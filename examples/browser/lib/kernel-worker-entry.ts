/**
 * Kernel Worker Entry Point — Dedicated web worker that hosts the
 * CentralizedKernelWorker and manages all process lifecycle.
 *
 * The main thread is a thin UI proxy; this worker owns the kernel Wasm
 * instance, process spawning (fork/exec/clone), and the HTTP connection pump.
 */

// Polyfill setImmediate for the web worker context.
// CentralizedKernelWorker uses setImmediate for yielding between syscall
// batches and waking blocked retries. In a dedicated worker there's no UI
// to starve, so we can use a simple MessageChannel polyfill.
if (typeof globalThis.setImmediate === "undefined") {
  const _immQueue: Array<{ id: number; fn: (...args: any[]) => void; args: any[] }> = [];
  let _immNextId = 0;
  let _immScheduled = false;
  let _immFlushing = false;
  const _immCancelled = new Set<number>();

  const _immChannel = new MessageChannel();
  _immChannel.port1.onmessage = _immFlush;

  function _immFlush() {
    _immScheduled = false;
    _immFlushing = true;
    // Process only items queued at flush start — items added during the flush
    // are deferred to a new macrotask so onmessage handlers can interleave.
    const count = _immQueue.length;
    for (let i = 0; i < count && _immQueue.length > 0; i++) {
      const entry = _immQueue.shift()!;
      if (_immCancelled.has(entry.id)) {
        _immCancelled.delete(entry.id);
        continue;
      }
      try {
        entry.fn(...entry.args);
      } catch (e) {
        console.error("[setImmediate] callback threw:", e);
      }
    }
    _immFlushing = false;
    // Schedule another flush if new items were added during processing
    if (_immQueue.length > 0 && !_immScheduled) {
      _immScheduled = true;
      _immChannel.port2.postMessage(null);
    }
  }

  (globalThis as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) => {
    const id = ++_immNextId;
    _immQueue.push({ id, fn, args });
    if (!_immScheduled && !_immFlushing) {
      _immScheduled = true;
      _immChannel.port2.postMessage(null);
    }
    return id;
  };
  (globalThis as any).clearImmediate = (id: number) => {
    _immCancelled.add(id);
  };
}

import { CentralizedKernelWorker } from "../../../host/src/kernel-worker";
import { BrowserWorkerAdapter } from "../../../host/src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../../host/src/vfs/vfs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { DeviceFileSystem } from "../../../host/src/vfs/device-fs";
import { BrowserTimeProvider } from "../../../host/src/vfs/time";
import {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
} from "../../../host/src/vfs/default-mounts";
import type { MountConfig } from "../../../host/src/vfs/types";
import { TlsNetworkBackend } from "./tls-network-backend";
import { patchWasmForThread } from "../../../host/src/worker-main";
import { detectPtrWidth, extractHeapBase } from "../../../host/src/constants";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../../host/src/worker-protocol";
import { ThreadPageAllocator } from "../../../host/src/thread-allocator";
import type {
  MainToKernelMessage,
  KernelToMainMessage,
} from "./kernel-worker-protocol";

const DEFAULT_MAX_PAGES = 16384;
const PAGE_SIZE = 65536;
const CH_TOTAL_SIZE = 72 + PAGE_SIZE;
const ASYNCIFY_BUF_SIZE = 16384;

// State
let kernelWorker: CentralizedKernelWorker;
let workerAdapter: BrowserWorkerAdapter;
let memfs: MemoryFileSystem;
let io: VirtualPlatformIO;
let maxPages = DEFAULT_MAX_PAGES;
let defaultEnv: string[] = [];
let threadAllocator: ThreadPageAllocator;

// Process tracking
interface ProcessInfo {
  memory: WebAssembly.Memory;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  channelOffset: number;
  ptrWidth: 4 | 8;
}
const processes = new Map<number, ProcessInfo>();

/**
 * Workers we deliberately terminated — exec, exit, top-level destroy. The
 * synthesized "exit" event from {@link BrowserWorkerHandle} fires on
 * `worker.terminate()` indistinguishably from an unexpected death; this
 * WeakSet lets the crash detector skip the deliberate cases. Mirrors the
 * `intentionallyTerminated` set on the Node host (PR #410).
 */
const intentionallyTerminated = new WeakSet<object>();

/**
 * Create shared memory sized for a wasm32 or wasm64 process. wasm64 modules
 * import memory with `address: 'i64'`; instantiation fails with a LinkError
 * if the shared memory was allocated as i32.
 */
function createProcessMemory(ptrWidth: 4 | 8, pages: number): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(pages),
      maximum: BigInt(pages),
      shared: true,
      address: "i64",
    } as unknown as WebAssembly.MemoryDescriptor);
  }
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

// Per-PID thread module cache: lazily compiled on first clone(), shared across
// all threads of the same process. Keyed by PID of the process that spawned threads.
const threadModuleCache = new Map<number, WebAssembly.Module>();
const threadWorkers = new Map<number, Array<{
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  channelOffset: number;
  tid: number;
}>>();
const ptyByPid = new Map<number, number>();

// Kernel wasm exports cache
let kernelInstance: WebAssembly.Instance | null = null;
let kernelMemory: WebAssembly.Memory | null = null;

// HTTP bridge port (transferred from main thread → service worker comms)
let bridgePort: MessagePort | null = null;
let bridgeTargetPort: number | null = null; // The specific HTTP port to route bridge requests to

function post(msg: KernelToMainMessage, transfer?: Transferable[]) {
  (globalThis as any).postMessage(msg, transfer ?? []);
}

function respond(requestId: number, result: unknown) {
  post({ type: "response", requestId, result });
}

function respondError(requestId: number, error: string) {
  post({ type: "response", requestId, result: null, error });
}

/**
 * Copy `/etc/*` files from a freshly-loaded `rootfs.vfs` image into the
 * given memfs. Existing files are NOT overwritten — the demo keeps any
 * /etc files it wrote itself (e.g. `/etc/profile`, `/etc/gitconfig`).
 *
 * This is the legacy-SAB-path counterpart to mounting rootfs.vfs at /:
 * because the legacy path keeps a single demo-controlled SAB at /, we
 * physically copy the canonical /etc files in instead of layering a
 * second mount. The kernel's `synthetic_file_content` shim that used
 * to serve these paths in-kernel was removed in PR 4/5.
 */
function overlayEtcFromRootfs(target: MemoryFileSystem, rootfsImage: Uint8Array): void {
  const source = MemoryFileSystem.fromImage(rootfsImage);

  // Ensure /etc exists in the target.
  try { target.mkdir("/etc", 0o755); } catch { /* exists */ }

  let dh: number;
  try { dh = source.opendir("/etc"); }
  catch { return; /* no /etc in image — nothing to overlay */ }

  try {
    while (true) {
      const entry = source.readdir(dh);
      if (entry === null) break;
      if (entry.name === "." || entry.name === "..") continue;
      const sourcePath = `/etc/${entry.name}`;
      const targetPath = sourcePath;

      // Skip if the demo already wrote this file — preserve demo intent.
      let exists = false;
      try { target.stat(targetPath); exists = true; } catch {}
      if (exists) continue;

      // Only handle regular files for now; the canonical rootfs/etc/*
      // is flat (no subdirs, no symlinks).
      const st = source.stat(sourcePath);
      const isRegular = (st.mode & 0xf000) === 0x8000;
      if (!isRegular) continue;

      // Read full content (sequential — pass null offset for read/write
      // semantics rather than pread/pwrite).
      const fdR = source.open(sourcePath, 0, 0); // O_RDONLY
      const size = st.size;
      const buf = new Uint8Array(size);
      let read = 0;
      while (read < size) {
        const n = source.read(fdR, buf.subarray(read), null, size - read);
        if (n <= 0) break;
        read += n;
      }
      source.close(fdR);

      // Write into target.
      const fdW = target.open(targetPath, 0o1101 /* O_WRONLY|O_CREAT|O_TRUNC */, st.mode & 0o777);
      if (read > 0) target.write(fdW, buf.subarray(0, read), null, read);
      target.close(fdW);
    }
  } finally {
    source.closedir(dh);
  }
}

// ── Init ──

async function handleInit(msg: Extract<MainToKernelMessage, { type: "init" }>) {
  maxPages = msg.config.maxMemoryPages;
  threadAllocator = new ThreadPageAllocator(maxPages);
  defaultEnv = msg.config.env;

  // Create VFS — prefer pre-built image bytes (kernel-owned FS); fall back
  // to the legacy shared-SAB path so the existing demos keep working.
  //
  // vfsImage path (Task 4.4): apply DEFAULT_MOUNT_SPEC via resolveForBrowser,
  // giving 8 mounts — / from the image, plus scratch memfs at /tmp, /var/tmp,
  // /var/log, /var/run, /home/user, /root, /srv. Layer /dev/shm and /dev on
  // top: those are browser-platform internals (POSIX semaphore SAB,
  // kernel devices) not part of the canonical spec.
  //
  // Legacy fsSab path keeps the prior 3-mount layout intact — its caller
  // controls the rootfs contents directly via kernel.fs and would lose
  // control if the spec dictated additional scratch mounts.
  const shmfs = MemoryFileSystem.fromExisting(msg.shmSab);
  const devfs = new DeviceFileSystem();
  let mounts: MountConfig[];
  if (msg.vfsImage) {
    const specMounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, msg.vfsImage);
    const rootMount = specMounts.find((m) => m.mountPoint === "/");
    if (!rootMount) throw new Error("DEFAULT_MOUNT_SPEC missing / mount");
    memfs = rootMount.backend as MemoryFileSystem;
    mounts = [
      { mountPoint: "/dev/shm", backend: shmfs },
      { mountPoint: "/dev", backend: devfs },
      ...specMounts,
    ];
  } else if (msg.fsSab) {
    memfs = MemoryFileSystem.fromExisting(msg.fsSab);
    // Overlay /etc/* from the canonical rootfs.vfs onto the SAB-backed
    // memfs. PR 4/5 removed `synthetic_file_content` from the kernel —
    // without this overlay, programs that call getpwnam/gethostbyname
    // (bash, git, curl, tar, nano, …) fail on legacy-SAB demos. Files
    // the demo already wrote (e.g. /etc/profile in shell.vfs) are not
    // overwritten.
    if (msg.rootfsImage) {
      try {
        overlayEtcFromRootfs(memfs, msg.rootfsImage);
      } catch (e) {
        console.error("[kernel-worker] Failed to overlay /etc from rootfs.vfs:", e);
      }
    }
    mounts = [
      { mountPoint: "/dev/shm", backend: shmfs },
      { mountPoint: "/dev", backend: devfs },
      { mountPoint: "/", backend: memfs },
    ];
  } else {
    throw new Error("init: vfsImage or fsSab required");
  }
  io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());

  // Create TLS-MITM network backend. Programs do real TLS handshakes via
  // their compiled-in OpenSSL; the backend terminates TLS locally, makes
  // real fetch() requests, and re-encrypts the responses.
  // In dev mode, use the vite CORS proxy middleware for cross-origin fetches.
  // In production, the service worker handles CORS proxying transparently.
  const devCorsProxy = import.meta.env.DEV ? "/cors-proxy?url=" : undefined;
  const tlsBackend = new TlsNetworkBackend(
    devCorsProxy ? { corsProxyUrl: devCorsProxy } : undefined,
  );
  await tlsBackend.init();
  io.network = tlsBackend;

  // Install the MITM CA certificate in the VFS so OpenSSL trusts it.
  const caCertPem = tlsBackend.getCACertPEM();
  try {
    // Demo images don't always include /etc — create the full chain.
    for (const dir of ["/etc", "/etc/ssl", "/etc/ssl/certs"]) {
      try { memfs.mkdir(dir, 0o755); } catch { /* exists */ }
    }
    const certBytes = new TextEncoder().encode(caCertPem);
    const certFd = memfs.open("/etc/ssl/certs/ca-certificates.crt", 0o1101, 0o644);
    memfs.write(certFd, certBytes, 0, certBytes.length);
    memfs.close(certFd);
  } catch (e) {
    console.error("[kernel-worker] Failed to write CA cert to VFS:", e);
  }

  // Create worker adapter for spawning sub-workers
  workerAdapter = new BrowserWorkerAdapter(msg.workerEntryUrl);

  // Create CentralizedKernelWorker
  kernelWorker = new CentralizedKernelWorker(
    {
      maxWorkers: msg.config.maxWorkers,
      dataBufferSize: PAGE_SIZE,
      useSharedMemory: true,
      enableSyscallLog: msg.config.enableSyscallLog,
      syscallLogPtrWidth: msg.config.syscallLogPtrWidth,
    },
    io,
    {
      onFork: (parentPid, childPid, parentMemory) =>
        handleFork(parentPid, childPid, parentMemory),
      onExec: async (pid, path, argv, envp) =>
        handleExec(pid, path, argv, envp),
      onResolveSpawn: async (path) => handlePosixSpawnResolve(path),
      onSpawn: async (childPid, programBytes, argv, envp) =>
        handlePosixSpawn(childPid, programBytes, argv, envp),
      onClone: (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) =>
        handleClone(pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory),
      onExit: (pid, exitStatus) => handleExit(pid, exitStatus),
    },
  );

  // In a dedicated worker, use Atomics.waitAsync directly — no V8 microtask
  // chain freeze bug (that's main-thread-only).
  kernelWorker.usePolling = false;
  // Process a small batch of syscalls via microtask before yielding to the
  // event loop via setImmediate. Batch size 8 is a good balance: it gives
  // ~8x throughput vs batch-1 while still yielding frequently enough for
  // pump timers, message handlers, and rendering to interleave.
  (kernelWorker as any).relistenBatchSize = 8;

  // Inject stdout/stderr/listen callbacks
  const kw = kernelWorker as any;
  const existingCallbacks = kw.kernel.callbacks || {};
  kw.kernel.callbacks = {
    ...existingCallbacks,
    onStdout: (data: Uint8Array) => post({ type: "stdout", pid: kw.currentHandlePid || 0, data }),
    onStderr: (data: Uint8Array) => post({ type: "stderr", pid: kw.currentHandlePid || 0, data }),
    onNetListen: (_fd: number, port: number, addr: [number, number, number, number]) => {
      const pid = kw.currentHandlePid;
      if (pid !== 0) {
        // Register the listener target for pickListenerTarget
        kw.startTcpListener(pid, _fd, port);
      }
      post({ type: "listen_tcp", pid, fd: _fd, port });
      return 0;
    },
  };

  await kernelWorker.init(msg.kernelWasmBytes);
  kernelInstance = kw.kernelInstance;
  kernelMemory = kw.kernelMemory;

  // /dev/fb0 forwarding: the registry lives in this worker, but the
  // canvas lives on the main thread. Translate bind/unbind events into
  // postMessage so a main-thread renderer can read pixels directly
  // from the process's wasm Memory SAB.
  kernelWorker.framebuffers.onChange((pid, ev) => {
    if (ev === "bind") {
      const b = kernelWorker.framebuffers.get(pid);
      const memory = kernelWorker.getProcessMemory(pid);
      if (!b || !memory) return;
      post({
        type: "fb_bind",
        pid,
        addr: b.addr,
        len: b.len,
        w: b.w,
        h: b.h,
        stride: b.stride,
        fmt: "BGRA32",
        memory,
      });
    } else {
      post({ type: "fb_unbind", pid });
    }
  });
  // memory.grow invalidates the previously-shared SAB; forward the new
  // Memory so the main-thread renderer rebuilds its view.
  const origRebind = kernelWorker.framebuffers.rebindMemory.bind(
    kernelWorker.framebuffers,
  );
  kernelWorker.framebuffers.rebindMemory = (pid: number) => {
    origRebind(pid);
    if (!kernelWorker.framebuffers.get(pid)) return;
    const memory = kernelWorker.getProcessMemory(pid);
    if (memory) post({ type: "fb_rebind_memory", pid, memory });
  };
  // Write-based fb deltas (fbDOOM-style): forward each pixel chunk
  // to the main thread, which mirrors them into its own registry.
  // The bytes here are non-shared (kernel.ts copies from the kernel
  // memory before invoking fbWrite), so they transfer cleanly.
  kernelWorker.framebuffers.onWrite((pid, offset, bytes) => {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    post(
      { type: "fb_write", pid, offset, bytes: new Uint8Array(buf) },
      [buf],
    );
  });

  // Accept bridge port for HTTP request handling
  if (msg.bridgePort) {
    bridgePort = msg.bridgePort;
  }

  post({ type: "ready" });
}

// ── Spawn ──

function handleSpawn(msg: Extract<MainToKernelMessage, { type: "spawn" }>) {
  try {
    let programBytes: ArrayBuffer;
    if (msg.programBytes) {
      programBytes = msg.programBytes;
    } else if (msg.programPath) {
      // Read from shared filesystem
      const bytes = readFileFromFs(msg.programPath);
      if (!bytes) {
        respondError(msg.requestId, `ENOENT: ${msg.programPath}`);
        return;
      }
      programBytes = bytes;
    } else {
      respondError(msg.requestId, "No programBytes or programPath");
      return;
    }

    // Pid: if the caller pre-picked one, honor it (legacy spawn() callers
    // still do); otherwise the worker is the source of truth and allocates.
    const pid = msg.pid ?? kernelWorker.allocatePid();
    const pages = msg.maxPages ?? maxPages;
    const ptrWidth = detectPtrWidth(programBytes);
    const memory = createProcessMemory(ptrWidth, pages);
    const channelOffset = (pages - 2) * PAGE_SIZE;
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernelWorker.registerProcess(pid, memory, [channelOffset], {
      ptrWidth,
      argv: msg.argv,
    });

    // Install the program's `__heap_base` as the initial brk before the
    // process worker is spawned (matches handleSpawn in
    // host/src/node-kernel-worker-entry.ts). Without this the kernel's
    // hardcoded INITIAL_BRK can land inside the program's stack region
    // for binaries with a large data section (e.g. mariadbd) — see
    // docs/architecture.md "Heap initialization (brk)".
    const heapBase = extractHeapBase(programBytes);
    if (heapBase !== null) {
      kernelWorker.setBrkBase(pid, heapBase);
    }

    if (msg.cwd) {
      kernelWorker.setCwd(pid, msg.cwd);
    }

    if (msg.pty) {
      const ptyIdx = kernelWorker.setupPty(pid);
      ptyByPid.set(pid, ptyIdx);
    } else if (msg.stdin) {
      const stdinData = msg.stdin instanceof Uint8Array ? msg.stdin : new Uint8Array(msg.stdin);
      kernelWorker.setStdinData(pid, stdinData);
    }

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes,
      memory,
      channelOffset,
      env: msg.env ?? defaultEnv,
      argv: msg.argv,
      cwd: msg.cwd,
      ptrWidth,
    };

    const worker = workerAdapter.createWorker(initData);
    processes.set(pid, { memory, programBytes, worker, channelOffset, ptrWidth });

    installProcessWorkerListeners(worker, pid);

    respond(msg.requestId, pid);
  } catch (e) {
    respondError(msg.requestId, String(e));
  }
}

/**
 * Wire the four ways a process worker can die so the kernel's view of
 * the process matches reality: worker-level uncaught error, worker-main
 * `{type:"error"}` (instantiation/init failure), worker-main
 * `{type:"exit"}` (_start returned without SYS_exit_group, or an
 * "unreachable" trap that worker-main treated as a normal exit), and
 * the synthesized "exit" event from {@link BrowserWorkerHandle} when
 * `worker.onerror` fires or `terminate()` is called externally.
 *
 * Without this, a wasm trap inside a process would post `{type:"exit"}`
 * to the main thread, but the kernel would still see the process as
 * alive — any `waitpid()` in the parent (e.g. dinit waiting on a child,
 * php-fpm master waiting on a worker) would block forever, and the
 * whole demo appears hung.
 *
 * Mirrors the wiring on the Node side (`installCrashSafetyNet` +
 * per-handler "error"/"exit" message routing in
 * `host/src/node-kernel-worker-entry.ts`, PR #410).
 */
function installProcessWorkerListeners(
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>,
  pid: number,
): void {
  let exited = false;
  const finalize = (status: number, source: string) => {
    if (exited) return;
    exited = true;
    if (processes.get(pid)?.worker !== worker) return; // already replaced (e.g. by exec)
    console.warn(`[kernel-worker] pid=${pid} ${source} → forcing exit ${status}`);
    handleExit(pid, status);
  };

  // Status conventions match the Node host (PR #410):
  //   139 = 128 + SIGSEGV (11) — uncaught wasm trap, worker died without
  //         a SYS_exit_group. Matches a Linux child killed by SIGSEGV.
  //   -1  — worker-main caught an instantiation/init error and posted
  //         {type:"error"}. Same convention as Node-side handleSpawn.
  //   m.status — worker-main posted {type:"exit"}, normal exit path.
  worker.on("error", (err: Error) => {
    if (intentionallyTerminated.has(worker as object)) return;
    console.error(`[kernel-worker] Worker error pid=${pid}:`, err.message);
    finalize(128 + 11, "worker.onerror");
  });
  worker.on("exit", (code: number) => {
    // BrowserWorkerHandle synthesizes an "exit" event when the underlying
    // Worker dies via onerror or external terminate(). worker-main itself
    // never triggers this — it posts {type:"exit"} via postMessage instead.
    // Skip the synthesized event when we're the ones terminating (exec,
    // explicit exit/destroy/terminate_process); otherwise we'd tear down
    // kernel state for a process that's still alive in a new wasm worker.
    if (intentionallyTerminated.has(worker as object)) return;
    // BrowserWorkerHandle synthesizes code=1 from onerror; we already
    // finalized via the "error" handler above, so this is a no-op there.
    // If "exit" fires without a prior "error" (worker died via some path
    // we don't yet model), still treat it as a crash.
    finalize(128 + 11, "worker exit event");
  });
  worker.on("message", (msg: unknown) => {
    const m = msg as { type?: string; message?: string; pid?: number; status?: number };
    if (m.type === "error") {
      console.error(`[kernel-worker] Process error pid=${pid}:`, m.message);
      // Forward to host stderr so the demo log shows the actual failure
      // ("Centralized worker failed: …" with the wasm trap or
      // instantiation error). Without this, a process death in the
      // browser is invisible to the user — only console.error in the
      // kernel-worker scope, which most users don't open. Mirrors the
      // Node-side handleSpawn message-listener stderr forwarding.
      const errBytes = new TextEncoder().encode(
        `[process-worker] ${m.message ?? "unknown error"}\n`,
      );
      post({ type: "stderr", pid, data: errBytes });
      finalize(-1, "worker-main error message");
    } else if (m.type === "exit") {
      finalize(m.status ?? 0, "worker-main exit message");
    }
  });
}

// ── Process lifecycle callbacks ──

async function handleFork(
  parentPid: number,
  childPid: number,
  parentMemory: WebAssembly.Memory,
): Promise<number[]> {
  const parentInfo = processes.get(parentPid);
  if (!parentInfo) throw new Error(`Unknown parent pid ${parentPid}`);

  // Pre-compile module for TurboFan-optimized code (smaller stack frames).
  if (!parentInfo.programModule) {
    parentInfo.programModule = await WebAssembly.compile(parentInfo.programBytes);
  }

  const parentBuf = new Uint8Array(parentMemory.buffer);
  const parentPages = Math.ceil(parentBuf.byteLength / PAGE_SIZE);
  const ptrWidth = parentInfo.ptrWidth;
  // Fork inherits the parent's memory arch. wasm64 children need i64 memory
  // to match the parent's module imports.
  const childMemory = ptrWidth === 8
    ? new WebAssembly.Memory({
        initial: BigInt(parentPages),
        maximum: BigInt(maxPages),
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor)
    : new WebAssembly.Memory({
        initial: parentPages,
        maximum: maxPages,
        shared: true,
      });
  if (parentPages < maxPages) {
    if (ptrWidth === 8) {
      childMemory.grow(BigInt(maxPages - parentPages) as unknown as number);
    } else {
      childMemory.grow(maxPages - parentPages);
    }
  }
  new Uint8Array(childMemory.buffer).set(parentBuf);

  const childChannelOffset = (maxPages - 2) * PAGE_SIZE;
  new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
    skipKernelCreate: true,
    ptrWidth,
  });

  const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
  const childInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: childPid,
    ppid: parentPid,
    programBytes: parentInfo.programBytes,
    programModule: parentInfo.programModule,
    memory: childMemory,
    channelOffset: childChannelOffset,
    isForkChild: true,
    asyncifyBufAddr,
    ptrWidth,
  };

  const childWorker = workerAdapter.createWorker(childInitData);

  processes.set(childPid, {
    memory: childMemory,
    programBytes: parentInfo.programBytes,
    programModule: parentInfo.programModule,
    worker: childWorker,
    channelOffset: childChannelOffset,
    ptrWidth,
  });

  installProcessWorkerListeners(childWorker, childPid);

  return [childChannelOffset];
}

async function handleExec(
  pid: number,
  path: string,
  argv: string[],
  envp: string[],
): Promise<number> {
  // Materialize lazy file if needed (async fetch avoids sync XHR + SW deadlock)
  await memfs.ensureMaterialized(path);

  // Read binary from the shared filesystem
  const bytes = readFileFromFs(path);
  if (!bytes) return -2; // ENOENT

  // Program found — run kernel exec setup
  const setupResult = kernelWorker.kernelExecSetup(pid);
  if (setupResult < 0) return setupResult;

  kernelWorker.prepareProcessForExec(pid);

  // Terminate old worker. Mark it as intentionally terminated *before*
  // calling terminate(): the synthesized "exit" event from
  // BrowserWorkerHandle would otherwise fire installProcessWorkerListeners'
  // crash detector and tear down the kernel's view of the still-alive
  // (post-exec) process.
  const oldInfo = processes.get(pid);
  if (oldInfo?.worker) {
    intentionallyTerminated.add(oldInfo.worker as object);
    await oldInfo.worker.terminate().catch(() => {});
  }

  // DIAGNOSTIC: track pid → exec path so the sysprof dump can name
  // each pid (otherwise the table is just opaque numbers).
  {
    const g = globalThis as { __pidMap?: Map<number, string> };
    if (!g.__pidMap) g.__pidMap = new Map();
    g.__pidMap.set(pid, path);
  }
  // Create fresh memory sized for the new binary's arch (exec across
  // wasm32↔wasm64 replaces the process image — memory type must match).
  const ptrWidth = detectPtrWidth(bytes);
  const newMemory = createProcessMemory(ptrWidth, maxPages);
  const newChannelOffset = (maxPages - 2) * PAGE_SIZE;
  new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
    skipKernelCreate: true,
    ptrWidth,
  });

  // Re-install the new program's `__heap_base` post-exec — the kernel
  // reset the brk in deserialize_exec_state (POSIX-correct), so the new
  // program would otherwise see the fallback INITIAL_BRK. Mirrors
  // handleExec in host/src/node-kernel-worker-entry.ts.
  const execHeapBase = extractHeapBase(bytes);
  if (execHeapBase !== null) {
    kernelWorker.setBrkBase(pid, execHeapBase);
  }

  const execInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes: bytes,
    memory: newMemory,
    channelOffset: newChannelOffset,
    argv,
    env: envp,
    ptrWidth,
  };

  const newWorker = workerAdapter.createWorker(execInitData);

  // Clear cached thread module — the new program binary is different
  threadModuleCache.delete(pid);

  processes.set(pid, {
    memory: newMemory,
    programBytes: bytes,
    worker: newWorker,
    channelOffset: newChannelOffset,
    ptrWidth,
  });

  // Wire post-exec error/exit handling. The handleFork listener (on the
  // pre-exec worker) is gone with the terminated worker; without re-arming
  // here, a wasm trap in the exec'd binary (php-fpm child handling a slow
  // request, sed inside wp-config-init, etc.) leaves the kernel believing
  // the process is alive and the parent's waitpid blocks forever.
  installProcessWorkerListeners(newWorker, pid);

  return 0;
}

/**
 * Handle SYS_SPAWN (non-forking posix_spawn) on the browser host.
 *
 * The kernel has already constructed the child Process descriptor under
 * `childPid` with attrs and file actions applied. This callback resolves
 * `path` to bytes via the shared MemoryFileSystem, allocates a fresh
 * Memory for the child, registers it with the kernel
 * (`skipKernelCreate: true` — kernel did its half), and spawns a Worker.
 *
 * Distinct from handleExec (which replaces the calling worker) and
 * handleFork (which clones the parent's Memory): this always creates a
 * fresh Memory and runs the new program from `_start`.
 *
 * Mirrors handlePosixSpawn in host/src/node-kernel-worker-entry.ts —
 * per CLAUDE.md the two hosts must move in lockstep.
 *
 * Returns 0 on success, negative errno on failure.
 */
/**
 * Pre-flight resolver — see node-kernel-worker-entry.ts:handlePosixSpawnResolve.
 * Browser-side equivalent: materialize the lazy file (async fetch via
 * the memfs lazy-loader, avoiding sync-XHR + SW deadlocks) then read its
 * contents from the VFS. Side-effect-free; safe to call on PATH search
 * iterations that may not resolve.
 */
async function handlePosixSpawnResolve(path: string): Promise<ArrayBuffer | null> {
  await memfs.ensureMaterialized(path);
  const bytes = readFileFromFs(path);
  return bytes ?? null;
}

/**
 * Launch a worker for a SYS_SPAWN child whose program bytes have already
 * been resolved by `handlePosixSpawnResolve`. Mirrors the Node entry's
 * `handlePosixSpawn`.
 */
async function handlePosixSpawn(
  childPid: number,
  programBytes: ArrayBuffer,
  argv: string[],
  envp: string[],
): Promise<number> {
  const ptrWidth = detectPtrWidth(programBytes);
  const newMemory = createProcessMemory(ptrWidth, maxPages);
  const newChannelOffset = (maxPages - 2) * PAGE_SIZE;
  new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

  // Kernel already created the child via kernel_spawn_process.
  kernelWorker.registerProcess(childPid, newMemory, [newChannelOffset], {
    skipKernelCreate: true,
    ptrWidth,
  });

  const heapBase = extractHeapBase(programBytes);
  if (heapBase !== null) {
    kernelWorker.setBrkBase(childPid, heapBase);
  }

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: childPid,
    ppid: 0,
    programBytes,
    memory: newMemory,
    channelOffset: newChannelOffset,
    argv,
    env: envp,
    ptrWidth,
  };

  const newWorker = workerAdapter.createWorker(initData);
  newWorker.on("error", (err: Error) => {
    console.error(`[kernel-worker] spawn worker error pid=${childPid}:`, err.message);
  });

  processes.set(childPid, {
    memory: newMemory,
    programBytes,
    worker: newWorker,
    channelOffset: newChannelOffset,
    ptrWidth,
  });

  return 0;
}

async function handleClone(
  pid: number,
  tid: number,
  fnPtr: number,
  argPtr: number,
  stackPtr: number,
  tlsPtr: number,
  ctidPtr: number,
  memory: WebAssembly.Memory,
): Promise<number> {
  const processInfo = processes.get(pid);
  if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);

  // Auto-compile thread module if not already cached.
  // The cache is per-PID so each process's module is compiled once and reused
  // for all its threads. Async compilation is fine since clone() blocks on the channel.
  // We keep this separate from processInfo.programModule (which is the unpatched
  // module used for fork children) to avoid conflating the two.
  let threadModule = threadModuleCache.get(pid);
  if (!threadModule) {
    const patched = patchWasmForThread(processInfo.programBytes);
    threadModule = await WebAssembly.compile(patched);
    threadModuleCache.set(pid, threadModule);
  }

  const alloc = threadAllocator.allocate(memory);

  kernelWorker.addChannel(pid, alloc.channelOffset, tid);

  const threadInitData: CentralizedThreadInitMessage = {
    type: "centralized_thread_init",
    pid,
    tid,
    programBytes: processInfo.programBytes,
    programModule: threadModule,
    memory,
    channelOffset: alloc.channelOffset,
    fnPtr,
    argPtr,
    stackPtr,
    tlsPtr,
    ctidPtr,
    tlsAllocAddr: alloc.tlsAllocAddr,
    ptrWidth: processInfo.ptrWidth,
  };

  const threadWorker = workerAdapter.createWorker(threadInitData);
  if (!threadWorkers.has(pid)) threadWorkers.set(pid, []);
  const threadEntry = { worker: threadWorker, channelOffset: alloc.channelOffset, tid, basePage: alloc.basePage };
  threadWorkers.get(pid)!.push(threadEntry);

  const reclaimThread = () => {
    threadAllocator.free(alloc.basePage);
    const threads = threadWorkers.get(pid);
    if (threads) {
      const idx = threads.indexOf(threadEntry);
      if (idx >= 0) threads.splice(idx, 1);
    }
  };

  threadWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "thread_exit") {
      intentionallyTerminated.add(threadWorker as object);
      threadWorker.terminate().catch(() => {});
      reclaimThread();
    } else if ((m as { type?: string }).type === "error") {
      // worker-main posted {type:"error"} — instantiation failure, top-level
      // throw, etc. Without this the parent's pthread_join blocks forever.
      console.error(
        `[kernel-worker] thread error pid=${pid} tid=${tid}:`,
        (m as { message?: string }).message,
      );
      kernelWorker.notifyThreadExit(pid, tid);
      kernelWorker.removeChannel(pid, alloc.channelOffset);
      intentionallyTerminated.add(threadWorker as object);
      threadWorker.terminate().catch(() => {});
      reclaimThread();
    }
  });
  threadWorker.on("error", (err: Error) => {
    console.error(`[kernel-worker] thread worker error pid=${pid} tid=${tid}:`, err.message);
    kernelWorker.notifyThreadExit(pid, tid);
    kernelWorker.removeChannel(pid, alloc.channelOffset);
    reclaimThread();
  });

  return tid;
}

function handleExit(pid: number, exitStatus: number): void {
  const info = processes.get(pid);

  // Check if this is a "top-level" process or a fork child
  // For now, always deactivate — the main thread tracks exit promises
  kernelWorker.deactivateProcess(pid);

  if (info?.worker) {
    intentionallyTerminated.add(info.worker as object);
    info.worker.terminate().catch(() => {});
  }

  // Terminate any surviving thread workers for this process; the main
  // process worker exiting means their shared state (memory, fd table,
  // signal mask) is gone. Mirrors handleExit in Node-side
  // node-kernel-worker-entry.ts; without this, threads of an exited
  // process leak Web Workers indefinitely.
  const threads = threadWorkers.get(pid);
  if (threads) {
    for (const t of threads) {
      intentionallyTerminated.add(t.worker as object);
      t.worker.terminate().catch(() => {});
    }
    threadWorkers.delete(pid);
  }

  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);

  // Notify main thread
  post({ type: "exit", pid, status: exitStatus });
}

// ── Terminate ──

async function handleTerminateProcess(msg: Extract<MainToKernelMessage, { type: "terminate_process" }>) {
  const pid = msg.pid;

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
    intentionallyTerminated.add(info.worker as object);
    await info.worker.terminate().catch(() => {});
  }

  try {
    kernelWorker.unregisterProcess(pid);
  } catch {}

  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);
  respond(msg.requestId, true);
}

// ── Pipe operations ──

function handlePipeRead(msg: Extract<MainToKernelMessage, { type: "pipe_read" }>) {
  if (!kernelInstance) { respond(msg.requestId, null); return; }
  const pipeRead = kernelInstance.exports.kernel_pipe_read as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = pipeRead(msg.pid, msg.pipeIdx, BigInt(scratchOffset), PAGE_SIZE);
    if (n <= 0) break;
    const mem = new Uint8Array(kernelMemory!.buffer);
    chunks.push(mem.slice(scratchOffset, scratchOffset + n));
  }
  if (chunks.length === 0) { respond(msg.requestId, null); return; }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  respond(msg.requestId, result);
}

function handlePipeWrite(msg: Extract<MainToKernelMessage, { type: "pipe_write" }>) {
  if (!kernelInstance) { respond(msg.requestId, -1); return; }
  const pipeWrite = kernelInstance.exports.kernel_pipe_write as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  let written = 0;
  const data = msg.data;
  while (written < data.length) {
    const chunk = Math.min(data.length - written, PAGE_SIZE);
    let mem = new Uint8Array(kernelMemory!.buffer);
    mem.set(data.subarray(written, written + chunk), scratchOffset);
    const n = pipeWrite(msg.pid, msg.pipeIdx, BigInt(scratchOffset), chunk);
    if (n <= 0) break;
    written += n;
  }
  // Wake readers + pollers watching this pipe + broad wake.
  kernelWorker.notifyPipeReadable(msg.pipeIdx);
  respond(msg.requestId, written);
}

function handlePipeCloseRead(msg: Extract<MainToKernelMessage, { type: "pipe_close_read" }>) {
  if (!kernelInstance) return;
  const fn = kernelInstance.exports.kernel_pipe_close_read as (pid: number, pipeIdx: number) => number;
  fn(msg.pid, msg.pipeIdx);
}

function handlePipeCloseWrite(msg: Extract<MainToKernelMessage, { type: "pipe_close_write" }>) {
  if (!kernelInstance) return;
  const fn = kernelInstance.exports.kernel_pipe_close_write as (pid: number, pipeIdx: number) => number;
  fn(msg.pid, msg.pipeIdx);
}

function handlePipeIsWriteOpen(msg: Extract<MainToKernelMessage, { type: "pipe_is_write_open" }>) {
  if (!kernelInstance) { respond(msg.requestId, false); return; }
  const fn = kernelInstance.exports.kernel_pipe_is_write_open as (pid: number, pipeIdx: number) => number;
  respond(msg.requestId, fn(msg.pid, msg.pipeIdx) === 1);
}

function handleInjectConnection(msg: Extract<MainToKernelMessage, { type: "inject_connection" }>) {
  if (!kernelInstance) { respond(msg.requestId, -1); return; }
  const injectConnection = kernelInstance.exports.kernel_inject_connection as (
    pid: number, fd: number, a: number, b: number, c: number, d: number, port: number,
  ) => number;
  const recvPipeIdx = injectConnection(
    msg.pid, msg.fd,
    msg.peerAddr[0], msg.peerAddr[1], msg.peerAddr[2], msg.peerAddr[3],
    msg.peerPort,
  );
  if (recvPipeIdx >= 0) {
    (kernelWorker as any).scheduleWakeBlockedRetries();
  }
  respond(msg.requestId, recvPipeIdx);
}

function handleWakeBlockedReaders(msg: Extract<MainToKernelMessage, { type: "wake_blocked_readers" }>) {
  const kw = kernelWorker as any;
  const readers = kw.pendingPipeReaders?.get(msg.pipeIdx);
  if (readers && readers.length > 0) {
    kw.pendingPipeReaders.delete(msg.pipeIdx);
    for (const reader of readers) {
      if (kw.processes.has(reader.pid)) {
        kw.retrySyscall(reader.channel);
      }
    }
  }
  kw.scheduleWakeBlockedRetries();
}

function handleWakeBlockedWriters(msg: Extract<MainToKernelMessage, { type: "wake_blocked_writers" }>) {
  const kw = kernelWorker as any;
  const writers = kw.pendingPipeWriters?.get(msg.pipeIdx);
  if (writers && writers.length > 0) {
    kw.pendingPipeWriters.delete(msg.pipeIdx);
    for (const writer of writers) {
      if (kw.processes.has(writer.pid)) {
        kw.retrySyscall(writer.channel);
      }
    }
  }
  kw.scheduleWakeBlockedRetries();
}

function handleIsStdinConsumed(msg: Extract<MainToKernelMessage, { type: "is_stdin_consumed" }>) {
  const kw = kernelWorker as any;
  respond(msg.requestId, kw.stdinFinite.has(msg.pid) && !kw.stdinBuffers.has(msg.pid));
}

function handlePickListenerTarget(msg: Extract<MainToKernelMessage, { type: "pick_listener_target" }>) {
  const kw = kernelWorker as any;
  const result = kw.pickListenerTarget(msg.port);
  respond(msg.requestId, result);
}

function handleDestroy(msg: Extract<MainToKernelMessage, { type: "destroy" }>) {
  // Terminate all process + thread workers, then clear every per-pid
  // map. Mirrors handleDestroy in node-kernel-worker-entry.ts —
  // without the threadWorkers / ptyByPid clears, those maps stay
  // populated across kernel rebuilds (e.g. iframe reload) and leak.
  for (const [pid, info] of processes) {
    if (info.worker) {
      intentionallyTerminated.add(info.worker as object);
      info.worker.terminate().catch(() => {});
    }
    try { kernelWorker.unregisterProcess(pid); } catch {}
  }
  for (const threads of threadWorkers.values()) {
    for (const t of threads) {
      intentionallyTerminated.add(t.worker as object);
      t.worker.terminate().catch(() => {});
    }
  }
  processes.clear();
  threadModuleCache.clear();
  threadWorkers.clear();
  ptyByPid.clear();
  respond(msg.requestId, true);
}

// ── PTY ──

function handlePtyWrite(msg: Extract<MainToKernelMessage, { type: "pty_write" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptyMasterWrite(ptyIdx, msg.data);
}

function handlePtyResize(msg: Extract<MainToKernelMessage, { type: "pty_resize" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptySetWinsize(ptyIdx, msg.rows, msg.cols);
}

function handleMouseInject(msg: Extract<MainToKernelMessage, { type: "mouse_inject" }>) {
  kernelWorker.injectMouseEvent(msg.dx, msg.dy, msg.buttons);
}

/**
 * Drain up to `maxBytes` from the kernel's `/dev/dsp` ring and post the
 * bytes back to the main thread. The main thread's AudioContext
 * scheduler decodes them into an `AudioBuffer` using
 * (sampleRate, channels) reported by the same call so a runtime config
 * change (`SNDCTL_DSP_SPEED`) is picked up on the next drain.
 */
function handleAudioDrain(msg: Extract<MainToKernelMessage, { type: "audio_drain" }>) {
  const cap = Math.min(msg.maxBytes, 65536);
  const buf = new Uint8Array(cap);
  const n = kernelWorker.drainAudio(buf);
  const sampleRate = kernelWorker.audioSampleRate();
  const channels = kernelWorker.audioChannels();
  // Slice to the actual drained length and transfer the underlying
  // ArrayBuffer so we don't pay a copy fee for the worker → main hop.
  const out = n > 0 ? buf.slice(0, n) : new Uint8Array(0);
  post(
    {
      type: "response",
      requestId: msg.requestId,
      result: { bytes: out, sampleRate, channels },
    },
    [out.buffer],
  );
}

function handleRegisterPtyOutput(msg: Extract<MainToKernelMessage, { type: "register_pty_output" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
    post({ type: "pty_output", pid: msg.pid, data });
  });
}

// ── Connection Pump (runs inside kernel worker) ──

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function handleHttpRequest(requestId: number, request: any) {
  if (!kernelInstance || !bridgePort) return;

  const url = request.url || "?";

  // Find a listener target for the bridge's target HTTP port.
  const kw = kernelWorker as any;
  let target: { pid: number; fd: number } | null = null;
  if (bridgeTargetPort !== null) {
    target = kw.pickListenerTarget(bridgeTargetPort);
  } else {
    // Fallback: try all registered listener ports
    const targetPorts: number[] = Array.from(kw.tcpListenerTargets?.keys() ?? []);
    for (const port of targetPorts) {
      target = kw.pickListenerTarget(port);
      if (target) break;
    }
  }
  if (!target) {
    console.warn(`[bridge] no listener target for req#${requestId} ${url}`);
    bridgePort.postMessage({
      type: "http-error",
      requestId,
      error: "No listener target available",
    });
    return;
  }

  const injectConnection = kernelInstance.exports.kernel_inject_connection as (
    pid: number, fd: number, a: number, b: number, c: number, d: number, port: number,
  ) => number;
  const recvPipeIdx = injectConnection(
    target.pid, target.fd,
    127, 0, 0, 1,
    Math.floor(Math.random() * 60000) + 1024,
  );
  if (recvPipeIdx < 0) {
    console.warn(`[bridge] inject failed for req#${requestId} ${url} → pid=${target.pid} err=${recvPipeIdx}`);
    bridgePort.postMessage({
      type: "http-error",
      requestId,
      error: "Failed to inject connection",
    });
    return;
  }

  const sendPipeIdx = recvPipeIdx + 1;
  const rawRequest = buildRawHttpRequest(request);

  console.log(`[bridge] req#${requestId} ${request.method} ${url} → pid=${target.pid}`);

  // Injected pipes live in the global pipe table (any process sharing
  // the listener can accept this connection). Pass pid=0 to the kernel
  // pipe APIs as the global-pipe sentinel — see kernel_inject_connection.
  const GLOBAL_PIPE_PID = 0;

  // Write request directly to pipe (synchronous)
  const written = pipeWriteDirect(GLOBAL_PIPE_PID, recvPipeIdx, rawRequest);
  if (written < rawRequest.length) {
    console.warn(`[bridge] req#${requestId} partial write: ${written}/${rawRequest.length}`);
  }

  // Wake any worker blocked reading or polling on the new recv pipe.
  // No pid filter: any worker sharing the listener (from the shared
  // SHARED_LISTENER_BACKLOG_TABLE — see PR #383) can pick up this
  // entry from the accept queue.
  kernelWorker.notifyPipeReadable(recvPipeIdx);

  // Pump response
  pumpResponse(requestId, GLOBAL_PIPE_PID, sendPipeIdx, recvPipeIdx, url);
}

function pipeWriteDirect(pid: number, pipeIdx: number, data: Uint8Array): number {
  const pipeWrite = kernelInstance!.exports.kernel_pipe_write as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  let written = 0;
  while (written < data.length) {
    const chunk = Math.min(data.length - written, PAGE_SIZE);
    // Re-create view before each Wasm call — memory.grow detaches the ArrayBuffer.
    let mem = new Uint8Array(kernelMemory!.buffer);
    mem.set(data.subarray(written, written + chunk), scratchOffset);
    const n = pipeWrite(pid, pipeIdx, BigInt(scratchOffset), chunk);
    if (n <= 0) break;
    written += n;
  }
  return written;
}

function pipeReadDirect(pid: number, pipeIdx: number): Uint8Array | null {
  const pipeRead = kernelInstance!.exports.kernel_pipe_read as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = pipeRead(pid, pipeIdx, BigInt(scratchOffset), PAGE_SIZE);
    if (n <= 0) break;
    // Re-create view after each Wasm call — memory.grow during pipe read
    // (e.g. wakeup Vec realloc) detaches the previous ArrayBuffer.
    const mem = new Uint8Array(kernelMemory!.buffer);
    chunks.push(mem.slice(scratchOffset, scratchOffset + n));
  }
  if (chunks.length === 0) return null;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function pipeIsWriteOpenDirect(pid: number, pipeIdx: number): boolean {
  const fn = kernelInstance!.exports.kernel_pipe_is_write_open as (pid: number, pipeIdx: number) => number;
  return fn(pid, pipeIdx) === 1;
}

function pipeCloseReadDirect(pid: number, pipeIdx: number): void {
  const fn = kernelInstance!.exports.kernel_pipe_close_read as (pid: number, pipeIdx: number) => number;
  fn(pid, pipeIdx);
}

function pipeCloseWriteDirect(pid: number, pipeIdx: number): void {
  const fn = kernelInstance!.exports.kernel_pipe_close_write as (pid: number, pipeIdx: number) => number;
  fn(pid, pipeIdx);
}

function buildRawHttpRequest(request: any): Uint8Array {
  let header = `${request.method} ${request.url} HTTP/1.1\r\n`;
  const headerKeys = Object.keys(request.headers).map((k: string) => k.toLowerCase());
  for (const [key, value] of Object.entries(request.headers)) {
    header += `${key}: ${value}\r\n`;
  }
  if (request.body && !headerKeys.includes("content-length")) {
    header += `Content-Length: ${request.body.length}\r\n`;
  }
  if (!headerKeys.includes("connection")) {
    header += `Connection: close\r\n`;
  }
  header += `\r\n`;

  const headerBytes = encoder.encode(header);
  if (!request.body || request.body.length === 0) return headerBytes;

  const result = new Uint8Array(headerBytes.length + request.body.length);
  result.set(headerBytes, 0);
  result.set(request.body, headerBytes.length);
  return result;
}

// 5 min: WordPress install on the LAMP stack does a long sequence of
// CREATE TABLE + INSERT against MariaDB inside the same wasm process —
// 60s wasn't enough for the request to complete on slower hardware.
// The bridge needs to outlive any single request the demo can make,
// otherwise the iframe shows a blank 504 even though the kernel is
// still happily processing the request.
const HTTP_PUMP_TIMEOUT_MS = 300_000;

function pumpResponse(
  requestId: number,
  pid: number,
  sendPipeIdx: number,
  recvPipeIdx: number,
  debugUrl?: string,
) {
  const chunks: Uint8Array[] = [];
  let sawWriteOpen = false;
  const startTime = Date.now();
  let totalBytes = 0;

  let pumpIter = 0;
  const pump = () => {
    pumpIter++;
    if (Date.now() - startTime > HTTP_PUMP_TIMEOUT_MS) {
      // Timeout — clean up and send error response
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.warn(`[bridge] TIMEOUT req#${requestId} after ${elapsed}s, ${totalBytes} bytes received, sawWriteOpen=${sawWriteOpen}, url=${debugUrl}`);
      pipeCloseReadDirect(pid, sendPipeIdx);
      pipeCloseWriteDirect(pid, recvPipeIdx);
      bridgePort!.postMessage({
        type: "http-response",
        requestId,
        status: 504,
        headers: {},
        body: new Uint8Array(0),
      });
      return;
    }

    const data = pipeReadDirect(pid, sendPipeIdx);
    if (data) {
      chunks.push(data);
      totalBytes += data.length;
      // Wake any process blocked writing because the pipe was full.
      kernelWorker.notifyPipeWritable(sendPipeIdx);
    }

    const writeOpen = (kernelInstance!.exports.kernel_pipe_is_write_open as (pid: number, pipeIdx: number) => number)(pid, sendPipeIdx) === 1;
    if (writeOpen && !sawWriteOpen) sawWriteOpen = true;

    if (sawWriteOpen && !writeOpen && !data) {
      // Response complete
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[bridge] DONE req#${requestId} ${elapsed}s ${totalBytes}B ${debugUrl}`);
      pipeCloseReadDirect(pid, sendPipeIdx);
      pipeCloseWriteDirect(pid, recvPipeIdx);
      const rawResponse = concatChunks(chunks);
      const parsed = parseRawHttpResponse(rawResponse);
      bridgePort!.postMessage({
        type: "http-response",
        requestId,
        status: parsed.status,
        headers: parsed.headers,
        body: parsed.body,
      });
      return;
    }

    setTimeout(pump, data ? 0 : 2);
  };

  pump();
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function parseRawHttpResponse(data: Uint8Array): { status: number; headers: Record<string, string>; body: Uint8Array } {
  const text = decoder.decode(data);
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return { status: 200, headers: {}, body: data };

  const headerText = text.slice(0, headerEnd);
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0].match(/^HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(": ");
    if (colon >= 0) {
      const key = lines[i].slice(0, colon);
      const value = lines[i].slice(colon + 2);
      if (key.toLowerCase() === "set-cookie" && headers[key]) {
        headers[key] += "\n" + value;
      } else {
        headers[key] = value;
      }
    }
  }

  let byteHeaderEnd = 0;
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      byteHeaderEnd = i + 4;
      break;
    }
  }
  let body = data.subarray(byteHeaderEnd);

  const te = headers["Transfer-Encoding"] || headers["transfer-encoding"];
  if (te && te.toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
    delete headers["Transfer-Encoding"];
    delete headers["transfer-encoding"];
  }

  return { status, headers, body: new Uint8Array(body) };
}

function decodeChunked(data: Uint8Array): Uint8Array {
  const result: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    let lineEnd = -1;
    for (let i = pos; i < data.length - 1; i++) {
      if (data[i] === 0x0d && data[i + 1] === 0x0a) { lineEnd = i; break; }
    }
    if (lineEnd < 0) break;
    const sizeLine = decoder.decode(data.subarray(pos, lineEnd)).trim();
    const chunkSize = parseInt(sizeLine, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;
    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) break;
    result.push(data.subarray(chunkStart, chunkEnd));
    pos = chunkEnd + 2;
  }
  return concatChunks(result);
}

// ── Filesystem helpers ──

function readFileFromFs(path: string): ArrayBuffer | null {
  try {
    const fd = memfs.open(path, 0 /* O_RDONLY */, 0);
    try {
      const stat = memfs.fstat(fd);
      const size = stat.size;
      if (size <= 0) { memfs.close(fd); return null; }
      const buf = new Uint8Array(size);
      const nread = memfs.read(fd, buf, null, size);
      memfs.close(fd);
      if (nread <= 0) return null;
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + nread);
    } catch {
      memfs.close(fd);
      return null;
    }
  } catch {
    return null;
  }
}

// ── Message dispatch ──

const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

sw.onmessage = (e: MessageEvent) => {
  const msg = e.data as MainToKernelMessage;
  switch (msg.type) {
    case "init": handleInit(msg); break;
    case "spawn": handleSpawn(msg); break;
    case "terminate_process": handleTerminateProcess(msg); break;
    case "append_stdin_data": kernelWorker.appendStdinData(msg.pid, msg.data); break;
    case "set_stdin_data": kernelWorker.setStdinData(msg.pid, msg.data); break;
    case "pty_write": handlePtyWrite(msg); break;
    case "pty_resize": handlePtyResize(msg); break;
    case "register_pty_output": handleRegisterPtyOutput(msg); break;
    case "inject_connection": handleInjectConnection(msg); break;
    case "pipe_read": handlePipeRead(msg); break;
    case "pipe_write": handlePipeWrite(msg); break;
    case "pipe_close_read": handlePipeCloseRead(msg); break;
    case "pipe_close_write": handlePipeCloseWrite(msg); break;
    case "pipe_is_write_open": handlePipeIsWriteOpen(msg); break;
    case "wake_blocked_readers": handleWakeBlockedReaders(msg); break;
    case "wake_blocked_writers": handleWakeBlockedWriters(msg); break;
    case "is_stdin_consumed": handleIsStdinConsumed(msg); break;
    case "pick_listener_target": handlePickListenerTarget(msg); break;
    case "destroy": handleDestroy(msg); break;
    case "register_lazy_files": memfs.importLazyEntries(msg.entries); break;
    case "register_lazy_archives": memfs.importLazyArchiveEntries(msg.entries); break;
    case "get_fork_count": {
      // Round-trip access to the kernel's per-process fork counter for
      // tests asserting SYS_SPAWN didn't fall back to fork. Mirrors the
      // Node-side `get_fork_count` request in node-kernel-worker-entry.ts.
      try {
        const count = kernelWorker.getForkCount(msg.pid);
        respond(msg.requestId, count);
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
      }
      break;
    }
    case "mouse_inject": handleMouseInject(msg); break;
    case "audio_drain": handleAudioDrain(msg); break;
    default: {
      // Handle non-protocol messages (e.g., bridge port transfer)
      const raw = e.data as any;
      if (raw?.type === "sysprof_start") {
        (globalThis as { __sysprof?: boolean }).__sysprof = true;
        (globalThis as { __sysprofTable?: Map<string, unknown> }).__sysprofTable = new Map();
        (globalThis as { __sysprofStartedAt?: number }).__sysprofStartedAt = performance.now();
        post({ type: "stdout", pid: 0, data: new TextEncoder().encode("[sysprof] started\n") });
      } else if (raw?.type === "pid_map_dump") {
        const m = (globalThis as { __pidMap?: Map<number, string> }).__pidMap;
        const out = ["[pid-map] (pid → exec'd path)\n"];
        if (m) for (const [pid, p] of [...m.entries()].sort((a, b) => a[0] - b[0])) out.push(`  pid=${pid} ${p}\n`);
        post({ type: "stdout", pid: 0, data: new TextEncoder().encode(out.join("")) });
      } else if (raw?.type === "sysprof_dump") {
        const table = (globalThis as { __sysprofTable?: Map<string, { count: number; totalMs: number; maxMs: number }> }).__sysprofTable;
        const gapTable = (globalThis as { __sysprofGap?: Map<number, { count: number; gapTotalMs: number; gapMaxMs: number }> }).__sysprofGap;
        const startedAt = (globalThis as { __sysprofStartedAt?: number }).__sysprofStartedAt ?? 0;
        const elapsed = performance.now() - startedAt;
        const rows = table ? [...table.entries()].map(([k, v]) => ({ key: k, ...v })) : [];
        rows.sort((a, b) => b.totalMs - a.totalMs);
        let out = `[sysprof] ${elapsed.toFixed(0)}ms total, top syscalls by kernel-side time:\n`;
        for (const r of rows.slice(0, 20)) {
          const [pid, nr] = r.key.split(":");
          out += `  pid=${pid} nr=${nr} count=${r.count} total=${r.totalMs.toFixed(0)}ms max=${r.maxMs.toFixed(1)}ms avg=${(r.totalMs / r.count).toFixed(2)}ms\n`;
        }
        // Wall-clock gaps tell us which pid's *user wasm code* is the
        // actual bottleneck — kernel handling itself has been ~negligible.
        if (gapTable) {
          const gapRows = [...gapTable.entries()].map(([pid, v]) => ({ pid, ...v }));
          gapRows.sort((a, b) => b.gapTotalMs - a.gapTotalMs);
          out += `[sysprof] gap-between-syscalls per pid (= time spent in user wasm):\n`;
          for (const r of gapRows.slice(0, 15)) {
            out += `  pid=${r.pid} gaps=${r.count} total=${r.gapTotalMs.toFixed(0)}ms max=${r.gapMaxMs.toFixed(1)}ms avg=${(r.gapTotalMs / r.count).toFixed(2)}ms\n`;
          }
        }
        post({ type: "stdout", pid: 0, data: new TextEncoder().encode(out) });
        (globalThis as { __sysprof?: boolean }).__sysprof = false;
      } else if (raw?.type === "set_bridge_port" && raw.bridgePort) {
        bridgePort = raw.bridgePort;
        if (typeof raw.httpPort === "number") {
          bridgeTargetPort = raw.httpPort;
        }
        // Wire up connection pump
        if (bridgePort) {
          bridgePort.onmessage = (event: MessageEvent) => {
            const m = event.data;
            if (m?.type === "http-request") {
              handleHttpRequest(m.requestId, m);
            }
          };
        }
      } else {
        console.warn("[kernel-worker] Unknown message type:", raw?.type);
      }
    }
  }
};
