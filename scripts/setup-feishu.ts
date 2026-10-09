import { existsSync } from 'node:fs';
import { setupFeishu, registrationError } from '../src/setup-feishu.js';

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15 * 60_000);
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  if (existsSync('.env')) {
    console.error('.env already exists. It will not be overwritten. See docs/feishu-setup.md.');
    process.exitCode = 1;
  } else {
    console.log('Create a dedicated Feishu bot. Review its name, organization and permissions on the official authorization page.');
    const result = await setupFeishu({ root: process.cwd(), signal: controller.signal,
      onQRCodeReady: ({ url, expireIn }) => {
        console.log(JSON.stringify({ verification_url: url, expires_in: expireIn }));
      } });
    console.log('Application credentials saved locally in .env (owner-only file permissions). No secrets printed.');
    console.log(`Application console: ${result.consoleUrl}`);
    console.log(result.ownerConfigured ? 'Owner bound to the authorizing user.'
      : 'Owner not configured. Service stays disabled; complete the manual identity setup locally.');
    if (!result.supportedBrand) console.log('Lark tenant detected. Current runtime supports Feishu only.');
    console.log('Next: npm run doctor && npm run build && npm start');
    console.log('In the application console, verify long-connection events, permissions and published availability.');
  }
} catch (error) {
  console.error(registrationError(error)); process.exitCode = 1;
} finally { clearTimeout(timer); }
