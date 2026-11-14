// Starts the agent: connects to the server, passes every server message to
// the beliefs, builds the plans and runs the agent loop.
// Run with: npm start   (or AGENT=milktea npm start)
import { config } from './config.js';
import { connect } from './client.js';
import { Beliefs } from './beliefs/index.js';
import { listOptions } from './deliberation/options.js';
import { IntentionRevision } from './intentions/revision.js';
import { planLibrary } from './plans/library.js';
import { astarRoute } from './planning/astar.js';

/** @typedef {import('./intentions/revision.js').RevisionEvent} RevisionEvent */

const client = connect(config);

// With no token, the server creates a new agent and sends its token. Put the
// token in .env to play as the same agent next time.
client.socket.once('token', (/** @type {string} */ token) =>
  console.log(`[token] new agent; put TOKEN_${config.name.toUpperCase()}=${token} in .env to keep it`));
client.socket.on('connect', () => console.log(`[connection] connected to ${config.host} as ${config.name}`));
client.socket.on('disconnect', (/** @type {string} */ reason) => console.log(`[connection] lost: ${reason}`));

const beliefs = new Beliefs({
  agentTtlMs: config.agentTtlMs,
  blockedTtlMs: config.blockedTtlMs,
  maxBlockedMs: config.maxBlockedMs,
});
beliefs.listen(client);

if (config.mover === 'pddl') console.log('[mover] PDDL is not written yet (Task 8); using A*');
const plans = planLibrary({ beliefs, client, planRoute: astarRoute, maxFailures: config.maxMoveRetries });

const fading = { halfLifeMs: config.parcelHalfLifeMs, minChance: config.minParcelChance };
const loop = new IntentionRevision({
  beliefs,
  plans,
  margin: config.replaceMargin,
  options: () => listOptions(beliefs, fading),
  onEvent: report,
});

/** @param {RevisionEvent} event */
function report({ kind, option, reason }) {
  const score = beliefs.me?.score ?? 0;
  const value = option.utility.toFixed(1);
  console.log(`[${kind}] ${option.id} (worth ${value})${reason ? `: ${reason}` : ''} | score ${score}`);
}

// Print the map when a game starts, and the score every 30 s.
let announcedMap = /** @type {unknown} */ (undefined);
beliefs.onChange(() => {
  if (!beliefs.ready || beliefs.map === announcedMap) return;
  announcedMap = beliefs.map;
  const { GAME } = /** @type {NonNullable<typeof beliefs.config>} */ (beliefs.config);
  console.log(`[map] ${GAME.title} ${beliefs.map?.width} x ${beliefs.map?.height}, capacity ${GAME.player.capacity}, decay ${GAME.parcels.decaying_event}`);
});
setInterval(() => {
  const warnings = beliefs.me?.attributes?.find(a => a.kind === 'warnings')?.value ?? 0;
  console.log(`[status] score ${beliefs.me?.score ?? 0}, warnings ${warnings}, other agents ${beliefs.agents.count}`);
}, 30_000).unref();

process.on('SIGINT', () => {
  loop.halt();
  console.log(`[stop] score ${beliefs.me?.score ?? 0}`);
  process.exit(0);
});

await loop.run();
