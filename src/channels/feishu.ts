import * as lark from '@larksuiteoapi/node-sdk';
import type { CardAction, Channel, Config, Incoming, View } from '../types.js';
import { Store } from '../store.js';
import { buildCard, viewKey } from './cards.js';

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

export function parseFeishuEvent(data: any): Incoming | undefined {
  const message = data?.message, sender = data?.sender;
  if (message?.message_type !== 'text' || message?.chat_type !== 'p2p' || sender?.sender_type !== 'user') return;
  let content;
  try { content = JSON.parse(message.content); } catch { return; }
  if (typeof content?.text !== 'string' || typeof message.message_id !== 'string'
    || typeof message.chat_id !== 'string' || typeof sender?.sender_id?.open_id !== 'string') return;
  return { id: message.message_id, senderId: sender.sender_id.open_id, chatId: message.chat_id,
    text: content.text, chatType: 'p2p', senderType: 'user' };
}

export class FeishuChannel implements Channel {
  private client: lark.Client;
  private ws: lark.WSClient;
  constructor(appId: string, appSecret: string, private store: Store, private config: Config) {
    // SDK errors may contain HTTP request configuration. Keep raw errors out of logs.
    const quiet = () => {};
    const base = { appId, appSecret, domain: lark.Domain.Feishu,
      logger: { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet } };
    this.client = new lark.Client(base);
    this.ws = new lark.WSClient(base);
  }
  async connect(receive: (message: Incoming) => void,
    action: (message: CardAction) => unknown): Promise<void> {
    await this.ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const message = parseFeishuEvent(data);
        if (message) receive(message); // No model/network work on the acknowledgement path.
      },
      'card.action.trigger': async (data: unknown) => {
        const message = parseCardAction(data);
        return message ? action(message) : { toast: { type: 'error', content: '无法识别操作，请重新打开工作台。' } };
      },
    }) });
  }
  async send(chatId: string, text: string, deliveryId: string, view?: View): Promise<void> {
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
    const result = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content, uuid: deliveryId } });
    if (result.code !== 0) throw new Error(`Feishu delivery error ${result.code}`);
    if (key && result.data?.message_id) this.store.bindCardMessage(chatId, key, result.data.message_id);
    if (view?.fresh && result.data?.message_id) this.store.saveCardMessage(chatId, `delivery:${deliveryId}`, result.data.message_id);
    if (alertKey && result.data?.message_id) this.store.saveCardMessage(chatId, alertKey, result.data.message_id);
  }
  close(): void { this.ws.close(); }
}
