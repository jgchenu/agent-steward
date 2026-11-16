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
  const json=JSON.stringify(card);assert.match(json,/已合并不代表已部署/);assert.match(json,/50.0%/);assert.doesNotMatch(json,/<at|"callback"|"form"/);assert.ok((card.body as {elements:unknown[]}).elements.length<=5);
});

test('top PR summary deduplicates associations and includes draft, closed and unknown states',()=>{
  const labels=['待合并 · 草稿','待合并 · 待审查','已合并','已关闭未合并','状态暂未核实'];
  const findings=labels.map((label,i)=>({id:String(i+1),title:`Issue ${i}`,count:1,users:1,firstSeen:'2025-01-01',url:`https://example.sentry.io/issues/${i+1}/`,previous:1,isNew:false,category:'repair' as const,description:'Existing analysis',prs:[{url:`https://github.com/example/app/pull/${i+1}`,label}]}));
  findings.push({...findings[2],id:'6'});
  const data={title:'Example',date:'2026-11-15',timezone:'Asia/Shanghai',environment:'production',checkedAt:'2026-11-16T02:00:00Z',total:6,previousTotal:6,issueCount:6,newCount:0,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings};
  const card=dailyCard(data),top=(card.body as any).elements[0];
  const progress=top.content;
  assert.match(progress,/待合并 \*\*2\*\*/);assert.match(progress,/已合并 \*\*1\*\*/);assert.match(progress,/已关闭 \*\*1\*\*/);assert.match(progress,/待核实 \*\*1\*\*/);
  assert.match(JSON.stringify(card),/关联 5 个 PR/);
  assert.doesNotMatch(JSON.stringify(card),/今天先看|下一步/);
  for(const f of findings)assert.ok(JSON.stringify(card).includes(f.prs[0].url));
  const empty=JSON.stringify(dailyCard({...data,findings:[]}));assert.match(empty,/关联 0 个 PR/);
  findings.push({...findings[2],id:'7',prs:[{...findings[2].prs[0],label:'已关闭未合并'}]});
  const conflict=JSON.stringify(dailyCard(data));assert.match(conflict,/2 个状态待核实/);
});

test('dense card bounds expanded categories without duplicating issues or losing PRs',()=>{
  const findings=Array.from({length:50},(_,i)=>({id:String(i+1),title:`issue-${i+1}`,count:50-i,users:50-i,firstSeen:'2025-01-01',url:`https://example.sentry.io/issues/${i+1}/`,previous:1,isNew:i>=10&&i<18,category:'investigate' as const,description:'A recorded analysis',prs:i<5?[{url:`https://github.com/example/app/pull/${i+1}`,label:'已合并'}]:[]}));
  const d={title:'Example',date:'2026-11-15',timezone:'Asia/Shanghai',environment:'production',checkedAt:'now',total:100,previousTotal:100,issueCount:50,newCount:8,unknownFirstSeen:0,allIssuesUrl:'https://example.sentry.io/issues/',findings};
  const card=dailyCard(d),elements=(card.body as any).elements;assert.equal(elements.length,5);
  const expanded=JSON.stringify(elements.slice(0,-1));assert.doesNotMatch(expanded,/background_style|heading-1/);
  for(const f of findings){const count=expanded.split(`](${f.url})`).length-1;assert.ok(count<=1);}
  assert.equal((expanded.match(/https:\/\/example.sentry.io\/issues\/\d+\//g)||[]).length,13);
  for(const f of findings.filter(f=>f.prs.length))assert.ok(JSON.stringify(card).includes(f.prs[0].url));
  assert.match(expanded,/展开前 3 项/);assert.match(expanded,/此处展示 6 项/);
  assert.match(JSON.stringify(dailyCard({...d,total:0,findings:[],issueCount:0,newCount:0})),/昨天没有记录到错误问题/);
});
