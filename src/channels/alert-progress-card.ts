import { alertDescription, publicPr, type AlertTopic } from '../alert-collaboration.js';
import { sentryIssueUrl } from '../sentry.js';
import type { Store } from '../store.js';
import type { Config, DeliveryReport, Task } from '../types.js';
import { canPublish } from '../workspace.js';

const plain = (content: string) => ({ tag: 'plain_text', content });
const markdown = (content: string) => ({ tag: 'markdown', content });
const escape = (text: string) => text.replace(/[<>\[\]*`\\]/g, '').trim();

function validation(report: DeliveryReport | undefined): string | undefined {
  if (!report) return;
  const timeout = report.error?.match(/^「([^」]{1,80})」超过 (\d+) 秒(，重试后仍未获得结果。原补丁已保留。)?$/u);
  if (timeout) return `${escape(timeout[1])}超过 ${timeout[2]} 秒${timeout[3] ? '，重试后仍未完成，原补丁已保留。' : '，原补丁已保留。'}`;
  if (report.targetBlocked || (report.targetBefore && report.targetBefore !== report.workspace?.baseSha)) {
    return '目标分支有更新，需要重新验证。';
  }
  if (report.checks.some(check => check.status === 'failed')) {
    return report.baselineComparison?.eligible
      ? '全量检查仍有失败，已和修复前的版本对照。'
      : '项目检查未通过。';
  }
  if (!report.ready || !report.checks.length) return '验证尚未完成。';
  const remaining = report.summary?.remaining;
  if (remaining?.length) return `还需确认：${remaining.map(escape).join('、')}`;
  return '项目检查已通过。';
}

/** Render only shareable issue analysis, verification records and validated links. */
export function alertProgressCard(store: Store, config: Config, topic: AlertTopic, task: Task) {
  const report = store.delivery(task.id);
  const assessment = alertDescription(store, task);
  const source = config.alertSources![topic.sourceId];
  const project = config.projects[task.project];
  const rawTitle = report?.summary?.title ?? assessment?.summary ?? `Sentry 问题 ${topic.issueId}`;
  const title = Array.from(escape(rawTitle).replace(/^修复\s*/, '').replace(/的问题$/, '') || `Sentry 问题 ${topic.issueId}`).slice(0, 65).join('');
  const pr = publicPr(config, task, report?.prUrl);
  const remote = report?.remotePr?.url === pr ? report?.remotePr : undefined;
  const mergedPr = publicPr(config, task, store.mergeReceipt(task.id)?.url) ?? (remote?.state === 'MERGED' ? pr : undefined);
  const draft = remote?.isDraft ?? report?.prIsDraft;
  const checks = validation(report);

  let status = '处理中';
  let template = 'blue';
  if (mergedPr) { status = '已合并'; template = 'green'; }
  else if (remote?.state === 'CLOSED') { status = 'PR 已关闭'; template = 'grey'; }
  else if (task.status === 'waiting_approval') { status = '待确认'; template = 'orange'; }
  else if (task.status === 'waiting_input') { status = '待补充信息'; template = 'orange'; }
  else if (['failed','interrupted','cancelled'].includes(task.status)) { status = '处理暂停'; template = 'grey'; }
  else if (pr && draft === false) status = '待审查';
  else if (pr && draft === true) { status = '草稿 PR'; template = 'orange'; }
  else if (pr) status = 'PR 已提交';
  else if (task.status === 'review' || task.status === 'completed') {
    const checksPassed = report?.ready && report.checks.length && report.checks.every(check => check.status === 'passed');
    const ready = report?.summary && !report.summary.remaining.length && (checksPassed || canPublish(task,project,report))
      && !report.targetBlocked && (!report.targetBefore || report.targetBefore === report.workspace?.baseSha);
    status = ready ? '待确认提交' : report ? '待验证' : '排查结果';
    template = ready ? 'blue' : 'orange';
  }

  const fields: string[] = [];
  if (report?.summary?.problem) fields.push(`**问题**　${escape(report.summary.problem)}`);
  else if (assessment?.impact) fields.push(`**影响**　${escape(assessment.impact)}`);
  if (report?.summary?.change) fields.push(`**修复**　${escape(report.summary.change)}`);
  if (checks && !mergedPr) fields.push(`**验证**　${checks}`);
  if (mergedPr) fields.push('**上线**　待核对生产发布和实际效果。');
  if (!fields.length) fields.push('正在核对报错和受影响的功能。');

  const prLink = mergedPr ?? pr;
  const links = [prLink ? `[查看 PR #${prLink.split('/').at(-1)}](${prLink})` : undefined,
    `[查看 Sentry 问题](${sentryIssueUrl(source, topic.issueId)})`].filter(Boolean);
  const subtitle = `${source.reportLabel ?? project?.label ?? task.project} · ${status}`;
  return {
    schema: '2.0',
    config: { update_multi: true, enable_forward: true, width_mode: 'default', summary: { content: `${title} · ${status}` } },
    header: { title: plain(title), subtitle: plain(subtitle), template },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '8px', elements: [markdown(fields.join('\n')), { tag: 'hr' }, markdown(links.join('　·　'))] },
  };
}
