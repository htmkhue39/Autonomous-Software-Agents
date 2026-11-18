#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateRounds, compareModes, auditHistoricalRound } from '../src/benchmark/results.js';

const dir = process.argv[2];
if (!dir) { console.error('Usage: npm run benchmark:summary -- benchmark-results/<run-folder>'); process.exit(1); }
try {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (!['3A','3A.1'].includes(manifest.stage)) throw new Error('Not a Stage 3A/3A.1 benchmark manifest');
  const historical = manifest.stage === '3A';
  const rows = historical ? (manifest.rounds??[]).map(auditHistoricalRound) : (manifest.rounds??[]);
  if (historical) console.log('RETROSPECTIVE AUDIT: duration checks applied to Stage 3A historical rows; original files were not changed.');
  console.log(`Benchmark: ${rows.length} trial(s); game=${manifest.config.game}; duration=${manifest.config.durationSec}s; mover=${manifest.config.mover}`);
  for (const r of rows) console.log(`  ${r.mode} #${r.trial}: valid=${r.valid} logScore=${r.teamObservedScore ?? 'NA'} deliveries=${r.totalDeliveredParcels} llmCalls=${r.llmCalls} ${r.issues.join(',')}`);
  for (const a of aggregateRounds(rows)) console.log(`  ${a.mode} ${a.label}: ${a.validTrials}/${a.trials} valid; mean log score=${a.meanObservedScore ?? 'NA'}; mean deliveries=${a.meanDeliveries ?? 'NA'}`);
  const bc=compareModes(rows,'B','C');
  console.log(`Unpaired C-B score difference: ${bc.difference ?? 'N/A'}; Welch 95% CI: ${JSON.stringify(bc.ci95)} (small samples / uncontrolled seeds)`);
  console.log('NOT official Tournament results; unmatched random seeds prevent claiming paired trials.');
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
