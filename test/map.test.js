import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { key } from '../src/beliefs/map.js';

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

// No movement rule is assumed for arrow tiles: a move the server refuses
// blocks the tile for a while instead (design.md section 4).
test('arrow tiles can be entered and left in any direction', () => {
  const map = mapFromRows(['3→3']);
  assert.deepEqual(map.neighbors(0, 0, 0), [{ x: 1, y: 0, dir: 'right' }]);
  assert.deepEqual(map.neighbors(2, 0, 0), [{ x: 1, y: 0, dir: 'left' }]);
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
