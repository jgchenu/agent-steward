import { createHash } from 'node:crypto';
import { alertSourceKey } from './alert-config.js';
import { alertBindingForTask } from './alert-provenance.js';
import { alertDescription, currentAlertTask, publicPr, topicAuthorized, type AlertTopic } from './alert-collaboration.js';
import { draftReason } from './delivery-summary.js';
import type { Config } from './types.js';
import type { Store } from './store.js';

// Owner-only, source-authorized projection. No prompts, transcripts, credentials,
// delegate tasks or instructions are copied from group threads into the digest.
export function ownerPrOverview(store:Store,config:Config,chatId:string):string|undefined {
  const sources=Object.entries(config.alertSources??{}).filter(([,s])=>s.chatId===chatId);
  const groups:Record<string,string[]>={'需要你处理':[],'等待验证或审查':[],'已合并':[],'已关闭':[]};
  const seen=new Set<string>();
  for(const task of store.list().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
    if(task.requesterId||task.requesterRevoked)continue;
    let binding;try{binding=alertBindingForTask(store,task.id);}catch{continue;}
    if(!binding||!sources.some(([id])=>id===binding.sourceId&&alertSourceKey(config,id)===binding.sourceKey))continue;
    const topic=store.db.prepare('SELECT * FROM alert_topics WHERE sourceKey=? AND issueId=?').get(binding.sourceKey,binding.issueId) as unknown as AlertTopic|undefined;
    if(topic && (!topicAuthorized(config,topic)||currentAlertTask(store,topic)?.id!==task.id))continue;
    if(!topic && task.chatId!==chatId)continue;
    const report=store.delivery(task.id),pr=publicPr(config,task,report?.prUrl),merge=store.mergeReceipt(task.id);
    if(!report?.files.length&&!pr)continue;
    const key=pr??`${binding.sourceKey}:${binding.issueId}`;if(seen.has(key))continue;seen.add(key);
    const title=report?.summary?.title??alertDescription(store,task)?.summary??'代码修改';
    const topicUrl=topic?.threadId ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(topic.chatId)}&open_thread_id=${encodeURIComponent(topic.threadId)}` : undefined;
    const link=pr?`[${title}](${pr})`:topicUrl?`[${title}](${topicUrl})`:title;
    const merged=(merge&&publicPr(config,task,merge.url))||report?.remotePr?.state==='MERGED';
    const needsAction=task.status==='waiting_approval'||(!pr&&task.status==='review'&&(report?.ready||report?.baselineComparison?.eligible));
    const bucket=merged?'已合并':report?.remotePr?.state==='CLOSED'?'已关闭':needsAction?'需要你处理':'等待验证或审查';
    const detail=merged?'已合并；上线效果未确认':report?.remotePr?.state==='CLOSED'?'PR 已关闭，未合并':needsAction?'请在原话题确认具体操作':pr?(report?.prIsDraft===false?'可开始代码审查':`草稿：${report?draftReason(report)??'审查准备待完成':'验证待完成'}`):'验证或补证中';
    groups[bucket].push(`- ${link}：${detail}`);
  }
  if(!seen.size)return;
  let budget=9000;
  const sections=Object.entries(groups).filter(([,rows])=>rows.length).map(([title,rows])=>{
    const shown:string[]=[];
    for(const row of rows.slice(0,8)){const size=Buffer.byteLength(row);if(size>budget)break;shown.push(row);budget-=size;}
    return `${title}（${rows.length}）\n${shown.join('\n')}${shown.length<rows.length?'\n其余项目见原话题。':''}`;
  });
  return ['PR 跟进总览',...sections,'此消息随任务进展更新；授权仍在原话题处理。已合并不代表已上线。'].join('\n\n');
}
export function syncOwnerPrOverviews(store:Store,config:Config):void {
  const destinations=new Set(Object.values(config.alertSources??{}).map(s=>s.chatId));
  for(const chatId of destinations){
    const text=ownerPrOverview(store,config,chatId);if(!text)continue;
    const hash=createHash('sha256').update(text).digest('hex');
    if(store.cardMessage(chatId,'pr-overview:queued')===hash)continue;
    store.transaction(()=>{store.saveCardMessage(chatId,'pr-overview:queued',hash);store.enqueue(chatId,'',{kind:'pr-overview'});});
  }
}
