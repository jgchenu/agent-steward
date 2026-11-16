import type { DailyReport, DailyFinding } from '../sentry-daily.js';
const plain=(content:string)=>({tag:'plain_text',content});
const md=(content:string,extra:Record<string,unknown>={})=>({tag:'markdown',content,...extra});
const safe=(s:string)=>s.replace(/[<>\[\]`*_]/g,'').replace(/[\r\n]+/g,' ');
const compact=(s:string,limit=80)=>{const value=safe(s);return value.length>limit?value.slice(0,limit-1)+'…':value;};
const prLinks=(f:DailyFinding)=>f.prs.map(p=>`[PR #${p.url.split('/').at(-1)} ${p.label}](${p.url})`).join(' · ');
const issueLink=(f:DailyFinding)=>`[${compact(f.title,64)}](${f.url})`;
const stats=(f:DailyFinding)=>`${f.count} 次 / ${f.users} 人 · ${f.count===f.previous?'持平':`${f.count>f.previous?'↑':'↓'}${Math.abs(f.count-f.previous)}`}（前日 ${f.previous}）`;
const section=(title:string,content:string)=>({tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,vertical_spacing:'4px',elements:[md(`**${title}**`),md(content)]}]});
export function dailyCard(d:DailyReport):Record<string,unknown>{
  // Count repair PRs, not issue-to-PR associations. Conflicting snapshots remain unknown.
  const uniquePrs=new Map<string,string>();
  for(const f of d.findings)for(const p of f.prs){
    const previous=uniquePrs.get(p.url);
    uniquePrs.set(p.url,previous!==undefined&&previous!==p.label?'状态暂未核实':p.label);
  }
  const prCounts={pending:0,merged:0,closed:0,unknown:0};
  for(const label of uniquePrs.values()){
    if(label==='已合并')prCounts.merged++;
    else if(label==='已关闭未合并')prCounts.closed++;
    else if(label==='待合并 · 草稿'||label==='待合并 · 待审查')prCounts.pending++;
    else prCounts.unknown++;
  }
  const rank=(a:DailyFinding,b:DailyFinding)=>b.users-a.users||b.count-a.count;
  // Keep categories disjoint in the expanded view; every PR is retained in the fold.
  const linked=d.findings.filter(f=>f.prs.length).sort(rank),progress=linked.slice(0,3);
  const pending=d.findings.filter(f=>!f.prs.length&&!f.isNew&&(f.category==='investigate'||f.category==='repair')).sort(rank).slice(0,4);
  const added=d.findings.filter(f=>f.isNew),fresh=added.filter(f=>!progress.includes(f)).slice(0,6);
  const visible=new Set([...progress,...pending,...fresh]);
  const rest=d.findings.filter(f=>!visible.has(f));
  const detail=rest.slice(0,30);
  for(const f of rest.slice(30))if(f.prs.length)detail.push(f);
  const trend=d.previousTotal?d.total===d.previousTotal?'与前日持平':`${d.total>d.previousTotal?'↑':'↓'}${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`:'前日无报错';
  const prSummary=`**PR**　待合并 **${prCounts.pending}**　已合并 **${prCounts.merged}**　已关闭 **${prCounts.closed}**${prCounts.unknown?`　待核实 **${prCounts.unknown}**`:''}`;
  const category=(c:DailyFinding['category'])=>{const a=d.findings.filter(f=>f.category===c);return `${a.length} 个 / ${a.reduce((n,f)=>n+f.count,0)} 次`;};
  const elements:unknown[]=[md(`报错 **${d.total.toLocaleString('en-US')}**（${trend}）　问题 **${d.issueCount}**　新增 **${d.newCount}**\n${prSummary}`)];
  if(progress.length)elements.push(section(`修复进展 · ${linked.length} 个问题 / ${uniquePrs.size} 个 PR${linked.length>progress.length?'（展开前 3 项）':''}`,progress.map(f=>`${issueLink(f)}　${stats(f)}\n${compact(f.description)} ${prLinks(f)}`).join('\n\n')));
  if(pending.length)elements.push(section('仍需排查 · 暂无关联 PR',pending.map(f=>`${issueLink(f)}　${stats(f)}${f.category==='repair'?' · 已有修复分析':''}`).join('\n')+'\n这些报错的实际影响仍需核实。'));
  if(fresh.length)elements.push(section(`昨日新增 · ${d.newCount} 个 / ${added.reduce((n,f)=>n+f.count,0)} 次${fresh.length<added.length?`（此处展示 ${fresh.length} 项）`:''}`,fresh.map(f=>`${issueLink(f)}　${f.count} 次 / ${f.users} 人${f.prs.length?' · '+prLinks(f):' · 待核查'}`).join('\n')));
  if(!d.findings.length)elements.push(md('昨天没有记录到错误问题。'));
  elements.push({tag:'collapsible_panel',expanded:false,header:{title:plain('其余问题、分析详情与统计口径')},padding:'0px',vertical_spacing:'4px',elements:[
    md(`**分类**\n已有修复分析 ${category('repair')}；待核查 ${category('investigate')}；历史噪音 ${category('noise')}；预期情况 ${category('expected')}。`),
    ...[...visible].filter(f=>f.title.length>64||progress.includes(f)).map(f=>md(`**${safe(f.title)}**\n${safe(f.description)}`)),
    ...detail.map(f=>md(`[${safe(f.title)}](${f.url}) · ${stats(f)}${f.isNew?' · 新增':''}\n${prLinks(f)||'暂无关联 PR 记录'}`)),
    md(`[查看当天全部 ${d.issueCount} 个问题](${d.allIssuesUrl})${rest.length>30?' · 此处列出其余问题中报错最多的 30 个，全部关联 PR 均保留。':''}`),
    md(`**口径**\n${d.date} 00:00–24:00（${safe(d.timezone)}），${safe(d.environment)}，覆盖所有状态的错误问题。人数按问题去重，不可相加；报错不等于业务失败。历史分析不代表昨日每条事件都已核实。新增按首次出现时间计算${d.unknownFirstSeen?`；${d.unknownFirstSeen} 个问题缺少首次出现时间，未计入新增`:''}。`),
    md(`**PR**\n昨日问题关联 ${uniquePrs.size} 个 PR，按链接去重；待合并含草稿，已关闭指未合并关闭${prCounts.unknown?`，${prCounts.unknown} 个状态待核实`:''}。关联 PR 包括修复与诊断改动，不代表对应报错已经解决。状态读取于 ${d.checkedAt}；已合并不代表已部署或问题消失，没有关联记录不代表仓库中没有修复。`)
  ]});
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:`${d.title} 日报｜${d.total} 次报错 · ${d.newCount} 个新增问题`}},header:{title:plain(`${d.title} · 昨日问题与修复`),subtitle:plain(`${d.date} · ${d.environment}`),template:'blue'},body:{direction:'vertical',padding:'10px 12px',vertical_spacing:'8px',elements}};
}
