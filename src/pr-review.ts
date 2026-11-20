import {runCommand} from './process.js';
import {currentOperation} from './operations.js';
import {redactAlertText} from './sentry.js';
import type {Store} from './store.js';
import type {DeliveryReport,Task} from './types.js';

export interface ReviewNote {id:string; author:string; text:string; path?:string}
export interface PrReviewBatch {url:string; head:string; notes:ReviewNote[]}
export type ReadPrReviews=(repository:string,url:string,head:string,signal:AbortSignal)=>Promise<ReviewNote[]>;

const trustedAssociations=new Set(['OWNER','MEMBER','COLLABORATOR']);
export const readPrReviews:ReadPrReviews=async(repository,url,head,signal)=>{
  const number=Number(url.split('/').at(-1));
  const [owner,name]=repository.split('/');
  if (!Number.isSafeInteger(number)||number<1||url!==`https://github.com/${repository}/pull/${number}`) throw Error('PR 评论目标无效');
  const query=`query($owner:String!,$name:String!,$number:Int!) {
    repository(owner:$owner,name:$name) { pullRequest(number:$number) {
      url state headRefOid author { login }
      reviews(last:20) { nodes { id body state authorAssociation author { login } submittedAt } }
      reviewThreads(last:20) { nodes { isResolved isOutdated
        comments(last:3) { nodes { id body path authorAssociation author { login } pullRequestReview { state submittedAt } } }
      } }
      comments(last:20) { nodes { id body authorAssociation author { login __typename } } }
    } }
  }`;
  const result=await runCommand('gh',['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${number}`],
    process.cwd(),signal,{timeoutSeconds:10});
  if (result.code||result.truncated) throw Error('PR 评论读取失败');
  const pr=JSON.parse(result.stdout).data?.repository?.pullRequest;
  if (pr?.url!==url||pr.state!=='OPEN'||pr.headRefOid!==head) return [];
  const notes:ReviewNote[]=[];
  const append=(node:any,path?:string)=>{
    if (!node||!trustedAssociations.has(node.authorAssociation)||typeof node.id!=='string'||!node.id
      ||typeof node.author?.login!=='string'||node.author.login===pr.author?.login
      ||typeof node.body!=='string'||!node.body.trim()) return;
    const body=redactAlertText(node.body.trim(),1800);
    if (body) notes.push({id:node.id,author:node.author.login.slice(0,80),text:body,...(path?{path:path.slice(0,240)}:{})});
  };
  for (const node of pr.reviews.nodes) if (node?.submittedAt&&['APPROVED','COMMENTED','CHANGES_REQUESTED'].includes(node.state)) append(node);
  for (const thread of pr.reviewThreads.nodes) {
    if (!thread||thread.isResolved||thread.isOutdated) continue;
    for (const node of thread.comments.nodes) {
      const reviewed=node?.pullRequestReview;
      if (reviewed?.submittedAt&&reviewed.state!=='DISMISSED') append(node,typeof node.path==='string'?node.path:undefined);
    }
  }
  for (const node of pr.comments.nodes) if (node?.author?.__typename==='User') append(node);
  return notes;
};

export function queuedPrReview(store:Store,task:Task):PrReviewBatch|undefined {
  if (task.nextAction!=='execute') return;
  const event=store.db.prepare("SELECT kind,body FROM events WHERE taskId=? AND kind IN ('followup','pr_review_queued','pr_review_finished') ORDER BY seq DESC LIMIT 1").get(task.id);
  return event?.kind==='pr_review_queued'?JSON.parse(String(event.body)) as PrReviewBatch:undefined;
}

function lastReviewResult(store:Store,task:Task):string|undefined {
  const last=store.db.prepare("SELECT kind,body FROM events WHERE taskId=? AND kind IN ('followup','pr_review_finished') ORDER BY seq DESC LIMIT 1").get(task.id);
  return last?.kind==='pr_review_finished'?String(last.body):undefined;
}

export function hasPreparedPrReviewUpdate(store:Store,task:Task):boolean {
  return lastReviewResult(store,task)==='changes_prepared';
}

export function queuePrReview(store:Store,task:Task,report:DeliveryReport,notes:ReviewNote[]):void {
  if (task.mode!=='workspace-write'||!['review','completed'].includes(task.status)
    ||!report.prUrl||!report.publishedSha||report.headSha!==report.publishedSha
    ||store.pendingFollowups(task.id).length||store.requests(task.id).length) return;
  if (task.nextAction!=='publish'&&lastReviewResult(store,task)!=='no_update') return;
  const operation=currentOperation(store,task.id);
  if (operation&&['pending','approved','applying','uncertain'].includes(operation.state)) return;
  const previous=store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='pr_review_queued'").all(task.id);
  const handled=new Set(previous.flatMap(row=>(JSON.parse(String(row.body)) as PrReviewBatch).notes.map(note=>note.id)));
  const candidates=notes.filter(note=>!handled.has(note.id)).slice(0,5);
  if (!candidates.length) return;
  store.transaction(()=>{
    store.resume(task.id,'跟进这条 Sentry 修复 PR 的新审查意见。');
    store.saveDelivery(task.id,{...report,authorizedKey:undefined,exceptionAuthorizedKey:undefined});
    store.event(task.id,'pr_review_queued',JSON.stringify({url:report.prUrl,head:report.publishedSha,notes:candidates}));
  });
}
