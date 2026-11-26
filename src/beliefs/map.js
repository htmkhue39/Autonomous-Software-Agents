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
  /** @type {{ deliveries: Set<TileKey>, spawns: Set<TileKey> } | null} cached until a tile changes */
  #sustainable = null;
  /** @type {Set<TileKey>} tiles where a crate was last seen */
  #crates = new Set();
  #doubleDelivery = false;

  /**
   * Whether the game scores parcels delivered on '9' tiles twice (the
   * 'double-delivery' plugin). Without the plugin a '9' tile is not a
   * delivery tile at all.
   */
  get doubleDelivery() { return this.#doubleDelivery; }

  #doorsLocked = false;
  /**
   * Whether door tiles ('7') are closed to the agent. With the 'keys-doors'
   * plugin, entering a door takes a key, which crossing it uses up; the
   * beliefs lock the doors while the agent has no key. Without the plugin a
   * '7' tile is an ordinary tile and this stays false.
   */
  get doorsLocked() { return this.#doorsLocked; }
  set doorsLocked(locked) {
    if (locked !== this.#doorsLocked) this.#sustainable = null;
    this.#doorsLocked = locked;
  }
  set doubleDelivery(on) {
    if (on !== this.#doubleDelivery) this.#sustainable = null;
    this.#doubleDelivery = on;
  }

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

  /**
   * How many times their reward parcels delivered on (x, y) score: 1 on a
   * '2' tile, 2 on a '9' tile when the game doubles them, and 0 anywhere else.
   * @param {number} x
   * @param {number} y
   */
  deliveryMultiplier(x, y) {
    const type = this.typeAt(x, y);
    if (type === '2') return 1;
    if (type === '9' && this.doubleDelivery) return 2;
    return 0;
  }

  /**
   * Record the crates in view. A crate seen before on a tile that is now in
   * view without it has been pushed away.
   * @param {Position[]} crates
   * @param {Position[]} inView
   */
  updateCrates(crates, inView) {
    for (const { x, y } of inView) this.#crates.delete(key(x, y));
    for (const { x, y } of crates) this.#crates.add(key(x, y));
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  hasCrate(x, y) {
    return this.#crates.has(key(x, y));
  }

  /** The tiles where crates are believed to be. @returns {Set<TileKey>} */
  crateTiles() {
    return new Set(this.#crates);
  }

  /**
   * The agent moved in `dir` onto (x, y) and so pushed the crate there one
   * tile further, if it believed one was there.
   * @param {number} x
   * @param {number} y
   * @param {Direction} dir
   */
  cratePushed(x, y, dir) {
    if (!this.#crates.delete(key(x, y))) return;
    this.#crates.add(key(x + DIRS[dir].dx, y + DIRS[dir].dy));
  }

  /**
   * Whether a crate on (x, y) can be pushed one tile in `dir`, as the course
   * server allows (backend/src/core/movement/worldRules.js): the tile behind
   * it must be a crate tile ('5' or '5!') with no other crate on it.
   * @param {number} x
   * @param {number} y
   * @param {Direction} dir
   * @param {ReadonlySet<TileKey>} [crates]  where the crates are, by default where they are believed to be
   */
  canPushCrate(x, y, dir, crates = this.#crates) {
    const bx = x + DIRS[dir].dx;
    const by = y + DIRS[dir].dy;
    return (this.typeAt(bx, by) ?? '').startsWith('5') && !crates.has(key(bx, by));
  }

  /** @param {Tile} tile */
  updateTile({ x, y, type }) {
    if (this.#types.get(key(x, y)) !== type) this.#sustainable = null;
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
  isWalkable(x, y, now, { ignoreTemporary = false } = {}) {
    const type = this.typeAt(x, y);
    if (type === undefined || type === '0') return false;
    // A locked door is as closed as a wall, for diagnostics too.
    if (type === '7' && this.#doorsLocked) return false;
    return ignoreTemporary || (this.#blockedUntil.get(key(x, y)) ?? -Infinity) <= now;
  }

  /**
   * Tiles one step away that the agent can move into, with the direction,
   * leaving out moves that were refused recently.
   * @param {number} x
   * @param {number} y
   * @param {number} now
   *
   * A tile with a crate can only be entered when the move pushes the crate
   * one tile further (see canPushCrate).
   *
   * An arrow tile only forbids stepping onto it against its arrow. Stepping
   * onto it the way the arrow points, or from the side, is allowed, and it
   * can be left in any direction, even against the arrow. This is the rule in
   * the course server (backend/src/core/Tile.js) and what the user sees in
   * the game.
   * @param {{ignoreTemporary?:boolean, ignoreCrates?:boolean}} [options] `ignoreTemporary` is for
   *   diagnostics only: it keeps walls and arrow rules and drops everything
   *   that passes, crates included. `ignoreCrates` drops only the crates.
   * @returns {(Position & { dir: Direction })[]}
   */
  neighbors(x, y, now, { ignoreTemporary = false, ignoreCrates = false } = {}) {
    const result = [];
    const arrow = /** @type {Record<string, Direction>} */ ({ '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' });
    const opposite = /** @type {Record<Direction, Direction>} */ ({ up: 'down', down: 'up', left: 'right', right: 'left' });
    /** Whether a move in `dir` goes against the arrow on the tile (tx, ty), if it has one. @param {number} tx @param {number} ty @param {Direction} dir */
    const against = (tx, ty, dir) => {
      const pointing = arrow[this.typeAt(tx, ty) ?? ''];
      return pointing !== undefined && opposite[pointing] === dir;
    };
    for (const [dir, { dx, dy }] of /** @type {[Direction, {dx: number, dy: number}][]} */ (Object.entries(DIRS))) {
      const nx = x + dx;
      const ny = y + dy;
      if (against(nx, ny, dir)) continue;
      // Crates move, so they do not count when only the lasting rules are asked for.
      if (!ignoreTemporary && !ignoreCrates && this.#crates.has(key(nx, ny)) && !this.canPushCrate(nx, ny, dir)) continue;
      const refusedUntil = this.#failedMoves.get(`${key(x, y)},${dir}`)?.until ?? -Infinity;
      if (this.isWalkable(nx, ny, now, { ignoreTemporary }) && (ignoreTemporary || refusedUntil <= now)) {
        result.push({ x: nx, y: ny, dir });
      }
    }
    return result;
  }

  /** @returns {Position[]} the tiles where parcels are delivered for points */
  deliveryTiles() {
    return this.doubleDelivery ? [...this.#tilesOfType('2'), ...this.#tilesOfType('9')] : this.#tilesOfType('2');
  }

  /** @returns {Position[]} */
  spawnTiles() {
    return this.#tilesOfType('1');
  }

  /**
   * The delivery and spawn tiles the agent can go to and still keep playing.
   *
   * Arrow tiles can make one-way traps: an area that can be entered but never
   * left. A delivery tile inside such an area can be reached once, but after
   * delivering there the agent can never reach a parcel again. In the same
   * way, a parcel inside a trap may be reachable while no delivery tile can be
   * reached from it. A tile counts here only if it is part of a loop that
   * goes on for ever: from a sustainable delivery tile the agent can reach a
   * sustainable spawn tile, and from a sustainable spawn tile it can reach a
   * sustainable delivery tile.
   *
   * Only the lasting rules are used: walls and arrows. Agents in the way and
   * refused moves are ignored, since they pass. The result is computed once
   * and kept until a tile changes type.
   * @returns {{ deliveries: Set<TileKey>, spawns: Set<TileKey> }}
   */
  sustainableTiles() {
    if (this.#sustainable) return this.#sustainable;
    // For every tile, the tiles from which one move leads to it.
    /** @type {Map<TileKey, TileKey[]>} */
    const comingFrom = new Map();
    for (const k of this.#types.keys()) {
      const [x, y] = k.split(',').map(Number);
      if (!this.isWalkable(x, y, 0, { ignoreTemporary: true })) continue;
      for (const next of this.neighbors(x, y, 0, { ignoreTemporary: true })) {
        const nk = key(next.x, next.y);
        comingFrom.set(nk, [...(comingFrom.get(nk) ?? []), k]);
      }
    }
    /** Every tile from which one of `targets` can be reached. @param {Set<TileKey>} targets */
    const canReach = targets => {
      const seen = new Set(targets);
      const queue = [...targets];
      for (let i = 0; i < queue.length; i++) {
        for (const before of comingFrom.get(queue[i]) ?? []) {
          if (!seen.has(before)) { seen.add(before); queue.push(before); }
        }
      }
      return seen;
    };
    const keys = (/** @type {Position[]} */ tiles) => tiles.map(t => key(t.x, t.y));
    let deliveries = new Set(keys(this.deliveryTiles()));
    let spawns = new Set(keys(this.spawnTiles()));
    // Drop tiles that cannot reach the other kind until nothing changes.
    for (;;) {
      const towardsDelivery = canReach(deliveries);
      const nextSpawns = new Set([...spawns].filter(k => towardsDelivery.has(k)));
      const towardsSpawn = canReach(nextSpawns);
      const nextDeliveries = new Set([...deliveries].filter(k => towardsSpawn.has(k)));
      const stable = nextSpawns.size === spawns.size && nextDeliveries.size === deliveries.size;
      spawns = nextSpawns;
      deliveries = nextDeliveries;
      if (stable) break;
    }
    this.#sustainable = { deliveries, spawns };
    return this.#sustainable;
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
