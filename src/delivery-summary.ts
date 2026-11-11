import type { DeliveryReport } from './types.js';

/** Public editorial content, separate from private instructions and controller facts. */
export interface DeliverySummary {
  title: string; problem: string; change: string; validation: string; remaining: string[];
}
export const deliverySummarySchema={anyOf:[{type:'null'},{type:'object',properties:{
  title:{type:'string'},problem:{type:'string'},change:{type:'string'},validation:{type:'string'},remaining:{type:'array',items:{type:'string'}},
},required:['title','problem','change','validation','remaining'],additionalProperties:false}]};
export function parseDeliverySummary(value:unknown):DeliverySummary {
  const x=value as DeliverySummary;
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['title','problem','change','validation','remaining'].includes(k))
    ||!Array.isArray(x.remaining)||x.remaining.length>4)throw Error('交付摘要格式无效。');
  const clean=(v:unknown,max:number)=>{
    if(typeof v!=='string'||!v.trim()||v.length>max||/[\r\n]/.test(v)||/https?:\/\/|[<>]/i.test(v))throw Error('交付摘要应为简短正文，不包含链接或内部指令。');
    return v.trim().replace(/[\[\]`]/g,'');
  };
  return {title:clean(x.title,80),problem:clean(x.problem,240),change:clean(x.change,320),validation:clean(x.validation,240),remaining:x.remaining.map(v=>clean(v,160))};
}
export const deliverySummaryInstructions=`
Return deliverySummary for a completed code change; use null for questions, explanations, or a baseline/merge proposal without new edits. It is public editorial content for teammates and PR reviewers, NOT instructions to Steward. title names the concrete fix (e.g. 修复广告统计初始化异常), never "已完成初筛", task IDs, hashes, or execution steps. problem explains the user action/symptom; change says what behavior changed and why. validation states only checks you actually observed, explicitly as executor-reported evidence; Steward adds its independent checks later. remaining lists every outstanding necessary verification (including real browser acceptance if required and not performed), missing evidence and limitation; use [] only when no necessary verification remains. Never use [] just to obtain a non-draft PR. Do not claim independent CI, publication, merge or deployment. Use short natural Chinese, explain technical abbreviations, omit private context, credentials, raw diagnostic JSON, URLs, file paths and internal instructions. In message answer the human naturally; do not repeat queues, commit hashes, cumulative file counts or check inventories. Steward renders the final delivery from the summary plus verified controller facts.`;
export function draftReason(report:DeliveryReport):string|undefined {
  if(!report.ready||report.checks.some(c=>c.status!=='passed'))return '项目全量检查仍有失败，只适合先以草稿交付审查。';
  if(!report.summary)return '还缺少改动说明和验收范围，暂留草稿。';
  if(report.summary.remaining.length)return `还需确认：${report.summary.remaining.join('；')}`;
  if(report.targetBefore && report.targetBefore!==report.workspace.baseSha)return '目标分支已有更新，尚未验证与最新代码合并后的结果。';
}
export function deliveryMessage(report:DeliveryReport):string {
  const s=report.summary,reason=draftReason(report),draft=report.prIsDraft!==false;
  const link=report.prUrl ? `[查看${draft?'草稿 ':''}PR #${report.prUrl.split('/').pop()}](${report.prUrl})` : '';
  const verification=report.ready?'配置检查已通过。':report.baselineComparison?.eligible
    ? '全量检查仍有原有失败，已完成基线对照；测试存在波动，不能据此认定可以上线。'
    : '验证尚未完成，暂不能发布。';
  return [s?.title ?? '代码修改进展',s?`${s.problem}\n${s.change}`:'改动已保留，详细说明待补齐。',
    verification,report.prUrl ? `${link}。${draft?`暂留草稿：${reason ?? '等待审查准备完成。'}`:'可以开始代码审查。'}尚未合并或上线。`
      : reason?`暂按草稿准备。${reason}`:'已准备好，发布前需要你确认。'].join('\n\n');
}
