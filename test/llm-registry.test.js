// @ts-nocheck -- deterministic test fixtures; production source remains strictly checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/llm/tools/registry.js';

function fixture() {
  const registry = new ToolRegistry(); let counter = 0;
  registry.register({ name: 'increment', description: 'Increment a demo counter',
    parameters: { type: 'object', additionalProperties: false, required: ['amount'],
      properties: { amount: { type: 'integer', minimum: 1, maximum: 5 } } },
    execute: ({ amount }) => { counter += amount; return { counter }; },
  });
  return { registry, getCount: () => counter };
}

test('tool registry exposes Ollama function schemas and executes allowed tool', async () => {
  const { registry, getCount } = fixture();
  const specs = registry.getSpecs();
  assert.equal(specs[0].function.name, 'increment');
  specs[0].function.name = 'tampered';
  assert.equal(registry.getSpecs()[0].function.name, 'increment');
  assert.deepEqual(await registry.invoke({ name: 'increment', arguments: '{"amount":2}' }), { ok: true, data: { counter: 2 } });
  assert.equal(getCount(), 2);
});
test('invalid, unknown and prototype-related tool names cannot execute', async () => {
  const { registry, getCount } = fixture();
  assert.equal((await registry.invoke({ name: 'constructor', arguments: {} })).error.code, 'unknown_tool');
  assert.equal((await registry.invoke({ name: 'increment', arguments: { amount: 2, surprise: true } })).error.code, 'invalid_arguments');
  assert.equal((await registry.invoke({ name: 'increment', arguments: { amount: '3' } })).error.code, 'invalid_arguments');
  assert.equal((await registry.invoke({ name: 'increment', arguments: '{broken' })).error.code, 'invalid_arguments');
  assert.equal(getCount(), 0);
});
test('duplicate and unsupported tool schemas are rejected', () => {
  const { registry } = fixture();
  assert.throws(() => registry.register({ name: 'increment', description: 'dup', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => {} }));
  assert.throws(() => registry.register({ name: 'finish_objective', description: 'reserved', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => {} }));
  assert.throws(() => registry.register({ name: 'unsafe', description: 'unsafe', parameters: { type: 'object', properties: {}, additionalProperties: true }, execute: () => {} }));
});
test('tool failure returns a recoverable result, and cancellation prevents dispatch', async () => {
  const { registry, getCount } = fixture();
  const controller = new AbortController(); controller.abort();
  assert.equal((await registry.invoke({ name: 'increment', arguments: { amount: 1 } }, { signal: controller.signal })).error.code, 'cancelled');
  assert.equal(getCount(), 0);
  registry.register({ name: 'broken', description: 'throw', parameters: { type: 'object', additionalProperties: false, properties: {} }, execute: () => { throw Error('not available'); } });
  assert.equal((await registry.invoke({ name: 'broken', arguments: {} })).error.code, 'tool_error');
});
test('slow in-flight tool times out with unknown outcome rather than a false refusal', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'slow', description: 'Simulate a non-cooperative in-flight tool',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: () => new Promise(() => {}),
  });
  const result = await registry.invoke({ name: 'slow', arguments: {} }, { timeoutMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'outcome_unknown');
});
