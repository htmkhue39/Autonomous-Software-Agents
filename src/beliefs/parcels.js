import { key } from './map.js';

/**
 * @typedef {import('../types.js').ClockEvent} ClockEvent
 * @typedef {import('../types.js').Parcel} Parcel
 * @typedef {import('../types.js').Position} Position
 * @typedef {import('../types.js').TileKey} TileKey
 */

/** @type {Record<string, number>} */
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Milliseconds between two clock events, `Infinity` for 'infinite'.
 * @param {ClockEvent} event
 * @param {number} [clockMs]  milliseconds per frame (the server's CLOCK), for 'frame'
 */
export function decayIntervalMs(event, clockMs) {
  if (event === 'infinite') return Infinity;
  if (event === 'frame') {
    if (clockMs === undefined) throw new Error("A 'frame' clock event needs the server's CLOCK");
    return clockMs;
  }
  const match = /^(\d+)([smh])$/.exec(event);
  if (!match) throw new Error(`Unknown clock event: ${event}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

/**
 * What the agent believes about parcels: where each was last seen, its value
 * then, and who carries it. Values are estimated from the time since then.
 */
export class ParcelBeliefs {
  /** @type {Map<string, { parcel: Parcel, seenAt: number, source?: 'direct'|'peer' }>} */
  #known = new Map();
  /** @type {Map<TileKey, number>} The newest authoritative observation for each tile. */
  #observedTiles = new Map();

  /** @param {number} decayMs  one point lost per this many milliseconds */
  constructor(decayMs) {
    this.decayMs = decayMs;
  }

  /**
   * Record the parcels in view, and forget parcels whose last tile is in view
   * but which are no longer there: taken, carried away or delivered. The
   * parcels the agent carries itself are kept, since they are tracked from
   * its own pickups and putdowns.
   * @param {Parcel[]} parcels
   * @param {Position[]} inView
   * @param {number} now
   * @param {string} [selfId]  the agent's own id
   */
  update(parcels, inView, now, selfId) {
    const seen = new Set(parcels.map(p => p.id));
    for (const t of inView) this.#observedTiles.set(key(t.x, t.y), now);
    /** @type {Set<TileKey>} */
    const viewed = new Set(inView.map(({ x, y }) => key(x, y)));
    for (const [id, { parcel }] of this.#known) {
      if (seen.has(id) || (selfId !== undefined && parcel.carriedBy === selfId)) continue;
      if (viewed.has(key(Math.round(parcel.x), Math.round(parcel.y)))) this.#known.delete(id);
    }
    for (const parcel of parcels) this.#known.set(parcel.id, { parcel: { ...parcel }, seenAt: now, source: 'direct' });
  }

  /** Merge teammate reports only if they do not contradict a newer direct
   * observation. The caller converts sender age to our local game clock.
   * @param {Parcel[]} parcels @param {number} observedAt @param {number} now
   * @returns {number} inserted or refreshed reports
   */
  mergeShared(parcels, observedAt, now) {
    let count = 0;
    if (!Number.isFinite(observedAt) || now - observedAt > 15000 || observedAt > now + 500) return count;
    for (const parcel of parcels) {
      if (!parcel || !Number.isInteger(parcel.x) || !Number.isInteger(parcel.y) || parcel.reward <= 0 || parcel.carriedBy) continue;
      if ((this.#observedTiles.get(key(parcel.x, parcel.y)) ?? -Infinity) >= observedAt) continue;
      const current = this.#known.get(parcel.id);
      if (current && current.seenAt >= observedAt) continue;
      this.#known.set(parcel.id, { parcel: { ...parcel, carriedBy: null }, seenAt: observedAt, source: 'peer' });
      count++;
    }
    return count;
  }

  /** Only directly observed free parcels are relayed; no echo chains. */
  /** @param {number} now @returns {Parcel[]} */
  directFree(now) {
    /** @type {Parcel[]} */ const parcels = [];
    for (const [id, entry] of this.#known) {
      if (entry.source === 'peer') continue;
      const parcel = this.get(id, now);
      if (parcel && !parcel.carriedBy) parcels.push(parcel);
    }
    return parcels;
  }

  /** Reports retain the ORIGINAL observation reward and age, never rebrand
   * old information as a fresh sighting when a heartbeat repeats it.
   * @param {number} now @param {number} [maxAgeMs]
   */
  directReports(now, maxAgeMs = 5000) {
    /** @type {{id:string,x:number,y:number,reward:number,ageMs:number}[]} */ const reports = [];
    for (const [id, entry] of this.#known) {
      const ageMs = Math.max(0, Math.floor(now - entry.seenAt));
      if (entry.source === 'peer' || ageMs > maxAgeMs) continue;
      const parcel = this.get(id, now);
      if (!parcel || parcel.carriedBy) continue;
      reports.push({ id, x: parcel.x, y: parcel.y, reward: entry.parcel.reward, ageMs });
    }
    return reports;
  }

  /** Provenance for one currently known parcel, without turning old peer
   * reports into authoritative fresh observations. Used only to assess how
   * safely a time-sensitive tool can act; never treated as proof of presence.
   * @param {string} id @param {number} now
   * @returns {{source:'direct'|'peer',ageMs:number}|null}
   */
  freshness(id, now) {
    const entry = this.#known.get(id);
    if (!entry) return null;
    return { source: entry.source === 'peer' ? 'peer' : 'direct',
      ageMs: Math.max(0, now - entry.seenAt) };
  }

  /** Forget a parcel confirmed collected or invalidated by a teammate. */
  /** @param {string} id */
  forget(id) { return this.#known.delete(id); }

  /**
   * These parcels were just picked up by `agentId`. Parcels never seen are
   * ignored: their value is unknown until sensing reports them.
   * @param {string[]} ids
   * @param {string} agentId
   */
  pickedUp(ids, agentId) {
    for (const id of ids) {
      const entry = this.#known.get(id);
      if (entry) entry.parcel.carriedBy = agentId;
    }
  }

  /**
   * These parcels were just put down at `at`: forgotten if delivered, else
   * left there, free.
   * @param {string[]} ids
   * @param {Position} at
   * @param {{ delivered: boolean }} how
   */
  putDown(ids, at, { delivered }) {
    for (const id of ids) {
      const entry = this.#known.get(id);
      if (!entry) continue;
      if (delivered) this.#known.delete(id);
      else entry.parcel = { ...entry.parcel, x: at.x, y: at.y, carriedBy: null };
    }
  }

  /**
   * The parcel with its estimated value at `now`, or undefined if unknown or
   * worthless (and then forgotten).
   * @param {string} id
   * @param {number} now
   * @returns {Parcel | undefined}
   */
  get(id, now) {
    const entry = this.#known.get(id);
    if (!entry) return undefined;
    const reward = entry.parcel.reward - Math.floor((now - entry.seenAt) / this.decayMs);
    if (reward <= 0) {
      this.#known.delete(id);
      return undefined;
    }
    return { ...entry.parcel, reward };
  }

  /**
   * Parcels nobody carries that are still worth something.
   * @param {number} now
   */
  free(now) {
    return this.#all(now).filter(p => !p.carriedBy);
  }

  /**
   * @param {string} agentId
   * @param {number} now
   */
  carriedBy(agentId, now) {
    return this.#all(now).filter(p => p.carriedBy === agentId);
  }

  /**
   * @param {number} now
   * @returns {Parcel[]}
   */
  #all(now) {
    const result = [];
    for (const id of [...this.#known.keys()]) {
      const parcel = this.get(id, now);
      if (parcel) result.push(parcel);
    }
    return result;
  }
}
