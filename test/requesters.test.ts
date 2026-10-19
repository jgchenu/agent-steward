import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewDeliverySetup } from '../src/delivery-preparation.js';
import { baselinePreview } from '../src/baseline.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { buildCard, viewKey } from '../src/channels/cards.js';
import { trustedRequesters, loadConfig } from '../src/config.js';
import { startWorkspaceConsole } from '../src/workspace-console.js';
import { FeishuChannel } from '../src/channels/feishu.js';
import { writePermissionRuntime } from '../src/permission-runtime.js';
import type { Config, Executor, Incoming, View, Intent } from '../src/types.js';

let seq = 0;
const input = (text: string, more: Partial<Incoming> = {}): Incoming => ({id:'msg-'+(++seq),senderId:'ou_guest',chatId:'guest-dm',senderType:'user',chatType:'p2p',text,...more});
const group = {chatType:'group' as const,chatId:'group',botMentioned:true,conversation:{anchorId:'topic',sourceId:'message',scope:'thread' as const,threadId:'thread'}};
const config = (): Config => ({ownerId:'ou_owner',trustedRequesters:[{openId:'ou_guest',name:'Guest'},{openId:'ou_other',name:'Other'}],stateDir:'.',codexCommand:'codex',maxRunMinutes:1,groupChats:true,projects:{
  read:{path:process.cwd(),sandbox:'read-only',label:'Read project'},write:{path:process.cwd(),sandbox:'workspace-write',workspaceMode:'direct',label:'Write project'}
}});
async function until(fn: () => boolean) { for (let n=0;n<300;n++){if(fn())return;await pause(5)}assert.fail('condition not reached'); }
function setup(executor: Executor, path=':memory:') {
  const store=new Store(path), c=config(), sent:Array<{chat:string;text:string;view?:View}>=[];
  const engine=new Engine(store,c,executor,{send:async(chat,text,_id,view)=>{sent.push({chat,text,view});},context:async()=>assert.fail('delegated tasks must not load group history')});
  return {store,c,sent,engine,close:async()=>{await engine.stop();store.close()}};
}
function action(f:ReturnType<typeof setup>,taskId:string,op:Intent['op'],senderId='ou_guest',fields:Record<string,unknown>={}) {
  const task=f.store.get(taskId)!;buildCard(f.store,f.c,task.chatId,{kind:'task',taskId});
  const rows=f.store.db.prepare('SELECT id,intent FROM card_actions ORDER BY rowid DESC').all() as Array<{id:string;intent:string}>;
  const found=rows.find(r=>{const i=JSON.parse(r.intent);return i.op===op&&i.taskId===taskId});assert.ok(found);
  return {id:'callback-'+(++seq),actionId:found.id,senderId,chatId:task.chatId,messageId:'card',fields};
}

test('default remains owner-only; self identity discovery grants no access; bot events ignored',async()=>{
  const f=setup({run:async()=>assert.fail('must not run')});f.c.trustedRequesters=[];
  try {f.engine.receive(input('work'));f.engine.receive(input('/whoami',{senderType:'app'}));await f.engine.flush();assert.equal(f.sent.length,0);
    f.engine.receive(input('/whoami'));await f.engine.flush();assert.match(f.sent[0].text,/ou_guest/);assert.equal(f.store.list().length,0);
  }finally{await f.close()}
});

test('allowlisted person starts immediately, continues own DM, and receives own result without owner approval',async()=>{
  const seen:Array<{id:string;thread:string|null}>=[];const f=setup({run:async(t,_p,h)=>{seen.push({id:t.id,thread:t.threadId});h.thread('session-'+t.id);assert.ok(t.projectCandidates?.includes('write'));return 'answer'}});
  try {const m=input('first');f.engine.receive(m);f.engine.receive(m);await until(()=>f.store.list()[0]?.status==='review');const task=f.store.list()[0];
    assert.equal(seen.length,1);assert.equal(task.requesterId,'ou_guest');assert.equal(task.chatId,'guest-dm');
    f.engine.receive(input('follow up'));await until(()=>seen.length===2&&f.store.get(task.id)?.status==='review');assert.equal(seen[1].id,task.id);assert.equal(seen[1].thread,'session-'+task.id);
    await f.engine.flush();assert.ok(f.sent.some(x=>x.chat==='guest-dm'&&x.view&&'taskId' in x.view&&x.view.taskId===task.id));assert.ok(!f.sent.some(x=>x.chat==='ou_owner'));
  }finally{await f.close()}
});

test('delegates can read and edit authorized projects but cannot upgrade read-only or access console configuration',async()=>{
  const seen:Array<{project:string;mode:string}>=[];const f=setup({run:async t=>{seen.push({project:t.project,mode:t.mode ?? 'read-only'});return 'code result'}});
  try {f.engine.receive(input('/edit read change'));f.engine.receive(input('/edit unknown change'));assert.equal(f.store.list().length,0);
    f.engine.receive(input('/new read inspect'));await until(()=>seen.length===1&&f.store.list().every(t=>t.status==='review'));
    f.engine.receive(input('/edit write change'));await until(()=>seen.length===2&&f.store.list().every(t=>t.status==='review'));assert.deepEqual(seen,[{project:'read',mode:'read-only'},{project:'write',mode:'workspace-write'}]);
    f.c.consoleUrl='http://private-control.example/';f.engine.receive(input('/console'));await f.engine.flush();assert.ok(f.sent.some(x=>x.text.includes('由机器人主人管理')));assert.ok(!f.sent.some(x=>x.text.includes(f.c.consoleUrl!)));
  }finally{await f.close()}
});

test('same group topic separates owner and delegates, including bindings, lists and callbacks',async()=>{
  const seen:string[]=[];const f=setup({run:async(t,_p,h)=>{assert.equal(t.threadId,null);seen.push(t.id);h.thread('s-'+t.id);return 'done'}});
  try {
    const owner=f.store.create('group','__conversation__','owner private task','read-only',group.conversation);f.store.thread(owner.id,'owner-session');f.store.set(owner.id,'review');
    f.engine.receive(input('not mentioned',{...group,botMentioned:false}));assert.equal(f.store.list().length,1);
    for(const senderId of ['ou_guest','ou_other']){f.engine.receive(input('my task',{...group,senderId}));await until(()=>f.store.list().filter(t=>t.requesterId).length===(senderId==='ou_guest'?1:2)&&f.store.list().every(t=>t.status==='review'));}
    assert.equal(new Set(seen).size,2);assert.equal(f.store.conversationTask('group',group.conversation)?.id,owner.id);
    const guest=f.store.conversationTask('group',group.conversation,'ou_guest')!,other=f.store.conversationTask('group',group.conversation,'ou_other')!;assert.notEqual(guest.id,other.id);
    await f.engine.flush();f.sent.length=0;
    for(const target of [owner,other])for(const cmd of ['status','continue','cancel','model','source','publish','done'])f.engine.receive(input('/'+cmd+' '+target.id+' attempt',{...group}));
    f.engine.receive(input('/list',{...group}));await f.engine.flush();assert.ok(!f.sent.some(x=>x.text.includes('owner private task')||x.text.includes(other.id)));
    const list=JSON.stringify(buildCard(f.store,f.c,'group',{kind:'list',requesterId:'ou_guest',conversation:group.conversation}));assert.ok(!list.includes(owner.id));assert.ok(!list.includes(other.id));const targets=[...list.matchAll(/"actionId":"([^"]+)"/g)].map(m=>f.store.getAction(m[1])!.intent.taskId).filter(Boolean);assert.deepEqual(targets,[guest.id]);
    const cb=action(f,other.id,'result');assert.equal(f.engine.handleAction(cb).toast.type,'error');assert.equal(f.store.get(other.id)?.status,'review');
    assert.notEqual(viewKey({kind:'home',requesterId:'ou_guest',conversation:group.conversation}),viewKey({kind:'home',requesterId:'ou_other',conversation:group.conversation}));
  }finally{await f.close()}
});

test('permission approvals require the initiating actor and current card; duplicate acceptance cannot run twice',async()=>{
  let requestId='',answer='';const f=setup({run:async(_t,_p,h)=>new Promise(resolve=>{requestId=h.request({kind:'approval',description:'tool permission',resolve:a=>{answer=a;resolve('done')}})} )});
  try {f.engine.receive(input('/edit write change',{...group}));await until(()=>!!requestId);const task=f.store.list()[0];const cb=action(f,task.id,'approve');
    assert.equal(f.engine.handleAction({...cb,senderId:'ou_other'}).toast.type,'error');assert.equal(answer,'');
    f.engine.receive(input('/approve '+requestId,{...group,senderId:'ou_other'}));assert.equal(answer,'');
    assert.equal(f.engine.handleAction(cb).toast.type,'success');await until(()=>answer==='accept'&&f.store.get(task.id)?.status==='review');
    assert.equal(f.engine.handleAction(cb).toast.type,'error');
    assert.ok(f.store.db.prepare("SELECT body FROM events WHERE kind='response_actor'").all().some(r=>String(r.body).includes('ou_guest')));
  }finally{await f.close()}
});

test('business clarification resumes directly from the same requester',async()=>{
  let calls=0;const f=setup({run:async(_t,_p,h)=>{calls++;if(calls===1){h.askClarification!('Which city?');return 'need detail'}return 'weather'}});
  try {f.engine.receive(input('weather'));await until(()=>f.store.list()[0]?.status==='waiting_input');f.engine.receive(input('Shenzhen'));await until(()=>f.store.list()[0]?.status==='review');assert.equal(calls,2);assert.equal(f.store.list().length,1);
  }finally{await f.close()}
});

test('revocation cancels active work and invalidates old approvals, replies and topic sessions even after re-add',async()=>{
  let requestId='';const f=setup({run:async(_t,_p,h)=>new Promise(resolve=>{requestId=h.request({kind:'approval',description:'approve',resolve:()=>resolve('done')})})});
  try {f.engine.receive(input('work',{...group}));await until(()=>!!requestId);const task=f.store.list()[0],cb=action(f,task.id,'approve');await f.engine.flush();
    f.store.enqueue('group','late reply',{kind:'reply',taskId:task.id});f.store.db.prepare('UPDATE outbox SET due=? WHERE sent=0').run(Date.now()+60_000);
    f.engine.updateProjects({projects:f.c.projects,trustedRequesters:[]});assert.equal(f.store.get(task.id)?.status,'cancelled');assert.equal(f.store.get(task.id)?.requesterRevoked,1);
    f.engine.updateProjects({projects:f.c.projects,trustedRequesters:[{name:'Guest',openId:'ou_guest'}]});assert.equal(f.engine.handleAction(cb).toast.type,'error');
    f.store.db.prepare('UPDATE outbox SET due=0').run();await f.engine.flush();assert.ok(!f.sent.some(x=>x.text==='late reply'));
    f.store.enqueue('group','late after re-add',{kind:'reply',taskId:task.id});await f.engine.flush();assert.ok(!f.sent.some(x=>x.text==='late after re-add'));assert.equal(f.store.conversationTask('group',group.conversation,'ou_guest'),undefined);
    f.engine.receive(input('/continue '+task.id+' revive',{...group}));assert.equal(f.store.get(task.id)?.status,'cancelled');
    const next=f.store.create('group','__conversation__','fresh','read-only',group.conversation,'ou_guest');assert.equal(f.store.conversationTask('group',group.conversation,'ou_guest')?.id,next.id);
  }finally{await f.close()}
});

test('requester ownership survives database restart and project handoff',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-delegate-')),path=join(dir,'store.sqlite');let store=new Store(path);
  try {const task=store.create('group','__conversation__','text','read-only',group.conversation,'ou_guest');store.set(task.id,'review');
    const next=store.handoff(task,'write','code','workspace-write',group.conversation);assert.equal(next.requesterId,'ou_guest');store.close();store=new Store(path);
    assert.equal(store.conversationTask('group',group.conversation,'ou_guest')?.id,next.id);assert.equal(store.conversationTask('group',group.conversation),undefined);
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('delegated card navigation remains actor-bound in original DM and group deliveries',async()=>{
  const f=setup({run:async()=>''}),channel=new FeishuChannel('fake','fake',f.store,f.c),created:any[]=[],replied:any[]=[];
  (channel as any).client={im:{message:{create:async(p:any)=>{created.push(p);return {code:0,data:{message_id:'created-'+created.length}}},reply:async(p:any)=>{replied.push(p);return {code:0,data:{message_id:'reply-'+replied.length}}}}}};
  try {
    await channel.send('guest-dm','home','a',{kind:'home',requesterId:'ou_guest'});assert.equal(created[0].params.receive_id_type,'chat_id');assert.equal(created[0].data.receive_id,'guest-dm');
    const rows=f.store.db.prepare('SELECT intent FROM card_actions').all() as Array<{intent:string}>;assert.ok(rows.length);assert.ok(rows.every(r=>JSON.parse(r.intent).requesterId==='ou_guest'));
    const task=f.store.create('group','read','task','read-only',group.conversation,'ou_guest');await channel.send('group','result','b',{kind:'reply',taskId:task.id,requesterId:'ou_guest'});
    await channel.send('group','result','b',{kind:'reply',taskId:task.id,requesterId:'ou_guest'});assert.equal(replied.length,1);assert.equal(replied[0].path.message_id,'topic');
  }finally{channel.close();await f.close()}
});
test('trusted requester config is explicit, bounded and identity based',()=>{
  assert.deepEqual(trustedRequesters(undefined),[]);assert.deepEqual(trustedRequesters([{openId:'ou_a',name:' A '}]),[{openId:'ou_a',name:'A'}]);
  for(const value of [null,{},['ou_a'],[{openId:'*',name:'everyone'}],[{openId:'ou_a',name:''}],[{openId:'ou_a',name:'A'},{openId:'ou_a',name:'B'}],Array.from({length:51},(_,i)=>({openId:'ou_'+i,name:'A'}))])assert.throws(()=>trustedRequesters(value));
});


test('console saves and removes identity grants atomically; old clients preserve them; applied state is separate',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-people-console-')),file=join(dir,'config.json');const owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='ou_owner';
  writeFileSync(file,JSON.stringify({projects:{},stateDir:dir}));const app=await startWorkspaceConsole(file,0,async()=>[],async()=>[]);
  try {
    const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)![1];assert.ok(html.includes('谁可以使用分身'));new Function(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]);
    const headers={'X-Steward-Console':token,Origin:app.url.slice(0,-1),'Content-Type':'application/json'};
    const state=async()=>await(await fetch(app.url+'api/state',{headers})).json() as any;
    const save=(body:unknown,h=headers)=>fetch(app.url+'api/grants',{method:'POST',headers:h,body:JSON.stringify(body)});
    let s=await state();assert.deepEqual(s.trustedRequesters,[]);const before=readFileSync(file,'utf8');
    assert.equal((await save({revision:s.revision,grants:[],trustedRequesters:[{name:'A',openId:'ou_a'}]},{...headers,Origin:'https://invalid.example'})).status,403);
    assert.equal((await save({revision:s.revision,grants:[],trustedRequesters:[{name:'A',openId:'*'}]})).status,400);assert.equal(readFileSync(file,'utf8'),before);
    const people=[{name:'A',openId:'ou_a'}];assert.equal((await save({revision:s.revision,grants:[],trustedRequesters:people})).status,200);
    assert.deepEqual(loadConfig(file).trustedRequesters,people);assert.equal((await save({revision:s.revision,grants:[],trustedRequesters:[]})).status,400);
    writePermissionRuntime(dir,{permissionMode:'ask',active:false,trustedRequesterIds:[]});s=await state();assert.deepEqual(s.runtime.trustedRequesterIds,[]);assert.deepEqual(s.trustedRequesters,people);
    assert.equal((await save({revision:s.revision,grants:[]})).status,200);assert.deepEqual(loadConfig(file).trustedRequesters,people);
    s=await state();assert.equal((await save({revision:s.revision,grants:[],trustedRequesters:[]})).status,200);assert.deepEqual(loadConfig(file).trustedRequesters,[]);
  }finally{await new Promise<void>(resolve=>app.server.close(()=>resolve()));if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true})}
});


test('owner can stop delegated work even when the same group topic has an owner task',async()=>{
  let started=false;const f=setup({run:async(_t,_p,_h,signal)=>new Promise((_,reject)=>{started=true;signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true})})});
  try {const own=f.store.create('group','__conversation__','owner task','read-only',group.conversation);f.store.set(own.id,'review');
    f.engine.receive(input('guest task',{...group}));await until(()=>started);const task=f.store.list().find(t=>t.requesterId)!;
    f.engine.receive(input('/cancel '+task.id,{...group,senderId:'ou_owner'}));assert.equal(f.store.get(task.id)?.status,'cancelled');assert.equal(f.store.get(own.id)?.status,'review');
  }finally{await f.close()}
});

test('queued delegated group work cannot run when group mode is disabled',async()=>{
  let calls=0;const f=setup({run:async()=>{calls++;return 'unexpected'}});f.c.groupChats=false;
  try {const task=f.store.create('group','__conversation__','queued','read-only',group.conversation,'ou_guest');f.engine.start();await until(()=>f.store.get(task.id)?.status==='failed');assert.equal(calls,0);
  }finally{await f.close()}
});


test('delegated baseline proposals cannot rewrite global delivery configuration',async()=>{
  const f=setup({run:async()=>''});
  try {const task=f.store.create('guest-dm','write','code','workspace-write',undefined,'ou_guest');
    const proposal={ref:'origin/main',migrateChanges:false,delivery:{repository:'test/repo',baseBranch:'main',checks:[{name:'check',command:'node',args:['--version'],timeoutSeconds:10}]}};
    await assert.rejects(previewDeliverySetup(f.c,task,f.c.projects.write,proposal,new AbortController().signal),/仅由机器人主人/);
    await assert.rejects(baselinePreview(f.store,{...task,baselineOptions:proposal},f.c.projects.write,'origin/main',new AbortController().signal,f.c),/不能修改/);
    assert.equal(f.c.projects.write.worktree,undefined);
  }finally{await f.close()}
});
