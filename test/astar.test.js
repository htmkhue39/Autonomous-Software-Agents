import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { distancesFrom, distancesThroughCrates, findPath, findNearest, findPushingPath, stepWithCrates } from '../src/planning/astar.js';

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

test('arrow tiles allow only routes in their direction', () => {
  const map = mapFromRows(['3→33']);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 3, y: 0 }, NOW), ['right', 'right', 'right']);
  assert.equal(findPath(map, { x: 3, y: 0 }, { x: 0, y: 0 }, NOW), null);
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

test('a tile behind a refused move is reached from another side', () => {
  const map = mapFromRows(['333', '333'], { blockedTtlMs: 1000 });
  map.failMove(0, 0, 'right', 0);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 1, y: 0 }, NOW), ['up', 'right', 'down']);
});

test('a route may turn off an arrow tile to the side', () => {
  // From the arrow at (1, 0) the goal at (1, 1) is a side step up.
  const map = mapFromRows(['333', '3→3']);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 1, y: 1 }, NOW)?.length, 2);
  assert.deepEqual(findPath(map, { x: 1, y: 0 }, { x: 1, y: 1 }, NOW), ['up']);
  // Stepping onto the arrow against it is not allowed, so the route steps
  // onto it from the side instead, then leaves it against the arrow.
  assert.deepEqual(findPath(map, { x: 2, y: 0 }, { x: 0, y: 0 }, NOW), ['up', 'left', 'down', 'left']);
  // Standing on the arrow, the agent may step off against it.
  assert.deepEqual(findPath(map, { x: 1, y: 0 }, { x: 0, y: 0 }, NOW), ['left']);
});

test('distancesFrom gives the same move counts as findPath', () => {
  const map = mapFromRows(['3303', '3333', '30→3']);
  const from = { x: 0, y: 0 };
  const distances = distancesFrom(map, from, { now: 0 });
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      assert.equal(distances.get(`${x},${y}`) ?? null, findPath(map, from, { x, y }, { now: 0 })?.length ?? null, `${x},${y}`);
    }
  }
});

test('a pushing route accounts for where each push leaves the crate', () => {
  // The crate at (1,1) can be pushed right once, onto the crate tile (2,1),
  // but not a second time, since (3,1) is not a crate tile. With the crate
  // standing still the straight route looks open; the real way round goes
  // down, pushes the crate up into (2,2) and walks on.
  const map = mapFromRows(['0050', '3553', '0330']);
  map.updateCrates([{ x: 1, y: 1 }], []);
  const from = { x: 0, y: 1 };
  const to = { x: 3, y: 1 };
  assert.deepEqual(findPath(map, from, to, NOW), ['right', 'right', 'right']);
  const pushing = findPushingPath(map, from, to, NOW);
  assert.deepEqual(pushing, ['right', 'down', 'right', 'up', 'right']);
  // Following it move by move, as the server would, reaches the target.
  /** @type {{ x: number, y: number, crates: ReadonlySet<string> }} */
  let at = { x: from.x, y: from.y, crates: map.crateTiles() };
  for (const dir of /** @type {import('../src/types.js').Direction[]} */ (pushing)) {
    const next = stepWithCrates(map, at, dir, at.crates, NOW);
    assert.ok(next, dir);
    at = next;
  }
  assert.deepEqual({ x: at.x, y: at.y }, to);
});

test('a crate cannot be pushed onto a tile where another agent stands', () => {
  const map = mapFromRows(['3553']);
  map.updateCrates([{ x: 1, y: 0 }], []);
  assert.equal(stepWithCrates(map, { x: 0, y: 0 }, 'right', map.crateTiles(), { now: 0, occupied: new Set(['2,0']) }), null);
  assert.ok(stepWithCrates(map, { x: 0, y: 0 }, 'right', map.crateTiles(), NOW));
});

test('without crates a pushing route is as short as any route', () => {
  const map = mapFromRows(['3303', '3333', '30→3']);
  assert.equal(findPushingPath(map, { x: 0, y: 0 }, { x: 3, y: 2 }, NOW)?.length, findPath(map, { x: 0, y: 0 }, { x: 3, y: 2 }, NOW)?.length);
});

test('distances through crates include tiles that only crates keep the agent from', () => {
  const map = mapFromRows(['353']);
  map.updateCrates([{ x: 1, y: 0 }], []);
  assert.equal(distancesFrom(map, { x: 0, y: 0 }, NOW).has('2,0'), false);
  assert.equal(distancesThroughCrates(map, { x: 0, y: 0 }, NOW).get('2,0'), 2);
});
