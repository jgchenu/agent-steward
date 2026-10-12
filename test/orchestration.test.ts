import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { TaskOrchestrator } from '../src/orchestration.js';
import type { Config, Executor, Incoming, RunHooks } from '../src/types.js';

let seq=0;
const message=(text:string,extra:Partial<Incoming>={}):Incoming=>({id:`msg-${++seq}`,text,chatId:'dm',senderId:'owner',senderType:'user',chatType:'p2p',...extra});
const project={path:process.cwd(),sandbox:'read-only' as const};
const hooks:RunHooks={thread:()=>{},progress:()=>{},request:()=>{throw Error('unexpected live permission');},resolved:()=>{}};
const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,langGraphPilot:true,projects:{demo:project}};
async function until(fn:()=>boolean){for(let i=0;i<200;i++){if(fn())return;await setTimeout(10);}assert.fail('condition not reached');}
const channel={send:async()=>{}};

test('business questions survive process restart, release the slot and resume the same session exactly once',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-graph-'));const db=join(dir,'state.db');
  let store=new Store(db), runs=0;
  const executor:Executor={run:async(task,_p,h)=>{
    runs++;
    if(task.prompt==='first'){h.thread('saved-codex-thread');h.askClarification!('需要哪个日期范围？');return '等待日期范围';}
    if(task.prompt==='second')return 'second done';
    assert.equal(task.threadId,'saved-codex-thread');assert.match(task.prompt,/最近七天/);return 'first done';
  }};
  let engine=new Engine(store,config,executor,channel);
  try{
    engine.receive(message('/new demo first'));await until(()=>store.list()[0]?.status==='waiting_input');
    const task=store.list()[0], request=store.requests(task.id)[0].id;
    engine.receive(message('/new demo second'));await until(()=>store.list()[1]?.status==='review');
    assert.equal(runs,2);
    await engine.stop();store.close();store=new Store(db);engine=new Engine(store,config,executor,channel);engine.start();
    assert.equal(store.get(task.id)?.status,'waiting_input');assert.equal(store.getRequest(request)?.status,'pending');
    engine.receive(message(`/answer ${request} bad`,{senderId:'stranger'}));
    engine.receive(message(`/answer ${request} bad`,{chatId:'other'}));
    engine.receive(message(`/approve ${request}`));assert.equal(store.getRequest(request)?.status,'pending');
    const reply=message(`/answer ${request} 最近七天`);engine.receive(reply);engine.receive(reply);
    await until(()=>store.get(task.id)?.status==='review');assert.equal(runs,3);
    engine.receive(message(`/answer ${request} replay`));assert.equal(runs,3);
    assert.equal(store.get(task.id)?.result,'first done');
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('topic prose answers durable questions but cannot cross topics; cancelled and stale cards do not resume',async()=>{
  const store=new Store(':memory:');let runs=0;
  const engine=new Engine(store,{...config,groupChats:true},{run:async(_t,_p,h)=>{runs++;h.askClarification!('补充范围');return 'question';}},
    {...channel,context:async()=>({summary:'context',capturedAt:'now',truncated:false,messages:[]})});
  const conversation={anchorId:'topic',sourceId:'topic',scope:'thread' as const};
  const group=(text:string,anchor='topic')=>message(text,{chatType:'group',botMentioned:true,conversation:{...conversation,anchorId:anchor,sourceId:anchor}});
  try{
    engine.receive(group('/new demo work'));await until(()=>store.list()[0]?.status==='waiting_input');
    const task=store.list()[0],req=store.requests(task.id)[0].id;
    engine.receive(group(`/answer ${req} wrong`,'other'));assert.equal(runs,1);
    const action=store.action('dm',{op:'answer',taskId:task.id,requestId:req,conversation});
    engine.receive(group('/cancel '+task.id));assert.equal(store.getRequest(req)?.status,'expired');
    const result=engine.handleAction({id:'click',senderId:'owner',chatId:'dm',actionId:action,messageId:'card',fields:{answer:'yes'}});
    assert.equal(result.toast.type,'error');assert.equal(runs,1);
  }finally{await engine.stop();store.close();}
});

test('pilot is opt in per new project task and disabling it never falls back to legacy execution',async()=>{
  const store=new Store(':memory:');const old=store.create('dm','demo','old');let runs=0;
  let engine=new Engine(store,config,{run:async()=>{runs++;return 'done';}},channel);
  try{
    assert.equal(store.get(old.id)?.orchestration,'legacy');
    const task=store.create('dm','demo','pilot');assert.equal(task.orchestration,'langgraph-v1');
    assert.equal(store.create('dm','__conversation__','chat').orchestration,'legacy');
    store.set(old.id,'review');store.set(store.list()[2].id,'review');
    await engine.stop();engine=new Engine(store,{...config,langGraphPilot:false},{run:async()=>{runs++;return 'wrong';}},channel);
    engine.start();await until(()=>store.get(task.id)?.status==='failed');assert.equal(runs,0);
    assert.match(store.get(task.id)!.result!,/不会通过旧运行时/);
  }finally{await engine.stop();store.close();}
});

test('uncertain executor effects are not repeated after recovery; live approvals expire',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-graph-'));const path=join(dir,'state.db');
  let store=new Store(path);store.pilotIntake=true;const task=store.create('dm','demo','work');
  let graph=new TaskOrchestrator(store),runs=0;
  const executor:Executor={run:async()=>{runs++;throw Error('lost connection after writing');}};
  try{
    await assert.rejects(graph.run(task,project,executor,hooks,AbortSignal.timeout(5000)),/lost connection/);
    const req=store.request(task.id,'approval','write');store.set(task.id,'waiting_approval');
    graph.close();store.close();store=new Store(path);store.recover();graph=new TaskOrchestrator(store);
    assert.equal(store.getRequest(req)?.status,'expired');
    await assert.rejects(graph.run(store.get(task.id)!,project,executor,hooks,AbortSignal.timeout(5000)),/阻止自动重放/);
    assert.equal(runs,1);
  }finally{graph.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a completed executor receipt reconciles a lost checkpoint without repeating the executor',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-graph-'));const path=join(dir,'state.db');
  let store=new Store(path);store.pilotIntake=true;const task=store.create('dm','demo','work');
  let graph=new TaskOrchestrator(store),runs=0;
  const executor:Executor={run:async()=>{runs++;return 'artifact';}};
  try{
    // Fail the checkpoint write after the domain operation receipt was committed.
    const saver=(graph as any).saver;const put=saver.put.bind(saver);
    saver.put=async(...args:any[])=>{
      if(store.db.prepare('SELECT result FROM graph_operations WHERE result IS NOT NULL').get())throw Error('checkpoint unavailable');
      return put(...args);
    };
    await assert.rejects(graph.run(task,project,executor,hooks,AbortSignal.timeout(5000)),/checkpoint unavailable/);
    graph.close();store.close();store=new Store(path);graph=new TaskOrchestrator(store);
    const result=await graph.run(store.get(task.id)!,project,executor,hooks,AbortSignal.timeout(5000));
    assert.deepEqual(result,{waiting:false,message:'artifact'});assert.equal(runs,1);
  }finally{graph.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('changed grants block a resumed graph and successive questions consume only their own answer',async()=>{
  const store=new Store(':memory:');store.pilotIntake=true;const task=store.create('dm','demo','work');
  const graph=new TaskOrchestrator(store);let runs=0;
  const executor:Executor={run:async(_t,_p,h)=>{runs++;if(runs<3)h.askClarification!('question '+runs);return 'result';}};
  try{
    const first=await graph.run(task,project,executor,hooks,AbortSignal.timeout(5000));assert.equal(first.waiting,true);
    if(!first.waiting)throw Error('expected wait');store.transaction(()=>store.graphQuestion(task.id,first.step,first.question));
    store.transaction(()=>store.answerGraph(task.id,'answer one'));
    await assert.rejects(graph.run(task,{...project,path:'/different'},executor,hooks,AbortSignal.timeout(5000)),/授权或配置已变化/);assert.equal(runs,1);
    const second=await graph.run(task,project,executor,hooks,AbortSignal.timeout(5000));assert.equal(second.waiting,true);
    if(!second.waiting)throw Error('expected wait');store.transaction(()=>store.graphQuestion(task.id,second.step,second.question));
    const waiting=await graph.run(task,project,executor,hooks,AbortSignal.timeout(5000));assert.equal(waiting.waiting,true);assert.equal(runs,2);
    store.transaction(()=>store.answerGraph(task.id,'answer two'));
    assert.deepEqual(await graph.run(task,project,executor,hooks,AbortSignal.timeout(5000)),{waiting:false,message:'result'});assert.equal(runs,3);
  }finally{graph.close();store.close();}
});

test('natural topic replies resume business work but do not approve a later runtime permission',async()=>{
  const store=new Store(':memory:');let runs=0,approved=0,permission='';let complete:(value:string)=>void=()=>{};
  const engine=new Engine(store,{...config,groupChats:true},{run:async(_t,_p,h,signal)=>{
    runs++;
    if(runs===1){h.askClarification!('采用哪种展示方式？');return 'question';}
    return new Promise<string>((resolve,reject)=>{
      complete=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      permission=h.request({kind:'approval',description:'specific tool action',resolve:answer=>{approved++;assert.equal(answer,'accept');resolve('done');}});
    });
  }},{...channel,context:async()=>({summary:'context',capturedAt:'now',truncated:false,messages:[]})});
  const conversation={anchorId:'root',sourceId:'root',scope:'thread' as const};
  const group=(text:string,mentioned=true)=>message(text,{chatType:'group',botMentioned:mentioned,conversation});
  try{
    engine.receive(group('/new demo work'));await until(()=>store.list()[0]?.status==='waiting_input');
    engine.receive(group('按刚才讨论的第二种方式来',false));await until(()=>!!permission);
    engine.receive(group('好的'));assert.equal(approved,0);assert.equal(runs,2);
    engine.receive(group(`/approve ${permission}`));await until(()=>store.list()[0]?.status==='review');assert.equal(approved,1);
  }finally{complete('stop');await engine.stop();store.close();}
});

test('a durable answer card is owner-bound, revision-bound and usable after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-graph-card-'));const path=join(dir,'state.db');
  let store=new Store(path),runs=0;
  const executor:Executor={run:async(_t,_p,h)=>{runs++;if(runs===1)h.askClarification!('Which range?');return 'done';}};
  let engine=new Engine(store,config,executor,channel);
  try{
    engine.receive(message('/new demo work'));await until(()=>store.list()[0]?.status==='waiting_input');
    const task=store.list()[0],requestId=store.requests(task.id)[0].id;
    const actionId=store.action('dm',{op:'answer',taskId:task.id,requestId,revision:task.updatedAt});
    await engine.stop();store.close();store=new Store(path);engine=new Engine(store,config,executor,channel);engine.start();
    const action={id:'answer-card',senderId:'owner',chatId:'dm',actionId,messageId:'card',fields:{body:'last week'}};
    assert.equal(engine.handleAction({...action,senderId:'other'}).toast.type,'error');
    assert.equal(engine.handleAction(action).toast.type,'success');
    await until(()=>store.get(task.id)?.status==='review');assert.equal(runs,2);
    assert.equal(engine.handleAction(action).toast.type,'error');
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('plain DM answers choose only an unambiguous durable question and revoked projects cannot resume',async()=>{
  const store=new Store(':memory:');let runs=0;
  const cfg={...config,projects:{...config.projects}};
  const engine=new Engine(store,cfg,{run:async(t,_p,h)=>{runs++;if(!t.prompt.includes('本次补充'))h.askClarification!('Which range?');return 'done';}},channel);
  try{
    engine.receive(message('/new demo first'));await until(()=>store.list()[0]?.status==='waiting_input');
    engine.receive(message('最近一周'));await until(()=>store.list()[0]?.status==='review');assert.equal(runs,2);assert.equal(store.list().length,1);
    engine.receive(message('/new demo second'));await until(()=>store.list()[1]?.status==='waiting_input');
    engine.receive(message('/new demo third'));await until(()=>store.list()[2]?.status==='waiting_input');
    engine.receive(message('最近一月'));assert.equal(runs,4);assert.equal(store.list().length,3);
    const second=store.list()[1],req=store.requests(second.id)[0].id;
    engine.updateProjects({projects:{}});engine.receive(message(`/answer ${req} last week`));
    assert.equal(store.getRequest(req)?.status,'pending');assert.equal(runs,4);
  }finally{await engine.stop();store.close();}
});

test('online SQLite backup includes both graph checkpoints and the matching business wait',async()=>{
  const {backup}=await import('node:sqlite');
  const dir=mkdtempSync(join(tmpdir(),'steward-graph-backup-'));
  let store=new Store(join(dir,'original.db'));store.pilotIntake=true;
  const task=store.create('dm','demo','work');let graph=new TaskOrchestrator(store),runs=0;
  const executor:Executor={run:async(_t,_p,h)=>{runs++;if(runs===1)h.askClarification!('Choose range');return 'done';}};
  try{
    const wait=await graph.run(task,project,executor,hooks,AbortSignal.timeout(5000));if(!wait.waiting)throw Error('expected wait');
    store.transaction(()=>store.graphQuestion(task.id,wait.step,wait.question));
    await backup(store.db,join(dir,'backup.db'));
    graph.close();store.close();store=new Store(join(dir,'backup.db'));graph=new TaskOrchestrator(store);store.recover();
    assert.equal(store.get(task.id)?.status,'waiting_input');store.transaction(()=>store.answerGraph(task.id,'last month'));
    assert.deepEqual(await graph.run(store.get(task.id)!,project,executor,hooks,AbortSignal.timeout(5000)),{waiting:false,message:'done'});
    assert.equal(runs,2);
  }finally{graph.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
