import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { startAlertWebhook } from '../src/alert-webhook.js';
import { sentryMcpForTask, sentryMcpOverrides } from '../src/sentry-mcp.js';
import { alertBindingForTask, pendingAlertTasks } from '../src/alert-provenance.js';
import { projectGrantKey } from '../src/routing.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertSources, alertSourceKey, type AlertSource } from '../src/alert-config.js';
import { AlertPoller, assertAlertAuthorized } from '../src/alerts.js';
import { SentryConnector, scriptLocation, sentryIssueUrl, type AlertConnector, type AlertEvidence } from '../src/sentry.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { commandEnv } from '../src/process.js';
import type { Config } from '../src/types.js';
import { confirmAlertNoise, clearAlertNoise, noiseSignature, flushNoiseDigests, ALERT_RECHECK_MS, NOISE_DIGEST_MS } from '../src/alert-triage.js';

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

const extensionEvidence=(id='1'):AlertEvidence=>({...evidence(id),eventId:'a'.repeat(32),completeStack:true,
  extensionOrigins:[`chrome-extension://${'a'.repeat(32)}`],exception:[{type:'ReferenceError',value:'M_ID',
    frames:[{absPath:'app:///executors/200.js',line:761,column:18,inApp:true}]}]});
const hour=(f:ReturnType<typeof fixture>)=>{for(let i=0;i<ALERT_RECHECK_MS/60_000;i++) f.advance();};

test('browser links stay on the authorized organization while API requests retain their region',async()=>{
  for (const [region,host] of [['us','us.sentry.io'],['eu','de.sentry.io'],['global','sentry.io']] as const) {
    const scoped={...source,sentry:{...source.sentry,region}};
    const connector=new SentryConnector((async(input)=>{
      const url=new URL(String(input));assert.equal(url.hostname,host);
      return Response.json(url.pathname.includes('/events/') ? {tags:[{key:'environment',value:'production'}]}
        : {id:'1',project:{id:'123'},permalink:'https://evil.example/issues/1/?token=PRIVATE'});
    }) as typeof fetch,{STEWARD_SENTRY_TEST_TOKEN:'PRIVATE'});
    assert.equal((await connector.evidence(scoped,'1',new AbortController().signal)).url,'https://example.sentry.io/issues/1/?project=123');
  }
  assert.equal(sentryIssueUrl({...source,sentry:{...source.sentry,organization:'legacy_org'}},'1'),
    'https://sentry.io/organizations/legacy_org/issues/1/?project=123');
  assert.throws(()=>sentryIssueUrl(source,'1/?secret=PRIVATE'),/Invalid issue/);
});

test('daily noise summaries retain the watermark across restart and repair cached links',async()=>{
  let e=extensionEvidence();const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();f.store.set(f.store.list()[0].id,'review');
    confirmAlertNoise(f.store,f.config,'web','1',noiseSignature(e)!,'verified',f.clock());
    f.advance();await f.poller.tick();const sentAt=Number(f.store.db.prepare('SELECT sentAt FROM alert_digests').get()!.sentAt);
    const first=String(f.store.db.prepare('SELECT text FROM outbox ORDER BY rowid DESC LIMIT 1').get()!.text);
    assert.match(first,/https:\/\/example.sentry.io\/issues\/1\/\?project=123/);
    assert.doesNotMatch(first,/us.sentry.io/);assert.match(first,/截至 .* UTC/);
    e={...e,eventId:'b'.repeat(32)};f.advance();await f.poller.tick();
    f.advance();await f.poller.tick(); // repeat event stays a single pending sample
    await f.poller.stop();const reopened=new Store(f.path);
    try {
      flushNoiseDigests(reopened,f.config,sentAt+NOISE_DIGEST_MS-1);
      assert.equal(reopened.db.prepare('SELECT count(*) n FROM outbox').get()!.n,2);
      assert.equal(reopened.db.prepare('SELECT pendingNoise FROM alert_observations').get()!.pendingNoise,1);
      flushNoiseDigests(reopened,f.config,sentAt+NOISE_DIGEST_MS);
      assert.equal(reopened.db.prepare('SELECT count(*) n FROM outbox').get()!.n,3);
      const next=String(reopened.db.prepare('SELECT text FROM outbox ORDER BY rowid DESC LIMIT 1').get()!.text);
      assert.notEqual(next,first);assert.match(next,/1 次新增采样匹配/);
      flushNoiseDigests(reopened,f.config,sentAt+2*NOISE_DIGEST_MS);
      assert.equal(reopened.db.prepare('SELECT count(*) n FROM outbox').get()!.n,3);
    } finally {reopened.close();}
  } finally {await f.close();}
});

test('unseen releases and stacks create isolated recurrences; seen signatures and restart do not replay',async()=>{
  let e=evidence('1');const connector:AlertConnector={list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e};
  const f=fixture(connector);
  try {
    await f.poller.tick();f.advance();await f.poller.tick();const original=f.store.list()[0];f.store.set(original.id,'review');
    e={...e,release:'v2'};f.advance();await f.poller.tick();assert.equal(f.store.list().length,1); // cooldown
    hour(f);await f.poller.tick();const second=f.store.list()[1];assert.equal(f.store.list().length,2);
    assert.notEqual(second.id,original.id);assert.match(second.prompt,new RegExp(original.id));assert.equal(second.threadId,null);
    assert.equal(f.store.get(original.id)!.status,'review');assertAlertAuthorized(f.store,f.config,second);
    f.store.set(second.id,'review');e={...e,release:'v1'};hour(f);await f.poller.tick();assert.equal(f.store.list().length,2);
    await f.poller.stop();const restarted=new AlertPoller(f.store,f.config,connector,f.clock);await restarted.tick();await restarted.stop();
    assert.equal(f.store.list().length,2);
    f.config.alertSources!.web.enabled=false;assert.throws(()=>assertAlertAuthorized(f.store,f.config,second));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_tasks').get()!.n,1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_runs').get()!.n,2);
  } finally {await f.close();}
});

test('waiting input and daily budget retain recurrence without overwriting old task or handled evidence',async()=>{
  let e=evidence('1');const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();const original=f.store.list()[0];f.store.set(original.id,'waiting_input');
    e={...e,release:'v2'};hour(f);await f.poller.tick();assert.equal(f.store.list().length,1);
    assert.equal(JSON.parse(String(f.store.db.prepare('SELECT baseline FROM alert_observations').get()!.baseline)).release,'v1');
    assert.equal(f.store.get(original.id)!.status,'waiting_input');f.store.set(original.id,'review');
    // Prefill today's budget without changing the source grant.
    for(let i=0;i<4;i++) f.store.db.prepare('INSERT INTO alert_runs VALUES (?,?,?,?,?,?)').run(`budget-${i}`,'web','other',`${i+2}`,'x',new Date(f.clock()).toISOString());
    f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);
    assert.equal(f.store.db.prepare('SELECT error FROM alert_cursors').get()!.error,'capacity_wait');
    for(let i=0;i<24;i++) hour(f);await f.poller.tick();assert.equal(f.store.list().length,2);
  } finally {await f.close();}
});

test('cumulative impact is measured against last analysis, so gradual growth triggers once',async()=>{
  let e=evidence('1');const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();f.store.set(f.store.list()[0].id,'review');hour(f);
    for(const count of [30,60,109]) {e={...e,count};f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);}
    e={...e,count:110};f.advance();await f.poller.tick();assert.equal(f.store.list().length,2);
    assert.match(f.store.list()[1].prompt,/累计影响增长/);f.store.set(f.store.list()[1].id,'review');hour(f);await f.poller.tick();assert.equal(f.store.list().length,2);
  } finally {await f.close();}
});

test('legacy intake migrates budget and provenance and establishes baseline without replay',async()=>{
  let e=evidence('1');const connector:AlertConnector={list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e};
  const f=fixture(connector);
  try {
    const original=f.store.create(source.chatId,'web','legacy','workspace-write');f.store.set(original.id,'review');
    f.store.db.prepare('INSERT INTO alert_tasks VALUES (?,?,?,?,?)').run('web',alertSourceKey(f.config,'web')!,'1',original.id,new Date(f.clock()).toISOString());
    const migrated=new Store(f.path),poller=new AlertPoller(migrated,f.config,connector,f.clock);
    try {
      assert.equal(migrated.db.prepare('SELECT count(*) n FROM alert_runs').get()!.n,1);
      await poller.tick();f.advance();await poller.tick();assert.equal(migrated.list().length,1);
      assertAlertAuthorized(migrated,f.config,original);e={...e,release:'v2'};hour(f);await poller.tick();assert.equal(migrated.list().length,2);
    } finally {await poller.stop();migrated.close();}
  } finally {await f.close();}
});

test('noise requires exact complete extension evidence and an explicit local confirmation',async()=>{
  for(const e of [evidence('1'),{...extensionEvidence(),completeStack:false},{...extensionEvidence(),extensionOrigins:[]},
    {...extensionEvidence(),extensionOrigins:['moz-extension://private-uuid']},
    {...extensionEvidence(),exception:[{frames:[{absPath:'https://product.example/app.js'}]}]}]) assert.equal(noiseSignature(e),undefined);
  let e=extensionEvidence();const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e});
  try {
    assert.throws(()=>confirmAlertNoise(f.store,f.config,'web','1',noiseSignature(e)!,'confirmed'),/complete extension/);
    await f.poller.tick();f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);f.store.set(f.store.list()[0].id,'review');
    assert.throws(()=>confirmAlertNoise(f.store,f.config,'web','1','stale-signature','verified',f.clock()),/current evidence/);
    confirmAlertNoise(f.store,f.config,'web','1',noiseSignature(e)!,'Locally verified script origin',f.clock());
    f.advance();await f.poller.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,2);
    assert.equal(JSON.parse(String(f.store.db.prepare('SELECT view FROM outbox ORDER BY rowid DESC LIMIT 1').get()!.view)).fresh,true);
    f.advance();await f.poller.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,2);
    e={...e,release:'v2',eventId:'b'.repeat(32)};f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);
    assert.equal(f.store.db.prepare('SELECT pendingNoise FROM alert_observations').get()!.pendingNoise,1);
    hour(f);await f.poller.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,2);
    for(let i=1;i<24;i++) hour(f);await f.poller.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,3);
    e={...e,extensionOrigins:[]};hour(f);await f.poller.tick();assert.equal(f.store.list().length,2);
    assert.match(f.store.list()[1].prompt,/不再匹配/);
  } finally {await f.close();}
});

test('a blocked issue does not starve confirmed noise later on the page; revocation fences pending digests',async()=>{
  let ids=['1'];let noise=extensionEvidence();const f=fixture({list:async()=>({issues:ids.map(id=>({id}))}),evidence:async(_s,id)=>id==='1' ? noise : evidence(id)});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();f.store.set(f.store.list()[0].id,'review');
    confirmAlertNoise(f.store,f.config,'web','1',noiseSignature(noise)!,'verified',f.clock());f.advance();await f.poller.tick();
    ids=['2','3','4','1'];noise={...noise,eventId:'b'.repeat(32)};f.advance();await f.poller.tick();
    assert.equal(f.store.list().length,3);assert.equal(f.store.db.prepare('SELECT error FROM alert_cursors').get()!.error,'capacity_wait');
    assert.equal(f.store.db.prepare("SELECT pendingNoise FROM alert_observations WHERE issueId='1'").get()!.pendingNoise,1);
    const receipts=f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n;
    f.config.alertSources!.web.enabled=false;for(let i=0;i<24;i++) hour(f);await f.poller.tick();
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,receipts);
    f.config.alertSources!.web.enabled=true;await f.poller.tick();assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n),Number(receipts)+1);
  } finally {await f.close();}
});

test('noise mismatch remains pending through cooldown and budget without publishing stale digest',async()=>{
  let e=extensionEvidence();const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();f.store.set(f.store.list()[0].id,'review');
    confirmAlertNoise(f.store,f.config,'web','1',noiseSignature(e)!,'verified',f.clock());f.advance();await f.poller.tick();
    e={...e,eventId:'b'.repeat(32)};f.advance();await f.poller.tick();
    e={...e,exception:[]};f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);
    assert.equal(f.store.db.prepare('SELECT pendingNoise FROM alert_observations').get()!.pendingNoise,0);
    hour(f);await f.poller.tick();assert.equal(f.store.list().length,2);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,3);
  } finally {await f.close();}
});

test('digest and recurrence receipt rollback leave evidence retryable and clearing a rule reopens analysis',async()=>{
  let e=extensionEvidence();const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>e});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();f.store.set(f.store.list()[0].id,'review');
    confirmAlertNoise(f.store,f.config,'web','1',noiseSignature(e)!,'verified',f.clock());
    f.store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(FAIL,'test'); END;");
    f.advance();await assert.rejects(f.poller.tick(),/test/);
    assert.equal(f.store.db.prepare('SELECT pendingNoise FROM alert_observations').get()!.pendingNoise,1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_digests').get()!.n,0);
    f.store.db.exec('DROP TRIGGER fail_notice');f.advance();await f.poller.tick();
    clearAlertNoise(f.store,f.config,'web','1');hour(f);await f.poller.tick();assert.equal(f.store.list().length,2);
    f.store.set(f.store.list()[1].id,'review');e={...e,release:'v3'};hour(f);
    f.store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(FAIL,'test'); END;");
    await assert.rejects(f.poller.tick(),/test/);assert.equal(f.store.list().length,2);
    f.store.db.exec('DROP TRIGGER fail_notice');f.advance();await f.poller.tick();assert.equal(f.store.list().length,3);
  } finally {await f.close();}
});

test('Sentry context whitelist excludes private UUIDs and incomplete stacks from noise rules',async()=>{
  let context:unknown={evidence:'original_exception_stack',origins:[`chrome-extension://${'a'.repeat(32)}`],private:'PRIVATE'};
  let frames=Array.from({length:1},()=>({absPath:'app:///executors/200.js',lineNo:761,colNo:18}));
  const connector=new SentryConnector((async(input)=>Response.json(String(input).includes('/events/')
    ? {eventID:'a'.repeat(32),dateCreated:'2026-11-06T00:00:00Z',tags:[{key:'environment',value:'production'}],contexts:{browser_extension_source:context,private:'PRIVATE'},
      entries:[{type:'exception',data:{values:[{type:'Error',stacktrace:{frames}}]}}]}
    : {id:'1',project:{id:'123'}})) as typeof fetch,{STEWARD_SENTRY_TEST_TOKEN:'PRIVATE'});
  const read=()=>connector.evidence(source,'1',new AbortController().signal);
  const first=await read();assert.ok(noiseSignature(first));assert.doesNotMatch(JSON.stringify(first),/PRIVATE/);
  frames=Array.from({length:21},()=>frames[0]);assert.equal(noiseSignature(await read()),undefined);
  context={evidence:'original_exception_stack',origins:['moz-extension://PRIVATE']};assert.deepEqual((await read()).extensionOrigins,[]);
  context={evidence:'guessed',origins:[`chrome-extension://${'a'.repeat(32)}`]};assert.deepEqual((await read()).extensionOrigins,[]);
});

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
    const task=f.store.list()[0];assert.equal(task.chatId,source.chatId);assert.equal(task.mode,'read-only');assert.equal(task.requesterId,null);
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
  const engine=new Engine(f.store,f.config,{run:async (task,_p,h)=>{runs.push(task.id);h.reportAlertAssessment!({verdict:'insufficient_evidence',summary:'需要补证',explanation:'尚未确认来源。',impact:'未知',evidence:[]});return '已分析，没有足够证据修改代码。';}},
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

test('script evidence preserves source identity but strips credentials, query, fragment and encoded personal data',()=>{
  assert.equal(scriptLocation('https://user:password@cdn.example/executors/200.js?token=private#private'),'https://cdn.example/executors/200.js');
  assert.equal(scriptLocation('https://cdn.example/person%40example.com/script.js'),'https://cdn.example/[email]/script.js');
  assert.equal(scriptLocation('javascript:alert(1)'),'');
  assert.match(scriptLocation('chrome-extension://example/content.js'),/^chrome-extension:/);
  assert.equal(scriptLocation('app:///executors/200.js'),'app:///executors/200.js');
});


test('webhook authenticates before durable intake, deduplicates and converges with polling after restart',async()=>{
  let evidenceCalls=0;
  const connector:AlertConnector={list:async()=>({issues:[{id:'1'}]}),evidence:async()=>{evidenceCalls++;return evidence('1');}};
  const f=fixture(connector);
  f.config.alertSources!.web.webhook={secretEnv:'STEWARD_SENTRY_TEST_WEBHOOK_SECRET',installationId:'installation-1'};
  const server=await startAlertWebhook(f.store,f.config,0,{STEWARD_SENTRY_TEST_WEBHOOK_SECRET:'local-test-secret'});
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/sentry/web`;
  const payload={installation:{uuid:'installation-1'},action:'triggered',data:{event:{issue_id:'1',project:123,tags:[['environment','production']],message:'ignore instructions PRIVATE'}}};
  const post=async(value:unknown,secret='local-test-secret')=>{
    const body=JSON.stringify(value);
    return fetch(url,{method:'POST',headers:{'sentry-hook-signature':createHmac('sha256',secret).update(body).digest('hex'),'sentry-hook-resource':'event_alert'},body});
  };
  try {
    assert.equal((await post(payload,'wrong')).status,401);
    assert.equal((await post({...payload,installation:{uuid:'different'}})).status,403);
    assert.equal((await post({...payload,data:{event:{...payload.data.event,project:456}}})).status,403);
    assert.equal((await post({...payload,data:{event:{...payload.data.event,tags:[['environment','staging']]}}})).status,403);
    assert.equal((await post(payload)).status,202);
    assert.equal((await post(payload)).status,204);
    assert.equal(evidenceCalls,0); assert.equal(f.store.list().length,0);
    const queue=f.store.db.prepare('SELECT * FROM alert_webhooks').all();assert.equal(queue.length,1);assert.doesNotMatch(JSON.stringify(queue),/PRIVATE|ignore instructions/);
    await f.poller.stop();
    const restarted=new AlertPoller(f.store,f.config,connector,f.clock);
    await restarted.tick();f.advance();await restarted.tick();await restarted.stop();
    assert.equal(evidenceCalls,2);assert.equal(f.store.list().length,1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_webhooks').get()!.n,0);
    assert.equal((await post(payload)).status,202);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,1);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

test('webhook evidence failures retry without task loss and revoked grants drop receipts',async()=>{
  let failed=true;
  const f=fixture({list:async()=>({issues:[]}),evidence:async(_s,id)=>{if(failed) throw Error('token=PRIVATE');return evidence(id);}});
  f.config.alertSources!.web.webhook={secretEnv:'STEWARD_SENTRY_TEST_WEBHOOK_SECRET',installationId:'installation-1'};
  try {
    const key=alertSourceKey(f.config,'web')!;
    f.store.db.prepare('INSERT INTO alert_webhooks(sourceKey,sourceId,issueId,receivedAt) VALUES (?,?,?,?)').run(key,'web','1',new Date(f.clock()).toISOString());
    await f.poller.tick();assert.equal(f.store.list().length,0);
    assert.equal(f.store.db.prepare('SELECT attempts FROM alert_webhooks').get()!.attempts,1);
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM alert_webhooks').all()),/PRIVATE/);
    failed=false;f.advance();await f.poller.tick();assert.equal(f.store.list().length,1);
    f.store.db.prepare('INSERT INTO alert_webhooks(sourceKey,sourceId,issueId,receivedAt) VALUES (?,?,?,?)').run(key,'web','2',new Date(f.clock()).toISOString());
    f.config.alertSources!.web.enabled=false;await f.poller.tick();
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_webhooks').get()!.n,0);assert.equal(f.store.list().length,1);
  } finally {await f.close();}
});

test('transport setup preserves legacy authorization and only bound tasks receive scoped read tools',async()=>{
  const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>evidence('1')});
  try {
    const legacy=createHash('sha256').update(JSON.stringify({id:'web',owner:f.config.ownerId,source:f.config.alertSources!.web,grant:projectGrantKey(f.config.projects.web)})).digest('hex');
    assert.equal(alertSourceKey(f.config,'web'),legacy);
    await f.poller.tick();f.advance();await f.poller.tick();const task=f.store.list()[0];
    f.config.alertSources!.web.sentry.mcpProject='frontend';
    f.config.alertSources!.web.webhook={secretEnv:'STEWARD_SENTRY_TEST_WEBHOOK_SECRET',installationId:'installation-1'};
    assert.equal(alertSourceKey(f.config,'web'),legacy);assertAlertAuthorized(f.store,f.config,task);
    const scope=sentryMcpForTask(f.store,f.config,task)!;assert.equal(scope.project,'frontend');
    assert.equal(sentryMcpForTask(f.store,f.config,{...task,id:'unbound'}),undefined);
    assert.match(sentryMcpOverrides(scope).join('\n'),/mcp\.sentry\.dev\/mcp\/example\/frontend/);
    assert.doesNotMatch(sentryMcpOverrides(scope).join('\n'),/execute_sentry_tool|analyze_issue_with_seer|update_issue/);
    assert.throws(()=>sentryMcpOverrides({...scope,organization:'https://evil'}));
    f.config.alertSources!.web.chatId='oc_other';assert.equal(sentryMcpForTask(f.store,f.config,task),undefined);
  } finally {await f.close();}
});

test('baseline descendants retain provenance across restart, capacity and original daily dedup receipts',async()=>{
  const f=fixture({list:async()=>({issues:[{id:'1'},{id:'2'},{id:'3'}]}),evidence:async(_s,id)=>evidence(id)});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();
    const originals=f.store.list();assert.equal(originals.length,2);
    let current=originals[0];
    for (let i=0;i<2;i++) {
      f.store.set(current.id,'review');
      const next=f.store.create(current.chatId,current.project,'continue',current.mode);
      f.store.event(current.id,'handoff_to',next.id);
      f.store.event(next.id,'baseline_authorized',JSON.stringify({fromTask:current.id,ref:'main',sha:'fixed'}));
      current=next;
    }
    assert.equal(pendingAlertTasks(f.store),2);
    const reopened=new Store(f.path);
    try {assert.deepEqual(alertBindingForTask(reopened,current.id),alertBindingForTask(reopened,originals[0].id));}
    finally {reopened.close();}
    f.advance();await f.poller.tick();assert.equal(f.store.list().length,4);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_tasks').get()!.n,2);
    assert.equal(f.store.db.prepare('SELECT error FROM alert_cursors').get()!.error,'capacity_wait');
    f.store.set(current.id,'review');f.advance();await f.poller.tick();
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_tasks').get()!.n,3);
    f.config.alertSources!.web.enabled=false;
    assert.throws(()=>assertAlertAuthorized(f.store,f.config,current),/授权已变化/);
  } finally {await f.close();}
});

test('ordinary handoffs and prompt text cannot inherit MCP; broken baseline lineage fails closed',async()=>{
  const f=fixture({list:async()=>({issues:[{id:'1'}]}),evidence:async()=>evidence('1')});
  try {
    await f.poller.tick();f.advance();await f.poller.tick();const original=f.store.list()[0];
    f.config.alertSources!.web.sentry.mcpProject='frontend';
    const child=f.store.create(original.chatId,original.project,JSON.stringify({baseline_authorized:{fromTask:original.id}}),original.mode);
    f.store.event(child.id,'handoff_from',original.id);f.store.event(original.id,'handoff_to',child.id);
    assert.equal(sentryMcpForTask(f.store,f.config,child),undefined);
    f.store.event(child.id,'baseline_authorized',JSON.stringify({fromTask:original.id}));
    for (const column of ['project','chatId','requesterId','mode']) {
      const prior=f.store.db.prepare(`SELECT ${column} value FROM tasks WHERE id=?`).get(child.id)!.value;
      f.store.db.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run('different',child.id);
      assert.throws(()=>assertAlertAuthorized(f.store,f.config,child),/继承链异常/);
      assert.throws(()=>sentryMcpForTask(f.store,f.config,child),/继承链异常/);
      f.store.db.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run(prior,child.id);
    }
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind='handoff_to'").run(original.id);
    assert.throws(()=>alertBindingForTask(f.store,child.id),/继承链异常/);
    assert.equal(pendingAlertTasks(f.store),2);
    f.store.event(child.id,'handoff_to',child.id);
    f.store.db.prepare("UPDATE events SET body=? WHERE taskId=? AND kind='baseline_authorized'").run(JSON.stringify({fromTask:child.id}),child.id);
    assert.throws(()=>alertBindingForTask(f.store,child.id),/继承链异常/);
  } finally {await f.close();}
});
