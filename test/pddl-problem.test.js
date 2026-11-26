// @ts-nocheck -- plans are written by hand in the shapes the solver client returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { DOMAIN } from '../src/planning/pddl/domain.js';
import { buildProblem, decodePlan, planStillWorks, routeFrom, routeExists } from '../src/planning/pddl/problem.js';

const trip = { kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } };
/** The trip of page 12 on one row: walk left to the parcel, then on to the delivery tile. */
const tripSpec = (map = mapFromRows(['2333']), carried = 0) =>
  buildProblem({ map, from: { x: 3, y: 0 }, paths: { now: 0 }, carried, goal: trip });
const step = (action, ...args) => ({ action, args });
const tripPlan = [
  step('move-left', 't3_0', 't2_0'), step('move-left', 't2_0', 't1_0'), step('pickup', 'target', 't1_0'),
  step('move-left', 't1_0', 't0_0'), step('putdown', 'target', 't0_0'),
];
/** The objects of a problem, as a list of names. */
const objectsOf = spec => spec.problem.match(/\(:objects ([^)]*)\)/)[1].trim().split(/\s+/);

test('the domain has move, pickup and putdown actions', () => {
  for (const action of ['move-up', 'move-down', 'move-left', 'move-right', 'pickup', 'putdown']) {
    assert.match(DOMAIN, new RegExp(`\\(:action ${action}\\b`));
  }
});

test('a trip problem has the start, the parcel, the delivery tile and directed edges', () => {
  const spec = tripSpec();
  assert.equal(spec.domain, DOMAIN);
  assert.match(spec.problem, /\(at t3_0\)/);
  assert.match(spec.problem, /\(parcel-at target t1_0\)/);
  assert.match(spec.problem, /\(delivery t0_0\)/);
  assert.match(spec.problem, /\(left t1_0 t0_0\)/);
  assert.match(spec.problem, /\(:goal \(and \(delivered target\) \(at t0_0\)\)\)/);
  assert.ok(spec.edges.has('1,0,left'));
  assert.ok(spec.deliveries.has('0,0'));
});

test('carried parcels get generic names and must be delivered', () => {
  const spec = buildProblem({ map: mapFromRows(['2333']), from: { x: 3, y: 0 }, paths: { now: 0 }, carried: 2,
    goal: { kind: 'deliver', deliverAt: { x: 0, y: 0 } } });
  assert.ok(objectsOf(spec).includes('carried1') && objectsOf(spec).includes('carried2'));
  assert.match(spec.problem, /\(carrying carried1\)/);
  assert.match(spec.problem, /\(carrying carried2\)/);
  assert.match(spec.problem, /\(:goal \(and \(delivered carried1\) \(delivered carried2\) \(at t0_0\)\)\)/);
});

test('a pickup goal only asks for the parcel to be carried', () => {
  const spec = buildProblem({ map: mapFromRows(['2333']), from: { x: 3, y: 0 }, paths: { now: 0 }, carried: 0,
    goal: { kind: 'pickup', parcelAt: { x: 1, y: 0 } } });
  assert.match(spec.problem, /\(:goal \(and \(carrying target\)\)\)/);
});

test('arrow tiles only allow the moves they point to', () => {
  // The middle tile points right: it can be entered from the left, not from the right.
  const spec = buildProblem({ map: mapFromRows(['3→3']), from: { x: 0, y: 0 }, paths: { now: 0 }, carried: 0,
    goal: { kind: 'deliver', deliverAt: { x: 2, y: 0 } } });
  assert.match(spec.problem, /\(right t0_0 t1_0\)/);
  assert.doesNotMatch(spec.problem, /\(left t2_0 t1_0\)/);
});

test('occupied, forbidden and crate tiles are left out', () => {
  const map = mapFromRows(['333332']);
  map.updateCrates([{ x: 3, y: 0 }], []);
  const spec = buildProblem({ map, from: { x: 0, y: 0 }, carried: 0, goal: { kind: 'deliver', deliverAt: { x: 5, y: 0 } },
    paths: { now: 0, occupied: new Set(['1,0']), forbidden: (x) => x === 2 } });
  const objects = objectsOf(spec);
  for (const gone of ['t1_0', 't2_0', 't3_0']) assert.ok(!objects.includes(gone), `${gone} should be left out`);
  assert.ok(objects.includes('t0_0') && objects.includes('t4_0'));
});

test('no problem is built when a goal tile cannot be entered', () => {
  const spec = buildProblem({ map: mapFromRows(['2333']), from: { x: 3, y: 0 }, carried: 0, goal: trip,
    paths: { now: 0, occupied: new Set(['0,0']) } });
  assert.equal(spec, null);
});

test('a refused move is left out of the edges', () => {
  const map = mapFromRows(['333'], { blockedTtlMs: 1000 });
  map.failMove(0, 0, 'right', 0);
  const spec = buildProblem({ map, from: { x: 0, y: 0 }, paths: { now: 0 }, carried: 0,
    goal: { kind: 'deliver', deliverAt: { x: 2, y: 0 } } });
  assert.doesNotMatch(spec.problem, /\(right t0_0 t1_0\)/);
  assert.match(spec.problem, /\(left t1_0 t0_0\)/);
});

test('a correct plan decodes to steps and the path it walks', () => {
  const plan = decodePlan(tripPlan, tripSpec());
  assert.deepEqual(plan.steps, [
    { action: 'move', dir: 'left' }, { action: 'move', dir: 'left' }, { action: 'pickup' },
    { action: 'move', dir: 'left' }, { action: 'putdown' },
  ]);
  assert.deepEqual(plan.path, [{ x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }]);
});

test('the decoder accepts the client format and plain text in any letter case', () => {
  const expected = decodePlan(tripPlan, tripSpec());
  const upper = tripPlan.map(s => ({ action: s.action.toUpperCase(), args: s.args.map(a => a.toUpperCase()) }));
  const text = tripPlan.map(s => `(${[s.action, ...s.args].join(' ').toUpperCase()})`);
  assert.deepEqual(decodePlan(upper, tripSpec()), expected);
  assert.deepEqual(decodePlan(text, tripSpec()), expected);
});

test('wrong plans are rejected', () => {
  const spec = tripSpec();
  assert.throws(() => decodePlan(undefined, spec), /no plan/);
  assert.throws(() => decodePlan([step('teleport', 't3_0', 't0_0')], spec), /Unknown PDDL action/);
  assert.throws(() => decodePlan([step('move-left', 't3_0', 't1_0')], spec), /not an edge/);
  assert.throws(() => decodePlan([step('move-left', 't2_0', 't1_0')], spec), /not where the agent is/);
  assert.throws(() => decodePlan([step('move-left', 't3_0', 't2_0'), step('pickup', 'target', 't2_0')], spec), /pickup/);
  assert.throws(() => decodePlan([step('move-left', 't3_0', 't2_0'), step('putdown', 'target', 't2_0')], spec), /putdown/);
  assert.throws(() => decodePlan(tripPlan.slice(0, 3), spec), /goal/);
});

test('putdowns before the pickup are dropped and putdowns together become one', () => {
  // A delivery tile at (2,0) lies on the way: the solver may put the carried parcel down there first.
  const spec = tripSpec(mapFromRows(['2323']), 1);
  const plan = decodePlan([
    step('move-left', 't3_0', 't2_0'), step('putdown', 'carried1', 't2_0'), step('move-left', 't2_0', 't1_0'),
    step('pickup', 'target', 't1_0'), step('move-left', 't1_0', 't0_0'), step('putdown', 'target', 't0_0'),
  ], spec);
  assert.deepEqual(plan.steps.map(s => s.action), ['move', 'move', 'pickup', 'move', 'putdown']);
  const together = decodePlan([...tripPlan, step('putdown', 'carried1', 't0_0')], tripSpec(mapFromRows(['2333']), 1));
  assert.deepEqual(together.steps.map(s => s.action), ['move', 'move', 'pickup', 'move', 'putdown']);
});

test('a putdown on the way is moved to the end, on the goal tile', () => {
  // The parcel lies where the agent starts; the solver delivers it on (2,0) and then walks on to (0,0).
  const spec = buildProblem({ map: mapFromRows(['2323']), from: { x: 3, y: 0 }, paths: { now: 0 }, carried: 0,
    goal: { kind: 'trip', parcelAt: { x: 3, y: 0 }, deliverAt: { x: 0, y: 0 } } });
  const plan = decodePlan([
    step('pickup', 'target', 't3_0'), step('move-left', 't3_0', 't2_0'), step('putdown', 'target', 't2_0'),
    step('move-left', 't2_0', 't1_0'), step('move-left', 't1_0', 't0_0'),
  ], spec);
  assert.deepEqual(plan.steps.map(s => s.action), ['pickup', 'move', 'move', 'move', 'putdown']);
});

test('planStillWorks fails once an agent stands on the path or a move was refused', () => {
  const map = mapFromRows(['2333'], { blockedTtlMs: 1000 });
  const plan = decodePlan(tripPlan, tripSpec(map));
  assert.equal(planStillWorks(plan, map, { now: 0 }), true);
  assert.equal(planStillWorks(plan, map, { now: 0, occupied: new Set(['2,0']) }), false);
  map.failMove(3, 0, 'left', 0);
  assert.equal(planStillWorks(plan, map, { now: 0 }), false);
});

test('routeFrom gives the moves of a leg from a tile on its path, and null off the path', () => {
  const plan = decodePlan(tripPlan, tripSpec());
  assert.deepEqual(routeFrom(plan, { x: 3, y: 0 }, 0), ['left', 'left']);
  assert.deepEqual(routeFrom(plan, { x: 2, y: 0 }, 0), ['left']);
  assert.deepEqual(routeFrom(plan, { x: 1, y: 0 }, 0), []);
  assert.deepEqual(routeFrom(plan, { x: 1, y: 0 }, 1), ['left']);
  assert.equal(routeFrom(plan, { x: 3, y: 0 }, 1), null);
  assert.equal(routeFrom(plan, { x: 5, y: 5 }, 0), null);
});

test('routeExists tells whether the problem connects the start to every place the goal needs', () => {
  assert.equal(routeExists(tripSpec()), true);
  // A wall between the agent and the parcel.
  const walled = buildProblem({ map: mapFromRows(['2303']), from: { x: 3, y: 0 }, paths: { now: 0 }, carried: 0, goal: trip });
  assert.equal(routeExists(walled), false);
});

test('blank lines and doubled spaces from the solver are ignored', () => {
  const expected = decodePlan(tripPlan, tripSpec());
  const padded = [step('', ), ...tripPlan.map(s => ({ action: s.action, args: ['', ...s.args, ''] })), ''];
  assert.deepEqual(decodePlan(padded, tripSpec()), expected);
  const text = ['', ...tripPlan.map(s => `(${s.action}  ${s.args.join('  ')})`), '   '];
  assert.deepEqual(decodePlan(text, tripSpec()), expected);
});
