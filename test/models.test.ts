import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readModels,modelSelection,validateSelection} from '../src/models.js';
import {WorkspaceRegistry} from '../src/workspace-console.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import type {Config,Task} from '../src/types.js';
const model={model:'model-a',name:'Model A',defaultEffort:'low',efforts:['low','high']};
test('model catalog preserves advertised efforts, filters hidden models and validates pagination',async()=>{
 const pages=[{data:[{model:'model-a',displayName:'Model A',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{hidden:true}],nextCursor:'next'},{data:[],nextCursor:null}];
 assert.deepEqual(await readModels({request:async()=>pages.shift()}),[model]);
 await assert.rejects(readModels({request:async()=>({data:[],nextCursor:'loop'})}),/分页/);
 assert.throws(()=>modelSelection({model:'a',effort:''}),/无效/);
 assert.throws(()=>validateSelection({model:'model-a',effort:'ultra'},[model]),/不可用/);
});
test('model save preserves project permissions, rejects stale/unsupported settings and hot loads',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-model-')),file=join(dir,'config.json'),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 try{
  writeFileSync(file,JSON.stringify({projects:{},permissionMode:'auto'}));const r=new WorkspaceRegistry(file,()=>[]),s=r.state();
  const input={revision:s.revision,grants:[],modelSelection:{model:'model-a',effort:'high'}};
  assert.throws(()=>r.apply(input,[]),/不可用/);
  r.apply(input,[model]);assert.deepEqual(loadConfig(file).modelSelection,input.modelSelection);assert.equal(loadConfig(file).permissionMode,'auto');
  assert.throws(()=>r.apply(input,[model]),/配置已变化/);
  const saved=readFileSync(file,'utf8');assert.throws(()=>r.apply({...input,revision:r.state().revision,modelSelection:{model:'model-a',effort:'ultra'}},[model]),/不可用/);assert.equal(readFileSync(file,'utf8'),saved);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true})}
});
const until=async(f:()=>boolean)=>{for(let i=0;i<200&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f());};
test('model edits affect the next turn only, including resumed conversations; console navigation starts no work',async()=>{
 const store=new Store(':memory:'),config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,projects:{},consoleUrl:'http://127.0.0.1:17831/',modelSelection:{model:'model-a',effort:'low'}};
 const seen:Task[]=[],messages:string[]=[];let release:()=>void=()=>{};
 const engine=new Engine(store,config,{run:async task=>{seen.push(task);return new Promise<string>(r=>{release=()=>r('done')})}},{send:async(_,text)=>{messages.push(text)}});
 const send=(id:string,text:string,senderId='owner')=>engine.receive({id,text,senderId,chatId:'dm',chatType:'p2p',senderType:'user'});
 try{
  send('stranger','打开控制台','other');send('console','打开控制台');engine.start();await until(()=>messages.length===1);assert.match(messages[0],/17831/);assert.equal(store.list().length,0);
  send('one','你好');await until(()=>seen.length===1);engine.updateProjects({...config,modelSelection:{model:'model-a',effort:'high'}});assert.equal(seen[0].modelSelection?.effort,'low');release();await until(()=>store.list()[0].status==='review');
  send('two','/continue '+store.list()[0].id+' 继续');await until(()=>seen.length===2);assert.equal(seen[1].modelSelection?.effort,'high');release();await until(()=>store.list()[0].status==='review');
 }finally{await engine.stop();store.close()}
});

test('model API uses console authentication and model outage does not prevent permission saves',async()=>{
 const {startWorkspaceConsole}=await import('../src/workspace-console.js');
 const dir=mkdtempSync(join(tmpdir(),'steward-model-http-')),file=join(dir,'config.json'),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 writeFileSync(file,JSON.stringify({projects:{},permissionMode:'auto'}));let available=true;
 const app=await startWorkspaceConsole(file,0,async()=>[],async()=>{if(!available)throw Error('model catalog unavailable');return [model]});
 try{
  assert.equal((await fetch(app.url+'api/models')).status,403);
  const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)![1];
  const headers={'X-Steward-Console':token,Origin:app.url.slice(0,-1),'Content-Type':'application/json'};
  assert.deepEqual(await(await fetch(app.url+'api/models',{headers})).json(),[model]);
  const state:any=await(await fetch(app.url+'api/state',{headers})).json();available=false;
  const response=await fetch(app.url+'api/grants',{method:'POST',headers,body:JSON.stringify({revision:state.revision,grants:[],permissionMode:'ask'})});assert.equal(response.status,200);assert.equal(loadConfig(file).permissionMode,'ask');
 }finally{await new Promise<void>(r=>app.server.close(()=>r()));if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true})}
});
