import type { Config } from './types.js';
// Explicit project names only; other people's context never chooses a working directory.
export function namedProjects(config: Config, text: string): string[] {
  return Object.entries(config.projects).filter(([alias, p]) => [alias, p.label, ...(p.aliases ?? [])].some(name => {
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'i').test(text);
  })).map(([alias]) => alias);
}
export function projectChoices(config: Config, text: string): string[] {
  const matches = namedProjects(config, text);
  if (matches.length) return matches;
  if (config.defaultProject && Object.hasOwn(config.projects, config.defaultProject)) return [config.defaultProject];
  return Object.keys(config.projects);
}
