import type { DailyReport, DailyFinding } from '../sentry-daily.js';
const plain=(content:string)=>({tag:'plain_text',content});
const md=(content:string,extra:Record<string,unknown>={})=>({tag:'markdown',content,...extra});
const col=(elements:unknown[],extra:Record<string,unknown>={})=>({tag:'column',width:'weighted',weight:1,vertical_spacing:'8px',elements,...extra});
const row=(columns:unknown[])=>({tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns});
const box=(elements:unknown[])=>row([col(elements,{padding:'12px',background_style:'grey-50'})]);
const safe=(s:string)=>s.replace(/[<>\[\]`*_]/g,'').replace(/[\r\n]+/g,' ');
const links=(f:DailyFinding)=>`[查看 Sentry](${f.url})${f.prs.map(p=>` · [PR #${p.url.split('/').at(-1)} · ${p.label}](${p.url})`).join('')}`;
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
  const priority=d.findings.filter(f=>f.category!=='noise'&&f.category!=='expected').sort((a,b)=>Number(!!b.prs.length)-Number(!!a.prs.length)||b.users-a.users||b.count-a.count);
  const top=priority.slice(0,2),rest=d.findings.filter(f=>!top.includes(f));
  const trend=d.previousTotal?`较前日 ${d.total>=d.previousTotal?'↑':'↓'}${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`:'前日无报错';
  const metric=(value:number,label:string,primary=false)=>col([md(`**${value.toLocaleString('en-US')}**`,{text_size:primary?'heading-1':'heading-3',text_align:'center'}),md(label,{text_size:'notation',text_align:'center'}),...(primary?[md(trend,{text_size:'notation',text_align:'center'})]:[])]);
  const compact=(text:string)=>{const value=safe(text);return value.length>80?value.slice(0,79)+'…':value;};
  const findings=top.map((f,i)=>box([
    md(`**0${i+1}  ${safe(f.title)}**`),
    md(`${f.count} 次 · ${f.users} 人 · 前日 ${f.previous} 次`,{text_size:'notation'}),
    ...(f.category==='repair'?[md(compact(f.description))]:[]),
    md(`${links(f)}${f.prs.length?'':f.category==='repair'?' · 已有修复分析，暂无关联 PR':' · 待核查，暂无关联 PR'}`)
  ]));
  const extra=rest.filter(f=>f.isNew).slice(0,3);
  const category=(c:DailyFinding['category'])=>d.findings.filter(f=>f.category===c);
  const counts=(c:DailyFinding['category'])=>{const a=category(c);return `${a.length} 个问题 / ${a.reduce((n,f)=>n+f.count,0)} 次`;};
  const rows=rest.slice(0,30).map(f=>`• **${safe(f.title)}** · ${f.count} 次${f.isNew?' · 新增':''}\n${links(f)}${f.prs.length?'':' · 暂无关联 PR 记录'}`);
  // All associated PRs remain visible, even when the issue list is capped for transport size.
  for(const f of rest.slice(30).filter(f=>f.prs.length))rows.push(`• ${safe(f.title)}\n${links(f)}`);
  const prSummary=`**PR 进度**　待合并 **${prCounts.pending}**　·　已合并 **${prCounts.merged}**　·　已关闭 **${prCounts.closed}**${prCounts.unknown?`　·　待核实 **${prCounts.unknown}**`:''}`;
  const elements=[
    box([row([metric(d.total,'报错次数',true),metric(d.issueCount,'涉及问题'),metric(d.newCount,'新增问题')]),md(prSummary)]),...findings,
    ...(extra.length?[box([md('**其他新增**'),...extra.map(f=>md(`[${safe(f.title)}](${f.url}) · ${f.count} 次${f.prs.length?' · '+f.prs.map(p=>`[PR #${p.url.split('/').at(-1)} · ${p.label}](${p.url})`).join(' · '):' · 待核查'}`))])]:[]),
    {tag:'collapsible_panel',expanded:false,header:{title:plain('其余问题与统计口径')},padding:'12px',vertical_spacing:'8px',elements:[
      md(`**分类**\n已有修复分析 ${counts('repair')}；待核查 ${counts('investigate')}；历史噪音 ${counts('noise')}；预期情况 ${counts('expected')}。`),
      ...top.filter(f=>f.category==='repair'&&safe(f.description).length>80).map(f=>md(`**${safe(f.title)}**\n${safe(f.description)}`)),
      ...rows.map(x=>md(x)),md(`[查看当天全部 ${d.issueCount} 个问题](${d.allIssuesUrl})${rest.length>30?' · 卡片展开其余问题中报错最多的 30 个，全部关联 PR 均保留。':''}`),
      md(`**口径**\n${d.date} 00:00–24:00（${safe(d.timezone)}），${safe(d.environment)}，覆盖所有状态的错误问题。人数按问题去重，不可相加；报错不等于业务失败。历史分析不代表昨日每条事件都已核实。新增按首次出现时间计算${d.unknownFirstSeen?`；${d.unknownFirstSeen} 个问题缺少首次出现时间，未计入新增`:''}。`),
      md(`**PR**\n昨日问题关联 ${uniquePrs.size} 个 PR，按链接去重；待合并含草稿，已关闭指未合并关闭${prCounts.unknown?`，${prCounts.unknown} 个状态待核实`:''}。状态读取于 ${d.checkedAt}；已合并不代表已部署或问题消失，没有关联记录不代表仓库中没有修复。`)
    ]}
  ];
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:`${d.title} 日报｜${d.total} 次报错 · ${d.newCount} 个新增问题`}},header:{title:plain(`${d.title} · 错误与修复日报`),subtitle:plain(`${d.date} · ${d.environment} · 昨日汇总`),template:'blue',icon:{tag:'standard_icon',token:'todo_colorful'}},body:{direction:'vertical',padding:'12px',vertical_spacing:'12px',elements}};
}
