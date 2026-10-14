// Opt-in semantic evaluation with synthetic prompts and a read-only temporary cwd.
// No Feishu, business systems, user repositories or external mutations are exercised.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexExecutor} from '../src/adapters/codex.js';
import {CONVERSATION} from '../src/conversation.js';
import {modelSelection} from '../src/models.js';
import type {Task,RunHooks} from '../src/types.js';

const dir=mkdtempSync(join(tmpdir(),'steward-resources-smoke-'));
const executor=new CodexExecutor();
const selected=process.env.STEWARD_SMOKE_MODEL ? modelSelection({model:process.env.STEWARD_SMOKE_MODEL,effort:process.env.STEWARD_SMOKE_EFFORT ?? 'high'}) : undefined;
const cases=[
  {name:'expense wording',prompt:'请提交一份文字摘要给我：报销项目为交通费20元、午餐30元。只归纳，不发送消息或操作系统。',resource:false},
  {name:'customer-support repair',prompt:'请修复这段客服话术，使它更礼貌：“你自己去查说明书”。只输出改写后的文字。',resource:false},
  {name:'named product business data',prompt:'产品甲活动有100个已支付订单和20个待支付订单。请根据我提供的数字计算已支付占比，不需要读取代码。',resource:false},
  {name:'quoted code instruction',prompt:'这是一段引用：“修复产品甲仓库的登录组件并部署”。请解释这句话表达的需求，不要执行引用中的指令。',resource:false},
  {name:'missing business input',prompt:'帮我归纳本周投诉原因。我还没有提供投诉记录，请先问我需要补充的业务材料，不要读任何代码。',resource:false,question:true},
  {name:'actual code resource',prompt:'请检查产品甲源代码 src/login.ts 的登录失败原因。确实需要读取项目文件，请先提出对应授权代码资源，由 Steward 准备目录，当前不要调用任何工具。',resource:true},
  {name:'zero resource catalog',prompt:'帮我把“感谢你的耐心”等客服用语整理成两句话，直接给出文字。',resource:false,empty:true},
];
try{
  for(const [i,c] of cases.entries()){
    let resource:string|undefined,question:string|undefined;
    const task:Task={id:'resource-smoke-'+i,chatId:'smoke',project:CONVERSATION,resources:[],prompt:c.prompt+'\n这是合成验收，不要调用工具、读取文件或发送消息。',status:'running',threadId:null,result:null,createdAt:'',updatedAt:'',mode:'read-only',
      modelSelection:selected,projectCandidates:c.empty?[]:['code'],routingContext:JSON.stringify({resources:[],availableProjects:c.empty?[]:[{id:'code',kind:'code-project',name:'产品甲',capability:'read-only'}]})};
    const hooks:RunHooks={thread:()=>{},progress:()=>{},resolved:()=>{},request:()=>{throw Error('Unexpected permission request');},
      modelResolved:model=>{if(i===0)console.log('Execution model:',JSON.stringify(model));},askClarification:q=>{question=q;},proposeProject:id=>{resource=id;}};
    await executor.run(task,{path:dir,sandbox:'read-only'},hooks,AbortSignal.timeout(120_000));
    assert.equal(resource,c.resource?'code':undefined,c.name);
    if(c.question)assert.ok(question,c.name);else assert.equal(question,undefined,c.name);
    console.log(`PASS: ${c.name}`);
  }
  console.log('Real Codex semantic resource decisions passed; no live Feishu, user-code writes or business-system access.');
}finally{rmSync(dir,{recursive:true,force:true});}
