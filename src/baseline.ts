import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, inventory } from './workspace.js';
import type { Config, Project, Task } from './types.js';
import type { Store } from './store.js';

export const validBaseRef = (ref: string) => /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(ref) && !ref.includes('..');
export async function baselinePreview(store: Store, task: Task, project: Project, ref: string, signal: AbortSignal) {
  if (!validBaseRef(ref)) throw Error('请填写明确的 Git 分支或提交 SHA，不能使用表达式。');
  if (task.mode === 'workspace-write' && project.sandbox !== 'workspace-write') throw Error('项目修改权限已撤销，不能沿用修改模式。');
  const old = store.workspace(task.id);
  if (!old || !project.worktree || realpathSync(project.path) !== old.source) throw Error('当前任务没有匹配的 Git 工作副本。');
  const before = await inventory(old, signal);
  if (ref.startsWith('origin/')) await git(old.source, ['fetch', 'origin', `refs/heads/${ref.slice(7)}:refs/remotes/origin/${ref.slice(7)}`], signal);
  const sha = await git(old.source, ['rev-parse', '--verify', `${ref}^{commit}`], signal);
  return { old, before, ref, sha, configuration: JSON.stringify(project),
    description: `从指定代码版本继续 · ${project.label ?? task.project}\n当前版本：${old.baseRef} @ ${old.baseSha}\n新版本：${ref} @ ${sha}\n旧任务有 ${before.files.length} 个改动文件，将全部保留在旧副本，不自动复制到新副本。\n确认后新建独立任务与会话，继续原需求；只使用上方精确提交，不修改项目默认版本，不合并、重置或推送任何分支。` };
}
export async function restartAtBaseline(store: Store, config: Config, task: Task, preview: Awaited<ReturnType<typeof baselinePreview>>, signal: AbortSignal) {
  const project = config.projects[task.project];
  if (JSON.stringify(project) !== preview.configuration) throw Error('项目配置或权限已变化，请重新选择代码版本。');
  const current = await inventory(preview.old, signal);
  if (current.fingerprint !== preview.before.fingerprint || current.headSha !== preview.before.headSha) throw Error('旧副本内容已变化，请重新预览；所有文件仍保留。');
  signal.throwIfAborted();
  const original = store.originalPrompt(task.id);
  const prompt = `继续原任务要求：\n${original}${task.prompt !== original ? `\n\n最近的补充：\n${task.prompt}` : ''}\n\n主人已确认从 ${preview.ref} @ ${preview.sha} 创建新副本继续；旧副本改动未复制。`;
  return store.transaction(() => {
    store.set(task.id, 'review');
    const next = task.conversation ? store.handoff(store.get(task.id)!, task.project, prompt, task.mode, task.conversation)
      : store.create(task.chatId, task.project, prompt, task.mode);
    if (!task.conversation) { store.expire(task.id); store.event(task.id, 'handoff_to', next.id); }
    store.saveWorkspace({ taskId: next.id, source: preview.old.source, path: join(realpathSync(resolve(config.stateDir, 'worktrees')), next.id),
      branch: `steward/${next.id}`, baseSha: preview.sha, baseRef: preview.ref, configBaseRef: project.worktree!.baseRef });
    store.event(next.id, 'baseline_authorized', JSON.stringify({ fromTask: task.id, ref: preview.ref, sha: preview.sha }));
    store.enqueue(task.chatId, `已从 ${preview.ref} @ ${preview.sha.slice(0,12)} 创建新任务，继续原需求。旧副本及 ${preview.before.files.length} 个改动文件已保留。`, { kind: task.conversation ? 'reply' : 'task', taskId: next.id });
    return next;
  });
}
