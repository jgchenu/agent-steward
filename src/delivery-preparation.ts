import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { git } from './workspace.js';
import type { BaselineProposal, Config, Project, Task } from './types.js';

const refValid = (ref: unknown): ref is string => typeof ref === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(ref) && !ref.includes('..');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(value,k));
export function parseBaselineProposal(value: unknown): BaselineProposal {
  const invalid = () => new Error('更换版本提议格式无效，未创建副本或修改交付配置。');
  if (!object(value) || !exact(value,['ref','migrateChanges','delivery']) || !refValid(value.ref) || typeof value.migrateChanges !== 'boolean') throw invalid();
  const d=value.delivery;
  if (d !== null) {
    if (!object(d) || !exact(d,['repository','baseBranch','checks']) || typeof d.repository !== 'string'
      || !/^[\w.-]+\/[\w.-]+$/.test(d.repository) || !refValid(d.baseBranch) || value.ref !== `origin/${d.baseBranch}`
      || !Array.isArray(d.checks) || !d.checks.length || d.checks.length > 10) throw invalid();
    for (const c of d.checks) {
      if (!object(c) || !exact(c,['name','command','args','timeoutSeconds']) || typeof c.name !== 'string' || !c.name.trim()
        || typeof c.command !== 'string' || !c.command.trim() || /[\r\n\0]/.test(c.command)
        || !Array.isArray(c.args) || c.args.some(a=>typeof a !== 'string' || a.includes('\0'))
        || !Number.isInteger(c.timeoutSeconds) || Number(c.timeoutSeconds)<1 || Number(c.timeoutSeconds)>1800) throw invalid();
    }
  }
  // Approval must show the complete operation, never a truncated command list.
  if (JSON.stringify(value).length > 8000) throw invalid();
  return structuredClone(value) as unknown as BaselineProposal;
}

export const baselineProposalSchema = {anyOf:[{type:'null'},{type:'object',properties:{
  ref:{type:'string'},migrateChanges:{type:'boolean'},delivery:{anyOf:[{type:'null'},{type:'object',properties:{
    repository:{type:'string'},baseBranch:{type:'string'},checks:{type:'array',items:{type:'object',properties:{
      name:{type:'string'},command:{type:'string'},args:{type:'array',items:{type:'string'}},timeoutSeconds:{type:'integer'},
    },required:['name','command','args','timeoutSeconds'],additionalProperties:false}},
  },required:['repository','baseBranch','checks'],additionalProperties:false}]},
},required:['ref','migrateChanges','delivery'],additionalProperties:false}]};

export async function previewDeliverySetup(config: Config, task: Task, project: Project, proposal: BaselineProposal, signal: AbortSignal) {
  const delivery=proposal.delivery!;
  if (!config.configFile) throw Error('当前运行器没有可写的交付配置入口，未修改配置；请在本机设置交付目标和检查命令。');
  const file=realpathSync(config.configFile), before=readFileSync(file,'utf8'), raw=JSON.parse(before);
  const saved=raw.projects?.[task.project];
  if (!saved || project.sandbox!=='workspace-write' || saved.sandbox!=='workspace-write'
    || realpathSync(resolve(dirname(file),saved.path))!==realpathSync(project.path)
    || saved.codexProjectId!==project.codexProjectId || JSON.stringify(saved.worktree)!==JSON.stringify(project.worktree)) {
    throw Error('项目授权或交付配置已变化，请重新准备。');
  }
  const origin=await git(project.path,['remote','get-url','--push','origin'],signal);
  if (![ `git@github.com:${delivery.repository}.git`, `git@github.com:${delivery.repository}`,
    `https://github.com/${delivery.repository}.git`, `https://github.com/${delivery.repository}` ].includes(origin)) throw Error('提议的 GitHub 仓库与项目 origin 不一致，未修改配置。');
  const worktree={baseRef:proposal.ref,checks:delivery.checks,github:{repository:delivery.repository,baseBranch:delivery.baseBranch}};
  const after=JSON.stringify({...raw,projects:{...raw.projects,[task.project]:{...saved,worktree}}},null,2)+'\n';
  return {file,before,after,origin,project:{...project,worktree},description:
    `\n同时更新本项目的后续任务交付配置：\n原配置：${JSON.stringify(project.worktree)}\n新配置：${JSON.stringify(worktree)}\n这些检查会作为本机用户在新任务副本执行，请核对完整命令；不会合并或部署。其他项目和权限模式不变。`};
}

export function applyDeliverySetup(preview: Awaited<ReturnType<typeof previewDeliverySetup>>): () => void {
  if (readFileSync(preview.file,'utf8')!==preview.before) throw Error('本机配置已变化，旧确认不能覆盖新设置。');
  const temp=preview.file+'.'+randomUUID()+'.tmp';
  const write=(text:string)=>{
    try {
      writeFileSync(temp,text,{mode:0o600,flag:'wx'});loadConfig(temp);
      renameSync(temp,preview.file);
    } finally { if(existsSync(temp))unlinkSync(temp); }
  };
  write(preview.after);
  return ()=>{if(readFileSync(preview.file,'utf8')===preview.after)write(preview.before);};
}
