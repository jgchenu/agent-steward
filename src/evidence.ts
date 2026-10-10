import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvidenceImage } from './types.js';
import type { Store } from './store.js';

export const EVIDENCE_DIRECTORY = '.steward-delivery';
export const isEvidencePath = (path: string) => path === EVIDENCE_DIRECTORY || path.startsWith(EVIDENCE_DIRECTORY + '/');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function boundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) throw Error('Invalid evidence file');
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd,bytes,length,bytes.length-length,null); if (!n) break; length += n; }
    if (length > limit) throw Error('Oversized evidence file');
    return bytes.subarray(0,length);
  } finally { closeSync(fd); }
}
function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'webp';
  throw Error('Unsupported evidence image');
}
export function prepareEvidenceDirectory(workspace: string): string {
  const root = join(workspace, EVIDENCE_DIRECTORY);
  mkdirSync(root, {recursive:true,mode:0o700});
  if (realpathSync(root) !== resolve(root)) throw Error('截图产物目录不是独立本地目录。');
  return mkdtempSync(join(root,'run-'));
}
export function collectEvidence(store: Store, stateDir: string, taskId: string, directory: string): { ids: string[]; warning?: string } {
  try {
    if (realpathSync(directory) !== resolve(directory)) throw Error('Invalid evidence directory');
    let manifest: unknown;
    try { manifest = JSON.parse(boundedFile(join(directory,'images.json'),8192).toString('utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {ids:[]}; throw error; }
    if (!Array.isArray(manifest) || manifest.length > 3) throw Error('Invalid manifest');
    const images = manifest.map(item => {
      if (!item || typeof item.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.(png|jpe?g|webp)$/i.test(item.file)
        || typeof item.caption !== 'string' || !item.caption.trim() || item.caption.length > 300
        || !['local-preview','deployed'].includes(item.scope)) throw Error('Invalid evidence metadata');
      const bytes = boundedFile(join(directory,item.file),5*1024*1024), ext = imageExtension(bytes);
      return {bytes,ext,caption:item.caption.trim(),scope:item.scope as EvidenceImage['scope']};
    });
    const root = join(realpathSync(stateDir),'evidence'); mkdirSync(root,{recursive:true,mode:0o700});
    if (realpathSync(root) !== root) throw Error('Invalid evidence store');
    const records = images.map(({bytes,ext,caption,scope}) => {
      const id = randomUUID(), path = join(root,`${id}.${ext}`);
      writeFileSync(path,bytes,{mode:0o600,flag:'wx'});
      return {id,taskId,path,sha256:digest(bytes),caption,scope,capturedAt:new Date().toISOString()};
    });
    store.transaction(() => { for (const record of records) store.saveEvidence(record); });
    return {ids:records.map(r=>r.id)};
  } catch { return {ids:[],warning:'截图产物未通过检查，未发送；需在本次产物目录提供至多 3 张 PNG/JPEG/WebP、每张不超过 5 MiB，并填写 images.json。'}; }
}
export function evidenceBytes(image: EvidenceImage, stateDir: string): Buffer {
  const root = join(realpathSync(stateDir),'evidence');
  if (realpathSync(root) !== root || !/^[a-f0-9-]{36}$/.test(image.id)
    || !['png','jpg','webp'].some(ext => image.path === join(root,`${image.id}.${ext}`))) throw Error('截图产物路径无效。');
  const bytes = boundedFile(image.path,5*1024*1024);
  if (!image.path.endsWith('.' + imageExtension(bytes))) throw Error('截图类型已变化。');
  if (digest(bytes) !== image.sha256) throw Error('截图产物已变化，未上传。');
  return bytes;
}
