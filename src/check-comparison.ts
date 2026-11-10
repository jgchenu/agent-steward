import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './process.js';
import type { BaselineComparison, Check, DeliveryReport, RunHooks } from './types.js';

export interface CheckEvidence { status: 'passed' | 'failed'; exitCode: number; digest: string; failureCount: number; tests: string[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;

// Only absolute workspace prefixes and ANSI styling are normalized. Error text, stacks,
// file locations and multiplicities stay significant. Unknown/malformed reports fail closed.
export function checkEvidence(format: Check['failureFormat'], raw: string, cwd: string, code: number): CheckEvidence {
  const clean = raw.replaceAll(cwd, '<workspace>').replace(/\x1b\[[0-9;]*m/g, '');
  if (code === 0 && !format) return {status:'passed',exitCode:code,digest:hash([]),failureCount:0,tests:[]};
  if (!format) throw Error('失败检查未配置可比较的诊断格式');
  let failures: unknown[] = [], tests: string[] = [];
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
        if(suite.status==='failed')failedSuites++;
        for (const a of suite.assertionResults) {
          if(typeof a.fullName!=='string'||typeof a.status!=='string'||!Array.isArray(a.failureMessages))throw Error('Vitest 用例诊断无效');
          total++;tests.push(JSON.stringify([suite.name,a.fullName,a.status]));
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
  return {status:code===0?'passed':'failed',exitCode:code,digest:hash(failures.map(stable).map(x=>JSON.stringify(x)).sort()),failureCount:failures.length,tests:tests.sort()};
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
import { writeFileSync } from 'node:fs';
const errors = xs => xs.map(e => ({name:e?.name ?? '',message:e?.message ?? String(e),stack:e?.stack ?? '',stacks:e?.stacks ?? []}));
export default class extends JsonReporter {
  constructor(){super({});}
  async onFinished(files,unhandled,coverage){
    if(!Array.isArray(files)||!Array.isArray(unhandled))throw Error('Incomplete Vitest completion');
    this.unhandled=errors(unhandled);this.files=files;
    await super.onFinished(files,unhandled,coverage);
  }
  async writeReport(raw){
    const data=JSON.parse(raw);data.unhandledErrors=this.unhandled;
    for(const suite of data.testResults){suite.stewardErrors=errors(this.files.find(f=>f.filepath===suite.name)?.result?.errors ?? []);}
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

export async function compareBaseline(report: DeliveryReport, checks: Check[], first: Array<Awaited<ReturnType<typeof runCheck>>>,
  dir: string, hooks: RunHooks, signal: AbortSignal,
  git: (cwd:string,args:string[],signal:AbortSignal)=>Promise<string>, unchanged:()=>Promise<boolean>): Promise<BaselineComparison> {
  const result:BaselineComparison={baseSha:report.workspace.baseSha,fingerprint:report.fingerprint,validationKey:report.validationKey!,
    capturedAt:new Date().toISOString(),equivalent:false,reason:'基线对照未完成',checks:[]};
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
    for(const [i,c] of checks.entries()) {
      const evidence=rounds.map(r=>r[i]);
      if(evidence.some(e=>e.status!==evidence[0].status||e.exitCode!==evidence[0].exitCode||e.digest!==evidence[0].digest))throw Error(`「${c.name}」失败内容有差异或波动，需要继续排查，不能申请例外。`);
      // Keep multiplicity and status of every baseline test; deleting/skipping a test is not a pass.
      const baselineTests=evidence[1].tests, patchTests=evidence[0].tests;
      const contains=(base:string[],patch:string[])=>{const copy=[...patch];return base.every(t=>{const n=copy.indexOf(t);if(n<0)return false;copy.splice(n,1);return true;});};
      if(!contains(baselineTests,patchTests)||JSON.stringify(evidence[0].tests)!==JSON.stringify(evidence[2].tests)
        ||JSON.stringify(evidence[1].tests)!==JSON.stringify(evidence[3].tests))throw Error('用例缺失、跳过或结果波动，不能申请例外');
      const {status,digest,failureCount}=evidence[0];result.checks.push({name:c.name,status,digest,failureCount});
    }
    result.equivalent=true;result.reason='两轮基线与补丁检查的失败内容一致，未发现新增失败；全仓检查仍未通过。';
  } catch(e) {signal.throwIfAborted();result.reason=e instanceof Error?e.message:'基线对照失败';}
  finally {
    if(added)await git(report.workspace.source,['worktree','remove','--force',baseline],AbortSignal.timeout(10000));
    else rmSync(baseline,{recursive:true,force:true});
  }
  return result;
}
