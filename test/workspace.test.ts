import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { WorkspaceExecutor, canPublish, canRequestDraftException, git, inventory, prepareWorkspace, publish, publicationKey } from '../src/workspace.js';
import { commandEnv, runCommand } from '../src/process.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { buildCard } from '../src/channels/cards.js';
import type { Config, Executor, PublicationTarget, RunHooks, View } from '../src/types.js';
const signal = () => AbortSignal.timeout(30_000);
const hooks: RunHooks = { thread() {}, progress() {}, request() { throw Error('unexpected request'); }, resolved() {} };
function fixture(commitAuthors: Executor['commitAuthors'] | null = [{ name: 'Codex', email: 'codex@openai.com' }]) {
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
  const executor = new WorkspaceExecutor(config, store, { ...(commitAuthors ? { commitAuthors } : {}),
    run: async (_t, p) => { writeFileSync(join(p.path, 'README.md'), 'changed\n'); return 'done'; } });
  return { root, source, config, project: config.projects.test, store, task, executor, g,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('natural owner PR request reaches a checked, durable preview through a simulated semantic proposal', async () => {
  const f=fixture(),views:View[]=[],cards:string[]=[];let runs=0;
  f.config.groupChats=true;
  const conversation={anchorId:'root',sourceId:'root',threadId:'topic',scope:'thread' as const};
  f.store.saveConversation(f.task.id,conversation);f.store.set(f.task.id,'review','Changes ready');
  const executor=new WorkspaceExecutor(f.config,f.store,{run:async(t,p,h)=>{
    runs++;assert.equal(t.prompt,'可以的，提交代码创建PR到main');
    writeFileSync(join(p.path,'README.md'),'changed\n');
    h.proposePublication!({repository:'',baseBranch:'main'});return '将为你准备 PR 预览。';
  }});
  const engine=new Engine(f.store,f.config,executor,{
    context:async()=>({summary:'',capturedAt:'',truncated:false,messages:[]}),acknowledge:async()=>{},
    send:async(_chat,_text,_id,view)=>{if(view){views.push(view);if(view.kind==='publication')cards.push(JSON.stringify(buildCard(f.store,f.config,'dm',view)));}},
  });
  try {
    const message={id:'request',chatId:'dm',chatType:'group' as const,senderId:'owner',senderType:'user',text:'可以的，提交代码创建PR到main',botMentioned:true,conversation};
    engine.receive({...message,id:'foreign',senderId:'other'});assert.equal(runs,0);
    engine.receive(message);engine.receive(message);
    for(let n=0;n<1000&&f.store.get(f.task.id)?.status!=='review';n++)await delay(5);
    assert.equal(f.store.get(f.task.id)?.status,'review');await engine.flush();
    assert.equal(runs,1);assert.equal(views.filter(v=>v.kind==='publication').length,1);
    const view=views.find(v=>v.kind==='publication')!;
    assert.deepEqual(view.publicationTarget,{repository:'test/repo',baseBranch:'main'});
    assert.match(cards[0],/确认创建草稿 PR/);assert.match(cards[0],/content check: passed/);
    const report=f.store.delivery(f.task.id)!;
    assert.equal(report.authorizedKey,undefined);assert.equal(report.prUrl,undefined);
    assert.equal(f.store.get(f.task.id)!.nextAction,'execute');
    assert.equal(f.g('rev-parse','main'),f.g('rev-parse','origin/main'));
    f.project.worktree!.github!.baseBranch='staging';
    const delayed=JSON.stringify(buildCard(f.store,f.config,'dm',view));
    assert.match(delayed,/请求交付到.*main/);assert.match(delayed,/当前配置为.*staging/);
    assert.ok(!delayed.includes('确认创建草稿 PR'));
  } finally {await engine.stop();f.close();}
});

test('semantic publication previews explain target mismatches and failed validation without offering publication',async()=>{
  for(const scenario of ['branch','repository','checks','configuration','failure'] as const){
    const f=fixture();let preview='';
    const target:PublicationTarget={repository:'',baseBranch:'main'};
    if(scenario==='branch')target.baseBranch='staging';
    if(scenario==='repository')target.repository='another/repo';
    if(scenario==='checks')f.project.worktree!.checks[0].args=['-e','process.exit(1)'];
    const executor=new WorkspaceExecutor(f.config,f.store,{run:async(_t,p,h)=>{
      writeFileSync(join(p.path,'README.md'),'changed\n');h.proposePublication!(target);
      if(scenario==='configuration')f.project.worktree!.github!.baseBranch='staging';
      if(scenario==='failure')throw Error('execution failed after proposal');
      return '准备交付';
    }});
    const engine=new Engine(f.store,f.config,executor,{send:async(_c,_t,_d,v)=>{
      if(v?.kind==='publication')preview=JSON.stringify(buildCard(f.store,f.config,'dm',v));
    }});
    try{
      engine.start();for(let n=0;n<1000&&!['review','failed'].includes(f.store.get(f.task.id)!.status);n++)await delay(5);
      await engine.flush();assert.equal(f.store.delivery(f.task.id)!.authorizedKey,undefined);
      if(scenario==='configuration'||scenario==='failure'){
        assert.equal(f.store.get(f.task.id)!.status,'failed');assert.equal(preview,'');
      }else{
        assert.equal(f.store.get(f.task.id)!.status,'review');assert.match(preview,/暂不能交付 PR/);
        assert.match(preview,scenario==='checks'?/独立检查尚未全部通过/:/请求交付到/);
        assert.ok(!preview.includes('确认创建草稿 PR'));
      }
    }finally{await engine.stop();f.close();}
  }
});
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
test('publication attributes the recorded executor, commits validated files, reuses PR, and only pushes the task branch', async () => {
  const cases: Array<Executor['commitAuthors'] | null> = [
    [{ name: 'Codex', email: 'codex@openai.com' }],
    [{ name: 'Other Agent', email: 'agent@example.invalid' }],
    null,
  ];
  for (const authors of cases) {
    const f = fixture(authors);
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
        if (args[1] === 'view') return JSON.stringify({ ...pr, isDraft:true, headRefOid: await git(cwd, ['rev-parse', 'HEAD'], sig) });
        throw Error('unexpected gh command');
      };
      await publish(f.store, f.config, f.task, f.project, signal(), gh, repoGit);
      const publishedHead = await git(report.workspace.path, ['rev-parse', 'HEAD'], signal());
      assert.equal(await git(report.workspace.path, ['log', '-1', '--format=%an <%ae>'], signal()), 'Test <test@example.invalid>');
      assert.equal(await git(report.workspace.path, ['log', '-1', '--format=%s'], signal()), `Steward task ${f.task.id}: test`);
      assert.equal(await git(report.workspace.path, ['log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)'], signal()),
        authors?.map(a => `${a.name} <${a.email}>`).join('\n') ?? '');
      await publish(f.store, f.config, f.task, f.project, signal(), gh, repoGit);
      assert.equal(await git(report.workspace.path, ['rev-parse', 'HEAD'], signal()), publishedHead);
      assert.equal(calls.filter(a => a[0] === 'commit').length, 1);
      assert.equal(creates, 1); assert.equal(edits, 1);
      assert.equal(await git(report.workspace.path, ['ls-files', '--', '.steward-delivery'], signal()), '');
      assert.equal(f.store.delivery(f.task.id)!.prUrl, 'https://github.com/test/repo/pull/1');
      assert.equal(f.g('rev-parse', 'origin/main'), report.workspace.baseSha);
      assert.ok(calls.filter(a => a[0] === 'push').every(a => a.join(' ') === `push origin HEAD:refs/heads/${report.workspace.branch}`));
      assert.equal((await inventory(report.workspace, signal())).fingerprint, report.fingerprint);
      writeFileSync(join(report.workspace.path, 'README.md'), 'changed after validation');
      await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), gh, repoGit), /验证后文件发生变化/);
    } finally { f.close(); }
  }
});
test('continuation preserves recorded contributors, deduplicates identities, and binds publication confirmation to them', async () => {
  const f = fixture();
  try {
    await f.executor.run(f.task, f.project, hooks, signal());
    await f.executor.run(f.task, f.project, hooks, signal());
    const next = new WorkspaceExecutor(f.config, f.store, {
      commitAuthors: [{ name: 'Other Agent', email: 'agent@example.invalid' }], run: async () => 'reviewed',
    });
    await next.run(f.task, f.project, hooks, signal());
    const report = f.store.delivery(f.task.id)!;
    assert.deepEqual(report.commitAuthors, [
      { name: 'Codex', email: 'codex@openai.com' }, { name: 'Other Agent', email: 'agent@example.invalid' },
    ]);
    const authorizedKey = publicationKey(f.task, f.project, report);
    f.store.saveDelivery(f.task.id, { ...report, authorizedKey, commitAuthors: [] });
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), async () => { throw Error('unexpected GitHub call'); }), /重新预览/);
    assert.equal(await git(report.workspace.path, ['rev-parse', 'HEAD'], signal()), report.headSha);
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
    const readyPr=async (_cwd:string,args:string[])=>JSON.stringify(args[1]==='list'?[{number:1,state:'OPEN',baseRefName:'main',headRefName:report.workspace.branch}]:{isDraft:false});
    await assert.rejects(publish(f.store, f.config, f.task, f.project, signal(), readyPr, transport), /目标分支已更新/);
    assert.equal(pushes, 0);
  } finally { f.close(); }
});
test('write form respects project grants; owner and delegate publication confirmations are actor-bound and single-use', async () => {
  for (const actorId of ['owner','ou_guest']) {
  const f = fixture(); let runs = 0;
  const requesterId = actorId === 'owner' ? undefined : actorId;
  f.config.trustedRequesters=[{openId:'ou_guest',name:'Guest'},{openId:'ou_other',name:'Other'}];
  if(requesterId){f.task.requesterId=requesterId;f.store.db.prepare('UPDATE tasks SET requesterId=? WHERE id=?').run(requesterId,f.task.id);}
  const engine = new Engine(f.store, f.config, { run: async t => { runs++; assert.equal(t.nextAction, 'publish'); return 'published'; } }, { send: async () => {} });
  try {
    await f.executor.run(f.task, f.project, hooks, signal()); f.store.set(f.task.id, 'review', 'done');
    const t = f.store.get(f.task.id)!;
    const card = JSON.stringify(buildCard(f.store, f.config, 'dm', { kind: 'publication', taskId: t.id }));
    assert.match(card, /test\/repo/); assert.match(card, /content check: passed/);
    const action = { id: 'click', senderId: actorId, chatId: 'dm', messageId: 'message', fields: {},
      actionId: f.store.action('dm', { op: 'publish', requesterId, taskId: t.id, revision: t.updatedAt, publicationKey: publicationKey(t, f.project, f.store.delivery(t.id)!) }) };
    assert.equal(engine.handleAction({ ...action, senderId: 'stranger' }).toast.type, 'error');
    assert.equal(engine.handleAction({ ...action, senderId: 'ou_other' }).toast.type, 'error');
    assert.equal(engine.handleAction(action).toast.type, 'success');
    assert.equal(engine.handleAction({ ...action, id: 'again' }).toast.type, 'error');
    await new Promise(r => setTimeout(r, 20)); assert.equal(runs, 1);
    f.project.sandbox = 'read-only';
    const form = { ...action, id: 'form', actionId: f.store.action('dm', { op: 'new', requesterId }), fields: { body: 'work', project: 'test', mode: 'workspace-write' } };
    assert.equal(engine.handleAction(form).toast.type, 'error');
    assert.equal(f.store.list().length, 1);
  } finally { await engine.stop(); f.close(); }
  }
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
  const { alertSourceKey } = await import('../src/alert-config.js');
  const { sentryMcpForTask } = await import('../src/sentry-mcp.js');
  const { assertAlertAuthorized } = await import('../src/alerts.js');
  const f = fixture();
  try {
    f.config.alertSources={monitor:{kind:'sentry',enabled:true,project:'test',chatId:'dm',mode:'workspace-write',pollSeconds:60,maxTasksPerDay:5,
      sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_TEST_TOKEN',mcpProject:'frontend'}}};
    f.store.db.prepare('INSERT INTO alert_tasks VALUES (?,?,?,?,?)').run('monitor',alertSourceKey(f.config,'monitor')!,'123',f.task.id,new Date().toISOString());
    const old = await prepareWorkspace(f.store,f.config.stateDir,f.task,f.project,signal());
    f.store.thread(f.task.id,'old-session'); writeFileSync(join(old.path,'README.md'),'unfinished work');
    writeFileSync(join(f.source,'feature.txt'),'new implementation'); f.g('add','feature.txt'); f.g('commit','-m','new base');
    const sha=f.g('rev-parse','HEAD'); f.store.set(f.task.id,'review');
    const preview=await baselinePreview(f.store,f.task,f.project,'main',signal());
    assert.equal(preview.sha,sha); assert.equal(preview.before.files.length,1);
    const next=await restartAtBaseline(f.store,f.config,f.store.get(f.task.id)!,preview,signal());
    assert.deepEqual(sentryMcpForTask(f.store,f.config,next),sentryMcpForTask(f.store,f.config,f.task));
    assert.equal(sentryMcpForTask(f.store,f.config,next)?.project,'frontend');
    assertAlertAuthorized(f.store,f.config,next);
    f.config.alertSources.monitor.enabled=false;
    assert.throws(()=>assertAlertAuthorized(f.store,f.config,next),/授权已变化/);
    assert.equal(sentryMcpForTask(f.store,f.config,next),undefined);
    f.config.alertSources.monitor.enabled=true;
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

for (const accept of [false,true]) test(`target movement on a ready PR preserves checked work and prepares migration; accept=${accept}`,async()=>{
 const f=fixture(),messages:string[]=[];let gitWrites=0,ghCalls=0;
 const transport:typeof git=async(cwd,args,sig)=>{
  if(args[0]==='remote')return 'https://github.com/test/repo.git';
  if(['add','commit','push'].includes(args[0]))gitWrites++;
  return git(cwd,args,sig);
 };
 const engine=new Engine(f.store,f.config,{run:async t=>t.nextAction==='publish' ? publish(f.store,f.config,t,f.project,signal(),async(_cwd,args)=>{ghCalls++;return JSON.stringify(args[1]==='list'?[{number:1,state:'OPEN',baseRefName:'main',headRefName:f.store.delivery(t.id)!.workspace.branch}]:{isDraft:false});},transport) : 'adaptation scheduled'},
  {send:async(_,text)=>{messages.push(text)}});
 const wait=async(check:()=>boolean)=>{for(let i=0;i<300&&!check();i++)await delay(10);assert.ok(check())};
 try{
  await f.executor.run(f.task,f.project,hooks,signal());f.store.set(f.task.id,'review','UI implemented and checked');
  const report=f.store.delivery(f.task.id)!;
  f.store.saveDelivery(f.task.id,{...report,authorizedKey:publicationKey(f.task,f.project,report)});
  f.g('commit','--allow-empty','-m','upstream advanced');f.g('push','origin','main');
  f.store.queuePublication(f.task.id);engine.start();
  await wait(()=>f.store.get(f.task.id)?.status==='waiting_approval');
  assert.equal(f.store.get(f.task.id)!.result,'UI implemented and checked');
  assert.deepEqual(f.store.get(f.task.id)!.baselineOptions,{migrateChanges:true,delivery:null});
  assert.equal(f.store.delivery(f.task.id)!.ready,true);assert.equal(f.store.delivery(f.task.id)!.authorizedKey,undefined);
  assert.equal(canPublish(f.store.get(f.task.id)!,f.project,f.store.delivery(f.task.id)),false);
  assert.equal(f.store.list().length,1);assert.equal(gitWrites,0);assert.equal(ghCalls,2);
  assert.match(f.store.getRequest(f.store.requests(f.task.id)[0].id)!.description,/只读快照/);
  assert.equal(readFileSync(join(report.workspace.path,'README.md'),'utf8'),'changed\n');
  engine.receive({id:'decision',senderId:'owner',senderType:'user',chatId:'dm',chatType:'p2p',text:(accept?'/approve ':'/deny ')+f.store.requests(f.task.id)[0].id});
  await wait(()=>f.store.get(f.task.id)?.status==='review');assert.equal(f.store.list().length,accept?2:1);
  if(accept){
    const next=f.store.list().find(t=>t.id!==f.task.id)!;
    assert.match(next.prompt,/主人同时确认迁移旧改动/);assert.match(next.prompt,/migration-/);
    assert.equal(f.store.workspace(next.id)!.baseSha,f.g('rev-parse','main'));
    assert.equal(readFileSync(join(report.workspace.path,'README.md'),'utf8'),'changed\n');
  }
  assert.equal(f.store.get(f.task.id)!.result,'UI implemented and checked');
  assert.ok(messages.some(m=>m.includes('PR 发布暂缓')));assert.ok(!messages.some(m=>m.includes('这次没能完成')));
 }finally{await engine.stop();f.close()}
});


test('advanced targets allow source-validated drafts without migrating or rerunning checks',async()=>{
 for(const scenario of ['create','update','exception','unrelated','ancestry-error'] as const){
  const f=fixture();let writes=0,creates=0,edits=0;
  try{
   if(scenario==='exception')f.project.worktree!.checks=[{name:'baseline failure',command:process.execPath,args:['-e',"console.error('old');process.exit(1)"],failureFormat:'exact'}];
   await f.executor.run(f.task,f.project,hooks,signal());
   const report=f.store.delivery(f.task.id)!,originalChecks=structuredClone(report.checks);
   const key=publicationKey(f.task,f.project,report);
   f.store.saveDelivery(f.task.id,{...report,...(scenario==='exception'?{exceptionAuthorizedKey:key}:{authorizedKey:key})});
   f.g('commit','--allow-empty','-m','upstream advanced');f.g('push','origin','main');
   const target=scenario==='unrelated'?f.g('commit-tree','HEAD^{tree}','-m','unrelated root'):f.g('rev-parse','main');
   const pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',baseRefName:'main',headRefName:report.workspace.branch,isDraft:true};
   const gh=async(cwd:string,args:string[],sig:AbortSignal)=>{
    if(args[1]==='list')return JSON.stringify(scenario==='update'||creates?[pr]:[]);
    if(args[1]==='view')return JSON.stringify({...pr,headRefOid:await git(cwd,['rev-parse','HEAD'],sig)});
    if(args[1]==='create'||args[1]==='edit'){
     if(args[1]==='create'){creates++;assert.ok(args.includes('--draft'));}else edits++;
     const body=readFileSync(args[args.indexOf('--body-file')+1],'utf8');
     assert.ok(body.includes(`Base: ${report.workspace.baseSha}`));assert.ok(body.includes(`Last observed target: ${target}`));
     assert.match(body,/不代表与最新目标分支合并后的结果/);return '';
    }
    throw Error('unexpected GitHub operation');
   };
   const transport:typeof git=async(cwd,args,sig)=>{
    if(args[0]==='remote')return 'https://github.com/test/repo.git';
    if(args[0]==='rev-parse'&&args[1]==='origin/main')return target;
    if(args[0]==='merge-base'&&scenario==='ancestry-error')throw Error('cannot inspect history');
    if(['add','commit','push'].includes(args[0]))writes++;
    return git(cwd,args,sig);
   };
   if(scenario==='unrelated'||scenario==='ancestry-error'){
    await assert.rejects(publish(f.store,f.config,f.task,f.project,signal(),gh,transport),/目标分支已更新/);
    assert.equal(writes,0);assert.equal(f.store.delivery(f.task.id)!.targetBlocked,true);
    assert.equal(canPublish(f.task,f.project,f.store.delivery(f.task.id)),false);
   }else{
    await publish(f.store,f.config,f.task,f.project,signal(),gh,transport);
    const after=f.store.delivery(f.task.id)!;
    assert.equal(creates,scenario==='update'?0:1);assert.equal(edits,scenario==='update'?1:0);
    assert.equal(after.workspace.baseSha,report.workspace.baseSha);assert.equal(after.targetBefore,target);
    assert.deepEqual(after.checks,originalChecks);assert.equal(after.ready,scenario!=='exception');
    assert.equal(after.exceptionAuthorizedKey,undefined);assert.equal(after.prUrl,pr.url);
    assert.equal(f.g('rev-parse','main'),target,'publication cannot change main');
    assert.equal(f.store.list().length,1,'no migration task');
   }
  }finally{f.close();}
 }
});

test('semantic merge preview avoids local checks and rejects unsubmitted edits',async()=>{
 for(const scenario of ['clean','dirty','edited'] as const){
  const f=fixture();let proposed=0;
  try{
   const ex=new WorkspaceExecutor(f.config,f.store,{run:async(_t,p,h)=>{
    if(scenario==='edited')writeFileSync(join(p.path,'README.md'),'new edits');
    h.proposeMerge!({url:''});return 'preview';
   }});
   if(scenario==='dirty')await f.executor.run(f.task,f.project,hooks,AbortSignal.timeout(5000));
   const run=ex.run(f.task,f.project,{...hooks,proposeMerge:()=>{proposed++}},AbortSignal.timeout(5000));
   if(scenario==='clean'){assert.equal(await run,'preview');assert.deepEqual(f.store.delivery(f.task.id)!.checks,[])}
   else{await assert.rejects(run,/未交付改动/);assert.equal(f.store.delivery(f.task.id)!.ready,false)}
   assert.equal(proposed,1);
  }finally{f.close()}
 }
});

test('default LangGraph defers checks until clarification finishes and preserves the worktree for publication',async()=>{
  const f=fixture();f.store.set(f.task.id,'completed');
  const checkLog=join(f.root,'checks-ran');
  f.project.worktree!.checks[0].args.push(checkLog);
  f.project.worktree!.checks[0].args[1]+=";require('fs').appendFileSync(process.argv[1],'check\\n')";
  let runs=0,worktree='';const views:View[]=[];
  const executor=new WorkspaceExecutor(f.config,f.store,{run:async(t,p,h)=>{
    runs++;
    if(runs===1){worktree=p.path;h.thread('pilot-session');writeFileSync(join(p.path,'README.md'),'changed\n');h.askClarification!('Should I include the explanation?');return 'Question';}
    assert.equal(p.path,worktree);assert.equal(t.threadId,'pilot-session');assert.match(t.prompt,/include it/);
    assert.equal(readFileSync(join(p.path,'README.md'),'utf8'),'changed\n');
    h.proposePublication!({repository:'',baseBranch:'main'});return 'Ready for PR preview';
  }});
  const engine=new Engine(f.store,f.config,executor,{send:async(_c,_t,_id,view)=>{if(view)views.push(view);}});
  const send=(id:string,text:string)=>engine.receive({id,text,chatId:'dm',chatType:'p2p',senderId:'owner',senderType:'user'});
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<1000;i++){if(fn())return;await delay(5);}assert.fail('pilot condition not reached');};
  try{
    send('pilot-task','/edit test Update README then ask for explanation scope');
    const task=f.store.list().find(t=>t.id!==f.task.id)!;
    await wait(()=>f.store.get(task.id)?.status==='waiting_input');
    assert.equal(task.orchestration,'langgraph-v1');
    assert.equal(existsSync(checkLog),false);
    assert.deepEqual(f.store.delivery(task.id)?.checks,[]);
    assert.equal(f.store.delivery(task.id)?.ready,false);
    const question=f.store.requests(task.id)[0].id;send('pilot-answer',`/answer ${question} include it`);
    await wait(()=>f.store.get(task.id)?.status==='review');await engine.flush();
    assert.equal(runs,2);assert.equal(f.store.delivery(task.id)?.ready,true);
    assert.equal(readFileSync(checkLog,'utf8'),'check\n');
    assert.equal(f.store.delivery(task.id)?.checks[0].status,'passed');
    assert.equal(f.store.delivery(task.id)?.authorizedKey,undefined);
    assert.equal(f.store.delivery(task.id)?.prUrl,undefined);
    assert.equal(views.filter(v=>v.kind==='publication').length,1);
    assert.equal(readFileSync(join(f.source,'README.md'),'utf8'),'base\n');
  }finally{await engine.stop();f.close();}
});

test('independent stable baseline failures enable only a scoped draft exception; changed failures remain blocked',async()=>{
 for(const scenario of ['stable','regression','flaky','mutating'] as const){
  const f=fixture();
  try{
   f.project.worktree!.checks=[{name:'existing failure',command:process.execPath,failureFormat:'exact',args:['-e',
    scenario==='regression'?"console.error(require('fs').readFileSync('README.md','utf8'));process.exit(1)":
    scenario==='flaky'?"console.error(Math.random());process.exit(1)":
    scenario==='mutating'?"require('fs').writeFileSync('README.md','mutated');console.error('same');process.exit(1)":
    "console.error('same diagnostic');process.exit(1)"],timeoutSeconds:10},
    {name:'later check',command:process.execPath,args:['-e','process.exit(0)']}];
   await f.executor.run(f.task,f.project,hooks,signal());
   const report=f.store.delivery(f.task.id)!;
   assert.equal(report.ready,false);assert.equal(canPublish(f.task,f.project,report),false);
   assert.equal(report.checks.length,2,'later checks must not be skipped');
   assert.equal(canRequestDraftException(f.task,f.project,report),scenario==='stable');
   assert.equal(report.exceptionAuthorizedKey,undefined);
   if(scenario==='stable'){
    f.store.set(f.task.id,'review');
    const card=JSON.stringify(buildCard(f.store,f.config,'dm',{kind:'publication',taskId:f.task.id}));
    assert.match(card,/仅本次发布草稿/);assert.match(card,/全仓检查仍未通过/);
    assert.equal(canRequestDraftException({...f.task,requesterId:'delegate'},f.project,report),false);
    assert.equal(canRequestDraftException(f.task,f.project,{...report,fingerprint:'changed'}),false);
    assert.equal(canRequestDraftException(f.task,f.project,{...report,targetBefore:'new-target',targetBlocked:true}),false);
    const changedProject=structuredClone(f.project);changedProject.worktree!.checks[0].args.push('changed');
    assert.equal(canRequestDraftException(f.task,changedProject,report),false);
    f.store.resume(f.task.id,'more');assert.equal(f.store.delivery(f.task.id)?.baselineComparison,undefined);
   }
   assert.equal(f.g('worktree','list','--porcelain').includes('baseline-'),false,'temporary baseline cleaned');
  }finally{f.close();}
 }
});

test('automatic baseline probes retain all attempts and allow only reproduced draft failures',async()=>{
 for(const scenario of ['reproduced','unmatched','malformed','mutating'] as const){
  const f=fixture();
  try{
   writeFileSync(join(f.source,'a.test.ts'),'// baseline test fixture\n');
   f.g('add','a.test.ts');f.g('commit','-m','test fixture');f.g('push');
   const script=`
    const fs=require('node:fs'),path=require('node:path');
    const report=process.argv[1],file=process.argv[2],probe=!!file;
    const patched=fs.readFileSync('README.md','utf8')==='changed\\n';
    if(probe && ${JSON.stringify(scenario)}==='malformed'){fs.writeFileSync(report,'{}');process.exit(1);}
    if(probe && ${JSON.stringify(scenario)}==='mutating')fs.writeFileSync('README.md','mutated');
    const fail=patched || (probe && ${JSON.stringify(scenario)}!=='unmatched' && path.basename(path.dirname(report))==='3');
    fs.writeFileSync(report,JSON.stringify({numFailedTests:fail?1:0,numFailedTestSuites:fail?1:0,numTotalTests:2,unhandledErrors:[],testResults:[{
      name:path.join(process.cwd(),'a.test.ts'),status:fail?'failed':'passed',message:'',
      stewardSourceHash:require('node:crypto').createHash('sha256').update(fs.readFileSync('a.test.ts')).digest('hex'),assertionResults:[{fullName:'time '+Date.now()+Math.random(),status:'passed',failureMessages:[]},{
        fullName:'menu opens',status:fail?'failed':'passed',failureMessages:fail?['expected rename item']:[]
      }]
    }]}));process.exit(fail?1:0);
   `;
   f.project.worktree!.checks=[{name:'test fixture',command:process.execPath,args:['-e',script,'{report}'],failureFormat:'vitest',timeoutSeconds:10}];
   await f.executor.run(f.task,f.project,hooks,signal());f.store.set(f.task.id,'review');
   const report=f.store.delivery(f.task.id)!,comparison=report.baselineComparison!;
   assert.equal(report.ready,false);assert.equal(canPublish(f.task,f.project,report),false);
   assert.equal(comparison.eligible,scenario==='reproduced',comparison.reason);
   assert.equal(canRequestDraftException(f.task,f.project,report),scenario==='reproduced');
   assert.equal(comparison.equivalent,false);assert.equal(report.exceptionAuthorizedKey,undefined);
   assert.equal(report.prUrl,undefined);
   if(scenario==='reproduced'){
    assert.deepEqual(comparison.probes.map(p=>p.exitCode),[0,0,1]);
    assert.deepEqual(comparison.checks[0].roundFailureCounts,[2,0,2,0]);
    assert.match(comparison.reason,/不能证明失败频率未增加/);
    const card=JSON.stringify(buildCard(f.store,f.config,'dm',{kind:'publication',taskId:f.task.id}));
    assert.match(card,/不能证明失败频率未增加/);assert.match(card,/Baseline probe/);
    const legacy=structuredClone(report);delete (legacy.baselineComparison as any).eligible;
    assert.equal(canRequestDraftException(f.task,f.project,legacy),false,'legacy comparison requires fresh validation');
   }else if(scenario==='unmatched'){
    assert.equal(comparison.probes.length,3);assert.match(comparison.reason,/未在未修改基线中复现/);
   }else assert.match(comparison.reason,scenario==='malformed'?/不完整/:/改变了源码/);
   assert.equal(f.g('worktree','list','--porcelain').includes('baseline-'),false);
  }finally{f.close();}
 }
});

test('unattributed rejections use at most two complete baseline probes and still require exact evidence',async()=>{
 for(const scenario of ['matched','unmatched','malformed','mutating'] as const){
  const f=fixture();
  try{
   const script=`
    const fs=require('node:fs'),path=require('node:path'),out=process.argv[1];
    const full=out.includes(path.join('probes','0','full'));
    if(full && ${JSON.stringify(scenario)}==='malformed'){fs.writeFileSync(out,'{}');process.exit(1);}
    if(full && ${JSON.stringify(scenario)}==='mutating')fs.writeFileSync('README.md','mutated');
    const failed=fs.readFileSync('README.md','utf8')==='changed\\n' || (full && ${JSON.stringify(scenario)}==='matched' && path.basename(path.dirname(out))==='2');
    fs.writeFileSync(out,JSON.stringify({numTotalTests:1,numFailedTests:0,numFailedTestSuites:0,
      unhandledErrors:failed?[{message:'timer rejection',stack:'source.js:1'}]:[],
      testResults:[{name:path.join(process.cwd(),'a.test.ts'),status:'passed',assertionResults:[{fullName:'case',status:'passed',failureMessages:[]}]}]}));
    process.exit(failed?1:0);
   `;
   f.project.worktree!.checks=[{name:'test fixture',command:process.execPath,args:['-e',script,'{report}'],failureFormat:'vitest',timeoutSeconds:10}];
   await f.executor.run(f.task,f.project,hooks,signal());
   const report=f.store.delivery(f.task.id)!,comparison=report.baselineComparison!;
   assert.equal(report.ready,false);assert.equal(report.exceptionAuthorizedKey,undefined);
   assert.equal(comparison.eligible,scenario==='matched',comparison.reason);
   if(scenario==='matched'||scenario==='unmatched'){
    assert.equal(comparison.probes.length,2);
    assert.ok(comparison.probes.every(p=>p.file==='(full Vitest check)'));
    assert.deepEqual(comparison.probes.map(p=>p.exitCode),scenario==='matched'?[0,1]:[0,0]);
   }else assert.match(comparison.reason,scenario==='malformed'?/不完整/:/改变了源码/);
  }finally{f.close();}
 }
});

test('group draft exception requires owner, topic, fresh revision and exact comparison; replay cannot publish twice',async()=>{
 const f=fixture();let published=0;
 f.config.groupChats=true;
 f.project.worktree!.checks[0]={name:'baseline failure',command:process.execPath,args:['-e',"console.error('old');process.exit(1)"],failureFormat:'exact'};
 const conversation={anchorId:'root',sourceId:'root',threadId:'thread',scope:'thread' as const};
 f.store.saveConversation(f.task.id,conversation);
 const engine=new Engine(f.store,f.config,{run:async()=>{published++;return 'published (simulated)';}},{send:async()=>{}});
 try{
  await f.executor.run(f.task,f.project,hooks,signal());f.store.set(f.task.id,'review');
  const task=f.store.get(f.task.id)!,report=f.store.delivery(task.id)!;
  const issue=(key=publicationKey(task,f.project,report),revision=task.updatedAt)=>f.store.action('dm',{
   op:'publish-exception',taskId:task.id,revision,publicationKey:key,conversation});
  const callback=(actionId:string)=>({id:'click-'+actionId,senderId:'owner',chatId:'dm',actionId,messageId:'card',fields:{}});
  const action=callback(issue());
  assert.equal(engine.handleAction({...action,senderId:'other'}).toast.type,'error');
  assert.equal(engine.handleAction({...action,chatId:'other-chat'}).toast.type,'error');
  assert.equal(engine.handleAction(callback(issue('wrong-key'))).toast.type,'error');
  assert.equal(engine.handleAction(callback(issue(undefined,'old-revision'))).toast.type,'error');
  assert.equal(engine.handleAction(action).toast.type,'success');
  assert.equal(engine.handleAction({...action,id:'replay'}).toast.type,'error');
  for(let n=0;n<100&&published===0;n++)await delay(5);
  assert.equal(published,1);assert.equal(f.store.delivery(task.id)?.ready,false);
  const event=f.store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='draft_exception_authorized'").get(task.id) as {body:string};
  assert.equal(JSON.parse(event.body).actorId,'owner');
 }finally{await engine.stop();f.close();}
});

test('draft exception publisher consumes approval, verifies draft state and does not authorize retries or merge',async()=>{
 for(const existingReady of [false,true]){
  const f=fixture();
  try{
   f.project.worktree!.checks[0]={name:'baseline failure',command:process.execPath,args:['-e',"console.error('old');process.exit(1)"],failureFormat:'exact'};
   await f.executor.run(f.task,f.project,hooks,signal());const report=f.store.delivery(f.task.id)!;
   f.store.saveDelivery(f.task.id,{...report,exceptionAuthorizedKey:publicationKey(f.task,f.project,report)});
   let creates=0,pushes=0;
   const pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',baseRefName:'main',headRefName:report.workspace.branch,isDraft:!existingReady};
   const gh=async(cwd:string,args:string[],sig:AbortSignal)=>{
    if(args[1]==='list')return JSON.stringify(existingReady||creates?[pr]:[]);
    if(args[1]==='create'){creates++;assert.ok(args.includes('--draft'));assert.match(readFileSync(args[args.indexOf('--body-file')+1],'utf8'),/Draft-only baseline exception/);return '';}
    if(args[1]==='view')return JSON.stringify({...pr,headRefOid:await git(cwd,['rev-parse','HEAD'],sig)});
    throw Error('unexpected GitHub operation');
   };
   const repoGit:typeof git=async(cwd,args,sig)=>{if(args[0]==='remote')return 'https://github.com/test/repo.git';if(args[0]==='push')pushes++;return git(cwd,args,sig);};
   if(existingReady){await assert.rejects(publish(f.store,f.config,f.task,f.project,signal(),gh,repoGit),/只适用于草稿/);assert.equal(pushes,0);}
   else{await publish(f.store,f.config,f.task,f.project,signal(),gh,repoGit);assert.equal(pushes,1);assert.equal(creates,1);assert.equal(f.store.delivery(f.task.id)?.ready,false);}
   assert.equal(f.store.delivery(f.task.id)?.exceptionAuthorizedKey,undefined);
   f.store.recover();
   await assert.rejects(publish(f.store,f.config,f.task,f.project,signal(),gh,repoGit),/配置验证全部通过/);
  }finally{f.close();}
 }
});

for(const kind of ['ready','browser','advanced'] as const)test(`publisher creates ${kind==='ready'?'ordinary':'draft'} PR for ${kind} verification`,async()=>{
 const f=fixture();let creates=0;
 try{
  await f.executor.run(f.task,f.project,hooks,signal());
  const report={...f.store.delivery(f.task.id)!,summary:{title:'修复文档内容',problem:'文档内容错误。',change:'改为正确内容。',validation:'内容检查通过。',remaining:kind==='browser'?['浏览器验收尚未完成']:[]}};
  f.store.saveDelivery(f.task.id,{...report,authorizedKey:publicationKey(f.task,f.project,report)});
  if(kind==='advanced'){f.g('commit','--allow-empty','-m','upstream');f.g('push','origin','main');}
  const transport:typeof git=async(cwd,args,sig)=>args[0]==='remote'?'https://github.com/test/repo.git':git(cwd,args,sig);
  const gh=async(cwd:string,args:string[],sig:AbortSignal)=>{
   if(args[1]==='create'){creates++;assert.equal(args.includes('--draft'),kind!=='ready');assert.equal(args[args.indexOf('--title')+1],'修复文档内容');return '';}
   const pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',baseRefName:'main',headRefName:report.workspace.branch,isDraft:kind!=='ready'};
   if(args[1]==='list')return JSON.stringify(creates?[pr]:[]);
   return JSON.stringify({...pr,headRefOid:await git(cwd,['rev-parse','HEAD'],sig)});
  };
  const result=await publish(f.store,f.config,f.task,f.project,signal(),gh,transport);
  assert.equal(f.store.delivery(f.task.id)!.prIsDraft,kind!=='ready');assert.equal(creates,1);assert.match(result,/查看.*PR/);
  if(kind==='advanced')assert.match(result,/目标分支/);
 }finally{f.close();}
});
