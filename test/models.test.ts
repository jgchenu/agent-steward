import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readModels,modelSelection,validateSelection,asksModelStatus,runtimeModel} from '../src/models.js';
import {WorkspaceRegistry} from '../src/workspace-console.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import type {Config,Task} from '../src/types.js';
const model={model:'model-a',name:'Model A',defaultEffort:'low',efforts:['low','high']};
test('model catalog preserves advertised efforts, filters hidden models and validates pagination',async()=>{
 const pages=[{data:[{model:'model-a',displayName:'Model A',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{hidden:true}],nextCursor:'next'},{data:[],nextCursor:null}];
 assert.deepEqual(await readModels({request:async()=>pages.shift()}),[model]);
 await assert.rejects(readModels({request:async()=>({data:[],nextCursor:'loop'})}),/分页/);
 assert.throws(()=>modelSelection({model:'a',effort:''}),/无效/);
 assert.throws(()=>validateSelection({model:'model-a',effort:'ultra'},[model]),/不可用/);
});
test('model save preserves project permissions, rejects stale/unsupported settings and hot loads',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-model-')),file=join(dir,'config.json'),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 try{
  writeFileSync(file,JSON.stringify({projects:{},permissionMode:'auto'}));const r=new WorkspaceRegistry(file,()=>[]),s=r.state();
  const input={revision:s.revision,grants:[],modelSelection:{model:'model-a',effort:'high'}};
  assert.throws(()=>r.apply(input,[]),/不可用/);
  r.apply(input,[model]);assert.deepEqual(loadConfig(file).modelSelection,input.modelSelection);assert.equal(loadConfig(file).permissionMode,'auto');
  assert.throws(()=>r.apply(input,[model]),/配置已变化/);
  const saved=readFileSync(file,'utf8');assert.throws(()=>r.apply({...input,revision:r.state().revision,modelSelection:{model:'model-a',effort:'ultra'}},[model]),/不可用/);assert.equal(readFileSync(file,'utf8'),saved);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true})}
});
const until=async(f:()=>boolean)=>{for(let i=0;i<200&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f());};
test('model edits affect the next turn only, including resumed conversations; console navigation starts no work',async()=>{
 const store=new Store(':memory:'),config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,projects:{},consoleUrl:'http://127.0.0.1:17831/',modelSelection:{model:'model-a',effort:'low'}};
 const seen:Task[]=[],messages:string[]=[];let release:()=>void=()=>{};
 const engine=new Engine(store,config,{run:async task=>{seen.push(task);return new Promise<string>(r=>{release=()=>r('done')})}},{send:async(_,text)=>{messages.push(text)}});
 const send=(id:string,text:string,senderId='owner')=>engine.receive({id,text,senderId,chatId:'dm',chatType:'p2p',senderType:'user'});
 try{
  send('stranger','打开控制台','other');send('console','打开控制台');engine.start();await until(()=>messages.length===1);assert.match(messages[0],/17831/);assert.equal(store.list().length,0);
  send('one','你好');await until(()=>seen.length===1);engine.updateProjects({...config,modelSelection:{model:'model-a',effort:'high'}});assert.equal(seen[0].modelSelection?.effort,'low');release();await until(()=>store.list()[0].status==='review');
  send('two','/continue '+store.list()[0].id+' 继续');await until(()=>seen.length===2);assert.equal(seen[1].modelSelection?.effort,'high');release();await until(()=>store.list()[0].status==='review');
 }finally{await engine.stop();store.close()}
});

test('model API uses console authentication and model outage does not prevent permission saves',async()=>{
 const {startWorkspaceConsole}=await import('../src/workspace-console.js');
 const dir=mkdtempSync(join(tmpdir(),'steward-model-http-')),file=join(dir,'config.json'),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 writeFileSync(file,JSON.stringify({projects:{},permissionMode:'auto'}));let available=true;
 const app=await startWorkspaceConsole(file,0,async()=>[],async()=>{if(!available)throw Error('model catalog unavailable');return [model]});
 try{
  assert.equal((await fetch(app.url+'api/models')).status,403);
  const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)![1];
  const headers={'X-Steward-Console':token,Origin:app.url.slice(0,-1),'Content-Type':'application/json'};
  assert.deepEqual(await(await fetch(app.url+'api/models',{headers})).json(),[model]);
  const state:any=await(await fetch(app.url+'api/state',{headers})).json();available=false;
  const response=await fetch(app.url+'api/grants',{method:'POST',headers,body:JSON.stringify({revision:state.revision,grants:[],permissionMode:'ask'})});assert.equal(response.status,200);assert.equal(loadConfig(file).permissionMode,'ask');
 }finally{await new Promise<void>(r=>app.server.close(()=>r()));if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true})}
});

test('model questions answer active runtime facts without losing work or changing approvals',async()=>{
 const store=new Store(':memory:'),config:Config={ownerId:'owner',groupChats:true,stateDir:'.',codexCommand:'unused',maxRunMinutes:1,projects:{}};
 let release:()=>void=()=>{},runs=0;
 const messages:string[]=[];
 const engine=new Engine(store,config,{run:async(_t,_p,h)=>{
  runs++;h.modelResolved?.({model:'runtime-a',effort:'high'});
  return new Promise<string>(r=>{release=()=>r('done')});
 }},{send:async(_,text)=>{messages.push(text)},context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]})});
 const conversation={anchorId:'topic',sourceId:'root',scope:'thread' as const};
 const send=(id:string,text:string,senderId='owner',anchorId='topic')=>engine.receive({id,text,senderId,chatId:'group',chatType:'group',senderType:'user',botMentioned:true,conversation:{...conversation,anchorId,sourceId:id}});
 try{
  engine.start();
  send('start','你好');await until(()=>runs===1);
  const task=store.list()[0],revision=task.updatedAt;
  engine.updateProjects({...config,modelSelection:{model:'next-b',effort:'low'}});
  send('query','你当前基于工作的模型跟强度是哪个');send('query','你当前基于工作的模型跟强度是哪个');
  await until(()=>messages.some(x=>x.includes('模型 runtime-a')));
  assert.equal(messages.filter(x=>x.includes('模型 runtime-a')).length,1);
  assert.match(messages.find(x=>x.includes('模型 runtime-a'))!,/high.*\n.*next-b · low/);
  assert.equal(store.get(task.id)!.updatedAt,revision);assert.equal(runs,1);
  assert.deepEqual(store.pendingFollowups(task.id),[]);
  const count=messages.length;send('foreign','/model '+task.id,'owner','other');send('stranger','/model '+task.id,'stranger');
  await until(()=>messages.length>count);assert.ok(!messages.slice(count).some(x=>x.includes('runtime-a')));
  send('note','请保留已有筛选器');send('note','请保留已有筛选器');assert.deepEqual(store.pendingFollowups(task.id),['请保留已有筛选器']);
  release();await until(()=>store.get(task.id)!.status==='review');
  assert.deepEqual(store.runtimeModel(task.id),{model:'runtime-a',effort:'high'});
  await engine.stop();
  store.resume(task.id,'继续');assert.match(store.get(task.id)!.prompt,/请保留已有筛选器/);assert.deepEqual(store.pendingFollowups(task.id),[]);
 }finally{release();await engine.stop();store.close()}
});
test('model status recognizes self questions, never steals edits, and unknown defaults remain unknown',()=>{
 for(const text of ['你现在用什么模型？','你当前基于工作的模型跟强度是哪个','告诉我当前推理强度'])assert.ok(asksModelStatus(text));
 for(const text of ['帮我实现模型设置页面','你当前是什么模型，然后修改代码','你现在切换模型到 model-b','分析模型价格'])assert.equal(asksModelStatus(text),false);
 assert.deepEqual(runtimeModel({}),{model:null,effort:null});
 assert.deepEqual(runtimeModel({model:'a',reasoningEffort:null}),{model:'a',effort:null});
 assert.deepEqual(runtimeModel({model:'a',reasoningEffort:'low'},{model:'b',effort:'high'}),{model:'b',effort:'high'});
});
test('pending followups and runtime facts survive restart, and handoff retains pending notes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-pending-')),file=join(dir,'state.sqlite');let store=new Store(file);
 try{
  const c={anchorId:'root',sourceId:'root',scope:'thread' as const};
  const task=store.create('group','p','work','read-only',c);
  store.event(task.id,'runtime_model',JSON.stringify({model:'a',effort:'high'}));store.event(task.id,'followup_pending','keep filter');
  store.close();store=new Store(file);store.recover();
  assert.equal(store.runtimeModel(task.id)?.model,'a');assert.deepEqual(store.pendingFollowups(task.id),['keep filter']);
  store.set(task.id,'review');const next=store.handoff(store.get(task.id)!,'p','new work','read-only',c);
  assert.deepEqual(store.pendingFollowups(next.id),['keep filter']);assert.deepEqual(store.pendingFollowups(task.id),[]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('model query while waiting for permission leaves the one-shot decision pending',async()=>{
 const store=new Store(':memory:'),config:Config={ownerId:'owner',groupChats:true,stateDir:'.',codexCommand:'unused',maxRunMinutes:1,projects:{}};
 let request='',decisions=0;const messages:string[]=[];
 const engine=new Engine(store,config,{run:async(_t,_p,h,signal)=>new Promise<string>((resolve,reject)=>{
  h.modelResolved?.({model:'actual',effort:'high'});
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  request=h.request({kind:'approval',description:'specific operation',resolve:a=>{decisions++;resolve(a)}});
 })},{send:async(_,text)=>{messages.push(text)},context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]})});
 const send=(id:string,text:string)=>engine.receive({id,text,senderId:'owner',senderType:'user',chatType:'group',chatId:'group',botMentioned:true,conversation:{anchorId:'topic',sourceId:id,scope:'thread'}});
 try{
  engine.start();send('start','你好');await until(()=>!!request);send('query','你现在用什么模型？');
  await until(()=>messages.some(x=>x.includes('模型 actual')));
  assert.equal(decisions,0);assert.equal(store.getRequest(request)!.status,'pending');assert.equal(store.list()[0].status,'waiting_approval');
  send('deny','/deny '+request);await until(()=>store.list()[0].status==='review');assert.equal(decisions,1);
 }finally{await engine.stop();store.close()}
});
