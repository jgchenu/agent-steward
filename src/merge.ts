import type { Config, Project, RunHooks, Task, MergeReceipt } from './types.js';
import type { Store } from './store.js';
import { git, ghCommand, type Gh } from './workspace.js';

export const mergeIntent = (text: string): string | undefined => {
  const match = /^(?:请|帮我|请帮我|授权给你帮我|授权你|确认)?\s*合并\s*(?:这个|当前|刚才的)?\s*(?:PR)?\s*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)?\s*[。！!]?$/i.exec(text.trim());
  return match ? match[1] ?? '' : undefined;
};
type Pull = { title?:string; body?:string; number:number; url:string; state:string; isDraft:boolean; headRefName:string; headRefOid:string;
  baseRefName:string; baseRefOid:string; isCrossRepository:boolean; mergeable:string; mergeStateStatus:string;
  reviewDecision:string; statusCheckRollup:Array<{name?:string;context?:string;status?:string;conclusion?:string;state?:string}>;
  changedFiles:number; additions:number; deletions:number; mergeCommit?:{oid:string}|null };
const fields='title,body,number,url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,changedFiles,additions,deletions,mergeCommit';
const sha=(v:string)=>/^[a-f0-9]{40}$/.test(v);
function ready(p:Pull) {
  if(p.baseRefName==='staging')throw Error('staging 按共享分支规则须由人工在 GitHub 审查并手动合并；分身只准备 PR。');
  if(p.state!=='OPEN')throw Error('PR 已关闭或合并，请重新查看 GitHub 状态。');
  if(p.isCrossRepository!==false || !sha(p.headRefOid) || !sha(p.baseRefOid))throw Error('不支持跨仓库或身份不完整的 PR 合并。');
  if(p.mergeable!=='MERGEABLE'||p.mergeStateStatus!=='CLEAN')throw Error('PR 存在冲突、检查未定或仓库保护尚未满足；不会绕过保护或自动排队合并。');
  if(!['','APPROVED'].includes(p.reviewDecision))throw Error('PR 仍需审查或有修改要求，请先完成审查。');
  if(!Array.isArray(p.statusCheckRollup)||!p.statusCheckRollup.length||p.statusCheckRollup.some(c=>c.status ? c.status!=='COMPLETED'||c.conclusion!=='SUCCESS' : c.state!=='SUCCESS'))throw Error('当前 PR 提交的检查尚未全部成功；没有检查记录也不能代为合并。');
}
// Remote PR text is display data only, never execution instructions. Keep the
// opening description bounded and omit validation/release claims from the excerpt.
export function prSummary(body: string): string {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const value = line.trim();
    if (/^#{0,6}\s*(验证|测试|验收|部署)/.test(value)) break;
    if (/^#{0,6}\s*(validation|tests?|testing|verification|验证|测试|验收|部署|release|base)\b/i.test(value) || /^(验证|测试|验收|部署)[：:]/.test(value)) break;
    if (/^#/.test(value)) { if (kept.length) break; continue; }
    if (!value) { if (kept.length) break; continue; }
    if (/^```/.test(value)) break;
    kept.push(value.replace(/^[-*]\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, ''));
  }
  const text = kept.join(' ');
  return Array.from(text).slice(0, 360).join('') + (Array.from(text).length > 360 ? '…' : '');
}

export function mergeResultText(receipt: MergeReceipt): string {
  const safe = (value: string) => value.replace(/[<>]/g, '').replace(/([\\`*_[\]])/g, '\\$1');
  return `[PR #${receipt.number}](${receipt.url}) 已合并到 ${safe(receipt.target)}。\n`
    + `改动：${safe(receipt.title)}\n`
    + (receipt.summary ? `PR 说明摘要：${safe(receipt.summary)}\n` : '')
    + `涉及 ${receipt.files} 个文件。部署状态未核验。`;
}

function recordMerge(store: Store, task: Task, pr: Pull): string {
  if (!pr.mergeCommit?.oid || !sha(pr.mergeCommit.oid)) throw Error('缺少有效的合并提交，尚未确认合并结果。');
  const receipt: MergeReceipt = { url:pr.url, number:pr.number, title:(pr.title || `PR #${pr.number}`).slice(0,200), summary:prSummary(pr.body || ''), target:pr.baseRefName,
    head:pr.headRefOid, commit:pr.mergeCommit.oid, files:pr.changedFiles, additions:pr.additions, deletions:pr.deletions };
  store.event(task.id,'merge_receipt',JSON.stringify(receipt));
  return mergeResultText(receipt);
}
export async function mergePullRequest(store:Store,config:Config,task:Task,project:Project,hooks:RunHooks,signal:AbortSignal,gh:Gh=ghCommand,repoGit:typeof git=git):Promise<string> {
  if(task.mode!=='workspace-write'||project.sandbox!=='workspace-write')throw Error('该任务没有修改项目的授权。');
  const match=/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(task.mergeUrl??'');
  if(!match)throw Error('请明确提供当前项目的 GitHub PR 链接。');
  const [,repository,number]=match, url=match[0], cwd=project.path;
  const projectKey=JSON.stringify(project);
  const currentGrant=()=>{
    signal.throwIfAborted();
    if(JSON.stringify(config.projects[task.project])!==projectKey)throw Error('项目授权或配置已变化，请重新确认合并。');
  };
  const origin=await repoGit(cwd,['remote','get-url','origin'],signal);
  if(![`https://github.com/${repository}`,`https://github.com/${repository}.git`,`git@github.com:${repository}`,`git@github.com:${repository}.git`].includes(origin))throw Error('PR 不属于当前授权项目的 origin 仓库。');
  if(project.worktree?.github && project.worktree.github.repository!==repository)throw Error('PR 与配置的交付仓库不同。');
  const read=async()=>{
    currentGrant();
    const p=JSON.parse(await gh(cwd,['pr','view',number,'--repo',repository,'--json',fields],signal)) as Pull;
    if(p.url!==url || p.number!==Number(number) || (project.worktree?.github && p.baseRefName!==project.worktree.github.baseBranch))throw Error('PR 身份或目标分支与配置不一致。');
    return p;
  };
  const preview=await read();
  if(preview.state==='MERGED')return recordMerge(store,task,preview);
  ready(preview);
  const repo=JSON.parse(await gh(cwd,['api',`repos/${repository}`,'--jq','{allow_squash_merge}'],signal));
  if(repo.allow_squash_merge!==true)throw Error('仓库未允许 squash 合并；请在 GitHub 按仓库要求处理。');
  const key=JSON.stringify([url,preview.headRefName,preview.headRefOid,preview.baseRefName,preview.baseRefOid]);
  store.event(task.id,'merge_preview',key);
  const description=`确认代你合并 [PR #${number}](${url})？\n来源：${preview.headRefName} @ ${preview.headRefOid}\n目标：${preview.baseRefName} @ ${preview.baseRefOid}\n范围：${preview.changedFiles} 个文件，+${preview.additions}/-${preview.deletions}；当前提交的 ${preview.statusCheckRollup.length} 项远端检查成功，GitHub 显示可合并。\n方式：squash${preview.isDraft?'，先将草稿转为待审阅':''}。只合并上述提交；分支或检查变化会停止。本地工作副本不会推送或重置，也不会删除分支。目标分支的现有 CI/CD 可能随合并触发。`;
  const accepted=await new Promise<boolean>((resolve,reject)=>{
    const abort=()=>reject(signal.reason??Error('合并已取消')); signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    try {hooks.request({kind:'approval',description,resolve:answer=>{signal.removeEventListener('abort',abort);resolve(answer==='accept');}});}
    catch(e){signal.removeEventListener('abort',abort);reject(e);}
  });
  currentGrant();
  if(!accepted)return '未合并，PR 保持原样。';
  store.event(task.id,'merge_authorized',key);
  const recheck=async()=>{
    const p=await read();ready(p);
    if(JSON.stringify([url,p.headRefName,p.headRefOid,p.baseRefName,p.baseRefOid])!==key || p.isDraft!==preview.isDraft)throw Error('确认后 PR 来源、目标或草稿状态发生变化，请重新预览并确认。');
    return p;
  };
  await recheck();
  if(preview.isDraft){
    await gh(cwd,['pr','ready',number,'--repo',repository],signal);
    preview.isDraft=false;
    await recheck();
  }
  currentGrant();
  store.event(task.id,'merge_attempted',key);
  let response:any;
  try {
    response=JSON.parse(await gh(cwd,['api','--method','PUT',`repos/${repository}/pulls/${number}/merge`,'-f',`sha=${preview.headRefOid}`,'-f','merge_method=squash'],signal));
  } catch {
    // A network failure may follow a successful merge. Read back only; never retry PUT.
    signal.throwIfAborted();
  }
  const result=await read();
  if(result.state!=='MERGED'||result.headRefOid!==preview.headRefOid||result.baseRefName!==preview.baseRefName||!result.mergeCommit?.oid
    || (response?.merged===true && response.sha!==result.mergeCommit.oid))throw Error('尚未确认合并成功；请检查 GitHub 状态，不会自动重试。若已转为待审阅，保留该状态。');
  store.event(task.id,'merge_completed',JSON.stringify({url,head:preview.headRefOid,targetBefore:preview.baseRefOid,commit:result.mergeCommit.oid}));
  return recordMerge(store,task,result);
}
