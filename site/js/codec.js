// 解码与编码：浏览器原生优先，冷门格式交给自托管的 ffmpeg.wasm（用到才下载）
const FF_BASE = new URL('../vendor/ffmpeg/', import.meta.url).href;

// ───── ffmpeg.wasm：单实例、串行排队；任何一次失败后重建实例（出错会 Aborted，实例不可信）─────
let ffP = null, queue = Promise.resolve(), progressCb = null;
async function loadFF() {
  const { FFmpeg } = await import('../vendor/ffmpeg/index.js');
  const ff = new FFmpeg();
  ff.logs = [];
  ff.on('log', e => { ff.logs.push(e.message); if (ff.logs.length > 400) ff.logs.splice(0, 200); });
  ff.on('progress', e => progressCb && progressCb(Math.max(0, Math.min(1, e.progress))));
  await ff.load({ coreURL: FF_BASE + 'ffmpeg-core.js', wasmURL: FF_BASE + 'ffmpeg-core.wasm' });
  return ff;
}
export function ffWarm() { if (!ffP) ffP = loadFF().catch(e => { ffP = null; throw e; }); return ffP; }
export function ffRun(job, onProgress) {
  const run = queue.then(async () => {
    const ff = await ffWarm();
    progressCb = onProgress || null;
    try { return await job(ff); }
    catch (e) { try { ff.terminate(); } catch {} ffP = null; throw e; }
    finally { progressCb = null; }
  });
  queue = run.catch(() => {});
  return run;
}
const copy = u8 => new Uint8Array(u8); // writeFile 会把 buffer 转移走，传副本

// ───── 解码 ─────
export async function decodeFile(ctx, bytes, name) {
  try { return await ctx.decodeAudioData(bytes.slice(0)); } catch {}
  const ext = (name.match(/\.[\w]{1,5}$/) || [''])[0].toLowerCase();
  return ffRun(async ff => {
    const inN = 'in' + ext, outN = 'dec.wav';
    await ff.writeFile(inN, copy(new Uint8Array(bytes)));
    const rc = await ff.exec(['-hide_banner', '-i', inN, '-vn', '-c:a', 'pcm_f32le', '-ac', '2', '-f', 'wav', outN]);
    try { await ff.deleteFile(inN); } catch {}
    if (rc !== 0) throw new Error('ffmpeg decode failed');
    const d = await ff.readFile(outN);
    try { await ff.deleteFile(outN); } catch {}
    return ctx.decodeAudioData(d.buffer.byteLength === d.length ? d.buffer : d.slice().buffer);
  });
}

// ───── 响度（ITU-R BS.1770 / EBU R128 积分响度）─────
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
  return y;
}
function kWeight(x, fs) {
  let K = Math.tan(Math.PI * 1681.974450955533 / fs), Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  K = Math.tan(Math.PI * 38.13547087602444 / fs); Q = 0.5003270373238773; a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
}
export function integratedLoudness(buf) {
  const fs = buf.sampleRate, chans = [0, 1].map(c => kWeight(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), fs));
  const blk = Math.round(0.4 * fs), hop = Math.round(0.1 * fs), z = [];
  for (let s = 0; s + blk <= chans[0].length; s += hop) {
    let sum = 0;
    for (const ch of chans) { let m = 0; for (let i = s; i < s + blk; i++) m += ch[i] * ch[i]; sum += m / blk; }
    z.push(sum);
  }
  const L = v => -0.691 + 10 * Math.log10(v + 1e-20);
  const abs = z.filter(v => L(v) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter(v => L(v) > rel);
  return L(g.reduce((a, b) => a + b, 0) / g.length);
}
// 增益后若超过 -1 dBFS，用 5ms 前瞻限幅压住峰值（只动峰值附近）
export function applyGainLimit(buf, gain, ceilingDb = -1) {
  const ceil = Math.pow(10, ceilingDb / 20), L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0), n = L.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak * gain <= ceil) { for (const ch of [L, R]) for (let i = 0; i < n; i++) ch[i] *= gain; return; }
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(L[i]), Math.abs(R[i])) * gain; need[i] = p > ceil ? ceil / p : 1; }
  const la = Math.max(1, Math.round(buf.sampleRate * 0.005)), rel = 1 - Math.exp(-1 / (buf.sampleRate * 0.08));
  // a[i] = need 在 [i, i+la] 里的最小值（单调队列）
  const a = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && need[dq[t - 1]] >= need[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + la) h++;
    a[i] = need[dq[h]];
  }
  // 往回铺一段线性下降（la 个采样内压到位），再往前做平滑释放
  for (let i = n - 2; i >= 0; i--) a[i] = Math.min(a[i], a[i + 1] + 1 / la);
  let g = a[0];
  for (let i = 0; i < n; i++) { g = a[i] < g ? a[i] : g + (a[i] - g) * rel; const k = gain * g; L[i] *= k; if (R !== L) R[i] *= k; }
}

// ───── 编码 ─────
function interleave16(buf, bigEndian) {
  const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  const out = new DataView(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    out.setInt16(i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), !bigEndian);
    out.setInt16(i * 4 + 2, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), !bigEndian);
  }
  return new Uint8Array(out.buffer);
}
const ascii = (dv, o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
export function encodeWav(buf) {
  const pcm = interleave16(buf, false), sr = buf.sampleRate;
  const out = new Uint8Array(44 + pcm.length), dv = new DataView(out.buffer);
  ascii(dv, 0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); ascii(dv, 8, 'WAVE'); ascii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); ascii(dv, 36, 'data'); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
export function encodeAiff(buf) {
  const pcm = interleave16(buf, true), sr = buf.sampleRate, frames = buf.length;
  const out = new Uint8Array(54 + pcm.length), dv = new DataView(out.buffer);
  ascii(dv, 0, 'FORM'); dv.setUint32(4, 46 + pcm.length); ascii(dv, 8, 'AIFF');
  ascii(dv, 12, 'COMM'); dv.setUint32(16, 18); dv.setUint16(20, 2); dv.setUint32(22, frames); dv.setUint16(26, 16);
  // 采样率：80 位扩展精度浮点
  const e = Math.floor(Math.log2(sr)); dv.setUint16(28, 16383 + e);
  const mant = BigInt(Math.round(sr)) << BigInt(63 - e); dv.setBigUint64(30, mant);
  ascii(dv, 38, 'SSND'); dv.setUint32(42, 8 + pcm.length); dv.setUint32(46, 0); dv.setUint32(50, 0);
  out.set(pcm, 54);
  return out;
}

// Opus：WebCodecs 编码 + 自写 Ogg 封装（ffmpeg.wasm 的 libopus 会崩）
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; } return t; })();
function oggPage(packets, granule, serial, seq, flags) {
  const lacing = [];
  for (const p of packets) { let s = p.length; while (s >= 255) { lacing.push(255); s -= 255; } lacing.push(s); }
  const body = packets.reduce((a, p) => a + p.length, 0), page = new Uint8Array(27 + lacing.length + body), dv = new DataView(page.buffer);
  ascii(dv, 0, 'OggS'); page[4] = 0; page[5] = flags;
  dv.setBigUint64(6, BigInt(granule), true); dv.setUint32(14, serial, true); dv.setUint32(18, seq, true); dv.setUint32(22, 0, true);
  page[26] = lacing.length; page.set(lacing, 27);
  let o = 27 + lacing.length; for (const p of packets) { page.set(p, o); o += p.length; }
  let c = 0; for (let i = 0; i < page.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ page[i]) & 0xff]) >>> 0;
  dv.setUint32(22, c, true);
  return page;
}
export async function encodeOpus(buf, kbps, onProgress) {
  if (typeof AudioEncoder === 'undefined') throw new Error('no WebCodecs');
  if (buf.sampleRate !== 48000) throw new Error('opus needs 48k');
  const packets = []; let desc = null, err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => { if (meta?.decoderConfig?.description) desc = new Uint8Array(meta.decoderConfig.description); const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); packets.push({ d, n: Math.round(chunk.duration * 48 / 1000) }); },
    error: e => { err = e; },
  });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: kbps * 1000 });
  const L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0), total = buf.length, step = 48000;
  for (let s = 0; s < total; s += step) {
    const n = Math.min(step, total - s), data = new Float32Array(n * 2);
    data.set(L.subarray(s, s + n), 0); data.set(R.subarray(s, s + n), n);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(s / 48), data }));
    if (enc.encodeQueueSize > 20) await new Promise(r => setTimeout(r, 0));
    onProgress && onProgress(s / total);
  }
  await enc.flush(); enc.close();
  if (err) throw err;
  let preskip = 312;
  if (desc && desc.length >= 12 && String.fromCharCode(...desc.slice(0, 8)) === 'OpusHead') preskip = desc[10] | (desc[11] << 8);
  const serial = 0x464c4f57, pages = [];
  const head = new Uint8Array(19), hv = new DataView(head.buffer);
  ascii(hv, 0, 'OpusHead'); head[8] = 1; head[9] = 2; hv.setUint16(10, preskip, true); hv.setUint32(12, 48000, true); hv.setInt16(16, 0, true); head[18] = 0;
  const vendor = 'Flowcut', tags = new Uint8Array(8 + 4 + vendor.length + 4), tv = new DataView(tags.buffer);
  ascii(tv, 0, 'OpusTags'); tv.setUint32(8, vendor.length, true); ascii(tv, 12, vendor); tv.setUint32(12 + vendor.length, 0, true);
  let seq = 0;
  pages.push(oggPage([head], 0, serial, seq++, 2));
  pages.push(oggPage([tags], 0, serial, seq++, 0));
  const end = preskip + total;
  let cum = 0;
  for (let i = 0; i < packets.length;) {
    const group = []; let segs = 0;
    while (i < packets.length && group.length < 50) { const s = Math.floor(packets[i].d.length / 255) + 1; if (segs + s > 255) break; segs += s; cum += packets[i].n; group.push(packets[i].d); i++; }
    pages.push(oggPage(group, Math.min(cum, end), serial, seq++, i >= packets.length ? 4 : 0));
  }
  const size = pages.reduce((a, p) => a + p.length, 0), out = new Uint8Array(size);
  let o = 0; for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}

const FF_ARGS = {
  mp3: k => ['-c:a', 'libmp3lame', '-b:a', `${k}k`],
  flac: () => ['-c:a', 'flac', '-sample_fmt', 's16'],
  m4a: k => ['-c:a', 'aac', '-b:a', `${k}k`, '-movflags', '+faststart'],
  ogg: k => ['-c:a', 'libvorbis', '-b:a', `${k}k`],
  opus: k => ['-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-b:a', `${k}k`],
};
export async function encodeFF(buf, fmt, kbps, onProgress) {
  const wav = encodeWav(buf);
  return ffRun(async ff => {
    const outN = 'out.' + fmt;
    await ff.writeFile('mix.wav', wav);
    const rc = await ff.exec(['-hide_banner', '-i', 'mix.wav', ...FF_ARGS[fmt](kbps), '-y', outN]);
    try { await ff.deleteFile('mix.wav'); } catch {}
    if (rc !== 0) throw new Error('ffmpeg encode failed: ' + ff.logs.slice(-3).join(' | '));
    const d = await ff.readFile(outN);
    try { await ff.deleteFile(outN); } catch {}
    return d;
  }, onProgress);
}
export const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', aiff: 'audio/aiff' };
