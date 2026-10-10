import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { buildCard } from '../src/channels/cards.js';
import { codeSourceReceipt, codeSourceChanged, deliveryFooter } from '../src/code-source.js';
import type { Config, DeliveryReport, View, Incoming } from '../src/types.js';
const config: Config = { ownerId:'owner', groupChats:true, stateDir:'.', codexCommand:'codex', maxRunMinutes:1,
  projects:{ demo:{ path:'/private/configured', sandbox:'workspace-write', worktree:{baseRef:'new-default', checks:[]} } } };
const report: DeliveryReport = { workspace:{taskId:'task', source:'/private/source', path:'/private/copy', branch:'steward/task', baseRef:'old-base', baseSha:'a'.repeat(40)},
  mode:'workspace-write', headSha:'b'.repeat(40), capturedAt:'2026-10-10T04:00:00.000Z', files:['one.ts'], diffStat:'', fingerprint:'snapshot', checks:[],ready:false };

test('code source shows actual snapshot instead of changed configuration, and keeps paths out of groups', () => {
  const store = new Store(':memory:');
  try {
    const task = store.create('dm','demo','work'); store.saveDelivery(task.id,report);
    const view = {kind:'source' as const,taskId:task.id};
    const dm = JSON.stringify(buildCard(store,config,'dm',view));
    for (const s of ['old-base',report.workspace.baseSha,report.headSha,report.capturedAt,'非实时','累计改动','/private/copy','/private/source']) assert.ok(dm.includes(s),s);
    assert.ok(!dm.includes('new-default'));
    const group = JSON.stringify(buildCard(store,config,'dm',{...view,conversation:{anchorId:'root',sourceId:'root',scope:'thread'}}));
    assert.ok(!group.includes('/private/'));
    const detail = JSON.stringify(buildCard(store,config,'dm',{kind:'task',taskId:task.id}));
    assert.ok(detail.includes('old-base')); assert.ok(detail.includes('查看详情'));
    const full = JSON.stringify(buildCard(store,config,'dm',{kind:'result',taskId:task.id}));
    assert.ok(full.includes(report.workspace.baseSha)); assert.ok(full.includes('代码与验证记录'));
    assert.ok(full.includes('未配置（不代表执行 Agent 没有自行验证）'));
    assert.ok(!JSON.stringify(buildCard(store,config,'other',view)).includes(report.headSha));
    const receipt = codeSourceReceipt('Demo',report);
    assert.ok(!receipt.includes('累计')); assert.ok(receipt.includes(report.workspace.baseSha.slice(0,12))); assert.ok(!receipt.includes('/private/'));
    const waiting = store.create('dm','demo','queued');
    const missing = JSON.stringify(buildCard(store,config,'dm',{kind:'source',taskId:waiting.id}));
    assert.ok(missing.includes('尚未记录实际执行版本')); assert.ok(missing.includes('尚非执行证据'));
  } finally { store.close(); }
});

test('source navigation while running never resumes inference or answers approval and retains owner/topic gates', async () => {
  const store = new Store(':memory:'); const sent: View[] = []; let runs = 0;
  const conversation = {anchorId:'root',sourceId:'root',scope:'thread' as const};
  const task = store.create('group','demo','work','workspace-write',conversation); store.set(task.id,'waiting_approval');
  const request = store.request(task.id,'approval','separate permission'); store.saveDelivery(task.id,report);
  const engine = new Engine(store,config,{run:async()=>{runs++;return 'unexpected';}},{send:async(_c,_t,_d,v)=>{if(v)sent.push(v);}});
  let sequence = 0;
  const message = (extra:Partial<Incoming> = {}): Incoming => ({id:String(++sequence),senderId:'owner',senderType:'user',chatId:'group',chatType:'group',text:'代码来源',botMentioned:true,conversation,...extra});
  try {
    engine.receive(message({senderId:'other'})); engine.receive(message({botMentioned:false}));
    await engine.flush(); assert.equal(sent.length,0);
    engine.receive(message()); await engine.flush();
    assert.equal(sent.at(-1)!.kind,'source'); assert.equal(sent.at(-1)!.conversation!.anchorId,'root');
    engine.receive(message({text:`/source ${task.id}`,conversation:{...conversation,anchorId:'elsewhere',sourceId:'elsewhere'}})); await engine.flush();
    assert.equal(sent.filter(v=>v.kind==='source').length,1);
    const actionId = store.action('group',{op:'source',taskId:task.id,conversation});
    assert.equal(engine.handleAction({id:'click',senderId:'owner',chatId:'group',actionId,messageId:'card',fields:{}}).toast.type,'success');
    await engine.flush(); assert.equal(sent.at(-1)!.kind,'source');
    assert.equal(runs,0); assert.equal(store.get(task.id)!.status,'waiting_approval'); assert.equal(store.getRequest(request)!.status,'pending');
  } finally {await engine.stop();store.close();}
});


test('source announcement ignores routine inventory changes but exposes changed execution versions', () => {
  assert.equal(codeSourceChanged(undefined, report), true);
  assert.equal(codeSourceChanged(report, {...report, capturedAt:'later', files:['two.ts'], fingerprint:'new'}), false);
  for (const changed of [
    {...report, headSha:'c'.repeat(40)},
    {...report, mode:'read-only' as const},
    {...report, workspace:{...report.workspace, baseSha:'c'.repeat(40)}},
    {...report, workspace:{...report.workspace, baseRef:'other'}},
    {...report, workspace:{...report.workspace, path:'/other-copy'}},
  ]) assert.equal(codeSourceChanged(report, changed), true);
});

test('result footer labels cumulative inventory and retains failed checks and PR evidence', () => {
  const plain = deliveryFooter(report,config.projects.demo);
  assert.match(plain,/相对基准累计改动：1 个文件/);
  assert.match(plain,/不是本轮新增数量/);
  assert.doesNotMatch(plain,/未配置|未运行|独立检查/);
  assert.match(deliveryFooter({...report, checks:[{name:'unit',status:'failed',log:'test failed',exitCode:1}],prUrl:'https:\/\/github.com/example/repo/pull/1'},config.projects.demo),/自动检查：unit: 失败\nPR：https:/);
});


test('continued runs do not enqueue duplicate source receipts after preparation overwrites the snapshot', async () => {
  const store = new Store(':memory:'); const sent: string[] = []; let runs = 0;
  const engine = new Engine(store,config,{ run:async(task,_project,hooks)=>{
    runs++;
    const current = {...report, headSha:runs === 3 ? 'c'.repeat(40) : report.headSha};
    store.saveDelivery(task.id,current);
    hooks.prepared?.(current);
    hooks.thread('same-thread');
    return `result-${runs}`;
  }},{send:async(_chat,text)=>{sent.push(text);}});
  const waitResult = async (result:string) => {
    for(let i=0;i<100;i++) {
      if(store.list()[0]?.result === result) { await engine.flush(); return; }
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('run did not finish');
  };
  try {
    engine.receive({id:'start',senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text:'/edit demo work'});
    await waitResult('result-1');
    const task = store.list()[0];
    const receipts = () => sent.filter(text=>text.startsWith('正在处理')).length;
    assert.equal(receipts(),1);
    engine.receive({id:'continue',senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text:`/continue ${task.id} continue`});
    await waitResult('result-2'); assert.equal(receipts(),1);
    engine.receive({id:'version',senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text:`/continue ${task.id} continue`});
    await waitResult('result-3'); assert.equal(receipts(),2);
  } finally { await engine.stop(); store.close(); }
});
