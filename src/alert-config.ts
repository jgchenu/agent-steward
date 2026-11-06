import { createHash } from 'node:crypto';
import { projectGrantKey } from './routing.js';
import type { Config } from './types.js';

export interface AlertSource {
  kind: 'sentry'; enabled: boolean; project: string; chatId: string;
  mode: 'read-only' | 'workspace-write'; pollSeconds: number; maxTasksPerDay: number;
  sentry: { region: 'us' | 'eu' | 'global'; organization: string; projectId: string;
    environment: string; tokenEnv: string };
}

export function alertSources(raw: unknown): Record<string, AlertSource> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 10) throw Error('Invalid alertSources');
  const result: Record<string, AlertSource> = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    const s = value as AlertSource, p = s?.sentry;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || s?.kind !== 'sentry' || typeof s.enabled !== 'boolean'
      || typeof s.project !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.project) || !/^oc_[a-zA-Z0-9_-]{1,128}$/.test(s.chatId)
      || !['read-only', 'workspace-write'].includes(s.mode) || !p
      || typeof p.organization !== 'string' || !['us','eu','global'].includes(p.region) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(p.organization)
      || typeof p.projectId !== 'string' || !/^[1-9][0-9]{0,30}$/.test(p.projectId) || typeof p.environment !== 'string'
      || !p.environment.trim() || p.environment.length > 80 || /[\r\n\0]/.test(p.environment)
      || !/^STEWARD_SENTRY_[A-Z0-9_]+_TOKEN$/.test(p.tokenEnv)) throw Error(`Invalid alert source: ${id}`);
    const pollSeconds = s.pollSeconds ?? 300, maxTasksPerDay = s.maxTasksPerDay ?? 5;
    if (!Number.isInteger(pollSeconds) || pollSeconds < 60 || pollSeconds > 86400
      || !Number.isInteger(maxTasksPerDay) || maxTasksPerDay < 1 || maxTasksPerDay > 20) throw Error(`Invalid alert limits: ${id}`);
    result[id] = {kind:'sentry',enabled:s.enabled,project:s.project,chatId:s.chatId,mode:s.mode,pollSeconds,maxTasksPerDay,
      sentry:{region:p.region,organization:p.organization,projectId:p.projectId,environment:p.environment,tokenEnv:p.tokenEnv}};
  }
  return result;
}

// Bind queued work to the exact local authorization, not to data from Sentry.
export function alertSourceKey(config: Config, id: string): string | undefined {
  const source = config.alertSources?.[id], project = source && config.projects[source.project];
  if (!source?.enabled || !project || (source.mode === 'workspace-write'
    && (project.sandbox !== 'workspace-write' || !project.worktree || project.workspaceMode === 'direct'))) return;
  return createHash('sha256').update(JSON.stringify({id,owner:config.ownerId,source,grant:projectGrantKey(project)})).digest('hex');
}
