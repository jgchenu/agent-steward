import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {parseDeliverySummary,draftReason,deliveryMessage} from '../src/delivery-summary.js';
import {publicationText,publicationKey} from '../src/workspace.js';
import {buildCard} from '../src/channels/cards.js';
import {FeishuChannel} from '../src/channels/feishu.js';
import {ownerPrOverview,syncOwnerPrOverviews} from '../src/pr-overview.js';
import {PublishedPrMonitor,type RemotePr} from '../src/pr-monitor.js';
import {alertSourceKey} from '../src/alert-config.js';
import {openAlertTopic,recordTopicMessage,alertTopic,syncAlertTopics} from '../src/alert-collaboration.js';
import type {Config,DeliveryReport,View} from '../src/types.js';
const summary={title:'修复广告统计初始化异常',problem:'广告脚本没有正常加载时，访问首页会报错。',change:'增加异常处理，正常加载时保持原来的统计逻辑。',validation:'五个异常场景和正常加载场景均通过。',remaining:[]};
function fixture(){
 const store=new Store(':memory:');const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,groupChats:true,
 projects:{web:{path:'.',sandbox:'workspace-write',worktree:{baseRef:'origin/main',checks:[{name:'test',command:'unused',args:[]}],github:{repository:'example/web',baseBranch:'main'}}}},
 alertSources:{web:{kind:'sentry',enabled:true,project:'web',chatId:'oc_dm',collaborationChatId:'oc_group',mode:'workspace-write',pollSeconds:60,maxTasksPerDay:10,sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_TEST_TOKEN'}}}};
 const task=store.create('oc_group','web','PRIVATE transcript and internal execution instructions','workspace-write');
 const key=alertSourceKey(config,'web')!;store.db.prepare('INSERT INTO alert_runs VALUES (?,?,?,?,?,?)').run(task.id,'web',key,'1','signature',task.createdAt);
 openAlertTopic(store,config,'web',key,'1',task,{verdict:'needs_fix',summary:summary.title,impact:'统计可能中断。',explanation:'PRIVATE cause',evidence:['PRIVATE stack']});
 const topic=alertTopic(store,String(store.db.prepare('SELECT id FROM alert_topics').get()!.id))!;recordTopicMessage(store,topic,'root','thread',true);
 const report:DeliveryReport={workspace:{taskId:task.id,source:'.',path:'.',branch:'fix/test',baseRef:'origin/main',baseSha:'a'.repeat(40)},mode:'workspace-write',files:['a.ts'],diffStat:'one file',fingerprint:'patch',headSha:'b'.repeat(40),capturedAt:'',checks:[{name:'test',status:'passed',log:'private'}],ready:true,summary};
 store.saveDelivery(task.id,report);store.set(task.id,'review');
 return {store,config,task:store.get(task.id)!,report,topic};
}
test('public title and body use bounded editorial fields, never the execution prompt',()=>{
 const f=fixture();try{
  const parsed=parseDeliverySummary(summary);assert.deepEqual(parsed,summary);
  for(const bad of [{...summary,title:'bad\ncommand'},{...summary,remaining:['https://private.example']},{...summary,extra:'instruction'}])assert.throws(()=>parseDeliverySummary(bad));
  const preview=publicationText(f.task,f.report);assert.equal(preview.title,summary.title);assert.doesNotMatch(preview.body,/PRIVATE|execution instructions/);
  assert.notEqual(publicationKey(f.task,f.config.projects.web,f.report),publicationKey(f.task,f.config.projects.web,{...f.report,summary:{...summary,remaining:['浏览器验收尚未完成']}}));
  assert.doesNotMatch(publicationText(f.task,{...f.report,summary:undefined}).title,/PRIVATE/);
 }finally{f.store.close();}
});
test('ordinary PR readiness requires independent checks, complete summary and unchanged target',()=>{
 const f=fixture();try{
  assert.equal(draftReason(f.report),undefined);
  assert.match(draftReason({...f.report,ready:false})!,/全量检查/);
  assert.match(draftReason({...f.report,summary:undefined})!,/改动说明/);
  assert.match(draftReason({...f.report,summary:{...summary,remaining:['浏览器验收未完成']}})!,/浏览器/);
  assert.match(draftReason({...f.report,targetBefore:'c'.repeat(40)})!,/目标分支/);
  const msg=deliveryMessage({...f.report,prUrl:'https://github.com/example/web/pull/1',prIsDraft:false});
  assert.match(msg,/查看PR|查看 PR/);assert.match(msg,/代码审查/);assert.doesNotMatch(msg,/private|origin\/|自动检查|累计改动|Steward:/);
 }finally{f.store.close();}
});
test('group root and owner overview update in place, deduplicate and recheck source permissions',async()=>{
 const f=fixture();const updates:any[]=[],creates:any[]=[];
 const channel=new FeishuChannel('fake','fake',f.store,f.config);
 (channel as any).client={im:{message:{update:async(p:any)=>{updates.push(p);return {code:0};},create:async(p:any)=>{creates.push(p);return {code:0,data:{message_id:'overview'}};}}}};
 try{
  syncAlertTopics(f.store,f.config);syncOwnerPrOverviews(f.store,f.config);
  const count=f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n;
  syncAlertTopics(f.store,f.config);syncOwnerPrOverviews(f.store,f.config);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,count);
  const row=f.store.db.prepare("SELECT * FROM outbox WHERE json_extract(view,'$.updateRoot')=1").get()!;
  await channel.send('oc_group',String(row.text),String(row.id),JSON.parse(String(row.view)) as View);
  assert.equal(updates[0].path.message_id,'root');assert.equal(updates[0].data.msg_type,'post');assert.doesNotMatch(updates[0].data.content,/PRIVATE|代码来源/);
  await channel.send('oc_dm','','one',{kind:'pr-overview'});await channel.send('oc_dm','','retry',{kind:'pr-overview'});
  assert.equal(creates.length,1);assert.equal(creates[0].data.msg_type,'post');assert.equal(updates.at(-1).path.message_id,'overview');
  assert.match(ownerPrOverview(f.store,f.config,'oc_dm')!,/需要你处理/);assert.equal(ownerPrOverview(f.store,f.config,'oc_group'),undefined);
  f.config.alertSources!.web.enabled=false;assert.equal(ownerPrOverview(f.store,f.config,'oc_dm'),undefined);
  await assert.rejects(channel.send('oc_group',String(row.text),'revoked',JSON.parse(String(row.view))),/授权/);
  await channel.send('oc_dm','','revoked',{kind:'pr-overview'});assert.equal(creates.length,1);
 }finally{f.store.close();}
});
test('overview excludes delegates and keeps draft reasons, PR links and merged facts separate from deployment',()=>{
 const f=fixture();try{
  f.store.saveDelivery(f.task.id,{...f.report,prUrl:'https://github.com/example/web/pull/1',prIsDraft:true,summary:{...summary,remaining:['浏览器验收未完成']}});
  assert.match(ownerPrOverview(f.store,f.config,'oc_dm')!,/浏览器验收未完成/);
  f.store.saveDelivery(f.task.id,{...f.store.delivery(f.task.id)!,remotePr:{url:'https://github.com/example/web/pull/1',state:'MERGED',isDraft:false,headRefOid:'b'.repeat(40),baseRefName:'main',mergedAt:new Date().toISOString(),checkedAt:new Date().toISOString()}});
  assert.match(ownerPrOverview(f.store,f.config,'oc_dm')!,/已合并；上线效果未确认/);
  f.store.db.prepare('UPDATE tasks SET requesterId=? WHERE id=?').run('delegate',f.task.id);assert.equal(ownerPrOverview(f.store,f.config,'oc_dm'),undefined);
 }finally{f.store.close();}
});
test('remote PR reconciliation reads state without changing approvals or task status; races and wrong identity fail closed',async()=>{
 const f=fixture();let now=1000,calls=0,answer:RemotePr={url:'https://github.com/example/web/pull/1',state:'OPEN',isDraft:false,headRefOid:'b'.repeat(40),baseRefName:'main',mergedAt:null};
 f.store.saveDelivery(f.task.id,{...f.report,prUrl:answer.url,publishedSha:'b'.repeat(40),authorizedKey:'untouched'});
 const monitor=new PublishedPrMonitor(f.store,f.config,async()=>{calls++;return answer;},()=>now);
 try{
  await monitor.tick();assert.equal(f.store.delivery(f.task.id)!.prIsDraft,false);assert.equal(f.store.delivery(f.task.id)!.authorizedKey,'untouched');assert.equal(f.store.get(f.task.id)!.status,'review');
  await monitor.tick();assert.equal(calls,1);
  now+=120000;answer={...answer,url:'https://github.com/other/private/pull/1'};await monitor.tick();assert.equal(f.store.delivery(f.task.id)!.remotePr!.url,'https://github.com/example/web/pull/1');
  now+=120000;answer={...answer,url:'https://github.com/example/web/pull/1',state:'MERGED',mergedAt:new Date().toISOString()};await monitor.tick();assert.equal(f.store.delivery(f.task.id)!.remotePr!.state,'MERGED');
  assert.equal(f.store.mergeReceipt(f.task.id),undefined,'readback never forges an approved merge receipt');
 }finally{await monitor.stop();f.store.close();}
});
test('publication receipts never recreate buttons and do not report an old PR as a successful update',()=>{
 const f=fixture();try{
  f.store.saveDelivery(f.task.id,{...f.report,prUrl:'https://github.com/example/web/pull/1'});f.store.queuePublication(f.task.id);
  const card=()=>JSON.stringify(buildCard(f.store,f.config,'oc_group',{kind:'publication-receipt',taskId:f.task.id}));
  assert.match(card(),/已收到发布授权/);assert.doesNotMatch(card(),/actionId|PR 已提交/);
  f.store.set(f.task.id,'failed');assert.match(card(),/发布未完成/);assert.doesNotMatch(card(),/actionId/);
  f.store.set(f.task.id,'review');assert.match(card(),/PR 已提交/);assert.doesNotMatch(card(),/actionId/);
 }finally{f.store.close();}
});

test('late remote results cannot overwrite a resumed task, changed project grant or revoked alert source',async()=>{
 for(const change of ['resume','project','source'] as const){
  const f=fixture();const url='https://github.com/example/web/pull/1';
  f.store.saveDelivery(f.task.id,{...f.report,prUrl:url,publishedSha:'b'.repeat(40)});
  const monitor=new PublishedPrMonitor(f.store,f.config,async()=>{
   if(change==='resume')f.store.resume(f.task.id,'new requirements');
   if(change==='project')f.config.projects.web.path='/changed';
   if(change==='source')f.config.alertSources!.web.enabled=false;
   return {url,state:'MERGED',isDraft:false,headRefOid:'b'.repeat(40),baseRefName:'main',mergedAt:new Date().toISOString()};
  });
  try{await monitor.tick();assert.equal(f.store.delivery(f.task.id)!.remotePr,undefined);assert.equal(f.store.mergeReceipt(f.task.id),undefined);}
  finally{await monitor.stop();f.store.close();}
 }
});
