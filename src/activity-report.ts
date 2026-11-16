import { alertBindingForTask } from './alert-provenance.js';
import { parseAlertAssessment, type AlertAssessment } from './alert-assessment.js';
import { publicPr } from './alert-collaboration.js';
import { noiseSignature } from './alert-triage.js';
import { redactAlertText, sentryIssueUrl, type AlertEvidence } from './sentry.js';
import { runCommand } from './process.js';
import type { InspectPr } from './pr-monitor.js';
import type { Schedule } from './schedules.js';
import type { Config, Task } from './types.js';
import type { Store } from './store.js';
const inspect:InspectPr=async(repository,url,signal)=>{const r=await runCommand('gh',['pr','view',url,'--repo',repository,'--json','url,state,isDraft,headRefOid,baseRefName,mergedAt'],process.cwd(),signal,{timeoutSeconds:10});if(r.code||r.truncated)throw Error('状态不可用');return JSON.parse(r.stdout);};
const clean=(s:string)=>redactAlertText(s,180).replace(/[\r\n\[\]<>`]/g,' ').trim().replace(/[。；;]+$/,'');
export async function activityReport(store:Store,config:Config,s:Schedule,start:number,end:number,signal:AbortSignal,read:InspectPr=inspect):Promise<string>{
  const source=config.alertSources![s.sourceId],byIssue=new Map<string,Task[]>();
  for(const task of store.list()){
    if(task.requesterId||task.requesterRevoked)continue;
    const binding=alertBindingForTask(store,task.id);
    if(binding?.sourceKey!==s.sourceKey)continue;
    const tasks=byIssue.get(binding.issueId)??[];tasks.push(task);byIssue.set(binding.issueId,tasks);
  }
  const observations=new Map<string,AlertEvidence>();
  for(const row of store.db.prepare('SELECT issueId,latest,handledAt FROM alert_observations WHERE sourceKey=? AND handledAt>=? AND handledAt<=?').all(s.sourceKey,start,end)){
    const evidence=JSON.parse(String(row.latest)) as AlertEvidence;
    observations.set(String(row.issueId),evidence);if(!byIssue.has(String(row.issueId)))byIssue.set(String(row.issueId),[]);
  }
  let total=0,noiseCount=0;
  const rows:string[]=[],counts={merged:0,pending:0,closed:0,unknown:0,noPr:0};
  for(const [issueId,tasks] of byIssue){
    signal.throwIfAborted();tasks.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    const active=tasks.some(t=>{const report=store.delivery(t.id);return [t.createdAt,t.updatedAt,report?.remotePr?.checkedAt].some(x=>x&&Date.parse(x)>=start&&Date.parse(x)<=end)||!!store.db.prepare('SELECT 1 FROM events WHERE taskId=? AND at>=? AND at<=? LIMIT 1').get(t.id,new Date(start).toISOString(),new Date(end).toISOString());});
    if(!active&&!observations.has(issueId))continue;total++;
    let assessment:AlertAssessment|undefined;
    for(const task of tasks){const row=store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='alert_assessed' ORDER BY seq DESC LIMIT 1").get(task.id);if(row){assessment=parseAlertAssessment(JSON.parse(String(row.body)));break;}}
    const reports=tasks.map(t=>({task:t,report:store.delivery(t.id)}));
    const summary=reports.find(x=>x.report?.summary)?.report?.summary;
    const title=clean(summary?.title??assessment?.summary??observations.get(issueId)?.title??`监控问题 ${issueId}`);
    const prs=new Map<string,Task>();for(const {task,report}of reports){const url=publicPr(config,task,report?.prUrl);if(url&&!prs.has(url))prs.set(url,task);}
    const status:string[]=[];
    for(const [url,task]of prs){let label='状态暂未核实';try{const p=config.projects[task.project].worktree!.github!;const remote=await read(p.repository,url,signal);if(remote.url!==url||remote.baseRefName!==p.baseBranch||!['OPEN','CLOSED','MERGED'].includes(remote.state)||typeof remote.isDraft!=='boolean')throw Error('PR 身份不符');if(remote.state==='MERGED'){label='已合并';counts.merged++;}else if(remote.state==='CLOSED'){label='已关闭未合并';counts.closed++;}else{label=remote.isDraft?'待合并（草稿）':'待合并（待审查）';counts.pending++;}}catch{signal.throwIfAborted();counts.unknown++;}status.push(`[${label}](${url})`);}
    let noise=assessment?.verdict==='noise';
    let conclusion=summary?.change?clean(summary.change):assessment?({noise:'已确认是外部噪音，无需改业务代码',expected:'属于预期业务情况，无需修复',insufficient_evidence:'证据不足，尚不能确定修复方式',needs_fix:'已确认需要修复'}[assessment.verdict]):'正在核查';
    if(!prs.size){counts.noPr++;const e=observations.get(issueId),rule=store.db.prepare('SELECT signature FROM alert_noise_rules WHERE sourceKey=? AND issueId=?').get(s.sourceKey,issueId);if(e&&typeof rule?.signature==='string'&&rule.signature===noiseSignature(e)){conclusion='已确认是浏览器扩展噪音，无需改业务代码';noise=true;}
      else if(summary)conclusion+=reports.some(x=>x.report?.checks.some(c=>c.status==='failed'))?'；验证未通过，暂未提交 PR':'；修复已准备，尚未提交 PR';
      else if(!assessment)conclusion=tasks.some(t=>t.status==='waiting_approval')?'等待主人确认，尚未提交 PR':tasks[0]?.status==='failed'?'处理未完成，尚未提交 PR':tasks[0]?.status==='cancelled'?'任务已取消，未提交 PR':'正在核查，暂无 PR';else if(assessment.verdict==='needs_fix')conclusion+='，正在处理，暂无 PR';
    }
    if(noise&&!prs.size&&s.destination==='group'){noiseCount++;continue;}
    rows.push(`- [${title}](${sentryIssueUrl(source,issueId)})：${conclusion}${status.length?'；'+status.join('、'):''}。`);
  }
  const fmt=(t:number)=>new Intl.DateTimeFormat('zh-CN',{timeZone:s.timezone,dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(t);
  return [`${config.projects[source.project]?.label??source.project} · ${s.frequency==='weekly'?'处理周报':'处理日报'}`,`${fmt(start)} — ${fmt(end)}（${s.timezone}）`,
    `本期跟进 ${total} 个问题；PR：已合并 ${counts.merged}，待合并 ${counts.pending}，已关闭未合并 ${counts.closed}${counts.unknown?`，状态暂未核实 ${counts.unknown}`:''}；${counts.noPr} 个问题未提交 PR。`,
    rows.join('\n')||(total?'本期没有需要逐项跟进的业务问题。':'本期没有新的处理记录。'),...(noiseCount?[`另有 ${noiseCount} 个已确认的外部噪音问题，无需改业务代码；群内不逐项推送。`]:[]),'PR 状态在本次汇总时查询；已合并不代表已上线。'].join('\n\n');
}
