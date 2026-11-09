import type { Store } from './store.js';

interface AlertBinding { sourceId: string; sourceKey: string; issueId: string }

// Baseline replacements retain the original intake receipt. Only controller-written,
// reciprocal handoffs can inherit it; prompt text and ordinary project handoffs cannot.
export function alertBindingForTask(store: Store, taskId: string): AlertBinding | undefined {
  const seen=new Set<string>();
  let id=taskId;
  for (let depth=0;depth<100;depth++) {
    if (seen.has(id)) throw Error('告警任务继承链异常，不能继续。');
    seen.add(id);
    const binding=store.db.prepare('SELECT sourceId,sourceKey,issueId FROM alert_tasks WHERE taskId=?').get(id) as AlertBinding | undefined;
    if (binding) return binding;
    const events=store.db.prepare("SELECT body FROM events WHERE taskId=? AND kind='baseline_authorized'").all(id);
    if (!events.length) return;
    if (events.length!==1) throw Error('告警任务继承链异常，不能继续。');
    let parent: unknown;
    try { parent=JSON.parse(String(events[0].body))?.fromTask; } catch { /* fail closed below */ }
    const child=store.get(id), from=typeof parent==='string' ? store.get(parent) : undefined;
    if (!child || !from || child.project!==from.project || child.chatId!==from.chatId
      || child.requesterId!==from.requesterId || child.mode!==from.mode
      || !store.db.prepare("SELECT 1 FROM events WHERE taskId=? AND kind='handoff_to' AND body=?").get(from.id,id)) {
      throw Error('告警任务继承链异常，不能继续。');
    }
    id=from.id;
  }
  throw Error('告警任务继承链过长，不能继续。');
}

export function pendingAlertTasks(store: Store): number {
  const tasks=store.db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_input','waiting_approval','interrupted')").all();
  return tasks.reduce((count,task) => {
    try { return count+(alertBindingForTask(store,String(task.id)) ? 1 : 0); }
    catch { return count+1; } // Broken provenance must not free an intake slot.
  },0);
}
