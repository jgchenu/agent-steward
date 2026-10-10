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
test('projectless chat works with no grants; code intent asks for a project and never picks a default',async()=>{
 const store=new Store(':memory:'),runs:Task[]=[],sent:Array<{text:string;view?:View}>=[];
 const c:Config={ownerId:'owner',stateDir:tmpdir(),codexCommand:'unused',maxRunMinutes:1,projects:{},codexProjects:[{id:'no',name:'PrivateRepo',roots:['/private-repo']}]};
 const engine=new Engine(store,c,{run:async(t,p)=>{runs.push(t);assert.equal(p.sandbox,'read-only');return '分析结果';}},{send:async(_c,text,_id,view)=>{sent.push({text,view});}});
 let seq=0;const send=(text:string)=>engine.receive({id:String(++seq),senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text});
 try{
  send('概括这段讨论');await until(()=>store.list()[0]?.status==='review');assert.equal(runs[0].project,CONVERSATION);
  send('修改登录流程代码');await engine.flush();assert.equal(runs.length,1);assert.match(sent.at(-1)!.text,/授权/);
  send('PrivateRepo 看看');await engine.flush();assert.equal(runs.length,1);assert.match(sent.at(-1)!.text,/还未授权/);
  engine.updateProjects({...c,defaultProject:'web',projects:{web:{path:'/web',sandbox:'read-only',label:'Web'}}});
  send('修复这个组件');await engine.flush();assert.equal(runs.length,1);assert.equal(sent.at(-1)!.view?.kind,'choose-project');
  send('再总结一下');await until(()=>runs.length===2);assert.equal(runs[1].project,CONVERSATION);
 }finally{await engine.stop();store.close();}
});

test('a projectless topic can choose a code target without losing its original request',async()=>{
 const store=new Store(':memory:'),runs:Task[]=[],views:View[]=[];
 const c:Config={ownerId:'owner',stateDir:tmpdir(),codexCommand:'unused',maxRunMinutes:1,groupChats:true,projects:{web:{path:'/web',label:'Web',sandbox:'read-only'}}};
 const engine=new Engine(store,c,{run:async(t)=>{runs.push(t);return 'done';}},{context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]}),send:async(_c,_t,_id,v)=>{if(v)views.push(v);}});
 const message=(id:string,text:string)=>({id,text,senderId:'owner',senderType:'user',chatId:'group',chatType:'group' as const,botMentioned:true,conversation:{anchorId:'topic',sourceId:id,scope:'thread' as const}});
 try {
  engine.receive(message('one','先讨论这张截图'));await until(()=>store.list()[0]?.status==='review');
  engine.receive(message('two','请修改组件代码'));await engine.flush();const choice=views.at(-1)!;assert.equal(choice.kind,'choose-project');
  if(choice.kind!=='choose-project')throw Error('missing choice');assert.ok(choice.fromTaskId);
  const actionId=store.action('group',{op:'dispatch',project:'web',prompt:choice.draft,selectionKey:choice.selectionKey,taskId:choice.fromTaskId,revision:choice.revision,conversation:message('x','').conversation});
  assert.equal(engine.handleAction({id:'click',senderId:'owner',chatId:'group',messageId:'card',actionId,fields:{}}).toast.type,'success');
  await until(()=>runs.length===2);assert.equal(runs[1].project,'web');assert.equal(runs[1].threadId,null);assert.match(runs[1].prompt,/这张截图/);
 }finally{await engine.stop();store.close();}
});
