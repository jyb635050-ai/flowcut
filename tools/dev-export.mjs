// 开发用：通过界面导入 A/B/C 并按指定格式导出，打印耗时与控制台输出。用法：node tools/dev-export.mjs opus
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('C:/Users/73405/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const SITE = path.resolve('site'), FIX = path.resolve('tools/.fixtures'), fmt = process.argv[2] || 'opus';
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html'; const f = path.join(SITE, u); if (fs.existsSync(f)) { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); } else { r.writeHead(404); r.end(); } }).listen(0);
await new Promise(r => srv.on('listening', r));
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await (await b.newContext({ acceptDownloads: true })).newPage();
const t0 = Date.now(); p.on('console', m => console.log(`[${Date.now() - t0}ms] C`, m.text())); p.on('pageerror', e => console.log('E', e.message));
await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForFunction(() => window.__fc && __fc.ready);
await p.setInputFiles('[data-testid=import]', ['A.mp3', 'B.flac', 'C.m4a'].map(f => path.join(FIX, f)));
await p.waitForFunction(() => document.querySelectorAll('[data-testid=clip][data-ready=true]').length === 3);
await p.evaluate(() => { const o = AudioEncoder.prototype.encode; window.__enc = 0; AudioEncoder.prototype.encode = function (...a) { window.__enc++; return o.apply(this, a); }; });
for (const fmt of (process.argv[2] || 'opus').split(',')) {
  if (!(await p.locator('[data-testid=format]').isVisible())) await p.click('[data-testid=export]');
  await p.selectOption('[data-testid=format]', fmt, { force: true });
  const s = Date.now();
  const iv = setInterval(async () => { try { console.log(`  [${fmt} ${Date.now() - s}ms]`, await p.evaluate(() => [document.querySelector('#progLabel').textContent, document.querySelector('#progress').getAttribute('aria-valuenow'), window.__enc])); } catch {} }, 3000);
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 300000 }), p.click('[data-testid=export-go]')]);
  clearInterval(iv); console.log('done', fmt, Date.now() - s, 'ms', d.suggestedFilename());
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
}
await b.close(); srv.close();
