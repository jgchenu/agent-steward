import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, lstatSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { runCommand } from './process.js';
import type { BaselineComparison, Check, DeliveryReport, RunHooks } from './types.js';

export interface CheckEvidence { status: 'passed' | 'failed'; exitCode: number; digest: string; failureCount: number; tests: string[]; testFiles: string[]; failures: string[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;

// Only absolute workspace prefixes and ANSI styling are normalized. Error text, stacks,
// file locations and multiplicities stay significant. Unknown/malformed reports fail closed.
export function checkEvidence(format: Check['failureFormat'], raw: string, cwd: string, code: number): CheckEvidence {
  // macOS tools can report /private/var while the worktree was created under /var.
  const prefixes=new Set([cwd]);try{prefixes.add(realpathSync(cwd));}catch{/* Synthetic reports may use a nonexistent root. */}
  let clean=raw;
  for(const prefix of [...prefixes].sort((a,b)=>b.length-a.length))clean=clean.replaceAll(prefix,'<workspace>');
  clean=clean.replace(/\x1b\[[0-9;]*m/g, '');
  if (code === 0 && !format) return {status:'passed',exitCode:code,digest:hash([]),failureCount:0,tests:[],testFiles:[],failures:[]};
  if (!format) throw Error('失败检查未配置可比较的诊断格式');
  let failures: unknown[] = [], tests: string[] = [], testFiles: string[] = [];
  if (format === 'exact') {
    if (code && !clean.trim()) throw Error('失败检查没有诊断输出');
    failures = code ? [clean] : [];
  } else {
    const data=JSON.parse(format==='biome' && clean.startsWith('check ') ? clean.slice(6) : clean);
    if (format === 'vitest') {
      if (!Array.isArray(data.testResults) || !Number.isInteger(data.numFailedTests) || !Number.isInteger(data.numFailedTestSuites)
        || !Number.isInteger(data.numTotalTests) || !Array.isArray(data.unhandledErrors)) throw Error('Vitest 诊断不完整');
      let failed=0,total=0,failedSuites=0;
      for (const suite of data.testResults) {
        if (typeof suite.name!=='string'||!Array.isArray(suite.assertionResults)||typeof suite.status!=='string') throw Error('Vitest 文件诊断无效');
        testFiles.push(suite.name);if(suite.status==='failed')failedSuites++;
        const sourceHash=suite.stewardSourceHash;
        if(sourceHash!==undefined && (typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(sourceHash)))throw Error('Vitest 源码摘要无效');
        for (const [index,a] of suite.assertionResults.entries()) {
          if(typeof a.fullName!=='string'||typeof a.status!=='string'||!Array.isArray(a.failureMessages))throw Error('Vitest 用例诊断无效');
          total++;tests.push(JSON.stringify(sourceHash ? [suite.name,a.fullName,a.status,sourceHash,index] : [suite.name,a.fullName,a.status]));
          if(a.status==='failed'){if(!a.failureMessages.length||a.failureMessages.some((m:unknown)=>typeof m!=='string'||!m))throw Error('Vitest 失败详情缺失');failed++;failures.push([suite.name,a.fullName,a.failureMessages]);}
        }
        if(suite.status==='failed')failures.push([suite.name,suite.message ?? '',suite.stewardErrors ?? []]);
      }
      if(failed!==data.numFailedTests||total!==data.numTotalTests||failedSuites>data.numFailedTestSuites)throw Error('Vitest 诊断数量不一致');
      failures.push(...data.unhandledErrors.map((e:unknown)=>['unhandled',e]));
      if((code===0)!==(failures.length===0))throw Error('Vitest 退出码与诊断不一致');
    } else {
      if (!data.summary || !Array.isArray(data.diagnostics) || data.summary.diagnosticsNotPrinted !== 0
        || !Number.isInteger(data.summary.errors) || !Number.isInteger(data.summary.warnings)) throw Error('Biome 诊断缺失或被截断');
      failures=data.diagnostics;
      const errors=failures.filter((d:any)=>d.severity==='error'||d.severity==='fatal').length;
      if(errors!==data.summary.errors || failures.filter((d:any)=>d.severity==='warning').length!==data.summary.warnings || (code===0 && errors>0) || (code!==0 && errors===0))throw Error('Biome 退出码与诊断不一致');
    }
  }
  const records=failures.map(stable).map(x=>JSON.stringify(x)).sort();
  return {status:code===0?'passed':'failed',exitCode:code,digest:hash(records),failureCount:records.length,tests:tests.sort(),testFiles,failures:records};
}

export async function runCheck(check: Check, cwd: string, dir: string, signal: AbortSignal) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  const reportPath=join(dir,'diagnostics.json'), log=join(dir,'check.log');
  const customVitest=check.failureFormat==='vitest' && check.args.some(a=>a.includes('{vitestReporter}'));
  const hasFile=customVitest || check.args.some(a=>a.includes('{report}'));
  const reporter=join(dir,'vitest-reporter.mjs');
  if(customVitest){
    const moduleUrl=pathToFileURL(createRequire(join(cwd,'package.json')).resolve('vitest/reporters')).href;
    writeFileSync(reporter,`import { JsonReporter } from ${JSON.stringify(moduleUrl)};
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const errors = xs => xs.map(e => ({name:e?.name ?? '',message:e?.message ?? String(e),stack:e?.stack ?? '',stacks:e?.stacks ?? [],...(typeof e?.VITEST_TEST_PATH==='string'?{testFile:e.VITEST_TEST_PATH}:{})}));
export default class extends JsonReporter {
  constructor(){super({});}
  async onFinished(files,unhandled,coverage){
    if(!Array.isArray(files)||!Array.isArray(unhandled))throw Error('Incomplete Vitest completion');
    this.unhandled=errors(unhandled);this.files=files;
    await super.onFinished(files,unhandled,coverage);
  }
  async writeReport(raw){
    const data=JSON.parse(raw);data.unhandledErrors=this.unhandled;
    for(const suite of data.testResults){
      suite.stewardErrors=errors(this.files.find(f=>f.filepath===suite.name)?.result?.errors ?? []);
      suite.stewardSourceHash=createHash('sha256').update(readFileSync(suite.name)).digest('hex');
    }
    writeFileSync(${JSON.stringify(reportPath)},JSON.stringify(data),{mode:0o600,flag:'wx'});
  }
}`,{mode:0o600,flag:'wx'});
  }
  const run=await runCommand(check.command,check.args.map(a=>a.replaceAll('{report}',reportPath).replaceAll('{vitestReporter}',reporter)),cwd,signal,
    {check:true,log,timeoutSeconds:check.timeoutSeconds??300});
  let evidence: CheckEvidence | undefined, reason: string | undefined;
  try {
    if(run.truncated || run.terminated)throw Error('检查输出被截断或进程异常终止');
    let raw=check.failureFormat==='exact' ? readFileSync(log,'utf8') : run.stdout;
    if(hasFile){const stat=lstatSync(reportPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('诊断文件无效或过大');raw=readFileSync(reportPath,'utf8');}
    evidence=checkEvidence(check.failureFormat,raw,cwd,run.code);
  } catch { reason='诊断缺失、不完整或格式不受支持'; }
  return {record:{name:check.name,status:run.code===0?'passed' as const:'failed' as const,exitCode:run.code,log},evidence,reason};
}

// Maximum multiplicity in any one run, never the sum across retries.
const counts = (items: string[]) => {const m=new Map<string,number>();for(const x of items)m.set(x,(m.get(x)??0)+1);return m;};
const unionCounts = (runs: string[][]) => {const m=new Map<string,number>();for(const xs of runs)for(const [k,n] of counts(xs))m.set(k,Math.max(n,m.get(k)??0));return m;};
const testId = (text:string) => {const [file,name]=JSON.parse(text);return JSON.stringify([file,name]);};
const activeTest = (text:string) => ['passed','failed'].includes(JSON.parse(text)[2]);

export function assessFailures(patches: CheckEvidence[], baselines: CheckEvidence[], probes: CheckEvidence[] = []) {
  // Parameterized passing test names can contain dates/random values. Recognize only
  // positions whose names already vary in BOTH pristine full baseline runs, with the
  // exact same test source, file count and passing outcome in all four full runs.
  const all=[...baselines,...patches], positions=all.map(e=>new Map(e.tests.map(t=>{
    const [file,name,status,sourceHash,index]=JSON.parse(t);
    return [JSON.stringify([file,index]),{file,name,status,sourceHash,index}];
  }))), fileCounts=all.map(e=>counts(e.tests.map(t=>JSON.parse(t)[0])));
  const dynamic=new Set<string>();
  for(const [key,b] of positions[0]){
    const other=positions[1].get(key);
    if(!b.sourceHash || !Number.isInteger(b.index) || !other || b.name===other.name)continue;
    if(positions.every((p,i)=>{
      const t=p.get(key);
      return t?.sourceHash===b.sourceHash && t?.status==='passed' && fileCounts[i].get(b.file)===fileCounts[0].get(b.file);
    }))dynamic.add(key);
  }
  const identity=(text:string)=>{
    const [file,, ,sourceHash,index]=JSON.parse(text);
    return dynamic.has(JSON.stringify([file,index])) ? JSON.stringify([file,{sourceHash,index}]) : testId(text);
  };
  const expected=unionCounts(baselines.map(e=>e.tests.map(identity)));
  const active=unionCounts(baselines.map(e=>e.tests.filter(activeTest).map(identity)));
  for(const patch of patches){
    const ids=counts(patch.tests.map(identity)),executed=counts(patch.tests.filter(activeTest).map(identity));
    if([...expected].some(([id,n])=>(ids.get(id)??0)<n)||[...active].some(([id,n])=>(executed.get(id)??0)<n)
      ||patch.tests.some(t=>!expected.has(identity(t))&&JSON.parse(t)[2]!=='passed')) {
      throw Error('用例缺失、跳过或新增用例未通过，不能申请例外');
    }
  }
  const observed=[...baselines,...probes],baselineFailures=unionCounts(observed.map(e=>e.failures));
  const patchFailures=unionCounts(patches.map(e=>e.failures));
  const unknown=[...patchFailures].filter(([key,n])=>n>(baselineFailures.get(key)??0)).map(([key])=>key);
  const unknownExit=patches.some(p=>p.exitCode!==0&&!observed.some(b=>b.exitCode===p.exitCode));
  return {unknown,unknownExit,covered:!unknown.length&&!unknownExit,
    variable:[...patches,...baselines].some(e=>e.digest!==patches[0].digest||e.exitCode!==patches[0].exitCode
      )
      ||JSON.stringify(patches[0].tests)!==JSON.stringify(patches[1].tests)
      ||JSON.stringify(baselines[0].tests)!==JSON.stringify(baselines[1].tests)};
}

// A diagnostic may nominate only an existing, non-symlink test file in this pristine baseline.
// It cannot inject CLI options, traverse directories, or nominate arbitrary commands.
export function probeFiles(unknown: string[], baseline: string): string[] {
  const files=new Set<string>();
  for(const record of unknown){
    const item=JSON.parse(record),name=Array.isArray(item)?(item[0]==='unhandled'?item[1]?.testFile:item[0]):undefined;
    if(typeof name!=='string'||!name.startsWith('<workspace>/'))continue;
    const file=name.slice('<workspace>/'.length);
    if(!/^[a-zA-Z0-9_][^\r\n\0]*\.(test|spec)\.[cm]?[jt]sx?$/.test(file)||file.split(/[\\/]/).some(s=>s==='..'||s==='.'||s.startsWith('-')))continue;
    const path=resolve(baseline,file);
    if(relative(baseline,path).startsWith('..'))continue;
    try{if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||relative(realpathSync(baseline),realpathSync(path)).startsWith('..'))continue;}catch{continue;}
    files.add(file);
  }
  return [...files].sort();
}

export async function compareBaseline(report: DeliveryReport, checks: Check[], first: Array<Awaited<ReturnType<typeof runCheck>>>,
  dir: string, hooks: RunHooks, signal: AbortSignal,
  git: (cwd:string,args:string[],signal:AbortSignal)=>Promise<string>, unchanged:()=>Promise<boolean>): Promise<BaselineComparison> {
  const result:BaselineComparison={baseSha:report.workspace.baseSha,fingerprint:report.fingerprint,validationKey:report.validationKey!,
    capturedAt:new Date().toISOString(),equivalent:false,eligible:false,reason:'基线对照未完成',checks:[],probes:[]};
  if(first.length!==checks.length||first.some(r=>!r.evidence))return {...result,reason:'检查诊断不完整；先配置机器可读报告并重新验证，不能申请草稿例外。'};
  const baseline=mkdtempSync(join(dir,'baseline-'));
  let added=false;
  try {
    await git(report.workspace.source,['worktree','add','--detach',baseline,report.workspace.baseSha],signal);added=true;
    const rounds: CheckEvidence[][]=[first.map(r=>r.evidence!)];
    // Two baseline/patch pairs are required; a lucky rerun cannot hide a new failure.
    for(const [name,cwd] of [['baseline-1',baseline],['patched-2',report.workspace.path],['baseline-2',baseline]]) {
      const round:CheckEvidence[]=[];
      for(const [i,c] of checks.entries()) {
        hooks.progress(`正在核对原有失败：${name} · ${c.name}`);
        const run=await runCheck(c,cwd,join(dir,name,String(i)),signal);
        if(!run.evidence)throw Error('诊断不完整，不能认定失败来自原有基线');
        round.push(run.evidence);
      }
      if(await git(baseline,['status','--porcelain','--untracked-files=all'],signal))throw Error('基线检查改变了源码，不能使用该对照');
      if(!await unchanged())throw Error('补丁在检查期间发生变化，请重新验证');
      rounds.push(round);
    }
    let variable=false;
    for(const [i,c] of checks.entries()) {
      const evidence=rounds.map(r=>r[i]),patches=[evidence[0],evidence[2]],baselines=[evidence[1],evidence[3]],probes:CheckEvidence[]=[];
      let assessment=assessFailures(patches,baselines);
      const observedFiles=new Set(baselines.flatMap(b=>b.testFiles));
      const files=c.failureFormat==='vitest'?probeFiles(assessment.unknown,baseline).filter(f=>observedFiles.has('<workspace>/'+f)):[];
      if(files.length>3)throw Error(`「${c.name}」超过 3 个文件仍缺少基线证据，请拆分排查。`);
      for(const [index,file] of files.entries()){
        for(let attempt=1;attempt<=3 && !assessment.covered && probeFiles(assessment.unknown,baseline).includes(file);attempt++){
          hooks.progress(`正在补查基线：${file} · 第 ${attempt} 次`);
          const run=await runCheck({...c,args:[...c.args,file],timeoutSeconds:Math.min(c.timeoutSeconds??300,120)},baseline,
            join(dir,'probes',String(i),String(index),String(attempt)),signal);
          if(!run.evidence)throw Error(`「${c.name}」定向基线诊断不完整，不能申请例外。`);
          if(await git(baseline,['status','--porcelain','--untracked-files=all'],signal)||!await unchanged())throw Error('定向检查改变了源码，不能使用该证据');
          probes.push(run.evidence);
          result.probes.push({check:c.name,file,attempt,exitCode:run.evidence.exitCode,failureCount:run.evidence.failureCount,digest:run.evidence.digest});
          assessment=assessFailures(patches,baselines,probes);
        }
      }
      // A process-level rejection may not identify a test file. Repeat the trusted
      // full check on the pristine base rather than guessing a file from its stack.
      for(let attempt=1;c.failureFormat==='vitest' && attempt<=2
        && assessment.unknown.some(record=>JSON.parse(record)[0]==='unhandled');attempt++){
        hooks.progress(`正在补查基线：未处理异常 · 完整检查第 ${attempt} 次`);
        const run=await runCheck({...c,timeoutSeconds:Math.min(c.timeoutSeconds??300,900)},baseline,
          join(dir,'probes',String(i),'full',String(attempt)),signal);
        if(!run.evidence)throw Error(`「${c.name}」完整基线补查诊断不完整，不能申请例外。`);
        if(await git(baseline,['status','--porcelain','--untracked-files=all'],signal)||!await unchanged())throw Error('完整基线补查改变了源码，不能使用该证据');
        probes.push(run.evidence);
        result.probes.push({check:c.name,file:'(full Vitest check)',attempt,exitCode:run.evidence.exitCode,failureCount:run.evidence.failureCount,digest:run.evidence.digest});
        assessment=assessFailures(patches,baselines,probes);
      }
      if(!assessment.covered)throw Error(`「${c.name}」仍有 ${assessment.unknown.length} 条失败或未知退出码未在未修改基线中复现，不能申请例外。`);
      variable ||= assessment.variable;
      const {status,digest,failureCount}=evidence[0];
      result.checks.push({name:c.name,status,digest,failureCount,roundFailureCounts:evidence.map(e=>e.failureCount),variable:assessment.variable});
    }
    result.eligible=true;result.equivalent=!variable;
    result.reason=variable
      ? '补丁侧失败均在未修改基线中实测匹配到，但各轮存在差异或波动，不能证明失败频率未增加。全仓检查仍未通过；仅可申请本次草稿发布。'
      : '两轮基线与补丁检查的失败内容一致，未发现新增失败；全仓检查仍未通过。';
  } catch(e) {signal.throwIfAborted();result.reason=e instanceof Error?e.message:'基线对照失败';}
  finally {
    // Dependency trees can outlast the bounded cleanup budget. Cleanup must not
    // replace a completed comparison, a rejected comparison, or cancellation.
    try {
      if(added)await git(report.workspace.source,['worktree','remove','--force',baseline],AbortSignal.timeout(10000));
      else rmSync(baseline,{recursive:true,force:true});
    } catch {
      result.cleanupPending=true;
      try { writeFileSync(join(dir,'cleanup.json'),JSON.stringify({status:'pending',baseline}),{mode:0o600}); }
      catch { /* Delivery still records cleanupPending if artifact storage fails. */ }
    }
  }
  return result;
}
