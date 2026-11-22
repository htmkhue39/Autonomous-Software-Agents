import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EarningRate, priorEarningRate } from '../src/deliberation/rate.js';

test('the prior rate is one average parcel per trip across the map', () => {
  // 30 points for (20 + 10) moves of 50 ms: 30 points in 1500 ms.
  assert.equal(priorEarningRate({ rewardAvg: 30, width: 20, height: 10, moveMs: 50 }), 30 / 1500);
});

test('the earning rate starts at the prior and follows the points earned', () => {
  const rate = new EarningRate({ priorRate: 0.01, priorMs: 10_000, windowMs: 60_000 });
  assert.equal(rate.rate(0), 0.01);
  // After 10 s with nothing earned the rate halves: 100 prior points over 20 s.
  assert.equal(rate.rate(10_000), 100 / 20_000);
  rate.record(300, 10_000);
  assert.equal(rate.rate(10_000), 400 / 20_000);
});

test('points older than the window stop counting, and the rate never reaches zero', () => {
  const rate = new EarningRate({ priorRate: 0.01, priorMs: 10_000, windowMs: 60_000 });
  rate.record(300, 1_000);
  assert.equal(rate.rate(100_000), 100 / 70_000);
  assert.ok(rate.rate(10_000_000) > 0);
});

test('earning at the prior rate keeps the rate, and idle time lowers it', () => {
  const rate = new EarningRate({ priorRate: 0.001, priorMs: 30_000, windowMs: 120_000, startedAt: 0 });
  assert.equal(rate.rate(0), 0.001);
  rate.record(30, 30_000);
  assert.equal(rate.rate(30_000), 0.001);
  assert.ok(rate.rate(120_000) < 0.001);
});

test('earning rate settings that make no sense are rejected', () => {
  assert.throws(() => new EarningRate({ priorRate: -1 }), RangeError);
  assert.throws(() => new EarningRate({ priorRate: NaN }), RangeError);
  assert.throws(() => new EarningRate({ priorRate: 0.01, priorMs: 0 }), RangeError);
  assert.throws(() => new EarningRate({ priorRate: 0.01, windowMs: 0 }), RangeError);
  assert.throws(() => new EarningRate({ priorRate: 0.01, startedAt: NaN }), RangeError);
  assert.equal(new EarningRate({ priorRate: 0 }).rate(1000), 0);
});

test('the first guess is never faster than parcels appear', () => {
  // A 10 x 10 map with 50 ms moves suggests 30 points per second, but one
  // parcel of 30 every 2 s allows only 15.
  const rate = priorEarningRate({ rewardAvg: 30, width: 10, height: 10, moveMs: 50, generationMs: 2000 });
  assert.equal(rate * 1000, 15);
  assert.equal(priorEarningRate({ rewardAvg: 30, width: 10, height: 10, moveMs: 50 }) * 1000, 30);
});
