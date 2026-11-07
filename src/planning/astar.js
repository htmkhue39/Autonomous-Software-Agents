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
export function findNearest(map, from, targets, { now, occupied = new Set(), forbidden = () => false }) {
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
    for (const { x, y, dir } of map.neighbors(current.x, current.y, now)) {
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
