import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config, Project } from './types.js';
export const CONVERSATION = '__conversation__';
export function conversationProject(config: Config): Project {
  const path = join(tmpdir(), 'agent-steward-chat-' + createHash('sha256').update(config.stateDir).digest('hex').slice(0,16));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path && realpathSync(path) !== realpathSync(tmpdir()) + '/' + path.split('/').pop()) throw Error('聊天运行目录无效。');
  return { path: realpathSync(path), label: '对话', sandbox: 'read-only' };
}
