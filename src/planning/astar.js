import { key } from '../beliefs/map.js';

/**
 * @typedef {import('../beliefs/index.js').Beliefs} Beliefs
 * @typedef {import('../beliefs/map.js').GridMap} GridMap
 * @typedef {import('../types.js').Direction} Direction
 * @typedef {import('../types.js').PathOptions} PathOptions
 * @typedef {import('../types.js').Position} Position
 * @typedef {import('../types.js').TileKey} TileKey
 */

/**
 * A shortest route from `from` to `to`, as a list of moves: empty when
 * already there, null when `to` cannot be reached.
 * @param {GridMap} map
 * @param {Position} from
 * @param {Position} to
 * @param {PathOptions} options
 * @returns {Direction[] | null}
 */
export function findPath(map, from, to, options) {
  return findNearest(map, from, [to], options)?.path ?? null;
}

/**
 * The route planner for plans: A* from `from` to the nearest of `targets`,
 * around the tiles of agents seen recently.
 * @param {Beliefs} beliefs
 * @param {Position} from
 * @param {Position[]} targets
 * @returns {{ target: Position, path: Direction[] } | null}
 */
export function astarRoute(beliefs, from, targets) {
  if (!beliefs.map) return null;
  const now = beliefs.now();
  return findNearest(beliefs.map, from, targets, { now, occupied: beliefs.agents.occupied(now) });
}

/**
 * The target with the shortest route from `from`, and that route. Walls and
 * blocked tiles come from the map's neighbours; tiles occupied
 * by other agents or forbidden are never entered, not even as the target.
 * @param {GridMap} map
 * @param {Position} from
 * @param {Position[]} targets
 * @param {PathOptions} options
 * @returns {{ target: Position, path: Direction[] } | null}
 */
export function findNearest(map, from, targets, { now, occupied = new Set(), forbidden = () => false, ignoreTemporary = false, ignoreCrates = false }) {
  if (targets.some(t => t.x === from.x && t.y === from.y)) return { target: { x: from.x, y: from.y }, path: [] };

  /** @param {number} x @param {number} y */
  const enterable = (x, y) => !occupied.has(key(x, y)) && !forbidden(x, y);
  const goals = targets.filter(t => enterable(t.x, t.y));
  if (goals.length === 0) return null;
  const goalKeys = new Set(goals.map(t => key(t.x, t.y)));

  /** Distance to the nearest goal ignoring walls; never more than the real route. @param {Position} p */
  const estimate = ({ x, y }) => Math.min(...goals.map(t => Math.abs(t.x - x) + Math.abs(t.y - y)));

  /** @type {Map<TileKey, { from: TileKey, dir: Direction } | null>} how each tile was reached */
  const cameFrom = new Map([[key(from.x, from.y), null]]);
  /** @type {Map<TileKey, number>} */
  const cost = new Map([[key(from.x, from.y), 0]]);
  /** @type {{ x: number, y: number, k: TileKey, f: number }[]} */
  const open = [{ x: from.x, y: from.y, k: key(from.x, from.y), f: estimate(from) }];

  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[best].f) best = i;
    const current = open.splice(best, 1)[0];
    if (goalKeys.has(current.k)) return { target: { x: current.x, y: current.y }, path: pathTo(cameFrom, current.k) };

    const g = /** @type {number} */ (cost.get(current.k)) + 1;
    for (const { x, y, dir } of map.neighbors(current.x, current.y, now, { ignoreTemporary, ignoreCrates })) {
      const k = key(x, y);
      if (!enterable(x, y) || g >= (cost.get(k) ?? Infinity)) continue;
      cost.set(k, g);
      cameFrom.set(k, { from: current.k, dir });
      open.push({ x, y, k, f: g + estimate({ x, y }) });
    }
  }
  return null;
}

/**
 * @param {Map<TileKey, { from: TileKey, dir: Direction } | null>} cameFrom
 * @param {TileKey} end
 * @returns {Direction[]}
 */
function pathTo(cameFrom, end) {
  /** @type {Direction[]} */
  const path = [];
  for (let step = cameFrom.get(end); step; step = cameFrom.get(step.from)) path.push(step.dir);
  return path.reverse();
}

/**
 * The number of moves from `from` to every tile it can reach, by breadth-first
 * search under the same rules as findNearest: tiles occupied by other agents
 * or forbidden are never entered. One search gives the distance to every
 * target at once, which is cheaper than an A* search for each of them.
 * @param {GridMap} map
 * @param {Position} from
 * @param {PathOptions} options
 * @returns {Map<TileKey, number>}
 */
export function distancesFrom(map, from, { now, occupied = new Set(), forbidden = () => false, ignoreTemporary = false, ignoreCrates = false }) {
  const start = key(from.x, from.y);
  /** @type {Map<TileKey, number>} */
  const distance = new Map([[start, 0]]);
  /** @type {Position[]} */
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i];
    const d = /** @type {number} */ (distance.get(key(x, y))) + 1;
    for (const next of map.neighbors(x, y, now, { ignoreTemporary, ignoreCrates })) {
      const k = key(next.x, next.y);
      if (distance.has(k) || occupied.has(k) || forbidden(next.x, next.y)) continue;
      distance.set(k, d);
      queue.push(next);
    }
  }
  return distance;
}

/**
 * Distances as distancesFrom gives them, and for tiles only crates keep the
 * agent from, the distance as if the crates were not there. A crate can often
 * be pushed out of the way, which a search with the crates standing still
 * does not see, so those tiles are not left out of deliberation. The movement
 * plan then finds the pushes (findPushingPath), or fails if there are none.
 * @param {GridMap} map
 * @param {Position} from
 * @param {PathOptions} options
 * @returns {Map<TileKey, number>}
 */
export function distancesThroughCrates(map, from, options) {
  const distances = distancesFrom(map, from, options);
  if (map.crateTiles().size === 0) return distances;
  for (const [k, d] of distancesFrom(map, from, { ...options, ignoreCrates: true })) {
    if (!distances.has(k)) distances.set(k, d);
  }
  return distances;
}

/**
 * One move from (x, y) in `dir` with the crates at `crates`: where the agent
 * ends up and where the crates are then, or null if the server would refuse
 * it. Walls and arrows are the map's (see GridMap.neighbors). A crate on the
 * tile entered is pushed one tile further, which needs a free crate tile
 * behind it with no agent on it.
 * @param {GridMap} map
 * @param {Position} at
 * @param {Direction} dir
 * @param {ReadonlySet<TileKey>} crates
 * @param {PathOptions} options
 * @returns {{ x: number, y: number, crates: ReadonlySet<TileKey> } | null}
 */
export function stepWithCrates(map, { x, y }, dir, crates, { now, occupied = new Set(), forbidden = () => false }) {
  const next = map.neighbors(x, y, now, { ignoreCrates: true }).find(n => n.dir === dir);
  if (!next || occupied.has(key(next.x, next.y)) || forbidden(next.x, next.y)) return null;
  const k = key(next.x, next.y);
  if (!crates.has(k)) return { x: next.x, y: next.y, crates };
  if (!map.canPushCrate(next.x, next.y, dir, crates)) return null;
  const behind = { x: next.x + (next.x - x), y: next.y + (next.y - y) };
  if (occupied.has(key(behind.x, behind.y))) return null;
  const moved = new Set(crates);
  moved.delete(k);
  moved.add(key(behind.x, behind.y));
  return { x: next.x, y: next.y, crates: moved };
}

/**
 * A shortest route from `from` to `to` that may push crates on the way, or
 * null. Pushing one crate can free or block the way for the next, so the
 * search keeps track of where every crate is, like a small Sokoban solver.
 * It is an A* search over those states, led by the distance to `to`, and it
 * gives up after `maxStates` states, since a maze of crates can have very many.
 * @param {GridMap} map
 * @param {Position} from
 * @param {Position} to
 * @param {PathOptions & { maxStates?: number }} options
 * @returns {Direction[] | null}
 */
export function findPushingPath(map, from, to, { maxStates = 50_000, ...options }) {
  const goal = key(to.x, to.y);
  if (key(from.x, from.y) === goal) return [];
  const crateKey = (/** @type {ReadonlySet<TileKey>} */ crates) => [...crates].sort().join(';');
  const estimate = (/** @type {Position} */ p) => Math.abs(p.x - to.x) + Math.abs(p.y - to.y);
  const crates = /** @type {ReadonlySet<TileKey>} */ (map.crateTiles());
  const ck = crateKey(crates);
  const first = `${key(from.x, from.y)}|${ck}`;
  /** @type {Map<string, { from: string, dir: Direction } | null>} */
  const cameFrom = new Map([[first, null]]);
  /** @type {Map<string, number>} */
  const cost = new Map([[first, 0]]);
  /** @typedef {{ x: number, y: number, crates: ReadonlySet<TileKey>, ck: string, k: string, g: number, f: number }} State */
  /** @type {State[]} a binary heap ordered by f */
  const heap = [{ x: from.x, y: from.y, crates, ck, k: first, g: 0, f: estimate(from) }];
  const push = (/** @type {State} */ item) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (heap[parent].f <= heap[i].f) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = /** @type {State} */ (heap.pop());
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0 && cameFrom.size < maxStates) {
    const state = pop();
    if (state.g > /** @type {number} */ (cost.get(state.k))) continue;
    if (key(state.x, state.y) === goal) {
      /** @type {Direction[]} */
      const path = [];
      for (let step = cameFrom.get(state.k); step; step = cameFrom.get(step.from)) path.push(step.dir);
      return path.reverse();
    }
    for (const dir of /** @type {Direction[]} */ (['up', 'down', 'left', 'right'])) {
      const next = stepWithCrates(map, state, dir, state.crates, options);
      if (!next) continue;
      const nextCk = next.crates === state.crates ? state.ck : crateKey(next.crates);
      const k = `${key(next.x, next.y)}|${nextCk}`;
      const g = state.g + 1;
      if (g >= (cost.get(k) ?? Infinity)) continue;
      cost.set(k, g);
      cameFrom.set(k, { from: state.k, dir });
      push({ ...next, ck: nextCk, k, g, f: g + estimate(next) });
    }
  }
  return null;
}
