// @ts-nocheck -- the solver is a fake that answers when the test says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { PlanLibrary } from '../src/plans/library.js';
import { PlannerService } from '../src/planning/pddl/service.js';
import { PlanArchive, archiveKey } from '../src/plans/archive.js';

const step = (action, ...args) => ({ action, args });
/** The trip of page 12 on stage1World's row '2133': from (3,0) to the parcel on (1,0), then to (0,0). */
const trip = { id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p', deliverX: 0, deliverY: 0 };
const tripPlan = [
  step('move-left', 't3_0', 't2_0'), step('move-left', 't2_0', 't1_0'), step('pickup', 'target', 't1_0'),
  step('move-left', 't1_0', 't0_0'), step('putdown', 'target', 't0_0'),
];
const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * A stage1World whose Plan Library has a planner and an archive. The fake
 * solver answers with `answer` when the test calls `release()`, or at once
 * when `answerAtOnce` is true.
 */
function plannedWorld({ rows, x, answer = tripPlan, answerAtOnce = false, archive = new PlanArchive() } = {}) {
  const logged = [];
  const log = (event, details) => logged.push({ event, ...details });
  const w = stage1World({ rows, x, log });
  const waiting = [];
  let calls = 0;
  const solve = () => {
    calls++;
    if (answerAtOnce) return Promise.resolve(answer);
    return new Promise(resolve => waiting.push(() => resolve(answer)));
  };
  const planner = new PlannerService({ solve, log });
  const plans = new PlanLibrary({ beliefs: w.beliefs, client: w.client, gate: w.gate, movement: w.movement, log, planner, archive });
  return {
    ...w, plans, archive, logged,
    calls: () => calls,
    release: () => { while (waiting.length) waiting.shift()(); },
    names: () => logged.map(e => e.event),
    find: event => logged.filter(e => e.event === event),
    actions: () => w.events.map(e => e.action === 'move' ? e.dir : e.action),
  };
}

test('a trip picks up, walks to its delivery tile and puts down in one intention', async () => {
  const w = stage1World();
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(w.events.map(e => e.action === 'move' ? e.dir : e.action), ['left', 'left', 'pickup', 'left', 'putdown']);
  assert.equal(w.beliefs.parcels.carriedBy('me', w.beliefs.now()).length, 0);
});

test('on a miss the agent walks with A* at once and archives the plan that arrives later', async () => {
  const w = plannedWorld();
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(w.calls(), 1);
  assert.deepEqual(w.actions(), ['left', 'left', 'pickup', 'left', 'putdown']);
  assert.equal(w.find('plan_archive_miss').length, 1);
  w.release();
  await tick(); await tick();
  assert.equal(w.archive.count, 1);
  assert.equal(w.find('pddl_plan_unused')[0]?.reason, 'intention ended');
});

test('the next same trip uses the archived plan without calling the solver', async () => {
  const first = plannedWorld();
  await first.plans.execute(trip, { stopped: false });
  first.release();
  await tick(); await tick();
  // A new game, the same places: the agent on (3,0), a parcel on (1,0).
  const again = plannedWorld({ archive: first.archive });
  const result = await again.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(again.calls(), 0);
  assert.equal(again.find('plan_archive_hit').length, 1);
  assert.equal(again.find('pddl_plan_used')[0]?.from, 'archive');
});

test('a plan that arrives during the walk takes over from the agent\'s tile', async () => {
  const w = plannedWorld({ answerAtOnce: true });
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(w.find('pddl_plan_used')[0]?.from, 'solver');
  assert.equal(w.find('pddl_plan_unused').length, 0);
});

test('an archived plan over a refused move is not used and is replaced', async () => {
  // Two rows: when the move left from (2,0) is refused, the way goes over the top row.
  const rows = ['3333', '2133'];
  const archive = new PlanArchive();
  const detour = [
    step('move-left', 't3_0', 't2_0'), step('move-up', 't2_0', 't2_1'), step('move-left', 't2_1', 't1_1'),
    step('move-down', 't1_1', 't1_0'), step('pickup', 'target', 't1_0'), step('move-left', 't1_0', 't0_0'),
    step('putdown', 'target', 't0_0'),
  ];
  const w = plannedWorld({ rows, x: 3, archive, answer: detour, answerAtOnce: true });
  const key = archiveKey({ kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } }, { x: 3, y: 0 }, 0);
  const straight = { steps: [{ action: 'move', dir: 'left' }, { action: 'move', dir: 'left' }, { action: 'pickup' },
    { action: 'move', dir: 'left' }, { action: 'putdown' }], path: [{ x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }] };
  archive.set(key, straight);
  w.beliefs.map.failMove(2, 0, 'left', w.beliefs.now());
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(w.find('plan_archive_hit').length, 0);
  assert.equal(w.find('plan_archive_miss').length, 1);
  assert.equal(w.calls(), 1);
  await tick();
  assert.equal(archive.get(key).path.length, 6);
});

test('a parcel taken while planning: nothing is sent, the plan is archived, unused says intention ended', async () => {
  const w = plannedWorld();
  const move = w.client.move;
  let moves = 0;
  w.client.move = async dir => {
    const result = await move(dir);
    // After the first move another agent takes the parcel.
    if (++moves === 1) w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: 'other' }]);
    return result;
  };
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'failed');
  assert.equal(w.events.some(e => e.action === 'pickup' || e.action === 'putdown'), false);
  w.release();
  await tick(); await tick();
  assert.equal(w.archive.count, 1);
  assert.equal(w.find('pddl_plan_unused')[0]?.reason, 'intention ended');
});

test('a trip that starts on the parcel tile picks up at once and still plans its delivery', async () => {
  // The pickup does not wait for the solver, but the trip's plan is still asked for and archived.
  const w = plannedWorld({ x: 1, answer: [step('pickup', 'target', 't1_0'), step('move-left', 't1_0', 't0_0'),
    step('putdown', 'target', 't0_0')] });
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(w.actions(), ['pickup', 'left', 'putdown']);
  assert.equal(w.calls(), 1);
  w.release();
  await tick(); await tick();
  assert.equal(w.archive.count, 1);
});

test('with the planner off, trips run on A* and nothing is logged about plans', async () => {
  const logged = [];
  const w = stage1World({ log: event => logged.push(event) });
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(logged.some(e => /^(plan_archive|pddl_)/.test(e)), false);
});

test('explore and goto never call the planner', async () => {
  const w = plannedWorld();
  const result = await w.plans.execute({ id: 'goto:0,0', type: 'goto', x: 0, y: 0, utility: 0, priority: 0 }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(w.calls(), 0);
  assert.equal(w.find('plan_archive_miss').length, 0);
});

test('a planner that throws never leaves an unhandled rejection', async () => {
  const logged = [];
  const log = (event, details) => logged.push({ event, ...details });
  const w = stage1World({ log });
  const planner = { plan: () => Promise.reject(new Error('logger broke')) };
  const plans = new PlanLibrary({ beliefs: w.beliefs, client: w.client, gate: w.gate, movement: w.movement, log,
    planner, archive: new PlanArchive() });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await plans.execute(trip, { stopped: false });
    assert.equal(result.status, 'completed');
    await tick(); await tick();
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.equal(unhandled.length, 0);
  assert.ok(logged.some(e => e.event === 'planner_fallback' && /logger broke/.test(e.reason)));
});

test('an archived plan that A* replaces at once is logged as replaced', async () => {
  // The archive holds a detour over the top row although the straight way is free.
  const archive = new PlanArchive();
  const w = plannedWorld({ rows: ['3333', '2133'], x: 3, archive });
  const key = archiveKey({ kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } }, { x: 3, y: 0 }, 0);
  archive.set(key, { steps: [{ action: 'move', dir: 'up' }, { action: 'move', dir: 'left' }, { action: 'move', dir: 'left' },
    { action: 'move', dir: 'down' }, { action: 'pickup' }, { action: 'move', dir: 'left' }, { action: 'putdown' }],
  path: [{ x: 3, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }] });
  const result = await w.plans.execute(trip, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(w.find('pddl_plan_used')[0]?.from, 'archive');
  assert.equal(w.find('pddl_plan_replaced')[0]?.reason, 'shorter');
});

test('an archived plan that does not work right now is kept until a new plan replaces it', async () => {
  // The straight plan is blocked by a refused move, and the solver then fails: the old plan must stay.
  const archive = new PlanArchive();
  const w = plannedWorld({ rows: ['3333', '2133'], x: 3, archive, answer: [step('teleport')], answerAtOnce: true });
  const key = archiveKey({ kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } }, { x: 3, y: 0 }, 0);
  const straight = { steps: [{ action: 'move', dir: 'left' }, { action: 'move', dir: 'left' }, { action: 'pickup' },
    { action: 'move', dir: 'left' }, { action: 'putdown' }], path: [{ x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }] };
  archive.set(key, straight);
  w.beliefs.map.failMove(2, 0, 'left', w.beliefs.now());
  await w.plans.execute(trip, { stopped: false });
  await tick();
  assert.equal(w.find('pddl_failure').length, 1);
  assert.equal(archive.get(key), straight);
});

test('after a delivery on the way the walk does not reuse the plan route from its old start', async () => {
  // The LLM agent's pickup: from (4,0), carrying 'c', to the parcel on (1,0), over the delivery tile on (2,0).
  const logged = [];
  const log = (event, details) => logged.push({ event, ...details });
  const w = stage1World({ rows: ['33233'], x: 4, log });
  w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }, { id: 'c', x: 4, y: 0, reward: 20, carriedBy: 'me' }]);
  const archive = new PlanArchive();
  archive.set(archiveKey({ kind: 'pickup', parcelAt: { x: 1, y: 0 } }, { x: 4, y: 0 }, 1), {
    steps: [{ action: 'move', dir: 'left' }, { action: 'move', dir: 'left' }, { action: 'move', dir: 'left' }, { action: 'pickup' }],
    path: [{ x: 4, y: 0 }, { x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }] });
  const planner = new PlannerService({ solve: () => new Promise(() => {}), log });
  const routes = [];
  const moveTo = w.movement.moveTo.bind(w.movement);
  w.movement.moveTo = (target, signal, given = {}) => { routes.push(given.route ?? null); return moveTo(target, signal, given); };
  const plans = new PlanLibrary({ beliefs: w.beliefs, client: w.client, gate: w.gate, movement: w.movement, log,
    planner, archive, deliverOnTheWay: true });
  const result = await plans.execute({ id: 'llm-pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p' }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.ok(logged.some(e => e.event === 'delivery' && e.onTheWay));
  assert.deepEqual(routes[0], ['left', 'left', 'left']);
  assert.ok(routes.slice(1).every(r => r === null), `later walks were given ${JSON.stringify(routes.slice(1))}`);
});

test('a trip that comes again while its plan is being made waits for the same request', async () => {
  // The trip is replaced before its first move, then chosen again from the same tile.
  const w = plannedWorld();
  const stopped = await w.plans.execute(trip, { stopped: true });
  assert.equal(stopped.status, 'cancelled');
  const again = await w.plans.execute(trip, { stopped: false });
  assert.equal(again.status, 'completed');
  assert.equal(w.calls(), 1);
  assert.equal(w.find('plan_archive_miss')[1]?.waiting, true);
  w.release();
  await tick(); await tick();
  assert.equal(w.archive.count, 1);
});
