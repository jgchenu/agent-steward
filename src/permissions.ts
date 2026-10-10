import type { Config, PermissionMode, Project } from './types.js';

export const PERMISSION_MODES = ['ask', 'auto', 'sandbox-auto', 'full-access'] as const;
export function permissionMode(config: Pick<Config, 'permissionMode' | 'approvalsReviewer'>): PermissionMode {
  if (config.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(config.permissionMode)) throw Error('Invalid permissionMode');
    return config.permissionMode;
  }
  return config.approvalsReviewer === 'auto_review' ? 'auto' : 'ask';
}
export const permissionRank = (mode: PermissionMode) => PERMISSION_MODES.indexOf(mode);
// Execution escalation stays disabled, but browser/MCP confirmations must reach
// the owner instead of being silently declined by App Server's `never` policy.
export const executionOnlyApprovals = () => ({ granular: {
  sandbox_approval: false, rules: false, skill_approval: false,
  request_permissions: false, mcp_elicitations: true,
} });
export function runtimePermissions(mode: PermissionMode, sandbox: Project['sandbox']) {
  if (!PERMISSION_MODES.includes(mode)) throw Error('Invalid permissionMode');
  // A global preference never turns an explicitly read-only task into a write task.
  const full = mode === 'full-access' && sandbox === 'workspace-write';
  return {
    sandbox: full ? 'danger-full-access' as const : sandbox,
    approvalPolicy: (mode === 'full-access' || mode === 'sandbox-auto') ? executionOnlyApprovals() : 'on-request' as const,
    approvalsReviewer: mode === 'auto' ? 'auto_review' as const : 'user' as const,
  };
}
