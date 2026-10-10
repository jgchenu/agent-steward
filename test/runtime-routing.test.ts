import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout} from 'node:timers/promises';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {buildCard} from '../src/channels/cards.js';
import {taskInput} from '../src/channels/context.js';
import {namedProjects} from '../src/routing.js';
import type {Config, Incoming, Task, View} from '../src/types.js';
const config=():Config=>({ownerId:'owner',stateDir:'.',codexCommand:'codex',maxRunMinutes:1,groupChats:true,defaultProject:'general',projects:{
 general:{path:'/general',label:'通用分析',sandbox:'read-only'},
 code:{path:'/code',label:'repository-name',aliases:['ProductName','产品甲'],sandbox:'workspace-write',naturalMode:'workspace-write',worktree:{baseRef:'feature/current',checks:[]}},
 other:{path:'/other',label:'另一个项目',aliases:['OtherProduct'],sandbox:'read-only'},
}});
const message=(id:string,text:string):Incoming=>({id,text,senderId:'owner',senderType:'user',chatId:'group',chatType:'group',botMentioned:true,conversation:{anchorId:'root',sourceId:id,threadId:'topic',scope:'thread'}});
async function until(fn:()=>boolean){for(let i=0;i<200;i++){if(fn())return;await setTimeout(5)}assert.fail('timeout')}
function harness(c=config()){
 const store=new Store(':memory:'),runs:Task[]=[],sent:Array<{text:string;view?:View}>=[];
 const engine=new Engine(store,c,{run:async(t,_p,h)=>{runs.push(structuredClone(t));h.thread('session-'+runs.length);return 'done'}},{context:async()=>({capturedAt:'',truncated:false,messages:[],summary:''}),acknowledge:async()=>{},send:async(_c,text,_id,view)=>{sent.push({text,view})}});
 return{store,engine,c,runs,sent,close:async()=>{await engine.stop();store.close()}};
}
test('product aliases route case-insensitively only within grants, without substring matches',async()=>{
 const h=harness();try{
  assert.deepEqual(namedProjects(h.c,'PRODUCTNAME 这个 admin 要调整'),['code']);
  assert.deepEqual(namedProjects(h.c,'产品甲看看'),['code']);
  assert.deepEqual(namedProjects(h.c,'NotProductName'),[]);
  h.engine.receive(message('one','ProductName 这个 admin 每根柱子显示平台占比'));
  await until(()=>h.store.list()[0]?.status==='review');
  assert.equal(h.runs[0].project,'code');assert.equal(h.runs[0].mode,'workspace-write');
  assert.match(taskInput(h.runs[0]),/ProductName/);assert.doesNotMatch(taskInput(h.runs[0]),/\/other/);
  delete h.c.projects.code;assert.deepEqual(namedProjects(h.c,'ProductName'),[]);
 }finally{await h.close()}
});
test('a previously misrouted discussion can move to a granted product in the same topic, retaining owner requirements but starting a new session',async()=>{
 const h=harness();try{
  const original='请调整 ProductName 的柱状图，展示每个平台的数量';delete h.c.projects.code.aliases;
  h.engine.receive(message('one',original));await until(()=>h.store.list()[0]?.status==='review');const old=h.store.list()[0];
  h.engine.updateProjects({...h.c,projects:{...h.c.projects,code:{...h.c.projects.code,aliases:['ProductName']}}});
  h.engine.receive({...message('two','继续处理 ProductName 的刚才需求'),botMentioned:true});
  await until(()=>h.runs.length===2&&h.store.list().every(t=>t.status==='review'));await h.engine.flush();
  const next=h.store.conversationTask('group',message('three','').conversation)!;
  assert.notEqual(next.id,old.id);assert.equal(next.project,'code');assert.equal(h.runs[1].threadId,null);assert.match(h.runs[1].prompt,/展示每个平台的数量/);
  assert.equal(h.store.get(old.id)!.project,'__conversation__');assert.equal(h.store.get(old.id)!.threadId,'session-1');
  h.store.bindConversation('group','late-reply',old.id);
  assert.equal(h.store.conversationTask('group',{anchorId:'root',sourceId:'three',parentId:'late-reply',scope:'thread'})!.id,next.id);
  h.engine.receive({...message('three','继续补充测试'),botMentioned:true});await until(()=>h.runs.length===3&&h.store.get(next.id)?.status==='review');
  assert.equal(h.runs[2].id,next.id);assert.equal(h.runs[2].threadId,'session-2');
  const count=h.runs.length;h.engine.receive({...message('three','重复消息'),botMentioned:true});await h.engine.flush();assert.equal(h.runs.length,count);
 }finally{await h.close()}
});
test('switching repositories preserves old delivery and worktree, resets the execution session, and invalidates old controls',async()=>{
 const h=harness();try{
  h.engine.receive(message('one','ProductName 分析'));await until(()=>h.store.list()[0]?.status==='review');const old=h.store.list()[0];
  const workspace={taskId:old.id,source:'/code',path:'/isolated/code',branch:'steward/'+old.id,baseRef:'feature/current',baseSha:'abc'};
  h.store.saveWorkspace(workspace);const actionId=h.store.action('group',{op:'continue',taskId:old.id,revision:old.updatedAt,conversation:old.conversation});
  h.engine.receive({...message('two','OtherProduct 看看文档'),botMentioned:true});await until(()=>h.runs.length===2&&h.store.list().every(t=>t.status==='review'));
  const next=h.store.conversationTask('group',message('x','').conversation)!;
  assert.equal(next.project,'other');assert.equal(next.mode,'read-only');assert.equal(h.runs[1].threadId,null);assert.deepEqual(h.store.workspace(old.id),workspace);assert.equal(h.store.workspace(next.id),undefined);
  assert.equal(h.engine.handleAction({id:'old',senderId:'owner',chatId:'group',messageId:'card',actionId,fields:{body:'继续修改'}}).toast.type,'error');
  h.engine.receive(message('old-command','/continue '+old.id+' old'));await h.engine.flush();assert.equal(h.runs.length,2);
 }finally{await h.close()}
});
test('ambiguous aliases require one owner choice; stale and revoked choices cannot switch the topic',async()=>{
 const h=harness();try{
  h.engine.receive(message('one','讨论一下'));await until(()=>h.store.list()[0]?.status==='review');
  h.c.projects.other.aliases=['ProductName'];
  h.engine.receive({...message('two','ProductName 改进图表'),botMentioned:true});await h.engine.flush();const view=h.sent.at(-1)!.view!;assert.equal(view.kind,'choose-project');assert.equal(h.runs.length,1);
  const card=buildCard(h.store,h.c,'group',view) as any;const ids=card.body.elements.filter((e:any)=>e.tag==='button').map((e:any)=>e.behaviors[0].value.actionId);
  const action={id:'choice',senderId:'owner',chatId:'group',messageId:'card',actionId:ids[0],fields:{project:'forged'}};
  assert.equal(h.engine.handleAction({...action,senderId:'other'}).toast.type,'error');
  assert.equal(h.engine.handleAction(action).toast.type,'success');await until(()=>h.runs.length===2&&h.store.list().every(t=>t.status==='review'));
  assert.equal(h.runs[1].project,'code');assert.equal(h.engine.handleAction({...action,id:'second',actionId:ids[1]}).toast.type,'error');
  h.engine.receive({...message('three','ProductName 继续'),botMentioned:true});await h.engine.flush();const last=buildCard(h.store,h.c,'group',h.sent.at(-1)!.view!) as any;
  const revoked=last.body.elements.find((e:any)=>e.tag==='button').behaviors[0].value.actionId;delete h.c.projects.code;
  assert.equal(h.engine.handleAction({...action,id:'revoked',actionId:revoked}).toast.type,'error');
 }finally{await h.close()}
});
test('running approvals and non-owner messages cannot initiate a project handoff',async()=>{
 const c=config(),store=new Store(':memory:');let runs=0;
 const engine=new Engine(store,c,{run:async(_t,_p,h,signal)=>new Promise((_resolve,reject)=>{runs++;h.request({kind:'approval',description:'Approve tool',resolve:()=>{}});signal.addEventListener('abort',()=>reject(Error('stop')),{once:true})})},{context:async()=>({capturedAt:'',truncated:false,messages:[],summary:''}),send:async()=>{}});
 try{
  engine.receive(message('one','ProductName 修改'));await until(()=>store.list()[0]?.status==='waiting_approval');
  engine.receive({...message('two','OtherProduct 修改'),botMentioned:true});engine.receive({...message('three','OtherProduct 修改'),senderId:'other'});await engine.flush();
  assert.equal(runs,1);assert.equal(store.list().length,1);assert.equal(store.requests(store.list()[0].id).length,1);
 }finally{await engine.stop();store.close()}
});
