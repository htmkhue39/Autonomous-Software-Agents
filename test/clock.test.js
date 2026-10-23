import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameClock } from '../src/beliefs/clock.js';

/** A game clock driven by a local clock the test controls. */
function makeClock() {
  const local = { t: 0 };
  return { clock: new GameClock(() => local.t), local };
}

test('game time is the frame times the milliseconds per frame', () => {
  const { clock } = makeClock();
  clock.setFrameMs(50);
  clock.onFrame(3000);
  assert.equal(clock.now(), 150_000);
});

test('game time moves on with the local clock between frames', () => {
  const { clock, local } = makeClock();
  clock.setFrameMs(50);
  local.t = 1_000_000;
  clock.onFrame(3000);
  local.t = 1_000_400;
  assert.equal(clock.now(), 150_400);
});

test('each new frame corrects the game time, even backwards', () => {
  const { clock, local } = makeClock();
  clock.setFrameMs(50);
  clock.onFrame(3000);
  local.t = 2000;                 // the local clock ran ahead of a slow server
  clock.onFrame(3020);            // the server only moved on 1 s
  assert.equal(clock.now(), 151_000);
});

test('before any frame the local clock is used', () => {
  const { clock, local } = makeClock();
  local.t = 1234;
  assert.equal(clock.now(), 1234);
  clock.onFrame(10);              // no frame length known yet
  assert.equal(clock.now(), 1234);
});
