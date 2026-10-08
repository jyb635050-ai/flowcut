import { clamp, clipLen, effXf, layout, buildGraph, renderMix, dbToGain } from './engine.js';
import { decodeFile, integratedLoudness, applyGainLimit, encodeWav, encodeAiff, encodeOpus, encodeFF, MIME, ffWarm } from './codec.js';
import { idbGet, idbPut, idbDel, idbKeys, pref } from './store.js';
import { STR } from './i18n.js';

const $ = s => document.querySelector(s);
const actx = new AudioContext({ latencyHint: 'interactive' });
const SR = actx.sampleRate;

// ───────── 状态 ─────────
const sources = new Map(); // id -> { name, key, buffer, peaks }
const S = { clips: [], sel: null, playhead: 0, playing: false, pps: 60, nextId: 1 };
let lang = pref.get('lang') === 'en' ? 'en' : 'zh';
const t = k => STR[lang][k] ?? k;
const undoS = [], redoS = [];
const snap = () => JSON.stringify({ clips: S.clips, sel: S.sel });
function restore(s) { const o = JSON.parse(s); S.clips = o.clips; S.sel = o.clips.some(c => c.id === o.sel) ? o.sel : null; }
function commit(prev) {
  if (prev === snap()) return;
  undoS.push(prev); if (undoS.length > 300) undoS.shift();
  redoS.length = 0; changed();
}
function undo() { if (!undoS.length) return; redoS.push(snap()); restore(undoS.pop()); changed(); }
function redo() { if (!redoS.length) return; undoS.push(snap()); restore(redoS.pop()); changed(); }
let saveT = 0;
function changed() {
  render();
  if (S.playing) restartSoon();
  clearTimeout(saveT); saveT = setTimeout(saveProject, 120);
}
function saveProject() { idbPut('project', { clips: S.clips, nextId: S.nextId }); }
const selClip = () => S.clips.find(c => c.id === S.sel) || null;
const fmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; };
const hueOf = id => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360; return (h * 47 + 200) % 360; };

// ───────── 导入 ─────────
function computePeaks(buf) {
  const B = 256, n = buf.length, nb = Math.ceil(n / B), mn = new Float32Array(nb), mx = new Float32Array(nb);
  const chs = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  for (let b = 0; b < nb; b++) {
    let lo = 0, hi = 0; const e = Math.min(n, (b + 1) * B);
    for (const ch of chs) for (let i = b * B; i < e; i++) { const v = ch[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
    mn[b] = lo; mx[b] = hi;
  }
  return { B, mn, mx, chs };
}
function addSource(id, name, key, buffer) { sources.set(id, { name, key, buffer, peaks: computePeaks(buffer) }); }
let busyN = 0;
async function importFiles(list) {
  const files = [...list].filter(f => f && f.size >= 0);
  if (!files.length) return;
  busyN++; render();
  const wasEmpty = S.clips.length === 0, prev = snap();
  // 并行解码，按原顺序接到末尾
  const jobs = files.map(f => (async () => {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    for (const [id, s] of sources) if (s.key === key) return { reuse: id, f };
    const bytes = await f.arrayBuffer();
    const buffer = await decodeFile(actx, bytes, f.name);
    if (!buffer || buffer.length < 2) throw new Error('empty');
    return { f, key, buffer };
  })());
  for (let i = 0; i < jobs.length; i++) {
    try {
      const r = await jobs[i];
      let id = r.reuse;
      if (!id) {
        id = 's' + S.nextId++;
        addSource(id, r.f.name, r.key, r.buffer);
        idbPut('src:' + id, { name: r.f.name, key: r.key, file: r.f }); // 存 File 本身，免主线程拷贝
      }
      const dur = sources.get(id).buffer.duration;
      S.clips.push({ id: 'c' + S.nextId++, src: id, in: 0, out: dur, gain: 0, fin: 0, fout: 0, xf: 0 });
      render();
    } catch { toast(`${t('importFailed')}：${files[i].name}`, true); }
  }
  busyN--;
  commit(prev);
  if (wasEmpty && S.clips.length) fit();
}

// ───────── 播放 ─────────
let live = [], master = null, psCtx = 0, psPH = 0, restartT = 0;
const duration = () => layout(S.clips).duration;
const curPH = () => (S.playing ? Math.min(duration(), psPH + Math.max(0, actx.currentTime - psCtx)) : S.playhead);
function stopNodes() {
  for (const n of live) { try { n.stop(); } catch {} }
  live = [];
  if (master) { const m = master; m.gain.setTargetAtTime(0, actx.currentTime, 0.005); setTimeout(() => { try { m.disconnect(); } catch {} }, 60); master = null; }
}
function startAt(tl) {
  stopNodes();
  if (actx.state !== 'running') actx.resume();
  if (tl >= duration() - 0.01) tl = 0;
  master = actx.createGain(); master.connect(actx.destination);
  psCtx = actx.currentTime + 0.03; psPH = tl;
  live = buildGraph(actx, master, S.clips, sources, tl, psCtx);
  S.playing = true; render();
}
function pause() { S.playhead = curPH(); stopNodes(); S.playing = false; render(); }
function togglePlay() { if (!S.clips.length) return; S.playing ? pause() : startAt(S.playhead); }
function restartSoon() { clearTimeout(restartT); restartT = setTimeout(() => { if (S.playing) startAt(curPH()); }, 40); }
function seek(tl) { const p = clamp(tl, 0, duration()); if (S.playing) startAt(p); else S.playhead = p; drawDirty = true; }

// ───────── 切开 / 删除 / 清空 ─────────
function split() {
  const tl = curPH(), { starts } = layout(S.clips);
  const inside = i => tl > starts[i] + 0.005 && tl < starts[i] + clipLen(S.clips[i]) - 0.005;
  let k = S.clips.findIndex(c => c.id === S.sel);
  if (k < 0 || !inside(k)) k = S.clips.findIndex((c, i) => inside(i));
  if (k < 0) return;
  const prev = snap(), c = S.clips[k], at = c.in + (tl - starts[k]);
  const c2 = { ...c, id: 'c' + S.nextId++, in: at, fin: 0, xf: 0 };
  c.out = at; c.fout = 0;
  S.clips.splice(k + 1, 0, c2);
  commit(prev);
}
function del() {
  const k = S.clips.findIndex(c => c.id === S.sel); if (k < 0) return;
  const prev = snap(); S.clips.splice(k, 1); S.sel = null; commit(prev);
  if (S.playhead > duration()) S.playhead = duration();
}
function clearAll() { if (!S.clips.length) return; const prev = snap(); if (S.playing) pause(); S.clips = []; S.sel = null; S.playhead = 0; commit(prev); toast(t('cleared')); }

// ───────── 导出 ─────────
let exporting = false;
async function doExport() {
  if (exporting) return;
  if (!S.clips.length) return toast(t('emptyExport'), true);
  const fmt = $('#format').value, kbps = +$('#bitrate').value, norm = $('#normalize').checked;
  exporting = true; $('#bGo').disabled = true; prog(0.02, t('rendering'));
  try {
    const useWC = fmt === 'opus' && typeof AudioEncoder !== 'undefined';
    const buf = await renderMix(S.clips, sources, useWC ? 48000 : SR, p => prog(p * 0.45, t('rendering')));
    if (norm) { const I = integratedLoudness(buf); if (isFinite(I)) applyGainLimit(buf, dbToGain(-14 - I), -1); }
    prog(0.5, t('encoding'));
    let data;
    if (fmt === 'wav') data = encodeWav(buf);
    else if (fmt === 'aiff') data = encodeAiff(buf);
    else if (useWC) { try { data = await encodeOpus(buf, kbps, p => prog(0.5 + p * 0.5, t('encoding'))); } catch { data = await encodeFF(buf, 'opus', kbps, p => prog(0.5 + p * 0.5, t('encoding'))); } }
    else { prog(0.5, t('loadingEngine')); data = await encodeFF(buf, fmt, kbps, p => prog(0.55 + p * 0.45, t('encoding'))); }
    prog(1, t('exported'));
    const first = sources.get(S.clips[0].src)?.name.replace(/\.[^.]+$/, '') || 'flowcut';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: MIME[fmt] }));
    a.download = `${first}-flowcut.${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    setTimeout(() => prog(-1), 2500);
    toast(`${t('exported')} · ${a.download}`);
  } catch (e) {
    prog(-1); toast(t('exportFailed'), true);
    console.warn('export failed', e);
  } finally { exporting = false; $('#bGo').disabled = false; }
}
function prog(p, label) {
  const w = $('#progWrap');
  if (p < 0) { w.classList.remove('on'); $('#progFill').style.width = '0'; return; }
  w.classList.add('on'); $('#progFill').style.width = (p * 100).toFixed(1) + '%';
  $('#progress').setAttribute('aria-valuenow', Math.round(p * 100)); if (label) $('#progLabel').textContent = label;
}

// ───────── 画面：片段 DOM ─────────
const lane = $('#lane'), content = $('#content'), scroller = $('#scroller'), canvas = $('#wave'), g2 = canvas.getContext('2d');
let drawDirty = true;
const PAD = 18; // 时间 0 离面板左边的留白（px）
function makeClipEl(c) {
  const el = document.createElement('div');
  el.className = 'clip'; el.setAttribute('data-testid', 'clip'); el.dataset.cid = c.id;
  el.innerHTML = '<div class="lab"></div><div class="trim s" data-testid="trim-start"></div><div class="trim e" data-testid="trim-end"></div><div class="fadeh fi"></div><div class="fadeh fo"></div>';
  el.addEventListener('pointerdown', onClipDown);
  return el;
}
function render() {
  const { starts, duration: dur } = layout(S.clips);
  content.style.width = Math.max(PAD + dur * S.pps + 240, scroller.clientWidth) + 'px';
  const existing = new Map([...lane.children].map(e => [e.dataset.cid, e]));
  S.clips.forEach((c, k) => {
    let el = existing.get(c.id); if (!el) el = makeClipEl(c); existing.delete(c.id);
    const s = sources.get(c.src), len = clipLen(c);
    el.style.left = PAD + starts[k] * S.pps + 'px'; el.style.width = Math.max(2, len * S.pps) + 'px';
    el.style.setProperty('--h', hueOf(c.src));
    el.setAttribute('aria-selected', String(S.sel === c.id));
    el.setAttribute('data-name', s ? s.name : '?');
    el.setAttribute('aria-label', s ? s.name : 'clip');
    const lab = el.firstChild, txt = `${s ? s.name : ''}`;
    if (lab.dataset.t !== txt + len.toFixed(2)) { lab.textContent = txt; const sm = document.createElement('small'); sm.textContent = fmtT(len); lab.appendChild(sm); lab.dataset.t = txt + len.toFixed(2); }
    const fi = el.querySelector('.fi'), fo = el.querySelector('.fo');
    fi.style.left = Math.max(8, Math.min(len, c.fin) * S.pps) + 'px';
    fo.style.left = `calc(100% - ${Math.max(8, Math.min(len, c.fout) * S.pps)}px)`;
    if (lane.children[k] !== el) lane.insertBefore(el, lane.children[k] || null);
  });
  existing.forEach(e => e.remove());
  // 已画好波形就标就绪（画布同步重画一次）
  drawWave();
  for (const el of lane.children) if (el.getAttribute('data-ready') !== 'true') el.setAttribute('data-ready', 'true');
  $('#empty').classList.toggle('gone', S.clips.length > 0 || busyN > 0);
  $('#tTotal').textContent = fmtT(dur);
  const pb = $('#bPlay'); pb.setAttribute('aria-pressed', String(S.playing)); pb.setAttribute('aria-label', t(S.playing ? 'pause' : 'play'));
  $('#playIc').firstElementChild.setAttribute('href', S.playing ? '#i-pause' : '#i-play');
  $('#bUndo').disabled = !undoS.length; $('#bRedo').disabled = !redoS.length;
  $('#bDel').disabled = !S.sel; $('#bSplit').disabled = !S.clips.length; $('#bClear').disabled = !S.clips.length;
  updateInspector(); syncZoom();
}

// ───────── 画面：画布（标尺 + 可见区波形）─────────
function drawWave() {
  drawDirty = false;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = g2; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const sl = scroller.scrollLeft, pps = S.pps, css = getComputedStyle(document.documentElement);
  const fg3 = css.getPropertyValue('--fg-3').trim() || '#888';
  // 标尺
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => s * pps >= 80) || 600;
  g.font = '11px ' + css.getPropertyValue('--mono'); g.fillStyle = fg3; g.strokeStyle = fg3; g.globalAlpha = .7; g.lineWidth = 1;
  const t0 = Math.max(0, Math.floor((sl - PAD) / pps / step) * step);
  for (let tm = t0; PAD + tm * pps - sl < W; tm += step) {
    const x = Math.round(PAD + tm * pps - sl) + .5; if (x < -40) continue;
    g.beginPath(); g.moveTo(x, 18); g.lineTo(x, 28); g.stroke();
    for (let j = 1; j < 5; j++) { const xx = Math.round(PAD + (tm + (step * j) / 5) * pps - sl) + .5; g.beginPath(); g.moveTo(xx, 24); g.lineTo(xx, 28); g.stroke(); }
    const m = Math.floor(tm / 60), s = tm - m * 60;
    g.fillText(step < 1 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`, x + 4, 14);
  }
  g.globalAlpha = 1;
  // 波形
  const top = 40 + 26, bot = H - 22 + 12 - 6, mid = (top + bot) / 2, amp = (bot - top) / 2;
  const { starts } = layout(S.clips);
  S.clips.forEach((c, k) => {
    const s = sources.get(c.src); if (!s) return;
    const len = clipLen(c), x0 = PAD + starts[k] * pps - sl, x1 = x0 + len * pps;
    if (x1 < 0 || x0 > W) return;
    const h = hueOf(c.src), p = s.peaks, rate = s.buffer.sampleRate, gain = dbToGain(c.gain || 0);
    const xi = effXf(S.clips, k), xo = effXf(S.clips, k + 1);
    const env = u => {
      let a = gain;
      if (c.fin > 0 && u < c.fin) a *= u / c.fin;
      if (c.fout > 0 && u > len - c.fout) a *= (len - u) / c.fout;
      if (xi > 0 && u < xi) a *= Math.sin((u / xi) * Math.PI / 2);
      if (xo > 0 && u > len - xo) a *= Math.sin(((len - u) / xo) * Math.PI / 2);
      return Math.max(0, a);
    };
    const a = Math.max(0, Math.floor(x0)), b = Math.min(W, Math.ceil(x1));
    const tops = new Float32Array(b - a), bots = new Float32Array(b - a);
    for (let x = a; x < b; x++) {
      const u0 = (x - x0) / pps, u1 = (x + 1 - x0) / pps;
      const i0 = Math.max(0, Math.floor((c.in + u0) * rate)), i1 = Math.max(i0 + 1, Math.floor((c.in + Math.min(len, u1)) * rate));
      let lo = 0, hi = 0;
      if (i1 - i0 >= p.B * 2) {
        const b0 = Math.floor(i0 / p.B), b1 = Math.min(p.mn.length, Math.ceil(i1 / p.B));
        for (let j = b0; j < b1; j++) { if (p.mn[j] < lo) lo = p.mn[j]; if (p.mx[j] > hi) hi = p.mx[j]; }
      } else {
        const stepS = Math.max(1, Math.floor((i1 - i0) / 64));
        for (const ch of p.chs) for (let j = i0; j < i1 && j < ch.length; j += stepS) { const v = ch[j]; if (v < lo) lo = v; else if (v > hi) hi = v; }
      }
      const e = env((u0 + u1) / 2);
      tops[x - a] = mid - Math.min(1, hi * e) * amp; bots[x - a] = mid - Math.max(-1, lo * e) * amp;
    }
    const grad = g.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, `hsla(${h},95%,60%,.95)`); grad.addColorStop(.5, `hsla(${(h + 30) % 360},95%,58%,.9)`); grad.addColorStop(1, `hsla(${h},95%,60%,.95)`);
    g.fillStyle = grad; g.beginPath(); g.moveTo(a, tops[0]);
    for (let x = a; x < b; x++) g.lineTo(x + .5, Math.min(tops[x - a], mid - .5));
    for (let x = b - 1; x >= a; x--) g.lineTo(x + .5, Math.max(bots[x - a], mid + .5));
    g.closePath(); g.fill();
    // 淡入淡出曲线
    if (c.fin > 0 || c.fout > 0 || xi > 0 || xo > 0) {
      g.strokeStyle = `hsla(${h},95%,45%,.9)`; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.beginPath();
      for (let x = a; x <= b; x += 2) { const y = bot - (env((x - x0) / pps) / Math.max(gain, 1e-6)) * (bot - top); x === a ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.stroke(); g.setLineDash([]);
    }
  });
}

// ───────── 检查器 ─────────
const FIELDS = [['clip-in', 'in'], ['clip-out', 'out'], ['clip-gain', 'gain'], ['fade-in', 'fin'], ['fade-out', 'fout'], ['xfade', 'xf']];
function updateInspector() {
  const c = selClip(), s = c && sources.get(c.src);
  $('#fields').classList.toggle('off', !c); $('#inspEmpty').style.display = c ? 'none' : '';
  $('#inspName').textContent = s ? s.name : t('inspector');
  $('#inspMeta').textContent = s ? `${t('source')} ${fmtT(s.buffer.duration)} · ${fmtT(clipLen(c))}` : '';
  $('#inspDot').style.background = c ? `hsl(${hueOf(c.src)},95%,58%)` : '';
  for (const [id, k] of FIELDS) {
    const inp = document.querySelector(`[data-testid=${id}]`);
    inp.disabled = !c;
    if (document.activeElement === inp && inp.dataset.editing === '1') continue;
    inp.value = c ? String(+(+c[k] || 0).toFixed(3)) : '';
  }
  const xfF = $('[data-testid=xfade]').closest('.field');
  xfF.style.opacity = c && S.clips.indexOf(c) === 0 ? .5 : '';
}
for (const [id, k] of FIELDS) {
  const inp = document.querySelector(`[data-testid=${id}]`);
  const apply = () => {
    inp.dataset.editing = '';
    const c = selClip(); if (!c) return;
    const v = parseFloat(String(inp.value).replace(',', '.'));
    if (!isFinite(v)) { updateInspector(); return; }
    const prev = snap(), srcDur = sources.get(c.src).buffer.duration, len = clipLen(c);
    if (k === 'in') c.in = clamp(v, 0, c.out - 0.01);
    else if (k === 'out') c.out = clamp(v, c.in + 0.01, srcDur);
    else if (k === 'gain') c.gain = clamp(v, -60, 24);
    else c[k] = clamp(v, 0, len);
    commit(prev); updateInspector();
  };
  inp.addEventListener('input', () => { inp.dataset.editing = '1'; });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { apply(); e.preventDefault(); }
    else if (e.key === 'Escape') { inp.dataset.editing = ''; updateInspector(); inp.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); const st = (k === 'gain' ? 1 : 0.1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      inp.value = String(+((parseFloat(inp.value) || 0) + st).toFixed(3)); apply();
    }
  });
  inp.addEventListener('change', apply);
}

// ───────── 时间线交互 ─────────
const timeAt = clientX => (clientX - content.getBoundingClientRect().left - PAD) / S.pps;
function onClipDown(e) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const el = e.currentTarget, c = S.clips.find(x => x.id === el.dataset.cid); if (!c) return;
  const tgt = e.target, prev = snap(), x0 = e.clientX, y0 = e.clientY, orig = { ...c }, srcDur = sources.get(c.src).buffer.duration;
  const mode = tgt.classList.contains('s') && tgt.classList.contains('trim') ? 'in' : tgt.classList.contains('e') && tgt.classList.contains('trim') ? 'out'
    : tgt.classList.contains('fi') ? 'fin' : tgt.classList.contains('fo') ? 'fout' : 'body';
  el.setPointerCapture(e.pointerId);
  if (mode !== 'body' && S.sel !== c.id) { S.sel = c.id; }
  let moved = false, dropAt = -1;
  const move = ev => {
    const dx = ev.clientX - x0, dt = dx / S.pps;
    if (!moved && Math.hypot(dx, ev.clientY - y0) < 4) return;
    moved = true;
    if (mode === 'in') { c.in = clamp(orig.in + dt, 0, c.out - 0.01); render(); }
    else if (mode === 'out') { c.out = clamp(orig.out + dt, c.in + 0.01, srcDur); render(); }
    else if (mode === 'fin') { c.fin = clamp(orig.fin + dt, 0, clipLen(c)); render(); }
    else if (mode === 'fout') { c.fout = clamp(orig.fout - dt, 0, clipLen(c)); render(); }
    else {
      el.classList.add('dragging'); el.style.transform = `translate(${dx}px, ${clamp(ev.clientY - y0, -20, 20)}px) scale(1.02)`;
      dropAt = dropIndex(ev.clientX, c.id);
      const mark = $('#dropMark'), { starts } = layout(S.clips);
      if (dropAt >= 0) {
        const others = S.clips.filter(x => x.id !== c.id);
        const ref = others[dropAt] ? starts[S.clips.indexOf(others[dropAt])] : duration();
        mark.style.left = PAD + ref * S.pps + 'px'; mark.classList.add('on');
      } else mark.classList.remove('on');
      autoScroll(ev.clientX);
    }
  };
  const up = ev => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    $('#dropMark').classList.remove('on');
    if (mode === 'body') {
      el.classList.remove('dragging'); el.style.transform = '';
      if (!moved) { S.sel = c.id; render(); return; }
      dropAt = dropIndex(ev.clientX, c.id);
      if (dropAt >= 0) {
        const from = S.clips.indexOf(c); S.clips.splice(from, 1); S.clips.splice(dropAt, 0, c);
        S.sel = c.id; commit(prev); return;
      }
      render(); return;
    }
    if (!moved) { render(); return; }
    commit(prev); render();
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
// 指针落在哪一段的左半边/右半边 → 插入到「去掉自己后的列表」的第几个位置；-1 = 不动
function dropIndex(clientX, selfId) {
  const tm = timeAt(clientX), { starts } = layout(S.clips);
  let hit = -1;
  for (let i = S.clips.length - 1; i >= 0; i--) { if (S.clips[i].id === selfId) continue; if (tm >= starts[i] && tm <= starts[i] + clipLen(S.clips[i])) { hit = i; break; } }
  if (hit < 0) { if (tm > duration()) hit = S.clips.length; else return -1; }
  const others = S.clips.filter(x => x.id !== selfId);
  if (hit === S.clips.length) return others.length;
  const left = tm < starts[hit] + clipLen(S.clips[hit]) / 2;
  const oi = others.indexOf(S.clips[hit]);
  return left ? oi : oi + 1;
}
function autoScroll(clientX) {
  const r = scroller.getBoundingClientRect();
  if (clientX < r.left + 40) scroller.scrollLeft -= 18; else if (clientX > r.right - 40) scroller.scrollLeft += 18;
}
// 空白处 / 标尺：点＝跳播放头，按住拖＝擦洗
content.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('.clip')) return;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (e.target.closest('.lane')) { S.sel = null; render(); }
  const wasPlaying = S.playing; if (wasPlaying) pause();
  content.setPointerCapture(e.pointerId);
  const go = ev => { S.playhead = clamp(timeAt(ev.clientX), 0, duration()); drawDirty = true; autoScroll(ev.clientX); };
  go(e);
  const up = () => { content.removeEventListener('pointermove', go); content.removeEventListener('pointerup', up); if (wasPlaying) startAt(S.playhead); };
  content.addEventListener('pointermove', go); content.addEventListener('pointerup', up);
});
scroller.addEventListener('scroll', () => { drawDirty = true; }, { passive: true });

// ───────── 缩放 ─────────
const PPS_MIN = 0.5, PPS_MAX = 3000;
const ppsToSlider = p => Math.round((Math.log(p / PPS_MIN) / Math.log(PPS_MAX / PPS_MIN)) * 1000);
const sliderToPps = v => PPS_MIN * Math.pow(PPS_MAX / PPS_MIN, v / 1000);
function setZoom(p, anchorClientX) {
  p = clamp(p, PPS_MIN, PPS_MAX);
  const r = scroller.getBoundingClientRect(), ax = anchorClientX ?? r.left + r.width / 2;
  const tAnchor = (scroller.scrollLeft + ax - r.left - PAD) / S.pps;
  S.pps = p; render();
  scroller.scrollLeft = PAD + tAnchor * p - (ax - r.left);
  drawDirty = true;
}
function fit() { const d = duration(); if (d > 0) { setZoom((scroller.clientWidth - PAD - 50) / d); scroller.scrollLeft = 0; } }
function syncZoom() { const z = $('#zoom'); if (document.activeElement !== z) z.value = ppsToSlider(S.pps); }
$('#zoom').addEventListener('input', e => setZoom(sliderToPps(+e.target.value)));
$('#bZoomIn').onclick = () => setZoom(S.pps * 1.5);
$('#bZoomOut').onclick = () => setZoom(S.pps / 1.5);
$('#bFit').onclick = fit;
$('#timeline').addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.pps * Math.pow(1.0018, -e.deltaY * (e.deltaMode ? 30 : 1)), e.clientX); }
  else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroller.scrollWidth > scroller.clientWidth) { e.preventDefault(); scroller.scrollLeft += e.deltaY; }
}, { passive: false });

// ───────── 弹层 / 提示 ─────────
let toastT = 0;
function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg; el.classList.toggle('err', err); el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), err ? 5000 : 3000);
}
function openSheet(id) { closeSheets(); $(id).classList.add('open'); $('#scrim').classList.add('on'); if (id === '#exportSheet') { syncChips(); ffWarmIfNeeded(); } }
function closeSheets() { for (const s of document.querySelectorAll('.sheet.open')) s.classList.remove('open'); $('#scrim').classList.remove('on'); }
const FMTS = [['mp3', 'MP3', ''], ['wav', 'WAV', 'lossless'], ['flac', 'FLAC', 'lossless'], ['m4a', 'M4A', 'AAC'], ['ogg', 'OGG', 'Vorbis'], ['opus', 'Opus', ''], ['aiff', 'AIFF', 'lossless']];
function buildChips() {
  const box = $('#fmtChips'); box.innerHTML = '';
  for (const [v, label, sub] of FMTS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.v = v;
    b.innerHTML = `<span>${label}</span><small>${sub === 'lossless' ? t('lossless') : sub}</small>`;
    b.onclick = () => { $('#format').value = v; syncChips(); };
    box.appendChild(b);
  }
}
function syncChips() {
  const v = $('#format').value;
  for (const b of document.querySelectorAll('.chip')) b.classList.toggle('on', b.dataset.v === v);
  $('#brRow').classList.toggle('dim', ['wav', 'flac', 'aiff'].includes(v));
  pref.set('format', v); pref.set('bitrate', $('#bitrate').value);
}
function ffWarmIfNeeded() { if (['mp3', 'flac', 'm4a', 'ogg'].includes($('#format').value)) ffWarm().catch(() => {}); }
$('#format').addEventListener('change', () => { syncChips(); ffWarmIfNeeded(); });
$('#bitrate').addEventListener('change', syncChips);

// ───────── 语言 / 主题 ─────────
function applyLang() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.title = lang === 'en' ? 'Flowcut · Song Editor' : '流音 Flowcut · 歌曲剪辑';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  const lab = { bImport: 'import', bUndo: 'undo', bRedo: 'redo', bClear: 'clear', bAbout: 'about', bExport: 'export', bSplit: 'split', bDel: 'delete', bZoomIn: 'zoomIn', bZoomOut: 'zoomOut', bFit: 'fit', bLang: 'lang' };
  for (const [id, k] of Object.entries(lab)) { const b = document.getElementById(id); b.setAttribute('aria-label', t(k)); b.title = t(k); }
  buildChips(); syncChips(); applyTheme(document.documentElement.dataset.theme); render();
}
function applyTheme(th) {
  document.documentElement.dataset.theme = th;
  const b = $('#bTheme'); b.firstElementChild.firstElementChild.setAttribute('href', th === 'dark' ? '#i-sun' : '#i-moon');
  b.setAttribute('aria-label', t(th === 'dark' ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label');
  document.querySelector('meta[name=theme-color]').content = th === 'dark' ? '#07080c' : '#eef1f7';
  drawDirty = true;
}
$('#bLang').onclick = () => { lang = lang === 'en' ? 'zh' : 'en'; pref.set('lang', lang); applyLang(); };
$('#bTheme').onclick = () => { const th = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; pref.set('theme', th); applyTheme(th); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => { if (!pref.get('theme')) applyTheme(e.matches ? 'dark' : 'light'); });

// ───────── 事件绑定 ─────────
$('#bImport').onclick = () => $('#file').click();
$('#file').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
$('#bUndo').onclick = undo; $('#bRedo').onclick = redo; $('#bClear').onclick = clearAll;
$('#bPlay').onclick = togglePlay; $('#bSplit').onclick = split; $('#bDel').onclick = del;
$('#bExport').onclick = () => openSheet('#exportSheet');
$('#bAbout').onclick = () => openSheet('#aboutSheet');
$('#bExpClose').onclick = closeSheets; $('#bAboutClose').onclick = closeSheets; $('#scrim').onclick = closeSheets;
$('#bGo').onclick = doExport;
// 拖文件进来
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dragVeil').classList.add('on'); });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dragVeil').classList.remove('on'); } });
window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#dragVeil').classList.remove('on'); importFiles(e.dataTransfer.files); });
// 键盘
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (document.querySelector('.sheet.open')) { closeSheets(); return; } }
  if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable]')) return;
  if (document.querySelector('.sheet.open')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod) return;
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 's') { e.preventDefault(); split(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(curPH() + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1)); }
  else if (e.key === 'Home') seek(0); else if (e.key === 'End') seek(duration());
  else if (e.key === '=' || e.key === '+') setZoom(S.pps * 1.5); else if (e.key === '-') setZoom(S.pps / 1.5);
});
window.addEventListener('resize', () => { render(); });

// ───────── 主循环：播放头 + 画布 ─────────
let lastPH = -1;
(function loop() {
  if (S.playing && curPH() >= duration() - 1e-3) { S.playhead = duration(); S.playing = false; stopNodes(); render(); }
  const ph = curPH();
  if (ph !== lastPH) {
    lastPH = ph;
    $('#playhead').style.transform = `translateX(${PAD + ph * S.pps}px)`;
    $('#tNow').textContent = fmtT(ph);
    if (S.playing) { const x = PAD + ph * S.pps - scroller.scrollLeft; if (x > scroller.clientWidth - 40 || x < 0) scroller.scrollLeft = PAD + ph * S.pps - 60; }
  }
  if (drawDirty) drawWave();
  requestAnimationFrame(loop);
})();

// ───────── 判卷/自动化接口 ─────────
window.__fc = {
  ready: false,
  state: () => ({ playhead: curPH(), playing: S.playing, duration: duration(), clips: S.clips.map(c => ({ name: sources.get(c.src)?.name, in: c.in, out: c.out })) }),
  seek,
};

// ───────── 启动：恢复上次的工程 ─────────
(async () => {
  const fmt = pref.get('format'), br = pref.get('bitrate');
  if (fmt && [...$('#format').options].some(o => o.value === fmt)) $('#format').value = fmt;
  if (br && [...$('#bitrate').options].some(o => o.value === br)) $('#bitrate').value = br;
  applyLang();
  try {
    const p = await idbGet('project');
    if (p && Array.isArray(p.clips)) {
      S.nextId = p.nextId || 1;
      const need = [...new Set(p.clips.map(c => c.src))];
      await Promise.all(need.map(async id => {
        const s = await idbGet('src:' + id); if (!s) return;
        try { const bytes = s.file ? await s.file.arrayBuffer() : s.bytes; addSource(id, s.name, s.key, await decodeFile(actx, bytes, s.name)); } catch {}
      }));
      S.clips = p.clips.filter(c => sources.has(c.src));
      for (const k of await idbKeys()) if (String(k).startsWith('src:') && !need.includes(String(k).slice(4))) idbDel(k);
      render();
      if (S.clips.length) fit();
    }
  } catch {}
  render();
  window.__fc.ready = true;
})();
