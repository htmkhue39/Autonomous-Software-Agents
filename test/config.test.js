import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('with an empty environment every setting has its default', () => {
  assert.deepEqual(loadConfig({}), {
    host: 'http://localhost:8080',
    token: undefined,
    name: 'bubble',
    mover: 'astar',
    replaceMargin: 1.2,
    blockedTtlMs: 2000,
    maxBlockedMs: 30_000,
    agentTtlMs: 3000,
    maxMoveRetries: 3,
    pddlTimeoutMs: 5000,
    parcelHalfLifeMs: 20_000,
    minParcelChance: 0.2,
  });
});

test('AGENT picks the name and the matching TOKEN_<AGENT>', () => {
  const config = loadConfig({ AGENT: 'MilkTea', TOKEN_MILKTEA: 'abc', TOKEN_BUBBLE: 'xyz' });
  assert.equal(config.name, 'milktea');
  assert.equal(config.token, 'abc');
});

test('an empty token counts as no token', () => {
  assert.equal(loadConfig({ TOKEN_BUBBLE: '' }).token, undefined);
});

test('MOVER is pddl only when set to pddl', () => {
  assert.equal(loadConfig({ MOVER: 'pddl' }).mover, 'pddl');
  assert.equal(loadConfig({ MOVER: 'other' }).mover, 'astar');
});

test('tuning constants can be overridden from the environment', () => {
  const config = loadConfig({
    REPLACE_MARGIN: '1.5',
    BLOCKED_TTL_MS: '1000',
    MAX_BLOCKED_MS: '10000',
    AGENT_TTL_MS: '500',
    MAX_MOVE_RETRIES: '5',
    PDDL_TIMEOUT_MS: '2000',
    PARCEL_HALF_LIFE_MS: '8000',
    MIN_PARCEL_CHANCE: '0.5',
  });
  assert.equal(config.replaceMargin, 1.5);
  assert.equal(config.blockedTtlMs, 1000);
  assert.equal(config.maxBlockedMs, 10_000);
  assert.equal(config.agentTtlMs, 500);
  assert.equal(config.maxMoveRetries, 5);
  assert.equal(config.pddlTimeoutMs, 2000);
  assert.equal(config.parcelHalfLifeMs, 8000);
  assert.equal(config.minParcelChance, 0.5);
});

test('an empty tuning variable keeps the default', () => {
  assert.equal(loadConfig({ REPLACE_MARGIN: '' }).replaceMargin, 1.2);
});

test('a tuning variable that is not a positive number is rejected', () => {
  assert.throws(() => loadConfig({ BLOCKED_TTL_MS: 'abc' }), /BLOCKED_TTL_MS/);
  assert.throws(() => loadConfig({ AGENT_TTL_MS: '-1' }), /AGENT_TTL_MS/);
});
