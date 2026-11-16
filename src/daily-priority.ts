import type {DailyFinding} from './sentry-daily.js';
/** An investigation agenda, not an incident-severity classification. Never infer impact from titles. */
export function prioritizeDailyFindings(findings:DailyFinding[]){
  const rank=(a:DailyFinding,b:DailyFinding)=>Number(b.category==='repair')-Number(a.category==='repair')||b.users-a.users||b.count-a.count||a.id.localeCompare(b.id);
  const candidates=findings.filter(f=>f.category==='repair'||f.category==='investigate').sort(rank);
  const primary=candidates.slice(0,2);
  const remaining=candidates.slice(2);
  const repairs=remaining.filter(f=>f.category==='repair');
  const newlySeen=remaining.filter(f=>f.category!=='repair'&&f.isNew).sort((a,b)=>b.count-a.count||rank(a,b)).slice(0,2);
  const preferred=new Set([...repairs,...newlySeen]);
  const secondary=[...repairs,...newlySeen,...remaining.filter(f=>!preferred.has(f))].slice(0,6);
  const visible=new Set([...primary,...secondary]);
  const other=findings.filter(f=>!visible.has(f));
  return {primary,secondary,other};
}
