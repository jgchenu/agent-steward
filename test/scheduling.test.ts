import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Config, Incoming, RunHooks, Task } from '../src/types.js';

let seq=0;
async function until(f:()=>boolean) { for(let i=0;i<200;i++){if(f())return;await setTimeout(10);}assert.fail('condition not reached'); }
function fixture(extra:Partial<Config>={}) {
  const dir=mkdtempSync(join(tmpdir(),'steward-scheduling-'));
  const store=new Store(join(dir,'state.sqlite'));
  const config:Config={ownerId:'owner',stateDir:dir,codexCommand:'unused',maxRunMinutes:1,groupChats:true,
    projects:{code:{path:dir,sandbox:'read-only'},alias:{path:dir,sandbox:'read-only'}},...extra};
  const running=new Map<string,{task:Task;hooks:RunHooks;finish:(result:string)=>void}>();
  const started:string[]=[];
  const engine=new Engine(store,config,{run:async(task,_project,hooks,signal)=>new Promise<string>((resolve,reject)=>{
    started.push(task.id);running.set(task.id,{task,hooks,finish:resolve});
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }).finally(()=>{running.delete(task.id);})}, {send:async()=>{},acknowledge:async()=>{},
    context:async()=>({summary:'',capturedAt:'now',truncated:false,messages:[]})});
  const send=(text:string,topic:string,extra:Partial<Incoming>={})=>engine.receive({id:String(++seq),text,chatId:'group',senderId:'owner',senderType:'user',chatType:'group',botMentioned:true,
    conversation:{anchorId:topic,sourceId:topic,scope:'thread'},...extra});
  const task=(topic:string)=>store.list().find(t=>t.conversation?.anchorId===topic)!;
  return {store,config,engine,running,started,send,task,close:async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('general topic bypasses queued code work while code executions remain serial',async()=>{
  const f=fixture();
  try {
    f.send('/new code slow work','code');await until(()=>f.running.size===1);
    f.send('/new alias another code task','other-code');
    f.send('weather question','weather');await until(()=>f.running.size===2);
    assert.equal(f.task('other-code').status,'queued');assert.equal(f.task('weather').status,'running');
    assert.equal(f.engine.permissionState().activeCount,2);
    f.running.get(f.task('weather').id)!.finish('weather done');await until(()=>f.task('weather').status==='review');
    assert.equal(f.task('code').status,'running');assert.equal(f.task('other-code').status,'queued');
    f.running.get(f.task('code').id)!.finish('code done');await until(()=>f.task('other-code').status==='running');
  }finally{await f.close();}
});

test('capacity is bounded, queue receipts are topic-bound and cancellation affects only its task',async()=>{
  const f=fixture();
  try {
    f.send('first','a');f.send('second','b');f.send('third','c');await until(()=>f.running.size===2);
    const a=f.task('a'),b=f.task('b'),c=f.task('c');assert.equal(c.status,'queued');
    const receipt=()=>f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId=? AND kind='queue_wait'").get(c.id)!.n;
    assert.equal(receipt(),1);
    f.send(`/status ${c.id}`,'c');assert.equal(receipt(),1);
    const out=f.store.db.prepare("SELECT view FROM outbox WHERE json_extract(view,'$.taskId')=? AND text LIKE '已收到，任务正在排队%' ORDER BY rowid LIMIT 1").get(c.id) as {view:string};
    assert.equal(JSON.parse(out.view).conversation.anchorId,'c');
    f.send(`/cancel ${a.id}`,'a');await until(()=>f.running.has(c.id));
    assert.equal(f.store.get(a.id)?.status,'cancelled');assert.equal(f.store.get(b.id)?.status,'running');
    assert.equal(f.running.size,2);assert.equal(f.started.filter(id=>id===c.id).length,1);
    f.send('more details','b');assert.equal(f.started.filter(id=>id===b.id).length,1);
    assert.deepEqual(f.store.pendingFollowups(b.id),['more details']);
  }finally{await f.close();}
});

test('single-slot configuration still queues independent conversations',async()=>{
  const f=fixture({maxConcurrentTasks:1});
  try{f.send('first','a');f.send('second','b');await until(()=>f.running.size===1);
    assert.equal(f.task('b').status,'queued');f.running.get(f.task('a').id)!.finish('done');await until(()=>f.running.has(f.task('b').id));
  }finally{await f.close();}
});

test('permission changes and shutdown apply to every concurrent invocation',async()=>{
  const f=fixture({permissionMode:'full-access'});
  try {
    f.send('first','a');f.send('second','b');await until(()=>f.running.size===2);
    f.engine.updateProjects({...f.config,permissionMode:'ask'});await until(()=>f.running.size===0);
    assert.equal(f.task('a').status,'failed');assert.equal(f.task('b').status,'failed');
    f.send(`/continue ${f.task('a').id} continue`,'a');f.send(`/continue ${f.task('b').id} continue`,'b');await until(()=>f.running.size===2);
    await f.engine.stop();assert.equal(f.running.size,0);
    assert.equal(f.task('a').status,'interrupted');assert.equal(f.task('b').status,'interrupted');
  }finally{await f.close();}
});

test('revoking a code grant stops that task without cancelling another topic',async()=>{
  const f=fixture();
  try{f.send('/new code work','a');f.send('weather','b');await until(()=>f.running.size===2);
    f.engine.updateProjects({projects:{}});await until(()=>f.task('a').status==='failed');
    assert.equal(f.task('b').status,'running');assert.equal(f.running.size,1);
  }finally{await f.close();}
});

test('one topic or saved Codex session cannot execute twice concurrently',async()=>{
  const f=fixture();
  try{
    f.send('first','a');await until(()=>f.running.size===1);const a=f.task('a');f.store.thread(a.id,'same-session');
    const sameTopic=f.store.create('group','__conversation__','second','read-only',a.conversation);
    const sameSession=f.store.create('group','__conversation__','third','read-only',{anchorId:'b',sourceId:'b',scope:'thread'});f.store.thread(sameSession.id,'same-session');
    f.send('/help','a');assert.equal(f.store.get(sameTopic.id)?.status,'queued');assert.equal(f.store.get(sameSession.id)?.status,'queued');
    assert.equal(f.running.size,1);
  }finally{await f.close();}
});

test('simultaneous runtime requests stay owner- and topic-bound and survive unrelated completion',async()=>{
  const f=fixture();
  try{
    f.send('first','a');f.send('second','b');await until(()=>f.running.size===2);
    const a=f.task('a'),b=f.task('b'),ra=f.running.get(a.id)!,rb=f.running.get(b.id)!;
    const decisions:string[]=[];
    const requestA=ra.hooks.request({kind:'approval',description:'operation A',resolve:answer=>{decisions.push('A:'+answer);ra.finish('A done');}});
    const requestB=rb.hooks.request({kind:'approval',description:'operation B',resolve:answer=>{decisions.push('B:'+answer);rb.finish('B done');}});
    f.send(`/approve ${requestA}`,'b');f.send(`/approve ${requestB}`,'b',{senderId:'stranger'});
    assert.deepEqual(decisions,[]);
    f.send(`/approve ${requestA}`,'a');await until(()=>f.store.get(a.id)?.status==='review');
    assert.equal(f.store.getRequest(requestB)?.status,'pending');assert.equal(f.store.get(b.id)?.status,'waiting_approval');
    f.send(`/approve ${requestB}`,'b');f.send(`/approve ${requestB}`,'b');await until(()=>f.store.get(b.id)?.status==='review');
    assert.deepEqual(decisions,['A:accept','B:accept']);
  }finally{await f.close();}
});

test('raising the live limit dispatches queued work; lowering drains active work without interruption',async()=>{
  const f=fixture({maxConcurrentTasks:1});
  try{
    f.engine.start();
    for(const topic of ['a','b','c','d'])f.send('work '+topic,topic);
    await until(()=>f.running.size===1);
    f.engine.updateProjects({...f.config,maxConcurrentTasks:3});await until(()=>f.running.size===3);
    assert.equal(f.engine.permissionState().maxConcurrentTasks,3);assert.equal(f.task('d').status,'queued');
    assert.throws(()=>f.engine.updateProjects({...f.config,maxConcurrentTasks:5}),/maxConcurrentTasks/);
    assert.equal(f.engine.permissionState().maxConcurrentTasks,3);
    f.engine.updateProjects({...f.config,maxConcurrentTasks:1});
    assert.equal(f.engine.permissionState().activeCount,3);
    f.running.get(f.task('a').id)!.finish('done');await until(()=>f.running.size===2);
    assert.equal(f.task('d').status,'queued');
    f.running.get(f.task('b').id)!.finish('done');await until(()=>f.running.size===1);
    assert.equal(f.task('d').status,'queued');
    f.running.get(f.task('c').id)!.finish('done');await until(()=>f.running.has(f.task('d').id));
    assert.equal(f.running.size,1);
    assert.equal(f.task('a').status,'review');assert.equal(f.task('b').status,'review');assert.equal(f.task('c').status,'review');
  }finally{await f.close();}
});
