import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };
// The JSON boundary is validated by each method consumer. Never log raw protocol frames.
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  private closed = false;
  private exited: Promise<void>;
  constructor(command: string, cwd: string) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(FEISHU_|STEWARD_)|^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY)$/.test(key)) delete env[key];
    }
    this.child = spawn(command, ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"',
      '-c', 'forced_login_method="chatgpt"'], { cwd, env, stdio: 'pipe', detached: process.platform !== 'win32' });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    // Drain stderr without retaining potentially sensitive local diagnostic output.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Codex emitted invalid JSON')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.fail(new Error('Codex emitted an invalid protocol frame')); return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(Number(message.id));
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        try { this.onMessage(message); } catch (error) { this.fail(error as Error); }
      }
    });
    this.child.on('error', () => this.fail(new Error('无法启动 Codex；请检查安装和 codexCommand。')));
    this.child.on('exit', () => { lines.close(); this.fail(new Error('Codex 进程已退出')); });
    this.child.stdin.on('error', () => this.fail(new Error('Codex 连接已关闭')));
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.kill('SIGTERM'); this.onExit(error);
  }
  private kill(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  write(message: unknown): void {
    if (this.closed) throw new Error('Codex 连接已关闭');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'agent_steward', title: 'Agent Steward', version: '0.1.0' },
      capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
  }
  async subscription(): Promise<void> {
    const result = await this.request('account/read', { refreshToken: false });
    if (result?.account?.type !== 'chatgpt') {
      throw new Error('需要 ChatGPT 订阅登录。请在本机运行 codex login；不会回退到付费 API。');
    }
  }
  async close(): Promise<void> {
    this.fail(new Error('Codex 连接关闭'));
    const timer = setTimeout(() => this.kill('SIGKILL'), 2000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
