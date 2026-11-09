import { createHash } from 'node:crypto';
import { alertSourceKey } from './alert-config.js';
import { alertBindingForTask } from './alert-provenance.js';
import { redactAlertText, type AlertEvidence } from './sentry.js';
import type { Store } from './store.js';
import type { Config } from './types.js';

export const ALERT_RECHECK_MS=3600_000;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const evidenceSignature=(e:AlertEvidence)=>hash([e.release,e.exception,e.extensionOrigins ?? [],e.completeStack ?? false]);

// An exact, locally confirmed signature is required. An extension marker alone is not a verdict.
export function noiseSignature(e:AlertEvidence):string | undefined {
  if (!e.completeStack || !e.extensionOrigins?.length || e.extensionOrigins.length>3
    || !e.extensionOrigins.every(x=>/^chrome-extension:\/\/[a-p]{32}$/.test(x)) || !e.exception.length) return;
  for (const value of e.exception) {
    const ex=value as {frames?:Array<{absPath?:string;inApp?:boolean}>};
    if (!ex?.frames?.length || ex.frames.some(f=>!f.absPath || !/^(app:\/\/\/|chrome-extension:\/\/)/.test(f.absPath))) return;
  }
  return hash([e.exception,e.extensionOrigins]);
}

interface Observation {latest:string;baseline:string|null;handledAt:number;pendingNoise:number;noiseEvent:string|null}
export function observeAlert(store:Store,key:string,e:AlertEvidence,now:number):{reason?:string;previousTask?:string;comparison?:unknown;wait?:boolean} {
  const db=store.db, old=db.prepare('SELECT * FROM alert_observations WHERE sourceKey=? AND issueId=?').get(key,e.issueId) as unknown as Observation | undefined;
  const previous=db.prepare('SELECT taskId FROM alert_runs WHERE sourceKey=? AND issueId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(key,e.issueId)
    ?? db.prepare('SELECT taskId FROM alert_tasks WHERE sourceKey=? AND issueId=?').get(key,e.issueId);
  const latest=JSON.stringify(e),signature=evidenceSignature(e);
  db.prepare('INSERT INTO alert_observations(sourceKey,issueId,latest) VALUES (?,?,?) ON CONFLICT(sourceKey,issueId) DO UPDATE SET latest=excluded.latest').run(key,e.issueId,latest);
  const rule=db.prepare('SELECT signature FROM alert_noise_rules WHERE sourceKey=? AND issueId=?').get(key,e.issueId);
  if (rule && rule.signature===noiseSignature(e)) {
    const eventKey=hash([signature,e.eventId || e.lastSeen,e.eventId ? '' : e.count]);
    db.prepare('UPDATE alert_observations SET baseline=?,handledAt=?,noiseEvent=?,pendingNoise=pendingNoise+? WHERE sourceKey=? AND issueId=?')
      .run(latest,now,eventKey,old?.noiseEvent===eventKey ? 0 : 1,key,e.issueId);
    return {};
  }
  // Never send a stale noise digest after the evidence stops matching.
  db.prepare('UPDATE alert_observations SET pendingNoise=0 WHERE sourceKey=? AND issueId=?').run(key,e.issueId);
  if (!old?.baseline && previous) {
    // Upgrade baseline: historical tasks are not silently replayed on installation.
    markAlertHandled(store,key,e,now);
    db.prepare("UPDATE alert_runs SET signature=? WHERE sourceKey=? AND issueId=? AND signature=''").run(signature,key,e.issueId);
    return {};
  }
  const baseline=old?.baseline ? JSON.parse(old.baseline) as AlertEvidence : undefined;
  const seen=db.prepare('SELECT 1 FROM alert_runs WHERE sourceKey=? AND issueId=? AND signature=?').get(key,e.issueId,signature);
  const grew=baseline && ((e.count>=baseline.count*2 && e.count-baseline.count>=100)
    || (e.userCount>=baseline.userCount*2 && e.userCount-baseline.userCount>=10));
  const changed=baseline && evidenceSignature(baseline)!==signature && !seen;
  // Leaving a noise match is always reconsidered, including a previously seen business stack.
  const lostNoise=!!old?.noiseEvent;
  if (baseline && !changed && !grew && !lostNoise) return {};
  const reason=!baseline ? '首次发现' : lostNoise ? '已确认噪声的来源或堆栈不再匹配' : changed ? '发现未分析的版本、堆栈或来源' : 'issue 累计影响增长（非错误率）';
  let busy=false;
  for (const task of db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_input','waiting_approval','interrupted')").all()) {
    try {const b=alertBindingForTask(store,String(task.id));if (b?.sourceKey===key && b.issueId===e.issueId) busy=true;}
    catch {busy=true;}
  }
  const comparison=baseline ? {previous:{release:baseline.release,count:baseline.count,userCount:baseline.userCount},
    current:{release:e.release,count:e.count,userCount:e.userCount},stackOrSourceChanged:noiseSignature(baseline)!==noiseSignature(e) || hash(baseline.exception)!==hash(e.exception)} : undefined;
  return {reason,comparison,previousTask:previous ? String(previous.taskId) : undefined,wait:busy || (!!baseline && now-old!.handledAt<ALERT_RECHECK_MS)};
}

export function markAlertHandled(store:Store,key:string,e:AlertEvidence,now:number):void {
  store.db.prepare('UPDATE alert_observations SET baseline=?,handledAt=?,noiseEvent=NULL WHERE sourceKey=? AND issueId=?').run(JSON.stringify(e),now,key,e.issueId);
}

// Only an explicit local operator command calls this; no model output or webhook can grant a rule.
export function confirmAlertNoise(store:Store,config:Config,id:string,issueId:string,expectedSignature:string,reason:string,now=Date.now()):void {
  const key=alertSourceKey(config,id),safeReason=redactAlertText(reason,300).trim();
  if (!key || !safeReason) throw Error('Noise rule requires an enabled authorized source and reason');
  store.transaction(()=>{
    const row=store.db.prepare('SELECT latest FROM alert_observations WHERE sourceKey=? AND issueId=?').get(key,issueId);
    const signature=row && noiseSignature(JSON.parse(String(row.latest)) as AlertEvidence);
    if (!signature) throw Error('Noise rule requires complete extension stack evidence');
    if (signature!==expectedSignature) throw Error('Noise rule requires review of the current evidence signature');
    store.db.prepare('INSERT INTO alert_noise_rules VALUES (?,?,?,?,?) ON CONFLICT(sourceKey,issueId) DO UPDATE SET signature=excluded.signature,reason=excluded.reason,confirmedAt=excluded.confirmedAt')
      .run(key,issueId,signature,safeReason,now);
    store.db.prepare('UPDATE alert_observations SET noiseEvent=NULL,pendingNoise=0 WHERE sourceKey=? AND issueId=?').run(key,issueId);
  });
}

export function clearAlertNoise(store:Store,config:Config,id:string,issueId:string):void {
  const key=alertSourceKey(config,id);if (!key) throw Error('Noise rule requires an enabled authorized source and reason');
  store.transaction(()=>{
    store.db.prepare('DELETE FROM alert_noise_rules WHERE sourceKey=? AND issueId=?').run(key,issueId);
    store.db.prepare('UPDATE alert_observations SET pendingNoise=0 WHERE sourceKey=? AND issueId=?').run(key,issueId);
  });
}

export function flushNoiseDigests(store:Store,config:Config,now:number):void {
  for (const [id,source] of Object.entries(config.alertSources ?? {})) {
    const key=alertSourceKey(config,id);if (!key) continue;
    store.transaction(()=>{
      const previous=store.db.prepare('SELECT sentAt FROM alert_digests WHERE sourceKey=?').get(key);
      if (previous && now-Number(previous.sentAt)<ALERT_RECHECK_MS) return;
      const rows=store.db.prepare(`SELECT o.issueId,o.latest,o.pendingNoise FROM alert_observations o JOIN alert_noise_rules r
        ON r.sourceKey=o.sourceKey AND r.issueId=o.issueId WHERE o.sourceKey=? AND o.pendingNoise>0 ORDER BY o.issueId LIMIT 20`).all(key);
      if (!rows.length) return;
      const lines=rows.map(r=>{const e=JSON.parse(String(r.latest)) as AlertEvidence;return `issue ${r.issueId}：${r.pendingNoise} 次采样匹配\n${e.url}`;});
      store.enqueue(source.chatId,`监控噪声汇总（${id}）\n${lines.join('\n')}\n样本与本机确认的扩展来源和堆栈一致，未创建修复任务。采样数不代表错误总数；来源或堆栈变化会重新分析。`,{kind:'notice'});
      for (const r of rows) store.db.prepare('UPDATE alert_observations SET pendingNoise=0 WHERE sourceKey=? AND issueId=?').run(key,String(r.issueId));
      store.db.prepare('INSERT INTO alert_digests VALUES (?,?) ON CONFLICT(sourceKey) DO UPDATE SET sentAt=excluded.sentAt').run(key,now);
    });
  }
}
