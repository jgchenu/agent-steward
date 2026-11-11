import { projectGrantKey } from './routing.js';
import { runCommand } from './process.js';
import { publicPr } from './alert-collaboration.js';
import { alertBindingForTask } from './alert-provenance.js';
import { alertSourceKey } from './alert-config.js';
import type { Store } from './store.js';
import type { Config } from './types.js';

export interface RemotePr {url:string;state:'OPEN'|'CLOSED'|'MERGED';isDraft:boolean;headRefOid:string;baseRefName:string;mergedAt:string|null}
export type InspectPr=(repository:string,url:string,signal:AbortSignal)=>Promise<RemotePr>;
const inspect:InspectPr=async(repository,url,signal)=>{
  const r=await runCommand('gh',['pr','view',url,'--repo',repository,'--json','url,state,isDraft,headRefOid,baseRefName,mergedAt'],process.cwd(),signal,{timeoutSeconds:10});
  if(r.code||r.truncated)throw Error('PR 状态读取失败');return JSON.parse(r.stdout);
};
/** Read-only reconciliation; never converts drafts, changes task state or grants approval. */
export class PublishedPrMonitor {
  private timer?:ReturnType<typeof setInterval>;
  private active?:Promise<void>;
  private abort=new AbortController();
  private attempted=new Map<string,number>();
  constructor(private store:Store,private config:Config,private read:InspectPr=inspect,private now=Date.now){}
  start(){this.timer=setInterval(()=>{void this.tick();},60_000);void this.tick();}
  tick():Promise<void>{if(this.active)return this.active;this.active=this.scan().finally(()=>{this.active=undefined;});return this.active;}
  private async scan(){
    let count=0;
    for(const task of this.store.list().sort((a,b)=>(this.attempted.get(a.id)??0)-(this.attempted.get(b.id)??0))){
      if(this.abort.signal.aborted||count>=5)return;
      if(task.requesterId||task.requesterRevoked||['running','queued','waiting_approval','waiting_input'].includes(task.status))continue;
      const report=this.store.delivery(task.id),project=this.config.projects[task.project],url=publicPr(this.config,task,report?.prUrl);
      if(!report||!url||!project?.worktree?.github||report.remotePr?.state==='MERGED')continue;
      let binding;try{binding=alertBindingForTask(this.store,task.id);}catch{continue;}
      if(binding&&alertSourceKey(this.config,binding.sourceId)!==binding.sourceKey)continue;
      const grant=projectGrantKey(project);
      const last=this.attempted.get(task.id);if(last!==undefined&&this.now()-last<120_000)continue;
      this.attempted.set(task.id,this.now());count++;
      try{
        const remote=await this.read(project.worktree.github.repository,url,this.abort.signal);
        if(this.abort.signal.aborted)return;
        const current=this.store.delivery(task.id),fresh=this.store.get(task.id);
        if(!current||current.prUrl!==url||current.publishedSha!==report.publishedSha||fresh?.updatedAt!==task.updatedAt||(!this.config.projects[task.project]||projectGrantKey(this.config.projects[task.project])!==grant))continue;
        if(binding&&alertSourceKey(this.config,binding.sourceId)!==binding.sourceKey)continue;
        if(remote.url!==url||!['OPEN','CLOSED','MERGED'].includes(remote.state)||typeof remote.isDraft!=='boolean'
          ||typeof remote.headRefOid!=='string'||!/^[a-f0-9]{40}$/.test(remote.headRefOid)||remote.baseRefName!==project.worktree.github.baseBranch
          ||(remote.state==='MERGED'&&(typeof remote.mergedAt!=='string'||!Number.isFinite(Date.parse(remote.mergedAt)))))throw Error('PR 回读身份无效');
        this.store.saveDelivery(task.id,{...current,prIsDraft:remote.isDraft,remotePr:{...remote,checkedAt:new Date(this.now()).toISOString()}});
      }catch{if(!this.abort.signal.aborted)this.store.event(task.id,'pr_status_unavailable','远端状态暂未刷新，保留上次记录。');}
    }
  }
  async stop(){clearInterval(this.timer);this.abort.abort();await this.active;}
}
