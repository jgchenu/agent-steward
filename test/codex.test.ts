import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexExecutor, inputAnswers, type RpcPort } from '../src/adapters/codex.js';
import type { RpcMessage } from '../src/adapters/rpc.js';
import type { HumanRequest, RunHooks, Task } from '../src/types.js';
import { executionOnlyApprovals } from '../src/permissions.js';

const task: Task = { id: 'task', chatId: 'dm', project: 'p', prompt: 'do work', status: 'running',
  threadId: null, result: null, createdAt: '', updatedAt: '' };
class FakeRpc implements RpcPort {
  onMessage: (m: RpcMessage) => void = () => {};
  onExit: (e: Error) => void = () => {};
  params: Record<string, any> = {}; calls: string[] = []; writes: any[] = []; closed = false;
  onTurn: () => void = () => {};
  async initialize() { this.calls.push('initialize'); }
  async subscription() { this.calls.push('subscription'); }
  async request(method: string, params: unknown): Promise<any> {
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

test('MCP browser confirmation waits for owner, responds once and never persists approval', async () => {
  const rpc = new FakeRpc(), requests: HumanRequest[] = [], s = setup(rpc, requests);
  rpc.onTurn = () => {
    rpc.emit('mcpServer/elicitation/request', { serverName: 'browser', mode: 'form', message: 'Read https://example.test in connected Chrome?',
      requestedSchema: { type: 'object', properties: {} }, _meta: { persist: ['session','always'] } }, 51);
    assert.equal(requests[0].kind, 'approval'); assert.equal(rpc.writes.length, 0);
    assert.match(requests[0].description, /example.test/);
    requests[0].resolve('accept'); requests[0].resolve('accept'); rpc.finish();
  };
  await s.run(); assert.deepEqual(rpc.writes, [{ id: 51, result: { action: 'accept', content: {}, _meta: null } }]);
});
test('MCP denial and server expiry do not become acceptance; unknown URL or sensitive schemas cancel', async () => {
  const rpc = new FakeRpc(), requests: HumanRequest[] = [], s = setup(rpc, requests);
  const form = { serverName: 'browser', mode: 'form', message: 'Allow access?', requestedSchema: { type: 'object', properties: {} } };
  rpc.onTurn = () => {
    rpc.emit('mcpServer/elicitation/request', form, 1); requests[0].resolve('decline');
    rpc.emit('mcpServer/elicitation/request', form, 2);
    rpc.emit('serverRequest/resolved', { requestId: 2 }); requests[1].resolve('accept');
    rpc.emit('mcpServer/elicitation/request', { ...form, mode: 'url', url: 'https://example.test/oauth' }, 3);
    rpc.emit('mcpServer/elicitation/request', { ...form, requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }, 4);
    rpc.finish();
  };
  await s.run(); assert.equal(requests.length, 2); assert.deepEqual(rpc.writes.map(w=>w.result.action), ['decline','cancel','cancel']);
});
test('structured MCP forms require explicit validated JSON and do not inherit default answers', async () => {
  const rpc = new FakeRpc(), requests: HumanRequest[] = [], s = setup(rpc, requests);
  rpc.onTurn = () => {
    rpc.emit('mcpServer/elicitation/request', { serverName: 'test', mode: 'form', message: 'Select access', requestedSchema: {
      type: 'object', properties: { scope: { type: 'string', enum: ['once','deny'] } }, required: ['scope'] } }, 9);
    assert.equal(requests[0].explicit, true);
    assert.throws(()=>requests[0].validate!('yes')); assert.throws(()=>requests[0].validate!('{"scope":"always"}'));
    assert.throws(()=>requests[0].validate!('{"scope":"once","extra":true}'));
    requests[0].validate!('{"scope":"once"}'); requests[0].resolve('{"scope":"once"}'); rpc.finish();
  };
  await s.run(); assert.deepEqual(rpc.writes[0].result,{action:'accept',content:{scope:'once'},_meta:null});
});

test('automatic reviewer is explicit on start/resume and turn without widening sandbox or bypassing human requests', async () => {
  for (const threadId of [null, 'thread']) {
    const rpc = new FakeRpc(), requests: HumanRequest[] = [], s = setup(rpc, requests);
    const ex = new CodexExecutor('unused', () => rpc, 'auto_review');
    rpc.onTurn = () => {
      rpc.emit('item/commandExecution/requestApproval', {command:'needs human'}, 90);
      assert.equal(rpc.writes.length,0); requests[0].resolve('decline'); rpc.finish();
    };
    await ex.run({...task,threadId}, {path:'.',sandbox:'read-only'},s.hooks,AbortSignal.timeout(5000));
    const common = rpc.params[threadId ? 'thread/resume' : 'thread/start'];
    assert.equal(common.approvalsReviewer,'auto_review'); assert.equal(common.sandbox,'read-only');
    assert.equal(common.approvalPolicy,'on-request');
    assert.equal(rpc.params['turn/start'].approvalsReviewer,'auto_review');
    assert.deepEqual(rpc.writes[0].result,{decision:'decline'});
  }
});

test('unsupported automatic reviewer fails without full-access or manual-policy retry', async () => {
  const rpc = new FakeRpc(), s = setup(rpc);
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === 'thread/start') { rpc.calls.push(method); throw Error('reviewer unavailable'); }
    return request(method, params);
  };
  await assert.rejects(new CodexExecutor('unused',()=>rpc,'auto_review').run(task,{path:'.',sandbox:'read-only'},s.hooks,AbortSignal.timeout(5000)), /reviewer unavailable/);
  assert.equal(rpc.calls.filter(c=>c==='thread/start').length,1);
  assert.ok(!rpc.calls.includes('turn/start')); assert.equal(rpc.closed,true);
});

test('console modes map explicitly on new and resumed threads; full access cannot widen read-only tasks', async () => {
  for (const permissionMode of ['ask','auto','sandbox-auto','full-access'] as const) for (const sandbox of ['read-only','workspace-write'] as const) for (const threadId of [null,'thread']) {
    const rpc = new FakeRpc(), s = setup(rpc);rpc.onTurn=()=>rpc.finish();
    await s.executor.run({...task,permissionMode,threadId}, {path:'.',sandbox},s.hooks,AbortSignal.timeout(5000));
    const common=rpc.params[threadId?'thread/resume':'thread/start'];
    assert.equal(common.sandbox,permissionMode==='full-access'&&sandbox==='workspace-write'?'danger-full-access':sandbox);
    assert.deepEqual(common.approvalPolicy,['full-access','sandbox-auto'].includes(permissionMode)?executionOnlyApprovals():'on-request');
    assert.equal(common.approvalsReviewer,permissionMode==='auto'?'auto_review':'user');
    assert.equal(rpc.params['turn/start'].approvalPolicy,common.approvalPolicy);
    const policy=rpc.params['turn/start'].sandboxPolicy;
    assert.equal(policy.type,common.sandbox==='danger-full-access'?'dangerFullAccess':sandbox==='read-only'?'readOnly':'workspaceWrite');
    if(policy.type==='workspaceWrite'){assert.deepEqual(policy.writableRoots,['.']);assert.equal(policy.networkAccess,permissionMode==='sandbox-auto');assert.equal(policy.excludeSlashTmp,permissionMode==='sandbox-auto');}
    if(policy.type==='readOnly')assert.equal(policy.networkAccess,false);
    assert.equal(rpc.params['turn/start'].approvalsReviewer,common.approvalsReviewer);
  }
});

test('conversation execution cannot inherit full access and new code threads keep Codex project identity',async()=>{
 const rpc=new FakeRpc(),s=setup(rpc);rpc.onTurn=()=>rpc.finish();
 await s.executor.run({...task,project:'__conversation__',permissionMode:'full-access'}, {path:'.',sandbox:'read-only'},s.hooks,AbortSignal.timeout(5000));
 assert.equal(rpc.params['thread/start'].sandbox,'read-only');assert.equal(rpc.params['thread/start'].approvalPolicy,'never');assert.equal(rpc.params['thread/start'].projectId,null);
 assert.match(rpc.params['thread/start'].developerInstructions,/conversation without a code project/);
 const code=new FakeRpc(),cs=setup(code);code.onTurn=()=>code.finish();await cs.executor.run(task,{path:'.',sandbox:'read-only',codexProjectId:'codex-project'},cs.hooks,AbortSignal.timeout(5000));assert.equal(code.params['thread/start'].projectId,'codex-project');
});

test('explicit model and effort are applied to new and resumed turns; unavailable combinations stop before inference',async()=>{
 for(const threadId of [null,'thread']){
  const rpc=new FakeRpc(),request=rpc.request.bind(rpc);
  rpc.request=async(method,params)=>method==='model/list'?{data:[{model:'model-a',displayName:'A',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]}:request(method,params);
  rpc.onTurn=()=>rpc.finish();await setup(rpc).run({...task,threadId,modelSelection:{model:'model-a',effort:'high'}});
  assert.equal(rpc.params[threadId?'thread/resume':'thread/start'].model,'model-a');assert.equal(rpc.params['turn/start'].model,'model-a');assert.equal(rpc.params['turn/start'].effort,'high');
 }
 const rpc=new FakeRpc();rpc.request=async()=>({data:[]});
 await assert.rejects(setup(rpc).run({...task,modelSelection:{model:'gone',effort:'high'}}),/不可用/);assert.ok(!rpc.calls.includes('turn/start'));
});


test('execution-only approval modes reject unexpected escalation without creating a human request',async()=>{
 const rpc=new FakeRpc(),requests:HumanRequest[]=[];rpc.onTurn=()=>{rpc.emit('item/commandExecution/requestApproval',{command:'outside operation'},77);rpc.finish()};
 await setup(rpc,requests).run({...task,permissionMode:'sandbox-auto'});assert.equal(requests.length,0);assert.deepEqual(rpc.writes.find(m=>m.id===77).result,{decision:'decline'});
});

test('sandbox automation preserves MCP confirmation on new and resumed turns without enabling escalation',async()=>{
 for(const mode of ['sandbox-auto','full-access'] as const)for(const threadId of [null,'thread']){
  const rpc=new FakeRpc(),requests:HumanRequest[]=[];
  rpc.onTurn=()=>{
   assert.deepEqual(rpc.params['turn/start'].approvalPolicy,{granular:{sandbox_approval:false,rules:false,skill_approval:false,request_permissions:false,mcp_elicitations:true}});
   rpc.emit('mcpServer/elicitation/request',{serverName:'browser',mode:'form',message:'Allow this browser origin?',requestedSchema:{type:'object',properties:{}}},33);
   assert.equal(requests.length,1);assert.equal(rpc.writes.length,0);
   requests[0].resolve('accept');rpc.finish();
  };
  await setup(rpc,requests).run({...task,permissionMode:mode,threadId});
  assert.deepEqual(rpc.writes[0].result,{action:'accept',content:{},_meta:null});
 }
});
