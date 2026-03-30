/**
 * Regression test — nginx serving static HTML via wasm-posix-kernel.
 *
 * Starts nginx.wasm in centralized mode with master_process on + 2 workers,
 * sends HTTP requests through the TCP bridge, verifies responses, and tears down.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import type {
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "../src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;
const ASYNCIFY_BUF_SIZE = 16384;

const nginxWasmPath = join(repoRoot, "examples/nginx/nginx.wasm");
const nginxPrefix = join(repoRoot, "examples/nginx");
const nginxConf = join(repoRoot, "examples/nginx/nginx.conf");

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Send a raw HTTP request and return the full response. */
function httpGet(
  port: number,
  path: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("HTTP request timed out")),
      timeoutMs,
    );
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(`GET ${path} HTTP/1.0\r\nHost: localhost\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (chunk) => (data += chunk.toString()));
    sock.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe.skipIf(!existsSync(nginxWasmPath))(
  "nginx static file serving",
  () => {
    it("serves index.html via HTTP on port 8080", async () => {
      const kernelBytes = loadWasm(join(__dirname, "../wasm/wasm_posix_kernel.wasm"));
      const programBytes = loadWasm(nginxWasmPath);
      const workerAdapter = new NodeWorkerAdapter();
      const io = new NodePlatformIO();

      const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
      let resolveExit: (status: number) => void;
      const exitPromise = new Promise<number>((r) => (resolveExit = r));

      const kw = new CentralizedKernelWorker(
        { maxWorkers: 8, dataBufferSize: 65536, useSharedMemory: true },
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

            kw.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

            const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
            const childInitData: CentralizedWorkerInitMessage = {
              type: "centralized_init",
              pid: childPid,
              ppid: parentPid,
              programBytes,
              memory: childMemory,
              channelOffset: childChannelOffset,
              isForkChild: true,
              asyncifyBufAddr,
            };

            const childWorker = workerAdapter.createWorker(childInitData);
            workers.set(childPid, childWorker);
            childWorker.on("error", () => {
              kw.unregisterProcess(childPid);
              workers.delete(childPid);
            });

            return [childChannelOffset];
          },
          onExec: async () => -38,
          onExit: (pid, status) => {
            if (pid === 1) {
              kw.unregisterProcess(pid);
              resolveExit!(status);
            } else {
              kw.deactivateProcess(pid);
            }
            workers.delete(pid);
          },
        },
      );

      await kw.init(kernelBytes);

      // Create process memory for master
      const memory = new WebAssembly.Memory({
        initial: 17,
        maximum: MAX_PAGES,
        shared: true,
      });
      const channelOffset = (MAX_PAGES - 2) * 65536;
      memory.grow(MAX_PAGES - 17);
      new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

      kw.registerProcess(1, memory, [channelOffset]);
      kw.setCwd(1, nginxPrefix);
      kw.setNextChildPid(2);

      const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid: 1,
        ppid: 0,
        programBytes,
        memory,
        channelOffset,
        env: ["HOME=/tmp", "PATH=/usr/bin"],
        argv: ["nginx", "-p", nginxPrefix + "/", "-c", nginxConf],
      };

      const masterWorker = workerAdapter.createWorker(initData);
      workers.set(1, masterWorker);
      masterWorker.on("error", () => {});

      // Wait for the TCP listener to be ready (poll until port 8080 accepts)
      let ready = false;
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          await httpGet(8080, "/", 1000);
          ready = true;
          break;
        } catch {
          // not ready yet
        }
      }

      try {
        expect(ready).toBe(true);

        // Actual test: request the static page
        const resp = await httpGet(8080, "/");
        expect(resp).toContain("HTTP/1.1 200 OK");
        expect(resp).toContain("Server: nginx");
        expect(resp).toContain("Hello from nginx on WebAssembly!");

        // Request a non-existent path → 404
        const resp404 = await httpGet(8080, "/nonexistent");
        expect(resp404).toContain("404");
      } finally {
        // Tear down all workers
        for (const [pid, w] of workers) {
          await w.terminate().catch(() => {});
          kw.unregisterProcess(pid);
        }
        workers.clear();
      }
    }, 60_000);
  },
);
