// 流音 Flowcut 验收脚本 —— 判卷标准，冻结，任何人不许改（改了就算不合格）。
// 用法（在 D:\blender\Flowcut 下）：
//   node tools/accept.mjs            本地：自带静态服务器，把 site/ 原样挂在 /flowcut/ 下
//                                    （不发 COOP/COEP 响应头，和 GitHub Pages 一样，页面里没有 SharedArrayBuffer）
//   node tools/accept.mjs --url https://jyb635050-ai.github.io/flowcut/
//                                    线上：全套检查＋线上 index.html 必须与本地 site/index.html 逐字节相同
//   node tools/accept.mjs --prove    反向验证：①判卷自造的「完美导出」必须判过、各种「错的导出」必须判挂；
//                                    ②往页面注入破坏（静音／外域请求／控制台报错／主线程卡顿／转码引擎被拦），
//                                    不注入时必须过、注入后必须挂。全部抓到 → 退出码 0；有没抓到的 → 退出码 2
//   --only 组名,组名   只跑某几组（调试用）：formats scenario perf ui。交付必须跑全量
// 全部 PASS 退出码 0；任一 FAIL 退出码 1。截图写到 shots/；测试音频由判卷用系统 ffmpeg 现做，放 tools/.fixtures/（可删，会重做）。
// 判卷用声音本身判：测试音是左右声道不同的扫频音（频率随时间走），网页导出的文件被解码回来，与判卷自己算的参考答案
// 逐 10ms 比电平、逐 50ms 比波形。剪错位置／顺序／声道、音量、淡入淡出、交叉淡化、接缝处多一截静音，都对不上。
//
// ───── 页面契约 ─────
// 单页 site/index.html。window.__fc：ready（就绪置 true）；state() 返回 { playhead, playing, duration, clips:[{name,in,out}] }
//   playhead/duration 是时间线秒数，in/out 是该段在原文件里的秒数；seek(秒)：把播放头放到时间线该位置（判卷专用）
// 时间线：所有片段在一条线上首尾相接。片段 k 的「交叉淡化 x 秒」＝它提前 x 秒压到上一段尾巴上，重叠处上一段渐出、这段渐入
//   （第一段的 x 不起作用）。淡入淡出、交叉淡化曲线用线性或等功率（sin/cos）都行。音量单位 dB。删掉片段后面的自动前移。
// 控件（data-testid，同一页面只许出现一个，片段除外）：
//   import       <input type=file multiple>（可隐藏）；多选时按 FileList 顺序依次接到时间线末尾
//   import-btn   看得见的「导入」按钮　　timeline  时间线区域：把文件拖进来松手＝导入
//   clip         每个片段一个，DOM 顺序＝播放顺序；data-name＝文件名；data-ready="true"＝已解码且波形已画好；
//                点中间＝选中（aria-selected="true"）；里面有 trim-start / trim-end 两个把手（选中时可见），按住左右拖＝改入点/出点；
//                按住片段本体拖到另一片段左半边松手＝插到它前面，右半边＝插到它后面
//   clip-in clip-out clip-gain fade-in fade-out xfade
//                选中片段的参数输入框，value 是纯十进制数（秒或 dB），填好回车生效；入点/出点超出原文件要自动夹回（出点填 999 → 原文件时长）
//   play（aria-pressed＝在播）  split（在播放头处切开所在片段，切口无缝）  delete（删选中段）  undo  redo
//   键盘（焦点不在输入框时）：空格＝播放/暂停，S＝切开，Delete＝删除，Ctrl+Z 撤销，Ctrl+Shift+Z 重做；Esc 关闭面板
//   时间线上按住 Ctrl 滚轮：向上＝放大（片段变宽）
//   export       打开导出面板；format <select> 选项值 wav mp3 flac m4a ogg opus aiff；bitrate <select> 选项值 128 192 256 320
//                （kbps，有损格式用）；normalize 复选框：勾上＝整体响度标准化到 -14 LUFS（±1）且不削波；export-go 开始导出
//   导出＝触发一次浏览器下载（不许弹系统另存为），扩展名同 format（aiff 也可 .aif）；双声道，采样率 44100 或 48000；
//                wav/flac/aiff 无损；mp3 按所选码率恒定码率；ogg＝Vorbis；opus＝Ogg 封装的 Opus；m4a＝AAC
//   toast        出错提示（如导入坏文件），不许用 alert()
//   lang         中英切换：默认 <html lang="zh-CN">，切换后 "en"，export 按钮文字随之变化，刷新后保持
//   theme        深浅色切换：<html data-theme="light|dark">，默认跟随系统，刷新后保持；
//                html 或 body 的 background-color 深色下要明显比浅色暗（相对亮度差 ≥ 0.3）
//   about        打开关于面板：列出用到的第三方库和许可证；site/ 里若带了 FFmpeg（文件名含 ffmpeg），面板里必须有
//                「FFmpeg」「GPL」字样和指向 github.com/ffmpegwasm 的源码链接
// 播放：整页只许 new 一个 AudioContext，声音经 Web Audio 连到 ctx.destination；听到的＝导出的（同样的剪辑、音量、淡入淡出）
// 刷新页面后工程原样恢复（片段、顺序、参数），只存本机，不上传
// 导入：至少认 tools/.fixtures 里的 15 种（wav 16/24/32 位浮点、mp3、flac、m4a(AAC)、aac、ogg、opus、webm、wma、aiff、
//   m4a(ALAC)、amr、ac3）；坏文件给 toast、不加片段、不报错
// 性能：导入 10 分钟 MP3 到波形画好 ≤ 6 秒；连续拖把手 2 秒：帧率 ≥ 48、最长一帧间隔 ≤ 100ms；Ctrl+滚轮缩放最长一帧间隔 ≤ 100ms；
//   3 分钟导出 MP3（含首次加载转码引擎）本地 ≤ 20 秒、线上 ≤ 60 秒
// 外观：至少 3 个看得见的元素用磨砂玻璃（backdrop-filter 含 blur）；1280×720、1440×900 下 import-btn play split delete undo redo
//   export 不滚动就全在屏内；390×844 下 import-btn play export 在屏内且不小于 40×40；任何宽度不许横向滚动；
//   看得见的按钮都要有名字（文字或 aria-label）
// 首屏（就绪后再等 2 秒）总下载 ≤ 1.5 MB（转码引擎等真用到再下）；全程不许请求外域、不许非 GET 请求；控制台不许有报错
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire('C:/Users/73405/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const FIX = path.join(ROOT, 'tools', '.fixtures');
const OUT = path.join(FIX, 'out');
const SHOTS = path.join(ROOT, 'shots');
const SR = 44100;
const args = process.argv.slice(2);
const PROVE = args.includes('--prove');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const want = g => !only || only.includes(g);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
setTimeout(() => { console.log('FAIL 总超时：判卷跑了 30 分钟还没完'); process.exit(PROVE ? 2 : 1); }, 30 * 60e3);

// ───────── 记录 ─────────
let results = [];
function rec(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

// ───────── ffmpeg ─────────
function run(cmd, a) { const r = spawnSync(cmd, a, { maxBuffer: 1 << 30 }); if (r.error) throw r.error; return r; }
function ff(a) { const r = run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...a]); if (r.status !== 0) throw new Error('ffmpeg 失败：' + a.join(' ') + '\n' + r.stderr); }
function probe(f) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration,bit_rate:stream=codec_name,channels,sample_rate,bit_rate', '-of', 'json', f]);
  try { return JSON.parse(r.stdout.toString()); } catch { return null; }
}
function decode(f) {
  const r = run('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', String(SR), '-']);
  if (r.status !== 0 || r.stdout.length < 8) return null;
  const ab = new ArrayBuffer(r.stdout.length & ~7); new Uint8Array(ab).set(r.stdout.subarray(0, ab.byteLength));
  const all = new Float32Array(ab), n = all.length >> 1, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  return { L, R };
}
function loudness(f) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-filter_complex', 'ebur128=peak=sample', '-f', 'null', '-']);
  const s = r.stderr.toString();
  const I = [...s.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].pop(), P = [...s.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)].pop();
  return { I: I ? parseFloat(I[1]) : NaN, peak: P ? parseFloat(P[1]) : NaN };
}
function writeWav(file, pcm, bits = 16) {
  const n = pcm.L.length, bps = bits / 8, buf = Buffer.alloc(44 + n * 2 * bps);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2 * bps, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * bps, 28); buf.writeUInt16LE(2 * bps, 32); buf.writeUInt16LE(bits, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2 * bps, 40);
  for (let i = 0; i < n; i++) for (const [c, x] of [[0, pcm.L[i]], [1, pcm.R[i]]]) {
    const v = Math.max(-1, Math.min(1, x)); const o = 44 + (2 * i + c) * bps;
    if (bits === 16) buf.writeInt16LE(Math.round(v * 32767), o); else buf.writeIntLE(Math.round(v * 8388607), o, 3);
  }
  fs.writeFileSync(file, buf);
}

// ───────── 测试音频 ─────────
const chirp = (f0, f1, T) => `0.25*sin(2*PI*(${f0}*t+(${(f1 - f0) / (2 * T)})*t*t))`;
const SRC = {
  A: { T: 12, L: [300, 1500], R: [2400, 1200], file: 'A.mp3', enc: ['-c:a', 'libmp3lame', '-b:a', '256k'] },
  B: { T: 8, L: [1800, 700], R: [500, 1300], file: 'B.flac', enc: ['-c:a', 'flac'] },
  C: { T: 6, L: [900, 2100], R: [2600, 1600], file: 'C.m4a', enc: ['-c:a', 'aac', '-b:a', '256k'] },
};
const FMTS = [
  ['wav16', 'wav', ['-c:a', 'pcm_s16le'], 'lossless'], ['wav24', 'wav', ['-c:a', 'pcm_s24le'], 'lossless'],
  ['wavf32', 'wav', ['-c:a', 'pcm_f32le'], 'lossless'], ['mp3', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '192k'], 'lossy'],
  ['flac', 'flac', ['-c:a', 'flac'], 'lossless'], ['aac', 'm4a', ['-c:a', 'aac', '-b:a', '192k'], 'lossy'],
  ['adts', 'aac', ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts'], 'lossy'], ['vorbis', 'ogg', ['-c:a', 'libvorbis', '-q:a', '6'], 'lossy'],
  ['opus', 'opus', ['-c:a', 'libopus', '-b:a', '160k'], 'lossy'], ['webm', 'webm', ['-c:a', 'libopus', '-b:a', '160k'], 'lossy'],
  ['wma', 'wma', ['-c:a', 'wmav2', '-b:a', '192k'], 'lossy'], ['aiff', 'aiff', ['-c:a', 'pcm_s16be'], 'lossless'],
  ['alac', 'm4a', ['-c:a', 'alac'], 'lossless'], ['amr', 'amr', ['-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k'], 'amr'],
  ['ac3', 'ac3', ['-c:a', 'ac3', '-b:a', '192k'], 'lossy'],
].map(([tag, ext, enc, cls], i) => ({ tag, cls, enc, file: `f${String(i + 1).padStart(2, '0')}-${tag}.${ext}`, L: [300 + 120 * i, 1000 + 120 * i], R: [2400 - 100 * i, 1700 - 100 * i] }));
const lavfi = (L, R, T) => ['-f', 'lavfi', '-i', `aevalsrc=exprs=${L}|${R}:s=${SR}:d=${T}`];
function makeFixtures() {
  const mk = (file, fn) => { const f = path.join(FIX, file); if (!fs.existsSync(f)) fn(f); return f; };
  for (const s of Object.values(SRC)) mk(s.file, f => ff([...lavfi(chirp(...s.L, s.T), chirp(...s.R, s.T), s.T), ...s.enc, f]));
  for (const s of FMTS) mk(s.file, f => ff([...lavfi(chirp(...s.L, 2), chirp(...s.R, 2), 2), ...s.enc, f]));
  mk('drop.wav', f => ff([...lavfi(chirp(400, 900, 2), chirp(1900, 1400, 2), 2), '-c:a', 'pcm_s16le', f]));
  mk('long.mp3', f => ff([...lavfi('0.25*sin(2*PI*(300*t+50*(t-20*floor(t/20))*(t-20*floor(t/20))))', '0.2*sin(2*PI*(2400*t-40*(t-20*floor(t/20))*(t-20*floor(t/20))))', 600), '-c:a', 'libmp3lame', '-b:a', '192k', f]));
  mk('bad.mp3', f => { const b = Buffer.alloc(8192); let x = 12345; for (let i = 0; i < b.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } fs.writeFileSync(f, b); });
}

// ───────── 参考答案 ─────────
// clips: [{ pcm, in, out, gain(dB), fin, fout, xf }]
function render(clips, curves) {
  const lens = clips.map(c => Math.round((c.out - c.in) * SR));
  const xfs = clips.map((c, k) => (k === 0 ? 0 : Math.min(Math.round((c.xf || 0) * SR), lens[k], lens[k - 1])));
  const starts = []; let t = 0;
  clips.forEach((c, k) => { t -= xfs[k]; starts.push(t); t += lens[k]; });
  const L = new Float32Array(t), R = new Float32Array(t), bounds = [];
  const cf = (x, kind) => (kind === 'pow' ? Math.sin((x * Math.PI) / 2) : x);
  clips.forEach((c, k) => {
    const n = lens[k], s0 = Math.round(c.in * SR), g = Math.pow(10, (c.gain || 0) / 20);
    const fi = Math.round((c.fin || 0) * SR), fo = Math.round((c.fout || 0) * SR), xi = xfs[k], xo = k + 1 < clips.length ? xfs[k + 1] : 0;
    for (let j = 0; j < n; j++) {
      let a = g;
      if (fi && j < fi) a *= cf(j / fi, curves.fade);
      if (fo && j >= n - fo) a *= cf((n - j) / fo, curves.fade);
      if (xi && j < xi) a *= cf(j / xi, curves.xf);
      if (xo && j >= n - xo) a *= cf((n - j) / xo, curves.xf);
      L[starts[k] + j] += (c.pcm.L[s0 + j] || 0) * a;
      R[starts[k] + j] += (c.pcm.R[s0 + j] || 0) * a;
    }
    bounds.push(starts[k] / SR, (starts[k] + n) / SR);
  });
  return { L, R, bounds };
}
const CURVES = [{ fade: 'lin', xf: 'lin' }, { fade: 'pow', xf: 'pow' }, { fade: 'lin', xf: 'pow' }, { fade: 'pow', xf: 'lin' }];

// ───────── 比对 ─────────
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, ang = ((inv ? 2 : -2) * Math.PI) / len;
    for (let j = 0; j < h; j++) {
      const wr = Math.cos(ang * j), wi = Math.sin(ang * j);
      for (let i = j; i < n; i += len) {
        const k = i + h, br = re[k] * wr - im[k] * wi, bi = re[k] * wi + im[k] * wr;
        re[k] = re[i] - br; im[k] = im[i] - bi; re[i] += br; im[i] += bi;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// 在 got 里找 exp 的起点 s（exp[i] 对 got[s+i]），s ∈ [from, to]
function xcorrPeak(exp, got, from, to, expA = 0, expN = exp.L.length) {
  const span = to - from, glen = span + expN; let N = 1; while (N < glen) N <<= 1;
  const acc = new Float64Array(N);
  for (const ch of ['L', 'R']) {
    const gr = new Float64Array(N), gi = new Float64Array(N), er = new Float64Array(N), ei = new Float64Array(N);
    for (let k = 0; k < glen; k++) { const idx = from + expA + k; gr[k] = idx >= 0 && idx < got[ch].length ? got[ch][idx] : 0; }
    for (let k = 0; k < expN; k++) er[k] = exp[ch][expA + k] || 0;
    fft(gr, gi, false); fft(er, ei, false);
    for (let k = 0; k < N; k++) { const r = gr[k] * er[k] + gi[k] * ei[k], im = gi[k] * er[k] - gr[k] * ei[k]; gr[k] = r; gi[k] = im; }
    fft(gr, gi, true);
    for (let k = 0; k <= span; k++) acc[k] += gr[k];
  }
  let best = 0; for (let k = 1; k <= span; k++) if (acc[k] > acc[best]) best = k;
  return from + best;
}
const prefix = x => { const p = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i] * x[i]; return p; };
function rmsP(p, a, n) { const lo = Math.max(0, Math.min(p.length - 1, a)), hi = Math.max(0, Math.min(p.length - 1, a + n)); return 10 * Math.log10((p[hi] - p[lo]) / n + 1e-20); }
function corrAt(e, g, ea, ga, n) { let eg = 0, ee = 0, gg = 0; for (let i = 0; i < n; i++) { const x = e[ea + i] || 0, y = g[ga + i] || 0; eg += x * y; ee += x * x; gg += y * y; } return eg / Math.sqrt(ee * gg + 1e-20); }
function bestCorr(e, g, ea, ga, n, s = 3) { let b = -1; for (let d = -s; d <= s; d++) b = Math.max(b, corrAt(e, g, ea, ga + d, n)); return b; }
const fmtT = s => s.toFixed(2) + 's';

// 返回 { ok, gross, marg, total, msg }
function compareOnce(got, exp, o, off) {
  const lossy = !!o.lossy;
  let e = exp;
  if (o.freeGain) {
    let eg = 0, ee = 0; for (const ch of ['L', 'R']) for (let i = 0; i < e[ch].length; i++) { const x = e[ch][i], y = got[ch][i + off] || 0; eg += x * y; ee += x * x; }
    const g = eg / (ee || 1); e = { L: e.L.map(v => v * g), R: e.R.map(v => v * g), bounds: e.bounds };
  }
  const notes = [];
  const durD = (got.L.length - off - e.L.length) / SR;
  const tolDur = lossy ? 0.15 : 0.03, tolOff = lossy ? 0.08 : 0.02;
  if (Math.abs(off / SR) > tolOff) notes.push(`整体错位 ${(off / SR * 1000).toFixed(0)}ms`);
  if (Math.abs(durD) > tolDur) notes.push(`时长差 ${durD.toFixed(3)}s（导出 ${((got.L.length) / SR).toFixed(3)}s，应为 ${(e.L.length / SR).toFixed(3)}s）`);
  const skip = lossy ? 0.03 : 0, near = t => skip && e.bounds.some(b => Math.abs(b - t) < skip + 0.01);
  const gross = [], tolDb = lossy ? 1.5 : 1.0, grossDb = lossy ? 9 : 6, tolC = lossy ? 0.85 : 0.97;
  let marg = 0, total = 0;
  for (const ch of ['L', 'R']) {
    const pe = prefix(e[ch]), pg = prefix(got[ch]), W = 441;
    for (let i = 0; i + W <= e[ch].length; i += W) {
      if (near((i + W / 2) / SR)) continue;
      const a = rmsP(pe, i, W), b = rmsP(pg, i + off, W); total++;
      if (a > -40) { const d = b - a; if (Math.abs(d) > grossDb) gross.push(`${ch} ${fmtT(i / SR)} 电平差 ${d.toFixed(1)}dB`); else if (Math.abs(d) > tolDb) marg++; }
      else if (a < -60 && b > -40) gross.push(`${ch} ${fmtT(i / SR)} 应静音却有 ${b.toFixed(1)}dB`);
    }
    const CW = 2205;
    for (let i = 0; i + CW <= e[ch].length; i += CW) {
      if (near(i / SR) || near((i + CW) / SR) || e.bounds.some(b => b > i / SR && b < (i + CW) / SR && lossy)) continue;
      if (rmsP(pe, i, CW) < -35) continue;
      total++; const c = bestCorr(e[ch], got[ch], i, i + off, CW);
      if (c < 0.5) gross.push(`${ch} ${fmtT(i / SR)} 波形对不上(相关 ${c.toFixed(2)})`); else if (c < tolC) marg++;
    }
  }
  const margRate = marg / Math.max(1, total);
  if (gross.length) notes.push(`严重偏差 ${gross.length} 处：${gross.slice(0, 3).join('；')}`);
  if (margRate > 0.03) notes.push(`轻微偏差 ${(margRate * 100).toFixed(1)}% > 3%`);
  return { ok: notes.length === 0, score: gross.length * 1000 + marg, msg: notes.join('；'), stat: `错位 ${(off / SR * 1000).toFixed(0)}ms，轻微偏差 ${(margRate * 100).toFixed(1)}%` };
}
// 四种曲线组合里挑最像的那个判
function compare(got, specClips, o = {}) {
  let best = null, off = null;
  for (const cv of CURVES) {
    const exp = render(specClips, cv);
    if (off === null) off = xcorrPeak(exp, got, -Math.round(0.15 * SR), Math.round(0.15 * SR));
    const r = compareOnce(got, exp, o, off);
    if (!best || r.score < best.score || (r.ok && !best.ok)) best = { ...r, cv };
    if (r.ok) return { ...r, cv };
  }
  return best;
}
const CODEC = { wav: /^pcm_(s16le|s24le|s32le|f32le)$/, mp3: /^mp3$/, flac: /^flac$/, m4a: /^aac$/, ogg: /^vorbis$/, opus: /^opus$/, aiff: /^pcm_(s16be|s24be|s32be|f32be)$/ };
const CONT = { wav: /wav/, mp3: /mp3/, flac: /flac/, m4a: /mov|mp4|m4a/, ogg: /ogg/, opus: /ogg/, aiff: /aiff/ };
function checkFile(file, name, fmt, br) {
  const pr = probe(file), st = pr?.streams?.[0], fn = pr?.format?.format_name || '', notes = [];
  const extOk = fmt === 'aiff' ? /\.(aiff?|aifc)$/i.test(name) : new RegExp(`\\.${fmt}$`, 'i').test(name);
  if (!extOk) notes.push(`扩展名不对：${name}`);
  if (!st) return { ok: false, msg: '文件解析不了' };
  if (!CODEC[fmt].test(st.codec_name || '')) notes.push(`编码是 ${st.codec_name}`);
  if (!CONT[fmt].test(fn)) notes.push(`封装是 ${fn}`);
  if (st.channels !== 2) notes.push(`声道数 ${st.channels}`);
  if (!['44100', '48000'].includes(String(st.sample_rate))) notes.push(`采样率 ${st.sample_rate}`);
  if (fmt === 'mp3' && br) { const b = +(st.bit_rate || pr.format.bit_rate); if (!(Math.abs(b / (br * 1000) - 1) <= 0.1)) notes.push(`码率 ${Math.round(b / 1000)}k，应为 ${br}k`); }
  return { ok: notes.length === 0, msg: notes.join('；') || `${st.codec_name} ${st.sample_rate}Hz` };
}
const LOSSY = { wav: false, flac: false, aiff: false, mp3: true, m4a: true, ogg: true, opus: true };
// 一次导出的完整判定：格式 + 声音
function judgeExport(id, label, dl, fmt, br, specClips, o = {}) {
  if (!dl) return rec(id, label, false, '没拿到下载');
  const f = checkFile(dl.file, dl.name, fmt, br);
  const got = decode(dl.file);
  if (!got) return rec(id, label, false, `解码失败；${f.msg}`);
  const c = compare(got, specClips, { lossy: LOSSY[fmt], freeGain: o.freeGain });
  let extra = '';
  let ok = f.ok && c.ok;
  if (o.lufs) { const l = loudness(dl.file); const lok = Math.abs(l.I + 14) <= 1 && l.peak <= -0.1; ok = ok && lok; extra = `；响度 ${l.I} LUFS、峰值 ${l.peak} dBFS${lok ? '' : '（应 -14±1 LUFS 且峰值 ≤ -0.1）'}`; }
  return rec(id, label, ok, `${f.ok ? '' : '格式：' + f.msg + '；'}${c.ok ? '声音对（' + c.cv.fade + '/' + c.cv.xf + '，' + c.stat + '）' : '声音：' + c.msg}${extra}${dl.ms ? `；用时 ${(dl.ms / 1000).toFixed(1)}s` : ''}`);
}
// 一串片段逐段找位置（格式测试用：每段各自找，容许不同解码器各差几毫秒）
function matchSegments(got, segs) {
  let cur = 0; const bad = [];
  segs.forEach((s, i) => {
    const n = s.pcm.L.length, from = Math.max(-Math.round(0.05 * SR), cur - Math.round(0.3 * SR)), to = cur + Math.round(0.3 * SR);
    const start = xcorrPeak(s.pcm, got, from, to);
    const a = Math.round(0.25 * SR), m = n - 2 * a;
    const pg = prefix(got.L), pe = prefix(s.pcm.L);
    const lvl = rmsP(pg, start + a, m) - rmsP(pe, a, m);
    const c = Math.min(bestCorr(s.pcm.L, got.L, a, start + a, m), bestCorr(s.pcm.R, got.R, a, start + a, m));
    let ok;
    if (s.cls === 'amr') ok = rmsP(pg, start + a, m) > -35;
    else ok = c >= (s.cls === 'lossless' ? 0.97 : 0.8) && Math.abs(lvl) <= (s.cls === 'lossless' ? 1 : 2);
    if (!ok) bad.push(`${s.tag}(相关 ${c.toFixed(2)}，电平差 ${lvl.toFixed(1)}dB)`);
    cur = start + n;
  });
  const tail = (got.L.length - cur) / SR;
  if (Math.abs(tail) > 0.3) bad.push(`总长差 ${tail.toFixed(2)}s`);
  return bad;
}

// ───────── 静态服务器 ─────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      let u = decodeURIComponent(q.url.split('?')[0].split('#')[0]);
      if (u === '/flowcut') { r.writeHead(301, { location: '/flowcut/' }); return r.end(); }
      if (!u.startsWith('/flowcut/')) { r.writeHead(404); return r.end(); }
      u = u.slice('/flowcut/'.length) || 'index.html';
      let f = path.join(SITE, u);
      if (!f.startsWith(SITE)) { r.writeHead(403); return r.end(); }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(r);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

// ───────── 浏览器 ─────────
function initScript(inj) {
  const J = (window.__judge = { ctxCount: 0, tap: null, lt: [], ft: [] });
  const AC = window.AudioContext;
  const P = new Proxy(AC, { construct(t, a, nt) { J.ctxCount++; return Reflect.construct(t, a, nt); } });
  window.AudioContext = P; if (window.webkitAudioContext) window.webkitAudioContext = P;
  const oc = AudioNode.prototype.connect, od = AudioNode.prototype.disconnect, taps = new Map();
  const tapFor = ctx => {
    let t = taps.get(ctx);
    if (!t) {
      const g = ctx.createGain(); oc.call(g, ctx.destination);
      const sp = ctx.createChannelSplitter(2); oc.call(g, sp);
      const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0; oc.call(sp, an, 0);
      t = { g, an, ctx }; taps.set(ctx, t); J.tap = t;
    }
    return t;
  };
  AudioNode.prototype.connect = function (dest, out) {
    if (dest instanceof AudioDestinationNode && !(dest.context instanceof OfflineAudioContext)) {
      const t = tapFor(dest.context);
      if (!inj.mute) out === undefined ? oc.call(this, t.g) : oc.call(this, t.g, out);
      return dest;
    }
    return oc.apply(this, arguments);
  };
  AudioNode.prototype.disconnect = function (dest) {
    if (dest instanceof AudioDestinationNode) { const t = taps.get(dest.context); if (t && !inj.mute) { try { od.call(this, t.g); } catch {} } return; }
    return od.apply(this, arguments);
  };
  J.measure = () => {
    const t = J.tap; if (!t) return { rms: -200, freq: 0 };
    const an = t.an, td = new Float32Array(an.fftSize); an.getFloatTimeDomainData(td);
    let s = 0; for (const v of td) s += v * v;
    const fd = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(fd);
    let bi = 2; for (let i = 3; i < fd.length - 1; i++) if (fd[i] > fd[bi]) bi = i;
    const a = fd[bi - 1], b = fd[bi], c = fd[bi + 1], den = a - 2 * b + c, p = den ? (0.5 * (a - c)) / den : 0;
    return { rms: 10 * Math.log10(s / td.length + 1e-20), freq: ((bi + p) * t.ctx.sampleRate) / an.fftSize };
  };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) J.lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const tick = () => { J.ft.push(performance.now()); if (J.ft.length > 4000) J.ft.splice(0, 2000); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  if (inj.external) setTimeout(() => { const i = new Image(); i.src = 'http://localhost:9/judge-probe.png'; }, 1500);
  if (inj.consoleErr) setTimeout(() => console.error('judge injected error'), 1500);
  if (inj.jank) setInterval(() => { const t = performance.now(); while (performance.now() - t < 150); }, 400);
}

let BASE, baseHost, browser;
const net = { external: [], nonGet: [] }, consoleErrs = [], dialogs = [];
async function openPage(o = {}) {
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: o.colorScheme || 'light' });
  await ctx.addInitScript(`(${initScript})(${JSON.stringify(o.inj || {})})`);
  if (o.inj?.blockWasm) await ctx.route(/\.wasm(\?|$)/, r => r.abort());
  const page = await ctx.newPage();
  const log = o.log || { external: net.external, nonGet: net.nonGet, errs: consoleErrs, dialogs };
  page.on('request', r => {
    const u = r.url(); if (!/^https?:/.test(u)) return;
    if (new URL(u).host !== baseHost) log.external.push(u);
    if (!['GET', 'HEAD'].includes(r.method())) log.nonGet.push(`${r.method()} ${u}`);
  });
  page.on('console', m => { if (m.type() === 'error') log.errs.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => log.errs.push('页面异常：' + e.message.slice(0, 200)));
  page.on('dialog', d => { log.dialogs.push(d.message().slice(0, 100)); d.dismiss().catch(() => {}); });
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__fc && window.__fc.ready === true, null, { timeout: 30000 });
  return { ctx, page, log };
}
const T = (id) => `[data-testid=${id}]`;
const clipsL = p => p.locator(T('clip'));
const names = p => p.$$eval(T('clip'), els => els.map(e => e.getAttribute('data-name')));
async function waitClips(p, n, ms) {
  await p.waitForFunction(n => { const c = document.querySelectorAll('[data-testid=clip]'); return c.length === n && [...c].every(e => e.getAttribute('data-ready') === 'true'); }, n, { timeout: ms });
}
async function blur(p) { await p.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()); }
// 点片段「看得见那部分」的正中（长片段的几何中心可能在屏幕外）
async function visibleCenter(p, loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox(), tl = await p.locator(T('timeline')).boundingBox(), vp = p.viewportSize();
  const x0 = Math.max(b.x, tl ? tl.x : 0, 0), x1 = Math.min(b.x + b.width, tl ? tl.x + tl.width : vp.width, vp.width);
  const y0 = Math.max(b.y, 0), y1 = Math.min(b.y + b.height, vp.height);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}
async function select(p, i) {
  const c = clipsL(p).nth(i);
  const m = await visibleCenter(p, c); await p.mouse.click(m.x, m.y);
  await p.waitForFunction(i => document.querySelectorAll('[data-testid=clip]')[i]?.getAttribute('aria-selected') === 'true', i, { timeout: 3000 });
}
async function setField(p, id, v) { const f = p.locator(T(id)); await f.fill(String(v)); await f.press('Enter'); await p.waitForTimeout(200); return parseFloat(await f.inputValue()); }
const getField = async (p, id) => parseFloat(await p.locator(T(id)).inputValue());
async function key(p, k) { await blur(p); await p.keyboard.press(k); await p.waitForTimeout(250); }
const near = (a, b, t = 0.011) => Math.abs(a - b) <= t;
let dlSeq = 0;
async function doExport(p, fmt, { bitrate, normalize = false } = {}) {
  try {
    if (!(await p.locator(T('format')).isVisible())) await p.locator(T('export')).click();
    await p.locator(T('format')).selectOption(fmt, { force: true });
    if (bitrate) await p.locator(T('bitrate')).selectOption(String(bitrate), { force: true });
    const nb = p.locator(T('normalize'));
    if ((await nb.isChecked()) !== normalize) await nb.setChecked(normalize, { force: true });
    const t0 = Date.now();
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.locator(T('export-go')).click()]);
    const name = dl.suggestedFilename(); const file = path.join(OUT, `${String(++dlSeq).padStart(2, '0')}-${name.replace(/[^\w.\-]/g, '_')}`);
    await dl.saveAs(file); const ms = Date.now() - t0;
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    return { file, name, ms };
  } catch (e) { console.log('   导出出错：' + e.message.split('\n')[0]); try { await p.keyboard.press('Escape'); } catch {} return null; }
}
async function dragBy(p, loc, dx, steps = 12, wait = 16) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox(); if (!b) throw new Error('把手看不见');
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await p.mouse.move(x, y); await p.mouse.down();
  for (let i = 1; i <= steps; i++) { await p.mouse.move(x + (dx * i) / steps, y); await p.waitForTimeout(wait); }
  await p.mouse.up(); await p.waitForTimeout(250);
}
async function dragClip(p, from, to, side) {
  const s0 = await visibleCenter(p, clipsL(p).nth(from)), b = await clipsL(p).nth(to).boundingBox();
  const sx = s0.x, sy = s0.y, tx = b.x + b.width * (side === 'left' ? 0.2 : 0.8), ty = b.y + b.height / 2;
  await p.mouse.move(sx, sy); await p.mouse.down();
  for (let i = 1; i <= 20; i++) { await p.mouse.move(sx + ((tx - sx) * i) / 20, sy + ((ty - sy) * i) / 20); await p.waitForTimeout(16); }
  await p.mouse.up(); await p.waitForTimeout(400);
}
async function frameStats(p, fn) {
  await p.evaluate(() => { window.__judge.ft.length = 0; window.__judge.lt.length = 0; });
  const t0 = Date.now(); await fn(); const el = Date.now() - t0;
  return p.evaluate(el => { const f = window.__judge.ft; let mg = 0; for (let i = 1; i < f.length; i++) mg = Math.max(mg, f[i] - f[i - 1]); return { fps: (f.length / el) * 1000, maxGap: mg, maxLong: Math.max(0, ...window.__judge.lt) }; }, el);
}

// ───────── 各组 ─────────
let PCM = {};
const spec = (k, a, b, extra = {}) => ({ pcm: PCM[k], in: a, out: b, gain: 0, fin: 0, fout: 0, xf: 0, ...extra });
const fA = s => 300 + 100 * s, fB = s => 1800 - 137.5 * s;

async function groupScenario(o = {}) {
  const { ctx, page: p } = await openPage(o);
  try {
    // S1 导入
    await p.setInputFiles(T('import'), ['A', 'B', 'C'].map(k => path.join(FIX, SRC[k].file)));
    let ok = true; try { await waitClips(p, 3, 20000); } catch { ok = false; }
    const n1 = await names(p);
    if (!rec('S1', '一次导入 3 个文件，按顺序上时间线、波形画好', ok && n1.join() === 'A.mp3,B.flac,C.m4a', `片段 ${n1.join(', ')}`)) return;
    // S2 入点出点 + 夹回
    await select(p, 0);
    const clamp = await setField(p, 'clip-out', 999);
    const vi = await setField(p, 'clip-in', 2), vo = await setField(p, 'clip-out', 9.5);
    rec('S2', '输入框改入点/出点；出点填 999 自动夹回原文件时长', near(clamp, 12, 0.03) && near(vi, 2) && near(vo, 9.5), `夹回后 ${clamp}，入点 ${vi}，出点 ${vo}`);
    // S3 音量 淡入 交叉淡化 淡出
    await select(p, 1); const g = await setField(p, 'clip-gain', -6), fi = await setField(p, 'fade-in', 1);
    await select(p, 2); const xf = await setField(p, 'xfade', 1), fo = await setField(p, 'fade-out', 1.5);
    const st = await p.evaluate(() => window.__fc.state());
    rec('S3', '音量 -6dB、淡入 1s、交叉淡化 1s、淡出 1.5s 生效，总长 20.5s', near(g, -6) && near(fi, 1) && near(xf, 1) && near(fo, 1.5) && near(st.duration, 20.5, 0.03), `总长 ${st.duration}`);
    const SC1 = [spec('A', 2, 9.5), spec('B', 0, 8, { gain: -6, fin: 1 }), spec('C', 0, 6, { xf: 1, fout: 1.5 })];
    // S4 播放
    if (!o.skipPlay) await playChecks(p);
    if (o.onlyPlay) return;
    // S5 导出 WAV
    judgeExport('S5', '导出 WAV：剪辑+音量+淡入+交叉淡化+淡出都对', await doExport(p, 'wav'), 'wav', 0, SC1);
    // S6 切开 删除 拖动排序 → MP3 320
    await select(p, 0); await p.evaluate(() => window.__fc.seek(3.0)); await p.locator(T('split')).click(); await p.waitForTimeout(300);
    const n6 = await names(p); await select(p, 0); const a1 = [await getField(p, 'clip-in'), await getField(p, 'clip-out')];
    await select(p, 1); const a2 = [await getField(p, 'clip-in'), await getField(p, 'clip-out')];
    rec('S6', '播放头 3.0s 处切开：A 变成 [2,5] 和 [5,9.5]', n6.length === 4 && near(a1[0], 2) && near(a1[1], 5) && near(a2[0], 5) && near(a2[1], 9.5), `片段 ${n6.length} 个，${a1} / ${a2}`);
    await select(p, 0); await key(p, 'Delete');
    const n7 = await names(p);
    rec('S7', 'Delete 键删掉选中段，后面自动前移', n7.join() === 'A.mp3,B.flac,C.m4a' && near((await p.evaluate(() => window.__fc.state())).duration, 17.5, 0.03), n7.join(', '));
    await dragClip(p, 1, 0, 'left');
    const n8 = await names(p);
    rec('S8', '把 B 拖到 A 左半边 → 插到 A 前面', n8.join() === 'B.flac,A.mp3,C.m4a', n8.join(', '));
    const SC2 = [spec('B', 0, 8, { gain: -6, fin: 1 }), spec('A', 5, 9.5), spec('C', 0, 6, { xf: 1, fout: 1.5 })];
    judgeExport('S9', '导出 MP3 320k：切开+删除+换序后的声音对', await doExport(p, 'mp3', { bitrate: 320 }), 'mp3', 320, SC2);
    // S10 撤销两次 → FLAC（切口无缝）
    await key(p, 'Control+z'); await key(p, 'Control+z');
    const n10 = await names(p);
    rec('S10', 'Ctrl+Z 两次：撤回换序和删除', n10.join() === 'A.mp3,A.mp3,B.flac,C.m4a', n10.join(', '));
    const SC1s = [spec('A', 2, 5), spec('A', 5, 9.5), spec('B', 0, 8, { gain: -6, fin: 1 }), spec('C', 0, 6, { xf: 1, fout: 1.5 })];
    judgeExport('S11', '导出 FLAC：切开处无缝（不多不少一个采样都不该有静音）', await doExport(p, 'flac'), 'flac', 0, SC1s);
    await key(p, 'Control+Shift+z');
    const n12 = await names(p);
    rec('S12', 'Ctrl+Shift+Z 重做删除；撤销/重做按钮在', n12.join() === 'A.mp3,B.flac,C.m4a' && (await p.locator(T('undo')).isVisible()) && (await p.locator(T('redo')).isVisible()), n12.join(', '));
    // S13 把手拖动 + 撤销
    await select(p, 0);
    let ok13 = true, d13 = '';
    try {
      await dragBy(p, clipsL(p).nth(0).locator(T('trim-start')), 40);
      await select(p, 0); const i1 = await getField(p, 'clip-in');
      await key(p, 'Control+z'); await select(p, 0); const i2 = await getField(p, 'clip-in');
      await dragBy(p, clipsL(p).nth(0).locator(T('trim-end')), -40);
      await select(p, 0); const o1 = await getField(p, 'clip-out');
      await key(p, 'Control+z'); await select(p, 0); const o2 = await getField(p, 'clip-out');
      ok13 = i1 > 5.05 && near(i2, 5) && o1 < 9.45 && near(o2, 9.5); d13 = `入点 5→${i1}→撤销 ${i2}；出点 9.5→${o1}→撤销 ${o2}`;
    } catch (e) { ok13 = false; d13 = e.message.split('\n')[0]; }
    rec('S13', '拖把手改入点/出点，Ctrl+Z 能撤回', ok13, d13);
    // S14 S 键切开 + 撤销
    await select(p, 0); await p.evaluate(() => window.__fc.seek(1.0)); await key(p, 's');
    const c14 = (await names(p)).length; await key(p, 'Control+z'); const c14b = (await names(p)).length;
    rec('S14', 'S 键切开、Ctrl+Z 撤回', c14 === 4 && c14b === 3, `${c14} → ${c14b}`);
    // S15 Ctrl+滚轮缩放
    const w0 = (await clipsL(p).nth(0).boundingBox()).width;
    const tl = await p.locator(T('timeline')).boundingBox();
    await p.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2);
    await p.keyboard.down('Control'); for (let i = 0; i < 5; i++) { await p.mouse.wheel(0, -100); await p.waitForTimeout(60); } await p.keyboard.up('Control');
    await p.waitForTimeout(300);
    const w1 = (await clipsL(p).nth(0).boundingBox()).width;
    rec('S15', 'Ctrl+滚轮向上放大（片段变宽 ≥ 1.5 倍）', w1 >= w0 * 1.5, `${w0.toFixed(0)}px → ${w1.toFixed(0)}px`);
    const SC3 = [spec('A', 5, 9.5), spec('B', 0, 8, { gain: -6, fin: 1 }), spec('C', 0, 6, { xf: 1, fout: 1.5 })];
    // S16-S19 其余格式
    judgeExport('S16', '导出 M4A 256k + 响度标准化 -14 LUFS', await doExport(p, 'm4a', { bitrate: 256, normalize: true }), 'm4a', 256, SC3, { freeGain: true, lufs: true });
    judgeExport('S17', '导出 OGG(Vorbis) 256k', await doExport(p, 'ogg', { bitrate: 256 }), 'ogg', 256, SC3);
    judgeExport('S18', '导出 OPUS 192k', await doExport(p, 'opus', { bitrate: 192 }), 'opus', 192, SC3);
    judgeExport('S19', '导出 AIFF', await doExport(p, 'aiff'), 'aiff', 0, SC3);
    // S20 刷新恢复
    await p.reload({ waitUntil: 'load' });
    await p.waitForFunction(() => window.__fc && window.__fc.ready === true, null, { timeout: 30000 });
    let ok20 = true, d20 = '';
    try {
      await waitClips(p, 3, 20000);
      const n = await names(p);
      await select(p, 0); const v0 = [await getField(p, 'clip-in'), await getField(p, 'clip-out')];
      await select(p, 1); const v1 = [await getField(p, 'clip-gain'), await getField(p, 'fade-in')];
      await select(p, 2); const v2 = [await getField(p, 'xfade'), await getField(p, 'fade-out')];
      ok20 = n.join() === 'A.mp3,B.flac,C.m4a' && near(v0[0], 5) && near(v0[1], 9.5) && near(v1[0], -6) && near(v1[1], 1) && near(v2[0], 1) && near(v2[1], 1.5);
      d20 = `${n.join(', ')}；${v0} / ${v1} / ${v2}`;
    } catch (e) { ok20 = false; d20 = e.message.split('\n')[0]; }
    rec('S20', '刷新页面后工程原样恢复', ok20, d20);
    if (ok20) judgeExport('S21', '刷新后再导出 WAV，声音和刷新前一样', await doExport(p, 'wav'), 'wav', 0, SC3);
    else rec('S21', '刷新后再导出 WAV，声音和刷新前一样', false, '工程没恢复');
    await p.screenshot({ path: path.join(SHOTS, 'scenario.png') });
    const cc = await p.evaluate(() => window.__judge.ctxCount);
    rec('S22', '整页只 new 一个 AudioContext', cc <= 1, `new 了 ${cc} 次`);
  } finally { await ctx.close(); }
}
async function playChecks(p) {
  const meas = () => p.evaluate(() => ({ m: window.__judge.measure(), s: window.__fc.state(), pressed: document.querySelector('[data-testid=play]').getAttribute('aria-pressed') }));
  await p.evaluate(() => window.__fc.seek(1.0));
  await p.locator(T('play')).click(); await p.waitForTimeout(700);
  const r1 = await meas(); const e1 = fA(2 + r1.s.playhead - 0.15);
  await p.waitForTimeout(1000); const r1b = await meas(); const adv = r1b.s.playhead - r1.s.playhead;
  await p.evaluate(() => window.__fc.seek(10.0)); await p.waitForTimeout(700);
  const r2 = await meas(); const e2 = fB(r2.s.playhead - 0.15 - 7.5);
  const okA = r1.pressed === 'true' && r1.m.rms > -30 && Math.abs(r1.m.freq / e1 - 1) <= 0.12;
  const okB = r2.m.rms > -40 && Math.abs(r2.m.freq / e2 - 1) <= 0.12 && r2.m.rms - r1.m.rms >= -8 && r2.m.rms - r1.m.rms <= -4;
  rec('P1', '播放出声，听到的就是时间线上该处的声音（左声道频率对得上）', okA, `电平 ${r1.m.rms.toFixed(1)}dB，频率 ${r1.m.freq.toFixed(0)}Hz，应约 ${e1.toFixed(0)}Hz`);
  rec('P2', '播放头按真实时间走（1 秒走 1±0.15 秒）', adv >= 0.85 && adv <= 1.15, `走了 ${adv.toFixed(3)}s`);
  rec('P3', '播放中跳到 B 段：频率对、音量比 A 小约 6dB（预览也套用音量）', okB, `频率 ${r2.m.freq.toFixed(0)}Hz，应约 ${e2.toFixed(0)}Hz；比 A ${(r2.m.rms - r1.m.rms).toFixed(1)}dB`);
  await p.locator(T('play')).click(); await p.waitForTimeout(500);
  const r3 = await meas();
  await key(p, ' '); await p.waitForTimeout(600); const r4 = await meas();
  await key(p, ' '); await p.waitForTimeout(500); const r5 = await meas();
  rec('P4', '再点暂停即静音；空格键能播/停', r3.m.rms < -60 && r3.pressed === 'false' && !r3.s.playing && r4.s.playing && r4.m.rms > -40 && !r5.s.playing && r5.m.rms < -60,
    `暂停 ${r3.m.rms.toFixed(0)}dB；空格播 ${r4.s.playing}/${r4.m.rms.toFixed(0)}dB；空格停 ${r5.s.playing}/${r5.m.rms.toFixed(0)}dB`);
}

async function groupFormats(o = {}) {
  const { ctx, page: p } = await openPage(o);
  try {
    await p.setInputFiles(T('import'), FMTS.map(s => path.join(FIX, s.file)));
    let ok = true; const t0 = Date.now(); try { await waitClips(p, FMTS.length, 120000); } catch { ok = false; }
    const n = await names(p);
    const missing = FMTS.filter(s => !n.includes(s.file)).map(s => s.tag);
    if (!rec('F1', `一次导入 ${FMTS.length} 种格式，全部按顺序上时间线`, ok && n.join() === FMTS.map(s => s.file).join(), ok ? `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : `只有 ${n.length} 个就绪；没进来的：${missing.join(' ') || '（顺序不对）'}`)) return;
    if (o.onlyImport) return;
    const dl = await doExport(p, 'wav');
    const got = dl && decode(dl.file);
    const bad = got ? matchSegments(got, FMTS.map(s => ({ ...s, pcm: PCM[s.file] }))) : ['没拿到导出'];
    rec('F2', '15 种格式拼起来导出 WAV，每段声音都对', bad.length === 0, bad.length ? '不对的：' + bad.join('；') : '每段都对上');
    await p.setInputFiles(T('import'), path.join(FIX, 'bad.mp3'));
    let toast = false; try { await p.locator(T('toast')).first().waitFor({ state: 'visible', timeout: 10000 }); toast = true; } catch {}
    await p.waitForTimeout(500);
    rec('F3', '导入坏文件：出 toast 提示、不加片段、不弹窗', toast && (await names(p)).length === FMTS.length && dialogs.length === 0, `toast ${toast}，片段 ${(await names(p)).length} 个`);
    const b64 = fs.readFileSync(path.join(FIX, 'drop.wav')).toString('base64');
    await p.evaluate(({ b64 }) => {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const f = new File([bin], 'drop.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(f); const tl = document.querySelector('[data-testid=timeline]'); const r = tl.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ['dragenter', 'dragover', 'drop']) tl.dispatchEvent(new DragEvent(t, o));
    }, { b64 });
    let ok4 = true; try { await waitClips(p, FMTS.length + 1, 15000); } catch { ok4 = false; }
    rec('F4', '把文件拖进时间线松手＝导入', ok4 && (await names(p)).pop() === 'drop.wav');
  } finally { await ctx.close(); }
}

async function groupPerf(o = {}) {
  const { ctx, page: p } = await openPage(o);
  try {
    const t0 = Date.now();
    await p.setInputFiles(T('import'), path.join(FIX, 'long.mp3'));
    let ok = true; try { await waitClips(p, 1, 30000); } catch { ok = false; }
    const ms = Date.now() - t0;
    if (!rec('X1', '导入 10 分钟 MP3 到波形画好 ≤ 6 秒', ok && ms <= 6000, `${(ms / 1000).toFixed(2)}s`) && !ok) return;
    await select(p, 0);
    let s;
    try { s = await frameStats(p, () => dragBy(p, clipsL(p).nth(0).locator(T('trim-end')), -300, 120, 16)); }
    catch (e) { s = { fps: 0, maxGap: 9999, err: e.message.split('\n')[0] }; }
    rec('X2', '连续拖把手 2 秒：帧率 ≥ 48、最长一帧间隔 ≤ 100ms', s.fps >= 48 && s.maxGap <= 100, s.err || `${s.fps.toFixed(1)} fps，最长 ${s.maxGap.toFixed(0)}ms`);
    if (o.onlyDrag) return;
    await key(p, 'Control+z');
    const tl = await p.locator(T('timeline')).boundingBox();
    await p.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2);
    const z = await frameStats(p, async () => { await p.keyboard.down('Control'); for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, i < 5 ? -120 : 120); await p.waitForTimeout(50); } await p.keyboard.up('Control'); await p.waitForTimeout(200); });
    rec('X3', 'Ctrl+滚轮缩放：最长一帧间隔 ≤ 100ms', z.maxGap <= 100, `最长 ${z.maxGap.toFixed(0)}ms`);
    await select(p, 0); await setField(p, 'clip-in', 0); await setField(p, 'clip-out', 180);
    const dl = await doExport(p, 'mp3', { bitrate: 192 });
    const lim = urlArg ? 60000 : 20000;
    let d = '没拿到下载', okx = false;
    if (dl) {
      const f = checkFile(dl.file, dl.name, 'mp3', 192), pr = probe(dl.file), dur = +pr?.format?.duration, g = decode(dl.file);
      const lvl = g ? rmsP(prefix(g.L), 0, g.L.length) : -200;
      okx = f.ok && dl.ms <= lim && Math.abs(dur - 180) <= 0.15 && lvl > -30;
      d = `用时 ${(dl.ms / 1000).toFixed(1)}s，时长 ${dur}s，电平 ${lvl.toFixed(1)}dB；${f.msg}`;
    }
    rec('X4', `3 分钟导出 MP3（含首次加载转码引擎）≤ ${lim / 1000} 秒`, okx, d);
  } finally { await ctx.close(); }
}

async function groupUI() {
  // 首屏重量 + 语言 + 深浅色
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await ctx.addInitScript(`(${initScript})({})`);
    const p = await ctx.newPage(); let bytes = 0; const big = [];
    p.on('requestfinished', async r => { try { const s = await r.sizes(); bytes += s.responseBodySize + s.responseHeadersSize; if (/\.wasm/.test(r.url())) big.push(r.url()); } catch {} });
    p.on('request', r => { const u = r.url(); if (/^https?:/.test(u) && new URL(u).host !== baseHost) net.external.push(u); if (!['GET', 'HEAD'].includes(r.method())) net.nonGet.push(r.method() + ' ' + u); });
    p.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)); });
    p.on('pageerror', e => consoleErrs.push('页面异常：' + e.message.slice(0, 200)));
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__fc && window.__fc.ready === true, null, { timeout: 30000 });
    await p.waitForTimeout(2000);
    rec('U1', '首屏总下载 ≤ 1.5MB，转码引擎不预载', bytes <= 1.5e6 && big.length === 0, `${(bytes / 1e6).toFixed(2)}MB${big.length ? '；预载了 ' + big.join(' ') : ''}`);
    const lum = () => p.evaluate(() => {
      const L = c => { const m = c.match(/[\d.]+/g); if (!m || (m.length > 3 && +m[3] === 0)) return null; const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(+m[0]) + 0.7152 * f(+m[1]) + 0.0722 * f(+m[2]); };
      return L(getComputedStyle(document.body).backgroundColor) ?? L(getComputedStyle(document.documentElement).backgroundColor);
    });
    const th0 = await p.evaluate(() => document.documentElement.dataset.theme), l0 = await lum();
    await p.locator(T('theme')).click(); await p.waitForTimeout(400);
    const th1 = await p.evaluate(() => document.documentElement.dataset.theme), l1 = await lum();
    const lang0 = await p.evaluate(() => document.documentElement.lang), tx0 = await p.locator(T('export')).innerText();
    await p.locator(T('lang')).click(); await p.waitForTimeout(300);
    const lang1 = await p.evaluate(() => document.documentElement.lang), tx1 = await p.locator(T('export')).innerText();
    await p.reload({ waitUntil: 'load' }); await p.waitForFunction(() => window.__fc && window.__fc.ready === true, null, { timeout: 30000 });
    const th2 = await p.evaluate(() => document.documentElement.dataset.theme), lang2 = await p.evaluate(() => document.documentElement.lang);
    rec('U2', '深浅色：默认跟系统（深），切到浅后明显变亮，刷新保持', th0 === 'dark' && th1 === 'light' && th2 === 'light' && l0 != null && l1 != null && l1 - l0 >= 0.3, `${th0}(${l0?.toFixed(2)}) → ${th1}(${l1?.toFixed(2)}) → 刷新 ${th2}`);
    rec('U3', '中英：默认 zh-CN，切换成 en 且按钮文字变，刷新保持', lang0 === 'zh-CN' && lang1 === 'en' && tx0.trim() !== tx1.trim() && lang2 === 'en', `${lang0}「${tx0.trim()}」→ ${lang1}「${tx1.trim()}」→ 刷新 ${lang2}`);
    await p.locator(T('lang')).click(); await p.locator(T('theme')).click();
    const glass = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none' && /blur\(/.test((s.backdropFilter || '') + (s.webkitBackdropFilter || '')); }).length);
    rec('U4', '磨砂玻璃：≥ 3 个看得见的元素 backdrop-filter 含 blur', glass >= 3, `${glass} 个`);
    const unnamed = await p.evaluate(() => [...document.querySelectorAll('button, [role=button]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden'; }).filter(b => !((b.innerText || '').trim() || b.getAttribute('aria-label') || b.getAttribute('title') || b.getAttribute('aria-labelledby'))).map(b => b.outerHTML.slice(0, 80)));
    rec('U5', '看得见的按钮都有名字', unnamed.length === 0, unnamed.slice(0, 3).join(' | '));
    const hasFF = (function scan(d) { return fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).some(e => e.isDirectory() ? scan(path.join(d, e.name)) : /ffmpeg/i.test(e.name)); })(SITE);
    let ok7 = true, d7 = '没带 FFmpeg';
    try {
      await p.locator(T('about')).click(); await p.waitForTimeout(400);
      const txt = await p.evaluate(() => document.body.innerText), link = await p.evaluate(() => [...document.querySelectorAll('a[href]')].some(a => /github\.com\/ffmpegwasm/i.test(a.href) && a.getBoundingClientRect().width > 0));
      if (hasFF) { ok7 = /FFmpeg/.test(txt) && /GPL/.test(txt) && link; d7 = `FFmpeg ${/FFmpeg/.test(txt)}，GPL ${/GPL/.test(txt)}，源码链接 ${link}`; }
      await p.keyboard.press('Escape');
    } catch (e) { ok7 = false; d7 = e.message.split('\n')[0]; }
    rec('U6', '关于面板：第三方库与许可证（带 FFmpeg 时须有 GPL 与源码链接）', ok7, d7);
    await ctx.close();
  }
  // 布局
  const vps = [[1280, 720, ['import-btn', 'play', 'split', 'delete', 'undo', 'redo', 'export'], 0], [1440, 900, ['import-btn', 'play', 'split', 'delete', 'undo', 'redo', 'export'], 0], [390, 844, ['import-btn', 'play', 'export'], 40]];
  for (const [w, h, ids, min] of vps) {
    const { ctx, page: p } = await openPage({ viewport: { width: w, height: h } });
    await p.setInputFiles(T('import'), ['A', 'B', 'C'].map(k => path.join(FIX, SRC[k].file)));
    try { await waitClips(p, 3, 20000); } catch {}
    const r = await p.evaluate(({ ids, min }) => {
      const bad = [];
      for (const id of ids) {
        const e = document.querySelector(`[data-testid=${id}]`); if (!e) { bad.push(id + ' 不存在'); continue; }
        const b = e.getBoundingClientRect();
        if (!(b.width > 0 && b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5)) bad.push(id + ' 不在屏内');
        else if (b.width < min || b.height < min) bad.push(`${id} 太小 ${b.width.toFixed(0)}×${b.height.toFixed(0)}`);
      }
      const se = document.scrollingElement; if (se.scrollWidth > se.clientWidth + 1) bad.push(`横向滚动 ${se.scrollWidth}>${se.clientWidth}`);
      return bad;
    }, { ids, min });
    await p.screenshot({ path: path.join(SHOTS, `layout-${w}x${h}.png`) });
    rec(`U7-${w}`, `${w}×${h}：主按钮不滚动就在屏内${min ? `且 ≥ ${min}px` : ''}，无横向滚动`, r.length === 0, r.join('；'));
    await ctx.close();
  }
  if (urlArg) {
    const res = await fetch(new URL('index.html', BASE)); const online = Buffer.from(await res.arrayBuffer()); const local = fs.readFileSync(path.join(SITE, 'index.html'));
    rec('U8', '线上 index.html 与本地 site/index.html 逐字节相同', res.ok && online.equals(local), `线上 ${online.length}B / 本地 ${local.length}B`);
  }
}

// ───────── 反向验证 ─────────
async function proveOffline() {
  const caught = [];
  const SC1 = [spec('A', 2, 9.5), spec('B', 0, 8, { gain: -6, fin: 1 }), spec('C', 0, 6, { xf: 1, fout: 1.5 })];
  const perfect = render(SC1, CURVES[0]);
  const wav = path.join(OUT, 'prove-perfect.wav'); writeWav(wav, perfect, 24);
  const enc = { wav: null, flac: ['-c:a', 'flac'], aiff: ['-c:a', 'pcm_s16be'], mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'], m4a: ['-c:a', 'aac', '-b:a', '256k'], ogg: ['-c:a', 'libvorbis', '-b:a', '256k'], opus: ['-c:a', 'libopus', '-b:a', '192k'] };
  const save = (fmt, src, extra = []) => { if (!enc[fmt]) return src; const f = path.join(OUT, `prove-${path.basename(src, '.wav')}.${fmt}`); ff(['-i', src, ...enc[fmt], ...extra, f]); return f; };
  results = [];
  for (const fmt of Object.keys(enc)) {
    const f = save(fmt, wav);
    const ok = judgeExport(`K-${fmt}`, `完美的 ${fmt} 导出必须判过`, { file: f, name: path.basename(f) }, fmt, fmt === 'mp3' ? 320 : 0, SC1);
    caught.push({ what: `完美 ${fmt} 判过`, ok });
  }
  { // 标准化完美版
    const l = loudness(wav); const g = Math.pow(10, (-14 - l.I) / 20);
    const nf = path.join(OUT, 'prove-norm.wav'); writeWav(nf, { L: perfect.L.map(v => v * g), R: perfect.R.map(v => v * g) }, 24);
    const ok = judgeExport('K-norm', '完美的标准化导出必须判过', { file: nf, name: 'x.wav' }, 'wav', 0, SC1, { freeGain: true, lufs: true });
    caught.push({ what: '完美标准化判过', ok });
  }
  const broken = [
    ['剪错位置（入点 2.2）', [spec('A', 2.2, 9.7), SC1[1], SC1[2]]],
    ['B 音量 -3dB（应 -6）', [SC1[0], spec('B', 0, 8, { gain: -3, fin: 1 }), SC1[2]]],
    ['B 没淡入', [SC1[0], spec('B', 0, 8, { gain: -6 }), SC1[2]]],
    ['没做交叉淡化', [SC1[0], SC1[1], spec('C', 0, 6, { fout: 1.5 })]],
    ['C 没淡出', [SC1[0], SC1[1], spec('C', 0, 6, { xf: 1 })]],
    ['顺序错（B A C）', [SC1[1], SC1[0], SC1[2]]],
  ];
  for (const [what, sc] of broken) {
    const f = path.join(OUT, `prove-bad-${caught.length}.wav`); writeWav(f, render(sc, CURVES[0]), 24);
    caught.push({ what, ok: !judgeExport('K-bad', `错的导出（${what}）必须判挂`, { file: f, name: 'x.wav' }, 'wav', 0, SC1) });
  }
  const mutate = (what, fn, fmt = 'wav', o = {}) => {
    const p2 = { L: Float32Array.from(perfect.L), R: Float32Array.from(perfect.R) }; const r = fn(p2) || p2;
    const f = path.join(OUT, `prove-bad-${caught.length}.wav`); writeWav(f, r, 24);
    const ff2 = save(fmt, f, o.extra || []);
    caught.push({ what, ok: !judgeExport('K-bad', `错的导出（${what}）必须判挂`, { file: ff2, name: path.basename(ff2) }, fmt, o.br || 0, SC1, o) });
  };
  mutate('声道左右反了', p => ({ L: p.R, R: p.L }));
  mutate('混成单声道再复制两份', p => { for (let i = 0; i < p.L.length; i++) p.L[i] = p.R[i] = (p.L[i] + p.R[i]) / 2; });
  mutate('切口处多 30ms 静音', p => { const a = Math.round(3 * SR), n = Math.round(0.03 * SR); const ins = x => { const y = new Float32Array(x.length + n); y.set(x.subarray(0, a)); y.set(x.subarray(a), a + n); return y; }; return { L: ins(p.L), R: ins(p.R) }; });
  mutate('末尾多 0.3s 静音', p => { const n = Math.round(0.3 * SR); const pad = x => { const y = new Float32Array(x.length + n); y.set(x); return y; }; return { L: pad(p.L), R: pad(p.R) }; });
  mutate('MP3 只有 128k（要 320k）', () => null, 'mp3', { extra: ['-b:a', '128k'], br: 320 });
  mutate('标准化过头（-8 LUFS）', p => { const g = Math.pow(10, (-8 - loudness(wav).I) / 20); return { L: p.L.map(v => v * g), R: p.R.map(v => v * g) }; }, 'wav', { freeGain: true, lufs: true });
  { const f = path.join(OUT, 'prove-mono.flac'); ff(['-i', wav, '-ac', '1', '-c:a', 'flac', f]);
    caught.push({ what: '导出成单声道文件', ok: !judgeExport('K-bad', '错的导出（单声道文件）必须判挂', { file: f, name: 'x.flac' }, 'flac', 0, SC1) }); }
  return caught;
}
async function proveOnline() {
  const caught = [];
  const tryGroup = async (what, id, fn) => {
    const pick = () => results.find(r => r.id === id);
    results = []; let base, bad;
    try { await fn(false); base = pick(); } catch (e) { base = null; }
    results = [];
    try { await fn(true); bad = pick(); } catch (e) { bad = { ok: false }; }
    const ok = !!base?.ok && !bad?.ok;
    caught.push({ what, ok, note: !base?.ok ? '不注入时本来就红，不算抓到' : '' });
  };
  const sub = () => ({ external: [], nonGet: [], errs: [], dialogs: [] });
  await tryGroup('静音（声音没进扬声器）', 'P1', async inj => groupScenario({ inj: inj ? { mute: true } : {}, onlyPlay: true, log: sub() }));
  await tryGroup('转码引擎被拦（.wasm 拿不到）', 'F1', async inj => groupFormats({ inj: inj ? { blockWasm: true } : {}, onlyImport: true, log: sub() }));
  await tryGroup('主线程卡顿', 'X2', async inj => groupPerf({ inj: inj ? { jank: true } : {}, onlyDrag: true, log: sub() }));
  for (const [what, k] of [['外域请求', 'external'], ['控制台报错', 'consoleErr']]) {
    const runOnce = async inj => { const log = sub(); const { ctx, page } = await openPage({ inj, log }); await page.waitForTimeout(3000); await ctx.close(); return k === 'external' ? log.external.length + log.nonGet.length === 0 : log.errs.length === 0; };
    const base = await runOnce({}), bad = await runOnce({ [k]: true });
    caught.push({ what, ok: base && !bad, note: !base ? '不注入时本来就红，不算抓到' : '' });
  }
  return caught;
}

// ───────── 主程序 ─────────
const t0 = Date.now();
makeFixtures();
for (const k of Object.keys(SRC)) PCM[k] = decode(path.join(FIX, SRC[k].file));
for (const s of FMTS) PCM[s.file] = decode(path.join(FIX, s.file));
if (PROVE) {
  console.log('── 反向验证 ①：判卷自己造的导出 ──');
  const c1 = await proveOffline();
  console.log('── 反向验证 ②：往页面注入破坏 ──');
  let c2 = [];
  if (!urlArg && !fs.existsSync(path.join(SITE, 'index.html'))) c2 = [{ what: '页面注入（site/index.html 不存在）', ok: false }];
  else {
    const srv = urlArg ? null : await serve(); BASE = urlArg || `http://127.0.0.1:${srv.address().port}/flowcut/`; baseHost = new URL(BASE).host;
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    try { c2 = await proveOnline(); } finally { await browser.close(); srv && srv.close(); }
  }
  console.log('\n══ 反向验证结果 ══');
  const all = [...c1, ...c2];
  for (const c of all) console.log(`${c.ok ? '抓到' : '漏了'}  ${c.what}${c.note ? '（' + c.note + '）' : ''}`);
  const n = all.filter(c => c.ok).length;
  console.log(`抓到 ${n}/${all.length}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(n === all.length ? 0 : 2);
}
const srv = urlArg ? null : await serve();
BASE = urlArg || `http://127.0.0.1:${srv.address().port}/flowcut/`; baseHost = new URL(BASE).host;
console.log(`判卷对象：${BASE}`);
browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const guard = async (name, fn) => { try { await fn(); } catch (e) { rec(name, '这一组跑崩了', false, e.message.split('\n')[0]); } };
if (!urlArg && !fs.existsSync(path.join(SITE, 'index.html'))) rec('G0', 'site/index.html 存在', false);
else {
  if (want('scenario')) await guard('scenario', () => groupScenario());
  if (want('formats')) await guard('formats', () => groupFormats());
  if (want('perf')) await guard('perf', () => groupPerf());
  if (want('ui')) await guard('ui', () => groupUI());
  rec('N1', '全程没有外域请求、没有非 GET 请求', net.external.length + net.nonGet.length === 0, [...new Set([...net.external, ...net.nonGet])].slice(0, 3).join('；'));
  rec('N2', '全程控制台无报错、无弹窗', consoleErrs.length + dialogs.length === 0, [...new Set([...consoleErrs, ...dialogs])].slice(0, 3).join('；'));
}
await browser.close(); srv && srv.close();
const pass = results.filter(r => r.ok).length;
console.log(`\n通过 ${pass}/${results.length}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s${only ? '（只跑了 ' + only.join(',') + '，交付须跑全量）' : ''}`);
process.exit(pass === results.length && results.length > 0 ? 0 : 1);
