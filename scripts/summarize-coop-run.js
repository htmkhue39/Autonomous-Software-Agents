import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length !== 2) {
  console.error('Usage: npm run summarize:coop -- logs/bubble-stage2c.log logs/milktea-stage2c.log');
  process.exit(2);
}
const events = ['coordination_peer_discovered', 'coordination_sent', 'coordination_received',
  'coordination_belief_merged', 'coordination_claim_started', 'coordination_claim_released',
  'coordination_claim_expired', 'coordination_yield', 'coordination_pickup_skipped',
  'pickup', 'delivery', 'navigation_failed', 'navigation_wait', 'navigation_recovered',
  'llm_parcel_rejected', 'llm_target_cooldown', 'llm_inventory_reconciled',
  'llm_target_precondition_rejected', 'llm_dynamic_selected', 'llm_dynamic_reselected',
  'llm_dynamic_explore', 'llm_dynamic_no_target', 'llm_dynamic_delivered',
  'llm_coordination_safe_yield', 'llm_objective_auto_verified',
  'llm_tool_result', 'game_objective_result'];
const results = [];
for (const file of files) {
  /** @type {Map<string,number>} */ const counts = new Map();
  /** @type {Map<string,number>} */ const traffic = new Map();
  /** @type {Map<string,number>} */ const failures = new Map();
  /** @type {any} */ let result = null;
  /** @type {number|null} */ let score = null;
  let name = 'unknown';
  let parsed = 0;
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      /** @type {any} */ let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row.event !== 'string') continue;
      if (row.agent === 'bubble' || row.agent === 'milktea') name = row.agent;
      parsed++;
      counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
      if (['coordination_sent', 'coordination_received'].includes(row.event)) {
        const key = `${row.event}:${row.type || 'unknown'}`;
        traffic.set(key, (traffic.get(key) ?? 0) + 1);
      }
      if (row.event === 'llm_tool_result' && row.ok === false) {
        const code = String(row.errorCode || 'unknown');
        failures.set(code, (failures.get(code) ?? 0) + 1);
        if (row.precondition === true) {
          const rejection = `precondition:${String(row.rejectionReason || 'unknown')}`;
          failures.set(rejection, (failures.get(rejection) ?? 0) + 1);
        }
      }
      if (row.event === 'navigation_failed' && row.failureKind) {
        const code = `navigation:${row.failureKind}`;
        failures.set(code, (failures.get(code) ?? 0) + 1);
      }
      if (row.event === 'game_objective_result') result = row;
      if (row.event === 'score_changed' && typeof row.score === 'number') score = row.score;
    }
  } catch (error) { console.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; continue; }
  console.log(`\n${file} (${name}, ${parsed} structured events)`);
  for (const event of events) console.log(`${event.padEnd(31)} ${counts.get(event) ?? 0}`);
  for (const [event, n] of [...traffic.entries()].sort()) console.log(`  ${event.padEnd(29)} ${n}`);
  for (const [failure, n] of [...failures.entries()].sort()) console.log(`  failure:${failure.padEnd(25)} ${n}`);
  if (score !== null) console.log('Last logged score:', score);
  if (result) console.log('LLM objective:', JSON.stringify({ status: result.status, reason: result.reason,
    progress: result.progress, metrics: result.metrics }));
  if (!counts.get('coordination_received')) console.log('WARNING: No teammate messages received. Check COORDINATION_ENABLED=true on BOTH agents and saved player identities.');
  results.push({ name, counts });
}
if (results.length === 2) {
  const sum = (event) => results.reduce((total, r) => total + (r.counts.get(event) ?? 0), 0);
  console.log('\nCombined activity (not a tournament score):');
  console.log(`Deliveries: ${sum('delivery')} action(s); pickups: ${sum('pickup')} action(s); shared-belief updates: ${sum('coordination_belief_merged')} event(s); arbitration yields: ${sum('coordination_yield')}`);
  console.log(`Navigation waits/recoveries/failures: ${sum('navigation_wait')} / ${sum('navigation_recovered')} / ${sum('navigation_failed')}`);
  console.log(`LLM rejected/cooldown/reconciled events: ${sum('llm_parcel_rejected')} / ${sum('llm_target_cooldown')} / ${sum('llm_inventory_reconciled')}`);
  console.log(`Dynamic target selections/reselections/deliveries: ${sum('llm_dynamic_selected')} / ${sum('llm_dynamic_reselected')} / ${sum('llm_dynamic_delivered')}`);
  console.log(`Dynamic exploration/no-target/precondition rejections: ${sum('llm_dynamic_explore')} / ${sum('llm_dynamic_no_target')} / ${sum('llm_target_precondition_rejected')}`);
  console.log(`Safe LLM claim yields before SDK pickup: ${sum('llm_coordination_safe_yield')}`);
  console.log(`Automatically verified LLM objectives: ${sum('llm_objective_auto_verified')}`);
  console.log('Use the saved Tournament panel for official timed-round scores. A single log is not a controlled cooperation benchmark.');
}
