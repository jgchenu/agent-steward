import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Conversation, ContextSnapshot, DeliveryReport, EvidenceImage, Intent, Status, Task, View, Workspace } from './types.js';

export interface Outgoing { id: string; chatId: string; text: string; attempts: number; view: string | null }
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL, project TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, threadId TEXT, result TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, taskId TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS card_actions (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL, intent TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS card_messages (
        chatId TEXT NOT NULL, viewKey TEXT NOT NULL, messageId TEXT NOT NULL, PRIMARY KEY(chatId,viewKey));`);
    const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === 'view')) this.db.exec('ALTER TABLE outbox ADD COLUMN view TEXT');
    const taskColumns = this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!taskColumns.some(c => c.name === 'mode')) this.db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'read-only'");
    if (!taskColumns.some(c => c.name === 'nextAction')) this.db.exec("ALTER TABLE tasks ADD COLUMN nextAction TEXT NOT NULL DEFAULT 'execute'");
    if (!taskColumns.some(c => c.name === 'baselineRef')) this.db.exec('ALTER TABLE tasks ADD COLUMN baselineRef TEXT');
    if (!taskColumns.some(c => c.name === 'mergeUrl')) this.db.exec('ALTER TABLE tasks ADD COLUMN mergeUrl TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces (taskId TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (taskId TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_conversations (taskId TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_snapshots (taskId TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_bindings (chatId TEXT NOT NULL, messageKey TEXT NOT NULL, taskId TEXT NOT NULL, PRIMARY KEY(chatId,messageKey));
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=6;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  consume(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO inbox VALUES (?)').run(id).changes === 1;
  }
  create(chatId: string, project: string, prompt: string, mode: Task['mode'] = 'read-only', conversation?: Conversation): Task {
    const id = randomUUID().slice(0, 8), now = new Date().toISOString();
    this.db.prepare('INSERT INTO tasks(id,chatId,project,prompt,status,createdAt,updatedAt,mode) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, chatId, project, prompt, 'queued', now, now, mode);
    if (conversation) this.saveConversation(id, conversation);
    this.event(id, 'created', prompt);
    return this.get(id)!;
  }
  get(id: string): Task | undefined {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined;
    return task && this.hydrate(task);
  }
  list(chatId?: string): Task[] {
    return ((chatId ? this.db.prepare('SELECT * FROM tasks WHERE chatId=? ORDER BY createdAt DESC LIMIT 20').all(chatId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY createdAt').all()) as unknown as Task[]).map(task => this.hydrate(task));
  }
  private hydrate(task: Task): Task {
    const conversation = this.db.prepare('SELECT data FROM task_conversations WHERE taskId=?').get(task.id) as { data: string } | undefined;
    return { ...task, ...(conversation ? { conversation: JSON.parse(conversation.data) } : {}) };
  }
  saveConversation(id: string, conversation: Conversation): void {
    this.db.prepare('INSERT INTO task_conversations VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(conversation));
    const task = this.get(id)!;
    for (const key of [conversation.anchorId, conversation.sourceId, conversation.threadId]) if (key) this.bindConversation(task.chatId, key, id);
  }
  bindConversation(chatId: string, key: string, taskId: string): void {
    // Late deliveries from a previous execution must still lead to the topic's current task.
    const anchor = this.get(taskId)?.conversation?.anchorId;
    const active = anchor && this.db.prepare('SELECT taskId FROM conversation_bindings WHERE chatId=? AND messageKey=?').get(chatId, anchor) as { taskId: string } | undefined;
    if (active) taskId = active.taskId;
    this.db.prepare('INSERT OR IGNORE INTO conversation_bindings VALUES (?,?,?)').run(chatId, key, taskId);
  }
  originalPrompt(id: string): string {
    return (this.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='created' ORDER BY seq LIMIT 1").get(id) as {body:string} | undefined)?.body ?? this.get(id)!.prompt;
  }
  handoff(from: Task, project: string, prompt: string, mode: Task['mode'], conversation: Conversation): Task {
    if (!['review','completed','failed','cancelled','interrupted'].includes(this.get(from.id)?.status ?? '')) throw Error('当前任务仍在执行，无法切换项目。');
    const next = this.create(from.chatId, project, prompt, mode, conversation);
    this.db.prepare('UPDATE conversation_bindings SET taskId=? WHERE chatId=? AND taskId=?').run(next.id, from.chatId, from.id);
    this.expire(from.id);
    this.set(from.id, from.status); // Invalidate controls issued before the handoff.
    this.event(from.id, 'handoff_to', next.id); this.event(next.id, 'handoff_from', from.id);
    return next;
  }
  conversationTask(chatId: string, conversation?: Conversation): Task | undefined {
    if (!conversation) return;
    const tasks = new Set<string>();
    for (const key of [conversation.anchorId, conversation.threadId, conversation.parentId]) {
      if (!key) continue;
      const row = this.db.prepare('SELECT taskId FROM conversation_bindings WHERE chatId=? AND messageKey=?').get(chatId, key) as { taskId: string } | undefined;
      if (row) tasks.add(row.taskId);
    }
    return tasks.size === 1 ? this.get([...tasks][0]) : undefined;
  }
  isOwnMessage(chatId: string, messageId?: string): boolean {
    return !!messageId && !!this.db.prepare("SELECT 1 FROM card_messages WHERE chatId=? AND messageId=? AND viewKey NOT LIKE 'reaction:%' LIMIT 1").get(chatId, messageId);
  }
  saveContext(id: string, snapshot: ContextSnapshot): void {
    this.db.prepare('INSERT INTO context_snapshots VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(snapshot));
  }
  context(id: string): ContextSnapshot | undefined {
    const row = this.db.prepare('SELECT data FROM context_snapshots WHERE taskId=?').get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  }
  set(id: string, status: Status, result?: string): void {
    // Monotonic revisions prevent a stale button matching a different turn in the same millisecond.
    const previous = this.get(id);
    const updatedAt = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    this.db.prepare('UPDATE tasks SET status=?, result=COALESCE(?,result), updatedAt=? WHERE id=?')
      .run(status, result ?? null, updatedAt, id);
    this.event(id, status, result ?? '');
  }
  resume(id: string, prompt: string): void {
    this.db.prepare('DELETE FROM context_snapshots WHERE taskId=?').run(id);
    this.db.prepare("UPDATE tasks SET prompt=?, result=NULL, nextAction='execute' WHERE id=?").run(prompt, id);
    const report = this.delivery(id);
    if (report) this.saveDelivery(id, { ...report, ready: false });
    this.set(id, 'queued');
    this.event(id, 'followup', prompt);
  }
  queueBaseline(id: string, ref: string): void {
    this.db.prepare("UPDATE tasks SET nextAction='baseline', baselineRef=? WHERE id=?").run(ref, id);
    this.set(id, 'queued');
  }
  queuePublication(id: string): void {
    this.db.prepare("UPDATE tasks SET nextAction='publish' WHERE id=?").run(id);
    this.set(id, 'queued');
  }
  queueMerge(id: string, url: string): void {
    this.db.prepare("UPDATE tasks SET nextAction='merge', mergeUrl=? WHERE id=?").run(url,id);
    this.set(id,'queued');
  }
  workspace(id: string): Workspace | undefined {
    const row = this.db.prepare('SELECT data FROM workspaces WHERE taskId=?').get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data) as Workspace;
  }
  saveWorkspace(workspace: Workspace): void {
    this.db.prepare('INSERT INTO workspaces VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data')
      .run(workspace.taskId, JSON.stringify(workspace));
  }
  delivery(id: string): DeliveryReport | undefined {
    const row = this.db.prepare('SELECT data FROM deliveries WHERE taskId=?').get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data) as DeliveryReport;
  }
  saveDelivery(id: string, report: DeliveryReport): void {
    this.db.prepare('INSERT INTO deliveries VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(report));
  }
  thread(id: string, threadId: string): void {
    this.db.prepare('UPDATE tasks SET threadId=? WHERE id=?').run(threadId, id);
  }
  event(taskId: string, kind: string, body: string): void {
    this.db.prepare('INSERT INTO events(taskId,kind,body,at) VALUES (?,?,?,?)')
      .run(taskId, kind, body, new Date().toISOString());
  }
  latestProgress(taskId: string): string {
    const event = this.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='progress' ORDER BY seq DESC LIMIT 1")
      .get(taskId) as { body: string } | undefined;
    return event?.body ?? '';
  }
  request(taskId: string, kind: string, description: string): string {
    const id = randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO requests(id,taskId,kind,description) VALUES (?,?,?,?)')
      .run(id, taskId, kind, description);
    return id;
  }
  getRequest(id: string): { taskId: string; kind: string; status: string; description: string } | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as ReturnType<Store['getRequest']>;
  }
  requests(taskId: string): Array<{ id: string; kind: string }> {
    return this.db.prepare("SELECT id,kind FROM requests WHERE taskId=? AND status='pending'").all(taskId) as Array<{id: string; kind: string}>;
  }
  resolveRequest(id: string, status = 'answered'): void {
    this.db.prepare("UPDATE requests SET status=? WHERE id=? AND status='pending'").run(status, id);
  }
  expire(taskId: string): void {
    this.db.prepare("UPDATE requests SET status='expired' WHERE taskId=? AND status='pending'").run(taskId);
  }
  recover(): void {
    this.transaction(() => {
      for (const task of this.list()) {
        if (['running', 'waiting_approval', 'waiting_input'].includes(task.status)) {
          this.set(task.id, 'interrupted', '进程已重启；旧确认已失效。请检查已有改动，再明确继续。');
          this.expire(task.id);
          this.enqueue(task.chatId, `任务 ${task.id} 已中断。使用 /continue ${task.id} <后续要求> 继续。`, { kind: 'task', taskId: task.id });
        }
      }
    });
  }
  enqueue(chatId: string, text: string, view?: View): void {
    if (view && 'taskId' in view && !view.conversation) view = { ...view, conversation: this.get(view.taskId)?.conversation };
    if (view) {
      this.db.prepare('INSERT INTO outbox(id,chatId,text,view) VALUES (?,?,?,?)')
        .run(randomUUID(), chatId, text, JSON.stringify(view));
      return;
    }
    // Chunk before persisting so each retried delivery has a stable deduplication ID.
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2500) {
      this.db.prepare('INSERT INTO outbox(id,chatId,text) VALUES (?,?,?)')
        .run(randomUUID(), chatId, chars.slice(i, i + 2500).join(''));
    }
  }
  action(chatId: string, intent: Intent): string {
    this.db.prepare('DELETE FROM card_actions WHERE expires<?').run(Date.now());
    const id = 'a' + randomUUID().replaceAll('-', '');
    this.db.prepare('INSERT INTO card_actions(id,chatId,intent,expires) VALUES (?,?,?,?)')
      .run(id, chatId, JSON.stringify(intent), Date.now() + 7 * 86_400_000);
    return id;
  }
  getAction(id: string): { chatId: string; intent: Intent; used: number; expires: number } | undefined {
    const row = this.db.prepare('SELECT * FROM card_actions WHERE id=?').get(id) as
      { chatId: string; intent: string; used: number; expires: number } | undefined;
    return row && { ...row, intent: JSON.parse(row.intent) as Intent };
  }
  useAction(id: string): boolean {
    return this.db.prepare('UPDATE card_actions SET used=1 WHERE id=? AND used=0').run(id).changes === 1;
  }
  cardMessage(chatId: string, key: string): string | undefined {
    return (this.db.prepare('SELECT messageId FROM card_messages WHERE chatId=? AND viewKey=?').get(chatId, key) as { messageId: string } | undefined)?.messageId;
  }
  saveCardMessage(chatId: string, key: string, messageId: string): void {
    this.db.prepare('INSERT INTO card_messages VALUES (?,?,?) ON CONFLICT(chatId,viewKey) DO UPDATE SET messageId=excluded.messageId')
      .run(chatId, key, messageId);
  }
  bindCardMessage(chatId: string, key: string, messageId: string): void {
    this.transaction(() => {
      // A task card navigated to a form must no longer be overwritten by background task updates.
      this.db.prepare("DELETE FROM card_messages WHERE chatId=? AND messageId=? AND viewKey NOT LIKE 'alert:%' AND viewKey NOT LIKE 'delivery:%'")
        .run(chatId, messageId);
      this.saveCardMessage(chatId, key, messageId);
    });
  }
  outgoing(): Outgoing | undefined {
    return this.db.prepare('SELECT * FROM outbox WHERE sent=0 AND due<=? ORDER BY rowid LIMIT 1')
      .get(Date.now()) as unknown as Outgoing | undefined;
  }
  delivered(id: string): void { this.db.prepare('UPDATE outbox SET sent=1 WHERE id=?').run(id); }
  retry(id: string, attempts: number): void {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,due=? WHERE id=?')
      .run(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8)), id);
  }
  saveEvidence(image: EvidenceImage): void {
    this.db.prepare('INSERT INTO evidence VALUES (?,?,?)').run(image.id,image.taskId,JSON.stringify(image));
  }
  evidence(id: string, taskId: string): EvidenceImage | undefined {
    const row = this.db.prepare('SELECT data FROM evidence WHERE id=? AND taskId=?').get(id,taskId) as {data:string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  close(): void { this.db.close(); }
}
