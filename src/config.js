import 'dotenv/config';

/** @typedef {import('./types.js').AppConfig} AppConfig */

/**
 * Builds the settings from an environment. AGENT selects which of the two
 * agents this process runs. Its token is read from TOKEN_<AGENT>; with no
 * token the server creates a new agent by name. Each tuning constant can be
 * overridden by the variable named beside it, to try values without editing
 * code.
 * @param {Record<string, string | undefined>} env
 * @returns {AppConfig}
 */
export function loadConfig(env) {
  const agent = (env.AGENT || 'bubble').toLowerCase();
  /** @param {string} name @param {number} fallback */
  const num = (name, fallback) => positiveNumber(env, name, fallback);

  return {
    host: env.HOST ?? 'http://localhost:8080',
    token: env[`TOKEN_${agent.toUpperCase()}`] || undefined,
    name: agent,
    // The online PDDL planner is on by default, because the course asks for the
    // planner to be called when an intention is activated; the agent never
    // waits for it (see src/plans/library.js). PLANNER=disabled turns it off.
    planner: planner(env),
    replaceMargin: num('REPLACE_MARGIN', 1.2),                 // a new option must be 20% better to replace the current one
    minCommitMs: num('MIN_COMMIT_MS', 6000),                   // the shortest time a non-urgent goal is kept before a soft switch
    failedGoalCooldownMs: num('FAILED_GOAL_COOLDOWN_MS', 10_000), // how long a failed goal waits before it is tried again
    blockedTtlMs: num('BLOCKED_TTL_MS', 2000),                 // how long a refused move is first avoided; doubles on each repeat
    maxBlockedMs: num('MAX_BLOCKED_MS', 30_000),               // the longest a refused move is ever avoided
    agentTtlMs: num('AGENT_TTL_MS', 3000),                     // how long a sighted agent counts as an obstacle
    maxMoveRetries: num('MAX_MOVE_RETRIES', 3),
    congestionTimeoutMs: num('NAV_CONGESTION_TIMEOUT_MS', 3500), // how long to wait behind another agent before giving up
    congestionRetryMs: num('NAV_CONGESTION_RETRY_MS', 180),    // how often to look again while waiting behind another agent
    pddlTimeoutMs: num('PDDL_TIMEOUT_MS', 10_000),              // how long to wait for the online solver; it took 3 to 7 s in our tests
    pddlBreakerFailures: Math.floor(num('PDDL_BREAKER_FAILURES', 3)), // failed solver calls in a row before the solver is skipped for a while
    pddlBreakerCooldownMs: num('PDDL_BREAKER_COOLDOWN_MS', 60_000), // how long the solver is skipped after that
    pddlMaxConcurrent: Math.floor(num('PDDL_MAX_CONCURRENT', 2)), // the most solver requests running at once, timed-out ones included
    planArchiveSize: Math.floor(num('PLAN_ARCHIVE_SIZE', 500)),  // the most plans the Plan Library keeps
    actionTimeoutMs: num('ACTION_TIMEOUT_MS', 8000),           // how long an SDK action may take before its outcome counts as unknown
    optionStrategy: strategy(env),                             // how pickups are weighed against delivering what is carried
    minNetGain: num('MIN_NET_GAIN', 1),                        // with net_gain: the fewest extra points a switch of goal must earn
    timeValuePerS: timeValue(env),                             // with net_gain: points one second is worth; null learns it from the score
    deliveryProtection: atLeastZero(env, 'DELIVERY_PROTECTION', 0), // with net_gain: the gain above which a pickup gives way to delivering
  };
}

/**
 * PLANNER is 'online' or 'disabled'. When it is unset, the older MOVER is
 * read instead, so that existing scripts keep working: MOVER=astar turns the
 * planner off and anything else leaves it on.
 * @param {Record<string, string | undefined>} env
 * @returns {'disabled' | 'online'}
 */
function planner(env) {
  const raw = env.PLANNER;
  if (raw === undefined || raw === '') return env.MOVER === 'astar' ? 'disabled' : 'online';
  if (raw === 'disabled' || raw === 'online') return raw;
  throw new Error(`PLANNER must be disabled or online, got '${raw}'`);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback  used when the variable is unset or empty
 */
function atLeastZero(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!(value >= 0)) throw new Error(`${name} must be a number of 0 or more, got '${raw}'`);
  return value;
}

/**
 * TIME_VALUE is a fixed value of time in points per second, 0 or more. Unset,
 * empty or 'auto' gives null: the agent learns the value from its own score.
 * @param {Record<string, string | undefined>} env
 * @returns {number | null}
 */
function timeValue(env) {
  const raw = env.TIME_VALUE;
  if (raw === undefined || raw === '' || raw === 'auto') return null;
  const value = Number(raw);
  if (!(value >= 0)) throw new Error(`TIME_VALUE must be auto or a number of 0 or more, got '${raw}'`);
  return value;
}

/**
 * OPTION_STRATEGY is 'net_gain' unless it is set to 'baseline'.
 * @param {Record<string, string | undefined>} env
 * @returns {'baseline' | 'net_gain'}
 */
function strategy(env) {
  const raw = env.OPTION_STRATEGY;
  if (raw === undefined || raw === '' || raw === 'net_gain') return 'net_gain';
  if (raw === 'baseline') return 'baseline';
  throw new Error(`OPTION_STRATEGY must be net_gain or baseline, got '${raw}'`);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback  used when the variable is unset or empty
 */
function positiveNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!(value > 0)) throw new Error(`${name} must be a positive number, got '${raw}'`);
  return value;
}

export const config = loadConfig(process.env);
