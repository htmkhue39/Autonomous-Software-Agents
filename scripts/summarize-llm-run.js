import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage: npm run summarize:llm -- logs/milktea-stage2b.log'); process.exit(2); }
const counts = new Map();
let lastResult = null;
/** @type {number[]} */ const scores = [];
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  try {
    const record = JSON.parse(line);
    if (!record || typeof record.event !== 'string' || record.agent !== 'milktea') continue;
    counts.set(record.event, (counts.get(record.event) ?? 0) + 1);
    if (record.event === 'game_objective_result') lastResult = record;
    if (record.event === 'score_changed' && typeof record.score === 'number') scores.push(record.score);
  } catch { /* npm banners and human-readable completion messages */ }
}
console.log('Log:', file);
for (const event of ['llm_game_ready', 'llm_plan', 'llm_tool_result', 'llm_no_tool_calls', 'llm_action_invalid', 'llm_plan_invalid', 'llm_objective_auto_verified',
  'pickup', 'delivery', 'move', 'move_refused', 'navigation_failed', 'action_unknown', 'game_objective_result']) {
  console.log(`${event.padEnd(24)} ${counts.get(event) ?? 0}`);
}
if (scores.length) console.log('Last observed score change:', scores.at(-1));
if (lastResult) console.log('Result:', JSON.stringify({ status: lastResult.status, reason: lastResult.reason,
  metrics: lastResult.metrics, progress: lastResult.progress }, null, 2));
else console.log('No completed objective record. Inspect disconnection, crash or cancellation.');
