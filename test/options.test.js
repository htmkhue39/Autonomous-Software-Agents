import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesFromRows } from './helpers.js';
import { Beliefs } from '../src/beliefs/index.js';
import { listOptions } from '../src/deliberation/options.js';
import { reconsider } from '../src/intentions/revision.js';

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
  assert.deepEqual(pickup, { id: 'pickup:p', type: 'pickup', x: 4, y: 0, utility: 9, priority: 0, parcelId: 'p',
    deliverX: 0, deliverY: 0 });
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
  assert.deepEqual(deliver, { id: 'deliver:6,0', type: 'deliver', x: 6, y: 0, utility: 10, priority: 0 });
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

test('unlimited capacity still permits pickup', () => {
  const { beliefs } = world(['2313'], { x: 3, y: 0 }, { capacity: -1 });
  see(beliefs, [parcel('c', 3, 10, 'me'), parcel('p', 1, 10)]);
  assert.ok(listOptions(beliefs).some(o => o.id === 'pickup:p'));
});

test('each delivery tile is its own option, so a failed tile can be skipped', () => {
  // Delivery tiles at x 0 and x 6; the agent at x 2 is nearer to x 0.
  const { beliefs } = world(['2333332'], { x: 2, y: 0 });
  see(beliefs, [parcel('c', 2, 10, 'me')]);
  assert.equal(listOptions(beliefs).find(o => o.type === 'deliver')?.id, 'deliver:0,0');
  const other = listOptions(beliefs, { excluded: new Set(['deliver:0,0']) }).find(o => o.type === 'deliver');
  assert.equal(other?.id, 'deliver:6,0');
});

test('standing on a delivery tile while carrying ranks delivering here first', () => {
  // A pickup would be worth more (both parcels), but delivering here costs
  // no moves at all, so it gets the higher priority.
  const { beliefs } = world(['3323'], { x: 2, y: 0 }, { decay: 'infinite' });
  see(beliefs, [parcel('c', 2, 10, 'me'), parcel('p', 0, 30)]);
  const [first] = listOptions(beliefs);
  assert.deepEqual(first, { id: 'deliver:2,0', type: 'deliver', x: 2, y: 0, utility: 10, priority: 1 });
});

test('net_gain offers a pickup only when it beats delivering first by minGain points', () => {
  // A point is lost every 5 moves, and time costs nothing here. The agent at
  // x 3 carries 'c' (10); delivering at x 0 takes 3 moves.
  // 'near' (5) at x 2 lies on that route: 3 moves in all, worth 15.
  // Delivering first and coming back for it takes 7 moves, worth 10 + 4 = 14,
  // so fetching it first gains 1 point.
  // 'even' (4) at x 8 and 'far' (3) at x 9 gain nothing: fetching first loses
  // as many points of decay from 'c' as delivering first saves.
  const { beliefs } = world(['2333333333'], { x: 3, y: 0 });
  see(beliefs, [parcel('c', 3, 10, 'me'), parcel('near', 2, 5), parcel('even', 8, 4), parcel('far', 9, 3)]);
  const ids = (/** @type {import('../src/deliberation/options.js').OptionPolicy} */ policy) =>
    listOptions(beliefs, policy).map(o => o.id).sort();
  assert.deepEqual(ids({ strategy: 'baseline' }), ['deliver:0,0', 'pickup:even', 'pickup:far', 'pickup:near']);
  assert.deepEqual(ids({ strategy: 'net_gain', minGain: 1 }), ['deliver:0,0', 'pickup:near']);
  assert.equal(listOptions(beliefs, { strategy: 'net_gain', minGain: 1 })[0].id, 'pickup:near');
  assert.deepEqual(ids({ strategy: 'net_gain', minGain: 2 }), ['deliver:0,0']);
});

test('net_gain always scores the current intention, even below minGain', () => {
  const { beliefs } = world(['2333333333'], { x: 3, y: 0 });
  see(beliefs, [parcel('c', 3, 10, 'me'), parcel('even', 8, 4)]);
  // Fetching 'even' first is worth 10, delivering first and fetching it after
  // 11, so the pickup is offered at what it gains over that, on top of the
  // 10 that delivering now is worth: 10 - 1.
  const kept = listOptions(beliefs, { strategy: 'net_gain', minGain: 1, keep: 'pickup:even' });
  assert.equal(kept.find(o => o.id === 'pickup:even')?.utility, 9);
});

test('net_gain offers any pickup when nothing is carried', () => {
  const { beliefs } = world(['2333333333'], { x: 3, y: 0 }, { decay: 'infinite' });
  see(beliefs, [parcel('far', 9, 30)]);
  assert.deepEqual(listOptions(beliefs, { strategy: 'net_gain', minGain: 1 }).map(o => o.id), ['pickup:far']);
});

/**
 * The most common course settings: 50 ms per move and a point of decay per
 * second, so a point is lost only every 20 moves. Agent at x 5 on a corridor
 * of 20 tiles, delivery at x 0, carrying three parcels of 10. Parcel 'near'
 * (10) is at x 7, 'mid' (10) at x 12, and 'far' (11) at the end, x 19.
 */
function slowDecayWorld() {
  const clock = { t: 0 };
  const beliefs = new Beliefs({ now: () => clock.t, agentTtlMs: 3000, blockedTtlMs: 2000 });
  beliefs.onConfig({ CLOCK: 50, AGENT_TIMEOUT: 10000, GAME: { title: 'test', description: '',
    parcels: { generation_event: '2s', decaying_event: '1s', max: 5, reward_avg: 30, reward_variance: 10 },
    player: { movement_duration: 50, observation_distance: 10, capacity: -1 } } });
  beliefs.onMap(0, 0, tilesFromRows(['2' + '3'.repeat(19)]));
  beliefs.onYou({ id: 'me', name: 'me', x: 5, y: 0, score: 0 });
  see(beliefs, [parcel('c1', 5, 10, 'me'), parcel('c2', 5, 10, 'me'), parcel('c3', 5, 10, 'me'),
    parcel('near', 7, 10), parcel('mid', 12, 10), parcel('far', 19, 11)]);
  return beliefs;
}

test('without a value of time, a pickup still has to beat delivering first', () => {
  // The bug once seen in the game: the agent kept collecting and never
  // delivered, because every pickup beat delivering now. Delivering first
  // and coming back is the real alternative: 'near' and then 'mid' gets both
  // home before they lose a point (50), while delivering first and fetching
  // them afterwards takes long enough to lose one from each (48). 'far' is
  // worth no more fetched first than fetched after delivering.
  const options = listOptions(slowDecayWorld(), { strategy: 'net_gain', minGain: 1, timeValue: 0 })
    .filter(o => o.type !== 'explore');
  assert.deepEqual(options.map(o => [o.id, o.utility]), [['pickup:near', 50], ['pickup:mid', 50], ['deliver:0,0', 30]]);
});

test('with a value of time, the agent delivers and only detours for a close parcel', () => {
  // 30 points per 1050 ms: one average parcel per trip across the 20 x 1 map.
  const timeValue = 30 / 1050;
  const options = listOptions(slowDecayWorld(), { strategy: 'net_gain', minGain: 1, timeValue });
  // 'near' costs 4 extra moves (200 ms, about 6 points of time) for 10 points.
  // 'mid' and 'far' cost far more time than they bring.
  assert.deepEqual(options.filter(o => o.type !== 'explore').map(o => o.id), ['pickup:near', 'deliver:0,0']);
  const deliver = options.find(o => o.type === 'deliver');
  assert.equal(deliver?.utility, 30 - timeValue * 5 * 50);
});

test('delivering is offered while carrying even when its value is below zero', () => {
  const beliefs = slowDecayWorld();
  const options = listOptions(beliefs, { strategy: 'net_gain', minGain: 1, timeValue: 1 });
  const deliver = options.find(o => o.type === 'deliver');
  assert.ok(deliver && deliver.utility < 0);
  assert.equal(options[0].id, 'deliver:0,0');
});

test('under net_gain any pickup outranks exploring, whatever its value', () => {
  const { beliefs } = world(['1333333332'], { x: 0, y: 0 });
  beliefs.map?.markSeen([{ x: 0, y: 0 }], 0);
  see(beliefs, [parcel('p', 8, 10)]);
  const options = listOptions(beliefs, { strategy: 'net_gain', minGain: 1, timeValue: 1 });
  assert.deepEqual(options.map(o => [o.type, o.priority]), [['pickup', 0]]);
  const withExplore = world(['13313332'], { x: 3, y: 0 });
  see(withExplore.beliefs, [parcel('p', 6, 10)]);
  const ranked = listOptions(withExplore.beliefs, { strategy: 'net_gain', minGain: 1, timeValue: 1 });
  assert.deepEqual(ranked.map(o => o.type), ['pickup', 'explore']);
  assert.ok(ranked[0].utility < 0);
  assert.equal(ranked[1].priority, -1);
});

test('a pickup is not scored through a delivery tile that is excluded', () => {
  // Delivery tiles at x 0 and x 9; the parcel at x 7 is nearer to x 9.
  const { beliefs } = world(['2333333332'], { x: 5, y: 0 }, { decay: 'infinite' });
  see(beliefs, [parcel('p', 7, 10)]);
  const target = (/** @type {Set<string>} */ excluded) =>
    listOptions(beliefs, { strategy: 'net_gain', excluded }).find(o => o.id === 'pickup:p');
  assert.ok(target(new Set()));
  assert.ok(target(new Set(['deliver:9,0'])));
  // With both tiles excluded there is nowhere to deliver it, so no pickup.
  assert.equal(target(new Set(['deliver:0,0', 'deliver:9,0'])), undefined);
});

test('net_gain leaves out a parcel that would reach delivery worthless', () => {
  // 9 moves of 200 ms with a point lost per second: 1 point lost, all it has.
  const { beliefs } = world(['2333333333'], { x: 9, y: 0 });
  see(beliefs, [parcel('p', 5, 1), parcel('q', 5, 5)]);
  assert.deepEqual(listOptions(beliefs, { strategy: 'net_gain' }).map(o => o.id), ['pickup:q']);
});

test('net_gain offers no pickup when no delivery tile can be reached from the parcel', () => {
  const { beliefs } = world(['3313302'], { x: 1, y: 0 }, { decay: 'infinite' });
  see(beliefs, [parcel('p', 3, 10)]);
  assert.equal(listOptions(beliefs, { strategy: 'net_gain' }).some(o => o.type === 'pickup'), false);
});

test('net_gain still explores when no pickup is possible', () => {
  const { beliefs } = world(['13331'], { x: 2, y: 0 });
  const options = listOptions(beliefs, { strategy: 'net_gain', timeValue: 1 });
  assert.deepEqual(options.map(o => o.type), ['explore']);
});

test('net_gain delivers first when standing on a delivery tile', () => {
  const { beliefs } = world(['3323'], { x: 2, y: 0 }, { decay: 'infinite' });
  see(beliefs, [parcel('c', 2, 10, 'me'), parcel('p', 0, 30)]);
  const [first] = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.001 });
  assert.deepEqual([first.id, first.priority], ['deliver:2,0', 1]);
});

test('a pickup may end on a tile blocked for now when it arrives after the cooldown', () => {
  // The only delivery tile is x 0. The agent at x 5 sees a parcel at x 3:
  // 2 moves there and 3 on, 5 moves of 200 ms = 1000 ms.
  const { beliefs } = world(['2333333'], { x: 5, y: 0 }, { decay: 'infinite' });
  see(beliefs, [parcel('p', 3, 10)]);
  const excluded = new Set(['deliver:0,0']);
  const pickup = (/** @type {Map<string, number>} */ deliveryCooldowns) =>
    listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.001, excluded, deliveryCooldowns }).find(o => o.id === 'pickup:p');
  // Excluded with no cooldown known: no tile can end the trip.
  assert.equal(pickup(new Map()), undefined);
  // The cooldown ends before the agent arrives: the trip takes its 1000 ms.
  assert.equal(pickup(new Map([['deliver:0,0', 400]]))?.utility, 10 - 0.001 * 1000);
  // The cooldown ends later: the trip counts as lasting until then.
  assert.equal(pickup(new Map([['deliver:0,0', 4000]]))?.utility, 10 - 0.001 * 4000);
  // Delivering there directly still waits for the cooldown.
  see(beliefs, [parcel('c', 5, 10, 'me')]);
  const options = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.001, excluded, deliveryCooldowns: new Map([['deliver:0,0', 400]]) });
  assert.equal(options.some(o => o.type === 'deliver'), false);
});

test('the agent does not deliver into a one-way trap, even when it is nearer', () => {
  // The arrow at x = 1 points left: after delivering at x = 0 the agent could
  // never get back to the spawn tile.
  const { beliefs } = world(['2←3132'], { x: 2, y: 0 });
  see(beliefs, [parcel('c', 2, 20, 'me')]);
  for (const strategy of /** @type {const} */ (['baseline', 'net_gain'])) {
    const deliver = listOptions(beliefs, { strategy }).find(o => o.type === 'deliver');
    assert.equal(deliver?.id, 'deliver:5,0');
  }
});

test('no pickup or exploring is offered inside a one-way trap', () => {
  const { beliefs } = world(['1←3132'], { x: 2, y: 0 });
  see(beliefs, [parcel('trapped', 0, 30)]);
  const options = listOptions(beliefs, { strategy: 'net_gain' });
  assert.equal(options.some(o => o.id === 'pickup:trapped'), false);
  assert.equal(options.some(o => o.id === 'explore:0,0'), false);
});

test('an agent already inside a trap still delivers what it carries there', () => {
  const { beliefs } = world(['2←3132'], { x: 0, y: 0 });
  see(beliefs, [parcel('c', 0, 20, 'me')]);
  assert.equal(listOptions(beliefs, { strategy: 'net_gain' })[0].id, 'deliver:0,0');
});

test('net_gain looks one stop ahead, so a parcel the other way can come first', () => {
  // A point is lost every 5 moves, and time costs nothing here. From x 4,
  // 'lone' (6) at x 3 lies on the way to delivery at x 0: alone it is worth 6
  // after 4 moves, and fetching 'a' after it is worth 7 at best. 'a' (5) at
  // x 6 lies the other way: taking it first and 'lone' on the way back takes
  // 8 moves and is worth 4 + 5 = 9, so 'a' ranks first.
  const { beliefs } = world(['2333333333'], { x: 4, y: 0 });
  see(beliefs, [parcel('lone', 3, 6), parcel('a', 6, 5)]);
  const pickups = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).filter(o => o.type === 'pickup');
  assert.deepEqual(pickups.map(o => [o.id, o.utility]), [['pickup:a', 9], ['pickup:lone', 7]]);
});

test('parcels on the same tile are scored together, since a pickup takes them all', () => {
  const { beliefs } = world(['2333'], { x: 1, y: 0 });
  see(beliefs, [parcel('x', 3, 10), parcel('y', 3, 7)]);
  const pickups = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).filter(o => o.type === 'pickup');
  assert.equal(pickups.length, 1);
  assert.equal(pickups[0].parcelId, 'x');
  // 5 moves there and back lose one point from each parcel.
  assert.equal(pickups[0].utility, 9 + 6);
});

test('a parcel a rival reaches first counts only for the chance of getting it', () => {
  const { beliefs } = world(['2333333'], { x: 1, y: 0 });
  see(beliefs, [parcel('p', 5, 20)]);
  const before = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).find(o => o.id === 'pickup:p');
  // A rival one tile from the parcel, seen carrying a parcel before.
  beliefs.onSensing({ positions: [], agents: [{ id: 'r', name: 'r', x: 6, y: 0, score: 0 }],
    parcels: [{ id: 'q', x: 6, y: 0, reward: 3, carriedBy: 'r' }], crates: [] });
  const after = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).find(o => o.id === 'pickup:p');
  assert.ok(before && after);
  assert.ok(after.utility < before.utility / 5, `${after.utility} < ${before.utility} / 5`);
});

test('an agent never seen carrying a parcel is not counted as a rival', () => {
  const { beliefs } = world(['2333333'], { x: 1, y: 0 });
  see(beliefs, [parcel('p', 5, 20)]);
  const before = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).find(o => o.id === 'pickup:p');
  beliefs.onSensing({ positions: [], agents: [{ id: 'npc', name: 'npc', x: 6, y: 0, score: 0 }], parcels: [], crates: [] });
  const after = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).find(o => o.id === 'pickup:p');
  assert.equal(after?.utility, before?.utility);
});

test('the trip ends where it is worth most: a tile that scores twice beats a nearer one', () => {
  const { beliefs } = world(['2393'], { x: 3, y: 0 });
  const config = /** @type {ServerConfig} */ (beliefs.config);
  beliefs.onConfig({ ...config, GAME: { ...config.GAME, plugins: ['double-delivery'] } });
  see(beliefs, [parcel('c', 3, 10, 'me')]);
  const deliver = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0 }).find(o => o.type === 'deliver');
  assert.equal(deliver?.id, 'deliver:2,0');
  assert.equal(deliver?.utility, 20);
});

test('net_gain explores the nearer of two spawn tiles unseen for as long', () => {
  const { beliefs } = world(['1333331'], { x: 2, y: 0 });
  const explore = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.001 }).find(o => o.type === 'explore');
  assert.equal(explore?.id, 'explore:0,0');
});

test('net_gain explores a far spawn tile unseen for long rather than a near one just seen', () => {
  const { beliefs, clock } = world(['1333331'], { x: 2, y: 0 });
  clock.t = 60_000;
  beliefs.map?.markSeen([{ x: 0, y: 0 }], 59_000);
  beliefs.map?.markSeen([{ x: 6, y: 0 }], 1_000);
  const explore = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.001 }).find(o => o.type === 'explore');
  assert.equal(explore?.id, 'explore:6,0');
});

test('net_gain explores towards the unseen part of a map where every tile spawns parcels', () => {
  // As on empty_30: from a corner, the tiles around the agent were just seen,
  // and one spawn tile alone is worth less than a move. The area seen from a
  // tile further off is worth the walk, so the agent does not shuffle between
  // the tiles next to it.
  const rows = Array.from({ length: 12 }, () => '111111111111');
  const { beliefs, clock } = world(rows, { x: 0, y: 0 });
  clock.t = 60_000;
  const near = [];
  for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) if (x + y <= 5) near.push({ x, y });
  beliefs.map?.markSeen(near, 60_000);
  const explore = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.009 }).find(o => o.type === 'explore');
  assert.ok(explore && explore.x + explore.y > 5, `${explore?.id}`);
});

test('net_gain explores sensibly when parcels never decay', () => {
  const { beliefs } = world(['1333331'], { x: 2, y: 0 }, { decay: 'infinite' });
  const explore = listOptions(beliefs, { strategy: 'net_gain', timeValue: 0.001 }).find(o => o.type === 'explore');
  assert.equal(explore?.id, 'explore:0,0');
});

test('a pickup option names the delivery tile its trip ends on', () => {
  // Delivery tiles at both ends; the parcel on (5,0) is nearer the right one, on (6,0).
  const { beliefs } = world(['2331332'], { x: 3, y: 0 });
  see(beliefs, [parcel('p', 5, 20)]);
  const pickup = listOptions(beliefs).find(o => o.type === 'pickup');
  assert.ok(pickup);
  assert.equal(pickup.deliverX, 6);
  assert.equal(pickup.deliverY, 0);
});

/**
 * Pickup ids offered under net_gain with these settings.
 * @param {Beliefs} beliefs
 * @param {number} timeValue
 */
function pickupIds(beliefs, timeValue) {
  return listOptions(beliefs, { strategy: 'net_gain', minGain: 1, timeValue }).filter(o => o.type === 'pickup').map(o => o.id);
}

const carrying = (/** @type {number} */ x) => [parcel('c1', x, 10, 'me'), parcel('c2', x, 10, 'me'), parcel('c3', x, 10, 'me')];

test('next to the delivery tile with a parcel behind, the agent delivers first', () => {
  // A point is lost every 5 moves, and time is worth 2 points a second. From
  // x 1, fetching 'back' (30) at x 6 first takes 11 moves and is worth
  // 24 + 28 - 4.4 = 47.6. Delivering first takes 1 move, and fetching 'back'
  // after it 13 moves in all: 30 + 28 - 5.2 = 52.8. Delivering now alone is
  // only worth 29.6, so comparing against it would send the agent back.
  const { beliefs } = world(['2333333333'], { x: 1, y: 0 });
  see(beliefs, [...carrying(1), parcel('back', 6, 30)]);
  assert.deepEqual(pickupIds(beliefs, 0.002), []);
});

test('a parcel on the way to the delivery tile is still picked up', () => {
  // From x 6, 'way' (30) at x 3 lies on the route: 6 moves, 27 + 29 - 2.4 = 53.6.
  // Delivering first and coming back for it takes 12 moves: 27 + 28 - 4.8 = 50.2.
  const { beliefs } = world(['2333333333'], { x: 6, y: 0 });
  see(beliefs, [...carrying(6), parcel('way', 3, 30)]);
  assert.deepEqual(pickupIds(beliefs, 0.002), ['pickup:way']);
});

test('delivering first walks from the delivery tile to the parcel, which an arrow can make longer', () => {
  // The arrow at (1,0) forbids stepping right from the delivery tile, so going
  // from it to 'p' at (2,0) takes 6 moves over the top, while coming back
  // takes 2. From (0,1), fetching 'p' first takes 5 + 2 = 7 moves and
  // delivering first 1 + 6 + 2 = 9. With the way back counted instead of the
  // way there, delivering first would look like 5 moves and win.
  const { beliefs } = world(['333', '303', '2←3'], { x: 0, y: 1 });
  see(beliefs, [parcel('c', 0, 10, 'me'), parcel('p', 2, 30)]);
  // The parcel lies at y 0; the carried one moves with the agent.
  assert.deepEqual(pickupIds(beliefs, 0.01), ['pickup:p']);
});

test('delivering first frees the room to take every parcel on the tile', () => {
  // Capacity 2 and one parcel carried: fetching first takes only one of the
  // two parcels of 30 at x 4, worth 9 + 29 - 2.4 = 35.6. Delivering first
  // takes both: 10 + 28 + 28 - 4 = 62.
  const { beliefs } = world(['2333333333'], { x: 2, y: 0 }, { capacity: 2 });
  see(beliefs, [parcel('c', 2, 10, 'me'), parcel('a', 4, 30), parcel('b', 4, 30)]);
  assert.deepEqual(pickupIds(beliefs, 0.002), []);
});

test('a rival that would reach the parcel while the agent delivers makes it worth fetching first', () => {
  // As in the first case, but a rival stands 7 moves from 'back'. Fetching
  // first gets there in 5 moves, sure to win; delivering first gets there in
  // 7, an even chance, worth 30 + 14 - 5.2 = 38.8 against 47.6.
  const { beliefs } = world(['2333333333333'], { x: 1, y: 0 });
  see(beliefs, [...carrying(1), parcel('back', 6, 30)]);
  beliefs.onSensing({ positions: [], agents: [{ id: 'r', name: 'r', x: 13, y: 0, score: 0 }],
    parcels: [{ id: 'q', x: 13, y: 0, reward: 3, carriedBy: 'r' }], crates: [] });
  assert.deepEqual(pickupIds(beliefs, 0.002), ['pickup:back']);
});

test('two parcels behind are not fetched one after the other before delivering', () => {
  // From x 1, fetching 'a' (30) at x 5 and then 'b' (30) at x 6 is worth
  // 24 + 28 + 28 - 4.4 = 75.6; delivering first and then fetching both is
  // worth 30 + 56 - 5.2 = 80.8.
  const { beliefs } = world(['2333333333'], { x: 1, y: 0 });
  see(beliefs, [...carrying(1), parcel('a', 5, 30), parcel('b', 6, 30)]);
  assert.deepEqual(pickupIds(beliefs, 0.002), []);
});

test('a pickup already under way gives way to delivering once delivering first wins', () => {
  // As in the case next to the delivery tile: fetching 'back' first is worth
  // 47.6 and delivering first 52.8. The pickup the agent already follows is
  // still offered, but at what it gains over delivering first, 29.6 - 5.2,
  // so the agent turns to deliver instead of finishing the detour.
  const { beliefs } = world(['2333333333'], { x: 1, y: 0 });
  see(beliefs, [...carrying(1), parcel('back', 6, 30)]);
  const options = listOptions(beliefs, { strategy: 'net_gain', minGain: 1, timeValue: 0.002, keep: 'pickup:back' });
  const kept = options.find(o => o.id === 'pickup:back');
  assert.ok(kept);
  assert.ok(Math.abs(kept.utility - (29.6 - 5.2)) < 1e-9, `${kept.utility}`);
  const decision = reconsider(kept, options, 1.2, { minGain: 1 });
  assert.equal(decision.next?.id, 'deliver:0,0');
});
