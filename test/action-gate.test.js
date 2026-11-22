// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionGate } from '../src/plans/action-gate.js';

test('an unresolved SDK action times out but keeps its single-flight lock', async () => {
  const gate = new ActionGate({ timeoutMs: 10 });
  let resolve;
  const slow = gate.call('move', () => new Promise(r => { resolve = r; }));
  assert.equal((await slow).status, 'unknown');
  assert.equal(gate.busy, true);
  assert.deepEqual(await gate.call('move', async () => true), { status: 'busy' });
  resolve({ x: 1, y: 0 });
  await new Promise(setImmediate);
  assert.equal(gate.busy, false);
  assert.deepEqual(await gate.call('move', async () => false), { status: 'ok', value: false });
});

test('SDK transport rejection is not treated as a refused move', async () => {
  const gate = new ActionGate();
  const r = await gate.call('pickup', async () => { throw new Error('socket disconnected'); });
  assert.deepEqual(r, { status: 'unknown', reason: 'socket disconnected' });
  assert.equal(gate.busy, false);
});

test('the action deadline is never shorter than the game allows', () => {
  let minimum = 0;
  const gate = new ActionGate({ timeoutMs: 8000, minimumMs: () => minimum });
  assert.equal(gate.timeoutMs, 8000);
  minimum = 20_000;
  assert.equal(gate.timeoutMs, 20_000);
});
