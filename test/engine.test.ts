import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Config, Executor, HumanRequest, Incoming, RunHooks } from '../src/types.js';

const config: Config = { ownerId: 'owner', stateDir: '.', codexCommand: 'codex', maxRunMinutes: 1,
  projects: { demo: { path: process.cwd(), sandbox: 'read-only' } } };
let sequence = 0;
const message = (text: string, extra: Partial<Incoming> = {}): Incoming => ({ id: String(++sequence), text,
  chatId: 'dm', senderId: 'owner', senderType: 'user', chatType: 'p2p', ...extra });
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await setTimeout(5); }
  assert.fail('Condition not reached');
}
function fixture(executor: Executor) {
  const store = new Store(':memory:');
  const sent: string[] = [];
  const engine = new Engine(store, config, executor, { send: async (_id, text) => { sent.push(text); } });
  return { store, engine, sent, close: async () => { await engine.stop(); store.close(); } };
}

test('only the owner in a direct human conversation can dispatch; delivery IDs deduplicate', async () => {
  let runs = 0;
  const f = fixture({ run: async () => { runs++; return 'artifact'; } });
  try {
    f.engine.receive(message('secret', { senderId: 'stranger' }));
    f.engine.receive(message('secret', { chatType: 'group' }));
    f.engine.receive(message('secret', { senderType: 'app' }));
    assert.equal(f.store.list().length, 0);
    const m = message('/new demo build a thing'); f.engine.receive(m); f.engine.receive(m);
    await until(() => f.store.list()[0]?.status === 'review');
    assert.equal(runs, 1); assert.equal(f.store.list().length, 1);
    const task = f.store.list()[0];
    f.engine.receive(message(`/done ${task.id}`));
    assert.equal(f.store.get(task.id)?.status, 'completed');
  } finally { await f.close(); }
});

test('approval is owner-bound, chat-bound and single use; continuation reuses the session', async () => {
  let requestId = '', approvals = 0, runs = 0;
  const f = fixture({ run: async (task, _p, hooks) => {
    runs++;
    if (runs === 2) { assert.equal(task.threadId, 'thread-1'); return 'followup'; }
    hooks.thread('thread-1');
    return new Promise(resolve => { requestId = hooks.request({ kind: 'approval', description: 'write test file',
      resolve: answer => { approvals++; assert.equal(answer, 'accept'); resolve('done'); } }); });
  } });
  try {
    f.engine.receive(message('build')); await until(() => !!requestId);
    const task = f.store.list()[0]; assert.equal(task.status, 'waiting_approval');
    f.engine.receive(message(`/approve ${requestId}`, { senderId: 'stranger' }));
    f.engine.receive(message(`/approve ${requestId}`, { chatId: 'other-dm' }));
    assert.equal(approvals, 0);
    f.engine.receive(message(`/approve ${requestId}`)); f.engine.receive(message(`/approve ${requestId}`));
    await until(() => f.store.get(task.id)?.status === 'review'); assert.equal(approvals, 1);
    f.engine.receive(message(`/continue ${task.id} refine`));
    await until(() => f.store.get(task.id)?.result === 'followup'); assert.equal(runs, 2);
  } finally { await f.close(); }
});

test('crash recovery expires approvals and requires explicit continuation, preserving queued work', () => {
  const store = new Store(':memory:');
  try {
    const task = store.create('dm', 'demo', 'change files'); store.set(task.id, 'waiting_approval');
    const req = store.request(task.id, 'approval', 'publish');
    const queued = store.create('dm', 'demo', 'later');
    store.recover();
    assert.equal(store.get(task.id)?.status, 'interrupted');
    assert.equal(store.getRequest(req)?.status, 'expired');
    assert.equal(store.get(queued.id)?.status, 'queued');
    assert.match(store.outgoing()!.text, /continue/);
  } finally { store.close(); }
});

test('cancellation aborts the executor and serial queue progresses', async () => {
  let active = 0, max = 0, runs = 0;
  const f = fixture({ run: async (_task, _p, _hooks, signal) => {
    active++; max = Math.max(max, active); runs++;
    try { if (runs === 1) await setTimeout(10_000, undefined, { signal }); return 'done'; }
    finally { active--; }
  } });
  try {
    f.engine.receive(message('first')); f.engine.receive(message('second'));
    await until(() => runs === 1);
    const [first, second] = f.store.list();
    f.engine.receive(message(`/cancel ${first.id}`));
    await until(() => f.store.get(second.id)?.status === 'review');
    assert.equal(f.store.get(first.id)?.status, 'cancelled'); assert.equal(max, 1);
  } finally { await f.close(); }
});

test('failed delivery is persisted and retried with the same delivery ID', async () => {
  const store = new Store(':memory:'); const ids: string[] = []; let fails = true;
  const engine = new Engine(store, config, { run: async () => 'x' }, {
    send: async (_chat, _text, id) => { ids.push(id); if (fails) throw new Error('offline'); },
  });
  try {
    store.enqueue('dm', 'hello'); await engine.flush(); fails = false;
    store.db.exec('UPDATE outbox SET due=0'); await engine.flush();
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(store.outgoing(), undefined);
  } finally { await engine.stop(); store.close(); }
});

test('invalid human input leaves the request pending', async () => {
  let req = '', resolve!: (text: string) => void;
  const executor: Executor = { run: async (_task, _project, hooks: RunHooks, signal) => new Promise((yes, no) => {
    resolve = yes; signal.addEventListener('abort', () => no(signal.reason), { once: true });
    const request: HumanRequest = { kind: 'input', description: 'choose',
      validate: answer => { if (answer !== 'yes') throw new Error('answer yes'); }, resolve: yes };
    req = hooks.request(request);
  }) };
  const f = fixture(executor);
  try {
    f.engine.receive(message('work')); await until(() => !!req);
    f.engine.receive(message(`/answer ${req} wrong`)); assert.equal(f.store.getRequest(req)?.status, 'pending');
    f.engine.receive(message(`/answer ${req} yes`)); await until(() => f.store.list()[0].status === 'review');
    assert.equal(f.store.getRequest(req)?.status, 'answered');
  } finally { resolve?.('stop'); await f.close(); }
});

test('structured tool permission input cannot be answered by ordinary topic prose',async()=>{
  const cfg={...config,groupChats:true};const store=new Store(':memory:');let resolved=0,requestId='';
  const engine=new Engine(store,cfg,{run:async(_t,_p,hooks)=>new Promise<string>(resolve=>{
    requestId=hooks.request({kind:'input',explicit:true,description:'structured tool permission',resolve:()=>{resolved++;resolve('done')}});
  })},{send:async()=>{},context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]})});
  const conversation={anchorId:'root',sourceId:'root',scope:'thread' as const};
  const send=(text:string)=>engine.receive(message(text,{chatType:'group',botMentioned:true,conversation}));
  try{
    send('do work');await until(()=>!!requestId);send('yes');assert.equal(resolved,0);
    send(`/answer ${requestId} {"decision":"once"}`);await until(()=>resolved===1);
  }finally{await engine.stop();store.close()}
});
