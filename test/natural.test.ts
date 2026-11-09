import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout} from 'node:timers/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {buildCard} from '../src/channels/cards.js';
import {FeishuChannel,parseFeishuEvent} from '../src/channels/feishu.js';
import type {Config, Incoming, Task, View} from '../src/types.js';
const cfg=():Config=>({ownerId:'owner',stateDir:'.',codexCommand:'codex',maxRunMinutes:1,groupChats:true,defaultProject:'general',projects:{
  general:{path:'.',sandbox:'read-only',label:'通用分析',description:'讨论、归纳与写作'},
  code:{path:'/private/code',sandbox:'workspace-write',label:'代码项目',naturalMode:'workspace-write',worktree:{baseRef:'feature/current',checks:[]}},
}});
let seq=0;const incoming=(text:string):Incoming=>({id:'msg'+(++seq),senderId:'owner',senderType:'user',chatId:'group',chatType:'group',botMentioned:true,text,conversation:{anchorId:'root'+seq,sourceId:'msg'+seq,scope:'chat',cutoff:'1000'}});
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await setTimeout(5)}assert.fail('timeout')}
const snapshot={summary:'one context',capturedAt:'',truncated:false,messages:[]};
const dm=(text:string,extra:Partial<Incoming>={}):Incoming=>({id:'dm-'+(++seq),senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text,...extra});

test('DM focus survives restart, follows trusted handoff and stays isolated by chat and actor',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-dm-')),file=join(dir,'state.sqlite');let store=new Store(file);
 try{
  const owner=store.create('dm','general','owner'),guest=store.create('dm','general','guest','read-only',undefined,'guest');
  store.focusDirectTask(owner);store.focusDirectTask(guest);store.set(owner.id,'review');
  const next=store.handoff(store.get(owner.id)!,'code','continue','read-only');
  store.close();store=new Store(file);
  assert.equal(store.directTask('dm')!.id,next.id);assert.equal(store.directTask('dm','guest')!.id,guest.id);assert.equal(store.directTask('other-dm'),undefined);
  store.db.prepare('UPDATE tasks SET requesterRevoked=1 WHERE id=?').run(guest.id);assert.equal(store.directTask('dm','guest'),undefined);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('DM clarification, result and followup are ordinary dialogue; unsolicited alerts do not steal focus',async()=>{
 const store=new Store(':memory:'),sent:Array<{text:string;view?:View}>=[],runs:Task[]=[];
 const engine=new Engine(store,cfg(),{run:async(t,_p,h)=>{
  runs.push(t);h.thread('session');
  if(runs.length===1)return new Promise(resolve=>h.request({kind:'input',description:'写给谁看？',resolve:a=>resolve('写给'+a)}));
  return '已按补充修改';
 }},{send:async(_c,text,_id,view)=>{sent.push({text,view})}});
 try{
  engine.receive(dm('帮我写一段介绍'));await until(()=>store.list()[0]?.status==='waiting_input');await engine.flush();
  assert.ok(sent.every(x=>x.view?.kind==='reply'));assert.equal(sent.at(-1)!.text,'写给谁看？');
  engine.receive(dm('新用户'));await until(()=>store.list()[0]?.status==='review');await engine.flush();
  assert.ok(sent.every(x=>x.view?.kind==='reply'));
  assert.equal(sent.at(-1)!.text,'写给新用户');assert.doesNotMatch(sent.at(-1)!.text,/验收|\/done|表单/);
  const original=store.list()[0],alert=store.create('dm','general','unsolicited alert');store.set(alert.id,'review');
  engine.receive(dm('再简短一点'));await until(()=>runs.length===2 && store.get(original.id)?.status==='review');
  assert.equal(runs[1].id,original.id);assert.equal(runs[1].threadId,'session');assert.equal(store.get(alert.id)!.prompt,'unsolicited alert');
 }finally{await engine.stop();store.close()}
});

test('DM quote selects its bound task over focus; foreign actor quotes never inherit owner work',async()=>{
 const store=new Store(':memory:'),config=cfg(),runs:Task[]=[];
 const engine=new Engine(store,config,{run:async t=>{runs.push(t);return 'done'}},{send:async()=>{}});
 try{
  engine.receive(dm('first'));await until(()=>store.list()[0]?.status==='review');const first=store.list()[0];
  store.bindConversation('dm','first-reply',first.id);
  engine.receive(dm('/new general second'));await until(()=>store.list().length===2 && store.list()[1].status==='review');const second=store.list()[1];
  assert.equal(store.directTask('dm')!.id,second.id);
  const raw={sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:'quoted-input',chat_id:'dm',chat_type:'p2p',message_type:'text',parent_id:'first-reply',content:JSON.stringify({text:'继续第一件事'})}};
  const parsed=parseFeishuEvent(raw)!;assert.equal(parsed.replyToMessageId,'first-reply');assert.equal(parsed.conversation,undefined);
  engine.receive(parsed);await until(()=>runs.length===3 && store.get(first.id)?.status==='review');
  assert.equal(runs[2].id,first.id);assert.equal(store.directTask('dm')!.id,first.id);assert.equal(store.get(second.id)!.prompt,'second');
  engine.receive({...dm('继续',{senderId:'stranger',replyToMessageId:'first-reply'})});assert.equal(runs.length,3);
 }finally{await engine.stop();store.close()}
});

test('natural DM yes never accepts a permission request or explicit tool form',async()=>{
 for(const kind of ['approval','input'] as const){
  const store=new Store(':memory:'),requests:Array<{id:string;resolved:number}>=[];
  const engine=new Engine(store,cfg(),{run:async(_t,_p,h,signal)=>new Promise((resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   const item={id:'',resolved:0};item.id=h.request({kind,explicit:true,description:'Explicit permission boundary',resolve:a=>{item.resolved++;resolve(a)}});requests.push(item);
  })},{send:async()=>{}});
  try{engine.receive(dm('执行'));await until(()=>requests.length===1);engine.receive(dm('好的'));await engine.flush();
   assert.equal(requests[0].resolved,0);assert.equal(store.getRequest(requests[0].id)!.status,'pending');assert.equal(store.list().length,1);
  }finally{await engine.stop();store.close()}
 }
});

test('DM notices and long replies use new posts, deduplicate retries, and persist task quote bindings',async()=>{
 const store=new Store(':memory:'),channel=new FeishuChannel('fake','fake',store,cfg()),sent:any[]=[];
 (channel as any).client={im:{message:{create:async(p:any)=>{sent.push(p);return {code:0,data:{message_id:'post-'+sent.length}}},patch:async()=>{throw Error('Ordinary speech must not patch a card')}}}};
 try{
  store.saveCardMessage('dm','notice','old-card');
  await channel.send('dm','噪声样本与已确认的来源一致。','digest',{kind:'notice',fresh:true});
  await channel.send('dm','噪声样本与已确认的来源一致。','digest',{kind:'notice',fresh:true});assert.equal(sent.length,1);
  const t=store.create('dm','general','question');
  await channel.send('dm','完整结果。'.repeat(3000),'result',{kind:'reply',taskId:t.id});
  assert.ok(sent.length>2);assert.ok(sent.every(p=>p.data.msg_type==='post' && !p.data.content.includes('派新任务')));
  assert.equal(store.conversationTask('dm',{anchorId:'post-2',sourceId:'quote',scope:'chat'})!.id,t.id);
  assert.equal(store.directTask('dm'),undefined); // Outbound automation never selects the human's current task.
 }finally{channel.close();store.close()}
});

test('ordinary task entry and followup have no forms, while explicit tool inputs retain their boundary',()=>{
 const store=new Store(':memory:');try{
  const t=store.create('dm','general','work');store.set(t.id,'review');
  for(const view of [{kind:'home'},{kind:'followup',taskId:t.id}] as View[])assert.doesNotMatch(JSON.stringify(buildCard(store,cfg(),'dm',view)),/"tag":"form"/);
  const id=store.request(t.id,'input','Who is the audience?');store.set(t.id,'waiting_input');
  assert.doesNotMatch(JSON.stringify(buildCard(store,cfg(),'dm',{kind:'task',taskId:t.id})),/"tag":"form"/);
  store.event(t.id,'input_explicit',id);
  assert.match(JSON.stringify(buildCard(store,cfg(),'dm',{kind:'task',taskId:t.id})),/"tag":"form"/);
 }finally{store.close()}
});
test('natural task bypasses forms, acknowledges before inference, preserves full text and only posts a final card',async()=>{
 const store=new Store(':memory:'),order:string[]=[],sent:View[]=[],tasks:Task[]=[];const config=cfg();
 const engine=new Engine(store,config,{run:async t=>{order.push('run');tasks.push(t);return 'result'}},{acknowledge:async()=>{order.push('reaction')},context:async()=>{order.push('context');return snapshot},send:async(_c,_t,_id,v)=>{if(v)sent.push(v)}});
 try{const text='帮我分析讨论'.repeat(300),m=incoming(text);engine.receive({...m,senderId:'other'});assert.equal(order.length,0);engine.receive(m);engine.receive(m);await until(()=>store.list()[0]?.status==='review');await engine.flush();
 assert.deepEqual(order,['reaction','context','run']);assert.equal(tasks[0].project,'__conversation__');assert.equal(tasks[0].prompt,text);assert.equal(tasks[0].mode,'read-only');assert.equal(sent.length,1);assert.equal(sent[0].kind,'reply');
 }finally{await engine.stop();store.close()}
});
test('bare mention asks a short question; product references do not force resources and explicit choice keeps the full task',async()=>{
 const store=new Store(':memory:'),sent:Array<{view?:View,text:string}>=[];const config=cfg();const engine=new Engine(store,config,{run:async()=> 'done'},{send:async(_c,text,_i,view)=>{sent.push({view,text})},context:async()=>snapshot});
 try{engine.receive(incoming(''));await engine.flush();assert.equal(store.list().length,0);assert.match(sent[0].text,/直接告诉我/);assert.equal(sent[0].view?.kind,'notice');
 const text=('比较通用分析和代码项目：'+'内容'.repeat(8000)).slice(0,16000),m=incoming(text);engine.receive(m);await until(()=>store.list()[0]?.status==='review');
 const task=store.list()[0];assert.equal(task.project,'__conversation__');assert.deepEqual(task.resources,[]);
 const view:View={kind:'choose-project',draft:text,choices:['general','code'],selectionKey:'explicit-resource',fromTaskId:task.id,revision:task.updatedAt,conversation:m.conversation};
 const card=buildCard(store,config,'group',view) as any;const button=card.body.elements.find((e:any)=>e.tag==='button');const actionId=button.behaviors[0].value.actionId;
 const click={id:'click',actionId,senderId:'owner',chatId:'group',messageId:'card',fields:{project:'forged',body:'forged'}};
 assert.equal(engine.handleAction({...click,senderId:'other'}).toast.type,'error');engine.handleAction(click);await until(()=>store.list().length===2&&store.list().every(t=>t.status==='review'));
 assert.match(store.list()[1].prompt,/比较通用分析和代码项目/);engine.handleAction({...click,id:'click2'});assert.equal(store.list().length,2);
 const home=JSON.stringify(buildCard(store,config,'group',{kind:'home',conversation:incoming('').conversation}));assert.match(home,/通用分析/);assert.doesNotMatch(home,/\/private\/code/);
 assert.match(JSON.stringify(buildCard(store,config,'dm',{kind:'home'})),/\/private\/code/);
 }finally{await engine.stop();store.close()}
});
test('revoking a project interrupts active work and an old project-choice action cannot restore access',async()=>{
 const store=new Store(':memory:');const config=cfg();let started=false;
 const engine=new Engine(store,config,{run:async(_t,_p,_h,signal)=>new Promise((_,reject)=>{started=true;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})},{send:async()=>{},context:async()=>snapshot});
 try{const actionId=store.action('group',{op:'dispatch',project:'code',prompt:'edit code',selectionKey:'revoked',conversation:incoming('').conversation});engine.receive(incoming('/edit code 改进代码项目'));await until(()=>started);
 assert.equal(store.list()[0].mode,'workspace-write');engine.updateProjects({projects:{general:config.projects.general},defaultProject:'general'});await until(()=>store.list()[0]?.status==='failed');
 assert.equal(engine.handleAction({id:'old',actionId,senderId:'owner',chatId:'group',messageId:'card',fields:{}}).toast.type,'error');
 }finally{await engine.stop();store.close()}
});
test('reaction failure falls back to thread acknowledgement without preventing work; reaction success deduplicates',async()=>{
 const store=new Store(':memory:'),sent:string[]=[];const config=cfg();let runs=0;
 const engine=new Engine(store,config,{run:async()=>{runs++;return 'done'}},{acknowledge:async()=>{throw Error('missing scope')},context:async()=>snapshot,send:async(_c,text)=>{sent.push(text)}});
 try{engine.receive(incoming('分析一下'));await until(()=>store.list()[0]?.status==='review');await engine.flush();assert.equal(runs,1);assert.ok(sent.includes('收到，正在处理。'));
 const channel=new FeishuChannel('fake','fake',store,config);let reactions=0;(channel as any).client={request:async(p:any)=>{assert.equal(p.data.reaction_type.emoji_type,'OnIt');reactions++;return{code:0,data:{reaction_id:'reaction'}}}};
 try{await channel.acknowledge(store.list()[0],new AbortController().signal);await channel.acknowledge(store.list()[0],new AbortController().signal);assert.equal(reactions,1)}finally{channel.close()}
 }finally{await engine.stop();store.close()}
});

test('ordinary questions and answers use thread prose while permission decisions keep explicit controls',async()=>{
 const store=new Store(':memory:'),sent:Array<{text:string;view?:View}>=[];let asks=0;
 const engine=new Engine(store,cfg(),{run:async(_t,_p,h)=>new Promise(resolve=>{
   asks++;h.request({kind:'input',description:'你希望这段内容写给谁看？',resolve:answer=>resolve('明白，我会面向'+answer+'来写。')});
 })},{send:async(_c,text,_id,view)=>{sent.push({text,view})},context:async()=>snapshot,acknowledge:async()=>{}});
 try{const first=incoming('帮我改写这段文字');engine.receive(first);await until(()=>store.list()[0]?.status==='waiting_input');await engine.flush();
 assert.equal(sent[0].view?.kind,'reply');assert.equal(sent[0].text,'你希望这段内容写给谁看？');
 engine.receive({...incoming('新用户'),botMentioned:false,conversation:{...first.conversation!,sourceId:'followup',scope:'thread',threadId:'thread'}});
 await until(()=>store.list()[0]?.status==='review');await engine.flush();assert.equal(asks,1);assert.equal(sent.at(-1)!.view?.kind,'reply');assert.match(sent.at(-1)!.text,/新用户/);assert.doesNotMatch(sent.at(-1)!.text,/验收|任务ID|\/done/);
 }finally{await engine.stop();store.close()}
});

test('complete Markdown answers become bounded thread posts and partial delivery retries do not duplicate earlier chunks',async()=>{
 const store=new Store(':memory:'),config=cfg(),channel=new FeishuChannel('fake','fake',store,config);const sent:any[]=[];const attempts:any[]=[];let failed=false;
 (channel as any).client={im:{message:{reply:async(p:any)=>{assert.ok(p.data.uuid.length<=50,'Feishu uuid max length is 50');attempts.push(p);if(sent.length===1&&!failed){failed=true;throw Error('network')}sent.push(p);return{code:0,data:{message_id:'post'+sent.length,thread_id:'topic'}}},patch:async()=>{throw Error('post must not patch card')}}}};
 try{const m=incoming('分析一下'),task=store.create('group','general','分析一下','read-only',m.conversation);const text='**完整回答**\n'+ '这是完整内容，不需要点击查看全文。😀'.repeat(2000)+'\n<at user_id="all">全体</at>';
 const view:View={kind:'reply',taskId:task.id};await assert.rejects(channel.send('group',text,'delivery',view),/network/);await channel.send('group',text,'delivery',view);
 assert.equal(attempts[1].data.uuid,attempts[2].data.uuid);assert.ok(sent.length>1);assert.equal(new Set(sent.map(p=>p.data.uuid)).size,sent.length);
 const all=sent.map(p=>{assert.equal(p.data.msg_type,'post');assert.equal(p.data.reply_in_thread,true);assert.equal(p.path.message_id,m.conversation!.anchorId);assert.ok(Buffer.byteLength(p.data.content)<12500);return JSON.parse(p.data.content).zh_cn.content[0][0].text}).join('');
 assert.equal(all,text.replace(/</g,'&lt;').replace(/>/g,'&gt;'));assert.equal(store.conversationTask('group',{...m.conversation!,anchorId:'unknown',parentId:'post1'})!.id,task.id);
 }finally{channel.close();store.close()}
});
