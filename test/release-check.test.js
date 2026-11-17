import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assessRelease } from '../scripts/release-check.js';

/** @template T @param {(root:string)=>T} fn @returns {T} */
const withTemp=fn=>{
  const root=mkdtempSync(join(tmpdir(),'asa-release-test-'));
  try{return fn(root)}finally{rmSync(root,{recursive:true,force:true})}
};
/** @param {string} root @param {string} path @param {string} text */
const put=(root,path,text)=>{
  mkdirSync(dirname(join(root,path)),{recursive:true});
  writeFileSync(join(root,path),text);
};

test('missing documentation and evidence must fail the release check',()=>withTemp(root=>{
  const result=assessRelease(root,{checkGit:false});
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(x=>x.includes('README.md')));
}));

test('unsafe nonblank tokens in template are rejected',()=>withTemp(root=>{
  put(root,'.env.example','TOKEN_BUBBLE=example-secret\nTOKEN_MILKTEA=\n');
  const result=assessRelease(root,{checkGit:false});
  assert.ok(result.errors.some(x=>x.includes('TOKEN_BUBBLE')));
}));

test('inconsistent ablation sample averages are rejected',()=>withTemp(root=>{
  put(root,'evidence/ablation_trials.csv','condition,observed_team_score\nC0,1\nC1,2\n');
  put(root,'evidence/ablation_statistics.json',JSON.stringify({C0_mean:99,C1_mean:99}));
  const result=assessRelease(root,{checkGit:false});
  assert.ok(result.errors.some(x=>x.includes('10 original trials')));
}));

test('fewer than four successful live validation scenarios fail evidence check',()=>withTemp(root=>{
  put(root,'evidence/local_validation_scenarios.csv','scenario,passed,checksPassed\nbdi_pddl,true,11\n');
  const result=assessRelease(root,{checkGit:false});
  assert.ok(result.errors.some(x=>x.includes('four locally passed')));
}));
