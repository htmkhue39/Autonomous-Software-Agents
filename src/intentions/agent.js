import { listOptions } from '../deliberation/options.js';
import { reconsider } from './revision.js';

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Single-task BDI controller. Reconsiders on new beliefs but never starts a
 * second plan before the previous plan exits. Each activated intention calls
 * the movement planner when its plan begins.
 */
export class BdiAgent {
  /** @param {{ beliefs:import('../beliefs/index.js').Beliefs,
   * plans:import('../plans/library.js').PlanLibrary,
   * gate:import('../plans/action-gate.js').ActionGate,
   * replaceMargin?:number, log?:(type:string,details:object)=>void,
   * idleMs?:number, minCommitMs?:number, failedGoalCooldownMs?:number,
   * now?:()=>number, coordination?:import('../coordination/controller.js').CoordinationController|null }} options */
  constructor({ beliefs, plans, gate, replaceMargin = 1.2, log = () => {}, idleMs = 200,
    minCommitMs = 6000, failedGoalCooldownMs = 10000, now = Date.now, coordination = null }) {
    this.beliefs = beliefs;
    this.coordination = coordination;
    this.plans = plans;
    this.gate = gate;
    this.replaceMargin = replaceMargin;
    this.log = log;
    this.idleMs = idleMs;
    this.minCommitMs = minCommitMs;
    this.failedGoalCooldownMs = failedGoalCooldownMs;
    this.now = now;
    /** @type {Map<string,number>} */
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
      const options = this.#availableOptions();
      // Preserve an applicable active goal even if the option generator no
      // longer ranks it (e.g. an explored tile lost its 'oldest' ranking).
      if (!options.some(option => option.id === active.id)) {
        options.push(active);
        options.sort((a, b) => b.priority - a.priority || b.utility - a.utility);
      }
      const decision = reconsider(active, options, this.replaceMargin);
      if (decision.next && decision.next.id !== active.id) {
        // Complete deliveries rather than repeatedly throwing away expensive
        // PDDL plans to chase slightly more valuable pickup opportunities.
        // Explicit higher-priority goals are allowed to preempt them.
        if (active.type === 'deliver' && decision.next.priority <= active.priority) return;
        // Exploration always yields to useful pickup/delivery opportunities.
        const explorationYield = active.type === 'explore' && decision.next.utility > 0;
        const highPriority = decision.next.priority > active.priority;
        if (!explorationYield && !highPriority && this.now() - this.activeSince < this.minCommitMs) return;
        signal.stopped = true;
        this.log('intention_revision', { from: active.id, to: decision.next.id, reason: decision.reason });
      }
    });
  }
  #observations;

  #availableOptions() {
    const now = this.now();
    for (const [id, until] of this.failedGoals) if (until <= now) this.failedGoals.delete(id);
    return listOptions(this.beliefs).filter(option => !this.failedGoals.has(option.id) &&
      (option.type !== 'pickup' || !this.coordination ||
        this.coordination.canTarget(option.parcelId ?? '', { x: option.x, y: option.y })));
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
        const decision = reconsider(null, this.#availableOptions(), this.replaceMargin);
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
        this.currentRecord = record;
        const signal = { stopped: false };
        this.signal = signal;
        this.log('intention_activated', { id: option.id, type: option.type, utility: option.utility, target: {x:option.x,y:option.y} });
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
          const until = this.now() + this.failedGoalCooldownMs;
          this.failedGoals.set(option.id, until);
          this.log('intention_cooldown', { id: option.id, reason: outcome.reason ?? outcome.status,
            cooldownMs: this.failedGoalCooldownMs });
        } else if (outcome.status === 'completed') {
          this.failedGoals.delete(option.id);
        }
        this.active = null;
        this.signal = null;
        if (outcome.status === 'unknown') this.reconciled = false;
        // An unreachable or temporarily unavailable goal should not cause a
        // CPU-hot retry loop. Beliefs must have a chance to change.
        await sleep(this.idleMs);
      }
    } finally { this.running = false; this.log('agent_stopped', {}); }
  }
}
