import { openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export function acquireLock(dir: string): () => void {
  const path = join(dir, 'instance.lock');
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('实例锁异常；确认没有运行实例后手动删除 instance.lock。');
    try { process.kill(pid, 0); }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
        unlinkSync(path); return acquireLock(dir);
      }
      throw probe;
    }
    throw new Error('同一数据目录已有 Steward 实例在运行。');
  }
  return () => { unlinkSync(path); };
}
