import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

export interface MergeScope {
  ownerId: string; project: string; grantKey: string;
  url: string; headRefName: string; headRefOid: string; baseRefName: string; baseRefOid: string; isDraft: boolean;
}
export interface OperationProposal { kind: 'merge'; scope: MergeScope; description: string }
export interface Operation {
  id: string; taskId: string; requestId: string; kind: 'merge'; scope: MergeScope;
  state: 'pending' | 'approved' | 'denied' | 'applying' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled';
  phase: 'prepared' | 'draft' | 'draft-ready' | 'merge'; expiresAt: number;
  actorId: string | null; result: string | null;
}
export class OperationWaiting extends Error {}

export function currentOperation(store: Store, taskId: string): Operation | undefined {
  const row=store.db.prepare('SELECT * FROM operations WHERE taskId=? AND current=1').get(taskId) as (Omit<Operation,'scope'> & {scope:string}) | undefined;
  return row && {...row,scope:JSON.parse(row.scope) as MergeScope};
}
// Completed records remain audit evidence. An uncertain effect cannot be forgotten
// by a fresh prompt or merge request; it must be reconciled before another attempt.
export function retireOperation(store: Store, taskId: string): void {
  const op=currentOperation(store,taskId);
  if(!op || ['applying','uncertain'].includes(op.state))return;
  store.resolveRequest(op.requestId,'expired');
  store.db.prepare("UPDATE operations SET current=0,state=CASE WHEN state IN ('pending','approved') THEN 'cancelled' ELSE state END WHERE id=?").run(op.id);
}
export function cancelOperation(store: Store, taskId: string): void {
  const op=currentOperation(store,taskId);if(!op)return;
  store.resolveRequest(op.requestId,'expired');
  if(['pending','approved','applying'].includes(op.state)){
    const state=op.state==='applying'?'uncertain':'cancelled';
    store.db.prepare('UPDATE operations SET state=? WHERE id=?').run(state,op.id);
    store.event(taskId,'operation_'+state,op.id);
  }
}
export function operationFailure(store: Store, taskId: string, reason: string): void {
  const op=currentOperation(store,taskId);if(!op || ['succeeded','denied','cancelled'].includes(op.state))return;
  const state=['applying','uncertain'].includes(op.state)?'uncertain':'failed';
  store.resolveRequest(op.requestId,'expired');
  store.db.prepare('UPDATE operations SET state=?,result=? WHERE id=?').run(state,reason,op.id);
  store.event(taskId,'operation_'+state,JSON.stringify({id:op.id,reason}));
}
export function approveOperation(store: Store, taskId: string, proposal: OperationProposal): void {
  const op=currentOperation(store,taskId);
  if(op){
    const expected={...op.scope,isDraft:op.phase==='draft-ready'?false:op.scope.isDraft};
    if(JSON.stringify(expected)!==JSON.stringify(proposal.scope))throw Error('确认后 PR 来源、目标、草稿状态或项目授权发生变化，请重新预览并确认。');
    if(op.expiresAt<=Date.now())throw Error('合并确认已过期，请重新预览并确认。');
    if(op.state==='pending')throw new OperationWaiting('等待已保存的操作确认');
    if(op.state!=='approved')throw Error('操作决定已失效或结果待核验，未再次执行。');
    return;
  }
  store.transaction(()=>{
    const id=randomUUID(),requestId=store.request(taskId,'approval',proposal.description+'\n确认有效期为 24 小时；等待期间可以处理其他任务。');
    store.db.prepare("INSERT INTO operations(id,taskId,requestId,kind,scope,state,phase,expiresAt,current) VALUES (?,?,?,?,?,'pending','prepared',?,1)")
      .run(id,taskId,requestId,proposal.kind,JSON.stringify(proposal.scope),Date.now()+24*60*60*1000);
    store.set(taskId,'waiting_approval');
    store.event(taskId,'operation_prepared',JSON.stringify({id,kind:proposal.kind,scope:proposal.scope}));
    const task=store.get(taskId)!;
    store.enqueue(task.chatId,`${proposal.description}\n等待确认期间可处理其他任务。\n/approve ${requestId} 或 /deny ${requestId}`,{kind:'task',taskId,fresh:true});
  });
  throw new OperationWaiting('等待操作确认');
}
// Caller owns the inbox transaction and checks owner/chat/topic/request binding.
export function decideOperation(store: Store, op: Operation, actorId: string, accept: boolean): void {
  if(op.state!=='pending'||op.expiresAt<=Date.now())throw Error('操作确认已失效，请重新预览。');
  const state=accept?'approved':'denied';
  if(store.db.prepare("UPDATE operations SET state=?,actorId=? WHERE id=? AND state='pending' AND current=1").run(state,actorId,op.id).changes!==1)throw Error('操作已处理。');
  store.resolveRequest(op.requestId);
  store.event(op.taskId,'operation_decided',JSON.stringify({id:op.id,state,actorId}));
  store.set(op.taskId,accept?'queued':'review',accept?undefined:'未合并，PR 保持原样。');
}
export function operationAttempt(store: Store, taskId: string, phase: 'draft'|'merge'): void {
  const op=currentOperation(store,taskId);if(!op)return;
  if(store.db.prepare("UPDATE operations SET state='applying',phase=? WHERE id=? AND state='approved'").run(phase,op.id).changes!==1)throw Error('操作不能重复执行。');
  store.event(taskId,'operation_attempted',JSON.stringify({id:op.id,phase}));
}
export function draftReady(store: Store, taskId: string): void {
  const op=currentOperation(store,taskId);if(!op)return;
  store.db.prepare("UPDATE operations SET state='approved',phase='draft-ready' WHERE id=? AND state='applying' AND phase='draft'").run(op.id);
}
export function operationSucceeded(store: Store, taskId: string, result: string): void {
  const op=currentOperation(store,taskId);if(!op)return;
  store.resolveRequest(op.requestId,'expired');
  store.db.prepare("UPDATE operations SET state='succeeded',result=? WHERE id=?").run(result,op.id);
  store.event(taskId,'operation_succeeded',op.id);
}
