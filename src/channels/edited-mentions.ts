import type { Incoming } from '../types.js';

// Feishu's receive event is not an edit subscription. Watch only recently observed,
// unhandled owner messages; never scan arbitrary chats or replay processed commands.
export class EditedMentionWatch {
  private candidates = new Map<string, { chatId: string; conversation: NonNullable<Incoming['conversation']>; expires: number }>();
  private running = false;
  private closed = false;
  private warned = false;
  constructor(private ownerId: string, private botId: string,
    private get: (id: string) => Promise<any>,
    private parse: (event: unknown, botId: string) => Incoming | undefined,
    private consumed: (id: string) => boolean,
    private receive: (message: Incoming) => void,
    private now = Date.now,
    private warn = () => console.warn('Edited-mention recovery unavailable: check message-read permission and connectivity.')) {}

  observe(message: Incoming): void {
    if (this.closed || message.chatType !== 'group' || message.senderType !== 'user'
      || !message.conversation || message.senderId !== this.ownerId || message.botMentioned || this.consumed(message.id)) return;
    if (this.candidates.has(message.id)) return; // Redelivery must not extend the window.
    if (this.candidates.size >= 100) this.candidates.delete(this.candidates.keys().next().value!);
    this.candidates.set(message.id, { chatId: message.chatId, conversation: { ...message.conversation }, expires: this.now() + 10 * 60_000 });
  }

  async poll(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      // Rotate candidates fairly; at most 20 sequential reads per tick, no overlap.
      for (const [id, candidate] of [...this.candidates].slice(0, 20)) {
        if (this.closed) break;
        this.candidates.delete(id);
        if (candidate.expires <= this.now() || this.consumed(id)) continue;
        this.candidates.set(id, candidate);
        try {
          const result = await this.get(id);
          if (this.closed) break;
          if (result?.code !== 0) throw new Error('Message read failed');
          const item = result.data?.items?.find((m: any) => m.message_id === id);
          if (!item || item.deleted || item.chat_id !== candidate.chatId
            || item.sender?.sender_type !== 'user' || item.sender?.id !== this.ownerId
            || item.sender?.id_type !== 'open_id') {
            this.candidates.delete(id); continue;
          }
          const original = candidate.conversation;
          if ((item.root_id || id) !== original.anchorId || (original.threadId && item.thread_id !== original.threadId)
            || (item.parent_id || undefined) !== original.parentId) { this.candidates.delete(id); continue; }
          const message = this.parse({ sender: { sender_type: 'user', sender_id: { open_id: item.sender.id } },
            message: { ...item, chat_type: 'group', message_type: item.msg_type, content: item.body?.content,
              create_time: item.update_time || item.create_time,
              mentions: (item.mentions ?? []).map((m: any) => ({ key: m.key,
                id: { open_id: m.id_type === 'open_id' ? m.id : undefined } })) } }, this.botId);
          if (message?.botMentioned && candidate.expires > this.now()) {
            this.receive(message); // Engine still owns owner/topic checks and atomic inbox deduplication.
            this.candidates.delete(id);
          }
          this.warned = false;
        } catch {
          if (!this.closed && !this.warned) { this.warn(); this.warned = true; }
        }
      }
    } finally { this.running = false; }
  }

  close(): void { this.closed = true; this.candidates.clear(); }
}
