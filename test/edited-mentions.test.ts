import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditedMentionWatch } from '../src/channels/edited-mentions.js';
import { parseFeishuEvent } from '../src/channels/feishu.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Config, Incoming } from '../src/types.js';

function incoming(id = 'm'): Incoming {
  return parseFeishuEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_id: id, chat_id: 'chat', chat_type: 'group', message_type: 'text',
      root_id: 'root', thread_id: 'thread', parent_id: 'parent', create_time: '1000',
      content: JSON.stringify({ text: 'inspect architecture' }) } }, 'bot')!;
}
function edited(id = 'm'): any {
  return { message_id: id, chat_id: 'chat', root_id: 'root', thread_id: 'thread', parent_id: 'parent',
    sender: { id: 'owner', id_type: 'open_id', sender_type: 'user' }, msg_type: 'text',
    create_time: '1000', update_time: '2000', body: { content: JSON.stringify({ text: 'inspect architecture @_user_1' }) },
    mentions: [{ key: '@_user_1', id: 'bot', id_type: 'open_id', name: 'Agent' }] };
}
const response = (item: any) => ({ code: 0, data: { items: [item] } });

test('top-level group message keeps its own anchor after a late mention', async () => {
  const received: Incoming[] = [];
  const item = { ...edited(), root_id: undefined, thread_id: undefined, parent_id: undefined };
  const original = parseFeishuEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_id: 'm', chat_id: 'chat', chat_type: 'group', message_type: 'text',
      content: '{"text":"inspect architecture"}' } }, 'bot')!;
  const watch = new EditedMentionWatch('owner', 'bot', async () => response(item),
    parseFeishuEvent, () => false, m => received.push(m));
  try {
    watch.observe(original); await watch.poll();
    assert.equal(received.length, 1);
    assert.equal(received[0].conversation?.anchorId, 'm');
    assert.equal(received[0].conversation?.scope, 'chat');
  } finally { watch.close(); }
});

test('a read completing after the watch window cannot dispatch', async () => {
  let now = 0;
  const watch = new EditedMentionWatch('owner', 'bot', async () => {
    now = 600_000; return response(edited());
  }, parseFeishuEvent, () => false, () => assert.fail('expired read must not dispatch'), () => now);
  try { watch.observe(incoming()); await watch.poll(); }
  finally { watch.close(); }
});

test('late mention reaches real Engine once; original ignored event did not consume inbox', async () => {
  const store = new Store(':memory:');
  const config: Config = { ownerId: 'owner', groupChats: true, stateDir: '.', codexCommand: 'codex', maxRunMinutes: 1, projects: {} };
  const engine = new Engine(store, config, { run: async () => 'done' }, { send: async () => {} });
  // Keep execution queued: this test exercises intake, not a provider or context API.
  (engine as any).tick = () => {};
  const watch = new EditedMentionWatch('owner', 'bot', async () => response(edited()), parseFeishuEvent,
    id => store.consumed(id), message => engine.receive(message));
  try {
    const original = incoming(); engine.receive(original); watch.observe(original);
    assert.equal(store.list().length, 0); assert.equal(store.consumed('m'), false);
    await watch.poll(); await watch.poll();
    engine.receive(parseFeishuEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
      message: { message_id: 'm', chat_id: 'chat', chat_type: 'group', message_type: 'text',
        content: '{"text":"duplicate"}', mentions: [{ id: { open_id: 'bot' } }] } }, 'bot')!);
    assert.equal(store.list().length, 1); assert.equal(store.consumed('m'), true);
    const task = store.list()[0]; assert.equal(task.prompt, 'inspect architecture');
    assert.equal(task.conversation?.sourceId, 'm'); assert.equal(task.conversation?.anchorId, 'root');
    assert.equal(task.conversation?.cutoff, '2000');
  } finally { watch.close(); await engine.stop(); store.close(); }
});

test('only exact owner/bot metadata in original chat and topic can wake; plain text and other mentions cannot', async () => {
  for (const patch of [ { deleted: true }, { chat_id: 'other' }, { root_id: 'other' }, { thread_id: 'other' },
    { parent_id: 'other' }, { sender: { id: 'other', id_type: 'open_id', sender_type: 'user' } },
    { sender: { id: 'owner', id_type: 'open_id', sender_type: 'app' } },
    { mentions: [] }, { mentions: [{ id: 'other', id_type: 'open_id' }] },
    { mentions: [{ id: 'bot', id_type: 'user_id' }] } ]) {
    const received: Incoming[] = [];
    const watch = new EditedMentionWatch('owner', 'bot', async () => response({ ...edited(), ...patch }),
      parseFeishuEvent, () => false, m => received.push(m));
    watch.observe(incoming()); await watch.poll(); assert.equal(received.length, 0); watch.close();
  }
});

test('limits candidates, rotates batches, expires without duplicate extension, and skips consumed inputs', async () => {
  let now = 0; const reads: string[] = []; const consumed = new Set<string>();
  const watch = new EditedMentionWatch('owner', 'bot', async id => { reads.push(id); return response({ ...edited(id), mentions: [] }); },
    parseFeishuEvent, id => consumed.has(id), () => assert.fail('must not dispatch'), () => now);
  watch.observe({ ...incoming('outsider'), senderId: 'other' });
  watch.observe({ ...incoming('dm'), chatType: 'p2p' });
  watch.observe({ ...incoming('addressed'), botMentioned: true });
  for (let n = 0; n < 101; n++) watch.observe(incoming(String(n)));
  consumed.add('1'); await watch.poll(); assert.equal(reads.length, 19); assert.equal(reads[0], '2');
  await watch.poll(); assert.equal(reads.length, 39); assert.equal(reads[19], '21');
  now = 599_999; watch.observe(incoming('99')); now = 600_000;
  for (let n = 0; n < 5; n++) await watch.poll();
  assert.equal(reads.length, 39); watch.close();
});

test('read failure retries without raw error logging; concurrent polls and close cannot dispatch twice', async () => {
  let calls = 0, warnings = 0; const received: Incoming[] = [];
  let finish!: (v: any) => void;
  const watch = new EditedMentionWatch('owner', 'bot', async () => {
    calls++; if (calls < 3) throw new Error('private data');
    return new Promise(resolve => { finish = resolve; });
  }, parseFeishuEvent, () => false, m => received.push(m), Date.now, () => { warnings++; });
  watch.observe(incoming()); await watch.poll(); await watch.poll(); assert.equal(warnings, 1);
  const pending = watch.poll(); await watch.poll(); assert.equal(calls, 3);
  watch.close(); finish(response(edited())); await pending;
  assert.equal(received.length, 0);
});

test('rich text late mention preserves edited body and processed messages are never replayed', async () => {
  let reads = 0; const received: Incoming[] = []; const consumed = new Set<string>();
  const watch = new EditedMentionWatch('owner', 'bot', async id => {
    reads++; return response({ ...edited(id), msg_type: 'post',
      body: { content: JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: 'new requirements' }, { tag: 'at', user_id: 'bot' }]] } }) } });
  }, parseFeishuEvent, id => consumed.has(id), m => received.push(m));
  watch.observe(incoming('processed')); consumed.add('processed');
  watch.observe(incoming()); await watch.poll(); await watch.poll();
  assert.equal(reads, 1); assert.equal(received.length, 1); assert.equal(received[0].text, 'new requirements');
  watch.close();
});
