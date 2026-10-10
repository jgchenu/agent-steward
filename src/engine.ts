import { Store } from './store.js';
import { canPublish, publicationKey } from './workspace.js';
import type { CardAction, Channel, Config, Executor, HumanRequest, Incoming, Status, Task, View } from './types.js';

const HELP = `Agent Steward · 个人数字员工（预览版）
/projects — 可用项目
/new <项目> <任务要求> — 只读分析
/edit <项目> <任务要求> — 在独立目录修改并验证
/publish <任务ID> — 预览草稿 PR 交付
/list 或 /status <任务ID> — 查进度
/cancel <任务ID> — 取消执行（不会回滚已有改动）
/continue <任务ID> <后续要求> — 继续已结束或中断的任务
/approve <请求ID> 或 /deny <请求ID> — 回答一次权限请求
/answer <请求ID> <回答> — 回答问题；多问题使用 JSON {"问题ID":"答案"}
/done <任务ID> — 确认验收
普通文本可派给唯一配置的项目；多个项目时请用 /new。`;

export class Engine {
  private active?: { task: Task; abort: AbortController; done: Promise<void> };
  private pending = new Map<string, HumanRequest>();
  private timer?: ReturnType<typeof setInterval>;
  private flushPromise?: Promise<void>;
  private stopped = false;
  constructor(readonly store: Store, readonly config: Config, private executor: Executor,
    private channel: Channel) {}

  start(): void {
    this.store.recover();
    this.timer = setInterval(() => { this.tick(); void this.flush(); }, 500);
    this.tick();
  }
  // Durable receipt + command mutation + notification are committed before acknowledging Feishu.
  receive(message: Incoming, actionId?: string): void {
    if (this.stopped || message.senderId !== this.config.ownerId || message.senderType !== 'user') return;
    const bound = message.chatType === 'group' ? this.store.conversationTask(message.chatId, message.conversation) : undefined;
    if (message.chatType === 'group' && (!this.config.groupChats || !message.conversation
      || (!message.botMentioned && (message.mentionsOthers || !bound)))) return;
    if (bound?.conversation && message.conversation) message = { ...message, conversation: {
      ...message.conversation, anchorId: bound.conversation.anchorId, scope: 'thread',
    } };
    const effects: Array<() => void> = [];
    this.store.transaction(() => {
      if (!this.store.consume(message.id)) return;
      if (actionId && !this.store.useAction(actionId)) return;
      const reply = (text: string, view?: View) => this.store.enqueue(message.chatId, text,
        message.conversation ? { ...(view ?? { kind: 'notice' }), conversation: message.conversation,
          ...(!view || ['home', 'list'].includes(view.kind) ? { fresh: true } : {}) }
          : view && ['home', 'list'].includes(view.kind) ? { ...view, fresh: true } : view);
      let text = message.text.trim();
      if (!text && message.botMentioned) text = '工作台';
      if (!text || text.length > 16_000) { reply('任务文本应为 1–16000 字符。'); return; }
      const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text);
      let command = match?.[1] ?? '/new';
      let args = match?.[2]?.trim() ?? '';
      const navigation = ['首页', '工作台', '帮助'].includes(text);
      if (!match && !navigation && bound) {
        const pending = this.store.requests(bound.id);
        if (pending.length === 1 && pending[0].kind === 'input') { command = '/answer'; args = `${pending[0].id} ${text}`; }
        else if (['queued', 'running', 'waiting_input', 'waiting_approval'].includes(bound.status)) {
          reply('当前任务仍在执行或等待确认，请使用任务卡片处理；本条消息没有授权任何操作。', { kind: 'task', taskId: bound.id }); return;
        } else { command = '/continue'; args = `${bound.id} ${text}`; }
      }
      if (command === '/help' || (!match && ['首页', '工作台', '帮助'].includes(text))) { reply(HELP, { kind: 'home' }); return; }
      if (command === '/projects') {
        reply(Object.entries(this.config.projects).map(([name, p]) => `${name} · ${p.sandbox}`).join('\n'), { kind: 'home' }); return;
      }
      if (command === '/new' || command === '/edit') {
        if (message.conversation && this.store.conversationTask(message.chatId, message.conversation)) {
          reply('此话题已绑定任务。直接在话题回复可继续；新任务请在群里另起消息 @我。', { kind: 'task', taskId: bound!.id }); return;
        }
        const names = Object.keys(this.config.projects);
        let project: string, prompt: string;
        if (!match && names.length === 1) { project = names[0]; prompt = text; }
        else {
          const parts = /^(\S+)\s+([\s\S]+)$/.exec(args);
          if (!parts) {
            if (message.conversation && !match && text.length <= 1000) reply('请选择项目后开始任务。', { kind: 'home', draft: text });
            else if (message.conversation && !match) reply('任务超过表单 1000 字上限，请使用 /new <项目> <完整任务要求> 派活。');
            else reply('用法：/new <项目> <任务要求>，项目列表：/projects');
            return;
          }
          [, project, prompt] = parts;
        }
        if (!Object.hasOwn(this.config.projects, project)) { reply('未配置该项目，请用 /projects 查询。'); return; }
        const mode = command === '/edit' ? 'workspace-write' : 'read-only';
        const p = this.config.projects[project];
        if (mode === 'workspace-write' && (p.sandbox !== mode || !p.worktree)) { reply('该项目仅支持只读分析。'); return; }
        const task = this.store.create(message.chatId, project, prompt, mode, message.conversation);
        reply(`已接单 ${task.id} · ${project}\n任务已排队。查询：/status ${task.id}`, { kind: 'task', taskId: task.id }); return;
      }
      if (command === '/list' || (command === '/status' && !args)) {
        reply(this.store.list(message.chatId).map(t => `${t.id} · ${t.project} · ${t.status}`).join('\n') || '暂无任务。', { kind: 'list' }); return;
      }
      const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
      const id = parts?.[1] ?? '', body = parts?.[2]?.trim() ?? '';
      if (['/approve', '/deny', '/answer'].includes(command)) {
        const req = this.store.getRequest(id), runtime = this.pending.get(id);
        const task = req && this.store.get(req.taskId);
        if (!req || !task || task.chatId !== message.chatId || (message.conversation && task.conversation?.anchorId !== message.conversation.anchorId) || req.status !== 'pending' || !runtime) {
          reply('请求不存在、已回答或已失效，请查看任务当前状态。'); return;
        }
        if ((req.kind === 'input') !== (command === '/answer') || (command === '/answer' && !body)) {
          reply(req.kind === 'input' ? `用法：/answer ${id} <回答>` : `用法：/approve ${id} 或 /deny ${id}`); return;
        }
        const answer = command === '/approve' ? 'accept' : command === '/deny' ? 'decline' : body;
        // Input validation runs synchronously, before consuming a one-shot request.
        if (runtime.validate) {
          try { runtime.validate(answer); }
          catch (error) { reply((error as Error).message); return; }
        }
        this.store.resolveRequest(id);
        this.store.event(task.id, 'human_response', `${id}: ${answer}`);
        this.updateWaiting(task.id);
        effects.push(() => { this.pending.delete(id); runtime.resolve(answer); });
        reply(`请求 ${id} 已回答。`, { kind: 'task', taskId: task.id }); return;
      }
      const task = this.store.get(id);
      if (!task || task.chatId !== message.chatId || (message.conversation && task.conversation?.anchorId !== message.conversation.anchorId)) { reply('任务不存在，请重新选择。', { kind: 'home' }); return; }
      if (command === '/publish') { reply('请先查看交付预览，再明确创建草稿 PR。', { kind: 'publication', taskId: id, fresh: true }); return; }
      if (command === '/status') {
        const requests = this.store.requests(id).map(r => `待处理请求：${r.id} · ${r.kind}`).join('\n');
        reply(`${id} · ${task.project} · ${task.status}\n${task.result ?? this.store.latestProgress(id)}\n${requests}`, { kind: 'task', taskId: id, fresh: true }); return;
      }
      if (command === '/cancel') {
        if (!['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.status)) {
          reply('任务当前未在执行。'); return;
        }
        this.store.set(id, 'cancelled'); this.store.expire(id);
        effects.push(() => { if (this.active?.task.id === id) this.active.abort.abort(); });
        reply(`任务 ${id} 已取消；已有文件修改保留。`, { kind: 'task', taskId: id }); return;
      }
      if (command === '/continue') {
        if (this.active?.task.id === id || !['review', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
          reply('请等当前执行结束后再继续，或先 /cancel。'); return;
        }
        if (!body) { reply(`用法：/continue ${id} <后续要求>`); return; }
        this.store.resume(id, body);
        if (message.conversation) this.store.saveConversation(id, message.conversation);
        reply(`任务 ${id} 已重新排队。`, { kind: 'task', taskId: id }); return;
      }
      if (command === '/done' && task.status === 'review') {
        this.store.set(id, 'completed'); reply(`任务 ${id} 已由你确认验收。`, { kind: 'task', taskId: id }); return;
      }
      reply(HELP, { kind: 'home' });
    });
    for (const effect of effects) effect();
    this.tick(); void this.flush();
  }
  // Only opaque, server-issued actions are accepted. Callback values are never executable commands.
  handleAction(action: CardAction): { toast: { type: 'success' | 'error'; content: string } } {
    const fail = (content: string) => ({ toast: { type: 'error' as const, content } });
    if (this.stopped || action.senderId !== this.config.ownerId) return fail('此操作仅限机器人的主人。');
    const saved = this.store.getAction(action.actionId);
    if (!saved || saved.chatId !== action.chatId || saved.expires < Date.now() || saved.used) {
      return fail('操作已处理或已过期。请发送“工作台”重新打开。');
    }
    const i = saved.intent, task = i.taskId ? this.store.get(i.taskId) : undefined;
    if (i.conversation && !this.config.groupChats) return fail('群聊功能已关闭。');
    if (i.op === 'new' && i.conversation && this.store.conversationTask(action.chatId, i.conversation)) return fail('此话题已绑定任务，请继续原任务；新任务请另起话题。');
    if (i.taskId && (!task || task.chatId !== action.chatId)) return fail('任务不属于当前会话。');
    const mutating = ['new', 'continue', 'done', 'cancel', 'approve', 'deny', 'answer', 'publish'].includes(i.op);
    if (mutating && task && i.revision !== task.updatedAt) return fail('任务状态已变化，请刷新后再操作。');
    const body = typeof action.fields.body === 'string' ? action.fields.body.trim() : '';
    if (['new', 'continue', 'answer'].includes(i.op) && (!body || body.length > 1000)) return fail('请填写 1–1000 字的内容。');
    if (i.op === 'new' && (typeof action.fields.project !== 'string' || !Object.hasOwn(this.config.projects, action.fields.project))) {
      return fail('请选择已配置的项目。');
    }
    if (i.op === 'new') {
      if (action.fields.mode !== undefined && !['read-only', 'workspace-write'].includes(String(action.fields.mode))) return fail('请选择有效的工作模式。');
      const project = this.config.projects[String(action.fields.project)];
      if (action.fields.mode === 'workspace-write' && (project.sandbox !== 'workspace-write' || !project.worktree)) return fail('该项目仅支持只读分析，请重新选择模式。');
    }
    if (i.op === 'publish') {
      if (!task || this.active?.task.id === task.id || !['review', 'completed', 'failed'].includes(task.status)
        || !canPublish(task, this.config.projects[task.project], this.store.delivery(task.id))) return fail('尚不具备 PR 交付条件，请检查文件与验证结果。');
      const report = this.store.delivery(task.id)!, project = this.config.projects[task.project];
      if (i.publicationKey !== publicationKey(task, project, report)) return fail('交付内容或目标已变化，请重新预览后确认。');
      this.store.transaction(() => {
        if (!this.store.consume('card:' + action.id) || !this.store.useAction(action.actionId)) return;
        this.store.saveDelivery(task.id, { ...report, authorizedKey: i.publicationKey });
        this.store.queuePublication(task.id);
        this.store.event(task.id, 'publication_authorized', 'Owner confirmed source-branch push and draft PR only.');
        this.store.enqueue(task.chatId, '正在准备草稿 PR', { kind: 'task', taskId: task.id });
      });
      this.tick(); void this.flush();
      return { toast: { type: 'success', content: '已排队准备草稿 PR，不会自动合并。' } };
    }
    if (i.op === 'done' && task?.status !== 'review') return fail('该任务当前不需要验收。');
    if (['continue', 'followup'].includes(i.op) && (this.active?.task.id === task?.id ||
      !['review', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task?.status ?? ''))) return fail('请等当前执行结束后继续。');
    if (i.op === 'cancel' && !['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task?.status ?? '')) return fail('任务已经停止。');
    if (['approve', 'deny', 'answer'].includes(i.op)) {
      const req = this.store.getRequest(i.requestId ?? ''), runtime = this.pending.get(i.requestId ?? '');
      if (!req || req.taskId !== task?.id || req.status !== 'pending' || !runtime ||
        (req.kind === 'input') !== (i.op === 'answer')) return fail('该请求已失效，未执行任何授权。');
      try { runtime.validate?.(i.op === 'answer' ? body : i.op === 'approve' ? 'accept' : 'decline'); }
      catch (e) { return fail(e instanceof Error ? e.message : '请检查输入。'); }
    }
    const views: Partial<Record<typeof i.op, View>> = {
      home: { kind: 'home' }, list: { kind: 'list', page: i.page },
      status: { kind: 'task', taskId: i.taskId! }, result: { kind: 'result', taskId: i.taskId!, page: i.page },
      followup: { kind: 'followup', taskId: i.taskId! },
      delivery: { kind: 'delivery', taskId: i.taskId! }, publication: { kind: 'publication', taskId: i.taskId! },
    };
    const view = views[i.op];
    if (view) {
      this.store.transaction(() => {
        if (this.store.consume('card:' + action.id)) this.store.enqueue(action.chatId, '已更新', { ...view, conversation: i.conversation, targetMessageId: action.messageId });
      });
      void this.flush();
    } else {
      const command = i.op === 'new' ? `${action.fields.mode === 'workspace-write' ? '/edit' : '/new'} ${action.fields.project} ${body}`
        : ['approve', 'deny', 'answer'].includes(i.op) ? `/${i.op} ${i.requestId} ${body}`
        : `/${i.op} ${i.taskId} ${body}`;
      this.receive({ id: 'card:' + action.id, senderId: action.senderId, chatId: action.chatId,
        chatType: i.conversation ? 'group' : 'p2p', senderType: 'user', text: command,
        botMentioned: !!i.conversation, conversation: i.conversation && { ...i.conversation, sourceId: action.messageId, cutoff: String(Date.now()) } }, action.actionId);
      // Refresh only the form that was submitted, not an older entry point in chat history.
      if (i.op === 'new') this.store.enqueue(action.chatId, '任务已提交', { kind: 'home', conversation: i.conversation, targetMessageId: action.messageId });
    }
    return { toast: { type: 'success', content: view ? '已更新' : '已处理' } };
  }
  private updateWaiting(id: string): void {
    const remaining = this.store.requests(id);
    const status: Status = remaining.some(r => r.kind === 'approval') ? 'waiting_approval'
      : remaining.length ? 'waiting_input' : 'running';
    this.store.set(id, status);
  }
  private tick(): void {
    if (this.stopped || this.active) return;
    const task = this.store.list().find(t => t.status === 'queued');
    if (!task) return;
    const abort = new AbortController();
    this.store.set(task.id, 'running');
    this.store.enqueue(task.chatId, `开始执行 ${task.id} · ${task.project}`, { kind: 'task', taskId: task.id });
    // Defer execution so synchronous adapters cannot race active-run registration.
    const done = Promise.resolve().then(() => this.run(task, abort));
    this.active = { task, abort, done };
  }
  private async run(task: Task, abort: AbortController): Promise<void> {
    const timeout = setTimeout(() => abort.abort(new Error('执行超过配置时限')), this.config.maxRunMinutes * 60_000);
    try {
      const project = this.config.projects[task.project];
      if (!project) throw new Error('项目配置已移除。');
      let executionTask = task;
      if (task.conversation && task.nextAction !== 'publish') {
        if (!this.config.groupChats || !this.channel.context) throw new Error('群上下文读取未启用，任务未执行。');
        this.store.event(task.id, 'progress', '正在读取当前会话上下文。');
        const snapshot = await this.channel.context(task, abort.signal);
        abort.signal.throwIfAborted();
        this.store.saveContext(task.id, snapshot); this.store.event(task.id, 'context_loaded', snapshot.summary);
        executionTask = { ...task, contextSnapshot: snapshot };
      }
      const result = await this.executor.run(executionTask, project, {
        thread: id => this.store.thread(task.id, id),
        progress: text => this.store.event(task.id, 'progress', text.slice(0, 8000)),
        request: req => {
          if (abort.signal.aborted) throw new Error('任务已停止');
          const id = this.store.request(task.id, req.kind, req.description);
          this.pending.set(id, req); this.updateWaiting(task.id);
          this.store.enqueue(task.chatId, `任务 ${task.id} 需要你处理 · 请求 ${id}\n${req.description}\n`
            + (req.kind === 'approval' ? `/approve ${id} 或 /deny ${id}` : `/answer ${id} <回答>`), { kind: 'task', taskId: task.id });
          return id;
        },
        resolved: id => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id); this.store.resolveRequest(id, 'expired');
          if (!abort.signal.aborted) this.updateWaiting(task.id);
        },
      }, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      this.store.set(task.id, 'review', result);
      const report = this.store.delivery(task.id);
      const evidence = report ? `\n实际改动：${report.files.length} 个文件\n验证：${report.checks.map(c => `${c.name}: ${c.status}`).join('；') || '未运行'}\n${report.prUrl ?? ''}` : '';
      this.store.enqueue(task.chatId, `任务 ${task.id} 已产出结果，等待你验收（执行器报告，尚非独立验证）。\n${result}${evidence}\n`
        + `验收：/done ${task.id}\n继续：/continue ${task.id} <要求>`, { kind: 'task', taskId: task.id });
    } catch (error) {
      const state = this.store.get(task.id)?.status;
      if (state !== 'cancelled') {
        const reason = error instanceof Error ? error.message : '执行失败';
        this.store.set(task.id, this.stopped ? 'interrupted' : 'failed', reason);
        this.store.enqueue(task.chatId, `任务 ${task.id} ${this.stopped ? '已中断' : '失败'}：${reason}\n`
          + `不会自动重试已发生的操作。检查后用 /continue ${task.id} <要求> 继续。`, { kind: 'task', taskId: task.id });
      }
    } finally {
      clearTimeout(timeout);
      for (const id of this.pending.keys()) {
        if (this.store.getRequest(id)?.taskId === task.id) this.pending.delete(id);
      }
      this.store.expire(task.id); this.active = undefined;
      this.tick(); void this.flush();
    }
  }
  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.drain();
    try { await this.flushPromise; } finally { this.flushPromise = undefined; }
  }
  private async drain(): Promise<void> {
      let item;
      while ((item = this.store.outgoing())) {
        try { await this.channel.send(item.chatId, item.text, item.id, item.view ? JSON.parse(item.view) as View : undefined); this.store.delivered(item.id); }
        catch { this.store.retry(item.id, item.attempts); }
      }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    this.active?.abort.abort(new Error('服务停止'));
    await this.active?.done;
    await this.flush();
  }
}
