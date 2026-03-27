#!/usr/bin/env node --experimental-strip-types
/**
 * WordPress HTTP Server — serves WordPress via PHP's built-in server
 * running on wasm-posix-kernel with real TCP connections bridged in.
 *
 * Usage:
 *   node --experimental-strip-types examples/wordpress/serve.ts [port]
 *
 * Requires:
 *   1. PHP binary: examples/libs/php/php-src/sapi/cli/php
 *      (build with: cd examples/libs/php && bash build.sh)
 *   2. WordPress files: examples/wordpress/wordpress/
 *      (download with: bash examples/wordpress/setup.sh)
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker.ts";
import { NodePlatformIO } from "../../host/src/platform/node.ts";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter.ts";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const phpBinaryPath = join(repoRoot, "examples/libs/php/php-src/sapi/cli/php");
const kernelWasmPath = join(repoRoot, "host/wasm/wasm_posix_kernel.wasm");
const wpDir = join(__dirname, "wordpress");
const routerScript = join(__dirname, "router.php");

const port = parseInt(process.argv[2] || "3000", 10);

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;

// Validate prerequisites
if (!existsSync(phpBinaryPath)) {
  console.error("Error: PHP binary not found. Build with: cd examples/libs/php && bash build.sh");
  process.exit(1);
}
if (!existsSync(join(wpDir, "wp-settings.php"))) {
  console.error("Error: WordPress not found. Run: bash examples/wordpress/setup.sh");
  process.exit(1);
}
if (!existsSync(kernelWasmPath)) {
  console.error("Error: Kernel wasm not found. Run: bash build.sh");
  process.exit(1);
}

function loadFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const kernelWasmBytes = loadFile(kernelWasmPath);
  const programBytes = loadFile(phpBinaryPath);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();

  let mainWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | null = null;
  let nextThreadChannelPage = MAX_PAGES - 4;

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
      onExec: async () => -38, // ENOSYS
      onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        const threadChannelOffset = nextThreadChannelPage * 65536;
        const tlsAllocAddr = (nextThreadChannelPage - 2) * 65536;
        nextThreadChannelPage -= 3;
        new Uint8Array(memory.buffer, threadChannelOffset, CH_TOTAL_SIZE).fill(0);
        new Uint8Array(memory.buffer, tlsAllocAddr, 65536).fill(0);

        kernelWorker.addChannel(pid, threadChannelOffset, tid);

        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid,
          tid,
          programBytes,
          memory,
          channelOffset: threadChannelOffset,
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          tlsAllocAddr,
        };

        const threadWorker = workerAdapter.createWorker(threadInitData);
        threadWorker.on("message", (msg: unknown) => {
          const m = msg as WorkerToHostMessage;
          if (m.type === "thread_exit") {
            threadWorker.terminate().catch(() => {});
          }
        });
        threadWorker.on("error", () => {
          kernelWorker.notifyThreadExit(pid, tid);
          kernelWorker.removeChannel(pid, threadChannelOffset);
        });

        return tid;
      },
      onExit: (pid, exitStatus) => {
        if (pid === 1) {
          console.log(`PHP process exited with status ${exitStatus}`);
          kernelWorker.unregisterProcess(pid);
          if (mainWorker) {
            mainWorker.terminate().catch(() => {});
          }
          process.exit(exitStatus);
        } else {
          kernelWorker.deactivateProcess(pid);
        }
      },
    },
  );

  // Forward stdout/stderr to console (merge with existing callbacks to
  // preserve onAlarm, onPosixTimer, onNetListen set by the constructor)
  const existingCallbacks = (kernelWorker as any).kernel.callbacks || {};
  (kernelWorker as any).kernel.callbacks = {
    ...existingCallbacks,
    onStdout: (data: Uint8Array) => {
      process.stdout.write(data);
    },
    onStderr: (data: Uint8Array) => {
      process.stderr.write(data);
    },
  };

  await kernelWorker.init(kernelWasmBytes);

  // Create shared memory for the process
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

  mainWorker.on("error", (err: Error) => {
    console.error("Worker error:", err);
    process.exit(1);
  });

  console.log(`WordPress server starting on http://localhost:${port}`);
  console.log("Waiting for PHP built-in server to initialize...");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
