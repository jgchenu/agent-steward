import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Status, Task } from './types.js';

export interface Outgoing { id: string; chatId: string; text: string; attempts: number }
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
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  consume(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO inbox VALUES (?)').run(id).changes === 1;
  }
  create(chatId: string, project: string, prompt: string): Task {
    const id = randomUUID().slice(0, 8), now = new Date().toISOString();
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,NULL,NULL,?,?)')
      .run(id, chatId, project, prompt, 'queued', now, now);
    this.event(id, 'created', prompt);
    return this.get(id)!;
  }
  get(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined;
  }
  list(chatId?: string): Task[] {
    return (chatId ? this.db.prepare('SELECT * FROM tasks WHERE chatId=? ORDER BY createdAt DESC LIMIT 20').all(chatId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY createdAt').all()) as unknown as Task[];
  }
  set(id: string, status: Status, result?: string): void {
    this.db.prepare('UPDATE tasks SET status=?, result=COALESCE(?,result), updatedAt=? WHERE id=?')
      .run(status, result ?? null, new Date().toISOString(), id);
    this.event(id, status, result ?? '');
  }
  resume(id: string, prompt: string): void {
    this.db.prepare('UPDATE tasks SET prompt=?, result=NULL WHERE id=?').run(prompt, id);
    this.set(id, 'queued');
    this.event(id, 'followup', prompt);
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
          this.enqueue(task.chatId, `任务 ${task.id} 已中断。使用 /continue ${task.id} <后续要求> 继续。`);
        }
      }
    });
  }
  enqueue(chatId: string, text: string): void {
    // Chunk before persisting so each retried delivery has a stable deduplication ID.
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2500) {
      this.db.prepare('INSERT INTO outbox(id,chatId,text) VALUES (?,?,?)')
        .run(randomUUID(), chatId, chars.slice(i, i + 2500).join(''));
    }
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
  close(): void { this.db.close(); }
}
