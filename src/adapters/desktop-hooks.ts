import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Suppress only the known desktop approval UI for this child process. Do not
// disable the hooks feature, other events, repository policy or managed hooks.
export function desktopApprovalPlan(home = homedir(), codexHome = process.env.CODEX_HOME ?? join(home,'.codex')): { overrides: string[]; hooks: Array<{key:string; command:string}> } {
  const file = resolve(codexHome,'hooks.json');
  let raw: any;
  try { raw=JSON.parse(readFileSync(file,'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {overrides:[],hooks:[]};
    throw Error('无法读取 Codex 桌面审批钩子配置；未改变审批策略。');
  }
  const groups=raw?.hooks?.PermissionRequest;
  if (groups === undefined) return {overrides:[],hooks:[]};
  if (!Array.isArray(groups)) throw Error('Codex PermissionRequest 配置格式不兼容。');
  const bridge=join(home,'.codeisland','codeisland-bridge');
  const commands=[`${bridge} --source codex`, `'${bridge}' --source codex`, `"${bridge}" --source codex`];
  const hooks: Array<{key:string; command:string}> = groups.flatMap((group: any,i: number) => Array.isArray(group?.hooks) ? group.hooks.flatMap((hook: any,j: number) =>
    hook?.type === 'command' && commands.includes(hook.command)
      ? [{key:`${file}:permission_request:${i}:${j}`,command:hook.command}] : []) : []);
  return {hooks,overrides:hooks.length ? [`hooks.state={${hooks.map(h=>`${JSON.stringify(h.key)} = { enabled = false }`).join(',')}}`] : []};
}
