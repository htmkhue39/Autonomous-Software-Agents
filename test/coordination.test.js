// @ts-nocheck -- in-memory SDK bus intentionally implements only the required chat surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessage, PREFIX } from '../src/coordination/protocol.js';
import { CoordinationController } from '../src/coordination/controller.js';
import { Beliefs } from '../src/beliefs/index.js';
import { tilesFromRows } from './helpers.js';
import { listOptions } from '../src/deliberation/options.js';
import { createGameTools } from '../src/llm/game/tools.js';
import { gameObservation } from '../src/llm/game/observations.js';

function world(name, x, { time, id = name, parcel = null } = {}) {
  const beliefs = new Beliefs({ now: () => time.value, agentTtlMs: 3000, blockedTtlMs: 100 });
  beliefs.onConfig({ CLOCK: 50, PENALTY: 0, AGENT_TIMEOUT: 10000, GAME: {
    title: 'test', parcels: { generation_event: '1s', decaying_event: '1s', max: 10, reward_avg: 30, reward_variance: 0 },
    player: { movement_duration: 50, observation_distance: 10, capacity: 5 },
  } });
  beliefs.onMap(0, 0, tilesFromRows(['23313333']));
  beliefs.onYou({ id, name, x, y: 0, score: 0 });
  beliefs.onSensing({ positions: parcel ? [{ x: parcel.x, y: parcel.y }] : [], parcels: parcel ? [parcel] : [], agents: [], crates: [] });
  return beliefs;
}
function bus() {
  const peers = new Map();
  const messages = [];
  return {
    messages,
    client(id, name) {
      const callbacks = new Set();
      peers.set(id, { name, callbacks });
      return {
        onMessage(fn) { callbacks.add(fn); return () => callbacks.delete(fn); },
        async shout(msg) {
          messages.push({ sender: name, msg });
          for (const [key, target] of peers) if (key !== id) {
            for (const f of [...target.callbacks]) f(id, name, msg);
          }
          return 'successful';
        },
      };
    },
  };
}
function pair({ parcel = null, xBubble = 4, xMilktea = 1, now = 100000 } = {}) {
  const time = { value: now };
  const b = bus();
  const bubbleBeliefs = world('bubble', xBubble, { time, parcel, id: 'b1' });
  const milkteaBeliefs = world('milktea', xMilktea, { time, id: 'm1' });
  const logs = [];
  const bubble = new CoordinationController({ client: b.client('b1', 'bubble'), beliefs: bubbleBeliefs,
    selfName: 'bubble', peerName: 'milktea', now: () => time.value, settleMs: 10, heartbeatMs: 1e6,
    log: (event, data) => logs.push({ agent: 'bubble', event, ...data }) });
  const milktea = new CoordinationController({ client: b.client('m1', 'milktea'), beliefs: milkteaBeliefs,
    selfName: 'milktea', peerName: 'bubble', now: () => time.value, settleMs: 10, heartbeatMs: 1e6,
    log: (event, data) => logs.push({ agent: 'milktea', event, ...data }) });
  bubble.start(); milktea.start();
  return { bubble, milktea, b, time, logs, bubbleBeliefs, milkteaBeliefs, stop() { bubble.stop(); milktea.stop(); } };
}

test('protocol accepts validated messages and rejects spam, malformed, stale or future packets', () => {
  const valid = encodeMessage('CLAIM', 1, 100000, { parcelId: 'p1', cost: 4, leaseMs: 5000 });
  assert.equal(decodeMessage(valid, 100000)?.type, 'CLAIM');
  assert.equal(decodeMessage(valid, 121000), null);
  assert.equal(decodeMessage(valid, 95000), null);
  assert.equal(decodeMessage('arbitrary chat message', 100000), null);
  assert.equal(decodeMessage(PREFIX + '{', 100000), null);
  assert.equal(decodeMessage('x'.repeat(5000), 100000), null);
  assert.throws(() => encodeMessage('CLAIM', 1, 100000, { parcelId: 'p1', cost: -3, leaseMs: 5000 }));
  assert.throws(() => encodeMessage('BELIEF', 1, 100000, { parcels: [{ id: 'p1', x: 'NaN', y: 0, reward: 100 }] }));
});

test('SDK broadcast discovers teammate, shares direct beliefs and exposes intention', () => {
  const p = { id: 'p42', x: 3, y: 0, reward: 40, carriedBy: null };
  const w = pair({ parcel: p });
  try {
    w.bubble.setIntention('pickup:p42');
    w.bubble.shareBeliefs();
    assert.ok(w.milkteaBeliefs.parcels.get('p42', w.milkteaBeliefs.now()));
    assert.equal(w.milktea.summary().teammate.intention, 'pickup:p42');
    assert.equal(w.milktea.summary().teammate.connected, true);
    assert.ok(w.logs.some(e => e.event === 'coordination_belief_merged'));
    assert.deepEqual(gameObservation(w.milkteaBeliefs, { coordination: w.milktea }).cooperation.teammate.name, 'bubble');
    assert.equal(w.milkteaBeliefs.parcels.directFree(w.milkteaBeliefs.now()).length, 0, 'peer rumors must not be re-broadcast');
  } finally { w.stop(); }
});

test('newer local empty sighting takes precedence over teammate belief', () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 40 }, now: 100000 });
  try {
    w.milkteaBeliefs.onSensing({ positions: [{ x: 3, y: 0 }], parcels: [], agents: [], crates: [] });
    w.bubble.shareBeliefs();
    assert.equal(w.milkteaBeliefs.parcels.get('p42', w.milkteaBeliefs.now()), undefined);
    w.time.value += 100;
    w.bubbleBeliefs.onSensing({ positions: [{ x: 3, y: 0 }], parcels: [{ id: 'p42', x: 3, y: 0, reward: 40 }], agents: [], crates: [] });
    w.bubble.shareBeliefs();
    assert.ok(w.milkteaBeliefs.parcels.get('p42', w.milkteaBeliefs.now()), 'new peer evidence may be fresher');
  } finally { w.stop(); }
});

test('simultaneous parcel claims resolve by reachable path cost and loser yields', async () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 30 }, xBubble: 4, xMilktea: 1 });
  let yielded = false;
  try {
    const one = w.bubble.acquire('p42', { x: 3, y: 0 });
    const two = w.milktea.acquire('p42', { x: 3, y: 0 }, { onYield: () => { yielded = true; } });
    const results = await Promise.all([one, two]);
    assert.deepEqual(results, [true, false]);
    assert.equal(yielded, false, 'loser saw the earlier remote claim and never started');
    assert.equal(w.bubble.summary().myClaim, 'p42');
    assert.equal(w.milktea.canTarget('p42', { x: 3, y: 0 }), false);
    w.bubble.release('p42', 'collected');
    assert.equal(w.milkteaBeliefs.parcels.get('p42', w.milkteaBeliefs.now()), undefined);
    assert.equal(w.milktea.summary().peerClaims.length, 0);
  } finally { w.stop(); }
});

test('incumbent claim survives a later equal-distance competitor', async () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 30 }, xBubble: 4, xMilktea: 2 });
  try {
    // Both have equal path cost: the already committed agent is not preempted.
    let yielded = false;
    assert.equal(await w.milktea.acquire('p42', { x: 3, y: 0 }, { onYield: () => { yielded = true; } }), true);
    assert.equal(await w.bubble.acquire('p42', { x: 3, y: 0 }), false);
    assert.equal(yielded, false);
    assert.equal(w.milktea.summary().myClaim, 'p42');
  } finally { w.stop(); }
});

test('simultaneous equal-cost claims use deterministic lexical tie-breaker', async () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 30 }, xBubble: 4, xMilktea: 2 });
  try {
    // Simulate a delayed claim arriving after milktea initiated its own claim,
    // before its 10ms settling interval elapsed.
    const pending = w.milktea.acquire('p42', { x:3,y:0 });
    const claim = encodeMessage('CLAIM', w.milktea.lastSeq + 1, w.time.value,
      { parcelId: 'p42', cost: 1, leaseMs: 6000 });
    w.milktea.receive('b1', 'bubble', claim);
    assert.equal(await pending, false, 'bubble sorts before milktea when both cost one step');
  } finally { w.stop(); }
});

test('peer claims expire after lease and do not block decisions when peer is gone', async () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 30 }, xBubble: 4, xMilktea: 1 });
  try {
    assert.equal(await w.bubble.acquire('p42', { x: 3, y: 0 }), true);
    assert.equal(w.milktea.canTarget('p42', { x: 3, y: 0 }), false);
    w.time.value += 12000;
    w.milktea.expireClaims();
    assert.equal(w.milktea.summary().peerClaims.length, 0);
    assert.equal(w.milktea.canTarget('p42', { x: 3, y: 0 }), true);
  } finally { w.stop(); }
});

test('unknown name, replayed sequence and malformed payload never change peer claim state', async () => {
  const w = pair();
  try {
    const claim = encodeMessage('CLAIM', w.milktea.lastSeq + 1, w.time.value,
      { parcelId: 'fake', cost: 1, leaseMs: 5000 });
    w.milktea.receive('rogue', 'attacker', claim);
    assert.equal(w.milktea.summary().peerClaims.length, 0);
    w.milktea.receive('b1', 'bubble', claim);
    assert.equal(w.milktea.summary().peerClaims.length, 1);
    w.milktea.receive('b1', 'bubble', claim);
    assert.equal(w.milktea.summary().peerClaims.length, 1);
    w.milktea.receive('b1', 'bubble', 'garbage');
    assert.equal(w.milktea.summary().peerClaims.length, 1);
  } finally { w.stop(); }
});

test('BDI option generation and LLM tool adapter both respect teammate claims', async () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 30 }, xBubble: 4, xMilktea: 1 });
  try {
    const before = listOptions(w.milkteaBeliefs);
    assert.ok(before.some(o => o.id === 'pickup:p42'));
    await w.bubble.acquire('p42', { x: 3, y: 0 });
    const options = listOptions(w.milkteaBeliefs).filter(o => o.type !== 'pickup' || w.milktea.canTarget(o.parcelId, o));
    assert.equal(options.some(o => o.id === 'pickup:p42'), false);
    const calls = [];
    const tools = createGameTools({ beliefs: w.milkteaBeliefs, coordination: w.milktea,
      plans: { execute: async (opt) => { calls.push(opt); return { status: 'completed' }; } } });
    assert.ok(tools.getSpecs().some(t => t.function.name === 'get_cooperation_state'));
    const state = await tools.invoke({ name: 'get_cooperation_state', arguments: {} });
    assert.equal(state.data.peerClaims[0].parcelId, 'p42');
    const collect = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'p42' } });
    assert.equal(collect.error.code, 'coordination_conflict');
    assert.equal(calls.length, 0);
  } finally { w.stop(); }
});

test('cooperative LLM collection enforces a claim, records intent and releases on successful pickup', async () => {
  const { GameProgress } = await import('../src/llm/game/objectives.js');
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 30 }, xBubble: 7, xMilktea: 2 });
  try {
    const progress = new GameProgress(w.milkteaBeliefs);
    const plans = { async execute(option) {
      if (option.type === 'pickup') {
        w.milkteaBeliefs.onYou({ ...w.milkteaBeliefs.me, x: option.x, y: option.y });
        w.milkteaBeliefs.onPickup([{ id: 'p42' }]);
      } else if (option.type === 'deliver') {
        w.milkteaBeliefs.onYou({ ...w.milkteaBeliefs.me, x: option.x, y: option.y, score: 30 });
        w.milkteaBeliefs.onPutdown([{ id: 'p42' }]);
        progress.record('delivery', { parcelIds: ['p42'] });
      }
      return { status: 'completed' };
    } };
    const tools = createGameTools({ beliefs: w.milkteaBeliefs, plans, progress, coordination: w.milktea });
    const result = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'p42' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(progress.deliveredCount, 1);
    assert.equal(w.milktea.summary().myClaim, null);
    assert.equal(w.bubbleBeliefs.parcels.get('p42', w.bubbleBeliefs.now()), undefined);
    assert.ok(w.logs.some(e => e.event === 'coordination_claim_started' && e.agent === 'milktea'));
    assert.ok(w.logs.some(e => e.event === 'coordination_claim_released' && e.reason === 'collected'));
    assert.equal(w.milktea.summary().teammate.intention, null);
  } finally { w.stop(); }
});

test('live BDI controller suppresses a pickup claimed by closer teammate', async () => {
  const { stage1World } = await import('./stage1-helpers.js');
  const { BdiAgent } = await import('../src/intentions/agent.js');
  const w = stage1World({ rows: ['2133'], x: 3 });
  const time = { value: 100000 };
  const b = bus();
  const selfCoord = new CoordinationController({ client: b.client('me', 'bubble'), beliefs: w.beliefs,
    selfName: 'bubble', peerName: 'milktea', now: () => time.value, settleMs: 5, heartbeatMs: 1e6 });
  const p = world('milktea', 0, { time, id: 'm1' });
  p.onSensing({ positions: [{x:1,y:0}], parcels: [{ id:'p',x:1,y:0,reward:20 }], agents:[], crates:[] });
  const peerCoord = new CoordinationController({ client: b.client('m1','milktea'), beliefs: p,
    selfName: 'milktea', peerName: 'bubble', now: () => time.value, settleMs: 5, heartbeatMs: 1e6 });
  selfCoord.start(); peerCoord.start();
  let agent;
  const events = [];
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 3,
    coordination: selfCoord, log: (event, details) => events.push({ event, ...details }) });
  try {
    assert.equal(await peerCoord.acquire('p', {x:1,y:0}), true);
    assert.equal(selfCoord.canTarget('p', {x:1,y:0}), false);
    const task = agent.start();
    await new Promise(resolve => setTimeout(resolve, 35));
    agent.stop();
    await task;
    assert.equal(events.some(e => e.event === 'intention_activated' && e.id === 'pickup:p'), false);
    assert.ok(events.some(e => e.event === 'agent_started'));
  } finally { agent.stop(); selfCoord.stop(); peerCoord.stop(); }
});

test('repeated old parcel reports do not overwrite newer empty observations', () => {
  const w = pair({ parcel: { id: 'p42', x: 3, y: 0, reward: 40 }, now: 100000 });
  try {
    // An old observation is initially propagated, then locally invalidated.
    w.bubble.shareBeliefs();
    assert.ok(w.milkteaBeliefs.parcels.get('p42', w.milkteaBeliefs.now()));
    w.time.value += 50;
    w.milkteaBeliefs.onSensing({ positions: [{x:3,y:0}], parcels:[], agents:[], crates:[] });
    w.time.value += 1000;
    w.bubble.shareBeliefs(); // same old direct sighting, with an accurate ageMs
    assert.equal(w.milkteaBeliefs.parcels.get('p42', w.milkteaBeliefs.now()), undefined);
  } finally { w.stop(); }
});
