import type { AlertSource } from './alert-config.js';

export interface AlertEvidence {
  issueId: string; title: string; url: string; firstSeen: string; lastSeen: string;
  count: number; userCount: number; release: string; environment: string; exception: unknown[];
}
export interface IssuePage { issues: Array<{id: string}>; next?: string }
export interface AlertConnector {
  list(source: AlertSource, start: string, end: string, cursor: string | undefined, signal: AbortSignal): Promise<IssuePage>;
  evidence(source: AlertSource, issueId: string, signal: AbortSignal): Promise<AlertEvidence>;
}
const hosts = {us:'https://us.sentry.io',eu:'https://de.sentry.io',global:'https://sentry.io'};
export function redactAlertText(value: unknown, limit = 600): string {
  return (typeof value === 'string' ? value : '').slice(0,4000)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi, '[secret]')
    .replace(/[a-zA-Z0-9_+\/-]{32,}(?:\.[a-zA-Z0-9_+\/-]+)*/g, '[identifier]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0,limit);
}
const count = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : '';
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
function sourceFile(value: unknown): string {
  if (typeof value !== 'string') return '';
  try { const u = new URL(value); return redactAlertText(decodeURIComponent(u.pathname).split(/[?#]/)[0],200); }
  catch { return redactAlertText(value.split(/[?#]/)[0],200); }
}

export class SentryConnector implements AlertConnector {
  constructor(private request: typeof fetch = fetch, private environment: NodeJS.ProcessEnv = process.env) {}
  private async get(source: AlertSource, path: string, params: URLSearchParams, signal: AbortSignal) {
    const token = this.environment[source.sentry.tokenEnv];
    if (!token?.trim()) throw Error('Sentry token missing');
    const url = new URL(`/api/0/organizations/${encodeURIComponent(source.sentry.organization)}/${path}`,hosts[source.sentry.region]);
    url.search = params.toString();
    // Never follow API redirects with credentials, log response bodies, or accept remote next-page URLs.
    const response = await this.request(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},
      redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
    if (!response.ok) { await response.body?.cancel(); throw Error(`Sentry HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw Error('Sentry empty response');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const {value,done} = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 2_000_000) throw Error('Sentry response too large'); chunks.push(value);
    } } finally { await reader.cancel(); }
    return {data:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, link:response.headers.get('link')};
  }
  async list(source: AlertSource, start: string, end: string, cursor: string | undefined, signal: AbortSignal): Promise<IssuePage> {
    const p = new URLSearchParams({project:source.sentry.projectId,environment:source.sentry.environment,
      query:'is:unresolved',sort:'date',limit:'20',start,end});
    if (cursor) p.set('cursor',cursor);
    const {data,link} = await this.get(source,'issues/',p,signal);
    if (!Array.isArray(data) || data.length > 20) throw Error('Sentry invalid issue page');
    const issues = data.map(record).filter(i => String(i.project?.id) === source.sentry.projectId
      && /^[1-9][0-9]{0,30}$/.test(String(i.id))).map(i => ({id:String(i.id)}));
    const nextLink = link?.split(',').find(part => /rel="next"/.test(part) && /results="true"/.test(part));
    const next = nextLink?.match(/cursor="([A-Za-z0-9:_-]{1,200})"/)?.[1];
    if (nextLink && !next) throw Error('Sentry invalid pagination');
    return {issues,...(next ? {next} : {})};
  }
  async evidence(source: AlertSource, issueId: string, signal: AbortSignal): Promise<AlertEvidence> {
    if (!/^[1-9][0-9]{0,30}$/.test(issueId)) throw Error('Invalid issue id');
    const {data:issueData} = await this.get(source,`issues/${issueId}/`,new URLSearchParams({environment:source.sentry.environment}),signal);
    const issue = record(issueData);
    if (String(issue.id) !== issueId || String(issue.project?.id) !== source.sentry.projectId) throw Error('Sentry project mismatch');
    const {data:eventData} = await this.get(source,`issues/${issueId}/events/latest/`,
      new URLSearchParams({environment:source.sentry.environment}),signal);
    const event = record(eventData);
    const environment = Array.isArray(event.tags) ? event.tags.find((t: any) => t?.key === 'environment')?.value : undefined;
    if (environment !== source.sentry.environment) throw Error('Sentry environment mismatch');
    const entries = Array.isArray(event.entries) ? event.entries : [];
    const values = entries.find((e: any) => e?.type === 'exception')?.data?.values;
    const exception = (Array.isArray(values) ? values : []).slice(0,3).map(record).map(e => ({
      type:redactAlertText(e.type,100), value:redactAlertText(e.value),
      frames:(Array.isArray(e.stacktrace?.frames) ? e.stacktrace.frames : []).slice(-20).map(record).map((f: Record<string, any>) => ({
        filename:sourceFile(f.filename),function:redactAlertText(f.function,150),
        line:count(f.lineNo),column:count(f.colNo),inApp:f.inApp === true,
      })),
    }));
    return {issueId,title:redactAlertText(issue.title),url:`${hosts[source.sentry.region]}/organizations/${encodeURIComponent(source.sentry.organization)}/issues/${issueId}/`,
      firstSeen:date(issue.firstSeen),lastSeen:date(issue.lastSeen),count:count(issue.count),userCount:count(issue.userCount),
      release:typeof record(event.release).version === 'string' && /^[a-zA-Z0-9_.+-]{1,100}$/.test(record(event.release).version) ? record(event.release).version : '',environment:source.sentry.environment,exception};
  }
}
