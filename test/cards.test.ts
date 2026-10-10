import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { buildCard } from '../src/channels/cards.js';
import { FeishuChannel, parseCardAction } from '../src/channels/feishu.js';
import type { CardAction, Config, Intent } from '../src/types.js';
const config: Config = { ownerId: 'owner', projects: { demo: { path: '.', sandbox: 'read-only' } },
  stateDir: '.', codexCommand: 'codex', maxRunMinutes: 1 };
let sequence = 0;
function action(store: Store, intent: Intent, fields: Record<string, unknown> = {}): CardAction {
  return { id: String(++sequence), senderId: 'owner', chatId: 'dm', messageId: 'om_clicked', actionId: store.action('dm', intent), fields };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await setTimeout(5); }
  assert.fail('condition not reached');
}

test('card form submission is owner/chat bound, validated and single use across distinct click events', async () => {
  const store = new Store(':memory:'); let runs = 0;
  const engine = new Engine(store, config, { run: async () => { runs++; return 'result'; } }, { send: async () => {} });
  try {
    const a = action(store, { op: 'new' }, { project: 'demo', body: 'work' });
    assert.equal(engine.handleAction({ ...a, senderId: 'other' }).toast.type, 'error');
    assert.equal(engine.handleAction({ ...a, chatId: 'group' }).toast.type, 'error');
    assert.equal(engine.handleAction({ ...a, fields: { project: '/tmp', body: 'work' } }).toast.type, 'error');
    assert.equal(store.getAction(a.actionId)?.used, 0);
    assert.equal(engine.handleAction(a).toast.type, 'success');
    engine.handleAction({ ...a, id: 'another-click' });
    await until(() => store.list()[0]?.status === 'review');
    assert.equal(runs, 1); assert.equal(store.list().length, 1);
    const task = store.list()[0];
    const done = action(store, { op: 'done', taskId: task.id, revision: task.updatedAt });
    engine.handleAction(done); assert.equal(store.get(task.id)?.status, 'completed');
    assert.equal(engine.handleAction({ ...done, id: 'again' }).toast.type, 'error');
  } finally { await engine.stop(); store.close(); }
});

test('old task revisions and expired capabilities never mutate work', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, config, { run: async () => 'result' }, { send: async () => {} });
  try {
    const task = store.create('dm', 'demo', 'work'); store.set(task.id, 'review');
    const a = action(store, { op: 'done', taskId: task.id, revision: 'old-revision' });
    assert.equal(engine.handleAction(a).toast.type, 'error'); assert.equal(store.get(task.id)?.status, 'review');
    const b = action(store, { op: 'new' }, { project: 'demo', body: 'work' });
    store.db.exec('UPDATE card_actions SET expires=0');
    assert.equal(engine.handleAction(b).toast.type, 'error'); assert.equal(store.list().length, 1);
  } finally { await engine.stop(); store.close(); }
});

test('approval cards authorize only the current request, and recovery invalidates old request buttons', async () => {
  const store = new Store(':memory:'); let req = '', answers = 0;
  const engine = new Engine(store, config, { run: async (_t, _p, hooks, signal) => new Promise((yes, no) => {
    signal.addEventListener('abort', () => no(signal.reason), { once: true });
    req = hooks.request({ kind: 'approval', description: 'write file', resolve: value => { answers++; yes(value); } });
  }) }, { send: async () => {} });
  try {
    engine.handleAction(action(store, { op: 'new' }, { project: 'demo', body: 'work' }));
    await until(() => !!req); const task = store.list()[0];
    const approve = action(store, { op: 'approve', taskId: task.id, requestId: req, revision: task.updatedAt });
    assert.equal(engine.handleAction({ ...approve, senderId: 'other' }).toast.type, 'error');
    engine.handleAction(approve); engine.handleAction({ ...approve, id: 'repeat' });
    await until(() => store.get(task.id)?.status === 'review'); assert.equal(answers, 1);
    store.set(task.id, 'waiting_approval'); const old = store.request(task.id, 'approval', 'old request');
    const stale = action(store, { op: 'approve', taskId: task.id, requestId: old, revision: store.get(task.id)!.updatedAt });
    store.recover(); assert.equal(engine.handleAction(stale).toast.type, 'error'); assert.equal(answers, 1);
  } finally { await engine.stop(); store.close(); }
});

test('invalid answer forms remain reusable so the owner can correct input', async () => {
  const store = new Store(':memory:'); let req = '';
  const engine = new Engine(store, config, { run: async (_t, _p, hooks, signal) => new Promise((yes, no) => {
    signal.addEventListener('abort', () => no(signal.reason), { once: true });
    req = hooks.request({ kind: 'input', description: 'choose', validate: a => { if (a !== 'yes') throw Error('choose yes'); }, resolve: yes });
  }) }, { send: async () => {} });
  try {
    engine.handleAction(action(store, { op: 'new' }, { project: 'demo', body: 'work' }));
    await until(() => !!req); const task = store.list()[0];
    const answer = action(store, { op: 'answer', taskId: task.id, requestId: req, revision: task.updatedAt }, { body: 'no' });
    assert.equal(engine.handleAction(answer).toast.type, 'error'); assert.equal(store.getAction(answer.actionId)?.used, 0);
    assert.equal(engine.handleAction({ ...answer, fields: { body: 'yes' } }).toast.type, 'success');
    await until(() => store.get(task.id)?.status === 'review');
  } finally { await engine.stop(); store.close(); }
});

test('callback parser accepts task-row navigation and rejects unrelated hosts and raw commands', () => {
  const data = { event_id: 'evt', host: 'im_message', operator: { open_id: 'owner' },
    context: { open_chat_id: 'dm', open_message_id: 'om_test' },
    action: { tag: 'button', name: 'a' + '1'.repeat(32), form_value: { body: 'hello' } } };
  assert.equal(parseCardAction(data)?.fields.body, 'hello');
  assert.equal(parseCardAction({ ...data, action: { tag: 'interactive_container', value: { actionId: data.action.name } } })?.actionId, data.action.name);
  assert.equal(parseCardAction({ ...data, action: { ...data.action, tag: 'input' } }), undefined);
  assert.equal(parseCardAction({ ...data, host: 'im_top_notice' }), undefined);
  assert.equal(parseCardAction({ ...data, context: {} }), undefined);
  assert.equal(parseCardAction({ ...data, action: { tag: 'button', value: { command: '/approve any' } } }), undefined);
});

test('cards preserve result pagination and cannot approve a truncated request', () => {
  const store = new Store(':memory:');
  try {
    const t = store.create('dm', 'demo', '<at id=all>unsafe</at>');
    const result = '🙂'.repeat(2000) + 'FINAL'; store.set(t.id, 'review', result);
    const first = buildCard(store, config, 'dm', { kind: 'result', taskId: t.id, page: 0 }) as any;
    const second = buildCard(store, config, 'dm', { kind: 'result', taskId: t.id, page: 1 }) as any;
    assert.equal(first.body.elements[0].text.content + second.body.elements[0].text.content, result);
    assert.equal(first.body.elements[0].text.tag, 'plain_text');
    store.request(t.id, 'approval', '危'.repeat(12000)); store.set(t.id, 'waiting_approval');
    const card = JSON.stringify(buildCard(store, config, 'dm', { kind: 'task', taskId: t.id }));
    assert.ok(!card.includes('允许本次')); assert.ok(card.includes('拒绝'));
  } finally { store.close(); }
});

test('schema v1 upgrades without losing queued text; cards and action identity survive reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-card-')); const path = join(root, 'state.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE outbox (id TEXT PRIMARY KEY,chatId TEXT,text TEXT,attempts INTEGER DEFAULT 0,due INTEGER DEFAULT 0,sent INTEGER DEFAULT 0); INSERT INTO outbox(id,chatId,text) VALUES ('legacy','dm','hello'); PRAGMA user_version=1;"); old.close();
    let store = new Store(path); assert.equal(store.outgoing()?.text, 'hello'); assert.equal(store.outgoing()?.view, null);
    const id = store.action('dm', { op: 'home' }); store.saveCardMessage('dm', 'home', 'om_card');
    store.close(); store = new Store(path);
    assert.equal(store.getAction(id)?.intent.op, 'home'); assert.equal(store.cardMessage('dm', 'home'), 'om_card'); store.close();
  } finally { rmSync(root, { recursive: true }); }
});

test('task notifications update the original card; failed patches do not silently create duplicates', async () => {
  const store = new Store(':memory:'); const channel = new FeishuChannel('fake', 'fake', store, config);
  let creates = 0, patches = 0, fail = false;
  (channel as any).client = { im: { message: {
    create: async () => { creates++; return { code: 0, data: { message_id: 'om_card' } }; },
    patch: async () => { patches++; return { code: fail ? 999 : 0 }; },
  } } };
  try {
    const task = store.create('dm', 'demo', 'work'); const view = { kind: 'task' as const, taskId: task.id };
    await channel.send('dm', 'queued', 'delivery1', view); store.set(task.id, 'running');
    await channel.send('dm', 'result', 'delivery2', view); assert.equal(creates, 1); assert.equal(patches, 1);
    fail = true; await assert.rejects(channel.send('dm', 'result', 'delivery2', view)); assert.equal(creates, 1);
    fail = false; store.set(task.id, 'review', 'done');
    await channel.send('dm', 'result', 'delivery3', view); assert.equal(creates, 2);
    await channel.send('dm', 'refresh', 'delivery4', view); assert.equal(creates, 2);
  } finally { channel.close(); store.close(); }
});

test('navigation replaces the clicked card, never the old home card; background updates cannot replace the form', async () => {
  const store = new Store(':memory:'); const channel = new FeishuChannel('fake', 'fake', store, config);
  const patched: string[] = []; let creates = 0;
  (channel as any).client = { im: { message: {
    create: async () => { creates++; return { code: 0, data: { message_id: `om_new_${creates}` } }; },
    patch: async (p: any) => { patched.push(p.path.message_id); return { code: 0 }; },
  } } };
  const engine = new Engine(store, config, { run: async () => 'unused' }, channel);
  try {
    const task = store.create('dm', 'demo', 'work'); store.set(task.id, 'running');
    store.saveCardMessage('dm', 'home', 'om_old_home');
    store.saveCardMessage('dm', `task:${task.id}`, 'om_clicked');
    engine.handleAction(action(store, { op: 'home' })); await engine.flush();
    assert.deepEqual(patched, ['om_clicked']);
    assert.equal(store.cardMessage('dm', 'home'), 'om_clicked');
    assert.equal(store.cardMessage('dm', `task:${task.id}`), undefined);
    await channel.send('dm', 'progress', 'progress-id', { kind: 'task', taskId: task.id });
    assert.equal(creates, 1); assert.deepEqual(patched, ['om_clicked']);
    // A typed workbench request appears at the end of chat, but delivery retry reuses its identity.
    await channel.send('dm', 'home', 'new-home-delivery', { kind: 'home', fresh: true });
    await channel.send('dm', 'home', 'new-home-delivery', { kind: 'home', fresh: true });
    assert.equal(creates, 2); assert.equal(patched.at(-1), 'om_new_2');
  } finally { await engine.stop(); channel.close(); store.close(); }
});

test('summary cards retain only details and stop while full records and rare actions live in collapsed panels', () => {
  const store = new Store(':memory:');
  const buttons = (value: any): string[] => !value || typeof value !== 'object' ? []
    : [...(value.tag === 'button' ? [value.text.content] : []), ...Object.values(value).flatMap(buttons)];
  try {
    const t = store.create('dm','demo','继续改一下'); store.set(t.id,'review','结果已经说明');
    const card = buildCard(store,config,'dm',{kind:'task',taskId:t.id}) as any;
    assert.deepEqual(buttons(card),['查看详情']); assert.equal(card.header.title.content,'处理结果');
    assert.ok(!JSON.stringify(card).includes('继续改一下'));
    const details = buildCard(store,config,'dm',{kind:'result',taskId:t.id}) as any;
    const panels = details.body.elements.filter((e: any)=>e.tag==='collapsible_panel');
    assert.equal(panels.length,2); assert.ok(panels.every((e:any)=>e.expanded===false));
    assert.ok(buttons(panels[1]).includes('标记完成'));
    store.set(t.id,'running');
    assert.deepEqual(buttons(buildCard(store,config,'dm',{kind:'task',taskId:t.id})),['查看详情','停止']);
  } finally {store.close();}
});
