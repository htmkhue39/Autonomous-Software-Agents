import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGame, readyBeliefs } from './helpers.js';
import { moveTo } from '../src/plans/moveTo.js';
import { planLibrary } from '../src/plans/library.js';
import { astarRoute } from '../src/planning/astar.js';

/**
 * @typedef {import('../src/types.js').Parcel} Parcel
 * @typedef {import('../src/types.js').Option} Option
 */

/**
 * Beliefs, a fake game playing against them, and the plans, on a map drawn
 * as rows with the agent at `me`.
 * @param {string[]} rows
 * @param {{ x: number, y: number }} me
 * @param {Parameters<typeof fakeGame>[1]} [setup]
 */
function play(rows, me, setup) {
  const { beliefs } = readyBeliefs(rows, me);
  const game = fakeGame(beliefs, setup);
  const ctx = { beliefs, client: game.client, planRoute: astarRoute, maxFailures: 3 };
  return { beliefs, game, ctx, plans: planLibrary(ctx) };
}

/**
 * @param {import('../src/beliefs/index.js').Beliefs} beliefs
 * @param {Parcel[]} parcels
 */
function see(beliefs, parcels) {
  beliefs.onSensing({ positions: [], agents: [], parcels, crates: [] });
}

/**
 * @param {Option['type']} type
 * @param {number} x
 * @param {number} y
 * @param {string} [parcelId]
 * @returns {Option}
 */
function option(type, x, y, parcelId) {
  return { id: type, type, x, y, utility: 0, priority: 0, parcelId };
}

const go = () => ({ stopped: false });

test('the agent walks to its target', async () => {
  const { beliefs, game, ctx } = play(['33333'], { x: 0, y: 0 });
  assert.equal(await moveTo(ctx, [{ x: 4, y: 0 }], go()), true);
  assert.deepEqual([beliefs.me?.x, beliefs.me?.y], [4, 0]);
  assert.deepEqual(game.moves, ['right', 'right', 'right', 'right']);
});

test('the walk stops when told, before the next step', async () => {
  const { game, ctx } = play(['33333'], { x: 0, y: 0 });
  const signal = go();
  game.onMove = () => { signal.stopped = true; };
  assert.equal(await moveTo(ctx, [{ x: 4, y: 0 }], signal), false);
  assert.equal(game.moves.length, 1);
});

test('a refused move is remembered and walked around', async () => {
  const { beliefs, ctx } = play(['33333', '33333'], { x: 0, y: 0 }, { refuseInto: ['2,0'] });
  assert.equal(await moveTo(ctx, [{ x: 4, y: 0 }], go()), true);
  assert.deepEqual([beliefs.me?.x, beliefs.me?.y], [4, 0]);
  assert.equal(beliefs.map?.neighbors(1, 0, 0).some(n => n.dir === 'right'), false);
});

test('the walk gives up after three refused moves', async () => {
  const { game, ctx } = play(['333', '333', '333'], { x: 0, y: 0 }, { refuseInto: ['1,1'] });
  assert.equal(await moveTo(ctx, [{ x: 1, y: 1 }], go()), false);
  assert.equal(game.refused, 3);
});

test('a move answered too late counts as failed, and the walk goes on', async () => {
  const { beliefs, ctx } = play(['3333'], { x: 0, y: 0 }, { lateInto: ['1,0'] });
  assert.equal(await moveTo(ctx, [{ x: 3, y: 0 }], go()), true);
  assert.deepEqual([beliefs.me?.x, beliefs.me?.y], [3, 0]);
  assert.equal(beliefs.map?.neighbors(0, 0, 0).some(n => n.dir === 'right'), false);
});

test('with no route the walk fails without moving', async () => {
  const { game, ctx } = play(['303'], { x: 0, y: 0 });
  assert.equal(await moveTo(ctx, [{ x: 2, y: 0 }], go()), false);
  assert.deepEqual(game.moves, []);
});

test('pickup walks to the parcel and picks it up', async () => {
  const { beliefs, plans } = play(['3333'], { x: 0, y: 0 }, { parcelsAt: { '3,0': ['p'] } });
  see(beliefs, [{ id: 'p', x: 3, y: 0, reward: 10, carriedBy: null }]);
  assert.equal(await plans.pickup(option('pickup', 3, 0, 'p'), go()), true);
  assert.deepEqual(beliefs.parcels.carriedBy('me', 0).map(p => p.id), ['p']);
});

test('pickup fails, and forgets the parcel, when someone else took it', async () => {
  const { beliefs, plans } = play(['3333'], { x: 0, y: 0 });
  see(beliefs, [{ id: 'p', x: 3, y: 0, reward: 10, carriedBy: null }]);
  assert.equal(await plans.pickup(option('pickup', 3, 0, 'p'), go()), false);
  assert.equal(beliefs.parcels.get('p', 0), undefined);
});

test('deliver walks to a delivery tile and puts the parcels down', async () => {
  const { beliefs, game, plans } = play(['3332'], { x: 0, y: 0 }, { carried: ['c'] });
  see(beliefs, [{ id: 'c', x: 0, y: 0, reward: 10, carriedBy: 'me' }]);
  assert.equal(await plans.deliver(option('deliver', 3, 0), go()), true);
  assert.deepEqual(game.delivered, ['c']);
  assert.deepEqual(beliefs.parcels.carriedBy('me', 0), []);
});

test('deliver heads for another delivery tile when the nearest is occupied', async () => {
  const { beliefs, game, plans } = play(['2333332'], { x: 2, y: 0 }, { carried: ['c'] });
  see(beliefs, [{ id: 'c', x: 2, y: 0, reward: 10, carriedBy: 'me' }]);
  beliefs.onSensing({ positions: [], agents: [{ id: 'a', name: 'a', x: 0, y: 0, score: 0 }], parcels: [], crates: [] });
  assert.equal(await plans.deliver(option('deliver', 0, 0), go()), true);
  assert.equal(beliefs.me?.x, 6);
  assert.deepEqual(game.delivered, ['c']);
});

test('a parcel on a tile passed on the way is picked up', async () => {
  const { beliefs, game, plans } = play(['33333'], { x: 0, y: 0 }, { parcelsAt: { '2,0': ['q'] } });
  see(beliefs, [{ id: 'q', x: 2, y: 0, reward: 10, carriedBy: null }]);
  assert.equal(await plans.explore(option('explore', 4, 0), go()), true);
  assert.deepEqual(game.carried, ['q']);
});

test('parcels are put down on a delivery tile passed on the way', async () => {
  const { beliefs, game, plans } = play(['33233'], { x: 0, y: 0 }, { carried: ['c'] });
  see(beliefs, [{ id: 'c', x: 0, y: 0, reward: 10, carriedBy: 'me' }]);
  assert.equal(await plans.goto(option('goto', 4, 0), go()), true);
  assert.deepEqual(game.delivered, ['c']);
});

test('every kind of option has exactly one plan', () => {
  const { plans } = play(['3'], { x: 0, y: 0 });
  assert.deepEqual(Object.keys(plans).sort(), ['deliver', 'explore', 'goto', 'pickup']);
  for (const plan of Object.values(plans)) assert.equal(typeof plan, 'function');
});
