import { distancesThroughCrates } from '../astar.js';
import { decayTicks } from '../../deliberation/utility.js';

/**
 * Task-level planning in PDDL: which parcels to pick up, in what order, and
 * where to deliver them. Walking between two places is one `go-to` action;
 * the moves of each walk are left to A* (see moveTo.js).
 *
 * The domain is plain STRIPS, the only requirement the course's online
 * solver (@unitn-asa/pddl-client, dual-bfws-ffparser by default) is known
 * to accept. STRIPS has no action costs, so the solver finds a valid order,
 * not the shortest one. The distances that A* measured are used instead to
 * score a decoded plan with the agent's own utility (evaluateTaskPlan).
 *
 * Capacity is modelled with one object per carrying slot: a pickup needs a
 * free slot and fills it, a delivery empties it again.
 */

/**
 * @typedef {import('../../beliefs/map.js').GridMap} GridMap
 * @typedef {import('../../types.js').PathOptions} PathOptions
 * @typedef {import('../../types.js').Position} Position
 * @typedef {import('../../types.js').TileKey} TileKey
 *
 * @typedef {{ id: string, x: number, y: number, reward: number }} TaskParcel
 * @typedef {{ type: 'goto', to: Position, moves: number }
 *   | { type: 'pickup', parcelId: string, at: Position }
 *   | { type: 'deliver', parcelId: string, at: Position }} Task
 * @typedef {{ domain: string, problem: string, me: Position,
 *   locations: Map<string, Position>, parcels: Map<string, TaskParcel>, slots: string[],
 *   carried: Set<string>, deliveries: Set<string>, distances: Map<string, Map<string, number>> }} TaskSpec
 */

const DOMAIN = `(define (domain deliveroo-tasks)
 (:requirements :strips)
 (:predicates (at ?l) (link ?from ?to) (delivery ?l) (parcel-at ?p ?l) (carrying ?p) (holds ?s ?p) (free ?s) (delivered ?p))
 (:action go-to
  :parameters (?from ?to)
  :precondition (and (at ?from) (link ?from ?to))
  :effect (and (not (at ?from)) (at ?to)))
 (:action pickup
  :parameters (?p ?l ?s)
  :precondition (and (at ?l) (parcel-at ?p ?l) (free ?s))
  :effect (and (not (parcel-at ?p ?l)) (not (free ?s)) (carrying ?p) (holds ?s ?p)))
 (:action deliver
  :parameters (?p ?l ?s)
  :precondition (and (at ?l) (delivery ?l) (carrying ?p) (holds ?s ?p))
  :effect (and (not (carrying ?p)) (not (holds ?s ?p)) (free ?s) (delivered ?p)))
)`;

/** The PDDL name of the place (x, y). @param {Position} p */
const placeName = ({ x, y }) => `l${x}_${y}`;
/** The PDDL name of a parcel: its id, kept to the characters PDDL names allow. @param {string} id */
const parcelName = id => `p_${id.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

/**
 * Build the task problem, or null when there is nothing to plan: fewer than
 * two parcels in all (carried ones included), since one parcel has only one
 * order. Only the `maxParcels` nearest free parcels go in, to keep the
 * problem small, and only those from which a delivery tile can be reached.
 * The places are the agent's tile, the parcels' tiles, and for each of these
 * the nearest of `deliveries`. Two places are linked when A* can walk from
 * the one to the other and the link is short enough (see taskLinks).
 * @param {{ map: GridMap, me: Position, carried: { id: string, reward: number }[], parcels: TaskParcel[],
 *   deliveries: Position[], capacity: number, paths: PathOptions, maxParcels: number, nearestLinks?: number }} input
 *   `capacity` is the server's player capacity, -1 for no limit.
 *   `nearestLinks` is how many of its nearest places each place is linked
 *   to (see taskLinks); 0 or less links every pair.
 * @returns {TaskSpec | null}
 */
export function buildTaskProblem({ map, me, carried, parcels, deliveries, capacity, paths, maxParcels, nearestLinks = NEAREST_LINKS }) {
  if (deliveries.length === 0) return null;
  /** @type {Map<string, Map<string, number>>} distances by place name, from each place */
  const distances = new Map();
  /** @param {Position} p */
  const distancesOf = p => {
    const name = placeName(p);
    if (!distances.has(name)) {
      /** @type {Map<string, number>} */
      const byName = new Map();
      for (const [k, d] of distancesThroughCrates(map, p, paths)) {
        const [x, y] = k.split(',').map(Number);
        byName.set(placeName({ x, y }), d);
      }
      distances.set(name, byName);
    }
    return /** @type {Map<string, number>} */ (distances.get(name));
  };
  /** The nearest delivery tile reachable from `p`, or null. @param {Position} p */
  const nearestDelivery = p => {
    const from = distancesOf(p);
    let best = null;
    for (const d of deliveries) {
      const moves = from.get(placeName(d));
      if (moves !== undefined && (!best || moves < best.moves)) best = { tile: d, moves };
    }
    return best?.tile ?? null;
  };

  const fromMe = distancesOf(me);
  const chosen = parcels
    .filter(p => fromMe.has(placeName(p)) && nearestDelivery(p) !== null)
    .sort((a, b) => /** @type {number} */ (fromMe.get(placeName(a))) - /** @type {number} */ (fromMe.get(placeName(b))))
    .slice(0, Math.max(0, maxParcels));
  if (chosen.length + carried.length < 2) return null;

  /** @type {Map<string, Position>} */
  const locations = new Map();
  const addPlace = (/** @type {Position} */ p) => locations.set(placeName(p), { x: p.x, y: p.y });
  addPlace(me);
  for (const p of chosen) addPlace(p);
  /** @type {Set<string>} */
  const deliveryNames = new Set();
  for (const p of [me, ...chosen]) {
    const tile = nearestDelivery(p);
    if (!tile) continue;
    addPlace(tile);
    deliveryNames.add(placeName(tile));
  }
  if (deliveryNames.size === 0) return null;

  /** @type {Map<string, TaskParcel>} */
  const parcelObjects = new Map();
  for (const p of chosen) parcelObjects.set(parcelName(p.id), p);
  /** @type {Set<string>} */
  const carriedNames = new Set();
  for (const c of carried) {
    const name = parcelName(c.id);
    parcelObjects.set(name, { id: c.id, x: me.x, y: me.y, reward: c.reward });
    carriedNames.add(name);
  }

  // One slot per parcel the agent can carry at once: the carried parcels
  // fill some, the rest are free. Without a limit, there are enough for all.
  const slotCount = capacity === -1 ? parcelObjects.size : Math.max(capacity, carried.length);
  const slots = Array.from({ length: slotCount }, (_, i) => `s${i + 1}`);

  const facts = [`(at ${placeName(me)})`];
  for (const name of locations.keys()) distancesOf(/** @type {Position} */ (locations.get(name)));
  for (const [from, to] of taskLinks(locations, distances, deliveryNames, placeName(me), nearestLinks)) facts.push(`(link ${from} ${to})`);
  for (const name of deliveryNames) facts.push(`(delivery ${name})`);
  let slot = 0;
  for (const [name, p] of parcelObjects) {
    if (carriedNames.has(name)) facts.push(`(carrying ${name})`, `(holds ${slots[slot++]} ${name})`);
    else facts.push(`(parcel-at ${name} ${placeName(p)})`);
  }
  for (; slot < slots.length; slot++) facts.push(`(free ${slots[slot]})`);

  const objects = [...locations.keys(), ...parcelObjects.keys(), ...slots];
  const goal = [...parcelObjects.keys()].map(name => `(delivered ${name})`).join(' ');
  const problem = `(define (problem deliveroo-tasks-now) (:domain deliveroo-tasks)
 (:objects ${objects.join(' ')})
 (:init ${facts.join(' ')})
 (:goal (and ${goal}))
)`;
  return { domain: DOMAIN, problem, me: { x: me.x, y: me.y }, locations, parcels: parcelObjects, slots,
    carried: carriedNames, deliveries: deliveryNames, distances };
}

/**
 * How many of its nearest places each place is linked to by default.
 */
const NEAREST_LINKS = 3;

/**
 * The `go-to` links of the problem. The solver only looks for a valid plan,
 * not the shortest, and with every pair of places linked it often walks to
 * a far parcel and back again. So each place is linked only to its
 * `nearest` nearest places that are not delivery tiles, and to its nearest
 * delivery tile, and each delivery tile to its `nearest` nearest parcels.
 * A long walk then takes several `go-to` actions, which the solver avoids.
 * If the pruned links no longer let the agent reach every parcel and carry
 * each one on to a delivery tile, every pair the agent can walk is linked
 * instead, so that the problem stays solvable.
 * @param {Map<string, Position>} locations  places by name
 * @param {Map<string, Map<string, number>>} distances  moves from each place, by place name
 * @param {Set<string>} deliveries  the names of the delivery tiles
 * @param {string} start  the agent's place
 * @param {number} nearest
 * @returns {[string, string][]}
 */
function taskLinks(locations, distances, deliveries, start, nearest) {
  const names = [...locations.keys()];
  /** @type {[string, string][]} */
  const all = [];
  for (const from of names) for (const to of names) if (to !== from && distances.get(from)?.has(to)) all.push([from, to]);
  if (nearest <= 0) return all;
  const moves = (/** @type {string} */ from, /** @type {string} */ to) => /** @type {number} */ (distances.get(from)?.get(to));
  /** The `count` nearest of `targets` that `from` can reach. @param {string} from @param {string[]} targets @param {number} count */
  const nearestOf = (from, targets, count) => targets
    .filter(to => to !== from && distances.get(from)?.has(to))
    .sort((a, b) => moves(from, a) - moves(from, b))
    .slice(0, count);
  const others = names.filter(n => !deliveries.has(n));
  const parcelPlaces = others.filter(n => n !== start);
  /** @type {Set<string>} */
  const kept = new Set();
  for (const from of names) {
    const targets = deliveries.has(from) ? nearestOf(from, parcelPlaces, nearest)
      : [...nearestOf(from, others, nearest), ...nearestOf(from, [...deliveries], 1)];
    for (const to of targets) kept.add(`${from} ${to}`);
  }
  const links = all.filter(([from, to]) => kept.has(`${from} ${to}`));
  // Check that the pruned links still allow a plan: the agent reaches every
  // parcel, and from every parcel some delivery tile and every other parcel.
  /** @param {string} from */
  const reach = from => {
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      for (const [a, b] of links) if (a === queue[i] && !seen.has(b)) { seen.add(b); queue.push(b); }
    }
    return seen;
  };
  const fromStart = reach(start);
  const solvable = parcelPlaces.every(p => fromStart.has(p)) &&
    parcelPlaces.every(p => { const r = reach(p); return [...deliveries].some(d => r.has(d)) && parcelPlaces.every(q => r.has(q)); });
  return solvable ? links : all;
}

/**
 * The fewest moves that deliver every parcel of the problem, found by trying
 * every order: the measure of how far the solver's plan is from the best
 * one. Parcels are picked up where they lie, within capacity, and delivered
 * all at once on a delivery tile. Only for the small problems the agent
 * builds; returns null when no order delivers them all.
 * @param {TaskSpec} spec
 * @returns {number | null}
 */
export function optimalTaskMoves(spec) {
  const names = [...spec.parcels.keys()];
  const placeOf = names.map(n => spec.carried.has(n) ? null : placeName(/** @type {TaskParcel} */ (spec.parcels.get(n))));
  const all = (1 << names.length) - 1;
  const carriedMask = names.reduce((m, n, i) => spec.carried.has(n) ? m | (1 << i) : m, 0);
  const capacity = spec.slots.length;
  const bits = (/** @type {number} */ m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
  /** @type {Map<string, number>} best moves to each state: place | picked | delivered */
  const best = new Map();
  /** @type {{ at: string, picked: number, done: number, moves: number }[]} */
  const queue = [{ at: placeName(spec.me), picked: carriedMask, done: 0, moves: 0 }];
  let answer = Infinity;
  while (queue.length) {
    queue.sort((a, b) => a.moves - b.moves);
    const state = /** @type {typeof queue[number]} */ (queue.shift());
    const k = `${state.at}|${state.picked}|${state.done}`;
    if ((best.get(k) ?? Infinity) <= state.moves) continue;
    best.set(k, state.moves);
    if (state.done === all) { answer = state.moves; break; }
    const carrying = state.picked & ~state.done;
    // Walk to a delivery tile and deliver everything carried.
    if (carrying) {
      for (const d of spec.deliveries) {
        const m = d === state.at ? 0 : spec.distances.get(state.at)?.get(d);
        if (m !== undefined) queue.push({ at: d, picked: state.picked, done: state.done | carrying, moves: state.moves + m });
      }
    }
    // Walk to a parcel not yet picked up, if there is room, and take it.
    if (bits(carrying) < capacity) {
      names.forEach((_, i) => {
        const place = placeOf[i];
        if (!place || state.picked & (1 << i)) return;
        const m = place === state.at ? 0 : spec.distances.get(state.at)?.get(place);
        if (m !== undefined) queue.push({ at: place, picked: state.picked | (1 << i), done: state.done, moves: state.moves + m });
      });
    }
  }
  return Number.isFinite(answer) ? answer : null;
}

/**
 * Turn the solver's plan into tasks, checking every action against the
 * problem as it was built: each action must be one of the domain's, name
 * known objects, and have its preconditions hold in the state reached so
 * far, and the plan must deliver every parcel. Output that fails any check
 * is rejected rather than trusted.
 * @param {unknown} plan  the steps the solver returned
 * @param {TaskSpec} spec
 * @returns {Task[]}
 */
export function decodeTaskPlan(plan, spec) {
  if (!Array.isArray(plan)) throw new Error('Planner returned no action sequence');
  let at = placeName(spec.me);
  /** @type {Map<string, string>} where each free parcel lies */
  const lying = new Map();
  /** @type {Map<string, string>} which slot holds each carried parcel */
  const held = new Map();
  /** @type {Set<string>} */
  const free = new Set(spec.slots);
  [...spec.carried].forEach((name, i) => { held.set(name, spec.slots[i]); free.delete(spec.slots[i]); });
  for (const [name, p] of spec.parcels) if (!spec.carried.has(name)) lying.set(name, placeName(p));
  /** @type {Set<string>} */
  const delivered = new Set();
  /** @type {Task[]} */
  const tasks = [];

  for (const step of plan) {
    const text = typeof step === 'string' ? step : typeof step?.action === 'string' ? step.action : null;
    if (!text) throw new Error('Unknown PDDL action');
    const tokens = text.trim().replace(/[()]/g, '').split(/\s+/).filter(Boolean);
    const action = tokens[0].toLowerCase().replace(/_/g, '-');
    const args = (Array.isArray(step?.args) ? step.args : tokens.slice(1)).map((/** @type {unknown} */ a) => String(a).toLowerCase());
    if (action === 'go-to') {
      const [from, to] = args;
      const dest = spec.locations.get(to);
      const moves = spec.distances.get(from)?.get(to);
      if (args.length !== 2 || from !== at || !dest || moves === undefined) throw new Error('PDDL go-to is not a known link from where the agent is');
      at = to;
      tasks.push({ type: 'goto', to: dest, moves });
    } else if (action === 'pickup') {
      const [p, l, s] = args;
      const parcel = spec.parcels.get(p);
      if (args.length !== 3 || !parcel || l !== at || lying.get(p) !== l || !free.has(s)) throw new Error('PDDL pickup does not hold in the planned state');
      lying.delete(p);
      free.delete(s);
      held.set(p, s);
      tasks.push({ type: 'pickup', parcelId: parcel.id, at: /** @type {Position} */ (spec.locations.get(l)) });
    } else if (action === 'deliver') {
      const [p, l, s] = args;
      const parcel = spec.parcels.get(p);
      if (args.length !== 3 || !parcel || l !== at || !spec.deliveries.has(l) || held.get(p) !== s) throw new Error('PDDL deliver does not hold in the planned state');
      held.delete(p);
      free.add(s);
      delivered.add(p);
      tasks.push({ type: 'deliver', parcelId: parcel.id, at: /** @type {Position} */ (spec.locations.get(l)) });
    } else {
      throw new Error(`Unexpected PDDL action: ${action}`);
    }
  }
  if (delivered.size !== spec.parcels.size) throw new Error('PDDL plan does not deliver every parcel');
  return tasks;
}

/**
 * What a task plan is worth by the agent's own utility, U = R - lambda * T,
 * as listOptions scores options. The walk of each `go-to` takes its A*
 * distance in moves; each delivered parcel is worth its reward less the
 * decay ticks until it is delivered. `firstTrip` is the value of the plan up
 * to the first moment the agent carries nothing again, which is what one
 * option of listOptions covers, so the two can be compared.
 * @param {Task[]} tasks
 * @param {{ rewards: Map<string, number>, now: number, moveMs: number, decayMs: number, perMs: number }} timing
 *   `rewards` holds each parcel's current value by id; `perMs` is the value
 *   of time in points per millisecond.
 * @returns {{ total: number, firstTrip: number }}
 */
export function evaluateTaskPlan(tasks, { rewards, now, moveMs, decayMs, perMs }) {
  let elapsedMs = 0;
  let earned = 0;
  let firstTrip = null;
  /** @type {Set<string>} */
  const carrying = new Set();
  for (const task of tasks) {
    if (task.type === 'goto') elapsedMs += task.moves * moveMs;
    else if (task.type === 'pickup') carrying.add(task.parcelId);
    else {
      const lost = decayTicks(now, now + elapsedMs, decayMs);
      earned += Math.max(0, (rewards.get(task.parcelId) ?? 0) - lost);
      carrying.delete(task.parcelId);
      if (firstTrip === null && carrying.size === 0) firstTrip = earned - perMs * elapsedMs;
    }
  }
  const total = earned - perMs * elapsedMs;
  return { total, firstTrip: firstTrip ?? total };
}

/**
 * The first thing the plan has the agent do at a place: pick up a parcel or
 * deliver. Walking there is left to the movement plan.
 * @param {Task[]} tasks
 * @returns {Task | null}
 */
export function firstTask(tasks) {
  return tasks.find(t => t.type !== 'goto') ?? null;
}

export { DOMAIN as TASK_DOMAIN, placeName as taskPlaceName, parcelName as taskParcelName };
