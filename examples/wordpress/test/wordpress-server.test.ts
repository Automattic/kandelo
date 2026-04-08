/**
 * WordPress HTTP server test — verifies that PHP's built-in server can
 * serve HTTP requests through the TCP bridge on wasm-posix-kernel.
 *
 * Requires:
 *   1. PHP binary: examples/libs/php/php-src/sapi/cli/php
 *      (build with: cd examples/libs/php && bash build.sh)
 *   2. WordPress files: examples/wordpress/wordpress/
 *      (download with: bash examples/wordpress/setup.sh)
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../../../host/src/kernel-worker";
import { NodePlatformIO } from "../../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../../host/src/worker-adapter";
import { ThreadPageAllocator } from "../../../host/src/thread-allocator";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../../host/src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const phpBinaryPath = join(repoRoot, "examples/libs/php/php-src/sapi/cli/php");
const kernelWasmPath = join(repoRoot, "host/wasm/wasm_posix_kernel.wasm");
const wpDir = join(dirname(__dirname), "wordpress");
const routerScript = join(dirname(__dirname), "router.php");

const PHP_AVAILABLE = existsSync(phpBinaryPath);
const WP_AVAILABLE = existsSync(join(wpDir, "wp-settings.php"));
const KERNEL_AVAILABLE = existsSync(kernelWasmPath);

const SKIP_REASON = !PHP_AVAILABLE
  ? "PHP binary not built"
  : !WP_AVAILABLE
    ? "WordPress not downloaded (run examples/wordpress/setup.sh)"
    : !KERNEL_AVAILABLE
      ? "Kernel wasm not built (run bash build.sh)"
      : "";

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;

function loadFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Find an available port by binding to 0 and reading the assigned port. */
async function getRandomPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe.skipIf(!!SKIP_REASON)("WordPress HTTP Server", () => {
  it("serves HTTP requests through the TCP bridge", async () => {
    const port = await getRandomPort();
    const kernelWasmBytes = loadFile(kernelWasmPath);
    const programBytes = loadFile(phpBinaryPath);
    const io = new NodePlatformIO();
    const workerAdapter = new NodeWorkerAdapter();

    let mainWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | null = null;
    const threadAllocator = new ThreadPageAllocator(MAX_PAGES, 3);
    let serverStderr = "";

    const kernelWorker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io,
      {
        onFork: async (parentPid, childPid, parentMemory) => {
          const parentBuf = new Uint8Array(parentMemory.buffer);
          const parentPages = Math.ceil(parentBuf.byteLength / 65536);
          const childMemory = new WebAssembly.Memory({
            initial: parentPages,
            maximum: MAX_PAGES,
            shared: true,
          });
          if (parentPages < MAX_PAGES) {
            childMemory.grow(MAX_PAGES - parentPages);
          }
          new Uint8Array(childMemory.buffer).set(parentBuf);
          const childChannelOffset = (MAX_PAGES - 2) * 65536;
          new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);
          kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
            skipKernelCreate: true,
          });
          const childInitData: CentralizedWorkerInitMessage = {
            type: "centralized_init",
            pid: childPid,
            ppid: parentPid,
            programBytes,
            memory: childMemory,
            channelOffset: childChannelOffset,
          };
          const childWorker = workerAdapter.createWorker(childInitData);
          childWorker.on("error", () => {
            kernelWorker.unregisterProcess(childPid);
          });
          return [childChannelOffset];
        },
        onExec: async () => -38,
        onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
          const alloc = threadAllocator.allocate(memory);
          kernelWorker.addChannel(pid, alloc.channelOffset, tid);
          const threadInitData: CentralizedThreadInitMessage = {
            type: "centralized_thread_init",
            pid,
            tid,
            programBytes,
            memory,
            channelOffset: alloc.channelOffset,
            fnPtr,
            argPtr,
            stackPtr,
            tlsPtr,
            ctidPtr,
            tlsAllocAddr: alloc.tlsAllocAddr,
          };
          const threadWorker = workerAdapter.createWorker(threadInitData);
          threadWorker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "thread_exit") {
              threadAllocator.free(alloc.basePage);
              threadWorker.terminate().catch(() => {});
            }
          });
          threadWorker.on("error", () => {
            kernelWorker.notifyThreadExit(pid, tid);
            kernelWorker.removeChannel(pid, alloc.channelOffset);
            threadAllocator.free(alloc.basePage);
          });
          return tid;
        },
        onExit: (pid, exitStatus) => {
          if (pid === 1) {
            kernelWorker.unregisterProcess(pid);
            if (mainWorker) mainWorker.terminate().catch(() => {});
          } else {
            kernelWorker.deactivateProcess(pid);
          }
        },
      },
    );

    kernelWorker.setOutputCallbacks({
      onStderr: (data: Uint8Array) => {
        serverStderr += new TextDecoder().decode(data);
      },
    });

    await kernelWorker.init(kernelWasmBytes);

    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: MAX_PAGES,
      shared: true,
    });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes,
      memory,
      channelOffset,
      env: ["HOME=/tmp", "TMPDIR=/tmp"],
      argv: ["php", "-S", `0.0.0.0:${port}`, "-t", wpDir, routerScript],
    };

    mainWorker = workerAdapter.createWorker(initData);

    // Wait for PHP's built-in server to print its startup message
    const startupTimeout = 30_000;
    const startTime = Date.now();
    while (!serverStderr.includes("Development Server") && Date.now() - startTime < startupTimeout) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // Give the server a moment to be fully ready after printing startup message
    await new Promise((r) => setTimeout(r, 500));

    // Make an HTTP request
    let response: Response | null = null;
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    expect(response).not.toBeNull();
    if (response) {
      const body = await response.text();
      // WordPress should return some HTML (install page, login page, etc.)
      expect(body.length).toBeGreaterThan(0);
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);
    }

    // Clean up server after reading response
    if (mainWorker) {
      mainWorker.terminate().catch(() => {});
    }
  }, 120_000);
});
