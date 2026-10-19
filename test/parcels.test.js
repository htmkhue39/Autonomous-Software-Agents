import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayIntervalMs, ParcelBeliefs } from '../src/beliefs/parcels.js';

/**
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @param {number} reward
 * @param {string | null} [carriedBy]
 * @returns {import('../src/types.js').Parcel}
 */
function parcel(id, x, y, reward, carriedBy = null) {
  return { id, x, y, reward, carriedBy };
}

test('decay settings become milliseconds', () => {
  assert.equal(decayIntervalMs('1s'), 1000);
  assert.equal(decayIntervalMs('2s'), 2000);
  assert.equal(decayIntervalMs('5s'), 5000);
  assert.equal(decayIntervalMs('10s'), 10000);
  assert.equal(decayIntervalMs('1m'), 60000);
  assert.equal(decayIntervalMs('1h'), 3600000);
  assert.equal(decayIntervalMs('frame', 50), 50);
});

test('an infinite decay setting means no decay', () => {
  assert.equal(decayIntervalMs('infinite'), Infinity);
  const parcels = new ParcelBeliefs(Infinity);
  parcels.update([parcel('p', 0, 0, 10)], [], 0);
  assert.equal(parcels.get('p', 1e9)?.reward, 10);
});

test('an unknown decay setting is an error', () => {
  assert.throws(() => decayIntervalMs(/** @type {any} */ ('soon')));
});

test('a parcel loses one point per interval since it was last seen', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([parcel('p', 2, 3, 10)], [], 5000);
  assert.deepEqual(parcels.get('p', 5000), parcel('p', 2, 3, 10));
  assert.equal(parcels.get('p', 5999)?.reward, 10);
  assert.equal(parcels.get('p', 8000)?.reward, 7);
});

test('a parcel whose value reaches zero is forgotten', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([parcel('p', 0, 0, 2)], [], 0);
  assert.equal(parcels.get('p', 2000), undefined);
  assert.equal(parcels.get('p', 0), undefined);
});

test('free parcels leave out carried and worthless ones', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([
    parcel('free', 0, 0, 10),
    parcel('carried', 1, 0, 10, 'a1'),
    parcel('cheap', 2, 0, 1),
  ], [], 0);
  assert.deepEqual(parcels.free(1500).map(p => p.id), ['free']);
  assert.equal(parcels.free(1500)[0].reward, 9);
});

test('a parcel is forgotten when its tile is seen empty', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([parcel('a', 0, 0, 10), parcel('b', 5, 5, 10)], [], 0);
  parcels.update([], [{ x: 0, y: 0 }], 100);
  assert.equal(parcels.get('a', 100), undefined);
  assert.equal(parcels.get('b', 100)?.id, 'b');
});

test('a carried parcel is not forgotten when its tile is seen empty', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([parcel('c', 0, 0, 10, 'a1')], [], 0);
  parcels.update([], [{ x: 0, y: 0 }], 100);
  assert.equal(parcels.get('c', 100)?.id, 'c');
});

test('a parcel seen again is updated', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([parcel('p', 0, 0, 10)], [], 0);
  parcels.update([parcel('p', 1, 0, 8, 'a1')], [{ x: 0, y: 0 }], 2000);
  assert.deepEqual(parcels.get('p', 2000), parcel('p', 1, 0, 8, 'a1'));
});

test('the parcels carried by an agent are listed', () => {
  const parcels = new ParcelBeliefs(1000);
  parcels.update([
    parcel('mine1', 1, 1, 10, 'me'),
    parcel('mine2', 1, 1, 4, 'me'),
    parcel('theirs', 3, 3, 10, 'other'),
    parcel('free', 2, 2, 10),
  ], [], 0);
  assert.deepEqual(parcels.carriedBy('me', 0).map(p => p.id).sort(), ['mine1', 'mine2']);
  assert.deepEqual(parcels.carriedBy('nobody', 0), []);
});
