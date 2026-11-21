import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceRegistry} from '../src/workspace-console.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {alertSourceKey} from '../src/alert-config.js';
import {readPermissionRuntime,writePermissionRuntime,clearPermissionRuntime} from '../src/permission-runtime.js';
import type {Config,PermissionMode} from '../src/types.js';
const until=async(f:()=>boolean)=>{for(let i=0;i<200&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f());};
test('permission saves are explicit, revision-bound, preserve grants and migrate legacy reviewer settings',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-permissions-')),file=join(dir,'config.json'),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 try{
  mkdirSync(join(dir,'general'));const raw={approvalsReviewer:'auto_review',projects:{general:{path:'./general',sandbox:'read-only'}}};
  writeFileSync(file,JSON.stringify(raw));const registry=new WorkspaceRegistry(file,()=>[{id:'codex-general',name:'通用分析',roots:[join(dir,'general')]}]);let s=registry.state();assert.equal(s.permissionMode,'auto');assert.equal(loadConfig(file).permissionMode,'auto');
  const save=(mode:PermissionMode,confirmed=false)=>registry.apply({revision:s.revision,grants:s.projects.map(p=>({id:p.id,mode:p.mode})),permissionMode:mode,confirmFullAccess:confirmed});
  const before=readFileSync(file,'utf8');assert.throws(()=>save('full-access'),/确认/);assert.equal(readFileSync(file,'utf8'),before);
  assert.throws(()=>save('invalid' as PermissionMode),/无效/);assert.equal(readFileSync(file,'utf8'),before);
  s=save('sandbox-auto');assert.equal(loadConfig(file).permissionMode,'sandbox-auto');
  s=save('full-access',true);assert.equal(loadConfig(file).permissionMode,'full-access');assert.equal(loadConfig(file).projects.general.sandbox,'read-only');
  const stale=s;s=save('ask');assert.equal(loadConfig(file).permissionMode,'ask');assert.equal(JSON.parse(readFileSync(file,'utf8')).approvalsReviewer,'auto_review');
  assert.throws(()=>registry.apply({revision:stale.revision,grants:stale.projects.map(p=>({id:p.id,mode:p.mode})),permissionMode:'full-access',confirmFullAccess:true}),/配置已变化/);
  const invalid={...raw,permissionMode:'invalid'};writeFileSync(file,JSON.stringify(invalid));assert.throws(()=>loadConfig(file),/permissionMode/);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true});}
});
test('hot reload does not elevate the active run; tightening cancels it and expires pending approvals',async()=>{
 const store=new Store(':memory:');const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,permissionMode:'ask',projects:{p:{path:'.',sandbox:'read-only'}}};
 const seen:PermissionMode[]=[];let release:()=>void=()=>{};
 const engine=new Engine(store,config,{run:async(task,_project,hooks,signal)=>{seen.push(task.permissionMode!);return new Promise<string>((resolve,reject)=>{release=()=>resolve('done');hooks.request({kind:'approval',description:'one operation',resolve:release});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}},{send:async()=>{}});
 try{
  engine.receive({id:'first',chatId:'dm',chatType:'p2p',senderId:'owner',senderType:'user',text:'/new p work'});engine.start();await until(()=>seen.length===1);
  engine.updateProjects({...config,permissionMode:'full-access'});assert.equal(engine.permissionState().activeMode,'ask');assert.equal(store.list()[0].status,'waiting_approval');release();await until(()=>store.list()[0].status==='review');
  engine.receive({id:'second',chatId:'dm',chatType:'p2p',senderId:'owner',senderType:'user',text:'/continue '+store.list()[0].id+' more'});await until(()=>seen.length===2);assert.deepEqual(seen,['ask','full-access']);
  engine.updateProjects({...config,permissionMode:'auto'});await until(()=>store.list()[0].status==='failed');assert.equal(store.requests(store.list()[0].id).length,0);assert.equal(engine.permissionState().permissionMode,'auto');
 }finally{await engine.stop();store.close();}
});

test('console can enable Sentry validation without changing the source grant or the default mode',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-sentry-validation-')),file=join(dir,'config.json'),owner=process.env.STEWARD_OWNER_ID;
 process.env.STEWARD_OWNER_ID='owner';
 try{
  const source={kind:'sentry',enabled:true,project:'code',chatId:'oc_owner',mode:'workspace-write',
   sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_TEST_TOKEN'}};
  writeFileSync(file,JSON.stringify({projects:{code:{codexProjectId:'c',label:'Code',path:dir,aliases:[],sandbox:'workspace-write',naturalMode:'workspace-write',workspaceMode:'isolated',worktree:{baseRef:'main',checks:[]}}},alertSources:{web:source}}));
  const registry=new WorkspaceRegistry(file,()=>[{id:'c',roots:[dir],name:'Code'}]),state=registry.state();
  const oldKey=alertSourceKey(loadConfig(file),'web');
  const payload={revision:state.revision,grants:state.projects.map(p=>({id:p.id,mode:p.mode}))};
  assert.throws(()=>registry.apply({...payload,sentryValidation:[{id:'unconfigured',enabled:true}]}),/设置无效/);
  const saved=registry.apply({...payload,sentryValidation:[{id:'web',enabled:true}]});
  assert.deepEqual(saved.sentryValidation,[{id:'web',label:'Code',enabled:true}]);
  const configured=loadConfig(file);
  assert.equal(configured.alertSources!.web.automaticValidation,true);
  assert.ok(oldKey);
  assert.equal(alertSourceKey(configured,'web'),oldKey);
  assert.equal(configured.permissionMode,'ask');
  assert.throws(()=>registry.apply({...payload,sentryValidation:[{id:'web',enabled:false}]}),/配置已变化/);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true});}
});

test('only authorized Sentry repair turns use sandbox validation, and disabling cancels the active run',async()=>{
 const store=new Store(':memory:');
 const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,permissionMode:'ask',
  projects:{code:{path:'.',sandbox:'workspace-write',worktree:{baseRef:'main',checks:[]}}},
  alertSources:{web:{kind:'sentry',enabled:true,project:'code',chatId:'oc_owner',mode:'workspace-write',automaticValidation:true,pollSeconds:60,maxTasksPerDay:10,
   sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_TEST_TOKEN'}}}};
 const ordinary=store.create('oc_owner','code','owner task','workspace-write');
 const diagnosis=store.create('oc_owner','code','diagnose','read-only');
 const repair=store.create('oc_owner','code','repair','workspace-write');
 for(const task of [diagnosis,repair]) store.db.prepare('INSERT INTO alert_runs VALUES (?,?,?,?,?,?)').run(task.id,'web',alertSourceKey(config,'web')!,'1','sig',task.createdAt);
 const seen:Record<string,PermissionMode|undefined>={};
 const engine=new Engine(store,config,{run:async(task,_p,_h,signal)=>{
  seen[task.id]=task.permissionMode;
  if (task.id!==repair.id) return 'done';
  return new Promise<string>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }},{send:async()=>{}});
 try{
  engine.start();
  await until(()=>Object.keys(seen).length===3);
  assert.deepEqual(seen,{[ordinary.id]:'ask',[diagnosis.id]:'ask',[repair.id]:'sandbox-auto'});
  engine.updateProjects({...config,alertSources:{web:{...config.alertSources!.web,automaticValidation:false}}});
  await until(()=>store.get(repair.id)?.status==='failed');
 }finally{await engine.stop();store.close();}
});
test('console runtime status is a live heartbeat rather than a saved preference',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-permission-runtime-'));
 try{assert.equal(readPermissionRuntime(dir).connected,false);writePermissionRuntime(dir,{permissionMode:'auto',active:true,activeMode:'ask'});
 assert.deepEqual(readPermissionRuntime(dir),{connected:true,permissionMode:'auto',active:true,activeMode:'ask'});
 writePermissionRuntime(dir,{permissionMode:'auto',active:true,activeMode:'ask',activeCount:2});
 assert.deepEqual(readPermissionRuntime(dir),{connected:true,permissionMode:'auto',active:true,activeMode:'ask',activeCount:2});
 const path=join(dir,'permission-runtime.json'),raw=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...raw,updatedAt:Date.now()-6000}));assert.equal(readPermissionRuntime(dir).connected,false);
 writePermissionRuntime(dir,{permissionMode:'ask',active:false});clearPermissionRuntime(dir);assert.equal(readPermissionRuntime(dir).connected,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
