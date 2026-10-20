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

/** @type {Partial<Record<TileType, Direction>>} */
const ARROWS = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };

/** @type {Record<Direction, Direction>} */
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

/**
 * Whether a tile of this type can be entered by a move in `dir`. Arrow tiles
 * refuse only a move against the arrow; they can be entered from the side
 * and left in any direction. This is the server's rule (design.md section 9).
 * @param {TileType} type
 * @param {Direction} dir
 */
function allowsEntry(type, dir) {
  const arrow = ARROWS[type];
  return arrow === undefined || OPPOSITE[arrow] !== dir;
}

/**
 * What the agent believes about the map: the type of every tile, tiles to
 * avoid for a while after a failed move, and when each tile was last in view.
 */
export class GridMap {
  /** @type {Map<TileKey, TileType>} */
  #types = new Map();
  /** @type {Map<TileKey, number>} time until which the tile is blocked */
  #blockedUntil = new Map();
  /** @type {Map<TileKey, number>} */
  #seenAt = new Map();

  /**
   * @param {number} width
   * @param {number} height
   * @param {Tile[]} tiles
   */
  constructor(width, height, tiles) {
    this.width = width;
    this.height = height;
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
   * On the map, not a wall or a crate tile, and not blocked at `now`.
   * @param {number} x
   * @param {number} y
   * @param {number} now
   */
  isWalkable(x, y, now) {
    const type = this.typeAt(x, y);
    if (type === undefined || type === '0' || type.startsWith('5')) return false;
    return (this.#blockedUntil.get(key(x, y)) ?? -Infinity) <= now;
  }

  /**
   * Tiles one step away that the agent can move into, with the direction.
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
      const type = this.typeAt(nx, ny);
      if (type !== undefined && this.isWalkable(nx, ny, now) && allowsEntry(type, dir)) {
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
