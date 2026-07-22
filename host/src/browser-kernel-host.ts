/**
 * BrowserKernel — Thin proxy that communicates with a dedicated kernel
 * web worker via MessagePort. The kernel worker owns the Wasm instance
 * and all process lifecycle (fork/exec/clone/exit).
 *
 * The main thread handles only UI, filesystem setup, and application-level
 * clients (MySQL, Redis) via async pipe operations.
 */

import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "./vfs/memory-fs";
import { FramebufferRegistry } from "./framebuffer/registry";
import type { ProcessSnapshot, SyscallTraceEvent } from "./kernel-worker";
import type {
  HostDiagnostic,
  MainToKernelMessage,
  KernelToMainMessage,
  VfsFileSnapshot,
} from "./browser-kernel-protocol";
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";

export type { HttpRequest, HttpResponse };
import kernelWasmUrl from "@kernel-wasm?url";
import rootfsVfsUrl from "@rootfs-vfs?url";
import workerEntryUrl from "./worker-entry-browser.ts?worker&url";
import kernelWorkerEntryUrl from "./browser-kernel-worker-entry.ts?worker&url";
import { DEFAULT_MAX_PAGES } from "./constants";
import {
  snapshotClosedLazyAssets,
  type ClosedLazyAsset,
} from "./vfs/closed-lazy-assets";

export interface BrowserKernelOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** Maximum wasm memory pages per process (default: 16384 = 1GB). This caps
   *  guest brk/mmap growth; initial process memory is computed separately. */
  maxMemoryPages?: number;
  /** Host default pthread slots when a wasm binary declares -1 (default: 16). */
  defaultThreadSlots?: number;
  /** Additional VFS mount points */
  extraMounts?: Array<{ mountPoint: string; backend: { open: Function } }>;
  /** Environment variables for spawned processes */
  env?: string[];
  /** Called when a process writes to stdout */
  onStdout?: (data: Uint8Array) => void;
  /** Called when a process writes to stderr */
  onStderr?: (data: Uint8Array) => void;
  /** Called for host-runtime diagnostics that are not guest stderr. */
  onHostDiagnostic?: (diagnostic: HostDiagnostic) => void;
  /** Called when a process requests a TCP listener (for service worker bridging) */
  onListenTcp?: (pid: number, fd: number, port: number) => void;
  /** Called when the service-worker HTTP bridge gains or completes preview requests. */
  onHttpBridgePendingRequests?: (count: number) => void;
  /** Called as lazy VFS files or archives are fetched on demand. */
  onLazyDownload?: (event: LazyDownloadEvent) => void;
  /** Called when a process is spawned, execs a new program, or exits.
   *  Used by Inspector-style UIs to refresh their process table without
   *  polling. Source feeds:
   *    - main-thread BrowserKernel.spawn / .boot → "spawn"
   *    - worker-side fork / posix_spawn → "spawn" with `ppid` (via proc_event message)
   *    - worker-side execve → "exec"
   *    - worker-side exit → "exit" (via existing exit message)
   *  Main-thread root spawns do not carry `ppid`.
   */
  onProcessEvent?: (event: { kind: "spawn" | "exec" | "exit"; pid: number; ppid?: number; exitStatus?: number }) => void;
  /** Pre-compiled thread module for clone(). Avoids recompiling large wasm for each thread. */
  threadModule?: WebAssembly.Module;
  /** The kernel worker always owns the VFS exclusively: the main thread holds
   *  no VFS SharedArrayBuffer, so it is reclaimed by `Worker.terminate()` and
   *  never accumulates across image switches (Safari OOM fix). Demos build a
   *  VFS image with {@link MemoryFileSystem} + `saveImage()` and pass it to
   *  {@link BrowserKernel.boot} / {@link BrowserKernel.initFromImage}. Accepted
   *  for backward compatibility; the value is ignored (there is no other mode). */
  kernelOwnedFs?: boolean;
  /** Debug: log every syscall to the kernel-worker console. Noisy. */
  enableSyscallLog?: boolean;
  /** Debug: only log syscalls for processes of the given pointer width
   *  (4=wasm32, 8=wasm64). Use 8 to focus on a single wasm64 process in a
   *  mixed-arch demo. */
  syscallLogPtrWidth?: 4 | 8;
  /** Forwarded to TlsNetworkBackendOptions.dnsAliases. */
  dnsAliases?: Record<string, string>;
  /** Forwarded to TlsNetworkBackendOptions.corsProxyUrl. Browser pages that
   *  are not controlled by Kandelo's service worker can use this to route
   *  guest outbound HTTP(S) through a same-origin proxy. */
  corsProxyUrl?: string;
}

/** Options for {@link BrowserKernel.boot}. */
export interface BrowserKernelBootOptions {
  /** Kernel wasm bytes; if omitted, fetched from the bundled URL. */
  kernelWasm?: ArrayBuffer;
  /**
   * Pre-built VFS image bytes from {@link MemoryFileSystem.saveImage}, OR
   * the literal `"default"` to fetch the canonical `host/wasm/rootfs.vfs`
   * shipped with the worker entry. The worker takes ownership; the main
   * thread no longer has FS access.
   */
  vfsImage: Uint8Array | "default";
  /** Base URL used to resolve relative lazy file/archive URLs in `vfsImage`. */
  lazyUrlBase?: string;
  /**
   * Exhaustive exact URL-to-byte transport for lazy entries in `vfsImage`.
   * When set, an unbound URL fails instead of using ambient browser fetch.
   */
  closedLazyAssets?: readonly ClosedLazyAsset[];
  /** Argv for the first (and currently only "init") process. argv[0] should
   *  be a path inside the VFS image. */
  argv: string[];
  /** Override the kernel's default environment for the first process. */
  env?: string[];
  /** Working directory for the first process. */
  cwd?: string;
  /** Initial real/effective user ID for the first process. */
  uid?: number;
  /** Initial real/effective group ID for the first process. */
  gid?: number;
  /** Allocate a PTY for the first process. */
  pty?: boolean;
  /** Initial stdin bytes (with implicit EOF). */
  stdin?: Uint8Array;
}

export class BrowserKernel {
  private kernelWorkerHandle!: Worker;
  /** POSIX shared-memory / semaphore SAB shared with the kernel worker. Small
   *  and fixed (1 MiB); the live VFS is owned by the worker, not here. */
  private shmSab: SharedArrayBuffer;
  private maxPages: number;
  private options: Required<
    Pick<BrowserKernelOptions, "maxWorkers" | "env">
  > &
    BrowserKernelOptions;
  private exitResolvers = new Map<number, (status: number) => void>();
  private unclaimedExitStatuses = new Map<number, { status: number; sequence: number }>();
  private exitSequence = 0;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private nextRequestId = 1;
  private ptyOutputCallbacks = new Map<number, (data: Uint8Array) => void>();
  /**
   * Mirror of the kernel-worker's FramebufferRegistry, populated by
   * forwarded fb_bind / fb_unbind messages. The renderer
   * (host/src/framebuffer/canvas-renderer.ts) reads from here.
   */
  readonly framebuffers = new FramebufferRegistry();
  private fbMemoryByPid = new Map<number, WebAssembly.Memory>();
  /** PTY output that arrived before the main thread registered a callback —
   * happens when `boot()` is awaited (process is running) before
   * PtyTerminal calls onPtyOutput. Drained when a callback registers. */
  private pendingPtyOutput = new Map<number, Uint8Array[]>();
  private lazyDownloadListeners = new Set<(event: LazyDownloadEvent) => void>();

  constructor(options: BrowserKernelOptions = {}) {
    this.maxPages = options.maxMemoryPages ?? DEFAULT_MAX_PAGES;
    this.options = {
      maxWorkers: 4,
      env: [
        "HOME=/root",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "USER=root",
        "LOGNAME=root",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "SSL_CERT_DIR=/etc/ssl/certs",
      ],
      ...options,
    };

    // The kernel worker owns the VFS. The main thread allocates only the
    // small shared-memory SAB (POSIX shm/semaphores), never a VFS buffer, so
    // nothing large accumulates on the main thread across image switches.
    this.shmSab = new SharedArrayBuffer(1024 * 1024);
    MemoryFileSystem.create(this.shmSab); // format shm SAB for kernel worker
  }

  /**
   * Boot the kernel from a pre-built VFS image and spawn the first process.
   * The worker takes ownership of the FS; the main thread no longer has FS
   * access. Returns the first process's exit code.
   *
   * Demos build the VFS image on the main thread using MemoryFileSystem +
   * the helpers in `host/src/vfs/image-helpers`, call `saveImage()` for
   * bytes, then pass them here.
   */
  async boot(options: BrowserKernelBootOptions): Promise<{ pid: number; exit: Promise<number> }> {
    await this.initFromImage(options);

    // Spawn the first process — kernel worker assigns the pid and returns
    // it in the response. Pid is the single source of truth in the worker.
    return this.spawnFirstProcess(options);
  }

  /**
   * Load a pre-built VFS image into the kernel worker WITHOUT spawning a
   * first process. The worker builds and takes ownership of the FS; the main
   * thread holds no FS SharedArrayBuffer, so the whole VFS is reclaimed when
   * the kernel worker is terminated (no dependence on main-thread GC — the
   * fix for the Safari image-switch OOM). Spawn processes afterward with
   * {@link spawnFromVfs}, or call {@link boot} to load + spawn a first process
   * in one step.
   */
  async initFromImage(options: {
    kernelWasm?: ArrayBuffer;
    vfsImage: Uint8Array | "default";
    lazyUrlBase?: string;
    closedLazyAssets?: readonly ClosedLazyAsset[];
  }): Promise<void> {
    const [wasmBytes, vfsImage] = await Promise.all([
      options.kernelWasm
        ? Promise.resolve(options.kernelWasm)
        : fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      options.vfsImage === "default"
        ? fetch(rootfsVfsUrl)
            .then((r) => r.arrayBuffer())
            .then((b) => new Uint8Array(b))
        : Promise.resolve(options.vfsImage),
    ]);

    await this.bootWorker({
      kernelWasmBytes: wasmBytes,
      vfsImage,
      lazyUrlBase: options.lazyUrlBase ?? import.meta.env.BASE_URL,
      closedLazyAssets: options.closedLazyAssets,
    });
  }

  /**
   * Internal: set up the kernel worker, attach handlers, send the init
   * message (with the demo's `vfsImage`), and await ready.
   */
  private async bootWorker(opts: {
    kernelWasmBytes: ArrayBuffer;
    vfsImage: Uint8Array;
    lazyUrlBase?: string;
    closedLazyAssets?: readonly ClosedLazyAsset[];
  }): Promise<void> {
    const closedLazyAssets = opts.closedLazyAssets === undefined
      ? undefined
      : snapshotClosedLazyAssets(opts.closedLazyAssets);
    // Create the kernel worker
    this.kernelWorkerHandle = new Worker(kernelWorkerEntryUrl, { type: "module" });

    this.kernelWorkerHandle.onmessage = (e: MessageEvent) => {
      this.handleWorkerMessage(e.data as KernelToMainMessage);
    };
    this.kernelWorkerHandle.onerror = (e: ErrorEvent) => {
      const err = new Error(`Kernel worker error: ${e.message}`);
      for (const [, { reject }] of this.pendingRequests) {
        reject(err);
      }
      this.pendingRequests.clear();
      this.options.onHttpBridgePendingRequests?.(0);
      const diagnostic: HostDiagnostic = {
        pid: 0,
        source: "kernel worker",
        message: `[BrowserKernel] kernel worker error: ${e.message}`,
      };
      // A worker-level error cannot send a typed message itself. Preserve the
      // same callback contract and a visible default without treating the
      // failure as guest stderr.
      console.error(diagnostic.message);
      try {
        this.options.onHostDiagnostic?.(diagnostic);
      } catch (callbackError) {
        console.error("[BrowserKernel] onHostDiagnostic callback failed:", callbackError);
      }
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.kernelWorkerHandle.removeEventListener("message", readyHandler);
        this.kernelWorkerHandle.removeEventListener("error", errorHandler);
        this.kernelWorkerHandle.removeEventListener("messageerror", messageErrorHandler);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const readyHandler = (e: MessageEvent) => {
        if (e.data?.type === "ready") {
          settleResolve();
        } else if (e.data?.type === "init_error") {
          settleReject(new Error(`Kernel worker init failed: ${e.data.error}`));
        }
      };
      const errorHandler = (e: ErrorEvent) => {
        settleReject(new Error(`Kernel worker error during init: ${e.message}`));
      };
      const messageErrorHandler = () => {
        settleReject(new Error("Kernel worker failed to deserialize an init message"));
      };
      this.kernelWorkerHandle.addEventListener("message", readyHandler);
      this.kernelWorkerHandle.addEventListener("error", errorHandler);
      this.kernelWorkerHandle.addEventListener("messageerror", messageErrorHandler);

      // Slice so the caller's ArrayBuffer isn't detached (allows restart)
      const transferBuf = opts.kernelWasmBytes.slice(0);
      const initMsg: MainToKernelMessage = {
        type: "init",
        kernelWasmBytes: transferBuf,
        vfsImage: opts.vfsImage,
        lazyUrlBase: opts.lazyUrlBase,
        closedLazyAssets,
        shmSab: this.shmSab,
        workerEntryUrl,
        config: {
          maxWorkers: this.options.maxWorkers,
          maxMemoryPages: this.maxPages,
          defaultThreadSlots: this.options.defaultThreadSlots,
          env: this.options.env,
          enableSyscallLog: this.options.enableSyscallLog,
          syscallLogPtrWidth: this.options.syscallLogPtrWidth,
          dnsAliases: this.options.dnsAliases,
          corsProxyUrl: this.options.corsProxyUrl,
        },
      };
      const transfer: Transferable[] = [transferBuf];
      for (const asset of closedLazyAssets ?? []) {
        // snapshotClosedLazyAssets always allocates one ordinary ArrayBuffer
        // per binding, so transferring it cannot detach caller-owned bytes.
        transfer.push(asset.bytes.buffer as ArrayBuffer);
      }
      this.kernelWorkerHandle.postMessage(initMsg, transfer);
    });
  }

  /**
   * Internal: send a spawn message for the first ("init") process. The
   * worker allocates the pid and returns it in the response. The exit
   * promise is wired up after the pid is known.
   */
  private async spawnFirstProcess(
    options: BrowserKernelBootOptions,
  ): Promise<{ pid: number; exit: Promise<number> }> {
    const requestId = this.nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const stdin = options.stdin ?? (!options.pty ? new Uint8Array() : undefined);

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      // No pid — the kernel worker allocates and returns it.
      programPath: options.argv[0],
      argv: options.argv,
      env: this.mergeEnv(options.env ?? this.options.env),
      cwd: options.cwd,
      uid: options.uid,
      gid: options.gid,
      pty: options.pty,
      stdin,
      maxPages: this.maxPages,
    }) as number;

    const exit = this.claimExitStatus(pid, spawnStartedBeforeExitSequence);

    if (options.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    this.options.onProcessEvent?.({ kind: "spawn", pid });
    return { pid, exit };
  }

  /**
   * Send the HTTP bridge host port to the kernel worker for connection pump handling.
   * Call after init() but before spawning processes that listen on ports.
   * The port should come from HttpBridgeHost.detachHostPort().
   * @param httpPort The specific TCP port to route HTTP bridge requests to (e.g. 8080 for nginx).
   */
  sendBridgePort(hostPort: MessagePort, httpPort?: number): void {
    this.kernelWorkerHandle.postMessage(
      { type: "set_bridge_port", bridgePort: hostPort, httpPort },
      [hostPort],
    );
  }

  /**
   * Spawn a new process and return a promise that resolves with the exit code.
   *
   * `onStarted(pid)` fires once the kernel has registered the process and the
   * spawn request is acknowledged — but BEFORE awaiting the exit promise. Use
   * this to capture the pid for follow-up calls like `getForkCount(pid)` (the
   * spawn-regression-guardrail pattern; see
   * `apps/browser-demos/pages/benchmark/main.ts`).
   * Mirrors `NodeKernelHost.spawn`'s `onStarted` option.
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: {
      env?: string[];
      cwd?: string;
      stdin?: Uint8Array;
      pty?: boolean;
      uid?: number;
      gid?: number;
      onStarted?: (pid: number) => void | Promise<void>;
      ptyCols?: number;
      ptyRows?: number;
    },
  ): Promise<number> {
    const requestId = this.nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const stdin =
      options?.stdin ??
      (!options?.pty && !options?.onStarted ? new Uint8Array() : undefined);

    // Clone programBytes since it gets transferred (detached)
    const bytesToSend = programBytes.slice(0);

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      programBytes: bytesToSend,
      argv,
      env: this.mergeEnv(options?.env ?? this.options.env),
      cwd: options?.cwd,
      uid: options?.uid,
      gid: options?.gid,
      pty: options?.pty,
      ptyCols: options?.ptyCols,
      ptyRows: options?.ptyRows,
      stdin,
      maxPages: this.maxPages,
    }, [bytesToSend]) as number;

    const exitPromise = this.claimExitStatus(pid, spawnStartedBeforeExitSequence);

    // Register PTY output callback if pty was requested
    if (options?.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    this.options.onProcessEvent?.({ kind: "spawn", pid });

    if (options?.onStarted) {
      await options.onStarted(pid);
    }

    return exitPromise;
  }

  /**
   * Spawn a process whose binary already lives in the kernel-owned VFS.
   * Returns the worker-allocated pid + an exit promise.
   *
   * This does not transfer any `programBytes` across the worker boundary —
   * the kernel reads the binary out of its own memfs at `programPath`. Use
   * this in `kernelOwnedFs: true` mode (or whenever the binary is already in
   * the VFS) to avoid re-shipping multi-megabyte binaries the kernel already
   * has.
   *
   * Like every top-level spawn path, the kernel worker allocates and returns
   * the pid.
   */
  async spawnFromVfs(
    programPath: string,
    argv: string[],
    options?: {
      env?: string[];
      cwd?: string;
      uid?: number;
      gid?: number;
      pty?: boolean;
      stdin?: Uint8Array;
      ptyCols?: number;
      ptyRows?: number;
    },
  ): Promise<{ pid: number; exit: Promise<number> }> {
    const requestId = this.nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      programPath,
      argv,
      env: this.mergeEnv(options?.env ?? this.options.env),
      cwd: options?.cwd,
      uid: options?.uid,
      gid: options?.gid,
      pty: options?.pty,
      ptyCols: options?.ptyCols,
      ptyRows: options?.ptyRows,
      stdin: options?.stdin,
      maxPages: this.maxPages,
    }) as number;

    const exit = this.claimExitStatus(pid, spawnStartedBeforeExitSequence);

    if (options?.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    return { pid, exit };
  }

  /**
   * Read the kernel's per-process fork counter. Used by the spawn
   * regression tests to assert a `SYS_SPAWN` call didn't fall back to
   * fork — `getForkCount(parentPid)` should return the same value
   * before and after a `posix_spawn`.
   *
   * Returns `u64::MAX` (as `bigint`) if the pid does not exist; callers
   * should compare against an explicit before-value rather than treating
   * "no process" as "0 forks". Mirrors `NodeKernelHost.getForkCount`.
   */
  async getForkCount(pid: number): Promise<bigint> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "get_fork_count",
      requestId,
      pid,
    });
    return typeof result === "bigint" ? result : BigInt(result as number);
  }

  /**
   * Snapshot the kernel's process table — one row per live process. Used
   * by Kandelo's Inspector → Procs tab. Mirrors `NodeKernelHost.enumProcs`.
   */
  async enumProcs(): Promise<ProcessSnapshot[]> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "enum_procs",
      requestId,
    });
    return (result as ProcessSnapshot[]) ?? [];
  }

  /**
   * Read `/proc/[pid]/maps` for a foreign process. Returns the raw Linux-
   * style text, `""` if the process has no mappings, or `null` if the pid
   * has exited. Mirrors `NodeKernelHost.readProcMaps`.
   */
  async readProcMaps(pid: number): Promise<string | null> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_proc_maps",
      requestId,
      pid,
    });
    return (result as string | null) ?? null;
  }

  /**
   * Subscribe to the kernel-worker's syscall trace. Returns an
   * unsubscribe function. Trace is enabled when the first subscriber
   * attaches and disabled after the last one detaches — zero cost on
   * the kernel hot path when nobody's watching.
   *
   * Delivery: the main thread polls the worker every 250ms and fans
   * out batched events to subscribers in the order the kernel saw them.
   * Higher resolution would require a push-style worker message; the
   * poll buys low overhead at the cost of up to one polling-interval
   * of latency.
   */
  subscribeSyscalls(cb: (event: SyscallTraceEvent) => void): () => void {
    this.syscallListeners.add(cb);
    if (this.syscallListeners.size === 1) {
      this.sendToKernel({ type: "set_syscall_trace", enabled: true });
      this.startSyscallPoll();
    }
    return () => {
      this.syscallListeners.delete(cb);
      if (this.syscallListeners.size === 0) {
        this.sendToKernel({ type: "set_syscall_trace", enabled: false });
        this.stopSyscallPoll();
      }
    };
  }

  /** Subscribe to lazy VFS file/archive download progress. */
  subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void): () => void {
    this.lazyDownloadListeners.add(cb);
    return () => {
      this.lazyDownloadListeners.delete(cb);
    };
  }

  private syscallListeners = new Set<(event: SyscallTraceEvent) => void>();
  private syscallPollTimer: ReturnType<typeof setInterval> | null = null;

  private startSyscallPoll(): void {
    if (this.syscallPollTimer !== null) return;
    this.syscallPollTimer = setInterval(() => {
      void this.drainAndFan();
    }, 250);
  }

  private stopSyscallPoll(): void {
    if (this.syscallPollTimer === null) return;
    clearInterval(this.syscallPollTimer);
    this.syscallPollTimer = null;
  }

  private async drainAndFan(): Promise<void> {
    if (this.syscallListeners.size === 0) return;
    const requestId = this.nextRequestId++;
    let events: SyscallTraceEvent[] = [];
    try {
      const result = await this.request(requestId, {
        type: "drain_syscall_trace",
        requestId,
      });
      events = (result as SyscallTraceEvent[]) ?? [];
    } catch {
      return;
    }
    for (const event of events) {
      for (const cb of this.syscallListeners) {
        try { cb(event); } catch { /* listener errors don't break the loop */ }
      }
    }
  }

  /**
   * Inject an external TCP connection into the kernel's listening socket.
   * Returns the recv pipe index, or -1 on failure.
   */
  async injectConnection(
    pid: number,
    listenerFd: number,
    peerAddr: [number, number, number, number] = [127, 0, 0, 1],
    peerPort: number = 0,
  ): Promise<number> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "inject_connection",
      requestId,
      pid,
      fd: listenerFd,
      peerAddr,
      peerPort,
    }) as Promise<number>;
  }

  /** Write data to a kernel pipe. */
  async pipeWrite(pid: number, pipeIdx: number, data: Uint8Array): Promise<number> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pipe_write",
      requestId,
      pid,
      pipeIdx,
      data,
    }) as Promise<number>;
  }

  /** Read data from a kernel pipe. */
  async pipeRead(pid: number, pipeIdx: number): Promise<Uint8Array | null> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pipe_read",
      requestId,
      pid,
      pipeIdx,
    }) as Promise<Uint8Array | null>;
  }

  /** Close the write end of a pipe. */
  pipeCloseWrite(pid: number, pipeIdx: number): void {
    this.sendToKernel({ type: "pipe_close_write", pid, pipeIdx });
  }

  /** Close the read end of a pipe. */
  pipeCloseRead(pid: number, pipeIdx: number): void {
    this.sendToKernel({ type: "pipe_close_read", pid, pipeIdx });
  }

  /** Check if a pipe's write end is still open. */
  async pipeIsWriteOpen(pid: number, pipeIdx: number): Promise<boolean> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pipe_is_write_open",
      requestId,
      pid,
      pipeIdx,
    }) as Promise<boolean>;
  }

  /** Wake any process blocked on reading the given pipe. */
  wakeBlockedReaders(pipeIdx: number): void {
    this.sendToKernel({ type: "wake_blocked_readers", pipeIdx });
  }

  /** Wake any process blocked on writing to the given pipe. */
  wakeBlockedWriters(pipeIdx: number): void {
    this.sendToKernel({ type: "wake_blocked_writers", pipeIdx });
  }

  /**
   * Send an HTTP request to a server running inside the kernel and return
   * the parsed response. Bypasses real TCP — uses the kernel's
   * `kernel_inject_connection` path directly. Prototype API.
   *
   * The in-kernel server must already be listening on `port`. Each call
   * opens a fresh injected connection (no pipelining).
   */
  async fetchInKernel(
    port: number,
    request: HttpRequest,
    options?: { timeoutMs?: number },
  ): Promise<HttpResponse> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "http_request",
      requestId,
      port,
      request,
      timeoutMs: options?.timeoutMs,
    }) as Promise<HttpResponse>;
  }

  /** Pick a listener target for the given port. */
  async pickListenerTarget(port: number): Promise<{ pid: number; fd: number } | null> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pick_listener_target",
      requestId,
      port,
    }) as Promise<{ pid: number; fd: number } | null>;
  }

  /** Append data to a process's stdin buffer. */
  appendStdinData(pid: number, data: Uint8Array): void {
    this.sendToKernel({ type: "append_stdin_data", pid, data });
  }

  /** Set a process's stdin data (complete buffer with implicit EOF). */
  setStdinData(pid: number, data: Uint8Array): void {
    this.sendToKernel({ type: "set_stdin_data", pid, data });
  }

  /** Check if a process's stdin buffer has been fully consumed. */
  async isStdinConsumed(pid: number): Promise<boolean> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "is_stdin_consumed",
      requestId,
      pid,
    }) as Promise<boolean>;
  }

  /**
   * Push a mouse event into the kernel's `/dev/input/mice` queue. Pass
   * deltas in PS/2 sign convention (positive-right, positive-up — invert
   * the browser's deltaY before calling) and a button bitmask
   * (bit0=left, bit1=right, bit2=middle).
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void {
    this.sendToKernel({ type: "mouse_inject", dx, dy, buttons });
  }

  /**
   * Hand an `OffscreenCanvas` to the kernel worker as the scanout
   * target for KMS CRTC `crtcId`. The worker's vblank pump blits the
   * CRTC's currently-bound framebuffer into this canvas at 60 Hz.
   *
   * `canvas` is transferred — the main thread loses control of it.
   * Pass `stats` to receive blit + page-flip telemetry (see
   * `attachKmsStats` for the slot layout).
   */
  kmsAttachCanvas(
    crtcId: number,
    canvas: OffscreenCanvas,
    stats?: SharedArrayBuffer,
    opts?: { mode?: "auto" | "2d" | "webgl2" },
  ): void {
    this.sendToKernel(
      { type: "kms_attach_canvas", crtcId, canvas, stats, opts },
      [canvas],
    );
  }

  /**
   * Register a stats SAB for KMS CRTC `crtcId` without binding a
   * scanout canvas. The worker still writes `commit_count` and
   * `last_frame_us` into slots 5/6 each vblank tick. Used by demos
   * that render through WebGL rather than the 2D blit path.
   */
  kmsAttachStats(crtcId: number, stats: SharedArrayBuffer): void {
    this.sendToKernel({ type: "kms_attach_stats", crtcId, stats });
  }

  /**
   * Drain up to `maxBytes` of PCM audio buffered in the kernel's
   * `/dev/dsp` ring. Returns the bytes plus the configured sample
   * rate / channel count so the caller can build a correctly-sized
   * `AudioBuffer`. Empty `Uint8Array` if the ring is empty.
   *
   * The audio scheduler in `apps/browser-demos/pages/doom/main.ts` calls
   * this every ~50 ms via setInterval, decodes S16 → Float32, and
   * schedules the result on a chained `AudioBufferSourceNode` so DOOM
   * SFX play continuously while the game is running.
   */
  async drainAudio(maxBytes: number): Promise<{
    bytes: Uint8Array;
    sampleRate: number;
    channels: number;
  }> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "audio_drain",
      requestId,
      maxBytes,
    }) as Promise<{ bytes: Uint8Array; sampleRate: number; channels: number }>;
  }

  // ── PTY methods ──

  /** Write data to the PTY master for a process. */
  ptyWrite(pid: number, data: Uint8Array): void {
    this.sendToKernel({ type: "pty_write", pid, data });
  }

  /** Resize the PTY for a process. */
  ptyResize(pid: number, rows: number, cols: number): void {
    this.sendToKernel({ type: "pty_resize", pid, rows, cols });
  }

  /** Register a callback for PTY output data from a process. Drains any
   * output that arrived before this call (e.g., when boot() returns the
   * process is already running). */
  onPtyOutput(pid: number, callback: (data: Uint8Array) => void): void {
    this.ptyOutputCallbacks.set(pid, callback);
    const pending = this.pendingPtyOutput.get(pid);
    if (pending) {
      this.pendingPtyOutput.delete(pid);
      for (const chunk of pending) callback(chunk);
    }
  }

  /** Remove any registered or buffered PTY output for a process. */
  clearPtyOutput(pid: number): void {
    this.ptyOutputCallbacks.delete(pid);
    this.pendingPtyOutput.delete(pid);
  }

  /** Terminate a specific process. */
  async terminateProcess(pid: number, status = -1): Promise<void> {
    const requestId = this.nextRequestId++;
    await this.request(requestId, {
      type: "terminate_process",
      requestId,
      pid,
      status,
    });
    // Resolve exit promise
    const resolver = this.exitResolvers.get(pid);
    this.exitResolvers.delete(pid);
    if (resolver) resolver(status);
  }

  /**
   * Read a file out of the kernel-owned VFS from the main thread. Returns the
   * bytes, or `null` if the path does not exist / is not readable. This is the
   * readback path for collecting artifacts a process wrote; the main thread
   * never receives the live VFS SharedArrayBuffer.
   */
  async readFileFromVfs(path: string): Promise<Uint8Array | null> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_vfs_file",
      requestId,
      path,
    });
    return (result as Uint8Array | null) ?? null;
  }

  /**
   * Read a file and its permission bits from the worker-owned VFS. This is
   * useful for callers that temporarily replace a path between process spawns
   * and must restore the exact prior state afterward.
   */
  async readFileSnapshotFromVfs(path: string): Promise<VfsFileSnapshot | null> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_vfs_file",
      requestId,
      path,
      includeMode: true,
    });
    return (result as VfsFileSnapshot | null) ?? null;
  }

  /**
   * Create or replace a regular file in the worker-owned VFS. The mutation is
   * performed by the kernel worker, preserving exclusive VFS ownership; call
   * this only while guest processes that could access the path are stopped.
   * The parent directory must already exist.
   */
  async writeFileToVfs(
    path: string,
    data: Uint8Array,
    mode = 0o644,
  ): Promise<void> {
    const requestId = this.nextRequestId++;
    const owned = data.slice();
    await this.request(requestId, {
      type: "write_vfs_file",
      requestId,
      path,
      data: owned,
      mode: mode & 0o7777,
    }, [owned.buffer]);
  }

  /**
   * Remove a path from the worker-owned VFS between process spawns. Returns
   * false when the path did not exist.
   */
  async unlinkFileFromVfs(path: string): Promise<boolean> {
    const requestId = this.nextRequestId++;
    const result = await this.request(requestId, {
      type: "unlink_vfs_file",
      requestId,
      path,
    });
    return result === true;
  }

  /** Destroy the kernel and release all resources. */
  async destroy(): Promise<void> {
    const requestId = this.nextRequestId++;
    await this.request(requestId, {
      type: "destroy",
      requestId,
    });
    this.kernelWorkerHandle.terminate();
    this.exitResolvers.clear();
    this.unclaimedExitStatuses.clear();
    this.pendingRequests.clear();
    this.ptyOutputCallbacks.clear();
    this.options.onHttpBridgePendingRequests?.(0);
    this.lazyDownloadListeners.clear();
    // Release every main-thread reference to shared buffers this kernel held.
    // `fbMemoryByPid`/`framebuffers` retain typed-array views over process
    // `WebAssembly.Memory` (up to 1 GiB max each) posted from the worker for
    // framebuffer demos; `pendingPtyOutput` holds buffered PTY chunks. On
    // WebKit these are reclaimed only when the page drops them — terminating
    // the worker does not, because the main thread is a co-owner. Leaving
    // them set makes reclamation depend on the whole BrowserKernel being GC'd
    // (and pins the memory outright if anything still references this kernel).
    this.fbMemoryByPid.clear();
    this.framebuffers.clear();
    this.pendingPtyOutput.clear();
  }

  // ── Private helpers ──

  /** Ensure SSL cert env vars select the image-owned platform trust bundle.
   *  OpenSSL's configured directory is `/etc/ssl`; browser sessions replace
   *  only this CA-bundle path with their ephemeral MITM root. */
  private mergeEnv(env: string[]): string[] {
    const sslVars = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "SSL_CERT_DIR=/etc/ssl/certs",
    ];
    const result = [...env];
    for (const v of sslVars) {
      const key = v.split("=")[0];
      if (!result.some(e => e.startsWith(key + "="))) {
        result.push(v);
      }
    }
    return result;
  }

  /** Diagnostic: turn on per-(pid, syscall_nr) timing aggregation in the
   *  kernel worker. Call sysprofDump() afterward to print and reset. */
  sysprofStart(): void {
    this.kernelWorkerHandle.postMessage({ type: "sysprof_start" } as unknown as MainToKernelMessage, []);
  }
  sysprofDump(): void {
    this.kernelWorkerHandle.postMessage({ type: "sysprof_dump" } as unknown as MainToKernelMessage, []);
  }
  pidMapDump(): void {
    this.kernelWorkerHandle.postMessage({ type: "pid_map_dump" } as unknown as MainToKernelMessage, []);
  }

  private sendToKernel(msg: MainToKernelMessage, transfer?: Transferable[]): void {
    this.kernelWorkerHandle.postMessage(msg, transfer ?? []);
  }

  private claimExitStatus(pid: number, spawnStartedBeforeExitSequence: number): Promise<number> {
    const unclaimed = this.unclaimedExitStatuses.get(pid);
    this.unclaimedExitStatuses.delete(pid);
    if (unclaimed !== undefined && unclaimed.sequence > spawnStartedBeforeExitSequence) {
      return Promise.resolve(unclaimed.status);
    }
    return new Promise<number>((resolve) => {
      this.exitResolvers.set(pid, resolve);
    });
  }

  private request(requestId: number, msg: MainToKernelMessage, transfer?: Transferable[]): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.sendToKernel(msg, transfer);
    });
  }

  private emitLazyDownload(event: LazyDownloadEvent): void {
    try { this.options.onLazyDownload?.(event); } catch { /* host callbacks should not break delivery */ }
    for (const cb of this.lazyDownloadListeners) {
      try { cb(event); } catch { /* listener errors don't break the loop */ }
    }
  }

  private handleWorkerMessage(msg: KernelToMainMessage): void {
    switch (msg.type) {
      case "ready":
      case "init_error":
        // The temporary boot listener resolves or rejects initialization. The
        // permanent listener also receives these messages, so account for
        // them explicitly rather than relying on an implicit fall-through.
        break;
      case "response": {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          this.pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }
      case "exit": {
        const resolver = this.exitResolvers.get(msg.pid);
        if (resolver) {
          this.exitResolvers.delete(msg.pid);
          resolver(msg.status);
        } else {
          this.unclaimedExitStatuses.set(msg.pid, {
            status: msg.status,
            sequence: ++this.exitSequence,
          });
          while (this.unclaimedExitStatuses.size > 256) {
            const oldest = this.unclaimedExitStatuses.keys().next().value;
            if (oldest === undefined) break;
            this.unclaimedExitStatuses.delete(oldest);
          }
        }
        this.options.onProcessEvent?.({ kind: "exit", pid: msg.pid, exitStatus: msg.status });
        break;
      }
      case "proc_event": {
        // fork / exec / posix_spawn happened inside the kernel — these
        // don't come through BrowserKernel.spawn(), so the worker posts
        // them directly. Exit is delivered separately via the existing
        // "exit" message above.
        const event = msg.kind === "spawn"
          ? { kind: msg.kind, pid: msg.pid, ppid: msg.ppid }
          : { kind: msg.kind, pid: msg.pid };
        this.options.onProcessEvent?.(event);
        break;
      }
      case "http_bridge_pending":
        this.options.onHttpBridgePendingRequests?.(msg.count);
        break;
      case "stdout":
        this.options.onStdout?.(msg.data);
        break;
      case "stderr":
        this.options.onStderr?.(msg.data);
        break;
      case "host_diagnostic": {
        this.options.onHostDiagnostic?.({
          pid: msg.pid,
          source: msg.source,
          message: msg.message,
          ...(msg.status === undefined ? {} : { status: msg.status }),
        });
        break;
      }
      case "pty_output": {
        const cb = this.ptyOutputCallbacks.get(msg.pid);
        if (cb) {
          cb(msg.data);
        } else {
          // Buffer until onPtyOutput registers a callback (race window
          // between worker starting the process and main thread wiring
          // the handler in boot()).
          let buf = this.pendingPtyOutput.get(msg.pid);
          if (!buf) {
            buf = [];
            this.pendingPtyOutput.set(msg.pid, buf);
          }
          buf.push(msg.data);
        }
        break;
      }
      case "listen_tcp":
        this.options.onListenTcp?.(msg.pid, msg.fd, msg.port);
        break;
      case "fb_bind":
        this.fbMemoryByPid.set(msg.pid, msg.memory);
        this.framebuffers.bind({
          pid: msg.pid,
          addr: msg.addr,
          len: msg.len,
          w: msg.w,
          h: msg.h,
          stride: msg.stride,
          fmt: msg.fmt,
        });
        break;
      case "fb_unbind":
        this.fbMemoryByPid.delete(msg.pid);
        this.framebuffers.unbind(msg.pid);
        break;
      case "fb_rebind_memory":
        this.fbMemoryByPid.set(msg.pid, msg.memory);
        this.framebuffers.rebindMemory(msg.pid);
        break;
      case "fb_write":
        this.framebuffers.fbWrite(msg.pid, msg.offset, msg.bytes);
        break;
      case "lazy_download":
        this.emitLazyDownload(msg.event);
        break;
      default: {
        // Keep this dispatch coupled to KernelToMainMessage as the protocol
        // grows. Runtime values still originate outside TypeScript, so make a
        // malformed/unknown worker message visible instead of dropping it.
        const exhaustive: never = msg;
        void exhaustive;
        console.error(
          `[BrowserKernel] unknown kernel-worker message type: ${String((msg as { type?: unknown }).type)}`,
        );
        break;
      }
    }
  }

  /**
   * Return the wasm `Memory` for the framebuffer-bound process. Used by
   * the canvas renderer to build typed-array views over the bound
   * region.
   */
  getProcessMemory(pid: number): WebAssembly.Memory | undefined {
    return this.fbMemoryByPid.get(pid);
  }
}
