// @ts-nocheck -- Tests intentionally provide partial benchmark/LLM mocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { buildTrialSummary, parseAgentLog, auditHistoricalRound, aggregateRounds,
  describeSamples, studentT95, compareModes, asCsv, timingToleranceMs } from '../src/benchmark/results.js';
import { monitorServer, parseBenchmarkArgs } from '../src/benchmark/runner.js';
import { PlanActLoop } from '../src/llm/agent.js';

const base = (mode='A') => ({mode,trial:1,durationMs:180000,actualDurationMs:180006,
  agents:{ bubble:{ready:true,score:100,counts:{}}, milktea:{ready:true,score:50,counts:{}} }});
const event = (type,data={},when='2026-11-12T16:00:00.000Z')=>JSON.stringify({timestamp:when,event:type,...data});

test('Stage 3A.1: rejects 942s and 1074s overruns previously accepted as valid',()=>{
  for(const actualDurationMs of [942354,1074213]){
    const result=buildTrialSummary({...base(),actualDurationMs});
    assert.equal(result.valid,false);
    assert.deepEqual(result.issues,['duration_out_of_tolerance']);
    assert.equal(result.actualDurationMs,actualDurationMs);
  }
});
test('Stage 3A.1: accepts normal 180.01s runner overhead',()=>{
  const result=buildTrialSummary({...base(),actualDurationMs:180011,actualWallDurationMs:180015});
  assert.equal(result.valid,true);
  assert.equal(result.durationDriftMs,11);
  assert.equal(result.wallDriftMs,15);
  assert.equal(result.timingToleranceMs,3600);
});
test('Stage 3A.1: a wall-clock sleep/clock jump invalidates even if monotonic duration is normal',()=>{
  const result=buildTrialSummary({...base(),actualDurationMs:180006,actualWallDurationMs:800000});
  assert.equal(result.valid,false);
  assert.ok(result.issues.includes('duration_out_of_tolerance'));
});
test('Stage 3A.1: readiness skew is detected, but not double counted as failed actions',()=>{
  const result=buildTrialSummary({...base('C'),roundStartedAt:1000,
    agents:{bubble:{ready:true,score:10,readyAt:2000,counts:{}},milktea:{ready:true,score:20,readyAt:24000,counts:{}}},
    agentStartTimes:{bubble:1000,milktea:1010}});
  assert.equal(result.valid,false);
  assert.ok(result.issues.includes('readiness_skew_exceeded'));
  assert.equal(result.readinessSkewMs,22000);
  assert.equal(result.readinessDelaysMs.bubble,1000);
  assert.equal(result.readinessDelaysMs.milktea,22990);
});
test('Stage 3A.1: server probe failure invalidates trial and remains reported',()=>{
  const result=buildTrialSummary({...base(),serverHealth:{probes:12,failures:1}});
  assert.equal(result.valid,false);
  assert.ok(result.issues.includes('server_probe_failed'));
});
test('Stage 3A.1: telemetry parser captures timed outcomes and only in-round events',()=>{
  const log=[event('llm_game_ready',{score:0}),
    event('llm_model_call',{phase:'act'}),
    event('llm_model_result',{phase:'act',ok:true,durationMs:2400,promptTokens:22}),
    event('llm_tool_result',{name:'collect_best_and_deliver',ok:false,errorCode:'outcome_unknown',durationMs:60001,timeoutOrigin:'tool_registry_deadline'}),
    event('plan_phase',{planType:'pickup',phase:'navigation',durationMs:5000,status:'completed'}),
    event('sdk_action_phase',{action:'pickup',durationMs:8001,status:'unknown'}),
    event('llm_dynamic_phase',{phase:'pickup_pipeline',durationMs:19000,status:'outcome_unknown'}),
    event('llm_model_result',{phase:'act',ok:true,durationMs:90000},'2026-11-12T16:04:01.000Z')].join('\n');
  const out=parseAgentLog(log,{name:'milktea',cutoffMs:Date.parse('2026-11-12T16:03:00.000Z')});
  assert.equal(out.timing.llm_model_result.mean,2400);
  assert.equal(out.timing.llm_tool_result.p95,60001);
  assert.equal(out.timing['plan:pickup:navigation'].mean,5000);
  assert.equal(out.timing['sdk:pickup'].mean,8001);
  assert.equal(out.timing['dynamic:pickup_pipeline'].mean,19000);
  assert.equal(out.toolTimings.collect_best_and_deliver.failed,1);
  assert.equal(out.counts.sdk_action_phase_unknown,1);
  assert.equal(out.unknownOutcomeOrigins.tool_registry_deadline,1);
  assert.equal(out.uncertainOutcomes,1);
  assert.equal(out.readyAt,Date.parse('2026-11-12T16:00:00.000Z'));
});
test('Stage 3A.1: older logs without telemetry still parse with null latency',()=>{
  const out=parseAgentLog(event('llm_game_ready',{score:5}));
  assert.equal(out.timing.llm_model_result,undefined);
  const trial=buildTrialSummary({...base('B'),agents:{bubble:{ready:true,score:10,counts:{}},milktea:out}});
  assert.equal(trial.valid,true);
  assert.equal(trial.llmModelLatencyMeanMs,null);
  assert.equal(trial.llmToolLatencyMeanMs,null);
});
test('Stage 3A.1: Student-t statistics preserve small-sample uncertainty',()=>{
  const x=describeSamples([73,349,262,206,248]);
  assert.equal(x.n,5);
  assert.equal(x.mean,227.6);
  assert.equal(x.median,248);
  assert.equal(x.p95,349);
  assert.ok(x.ci95[0] < x.mean && x.ci95[1] > x.mean);
  assert.equal(describeSamples([4]).ci95,null);
  assert.ok(Math.abs(studentT95(4)-2.776)<0.001);
});
test('Stage 3A.1: Welch comparison uses independent groups, not arbitrary trial-number pairing',()=>{
  const b=[73,349,262,206,248].map((score,i)=>({mode:'B',trial:i+1,valid:true,teamObservedScore:score}));
  const c=[457,240,216,498,361].map((score,i)=>({mode:'C',trial:i+1,valid:true,teamObservedScore:score}));
  const result=compareModes([...b,...c]);
  assert.ok(Math.abs(result.difference-126.8)<1e-7);
  assert.ok(Math.abs(result.relativePercent-55.711775)<0.02);
  assert.ok(result.ci95[0]<0 && result.ci95[1]>0);
  const aggregate=aggregateRounds([...b,...c,{mode:'B',valid:false,issues:['early_agent_exit']}]);
  assert.equal(aggregate.find(r=>r.mode==='B').invalidTrials,1);
  assert.equal(aggregate.find(r=>r.mode==='B').issues.early_agent_exit,1);
});
test('Stage 3A.1: audit retroactively flags timing anomalies without mutating old round objects',()=>{
  const original={mode:'C',valid:true,issues:[],requestedDurationMs:180000,actualDurationMs:942354};
  const audited=auditHistoricalRound(original);
  assert.equal(original.valid,true);
  assert.equal(audited.valid,false);
  assert.deepEqual(audited.issues,['duration_out_of_tolerance']);
  assert.match(asCsv([audited]),/duration_out_of_tolerance/);
  assert.equal(auditHistoricalRound({requestedDurationMs:180000,actualDurationMs:180001,valid:true}).historicalAudit,'duration_ok');
});
test('Stage 3A.1: benchmark CLI validates diagnostic controls',()=>{
  const args=parseBenchmarkArgs(['--server-dir','/tmp/server','--timing-tolerance-ms','2100','--readiness-tolerance-ms','4500']);
  assert.equal(args.timingToleranceMs,2100);
  assert.equal(args.readinessToleranceMs,4500);
  assert.throws(()=>parseBenchmarkArgs(['--server-dir','/tmp','--timing-tolerance-ms','0']),/integer/);
  assert.equal(timingToleranceMs(180000),3600);
});
test('Stage 3A.1: probe records failure if server disappears; does not invent game-level readiness',async()=>{
  const server=createServer(()=>{});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const addr=server.address();
  const monitor=monitorServer(`http://127.0.0.1:${addr.port}`,20);
  await new Promise(r=>setTimeout(r,72));
  await new Promise(r=>server.close(r));
  await new Promise(r=>setTimeout(r,75));
  const result=await monitor.stop();
  assert.ok(result.probes>=3);
  assert.ok(result.failures>=1);
});
test('Stage 3A.1: LLM diagnostics do not record prompt or response content',async()=>{
  const calls=[];
  const loop=new PlanActLoop({provider:{chat:async()=>({message:{role:'assistant',content:'SECRET NEVER LOGGED'},
    usage:{promptTokens:12,completionTokens:9},durationMs:100})},
    memory:{setObjective(){},updateObservation(){},snapshot(){return{}},objectiveVersion:1},
    tools:{getSpecs:()=>[]},log:(e,d)=>calls.push({event:e,...d})});
  const result=await loop.monitoredChat({messages:[{role:'user',content:'SECRET NEVER LOGGED'}]},'plan');
  assert.equal(result.message.content,'SECRET NEVER LOGGED');
  assert.equal(calls[0].event,'llm_model_result');
  assert.equal(calls[0].promptTokens,12);
  assert.equal(JSON.stringify(calls).includes('SECRET'),false);
  const failure=new PlanActLoop({provider:{chat:async()=>{throw Error('LLM request timed out');}},
    memory:{},tools:{},log:(e,d)=>calls.push({event:e,...d})});
  await assert.rejects(failure.monitoredChat({messages:[]},'act'));
  assert.equal(calls.at(-1).failureKind,'provider_timeout');
});
