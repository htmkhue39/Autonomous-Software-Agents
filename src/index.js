import { connect } from './client.js';
import { config } from './config.js';
import { Beliefs } from './beliefs/index.js';
import { ActionGate } from './plans/action-gate.js';
import { MovementRunner } from './plans/moveTo.js';
import { PlanLibrary } from './plans/library.js';
import { BdiAgent } from './intentions/agent.js';
import { logEvent } from './metrics/log.js';
import { CoordinationController } from './coordination/controller.js';

const client = connect(config);
const beliefs = new Beliefs({
  agentTtlMs: config.agentTtlMs,
  blockedTtlMs: config.blockedTtlMs,
  maxBlockedMs: config.maxBlockedMs,
});
beliefs.listen(client);
const log = (/** @type {string} */ event, /** @type {object} */ data) => logEvent(event, { agent: config.name, ...data });
const coordination = process.env.COORDINATION_ENABLED === 'true' ? new CoordinationController({
  client, beliefs, selfName: 'bubble', peerName: 'milktea', log,
}) : null;
coordination?.start();
const gate = new ActionGate({ timeoutMs: config.actionTimeoutMs });
const movement = new MovementRunner({
  beliefs, client, gate, mode: config.mover,
  pddlTimeoutMs: config.pddlTimeoutMs,
  maxMoveRetries: config.maxMoveRetries,
  congestionTimeoutMs: config.congestionTimeoutMs, congestionRetryMs: config.congestionRetryMs, log,
});
const plans = new PlanLibrary({ beliefs, client, gate, movement, log });
const agent = new BdiAgent({ beliefs, plans, gate, replaceMargin: config.replaceMargin,
  minCommitMs: config.minCommitMs, failedGoalCooldownMs: config.failedGoalCooldownMs, coordination, log });
/** @type {number | null} */
let lastScore = null;
client.onYou(me => {
  if (lastScore === null) log('score_observed', { score: me.score });
  else if (me.score !== lastScore) log('score_changed', { previous: lastScore, score: me.score });
  lastScore = me.score;
});

let gameReadyLogged = false;
beliefs.onChange(() => {
  if (gameReadyLogged || !beliefs.ready || !beliefs.positionStable) return;
  gameReadyLogged = true;
  log('bdi_game_ready', { level: beliefs.config?.GAME.title });
});

client.socket.on('token', (/** @type {string} */ token) => log('token_issued', { note: 'Store new token locally in .env; token is deliberately not logged', tokenReceived: !!token }));
client.socket.on('disconnect', (/** @type {string} */ reason) => { agent.stop(); coordination?.stop(); log('disconnected', { reason }); });
const stop = () => {
  if (process.env.BENCHMARK_CONTINUOUS === 'true') log('benchmark_bdi_final', { score: lastScore });
  agent.stop(); coordination?.stop(); client.socket.disconnect?.();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
log('startup', { host: config.host, mode: config.mover });
await agent.start();
