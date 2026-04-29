/**
 * Debug test — minimal test to see if CPython starts at all.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import { resolveBinary } from "../../host/src/binary-resolver";
import type {
  CentralizedWorkerInitMessage,
} from "../../host/src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 72 + 65536;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const pythonWasm = resolveBinary("programs/cpython.wasm");
  const pythonHome = resolve(__dirname, "../libs/cpython/cpython-install");
  const kernelWasmPath = resolveBinary("kernel.wasm");

  console.error(`[${Date.now()}] Loading wasm files...`);
  const kernelWasmBytes = loadBytes(kernelWasmPath);
  const programBytes = loadBytes(pythonWasm);
  console.error(`[${Date.now()}] Kernel: ${kernelWasmBytes.byteLength}, Python: ${programBytes.byteLength}`);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();

  let resolveExit: (status: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
    io,
    {
      onExit: (pid, exitStatus) => {
        console.error(`[${Date.now()}] [exit] pid=${pid} status=${exitStatus}`);
        resolveExit(exitStatus);
      },
    },
  );

  // Capture stdout/stderr with timestamps
  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      console.error(`[${Date.now()}] [stdout] ${text.substring(0, 200)}`);
      process.stdout.write(data);
    },
    onStderr: (data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      console.error(`[${Date.now()}] [stderr] ${text.substring(0, 200)}`);
      process.stderr.write(data);
    },
  });

  console.error(`[${Date.now()}] Initializing kernel...`);
  await kernelWorker.init(kernelWasmBytes);
  console.error(`[${Date.now()}] Kernel ready.`);

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
    env: [
      `PYTHONHOME=${pythonHome}`,
      `HOME=/tmp`,
      `TMPDIR=/tmp`,
      `PYTHONDONTWRITEBYTECODE=1`,
      `PYTHONNOUSERSITE=1`,
      `PYTHONMALLOC=malloc`,
    ],
    argv: ["python3", "-S", "-c", "print('Hello')"],
  };

  console.error(`[${Date.now()}] Spawning python3 worker...`);
  const mainWorker = workerAdapter.createWorker(initData);

  mainWorker.on("message", (msg: any) => {
    console.error(`[${Date.now()}] [worker msg] ${JSON.stringify(msg).substring(0, 200)}`);
  });

  mainWorker.on("error", (err: Error) => {
    console.error(`[${Date.now()}] [worker error] ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });

  mainWorker.on("exit", (code: number) => {
    console.error(`[${Date.now()}] [worker exit] code=${code}`);
  });

  // Periodic status check
  const statusInterval = setInterval(() => {
    console.error(`[${Date.now()}] ... still waiting ...`);
  }, 5000);

  // Timeout
  const timer = setTimeout(() => {
    console.error(`[${Date.now()}] [timeout] after 120s`);
    clearInterval(statusInterval);
    process.exit(1);
  }, 120_000);

  const exitCode = await exitPromise;
  clearTimeout(timer);
  clearInterval(statusInterval);
  console.error(`[${Date.now()}] [done] exit=${exitCode}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
