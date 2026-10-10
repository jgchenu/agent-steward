import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { CodexRpc } from './adapters/rpc.js';
import type { Config, Project } from './types.js';

export interface CodexProject { id: string; name: string; roots: string[] }
export async function listCodexProjects(command = 'codex', cwd = process.cwd()): Promise<CodexProject[]> {
  const rpc = new CodexRpc(command, cwd);
  try {
    await rpc.initialize();
    const projects: CodexProject[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await rpc.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw Error('Codex 项目列表格式不兼容。');
      for (const p of page.data) {
        if (typeof p.id !== 'string' || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.roots)
          || !p.roots.length || p.roots.some((r: any) => typeof r.path !== 'string' || !r.path.startsWith('/'))) throw Error('Codex 项目列表格式不兼容。');
        if (projects.some(x => x.id === p.id)) throw Error('Codex 项目列表重复。');
        projects.push({ id: p.id, name: p.name, roots: p.roots.map((r: { path: string }) => resolve(r.path)) });
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw Error('Codex 项目分页无效。');
      if (cursor) cursors.add(cursor);
      if (projects.length > 2000) throw Error('Codex 项目数量超出支持范围。');
    } while (cursor);
    return projects;
  } finally { await rpc.close(); }
}
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
export const codexKey = (id: string) => 'p_' + createHash('sha256').update(id).digest('hex').slice(0, 16);
// Migrate an old path grant only to one unambiguous Codex identity, never every project sharing that directory.
export function projectBindings(projects: Record<string, Project>, catalog: CodexProject[], base: string) {
  return catalog.map(c => {
    const exact = Object.entries(projects).find(([, p]) => p.codexProjectId === c.id && canonical(resolve(base, p.path)) === canonical(c.roots[0]));
    const legacy = Object.entries(projects).filter(([, p]) => !p.codexProjectId && canonical(resolve(base, p.path)) === canonical(c.roots[0]));
    const named = legacy.filter(([id, p]) => (p.label ?? id) === c.name);
    const grant = exact ?? (named.length === 1 && catalog.filter(x => canonical(x.roots[0]) === canonical(c.roots[0]) && x.name === c.name).length === 1 ? named[0] : catalog.filter(x => canonical(x.roots[0]) === canonical(c.roots[0])).length === 1 && legacy.length === 1 ? legacy[0] : undefined);
    return { codex: c, id: grant?.[0] ?? codexKey(c.id), project: grant?.[1] };
  });
}
export function scopeToCodex(config: Config, catalog: CodexProject[]): Config {
  const projects: Record<string, Project> = Object.create(null);
  for (const b of projectBindings(config.projects, catalog, '/')) if (b.project) projects[b.id] = { ...b.project, label: b.codex.name, codexProjectId: b.codex.id };
  return { ...config, projects, codexProjects: catalog, defaultProject: undefined };
}

// Pin migrated grants once; later project recreation at the same path is a different authorization.
export function pinCodexGrants(file: string, catalog: CodexProject[]): void {
  const before = readFileSync(file,'utf8'), raw = JSON.parse(before);
  const projects = Object.fromEntries(projectBindings(raw.projects ?? {},catalog,dirname(resolve(file))).filter(b=>b.project)
    .map(b=>[b.id,{...b.project,codexProjectId:b.codex.id,label:b.codex.name}]));
  const next = {...raw,projects}; delete next.defaultProject;
  const text = JSON.stringify(next,null,2)+'\n';
  if (JSON.stringify(raw) === JSON.stringify(next)) return;
  const backup = file + '.before-codex-projects.json';
  if (!existsSync(backup)) writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp,text,{mode:0o600,flag:'wx'});
    if (readFileSync(file,'utf8') !== before) throw Error('Project configuration changed during migration.');
    renameSync(temp,file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
