/**
 * Predefined goal plans: reach a tile, pick up, deliver, or explore. Navigation
 * can be PDDL-backed, but the final SDK actions remain predefined plan steps.
 */
export class PlanLibrary {
  /**
   * @param {{ beliefs:import('../beliefs/index.js').Beliefs,
   * client:import('../types.js').Client,
   * gate:import('./action-gate.js').ActionGate,
   * movement:import('./moveTo.js').MovementRunner,
   * log?:(type:string,details:object)=>void,
   * pickupReconcileMs?:number }} setup
   */
  constructor({ beliefs, client, gate, movement, log = () => {}, pickupReconcileMs = 300 }) {
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
      timeout = setTimeout(() => finish(isCarried()), this.pickupReconcileMs);
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
    if (option.type === 'deliver') return map.typeAt(option.x, option.y) === '2' && this.beliefs.parcels.carriedBy(me.id, this.beliefs.now()).length > 0;
    return map.isWalkable(option.x, option.y, this.beliefs.now());
  }
  /** @param {import('../types.js').Option} option @param {import('../types.js').StopSignal} signal */
  async execute(option, signal) {
    if (!this.applicable(option)) return { status: 'failed', reason: 'Plan not applicable' };
    const navigationStarted = performance.now();
    let navigate;
    try { navigate = await this.movement.moveTo(option, signal); }
    finally { this.log('plan_phase', { planType: option.type, phase: 'navigation',
      durationMs: Math.round(performance.now() - navigationStarted), status: navigate?.status ?? 'threw' }); }
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
      const picked = Array.isArray(result.value) ? result.value.filter(p => p && typeof p.id === 'string') : [];
      const ids = picked.map(p => p.id);
      this.log('pickup_ack', {
        targetParcelId: option.parcelId, returnedIds: ids,
        responseShape: Array.isArray(result.value) ? 'array' : typeof result.value,
      });
      // The server may acknowledge multiple parcels. Preserve *every*
      // confirmed pickup, even when the requested target is missing.
      if (ids.length) this.beliefs.onPickup(picked);
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
      const before = this.beliefs.me?.score ?? null;
      const dispatchedAt = performance.now();
      let result;
      try { result = await this.gate.call('putdown', () => this.client.putdown()); }
      finally { this.log('sdk_action_phase', { action: 'putdown', durationMs: Math.round(performance.now() - dispatchedAt),
        status: result?.status ?? 'threw' }); }
      if (result.status !== 'ok') return { status: 'unknown', reason: result.status === 'unknown' ? result.reason : result.status };
      const dropped = Array.isArray(result.value) ? result.value : [];
      if (!dropped.length) return { status: 'failed', reason: 'Nothing dropped at delivery' };
      this.beliefs.onPutdown(dropped);
      this.log('delivery', { parcelIds: dropped.map(p => p.id), beforeScore: before, x: option.x, y: option.y });
      return { status: 'completed' };
    }
    return { status: 'failed', reason: 'Unknown plan type' };
  }
}
