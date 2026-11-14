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
 * @property {TileKey[]} tiles  the tiles it holds: two while it moves between them
 * @property {number} seenAt
 */

/**
 * What the agent believes about other agents: where each was last seen, and
 * when. Only recent sightings count as obstacles, and an agent is forgotten
 * once its last tiles are seen without it.
 */
export class AgentBeliefs {
  /** @type {Map<string, SeenAgent>} */
  #seen = new Map();
  /**
   * For each agent, where it is now (`at`) and the different position it was
   * seen at before that (`from`), not rounded. Used to tell which way it is
   * going.
   * @type {Map<string, { from: Position, at: Position }>}
   */
  #moves = new Map();

  /** @param {number} ttlMs  how long a sighting blocks its tile */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }

  /**
   * Record the agents in view, and forget agents whose last tiles are all in
   * view but which are no longer there.
   * @param {AgentState[]} agents  other agents in view
   * @param {Position[]} inView
   * @param {number} now
   */
  update(agents, inView, now) {
    const seen = new Set(agents.map(a => a.id));
    /** @type {Set<TileKey>} */
    const viewed = new Set(inView.map(({ x, y }) => key(x, y)));
    for (const [id, { tiles }] of this.#seen) {
      if (!seen.has(id) && tiles.every(tile => viewed.has(tile))) {
        this.#seen.delete(id);
        this.#moves.delete(id);
      }
    }
    for (const { id, name, x, y } of agents) {
      const last = this.#moves.get(id);
      if (!last) this.#moves.set(id, { from: { x, y }, at: { x, y } });
      else if (last.at.x !== x || last.at.y !== y) this.#moves.set(id, { from: last.at, at: { x, y } });
      this.#seen.set(id, { id, name, x: Math.round(x), y: Math.round(y), tiles: heldTiles(x, y), seenAt: now });
    }
  }

  /** @param {string} id */
  get(id) {
    return this.#seen.get(id);
  }

  /** The number of other agents the agent remembers. */
  get count() {
    return this.#seen.size;
  }

  /**
   * Whether another agent will probably get to `target` before us. That is
   * the case when an agent seen in the last `ttlMs`:
   * - is closer to `target` than we are, and
   * - is next to `target`, or got closer to it since it was last seen.
   * Its distance is counted in a straight line on the grid (we do not know
   * its route).
   * @param {Position} target
   * @param {number} distance  our own number of moves to `target`
   * @param {number} now
   */
  beatsUsTo(target, distance, now) {
    /** @param {Position} p */
    const away = p => Math.abs(p.x - target.x) + Math.abs(p.y - target.y);
    for (const [id, { seenAt }] of this.#seen) {
      const moves = this.#moves.get(id);
      if (!moves || now - seenAt > this.ttlMs) continue;
      const left = away(moves.at);
      if (left < distance && (left <= 1 || left < away(moves.from))) return true;
    }
    return false;
  }

  /**
   * Tiles of agents seen within the last `ttlMs`.
   * @param {number} now
   * @returns {Set<TileKey>}
   */
  occupied(now) {
    const result = new Set();
    for (const { tiles, seenAt } of this.#seen.values()) {
      if (now - seenAt <= this.ttlMs) for (const tile of tiles) result.add(tile);
    }
    return result;
  }
}

/**
 * The tiles an agent at a possibly fractional position holds: the one it is
 * leaving and the one it is entering while it moves, else just its own.
 * @param {number} x
 * @param {number} y
 * @returns {TileKey[]}
 */
function heldTiles(x, y) {
  const xs = [...new Set([Math.floor(x), Math.ceil(x)])];
  const ys = [...new Set([Math.floor(y), Math.ceil(y)])];
  return xs.flatMap(tx => ys.map(ty => key(tx, ty)));
}
