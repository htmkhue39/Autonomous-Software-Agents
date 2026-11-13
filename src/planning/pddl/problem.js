import { DIRS, key } from '../../beliefs/map.js';

const actions = [
  ['up', 'above'], ['down', 'below'], ['left', 'west'], ['right', 'east'],
];
const id = (/** @type {number} */ x, /** @type {number} */ y) => `t${x}_${y}`;

/** Build a bounded grounded movement problem from known, currently passable tiles.
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {import('../../types.js').Position} from
 * @param {import('../../types.js').Position} to
 * @param {import('../../types.js').PathOptions} options
 */
export function buildNavigationProblem(map, from, to, { now, occupied = new Set(), forbidden = () => false }) {
  const tiles = [];
  const tileSet = new Set();
  for (let x = 0; x < map.width; x++) for (let y = 0; y < map.height; y++) {
    if ((!map.isWalkable(x, y, now) || occupied.has(key(x, y)) || forbidden(x, y)) && !(x === from.x && y === from.y)) continue;
    tiles.push({ x, y }); tileSet.add(key(x, y));
  }
  if (!tileSet.has(key(from.x, from.y)) || !tileSet.has(key(to.x, to.y))) return null;
  const facts = [`(at ${id(from.x, from.y)})`];
  for (const { x, y } of tiles) {
    for (const n of map.neighbors(x, y, now)) {
      if (!tileSet.has(key(n.x, n.y))) continue;
      // Edge predicate is named for the direction of traversal.
      const edge = actions.find(a => a[0] === n.dir)?.[1];
      if (!edge) throw new Error('Missing direction predicate');
      facts.push(`(${edge} ${id(x, y)} ${id(n.x, n.y)})`);
    }
  }
  const domain = `(define (domain deliveroo-navigation)\n (:requirements :strips)\n (:predicates (at ?t) ${actions.map(([,edge]) => `(${edge} ?from ?to)`).join(' ')})\n${actions.map(([dir, edge]) => ` (:action move_${dir}\n  :parameters (?from ?to)\n  :precondition (and (at ?from) (${edge} ?from ?to))\n  :effect (and (not (at ?from)) (at ?to)))`).join('\n')}\n)`;
  const problem = `(define (problem delivery-route) (:domain deliveroo-navigation)\n (:objects ${tiles.map(t => id(t.x, t.y)).join(' ')})\n (:init ${facts.join(' ')})\n (:goal (at ${id(to.x, to.y)}))\n)`;
  return { domain, problem };
}

/** Decode only known movement actions and verify every returned edge.
 * Invalid or unrecognized solver output must not be sent to the game.
 * @param {unknown} plan
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {import('../../types.js').Position} from
 * @param {import('../../types.js').Position} to
 * @param {import('../../types.js').PathOptions} options
 */
export function decodeNavigationPlan(plan, map, from, to, options) {
  if (!Array.isArray(plan)) throw new Error('Planner returned no action sequence');
  /** @type {import('../../types.js').Direction[]} */
  const route = [];
  let pos = { ...from };
  for (const step of plan) {
    const text = typeof step === 'string' ? step : typeof step?.action === 'string' ? step.action : (typeof step?.name === 'string' ? step.name : null);
    if (!text) throw new Error('Unknown PDDL action');
    const tokens = text.trim().replace(/[()]/g, '').split(/\s+/).filter(Boolean);
    const action = tokens[0].toLowerCase().replace(/-/g, '_');
    const candidate = action.startsWith('move_') ? action.slice(5) : '';
    if (!(candidate in DIRS)) throw new Error(`Unexpected PDDL action: ${action}`);
    const dir = /** @type {import('../../types.js').Direction} */ (candidate);
    const args = Array.isArray(step?.args) ? step.args : tokens.slice(1);
    const next = { x: pos.x + DIRS[dir].dx, y: pos.y + DIRS[dir].dy };
    if (args.length >= 2 && (String(args[0]).toLowerCase() !== id(pos.x, pos.y) || String(args[1]).toLowerCase() !== id(next.x, next.y))) throw new Error('PDDL plan arguments do not match route');
    if (!map.neighbors(pos.x, pos.y, options.now).some(n => n.dir === dir && n.x === next.x && n.y === next.y) || options.occupied?.has(key(next.x, next.y)) || options.forbidden?.(next.x, next.y)) throw new Error('PDDL plan crosses an unavailable edge');
    route.push(dir);
    pos = next;
  }
  if (pos.x !== to.x || pos.y !== to.y) throw new Error('PDDL plan does not achieve its goal');
  return route;
}
