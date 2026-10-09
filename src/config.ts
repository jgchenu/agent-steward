import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config, Project } from './types.js';

export function loadConfig(file = process.env.STEWARD_CONFIG ?? 'steward.config.json'): Config {
  const base = dirname(resolve(file));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const ownerId = process.env.STEWARD_OWNER_ID?.trim();
  if (!ownerId) throw new Error('STEWARD_OWNER_ID is required; there is no public/default owner.');
  if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
    throw new Error('Configure at least one project.');
  }
  const projects: Record<string, Project> = Object.create(null);
  for (const [name, value] of Object.entries(raw.projects)) {
    const p = value as Project;
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !p || typeof p.path !== 'string') {
      throw new Error(`Invalid project: ${name}`);
    }
    const sandbox = p.sandbox ?? 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error(`Invalid sandbox: ${name}`);
    const path = realpathSync(resolve(base, p.path));
    if (!statSync(path).isDirectory()) throw new Error(`Project is not a directory: ${name}`);
    projects[name] = { path, sandbox };
  }
  if (!Object.keys(projects).length) throw new Error('Configure at least one project.');
  const maxRunMinutes = raw.maxRunMinutes ?? 60;
  if (!Number.isFinite(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 1440) {
    throw new Error('maxRunMinutes must be between 1 and 1440.');
  }
  return { ownerId, projects, maxRunMinutes, stateDir: resolve(base, raw.stateDir ?? '.steward'),
    codexCommand: raw.codexCommand ?? 'codex' };
}
