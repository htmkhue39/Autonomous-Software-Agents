import { connect } from './client.js';
import { config } from './config.js';
import { Beliefs } from './beliefs/index.js';
import { ActionGate } from './plans/action-gate.js';
import { MovementRunner } from './plans/moveTo.js';
import { PlanLibrary } from './plans/library.js';
import { PlanArchive } from './plans/archive.js';
import { PlannerService } from './planning/pddl/service.js';
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
const gate = new ActionGate({ timeoutMs: config.actionTimeoutMs, minimumMs: () => beliefs.atLeastMoves(0, 4) });
const movement = new MovementRunner({
  beliefs, client, gate,
  maxMoveRetries: config.maxMoveRetries,
  congestionTimeoutMs: config.congestionTimeoutMs, congestionRetryMs: config.congestionRetryMs, log,
});
const planner = config.planner === 'online' ? new PlannerService({ timeoutMs: config.pddlTimeoutMs,
  breakerFailures: config.pddlBreakerFailures, breakerCooldownMs: config.pddlBreakerCooldownMs,
  maxConcurrent: config.pddlMaxConcurrent, log }) : null;
const plans = new PlanLibrary({ beliefs, client, gate, movement, log, planner,
  archive: new PlanArchive({ size: config.planArchiveSize }) });
const agent = new BdiAgent({ beliefs, plans, gate, replaceMargin: config.replaceMargin,
  minCommitMs: config.minCommitMs, failedGoalCooldownMs: config.failedGoalCooldownMs, coordination, log,
  optionPolicy: { strategy: config.optionStrategy, minGain: config.minNetGain, timeValuePerS: config.timeValuePerS,
    deliveryProtection: config.deliveryProtection } });
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
log('startup', { host: config.host, planner: config.planner, optionStrategy: config.optionStrategy, minNetGain: config.minNetGain, timeValuePerS: config.timeValuePerS, deliveryProtection: config.deliveryProtection,
  pddlTimeoutMs: config.pddlTimeoutMs, pddlBreakerFailures: config.pddlBreakerFailures, pddlBreakerCooldownMs: config.pddlBreakerCooldownMs,
  planArchiveSize: config.planArchiveSize });
await agent.start();
