import { BrowserKernel } from "../../../../../host/src/browser-kernel-host";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../../../host/src/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";

const stdoutEl = document.getElementById("stdout")!;
const stderrEl = document.getElementById("stderr")!;
const resultsEl = document.getElementById("results")!;
const statusEl = document.getElementById("status")!;

const JS_PATH = "/usr/bin/js";
const NODE_PATH = "/usr/bin/node";
const WASM_PAGE_SIZE = 64 * 1024;
const MAX_PROCESS_PAGES = 16_384;
const MAX_EXPECTED_INITIAL_BYTES = 512 * 1024 * 1024;
const ITERATIONS = 6;

interface IterationResult {
  pid: number;
  exitCode: number;
  memoryBytes: number;
  leaked: boolean;
}

interface NodeWorkerProbeResult {
  label: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function stressSource(iteration: number): string {
  return [
    "var deadline = Date.now() + 50;",
    "while (Date.now() < deadline) {}",
    `print("stress-ok-${iteration}")`,
  ].join("\n");
}

async function waitForProcessMemory(
  kernel: BrowserKernel,
  pid: number,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const proc = (await kernel.enumProcs()).find((p) => p.pid === pid);
    if (proc?.memoryBytes != null) return proc.memoryBytes;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} did not appear in enumProcs`);
}

async function processLeaked(kernel: BrowserKernel, pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const procs = await kernel.enumProcs();
    if (!procs.some((p) => p.pid === pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function runOne(
  kernel: BrowserKernel,
  iteration: number,
): Promise<IterationResult> {
  const { pid, exit } = await kernel.spawnFromVfs(
    JS_PATH,
    ["js", "-e", stressSource(iteration)],
    {
      cwd: "/root",
      uid: 0,
      gid: 0,
      env: [
        "HOME=/root",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "PATH=/usr/bin:/bin",
      ],
    },
  );
  const memoryBytes = await waitForProcessMemory(kernel, pid);
  const exitCode = await exit;
  const leaked = await processLeaked(kernel, pid);
  return { pid, exitCode, memoryBytes, leaked };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runNodeWorkerProbe(
  kernel: BrowserKernel,
  label: string,
  source: string,
  stdoutRef: () => string,
  stderrRef: () => string,
): Promise<NodeWorkerProbeResult> {
  const stdoutStart = stdoutRef().length;
  const stderrStart = stderrRef().length;
  const { exit } = await kernel.spawnFromVfs(
    NODE_PATH,
    ["node", "-e", source],
    {
      cwd: "/root",
      uid: 0,
      gid: 0,
      env: [
        "HOME=/root",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "PATH=/usr/bin:/bin",
      ],
    },
  );
  const exitCode = await withTimeout(exit, 30_000, label);
  const stdout = stdoutRef().slice(stdoutStart);
  const stderr = stderrRef().slice(stderrStart);
  return { label, exitCode, stdout, stderr };
}

const ABORT_ON_UNCAUGHT_EXCEPTION_TERMINATE_SOURCE = [
  "const { Worker } = require('worker_threads');",
  "const worker = new Worker('while (true);', { eval: true });",
  "worker.on('online', () => worker.terminate());",
  "worker.on('exit', (code) => console.log('abort-on-uncaught-exception-terminate exit', code));",
].join("\n");

const TERMINATE_MICROTASK_LOOP_SOURCE = [
  "const { Worker } = require('worker_threads');",
  "const worker = new Worker(`",
  "function loop() { Promise.resolve().then(loop); }",
  "loop();",
  "require('worker_threads').parentPort.postMessage('up');",
  "`, { eval: true });",
  "worker.once('message', (message) => {",
  "  console.log('terminate-microtask-loop message', message);",
  "  setImmediate(() => worker.terminate());",
  "});",
  "worker.once('exit', (code) => console.log('terminate-microtask-loop exit', code));",
].join("\n");

async function main(): Promise<void> {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  let kernel: BrowserKernel | null = null;

  try {
    const [kernelBytes, jsBytes, nodeBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((response) => response.arrayBuffer()),
      fetch("/js.wasm").then((response) => {
        if (!response.ok) throw new Error(`fetch /js.wasm failed: ${response.status}`);
        return response.arrayBuffer();
      }),
      fetch("/spidermonkey-node.wasm").then((response) => {
        if (!response.ok) {
          throw new Error(`fetch /spidermonkey-node.wasm failed: ${response.status}`);
        }
        return response.arrayBuffer();
      }),
    ]);

    const memfs = MemoryFileSystem.create(
      new SharedArrayBuffer(96 * 1024 * 1024, { maxByteLength: 192 * 1024 * 1024 }),
      192 * 1024 * 1024,
    );
    for (const dir of ["/tmp", "/root", "/dev"]) ensureDir(memfs, dir);
    memfs.chmod("/tmp", 0o777);
    memfs.chmod("/root", 0o700);
    ensureDirRecursive(memfs, "/usr/bin");
    writeVfsBinary(memfs, JS_PATH, new Uint8Array(jsBytes));
    writeVfsBinary(memfs, NODE_PATH, new Uint8Array(nodeBytes));
    const vfsImage = await memfs.saveImage();

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 4,
      maxMemoryPages: MAX_PROCESS_PAGES,
      onStdout: (data) => { stdout += decoder.decode(data); },
      onStderr: (data) => { stderr += decoder.decode(data); },
    });

    const first = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage,
      argv: [JS_PATH, "-e", stressSource(0)],
      cwd: "/root",
      uid: 0,
      gid: 0,
    });
    const firstMemory = await waitForProcessMemory(kernel, first.pid);
    const firstExitCode = await first.exit;
    const firstLeaked = await processLeaked(kernel, first.pid);
    const results: IterationResult[] = [{
      pid: first.pid,
      exitCode: firstExitCode,
      memoryBytes: firstMemory,
      leaked: firstLeaked,
    }];

    for (let i = 1; i <= ITERATIONS; i++) {
      results.push(await runOne(kernel, i));
    }

    const nodeWorkerProbes = [
      await runNodeWorkerProbe(
        kernel,
        "test-worker-abort-on-uncaught-exception-terminate",
        ABORT_ON_UNCAUGHT_EXCEPTION_TERMINATE_SOURCE,
        () => stdout,
        () => stderr,
      ),
      await runNodeWorkerProbe(
        kernel,
        "test-worker-terminate-microtask-loop",
        TERMINATE_MICROTASK_LOOP_SOURCE,
        () => stdout,
        () => stderr,
      ),
    ];

    const maxObservedMemoryBytes = Math.max(...results.map((r) => r.memoryBytes));
    const leakedPids = results.filter((r) => r.leaked).map((r) => r.pid);
    const nonzeroExits = results.filter((r) => r.exitCode !== 0);
    const failedNodeWorkerProbes = nodeWorkerProbes.filter((probe) => {
      if (probe.exitCode !== 0) return true;
      if (probe.label === "test-worker-abort-on-uncaught-exception-terminate") {
        return !probe.stdout.includes("abort-on-uncaught-exception-terminate exit 1");
      }
      return !probe.stdout.includes("terminate-microtask-loop message up") ||
        !probe.stdout.includes("terminate-microtask-loop exit 1");
    });

    if (maxObservedMemoryBytes >= MAX_PROCESS_PAGES * WASM_PAGE_SIZE) {
      throw new Error(`js launch allocated the configured max memory: ${maxObservedMemoryBytes}`);
    }
    if (maxObservedMemoryBytes >= MAX_EXPECTED_INITIAL_BYTES) {
      throw new Error(`js launch initial memory is unexpectedly large: ${maxObservedMemoryBytes}`);
    }
    if (leakedPids.length > 0) {
      throw new Error(`process leak after js launch: ${leakedPids.join(",")}`);
    }
    if (nonzeroExits.length > 0) {
      throw new Error(`non-zero js exits: ${JSON.stringify(nonzeroExits)}`);
    }
    if (failedNodeWorkerProbes.length > 0) {
      throw new Error(`Node worker probe failure: ${JSON.stringify(failedNodeWorkerProbes)}`);
    }

    stdoutEl.textContent = stdout;
    stderrEl.textContent = stderr;
    resultsEl.textContent = JSON.stringify({
      iterations: results.length,
      maxObservedMemoryBytes,
      leakedPids,
      nodeWorkerProbes,
      stdout,
      stderr,
    });
    statusEl.textContent = "done";
  } catch (error) {
    stdoutEl.textContent = stdout;
    stderrEl.textContent = `${stderr}${stderr ? "\n" : ""}${String(error)}`;
    statusEl.textContent = "error";
  } finally {
    await kernel?.destroy().catch(() => {});
  }
}

main();
