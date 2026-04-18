/**
 * Suite 1: Erlang Ring
 *
 * Spawns 1000 Erlang processes in a ring, sends a token around 100 times.
 * Uses the BEAM VM running on the wasm-posix-kernel.
 *
 * Metrics:
 *   total_ms         — Wall-clock time for full ring completion
 *   messages_per_sec — Total messages / elapsed seconds
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker.js";
import { NodePlatformIO } from "../../host/src/platform/node.js";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter.js";
import { patchWasmForThread } from "../../host/src/worker-main.js";
import { ThreadPageAllocator } from "../../host/src/thread-allocator.js";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const erlangLibDir = resolve(repoRoot, "examples/libs/erlang");
const installDir = resolve(erlangLibDir, "erlang-install");
const beamWasm = resolve(erlangLibDir, "bin/beam.wasm");
const ringDir = resolve(repoRoot, "examples/erlang");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runErlangRing(): Promise<Record<string, number>> {
  const kernelBytes = loadBytes(resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
  const beamBytes = loadBytes(beamWasm);

  // Pre-compile thread module
  const threadPatchedBytes = patchWasmForThread(beamBytes);
  const threadModule = new WebAssembly.Module(threadPatchedBytes);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
  const threadWorkers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
  const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

  let stdout = "";
  let lastOutputTime = 0;
  let outputSeen = false;

  let resolveExit: (status: number) => void;
  const exitPromise = new Promise<number>((r) => { resolveExit = r; });

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
        if (parentPages < MAX_PAGES) childMemory.grow(MAX_PAGES - parentPages);
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = (MAX_PAGES - 2) * 65536;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);
        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

        const ASYNCIFY_BUF_SIZE = 16384;
        const childWorker = workerAdapter.createWorker({
          type: "centralized_init",
          pid: childPid,
          ppid: parentPid,
          programBytes: beamBytes,
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

      onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        const alloc = threadAllocator.allocate(memory);
        kernelWorker.addChannel(pid, alloc.channelOffset, tid);

        const threadWorker = workerAdapter.createWorker({
          type: "centralized_thread_init",
          pid,
          tid,
          programBytes: beamBytes,
          programModule: threadModule,
          memory,
          channelOffset: alloc.channelOffset,
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          tlsAllocAddr: alloc.tlsAllocAddr,
        } as CentralizedThreadInitMessage);
        threadWorkers.set(tid, threadWorker);
        threadWorker.on("message", (msg: unknown) => {
          const m = msg as any;
          if (m.type === "thread_exit") {
            kernelWorker.notifyThreadExit(pid, tid);
            kernelWorker.removeChannel(pid, alloc.channelOffset);
            threadAllocator.free(alloc.basePage);
            threadWorkers.delete(tid);
            threadWorker.terminate().catch(() => {});
          }
        });
        threadWorker.on("error", () => {
          kernelWorker.notifyThreadExit(pid, tid);
          kernelWorker.removeChannel(pid, alloc.channelOffset);
          threadAllocator.free(alloc.basePage);
          threadWorkers.delete(tid);
        });
        return tid;
      },

      onExec: async () => -38,

      onExit: (pid, exitStatus) => {
        if (pid === 1) {
          for (const [, tw] of threadWorkers) tw.terminate().catch(() => {});
          threadWorkers.clear();
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
    onStdout: (data) => {
      outputSeen = true;
      lastOutputTime = Date.now();
      stdout += decoder.decode(data);
    },
    onStderr: () => {},
  });

  const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
  const channelOffset = (MAX_PAGES - 2) * 65536;
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  const pid = 1;
  kernelWorker.registerProcess(pid, memory, [channelOffset]);
  kernelWorker.setCwd(pid, ringDir);
  kernelWorker.setNextChildPid(2);

  // Protect thread region
  const maxThreads = 8;
  const pagesPerThread = 4;
  const lowestThreadTlsPage = MAX_PAGES - 2 - maxThreads * pagesPerThread - 2;
  kernelWorker.setMaxAddr(pid, lowestThreadTlsPage * 65536);

  const beamArgs = [
    "beam.smp",
    "-S", "1:1",
    "-A", "0",
    "-SDio", "1",
    "-SDcpu", "1:1",
    "-P", "262144",
    "--",
    "-root", installDir,
    "-bindir", resolve(installDir, "erts-16.1.2/bin"),
    "-progname", "erl",
    "-home", "/tmp",
    "-start_epmd", "false",
    "-boot", resolve(installDir, "releases/28/start_clean"),
    "-noshell",
    "-pa", ".", ringDir,
    resolve(installDir, "lib/kernel-10.4.2/ebin"),
    resolve(installDir, "lib/stdlib-7.1/ebin"),
    "-eval", "ring:start().",
  ];

  const t0 = performance.now();

  const masterWorker = workerAdapter.createWorker({
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes: beamBytes,
    memory,
    channelOffset,
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TMPDIR=/tmp",
      "LANG=en_US.UTF-8",
      `ROOTDIR=${installDir}`,
      `BINDIR=${installDir}/erts-16.1.2/bin`,
      "EMU=beam",
      "PROGNAME=erl",
    ],
    argv: beamArgs,
  } as CentralizedWorkerInitMessage);
  workers.set(pid, masterWorker);

  masterWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "exit") resolveExit(m.status);
  });

  // Halt detection: BEAM's halt gets stuck in pthread_join
  const haltDetector = setInterval(() => {
    if (outputSeen && Date.now() - lastOutputTime > 2000) {
      clearInterval(haltDetector);
      resolveExit(0);
    }
  }, 500);

  const timeoutPromise = new Promise<number>((r) => {
    setTimeout(() => { clearInterval(haltDetector); r(1); }, 120_000);
  });

  await Promise.race([exitPromise, timeoutPromise]);
  const t1 = performance.now();

  // Cleanup
  for (const [, tw] of threadWorkers) await tw.terminate().catch(() => {});
  for (const [, w] of workers) await w.terminate().catch(() => {});

  // Parse output: "Completed in X.XXX seconds (XXXXX us)"
  const usMatch = stdout.match(/\((\d+) us\)/);
  const msgMatch = stdout.match(/Total messages: (\d+)/);

  if (!usMatch || !msgMatch) {
    throw new Error(`Failed to parse ring output:\n${stdout}`);
  }

  const elapsedUs = parseInt(usMatch[1], 10);
  const totalMessages = parseInt(msgMatch[1], 10);
  const totalMs = elapsedUs / 1000;
  const messagesPerSec = Math.round(totalMessages / (elapsedUs / 1e6));

  return {
    total_ms: totalMs,
    messages_per_sec: messagesPerSec,
  };
}

const suite: BenchmarkSuite = {
  name: "erlang-ring",

  async run(): Promise<Record<string, number>> {
    if (!existsSync(beamWasm)) {
      console.warn("  BEAM binary not found, skipping. Run: bash examples/libs/erlang/build-erlang.sh");
      return {};
    }
    if (!existsSync(resolve(installDir, "releases/28/start_clean.boot"))) {
      console.warn("  Erlang OTP not installed, skipping.");
      return {};
    }
    return runErlangRing();
  },
};

export default suite;
