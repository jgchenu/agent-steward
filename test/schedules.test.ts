import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CONVERSATION } from '../src/conversation.js';
import { alertSourceKey } from '../src/alert-config.js';
import { applySchedule, schedules, nextOccurrence, parseSchedule, runDueSchedule, scheduledDeliveryDestination, reportDelivered, type ScheduleProposal } from '../src/schedules.js';
import { sentryDailyReport } from '../src/sentry-daily.js';
import { activityReport } from '../src/activity-report.js';
import type { Config } from '../src/types.js';
const now=Date.parse('2026-11-16T02:00:00Z');
const proposal:ScheduleProposal={action:'create',id:'',sourceId:'example',destination:'group',frequency:'weekly',weekday:5,hour:18,minute:0,timezone:'Asia/Shanghai'};
function fixture(path=':memory:'){
  const store=new Store(path),config:Config={ownerId:'owner',stateDir:tmpdir(),codexCommand:'unused',maxRunMinutes:1,groupChats:true,langGraphPilot:false,projects:{app:{path:tmpdir(),sandbox:'read-only',worktree:{baseRef:'origin/main',checks:[],github:{repository:'example/app',baseBranch:'main'}}}},alertSources:{example:{kind:'sentry',enabled:true,project:'app',chatId:'oc_private',collaborationChatId:'oc_team',mode:'read-only',pollSeconds:300,maxTasksPerDay:5,sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_EXAMPLE_TOKEN'}}}};
  const task=store.create('oc_private',CONVERSATION,'每周五发研发群','read-only');
  return {store,config,task};
}
test('recurrence uses chosen timezone; skips DST gap and duplicate local date',()=>{
  assert.equal(new Date(nextOccurrence(now,proposal)).toISOString(),'2026-11-20T10:00:00.000Z');
  const cadence={...proposal,frequency:'daily' as const,hour:2,minute:30,timezone:'America/New_York'};
  assert.equal(new Date(nextOccurrence(Date.parse('2026-03-08T05:00:00Z'),cadence)).toISOString(),'2026-03-09T06:30:00.000Z');
  assert.equal(new Date(nextOccurrence(Date.parse('2026-11-01T05:30:00Z'),{...cadence,hour:1},'2026-11-01')).toISOString(),'2026-11-02T06:30:00.000Z');
  assert.throws(()=>parseSchedule({...proposal,timezone:'Mars/Space'}));assert.throws(()=>parseSchedule({...proposal,hour:24}));
});
test('owner setup is idempotent; delegates cannot manage, destination is controller-bound',()=>{
  const {store,config,task}=fixture();try{
    const text=applySchedule(store,config,task,proposal,now);assert.match(text,/研发群/);assert.equal(applySchedule(store,config,task,proposal,now),text);assert.equal(schedules(store).length,1);
    assert.equal(schedules(store)[0].chatId,'oc_team');assert.throws(()=>applySchedule(store,config,{...task,requesterId:'other'},proposal,now));
    assert.throws(()=>applySchedule(store,config,{...task,id:'new'},proposal,now),/已有/);
    assert.throws(()=>applySchedule(store,config,{...task,id:'new'},{...proposal,sourceId:'unknown'},now));
  }finally{store.close();}
});
test('one durable outbox across restarts; cutoff advances only after delivery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-schedule-'));const {store,config,task}=fixture(join(dir,'state.sqlite'));let reopened:Store|undefined;
  try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0],due=s.nextDue;
    let calls=0;const providers={alert_activity:async()=>{calls++;return '本周修复 1 个问题';}};
    await runDueSchedule(store,config,providers,new AbortController().signal,due);const first=store.outgoing()!;assert.equal(first.chatId,'oc_team');assert.equal(schedules(store)[0].cursor,Date.parse('2026-11-15T16:00:00Z'));store.close();
    reopened=new Store(join(dir,'state.sqlite'));await runDueSchedule(reopened,config,providers,new AbortController().signal,due+60000);assert.equal(calls,1);assert.equal(reopened.outgoing()!.id,first.id);
    const runId=JSON.parse(first.view!).runId;assert.ok(scheduledDeliveryDestination(reopened,config,runId,'oc_team'));assert.equal(scheduledDeliveryDestination(reopened,config,runId,'oc_other'),undefined);
    reopened.transaction(()=>{reopened!.delivered(first.id);reportDelivered(reopened!,runId,due);});assert.equal(schedules(reopened)[0].cursor,due);assert.equal(schedules(reopened)[0].nextDue,due+7*86400000);
    await runDueSchedule(reopened,config,providers,new AbortController().signal,due+60000);assert.equal(calls,1);
  }finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}
});
test('pause retires pending sends; revocation and changed destination prevent publication',async()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0];await runDueSchedule(store,config,{alert_activity:async()=> 'report'},new AbortController().signal,s.nextDue);
    const out=store.outgoing()!,runId=JSON.parse(out.view!).runId;config.alertSources!.example.collaborationChatId='oc_else';assert.equal(scheduledDeliveryDestination(store,config,runId,'oc_team'),undefined);config.alertSources!.example.collaborationChatId='oc_team';
    applySchedule(store,config,{...task,id:'pause'},{...proposal,action:'pause',id:s.id},now);assert.equal(store.outgoing(),undefined);assert.equal(schedules(store)[0].state,'paused');
    applySchedule(store,config,{...task,id:'resume'},{...proposal,action:'resume',id:s.id},now);assert.equal(schedules(store)[0].state,'active');
    config.alertSources!.example.enabled=false;let calls=0;await runDueSchedule(store,config,{alert_activity:async()=>{calls++;return ''; }},new AbortController().signal,s.nextDue);assert.equal(calls,0);
  }finally{store.close();}
});
test('provider failure retries without advancing window; revisions discard stale generation',async()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0];let calls=0;
    const failed={alert_activity:async()=>{calls++;throw Error('offline');}};
    await runDueSchedule(store,config,failed,new AbortController().signal,s.nextDue);await runDueSchedule(store,config,failed,new AbortController().signal,s.nextDue+1);assert.equal(calls,1);assert.equal(schedules(store)[0].cursor,s.cursor);
    await runDueSchedule(store,config,{alert_activity:async()=>{applySchedule(store,config,{...task,id:'pause'},{...proposal,action:'pause',id:s.id},now);return 'stale';}},new AbortController().signal,s.nextDue+300001);assert.equal(store.outgoing(),undefined);
  }finally{store.close();}
});
test('report includes no-PR diagnosis, fresh merged state and unavailable state without trusting cached labels',async()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0];
    const add=(issue:string,verdict:string)=>{const t=store.create('oc_private','app','PRIVATE TRANSCRIPT MUST NOT LEAK','read-only');store.db.prepare('INSERT INTO alert_runs VALUES (?,?,?,?,?,?)').run(t.id,'example',alertSourceKey(config,'example')!,issue,'',t.createdAt);store.event(t.id,'alert_assessed',JSON.stringify({verdict,summary:issue==='1'?'浏览器扩展报错':'页面恢复显示时报错',explanation:'private evidence',impact:'待核实',evidence:['event verified']}));return t;};
    add('1','noise');const fixed=add('2','needs_fix');const unresolved=add('3','needs_fix');
    for(const [t,n]of [[fixed,10],[unresolved,11]] as const)store.saveDelivery(t.id,{workspace:{taskId:t.id,source:'/',path:'/',branch:'x',baseSha:'a',baseRef:'main'},mode:'read-only',capturedAt:new Date().toISOString(),files:['x'],diffStat:'',fingerprint:'x',headSha:'a',checks:[],ready:true,prUrl:`https://github.com/example/app/pull/${n}`,prIsDraft:true});
    let reads=0;const text=await activityReport(store,config,s,now,Date.now()+1000,new AbortController().signal,async(_repo,url)=>{reads++;if(url.endsWith('11'))throw Error('offline');return {url,state:'MERGED',isDraft:false,headRefOid:'a'.repeat(40),baseRefName:'main',mergedAt:new Date().toISOString()};});
    assert.equal(reads,2);assert.match(text,/3 个问题/);assert.match(text,/外部噪音/);assert.match(text,/已合并/);assert.match(text,/状态暂未核实/);assert.doesNotMatch(text,/PRIVATE TRANSCRIPT|private evidence/);
  }finally{store.close();}
});
test('normal owner conversation commits proposal and sends factual receipt; duplicate message does not create another schedule',async()=>{
  const {store,config,task:setup}=fixture();store.set(setup.id,'completed');let calls=0;const sent:string[]=[];
  const engine=new Engine(store,config,{run:async(task,_project,hooks)=>{calls++;assert.match(task.routingContext!,/recurringReports/);hooks.proposeSchedule!(proposal);return 'not the receipt';}},{send:async(_id,text)=>{sent.push(text);}});
  try{engine.start();const message={id:'incoming-schedule',text:'每周五把处理情况发到研发群',senderId:'owner',senderType:'user',chatId:'oc_private',chatType:'p2p' as const};engine.receive(message);engine.receive(message);for(let i=0;i<100&&!sent.some(s=>s.includes('已安排'));i++)await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);assert.equal(schedules(store).length,1);assert.ok(sent.some(s=>s.includes('研发群')));assert.ok(!sent.includes('not the receipt'));}finally{await engine.stop();store.close();}
});

test('graph persists schedule proposals across recovery without invoking the executor again',async()=>{
  const {TaskOrchestrator}=await import('../src/orchestration.js');
  const dir=mkdtempSync(join(tmpdir(),'steward-schedule-graph-'));const {store,config,task}=fixture(join(dir,'state.sqlite'));const graph=new TaskOrchestrator(store);let calls=0,proposals=0;
  const input={...task,orchestrationRunId:'schedule-graph',scheduleRevision:'grant-one'};
  const hooks={thread:()=>{},progress:()=>{},resolved:()=>{},request:()=>'',proposeSchedule:()=>{proposals++;}};
  const executor={run:async(_task:unknown,_project:unknown,h:import('../src/types.js').RunHooks)=>{calls++;h.proposeSchedule!(proposal);return 'proposal';}};
  try{await graph.run(input,config.projects.app,executor,hooks,new AbortController().signal);await graph.run(input,config.projects.app,executor,hooks,new AbortController().signal);assert.equal(calls,1);assert.equal(proposals,2);
    await assert.rejects(graph.run({...input,scheduleRevision:'changed'},config.projects.app,executor,hooks,new AbortController().signal),/旧提议不能继续/);
  }finally{graph.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('owner can cancel an arrangement after its monitoring source is removed',()=>{
  const {store,config,task}=fixture();try{applySchedule(store,config,task,proposal,now);const s=schedules(store)[0];config.alertSources={};applySchedule(store,config,{...task,id:'cancel'},{...proposal,action:'cancel',id:s.id},now);assert.equal(schedules(store)[0].state,'cancelled');}finally{store.close();}
});

test('scheduled reports are read-only group cards, with stable provider UUID and durable send receipts',async()=>{
  const {FeishuChannel}=await import('../src/channels/feishu.js');const {store,config}=fixture();
  const channel=new FeishuChannel('fake','fake',store,config);const sent:any[]=[];
  (channel as any).client={im:{message:{create:async(p:any)=>{sent.push(p);return {code:0,data:{message_id:'om_summary'}};},reply:async()=>{throw Error('must not post inside a task topic');}}}};
  try{await channel.send('oc_team','本周处理 2 个问题。','delivery-one',{kind:'scheduled-report',runId:'run-one'});await channel.send('oc_team','本周处理 2 个问题。','delivery-one',{kind:'scheduled-report',runId:'run-one'});assert.equal(sent.length,1);assert.equal(sent[0].data.receive_id,'oc_team');assert.equal(sent[0].data.msg_type,'interactive');assert.ok(sent[0].data.uuid);assert.match(sent[0].data.content,/本周处理/);}finally{store.close();}
});

test('editing a paused schedule keeps it paused; overlapping schedules cannot be introduced by update',()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0];
    applySchedule(store,config,{...task,id:'pause-edit'},{...proposal,action:'pause',id:s.id},now);
    applySchedule(store,config,{...task,id:'edit'},{...proposal,action:'update',id:s.id,hour:17},now);
    assert.equal(schedules(store)[0].state,'paused');assert.equal(schedules(store)[0].hour,17);
    applySchedule(store,config,{...task,id:'dm'},{...proposal,destination:'private'},now);
    assert.throws(()=>applySchedule(store,config,{...task,id:'duplicate'},{...proposal,action:'update',id:s.id,destination:'private'},now),/已有/);
  }finally{store.close();}
});

test('late startup combines missed periods; a revoked pending delivery is retired and paused',async()=>{
  const {retireScheduledReport}=await import('../src/schedules.js');
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0],late=s.nextDue+14*86400000;let window:number[]=[];
    await runDueSchedule(store,config,{alert_activity:async(_s,start,end)=>{window=[start,end];return 'catchup';}},new AbortController().signal,late);assert.deepEqual(window,[s.cursor,late]);
    const out=store.outgoing()!,runId=JSON.parse(out.view!).runId;config.groupChats=false;assert.equal(scheduledDeliveryDestination(store,config,runId,'oc_team'),undefined);
    store.transaction(()=>{store.retireOutgoing(out.id);retireScheduledReport(store,runId);});assert.equal(schedules(store)[0].state,'paused');assert.equal(schedules(store)[0].cursor,s.cursor);assert.equal(store.outgoing(),undefined);
  }finally{store.close();}
});


test('an observed issue without a confirmed noise rule is never called browser-extension noise',async()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,proposal,now);const s=schedules(store)[0];
    store.db.prepare('INSERT INTO alert_observations(sourceKey,issueId,latest,handledAt) VALUES (?,?,?,?)').run(s.sourceKey,'9',JSON.stringify({issueId:'9',title:'页面请求失败',exception:[]}),now+1000);
    const text=await activityReport(store,config,s,now,now+2000,new AbortController().signal,async()=>{throw Error('no PR expected');});
    assert.match(text,/正在核查/);assert.doesNotMatch(text,/已确认是浏览器扩展噪音/);
  }finally{store.close();}
});

test('Sentry daily keeps private destination, fixed yesterday window and provider across pause/resume',async()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,{...proposal,provider:'sentry_daily',frequency:'daily',hour:10,minute:0,destination:'private'},now-60000);
    const s=schedules(store)[0];assert.equal(s.provider,'sentry_daily');assert.equal(s.chatId,'oc_private');
    let calls=0;await runDueSchedule(store,config,{sentry_daily:async(_s,start,end)=>{calls++;assert.equal(new Date(start).toISOString(),'2026-11-14T16:00:00.000Z');assert.equal(new Date(end).toISOString(),'2026-11-15T16:00:00.000Z');return {text:'昨日汇总'};}},new AbortController().signal,now);
    assert.equal(calls,1);const out=store.outgoing()!;assert.equal(out.chatId,'oc_private');
    applySchedule(store,config,{...task,id:'pause-daily'},{...proposal,action:'pause',id:s.id},now);assert.equal(store.outgoing(),undefined);assert.equal(schedules(store)[0].provider,'sentry_daily');
    applySchedule(store,config,{...task,id:'resume-daily'},{...proposal,action:'resume',id:s.id},now);assert.equal(schedules(store)[0].provider,'sentry_daily');assert.equal(schedules(store)[0].nextDue,now+86400000);
  }finally{store.close();}
});

test('Sentry daily includes unhandled errors and refreshes PR status without claiming deployment',async()=>{
  const {store,config,task}=fixture();try{
    applySchedule(store,config,task,{...proposal,provider:'sentry_daily',frequency:'daily',destination:'private'},now);
    const s=schedules(store)[0],t=store.create('oc_private','app','secret transcript','read-only');
    store.db.prepare('INSERT INTO alert_runs VALUES (?,?,?,?,?,?)').run(t.id,'example',s.sourceKey,'1','',t.createdAt);
    store.saveDelivery(t.id,{workspace:{taskId:t.id,source:'/',path:'/',branch:'x',baseSha:'a',baseRef:'main'},mode:'read-only',capturedAt:new Date().toISOString(),files:['x'],diffStat:'',fingerprint:'x',headSha:'a',checks:[],ready:true,prUrl:'https://github.com/example/app/pull/10',prIsDraft:true});
    let pages=0,reads=0;const connector={dailyIssues:async()=>{pages++;return pages%2?[{id:'1',title:'Known',count:7,users:2,firstSeen:'2025-01-01'},{id:'2',title:'Unhandled',count:3,users:1,firstSeen:'2026-11-15T02:00:00Z'}]:[];}};
    const result=await sentryDailyReport(store,config,s,Date.parse('2026-11-14T16:00:00Z'),Date.parse('2026-11-15T16:00:00Z'),new AbortController().signal,connector,async(_repo,url)=>{reads++;return {url,state:'MERGED',isDraft:false,headRefOid:'a',baseRefName:'main',mergedAt:new Date().toISOString()};});
    assert.equal(pages,2);assert.equal(reads,1);assert.equal(result.daily!.total,10);assert.equal(result.daily!.newCount,1);assert.equal(result.daily!.findings[0].prs[0].label,'已合并');assert.equal(result.daily!.findings[1].category,'investigate');assert.doesNotMatch(JSON.stringify(result),/secret transcript/);
    const unavailable=await sentryDailyReport(store,config,s,Date.parse('2026-11-14T16:00:00Z'),Date.parse('2026-11-15T16:00:00Z'),new AbortController().signal,connector,async()=>{throw Error('offline');});assert.equal(unavailable.daily!.findings[0].prs[0].label,'状态暂未核实');
  }finally{store.close();}
});

test('report display labels do not revoke source grants',()=>{const {store,config}=fixture();try{const key=alertSourceKey(config,'example');config.alertSources!.example.reportLabel='Example 前端';assert.equal(alertSourceKey(config,'example'),key);}finally{store.close();}});

test('daily report group is independent from repair collaboration and paused weekly report',async()=>{
  const {FeishuChannel}=await import('../src/channels/feishu.js');
  const {store,config,task}=fixture();
  const channel=new FeishuChannel('fake','fake',store,config);
  const sent:Array<{receive_id:string;content:string}>= [];
  (channel as any).client={im:{message:{create:async({data}:any)=>{
    sent.push(data);return {code:0,data:{message_id:`om_daily_${sent.length}`}};
  }}}};
  const engine=new Engine(store,config,{run:async()=>{throw Error('report should not use the executor');}},channel);
  try{
    const grant=alertSourceKey(config,'example');config.alertSources!.example.reportChatId='oc_data';assert.equal(alertSourceKey(config,'example'),grant);
    applySchedule(store,config,task,proposal,now);const weekly=schedules(store)[0];
    applySchedule(store,config,{...task,id:'pause-weekly'},{...proposal,action:'pause',id:weekly.id},now);
    const daily={...proposal,provider:'sentry_daily' as const,frequency:'daily' as const,hour:10,minute:0};
    applySchedule(store,config,{...task,id:'daily-private'},{...daily,destination:'private'},now);
    applySchedule(store,config,{...task,id:'daily-group'},daily,now);
    const group=schedules(store).find(s=>s.provider==='sentry_daily'&&s.destination==='group')!;
    assert.equal(group.chatId,'oc_data');assert.ok(scheduledGroup());
    function scheduledGroup(){return schedules(store).find(s=>s.id===weekly.id)!.state==='paused'&&config.alertSources!.example.collaborationChatId==='oc_team';}
    const report={text:'日报',daily:{title:'Example',date:'2026-11-16',timezone:'Asia/Shanghai',environment:'production',
      checkedAt:'2026-11-17T02:00:00Z',total:0,previousTotal:0,issueCount:0,newCount:0,unknownFirstSeen:0,
      findings:[],allIssuesUrl:'https://example.sentry.io/issues/'}};
    const providers={sentry_daily:async()=>report};
    await runDueSchedule(store,config,providers,new AbortController().signal,group.nextDue);
    const out=store.outgoing()!;
    assert.equal(out.chatId,'oc_private');
    assert.equal(JSON.parse(out.view!).destination,undefined);
    await engine.flush();
    assert.equal(sent[0].receive_id,'oc_private');
    assert.equal(JSON.parse(sent[0].content).header.title.content,'Example Sentry 日报');
    await runDueSchedule(store,config,providers,new AbortController().signal,group.nextDue);
    const groupOut=store.outgoing()!;assert.equal(groupOut.chatId,'oc_data');const groupRun=JSON.parse(groupOut.view!).runId;assert.equal(scheduledDeliveryDestination(store,config,groupRun,'oc_data'),'group');
    config.alertSources!.example.reportChatId='oc_changed';assert.equal(scheduledDeliveryDestination(store,config,groupRun,'oc_data'),undefined);assert.equal(scheduledDeliveryDestination(store,config,groupRun,'oc_team'),undefined);
    config.alertSources!.example.reportChatId='oc_data';
    await engine.flush();
    assert.equal(sent.length,2);
    assert.equal(sent[1].receive_id,'oc_data');
    assert.equal(JSON.parse(sent[1].content).header.title.content,'Example｜Sentry 报错与修复进展');
  }finally{store.close();}
});
