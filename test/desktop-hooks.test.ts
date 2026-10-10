import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopApprovalPlan} from '../src/adapters/desktop-hooks.js';
test('only exact CodeIsland user PermissionRequest handlers receive invocation overrides',()=>{
 const home=mkdtempSync(join(tmpdir(),'steward-hook-'));const dir=join(home,'.codex'),file=join(dir,'hooks.json');mkdirSync(dir);
 try{
  const command=join(home,'.codeisland','codeisland-bridge')+' --source codex';
  const raw=JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:'command',command}]}],PermissionRequest:[{hooks:[{type:'command',command:'policy-check'},{type:'command',command}]},{hooks:[{type:'command',command:command+' && policy-check'}]}]}});writeFileSync(file,raw);
  const p=desktopApprovalPlan(home,dir);assert.deepEqual(p.hooks,[{key:file+':permission_request:0:1',command}]);assert.deepEqual(p.overrides,[`hooks.state={${JSON.stringify(p.hooks[0].key)} = { enabled = false }}`]);assert.equal(readFileSync(file,'utf8'),raw);
  writeFileSync(file,'broken');assert.throws(()=>desktopApprovalPlan(home,dir),/无法读取/);
 }finally{rmSync(home,{recursive:true,force:true})}
});
test('no desktop bridge means no hook overrides, including absent hook files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-hook-'));
 try{assert.deepEqual(desktopApprovalPlan(dir,dir),{overrides:[],hooks:[]});writeFileSync(join(dir,'hooks.json'),JSON.stringify({hooks:{PermissionRequest:[{hooks:[{type:'command',command:'company-policy'}]}]}}));assert.deepEqual(desktopApprovalPlan(dir,dir),{overrides:[],hooks:[]});}finally{rmSync(dir,{recursive:true,force:true})}
});

test('App Server gets session-only overrides and must confirm the exact hook is disabled',async()=>{
 const {homedir}=await import('node:os');const {CodexRpc}=await import('../src/adapters/rpc.js');
 const dir=mkdtempSync(join(tmpdir(),'steward-hook-rpc-')),saved=process.env.CODEX_HOME;process.env.CODEX_HOME=dir;
 const command=join(homedir(),'.codeisland','codeisland-bridge')+' --source codex',key=join(dir,'hooks.json')+':permission_request:0:0';
 writeFileSync(join(dir,'hooks.json'),JSON.stringify({hooks:{PermissionRequest:[{hooks:[{type:'command',command}]}]}}));
 try{for(const enabled of [false,true]){
  const exe=join(dir,'fake-codex'),capture=join(dir,'args.json');
  writeFileSync(exe,`#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='hooks/list'?{data:[{cwd:${JSON.stringify(dir)},hooks:[{key:${JSON.stringify(key)},command:${JSON.stringify(command)},enabled:${enabled},isManaged:false}]}]}:{};process.stdout.write(JSON.stringify({id:r.id,result})+'\\n')});`,{mode:0o700});
  const rpc=new CodexRpc(exe,dir);
  try{if(enabled)await assert.rejects(rpc.initialize(),/未确认/);else await rpc.initialize();const args=JSON.parse(readFileSync(capture,'utf8'));assert.ok(args.includes(`hooks.state={${JSON.stringify(key)} = { enabled = false }}`));assert.ok(!args.some((a:string)=>a.includes('features.hooks')));}finally{await rpc.close()}
 }}finally{if(saved===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=saved;rmSync(dir,{recursive:true,force:true})}
});
