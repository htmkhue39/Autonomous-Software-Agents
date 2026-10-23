import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedReward } from '../src/deliberation/utility.js';

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
