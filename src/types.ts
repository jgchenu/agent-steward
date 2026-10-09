export type Status = 'queued' | 'running' | 'waiting_approval' | 'waiting_input'
  | 'review' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Task {
  id: string; chatId: string; project: string; prompt: string; status: Status;
  threadId: string | null; result: string | null; createdAt: string; updatedAt: string;
  mode?: 'read-only' | 'workspace-write'; nextAction?: 'execute' | 'publish';
}
export interface Incoming {
  id: string; senderId: string; chatId: string; text: string;
  chatType: 'p2p' | 'group'; senderType: string;
}
export interface Check { name: string; command: string; args: string[]; timeoutSeconds?: number }
export interface Project {
  path: string; sandbox: 'read-only' | 'workspace-write';
  worktree?: { baseRef: string; checks: Check[]; github?: { repository: string; baseBranch: string } };
}
export interface Workspace {
  taskId: string; source: string; path: string; branch: string; baseSha: string; baseRef: string;
}
export interface DeliveryReport {
  workspace: Workspace; mode: 'read-only' | 'workspace-write'; capturedAt: string;
  files: string[]; diffStat: string; fingerprint: string; headSha: string;
  checks: Array<{ name: string; status: 'running' | 'passed' | 'failed'; log: string; exitCode?: number }>;
  ready: boolean; validationKey?: string; authorizedKey?: string; prUrl?: string; publishedSha?: string; targetBefore?: string; error?: string;
}
export interface Config {
  ownerId: string; stateDir: string; codexCommand: string; maxRunMinutes: number;
  projects: Record<string, Project>;
}
export interface HumanRequest {
  kind: 'approval' | 'input'; description: string;
  validate?: (answer: string) => void;
  // Reply is interpreted by the adapter, never executed as shell text.
  resolve: (answer: string) => void;
}
export interface RunHooks {
  thread: (id: string) => void;
  progress: (text: string) => void;
  request: (request: HumanRequest) => string;
  resolved: (id: string) => void;
}
export interface Executor {
  run(task: Task, project: Project, hooks: RunHooks, signal: AbortSignal): Promise<string>;
}
export type View = ({ kind: 'home' } | { kind: 'list'; page?: number }
  | { kind: 'task' | 'followup' | 'result' | 'delivery' | 'publication'; taskId: string; page?: number })
  & { targetMessageId?: string; fresh?: boolean };
export interface CardAction {
  id: string; senderId: string; chatId: string; actionId: string; messageId: string;
  fields: Record<string, unknown>;
}
export interface Intent {
  op: 'home' | 'list' | 'status' | 'result' | 'followup' | 'new' | 'continue' | 'done' | 'cancel' | 'approve' | 'deny' | 'answer'
    | 'delivery' | 'publication' | 'publish';
  taskId?: string; requestId?: string; revision?: string; page?: number; publicationKey?: string;
}
export interface Channel {
  send(chatId: string, text: string, deliveryId: string, view?: View): Promise<void>;
}
