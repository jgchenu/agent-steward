import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeishuEvent } from '../src/channels/feishu.js';
import { Store } from '../src/store.js';
import { acquireLock } from '../src/lock.js';
import { loadConfig } from '../src/config.js';

test('Feishu normalization drops groups, bot events and malformed JSON', () => {
  const data = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_type: 'text', chat_type: 'p2p', message_id: 'm', chat_id: 'c', content: '{"text":"hello"}' } };
  assert.equal(parseFeishuEvent(data)?.senderId, 'owner');
  assert.equal(parseFeishuEvent({ ...data, message: { ...data.message, chat_type: 'group' } }), undefined);
  assert.equal(parseFeishuEvent({ ...data, sender: { ...data.sender, sender_type: 'app' } }), undefined);
  assert.equal(parseFeishuEvent({ ...data, message: { ...data.message, content: 'oops' } }), undefined);
});

test('SQLite retains task/session, deduplication and outbound delivery across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-store-test-'));
  try {
    const path = join(dir, 'db.sqlite'); let store = new Store(path);
    const task = store.create('dm', 'p', 'hello'); store.thread(task.id, 'thread');
    store.consume('message'); store.enqueue('dm', 'result'); const delivery = store.outgoing()!.id;
    store.close(); store = new Store(path);
    assert.equal(store.get(task.id)?.threadId, 'thread'); assert.equal(store.consume('message'), false);
    assert.equal(store.outgoing()?.id, delivery); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('duplicate local instances cannot acquire the same state directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-lock-test-'));
  try {
    const unlock = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /实例/); unlock();
    acquireLock(dir)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configuration fails closed for missing owner, unknown sandbox and invalid paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-config-test-'));
  const before = process.env.STEWARD_OWNER_ID;
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ projects: { demo: { path: dir } } }));
    delete process.env.STEWARD_OWNER_ID; assert.throws(() => loadConfig(path), /OWNER/);
    process.env.STEWARD_OWNER_ID = 'owner';
    assert.equal(loadConfig(path).projects.demo.sandbox, 'read-only');
    writeFileSync(path, JSON.stringify({ projects: { demo: { path: dir, sandbox: 'danger-full-access' } } }));
    assert.throws(() => loadConfig(path), /sandbox/);
  } finally {
    if (before === undefined) delete process.env.STEWARD_OWNER_ID; else process.env.STEWARD_OWNER_ID = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
