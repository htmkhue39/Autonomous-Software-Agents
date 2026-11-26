import { archiveKey } from './archive.js';
import { buildProblem, planStillWorks, routeExists, routeFrom } from '../planning/pddl/problem.js';

/**
 * The Plan Library of page 2 of the course slides: plans to reach a tile,
 * pick up, deliver, or explore. A pickup whose option names a delivery tile
 * is a whole trip, and its plan comes from the archive or the PDDL planner
 * when it is there in time (see #startPlanning). The pickup and putdown are
 * sent to the game by this library, which settles their outcomes.
 *
 * With `deliverOnTheWay`, a plan that walks over a delivery tile while the
 * agent carries parcels puts them down there and then carries on. The LLM
 * agent uses this, since it has no BDI loop to notice the chance itself. The
 * BDI agent leaves it off and gets the same effect from intention revision.
 */
export class PlanLibrary {
  /**
   * @param {{ beliefs:import('../beliefs/index.js').Beliefs,
   * client:import('../types.js').Client,
   * gate:import('./action-gate.js').ActionGate,
   * movement:import('./moveTo.js').MovementRunner,
   * log?:(type:string,details:object)=>void,
   * pickupReconcileMs?:number, deliverOnTheWay?:boolean,
   * planner?:import('../planning/pddl/service.js').PlannerService | null,
   * archive?:import('./archive.js').PlanArchive | null }} setup
   *   Without a `planner`, every walk is found with A* and the archive is not used.
   */
  constructor({ beliefs, client, gate, movement, log = () => {}, pickupReconcileMs = 300, deliverOnTheWay = false,
    planner = null, archive = null }) {
    this.deliverOnTheWay = deliverOnTheWay;
    this.planner = planner;
    this.archive = archive;
    /** @type {Map<string, Set<PlanHandle>>} requests sent and not answered yet, by archive key, with the intentions waiting for them */
    this.pending = new Map();
    this.beliefs = beliefs;
    this.client = client;
    this.gate = gate;
    this.movement = movement;
    this.log = log;
    this.pickupReconcileMs = pickupReconcileMs;
  }

  /** Wait briefly for an authoritative sensing update when an ACK omitted the
   * target. Only a positive carriedBy=self observation can confirm success.
   * Never turn a missing/empty ACK into success merely because pickup was sent.
   * @param {string} parcelId
   */
  async #confirmCarried(parcelId) {
    const isCarried = () => {
      const me = this.beliefs.me;
      return !!me && this.beliefs.parcels.get(parcelId, this.beliefs.now())?.carriedBy === me.id;
    };
    if (isCarried()) return true;
    if (this.pickupReconcileMs <= 0) return false;
    return new Promise(resolve => {
      let finished = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timeout;
      const finish = (/** @type {boolean} */ confirmed) => {
        if (finished) return;
        finished = true;
        unsubscribe();
        if (timeout) clearTimeout(timeout);
        resolve(confirmed);
      };
      const unsubscribe = this.beliefs.onChange(() => {
        if (isCarried()) finish(true);
      });
      // Wait for a few frames of sensing at least, however slow the server's clock is.
      timeout = setTimeout(() => finish(isCarried()), this.beliefs.atLeastFrames(this.pickupReconcileMs, 3));
      if (isCarried()) finish(true);
    });
  }
  /** @param {import('../types.js').Option} option */
  applicable(option) {
    const { me, map } = this.beliefs;
    if (!me || !map) return false;
    const now = this.beliefs.now();
    if (option.type === 'pickup') {
      if (!option.parcelId) return false;
      const p = this.beliefs.parcels.get(option.parcelId, now);
      if (!p) return false;
      if (!isTrip(option)) return !p.carriedBy;
      // A trip goes on after its pickup, so its parcel may already be carried by the agent.
      return (!p.carriedBy || p.carriedBy === me.id) && map.deliveryMultiplier(option.deliverX, option.deliverY) > 0;
    }
    if (option.type === 'deliver') return map.deliveryMultiplier(option.x, option.y) > 0 && this.beliefs.parcels.carriedBy(me.id, now).length > 0;
    return map.isWalkable(option.x, option.y, now);
  }

  /**
   * Carry out an intention. A pickup whose option names a delivery tile is a
   * whole trip, as on page 12 of the course slides: walk to the parcel, pick
   * it up, walk to the delivery tile, put it down. Between the pickup and the
   * second walk the BDI loop may replace the trip, as with any intention.
   *
   * With a planner, each walk follows the intention's PDDL plan when there is
   * one in time (see #startPlanning); otherwise A* finds the way.
   * @param {import('../types.js').Option} option @param {import('../types.js').StopSignal} signal
   */
  async execute(option, signal) {
    if (!this.applicable(option)) return { status: 'failed', reason: 'Plan not applicable' };
    const carried = option.type === 'pickup' && this.#carriedByMe(option.parcelId ?? '');
    const goal = planGoal(option, carried);
    const planning = goal ? this.#startPlanning(goal) : null;
    try {
      return await this.#run(option, carried, planning, signal);
    } finally {
      planning?.end();
    }
  }

  /**
   * @param {import('../types.js').Option} option
   * @param {boolean} carried  whether the parcel of a pickup is already carried by the agent
   * @param {PlanHandle | null} planning
   * @param {import('../types.js').StopSignal} signal
   * @returns {Promise<{status:'completed'|'failed'|'cancelled'|'unknown', reason?:string}>}
   */
  async #run(option, carried, planning, signal) {
    if (option.type === 'explore' || option.type === 'goto') {
      const walked = await this.#walk(option, signal, option.type, null, null, false);
      if (walked.status === 'delivered') return { status: 'completed' };
      if (walked.status !== 'completed') return { status: walked.status, reason: walked.reason };
      if (signal.stopped) return { status: 'cancelled' };
      this.beliefs.map?.markSeen([option], this.beliefs.now());
      return { status: 'completed' };
    }
    if (option.type === 'deliver') return this.#deliverAt(option, option, signal, planning, 0);
    if (option.type === 'pickup') {
      if (!carried) {
        const walked = await this.#walk(option, signal, 'pickup', planning, 0, false);
        if (walked.status === 'delivered') return { status: 'completed' };
        if (walked.status !== 'completed') return { status: walked.status, reason: walked.reason };
        if (signal.stopped) return { status: 'cancelled' };
        if (!this.applicable(option)) return { status: 'failed', reason: 'Target no longer applicable' };
        // Ignore intention reconsideration during the SDK pickup about to be
        // sent; its result must be settled before a new decision.
        signal.finishing = true;
        const picked = await this.#pickup(option);
        if (picked.status !== 'completed' || !isTrip(option)) return picked;
        // The pickup is settled: the trip may be replaced again on the way to deliver.
        signal.finishing = false;
      }
      const to = { x: /** @type {number} */ (option.deliverX), y: /** @type {number} */ (option.deliverY) };
      return this.#deliverAt(to, option, signal, planning, carried ? 0 : 1);
    }
    return { status: 'failed', reason: 'Unknown plan type' };
  }

  /**
   * Walk to the delivery tile `to` and put everything down there.
   * @param {import('../types.js').Position} to
   * @param {import('../types.js').Option} option
   * @param {import('../types.js').StopSignal} signal
   * @param {PlanHandle | null} planning
   * @param {0 | 1} leg  which walk of the plan this is
   * @returns {Promise<{status:'completed'|'failed'|'cancelled'|'unknown', reason?:string}>}
   */
  async #deliverAt(to, option, signal, planning, leg) {
    const walked = await this.#walk(to, signal, option.type, planning, leg, true);
    if (walked.status === 'delivered') return { status: 'completed' };
    if (walked.status !== 'completed') return { status: walked.status, reason: walked.reason };
    if (signal.stopped) return { status: 'cancelled' };
    if (!this.applicable(option)) return { status: 'failed', reason: 'Target no longer applicable' };
    signal.finishing = true;
    return this.#putdown(to, false);
  }

  /** @param {string} parcelId */
  #carriedByMe(parcelId) {
    const me = this.beliefs.me;
    return !!me && this.beliefs.parcels.get(parcelId, this.beliefs.now())?.carriedBy === me.id;
  }

  /**
   * Pick up on the tile the agent stands on, and make sure the target parcel
   * was really collected.
   * @param {import('../types.js').Option} option
   * @returns {Promise<{status:'completed'|'failed'|'unknown', reason?:string}>}
   */
  async #pickup(option) {
    const dispatchedAt = performance.now();
    let result;
    try { result = await this.gate.call('pickup', () => this.client.pickup()); }
    finally { this.log('sdk_action_phase', { action: 'pickup', durationMs: Math.round(performance.now() - dispatchedAt),
      status: result?.status ?? 'threw' }); }
    if (result.status !== 'ok') return { status: 'unknown', reason: result.status === 'unknown' ? result.reason : result.status };
    /** @type {unknown[]} */
    const picked = Array.isArray(result.value) ? result.value : [];
    // The reply may or may not carry parcel ids, so ids are used only when
    // present. Whether the reply is empty is what tells the beliefs that
    // the parcels on this tile are now carried.
    const ids = picked.flatMap(p => {
      const id = p && typeof p === 'object' ? /** @type {{ id?: unknown }} */ (p).id : undefined;
      return typeof id === 'string' ? [id] : [];
    });
    this.log('pickup_ack', {
      targetParcelId: option.parcelId, returnedIds: ids, returnedCount: picked.length,
      responseShape: Array.isArray(result.value) ? 'array' : typeof result.value,
    });
    if (picked.length) this.beliefs.onPickup(picked);
    const targetInAck = ids.includes(option.parcelId ?? '');
    const confirmed = targetInAck || await this.#confirmCarried(option.parcelId ?? '');
    if (ids.length || confirmed) {
      const confirmedIds = confirmed && option.parcelId ? [...new Set([...ids, option.parcelId])] : ids;
      this.log('pickup', { parcelIds: confirmedIds, targetParcelId: option.parcelId,
        targetConfirmed: confirmed,
        confirmation: confirmed ? (targetInAck ? 'ack' : 'sensing') : 'other-parcel-ack',
        x: option.x, y: option.y });
    }
    if (!confirmed) return { status: 'failed', reason: 'Target parcel not confirmed collected' };
    return { status: 'completed' };
  }

  /**
   * One walk of an intention, logged as a 'plan_phase'. With a plan handle,
   * the walk follows the plan's leg `leg` when the plan is there in time.
   * @param {import('../types.js').Position} target
   * @param {import('../types.js').StopSignal} signal
   * @param {string} planType
   * @param {PlanHandle | null} planning
   * @param {0 | 1 | null} leg
   * @param {boolean} isDelivery  whether the walk ends with a delivery
   */
  async #walk(target, signal, planType, planning, leg, isDelivery) {
    const started = performance.now();
    /** @type {{status:'completed'|'failed'|'cancelled'|'unknown'|'delivered', reason?:string} | undefined} */
    let walked;
    try {
      const given = planning && leg !== null ? planning.walking(leg) : {};
      walked = await this.#navigate(target, signal, isDelivery, given);
    } finally {
      planning?.stopWalking();
      this.log('plan_phase', { planType, phase: 'navigation',
        durationMs: Math.round(performance.now() - started), status: walked?.status ?? 'threw' });
    }
    return walked;
  }

  /**
   * Begin planning an intention: use a plan from the archive when one still
   * works, and otherwise ask the planner in the background. Returns null when
   * there is no planner, or when the agent already stands where the
   * intention's first action happens, so that it acts at once.
   * @param {import('../types.js').PlanGoal} goal
   * @returns {PlanHandle | null}
   */
  #startPlanning(goal) {
    const { me, map } = this.beliefs;
    if (!this.planner || !me || !map) return null;
    // A plan of a single pickup or putdown on the tile the agent stands on
    // would add nothing. A trip that starts on its parcel's tile still has its
    // delivery to plan; its pickup goes ahead at once all the same.
    const first = goal.kind === 'deliver' ? goal.deliverAt : goal.parcelAt;
    if (goal.kind !== 'trip' && me.x === first.x && me.y === first.y) return null;
    const now = this.beliefs.now();
    const paths = { now, occupied: this.beliefs.agents.occupied(now) };
    const from = { x: me.x, y: me.y };
    const carried = this.beliefs.parcels.carriedBy(me.id, now).length;
    const key = archiveKey(goal, from, carried);
    const handle = new PlanHandle(key, () => this.beliefs.me ?? null, this.log);
    const archived = this.archive?.get(key);
    if (archived && planStillWorks(archived, map, paths)) {
      this.log('plan_archive_hit', { key });
      handle.arrive(archived, 'archive');
      return handle;
    }
    // A plan that does not work right now (an agent on its path, a refused
    // move) stays archived until a new plan for the same key replaces it.
    // The same trip may come again while its plan is still being made, for
    // instance when the intention is replaced and chosen again: it then
    // waits for the request already sent instead of sending another.
    const waiting = this.pending.get(key);
    if (waiting) {
      waiting.add(handle);
      this.log('plan_archive_miss', { key, waiting: true });
      return handle;
    }
    this.log('plan_archive_miss', { key, ...(archived ? { reason: 'the archived plan no longer works' } : {}) });
    const spec = buildProblem({ map, from, paths, carried, goal });
    if (!spec || !routeExists(spec)) {
      this.log('planner_fallback', { reason: 'no route in the problem', fallback: 'astar', key });
      return handle;
    }
    // Not awaited: the agent walks with A* meanwhile. Nothing it throws may be
    // left unhandled, since that would stop the whole process.
    const handles = new Set([handle]);
    this.pending.set(key, handles);
    this.planner.plan(spec).then(result => {
      if (result.status !== 'ok') return;
      this.archive?.set(key, result.plan);
      for (const waiter of handles) waiter.arrive(result.plan, 'solver');
    }).catch(error => {
      this.log('planner_fallback', { reason: String(error instanceof Error ? error.message : error), fallback: 'astar', key });
    }).finally(() => this.pending.delete(key));
    return handle;
  }

  /** Standing on a delivery tile, at a whole position, while carrying parcels. */
  #onDeliveryTileCarrying() {
    const { me, map } = this.beliefs;
    return !!me && !!map && this.beliefs.positionStable && map.deliveryMultiplier(me.x, me.y) > 0 &&
      this.beliefs.parcels.carriedBy(me.id, this.beliefs.now()).length > 0;
  }

  /**
   * Walk to `target`. With `deliverOnTheWay`, stop on any delivery tile
   * reached while carrying parcels, put them down, and walk on. A walk that
   * ends with a delivery has then reached its goal, which is reported as
   * 'delivered'.
   * @param {import('../types.js').Position} target
   * @param {import('../types.js').StopSignal} signal
   * @param {boolean} isDelivery
   * @param {{ route?: import('../types.js').Direction[] | null,
   *   takeRoute?: (() => import('../types.js').Direction[] | null) | null,
   *   onReplaced?: ((reason: string) => void) | null }} given  the route from a plan, if any
   * @returns {Promise<{status:'completed'|'failed'|'cancelled'|'unknown'|'delivered', reason?:string}>}
   */
  async #navigate(target, signal, isDelivery, given) {
    if (!this.deliverOnTheWay) return this.movement.moveTo(target, signal, given);
    // Turned off for the rest of this plan once a putdown on the way drops
    // nothing, so that a wrong belief about carried parcels cannot loop.
    let onTheWay = true;
    // The plan's route starts where the walk started: after a delivery on the
    // way only takeRoute may hand over the rest of it, from the agent's tile.
    let walkGiven = given;
    const shouldDeliver = () => onTheWay && this.#onDeliveryTileCarrying();
    for (;;) {
      let deliverHere = shouldDeliver();
      // The movement runner stops when either the caller stops the plan or
      // a delivery tile is reached while carrying parcels.
      const inner = { get stopped() { return signal.stopped || deliverHere; } };
      const unsubscribe = this.beliefs.onChange(() => {
        if (!deliverHere && shouldDeliver()) deliverHere = true;
      });
      let moved;
      try { moved = deliverHere ? { status: /** @type {const} */ ('cancelled') } : await this.movement.moveTo(target, /** @type {any} */ (inner), walkGiven); }
      finally { unsubscribe(); }
      if (!deliverHere || signal.stopped || moved.status !== 'cancelled') return moved;
      walkGiven = { ...given, route: null };
      const me = /** @type {NonNullable<typeof this.beliefs.me>} */ (this.beliefs.me);
      // The putdown is an SDK action already sent: the caller must not
      // reconsider until its result is known.
      signal.finishing = true;
      const dropped = await this.#putdown({ x: me.x, y: me.y }, true);
      signal.finishing = false;
      if (dropped.status === 'unknown') return dropped;
      if (dropped.status === 'failed') { onTheWay = false; continue; }
      if (isDelivery) return { status: 'delivered' };
    }
  }

  /**
   * Put down everything carried, on the tile `at` where the agent stands.
   * @param {import('../types.js').Position} at
   * @param {boolean} onTheWay  true when this is a delivery on the way to another goal
   * @returns {Promise<{status:'completed'|'failed'|'unknown', reason?:string}>}
   */
  async #putdown(at, onTheWay) {
    const before = this.beliefs.me?.score ?? null;
    const dispatchedAt = performance.now();
    let result;
    try { result = await this.gate.call('putdown', () => this.client.putdown()); }
    finally { this.log('sdk_action_phase', { action: 'putdown', durationMs: Math.round(performance.now() - dispatchedAt),
      status: result?.status ?? 'threw' }); }
    if (result.status !== 'ok') return { status: 'unknown', reason: result.status === 'unknown' ? result.reason : result.status };
    const dropped = Array.isArray(result.value) ? result.value : [];
    if (!dropped.length) {
      // The server carried nothing for the agent: the belief was wrong, not the tile.
      const forgotten = this.beliefs.onNothingCarried();
      this.log('inventory_reconciled', { reason: 'putdown_dropped_nothing', forgotten, x: at.x, y: at.y });
      return { status: 'failed', reason: 'Nothing dropped at delivery' };
    }
    this.beliefs.onPutdown(dropped);
    // One entry per dropped parcel, because the LLM's progress counts
    // deliveries by the length of this list. An entry is null when the
    // reply did not carry that parcel's id.
    const parcelIds = dropped.map(p => {
      const id = p && typeof p === 'object' ? /** @type {{ id?: unknown }} */ (p).id : undefined;
      return typeof id === 'string' ? id : null;
    });
    this.log('delivery', { parcelIds, beforeScore: before, x: at.x, y: at.y, ...(onTheWay ? { onTheWay: true } : {}) });
    return { status: 'completed' };
  }
}

/**
 * Whether a pickup option is a whole trip, ending with a delivery.
 * @param {import('../types.js').Option} option
 * @returns {option is import('../types.js').Option & { deliverX: number, deliverY: number }}
 */
function isTrip(option) {
  return option.type === 'pickup' && option.deliverX !== undefined && option.deliverY !== undefined;
}

/**
 * What the plan of an option must achieve, or null when the option is not
 * planned (exploring and going to a tile only walk, which A* does best). A
 * trip whose parcel is already carried only has its delivery left.
 * @param {import('../types.js').Option} option
 * @param {boolean} carried  whether the parcel of a pickup is already carried by the agent
 * @returns {import('../types.js').PlanGoal | null}
 */
function planGoal(option, carried) {
  if (option.type === 'deliver') return { kind: 'deliver', deliverAt: { x: option.x, y: option.y } };
  if (option.type !== 'pickup') return null;
  if (isTrip(option)) {
    const deliverAt = { x: option.deliverX, y: option.deliverY };
    return carried ? { kind: 'deliver', deliverAt } : { kind: 'trip', parcelAt: { x: option.x, y: option.y }, deliverAt };
  }
  return carried ? null : { kind: 'pickup', parcelAt: { x: option.x, y: option.y } };
}

/**
 * The plan of one running intention: it may come from the archive at once,
 * or from the solver later, while the agent already walks with A*. Each walk
 * of the intention asks for its leg of the plan; the plan is handed over once
 * per leg, from the agent's tile, and only while the agent is on the plan's
 * path. The handle logs whether the plan drove the agent:
 * - 'pddl_plan_used', with `from: 'archive' | 'solver'`, the first time it is handed over;
 * - 'pddl_plan_replaced', with the reason, when A* then replaces the plan's
 *   route (it was blocked, or a shorter way opened);
 * - 'pddl_plan_unused', when the intention ends without using it, with the
 *   reason 'off the plan path' (the agent was elsewhere when it came),
 *   'walk finished' (it came when there was no walk left to take it), or
 *   'intention ended' (it came after the intention was over).
 */
class PlanHandle {
  /**
   * @param {string} key  the plan's archive key
   * @param {() => import('../types.js').Position | null} where  the agent's tile now
   * @param {(event: string, details: object) => void} log
   */
  constructor(key, where, log) {
    this.key = key;
    this.where = where;
    this.log = log;
    /** @type {import('../types.js').DecodedPlan | null} */
    this.plan = null;
    /** @type {'archive' | 'solver' | null} */
    this.from = null;
    /** @type {0 | 1 | null} the leg being walked now */
    this.leg = null;
    /** @type {Set<number>} legs for which the plan was handed over or found off its path */
    this.settled = new Set();
    this.used = false;
    this.offPath = false;
    this.ended = false;
  }

  /** @param {import('../types.js').DecodedPlan} plan @param {'archive' | 'solver'} from */
  arrive(plan, from) {
    if (this.ended) {
      this.log('pddl_plan_unused', { reason: 'intention ended', from, key: this.key });
      return;
    }
    this.plan = plan;
    this.from = from;
  }

  /**
   * The route options for a walk of leg `leg`: the plan's route from here if
   * the plan is there already, and a way to hand it over if it comes later.
   * @param {0 | 1} leg
   */
  walking(leg) {
    this.leg = leg;
    return {
      route: this.#take(),
      takeRoute: () => this.#take(),
      // A* may still replace the plan's route, when it is blocked or a shorter way opens.
      onReplaced: (/** @type {string} */ reason) => this.log('pddl_plan_replaced', { reason, from: this.from, leg, key: this.key }),
    };
  }

  stopWalking() {
    this.leg = null;
  }

  /** @returns {import('../types.js').Direction[] | null} */
  #take() {
    const leg = this.leg;
    const at = this.where();
    if (!this.plan || leg === null || !at || this.settled.has(leg)) return null;
    this.settled.add(leg);
    const route = routeFrom(this.plan, at, leg);
    if (route === null) {
      this.offPath = true;
      return null;
    }
    if (!this.used) {
      this.used = true;
      this.log('pddl_plan_used', { from: this.from, leg, key: this.key });
    }
    return route;
  }

  /** The intention is over. */
  end() {
    this.ended = true;
    if (this.plan && !this.used) {
      this.log('pddl_plan_unused', { reason: this.offPath ? 'off the plan path' : 'walk finished', from: this.from, key: this.key });
    }
  }
}
