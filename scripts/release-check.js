#!/usr/bin/env node
/** Lightweight, dependency-free release safety and evidence preflight. */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REQUIRED=[
  'README.md','.gitignore','.env.example','package.json','package-lock.json',
  'src/index.js','src/llm-agent.js','src/planning/pddl/solve.js','src/coordination/controller.js',
  'docs/SETUP.md','docs/DEMO.md','docs/INDEX.md','docs/EVIDENCE.md','docs/FINAL_AUDIT.md',
  'evidence/ablation_trials.csv','evidence/ablation_statistics.json','evidence/local_validation_scenarios.csv',
  'submission/Final_Report_10_Pages.pdf','submission/Final_Presentation.pptx',
];
const UNPUBLISHABLE=/(^|\/)(\.env($|\.(?!example$))|node_modules|\.git|__MACOSX|logs|course-validation-results|ablation-results|benchmark-results|course-audit)(\/|$)/i;

/** @param {string} raw */
function parseCsv(raw) {
  // Our sanitized evidence files are comma-separated numbers/short identifiers;
  // no quoted fields. This avoids a CSV parser dependency in final preflight.
  const [header,...lines]=raw.trim().split(/\r?\n/);
  const columns=header.split(',');
  return lines.map(line=>Object.fromEntries(line.split(',').map((item,i)=>[columns[i],item])));
}

/** @param {string} root @param {{checkGit?:boolean}} [opts] */
export function assessRelease(root,{checkGit=true}={}) {
  const errors=[];const warnings=[];const checks=[];
  for(const path of REQUIRED) {
    if(!existsSync(join(root,path)))errors.push(`Required release file missing: ${path}`);
  }
  checks.push('Curated documentation, report, slides and source files checked');
  if(existsSync(join(root,'.env.example'))) {
    const template=readFileSync(join(root,'.env.example'),'utf8');
    for(const key of ['TOKEN_BUBBLE','TOKEN_MILKTEA']) {
      const found=template.match(new RegExp(`^${key}=(.*)$`,'m'));
      if(!found || found[1].trim())errors.push(`.env.example must contain a blank ${key} placeholder`);
    }
    checks.push('Agent-token placeholders are blank in .env.example');
  }
  if(existsSync(join(root,'evidence/ablation_trials.csv'))&&existsSync(join(root,'evidence/ablation_statistics.json'))) {
    const rows=parseCsv(readFileSync(join(root,'evidence/ablation_trials.csv'),'utf8'));
    const s=JSON.parse(readFileSync(join(root,'evidence/ablation_statistics.json'),'utf8'));
    /** @param {string} name */
    const by=name=>rows.filter(r=>r.condition===name);
    /** @param {number[]} values */
    const avg=values=>values.reduce((a,b)=>a+b,0)/values.length;
    if(by('C0').length!==10||by('C1').length!==10)errors.push('Expected 10 original trials in each ablation condition');
    else {
      const m0=avg(by('C0').map(r=>Number(r.observed_team_score)));
      const m1=avg(by('C1').map(r=>Number(r.observed_team_score)));
      if(Math.abs(m0-s.C0_mean)>1e-6||Math.abs(m1-s.C1_mean)>1e-6)errors.push('Ablation summary does not match per-trial data');
      for(const c of ['C0','C1']) {
        if(by(c).some(r=>!Number.isFinite(Number(r.observed_team_score))))errors.push(`Non-numeric score in ${c}`);
      }
    }
    checks.push('Ablation data reconciled against per-condition score means');
  }
  if(existsSync(join(root,'evidence/local_validation_scenarios.csv'))) {
    const rows=parseCsv(readFileSync(join(root,'evidence/local_validation_scenarios.csv'),'utf8'));
    if(rows.length!==4||rows.some(r=>r.passed!=='true')||rows.reduce((n,r)=>n+Number(r.checksPassed),0)!==60)
      errors.push('Functional evidence must contain four locally passed scenarios totaling 60 checks');
    checks.push('Local functional evidence checked (not official grader results)');
  }
  if(existsSync(join(root,'.env'))) warnings.push('A local private .env exists; that is normal for development, but NEVER include it in a submission ZIP');
  if(checkGit) {
    try {
      const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:4000}).split('\0').filter(Boolean);
      const unsafe=files.filter(path=>UNPUBLISHABLE.test(path));
      if(unsafe.length) errors.push(`${unsafe.length} generated/private file(s) still tracked in Git. Untrack without deleting local files: git rm -r --cached --ignore-unmatch course-validation-results benchmark-results ablation-results course-audit logs`);
      else checks.push('Git index excludes local logs, generated results and credential files');
    } catch {warnings.push('No usable Git index: cannot verify tracked-file hygiene in extracted ZIP');}
  }
  if(existsSync(join(root,'submission/Final_Report_10_Pages.pdf'))) {
    const prefix=readFileSync(join(root,'submission/Final_Report_10_Pages.pdf')).subarray(0,5).toString('ascii');
    if(prefix!=='%PDF-')errors.push('Professor report is not a PDF');
  }
  return {ok:errors.length===0,errors,warnings,checks};
}

if(process.argv[1] && resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))) {
  const result=assessRelease(ROOT);
  for(const line of result.checks)console.log(`PASS: ${line}`);
  for(const line of result.warnings)console.warn(`NOTE: ${line}`);
  for(const line of result.errors)console.error(`FAIL: ${line}`);
  console.log(result.ok?'Final release preflight: PASS':'Final release preflight: FAIL');
  if(!result.ok)process.exitCode=1;
}
