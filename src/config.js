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
    mover: env.MOVER === 'pddl' ? 'pddl' : 'astar',
    replaceMargin: num('REPLACE_MARGIN', 1.2),                 // a new option must be 20% better to replace the current one
    minCommitMs: num('MIN_COMMIT_MS', 6000),                   // the shortest time a non-urgent goal is kept before a soft switch
    failedGoalCooldownMs: num('FAILED_GOAL_COOLDOWN_MS', 10_000), // how long a failed goal waits before it is tried again
    blockedTtlMs: num('BLOCKED_TTL_MS', 2000),                 // how long a refused move is first avoided; doubles on each repeat
    maxBlockedMs: num('MAX_BLOCKED_MS', 30_000),               // the longest a refused move is ever avoided
    agentTtlMs: num('AGENT_TTL_MS', 3000),                     // how long a sighted agent counts as an obstacle
    maxMoveRetries: num('MAX_MOVE_RETRIES', 3),
    congestionTimeoutMs: num('NAV_CONGESTION_TIMEOUT_MS', 3500), // how long to wait behind another agent before giving up
    congestionRetryMs: num('NAV_CONGESTION_RETRY_MS', 180),    // how often to look again while waiting behind another agent
    pddlTimeoutMs: num('PDDL_TIMEOUT_MS', 5000),
    actionTimeoutMs: num('ACTION_TIMEOUT_MS', 8000),           // how long an SDK action may take before its outcome counts as unknown
  };
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
