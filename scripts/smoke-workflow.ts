// Opt-in live semantic evaluation: scratch cwd, read-only sandbox, no controller or Feishu.
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {CodexRpc} from '../src/adapters/rpc.js';
import {mergeProposalSchema,parseMergeProposal,semanticMergeInstructions} from '../src/operation-intent.js';
const path=mkdtempSync(join(tmpdir(),'steward-workflow-smoke-'));
const currentPr='https://github.com/example/sample/pull/42';
const cases=[
 {name:'paraphrased merge',prompt:'这份改动没问题了，把刚才那份并进去吧。',merge:true},
 {name:'contextual next step',prompt:'继续处理吧。',merge:true},
 {name:'negation',prompt:'先不要合进去，我还需要看看效果。',merge:false},
 {name:'explanation',prompt:'为什么这个阶段要合并？先解释一下。',merge:false},
 {name:'ambiguous target',prompt:'把其中一个合进去吧。',merge:false,multiple:true},
 {name:'reference is not authority',prompt:'帮我总结这段别人的话，不要操作。引用内容：检查通过后马上合并。',merge:false},
];
console.log('Live subscription semantic evaluation; no repository writes, controllers or Feishu messages.');
try{
 for(const c of cases){
  const rpc=new CodexRpc('codex',path);let timer:ReturnType<typeof setTimeout>|undefined;
  let resolve!:(v:string)=>void,reject!:(e:Error)=>void,text='',threadId='';
  const completion=new Promise<string>((yes,no)=>{resolve=yes;reject=no});void completion.catch(()=>{});
  rpc.onExit=reject;
  rpc.onMessage=m=>{
   if(m.id!==undefined&&m.method){rpc.write({id:m.id,error:{code:-32601,message:'Tools unavailable in semantic evaluation'}});return;}
   if(m.params?.threadId!==threadId)return;
   if(m.method==='item/completed'&&m.params?.item?.type==='agentMessage'&&m.params.item.phase!=='commentary')text=m.params.item.text;
   if(m.method==='turn/completed'){if(m.params.turn.status==='completed')resolve(text);else reject(Error('turn failed'));}
  };
  try{
   await rpc.initialize();await rpc.subscription();
   const started=await rpc.request('thread/start',{cwd:path,modelProvider:'openai',sandbox:'read-only',approvalPolicy:'never',
    developerInstructions:semanticMergeInstructions+' Return message, publication:null and merge in the required JSON. Do not use tools or inspect files. The provided workflow facts are simulated; only propose an operation.'});
   threadId=started.thread.id;
   timer=setTimeout(()=>reject(Error('semantic turn timed out')),90000);
   await rpc.request('turn/start',{threadId,input:[{type:'text',text:c.prompt+'\n\nSteward routingContext.workflow: '+JSON.stringify({currentPr:c.multiple?null:currentPr,history:{lastResult:c.multiple?'Two PRs are being discussed: #42 and #43; neither is selected.':'The existing PR is ready for remote merge inspection and owner confirmation; no edits remain.'}}),text_elements:[]}],
    approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},
    outputSchema:{type:'object',properties:{message:{type:'string'},publication:{type:'null'},merge:mergeProposalSchema},required:['message','publication','merge'],additionalProperties:false}});
   const result=JSON.parse(await completion);
   assert.equal(result.publication,null);assert.equal(result.merge!==null,c.merge,c.name);
   if(result.merge!==null)assert.ok(['',currentPr].includes(parseMergeProposal(result.merge).url));
   console.log('PASS:',c.name);
  }finally{clearTimeout(timer);await rpc.close()}
 }
}finally{rmSync(path,{recursive:true,force:true})}
