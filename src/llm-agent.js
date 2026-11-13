/** Stage 2B: second independent Deliveroo.js actor controlled by Qwen. */
import 'dotenv/config';
import { connect } from './client.js';
import { Beliefs } from './beliefs/index.js';
import { config } from './config.js';
import { logEvent } from './metrics/log.js';
import { OllamaProvider } from './llm/providers/ollama.js';
import { OpenAiCompatibleProvider } from './llm/providers/openai-compatible.js';
import { McpHttpClient } from './course/mcp-http.js';
import { attachMcpCatalog } from './course/catalog.js';
import { ObjectiveInbox, parseObjectiveLine } from './course/objective-inbox.js';
import { createInterface } from 'node:readline';
import { createGameRuntime, waitForGameReady } from './llm/game/runtime.js';
import { CoordinationController } from './coordination/controller.js';
import { runContinuousBenchmark } from './benchmark/continuous.js';

const agent = (process.env.AGENT || 'milktea').toLowerCase();
if (agent !== 'milktea') throw new Error('Stage 2B uses the separate milktea identity. Set AGENT=milktea; never reuse bubble credentials.');
const llmProviderName = (process.env.LLM_PROVIDER ?? 'ollama').toLowerCase();
if (!['ollama', 'openai_compatible'].includes(llmProviderName)) throw new Error('LLM_PROVIDER must be ollama or openai_compatible');
const objectiveArgIndex = process.argv.indexOf('--objective');
const objective = (objectiveArgIndex >= 0 ? process.argv[objectiveArgIndex + 1] : process.env.LLM_OBJECTIVE)
  || 'Collect and deliver at least one parcel.';
/** @param {string} name @param {number} fallback */
const integerEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const client = connect({ host: config.host, name: 'milktea', token: process.env.TOKEN_MILKTEA || undefined });
const beliefs = new Beliefs({ agentTtlMs: config.agentTtlMs, blockedTtlMs: config.blockedTtlMs, maxBlockedMs: config.maxBlockedMs });
beliefs.listen(client);
const log = (/** @type {string} */ name, /** @type {object} */ details) => logEvent(name, { agent: 'milktea', ...details });
// Record scores as they arrive, including in an incomplete final objective.
/** @type {number|null} */ let lastObservedScore = null;
client.onYou(me => {
  if (typeof me.score === 'number' && me.score !== lastObservedScore) {
    log('score_observed', { score: me.score });
    lastObservedScore = me.score;
  }
});
const coordination = process.env.COORDINATION_ENABLED === 'true' ? new CoordinationController({
  client, beliefs, selfName: 'milktea', peerName: 'bubble', log,
}) : null;
coordination?.start();
const provider = llmProviderName === 'ollama' ? new OllamaProvider({
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL || 'qwen3.5:4b-q4_K_M',
  timeoutMs: integerEnv('LLM_TIMEOUT_MS', 120_000), think: process.env.OLLAMA_THINK === 'true',
}) : new OpenAiCompatibleProvider({
  baseUrl: process.env.COURSE_LLM_BASE_URL || '', apiKey: process.env.COURSE_LLM_TOKEN || '',
  model: process.env.COURSE_LLM_MODEL || '', timeoutMs: integerEnv('LLM_TIMEOUT_MS', 120_000),
});
const requestedMode = process.env.LLM_MODE || 'native';
if (!['native', 'json'].includes(requestedMode)) throw new Error('LLM_MODE must be native or json');
if (llmProviderName === 'openai_compatible' && requestedMode !== 'json') throw new Error('OpenAI-compatible adapter requires LLM_MODE=json');
/** @type {'native'|'json'} */
const mode = requestedMode === 'json' ? 'json' : 'native';
// Change only cooperative C by default; B remains an unchanged independent control.
// Explicit LLM_DELIVERY_EVACUATION=true/false overrides this for ablation trials.
const deliveryEvacuationSetting = process.env.LLM_DELIVERY_EVACUATION ?? (coordination ? 'true' : 'false');
if (!['true', 'false'].includes(deliveryEvacuationSetting)) throw new Error('LLM_DELIVERY_EVACUATION must be true or false');
const deliveryEvacuation = deliveryEvacuationSetting === 'true';
const runtime = createGameRuntime({ beliefs, client, provider, mode,
  mover: process.env.MOVER === 'pddl' ? 'pddl' : 'astar',
  maxSteps: integerEnv('LLM_MAX_STEPS', 18), maxToolCalls: integerEnv('LLM_MAX_TOOL_CALLS', 20),
  toolTimeoutMs: integerEnv('LLM_TOOL_TIMEOUT_MS', 60_000),
  actionTimeoutMs: config.actionTimeoutMs, maxMoveRetries: config.maxMoveRetries,
  pddlTimeoutMs: config.pddlTimeoutMs, congestionTimeoutMs: config.congestionTimeoutMs,
  congestionRetryMs: config.congestionRetryMs, coordination, deliveryEvacuation, log });
let stopping = false;
const abort = new AbortController();
const stop = () => { stopping = true; abort.abort(); runtime.stop(); coordination?.stop(); client.socket.disconnect?.(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
client.socket.on('disconnect', (/** @type {string} */ reason) => {
  log('disconnected', { reason }); if (!stopping) abort.abort();
});
client.socket.on('token', (/** @type {string} */ token) => {
  log('token_issued', { tokenReceived: !!token, note: 'Create/save TOKEN_MILKTEA locally; the JWT is deliberately never logged' });
});
log('llm_game_startup', { host: config.host, agent: 'milktea', mode, llmProvider: llmProviderName, mover: process.env.MOVER === 'pddl' ? 'pddl' : 'astar', objective, deliveryEvacuation });
try {
  await waitForGameReady(beliefs, { timeoutMs: integerEnv('GAME_READY_TIMEOUT_MS', 20_000), signal: abort.signal });
  log('llm_game_ready', { x: beliefs.me?.x, y: beliefs.me?.y, score: beliefs.me?.score, level: beliefs.config?.GAME.title });
  // Optional course-adapter boundary. The published slides have NOT provided
  // the tool-server URL, schemas or authentication contract. A configured MCP
  // server must pass discovery + allowlist checks before any remote tool is used.
  if (process.env.COURSE_MCP_URL) {
    const rawAllowlist = process.env.COURSE_TOOL_ALLOWLIST || '';
    const allowlist = rawAllowlist.split(',').map(x => x.trim()).filter(Boolean);
    const catalog = new McpHttpClient({ url: process.env.COURSE_MCP_URL,
      token: process.env.COURSE_MCP_TOKEN || '', timeoutMs: integerEnv('COURSE_MCP_TIMEOUT_MS', 15_000) });
    await attachMcpCatalog({ registry: runtime.tools, client: catalog, allowlist, log, signal: abort.signal });
  }
  const objectiveSource = process.env.LLM_OBJECTIVE_SOURCE || 'cli';
  if (!['cli', 'stdin'].includes(objectiveSource)) throw new Error('LLM_OBJECTIVE_SOURCE must be cli or stdin');
  if (objectiveSource === 'stdin') {
    if (process.env.BENCHMARK_CONTINUOUS === 'true') throw new Error('stdin objective source cannot be used in benchmark mode');
    const inbox = new ObjectiveInbox({
      runObjective: (goal, options) => runtime.runObjective(goal, options),
      stopCurrent: () => runtime.stop(),
      isActionBusy: () => runtime.gate.busy || runtime.tools.activeCalls > 0 || runtime.tools.hasUncertainOutcome,
      log,
    });
    log('course_objective_channel_ready', { source: 'stdin_ndjson', officialTransportVerified: false });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (abort.signal.aborted) break;
      if (!line.trim()) continue;
      try { inbox.submit(parseObjectiveLine(line)); }
      catch (error) { log('course_objective_rejected', { reason: error instanceof Error ? error.message : String(error) }); }
    }
    await inbox.drain();
  } else if (process.env.BENCHMARK_CONTINUOUS === 'true') {

    const deadlineMs = Number(process.env.BENCHMARK_DEADLINE_MS);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
      throw new Error('BENCHMARK_CONTINUOUS requires a future BENCHMARK_DEADLINE_MS');
    }
    const summary = await runContinuousBenchmark({
      runObjective: (goal, options) => runtime.runObjective(goal, options),
      objective, signal: abort.signal, deadlineMs, log,
      readScore: () => beliefs.me?.score ?? null,
    });
    console.log('Stage 3 benchmark LLM session:', JSON.stringify(summary, null, 2));
    if (summary.status.startsWith('blocked') || summary.status === 'error') process.exitCode = 1;
  } else {
    const result = await runtime.runObjective(objective, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(integerEnv('LLM_MAX_RUN_MS', 180_000))]),
    });
    console.log('Stage 2B result:', JSON.stringify(result, null, 2));
    if (result.status !== 'completed') process.exitCode = 1;
  }
} catch (error) {
  console.error('Stage 2B failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  stop();
}
