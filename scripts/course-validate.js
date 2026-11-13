#!/usr/bin/env node
import { parseCourseArgs, runCourseValidation, HELP } from '../src/course/validation-runner.js';
const controller=new AbortController();
process.once('SIGINT',()=>{console.error('\nInterrupt: shutting down scenario and game server.');controller.abort();});
process.once('SIGTERM',()=>{console.error('\nTermination: cleaning up.');controller.abort();});
try {
  const opts=parseCourseArgs(process.argv.slice(2));
  if(opts.help)console.log(HELP);
  else {
    const result=await runCourseValidation(opts,controller.signal);
    console.log(`\nStage 4C local evidence: ${result.output}`);
    console.log('Files: report.md, scenarios.csv, manifest.json, per-scenario logs and result.json');
    console.log('These are LOCAL challenge-readiness checks, not the official instructor evaluation.');
    if(!result.allPassed)process.exitCode=1;
  }
}catch(error){console.error('Stage 4C validation failed:',error instanceof Error?error.message:String(error));process.exitCode=1;}
