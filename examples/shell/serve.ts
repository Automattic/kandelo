/**
 * serve.ts — Run dash shell on the wasm-posix-kernel.
 *
 * Supports three modes:
 *   1. Command: npx tsx examples/shell/serve.ts -c "echo hello"
 *   2. Piped:   echo "echo hello" | npx tsx examples/shell/serve.ts
 *   3. Script:  npx tsx examples/shell/serve.ts script.sh
 *
 * Build dash first:
 *   bash examples/libs/dash/build-dash.sh
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import type {
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Read all of stdin (for piped mode). */
function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
}

async function main() {
  const dashBinary = resolve(
    repoRoot,
    "examples/libs/dash/dash-src/src/dash",
  );
  if (!existsSync(dashBinary)) {
    console.error(
      "dash binary not found. Run: bash examples/libs/dash/build-dash.sh",
    );
    process.exit(1);
  }

  const kernelWasmPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");
  if (!existsSync(kernelWasmPath)) {
    console.error("Kernel wasm not found. Run: bash build.sh");
    process.exit(1);
  }

  // Parse args: everything after serve.ts goes to dash
  const args = process.argv.slice(2);
  const dashArgv = ["dash", ...args];

  // Read piped stdin if available
  const stdinData = await readStdin();

  const kernelBytes = loadBytes(kernelWasmPath);
  const programBytes = loadBytes(dashBinary);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();
  const workers = new Map<
    number,
    ReturnType<NodeWorkerAdapter["createWorker"]>
  >();

  let resolveExit: (status: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  let nextThreadChannelPage = MAX_PAGES - 4;

  const kernelWorker = new CentralizedKernelWorker(
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
        new Uint8Array(
          childMemory.buffer,
          childChannelOffset,
          CH_TOTAL_SIZE,
        ).fill(0);

        kernelWorker.registerProcess(childPid, childMemory, [
          childChannelOffset,
        ], { skipKernelCreate: true });

        const ASYNCIFY_BUF_SIZE = 16384;
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
          kernelWorker.unregisterProcess(childPid);
          workers.delete(childPid);
        });

        return [childChannelOffset];
      },
      onExec: async () => -2, // ENOENT — no external programs available yet
      onClone: async (
        pid,
        tid,
        _fnPtr,
        _argPtr,
        _stackPtr,
        _tlsPtr,
        _ctidPtr,
        memory,
      ) => {
        const threadChannelOffset = nextThreadChannelPage * 65536;
        const tlsAllocAddr = (nextThreadChannelPage - 2) * 65536;
        nextThreadChannelPage -= 3;
        new Uint8Array(
          memory.buffer,
          threadChannelOffset,
          CH_TOTAL_SIZE,
        ).fill(0);
        new Uint8Array(memory.buffer, tlsAllocAddr, 65536).fill(0);

        kernelWorker.addChannel(pid, threadChannelOffset, tid);

        const threadInitData = {
          type: "centralized_thread_init" as const,
          pid,
          tid,
          programBytes,
          memory,
          channelOffset: threadChannelOffset,
          fnPtr: _fnPtr,
          argPtr: _argPtr,
          stackPtr: _stackPtr,
          tlsPtr: _tlsPtr,
          ctidPtr: _ctidPtr,
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
          kernelWorker.unregisterProcess(pid);
          const w = workers.get(pid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(pid);
          }
          resolveExit(exitStatus);
        } else {
          kernelWorker.deactivateProcess(pid);
          const w = workers.get(pid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(pid);
          }
        }
      },
    },
  );

  // Forward stdout/stderr to host
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

  await kernelWorker.init(kernelBytes);

  // Create process memory
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
  kernelWorker.setCwd(pid, "/");

  // Provide piped stdin data if available
  if (stdinData.length > 0) {
    kernelWorker.setStdinData(pid, new Uint8Array(stdinData));
  }

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes,
    memory,
    channelOffset,
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TMPDIR=/tmp",
      "TERM=dumb",
    ],
    argv: dashArgv,
  };

  const mainWorker = workerAdapter.createWorker(initData);
  workers.set(pid, mainWorker);

  mainWorker.on("error", (err: Error) => {
    console.error("Worker error:", err);
    process.exit(1);
  });

  const exitCode = await exitPromise;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
