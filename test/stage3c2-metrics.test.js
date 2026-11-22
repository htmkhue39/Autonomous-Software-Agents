// @ts-nocheck -- intentionally minimal event fixtures for benchmark log parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentLog, buildTrialSummary, asCsv, aggregateRounds } from '../src/benchmark/results.js';

const base = Date.parse('2026-11-12T19:00:00.000Z');
const evt = (ms, event, props = {}) => JSON.stringify({timestamp:new Date(base+ms).toISOString(),event,...props});
const ready = name => evt(0, `${name==='bubble'?'bdi':'llm'}_game_ready`, {score:0});

test('Stage 3C.2: logs distinguish confirmed tile dwell from censored holds', () => {
  const log = [
    ready('milktea'),
    evt(1000,'delivery',{x:6,y:13,parcelIds:['p1']}),
    evt(1250,'llm_delivery_evacuate_selected',{from:{x:6,y:13},target:{x:6,y:10}}),
    evt(2300,'move',{x:6,y:12}),
    evt(2550,'llm_delivery_evacuate_result',{status:'vacated',durationMs:1300}),
    evt(5000,'delivery',{x:6,y:13,parcelIds:['p2']}),
    evt(5100,'llm_delivery_evacuate_result',{status:'no_safe_target'})
  ].join('\n');
  const result = parseAgentLog(log,{name:'milktea',cutoffMs:base+10000});
  assert.equal(result.deliveryTileDwell.n,1);
  assert.equal(result.deliveryTileDwell.mean,1300);
  assert.equal(result.deliveryTileDwell.censored,1);
  assert.deepEqual(result.evacuationStatusCounts,{vacated:1,no_safe_target:1});
  assert.equal(result.deliveredParcels,2);
});

test('Stage 3C.2: distinguish teammate and NPC congestion (both can be present)', () => {
  const log = [ready('bubble'),
    evt(2000,'navigation_failed',{failureKind:'congestion',blockers:[{name:'milktea'},{name:'a0'}]}),
    evt(3000,'navigation_failed',{failureKind:'congestion',blockers:[{name:'milktea'}]}),
    evt(4000,'navigation_failed',{failureKind:'congestion',blockers:[{name:'a0'}]}),
    evt(5000,'navigation_failed',{failureKind:'static',blockers:[{name:'milktea'}]})
  ].join('\n');
  const result = parseAgentLog(log,{name:'bubble'});
  assert.equal(result.teammateCongestionFailures,2);
  assert.equal(result.npcCongestionFailures,2);
  assert.equal(result.counts.navigation_failed,4);
});

test('Stage 3C.2: new metrics are exported without changing score validity', () => {
  const b = parseAgentLog([ready('bubble'),evt(3000,'score_changed',{score:50}),
    evt(3000,'navigation_failed',{failureKind:'congestion',blockers:[{name:'milktea'}]})].join('\n'),{name:'bubble'});
  const m = parseAgentLog([ready('milktea'),evt(3000,'score_observed',{score:30}),
    evt(2000,'delivery',{x:6,y:13,parcelIds:['p']}),
    evt(2100,'llm_delivery_evacuate_selected',{}),
    evt(3000,'move',{x:6,y:12}),
    evt(3000,'llm_delivery_evacuate_result',{status:'vacated',durationMs:1000})].join('\n'),{name:'milktea'});
  const round = buildTrialSummary({mode:'C',trial:1,durationMs:45000,actualDurationMs:45001,
    agents:{bubble:b,milktea:m}});
  assert.equal(round.valid,true);
  assert.equal(round.teamObservedScore,80);
  assert.equal(round.llmDeliveryEvacuationAttempts,1);
  assert.equal(round.llmDeliveryEvacuationSuccesses,1);
  assert.equal(round.llmDeliveryTileDwellMeanMs,1000);
  assert.equal(round.bdiTeammateCongestionFailures,1);
  const csv = asCsv([round]);
  assert.match(csv,/bdiTeammateCongestionFailures/);
  assert.match(csv,/llmDeliveryTileDwellMeanMs/);
  assert.equal(aggregateRounds([round])[0].meanLlmDeliveryTileDwellMs,1000);
});
