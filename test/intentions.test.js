// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconsider, tripAsDelivery } from '../src/intentions/revision.js';
import { BdiAgent, failureKind } from '../src/intentions/agent.js';
import { stage1World } from './stage1-helpers.js';

const pick = (id, utility, priority = 0) => ({ id, type: 'pickup', x: 1, y: 0, parcelId: id, utility, priority });

test('intention revision respects threshold, invalidation, and exploration yield', () => {
  const old = pick('a', 10), small = pick('b', 11), big = pick('b', 13);
  assert.equal(reconsider(old, [small, old], 1.2).next.id, 'a');
  assert.equal(reconsider(old, [big, old], 1.2).next.id, 'b');
  assert.equal(reconsider(old, [small], 1.2).reason, 'invalidated');
  const explore = { id: 'explore:1,0', type: 'explore', x: 1, y: 0, utility: 0, priority: 0 };
  assert.equal(reconsider(explore, [pick('p', 1), explore], 1.2).next.id, 'p');
});

test('with minGain, switching follows the gain in points instead of the margin', () => {
  const deliver = { id: 'deliver:0,0', type: 'deliver', x: 0, y: 0, utility: 30, priority: 0 };
  const pickup = pick('q', 35);
  // 35 is not 1.2 times 30, so the margin rule keeps delivering.
  assert.equal(reconsider(deliver, [pickup, deliver], 1.2).next.id, 'deliver:0,0');
  // It is 5 points more, which is enough for a minimum gain of 1 but not of 6.
  assert.equal(reconsider(deliver, [pickup, deliver], 1.2, { minGain: 1 }).next.id, 'q');
  assert.equal(reconsider(deliver, [pickup, deliver], 1.2, { minGain: 6 }).next.id, 'deliver:0,0');
});

test('BDI control loop activates goals autonomously and completes pickup/delivery', async () => {
  const w = stage1World();
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'delivery') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log });
  const end = Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]);
  await end;
  assert.ok(events.some(e => e.event === 'intention_activated' && e.id === 'pickup:p'));
  // The pickup is a whole trip: the same intention delivers the parcel.
  assert.ok(events.some(e => e.event === 'delivery'));
  assert.equal(w.beliefs.parcels.carriedBy('me', w.beliefs.now()).length, 0);
});

test('BDI agent delivers on a delivery tile it walks over on the way to a pickup', async () => {
  // Agent at x 4 carries 'c'; parcel 'p' lies at x 1, past the delivery tile at x 2.
  const w = stage1World({ rows: ['33233'], x: 4 });
  w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }, { id: 'c', x: 4, y: 0, reward: 20, carriedBy: 'me' }]);
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'pickup') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log });
  await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]);
  assert.equal(events.find(e => e.event === 'intention_activated')?.id, 'pickup:p');
  assert.ok(events.some(e => e.event === 'intention_revision' && e.reason === 'deliver_here' && e.to === 'deliver:2,0'));
  const delivery = events.findIndex(e => e.event === 'delivery' && e.x === 2);
  const pickup = events.findIndex(e => e.event === 'pickup');
  assert.ok(delivery !== -1 && delivery < pickup, 'delivered at x 2 before picking up p');
  // A cancelled intention is not a failure, so it is not put on cooldown.
  assert.equal(events.some(e => e.event === 'intention_cooldown' && e.id === 'pickup:p'), false);
});

test('a delivery tile blocked for now does not stop delivering to another tile', async () => {
  // Delivery tiles at x 0 and x 3; the agent at x 1 carries 'c'. Every move
  // into x 0 is refused, so that tile is cooled down as blocked for now, and
  // the agent delivers at x 3 instead of waiting out the cooldown.
  const w = stage1World({ rows: ['2332'], x: 1 });
  w.send([{ id: 'c', x: 1, y: 0, reward: 20, carriedBy: 'me' }], [{ x: 1, y: 0 }]);
  w.setRejectMove(dir => dir === 'left' && w.beliefs.me.x === 1);
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'delivery') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]); }
  finally { agent.stop(); }
  assert.ok(events.some(e => e.event === 'intention_cooldown' && e.id === 'deliver:0,0' && e.kind === 'temporary'));
  assert.equal(events.find(e => e.event === 'delivery')?.x, 3);
});

test('a putdown that drops nothing corrects the belief and does not cool the tile down', async () => {
  // The agent believes it carries 'c', but the server holds nothing for it.
  const w = stage1World({ rows: ['2333'], x: 1 });
  w.send([{ id: 'c', x: 1, y: 0, reward: 20, carriedBy: 'me' }], [{ x: 1, y: 0 }]);
  w.client.putdown = async () => [];
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'intention_failure_not_cooled') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]); }
  finally { agent.stop(); }
  assert.deepEqual(w.beliefs.parcels.carriedBy('me', w.beliefs.now()), []);
  assert.ok(events.some(e => e.event === 'inventory_reconciled' && e.forgotten === 1));
  assert.equal(events.some(e => e.event === 'intention_cooldown'), false);
});

test('failure kinds tell the tile apart from the agent and from unknown outcomes', () => {
  const deliver = { id: 'deliver:0,0', type: 'deliver', x: 0, y: 0, utility: 5, priority: 0 };
  assert.equal(failureKind(deliver, { status: 'failed', reason: 'Nothing dropped at delivery' }), 'none');
  assert.equal(failureKind(deliver, { status: 'failed', reason: 'Target no longer applicable' }), 'none');
  assert.equal(failureKind(deliver, { status: 'failed', reason: 'Congestion timeout' }), 'temporary');
  assert.equal(failureKind(deliver, { status: 'failed', reason: 'Too many refused moves' }), 'temporary');
  assert.equal(failureKind(deliver, { status: 'unknown', reason: 'putdown exceeded 8000ms' }), 'uncertain');
  assert.equal(failureKind(pick('p', 5), { status: 'failed', reason: 'Target parcel not confirmed collected' }), 'temporary');
});

/**
 * The agent at (3, 0) carries 'c' and sets off to deliver at (0, 0). After
 * its first move a parcel 'q' appears one tile off the route, at (2, 1).
 * @param {object} optionPolicy
 */
async function parcelAppearsWhileDelivering(optionPolicy) {
  const w = stage1World({ rows: ['3333', '2333'], x: 3 });
  const c = { id: 'c', x: 3, y: 0, reward: 20, carriedBy: 'me' };
  w.send([c], [{ x: 1, y: 0 }]);
  const move = w.client.move;
  let moves = 0;
  w.client.move = async dir => {
    const result = await move(dir);
    if (++moves === 1) w.send([c, { id: 'q', x: 2, y: 1, reward: 10, carriedBy: null }]);
    return result;
  };
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'delivery') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log, optionPolicy });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]); }
  finally { agent.stop(); }
  return events;
}

test('net_gain leaves a delivery to pick up a parcel near the route, then delivers both', async () => {
  const events = await parcelAppearsWhileDelivering({ strategy: 'net_gain', minGain: 1 });
  assert.equal(events.find(e => e.event === 'intention_activated')?.id, 'deliver:0,0');
  assert.ok(events.some(e => e.event === 'intention_revision' && e.from === 'deliver:0,0' && e.to === 'pickup:q'));
  const pickup = events.findIndex(e => e.event === 'pickup');
  const delivery = events.findIndex(e => e.event === 'delivery');
  assert.ok(pickup !== -1 && pickup < delivery);
  assert.equal(events[delivery].parcelIds.length, 2);
});

test('baseline keeps a delivery committed and passes the parcel by', async () => {
  const events = await parcelAppearsWhileDelivering({ strategy: 'baseline' });
  assert.equal(events.some(e => e.event === 'intention_revision' && e.to === 'pickup:q'), false);
  assert.equal(events.find(e => e.event === 'delivery')?.parcelIds.length, 1);
});

test('with minGain, switching works on values below zero too', () => {
  const deliver = { id: 'deliver:0,0', type: 'deliver', x: 0, y: 0, utility: -4, priority: 0 };
  assert.equal(reconsider(deliver, [pick('q', -2), deliver], 1.2, { minGain: 1 }).next.id, 'q');
  assert.equal(reconsider(deliver, [pick('q', -3.5), deliver], 1.2, { minGain: 1 }).next.id, 'deliver:0,0');
  const explore = { id: 'explore:1,0', type: 'explore', x: 1, y: 0, utility: 0, priority: -1 };
  assert.equal(reconsider(explore, [pick('p', -10), explore], 1.2, { minGain: 1 }).next.id, 'p');
});

test('the BDI agent learns the value of time from its own score', () => {
  const w = stage1World();
  const agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, optionPolicy: { strategy: 'net_gain' } });
  const before = agent.timeValue();
  assert.ok(before > 0);
  w.beliefs.onYou({ ...w.beliefs.me, score: 0 });
  w.beliefs.onYou({ ...w.beliefs.me, score: 50 });
  assert.ok(agent.timeValue() > before);
});

test('the learned value of time starts again on a new map', () => {
  const w = stage1World();
  const agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, optionPolicy: { strategy: 'net_gain' } });
  const prior = agent.timeValue();
  w.beliefs.onYou({ ...w.beliefs.me, score: 0 });
  w.beliefs.onYou({ ...w.beliefs.me, score: 500 });
  assert.ok(agent.timeValue() > prior);
  // The same map arrives again, as when the server starts a new round.
  w.beliefs.onMap(0, 0, w.beliefs.map ? [...Array(w.beliefs.map.width).keys()].map(x => ({ x, y: 0, type: '3' })) : []);
  assert.ok(agent.timeValue() <= prior * 1.0001);
});

test('the learned value of time starts again when the game settings change', () => {
  const w = stage1World();
  const agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, optionPolicy: { strategy: 'net_gain' } });
  w.beliefs.onYou({ ...w.beliefs.me, score: 0 });
  w.beliefs.onYou({ ...w.beliefs.me, score: 500 });
  const learned = agent.timeValue();
  const config = structuredClone(w.beliefs.config);
  config.GAME.player.movement_duration *= 10;
  w.beliefs.onConfig(config);
  assert.ok(agent.timeValue() < learned);
});

test('a fixed value of time is used as given, and the baseline uses none', () => {
  const w = stage1World();
  const fixed = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, optionPolicy: { strategy: 'net_gain', timeValuePerS: 5 } });
  assert.equal(fixed.timeValue(), 0.005);
  const baseline = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, optionPolicy: { strategy: 'baseline' } });
  assert.equal(baseline.timeValue(), 0);
});

test('delivery protection lets a pickup give way to a slightly better delivery', () => {
  const pickup = { id: 'pickup:A', type: 'pickup', x: 1, y: 0, parcelId: 'A', utility: 8, priority: 0 };
  const deliver = { id: 'deliver:1,1', type: 'deliver', x: 1, y: 1, utility: 8.5, priority: 0 };
  const rule = { minGain: 1, deliveryProtection: 0 };
  // Only 0.5 points better, below minGain, but enough to stop a detour.
  const result = reconsider(pickup, [deliver, pickup], 1.2, rule);
  assert.equal(result.next.id, 'deliver:1,1');
  assert.equal(result.reason, 'delivery_protection');
  // A slightly worse delivery does not replace the pickup.
  assert.equal(reconsider(pickup, [pickup, { ...deliver, utility: 7.5 }], 1.2, rule).next.id, 'pickup:A');
  // A larger protection keeps the pickup on a small gain.
  assert.equal(reconsider(pickup, [deliver, pickup], 1.2, { minGain: 1, deliveryProtection: 0.5 }).next.id, 'pickup:A');
  // Going back from delivering to a pickup still needs the full minGain.
  assert.equal(reconsider(deliver, [{ ...pickup, utility: 9 }, deliver], 1.2, rule).next.id, 'deliver:1,1');
  // Without minGain (the baseline) protection plays no part.
  assert.equal(reconsider(pickup, [deliver, pickup], 1.2, { deliveryProtection: 0 }).next.id, 'pickup:A');
});

test('a lower priority option never replaces the current one', () => {
  const here = { id: 'deliver:0,0', type: 'deliver', x: 0, y: 0, utility: 5, priority: 1 };
  const explore = { id: 'explore:1,0', type: 'explore', x: 1, y: 0, utility: 100, priority: -1 };
  assert.equal(reconsider(here, [explore, here], 1.2, { minGain: 1 }).next.id, 'deliver:0,0');
});

test('a trip goes on to deliver after its pickup instead of being replaced by a delivery', async () => {
  // The agent at (3, 0), the parcel 'p' on (1, 0), the delivery tile on (0, 0): one trip.
  const w = stage1World();
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'delivery') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log,
    optionPolicy: { strategy: 'net_gain', minGain: 1 } });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]); }
  finally { agent.stop(); }
  assert.equal(events.find(e => e.event === 'intention_activated')?.id, 'pickup:p');
  assert.equal(events.some(e => e.event === 'intention_revision' && e.from === 'pickup:p'), false);
  assert.ok(events.some(e => e.event === 'delivery'));
});

test('after a completed intention the next one starts without the idle wait', async () => {
  // After the first completed intention, the next one must start at once, not idleMs later.
  const w = stage1World({ rows: ['21133'], x: 4 });
  w.send([{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }, { id: 'q', x: 2, y: 0, reward: 20, carriedBy: null }]);
  const events = [];
  let agent;
  let completed = false;
  const log = (type, details) => {
    events.push({ event: type, at: Date.now(), ...details });
    if (type === 'intention_outcome' && details.status === 'completed') completed = true;
    else if (type === 'intention_activated' && completed) agent.stop();
  };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 1000, log,
    optionPolicy: { strategy: 'net_gain', minGain: 1 } });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 3000))]); }
  finally { agent.stop(); }
  const first = events.findIndex(e => e.event === 'intention_outcome' && e.status === 'completed');
  const next = events.slice(first).find(e => e.event === 'intention_activated');
  assert.ok(first !== -1 && next, 'two intentions ran');
  assert.ok(next.at - events[first].at < 200, `the next intention waited ${next.at - events[first].at} ms`);
});

test('an intention that ends at once is not started again more than once every 50 ms', async () => {
  // A plan that is cancelled the moment it starts, with nothing else to do: the loop must not spin.
  const w = stage1World();
  let activations = 0;
  const plans = { applicable: () => true, execute: async () => ({ status: 'cancelled' }) };
  const agent = new BdiAgent({ beliefs: w.beliefs, plans, gate: w.gate, idleMs: 1,
    log: type => { if (type === 'intention_activated') activations++; } });
  const run = agent.start();
  await new Promise(resolve => setTimeout(resolve, 300));
  agent.stop();
  await run;
  assert.ok(activations <= 7, `${activations} activations in 300 ms`);
});

test('a trip that fails on its way to deliver cools down its delivery tile', async () => {
  // After the pickup on (1,0), every move towards the delivery tile on (0,0) is refused.
  const w = stage1World();
  w.setRejectMove(dir => dir === 'left' && w.beliefs.parcels.carriedBy('me', w.beliefs.now()).length > 0);
  const events = [];
  let agent;
  const log = (type, details) => { events.push({ event: type, ...details }); if (type === 'intention_cooldown') agent.stop(); };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 5, log,
    optionPolicy: { strategy: 'net_gain', minGain: 1 } });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 1500))]); }
  finally { agent.stop(); }
  const cooldown = events.find(e => e.event === 'intention_cooldown');
  assert.equal(cooldown?.id, 'deliver:0,0');
  assert.ok(agent.failedGoals.has('deliver:0,0'));
  assert.equal(agent.failedGoals.has('pickup:p'), false);
});

test('after its pickup a trip is weighed as a delivery, even when its tile is not the listed one', () => {
  const trip = { id: 'pickup:p', type: 'pickup', x: 1, y: 0, parcelId: 'p', deliverX: 0, deliverY: 0, utility: 50, priority: 0 };
  const deliverHere = { id: 'deliver:0,0', type: 'deliver', x: 0, y: 0, utility: 20, priority: 0 };
  const deliverElsewhere = { id: 'deliver:4,0', type: 'deliver', x: 4, y: 0, utility: 21, priority: 0 };
  // Its own tile is listed: the trip takes that delivery's place and value.
  const own = tripAsDelivery(trip, [deliverHere], true);
  assert.deepEqual(own.map(o => [o.id, o.utility]), [['pickup:p', 20]]);
  // Another tile is listed: the trip is added at that delivery's value, so it is not replaced for nothing.
  const other = tripAsDelivery(trip, [deliverElsewhere], true);
  assert.deepEqual(other.map(o => [o.id, o.utility]), [['deliver:4,0', 21], ['pickup:p', 21]]);
  assert.equal(reconsider(trip, other, 1.2, { minGain: 1 }).next.id, 'pickup:p');
  // Before the pickup nothing changes.
  assert.deepEqual(tripAsDelivery(trip, [deliverHere], false), [deliverHere]);
});

test('after an intention the next decision waits for fresh sensing, not for the idle time', async () => {
  // Exploring on stale beliefs picks the next tile before the server says what the agent now sees.
  const w = stage1World();
  const order = [];
  let agent;
  let completed = false;
  const log = (type, details) => {
    if (type === 'intention_outcome' && details.status === 'completed' && !completed) {
      completed = true;
      order.push({ what: 'completed', at: Date.now() });
      // The server's next sensing comes 80 ms later, after the 50 ms floor and within two frames.
      setTimeout(() => { order.push({ what: 'sensing', at: Date.now() }); w.send(w.beliefs.parcels.free(w.beliefs.now())); }, 80);
    } else if (type === 'intention_activated' && completed) {
      order.push({ what: 'activated', at: Date.now() });
      agent.stop();
    }
  };
  w.movement.log = log;
  w.plans.log = log;
  agent = new BdiAgent({ beliefs: w.beliefs, plans: w.plans, gate: w.gate, idleMs: 1000, log,
    optionPolicy: { strategy: 'net_gain', minGain: 1 } });
  try { await Promise.race([agent.start(), new Promise((_, reject) => setTimeout(() => reject(Error('BDI test timed out')), 3000))]); }
  finally { agent.stop(); }
  assert.deepEqual(order.map(o => o.what), ['completed', 'sensing', 'activated']);
  assert.ok(order[2].at - order[0].at < 200, 'the next decision did not wait for the idle time');
});
