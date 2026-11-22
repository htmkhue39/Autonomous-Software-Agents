import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayTicks, expectedReward, expectedRewardAtTime } from '../src/deliberation/utility.js';

// 200 ms per move and one point lost per second: a point every 5 moves.
const TIMING = { moveMs: 200, decayMs: 1000 };

test('every parcel loses value for the whole trip', () => {
  // 10 moves take 2 s, so each parcel loses 2.
  assert.equal(expectedReward([10, 20], 10, TIMING), 8 + 18);
});

test('only whole decay intervals count', () => {
  assert.equal(expectedReward([10], 4, TIMING), 10);
  assert.equal(expectedReward([10], 5, TIMING), 9);
});

test('a parcel never counts below zero', () => {
  assert.equal(expectedReward([1, 10], 10, TIMING), 0 + 8);
});

test('nothing is lost when parcels do not decay', () => {
  assert.equal(expectedReward([10], 1000, { moveMs: 200, decayMs: Infinity }), 10);
});

test('a trip with no parcels is worth nothing', () => {
  assert.equal(expectedReward([], 3, TIMING), 0);
});

test('decay ticks fall on whole multiples of the decay interval of the game clock', () => {
  assert.equal(decayTicks(0, 999, 1000), 0);
  assert.equal(decayTicks(900, 1100, 1000), 1);   // a short wait across a tick
  assert.equal(decayTicks(100, 1050, 1000), 1);
  assert.equal(decayTicks(1000, 2999, 1000), 1);
  assert.equal(decayTicks(0, 1e9, Infinity), 0);
});

test('a trip counts the decay ticks from the game time it starts at', () => {
  // 2 moves of 100 ms: from 0 no tick is crossed, from 900 the tick at 1000 is.
  assert.equal(expectedReward([10], 2, { moveMs: 100, decayMs: 1000 }, 0), 10);
  assert.equal(expectedReward([10], 2, { moveMs: 100, decayMs: 1000 }, 900), 9);
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

test('a reward can be predicted from a trip duration instead of a move count', () => {
  assert.equal(expectedRewardAtTime([10, 20], 1100, 1000, 0), 28);
  assert.equal(expectedRewardAtTime([10], 0, 1000, 999), 10);
  assert.throws(() => expectedRewardAtTime([10], -1, 1000), RangeError);
});
