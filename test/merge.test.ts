import {FeishuChannel} from '../src/channels/feishu.js';
import {buildCard} from '../src/channels/cards.js';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/store.js';import {Engine} from '../src/engine.js';
import {mergeIntent,mergePullRequest,prSummary,mergeResultText} from '../src/merge.js';
import type {Config,RunHooks} from '../src/types.js';
const head='a'.repeat(40),base='b'.repeat(40),commit='c'.repeat(40),url='https://github.com/test/repo/pull/139';
function fixture(){
 const store=new Store(':memory:');const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,groupChats:true,projects:{p:{path:'.',sandbox:'workspace-write'}}};
 const task=store.create('group','p','work','workspace-write',{anchorId:'root',sourceId:'root',scope:'thread'});store.set(task.id,'review');
 let pr:any={title:'按平台显示每日新增数量和占比',body:'每根柱子按平台分段，支持查看数量与占比。\n\nValidation:\nTest data',number:139,url,state:'OPEN',isDraft:true,headRefName:'feature',headRefOid:head,baseRefName:'main',baseRefOid:base,isCrossRepository:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'',statusCheckRollup:[{name:'CI',status:'COMPLETED',conclusion:'SUCCESS'}],changedFiles:6,additions:10,deletions:2};
 const calls:string[][]=[];let answer='accept',onConfirm=()=>{},onPut=()=>{};let asks=0;
 const gh=async(_cwd:string,args:string[])=>{calls.push(args);if(args[0]==='pr'&&args[1]==='view')return JSON.stringify(pr);if(args[1]==='ready'){pr.isDraft=false;return '';}
  if(args.includes('PUT')){onPut();pr={...pr,state:'MERGED',mergeCommit:{oid:commit}};return JSON.stringify({merged:true,sha:commit});}return JSON.stringify({allow_squash_merge:true});};
 const hooks:RunHooks={thread(){},progress(){},resolved(){},request:r=>{asks++;onConfirm();queueMicrotask(()=>r.resolve(answer));return 'request';}};
 return {store,config,task,calls,hooks,gh,get pr(){return pr},get asks(){return asks},setAnswer(v:string){answer=v},confirm(f:()=>void){onConfirm=f},put(f:()=>void){onPut=f},run:()=>mergePullRequest(store,config,{...task,mergeUrl:url},config.projects.p,hooks,AbortSignal.timeout(3000),gh,async()=> 'git@github.com:test/repo.git')};
}
test('merge previews exact remote commits, needs confirmation, converts draft and uses a head-bound squash PUT',async()=>{
 const f=fixture();try{const result=await f.run();assert.match(result,/已合并到 main/);assert.equal(f.asks,1);const put=f.calls.find(a=>a.includes('PUT'))!;assert.ok(put.includes('sha='+head));assert.ok(put.includes('merge_method=squash'));assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);assert.ok(f.calls.some(a=>a[1]==='ready'));assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE kind='merge_completed'").get()!.n,1);
  await f.run();assert.equal(f.asks,1);assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
 }finally{f.store.close()}
});
test('decline, stale commits, draft changes and grant changes never merge',async()=>{
 for(const variation of ['decline','head','base','draft','grant']){const f=fixture();try{
  if(variation==='decline')f.setAnswer('decline');else f.confirm(()=>{if(variation==='grant')f.config.projects.p={...f.config.projects.p,sandbox:'read-only'};else if(variation==='draft')f.pr.isDraft=false;else f.pr[variation==='head'?'headRefOid':'baseRefOid']='d'.repeat(40)});
  if(variation==='decline')assert.match(await f.run(),/未合并/);else await assert.rejects(f.run(),/变化/);
  assert.ok(!f.calls.some(a=>a.includes('PUT')||a[1]==='ready'));
 }finally{f.store.close()}}
});
test('incomplete CI, review requirements, conflicts and unknown remote state block before confirmation',async()=>{
 for(const change of [{statusCheckRollup:[]},{statusCheckRollup:[{status:'IN_PROGRESS',conclusion:''}]},{statusCheckRollup:[{status:'COMPLETED',conclusion:'FAILURE'}]},{mergeable:'UNKNOWN'},{mergeStateStatus:'BLOCKED'},{reviewDecision:'CHANGES_REQUESTED'},{reviewDecision:'REVIEW_REQUIRED'},{isCrossRepository:true},{url:'https://github.com/other/repo/pull/139'}]){
  const f=fixture();try{Object.assign(f.pr,change);await assert.rejects(f.run());assert.equal(f.asks,0);assert.ok(!f.calls.some(a=>a.includes('PUT')));}finally{f.store.close()}
 }
});
test('merge response failure performs readback only, never retries the merge request',async()=>{
 const f=fixture();try{f.put(()=>{throw Error('network lost')});await assert.rejects(f.run(),/未确认/);assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);}finally{f.store.close()}
});
test('staging remains manual-only even when the owner requests delegated merging',async()=>{
 const f=fixture();try{f.pr.baseRefName='staging';await assert.rejects(f.run(),/人工/);assert.equal(f.asks,0);assert.ok(!f.calls.some(a=>a.includes('PUT')||a[1]==='ready'));}finally{f.store.close()}
});
test('unknown response after a completed remote merge is recovered by readback',async()=>{
 const f=fixture();try{f.put(()=>{Object.assign(f.pr,{state:'MERGED',mergeCommit:{oid:commit}});throw Error('response lost')});assert.match(await f.run(),/已合并到 main/);assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);}finally{f.store.close()}
});
test('origin mismatch, read-only scope and cancellation cannot grant merge authority',async()=>{
 const f=fixture();try{
 await assert.rejects(mergePullRequest(f.store,f.config,{...f.task,mergeUrl:url},f.config.projects.p,f.hooks,AbortSignal.timeout(3000),f.gh,async()=> 'git@github.com:other/repo.git'),/origin/);
 await assert.rejects(mergePullRequest(f.store,f.config,{...f.task,mode:'read-only',mergeUrl:url},f.config.projects.p,f.hooks,AbortSignal.timeout(3000),f.gh),/授权/);
 const abort=new AbortController();await assert.rejects(mergePullRequest(f.store,f.config,{...f.task,mergeUrl:url},f.config.projects.p,{...f.hooks,request:()=>{abort.abort(Error('cancelled'));return 'id'}},abort.signal,f.gh,async()=> 'git@github.com:test/repo.git'),/cancelled/);
 assert.ok(!f.calls.some(a=>a.includes('PUT')));
 }finally{f.store.close()}
});
test('only addressed owner merge intent enters the separate workflow; ordinary yes and references are not authorization',async()=>{
 const f=fixture();let runs=0,modelRuns=0;const engine=new Engine(f.store,f.config,{run:async()=>{modelRuns++;return 'model'}},{send:async()=>{}},async()=>{runs++;return 'preview only'});
 const send=(id:string,senderId:string,botMentioned:boolean,text:string)=>engine.receive({id,senderId,botMentioned,text,senderType:'user',chatId:'group',chatType:'group',conversation:{anchorId:'root',sourceId:id,scope:'thread'}});
 try{send('other','other',true,'合并 PR '+url);send('chatter','owner',false,'合并 PR '+url);assert.equal(f.store.get(f.task.id)!.status,'review');send('owner','owner',true,'授权给你帮我合并 '+url);
  for(let i=0;i<50&&f.store.get(f.task.id)!.status!=='review';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(runs,1);assert.equal(modelRuns,0);assert.equal(f.store.get(f.task.id)!.mergeUrl,url);send('owner','owner',true,'合并 PR '+url);assert.equal(runs,1);
  assert.equal(mergeIntent('可以'),undefined);assert.equal(mergeIntent('不要合并 PR '+url),undefined);assert.equal(mergeIntent('截图里说合并 PR '+url),undefined);
 }finally{await engine.stop();f.store.close()}
});
test('merge confirmation remains owner/chat/topic bound and single-use; restart expires it',async()=>{
 const f=fixture();let merges=0;
 const engine=new Engine(f.store,f.config,{run:async()=>{throw Error('must not run model')}},{send:async()=>{}},async(_s,_c,_t,_p,h,signal)=>{
  return new Promise<string>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});h.request({kind:'approval',description:'PR preview',resolve:answer=>{if(answer==='accept')merges++;resolve('done')}})});
 });
 const send=(id:string,text:string,senderId='owner',chatId='group',anchorId='root')=>engine.receive({id,text,senderId,chatId,senderType:'user',chatType:'group',botMentioned:true,conversation:{anchorId,sourceId:id,scope:'thread'}});
 try{
  send('start','合并 PR '+url);for(let i=0;i<50&&!f.store.requests(f.task.id).length;i++)await new Promise(r=>setTimeout(r,5));const req=f.store.requests(f.task.id)[0].id;
  send('wrong-owner','/approve '+req,'other');send('wrong-chat','/approve '+req,'owner','other');send('wrong-topic','/approve '+req,'owner','group','other');send('yes','可以');assert.equal(merges,0);
  send('ok','/approve '+req);send('duplicate','/approve '+req);assert.equal(merges,1);
  for(let i=0;i<50&&f.store.get(f.task.id)!.status!=='review';i++)await new Promise(r=>setTimeout(r,5));
  send('next','合并 PR '+url);for(let i=0;i<50&&!f.store.requests(f.task.id).length;i++)await new Promise(r=>setTimeout(r,5));const stale=f.store.requests(f.task.id)[0].id;
  await engine.stop();f.store.recover();assert.equal(f.store.getRequest(stale)?.status,'expired');assert.equal(merges,1);
 }finally{await engine.stop();f.store.close()}
});


test('merge receipt uses remote PR description, keeps commit in details and invalidates on another run', async()=>{
 const f=fixture();try {
   f.store.queueMerge(f.task.id,url);
   const text=await f.run();
   assert.match(text,/按平台显示每日新增数量和占比/);
   assert.match(text,/每根柱子按平台分段/);
   assert.doesNotMatch(text,new RegExp(commit));
   assert.doesNotMatch(text,/Test data/);
   assert.match(text,/6 个文件/);
   assert.match(text,/部署状态未核验/);
   const receipt=f.store.mergeReceipt(f.task.id)!;
   assert.equal(receipt.commit,commit);assert.equal(mergeResultText(receipt),text);
   f.store.set(f.task.id,'review',text);
   const card=JSON.stringify(buildCard(f.store,f.config,'group',{kind:'task',taskId:f.task.id}));
   assert.match(card,/PR 已合并/);assert.doesNotMatch(card,/停止|允许本次/);
   const detail=JSON.stringify(buildCard(f.store,f.config,'group',{kind:'result',taskId:f.task.id}));
   assert.ok(detail.includes(commit));
   f.store.queueMerge(f.task.id,url);assert.equal(f.store.get(f.task.id)!.result,null);assert.equal(f.store.mergeReceipt(f.task.id),undefined);
 } finally{f.store.close()}
 assert.equal(prSummary('## Summary\nFix bars.\n\n## Validation\nTests passed'),'Fix bars.');
 assert.equal(prSummary('<!-- template -->\n## 验证\n测试通过'),'');
 assert.equal(prSummary('x'.repeat(500)).length,361);
});

test('merge completion patches the existing approval card and sends a concise result',async()=>{
 for(const outcome of ['merged','declined','failed']) {
 const f=fixture();const patches:any[]=[];const replies:any[]=[];
 const channel=new FeishuChannel('fake','fake',f.store,f.config);
 (channel as any).client={im:{message:{
   reply:async(p:any)=>{replies.push(p);return {code:0,data:{message_id:'message-'+replies.length}}},
   patch:async(p:any)=>{patches.push(p);return {code:0}},
 }}};
 const engine=new Engine(f.store,f.config,{run:async()=>{throw Error('no model')}},channel,
   (s,c,t,p,h,signal)=>mergePullRequest(s,c,t,p,h,signal,f.gh,async()=> 'git@github.com:test/repo.git'));
 const send=(id:string,text:string)=>engine.receive({id,text,senderId:'owner',senderType:'user',chatType:'group',chatId:'group',botMentioned:true,conversation:{anchorId:'root',sourceId:id,scope:'thread'}});
 const until=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn()){await engine.flush();return;}await new Promise(r=>setTimeout(r,5))}assert.fail('timeout')};
 try {
   f.store.set(f.task.id,'review','旧回复：不能合并');
   send('merge','合并 PR '+url);
   await until(()=>f.store.requests(f.task.id).length>0);
   const approval=replies.find(p=>p.data.msg_type==='interactive');assert.ok(approval);
   const request=f.store.requests(f.task.id)[0];
   if(outcome==='failed') f.pr.headRefOid='d'.repeat(40);
   send('answer',`${outcome==='declined'?'/deny':'/approve'} ${request.id}`);
   await until(()=>['review','failed'].includes(f.store.get(f.task.id)!.status));
   const latest=JSON.parse(patches.at(-1).data.content);
   const rendered=JSON.stringify(latest);
   assert.equal(patches.at(-1).path.message_id,'message-'+(replies.indexOf(approval)+1));
   assert.doesNotMatch(rendered,/旧回复|正在处理合并|允许本次/);
   assert.equal(rendered.includes('PR 已合并'),outcome==='merged');
   if(outcome==='merged')assert.match(rendered,/数量和占比/);
   if(outcome==='declined')assert.match(rendered,/未合并/);
   if(outcome==='failed')assert.match(rendered,/执行失败/);
 } finally {await engine.stop();channel.close();f.store.close()}
 }
});
