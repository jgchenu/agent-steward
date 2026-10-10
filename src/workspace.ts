import { collectEvidence, prepareEvidenceDirectory, isEvidencePath, EVIDENCE_DIRECTORY } from './evidence.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from './store.js';
import { runCommand } from './process.js';
import type { Config, DeliveryReport, Executor, Project, PublicationTarget, RunHooks, Task, Workspace } from './types.js';

export async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  const result = await runCommand('git', ['--literal-pathspecs', ...args], cwd, signal);
  if (result.code !== 0 || result.truncated) throw new Error(`Git 操作未完成：${args[0]}（${result.code}）`);
  return result.stdout.trimEnd();
}
const lines0 = (text: string) => text.split('\0').filter(Boolean);
export async function verifyWorkspace(w: Workspace, signal: AbortSignal): Promise<void> {
  if (!existsSync(w.path) || realpathSync(w.path) !== w.path) throw new Error('任务工作目录不存在或已被替换；不会自动重建丢失的任务。');
  const common = await git(w.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal);
  const sourceCommon = await git(w.source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal);
  if (realpathSync(common) !== realpathSync(sourceCommon)
    || await git(w.path, ['symbolic-ref', '--short', 'HEAD'], signal) !== w.branch) throw new Error('工作目录的仓库或分支不匹配。');
  await git(w.path, ['merge-base', '--is-ancestor', w.baseSha, 'HEAD'], signal);
}
export async function prepareWorkspace(store: Store, stateDir: string, task: Task, project: Project,
  signal: AbortSignal): Promise<Workspace> {
  if (!project.worktree || !/^[a-f0-9]{8}$/.test(task.id)) throw new Error('未配置有效的 Git 工作目录。');
  const source = realpathSync(project.path);
  if (realpathSync(await git(source, ['rev-parse', '--show-toplevel'], signal)) !== source) throw new Error('项目目录必须是 Git 仓库根目录。');
  let workspace = store.workspace(task.id);
  const root = resolve(stateDir, 'worktrees'); mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(root), task.id), branch = `steward/${task.id}`;
  if (workspace) {
    if (workspace.source !== source || workspace.path !== path || workspace.branch !== branch
      || (workspace.configBaseRef ?? workspace.baseRef) !== project.worktree.baseRef) throw new Error('任务项目配置已变化；请恢复原配置或创建新任务。');
    if (existsSync(path)) { await verifyWorkspace(workspace, signal); return workspace; }
    if (task.threadId) throw new Error('已有会话的工作目录丢失，不会重建空目录后继续。');
  } else {
    if (project.worktree.baseRef.startsWith('origin/')) {
      const ref = project.worktree.baseRef.slice(7);
      await git(source, ['fetch', 'origin', `refs/heads/${ref}:refs/remotes/origin/${ref}`], signal);
    }
    const baseSha = await git(source, ['rev-parse', '--verify', `${project.worktree.baseRef}^{commit}`], signal);
    workspace = { taskId: task.id, source, path, branch, baseSha, baseRef: project.worktree.baseRef };
    // Persist intent before Git mutation, allowing recovery from a crash during creation.
    store.saveWorkspace(workspace);
  }
  const branchExists = await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], source, signal);
  if (branchExists.code === 0) await git(source, ['worktree', 'add', path, branch], signal);
  else if (branchExists.code === 1) await git(source, ['worktree', 'add', '-b', branch, path, workspace.baseSha], signal);
  else throw new Error('无法检查任务分支。');
  await verifyWorkspace(workspace, signal);
  return workspace;
}

export async function inventory(w: Workspace, signal: AbortSignal): Promise<Pick<DeliveryReport, 'files' | 'diffStat' | 'fingerprint' | 'headSha'>> {
  await verifyWorkspace(w, signal);
  const tracked = lines0(await git(w.path, ['diff', '--no-renames', '--name-only', '-z', w.baseSha, '--'], signal));
  const untracked = lines0(await git(w.path, ['ls-files', '--others', '--exclude-standard', '-z'], signal));
  const files = [...new Set([...tracked, ...untracked])].filter(f => !isEvidencePath(f)).sort();
  if (files.length > 500) throw new Error('改动超过 500 个文件，请拆分任务。');
  const hash = createHash('sha256').update(w.baseSha);
  let bytes = 0;
  for (const file of files) {
    if (isAbsolute(file) || relative(w.path, resolve(w.path, file)).startsWith('..') || /[\r\n\0]/.test(file)) throw new Error('不支持的改动文件路径。');
    const path = join(w.path, file);
    hash.update('\0' + file + '\0');
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && !stat.isFile()) throw new Error('不支持目录或子模块交付。');
      if (bytes + stat.size > 50 * 1024 * 1024) throw new Error('改动内容超过 50 MiB，请拆分任务。');
      const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
      bytes += content.length; if (bytes > 50 * 1024 * 1024) throw new Error('改动内容超过 50 MiB，请拆分任务。');
      hash.update(String(stat.mode & 0o177777)).update('\0').update(content);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted'); else throw e; }
  }
  const diffStat = await git(w.path, ['diff', '--stat', w.baseSha, '--'], signal);
  return { files, diffStat: [diffStat, ...untracked.filter(f => !isEvidencePath(f)).map(f => `新增文件：${f}`)].filter(Boolean).join('\n'),
    fingerprint: hash.digest('hex'), headSha: await git(w.path, ['rev-parse', 'HEAD'], signal) };
}
export function publicationText(task: Task, report: DeliveryReport): { title: string; body: string } {
  return { title: `Steward: ${task.prompt.split('\n')[0].slice(0, 70)} (${task.id})`, body: [
    '## Task', task.prompt, '', '## Changes', report.diffStat || 'No diff summary.', '',
    '## Validation', ...report.checks.map(c => `- ${c.name}: ${c.status}`), '',
    `Base: ${report.workspace.baseSha}`, `Task branch: ${report.workspace.branch}`,
    'The owner requested this draft PR from Agent Steward. Code checks are recorded separately from human acceptance. No merge or deployment was performed.',
  ].join('\n') };
}
export const validationKey = (project: Project) => createHash('sha256').update(JSON.stringify(project.worktree?.checks ?? [])).digest('hex');
export function publicationBlocker(task: Task, project: Project | undefined, report: DeliveryReport | undefined, requested?: PublicationTarget): string | undefined {
  if (task.mode !== 'workspace-write' || project?.sandbox !== 'workspace-write') return '本次为只读分析，没有可发布的修改权限。';
  if (!project.worktree?.github) return '项目尚未配置 GitHub 仓库和 PR 目标分支，需要先在本机配置交付目标。';
  const target = project.worktree.github;
  if (requested && (requested.repository !== target.repository || requested.baseBranch !== target.baseBranch)) {
    return `请求交付到 ${requested.repository} → ${requested.baseBranch}，但项目当前配置为 ${target.repository} → ${target.baseBranch}。未替换目标或发起发布，请先在本机配置正确的交付目标，并按对应基准准备和验证改动。`;
  }
  if (!report) return '尚无代码改动与验证记录，请先完成执行。';
  if (report.workspace.baseRef !== `origin/${project.worktree.github.baseBranch}`) return '任务基准与 PR 目标不同，需先在正确基准的新副本准备改动；原副本保留。';
  if (!report.files.length) return '没有文件改动，无需创建 PR。';
  if (!project.worktree.checks.length) return '项目未配置 Steward 独立检查，需要先配置并运行项目验证；模型自报通过不能替代检查记录。';
  if (report.validationKey !== validationKey(project)) return '检查配置已变化，需要按当前配置重新验证。';
  if (!report.ready || !report.checks.length || !report.checks.every(c => c.status === 'passed')) return 'Steward 独立检查尚未全部通过，请先查看验证结果。';
}
export function canPublish(task: Task, project: Project | undefined, report: DeliveryReport | undefined): boolean {
  return publicationBlocker(task,project,report) === undefined;
}

export function publicationKey(task: Task, project: Project, report: DeliveryReport): string {
  return createHash('sha256').update(JSON.stringify([task.id, project.path, project.worktree?.github,
    report.workspace, report.fingerprint, report.validationKey, publicationText(task, report)])).digest('hex');
}

export type Gh = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;
export const ghCommand: Gh = async (cwd, args, signal) => {
  const r = await runCommand('gh', args, cwd, signal);
  if (r.code !== 0 || r.truncated) throw new Error('GitHub 操作未完成；请检查本机 gh 登录与仓库权限。');
  return r.stdout.trim();
};
export async function publish(store: Store, config: Config, task: Task, project: Project, signal: AbortSignal,
  gh: Gh = ghCommand, repoGit: typeof git = git): Promise<string> {
  const report = store.delivery(task.id), target = project.worktree?.github;
  if (!report || !target || !canPublish(task, project, report)) throw new Error('只有存在文件改动且配置验证全部通过的修改任务可以交付 PR。');
  if (report.authorizedKey !== publicationKey(task, project, report)) throw new Error('交付内容或目标已变化，请重新预览并确认。');
  const w = report.workspace;
  if (realpathSync(project.path) !== w.source || w.baseRef !== `origin/${target.baseBranch}`) throw new Error('交付项目配置已变化。');
  const origin = await repoGit(w.path, ['remote', 'get-url', '--push', 'origin'], signal);
  const allowed = [`https://github.com/${target.repository}`, `https://github.com/${target.repository}.git`,
    `git@github.com:${target.repository}.git`, `git@github.com:${target.repository}`];
  if (!allowed.includes(origin)) throw new Error('origin 与配置的 GitHub 仓库不一致。');
  if ((await inventory(w, signal)).fingerprint !== report.fingerprint) throw new Error('验证后文件发生变化；请继续任务并重新验证。');
  if (report.files.some(f => /(^|\/)(\.env($|\.)|\.steward\/)|\.(pem|key|p12)$/.test(f) && !f.endsWith('.env.example'))) throw new Error('改动中包含私有配置或密钥类文件，拒绝发布。');
  await repoGit(w.path, ['fetch', 'origin', `refs/heads/${target.baseBranch}:refs/remotes/origin/${target.baseBranch}`], signal);
  report.targetBefore = await repoGit(w.path, ['rev-parse', `origin/${target.baseBranch}`], signal);
  store.saveDelivery(task.id, report);
  if (report.targetBefore !== w.baseSha) throw new Error('目标分支已更新。请基于最新版本创建新任务；不会自动合并、重置或改写当前工作。');
  const list = async () => JSON.parse(await gh(w.path, ['pr', 'list', '--repo', target.repository, '--head', w.branch,
    '--state', 'all', '--json', 'number,url,state,baseRefName,headRefName'], signal)) as Array<{ number: number; url: string; state: string; baseRefName: string; headRefName: string }>;
  let prs = await list();
  if (prs.some(p => p.state !== 'OPEN' || p.baseRefName !== target.baseBranch) || prs.length > 1) throw new Error('任务分支已有关闭、合并或目标不同的 PR，请创建新任务。');
  const remote = await repoGit(w.path, ['ls-remote', '--heads', 'origin', w.branch], signal);
  if (remote) {
    await repoGit(w.path, ['fetch', 'origin', `refs/heads/${w.branch}`], signal);
    await repoGit(w.path, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], signal);
  }
  const pendingFiles = [...new Set([...lines0(await repoGit(w.path, ['diff', '--name-only', '-z', 'HEAD', '--'], signal)),
    ...lines0(await repoGit(w.path, ['ls-files', '--others', '--exclude-standard', '-z'], signal))])];
  if (pendingFiles.some(isEvidencePath)) {
    for (let i = pendingFiles.length - 1; i >= 0; i--) if (isEvidencePath(pendingFiles[i])) pendingFiles.splice(i,1);
  }
  if (pendingFiles.length) await repoGit(w.path, ['add', '--', ...pendingFiles], signal);
  const staged = await repoGit(w.path, ['diff', '--cached', '--name-only', '-z'], signal);
  if (lines0(staged).some(isEvidencePath)) throw new Error('截图产物不能提交到代码仓库。');
  if (staged) await repoGit(w.path, ['commit', '-m', `Steward task ${task.id}: ${task.project}`], signal);
  if ((await inventory(w, signal)).fingerprint !== report.fingerprint) throw new Error('提交过程改变了验证过的文件，未推送；请重新验证。');
  const head = await repoGit(w.path, ['rev-parse', 'HEAD'], signal);
  await repoGit(w.path, ['push', 'origin', `HEAD:refs/heads/${w.branch}`], signal);
  if (!(await repoGit(w.path, ['ls-remote', '--heads', 'origin', w.branch], signal)).startsWith(head + '\t')) throw new Error('远端提交与本地不一致。');
  const dir = join(config.stateDir, 'artifacts', task.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bodyFile = join(dir, 'pr-body.md'), text = publicationText(task, report);
  writeFileSync(bodyFile, text.body, { mode: 0o600 });
  if (!prs.length) {
    try { await gh(w.path, ['pr', 'create', '--repo', target.repository, '--head', w.branch, '--base', target.baseBranch,
      '--draft', '--title', text.title, '--body-file', bodyFile], signal); }
    catch (error) { prs = await list(); if (!prs.length) throw error; }
    prs = await list();
  } else await gh(w.path, ['pr', 'edit', String(prs[0].number), '--repo', target.repository, '--title', text.title, '--body-file', bodyFile], signal);
  const pr = prs[0]; if (!pr) throw new Error('未能回读 PR。');
  const verified = JSON.parse(await gh(w.path, ['pr', 'view', String(pr.number), '--repo', target.repository,
    '--json', 'url,state,headRefName,headRefOid,baseRefName'], signal));
  if (verified.state !== 'OPEN' || verified.headRefName !== w.branch || verified.baseRefName !== target.baseBranch
    || verified.headRefOid !== head || verified.url !== `https://github.com/${target.repository}/pull/${pr.number}`) throw new Error('PR 回读身份不一致，请在 GitHub 检查。');
  store.saveDelivery(task.id, { ...report, headSha: head, prUrl: verified.url, publishedSha: head, error: undefined });
  return task.result ?? '草稿 PR 已准备好，等待人工审查。';
}

export class WorkspaceExecutor implements Executor {
  constructor(private config: Config, private store: Store, private inner: Executor, private gh: Gh = ghCommand) {}
  async run(task: Task, project: Project, hooks: RunHooks, signal: AbortSignal): Promise<string> {
    if (task.nextAction === 'publish') return publish(this.store, this.config, task, project, signal, this.gh);
    const mode = task.mode ?? 'read-only';
    if (mode === 'workspace-write' && (project.sandbox !== mode || !project.worktree)) throw new Error('项目不允许修改或未配置隔离工作目录。');
    if (!project.worktree) return this.inner.run(task, { ...project, sandbox: 'read-only' }, hooks, signal);
    hooks.progress('正在准备独立工作目录。');
    const workspace = await prepareWorkspace(this.store, this.config.stateDir, task, project, signal);
    if (await git(workspace.path, ['ls-files', '--', EVIDENCE_DIRECTORY], signal)) throw Error('仓库占用了保留的截图目录，未执行任务。');
    const evidenceDirectory = mode === 'workspace-write' ? prepareEvidenceDirectory(workspace.path) : undefined;
    const previous = this.store.delivery(task.id);
    const initial = await inventory(workspace, signal);
    let report: DeliveryReport = { workspace, mode, ...initial, capturedAt: new Date().toISOString(), checks: [], ready: false, validationKey: validationKey(project),
      ...(previous?.prUrl ? { prUrl: previous.prUrl, publishedSha: previous.publishedSha } : {}) };
    this.store.saveDelivery(task.id, report);
    try {
      signal.throwIfAborted();
      hooks.prepared?.(report);
      const deliveryContext = JSON.stringify({currentBase:workspace.baseRef,configuredBase:project.worktree.baseRef,
        github:project.worktree.github ?? null,checks:project.worktree.checks,
        missing:[...(!project.worktree.github ? ['GitHub repository/baseBranch'] : []),...(!project.worktree.checks.length ? ['Steward independent checks'] : [])],
        configurationManagedBy:'Steward; propose baseline.delivery to preview a scoped configuration update'});
      let changingBaseline=false;
      const innerHooks=hooks.proposeBaseline ? {...hooks,proposeBaseline:(request:Parameters<NonNullable<RunHooks['proposeBaseline']>>[0])=>{
        hooks.proposeBaseline!(request);changingBaseline=true;
      }} : hooks;
      const result = await this.inner.run({ ...task, evidenceDirectory, deliveryContext, codeVersion: { ref: workspace.baseRef, baseSha: workspace.baseSha, headSha: initial.headSha } }, { ...project, path: workspace.path, sandbox: mode }, innerHooks, signal);
      signal.throwIfAborted();
      report = { ...report, ...await inventory(workspace, signal), capturedAt: new Date().toISOString() };
      this.store.saveDelivery(task.id, report);
      if (mode === 'workspace-write' && !changingBaseline) {
        const dir = join(this.config.stateDir, 'artifacts', task.id, String(Date.now())); mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const check of project.worktree.checks) {
          signal.throwIfAborted(); hooks.progress(`正在验证：${check.name}`);
          const record: DeliveryReport['checks'][number] = { name: check.name, status: 'running', log: join(dir, `check-${report.checks.length + 1}.log`) };
          report.checks.push(record); this.store.saveDelivery(task.id, report);
          const run = await runCommand(check.command, check.args, workspace.path, signal,
            { check: true, log: record.log, timeoutSeconds: check.timeoutSeconds ?? 300 });
          record.exitCode = run.code; record.status = run.code === 0 ? 'passed' : 'failed'; this.store.saveDelivery(task.id, report);
          if (run.code !== 0) break;
        }
        const after = await inventory(workspace, signal);
        if (after.fingerprint !== report.fingerprint) report.error = '验证命令修改了交付文件，需要重新执行并验证。';
        report = { ...report, ...after, capturedAt: new Date().toISOString() };
        report.ready = !report.error && report.checks.length === project.worktree.checks.length
          && report.checks.length > 0 && report.checks.every(c => c.status === 'passed');
      }
      if (evidenceDirectory) {
        const evidence = collectEvidence(this.store, this.config.stateDir, task.id, evidenceDirectory);
        report.evidenceIds = evidence.ids; report.evidenceWarning = evidence.warning;
      }
      this.store.saveDelivery(task.id, report);
      return result;
    } catch (error) {
      try { report = { ...report, ...await inventory(workspace, AbortSignal.timeout(5000)), capturedAt: new Date().toISOString() }; } catch { /* Preserve last known snapshot. */ }
      report.ready = false; report.error = error instanceof Error ? error.message : '任务未完成';
      for (const check of report.checks) if (check.status === 'running') check.status = 'failed';
      this.store.saveDelivery(task.id, report); throw error;
    }
  }
}
