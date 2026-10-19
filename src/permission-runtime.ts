import { taskConcurrency } from './config.js';
import { modelSelection, type ModelSelection } from './models.js';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_MODES } from './permissions.js';
import type { PermissionMode } from './types.js';
type State = { trustedRequesterIds?: string[]; modelSelection?: ModelSelection; activeModelSelection?: ModelSelection; permissionMode: PermissionMode; activeMode?: PermissionMode; active: boolean; activeCount?: number; maxConcurrentTasks?: number };
const file = (stateDir: string) => join(stateDir, 'permission-runtime.json');
export function writePermissionRuntime(stateDir: string, state: State) {
  const target = file(stateDir), temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...state, pid: process.pid, updatedAt: Date.now() }), { mode: 0o600 });
  renameSync(temp, target);
}
export function clearPermissionRuntime(stateDir: string) {
  try { if (JSON.parse(readFileSync(file(stateDir),'utf8')).pid === process.pid) unlinkSync(file(stateDir)); } catch { /* Already absent. */ }
}
export function readPermissionRuntime(stateDir: string): (State & { connected: true }) | { connected: false } {
  try {
    const s = JSON.parse(readFileSync(file(stateDir),'utf8'));
    if (!Number.isSafeInteger(s.pid) || s.pid < 1 || !Number.isFinite(s.updatedAt) || Date.now()-s.updatedAt > 5000 || s.updatedAt > Date.now()+1000
      || !PERMISSION_MODES.includes(s.permissionMode) || typeof s.active !== 'boolean'
      || (s.active && !PERMISSION_MODES.includes(s.activeMode))
      || (s.activeCount !== undefined && (!Number.isInteger(s.activeCount) || s.activeCount < 0 || s.activeCount > 4 || (s.activeCount > 0) !== s.active))) throw Error('Invalid runtime');
    if (s.maxConcurrentTasks !== undefined) taskConcurrency(s.maxConcurrentTasks);
    if (s.trustedRequesterIds !== undefined && (!Array.isArray(s.trustedRequesterIds) || s.trustedRequesterIds.length > 50 || s.trustedRequesterIds.some((id: unknown) => typeof id !== 'string'))) throw Error('Invalid requesters');
    process.kill(s.pid,0);
    const selected = modelSelection(s.modelSelection), activeSelected = modelSelection(s.activeModelSelection);
    return {...(s.trustedRequesterIds !== undefined ? {trustedRequesterIds:s.trustedRequesterIds} : {}), ...(selected ? {modelSelection:selected} : {}), ...(s.active && activeSelected ? {activeModelSelection:activeSelected} : {}), ...(s.maxConcurrentTasks !== undefined ? {maxConcurrentTasks:s.maxConcurrentTasks} : {}), connected:true, permissionMode:s.permissionMode, active:s.active, ...(s.activeCount !== undefined ? {activeCount:s.activeCount} : {}), ...(s.active ? {activeMode:s.activeMode} : {})};
  } catch { return {connected:false}; }
}
