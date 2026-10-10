import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { WorkspaceExecutor, canPublish, git, inventory, prepareWorkspace, publish, publicationKey } from '../src/workspace.js';
import { commandEnv, runCommand } from '../src/process.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { buildCard } from '../src/channels/cards.js';
import type { Config, RunHooks } from '../src/types.js';
const signal = () => AbortSignal.timeout(30_000);
const hooks: RunHooks = { thread() {}, progress() {}, request() { throw Error('unexpected request'); }, resolved() {} };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'steward-worktree-'));
  const source = join(root, 'repo'), remote = join(root, 'remote.git'), stateDir = join(root, 'state');
  mkdirSync(source); mkdirSync(stateDir);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-b', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(source, '.gitignore'), '.env\nnode_modules/\n'); writeFileSync(join(source, 'README.md'), 'base\n');
  g('add', '--', '.gitignore', 'README.md'); g('commit', '-m', 'base');
  g('init', '--bare', remote); g('remote', 'add', 'origin', remote); g('push', '-u', 'origin', 'main');
  const config: Config = { ownerId: 'owner', stateDir, codexCommand: 'codex', maxRunMinutes: 1,
    projects: { test: { path: source, sandbox: 'workspace-write', worktree: { baseRef: 'origin/main',
      checks: [{ name: 'content check', command: process.execPath, args: ['-e', "if(require('fs').readFileSync('README.md','utf8')!=='changed\\n')process.exit(1)"] }],
      github: { repository: 'test/repo', baseBranch: 'main' } } } } };
  const store = new Store(join(stateDir, 'db.sqlite'));
  const task = store.create('dm', 'test', 'Update README', 'workspace-write');
  const executor = new WorkspaceExecutor(config, store, { run: async (_t, p) => { writeFileSync(join(p.path, 'README.md'), 'changed\n'); return 'done'; } });
  return { root, source, config, project: config.projects.test, store, task, executor, g,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('real worktree isolates dirty source, preserves session workspace, and records independent checks', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, 'README.md'), 'owner WIP'); writeFileSync(join(f.source, '.env'), 'private');
    await f.executor.run(f.task, f.project, hooks, signal());
    const report = f.store.delivery(f.task.id)!;
    assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), 'owner WIP');
    assert.equal(f.g('branch', '--show-current'), 'main');
    assert.equal(existsSync(join(report.workspace.path, '.env')), false);
    assert.deepEqual(report.files, ['README.md']); assert.equal(report.checks[0].status, 'passed');
    assert.equal(canPublish(f.task, f.project, report), true);
    assert.equal((await prepareWorkspace(f.store, f.config.stateDir, f.task, f.project, signal())).path, report.workspace.path);
    f.project.worktree!.checks[0].args = ['-e', 'process.exit(1)'];
    assert.equal(canPublish(f.task, f.project, report), false, 'changed validation configuration requires rerun');
    await git(report.workspace.path, ['checkout', '--detach'], signal());
    await assert.rejects(prepareWorkspace(f.store, f.config.stateDir, f.task, f.project, signal()), /Git|分支/);
  } finally { f.close(); }
});
test('failed or file-mutating checks cannot publish; continuation invalidates validation', async () => {
  const f = fixture();
  try {
    f.project.worktree!.checks[0].args = ['-e', 'process.exit(2)'];
    await f.executor.run(f.task, f.project, hooks, signal());
    assert.equal(f.store.delivery(f.task.id)!.ready, false); assert.equal(f.store.delivery(f.task.id)!.checks[0].exitCode, 2);
    f.project.worktree!.checks[0].args = ['-e', "require('fs').writeFileSync('README.md','changed by test')"];
    await f.executor.run(f.task, f.project, hooks, signal());
    assert.match(f.store.delivery(f.task.id)!.error!, /修改/); assert.equal(f.store.delivery(f.task.id)!.ready, false);
    f.project.worktree!.checks[0].args = ['-e', 'process.exit(0)'];
    await f.executor.run(f.task, f.project, hooks, signal());
    assert.equal(f.store.delivery(f.task.id)!.ready, true);
    f.store.resume(f.task.id, 'more'); assert.equal(f.store.delivery(f.task.id)!.ready, false);
  } finally { f.close(); }
});
test('readonly defaults never execute project checks; write needs both explicit mode and project capability', async () => {
  const f = fixture();
  try {
    let mode = '';
    const ex = new WorkspaceExecutor(f.config, f.store, { run: async (_t, p) => { mode = p.sandbox; return 'analysis'; } });
    await ex.run({ ...f.task, mode: undefined }, f.project, hooks, signal());
    assert.equal(mode, 'read-only'); assert.deepEqual(f.store.delivery(f.task.id)!.checks, []);
    await assert.rejects(ex.run(f.task, { path: f.source, sandbox: 'read-only' }, hooks, signal()), /不允许修改/);
  } finally { f.close(); }
});
test('publication commits exact validated files, reuses PR, and only pushes the task branch', async () => {
  const f = fixture();
  try {
    await f.executor.run(f.task, f.project, hooks, signal());
    const report = f.store.delivery(f.task.id)!;
    f.store.saveDelivery(f.task.id, { ...report, authorizedKey: publicationKey(f.task, f.project, report) });
    const evidenceDir = join(report.workspace.path, '.steward-delivery');
    mkdirSync(evidenceDir, {recursive:true});
    writeFileSync(join(evidenceDir, 'private.png'), 'not code');
    const calls: string[][] = []; let creates = 0, edits = 0;
    const repoGit: typeof git = async (cwd, args, sig) => {
      calls.push(args);
      // Network transport is a local bare Git repository; production identity check is exercised separately.
      if (args[0] === 'remote') return 'https://github.com/test/repo.git';
      return git(cwd, args, sig);
    };
    const gh = async (cwd: string, args: string[], sig: AbortSignal) => {
      if (args[1] === 'create') { creates++; assert.ok(args.includes('--draft')); throw Error('simulated lost response after remote creation'); }
      if (args[1] === 'edit') { edits++; return ''; }
      const pr = { number: 1, url: 'https://github.com/test/repo/pull/1', state: 'OPEN', baseRefName: 'main', headRefName: report.workspace.branch };
      if (args[1] === 'list') return JSON.stringify(creates ? [pr] : []);
      if (args[1] === 'view') return JSON.stringify({ ...pr, headRefOid: await git(cwd, ['rev-parse', 'HEAD'], sig) });
      throw Error('unexpected gh command');
    };
    await publish(f.store, f.config, f.task, f.project, signal(), gh, repoGit);
    await publish(f.store, f.config, f.task, f.project, signal(), gh, repoGit);
    assert.equal(creates, 1); assert.equal(edits, 1);
    assert.equal(await git(report.workspace.path, ['ls-files', '--', '.steward-delivery'], signal()), '');
    assert.equal(f.store.delivery(f.task.id)!.prUrl, 'https://github.com/test/repo/pull/1');
    assert.equal(f.g('rev-parse', 'origin/main'), report.workspace.baseSha);
    assert.ok(calls.filter(a => a[0] === 'push').every(a => a.join(' ') === `push origin HEAD:refs/heads/${report.workspace.branch}`));
    assert.equal((await inventory(report.workspace, signal())).fingerprint, report.fingerprint);
    writeFileSync(join(report.workspace.path, 'README.md'), 'changed after validation');
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), gh, repoGit), /验证后文件发生变化/);
  } finally { f.close(); }
});
test('publication rejects wrong origin, changed target, and closed PR before push', async () => {
  const f = fixture();
  try {
    await f.executor.run(f.task, f.project, hooks, signal());
    const report = f.store.delivery(f.task.id)!;
    f.store.saveDelivery(f.task.id, { ...report, authorizedKey: publicationKey(f.task, f.project, report) });
    const gh = async () => '[]';
    f.project.worktree!.github!.repository = 'other/repo';
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), gh), /重新预览/);
    f.project.worktree!.github!.repository = 'test/repo';
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), gh), /origin/);
    let pushes = 0;
    const transport: typeof git = async (cwd, args, sig) => {
      if (args[0] === 'remote') return 'https://github.com/test/repo.git';
      if (args[0] === 'push') pushes++;
      return git(cwd, args, sig);
    };
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), async () => JSON.stringify([{ state: 'CLOSED', baseRefName: 'main' }]), transport), /关闭/);
    f.g('commit', '--allow-empty', '-m', 'upstream changed'); f.g('push', 'origin', 'main');
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), gh, transport), /目标分支已更新/);
    assert.equal(pushes, 0);
  } finally { f.close(); }
});
test('write form cannot escalate read-only project; publication confirmation is owner-bound and single-use', async () => {
  const f = fixture(); let runs = 0;
  const engine = new Engine(f.store, f.config, { run: async t => { runs++; assert.equal(t.nextAction, 'publish'); return 'published'; } }, { send: async () => {} });
  try {
    await f.executor.run(f.task, f.project, hooks, signal()); f.store.set(f.task.id, 'review', 'done');
    const t = f.store.get(f.task.id)!;
    const card = JSON.stringify(buildCard(f.store, f.config, 'dm', { kind: 'publication', taskId: t.id }));
    assert.match(card, /test\/repo/); assert.match(card, /content check: passed/);
    const action = { id: 'click', senderId: 'owner', chatId: 'dm', messageId: 'message', fields: {},
      actionId: f.store.action('dm', { op: 'publish', taskId: t.id, revision: t.updatedAt, publicationKey: publicationKey(t, f.project, f.store.delivery(t.id)!) }) };
    assert.equal(engine.handleAction({ ...action, senderId: 'stranger' }).toast.type, 'error');
    assert.equal(engine.handleAction(action).toast.type, 'success');
    assert.equal(engine.handleAction({ ...action, id: 'again' }).toast.type, 'error');
    await new Promise(r => setTimeout(r, 20)); assert.equal(runs, 1);
    f.project.sandbox = 'read-only';
    const form = { ...action, id: 'form', actionId: f.store.action('dm', { op: 'new' }), fields: { body: 'work', project: 'test', mode: 'workspace-write' } };
    assert.equal(engine.handleAction(form).toast.type, 'error');
    assert.equal(f.store.list().length, 1);
  } finally { await engine.stop(); f.close(); }
});
test('schema v2 migration preserves old tasks and makes them explicitly read-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-migrate-')), path = join(root, 'state.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,chatId TEXT,project TEXT,prompt TEXT,status TEXT,threadId TEXT,result TEXT,createdAt TEXT,updatedAt TEXT); INSERT INTO tasks VALUES('12345678','dm','p','work','review','session','done','now','now'); PRAGMA user_version=2;"); db.close();
    const store = new Store(path);
    assert.equal(store.get('12345678')!.mode, 'read-only'); assert.equal(store.get('12345678')!.threadId, 'session');
    assert.equal(store.get('12345678')!.nextAction, 'execute'); store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('validation commands scrub service credentials, time out, and report log failures without hanging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-command-'));
  try {
    assert.equal(commandEnv(true).FEISHU_APP_SECRET, undefined); assert.equal(commandEnv(true).OPENAI_API_KEY, undefined);
    assert.equal(commandEnv(true).GH_TOKEN, undefined);
    await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, signal(), { timeoutSeconds: 0.05 }), /超时/);
    await assert.rejects(runCommand(process.execPath, ['-e', 'console.log("check")'], root, signal(), { log: join(root, 'missing', 'log') }), /日志/);
    const controller = new AbortController(); const job = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, controller.signal);
    controller.abort(new Error('cancelled')); await assert.rejects(job, /cancelled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('write configuration requires worktree and a consistent GitHub base', () => {
  const f = fixture(), previous = process.env.STEWARD_OWNER_ID;
  try {
    process.env.STEWARD_OWNER_ID = 'owner';
    const path = join(f.root, 'config.json');
    const save = () => writeFileSync(path, JSON.stringify(f.config));
    save(); assert.equal(loadConfig(path).projects.test.worktree!.baseRef, 'origin/main');
    f.project.worktree!.github!.baseBranch = 'staging'; save();
    assert.throws(() => loadConfig(path), /GitHub target/);
    delete f.project.worktree; save(); assert.throws(() => loadConfig(path), /requires an isolated worktree/);
  } finally {
    if (previous === undefined) delete process.env.STEWARD_OWNER_ID; else process.env.STEWARD_OWNER_ID = previous;
    f.close();
  }
});

test('baseline restart pins an approved SHA, preserves old WIP/session and leaves project defaults alone', async () => {
  const { baselinePreview, restartAtBaseline } = await import('../src/baseline.js');
  const f = fixture();
  try {
    const old = await prepareWorkspace(f.store,f.config.stateDir,f.task,f.project,signal());
    f.store.thread(f.task.id,'old-session'); writeFileSync(join(old.path,'README.md'),'unfinished work');
    writeFileSync(join(f.source,'feature.txt'),'new implementation'); f.g('add','feature.txt'); f.g('commit','-m','new base');
    const sha=f.g('rev-parse','HEAD'); f.store.set(f.task.id,'review');
    const preview=await baselinePreview(f.store,f.task,f.project,'main',signal());
    assert.equal(preview.sha,sha); assert.equal(preview.before.files.length,1);
    const next=await restartAtBaseline(f.store,f.config,f.store.get(f.task.id)!,preview,signal());
    assert.equal(next.threadId,null); assert.equal(next.mode,f.task.mode); assert.match(next.prompt,/Update README/);
    assert.equal(f.store.get(f.task.id)?.threadId,'old-session'); assert.equal(readFileSync(join(old.path,'README.md'),'utf8'),'unfinished work');
    const newer=await prepareWorkspace(f.store,f.config.stateDir,next,f.project,signal());
    assert.equal(await git(newer.path,['rev-parse','HEAD'],signal()),sha); assert.equal(readFileSync(join(newer.path,'README.md'),'utf8'),'base\n');
    assert.equal(f.project.worktree?.baseRef,'origin/main'); assert.equal(f.g('branch','--show-current'),'main');
    writeFileSync(join(f.source,'later'),'later');f.g('add','later');f.g('commit','-m','move main');
    await prepareWorkspace(f.store,f.config.stateDir,next,f.project,signal());
    assert.equal(await git(newer.path,['rev-parse','HEAD'],signal()),sha);
  } finally { f.close(); }
});
test('baseline approval cannot apply after WIP or grants change and refs cannot contain expressions',async()=>{
  const { baselinePreview, restartAtBaseline, validBaseRef }=await import('../src/baseline.js'); const f=fixture();
  try {
    const old=await prepareWorkspace(f.store,f.config.stateDir,f.task,f.project,signal());f.store.set(f.task.id,'review');
    assert.equal(validBaseRef('main~1'),false); assert.equal(validBaseRef('--help'),false); assert.equal(validBaseRef('a..b'),false);
    const preview=await baselinePreview(f.store,f.task,f.project,'main',signal());
    writeFileSync(join(old.path,'README.md'),'new WIP');
    await assert.rejects(restartAtBaseline(f.store,f.config,f.task,preview,signal()),/内容已变化/);
    const fresh=await baselinePreview(f.store,f.task,f.project,'main',signal());f.project.sandbox='read-only';
    await assert.rejects(restartAtBaseline(f.store,f.config,f.task,fresh,signal()),/权限已变化/);
    assert.equal(f.store.list().length,1);assert.equal(readFileSync(join(old.path,'README.md'),'utf8'),'new WIP');
  }finally{f.close()}
});

test('topic baseline flow requires one owner confirmation, hands off bindings and invalidates old controls',async()=>{
  const f=fixture(); f.config.groupChats=true;
  const conversation={anchorId:'root',sourceId:'root',scope:'thread' as const,threadId:'topic'};
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}assert.fail('timed out')};
  const engine=new Engine(f.store,f.config,{run:async task=>{assert.equal(task.threadId,null);return 'new execution'}},{send:async()=>{},context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]})});
  let n=0;const send=(text:string,senderId='owner')=>engine.receive({id:'baseline-'+(++n),senderId,chatId:'dm',senderType:'user',chatType:'group',botMentioned:true,text,conversation});
  try{
    const old=await prepareWorkspace(f.store,f.config.stateDir,f.task,f.project,signal());
    f.store.saveConversation(f.task.id,conversation);f.store.set(f.task.id,'review');
    const oldAction=f.store.action('dm',{op:'continue',taskId:f.task.id,revision:f.store.get(f.task.id)!.updatedAt,conversation});
    send(`/restart ${f.task.id} main`);
    await wait(()=>f.store.get(f.task.id)?.status==='waiting_approval');
    const req=f.store.requests(f.task.id)[0];assert.equal(req.kind,'approval');
    const card=JSON.stringify(buildCard(f.store,f.config,'dm',{kind:'task',taskId:f.task.id}));
    assert.ok(card.includes(old.baseSha));assert.match(card,/旧任务有 0 个改动文件/);
    send(`/approve ${req.id}`,'stranger');send('可以');assert.equal(f.store.getRequest(req.id)?.status,'pending');
    send(`/approve ${req.id}`);
    await wait(()=>f.store.list().some(t=>t.id!==f.task.id&&t.status==='review'));
    const next=f.store.conversationTask('dm',conversation)!;assert.notEqual(next.id,f.task.id);
    assert.equal(f.store.workspace(next.id)?.baseRef,'main');assert.equal(f.store.workspace(f.task.id)?.baseRef,'origin/main');
    assert.equal(engine.handleAction({id:'stale',senderId:'owner',chatId:'dm',actionId:oldAction,messageId:'msg',fields:{body:'modify'}}).toast.type,'error');
    send(`/approve ${req.id}`);assert.equal(f.store.list().length,2);
  }finally{await engine.stop();f.close()}
});

test('declining a baseline leaves the task/session untouched and cancellation expires the pending confirmation',async()=>{
  const f=fixture();let runs=0;
  const engine=new Engine(f.store,f.config,{run:async()=>{runs++;return 'unexpected'}},{send:async()=>{}});
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}assert.fail('timed out')};
  let n=0;const send=(text:string)=>engine.receive({id:'cancel-'+(++n),senderId:'owner',chatId:'dm',senderType:'user',chatType:'p2p',text});
  try{
    await prepareWorkspace(f.store,f.config.stateDir,f.task,f.project,signal());f.store.thread(f.task.id,'keep');f.store.set(f.task.id,'review','original result');
    send(`/restart ${f.task.id} main`);await wait(()=>f.store.requests(f.task.id).length===1);
    send(`/deny ${f.store.requests(f.task.id)[0].id}`);await wait(()=>f.store.get(f.task.id)?.status==='review');
    assert.equal(f.store.get(f.task.id)?.result,'original result');assert.equal(f.store.get(f.task.id)?.threadId,'keep');
    send(`/restart ${f.task.id} main`);await wait(()=>f.store.requests(f.task.id).length===1);
    const req=f.store.requests(f.task.id)[0].id;send(`/cancel ${f.task.id}`);await new Promise(r=>setTimeout(r,30));
    send(`/approve ${req}`);assert.equal(f.store.getRequest(req)?.status,'expired');assert.equal(f.store.list().length,1);assert.equal(runs,0);
  }finally{await engine.stop();f.close()}
});

test('code source receipt follows verified preparation and precedes inference, including continuation edits', async () => {
  const f = fixture();
  try {
    let prepared = 0;
    const ex = new WorkspaceExecutor(f.config, f.store, { run: async (t, p) => {
      assert.equal(prepared, 1);
      assert.equal(t.codeVersion!.baseSha, f.g('rev-parse', 'HEAD'));
      assert.notEqual(p.path, f.source);
      return 'done';
    } });
    await f.executor.run(f.task, f.project, hooks, signal());
    await ex.run(f.task, f.project, { ...hooks, prepared: r => {
      prepared++;
      assert.deepEqual(r.files, ['README.md']);
      assert.equal(r.workspace.baseRef, 'origin/main');
      assert.equal(r.headSha, f.g('rev-parse', 'HEAD'));
      assert.deepEqual(f.store.delivery(f.task.id), r);
    } }, signal());
    prepared = 0;
    await assert.rejects(ex.run(f.task, { ...f.project, path: join(f.root, 'missing') }, { ...hooks, prepared: () => { prepared++; } }, signal()));
    assert.equal(prepared, 0, 'failed preparation must not claim a code version');
  } finally { f.close(); }
});

test('UI screenshot outputs are collected separately and never enter the code inventory', async () => {
  const f = fixture();
  try {
    const ex = new WorkspaceExecutor(f.config,f.store,{run:async(t,p)=>{
      assert.ok(t.evidenceDirectory?.startsWith(p.path));
      writeFileSync(join(p.path,'README.md'),'changed\n');
      writeFileSync(join(t.evidenceDirectory!,'screen.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6H1kAAAAASUVORK5CYII=','base64'));
      writeFileSync(join(t.evidenceDirectory!,'images.json'),JSON.stringify([{file:'screen.png',caption:'本地模拟',scope:'local-preview'}]));
      return 'done';
    }});
    await ex.run(f.task,f.project,hooks,signal());
    const r=f.store.delivery(f.task.id)!;assert.deepEqual(r.files,['README.md']);assert.equal(r.evidenceIds?.length,1);assert.equal(r.ready,true);
    assert.ok(!r.diffStat.includes('.steward-delivery'));assert.equal(f.store.evidence(r.evidenceIds![0],f.task.id)?.scope,'local-preview');
  }finally{f.close();}
});
