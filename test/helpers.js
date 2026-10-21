import { GridMap } from '../src/beliefs/map.js';

/**
 * Build a map from rows of tile characters. The first row is the top of the
 * map (highest y), so the picture in a test reads like the game view.
 * @param {string[]} rows
 * @param {{ blockedTtlMs?: number, maxBlockedMs?: number }} [options]
 * @returns {GridMap}
 */
export function mapFromRows(rows, options) {
  const height = rows.length;
  const width = [...rows[0]].length;
  /** @type {import('../src/types.js').Tile[]} */
  const tiles = [];
  rows.forEach((row, i) =>
    [...row].forEach((type, x) =>
      tiles.push({ x, y: height - 1 - i, type: /** @type {import('../src/types.js').TileType} */ (type) })));
  return new GridMap(width, height, tiles, options);
}
