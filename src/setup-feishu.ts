import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { registerApp } from '@larksuiteoapi/node-sdk';
import { acquireLock } from './lock.js';

type Register = typeof registerApp;
type Registration = Awaited<ReturnType<Register>>;
export interface SetupResult {
  appId: string; ownerConfigured: boolean; supportedBrand: boolean; consoleUrl: string;
}

// Credentials come straight from the official authorization flow and never reach stdout.
// Reject control characters and quotes instead of allowing dotenv key injection.
function envValue(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\r\n\0'"]/.test(value)) {
    throw new Error('Registration returned an unsupported credential format. No configuration was written.');
  }
  return `'${value}'`;
}

export function saveRegistration(root: string, registration: Registration): SetupResult {
  const appId = registration.client_id;
  if (typeof appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(appId)) {
    throw new Error('Registration did not return a valid application ID.');
  }
  const owner = registration.user_info?.open_id;
  const ownerConfigured = typeof owner === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(owner);
  const supportedBrand = registration.user_info?.tenant_brand !== 'lark';
  const data = [
    '# Private Agent Steward configuration. Never commit or share this file.',
    `FEISHU_APP_ID=${envValue(appId)}`,
    `FEISHU_APP_SECRET=${envValue(registration.client_secret)}`,
    `STEWARD_OWNER_ID=${ownerConfigured && supportedBrand ? envValue(owner) : ''}`,
    'STEWARD_CONFIG=steward.config.json',
    ...(!supportedBrand ? ['# This application belongs to Lark. The current transport only supports Feishu.',
      '# Owner left unset intentionally; do not start until a Lark transport is configured.'] : []),
    '',
  ].join('\n');
  // Exclusive creation prevents a concurrent setup from replacing an existing identity.
  writeFileSync(join(root, '.env'), data, { flag: 'wx', mode: 0o600 });
  return { appId, ownerConfigured: ownerConfigured && supportedBrand, supportedBrand,
    consoleUrl: `https://${supportedBrand ? 'open.feishu.cn' : 'open.larksuite.com'}/app/${appId}` };
}

export async function setupFeishu(options: {
  root: string;
  signal: AbortSignal;
  onQRCodeReady: Parameters<Register>[0]['onQRCodeReady'];
}, register: Register = registerApp): Promise<SetupResult> {
  const root = resolve(options.root);
  if (existsSync(join(root, '.env'))) {
    throw new Error('.env already exists. Setup will not replace an existing application or identity. Use the manual setup guide.');
  }
  mkdirSync(join(root, '.steward'), { recursive: true, mode: 0o700 });
  const unlock = acquireLock(join(root, '.steward'));
  try {
    const config = join(root, 'steward.config.json');
    if (!existsSync(config)) {
      mkdirSync(join(root, 'playground'), { recursive: true });
      writeFileSync(config, JSON.stringify({ stateDir: '.steward', codexCommand: 'codex', maxRunMinutes: 60,
        projects: { sandbox: { path: './playground', sandbox: 'read-only' } } }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    }
    options.signal.throwIfAborted();
    const registration = await register({
      createOnly: true,
      source: 'agent-steward',
      appPreset: { name: 'Agent Steward', desc: '你的个人数字员工：飞书派活、Codex 执行、人工确认与结果交付。' },
      addons: {
        preset: false,
        scopes: { tenant: ['im:message:send_as_bot', 'im:message.p2p_msg:readonly'] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
      },
      signal: options.signal,
      onQRCodeReady: options.onQRCodeReady,
    });
    return saveRegistration(root, registration);
  } finally { unlock(); }
}

export function registrationError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const safeCodes = ['access_denied', 'expired_token', 'abort', 'EEXIST', 'EACCES', 'ENOSPC'];
  // SDK/HTTP errors can contain response bodies or request configuration with credentials.
  return typeof code === 'string' && safeCodes.includes(code)
    ? `Setup did not finish (${code}). See the local setup guide.`
    : 'Setup did not finish. Check local files, network and the setup guide; raw errors are hidden to protect credentials.';
}
