import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readableFileReferences } from '../src/channels/file-references.js';
import { FeishuChannel } from '../src/channels/feishu.js';
import { Store } from '../src/store.js';
import type { Config } from '../src/types.js';

const roots = ['/private/steward/worktrees/abcd1234', '/work/project'];
test('local citations keep repository-relative paths and target line numbers instead of broken links', () => {
  assert.equal(readableFileReferences('[Login.tsx:131](/private/steward/worktrees/abcd1234/src/Login.tsx:131)', roots), '`src/Login.tsx:131`');
  assert.equal(readableFileReferences('[证据](file:///work/project/src/Login.tsx#L54-L60)', roots), '`src/Login.tsx#L54-L60`');
  assert.equal(readableFileReferences('[源文件](vscode://file/work/project/src/Login.tsx:54:2)', roots), '`src/Login.tsx:54:2`');
  assert.equal(readableFileReferences('[证据:42](./src/login.ts)', roots), '`src/login.ts:42`');
  assert.equal(readableFileReferences('[文件](login.ts:42)', roots), '`login.ts:42`');
});
test('spaces, encoded and parenthesized paths remain complete; unknown absolute roots are not leaked', () => {
  assert.equal(readableFileReferences('[页](</work/project/src/(auth)/My Page.tsx:7> "说明")', roots), '`src/(auth)/My Page.tsx:7`');
  assert.equal(readableFileReferences('[页](/work/project/src/(auth)/(nested)/page.tsx#L8)', roots), '`src/(auth)/(nested)/page.tsx#L8`');
  assert.equal(readableFileReferences('[页](file:///work/project/My%20Page.tsx:9)', roots), '`My Page.tsx:9`');
  assert.equal(readableFileReferences('[页](/work/project-other/src/private.ts:3)', roots), '`private.ts:3`');
  assert.equal(readableFileReferences('[页](/work/project/../../other/private.ts:3)', roots), '`private.ts:3`');
  assert.equal(readableFileReferences('[页](C:\\repo\\src\\page.tsx:10)', ['C:\\repo']), '`src/page.tsx:10`');
  assert.equal(readableFileReferences('![图片](/work/project/docs/diagram.png)', roots), '`docs/diagram.png`');
  assert.equal(readableFileReferences('![](/work/project/docs/diagram.png)', roots), '`docs/diagram.png`');
});
test('web and PR URLs and literal code examples survive unchanged', () => {
  const text = '[PR](https://github.com/example/repo/pull/1) [文档](https://example.com/a_(b)) [邮箱](mailto:test@example.com) [节](#section) [资源](//example.com/file)';
  assert.equal(readableFileReferences(text, roots), text);
  const code = '`[file](/work/project/a.ts)`\n```md\n[file](/work/project/a.ts)\n```';
  assert.equal(readableFileReferences(code, roots), code);
});
test('Feishu sends source and task-worktree citations as text, preserving web links and retry deduplication', async () => {
  const store = new Store(':memory:');
  const config: Config = {ownerId:'owner',stateDir:'.',codexCommand:'codex',maxRunMinutes:1,projects:{code:{path:'/work/project',sandbox:'read-only'}}};
  const task = store.create('group','code','inspect','read-only',{anchorId:'root',sourceId:'source',scope:'thread'});
  store.saveWorkspace({taskId:task.id,path:roots[0],source:roots[1],branch:'steward/'+task.id,baseSha:'abc',baseRef:'feature/test'});
  const channel = new FeishuChannel('fake','fake',store,config), sent: any[] = [];
  (channel as any).client={im:{message:{reply:async(p:any)=>{sent.push(p);return{code:0,data:{message_id:'out',thread_id:'topic'}}}}}};
  try {
    const text='依据：[Login.tsx:131]('+roots[0]+'/src/Login.tsx:131)、[配置](/work/project/config.ts#L2)。[PR](https://github.com/example/repo/pull/1)';
    await channel.send('group',text,'delivery',{kind:'reply',taskId:task.id});
    await channel.send('group',text,'delivery',{kind:'reply',taskId:task.id});
    assert.equal(sent.length,1);
    assert.equal(JSON.parse(sent[0].data.content).zh_cn.content[0][0].text,'依据：`src/Login.tsx:131`、`config.ts#L2`。[PR](https://github.com/example/repo/pull/1)');
    assert.equal(sent[0].data.reply_in_thread,true);
    assert.equal(store.conversationTask('group',{anchorId:'out',sourceId:'followup',scope:'thread'})!.id,task.id);
  } finally { channel.close();store.close(); }
});
