/**
 * Node.js kernel worker entry point — general-purpose, message-based.
 *
 * Runs CentralizedKernelWorker in a dedicated worker_thread so the kernel's
 * Atomics.waitAsync event loop runs independently of the main thread's libuv
 * loop. This eliminates the 3-4x throughput penalty observed when the kernel
 * shares the main thread.
 *
 * Protocol (see node-kernel-protocol.ts):
 *   Main → Worker: init, spawn, append_stdin_data, set_stdin_data,
 *                  pty_write, pty_resize, terminate_process, destroy,
 *                  resolve_exec_response
 *   Worker → Main: ready, response, exit, stdout, stderr, host_diagnostic,
 *                  pty_output, resolve_exec
 */
import { parentPort } from "node:worker_threads";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  isCurrentProcessGeneration,
  TERMINAL_STDIO,
} from "./kernel-worker";
import type {
  ForkFromThreadContext,
  ResolvedSpawnProgram,
  SpawnProgramResolution,
  ThreadChannelAttachment,
} from "./kernel-worker";
import { NodePlatformIO } from "./platform/node";
import {
  VirtualPlatformIO,
  NodeTimeProvider,
  DEFAULT_MOUNT_SPEC,
  DeviceFileSystem,
  ensureMountParentDirectories,
  HostFileSystem,
  MemoryFileSystem,
  resolveForNode,
} from "./vfs";
import type { MountConfig } from "./vfs/types";
import { TcpNetworkBackend } from "./networking/tcp-backend";
import { findRepoRoot } from "./binary-resolver";
import { NodeWorkerAdapter } from "./worker-adapter";
import { DeferredWorkerHandle } from "./deferred-worker-handle";
import { ThreadPageAllocator } from "./thread-allocator";
import { patchWasmForThread } from "./worker-main";
import { ThreadExitCoordinator } from "./thread-exit-coordinator";
import { detectPtrWidth, extractAbiVersion, extractHeapBase, isWasmModuleBytes } from "./constants";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
import {
  classifiedSignalOrFallback,
  classifiedTrapExitStatus,
  signalExitStatus,
  SIGSEGV,
} from "./trap-signals";
import {
  removeThreadWorkerRegistryEntry,
  threadWorkerFailureDisposition,
} from "./thread-worker-disposition";
import { VmInterruptTimerManager } from "./vm-interrupt-timer";
import {
  computeProcessMemoryLayout,
  createProcessMemory,
  DEFAULT_PROCESS_THREAD_SLOTS,
  FORK_SAVE_BUFFER_SIZE,
  type ProcessMemoryLayout,
} from "./process-memory";
import type { PlatformIO } from "./types";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import type {
  HostDiagnostic,
  MainToKernelMessage,
  KernelToMainMessage,
  InitMessage,
  SpawnMessage,
  TerminateProcessMessage,
  HttpRequestMessage,
} from "./node-kernel-protocol";

if (!parentPort) {
  throw new Error("node-kernel-worker-entry must run in a worker_thread");
}

const port = parentPort;

// --- State ---

let kernelWorker: CentralizedKernelWorker;
let workerAdapter: NodeWorkerAdapter;
let maxPages: number = DEFAULT_MAX_PAGES;
let defaultThreadSlots: number = DEFAULT_PROCESS_THREAD_SLOTS;
let execPrograms: Record<string, string> = {};
let vfsExecIO: PlatformIO | null = null;
let rootfsMemfs: MemoryFileSystem | null = null;
/** Per-boot scratch directory; cleaned up on `destroy`. Only set when the
 *  worker constructs a `VirtualPlatformIO` from the default mount spec. */
let sessionDir: string | null = null;
const ENOEXEC = 8;
// [JSC-TERMINATE-ATOMICS-WAIT-LEAK] destroy-time drain bounds; see handleDestroy.
const DESTROY_KILL_DRAIN_TIMEOUT_MS = 1500;
const DESTROY_KILL_DRAIN_POLL_MS = 15;

// Process tracking
interface ForkReplayContext {
  fnPtr: number;
  argPtr: number;
  forkBufAddr: number;
}

interface ProcessInfo {
  memory: WebAssembly.Memory;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  channelOffset: number;
  ptrWidth: 4 | 8;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
  /** Non-_start continuation root inherited from a pthread fork until exec. */
  forkReplayContext?: ForkReplayContext;
}
const processes = new Map<number, ProcessInfo>();
const processTeardowns = new Map<ProcessInfo["worker"], Promise<void>>();
const vmInterruptTimers = new VmInterruptTimerManager<ProcessInfo>(
  (pid) => processes.get(pid),
);
const reportedExits = new Set<number>();

// Workers terminated by the kernel-worker entry itself (handleExit /
// handleExec / handleTerminate). The crash safety-net listener checks
// this set so it doesn't fire for our own teardown calls.
const intentionallyTerminated = new WeakSet<object>();

/**
 * Install a safety-net 'exit' listener on a process worker. If the wasm
 * worker_thread exits unexpectedly (e.g. an uncaught wasm trap that
 * bypasses the SYS_exit_group path), no kernel-side exit handler runs and
 * the host's spawn promise would hang waiting for an exit notification
 * that never comes. This listener detects that case — when the worker we
 * registered here is *still* the one bound to `pid` in `processes` and we
 * didn't terminate it ourselves — and synthesizes a SIGSEGV crash exit
 * so the host learns the process is gone. There is no reliable trap
 * reason on this path, so it keeps the generic 128+SIGSEGV convention.
 */
function installCrashSafetyNet(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  pid: number,
): void {
  worker.on("exit", (code: number) => {
    if (intentionallyTerminated.has(worker as object)) return;
    const cur = processes.get(pid);
    if (!cur || cur.worker !== worker) return; // already torn down or replaced
    const status = signalExitStatus(SIGSEGV);
    reportHostDiagnostic({
      pid,
      status,
      source: "worker exit event",
      message:
        `[process-worker] pid=${pid} crashed ` +
        `(worker exit code=${code}, no SYS_exit_group from wasm)`,
    });
    void finalizeProcessWorker(pid, worker, status, SIGSEGV);
  });
}

// Per-PID thread module cache: lazily compiled on first clone()
const threadModuleCache = new Map<number, WebAssembly.Module>();

// Thread workers per-PID for cleanup
interface ThreadWorkerInfo {
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  channelOffset: number;
  tid: number;
  basePage: number;
  termination?: Promise<void>;
}
const threadWorkers = new Map<number, ThreadWorkerInfo[]>();
const threadExits = new ThreadExitCoordinator();

async function terminateTrackedWorker(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
): Promise<void> {
  intentionallyTerminated.add(worker as object);
  await worker.terminate().catch(() => {});
}

async function terminateThreadWorkers(pid: number): Promise<void> {
  const threads = threadWorkers.get(pid);
  if (!threads) return;
  threadWorkers.delete(pid);
  for (const thread of threads) {
    intentionallyTerminated.add(thread.worker as object);
  }
  for (const t of threads) {
    await (t.termination ?? terminateTrackedWorker(t.worker));
    threadExits.release(pid, t.channelOffset);
  }
}

function reportProcessExit(pid: number, status: number): void {
  if (reportedExits.has(pid)) return;
  reportedExits.add(pid);
  post({ type: "exit", pid, status });
}

function handleVmInterruptTimer(msg: {
  pid: number;
  timedOutPtr: number;
  vmInterruptPtr: number;
  seconds: number;
}, pid: number, process: ProcessInfo): void {
  if (msg.pid !== pid) return;
  vmInterruptTimers.handleRequest(pid, process, msg);
}

function signalFromExitStatus(exitStatus: number): number | null {
  return exitStatus >= 128 ? (exitStatus - 128) & 0x7f : null;
}

// PTY index per-PID
const ptyByPid = new Map<number, number>();

// Exec resolution: request ID → resolver
let execResolveId = 0;
const pendingExecResolves = new Map<number, (bytes: ArrayBuffer | null) => void>();

// --- Helpers ---

/**
 * Tear down kernel and host state for an exiting process worker.
 *
 * Called from BOTH the `{type:"exit"}` and `{type:"error"}` message
 * handlers below: previously only `exit` ran the cleanup, so a
 * worker that died via `{type:"error"}` (uncaught wasm trap,
 * instantiation failure) left `kernelWorker` with the process still
 * registered. Any concurrent `waitpid` in the parent then hung
 * forever because the kernel never saw the child go zombie. The
 * stderr forwarding alone, without `deactivateProcess`, is not
 * enough.
 *
 * Idempotent: guarded by `cur && cur.worker === worker` so a later
 * `worker.on("exit")` from `installCrashSafetyNet` is a no-op.
 */
async function finalizeProcessWorker(
  pid: number,
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  exitStatus: number,
  crashSignum: number = signalFromExitStatus(exitStatus) ?? SIGSEGV,
): Promise<void> {
  if (intentionallyTerminated.has(worker as object)) return;
  const cur = processes.get(pid);
  if (!cur || cur.worker !== worker) return;

  // A kernel-side exit callback may already be draining this exact Worker
  // generation. Its teardown deliberately keeps channels registered until
  // every backing Worker is gone, so a trailing worker-main exit/error event
  // must not race in here and deactivate the pid early. The browser entry
  // funnels the same events through finishProcessExit(), whose teardown-map
  // guard provides this ordering directly.
  if (processTeardowns.has(worker)) {
    reportProcessExit(pid, exitStatus);
    return;
  }
  vmInterruptTimers.clear(pid);

  // Synthesize a signal-style reap *before* `deactivateProcess` in
  // case the worker died without sending SYS_EXIT_GROUP (uncaught
  // wasm trap, instantiation failure → `{type:"error"}` path).
  // Without this, a concurrent waitpid in the parent blocks until
  // destroy because the kernel never marked the child as a zombie.
  // Idempotent via `hostReaped`: when the kernel already processed
  // a clean SYS_EXIT_GROUP for this pid, this is a no-op.
  try { kernelWorker.notifyHostProcessCrashed(pid, crashSignum); } catch { /* best-effort */ }
  try { kernelWorker.deactivateProcess(pid); } catch { /* best-effort */ }
  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);

  // Report while this worker is still known to be the current generation.
  // Its asynchronous termination must not report an exit for an exec
  // replacement that has since installed a new generation under the same pid.
  reportProcessExit(pid, exitStatus);
  await terminateThreadWorkers(pid);
  await terminateTrackedWorker(worker);
}

function processWorkerErrorDisposition(reason: string | undefined): {
  exitStatus: number;
  signum: number;
} {
  return {
    exitStatus: classifiedTrapExitStatus(reason) ?? -1,
    signum: classifiedSignalOrFallback(reason),
  };
}

function unexpectedWorkerCrashDisposition(reason: unknown): {
  exitStatus: number;
  signum: number;
} {
  const signum = classifiedSignalOrFallback(reason);
  return { exitStatus: signalExitStatus(signum), signum };
}

function finalizeProcessWorkerError(
  pid: number,
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  message: string | undefined,
): void {
  if (intentionallyTerminated.has(worker as object)) return;
  if (processes.get(pid)?.worker !== worker) return;
  const { exitStatus, signum } = processWorkerErrorDisposition(message);
  reportHostDiagnostic({
    pid,
    status: exitStatus,
    source: "worker-main error message",
    message: `[process-worker] ${message ?? "unknown error"}`,
  });
  void finalizeProcessWorker(pid, worker, exitStatus, signum);
}

function finalizeUnexpectedWorkerError(
  pid: number,
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  label: string,
  err: unknown,
): void {
  if (intentionallyTerminated.has(worker as object)) return;
  if (processes.get(pid)?.worker !== worker) return;
  const message = err instanceof Error ? (err.message ?? String(err)) : String(err);
  const { exitStatus, signum } = unexpectedWorkerCrashDisposition(err);
  reportHostDiagnostic({
    pid,
    status: exitStatus,
    source: label,
    message: `[kernel-worker] pid=${pid}: ${label}: ${message}`,
  });
  void finalizeProcessWorker(pid, worker, exitStatus, signum);
}

function post(msg: KernelToMainMessage) {
  port.postMessage(msg);
}

function reportHostDiagnostic(
  diagnostic: HostDiagnostic,
  level: "error" | "warn" = "error",
): void {
  if (level === "warn") console.warn(diagnostic.message);
  else console.error(diagnostic.message);
  post({ type: "host_diagnostic", ...diagnostic });
}

function reportWorkerProtocolError(message: string): void {
  reportHostDiagnostic({
    pid: 0,
    source: "worker protocol",
    message: `[node-kernel-worker] ${message}`,
  });
}

function respond(requestId: number, result: unknown) {
  post({ type: "response", requestId, result });
}

function respondError(requestId: number, error: string) {
  post({ type: "response", requestId, result: null, error });
}

function createSharedProcessMemory(
  ptrWidth: 4 | 8,
  initialPages: number,
  maximumPages: number,
): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(initialPages) as any,
      maximum: BigInt(maximumPages) as any,
      shared: true,
      address: "i64",
    } as any);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maximumPages,
    shared: true,
  });
}

function threadAllocatorForLayout(
  layout: ProcessMemoryLayout,
  ptrWidth: 4 | 8,
  pid: number,
): ThreadPageAllocator {
  return new ThreadPageAllocator({
    firstSlotStartPage: layout.firstThreadSlotPage,
    maxPageExclusive: layout.threadArenaEndPage,
    ptrWidth,
    reservedSlots: layout.threadSlotCount,
    reserveSlotStartPage: () =>
      kernelWorker.reserveHostRegion(pid, PAGES_PER_THREAD * WASM_PAGE_SIZE) / WASM_PAGE_SIZE,
  });
}

function createFreshProcessMemory(
  pid: number,
  programBytes: ArrayBuffer,
  ptrWidth: 4 | 8,
): {
  memory: WebAssembly.Memory;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
} {
  const heapBase = extractHeapBase(programBytes);
  const layout = computeProcessMemoryLayout({
    maxPages,
    defaultThreadSlots,
    ptrWidth,
    programBytes,
    heapBase,
  });
  const memory = createProcessMemory(ptrWidth, layout);
  new Uint8Array(memory.buffer, layout.channelOffset, CH_TOTAL_SIZE).fill(0);
  return {
    memory,
    layout,
    threadAllocator: threadAllocatorForLayout(layout, ptrWidth, pid),
  };
}

function bufferToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function resolveExecLocal(path: string): ArrayBuffer | null {
  const mapped = execPrograms[path];
  if (mapped && existsSync(mapped)) {
    const bytes = readFileSync(mapped);
    return bufferToArrayBuffer(bytes);
  }
  return null;
}

function readExecFromVfs(path: string): ArrayBuffer | null {
  const io = vfsExecIO;
  if (!io) return null;
  let fd: number | null = null;
  try {
    const st = io.stat(path);
    if ((st.mode & 0o170000) === 0o040000) return null;
    fd = io.open(path, 0, 0);
    const bytes = new Uint8Array(st.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = io.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return bytes.slice(0, offset).buffer;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { io.close(fd); } catch {}
    }
  }
}

async function resolveExecFromRootfs(path: string): Promise<ArrayBuffer | null> {
  if (!rootfsMemfs) return null;

  const lazy = rootfsMemfs.getLazyEntry(path);
  if (lazy) {
    return readLazyExecBytes(lazy.url);
  }

  try {
    const st = rootfsMemfs.stat(path);
    if (st.size <= 0) return null;
    const fd = rootfsMemfs.open(path, 0, 0);
    try {
      const bytes = new Uint8Array(st.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const n = rootfsMemfs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
        if (n <= 0) break;
        offset += n;
      }
      return bufferToArrayBuffer(bytes.subarray(0, offset));
    } finally {
      rootfsMemfs.close(fd);
    }
  } catch {
    return null;
  }
}

async function readLazyExecBytes(url: string): Promise<ArrayBuffer | null> {
  if (/^https?:\/\//.test(url)) {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  }

  const path = url.startsWith("file://")
    ? fileURLToPath(url)
    : join(findRepoRoot(), url.replace(/^\/+/, ""));
  if (!existsSync(path)) return null;
  return bufferToArrayBuffer(readFileSync(path));
}

async function resolveExec(path: string): Promise<ArrayBuffer | null> {
  const local = resolveExecLocal(path);
  if (local) return local;

  const fromRootfs = await resolveExecFromRootfs(path);
  if (fromRootfs) return fromRootfs;

  const vfs = readExecFromVfs(path);
  if (vfs) return vfs;

  // Ask main thread to resolve
  const requestId = ++execResolveId;
  return new Promise<ArrayBuffer | null>((resolve) => {
    pendingExecResolves.set(requestId, resolve);
    post({ type: "resolve_exec", requestId, path });
  });
}

const MAX_SHEBANG_DEPTH = 4;

function parseShebang(bytes: ArrayBuffer): { interpreter: string; arg?: string } | null {
  const view = new Uint8Array(bytes);
  if (view.length < 2 || view[0] !== 0x23 || view[1] !== 0x21) return null;
  let end = 2;
  while (end < view.length && view[end] !== 0x0a && end < 4096) end++;
  const line = new TextDecoder().decode(view.subarray(2, end)).replace(/\r$/, "").trim();
  if (!line) return null;
  const match = line.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { interpreter: match[1], arg: match[2] };
}

async function resolveExecutableForLaunch(
  path: string,
  argv: string[],
  depth = 0,
): Promise<ResolvedSpawnProgram | { errno: number } | null> {
  if (depth > MAX_SHEBANG_DEPTH) return null;
  const bytes = await resolveExec(path);
  if (!bytes) return null;

  const shebang = parseShebang(bytes);
  if (!shebang) {
    if (!isWasmModuleBytes(bytes)) return { errno: ENOEXEC };
    let programModule: WebAssembly.Module;
    try {
      programModule = await WebAssembly.compile(bytes);
    } catch (error) {
      if (error instanceof WebAssembly.CompileError) return { errno: ENOEXEC };
      throw error;
    }
    const declaredAbi = extractAbiVersion(bytes);
    if (declaredAbi !== null && declaredAbi !== kernelWorker.getKernelAbiVersion()) {
      return { errno: ENOEXEC };
    }
    return { programBytes: bytes, programModule, argv };
  }

  const scriptArgv = [
    shebang.interpreter,
    ...(shebang.arg ? [shebang.arg] : []),
    path,
    ...argv.slice(1),
  ];
  return resolveExecutableForLaunch(shebang.interpreter, scriptArgv, depth + 1);
}

// --- Init ---

/**
 * Materialise the default mount spec into a `VirtualPlatformIO` backed by
 * the rootfs image at `/` and per-boot host-fs scratch dirs everywhere
 * else. The session dir is created once per boot and torn down by
 * `cleanupSessionDir` on `destroy`.
 */
function buildVirtualPlatformIO(
  rootfsImage: ArrayBuffer,
  extraMounts?: Array<{
    mountPoint: string;
    hostPath: string;
    readonly?: boolean;
    uid?: number;
    gid?: number;
  }>,
): VirtualPlatformIO {
  const bootSessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-session-"));
  sessionDir = bootSessionDir;
  const specMounts = resolveForNode(
    DEFAULT_MOUNT_SPEC,
    new Uint8Array(rootfsImage),
    bootSessionDir,
  );
  const shmSab = new SharedArrayBuffer(16 * 1024 * 1024);
  const shmfs = MemoryFileSystem.create(shmSab);
  shmfs.chmod("/", 0o1777);
  const extras: MountConfig[] = (extraMounts ?? []).map((m) => ({
    mountPoint: m.mountPoint,
    backend: new HostFileSystem(m.hostPath, m.mountPoint, {
      uid: m.uid,
      gid: m.gid,
    }),
    readonly: m.readonly,
  }));
  const mounts = [
    { mountPoint: "/dev/shm", backend: shmfs },
    { mountPoint: "/dev", backend: new DeviceFileSystem() },
    ...specMounts,
    ...extras,
  ];
  const rootMount = mounts.find((m) => m.mountPoint === "/");
  rootfsMemfs = rootMount?.backend instanceof MemoryFileSystem
    ? rootMount.backend
    : null;
  if (rootfsMemfs) {
    ensureMountParentDirectories(rootfsMemfs, extras.map((m) => m.mountPoint));
  }
  return new VirtualPlatformIO(mounts, new NodeTimeProvider());
}

function cleanupSessionDir(): void {
  if (sessionDir) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // best-effort: tests should still pass even if cleanup races a hold
    }
  }
  sessionDir = null;
  vfsExecIO = null;
  rootfsMemfs = null;
}

async function handleInit(msg: InitMessage) {
  maxPages = msg.config.maxPages ?? DEFAULT_MAX_PAGES;
  defaultThreadSlots = msg.config.defaultThreadSlots ?? DEFAULT_PROCESS_THREAD_SLOTS;
  execPrograms = msg.execPrograms ?? {};
  workerAdapter = new NodeWorkerAdapter();

  const io: PlatformIO = msg.rootfsImage
    ? buildVirtualPlatformIO(msg.rootfsImage, msg.extraMounts)
    : new NodePlatformIO();
  vfsExecIO = msg.rootfsImage ? io : null;
  if (msg.enableTcpNetwork) {
    io.network = new TcpNetworkBackend();
  }

  kernelWorker = new CentralizedKernelWorker(
    {
      maxWorkers: msg.config.maxWorkers,
      dataBufferSize: msg.config.dataBufferSize ?? 65536,
      useSharedMemory: msg.config.useSharedMemory ?? true,
      defaultThreadSlots,
      enableSyscallLog: !!process.env.KERNEL_SYSCALL_LOG,
    },
    io,
    {
      onFork: (parentPid, childPid, parentMemory, threadFork) => {
        // Notify the main thread of every kernel-side process event so
        // Inspector-style UIs (Kandelo) can refresh their process table
        // event-driven. Mirrors the browser-side worker entry.
        post({ type: "proc_event", kind: "spawn", pid: childPid, ppid: parentPid });
        return handleFork(parentPid, childPid, parentMemory, threadFork);
      },
      onExec: async (pid, path, argv, envp, callerTid) => {
        const previousWorker = processes.get(pid)?.worker;
        const result = await handleExec(pid, path, argv, envp, callerTid);
        // Notify after handleExec refreshes kernel-side Process.argv so
        // process-table consumers don't refetch stale command names. A
        // post-commit signal death also returns 0 because the old syscall can
        // no longer return; only emit exec when a replacement was installed.
        const installedWorker = processes.get(pid)?.worker;
        if (
          result === 0
          && installedWorker
          && installedWorker !== previousWorker
          && kernelWorker.isProcessExecutionActive(pid)
        ) {
          post({ type: "proc_event", kind: "exec", pid });
        }
        return result;
      },
      onResolveSpawn: handlePosixSpawnResolve,
      onSpawn: handlePosixSpawn,
      onClone: handleClone,
      onThreadExit: (pid, _tid, channelOffset) => handleThreadExit(pid, channelOffset),
      onExit: handleExit,
    },
  );

  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      post({ type: "stdout", pid: 0, data: new Uint8Array(data) });
    },
    onStderr: (data: Uint8Array) => {
      post({ type: "stderr", pid: 0, data: new Uint8Array(data) });
    },
  });

  await kernelWorker.init(msg.kernelWasmBytes);

  post({ type: "ready" });
}

// --- Spawn ---

function handleSpawn(msg: SpawnMessage) {
  let createdPid: number | undefined;
  try {
    if (!isWasmModuleBytes(msg.programBytes)) {
      respondError(msg.requestId, "ENOEXEC: program is not a WebAssembly module");
      return;
    }

    const pid = kernelWorker.createProcess(
      msg.pty ? TERMINAL_STDIO : CAPTURED_STDIO,
    );
    createdPid = pid;
    const ptrWidth = detectPtrWidth(msg.programBytes);
    const {
      memory,
      layout,
      threadAllocator,
    } = createFreshProcessMemory(pid, msg.programBytes, ptrWidth);
    const channelOffset = layout.channelOffset;

    kernelWorker.registerProcess(pid, memory, [channelOffset], {
      ptrWidth,
      argv: msg.argv,
      env: msg.env ?? [],
      brkBase: layout.brkBase,
      mmapBase: layout.mmapBase,
      maxAddr: layout.maxAddr,
    });

    kernelWorker.setCredentials(pid, { uid: msg.uid, gid: msg.gid });
    if (msg.cwd) {
      kernelWorker.setCwd(pid, msg.cwd);
    }

    if (msg.maxAddr != null) {
      kernelWorker.setMaxAddr(pid, msg.maxAddr);
    }

    if (msg.pty) {
      const ptyIdx = kernelWorker.setupPty(pid);
      ptyByPid.set(pid, ptyIdx);
      // Apply initial winsize before the wasm program starts. Without this,
      // the program's first TIOCGWINSZ returns the kernel default (80x24)
      // and TUI renderers (ink, blessed) cache the wrong width before the
      // post-spawn pty_resize lands, causing redraw corruption.
      if (msg.ptyCols != null && msg.ptyRows != null) {
        kernelWorker.ptySetWinsize(ptyIdx, msg.ptyRows, msg.ptyCols);
      }
      kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
        post({ type: "pty_output", pid, data });
      });
    } else {
      if (msg.stdin) {
        const stdinData = msg.stdin instanceof Uint8Array ? msg.stdin : new Uint8Array(msg.stdin);
        kernelWorker.setStdinData(pid, stdinData);
      }
    }

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes: msg.programBytes,
      programModule: msg.programModule,
      memory,
      channelOffset,
      env: msg.env,
      argv: msg.argv,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    const worker = workerAdapter.createWorker(initData);
    processes.set(pid, {
      memory,
      programBytes: msg.programBytes,
      programModule: msg.programModule,
      worker,
      channelOffset,
      ptrWidth,
      layout,
      threadAllocator,
    });

    worker.on("error", (err: Error) => finalizeUnexpectedWorkerError(pid, worker, "worker error", err));

    // Process-worker top-level catch in worker-main posts {type:"error"}
    // for instantiation failures (ABI mismatch, link errors). Without
    // routing those upward, the spawn just hangs until the host's timeout
    // — so surface them to stderr and synthesize an exit so the host's
    // exitResolver fires with a non-zero status.
    worker.on("message", (raw: unknown) => {
      const m = raw as WorkerToHostMessage;
      if (m.type === "error" && m.pid === pid) {
        finalizeProcessWorkerError(pid, worker, m.message);
      } else if (m.type === "exit" && m.pid === pid) {
        // worker-main posts {type:"exit"} when _start returns or hits an
        // "unreachable" trap (the latter is treated as normal _Exit). If
        // the kernel didn't process a SYS_exit_group first, the kernel
        // still has the process registered and host.spawn() would hang.
        void finalizeProcessWorker(pid, worker, m.status ?? 0);
      } else if (m.type === "vm_interrupt_timer" && m.pid === pid) {
        const process = processes.get(pid);
        if (process?.worker === worker) handleVmInterruptTimer(m, pid, process);
      }
    });

    installCrashSafetyNet(worker, pid);
    createdPid = undefined;

    respond(msg.requestId, pid);
  } catch (e) {
    if (createdPid !== undefined) {
      kernelWorker.unregisterProcess(createdPid);
      kernelWorker.removeProcessFromKernelTable(createdPid);
    }
    respondError(msg.requestId, String(e));
  }
}

// --- Process lifecycle callbacks ---

async function handleFork(
  parentPid: number,
  childPid: number,
  parentMemory: WebAssembly.Memory,
  threadFork?: ForkFromThreadContext,
): Promise<number[]> {
  const parentInfo = processes.get(parentPid);
  const parentProgram = parentInfo?.programBytes;
  if (!parentProgram || parentInfo.memory !== parentMemory) {
    throw new Error(`Unknown parent generation for pid ${parentPid}`);
  }

  if (!parentInfo.programModule) {
    parentInfo.programModule = await WebAssembly.compile(parentProgram);
  }
  if (!kernelWorker.shouldLaunchPendingChild(childPid)) return [];

  const ptrWidth = parentInfo.ptrWidth;
  const parentBuf = new Uint8Array(parentMemory.buffer);
  const parentPages = Math.ceil(parentBuf.byteLength / 65536);
  const childLayout = parentInfo.layout;
  const childMemory = createSharedProcessMemory(
    ptrWidth,
    parentPages,
    childLayout.maximumPages,
  );
  new Uint8Array(childMemory.buffer).set(parentBuf);

  const childChannelOffset = childLayout.channelOffset;
  new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
    ptrWidth,
    maxAddr: childLayout.maxAddr,
    mmapBase: childLayout.mmapBase,
  });
  kernelWorker.inheritProcessSharedMappings(parentPid, childPid);

  const FORK_BUF_SIZE = FORK_SAVE_BUFFER_SIZE;
  const forkReplayContext: ForkReplayContext | undefined = threadFork
    ? {
        fnPtr: threadFork.fnPtr,
        argPtr: threadFork.argPtr,
        forkBufAddr: threadFork.forkBufAddr,
      }
    : parentInfo.forkReplayContext;
  const forkBufAddr = forkReplayContext?.forkBufAddr ?? childChannelOffset - FORK_BUF_SIZE;

  const childInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: childPid,
    programBytes: parentProgram,
    programModule: parentInfo.programModule,
    memory: childMemory,
    channelOffset: childChannelOffset,
    isForkChild: true,
    forkBufAddr,
    forkChildThreadFnPtr: forkReplayContext?.fnPtr,
    forkChildThreadArgPtr: forkReplayContext?.argPtr,
    ptrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
  };

  const childWorker = new DeferredWorkerHandle(
    () => workerAdapter.createWorker(childInitData),
  );
  processes.set(childPid, {
    memory: childMemory,
    programBytes: parentProgram,
    programModule: parentInfo.programModule,
    worker: childWorker,
    channelOffset: childChannelOffset,
    ptrWidth,
    layout: childLayout,
    threadAllocator: threadAllocatorForLayout(childLayout, ptrWidth, childPid),
    forkReplayContext,
  });

  childWorker.on("error", (err: Error) => finalizeUnexpectedWorkerError(childPid, childWorker, "worker error", err));

  childWorker.on("message", (raw: unknown) => {
    const m = raw as WorkerToHostMessage;
    if (m.type === "error" && m.pid === childPid) {
      finalizeProcessWorkerError(childPid, childWorker, m.message);
    } else if (m.type === "exit" && m.pid === childPid) {
      void finalizeProcessWorker(childPid, childWorker, m.status ?? 0);
    } else if (m.type === "vm_interrupt_timer" && m.pid === childPid) {
      const process = processes.get(childPid);
      if (process?.worker === childWorker) {
        handleVmInterruptTimer(m, childPid, process);
      }
    }
  });

  installCrashSafetyNet(childWorker, childPid);

  try {
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      childPid,
      childMemory,
      () => { childWorker.start(); },
      () => { void childWorker.terminate(); },
    );
    if (startDisposition === "stale") {
      throw new Error(`Fork child ${childPid} changed generation before Worker launch`);
    }
  } catch (error) {
    if (processes.get(childPid)?.worker === childWorker) {
      processes.delete(childPid);
      threadModuleCache.delete(childPid);
      ptyByPid.delete(childPid);
      vmInterruptTimers.clear(childPid);
    }
    void childWorker.terminate();
    throw error;
  }

  return [childChannelOffset];
}

async function handleExec(
  pid: number,
  path: string,
  argv: string[],
  envp: string[],
  callerTid: number,
): Promise<number> {
  const initiatingInfo = processes.get(pid);
  if (!initiatingInfo) return -3; // ESRCH
  if (!kernelWorker.supportsExecMetadataReplacement()) return -38; // ENOSYS

  const resolved = await resolveExecutableForLaunch(path, argv);
  if (!resolved) return -2; // ENOENT
  if ("errno" in resolved) return -resolved.errno;
  const { programBytes, programModule, argv: launchArgv } = resolved;
  const newPtrWidth = detectPtrWidth(programBytes);
  const metadataResult = kernelWorker.validateExecMetadata(
    launchArgv,
    envp,
    initiatingInfo.ptrWidth,
  );
  if (metadataResult < 0) return metadataResult;
  let prepared: ReturnType<typeof createFreshProcessMemory>;
  try {
    prepared = createFreshProcessMemory(pid, programBytes, newPtrWidth);
  } catch {
    return -12; // ENOMEM before the exec commit point
  }

  // Resolution/compilation yielded to the event loop. Another exec may have
  // replaced the host execution generation for this persistent PID; a stale
  // continuation must not commit exec state against it.
  if (processes.get(pid) !== initiatingInfo
      || kernelWorker.isExecHandoffActive(pid)
      || !kernelWorker.isProcessExecutionActive(pid)) return -3; // ESRCH
  const prepareResult = kernelWorker.kernelExecPrepare(pid, callerTid);
  if (prepareResult < 0) return prepareResult;
  const addressSpaceResult = kernelWorker.prepareAddressSpaceForExec(pid);
  if (addressSpaceResult < 0) return addressSpaceResult;
  let replacementWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | undefined;
  try {
    const setupResult = kernelWorker.kernelExecSetup(pid, callerTid);
    if (setupResult < 0) return setupResult;
    vmInterruptTimers.clear(pid);

    // From this point onward the old image cannot resume. Invalidate its
    // channels and async continuations immediately, before any other
    // post-commit operation can fail or yield.
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
    }
    kernelWorker.prepareProcessForExec(pid);

    const finalizeResult = kernelWorker.finalizeAddressSpaceForExec(pid);
    if (finalizeResult < 0) {
      throw new Error("failed to detach the discarded address space");
    }

    await terminateThreadWorkers(pid);
    if (initiatingInfo.worker) {
      await initiatingInfo.worker.terminate().catch(() => {});
    }
    if (kernelWorker.finalizeExecHandoffTermination(pid) > 0) return 0;

    const {
      memory: newMemory,
      layout: newLayout,
      threadAllocator: newThreadAllocator,
    } = prepared;
    const newChannelOffset = newLayout.channelOffset;

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes,
      programModule,
      memory: newMemory,
      channelOffset: newChannelOffset,
      argv: launchArgv,
      env: envp,
      ptrWidth: newPtrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
      preserveProcessState: true,
      ptrWidth: newPtrWidth,
      metadataPtrWidth: initiatingInfo.ptrWidth,
      brkBase: newLayout.brkBase,
      mmapBase: newLayout.mmapBase,
      maxAddr: newLayout.maxAddr,
      // Refresh kernel-side Process.argv and environment so procfs and
      // kernel APIs reflect the replacement image.
      argv: launchArgv,
      env: envp,
    });
    replacementWorker = new DeferredWorkerHandle(
      () => workerAdapter.createWorker(initData),
    );

    // Clear thread module cache — new program binary is different
    threadModuleCache.delete(pid);

    processes.set(pid, {
      memory: newMemory,
      programBytes,
      programModule,
      worker: replacementWorker,
      channelOffset: newChannelOffset,
      ptrWidth: newPtrWidth,
      layout: newLayout,
      threadAllocator: newThreadAllocator,
    });

    replacementWorker.on("error", (err: Error) =>
      finalizeUnexpectedWorkerError(pid, replacementWorker!, "exec worker error", err));

    // Forward worker-main top-level errors (instantiation failures,
    // uncaught wasm traps) so the host learns the process died — same
    // wiring as handleSpawn.
    replacementWorker.on("message", (raw: unknown) => {
      const m = raw as WorkerToHostMessage;
      if (m.type === "error" && m.pid === pid) {
        finalizeProcessWorkerError(pid, replacementWorker!, m.message);
      } else if (m.type === "exit" && m.pid === pid) {
        void finalizeProcessWorker(pid, replacementWorker!, m.status ?? 0);
      } else if (m.type === "vm_interrupt_timer" && m.pid === pid) {
        const process = processes.get(pid);
        if (process && process.worker === replacementWorker) {
          handleVmInterruptTimer(m, pid, process);
        }
      }
    });

    installCrashSafetyNet(replacementWorker, pid);
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      pid,
      newMemory,
      () => { (replacementWorker as DeferredWorkerHandle).start(); },
      () => { void replacementWorker?.terminate(); },
    );
    if (startDisposition === "stale") {
      throw new Error(`Exec pid ${pid} changed generation before Worker launch`);
    }
    if (startDisposition === "dead") {
      kernelWorker.finishProcessExecHandoff(pid);
      kernelWorker.finalizeExecHandoffTermination(pid);
      return 0;
    }
    kernelWorker.finishProcessExecHandoff(pid);
    return 0;
  } catch (err) {
    // A kernel trap can leave the commit point uncertain. We cannot safely
    // return to the caller, so invalidate the old generation before yielding
    // and report a truthful signal death.
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
    }
    try {
      kernelWorker.prepareProcessForExec(pid);
    } catch {
      // Continue with best-effort process death below.
    }
    if (replacementWorker && processes.get(pid)?.worker !== replacementWorker) {
      await terminateTrackedWorker(replacementWorker);
    }

    const message = err instanceof Error ? err.message : String(err);
    try {
      reportHostDiagnostic({
        pid,
        status: signalExitStatus(SIGSEGV),
        source: "exec post-commit transition",
        message: `[exec] post-commit transition failed: ${message}`,
      });
    } catch {
      // A closed host port must not prevent kernel-side reap.
    }
    try { kernelWorker.notifyHostProcessCrashed(pid, SIGSEGV); } catch { /* best-effort */ }
    try {
      handleExit(pid, signalExitStatus(SIGSEGV));
    } catch {
      try { kernelWorker.deactivateProcess(pid); } catch { /* best-effort */ }
    }
    return 0;
  }
}

/**
 * Handle SYS_SPAWN (non-forking posix_spawn).
 *
 * The kernel has already constructed the child Process descriptor in its
 * ProcessTable under `childPid` (with attrs and file actions applied).
 * This callback resolves the program bytes for `path`, allocates a fresh
 * Memory for the child, attaches it to the existing kernel Process, and
 * launches a Worker for it.
 *
 * Distinct from handleExec (which replaces the calling worker) and
 * handleFork (which clones the parent's Memory): handlePosixSpawn always
 * creates a fresh Memory and runs the new program from `_start`.
 *
 * Returns 0 on success, negative errno on failure (e.g. -ENOENT).
 */
/**
 * Pre-flight resolver for SYS_SPAWN. Side-effect-free: looks up program
 * bytes for `path` (via the same execPrograms map + main-thread fallback
 * `resolveExec` already uses for execve), follows shebangs, and compiles the
 * final Wasm module. Returns null on ENOENT and `{ errno }` when the located
 * target cannot be launched.
 *
 * `handleSpawn` in `host/src/kernel-worker.ts` calls this BEFORE
 * `kernel_spawn_process` so that file_actions (which the kernel runs
 * inside `spawn_child`) never execute on a doomed PATH iteration —
 * see the POSIX "exactly once" rule.
 */
async function handlePosixSpawnResolve(
  path: string,
  argv: string[],
): Promise<SpawnProgramResolution | null> {
  return resolveExecutableForLaunch(path, argv);
}

/**
 * Launch a worker for a SYS_SPAWN child whose program has already been
 * resolved and compiled by `handlePosixSpawnResolve`. The kernel has built
 * the child Process descriptor + applied file actions by the time we get
 * here, so this just allocates a Memory, registers the process, and spawns
 * the worker.
 */
async function handlePosixSpawn(
  parentPid: number,
  childPid: number,
  program: ResolvedSpawnProgram,
  envp: string[],
): Promise<number> {
  // Preserve a child that became a zombie before launch, but do not resurrect
  // it by registering a new execution generation.
  if (!kernelWorker.shouldLaunchPendingChild(childPid)) return 0;
  post({ type: "proc_event", kind: "spawn", pid: childPid, ppid: parentPid });

  const { programBytes, programModule, argv } = program;
  const ptrWidth = detectPtrWidth(programBytes);
  const {
    memory,
    layout,
    threadAllocator,
  } = createFreshProcessMemory(childPid, programBytes, ptrWidth);
  const channelOffset = layout.channelOffset;

  // The kernel already created the child Process via kernel_spawn_process.
  kernelWorker.registerProcess(childPid, memory, [channelOffset], {
    ptrWidth,
    brkBase: layout.brkBase,
    mmapBase: layout.mmapBase,
    maxAddr: layout.maxAddr,
  });

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: childPid,
    programBytes,
    programModule,
    memory,
    channelOffset,
    argv,
    env: envp,
    ptrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
  };

  const newWorker = new DeferredWorkerHandle(
    () => workerAdapter.createWorker(initData),
  );
  processes.set(childPid, {
    memory,
    programBytes,
    programModule,
    worker: newWorker,
    channelOffset,
    ptrWidth,
    layout,
    threadAllocator,
  });

  newWorker.on("error", (err: Error) => finalizeUnexpectedWorkerError(childPid, newWorker, "spawn worker error", err));

  newWorker.on("message", (raw: unknown) => {
    const m = raw as WorkerToHostMessage;
    if (m.type === "error" && m.pid === childPid) {
      finalizeProcessWorkerError(childPid, newWorker, m.message);
    } else if (m.type === "exit" && m.pid === childPid) {
      void finalizeProcessWorker(childPid, newWorker, m.status ?? 0);
    } else if (m.type === "vm_interrupt_timer" && m.pid === childPid) {
      const process = processes.get(childPid);
      if (process?.worker === newWorker) {
        handleVmInterruptTimer(m, childPid, process);
      }
    }
  });

  installCrashSafetyNet(newWorker, childPid);

  try {
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      childPid,
      memory,
      () => { newWorker.start(); },
      () => { void newWorker.terminate(); },
    );
    if (startDisposition === "stale") {
      throw new Error(`Spawn child ${childPid} changed generation before Worker launch`);
    }
  } catch (error) {
    if (processes.get(childPid)?.worker === newWorker) {
      processes.delete(childPid);
      threadModuleCache.delete(childPid);
      ptyByPid.delete(childPid);
      vmInterruptTimers.clear(childPid);
    }
    void newWorker.terminate();
    throw error;
  }

  return 0;
}

async function handleClone(
  attachment: ThreadChannelAttachment,
): Promise<void> {
  const { pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory } =
    attachment;
  const processInfo = processes.get(pid);
  if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);

  // Auto-compile thread module if not already cached per-PID
  let threadModule = threadModuleCache.get(pid);
  let cacheCompiledModule = false;
  if (!threadModule) {
    const patched = patchWasmForThread(processInfo.programBytes);
    threadModule = await WebAssembly.compile(patched);
    cacheCompiledModule = true;
  }

  // Compilation yields. A sibling pthread may have committed exec while this
  // clone continuation was suspended; never attach the old program/Memory to
  // the replacement exec image for the same process identity.
  if (!isCurrentProcessGeneration(
    processes,
    pid,
    processInfo,
    memory,
    kernelWorker.isExecHandoffActive(pid),
  ) || !kernelWorker.isProcessExecutionActive(pid)) {
    throw new Error(`Process ${pid} changed generation during clone`);
  }
  if (cacheCompiledModule) threadModuleCache.set(pid, threadModule);

  let alloc: ReturnType<ThreadPageAllocator["allocate"]>;
  try {
    alloc = processInfo.threadAllocator.allocate(memory);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportHostDiagnostic({
      pid,
      source: "clone allocation",
      message: `[kernel-worker] pid=${pid}: ${message}`,
    });
    throw e;
  }
  // Register fnPtr/argPtr so that handleFork can route a fork() from
  // this thread back through its entry point (see ForkFromThreadContext
  // in kernel-worker.ts).
  try {
    kernelWorker.attachThreadChannel(attachment, alloc.channelOffset);
  } catch (err) {
    processInfo.threadAllocator.free(alloc.basePage);
    throw err;
  }

  const threadInitData: CentralizedThreadInitMessage = {
    type: "centralized_thread_init",
    pid,
    tid,
    programBytes: processInfo.programBytes,
    programModule: threadModule,
    memory,
    processChannelOffset: processInfo.channelOffset,
    channelOffset: alloc.channelOffset,
    fnPtr,
    argPtr,
    stackPtr,
    tlsPtr,
    ctidPtr,
    tlsOffset: alloc.tlsOffset,
    tlsAllocAddr: alloc.tlsAllocAddr,
    ptrWidth: processInfo.ptrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
  };

  const threadWorker = new DeferredWorkerHandle(
    () => workerAdapter.createWorker(threadInitData),
  );
  if (!threadWorkers.has(pid)) threadWorkers.set(pid, []);
  const threadEntry: ThreadWorkerInfo = {
    worker: threadWorker,
    channelOffset: alloc.channelOffset,
    tid,
    basePage: alloc.slotStartPage,
  };
  threadWorkers.get(pid)!.push(threadEntry);

  const belongsToCurrentProcessImage = () =>
    isCurrentProcessGeneration(
      processes,
      pid,
      processInfo,
      memory,
      kernelWorker.isExecHandoffActive(pid),
    );
  let reclaimed = false;
  const reclaimThread = () => {
    if (reclaimed) return;
    reclaimed = true;
    processInfo.threadAllocator.free(alloc.basePage);
    if (belongsToCurrentProcessImage()) {
      threadExits.release(pid, alloc.channelOffset);
    }
    removeThreadWorkerRegistryEntry(threadWorkers, pid, threadEntry);
  };
  const terminateThreadEntry = (): Promise<void> => {
    if (!threadEntry.termination) {
      threadEntry.termination = terminateTrackedWorker(threadWorker).finally(reclaimThread);
    }
    return threadEntry.termination;
  };
  threadExits.register(pid, alloc.channelOffset, terminateThreadEntry);

  const isCurrentThreadGeneration = () =>
    !intentionallyTerminated.has(threadWorker as object)
    && belongsToCurrentProcessImage();
  const failThread = (reason: string) => {
    if (!isCurrentThreadGeneration()) {
      void terminateThreadEntry();
      return;
    }
    const disposition = threadWorkerFailureDisposition(reason);
    reportHostDiagnostic({
      pid,
      status: disposition.kind === "guest-fatal-trap"
        ? disposition.exitStatus
        : undefined,
      source: "thread worker failure",
      message: `[kernel-worker] pid=${pid} tid=${tid}: ${reason}`,
    });
    kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
    void terminateThreadEntry();
    if (disposition.kind === "guest-fatal-trap") {
      try { kernelWorker.notifyHostProcessCrashed(pid, disposition.signum); } catch { /* best-effort */ }
      void finishProcessExit(pid, disposition.exitStatus);
    }
  };
  threadWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "thread_exit") {
      if (!isCurrentThreadGeneration()) {
        void terminateThreadEntry();
        return;
      }
      void terminateThreadEntry();
    } else if (m.type === "error") {
      failThread(m.message);
    } else if (m.type === "vm_interrupt_timer") {
      if (isCurrentThreadGeneration() && m.pid === pid) {
        handleVmInterruptTimer(m, pid, processInfo);
      }
    }
  });
  threadWorker.on("error", (err: Error) => failThread(`worker error: ${err.message ?? err}`));

  let startDisposition: ReturnType<
    CentralizedKernelWorker["startProcessWorkerWhenRunnable"]
  >;
  try {
    startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      pid,
      memory,
      () => { threadWorker.start(); },
      () => { void threadWorker.terminate(); },
      () => {
        kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
        const failedClone = kernelWorker.failDeferredCloneLaunch(pid, tid, 12);
        void terminateThreadEntry();
        return failedClone;
      },
    );
  } catch (error) {
    kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
    void terminateThreadEntry();
    throw error;
  }
  if (startDisposition === "stale") {
    void terminateThreadEntry();
    throw new Error(`Process ${pid} changed generation before thread Worker launch`);
  }

}

function handleThreadExit(pid: number, channelOffset: number): boolean {
  return threadExits.requestExit(pid, channelOffset);
}

function handleExit(pid: number, exitStatus: number): void {
  void finishProcessExit(pid, exitStatus, processes.get(pid)?.worker);
}

async function finishProcessExit(
  pid: number,
  exitStatus: number,
  expectedWorker = processes.get(pid)?.worker,
): Promise<void> {
  if (!expectedWorker) return;
  const info = processes.get(pid);
  if (!info || info.worker !== expectedWorker) return;
  vmInterruptTimers.clear(pid);

  const existingTeardown = processTeardowns.get(expectedWorker);
  if (existingTeardown) {
    reportProcessExit(pid, exitStatus);
    return;
  }

  const teardown = (async () => {
    // Keep the pid registered until the process worker is gone. musl's
    // _Exit() loops on SYS_exit after SYS_exit_group returns; while worker
    // termination is in flight those duplicate exits still need channel
    // completions, otherwise the worker can park in Atomics.wait with no
    // registered listener left to wake it.
    await terminateThreadWorkers(pid);
    await terminateTrackedWorker(expectedWorker);

    // Exec may have installed a replacement while old worker termination was
    // settling. Never apply pid-wide cleanup to a different generation.
    if (processes.get(pid)?.worker !== expectedWorker) return;

    // Deactivate process (zombie until reaped or destroy) after worker
    // termination so no further guest syscalls can arrive on its channel.
    kernelWorker.deactivateProcess(pid);

    processes.delete(pid);
    threadModuleCache.delete(pid);
    ptyByPid.delete(pid);
  })();
  processTeardowns.set(expectedWorker, teardown);

  // The process is already a kernel-side zombie at this point. Report the
  // exit before worker-thread teardown so a slow termination cannot make
  // NodeKernelHost.spawn() look like the guest process never exited. The
  // teardown promise remains tracked so destroy() still waits for cleanup.
  reportProcessExit(pid, exitStatus);

  try {
    await teardown;
  } finally {
    processTeardowns.delete(expectedWorker);
  }
}

// --- Terminate ---

async function handleTerminate(msg: TerminateProcessMessage) {
  const pid = msg.pid;
  vmInterruptTimers.clear(pid);

  // Terminate thread workers
  const threads = threadWorkers.get(pid);
  if (threads) {
    for (const t of threads) {
      intentionallyTerminated.add(t.worker as object);
      await t.worker.terminate().catch(() => {});
      try {
        kernelWorker.notifyThreadExit(pid, t.tid);
        kernelWorker.removeChannel(pid, t.channelOffset);
      } catch {}
    }
    threadWorkers.delete(pid);
  }

  // Terminate main process worker
  const info = processes.get(pid);
  if (info?.worker) {
    await terminateTrackedWorker(info.worker);
  }

  try {
    kernelWorker.unregisterProcess(pid);
  } catch {}

  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);
  respond(msg.requestId, true);
}

// --- Destroy ---

async function handleDestroy(msg: { requestId: number }) {
  // [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — WORKAROUND, remove when the engine bug
  // is fixed; see docs/jsc-terminate-atomics-wait-workaround.md.
  //
  // On JSC-based runtimes, `Worker.terminate()` cannot free a worker parked in
  // Atomics.wait on its syscall channel — the state every blocked process/thread
  // worker sits in — so terminating them directly leaks their threads + committed
  // memory. This host entry backs BOTH Node.js (V8) and Bun (JSC); on Bun the
  // leak is live, so we must first wake every blocked worker into a cooperative
  // exit (killAllBlockedForTeardown queues SIGKILL + EINTR; the guest glue runs
  // kernel_exit → wasm trap → the worker idles → terminate() reclaims it). This
  // is harmless on V8, so we do it unconditionally rather than sniff the engine,
  // matching the browser host (which does the same and is likewise a no-op cost
  // on Chrome/V8). Phases mirror browser-kernel-worker-entry.ts handleDestroy.
  let woken = new Set<number>();
  try { woken = kernelWorker.killAllBlockedForTeardown(); } catch (e) {
    console.error(`[node-kernel-worker] killAllBlockedForTeardown failed: ${e}`);
  }
  // Drain only for the pids we woke — a process we did not wake (e.g. one
  // already exited via a sibling thread) never posts {exit} and is
  // force-terminated below instead of waited on.
  const drainDeadline = Date.now() + DESTROY_KILL_DRAIN_TIMEOUT_MS;
  const stillDraining = () => {
    for (const pid of woken) if (processes.has(pid)) return true;
    return false;
  };
  while (stillDraining() && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, DESTROY_KILL_DRAIN_POLL_MS));
  }
  if (stillDraining()) {
    console.warn(`[node-kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating`);
  }

  const processEntries = [...processes.entries()];
  for (const [pid, info] of processEntries) {
    vmInterruptTimers.clear(pid);
    await terminateThreadWorkers(pid);
    await terminateTrackedWorker(info.worker);
    try { kernelWorker.unregisterProcess(pid); } catch {}
  }
  await Promise.allSettled([...processTeardowns.values()]);
  // Process workers can still have pthread/JS-worker children. Terminate
  // them explicitly before clearing the map so destroy does not leave worker
  // threads keeping the Vitest fork alive.
  for (const threads of threadWorkers.values()) {
    for (const t of threads) {
      intentionallyTerminated.add(t.worker as object);
      t.worker.terminate().catch(() => {});
    }
  }
  processes.clear();
  vmInterruptTimers.clearAll();
  processTeardowns.clear();
  reportedExits.clear();
  threadModuleCache.clear();
  threadWorkers.clear();
  ptyByPid.clear();
  cleanupSessionDir();
  respond(msg.requestId, true);
}

// --- PTY ---

function handlePtyWrite(pid: number, data: Uint8Array) {
  const ptyIdx = ptyByPid.get(pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptyMasterWrite(ptyIdx, data);
}

function handlePtyResize(pid: number, rows: number, cols: number) {
  const ptyIdx = ptyByPid.get(pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptySetWinsize(ptyIdx, rows, cols);
}

// --- External HTTP request bridge ---

async function handleHttpRequest(msg: HttpRequestMessage) {
  try {
    const response = await kernelWorker.sendHttpRequest(
      msg.port,
      msg.request,
      { timeoutMs: msg.timeoutMs },
    );
    respond(msg.requestId, response);
  } catch (e) {
    respondError(msg.requestId, String(e));
  }
}

// --- Message dispatch ---

port.on("message", (msg: MainToKernelMessage) => {
  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "spawn":
      handleSpawn(msg);
      break;
    case "append_stdin_data":
      kernelWorker.appendStdinData(msg.pid, msg.data);
      break;
    case "set_stdin_data":
      kernelWorker.setStdinData(msg.pid, msg.data);
      break;
    case "pty_write":
      handlePtyWrite(msg.pid, msg.data);
      break;
    case "pty_resize":
      handlePtyResize(msg.pid, msg.rows, msg.cols);
      break;
    case "terminate_process":
      void handleTerminate(msg);
      break;
    case "destroy":
      void handleDestroy(msg);
      break;
    case "get_fork_count": {
      // Round-trip access to the kernel's per-process fork counter for
      // tests asserting SYS_SPAWN didn't fall back to fork. Result is a
      // u64 BigInt (kernel returns u64::MAX as a "pid not found" sentinel).
      try {
        const count = kernelWorker.getForkCount(msg.pid);
        post({ type: "response", requestId: msg.requestId, result: count });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "enum_procs": {
      // Snapshot the kernel's process table for the Inspector → Procs tab.
      // Mirrors the Browser-side handler in browser-kernel-worker-entry.ts.
      try {
        post({ type: "response", requestId: msg.requestId, result: kernelWorker.enumProcs() });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "read_proc_maps": {
      try {
        post({ type: "response", requestId: msg.requestId, result: kernelWorker.readProcMaps(msg.pid) });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "set_syscall_trace": {
      if (msg.enabled) kernelWorker.enableSyscallTrace();
      else kernelWorker.disableSyscallTrace();
      break;
    }
    case "drain_syscall_trace": {
      try {
        post({ type: "response", requestId: msg.requestId, result: kernelWorker.drainSyscallTrace() });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "resolve_exec_response": {
      const resolve = pendingExecResolves.get(msg.requestId);
      if (resolve) {
        pendingExecResolves.delete(msg.requestId);
        resolve(msg.programBytes);
      }
      break;
    }
    case "http_request":
      handleHttpRequest(msg);
      break;
    case "kms_attach_canvas":
      kernelWorker.attachKmsCanvas(msg.crtcId, msg.canvas, msg.stats, msg.opts);
      break;
    case "kms_attach_stats":
      kernelWorker.attachKmsStats(msg.crtcId, msg.stats);
      break;
    default: {
      const exhaustive: never = msg;
      void exhaustive;
      reportWorkerProtocolError(
        `unknown main-thread message type: ${String((msg as { type?: unknown }).type)}`,
      );
      break;
    }
  }
});
