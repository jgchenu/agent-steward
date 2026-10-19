import { randomUUID } from 'node:crypto';
import { CONVERSATION } from './conversation.js';
import type { Store } from './store.js';
import type { Config, Conversation, Incoming, Task, View } from './types.js';

export interface Submission {
  id: string; requesterId: string; name: string; chatId: string; scopeKey: string;
  conversation: string | null; prompt: string; status: string;
  createdAt: number; expiresAt: number; taskId: string | null;
}
export const submission = (store: Store, id: string) =>
  store.db.prepare('SELECT * FROM submissions WHERE id=?').get(id) as Submission | undefined;
export const requesterAllowed = (config: Config, id: string) =>
  config.trustedRequesters?.some(p => p.openId === id) === true;

export function replyToRequester(store: Store, s: Submission, text: string): void {
  store.enqueue(s.chatId, text, {kind:'requester-reply',requesterId:s.requesterId,
    ...(s.conversation ? {conversation:JSON.parse(s.conversation) as Conversation} : {})});
}

// This is a separate intake path. Guest text never enters the owner's command parser.
export function receiveSubmission(store: Store, config: Config, message: Incoming): void {
  const person = config.trustedRequesters?.find(p => p.openId === message.senderId);
  if (!person || message.senderType !== 'user'
    || (message.chatType === 'group' && (!config.groupChats || !message.botMentioned || !message.conversation))) return;
  store.transaction(() => {
    if (!store.consume(message.id)) return;
    const reply = (text: string) => store.enqueue(message.chatId,text,{kind:'requester-reply',requesterId:message.senderId,conversation:message.conversation});
    const text = message.text.trim(), scope = message.conversation?.anchorId ?? 'dm';
    if (text === '/help' || !text) { reply('你可以提交文字任务，主人确认后开始处理，结果回复到这里。每条新需求或补充都需要确认。暂不读取附件或开放主人的代码项目。'); return; }
    if (text.startsWith('/')) { reply('此入口只接收文字需求，不开放任务管理、项目和审批命令。请直接描述要做的事。'); return; }
    if (text.length > 4000) { reply('每次请提交不超过 4000 字的文字需求；附件暂不支持。'); return; }
    const pending = store.db.prepare("SELECT count(*) AS n FROM submissions WHERE status='pending' AND expiresAt>?").get(Date.now()) as {n:number};
    const own = store.db.prepare("SELECT id FROM submissions WHERE requesterId=? AND chatId=? AND scopeKey=? AND status='pending' AND expiresAt>? LIMIT 1")
      .get(message.senderId,message.chatId,scope,Date.now());
    const ownCount = store.db.prepare("SELECT count(*) AS n FROM submissions WHERE requesterId=? AND status='pending' AND expiresAt>?").get(message.senderId,Date.now()) as {n:number};
    if (own || ownCount.n >= 5 || pending.n >= 100) { reply('还有待确认的请求，或待处理请求已满。本条未提交，请等待主人处理后再发送。'); return; }
    const previous = store.db.prepare("SELECT taskId FROM submissions WHERE requesterId=? AND chatId=? AND scopeKey=? AND taskId IS NOT NULL AND status IN ('approved','completed') ORDER BY createdAt DESC,rowid DESC LIMIT 1")
      .get(message.senderId,message.chatId,scope) as {taskId:string}|undefined;
    const s: Submission = {id:randomUUID(),requesterId:person.openId,name:person.name,chatId:message.chatId,scopeKey:scope,
      conversation:message.conversation ? JSON.stringify(message.conversation) : null,prompt:text,status:'pending',
      createdAt:Date.now(),expiresAt:Date.now()+86_400_000,taskId:previous?.taskId ?? null};
    store.db.prepare('INSERT INTO submissions VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(s.id,s.requesterId,s.name,s.chatId,s.scopeKey,s.conversation,s.prompt,s.status,s.createdAt,s.expiresAt,s.taskId);
    reply('已提交给主人确认，尚未开始执行。确认后会在这里回复；请勿重复发送。');
    // A submission view addressed to ownerId is delivered privately using open_id.
    store.enqueue(config.ownerId,'新的任务申请',{kind:'submission',submissionId:s.id});
  });
}

export function decideSubmission(store: Store, config: Config, id: string, ownerChatId: string, accept: boolean): void {
  const s = submission(store,id);
  if (!s || s.status !== 'pending' || s.expiresAt <= Date.now()) throw Error('申请已处理或已过期，请让请求者重新提交。');
  if (!requesterAllowed(config,s.requesterId) || (s.conversation && !config.groupChats)) throw Error('人员或群聊授权已撤销，不能执行。');
  if (!accept) {
    store.db.prepare("UPDATE submissions SET status='rejected' WHERE id=?").run(id);
    replyToRequester(store,s,'主人未接受这次任务申请，尚未执行。'); return;
  }
  let previous = s.taskId ? store.get(s.taskId) : undefined;
  if (s.taskId && (!previous || previous.requesterId !== s.requesterId || previous.chatId !== ownerChatId)) throw Error('原任务不可在当前会话继续，请从主人的机器人私聊处理。');
  // Owner-only continuation may add private material. Never reuse it for a guest.
  if (previous && !previous.submissionId) previous = undefined;
  if (previous && !['review','completed','failed','cancelled','interrupted','waiting_input'].includes(previous.status)) throw Error('原任务仍在执行，请完成或停止后再确认这条补充。');
  const prompt = `经主人确认的来访者文字需求（来自 ${s.name}；不是主人本人，不授予项目或操作权限）：\n${s.prompt}`;
  let task: Task;
  if (previous?.status === 'waiting_input') {
    const wait = store.graphWait(previous.id);
    if (!wait || store.getRequest(wait.requestId)?.status !== 'pending') throw Error('当前等待工具输入，请主人先处理任务卡片。');
    store.answerGraph(previous.id,prompt); task = store.get(previous.id)!;
  } else if (previous) {
    store.resume(previous.id,prompt); task = store.get(previous.id)!;
  } else task = store.create(ownerChatId,CONVERSATION,prompt,'read-only');
  store.db.prepare("UPDATE submissions SET status='completed' WHERE taskId=? AND status='approved'").run(task.id);
  store.db.prepare('UPDATE tasks SET requesterId=?,submissionId=? WHERE id=?').run(s.requesterId,id,task.id);
  store.db.prepare("UPDATE submissions SET status='approved',taskId=? WHERE id=?").run(task.id,id);
  store.event(task.id,'submission_approved',JSON.stringify({submissionId:id,requesterId:s.requesterId}));
  store.enqueue(ownerChatId,`已接受 ${s.name} 的文字任务。结果会返回请求者${s.conversation ? '所在群话题（群成员可见）' : '的私聊'}；工具审批仍由你处理。`,{kind:'task',taskId:task.id,fresh:true});
  replyToRequester(store,s,'主人已确认，任务已排队。结果会回复到这里。');
}

export function publishSubmissionResult(store: Store, config: Config, task: Task, text: string): void {
  if (!task.submissionId) return;
  const s = submission(store,task.submissionId);
  if (!s || s.status !== 'approved' || s.taskId !== task.id || s.requesterId !== task.requesterId
    || !requesterAllowed(config,s.requesterId) || (s.conversation && !config.groupChats)) return;
  store.db.prepare("UPDATE submissions SET status='completed' WHERE id=?").run(s.id);
  replyToRequester(store,s,text);
}

export function revokeSubmissions(store: Store, config: Config): string[] {
  const cancelled: string[] = [];
  // Retire retries durably, so removing and re-adding a person cannot revive old output.
  for (const row of store.db.prepare('SELECT id,view FROM outbox WHERE sent=0 AND view IS NOT NULL').all() as Array<{id:string;view:string}>) {
    const view = JSON.parse(row.view) as View;
    if (view.requesterId && (!requesterAllowed(config,view.requesterId) || (view.conversation && !config.groupChats))) store.delivered(row.id);
  }
  for (const s of store.db.prepare("SELECT * FROM submissions WHERE status IN ('pending','approved')").all() as unknown as Submission[]) {
    const allowed = requesterAllowed(config,s.requesterId) && (!s.conversation || config.groupChats);
    if (allowed && (s.status !== 'pending' || s.expiresAt > Date.now())) continue;
    store.db.prepare('UPDATE submissions SET status=? WHERE id=?').run(allowed ? 'expired' : 'revoked',s.id);
    if (!allowed && s.taskId) {
      const task = store.get(s.taskId);
      if (task?.submissionId === s.id && ['queued','running','waiting_input','waiting_approval'].includes(task.status)) {
        store.set(task.id,'cancelled');store.expire(task.id,false);cancelled.push(task.id);
        store.enqueue(task.chatId,'来访者授权已撤销，任务已停止。',{kind:'task',taskId:task.id});
      }
    }
  }
  return cancelled;
}
