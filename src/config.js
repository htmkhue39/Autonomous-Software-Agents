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
    replaceMargin: num('REPLACE_MARGIN', 1.2),       // new option must be 20% better to replace
    blockedTtlMs: num('BLOCKED_TTL_MS', 2000),       // how long a refused move is first avoided; doubles on each repeat
    maxBlockedMs: num('MAX_BLOCKED_MS', 30_000),     // the longest a refused move is ever avoided
    agentTtlMs: num('AGENT_TTL_MS', 3000),           // how long a sighted agent counts as an obstacle
    maxMoveRetries: num('MAX_MOVE_RETRIES', 3),
    pddlTimeoutMs: num('PDDL_TIMEOUT_MS', 5000),
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
