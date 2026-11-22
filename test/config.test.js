import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('with an empty environment every setting has its default', () => {
  assert.deepEqual(loadConfig({}), {
    host: 'http://localhost:8080',
    token: undefined,
    name: 'bubble',
    mover: 'pddl',
    replaceMargin: 1.2,
    minCommitMs: 6000,
    failedGoalCooldownMs: 10_000,
    blockedTtlMs: 2000,
    maxBlockedMs: 30_000,
    agentTtlMs: 3000,
    maxMoveRetries: 3,
    congestionTimeoutMs: 3500,
    congestionRetryMs: 180,
    pddlTimeoutMs: 5000,
    actionTimeoutMs: 8000,
    optionStrategy: 'net_gain',
    minNetGain: 1,
    timeValuePerS: null,
    deliveryProtection: 0,
    taskPlanner: 'off',
    taskPlannerMaxParcels: 5,
    taskPlannerTimeoutMs: 10_000,
  });
});

test('TASK_PLANNER is off unless it is set to pddl, and its limits can be set', () => {
  assert.equal(loadConfig({ TASK_PLANNER: 'pddl' }).taskPlanner, 'pddl');
  assert.equal(loadConfig({ TASK_PLANNER: 'off' }).taskPlanner, 'off');
  assert.throws(() => loadConfig({ TASK_PLANNER: 'llm' }), /TASK_PLANNER/);
  const config = loadConfig({ TASK_PLANNER_MAX_PARCELS: '6', TASK_PLANNER_TIMEOUT_MS: '1500' });
  assert.equal(config.taskPlannerMaxParcels, 6);
  assert.equal(config.taskPlannerTimeoutMs, 1500);
});

test('AGENT picks the name and the matching TOKEN_<AGENT>', () => {
  const config = loadConfig({ AGENT: 'MilkTea', TOKEN_MILKTEA: 'abc', TOKEN_BUBBLE: 'xyz' });
  assert.equal(config.name, 'milktea');
  assert.equal(config.token, 'abc');
});

test('an empty token counts as no token', () => {
  assert.equal(loadConfig({ TOKEN_BUBBLE: '' }).token, undefined);
});

test('MOVER is pddl unless it is set to astar', () => {
  assert.equal(loadConfig({ MOVER: 'pddl' }).mover, 'pddl');
  assert.equal(loadConfig({ MOVER: 'other' }).mover, 'pddl');
  assert.equal(loadConfig({ MOVER: 'astar' }).mover, 'astar');
});

test('OPTION_STRATEGY and MIN_NET_GAIN are read and checked', () => {
  assert.equal(loadConfig({ OPTION_STRATEGY: 'baseline' }).optionStrategy, 'baseline');
  assert.equal(loadConfig({ OPTION_STRATEGY: 'net_gain' }).optionStrategy, 'net_gain');
  assert.throws(() => loadConfig({ OPTION_STRATEGY: 'greedy' }), /OPTION_STRATEGY/);
  assert.equal(loadConfig({ MIN_NET_GAIN: '2' }).minNetGain, 2);
  assert.throws(() => loadConfig({ MIN_NET_GAIN: '0' }), /MIN_NET_GAIN/);
});

test('DELIVERY_PROTECTION is a number of 0 or more', () => {
  assert.equal(loadConfig({ DELIVERY_PROTECTION: '0.5' }).deliveryProtection, 0.5);
  assert.throws(() => loadConfig({ DELIVERY_PROTECTION: '-1' }), /DELIVERY_PROTECTION/);
});

test('TIME_VALUE is learned unless a fixed value is given', () => {
  assert.equal(loadConfig({}).timeValuePerS, null);
  assert.equal(loadConfig({ TIME_VALUE: 'auto' }).timeValuePerS, null);
  assert.equal(loadConfig({ TIME_VALUE: '0' }).timeValuePerS, 0);
  assert.equal(loadConfig({ TIME_VALUE: '12.5' }).timeValuePerS, 12.5);
  assert.throws(() => loadConfig({ TIME_VALUE: '-1' }), /TIME_VALUE/);
  assert.throws(() => loadConfig({ TIME_VALUE: 'fast' }), /TIME_VALUE/);
});

test('tuning constants can be overridden from the environment', () => {
  const config = loadConfig({
    REPLACE_MARGIN: '1.5',
    BLOCKED_TTL_MS: '1000',
    MAX_BLOCKED_MS: '10000',
    AGENT_TTL_MS: '500',
    MAX_MOVE_RETRIES: '5',
    PDDL_TIMEOUT_MS: '2000',
  });
  assert.equal(config.replaceMargin, 1.5);
  assert.equal(config.blockedTtlMs, 1000);
  assert.equal(config.maxBlockedMs, 10_000);
  assert.equal(config.agentTtlMs, 500);
  assert.equal(config.maxMoveRetries, 5);
  assert.equal(config.pddlTimeoutMs, 2000);
});

test('an empty tuning variable keeps the default', () => {
  assert.equal(loadConfig({ REPLACE_MARGIN: '' }).replaceMargin, 1.2);
});

test('a tuning variable that is not a positive number is rejected', () => {
  assert.throws(() => loadConfig({ BLOCKED_TTL_MS: 'abc' }), /BLOCKED_TTL_MS/);
  assert.throws(() => loadConfig({ AGENT_TTL_MS: '-1' }), /AGENT_TTL_MS/);
});
