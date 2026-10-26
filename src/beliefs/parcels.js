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
  /** @type {Map<string, { parcel: Parcel, seenAt: number }>} */
  #known = new Map();

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
    /** @type {Set<TileKey>} */
    const viewed = new Set(inView.map(({ x, y }) => key(x, y)));
    for (const [id, { parcel }] of this.#known) {
      if (seen.has(id) || (selfId !== undefined && parcel.carriedBy === selfId)) continue;
      if (viewed.has(key(Math.round(parcel.x), Math.round(parcel.y)))) this.#known.delete(id);
    }
    for (const parcel of parcels) this.#known.set(parcel.id, { parcel: { ...parcel }, seenAt: now });
  }

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

  /** @param {string} id */
  forget(id) {
    this.#known.delete(id);
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
