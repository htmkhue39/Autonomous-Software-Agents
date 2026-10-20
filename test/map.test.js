import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { key } from '../src/beliefs/map.js';

test('key joins coordinates', () => {
  assert.equal(key(2, 5), '2,5');
});

test('walls, crate tiles and off-map are not walkable', () => {
  const map = mapFromRows(['305', '312']);
  assert.equal(map.isWalkable(0, 0, 0), true);   // '3' walkable
  assert.equal(map.isWalkable(1, 0, 0), true);   // '1' spawner
  assert.equal(map.isWalkable(2, 0, 0), true);   // '2' delivery
  assert.equal(map.isWalkable(1, 1, 0), false);  // '0' wall
  assert.equal(map.isWalkable(2, 1, 0), false);  // '5' crate tile
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

// The server's rule (backend/src/deliveroo/Tile.js and Controller.js in
// unitn-ASA/Deliveroo.js): an arrow tile only refuses a move against it.
test('an arrow tile cannot be entered against its direction', () => {
  const map = mapFromRows(['3→3']);
  assert.deepEqual(map.neighbors(0, 0, 0), [{ x: 1, y: 0, dir: 'right' }]);
  assert.deepEqual(map.neighbors(2, 0, 0), []);
});

test('an arrow tile can be entered from the side and left in any direction', () => {
  const map = mapFromRows(['3', '→', '3']);
  assert.deepEqual(map.neighbors(0, 2, 0), [{ x: 0, y: 1, dir: 'down' }]);
  assert.deepEqual(map.neighbors(0, 1, 0).map(n => n.dir).sort(), ['down', 'up']);
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
