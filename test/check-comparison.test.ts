import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessFailures, probeFiles, checkEvidence, runCheck, compareBaseline } from '../src/check-comparison.js';
import type { DeliveryReport, RunHooks } from '../src/types.js';

const vitest=(message='boom')=>({numFailedTests:1,numFailedTestSuites:2,numTotalTests:1,unhandledErrors:[],testResults:[{
 name:'/repo/a.test.ts',status:'failed',message:'',assertionResults:[{fullName:'suite case',status:'failed',failureMessages:[message]}],
}]});

for (const outcome of ['matched', 'unmatched', 'cancelled'] as const) {
 test(`baseline cleanup timeout preserves ${outcome} verification outcome`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'steward-cleanup-'));
  const controller=new AbortController(),cancelled=new Error('owner cancelled');
  const check={name:'test',command:process.execPath,args:['-e',"console.error('old failure');process.exit(1)"],failureFormat:'exact' as const};
  const report:DeliveryReport={workspace:{taskId:'task',source:root,path:root,branch:'task',baseSha:'base',baseRef:'main'},
   mode:'workspace-write',capturedAt:'',files:['a.ts'],diffStat:'',fingerprint:'patch',headSha:'base',checks:[],ready:false,validationKey:'checks'};
  const hooks:RunHooks={thread(){},progress(){},request(){return '';},resolved(){}};
  let cleanupAttempts=0;
  try {
   const first=await runCheck(outcome==='unmatched'?{...check,args:['-e',"console.error('new failure');process.exit(1)"]}:check,
    root,join(root,'patched-1'),controller.signal);
   const git=async(_cwd:string,args:string[])=>{
    if(args[0]==='worktree'&&args[1]==='remove'){
     cleanupAttempts++;throw new DOMException('cleanup timed out','TimeoutError');
    }
    if(args[0]==='status'&&outcome==='cancelled'){controller.abort(cancelled);throw cancelled;}
    return '';
   };
   const pending=compareBaseline(report,[check],[first],root,hooks,controller.signal,git,async()=>true);
   if(outcome==='cancelled')await assert.rejects(pending,e=>e===cancelled);
   else {
    const result=await pending;
    assert.equal(result.eligible,outcome==='matched');
    assert.equal(result.cleanupPending,true);
    if(outcome==='matched'){
     assert.equal(result.equivalent,true);
     assert.deepEqual(result.checks[0].roundFailureCounts,[1,1,1,1]);
     assert.equal(result.checks[0].status,'failed');
    }else assert.match(result.reason,/未在未修改基线中复现/);
   }
   assert.equal(cleanupAttempts,1);
   const receipt=JSON.parse(readFileSync(join(root,'cleanup.json'),'utf8'));
   assert.equal(receipt.status,'pending');assert.ok(receipt.baseline.startsWith(join(root,'baseline-')));
   assert.equal(report.ready,false);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
}
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
   `const {default:R}=await import(process.argv[1]);await new R().onFinished([], [{name:'Error',message:'unhandled',stack:'a.ts:1',VITEST_TEST_PATH:process.argv[2]}]);process.exit(1)`,
   '{vitestReporter}',join(root,'a.test.ts')]},root,join(root,'run'),AbortSignal.timeout(5000));
  assert.equal(run.evidence?.failureCount,1);assert.equal(run.record.status,'failed');
  assert.equal(JSON.parse(run.evidence!.failures[0])[1].testFile,'<workspace>/a.test.ts');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('baseline evidence retains every failure and uses per-run multiplicity, never retry totals',()=>{
 const old=checkEvidence('vitest',JSON.stringify(vitest()),'/repo',1);
 const extra=checkEvidence('vitest',JSON.stringify({...vitest(),unhandledErrors:[{message:'warning rejection'}]}),'/repo',1);
 assert.equal(assessFailures([old,extra],[extra,old]).covered,true);
 assert.equal(assessFailures([old,extra],[extra,old]).variable,true);
 const changed=checkEvidence('vitest',JSON.stringify(vitest('new stack')),'/repo',1);
 assert.equal(assessFailures([old,changed],[old,old]).covered,false);
 assert.equal(assessFailures([old,extra],[old,old]).covered,false,'unhandled failures cannot disappear in retries');
 const doubled=checkEvidence('vitest',JSON.stringify({...vitest(),unhandledErrors:[{message:'warning rejection'},{message:'warning rejection'}]}),'/repo',1);
 assert.equal(assessFailures([doubled,doubled],[extra,extra],[extra,extra,extra]).covered,false);
 assert.equal(assessFailures([{...old,exitCode:99},old],[old,old]).unknownExit,true);
});

test('baseline exceptions preserve executed test identities and require new tests to pass',()=>{
 const old=checkEvidence('vitest',JSON.stringify(vitest()),'/repo',1);
 const add=(status:string)=>({...old,tests:[...old.tests,JSON.stringify(['<workspace>/a.test.ts','new case',status])]});
 assert.equal(assessFailures([add('passed'),add('passed')],[old,old]).variable,false);
 for(const status of ['skipped','pending','todo','failed']){
  assert.throws(()=>assessFailures([add(status),old],[old,old]),/新增用例/);
  const skipped={...old,tests:[JSON.stringify(['<workspace>/a.test.ts','suite case',status==='failed'?'skipped':status])]};
  assert.throws(()=>assessFailures([skipped,old],[old,old]),/跳过/);
 }
 assert.throws(()=>assessFailures([{...old,tests:[]},old],[old,old]),/缺失/);
 assert.throws(()=>assessFailures([old,old],[{...old,tests:[...old.tests,...old.tests]},old]),/缺失/);
});

test('targeted baseline files cannot escape the worktree or inject CLI arguments',()=>{
 const root=mkdtempSync(join(tmpdir(),'steward-probe-paths-'));
 try{
  const baseline=join(root,'repo');mkdirSync(baseline);writeFileSync(join(baseline,'a.test.ts'),'');
  writeFileSync(join(root,'outside.test.ts'),'');
  symlinkSync(root,join(baseline,'linked'));symlinkSync(join(root,'outside.test.ts'),join(baseline,'link.test.ts'));
  const names=['a.test.ts','../outside.test.ts','linked/outside.test.ts','link.test.ts','--config.test.ts','missing.test.ts','a.ts','a.test.ts\n--help'];
  assert.deepEqual(probeFiles(names.map(n=>JSON.stringify(['<workspace>/'+n,'case',['error']])),baseline),['a.test.ts']);
  assert.deepEqual(probeFiles(names.map(n=>JSON.stringify(['unhandled',{testFile:'<workspace>/'+n,message:'timer'}])),baseline),['a.test.ts']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('dynamic passing names require observed baseline variation and unchanged source, positions and outcomes',()=>{
 const passing=(name:string,hash='a'.repeat(64))=>checkEvidence('vitest',JSON.stringify({numFailedTests:0,numFailedTestSuites:0,numTotalTests:1,unhandledErrors:[],testResults:[{
  name:'/repo/a.test.ts',status:'passed',stewardSourceHash:hash,assertionResults:[{fullName:name,status:'passed',failureMessages:[]}]
 }]}),'/repo',0);
 const bases=[passing('date 1'),passing('date 2')],patches=[passing('date 3'),passing('date 4')];
 assert.equal(assessFailures(patches,bases).covered,true);
 assert.equal(assessFailures(patches,bases).variable,true);
 assert.throws(()=>assessFailures([passing('date 3','b'.repeat(64)),patches[1]],bases),/缺失/);
 assert.throws(()=>assessFailures(patches,[bases[0],bases[0]]),/缺失/,'a stable baseline name cannot be arbitrarily renamed');
 const skipped={...patches[0],tests:patches[0].tests.map(t=>{const a=JSON.parse(t);a[2]='skipped';return JSON.stringify(a);})};
 assert.throws(()=>assessFailures([skipped,patches[1]],bases),/跳过/);
 assert.throws(()=>assessFailures([{...patches[0],tests:[]},patches[1]],bases),/缺失/);
 const extra=JSON.stringify(['<workspace>/a.test.ts','extra','passed','a'.repeat(64),1]);
 assert.throws(()=>assessFailures([{...patches[0],tests:[...patches[0].tests,extra]},patches[1]],bases),/缺失/);
});
