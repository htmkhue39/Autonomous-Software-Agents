import { key } from './map.js';

/**
 * @typedef {import('../types.js').AgentState} AgentState
 * @typedef {import('../types.js').TileKey} TileKey
 */

/**
 * @typedef {Object} SeenAgent
 * @property {string} id
 * @property {string} name
 * @property {number} x       rounded
 * @property {number} y       rounded
 * @property {number} seenAt
 * @property {number} rawX
 * @property {number} rawY
 */

/**
 * What the agent believes about other agents: where each was last seen, and
 * when. Only recent sightings count as obstacles.
 */
export class AgentBeliefs {
  /** @type {Map<string, SeenAgent>} */
  #seen = new Map();

  /** @param {number} ttlMs  how long a sighting blocks its tile */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }

  /**
   * @param {AgentState[]} agents  other agents in view
   * @param {number} now
   */
  update(agents, now) {
    for (const { id, name, x, y } of agents) {
      this.#seen.set(id, { id, name, x: Math.round(x), y: Math.round(y), rawX: x, rawY: y, seenAt: now });
    }
  }

  /** @param {string} id */
  get(id) {
    return this.#seen.get(id);
  }

  /**
   * Tiles of agents seen within the last `ttlMs`.
   * @param {number} now
   * @returns {Set<TileKey>}
   */
  occupied(now) {
    const result = new Set();
    for (const detail of this.occupiedDetails(now)) {
      for (const tile of detail.tiles) result.add(key(tile.x, tile.y));
    }
    return result;
  }

  /** Human-readable, bounded diagnostics; sighting age matters for recovery.
   * @param {number} now
   */
  occupiedDetails(now) {
    const details = [];
    for (const { id, name, rawX, rawY, seenAt } of this.#seen.values()) {
      const ageMs = Math.max(0, now - seenAt);
      if (ageMs > this.ttlMs) continue;
      const tiles = [];
      for (const x of new Set([Math.floor(rawX), Math.ceil(rawX)])) {
        for (const y of new Set([Math.floor(rawY), Math.ceil(rawY)])) tiles.push({ x, y });
      }
      details.push({ id, name, ageMs, tiles });
    }
    return details;
  }
}
