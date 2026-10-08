// 开发用：单独量 Opus 导出（WebCodecs 路径）耗时
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('C:/Users/73405/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const SITE = path.resolve('site');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html'; const f = path.join(SITE, u); if (fs.existsSync(f)) { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); } else { r.writeHead(404); r.end(); } }).listen(0);
await new Promise(r => srv.on('listening', r));
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const p = await b.newPage(); p.on('console', m => console.log('C', m.text())); p.on('pageerror', e => console.log('E', e.message));
await p.goto(`http://127.0.0.1:${srv.address().port}/`);
const r = await p.evaluate(async () => {
  const { encodeOpus } = await import('./js/codec.js');
  const oac = new OfflineAudioContext(2, 48000 * 20, 48000); const o = oac.createOscillator(); o.connect(oac.destination); o.start();
  const buf = await oac.startRendering(); const t0 = performance.now(); const log = [];
  const out = await encodeOpus(buf, 192, p => log.push([Math.round(performance.now() - t0), p.toFixed(2)]));
  return { ms: Math.round(performance.now() - t0), size: out.length, log: log.slice(0, 5) };
});
console.log(r); await b.close(); srv.close();
