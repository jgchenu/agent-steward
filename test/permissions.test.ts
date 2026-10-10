import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceRegistry} from '../src/workspace-console.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
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
test('console runtime status is a live heartbeat rather than a saved preference',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-permission-runtime-'));
 try{assert.equal(readPermissionRuntime(dir).connected,false);writePermissionRuntime(dir,{permissionMode:'auto',active:true,activeMode:'ask'});
 assert.deepEqual(readPermissionRuntime(dir),{connected:true,permissionMode:'auto',active:true,activeMode:'ask'});
 const path=join(dir,'permission-runtime.json'),raw=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...raw,updatedAt:Date.now()-6000}));assert.equal(readPermissionRuntime(dir).connected,false);
 writePermissionRuntime(dir,{permissionMode:'ask',active:false});clearPermissionRuntime(dir);assert.equal(readPermissionRuntime(dir).connected,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
