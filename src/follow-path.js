// Lab 1 exercise: walk a predefined path, retrying blocked moves, then pick up.
// Run with: npm run path   (or AGENT=milktea npm run path)
import { config } from './config.js';
import { connect } from './client.js';

/** @typedef {import('./types.js').Direction} Direction */

const client = connect(config);
const me = await new Promise((resolve) => client.onYou(resolve));
console.log('start', me.x, me.y);

/** @type {Direction[]} */
const path = ['up', 'up', 'right', 'right', 'down', 'down', 'left', 'left'];

for (const dir of path) {
  let result = await client.move(dir);
  for (let attempt = 1; !result && attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    result = await client.move(dir);
  }
  if (!result) {
    console.log(`blocked going ${dir}, stopping`);
    break;
  }
  console.log(dir, '->', result.x, result.y);
}

console.log('picked up', await client.pickup());
process.exit(0);
