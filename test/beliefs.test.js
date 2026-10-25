import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beliefs } from '../src/beliefs/index.js';

/** @typedef {import('../src/types.js').ServerConfig} ServerConfig */

/** @returns {ServerConfig} */
function serverConfig(decay = /** @type {import('../src/types.js').ClockEvent} */ ('1s')) {
  return {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    GAME: {
      title: 'test',
      description: '',
      parcels: { generation_event: '2s', decaying_event: decay, max: 5, reward_avg: 30, reward_variance: 10 },
      player: { movement_duration: 200, observation_distance: 5, capacity: 5 },
    },
  };
}

/** A 3 x 2 map of walkable tiles. */
function tiles() {
  /** @type {import('../src/types.js').Tile[]} */
  const result = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) result.push({ x, y, type: '3' });
  return result;
}

const ME = { id: 'me', name: 'me', x: 0, y: 0, score: 0 };

/**
 * Beliefs with a clock the test controls.
 * @param {number} [start]
 */
function makeBeliefs(start = 0) {
  const clock = { t: start };
  const beliefs = new Beliefs({ now: () => clock.t, agentTtlMs: 3000, blockedTtlMs: 2000 });
  return { beliefs, clock };
}

/** Beliefs that have received the config, the map and the agent itself. */
function readyBeliefs() {
  const made = makeBeliefs();
  made.beliefs.onConfig(serverConfig());
  made.beliefs.onMap(2, 1, tiles());
  made.beliefs.onYou(ME);
  return made;
}

/**
 * @param {Partial<import('../src/types.js').Sensing>} sensing
 * @returns {import('../src/types.js').Sensing}
 */
function sensing(sensing) {
  return { positions: [], agents: [], parcels: [], crates: [], ...sensing };
}

test('the map size is taken from the tiles, not the map message', () => {
  const { beliefs } = makeBeliefs();
  beliefs.onMap(2, 1, tiles());
  assert.equal(beliefs.map?.width, 3);
  assert.equal(beliefs.map?.height, 2);
});

test("the agent's own position is rounded", () => {
  const { beliefs } = makeBeliefs();
  beliefs.onYou({ ...ME, x: 1.6, y: 0.4, score: 7 });
  assert.deepEqual(beliefs.me, { id: 'me', name: 'me', x: 2, y: 0, score: 7 });
});

test('the agent itself is not counted as another agent', () => {
  const { beliefs } = readyBeliefs();
  beliefs.onSensing(sensing({ agents: [ME, { ...ME, id: 'other', x: 2, y: 1 }] }));
  assert.deepEqual([...beliefs.agents.occupied(0)], ['2,1']);
  assert.equal(beliefs.agents.get('me'), undefined);
});

test('tiles in view are marked as seen now', () => {
  const { beliefs, clock } = readyBeliefs();
  clock.t = 1234;
  beliefs.onSensing(sensing({ positions: [{ x: 1, y: 1 }] }));
  assert.equal(beliefs.map?.lastSeen(1, 1), 1234);
  assert.equal(beliefs.map?.lastSeen(0, 0), -Infinity);
});

test('parcels are fed from sensing and decay with the server setting', () => {
  const { beliefs, clock } = readyBeliefs();
  beliefs.onSensing(sensing({ parcels: [{ id: 'p', x: 1, y: 0, reward: 10, carriedBy: null }] }));
  clock.t = 3000;
  assert.deepEqual(beliefs.parcels.free(clock.t).map(p => [p.id, p.reward]), [['p', 7]]);
});

test('times in the beliefs follow the game clock, not the local clock', () => {
  const { beliefs, clock } = readyBeliefs();          // CLOCK is 50 ms per frame
  beliefs.onSensing(sensing({ frame: 1000, parcels: [{ id: 'p', x: 1, y: 0, reward: 10, carriedBy: null }] }));
  clock.t = 10_000;                                    // 10 s on the local clock...
  beliefs.onPing(1040);                                // ...but only 2 s on the server's
  assert.equal(beliefs.now(), 52_000);
  assert.equal(beliefs.parcels.get('p', beliefs.now())?.reward, 8);
});

test('the agent learns what it carries from its own pickup and putdown', () => {
  const { beliefs } = readyBeliefs();
  beliefs.onMap(2, 1, [...tiles().filter(t => !(t.x === 1 && t.y === 0)), { x: 1, y: 0, type: '2' }]);
  beliefs.onSensing(sensing({ parcels: [{ id: 'p', x: 0, y: 0, reward: 10, carriedBy: null }] }));
  beliefs.onPickup([{ id: 'p' }]);
  assert.deepEqual(beliefs.parcels.carriedBy('me', 0).map(p => p.id), ['p']);
  beliefs.onYou({ ...ME, x: 1, y: 0 });                // onto the delivery tile
  beliefs.onPutdown([{ id: 'p' }]);
  assert.deepEqual(beliefs.parcels.carriedBy('me', 0), []);
  assert.equal(beliefs.parcels.get('p', 0), undefined);
});

test('a parcel put down off a delivery tile is left there, free', () => {
  const { beliefs } = readyBeliefs();
  beliefs.onSensing(sensing({ parcels: [{ id: 'p', x: 0, y: 0, reward: 10, carriedBy: 'me' }] }));
  beliefs.onYou({ ...ME, x: 2, y: 1 });
  beliefs.onPutdown([{ id: 'p' }]);
  assert.deepEqual(beliefs.parcels.free(0).map(p => [p.id, p.x, p.y]), [['p', 2, 1]]);
});

test('a tile holding a crate is blocked for a short time', () => {
  const { beliefs, clock } = readyBeliefs();
  clock.t = 100;
  beliefs.onSensing(sensing({ crates: [{ id: 'c', x: 1, y: 1 }] }));
  assert.equal(beliefs.map?.isWalkable(1, 1, 2099), false);
  assert.equal(beliefs.map?.isWalkable(1, 1, 2100), true);
});

test('a tile event changes the map', () => {
  const { beliefs } = readyBeliefs();
  beliefs.onTile({ x: 1, y: 1, type: '0' });
  assert.equal(beliefs.map?.isWalkable(1, 1, 0), false);
});

test('beliefs become ready only when config, map and self have all arrived', () => {
  const { beliefs } = makeBeliefs();
  assert.equal(beliefs.ready, false);
  beliefs.onYou(ME);
  assert.equal(beliefs.ready, false);
  beliefs.onMap(2, 1, tiles());
  assert.equal(beliefs.ready, false);
  beliefs.onConfig(serverConfig());
  assert.equal(beliefs.ready, true);
});

test('every update is announced', () => {
  const { beliefs } = makeBeliefs();
  let changes = 0;
  beliefs.onChange(() => changes++);
  beliefs.onConfig(serverConfig());
  beliefs.onMap(2, 1, tiles());
  beliefs.onTile({ x: 0, y: 0, type: '2' });
  beliefs.onYou(ME);
  beliefs.onSensing(sensing({}));
  assert.equal(changes, 5);
});

test('listen feeds beliefs from the client', () => {
  /** @type {Record<string, Function>} */
  const handlers = {};
  const client = /** @type {import('../src/types.js').Client} */ (/** @type {unknown} */ ({
    onConfig: (/** @type {Function} */ cb) => { handlers.config = cb; },
    onMap: (/** @type {Function} */ cb) => { handlers.map = cb; },
    onTile: (/** @type {Function} */ cb) => { handlers.tile = cb; },
    onSensing: (/** @type {Function} */ cb) => { handlers.sensing = cb; },
    onYou: (/** @type {Function} */ cb) => { handlers.you = cb; },
    onPing: (/** @type {Function} */ cb) => { handlers.ping = cb; },
  }));
  const { beliefs } = makeBeliefs();
  beliefs.listen(client);
  handlers.config(serverConfig());
  handlers.map(2, 1, tiles());
  handlers.you(ME);
  handlers.sensing(sensing({ positions: [{ x: 0, y: 0 }] }));
  assert.equal(beliefs.ready, true);
  assert.equal(beliefs.map?.lastSeen(0, 0), 0);
  handlers.ping(20);
  assert.equal(beliefs.now(), 1000);
});

test('another agent is forgotten once sensing shows its tile without it', () => {
  const { beliefs } = readyBeliefs();
  beliefs.onSensing(sensing({ positions: [{ x: 2, y: 1 }], agents: [{ ...ME, id: 'other', x: 2, y: 1 }] }));
  beliefs.onSensing(sensing({ positions: [{ x: 2, y: 1 }] }));
  assert.deepEqual([...beliefs.agents.occupied(0)], []);
});
