// @ts-nocheck -- focused game and LLM fixtures deliberately use partial SDK clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { createGameRuntime } from '../src/llm/game/runtime.js';
import { GameProgress, parseGameObjective } from '../src/llm/game/objectives.js';
import { gameObservation } from '../src/llm/game/observations.js';
import { WorkingMemory } from '../src/llm/memory.js';
import { PlanActLoop } from '../src/llm/agent.js';
import { ToolRegistry } from '../src/llm/tools/registry.js';

const plan = (name) => ({ role: 'assistant', content: JSON.stringify({ summary: 'Follow the goal',
  steps: [{ tool: name, reason: 'Use verified game actions' }] }) });
const call = (name, args = {}) => ({ role: 'assistant', content: '', tool_calls: [
  { function: { name, arguments: args } },
] });
const fixtureProvider = (responses) => {
  let chats = 0;
  return {
    get calls() { return chats; },
    async chat() {
      const reply = responses[chats++];
      assert.ok(reply, 'model must not be called again after verified completion');
      return { message: reply };
    },
  };
};

const empty = { type: 'object', additionalProperties: false, required: [], properties: {} };

test('Stage 2C.2.2: real game runtime auto-completes 3-delivery goal after five acknowledged parcels, even without model finish', async () => {
  const sim = stage1World({ rows: ['2133'], x: 3, capacity: 5 });
  sim.send(Array.from({ length: 5 }, (_, n) => ({ id: `p${n}`, x: 1, y: 0, reward: 25, carriedBy: null })), [{ x: 1, y: 0 }]);
  const provider = fixtureProvider([plan('collect_best_and_deliver'),
    call('collect_best_and_deliver', { strategy: 'highest_expected_reward' })]);
  const events = [];
  const runtime = createGameRuntime({ beliefs: sim.beliefs, client: sim.client, provider,
    log: (event, details) => events.push({ event, ...details }) });
  const result = await runtime.runObjective('Deliver 3 parcels');
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'verified');
  assert.equal(result.progress.deliveredCount, 5);
  assert.equal(result.progress.deliveryActions, 1);
  assert.equal(result.metrics.llmCalls, 2);
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(provider.calls, 2, 'must not require finish_objective or another LLM response');
  assert.equal(sim.events.filter(e => e.action === 'putdown').length, 1);
  assert.ok(events.some(e => e.event === 'llm_objective_auto_verified' && e.source === 'tool:collect_best_and_deliver'));
  assert.equal(runtime.memory.snapshot().observation.objectiveProgress.verifiedComplete, true);
  assert.equal(runtime.memory.snapshot().observation.objectiveProgress.remaining, 0);
});

test('Stage 2C.2.2: objective context distinguishes historical deliveries from currently visible parcels', () => {
  const sim = stage1World();
  const progress = new GameProgress(sim.beliefs);
  const criterion = parseGameObjective('Deliver 3 parcels');
  const before = progress.status(criterion);
  assert.equal(before.current, 0);
  assert.equal(before.remaining, 3);
  assert.equal(before.verifiedComplete, false);
  progress.record('delivery', { parcelIds: ['p1', 'p2'] });
  const observation = gameObservation(sim.beliefs, { objectiveProgress: progress.status(criterion) });
  assert.equal(observation.objectiveProgress.current, 2);
  assert.equal(observation.objectiveProgress.remaining, 1);
  assert.equal(observation.objectiveProgress.evidence.deliveredCount, 2);
  assert.ok(observation.knownFreeParcels.count <= 1,
    'goal progress is independent of how many parcels are visible right now');
});

test('Stage 2C.2.2: score objective progress uses actual scores and never fabricates missing score evidence', () => {
  const sim = stage1World();
  const progress = new GameProgress(sim.beliefs);
  const delta = parseGameObjective('Earn 20 additional points');
  assert.equal(progress.status(delta).remaining, 20);
  sim.beliefs.onYou({ ...sim.beliefs.me, score: 13 });
  assert.equal(progress.status(delta).remaining, 7);
  assert.equal(progress.status(delta).verifiedComplete, false);
  sim.beliefs.onYou({ ...sim.beliefs.me, score: 20 });
  assert.equal(progress.status(delta).verifiedComplete, true);
  const scoreAbsolute = parseGameObjective('Reach 30 points');
  assert.equal(progress.status(scoreAbsolute).remaining, 10);
});

test('Stage 2C.2.2: read-only tool cannot auto-complete an unfulfilled delivery goal', async () => {
  const sim = stage1World();
  const progress = new GameProgress(sim.beliefs);
  const tools = new ToolRegistry().register({ name: 'observe_only', description: 'Read game state',
    parameters: empty, execute: () => ({ parcels: [] }) });
  const provider = fixtureProvider([plan('observe_only'), call('observe_only'),
    { role: 'assistant', content: 'I did it.' }, { role: 'assistant', content: 'Finished.' }]);
  const loop = new PlanActLoop({ provider, memory: new WorkingMemory(), tools,
    maxSteps: 3, autoVerifyCompletion: true,
    verifyCompletion: () => progress.verify(parseGameObjective('Deliver 3 parcels')) });
  const result = await loop.run('Deliver 3 parcels');
  assert.equal(result.status, 'stalled');
  assert.equal(result.reason, 'no_tool_calls');
  assert.equal(result.metrics.successfulTools, 1);
  assert.equal(progress.deliveredCount, 0);
});

test('Stage 2C.2.2: auto-verification stops before any further tool calls in a multi-tool reply', async () => {
  const sim = stage1World();
  const progress = new GameProgress(sim.beliefs);
  let secondExecuted = false;
  const tools = new ToolRegistry()
    .register({ name: 'real_delivery', description: 'Confirm a delivery', parameters: empty,
      execute: () => { progress.record('delivery', { parcelIds: ['p1'] }); return { delivered: ['p1'] }; } })
    .register({ name: 'unnecessary_action', description: 'Should not run after success', parameters: empty,
      execute: () => { secondExecuted = true; return 'bad'; } });
  const provider = fixtureProvider([plan('real_delivery'), { role: 'assistant', content: '', tool_calls: [
    { function: { name: 'real_delivery', arguments: {} } },
    { function: { name: 'unnecessary_action', arguments: {} } },
  ] }]);
  const loop = new PlanActLoop({ provider, memory: new WorkingMemory(), tools,
    autoVerifyCompletion: true, verifyCompletion: () => progress.verify(parseGameObjective('Deliver 1 parcel')) });
  const result = await loop.run('Deliver 1 parcel');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(secondExecuted, false);
});

test('Stage 2C.2.2: already-verified score goal completes without LLM call or actions', async () => {
  const sim = stage1World();
  sim.beliefs.onYou({ ...sim.beliefs.me, score: 50 });
  const progress = new GameProgress(sim.beliefs);
  const tools = new ToolRegistry().register({ name: 'read_game', description: 'Read the game', parameters: empty,
    execute: () => ({}) });
  const provider = fixtureProvider([]);
  const loop = new PlanActLoop({ provider, memory: new WorkingMemory(), tools,
    autoVerifyCompletion: true, verifyCompletion: () => progress.verify(parseGameObjective('Reach 40 points')) });
  const result = await loop.run('Reach 40 points');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.toolCalls, 0);
  assert.equal(provider.calls, 0);
});

test('Stage 2C.2.2: general-purpose loop cannot enable auto-verification without a verifier', () => {
  assert.throws(() => new PlanActLoop({ provider: fixtureProvider([]), memory: new WorkingMemory(),
    tools: new ToolRegistry(), autoVerifyCompletion: true }), /requires an evidence verifier/);
});
