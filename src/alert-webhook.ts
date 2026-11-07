import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { alertSourceKey } from './alert-config.js';
import type { Config } from './types.js';
import type { Store } from './store.js';

// A separate listener: a reverse proxy may expose this port, never the owner console.
// No model, provider request, raw payload or credential is part of acknowledgement.
export async function startAlertWebhook(store: Store, config: Config, port: number,
  environment: NodeJS.ProcessEnv = process.env): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid alert webhook port');
  const server = createServer({requestTimeout:10_000,headersTimeout:10_000,maxHeaderSize:8192}, (req,res) => {
    const reply = (status:number) => { res.writeHead(status,{'content-type':'text/plain','cache-control':'no-store'}); res.end(); };
    const id = /^\/sentry\/([a-zA-Z0-9_-]{1,64})$/.exec(req.url ?? '')?.[1];
    const source = id && config.alertSources?.[id], key = id && alertSourceKey(config,id);
    if (req.method !== 'POST' || !source || !key || !source.webhook) {reply(404);req.resume();return;}
    const secret = environment[source.webhook.secretEnv];
    if (!secret?.trim()) {reply(503);req.resume();return;}
    const signature = req.headers['sentry-hook-signature'];
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {reply(401);req.resume();return;}
    let bytes=0; const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer) => {
      bytes+=chunk.length;
      if (bytes > 1_000_000) {if (!res.writableEnded) reply(413);chunks.length=0;return;}
      chunks.push(chunk);
    });
    req.on('error',() => {if (!res.writableEnded) reply(400);});
    req.on('end',() => {
      if (res.writableEnded) return;
      const body=Buffer.concat(chunks);
      const expected=createHmac('sha256',secret).update(body).digest();
      if (!timingSafeEqual(expected,Buffer.from(signature,'hex'))) {reply(401);return;}
      let payload:any;
      try {payload=JSON.parse(body.toString('utf8'));} catch {reply(400);return;}
      if (!payload || typeof payload !== 'object' || payload.installation?.uuid !== source.webhook!.installationId) {reply(403);return;}
      // Installation handshake and unrelated signed events are harmless acknowledgements.
      if (req.headers['sentry-hook-resource'] !== 'event_alert' || payload.action !== 'triggered') {reply(204);return;}
      const event=payload.data?.event, issueId=String(event?.issue_id ?? '');
      const env=Array.isArray(event?.tags) ? event.tags.find((t:unknown) => Array.isArray(t) && t[0]==='environment')?.[1] : undefined;
      if (!/^[1-9][0-9]{0,30}$/.test(issueId) || String(event?.project) !== source.sentry.projectId || env !== source.sentry.environment) {reply(403);return;}
      try {
        const result=store.transaction(() => {
          if (alertSourceKey(config,id!) !== key) return 403;
          if (store.db.prepare('SELECT 1 FROM alert_tasks WHERE sourceKey=? AND issueId=?').get(key,issueId)
            || store.db.prepare('SELECT 1 FROM alert_webhooks WHERE sourceKey=? AND issueId=?').get(key,issueId)) return 204;
          if (Number(store.db.prepare('SELECT count(*) n FROM alert_webhooks').get()!.n)>=1000) return 503;
          store.db.prepare('INSERT INTO alert_webhooks(sourceKey,sourceId,issueId,receivedAt) VALUES (?,?,?,?)')
            .run(key,id!,issueId,new Date().toISOString());
          return 202;
        });
        reply(result);
      } catch {reply(503);}
    });
  });
  server.keepAliveTimeout=1000;
  server.maxConnections=32;
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(port,'127.0.0.1',() => {server.off('error',reject);resolve();});});
  return server;
}
