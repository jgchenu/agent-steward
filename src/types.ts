export type Status = 'queued' | 'running' | 'waiting_approval' | 'waiting_input'
  | 'review' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Conversation {
  anchorId: string; sourceId: string; threadId?: string; parentId?: string;
  scope: 'chat' | 'thread'; cutoff?: string;
}
export interface ContextSnapshot {
  summary: string; capturedAt: string; truncated: boolean;
  messages: Array<{ id: string; author: string; text: string }>;
  attachments?: Attachment[];
  mediaDir?: string;
}
export interface Attachment {
  messageId: string; key?: string; kind: 'image' | 'file' | 'video' | 'audio'; name?: string;
  status: 'unread' | 'attached' | 'text' | 'processed' | 'partial'; detail: string; path?: string; text?: string;
  visuals?: Array<{ path: string; label: string }>;
}
export type PermissionMode = 'ask' | 'auto' | 'sandbox-auto' | 'full-access';
export interface Task {
  modelSelection?: import('./models.js').ModelSelection;
  permissionMode?: PermissionMode;
  id: string; chatId: string; project: string; prompt: string; status: Status;
  threadId: string | null; result: string | null; createdAt: string; updatedAt: string;
  evidenceDirectory?: string;
  conversation?: Conversation; contextSnapshot?: ContextSnapshot; codeVersion?: { ref: string; baseSha: string; headSha: string };
  mode?: 'read-only' | 'workspace-write'; nextAction?: 'execute' | 'publish' | 'baseline'; baselineRef?: string | null; routingContext?: string;
}
export interface Incoming {
  id: string; senderId: string; chatId: string; text: string;
  chatType: 'p2p' | 'group'; senderType: string;
  conversation?: Conversation; botMentioned?: boolean; mentionsOthers?: boolean;
}
export interface Check { name: string; command: string; args: string[]; timeoutSeconds?: number }
export interface Project {
  codexProjectId?: string;
  path: string; sandbox: 'read-only' | 'workspace-write'; label?: string; aliases?: string[]; description?: string; naturalMode?: 'read-only' | 'workspace-write';
  worktree?: { baseRef: string; checks: Check[]; github?: { repository: string; baseBranch: string } };
}
export interface Workspace {
  taskId: string; source: string; path: string; branch: string; baseSha: string; baseRef: string; configBaseRef?: string;
}
export interface EvidenceImage {
  id: string; taskId: string; path: string; sha256: string; caption: string; scope: 'local-preview' | 'deployed'; capturedAt: string;
}
export interface DeliveryReport {
  evidenceIds?: string[]; evidenceWarning?: string;
  workspace: Workspace; mode: 'read-only' | 'workspace-write'; capturedAt: string;
  files: string[]; diffStat: string; fingerprint: string; headSha: string;
  checks: Array<{ name: string; status: 'running' | 'passed' | 'failed'; log: string; exitCode?: number }>;
  ready: boolean; validationKey?: string; authorizedKey?: string; prUrl?: string; publishedSha?: string; targetBefore?: string; error?: string;
}
export interface Config {
  modelSelection?: import('./models.js').ModelSelection;
  consoleUrl?: string;
  codexProjects?: import('./codex-projects.js').CodexProject[];
  permissionMode?: PermissionMode;
  approvalsReviewer?: 'user' | 'auto_review';
  ownerId: string; stateDir: string; codexCommand: string; maxRunMinutes: number;
  projects: Record<string, Project>; groupChats?: boolean; defaultProject?: string;
}
export interface HumanRequest {
  kind: 'approval' | 'input'; description: string; explicit?: boolean;
  validate?: (answer: string) => void;
  // Reply is interpreted by the adapter, never executed as shell text.
  resolve: (answer: string) => void;
}
export interface RunHooks {
  prepared?: (report: DeliveryReport) => void;
  thread: (id: string) => void;
  progress: (text: string) => void;
  request: (request: HumanRequest) => string;
  resolved: (id: string) => void;
}
export interface Executor {
  run(task: Task, project: Project, hooks: RunHooks, signal: AbortSignal): Promise<string>;
}
export type View = ({ kind: 'evidence'; taskId: string; evidenceIds: string[] } | { kind: 'home' } | { kind: 'notice' } | { kind: 'choose-project'; draft: string; choices: string[]; selectionKey: string; fromTaskId?: string; revision?: string } | { kind: 'list'; page?: number }
  | { kind: 'reply' | 'task' | 'followup' | 'result' | 'delivery' | 'publication' | 'baseline' | 'source'; taskId: string; page?: number })
  & { targetMessageId?: string; fresh?: boolean; conversation?: Conversation; draft?: string };
export interface CardAction {
  id: string; senderId: string; chatId: string; actionId: string; messageId: string;
  fields: Record<string, unknown>;
}
export interface Intent {
  op: 'dispatch' | 'home' | 'list' | 'status' | 'result' | 'followup' | 'new' | 'continue' | 'done' | 'cancel' | 'approve' | 'deny' | 'answer'
    | 'delivery' | 'publication' | 'publish' | 'baseline' | 'restart' | 'source';
  conversation?: Conversation; project?: string; prompt?: string; selectionKey?: string; taskId?: string; requestId?: string; revision?: string; page?: number; publicationKey?: string;
}
export interface Channel {
  acknowledge?(task: Task, signal: AbortSignal): Promise<void>;
  context?(task: Task, signal: AbortSignal): Promise<ContextSnapshot>;
  releaseContext?(snapshot: ContextSnapshot): Promise<void>;
  send(chatId: string, text: string, deliveryId: string, view?: View): Promise<void>;
}
