// @ts-nocheck -- plans are written by hand as the solver would return them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { buildTaskProblem, decodeTaskPlan, evaluateTaskPlan, firstTask, optimalTaskMoves } from '../src/planning/pddl/task-problem.js';
import { solveTasks } from '../src/planning/pddl/solve.js';

// A delivery tile at x 0, the agent at x 1, parcels at x 2 and x 3.
const map = mapFromRows(['23333']);
const me = { x: 1, y: 0 };
const deliveries = [{ x: 0, y: 0 }];
const paths = { now: 0 };
const a = { id: 'a', x: 2, y: 0, reward: 10 };
const b = { id: 'b', x: 3, y: 0, reward: 8 };
const build = (over = {}) => buildTaskProblem({ map, me, carried: [], parcels: [a, b], deliveries, capacity: 5, paths, maxParcels: 5, ...over });

// Pick up both parcels on the way out, then deliver both.
const plan = [
  { action: 'GO-TO', args: ['l1_0', 'l2_0'] },
  { action: 'PICKUP', args: ['p_a', 'l2_0', 's1'] },
  { action: 'GO-TO', args: ['l2_0', 'l3_0'] },
  { action: 'PICKUP', args: ['p_b', 'l3_0', 's2'] },
  { action: 'GO-TO', args: ['l3_0', 'l0_0'] },
  { action: 'DELIVER', args: ['p_a', 'l0_0', 's1'] },
  { action: 'DELIVER', args: ['p_b', 'l0_0', 's2'] },
];

test('the task problem holds the agent, parcels, delivery tiles, links and the goal', () => {
  const spec = build();
  assert.match(spec.domain, /\(:requirements :strips\)/);
  assert.doesNotMatch(spec.domain, /:typing|:action-costs/);
  for (const action of ['go-to', 'pickup', 'deliver']) assert.match(spec.domain, new RegExp(`:action ${action}\\b`));
  assert.match(spec.problem, /\(at l1_0\)/);
  assert.match(spec.problem, /\(parcel-at p_a l2_0\)/);
  assert.match(spec.problem, /\(parcel-at p_b l3_0\)/);
  assert.match(spec.problem, /\(delivery l0_0\)/);
  assert.match(spec.problem, /\(link l1_0 l3_0\)/);
  assert.match(spec.problem, /\(:goal \(and \(delivered p_a\) \(delivered p_b\)\)\)/);
});

test('a single parcel is not planned, since it has only one order', () => {
  assert.equal(build({ parcels: [a] }), null);
  // A carried parcel and a free one are two.
  assert.ok(build({ parcels: [a], carried: [{ id: 'c', reward: 5 }] }));
});

test('only the nearest parcels go into the problem', () => {
  const spec = build({ maxParcels: 1, carried: [{ id: 'c', reward: 5 }] });
  assert.ok(spec.parcels.has('p_a'));
  assert.equal(spec.parcels.has('p_b'), false);
});

test('capacity comes from the player settings, as carrying slots', () => {
  const one = build({ capacity: 1 });
  assert.deepEqual(one.slots, ['s1']);
  assert.match(one.problem, /\(free s1\)/);
  // A carried parcel fills a slot.
  const full = build({ capacity: 2, parcels: [a], carried: [{ id: 'c', reward: 5 }] });
  assert.match(full.problem, /\(carrying p_c\) \(holds s1 p_c\)/);
  assert.match(full.problem, /\(free s2\)/);
  // Without a limit, there is a slot for every parcel.
  assert.equal(build({ capacity: -1 }).slots.length, 2);
});

test('a valid plan decodes into tasks', () => {
  const tasks = decodeTaskPlan(plan, build());
  assert.deepEqual(tasks.map(t => t.type), ['goto', 'pickup', 'goto', 'pickup', 'goto', 'deliver', 'deliver']);
  assert.deepEqual(firstTask(tasks), { type: 'pickup', parcelId: 'a', at: { x: 2, y: 0 } });
  assert.equal(tasks[4].moves, 3);
});

test('decoding rejects unknown actions, broken preconditions and unfinished plans', () => {
  const spec = build();
  assert.throws(() => decodeTaskPlan([{ action: 'teleport', args: [] }], spec), /Unexpected PDDL action/);
  assert.throws(() => decodeTaskPlan([{ action: 'go-to', args: ['l2_0', 'l3_0'] }], spec), /go-to/);
  assert.throws(() => decodeTaskPlan([{ action: 'pickup', args: ['p_a', 'l2_0', 's1'] }], spec), /pickup/);
  assert.throws(() => decodeTaskPlan(plan.slice(0, -1), spec), /every parcel/);
  assert.throws(() => decodeTaskPlan(undefined, spec), /no action sequence/);
});

test('decoding enforces capacity: a second pickup needs a free slot', () => {
  const spec = build({ capacity: 1 });
  const overfull = [plan[0], plan[1], plan[2], { action: 'pickup', args: ['p_b', 'l3_0', 's1'] }];
  assert.throws(() => decodeTaskPlan(overfull, spec), /pickup/);
  // Delivering in between frees the slot again.
  const twoTrips = [
    { action: 'go-to', args: ['l1_0', 'l2_0'] }, { action: 'pickup', args: ['p_a', 'l2_0', 's1'] },
    { action: 'go-to', args: ['l2_0', 'l0_0'] }, { action: 'deliver', args: ['p_a', 'l0_0', 's1'] },
    { action: 'go-to', args: ['l0_0', 'l3_0'] }, { action: 'pickup', args: ['p_b', 'l3_0', 's1'] },
    { action: 'go-to', args: ['l3_0', 'l0_0'] }, { action: 'deliver', args: ['p_b', 'l0_0', 's1'] },
  ];
  assert.equal(decodeTaskPlan(twoTrips, spec).length, 8);
});

test('a plan is scored by the agent utility, for the whole plan and its first trip', () => {
  const tasks = decodeTaskPlan(plan, build());
  // 1 + 1 + 3 = 5 moves of 200 ms, one decay tick a second: 1 tick lost each.
  const rewards = new Map([['a', 10], ['b', 8]]);
  const value = evaluateTaskPlan(tasks, { rewards, now: 0, moveMs: 200, decayMs: 1000, perMs: 0.001 });
  assert.equal(value.total, 9 + 7 - 1);
  assert.equal(value.firstTrip, value.total);
});

test('the solver is called once and its plan is returned as validated tasks', async () => {
  const events = [];
  let calls = 0;
  const tasks = await solveTasks(build(), {
    solve: async (domain, problem) => { calls++; assert.match(domain, /deliveroo-tasks/); assert.match(problem, /p_b/); return plan; },
    log: (event, details) => events.push({ event, ...details }),
  });
  assert.equal(calls, 1);
  assert.equal(tasks.length, 7);
  assert.deepEqual(events.map(e => e.event), ['pddl_task_call', 'pddl_task_success']);
  assert.equal(typeof events[1].durationMs, 'number');
});

test('a timeout, an error or an invalid plan is reported as pddl_task_failure', async () => {
  for (const solve of [async () => new Promise(() => {}), async () => { throw new Error('offline'); }, async () => plan.slice(0, 2)]) {
    const events = [];
    await assert.rejects(solveTasks(build(), { solve, timeoutMs: 10, log: (event, details) => events.push({ event, ...details }) }));
    assert.deepEqual(events.map(e => e.event), ['pddl_task_call', 'pddl_task_failure']);
    assert.ok(events[1].reason);
  }
});

test('the fewest moves to deliver every parcel are found by trying every order', () => {
  // Both parcels on the way out: 1 + 1 + 3 moves.
  assert.equal(optimalTaskMoves(build()), 5);
  // With room for one parcel: 1 to a, 2 back, 3 to b, 3 back.
  assert.equal(optimalTaskMoves(build({ capacity: 1 })), 9);
});

test('each place is linked only to its nearest places, while the problem stays solvable', () => {
  // A row of parcels: with two nearest links each, far jumps are left out.
  const row = mapFromRows(['2333333']);
  const parcels = [2, 3, 4, 5, 6].map(x => ({ id: `q${x}`, x, y: 0, reward: 10 }));
  const spec = buildTaskProblem({ map: row, me: { x: 1, y: 0 }, carried: [], parcels, deliveries: [{ x: 0, y: 0 }],
    capacity: 5, paths: { now: 0 }, maxParcels: 5, nearestLinks: 2 });
  assert.doesNotMatch(spec.problem, /\(link l1_0 l6_0\)/);
  assert.match(spec.problem, /\(link l1_0 l2_0\)/);
  // With one link each, a tile could only link back the way it came and the
  // far parcels could not be reached, so every pair is linked instead.
  const tight = buildTaskProblem({ map: row, me: { x: 1, y: 0 }, carried: [], parcels, deliveries: [{ x: 0, y: 0 }],
    capacity: 5, paths: { now: 0 }, maxParcels: 5, nearestLinks: 1 });
  assert.match(tight.problem, /\(link l2_0 l3_0\)/);
  // Every pair is linked when asked for.
  const full = buildTaskProblem({ map: row, me: { x: 1, y: 0 }, carried: [], parcels, deliveries: [{ x: 0, y: 0 }],
    capacity: 5, paths: { now: 0 }, maxParcels: 5, nearestLinks: 0 });
  assert.match(full.problem, /\(link l1_0 l6_0\)/);
});
