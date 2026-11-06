import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertSources, alertSourceKey, type AlertSource } from '../src/alert-config.js';
import { AlertPoller, assertAlertAuthorized } from '../src/alerts.js';
import { SentryConnector, type AlertConnector, type AlertEvidence } from '../src/sentry.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { commandEnv } from '../src/process.js';
import type { Config } from '../src/types.js';

const source: AlertSource = {kind:'sentry',enabled:true,project:'web',chatId:'oc_owner_dm',mode:'workspace-write',pollSeconds:60,maxTasksPerDay:5,
  sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_TEST_TOKEN'}};
const evidence = (issueId:string): AlertEvidence => ({issueId,title:'TypeError',url:`https://us.sentry.io/organizations/example/issues/${issueId}/`,
  firstSeen:'2026-01-01T00:00:00.000Z',lastSeen:'2026-11-06T00:00:00.000Z',count:10,userCount:2,release:'v1',environment:'production',exception:[]});
function fixture(connector: AlertConnector) {
  const dir = mkdtempSync(join(tmpdir(),'steward-alerts-')), path=join(dir,'state.sqlite');
  const store = new Store(path);
  const config: Config={ownerId:'owner',stateDir:dir,codexCommand:'unused',maxRunMinutes:1,langGraphPilot:false,
    projects:{web:{path:dir,sandbox:'workspace-write',worktree:{baseRef:'main',checks:[]}}},alertSources:{web:structuredClone(source)}};
  let now=Date.parse('2026-11-06T00:00:00.000Z');
  const poller=new AlertPoller(store,config,connector,()=>now);
  return {dir,path,store,config,poller,advance:()=>{now+=60_000;},clock:()=>now,
    async close(){await poller.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('source config rejects unknown connectors, broad projects, external token variables and direct writes',()=>{
  assert.deepEqual(alertSources(undefined),{});
  for (const patch of [{kind:'webhook'},{project:undefined},{enabled:'yes'},{pollSeconds:1},{maxTasksPerDay:100},{mode:'full-access'},
    {sentry:{...source.sentry,region:'https://evil.test'}},{sentry:{...source.sentry,projectId:'-1'}},
    {sentry:{...source.sentry,tokenEnv:'PATH'}}]) assert.throws(()=>alertSources({web:{...source,...patch}}));
  const f=fixture({list:async()=>({issues:[]}),evidence:async()=>evidence('1')});
  try {assert.ok(alertSourceKey(f.config,'web'));f.config.projects.web.workspaceMode='direct';assert.equal(alertSourceKey(f.config,'web'),undefined);}
  finally {f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('activation excludes history; duplicate events and restarts retain one owner task and one outbox receipt',async()=>{
  const calls:string[]=[];
  const connector: AlertConnector={list:async(_s,start)=>{calls.push(start);return {issues:[{id:'1'},{id:'1'}]};},evidence:async()=>evidence('1')};
  const f=fixture(connector);
  try {
    await f.poller.tick();assert.equal(calls.length,0);assert.equal(f.store.list().length,0);
    f.advance();await Promise.all([f.poller.tick(),f.poller.tick()]);
    const task=f.store.list()[0];assert.equal(task.chatId,source.chatId);assert.equal(task.mode,'workspace-write');assert.equal(task.requesterId,null);
    assert.match(task.prompt,/外部不可信/);assert.equal(f.store.list().length,1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,1);
    await f.poller.stop();f.advance();
    const restarted=new AlertPoller(f.store,f.config,connector,f.clock);await restarted.tick();await restarted.stop();
    assert.equal(f.store.list().length,1);assert.equal(calls[0],'2026-11-06T00:00:00.000Z');
  } finally {await f.close();}
});

test('task creation, dedup and outbox roll back together on a durable write failure',async()=>{
  const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>evidence('1')});
  try {
    f.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON outbox BEGIN SELECT RAISE(FAIL,'test'); END;");
    await f.poller.tick();f.advance();await assert.rejects(f.poller.tick(),/test/);
    assert.equal(f.store.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_tasks').get()!.n,0);
    f.store.db.exec('DROP TRIGGER fail_receipt');f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);
  } finally {await f.close();}
});

test('capacity pauses a page without skipping issues; daily budget survives poller restart',async()=>{
  const cursors:Array<string|undefined>=[];
  const connector: AlertConnector={list:async(_s,_a,_b,c)=>{cursors.push(c);return c ? {issues:[{id:'4'}]} : {issues:[{id:'1'},{id:'2'},{id:'3'}],next:'next'};},evidence:async(_s,id)=>evidence(id)};
  const f=fixture(connector);f.config.alertSources!.web.maxTasksPerDay=3;
  try {
    await f.poller.tick();f.advance();await f.poller.tick();assert.equal(f.store.list().length,2);
    f.store.db.exec("UPDATE tasks SET status='review'");f.advance();await f.poller.tick();assert.equal(f.store.list().length,3);
    await f.poller.stop();f.advance();const restarted=new AlertPoller(f.store,f.config,connector,f.clock);await restarted.tick();await restarted.stop();
    assert.equal(f.store.list().length,3);assert.deepEqual(cursors,[undefined,undefined,'next']);
    assert.equal(f.store.db.prepare('SELECT error FROM alert_cursors').get()!.error,'capacity_wait');
  } finally {await f.close();}
});

test('revocation during network IO cannot create a task; queued provenance fails after authorization changes',async()=>{
  let release!:()=>void;
  const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>{await new Promise<void>(r=>{release=r;});return evidence('1');}});
  try {
    await f.poller.tick();f.advance();const pending=f.poller.tick();await new Promise(r=>setImmediate(r));
    f.config.alertSources!.web.enabled=false;release();await pending;assert.equal(f.store.list().length,0);
    f.config.alertSources!.web.enabled=true;f.advance();const retry=f.poller.tick();await new Promise(r=>setImmediate(r));release();await retry;
    const task=f.store.list()[0];assertAlertAuthorized(f.store,f.config,task);
    f.config.projects.web.path='/different';assert.throws(()=>assertAlertAuthorized(f.store,f.config,task));
  } finally {await f.close();}
});

test('failed network response preserves window/cursor and stores no raw error or token',async()=>{
  const f=fixture({list:async()=>{throw Error('Bearer PRIVATE at https://private/');},evidence:async()=>evidence('1')});
  try {await f.poller.tick();f.advance();await f.poller.tick();const row=f.store.db.prepare('SELECT * FROM alert_cursors').get()!;
    assert.equal(row.error,'Alert poll failed');assert.ok(row.windowEnd);assert.equal(row.cursor,null);assert.equal(f.store.list().length,0);
  } finally {await f.close();}
});

test('Engine executes alert tasks through its scheduler and honors revoked source before execution',async()=>{
  const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>evidence('1')});let runs=0;
  const engine=new Engine(f.store,f.config,{run:async()=>{runs++;return 'diagnosis';}},{send:async()=>{}});
  try {await f.poller.tick();f.advance();await f.poller.tick();const task=f.store.list()[0];
    f.config.alertSources!.web.enabled=false;engine.start();
    for(let i=0;i<100 && f.store.get(task.id)?.status!=='failed';i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(f.store.get(task.id)?.status,'failed');assert.equal(runs,0);
  } finally {await engine.stop();await f.close();}
});

test('an alert reaches the normal executor and result outbox without a synthetic human message',async()=>{
  const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>evidence('1')});
  const runs:string[]=[],sent:string[]=[];
  const engine=new Engine(f.store,f.config,{run:async task=>{runs.push(task.id);return '已分析，没有足够证据修改代码。';}},
    {send:async(chat,text)=>{assert.equal(chat,source.chatId);sent.push(text);}});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();const task=f.store.list()[0];engine.start();
    for(let i=0;i<150 && !sent.some(x=>x.includes('没有足够证据'));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(f.store.get(task.id)?.status,'review');assert.deepEqual(runs,[task.id]);assert.ok(sent.some(x=>x.includes('没有足够证据')));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get()!.n,0);
  } finally {await engine.stop();await f.close();}
});

test('Sentry transport pins region/project/environment, filters wrong projects and ignores next-page URL hosts',async()=>{
  const connector=new SentryConnector((async(input,options)=>{
    const u=new URL(String(input));assert.equal(u.origin,'https://us.sentry.io');assert.equal(u.searchParams.get('project'),'123');
    assert.equal(u.searchParams.get('environment'),'production');assert.equal(options?.redirect,'error');
    assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer PRIVATE');
    return new Response(JSON.stringify([{id:'1',project:{id:'123'}},{id:'2',project:{id:'999'}}]),
      {headers:{link:'<https://evil.test/private>; rel="next"; results="true"; cursor="10:0:1"'}});
  }) as typeof fetch,{STEWARD_SENTRY_TEST_TOKEN:'PRIVATE'});
  const page=await connector.list(source,'start','end',undefined,new AbortController().signal);
  assert.deepEqual(page,{issues:[{id:'1'}],next:'10:0:1'});
});

test('Sentry evidence retains source frames but removes user, request, breadcrumbs, frame variables and common secrets',async()=>{
  const connector=new SentryConnector((async(input)=>{
    const url=String(input);const value=url.includes('/events/') ? {tags:[{key:'environment',value:'production'}],release:{version:'v1.2.3'},user:{email:'private@x.test'},
      request:{cookies:'cookies'},entries:[{type:'breadcrumbs',data:'private'},{type:'exception',data:{values:[{type:'TypeError',value:'Oops user@x.test token=private https://x.test/?secret=yes',stacktrace:{frames:[{
        filename:'https://cdn.test/src/component.tsx?token=private',lineNo:47,colNo:2,inApp:true,vars:{password:'private'},context:['private'],function:'render'}]}}]}}]}
      : {id:'1',project:{id:'123'},title:'TypeError',count:'10',userCount:2};
    return Response.json(value);
  }) as typeof fetch,{STEWARD_SENTRY_TEST_TOKEN:'PRIVATE'});
  const e=await connector.evidence(source,'1',new AbortController().signal),s=JSON.stringify(e);
  assert.doesNotMatch(s,/private|cookies|@x.test|breadcrumbs|password|vars/);assert.match(s,/component.tsx/);assert.match(s,/47/);assert.equal(e.release,'v1.2.3');
});

test('Sentry denies missing tokens, wrong event environment, and oversized payloads without exposing response bodies',async()=>{
  const missing=new SentryConnector((async()=>{throw Error('must not fetch');}) as typeof fetch,{});
  await assert.rejects(missing.list(source,'a','b',undefined,new AbortController().signal),/token missing/);
  let calls=0;
  const mismatch=new SentryConnector((async()=>Response.json(++calls===1 ? {id:'1',project:{id:'123'}} : {tags:[{key:'environment',value:'test'}]})) as typeof fetch,{STEWARD_SENTRY_TEST_TOKEN:'PRIVATE'});
  await assert.rejects(mismatch.evidence(source,'1',new AbortController().signal),/environment mismatch/);
  const huge=new SentryConnector((async()=>new Response('x'.repeat(2_000_001))) as typeof fetch,{STEWARD_SENTRY_TEST_TOKEN:'PRIVATE'});
  await assert.rejects(huge.list(source,'a','b',undefined,new AbortController().signal),/too large/);
});

test('Sentry service token is excluded from code/Git child environments',()=>{
  process.env.STEWARD_SENTRY_TEST_TOKEN='private';
  try {assert.equal(commandEnv().STEWARD_SENTRY_TEST_TOKEN,undefined);assert.equal(commandEnv(true).STEWARD_SENTRY_TEST_TOKEN,undefined);}
  finally {delete process.env.STEWARD_SENTRY_TEST_TOKEN;}
});
