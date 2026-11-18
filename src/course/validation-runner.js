// @ts-nocheck -- isolated OS process orchestration; runtime inputs verified by parseCourseArgs.
/** Stage 4C real-game local validation. NOT official course evaluator. */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { parseBenchmarkArgs, isPortOpen, waitForServer, startProcess, stopProcess } from '../benchmark/runner.js';
import { COURSE_SCENARIOS, parseScenarioList, parseEvidenceEvents, eventCount, evaluateScenario, validationReport } from './validation.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const SCENARIO_NAMES=Object.keys(COURSE_SCENARIOS);
export const HELP=`Usage: npm run course:validate -- --server-dir /path/to/Deliveroo.js [options]\n\n`+
  `--scenarios LIST          Comma-separated: ${SCENARIO_NAMES.join(',')} [all]\n`+
  `--duration SECONDS        Max live observation seconds per scenario [180]\n`+
  `--game NAME               GAME_NAME passed to fresh server [oval_counterclockwise]\n`+
  `--host URL                Fresh server address [http://localhost:8080]\n`+
  `--startup-timeout N       Wait for server readiness, seconds [45]\n`+
  `--output PATH             Local evidence folder [course-validation-results/<timestamp>]\n`+
  `--help                    Show help\n\n`+
  `Requires game server checkout, two JWTs in private .env and local Ollama.\n`+
  `Uses PDDL mode in bdi_pddl only; other scenarios use A*. Does not verify official course services.\n`;

/** @param {string[]} argv @param {string} [cwd] */
export function parseCourseArgs(argv,cwd=process.cwd()) {
  if(argv.includes('--help')||argv.includes('-h'))return{help:true};
  let scenarios=[...SCENARIO_NAMES];const stripped=[];
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--scenarios') { if(!argv[i+1])throw new Error('Missing --scenarios value');scenarios=parseScenarioList(argv[++i]); }
    else stripped.push(argv[i]);
  }
  if(stripped.includes('--mover')||stripped.includes('--modes')||stripped.includes('--runs')||stripped.includes('--timing-tolerance-ms')||stripped.includes('--readiness-tolerance-ms'))
    throw new Error('Stage 4C sets agent modes itself; --mover, --modes, --runs, --timing-tolerance-ms and --readiness-tolerance-ms are unsupported');
  const opts=parseBenchmarkArgs(stripped,cwd);
  const output=stripped.includes('--output') ? opts.output : resolve(cwd,'course-validation-results',new Date().toISOString().replace(/[:.]/g,'-'));
  return {serverDir:opts.serverDir,host:opts.host,game:opts.game,durationSec:opts.durationSec,startupTimeoutSec:opts.startupTimeoutSec,output,scenarios};
}

/** @param {string} path @param {number} cutoff */
async function eventsAt(path,cutoff=Infinity) {
  try{return parseEvidenceEvents(await readFile(path,'utf8'),cutoff);}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
}

/** @param {string} path @param {string} type @param {(row:any)=>boolean} [predicate] */
async function eventAvailable(path,type,predicate=()=>true){return eventCount(await eventsAt(path),type,predicate)>0;}

/** @param {number} maxMs @param {AbortSignal} signal @param {()=>Promise<boolean>} predicate @param {()=>boolean} [hasExited] */
async function waitUntil(maxMs,signal,predicate,hasExited=()=>false) {
  const deadline=Date.now()+maxMs;
  while(Date.now()<deadline && !signal.aborted && !hasExited()) {
    if(await predicate())return true;
    await wait(Math.min(300,Math.max(1,deadline-Date.now())));
  }
  return !signal.aborted && !hasExited() && await predicate();
}

/** @param {string} cwd */
function revision(cwd) {try{return execFileSync('git',['rev-parse','HEAD'],{cwd,timeout:2500,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}}
/** @param {string} name */
function safeName(name){return /^[a-z0-9_]+$/.test(name);}

/**
 * @param {ReturnType<typeof parseCourseArgs>} opts
 * @param {AbortSignal} signal
 */
export async function runCourseValidation(opts,signal) {
  if(process.platform==='win32')throw new Error('Process-group cleanup is supported on macOS/Linux');
  await access(join(opts.serverDir,'package.json'));
  await access(join(ROOT,'src','index.js'));
  if(await isPortOpen(opts.host))throw new Error(`Game port ${opts.host} already occupied: stop your game server before validation`);
  await mkdir(opts.output,{recursive:true});
  const manifest={stage:'4C',createdAt:new Date().toISOString(),status:'in_progress',
    localNotOfficial:true,gameWorldSeedControlled:false,requestedScenarios:opts.scenarios,
    runtime:{node:process.version,platform:process.platform},
    config:{game:opts.game,host:opts.host,observationMaxSeconds:opts.durationSec,cooperativeEvacuation:true,llmMode:'json',
      llmProvider:'ollama',pddlScenarioPlanner:'external_pddl_client',otherScenariosPlanner:'astar',
      officialCourseApiVerified:false},
    revision:{agent:revision(ROOT),gameServer:revision(opts.serverDir)},
    results:[]};
  const persist=async()=>{
    await writeFile(join(opts.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    await writeFile(join(opts.output,'report.md'),validationReport(manifest.results));
    const fields=['scenario','passed','elapsedMs','checksPassed','checksTotal','failedChecks','bdiIntentions','pddlCalls','pddlSuccess','bdiDeliveries','llmDeliveries','llmModelCalls','llmToolResults','coordinationMessages','beliefMerges','llmEvacuations','objectiveStarts','objectiveQuarantines'];
    const escape=x=>{const raw=x===null||x===undefined?'':String(x);return /[",\r\n]/.test(raw)?`"${raw.replaceAll('"','""')}"`:raw;};
    await writeFile(join(opts.output,'scenarios.csv'),[fields.join(','),...manifest.results.map(r=>fields.map(f=>escape({
      ...r,...r.observed,checksPassed:r.checks.filter(c=>c.passed).length,checksTotal:r.checks.length,failedChecks:r.checks.filter(c=>!c.passed).map(c=>c.id).join(';')
    }[f])).join(','))].join('\n')+'\n');
  };
  await persist();
  for(const scenario of opts.scenarios) {
    if(signal.aborted)break;
    if(!safeName(scenario)||!COURSE_SCENARIOS[scenario])throw new Error('Unknown scenario');
    const def=COURSE_SCENARIOS[scenario];
    const dir=join(opts.output,scenario);await mkdir(dir,{recursive:true});
    console.log(`Stage 4C [${scenario}]: ${def.title} (up to ${opts.durationSec}s)`);
    let server,serverStopped=false,setupError=null,completedWindow=false;
    const agents={};const issued={goal1Sent:false,goal2Sent:false,firstToolObservedBeforeReplacement:false};
    const maxMs=opts.durationSec*1000;let startedAt=Date.now(),deadlineMs=startedAt+maxMs,finishedAt=startedAt;
    try {
      if(await isPortOpen(opts.host))throw new Error('Game port already in use before scenario');
      server=startProcess('npm',['start'],{cwd:opts.serverDir,env:{...process.env,GAME_NAME:opts.game},logFile:join(dir,'server.log')});
      await waitForServer(opts.host,opts.startupTimeoutSec*1000,()=>server.state.exited);
      if(signal.aborted)throw new Error('Interrupted during game startup');
      startedAt=Date.now();deadlineMs=startedAt+maxMs;
      for(const name of def.agents){
        const isLlm=name==='milktea';
        const useStdin=isLlm && scenario==='objective_replace';
        const env={...process.env,HOST:opts.host,AGENT:name,MOVER:def.mover,
          COORDINATION_ENABLED:String(def.coordination),
          ...(isLlm?{LLM_MODE:'json',LLM_PROVIDER:'ollama',LLM_DELIVERY_EVACUATION:String(def.coordination),
            LLM_MAX_RUN_MS:String(maxMs),LLM_OBJECTIVE_SOURCE:useStdin?'stdin':'cli',
            // Repeat safely verified one-parcel episodes to keep this process
            // alive until the evidence threshold or observation deadline.
            BENCHMARK_CONTINUOUS:useStdin?'false':'true',BENCHMARK_DEADLINE_MS:String(deadlineMs),
            COURSE_MCP_URL:'',
          }:{BENCHMARK_CONTINUOUS:'false'})};
        agents[name]=startProcess(process.execPath,[join(ROOT,'src',isLlm?'llm-agent.js':'index.js'),
          ...(isLlm&&!useStdin?['--objective','Deliver 1 parcel']:[])],{
          cwd:ROOT,env,logFile:join(dir,`${name}.log`),stdin:useStdin});
      }
      const llmLog=join(dir,'milktea.log');
      const early=()=>Boolean(server.state.exited||Object.values(agents).some(p=>p.state.exited));
      if(scenario==='objective_replace'){
        const channel=await waitUntil(Math.min(maxMs,30_000),signal,()=>eventAvailable(llmLog,'course_objective_channel_ready'),early);
        if(channel&&!early()){
          agents.milktea.child.stdin.write(JSON.stringify({type:'objective',id:'stage4c_first',objective:'Deliver 100 parcels'})+'\n');
          issued.goal1Sent=true;
          // Do not replace before the first objective has dispatched a *real* tool.
          const gotTool=await waitUntil(Math.max(0,Math.min(70_000,deadlineMs-Date.now()-30_000)),signal,
            ()=>eventAvailable(llmLog,'llm_tool_result'),early);
          issued.firstToolObservedBeforeReplacement=gotTool;
          if(gotTool&&!early()&&!signal.aborted&&Date.now()<deadlineMs){
            agents.milktea.child.stdin.write(JSON.stringify({type:'objective',id:'stage4c_second',objective:'Deliver 1 parcel'})+'\n');
            issued.goal2Sent=true;
          }
        }
        if(issued.goal2Sent)completedWindow=await waitUntil(Math.max(0,deadlineMs-Date.now()),signal,
          async()=>{
            const events=await eventsAt(llmLog);
            return eventCount(events,'course_objective_finished',x=>x.id==='stage4c_second')>0 ||
              eventCount(events,'course_objective_quarantined')>0;
          },early);
        else if(!signal.aborted && !early())await waitUntil(Math.max(0,deadlineMs-Date.now()),signal,async()=>false,early);
        if(!completedWindow && !signal.aborted && !early() && Date.now()>=deadlineMs)completedWindow=true;
      }else {
        completedWindow=await waitUntil(Math.max(0,deadlineMs-Date.now()),signal,async()=>{
          const logs={};for(const name of def.agents)logs[name]=await eventsAt(join(dir,`${name}.log`));
          const check=evaluateScenario(scenario,logs,{serverStopped:true,completedWindow:true});
          // Continue observing until all domain-specific evidence appears.
          return check.checks.filter(x=>!['server_shutdown_clean','no_early_agent_exit','no_early_server_exit','no_setup_error','not_interrupted','window_completed'].includes(x.id)).every(x=>x.passed);
        },early);
        if(!completedWindow && !signal.aborted && !early() && Date.now()>=deadlineMs)completedWindow=true;
      }
    }catch(error){setupError=error instanceof Error?error.message:String(error);console.error(`  Scenario setup error: ${setupError}`);}
    finally {
      finishedAt=Date.now();
      // A scenario may pass early; duration is a ceiling, not a fixed-length score trial.
      for(const proc of Object.values(agents))await stopProcess(proc);
      await stopProcess(server);
      const until=Date.now()+5_000;
      while(Date.now()<until && await isPortOpen(opts.host))await wait(120);
      serverStopped=!await isPortOpen(opts.host);
      const logs={};for(const name of def.agents)logs[name]=await eventsAt(join(dir,`${name}.log`),finishedAt);
      const earlyAgent=Object.values(agents).some(p=>p.state.endedAt!==null&&p.state.endedAt<finishedAt-250);
      const earlyServer=server?.state.endedAt!==null&&server?.state.endedAt!==undefined&&server.state.endedAt<finishedAt-250;
      const outcome=evaluateScenario(scenario,logs,{
        ...issued,agentEarlyExit:earlyAgent,serverEarlyExit:earlyServer,setupError,interrupted:signal.aborted,
        serverStopped,completedWindow});
      const result={...outcome,elapsedMs:Math.max(0,finishedAt-startedAt),startedAt:new Date(startedAt).toISOString(),
        endedAt:new Date(finishedAt).toISOString(),observationLimitMs:maxMs,setupError};
      await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');
      manifest.results.push(result);await persist();
      console.log(`  ${outcome.passed?'PASS':'FAIL'}: ${outcome.checks.filter(x=>x.passed).length}/${outcome.checks.length} checks; ${outcome.checks.filter(x=>!x.passed).map(x=>x.id).join(', ')||'all supported'}`);
      if(!serverStopped)throw new Error('Server still listening after cleanup; stop it manually');
    }
  }
  manifest.status=signal.aborted?'interrupted':manifest.results.length===opts.scenarios.length&&manifest.results.every(r=>r.passed)?'passed':'incomplete_or_failed';
  manifest.finishedAt=new Date().toISOString();await persist();
  return {output:opts.output,manifest,allPassed:manifest.status==='passed'};
}
