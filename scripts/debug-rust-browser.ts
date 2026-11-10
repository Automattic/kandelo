#!/usr/bin/env -S npx tsx
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '../apps/browser-demos/node_modules/playwright/index.mjs';
import { createRustDebugSession } from './lib/rust-debug-session';
import { ChromiumWorkerDebugger } from './lib/chromium-worker-debugger';
import { SILENT_AUDIO_INIT_SCRIPT } from '../apps/browser-demos/playwright-audio';

const usage = 'scripts/dev-shell.sh npx tsx scripts/debug-rust-browser.ts PROGRAM.wasm --url http://127.0.0.1:PORT --break FILE:LINE [--commands next,where,continue] [--image IMAGE.vfs] [--kernel KERNEL.wasm] [-- ARGS...]';
const args = process.argv.slice(2), program = args.shift();
if (!program || program === '--help') { console.log(usage); process.exit(program ? 0 : 2); }
let url: string | undefined, breakpoint: string | undefined, image: string | undefined, kernel: string | undefined, commands: string[] | undefined;
let guestArgs: string[] = [];
while (args.length) {
  const option = args.shift()!;
  if (option === '--') { guestArgs = args.splice(0); break; }
  const value = args.shift();
  if (!value) throw new Error(`${option} needs a value\n${usage}`);
  if (option === '--url') url = value;
  else if (option === '--break') breakpoint = value;
  else if (option === '--image') image = value;
  else if (option === '--kernel') kernel = value;
  else if (option === '--commands') commands = value.split(',');
  else throw new Error(`unknown option ${option}\n${usage}`);
}
if (!url || !breakpoint) throw new Error(`--url and --break are required\n${usage}`);
const base = new URL(url);
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('--url must identify the local Kandelo development server');
}
if (commands?.some(value => !['next','n','where','bt','continue','c','quit','q'].includes(value))) throw new Error('unknown scripted debugger command');
if (statSync(program).size > 256 * 1024 ** 2) throw new Error('debug module exceeds 256 MiB');
const bytes = new Uint8Array(readFileSync(program));
let quitting = false, cancel!: (error: Error) => void;
const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
void cancelled.catch(() => {});
const stop = () => { quitting = true; cancel(new Error('debug session cancelled')); };
const debug = createRustDebugSession(bytes, breakpoint, commands, stop);
// Serve only the artifacts explicitly selected on this command line. Source
// names in debug metadata never select files on the embedding computer.
const files = new Map<string,string>([['/program.wasm', resolve(program)]]);
if (image) files.set('/image.vfs', resolve(image));
if (kernel) files.set('/kernel.wasm', resolve(kernel));
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', base.origin);
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const path = files.get(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  if (!path || !['GET','HEAD'].includes(request.method ?? '')) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type':'application/octet-stream', 'Content-Length':statSync(path).size });
  if (request.method === 'HEAD') response.end();
  else {
    const stream = createReadStream(path);
    stream.on('error', error => response.destroy(error));
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
let transport: ChromiumWorkerDebugger | undefined;
const interrupt = stop;
process.once('SIGINT', interrupt);
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('debug asset server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless:true, args:['--js-flags=--experimental-wasm-exnref'] });
  page = await browser.newPage();
  if (process.env.KANDELO_PLAYWRIGHT_AUDIBLE_AUDIO !== '1') await page.addInitScript({content:SILENT_AUDIO_INIT_SCRIPT});
  await page.exposeFunction('__rustDebugOutput', (stream: 'stdout'|'stderr', text: string) => { process[stream].write(text); });
  await page.goto(new URL('trap-signal-test.html', base).href);
  transport = new ChromiumWorkerDebugger(await page.context().newCDPSession(page), debug.callbacks);
  await transport.start();
  process.stderr.write(`debugging Chromium ${debug.expected}; ${debug.locations.length} source breakpoint location(s)\n`);
  const moduleUrl = new URL('/@fs/'+fileURLToPath(new URL('./lib/rust-browser-debuggee.ts',import.meta.url)),base).href;
  const exit = await Promise.race([page.evaluate(async options => {
    const {runRustBrowserDebuggee} = await import(options.moduleUrl);
    return runRustBrowserDebuggee(options);
  }, {moduleUrl,origin,image:!!image,kernel:!!kernel,argv:[program,...guestArgs],env:['PATH=/usr/bin:/bin','HOME=/home/maker',`RUST_BACKTRACE=${process.env.RUST_BACKTRACE ?? '1'}`]}), transport.failure, cancelled]);
  if (!debug.wasHit) throw new Error('program exited without hitting the requested source breakpoint');
  process.stderr.write(`guest exited ${exit}\n`); process.exitCode = exit;
} catch (error) {
  if (quitting) process.exitCode = 130;
  else throw error;
} finally {
  try { await transport?.close(); }
  finally {
    debug.close(); process.off('SIGINT',interrupt);
    try {
      if (page && !page.isClosed()) await page.evaluate(async moduleUrl => {
        const {destroyRustBrowserDebuggee} = await import(moduleUrl);
        await destroyRustBrowserDebuggee();
      }, new URL('/@fs/'+fileURLToPath(new URL('./lib/rust-browser-debuggee.ts',import.meta.url)),base).href);
    } finally {
      try { await browser?.close(); }
      finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  }
}
