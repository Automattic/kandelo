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

function stressSource(iteration: number): string {
  return [
    "if (typeof setTimeZone !== 'function') throw new Error('setTimeZone unavailable');",
    "setTimeZone('UTC');",
    "setTimeZone('PST8PDT');",
    "setTimeZone('UTC');",
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

async function main(): Promise<void> {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  let kernel: BrowserKernel | null = null;

  try {
    const [kernelBytes, jsBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((response) => response.arrayBuffer()),
      fetch("/js.wasm").then((response) => {
        if (!response.ok) throw new Error(`fetch /js.wasm failed: ${response.status}`);
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
    const vfsImage = await memfs.saveImage();

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 2,
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

    const maxObservedMemoryBytes = Math.max(...results.map((r) => r.memoryBytes));
    const leakedPids = results.filter((r) => r.leaked).map((r) => r.pid);
    const nonzeroExits = results.filter((r) => r.exitCode !== 0);

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

    stdoutEl.textContent = stdout;
    stderrEl.textContent = stderr;
    resultsEl.textContent = JSON.stringify({
      iterations: results.length,
      maxObservedMemoryBytes,
      leakedPids,
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
