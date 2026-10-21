import 'dotenv/config';

// AGENT selects which of the two agents this process runs. Its token is read
// from TOKEN_<AGENT>; with no token the server creates a new agent by name.
const agent = (process.env.AGENT || 'bubble').toLowerCase();

/** @type {import('./types.js').AppConfig} */
export const config = {
  host: process.env.HOST ?? 'http://localhost:8080',
  token: process.env[`TOKEN_${agent.toUpperCase()}`] || undefined,
  name: agent,
  mover: process.env.MOVER === 'pddl' ? 'pddl' : 'astar',
  replaceMargin: 1.2,     // new option must be 20% better to replace
  blockedTtlMs: 2000,     // how long a refused move is first avoided; doubles on each repeat
  maxBlockedMs: 30_000,   // the longest a refused move is ever avoided
  agentTtlMs: 3000,       // how long a sighted agent counts as an obstacle
  maxMoveRetries: 3,
  pddlTimeoutMs: 5000,
};
