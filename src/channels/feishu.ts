import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type { CardAction, Channel, Config, Incoming, Task, View } from '../types.js';
import { messageText, readContext } from './context.js';
import { Store } from '../store.js';
import { buildCard, viewKey } from './cards.js';
import { readableFileReferences } from './file-references.js';

export function parseCardAction(data: any): CardAction | undefined {
  const value = data?.action?.value;
  const actionId = value?.actionId ?? data?.action?.name;
  const chatId = data?.context?.open_chat_id, senderId = data?.operator?.open_id;
  // Only IM cards are supported, never arbitrary host contexts or client-supplied commands.
  if (!['button', 'interactive_container'].includes(data?.action?.tag) || (data.host && data.host !== 'im_message') ||
    typeof actionId !== 'string' || !/^a[a-f0-9]{32}$/.test(actionId) ||
    typeof chatId !== 'string' || typeof senderId !== 'string' ||
    typeof data?.context?.open_message_id !== 'string' || typeof data.event_id !== 'string') return;
  const fields = data.action.form_value;
  return { id: data.event_id, senderId, chatId, actionId, messageId: data.context.open_message_id,
    fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {} };
}

export function parseFeishuEvent(data: any, botId?: string): Incoming | undefined {
  const message = data?.message, sender = data?.sender;
  if (!['text', 'post'].includes(message?.message_type) || !['p2p', 'group'].includes(message?.chat_type)
    || sender?.sender_type !== 'user' || (message.chat_type === 'group' && !botId)) return;
  const text = messageText(message.message_type, message.content);
  if (typeof text !== 'string' || typeof message.message_id !== 'string'
    || typeof message.chat_id !== 'string' || typeof sender?.sender_id?.open_id !== 'string') return;
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const botMentions = mentions.filter((m: any) => botId && m.id?.open_id === botId);
  let body = text;
  for (const mention of botMentions) if (typeof mention.key === 'string' && mention.key) body = body.split(mention.key).join('');
  const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
  return { id: message.message_id, senderId: sender.sender_id.open_id, chatId: message.chat_id,
    text: body.trim(), chatType: message.chat_type, senderType: 'user',
    botMentioned: botMentions.length > 0, mentionsOthers: mentions.some((m: any) => m.id?.open_id !== botId),
    ...(message.chat_type === 'group' ? { conversation: {
      anchorId: str(message.root_id) ?? message.message_id, sourceId: message.message_id,
      threadId: str(message.thread_id), parentId: str(message.parent_id),
      scope: message.root_id || message.thread_id ? 'thread' as const : 'chat' as const,
      cutoff: str(message.create_time) ?? String(Date.now()),
    } } : {}),
  };
}

export class FeishuChannel implements Channel {
  private client: lark.Client;
  private ws: lark.WSClient;
  private botId?: string;
  private appId: string;
  constructor(appId: string, appSecret: string, private store: Store, private config: Config) {
    this.appId = appId;
    // SDK errors may contain HTTP request configuration. Keep raw errors out of logs.
    const quiet = () => {};
    const base = { appId, appSecret, domain: lark.Domain.Feishu,
      logger: { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet } };
    this.client = new lark.Client(base);
    this.ws = new lark.WSClient(base);
  }
  async connect(receive: (message: Incoming) => void,
    action: (message: CardAction) => unknown): Promise<void> {
    if (this.config.groupChats) {
      try {
        const info = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info', timeout: 10_000 });
        if (info.code !== 0 || typeof info.bot?.open_id !== 'string') throw new Error('Unavailable');
        this.botId = info.bot.open_id;
      } catch { console.warn('Group intake disabled: unable to resolve bot identity. Private chat remains available.'); }
    }
    await this.ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const message = parseFeishuEvent(data, this.botId);
        if (message) receive(message); // No model/network work on the acknowledgement path.
      },
      'card.action.trigger': async (data: unknown) => {
        const message = parseCardAction(data);
        return message ? action(message) : { toast: { type: 'error', content: '无法识别操作，请重新打开工作台。' } };
      },
    }) });
  }
  async acknowledge(task: Task, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const source = task.conversation?.sourceId; if (!source) return;
    const key = `reaction:OnIt:${source}`;
    if (this.store.cardMessage(task.chatId, key)) return;
    const result = await this.client.request({ method: 'POST', url: `/open-apis/im/v1/messages/${encodeURIComponent(source)}/reactions`,
      data: { reaction_type: { emoji_type: 'OnIt' } }, timeout: 3000 });
    if (result.code !== 0 || !result.data?.reaction_id) throw new Error('Reaction unavailable');
    this.store.saveCardMessage(task.chatId, key, result.data.reaction_id);
    signal.throwIfAborted();
  }
  async context(task: Task, signal: AbortSignal) {
    return readContext(this.client.im.message, task, signal, [this.appId, this.botId ?? '']);
  }
  async send(chatId: string, text: string, deliveryId: string, view?: View): Promise<void> {
    const scopedTask = view && 'taskId' in view ? this.store.get(view.taskId) : undefined;
    if (view && scopedTask?.conversation) view = { ...view, conversation: scopedTask.conversation };
    if (view?.kind === 'reply' || (view?.kind === 'notice' && view.conversation)) {
      const workspace = scopedTask && this.store.workspace(scopedTask.id);
      const roots = [workspace?.path, workspace?.source, scopedTask && this.config.projects[scopedTask.project]?.path]
        .filter((path): path is string => typeof path === 'string');
      const chunks = replyChunks(readableFileReferences(text, roots));
      for (let i = 0; i < chunks.length; i++) {
        const key = `reply:${deliveryId}:${i}`;
        if (this.store.cardMessage(chatId, key)) continue;
        const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: chunks[i] }]] } });
        // Feishu accepts at most 50 characters, including for thread replies.
        const uuid = createHash('sha256').update(`${deliveryId}:${i}`).digest('hex').slice(0, 32);
        const result = view.conversation
          ? await this.client.im.message.reply({ path: { message_id: view.conversation.anchorId },
            data: { msg_type: 'post', content, uuid, reply_in_thread: true } })
          : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'post', content, uuid } });
        if (result.code !== 0 || !result.data?.message_id) throw new Error(`Feishu reply error ${result.code}`);
        this.store.saveCardMessage(chatId, key, result.data.message_id);
        if (scopedTask?.conversation) {
          this.store.bindConversation(chatId, result.data.message_id, scopedTask.id);
          if (result.data.thread_id) this.store.bindConversation(chatId, result.data.thread_id, scopedTask.id);
        }
      }
      return;
    }
    const content = JSON.stringify(buildCard(this.store, this.config, chatId, view, text));
    const key = view && viewKey(view);
    const existing = view?.targetMessageId ?? (view?.fresh
      ? this.store.cardMessage(chatId, `delivery:${deliveryId}`) : key && this.store.cardMessage(chatId, key));
    const task = view?.kind === 'task' ? this.store.get(view.taskId) : undefined;
    // Patches do not create an unread notification. Important transitions need one fresh card.
    const alertKey = task && ['review', 'waiting_approval', 'waiting_input', 'failed', 'interrupted'].includes(task.status)
      ? `alert:${task.id}:${task.updatedAt}` : undefined;
    const needsAlert = alertKey && !this.store.cardMessage(chatId, alertKey);
    if (existing && (view?.targetMessageId || view?.fresh || !needsAlert)) {
      const result = await this.client.im.message.patch({ path: { message_id: existing }, data: { content } });
      if (result.code !== 0) throw new Error(`Feishu card update error ${result.code}`);
      if (key) this.store.bindCardMessage(chatId, key, existing);
      return;
    }
    const result = view?.conversation
      ? await this.client.im.message.reply({ path: { message_id: view.conversation.anchorId },
        data: { msg_type: 'interactive', content, uuid: deliveryId, reply_in_thread: true } })
      : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content, uuid: deliveryId } });
    if (result.code !== 0) throw new Error(`Feishu delivery error ${result.code}`);
    if (scopedTask?.conversation && result.data?.message_id) {
      this.store.bindConversation(chatId, result.data.message_id, scopedTask.id);
      if (result.data.thread_id) this.store.bindConversation(chatId, result.data.thread_id, scopedTask.id);
    }
    if (key && result.data?.message_id) this.store.bindCardMessage(chatId, key, result.data.message_id);
    if (view?.fresh && result.data?.message_id) this.store.saveCardMessage(chatId, `delivery:${deliveryId}`, result.data.message_id);
    if (alertKey && result.data?.message_id) this.store.saveCardMessage(chatId, alertKey, result.data.message_id);
  }
  close(): void { this.ws.close(); }
}


// Preserve the complete answer in bounded post messages. Escape HTML-like mention syntax;
// remote images remain links, never automatically fetched or uploaded by this adapter.
export function replyChunks(text: string): string[] {
  const safe = text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片：$1]($2)');
  const chunks: string[] = []; let chunk = '', bytes = 0;
  for (const char of safe || '我处理完了，但没有收到可展示的正文。') {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + size > 12_000) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
