# Deliveroo.js BDI Agent Implementation Plan

> **How to use this plan.** It is written for you to implement by hand, task
> by task. Each task gives the files, the exact interfaces, the tests in
> full, and notes on how to implement. The implementations themselves are
> yours to write. Steps use checkbox (`- [ ]`) syntax so you can track
> progress. If you later hand a task to an agent, use
> superpowers:executing-plans.

**Goal:** A BDI agent that plays Deliveroo.js autonomously, can plan
movement with an external PDDL planner, and can be instructed in natural
language through an LLM agent.

**Architecture:** One Node process runs a sense → believe → deliberate → act
loop. Beliefs are updated from server events; options are scored by expected
reward; one intention at a time is achieved through a plan library with two
interchangeable movers (A* and PDDL). An LLM agent translates user text into
validated directives that the BDI agent treats as goals and constraints.

**Tech Stack:** Node 25, plain JavaScript (ES modules, JSDoc),
`@unitn-asa/deliveroo-js-sdk` 1.3.10, `socket.io-client`,
`@unitn-asa/pddl-client` 1.7.7, `dotenv`, Node's built-in test runner
(`node --test`). LLM provider: open (see Task 11).

**Requirements:** `docs/project_requirement.md`. **Design:** `docs/design.md`. **Server notes:** `docs/server_notes.md`.

## Global Constraints

- Plain JavaScript, ES modules (`"type": "module"`), no build step.
- `src/client.js` is the only file that imports the Deliveroo SDK.
- Data structures are defined once in `src/types.js` (`Position`,
  `Direction`, `Tile`, `AgentState`, `Parcel`, `Sensing`, `ServerConfig`,
  `AppConfig`, `Client`, `Option`, `StopSignal`, `PathOptions`, `Directive`,
  `Goal`). Use them through JSDoc, for example
  `@param {import('../types.js').Parcel} parcel`; do not redefine object
  shapes inline. When a task needs a new shape, add it to `types.js` first.
  `npm run typecheck` must pass at the end of every task.
- Subscribe to server events through the client (`client.onConfig`,
  `onMap`, `onTile`, `onSensing`, `onYou`), not through `client.socket`.
- `src/llm/provider.js` is the only file that calls an LLM API.
- `src/planning/pddl/solve.js` is the only file that imports `pddl-client`.
- The LLM never emits moves; it only produces directives.
- LLM calls happen only when the user types, never inside the agent loop.
- With no directives, behaviour is identical to Part 1.
- Failed moves cost points (`config.PENALTY`): never attempt a move the
  beliefs say will fail.
- Every function that depends on time takes `now` (milliseconds) as an
  argument, so tests never sleep.
- Coordinates: `right` is `x+1`, `left` is `x-1`, `up` is `y+1`, `down` is
  `y-1`. Tile keys are the string `` `${x},${y}` ``.
- Out of scope: two-agent team, opponent modelling, map-specific tuning.

## Review Focus

Conditions the requirements and design imply but does not spell out, most likely first. Each
has a test in the task named.

1. **Fractional positions.** While moving, the server reports positions
   like `x: 3.6`. Beliefs must round them before any pathfinding. (Task 3)
2. **`emitMove` rejects on timeout.** It does not resolve `false`; it
   throws after 1000 ms. The mover must treat a rejection as a failed move
   and not crash. (Task 6)
3. **Nothing reachable.** A map position with no reachable parcel or
   delivery tile must yield an empty or explore-only option list, not an
   exception. (Task 5)
4. **Parcel taken before arrival.** `emitPickup` resolves `[]` when another
   agent got there first. The plan must report failure and the parcel must
   leave beliefs. (Task 6)
5. **Directive outside the world.** An LLM directive with off-map
   coordinates, a wall tile, or an unknown parcel id must be rejected with a
   reason, leaving current directives unchanged. (Task 9)

## File Structure

```
package.json
.env.example
src/
  types.js                  every data structure, as JSDoc typedefs
  config.js                 settings from env
  client.js                 SDK wrapper (only SDK import)
  index.js                  wiring and start
  beliefs/
    map.js                  GridMap: tiles, walkability, neighbours, blocks
    parcels.js              ParcelBeliefs: decay, expiry
    agents.js               AgentBeliefs: other agents' positions
    directives.js           DirectiveBeliefs: user goals and constraints
    index.js                Beliefs: aggregate, event handlers
  planning/
    astar.js                findPath, nearest
    pddl/
      domain.pddl           movement domain
      problem.js            buildProblem, planToDirs
      solve.js              pddlPath (only pddl-client import)
  deliberation/
    utility.js              expectedReward
    options.js              generateOptions, optionKey
  intentions/
    intention.js            Intention
    revision.js             shouldReplace, IntentionRevision
  plans/
    moveTo.js               moveTo, astarPlanner, pddlPlanner
    library.js              GoTo, GoPickUp, GoDeliver, Explore, planLibrary
  llm/
    directives.js           validateDirective, DIRECTIVE_TOOL
    provider.js             complete() (only LLM API call)
    agent.js                LlmAgent
    console.js              terminal prompt
test/
  helpers.js                mapFromRows, fakeClient
  *.test.js                 one per unit
```

---

### Task 1: Project setup, connect and observe (DONE 2026-10-13)

Results are recorded in `docs/server_notes.md` under "Observed on the course server".
Three of them change later tasks, and the notes there have been updated:
the server sends no `you` event (use `client.onYou`), `onMap` reports the
highest index instead of the size, and the config has an energy section
that this plan does not model.

Answers the open items in `docs/server_notes.md` before any logic depends on them.

**Files:**
- Create: `package.json`, `.env.example`, `src/config.js`, `src/client.js`,
  `src/observe.js` (temporary script, deleted in Task 7)
- Test: none (live check)

**Interfaces:**
- Produces: `config` object from `src/config.js`:
  `{ host, token, name, mover, replaceMargin, blockedTtlMs, agentTtlMs,
  maxMoveRetries, pddlTimeoutMs }`
- Produces: `connect(config)` from `src/client.js`, returning
  `{ socket, move(dir), pickup(), putdown(), onYou(callback) }` where
  `onYou` fires for the SDK `you` event and for `sensing.self`, and
  `move(dir): Promise<{x,y}|false>` **never rejects** (a rejection from the
  SDK is caught and returned as `false`), `pickup(): Promise<{id}[]>`,
  `putdown(): Promise<{id}[]>` (both return `[]` on rejection).

- [x] **Step 1: Initialise the package**

```bash
npm init -y
npm pkg set type=module
npm pkg set scripts.start="node src/index.js" scripts.test="node --test" scripts.observe="node src/observe.js"
npm install @unitn-asa/deliveroo-js-sdk socket.io-client @unitn-asa/pddl-client dotenv
```

- [x] **Step 2: Create `.env.example`** and copy it to `.env`

```
HOST=https://deliveroojs.onrender.com
NAME=your-agent-name
TOKEN=
MOVER=astar
```

Check that `.gitignore` lists `.env` (the Node template does). Never commit
`.env`.

- [x] **Step 3: Write `src/config.js`**

Import `dotenv/config` first, then export:

```js
export const config = {
  host: process.env.HOST,
  token: process.env.TOKEN || undefined,
  name: process.env.NAME,
  mover: process.env.MOVER === 'pddl' ? 'pddl' : 'astar',
  replaceMargin: 1.2,     // new option must be 20% better to replace
  blockedTtlMs: 2000,     // how long a failed-move tile stays blocked
  agentTtlMs: 3000,       // how long a sighted agent counts as an obstacle
  maxMoveRetries: 3,
  pddlTimeoutMs: 5000,
};
```

- [x] **Step 4: Write `src/client.js`**

Notes:
- `import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';`
- `const socket = DjsConnect(config.host, config.token, config.name);`
- Wrap the three emitters in `try/catch` so they never reject:
  `move` returns `false` on error; `pickup` and `putdown` return `[]`.
- Return `{ socket, move, pickup, putdown }`.

- [x] **Step 5: Write `src/observe.js`** to log every event once

Subscribe with `socket.onConfig`, `socket.onMap((w, h, tiles) => ...)`,
`socket.onTile`, `socket.onYou`, `socket.onSensing`. Print the config in
full, the map size and the count of tiles per `type`, and the first three
`you` and `sensing` payloads. Also `console.log(await socket.token)`.

- [x] **Step 6: Run it and record the answers**

Run: `npm run observe`
Expected: `Connected`, `Authenticated as ...`, then the logged payloads.

Copy the printed token into `.env` as `TOKEN=` so the agent keeps its
identity. Then write the answers into "Open items" in `docs/server_notes.md`:

| Question | Where to look |
|---|---|
| Value of `GAME.player.movement_duration` (is it under 1000 ms?) | config log |
| Value of `GAME.parcels.decaying_event`, `GAME.player.capacity`, `observation_distance`, `PENALTY`, `CLOCK` | config log |
| Which tile types the map uses (any `5`, `5!`, arrows?) | tile count log |
| How arrow tiles behave | steer the agent by hand onto and off one from the web UI, or `await move('up')` in the script, and note which moves return `false` |
| Are `you.x`/`you.y` fractional mid-move? | `you` log while moving |

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example src/config.js src/client.js src/observe.js docs
git commit -m "chore: project setup and server observation script"
```

---

### Task 2: GridMap

**Files:**
- Create: `src/beliefs/map.js`, `test/helpers.js`
- Test: `test/map.test.js`

**Interfaces:**
- Produces: `key(x, y): string`
- Produces: `DIRS`: `{ up: {dx:0,dy:1}, down: {dx:0,dy:-1}, left: {dx:-1,dy:0}, right: {dx:1,dy:0} }`
- Produces: `class GridMap`
  - `constructor(width, height, tiles)` with `tiles: {x, y, type}[]`
  - `width`, `height`
  - `typeAt(x, y): string | undefined`
  - `updateTile({x, y, type}): void`
  - `block(x, y, untilMs): void`
  - `isWalkable(x, y, now): boolean`
  - `neighbors(x, y, now): {x, y, dir}[]`
  - `deliveryTiles(): {x, y}[]`, `spawnTiles(): {x, y}[]`
- Produces (test helper): `mapFromRows(rows: string[]): GridMap`. The first
  string is the top row (highest `y`); each character is a tile type.

- [ ] **Step 1: Write `test/helpers.js`**

```js
import { GridMap } from '../src/beliefs/map.js';

export function mapFromRows(rows) {
  const height = rows.length;
  const width = [...rows[0]].length;
  const tiles = [];
  rows.forEach((row, i) =>
    [...row].forEach((type, x) => tiles.push({ x, y: height - 1 - i, type })));
  return new GridMap(width, height, tiles);
}
```

- [ ] **Step 2: Write the failing tests** in `test/map.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { key } from '../src/beliefs/map.js';

test('key joins coordinates', () => {
  assert.equal(key(2, 5), '2,5');
});

test('walls, crate tiles and off-map are not walkable', () => {
  const map = mapFromRows(['305', '312']);
  assert.equal(map.isWalkable(0, 0, 0), true);   // '3'
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

// ASSUMPTION until Task 1 Step 6 confirms it: an arrow tile can be entered
// only by a move in the arrow's direction. Change this test if the server
// behaves differently.
test('arrow tiles can only be entered in their direction', () => {
  const map = mapFromRows(['3→3']);
  assert.deepEqual(map.neighbors(0, 0, 0), [{ x: 1, y: 0, dir: 'right' }]);
  assert.deepEqual(map.neighbors(2, 0, 0), []);
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/map.test.js`
Expected: FAIL, cannot find module `../src/beliefs/map.js`

- [ ] **Step 4: Implement `src/beliefs/map.js`**

Notes:
- Store tiles in a `Map` from `key(x, y)` to type string, and blocks in a
  second `Map` from key to `untilMs`.
- `isWalkable`: type exists, type is not `'0'`, does not start with `'5'`,
  and there is no block with `untilMs > now`.
- `neighbors`: for each entry of `DIRS`, compute the target; keep it if
  `isWalkable` and, when the target type is one of `← ↑ → ↓`, only if the
  arrow matches `dir`. Keep the arrow rule in one small function
  `allowsEntry(type, dir)` so it is easy to change after Task 1.
- `deliveryTiles` returns type `'2'`; `spawnTiles` returns type `'1'`.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/map.test.js`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/beliefs/map.js test/helpers.js test/map.test.js
git commit -m "feat: grid map beliefs"
```

---

### Task 3: Parcel, agent and aggregate beliefs

**Files:**
- Create: `src/beliefs/parcels.js`, `src/beliefs/agents.js`,
  `src/beliefs/index.js`
- Test: `test/beliefs.test.js`

**Interfaces:**
- Consumes: `GridMap`, `key` (Task 2)
- Produces: `clockEventMs(event, clockMs): number`. `'1s'` → 1000, `'2s'`
  → 2000, `'5s'` → 5000, `'10s'` → 10000, `'1m'` → 60000, `'1h'` →
  3600000, `'frame'` → `clockMs`, `'infinite'` → `Infinity`.
- Produces: `class ParcelBeliefs`
  - `constructor(decayMs)`
  - `update({positions, parcels}, now): void`
  - `rewardNow(id, now): number`
  - `free(now): {id, x, y, reward}[]` (not carried, reward now > 0;
    `reward` is the estimate at `now`)
  - `carriedBy(agentId, now): {id, reward}[]`
  - `remove(id): void`
- Produces: `class AgentBeliefs`
  - `update(agents, now): void`
  - `occupied(now, ttlMs): Set<string>` of tile keys
- Produces: `class Beliefs extends EventEmitter`
  - fields `me: {id, name, x, y, score} | null`, `map: GridMap | null`,
    `parcels: ParcelBeliefs | null`, `agents: AgentBeliefs`,
    `serverConfig`, `moveMs`, `capacity`, `agentTtlMs`
  - `constructor(agentTtlMs = 3000)`
  - `onConfig(cfg)`, `onMap(width, height, tiles)`, `onTile(tile)`,
    `onYou(agent)`, `onSensing(sensing, now = Date.now())`
  - `ready: boolean` (true once config, map and `me` are all known)
  - emits `'change'` after every handler

- [ ] **Step 1: Write the failing tests** in `test/beliefs.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockEventMs, ParcelBeliefs } from '../src/beliefs/parcels.js';
import { AgentBeliefs } from '../src/beliefs/agents.js';
import { Beliefs } from '../src/beliefs/index.js';

test('clockEventMs parses server clock events', () => {
  assert.equal(clockEventMs('1s', 50), 1000);
  assert.equal(clockEventMs('10s', 50), 10000);
  assert.equal(clockEventMs('frame', 50), 50);
  assert.equal(clockEventMs('infinite', 50), Infinity);
});

test('reward decays by one per decay interval since last seen', () => {
  const p = new ParcelBeliefs(1000);
  p.update({ positions: [{ x: 1, y: 1 }], parcels: [{ id: 'a', x: 1, y: 1, reward: 10 }] }, 0);
  assert.equal(p.rewardNow('a', 0), 10);
  assert.equal(p.rewardNow('a', 2500), 8);
  assert.equal(p.rewardNow('a', 99999), 0);
});

test('no decay when the interval is infinite', () => {
  const p = new ParcelBeliefs(Infinity);
  p.update({ positions: [], parcels: [{ id: 'a', x: 1, y: 1, reward: 10 }] }, 0);
  assert.equal(p.rewardNow('a', 99999), 10);
});

test('free excludes carried and fully decayed parcels', () => {
  const p = new ParcelBeliefs(1000);
  p.update({ positions: [], parcels: [
    { id: 'a', x: 1, y: 1, reward: 10 },
    { id: 'b', x: 2, y: 2, reward: 10, carriedBy: 'other' },
    { id: 'c', x: 3, y: 3, reward: 2 },
  ] }, 0);
  assert.deepEqual(p.free(5000), [{ id: 'a', x: 1, y: 1, reward: 5 }]);
});

test('a parcel is forgotten when its tile is observed without it', () => {
  const p = new ParcelBeliefs(1000);
  p.update({ positions: [{ x: 1, y: 1 }], parcels: [{ id: 'a', x: 1, y: 1, reward: 10 }] }, 0);
  p.update({ positions: [{ x: 5, y: 5 }], parcels: [] }, 100);
  assert.equal(p.free(100).length, 1);          // tile not observed: kept
  p.update({ positions: [{ x: 1, y: 1 }], parcels: [] }, 200);
  assert.equal(p.free(200).length, 0);          // tile observed, parcel gone
});

test('carriedBy lists parcels held by an agent', () => {
  const p = new ParcelBeliefs(1000);
  p.update({ positions: [], parcels: [{ id: 'a', x: 1, y: 1, reward: 10, carriedBy: 'me' }] }, 0);
  assert.deepEqual(p.carriedBy('me', 1000), [{ id: 'a', reward: 9 }]);
});

test('occupied returns rounded tiles of recently seen agents', () => {
  const a = new AgentBeliefs();
  a.update([{ id: 'x', name: 'x', x: 2.6, y: 3, score: 0 }], 0);
  assert.deepEqual([...a.occupied(1000, 3000)], ['3,3']);
  assert.deepEqual([...a.occupied(5000, 3000)], []);
});

// Review Focus 1
test('Beliefs rounds fractional positions of me', () => {
  const b = new Beliefs();
  b.onYou({ id: 'me', name: 'me', x: 3.6, y: 2.4, score: 0 });
  assert.equal(b.me.x, 4);
  assert.equal(b.me.y, 2);
});

test('Beliefs is ready only after config, map and you', () => {
  const b = new Beliefs();
  assert.equal(b.ready, false);
  b.onSensing({ positions: [], agents: [], parcels: [], crates: [] }, 0); // before config: must not throw
  b.onConfig({ CLOCK: 50, PENALTY: 1, GAME: {
    parcels: { decaying_event: '1s' },
    player: { movement_duration: 500, capacity: 5, observation_distance: 5 } } });
  b.onMap(1, 1, [{ x: 0, y: 0, type: '3' }]);
  b.onYou({ id: 'me', name: 'me', x: 0, y: 0, score: 0 });
  assert.equal(b.ready, true);
  assert.equal(b.moveMs, 500);
  assert.equal(b.capacity, 5);
});

test('Beliefs excludes me from the agents store and emits change', () => {
  const b = new Beliefs();
  let changes = 0;
  b.on('change', () => changes++);
  b.onYou({ id: 'me', name: 'me', x: 0, y: 0, score: 0 });
  b.onSensing({ positions: [], agents: [
    { id: 'me', name: 'me', x: 0, y: 0, score: 0 },
    { id: 'o', name: 'o', x: 1, y: 0, score: 0 } ], parcels: [], crates: [] }, 0);
  assert.deepEqual([...b.agents.occupied(0, 3000)], ['1,0']);
  assert.equal(changes, 2);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/beliefs.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement the three files**

Notes:
- `ParcelBeliefs` keeps a `Map` from id to `{id, x, y, reward, carriedBy,
  seenAt}`. `update` first upserts every sensed parcel with `seenAt = now`
  (round `x`, `y`), then deletes each stored, uncarried parcel whose tile is
  in `positions` and whose id is not in the sensed list.
- `rewardNow` is `max(0, reward - floor((now - seenAt) / decayMs))`.
  Dividing by `Infinity` gives 0, so no special case is needed.
- `AgentBeliefs` keeps `{x, y, seenAt}` per id, rounded.
- `Beliefs.onMap` ignores the `width` and `height` it is given when they
  disagree with the tiles (the course server sends 19 for a 20-wide map):
  use highest `x` plus 1 and highest `y` plus 1.
- `Beliefs.onConfig` stores the config, sets `moveMs`, `capacity`, and
  creates `this.parcels = new ParcelBeliefs(clockEventMs(...))`.
- `Beliefs.onSensing` always updates `agents`, after filtering out the
  agent whose id equals `this.me?.id`. It updates `parcels` only when
  `this.parcels` is not null (config may arrive later), and, only when
  `this.map` is not null, blocks tiles holding a crate:
  `map.block(x, y, now + this.agentTtlMs)` for each of `sensing.crates`.
  It emits `'change'` in every case.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/beliefs.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/beliefs test/beliefs.test.js
git commit -m "feat: parcel, agent and aggregate beliefs"
```

---

### Task 4: A* pathfinding

**Files:**
- Create: `src/planning/astar.js`
- Test: `test/astar.test.js`

**Interfaces:**
- Consumes: `GridMap.neighbors`, `key` (Task 2)
- Produces: `findPath(map, from, to, opts): string[] | null`. `from` and
  `to` are `{x, y}`; `opts` is `{ now, occupied?: Set<string>,
  forbidden?: (x, y) => boolean }`. Returns directions such as
  `['right', 'up']`, `[]` when `from` equals `to`, `null` when unreachable.
  A tile in `occupied` or for which `forbidden` is true is never entered,
  **including the target**.
- Produces: `nearest(map, from, targets, opts): { target: {x, y}, path:
  string[] } | null`, the target with the shortest path.

- [ ] **Step 1: Write the failing tests** in `test/astar.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { findPath, nearest } from '../src/planning/astar.js';

const opts = { now: 0 };

test('empty path when already at the target', () => {
  const map = mapFromRows(['33']);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 0, y: 0 }, opts), []);
});

test('straight line', () => {
  const map = mapFromRows(['333']);
  assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, opts), ['right', 'right']);
});

test('routes around a wall with a shortest path', () => {
  const map = mapFromRows(['333', '303', '333']);
  const path = findPath(map, { x: 0, y: 0 }, { x: 2, y: 2 }, opts);
  assert.equal(path.length, 4);
});

test('null when unreachable', () => {
  const map = mapFromRows(['303']);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, opts), null);
});

test('occupied tiles are avoided', () => {
  const map = mapFromRows(['333', '333']);
  const path = findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 },
    { now: 0, occupied: new Set(['1,0']) });
  assert.deepEqual(path, ['up', 'right', 'right', 'down']);
});

test('forbidden tiles are avoided, including as a target', () => {
  const map = mapFromRows(['333']);
  const forbidden = (x, y) => x === 2 && y === 0;
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 }, { now: 0, forbidden }), null);
});

test('nearest picks the closest reachable target', () => {
  const map = mapFromRows(['33333']);
  const got = nearest(map, { x: 1, y: 0 }, [{ x: 4, y: 0 }, { x: 0, y: 0 }], opts);
  assert.deepEqual(got, { target: { x: 0, y: 0 }, path: ['left'] });
});

test('nearest is null when no target is reachable or the list is empty', () => {
  const map = mapFromRows(['303']);
  assert.equal(nearest(map, { x: 0, y: 0 }, [{ x: 2, y: 0 }], opts), null);
  assert.equal(nearest(map, { x: 0, y: 0 }, [], opts), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/astar.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement `src/planning/astar.js`**

Notes:
- A* with the Manhattan distance heuristic. Every step costs 1.
- Open set: an array sorted by `f` is fine for course-size maps.
- Keep `cameFrom: Map<key, {prevKey, dir}>` and rebuild the direction list
  by walking back from the target.
- Expand with `map.neighbors(x, y, opts.now)` and skip any neighbour in
  `opts.occupied` or matching `opts.forbidden`.
- `nearest` calls `findPath` for each target and keeps the shortest.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/astar.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/planning/astar.js test/astar.test.js
git commit -m "feat: A* pathfinding"
```

---

### Task 5: Utility and option generation

**Files:**
- Create: `src/deliberation/utility.js`, `src/deliberation/options.js`
- Test: `test/deliberation.test.js`

**Interfaces:**
- Consumes: `Beliefs` (Task 3), `findPath`, `nearest` (Task 4)
- Produces: `expectedReward({ carried, target, steps, moveMs, decayMs }):
  number`. `carried` is an array of rewards held now, `target` is the
  reward of the parcel to pick up or `null`, `steps` is the total number of
  moves until delivery. Each parcel loses `floor(steps * moveMs / decayMs)`
  and cannot go below 0; the result is the sum.
- Produces: `optionKey(option): string`. `'pickup:<id>'`, `'deliver'`,
  `'explore'`, `'goto:<x>,<y>'`.
- Produces: `generateOptions(beliefs, now): Option[]`, sorted by `utility`
  descending. `Option` is `{ type: 'pickup' | 'deliver' | 'explore', x, y,
  utility, parcelId?, priority: 0 }`.

Rules for `generateOptions`:
- Let `opts = { now, occupied: beliefs.agents.occupied(now, beliefs.agentTtlMs) }`.
- **pickup:** one per free parcel, only when carried count is below
  `beliefs.capacity`, only when a path to it exists and a path from it to a
  delivery tile exists. `steps` is path-to-parcel plus parcel-to-nearest-
  delivery. Utility is `expectedReward` with that parcel as `target`. A
  parcel on the agent's own tile has zero steps to pick up.
- **deliver:** only when carrying at least one parcel and a delivery tile is
  reachable. Target is the nearest delivery tile. Utility is
  `expectedReward` with `target: null`.
- **explore:** always offered when `beliefs.map.spawnTiles()` has a
  reachable tile other than the current one; target is the *farthest*
  reachable spawn tile (a simple, explainable choice; revisit in Task 12).
  Utility is 0.
- Options with utility 0 other than explore are dropped.

- [ ] **Step 1: Write the failing tests** in `test/deliberation.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beliefs } from '../src/beliefs/index.js';
import { expectedReward } from '../src/deliberation/utility.js';
import { generateOptions, optionKey } from '../src/deliberation/options.js';

function beliefsFor(rows, me, parcels, { decay = '1s', moveMs = 500, capacity = 5 } = {}) {
  const b = new Beliefs();
  b.onConfig({ CLOCK: 50, PENALTY: 1, GAME: {
    parcels: { decaying_event: decay },
    player: { movement_duration: moveMs, capacity, observation_distance: 5 } } });
  const h = rows.length;
  const tiles = [];
  rows.forEach((row, i) => [...row].forEach((type, x) => tiles.push({ x, y: h - 1 - i, type })));
  b.onMap([...rows[0]].length, h, tiles);
  b.onYou({ id: 'me', name: 'me', x: me.x, y: me.y, score: 0 });
  b.onSensing({ positions: [], agents: [], parcels, crates: [] }, 0);
  return b;
}

test('expectedReward subtracts decay over the trip from every parcel', () => {
  // 4 steps * 500 ms = 2000 ms = 2 decay ticks
  assert.equal(expectedReward({ carried: [10, 5], target: 8, steps: 4, moveMs: 500, decayMs: 1000 }), 8 + 3 + 6);
});

test('expectedReward floors at zero per parcel and handles no decay', () => {
  assert.equal(expectedReward({ carried: [1], target: null, steps: 10, moveMs: 500, decayMs: 1000 }), 0);
  assert.equal(expectedReward({ carried: [1], target: 4, steps: 10, moveMs: 500, decayMs: Infinity }), 5);
});

test('optionKey identifies options', () => {
  assert.equal(optionKey({ type: 'pickup', parcelId: 'a' }), 'pickup:a');
  assert.equal(optionKey({ type: 'deliver' }), 'deliver');
  assert.equal(optionKey({ type: 'explore' }), 'explore');
  assert.equal(optionKey({ type: 'goto', x: 1, y: 2 }), 'goto:1,2');
});

test('prefers the parcel with the higher expected reward', () => {
  // me at x=2; parcel a far left worth 30, parcel b adjacent worth 5; delivery at x=5
  const b = beliefsFor(['333332'], { x: 2, y: 0 }, [
    { id: 'a', x: 0, y: 0, reward: 30 },
    { id: 'b', x: 3, y: 0, reward: 5 },
  ]);
  const options = generateOptions(b, 0);
  assert.equal(optionKey(options[0]), 'pickup:a');
  assert.ok(options.some(o => optionKey(o) === 'pickup:b'));
});

test('deliver is offered only when carrying', () => {
  const empty = beliefsFor(['332'], { x: 0, y: 0 }, []);
  assert.equal(generateOptions(empty, 0).some(o => o.type === 'deliver'), false);
  const carrying = beliefsFor(['332'], { x: 0, y: 0 },
    [{ id: 'a', x: 0, y: 0, reward: 10, carriedBy: 'me' }]);
  const deliver = generateOptions(carrying, 0).find(o => o.type === 'deliver');
  assert.deepEqual({ x: deliver.x, y: deliver.y, utility: deliver.utility }, { x: 2, y: 0, utility: 9 });
});

test('no pickup options at full capacity', () => {
  const b = beliefsFor(['332'], { x: 0, y: 0 }, [
    { id: 'a', x: 0, y: 0, reward: 10, carriedBy: 'me' },
    { id: 'b', x: 1, y: 0, reward: 10 },
  ], { capacity: 1 });
  assert.equal(generateOptions(b, 0).some(o => o.type === 'pickup'), false);
});

test('explore targets a spawn tile when there is nothing else', () => {
  const b = beliefsFor(['3331'], { x: 0, y: 0 }, []);
  const options = generateOptions(b, 0);
  assert.equal(options.length, 1);
  assert.deepEqual({ type: options[0].type, x: options[0].x }, { type: 'explore', x: 3 });
});

// Review Focus 3
test('unreachable parcels and delivery tiles produce no options and no throw', () => {
  const b = beliefsFor(['302'], { x: 0, y: 0 }, [{ id: 'a', x: 2, y: 0, reward: 10 }]);
  assert.deepEqual(generateOptions(b, 0), []);
});

test('a parcel is not an option when it cannot be delivered', () => {
  const b = beliefsFor(['333'], { x: 0, y: 0 }, [{ id: 'a', x: 1, y: 0, reward: 10 }]);
  assert.equal(generateOptions(b, 0).some(o => o.type === 'pickup'), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/deliberation.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement `utility.js` then `options.js`**

Notes:
- `generateOptions` returns `[]` when `beliefs.ready` is false.
- Read `decayMs` from `beliefs.parcels.decayMs` (expose it as a public
  field of `ParcelBeliefs`).
- Carried rewards come from `beliefs.parcels.carriedBy(beliefs.me.id, now)`.
- Give every option `priority: 0`. Task 9 adds options with `priority: 1`.
- Sort by `priority` descending, then `utility` descending.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/deliberation.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/deliberation test/deliberation.test.js
git commit -m "feat: utility scoring and option generation"
```

---

### Task 6: Movement and the plan library

**Files:**
- Create: `src/plans/moveTo.js`, `src/plans/library.js`
- Modify: `test/helpers.js` (add `fakeClient`)
- Test: `test/plans.test.js`

**Interfaces:**
- Consumes: `Beliefs`, `findPath`, `connect()` shape from Task 1
- Produces: `ctx` object used by every plan: `{ beliefs, client, config,
  now: () => number }`
- Produces: `signal` object: `{ stopped: boolean }`
- Produces: `astarPlanner(ctx, from, to, opts): Promise<string[] | null>`
  (wraps `findPath`)
- Produces: `moveTo(ctx, target, signal, planner): Promise<boolean>`.
  Resolves `true` on arrival, `false` when stopped, unreachable, or out of
  retries.
- Produces: `planLibrary(planner): PlanClass[]` returning `[GoPickUp,
  GoDeliver, Explore, GoTo]`, each with
  `static isApplicableTo(option): boolean` and
  `execute(ctx, option, signal): Promise<boolean>`.
- Produces (test helper): `fakeClient(beliefs, { failMoves = [],
  rejectMoves = [], pickupResult })`. `move(dir)` updates `beliefs.me` and
  returns the new `{x, y}`; when the target key is in `failMoves` it returns
  `false`; when in `rejectMoves` it throws. Records calls in `.calls`.

Rules for `moveTo`:
1. Loop while `beliefs.me` is not at `target`:
   a. If `signal.stopped`, return `false`.
   b. `path = await planner(ctx, me, target, { now, occupied, forbidden })`
      where `occupied` is `beliefs.agents.occupied(now, beliefs.agentTtlMs)`
      and `forbidden` is `(x, y) => beliefs.directives.isForbidden(x, y)`
      when `beliefs.directives` exists (it does not until Task 9), else
      undefined. If the path is `null`, return `false`.
   c. Take only the **first** step. Call `client.move(dir)` inside
      `try/catch`.
   d. On `false` or a thrown error: block the target tile until
      `now + config.blockedTtlMs`, count a failure, and return `false` once
      failures reach `config.maxMoveRetries`.
   e. On success: set `beliefs.me.x`, `beliefs.me.y` from the result
      (rounded) and reset nothing else.
2. Return `true`.

Replanning after every step keeps the agent reactive. For the PDDL mover,
which is slow, Task 8 passes a planner that caches its plan.

Rules for plans:
- `GoTo` (`type: 'goto'`): `moveTo` the option's tile.
- `GoPickUp` (`type: 'pickup'`): `moveTo`, then `client.pickup()`. If the
  result is empty, call `beliefs.parcels.remove(option.parcelId)` and
  return `false`.
- `GoDeliver` (`type: 'deliver'`): `moveTo`, then `client.putdown()`.
  Return `true` when at least one parcel was dropped; remove the dropped
  ids from `beliefs.parcels`.
- `Explore` (`type: 'explore'`): `moveTo`; return its result.

- [ ] **Step 1: Add `fakeClient` to `test/helpers.js`**

```js
import { DIRS, key } from '../src/beliefs/map.js';

export function fakeClient(beliefs, { failMoves = [], rejectMoves = [], pickupResult } = {}) {
  const calls = [];
  return {
    calls,
    async move(dir) {
      calls.push(dir);
      const x = beliefs.me.x + DIRS[dir].dx;
      const y = beliefs.me.y + DIRS[dir].dy;
      if (rejectMoves.includes(key(x, y))) throw new Error('operation has timed out');
      if (failMoves.includes(key(x, y))) return false;
      return { x, y };
    },
    async pickup() { calls.push('pickup'); return pickupResult ?? [{ id: 'a' }]; },
    async putdown() { calls.push('putdown'); return [{ id: 'a' }]; },
  };
}
```

Note that `fakeClient.move` throws for `rejectMoves`, unlike the real
`client.move` from Task 1, which already catches. The test proves `moveTo`
is safe either way.

- [ ] **Step 2: Write the failing tests** in `test/plans.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beliefs } from '../src/beliefs/index.js';
import { fakeClient } from './helpers.js';
import { moveTo, astarPlanner } from '../src/plans/moveTo.js';
import { planLibrary } from '../src/plans/library.js';

const config = { blockedTtlMs: 2000, agentTtlMs: 3000, maxMoveRetries: 3 };

function setup(rows, me, parcels = [], clientOpts = {}) {
  const beliefs = new Beliefs();
  beliefs.onConfig({ CLOCK: 50, PENALTY: 1, GAME: {
    parcels: { decaying_event: '1s' },
    player: { movement_duration: 500, capacity: 5, observation_distance: 5 } } });
  const h = rows.length;
  const tiles = [];
  rows.forEach((row, i) => [...row].forEach((type, x) => tiles.push({ x, y: h - 1 - i, type })));
  beliefs.onMap([...rows[0]].length, h, tiles);
  beliefs.onYou({ id: 'me', name: 'me', x: me.x, y: me.y, score: 0 });
  beliefs.onSensing({ positions: [], agents: [], parcels, crates: [] }, 0);
  const client = fakeClient(beliefs, clientOpts);
  return { beliefs, client, ctx: { beliefs, client, config, now: () => 0 } };
}

const plan = (type) => planLibrary(astarPlanner).find(P => P.isApplicableTo({ type }));

test('moveTo walks to the target', async () => {
  const { ctx, beliefs, client } = setup(['333'], { x: 0, y: 0 });
  assert.equal(await moveTo(ctx, { x: 2, y: 0 }, { stopped: false }, astarPlanner), true);
  assert.deepEqual(client.calls, ['right', 'right']);
  assert.deepEqual({ x: beliefs.me.x, y: beliefs.me.y }, { x: 2, y: 0 });
});

test('moveTo stops when the signal is set', async () => {
  const { ctx, client } = setup(['333'], { x: 0, y: 0 });
  assert.equal(await moveTo(ctx, { x: 2, y: 0 }, { stopped: true }, astarPlanner), false);
  assert.deepEqual(client.calls, []);
});

test('moveTo blocks a failed tile and routes around it', async () => {
  const { ctx, beliefs } = setup(['333', '333'], { x: 0, y: 0 }, [], { failMoves: ['1,0'] });
  assert.equal(await moveTo(ctx, { x: 2, y: 0 }, { stopped: false }, astarPlanner), true);
  assert.equal(beliefs.map.isWalkable(1, 0, 0), false);
});

test('moveTo gives up when the only route keeps failing', async () => {
  const { ctx, client } = setup(['333'], { x: 0, y: 0 }, [], { failMoves: ['1,0'] });
  assert.equal(await moveTo(ctx, { x: 2, y: 0 }, { stopped: false }, astarPlanner), false);
  assert.equal(client.calls.length, 1);   // blocked after one failure, then no path
});

// Review Focus 2
test('moveTo treats a rejected move as a failure, not a crash', async () => {
  const { ctx } = setup(['333'], { x: 0, y: 0 }, [], { rejectMoves: ['1,0'] });
  assert.equal(await moveTo(ctx, { x: 2, y: 0 }, { stopped: false }, astarPlanner), false);
});

test('GoPickUp moves then picks up', async () => {
  const { ctx, client } = setup(['33'], { x: 0, y: 0 }, [{ id: 'a', x: 1, y: 0, reward: 5 }]);
  const P = plan('pickup');
  const ok = await new P().execute(ctx, { type: 'pickup', parcelId: 'a', x: 1, y: 0 }, { stopped: false });
  assert.equal(ok, true);
  assert.deepEqual(client.calls, ['right', 'pickup']);
});

// Review Focus 4
test('GoPickUp fails and forgets the parcel when someone else took it', async () => {
  const { ctx, beliefs } = setup(['33'], { x: 0, y: 0 },
    [{ id: 'a', x: 1, y: 0, reward: 5 }], { pickupResult: [] });
  const P = plan('pickup');
  const ok = await new P().execute(ctx, { type: 'pickup', parcelId: 'a', x: 1, y: 0 }, { stopped: false });
  assert.equal(ok, false);
  assert.equal(beliefs.parcels.free(0).length, 0);
});

test('GoDeliver moves then puts down', async () => {
  const { ctx, client } = setup(['32'], { x: 0, y: 0 },
    [{ id: 'a', x: 0, y: 0, reward: 5, carriedBy: 'me' }]);
  const P = plan('deliver');
  assert.equal(await new P().execute(ctx, { type: 'deliver', x: 1, y: 0 }, { stopped: false }), true);
  assert.deepEqual(client.calls, ['right', 'putdown']);
});

test('every option type has exactly one applicable plan', () => {
  for (const type of ['pickup', 'deliver', 'explore', 'goto'])
    assert.equal(planLibrary(astarPlanner).filter(P => P.isApplicableTo({ type })).length, 1);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/plans.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 4: Implement `moveTo.js` and `library.js`**

Notes:
- `planLibrary(planner)` builds the four classes as closures over `planner`
  so the mover is chosen once, at start-up.
- `moveTo` reads the agent position fresh from `ctx.beliefs.me` at the top
  of each loop iteration: server `you` events may also update it.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/plans.test.js`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add src/plans test/helpers.js test/plans.test.js
git commit -m "feat: movement and plan library"
```

---

### Task 7: Intentions, revision loop and the running agent

This completes the core of Part 1: a full BDI agent with the A* mover.

**Files:**
- Create: `src/intentions/intention.js`, `src/intentions/revision.js`,
  `src/index.js`
- Delete: `src/observe.js` (and the `observe` script in `package.json`)
- Test: `test/intentions.test.js`

**Interfaces:**
- Consumes: `generateOptions`, `optionKey` (Task 5), `planLibrary`,
  `astarPlanner` (Task 6), `Beliefs`, `connect`, `config`
- Produces: `class Intention`
  - `constructor(option, plans, ctx)`
  - `option`, `signal: {stopped}`
  - `achieve(): Promise<boolean>`: runs the first applicable plan; `false`
    when none applies or the plan throws
  - `stop(): void`: sets `signal.stopped = true`
- Produces: `shouldReplace(current, best, margin): boolean` where both
  arguments are options or `null`
- Produces: `class IntentionRevision`
  - `constructor(ctx, plans, generate = generateOptions)`
  - `current: Intention | null`
  - `reconsider(): void`: called on every belief change
  - `start(): Promise<never>`: the loop

Rules for `shouldReplace`:
- `best` is `null` → `false`.
- `current` is `null` → `true`.
- Same `optionKey` → `false`.
- `best.priority > current.priority` → `true`;
  `best.priority < current.priority` → `false`.
- Otherwise `best.utility > current.utility * margin` **and**
  `best.utility - current.utility >= 1`. The second condition stops an
  agent exploring at utility 0 from thrashing between zero-value options.

Rules for the loop (`start`):
1. Wait until `beliefs.ready`.
2. `options = generate(beliefs, now)`; if empty, wait for the next
   `'change'` event and repeat.
3. `current = new Intention(options[0], plans, ctx)`;
   `await current.achieve()`; set `current = null`; repeat.

Rules for `reconsider`: if there is a `current`, compute options and, when
`shouldReplace(current.option, options[0] ?? null, config.replaceMargin)`,
call `current.stop()`. The loop then picks the new best on its next pass.
Refresh `current.option.utility` from the matching fresh option before
comparing, so a decaying target is judged at its present value.

- [ ] **Step 1: Write the failing tests** in `test/intentions.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Intention } from '../src/intentions/intention.js';
import { shouldReplace } from '../src/intentions/revision.js';

const pickup = (id, utility, priority = 0) => ({ type: 'pickup', parcelId: id, utility, priority });

test('shouldReplace: nothing to switch to', () => {
  assert.equal(shouldReplace(pickup('a', 5), null, 1.2), false);
});

test('shouldReplace: idle agent takes any option', () => {
  assert.equal(shouldReplace(null, pickup('a', 5), 1.2), true);
});

test('shouldReplace: never replaces an option with itself', () => {
  assert.equal(shouldReplace(pickup('a', 5), pickup('a', 50), 1.2), false);
});

test('shouldReplace: needs to beat the margin', () => {
  assert.equal(shouldReplace(pickup('a', 10), pickup('b', 11), 1.2), false);
  assert.equal(shouldReplace(pickup('a', 10), pickup('b', 13), 1.2), true);
});

test('shouldReplace: explore at utility 0 yields to a real option, not to another zero', () => {
  const explore = { type: 'explore', utility: 0, priority: 0 };
  assert.equal(shouldReplace(explore, pickup('a', 3), 1.2), true);
  assert.equal(shouldReplace(explore, { type: 'goto', x: 1, y: 1, utility: 0, priority: 0 }, 1.2), false);
});

test('shouldReplace: higher priority always wins, lower never does', () => {
  assert.equal(shouldReplace(pickup('a', 99, 0), pickup('b', 1, 1), 1.2), true);
  assert.equal(shouldReplace(pickup('a', 1, 1), pickup('b', 99, 0), 1.2), false);
});

class Works { static isApplicableTo(o) { return o.type === 'x'; } async execute() { return true; } }
class Throws { static isApplicableTo(o) { return o.type === 'y'; } async execute() { throw new Error('boom'); } }
class SeesSignal { static isApplicableTo(o) { return o.type === 'z'; } async execute(ctx, o, signal) { return signal.stopped; } }

test('Intention runs the applicable plan', async () => {
  assert.equal(await new Intention({ type: 'x' }, [Works, Throws], {}).achieve(), true);
});

test('Intention fails when no plan applies or the plan throws', async () => {
  assert.equal(await new Intention({ type: 'none' }, [Works], {}).achieve(), false);
  assert.equal(await new Intention({ type: 'y' }, [Throws], {}).achieve(), false);
});

test('Intention.stop is visible to the running plan', async () => {
  const i = new Intention({ type: 'z' }, [SeesSignal], {});
  i.stop();
  assert.equal(await i.achieve(), true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/intentions.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement `intention.js` and `revision.js`**

Notes:
- `Intention.achieve` logs the option key at start and the result at end;
  these logs are what you show in the oral exam.
- In `IntentionRevision.start`, "wait for the next change" is
  `await new Promise(r => beliefs.once('change', r))`.
- Add a 50 ms pause after a failed intention so a permanently failing
  option cannot spin the CPU.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/intentions.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Write `src/index.js`**

Wiring, in order:
1. `const client = connect(config)`
2. `const beliefs = new Beliefs(config.agentTtlMs)`
3. Forward events: `client.onConfig(c => beliefs.onConfig(c))`, and the
   same for `onMap`, `onTile`, `onSensing` and `onYou`.
4. `const ctx = { beliefs, client, config, now: () => Date.now() }`
5. `const agent = new IntentionRevision(ctx, planLibrary(astarPlanner))`
6. `beliefs.on('change', () => agent.reconsider())`
7. `agent.start()`

- [ ] **Step 6: Remove the observation script**

```bash
git rm src/observe.js
npm pkg delete scripts.observe
```

- [ ] **Step 7: Run the whole suite, then run live**

Run: `npm test`
Expected: PASS, all tests

Run: `npm start` and watch the agent in the browser at the `HOST` URL.
Expected within two minutes: the agent picks up parcels, delivers them, the
score rises, and the log shows intentions being replaced when a better
parcel appears. Note the score after 5 minutes as the A* baseline.

- [ ] **Step 8: Commit**

```bash
git add -A src test package.json
git commit -m "feat: intention revision loop and runnable BDI agent"
```

---

### Task 8: PDDL mover

This completes Part 1 (external planner).

**Files:**
- Create: `src/planning/pddl/domain.pddl`, `src/planning/pddl/problem.js`,
  `src/planning/pddl/solve.js`
- Modify: `src/plans/moveTo.js` (add `pddlPlanner`), `src/index.js`
  (choose the planner from `config.mover`)
- Test: `test/pddl.test.js`

**Interfaces:**
- Consumes: `GridMap.neighbors`, `findPath`, `astarPlanner`
- Produces: `tileName(x, y): string` → `` `t_${x}_${y}` ``
- Produces: `buildProblem(map, from, to, opts): string`, PDDL problem text
  with the same `opts` as `findPath`
- Produces: `planToDirs(plan): string[]`, mapping
  `[{action: 'move-up', ...}]` to `['up']`, case-insensitive
- Produces: `pddlPath(map, from, to, opts, { solver, domain, timeoutMs }):
  Promise<string[] | null>`. `null` on no plan, solver error or timeout.
- Produces: `pddlPlanner(ctx, from, to, opts): Promise<string[] | null>`,
  same signature as `astarPlanner`

- [ ] **Step 1: Write `src/planning/pddl/domain.pddl`**

The domain name must be `default`, because `PddlProblem.toPddlString()` in
`pddl-client` hard-codes `(:domain default)`.

```pddl
(define (domain default)
  (:requirements :strips)
  (:predicates
    (at ?t)
    (up ?from ?to)
    (down ?from ?to)
    (left ?from ?to)
    (right ?from ?to))
  (:action move-up
    :parameters (?from ?to)
    :precondition (and (at ?from) (up ?from ?to))
    :effect (and (at ?to) (not (at ?from))))
  (:action move-down
    :parameters (?from ?to)
    :precondition (and (at ?from) (down ?from ?to))
    :effect (and (at ?to) (not (at ?from))))
  (:action move-left
    :parameters (?from ?to)
    :precondition (and (at ?from) (left ?from ?to))
    :effect (and (at ?to) (not (at ?from))))
  (:action move-right
    :parameters (?from ?to)
    :precondition (and (at ?from) (right ?from ?to))
    :effect (and (at ?to) (not (at ?from)))))
```

- [ ] **Step 2: Write the failing tests** in `test/pddl.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFromRows } from './helpers.js';
import { buildProblem, planToDirs, tileName } from '../src/planning/pddl/problem.js';
import { pddlPath } from '../src/planning/pddl/solve.js';

const opts = { now: 0 };

test('tileName is a valid PDDL object name', () => {
  assert.equal(tileName(3, 12), 't_3_12');
});

test('problem lists walkable tiles, adjacency, start and goal', () => {
  const map = mapFromRows(['303']);
  const text = buildProblem(map, { x: 0, y: 0 }, { x: 2, y: 0 }, opts);
  assert.match(text, /\(:domain default\)/);
  assert.match(text, /\(:objects [^)]*t_0_0[^)]*t_2_0/);
  assert.doesNotMatch(text, /t_1_0/);                 // wall is not an object
  assert.match(text, /\(at t_0_0\)/);
  assert.match(text, /\(:goal \(at t_2_0\)\)/);
});

test('adjacency facts follow map.neighbors', () => {
  const map = mapFromRows(['33']);
  const text = buildProblem(map, { x: 0, y: 0 }, { x: 1, y: 0 }, opts);
  assert.match(text, /\(right t_0_0 t_1_0\)/);
  assert.match(text, /\(left t_1_0 t_0_0\)/);
  assert.doesNotMatch(text, /\(up /);
});

test('occupied and forbidden tiles are left out of adjacency', () => {
  const map = mapFromRows(['333']);
  const text = buildProblem(map, { x: 0, y: 0 }, { x: 2, y: 0 },
    { now: 0, occupied: new Set(['1,0']) });
  assert.doesNotMatch(text, /\(right t_0_0 t_1_0\)/);
});

test('planToDirs maps solver steps to directions', () => {
  assert.deepEqual(planToDirs([
    { parallel: false, action: 'MOVE-UP', args: ['T_0_0', 'T_0_1'] },
    { parallel: false, action: 'move-right', args: ['t_0_1', 't_1_1'] },
  ]), ['up', 'right']);
});

test('pddlPath returns directions from the solver plan', async () => {
  const map = mapFromRows(['33']);
  const solver = async () => [{ parallel: false, action: 'move-right', args: [] }];
  assert.deepEqual(
    await pddlPath(map, { x: 0, y: 0 }, { x: 1, y: 0 }, opts, { solver, domain: 'd', timeoutMs: 100 }),
    ['right']);
});

test('pddlPath returns [] without calling the solver when already there', async () => {
  const map = mapFromRows(['33']);
  let called = false;
  const solver = async () => { called = true; return []; };
  assert.deepEqual(
    await pddlPath(map, { x: 0, y: 0 }, { x: 0, y: 0 }, opts, { solver, domain: 'd', timeoutMs: 100 }), []);
  assert.equal(called, false);
});

test('pddlPath is null on no plan, on solver error and on timeout', async () => {
  const map = mapFromRows(['33']);
  const args = [map, { x: 0, y: 0 }, { x: 1, y: 0 }, opts];
  assert.equal(await pddlPath(...args, { solver: async () => undefined, domain: 'd', timeoutMs: 100 }), null);
  assert.equal(await pddlPath(...args, { solver: async () => { throw new Error('500'); }, domain: 'd', timeoutMs: 100 }), null);
  assert.equal(await pddlPath(...args, { solver: () => new Promise(() => {}), domain: 'd', timeoutMs: 20 }), null);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/pddl.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 4: Implement `problem.js` and `solve.js`**

Notes for `problem.js`:
- Iterate `x` in `0..width-1`, `y` in `0..height-1`. A tile is an object
  when `map.isWalkable(x, y, now)`.
- For each object tile, for each `map.neighbors(x, y, now)` not in
  `occupied` and not `forbidden`, emit `(<dir> <tile> <neighbour>)`.
- Build the text yourself in the exact shape `pddl-client` uses, or import
  `PddlProblem` only in `solve.js` and pass a builder in. Building the
  string directly keeps `problem.js` free of the dependency:

```
(define (problem default)
    (:domain default)
    (:objects t_0_0 t_1_0)
    (:init (at t_0_0) (right t_0_0 t_1_0) (left t_1_0 t_0_0))
    (:goal (at t_1_0))
)
```

Notes for `solve.js`:
- Default `solver` is `onlineSolver` from `@unitn-asa/pddl-client`. Default
  `domain` is the content of `domain.pddl`, read once with
  `fs.readFileSync(new URL('./domain.pddl', import.meta.url), 'utf8')`.
- Timeout with `Promise.race([solver(domain, problem), timeoutPromise])`
  where the timeout promise resolves to `undefined`. Clear the timer in a
  `finally`.
- Wrap everything in `try/catch` and return `null` on any error.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/pddl.test.js`
Expected: PASS, 8 tests

- [ ] **Step 6: Add `pddlPlanner` to `src/plans/moveTo.js`**

Because `moveTo` asks for a path before every step and a solver call takes
from a fraction of a second to several seconds, `pddlPlanner` caches:

- Keep `{ targetKey, remaining: string[] }` in module scope.
- If the cache is for the same target and the agent is where the cache
  expects (track the expected position as you shift steps off), return
  `remaining`.
- Otherwise call `pddlPath(...)` with `timeoutMs: ctx.config.pddlTimeoutMs`
  and cache the result.
- If `pddlPath` returns `null`, log `PDDL failed, falling back to A*` and
  return `astarPlanner(ctx, from, to, opts)`.
- `moveTo` must drop the first step of the cache after a successful move
  and clear the cache after a failed one. Do this by having `moveTo` call
  an optional `planner.onStep?.(ok)` hook, which `astarPlanner` leaves
  undefined.

Add this test to `test/plans.test.js`:

```js
import { pddlPlanner } from '../src/plans/moveTo.js';

test('pddlPlanner falls back to A* when the solver fails', async () => {
  const { ctx } = setup(['333'], { x: 0, y: 0 });
  ctx.config = { ...config, pddlTimeoutMs: 20 };
  ctx.pddlSolver = async () => { throw new Error('solver down'); };
  assert.equal(await moveTo(ctx, { x: 2, y: 0 }, { stopped: false }, pddlPlanner), true);
});
```

`pddlPlanner` passes `ctx.pddlSolver` (undefined in production, so the
default `onlineSolver` is used) through to `pddlPath` as `solver`.

- [ ] **Step 7: Select the planner in `src/index.js`**

```js
const planner = config.mover === 'pddl' ? pddlPlanner : astarPlanner;
const agent = new IntentionRevision(ctx, planLibrary(planner));
```

- [ ] **Step 8: Run the suite, then run live with PDDL**

Run: `npm test`
Expected: PASS, all tests

Run: `MOVER=pddl npm start`
Expected: the log shows `POSTING planning request to ...` and
`Plan found:`, the agent delivers parcels, and killing the network briefly
produces `PDDL failed, falling back to A*` without the agent stopping. Note
the 5-minute score next to the A* baseline from Task 7.

If the solver host is unreachable, set `PAAS_HOST` in `.env` (see
`node_modules/@unitn-asa/pddl-client/.env.example`) and record which host
worked in the open items in `docs/server_notes.md`.

- [ ] **Step 9: Commit**

```bash
git add src/planning/pddl src/plans/moveTo.js src/index.js test/pddl.test.js test/plans.test.js
git commit -m "feat: PDDL mover with A* fallback"
```

---

### Task 9: Directives in the BDI agent

Part 2 without the LLM: the agent obeys hand-written directives.

**Files:**
- Create: `src/llm/directives.js`, `src/beliefs/directives.js`
- Modify: `src/beliefs/index.js` (add `directives` field),
  `src/deliberation/options.js` (goals and constraints),
  `src/intentions/revision.js` (goal status, pause)
- Test: `test/directives.test.js`

**Interfaces:**
- Produces: directive shapes (plain objects):
  - `{ type: 'goto', x, y }`
  - `{ type: 'pickup', parcelId }`
  - `{ type: 'deliverNow' }`
  - `{ type: 'pause' }`, `{ type: 'resume' }`, `{ type: 'clear' }`
  - `{ type: 'avoidArea', rect: {x1, y1, x2, y2} }`
  - `{ type: 'stayInArea', rect: {x1, y1, x2, y2} }`
  - `{ type: 'minParcelReward', value }`
  - `{ type: 'maxCarried', value }`
- Produces: `validateDirective(d, beliefs, now): { ok: true, directive } |
  { ok: false, error: string }`
- Produces: `class DirectiveBeliefs extends EventEmitter`
  - `apply(directive): void` (assumes already validated)
  - `paused: boolean`
  - `goals(): { id, directive, status }[]` with status `'pending' |
    'active' | 'done' | 'failed'`
  - `pendingGoal(): { id, directive } | null` (oldest pending or active)
  - `setGoalStatus(id, status, reason?): void`, emits
    `'goal-status', { id, directive, status, reason }`
  - `minParcelReward: number` (default 0), `maxCarried: number` (default
    `Infinity`)
  - `isForbidden(x, y): boolean`
  - `summary(): string[]` (human-readable list of what is active)
- Modifies: `Beliefs` gains `directives = new DirectiveBeliefs()`; a change
  in directives re-emits `'change'`.
- Modifies: `generateOptions` adds user-goal options with `priority: 1` and
  a `goalId` field, and applies constraints.

Validation rules:
- Unknown `type` → error `unknown directive type "<type>"`.
- `goto`: `x`, `y` integers, on the map, and `map.isWalkable` → else error
  `(x,y) is not a walkable tile`.
- `pickup`: `parcelId` must be among `beliefs.parcels.free(now)` → else
  error `no free parcel "<id>" is known`.
- `avoidArea`, `stayInArea`: four integers; normalise so `x1 <= x2` and
  `y1 <= y2`; the rectangle must overlap the map → else error
  `area is outside the map`.
- `minParcelReward`: number `>= 0`. `maxCarried`: integer `>= 1`.

How directives change behaviour:
- `isForbidden(x, y)`: true inside any `avoidArea`, or outside the
  `stayInArea` when one is set. Passed as `forbidden` to path planning in
  `generateOptions` and in `moveTo` (already wired in Task 6).
- `minParcelReward`: pickup options whose parcel's reward now is below the
  value are dropped.
- `maxCarried`: effective capacity is `min(beliefs.capacity, maxCarried)`.
- `paused`: `generateOptions` returns `[]`; `IntentionRevision.reconsider`
  stops the current intention.
- User goals: the oldest pending goal becomes one option with
  `priority: 1`: `goto` → `{type: 'goto', x, y}`, `pickup` →
  `{type: 'pickup', parcelId, x, y}`, `deliverNow` → the normal deliver
  option raised to priority 1. If no path exists, or `deliverNow` is given
  while carrying nothing, set the goal `'failed'` with a reason and emit no
  option for it.
- `IntentionRevision`: when an intention carrying a `goalId` starts, set
  `'active'`; when it ends, set `'done'` or `'failed'` (reason
  `could not complete`). A stopped intention goes back to `'pending'`.
- `clear`: removes all constraints and all pending goals, and unpauses.

- [ ] **Step 1: Write the failing tests** in `test/directives.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beliefs } from '../src/beliefs/index.js';
import { validateDirective } from '../src/llm/directives.js';
import { generateOptions, optionKey } from '../src/deliberation/options.js';

function beliefsFor(rows, me, parcels = []) {
  const b = new Beliefs();
  b.onConfig({ CLOCK: 50, PENALTY: 1, GAME: {
    parcels: { decaying_event: 'infinite' },
    player: { movement_duration: 500, capacity: 5, observation_distance: 5 } } });
  const h = rows.length;
  const tiles = [];
  rows.forEach((row, i) => [...row].forEach((type, x) => tiles.push({ x, y: h - 1 - i, type })));
  b.onMap([...rows[0]].length, h, tiles);
  b.onYou({ id: 'me', name: 'me', x: me.x, y: me.y, score: 0 });
  b.onSensing({ positions: [], agents: [], parcels, crates: [] }, 0);
  return b;
}

test('valid directives pass through', () => {
  const b = beliefsFor(['332'], { x: 0, y: 0 });
  assert.deepEqual(validateDirective({ type: 'goto', x: 1, y: 0 }, b, 0),
    { ok: true, directive: { type: 'goto', x: 1, y: 0 } });
  assert.equal(validateDirective({ type: 'pause' }, b, 0).ok, true);
  assert.equal(validateDirective({ type: 'minParcelReward', value: 5 }, b, 0).ok, true);
});

test('rectangles are normalised', () => {
  const b = beliefsFor(['333', '333'], { x: 0, y: 0 });
  const r = validateDirective({ type: 'avoidArea', rect: { x1: 2, y1: 1, x2: 0, y2: 0 } }, b, 0);
  assert.deepEqual(r.directive.rect, { x1: 0, y1: 0, x2: 2, y2: 1 });
});

// Review Focus 5
test('directives outside the world are rejected with a reason', () => {
  const b = beliefsFor(['302'], { x: 0, y: 0 });
  assert.deepEqual(validateDirective({ type: 'goto', x: 9, y: 9 }, b, 0),
    { ok: false, error: '(9,9) is not a walkable tile' });
  assert.equal(validateDirective({ type: 'goto', x: 1, y: 0 }, b, 0).ok, false);   // wall
  assert.equal(validateDirective({ type: 'goto', x: 0.5, y: 0 }, b, 0).ok, false);
  assert.deepEqual(validateDirective({ type: 'pickup', parcelId: 'zz' }, b, 0),
    { ok: false, error: 'no free parcel "zz" is known' });
  assert.deepEqual(validateDirective({ type: 'avoidArea', rect: { x1: 10, y1: 10, x2: 12, y2: 12 } }, b, 0),
    { ok: false, error: 'area is outside the map' });
  assert.deepEqual(validateDirective({ type: 'dance' }, b, 0),
    { ok: false, error: 'unknown directive type "dance"' });
  assert.equal(validateDirective({ type: 'maxCarried', value: 0 }, b, 0).ok, false);
  assert.equal(validateDirective(null, b, 0).ok, false);
});

test('with no directives options are unchanged', () => {
  const b = beliefsFor(['3332'], { x: 0, y: 0 }, [{ id: 'a', x: 1, y: 0, reward: 10 }]);
  // no spawn tiles on this map, so no explore option: same result as Part 1
  assert.deepEqual(generateOptions(b, 0).map(optionKey), ['pickup:a']);
});

test('a goto goal outranks a valuable parcel', () => {
  const b = beliefsFor(['3332'], { x: 0, y: 0 }, [{ id: 'a', x: 1, y: 0, reward: 99 }]);
  b.directives.apply({ type: 'goto', x: 2, y: 0 });
  const top = generateOptions(b, 0)[0];
  assert.equal(optionKey(top), 'goto:2,0');
  assert.equal(top.priority, 1);
  assert.ok(top.goalId);
});

test('an unreachable goal is marked failed and produces no option', () => {
  const b = beliefsFor(['3332'], { x: 0, y: 0 });
  b.directives.apply({ type: 'avoidArea', rect: { x1: 1, y1: 0, x2: 1, y2: 0 } });
  b.directives.apply({ type: 'goto', x: 2, y: 0 });
  const options = generateOptions(b, 0);
  assert.equal(options.some(o => o.type === 'goto'), false);
  assert.equal(b.directives.goals()[0].status, 'failed');
});

test('deliverNow with nothing carried fails', () => {
  const b = beliefsFor(['32'], { x: 0, y: 0 });
  b.directives.apply({ type: 'deliverNow' });
  generateOptions(b, 0);
  assert.equal(b.directives.goals()[0].status, 'failed');
});

test('minParcelReward filters cheap parcels', () => {
  const b = beliefsFor(['3332'], { x: 0, y: 0 }, [
    { id: 'cheap', x: 1, y: 0, reward: 3 }, { id: 'rich', x: 2, y: 0, reward: 30 }]);
  b.directives.apply({ type: 'minParcelReward', value: 10 });
  const keys = generateOptions(b, 0).map(optionKey);
  assert.ok(keys.includes('pickup:rich'));
  assert.equal(keys.includes('pickup:cheap'), false);
});

test('maxCarried lowers capacity', () => {
  const b = beliefsFor(['3332'], { x: 0, y: 0 }, [
    { id: 'held', x: 0, y: 0, reward: 5, carriedBy: 'me' }, { id: 'b', x: 1, y: 0, reward: 30 }]);
  b.directives.apply({ type: 'maxCarried', value: 1 });
  assert.equal(generateOptions(b, 0).some(o => o.type === 'pickup'), false);
});

test('avoidArea and stayInArea forbid tiles', () => {
  const b = beliefsFor(['3333'], { x: 0, y: 0 });
  b.directives.apply({ type: 'avoidArea', rect: { x1: 3, y1: 0, x2: 3, y2: 0 } });
  assert.equal(b.directives.isForbidden(3, 0), true);
  assert.equal(b.directives.isForbidden(2, 0), false);
  b.directives.apply({ type: 'stayInArea', rect: { x1: 0, y1: 0, x2: 1, y2: 0 } });
  assert.equal(b.directives.isForbidden(2, 0), true);
  assert.equal(b.directives.isForbidden(1, 0), false);
});

test('pause empties the options, resume restores them, clear resets all', () => {
  const b = beliefsFor(['3332'], { x: 0, y: 0 }, [{ id: 'a', x: 1, y: 0, reward: 10 }]);
  b.directives.apply({ type: 'pause' });
  assert.deepEqual(generateOptions(b, 0), []);
  b.directives.apply({ type: 'resume' });
  assert.ok(generateOptions(b, 0).length > 0);
  b.directives.apply({ type: 'minParcelReward', value: 50 });
  b.directives.apply({ type: 'clear' });
  assert.equal(b.directives.minParcelReward, 0);
  assert.equal(b.directives.paused, false);
});

test('goal status changes are emitted', () => {
  const b = beliefsFor(['33'], { x: 0, y: 0 });
  const seen = [];
  b.directives.on('goal-status', e => seen.push(e.status));
  b.directives.apply({ type: 'goto', x: 1, y: 0 });
  const { id } = b.directives.pendingGoal();
  b.directives.setGoalStatus(id, 'active');
  b.directives.setGoalStatus(id, 'done');
  assert.deepEqual(seen, ['active', 'done']);
  assert.equal(b.directives.pendingGoal(), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/directives.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement**, in this order: `src/llm/directives.js`,
  `src/beliefs/directives.js`, the `Beliefs` field, `generateOptions`
  changes, `IntentionRevision` changes.

Notes:
- Goal ids: a counter, `g1`, `g2`, ...
- `apply` of a goal directive stores it as `'pending'` without emitting
  `'goal-status'`; only `setGoalStatus` emits that event. Every `apply`
  emits `'change'`.
- In `IntentionRevision`, treat `signal.stopped` after `achieve()` returns
  as "interrupted", not "failed".

- [ ] **Step 4: Run to verify they pass, and that nothing regressed**

Run: `npm test`
Expected: PASS, all tests including Tasks 2 to 8

- [ ] **Step 5: Try it live with hand-written directives**

Temporarily add to `src/index.js`, after the wiring:

```js
setTimeout(() => beliefs.directives.apply({ type: 'pause' }), 20000);
setTimeout(() => beliefs.directives.apply({ type: 'resume' }), 30000);
```

Run: `npm start`
Expected: the agent stops moving at 20 s and resumes at 30 s. Remove the
two lines afterwards.

- [ ] **Step 6: Commit**

```bash
git add src test/directives.test.js
git commit -m "feat: user directives as goals and constraints in the BDI agent"
```

---

### Task 10: LLM agent with a fake provider

**Files:**
- Create: `src/llm/agent.js`
- Modify: `src/llm/directives.js` (add `DIRECTIVE_TOOL`)
- Test: `test/llm-agent.test.js`

**Interfaces:**
- Consumes: `validateDirective`, `Beliefs`, `DirectiveBeliefs`
- Produces: `DIRECTIVE_TOOL`: a JSON-schema tool definition
  `{ name: 'set_directives', description, input_schema }` whose input is
  `{ directives: object[], reply: string }`
- Produces: provider contract (implemented in Task 11):
  `complete({ system, messages, tool }): Promise<{ input: { directives,
  reply } | null, text: string }>`
- Produces: `class LlmAgent`
  - `constructor({ provider, beliefs, now = () => Date.now() })`
  - `handle(userText): Promise<{ reply: string, applied: object[],
    rejected: { directive, error }[] }>`
  - `buildSystemPrompt(): string`

Rules for `handle`:
1. Append `{ role: 'user', content: userText }` to the conversation (keep
   the last 10 messages).
2. Call `provider.complete({ system: this.buildSystemPrompt(), messages,
   tool: DIRECTIVE_TOOL })` inside `try/catch`.
3. On a thrown error: return `{ reply: 'LLM unavailable: <message>. Current
   directives are unchanged.', applied: [], rejected: [] }`.
4. On `input === null` or `input.directives` not an array: return the
   provider's `text` (or `I could not turn that into an instruction.`) with
   nothing applied.
5. Validate **all** directives first. If any is invalid, apply **none**,
   and return a reply listing each error. All-or-nothing keeps the agent
   from half-obeying an instruction.
6. Otherwise apply each with `beliefs.directives.apply` and return
   `input.reply`.

`buildSystemPrompt` contains: the role ("you translate the user's
instructions into directives for a delivery agent; you never move the agent
yourself"), the directive types with one example each, the coordinate
convention, map width and height, the agent's position, the parcels it
carries, known free parcels with id, position and reward, delivery tiles,
and `beliefs.directives.summary()`.

- [ ] **Step 1: Write the failing tests** in `test/llm-agent.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beliefs } from '../src/beliefs/index.js';
import { LlmAgent } from '../src/llm/agent.js';
import { DIRECTIVE_TOOL } from '../src/llm/directives.js';

function beliefs() {
  const b = new Beliefs();
  b.onConfig({ CLOCK: 50, PENALTY: 1, GAME: {
    parcels: { decaying_event: 'infinite' },
    player: { movement_duration: 500, capacity: 5, observation_distance: 5 } } });
  b.onMap(3, 1, [{ x: 0, y: 0, type: '3' }, { x: 1, y: 0, type: '3' }, { x: 2, y: 0, type: '2' }]);
  b.onYou({ id: 'me', name: 'me', x: 0, y: 0, score: 0 });
  b.onSensing({ positions: [], agents: [], parcels: [{ id: 'p7', x: 1, y: 0, reward: 12 }], crates: [] }, 0);
  return b;
}

const providerReturning = (input, text = '') => {
  const calls = [];
  return { calls, async complete(req) { calls.push(req); return { input, text }; } };
};

test('the tool schema names the directives array and the reply', () => {
  assert.equal(DIRECTIVE_TOOL.name, 'set_directives');
  assert.deepEqual(DIRECTIVE_TOOL.input_schema.required.sort(), ['directives', 'reply']);
});

test('valid directives are applied and the reply returned', async () => {
  const b = beliefs();
  const provider = providerReturning({ directives: [{ type: 'goto', x: 2, y: 0 }], reply: 'Heading to (2,0).' });
  const out = await new LlmAgent({ provider, beliefs: b, now: () => 0 }).handle('go to the delivery zone');
  assert.equal(out.reply, 'Heading to (2,0).');
  assert.equal(out.applied.length, 1);
  assert.equal(b.directives.pendingGoal().directive.type, 'goto');
});

test('the prompt carries the state the LLM needs', async () => {
  const b = beliefs();
  const provider = providerReturning({ directives: [], reply: 'ok' });
  await new LlmAgent({ provider, beliefs: b, now: () => 0 }).handle('hello');
  const { system, messages, tool } = provider.calls[0];
  assert.match(system, /p7/);
  assert.match(system, /3 ?x ?1|width.*3/i);
  assert.equal(messages.at(-1).content, 'hello');
  assert.equal(tool, DIRECTIVE_TOOL);
});

test('one invalid directive means none are applied', async () => {
  const b = beliefs();
  const provider = providerReturning({ directives: [
    { type: 'minParcelReward', value: 5 }, { type: 'goto', x: 99, y: 99 }], reply: 'Done.' });
  const out = await new LlmAgent({ provider, beliefs: b, now: () => 0 }).handle('do things');
  assert.equal(out.applied.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.match(out.reply, /\(99,99\) is not a walkable tile/);
  assert.equal(b.directives.minParcelReward, 0);
});

test('no tool call returns the text and changes nothing', async () => {
  const b = beliefs();
  const out = await new LlmAgent({ provider: providerReturning(null, 'Which parcel do you mean?'), beliefs: b })
    .handle('get that one');
  assert.equal(out.reply, 'Which parcel do you mean?');
  assert.equal(b.directives.pendingGoal(), null);
});

test('malformed tool input changes nothing', async () => {
  const b = beliefs();
  const out = await new LlmAgent({ provider: providerReturning({ directives: 'goto 2 0', reply: 'x' }), beliefs: b })
    .handle('go');
  assert.equal(out.applied.length, 0);
  assert.equal(b.directives.pendingGoal(), null);
});

test('a provider error is reported and directives are kept', async () => {
  const b = beliefs();
  b.directives.apply({ type: 'minParcelReward', value: 7 });
  const provider = { async complete() { throw new Error('rate limited'); } };
  const out = await new LlmAgent({ provider, beliefs: b }).handle('go');
  assert.match(out.reply, /LLM unavailable: rate limited/);
  assert.equal(b.directives.minParcelReward, 7);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/llm-agent.test.js`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement `DIRECTIVE_TOOL` and `LlmAgent`**

Notes:
- `DIRECTIVE_TOOL.input_schema` is
  `{ type: 'object', required: ['directives', 'reply'], properties: {
  directives: { type: 'array', items: { type: 'object', required: ['type'],
  properties: { type: { enum: [...the ten types] }, x: {type:'integer'},
  y: {type:'integer'}, parcelId: {type:'string'}, value: {type:'number'},
  rect: { type: 'object', properties: { x1, y1, x2, y2 as integers } } } } },
  reply: { type: 'string' } } }`.
- The schema is a hint to the model; `validateDirective` is the guard.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/llm-agent.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/llm test/llm-agent.test.js
git commit -m "feat: LLM agent translating instructions into validated directives"
```

---

### Task 11: LLM provider and console

This completes Part 2.

**Before starting:** settle the open item on the LLM in `docs/server_notes.md`. Ask the
course staff (a) which provider and model are allowed or supplied, and (b)
whether the LLM agent must be a separate Deliveroo agent that talks to the
BDI agent with game messages. This task assumes (b) is "no": one process,
direct calls. If (b) is "yes", keep everything here and add a transport:
the console process calls `socket.emitSay(bdiAgentId, directive)` and the
BDI process calls `beliefs.directives.apply` inside `socket.onMsg` after
`validateDirective`.

**Files:**
- Create: `src/llm/provider.js`, `src/llm/console.js`
- Modify: `src/config.js`, `.env.example`, `src/index.js`
- Test: none for `provider.js` (it is the network edge); live check

**Interfaces:**
- Consumes: `LlmAgent`, `DIRECTIVE_TOOL`
- Produces: `createProvider(config.llm): { complete({ system, messages,
  tool }) }` honouring the contract from Task 10
- Produces: `startConsole(llmAgent, beliefs): void`

- [ ] **Step 1: Add LLM settings**

`.env.example`:

```
LLM_API_KEY=
LLM_MODEL=
```

`src/config.js`, inside `config`:

```js
llm: { apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL },
```

- [ ] **Step 2: Install the provider's official SDK** for the provider the
  course allows, and write `src/llm/provider.js`

`complete` must:
1. Send `system`, `messages` and the single tool, and force or strongly
   prefer a call to `set_directives`.
2. Find the tool call in the response and return `{ input: <its parsed
   arguments>, text: <any plain text> }`, or `{ input: null, text }` when
   the model did not call the tool.
3. Let API errors throw; `LlmAgent.handle` already catches them.
4. Use a request timeout of 30 seconds.

Follow the provider's current tool-use documentation for the exact request
and response fields; they differ between providers, which is why this file
is the only place that knows about them.

- [ ] **Step 3: Write `src/llm/console.js`**

Notes:
- `readline.createInterface({ input: process.stdin, output: process.stdout })`
  with prompt `you> `.
- On each line: `const { reply } = await llmAgent.handle(line)`, print
  `agent> ${reply}`, re-prompt. Ignore empty lines.
- Local commands that skip the LLM: `/status` prints
  `beliefs.directives.summary()` and `beliefs.directives.goals()`.
- Subscribe once: `beliefs.directives.on('goal-status', e => ...)` and
  print, for example, `agent> goal g1 (goto 2,0): done` or
  `agent> goal g2 (pickup p7): failed, could not complete`.

- [ ] **Step 4: Start the console from `src/index.js`** only when a key is
  configured

```js
if (config.llm.apiKey) {
  const llmAgent = new LlmAgent({ provider: createProvider(config.llm), beliefs });
  startConsole(llmAgent, beliefs);
}
```

Reduce the agent's own per-step logging (or send it to a file) so it does
not bury the console prompt.

- [ ] **Step 5: Live check with a fixed script of instructions**

Run: `npm start`, then type each line and compare with the browser view:

| Instruction | Expected |
|---|---|
| `stop for a moment` | agent halts; `/status` shows paused |
| `carry on` | agent resumes |
| `only take parcels worth at least 20` | cheap parcels are ignored |
| `go to the bottom-left corner` | agent walks there, console reports `done` |
| `stay out of the top half of the map` | agent never enters it |
| `go to 999, 999` | reply explains the tile is not valid; behaviour unchanged |
| `forget all of that` | constraints cleared, normal behaviour |
| (unplug network) `deliver now` | `LLM unavailable: ...`, agent keeps playing |

- [ ] **Step 6: Run the suite and commit**

Run: `npm test`
Expected: PASS, all tests

```bash
git add src .env.example package.json package-lock.json
git commit -m "feat: LLM provider and instruction console"
```

---

### Task 12: Tuning and write-up of results

**Files:**
- Modify: `src/config.js`, `src/deliberation/options.js` (explore only),
  `README.md`
- Test: existing suite must stay green

- [ ] **Step 1: Measure before changing anything**

Run each for 5 minutes on the same map and record the score:
`npm start`, `MOVER=pddl npm start`.

- [ ] **Step 2: Tune one constant at a time**, re-measuring after each

| Constant | Try | Watch for |
|---|---|---|
| `replaceMargin` | 1.0, 1.2, 1.5 | thrashing between parcels (too low) or ignoring a much better parcel (too high) |
| `blockedTtlMs` | 1000, 2000, 4000 | repeated failed moves and penalties (too low) or long detours (too high) |
| `agentTtlMs` | 1000, 3000 | walking into agents that have moved on, or avoiding empty tiles |
| `pddlTimeoutMs` | 2000, 5000 | frequent fallback to A* (too low) or long stalls (too high) |

- [ ] **Step 3: Improve explore if the agent idles in one area**

Replace "farthest reachable spawn tile" with "spawn tile seen longest ago":
keep a `lastSeen` timestamp per tile, updated from `sensing.positions` in
`Beliefs.onSensing`, and pick the reachable spawn tile with the oldest one.
Update the explore test in `test/deliberation.test.js` to set the
timestamps explicitly, then make it pass.

- [ ] **Step 4: Update `README.md`**

Sections: what it is, setup (`npm install`, `.env`), how to run each mode,
the architecture diagram from `docs/design.md`, a results table (A* and PDDL
5-minute scores, map name), and the list of supported instructions.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS, all tests

```bash
git add -A
git commit -m "chore: tuning, explore improvement and README"
```

---

## Design coverage

| Design item | Task |
|---|---|
| `config.js`, `client.js`, open items | 1 |
| `beliefs/map.js`, directional and crate tiles | 2 |
| `beliefs/parcels.js`, `agents.js`, `index.js` | 3 |
| `planning/astar.js` | 4 |
| `deliberation/utility.js`, `options.js`, deliver decision, explore | 5 |
| `plans/`, move failure handling, parcel gone on arrival | 6 |
| `intentions/`, intention revision, `index.js` | 7 |
| `planning/pddl/`, PDDL scope, solver fallback | 8 |
| `llm/directives.js`, `beliefs/directives.js`, user goals, constraints, unreachable goal | 9 |
| `llm/agent.js`, invalid LLM output, LLM API error | 10 |
| `llm/provider.js`, `llm/console.js`, latency rule | 11 |
| Live comparison of A* and PDDL, tuning | 12 |
| Disconnect | Handled by the SDK's socket reconnection; beliefs rebuild from the `map`, `you` and `sensing` events that follow. Verify in Task 7 Step 7 by toggling the network. |
