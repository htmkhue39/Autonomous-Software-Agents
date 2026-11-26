import { deliverId, listOptions } from '../deliberation/options.js';
import { EarningRate, priorEarningRate } from '../deliberation/rate.js';
import { reconsider, tripAsDelivery } from './revision.js';
import { decayIntervalMs } from '../beliefs/parcels.js';

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Why a delivery plan failed decides what the agent does with the tile:
 * - 'none': the tile is not to blame (the agent carried nothing after all, or
 *   its own state was not ready). The tile is not cooled down.
 * - 'temporary': the way to the tile was blocked for now (another agent in
 *   the way, refused moves). Delivering there directly waits out the
 *   cooldown, but a pickup trip may still count on the tile when it would
 *   arrive after the cooldown has ended.
 * - 'uncertain': the outcome is unknown (a server or network error). The tile
 *   is left out of all plans until the cooldown ends, while fresh sensing
 *   settles what happened.
 * Other goals are cooled down as 'uncertain' when the outcome is unknown and
 * as 'temporary' otherwise, which changes nothing for them.
 * @param {import('../types.js').Option} option
 * @param {{ status: string, reason?: string }} outcome
 * @returns {'none' | 'temporary' | 'uncertain'}
 */
export function failureKind(option, outcome) {
  if (outcome.status === 'unknown') return 'uncertain';
  if (option.type !== 'deliver') return 'temporary';
  const notTheTile = ['Nothing dropped at delivery', 'Plan not applicable', 'Target no longer applicable',
    'No known map', 'Self position unknown'];
  return notTheTile.includes(outcome.reason ?? '') ? 'none' : 'temporary';
}

/**
 * Single-task BDI controller. Reconsiders on new beliefs but never starts a
 * second plan before the previous plan exits. Each activated intention goes
 * to the Plan Library, which plans it (with the PDDL planner when it is on).
 */
export class BdiAgent {
  /** @param {{ beliefs:import('../beliefs/index.js').Beliefs,
   * plans:import('../plans/library.js').PlanLibrary,
   * gate:import('../plans/action-gate.js').ActionGate,
   * replaceMargin?:number, log?:(type:string,details:object)=>void,
   * idleMs?:number, minIntentionMs?:number, minCommitMs?:number, failedGoalCooldownMs?:number,
   * now?:()=>number, coordination?:import('../coordination/controller.js').CoordinationController|null,
   * optionPolicy?:{ strategy?:'baseline'|'net_gain', minGain?:number, deliveryProtection?:number, timeValuePerS?:number|null } }} options
   *   `optionPolicy` chooses how pickups are weighed against delivering (see listOptions).
   *   With the 'net_gain' strategy, switching intentions follows the score
   *   alone: another goal replaces the current one as soon as it is worth at
   *   least `minGain` points more, even while delivering, and neither
   *   `replaceMargin` nor `minCommitMs` applies. Every option is charged for
   *   its time at `timeValuePerS` points per second when that is set, and
   *   otherwise at the agent's own earning rate, learned from its score.
   *   `deliveryProtection` lets a pickup give way to delivering on a smaller
   *   gain than `minGain` (see reconsider). */
  constructor({ beliefs, plans, gate, replaceMargin = 1.2, log = () => {}, idleMs = 200, minIntentionMs = 50,
    minCommitMs = 6000, failedGoalCooldownMs = 10000, now = Date.now, coordination = null, optionPolicy = {}}) {
    this.beliefs = beliefs;
    this.optionPolicy = optionPolicy;
    /** @type {EarningRate | null} created once the map and game settings are known */
    this.earningRate = null;
    /** @type {object | null} the map the earning rate was learned on */
    this.rateMap = null;
    /** @type {string | null} the game settings it was learned under */
    this.rateGame = null;
    /** @type {number | undefined} */
    this.lastScore = undefined;
    this.coordination = coordination;
    this.plans = plans;
    this.gate = gate;
    this.replaceMargin = replaceMargin;
    this.log = log;
    this.idleMs = idleMs;
    this.minIntentionMs = minIntentionMs;
    this.minCommitMs = minCommitMs;
    this.failedGoalCooldownMs = failedGoalCooldownMs;
    this.now = now;
    /** @type {Map<string,{ until:number, kind:'temporary'|'uncertain' }>} goals cooled down after failing */
    this.failedGoals = new Map();
    this.activeSince = 0;
    this.running = false;
    /** @type {import('../types.js').Option | null} */
    this.active = null;
    /** @type {import('../types.js').StopSignal | null} */
    this.signal = null;
    this.currentRecord = null;
    /** @type {{ id:string, status:'running'|'completed'|'failed'|'cancelled', startedAt:number, endedAt:number|null, reason:string|null }[]} */
    this.intentionHistory = [];
    this.reconciled = true;
    this.#observations = 0;
    beliefs.onChange(() => {
      this.#observations++;
      this.#noteScore();
      const active = this.active;
      const signal = this.signal;
      if (!this.running || !active || !signal || signal.stopped || signal.finishing) return;
      // A goal is hard-invalid only when it is truly impossible or already
      // achieved; a changed utility rank / preferred exploration tile is not
      // proof that the current goal has become invalid.
      if (!this.plans.applicable(active)) {
        signal.stopped = true;
        this.log('intention_revision', { from: active.id, to: null, reason: 'invalidated' });
        return;
      }
      const carried = active.parcelId !== undefined && this.beliefs.me !== undefined &&
        this.beliefs.parcels.get(active.parcelId, this.beliefs.now())?.carriedBy === this.beliefs.me.id;
      const options = tripAsDelivery(active, this.#availableOptions(active.id), carried);
      // Preserve an applicable active goal even if the option generator no
      // longer ranks it (e.g. an explored tile lost its 'oldest' ranking).
      if (!options.some(option => option.id === active.id)) {
        options.push(active);
        options.sort((a, b) => b.priority - a.priority || b.utility - a.utility);
      }
      const netGain = this.optionPolicy.strategy === 'net_gain';
      const decision = reconsider(active, options, this.replaceMargin,
        netGain ? { minGain: this.optionPolicy.minGain ?? 1, deliveryProtection: this.optionPolicy.deliveryProtection ?? 0 } : {});
      if (decision.next && decision.next.id !== active.id) {
        // Baseline only: complete deliveries rather than repeatedly throwing
        // away expensive PDDL plans to chase slightly more valuable pickup
        // opportunities. Explicit higher-priority goals may preempt them.
        // The net gain rule already demands a real gain in points instead.
        if (!netGain && active.type === 'deliver' && decision.next.priority <= active.priority) return;
        // Exploration always yields to useful pickup/delivery opportunities.
        const explorationYield = active.type === 'explore' && decision.next.utility > 0;
        const highPriority = decision.next.priority > active.priority;
        if (!netGain && !explorationYield && !highPriority && this.now() - this.activeSince < this.minCommitMs) return;
        signal.stopped = true;
        // Standing on a delivery tile while carrying parcels: deliver here first.
        const reason = decision.next.type === 'deliver' && decision.next.priority > active.priority
          ? 'deliver_here' : decision.reason;
        this.log('intention_revision', { from: active.id, to: decision.next.id, reason });
      }
    });
  }
  #observations;

  /** Feed every rise of the agent's score into its earning rate. */
  #noteScore() {
    const score = this.beliefs.me?.score;
    if (score === undefined) return;
    if (this.lastScore !== undefined && score > this.lastScore) this.#rate()?.record(score - this.lastScore, this.beliefs.now());
    this.lastScore = score;
  }

  /**
   * The learned earning rate, created on first use once the game is known.
   * It starts again whenever the map or the game's settings change, since
   * what the agent earned on another map, or under other settings, says
   * little about what it can earn now.
   */
  #rate() {
    const { config, map } = this.beliefs;
    if (!config || !map) return this.earningRate;
    const { reward_avg: rewardAvg, generation_event: generation } = config.GAME.parcels;
    const moveMs = config.GAME.player.movement_duration;
    const game = JSON.stringify([rewardAvg, generation, moveMs, config.GAME.parcels.decaying_event, config.CLOCK]);
    if (!this.earningRate || this.rateMap !== map || this.rateGame !== game) {
      let generationMs = Infinity;
      try { generationMs = decayIntervalMs(generation, config.CLOCK); } catch { /* unknown: no cap */ }
      this.earningRate = new EarningRate({
        priorRate: priorEarningRate({ rewardAvg, width: map.width, height: map.height, moveMs, generationMs }),
        startedAt: this.beliefs.now(),
      });
      this.rateMap = map;
      this.rateGame = game;
    }
    return this.earningRate;
  }

  /** What one millisecond is worth, in points, under the net_gain strategy. */
  timeValue() {
    if (this.optionPolicy.strategy !== 'net_gain') return 0;
    const fixed = this.optionPolicy.timeValuePerS;
    if (fixed !== undefined && fixed !== null) return fixed / 1000;
    return this.#rate()?.rate(this.beliefs.now()) ?? 0;
  }

  /** @param {string | null} [activeId] the current intention, which is always scored afresh */
  #availableOptions(activeId = null) {
    const now = this.now();
    for (const [id, { until }] of this.failedGoals) if (until <= now) this.failedGoals.delete(id);
    // Goals that failed recently are passed in, so that a delivery tile that
    // failed is skipped while the other delivery tiles stay available.
    const excluded = new Set(this.failedGoals.keys());
    // A delivery tile that was only blocked for now may still end a pickup
    // trip that reaches it after its cooldown (see failureKind).
    /** @type {Map<string, number>} */
    const deliveryCooldowns = new Map();
    for (const [id, { until, kind }] of this.failedGoals) {
      if (kind === 'temporary' && id.startsWith('deliver:')) deliveryCooldowns.set(id, until - now);
    }
    return listOptions(this.beliefs, { ...this.optionPolicy, timeValue: this.timeValue(), excluded, deliveryCooldowns, keep: activeId }).filter(option => !this.failedGoals.has(option.id) &&
      (option.type !== 'pickup' || !this.coordination ||
        this.coordination.canTarget(option.parcelId ?? '', { x: option.x, y: option.y })));
  }

  /**
   * The goal a failed intention stands for. A trip whose parcel the agent
   * carries failed while delivering, so it stands for the delivery to its tile.
   * @param {import('../types.js').Option} option
   * @returns {import('../types.js').Option}
   */
  #failedPart(option) {
    const me = this.beliefs.me;
    if (option.type !== 'pickup' || option.deliverX === undefined || option.deliverY === undefined || !me) return option;
    if (this.beliefs.parcels.get(option.parcelId ?? '', this.beliefs.now())?.carriedBy !== me.id) return option;
    return { ...option, id: deliverId(option.deliverX, option.deliverY), type: 'deliver', x: option.deliverX, y: option.deliverY };
  }

  /**
   * Resolves once a sensing update newer than `count` has come, or after `maxMs`.
   * @param {number} count  the number of sensing updates already seen
   * @param {number} maxMs
   * @returns {Promise<void>}
   */
  #freshSensing(count, maxMs) {
    if (this.beliefs.sensings > count) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); unsubscribe(); resolve(); };
      const timer = setTimeout(done, maxMs);
      const unsubscribe = this.beliefs.onChange(() => { if (this.beliefs.sensings > count) done(); });
    });
  }

  stop() { this.running = false; if (this.signal) this.signal.stopped = true; this.coordination?.release(undefined, 'stopped'); }

  /** Execute until stopped, using current world belief rather than a static fixture. */
  async start() {
    if (this.running) throw new Error('BDI loop already running');
    this.running = true;
    this.log('agent_started', {});
    try {
      while (this.running) {
        if (!this.beliefs.ready || this.gate.busy) { await sleep(this.idleMs); continue; }
        if (!this.reconciled) {
          // An ambiguous action must be reconciled with fresh observation
          // before the BDI loop issues another action.
          const n = this.#observations;
          await sleep(this.idleMs);
          if (this.#observations > n && this.beliefs.positionStable) this.reconciled = true;
          continue;
        }
        const available = this.#availableOptions();
        const decision = reconsider(null, available, this.replaceMargin);
        if (!decision.next) { await sleep(this.idleMs); continue; }
        const option = decision.next;
        if (option.type === 'pickup' && option.parcelId && this.coordination) {
          const acquired = await this.coordination.acquire(option.parcelId, option, { onYield: () => {
            if (this.active?.id === option.id && this.signal) this.signal.stopped = true;
          } });
          if (!acquired) {
            this.log('coordination_pickup_skipped', { parcelId: option.parcelId, reason: 'peer_has_priority' });
            await sleep(this.idleMs);
            continue;
          }
          if (!this.running) { this.coordination.release(option.parcelId, 'stopped'); break; }
        }
        this.active = option;
        this.coordination?.setIntention(option.id);
        this.activeSince = this.now();
        /** @type {{ id:string, status:'running'|'completed'|'failed'|'cancelled', startedAt:number, endedAt:number|null, reason:string|null }} */
        const record = { id: option.id, status: 'running', startedAt: this.beliefs.now(), endedAt: null, reason: null };
        const startedAt = Date.now();
        this.currentRecord = record;
        const signal = { stopped: false };
        this.signal = signal;
        this.log('intention_activated', { id: option.id, type: option.type, utility: option.utility, target: {x:option.x,y:option.y},
          ...(this.optionPolicy.strategy === 'net_gain' ? { timeValuePerS: Math.round(this.timeValue() * 1000 * 100) / 100 } : {}) });
        let outcome;
        try { outcome = await this.plans.execute(option, signal); }
        catch (error) { outcome = { status: 'unknown', reason: String(error instanceof Error ? error.message : error) }; }
        record.status = outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
        record.endedAt = this.beliefs.now();
        record.reason = outcome.reason ?? null;
        this.intentionHistory.push({ ...record });
        if (this.intentionHistory.length > 100) this.intentionHistory.shift();
        this.currentRecord = null;
        this.log('intention_outcome', { id: option.id, ...outcome, lifecycleStatus: record.status });
        if (option.type === 'pickup' && option.parcelId) this.coordination?.release(option.parcelId,
          outcome.status === 'completed' ? 'collected' : outcome.status === 'cancelled' ? 'yielded' : 'failed');
        this.coordination?.setIntention(null);
        if (outcome.status === 'failed' || outcome.status === 'unknown') {
          // A trip that failed after its pickup failed at delivering: the
          // delivery tile is cooled down, as a delivery would be.
          const failed = this.#failedPart(option);
          const kind = failureKind(failed, outcome);
          if (kind === 'none') {
            this.log('intention_failure_not_cooled', { id: failed.id, reason: outcome.reason ?? outcome.status });
          } else {
            // Never shorter than some moves of this game, whose speed may have been set by hand.
            const cooldownMs = this.beliefs.atLeastMoves(this.failedGoalCooldownMs, 20);
            const until = this.now() + cooldownMs;
            this.failedGoals.set(failed.id, { until, kind });
            this.log('intention_cooldown', { id: failed.id, reason: outcome.reason ?? outcome.status,
              kind, cooldownMs });
          }
        } else if (outcome.status === 'completed') {
          this.failedGoals.delete(option.id);
        }
        this.active = null;
        this.signal = null;
        const sensedBefore = this.beliefs.sensings;
        if (outcome.status === 'unknown') this.reconciled = false;
        if (outcome.status === 'completed' || outcome.status === 'cancelled') {
          // Done, or replaced by a better goal: decide again as soon as the
          // server's next sensing has come, at most two frames later, so that
          // the next goal is chosen on what the agent sees from where it now
          // stands (exploring otherwise picks the tile next door, step after
          // step). An intention that ended at once also waits until
          // minIntentionMs after it started, so that it cannot spin.
          await Promise.all([
            sleep(Math.max(0, this.minIntentionMs - (Date.now() - startedAt))),
            this.#freshSensing(sensedBefore, this.beliefs.atLeastFrames(0, 2)),
          ]);
        } else {
          // An unreachable or temporarily unavailable goal should not cause a
          // CPU-hot retry loop. Beliefs must have a chance to change.
          await sleep(this.idleMs);
        }
      }
    } finally { this.running = false; this.log('agent_stopped', {}); }
  }
}
