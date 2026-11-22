/**
 * Run repeated, independently verified delivery objectives for an entire
 * benchmark window. Normal, one-off LLM objectives remain unchanged.
 *
 * Never retry a potentially ambiguous SDK action: if an objective stops with
 * uncertain_tool_outcome, end the session and surface the failure.
 */

/** @param {AbortSignal|undefined} signal @param {number} ms */
export function abortablePause(signal, ms) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(undefined); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * @param {{
 *   runObjective:(objective:string,options?:{signal?:AbortSignal})=>Promise<any>,
 *   objective?:string, signal?:AbortSignal, deadlineMs:number,
 *   pauseMs?:number, now?:()=>number, pause?:(signal:AbortSignal|undefined,ms:number)=>Promise<void>,
 *   log?:(event:string,details:object)=>void,
 *   readScore?:()=>number|null
 * }} options
 */
export async function runContinuousBenchmark({ runObjective, objective = 'Deliver 3 parcels', signal,
  deadlineMs, pauseMs = 1200, now = Date.now, pause = abortablePause, log = () => {}, readScore = () => null }) {
  if (!Number.isFinite(deadlineMs)) throw new Error('Benchmark requires a finite deadline');
  if (!Number.isFinite(pauseMs) || pauseMs < 0) throw new Error('Invalid benchmark pause');
  const metrics = { llmCalls: 0, toolCalls: 0, successfulTools: 0, invalidTools: 0,
    invalidToolCalls: 0, preconditionRejections: 0, failedGameActions: 0, uncertainOutcomes: 0, replans: 0 };
  /** @type {{status:string,episodes:number,completedEpisodes:number,deliveredCount:number,deliveryActions:number,metrics:typeof metrics,currentScore:number|null,lastStatus:string|null,lastReason:string|null}} */
  const summary = { status: 'deadline_reached', episodes: 0, completedEpisodes: 0,
    deliveredCount: 0, deliveryActions: 0, metrics, currentScore: null, lastStatus: null, lastReason: null };
  const publish = () => {
    summary.currentScore = readScore();
    log('llm_benchmark_session_result', summary);
    return summary;
  };
  while (now() < deadlineMs && !signal?.aborted) {
    summary.episodes++;
    log('llm_benchmark_episode_started', { episode: summary.episodes, objective });
    let result;
    try { result = await runObjective(objective, { signal }); }
    catch (error) {
      summary.status = signal?.aborted ? 'interrupted' : 'error';
      summary.lastReason = error instanceof Error ? error.message : String(error);
      return publish();
    }
    summary.lastStatus = result.status;
    summary.lastReason = result.reason;
    summary.deliveredCount += result.progress?.deliveredCount ?? 0;
    summary.deliveryActions += result.progress?.deliveryActions ?? 0;
    for (const key of /** @type {(keyof typeof metrics)[]} */ (Object.keys(metrics))) {
      metrics[key] += Number(result.metrics?.[key] ?? 0);
    }
    if (result.status === 'completed') summary.completedEpisodes++;
    log('llm_benchmark_episode_result', { episode: summary.episodes, status: result.status,
      reason: result.reason, deliveries: result.progress?.deliveredCount ?? 0,
      score: result.progress?.currentScore ?? null });
    if (result.status === 'error') {
      summary.status = 'error';
      return publish();
    }
    if (result.reason === 'uncertain_tool_outcome' || Number(result.metrics?.uncertainOutcomes ?? 0) > 0) {
      summary.status = 'blocked_uncertain_outcome';
      return publish();
    }
    if (result.status === 'blocked' && result.reason === 'unsupported_local_completion_criterion') {
      summary.status = 'blocked_unsupported_objective';
      return publish();
    }
    if (signal?.aborted) { summary.status = 'interrupted'; break; }
    if (now() >= deadlineMs) break;
    // Pausing between episodes also prevents a malformed or empty model response
    // from creating a busy-spin (and lets fresh parcels appear).
    await pause(signal, Math.min(pauseMs, Math.max(0, deadlineMs - now())));
  }
  if (signal?.aborted) summary.status = 'interrupted';
  return publish();
}
