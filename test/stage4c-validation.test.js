// @ts-nocheck -- fixture-oriented validation tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenarioList,parseEvidenceEvents,evaluateScenario,validationReport } from '../src/course/validation.js';
import { parseCourseArgs } from '../src/course/validation-runner.js';
const ev=(event,extra={})=>({event,timestamp:'2026-11-13T10:00:00.000Z',...extra});
const clean={serverStopped:true,completedWindow:true,agentEarlyExit:false,serverEarlyExit:false,interrupted:false,setupError:null};

test('Stage 4C requires correct unique scenario names, strict CLI, and fresh server dir',()=>{
  assert.deepEqual(parseScenarioList('bdi_pddl,llm_objective'),['bdi_pddl','llm_objective']);
  assert.throws(()=>parseScenarioList('bdi_pddl,bdi_pddl'),/unique/);
  assert.throws(()=>parseScenarioList('official_challenge'),/unique/);
  assert.throws(()=>parseCourseArgs(['--scenarios','bdi_pddl','--mover','astar','--server-dir','/tmp/game']),/unsupported/);
  assert.throws(()=>parseCourseArgs(['--duration','180']),/--server-dir is required/);
  const parsed=parseCourseArgs(['--server-dir','/tmp/game','--scenarios','cooperation','--duration','65'], '/tmp');
  assert.deepEqual(parsed.scenarios,['cooperation']);assert.equal(parsed.durationSec,65);
  assert.match(parsed.output,/course-validation-results/);
});

test('Stage 4C ignores non-JSON, invalid timestamps, and post-cutoff events',()=>{
  const raw='password=hidden\n'+JSON.stringify(ev('pddl_call'))+'\n'+JSON.stringify(ev('pddl_success',{timestamp:'2026-11-13T10:00:30.000Z'}))+'\n{"event":"delivery","timestamp":"bad"}\n';
  assert.deepEqual(parseEvidenceEvents(raw,Date.parse('2026-11-13T10:00:20Z')).map(x=>x.event),['pddl_call']);
});

test('Stage 4C external PDDL requires an actual completed invocation, not fallback to A*',()=>{
  const b=[ev('bdi_game_ready'),ev('intention_activated'),ev('pddl_call'),ev('pddl_failure'),ev('planner_fallback'),ev('move')];
  const failed=evaluateScenario('bdi_pddl',{bubble:b},clean);
  assert.equal(failed.passed,false);
  assert.deepEqual(failed.checks.filter(x=>!x.passed).map(x=>x.id),['external_pddl_succeeded']);
  assert.equal(evaluateScenario('bdi_pddl',{bubble:[...b,ev('pddl_success')]},clean).passed,true);
});

test('Stage 4C LLM objective requires independent verified completion and game delivery',()=>{
  const base=[ev('llm_game_ready'),ev('game_objective',{criterion:{kind:'deliver_count'}}),ev('llm_model_call'),ev('llm_tool_result',{ok:true}),ev('delivery',{parcelIds:['a']})];
  assert.equal(evaluateScenario('llm_objective',{milktea:base},clean).passed,false);
  const all=[...base,ev('game_objective_result',{status:'completed',progress:{deliveredCount:1}})];
  assert.equal(evaluateScenario('llm_objective',{milktea:all},clean).passed,true);
  assert.equal(evaluateScenario('llm_objective',{milktea:[...all,ev('action_unknown')]},clean).passed,false);
  assert.equal(evaluateScenario('llm_objective',{milktea:[...all,ev('llm_tool_result',{ok:false,errorCode:'outcome_unknown'})]},clean).passed,false);
  assert.equal(evaluateScenario('llm_objective',{milktea:[...all,ev('sdk_action_phase',{status:'unknown'})]},clean).passed,false);
});

test('Stage 4C cooperative check rejects one-way messages, unverified delivery, and no evacuation',()=>{
  const bubble=[ev('bdi_game_ready'),ev('intention_activated'),ev('coordination_sent'),ev('coordination_received'),ev('coordination_belief_merged')];
  const milk=[ev('llm_game_ready'),ev('llm_model_call'),ev('coordination_sent'),ev('coordination_received'),ev('llm_game_startup',{deliveryEvacuation:true}),ev('delivery',{parcelIds:['p']}),ev('llm_delivery_evacuate_result',{status:'vacated'})];
  assert.equal(evaluateScenario('cooperation',{bubble,milktea:milk},clean).passed,true);
  assert.equal(evaluateScenario('cooperation',{bubble,milktea:milk.filter(x=>x.event!=='llm_delivery_evacuate_result')},clean).passed,false);
  assert.equal(evaluateScenario('cooperation',{bubble:bubble.filter(x=>x.event!=='coordination_received'),milktea:milk},clean).passed,false);
});

test('Stage 4C replacement requires queued + safe switch + second goal verified with evidence in order',()=>{
  const m=[ev('llm_game_ready'),ev('course_objective_channel_ready'),ev('course_objective_started',{id:'stage4c_first'}),ev('llm_tool_result',{ok:true}),
    ev('course_objective_queued',{id:'stage4c_second'}),ev('course_objective_replacement_requested',{nextId:'stage4c_second'}),
    ev('course_objective_finished',{id:'stage4c_first',status:'cancelled'}),ev('course_objective_started',{id:'stage4c_second'}),
    ev('delivery',{parcelIds:['a']}),ev('game_objective_result',{status:'completed',progress:{deliveredCount:1}}),
    ev('course_objective_finished',{id:'stage4c_second',status:'completed'})];
  const state={...clean,goal1Sent:true,goal2Sent:true,firstToolObservedBeforeReplacement:true};
  assert.equal(evaluateScenario('objective_replace',{milktea:m},state).passed,true);
  const duplicate=m.map(x=>({...x}));duplicate.splice(9,1);
  assert.equal(evaluateScenario('objective_replace',{milktea:duplicate},state).passed,false);
  const prior=[...m];prior.splice(9,1);prior.unshift(ev('game_objective_result',{status:'completed',progress:{deliveredCount:1}}));
  assert.equal(evaluateScenario('objective_replace',{milktea:prior},state).passed,false);
  assert.equal(evaluateScenario('objective_replace',{milktea:[...m,ev('course_objective_quarantined')]},state).passed,false);
});

test('Stage 4C refuses fake-server success, interrupted windows and unclean shutdown',()=>{
  const b=[ev('bdi_game_ready'),ev('intention_activated'),ev('pddl_call'),ev('pddl_success'),ev('move')];
  assert.equal(evaluateScenario('bdi_pddl',{bubble:b},{...clean,serverStopped:false}).passed,false);
  assert.equal(evaluateScenario('bdi_pddl',{bubble:b},{...clean,interrupted:true}).passed,false);
  assert.equal(evaluateScenario('bdi_pddl',{bubble:[]},clean).passed,false);
});

test('Stage 4C report is honest about external dependencies and remaining limitations',()=>{
  const result=evaluateScenario('llm_objective',{milktea:[]},clean);
  const md=validationReport([result]);
  assert.match(md,/0\/1 scenarios passed/);
  assert.match(md,/local stdin NDJSON/);
  assert.match(md,/official Challenge 1\/2/);
  assert.match(md,/llm_confirmed_delivery/);
});
