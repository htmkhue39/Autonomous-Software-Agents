import { key } from './map.js';

/**
 * @typedef {import('../types.js').AgentState} AgentState
 * @typedef {import('../types.js').Position} Position
 * @typedef {import('../types.js').TileKey} TileKey
 */

/**
 * @typedef {Object} SeenAgent
 * @property {string} id
 * @property {string} name
 * @property {number} x       rounded
 * @property {number} y       rounded
 * @property {number} seenAt
 */

/**
 * What the agent believes about other agents: where each was last seen, and
 * when. Only recent sightings count as obstacles, and an agent is forgotten
 * once its last tile is seen without it.
 */
export class AgentBeliefs {
  /** @type {Map<string, SeenAgent>} */
  #seen = new Map();

  /** @param {number} ttlMs  how long a sighting blocks its tile */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }

  /**
   * Record the agents in view, and forget agents whose last tile is in view
   * but which are no longer there.
   * @param {AgentState[]} agents  other agents in view
   * @param {Position[]} inView
   * @param {number} now
   */
  update(agents, inView, now) {
    const seen = new Set(agents.map(a => a.id));
    /** @type {Set<TileKey>} */
    const viewed = new Set(inView.map(({ x, y }) => key(x, y)));
    for (const [id, { x, y }] of this.#seen) {
      if (!seen.has(id) && viewed.has(key(x, y))) this.#seen.delete(id);
    }
    for (const { id, name, x, y } of agents) {
      this.#seen.set(id, { id, name, x: Math.round(x), y: Math.round(y), seenAt: now });
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
    for (const { x, y, seenAt } of this.#seen.values()) {
      if (now - seenAt <= this.ttlMs) result.add(key(x, y));
    }
    return result;
  }
}
