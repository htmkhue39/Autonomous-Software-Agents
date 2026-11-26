// @ts-nocheck -- the solver is a fake that answers by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { buildProblem } from '../src/planning/pddl/problem.js';
import { PlannerService } from '../src/planning/pddl/service.js';

const spec = buildProblem({ map: mapFromRows(['23']), from: { x: 1, y: 0 }, paths: { now: 0 }, carried: 0,
  goal: { kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } } });
const good = [{ action: 'pickup', args: ['target', 't1_0'] }, { action: 'move-left', args: ['t1_0', 't0_0'] },
  { action: 'putdown', args: ['target', 't0_0'] }];
const wrong = [{ action: 'teleport', args: [] }];

/** A service on a fake clock whose solver answers from `answers`, one per call. */
function setup(answers, settings = {}) {
  const clock = { t: 0 };
  const events = [];
  let calls = 0;
  const solve = async () => {
    const answer = answers[Math.min(calls++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  };
  const service = new PlannerService({ solve, now: () => clock.t, log: (event, data) => events.push({ event, ...data }), ...settings });
  return { service, clock, events, calls: () => calls, names: () => events.map(e => e.event) };
}

test('a good plan is returned and logged as pddl_call then pddl_success', async () => {
  const { service, names, events } = setup([good]);
  const result = await service.plan(spec);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.plan.steps.map(s => s.action), ['pickup', 'move', 'putdown']);
  assert.deepEqual(names(), ['pddl_call', 'pddl_success']);
  assert.equal(events[1].actions, 3);
  assert.equal(typeof events[1].durationMs, 'number');
});

test('a timeout fails and is logged as pddl_failure', async () => {
  const { service, names, events } = setup([() => new Promise(() => {})], { timeoutMs: 10 });
  const result = await service.plan(spec);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /timeout/i);
  assert.deepEqual(names(), ['pddl_call', 'pddl_failure']);
  assert.match(events[1].reason, /timeout/i);
});

test('a plan that fails the check counts as a failure', async () => {
  const { service } = setup([wrong]);
  const result = await service.plan(spec);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Unknown PDDL action/);
});

test('three failures in a row open the breaker and later calls are skipped', async () => {
  const { service, names, events, calls } = setup([new Error('network down')]);
  for (let i = 0; i < 3; i++) assert.equal((await service.plan(spec)).status, 'failed');
  assert.equal(service.breaker, 'open');
  assert.ok(names().includes('pddl_breaker_open'));
  const skipped = await service.plan(spec);
  assert.equal(skipped.status, 'skipped');
  assert.equal(calls(), 3);
  const fallback = events.at(-1);
  assert.equal(fallback.event, 'planner_fallback');
  assert.equal(fallback.reason, 'circuit breaker open');
});

test('after the cooldown one call goes through; success closes the breaker', async () => {
  const { service, clock, names } = setup([new Error('down'), new Error('down'), new Error('down'), good]);
  for (let i = 0; i < 3; i++) await service.plan(spec);
  clock.t += 60_000;
  assert.equal(service.breaker, 'half-open');
  const result = await service.plan(spec);
  assert.equal(result.status, 'ok');
  assert.equal(service.breaker, 'closed');
  assert.ok(names().includes('pddl_breaker_half_open'));
  assert.equal(names().at(-1), 'pddl_breaker_closed');
});

test('a failed trial call opens the breaker again', async () => {
  const { service, clock, names } = setup([new Error('down')]);
  for (let i = 0; i < 3; i++) await service.plan(spec);
  clock.t += 60_000;
  assert.equal((await service.plan(spec)).status, 'failed');
  assert.equal(service.breaker, 'open');
  assert.equal(names().filter(n => n === 'pddl_breaker_open').length, 2);
  clock.t += 59_999;
  assert.equal((await service.plan(spec)).status, 'skipped');
});

test('while the trial call is running, other calls are skipped', async () => {
  let release;
  const slow = () => new Promise(resolve => { release = () => resolve(good); });
  const { service, clock, calls } = setup([new Error('down'), new Error('down'), new Error('down'), slow]);
  for (let i = 0; i < 3; i++) await service.plan(spec);
  clock.t += 60_000;
  const trial = service.plan(spec);
  const other = await service.plan(spec);
  assert.equal(other.status, 'skipped');
  assert.equal(calls(), 4);
  release();
  assert.equal((await trial).status, 'ok');
});

test('a success resets the count of failures', async () => {
  const down = new Error('down');
  const { service } = setup([down, down, good, down, down]);
  for (let i = 0; i < 5; i++) await service.plan(spec);
  assert.equal(service.breaker, 'closed');
});

test('no more than maxConcurrent solver calls run at once; more are skipped', async () => {
  const waiting = [];
  const { service, calls, events } = setup([() => new Promise(resolve => waiting.push(() => resolve(good)))], { maxConcurrent: 2 });
  const first = service.plan(spec);
  const second = service.plan(spec);
  const third = await service.plan(spec);
  assert.equal(third.status, 'skipped');
  assert.equal(calls(), 2);
  assert.equal(events.at(-1).reason, 'solver busy');
  waiting.forEach(release => release());
  assert.equal((await first).status, 'ok');
  assert.equal((await second).status, 'ok');
});

test('a timed-out call keeps its place until its request settles', async () => {
  let release;
  const { service, calls } = setup([() => new Promise(resolve => { release = () => resolve(good); }), good],
    { maxConcurrent: 1, timeoutMs: 10 });
  assert.equal((await service.plan(spec)).status, 'failed');
  // The request still polls the solver in the background: a new one must not start.
  assert.equal((await service.plan(spec)).status, 'skipped');
  assert.equal(calls(), 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.plan(spec)).status, 'ok');
});

test('a request that never settles gives its place back after zombieMs', async () => {
  const { service, calls } = setup([() => new Promise(() => {}), good], { maxConcurrent: 1, timeoutMs: 5, zombieMs: 30 });
  assert.equal((await service.plan(spec)).status, 'failed');
  assert.equal((await service.plan(spec)).status, 'skipped');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await service.plan(spec)).status, 'ok');
  assert.equal(calls(), 2);
});
