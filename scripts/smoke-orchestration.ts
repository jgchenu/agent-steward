// Opt-in live Codex integration in read-only scratch space. No Feishu, Git or publication.
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {CodexExecutor} from '../src/adapters/codex.js';
import type {Config} from '../src/types.js';
const dir=mkdtempSync(join(tmpdir(),'steward-graph-smoke-'));
const config:Config={ownerId:'smoke-owner',stateDir:dir,codexCommand:'codex',maxRunMinutes:2,langGraphPilot:true,
  projects:{smoke:{path:dir,sandbox:'read-only'}}};
const channel={send:async()=>{}};
let store=new Store(join(dir,'state.sqlite'));
let engine=new Engine(store,config,new CodexExecutor(),channel);
let messageId=0;
function send(text:string){engine.receive({id:String(++messageId),senderId:'smoke-owner',senderType:'user',chatId:'smoke',chatType:'p2p',text});}
async function waitFor(status:string){
  for(let i=0;i<1200;i++){
    const task=store.list()[0];
    if(task?.status===status)return task;
    if(task&&['failed','interrupted','cancelled'].includes(task.status))throw Error(`Smoke failed: ${task.result}`);
    await setTimeout(100);
  }
  throw Error('Live orchestration smoke timed out');
}
console.log('Live subscription graph pilot: synthetic read-only clarification, restart and session continuation.');
try{
  send('/new smoke 请为迎新活动写一句标语，但先问我活动主题。主题确认前不要写标语。不要调用工具或读取文件。');
  const waiting=await waitFor('waiting_input');
  const request=store.requests(waiting.id)[0];assert.ok(request);assert.ok(waiting.threadId);
  console.log('PASS: real Codex returned a durable business question');
  await engine.stop();store.close();
  store=new Store(join(dir,'state.sqlite'));engine=new Engine(store,config,new CodexExecutor(),channel);engine.start();
  assert.equal(store.get(waiting.id)?.status,'waiting_input');
  assert.equal(store.getRequest(request.id)?.status,'pending');
  console.log('PASS: business wait survived runtime reconstruction');
  send(`/answer ${request.id} 主题是开源协作，标语请包含“同行”二字。不用再问问题，直接给出标语，不要调用工具。`);
  const result=await waitFor('review');
  assert.equal(result.threadId,waiting.threadId);assert.match(result.result??'',/同行/);
  assert.equal(store.getRequest(request.id)?.status,'answered');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM graph_operations WHERE result IS NOT NULL').get()?.n,2);
  console.log('PASS: original Codex session resumed and delivered the requested result');
  console.log('No live Feishu, project writes, permissions or deployment were exercised.');
}finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
