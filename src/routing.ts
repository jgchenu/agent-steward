import { CONVERSATION } from './conversation.js';
import type { Config } from './types.js';
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
