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
