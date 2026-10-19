import type { Config, Task, View, Intent } from './types.js';
import type { Store } from './store.js';

export const requesterAllowed = (config: Config, id: string) =>
  config.trustedRequesters?.some(p => p.openId === id) === true;

export function canControlTask(config: Config, actorId: string, task?: Task): boolean {
  return !!task && (actorId === config.ownerId || (task.requesterId === actorId
    && !task.requesterRevoked && requesterAllowed(config,actorId)));
}

// Caller commits revocation with task cancellation and outbox retirement, then aborts live runs.
export function revokeRequesters(store: Store, config: Config): string[] {
  const cancelled: string[] = [];
  for (const row of store.db.prepare('SELECT id,requesterId FROM tasks WHERE requesterId IS NOT NULL AND requesterRevoked=0').all() as Array<{id:string;requesterId:string}>) {
    if (requesterAllowed(config,row.requesterId)) continue;
    const task = store.get(row.id)!;
    store.db.prepare('UPDATE tasks SET requesterRevoked=1 WHERE id=?').run(task.id);
    store.event(task.id,'requester_revoked',row.requesterId);
    store.db.prepare('DELETE FROM conversation_bindings WHERE taskId=?').run(task.id);
    store.expire(task.id,false);store.clearProjectSelection(task.id);
    if (['queued','running','waiting_input','waiting_approval'].includes(task.status)) {
      store.set(task.id,'cancelled');cancelled.push(task.id);
    }
  }
  for (const row of store.db.prepare('SELECT id,view FROM outbox WHERE sent=0 AND view IS NOT NULL').all() as Array<{id:string;view:string}>) {
    const view = JSON.parse(row.view) as View;
    if (view.requesterId && (!requesterAllowed(config,view.requesterId)
      || ('taskId' in view && store.get(view.taskId)?.requesterRevoked))) store.delivered(row.id);
  }
  for (const row of store.db.prepare("SELECT id,intent FROM card_actions WHERE used=0 AND json_extract(intent,'$.requesterId') IS NOT NULL").all() as Array<{id:string;intent:string}>) {
    const intent = JSON.parse(row.intent) as Intent;
    if (intent.requesterId && !requesterAllowed(config,intent.requesterId)) store.useAction(row.id);
  }
  return cancelled;
}
