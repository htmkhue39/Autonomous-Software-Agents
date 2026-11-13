// @ts-nocheck -- deterministic failure/recovery simulations with fake SDK actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { GridMap } from '../src/beliefs/map.js';
import { tilesFromRows } from './helpers.js';
import { AgentBeliefs } from '../src/beliefs/agents.js';
import { MovementRunner } from '../src/plans/moveTo.js';
import { findPath } from '../src/planning/astar.js';
import { parcelOpportunities } from '../src/llm/game/viability.js';
import { createGameTools } from '../src/llm/game/tools.js';
import { PlanActLoop } from '../src/llm/agent.js';
import { WorkingMemory } from '../src/llm/memory.js';
import { ToolRegistry, ToolFailure } from '../src/llm/tools/registry.js';
import { CoordinationController } from '../src/coordination/controller.js';
import { decodeMessage } from '../src/coordination/protocol.js';

const parcel = (reward = 35) => ({ id: 'p', x: 1, y: 0, reward, carriedBy: null });
function decayWorld(reward) {
  const w = stage1World({ rows: ['21333333'], x: 7 });
  const config = structuredClone(w.beliefs.config);
  config.GAME.parcels.decaying_event = '1s';
  w.beliefs.onConfig(config);
  w.send([parcel(reward)], [{ x: 1, y: 0 }]);
  return w;
}

test('static diagnostic route ignores temporary block but keeps walls/arrows', () => {
  const map = new GridMap(4, 1, tilesFromRows(['2333']));
  map.block(2, 0, 1000);
  assert.equal(findPath(map, { x: 3, y: 0 }, { x: 0, y: 0 }, { now: 0 }), null);
  assert.deepEqual(findPath(map, { x: 3, y: 0 }, { x: 0, y: 0 }, { now: 0, ignoreTemporary: true }), ['left','left','left']);
  const oneWay = new GridMap(3, 1, tilesFromRows(['3→3']));
  assert.equal(findPath(oneWay, { x: 2, y: 0 }, { x: 0, y: 0 }, { now: 0, ignoreTemporary: true }), null);
});

test('occupancy details report observed agent, fractional reserved tiles and freshness', () => {
  const agents = new AgentBeliefs(3000);
  agents.update([{ id: 'a', name: 'NPC', x: 1.4, y: 0, score: 0 }], 100);
  const first = agents.occupiedDetails(600)[0];
  assert.equal(first.name, 'NPC');
  assert.equal(first.ageMs, 500);
  assert.deepEqual(first.tiles, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
  assert.equal(agents.occupiedDetails(4000).length, 0);
});

test('blocked by another agent: runner waits, re-observes and then navigates', async () => {
  const events = [];
  const w = stage1World({ rows: ['2333'], x: 3, log: (event, details) => events.push({ event, ...details }) });
  w.beliefs.agents.update([{ id: 'a', name: 'npc', x: 2, y: 0, score: 0 }], w.beliefs.now());
  const runner = new MovementRunner({ beliefs: w.beliefs, client: w.client, gate: w.gate,
    mode: 'astar', congestionTimeoutMs: 500, congestionRetryMs: 20,
    log: (event, details) => events.push({ event, ...details }) });
  const timer = setTimeout(() => w.beliefs.agents.update([
    { id: 'a', name: 'npc', x: 99, y: 0, score: 0 }], w.beliefs.now()), 55);
  try {
    const result = await runner.moveTo({ x: 0, y: 0 }, { stopped: false });
    assert.equal(result.status, 'completed');
    assert.ok(events.some(e => e.event === 'navigation_wait' && e.blockers[0].name === 'npc'));
    assert.ok(events.some(e => e.event === 'navigation_recovered'));
  } finally { clearTimeout(timer); }
});

test('persistent congestion fails within the configured deadline and logs blockers', async () => {
  const events = [];
  const w = stage1World({ rows: ['2333'], x: 3 });
  w.beliefs.agents.update([{ id: 'a', name: 'npc', x: 2, y: 0, score: 0 }], w.beliefs.now());
  const runner = new MovementRunner({ beliefs: w.beliefs, client: w.client, gate: w.gate,
    mode: 'astar', congestionTimeoutMs: 80, congestionRetryMs: 20,
    log: (event, details) => events.push({ event, ...details }) });
  const result = await runner.moveTo({ x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Congestion timeout');
  assert.ok(events.some(e => e.event === 'navigation_failed' && e.failureKind === 'congestion'));
});

test('permanently unreachable map fails static-route check promptly', async () => {
  const events = [];
  const w = stage1World({ rows: ['2033'], x: 3 });
  const runner = new MovementRunner({ beliefs: w.beliefs, client: w.client, gate: w.gate,
    mode: 'astar', congestionTimeoutMs: 500,
    log: (event, details) => events.push({ event, ...details }) });
  const result = await runner.moveTo({ x: 0, y: 0 }, { stopped: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Static route impossible');
  assert.ok(events.some(e => e.failureKind === 'static'));
});

test('congestion wait respects cancellation', async () => {
  const w = stage1World({ rows: ['2333'], x: 3 });
  w.beliefs.agents.update([{ id: 'a', name: 'npc', x: 2, y: 0, score: 0 }], w.beliefs.now());
  const signal = { stopped: false };
  const runner = new MovementRunner({ beliefs: w.beliefs, client: w.client, gate: w.gate,
    mode: 'astar', congestionTimeoutMs: 300, congestionRetryMs: 20 });
  const timer = setTimeout(() => { signal.stopped = true; }, 35);
  try { assert.equal((await runner.moveTo({ x: 0, y: 0 }, signal)).status, 'cancelled'); }
  finally { clearTimeout(timer); }
});

test('reward-aware ranking favors a deliverable parcel over an expiring parcel', () => {
  const w = decayWorld(5);
  w.send([parcel(5), { id: 'good', x: 2, y: 0, reward: 35, carriedBy: null }]);
  const ranked = parcelOpportunities(w.beliefs);
  assert.equal(ranked[0].id, 'good');
  assert.equal(ranked[0].viable, true);
  assert.equal(ranked.find(p => p.id === 'p').viable, false);
  assert.equal(ranked.find(p => p.id === 'p').reason, 'likely_to_expire');
  assert.ok(ranked[0].estimatedTimeMs >= 6000);
});

test('low-viability target rejected before issuing any SDK actions', async () => {
  const w = decayWorld(4);
  const calls = [];
  const tools = createGameTools({ beliefs: w.beliefs, plans: { async execute(opt) { calls.push(opt); return { status: 'completed' }; } } });
  const response = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'p' } });
  assert.equal(response.ok, false);
  assert.match(response.error.message, /not a viable/);
  assert.deepEqual(calls, []);
});

test('failed pickup puts target on cooldown and provides alternative feedback', async () => {
  const w = decayWorld(40);
  const logs = [];
  const tools = createGameTools({ beliefs: w.beliefs,
    plans: { async execute() { return { status: 'failed', reason: 'Target no longer applicable' }; } },
    log: (event, data) => logs.push({ event, ...data }) });
  const first = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'p' } });
  assert.equal(first.ok, false);
  assert.ok(logs.some(e => e.event === 'llm_target_cooldown'));
  const known = await tools.invoke({ name: 'get_known_parcels', arguments: {} });
  assert.equal(known.data.free[0].onCooldown, true);
  assert.equal(known.data.free[0].reason, 'failed_target_cooldown');
});

test('failed delivery reconciles actual carrying beliefs rather than claiming success', async () => {
  const w = decayWorld(40);
  w.beliefs.onPickup([{ id: 'p' }]);
  const logs = [];
  const tools = createGameTools({ beliefs: w.beliefs,
    plans: { async execute() { return { status: 'failed', reason: 'Nothing dropped at delivery' }; } },
    log: (event, data) => logs.push({ event, ...data }) });
  const result = await tools.invoke({ name: 'deliver_parcels', arguments: {} });
  assert.equal(result.ok, false);
  assert.ok(logs.some(e => e.event === 'llm_inventory_reconciled' && e.carryingCount === 1));
});

test('LLM metrics separate invalid requests from failed gameplay actions', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'fail_game', description: 'Simulated game failure',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    execute() { throw new ToolFailure('game_action_failed', 'Parcel expired'); } });
  const responses = [
    { message: { content: JSON.stringify({ summary: 'try it', steps: [{ tool: 'fail_game', reason: 'test' }] }) } },
    { message: { content: '', tool_calls: [{ function: { name: 'fail_game', arguments: {} } }] } },
    { message: { content: '', tool_calls: [{ function: { name: 'missing_tool', arguments: {} } }] } },
    { message: { content: '', tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'blocked', summary: 'no parcel' } } }] } },
  ];
  let i = 0;
  const loop = new PlanActLoop({ provider: { chat: async () => responses[i++] },
    memory: new WorkingMemory(), tools, maxSteps: 4 });
  const result = await loop.run('test failure types');
  assert.equal(result.status, 'blocked');
  assert.equal(result.metrics.failedGameActions, 1);
  assert.equal(result.metrics.invalidToolCalls, 1);
  assert.equal(result.metrics.invalidTools, 2); // legacy total preserved
});

test('heartbeat throttles repeated status and belief messages without delaying intention changes', () => {
  const w = stage1World();
  let now = 100_000;
  const outgoing = [];
  const client = { onMessage() { return () => {}; }, async shout(wire) { outgoing.push(decodeMessage(wire, now)); } };
  const coord = new CoordinationController({ client, beliefs: w.beliefs, selfName: 'bubble', peerName: 'milktea',
    now: () => now, heartbeatMs: 1000000 });
  const count = type => outgoing.filter(m => m?.type === type).length;
  try {
    coord.start();
    const statuses = count('STATUS'); const beliefs = count('BELIEF');
    coord.heartbeat(); coord.heartbeat();
    assert.equal(count('STATUS'), statuses);
    assert.equal(count('BELIEF'), beliefs);
    coord.setIntention('pickup:p');
    assert.equal(count('STATUS'), statuses + 1);
    now += 6_001;
    coord.heartbeat();
    assert.equal(count('STATUS'), statuses + 2);
  } finally { coord.stop(); }
});

test('LLM delivery can select statically reachable tile despite temporary occupancy', async () => {
  const w = stage1World({ rows: ['2133'], x: 3 });
  w.beliefs.onPickup([{ id: 'p' }]);
  w.beliefs.agents.update([{ id: 'npc', name: 'npc', x: 0, y: 0, score: 0 }], w.beliefs.now());
  let selected = null;
  const tools = createGameTools({ beliefs: w.beliefs, plans: {
    async execute(option) { selected = option; return { status: 'completed' }; }
  } });
  const result = await tools.invoke({ name: 'deliver_parcels', arguments: {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(selected.type, 'deliver');
  assert.equal(selected.x, 0);
});
