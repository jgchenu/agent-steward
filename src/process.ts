import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export interface CommandResult { code: number; stdout: string; truncated: boolean }
export function commandEnv(check = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(FEISHU_|STEWARD_)|^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY)$/.test(key)) continue;
    if (check && !/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|SystemRoot)$/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
}
// No shell interpolation. Terminate the process group and wait before releasing the task slot.
export function runCommand(command: string, args: string[], cwd: string, signal: AbortSignal,
  options: { timeoutSeconds?: number; log?: string; check?: boolean } = {}): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let output = '', bytes = 0, truncated = false, stopped = false, spawnError = false;
    const limit = 2 * 1024 * 1024;
    const log = options.log ? createWriteStream(options.log, { mode: 0o600 }) : undefined;
    const child = spawn(command, args, { cwd, env: commandEnv(options.check), stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' });
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const kill = (s: NodeJS.Signals) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, s); else child.kill(s); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') spawnError = true; } };
    const stop = () => { if (stopped) return; stopped = true; kill('SIGTERM'); hardKill = setTimeout(() => kill('SIGKILL'), 2000); };
    const timer = setTimeout(stop, (options.timeoutSeconds ?? 120) * 1000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const collect = (chunk: Buffer, stdout: boolean) => {
      if (bytes >= limit) { truncated = true; return; }
      const part = chunk.subarray(0, limit - bytes); bytes += part.length;
      if (part.length < chunk.length) truncated = true;
      log?.write(part); if (stdout) output += part.toString('utf8');
    };
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false));
    log?.on('error', () => { spawnError = true; stop(); });
    child.on('error', () => { spawnError = true; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(hardKill); signal.removeEventListener('abort', stop);
      const finish = () => {
        if (signal.aborted) reject(signal.reason ?? new Error('已取消'));
        else if (spawnError) reject(new Error(`无法启动命令或保存验证日志：${command}`));
        else if (stopped) reject(new Error(`命令超时：${command}`));
        else resolve({ code: code ?? 1, stdout: output, truncated });
      };
      if (log && !log.destroyed) log.end(finish); else finish();
    });
  });
}
