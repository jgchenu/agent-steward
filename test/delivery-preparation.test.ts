import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {prepareWorkspace,WorkspaceExecutor} from '../src/workspace.js';
import {baselinePreview,restartAtBaseline} from '../src/baseline.js';
import {parseBaselineProposal} from '../src/delivery-preparation.js';
import type {BaselineProposal,Config,Incoming,Task} from '../src/types.js';

const signal=()=>AbortSignal.timeout(30000);
const proposal:BaselineProposal={ref:'origin/main',migrateChanges:true,delivery:{repository:'test/repo',baseBranch:'main',
  checks:[{name:'verify',command:process.execPath,args:['-e','process.exit(0)'],timeoutSeconds:30}]}};
async function until(fn:()=>boolean){for(let n=0;n<1000;n++){if(fn())return;await delay(5)}assert.fail('timeout');}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'steward-preparation-')),source=join(dir,'repo'),remote=join(dir,'remote.git'),stateDir=join(dir,'state');
  mkdirSync(source);mkdirSync(stateDir);
  const g=(...args:string[])=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:'pipe'}).trim();
  g('init','-b','main');g('config','user.name','Test');g('config','user.email','test@example.invalid');
  writeFileSync(join(source,'page.txt'),'old shared content\n');g('add','page.txt');g('commit','-m','initial');g('branch','old-feature');
  g('init','--bare',remote);g('remote','add','origin',remote);g('push','origin','main');
  // Fetches remain local; the configured push identity is verified without pushing.
  g('remote','set-url','--push','origin','git@github.com:test/repo.git');
  const config:Config={ownerId:'owner',stateDir,codexCommand:'unused',maxRunMinutes:1,groupChats:true,configFile:join(dir,'config.json'),
    projects:{code:{path:source,sandbox:'workspace-write',worktree:{baseRef:'old-feature',checks:[]}}}};
  writeFileSync(config.configFile!,JSON.stringify(config),{mode:0o600});
  const store=new Store(join(stateDir,'db.sqlite'));
  const conversation={anchorId:'root',sourceId:'root',threadId:'topic',scope:'thread' as const};
  const task=store.create('group','code','改善收入页并创建 PR','workspace-write',conversation);
  const previousOwner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
  return {dir,source,stateDir,g,config,store,task,conversation,close(){store.close();rmSync(dir,{recursive:true,force:true});
    if(previousOwner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=previousOwner;}};
}

test('baseline proposal rejects malformed refs, targets, extra privileges and incomplete check commands',()=>{
  assert.deepEqual(parseBaselineProposal(proposal),proposal);
  for(const value of [null,{...proposal,ref:'main~1'},{...proposal,approved:true},{...proposal,migrateChanges:'yes'},
    {...proposal,delivery:{...proposal.delivery,baseBranch:'staging'}},{...proposal,delivery:{...proposal.delivery,checks:[]}},
    {...proposal,delivery:{...proposal.delivery,checks:[{name:'x',command:'node',args:[],timeoutSeconds:0}]}},
    {...proposal,delivery:{...proposal.delivery,checks:[{name:'x',command:'node',args:[],timeoutSeconds:5,env:{SECRET:'value'}}]}}]){
    assert.throws(()=>parseBaselineProposal(value),/格式无效/);
  }
});

test('confirmed preparation configures only this project and hands off immutable changes with full owner requirements',async()=>{
  const f=fixture();
  try{
    const old=await prepareWorkspace(f.store,f.stateDir,f.task,f.config.projects.code,signal());
    writeFileSync(join(old.path,'page.txt'),'requested change\n');writeFileSync(join(old.path,'new.txt'),'new work\n');
    f.store.set(f.task.id,'review');f.store.resume(f.task.id,'保留已有功能，迁移到最新 main');f.store.set(f.task.id,'review');
    f.store.queueBaseline(f.task.id,proposal.ref,proposal);const task=f.store.get(f.task.id)!;
    const before=readFileSync(f.config.configFile!,'utf8');
    writeFileSync(join(f.source,'upstream.txt'),'new main feature');f.g('add','upstream.txt');f.g('commit','-m','new main feature');
    f.g('push',join(f.dir,'remote.git'),'main');
    const preview=await baselinePreview(f.store,task,f.config.projects.code,task.baselineRef!,signal(),f.config);
    assert.match(preview.description,/新配置/);assert.match(preview.description,/process.exit/);
    assert.equal(readFileSync(f.config.configFile!,'utf8'),before);
    const next=await restartAtBaseline(f.store,f.config,task,preview,signal());
    const raw=JSON.parse(readFileSync(f.config.configFile!,'utf8'));
    assert.deepEqual(raw.projects.code.worktree.github,{repository:'test/repo',baseBranch:'main'});
    assert.equal(raw.projects.code.sandbox,'workspace-write');assert.equal(raw.groupChats,true);
    assert.equal(next.threadId,null);assert.match(next.prompt,/改善收入页/);assert.match(next.prompt,/保留已有功能/);
    assert.match(next.prompt,/更换基准步骤已经完成/);
    const manifest=/迁移快照 (.*?manifest\.json)/.exec(next.prompt)![1];
    const data=JSON.parse(readFileSync(manifest,'utf8'));
    assert.deepEqual(data.files.map((v:{path:string})=>v.path),['new.txt','page.txt']);
    const snapshotDir=manifest.slice(0,-'manifest.json'.length);
    assert.match(readFileSync(join(snapshotDir,'tracked.patch'),'utf8'),/requested change/);
    writeFileSync(join(old.path,'new.txt'),'later old work');
    assert.equal(readFileSync(join(snapshotDir,'files/new.txt'),'utf8'),'new work\n');
    const workspace=await prepareWorkspace(f.store,f.stateDir,next,f.config.projects.code,signal());
    assert.equal(readFileSync(join(workspace.path,'upstream.txt'),'utf8'),'new main feature');
    assert.equal(readFileSync(join(workspace.path,'page.txt'),'utf8'),'old shared content\n');
    assert.equal(existsSync(join(workspace.path,'new.txt')),false,'old files must be adapted, not copied wholesale');
    assert.equal(readFileSync(join(old.path,'page.txt'),'utf8'),'requested change\n');
    assert.equal(f.store.conversationTask('group',f.conversation)?.id,next.id);
  }finally{f.close();}
});

test('stale disk configuration and wrong remote cannot be approved into setup changes',async()=>{
  const f=fixture();try{
    await prepareWorkspace(f.store,f.stateDir,f.task,f.config.projects.code,signal());f.store.queueBaseline(f.task.id,proposal.ref,proposal);
    const task=f.store.get(f.task.id)!;
    f.g('remote','set-url','--push','origin','git@github.com:other/repo.git');
    await assert.rejects(baselinePreview(f.store,task,f.config.projects.code,proposal.ref,signal(),f.config),/origin/);
    f.g('remote','set-url','--push','origin','git@github.com:test/repo.git');
    const preview=await baselinePreview(f.store,task,f.config.projects.code,proposal.ref,signal(),f.config);
    const changed=JSON.parse(readFileSync(f.config.configFile!,'utf8'));changed.maxRunMinutes=12;
    writeFileSync(f.config.configFile!,JSON.stringify(changed));
    await assert.rejects(restartAtBaseline(f.store,f.config,task,preview,signal()),/配置已变化/);
    assert.equal(JSON.parse(readFileSync(f.config.configFile!,'utf8')).maxRunMinutes,12);
    assert.equal(f.store.list().length,1);
  }finally{f.close();}
});

test('natural baseline handoff waits for owner approval and cannot be triggered twice or by another user',async()=>{
  const f=fixture(),runs:Task[]=[];
  const executor=new WorkspaceExecutor(f.config,f.store,{run:async(t,p,h)=>{
    runs.push(t);assert.ok(t.deliveryContext);
    if(t.id===f.task.id){assert.match(t.deliveryContext!,/Steward independent checks/);h.proposeBaseline!(proposal);}
    else {assert.match(t.prompt,/迁移快照/);assert.equal(t.threadId,null);writeFileSync(join(p.path,'page.txt'),'adapted');}
    return '准备交接';
  }});
  const engine=new Engine(f.store,f.config,executor,{send:async()=>{},acknowledge:async()=>{},context:async()=>({capturedAt:'',truncated:false,messages:[],summary:''})});
  const msg=(id:string,text:string,senderId='owner'):Incoming=>({id,text,senderId,chatId:'group',chatType:'group',senderType:'user',botMentioned:true,conversation:f.conversation});
  try{
    f.store.set(f.task.id,'review');const request=msg('natural','保留旧副本，从最新 main 创建新副本，迁移这次改动并补齐交付配置');
    engine.receive(request);engine.receive(request);await until(()=>f.store.get(f.task.id)?.status==='waiting_approval');
    assert.equal(runs.length,1);assert.equal(f.store.list().length,1);
    const req=f.store.requests(f.task.id)[0];assert.match(f.store.getRequest(req.id)!.description,/新配置/);
    assert.equal(JSON.parse(readFileSync(f.config.configFile!,'utf8')).projects.code.worktree.github,undefined);
    engine.receive(msg('foreign',`/approve ${req.id}`,'other'));engine.receive(msg('yes','可以'));
    assert.equal(f.store.getRequest(req.id)?.status,'pending');
    engine.receive(msg('approve',`/approve ${req.id}`));
    await until(()=>f.store.list().some(t=>t.id!==f.task.id&&t.status==='review'));
    assert.equal(runs.length,2);assert.equal(f.store.list().length,2);
    const next=f.store.list().find(t=>t.id!==f.task.id)!;
    assert.equal(f.store.delivery(next.id)!.checks[0].status,'passed');
    engine.receive(msg('again',`/approve ${req.id}`));assert.equal(f.store.list().length,2);
  }finally{await engine.stop();f.close();}
});

test('denial and cancellation retain the old copy and do not update project delivery configuration',async()=>{
  for(const operation of ['deny','cancel'] as const){
    const f=fixture();const before=readFileSync(f.config.configFile!,'utf8');
    const engine=new Engine(f.store,f.config,{run:async()=>{assert.fail('unexpected execution');}}, {send:async()=>{}});
    try{
      await prepareWorkspace(f.store,f.stateDir,f.task,f.config.projects.code,signal());
      f.store.queueBaseline(f.task.id,proposal.ref,proposal);engine.start();
      await until(()=>f.store.requests(f.task.id).length===1);const req=f.store.requests(f.task.id)[0];
      engine.receive({id:'decision',senderId:'owner',senderType:'user',chatId:'group',chatType:'p2p',text:`/${operation} ${operation==='deny'?req.id:f.task.id}`});
      await until(()=>['review','cancelled'].includes(f.store.get(f.task.id)!.status));
      assert.equal(f.store.list().length,1);assert.equal(readFileSync(f.config.configFile!,'utf8'),before);
    }finally{await engine.stop();f.close();}
  }
});

test('schema v8 retains queued proposal data across reopen but expires in-flight confirmation on recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-plan-recovery-')),file=join(dir,'state.sqlite');
  let store=new Store(file);
  try{
    const queued=store.create('dm','code','prepare','workspace-write');store.queueBaseline(queued.id,proposal.ref,proposal);
    const waiting=store.create('dm','code','prepare','workspace-write');store.queueBaseline(waiting.id,proposal.ref,proposal);
    store.set(waiting.id,'waiting_approval');const request=store.request(waiting.id,'approval','concrete setup');
    store.close();store=new Store(file);store.recover();
    assert.equal(store.get(queued.id)!.status,'queued');assert.equal(store.get(queued.id)!.nextAction,'baseline');
    assert.deepEqual(store.get(queued.id)!.baselineOptions,proposal);
    assert.equal(store.get(waiting.id)!.status,'interrupted');assert.equal(store.getRequest(request)!.status,'expired');
    store.resume(waiting.id,'继续');assert.equal(store.get(waiting.id)!.baselineOptions,null);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
