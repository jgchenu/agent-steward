import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, projectAliases } from './config.js';
import { workspacePage } from './workspace-page.js';

type Candidate = { id: string; label: string; path: string; description?: string; aliases?: string[] };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const git = (path: string, args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function workspaceBase(path: string, label: string): string {
  // An unborn branch cannot seed a worktree. A detached checkout can: pin its commit.
  let commit: string;
  try { commit = git(path, ['rev-parse', '--verify', 'HEAD^{commit}']); }
  catch { throw Error(`${label} 无法读取当前提交，请先确认仓库至少有一次提交且可以访问。`); }
  try { return git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch (error) {
    if ((error as { status?: number }).status === 1) return commit;
    throw Error(`${label} 无法读取当前分支，请检查仓库后重试。`);
  }
}
export class WorkspaceRegistry {
  private catalog: string;
  constructor(readonly file: string) {
    const raw = this.raw();
    const state = resolve(dirname(file), raw.stateDir ?? '.steward');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.catalog = join(state, 'workspace-catalog.json');
  }
  private raw(): any { return JSON.parse(readFileSync(this.file, 'utf8')); }
  private candidates(): Candidate[] {
    const items: Candidate[] = existsSync(this.catalog) ? JSON.parse(readFileSync(this.catalog, 'utf8')) : [];
    if (!Array.isArray(items)) throw Error('工作空间清单格式无效。');
    const map = new Map(items.map(item => [resolve(item.path), item]));
    for (const [id, p] of Object.entries<any>(this.raw().projects ?? {})) {
      const path = resolve(dirname(this.file), p.path);
      map.set(path, { id, label: p.label ?? id, description: p.description, aliases:p.aliases, path });
    }
    return [...map.values()];
  }
  state() {
    const text = readFileSync(this.file, 'utf8'), raw = JSON.parse(text);
    const projects = this.candidates().map(item => {
      let available = false, gitRepository = false;
      try { available = statSync(item.path).isDirectory(); gitRepository = available && realpathSync(git(item.path, ['rev-parse', '--show-toplevel'])) === realpathSync(item.path); } catch { /* not a Git root */ }
      const configured = Object.entries<any>(raw.projects ?? {}).find(([, p]) => resolve(dirname(this.file), p.path) === item.path);
      const mode = configured?.[1].sandbox ?? (configured ? 'read-only' : 'none');
      return { ...item, id: configured?.[0] ?? item.id, available, gitRepository, mode,
        default: configured?.[0] === raw.defaultProject, baseRef: configured?.[1].worktree?.baseRef };
    });
    return { revision: digest(text), projects };
  }
  add(path: string, label: string): void {
    if (typeof path !== 'string' || typeof label !== 'string' || !label.trim() || label.length > 40) throw Error('请填写有效的名称和目录。');
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw Error('请选择已有目录。');
    const items = this.candidates();
    if (items.some(i => i.path === canonical)) throw Error('该目录已在列表里。');
    items.push({ id: 'p_' + digest(canonical).slice(0, 10), label: label.trim(), path: canonical });
    this.write(this.catalog, items);
  }
  private write(file: string, value: unknown): void {
    const temp = file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  }
  apply(input: { revision: string; grants: Array<{ id: string; mode: string; aliases?: string[] }>; defaultProject?: string }) {
    const state = this.state();
    if (input.revision !== state.revision) throw Error('配置已变化，请刷新页面后再保存。');
    if (!Array.isArray(input.grants) || input.grants.length !== state.projects.length) throw Error('项目清单不完整，请刷新。');
    const raw = this.raw(), projects: Record<string, any> = Object.create(null), seen = new Set<string>();
    for (const grant of input.grants) {
      const item = state.projects.find(p => p.id === grant.id);
      if (!item || seen.has(grant.id) || !['none', 'read-only', 'workspace-write'].includes(grant.mode)) throw Error('项目或权限无效。');
      seen.add(grant.id);
      item.aliases = projectAliases(grant.aliases ?? item.aliases, item.label);
      if (grant.mode === 'none') continue;
      if (!item.available) throw Error(`目录不存在：${item.label}`);
      const previous = raw.projects?.[grant.id];
      const p: any = { ...previous, path: item.path, label: item.label, aliases:item.aliases, ...(item.description ? { description: item.description } : {}), sandbox: grant.mode, naturalMode: grant.mode };
      if (grant.mode === 'workspace-write' && !p.worktree) {
        if (!item.gitRepository) throw Error(`${item.label} 不是 Git 仓库根目录，当前只能只读授权。`);
        // Use this workspace's own branch, never a guessed production/default branch.
        p.worktree = { baseRef: workspaceBase(item.path, item.label), checks: [] };
      }
      projects[grant.id] = p;
    }
    if (!Object.keys(projects).length) throw Error('请至少保留一个通用分析空间。');
    if (input.defaultProject && !Object.hasOwn(projects, input.defaultProject)) throw Error('默认空间必须已经授权。');
    const next = { ...raw, projects, ...(input.defaultProject ? { defaultProject: input.defaultProject } : {}) };
    if (!input.defaultProject) delete next.defaultProject;
    // Validate before replacement; the existing application identity and unrelated settings survive.
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      loadConfig(temp);
      if (digest(readFileSync(this.file, 'utf8')) !== input.revision) throw Error('配置已变化，请刷新后重试。');
      // Retain revoked projects in the catalog so they remain visible as unauthorized.
      this.write(this.catalog, state.projects.map(({ id, label, path, description, aliases }) => ({ id, label, path, description, aliases })));
      renameSync(temp, this.file);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    return this.state();
  }
}
export async function startWorkspaceConsole(file: string, port = 0) {
  const registry = new WorkspaceRegistry(resolve(file));
  const token = randomUUID(); let origin = '';
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (code: number, data: unknown) => { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    if (req.headers.host !== new URL(origin).host) { send(403, {error: '仅允许本机访问。'}); return; }
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(workspacePage(token)); return;
    }
    if (req.headers['x-steward-console'] !== token || (req.method !== 'GET' && req.headers.origin !== origin)) { send(403, {error: '请从本机授权页面操作。'}); return; }
    try {
      if (req.method === 'GET' && req.url === '/api/state') { send(200, registry.state()); return; }
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') { send(405, {error:'不支持的请求。'}); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 64_000) throw Error('请求过大。'); }
      const data = JSON.parse(body);
      if (req.url === '/api/grants') send(200, registry.apply(data));
      else if (req.url === '/api/candidates') { registry.add(data.path, data.label); send(200, registry.state()); }
      else send(404, {error:'未找到。'});
    } catch (e) { send(400, {error:e instanceof Error ? e.message : '保存失败。'}); }
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('无法打开本地页面。');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin + '/' };
}
