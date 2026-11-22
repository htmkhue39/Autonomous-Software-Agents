import { findPath } from '../planning/astar.js';
import { decodeMessage, encodeMessage } from './protocol.js';

/** @typedef {import('../types.js').Position} Position */
/** @typedef {{parcelId:string,cost:number,expiresAt:number,owner:string,onYield?:()=>void}} ParcelClaim */
/**
 * One controller per real SDK identity. Only explicitly enabled instances
 * broadcast messages. No shared process memory or central task allocator.
 */
export class CoordinationController {
  /** @param {{client:import('../types.js').Client, beliefs:import('../beliefs/index.js').Beliefs,
   * selfName:'bubble'|'milktea',peerName:'bubble'|'milktea', now?:()=>number,
   * settleMs?:number,leaseMs?:number,heartbeatMs?:number,
   * log?:(event:string,data:object)=>void }} cfg */
  constructor({ client, beliefs, selfName, peerName, now = Date.now, settleMs = 220,
    leaseMs = 6500, heartbeatMs = 2000, log = () => {} }) {
    this.client = client;
    this.beliefs = beliefs;
    this.selfName = selfName;
    this.peerName = peerName;
    this.now = now;
    this.settleMs = settleMs;
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.log = log;
    this.seq = 0;
    this.lastSeq = 0;
    this.peerId = '';
    this.peerSeenAt = 0;
    this.started = false;
    /** @type {string|null} */ this.intention = null;
    /** @type {{x:number,y:number,intention:string|null,at:number}|null} */
    this.peer = null;
    /** @type {Map<string,ParcelClaim>} */ this.remoteClaims = new Map();
    /** @type {ParcelClaim|null} */ this.ownClaim = null;
    this.sharedCount = 0;
    /** @type {(()=>void)[]} */ this.listeners = [];
    /** @type {(()=>void)|null} */ this.unsubscribe = null;
    /** @type {ReturnType<typeof setInterval>|null} */ this.timer = null;
    this.lastBeliefSent = 0;
    this.lastBeliefFingerprint = '';
    this.lastStatusSent = 0;
    this.lastHelloSent = 0;
    this.statusIntervalMs = 6000;
    this.beliefMinIntervalMs = 4000;
    this.beliefRefreshMs = 10000;
  }

  /** @param {()=>void} callback */
  onChange(callback) {
    this.listeners.push(callback);
    return () => { this.listeners = this.listeners.filter(f => f !== callback); };
  }
  changed() { for (const fn of [...this.listeners]) fn(); }
  start() {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.client.onMessage((id, name, msg) => this.receive(id, name, msg));
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
    this.heartbeat();
  }
  stop() {
    if (!this.started) return;
    this.release(undefined, 'stopped');
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** @param {import('./protocol.js').CoopType} type @param {object} data */
  send(type, data) {
    if (!this.started) return;
    let wire;
    try { wire = encodeMessage(type, ++this.seq, this.now(), data); }
    catch (error) { this.log('coordination_invalid_outbound', { type, reason: String(error) }); return; }
    try {
      // Never wait for a chat ACK in the real-time decision path. Errors are
      // logged, not treated as proof that a peer saw the message.
      void Promise.resolve(this.client.shout(wire)).catch(error =>
        this.log('coordination_send_failed', { type, reason: String(error) }));
      this.log('coordination_sent', { type, parcelId: 'parcelId' in data ? data.parcelId : undefined });
    } catch (error) { this.log('coordination_send_failed', { type, reason: String(error) }); }
  }

  heartbeat() {
    if (!this.started || !this.beliefs.me) return;
    this.expireClaims();
    if ((!this.peerId || this.now() - this.peerSeenAt > 8000) &&
      (!this.lastHelloSent || this.now() - this.lastHelloSent >= 4000)) {
      this.send('HELLO', { agent: this.selfName, id: this.beliefs.me.id });
      this.lastHelloSent = this.now();
    }
    this.sendStatus();
    if (this.ownClaim) {
      this.ownClaim.expiresAt = this.now() + this.leaseMs;
      this.send('CLAIM', { parcelId: this.ownClaim.parcelId, cost: this.ownClaim.cost, leaseMs: this.leaseMs });
    }
    // Send a bounded snapshot of directly observed parcels, not rumors.
    this.shareBeliefs(false);
  }
  /** STATUS changes immediately on intention change; position heartbeats are
   * throttled but continue often enough for peer liveness detection.
   * @param {boolean} [force]
   */
  sendStatus(force = false) {
    const me = this.beliefs.me;
    if (!me || !this.started) return;
    const data = { x: me.x, y: me.y, intention: this.intention };
    if (!force && this.lastStatusSent && this.now() - this.lastStatusSent < this.statusIntervalMs) return;
    this.send('STATUS', data);
    this.lastStatusSent = this.now();
  }
  /** Manually invoked sharing remains immediate. Heartbeat sharing is
   * throttled while still refreshing unchanging sightings occasionally.
   * @param {boolean} [force]
   */
  shareBeliefs(force = true) {
    if (!this.beliefs.me || !this.started) return;
    const parcels = this.beliefs.parcels.directReports(this.beliefs.now())
      .sort((a, b) => (b.reward - b.ageMs / this.beliefs.parcels.decayMs) -
        (a.reward - a.ageMs / this.beliefs.parcels.decayMs)).slice(0, 6);
    if (parcels.length) {
      const signature = JSON.stringify(parcels.map(p => [p.id, p.x, p.y, p.reward]));
      const elapsed = this.now() - this.lastBeliefSent;
      if (!force && this.lastBeliefSent && (elapsed < this.beliefMinIntervalMs ||
        (signature === this.lastBeliefFingerprint && elapsed < this.beliefRefreshMs))) return;
      this.send('BELIEF', { parcels });
      this.lastBeliefSent = this.now();
      this.lastBeliefFingerprint = signature;
    }
  }
  /** @param {string|null} intention */
  setIntention(intention) {
    if (this.intention === intention) return;
    this.intention = intention;
    if (this.beliefs.me) this.sendStatus(true);
  }

  /** @param {number} x @param {number} y @returns {number} */
  cost(x, y) {
    const { me, map } = this.beliefs;
    if (!me || !map) return 9999;
    const path = findPath(map, me, { x, y }, { now: this.beliefs.now(), occupied: this.beliefs.agents.occupied(this.beliefs.now()) });
    return path ? Math.min(9999, path.length) : 9999;
  }
  /** @param {ParcelClaim} a @param {ParcelClaim} b */
  winner(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost ? a : b;
    return a.owner.localeCompare(b.owner) <= 0 ? a : b;
  }
  expireClaims() {
    const now = this.now();
    for (const [id, claim] of this.remoteClaims) {
      if (claim.expiresAt <= now || this.peerSeenAt && now - this.peerSeenAt > 12000) {
        this.remoteClaims.delete(id);
        this.log('coordination_claim_expired', { parcelId: id });
        this.changed();
      }
    }
  }
  /** @param {string} parcelId @param {Position} position */
  canTarget(parcelId, position) {
    this.expireClaims();
    const remote = this.remoteClaims.get(parcelId);
    if (!remote) return true;
    const cost = this.cost(position.x, position.y);
    // Respect a peer that already committed. Only a clearly better new route
    // (at least three tiles shorter) may challenge that incumbent. Claims
    // created simultaneously are still decided by winner() on reception.
    if (this.ownClaim?.parcelId !== parcelId) return cost + 2 < remote.cost;
    return this.winner(this.ownClaim, remote) === this.ownClaim;
  }
  /** @param {string} parcelId @param {Position} position
   * @param {{signal?:AbortSignal,onYield?:()=>void}} [options]
   * @returns {Promise<boolean>}
   */
  async acquire(parcelId, position, { signal, onYield } = {}) {
    if (signal?.aborted || !this.started || !this.beliefs.me || this.ownClaim) return false;
    const cost = this.cost(position.x, position.y);
    if (cost >= 9999 || !this.canTarget(parcelId, position)) return false;
    this.ownClaim = { parcelId, cost, owner: this.selfName, expiresAt: this.now() + this.leaseMs, onYield };
    this.send('CLAIM', { parcelId, cost, leaseMs: this.leaseMs });
    this.log('coordination_claim_started', { parcelId, cost });
    // Allow simultaneous contenders to exchange claims before taking action.
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(undefined); };
      const timer = setTimeout(finish, this.settleMs);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    });
    if (!this.ownClaim || this.ownClaim.parcelId !== parcelId || signal?.aborted) {
      this.release(parcelId, 'yielded'); return false;
    }
    const remote = this.remoteClaims.get(parcelId);
    if (remote && this.winner(this.ownClaim, remote) === remote) {
      this.release(parcelId, 'yielded'); return false;
    }
    return true;
  }
  /** @param {string|undefined} [parcelId] @param {'completed'|'collected'|'failed'|'yielded'|'stopped'} [reason] */
  release(parcelId, reason = 'completed') {
    if (!this.ownClaim || (parcelId && this.ownClaim.parcelId !== parcelId)) return;
    const id = this.ownClaim.parcelId;
    this.ownClaim = null;
    this.send('RELEASE', { parcelId: id, reason });
    this.log('coordination_claim_released', { parcelId: id, reason });
    this.changed();
  }

  /** @param {string} fromId @param {string} fromName @param {unknown} wire */
  receive(fromId, fromName, wire) {
    if (!this.started || fromName !== this.peerName || typeof fromId !== 'string' || !fromId ||
      fromId === this.beliefs.me?.id) return;
    const msg = decodeMessage(wire, this.now());
    if (!msg) return;
    if (msg.type === 'HELLO' && (msg.data.agent !== fromName || msg.data.id !== fromId)) return;
    // Bind a peer identity to its server-provided ID; a replacement identity
    // may join after the old one has been absent for 12 seconds.
    if (this.peerId && fromId !== this.peerId && this.now() - this.peerSeenAt < 12000) return;
    if (this.peerId !== fromId) {
      this.peerId = fromId;
      this.lastSeq = 0;
      this.remoteClaims.clear();
      this.peer = null;
      this.log('coordination_peer_discovered', { name: fromName });
    }
    if (msg.seq <= this.lastSeq) return;
    this.lastSeq = msg.seq;
    this.peerSeenAt = this.now();
    const d = msg.data;
    this.log('coordination_received', { type: msg.type, peer: fromName,
      parcelId: d.parcelId ?? undefined });
    switch (msg.type) {
      case 'HELLO': {
        this.shareBeliefs(true);
        this.sendStatus(true);
        if (this.ownClaim) this.send('CLAIM', { parcelId: this.ownClaim.parcelId, cost: this.ownClaim.cost, leaseMs: this.leaseMs });
        break;
      }
      case 'BELIEF': {
        const networkAge = Math.max(0, this.now() - msg.at);
        let inserted = 0;
        /** @type {import('./protocol.js').SharedParcel[]} */ const reports = d.parcels;
        for (const p of reports) {
          const observedAt = this.beliefs.now() - networkAge - p.ageMs;
          inserted += this.beliefs.onSharedParcels([{
            id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: null,
          }], observedAt);
        }
        this.sharedCount += inserted;
        if (inserted) this.log('coordination_belief_merged', { inserted, parcelIds: reports.map(p => p.id) });
        break;
      }
      case 'STATUS': {
        this.peer = { x: d.x, y: d.y, intention: d.intention, at: this.now() };
        this.changed();
        break;
      }
      case 'CLAIM': {
        const remote = { parcelId: d.parcelId, cost: d.cost, owner: this.peerName,
          expiresAt: Math.min(this.now() + d.leaseMs, msg.at + d.leaseMs) };
        this.remoteClaims.set(d.parcelId, remote);
        this.changed();
        const own = this.ownClaim;
        if (own && own.parcelId === d.parcelId) {
          if (this.winner(own, remote) === remote) {
            this.log('coordination_yield', { parcelId: d.parcelId, to: this.peerName });
            own.onYield?.();
            this.release(d.parcelId, 'yielded');
          } else {
            // Confirm our earlier win when claims cross in flight.
            this.send('CLAIM', { parcelId: own.parcelId, cost: own.cost, leaseMs: this.leaseMs });
          }
        }
        break;
      }
      case 'RELEASE': {
        this.remoteClaims.delete(d.parcelId);
        if (d.reason === 'collected') this.beliefs.onPeerCollected(d.parcelId);
        this.changed();
        break;
      }
    }
  }
  summary() {
    this.expireClaims();
    const now = this.now();
    const seenAgeMs = this.peerSeenAt ? now - this.peerSeenAt : null;
    return {
      enabled: this.started,
      teammate: { name: this.peerName, connected: seenAgeMs !== null && seenAgeMs < 12000,
        ageMs: seenAgeMs, position: this.peer && now - this.peer.at < 12000 ? { x: this.peer.x, y: this.peer.y } : null,
        intention: this.peer && now - this.peer.at < 12000 ? this.peer.intention : null },
      peerClaims: [...this.remoteClaims.values()].slice(0, 12).map(c => ({ parcelId: c.parcelId, pathCost: c.cost, leaseRemainingMs: Math.max(0, c.expiresAt - now) })),
      myClaim: this.ownClaim?.parcelId ?? null,
      sharedParcelUpdates: this.sharedCount,
    };
  }
}
