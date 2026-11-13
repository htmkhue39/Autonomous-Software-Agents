import 'dotenv/config';

// AGENT selects which of the two agents this process runs. Its token is read
// from TOKEN_<AGENT>; with no token the server creates a new agent by name.
const agent = (process.env.AGENT || 'bubble').toLowerCase();

/** @type {import('./types.js').AppConfig} */
export const config = {
  host: process.env.HOST ?? 'http://localhost:8080',
  token: process.env[`TOKEN_${agent.toUpperCase()}`] || undefined,
  name: agent,
  mover: process.env.MOVER === 'astar' ? 'astar' : 'pddl',
  replaceMargin: Number(process.env.REPLACE_MARGIN ?? 1.2), // utility switching policy
  minCommitMs: Number(process.env.MIN_COMMIT_MS ?? 6000),   // nonurgent goal commitment
  failedGoalCooldownMs: Number(process.env.FAILED_GOAL_COOLDOWN_MS ?? 10000),
  blockedTtlMs: 2000,     // how long a refused move is first avoided; doubles on each repeat
  maxBlockedMs: 30_000,   // the longest a refused move is ever avoided
  agentTtlMs: 3000,       // how long a sighted agent counts as an obstacle
  maxMoveRetries: 3,
  congestionTimeoutMs: Number(process.env.NAV_CONGESTION_TIMEOUT_MS ?? 3500),
  congestionRetryMs: Number(process.env.NAV_CONGESTION_RETRY_MS ?? 180),
  pddlTimeoutMs: Number(process.env.PDDL_TIMEOUT_MS ?? 5000),
  actionTimeoutMs: Number(process.env.ACTION_TIMEOUT_MS ?? 8000),
};
