import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayTicks } from '../src/deliberation/utility.js';


test('decay ticks fall on whole multiples of the decay interval of the game clock', () => {
  assert.equal(decayTicks(0, 999, 1000), 0);
  assert.equal(decayTicks(900, 1100, 1000), 1);   // a short wait across a tick
  assert.equal(decayTicks(100, 1050, 1000), 1);
  assert.equal(decayTicks(1000, 2999, 1000), 1);
  assert.equal(decayTicks(0, 1e9, Infinity), 0);
});

test('decay ticks reject timing that makes no sense', () => {
  assert.equal(decayTicks(1000, 1999, 1000), 0);
  assert.equal(decayTicks(1000, 2000, 1000), 1);
  assert.equal(decayTicks(2000, 1000, 1000), 0);
  assert.throws(() => decayTicks(0, 1000, 0), RangeError);
  assert.throws(() => decayTicks(0, 1000, -5), RangeError);
  assert.throws(() => decayTicks(0, 1000, NaN), RangeError);
  assert.throws(() => decayTicks(NaN, 1000, 1000), RangeError);
});

