import { DOMAIN } from './domain.js';
import { DIRS, key } from '../../beliefs/map.js';

// One plan per intention (design: docs/superpowers/specs/2026-11-24-intention-planner-design.md).

/** @typedef {import('../../types.js').Position} Position */
/** @typedef {import('../../types.js').Direction} Direction */
/** @typedef {import('../../types.js').PathOptions} PathOptions */
/** @typedef {import('../../types.js').PlanGoal} PlanGoal */
/** @typedef {import('../../types.js').PlanStep} PlanStep */
/** @typedef {import('../../types.js').DecodedPlan} DecodedPlan */
/** @typedef {import('../../types.js').ProblemSpec} ProblemSpec */

/** The name of the tile object at (x, y). @param {number} x @param {number} y */
const tileName = (x, y) => `t${x}_${y}`;

/**
 * Whether the agent may stand on (x, y) in a plan: on the map and walkable
 * now, not held by another agent, not forbidden, and without a crate, since
 * the domain does not model pushing crates.
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {PathOptions} paths
 * @param {number} x @param {number} y
 */
function enterable(map, paths, x, y) {
  return map.isWalkable(x, y, paths.now) && !paths.occupied?.has(key(x, y)) &&
    !paths.forbidden?.(x, y) && !map.hasCrate(x, y);
}

/**
 * The PDDL problem for one intention, built from what the agent believes
 * now. Parcels have generic names: the parcel to pick up is `target` and the
 * carried ones are `carried1`, `carried2` and so on, so that a plan does not
 * depend on which parcel it was made for.
 *
 * Returns null when the agent's tile is not on the map, or when a tile the
 * goal needs cannot be entered now.
 * @param {{ map: import('../../beliefs/map.js').GridMap, from: Position, paths: PathOptions,
 *   carried: number, goal: PlanGoal }} input
 * @returns {ProblemSpec | null}
 */
export function buildProblem({ map, from, paths, carried, goal }) {
  /** @type {Position[]} */
  const tiles = [];
  const kept = new Set();
  for (let x = 0; x < map.width; x++) for (let y = 0; y < map.height; y++) {
    // The agent's own tile is always kept, whatever stands on it.
    const start = x === from.x && y === from.y;
    if (!start && !enterable(map, paths, x, y)) continue;
    if (start && !map.isWalkable(x, y, paths.now)) continue;
    tiles.push({ x, y });
    kept.add(key(x, y));
  }
  const needed = [from];
  if (goal.kind !== 'deliver') needed.push(goal.parcelAt);
  if (goal.kind !== 'pickup') needed.push(goal.deliverAt);
  if (needed.some(p => !kept.has(key(p.x, p.y)))) return null;

  const carriedNames = Array.from({ length: carried }, (_, i) => `carried${i + 1}`);
  /** @type {Set<string>} */
  const edges = new Set();
  /** @type {Set<string>} */
  const deliveries = new Set();
  const facts = [`(at ${tileName(from.x, from.y)})`];
  for (const { x, y } of tiles) {
    if (map.deliveryMultiplier(x, y) > 0) {
      deliveries.add(key(x, y));
      facts.push(`(delivery ${tileName(x, y)})`);
    }
    for (const n of map.neighbors(x, y, paths.now)) {
      if (!kept.has(key(n.x, n.y))) continue;
      edges.add(`${key(x, y)},${n.dir}`);
      facts.push(`(${n.dir} ${tileName(x, y)} ${tileName(n.x, n.y)})`);
    }
  }
  if (goal.kind !== 'deliver') facts.push(`(parcel-at target ${tileName(goal.parcelAt.x, goal.parcelAt.y)})`);
  for (const name of carriedNames) facts.push(`(carrying ${name})`);

  const goals = goal.kind === 'pickup' ? ['(carrying target)'] : [
    ...(goal.kind === 'trip' ? ['(delivered target)'] : []),
    ...carriedNames.map(name => `(delivered ${name})`),
    `(at ${tileName(goal.deliverAt.x, goal.deliverAt.y)})`,
  ];
  const parcels = [...(goal.kind === 'deliver' ? [] : ['target']), ...carriedNames];
  const problem = `(define (problem intention) (:domain deliveroo)
 (:objects ${[...parcels, ...tiles.map(t => tileName(t.x, t.y))].join(' ')})
 (:init ${facts.join(' ')})
 (:goal (and ${goals.join(' ')})))`;
  return { domain: DOMAIN, problem, from: { x: from.x, y: from.y }, goal, carried, edges, deliveries, tiles: tiles.length };
}

/**
 * One action of a solver plan as its name and arguments, in lower case. The
 * course client returns `{ action, args }` objects; plain text lines such as
 * `(move-left t1_0 t0_0)` are accepted too.
 * @param {unknown} step
 * @returns {{ name: string, args: string[] }}
 */
function readAction(step) {
  if (typeof step === 'string') {
    const [name = '', ...args] = step.replace(/[()]/g, ' ').trim().toLowerCase().split(/\s+/);
    return { name, args: args.filter(Boolean) };
  }
  const object = /** @type {{ action?: unknown, name?: unknown, args?: unknown }} */ (step ?? {});
  const name = typeof object.action === 'string' ? object.action : typeof object.name === 'string' ? object.name : '';
  // The client splits lines on single spaces, so a doubled space leaves an empty argument.
  const args = Array.isArray(object.args) ? object.args.map(a => String(a).trim().toLowerCase()).filter(Boolean) : [];
  return { name: name.trim().toLowerCase(), args };
}

/**
 * Check a solver plan against the problem it answers, by carrying it out on
 * the problem's own facts, and return its steps and the tiles it walks
 * through. Anything wrong throws, so that the plan is never used: an unknown
 * action, a move that does not start where the agent is or does not follow an
 * edge of the problem, a pickup or putdown that is not allowed where the
 * agent stands, or a plan that does not reach the goal.
 *
 * The steps keep every move, the pickup, and exactly one putdown, at the
 * end on the goal's delivery tile. The solver may put parcels down on a
 * delivery tile on the way; those putdowns are dropped, because the game's
 * putdown drops everything the agent carries, so the one at the end
 * delivers every parcel anyway.
 * @param {unknown} plan
 * @param {ProblemSpec} spec
 * @returns {DecodedPlan}
 */
export function decodePlan(plan, spec) {
  if (!Array.isArray(plan)) throw new Error('The solver returned no plan');
  const directions = /** @type {Direction[]} */ (['up', 'down', 'left', 'right']);
  let at = { ...spec.from };
  /** @type {Map<string, string>} where each parcel not yet picked up lies */
  const lying = new Map(spec.goal.kind === 'deliver' ? [] : [['target', key(spec.goal.parcelAt.x, spec.goal.parcelAt.y)]]);
  const carrying = new Set(Array.from({ length: spec.carried }, (_, i) => `carried${i + 1}`));
  const delivered = new Set();
  /** @type {PlanStep[]} */
  const steps = [];
  const path = [{ ...at }];
  for (const raw of plan) {
    const { name, args } = readAction(raw);
    // A blank line of the solver's output is not an action.
    if (name === '') continue;
    const here = tileName(at.x, at.y);
    if (name.startsWith('move-') && directions.includes(/** @type {Direction} */ (name.slice(5)))) {
      const dir = /** @type {Direction} */ (name.slice(5));
      if (args.length !== 2) throw new Error(`PDDL action ${name} needs 2 arguments`);
      if (args[0] !== here) throw new Error(`PDDL move starts on ${args[0]}, which is not where the agent is (${here})`);
      const next = { x: at.x + DIRS[dir].dx, y: at.y + DIRS[dir].dy };
      if (args[1] !== tileName(next.x, next.y) || !spec.edges.has(`${key(at.x, at.y)},${dir}`)) {
        throw new Error(`PDDL move ${args[0]} to ${args[1]} is not an edge of the problem`);
      }
      at = next;
      path.push({ ...at });
      steps.push({ action: 'move', dir });
    } else if (name === 'pickup') {
      if (args.length !== 2) throw new Error('PDDL action pickup needs 2 arguments');
      if (args[1] !== here || lying.get(args[0]) !== key(at.x, at.y)) throw new Error(`PDDL pickup of ${args[0]} is not allowed on ${here}`);
      lying.delete(args[0]);
      carrying.add(args[0]);
      steps.push({ action: 'pickup' });
    } else if (name === 'putdown') {
      if (args.length !== 2) throw new Error('PDDL action putdown needs 2 arguments');
      if (args[1] !== here || !spec.deliveries.has(key(at.x, at.y)) || !carrying.has(args[0])) {
        throw new Error(`PDDL putdown of ${args[0]} is not allowed on ${here}`);
      }
      carrying.delete(args[0]);
      delivered.add(args[0]);

    } else {
      throw new Error(`Unknown PDDL action: ${name || '(empty)'}`);
    }
  }
  const goal = spec.goal;
  const reached = goal.kind === 'pickup' ? carrying.has('target') :
    (goal.kind === 'deliver' || delivered.has('target')) &&
    Array.from({ length: spec.carried }, (_, i) => `carried${i + 1}`).every(p => delivered.has(p)) &&
    at.x === goal.deliverAt.x && at.y === goal.deliverAt.y;
  if (!reached) throw new Error('The PDDL plan does not reach the goal');
  if (goal.kind !== 'pickup') steps.push({ action: 'putdown' });
  return { steps, path };
}

/**
 * Whether every move of a plan is still allowed now: each move must still
 * follow an edge of the map, and enter a tile that no other agent holds, that
 * is not forbidden, and that has no crate.
 * @param {DecodedPlan} plan
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {PathOptions} paths
 */
export function planStillWorks(plan, map, paths) {
  let at = plan.path[0];
  for (const step of plan.steps) {
    if (step.action !== 'move') continue;
    const next = { x: at.x + DIRS[step.dir].dx, y: at.y + DIRS[step.dir].dy };
    const edge = map.neighbors(at.x, at.y, paths.now).some(n => n.dir === step.dir);
    if (!edge || !enterable(map, paths, next.x, next.y)) return false;
    at = next;
  }
  return true;
}

/**
 * The moves of one leg of a plan from the tile `at`: leg 0 is the walk before
 * the plan's first pickup or putdown, and leg 1 the walk between its first and
 * second. Returns null when `at` is not on that leg's path.
 * @param {DecodedPlan} plan
 * @param {Position} at
 * @param {0 | 1} leg
 * @returns {Direction[] | null}
 */
export function routeFrom(plan, at, leg) {
  /** @type {{ tile: Position, dir: Direction }[][]} */
  const legs = [[]];
  let tile = plan.path[0];
  /** @type {Position[]} the tile each leg ends on */
  const ends = [];
  for (const step of plan.steps) {
    if (step.action === 'move') {
      legs[legs.length - 1].push({ tile, dir: step.dir });
      tile = { x: tile.x + DIRS[step.dir].dx, y: tile.y + DIRS[step.dir].dy };
    } else {
      ends.push(tile);
      legs.push([]);
    }
  }
  const moves = legs[leg];
  const end = ends[leg];
  if (!moves || !end) return null;
  const index = moves.findIndex(m => m.tile.x === at.x && m.tile.y === at.y);
  if (index >= 0) return moves.slice(index).map(m => m.dir);
  return end.x === at.x && end.y === at.y ? [] : null;
}

/**
 * Whether the problem's edges lead from the start to every place the goal
 * needs, in order: the parcel and then the delivery tile for a trip. When
 * they do not, the solver can only answer "no plan", so it is not asked.
 * @param {ProblemSpec} spec
 */
export function routeExists(spec) {
  /** @param {Position} from @param {Position} to */
  const connected = (from, to) => {
    const seen = new Set([key(from.x, from.y)]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i];
      if (at.x === to.x && at.y === to.y) return true;
      for (const [dir, { dx, dy }] of Object.entries(DIRS)) {
        const next = { x: at.x + dx, y: at.y + dy };
        if (!spec.edges.has(`${key(at.x, at.y)},${dir}`) || seen.has(key(next.x, next.y))) continue;
        seen.add(key(next.x, next.y));
        queue.push(next);
      }
    }
    return false;
  };
  const goal = spec.goal;
  const stops = goal.kind === 'trip' ? [goal.parcelAt, goal.deliverAt] : goal.kind === 'deliver' ? [goal.deliverAt] : [goal.parcelAt];
  let from = spec.from;
  for (const stop of stops) {
    if (!connected(from, stop)) return false;
    from = stop;
  }
  return true;
}
