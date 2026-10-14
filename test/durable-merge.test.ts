import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { mergePullRequest } from '../src/merge.js';
import { currentOperation, operationAttempt, draftReady, decideOperation } from '../src/operations.js';
import { buildCard } from '../src/channels/cards.js';
import { parseCardAction } from '../src/channels/feishu.js';
import type { Config, Incoming, CardAction, Executor } from '../src/types.js';

const head='a'.repeat(40),base='b'.repeat(40),commit='c'.repeat(40),url='https://github.com/test/repo/pull/12';
async function until(fn:()=>boolean){for(let i=0;i<200;i++){if(fn())return;await setTimeout(5);}assert.fail('condition not reached');}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'steward-durable-merge-')),db=join(dir,'state.db');
  let store=new Store(db),engine:Engine,seq=0,executions=0,putMode:'ok'|'lost'|'unknown'='ok';
  const config:Config={ownerId:'owner',stateDir:dir,codexCommand:'unused',maxRunMinutes:1,groupChats:true,projects:{p:{path:dir,sandbox:'workspace-write'}}};
  const conversation={anchorId:'root',sourceId:'root',scope:'thread' as const};
  const task=store.create('group','p','work','workspace-write',conversation);store.set(task.id,'review');
  const pr={number:12,url,title:'Feature',body:'Change behavior',state:'OPEN',isDraft:true,headRefName:'feature',headRefOid:head,
    baseRefName:'main',baseRefOid:base,isCrossRepository:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'',
    statusCheckRollup:[{name:'CI',status:'COMPLETED',conclusion:'SUCCESS'}],changedFiles:2,additions:4,deletions:1,mergeCommit:null as {oid:string}|null};
  const calls:string[][]=[];let onRead=()=>{};
  const gh=async(_cwd:string,args:string[])=>{
    calls.push(args);
    if(args[0]==='pr'&&args[1]==='view'){onRead();return JSON.stringify(pr);}
    if(args[1]==='ready'){pr.isDraft=false;return '';}
    if(args.includes('PUT')){
      if(putMode==='unknown')throw Error('network lost');
      pr.state='MERGED';pr.mergeCommit={oid:commit};
      if(putMode==='lost')throw Error('response lost');
      return JSON.stringify({merged:true,sha:commit});
    }
    return JSON.stringify({allow_squash_merge:true});
  };
  let executor:Executor={run:async()=>{executions++;return 'independent work done';}};
  const make=()=>new Engine(store,config,{run:(...args)=>executor.run(...args)},{send:async()=>{},context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]})},
    (s,c,t,p,h,signal)=>mergePullRequest(s,c,t,p,h,signal,gh,async()=> 'git@github.com:test/repo.git'));
  engine=make();
  const send=(text:string,extra:Partial<Incoming>={})=>engine.receive({id:'event-'+ ++seq,text,senderId:'owner',senderType:'user',chatId:'group',chatType:'group',botMentioned:true,conversation,...extra});
  return {
    config,task,pr,calls,send,get store(){return store;},get engine(){return engine;},get executions(){return executions;},
    get op(){return currentOperation(store,task.id)!;},get effects(){return calls.filter(a=>a.includes('PUT')||a[1]==='ready');},
    setPutMode(mode:typeof putMode){putMode=mode;},onRead(callback:()=>void){onRead=callback;},setExecutor(next:Executor){executor=next;},
    async preview(){send('合并 PR '+url);await until(()=>store.get(task.id)?.status==='waiting_approval'&&!engine.permissionState().active);return currentOperation(store,task.id)!;},
    async restart(){await engine.stop();store.close();store=new Store(db);engine=make();engine.start();},
    async close(){await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});},
  };
}
function approvalCard(store:Store,config:Config,taskId:string):CardAction {
  // Render the real card, then feed its opaque button through the Feishu parser.
  const card=buildCard(store,config,'group',{kind:'task',taskId});
  function find(value:any):string|undefined {
    if(!value||typeof value!=='object')return;
    const id=value.value?.actionId??value.name;
    if(typeof id==='string'&&store.getAction(id)?.intent.op==='approve')return id;
    for(const child of Object.values(value)){const found=find(child);if(found)return found;}
  }
  const actionId=find(card);assert.ok(actionId,'rendered approval button');
  return parseCardAction({event_id:'click-'+actionId,host:'im_message',operator:{open_id:'owner'},
    context:{open_chat_id:'group',open_message_id:'approval-message'},action:{tag:'button',value:{actionId}}})!;
}

test('durable merge releases the single slot and its original Feishu card survives DB reopen',async()=>{
  const f=fixture();try{
    const op=await f.preview(), revision=f.store.get(f.task.id)!.updatedAt;
    const action=approvalCard(f.store,f.config,f.task.id);
    f.send('/new p unrelated',{conversation:{anchorId:'other',sourceId:'other',scope:'thread'}});
    await until(()=>f.store.list().some(t=>t.id!==f.task.id&&t.status==='review'));
    assert.equal(f.executions,1);assert.equal(f.effects.length,0);
    await f.restart();assert.equal(f.op.id,op.id);assert.equal(f.store.get(f.task.id)!.updatedAt,revision);
    assert.equal(f.store.getRequest(op.requestId)?.status,'pending');
    assert.equal(f.engine.handleAction({...action,senderId:'other'}).toast.type,'error');
    assert.equal(f.engine.handleAction({...action,chatId:'other'}).toast.type,'error');
    f.send('/approve '+op.requestId,{conversation:{anchorId:'other',sourceId:'other',scope:'thread'}});
    f.send('/approve '+op.requestId,{conversation:undefined});
    f.send('可以');assert.equal(f.op.state,'pending');assert.equal(f.effects.length,0);
    assert.equal(f.engine.handleAction(action).toast.type,'success');
    assert.equal(f.engine.handleAction({...action,id:'duplicate-click'}).toast.type,'error');
    await until(()=>f.store.get(f.task.id)?.status==='review');
    assert.equal(f.op.state,'succeeded');assert.equal(f.op.actorId,'owner');
    assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);assert.equal(f.calls.filter(a=>a[1]==='ready').length,1);
    await f.restart();f.send('/approve '+op.requestId);assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
  }finally{await f.close();}
});

test('approved queued merge survives restart and rechecks before any mutation',async()=>{
  const f=fixture();try{
    const op=await f.preview();
    // A crash after the atomic inbox decision, before the scheduler starts it.
    f.store.transaction(()=>decideOperation(f.store,op,'owner',true));
    await f.restart();await until(()=>f.op.state==='succeeded');
    assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
  }finally{await f.close();}
});

test('changed approval scope and regressed remote conditions never authorize a durable merge',async()=>{
  for(const variation of ['head','base','head-branch','base-branch','draft','ci','review','grant','owner','expired']){
    const f=fixture();try{
      const op=await f.preview();f.store.transaction(()=>decideOperation(f.store,op,'owner',true));
      if(variation==='head')f.pr.headRefOid='d'.repeat(40);
      if(variation==='base')f.pr.baseRefOid='d'.repeat(40);
      if(variation==='head-branch')f.pr.headRefName='other';
      if(variation==='base-branch')f.pr.baseRefName='other';
      if(variation==='draft')f.pr.isDraft=false;
      if(variation==='ci')f.pr.statusCheckRollup[0].conclusion='FAILURE';
      if(variation==='review')f.pr.reviewDecision='CHANGES_REQUESTED';
      if(variation==='grant')f.config.projects.p={...f.config.projects.p,label:'changed grant'};
      if(variation==='owner')f.config.ownerId='new-owner';
      if(variation==='expired')f.store.db.prepare('UPDATE operations SET expiresAt=0').run();
      await f.restart();await until(()=>f.store.get(f.task.id)?.status==='failed');
      assert.equal(f.effects.length,0,variation);assert.equal(f.op.state,'failed',variation);
    }finally{await f.close();}
  }
});

test('deny, cancel, revoked grant and expiration invalidate pending decisions without effects',async()=>{
  for(const variation of ['deny','cancel','grant','expired']){
    const f=fixture();try{
      const op=await f.preview(),action=approvalCard(f.store,f.config,f.task.id);
      if(variation==='deny')f.send('/deny '+op.requestId);
      if(variation==='cancel')f.send('/cancel '+f.task.id);
      if(variation==='grant'){delete f.config.projects.p;f.send('/approve '+op.requestId);}
      if(variation==='expired'){f.store.db.prepare('UPDATE operations SET expiresAt=0').run();await f.restart();}
      assert.notEqual(f.store.getRequest(op.requestId)?.status,'pending');
      assert.equal(f.engine.handleAction(action).toast.type,'error');
      f.send('/approve '+op.requestId);assert.equal(f.effects.length,0);
      assert.ok(['denied','cancelled','failed'].includes(f.op.state));
    }finally{await f.close();}
  }
});

test('unknown merge outcome stays readback-only across restart and a new merge request',async()=>{
  const f=fixture();try{
    const op=await f.preview();f.setPutMode('unknown');f.send('/approve '+op.requestId);
    await until(()=>f.op.state==='uncertain');assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
    await f.restart();f.send('合并 PR '+url);await until(()=>f.store.get(f.task.id)?.status==='failed');
    assert.equal(f.op.id,op.id);assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
    // Subsequent remote evidence can settle the same operation without repeating it.
    f.pr.state='MERGED';f.pr.mergeCommit={oid:commit};f.send('合并 PR '+url);
    await until(()=>f.op.state==='succeeded');assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
    assert.equal(f.store.mergeReceipt(f.task.id)?.commit,commit);
  }finally{await f.close();}
});

test('crash after recording an attempt reconciles matching remote success and never replays draft or merge',async()=>{
  for(const phase of ['draft','merge'] as const)for(const remote of ['open','merged','wrong-head'] as const){
    const f=fixture();try{
      const op=await f.preview();f.store.transaction(()=>decideOperation(f.store,op,'owner',true));
      operationAttempt(f.store,f.task.id,phase);f.store.set(f.task.id,'running');
      f.pr.isDraft=false;
      if(remote!=='open'){f.pr.state='MERGED';f.pr.mergeCommit={oid:commit};}
      if(remote==='wrong-head')f.pr.headRefOid='d'.repeat(40);
      await f.restart();await until(()=>['review','failed'].includes(f.store.get(f.task.id)!.status));
      assert.equal(f.effects.length,0);
      assert.equal(f.op.state,remote==='merged'?'succeeded':'uncertain');
      assert.equal(!!f.store.mergeReceipt(f.task.id),remote==='merged');
    }finally{await f.close();}
  }
});

test('confirmed draft conversion can resume at merge without repeating ready',async()=>{
  const f=fixture();try{
    const op=await f.preview();f.store.transaction(()=>decideOperation(f.store,op,'owner',true));
    operationAttempt(f.store,f.task.id,'draft');f.pr.isDraft=false;draftReady(f.store,f.task.id);f.store.set(f.task.id,'running');
    await f.restart();await until(()=>f.op.state==='succeeded');
    assert.equal(f.calls.filter(a=>a[1]==='ready').length,0);assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
  }finally{await f.close();}
});

test('lost PUT response is settled by readback without leaving a retryable operation',async()=>{
  const f=fixture();try{
    const op=await f.preview();f.setPutMode('lost');f.send('/approve '+op.requestId);
    await until(()=>f.op.state==='succeeded');await f.restart();
    assert.equal(f.calls.filter(a=>a.includes('PUT')).length,1);
  }finally{await f.close();}
});

test('v9 database migration preserves tasks and process-bound runtime approvals still expire',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-operation-migration-')),path=join(dir,'state.db');
  let store=new Store(path);
  try{
    const task=store.create('dm','p','old work');store.set(task.id,'waiting_approval');
    const req=store.request(task.id,'approval','live tool approval');
    store.db.exec('DROP TABLE operations; PRAGMA user_version=9');store.close();store=new Store(path);store.recover();
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,10);
    assert.equal(store.get(task.id)?.prompt,'old work');assert.equal(store.get(task.id)?.status,'interrupted');
    assert.equal(store.getRequest(req)?.status,'expired');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('approval received while another task runs stays queued and can be cancelled before mutation',async()=>{
  const f=fixture();let release=()=>{},entered=false;
  f.setExecutor({run:()=>new Promise<string>(resolve=>{entered=true;release=()=>resolve('done');})});
  try{
    const op=await f.preview();
    f.send('/new p slow',{conversation:{anchorId:'other',sourceId:'other',scope:'thread'}});
    await until(()=>entered);
    f.send('/approve '+op.requestId);f.send('/approve '+op.requestId);
    assert.equal(f.op.state,'approved');assert.equal(f.store.get(f.task.id)?.status,'queued');assert.equal(f.effects.length,0);
    f.send('/cancel '+f.task.id);release();
    await until(()=>!f.engine.permissionState().active);
    assert.equal(f.op.state,'cancelled');assert.equal(f.effects.length,0);
  }finally{release();await f.close();}
});

test('pending approval expires while another execution holds the slot',async()=>{
  const f=fixture();let release=()=>{},entered=false;
  f.setExecutor({run:()=>new Promise<string>(resolve=>{entered=true;release=()=>resolve('done');})});
  try{
    const op=await f.preview();f.engine.start();
    f.send('/new p slow',{conversation:{anchorId:'other',sourceId:'other',scope:'thread'}});
    await until(()=>entered);
    f.store.db.prepare('UPDATE operations SET expiresAt=0').run();
    await until(()=>f.op.state==='failed');
    assert.equal(f.engine.permissionState().active,true);assert.equal(f.store.getRequest(op.requestId)?.status,'expired');
    assert.equal(f.store.get(f.task.id)?.status,'review');assert.equal(f.effects.length,0);
  }finally{release();await f.close();}
});

test('preview persistence failure rolls back request, operation and waiting state together',async()=>{
  const f=fixture();const enqueue=f.store.enqueue.bind(f.store);
  f.store.enqueue=(chatId,text,view)=>{if(view?.kind==='task'&&view.fresh)throw Error('simulated outbox failure');enqueue(chatId,text,view);};
  try{
    f.send('合并 PR '+url);await until(()=>f.store.get(f.task.id)?.status==='failed');
    assert.equal(f.op,undefined);assert.equal(f.store.requests(f.task.id).length,0);assert.equal(f.effects.length,0);
    assert.match(f.store.get(f.task.id)!.result!,/outbox failure/);
  }finally{await f.close();}
});


test('a persisted success recovers the task result without querying or mutating GitHub again',async()=>{
  const f=fixture();try{
    const op=await f.preview();f.send('/approve '+op.requestId);await until(()=>f.op.state==='succeeded');
    // Simulate exit between receipt persistence and Engine's final task transition.
    f.store.set(f.task.id,'running');const count=f.calls.length;
    await f.restart();assert.equal(f.store.get(f.task.id)?.status,'review');
    assert.match(f.store.get(f.task.id)!.result!,/已合并到 main/);assert.equal(f.calls.length,count);
  }finally{await f.close();}
});


test('expiry or grant revocation during the final remote check blocks the first mutation',async()=>{
  for(const variation of ['expiry','grant']){
    const f=fixture();try{
      const op=await f.preview();let reads=0;
      f.onRead(()=>{if(++reads===2){
        if(variation==='expiry')f.store.db.prepare('UPDATE operations SET expiresAt=0').run();
        else f.config.projects.p={...f.config.projects.p,label:'revoked grant snapshot'};
      }});
      f.send('/approve '+op.requestId);await until(()=>f.store.get(f.task.id)?.status==='failed');
      assert.equal(f.effects.length,0);assert.equal(f.op.state,'failed');
    }finally{await f.close();}
  }
});
