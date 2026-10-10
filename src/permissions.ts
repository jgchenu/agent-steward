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
export function runtimePermissions(mode: PermissionMode, sandbox: Project['sandbox']) {
  if (!PERMISSION_MODES.includes(mode)) throw Error('Invalid permissionMode');
  // A global preference never turns an explicitly read-only task into a write task.
  const full = mode === 'full-access' && sandbox === 'workspace-write';
  return {
    sandbox: full ? 'danger-full-access' as const : sandbox,
    approvalPolicy: (mode === 'full-access' || mode === 'sandbox-auto') ? 'never' as const : 'on-request' as const,
    approvalsReviewer: mode === 'auto' ? 'auto_review' as const : 'user' as const,
  };
}
