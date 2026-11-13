/**
 * Stage 3A game-run orchestration. One FRESH Deliveroo.js server is started
 * for each trial, then agents share a common wall-clock round deadline.
 * This is a LOCAL benchmark, not the course Tournament evaluation API.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect as tcpConnect } from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { MODES, readAgentLog, buildTrialSummary, aggregateRounds, asCsv, timingToleranceMs, compareModes } from './results.js';
import { scheduleAblation, analyzeAblation, asAblationCsv, ablationMarkdown, ablationScoreSvg, validateAblationTrial } from './ablation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @param {string} value @param {string} name @param {number} [min] @param {number} [max] */
const positiveInt = (value, name, min = 1, max = 1000000) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
};

export const HELP = `Usage: npm run benchmark -- --server-dir /path/to/Deliveroo.js [options]

Required:
  --server-dir PATH       Official Deliveroo.js checkout (npm start runs here)

Options:
  --modes A,B,C           A=BDI alone; B=independent; C=cooperating [A,B,C]
  --runs N                Trials PER mode [5]
  --duration N            Round length in seconds [180]
  --game NAME             GAME_NAME for server [oval_counterclockwise]
  --mover astar|pddl      BDI and LLM path planner [astar]
  --host URL              Game server URL [http://localhost:8080]
  --output PATH           New result folder [benchmark-results/<timestamp>]
  --startup-timeout N     Maximum seconds to wait for server [45]
  --timing-tolerance-ms N Max allowed round-duration drift [max(2000,2%)]
  --readiness-tolerance-ms N Maximum two-agent ready-time skew [15000]
  --help                  Display help

Examples:
  npm run benchmark -- --server-dir ~/src/Deliveroo.js --runs 1 --duration 30
  npm run benchmark -- --server-dir ~/src/Deliveroo.js --runs 5 --duration 180

Requirements: game server already installed; Ollama running; bubble/milktea
credentials in private .env. Benchmark refuses to reuse a running server.
Outputs are agent-observed log metrics, NOT official Tournament scores.
`;

/** @param {string[]} argv @param {string} [cwd] */
export function parseBenchmarkArgs(argv, cwd = process.cwd()) {
  const opts = { modes: /** @type {string[]} */ (['A', 'B', 'C']), runs: 5,
    durationSec: 180, game: 'oval_counterclockwise', mover: 'astar',
    host: 'http://localhost:8080', serverDir: '',
    output: resolve(cwd, 'benchmark-results', new Date().toISOString().replace(/[:.]/g, '-')),
    startupTimeoutSec: 45, timingToleranceMs: /** @type {number|null} */ (null), readinessToleranceMs: 15000 };
  /** @type {Record<string,string>} */
  const map = { '--modes': 'modes', '--runs': 'runs', '--duration': 'durationSec',
    '--game': 'game', '--mover': 'mover', '--host': 'host', '--server-dir': 'serverDir',
    '--output': 'output', '--startup-timeout': 'startupTimeoutSec',
    '--timing-tolerance-ms': 'timingToleranceMs', '--readiness-tolerance-ms': 'readinessToleranceMs' };
  if (argv.includes('--help') || argv.includes('-h')) return { ...opts, help: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!Object.hasOwn(map, flag)) throw new Error(`Unknown option ${flag}; use --help`);
    const raw = argv[++i];
    if (!raw || raw.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    const field = map[flag];
    if (field === 'modes') opts.modes = raw.split(',').map(s => s.trim().toUpperCase());
    else if (field === 'runs') opts.runs = positiveInt(raw, flag, 1, 100);
    else if (field === 'durationSec') opts.durationSec = positiveInt(raw, flag, 5, 7200);
    else if (field === 'startupTimeoutSec') opts.startupTimeoutSec = positiveInt(raw, flag, 1, 300);
    else if (field === 'timingToleranceMs') opts.timingToleranceMs = positiveInt(raw, flag, 1, 60_000);
    else if (field === 'readinessToleranceMs') opts.readinessToleranceMs = positiveInt(raw, flag, 1, 120_000);
    else if (field === 'serverDir') opts.serverDir = resolve(cwd, raw);
    else if (field === 'output') opts.output = resolve(cwd, raw);
    else if (field === 'host') opts.host = raw;
    else if (field === 'mover') opts.mover = raw;
    else if (field === 'game') opts.game = raw;
  }
  if (!opts.serverDir) throw new Error('--server-dir is required: fresh server restart per trial is necessary');
  if (!opts.modes.length || new Set(opts.modes).size !== opts.modes.length || !opts.modes.every(x => x in MODES)) {
    throw new Error('--modes must contain unique values from A,B,C');
  }
  if (!['astar', 'pddl'].includes(opts.mover)) throw new Error('--mover must be astar or pddl');
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.game)) throw new Error('Game name contains unsupported characters');
  let url;
  try { url = new URL(opts.host); }
  catch { throw new Error('--host must be a valid HTTP URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search) {
    throw new Error('--host must be an HTTP(S) base URL without credentials, path or query');
  }
  return opts;
}

/** Rotating the order across repetitions reduces deterministic order effects.
 * @param {string[]} modes @param {number} runs */
export function scheduleRounds(modes, runs) {
  const rounds = [];
  for (let trial = 1; trial <= runs; trial++) {
    for (let index = 0; index < modes.length; index++) {
      const mode = modes[(index + trial - 1) % modes.length];
      rounds.push({ mode, trial, ordinal: rounds.length + 1 });
    }
  }
  return rounds;
}

/** @param {string} host @param {number} [timeoutMs] */
export async function isPortOpen(host, timeoutMs = 500) {
  const url = new URL(host);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise(resolve => {
    const socket = tcpConnect({ host: url.hostname, port });
    let done = false;
    const finish = (/** @type {boolean} */ open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** @param {string} host @param {number} timeoutMs @param {()=>boolean} [exited] */
export async function waitForServer(host, timeoutMs, exited = () => false) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited()) throw new Error('Game server process exited before its TCP port opened');
    if (await isPortOpen(host)) return;
    await wait(250);
  }
  throw new Error(`Game server did not open ${host} within ${timeoutMs} ms`);
}

/** @param {string} host @param {number} timeoutMs */
async function waitForClosed(host, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!await isPortOpen(host)) return true;
    await wait(100);
  }
  return !await isPortOpen(host);
}

/**
 * Spawn isolated OS process groups so npm start children also stop. This is
 * intended for macOS/Linux, matching the project's course environment.
 * @param {string} command @param {string[]} args @param {{cwd:string,env:NodeJS.ProcessEnv,logFile:string,stdin?:boolean}} options
 */
export function startProcess(command, args, { cwd, env, logFile, stdin = false }) {
  const stream = createWriteStream(logFile, { flags: 'w' });
  const child = spawn(command, args, { cwd, env, detached: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const state = { startedAt:Date.now(), pid: child.pid ?? null, exited: false, exitCode: /** @type {number|null} */ (null),
    exitSignal: /** @type {NodeJS.Signals|null} */ (null), endedAt: /** @type {number|null} */ (null),
    error: /** @type {string|null} */ (null) };
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });
  child.on('error', error => { state.error = error.message; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    state.endedAt = Date.now();
    stream.end();
    resolve(undefined);
  }));
  return { child, state, exited };
}

/** @param {ReturnType<typeof startProcess>|undefined} processRef @param {number} [graceMs] */
export async function stopProcess(processRef, graceMs = 2000) {
  if (!processRef) return;
  const { child, state, exited } = processRef;
  const killGroup = (/** @type {NodeJS.Signals} */ signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') {
      try { child.kill(signal); } catch { /* process already exited */ }
    } }
  };
  killGroup('SIGTERM');
  if (!state.exited) {
    await Promise.race([exited, wait(graceMs)]);
    if (!state.exited) killGroup('SIGKILL');
    await Promise.race([exited, wait(1500)]);
  }
  // Group leader may have exited but left a grandchild behind.
  killGroup('SIGKILL');
}

/** @param {number} ms @param {AbortSignal} signal */
async function waitWindow(ms, signal) {
  if (signal.aborted) return false;
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    function onAbort() { clearTimeout(timer); resolve(false); }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Git metadata only; never read a full config, credentials or environment dump. */
/** @param {string} cwd */
function gitRevision(cwd) {
  try { return execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8',timeout:2500,stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return null; }
}

/** Monitor TCP reachability plus driver timer lag. TCP check is NOT a game-protocol heartbeat. */
/** @param {string} host @param {number} [intervalMs] */
export function monitorServer(host, intervalMs = 5000) {
  const summary={probes:0,failures:0,maxProbeLatencyMs:0,meanProbeLatencyMs:0,maxTimerLagMs:0};
  const inFlight = new Set();
  let stopped=false;
  let expected=Date.now()+intervalMs;
  const timer=setInterval(()=>{
    if(stopped)return;
    const current=Date.now();
    summary.maxTimerLagMs=Math.max(summary.maxTimerLagMs,Math.max(0,current-expected));
    expected=current+intervalMs;
    const started=performance.now();
    const probe=isPortOpen(host,500).then(ok=>{
      const latency=performance.now()-started;
      summary.probes++;
      if(!ok)summary.failures++;
      summary.maxProbeLatencyMs=Math.max(summary.maxProbeLatencyMs,latency);
      summary.meanProbeLatencyMs+=latency;
    });
    inFlight.add(probe); void probe.finally(()=>inFlight.delete(probe));
  },intervalMs);
  timer.unref();
  return {stop:async()=>{
    stopped=true;clearInterval(timer);
    await Promise.allSettled([...inFlight]);
    if(summary.probes)summary.meanProbeLatencyMs/=summary.probes;
    return summary;
  }};
}

/** Read ONLY an allowlisted, non-secret model identifier from the private .env;
 * never store or echo the file itself. The runner does not require dotenv. */
async function safeModelName() {
  const direct = process.env.OLLAMA_MODEL;
  let value = direct;
  if (!value) {
    try {
      const raw = await readFile(join(REPO_ROOT,'.env'),'utf8');
      const entry=raw.split(/\r?\n/).find(line => /^\s*OLLAMA_MODEL\s*=/.test(line));
      value=entry?.split('=',2)[1]?.trim().replace(/^['"]|['"]$/g,'');
    } catch { /* optional local .env */ }
  }
  return value && /^[\w.:/\-]{1,128}$/.test(value) ? value : 'unknown_from_private_environment';
}

/** @param {ReturnType<typeof parseBenchmarkArgs> & {ablation?:{schedulingSeed:number}}} opts @param {AbortSignal} signal */
export async function runBenchmarks(opts, signal) {
  if (process.platform === 'win32') throw new Error('Stage 3A process-group cleanup requires macOS or Linux');
  await access(join(opts.serverDir, 'package.json'));
  await access(join(REPO_ROOT, 'src', 'index.js'));
  if (await isPortOpen(opts.host)) throw new Error(`Port already occupied at ${opts.host}. Stop the existing game server; this benchmark must start a fresh instance per trial.`);
  await mkdir(opts.output, { recursive: true });
  /** @type {Array<{mode:string,trial:number,ordinal:number,block?:number,condition?:string,evacuationEnabled?:boolean}>} */
  const schedule = opts.ablation ? scheduleAblation(opts.runs, opts.ablation.schedulingSeed) : scheduleRounds(opts.modes, opts.runs);
  const toleranceMs = opts.timingToleranceMs ?? timingToleranceMs(opts.durationSec*1000);
  const modelName = await safeModelName();
  const safeConfig = { modes: opts.modes, runs: opts.runs, durationSec: opts.durationSec,
    game: opts.game, mover: opts.mover, host: opts.host, startupTimeoutSec: opts.startupTimeoutSec,
    gameRestartsPerRound: true, randomSeedControlled: false,
    randomSeedStatus: 'unverified_no_seed_injected',
    ...(opts.ablation ? {ablationDesign: 'balanced_randomized_order', ablationSchedulingSeed: opts.ablation.schedulingSeed} : {}),
    timingToleranceMs: toleranceMs, readinessToleranceMs: opts.readinessToleranceMs,
    llmMode:'json', llmModel: modelName,
    deliveryEvacuation: 'see_llmDeliveryEvacuationEnabled_per_round',
    runtime: {node:process.version, platform:process.platform, arch:process.arch},
    revision: {agent:gitRevision(REPO_ROOT),server:gitRevision(opts.serverDir)},
    scoreSource: 'last_agent_observed_not_tournament' };
  /** @type {any[]} */ const rounds = [];
  /** @type {any} */
  const manifest = { stage: opts.ablation ? '3C.3' : '3C.2', startedAt: new Date().toISOString(), config: safeConfig, schedule, rounds };
  const persist = async () => {
    await writeFile(join(opts.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(opts.output, 'rounds.csv'), asCsv(rounds));
    await writeFile(join(opts.output, 'aggregate.json'), JSON.stringify(aggregateRounds(rounds), null, 2) + '\n');
    await writeFile(join(opts.output, 'comparisons.json'), JSON.stringify([compareModes(rounds,'B','C'), compareModes(rounds,'A','C')],null,2)+'\n');
    if (opts.ablation) {
      const analysis = analyzeAblation(rounds);
      await writeFile(join(opts.output, 'ablation-results.csv'), asAblationCsv(rounds));
      await writeFile(join(opts.output, 'comparison.json'), JSON.stringify(analysis,null,2)+'\n');
      await writeFile(join(opts.output, 'report.md'), ablationMarkdown(analysis, manifest));
      await writeFile(join(opts.output, 'score-distribution.svg'), ablationScoreSvg(rounds));
    }
  };
  await persist();
  for (const { mode, trial, ordinal, ...ablationRound } of schedule) {
    if (signal.aborted) break;
    const config = MODES[/** @type {keyof typeof MODES} */ (mode)];
    const dirname = opts.ablation
      ? `${String(ordinal).padStart(2, '0')}_${ablationRound.condition}_trial${trial}`
      : `${String(ordinal).padStart(2, '0')}_${mode}_trial${trial}`;
    const roundDir = join(opts.output, dirname);
    await mkdir(roundDir, { recursive: true });
    const record = { mode, trial, ordinal, ...(opts.ablation ? ablationRound : {}), startedAt: new Date().toISOString(),
      durationMs: opts.durationSec * 1000, completedWindow: false,
      error: /** @type {string|null} */ (null) };
    console.log(`[${ordinal}/${schedule.length}] ${opts.ablation ? ablationRound.condition : mode} (${config.label}), trial ${trial}: fresh server, ${opts.durationSec}s`);
    /** @type {ReturnType<typeof startProcess>|undefined} */ let server;
    /** @type {Record<string, ReturnType<typeof startProcess>>} */ const agents = {};
    let startedAt = Date.now();
    let deadlineAt = startedAt;
    let serverStopped = false;
    let serverFailure = false;
    /** @type {ReturnType<typeof monitorServer>|undefined} */ let healthMonitor;
    let startedMono = process.hrtime.bigint();
    try {
      if (await isPortOpen(opts.host)) throw new Error('Game server still listening before new trial');
      const activeServer = startProcess('npm', ['start'], { cwd: opts.serverDir,
        env: { ...process.env, GAME_NAME: opts.game }, logFile: join(roundDir, 'server.log') });
      server = activeServer;
      await waitForServer(opts.host, opts.startupTimeoutSec * 1000, () => activeServer.state.exited);
      if (signal.aborted) throw new Error('Benchmark interrupted during server startup');
      const names = config.llm ? ['bubble', 'milktea'] : ['bubble'];
      startedAt = Date.now();
      startedMono = process.hrtime.bigint();
      deadlineAt = startedAt + opts.durationSec * 1000;
      healthMonitor = monitorServer(opts.host);
      for (const name of names) {
        const isLlm = name === 'milktea';
        agents[name] = startProcess(process.execPath, [join(REPO_ROOT, 'src', isLlm ? 'llm-agent.js' : 'index.js'),
          ...(isLlm ? ['--objective', 'Deliver 3 parcels'] : [])], {
          cwd: REPO_ROOT, logFile: join(roundDir, `${name}.log`),
          env: { ...process.env, HOST: opts.host, AGENT: name, MOVER: opts.mover,
            COORDINATION_ENABLED: String(config.coordination), BENCHMARK_CONTINUOUS: 'true',
            BENCHMARK_DEADLINE_MS: String(deadlineAt),
            ...(isLlm ? { LLM_MODE: 'json', ...(opts.ablation ? { LLM_DELIVERY_EVACUATION: String(ablationRound.evacuationEnabled) } : {}) } : {}) },
        });
      }
      record.completedWindow = await waitWindow(opts.durationSec * 1000, signal);
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      serverFailure = true;
      console.error('  Trial setup failed:', record.error);
    } finally {
      const stoppedAt = Date.now();
      const actualDurationMs = Number(process.hrtime.bigint()-startedMono)/1e6;
      const serverHealth = await healthMonitor?.stop() ?? null;
      // Grace period allows in-flight model/tool calls to observe cancellation.
      for (const name of Object.keys(agents)) await stopProcess(agents[name]);
      await stopProcess(server);
      serverStopped = await waitForClosed(opts.host, 5000);
      // Count only in-round game events; post-deadline shutdown events
      // must not inflate scores or delivery counts.
      const cutoffMs = record.completedWindow ? deadlineAt : stoppedAt;
      /** @type {Record<string,any>} */ const parsed = {};
      /** @type {Record<string,any>} */ const exits = {};
      for (const [name, proc] of Object.entries(agents)) {
        parsed[name] = await readAgentLog(join(roundDir, `${name}.log`), { name, cutoffMs });
        exits[name] = { ...proc.state, earlyExit: proc.state.endedAt !== null && proc.state.endedAt < deadlineAt - 1500 };
      }
      const summary = buildTrialSummary({ mode, trial,
        durationMs: opts.durationSec * 1000, actualDurationMs, actualWallDurationMs: Math.max(0, stoppedAt-startedAt),
        agents: parsed, exits, serverStopped, completedWindow: record.completedWindow && !serverFailure,
        timingToleranceMs: toleranceMs, readinessToleranceMs: opts.readinessToleranceMs,
        roundStartedAt:startedAt, agentStartTimes:Object.fromEntries(Object.entries(agents).map(([name,proc])=>[name,proc.state.startedAt])),
        serverHealth });
      if (opts.ablation) validateAblationTrial(summary, ablationRound, opts.ablation.schedulingSeed);
      // An unexpectedly terminated game process invalidates all observations
      // even if the TCP port was later shut down successfully.
      if (server?.state.endedAt !== null && server?.state.endedAt !== undefined && server.state.endedAt < deadlineAt - 1500) {
        summary.issues.push('server_early_exit');
        summary.valid = false;
      }
      if (record.error) summary.issues.push(`setup_error:${record.error}`);
      if (record.error) summary.valid = false;
      await writeFile(join(roundDir, 'result.json'), JSON.stringify({ ...record, serverStopped, summary }, null, 2) + '\n');
      rounds.push(summary);
      await persist();
      console.log(`  valid=${summary.valid} score=${summary.teamObservedScore ?? 'NA'} (agent-observed, NOT tournament) deliveries=${summary.totalDeliveredParcels} issues=${summary.issues.join(';') || 'none'}`);
      if (!serverStopped) throw new Error('Game server port remained open after cleanup; stop it manually before further trials');
    }
    if (serverFailure) break;
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.interrupted = signal.aborted;
  await persist();
  return { output: opts.output, rounds, interrupted: signal.aborted, aggregate: aggregateRounds(rounds), comparison:compareModes(rounds,'B','C') };
}
