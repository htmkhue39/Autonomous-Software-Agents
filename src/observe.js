// Temporary script for Task 1: logs what the server sends, then tries a few
// moves. Deleted in Task 7.
import { config } from './config.js';
import { connect } from './client.js';

/** @typedef {import('./types.js').Direction} Direction */

const client = connect(config);
const { socket } = client;
const SAMPLES = 3;

client.onConfig((cfg) => {
  const { map, ...game } = cfg.GAME ?? {};
  console.log('\n[config]', JSON.stringify({ ...cfg, GAME: game }, null, 2));
  if (map) console.log(`[config map] ${map.width} x ${map.height}, first row: ${JSON.stringify(map.tiles?.[0])}`);
});

client.onMap((width, height, tiles) => {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const tile of tiles) counts[tile.type] = (counts[tile.type] ?? 0) + 1;
  console.log(`\n[map] ${width} x ${height}, ${tiles.length} tiles, count per type:`, counts);
});

// The server also sends the map one 'tile' event at a time.
/** @type {Record<string, number>} */
const tileCounts = {};
let tileEvents = 0;
client.onTile((tile) => {
  tileEvents++;
  tileCounts[tile.type] = (tileCounts[tile.type] ?? 0) + 1;
});

let youSeen = 0;
let fractionalLogged = false;
client.onYou((me) => {
  if (youSeen++ < SAMPLES) console.log('[you]', me);
  if (!fractionalLogged && !(Number.isInteger(me.x) && Number.isInteger(me.y))) {
    fractionalLogged = true;
    console.log('[you] fractional position mid-move:', { x: me.x, y: me.y });
  }
});

let sensingSeen = 0;
client.onSensing((sensing) => {
  if (sensingSeen++ >= SAMPLES) return;
  const { positions, ...rest } = sensing;
  console.log('[sensing]', { positions: positions.length, ...rest });
});

// A token is sent only when connecting by NAME without a TOKEN. Each such
// connection creates a new agent, so copy the token into .env.
socket.once('token', (/** @type {string} */ token) => console.log('\n[token]', token));
await new Promise((resolve) => client.onYou(resolve));
console.log(`\n[tile events] ${tileEvents}, count per type:`, tileCounts);

for (const dir of /** @type {Direction[]} */ (['up', 'right', 'down', 'left'])) {
  const started = Date.now();
  const result = await client.move(dir);
  console.log(`[move ${dir}]`, result, `${Date.now() - started} ms`);
}
console.log('[pickup]', await client.pickup());

console.log(`[you] events seen: ${youSeen}, [sensing] events seen: ${sensingSeen}`);
setTimeout(() => process.exit(0), 3000);
