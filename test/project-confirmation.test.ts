import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout} from 'node:timers/promises';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {WorkspaceExecutor} from '../src/workspace.js';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {projectAnswer} from '../src/routing.js';
import type {Config, Incoming, Task} from '../src/types.js';
const config=():Config=>({ownerId:'owner',stateDir:'.',codexCommand:'codex',maxRunMinutes:1,groupChats:true,projects:{
 code:{path:'/code',label:'ExampleProduct',sandbox:'workspace-write',naturalMode:'workspace-write',worktree:{baseRef:'origin/main',checks:[]}},
 other:{path:'/other',label:'OtherProduct',sandbox:'read-only'},
}});
const message=(id:string,text:string):Incoming=>({id,text,senderId:'owner',senderType:'user',chatId:'group',chatType:'group',botMentioned:true,conversation:{anchorId:'root',sourceId:id,threadId:'topic',scope:'thread'}});
async function until(fn:()=>boolean){for(let i=0;i<200;i++){if(fn())return;await setTimeout(5)}assert.fail('timeout')}
function harness(store=new Store(':memory:'), c=config()){
 const runs:Task[]=[],sent:string[]=[];
 const engine=new Engine(store,c,{run:async(t,_p,h)=>{runs.push(structuredClone(t));h.thread('session-'+runs.length);if(t.project==='__conversation__')h.proposeProject?.('code');return '已理解原始页面需求';}},
 {context:async()=>({capturedAt:'',truncated:false,messages:[],summary:''}),acknowledge:async()=>{},send:async(_c,text)=>{sent.push(text)}});
 return{store,engine,c,runs,sent,close:async()=>{await engine.stop();store.close()}};
}
async function propose(h:ReturnType<typeof harness>){
 h.engine.receive(message('one','收入订单这里要更新下，展示更加详细跟友好'));
 await until(()=>h.store.list()[0]?.status==='review');await h.engine.flush();return h.store.list()[0];
}
test('owner affirmative hands off a persisted proposal exactly once with original requirements and fresh code session',async()=>{
 const h=harness();try{
  const old=await propose(h);assert.ok(h.store.projectSelection(old.id));assert.match(h.sent.at(-1)!,/ExampleProduct.*对吗/);
  const yes={...message('yes','对的'),botMentioned:false};h.engine.receive(yes);h.engine.receive(yes);
  await until(()=>h.runs.length===2&&h.store.list().every(t=>t.status==='review'));
  const next=h.store.conversationTask('group',yes.conversation)!;
  assert.notEqual(next.id,old.id);assert.equal(next.project,'code');assert.equal(next.mode,'workspace-write');
  assert.equal(h.runs[1].threadId,null);assert.match(h.runs[1].prompt,/收入订单这里要更新下/);
  assert.equal(next.conversation!.anchorId,'root');assert.equal(h.store.projectSelection(old.id),undefined);
  assert.equal(h.store.requests(old.id).length,0);assert.equal(next.nextAction,'execute');
 }finally{await h.close()}
});
test('project proposal survives restart but cannot authorize unrelated topics, people or addressed recipients',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-selection-'));const db=join(dir,'test.sqlite');let h=harness(new Store(db));
 try{const old=await propose(h);await h.close();h=harness(new Store(db));h.engine.start();
  h.engine.receive({...message('foreign','对的'),senderId:'someone'});
  h.engine.receive({...message('bot','对的'),senderType:'app'});
  h.engine.receive({...message('other-chat','对的'),chatId:'other-group',botMentioned:false});
  h.engine.receive({...message('other-topic','对的'),botMentioned:false,conversation:{anchorId:'another',sourceId:'other-topic',threadId:'another-topic',scope:'thread'}});
  h.engine.receive({...message('other-person','对的'),botMentioned:false,mentionsOthers:true});
  assert.equal(h.runs.length,0);assert.ok(h.store.projectSelection(old.id));
  h.engine.receive({...message('yes','是的，继续'),botMentioned:false});await until(()=>h.runs.length===1&&h.store.list().every(t=>t.status==='review'));
  assert.equal(h.runs[0].project,'code');
 }finally{await h.close();rmSync(dir,{recursive:true,force:true})}
});
test('revoked, replaced and stale proposals fail closed without granting code access',async()=>{
 for(const change of ['revoked','replaced','revision'] as const){const h=harness();try{
  const old=await propose(h);
  if(change==='revoked')delete h.c.projects.code;
  if(change==='replaced')h.c.projects.code.path='/replacement';
  if(change==='revision')h.store.set(old.id,'review','new result');
  h.engine.receive(message('yes','对的'));await h.engine.flush();
  assert.equal(h.runs.length,1);assert.equal(h.store.list().length,1);assert.equal(h.store.projectSelection(old.id),undefined);assert.match(h.sent.at(-1)!,/失效/);
 }finally{await h.close()}}
});
test('negative cancels proposal; explicitly naming another project overrides it',async()=>{
 for(const text of ['不是','OtherProduct 继续处理']){const h=harness();try{
  const old=await propose(h);h.engine.receive(message('answer',text));await h.engine.flush();
  if(text==='不是'){assert.equal(h.runs.length,1);assert.equal(h.store.projectSelection(old.id),undefined);assert.match(h.sent.at(-1)!,/取消/)}
  else{await until(()=>h.runs.length===2);assert.equal(h.runs[1].project,'other');assert.equal(h.store.projectSelection(old.id),undefined)}
 }finally{await h.close()}}
});
test('owner supplements survive proposal replacement and the eventual project handoff',async()=>{
 const h=harness();try{const old=await propose(h);
  h.engine.receive(message('supplement','退款数据缺失时显示暂无数据'));await until(()=>h.runs.length===2&&h.store.get(old.id)?.status==='review');
  h.engine.receive(message('yes','好的'));await until(()=>h.runs.length===3);
  assert.match(h.runs[2].prompt,/收入订单这里要更新下/);assert.match(h.runs[2].prompt,/退款数据缺失时显示暂无数据/);
 }finally{await h.close()}
});
test('ordinary yes without a project proposal cannot select a project or grant approval',async()=>{
 assert.equal(projectAnswer('对的，但是先别执行'),undefined);assert.equal(projectAnswer('同意合并 PR'),undefined);
 const store=new Store(':memory:');let approved=false;let runs=0;
 const engine=new Engine(store,config(),{run:async(_t,_p,h,signal)=>{runs++;return new Promise((_resolve,reject)=>{
  h.request({kind:'approval',description:'publish?',resolve:()=>{approved=true}});signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});
 })}},{send:async()=>{},context:async()=>({capturedAt:'',truncated:false,messages:[],summary:''})});
 try{engine.receive(message('one','ExampleProduct 工作'));await until(()=>store.list()[0]?.status==='waiting_approval');
  engine.receive(message('yes','对的'));await engine.flush();assert.equal(approved,false);assert.equal(runs,1);assert.equal(store.requests(store.list()[0].id).length,1);
 }finally{await engine.stop();store.close()}
});


test('confirmed project prepares an isolated real Git worktree before code execution',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-confirm-worktree-')),store=new Store(':memory:'),c=config();
 const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
 git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');
 writeFileSync(join(dir,'sample.txt'),'original');git('add','sample.txt');git('commit','-m','initial');
 c.stateDir=join(dir,'.state');c.projects.code={...c.projects.code,path:dir,worktree:{baseRef:'main',checks:[]}};
 let codeRuns=0;
 const executor=new WorkspaceExecutor(c,store,{run:async(t,p,h)=>{
  if(t.project==='__conversation__'){h.proposeProject!('code');return '已理解页面需求'}
  codeRuns++;assert.notEqual(p.path,dir);assert.equal(readFileSync(join(p.path,'sample.txt'),'utf8'),'original');
  assert.match(t.prompt,/收入订单/);assert.equal(t.threadId,null);writeFileSync(join(p.path,'sample.txt'),'updated');return 'done';
 }});
 const engine=new Engine(store,c,executor,{send:async()=>{},acknowledge:async()=>{},context:async()=>({capturedAt:'',truncated:false,messages:[],summary:''})});
 try{engine.receive(message('one','收入订单这里要更新下'));await until(()=>store.list()[0]?.status==='review');
  engine.receive(message('yes','对的'));await until(()=>store.list().length===2&&store.list().every(t=>t.status==='review'));
  const task=store.conversationTask('group',message('last','').conversation)!;
  assert.equal(codeRuns,1);assert.ok(store.workspace(task.id));assert.deepEqual(store.delivery(task.id)!.files,['sample.txt']);
  assert.equal(readFileSync(join(dir,'sample.txt'),'utf8'),'original');
 }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});
