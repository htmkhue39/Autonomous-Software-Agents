// @ts-nocheck -- simulation fixtures use intentionally partial SDK clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { createGameTools } from '../src/llm/game/tools.js';
import { parcelOpportunities } from '../src/llm/game/viability.js';
import { createGameRuntime } from '../src/llm/game/runtime.js';

const p = (id, x, reward = 40) => ({ id, x, y: 0, reward, carriedBy: null });
const world = () => stage1World({ rows: ['213333'], x: 5 });
const run = (tools, strategy = 'highest_expected_reward', extra = {}) =>
  tools.invoke({ name: 'collect_best_and_deliver', arguments: { strategy, explore_if_empty: false, ...extra } });

test('a strategy tool selects a fresh parcel AFTER an old observed ID disappears', async () => {
  const w = world();
  // Model saw p before invocation. An authoritative sensing update now
  // removes p and discovers q; the strategy must not bind to p.
  w.send([p('q', 2, 45)], [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
  const events = [];
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans,
    log: (event, fields) => events.push({ event, ...fields }) });
  const result = await run(tools);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, 'delivered');
  assert.equal(result.data.selectedParcelId, 'q');
  assert.deepEqual(result.data.delivery.deliveredParcelIds, ['q']);
  assert.equal(w.events.filter(e => e.action === 'pickup').length, 1);
  assert.equal(w.events.filter(e => e.action === 'putdown').length, 1);
  assert.ok(events.some(e => e.event === 'llm_dynamic_selected' && e.parcelId === 'q'));
});

test('dynamic selection is strategy-dependent and never assumes an old ID exists', async () => {
  const w = world();
  w.send([p('near', 4, 20), p('valuable', 1, 100)]);
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans });
  const ranked = parcelOpportunities(w.beliefs);
  assert.equal(ranked[0].id, 'valuable');
  assert.ok(ranked.every(x => x.freshForAction && x.source === 'direct'));
  assert.equal((await run(tools, 'nearest_viable')).data.selectedParcelId, 'near');
});

test('stale teammate report remains a belief but cannot trigger a time-sensitive pickup', async () => {
  const w = world();
  w.send([], [{ x: 1, y: 0 }]); // removes the initially observed parcel
  assert.equal(w.beliefs.parcels.mergeShared([p('peer-old', 2, 55)], -2000, w.beliefs.now()), 1);
  const opp = parcelOpportunities(w.beliefs);
  assert.equal(opp.length, 1);
  assert.equal(opp[0].source, 'peer');
  assert.equal(opp[0].freshForAction, false);
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans });
  const res = await run(tools);
  assert.equal(res.ok, true);
  assert.equal(res.data.status, 'no_viable_target');
  assert.equal(w.events.some(e => e.action === 'pickup'), false);
});

test('teammate-claimed target is not selected even if reward is highest', async () => {
  const w = world();
  w.send([p('claimed', 1, 99), p('free', 2, 35)]);
  const coordination = { canTarget(id) { return id !== 'claimed'; }, async acquire() { return true; },
    release() {}, setIntention() {} };
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans, coordination });
  const result = await run(tools);
  assert.equal(result.ok, true);
  assert.equal(result.data.selectedParcelId, 'free');
});

test('pre-dispatch parcel disappearance during claim settlement triggers safe reselection', async () => {
  const w = world();
  w.send([p('target', 1, 75), p('backup', 2, 50)]);
  let first = true;
  const events = [];
  const coordination = { canTarget() { return true; }, async acquire(id) {
    if (first && id === 'target') {
      first = false;
      w.send([p('backup', 2, 50)], [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
    }
    return true;
  }, release() {}, setIntention() {} };
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans, coordination,
    log: (event, detail) => events.push({ event, ...detail }) });
  const result = await run(tools);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.selectedParcelId, 'backup');
  assert.ok(result.data.attempts.some(x => x.id === 'target'));
  assert.ok(events.some(e => e.event === 'llm_dynamic_reselected' && e.rejectedParcelId === 'target'));
  assert.equal(w.events.filter(e => e.action === 'pickup').length, 1);
});

test('a failed SDK-side pickup is NOT silently retried on another target', async () => {
  const w = world();
  w.send([p('one', 1, 70), p('two', 2, 50)]);
  const calls = [];
  const tools = createGameTools({ beliefs: w.beliefs, plans: { async execute(option) {
    calls.push(option);
    return { status: 'failed', reason: 'Target parcel not confirmed collected' };
  } } });
  const result = await run(tools);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'game_action_failed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'pickup');
});

test('unknown SDK action outcome is not retried', async () => {
  const w = world();
  let calls = 0;
  const tools = createGameTools({ beliefs: w.beliefs, plans: { async execute() {
    calls++;
    return { status: 'unknown', reason: 'SDK timeout' };
  } } });
  const result = await run(tools);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'outcome_unknown');
  assert.equal(calls, 1);
});

test('no fresh viable target returns an explicit non-delivery result, never false completion', async () => {
  const w = world();
  w.send([], [{ x: 1, y: 0 }]);
  const events = [];
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans,
    log: (event, detail) => events.push({ event, ...detail }) });
  const result = await run(tools);
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'no_viable_target');
  assert.match(result.data.nextAction, /Explore|wait/);
  assert.equal(w.events.length, 0);
  assert.ok(events.some(e => e.event === 'llm_dynamic_no_target'));
});

test('optional bounded exploration returns no target if nothing appears', async () => {
  const w = world();
  w.send([], [{ x: 1, y: 0 }]);
  const events = [];
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans,
    log: (event, detail) => events.push({ event, ...detail }) });
  const result = await tools.invoke({ name: 'collect_best_and_deliver', arguments: { strategy: 'nearest_viable' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'no_viable_target');
  assert.ok(events.some(e => e.event === 'llm_dynamic_explore'));
  assert.equal(w.events.filter(x => x.action === 'pickup').length, 0);
});

test('invalid strategy is rejected by the tool registry without moving', async () => {
  const w = world();
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans });
  const result = await run(tools, 'hallucinated_strategy');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_arguments');
  assert.deepEqual(w.events, []);
});

test('legacy exact-ID tool still reports preconditions distinctly without breaking its error code', async () => {
  const w = world();
  w.send([], [{ x: 1, y: 0 }]);
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans });
  const res = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'p' } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'game_action_failed');
  assert.equal(res.error.precondition, true);
  assert.equal(res.error.reason, 'missing_or_expired');
});

test('full LLM runtime selects the dynamic tool and verifies one genuine delivery', async () => {
  const w = world();
  const responses = [
    { content: JSON.stringify({ summary: 'Use dynamic parcel selection', steps: [{ tool: 'collect_best_and_deliver', reason: 'Fresh ID at execution' }] }) },
    { tool_calls: [{ function: { name: 'collect_best_and_deliver', arguments: { strategy: 'highest_expected_reward' } } }] },
    { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'Delivered parcel p' } } }] },
  ];
  let i = 0;
  const runtime = createGameRuntime({ beliefs: w.beliefs, client: w.client,
    provider: { async chat() { const next = responses[i++]; return { message: { role: 'assistant', content: next.content ?? '',
      ...(next.tool_calls ? { tool_calls: next.tool_calls } : {}) } }; } } });
  const result = await runtime.runObjective('Deliver 1 parcel');
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'verified');
  assert.equal(result.progress.deliveredCount, 1);
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(w.events.filter(x => x.action === 'pickup').length, 1);
  assert.equal(w.events.filter(x => x.action === 'putdown').length, 1);
});

test('exact-ID rejection provides fresh, structured alternatives to Qwen', async () => {
  const w = world();
  w.send([p('alternative', 2, 46)], [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
  const tools = createGameTools({ beliefs: w.beliefs, plans: w.plans });
  const result = await tools.invoke({ name: 'collect_and_deliver', arguments: { parcel_id: 'p' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.precondition, true);
  assert.deepEqual(result.error.alternatives.map(a => a.id), ['alternative']);
});

test('LLM game precondition rejection counts separately from an SDK action failure', async () => {
  const w = world();
  w.send([], [{ x: 1, y: 0 }]);
  const responses = [
    { content: JSON.stringify({ summary: 'Inspect', steps: [{ tool: 'collect_and_deliver', reason: 'Attempt ID' }] }) },
    { tool_calls: [{ function: { name: 'collect_and_deliver', arguments: { parcel_id: 'p' } } }] },
    { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'blocked', summary: 'No parcel yet' } } }] },
  ];
  let i = 0;
  const runtime = createGameRuntime({ beliefs: w.beliefs, client: w.client,
    provider: { async chat() { const reply = responses[i++]; return { message: { role: 'assistant', content: reply.content ?? '',
      ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } }; } } });
  const result = await runtime.runObjective('Deliver 1 parcel');
  assert.equal(result.status, 'blocked');
  assert.equal(result.metrics.preconditionRejections, 1);
  assert.equal(result.metrics.failedGameActions, 0);
  assert.equal(result.metrics.invalidToolCalls, 0);
  assert.equal(w.events.filter(e => e.action === 'pickup').length, 0);
});

test('model inference can outlive a parcel without the runtime chasing its stale ID', async () => {
  const w = world();
  let i = 0;
  const responses = [
    { content: JSON.stringify({ summary: 'Collect now', steps: [{ tool: 'collect_best_and_deliver', reason: 'Newest observation' }] }) },
    { tool_calls: [{ function: { name: 'collect_best_and_deliver', arguments: { strategy: 'highest_expected_reward' } } }] },
    { tool_calls: [{ function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'The real pickup and delivery succeeded' } } }] },
  ];
  const runtime = createGameRuntime({ beliefs: w.beliefs, client: w.client,
    provider: { async chat() {
      if (i === 1) {
        // The first plan and memory mention p, but p vanished during inference.
        w.send([p('spawned-now', 2, 70)], [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
      }
      const r = responses[i++];
      return { message: { role: 'assistant', content: r.content ?? '',
        ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) } };
    } } });
  const result = await runtime.runObjective('Deliver 1 parcel');
  assert.equal(result.status, 'completed');
  assert.equal(result.progress.deliveredCount, 1);
  assert.equal(w.events.filter(e => e.action === 'pickup').length, 1);
  assert.equal(w.beliefs.parcels.get('p', w.beliefs.now()), undefined);
});
