#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkArgs, runBenchmarks } from '../src/benchmark/runner.js';
import { schedulingSeed } from '../src/benchmark/ablation.js';

export const HELP = `Usage: npm run benchmark:ablation -- --server-dir /path/to/Deliveroo.js [options]\n\n`+
  `--runs N                  Trials per condition (C0 and C1) [10]\n`+
  `--duration SECONDS        Round duration [180]\n`+
  `--schedule-seed UINT32    Reproducible ORDER seed (NOT a game-world seed) [random]\n`+
  `--output PATH             Result directory [ablation-results/<timestamp>]\n`+
  `Other options: --game, --mover, --host, --startup-timeout, --timing-tolerance-ms, --readiness-tolerance-ms.\n`+
  `The runner controls evacuation per trial. It refuses --modes, and never claims paired-world randomness.\n`;

/** @param {string[]} argv @param {string} [cwd] */
export function parseAblationArgs(argv, cwd=process.cwd()) {
  if (argv.includes('--help') || argv.includes('-h')) return {help:true};
  if (argv.includes('--modes')) throw new Error('--modes is not supported for ablation; both conditions always use cooperative mode C');
  let seed;
  const stripped=[];
  for (let i=0;i<argv.length;i++) {
    if (argv[i] === '--schedule-seed') {
      const raw=argv[++i];
      if (!raw || !/^\d+$/.test(raw)) throw new Error('--schedule-seed must be a uint32 integer');
      seed=Number(raw);
      if (!Number.isSafeInteger(seed) || seed<0 || seed>0xffffffff) throw new Error('--schedule-seed must be 0..4294967295');
    } else stripped.push(argv[i]);
  }
  const opts=parseBenchmarkArgs(stripped,cwd);
  opts.modes=['C'];
  if (!argv.includes('--runs')) opts.runs=10;
  if (!argv.includes('--output')) opts.output=resolve(cwd,'ablation-results',new Date().toISOString().replace(/[:.]/g,'-'));
  return {...opts,ablation:{schedulingSeed:schedulingSeed(seed)}};
}

// Only execute CLI when directly run; importing for unit tests must be inert.
if (process.argv[1] && resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))) {
  const controller=new AbortController();
  process.once('SIGINT',()=>{console.error('\nInterrupt received; cleaning up.');controller.abort();});
  process.once('SIGTERM',()=>{console.error('\nTerminating; cleaning up.');controller.abort();});
  try {
    const options=parseAblationArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else if ('ablation' in options && options.ablation) {
      console.log(`Stage 3C.3 scheduling seed (ORDER ONLY): ${options.ablation.schedulingSeed}`);
      const result=await runBenchmarks(options,controller.signal);
      console.log(`\nAblation results: ${result.output}`);
      console.log('Files: ablation-results.csv, comparison.json, report.md, manifest.json, raw trial logs.');
      console.log('Scores are agent-observed, NOT Tournament; game-world randomness is NOT controlled.');
      if (result.interrupted || result.rounds.length!==options.runs*2 || result.rounds.some(r=>!r.valid)) process.exitCode=1;
    }
  } catch(err) {
    console.error('Ablation failed:',err instanceof Error?err.message:String(err));
    process.exitCode=1;
  }
}
