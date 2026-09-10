import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/Users/brandon/kandelo-abi44-reconcile/apps/browser-demos/');
const { chromium, webkit } = require('playwright');

const types = { '.html': 'text/html', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = readFileSync(new URL('.' + p, import.meta.url));
    res.writeHead(200, {
      'Content-Type': types[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream',
      // Cross-origin isolation: SharedArrayBuffer does not exist without it,
      // and the whole question is what SubtleCrypto does with one.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(body);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const out = [];
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch();
  const row = { engine: name, version: browser.version() };
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => { row.pageerror = String(e.message); });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    Object.assign(row, await page.evaluate(() => window.__done));
  } catch (e) {
    row.harnessError = String(e).slice(0, 200);
  }
  await browser.close();
  out.push(row);
}
server.close();
console.log(JSON.stringify(out, null, 2));
