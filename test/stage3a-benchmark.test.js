// @ts-nocheck -- mocks intentionally model only the benchmark log/runner contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runContinuousBenchmark, abortablePause } from '../src/benchmark/continuous.js';
import { parseAgentLog, buildTrialSummary, aggregateRounds, asCsv, MODES } from '../src/benchmark/results.js';
import { parseBenchmarkArgs, scheduleRounds, isPortOpen, waitForServer, runBenchmarks } from '../src/benchmark/runner.js';

const makeEvent = (event, detail = {}, at = '2026-11-12T14:00:00.000Z') => JSON.stringify({timestamp:at,event,...detail});

test('Stage 3A: opt-in continuous sessions repeat verified goals and aggregate REAL episode metrics', async () => {
  let clock = 0;
  let invoked = 0;
  const events = [];
  const finished = await runContinuousBenchmark({ deadlineMs: 5000,
    now: () => clock, pause: async (_, ms) => { clock += ms; }, pauseMs: 1000,
    log: (event, data) => events.push({ event, ...data }), readScore: () => 55,
    runObjective: async (objective) => {
      assert.equal(objective, 'Deliver 3 parcels');
      invoked++;
      return { status:'completed', reason:'verified', progress:{deliveredCount:3,deliveryActions:2,currentScore:invoked*10},
        metrics:{llmCalls:4,toolCalls:3,successfulTools:3,failedGameActions:0} };
    },
  });
  assert.equal(invoked, 5);
  assert.equal(finished.status, 'deadline_reached');
  assert.equal(finished.episodes, 5);
  assert.equal(finished.completedEpisodes, 5);
  assert.equal(finished.deliveredCount, 15);
  assert.equal(finished.deliveryActions, 10);
  assert.equal(finished.metrics.llmCalls, 20);
  assert.equal(finished.metrics.toolCalls, 15);
  assert.equal(finished.currentScore, 55);
  assert.equal(events.filter(e => e.event === 'llm_benchmark_episode_result').length, 5);
  assert.equal(events.at(-1).event, 'llm_benchmark_session_result');
});

test('Stage 3A: uncertain SDK outcome is terminal even in continuous mode', async () => {
  let called = 0;
  const result = await runContinuousBenchmark({ deadlineMs: Date.now()+60_000,
    pauseMs:0, runObjective:async()=>{called++;return {status:'blocked',reason:'uncertain_tool_outcome',
      progress:{deliveredCount:0,deliveryActions:0},metrics:{uncertainOutcomes:1}};},
  });
  assert.equal(called, 1, 'must not replay potentially executed pickup/putdown');
  assert.equal(result.status, 'blocked_uncertain_outcome');
  assert.equal(result.metrics.uncertainOutcomes, 1);
});

test('Stage 3A: stalled LLM episode gets bounded retry instead of prematurely ending a timed session', async () => {
  let clock = 0;
  let n = 0;
  const result = await runContinuousBenchmark({ deadlineMs: 2500, pauseMs:1000,
    now:()=>clock, pause:async(_signal,ms)=>{clock+=ms;},
    runObjective:async()=>{
      n++;
      return { status:n===3?'completed':'stalled',reason:n===3?'verified':'no_tool_calls',
        progress:{deliveredCount:n===3?3:0,deliveryActions:n===3?1:0},
        metrics:{llmCalls:2,toolCalls:n===3?1:0} };
    } });
  assert.equal(n, 3);
  assert.equal(result.completedEpisodes, 1);
  assert.equal(result.deliveredCount, 3);
});

test('Stage 3A: aborted session stops without executing another objective', async () => {
  const ctrl = new AbortController();
  const result = await runContinuousBenchmark({ deadlineMs:Date.now()+100000, signal:ctrl.signal,
    runObjective:async()=>{ctrl.abort();return {status:'cancelled',reason:'objective_replaced_or_cancelled',
      progress:{deliveredCount:0,deliveryActions:0},metrics:{}};} });
  assert.equal(result.episodes,1);
  assert.equal(result.status,'interrupted');
  await abortablePause(ctrl.signal,500);
});

test('Stage 3A: parser uses deadline cutoff and does not treat game log score as Tournament score', () => {
  const text = [
    makeEvent('bdi_game_ready',{level:'oval'}),
    makeEvent('score_observed',{score:0}),
    makeEvent('pickup',{parcelIds:['p1','p2']}),
    makeEvent('delivery',{parcelIds:['p1','p2']}),
    makeEvent('score_changed',{previous:0,score:20}),
    makeEvent('score_changed',{previous:20,score:999},'2026-11-12T14:03:01.000Z'),
    '{not-valid-json',
    'Disconnected from server',
  ].join('\n');
  const bdi = parseAgentLog(text, { name:'bubble',cutoffMs:Date.parse('2026-11-12T14:03:00.000Z') });
  assert.equal(bdi.score,20);
  assert.equal(bdi.deliveredParcels,2);
  assert.equal(bdi.deliveryActions,1);
  assert.equal(bdi.ready,true);
  assert.equal(bdi.invalidJsonLines,1);
  const trial = buildTrialSummary({mode:'A',trial:1,durationMs:180000,actualDurationMs:180000,
    agents:{bubble:bdi}});
  assert.equal(trial.valid,true);
  assert.equal(trial.teamObservedScore,20);
  assert.equal(trial.officialTournamentScore,null);
  assert.match(trial.scoreSource,/not_tournament/);
});

test('Stage 3A: independent and cooperative trials retain identical agent counts but different coordination mode', () => {
  const bdi = parseAgentLog([makeEvent('bdi_game_ready'),makeEvent('score_observed',{score:25}),makeEvent('delivery',{parcelIds:['x']})].join('\n'));
  const llm = parseAgentLog([makeEvent('llm_game_ready',{score:0}),
    makeEvent('game_objective_result',{status:'completed',reason:'verified',progress:{currentScore:15},metrics:{llmCalls:5,toolCalls:4,successfulTools:4}}),
    makeEvent('llm_benchmark_episode_started',{}),
    makeEvent('delivery',{parcelIds:['y','z']})].join('\n'));
  for (const mode of ['B','C']) {
    const result = buildTrialSummary({mode,trial:1,durationMs:180000,actualDurationMs:180000,
      agents:{bubble:bdi,milktea:llm}});
    assert.equal(result.valid,true);
    assert.equal(result.teamObservedScore,40);
    assert.equal(result.totalDeliveredParcels,3);
    assert.equal(result.llmCalls,5);
    assert.equal(result.llmCompletedObjectives,1);
    assert.equal(result.llmEpisodes,1);
  }
  assert.equal(MODES.B.coordination,false);
  assert.equal(MODES.C.coordination,true);
});

test('Stage 3A: invalid rounds are excluded from means and CSV reports missing scores as blank', () => {
  const base = {mode:'C',label:'cooperative',trial:1,valid:true,issues:[],teamObservedScore:60,
    totalDeliveredParcels:4,llmCalls:9};
  const invalid = {...base,trial:2,valid:false,issues:['early_agent_exit'],teamObservedScore:null};
  const aggregate = aggregateRounds([base,invalid]);
  assert.equal(aggregate[0].meanObservedScore,60);
  assert.equal(aggregate[0].validTrials,1);
  const csv=asCsv([base,invalid]);
  assert.match(csv,/teamObservedScore/);
  assert.match(csv,/early_agent_exit/);
});

test('Stage 3A: robust flag validation rejects missing fresh-server directory, unsafe args and duplicate modes', () => {
  assert.throws(()=>parseBenchmarkArgs([]),/server-dir is required/);
  assert.throws(()=>parseBenchmarkArgs(['--server-dir','/tmp','--modes','A,A']),/unique/);
  assert.throws(()=>parseBenchmarkArgs(['--server-dir','/tmp','--duration','0']),/integer/);
  assert.throws(()=>parseBenchmarkArgs(['--server-dir','/tmp','--mover','rocket']),/astar or pddl/);
  assert.throws(()=>parseBenchmarkArgs(['--server-dir','/tmp','--game','evil;rm -rf']),/unsupported characters/);
  assert.throws(()=>parseBenchmarkArgs(['--server-dir','/tmp','--host','http://u:p@localhost:8080']),/without credentials/);
  const args=parseBenchmarkArgs(['--server-dir','/tmp/Deliveroo.js','--runs','5','--duration','180','--modes','B,C']);
  assert.equal(args.runs,5);
  assert.equal(args.durationSec,180);
  assert.deepEqual(args.modes,['B','C']);
});

test('Stage 3A: balanced interleaved schedule rotates modes across repeated rounds', () => {
  assert.deepEqual(scheduleRounds(['A','B','C'],3).map(x=>x.mode),['A','B','C','B','C','A','C','A','B']);
  assert.deepEqual(scheduleRounds(['B'],2).map(x=>x.mode),['B','B']);
});

test('Stage 3A: TCP readiness detection works and runner refuses an already-running server', async () => {
  const server=createServer(()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  const host=`http://127.0.0.1:${address.port}`;
  const dir=await mkdtemp(join(tmpdir(),'stage3a-smoke-'));
  try {
    assert.equal(await isPortOpen(host),true);
    await waitForServer(host,500);
    await writeFile(join(dir,'package.json'),'{"scripts":{"start":"node server.js"}}');
    const args=parseBenchmarkArgs(['--server-dir',dir,'--host',host,'--duration','5','--runs','1',
      '--modes','A','--output',join(dir,'output')]);
    await assert.rejects(runBenchmarks(args,new AbortController().signal),/Port already occupied/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    assert.equal(await isPortOpen(host),false);
    await rm(dir,{recursive:true,force:true});
  }
});

test('Stage 3A: model and tool events from an unfinished objective count toward the deadline metrics', () => {
  const log = [makeEvent('llm_game_ready',{score:0}),
    makeEvent('llm_model_call',{phase:'plan'}),
    makeEvent('llm_model_call',{phase:'act'}),
    makeEvent('llm_tool_result',{name:'explore',ok:true}),
    makeEvent('llm_model_call',{phase:'act'}),
  ].join('\n');
  const measured = parseAgentLog(log, {name:'milktea'});
  assert.equal(measured.ready,true);
  assert.equal(measured.score,0);
  assert.equal(measured.llmCalls,3);
  assert.equal(measured.toolCalls,1);
  assert.equal(measured.successfulTools,1);
  assert.equal(measured.completedObjectives,0);
});
