import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { NodeKernelHost } from '../host/src/node-kernel-host';
import { resolveBinary } from '../host/src/binary-resolver';
import { type NodejsTestDescriptor, nodejsTarget, repoRoot, fileHash } from './nodejs-source-helper';
import { type NodejsRun } from './nodejs-test-results';
import { testFlags } from './nodejs-native-runner';

export type GuestHost = 'node' | 'chromium' | 'firefox' | 'webkit';
export interface NodejsGuestRunner { identity: Record<string, unknown>; run(test: NodejsTestDescriptor, timeout: number): Promise<NodejsRun>; close(): Promise<void> }
export function unsupportedGuestRequirements(test: NodejsTestDescriptor) {
  if (test.rlimitAs !== undefined) return 'RLIMIT_AS test launcher is not implemented';
  const flags = testFlags(test);
  return flags.length ? 'Guest CLI has no verified mapping for required flags: ' + flags.join(' ') : undefined;
}

const env = (test: NodejsTestDescriptor) => Object.entries({
  HOME: '/tmp', TMPDIR: '/tmp', NODE_TEST_DIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin',
  TERM: 'dumb', TZ: 'UTC', LC_ALL: 'C', NODE_DISABLE_COLORS: '1', ...test.env,
}).map(([key, value]) => `${key}=${value}`);

export async function createNodejsGuestRunner(hostKind: GuestHost, imagePath: string): Promise<NodejsGuestRunner> {
  const assets = [
    { guest: 'assets/programs/wasm32/node.zip', path: resolveBinary('programs/wasm32/node.zip') },
    { guest: 'assets/programs/wasm32/coreutils.wasm', path: resolveBinary('programs/coreutils.wasm') },
  ].map(item => ({ ...item, sha256: fileHash(item.path) }));
  const identity = { host: hostKind, imageSha256: fileHash(imagePath),
    kernelSha256: fileHash(resolveBinary('kernel.wasm')), assets: assets.map(({ guest, sha256 }) => ({ guest, sha256 })) };
  const bytes = new Uint8Array(readFileSync(imagePath));
  const base = 'https://nodejs-tests.kandelo.invalid/';
  if (hostKind === 'node') {
    return { identity, async close() {}, async run(test, timeout) {
      let stdout = '', stderr = '', timer: ReturnType<typeof setTimeout> | undefined;
      const stdoutDecoder = new TextDecoder(), stderrDecoder = new TextDecoder();
      const stdoutChunks: string[] = [], stderrChunks: string[] = [];
      let timedOut = false;
      const start = performance.now();
      const host = new NodeKernelHost({ rootfsImage: bytes, rootfsLazyUrlBase: base, rootfsLazyAssetDirectory: base,
        rootfsLazyAssets: assets.map(item => { const data = new Uint8Array(readFileSync(item.path));
          return { url: base + item.guest, bytes: data, size: data.byteLength, sha256: item.sha256 }; }),
        onStdout: (_pid, data) => { stdout += stdoutDecoder.decode(data, { stream: true }); stdoutChunks.push(Buffer.from(data).toString('base64')); },
        onStderr: (_pid, data) => { stderr += stderrDecoder.decode(data, { stream: true }); stderrChunks.push(Buffer.from(data).toString('base64')); } });
      const raw: NodejsRun = { exitCode: null, stdout: '', stderr: '', durationMs: 0 };
      try {
        const exitCode = await Promise.race([
          (async () => { await host.init(); const child = await host.spawnFromVfs('/usr/bin/node', ['node', ...testFlags(test), test.vfsPath],
            { cwd: '/node-src', env: env(test), stdin: new Uint8Array() }); return child.exit; })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Error('TIMEOUT')); }, timeout); }),
        ]);
        raw.exitCode = exitCode;
      } catch (error) {
        if (timedOut) raw.timeout = true;
        else raw.error = String(error);
      } finally {
        clearTimeout(timer);
        try { await host.destroy(); } catch (error) { raw.error = `Teardown failed: ${error}`; }
        raw.stdout = stdout + stdoutDecoder.decode(); raw.stderr = stderr + stderrDecoder.decode();
        raw.stdoutChunks = stdoutChunks; raw.stderrChunks = stderrChunks;
        raw.durationMs = Math.round(performance.now() - start);
      }
      return raw;
    } };
  }

  // Serve immutable run inputs at a private loopback origin. Vite supplies the
  // normal host modules/workers; it does not rebuild package products here.
  const server = createServer((req, res) => {
    const requested = req.url?.slice(1);
    const file = requested === 'suite.vfs' ? imagePath : assets.find(item => item.guest === requested)?.path;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (!file) { res.writeHead(404); res.end(); return; }
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}/`;
  let vite: ChildProcess | undefined, browser: Browser | undefined, page: Page | undefined;
  try {
    const reserve = createNetServer();
    await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
    const port = (reserve.address() as any).port;
    await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
    vite = spawn(join(repoRoot, 'apps/browser-demos/node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: join(repoRoot, 'apps/browser-demos'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KANDELO_BROWSER_TEST_NO_HMR: '1' } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Vite startup timeout')), 60_000);
      vite!.once('error', reject);
      vite!.once('exit', code => { clearTimeout(timer); reject(Error(`Vite exited ${code}`)); });
      const ready = (chunk: Buffer) => { if (chunk.toString().includes('Local:')) { clearTimeout(timer); resolve(); } };
      vite!.stdout!.on('data', ready); vite!.stderr!.on('data', ready);
    });
    const { default: config } = await import('../apps/browser-demos/playwright.config');
    const launchOptions = config.projects?.find(project => project.name === hostKind)?.use?.launchOptions;
    browser = await ({ chromium, firefox, webkit })[hostKind].launch(launchOptions);
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/pages/test-runner/`);
    const run = async (test: NodejsTestDescriptor, timeout: number): Promise<NodejsRun> => {
      return page!.evaluate(async request =>
        (await import(/* @vite-ignore */ request.runnerUrl)).runNodejsBrowserCase(request),
        { origin, filename: test.vfsPath, flags: testFlags(test), environment: env(test), timeout,
          runnerUrl: '/@fs/' + join(repoRoot, 'scripts/nodejs-browser-runner.ts') });
    };
    return { identity: { ...identity, browserVersion: browser.version() }, run, async close() {
      await browser!.close(); vite!.kill('SIGTERM'); server.close();
    } };
  } catch (error) { await browser?.close(); vite?.kill('SIGTERM'); server.close(); throw error; }
}
