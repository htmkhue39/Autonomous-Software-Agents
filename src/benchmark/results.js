/** Stage 3 benchmark log metrics. These are AGENT-OBSERVED results, not official Tournament scores. */
import { readFile } from 'node:fs/promises';

export const DEFAULT_TIMING_TOLERANCE_MS = 2000;
/** @param {number} durationMs */
export const timingToleranceMs = durationMs => Math.max(DEFAULT_TIMING_TOLERANCE_MS, Math.ceil(durationMs * 0.02));

/** @param {number[]} values
 * @returns {{n:number,mean:number|null,median:number|null,p95:number|null,sampleStdev:number|null,ci95:number[]|null}} */
export function describeSamples(values) {
  const xs = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length) return { n:0, mean:null, median:null, p95:null, sampleStdev:null, ci95:null };
  const n = xs.length;
  const mean = xs.reduce((a,b)=>a+b,0)/n;
  const sampleStdev = n >= 2 ? Math.sqrt(xs.reduce((a,b)=>a+(b-mean)**2,0)/(n-1)) : null;
  const median = n%2 ? xs[(n-1)/2] : (xs[n/2-1]+xs[n/2])/2;
  const p95 = xs[Math.ceil(n*0.95)-1];
  const t = studentT95(n-1);
  const halfWidth = sampleStdev === null ? null : t*sampleStdev/Math.sqrt(n);
  return { n,mean,median,p95,sampleStdev,ci95:halfWidth===null?null:[mean-halfWidth,mean+halfWidth] };
}

/** Two-sided 95% Student-t critical approximation (exact table entries for df=1..30; >=30 use normal approximation).
 * @param {number} df */
export function studentT95(df) {
  const table = [0,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.160,2.145,2.131,2.120,2.110,2.101,2.093,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.048,2.045,2.042];
  if (!Number.isFinite(df) || df <= 0) return NaN;
  if (df >= 30) { const inv=1/df; return 1.95996398454 + 2.3723*inv + 2.8225*inv**2; }
  const lo=Math.floor(df), hi=Math.ceil(df);
  return lo===hi?table[lo]:table[lo]+(table[hi]-table[lo])*(df-lo);
}

/** Independent, unpaired Welch comparison. Not causal without controlled worlds.
 * @param {any[]} rounds @param {string} baseline @param {string} treatment */
export function compareModes(rounds,baseline='B',treatment='C') {
  /** @param {string} mode */ const get = mode => describeSamples(rounds.filter(r=>r.mode===mode&&r.valid&&Number.isFinite(r.teamObservedScore)).map(r=>r.teamObservedScore));
  const a=get(baseline), b=get(treatment);
  if (a.mean === null || b.mean === null) return { baseline,treatment,nBaseline:a.n,nTreatment:b.n,difference:null,relativePercent:null,ci95:null,method:'unpaired_welch_95' };
  const difference=b.mean-a.mean;
  const relativePercent=a.mean===0?null:difference/a.mean*100;
  let ci95=null;
  if (a.n>=2 && b.n>=2 && a.sampleStdev !== null && b.sampleStdev !== null) {
    const va=a.sampleStdev**2/a.n, vb=b.sampleStdev**2/b.n;
    const se=Math.sqrt(va+vb);
    const df=se===0?Infinity:(va+vb)**2/(va**2/(a.n-1)+vb**2/(b.n-1));
    const half=se===0?0:studentT95(df)*se;
    ci95=[difference-half,difference+half];
  }
  return {baseline,treatment,nBaseline:a.n,nTreatment:b.n,difference,relativePercent,ci95,method:'unpaired_welch_95'};
}


export const MODES = Object.freeze({
  A: { label: 'bdi_alone', llm: false, coordination: false },
  B: { label: 'independent', llm: true, coordination: false },
  C: { label: 'cooperative', llm: true, coordination: true },
});

/** @param {string} text @param {{name?:string,cutoffMs?:number}} [options] */
export function parseAgentLog(text, { name = 'unknown', cutoffMs = Infinity } = {}) {
  /** @type {Record<string,number>} */
  const counts = {};
  let score = null;
  let parsed = 0;
  let invalidJsonLines = 0;
  let deliveredParcels = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let successfulTools = 0;
  let failedGameActions = 0;
  let uncertainOutcomes = 0;
  let completedObjectives = 0;
  let toolResultsSeen = 0;
  let successfulToolResults = 0;
  let failedActionResults = 0;
  let uncertainToolResults = 0;
  let llmSessions = 0;
  let observedGameTitle = null;
  let llmFinalStatus = null;
  /** @type {boolean|null} */ let deliveryEvacuationEnabled = null;
  let firstEventAt = null;
  let lastEventAt = null;
  let ready = false;
  /** @type {number|null} */ let readyAt = null;
  /** @type {Record<string,number[]>} */ const durations = {};
  /** @type {Record<string,number>} */ const outcomeCounts = {};
  /** @type {Record<string,{calls:number,failed:number,totalMs:number,maxMs:number}>} */ const toolTimings = {};
  let scoreEvidence = null;
  let maxScoreObserved = null;
  // A confirmed delivery starts a tile-occupancy interval. Only an observed
  // MOVE to a different tile ends it; unfinished intervals are right-censored.
  /** @type {{at:number,x:number,y:number}|null} */ let deliveryTileHold = null;
  /** @type {number[]} */ const deliveryTileDwellsMs = [];
  let deliveryTileDwellCensored = 0;
  let teammateCongestionFailures = 0;
  let npcCongestionFailures = 0;
  /** @type {Record<string,number>} */ const evacuationStatusCounts = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    /** @type {any} */ let record;
    try { record = JSON.parse(trimmed); }
    catch { invalidJsonLines++; continue; }
    if (!record || typeof record.event !== 'string') continue;
    const at = Date.parse(record.timestamp);
    if (Number.isFinite(at) && at > cutoffMs) continue;
    if (firstEventAt === null && Number.isFinite(at)) firstEventAt = at;
    if (Number.isFinite(at)) lastEventAt = at;
    parsed++;
    counts[record.event] = (counts[record.event] ?? 0) + 1;
    if (name === 'milktea' && record.event === 'delivery' && Number.isFinite(at) &&
        Number.isInteger(record.x) && Number.isInteger(record.y)) {
      if (deliveryTileHold) deliveryTileDwellCensored++;
      deliveryTileHold = { at, x: record.x, y: record.y };
    }
    if (name === 'milktea' && record.event === 'move' && deliveryTileHold && Number.isFinite(at) &&
        Number.isInteger(record.x) && Number.isInteger(record.y) &&
        (record.x !== deliveryTileHold.x || record.y !== deliveryTileHold.y)) {
      deliveryTileDwellsMs.push(Math.max(0, at - deliveryTileHold.at));
      deliveryTileHold = null;
    }
    if (name === 'milktea' && record.event === 'llm_delivery_evacuate_result' && typeof record.status === 'string') {
      evacuationStatusCounts[record.status] = (evacuationStatusCounts[record.status] ?? 0) + 1;
    }
    if (name === 'bubble' && record.event === 'navigation_failed' && record.failureKind === 'congestion' &&
        Array.isArray(record.blockers)) {
      if (record.blockers.some((/** @type {{name?:string}} */ b) => b.name === 'milktea')) teammateCongestionFailures++;
      if (record.blockers.some((/** @type {{name?:string}} */ b) => b.name !== 'milktea')) npcCongestionFailures++;
    }
    if (record.event === 'llm_game_ready' || record.event === 'bdi_game_ready') {
      ready = true;
      if (readyAt === null && Number.isFinite(at)) readyAt = at;
    }
    if (['llm_model_result','llm_tool_result','plan_phase','sdk_action_phase','llm_dynamic_phase'].includes(record.event) &&
      Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      const group = record.event === 'plan_phase' ? `plan:${record.planType}:${record.phase}`
        : record.event === 'sdk_action_phase' ? `sdk:${record.action}`
        : record.event === 'llm_dynamic_phase' ? `dynamic:${record.phase}` : record.event;
      (durations[group] ??= []).push(record.durationMs);
      if (record.event === 'llm_tool_result' && typeof record.name === 'string') {
        const bucket = toolTimings[record.name] ??= { calls:0,failed:0,totalMs:0,maxMs:0 };
        bucket.calls++; bucket.failed+=record.ok===false?1:0; bucket.totalMs+=record.durationMs;
        bucket.maxMs=Math.max(bucket.maxMs,record.durationMs);
      }
    }
    if (record.event === 'sdk_action_phase' && record.status === 'unknown') {
      counts.sdk_action_phase_unknown = (counts.sdk_action_phase_unknown ?? 0) + 1;
    }
    if (record.event === 'llm_tool_result' && record.errorCode === 'outcome_unknown') {
      const origin = typeof record.timeoutOrigin === 'string' ? record.timeoutOrigin : 'unclassified';
      outcomeCounts[origin] = (outcomeCounts[origin]??0)+1;
    }
    if (record.event === 'llm_game_startup' && typeof record.deliveryEvacuation === 'boolean') deliveryEvacuationEnabled = record.deliveryEvacuation;
    if (record.event === 'llm_game_ready' && typeof record.level === 'string') observedGameTitle = record.level;
    if (record.event === 'bdi_game_ready' && typeof record.level === 'string') observedGameTitle = record.level;
    const candidateScore = record.event === 'score_changed' || record.event === 'score_observed' || record.event === 'benchmark_bdi_final' || record.event === 'llm_game_ready'
      ? record.score : record.event === 'game_objective_result' ? record.progress?.currentScore
        : record.event === 'llm_benchmark_session_result' ? record.currentScore : null;
    if (typeof candidateScore === 'number' && Number.isFinite(candidateScore)) {
      score = candidateScore;
      scoreEvidence = record.event;
      maxScoreObserved = Math.max(maxScoreObserved ?? -Infinity, candidateScore);
    }
    if (record.event === 'delivery') deliveredParcels += Array.isArray(record.parcelIds) ? record.parcelIds.length : 0;
    if (record.event === 'llm_tool_result') {
      toolResultsSeen++;
      if (record.ok === true) successfulToolResults++;
      else if (record.errorCode === 'outcome_unknown') uncertainToolResults++;
      else if (!['invalid_arguments', 'unknown_tool'].includes(record.errorCode) && record.precondition !== true) failedActionResults++;
    }
    if (record.event === 'game_objective_result') {
      if (record.status === 'completed' && record.reason === 'verified') completedObjectives++;
      const met = record.metrics || {};
      llmCalls += Number(met.llmCalls ?? 0);
      toolCalls += Number(met.toolCalls ?? 0);
      successfulTools += Number(met.successfulTools ?? 0);
      failedGameActions += Number(met.failedGameActions ?? 0);
      uncertainOutcomes += Number(met.uncertainOutcomes ?? 0);
    }
    if (record.event === 'llm_benchmark_session_result') {
      llmSessions++;
      llmFinalStatus = record.status ?? null;
    }
  }
  // Per-call events also count an active episode that was interrupted at the
  // deadline, which has no game_objective_result yet.
  if ((counts.llm_model_call ?? 0) > 0) llmCalls = counts.llm_model_call;
  if (toolResultsSeen > 0) {
    toolCalls = toolResultsSeen;
    successfulTools = successfulToolResults;
    failedGameActions = failedActionResults;
    uncertainOutcomes = uncertainToolResults;
  }
  if (deliveryTileHold) deliveryTileDwellCensored++;
  return { name, parsed, invalidJsonLines, counts, score, scoreEvidence,
    maxScoreObserved, deliveredParcels, deliveryActions: counts.delivery ?? 0,
    pickups: counts.pickup ?? 0, llmCalls, toolCalls, successfulTools,
    failedGameActions, uncertainOutcomes, completedObjectives, llmSessions,
    llmFinalStatus, deliveryEvacuationEnabled, ready, readyAt, observedGameTitle, firstEventAt, lastEventAt,
    timing: Object.fromEntries(Object.entries(durations).map(([k,v])=>[k,describeSamples(v)])),
    toolTimings, unknownOutcomeOrigins: outcomeCounts,
    deliveryTileDwell: { ...describeSamples(deliveryTileDwellsMs), censored: deliveryTileDwellCensored },
    teammateCongestionFailures, npcCongestionFailures, evacuationStatusCounts };
}

/** @param {string} file @param {{name?:string,cutoffMs?:number}} [options] */
export async function readAgentLog(file, options = {}) {
  return parseAgentLog(await readFile(file, 'utf8'), options);
}

/** @param {{mode:string,trial:number,durationMs:number,actualDurationMs:number,agents:Record<string,any>,exits?:Record<string,any>,serverStopped?:boolean,completedWindow?:boolean,timingToleranceMs?:number,readinessToleranceMs?:number,serverHealth?:any,roundStartedAt?:number,agentStartTimes?:Record<string,number>,actualWallDurationMs?:number}} setup */
export function buildTrialSummary({ mode, trial, durationMs, actualDurationMs, agents, exits = {}, serverStopped = true, completedWindow = true,
  timingToleranceMs: allowedTimingMs = timingToleranceMs(durationMs), readinessToleranceMs = 15000,
  serverHealth = undefined, roundStartedAt = undefined, agentStartTimes = {}, actualWallDurationMs = actualDurationMs }) {
  const definition = MODES[/** @type {keyof typeof MODES} */ (mode)];
  if (!definition) throw new Error(`Unknown benchmark mode: ${mode}`);
  const names = definition.llm ? ['bubble', 'milktea'] : ['bubble'];
  const present = names.every(name => agents[name]?.ready);
  const remainedRunning = names.every(name => !exits[name]?.earlyExit);
  const scoresComplete = names.every(name => typeof agents[name]?.score === 'number');
  const teamObservedScore = scoresComplete ? names.reduce((sum, name) => sum + agents[name].score, 0) : null;
  const sum = (/** @type {string} */ field) => names.reduce((total, name) => total + Number(agents[name]?.[field] ?? 0), 0);
  const count = (/** @type {string} */ event) => names.reduce((total, name) => total + Number(agents[name]?.counts?.[event] ?? 0), 0);
  const durationDriftMs = actualDurationMs - durationMs;
  const wallDriftMs=actualWallDurationMs-durationMs;
  const durationWithinTolerance = Number.isFinite(actualDurationMs) && Math.abs(durationDriftMs) <= allowedTimingMs &&
    Number.isFinite(actualWallDurationMs) && Math.abs(wallDriftMs) <= allowedTimingMs;
  const readinessDelaysMs = Object.fromEntries(names.map(name => [name,
    agents[name]?.readyAt == null ? null : agents[name].readyAt - (agentStartTimes[name] ?? roundStartedAt ?? agents[name].readyAt)]));
  const readyOffsets = names.map(name => agents[name]?.readyAt).filter(Number.isFinite);
  const readinessSkewMs = readyOffsets.length === names.length && names.length > 1
    ? Math.max(...readyOffsets) - Math.min(...readyOffsets) : null;
  const readinessWithinTolerance = readinessSkewMs === null || readinessSkewMs <= readinessToleranceMs;
  const serverResponsive = !serverHealth || serverHealth.failures === 0;
  const valid = present && remainedRunning && completedWindow && scoresComplete && serverStopped && durationWithinTolerance && readinessWithinTolerance && serverResponsive;
  const issues = [];
  if (!present) issues.push('agent_not_ready');
  if (!remainedRunning) issues.push('early_agent_exit');
  if (!completedWindow) issues.push('incomplete_round');
  if (!scoresComplete) issues.push('missing_score_observation');
  if (!serverStopped) issues.push('server_not_stopped');
  if (!durationWithinTolerance) issues.push('duration_out_of_tolerance');
  if (!readinessWithinTolerance) issues.push('readiness_skew_exceeded');
  if (!serverResponsive) issues.push('server_probe_failed');
  return { mode, label: definition.label, trial, requestedDurationMs: durationMs,
    actualDurationMs, actualWallDurationMs, durationDriftMs, wallDriftMs, timingToleranceMs: allowedTimingMs,
    readinessSkewMs, readinessDelaysMs, readinessToleranceMs, serverHealth,
    valid, issues, scoreSource: 'last_agent_observed_not_tournament',
    officialTournamentScore: null, teamObservedScore,
    bubbleObservedScore: agents.bubble?.score ?? null,
    milkteaObservedScore: definition.llm ? agents.milktea?.score ?? null : null,
    totalDeliveredParcels: sum('deliveredParcels'), deliveryActions: sum('deliveryActions'),
    pickups: sum('pickups'), llmCalls: sum('llmCalls'), toolCalls: sum('toolCalls'),
    successfulTools: sum('successfulTools'), failedGameActions: sum('failedGameActions'),
    uncertainOutcomes: sum('uncertainOutcomes'),
    navigationFailures: count('navigation_failed'), navigationRecoveries: count('navigation_recovered'),
    navigationWaits: count('navigation_wait'),
    bdiTeammateCongestionFailures: agents.bubble?.teammateCongestionFailures ?? 0,
    bdiNpcCongestionFailures: agents.bubble?.npcCongestionFailures ?? 0,
    llmDeliveryEvacuationAttempts: agents.milktea?.counts?.llm_delivery_evacuate_selected ?? 0,
    llmDeliveryEvacuationSuccesses: agents.milktea?.evacuationStatusCounts?.vacated ?? 0,
    llmDeliveryEvacuationBlocked: agents.milktea?.evacuationStatusCounts?.blocked ?? 0,
    llmDeliveryEvacuationNoTarget: agents.milktea?.evacuationStatusCounts?.no_safe_target ?? 0,
    llmDeliveryEvacuationUnknown: agents.milktea?.evacuationStatusCounts?.uncertain ?? 0,
    llmDeliveryTileDwellMeanMs: agents.milktea?.deliveryTileDwell?.mean ?? null,
    llmDeliveryTileDwellCensored: agents.milktea?.deliveryTileDwell?.censored ?? 0,
    coordinationSent: count('coordination_sent'), coordinationReceived: count('coordination_received'),
    beliefMerges: count('coordination_belief_merged'), arbitrationYields: count('coordination_yield'),
    llmCompletedObjectives: agents.milktea?.completedObjectives ?? 0,
    llmAutoVerified: agents.milktea?.counts?.llm_objective_auto_verified ?? 0,
    llmEpisodes: agents.milktea?.counts?.llm_benchmark_episode_started ?? 0,
    llmModelLatencyMeanMs: agents.milktea?.timing?.llm_model_result?.mean ?? null,
    llmModelLatencyP95Ms: agents.milktea?.timing?.llm_model_result?.p95 ?? null,
    llmToolLatencyMeanMs: agents.milktea?.timing?.llm_tool_result?.mean ?? null,
    llmToolTimeouts: agents.milktea?.unknownOutcomeOrigins?.tool_registry_deadline ?? 0,
    sdkUnknownActions: names.reduce((total,name)=>total+Number(agents[name]?.counts?.sdk_action_phase_unknown??0),0),
    llmFinalStatus: agents.milktea?.llmFinalStatus ?? null,
    llmDeliveryEvacuationEnabled: agents.milktea?.deliveryEvacuationEnabled ?? null,
    gameTitleObserved: agents.milktea?.observedGameTitle ?? agents.bubble?.observedGameTitle ?? null,
    agents, exits };
}

export const CSV_FIELDS = ['mode', 'label', 'trial', 'valid', 'issues', 'requestedDurationMs',
  'actualDurationMs', 'actualWallDurationMs', 'durationDriftMs', 'wallDriftMs', 'readinessSkewMs', 'teamObservedScore', 'bubbleObservedScore', 'milkteaObservedScore',
  'totalDeliveredParcels', 'deliveryActions', 'pickups', 'llmCalls', 'toolCalls',
  'successfulTools', 'failedGameActions', 'uncertainOutcomes', 'navigationFailures',
  'navigationRecoveries', 'navigationWaits', 'bdiTeammateCongestionFailures', 'bdiNpcCongestionFailures',
  'llmDeliveryEvacuationAttempts', 'llmDeliveryEvacuationSuccesses', 'llmDeliveryEvacuationBlocked',
  'llmDeliveryEvacuationNoTarget', 'llmDeliveryEvacuationUnknown', 'llmDeliveryTileDwellMeanMs',
  'llmDeliveryTileDwellCensored', 'llmDeliveryEvacuationEnabled', 'coordinationSent', 'coordinationReceived',
  'beliefMerges', 'arbitrationYields', 'llmCompletedObjectives', 'llmAutoVerified',
  'llmEpisodes', 'llmFinalStatus', 'llmModelLatencyMeanMs', 'llmModelLatencyP95Ms', 'llmToolLatencyMeanMs', 'llmToolTimeouts', 'scoreSource'];

/** @param {any[]} rounds */
export function asCsv(rounds) {
  const cell = (/** @type {unknown} */ raw) => {
    const value = Array.isArray(raw) ? raw.join(';') : raw === null || raw === undefined ? '' : String(raw);
    return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  };
  return [CSV_FIELDS.join(','), ...rounds.map(round => CSV_FIELDS.map(field => cell(round[field])).join(','))].join('\n') + '\n';
}

/** @param {any[]} rounds */
export function aggregateRounds(rounds) {
  return Object.entries(MODES).map(([mode,cfg])=>{
    const all=rounds.filter(r=>r.mode===mode);
    const valid=all.filter(r=>r.valid&&Number.isFinite(r.teamObservedScore));
    const scores=describeSamples(valid.map(r=>r.teamObservedScore));
    /** @param {string} field */ const metric=(field)=>describeSamples(valid.map(r=>r[field]).filter(Number.isFinite));
    /** @type {Record<string,number>} */ const issues={};
    for (const row of all) for (const issue of row.issues??[]) issues[issue]=(issues[issue]??0)+1;
    return { mode,label:cfg.label,trials:all.length,validTrials:valid.length,invalidTrials:all.length-valid.length,
      meanObservedScore:scores.mean,medianObservedScore:scores.median,sampleStdevObservedScore:scores.sampleStdev,
      scoreCi95:scores.ci95,scoreMin:valid.length?Math.min(...valid.map(r=>r.teamObservedScore)):null,
      scoreMax:valid.length?Math.max(...valid.map(r=>r.teamObservedScore)):null,
      meanDeliveries:metric('totalDeliveredParcels').mean,meanLlmCalls:metric('llmCalls').mean,
      meanLlmModelLatencyMs:metric('llmModelLatencyMeanMs').mean,
      meanBdiTeammateCongestionFailures:metric('bdiTeammateCongestionFailures').mean,
      meanLlmDeliveryEvacuationSuccesses:metric('llmDeliveryEvacuationSuccesses').mean,
      meanLlmDeliveryTileDwellMs:metric('llmDeliveryTileDwellMeanMs').mean,
      completionRate:all.length?valid.length/all.length:null,issues,scoreSource:'last_agent_observed_not_tournament' };
  }).filter(r=>r.trials);
}

/** Retrospective audit of Stage 3A manifests; does NOT edit or silently rewrite original data.
 * @param {any} row */
export function auditHistoricalRound(row) {
  if (!Number.isFinite(row.requestedDurationMs) || !Number.isFinite(row.actualDurationMs)) return { ...row, historicalAudit:'missing_duration' };
  const tol=timingToleranceMs(row.requestedDurationMs);
  const drift=row.actualDurationMs-row.requestedDurationMs;
  if (Math.abs(drift)<=tol) return { ...row, historicalAudit:'duration_ok' };
  return { ...row,valid:false,issues:[...new Set([...(row.issues??[]),'duration_out_of_tolerance'])],
    durationDriftMs:drift,historicalAudit:'duration_out_of_tolerance' };
}
