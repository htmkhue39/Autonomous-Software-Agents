/**
 * Stage 4C: observable evidence rules for local Deliveroo.js challenge-readiness.
 * We deliberately do NOT infer game successes from process exit codes, model
 * summaries, simulator mocks, or agent-observed score alone.
 *
 * Official Challenge 1/2 graders and official remote APIs remain unverified.
 */

export const COURSE_SCENARIOS = Object.freeze({
  bdi_pddl: {
    title: 'Standalone BDI + external PDDL',
    agents: ['bubble'],
    mover: 'pddl',
    coordination: false,
    description: 'BDI intention activated, external PDDL solver called and succeeded, and actual navigation occurred.',
  },
  llm_objective: {
    title: 'Independent LLM objective',
    agents: ['milktea'],
    mover: 'astar',
    coordination: false,
    description: 'Independent LLM executes game tools and completes one locally verified natural-language delivery objective.',
  },
  cooperation: {
    title: 'BDI + LLM cooperation and traffic evacuation',
    agents: ['bubble', 'milktea'],
    mover: 'astar',
    coordination: true,
    description: 'Two independent agents exchange coordination messages, merge beliefs, and deliver with a successful LLM tile evacuation.',
  },
  objective_replace: {
    title: 'Live natural-language objective replacement',
    agents: ['bubble', 'milktea'],
    mover: 'astar',
    coordination: true,
    description: 'Local stdin update supersedes an active first objective; second goal completes after safe cancellation.',
  },
});

/** @param {string} value */
export function parseScenarioList(value) {
  const selected = value.split(',').map(x => x.trim()).filter(Boolean);
  if (!selected.length || new Set(selected).size !== selected.length || !selected.every(x => Object.hasOwn(COURSE_SCENARIOS, x))) {
    throw new Error(`--scenarios must contain unique comma-separated names: ${Object.keys(COURSE_SCENARIOS).join(',')}`);
  }
  return selected;
}

/**
 * @param {string} raw
 * @param {number} [cutoffMs]
 * @returns {any[]}
 */
export function parseEvidenceEvents(raw, cutoffMs = Infinity) {
  /** @type {any[]} */ const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value.event !== 'string') continue;
      const timestampMs = Date.parse(value.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs > cutoffMs) continue;
      events.push(value);
    } catch { /* Non-JSON process noise is never evidence. */ }
  }
  return events;
}

/** @param {any[]} events @param {string} name @param {(record:any)=>boolean} [predicate] */
export function eventCount(events, name, predicate = () => true) {
  return events.filter(x => x.event === name && predicate(x)).length;
}

/** @param {any[]} events */
function uncertainActionCount(events) {
  return eventCount(events,'action_unknown') +
    eventCount(events,'sdk_action_phase',x=>x.status==='unknown') +
    eventCount(events,'llm_tool_result',x=>x.errorCode==='outcome_unknown');
}

/**
 * Evidence rules are intentionally conservative. Everything returned here is
 * derived from logs emitted by REAL spawned agents in live test execution;
 * separate fake-server tests MUST remain explicitly negative.
 *
 * @param {string} scenario
 * @param {{bubble?:any[],milktea?:any[]}} logs
 * @param {{goal1Sent?:boolean,goal2Sent?:boolean,firstToolObservedBeforeReplacement?:boolean,agentEarlyExit?:boolean,serverEarlyExit?:boolean,setupError?:string|null,interrupted?:boolean,serverStopped?:boolean,completedWindow?:boolean}} [execution]
 */
export function evaluateScenario(scenario, logs, execution = {}) {
  if (!Object.hasOwn(COURSE_SCENARIOS, scenario)) throw new Error('Unknown validation scenario');
  const b = logs.bubble ?? [], m = logs.milktea ?? [];
  /** @type {Array<{id:string,passed:boolean,observed:number|boolean,required:string}>} */ const checks = [];
  /** @param {string} id @param {number|boolean} observed @param {number|boolean} required */
  const check = (id, observed, required = 1) => checks.push({id,passed:typeof required==='boolean' ? observed === required : typeof observed === 'number' && observed>=required,observed,required:typeof required==='boolean' ? String(required) : `>=${required}`});
  check('server_shutdown_clean',execution.serverStopped === true,true);
  check('no_early_agent_exit',execution.agentEarlyExit !== true,true);
  check('no_early_server_exit',execution.serverEarlyExit !== true,true);
  check('no_setup_error',!execution.setupError,true);
  check('not_interrupted',execution.interrupted !== true,true);
  check('window_completed',execution.completedWindow === true,true);
  if (scenario === 'bdi_pddl') {
    check('bdi_ready',eventCount(b,'bdi_game_ready'));
    check('bdi_intention_activated',eventCount(b,'intention_activated'));
    check('external_pddl_invoked',eventCount(b,'pddl_call'));
    check('external_pddl_succeeded',eventCount(b,'pddl_success'));
    check('bdi_real_move',eventCount(b,'move'));
  } else if (scenario === 'llm_objective') {
    check('llm_ready',eventCount(m,'llm_game_ready'));
    check('objective_interpreted',eventCount(m,'game_objective',x=>x.criterion?.kind === 'deliver_count'));
    check('llm_model_called',eventCount(m,'llm_model_call'));
    check('llm_game_tool_succeeded',eventCount(m,'llm_tool_result',x=>x.ok === true));
    check('llm_confirmed_delivery',eventCount(m,'delivery',x=>Array.isArray(x.parcelIds)&&x.parcelIds.length>0));
    check('objective_verified',eventCount(m,'game_objective_result',x=>x.status==='completed'&&Number(x.progress?.deliveredCount)>0));
    check('no_uncertain_action',uncertainActionCount(m)===0,true);
  } else if (scenario === 'cooperation') {
    check('bdi_ready',eventCount(b,'bdi_game_ready'));
    check('llm_ready',eventCount(m,'llm_game_ready'));
    check('independent_bdi_intention',eventCount(b,'intention_activated'));
    check('llm_model_called',eventCount(m,'llm_model_call'));
    check('bidirectional_sent',eventCount(b,'coordination_sent')>0&&eventCount(m,'coordination_sent')>0,true);
    check('bidirectional_received',eventCount(b,'coordination_received')>0&&eventCount(m,'coordination_received')>0,true);
    check('belief_merge_observed',eventCount(b,'coordination_belief_merged')+eventCount(m,'coordination_belief_merged'));
    check('llm_real_delivery',eventCount(m,'delivery',x=>Array.isArray(x.parcelIds)&&x.parcelIds.length>0));
    check('delivery_tile_evacuated',eventCount(m,'llm_delivery_evacuate_result',x=>x.status==='vacated'));
    check('evacuation_enabled',eventCount(m,'llm_game_startup',x=>x.deliveryEvacuation===true));
  } else if (scenario === 'objective_replace') {
    check('llm_ready',eventCount(m,'llm_game_ready'));
    check('channel_ready',eventCount(m,'course_objective_channel_ready'));
    check('first_goal_sent',execution.goal1Sent===true,true);
    check('second_goal_sent',execution.goal2Sent===true,true);
    check('first_tool_observed_before_replacement',execution.firstToolObservedBeforeReplacement===true,true);
    check('first_goal_started',eventCount(m,'course_objective_started',x=>x.id==='stage4c_first'));
    check('replacement_queued',eventCount(m,'course_objective_queued',x=>x.id==='stage4c_second'));
    check('safe_replacement_requested',eventCount(m,'course_objective_replacement_requested',x=>x.nextId==='stage4c_second'));
    check('second_goal_started',eventCount(m,'course_objective_started',x=>x.id==='stage4c_second'));
    check('first_goal_settled',eventCount(m,'course_objective_finished',x=>x.id==='stage4c_first'));
    const secondStart=m.findIndex(x=>x.event==='course_objective_started'&&x.id==='stage4c_second');
    const secondFinished=m.findIndex((x,i)=>i>secondStart&&x.event==='course_objective_finished'&&x.id==='stage4c_second');
    check('second_goal_verified',secondStart>=0&&secondFinished>secondStart&&m[secondFinished].status==='completed',true);
    const evidence=secondStart>=0?m.slice(secondStart+1,secondFinished>secondStart?secondFinished:undefined):[];
    check('confirmed_second_delivery',eventCount(evidence,'game_objective_result',x=>x.status==='completed'&&Number(x.progress?.deliveredCount)>0));
    check('no_quarantine',eventCount(m,'course_objective_quarantined')===0,true);
    check('no_uncertain_action',uncertainActionCount(m)===0,true);
  }
  const observed = {
    bdiIntentions:eventCount(b,'intention_activated'), pddlCalls:eventCount(b,'pddl_call'), pddlSuccess:eventCount(b,'pddl_success'),
    bdiDeliveries:eventCount(b,'delivery'),llmDeliveries:eventCount(m,'delivery'),
    llmModelCalls:eventCount(m,'llm_model_call'),llmToolResults:eventCount(m,'llm_tool_result'),
    coordinationMessages:eventCount(b,'coordination_received')+eventCount(m,'coordination_received'),
    beliefMerges:eventCount(b,'coordination_belief_merged')+eventCount(m,'coordination_belief_merged'),
    llmEvacuations:eventCount(m,'llm_delivery_evacuate_result',x=>x.status==='vacated'),
    objectiveStarts:eventCount(m,'course_objective_started'),objectiveQuarantines:eventCount(m,'course_objective_quarantined'),
  };
  return {scenario,passed:checks.every(x=>x.passed),checks,observed,limitations:[
    'Local Deliveroo.js game only; not official course Challenge 1/2 evaluation.',
    'Scores and deliveries are agent-observed, not official Tournament outcomes.',
    scenario==='objective_replace' ? 'Objective update uses a local stdin NDJSON fixture, not an official instructor channel.' : null,
  ].filter(Boolean)};
}

/** @param {Array<ReturnType<typeof evaluateScenario> & {elapsedMs?:number|null}>} results */
export function validationReport(results) {
  const total=results.length, passed=results.filter(r=>r.passed).length;
  const lines=[
    '# Stage 4C — Local End-to-End Course Readiness',
    '',`**Results:** ${passed}/${total} scenarios passed.`,
    '', '| Scenario | Result | Evidence |','|---|---|---|',
    ...results.map(r=>`| ${r.scenario} | ${r.passed?'PASS':'FAIL'} | ${Object.entries(r.observed).filter(([,v])=>typeof v==='number'&&v>0).map(([k,v])=>`${k}=${v}`).join(', ')||'none'} |`),
    '', '## Evidence gaps', '',
    ...results.flatMap(r=>r.checks.filter(c=>!c.passed).map(c=>`- **${r.scenario} / ${c.id}:** observed ${c.observed}, required ${c.required}`)),
    ...(results.every(r=>r.passed)?['- No missing evidence within these local scenarios.']:[]),
    '', '## Interpretation and limitations', '',
    '- These scenarios use local live Deliveroo.js servers. A separate mock-server process test is NOT live evidence.',
    '- The result is **course readiness**, not official Challenge 1/2 certification.',
    '- External PDDL success depends on the real external online solver being reachable.',
    '- Optional external instructor LLM/MCP endpoints are **not verified**; local Ollama and SDK tools are used here.',
    '- Objective replacement uses a local stdin NDJSON test channel; the official delivery contract remains unspecified.',
    '- Scenario timeouts are maximum observation windows, not comparable fixed-duration performance benchmarks.',
    '- Failure recovery is covered by deterministic simulator/regression tests separately and should not be called a live fault-injection success.',
    '- Retain raw logs locally; do not publish JWTs or private runtime evidence without review.',
    '', '## Raw evidence', '',
    'Each scenario directory contains `server.log`, agent JSONL logs and `result.json` with individual pass/fail checks.',
  ];
  return lines.join('\n')+'\n';
}
