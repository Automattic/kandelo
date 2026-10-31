/** Vite-served browser controller; avoids serializing transpiler closures. */
import { BrowserKernel } from '../host/src/browser-kernel-host';
import type { NodejsRun } from './nodejs-test-results';
export async function runNodejsBrowserCase({ origin, filename, flags, environment, timeout }: {
  origin: string; filename: string; flags: string[]; environment: string[]; timeout: number;
}): Promise<NodejsRun> {
  const start = performance.now();
  let stdout = '', stderr = '', timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stdoutDecoder = new TextDecoder(), stderrDecoder = new TextDecoder();
  const stdoutChunks: string[] = [], stderrChunks: string[] = [];
  function record(data: Uint8Array, chunks: string[]) {
    for (let offset = 0; offset < data.length; offset += 8192) {
      chunks.push(btoa(String.fromCharCode(...data.subarray(offset, offset + 8192))));
    }
  }
  const raw: NodejsRun = { exitCode: null, stdout: '', stderr: '', durationMs: 0 };
  const kernel = new BrowserKernel({
    onStdout: (data: Uint8Array) => { stdout += stdoutDecoder.decode(data, { stream: true }); record(data, stdoutChunks); },
    onStderr: (data: Uint8Array) => { stderr += stderrDecoder.decode(data, { stream: true }); record(data, stderrChunks); },
  });
  try {
    const exitCode = await Promise.race([
      (async () => { const image = new Uint8Array(await (await fetch(origin + 'suite.vfs')).arrayBuffer());
        await kernel.initFromImage({ vfsImage: image, lazyUrlBase: origin, lazyAssetDirectory: origin });
        const child = await kernel.spawnFromVfs('/usr/bin/node', ['node', ...flags, filename],
          { cwd: '/node-src', env: environment, stdin: new Uint8Array() }); return child.exit; })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Error('TIMEOUT')); }, timeout); }),
    ]);
    raw.exitCode = exitCode;
  } catch (error) {
    if (timedOut) raw.timeout = true;
    else raw.error = String(error);
  } finally {
    clearTimeout(timer);
    try { await kernel.destroy(); } catch (error) { raw.error = `Teardown failed: ${error}`; }
    raw.stdout = stdout + stdoutDecoder.decode(); raw.stderr = stderr + stderrDecoder.decode();
    raw.stdoutChunks = stdoutChunks; raw.stderrChunks = stderrChunks;
    raw.durationMs = Math.round(performance.now() - start);
  }
  return raw;
}
