// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { PlanLibrary } from '../src/plans/library.js';
import { findPath } from '../src/planning/astar.js';

test('predefined pickup and delivery plans execute and revise beliefs', async () => {
  const { beliefs, plans, events } = stage1World();
  const picked = await plans.execute({ id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p' }, { stopped: false });
  assert.equal(picked.status, 'completed');
  assert.equal(beliefs.parcels.carriedBy('me', beliefs.now()).length, 1);
  const delivered = await plans.execute({ id: 'deliver', type: 'deliver', x: 0, y: 0 }, { stopped: false });
  assert.equal(delivered.status, 'completed');
  assert.equal(beliefs.parcels.carriedBy('me', beliefs.now()).length, 0);
  assert.deepEqual(events.filter(e => e.action !== 'move').map(e => e.action), ['pickup', 'putdown']);
});

test('plan is rejected when parcel is gone', async () => {
  const { plans, send } = stage1World();
  send([], [{ x: 1, y: 0 }]);
  const result = await plans.execute({ id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p' }, { stopped: false });
  assert.equal(result.status, 'failed');
});

test('movement checks stop signal between steps', async () => {
  const w = stage1World();
  const signal = { stopped: false };
  const original = w.client.move;
  w.client.move = async dir => { const result = await original(dir); signal.stopped = true; return result; };
  const result = await w.movement.moveTo({ x: 0, y: 0 }, signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(w.events.filter(e => e.action === 'move').length, 1);
});

test('refused move marks a failed edge and avoids unsafe rapid retry', async () => {
  const w = stage1World({ rows: ['2333'], x: 3 });
  w.setRejectMove(() => true);
  const result = await w.movement.moveTo({ x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'failed');
  assert.equal(w.beliefs.map.neighbors(3, 0, w.beliefs.now()).some(n => n.dir === 'left'), false);
});

test('ambiguous move result is not retried by movement runner', async () => {
  const w = stage1World();
  w.client.move = async () => { throw new Error('connection lost'); };
  const result = await w.movement.moveTo({ x: 1, y: 0 }, { stopped: false });
  assert.equal(result.status, 'unknown');
  assert.equal(w.beliefs.me.x, 3);
});

test('with deliverOnTheWay a pickup plan delivers on a delivery tile it crosses', async () => {
  // Agent at x 4 carries 'c'; parcel 'p' lies at x 1, past the delivery tile at x 2.
  const w = stage1World({ rows: ['33233'], x: 4 });
  w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }, { id: 'c', x: 4, y: 0, reward: 20, carriedBy: 'me' }]);
  const logged = [];
  const plans = new PlanLibrary({ beliefs: w.beliefs, client: w.client, gate: w.gate, movement: w.movement,
    log: (type, details) => logged.push({ type, ...details }), deliverOnTheWay: true });
  const result = await plans.execute({ id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p' }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(w.events.map(e => e.action), ['move', 'move', 'putdown', 'move', 'pickup']);
  assert.deepEqual(logged.find(e => e.type === 'delivery'), { type: 'delivery', parcelIds: ['c'], beforeScore: 0, x: 2, y: 0, onTheWay: true });
  assert.deepEqual(w.beliefs.parcels.carriedBy('me', w.beliefs.now()).map(p => p.id), ['p']);
});

test('with deliverOnTheWay a delivery plan ends at the first delivery tile it reaches', async () => {
  const w = stage1World({ rows: ['2323'], x: 3 });
  w.send([{ id: 'c', x: 3, y: 0, reward: 20, carriedBy: 'me' }], [{ x: 1, y: 0 }]);
  const plans = new PlanLibrary({ beliefs: w.beliefs, client: w.client, gate: w.gate, movement: w.movement, deliverOnTheWay: true });
  const result = await plans.execute({ id: 'deliver:0,0', type: 'deliver', x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(w.events.map(e => e.action), ['move', 'putdown']);
  assert.equal(w.beliefs.me.x, 2);
});

test('with deliverOnTheWay an empty putdown on the way does not stop the plan', async () => {
  const w = stage1World({ rows: ['33233'], x: 4 });
  w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }, { id: 'c', x: 4, y: 0, reward: 20, carriedBy: 'me' }]);
  w.client.putdown = async () => { w.events.push({ action: 'putdown' }); return []; };
  const plans = new PlanLibrary({ beliefs: w.beliefs, client: w.client, gate: w.gate, movement: w.movement, deliverOnTheWay: true });
  const result = await plans.execute({ id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p' }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(w.events.map(e => e.action), ['move', 'move', 'putdown', 'move', 'pickup']);
});

test('without deliverOnTheWay a pickup plan walks over delivery tiles', async () => {
  const w = stage1World({ rows: ['33233'], x: 4 });
  w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }, { id: 'c', x: 4, y: 0, reward: 20, carriedBy: 'me' }]);
  const result = await w.plans.execute({ id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p' }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(w.events.map(e => e.action), ['move', 'move', 'move', 'pickup']);
});

/** Report another agent standing on (x, y), or none when `at` is null. */
function otherAgent(w, at) {
  const agents = at ? [{ id: 'o', name: 'other', x: at.x, y: at.y, score: 0 }] : [];
  // With no agent reported and its tile in view, the agent is forgotten.
  w.beliefs.onSensing({ positions: [{ x: 2, y: 0 }, { x: 1, y: 0 }], agents, parcels: [], crates: [] });
}

test('the route is replanned as soon as an agent blocks it further ahead', async () => {
  // Agent at (4, 0) walks left to (0, 0). After its first move another agent
  // appears at (1, 0), two tiles ahead: the agent must turn off at once
  // rather than walk up to it.
  const logged = [];
  const w = stage1World({ rows: ['33333', '33333'], x: 4, log: (type, details) => logged.push({ type, ...details }) });
  w.send([], [{ x: 1, y: 0 }]);
  const move = w.client.move;
  let moves = 0;
  w.client.move = async dir => { const result = await move(dir); if (++moves === 1) otherAgent(w, { x: 1, y: 0 }); return result; };
  const result = await w.movement.moveTo({ x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'completed');
  const replan = logged.find(e => e.type === 'replan');
  assert.deepEqual([replan?.reason, replan?.planner, replan?.from], ['blocked', 'astar', { x: 3, y: 0 }]);
  assert.equal(logged.some(e => e.type === 'move' && e.x === 1 && e.y === 0), false);
});

test('the route is shortened as soon as a blocking agent moves away', async () => {
  // y 2:  3 3 3 3 3
  // y 1:  3 0 0 0 3
  // y 0:  3 3 3 3 3   agent at (4, 0), goal (0, 0), another agent at (2, 0)
  // The first route goes over the top, 8 moves. After the first move the
  // other agent is gone, and going back along the bottom row is shorter.
  const logged = [];
  const w = stage1World({ rows: ['33333', '30003', '33333'], x: 4, log: (type, details) => logged.push({ type, ...details }) });
  w.send([], [{ x: 1, y: 0 }]);
  otherAgent(w, { x: 2, y: 0 });
  const move = w.client.move;
  let moves = 0;
  w.client.move = async dir => { const result = await move(dir); if (++moves === 1) otherAgent(w, null); return result; };
  const result = await w.movement.moveTo({ x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(logged.find(e => e.type === 'replan')?.reason, 'shorter');
  assert.equal(moves, 6);
});

/** The moves the agent sent, in order. */
const sentMoves = w => w.events.filter(e => e.action === 'move').map(e => e.dir);

/**
 * A shortest route on an open grid from `from` to `to` that differs from the
 * one A* would take, so that a test can tell which of the two was followed.
 */
function otherShortestRoute(w, from, to) {
  const astar = findPath(w.beliefs.map, from, to, { now: 0 }).join();
  const horizontal = Array(Math.abs(to.x - from.x)).fill(to.x < from.x ? 'left' : 'right');
  const vertical = Array(Math.abs(to.y - from.y)).fill(to.y > from.y ? 'up' : 'down');
  // Every place the vertical moves can go among the horizontal ones.
  for (let i = 0; i <= horizontal.length; i++) {
    const route = [...horizontal.slice(0, i), ...vertical, ...horizontal.slice(i)];
    if (route.join() !== astar) return route;
  }
  throw new Error('No other shortest route');
}

test('moveTo follows a route it is given instead of computing one', async () => {
  const w = stage1World({ rows: ['3333', '2333'], x: 2 });
  const given = otherShortestRoute(w, { x: 2, y: 0 }, { x: 0, y: 1 });
  const result = await w.movement.moveTo({ x: 0, y: 1 }, { stopped: false }, { route: given });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sentMoves(w), given);
});

test('moveTo switches to the route takeRoute returns', async () => {
  // Three rows, so that after any first move there is still more than one shortest route.
  const w = stage1World({ rows: ['3333', '3333', '2333'], x: 3 });
  let asked = 0;
  /** @type {string[] | null} */
  let handed = null;
  // Nothing for the first move; then, once, another shortest route from where the agent stands.
  const takeRoute = () => {
    if (++asked !== 2) return null;
    handed = otherShortestRoute(w, w.beliefs.me, { x: 0, y: 2 });
    return handed;
  };
  const result = await w.movement.moveTo({ x: 0, y: 2 }, { stopped: false }, { takeRoute });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sentMoves(w).slice(1), handed);
});

test('a given route that becomes blocked is replaced by A*', async () => {
  const w = stage1World({ rows: ['3333', '2333'], x: 2 });
  w.beliefs.onSensing({ positions: [], agents: [{ id: 'o', name: 'other', x: 2, y: 1, score: 0 }], parcels: [], crates: [] });
  const result = await w.movement.moveTo({ x: 0, y: 1 }, { stopped: false }, { route: ['up', 'left', 'left'] });
  assert.equal(result.status, 'completed');
  assert.notEqual(sentMoves(w)[0], 'up');
  assert.equal(w.beliefs.me.x, 0);
  assert.equal(w.beliefs.me.y, 1);
});

test('moveTo says when it replaces a route it was given', async () => {
  // A route of 5 moves where 3 are enough: A* replaces it at once as shorter.
  const w = stage1World({ rows: ['3333', '2333'], x: 2 });
  const replaced = [];
  const result = await w.movement.moveTo({ x: 0, y: 1 }, { stopped: false },
    { route: ['left', 'up', 'right', 'left', 'left'], onReplaced: reason => replaced.push(reason) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(replaced, ['shorter']);
});
