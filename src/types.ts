export type Status = 'queued' | 'running' | 'waiting_approval' | 'waiting_input'
  | 'review' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Task {
  id: string; chatId: string; project: string; prompt: string; status: Status;
  threadId: string | null; result: string | null; createdAt: string; updatedAt: string;
}
export interface Incoming {
  id: string; senderId: string; chatId: string; text: string;
  chatType: 'p2p' | 'group'; senderType: string;
}
export interface Project { path: string; sandbox: 'read-only' | 'workspace-write' }
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
export interface Channel { send(chatId: string, text: string, deliveryId: string): Promise<void> }
