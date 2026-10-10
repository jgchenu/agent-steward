import { modelSelection } from './models.js';
import { projectBindings, type CodexProject } from './codex-projects.js';
import { permissionMode } from './permissions.js';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config, Project } from './types.js';

export function projectAliases(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 10 || value.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 40 || /[\r\n\0]/.test(alias))) throw new Error(`Invalid project aliases: ${name}`);
  return [...new Set(value.map(alias => (alias as string).trim()))];
}

export function loadConfig(file = process.env.STEWARD_CONFIG ?? 'steward.config.json', catalog?: CodexProject[]): Config {
  const base = dirname(resolve(file));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const ownerId = process.env.STEWARD_OWNER_ID?.trim();
  if (!ownerId) throw new Error('STEWARD_OWNER_ID is required; there is no public/default owner.');
  if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
    throw new Error('projects must be an object.');
  }
  if (catalog) {
    raw.projects = Object.fromEntries(projectBindings(raw.projects, catalog, base).filter(b => b.project).map(b => [b.id, {...b.project, label:b.codex.name, codexProjectId:b.codex.id}]));
    delete raw.defaultProject;
  }
  const projects: Record<string, Project> = Object.create(null);
  for (const [name, value] of Object.entries(raw.projects)) {
    const p = value as Project;
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !p || typeof p.path !== 'string') {
      throw new Error(`Invalid project: ${name}`);
    }
    for (const [field, limit] of [['label', 40], ['description', 200]] as const) {
      if (p[field] !== undefined && (typeof p[field] !== 'string' || !p[field]!.trim() || p[field]!.length > limit)) throw new Error(`Invalid project ${field}: ${name}`);
    }
    const aliases = projectAliases(p.aliases, name);
    const sandbox = p.sandbox ?? 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error(`Invalid sandbox: ${name}`);
    if (p.naturalMode !== undefined && (!['read-only', 'workspace-write'].includes(p.naturalMode) || (p.naturalMode === 'workspace-write' && sandbox !== 'workspace-write'))) throw new Error(`Invalid naturalMode: ${name}`);
    const path = realpathSync(resolve(base, p.path));
    if (!statSync(path).isDirectory()) throw new Error(`Project is not a directory: ${name}`);
    let worktree: Project['worktree'];
    if (p.worktree !== undefined) {
      const w = p.worktree;
      if (!w || typeof w.baseRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(w.baseRef)
        || w.baseRef.includes('..') || !Array.isArray(w.checks)) throw new Error(`Invalid worktree config: ${name}`);
      if (w.checks.length > 10 || w.checks.some(c => !c || typeof c.name !== 'string' || !c.name.trim()
        || typeof c.command !== 'string' || !c.command || /[\r\n\0]/.test(c.command)
        || !Array.isArray(c.args) || c.args.some(a => typeof a !== 'string' || a.includes('\0'))
        || (c.timeoutSeconds !== undefined && (!Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 1800)))) {
        throw new Error(`Invalid validation checks: ${name}`);
      }
      if (w.github && (!/^[\w.-]+\/[\w.-]+$/.test(w.github.repository)
        || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(w.github.baseBranch) || w.github.baseBranch.includes('..')
        || w.baseRef !== `origin/${w.github.baseBranch}`)) throw new Error(`Invalid GitHub target: ${name}`);
      worktree = { baseRef: w.baseRef, checks: w.checks, ...(w.github ? { github: w.github } : {}) };
    }
    if (sandbox === 'workspace-write' && !worktree) throw new Error(`workspace-write requires an isolated worktree: ${name}`);
    if (p.codexProjectId !== undefined && typeof p.codexProjectId !== 'string') throw Error('Invalid Codex project identity');
    projects[name] = { path, sandbox, ...(p.codexProjectId ? { codexProjectId: p.codexProjectId } : {}), ...(aliases ? { aliases } : {}), ...(p.naturalMode ? { naturalMode: p.naturalMode } : {}), ...(p.label ? { label: p.label.trim() } : {}), ...(p.description ? { description: p.description.trim() } : {}), ...(worktree ? { worktree } : {}) };
  }
  if (raw.defaultProject !== undefined && (typeof raw.defaultProject !== 'string' || !Object.hasOwn(projects, raw.defaultProject))) throw new Error('defaultProject must name a configured project.');
  if (raw.groupChats !== undefined && typeof raw.groupChats !== 'boolean') throw new Error('groupChats must be boolean.');
  if (raw.approvalsReviewer !== undefined && !['user', 'auto_review'].includes(raw.approvalsReviewer)) throw new Error('approvalsReviewer must be user or auto_review.');
  const maxRunMinutes = raw.maxRunMinutes ?? 60;
  if (!Number.isFinite(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 1440) {
    throw new Error('maxRunMinutes must be between 1 and 1440.');
  }
  return { ownerId, projects, modelSelection:modelSelection(raw.modelSelection), ...(catalog ? {codexProjects:catalog} : {}), maxRunMinutes, permissionMode: permissionMode(raw), approvalsReviewer: raw.approvalsReviewer ?? 'user', defaultProject: raw.defaultProject, groupChats: raw.groupChats ?? false, stateDir: resolve(base, raw.stateDir ?? '.steward'),
    codexCommand: raw.codexCommand ?? 'codex' };
}
