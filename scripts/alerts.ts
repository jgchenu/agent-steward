import { loadConfig } from '../src/config.js';
import { SentryConnector } from '../src/sentry.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { confirmAlertNoise, clearAlertNoise, noiseSignature } from '../src/alert-triage.js';
import { alertSourceKey } from '../src/alert-config.js';

async function main() {
  const config = loadConfig(), command = process.argv[2], id = process.argv[3];
  if (command === 'status') {
    const db = new DatabaseSync(join(config.stateDir,'steward.sqlite'),{readOnly:true});
    try {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_cursors'").get();
      const hasWebhooks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_webhooks'").get();
      for (const [sourceId,s] of Object.entries(config.alertSources ?? {})) {
        const state = hasTable ? db.prepare('SELECT watermark,checkedAt,error FROM alert_cursors WHERE sourceId=? ORDER BY rowid DESC LIMIT 1').get(sourceId) : null;
        const webhook = hasWebhooks ? db.prepare('SELECT count(*) pending,max(attempts) maxAttempts FROM alert_webhooks WHERE sourceId=?').get(sourceId) : null;
        const hasTriage=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_noise_rules'").get();
        const rules=hasTriage ? db.prepare('SELECT issueId,confirmedAt FROM alert_noise_rules WHERE sourceKey=?').all(alertSourceKey(config,sourceId) ?? '') : [];
        console.log(JSON.stringify({sourceId,enabled:s.enabled,project:s.project,credentialPresent:!!process.env[s.sentry.tokenEnv]?.trim(),state,noiseRules:rules,
          mcpConfigured:!!s.sentry.mcpProject,webhookConfigured:!!s.webhook,webhook}));
      }
    } finally {db.close();}
  } else if (command === 'check' && id && config.alertSources?.[id]) {
    const connector = new SentryConnector(), source = config.alertSources[id], now = Date.now();
    const page = await connector.list(source,new Date(now-86400_000).toISOString(),new Date(now).toISOString(),undefined,new AbortController().signal);
    const sample = page.issues[0] && await connector.evidence(source,page.issues[0].id,new AbortController().signal);
    console.log(JSON.stringify({sourceId:id,api:'ok',sampledIssues:page.issues.length,hasMore:!!page.next,
      event:sample ? 'ok' : 'no matching issue',exceptionCount:sample?.exception.length ?? 0,tasksCreated:0,messagesSent:0}));
  } else if (command==='inspect-noise' && id && /^[1-9][0-9]{0,30}$/.test(process.argv[4] ?? '')) {
    const db=new DatabaseSync(join(config.stateDir,'steward.sqlite'),{readOnly:true});
    try {
      const row=db.prepare('SELECT latest FROM alert_observations WHERE sourceKey=? AND issueId=?').get(alertSourceKey(config,id) ?? '',process.argv[4]);
      const e=row ? JSON.parse(String(row.latest)) : undefined;
      console.log(JSON.stringify({sourceId:id,issueId:process.argv[4],signature:e ? noiseSignature(e) ?? null : null,evidence:e ?? null}));
    } finally {db.close();}
  } else if (['confirm-noise','clear-noise'].includes(command) && id && /^[1-9][0-9]{0,30}$/.test(process.argv[4] ?? '')) {
    const store=new Store(join(config.stateDir,'steward.sqlite'));
    try {
      if (command==='confirm-noise') confirmAlertNoise(store,config,id,process.argv[4],process.argv[5] ?? '',process.argv.slice(6).join(' '));
      else clearAlertNoise(store,config,id,process.argv[4]);
      console.log(JSON.stringify({sourceId:id,issueId:process.argv[4],rule:command==='confirm-noise' ? 'confirmed' : 'cleared',tasksCreated:0,messagesSent:0}));
    } finally {store.close();}
  } else throw Error('Usage: alerts <status|check SOURCE_ID|inspect-noise SOURCE_ID ISSUE_ID|confirm-noise SOURCE_ID ISSUE_ID SIGNATURE REASON|clear-noise SOURCE_ID ISSUE_ID>');
}
main().catch(error => {
  // Do not print raw API errors, headers, response payloads or private config.
  const message = error instanceof Error && /^(Sentry (HTTP \d{3}|token missing|project mismatch|environment mismatch)|Noise rule requires|Usage:)/.test(error.message)
    ? error.message : 'Alert diagnostic failed; check local config, connectivity and API permissions.';
  console.error(message);process.exitCode=1;
});
