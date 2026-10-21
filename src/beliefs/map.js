/**
 * @typedef {import('../types.js').Direction} Direction
 * @typedef {import('../types.js').Position} Position
 * @typedef {import('../types.js').Tile} Tile
 * @typedef {import('../types.js').TileKey} TileKey
 * @typedef {import('../types.js').TileType} TileType
 */

/**
 * @param {number} x
 * @param {number} y
 * @returns {TileKey}
 */
export function key(x, y) {
  return `${x},${y}`;
}

/** One step in each direction. `up` is y + 1. */
export const DIRS = /** @type {const} */ ({
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
});

/**
 * What the agent believes about the map: the type of every tile, tiles and
 * moves to avoid for a while, and when each tile was last in view.
 *
 * A refused move is remembered as that one move, not the whole tile, since
 * the tile may still be enterable from another side. Each time the same move
 * is refused again it stays blocked twice as long, so a passing agent is
 * soon forgotten while a passage that never works is avoided for longer.
 */
export class GridMap {
  /** @type {Map<TileKey, TileType>} */
  #types = new Map();
  /** @type {Map<TileKey, number>} time until which the tile is blocked */
  #blockedUntil = new Map();
  /** @type {Map<string, { failures: number, until: number }>} refused moves by `${x},${y},${dir}` */
  #failedMoves = new Map();
  /** @type {Map<TileKey, number>} */
  #seenAt = new Map();

  /**
   * @param {number} width
   * @param {number} height
   * @param {Tile[]} tiles
   * @param {{ blockedTtlMs?: number, maxBlockedMs?: number }} [options]
   *   how long a refused move is first avoided, and the most it ever is
   */
  constructor(width, height, tiles, { blockedTtlMs = 2000, maxBlockedMs = 30_000 } = {}) {
    this.width = width;
    this.height = height;
    this.blockedTtlMs = blockedTtlMs;
    this.maxBlockedMs = maxBlockedMs;
    for (const tile of tiles) this.updateTile(tile);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {TileType | undefined}
   */
  typeAt(x, y) {
    return this.#types.get(key(x, y));
  }

  /** @param {Tile} tile */
  updateTile({ x, y, type }) {
    this.#types.set(key(x, y), type);
  }

  /**
   * Treat a tile as unwalkable until `untilMs`.
   * @param {number} x
   * @param {number} y
   * @param {number} untilMs
   */
  block(x, y, untilMs) {
    this.#blockedUntil.set(key(x, y), untilMs);
  }

  /**
   * The server refused the move `dir` from (x, y) at `now`: avoid it for a
   * while, twice as long as the last time it was refused.
   * @param {number} x
   * @param {number} y
   * @param {Direction} dir
   * @param {number} now
   */
  failMove(x, y, dir, now) {
    const k = `${key(x, y)},${dir}`;
    const failures = (this.#failedMoves.get(k)?.failures ?? 0) + 1;
    const ttl = Math.min(this.blockedTtlMs * 2 ** (failures - 1), this.maxBlockedMs);
    this.#failedMoves.set(k, { failures, until: now + ttl });
  }

  /**
   * The move `dir` from (x, y) worked: forget any earlier refusals.
   * @param {number} x
   * @param {number} y
   * @param {Direction} dir
   */
  moveSucceeded(x, y, dir) {
    this.#failedMoves.delete(`${key(x, y)},${dir}`);
  }

  /**
   * On the map, not a wall, and not blocked at `now`.
   * @param {number} x
   * @param {number} y
   * @param {number} now
   */
  isWalkable(x, y, now) {
    const type = this.typeAt(x, y);
    if (type === undefined || type === '0') return false;
    return (this.#blockedUntil.get(key(x, y)) ?? -Infinity) <= now;
  }

  /**
   * Tiles one step away that the agent can move into, with the direction,
   * leaving out moves that were refused recently.
   * @param {number} x
   * @param {number} y
   * @param {number} now
   * @returns {(Position & { dir: Direction })[]}
   */
  neighbors(x, y, now) {
    const result = [];
    for (const [dir, { dx, dy }] of /** @type {[Direction, {dx: number, dy: number}][]} */ (Object.entries(DIRS))) {
      const nx = x + dx;
      const ny = y + dy;
      const refusedUntil = this.#failedMoves.get(`${key(x, y)},${dir}`)?.until ?? -Infinity;
      if (this.isWalkable(nx, ny, now) && refusedUntil <= now) {
        result.push({ x: nx, y: ny, dir });
      }
    }
    return result;
  }

  /** @returns {Position[]} */
  deliveryTiles() {
    return this.#tilesOfType('2');
  }

  /** @returns {Position[]} */
  spawnTiles() {
    return this.#tilesOfType('1');
  }

  /**
   * Record that these tiles were in view at `now`.
   * @param {Position[]} positions
   * @param {number} now
   */
  markSeen(positions, now) {
    for (const { x, y } of positions) this.#seenAt.set(key(x, y), now);
  }

  /**
   * When the tile was last in view; `-Infinity` if never.
   * @param {number} x
   * @param {number} y
   */
  lastSeen(x, y) {
    return this.#seenAt.get(key(x, y)) ?? -Infinity;
  }

  /** @param {TileType} type */
  #tilesOfType(type) {
    const result = [];
    for (const [k, t] of this.#types) {
      if (t !== type) continue;
      const [x, y] = k.split(',').map(Number);
      result.push({ x, y });
    }
    return result;
  }
}
