import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/Users/brandon/kandelo-abi44-reconcile/apps/browser-demos/');
const { chromium, webkit } = require('playwright');

const types = { '.html':'text/html', '.js':'text/javascript', '.wasm':'application/wasm' };
const server = http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = readFileSync(new URL('.' + p, import.meta.url));
    res.writeHead(200, {
      'Content-Type': types[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream',
      // Cross-origin isolation: required for SharedArrayBuffer, and the
      // configuration the real demo ships under.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(body);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch();
  const out = { engine: name };
  try {
    out.version = browser.version();
    const page = await browser.newPage();
    const crashes = [];
    page.on('crash', () => crashes.push('PAGE CRASHED'));
    page.on('pageerror', (e) => crashes.push('pageerror: ' + e.message));
    await page.goto(base, { waitUntil: 'load' });
    out.mainThread = await page.evaluate(() => window.__done);
    const wp = await browser.newPage();
    wp.on('crash', () => crashes.push('WORKER PAGE CRASHED'));
    wp.on('pageerror', (e) => crashes.push('pageerror: ' + e.message));
    await wp.goto(base + 'worker-page.html', { waitUntil: 'load' });
    out.inDedicatedWorker = await wp.evaluate(() => window.__done);
    out.crashes = crashes;
  } catch (e) {
    out.fatal = String(e && e.message || e);
  } finally { await browser.close(); }
  console.log(JSON.stringify(out, null, 1));
}
server.close();
