import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { WorkspaceExecutor } from './workspace.js';
import { Engine } from './engine.js';
import { acquireLock } from './lock.js';
import { CodexExecutor } from './adapters/codex.js';
import { CodexRpc } from './adapters/rpc.js';
import { DemoExecutor } from './adapters/demo.js';
import { FeishuChannel } from './channels/feishu.js';
import type { Channel, Config } from './types.js';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!['demo', 'local', 'feishu', 'doctor'].includes(mode)) {
    console.log('Usage: agent-steward <demo|local|feishu|doctor>'); return;
  }
  const config: Config = mode === 'demo' ? {
    ownerId: 'demo-owner', stateDir: mkdtempSync(join(tmpdir(), 'agent-steward-demo-')),
    projects: { demo: { path: process.cwd(), sandbox: 'read-only' } }, codexCommand: 'codex', maxRunMinutes: 60,
  } : loadConfig();
  if (mode === 'doctor') {
    const rpc = new CodexRpc(config.codexCommand, Object.values(config.projects)[0].path);
    try {
      await rpc.initialize(); await rpc.subscription();
      console.log('OK: project paths, Codex App Server, ChatGPT login. No inference performed.');
      console.log(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET
        ? 'Feishu credentials present (connection not tested).' : 'Feishu credentials missing; local mode remains available.');
    } finally { await rpc.close(); }
    return;
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(config.stateDir);
  const store = new Store(join(config.stateDir, 'steward.sqlite'));
  let feishu: FeishuChannel | undefined;
  let channel: Channel = { send: async (_chatId, text) => { console.log(`\n${text}\n`); } };
  if (mode === 'feishu') {
    const appId = process.env.FEISHU_APP_ID, secret = process.env.FEISHU_APP_SECRET;
    if (!appId || !secret) { store.close(); release(); throw new Error('请在本地 .env 配置飞书应用身份。'); }
    feishu = new FeishuChannel(appId, secret, store, config); channel = feishu;
  }
  const engine = new Engine(store, config, mode === 'demo' ? new DemoExecutor() : new WorkspaceExecutor(config, store, new CodexExecutor(config.codexCommand)), channel);
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    feishu?.close();
    await engine.stop(); store.close(); release(); process.exit(0);
  };
  process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
  engine.start();
  if (feishu) {
    await feishu.connect(message => engine.receive(message), action => engine.handleAction(action));
    console.log('Agent Steward started. Owner-only Feishu DMs. Use /help.');
  } else {
    console.log(mode === 'demo' ? 'DEMO · 模拟执行器，不调用模型。输入任务或 /help。'
      : 'LOCAL · 真实 Codex 订阅执行。输入任务或 /help。');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.on('line', text => engine.receive({ id: randomUUID(), senderId: config.ownerId, chatId: 'local',
      chatType: 'p2p', senderType: 'user', text }));
    input.on('close', () => void shutdown());
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Startup failed'); process.exit(1); });
