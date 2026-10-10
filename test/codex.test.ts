import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexExecutor, inputAnswers, type RpcPort } from '../src/adapters/codex.js';
import type { RpcMessage } from '../src/adapters/rpc.js';
import type { HumanRequest, RunHooks, Task } from '../src/types.js';

const task: Task = { id: 'task', chatId: 'dm', project: 'p', prompt: 'do work', status: 'running',
  threadId: null, result: null, createdAt: '', updatedAt: '' };
class FakeRpc implements RpcPort {
  onMessage: (m: RpcMessage) => void = () => {};
  onExit: (e: Error) => void = () => {};
  params: Record<string, any> = {}; calls: string[] = []; writes: any[] = []; closed = false;
  onTurn: () => void = () => {};
  async initialize() { this.calls.push('initialize'); }
  async subscription() { this.calls.push('subscription'); }
  async request(method: string, params: unknown) {
    this.calls.push(method); this.params[method] = params;
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } };
    if (method === 'turn/start') queueMicrotask(this.onTurn);
    return {};
  }
  write(message: unknown) { this.writes.push(message); }
  close() { this.closed = true; }
  emit(method: string, params: any, id?: number) { this.onMessage({ method, params: { threadId: 'thread', ...params }, id }); }
  finish(status = 'completed') { this.emit('turn/completed', { turn: { status } }); }
}
function setup(rpc: FakeRpc, requests: HumanRequest[] = []) {
  const hooks: RunHooks = { thread: () => {}, progress: () => {}, resolved: () => {},
    request: r => { requests.push(r); return `request-${requests.length}`; } };
  const executor = new CodexExecutor('unused', () => rpc);
  return { hooks, executor, run: (input = task) => executor.run(input,
    { path: '.', sandbox: 'read-only' }, hooks, AbortSignal.timeout(5000)) };
}

test('requires subscription before starting inference and resumes stored thread', async () => {
  const rpc = new FakeRpc();
  rpc.onTurn = () => {
    rpc.emit('item/completed', { item: { type: 'agentMessage', text: 'thinking', phase: 'commentary' } });
    rpc.emit('item/completed', { item: { type: 'agentMessage', text: 'actual artifact', phase: 'final_answer' } });
    rpc.finish();
  };
  const result = await setup(rpc).run({ ...task, threadId: 'thread' });
  assert.equal(result, 'actual artifact');
  assert.deepEqual(rpc.calls, ['initialize', 'subscription', 'thread/resume', 'turn/start']);
  assert.equal(rpc.closed, true);
});

test('API-only or missing authentication stops before any thread or turn', async () => {
  const rpc = new FakeRpc(); rpc.subscription = async () => { throw new Error('subscription required'); };
  await assert.rejects(setup(rpc).run(), /subscription required/);
  assert.equal(rpc.calls.includes('turn/start'), false); assert.equal(rpc.closed, true);
});

test('failed turns are not successful deliverables even if they contain prose', async () => {
  const rpc = new FakeRpc(); rpc.onTurn = () => {
    rpc.emit('item/completed', { item: { type: 'agentMessage', text: 'all good' } }); rpc.finish('failed');
  };
  await assert.rejects(setup(rpc).run(), /failed/);
});

test('command approvals are explicit and accept only the individual request', async () => {
  const rpc = new FakeRpc(), requests: HumanRequest[] = [];
  const s = setup(rpc, requests);
  rpc.onTurn = () => {
    rpc.emit('item/commandExecution/requestApproval', { command: 'touch example.txt', cwd: '/project' }, 15);
    assert.equal(rpc.writes.length, 0);
    assert.match(requests[0].description, /touch example/);
    requests[0].resolve('accept'); rpc.finish();
  };
  await s.run(); assert.deepEqual(rpc.writes[0], { id: 15, result: { decision: 'accept' } });
});

test('unknown permission requests fail closed and server resolution invalidates local approvals', async () => {
  const rpc = new FakeRpc(); const expired: string[] = [], s = setup(rpc);
  s.hooks.resolved = id => expired.push(id);
  rpc.onTurn = () => {
    rpc.emit('future/elevatedPermission', {}, 1);
    rpc.emit('item/commandExecution/requestApproval', { command: 'example' }, 2);
    rpc.emit('serverRequest/resolved', { requestId: 2 }); rpc.finish();
  };
  await s.run(); assert.equal(rpc.writes[0].error.code, -32601);
  assert.deepEqual(expired, ['request-1']);
});

test('cancellation closes the runtime while waiting for human input', async () => {
  const rpc = new FakeRpc(), controller = new AbortController(), s = setup(rpc);
  rpc.onTurn = () => {
    rpc.emit('tool/requestUserInput', { questions: [{ id: 'q', question: 'choose' }] }, 7);
    controller.abort(new Error('cancelled by owner'));
  };
  await assert.rejects(s.executor.run(task, { path: '.', sandbox: 'read-only' }, s.hooks, controller.signal), /cancelled/);
  assert.equal(rpc.closed, true);
});

test('multi-question responses require complete, explicit answers', () => {
  const questions = [{ id: 'a' }, { id: 'b' }];
  assert.throws(() => inputAnswers(questions, 'yes'), /JSON/);
  assert.throws(() => inputAnswers(questions, '{"a":"yes"}'), /b/);
  assert.deepEqual(inputAnswers(questions, '{"a":"yes","b":"no"}'),
    { a: { answers: ['yes'] }, b: { answers: ['no'] } });
});


test('image attachments reach the subscription turn as localImage inputs, unread resources do not',async()=>{
  const rpc=new FakeRpc();rpc.onTurn=()=>rpc.finish();
  await setup(rpc).run({...task,contextSnapshot:{summary:'media',capturedAt:'',truncated:false,messages:[],attachments:[
    {messageId:'source',kind:'image',status:'attached',detail:'attached',path:'/private/image.png'},
    {messageId:'source',kind:'video',status:'unread',detail:'video unread'},
    {messageId:'source',kind:'image',status:'unread',detail:'failed'},
  ]}});
  const input=rpc.params['turn/start'].input;assert.equal(input.length,2);
  assert.deepEqual(input[1],{type:'localImage',path:'/private/image.png'});assert.match(input[0].text,/video unread/);
});

test('PDF pages and sampled video frames keep source/time labels in model input; transcripts are text',async()=>{
  const rpc=new FakeRpc();rpc.onTurn=()=>rpc.finish();
  await setup(rpc).run({...task,contextSnapshot:{summary:'media',capturedAt:'',truncated:false,messages:[],attachments:[
    {messageId:'pdf',kind:'file',status:'processed',detail:'2 pages',visuals:[{path:'/private/page.png',label:'PDF 第 2 页'}]},
    {messageId:'video',kind:'video',status:'partial',detail:'sampled',text:'00:00:01 --> 00:00:02 speech',visuals:[{path:'/private/frame.png',label:'视频 1.00 秒抽样画面'}]},
  ]}});
  const input=rpc.params['turn/start'].input;
  assert.equal(input.length,5);assert.match(input[1].text,/pdf.*第 2 页/);assert.equal(input[2].path,'/private/page.png');
  assert.match(input[3].text,/video.*1.00 秒/);assert.equal(input[4].type,'localImage');assert.match(input[0].text,/speech/);assert.ok(!input[0].text.includes('/private/'));
});
