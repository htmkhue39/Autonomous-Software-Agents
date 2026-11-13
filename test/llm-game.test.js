// @ts-nocheck -- focused integration fixtures use partial fake game clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beliefs } from '../src/beliefs/index.js';
import { tilesFromRows } from './helpers.js';
import { parseGameObjective, GameProgress } from '../src/llm/game/objectives.js';
import { gameObservation } from '../src/llm/game/observations.js';
import { createGameTools } from '../src/llm/game/tools.js';
import { ToolFailure, ToolRegistry } from '../src/llm/tools/registry.js';
import { PlanActLoop } from '../src/llm/agent.js';
import { WorkingMemory } from '../src/llm/memory.js';

function world({ x = 3, rows = ['2133'], capacity = 2 } = {}) {
  const beliefs = new Beliefs({ now: () => 100, agentTtlMs: 3000, blockedTtlMs: 100 });
  beliefs.onConfig({ CLOCK: 50, PENALTY: 1, AGENT_TIMEOUT: 10000, GAME: { title: 'toy oval',
    parcels: { generation_event: '2s', decaying_event: 'infinite', max: 10, reward_avg: 10, reward_variance: 1 },
    player: { movement_duration: 50, observation_distance: 5, capacity },
  } });
  beliefs.onMap(0, 0, tilesFromRows(rows));
  beliefs.onYou({ id: 'milktea-id', name: 'milktea', x, y: 0, score: 0 });
  beliefs.onSensing({ positions: [{ x: 1, y: 0 }], agents: [],
    parcels: [{ id: 'parcel-1', x: 1, y: 0, reward: 20, carriedBy: null }], crates: [] });
  const progress = new GameProgress(beliefs);
  const calls = [];
  const plans = {
    async execute(option, stop) {
      calls.push(option);
      if (stop.stopped) return { status: 'cancelled' };
      if (option.type === 'pickup') {
        const p = beliefs.parcels.get(option.parcelId, beliefs.now());
        if (!p) return { status: 'failed', reason: 'missing' };
        beliefs.onYou({ ...beliefs.me, x: p.x, y: p.y });
        beliefs.onPickup([{ id: p.id }]);
      } else if (option.type === 'deliver') {
        const carried = beliefs.parcels.carriedBy('milktea-id', beliefs.now());
        beliefs.onYou({ ...beliefs.me, x: option.x, y: option.y, score: 20 });
        beliefs.onPutdown(carried.map(p => ({ id: p.id })));
        progress.record('delivery', { parcelIds: carried.map(p => p.id) });
      } else beliefs.onYou({ ...beliefs.me, x: option.x, y: option.y });
      return { status: 'completed' };
    },
  };
  return { beliefs, progress, plans, calls, tools: createGameTools({ beliefs, plans, progress }) };
}

test('Stage 2B objective grammar supports scored and delivered goals without trusting LLM claims', () => {
  assert.deepEqual(parseGameObjective('Collect and deliver at least 100 points').kind, 'score_absolute');
  assert.deepEqual(parseGameObjective('Earn 50 additional points').kind, 'score_delta');
  assert.deepEqual(parseGameObjective('Deliver 3 parcels').kind, 'deliver_count');
  assert.deepEqual(parseGameObjective('Collect and deliver at least one parcel').target, 1);
  assert.equal(parseGameObjective('Coordinate with agent bubble to defend a zone').kind, 'unsupported');
});

test('game observations keep current and partial game state explicit', () => {
  const { beliefs } = world();
  const view = gameObservation(beliefs);
  assert.equal(view.ready, true);
  assert.equal(view.self.name, 'milktea');
  assert.equal(view.knownFreeParcels.count, 1);
  assert.match(view.knownFreeParcels.note, /Partially observed/);
  assert.equal(view.deliveryTiles.count, 1);
});

test('GameProgress completion requires actual score or acknowledged delivery', () => {
  const { beliefs, progress } = world();
  assert.equal(progress.verify(parseGameObjective('Deliver 1 parcel')), false);
  assert.equal(progress.verify(parseGameObjective('Reach 20 points')), false);
  progress.record('delivery', { parcelIds: ['parcel-1'] });
  assert.equal(progress.verify(parseGameObjective('Deliver 1 parcel')), true);
  assert.equal(progress.verify(parseGameObjective('Reach 20 points')), false);
  beliefs.onYou({ ...beliefs.me, score: 20 });
  assert.equal(progress.verify(parseGameObjective('Reach 20 points')), true);
  assert.equal(progress.verify(parseGameObjective('Earn 20 additional points')), true);
  assert.equal(progress.verify(parseGameObjective('Defend north area')), false);
});

test('game tools use allowlisted Stage 1.1 plan interface to collect and deliver real parcel IDs', async () => {
  const { tools, calls, progress } = world();
  const spec = tools.getSpecs().map(x => x.function.name);
  assert.deepEqual(spec, ['get_game_state', 'get_known_parcels', 'get_delivery_tiles',
    'navigate_to', 'pickup_parcels', 'deliver_parcels', 'collect_and_deliver', 'explore', 'collect_best_and_deliver']);
  const parcels = await tools.invoke({ name: 'get_known_parcels', arguments: {} });
  assert.equal(parcels.data.free[0].id, 'parcel-1');
  const picked = await tools.invoke({ name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } });
  assert.equal(picked.ok, true);
  const delivered = await tools.invoke({ name: 'deliver_parcels', arguments: {} });
  assert.equal(delivered.ok, true);
  assert.equal(progress.deliveredCount, 1);
  assert.equal(calls[0].type, 'pickup');
  assert.equal(calls[1].type, 'deliver');
  assert.equal(progress.verify(parseGameObjective('Deliver 1 parcel')), true);
});

test('invalid or unknown game requests cannot execute an action', async () => {
  const { tools, calls } = world();
  assert.equal((await tools.invoke({ name: 'shell_command', arguments: { cmd: 'rm -rf' } })).error.code, 'unknown_tool');
  assert.equal((await tools.invoke({ name: 'navigate_to', arguments: { x: -2, y: 0 } })).error.code, 'invalid_arguments');
  assert.equal((await tools.invoke({ name: 'navigate_to', arguments: { x: 99, y: 0 } })).error.code, 'game_action_failed');
  assert.equal((await tools.invoke({ name: 'pickup_parcels', arguments: { parcel_id: 'invented' } })).error.code, 'game_action_failed');
  assert.equal(calls.length, 0);
});

test('game tool detects parcel disappearance and never invokes pickup plan', async () => {
  const { tools, beliefs, calls } = world();
  beliefs.onSensing({ positions: [{ x: 1, y: 0 }], agents: [], parcels: [], crates: [] });
  const result = await tools.invoke({ name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } });
  assert.equal(result.error.code, 'game_action_failed');
  assert.equal(calls.length, 0);
});

test('unknown action outcome is preserved as outcome_unknown instead of false failure', async () => {
  const { beliefs } = world();
  const plans = { execute: async () => ({ status: 'unknown', reason: 'Socket ack timed out' }) };
  const tools = createGameTools({ beliefs, plans });
  const result = await tools.invoke({ name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } });
  assert.equal(result.error.code, 'outcome_unknown');
});

test('capacity and reachable delivery preconditions are validated', async () => {
  const filled = world({ capacity: 0 });
  assert.equal((await filled.tools.invoke({ name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } })).error.code, 'game_action_failed');
  const noDelivery = world({ rows: ['1333'] });
  await noDelivery.tools.invoke({ name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } });
  assert.equal((await noDelivery.tools.invoke({ name: 'deliver_parcels', arguments: {} })).error.code, 'game_action_failed');
});

test('complete simulated LLM plan picks up and delivers based on evidence', async () => {
  const { tools, progress, beliefs } = world();
  let step = 0;
  const provider = { async chat() {
    const responses = [
      { content: JSON.stringify({ summary: 'Collect and deliver one parcel', steps: [
        { tool: 'get_game_state', reason: 'Observe' }, { tool: 'pickup_parcels', reason: 'Collect' },
        { tool: 'deliver_parcels', reason: 'Deliver' }] }) },
      { tool_calls: [{ function: { name: 'get_game_state', arguments: {} } }] },
      { tool_calls: [{ function: { name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } } }] },
      { tool_calls: [{ function: { name: 'deliver_parcels', arguments: {} } }] },
      { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'Delivered one parcel' } } }] },
    ];
    const reply = responses[step++];
    return { message: { role: 'assistant', content: reply.content ?? '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } };
  } };
  const loop = new PlanActLoop({ provider, memory: new WorkingMemory({ maxTextLength: 5500 }), tools,
    verifyCompletion: () => progress.verify(parseGameObjective('Deliver 1 parcel')),
    observe: () => gameObservation(beliefs), });
  const result = await loop.run('Deliver 1 parcel', { observation: gameObservation(beliefs) });
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.successfulTools, 3);
  assert.equal(progress.deliveredCount, 1);
});

test('native finish without delivery evidence is rejected even after read-only tool', async () => {
  const { tools, progress, beliefs } = world();
  let step = 0;
  const provider = { async chat() {
    const responses = [
      { content: JSON.stringify({ summary: 'Observe', steps: [{ tool: 'get_game_state', reason: 'Inspect' }] }) },
      { tool_calls: [{ function: { name: 'get_game_state', arguments: {} } }] },
      { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'Claim complete' } } }] },
    ];
    const reply = responses[step++] ?? { tool_calls: [] };
    return { message: { role: 'assistant', content: reply.content ?? '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } };
  } };
  const result = await new PlanActLoop({ provider, memory: new WorkingMemory(), tools,
    verifyCompletion: () => progress.verify(parseGameObjective('Deliver 1 parcel')) }).run('Deliver one parcel', {
      observation: gameObservation(beliefs) });
  assert.notEqual(result.status, 'completed');
  assert.equal(progress.deliveredCount, 0);
});

test('ToolFailure metadata is never taken from arbitrary tool exceptions', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'legit', description: 'an action', parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    execute() { throw new ToolFailure('outcome_unknown', 'Uncertain dispatch'); } });
  const outcome = await tools.invoke({ name: 'legit', arguments: {} });
  assert.equal(outcome.error.code, 'outcome_unknown');
});

test('Stage 2B runtime executes the genuine Stage 1.1 movement/plan pipeline in a fake world', async () => {
  const { stage1World } = await import('./stage1-helpers.js');
  const { createGameRuntime } = await import('../src/llm/game/runtime.js');
  const sim = stage1World({ rows: ['2133'], x: 3 });
  const dialogs = [
    { content: JSON.stringify({ summary: 'Collect and deliver', steps: [
      { tool: 'get_game_state', reason: 'Observe the world' },
      { tool: 'pickup_parcels', reason: 'Go to p' },
      { tool: 'deliver_parcels', reason: 'Finish delivery' }] }) },
    { tool_calls: [{ function: { name: 'get_game_state', arguments: {} } }] },
    { tool_calls: [{ function: { name: 'pickup_parcels', arguments: { parcel_id: 'p' } } }] },
    { tool_calls: [{ function: { name: 'deliver_parcels', arguments: {} } }] },
    { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'Parcel delivered' } } }] },
  ];
  let i = 0;
  const events = [];
  const runtime = createGameRuntime({ beliefs: sim.beliefs, client: sim.client,
    provider: { async chat() { const next = dialogs[i++]; return { message: { role: 'assistant', content: next.content ?? '', ...(next.tool_calls ? { tool_calls: next.tool_calls } : {}) } }; } },
    log: (type, data) => events.push({ type, data }) });
  const result = await runtime.runObjective('Deliver 1 parcel');
  assert.equal(result.status, 'completed');
  assert.equal(result.progress.deliveredCount, 1);
  assert.equal(sim.events.filter(e => e.action === 'pickup').length, 1);
  assert.equal(sim.events.filter(e => e.action === 'putdown').length, 1);
  assert.ok(sim.events.some(e => e.action === 'move'));
  assert.ok(events.some(e => e.type === 'delivery'));
});

test('Stage 2B rejects unsupported local objectives before dispatching model/game actions', async () => {
  const { createGameRuntime } = await import('../src/llm/game/runtime.js');
  const { beliefs, plans } = world();
  let modelCalls = 0;
  const runtime = createGameRuntime({ beliefs, client: {}, provider: { async chat() { modelCalls++; return {}; } } });
  const result = await runtime.runObjective('Coordinate agent bubble through the course challenge channel');
  assert.equal(result.reason, 'unsupported_local_completion_criterion');
  assert.equal(modelCalls, 0);
});

test('Stage 2B game readiness waits for genuine map/config/self observations', async () => {
  const { waitForGameReady } = await import('../src/llm/game/runtime.js');
  const beliefs = new Beliefs({ now: () => 0, agentTtlMs: 100, blockedTtlMs: 100 });
  const pending = waitForGameReady(beliefs, { timeoutMs: 1000 });
  beliefs.onConfig({ CLOCK: 50, PENALTY: 1, AGENT_TIMEOUT: 10_000, GAME: { title: 'test',
    parcels: { generation_event: '2s', decaying_event: 'infinite', max: 1, reward_avg: 10, reward_variance: 1 },
    player: { movement_duration: 50, observation_distance: 5, capacity: 5 } } });
  beliefs.onMap(0, 0, tilesFromRows(['23']));
  beliefs.onYou({ id: 'me', name: 'milktea', x: 1, y: 0, score: 0 });
  await pending;
  const other = new Beliefs({ now: () => 0, agentTtlMs: 100, blockedTtlMs: 100 });
  await assert.rejects(() => waitForGameReady(other, { timeoutMs: 4 }), /No full SDK/);
});

test('collect_and_deliver dispatches pickup and delivery in one LLM tool call', async () => {
  const { tools, calls, progress } = world();
  const result = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'parcel-1' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.pickup.picked, 'parcel-1');
  assert.equal(result.data.delivery.deliveredParcelIds[0], 'parcel-1');
  assert.deepEqual(calls.map(x => x.type), ['pickup', 'deliver']);
  assert.equal(progress.deliveredCount, 1);
});

test('collect_and_deliver does not claim delivery when parcel expires after pickup', async () => {
  const { beliefs } = world();
  let attempts = 0;
  const plans = { execute: async (option) => {
    attempts++;
    if (option.type === 'pickup') {
      beliefs.onPickup([{ id: 'parcel-1' }]);
      // Even a confirmed parcel may disappear during a real game with decay.
      beliefs.onPutdown([{ id: 'parcel-1' }]);
    }
    return { status: 'completed' };
  } };
  const tools = createGameTools({ beliefs, plans });
  const result = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'parcel-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'game_action_failed');
  assert.equal(attempts, 1);
});

test('perished parcel followed by prose can recover to a new tool action', async () => {
  const { beliefs } = world();
  let calls = 0;
  const plans = {
    async execute(option) {
      if (option.type === 'pickup') {
        calls++;
        // First parcel disappears before it can be picked up.
        if (calls === 1) {
          beliefs.onSensing({ positions: [{ x: 1, y: 0 }], agents: [], parcels: [], crates: [] });
          return { status: 'failed', reason: 'Target no longer applicable' };
        }
      }
      return { status: 'completed' };
    },
  };
  const tools = createGameTools({ beliefs, plans });
  let i = 0;
  const responses = [
    { content: JSON.stringify({ summary: 'Inspect and retry safely', steps: [{ tool: 'pickup_parcels', reason: 'collect' }] }) },
    { tool_calls: [{ function: { name: 'pickup_parcels', arguments: { parcel_id: 'parcel-1' } } }] },
    { content: 'Parcel disappeared, I should look for another.' },
    { tool_calls: [{ function: { name: 'get_game_state', arguments: {} } }] },
    { tool_calls: [{ function: { name: 'get_known_parcels', arguments: {} } }] },
    { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'blocked', summary: 'No new parcels yet' } } }] },
  ];
  const provider = { async chat() { const response = responses[i++]; return { message: { role: 'assistant', content: response.content ?? '', ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}) } }; } };
  const loop = new PlanActLoop({ provider, tools, memory: new WorkingMemory(),
    observe: () => gameObservation(beliefs), maxSteps: 7 });
  const result = await loop.run('Deliver one parcel');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'model_reported_blocked');
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(calls, 1);
  assert.equal(result.metrics.replans >= 1, true);
});

test('the Stage 1.1 executor can execute collect_and_deliver as one LLM game tool', async () => {
  const { stage1World } = await import('./stage1-helpers.js');
  const { createGameRuntime } = await import('../src/llm/game/runtime.js');
  const sim = stage1World({ rows: ['2133'], x: 3 });
  const dialogs = [
    { content: JSON.stringify({ summary: 'Deliver swiftly', steps: [{ tool: 'collect_and_deliver', reason: 'Avoid decay' }] }) },
    { tool_calls: [{ function: { name: 'collect_and_deliver', arguments: { parcel_id: 'p' } } }] },
    { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'Delivered' } } }] },
  ];
  let i = 0;
  const runtime = createGameRuntime({ beliefs: sim.beliefs, client: sim.client,
    provider: { async chat() { const r = dialogs[i++]; return { message: { role: 'assistant', content: r.content ?? '', ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) } }; } } });
  const result = await runtime.runObjective('Deliver one parcel');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.progress.deliveredCount, 1);
  assert.equal(sim.events.filter(e => e.action === 'pickup').length, 1);
  assert.equal(sim.events.filter(e => e.action === 'putdown').length, 1);
});
