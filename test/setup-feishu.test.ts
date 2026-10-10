import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { setupFeishu, saveRegistration, registrationError } from '../src/setup-feishu.js';

const registration = { client_id: 'cli_test', client_secret: 'test-secret-not-a-real-credential',
  user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' as const } };

test('onboarding uses new-app flow with minimal permissions and binds the verified owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-setup-test-')); const urls: string[] = [];
  try {
    const result = await setupFeishu({ root: dir, signal: new AbortController().signal,
      onQRCodeReady: ({ url }) => urls.push(url) }, async options => {
      assert.equal(options.createOnly, true); assert.equal(options.addons?.preset, false);
      assert.equal(options.appPreset?.name, '{user}的 Agent 分身');
      assert.match(options.appPreset?.desc ?? '', /已授权的工作空间/);
      assert.deepEqual(options.addons?.scopes, { tenant: ['im:message:send_as_bot', 'im:message.p2p_msg:readonly'] });
      assert.equal(options.appId, undefined);
      options.onQRCodeReady({ url: 'https://example.test/authorize?code=a%2Bb', expireIn: 60 });
      return registration;
    });
    assert.deepEqual(urls, ['https://example.test/authorize?code=a%2Bb']);
    assert.equal(result.ownerConfigured, true);
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    assert.equal(env.STEWARD_OWNER_ID, 'ou_owner'); assert.equal(env.FEISHU_APP_SECRET, registration.client_secret);
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'steward.config.json'), 'utf8')).projects, {});
    assert.equal(existsSync(join(dir, '.steward/instance.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing identity is never replaced and registration is not started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-setup-test-')); let called = false;
  try {
    writeFileSync(join(dir, '.env'), 'PRIVATE=existing');
    await assert.rejects(setupFeishu({ root: dir, signal: new AbortController().signal, onQRCodeReady: () => {} },
      async () => { called = true; return registration; }), /already exists/);
    assert.equal(called, false); assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'PRIVATE=existing');
    assert.throws(() => saveRegistration(dir, registration), /EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing owner and unsupported Lark tenant fail closed without discarding app credentials', () => {
  for (const user_info of [undefined, { open_id: 'ou_owner', tenant_brand: 'lark' as const }]) {
    const dir = mkdtempSync(join(tmpdir(), 'steward-setup-test-'));
    try {
      const result = saveRegistration(dir, { ...registration, user_info });
      assert.equal(result.ownerConfigured, false);
      assert.equal(parseEnv(readFileSync(join(dir, '.env'), 'utf8')).STEWARD_OWNER_ID, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('authorization denial releases the setup lock and does not write credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-setup-test-'));
  try {
    await assert.rejects(setupFeishu({ root: dir, signal: new AbortController().signal, onQRCodeReady: () => {} },
      async () => { throw new Error('denied'); }), /denied/);
    assert.equal(existsSync(join(dir, '.env')), false);
    assert.equal(existsSync(join(dir, '.steward/instance.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('credentials cannot inject extra dotenv entries and SDK errors are never printed raw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-setup-test-'));
  try {
    assert.throws(() => saveRegistration(dir, { ...registration, client_secret: 'x\nSTEWARD_OWNER_ID=attacker' }), /format/);
    assert.equal(existsSync(join(dir, '.env')), false);
    assert.equal(registrationError({ code: 'expired_token', secret: 'private' }).includes('expired_token'), true);
    assert.equal(registrationError(new Error('secret=private')).includes('private'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
