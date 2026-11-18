// @ts-nocheck -- deterministic fake-client fixtures exercise public runtime contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { BdiAgent } from '../src/intentions/agent.js';
import { PlanLibrary } from '../src/plans/library.js';

const pickupP = { id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p', utility: 20, priority: 0 };
const parcelP = { id: 'p', x: 1, y: 0, reward: 20, carriedBy: null };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Run a controller with a plan stub paused until the test releases it.
async function pausedController({ w, now = () => Date.now(), minCommitMs = 6000, failedGoalCooldownMs = 10000 }) {
  const started = deferred();
  const release = deferred();
  const calls = [];
  let signal;
  const events = [];
  const realPlans = w.plans;
  const plans = {
    applicable: option => realPlans.applicable(option),
    async execute(option, s) {
      signal = s;
      calls.push(option);
      started.resolve();
      await release.promise;
      return { status: s.stopped ? 'cancelled' : 'completed' };
    },
  };
  const agent = new BdiAgent({ beliefs: w.beliefs, plans, gate: w.gate, idleMs: 2,
    now, minCommitMs, failedGoalCooldownMs,
    log: (event, data) => events.push({ event, ...data }),
  });
  const running = agent.start();
  await started.promise;
  return {
    agent, calls, events, get signal() { return signal; },
    async stop() { agent.stop(); release.resolve(); await running; },
  };
}

test('pickup ACK missing target is confirmed by subsequent carried-by-self sensing', async () => {
  const w = stage1World();
  w.plans.pickupReconcileMs = 80;
  const events = [];
  w.plans.log = (event, data) => events.push({ event, ...data });
  w.client.pickup = async () => {
    setTimeout(() => w.send([{ ...parcelP, carriedBy: 'me' }], [{ x: 1, y: 0 }]), 5);
    return [];
  };
  const result = await w.plans.execute(pickupP, { stopped: false });
  assert.equal(result.status, 'completed');
  assert.ok(events.some(e => e.event === 'pickup' && e.targetConfirmed && e.confirmation === 'sensing'));
});

test('missing pickup ACK without positive evidence remains a failure', async () => {
  const w = stage1World();
  w.plans.pickupReconcileMs = 12;
  w.client.pickup = async () => [];
  const result = await w.plans.execute(pickupP, { stopped: false });
  assert.equal(result.status, 'failed');
  assert.equal(w.beliefs.parcels.carriedBy('me', w.beliefs.now()).length, 0);
});

test('other parcels acknowledged by pickup are preserved even if target was missed', async () => {
  const w = stage1World();
  w.plans.pickupReconcileMs = 10;
  w.send([parcelP, { id: 'q', x: 1, y: 0, reward: 15, carriedBy: null }]);
  w.client.pickup = async () => [{ id: 'q' }];
  const result = await w.plans.execute(pickupP, { stopped: false });
  assert.equal(result.status, 'failed');
  assert.deepEqual(w.beliefs.parcels.carriedBy('me', w.beliefs.now()).map(p => p.id), ['q']);
});

test('delivery intention does not switch for a newly seen high-value pickup', async () => {
  const w = stage1World();
  w.beliefs.onPickup([{ id: 'p' }]);
  const ctx = await pausedController({ w, minCommitMs: 0 });
  try {
    assert.equal(ctx.calls[0].type, 'deliver');
    w.send([{ ...parcelP, carriedBy: 'me' }, { id: 'q', x: 2, y: 0, reward: 100, carriedBy: null }]);
    assert.equal(ctx.signal.stopped, false);
    assert.equal(ctx.events.some(e => e.event === 'intention_revision'), false);
  } finally { await ctx.stop(); }
});

test('exploration remains committed when another spawn tile becomes older', async () => {
  const w = stage1World({ rows: ['21113'], x: 4 });
  w.send([], [{ x: 1, y: 0 }]); // clear the starting parcel
  const ctx = await pausedController({ w, minCommitMs: 0 });
  try {
    assert.equal(ctx.calls[0].type, 'explore');
    w.send([], [{ x: ctx.calls[0].x, y: ctx.calls[0].y }]);
    assert.equal(ctx.signal.stopped, false);
  } finally { await ctx.stop(); }
});

test('new high-value pickup cannot cause a soft switch before commitment interval', async () => {
  const w = stage1World();
  let time = 0;
  const ctx = await pausedController({ w, now: () => time, minCommitMs: 6000 });
  try {
    assert.equal(ctx.calls[0].id, 'pickup:p');
    w.send([parcelP, { id: 'q', x: 2, y: 0, reward: 100, carriedBy: null }]);
    assert.equal(ctx.signal.stopped, false);
    time = 6100;
    w.send([parcelP, { id: 'q', x: 2, y: 0, reward: 100, carriedBy: null }]);
    assert.equal(ctx.signal.stopped, true);
    assert.ok(ctx.events.some(e => e.event === 'intention_revision' && e.reason === 'replaced'));
  } finally { await ctx.stop(); }
});

test('failed intention is put on cooldown so another goal is selected', async () => {
  const w = stage1World();
  const actions = [];
  let agent;
  const plans = {
    applicable: option => w.plans.applicable(option),
    async execute(option) {
      actions.push(option.id);
      if (actions.length >= 2) agent.stop();
      return { status: actions.length === 1 ? 'failed' : 'completed', reason: actions.length === 1 ? 'No reachable route' : undefined };
    },
  };
  const agentEvents = [];
  agent = new BdiAgent({ beliefs: w.beliefs, plans, gate: w.gate, idleMs: 2,
    failedGoalCooldownMs: 10000, log: (event, data) => agentEvents.push({ event, ...data }),
  });
  const timeout = setTimeout(() => agent.stop(), 400);
  try {
    await agent.start();
  } finally { clearTimeout(timeout); }
  assert.equal(actions[0], 'pickup:p');
  assert.equal(actions[1], 'explore:1,0');
  assert.ok(agentEvents.some(e => e.event === 'intention_cooldown' && e.id === 'pickup:p'));
});

test('hard invalidation cancels a disappeared pickup immediately', async () => {
  const w = stage1World();
  const ctx = await pausedController({ w, minCommitMs: 60000 });
  try {
    assert.equal(ctx.calls[0].id, 'pickup:p');
    w.send([], [{ x: 1, y: 0 }]);
    assert.equal(ctx.signal.stopped, true);
    assert.ok(ctx.events.some(e => e.event === 'intention_revision' && e.reason === 'invalidated'));
  } finally { await ctx.stop(); }
});

// Negative PDDL/cancel tests already live in test/plans.test.js; keep them as baseline.

test('navigation failure includes attempted edge and target for diagnostics', async () => {
  const events = [];
  const w = stage1World({ rows: ['2333'], x: 3, log: (event, data) => events.push({ event, ...data }) });
  w.setRejectMove(() => true);
  const result = await w.movement.moveTo({ x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'failed');
  const refused = events.find(e => e.event === 'move_refused');
  assert.deepEqual(refused.from, { x: 3, y: 0 });
  assert.deepEqual(refused.to, { x: 2, y: 0 });
  assert.equal(refused.toTileType, '3');
  assert.ok(events.some(e => e.event === 'navigation_failed'));
});

test('cancelled navigation records completed work for PDDL efficiency analysis', async () => {
  const events = [];
  const w = stage1World({ log: (event, data) => events.push({ event, ...data }) });
  const signal = { stopped: false };
  const original = w.client.move;
  w.client.move = async dir => { const result = await original(dir); signal.stopped = true; return result; };
  const result = await w.movement.moveTo({ x: 0, y: 0 }, signal);
  assert.equal(result.status, 'cancelled');
  assert.ok(events.some(e => e.event === 'navigation_cancelled' && e.movesCompleted === 1));
});

test('exploration yields immediately to a worthwhile pickup even during commitment period', async () => {
  const w = stage1World();
  w.send([], [{ x: 1, y: 0 }]);
  const ctx = await pausedController({ w, minCommitMs: 60000 });
  try {
    assert.equal(ctx.calls[0].type, 'explore');
    w.send([{ id: 'fresh', x: 2, y: 0, reward: 80, carriedBy: null }]);
    assert.equal(ctx.signal.stopped, true);
    assert.ok(ctx.events.some(e => e.event === 'intention_revision' && e.reason === 'replaced'));
  } finally { await ctx.stop(); }
});

test('a final SDK action is not interrupted by a sensing update', async () => {
  const w = stage1World();
  const ctx = await pausedController({ w, minCommitMs: 0 });
  try {
    assert.equal(ctx.calls[0].type, 'pickup');
    ctx.signal.finishing = true;
    w.send([], [{ x: 1, y: 0 }]); // target gone while pickup action is completing
    assert.equal(ctx.signal.stopped, false);
  } finally { await ctx.stop(); }
});
