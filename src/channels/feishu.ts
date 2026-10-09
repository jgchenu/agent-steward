import * as lark from '@larksuiteoapi/node-sdk';
import type { Channel, Incoming } from '../types.js';

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
  constructor(appId: string, appSecret: string) {
    const base = { appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error };
    this.client = new lark.Client(base);
    this.ws = new lark.WSClient(base);
  }
  async connect(receive: (message: Incoming) => void): Promise<void> {
    await this.ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const message = parseFeishuEvent(data);
        if (message) receive(message); // No model/network work on the acknowledgement path.
      },
    }) });
  }
  async send(chatId: string, text: string, deliveryId: string): Promise<void> {
    const result = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: deliveryId } });
    if (result.code !== 0) throw new Error(`Feishu delivery error ${result.code}`);
  }
  close(): void { this.ws.close(); }
}
