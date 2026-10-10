import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {WorkspaceRegistry,startWorkspaceConsole} from '../src/workspace-console.js';
import {loadConfig} from '../src/config.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'steward-grants-')),file=join(dir,'config.json');mkdirSync(join(dir,'general'));mkdirSync(join(dir,'code'));writeFileSync(file,JSON.stringify({stateDir:'.state',maxRunMinutes:30,projects:{general:{path:'./general',sandbox:'read-only',label:'通用分析'}},defaultProject:'general'}));return{dir,file}}
test('workspace catalog is not authorization; grants use the current branch, preserve settings, reject stale saves and retain revoked entries',()=>{
 const f=fixture(),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 try{const run=(args:string[])=>execFileSync('git',['-C',join(f.dir,'code'),...args],{stdio:'ignore'});run(['init','-b','feature/current']);run(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','initial']);
 const r=new WorkspaceRegistry(f.file);r.add(join(f.dir,'code'),'代码项目');let s=r.state();assert.equal(s.projects.find(p=>p.label==='代码项目')!.mode,'none');assert.equal(Object.keys(loadConfig(f.file).projects).length,1);
 const input={revision:s.revision,grants:s.projects.map(p=>({id:p.id,mode:p.id==='general'?'read-only':'workspace-write'})),defaultProject:'general'};s=r.apply(input);const c=loadConfig(f.file),code=Object.values(c.projects).find(p=>p.label==='代码项目')!;
 assert.equal(code.worktree!.baseRef,'feature/current');assert.equal(code.naturalMode,'workspace-write');assert.equal(c.maxRunMinutes,30);assert.equal(statSync(f.file).mode&0o777,0o600);
 assert.throws(()=>r.apply(input),/配置已变化/);
 s=r.apply({revision:s.revision,grants:s.projects.map(p=>({id:p.id,mode:p.id==='general'?'read-only':'none'})),defaultProject:'general'});
 assert.equal(s.projects.length,2);assert.equal(Object.keys(loadConfig(f.file).projects).length,1);
 const before=readFileSync(f.file,'utf8');assert.throws(()=>r.apply({revision:s.revision,grants:[{id:'forged',mode:'workspace-write'},{id:'general',mode:'read-only'}]}),/无效/);assert.equal(readFileSync(f.file,'utf8'),before);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(f.dir,{recursive:true,force:true})}
});
test('invalid defaults and natural write grants fail configuration validation',()=>{
 const f=fixture(),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';try{
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.defaultProject='unknown';writeFileSync(f.file,JSON.stringify(raw));assert.throws(()=>loadConfig(f.file),/defaultProject/);
 raw.defaultProject='general';raw.projects.general.naturalMode='workspace-write';writeFileSync(f.file,JSON.stringify(raw));assert.throws(()=>loadConfig(f.file),/naturalMode/);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(f.dir,{recursive:true,force:true})}
});
test('local console blocks cross-origin writes and unauthenticated API access; explicit save persists',async()=>{
 const f=fixture(),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';const app=await startWorkspaceConsole(f.file);
 try{const page=await fetch(app.url),html=await page.text();assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);const token=html.match(/<script nonce="([^"]+)"/)![1];
 assert.equal((await fetch(app.url+'api/state')).status,403);
 const headers={'X-Steward-Console':token,'Content-Type':'application/json',Origin:app.url.slice(0,-1)};
 const state=await(await fetch(app.url+'api/state',{headers})).json() as any;
 const body=JSON.stringify({revision:state.revision,grants:[{id:'general',mode:'read-only'}],defaultProject:'general'});
 assert.equal((await fetch(app.url+'api/grants',{method:'POST',headers:{...headers,Origin:'https://untrusted.invalid'},body})).status,403);
 const response=await fetch(app.url+'api/grants',{method:'POST',headers,body});assert.equal(response.status,200);assert.equal(loadConfig(f.file).defaultProject,'general');
 }finally{await new Promise<void>((yes,no)=>app.server.close(e=>e?no(e):yes()));if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(f.dir,{recursive:true,force:true})}
});
