import { CodexRpc } from './adapters/rpc.js';
export interface ModelSelection { model: string; effort: string }
export interface CodexModel { model: string; name: string; defaultEffort: string; efforts: string[] }
export function modelSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined) return;
  const v = value as ModelSelection;
  if (!v || typeof v.model !== 'string' || typeof v.effort !== 'string' || !/^[\w.-]{1,100}$/.test(v.model) || !/^[\w-]{1,40}$/.test(v.effort)) throw Error('模型设置无效。');
  return {model:v.model,effort:v.effort};
}
export async function readModels(rpc: Pick<CodexRpc,'request'>): Promise<CodexModel[]> {
  const models: CodexModel[] = [], seen = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await rpc.request('model/list',{limit:100,includeHidden:false,...(cursor ? {cursor} : {})});
    if (!Array.isArray(page?.data)) throw Error('Codex 模型列表格式不兼容。');
    for (const m of page.data) {
      if (m.hidden) continue;
      const selection = modelSelection({model:m.model,effort:m.defaultReasoningEffort})!;
      if (typeof m.displayName !== 'string' || !Array.isArray(m.supportedReasoningEfforts)) throw Error('Codex 模型列表格式不兼容。');
      const efforts = m.supportedReasoningEfforts.map((e: any) => modelSelection({model:m.model,effort:e.reasoningEffort})!.effort);
      if (!efforts.includes(selection.effort) || models.some(x=>x.model===m.model)) throw Error('Codex 模型列表无效。');
      models.push({model:m.model,name:m.displayName,defaultEffort:selection.effort,efforts});
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw Error('Codex 模型分页无效。');
    if (cursor) seen.add(cursor);
    if (seen.size > 20 || models.length > 2000) throw Error('Codex 模型数量超出支持范围。');
  } while (cursor);
  return models;
}
export function validateSelection(selection: ModelSelection, models: CodexModel[]) {
  const m = models.find(m=>m.model===selection.model);
  if (!m || !m.efforts.includes(selection.effort)) throw Error('所选模型或思考强度已不可用，请在控制台重新选择。');
}
export async function listCodexModels(command: string, cwd: string) {
  const rpc = new CodexRpc(command,cwd);
  try {await rpc.initialize(); return await readModels(rpc);} finally {await rpc.close();}
}
