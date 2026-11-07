import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { NativeWindowObserver, ownedProcessFamily, type WindowObserver } from './native-observer-client.js';
import { HeadlessWindowObserver } from './headless-window-observer.js';
import { responseControlScript } from './response-control-page.js';
import { measureResponseRoi } from './response-roi-experiment.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = process.env.KPERF_CURSOR_CONTROL_OUT;
assert(out, 'KPERF_CURSOR_CONTROL_OUT must name a private output directory');
const native = process.env.KPERF_CURSOR_OBSERVER === 'native';
assert(['native', 'headless'].includes(process.env.KPERF_CURSOR_OBSERVER ?? ''));
const engines = (process.env.KPERF_NATIVE_ENGINES ?? 'chromium,firefox,webkit').split(',');
assert(engines.length && new Set(engines).size === engines.length && engines.every(e => ['chromium', 'firefox', 'webkit'].includes(e)));
const count = Number(process.env.KPERF_CURSOR_SAMPLES ?? '60');
assert(Number.isInteger(count) && count >= 4 && count <= 120);
const pw = await import(pathToFileURL(join(root, 'apps/browser-demos/node_modules/@playwright/test/index.mjs')).href);
const fault=process.env.KPERF_RESPONSE_FAULT;assert(fault===undefined||fault==='source-error'||fault==='wrong-response','Unknown response source fault');
let failed = false;
for (const engine of engines) for (const mode of ['dom', 'offscreen'] as const) {
  const dir = join(out, engine, mode); mkdirSync(dir, { recursive: true });
  let server: any, browser: any, context: any, page: any, observer: WindowObserver | undefined, closed = false;
  const sourceErrors: string[] = [];
  try {
    const profile = mkdtempSync(join(dir, 'profile-'));
    // Match the browser gate's test-launcher profile isolation on macOS.
    server = await pw[engine].launchServer({ headless: !native,
      ...(engine === 'chromium' ? { channel: 'chromium' } : {}),
      ...(engine === 'firefox' ? { env: { ...process.env, CFFIXED_USER_HOME: profile } } : {}) });
    browser = await pw[engine].connect(server.wsEndpoint());
    context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    page = await context.newPage(); page.on('pageerror', (e: Error) => sourceErrors.push(e.message));
    const title = `KandeloCursorObserver-${randomUUID()}`;
    await page.goto('data:text/html,' + encodeURIComponent(`<title>${title}</title>`));
    await page.evaluate(responseControlScript(mode));
    if (native) await page.bringToFront();
    await page.screenshot({ path: join(dir, 'startup.png') });
    if (native) {
      const owners = ownedProcessFamily(server.process().pid);
      writeFileSync(join(dir, 'browser-owners.json'), JSON.stringify(owners));
      observer = new NativeWindowObserver(join(resolve(out), 'window-capture'), title, owners, 'points','response-roi');
    } else observer = new HeadlessWindowObserver(page, join(resolve(out), 'pixel-matcher-offline'),true);
    const result=await measureResponseRoi({page,observer,out:dir,count,native,label:`${engine}-${mode}`,sourceErrors,
      fault:fault as any});
    Object.assign(result,{engine,mode,version:browser.version()});
    await observer.close(); closed = true;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ engine, mode, native, responses: result.matchedResponses, noOp: true, delayed: 'pass' }));
  } catch (error) {
    failed = true;
    const inputs = page && !page.isClosed() ? await page.evaluate(() => (globalThis as any).roiInputs).catch(() => 'unavailable') : 'unavailable';
    writeFileSync(join(dir, 'failure.json'), JSON.stringify({ error: String((error as Error).stack ?? error), inputs, sourceErrors }, null, 2));
    console.error(engine, mode, String(error));
  } finally {
    if (observer && !closed) { try { await observer.close(); } catch (e) { writeFileSync(join(dir, 'cleanup-error.txt'), String(e)); } }
    if (observer) writeFileSync(join(dir, 'observer-rows.json'), JSON.stringify(observer.stream.rows));
    if (observer instanceof NativeWindowObserver) writeFileSync(join(dir, 'native-stderr.txt'), observer.stderr);
    if (context) await context.close(); if (browser) await browser.close(); if (server) await server.close();
  }
}
if (failed) process.exitCode = 1;
