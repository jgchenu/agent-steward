import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { addAbortSignal, type Readable } from 'node:stream';
import type { Attachment, ContextSnapshot } from '../types.js';

// Only keys embedded in verified messages. Never follow URLs or parse executable card controls.
export function messageAttachments(messageId: string, type: string, content: string): Attachment[] {
  if (typeof content !== 'string' || content.length > 200_000) return [];
  let data: any; try { data = JSON.parse(content); } catch { return []; }
  const found: Attachment[] = []; let nodes = 0;
  const add = (kind: Attachment['kind'], value: any) => {
    if (found.length >= 20) return;
    const key = kind === 'image' ? value.image_key ?? value.img_key : value.file_key;
    const safeKey = typeof key === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(key) ? key : undefined;
    const name = typeof value.file_name === 'string' ? value.file_name.slice(0, 200) : undefined;
    if (safeKey && found.some(a => a.key === safeKey && a.kind === kind)) return;
    found.push({ messageId, key: safeKey, kind, name, status: 'unread', detail: '附件尚未读取' });
  };
  if (['image', 'file', 'audio', 'video', 'media'].includes(type)) add(type === 'media' ? 'video' : type as Attachment['kind'], data ?? {});
  if (type === 'post') {
    const visit = (v: any, depth = 0): void => {
      if (++nodes > 2000 || depth > 20 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
      if (v.tag === 'img') { add('image', v); return; }
      if (['media', 'video', 'audio', 'file'].includes(v.tag)) { add(v.tag === 'media' ? 'video' : v.tag, v); return; }
      if (['button', 'input', 'select_static', 'multi_select_static'].includes(v.tag)) return;
      for (const [key, item] of Object.entries(v)) if (!['behaviors', 'value', 'action', 'actions', 'callback'].includes(key)) visit(item, depth + 1);
    };
    visit(data);
  }
  return found;
}
export interface ResourceApi {
  get(payload: { path: { message_id: string; file_key: string }; params: { type: string } }, options?: any): Promise<{ getReadableStream(): Readable; headers: any }>;
}
async function download(api: ResourceApi, item: Attachment, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  bounded.throwIfAborted();
  let listener = () => {};
  const request = api.get({ path: { message_id: item.messageId, file_key: item.key! }, params: { type: item.kind === 'image' ? 'image' : 'file' } }, { timeout: 10_000 });
  // A cancelled request that resolves late must not leave a resource stream open.
  void request.then(r => { if (bounded.aborted) r.getReadableStream().destroy(); }, () => {});
  let response: Awaited<typeof request>;
  try {
    response = await Promise.race([request, new Promise<never>((_, reject) => {
      listener = () => reject(Error('附件下载已取消或超时'));
      bounded.addEventListener('abort', listener, { once: true }); if (bounded.aborted) listener();
    })]);
  } finally { bounded.removeEventListener('abort', listener); }
  const stream = response.getReadableStream();
  if (Number(response.headers?.['content-length']) > maxBytes) { stream.destroy(); throw Error('附件超过大小限制'); }
  addAbortSignal(bounded, stream);
  let size = 0; const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      bounded.throwIfAborted(); const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) throw Error('附件超过大小限制');
      chunks.push(bytes);
    }
    bounded.throwIfAborted(); return Buffer.concat(chunks, size);
  } finally { stream.destroy(); }
}
function imageExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
}
export async function loadMedia(snapshot: ContextSnapshot, api: ResourceApi, stateDir: string, signal: AbortSignal): Promise<ContextSnapshot> {
  const attachments = (snapshot.attachments ?? []).map(a => ({ ...a }));
  let mediaDir: string | undefined, images = 0, texts = 0, total = 0;
  try {
    for (const [index, item] of attachments.entries()) {
      signal.throwIfAborted();
      const isText = item.kind === 'file' && /\.(txt|md|csv|json|log)$/i.test(item.name ?? '');
      if (item.kind !== 'image' && !isText) {
        item.detail = item.kind === 'video' ? '视频尚未解析，未观看画面或收听声音'
          : item.kind === 'audio' ? '音频尚未转写，未收听内容' : '此文件格式尚未解析';
        continue;
      }
      if (!item.key) { item.detail = '缺少有效消息资源标识，未读取'; continue; }
      if ((item.kind === 'image' && images >= 4) || (isText && texts >= 2) || total >= 20 * 1024 * 1024) {
        item.detail = '超过本轮附件数量或总大小上限，未读取'; continue;
      }
      try {
        const bytes = await download(api, item, signal, Math.min(isText ? 256 * 1024 : 8 * 1024 * 1024, 20 * 1024 * 1024 - total));
        total += bytes.length;
        if (isText) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (text.includes('\0')) throw Error('不是纯文本');
          item.text = text.slice(0, 8000); item.status = 'text'; texts++;
          item.detail = text.length > 8000 ? '已读取前 8000 字，后续已截断' : '已读取 UTF-8 文本';
        } else {
          const ext = imageExtension(bytes);
          if (!ext) { item.detail = '图片格式不支持，仅支持 PNG、JPEG、WebP'; continue; }
          if (!mediaDir) {
            const root = resolve(stateDir, 'media'); await mkdir(root, { recursive: true, mode: 0o700 });
            mediaDir = await mkdtemp(join(root, 'turn-'));
          }
          item.path = join(mediaDir, `${index}.${ext}`);
          await writeFile(item.path, bytes, { mode: 0o600, flag: 'wx' });
          item.status = 'attached'; item.detail = `已作为第 ${++images} 张图片传入模型，可直接查看画面`;
        }
      } catch {
        signal.throwIfAborted();
        item.status = 'unread'; delete item.path;
        item.detail = '附件读取失败（权限、网络、大小上限或编码问题），内容不可见';
      }
    }
    signal.throwIfAborted();
    return { ...snapshot, attachments, mediaDir, summary: snapshot.summary + `；已附 ${images} 张图片、读取 ${texts} 个文本文件，另有 ${attachments.filter(a => a.status === 'unread').length} 个附件未读取。` };
  } catch (error) {
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
    throw error;
  }
}
export async function releaseMedia(snapshot: ContextSnapshot, stateDir: string): Promise<void> {
  if (snapshot.mediaDir && dirname(snapshot.mediaDir) === resolve(stateDir, 'media')) await rm(snapshot.mediaDir, { recursive: true, force: true });
}
