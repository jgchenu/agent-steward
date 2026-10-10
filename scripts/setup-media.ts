import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { whisperModel, runMedia } from '../src/channels/media-convert.js';

// Official whisper.cpp multilingual base model. Pin content by hash even if the upstream branch moves.
const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const digest = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const configFile = resolve(process.env.STEWARD_CONFIG ?? 'steward.config.json');
const raw = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const stateDir = resolve(dirname(configFile), raw.stateDir ?? '.steward');
const target = whisperModel(stateDir);
const signal = AbortSignal.timeout(300_000);
try {
  for (const [command, args] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']], ['pdfinfo', ['-v']], ['pdftotext', ['-v']], ['pdftoppm', ['-v']], ['whisper-cli', ['--help']]] as const) {
    await runMedia(command, [...args], signal); console.log(`OK: ${command}`);
  }
  if (existsSync(target)) {
    // A user-provided replacement model is an explicit operator choice, never overwritten.
    if (process.env.STEWARD_WHISPER_MODEL) { console.log('Configured Whisper model exists.'); process.exit(0); }
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== digest) throw Error('已有模型校验失败；请检查后移走该文件再重试。');
    console.log('Whisper base model verified.'); process.exit(0);
  }
  if (process.env.STEWARD_WHISPER_MODEL) throw Error('指定的 Whisper 模型不存在；请提供有效路径。');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.' + randomUUID() + '.download';
  try {
    console.log('Downloading multilingual Whisper base (142 MiB); no audio or project data is uploaded.');
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw Error('模型下载失败');
    const hash = createHash('sha256'); let size = 0;
    const file = await open(temp, 'wx', 0o600);
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength; if (size > 150 * 1024 * 1024) throw Error('模型大小不符');
        hash.update(chunk); await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    if (hash.digest('hex') !== digest) throw Error('模型校验失败');
    await rename(temp, target); console.log('Whisper base model installed and verified.');
  } finally { await rm(temp, { force: true }); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Media setup failed'); process.exitCode = 1; }
