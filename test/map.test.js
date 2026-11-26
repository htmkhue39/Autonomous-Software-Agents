import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { GridMap, key } from '../src/beliefs/map.js';

test('key joins coordinates', () => {
  assert.equal(key(2, 5), '2,5');
});

test('walls and off-map are not walkable, every other tile is', () => {
  const map = mapFromRows(['305', '312']);
  assert.equal(map.isWalkable(0, 0, 0), true);   // '3' walkable
  assert.equal(map.isWalkable(1, 0, 0), true);   // '1' spawner
  assert.equal(map.isWalkable(2, 0, 0), true);   // '2' delivery
  assert.equal(map.isWalkable(1, 1, 0), false);  // '0' wall
  assert.equal(map.isWalkable(2, 1, 0), true);   // '5' crate tile
  assert.equal(map.isWalkable(-1, 0, 0), false);
  assert.equal(map.isWalkable(0, 2, 0), false);
});

test('a blocked tile is unwalkable until the block expires', () => {
  const map = mapFromRows(['33']);
  map.block(1, 0, 1000);
  assert.equal(map.isWalkable(1, 0, 999), false);
  assert.equal(map.isWalkable(1, 0, 1000), true);
});

test('neighbors returns walkable adjacent tiles with directions', () => {
  const map = mapFromRows(['030', '333', '030']);
  const got = map.neighbors(1, 1, 0).map(n => n.dir).sort();
  assert.deepEqual(got, ['down', 'left', 'right', 'up']);
  assert.deepEqual(map.neighbors(1, 2, 0), [{ x: 1, y: 1, dir: 'down' }]);
});

// One-way arrows only permit travel in their specified direction.
test('arrow tiles restrict traversal to their indicated direction', () => {
  const map = mapFromRows(['3→3']);
  assert.deepEqual(map.neighbors(0, 0, 0), [{ x: 1, y: 0, dir: 'right' }]);
  assert.deepEqual(map.neighbors(2, 0, 0), []);
  // Leaving the arrow tile is allowed in any direction, even against it.
  assert.deepEqual(map.neighbors(1, 0, 0).map(n => n.dir).sort(), ['left', 'right']);
});

test('delivery and spawn tiles are listed', () => {
  const map = mapFromRows(['12', '31']);
  assert.deepEqual(map.deliveryTiles(), [{ x: 1, y: 1 }]);
  assert.equal(map.spawnTiles().length, 2);
});

test('updateTile changes a tile type', () => {
  const map = mapFromRows(['33']);
  map.updateTile({ x: 1, y: 0, type: '0' });
  assert.equal(map.isWalkable(1, 0, 0), false);
});

test('remembers when each tile was last seen', () => {
  const map = mapFromRows(['33']);
  assert.equal(map.lastSeen(0, 0), -Infinity);
  map.markSeen([{ x: 0, y: 0 }], 500);
  assert.equal(map.lastSeen(0, 0), 500);
  assert.equal(map.lastSeen(1, 0), -Infinity);
});

test('a refused move blocks only that move, not the tile', () => {
  const map = mapFromRows(['333', '333'], { blockedTtlMs: 1000 });
  map.failMove(0, 0, 'right', 0);
  assert.deepEqual(map.neighbors(0, 0, 0).map(n => n.dir), ['up']);
  // The same tile can still be entered from above.
  assert.ok(map.neighbors(1, 1, 0).some(n => n.dir === 'down'));
  assert.ok(map.neighbors(0, 0, 1000).some(n => n.dir === 'right'));
});

test('a move refused again stays blocked twice as long, up to a limit', () => {
  const map = mapFromRows(['33'], { blockedTtlMs: 1000, maxBlockedMs: 3000 });
  const canGoRight = (/** @type {number} */ now) => map.neighbors(0, 0, now).length === 1;
  map.failMove(0, 0, 'right', 0);        // blocked until 1000
  map.failMove(0, 0, 'right', 1000);     // until 3000
  assert.equal(canGoRight(2999), false);
  assert.equal(canGoRight(3000), true);
  map.failMove(0, 0, 'right', 3000);     // 4000 would exceed the limit: until 6000
  assert.equal(canGoRight(5999), false);
  assert.equal(canGoRight(6000), true);
});

test('a move that succeeds is trusted again', () => {
  const map = mapFromRows(['33'], { blockedTtlMs: 1000 });
  map.failMove(0, 0, 'right', 0);
  map.failMove(0, 0, 'right', 1000);
  map.moveSucceeded(0, 0, 'right');
  assert.equal(map.neighbors(0, 0, 0).length, 1);
  map.failMove(0, 0, 'right', 5000);     // counts as a first failure again
  assert.equal(map.neighbors(0, 0, 6000).length, 1);
});

// An arrow only forbids stepping onto it against the arrow. It can be left
// in any direction.
test('an arrow tile can be left in every direction, even against the arrow', () => {
  const map = mapFromRows(['333', '3→3', '333']);
  assert.deepEqual(map.neighbors(1, 1, 0).map(n => n.dir).sort(), ['down', 'left', 'right', 'up']);
});

test('an arrow tile can be entered from the side, but not against the arrow', () => {
  const map = mapFromRows(['333', '3→3', '333']);
  const into = (/** @type {number} */ x, /** @type {number} */ y) =>
    map.neighbors(x, y, 0).some(n => n.x === 1 && n.y === 1);
  assert.equal(into(0, 1), true);   // from the left, moving right: the arrow's way
  assert.equal(into(1, 2), true);   // from above, moving down: from the side
  assert.equal(into(1, 0), true);   // from below, moving up: from the side
  assert.equal(into(2, 1), false);  // from the right, moving left: against the arrow
});

test('a delivery tile that can be entered but never left is not sustainable', () => {
  // The arrow at x = 1 points left: the left end can be entered, never left.
  const map = mapFromRows(['2←3132']);
  const { deliveries, spawns } = map.sustainableTiles();
  assert.deepEqual([...deliveries], ['5,0']);
  assert.deepEqual([...spawns], ['3,0']);
});

test('a spawn tile from which no delivery tile can be reached is not sustainable', () => {
  const map = mapFromRows(['1←3132']);
  const { deliveries, spawns } = map.sustainableTiles();
  assert.deepEqual([...deliveries], ['5,0']);
  assert.deepEqual([...spawns], ['3,0']);
});

test('the sustainable tiles are worked out again when a tile changes', () => {
  const map = mapFromRows(['2←3132']);
  assert.equal(map.sustainableTiles().deliveries.has('0,0'), false);
  map.updateTile({ x: 1, y: 0, type: '3' });
  assert.equal(map.sustainableTiles().deliveries.has('0,0'), true);
});

test('a crate can be pushed only onto a free crate tile behind it', () => {
  // From x = 0, a move right steps onto the crate at x = 1 and pushes it to x = 2.
  const map = mapFromRows(['3553']);
  map.updateCrates([{ x: 1, y: 0 }], []);
  assert.deepEqual(map.neighbors(0, 0, 0).map(n => n.dir), ['right']);
  // Behind the crate there is another crate: the push is refused.
  map.updateCrates([{ x: 2, y: 0 }], []);
  assert.deepEqual(map.neighbors(0, 0, 0), []);
});

test('a crate cannot be pushed onto a tile that is not a crate tile', () => {
  const map = mapFromRows(['353']);
  map.updateCrates([{ x: 1, y: 0 }], []);
  assert.deepEqual(map.neighbors(0, 0, 0), []);
  // A '5!' tile is a crate tile too.
  const spawner = new GridMap(3, 1, [{ x: 0, y: 0, type: '3' }, { x: 1, y: 0, type: '5' }, { x: 2, y: 0, type: '5!' }]);
  spawner.updateCrates([{ x: 1, y: 0 }], []);
  assert.deepEqual(spawner.neighbors(0, 0, 0).map(n => n.dir), ['right']);
});

test('a pushed crate is believed one tile further on', () => {
  const map = mapFromRows(['3553']);
  map.updateCrates([{ x: 1, y: 0 }], []);
  map.cratePushed(1, 0, 'right');
  assert.equal(map.hasCrate(1, 0), false);
  assert.equal(map.hasCrate(2, 0), true);
});

test('crates do not count for the lasting rules', () => {
  const map = mapFromRows(['353']);
  map.updateCrates([{ x: 1, y: 0 }], []);
  assert.deepEqual(map.neighbors(0, 0, 0, { ignoreTemporary: true }).map(n => n.dir), ['right']);
});

test("a '9' tile is a delivery tile worth twice only when the game doubles it", () => {
  const map = mapFromRows(['293']);
  assert.deepEqual(map.deliveryTiles(), [{ x: 0, y: 0 }]);
  assert.equal(map.deliveryMultiplier(1, 0), 0);
  map.doubleDelivery = true;
  assert.deepEqual(map.deliveryTiles(), [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  assert.equal(map.deliveryMultiplier(1, 0), 2);
  assert.equal(map.deliveryMultiplier(0, 0), 1);
});

test("a door tile ('7') can only be entered while the doors are open", () => {
  const map = mapFromRows(['373']);
  assert.equal(map.isWalkable(1, 0, 0), true);
  map.doorsLocked = true;
  assert.equal(map.isWalkable(1, 0, 0), false);
  assert.equal(map.isWalkable(1, 0, 0, { ignoreTemporary: true }), false);
  assert.deepEqual(map.neighbors(0, 0, 0).map(n => n.dir), []);
  map.doorsLocked = false;
  assert.deepEqual(map.neighbors(0, 0, 0).map(n => n.dir), ['right']);
});
