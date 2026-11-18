// @ts-nocheck -- deterministic test fixtures; production source remains strictly checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanActLoop } from '../src/llm/agent.js';
import { WorkingMemory } from '../src/llm/memory.js';
import { createDemoTools } from '../src/llm/tools/demo.js';

const plan = (tool = 'read_demo_parcels') => ({ message: { role: 'assistant', content: JSON.stringify({ summary: 'Inspect before reporting', steps: [{ tool, reason: 'verify' }] }) } });
const call = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name, arguments: args } }] } });
const answer = (payload) => ({ message: { role: 'assistant', content: JSON.stringify(payload) } });

function fixture(responses, options = {}) {
  let count = 0;
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(request);
      if (count >= responses.length) throw Error('Unexpected extra model call');
      return responses[count++];
    },
  };
  const memory = new WorkingMemory();
  const tools = createDemoTools();
  const loop = new PlanActLoop({ provider, memory, tools, maxSteps: 6,
    verifyCompletion: () => true, ...options });
  return { loop, memory, requests };
}

test('native tool loop plans, executes an allowlisted tool, updates memory, then verifies completion', async () => {
  const f = fixture([plan(), call('read_demo_parcels', {}), call('finish_objective', { status: 'completed', summary: '2 toy parcels observed' })]);
  const result = await f.loop.run('Count toy parcels', { observation: { timestamp: 3 } });
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.successfulTools, 1);
  assert.equal(f.requests[0].format.type, 'object');
  assert.ok(f.requests[1].tools.some(t => t.function.name === 'read_demo_parcels'));
  assert.ok(f.memory.snapshot().events.some(e => e.kind === 'tool_result'));
});
test('unknown native tools are rejected; model can replan using failure feedback', async () => {
  const f = fixture([plan(), call('execute_shell', { command: 'pwd' }), call('read_demo_parcels', {}), call('finish_objective', { status: 'completed', summary: 'Count read' })]);
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.invalidTools, 1);
  assert.equal(result.metrics.replans, 1);
  assert.ok(f.memory.snapshot().events.some(e => e.kind === 'tool_result' && e.details.error?.code === 'unknown_tool'));
});
test('invalid plans do not execute any tools', async () => {
  const f = fixture([plan('not_registered'), answer({ summary: 'bad', steps: [] })]);
  const result = await f.loop.run('Do something');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'invalid_plan');
  assert.equal(result.metrics.toolCalls, 0);
  assert.equal(result.metrics.llmCalls, 2);
});
test('plain chat answer without a real tool call never counts as completion', async () => {
  const f = fixture([plan(), { message: { role: 'assistant', content: 'Done.' } },
    { message: { role: 'assistant', content: 'Still done.' } }]);
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'stalled');
  assert.equal(result.metrics.toolCalls, 0);
  assert.equal(result.metrics.llmCalls, 3);
});
test('premature completed status is rejected until a real tool executes', async () => {
  const f = fixture([plan(), call('finish_objective', { status: 'completed', summary: 'done' }), call('read_demo_parcels', {}), call('finish_objective', { status: 'completed', summary: 'done' })]);
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.invalidTools, 1);
});
test('model reported completion is not falsely labelled verified without a verifier', async () => {
  const f = fixture([plan(), call('read_demo_parcels', {}), call('finish_objective', { status: 'completed', summary: 'done' })], { verifyCompletion: undefined });
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'reported_completed');
});
test('JSON fallback still validates tool arguments before dispatch', async () => {
  const f = fixture([plan(),
    answer({ action: 'tool', tool: 'read_demo_parcels', arguments: { madeUp: 1 }, status: 'blocked', summary: '' }),
    answer({ action: 'tool', tool: 'read_demo_parcels', arguments: {}, status: 'blocked', summary: '' }),
    answer({ action: 'finish', tool: '', arguments: {}, status: 'completed', summary: 'Observed 2 parcels' }),
  ], { mode: 'json' });
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.invalidTools, 1);
  assert.equal(result.metrics.successfulTools, 1);
  assert.ok(f.requests[1].format);
});
test('bounded tool loop terminates when the model continues calling tools', async () => {
  const f = fixture([plan(), call('read_demo_parcels', {}), call('read_demo_parcels', {})], { maxSteps: 2 });
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'limit_reached');
  assert.equal(result.reason, 'max_steps');
});
test('objective replacement cancels an unfinished model call', async () => {
  let started;
  const before = new Promise(resolve => { started = resolve; });
  const f = fixture([], { provider: {
    async chat({ signal }) {
      started();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    },
  } });
  const running = f.loop.run('Old objective');
  await before;
  f.loop.replaceObjective('New objective');
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(f.memory.snapshot().objective, 'New objective');
});
test('failed completion verifier requires re-evaluation', async () => {
  let verifies = 0;
  const f = fixture([plan(), call('read_demo_parcels', {}), call('finish_objective', { status: 'completed', summary: 'maybe' }),
    call('finish_objective', { status: 'completed', summary: 'yes' })], {
    verifyCompletion: () => ++verifies >= 2,
  });
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.replans, 1);
});

// Stage 2B.1: Qwen sometimes writes a narrative after a lost parcel. A single
// corrective turn must be allowed without accepting prose as verification.
test('native narrative after a tool failure gets a bounded recovery nudge', async () => {
  const f = fixture([plan(), call('read_demo_parcels', {}),
    { message: { role: 'assistant', content: 'I need to find another parcel.' } },
    call('read_demo_parcels', {}),
    call('finish_objective', { status: 'completed', summary: 'Observed real tools' })]);
  const result = await f.loop.run('Count toy parcels');
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.toolCalls, 2);
  assert.equal(result.metrics.llmCalls, 5);
  assert.ok(f.requests[3].messages.some(m => /NOT been verified/.test(m.content ?? '')));
});

test('tool failures include diagnostic error message and refreshed observation', async () => {
  let observed = 0; const messages = [];
  const f = fixture([plan(), call('execute_shell', { command: 'pwd' }),
    call('read_demo_parcels', {}), call('finish_objective', { status: 'completed', summary: 'done' })],
    { observe: () => { observed++; return { observed }; }, log: (name, details) => messages.push({ name, details }) });
  const result = await f.loop.run('Recover');
  assert.equal(result.status, 'completed');
  assert.ok(observed >= 2);
  assert.ok(messages.some(e => e.name === 'llm_tool_result' && e.details.errorMessage?.includes('Tool not allowed')));
});
