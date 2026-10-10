import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment } from '../types.js';

export class MediaError extends Error {}
export type MediaRunner = (command: string, args: string[], signal: AbortSignal, timeout?: number) => Promise<string>;
export const runMedia: MediaRunner = (command, args, signal, timeout = 30_000) => new Promise((yes, no) => {
  signal.throwIfAborted();
  execFile(command, args, { signal, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => {
    if (signal.aborted) { no(signal.reason); return; }
    if (error) { no(new MediaError((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `缺少本机工具 ${command}，请按媒体部署说明安装` : `${command} 处理失败或超时，未成功读取该部分`)); return; }
    yes(stdout);
  });
});
const formats = 'mov,matroska,webm,mp3,wav,ogg,flac,aac,amr,aiff';
const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', formats];
const ffmpeg = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', ...inputOptions];
export function whisperModel(stateDir: string): string {
  return process.env.STEWARD_WHISPER_MODEL || join(stateDir, 'models', 'ggml-base.bin');
}
export function conversionKind(a: Attachment): 'pdf' | 'audio' | 'video' | undefined {
  if (a.kind === 'audio' || a.kind === 'video') return a.kind;
  if (a.kind !== 'file') return;
  if (/\.pdf$/i.test(a.name ?? '')) return 'pdf';
  if (/\.(mp4|mov|mkv|webm|m4v)$/i.test(a.name ?? '')) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac|amr|aiff)$/i.test(a.name ?? '')) return 'audio';
}
async function transcribe(file: string, dir: string, model: string, seconds: number, signal: AbortSignal, run: MediaRunner) {
  try { await access(model); } catch { throw new MediaError('缺少本地 Whisper 模型，请运行 npm run setup:media'); }
  const wav = join(dir, 'speech.wav'), prefix = join(dir, 'speech');
  await run('ffmpeg', [...ffmpeg, '-i', file, '-map', '0:a:0', '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], signal);
  await run('whisper-cli', ['-m', model, '-f', wav, '-l', 'auto', '-t', '4', '-osrt', '-of', prefix], signal, 180_000);
  const text = (await readFile(prefix + '.srt', 'utf8')).trim();
  return text ? `语音自动转写（可能有识别错误，不能据此判断未转写的音乐、语气或环境声）：\n${text}` : '转写未检测到可识别语音；不据此断言音频完全静音。';
}
export async function convertMedia(kind: 'pdf' | 'audio' | 'video', file: string, dir: string, stateDir: string,
  visualBudget: number, signal: AbortSignal, run: MediaRunner = runMedia): Promise<Pick<Attachment, 'status' | 'detail' | 'text' | 'visuals'>> {
  const visuals: NonNullable<Attachment['visuals']> = [];
  if (kind === 'pdf') {
    const info = await run('pdfinfo', [file], signal);
    const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
    if (!Number.isSafeInteger(pages) || pages < 1) throw new MediaError('无法读取 PDF 页数，文件可能损坏或需要密码');
    const end = Math.min(6, pages), renderEnd = Math.min(end, visualBudget);
    const notes: string[] = []; let text = '';
    try { text = await run('pdftotext', ['-f', '1', '-l', String(end), '-layout', '-enc', 'UTF-8', file, '-'], signal); }
    catch (e) { signal.throwIfAborted(); notes.push(e instanceof MediaError ? e.message : 'PDF 文字提取失败'); }
    for (let page = 1; page <= renderEnd; page++) {
      const prefix = join(dir, `page-${page}`);
      try {
        await run('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1400', '-png', file, prefix], signal);
        await access(prefix + '.png'); visuals.push({ path: prefix + '.png', label: `PDF 第 ${page} 页` });
      } catch (e) { signal.throwIfAborted(); notes.push(e instanceof MediaError ? e.message : `第 ${page} 页渲染失败`); }
    }
    if (text.length > 20000) notes.push('提取文字超过 20000 字，已截断');
    const clipped = text.slice(0, 20000);
    const partial = pages > end || visuals.length < end || notes.length > 0;
    return { status: !visuals.length && !clipped.trim() ? 'unread' : partial ? 'partial' : 'processed', visuals,
      text: clipped ? `PDF 前 ${end} 页文字（分页符分隔）：\n${clipped}` : undefined,
      detail: `PDF 共 ${pages} 页；提取前 ${end} 页文字，提供 ${visuals.length} 页画面${pages > end ? `；第 ${end + 1}–${pages} 页未读取` : ''}${renderEnd < end ? '；部分页面未提供画面' : ''}。${notes.join('；')}` };
  }
  const raw = await run('ffprobe', ['-v', 'error', ...inputOptions, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], signal);
  let data: { format?: { duration?: string }; streams?: Array<{ codec_type: string }> };
  try { data = JSON.parse(raw); } catch { throw new MediaError('无法读取媒体时长'); }
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaError('无法确认媒体时长，未处理');
  const seconds = Math.min(duration, kind === 'video' ? 120 : 180);
  const hasAudio = data.streams?.some(s => s.codec_type === 'audio');
  const hasVideo = data.streams?.some(s => s.codec_type === 'video');
  if (kind === 'audio' && !hasAudio) throw new MediaError('文件中没有可读取的音轨');
  const notes: string[] = []; let text: string | undefined;
  if (kind === 'video' && hasVideo) {
    const count = Math.min(6, visualBudget, Math.max(1, Math.ceil(seconds)));
    for (let i = 0; i < count; i++) {
      const time = count === 1 ? 0 : i * Math.max(0, seconds - 0.1) / (count - 1);
      const path = join(dir, `frame-${i}.png`);
      try {
        // Output seeking after frame holding keeps low-frame-rate slides visible until the next frame.
        await run('ffmpeg', [...ffmpeg, '-i', file, '-ss', time.toFixed(3), '-map', '0:v:0', '-frames:v', '1', '-vf', 'fps=10:round=up,scale=1280:1280:force_original_aspect_ratio=decrease,format=rgb24', path], signal);
        await access(path); visuals.push({ path, label: `视频 ${time.toFixed(2)} 秒抽样画面` });
      } catch (e) { signal.throwIfAborted(); notes.push(e instanceof MediaError ? e.message : '视频抽帧失败'); }
    }
    if (!count) notes.push('本轮图片额度已用完，未读取视频画面');
  } else if (kind === 'video') notes.push('未找到视频画面轨道');
  if (hasAudio) {
    try { text = await transcribe(file, dir, whisperModel(stateDir), seconds, signal, run); }
    catch (e) { signal.throwIfAborted(); notes.push(e instanceof MediaError ? e.message : '音轨转写失败'); }
  }
  return { status: !visuals.length && !text ? 'unread' : kind === 'video' || seconds < duration || notes.length ? 'partial' : 'processed', visuals, text,
    detail: `总时长 ${duration.toFixed(1)} 秒；处理 0–${seconds.toFixed(1)} 秒${seconds < duration ? '，后续未读取' : ''}。`
      + (kind === 'video' ? `提供 ${visuals.length} 个带时间点的抽样画面，非逐帧观看，可能遗漏短暂变化；` : '')
      + (hasAudio ? text ? '已提供语音转写。' : '音轨未读取。' : '没有音轨。') + notes.join('；') };
}
