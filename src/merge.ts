import { setTimeout as delay } from 'node:timers/promises';
import type { Config, Project, RunHooks, Task, MergeReceipt } from './types.js';
import type { Store } from './store.js';
import { git, ghCommand, type Gh } from './workspace.js';

export const mergeIntent = (text: string): string | undefined => {
  const match = /^(?:请|帮我|请帮我|授权给你帮我|授权你|授权|确认|可以[，,]?|好的[，,]?)?\s*(?:直接)?合并\s*(?:这个|当前|刚才的)?\s*(?:PR)?\s*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)?\s*(?:即可|吧|就行)?[。！!]?$/i.exec(text.trim());
  return match ? match[1] ?? '' : undefined;
};
type Pull = { title?:string; body?:string; number:number; url:string; state:string; isDraft:boolean; headRefName:string; headRefOid:string;
  baseRefName:string; baseRefOid:string; isCrossRepository:boolean; mergeable:string; mergeStateStatus:string;
  reviewDecision:string; statusCheckRollup:Array<{name?:string;context?:string;status?:string;conclusion?:string;state?:string}>;
  changedFiles:number; additions:number; deletions:number; mergeCommit?:{oid:string}|null };
const fields='title,body,number,url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,changedFiles,additions,deletions,mergeCommit';
const sha=(v:string)=>/^[a-f0-9]{40}$/.test(v);
export class MergeBlocked extends Error {}
// A wait is not a conflict or a failed check. Return its concrete reason.
export function mergeReadiness(p:Pull, allowDraft=false): string | undefined {
  if(p.baseRefName==='staging')throw new MergeBlocked('staging 按共享分支规则须由人工在 GitHub 审查并手动合并；分身只准备 PR。');
  if(p.state!=='OPEN')throw new MergeBlocked(`PR 当前状态为 ${p.state}，不执行合并。`);
  if(p.isCrossRepository!==false || !sha(p.headRefOid) || !sha(p.baseRefOid))throw new MergeBlocked('不支持跨仓库或身份不完整的 PR 合并。');
  if(p.mergeable==='CONFLICTING'||p.mergeStateStatus==='DIRTY')throw new MergeBlocked('GitHub 已确认代码冲突，需要先解决冲突并重新授权新的提交。');
  if(!['','APPROVED'].includes(p.reviewDecision))throw new MergeBlocked(`PR 审查尚未满足：${p.reviewDecision}。请先完成审查。`);
  if(!Array.isArray(p.statusCheckRollup)||!p.statusCheckRollup.length)throw new MergeBlocked('PR 尚无检查记录，无法确认当前提交已通过检查。');
  const pending:string[]=[],failed:string[]=[];
  for(const c of p.statusCheckRollup){
    const name=(c.name||c.context||'未命名检查').slice(0,160);
    if(c.status){
      if(['QUEUED','IN_PROGRESS','WAITING','PENDING','REQUESTED'].includes(c.status))pending.push(name);
      else if(c.status!=='COMPLETED'||c.conclusion!=='SUCCESS')failed.push(`${name} (${c.conclusion||c.status})`);
    }else if(['PENDING','EXPECTED'].includes(c.state||''))pending.push(name);
    else if(c.state!=='SUCCESS')failed.push(`${name} (${c.state||'UNKNOWN'})`);
  }
  if(failed.length)throw new MergeBlocked(`检查未成功：${failed.slice(0,20).join('、')}。需要处理检查结果，不代表代码冲突。`);
  if(pending.length)return `等待检查完成：${pending.slice(0,20).join('、')}。尚未发现已确认的代码冲突。`;
  if(p.mergeable==='UNKNOWN'||p.mergeStateStatus==='UNKNOWN')return '检查已成功，等待 GitHub 计算可合并状态；UNKNOWN 不表示代码冲突。';
  if(p.mergeable!=='MERGEABLE')throw new MergeBlocked(`GitHub 可合并状态未识别：${p.mergeable}。`);
  if(p.mergeStateStatus==='UNSTABLE')return '检查已成功，等待 GitHub 更新合并状态；UNSTABLE 不表示代码冲突。';
  if(p.mergeStateStatus==='BEHIND')throw new MergeBlocked('目标分支已前进，仓库要求更新 PR 分支后再合并。');
  if(p.mergeStateStatus!=='CLEAN' && !(allowDraft&&p.isDraft&&p.mergeStateStatus==='BLOCKED'))throw new MergeBlocked(`仓库合并要求尚未满足（${p.mergeStateStatus}）；当前没有代码冲突证据，请检查分支保护或合并队列要求。`);
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
export async function mergePullRequest(store:Store,config:Config,task:Task,project:Project,hooks:RunHooks,signal:AbortSignal,gh:Gh=ghCommand,repoGit:typeof git=git, wait:(signal:AbortSignal)=>Promise<void>=signal=>delay(10_000,undefined,{signal})):Promise<string> {
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
  const key=JSON.stringify([url,preview.headRefName,preview.headRefOid,preview.baseRefName,preview.baseRefOid]);
  const authorization=task.mergeAuthorization;
  if(authorization && (authorization.url!==url || !authorization.messageId || authorization.projectKey!==projectKey))throw new MergeBlocked('本次合并授权与 PR 或项目配置不匹配，请重新指定 PR。');
  const checkIdentity=(p:Pull)=>{
    if(p.state==='MERGED'&&p.headRefOid===preview.headRefOid&&p.baseRefName===preview.baseRefName)return;
    if(JSON.stringify([url,p.headRefName,p.headRefOid,p.baseRefName,p.baseRefOid])!==key || p.isDraft!==preview.isDraft)throw new MergeBlocked('授权后 PR 来源、目标提交或草稿状态发生变化，本次授权停止，请核对新版本后重新授权。');
  };
  let lastWait='',polls=0,authorized=!!authorization;
  const awaitReady=async(p:Pull,allowDraft:boolean):Promise<Pull>=>{
    for(;;){
      currentGrant();checkIdentity(p);
      if(p.state==='MERGED')return p;
      const reason=mergeReadiness(p,allowDraft);
      if(!reason)return p;
      if(reason!==lastWait){
        lastWait=reason;store.event(task.id,'merge_waiting',reason);
        store.enqueue(task.chatId,`${reason} ${authorized?'本次授权保留，状态满足后继续。':'状态满足后展示确认预览。'}可取消任务停止等待。`,{kind:'reply',taskId:task.id});
      }
      if(polls++>=90)throw new MergeBlocked('等待检查或 GitHub 状态超过 15 分钟，本次未合并；请查看检查结果后重新发送合并指令。');
      await wait(signal);p=await read();
    }
  };
  if(authorization)store.event(task.id,'merge_authorized',JSON.stringify({key,messageId:authorization.messageId,source:'owner-command'}));
  let prepared=await awaitReady(preview,true);
  if(prepared.state==='MERGED')return recordMerge(store,task,prepared);
  const repo=JSON.parse(await gh(cwd,['api',`repos/${repository}`,'--jq','{allow_squash_merge}'],signal));
  if(repo.allow_squash_merge!==true)throw new MergeBlocked('仓库未允许 squash 合并；请在 GitHub 按仓库要求处理。');
  store.event(task.id,'merge_preview',key);
  if(!authorization){
    const description=`确认代你合并 [PR #${number}](${url})？\n来源：${preview.headRefName} @ ${preview.headRefOid}\n目标：${preview.baseRefName} @ ${preview.baseRefOid}\n范围：${preview.changedFiles} 个文件，+${preview.additions}/-${preview.deletions}；当前提交的 ${prepared.statusCheckRollup.length} 项远端检查成功。\n方式：squash${preview.isDraft?'，先将草稿转为待审阅':''}。只合并上述提交；版本变化会停止，现有 CI/CD 可能随合并触发。`;
    const accepted=await new Promise<boolean>((resolve,reject)=>{
      const abort=()=>reject(signal.reason??Error('合并已取消'));signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      try{hooks.request({kind:'approval',description,resolve:answer=>{signal.removeEventListener('abort',abort);resolve(answer==='accept');}});}
      catch(e){signal.removeEventListener('abort',abort);reject(e);}
    });
    currentGrant();if(!accepted)return '未合并，PR 保持原样。';
    authorized=true;store.event(task.id,'merge_authorized',key);
  }
  prepared=await awaitReady(await read(),true);
  if(prepared.state==='MERGED')return recordMerge(store,task,prepared);
  if(preview.isDraft){
    await gh(cwd,['pr','ready',number,'--repo',repository],signal);
    preview.isDraft=false;
  }
  prepared=await awaitReady(await read(),false);
  if(prepared.state==='MERGED')return recordMerge(store,task,prepared);
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
