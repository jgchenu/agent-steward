import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectBindings,scopeToCodex,pinCodexGrants,type CodexProject} from '../src/codex-projects.js';
import {WorkspaceRegistry} from '../src/workspace-console.js';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {CONVERSATION} from '../src/conversation.js';
import type {Config,Task,View} from '../src/types.js';
const until=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,5));assert.ok(fn());};
test('Codex identities stay distinct; legacy grants do not spread to projects sharing a root',()=>{
 const c:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,projects:{web:{path:'/web',label:'Web',sandbox:'read-only'},sandbox:{path:'/playground',sandbox:'read-only'}}};
 const catalog:CodexProject[]=[{id:'web',name:'Web',roots:['/web']},{id:'full',name:'Full Stack',roots:['/web','/server']}];
 const bound=projectBindings(c.projects,catalog,'/');assert.equal(bound.length,2);assert.ok(bound[0].project);assert.equal(bound[1].project,undefined);
 const scoped=scopeToCodex(c,catalog);assert.deepEqual(Object.keys(scoped.projects),['web']);assert.equal(scoped.projects.web.codexProjectId,'web');
 assert.deepEqual(Object.keys(scopeToCodex(scoped,[]).projects),[]);
 assert.deepEqual(Object.keys(scopeToCodex(scoped,[{id:'replacement',name:'Web',roots:['/web']}]).projects),[]);
});
test('console lists only Codex projects, binds grants to identity, detects catalog drift and permits zero grants',()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-codex-projects-')),owner=process.env.STEWARD_OWNER_ID;process.env.STEWARD_OWNER_ID='owner';
 try {
  mkdirSync(join(dir,'web'));mkdirSync(join(dir,'playground'));
  const file=join(dir,'config.json');writeFileSync(file,JSON.stringify({projects:{web:{path:'./web',label:'Web',sandbox:'read-only'},sandbox:{path:'./playground',label:'通用分析',sandbox:'read-only'}},defaultProject:'sandbox'}));
  let catalog=[{id:'web',name:'Web',roots:[join(dir,'web')]}];const r=new WorkspaceRegistry(file,()=>catalog);const first=r.state();
  assert.deepEqual(first.projects.map(p=>p.label),['Web']);catalog=[...catalog,{id:'new',name:'New',roots:[join(dir,'web')]}];
  const before=readFileSync(file,'utf8');assert.throws(()=>r.apply({revision:first.revision,grants:first.projects.map(p=>({id:p.id,mode:p.mode}))}),/变化/);assert.equal(readFileSync(file,'utf8'),before);
  pinCodexGrants(file,catalog);const pinned=JSON.parse(readFileSync(file,'utf8'));assert.equal(pinned.projects.web.codexProjectId,'web');assert.equal(pinned.projects.sandbox,undefined);assert.equal(readFileSync(file+'.before-codex-projects.json','utf8'),before);
  const next=r.state();assert.equal(next.projects[1].mode,'none');r.apply({revision:next.revision,grants:next.projects.map(p=>({id:p.id,mode:'none'}))});
  const raw=JSON.parse(readFileSync(file,'utf8'));assert.deepEqual(raw.projects,{});assert.equal(raw.defaultProject,undefined);
 }finally{if(owner===undefined)delete process.env.STEWARD_OWNER_ID;else process.env.STEWARD_OWNER_ID=owner;rmSync(dir,{recursive:true,force:true});}
});
test('resource-free tasks reach the executor with zero grants; resource proposals cannot select an ungranted or default project',async()=>{
 const store=new Store(':memory:'),runs:Task[]=[],sent:Array<{text:string;view?:View}>=[];
 const c:Config={ownerId:'owner',stateDir:tmpdir(),codexCommand:'unused',maxRunMinutes:1,projects:{},codexProjects:[{id:'no',name:'PrivateRepo',roots:['/private-repo']}]};
 const engine=new Engine(store,c,{run:async(t,p,h)=>{runs.push(t);assert.equal(p.sandbox,'read-only');
  if(t.prompt==='PrivateRepo 看看')h.proposeProject!('no');
  if(t.prompt==='修复这个组件')h.proposeProject!('web');
  return '分析结果';}},{send:async(_c,text,_id,view)=>{sent.push({text,view});}});
 let seq=0;const send=(text:string)=>engine.receive({id:String(++seq),senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text});
 try{
  send('概括这段讨论');await until(()=>store.list()[0]?.status==='review');assert.equal(runs[0].project,CONVERSATION);
  send('修改登录流程代码');await until(()=>runs.length===2&&store.list().every(t=>t.status==='review'));assert.equal(runs[1].project,CONVERSATION);assert.deepEqual(runs[1].projectCandidates,[]);
  send('PrivateRepo 看看');await until(()=>runs.length===3&&store.list().some(t=>t.status==='failed'));assert.equal(runs[2].project,CONVERSATION);
  assert.deepEqual(runs[2].resources,[]);assert.equal(store.list().length,3);
  engine.updateProjects({...c,defaultProject:'web',projects:{web:{path:'/web',sandbox:'read-only',label:'Web'}}});
  send('修复这个组件');await until(()=>runs.length===4&&store.list().at(-1)?.status==='review');assert.equal(runs[3].project,CONVERSATION);assert.ok(store.projectSelection(runs[3].id));
  send('再总结一下');await until(()=>runs.length===5);assert.equal(runs[4].project,CONVERSATION);
 }finally{await engine.stop();store.close();}
});

test('a projectless topic can choose a code target without losing its original request',async()=>{
 const store=new Store(':memory:'),runs:Task[]=[],views:View[]=[];
 const c:Config={ownerId:'owner',stateDir:tmpdir(),codexCommand:'unused',maxRunMinutes:1,groupChats:true,projects:{web:{path:'/web',label:'Web',sandbox:'read-only'}}};
 const engine=new Engine(store,c,{run:async(t,_p,h)=>{runs.push(t);if(t.project===CONVERSATION&&t.prompt==='请修改组件代码')h.proposeProject!('web');return 'done';}},{context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]}),send:async(_c,_t,_id,v)=>{if(v)views.push(v);}});
 const message=(id:string,text:string)=>({id,text,senderId:'owner',senderType:'user',chatId:'group',chatType:'group' as const,botMentioned:true,conversation:{anchorId:'topic',sourceId:id,scope:'thread' as const}});
 try {
  engine.receive(message('one','先讨论这张截图'));await until(()=>store.list()[0]?.status==='review');
  engine.receive(message('two','请修改组件代码'));await until(()=>runs.length===2&&store.list()[0].status==='review');assert.ok(store.projectSelection(runs[1].id));
  engine.receive(message('three','对的'));
  await until(()=>runs.length===3);assert.equal(runs[2].project,'web');assert.equal(runs[2].threadId,null);assert.match(runs[2].prompt,/这张截图/);assert.match(runs[2].prompt,/修改组件代码/);
 }finally{await engine.stop();store.close();}
});
