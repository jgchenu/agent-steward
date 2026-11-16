import test from 'node:test';
import assert from 'node:assert/strict';
import {summaryCard} from '../src/channels/summary-card.js';
import {FeishuChannel} from '../src/channels/feishu.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/types.js';
test('report cards preserve all categories, links and uncertainty without adding controls',()=>{
 const text='Flova · 处理周报\n\n本期跟进 12 个问题；PR：已合并 3，待合并 2，已关闭未合并 1；6 个问题未提交 PR。\n\n- [编辑器](https://example.com/issue)：已合并不代表已上线。\n\n**待核实**\n缺少事件证据。\n\n**噪音**\n只抽查了样本。';
 const card=summaryCard(text,'report') as any,raw=JSON.stringify(card);
 assert.equal(card.schema,'2.0');assert.ok(card.body.elements.length<=5);
 assert.equal(card.body.elements[0].columns.length,3);
 for(const word of ['12','https://example.com/issue','已合并不代表已上线','缺少事件证据','只抽查了样本'])assert.ok(raw.includes(word));
 assert.doesNotMatch(raw,/actionId|"tag":"form"|"type":"callback"/);
 assert.ok(raw.includes('collapsible_panel'));
});
test('ordinary reply cards preserve complete text and neutralize mentions and remote images',()=>{
 const card=summaryCard('结果 <at id=all>所有人</at> ![图](https://example.com/a.png)') as any;
 const body=card.body.elements[0].columns[0].elements[0].content;
 assert.equal(body,'结果 &lt;at id=all&gt;所有人&lt;/at&gt; [图片：图](https://example.com/a.png)');
 assert.doesNotMatch(JSON.stringify(card),/"tag":"img"|"tag":"input"/);
});
test('revoked overview authorization suppresses writes even with a legacy receipt',async()=>{
 const store=new Store(':memory:');
 // No authorized overview means no outgoing write, including a stale legacy receipt.
 const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'none',maxRunMinutes:1,projects:{}};
 const channel=new FeishuChannel('fake','fake',store,config);let writes=0;
 (channel as any).client={im:{message:{create:async()=>{writes++;},patch:async()=>{writes++;}}}};
 store.saveCardMessage('dm','pr-overview:message','legacy-post');
 try{await channel.send('dm','','x',{kind:'pr-overview'});assert.equal(writes,0);}finally{store.close();}
});
