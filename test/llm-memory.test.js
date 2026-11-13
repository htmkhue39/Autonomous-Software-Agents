// @ts-nocheck -- deterministic test fixtures; production source remains strictly checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkingMemory } from '../src/llm/memory.js';

test('memory replaces objectives, versions and clears previous tool history', () => {
  const m = new WorkingMemory();
  m.setObjective('Collect parcel p1');
  m.setPlan({ summary: 'do it', steps: [{ tool: 'read_demo_parcels', reason: 'see parcels' }] });
  m.record('tool_result', { ok: true });
  m.setObjective('Explore nearby tiles');
  assert.equal(m.snapshot().objectiveVersion, 2);
  assert.equal(m.snapshot().objective, 'Explore nearby tiles');
  assert.equal(m.snapshot().plan, null);
  assert.deepEqual(m.snapshot().events, []);
});
test('memory caps event history and discards stale observations from context', () => {
  let time = 1000;
  const m = new WorkingMemory({ now: () => time, maxEvents: 2, observationTtlMs: 500 });
  m.setObjective('Collect parcels');
  m.updateObservation({ self: { x: 2 }, parcels: [{ id: 'p1' }] });
  m.record('one', 1); m.record('two', 2); m.record('three', 3);
  assert.deepEqual(m.snapshot().events.map(e => e.kind), ['two', 'three']);
  assert.equal(m.snapshot().observation.self.x, 2);
  time = 1800;
  assert.equal(m.snapshot().observation, null);
  assert.equal(m.snapshot().observationAgeMs, 800);
});
test('memory copies observations and bounds oversized data', () => {
  const m = new WorkingMemory({ maxTextLength: 50 });
  m.setObjective('demo');
  const obs = { self: { x: 1 } };
  m.updateObservation(obs);
  obs.self.x = 10;
  assert.equal(m.snapshot().observation.self.x, 1);
  m.record('big', 'x'.repeat(1000));
  assert.equal(m.snapshot().events[0].details.truncated, true);
});
