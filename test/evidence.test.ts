import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { collectEvidence, evidenceBytes } from '../src/evidence.js';
import { FeishuChannel } from '../src/channels/feishu.js';
import { Engine } from '../src/engine.js';
import type { Config, View } from '../src/types.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6H1kAAAAASUVORK5CYII=','base64');
const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'codex',maxRunMinutes:1,groupChats:true,projects:{demo:{path:'.',sandbox:'read-only'}}};
function fixture() {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'steward-evidence-'))), output=join(dir,'output');mkdirSync(output);
  const store=new Store(join(dir,'db.sqlite'));
  const task=store.create('group','demo','work','workspace-write',{anchorId:'root',sourceId:'root',scope:'thread'});
  const manifest=(items:unknown)=>writeFileSync(join(output,'images.json'),JSON.stringify(items));
  writeFileSync(join(output,'screen.png'),png);manifest([{file:'screen.png',caption:'模拟数据 · 桌面',scope:'local-preview'}]);
  return {dir,output,store,task,manifest,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('evidence snapshots are task-bound, immutable on source edits, and reject traversal, symlinks and non-images',()=>{
  const f=fixture();
  try{
    const result=collectEvidence(f.store,f.dir,f.task.id,f.output);assert.equal(result.ids.length,1);
    const image=f.store.evidence(result.ids[0],f.task.id)!;assert.equal(f.store.evidence(image.id,'other'),undefined);
    writeFileSync(join(f.output,'screen.png'),'changed source');assert.deepEqual(evidenceBytes(image,f.dir),png);
    writeFileSync(image.path,png.subarray(0,20));assert.throws(()=>evidenceBytes(image,f.dir),/变化/);
    for (const file of ['../secret.png','https://example.test/x.png','screen.png']) {
      f.manifest([{file,caption:'test',scope:'local-preview'}]);assert.equal(collectEvidence(f.store,f.dir,f.task.id,f.output).ids.length,0);
    }
    symlinkSync(image.path,join(f.output,'link.png'));f.manifest([{file:'link.png',caption:'test',scope:'local-preview'}]);
    assert.ok(collectEvidence(f.store,f.dir,f.task.id,f.output).warning);
    f.manifest(Array(4).fill({file:'screen.png',caption:'test',scope:'local-preview'}));assert.ok(collectEvidence(f.store,f.dir,f.task.id,f.output).warning);
  }finally{f.close();}
});
test('Feishu sends bounded evidence as native thread images, retries with stable UUID and rejects other tasks/chats',async()=>{
  const f=fixture(), channel=new FeishuChannel('fake','fake',f.store,{...config,stateDir:f.dir});
  const creates:any[]=[], uploads:Buffer[]=[];let fail=true;
  (channel as any).client={im:{image:{create:async(p:any)=>{uploads.push(p.data.image);return {image_key:'img-key'};}},message:{reply:async(p:any)=>{creates.push(p);if(fail)throw Error('lost response');return {code:0,data:{message_id:'image-msg'}};}}}};
  try{
    const r=collectEvidence(f.store,f.dir,f.task.id,f.output);const view:View={kind:'evidence',taskId:f.task.id,evidenceIds:r.ids};
    await assert.rejects(channel.send('other','', 'out',view));assert.equal(uploads.length,0);
    await assert.rejects(channel.send('group','', 'out',view),/lost response/);fail=false;
    await channel.send('group','', 'out',view);await channel.send('group','', 'out',view);
    assert.equal(creates.length,2);assert.equal(creates[0].data.uuid,creates[1].data.uuid);assert.equal(creates[1].data.reply_in_thread,true);
    const body=JSON.parse(creates[1].data.content);assert.equal(body.zh_cn.content[1][0].tag,'img');assert.match(body.zh_cn.content[0][0].text,/本地预览/);
    assert.deepEqual(uploads[0],png);assert.ok(!creates[1].data.content.includes(f.dir));
    assert.ok(f.store.isOwnMessage('group','image-msg'));
  }finally{channel.close();f.close();}
});
test('addressed create-PR intent opens a preview without model execution or implicit publication',async()=>{
  const f=fixture();f.store.set(f.task.id,'review');let runs=0;const views:View[]=[];
  const engine=new Engine(f.store,config,{run:async()=>{runs++;return 'unexpected';}},{send:async(_c,_t,_d,v)=>{if(v)views.push(v);}});
  try{
    engine.receive({id:'create-pr',chatId:'group',chatType:'group',senderId:'owner',senderType:'user',text:'创建 PR',botMentioned:true,conversation:f.task.conversation});
    await engine.flush();assert.equal(runs,0);assert.equal(views[0].kind,'publication');assert.equal(f.store.get(f.task.id)!.nextAction,'execute');
  }finally{await engine.stop();f.close();}
});
