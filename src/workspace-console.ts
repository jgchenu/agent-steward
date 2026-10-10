import { listCodexModels, modelSelection, validateSelection, type CodexModel, type ModelSelection } from './models.js';
import { listCodexProjects, projectBindings, type CodexProject } from './codex-projects.js';
import { permissionMode, PERMISSION_MODES } from './permissions.js';
import { readPermissionRuntime } from './permission-runtime.js';
import type { PermissionMode } from './types.js';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, projectAliases } from './config.js';
import { workspacePage } from './workspace-page.js';

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
  constructor(readonly file: string, private catalog: () => CodexProject[]) {}
  private raw(): any { return JSON.parse(readFileSync(this.file, 'utf8')); }
  state() {
    const text = readFileSync(this.file, 'utf8'), raw = JSON.parse(text), catalog = this.catalog();
    const projects = projectBindings(raw.projects ?? {}, catalog, dirname(this.file)).map(({codex, id, project}) => {
      const path = codex.roots[0]; let available = false, gitRepository = false;
      try { available = statSync(path).isDirectory(); gitRepository = available && realpathSync(git(path, ['rev-parse','--show-toplevel'])) === realpathSync(path); } catch {}
      const aliases = project?.aliases ?? raw.projectPreferences?.[codex.id]?.aliases ?? [];
      return { id, codexProjectId: codex.id, label: codex.name, path, roots: codex.roots, available, gitRepository,
        aliases, mode: project?.sandbox ?? 'none', baseRef: project?.worktree?.baseRef };
    });
    return { modelSelection:modelSelection(raw.modelSelection), revision: digest(text + JSON.stringify(catalog)), projects, permissionMode: permissionMode(raw),
      runtime: readPermissionRuntime(resolve(dirname(this.file), raw.stateDir ?? '.steward')) };
  }
  apply(input: { revision: string; grants: Array<{id: string; mode: string; aliases?: string[]}>; permissionMode?: PermissionMode; confirmFullAccess?: boolean; modelSelection?: ModelSelection }, models: CodexModel[] = []) {
    const state = this.state();
    const selected = modelSelection(input.modelSelection);
    if (selected && JSON.stringify(selected) !== JSON.stringify(state.modelSelection)) validateSelection(selected, models);
    if (input.revision !== state.revision) throw Error('Codex 项目或配置已变化，请刷新后再保存。');
    if (!Array.isArray(input.grants) || input.grants.length !== state.projects.length) throw Error('项目清单不完整，请刷新。');
    if (input.permissionMode !== undefined && !PERMISSION_MODES.includes(input.permissionMode)) throw Error('审批模式无效。');
    if (input.permissionMode === 'full-access' && state.permissionMode !== 'full-access' && input.confirmFullAccess !== true) throw Error('请明确确认完全访问权限的范围后再保存。');
    const raw = this.raw(), projects: Record<string, any> = Object.create(null), preferences: Record<string, any> = Object.create(null), seen = new Set<string>();
    for (const grant of input.grants) {
      const item = state.projects.find(p => p.id === grant.id);
      if (!item || seen.has(grant.id) || !['none','read-only','workspace-write'].includes(grant.mode)) throw Error('无效的项目授权。');
      seen.add(grant.id);
      const aliases = projectAliases(grant.aliases ?? item.aliases, item.label);
      preferences[item.codexProjectId] = {aliases};
      if (grant.mode === 'none') continue;
      if (!item.available) throw Error(`${item.label} 目录不可用。`);
      const previous = raw.projects?.[grant.id];
      const p: any = { ...previous, codexProjectId: item.codexProjectId, path:item.path, label:item.label, aliases, sandbox:grant.mode, naturalMode:grant.mode };
      if (grant.mode === 'workspace-write' && !p.worktree) {
        if (!item.gitRepository) throw Error(`${item.label} 不是 Git 仓库根目录，当前只能只读授权。`);
        p.worktree = {baseRef:workspaceBase(item.path,item.label),checks:[]};
      }
      projects[grant.id] = p;
    }
    const next = {...raw, ...(selected ? {modelSelection:selected} : {}), ...(input.permissionMode ? {permissionMode:input.permissionMode} : {}), projects, projectPreferences:preferences};
    delete next.defaultProject;
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'}); loadConfig(temp);
      if (this.state().revision !== input.revision) throw Error('Codex 项目或配置已变化，请刷新后再保存。');
      renameSync(temp,this.file);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    return this.state();
  }
}
export async function startWorkspaceConsole(file: string, port = 0, discover?: () => Promise<CodexProject[]>, discoverModels?: () => Promise<CodexModel[]>) {
  const command = JSON.parse(readFileSync(file,'utf8')).codexCommand ?? 'codex';
  const read = discover ?? (() => listCodexProjects(command, dirname(resolve(file))));
  let catalog: CodexProject[] = [], updatedAt = 0, inflight: Promise<void> | undefined;
  const refresh = (force = false) => {
    if (inflight) return inflight;
    if (!force && Date.now()-updatedAt < 10_000) return Promise.resolve();
    inflight = read().then(p => {catalog=p;updatedAt=Date.now();}).catch(() => {catalog=[];throw Error('无法读取 Codex 项目，请确认本机 Codex 可用后重新加载。');}).finally(() => {inflight=undefined;});
    return inflight;
  };
  const registry = new WorkspaceRegistry(resolve(file), () => catalog);
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
      if (req.method === 'GET' && req.url === '/api/models') { send(200, await (discoverModels ?? (() => listCodexModels(command, dirname(resolve(file)))))()); return; }
      if (req.method === 'GET' && req.url === '/api/state') { await refresh(); send(200, registry.state()); return; }
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') { send(405, {error:'不支持的请求。'}); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 64_000) throw Error('请求过大。'); }
      const data = JSON.parse(body);
      if (req.url === '/api/grants') { await refresh(true); const changed = data.modelSelection && JSON.stringify(data.modelSelection) !== JSON.stringify(registry.state().modelSelection);
        const models = changed ? await (discoverModels ?? (() => listCodexModels(command,dirname(resolve(file)))))() : [];
        send(200, registry.apply(data,models)); }
      else send(404, {error:'未找到。'});
    } catch (e) { send(400, {error:e instanceof Error ? e.message : '保存失败。'}); }
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('无法打开本地页面。');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin + '/' };
}
