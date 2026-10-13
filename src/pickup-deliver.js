// Lab 1 exercise: find a parcel, walk to it, pick it up, walk to a delivery
// tile and put it down. A throwaway demo; the real agent replaces the simple
// search here with the beliefs, A* and plans from the implementation plan.
// Run with: npm run deliver   (or AGENT=milktea npm run deliver)
import { config } from './config.js';
import { connect } from './client.js';

/**
 * @typedef {import('./types.js').Direction} Direction
 * @typedef {import('./types.js').Position} Position
 * @typedef {import('./types.js').Parcel} Parcel
 */

const client = connect(config);

/** @type {Map<string, string>} tile type by "x,y" */
const tiles = new Map();
/** @type {Position} */
let me = { x: 0, y: 0 };
let score = 0;
/** @type {Parcel[]} parcels currently in view */
let visible = [];
/** @type {Set<string>} tiles other agents are on or moving between */
let occupied = new Set();

client.onMap((_width, _height, list) => {
  for (const tile of list) tiles.set(`${tile.x},${tile.y}`, tile.type);
});
client.onTile((tile) => tiles.set(`${tile.x},${tile.y}`, tile.type));
client.onYou((self) => {
  me = { x: Math.round(self.x), y: Math.round(self.y) };
  score = self.score;
});
client.onSensing((sensing) => {
  visible = sensing.parcels;
  occupied = new Set();
  for (const agent of sensing.agents) {
    // An agent between two tiles (x: 8.4) blocks both of them.
    for (const x of [Math.floor(agent.x), Math.ceil(agent.x)])
      for (const y of [Math.floor(agent.y), Math.ceil(agent.y)]) occupied.add(`${x},${y}`);
  }
});

/** @type {Record<Direction, Position>} */
const STEP = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** @param {number} x @param {number} y */
function walkable(x, y) {
  const type = tiles.get(`${x},${y}`);
  return type !== undefined && type !== '0' && !type.startsWith('5');
}

/**
 * Breadth-first search from `from` to the nearest tile accepted by `isGoal`.
 * @param {Position} from
 * @param {(x: number, y: number) => boolean} isGoal
 * @returns {{ target: Position, path: Direction[] } | null}
 */
function pathToNearest(from, isGoal) {
  /** @type {{ pos: Position, path: Direction[] }[]} */
  const queue = [{ pos: from, path: [] }];
  const seen = new Set([`${from.x},${from.y}`]);
  while (queue.length > 0) {
    const { pos, path } = /** @type {{ pos: Position, path: Direction[] }} */ (queue.shift());
    if (isGoal(pos.x, pos.y)) return { target: pos, path };
    for (const dir of /** @type {Direction[]} */ (Object.keys(STEP))) {
      const next = { x: pos.x + STEP[dir].x, y: pos.y + STEP[dir].y };
      const key = `${next.x},${next.y}`;
      if (seen.has(key) || !walkable(next.x, next.y) || occupied.has(key)) continue;
      seen.add(key);
      queue.push({ pos: next, path: [...path, dir] });
    }
  }
  return null;
}

/**
 * Walk to the nearest tile accepted by `isGoal`, one move at a time. The
 * route is recomputed before every move, so the agent steers around other
 * agents; a refused move just means "look again".
 * @param {(x: number, y: number) => boolean} isGoal
 * @returns {Promise<boolean>} true on arrival
 */
async function goTo(isGoal) {
  let refused = 0;
  while (refused < 30) {
    const route = pathToNearest(me, isGoal);
    if (!route) {
      refused++;
      await sleep(200); // boxed in by other agents: wait for them to move
      continue;
    }
    if (route.path.length === 0) return true;
    const result = await client.move(route.path[0]);
    if (result) {
      me = { x: Math.round(result.x), y: Math.round(result.y) };
    } else {
      refused++;
      await sleep(100);
    }
  }
  return false;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Free parcels in view that still have some reward. */
const freeParcels = () => visible.filter((p) => !p.carriedBy && p.reward > 1);

// Wait until logged in and the map has arrived.
await new Promise((resolve) => client.onYou(resolve));
while (tiles.size === 0) await sleep(100);
console.log(`start at (${me.x},${me.y}), score ${score}`);

/** @param {string} type */
const isType = (type) => (/** @type {number} */ x, /** @type {number} */ y) => tiles.get(`${x},${y}`) === type;

// 1. Find a parcel. If none is in view, walk to parcel spawner tiles (type '1').
const visited = new Set();
let carried = 0;
for (let attempt = 0; attempt < 20 && carried === 0; attempt++) {
  const parcels = freeParcels();
  const arrived = parcels.length > 0
    ? await goTo((x, y) => freeParcels().some((p) => p.x === x && p.y === y))
    : await goTo((x, y) => tiles.get(`${x},${y}`) === '1' && !visited.has(`${x},${y}`));
  if (!arrived) {
    console.log('could not get there, looking again');
    continue;
  }
  visited.add(`${me.x},${me.y}`);
  // 2. Pick up whatever is on this tile.
  const picked = await client.pickup();
  carried = picked.length;
  console.log(`${parcels.length > 0 ? 'went to a parcel' : 'no parcel in view, went to a spawner'}, pickup at (${me.x},${me.y}):`, JSON.stringify(picked));
  if (carried === 0) await sleep(300);
}

// 3. Carry it to the nearest delivery tile (type '2') and put it down.
if (carried > 0) {
  if (await goTo(isType('2'))) {
    const before = score;
    const dropped = await client.putdown();
    await sleep(500); // let the score update arrive
    console.log(`putdown at (${me.x},${me.y}):`, JSON.stringify(dropped), `score ${before} -> ${score}`);
  } else {
    console.log('could not reach a delivery tile');
  }
}

process.exit(0);
