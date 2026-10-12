import type { CommitAuthor } from './types.js';

export function mergeCommitAuthors(...groups: Array<readonly CommitAuthor[] | undefined>): CommitAuthor[] {
  const authors = new Map<string, CommitAuthor>();
  for (const author of groups.flatMap(group => group ?? [])) {
    const name = author.name.trim(), email = author.email.trim();
    if (!name || /[<>\r\n]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) {
      throw Error('执行器共同作者署名无效。');
    }
    const key = email.toLowerCase();
    if (!authors.has(key)) authors.set(key, { name, email });
  }
  return [...authors.values()];
}
