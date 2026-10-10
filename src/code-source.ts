import type { DeliveryReport, Project } from './types.js';

export function codeSourceSummary(report?: DeliveryReport): string {
  if (!report) return '代码来源 · 尚未记录实际执行版本';
  return `代码来源 · ${report.workspace.baseRef} @ ${report.workspace.baseSha.slice(0, 12)} · 独立副本`;
}

export function codeSourceDetails(report: DeliveryReport | undefined, project: Project | undefined, group: boolean): string {
  if (!report) return [
    '尚未记录实际执行版本，不能根据项目配置认定本次使用的提交。',
    project?.worktree ? `配置基准：${project.worktree.baseRef}（尚非执行证据）` : '此项目未配置 Git 独立副本，执行时使用授权目录；未记录 Git 版本。',
    ...(!group && project ? [`配置目录：${project.path}`] : []),
  ].join('\n');
  const w = report.workspace;
  return [
    `基准来源：${w.baseRef}`,
    `基准提交：${w.baseSha}`,
    `任务分支：${w.branch}`,
    `最近检查提交：${report.headSha}`,
    `相对基准累计改动：${report.files.length} 个文件（含未提交文件，详情见“查看交付”）`,
    `检查时间：${report.capturedAt}`,
    '以上为最近一次检查记录，非实时；不代表远端最新版或线上部署版本。',
    '执行位置：独立 Git 副本。原目录未提交内容不会自动带入；继续任务会保留副本已有改动。',
    ...(!group ? [`来源目录：${w.source}`, `执行目录：${w.path}`] : []),
  ].join('\n');
}

export function codeSourceReceipt(label: string, report: DeliveryReport): string {
  return `我会在 ${label} 的独立副本中${report.mode === 'read-only' ? '分析' : '处理'}。基准：${report.workspace.baseRef} @ ${report.workspace.baseSha.slice(0, 12)}；开始时提交：${report.headSha.slice(0, 12)}。`
    + (report.files.length ? `副本已有相对基准累计 ${report.files.length} 个文件改动，会在此基础上继续。` : '')
    + '可在任务详情查看代码来源；群话题里也可以 @我说“代码来源”。';
}

export function configuredCheckSummary(report: DeliveryReport, project?: Project): string {
  if (report.checks.length) return report.checks.map(c => `${c.name}: ${c.status === 'passed' ? '通过' : c.status === 'failed' ? '失败' : '执行中'}`).join('；');
  if (report.mode === 'read-only') return '只读分析，不运行项目检查';
  return project?.worktree?.checks.length ? '尚未运行' : '未配置（不代表执行 Agent 没有自行验证）';
}
