import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { CodexExecutor } from '../src/adapters/codex.js';

const path = mkdtempSync(join(tmpdir(), 'steward-codex-smoke-'));
console.log('Live smoke test: one tiny turn using your ChatGPT subscription, read-only temporary workspace.');
try {
  const result = await new CodexExecutor().run({ id: 'smoke', chatId: 'local', project: 'smoke',
    prompt: 'Reply exactly STEWARD_OK. Do not use tools or inspect files.', status: 'running', threadId: null,
    result: null, createdAt: '', updatedAt: '' }, { path, sandbox: 'read-only' }, {
    thread: () => {}, progress: () => {}, resolved: () => {},
    request: request => { request.resolve(request.kind === 'approval' ? 'decline' : 'Do not use tools.'); return 'smoke'; },
  }, AbortSignal.timeout(90_000));
  assert.match(result, /STEWARD_OK/);
  console.log('PASS: ChatGPT auth → thread/start → turn/start → final result.');
} finally { rmSync(path, { recursive: true, force: true }); }
