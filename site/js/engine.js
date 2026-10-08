// 剪辑引擎：片段模型、时间线排布、Web Audio 图（试听和导出共用这一套，保证听到的＝导出的）
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dbToGain = db => Math.pow(10, db / 20);

// clip: { id, src, in, out, gain(dB), fin, fout, xf }
export function clipLen(c) { return Math.max(0, c.out - c.in); }

// 第 k 段实际生效的交叉淡化长度（第一段为 0；不超过本段和上一段的长度）
export function effXf(clips, k) {
  if (k <= 0 || k >= clips.length) return 0;
  return clamp(clips[k].xf || 0, 0, Math.min(clipLen(clips[k]), clipLen(clips[k - 1])));
}

export function layout(clips) {
  const starts = [];
  let t = 0;
  clips.forEach((c, k) => { t -= effXf(clips, k); starts.push(t); t += clipLen(c); });
  return { starts, duration: Math.max(0, t) };
}

// 片段内（相对片段开头的秒数）的淡入淡出包络，线性
function fadeEnv(c, len) {
  const fi = clamp(c.fin || 0, 0, len), fo = clamp(c.fout || 0, 0, len);
  return u => {
    let a = 1;
    if (fi > 0 && u < fi) a *= u / fi;
    if (fo > 0 && u > len - fo) a *= (len - u) / fo;
    return clamp(a, 0, 1);
  };
}
// 交叉淡化包络，等功率（sin/cos）
function xfEnv(xi, xo, len) {
  return u => {
    let a = 1;
    if (xi > 0 && u < xi) a *= Math.sin((u / xi) * Math.PI / 2);
    if (xo > 0 && u > len - xo) a *= Math.sin(((len - u) / xo) * Math.PI / 2);
    return clamp(a, 0, 1);
  };
}
// 把包络按「需要变化的区段」写成 AudioParam 曲线；from 之前的部分跳过
function applyEnv(param, env, segs, len, u0, toCtx) {
  param.setValueAtTime(env(u0), toCtx(u0));
  const ranges = segs.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  // 合并重叠区段
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  for (let [a, b] of merged) {
    a = Math.max(a, u0); b = Math.min(b, len);
    if (b - a < 1e-4) continue;
    const n = clamp(Math.ceil((b - a) * 200), 16, 8192);
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = env(a + ((b - a) * i) / (n - 1));
    param.setValueCurveAtTime(curve, toCtx(a), b - a);
  }
}

// 在 ac 上搭出从时间线 from 秒开始的整条声音，接到 dest；t0 是 from 对应的 ac 时间
export function buildGraph(ac, dest, clips, sources, from, t0) {
  const { starts } = layout(clips);
  const nodes = [];
  clips.forEach((c, k) => {
    const s = sources.get(c.src);
    if (!s || !s.buffer) return;
    const len = clipLen(c), start = starts[k], end = start + len;
    if (end <= from + 1e-6 || len <= 0) return;
    const u0 = Math.max(0, from - start); // 从片段内的哪一秒开始
    const toCtx = u => t0 + (start + u - from);
    const src = ac.createBufferSource(); src.buffer = s.buffer;
    const g = ac.createGain(); g.gain.value = dbToGain(c.gain || 0);
    const f = ac.createGain(), x = ac.createGain();
    src.connect(g); g.connect(f); f.connect(x); x.connect(dest);
    const fi = clamp(c.fin || 0, 0, len), fo = clamp(c.fout || 0, 0, len);
    applyEnv(f.gain, fadeEnv(c, len), [[0, fi], [len - fo, len]], len, u0, toCtx);
    const xi = effXf(clips, k), xo = effXf(clips, k + 1);
    applyEnv(x.gain, xfEnv(xi, xo, len), [[0, xi], [len - xo, len]], len, u0, toCtx);
    src.start(toCtx(u0), c.in + u0, len - u0);
    nodes.push(src);
  });
  return nodes;
}

// 离线渲染整条时间线
export async function renderMix(clips, sources, sampleRate, onProgress) {
  const { duration } = layout(clips);
  const n = Math.max(1, Math.round(duration * sampleRate));
  const oac = new OfflineAudioContext(2, n, sampleRate);
  buildGraph(oac, oac.destination, clips, sources, 0, 0);
  if (onProgress) {
    const step = Math.max(1, duration / 20);
    for (let t = step; t < duration; t += step) oac.suspend(t).then(() => { onProgress(t / duration); oac.resume(); });
  }
  return oac.startRendering();
}
