import { setTimeout } from 'node:timers/promises';
import type { Executor, Project, RunHooks, Task } from '../types.js';

// Explicit simulator; never described as a real model execution.
export class DemoExecutor implements Executor {
  async run(task: Task, _project: Project, hooks: RunHooks, signal: AbortSignal): Promise<string> {
    hooks.thread(task.threadId ?? `demo-${task.id}`);
    await setTimeout(100, undefined, { signal });
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      hooks.request({ kind: 'approval', description: '[模拟] 允许生成演示报告？不会修改文件。',
        resolve: answer => {
          signal.removeEventListener('abort', abort);
          if (answer === 'accept') resolve(); else reject(new Error('你拒绝了演示操作'));
        } });
    });
    return '[模拟结果] 任务流程已跑通：接单 → 排队 → 确认 → 交付待验收。未调用模型，未修改项目。';
  }
}
