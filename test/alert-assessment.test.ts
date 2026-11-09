import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {alertSourceKey} from '../src/alert-config.js';
import {alertBindingForTask,pendingAlertTasks,alertRepairTask} from '../src/alert-provenance.js';
import {completeAlertAssessment,parseAlertAssessment,type AlertAssessment} from '../src/alert-assessment.js';
import {alertTopic,recordTopicMessage,syncAlertTopics} from '../src/alert-collaboration.js';
import type {Config,Task} from '../src/types.js';
const decision:AlertAssessment={verdict:'needs_fix',summary:'断线重连后会重复提交生成请求',explanation:'已在调用方确认重试未使用同一个请求标识。',impact:'已确认一条生产样本，实际影响范围待核查。',evidence:['生产事件与 src/retry.ts:42 的调用链一致']};
function fixture(path=':memory:') {
  const store=new Store(path);
  const config:Config={ownerId:'owner',stateDir:'.',codexCommand:'unused',maxRunMinutes:1,langGraphPilot:false,groupChats:true,
    projects:{web:{path:'.',sandbox:'workspace-write',worktree:{baseRef:'main',checks:[]}}},
    alertSources:{web:{kind:'sentry',enabled:true,project:'web',chatId:'oc_dm',collaborationChatId:'oc_group',mode:'workspace-write',pollSeconds:60,maxTasksPerDay:10,
      sentry:{region:'us',organization:'example',projectId:'123',environment:'production',tokenEnv:'STEWARD_SENTRY_TEST_TOKEN'}}}};
  const key=alertSourceKey(config,'web')!;
  const diagnosis=()=>{const t=store.create('oc_dm','web','PRIVATE diagnostic transcript','read-only');
    store.event(t.id,'alert_assessment_required','read-only');store.thread(t.id,'private-session');
    store.db.prepare('INSERT INTO alert_runs VALUES (?,?,?,?,?,?)').run(t.id,'web',key,'1','signature',t.createdAt);return store.get(t.id)!;};
  return {store,config,key,diagnosis};
}
const groups=(s:Store)=>s.db.prepare("SELECT * FROM outbox WHERE chatId='oc_group'").all();
async function until(f:()=>boolean){for(let i=0;i<200;i++){if(f())return;await setTimeout(10);}assert.fail('condition not reached');}

test('noise, expected errors and missing evidence never create a group topic or writable task',()=>{
  for(const verdict of ['noise','expected','insufficient_evidence'] as const){
    const f=fixture();try{const t=f.diagnosis();f.store.set(t.id,'review');completeAlertAssessment(f.store,f.config,t,{...decision,verdict});
      assert.equal(groups(f.store).length,0);assert.equal(f.store.list().length,1);assert.equal(alertRepairTask(f.store,t.id),undefined);
      assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_noise_rules').get()!.n,0); // model cannot grant permanent filtering
    }finally{f.store.close();}
  }
});

test('verified diagnosis creates one fresh group repair with summary, provenance and the existing daily receipt',()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-assess-')),f=fixture(join(dir,'db'));
  try{const t=f.diagnosis();f.store.set(t.id,'review');completeAlertAssessment(f.store,f.config,t,decision);
    const child=f.store.get(alertRepairTask(f.store,t.id)!)!;
    assert.equal(child.chatId,'oc_group');assert.equal(child.mode,'workspace-write');assert.equal(child.threadId,null);
    assert.equal(child.conversation,undefined);assert.equal(f.store.requests(child.id).length,0);
    assert.deepEqual({...alertBindingForTask(f.store,child.id)},{sourceId:'web',sourceKey:f.key,issueId:'1'});
    assert.equal(pendingAlertTasks(f.store),1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM alert_runs').get()!.n,1);
    const root=groups(f.store)[0];assert.match(String(root.text),/断线重连/);assert.ok(String(root.text).includes(decision.impact));
    assert.ok(!String(root.text).includes(decision.explanation));
    for (const evidence of decision.evidence) {
      assert.ok(!String(root.text).includes(evidence));assert.ok(child.prompt.includes(evidence));
    }
    assert.match(String(root.text),/\[查看 Sentry 问题\]\(https:\/\/example.sentry.io\/issues\/1\/\?project=123\)/);
    assert.doesNotMatch(String(root.text)+child.prompt,/PRIVATE|private-session/);
    const reopened=new Store(join(dir,'db'));try{completeAlertAssessment(reopened,f.config,t,decision);assert.equal(reopened.list().length,2);assert.equal(groups(reopened).length,1);}finally{reopened.close();}
    // A later noise diagnosis neither takes ownership of the old topic nor broadcasts its private result.
    f.store.set(child.id,'review');const again=f.diagnosis();f.store.set(again.id,'review','PRIVATE noise');
    completeAlertAssessment(f.store,f.config,again,{...decision,verdict:'noise'});syncAlertTopics(f.store,f.config);
    assert.equal(groups(f.store).length,1);assert.equal(f.store.db.prepare('SELECT taskId FROM alert_topics').get()!.taskId,child.id);
  }finally{f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('malformed or revoked diagnoses fail closed and a failed outbox write rolls back promotion',()=>{
  const f=fixture();try{const t=f.diagnosis();
    assert.throws(()=>parseAlertAssessment({...decision,evidence:[]}));assert.throws(()=>parseAlertAssessment({...decision,verdict:'guess'}));
    f.config.alertSources!.web.enabled=false;assert.throws(()=>completeAlertAssessment(f.store,f.config,t,decision));assert.equal(f.store.list().length,1);
    f.config.alertSources!.web.enabled=true;
    f.store.db.exec("CREATE TRIGGER fail_root BEFORE INSERT ON outbox BEGIN SELECT RAISE(FAIL,'test'); END;");
    assert.throws(()=>completeAlertAssessment(f.store,f.config,t,decision));assert.equal(f.store.list().length,1);assert.equal(alertRepairTask(f.store,t.id),undefined);
    f.store.db.exec('DROP TRIGGER fail_root');completeAlertAssessment(f.store,f.config,t,decision);assert.equal(f.store.list().length,2);
  }finally{f.store.close();}
});

test('engine privately assesses then delivers the group root before repair and accepts only owner topic approval',async()=>{
  const f=fixture(),first=f.diagnosis();let repair:Task|undefined,accepted=false;const sent:Array<{chat:string,text:string}>=[];
  const engine=new Engine(f.store,f.config,{run:async(t,_p,h)=>{
    if(h.reportAlertAssessment){assert.equal(t.chatId,'oc_dm');assert.equal(t.mode,'read-only');h.reportAlertAssessment(decision);return '已确认需要修复。';}
    repair=t;assert.equal(t.conversation?.anchorId,'root');assert.equal(t.threadId,null);
    await new Promise<void>(resolve=>h.request({kind:'approval',description:'具体修复操作',resolve:answer=>{accepted=answer==='accept';resolve();}}));return '修复完成';
  }},{send:async(chat,text,_id,view)=>{
    sent.push({chat,text});if(view?.kind==='alert-collaboration' && view.root)recordTopicMessage(f.store,alertTopic(f.store,view.topicId)!,'root','thread',true);
  }});
  try{engine.start();await until(()=>!!repair && f.store.requests(repair.id).length===1).catch(e=>{throw Error(JSON.stringify(f.store.list().map(t=>({id:t.id,status:t.status,result:t.result,conversation:t.conversation})))+e);});
    assert.equal(f.store.get(first.id)?.status,'review');assert.ok(sent.some(x=>x.chat==='oc_group' && x.text.includes(decision.summary)));
    const request=f.store.requests(repair!.id)[0].id;
    const message={id:'decision',senderId:'owner',senderType:'user',chatId:'oc_group',chatType:'group' as const,botMentioned:true,
      conversation:{anchorId:'root',parentId:'root',sourceId:'decision',threadId:'thread',scope:'thread' as const},text:`/approve ${request}`};
    engine.receive({...message,id:'wrong-person',senderId:'stranger'});engine.receive({...message,id:'wrong-chat',chatId:'oc_dm'});
    assert.equal(accepted,false);engine.receive(message);await until(()=>f.store.get(repair!.id)?.status==='review');assert.equal(accepted,true);
  }finally{await engine.stop();f.store.close();}
});
