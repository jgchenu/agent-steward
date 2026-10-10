import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertMedia, conversionKind, MediaError, runMedia, type MediaRunner } from '../src/channels/media-convert.js';
import { loadMedia } from '../src/channels/media.js';
import { Readable } from 'node:stream';
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'steward-converter-'));writeFileSync(join(dir,'model.bin'),'model');
 return {dir,finish:()=>rmSync(dir,{recursive:true,force:true})};
}
test('PDF extraction renders numbered pages with a strict page and visual budget, including scan-only pages',async()=>{
 const f=fixture();const calls:Array<[string,string[]]>=[];
 const run:MediaRunner=async(c,a)=>{calls.push([c,a]);if(c==='pdfinfo')return 'Pages: 9\n';if(c==='pdftotext')return '\f';if(c==='pdftoppm')writeFileSync(a.at(-1)!+'.png','png');return ''};
 try{
  const result=await convertMedia('pdf',join(f.dir,'source'),f.dir,f.dir,2,AbortSignal.timeout(1000),run);
  assert.equal(result.status,'partial');assert.match(result.detail,/7–9 页未读取/);assert.equal(result.visuals?.length,2);assert.equal(result.visuals?.[1].label,'PDF 第 2 页');
  assert.deepEqual(calls.filter(([c])=>c==='pdftoppm').map(([,a])=>a[a.indexOf('-f')+1]),['1','2']);
  assert.equal(calls.find(([c])=>c==='pdftotext')![1][3],'6');
 }finally{f.finish()}
});
test('a broken/encrypted PDF fails without pretending it was read; text failures retain page images',async()=>{
 const f=fixture();try{
  await assert.rejects(convertMedia('pdf','source',f.dir,f.dir,2,AbortSignal.timeout(1000),async()=> 'Encrypted: yes'),/页数/);
  const result=await convertMedia('pdf','source',f.dir,f.dir,2,AbortSignal.timeout(1000),async(c,a)=>{
   if(c==='pdfinfo')return 'Pages: 1';if(c==='pdftotext')throw new MediaError('text failed');writeFileSync(a.at(-1)!+'.png','png');return '';
  });assert.equal(result.status,'partial');assert.equal(result.visuals?.length,1);assert.match(result.detail,/text failed/);
 }finally{f.finish()}
});
test('video samples include time labels, duration truncation and independent audio failure',async()=>{
 const f=fixture();const args:string[][]=[];
 try{
  const result=await convertMedia('video','source',f.dir,f.dir,3,AbortSignal.timeout(1000),async(c,a)=>{
   if(c==='ffprobe')return JSON.stringify({format:{duration:'240'},streams:[{codec_type:'video'},{codec_type:'audio'}]});
   args.push(a);writeFileSync(a.at(-1)!,'frame');return '';
  });assert.equal(result.status,'partial');assert.equal(result.visuals?.length,3);assert.match(result.detail,/0–120.0 秒，后续未读取/);assert.match(result.detail,/音轨未读取/);assert.match(result.detail,/缺少本地 Whisper 模型/);
  assert.equal(result.visuals?.[0].label,'视频 0.00 秒抽样画面');assert.equal(result.visuals?.[2].label,'视频 119.90 秒抽样画面');
  assert.ok(args.every(a=>a.includes('-protocol_whitelist')&&a.includes('file,pipe')&&a.includes('-format_whitelist')));
 }finally{f.finish()}
});
test('audio transcription is local, timestamped, bounded and does not expose sound claims',async()=>{
 const f=fixture();const old=process.env.STEWARD_WHISPER_MODEL;process.env.STEWARD_WHISPER_MODEL=join(f.dir,'model.bin');const calls:Array<[string,string[]]>=[];
 try{
  const result=await convertMedia('audio','source',f.dir,f.dir,0,AbortSignal.timeout(1000),async(c,a)=>{
   calls.push([c,a]);if(c==='ffprobe')return JSON.stringify({format:{duration:'200'},streams:[{codec_type:'audio'}]});
   if(c==='whisper-cli')writeFileSync(a[a.indexOf('-of')+1]+'.srt','1\n00:00:01,000 --> 00:00:02,000\nHello');return '';
  });assert.equal(result.status,'partial');assert.match(result.detail,/0–180.0 秒/);assert.match(result.text!,/00:00:01/);assert.match(result.text!,/可能有识别错误/);
  const convert=calls.find(([c])=>c==='ffmpeg')![1];assert.equal(convert[convert.indexOf('-t')+1],'180');assert.ok(convert.includes('pcm_s16le'));assert.ok(calls.some(([c])=>c==='whisper-cli'));
 }finally{if(old===undefined)delete process.env.STEWARD_WHISPER_MODEL;else process.env.STEWARD_WHISPER_MODEL=old;f.finish()}
});
test('runner scrubs credentials, sanitizes failures and terminates on cancellation',async()=>{
 process.env.STEWARD_MEDIA_TEST_SECRET='do-not-forward';
 try{
  assert.equal(await runMedia(process.execPath,['-e','process.stdout.write(String(process.env.STEWARD_MEDIA_TEST_SECRET))'],AbortSignal.timeout(1000)),'undefined');
  await assert.rejects(runMedia('steward-nonexistent-tool',[],AbortSignal.timeout(1000)),/缺少本机工具/);
  await assert.rejects(runMedia(process.execPath,['-e','process.stderr.write("private detail");process.exit(1)'],AbortSignal.timeout(1000)),e=>e instanceof Error&&!e.message.includes('private detail'));
  const abort=new AbortController();const pending=runMedia(process.execPath,['-e','setInterval(()=>{},1000)'],abort.signal);abort.abort(Error('stop'));await assert.rejects(pending,/stop/);
 }finally{delete process.env.STEWARD_MEDIA_TEST_SECRET}
});
test('file uploads route by media extension and complex conversions cannot exceed the turn cap',async()=>{
 const f=fixture();let reads=0,conversions=0;
 const attachments=['doc.pdf','demo.mp4','voice.m4a'].map((name,i)=>({messageId:'message',kind:'file' as const,key:'key'+i,name,status:'unread' as const,detail:''}));
 assert.deepEqual(attachments.map(conversionKind),['pdf','video','audio']);
 try{
  const result=await loadMedia({summary:'',capturedAt:'',truncated:false,messages:[],attachments},{get:async()=>{reads++;return{headers:{},getReadableStream:()=>Readable.from([Buffer.from('%PDF-test')])}}},f.dir,AbortSignal.timeout(1000),async(kind)=>{conversions++;return{status:'processed',detail:kind,text:'content'}});
  assert.equal(reads,2);assert.equal(conversions,2);assert.equal(result.attachments![2].status,'unread');assert.match(result.attachments![2].detail,/上限/);
 }finally{f.finish()}
});
