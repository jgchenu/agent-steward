import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { buildCard, viewKey } from '../src/channels/cards.js';
import { submission, type Submission } from '../src/submissions.js';
import { trustedRequesters, loadConfig } from '../src/config.js';
import { startWorkspaceConsole } from '../src/workspace-console.js';
import { FeishuChannel } from '../src/channels/feishu.js';
import { writePermissionRuntime } from '../src/permission-runtime.js';
import type { Config, Executor, Incoming, View } from '../src/types.js';

let seq = 0;
const input = (text: string, more: Partial<Incoming> = {}): Incoming => ({id:'msg-'+(++seq),senderId:'ou_guest',chatId:'guest-dm',senderType:'user',chatType:'p2p',text,...more});
const config = (): Config => ({ownerId:'ou_owner',trustedRequesters:[{openId:'ou_guest',name:'Guest'},{openId:'ou_other',name:'Other'}],stateDir:'.',codexCommand:'codex',maxRunMinutes:1,groupChats:true,projects:{secret:{path:process.cwd(),sandbox:'read-only',label:'Secret project'}}});
async function until(fn: () => boolean) { for (let n=0;n<200;n++){if(fn())return;await pause(5)}assert.fail('condition not reached'); }
function setup(executor: Executor, path=':memory:') {
  const store=new Store(path), c=config(), sent:Array<{chat:string;text:string;view?:View}>=[];
  const engine=new Engine(store,c,executor,{send:async(chat,text,_id,view)=>{sent.push({chat,text,view});}});
  return {store,c,sent,engine,close:async()=>{await engine.stop();store.close()}};
}
function pending(store:Store): Submission {return store.db.prepare("SELECT * FROM submissions WHERE status='pending' ORDER BY rowid DESC LIMIT 1").get() as unknown as Submission;}
function act(f:ReturnType<typeof setup>, id:string, accept=true, overrides:Record<string,unknown>={}) {
  buildCard(f.store,f.c,'ou_owner',{kind:'submission',submissionId:id});
  const actions=f.store.db.prepare('SELECT id,intent FROM card_actions ORDER BY rowid DESC').all() as Array<{id:string;intent:string}>;
  const a=actions.find(x=>{const i=JSON.parse(x.intent);return i.submissionId===id&&i.op===(accept?'accept-submission':'reject-submission')})!;
  assert.ok(a);
  f.store.saveCardMessage('ou_owner',viewKey({kind:'submission',submissionId:id}),'card-'+id);
  return f.engine.handleAction({id:'callback-'+(++seq),actionId:a.id,senderId:'ou_owner',chatId:'owner-dm',messageId:'card-'+id,fields:{},...overrides});
}

test('default remains owner-only; self identity command grants no access; bot events stay ignored',async()=>{
  const f=setup({run:async()=>assert.fail('must not run')});f.c.trustedRequesters=[];
  try {f.engine.receive(input('do work'));f.engine.receive(input('/whoami',{senderType:'app'}));await f.engine.flush();assert.equal(f.sent.length,0);
    f.engine.receive(input('/whoami'));await f.engine.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/ou_guest/);assert.equal(f.store.list().length,0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM submissions').get()!.n,0);
  }finally{await f.close()}
});

test('allowlisted guest submits but cannot run commands, inspect owner tasks, or approve; duplicate intake and decisions are idempotent',async()=>{
  let calls=0;const f=setup({run:async task=>{calls++;assert.equal(task.chatId,'owner-dm');assert.equal(task.requesterId,'ou_guest');assert.equal(task.projectCandidates,undefined);assert.deepEqual(JSON.parse(task.routingContext!).availableProjects,[]);return 'guest answer'}});
  try {
    for(const text of ['/approve hidden','/list','/status hidden','/edit secret edit','/console'])f.engine.receive(input(text));
    assert.equal(f.store.list().length,0);assert.equal(pending(f.store),undefined);
    const m=input('summarize this text');f.engine.receive(m);f.engine.receive(m);const s=pending(f.store);assert.ok(s);assert.equal(calls,0);
    assert.equal(act(f,s.id,true,{senderId:'ou_guest'}).toast.type,'error');assert.equal(act(f,s.id,true,{messageId:'wrong'}).toast.type,'error');assert.equal(calls,0);
    assert.equal(act(f,s.id).toast.type,'success');await until(()=>f.store.list()[0]?.status==='review');await f.engine.flush();
    assert.equal(calls,1);assert.equal(submission(f.store,s.id)?.status,'completed');
    assert.ok(f.sent.some(x=>x.chat==='guest-dm'&&x.text==='guest answer'&&x.view?.kind==='requester-reply'));
    assert.equal(act(f,s.id).toast.type,'error');assert.equal(calls,1);
    assert.ok(f.sent.filter(x=>x.chat==='guest-dm').every(x=>x.view?.kind==='requester-reply'));
  }finally{await f.close()}
});

test('shared group guests never reuse another guest or owner session; only explicit mentions submit',async()=>{
  const sessions:string[]=[];const f=setup({run:async(task,_p,hooks)=>{assert.equal(task.threadId,null);sessions.push(task.id);hooks.thread('codex-'+task.id);return 'answer'}});
  const group={chatType:'group' as const,chatId:'group',botMentioned:true,conversation:{anchorId:'topic',sourceId:'message',scope:'thread' as const,threadId:'thread'}};
  try {
    const own=f.store.create('group','__conversation__','owner secret','read-only',group.conversation);f.store.thread(own.id,'private-session');f.store.set(own.id,'review');
    f.engine.receive(input('not addressed',{...group,botMentioned:false}));assert.equal(pending(f.store),undefined);
    for(const senderId of ['ou_guest','ou_other']){f.engine.receive(input('hello',{...group,senderId}));assert.equal(act(f,pending(f.store).id).toast.type,'success');await until(()=>sessions.length===(senderId==='ou_guest'?1:2)&&f.store.list().filter(t=>t.requesterId).every(t=>t.status==='review'));}
    assert.equal(new Set(sessions).size,2);assert.equal(f.store.conversationTask('group',group.conversation)?.id,own.id);
    await f.engine.flush();assert.equal(f.sent.filter(x=>x.chat==='group'&&x.text==='answer').length,2);
    assert.ok(f.sent.filter(x=>x.chat==='group').every(x=>x.view?.conversation?.anchorId==='topic'));
  }finally{await f.close()}
});

test('approved guest continuation reuses only its own thread; owner private continuation prevents later reuse',async()=>{
  const seen:Array<{id:string;thread:string|null;prompt:string}>=[];const f=setup({run:async(task,_p,h)=>{seen.push({id:task.id,thread:task.threadId,prompt:task.prompt});h.thread('session-'+task.id);return 'answer-'+seen.length}});
  try {
    f.engine.receive(input('first'));act(f,pending(f.store).id);await until(()=>seen.length===1&&f.store.list()[0].status==='review');const first=seen[0].id;
    f.engine.receive(input('follow up'));act(f,pending(f.store).id);await until(()=>seen.length===2&&f.store.get(first)?.status==='review');assert.equal(seen[1].id,first);assert.equal(seen[1].thread,'session-'+first);
    f.engine.receive(input('/continue '+first+' private owner input',{senderId:'ou_owner',chatId:'owner-dm'}));await until(()=>seen.length===3&&f.store.get(first)?.status==='review');await f.engine.flush();assert.ok(!f.sent.some(x=>x.chat==='guest-dm'&&x.text==='answer-3'));
    f.engine.receive(input('another guest request'));act(f,pending(f.store).id);await until(()=>seen.length===4);assert.notEqual(seen[3].id,first);assert.equal(seen[3].thread,null);
  }finally{await f.close()}
});

test('business clarification replies need owner confirmation; runtime permission replies never accept guest text',async()=>{
  let calls=0;const f=setup({run:async(_task,_p,h)=>{calls++;if(calls===1){h.askClarification!('Which city?');return 'need detail'}return 'weather'}});
  try {
    f.engine.receive(input('weather'));act(f,pending(f.store).id);await until(()=>f.store.list()[0]?.status==='waiting_input');await f.engine.flush();
    assert.ok(f.sent.some(x=>x.chat==='guest-dm'&&x.text.includes('Which city?')));
    f.engine.receive(input('Shenzhen'));assert.equal(calls,1);act(f,pending(f.store).id);await until(()=>f.store.list()[0]?.status==='review');assert.equal(calls,2);
  }finally{await f.close()}
  let requestId='',answer='';const g=setup({run:async(_task,_p,h)=>new Promise(resolve=>{requestId=h.request({kind:'approval',description:'private permission request',resolve:a=>{answer=a;resolve('done')}})})});
  try {
    g.engine.receive(input('task'));act(g,pending(g.store).id);await until(()=>!!requestId);await g.engine.flush();assert.ok(!g.sent.some(x=>x.chat==='guest-dm'&&x.text.includes('private permission')));
    g.engine.receive(input('/approve '+requestId));assert.equal(answer,'');
    g.engine.receive(input('/approve '+requestId,{senderId:'ou_owner',chatId:'owner-dm'}));await until(()=>answer==='accept');
  }finally{await g.close()}
});

test('revoking a requester cancels execution and blocks pending approvals and undelivered replies',async()=>{
  let began=false;const f=setup({run:async(_t,_p,_h,signal)=>{began=true;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}});
  try {
    f.engine.receive(input('first'));act(f,pending(f.store).id);await until(()=>began);const task=f.store.list()[0];
    f.engine.receive(input('second'));const s=pending(f.store);buildCard(f.store,f.c,'ou_owner',{kind:'submission',submissionId:s.id});
    f.engine.updateProjects({projects:f.c.projects,trustedRequesters:[]});assert.equal(f.store.get(task.id)?.status,'cancelled');
    assert.equal(act(f,s.id).toast.type,'error');assert.equal(submission(f.store,s.id)?.status,'revoked');
    const before=f.sent.filter(x=>x.chat==='guest-dm').length;
    f.store.enqueue('guest-dm','private late reply',{kind:'requester-reply',requesterId:'ou_guest'});await f.engine.flush();assert.equal(f.sent.filter(x=>x.chat==='guest-dm').length,before);
    f.store.enqueue('guest-dm','delayed reply',{kind:'requester-reply',requesterId:'ou_guest'});
    f.store.db.prepare('UPDATE outbox SET due=? WHERE sent=0').run(Date.now()+60_000);
    f.engine.updateProjects({projects:f.c.projects,trustedRequesters:[]});
    f.engine.updateProjects({projects:f.c.projects,trustedRequesters:[{openId:'ou_guest',name:'Guest'}]});
    f.store.db.prepare('UPDATE outbox SET due=0').run();await f.engine.flush();
    assert.ok(!f.sent.some(x=>x.text==='delayed reply'));assert.equal(act(f,s.id).toast.type,'error');
  }finally{await f.close()}
});

test('owner cancellation notifies requester without private task details',async()=>{
  let began=false;const f=setup({run:async(_t,_p,_h,signal)=>{began=true;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('private failure')),{once:true}))}});
  try {
    f.engine.receive(input('task'));const s=pending(f.store);act(f,s.id);await until(()=>began);const task=f.store.list()[0];
    f.engine.receive(input('/cancel '+task.id,{senderId:'ou_owner',chatId:'owner-dm'}));await f.engine.flush();
    assert.equal(submission(f.store,s.id)?.status,'completed');
    assert.ok(f.sent.some(x=>x.chat==='guest-dm'&&x.text==='主人已停止这次任务。'));
    assert.ok(!f.sent.some(x=>x.chat==='guest-dm'&&x.text.includes('private failure')));
  }finally{await f.close()}
});

test('pending approvals persist across restart, expire, and reject safely without model execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-requesters-')),path=join(dir,'store.sqlite');let f=setup({run:async()=>assert.fail('not approved')},path);
  try {
    f.engine.receive(input('pending'));const id=pending(f.store).id;await f.close();f=setup({run:async()=>assert.fail('must not execute rejected')},path);f.engine.start();
    assert.equal(submission(f.store,id)?.status,'pending');assert.equal(act(f,id,false).toast.type,'success');assert.equal(submission(f.store,id)?.status,'rejected');
    f.engine.receive(input('expires'));const s=pending(f.store);buildCard(f.store,f.c,'ou_owner',{kind:'submission',submissionId:s.id});f.store.db.prepare('UPDATE submissions SET expiresAt=0 WHERE id=?').run(s.id);assert.equal(act(f,s.id).toast.type,'error');
  }finally{await f.close();rmSync(dir,{recursive:true,force:true})}
});

test('trusted requester config is explicit, bounded and identity based',()=>{
  assert.deepEqual(trustedRequesters(undefined),[]);assert.deepEqual(trustedRequesters([{openId:'ou_a',name:' A '}]),[{openId:'ou_a',name:'A'}]);
  for(const value of [null,{},['ou_a'],[{openId:'*',name:'everyone'}],[{openId:'ou_a',name:''}],[{openId:'ou_a',name:'A'},{openId:'ou_a',name:'B'}],Array.from({length:51},(_,i)=>({openId:'ou_'+i,name:'A'}))])assert.throws(()=>trustedRequesters(value));
});


test('console saves and removes identity grants atomically; old clients preserve them; applied state is separate',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-people-console-')),file=join(dir,'config.json');const owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='ou_owner';
  writeFileSync(file,JSON.stringify({projects:{},stateDir:dir}));const app=await startWorkspaceConsole(file,0,async()=>[],async()=>[]);
  try {
    const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)![1];assert.ok(html.includes('谁可以向分身提交任务'));new Function(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]);
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

test('Feishu owner review uses open_id privately, while guest replies use original chat or topic with stable dedupe',async()=>{
  const f=setup({run:async()=>assert.fail('not approved')}),channel=new FeishuChannel('fake','fake',f.store,f.c),created:any[]=[],replied:any[]=[];
  (channel as any).client={im:{message:{create:async(p:any)=>{created.push(p);return {code:0,data:{message_id:'created-'+created.length,chat_id:'owner-dm'}}},reply:async(p:any)=>{replied.push(p);return {code:0,data:{message_id:'reply-'+replied.length}}}}}};
  try {
    f.engine.receive(input('work'));const s=pending(f.store);
    await channel.send('ou_owner','pending','delivery-a',{kind:'submission',submissionId:s.id});
    assert.equal(created[0].params.receive_id_type,'open_id');assert.equal(created[0].data.receive_id,'ou_owner');assert.equal(f.store.cardMessage('ou_owner','submission:'+s.id),'created-1');
    await channel.send('guest-dm','answer','delivery-b',{kind:'requester-reply',requesterId:'ou_guest'});await channel.send('guest-dm','answer','delivery-b',{kind:'requester-reply',requesterId:'ou_guest'});
    assert.equal(created.length,2);assert.equal(created[1].params.receive_id_type,'chat_id');assert.equal(created[1].data.msg_type,'post');assert.ok(!created[1].data.content.includes('actionId'));
    await channel.send('group','group answer','delivery-c',{kind:'requester-reply',requesterId:'ou_guest',conversation:{anchorId:'source-topic',sourceId:'source',scope:'thread'}});
    assert.equal(replied[0].path.message_id,'source-topic');assert.equal(replied[0].data.reply_in_thread,true);
  }finally{channel.close();await f.close()}
});
