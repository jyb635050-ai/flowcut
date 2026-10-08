// 把 node_modules 里的 ffmpeg.wasm 复制进 site/vendor/ffmpeg（网站自托管，不从外域拉）。用法：npm run vendor
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site', 'vendor', 'ffmpeg');
fs.mkdirSync(out, { recursive: true });
const ff = path.join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm');
for (const f of fs.readdirSync(ff)) if (f.endsWith('.js')) fs.copyFileSync(path.join(ff, f), path.join(out, f));
const core = path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) fs.copyFileSync(path.join(core, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'NOTICE.txt'), [
  'ffmpeg-core.js / ffmpeg-core.wasm: @ffmpeg/core 0.12.10 — FFmpeg compiled to WebAssembly, GPL-2.0-or-later.',
  'Source: https://github.com/ffmpegwasm/ffmpeg.wasm  ·  https://ffmpeg.org',
  'Other .js files here: @ffmpeg/ffmpeg 0.12.15, MIT.',
  '',
].join('\n'));
console.log('vendored ->', out, fs.readdirSync(out).join(' '));
