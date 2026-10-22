import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesFromRows } from './helpers.js';
import { Beliefs } from '../src/beliefs/index.js';
import { listOptions } from '../src/deliberation/options.js';

/**
 * @typedef {import('../src/types.js').Parcel} Parcel
 * @typedef {import('../src/types.js').ServerConfig} ServerConfig
 */

/**
 * Ready beliefs on a map drawn as rows, with the agent at `me`. Moves take
 * 200 ms and parcels lose a point per second, so a point every 5 moves.
 * @param {string[]} rows
 * @param {{ x: number, y: number }} me
 * @param {{ capacity?: number, decay?: import('../src/types.js').ClockEvent }} [settings]
 */
function world(rows, me, { capacity = 5, decay = '1s' } = {}) {
  const clock = { t: 0 };
  const beliefs = new Beliefs({ now: () => clock.t, agentTtlMs: 3000, blockedTtlMs: 2000 });
  /** @type {ServerConfig} */
  const config = {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    GAME: {
      title: 'test',
      description: '',
      parcels: { generation_event: '2s', decaying_event: decay, max: 5, reward_avg: 30, reward_variance: 10 },
      player: { movement_duration: 200, observation_distance: 5, capacity },
    },
  };
  beliefs.onConfig(config);
  beliefs.onMap(0, 0, tilesFromRows(rows));
  beliefs.onYou({ id: 'me', name: 'me', x: me.x, y: me.y, score: 0 });
  return { beliefs, clock };
}

/**
 * Tell the beliefs about these parcels, without any tile in view.
 * @param {Beliefs} beliefs
 * @param {Parcel[]} parcels
 */
function see(beliefs, parcels) {
  beliefs.onSensing({ positions: [], agents: [], parcels, crates: [] });
}

/**
 * @param {string} id
 * @param {number} x
 * @param {number} reward
 * @param {string | null} [carriedBy]
 * @returns {Parcel}
 */
function parcel(id, x, reward, carriedBy = null) {
  return { id, x, y: 0, reward, carriedBy };
}

test('nothing is offered before the beliefs are ready', () => {
  const beliefs = new Beliefs({ agentTtlMs: 3000, blockedTtlMs: 2000 });
  assert.deepEqual(listOptions(beliefs), []);
});

test('a pickup is scored for the walk to the parcel and on to delivery', () => {
  const { beliefs } = world(['2333333333'], { x: 9, y: 0 });
  see(beliefs, [parcel('p', 4, 10)]);
  // 5 moves to the parcel, 4 more to the delivery tile: 9 moves, 1.8 s.
  const [pickup] = listOptions(beliefs);
  assert.deepEqual(pickup, { id: 'pickup:p', type: 'pickup', x: 4, y: 0, utility: 9, priority: 0, parcelId: 'p' });
});

test('the more rewarding parcel ranks first even when it is further away', () => {
  // Delivery at x 0, agent at x 5. p1 (10) is 2 moves away and 3 from
  // delivery: 5 moves, worth 9. p2 (30) is 10 moves away and 15 from
  // delivery: 25 moves, worth 25.
  const { beliefs } = world(['2333333333333333'], { x: 5, y: 0 });
  see(beliefs, [parcel('p1', 3, 10), parcel('p2', 15, 30)]);
  const options = listOptions(beliefs).filter(o => o.type === 'pickup');
  assert.deepEqual(options.map(o => [o.parcelId, o.utility]), [['p2', 25], ['p1', 9]]);
});

test('a pickup counts the decay of the parcels already carried', () => {
  const { beliefs } = world(['2333333333'], { x: 9, y: 0 });
  see(beliefs, [parcel('c', 9, 20, 'me'), parcel('p', 4, 10)]);
  const pickup = listOptions(beliefs).find(o => o.type === 'pickup');
  assert.equal(pickup?.utility, 19 + 9);
});

test('deliver is offered only while carrying, to the nearest delivery tile', () => {
  const { beliefs } = world(['2333332'], { x: 4, y: 0 });
  assert.equal(listOptions(beliefs).some(o => o.type === 'deliver'), false);
  see(beliefs, [parcel('c', 4, 10, 'me')]);
  const deliver = listOptions(beliefs).find(o => o.type === 'deliver');
  assert.deepEqual(deliver, { id: 'deliver', type: 'deliver', x: 6, y: 0, utility: 10, priority: 0 });
});

test('no pickup is offered at full capacity', () => {
  const { beliefs } = world(['2333'], { x: 3, y: 0 }, { capacity: 1 });
  see(beliefs, [parcel('c', 3, 10, 'me'), parcel('p', 1, 10)]);
  assert.deepEqual(listOptions(beliefs).map(o => o.type), ['deliver']);
});

test('explore heads for the spawn tile seen longest ago, worth nothing', () => {
  const { beliefs } = world(['13331'], { x: 2, y: 0 });
  beliefs.map?.markSeen([{ x: 0, y: 0 }], 500);
  beliefs.map?.markSeen([{ x: 4, y: 0 }], 100);
  assert.deepEqual(listOptions(beliefs), [{ id: 'explore:4,0', type: 'explore', x: 4, y: 0, utility: 0, priority: 0 }]);
});

test('options worth something come before exploring', () => {
  const { beliefs } = world(['2313'], { x: 3, y: 0 });
  see(beliefs, [parcel('p', 1, 10)]);
  assert.deepEqual(listOptions(beliefs).map(o => o.type), ['pickup', 'explore']);
});

test('parcels that would be worthless on delivery are left out', () => {
  // The trip is 9 moves, which costs 1 point: all this parcel has.
  const { beliefs } = world(['2333333333'], { x: 9, y: 0 });
  see(beliefs, [parcel('p', 5, 1)]);
  assert.deepEqual(listOptions(beliefs), []);
});

test('nothing is offered for parcels and tiles that cannot be reached', () => {
  // The parcel at x 4 is behind a wall; the one at x 1 can be reached, but
  // no delivery tile can be reached from it.
  const { beliefs } = world(['3303320'], { x: 1, y: 0 });
  see(beliefs, [parcel('far', 4, 10), parcel('here', 1, 10)]);
  assert.deepEqual(listOptions(beliefs), []);
  see(beliefs, [parcel('c', 1, 10, 'me')]);
  assert.equal(listOptions(beliefs).some(o => o.type === 'deliver'), false);
});
