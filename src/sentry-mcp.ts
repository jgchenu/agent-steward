import { alertSourceKey } from './alert-config.js';
import type { Config, Task } from './types.js';
import type { Store } from './store.js';

export interface SentryMcp { organization: string; project: string; environment: string }
export function sentryMcpForTask(store: Store, config: Config, task: Task): SentryMcp | undefined {
  const binding=store.db.prepare('SELECT sourceId,sourceKey FROM alert_tasks WHERE taskId=?').get(task.id);
  if (!binding || alertSourceKey(config,String(binding.sourceId))!==binding.sourceKey) return;
  const sentry=config.alertSources![String(binding.sourceId)].sentry;
  if (sentry.mcpProject) return {organization:sentry.organization,project:sentry.mcpProject,environment:sentry.environment};
}
export function sentryMcpOverrides(scope?: SentryMcp): string[] {
  if (!scope) return [];
  if (![scope.organization,scope.project].every(v => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v))) throw Error('Invalid Sentry MCP scope');
  const prefix='mcp_servers.steward_sentry';
  return [
    `${prefix}.url=${JSON.stringify(`https://mcp.sentry.dev/mcp/${scope.organization}/${scope.project}`)}`,
    `${prefix}.enabled=true`,`${prefix}.required=true`,`${prefix}.startup_timeout_sec=30`,`${prefix}.tool_timeout_sec=60`,
    // No mutation, Seer, generic execution gateway, or arbitrary remote URL tool.
    `${prefix}.enabled_tools=["get_sentry_resource","get_issue_details","get_issue_events","search_issues","search_events","search_errors"]`,
  ];
}
