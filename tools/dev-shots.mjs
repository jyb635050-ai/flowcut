// 开发用：导入示例、做几步编辑，截深/浅色和手机图到 shots/
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('C:/Users/73405/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const SITE = path.resolve('site'), FIX = path.resolve('tools/.fixtures'), files = process.argv.slice(2);
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html'; const f = path.join(SITE, u); if (fs.existsSync(f)) { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); } else { r.writeHead(404); r.end(); } }).listen(0);
await new Promise(r => srv.on('listening', r));
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const src = files.length ? files : ['A.mp3', 'B.flac', 'C.m4a'].map(f => path.join(FIX, f));
for (const [scheme, vp, name] of [['light', { width: 1440, height: 900 }, 'light'], ['dark', { width: 1440, height: 900 }, 'dark'], ['light', { width: 390, height: 844 }, 'mobile'], ['dark', { width: 1280, height: 720 }, 'empty']]) {
  const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: name === 'mobile' ? 2 : 1 });
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('E', e.message)); p.on('console', m => m.type() === 'error' && console.log('C', m.text()));
  await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForFunction(() => window.__fc && __fc.ready);
  if (name !== 'empty') {
    await p.setInputFiles('[data-testid=import]', src);
    await p.waitForFunction(n => document.querySelectorAll('[data-testid=clip][data-ready=true]').length === n, src.length);
    const c = p.locator('[data-testid=clip]').nth(1); const bb = await c.boundingBox(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await p.fill('[data-testid=fade-in]', '1.5'); await p.press('[data-testid=fade-in]', 'Enter');
    await p.fill('[data-testid=xfade]', '1'); await p.press('[data-testid=xfade]', 'Enter');
    await p.evaluate(() => { document.activeElement.blur(); __fc.seek(5.2); });
  }
  await p.waitForTimeout(600);
  await p.screenshot({ path: `shots/dev-${name}.png` });
  if (name === 'light') {
    console.log(await p.evaluate(() => getComputedStyle(document.querySelector('.bar')).backdropFilter));
    await p.click('[data-testid=export]'); await p.waitForTimeout(800); await p.screenshot({ path: 'shots/dev-export.png' });
  }
  await ctx.close();
}
await b.close(); srv.close();
