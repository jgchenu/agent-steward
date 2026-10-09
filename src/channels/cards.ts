import type { Config, Intent, Status, View } from '../types.js';
import { Store } from '../store.js';

type Element = Record<string, unknown>;
const plain = (content: string) => ({ tag: 'plain_text', content });
const text = (content: string, lines?: number): Element => ({ tag: 'div', text: { ...plain(content), ...(lines ? { lines } : {}) } });
const caption = (content: string): Element => ({ tag: 'div', text: { ...plain(content), text_size: 'notation', text_color: 'grey' } });
const row = (...elements: Element[]): Element => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
  columns: elements.map(element => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })) });
const box = (content: string): Element => ({ tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column',
  width: 'weighted', weight: 1, padding: '12px', background_style: 'grey-50', elements: [text(content, 4)] }] });
// Status styling is shared by list rows and task details; labels remain readable without color.
const status: Record<Status, [label: string, color: string, mark: string, hint: string]> = {
  queued: ['已排队', 'grey', '○', '等待前面的任务结束'],
  running: ['执行中', 'blue', '◉', '正在处理，可随时查看进度'],
  waiting_approval: ['需要授权', 'orange', '!', '查看具体操作，再决定是否允许'],
  waiting_input: ['等你补充', 'orange', '?', '补充信息后即可继续'],
  review: ['待你验收', 'purple', '◇', '已有结果，请检查后确认完成'],
  completed: ['已完成', 'green', '✓', '已由你确认验收'],
  failed: ['执行失败', 'red', '×', '查看原因后决定下一步'],
  cancelled: ['已停止', 'grey', '■', '执行已停止，已有改动保留'],
  interrupted: ['已中断', 'orange', 'Ⅱ', '检查已有改动后可继续'],
};
const badge = (state: Status): Element => {
  const [label, color, mark] = status[state];
  // Only fixed application-owned strings are interpreted as markup.
  return { tag: 'markdown', content: `<text_tag color='${color === 'grey' ? 'neutral' : color}'>${mark} ${label}</text_tag>` };
};
const taskHeading = (prompt: string): Element => ({ tag: 'div', text: { ...plain(prompt), text_size: 'heading-3', lines: 2 } });
const stateBox = (prompt: string, state: Status): Element => ({
  tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column', width: 'weighted', weight: 1,
    background_style: `${status[state][1]}-50`, padding: '12px', vertical_spacing: '8px',
    elements: [badge(state), taskHeading(prompt), caption(status[state][3])] }],
});
export function viewKey(view: View): string {
  return 'taskId' in view ? `${view.kind}:${view.taskId}` : view.kind;
}
export function buildCard(store: Store, config: Config, chatId: string, view?: View, notice = ''): Record<string, unknown> {
  const button = (label: string, intent: Intent, primary = false, confirm?: string): Element => ({
    tag: 'button', text: plain(label), type: primary ? 'primary_filled' : 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { actionId: store.action(chatId, intent) } }],
    ...(confirm ? { confirm: { title: plain(label), text: plain(confirm) } } : {}),
  });
  const form = (label: string, intent: Intent, fields: Element[]): Element => ({ tag: 'form', name: 'steward_form',
    elements: [...fields, { tag: 'button', name: store.action(chatId, intent), text: plain(label),
      type: 'primary_filled', width: 'fill', form_action_type: 'submit' }] });
  const input = (label: string, placeholder: string): Element => ({ tag: 'input', name: 'body', required: true,
    label: plain(label), placeholder: plain(placeholder), input_type: 'multiline_text', rows: 3, max_length: 1000, width: 'fill' });
  const card = (title: string, subtitle: string, color: string, elements: Element[]): Record<string, unknown> => ({
    schema: '2.0', config: { update_multi: true, enable_forward: false, width_mode: 'default', summary: { content: title } },
    header: { title: plain(title), subtitle: plain(subtitle), template: color,
      icon: { tag: 'standard_icon', token: 'todo_colorful' } },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '12px', elements },
  });
  const homeButton = (primary = false) => button('派新任务', { op: 'home' }, primary);
  if (!view) return card('Agent Steward', '工作动态', 'blue', [box(notice), homeButton()]);
  if (view.kind === 'home') {
    const projects = Object.entries(config.projects);
    return card('交给我来做', 'Agent Steward · 你的数字员工', 'blue', [
      box('选一个项目，告诉我希望完成什么。需要你决定时，我会在这里找你。'),
      form('开始执行', { op: 'new' }, [
        { tag: 'select_static', name: 'project', required: true, width: 'fill', placeholder: plain('选择项目'),
          ...(projects.length === 1 ? { initial_option: projects[0][0] } : {}),
          options: projects.map(([name, p]) => ({ text: plain(`${name} · ${p.sandbox === 'read-only' ? '只读' : '可修改文件'}`), value: name })) },
        input('任务要求', '例如：检查这个项目，并给我三条改进建议'),
      ]), row(button('我的任务', { op: 'list' }), button('刷新入口', { op: 'home' })),
    ]);
  }
  if (view.kind === 'list') {
    const tasks = store.list(chatId), page = Math.min(Math.max(0, view.page ?? 0), Math.max(0, Math.ceil(tasks.length / 3) - 1));
    const items = tasks.slice(page * 3, page * 3 + 3).map(t => ({
      tag: 'interactive_container', width: 'fill', has_border: true, corner_radius: '8px',
      border_color: `${status[t.status][1]}-100`, background_style: `${status[t.status][1]}-50`,
      padding: '12px', vertical_spacing: '8px',
      behaviors: [{ type: 'callback', value: { actionId: store.action(chatId, { op: 'status', taskId: t.id }) } }],
      elements: [badge(t.status), taskHeading(t.prompt), caption(`项目 · ${t.project}`),
        row(caption(status[t.status][3]), { tag: 'div', text: { ...plain('打开任务 ›'), text_color: status[t.status][1], text_align: 'right', text_size: 'notation' } })],
    }));
    const nav = [homeButton(true)];
    if (page > 0) nav.push(button('上一页', { op: 'list', page: page - 1 }));
    if ((page + 1) * 3 < tasks.length) nav.push(button('下一页', { op: 'list', page: page + 1 }));
    return card('我的任务', `最近 ${tasks.length} 项 · 第 ${page + 1} 页 · 点击任务查看详情`, 'grey', [...(items.length ? items : [box('还没有任务。从一个小任务开始吧。')]), row(...nav)]);
  }
  const task = store.get(view.taskId);
  if (!task || task.chatId !== chatId) return card('任务不可用', '请重新打开任务列表', 'grey', [box('找不到当前会话中的任务。'), homeButton()]);
  const [label, color] = status[task.status];
  const intent = (op: Intent['op']): Intent => ({ op, taskId: task.id, revision: task.updatedAt });
  if (view.kind === 'followup') return card('继续这项任务', `${task.project} · ${task.id}`, 'blue', [box(task.prompt),
    form('提交后续要求', intent('continue'), [input('希望调整什么', '说明需要补充、修改或继续的内容')]),
    button('返回任务', intent('status'))]);
  if (view.kind === 'result') {
    const chars = Array.from((task.result ?? store.latestProgress(task.id)) || '还没有可展示的内容。');
    const pages = Math.ceil(chars.length / 1800), page = Math.min(Math.max(0, view.page ?? 0), pages - 1);
    const nav = [button('返回任务', intent('status'))];
    if (page > 0) nav.push(button('上一页', { ...intent('result'), page: page - 1 }));
    if (page + 1 < pages) nav.push(button('下一页', { ...intent('result'), page: page + 1 }));
    return card('任务详情', `${task.project} · 第 ${page + 1} / ${pages} 页`, color, [
      text(chars.slice(page * 1800, (page + 1) * 1800).join('')), row(...nav)]);
  }
  const req = store.requests(task.id)[0];
  if (req) {
    const request = store.getRequest(req.id)!;
    const action = (op: Intent['op']): Intent => ({ ...intent(op), requestId: req.id });
    // Approval details must be complete. Oversized content is never paired with an accept button.
    const fits = Buffer.byteLength(JSON.stringify(request.description)) < 20_000;
    const detail = { tag: 'collapsible_panel', expanded: true, header: { title: plain('具体内容') },
      elements: [text(fits ? request.description : '请求内容过长，无法在一张卡片内完整展示。本卡片只允许拒绝；请在本地检查。')] };
    return card(label, `${task.project} · ${task.id}`, color, [stateBox(task.prompt, task.status), detail,
      ...(req.kind === 'approval' ? [row(...(fits ? [button('允许本次', action('approve'), true,
        '仅允许上方展示的本次操作，不授予后续操作权限。')] : []), button('拒绝', action('deny')))]
        : [form('提交回答', action('answer'), [input('你的回答', '填写回答；多个问题请按问题 ID 填写 JSON')])]),
      caption('操作仅对当前请求有效。处理后会显示下一步。'),
    ]);
  }
  const actions: Element[] = [];
  if (task.status === 'review') actions.push(button('确认完成', intent('done'), true));
  if (['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.status)) {
    actions.push(button('刷新进度', intent('status'), true), button('停止执行', intent('cancel'), false, '停止后会保留已有改动，不会自动回滚。'));
  } else actions.push(button('继续修改', intent('followup'), actions.length === 0));
  actions.push(button('查看全文', intent('result')));
  return card(label, `${task.project} · ${task.id}`, color, [stateBox(task.prompt, task.status),
    text((task.result ?? store.latestProgress(task.id)) || (task.status === 'queued' ? '正在排队，轮到后自动开始。' : '任务已开始，结果会更新在这里。'), 4),
    ...(task.status === 'review' ? [caption('这是执行结果；请检查内容后确认完成。')] : []), row(...actions),
    row(button('我的任务', { op: 'list' }), homeButton()),
  ]);
}
