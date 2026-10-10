import { posix } from 'node:path';

function inlineCode(value: string): string {
  const clean = value.replace(/[\r\n]/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...Array.from(clean.matchAll(/`+/g), m => m[0].length)) + 1);
  const padding = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${clean}${padding}${fence}`;
}

function fileReference(label: string, destination: string, roots: string[]): string | undefined {
  let path = destination.trim().replace(/\s+["'][^"']*["']$/, '').replace(/^<([\s\S]*)>$/, '$1');
  // Leave web/PR links, anchors and non-file application links alone.
  const localScheme = /^(?:file|vscode|vscode-insiders|cursor):/i.test(path);
  if (!localScheme && (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/^[^/:]+:\d+(?::\d+)?(?:-\d+)?$/.test(path)
    || path.startsWith('//') || path.startsWith('#'))) return;
  path = path.replace(/^file:\/\/(?:localhost)?/i, '').replace(/^(?:vscode|vscode-insiders|cursor):\/\/file\//i, '/');
  try { path = decodeURIComponent(path); } catch { /* retain malformed percent escapes as text */ }
  path = path.replace(/\\([() ])/g, '$1').replace(/\\/g, '/');
  const location = path.match(/(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/)?.[0] ?? '';
  if (location) path = path.slice(0, -location.length);
  path = posix.normalize(path);
  const root = roots.map(r => posix.normalize(r.replace(/\\/g, '/')).replace(/\/$/, ''))
    .filter(Boolean).sort((a, b) => b.length - a.length).find(r => path.startsWith(r + '/'));
  if (root) path = path.slice(root.length + 1);
  else if (/^(?:\/|[a-z]:\/|~\/)/i.test(path)) path = posix.basename(path);
  const suffix = location || label.match(/(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L?\d+)?)$/)?.[0] || '';
  return inlineCode((path || '本地文件') + suffix);
}

// Handle inline file links from coding agents, including parenthesized directories,
// angle-wrapped paths and optional titles. Code examples remain literal.
export function readableFileReferences(markdown: string, roots: string[] = []): string {
  let result = '', offset = 0;
  while (offset < markdown.length) {
    if (markdown[offset] === '\\') { result += markdown.slice(offset, offset + 2); offset += 2; continue; }
    if (markdown[offset] === '`') {
      const marker = markdown.slice(offset).match(/^`+/)![0];
      const end = markdown.indexOf(marker, offset + marker.length);
      if (end !== -1) { result += markdown.slice(offset, end + marker.length); offset = end + marker.length; continue; }
    }
    const match = markdown.slice(offset).match(/^(!?)\[([^\]\n]*)\]\(/);
    if (!match) { result += markdown[offset++]; continue; }
    const start = offset + match[0].length;
    let end = start, depth = 1, angle = false;
    for (; end < markdown.length; end++) {
      const char = markdown[end];
      if (char === '\\') { end++; continue; }
      if (char === '<') angle = true;
      if (char === '>') angle = false;
      if (!angle && char === '(') depth++;
      if (!angle && char === ')' && --depth === 0) break;
      if (char === '\n') break;
    }
    if (depth !== 0) { result += markdown[offset++]; continue; }
    const reference = fileReference(match[2], markdown.slice(start, end), roots);
    result += reference ?? markdown.slice(offset, end + 1);
    offset = end + 1;
  }
  return result;
}
