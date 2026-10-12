import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {WorkspaceExecutor} from '../src/workspace.js';
import {CONVERSATION} from '../src/conversation.js';
import {buildCard} from '../src/channels/cards.js';
import {TaskOrchestrator} from '../src/orchestration.js';
import type {Config,Incoming,Task,Executor} from '../src/types.js';

async function until(fn:()=>boolean,details?:()=>unknown){for(let i=0;i<300;i++){if(fn())return;await delay(10);}assert.fail('condition not reached: '+JSON.stringify(details?.()));}
const context=async()=>({summary:'supplied business context',capturedAt:'',truncated:false,messages:[]});
const channel={send:async()=>{},context,acknowledge:async()=>{}};
let seq=0;
const message=(text:string,topic='topic',botMentioned=true):Incoming=>({id:String(++seq),text,senderId:'owner',senderType:'user',chatId:'group',chatType:'group',botMentioned,
  conversation:{anchorId:topic,sourceId:String(seq),threadId:topic,scope:'thread'}});
const base:Config={ownerId:'owner',stateDir:tmpdir(),codexCommand:'unused',maxRunMinutes:1,groupChats:true,projects:{}};

test('the task form defaults to no resource and works with zero code grants without allowing write escalation',async()=>{
  const store=new Store(':memory:');let runs=0;
  const engine=new Engine(store,base,{run:async(t)=>{runs++;assert.deepEqual(t.resources,[]);return 'summary';}},channel);
  try{
    const home=JSON.stringify(buildCard(store,base,'group',{kind:'home',conversation:message('').conversation}));
    assert.match(home,/"initial_option":"__conversation__"/);assert.match(home,/归纳客服反馈/);
    const actionId=store.action('group',{op:'new',conversation:message('').conversation});
    const action={id:'start',actionId,senderId:'owner',chatId:'group',messageId:'card',fields:{project:CONVERSATION,mode:'read-only',body:'整理客服反馈'}};
    assert.equal(engine.handleAction({...action,senderId:'other'}).toast.type,'error');
    assert.equal(engine.handleAction({...action,fields:{...action.fields,mode:'workspace-write'}}).toast.type,'error');
    assert.equal(engine.handleAction(action).toast.type,'success');await until(()=>store.list()[0]?.status==='review');
    assert.equal(runs,1);assert.equal(engine.handleAction({...action,id:'duplicate'}).toast.type,'error');
  }finally{await engine.stop();store.close();}
});

test('business wording, named products and multiple resource references never force a code binding',async()=>{
  for(const granted of [false,true]){
    const store=new Store(':memory:'),runs:Task[]=[];
    const config:Config={...base,permissionMode:'full-access',projects:granted?{code:{path:'/not-accessible',label:'产品甲',sandbox:'workspace-write',naturalMode:'workspace-write',worktree:{baseRef:'main',checks:[]}}}: {}};
    const engine=new Engine(store,config,{run:async(t,p)=>{
      runs.push(t);assert.equal(t.project,CONVERSATION);assert.deepEqual(t.resources,[]);
      assert.equal(p.sandbox,'read-only');assert.equal(p.worktree,undefined);assert.notEqual(p.path,'/not-accessible');return 'business result';
    }},channel);
    try{
      for(const text of ['提交报销材料，核对金额','修复这段客服话术','读这份文件，归纳投诉原因','部署下周的运营活动安排','分析产品甲的活动复盘，不需要读代码','比较产品甲和其他产品的客服反馈']){
        engine.receive(message(text,'topic-'+seq));await until(()=>store.list().every(t=>t.status==='review'));
      }
      assert.equal(runs.length,6);assert.ok(store.list().every(t=>!store.workspace(t.id)&&!store.projectSelection(t.id)));
    }finally{await engine.stop();store.close();}
  }
});

test('a resource-free business question survives restart and releases capacity for another task',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-business-')),db=join(dir,'state.sqlite');
  const config={...base,stateDir:dir,langGraphPilot:true};let store=new Store(db),runs=0;
  const executor:Executor={run:async(t,_p,h)=>{
    runs++;assert.deepEqual(t.resources,[]);
    if(t.prompt==='核对这批报销材料'){h.thread('business-session');h.askClarification!('使用哪个核对口径？');return 'waiting';}
    if(t.prompt==='整理客服话术')return 'second result';
    assert.equal(t.threadId,'business-session');assert.match(t.prompt,/按实际到账金额/);return 'reconciliation result';
  }};
  let engine=new Engine(store,config,executor,channel);
  try{
    engine.receive(message('核对这批报销材料'));await until(()=>store.list()[0]?.status==='waiting_input',()=>store.list());const task=store.list()[0];
    assert.equal(task.orchestration,'langgraph-v1');assert.equal(store.workspace(task.id),undefined);
    engine.receive(message('整理客服话术','another'));await until(()=>store.list()[1]?.status==='review');assert.equal(runs,2);
    const request=store.requests(task.id)[0].id;await engine.stop();store.close();store=new Store(db);engine=new Engine(store,config,executor,channel);engine.start();
    assert.equal(store.getRequest(request)?.status,'pending');
    engine.receive(message('错误答案','wrong',false));assert.equal(store.getRequest(request)?.status,'pending');
    const answer=message('按实际到账金额','topic',false);engine.receive(answer);engine.receive(answer);
    await until(()=>store.get(task.id)?.status==='review',()=>store.list());assert.equal(runs,3);assert.equal(store.getRequest(request)?.status,'answered');
    assert.equal(store.get(task.id)?.threadId,'business-session');assert.deepEqual(store.get(task.id)?.resources,[]);
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a semantic code need binds an owner-named resource after clarification and only then prepares its worktree',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-resource-')),store=new Store(':memory:');
  const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  writeFileSync(join(dir,'sample.txt'),'original');git('add','sample.txt');git('commit','-m','initial');
  const config:Config={...base,stateDir:join(dir,'.state'),langGraphPilot:true,projects:{code:{path:dir,label:'产品甲',sandbox:'workspace-write',naturalMode:'workspace-write',worktree:{baseRef:'main',checks:[]}}}};
  const runs:Task[]=[];
  const executor=new WorkspaceExecutor(config,store,{run:async(t,p,h)=>{
    runs.push(t);
    if(t.project===CONVERSATION){
      assert.equal(store.workspace(t.id),undefined);assert.deepEqual(t.resources,[]);assert.notEqual(p.path,dir);
      if(!t.prompt.includes('最近七天')){h.thread('general-session');h.askClarification!('使用哪个日期范围？');return 'question';}
      h.proposeProject!('code');return 'need code resource';
    }
    assert.deepEqual(t.resources,[{kind:'code-project',id:'code'}]);assert.equal(t.threadId,null);assert.match(t.prompt,/最近七天/);
    assert.notEqual(p.path,dir);assert.ok(store.workspace(t.id));writeFileSync(join(p.path,'sample.txt'),'changed');return 'implemented';
  }});
  const engine=new Engine(store,config,executor,channel);
  try{
    engine.receive(message('修改产品甲的数据页，只展示已支付订单，先问我日期范围'));
    await until(()=>store.list()[0]?.status==='waiting_input',()=>store.list());const original=store.list()[0];
    engine.receive(message('最近七天','topic',false));
    await until(()=>runs.length===3&&store.list().every(t=>t.status==='review'),()=>store.list());
    const next=store.conversationTask('group',message('查看结果').conversation)!;
    assert.notEqual(next.id,original.id);assert.equal(next.project,'code');assert.equal(store.projectSelection(original.id),undefined);
    assert.equal(readFileSync(join(dir,'sample.txt'),'utf8'),'original');assert.deepEqual(store.delivery(next.id)?.files,['sample.txt']);
    assert.equal(store.workspace(original.id),undefined);
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('DM resource confirmation stays scoped to a single pending task and is invalidated when the grant changes',async()=>{
  for(const revoked of [false,true]){
    const store=new Store(':memory:');const config:Config={...base,projects:{code:{path:'/code',sandbox:'read-only'}}};let runs=0;
    const engine=new Engine(store,config,{run:async(t,_p,h)=>{runs++;if(t.project===CONVERSATION)h.proposeProject!('code');return 'need resource';}},channel);
    const dm=(text:string,chatId='dm'):Incoming=>({id:String(++seq),text,chatId,senderId:'owner',senderType:'user',chatType:'p2p'});
    try{
      engine.receive(dm('请检查这个组件'));await until(()=>store.list()[0]?.status==='review');const task=store.list()[0];assert.ok(store.projectSelection(task.id));
      if(revoked)delete config.projects.code;
      engine.receive(dm('对的'));await engine.flush();
      if(revoked){assert.equal(runs,1);assert.equal(store.list().length,1);assert.equal(store.projectSelection(task.id),undefined);}
      else{await until(()=>runs===2&&store.list().every(t=>t.status==='review'));assert.deepEqual(store.list()[1].resources,[{kind:'code-project',id:'code'}]);}
    }finally{await engine.stop();store.close();}
  }
});

test('a resource replaced during semantic interpretation cannot be bound from an old proposal',async()=>{
  for(const pilot of [false,true]){
    const store=new Store(':memory:'),config:Config={...base,langGraphPilot:pilot,projects:{code:{path:'/original',label:'产品甲',sandbox:'read-only'}}};let runs=0;
    const engine=new Engine(store,config,{run:async(_t,_p,h)=>{runs++;h.proposeProject!('code');config.projects.code.path='/replacement';return 'proposal';}},channel);
    try{
      engine.receive(message('检查产品甲代码'));await until(()=>store.list()[0]?.status==='failed');
      assert.equal(runs,1);assert.equal(store.list().length,1);assert.deepEqual(store.list()[0].resources,[]);assert.equal(store.projectSelection(store.list()[0].id),undefined);
    }finally{await engine.stop();store.close();}
  }
});

test('a checkpointed resource proposal is revalidated on reopen without repeating model execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-resource-receipt-')),db=join(dir,'state.sqlite');let store=new Store(db);store.pilotIntake=true;
  const task=store.create('dm',CONVERSATION,'需要代码资源'),project={path:dir,sandbox:'read-only' as const};let graph=new TaskOrchestrator(store),runs=0,proposals=0;
  const executor:Executor={run:async(_t,_p,h)=>{runs++;h.proposeProject!('code');return 'resource needed';}};
  const hooks={thread:()=>{},progress:()=>{},resolved:()=>{},request:()=>{throw Error('unexpected');},proposeProject:()=>{proposals++;}};
  try{
    await graph.run({...task,projectCandidateGrants:{code:'grant-one'}},project,executor,hooks,AbortSignal.timeout(5000));assert.equal(proposals,1);
    graph.close();store.close();store=new Store(db);graph=new TaskOrchestrator(store);
    await assert.rejects(graph.run({...store.get(task.id)!,projectCandidateGrants:{code:'grant-two'}},project,executor,hooks,AbortSignal.timeout(5000)),/授权已变化/);
    assert.equal(runs,1);assert.equal(proposals,1);
  }finally{graph.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
