// @ts-nocheck -- fixtures intentionally contain only needed per-trial metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAblationArgs, HELP } from '../scripts/run-ablation.js';
import { scheduleAblation, compareIndependentSamples, validateAblationTrial, analyzeAblation,
  asAblationCsv, ablationMarkdown, ablationScoreSvg } from '../src/benchmark/ablation.js';
import { parseAgentLog } from '../src/benchmark/results.js';

const dataOff=[183,663,206,106,341];
const dataOn=[703,597,417,414,441];
const baseRow=(condition,trial,score,valid=true)=>({mode:'C',condition,block:trial,trial,
  schedulingSeed:42,valid,label:'cooperative',issues:valid?[]:['early_agent_exit'],teamObservedScore:score,
  totalDeliveredParcels:condition==='C0'?17:32,
  bubbleObservedScore:score-60,milkteaObservedScore:60,
  bdiTeammateCongestionFailures:condition==='C0'?5:1,
  llmDeliveryTileDwellMeanMs:condition==='C0'?24000:100,
  llmDeliveryTileDwellCensored:condition==='C0'?1:0,
  llmDeliveryEvacuationAttempts:condition==='C0'?0:4,
  llmDeliveryEvacuationSuccesses:condition==='C0'?0:4,
  llmModelLatencyMeanMs:6500,llmDeliveryEvacuationEnabled:condition==='C1'});
const fixtures=()=>[
  ...dataOff.map((n,i)=>baseRow('C0',i+1,n)),
  ...dataOn.map((n,i)=>baseRow('C1',i+1,n)),
];
const manifest={config:{runs:5,durationSec:180,game:'oval_counterclockwise',mover:'astar',
  ablationSchedulingSeed:42,llmModel:'qwen3.5:4b-q4_K_M',revision:{agent:null,server:null}}};

test('Stage 3C.3: CLI accepts scheduled ablation, not user-supplied mode or invalid seeds',()=>{
  const args=parseAblationArgs(['--server-dir','/tmp/Deliveroo.js','--runs','5','--duration','45','--schedule-seed','42']);
  assert.deepEqual(args.modes,['C']);
  assert.equal(args.ablation.schedulingSeed,42);
  assert.equal(args.runs,5);
  assert.equal(args.durationSec,45);
  assert.match(args.output,/ablation-results/);
  assert.match(HELP,/ORDER seed/);
  assert.throws(()=>parseAblationArgs(['--server-dir','/tmp','--modes','A,C']),/modes is not supported/);
  for(const bad of ['-1','4294967296','1.5','abc'])
    assert.throws(()=>parseAblationArgs(['--server-dir','/tmp','--schedule-seed',bad]),/seed/);
  assert.throws(()=>parseAblationArgs(['--duration','20']),/server-dir is required/);
  assert.equal(parseAblationArgs(['--server-dir','/tmp']).runs,10);
  assert.equal(parseAblationArgs(['--help']).help,true);
});

test('Stage 3C.3: reproducible, balanced within blocks AND balanced first-position assignment',()=>{
  const a=scheduleAblation(10,42);
  assert.equal(a.length,20);
  assert.deepEqual(a,scheduleAblation(10,42));
  assert.notDeepEqual(a,scheduleAblation(10,43));
  for(let i=0;i<a.length;i+=2){
    assert.deepEqual(new Set([a[i].condition,a[i+1].condition]),new Set(['C0','C1']));
    assert.equal(a[i].block,a[i+1].block);
    assert.equal(a[i].ordinal,i+1);
    assert.equal(a[i+1].ordinal,i+2);
    for(const r of [a[i],a[i+1]]) {
      assert.equal(r.mode,'C');
      assert.equal(r.evacuationEnabled,r.condition==='C1');
    }
  }
  assert.equal(a.filter((v,i)=>i%2===0 && v.condition==='C0').length,5);
  assert.equal(a.filter((v,i)=>i%2===0 && v.condition==='C1').length,5);
  assert.equal(scheduleAblation(5,42).filter((v,i)=>i%2===0 && v.condition==='C0').length>=2,true);
  assert.throws(()=>scheduleAblation(0,42),/runs/);
  assert.throws(()=>scheduleAblation(2,-1),/seed/);
});

test('Stage 3C.3: effective startup event overrides assumptions and mismatches invalidate',()=>{
  const startup=(v)=>parseAgentLog(JSON.stringify({timestamp:'2026-11-12T20:00:00Z',event:'llm_game_startup',deliveryEvacuation:v}),{name:'milktea'});
  assert.equal(startup(true).deliveryEvacuationEnabled,true);
  assert.equal(startup(false).deliveryEvacuationEnabled,false);
  for(const condition of ['C0','C1']) {
    const enabled=condition==='C1';
    const ok=validateAblationTrial({valid:true,issues:[],llmDeliveryEvacuationEnabled:enabled},
      {condition,block:1,evacuationEnabled:enabled},42);
    assert.equal(ok.valid,true); assert.equal(ok.expectedEvacuationEnabled,enabled);
    const wrong=validateAblationTrial({valid:true,issues:[],llmDeliveryEvacuationEnabled:!enabled},
      {condition,block:1,evacuationEnabled:enabled},42);
    assert.equal(wrong.valid,false);
    assert.deepEqual(wrong.issues,['evacuation_setting_mismatch']);
  }
  const missing=validateAblationTrial({valid:true,issues:[],llmDeliveryEvacuationEnabled:null},
    {condition:'C1',block:2,evacuationEnabled:true},100);
  assert.equal(missing.valid,false);
});

test('Stage 3C.3: published 5+5 control/treatment fixture yields exact descriptive effects and uncertain CI',()=>{
  const stats=analyzeAblation(fixtures());
  const score=stats.comparisons.teamObservedScore;
  assert.equal(score.baseline.mean,299.8);
  assert.equal(score.treatment.mean,514.4);
  assert.ok(Math.abs(score.difference-214.6)<1e-8);
  assert.ok(Math.abs(score.relativePercent-71.581054)<0.01);
  assert.ok(score.ci95[0]<0 && score.ci95[1]>0);
  assert.equal(score.probabilitySuperiority,0.84);
  assert.equal(stats.groups.C0.metrics.bdiTeammateCongestionFailures.mean,5);
  assert.equal(stats.groups.C1.metrics.bdiTeammateCongestionFailures.mean,1);
  assert.equal(stats.groups.C0.tileDwellCensored,5);
  assert.equal(stats.groups.C1.evacuationSuccesses,20);
  assert.equal(stats.design,'balanced_randomized_order_not_matched_game_worlds');
});

test('Stage 3C.3: invalid rounds remain in completeness metrics but not score inference',()=>{
  const rows=[...fixtures(),baseRow('C1',6,99999,false)];
  const result=analyzeAblation(rows);
  assert.equal(result.groups.C1.attempted,6);
  assert.equal(result.groups.C1.valid,5);
  assert.equal(result.groups.C1.invalid,1);
  assert.equal(result.groups.C1.issues.early_agent_exit,1);
  assert.equal(result.comparisons.teamObservedScore.treatment.mean,514.4);
  const csv=asAblationCsv(rows);
  assert.match(csv,/condition,block,schedulingSeed,mode/);
  assert.match(csv,/C1,6,42,C,cooperative,6,false,early_agent_exit/);
});

test('Stage 3C.3: missing, singleton, zero variance cases do not fabricate significance',()=>{
  assert.equal(compareIndependentSamples([], [10]).difference,null);
  assert.equal(compareIndependentSamples([1],[3]).ci95,null);
  assert.deepEqual(compareIndependentSamples([7,7],[7,7]).ci95,[0,0]);
  assert.equal(compareIndependentSamples([7,7],[7,7]).hedgesG,null);
  assert.equal(compareIndependentSamples([0,0],[10,10]).relativePercent,null);
});

test('Stage 3C.3: report and SVG include research caveats and never mislabel scores',()=>{
  const analysis=analyzeAblation(fixtures());
  const report=ablationMarkdown(analysis,manifest);
  assert.match(report,/214\.6 points \(71\.6%/);
  assert.match(report,/NOT official Tournament/);
  assert.match(report,/not.*identical game states/i);
  assert.match(report,/unpaired/i);
  assert.match(report,/censored/i);
  assert.match(report,/score-distribution.svg/);
  const svg=ablationScoreSvg(fixtures());
  assert.match(svg,/xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg,/NOT Tournament/);
  assert.match(svg,/circle/);
  assert.ok(!svg.includes('undefined'));
  assert.match(ablationMarkdown(analyzeAblation([]),manifest),/not estimable/);
});
