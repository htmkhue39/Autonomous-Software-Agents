import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { findPath, findNearest } from '../src/planning/astar.js';

const NOW = { now: 0 };

test('the route is empty when already at the target', () => {
  const map = mapFromRows(['333']);
  assert.deepEqual(findPath(map, { x: 1, y: 0 }, { x: 1, y: 0 }, NOW), []);
});

test('a straight line is the obvious route', () => {
  const map = mapFromRows(['3333']);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 3, y: 0 }, NOW), ['right', 'right', 'right']);
});

test('the route takes a shortest detour around a wall', () => {
  const map = mapFromRows([
    '333',
    '303',
    '303',
  ]);
  // From bottom left to bottom right: up two, across, down two.
  const path = findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, NOW);
  assert.deepEqual(path, ['up', 'up', 'right', 'right', 'down', 'down']);
});

test('there is no route to an unreachable tile', () => {
  const map = mapFromRows(['303']);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, NOW), null);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 1, y: 0 }, NOW), null);
});

test('blocked tiles are avoided', () => {
  const map = mapFromRows(['333', '333']);
  map.block(1, 0, 1000);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, NOW), ['up', 'right', 'right', 'down']);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, { now: 1000 }), ['right', 'right']);
});

// The situation on the course map "tree": a pair of arrows pointing at each
// other cannot be crossed straight, so the route steps around and comes back
// in from the side.
test('one-way tiles are never entered against their direction', () => {
  const map = mapFromRows([
    '0330',
    '3→←3',
  ]);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 3, y: 0 }, NOW), ['right', 'up', 'right', 'down', 'right']);
  assert.deepEqual(findPath(map, { x: 3, y: 0 }, { x: 0, y: 0 }, NOW), ['left', 'up', 'left', 'down', 'left']);
});

test('tiles occupied by other agents are avoided', () => {
  const map = mapFromRows(['333', '333']);
  const occupied = new Set(['1,0']);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, { now: 0, occupied }), ['up', 'right', 'right', 'down']);
});

test('an occupied target cannot be reached', () => {
  const map = mapFromRows(['333']);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, { now: 0, occupied: new Set(['2,0']) }), null);
});

test('forbidden tiles are avoided, including as the target', () => {
  const map = mapFromRows(['333', '333']);
  /** @param {number} x @param {number} y */
  const forbidden = (x, y) => x === 1 && y === 0;
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, { now: 0, forbidden }), ['up', 'right', 'right', 'down']);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 1, y: 0 }, { now: 0, forbidden }), null);
});

test('the closest reachable target is picked', () => {
  const map = mapFromRows([
    '33333',
    '30333',
  ]);
  // (0,1) is 1 move away, (4,0) is 4.
  const got = findNearest(map, { x: 0, y: 0 }, [{ x: 4, y: 0 }, { x: 0, y: 1 }], NOW);
  assert.deepEqual(got, { target: { x: 0, y: 1 }, path: ['up'] });
});

test('the closest target is measured by route, not straight-line distance', () => {
  const map = mapFromRows([
    '33333',
    '30333',
    '30333',
  ]);
  // (2,0) is 2 tiles away in a straight line but 6 moves around the wall;
  // (1,2) is 3 tiles away and 3 moves.
  const got = findNearest(map, { x: 0, y: 0 }, [{ x: 2, y: 0 }, { x: 1, y: 2 }], NOW);
  assert.deepEqual(got, { target: { x: 1, y: 2 }, path: ['up', 'up', 'right'] });
});

test('unreachable targets are skipped', () => {
  const map = mapFromRows(['33033']);
  const got = findNearest(map, { x: 0, y: 0 }, [{ x: 3, y: 0 }, { x: 1, y: 0 }], NOW);
  assert.deepEqual(got, { target: { x: 1, y: 0 }, path: ['right'] });
});

test('nothing is returned when no target can be reached', () => {
  const map = mapFromRows(['30333']);
  assert.equal(findNearest(map, { x: 0, y: 0 }, [{ x: 2, y: 0 }, { x: 4, y: 0 }], NOW), null);
  assert.equal(findNearest(map, { x: 0, y: 0 }, [], NOW), null);
});
