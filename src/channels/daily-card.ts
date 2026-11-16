import {prioritizeDailyFindings} from '../daily-priority.js';
import type { DailyReport, DailyFinding } from '../sentry-daily.js';
const plain=(content:string)=>({tag:'plain_text',content});
const md=(content:string,extra:Record<string,unknown>={})=>({tag:'markdown',content,...extra});
const safe=(s:string)=>s.replace(/[<>\[\]`*_]/g,'').replace(/[\r\n]+/g,' ');
const compact=(s:string,limit=80)=>{const value=safe(s);return value.length>limit?value.slice(0,limit-1)+'…':value;};
const prLinks=(f:DailyFinding)=>f.prs.map(p=>`[PR #${p.url.split('/').at(-1)} ${p.label}](${p.url})`).join(' · ');
const issueLink=(f:DailyFinding)=>`[${compact(f.title,64)}](${f.url})`;
const stats=(f:DailyFinding)=>`${f.count} 次 / ${f.users} 人 · ${f.count===f.previous?'持平':`${f.count>f.previous?'↑':'↓'}${Math.abs(f.count-f.previous)}`}（前日 ${f.previous}）`;
const column=(elements:unknown[],spacing='4px')=>({tag:'column',width:'weighted',weight:1,vertical_spacing:spacing,elements});
const row=(columns:unknown[])=>({tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns});
const metricRow=(items:Array<[string,number|string]>)=>row(items.map(([label,value])=>column([md(`${label} **${value}**`)])));
const section=(title:string,items:unknown[])=>row([column([md(`**${title}**`),...items],'8px')]);
const item=(f:DailyFinding,description=false)=>row([column([
  md(`**${issueLink(f)}**`),
  md(`报错 ${f.count} 次　·　用户 ${f.users} 人　·　较前日 ${f.count===f.previous?'持平':`${f.count>f.previous?'↑':'↓'}${Math.abs(f.count-f.previous)} 次`}`,{text_size:'notation'}),
  ...(description?[md(f.category==='repair'?compact(f.description):'用户覆盖较多，优先核实业务影响。')]:[]),
  ...(f.prs.some(p=>p.label==='已合并')?[md('上线核验：缺少部署版本与事件 release 对照，尚不能判断修复生效。',{text_size:'notation'})]:[]),
  ...(f.prs.length?[md(prLinks(f))]:[])
])]);
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
  const {primary,secondary,other:rest}=prioritizeDailyFindings(d.findings);
  const visible=new Set([...primary,...secondary]);
  const detail=rest.slice(0,30);
  for(const f of rest.slice(30))if(f.prs.length)detail.push(f);
  const trend=d.previousTotal?d.total===d.previousTotal?'与前日持平':`${d.total>d.previousTotal?'↑':'↓'}${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`:'前日无报错';
  const category=(c:DailyFinding['category'])=>{const a=d.findings.filter(f=>f.category===c);return `${a.length} 个 / ${a.reduce((n,f)=>n+f.count,0)} 次`;};
  const elements:unknown[]=[row([column([
    metricRow([['报错',d.total.toLocaleString('en-US')],['涉及问题',d.issueCount],['新增问题',d.newCount]]),
    metricRow([['待合并',prCounts.pending],['已合并',prCounts.merged],['已关闭',prCounts.closed]]),
    md(`报错较前日 ${trend} · PR 按链接去重${prCounts.unknown?` · ${prCounts.unknown} 个状态待核实`:''}`,{text_size:'notation'})
  ],'8px')])];
  const comparison=d.previousTotal?(d.total===d.previousTotal?'与前日持平':`较前日${d.total>d.previousTotal?'增加':'减少'} ${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`):'前日无报错记录';
  const overview=!d.findings.length?'昨天没有记录到错误问题。':primary.length
    ?`昨日报错${comparison}。优先跟进：${primary.map(f=>compact(f.title,42)).join('；')}。${primary.some(f=>f.category==='repair')?'已有修复记录需核对处理结果；':''}${primary.some(f=>f.category==='investigate')?'未归因问题先核实影响。':''}`
    :`昨日报错${comparison}；目前仅有历史噪音或预期情况的分析记录，仍需留意来源变化。`;
  elements.push(section('昨日总结',[md(overview),md(`重点 ${primary.length} 项 · 次要 ${secondary.length} 项 · 其他 ${rest.length} 项。分类表示排查顺序，不代表已确认的故障等级。`,{text_size:'notation'})]));
  if(primary.length)elements.push({tag:'hr'},section('01　重点问题 · 优先跟进',primary.map(f=>item(f,true))));
  if(secondary.length)elements.push({tag:'hr'},section('02　次要问题 · 继续观察',secondary.map(f=>item(f))));
  elements.push({tag:'collapsible_panel',expanded:false,header:{title:plain(`03　其他 · ${rest.length} 项 / 详细分析与统计口径`)},padding:'0px',vertical_spacing:'4px',elements:[
    md(`**分类依据**\n优先跟进有修复分析的问题，再按涉及用户数安排未归因问题；次要项优先保留新增问题。历史噪音、预期情况和未展开问题归入其他。PR 存在不代表问题严重，报错次数不等于业务影响。\n已有修复分析 ${category('repair')}；待核查 ${category('investigate')}；历史噪音 ${category('noise')}；预期情况 ${category('expected')}。`),
    ...[...visible].filter(f=>f.title.length>64||primary.includes(f)).map(f=>md(`**${safe(f.title)}**\n${safe(f.description)}`)),
    ...detail.map(f=>md(`[${safe(f.title)}](${f.url}) · ${stats(f)}${f.isNew?' · 新增':''}\n${prLinks(f)||'暂无关联 PR 记录'}`)),
    md(`[查看当天全部 ${d.issueCount} 个问题](${d.allIssuesUrl})${rest.length>30?' · 此处列出其余问题中报错最多的 30 个，全部关联 PR 均保留。':''}`),
    md(`**口径**\n${d.date} 00:00–24:00（${safe(d.timezone)}），${safe(d.environment)}，覆盖所有状态的错误问题。人数按问题去重，不可相加；报错不等于业务失败。历史分析不代表昨日每条事件都已核实。新增按首次出现时间计算${d.unknownFirstSeen?`；${d.unknownFirstSeen} 个问题缺少首次出现时间，未计入新增`:''}。`),
    md(`**PR**\n昨日问题关联 ${uniquePrs.size} 个 PR，按链接去重；待合并含草稿，已关闭指未合并关闭${prCounts.unknown?`，${prCounts.unknown} 个状态待核实`:''}。关联 PR 包括修复与诊断改动，不代表对应报错已经解决。状态读取于 ${d.checkedAt}；已合并不代表已部署或问题消失，没有关联记录不代表仓库中没有修复。`)
  ]});
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:`${d.title} 日报｜${d.total} 次报错 · ${d.newCount} 个新增问题`}},header:{title:plain(`${d.title}｜Sentry 报错与修复进展`),subtitle:plain(`${d.date} 00:00–24:00 · ${d.timezone==='Asia/Shanghai'?'北京时间':d.timezone} · ${d.environment}`),template:'blue'},body:{direction:'vertical',padding:'10px 12px',vertical_spacing:'8px',elements}};
}
