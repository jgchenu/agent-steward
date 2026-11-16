import { SentryConnector, redactAlertText, sentryIssueUrl, type DailyIssue } from './sentry.js';
import { previousCalendarDay, type Schedule, type ReportResult } from './schedules.js';
import { alertBindingForTask } from './alert-provenance.js';
import { parseAlertAssessment } from './alert-assessment.js';
import { publicPr } from './alert-collaboration.js';
import { runCommand } from './process.js';
import type { InspectPr } from './pr-monitor.js';
import type { Config } from './types.js';
import type { Store } from './store.js';
export interface DailyFinding extends DailyIssue { url:string; previous:number; isNew:boolean; category:'repair'|'noise'|'expected'|'investigate'; description:string; prs:Array<{url:string;label:string}> }
export interface DailyReport { title:string; date:string; timezone:string; environment:string; checkedAt:string; total:number; previousTotal:number; issueCount:number; newCount:number; unknownFirstSeen:number; findings:DailyFinding[]; allIssuesUrl:string }
const clean=(s:string)=>redactAlertText(s,200).replace(/[\[\]<>`*_]/g,'').trim();
const inspect:InspectPr=async(repository,url,signal)=>{const r=await runCommand('gh',['pr','view',url,'--repo',repository,'--json','url,state,isDraft,headRefOid,baseRefName,mergedAt'],process.cwd(),signal,{timeoutSeconds:10});if(r.code||r.truncated)throw Error('PR unavailable');return JSON.parse(r.stdout);};
export async function sentryDailyReport(store:Store,config:Config,s:Schedule,start:number,end:number,signal:AbortSignal,connector:Pick<SentryConnector,'dailyIssues'>=new SentryConnector(),read:InspectPr=inspect):Promise<ReportResult>{
  const source=config.alertSources![s.sourceId],prior=previousCalendarDay(start,s.timezone);
  const current=await connector.dailyIssues(source,new Date(start).toISOString(),new Date(end).toISOString(),signal);
  const previous=await connector.dailyIssues(source,new Date(prior.start).toISOString(),new Date(prior.end).toISOString(),signal);
  const byId=new Map(current.map(i=>[i.id,i])),history=new Map(previous.map(i=>[i.id,i.count]));
  const findings=new Map<string,DailyFinding>(current.map(i=>[i.id,{...i,title:clean(i.title),url:sentryIssueUrl(source,i.id),previous:history.get(i.id)??0,isNew:!!i.firstSeen&&Date.parse(i.firstSeen)>=start&&Date.parse(i.firstSeen)<end,category:'investigate',description:'尚未完成归因，不能仅凭报错判断业务影响。',prs:[]}]));
  const assessed=new Set<string>(),cache=new Map<string,string>();
  for(const task of store.list().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
    signal.throwIfAborted();if(task.requesterId||task.requesterRevoked)continue;
    const binding=alertBindingForTask(store,task.id);if(binding?.sourceKey!==s.sourceKey||!byId.has(binding.issueId))continue;
    const f=findings.get(binding.issueId)!,delivery=store.delivery(task.id);
    if(!assessed.has(f.id)){
      const row=store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='alert_assessed' ORDER BY seq DESC LIMIT 1").get(task.id);
      if(row){const a=parseAlertAssessment(JSON.parse(String(row.body)));f.title=clean(a.summary);f.description=`已有分析：${clean(a.explanation)}（昨日事件是否同源仍需核实）`;f.category=a.verdict==='noise'?'noise':a.verdict==='expected'?'expected':a.verdict==='needs_fix'?'repair':'investigate';assessed.add(f.id);}
      if(delivery?.summary){f.title=clean(delivery.summary.title);f.description=`已有修复：${clean(delivery.summary.change)}；昨日报错是否来自同一原因仍需核实。`;f.category='repair';assessed.add(f.id);}
    }
    const url=publicPr(config,task,delivery?.prUrl),github=config.projects[task.project]?.worktree?.github;
    if(!url||!github||f.prs.some(p=>p.url===url))continue;
    if(!cache.has(url)){
      let label='状态暂未核实';
      try{const p=await read(github.repository,url,signal);if(p.url!==url||p.baseRefName!==github.baseBranch||typeof p.isDraft!=='boolean')throw Error('PR scope mismatch');label=p.state==='MERGED'?'已合并':p.state==='CLOSED'?'已关闭未合并':p.state==='OPEN'?(p.isDraft?'待合并 · 草稿':'待合并 · 待审查'):'状态暂未核实';}catch{signal.throwIfAborted();}
      cache.set(url,label);
    }
    f.prs.push({url,label:cache.get(url)!});
  }
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:s.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(start);
  const allIssuesUrl=new URL(`/issues/`,`https://${source.sentry.organization}.sentry.io`);
  allIssuesUrl.search=new URLSearchParams({project:source.sentry.projectId,environment:source.sentry.environment,query:'issue.category:error',start:new Date(start).toISOString(),end:new Date(end).toISOString()}).toString();
  const daily:DailyReport={title:clean(source.reportLabel??config.projects[source.project]?.label??s.sourceId),date,timezone:s.timezone,environment:source.sentry.environment,checkedAt:new Date().toISOString(),total:current.reduce((n,i)=>n+i.count,0),previousTotal:previous.reduce((n,i)=>n+i.count,0),issueCount:current.length,newCount:[...findings.values()].filter(i=>i.isNew).length,unknownFirstSeen:current.filter(i=>!i.firstSeen).length,findings:[...findings.values()].sort((a,b)=>b.count-a.count),allIssuesUrl:allIssuesUrl.toString()};
  return {text:`${daily.title} · ${date} 错误与修复日报：${daily.total} 次报错，${daily.issueCount} 个问题，新增 ${daily.newCount} 个。`,daily};
}
