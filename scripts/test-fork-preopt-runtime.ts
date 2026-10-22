/** Execute the SDK fork/jump fixture with and without pre-inlining on both hosts.
 * Usage: node --experimental-wasm-exnref --import tsx scripts/test-fork-preopt-runtime.ts normal.wasm inlined.wasm
 * Build the two inputs from crates/fork-instrument/tests/fixtures/preopt/fork-jump.c.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { KandeloImageFs } from '../images/vfs/lib/kandelo-image-fs.ts';
import { ensureDirRecursive, writeVfsBinary } from '../host/src/vfs/image-helpers.ts';
import { runCentralizedProgram } from '../host/test/centralized-test-helper.ts';
import { resolveBinary, tryResolveBinary } from '../host/src/binary-resolver.ts';

const programs = process.argv.slice(2).map(p => resolve(p));
assert.equal(programs.length, 2, 'provide the normal and pre-inlined fixture Wasm paths');
const images: Uint8Array[] = [];
for (const program of programs) {
  const fs = KandeloImageFs.create();
  for (const path of ['/bench', '/tmp', '/home', '/dev']) ensureDirRecursive(fs, path);
  fs.chmod('/tmp', 0o1777);
  writeVfsBinary(fs, '/bench/program', new Uint8Array(readFileSync(program)), 0o755);
  images.push(new Uint8Array(await fs.saveImage()));
}

function check(result: { exitCode: number; stdout: string; forkCounts: string[] }) {
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stdout.trim(), 'DONE', JSON.stringify(result));
  assert(result.forkCounts.some(count => BigInt(count) > 0n), 'no actual kernel fork was observed');
}

for (let index = 0; index < programs.length; index++) {
  const result = await runCentralizedProgram({
    programPath: programs[index], argv: ['/bench/program'], rootfsImage: images[index],
    env: ['HOME=/home', 'TMPDIR=/tmp'], captureForkCount: true, timeout: 30_000,
  });
  const row = { host: 'Node', variant: index === 0 ? 'normal' : 'pre-inlined',
    exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
    forkCounts: result.forkCountSamples?.map(String) ?? [] };
  check(row);
  console.log(JSON.stringify(row));
}

const kernel = resolveBinary('kernel.wasm');
const root = process.cwd();
const entry = '/preopt-runtime.ts';
const source = `
import { BrowserKernel } from ${JSON.stringify('/@fs' + resolve(root, 'host/src/browser-kernel-host.ts'))};
window.preoptRun = async index => {
  const kernelBytes = await fetch('/kernel.wasm').then(r => r.arrayBuffer());
  const image = await fetch('/input-' + index + '.vfs').then(r => r.arrayBuffer());
  let stdout = '', stderr = '', rootPid;
  const counts = [];
  const kernel = new BrowserKernel({kernelOwnedFs:true,maxWorkers:4,
    onStdout:b=>stdout+=new TextDecoder().decode(b),
    onStderr:b=>stderr+=new TextDecoder().decode(b),
    onProcessEvent:e=>{if(e.kind!=='spawn')return;if(rootPid===undefined)rootPid=e.pid;else counts.push(kernel.getForkCount(rootPid));}
  });
  try {
    const {exit} = await kernel.boot({kernelWasm:kernelBytes,vfsImage:new Uint8Array(image),
      argv:['/bench/program'],cwd:'/bench',env:['HOME=/home','TMPDIR=/tmp'],uid:0,gid:0});
    return {exitCode:await exit,stdout,stderr,forkCounts:(await Promise.all(counts)).map(String)};
  } finally { await kernel.destroy(); }
};
`;
const server = await createServer({
  configFile: false, root,
  // The only entry is virtual. Do not crawl unrelated demo HTML in the repo.
  optimizeDeps: { entries: [] },
  plugins: [{ name: 'fork-preopt-runtime', enforce: 'pre',
    resolveId(id) {
      if (id === entry) return '\0fork-preopt-runtime';
      if (id.startsWith('@kernel-wasm')) return kernel + id.slice('@kernel-wasm'.length);
      if (id.startsWith('@rootfs-vfs')) return (tryResolveBinary('rootfs.vfs.zst') ?? resolveBinary('programs/rootfs.vfs.zst')) + id.slice('@rootfs-vfs'.length);
    },
    load(id) { if (id === '\0fork-preopt-runtime') return source; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        const path = req.url?.split('?')[0];
        if (path === '/') {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>Fork pre-inlining runtime check</title><script type="module" src="' + entry + '"></script>');
        } else if (path === '/kernel.wasm') {
          res.setHeader('Content-Type', 'application/wasm'); res.end(readFileSync(kernel));
        } else if (path === '/input-0.vfs' || path === '/input-1.vfs') {
          res.end(images[path === '/input-0.vfs' ? 0 : 1]);
        } else next();
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
});
try {
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForFunction(() => typeof (window as any).preoptRun === 'function');
    for (let index = 0; index < programs.length; index++) {
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        page.evaluate(index => (window as any).preoptRun(index), index),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser fork/jump fixture timed out')), 30_000); }),
      ]).finally(() => clearTimeout(timer!));
      check(result);
      console.log(JSON.stringify({ host: 'Chromium', variant: index === 0 ? 'normal' : 'pre-inlined', ...result }));
    }
  } finally { await browser.close(); }
} finally { await server.close(); }
