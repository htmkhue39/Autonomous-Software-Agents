// @ts-nocheck -- dedicated fixture clients simulate partial SDK acknowledgements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { createGameTools } from '../src/llm/game/tools.js';
import { selectDeliveryParking } from '../src/llm/game/evacuation.js';
import { GameProgress } from '../src/llm/game/objectives.js';

function setup({ rows = ['21333'], x = 4, auto = true, afterDelivery, logFn } = {}) {
  const events = [];
  let progress;
  const w = stage1World({ rows, x, log: (event, data) => {
    progress?.record(event, data);
    events.push({ event, ...data }); logFn?.(event, data);
  } });
  const original = w.plans.execute.bind(w.plans);
  const plans = { async execute(option, signal) {
    if (afterDelivery && option.id?.startsWith('llm-evacuate:')) {
      return afterDelivery(option, signal, w);
    }
    return original(option, signal);
  } };
  progress = new GameProgress(w.beliefs);
  const write = (event, data) => { progress.record(event, data); events.push({ event, ...data }); };
  const tools = createGameTools({ beliefs: w.beliefs, plans, progress,
    deliveryEvacuation: auto, log: write });
  return { ...w, actions: w.events, tools, progress, events };
}

async function collect(w) {
  const pickup = await w.tools.invoke({ name:'pickup_parcels', arguments:{ parcel_id:'p' } });
  assert.equal(pickup.ok, true);
  return w.tools.invoke({ name:'deliver_parcels', arguments:{} });
}

test('Stage 3C.2: after confirmed putdown, milktea clears delivery tile via acknowledged movement', async () => {
  const w = setup();
  const result = await collect(w);
  assert.equal(result.ok, true);
  assert.equal(result.data.evacuation.status, 'vacated');
  assert.equal(w.progress.deliveredCount, 1);
  assert.notEqual(w.beliefs.map.typeAt(w.beliefs.me.x, w.beliefs.me.y), '2');
  assert.equal(w.events.filter(e => e.event === 'delivery').length, 1);
  assert.ok(w.events.some(e => e.event === 'llm_delivery_evacuate_result' && e.status === 'vacated'));
  assert.ok(w.actions.some(e => e.action === 'putdown'));
  const putdown = w.actions.findIndex(e => e.action === 'putdown');
  assert.ok(w.actions.slice(putdown + 1).some(e => e.action === 'move'));
});

test('Stage 3C.2: no additional evacuation action if verified putdown fails', async () => {
  const w = setup();
  const original = w.client.putdown;
  w.client.putdown = async () => { return []; };
  const result = await collect(w);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'game_action_failed');
  assert.equal(w.progress.deliveredCount, 0);
  assert.equal(w.events.filter(e => e.event === 'llm_delivery_evacuate_selected').length, 0);
  w.client.putdown = original;
});

test('Stage 3C.2: acknowledged delivery survives known parking navigation failure', async () => {
  const w = setup({ afterDelivery: () => ({ status:'failed', reason:'Temporary congestion' }) });
  const result = await collect(w);
  assert.equal(result.ok, true);
  assert.equal(result.data.evacuation.status, 'blocked');
  assert.equal(w.progress.deliveredCount, 1);
  assert.equal(w.beliefs.me.x, 0);
  assert.equal(w.events.filter(e => e.event === 'delivery').length, 1);
  assert.equal(w.events.filter(e => e.event === 'llm_delivery_evacuate_result' && e.status === 'blocked').length, 1);
});

test('Stage 3C.2: unknown evacuation move fails closed, does not retry or erase delivery', async () => {
  let attempts = 0;
  const w = setup({ afterDelivery: () => { attempts++; return { status:'unknown', reason:'SDK move ACK timed out' }; } });
  const result = await collect(w);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'outcome_unknown');
  assert.equal(attempts, 1);
  assert.equal(w.progress.deliveredCount, 1);
  assert.ok(w.events.some(e => e.event === 'llm_delivery_evacuate_result' && e.status === 'uncertain'));
});

test('Stage 3C.2: when no safe non-delivery tile is reachable, keep verified delivery', async () => {
  const w = setup({ rows:['21'], x:1 });
  // Tile x1 is a parcel spawn, so the LLM can collect and return, but if
  // teammate stands there after pickup, evacuation must not enter it.
  const p = await w.tools.invoke({ name:'pickup_parcels', arguments:{ parcel_id:'p' } });
  assert.equal(p.ok, true);
  w.beliefs.agents.update([{ id:'other', name:'bubble', x:1, y:0, score:0 }], w.beliefs.now());
  const result = await w.tools.invoke({ name:'deliver_parcels', arguments:{} });
  assert.equal(result.ok, true);
  assert.equal(result.data.evacuation.status, 'no_safe_target');
  assert.equal(w.progress.deliveredCount, 1);
  assert.equal(w.beliefs.me.x, 0);
});

test('Stage 3C.2: select a reachable unoccupied staging tile, respecting one-way arrows', () => {
  const w = setup({ rows:['21333'], x:4 });
  w.beliefs.onYou({ ...w.beliefs.me, x:0 });
  w.beliefs.agents.update([{ id:'a0', name:'a0', x:1, y:0, score:0 }], w.beliefs.now());
  assert.equal(selectDeliveryParking(w.beliefs), null);
  w.beliefs.agents.update([{ id:'a0', name:'a0', x:1, y:0, score:0 }], w.beliefs.now()-4000);
  const parking = selectDeliveryParking(w.beliefs);
  assert.ok(parking);
  assert.notEqual(w.beliefs.map.typeAt(parking.target.x, parking.target.y), '2');
  assert.ok(parking.distance <= 7);
  assert.ok(parking.deliverySeparation >= 1);
  // One-way tile, cannot step into a left-only arrow while traveling right.
  const arrow = setup({ rows:['2←33'], x:3 });
  arrow.beliefs.onYou({ ...arrow.beliefs.me, x:0 });
  assert.equal(selectDeliveryParking(arrow.beliefs), null);
});

test('Stage 3C.2: prefer an off-corridor pocket over a narrow through-lane', () => {
  const w = setup({ rows:['00000','21333','00300'], x:4 });
  w.beliefs.onYou({ ...w.beliefs.me, x:0, y:1 });
  const parking = selectDeliveryParking(w.beliefs);
  assert.deepEqual(parking?.target, { x:2, y:0 });
});

test('Stage 3C.2: explicit opt-out preserves the frozen baseline delivery behavior', async () => {
  const w = setup({ auto:false });
  const result = await collect(w);
  assert.equal(result.ok, true);
  assert.equal('evacuation' in result.data, false);
  assert.equal(w.beliefs.me.x, 0);
  assert.equal(w.events.filter(e => e.event === 'llm_delivery_evacuate_selected').length, 0);
});

test('Stage 3C.2: successful high-level collect-and-deliver also evacuates', async () => {
  const w = setup();
  const result = await w.tools.invoke({ name:'collect_and_deliver', arguments:{parcel_id:'p'} });
  assert.equal(result.ok, true);
  assert.equal(result.data.delivery.evacuation.status, 'vacated');
  assert.equal(w.progress.deliveredCount, 1);
});
