// @ts-nocheck -- plans are small hand-written objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanArchive, archiveKey } from '../src/plans/archive.js';

const goal = { kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } };
const from = { x: 3, y: 0 };
const plan = name => ({ steps: [], path: [{ x: 0, y: 0 }], name });

test('the key is made of the start, parcel and delivery tiles and the carried count', () => {
  assert.equal(archiveKey(goal, from, 0), 'trip 3,0>1,0>0,0 c0');
  assert.equal(archiveKey({ kind: 'deliver', deliverAt: { x: 0, y: 0 } }, from, 2), 'deliver 3,0>0,0 c2');
  assert.equal(archiveKey({ kind: 'pickup', parcelAt: { x: 1, y: 0 } }, from, 1), 'pickup 3,0>1,0 c1');
  assert.notEqual(archiveKey(goal, from, 0), archiveKey(goal, from, 1));
});

test('a stored plan is found again', () => {
  const archive = new PlanArchive();
  archive.set('a', plan('a'));
  assert.equal(archive.get('a').name, 'a');
  assert.equal(archive.get('b'), undefined);
  archive.delete('a');
  assert.equal(archive.count, 0);
});

test('when full, the plan unused for longest is dropped', () => {
  const archive = new PlanArchive({ size: 2 });
  archive.set('a', plan('a'));
  archive.set('b', plan('b'));
  archive.get('a');
  archive.set('c', plan('c'));
  assert.equal(archive.get('b'), undefined);
  assert.equal(archive.get('a').name, 'a');
  assert.equal(archive.get('c').name, 'c');
  assert.equal(archive.count, 2);
});
