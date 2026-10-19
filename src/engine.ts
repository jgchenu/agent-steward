import { taskConcurrency } from './config.js';
import { decideSubmission, publishSubmissionResult, receiveSubmission, replyToRequester, requesterAllowed, revokeSubmissions, submission } from './submissions.js';
import { approveOperation, currentOperation, decideOperation, operationFailure, OperationWaiting } from './operations.js';
import { viewKey } from './channels/cards.js';
import { CONVERSATION, conversationProject } from './conversation.js';
import { permissionMode, permissionRank } from './permissions.js';
import { asksModelStatus, modelStatusText } from './models.js';
import { codeSourceReceipt, codeSourceDetails, codeSourceChanged, deliveryFooter } from './code-source.js';
import { baselinePreview, restartAtBaseline, validBaseRef } from './baseline.js';
import { parseBaselineProposal } from './delivery-preparation.js';
import { namedProjects, projectAnswer, projectGrantKey } from './routing.js';
import { Store } from './store.js';
import { canPublish, publicationBlocker, publicationKey, TargetBranchMoved } from './workspace.js';
import { mergeIntent, mergePullRequest } from './merge.js';
import { parseMergeProposal, type MergeProposal } from './operation-intent.js';
import { TaskOrchestrator } from './orchestration.js';
import type { BaselineProposal, CardAction, Channel, Config, ContextSnapshot, Executor, HumanRequest, Incoming, PublicationTarget, RunHooks, Status, Task, View } from './types.js';

const HELP = `Agent Steward · 个人 Agent 分身（预览版）
/requests — 查看来访者待确认的文字任务（请私聊）
/whoami — 查看本机器人下的飞书身份 ID
/projects — 可用代码资源
/new <项目> <任务要求> — 只读分析
/edit <项目> <任务要求> — 在独立目录修改并验证
/source <任务ID> — 查看实际代码来源
/model [任务ID] — 查看本轮或最近一轮的模型与思考强度
/baseline <任务ID> — 选择代码版本并从新副本继续
/publish <任务ID> — 预览草稿 PR 交付
/merge <任务ID> <PR链接> — 检查 PR，确认后代为合并
/list 或 /status <任务ID> — 查进度
/cancel <任务ID> — 取消执行（不会回滚已有改动）
/continue <任务ID> <后续要求> — 继续已结束或中断的任务
/approve <请求ID> 或 /deny <请求ID> — 回答一次权限请求
/answer <请求ID> <回答> — 回答问题；多问题使用 JSON {"问题ID":"答案"}
/done <任务ID> — 确认验收
直接说需求即可开始；使用默认项目或唯一配置的项目，工作台是可选入口。`;

export class Engine {
  private active = new Map<string, { task: Task; abort: AbortController; done: Promise<void> }>();
  private pending = new Map<string, HumanRequest>();
  private timer?: ReturnType<typeof setInterval>;
  private flushPromise?: Promise<void>;
  private stopped = false;
  private orchestrator?: TaskOrchestrator;
  constructor(readonly store: Store, readonly config: Config, private executor: Executor,
    private channel: Channel, private mergeRunner = mergePullRequest) {
    config.maxConcurrentTasks = taskConcurrency(config.maxConcurrentTasks);
    store.pilotIntake = config.langGraphPilot !== false;
    // Intake policy must not strand persisted graph questions or recovery receipts.
    this.orchestrator = new TaskOrchestrator(store);
  }

  updateProjects(next: Pick<Config, 'projects' | 'defaultProject' | 'codexProjects'> & Partial<Pick<Config, 'trustedRequesters' | 'permissionMode' | 'approvalsReviewer' | 'modelSelection' | 'maxConcurrentTasks'>>): void {
    const concurrency = taskConcurrency('maxConcurrentTasks' in next ? next.maxConcurrentTasks : this.config.maxConcurrentTasks);
    this.config.maxConcurrentTasks = concurrency;
    if ('trustedRequesters' in next) this.config.trustedRequesters = next.trustedRequesters;
    for (const id of this.store.transaction(() => revokeSubmissions(this.store,this.config))) this.active.get(id)?.abort.abort(new Error('来访者授权已撤销'));
    const previous = this.config.projects;
    for (const task of this.store.list()) {
      const selection = this.store.projectSelection(task.id);
      if (selection && (!next.projects[selection.project] || projectGrantKey(next.projects[selection.project]) !== selection.grantKey)) this.store.clearProjectSelection(task.id);
    }
    if ('modelSelection' in next) this.config.modelSelection = next.modelSelection;
    if ('permissionMode' in next || 'approvalsReviewer' in next) {
      const mode = permissionMode(next);
      this.config.permissionMode = mode; this.config.approvalsReviewer = next.approvalsReviewer;
      for (const run of this.active.values()) if (permissionRank(mode) < permissionRank(run.task.permissionMode ?? 'ask')) {
        run.abort.abort(new Error('审批模式已收紧，本轮执行已停止；已有改动保留，请继续任务以应用新设置。'));
      }
    }
    this.config.codexProjects = next.codexProjects; this.config.projects = next.projects; this.config.defaultProject = next.defaultProject;
    for (const run of this.active.values()) {
      const t = run.task, p = next.projects[t.project];
      if (t.project !== CONVERSATION && (!p || p.path !== previous[t.project]?.path || p.workspaceMode !== previous[t.project]?.workspaceMode || (t.mode === 'workspace-write' && p.sandbox !== 'workspace-write'))) run.abort.abort(new Error('项目授权或执行位置已变化，执行已停止；已有改动保留。'));
    }
  }
  permissionState() {
    const runs = [...this.active.values()];
    const broadest = runs.map(r => r.task.permissionMode ?? 'ask').sort((a,b) => permissionRank(b)-permissionRank(a))[0];
    const selection = runs.length === 1 ? runs[0].task.modelSelection : undefined;
    return { trustedRequesterIds:(this.config.trustedRequesters ?? []).map(p=>p.openId).sort(), permissionMode: permissionMode(this.config), activeMode: broadest, active: runs.length > 0, activeCount: runs.length, maxConcurrentTasks: this.config.maxConcurrentTasks,
      ...(this.config.modelSelection ? {modelSelection:this.config.modelSelection} : {}), ...(selection ? {activeModelSelection:selection} : {}) };
  }
  start(): void {
    this.store.recover();
    this.timer = setInterval(() => { this.tick(); void this.flush(); }, 500);
    this.tick();
  }
  // Durable receipt + command mutation + notification are committed before acknowledging Feishu.
  receive(message: Incoming, actionId?: string): void {
    if (this.stopped || message.senderType !== 'user') return;
    if (message.text.trim() === '/whoami' && (message.chatType === 'p2p' || (this.config.groupChats && message.botMentioned && message.conversation))) {
      this.store.transaction(() => {
        if (this.store.consume(message.id)) this.store.enqueue(message.chatId,`你在本机器人下的飞书 open_id：${message.senderId}\n请把它发给主人，由主人在本机控制台添加。此命令不会授予权限。`,{kind:'requester-reply',conversation:message.conversation});
      }); void this.flush();return;
    }
    if (message.senderId !== this.config.ownerId) { receiveSubmission(this.store,this.config,message);void this.flush();return; }
    const dmWaits = message.chatType === 'p2p' && !message.text.trim().startsWith('/')
      ? this.store.list().filter(t => t.chatId === message.chatId && ['waiting_input','waiting_approval'].includes(t.status)
        && this.store.requests(t.id).length) : [];
    const dmSelections = message.chatType === 'p2p' && !message.text.trim().startsWith('/')
      ? this.store.list(message.chatId).filter(t => t.status === 'review' && this.store.projectSelection(t.id)) : [];
    const selectionAnswer = !!projectAnswer(message.text) || namedProjects(this.config,message.text).length > 0;
    const bound = message.chatType === 'group' ? this.store.conversationTask(message.chatId, message.conversation)
      : dmWaits.length === 1 && this.store.graphWait(dmWaits[0].id)?.requestId === this.store.requests(dmWaits[0].id)[0]?.id ? dmWaits[0]
      : !dmWaits.length && dmSelections.length === 1 && selectionAnswer ? dmSelections[0] : undefined;
    const pendingInput = bound && this.store.requests(bound.id);
    const projectSelection = bound && this.store.projectSelection(bound.id);
    const answeringProject = !!projectSelection && !!projectAnswer(message.text);
    const answering = pendingInput?.length === 1 && pendingInput[0].kind === 'input' && !this.pending.get(pendingInput[0].id)?.explicit;
    const replying = bound && this.store.isOwnMessage(message.chatId, message.conversation?.parentId);
    if (message.chatType === 'group' && (!this.config.groupChats || !message.conversation
      || (!message.botMentioned && (message.mentionsOthers || (!replying && !answering && !answeringProject))))) return;
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
      const text = message.text.trim();
      if (text === '/requests') {
        if (message.chatType !== 'p2p') { reply('请私聊机器人发送 /requests 查看来访任务，避免公开其他人的需求。');return; }
        for (const id of revokeSubmissions(this.store,this.config)) effects.push(() => this.active.get(id)?.abort.abort(new Error('来访者授权已撤销')));
        const rows = this.store.db.prepare("SELECT id FROM submissions WHERE status='pending' ORDER BY createdAt LIMIT 20").all() as Array<{id:string}>;
        for (const row of rows) this.store.enqueue(message.chatId,'待确认申请',{kind:'submission',submissionId:row.id,fresh:true});
        if (!rows.length) reply('当前没有待确认的来访任务。');return;
      }
      if (!text && message.botMentioned) { reply('我在。直接告诉我想做什么，例如“分析上面的讨论，给出建议”。'); return; }
      const formPrompt = actionId ? /^\/(?:new|edit)\s+\S+\s+([\s\S]*)$/.exec(text)?.[1] : undefined;
      if (!text || (formPrompt ?? text).length > 16_000) { reply('任务文本应为 1–16000 字符。'); return; }
      const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match && dmWaits.length > 1 && dmWaits.some(t => this.store.graphWait(t.id))) { reply('当前有多个待处理的问题或权限请求，请使用对应卡片提交回答。'); return; }
      if (!match && !dmWaits.length && dmSelections.length > 1 && projectAnswer(text)) { reply('当前有多个待选择的代码资源，请说明对应的任务和项目。'); return; }
      let command = match?.[1] ?? '/new';
      let args = match?.[2]?.trim() ?? '';
      let selectedResource: string | undefined;
      if (command === '/model' || (!match && asksModelStatus(text))) {
        const target = args ? this.store.get(args) : bound ?? (message.chatType === 'p2p' ? this.store.list(message.chatId)[0] : undefined);
        if (args && (!target || target.chatId !== message.chatId || (message.conversation && target.conversation?.anchorId !== message.conversation.anchorId))) {
          reply('任务不存在，请在对应话题查询。'); return;
        }
        const current = target && this.store.runtimeModel(target.id);
        const scope = target ? (this.active.has(target.id) && (!target.nextAction || target.nextAction === 'execute') ? '当前执行参数' : '该任务最近一轮模型执行参数') : '当前没有可查询的模型执行';
        reply(modelStatusText(current, this.config.modelSelection, scope), target ? {kind:'reply',taskId:target.id} : undefined); return;
      }
      if (['控制台','打开控制台','设置','/console'].includes(text)) {
        reply(this.config.consoleUrl ? `在运行分身的电脑上打开：[分身控制台](${this.config.consoleUrl})。可以收藏此地址，设置权限、模型和项目。手机或其他电脑暂不支持访问这个本机地址。` : '控制台尚未启动，请在运行分身的电脑上启动新版服务。'); return;
      }
      let navigation = ['首页', '工作台', '帮助'].includes(text);
      if (!match && bound && /^(创建|提交|交付|准备)(草稿\s*)?\s*PR$/i.test(text)) { command = '/publish'; args = bound.id; navigation = true; }
      const mergeTarget = !match && bound ? mergeIntent(text) : undefined;
      if (mergeTarget !== undefined) { command='/merge'; args=`${bound!.id} ${mergeTarget}`.trim(); navigation=true; }
      if (!match && bound && /^(代码来源|查看代码来源|当前代码版本)$/.test(text)) {
        reply(codeSourceDetails(this.store.delivery(bound.id), this.config.projects[bound.project], true), { kind: 'source', taskId: bound.id, fresh: true }); return;
      }
      if (!match && bound && /^(更新代码版本|更换代码版本|更新任务基线)$/.test(text)) {
        reply('选择从哪个代码版本继续。原副本会保留。', { kind: 'baseline', taskId: bound.id, fresh: true }); return;
      }
      if (!match && !navigation && bound && projectSelection && projectAnswer(text)) {
        if (this.active.has(bound.id) || bound.status !== 'review' || bound.project !== CONVERSATION
          || this.store.requests(bound.id).length) { reply('当前执行尚未结束，请稍后回答项目选择。'); return; }
        this.store.clearProjectSelection(bound.id);
        if (projectAnswer(text) === 'no') { reply('已取消这次项目选择。请告诉我应使用哪个项目，或补充需求。'); return; }
        const selected = this.config.projects[projectSelection.project];
        if (projectSelection.revision !== bound.updatedAt || !selected || projectGrantKey(selected) !== projectSelection.grantKey) {
          reply('项目授权或任务已变化，旧项目选择已失效。请明确要使用的项目。'); return;
        }
        const mode = selected.naturalMode ?? 'read-only';
        if (mode === 'workspace-write' && (selected.sandbox !== mode || (!selected.worktree && selected.workspaceMode !== 'direct'))) { reply('该项目当前没有可用的修改工作区，请在控制台检查授权。'); return; }
        const prompt = `${this.store.ownerRequirements(bound.id)}\n\n主人已确认代码资源：${selected.label ?? projectSelection.project}\n主人本次回答：${text}`;
        const next = this.store.handoff(bound, projectSelection.project, prompt, mode, message.conversation);
        this.store.event(next.id, 'project_confirmed', JSON.stringify({fromTaskId:bound.id,project:projectSelection.project,messageId:message.id}));
        reply(`已确认 ${selected.label ?? projectSelection.project}，正在分配工作区并继续处理。`, {kind:'reply',taskId:next.id}); return;
      }
      if (!match && !navigation && bound) {
        const pending = this.store.requests(bound.id);
        if (pending.length === 1 && pending[0].kind === 'input' && !this.pending.get(pending[0].id)?.explicit) { command = '/answer'; args = `${pending[0].id} ${text}`; }
        else if (['queued', 'running', 'waiting_input', 'waiting_approval'].includes(bound.status)) {
          if (['queued','running'].includes(bound.status)) {
            const pending = this.store.pendingFollowups(bound.id);
            if (pending.join('').length + text.length > 32_000) { reply('待处理补充已达容量，本条尚未保存。请等当前执行结束后再发送。'); return; }
            this.store.event(bound.id, 'followup_pending', text);
            reply('已保存这条文字补充；当前执行继续。结束后我会提醒你处理，继续任务时会一并带入；这不代表批准任何操作。', {kind:'reply',taskId:bound.id}); return;
          }
          reply(bound.status === 'waiting_approval' ? '这一步需要你确认具体操作，我在等你的决定。' : '这一步需要你通过卡片明确提交回答，普通聊天不会回答工具权限请求。', { kind:'task', taskId: bound.id }); return;
        } else {
          // A named resource is an answer only within an existing resource-selection request.
          const choices = projectSelection ? namedProjects(this.config, text) : [];
          if (choices.length === 1 && choices[0] !== projectSelection!.project) {
            selectedResource = choices[0]; command = '/new';
          } else { command = '/continue'; args = `${bound.id} ${text}`; }
        }
      }
      if (command === '/help' || (!match && ['首页', '工作台', '帮助'].includes(text))) { reply(HELP, { kind: 'home' }); return; }
      if (command === '/projects') {
        reply(Object.entries(this.config.projects).map(([name, p]) => `${name} · ${p.sandbox}`).join('\n'), { kind: 'home' }); return;
      }
      if (command === '/new' || command === '/edit') {
        let project: string, prompt: string;
        if (!match) {
          project = selectedResource ?? CONVERSATION; prompt = text;
        }
        else {
          const parts = /^(\S+)\s+([\s\S]+)$/.exec(args);
          if (!parts) { reply('用法：/new <项目> <任务要求>，项目列表：/projects'); return; }
          [, project, prompt] = parts;
        }
        if (project !== CONVERSATION && !Object.hasOwn(this.config.projects, project)) { reply('未配置该项目，请用 /projects 查询。'); return; }
        const mode = command === '/edit' ? 'workspace-write' : !match ? this.config.projects[project]?.naturalMode ?? 'read-only' : 'read-only';
        const p = project === CONVERSATION ? conversationProject(this.config) : this.config.projects[project];
        if (mode === 'workspace-write' && (p.sandbox !== mode || (!p.worktree && p.workspaceMode !== 'direct'))) { reply('该项目仅支持只读分析。'); return; }
        if (bound && (this.active.has(bound.id) || !['review','completed','failed','cancelled','interrupted'].includes(bound.status))) {
          reply('我还在处理当前工作，完成或停止后才能切换项目。'); return;
        }
        if (bound && bound.project === project) {
          if (mode !== bound.mode) { reply('这段工作的执行权限保持不变。需要不同权限时，请另起消息说明任务。'); return; }
          this.store.resume(bound.id, prompt); this.store.saveConversation(bound.id, message.conversation!); return;
        }
        if (bound && (bound.project === CONVERSATION || bound.project === this.config.defaultProject) && !this.store.workspace(bound.id)) {
          // Recover a request previously misrouted to general discussion, using owner input only.
          prompt = `本话题最初的需求与补充：\n${this.store.ownerRequirements(bound.id)}\n\n主人本次补充：\n${prompt}`;
        }
        const task = bound && message.conversation
          ? this.store.handoff(bound, project, prompt, mode, message.conversation)
          : this.store.create(message.chatId, project, prompt, mode, message.conversation);
        if (!message.conversation || !this.channel.acknowledge) reply(`已接单 ${task.id} · ${project === CONVERSATION ? '对话' : project}\n任务已排队。查询：/status ${task.id}`, { kind: 'task', taskId: task.id }); return;
      }
      if (command === '/list' || (command === '/status' && !args)) {
        reply(this.store.list(message.chatId).map(t => `${t.id} · ${t.project} · ${t.status}`).join('\n') || '暂无任务。', { kind: 'list' }); return;
      }
      const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
      const id = parts?.[1] ?? '', body = parts?.[2]?.trim() ?? '';
      if (['/approve', '/deny', '/answer'].includes(command)) {
        const req = this.store.getRequest(id), runtime = this.pending.get(id);
        const task = req && this.store.get(req.taskId);
        const business = task && this.store.graphWait(task.id);
        const operation=task && currentOperation(this.store,task.id);
        if(operation?.requestId===id && req?.status==='pending' && operation.state==='pending'){
          if(!task || task.status!=='waiting_approval' || task.nextAction!=='merge' || this.active.has(task.id)
            || task.chatId!==message.chatId || task.conversation?.anchorId!==message.conversation?.anchorId
            || (bound && bound.id!==task.id) || operation.scope.ownerId!==message.senderId){reply('请在操作所属话题处理有效的确认。');return;}
          if(!['/approve','/deny'].includes(command)){reply('请明确允许或拒绝这项操作。');return;}
          const project=this.config.projects[task.project];
          if(!project || projectGrantKey(project)!==operation.scope.grantKey || operation.expiresAt<=Date.now()){
            operationFailure(this.store,task.id,'项目授权已变化或确认已过期，请重新预览。');
            this.store.set(task.id,'review','项目授权已变化或确认已过期，请重新预览。');this.refreshTaskCard(task);reply('项目授权已变化或确认已过期，请重新预览。',{kind:'task',taskId:task.id});return;
          }
          decideOperation(this.store,operation,message.senderId,command==='/approve');
          this.refreshTaskCard(task);
          reply(command==='/approve'?'已记录这项操作的确认，重新校验后执行。':'未合并，PR 保持原样。',{kind:'task',taskId:task.id});return;
        }
        if (command === '/answer' && task && req?.kind === 'input' && req.status === 'pending' && business?.requestId === id) {
          if (task.chatId !== message.chatId || (message.conversation && task.conversation?.anchorId !== message.conversation.anchorId)) { reply('请在问题所在会话回答。'); return; }
          if (!this.orchestrator) { reply('编排运行时不可用，问题与任务已保留。'); return; }
          if (task.status !== 'waiting_input' || this.active.has(task.id) || !body) { reply('请等待问题保存完成，并填写回答。'); return; }
          if (task.project !== CONVERSATION && !this.config.projects[task.project]) { reply('项目授权已撤销，任务尚未继续。'); return; }
          this.store.answerGraph(task.id,body);
          reply('收到，我会结合这条补充继续处理。',{kind:'reply',taskId:task.id}); return;
        }
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
        reply(message.conversation && req.kind === 'input' ? '收到，我继续。' : `请求 ${id} 已回答。`, { kind: message.conversation && req.kind === 'input' ? 'reply' : 'task', taskId: task.id }); return;
      }
      const task = this.store.get(id);
      if (!task || task.chatId !== message.chatId || (message.conversation && task.conversation?.anchorId !== message.conversation.anchorId)) { reply('任务不存在，请重新选择。', { kind: 'home' }); return; }
      if (bound && bound.id !== task.id && !['/status', '/source'].includes(command)) { reply('这个话题已转到另一个项目，请直接在话题里说明当前需求。'); return; }
      if (command === '/baseline' || command === '/restart') {
        if (this.active.has(id) || !['review','completed','failed','cancelled','interrupted'].includes(task.status)) { reply('请等任务结束或停止后再更换版本。'); return; }
        if (this.config.projects[task.project]?.workspaceMode === 'direct' || !this.store.workspace(id) || !this.config.projects[task.project]?.worktree) { reply('这个任务没有 Git 工作副本。'); return; }
        if (command === '/baseline') { reply('选择从哪个代码版本继续。', { kind: 'baseline', taskId: id, fresh: true }); return; }
        if (!validBaseRef(body)) { reply('请填写明确的 Git 分支或提交 SHA。'); return; }
        this.store.queueBaseline(id, body);
        if (message.conversation) this.store.saveConversation(id, message.conversation);
        return;
      }
      if (command === '/source') { reply(codeSourceDetails(this.store.delivery(id), this.config.projects[task.project], !!message.conversation), { kind: 'source', taskId: id, fresh: true }); return; }
      if (command === '/merge') {
        if (this.active.has(id) || !['review','completed','failed','cancelled','interrupted'].includes(task.status)) {reply('请等当前执行结束后再合并。');return;}
        const project=this.config.projects[task.project];
        if(task.mode!=='workspace-write'||project?.sandbox!=='workspace-write'){reply('该任务没有修改项目的授权。');return;}
        if(project.workspaceMode==='direct'){reply('直接编辑项目的任务不提供自动 PR 合并，请在 Git 工具中处理。');return;}
        const url=body||this.store.delivery(id)?.prUrl;
        if(!url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url)){reply('请提供要合并的 PR 链接，例如“合并 PR https://github.com/组织/仓库/pull/123”。我会先核对版本和检查结果，再请你确认。');return;}
        this.store.queueMerge(id,url);
        if(message.conversation)this.store.saveConversation(id,message.conversation);
        reply('我先核对 PR 的提交、目标分支和检查结果，确认后再代你合并。',{kind:'reply',taskId:id});return;
      }
      if (command === '/publish') { reply('请先查看交付预览，再明确创建草稿 PR。', { kind: 'publication', taskId: id, fresh: true }); return; }
      if (command === '/status') {
        const requests = this.store.requests(id).map(r => `待处理请求：${r.id} · ${r.kind}`).join('\n');
        reply(`${id} · ${task.project} · ${task.status}\n${task.result ?? this.store.latestProgress(id)}\n${requests}`, { kind: 'task', taskId: id, fresh: true }); return;
      }
      if (command === '/cancel') {
        if (!['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.status)) {
          reply('任务当前未在执行。'); return;
        }
        this.store.set(id, 'cancelled'); this.store.expire(id, false);
        publishSubmissionResult(this.store,this.config,task,'主人已停止这次任务。');
        effects.push(() => { if (this.active.has(id)) this.active.get(id)?.abort.abort(); });
        reply(`任务 ${id} 已取消；已有文件修改保留。`, { kind: 'task', taskId: id }); return;
      }
      if (command === '/continue') {
        if (this.active.has(id) || !['review', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
          reply('请等当前执行结束后再继续，或先 /cancel。'); return;
        }
        if (task.project !== CONVERSATION && !this.config.projects[task.project]) { reply('原项目已不在已授权的 Codex 项目中，请重新选择或授权；原任务记录和文件保留。'); return; }
        if (!body) { reply(`用法：/continue ${id} <后续要求>`); return; }
        this.store.resume(id, body);
        if (message.conversation) this.store.saveConversation(id, message.conversation);
        if (!message.conversation || !this.channel.acknowledge) reply(`任务 ${id} 已重新排队。`, { kind: 'task', taskId: id }); return;
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
    if (saved && ['accept-submission','reject-submission'].includes(saved.intent.op)) {
      const id = saved.intent.submissionId;
      if (!id || saved.used || saved.expires < Date.now() || saved.intent.conversation
        || (saved.chatId !== action.chatId && (saved.chatId !== this.config.ownerId
          || this.store.cardMessage(saved.chatId,`submission:${id}`) !== action.messageId))) return fail('申请卡片已失效，请私聊发送 /requests。');
      try {
        this.store.transaction(() => {
          if (!this.store.consume('card:'+action.id) || !this.store.useAction(action.actionId)) throw Error('申请已处理。');
          decideSubmission(this.store,this.config,id,action.chatId,saved.intent.op === 'accept-submission');
          this.store.enqueue(action.chatId,'申请已处理',{kind:'submission',submissionId:id,targetMessageId:action.messageId});
        });
      } catch (error) { return fail(error instanceof Error ? error.message : '申请处理失败'); }
      this.tick();void this.flush();return {toast:{type:'success',content:'已处理这次申请'}};
    }
    if (!saved || saved.chatId !== action.chatId || saved.expires < Date.now() || saved.used) {
      return fail('操作已处理或已过期。请发送“工作台”重新打开。');
    }
    const i = saved.intent, task = i.taskId ? this.store.get(i.taskId) : undefined;
    if (i.conversation && !this.config.groupChats) return fail('群聊功能已关闭。');
    if (i.op === 'new' && i.conversation && this.store.conversationTask(action.chatId, i.conversation)) return fail('此话题已绑定任务，请继续原任务；新任务请另起话题。');
    if (i.taskId && (!task || task.chatId !== action.chatId)) return fail('任务不属于当前会话。');
    const current = i.conversation && this.store.conversationTask(action.chatId, i.conversation);
    if (task && current && task.id !== current.id && ['dispatch','continue','done','cancel','approve','deny','answer','publish','restart'].includes(i.op)) return fail('话题已转到另一个项目，旧操作已失效。');
    if (i.op === 'dispatch') {
      const p = i.project && this.config.projects[i.project];
      if (!p || !i.prompt || !i.selectionKey || i.prompt.length > 16000) return fail('该项目已撤销授权，请重新派活。');
      if (current && (!task || current.id !== task.id || i.revision !== task.updatedAt
        || this.active.has(task.id) || !['review','completed','failed','cancelled','interrupted'].includes(task.status))) return fail('话题状态已变化，请在话题里继续说明需求。');
      if (i.taskId && !current) return fail('原话题已失效，请重新选择。');
      this.receive({ id: 'choice:' + i.selectionKey, senderId: action.senderId, senderType: 'user', chatId: action.chatId,
        chatType: i.conversation ? 'group' : 'p2p', botMentioned: !!i.conversation, conversation: i.conversation,
        text: `${p.naturalMode === 'workspace-write' ? '/edit' : '/new'} ${i.project} ${i.prompt}` }, action.actionId);
      return { toast: { type: 'success', content: '收到，开始处理。' } };
    }
    const mutating = ['new', 'continue', 'done', 'cancel', 'approve', 'deny', 'answer', 'publish', 'restart'].includes(i.op);
    if (mutating && task && i.revision !== task.updatedAt) return fail('任务状态已变化，请刷新后再操作。');
    const body = typeof action.fields.body === 'string' ? action.fields.body.trim() : '';
    if (['new', 'continue', 'answer', 'restart'].includes(i.op) && (!body || body.length > 1000)) return fail('请填写 1–1000 字的内容。');
    if (i.op === 'new' && (typeof action.fields.project !== 'string' || (action.fields.project !== CONVERSATION && !Object.hasOwn(this.config.projects, action.fields.project)))) {
      return fail('请选择通用任务或已授权的代码资源。');
    }
    if (i.op === 'new') {
      if (action.fields.mode !== undefined && !['read-only', 'workspace-write'].includes(String(action.fields.mode))) return fail('请选择有效的工作模式。');
      const project = this.config.projects[String(action.fields.project)];
      if (action.fields.mode === 'workspace-write' && (project?.sandbox !== 'workspace-write' || (!project?.worktree && project?.workspaceMode !== 'direct'))) return fail('请先选择已授权且支持修改的代码资源。');
    }
    if (i.op === 'publish') {
      if (!task || this.active.has(task.id) || !['review', 'completed', 'failed'].includes(task.status)
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
    if (['continue', 'followup', 'baseline', 'restart'].includes(i.op) && ((!!task && this.active.has(task.id)) ||
      !['review', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task?.status ?? ''))) return fail('请等当前执行结束后继续。');
    if (i.op === 'cancel' && !['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task?.status ?? '')) return fail('任务已经停止。');
    if (['approve', 'deny', 'answer'].includes(i.op)) {
      const req = this.store.getRequest(i.requestId ?? ''), runtime = this.pending.get(i.requestId ?? '');
      const business = task && this.store.graphWait(task.id);
      const operation = task && currentOperation(this.store, task.id);
      const operationWait = !!operation && ['approve','deny'].includes(i.op) && operation.requestId === i.requestId
        && operation.state === 'pending' && operation.expiresAt > Date.now() && operation.scope.ownerId === action.senderId
        && task?.status === 'waiting_approval' && task.nextAction === 'merge' && !this.active.has(task.id);
      const durable = i.op === 'answer' && req?.kind === 'input' && business?.requestId === i.requestId && !!this.orchestrator && task?.status === 'waiting_input';
      if (!req || req.taskId !== task?.id || req.status !== 'pending' || (!runtime && !durable && !operationWait) ||
        (req.kind === 'input') !== (i.op === 'answer')) return fail('该请求已失效，未执行任何授权。');
      try { runtime?.validate?.(i.op === 'answer' ? body : i.op === 'approve' ? 'accept' : 'decline'); }
      catch (e) { return fail(e instanceof Error ? e.message : '请检查输入。'); }
    }
    const views: Partial<Record<typeof i.op, View>> = {
      home: { kind: 'home' }, list: { kind: 'list', page: i.page },
      status: { kind: 'task', taskId: i.taskId! }, result: { kind: 'result', taskId: i.taskId!, page: i.page },
      followup: { kind: 'followup', taskId: i.taskId! },
      baseline: { kind: 'baseline', taskId: i.taskId! }, source: { kind: 'source', taskId: i.taskId! },
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
  private refreshTaskCard(task: Task): void {
    const view: View = {kind:'task', taskId:task.id, conversation:task.conversation};
    const targetMessageId = this.store.cardMessage(task.chatId, viewKey(view));
    // Patch only the existing task card; the ordinary reply supplies notification.
    // Never replace a card the owner has navigated into another view.
    if (targetMessageId) this.store.enqueue(task.chatId, '', {...view,targetMessageId});
  }
  private updateWaiting(id: string): void {
    const remaining = this.store.requests(id);
    const status: Status = remaining.some(r => r.kind === 'approval') ? 'waiting_approval'
      : remaining.length ? 'waiting_input' : 'running';
    this.store.set(id, status);
  }
  private canDispatch(task: Task): boolean {
    if (this.active.size >= (this.config.maxConcurrentTasks ?? 2) || this.active.has(task.id)) return false;
    for (const run of this.active.values()) {
      // Keep all code/Git actions serial; general read-only conversations may overlap them.
      if (task.project !== CONVERSATION && run.task.project !== CONVERSATION) return false;
      if (task.conversation && run.task.conversation && task.chatId === run.task.chatId
        && task.conversation.anchorId === run.task.conversation.anchorId) return false;
      if (task.threadId && task.threadId === this.store.get(run.task.id)?.threadId) return false;
    }
    return true;
  }
  private tick(): void {
    if (this.stopped) return;
    for (const id of this.store.transaction(() => revokeSubmissions(this.store,this.config))) this.active.get(id)?.abort.abort(new Error('来访者授权已撤销'));
    this.store.expireOperations();
    const queued = this.store.list().filter(t => t.status === 'queued').sort((a,b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const candidate of queued) {
      if (!this.canDispatch(candidate)) {
        if (candidate.conversation && this.channel.acknowledge) {
          const notified = this.store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='queue_wait' ORDER BY seq DESC LIMIT 1").get(candidate.id) as {body:string} | undefined;
          if (notified?.body !== candidate.updatedAt) this.store.transaction(() => {
            this.store.event(candidate.id,'queue_wait',candidate.updatedAt);
            this.store.enqueue(candidate.chatId,'已收到，任务正在排队；有执行名额后会自动继续，无需重复发送。',{kind:'reply',taskId:candidate.id});
          });
        }
        continue;
      }
      const task = { ...candidate, permissionMode: candidate.requesterId ? 'ask' as const : permissionMode(this.config), modelSelection: this.config.modelSelection ? {...this.config.modelSelection} : undefined };
      const abort = new AbortController();
      this.store.set(task.id, 'running');
      if (!task.conversation || !this.channel.acknowledge) this.store.enqueue(task.chatId, `开始执行 ${task.id} · ${task.project === CONVERSATION ? '对话' : task.project}`, { kind: 'task', taskId: task.id });
      // Register before invoking an adapter; each task owns its abort and completion.
      const done = Promise.resolve().then(() => this.run(task, abort));
      this.active.set(task.id,{ task, abort, done });
    }
  }
  private async run(task: Task, abort: AbortController): Promise<void> {
    const timeout = setTimeout(() => abort.abort(new Error('执行超过配置时限')), this.config.maxRunMinutes * 60_000);
    let snapshot: ContextSnapshot | undefined;
    try {
      abort.signal.throwIfAborted();
      if (task.requesterId && (!requesterAllowed(this.config,task.requesterId) || task.project !== CONVERSATION || task.mode !== 'read-only' || task.nextAction !== 'execute')) throw Error('来访者任务仅允许经确认的通用只读执行。');
      this.store.event(task.id, 'permission_mode', task.permissionMode ?? 'ask');
      if (task.modelSelection) this.store.event(task.id, 'model_selection', JSON.stringify(task.modelSelection));
      if (!task.nextAction || task.nextAction === 'execute') this.store.event(task.id,'runtime_model',JSON.stringify({model:null,effort:null}));
      const project = task.project === CONVERSATION ? conversationProject(this.config,task.requesterId ? task.id : undefined) : this.config.projects[task.project];
      if (!project) throw new Error('项目配置已移除。');
      const directDirectory = this.store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='direct_directory' ORDER BY seq LIMIT 1").get(task.id) as {body:string}|undefined;
      if ((project.workspaceMode === 'direct' && this.store.workspace(task.id)) || (directDirectory && (project.workspaceMode !== 'direct' || project.path !== directDirectory.body))) throw Error('任务执行位置已变化，请新建任务；原任务改动保留。');
      if (project.workspaceMode === 'direct' && task.nextAction && task.nextAction !== 'execute') throw Error('直接编辑项目不支持独立副本的交付或版本操作。');
      const previousReport = this.store.delivery(task.id);
      let proposed: {project: string; grantKey: string} | undefined;
      let publication: PublicationTarget | undefined;
      let baseline: BaselineProposal | undefined;
      let merge: MergeProposal | undefined;
      const grantKey = projectGrantKey(project);
      const resources = task.requesterId ? [] : Object.entries(this.config.projects);
      const resourceCatalog = resources.map(([id,p]) => ({id,kind:'code-project',name:p.label ?? id,aliases:[...(p.aliases ?? [])],description:p.description ?? '',capability:p.sandbox}));
      const resourceGrants = Object.fromEntries(resources.map(([id,p]) => [id,projectGrantKey(p)]));
      const hooks: RunHooks = {
        ...(task.nextAction==='merge'?{approveOperation:proposal=>{abort.signal.throwIfAborted();approveOperation(this.store,task.id,proposal);}}:{}),
        ...(task.project !== CONVERSATION && task.mode === 'workspace-write' && project.sandbox === 'workspace-write' && project.workspaceMode !== 'direct'
          && (!task.nextAction || task.nextAction === 'execute') ? {proposeMerge:(request:MergeProposal)=>{
            abort.signal.throwIfAborted();merge=parseMergeProposal(request);
          }} : {}),
        modelResolved: model => {
          abort.signal.throwIfAborted();
          this.store.event(task.id,'runtime_model',JSON.stringify(model));
        },
        ...(task.project !== CONVERSATION && task.mode === 'workspace-write' && project.sandbox === 'workspace-write' && project.workspaceMode !== 'direct' && project.worktree
          && (!task.nextAction || task.nextAction === 'execute') ? {proposeBaseline:(request:BaselineProposal)=>{
            abort.signal.throwIfAborted();baseline=parseBaselineProposal(request);
          }} : {}),
        ...(task.project !== CONVERSATION && task.mode === 'workspace-write' && project.sandbox === 'workspace-write' && project.workspaceMode !== 'direct'
          && (!task.nextAction || task.nextAction === 'execute') ? { proposePublication: (target: PublicationTarget) => {
            abort.signal.throwIfAborted();
            publication = { ...target };
          } } : {}),
        ...(task.project === CONVERSATION && !task.requesterId ? { proposeProject: (id: string) => {
          abort.signal.throwIfAborted();
          const candidate = this.config.projects[id];
          if (!Object.hasOwn(this.config.projects,id) || !Object.hasOwn(resourceGrants,id)) throw new Error('提议的项目不在已授权列表中。');
          if (projectGrantKey(candidate) !== resourceGrants[id]) throw Error('代码资源授权在本轮发生变化，请重新确认任务。');
          proposed = {project:id,grantKey:projectGrantKey(candidate)};
        } } : {}),
        prepared: report => {
          abort.signal.throwIfAborted();
          if (!codeSourceChanged(previousReport, report)) return;
          this.store.enqueue(task.chatId, codeSourceReceipt(project.label ?? task.project, report), { kind: 'reply', taskId: task.id });
          void this.flush();
        },
        thread: id => this.store.thread(task.id, id),
        progress: text => this.store.event(task.id, 'progress', text.slice(0, 8000)),
        request: req => {
          if (abort.signal.aborted) throw new Error('任务已停止');
          const id = this.store.request(task.id, req.kind, req.description);
          this.pending.set(id, req); this.updateWaiting(task.id);
          if (task.conversation && req.kind === 'input' && !req.explicit) this.store.enqueue(task.chatId, req.description, { kind: 'reply', taskId: task.id });
          else this.store.enqueue(task.chatId, `任务 ${task.id} 需要你处理 · 请求 ${id}\n${req.description}\n`
            + (req.kind === 'approval' ? `/approve ${id} 或 /deny ${id}` : `/answer ${id} <回答>`), { kind: 'task', taskId: task.id });
          return id;
        },
        resolved: id => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id); this.store.resolveRequest(id, 'expired');
          if (!abort.signal.aborted) this.updateWaiting(task.id);
        },
      };
      if (task.nextAction === 'merge') {
        const result=await this.mergeRunner(this.store,this.config,task,project,hooks,abort.signal);
        abort.signal.throwIfAborted();this.store.transaction(() => {
          this.store.set(task.id,'review',result);
          this.refreshTaskCard(task);
        });
        this.store.enqueue(task.chatId,result,{kind:'reply',taskId:task.id});return;
      }
      if (task.nextAction === 'baseline') {
        const preview = await baselinePreview(this.store, task, project, task.baselineRef ?? '', abort.signal, this.config);
        const accepted = await new Promise<boolean>((resolve, reject) => {
          const cancelled = () => reject(abort.signal.reason ?? Error('已取消'));
          abort.signal.addEventListener('abort', cancelled, { once: true });
          hooks.request({ kind: 'approval', description: preview.description, resolve: answer => {
            abort.signal.removeEventListener('abort', cancelled); resolve(answer === 'accept');
          } });
        });
        abort.signal.throwIfAborted();
        if (accepted) await restartAtBaseline(this.store, this.config, task, preview, abort.signal);
        else {
          this.store.set(task.id, 'review');
          this.store.enqueue(task.chatId, '未更换代码版本，原任务和文件保持原样。', { kind: task.conversation ? 'reply' : 'task', taskId: task.id });
        }
        return;
      }
      if (task.conversation && task.nextAction !== 'publish' && this.channel.acknowledge) {
        try { await this.channel.acknowledge(task, abort.signal); }
        catch {
          abort.signal.throwIfAborted();
          this.store.event(task.id, 'acknowledgement_failed', '表情回复不可用，已改用话题文字回执。');
          this.store.enqueue(task.chatId, '收到，正在处理。', { kind: 'notice', conversation: task.conversation, fresh: true });
        }
      }
      abort.signal.throwIfAborted();
      let executionTask = task;
      if (task.conversation && task.nextAction !== 'publish') {
        if (!this.config.groupChats || !this.channel.context) throw new Error('群上下文读取未启用，任务未执行。');
        this.store.event(task.id, 'progress', '正在读取当前会话上下文。');
        snapshot = await this.channel.context(task, abort.signal);
        abort.signal.throwIfAborted();
        this.store.saveContext(task.id, snapshot); this.store.event(task.id, 'context_loaded', snapshot.summary);
        executionTask = { ...task, contextSnapshot: snapshot };
      }
      executionTask = { ...executionTask, projectCandidates: hooks.proposeProject ? Object.keys(resourceGrants) : undefined,
        projectCandidateGrants: hooks.proposeProject ? resourceGrants : undefined,
        routingContext: JSON.stringify({ currentProject: task.project === CONVERSATION ? null : project.label ?? task.project,
        resources: task.resources ?? [],
        resourcePolicy: 'Tasks need no space by default. Propose a code project only when completing the goal requires its files. Business wording and named products alone do not require code access.',
        workflow: {availableOperations:[...(hooks.proposePublication ? ['publication'] : []),...(hooks.proposeBaseline ? ['baseline'] : []),...(hooks.proposeMerge ? ['merge_preview'] : [])],
          currentPr:previousReport?.prUrl ?? null,publishedSha:previousReport?.publishedSha ?? null,
          deliveryError:previousReport?.error ?? null,configuredTarget:project.worktree?.github ?? null,
          history:this.store.workflowHistory(task.id),
          approval:'Proposals only; each external operation retains its own owner confirmation.'},
        availableProjects: resourceCatalog }) };
      let result: string;
      if (task.orchestration === 'langgraph-v1' && task.nextAction !== 'publish') {
        if (!this.orchestrator) throw Error('编排运行时不可用；任务已保留，不会通过旧运行时重放。');
        const outcome = await this.orchestrator.run(executionTask,project,this.executor,hooks,abort.signal);
        abort.signal.throwIfAborted();
        if (outcome.waiting) {
          this.store.transaction(() => {
            this.store.graphQuestion(task.id,outcome.step,outcome.question);
            const s = task.submissionId && submission(this.store,task.submissionId);
            if (s && requesterAllowed(this.config,s.requesterId)) replyToRequester(this.store,s,`${outcome.question}\n\n请在原会话补充文字，群聊中请 @机器人；主人确认后继续。`);
          });
          return;
        }
        result = outcome.message;
      } else result = await this.executor.run(executionTask, project, hooks, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      let automaticallySelected: string | undefined;
      if (proposed) {
        const candidate = this.config.projects[proposed.project];
        if (!candidate || projectGrantKey(candidate) !== proposed.grantKey) throw new Error('项目授权已变化，请重新选择项目。');
        const explicit = namedProjects(this.config,this.store.ownerRequirements(task.id));
        if (explicit.length === 1 && explicit[0] === proposed.project) automaticallySelected = proposed.project;
        else result = `${result}\n\n这次使用 ${candidate.label ?? proposed.project} 代码资源处理，对吗？回复“对的”即可分配工作区并继续，也可以直接告诉我其他项目名称。`;
      }
      const report = this.store.delivery(task.id);
      if ([!!proposed,!!publication,!!baseline,!!merge].filter(Boolean).length > 1) throw Error('每轮只能提议一个 Steward 操作。');
      if ((publication || baseline || merge) && (!this.config.projects[task.project] || projectGrantKey(this.config.projects[task.project]) !== grantKey)) {
        throw new Error('项目交付配置已变化，请按当前配置重新准备 PR。');
      }
      const evidence = report ? `\n\n${deliveryFooter(report, project)}` : '';
      this.store.transaction(() => {
        this.store.set(task.id, 'review', result);
        publishSubmissionResult(this.store,this.config,task,result);
        if (automaticallySelected) {
          const selected = this.config.projects[automaticallySelected], mode = selected.naturalMode ?? 'read-only';
          if (mode === 'workspace-write' && (selected.sandbox !== mode || (!selected.worktree && selected.workspaceMode !== 'direct'))) throw Error('该代码资源没有可用的修改工作目录。');
          const next = this.store.handoff(this.store.get(task.id)!,automaticallySelected,
            `${this.store.ownerRequirements(task.id)}\n\n模型判断需要使用主人已明确指定的代码资源：${selected.label ?? automaticallySelected}`,mode,task.conversation);
          this.store.event(next.id,'resource_bound',JSON.stringify({fromTaskId:task.id,resource:{kind:'code-project',id:automaticallySelected},source:'owner-named-model-proposal'}));
          this.store.enqueue(task.chatId,`本任务需要使用你指定的 ${selected.label ?? automaticallySelected} 代码资源，正在准备执行目录并继续。`,{kind:'reply',taskId:next.id});
        } else if (proposed) this.store.saveProjectSelection(task.id, proposed.project, proposed.grantKey);
        if (task.conversation) this.store.enqueue(task.chatId, result + (report && task.mode === 'workspace-write' ? evidence : ''), {kind:'reply',taskId:task.id});
        if (baseline) {
          this.store.event(task.id,'baseline_proposed',JSON.stringify(baseline));
          this.store.queueBaseline(task.id,baseline.ref,{migrateChanges:baseline.migrateChanges,delivery:baseline.delivery});
        } else if (merge) {
          const url = merge.url || previousReport?.prUrl;
          this.store.event(task.id,'merge_proposed',JSON.stringify({url:url ?? null}));
          if (!url) this.store.enqueue(task.chatId,'当前任务还没有已记录的 PR。请指出要处理的 PR，或先交付当前改动。',{kind:'reply',taskId:task.id});
          else this.store.queueMerge(task.id,url);
        } else if (publication) {
          // A semantic proposal opens a preview only; it never writes an authorization key.
          const target = project.worktree?.github;
          const publicationTarget = { repository: publication.repository || target?.repository || '',
            baseBranch: publication.baseBranch || target?.baseBranch || '' };
          this.store.event(task.id, 'publication_proposed', JSON.stringify(publicationTarget));
          this.store.enqueue(task.chatId, publicationBlocker(task, project, report, publicationTarget) ?? '已接到 PR 交付请求，请核对交付预览。',
            {kind:'publication',taskId:task.id,fresh:true,publicationTarget});
        }
      });
      if (!task.conversation) this.store.enqueue(task.chatId, `任务 ${task.id} 已产出结果，等待你验收（执行器报告，尚非独立验证）。\n${result}${evidence}\n`
        + `验收：/done ${task.id}\n继续：/continue ${task.id} <要求>`, { kind: 'task', taskId: task.id });
      if (task.nextAction !== 'publish' && report?.evidenceIds?.length) this.store.enqueue(task.chatId, '验收截图（执行 Agent 提供）', { kind:'evidence', taskId:task.id, evidenceIds:report.evidenceIds });
      if (report?.evidenceWarning) this.store.enqueue(task.chatId, report.evidenceWarning, {kind:'reply', taskId:task.id});
    } catch (error) {
      if(error instanceof OperationWaiting)return;
      if(task.nextAction==='merge')operationFailure(this.store,task.id,error instanceof Error?error.message:'操作失败');
      const state = this.store.get(task.id)?.status;
      if (state !== 'cancelled' && !abort.signal.aborted && task.nextAction === 'publish' && error instanceof TargetBranchMoved) {
        // No Git mutation has occurred. Preserve the implementation result and checks,
        // and prepare a migration proposal; a fresh owner decision is still required.
        this.store.transaction(() => {
          this.store.event(task.id,'publication_blocked',error.message);
          this.store.set(task.id,'review');
          this.store.enqueue(task.chatId, `${error.message}\n代码改动、检查记录和截图保留；本次尚未提交或推送。接下来会展示迁移现有改动到最新基准的确认预览，确认后才建立新副本并重新验证。`, {kind:'reply',taskId:task.id});
          this.store.queueBaseline(task.id,error.ref,{migrateChanges:true,delivery:null});
        });
        return;
      }
      if (state !== 'cancelled') {
        const reason = error instanceof Error ? error.message : '执行失败';
        this.store.set(task.id, this.stopped ? 'interrupted' : 'failed', task.nextAction === 'publish' ? undefined : reason);
        this.store.transaction(() => publishSubmissionResult(this.store,this.config,task,'这次任务未完成，已通知主人检查。可稍后在原会话提交文字补充。'));
        if(task.nextAction === 'publish')this.store.event(task.id,'publication_failed',reason);
        if (task.nextAction === 'merge') this.refreshTaskCard(task);
        if (task.conversation) this.store.enqueue(task.chatId, `${task.nextAction === 'publish' ? 'PR 发布未完成，已有代码结果保留' : '这次没能完成'}：${reason}\n你可以引用回复这条消息，或 @我补充要求，我会接着处理。`, { kind: 'reply', taskId: task.id });
        else this.store.enqueue(task.chatId, `任务 ${task.id} ${this.stopped ? '已中断' : '失败'}：${reason}\n`
          + `不会自动重试已发生的操作。检查后用 /continue ${task.id} <要求> 继续。`, { kind: 'task', taskId: task.id });
      }
    } finally {
      clearTimeout(timeout);
      const pendingFollowups = this.store.pendingFollowups(task.id);
      if (pendingFollowups.length) this.store.enqueue(task.chatId, `还有 ${pendingFollowups.length} 条执行期间收到的补充尚未处理，已保存。继续任务时会一并带入；操作确认卡不会代为处理这些补充。`, {kind:'reply',taskId:task.id});
      if (snapshot && this.channel.releaseContext) {
        try { await this.channel.releaseContext(snapshot); }
        catch { this.store.event(task.id, 'media_cleanup_failed', '本次附件临时目录未能清理。'); }
      }
      for (const id of this.pending.keys()) {
        if (this.store.getRequest(id)?.taskId === task.id) this.pending.delete(id);
      }
      this.store.expire(task.id); this.active.delete(task.id);
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
        try {
          const view = item.view ? JSON.parse(item.view) as View : undefined;
          if (view?.requesterId && (!requesterAllowed(this.config,view.requesterId) || (view.conversation && !this.config.groupChats))) { this.store.delivered(item.id);continue; }
          await this.channel.send(item.chatId, item.text, item.id, view); this.store.delivered(item.id);
        }
        catch { this.store.retry(item.id, item.attempts); }
      }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    const runs = [...this.active.values()];
    for (const run of runs) run.abort.abort(new Error('服务停止'));
    await Promise.all(runs.map(run => run.done));
    await this.flush();
    this.orchestrator?.close(); this.orchestrator = undefined;
  }
}
