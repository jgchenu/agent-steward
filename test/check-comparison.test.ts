import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEvidence, runCheck } from '../src/check-comparison.js';

const vitest=(message='boom')=>({numFailedTests:1,numFailedTestSuites:2,numTotalTests:1,unhandledErrors:[],testResults:[{
 name:'/repo/a.test.ts',status:'failed',message:'',assertionResults:[{fullName:'suite case',status:'failed',failureMessages:[message]}],
}]});
test('comparison preserves failure identity, stacks, multiplicity and unhandled errors',()=>{
 const baseline=checkEvidence('vitest',JSON.stringify(vitest()),'/repo',1);
 const same=checkEvidence('vitest',JSON.stringify(vitest()).replaceAll('/repo','/other'),'/other',1);
 assert.deepEqual(baseline,same);
 assert.notEqual(baseline.digest,checkEvidence('vitest',JSON.stringify(vitest('different')),'/repo',1).digest);
 const unhandled={...vitest(),unhandledErrors:[{stack:'new rejection'}]};
 assert.notEqual(baseline.digest,checkEvidence('vitest',JSON.stringify(unhandled),'/repo',1).digest);
 const missing={...vitest()} as any;delete missing.unhandledErrors;
 assert.throws(()=>checkEvidence('vitest',JSON.stringify(missing),'/repo',1));
 assert.throws(()=>checkEvidence('vitest',JSON.stringify({...vitest(),numFailedTests:2}),'/repo',1));
 assert.throws(()=>checkEvidence('vitest',JSON.stringify(vitest()),'/repo',0));
});
test('Biome compares complete diagnostics and rejects skipped/inconsistent output',()=>{
 const d={summary:{errors:1,warnings:0,diagnosticsNotPrinted:0},diagnostics:[{severity:'error',location:{path:'/repo/file'},message:'bad'}]};
 assert.equal(checkEvidence('biome',JSON.stringify(d),'/repo',1).failureCount,1);
 assert.throws(()=>checkEvidence('biome',JSON.stringify({...d,summary:{...d.summary,diagnosticsNotPrinted:1}}),'/repo',1));
 assert.throws(()=>checkEvidence('biome',JSON.stringify({...d,summary:{...d.summary,errors:2}}),'/repo',1));
});
test('check commands capture stderr and missing reports fail closed',async()=>{
 const root=mkdtempSync(join(tmpdir(),'steward-diagnostics-'));
 try{
  const check={name:'test',command:process.execPath,args:['-e',"console.error('actual failure');process.exit(1)"],failureFormat:'exact' as const};
  const r=await runCheck(check,root,join(root,'one'),AbortSignal.timeout(5000));
  assert.equal(r.evidence?.failureCount,1);assert.match(readFileSync(r.record.log,'utf8'),/actual failure/);
  const missing=await runCheck({...check,args:['-e','process.exit(1)','{report}']},root,join(root,'two'),AbortSignal.timeout(5000));
  assert.equal(missing.evidence,undefined);
  const terminated=await runCheck({...check,args:['-e',"console.error('old failure');process.kill(process.pid,'SIGTERM')"]},root,join(root,'terminated'),AbortSignal.timeout(5000));
  assert.equal(terminated.evidence,undefined);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('generated Vitest adapter captures unhandled completion errors rather than trusting JSON totals',async()=>{
 const root=mkdtempSync(join(tmpdir(),'steward-reporter-'));
 try{
  mkdirSync(join(root,'node_modules/vitest'),{recursive:true});
  writeFileSync(join(root,'package.json'),'{}');
  writeFileSync(join(root,'node_modules/vitest/package.json'),JSON.stringify({type:'module',exports:{'./reporters':'./reporters.js'}}));
  writeFileSync(join(root,'node_modules/vitest/reporters.js'),`export class JsonReporter {async onFinished(){await this.writeReport(JSON.stringify({numFailedTests:0,numFailedTestSuites:0,numTotalTests:0,testResults:[]}));}}`);
  const run=await runCheck({name:'test',command:process.execPath,failureFormat:'vitest',args:['--input-type=module','-e',
   `const {default:R}=await import(process.argv[1]);await new R().onFinished([], [{name:'Error',message:'unhandled',stack:'a.ts:1'}]);process.exit(1)`,
   '{vitestReporter}']},root,join(root,'run'),AbortSignal.timeout(5000));
  assert.equal(run.evidence?.failureCount,1);assert.equal(run.record.status,'failed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
