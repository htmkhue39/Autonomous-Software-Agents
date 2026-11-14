import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGame, readyBeliefs } from './helpers.js';
import { IntentionRevision, shouldSwitch } from '../src/intentions/revision.js';
import { planLibrary } from '../src/plans/library.js';
import { astarRoute } from '../src/planning/astar.js';

/**
 * @typedef {import('../src/types.js').Option} Option
 * @typedef {import('../src/types.js').Parcel} Parcel
 * @typedef {import('../src/intentions/revision.js').RevisionEvent} RevisionEvent
 */

/**
 * @param {string} id
 * @param {number} utility
 * @param {0 | 1} [priority]
 * @returns {Option}
 */
function option(id, utility, priority = 0) {
  return { id, type: 'explore', x: 0, y: 0, utility, priority };
}

// ---------------------------------------------------------------------------
// The switching rule, one rule at a time
// ---------------------------------------------------------------------------

test('never switch without a better option', () => {
  assert.equal(shouldSwitch(option('a', 10), undefined, 1.2), false);
});

test('always switch when idle', () => {
  assert.equal(shouldSwitch(undefined, option('a', 0), 1.2), true);
});

test('never switch to the same option', () => {
  assert.equal(shouldSwitch(option('a', 10), option('a', 100), 1.2), false);
});

test('always switch to a higher priority', () => {
  assert.equal(shouldSwitch(option('a', 100), option('goal', 0, 1), 1.2), true);
});

test('never switch to a lower priority', () => {
  assert.equal(shouldSwitch(option('goal', 0, 1), option('a', 100), 1.2), false);
});

test('switch only when the new option beats the current one by the margin', () => {
  assert.equal(shouldSwitch(option('a', 10), option('b', 12), 1.2), false);
  assert.equal(shouldSwitch(option('a', 10), option('b', 12.5), 1.2), true);
});

test('switch only when the new option is worth at least one point more', () => {
  assert.equal(shouldSwitch(option('a', 0), option('b', 0), 1.2), false);
  assert.equal(shouldSwitch(option('a', 0), option('b', 0.5), 1.2), false);
  assert.equal(shouldSwitch(option('a', 2), option('b', 2.9), 1.2), false);
  assert.equal(shouldSwitch(option('a', 2), option('b', 3), 1.2), true);
});

// ---------------------------------------------------------------------------
// The loop, against a fake game
// ---------------------------------------------------------------------------

/**
 * Sets up the agent loop against a fake game, on a map drawn as rows, with
 * the agent at `me`. Every event the loop reports is saved in `events`.
 * @param {string[]} rows
 * @param {{ x: number, y: number }} me
 * @param {Parameters<typeof fakeGame>[1]} [setup]
 */
function agentLoop(rows, me, setup) {
  const { beliefs, clock } = readyBeliefs(rows, me);
  const game = fakeGame(beliefs, setup);
  const plans = planLibrary({ beliefs, client: game.client, planRoute: astarRoute, maxFailures: 3 });
  /** @type {RevisionEvent[]} */
  const events = [];
  const loop = new IntentionRevision({ beliefs, plans, margin: 1.2, idleMs: 5, onEvent: e => events.push(e) });
  /** @param {RevisionEvent['kind']} kind @param {string} id */
  const happened = (kind, id) => events.some(e => e.kind === kind && e.option.id === id);
  return { beliefs, clock, game, loop, events, happened };
}

/**
 * @param {import('../src/beliefs/index.js').Beliefs} beliefs
 * @param {Parcel[]} parcels
 * @param {import('../src/types.js').Position[]} [positions]
 */
function see(beliefs, parcels, positions = []) {
  beliefs.onSensing({ positions, agents: [], parcels, crates: [] });
}

/**
 * Runs the loop until `done()` returns true, then stops it. Fails the test
 * if that never happens.
 * @param {IntentionRevision} loop
 * @param {() => boolean} done
 */
async function runUntil(loop, done) {
  const running = loop.run();
  for (let i = 0; i < 1000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  loop.halt();
  await running;
  assert.ok(done(), 'the loop never got there');
}

test('the loop waits for the beliefs, then commits to the best option and carries it out', async () => {
  const { game, loop, happened } = agentLoop(['2333333'], { x: 6, y: 0 }, { parcelsAt: { '3,0': ['p'] } });
  see(loop.beliefs, [{ id: 'p', x: 3, y: 0, reward: 30, carriedBy: null }]);
  await runUntil(loop, () => game.delivered.includes('p'));
  assert.ok(happened('commit', 'pickup:p'));
  assert.ok(happened('done', 'pickup:p'));
  assert.ok(happened('done', 'deliver'));
});

test('the loop does nothing before the beliefs are ready', async () => {
  const { Beliefs } = await import('../src/beliefs/index.js');
  const beliefs = new Beliefs({ agentTtlMs: 3000, blockedTtlMs: 2000 });
  /** @type {RevisionEvent[]} */
  const events = [];
  const loop = new IntentionRevision({ beliefs, plans: /** @type {any} */ ({}), margin: 1.2, idleMs: 1, onEvent: e => events.push(e) });
  const running = loop.run();
  await new Promise(resolve => setTimeout(resolve, 20));
  loop.halt();
  await running;
  assert.deepEqual(events, []);
});

test('a pickup is stopped as soon as another agent takes its parcel', async () => {
  const { game, loop, happened } = agentLoop(['2333333'], { x: 6, y: 0 });
  see(loop.beliefs, [{ id: 'p', x: 1, y: 0, reward: 30, carriedBy: null }]);
  game.onMove = () => see(loop.beliefs, [{ id: 'p', x: 1, y: 0, reward: 30, carriedBy: 'other' }]);
  await runUntil(loop, () => happened('drop', 'pickup:p'));
  assert.equal(game.moves.length, 1);
});

test('a pickup is stopped as soon as its parcel is seen to be gone', async () => {
  const { game, loop, happened } = agentLoop(['2333333'], { x: 6, y: 0 });
  see(loop.beliefs, [{ id: 'p', x: 1, y: 0, reward: 30, carriedBy: null }]);
  game.onMove = () => see(loop.beliefs, [], [{ x: 1, y: 0 }]);
  await runUntil(loop, () => happened('drop', 'pickup:p'));
  assert.equal(game.moves.length, 1);
});

test('the loop switches to a clearly better parcel that appears', async () => {
  // The agent is at x 6 and the delivery tile at x 0. It sets off for p1
  // (worth 10, at x 1). After its first move, p2 (worth 40, at x 4) appears.
  const { game, loop, happened } = agentLoop(['2333333'], { x: 6, y: 0 });
  see(loop.beliefs, [{ id: 'p1', x: 1, y: 0, reward: 10, carriedBy: null }]);
  game.onMove = () => {
    game.onMove = undefined;
    see(loop.beliefs, [
      { id: 'p1', x: 1, y: 0, reward: 10, carriedBy: null },
      { id: 'p2', x: 4, y: 0, reward: 40, carriedBy: null },
    ]);
  };
  await runUntil(loop, () => happened('commit', 'pickup:p2'));
  assert.ok(happened('drop', 'pickup:p1'));
});

test('the loop keeps its intention when the new option is only slightly better', async () => {
  // After the first move, p1 would bring 19 points and p2 would bring 20.
  // 20 is not 20% more than 19, so the agent must keep going for p1.
  const { game, loop, events, happened } = agentLoop(['2333333'], { x: 6, y: 0 }, { parcelsAt: { '2,0': ['p1'] } });
  see(loop.beliefs, [{ id: 'p1', x: 2, y: 0, reward: 20, carriedBy: null }]);
  game.onMove = () => {
    game.onMove = undefined;
    see(loop.beliefs, [
      { id: 'p1', x: 2, y: 0, reward: 20, carriedBy: null },
      { id: 'p2', x: 3, y: 0, reward: 21, carriedBy: null },
    ]);
  };
  await runUntil(loop, () => events.some(e => e.kind !== 'commit'));
  assert.equal(happened('drop', 'pickup:p1'), false);
  assert.ok(happened('done', 'pickup:p1'));
});

test('a failed intention is reported with its reason', async () => {
  // The server refuses the move into x 5, the only way to the parcel. After
  // that refusal A* finds no route, so the walk gives up.
  const { loop, events } = agentLoop(['2333333'], { x: 6, y: 0 }, { refuseInto: ['5,0'] });
  see(loop.beliefs, [{ id: 'p', x: 1, y: 0, reward: 30, carriedBy: null }]);
  await runUntil(loop, () => events.some(e => e.kind === 'failed'));
  const failed = events.find(e => e.kind === 'failed');
  assert.equal(failed?.option.id, 'pickup:p');
  assert.ok(failed?.reason);
});
