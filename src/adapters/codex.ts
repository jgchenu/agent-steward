import { CodexRpc, type RpcMessage } from './rpc.js';
import type { Executor, Project, RunHooks, Task } from '../types.js';

const INSTRUCTIONS = `You are executing a task for the owner of Agent Steward.
Read the repository's AGENTS.md before changes. Keep work inside the configured project.
Do not expose credentials. Do not merge PRs, enable auto-merge, force-push, or push main/staging.
Prepare a source branch and a PR only when authorized by the task. Preserve unrelated local edits.
Ask for human input when blocked. A tool approval is permission for that specific action only.
At the end report actual changes, validation performed, artifacts/PR links, and unresolved limitations.
Never claim independent verification, publication, or deployment without evidence.`;

export function inputAnswers(questions: Array<{ id: string }>, text: string): Record<string, { answers: string[] }> {
  if (!questions.length) throw new Error('请求没有可回答的问题。');
  if (questions.length === 1) return { [questions[0].id]: { answers: [text] } };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('多个问题请使用 JSON：{"问题ID":"答案"}'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('回答必须是 JSON 对象。');
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const answer = (parsed as Record<string, unknown>)[q.id];
    if (typeof answer !== 'string' || !answer.trim()) throw new Error(`请填写问题 ${q.id} 的答案。`);
    answers[q.id] = { answers: [answer] };
  }
  return answers;
}

export interface RpcPort {
  onMessage: (m: RpcMessage) => void; onExit: (e: Error) => void;
  initialize(): Promise<void>; subscription(): Promise<void>;
  request(method: string, params: unknown): Promise<any>;
  write(message: unknown): void; close(): void | Promise<void>;
}

export class CodexExecutor implements Executor {
  constructor(private command = 'codex', private factory: (command: string, cwd: string) => RpcPort
    = (command, cwd) => new CodexRpc(command, cwd)) {}

  async run(task: Task, project: Project, hooks: RunHooks, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const rpc = this.factory(this.command, project.path);
    let threadId: string | undefined, result = '';
    const pending = new Map<string | number, string>();
    const fileChanges = new Map<string, unknown>();
    let resolve!: (text: string) => void, reject!: (error: Error) => void;
    const completion = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    void completion.catch(() => {});
    rpc.onExit = reject;
    const abort = () => { reject(signal.reason ?? new Error('任务取消')); void rpc.close(); };
    signal.addEventListener('abort', abort, { once: true });
    rpc.onMessage = (message: RpcMessage) => {
      const p = message.params ?? {};
      if (message.id !== undefined && message.method) {
        if (p.threadId !== threadId) {
          rpc.write({ id: message.id, error: { code: -32602, message: 'Unknown task thread' } }); return;
        }
        const id = message.id;
        const respond = (value: unknown) => { pending.delete(id); rpc.write({ id, result: value }); };
        if (message.method === 'item/commandExecution/requestApproval'
          || message.method === 'item/fileChange/requestApproval') {
          const details = message.method.includes('commandExecution')
            ? { command: p.command, cwd: p.cwd, reason: p.reason, network: p.networkApprovalContext }
            : { reason: p.reason, grantRoot: p.grantRoot, changes: fileChanges.get(p.itemId) };
          // Never truncate approval details and then offer approval of an unseen action.
          const description = JSON.stringify(details, null, 2);
          if (description.length > 12_000 || (message.method.includes('fileChange') && !fileChanges.has(p.itemId))) {
            respond({ decision: 'decline' });
            hooks.progress('权限请求无法完整展示，已拒绝；请在本机检查。'); return;
          }
          pending.set(id, hooks.request({ kind: 'approval', description,
            resolve: answer => respond({ decision: answer === 'accept' ? 'accept' : 'decline' }) }));
        } else if (message.method === 'tool/requestUserInput') {
          const questions = p.questions;
          if (!Array.isArray(questions) || !questions.length || questions.some(q => typeof q.id !== 'string' || q.isSecret)) {
            respond({ answers: {} }); hooks.progress('敏感或无法识别的输入请求未转发，请在本机处理。'); return;
          }
          const description = questions.map(q => `${q.id}: ${q.question}\n`
            + (q.options ?? []).map((o: { label: string; description?: string }) => `${o.label}: ${o.description ?? ''}`).join('\n')).join('\n\n');
          const request = { kind: 'input' as const, description,
            validate: (text: string) => { inputAnswers(questions, text); },
            resolve: (text: string) => respond({ answers: inputAnswers(questions, text) }) };
          pending.set(id, hooks.request(request));
        } else {
          // New protocol permissions or tool calls must never silently gain authority.
          rpc.write({ id, error: { code: -32601, message: `Unsupported request: ${message.method}` } });
          hooks.progress(`未支持的 Codex 请求已拒绝：${message.method}`);
        }
        return;
      }
      if (message.method === 'serverRequest/resolved') {
        const local = pending.get(p.requestId);
        if (local) { hooks.resolved(local); pending.delete(p.requestId); }
      }
      if (p.threadId !== threadId) return;
      if (message.method === 'item/started' && p.item?.type === 'fileChange') {
        fileChanges.set(p.item.id, p.item.changes);
      }
      if (message.method === 'item/completed') {
        const item = p.item;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') {
          hooks.progress(item.text);
          // Commentary does not constitute a final deliverable.
          if (item.phase !== 'commentary') result = item.text;
        } else if (item?.type === 'commandExecution') hooks.progress(`commandExecution: ${item.status}`);
      }
      if (message.method === 'turn/completed') {
        if (p.turn?.status === 'completed') resolve(result || '执行结束，但未收到最终说明。请继续询问交付结果。');
        else reject(new Error(p.turn?.error?.message ?? `Codex turn: ${p.turn?.status ?? 'unknown'}`));
      }
    };
    try {
      await rpc.initialize();
      await rpc.subscription();
      signal.throwIfAborted();
      const common = { cwd: project.path, modelProvider: 'openai', sandbox: project.sandbox,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', developerInstructions: INSTRUCTIONS };
      const response = await rpc.request(task.threadId ? 'thread/resume' : 'thread/start',
        task.threadId ? { ...common, threadId: task.threadId } : common);
      threadId = response?.thread?.id;
      if (typeof threadId !== 'string') throw new Error('Codex 未返回会话 ID');
      hooks.thread(threadId);
      signal.throwIfAborted();
      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: task.prompt, text_elements: [] }],
        approvalPolicy: 'on-request', approvalsReviewer: 'user' });
      return await completion;
    } finally {
      signal.removeEventListener('abort', abort);
      for (const id of pending.values()) hooks.resolved(id);
      await rpc.close();
    }
  }
}
