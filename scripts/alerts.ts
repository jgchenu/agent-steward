import { loadConfig } from '../src/config.js';
import { SentryConnector } from '../src/sentry.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

async function main() {
  const config = loadConfig(), command = process.argv[2], id = process.argv[3];
  if (command === 'status') {
    const db = new DatabaseSync(join(config.stateDir,'steward.sqlite'),{readOnly:true});
    try {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_cursors'").get();
      for (const [sourceId,s] of Object.entries(config.alertSources ?? {})) {
        const state = hasTable ? db.prepare('SELECT watermark,checkedAt,error FROM alert_cursors WHERE sourceId=? ORDER BY rowid DESC LIMIT 1').get(sourceId) : null;
        console.log(JSON.stringify({sourceId,enabled:s.enabled,project:s.project,credentialPresent:!!process.env[s.sentry.tokenEnv]?.trim(),state}));
      }
    } finally {db.close();}
  } else if (command === 'check' && id && config.alertSources?.[id]) {
    const connector = new SentryConnector(), source = config.alertSources[id], now = Date.now();
    const page = await connector.list(source,new Date(now-86400_000).toISOString(),new Date(now).toISOString(),undefined,new AbortController().signal);
    const sample = page.issues[0] && await connector.evidence(source,page.issues[0].id,new AbortController().signal);
    console.log(JSON.stringify({sourceId:id,api:'ok',sampledIssues:page.issues.length,hasMore:!!page.next,
      event:sample ? 'ok' : 'no matching issue',exceptionCount:sample?.exception.length ?? 0,tasksCreated:0,messagesSent:0}));
  } else throw Error('Usage: alerts <status|check SOURCE_ID>');
}
main().catch(error => {
  // Do not print raw API errors, headers, response payloads or private config.
  const message = error instanceof Error && /^(Sentry (HTTP \d{3}|token missing|project mismatch|environment mismatch)|Usage:)/.test(error.message)
    ? error.message : 'Alert diagnostic failed; check local config, connectivity and API permissions.';
  console.error(message);process.exitCode=1;
});
