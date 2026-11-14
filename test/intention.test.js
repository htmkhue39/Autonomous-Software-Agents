import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Intention } from '../src/intentions/intention.js';

/**
 * @typedef {import('../src/types.js').Option} Option
 * @typedef {import('../src/plans/library.js').Plan} Plan
 */

/** @type {Option} */
const pickup = { id: 'pickup:p', type: 'pickup', x: 1, y: 0, utility: 10, priority: 0, parcelId: 'p' };

/** @param {Partial<Record<Option['type'], Plan>>} plans */
const library = plans => /** @type {Record<Option['type'], Plan>} */ (plans);

test('an intention runs the plan for its kind of option', async () => {
  /** @type {Option[]} */
  const ran = [];
  const intention = new Intention(pickup, library({
    async pickup(option) { ran.push(option); return true; },
    async explore() { throw new Error('wrong plan'); },
  }));
  assert.equal(await intention.achieve(), true);
  assert.deepEqual(ran, [pickup]);
  assert.equal(intention.failure, undefined);
});

test('an intention fails when no plan fits', async () => {
  const intention = new Intention(pickup, library({}));
  assert.equal(await intention.achieve(), false);
  assert.match(String(intention.failure), /no plan/);
});

test('an intention fails when its plan crashes', async () => {
  const intention = new Intention(pickup, library({ async pickup() { throw new Error('boom'); } }));
  assert.equal(await intention.achieve(), false);
  assert.match(String(intention.failure), /boom/);
});

test('an intention fails when its plan does not achieve the option', async () => {
  const intention = new Intention(pickup, library({ async pickup() { return false; } }));
  assert.equal(await intention.achieve(), false);
  assert.match(String(intention.failure), /not achieved/);
});

test('a running plan notices that its intention was stopped', async () => {
  let steps = 0;
  const intention = new Intention(pickup, library({
    async pickup(_option, signal) {
      while (!signal.stopped) {
        steps++;
        await new Promise(resolve => setImmediate(resolve));
      }
      return false;
    },
  }));
  const running = intention.achieve();
  await new Promise(resolve => setImmediate(resolve));
  intention.stop();
  assert.equal(await running, false);
  assert.equal(intention.stopped, true);
  assert.ok(steps >= 1);
});
