import type { DailyReport, DailyFinding } from '../sentry-daily.js';
const plain=(content:string)=>({tag:'plain_text',content});
const md=(content:string,extra:Record<string,unknown>={})=>({tag:'markdown',content,...extra});
const col=(elements:unknown[],extra:Record<string,unknown>={})=>({tag:'column',width:'weighted',weight:1,vertical_spacing:'8px',elements,...extra});
const row=(columns:unknown[])=>({tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns});
const box=(elements:unknown[])=>row([col(elements,{padding:'12px',background_style:'grey-50'})]);
const safe=(s:string)=>s.replace(/[<>\[\]`*_]/g,'').replace(/[\r\n]+/g,' ');
const links=(f:DailyFinding)=>`[查看 Sentry](${f.url})${f.prs.map(p=>` · [PR #${p.url.split('/').at(-1)} · ${p.label}](${p.url})`).join('')}`;
export function dailyCard(d:DailyReport):Record<string,unknown>{
  const priority=d.findings.filter(f=>f.category!=='noise'&&f.category!=='expected').sort((a,b)=>Number(!!b.prs.length)-Number(!!a.prs.length)||b.users-a.users||b.count-a.count);
  const top=priority.slice(0,2),rest=d.findings.filter(f=>!top.includes(f));
  const trend=d.previousTotal?`较前日 ${d.total>=d.previousTotal?'↑':'↓'}${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`:'前日无报错';
  const metric=(value:number,label:string,primary=false)=>col([md(`**${value.toLocaleString('en-US')}**`,{text_size:primary?'heading-1':'heading-3',text_align:'center'}),md(label,{text_size:'notation',text_align:'center'}),...(primary?[md(trend,{text_size:'notation',text_align:'center'})]:[])]);
  const findings=top.map((f,i)=>box([
    row([col([md(`**0${i+1}  ${safe(f.title)}**`)]),col([md(`<text_tag color='neutral'>${f.prs[0]?.label??'待核实影响'}</text_tag>`,{text_align:'right'})])]),
    md(`${f.count} 次 · ${f.users} 位用户 / 前日 ${f.previous} 次`,{text_size:'notation'}),md(safe(f.description)),
    md(f.prs.length?'**下一步**  按 PR 状态继续审查或确认上线效果。':'**下一步**  补查触发条件和业务影响。分身记录中暂未关联修复 PR。'),md(links(f))
  ]));
  const extra=rest.filter(f=>f.isNew||f.prs.length).slice(0,6);
  const category=(c:DailyFinding['category'])=>d.findings.filter(f=>f.category===c);
  const counts=(c:DailyFinding['category'])=>{const a=category(c);return `${a.length} 个问题 / ${a.reduce((n,f)=>n+f.count,0)} 次`;};
  const rows=rest.slice(0,30).map(f=>`• **${safe(f.title)}** · ${f.count} 次${f.isNew?' · 新增':''}\n${links(f)}${f.prs.length?'':' · 暂无关联 PR 记录'}`);
  // All associated PRs remain visible, even when the issue list is capped for transport size.
  for(const f of rest.slice(30).filter(f=>f.prs.length))rows.push(`• ${safe(f.title)}\n${links(f)}`);
  const elements=[box([row([metric(d.total,'报错次数',true),metric(d.issueCount,'涉及问题'),metric(d.newCount,'新增问题')]),md(`**今天先看**\n${d.total===0?'昨天没有记录到错误事件。':top.length?`${top.map(f=>safe(f.title)).join('；')}。关联 PR 状态已尝试更新，下面保留待核实项。`:'昨天的报错均有噪音或预期情况的历史分析，仍需留意来源变化。'}`)]),...findings,
    box([md('**新增与观察**'),...extra.map(f=>md(`**${safe(f.title)}** · ${f.count} 次 · ${f.users} 位用户\n${links(f)}${f.prs.length?'':' · 暂无关联 PR 记录，待核查'}`)),md(`已有修复分析：${counts('repair')}；待核查：${counts('investigate')}。\n历史分析为外部噪音：${counts('noise')}；预期情况：${counts('expected')}。历史结论不代表昨日每条事件都已核实。`,{text_size:'notation'})]),
    {tag:'collapsible_panel',expanded:false,header:{title:plain('更多问题、噪音与统计口径')},padding:'12px',vertical_spacing:'8px',elements:[...rows.map(x=>md(x)),md(`[查看当天全部 ${d.issueCount} 个问题](${d.allIssuesUrl})${rest.length>30?' · 卡片仅展开其余问题中报错最多的 30 个，全部关联 PR 均保留。':''}`),md(`**统计口径**\n${d.date} 00:00–24:00（${safe(d.timezone)}），${safe(d.environment)} 环境，覆盖所有状态的错误问题。人数为各问题内去重，不能相加；报错次数不等于业务失败。新增按问题首次出现时间计算${d.unknownFirstSeen?`；${d.unknownFirstSeen} 个问题缺少首次出现时间，未计入新增`:''}。`),md(`**PR 状态**\n本次读取时间 ${d.checkedAt}。已合并不代表已部署或线上问题消失；没有关联记录不等于仓库中不存在修复。`)]}
  ];
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:`${d.title} 日报｜${d.total} 次报错 · ${d.newCount} 个新增问题`}},header:{title:plain(`${d.title} · 错误与修复日报`),subtitle:plain(`${d.date} · ${d.environment} · 昨日汇总`),template:'blue',icon:{tag:'standard_icon',token:'todo_colorful'}},body:{direction:'vertical',padding:'12px',vertical_spacing:'12px',elements}};
}
