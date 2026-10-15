import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {Store} from '../src/store.js';import {WorkspaceExecutor,publicationBlocker} from '../src/workspace.js';
import {WorkspaceRegistry} from '../src/workspace-console.js';import {loadConfig} from '../src/config.js';import {Engine} from '../src/engine.js';
import type {Config,RunHooks} from '../src/types.js';
const hooks:RunHooks={thread:()=>{},progress:()=>{},request:()=>'',resolved:()=>{}};
async function until(f:()=>boolean){for(let i=0;i<250;i++){if(f())return;await setTimeout(10)}assert.fail('timed out')}
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'steward-direct-'))),path=join(root,'project');mkdirSync(path);
 const config:Config={ownerId:'owner',stateDir:root,codexCommand:'unused',maxRunMinutes:1,maxConcurrentTasks:4,projects:{p:{path,sandbox:'workspace-write',workspaceMode:'direct',naturalMode:'workspace-write'}}};
 const store=new Store(join(root,'state.sqlite'));return{root,path,config,store,close(){store.close();rmSync(root,{recursive:true,force:true})}}}

test('console explicitly grants direct edits to a plain directory without initializing Git',()=>{
 const f=fixture(),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';try{
  const file=join(f.root,'config.json');writeFileSync(file,JSON.stringify({projects:{}}));
  const registry=new WorkspaceRegistry(file,()=>[{id:'plain',name:'Plain folder',roots:[f.path]}]);const s=registry.state();
  assert.equal(s.projects[0].gitRepository,false);
  const saved=registry.apply({revision:s.revision,grants:[{id:s.projects[0].id,mode:'direct-write'}]});
  const p=Object.values(loadConfig(file).projects)[0];assert.equal(p.workspaceMode,'direct');assert.equal(p.sandbox,'workspace-write');assert.equal(p.worktree,undefined);
  assert.equal(saved.projects[0].mode,'direct-write');assert.equal(existsSync(join(f.path,'.git')),false);
  const before=readFileSync(file,'utf8');assert.throws(()=>registry.apply({revision:saved.revision,grants:[{id:s.projects[0].id,mode:'workspace-write'}]}),/Git/);assert.equal(readFileSync(file,'utf8'),before);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;f.close()}
});

test('direct execution writes the source, preserves unrelated files and refuses directory/mode switches',async()=>{
 const f=fixture();try{
  writeFileSync(join(f.path,'keep.txt'),'existing');let calls=0;
  const task=f.store.create('dm','p','write file','workspace-write');
  const executor=new WorkspaceExecutor(f.config,f.store,{run:async(t,p)=>{calls++;assert.equal(p.path,f.path);assert.equal(p.sandbox,t.mode);writeFileSync(join(p.path,'result.txt'),'done');return 'done'}});
  await executor.run(task,f.config.projects.p,hooks,AbortSignal.timeout(1000));
  assert.equal(readFileSync(join(f.path,'keep.txt'),'utf8'),'existing');assert.equal(readFileSync(join(f.path,'result.txt'),'utf8'),'done');assert.equal(f.store.workspace(task.id),undefined);assert.equal(f.store.delivery(task.id),undefined);
  assert.match(publicationBlocker(task,f.config.projects.p,undefined)!,/直接编辑/);
  assert.equal(existsSync(join(f.root,'worktrees')),false);
  const other=join(f.root,'other');mkdirSync(other);
  await assert.rejects(executor.run(task,{...f.config.projects.p,path:other},hooks,AbortSignal.timeout(1000)),/目录已变化/);
  await assert.rejects(executor.run(task,{...f.config.projects.p,workspaceMode:'isolated',worktree:{baseRef:'main',checks:[]}},hooks,AbortSignal.timeout(1000)),/不能切换/);assert.equal(calls,1);
  const read=f.store.create('dm','p','view','read-only');
  await new WorkspaceExecutor(f.config,f.store,{run:async(_t,p)=>{assert.equal(p.sandbox,'read-only');return 'read'}}).run(read,f.config.projects.p,hooks,AbortSignal.timeout(1000));
 }finally{f.close()}
});

test('direct tasks sharing a directory run sequentially and the second sees the first changes',async()=>{
 const f=fixture();let release!:()=>void;const started:string[]=[];
 const executor=new WorkspaceExecutor(f.config,f.store,{run:async(t,p,h,signal)=>{
  assert.equal(h.proposePublication,undefined);assert.equal(h.proposeBaseline,undefined);assert.equal(h.proposeMerge,undefined);
  started.push(t.prompt);if(started.length===1){await new Promise<void>((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});writeFileSync(join(p.path,'shared.txt'),'first');}
  else{assert.equal(readFileSync(join(p.path,'shared.txt'),'utf8'),'first');writeFileSync(join(p.path,'shared.txt'),'second');}return 'done';
 }});
 const engine=new Engine(f.store,f.config,executor,{send:async()=>{}});
 try{
  const send=(id:string,text:string)=>engine.receive({id,text,chatId:'dm',chatType:'p2p',senderId:'owner',senderType:'user'});
  send('one','/edit p first');await until(()=>started.length===1);send('two','/edit p second');
  assert.equal(f.store.list().filter(t=>t.status==='queued').length,1);assert.equal(started.length,1);
  release();await until(()=>f.store.list().every(t=>t.status==='review'));
  assert.deepEqual(started,['first','second']);assert.equal(readFileSync(join(f.path,'shared.txt'),'utf8'),'second');
 }finally{release?.();await engine.stop();f.close()}
});

test('changing execution location stops a direct task and cannot move its session into a copy',async()=>{
 const f=fixture();let started=false,aborted=false;
 const executor=new WorkspaceExecutor(f.config,f.store,{run:async()=>new Promise<string>(()=>{})});
 // A cooperative adapter exits when its task is revoked.
 const adapter=new WorkspaceExecutor(f.config,f.store,{run:async(_t,p,_h,signal)=>{started=true;writeFileSync(join(p.path,'keep.txt'),'in progress');return new Promise<string>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}))}});
 const engine=new Engine(f.store,f.config,adapter,{send:async()=>{}});
 try{
  engine.receive({id:'start',text:'/edit p work',chatId:'dm',chatType:'p2p',senderId:'owner',senderType:'user'});await until(()=>started);
  const task=f.store.list()[0];
  engine.updateProjects({...f.config,projects:{p:{...f.config.projects.p,workspaceMode:'isolated',worktree:{baseRef:'main',checks:[]}}}});
  await until(()=>aborted&&f.store.get(task.id)!.status!=='running');
  assert.equal(readFileSync(join(f.path,'keep.txt'),'utf8'),'in progress');
  await assert.rejects(executor.run(task,f.config.projects.p,hooks,AbortSignal.timeout(1000)),/不能切换/);
 }finally{await engine.stop();f.close()}
});
