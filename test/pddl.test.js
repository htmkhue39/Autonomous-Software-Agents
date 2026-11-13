// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { buildNavigationProblem, decodeNavigationPlan } from '../src/planning/pddl/problem.js';
import { solveNavigation } from '../src/planning/pddl/solve.js';

const map = mapFromRows(['333']);
const from = { x: 0, y: 0 }, to = { x: 2, y: 0 }, opts = { now: 0 };
const route = [{ action: 'move_right', args: ['t0_0', 't1_0'] }, { action: 'move_right', args: ['t1_0', 't2_0'] }];

test('PDDL includes valid domain, current location, goal and adjacency', () => {
  const spec = buildNavigationProblem(map, from, to, opts);
  assert.match(spec.domain, /\(define \(domain deliveroo-navigation\)/);
  assert.match(spec.domain, /:action move_right/);
  assert.match(spec.problem, /\(at t0_0\)/);
  assert.match(spec.problem, /\(east t0_0 t1_0\)/);
  assert.match(spec.problem, /\(:goal \(at t2_0\)\)/);
});

test('decode rejects invalid edge, action, or goal', () => {
  assert.deepEqual(decodeNavigationPlan(route, map, from, to, opts), ['right', 'right']);
  assert.throws(() => decodeNavigationPlan([{ action: 'teleport' }], map, from, to, opts), /Unexpected PDDL action/);
  assert.throws(() => decodeNavigationPlan(route.slice(0, 1), map, from, to, opts), /does not achieve/);
  assert.throws(() => decodeNavigationPlan(route, map, from, to, { now: 0, occupied: new Set(['1,0']) }), /unavailable edge/);
});

test('external solver called and returned plan executed as a validated route', async () => {
  let calls = 0; const events = [];
  const got = await solveNavigation(map, from, to, opts, {
    solve: async (domain, problem) => { calls++; assert.ok(problem.includes('t2_0')); return route; },
    log: (type) => events.push(type),
  });
  assert.deepEqual(got, ['right', 'right']);
  assert.equal(calls, 1);
  assert.deepEqual(events, ['pddl_call', 'pddl_success']);
});

test('external solver timeout is reported and cannot masquerade as success', async () => {
  const events = [];
  await assert.rejects(solveNavigation(map, from, to, opts, {
    solve: async () => new Promise(() => {}), timeoutMs: 8,
    log: type => events.push(type),
  }), /timeout/);
  assert.deepEqual(events, ['pddl_call', 'pddl_failure']);
});
