import type { Config } from './types.js';
// Explicit project names only; other people's context never chooses a working directory.
export function projectChoices(config: Config, text: string): string[] {
  const matches = Object.entries(config.projects).filter(([alias, p]) => [alias, p.label].some(name => {
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'i').test(text);
  })).map(([alias]) => alias);
  if (matches.length) return matches;
  if (config.defaultProject && Object.hasOwn(config.projects, config.defaultProject)) return [config.defaultProject];
  return Object.keys(config.projects);
}
