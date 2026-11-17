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
const metric=(title:string,value:string,note:string)=>column([md(`**${title}**`,{text_align:'center'}),md(`**${value}**`,{text_size:'heading-2',text_align:'center'}),md(note,{text_align:'center'})]);
const emphasized=(title:string,note:string,color:string,items:unknown[])=>row([{...column([md(`**${title}**`,{text_size:'heading-3'}),md(note,{text_size:'notation'}),...items.flatMap((item,i)=>i?[{tag:'hr'},item]:[item])],'8px'),padding:'12px',background_style:color}]);
const section=(title:string,items:unknown[])=>row([column([md(`**${title}**`),...items],'8px')]);
const item=(f:DailyFinding,description=false)=>row([column([
  md(`**${issueLink(f)}**`),
  md(`报错 ${f.count} 次　·　用户 ${f.users} 人　·　较前日 ${f.count===f.previous?'持平':`${f.count>f.previous?'↑':'↓'}${Math.abs(f.count-f.previous)} 次`}`,{text_size:'notation'}),
  ...(description?[md(compact(f.description))]:[]),

  ...(f.prs.length?[md(prLinks(f))]:[])
])]);
const contextFeature=(f:DailyFinding)=>({home:'首页',project:'项目页',pricing:'定价页',account:'账户页',other:'其他页面',unknown:'页面待定位'}[f.context?.page??'unknown']);
const summaryTitle=(f:DailyFinding)=>{
  // Translate known error wording only; never infer an affected business operation.
  const wording=f.title.includes('Event stream idle')?'事件流空闲':f.title.includes('Chat stream completed')?'聊天流结束':f.title.includes("(setting 'innerHTML')")?'页面内容写入异常':'';
  return wording?`${contextFeature(f)}：${wording}`:/^(?:TypeError|ReferenceError|Error|UnhandledRejection|AbortError|InternalError|NotFoundError):/.test(f.title)?`${contextFeature(f)}异常，调用来源待确认`:compact(f.title,56);
};
const originLine=(f:DailyFinding,zone:string)=>{
  const first=f.firstSeen&&Number.isFinite(Date.parse(f.firstSeen))?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(f.firstSeen)):'未知';
  const release=f.context?.release;return `${contextFeature(f)} · 首次记录 ${first} · 样本版本 ${release?( /^[a-f0-9]{40}$/.test(release)?release.slice(0,10):safe(release)):'未取得'} · 引入版本待确认`;
};
const summarySentence=(f:DailyFinding,zone:string)=>{
  const title=summaryTitle(f);
  const when=f.firstSeen&&Number.isFinite(Date.parse(f.firstSeen))?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,month:'numeric'}).format(new Date(f.firstSeen)):'';
  const since=when?`从${when}就有记录`:'此前已有记录';
  if(f.prs.some(p=>p.label==='已合并'))return `${title.includes('文档')?'文档恢复时报错':compact(title,28)}已有合并的 PR，接下来核对上线后的表现。`;
  if(f.prs.length)return `${compact(title,28)}正在跟进修复，进度见下方 PR。`;
  if(f.title.includes('Event stream idle'))return `项目页连接空闲报错${since}，是否影响正常使用还在查。`;
  if(f.title.includes('Chat stream completed'))return `聊天流结束报错${since}，是否属于正常结束还在查。`;
  if(f.title.includes("(setting 'innerHTML')"))return `${contextFeature(f)}内容更新时报错，${since}，触发原因还在查。`;
  return `${compact(title,28)}，${since}，具体原因还在查。`;
};
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
  const prioritized=prioritizeDailyFindings(d.findings);
  const progress=d.findings.filter(f=>f.prs.length).sort(rank).slice(0,3);
  const primary=[...prioritized.primary,...prioritized.secondary,...prioritized.other].filter(f=>!f.prs.length&&(f.category==='repair'||f.category==='investigate')).slice(0,3);
  const selected=new Set([...primary,...progress]);
  const secondary=d.findings.filter(f=>!selected.has(f)&&f.isNew&&f.category!=='noise'&&f.category!=='expected').slice(0,6);
  const visible=new Set([...primary,...progress,...secondary]);
  const rest=d.findings.filter(f=>!visible.has(f));
  const detail=rest.slice(0,30);
  for(const f of rest.slice(30))if(f.prs.length)detail.push(f);
  const trend=d.previousTotal?d.total===d.previousTotal?'与前日持平':`${d.total>d.previousTotal?'↑':'↓'}${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`:'前日无报错';
  const category=(c:DailyFinding['category'])=>{const a=d.findings.filter(f=>f.category===c);return `${a.length} 个 / ${a.reduce((n,f)=>n+f.count,0)} 次`;};
  const elements:unknown[]=[row([
    metric('📊 报错概况',d.total.toLocaleString('en-US')+' 次','较前日 '+trend),
    metric('🔎 问题分布',d.issueCount+' 个','新增 '+d.newCount+' 个'),
    metric('🛠️ PR 进度',prCounts.merged+' 已合并',`待合并 ${prCounts.pending} · 已关闭 ${prCounts.closed}${prCounts.unknown?' · 待核实 '+prCounts.unknown:''}`)
  ]),md('昨日完整自然日 · 报错不等于业务失败 · PR 按链接去重',{text_size:'notation'})];
  const comparison=d.previousTotal?(d.total===d.previousTotal?'与前日持平':`较前日${d.total>d.previousTotal?'增加':'减少'} ${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`):'前日无报错记录';
  const major=[...primary.slice(0,2),...progress.slice(0,1)];
  const overview=!d.findings.length?'昨天没有记录到错误问题。':`昨日报错${comparison}。`;
  elements.push(section('昨日总结',[md(overview),md(major.map(f=>'• '+summarySentence(f,d.timezone)).join('\n'))]));
  if(primary.length)elements.push(emphasized('🔶 重点关注','按排查优先级排列；业务影响尚未核实。','orange-50',primary.map(f=>item(f))));
  if(progress.length)elements.push(emphasized('🛠️ 修复进展','关联 PR 最新状态；已合并不代表已上线。','blue-50',progress.map(f=>item(f,true))));
  if(secondary.length)elements.push(section('持续观察与其他新增',secondary.map(f=>item(f))));
  elements.push({tag:'collapsible_panel',expanded:false,header:{title:plain(`其他 · ${rest.length} 项 / 详细分析与统计口径`)},padding:'0px',vertical_spacing:'4px',elements:[
    md(`**分类依据**\n重点关注按已有分析及用户覆盖安排排查顺序；有关联 PR 的问题单列修复进展，其他新增问题简要展示。历史噪音、预期情况和未展开问题归入其他。PR 存在不代表问题严重，报错次数不等于业务影响。\n已有修复分析 ${category('repair')}；待核查 ${category('investigate')}；历史噪音 ${category('noise')}；预期情况 ${category('expected')}。`),
    ...[...visible].filter(f=>f.title.length>64||primary.includes(f)||progress.includes(f)).map(f=>md(`**${safe(f.title)}**\n${originLine(f,d.timezone)}\n${safe(f.description)}`)),
    ...detail.map(f=>md(`[${safe(f.title)}](${f.url}) · ${stats(f)}${f.isNew?' · 新增':''}\n${prLinks(f)||'暂无关联 PR 记录'}`)),
    md(`[查看当天全部 ${d.issueCount} 个问题](${d.allIssuesUrl})${rest.length>30?' · 此处列出其余问题中报错最多的 30 个，全部关联 PR 均保留。':''}`),
    md(`**口径**\n${d.date} 00:00–24:00（${safe(d.timezone)}），${safe(d.environment)}，覆盖所有状态的错误问题。人数按问题去重，不可相加；报错不等于业务失败。历史分析不代表昨日每条事件都已核实。新增按首次出现时间计算${d.unknownFirstSeen?`；${d.unknownFirstSeen} 个问题缺少首次出现时间，未计入新增`:''}。`),
    md(`**PR**\n昨日问题关联 ${uniquePrs.size} 个 PR，按链接去重；待合并含草稿，已关闭指未合并关闭${prCounts.unknown?`，${prCounts.unknown} 个状态待核实`:''}。关联 PR 包括修复与诊断改动，不代表对应报错已经解决。缺少部署版本与事件 release 对照，尚不能判断修复生效。状态读取于 ${d.checkedAt}；已合并不代表已部署或问题消失，没有关联记录不代表仓库中没有修复。`)
  ]});
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:`${d.title} 日报｜${d.total} 次报错 · ${d.newCount} 个新增问题`}},header:{title:plain(`${d.title}｜Sentry 报错与修复进展`),subtitle:plain(`${d.date} 00:00–24:00 · ${d.timezone==='Asia/Shanghai'?'北京时间':d.timezone} · ${d.environment}`),template:'blue'},body:{direction:'vertical',padding:'10px 12px',vertical_spacing:'8px',elements}};
}
