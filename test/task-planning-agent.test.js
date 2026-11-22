// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BdiAgent } from '../src/intentions/agent.js';
import { stage1World } from './stage1-helpers.js';

/**
 * The agent at (3, 0) next to two parcels: 'p' at (1, 0), as stage1World
 * places it, and 'q' at (2, 0). Delivery is at (0, 0) and the agent carries
 * two at most. Runs the BDI loop until the first delivery.
 * @param {object | null} taskPlanning
 * @param {{ parcels?: object[] }} [setup]
 */
async function run(taskPlanning, { parcels } = {}) {
  const w = stage1World({ rows: ['21333'], x: 3 });
  w.send(parcels ?? [
    { id: 'p', x: 1, y: 0, reward: 20, carriedBy: null },
    { id: 'q', x: 2, y: 0, reward: 20, carriedBy: null },
  ]);
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'delivery') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log,
    optionPolicy: { strategy: 'net_gain', timeValuePerS: 0 }, taskPlanning });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]); }
  finally { agent.stop(); }
  return events;
}

// Both parcels on the way to delivery, as a solver would return it.
const plan = [
  { action: 'go-to', args: ['l3_0', 'l2_0'] }, { action: 'pickup', args: ['p_q', 'l2_0', 's1'] },
  { action: 'go-to', args: ['l2_0', 'l1_0'] }, { action: 'pickup', args: ['p_p', 'l1_0', 's2'] },
  { action: 'go-to', args: ['l1_0', 'l0_0'] },
  { action: 'deliver', args: ['p_q', 'l0_0', 's1'] }, { action: 'deliver', args: ['p_p', 'l0_0', 's2'] },
];

test('with the task planner on, the agent follows the order the planner chose', async () => {
  let calls = 0;
  const events = await run({ maxParcels: 5, timeoutMs: 200, solve: async () => { calls++; return plan; } });
  assert.ok(calls >= 1);
  assert.deepEqual(events.filter(e => e.event.startsWith('pddl_task')).slice(0, 3).map(e => e.event),
    ['pddl_task_call', 'pddl_task_success', 'pddl_task_choice']);
  assert.equal(events.find(e => e.event === 'pddl_task_choice').adopted, true);
  const first = events.find(e => e.event === 'intention_activated');
  assert.equal(first.id, 'pickup:q');
  assert.equal(first.source, 'pddl_task');
  // After the first pickup the stored plan is followed without asking again.
  assert.equal(calls, 1);
  assert.equal(events.find(e => e.event === 'delivery').parcelIds.length, 2);
});

test('when the planner fails, the agent logs why and falls back to its own choice', async () => {
  for (const solve of [async () => { throw new Error('offline'); }, async () => new Promise(() => {}), async () => plan.slice(0, 3)]) {
    const events = await run({ maxParcels: 5, timeoutMs: 20, solve });
    const failure = events.find(e => e.event === 'pddl_task_failure');
    assert.ok(failure?.reason, 'failure reason logged');
    assert.equal(typeof failure.durationMs, 'number');
    assert.ok(events.some(e => e.event === 'delivery'), 'still delivers');
    assert.equal(events.find(e => e.event === 'intention_activated').source, undefined);
  }
});

test('with a single parcel the planner is not called', async () => {
  let calls = 0;
  const events = await run({ maxParcels: 5, timeoutMs: 200, solve: async () => { calls++; return plan; } },
    { parcels: [{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }] });
  assert.equal(calls, 0);
  assert.equal(events.some(e => e.event.startsWith('pddl_task')), false);
  assert.ok(events.some(e => e.event === 'delivery'));
});

test('a plan worth less than the agent own choice is not followed', async () => {
  // Deliver 'q' first, then come back for 'p': much longer than taking both on the way.
  const detour = [
    { action: 'go-to', args: ['l3_0', 'l2_0'] }, { action: 'pickup', args: ['p_q', 'l2_0', 's1'] },
    { action: 'go-to', args: ['l2_0', 'l0_0'] }, { action: 'deliver', args: ['p_q', 'l0_0', 's1'] },
    { action: 'go-to', args: ['l0_0', 'l1_0'] }, { action: 'pickup', args: ['p_p', 'l1_0', 's1'] },
    { action: 'go-to', args: ['l1_0', 'l0_0'] }, { action: 'deliver', args: ['p_p', 'l0_0', 's1'] },
  ];
  const events = await run({ maxParcels: 5, timeoutMs: 200, solve: async () => detour });
  const choice = events.find(e => e.event === 'pddl_task_choice');
  assert.equal(choice.adopted, false);
  assert.ok(choice.planFirstTrip < choice.netGainUtility);
  // The same parcels are not planned for again.
  assert.equal(events.filter(e => e.event === 'pddl_task_call').length, 1);
});

test('without the task planner nothing changes and nothing is logged for it', async () => {
  const events = await run(null);
  assert.equal(events.some(e => e.event.startsWith('pddl_task')), false);
  assert.ok(events.some(e => e.event === 'delivery'));
});
