import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SentryConnector} from '../src/sentry.js';
import {previousCalendarDay} from '../src/schedules.js';
import {dailyCard} from '../src/channels/daily-card.js';
import type {AlertSource} from '../src/alert-config.js';
const source={sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'TEST_TOKEN'}} as AlertSource;
test('daily calendar covers yesterday rather than 24 hours before send, including DST',()=>{
  const w=previousCalendarDay(Date.parse('2026-11-16T02:00:00Z'),'Asia/Shanghai');
  assert.equal(new Date(w.start).toISOString(),'2026-11-14T16:00:00.000Z');assert.equal(new Date(w.end).toISOString(),'2026-11-15T16:00:00.000Z');
  const dst=previousCalendarDay(Date.parse('2026-03-09T14:00:00Z'),'America/New_York');assert.equal(dst.end-dst.start,23*3600000);
});
test('daily inventory uses window counts, lifetime firstSeen, all statuses and every page',async()=>{
  let calls=0;const c=new SentryConnector(async(input)=>{const u=new URL(String(input));assert.equal(u.searchParams.get('query'),'issue.category:error');assert.equal(u.searchParams.get('environment'),'production');assert.equal(u.searchParams.get('start'),'start');assert.equal(u.searchParams.get('cursor'),calls?'next':null);calls++;
    return new Response(JSON.stringify([{id:String(calls),project:{id:'123'},title:'issue',count:'7',userCount:2,firstSeen:'2026-11-15',lifetime:{count:999,firstSeen:'2025-01-01'}}]),{headers:calls===1?{link:'<https://evil.invalid>; rel="next"; results="true"; cursor="next"'}:{}});
  },{TEST_TOKEN:'test'});
  const rows=await c.dailyIssues(source,'start','end',new AbortController().signal);assert.equal(calls,2);assert.equal(rows.reduce((n,r)=>n+r.count,0),14);assert.equal(rows[0].firstSeen,'2025-01-01T00:00:00.000Z');
});
test('daily rejects partial/mis-scoped or looping inventory instead of claiming success',async()=>{
  for(const project of ['wrong','123']){const c=new SentryConnector(async()=>new Response(JSON.stringify([{id:'1',project:{id:project},count:1}]),{headers:{link:'<https://example.invalid>; rel="next"; results="true"; cursor="same"'}}),{TEST_TOKEN:'test'});await assert.rejects(c.dailyIssues(source,'a','b',new AbortController().signal));}
});
test('approved card is a single bounded hierarchy with truthful PR status and safe remote prose',()=>{
  const card=dailyCard({title:'Example',date:'2026-11-15',timezone:'Asia/Shanghai',environment:'production',checkedAt:'2026-11-16T02:00:00Z',total:50,previousTotal:100,issueCount:1,newCount:0,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings:[{id:'1',title:'<at id=all>Oops</at>',count:50,users:3,firstSeen:'2025-01-01',url:'https://example.sentry.io/issues/1/',previous:100,isNew:false,category:'repair',description:'已有修复',prs:[{url:'https://github.com/example/app/pull/1',label:'已合并'}]}]});
  const json=JSON.stringify(card);assert.match(json,/已合并不代表已部署/);assert.match(json,/50.0%/);assert.doesNotMatch(json,/<at|"callback"|"form"/);assert.ok((card.body as {elements:unknown[]}).elements.filter((e:any)=>e.tag!=='hr').length<=6);
});

test('top PR summary deduplicates associations and includes draft, closed and unknown states',()=>{
  const labels=['待合并 · 草稿','待合并 · 待审查','已合并','已关闭未合并','状态暂未核实'];
  const findings=labels.map((label,i)=>({id:String(i+1),title:`Issue ${i}`,count:1,users:1,firstSeen:'2025-01-01',url:`https://example.sentry.io/issues/${i+1}/`,previous:1,isNew:false,category:'repair' as const,description:'Existing analysis',prs:[{url:`https://github.com/example/app/pull/${i+1}`,label}]}));
  findings.push({...findings[2],id:'6'});
  const data={title:'Example',date:'2026-11-15',timezone:'Asia/Shanghai',environment:'production',checkedAt:'2026-11-16T02:00:00Z',total:6,previousTotal:6,issueCount:6,newCount:0,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings};
  const card=dailyCard(data),top=(card.body as any).elements[0];
  const progress=JSON.stringify(top);
  assert.match(progress,/待合并 2/);assert.match(progress,/1 已合并/);assert.match(progress,/已关闭 1/);assert.match(progress,/待核实 1/);
  assert.match(JSON.stringify(card),/关联 5 个 PR/);
  assert.doesNotMatch(JSON.stringify(card),/今天先看|下一步/);
  for(const f of findings)assert.ok(JSON.stringify(card).includes(f.prs[0].url));
  const empty=JSON.stringify(dailyCard({...data,findings:[]}));assert.match(empty,/关联 0 个 PR/);
  findings.push({...findings[2],id:'7',prs:[{...findings[2].prs[0],label:'已关闭未合并'}]});
  const conflict=JSON.stringify(dailyCard(data));assert.match(conflict,/2 个状态待核实/);
});

test('emphasized detail groups stay disjoint while the summary repeats major findings',()=>{
  const findings=Array.from({length:50},(_,i)=>({id:String(i+1),title:`issue-${i+1}`,count:50-i,users:50-i,firstSeen:'2025-01-01',url:`https://example.sentry.io/issues/${i+1}/`,previous:1,isNew:i>=10&&i<18,category:'investigate' as const,description:'A recorded analysis',prs:i<5?[{url:`https://github.com/example/app/pull/${i+1}`,label:'已合并'}]:[]}));
  const d={title:'Example',date:'2026-11-15',timezone:'Asia/Shanghai',environment:'production',checkedAt:'now',total:100,previousTotal:100,issueCount:50,newCount:8,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings};
  const card=dailyCard(d),elements=(card.body as any).elements;assert.equal(elements.length,7);
  assert.equal((card.header as any).title.content,'Example｜Sentry 报错与修复进展');
  assert.ok(JSON.stringify(elements).includes('orange-50'));assert.ok(JSON.stringify(elements).includes('blue-50'));
  const expanded=JSON.stringify(elements.slice(3,-1));assert.doesNotMatch(expanded,/heading-1/);
  for(const f of findings){const count=expanded.split(`](${f.url})`).length-1;assert.ok(count<=1);}
  assert.equal((expanded.match(/https:\/\/example.sentry.io\/issues\/\d+\//g)||[]).length,12);
  for(const f of findings.filter(f=>f.prs.length))assert.ok(JSON.stringify(card).includes(f.prs[0].url));
  assert.match(JSON.stringify(card),/昨日总结/);assert.match(expanded,/重点关注/);assert.match(expanded,/修复进展/);assert.match(JSON.stringify(card),/其他/);
  assert.match(JSON.stringify(dailyCard({...d,total:0,findings:[],issueCount:0,newCount:0})),/昨天没有记录到错误问题/);
});


test('priority is an evidence-aware agenda: no title-based severity or volume-based noise promotion',async()=>{
  const {prioritizeDailyFindings}=await import('../src/daily-priority.js');
  const make=(id:string,category:'repair'|'noise'|'expected'|'investigate',users:number,count:number,isNew=false)=>({id,title:'Payment outage CRITICAL',category,users,count,isNew,previous:0,firstSeen:'2026-11-15',url:'https://example.sentry.io/issues/'+id,description:'recorded',prs:[]});
  const repair=make('1','repair',1,1),unknown=make('2','investigate',40,50),noise=make('3','noise',1000,99999),expected=make('4','expected',900,90000),newIssue=make('5','investigate',1,2,true);
  const classified=prioritizeDailyFindings([noise,expected,newIssue,unknown,repair]);
  assert.deepEqual(classified.primary.map(x=>x.id),['1','2']);assert.deepEqual(classified.secondary.map(x=>x.id),['5']);assert.deepEqual(classified.other.map(x=>x.id),['3','4']);
});

test('private daily card shows one overview and keeps technical details folded',()=>{
  const issue={id:'1',title:'UnhandledRejection: Non-Error promise rejection captured with value: Project event replay requested',
    count:200,users:28,previous:0,isNew:true,firstSeen:'2026-11-18T02:00:00Z',category:'investigate' as const,
    description:'尚未完成归因',context:{page:'project' as const,eventAt:'2026-11-18T02:00:00Z',release:'7a17cd7f11'},
    url:'https://example.sentry.io/issues/1/',prs:[]};
  const repair={...issue,id:'2',title:'文档恢复异常',category:'repair' as const,url:'https://example.sentry.io/issues/2/',
    prs:[{url:'https://github.com/example/app/pull/2268',label:'已合并'}]};
  const noise={...issue,id:'3',category:'noise' as const,users:1000,url:'https://example.sentry.io/issues/3/'};
  const card=dailyCard({title:'Example 前端',date:'2026-11-18',timezone:'Asia/Shanghai',environment:'production',
    checkedAt:'2026-11-19T02:00:00Z',total:600,previousTotal:300,issueCount:3,newCount:3,unknownFirstSeen:0,
    findings:[issue,repair,noise],allIssuesUrl:'https://example.sentry.io/issues/'},'private');
  const elements=(card.body as any).elements;
  const summary=JSON.stringify(elements.filter((e:any)=>e.tag!=='collapsible_panel'));
  assert.match(summary,/600 次报错.*↑100.0%.*3 个问题/);
  assert.match(summary,/已合并 1/);
  assert.match(summary,/项目事件请求回放.*200 次 \/ 28 人/);
  assert.match(summary,/PR #2268 已合并/);
  assert.match(summary,/含其他 1 项/);
  assert.doesNotMatch(summary,/UnhandledRejection|昨日总结|7a17cd7f11|issues\/3\//);
  const details=elements.find((e:any)=>e.tag==='collapsible_panel');
  assert.equal(details.expanded,false);
  assert.match(JSON.stringify(details),/7a17cd7f11/);
});

test('daily summary changes with counts and PR states without claiming deployment or resolution',()=>{
  const f={id:'1',title:'Editor error',count:50,users:40,previous:100,isNew:false,category:'repair' as const,firstSeen:'2025-01-01',url:'https://example.sentry.io/issues/1/',description:'Recorded repair',prs:[{url:'https://github.com/example/app/pull/1',label:'待合并 · 草稿'}]};
  const d={title:'Example',date:'2026-11-15',timezone:'Asia/Shanghai',environment:'production',checkedAt:'now',total:50,previousTotal:100,issueCount:1,newCount:0,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings:[f]};
  const before=JSON.stringify(dailyCard(d));assert.match(before,/↓50.0%/);assert.match(before,/待合并 1/);
  const after=JSON.stringify(dailyCard({...d,date:'2026-11-16',total:60,previousTotal:50,findings:[{...f,count:60,previous:50,prs:[{...f.prs[0],label:'已合并'}]}]}));
  assert.match(after,/↑20.0%/);assert.match(after,/1 已合并/);assert.match(after,/缺少部署版本与事件 release 对照/);assert.doesNotMatch(after,/线上效果待验证|修复已生效|问题已解决/);
});

test('window context rejects wrong dates and environments and strips private URL details',async()=>{
  const event={dateCreated:'2026-11-16T05:00:00Z',release:{version:'a'.repeat(40)},projectID:'123',tags:[{key:'environment',value:'production'},{key:'url',value:'https://example.com/en/project/private-id?token=secret'}]};
  const make=(e:unknown)=>new SentryConnector(async()=>new Response(JSON.stringify([e])),{TEST_TOKEN:'test'});
  const ctx=await make(event).dailyContext(source,'1','2026-11-16T00:00:00Z','2026-11-17T00:00:00Z',new AbortController().signal);
  const tagged=await make({...event,release:undefined,tags:[...event.tags,{key:'release',value:'b'.repeat(40)}]}).dailyContext(source,'1','2026-11-16T00:00:00Z','2026-11-17T00:00:00Z',new AbortController().signal);assert.equal(tagged!.release,'b'.repeat(40));
  assert.equal(ctx!.page,'project');assert.equal(ctx!.release,'a'.repeat(40));assert.doesNotMatch(JSON.stringify(ctx),/secret|private-id/);
  await assert.rejects(make({...event,dateCreated:'2026-11-17T00:00:00Z'}).dailyContext(source,'1','2026-11-16T00:00:00Z','2026-11-17T00:00:00Z',new AbortController().signal));
  await assert.rejects(make({...event,projectID:'456'}).dailyContext(source,'1','2026-11-16T00:00:00Z','2026-11-17T00:00:00Z',new AbortController().signal));
});


test('group summary shows recorded work and concrete checks without inferring a repair',()=>{
  const base={count:65,users:38,previous:86,isNew:false,firstSeen:'2026-05-20T06:15:29Z'};
  const findings=[
    {...base,id:'1',title:'登录弹窗重复回调',category:'repair' as const,
      description:'已有修复：登录弹窗只处理首次回调；昨日报错是否来自同一原因仍需核实。',
      url:'https://example.sentry.io/issues/1/',prs:[{url:'https://github.com/example/app/pull/3',label:'已合并'}]},
    {...base,id:'2',title:'项目页初始化异常',category:'repair' as const,
      description:'已有分析：调用栈指向项目页初始化时的样式读取（昨日事件是否同源仍需核实）',
      url:'https://example.sentry.io/issues/2/',prs:[],context:{page:'project' as const,eventAt:'2026-11-16T06:00:00Z',release:'46304648c0'}},
    {...base,id:'3',title:'预览页报错',category:'investigate' as const,description:'尚未完成归因',
      url:'https://example.sentry.io/issues/3/',prs:[]},
  ];
  const card=dailyCard({title:'Example',date:'2026-11-16',timezone:'Asia/Shanghai',environment:'production',checkedAt:'now',total:195,previousTotal:258,issueCount:3,newCount:0,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings});
  const elements=(card.body as any).elements;
  const summary=JSON.stringify(elements[2]);
  assert.match(summary,/已改.*登录弹窗只处理首次回调.*PR #3 已合并.*核对生产版本/);
  assert.match(summary,/已查.*调用栈指向项目页初始化.*按已确认的触发条件复测/);
  assert.match(summary,/预览页报错.*从当天取一条完整事件/);
  assert.equal((summary.match(/已查/g)||[]).length,1);
  assert.doesNotMatch(summary,/还在查|仍需核实|就有记录|昨日报错|46304648c0|修复已生效/);
  assert.match(JSON.stringify(elements.at(-1)),/46304648c0/);
});
