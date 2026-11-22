/** Summarize structured events from a local smoke-test log without contacting
 * the game server or exposing credentials. The browser's saved timed-round
 * scoreboard is authoritative for the round result, not the last score here.
 */
import { readFileSync } from 'node:fs';

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: npm run summarize -- logs/astar-stage11.log');
  process.exitCode = 2;
} else {
  try {
    const lines = readFileSync(logFile, 'utf8').split(/\r?\n/);
    const counts = new Map();
    const pddlMs = [];
    let lastScore = null;
    let firstScore = null;
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.event !== 'string') continue;
        counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
        if (event.event === 'score_changed' && typeof event.score === 'number') {
          if (firstScore === null && typeof event.previous === 'number') firstScore = event.previous;
          lastScore = event.score;
        }
        if (event.event === 'pddl_success' && typeof event.durationMs === 'number') pddlMs.push(event.durationMs);
      } catch { /* non-JSON messages from the planner are intentionally skipped */ }
    }
    const events = ['intention_activated', 'intention_revision', 'intention_outcome',
      'intention_cooldown', 'pickup_ack', 'pickup', 'delivery', 'score_changed',
      'move', 'move_refused', 'navigation_failed', 'navigation_cancelled',
      'pddl_call', 'pddl_success', 'pddl_failure', 'planner_fallback', 'action_unknown'];
    console.log(`Log: ${logFile}`);
    for (const name of events) console.log(`${name.padEnd(24)} ${counts.get(name) ?? 0}`);
    if (pddlMs.length) {
      const avg = pddlMs.reduce((a, b) => a + b, 0) / pddlMs.length;
      console.log(`Mean successful PDDL time: ${avg.toFixed(0)} ms (${pddlMs.length} plans)`);
    }
    if (lastScore !== null) console.log(`Last observed score: ${lastScore} (first observed ${firstScore})`);
    console.log('Note: use the saved Tournament round result for the exact timed-round score.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
