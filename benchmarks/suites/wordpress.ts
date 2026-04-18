/**
 * Suite 2: WordPress
 *
 * Two measurements:
 *   cli_require_ms         — php -r "require 'wp-load.php';" (process start to exit)
 *   http_first_response_ms — Start PHP built-in server, time to first HTTP response
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker.js";
import { NodePlatformIO } from "../../host/src/platform/node.js";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter.js";
import type { CentralizedWorkerInitMessage } from "../../host/src/worker-protocol.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const phpBinaryPath = resolve(repoRoot, "examples/libs/php/php-src/sapi/cli/php");
const wpDir = resolve(repoRoot, "examples/wordpress/wordpress");
const kernelWasmPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");
const routerScript = resolve(repoRoot, "examples/wordpress/router.php");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function hasPrereqs(): boolean {
  return existsSync(phpBinaryPath) && existsSync(join(wpDir, "wp-settings.php"));
}

async function measureCliRequire(): Promise<number> {
  const t0 = performance.now();
  const result = await runCentralizedProgram({
    programPath: phpBinaryPath,
    argv: ["php", "-r", `chdir('${wpDir}'); require 'wp-load.php';`],
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
    timeout: 120_000,
  });
  const t1 = performance.now();
  if (result.exitCode !== 0) {
    throw new Error(`PHP wp-load.php failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return t1 - t0;
}

async function measureHttpFirstResponse(): Promise<number> {
  const port = 19400 + Math.floor(Math.random() * 100);
  const kernelBytes = loadBytes(kernelWasmPath);
  const programBytes = loadBytes(phpBinaryPath);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

  let serverStarted = false;
  let stderr = "";

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
    io,
    {
      onFork: async (parentPid, childPid, parentMemory) => {
        const parentBuf = new Uint8Array(parentMemory.buffer);
        const parentPages = Math.ceil(parentBuf.byteLength / 65536);
        const childMemory = new WebAssembly.Memory({
          initial: parentPages, maximum: MAX_PAGES, shared: true,
        });
        if (parentPages < MAX_PAGES) childMemory.grow(MAX_PAGES - parentPages);
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = (MAX_PAGES - 2) * 65536;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);
        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

        const ASYNCIFY_BUF_SIZE = 16384;
        const childWorker = workerAdapter.createWorker({
          type: "centralized_init",
          pid: childPid, ppid: parentPid,
          programBytes,
          memory: childMemory,
          channelOffset: childChannelOffset,
          isForkChild: true,
          asyncifyBufAddr: childChannelOffset - ASYNCIFY_BUF_SIZE,
        } as CentralizedWorkerInitMessage);
        workers.set(childPid, childWorker);
        childWorker.on("error", () => {
          kernelWorker.unregisterProcess(childPid);
          workers.delete(childPid);
        });
        return [childChannelOffset];
      },
      onExec: async () => -38,
      onExit: (pid, exitStatus) => {
        if (pid === 1) {
          kernelWorker.unregisterProcess(pid);
        } else {
          kernelWorker.deactivateProcess(pid);
        }
        workers.delete(pid);
      },
    },
  );

  await kernelWorker.init(kernelBytes);

  const decoder = new TextDecoder();
  kernelWorker.setOutputCallbacks({
    onStdout: () => {},
    onStderr: (data) => {
      stderr += decoder.decode(data);
      if (stderr.includes("Development Server")) serverStarted = true;
    },
  });

  const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
  const channelOffset = (MAX_PAGES - 2) * 65536;
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(1, memory, [channelOffset]);
  kernelWorker.setCwd(1, wpDir);
  kernelWorker.setNextChildPid(2);

  const t0 = performance.now();

  const mainWorker = workerAdapter.createWorker({
    type: "centralized_init",
    pid: 1, ppid: 0,
    programBytes,
    memory,
    channelOffset,
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
    argv: ["php", "-S", `0.0.0.0:${port}`, "-t", wpDir, routerScript],
  } as CentralizedWorkerInitMessage);
  workers.set(1, mainWorker);

  // Wait for server startup (PHP prints "Development Server started" to stderr)
  const startDeadline = Date.now() + 60_000;
  while (!serverStarted && Date.now() < startDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!serverStarted) {
    for (const [, w] of workers) await w.terminate().catch(() => {});
    throw new Error("PHP server did not start within 60s");
  }

  // Poll for first complete HTTP response (WordPress first page load is slow)
  let firstResponseMs = -1;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (resp.status > 0) {
        await resp.text();
        firstResponseMs = performance.now() - t0;
        break;
      }
    } catch {
      // Not ready yet — retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Cleanup
  for (const [, w] of workers) await w.terminate().catch(() => {});

  if (firstResponseMs < 0) {
    throw new Error("Timed out waiting for WordPress HTTP response");
  }

  return firstResponseMs;
}

const suite: BenchmarkSuite = {
  name: "wordpress",

  async run(): Promise<Record<string, number>> {
    if (!hasPrereqs()) {
      console.warn("  Skipping (PHP or WordPress not found)");
      return {};
    }

    const results: Record<string, number> = {};
    results.cli_require_ms = await measureCliRequire();
    results.http_first_response_ms = await measureHttpFirstResponse();
    return results;
  },
};

export default suite;
