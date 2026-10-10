import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { CodexExecutor } from '../src/adapters/codex.js';
import { Store } from '../src/store.js';
import { git, WorkspaceExecutor } from '../src/workspace.js';
import type { Config } from '../src/types.js';
const root = mkdtempSync(join(tmpdir(), 'steward-workspace-smoke-'));
const source = join(root, 'repo'), stateDir = join(root, 'state'); mkdirSync(source); mkdirSync(stateDir);
const store = new Store(join(stateDir, 'db.sqlite'));
const signal = AbortSignal.timeout(180_000);
console.log('Live smoke: ChatGPT subscription, one isolated temporary Git task, no remote or PR.');
try {
  await git(source, ['init', '-b', 'main'], signal);
  writeFileSync(join(source, 'result.txt'), 'before\n');
  await git(source, ['add', '--', 'result.txt'], signal);
  await git(source, ['-c', 'user.name=Steward Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'fixture'], signal);
  const config: Config = { ownerId: 'local', codexCommand: 'codex', stateDir, maxRunMinutes: 3, projects: {
    smoke: { path: source, sandbox: 'workspace-write', worktree: { baseRef: 'main', checks: [{ name: 'exact file content',
      command: process.execPath, args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'WORKTREE_OK\\n')"] }] } },
  } };
  const task = store.create('local', 'smoke', 'Change result.txt to contain exactly WORKTREE_OK followed by one newline. Do not change other files. Do not commit, use network, or inspect outside this directory. Reply briefly when done.', 'workspace-write');
  await new WorkspaceExecutor(config, store, new CodexExecutor()).run(task, config.projects.smoke, {
    thread: id => store.thread(task.id, id), progress: () => {}, resolved: () => {},
    request: r => { r.resolve(r.kind === 'approval' ? 'decline' : 'Do only the stated local file edit.'); return 'smoke'; },
  }, signal);
  const report = store.delivery(task.id)!;
  assert.equal(report.ready, true); assert.deepEqual(report.files, ['result.txt']);
  assert.equal(readFileSync(join(source, 'result.txt'), 'utf8'), 'before\n');
  console.log('PASS: subscription → isolated worktree edit → independent file check → delivery inventory; source unchanged.');
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
