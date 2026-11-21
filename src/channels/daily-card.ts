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
  return wording?`${contextFeature(f)}：${wording}`:/^(?:TypeError|ReferenceError|Error|UnhandledRejection|AbortError|InternalError|NotFoundError):/.test(f.title)?`${contextFeature(f)}报错`:compact(f.title,56);
};
const originLine=(f:DailyFinding,zone:string)=>{
  const first=f.firstSeen&&Number.isFinite(Date.parse(f.firstSeen))?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(f.firstSeen)):'未知';
  const release=f.context?.release;return `${contextFeature(f)} · 首次记录 ${first} · 样本版本 ${release?( /^[a-f0-9]{40}$/.test(release)?release.slice(0,10):safe(release)):'未取得'} · 引入版本待确认`;
};
function summaryItem(f:DailyFinding):string {
  // The stored findings carry only sanitized, shareable analysis and delivery copy.
  const change=f.description.startsWith('已有修复：');
  const prefix=change?'已有修复：':'已有分析：';
  const recordedWork=f.description.startsWith(prefix)
    ? safe(f.description.slice(prefix.length))
      .split(/（昨日事件是否同源仍需核实）|；昨日报错是否来自同一原因仍需核实。/,1)[0].trim()
      .replace(/[。；]+$/,'')
    : '';
  const lastSentence=recordedWork.slice(0,140).lastIndexOf('。');
  const shortWork=recordedWork.length>140&&lastSentence>=0
    ? recordedWork.slice(0,lastSentence+1)
    : compact(recordedWork,140);
  const work=shortWork
    ? `  **${change?'已改':'已查'}** ${shortWork}`
    : f.context
      ? `  **已查** 取到当天的${f.context.page==='unknown'||f.context.page==='other'?'':contextFeature(f)}报错样本`
      : '';
  const labels=new Set(f.prs.map(p=>p.label));
  let next:string;
  if(labels.has('已合并')) {
    next='核对生产版本是否包含已合并的提交，再查这个报错在该版本是否还有新事件。';
  } else if(labels.has('待合并 · 待审查')||labels.has('待合并 · 草稿')) {
    next='对照 PR 的复现步骤跑一次回归，确认原触发操作能完成。';
  } else if(labels.has('状态暂未核实')) {
    next='先回读关联 PR 的状态，确认改动是否已合并。';
  } else if(change) {
    next='找到包含这次改动的版本，用原触发操作核对是否仍报错。';
  } else if(recordedWork&&f.category==='repair') {
    next='按已确认的触发条件复测，检查报错时页面还能否完成后续操作。';
  } else if(f.context) {
    next='按样本的浏览器、页面和触发操作复现，对照调用栈确认异常发生在哪一步。';
  } else {
    next='从当天取一条完整事件，核对页面、浏览器和首个业务栈帧。';
  }
  return [`• **[${summaryTitle(f)}](${f.url})**`,work,f.prs.length?`  ${prLinks(f)}`:'',`  **接下来** ${next}`].filter(Boolean).join('\n');
}
const privateIssueNames:Record<string,string>={
  'Project event replay requested':'项目事件请求回放',
  'Chat stream completed':'聊天流结束时报错',
  'Project event stream awaiting retry':'项目事件流等待重试',
  'Event stream idle':'事件流空闲'
};
function privateIssueLink(f:DailyFinding):string {
  const title=f.title.replace(/^UnhandledRejection: Non-Error promise rejection captured with value: /,'');
  const label=Object.hasOwn(privateIssueNames,title)?privateIssueNames[title]:title.split(/[，。；]/,1)[0]||title;
  return `[${compact(label,36)}](${f.url})`;
}

function privateDailyCard(d:DailyReport,primary:DailyFinding[],progress:DailyFinding[],
  prCounts:{pending:number;merged:number;closed:number;unknown:number},trend:string):Record<string,unknown>{
  const errors=d.total.toLocaleString('en-US');
  const counts=`待合并 ${prCounts.pending} · 已合并 ${prCounts.merged} · 已关闭 ${prCounts.closed}${prCounts.unknown?` · 待核实 ${prCounts.unknown}`:''}`;
  const change=d.previousTotal?(d.total===d.previousTotal?'与前日持平':`较前日 ${trend}`):'前日无报错';
  const elements:unknown[]=[md(`**${errors} 次报错**（${change}） · **${d.issueCount} 个问题**（新增 ${d.newCount}）\n**关联 PR**　${counts}`)];
  if(primary.length)elements.push(md('**重点关注**\n'+primary.map(f=>
    `• ${privateIssueLink(f)} · ${f.count} 次 / ${f.users} 人${f.isNew?' · 新增':''}`).join('\n')));
  if(progress.length)elements.push(md('**修复进展**\n'+progress.map(f=>
    `• ${privateIssueLink(f)}\n  ${prLinks(f)}`).join('\n')));
  const featured=[...primary,...progress],shown=new Set(featured);
  const other=d.findings.filter(f=>!shown.has(f));
  const prDetails=other.filter(f=>f.prs.length);
  if(featured.length)elements.push({tag:'collapsible_panel',expanded:false,header:{title:plain('展开原因、版本与关联修复')},padding:'0px',
    elements:[...featured.map(f=>md(`**${compact(f.title)}**\n${originLine(f,d.timezone)}\n${safe(f.description)}`)),
      ...prDetails.map(f=>md(`${privateIssueLink(f)} · ${prLinks(f)}`)),
      md('报错次数与业务失败需分别核实。PR 已合并，仍需核对部署版本和线上报错。',{text_size:'notation'})]});
  elements.push(md(`[查看 Sentry 全部问题${other.length?`（含其他 ${other.length} 项）`:''}](${d.allIssuesUrl})`,{text_size:'notation'}));
  const zone=d.timezone==='Asia/Shanghai'?'北京时间':d.timezone;
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:`${d.title} Sentry 日报 · ${errors} 次报错`}},
    header:{title:plain(`${d.title} Sentry 日报`),subtitle:plain(`${d.date} · ${zone} · ${d.environment==='production'?'生产环境':d.environment}`),template:'blue'},
    body:{direction:'vertical',padding:'10px 12px',vertical_spacing:'8px',elements}};
}

export function dailyCard(d:DailyReport,destination:'group'|'private'='group'):Record<string,unknown>{
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
  const trend=d.previousTotal?d.total===d.previousTotal?'与前日持平':`${d.total>d.previousTotal?'↑':'↓'}${(Math.abs(d.total-d.previousTotal)/d.previousTotal*100).toFixed(1)}%`:'前日无报错';
  if(destination==='private')return privateDailyCard(d,primary,progress,prCounts,trend);
  const selected=new Set([...primary,...progress]);
  const secondary=d.findings.filter(f=>!selected.has(f)&&f.isNew&&f.category!=='noise'&&f.category!=='expected').slice(0,6);
  const visible=new Set([...primary,...progress,...secondary]);
  const rest=d.findings.filter(f=>!visible.has(f));
  const detail=rest.slice(0,30);
  for(const f of rest.slice(30))if(f.prs.length)detail.push(f);
  const category=(c:DailyFinding['category'])=>{const a=d.findings.filter(f=>f.category===c);return `${a.length} 个 / ${a.reduce((n,f)=>n+f.count,0)} 次`;};
  const elements:unknown[]=[row([
    metric('📊 报错概况',d.total.toLocaleString('en-US')+' 次','较前日 '+trend),
    metric('🔎 问题分布',d.issueCount+' 个','新增 '+d.newCount+' 个'),
    metric('🛠️ PR 进度',prCounts.merged+' 已合并',`待合并 ${prCounts.pending} · 已关闭 ${prCounts.closed}${prCounts.unknown?' · 待核实 '+prCounts.unknown:''}`)
  ]),md('昨日完整自然日 · 报错不等于业务失败 · PR 按链接去重',{text_size:'notation'})];
  const major=[...progress.slice(0,1),...primary.slice(0,2)];
  if(major.length) elements.push(section('昨日总结',major.map(f=>md(summaryItem(f)))));
  else if(!d.findings.length) elements.push(section('昨日总结',[md('昨天没有记录到错误问题。')]));
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
