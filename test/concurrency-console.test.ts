import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceConsole } from '../src/workspace-console.js';
import { loadConfig } from '../src/config.js';
import { writePermissionRuntime, readPermissionRuntime } from '../src/permission-runtime.js';

test('console persists bounded concurrency with revision/auth checks and distinguishes saved from applied',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-concurrency-console-')),file=join(dir,'config.json');
  const owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
  writeFileSync(file,JSON.stringify({projects:{},stateDir:dir,langGraphPilot:true,permissionMode:'ask'}));
  const app=await startWorkspaceConsole(file,0,async()=>[],async()=>[]);
  try{
    const html=await(await fetch(app.url)).text(),token=html.match(/<script nonce="([^"]+)"/)![1];
    const headers={'X-Steward-Console':token,Origin:app.url.slice(0,-1),'Content-Type':'application/json'};
    const state=async()=>await(await fetch(app.url+'api/state',{headers})).json() as any;
    let s=await state();assert.equal(s.maxConcurrentTasks,2);assert.equal(s.runtime.connected,false);
    const save=async(body:unknown,h=headers)=>fetch(app.url+'api/grants',{method:'POST',headers:h,body:JSON.stringify(body)});
    const initial=readFileSync(file,'utf8');
    assert.equal((await save({revision:s.revision,grants:[],maxConcurrentTasks:4},{...headers,'X-Steward-Console':'wrong'})).status,403);
    for(const maxConcurrentTasks of [0,5,1.5,'3',null,true]){
      assert.equal((await save({revision:s.revision,grants:[],maxConcurrentTasks})).status,400);
      assert.equal(readFileSync(file,'utf8'),initial);
    }
    const revision=s.revision;
    assert.equal((await save({revision,grants:[],maxConcurrentTasks:4})).status,200);
    assert.equal(loadConfig(file).maxConcurrentTasks,4);assert.equal(loadConfig(file).langGraphPilot,true);
    assert.equal((await save({revision,grants:[],maxConcurrentTasks:1})).status,400);
    // A saved value is not runtime acknowledgement.
    writePermissionRuntime(dir,{permissionMode:'ask',active:true,activeMode:'ask',activeCount:2,maxConcurrentTasks:2});
    s=await state();assert.equal(s.maxConcurrentTasks,4);assert.equal(s.runtime.maxConcurrentTasks,2);
    assert.equal((await save({revision:s.revision,grants:[],permissionMode:'ask'})).status,200);
    assert.equal(loadConfig(file).maxConcurrentTasks,4); // Older clients omit this field.
    writePermissionRuntime(dir,{permissionMode:'ask',active:true,activeMode:'ask',activeCount:3,maxConcurrentTasks:1});
    assert.equal(readPermissionRuntime(dir).connected,true); // Lowering drains existing work.
    writePermissionRuntime(dir,{permissionMode:'ask',active:false,activeCount:0,maxConcurrentTasks:5});
    assert.equal(readPermissionRuntime(dir).connected,false);
  }finally{
    await new Promise<void>(resolve=>app.server.close(()=>resolve()));
    if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;
    rmSync(dir,{recursive:true,force:true});
  }
});
