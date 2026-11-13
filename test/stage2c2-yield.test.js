// @ts-nocheck -- Simulated SDK and coordination callbacks are intentionally partial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage1World } from './stage1-helpers.js';
import { createGameTools } from '../src/llm/game/tools.js';

const parcel = (id, x, reward) => ({ id, x, y: 0, reward, carriedBy: null });
const world = () => {
  const w = stage1World({ rows: ['213333'], x: 5 });
  w.send([parcel('preferred', 4, 70), parcel('backup', 3, 48)]);
  return w;
};
const collect = tools => tools.invoke({ name: 'collect_best_and_deliver',
  arguments: { strategy: 'highest_expected_reward', explore_if_empty: false } });

test('safe peer-claim yield during navigation reselects a backup without blocking objective', async () => {
  const w = world();
  const logs = [];
  let onClaimYield;
  const coordination = {
    canTarget() { return true; },
    async acquire(id, _parcel, { onYield }) {
      if (id === 'preferred') onClaimYield = onYield;
      return true;
    },
    release() {}, setIntention() {},
  };
  const plans = {
    async execute(option, stop) {
      if (option.type === 'pickup' && option.parcelId === 'preferred') {
        // The peer wins the claim after a navigation step, before any pickup
        // or putdown call has been dispatched. This matches the live log.
        onClaimYield();
        assert.equal(stop.stopped, true);
        return { status: 'cancelled' };
      }
      return w.plans.execute(option, stop);
    },
  };
  const tools = createGameTools({ beliefs: w.beliefs, plans, coordination,
    log: (event, details) => logs.push({ event, ...details }) });
  const result = await collect(tools);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, 'delivered');
  assert.equal(result.data.selectedParcelId, 'backup');
  assert.deepEqual(result.data.attempts, [{ id: 'preferred', reason: 'coordination_conflict' }]);
  assert.equal(w.events.filter(x => x.action === 'pickup').length, 1);
  assert.equal(w.events.filter(x => x.action === 'putdown').length, 1);
  assert.ok(logs.some(x => x.event === 'llm_coordination_safe_yield' && x.parcelId === 'preferred'));
  assert.ok(logs.some(x => x.event === 'llm_dynamic_reselected' && x.rejectedParcelId === 'preferred'));
  assert.ok(!logs.some(x => x.event === 'llm_target_cooldown'));
});

test('claim yield cannot conceal an ambiguous SDK pickup outcome', async () => {
  const w = world();
  let onClaimYield;
  let plansExecuted = 0;
  const coordination = {
    canTarget() { return true; },
    async acquire(id, _parcel, { onYield }) { if (id === 'preferred') onClaimYield = onYield; return true; },
    release() {}, setIntention() {},
  };
  const plans = {
    async execute(option, stop) {
      plansExecuted++;
      if (option.type === 'pickup' && option.parcelId === 'preferred') {
        stop.finishing = true; // SDK pickup already dispatched.
        onClaimYield();
        return { status: 'unknown', reason: 'SDK request timed out' };
      }
      return w.plans.execute(option, stop);
    },
  };
  const tools = createGameTools({ beliefs: w.beliefs, plans, coordination });
  const result = await collect(tools);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'outcome_unknown');
  assert.equal(plansExecuted, 1, 'must never silently try backup after possible SDK pickup');
  assert.equal(w.events.some(e => e.action === 'pickup'), false);
});

test('unrelated navigation cancellation is NOT misclassified as a safe claim yield', async () => {
  const w = world();
  let calls = 0;
  const plans = { async execute() { calls++; return { status: 'cancelled' }; } };
  const tools = createGameTools({ beliefs: w.beliefs, plans });
  const result = await collect(tools);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'outcome_unknown');
  assert.equal(calls, 1);
});
