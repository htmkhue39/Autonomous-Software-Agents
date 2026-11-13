// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';

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

test('PDDL mode calls external planner; fallback is explicit', async () => {
  const events = [];
  let calls = 0;
  const w = stage1World({ mode: 'pddl', solve: async () => { calls++; throw Error('unavailable'); }, log: event => events.push(event) });
  const result = await w.movement.moveTo({ x: 1, y: 0 }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.ok(events.includes('pddl_failure'));
  assert.ok(events.includes('planner_fallback'));
});

test('PDDL-backed plan executes external solver moves without fallback', async () => {
  const events = [];
  let calls = 0;
  const w = stage1World({
    mode: 'pddl',
    solve: async () => { calls++; return [
      { action: 'move_left', args: ['t3_0', 't2_0'] },
      { action: 'move_left', args: ['t2_0', 't1_0'] },
    ]; },
    log: event => events.push(event),
  });
  const result = await w.movement.moveTo({ x: 1, y: 0 }, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.ok(events.includes('pddl_success'));
  assert.equal(events.includes('planner_fallback'), false);
  assert.equal(w.beliefs.me.x, 1);
});

test('ambiguous move result is not retried by movement runner', async () => {
  const w = stage1World();
  w.client.move = async () => { throw new Error('connection lost'); };
  const result = await w.movement.moveTo({ x: 1, y: 0 }, { stopped: false });
  assert.equal(result.status, 'unknown');
  assert.equal(w.beliefs.me.x, 3);
});
