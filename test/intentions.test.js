// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconsider } from '../src/intentions/revision.js';
import { BdiAgent } from '../src/intentions/agent.js';
import { stage1World } from './stage1-helpers.js';

const pick = (id, utility, priority = 0) => ({ id, type: 'pickup', x: 1, y: 0, parcelId: id, utility, priority });

test('intention revision respects threshold, invalidation, and exploration yield', () => {
  const old = pick('a', 10), small = pick('b', 11), big = pick('b', 13);
  assert.equal(reconsider(old, [small, old], 1.2).next.id, 'a');
  assert.equal(reconsider(old, [big, old], 1.2).next.id, 'b');
  assert.equal(reconsider(old, [small], 1.2).reason, 'invalidated');
  const explore = { id: 'explore:1,0', type: 'explore', x: 1, y: 0, utility: 0, priority: 0 };
  assert.equal(reconsider(explore, [pick('p', 1), explore], 1.2).next.id, 'p');
});

test('BDI control loop activates goals autonomously and completes pickup/delivery', async () => {
  const w = stage1World();
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'delivery') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log });
  const end = Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]);
  await end;
  assert.ok(events.some(e => e.event === 'intention_activated' && e.id === 'pickup:p'));
  assert.ok(events.some(e => e.event === 'intention_activated' && e.id === 'deliver'));
  assert.equal(w.beliefs.parcels.carriedBy('me', w.beliefs.now()).length, 0);
});
