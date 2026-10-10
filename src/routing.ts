import { CONVERSATION } from './conversation.js';
import { createHash } from 'node:crypto';
import type { Config, Project } from './types.js';

// This is an answer to a persisted project question, never a tool/PR approval.
export function projectAnswer(text: string): 'yes' | 'no' | undefined {
  const answer = text.trim().replace(/[。.!！,，\s]+$/u, '').toLowerCase();
  if (/^(对|对的|是|是的|就是这个|没错|确认|好的|好|可以|yes|yep|ok|okay)([，,\s]*(继续|开始|执行|请继续))?$/.test(answer)) return 'yes';
  if (/^(不|不是|不对|不要|取消|算了|no|nope)$/.test(answer)) return 'no';
}
export function projectGrantKey(project: Project): string {
  return createHash('sha256').update(JSON.stringify(project)).digest('hex');
}
// Explicit project names only; other people's context never chooses a working directory.
export function namedProjects(config: Config, text: string): string[] {
  return Object.entries(config.projects).filter(([alias, p]) => [alias, p.label, ...(p.aliases ?? [])].some(name => {
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'i').test(text);
  })).map(([alias]) => alias);
}
export function requiresProject(text: string): boolean {
  return /代码|仓库|代码库|组件|接口|登录流程|代码版本|分支|提交|修复|调试|部署|编译|单元测试|读.*文件|修改.*(?:页面|按钮|图表)|(?:admin|repository|repo|codebase|bug|implement|debug|deploy)\b/i.test(text);
}
export function projectChoices(config: Config, text: string): string[] {
  const matches = namedProjects(config, text);
  if (matches.length) return matches;
  return requiresProject(text) ? Object.keys(config.projects) : [CONVERSATION];
}
export function ungrantedNames(config: Config, text: string): string[] {
  const granted = new Set(Object.values(config.projects).map(p => p.codexProjectId));
  return (config.codexProjects ?? []).filter(p => !granted.has(p.id)
    && namedProjects({ ...config, projects: { candidate: { path:'', sandbox:'read-only', label:p.name } } }, text).length).map(p => p.name);
}
