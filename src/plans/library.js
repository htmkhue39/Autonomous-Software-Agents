/**
 * Predefined goal plans: reach a tile, pick up, deliver, or explore. Navigation
 * can be PDDL-backed, but the final SDK actions remain predefined plan steps.
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
   * pickupReconcileMs?:number, deliverOnTheWay?:boolean }} setup
   */
  constructor({ beliefs, client, gate, movement, log = () => {}, pickupReconcileMs = 300, deliverOnTheWay = false }) {
    this.deliverOnTheWay = deliverOnTheWay;
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
    if (option.type === 'pickup') {
      if (!option.parcelId) return false;
      const p = this.beliefs.parcels.get(option.parcelId, this.beliefs.now());
      return !!p && !p.carriedBy;
    }
    if (option.type === 'deliver') return map.deliveryMultiplier(option.x, option.y) > 0 && this.beliefs.parcels.carriedBy(me.id, this.beliefs.now()).length > 0;
    return map.isWalkable(option.x, option.y, this.beliefs.now());
  }
  /** @param {import('../types.js').Option} option @param {import('../types.js').StopSignal} signal */
  async execute(option, signal) {
    if (!this.applicable(option)) return { status: 'failed', reason: 'Plan not applicable' };
    const navigationStarted = performance.now();
    let navigate;
    try { navigate = await this.#navigate(option, signal); }
    finally { this.log('plan_phase', { planType: option.type, phase: 'navigation',
      durationMs: Math.round(performance.now() - navigationStarted), status: navigate?.status ?? 'threw' }); }
    if (navigate.status === 'delivered') return { status: 'completed' };
    if (navigate.status !== 'completed') return navigate;
    if (signal.stopped) return { status: 'cancelled' };
    if (option.type === 'explore' || option.type === 'goto') {
      this.beliefs.map?.markSeen([option], this.beliefs.now());
      return { status: 'completed' };
    }
    if (!this.applicable(option)) return { status: 'failed', reason: 'Target no longer applicable' };
    if (option.type === 'pickup') {
      // Ignore intention reconsideration during the final, already-sent SDK
      // action; its result must be reconciled before making a new decision.
      signal.finishing = true;
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
    if (option.type === 'deliver') {
      signal.finishing = true;
      return this.#putdown({ x: option.x, y: option.y }, false);
    }
    return { status: 'failed', reason: 'Unknown plan type' };
  }

  /** Standing on a delivery tile, at a whole position, while carrying parcels. */
  #onDeliveryTileCarrying() {
    const { me, map } = this.beliefs;
    return !!me && !!map && this.beliefs.positionStable && map.deliveryMultiplier(me.x, me.y) > 0 &&
      this.beliefs.parcels.carriedBy(me.id, this.beliefs.now()).length > 0;
  }

  /**
   * Walk to the option's tile. With `deliverOnTheWay`, stop on any delivery
   * tile reached while carrying parcels, put them down, and walk on. A
   * delivery plan has then reached its goal, which is reported as
   * 'delivered'.
   * @param {import('../types.js').Option} option
   * @param {import('../types.js').StopSignal} signal
   * @returns {Promise<{status:'completed'|'failed'|'cancelled'|'unknown'|'delivered', reason?:string}>}
   */
  async #navigate(option, signal) {
    if (!this.deliverOnTheWay) return this.movement.moveTo(option, signal);
    // Turned off for the rest of this plan once a putdown on the way drops
    // nothing, so that a wrong belief about carried parcels cannot loop.
    let onTheWay = true;
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
      try { moved = deliverHere ? { status: /** @type {const} */ ('cancelled') } : await this.movement.moveTo(option, /** @type {any} */ (inner)); }
      finally { unsubscribe(); }
      if (!deliverHere || signal.stopped || moved.status !== 'cancelled') return moved;
      const me = /** @type {NonNullable<typeof this.beliefs.me>} */ (this.beliefs.me);
      // The putdown is an SDK action already sent: the caller must not
      // reconsider until its result is known.
      signal.finishing = true;
      const dropped = await this.#putdown({ x: me.x, y: me.y }, true);
      signal.finishing = false;
      if (dropped.status === 'unknown') return dropped;
      if (dropped.status === 'failed') { onTheWay = false; continue; }
      if (option.type === 'deliver') return { status: 'delivered' };
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
