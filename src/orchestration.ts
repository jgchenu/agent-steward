import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { projectGrantKey } from './routing.js';
import { clarification } from './clarification.js';
import type { Store } from './store.js';
import type { BaselineProposal, Executor, Project, PublicationTarget, RunHooks, Task } from './types.js';
import type { MergeProposal } from './operation-intent.js';

interface Outcome {
  message: string; question: string | null;
  projectId?: string; projectGrantKey?: string;
  publication?: PublicationTarget; baseline?: BaselineProposal; merge?: MergeProposal;
}
const State = Annotation.Root({
  prompt: Annotation<string>, step: Annotation<number>, grant: Annotation<string>, outcome: Annotation<Outcome>,
});

// The Engine remains the only scheduler. A graph is invoked only inside its active slot.
export class TaskOrchestrator {
  private saver: SqliteSaver;
  constructor(private store: Store) {
    this.saver = SqliteSaver.fromConnString(store.path);
    this.saver.db.pragma('journal_mode = WAL');
    this.saver.db.pragma('busy_timeout = 5000');
  }
  close(): void { this.saver.db.close(); }

  async run(task: Task, project: Project, executor: Executor, hooks: RunHooks, signal: AbortSignal): Promise<
    {waiting: true; step: number; question: string} | {waiting: false; message: string}
  > {
    if (!task.orchestrationRunId) throw Error('任务缺少编排运行标识。');
    const grant = projectGrantKey(project);
    const graph = new StateGraph(State)
      .addNode('execute', async state => {
        signal.throwIfAborted();
        if (state.grant !== grant) throw Error('项目授权或配置已变化，请检查后明确继续任务。');
        const id = `${task.orchestrationRunId}:${state.step}`;
        const saved = this.store.db.prepare('SELECT grantKey,result FROM graph_operations WHERE id=?').get(id) as {grantKey:string;result:string|null} | undefined;
        if (saved) {
          if (saved.grantKey !== grant) throw Error('执行记录的项目授权已变化。');
          if (saved.result === null) throw Error('上一轮执行结果不明，已阻止自动重放。请检查已有改动后明确继续。');
          return {outcome:JSON.parse(saved.result) as Outcome};
        }
        // Commit intent before calling a runtime that may change files or call tools.
        this.store.db.prepare('INSERT INTO graph_operations VALUES (?,?,?,NULL)').run(id,task.id,grant);
        const outcome: Outcome = {message:'',question:null};
        const capture: RunHooks = {...hooks,
          askClarification: question => {outcome.question=clarification(question);},
          ...(hooks.proposeProject ? {proposeProject:(id:string)=>{
            const key=task.projectCandidateGrants?.[id];
            if(typeof key !== 'string')throw Error('提议的代码资源不在本轮授权列表中。');
            outcome.projectId=id;outcome.projectGrantKey=key;
          }} : {}),
          ...(hooks.proposePublication ? {proposePublication:(p:PublicationTarget)=>{outcome.publication=p;}} : {}),
          ...(hooks.proposeBaseline ? {proposeBaseline:(p:BaselineProposal)=>{outcome.baseline=p;}} : {}),
          ...(hooks.proposeMerge ? {proposeMerge:(p:MergeProposal)=>{outcome.merge=p;}} : {}),
        };
        outcome.message = await executor.run({...task,prompt:state.prompt,threadId:this.store.get(task.id)!.threadId},project,capture,signal);
        signal.throwIfAborted();
        if ([!!outcome.question,!!outcome.projectId,!!outcome.publication,!!outcome.baseline,!!outcome.merge].filter(Boolean).length > 1) throw Error('每轮只能提出一个业务问题或操作。');
        this.store.db.prepare('UPDATE graph_operations SET result=? WHERE id=?').run(JSON.stringify(outcome),id);
        return {outcome};
      })
      .addNode('wait', state => {
        const answer = interrupt({question:state.outcome.question,step:state.step}) as string;
        if (typeof answer !== 'string' || !answer.trim() || answer.length > 64000) throw Error('业务问题回答无效。');
        return {prompt:`${state.prompt}\n\n待补充的问题：${state.outcome.question}\n主人本次补充（不构成权限批准）：${answer}`,step:state.step+1};
      })
      .addEdge(START,'execute')
      .addConditionalEdges('execute', state => state.outcome.question ? 'wait' : END)
      .addEdge('wait','execute')
      .compile({checkpointer:this.saver});
    const config = {configurable:{thread_id:task.orchestrationRunId},signal,recursionLimit:100};
    const previous = await graph.getState(config);
    if (previous.values.grant && previous.values.grant !== grant) throw Error('项目授权或配置已变化，请检查后明确继续任务。');
    const interrupted = previous.tasks.some(t => t.interrupts?.length);
    const wait = this.store.graphWait(task.id);
    if (interrupted && (wait?.answer == null || wait.step !== previous.values.step)) {
      return {waiting:true,step:previous.values.step,question:previous.values.outcome.question};
    }
    if (previous.next.length || !previous.values.prompt) {
      await graph.invoke(interrupted ? new Command({resume:wait!.answer}) : previous.values.prompt ? null :
        {prompt:task.prompt,step:0,grant}, config);
    }
    signal.throwIfAborted();
    const current = await graph.getState(config);
    if (current.tasks.some(t => t.interrupts?.length)) return {waiting:true,step:current.values.step,question:current.values.outcome.question};
    const outcome = current.values.outcome as Outcome;
    if (!outcome) throw Error('编排未产生可交付结果。');
    // Revalidate proposals through the Engine; a cached result never grants authority.
    if (outcome.projectId) {
      if(task.projectCandidateGrants?.[outcome.projectId] !== outcome.projectGrantKey) throw Error('代码资源授权已变化，保存的提议不能继续。');
      hooks.proposeProject?.(outcome.projectId);
    }
    if (outcome.publication) hooks.proposePublication?.(outcome.publication);
    if (outcome.baseline) hooks.proposeBaseline?.(outcome.baseline);
    if (outcome.merge) hooks.proposeMerge?.(outcome.merge);
    return {waiting:false,message:outcome.message};
  }
}
