#!/usr/bin/env node
import { HELP, parseBenchmarkArgs, runBenchmarks } from '../src/benchmark/runner.js';

const controller = new AbortController();
process.once('SIGINT', () => { console.error('\nInterrupt received; ending current round and cleaning up.'); controller.abort(); });
process.once('SIGTERM', () => { console.error('\nTermination received; cleaning up.'); controller.abort(); });
try {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); process.exit(0); }
  const result = await runBenchmarks(options, controller.signal);
  console.log(`\nBenchmark results: ${result.output}`);
  console.log('CSV: rounds.csv | Aggregate: aggregate.json | Comparisons: comparisons.json | Raw per-round logs');
  console.log('IMPORTANT: scores are agent-observed and not official Tournament scores; seeds are not controlled.');
  if (result.interrupted || result.rounds.some(r => !r.valid)) process.exitCode = 1;
} catch (error) {
  console.error('Benchmark failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
