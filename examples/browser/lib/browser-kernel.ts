/**
 * BrowserKernel — Thin proxy that communicates with a dedicated kernel
 * web worker via MessagePort. The kernel worker owns the Wasm instance
 * and all process lifecycle (fork/exec/clone/exit).
 *
 * The main thread handles only UI, filesystem setup, and application-level
 * clients (MySQL, Redis) via async pipe operations.
 */

import { MemoryFileSystem, type LazyFileEntry } from "../../../host/src/vfs/memory-fs";
import { FramebufferRegistry } from "../../../host/src/framebuffer/registry";
import type {
  MainToKernelMessage,
  KernelToMainMessage,
} from "./kernel-worker-protocol";
import kernelWasmUrl from "@kernel-wasm?url";
import rootfsVfsUrl from "@rootfs-vfs?url";
import workerEntryUrl from "../../../host/src/worker-entry-browser.ts?worker&url";
import kernelWorkerEntryUrl from "./kernel-worker-entry.ts?worker&url";

const DEFAULT_MAX_PAGES = 16384;

export interface BrowserKernelOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** Initial SharedArrayBuffer size for MemoryFileSystem (default: 16MB).
   *  The VFS grows automatically on demand up to maxFsSize. */
  fsSize?: number;
  /** Maximum VFS size the SharedArrayBuffer can grow to (default: 4x fsSize). */
  maxFsSize?: number;
  /** Maximum wasm memory pages per process (default: 16384 = 1GB). Reduce for
   *  multi-process demos to avoid exhausting browser memory limits. */
  maxMemoryPages?: number;
  /** Additional VFS mount points */
  extraMounts?: Array<{ mountPoint: string; backend: { open: Function } }>;
  /** Environment variables for spawned processes */
  env?: string[];
  /** Called when a process writes to stdout */
  onStdout?: (data: Uint8Array) => void;
  /** Called when a process writes to stderr */
  onStderr?: (data: Uint8Array) => void;
  /** Called when a process requests a TCP listener (for service worker bridging) */
  onListenTcp?: (pid: number, fd: number, port: number) => void;
  /** Pre-compiled thread module for clone(). Avoids recompiling large wasm for each thread. */
  threadModule?: WebAssembly.Module;
  /** Pre-built MemoryFileSystem (e.g. from a VFS image). When provided, skips
   *  SAB creation, mkfs, and standard directory/services setup — uses the
   *  provided filesystem as-is.
   *  @deprecated — use {@link BrowserKernel.boot} with `vfsImage` instead. */
  memfs?: MemoryFileSystem;
  /** When true, the kernel worker owns the VFS exclusively. The constructor
   *  skips fsSab allocation; `kernel.fs` is unavailable; the demo passes a
   *  pre-built `vfsImage` to {@link BrowserKernel.boot}. This is the target
   *  architecture — `kernel.fs` and `memfs` will be removed once all demos
   *  migrate. */
  kernelOwnedFs?: boolean;
  /** Debug: log every syscall to the kernel-worker console. Noisy. */
  enableSyscallLog?: boolean;
  /** Debug: only log syscalls for processes of the given pointer width
   *  (4=wasm32, 8=wasm64). Use 8 to focus on a single wasm64 process in a
   *  mixed-arch demo. */
  syscallLogPtrWidth?: 4 | 8;
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
  /** Argv for the first (and currently only "init") process. argv[0] should
   *  be a path inside the VFS image. */
  argv: string[];
  /** Override the kernel's default environment for the first process. */
  env?: string[];
  /** Working directory for the first process. */
  cwd?: string;
  /** Allocate a PTY for the first process. */
  pty?: boolean;
  /** Initial stdin bytes (with implicit EOF). */
  stdin?: Uint8Array;
}

export class BrowserKernel {
  private kernelWorkerHandle!: Worker;
  /** Set when `kernelOwnedFs` is true — main thread has no FS access. */
  private kernelOwnedFs: boolean;
  /** undefined in `kernelOwnedFs` mode. */
  private memfs?: MemoryFileSystem;
  /** undefined in `kernelOwnedFs` mode. */
  private fsSab?: SharedArrayBuffer;
  private shmSab: SharedArrayBuffer;
  private maxPages: number;
  /**
   * @internal Legacy spawn() pre-allocates pids on the main thread. New
   * code uses kernel.boot() which lets the worker allocate, making this
   * counter irrelevant. Once all demos migrate to boot(), this goes away.
   *
   * Starts at 100 to skip the kernel's reserved range (virtual init at
   * pid 1, future kernel threads). The architectural fix is in the spawn
   * message protocol where pid is now optional and the worker is the
   * authority.
   */
  nextPid = 100;
  private options: Required<
    Pick<BrowserKernelOptions, "maxWorkers" | "fsSize" | "env">
  > &
    BrowserKernelOptions;
  private exitResolvers = new Map<number, (status: number) => void>();
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

  constructor(options: BrowserKernelOptions = {}) {
    this.maxPages = options.maxMemoryPages ?? DEFAULT_MAX_PAGES;
    this.options = {
      maxWorkers: 4,
      fsSize: 16 * 1024 * 1024,
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "USER=browser",
        "LOGNAME=browser",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "SSL_CERT_DIR=/etc/ssl/certs",
      ],
      ...options,
    };

    this.shmSab = new SharedArrayBuffer(1024 * 1024);
    MemoryFileSystem.create(this.shmSab); // format shm SAB for kernel worker
    this.kernelOwnedFs = options.kernelOwnedFs ?? false;

    if (this.kernelOwnedFs) {
      // Kernel-owned FS — main thread doesn't allocate fsSab/memfs at all.
      // The demo will pass `vfsImage` bytes to boot(), and the worker
      // builds its own memfs from those bytes.
    } else if (options.memfs) {
      // Use pre-built filesystem — skip SAB creation, mkfs, and directory setup
      this.memfs = options.memfs;
      this.fsSab = options.memfs.sharedBuffer;
    } else {
      const fsSize = this.options.fsSize;
      const maxFsSize = this.options.maxFsSize ?? fsSize * 4;
      this.fsSab = new SharedArrayBuffer(fsSize, { maxByteLength: maxFsSize });
      this.memfs = MemoryFileSystem.create(this.fsSab, maxFsSize);

      // Create standard directories. The legacy SAB path starts from a
      // bare memfs — demos populate everything else themselves. Once a
      // demo migrates to `boot()` with a `vfsImage`, /etc/services and
      // friends come from the rootfs image via DEFAULT_MOUNT_SPEC and
      // these mkdirs become redundant.
      this.memfs.mkdir("/tmp", 0o777);
      this.memfs.mkdir("/home", 0o755);
      this.memfs.mkdir("/dev", 0o755);
      this.memfs.mkdir("/etc", 0o755);
    }
  }

  /**
   * Access the underlying MemoryFileSystem for pre-populating files.
   * @deprecated — only available when `kernelOwnedFs` is false. New demos
   * should build a `vfsImage` and call {@link BrowserKernel.boot} instead.
   * Throws when `kernelOwnedFs` is true.
   */
  get fs(): MemoryFileSystem {
    if (!this.memfs) {
      throw new Error(
        "kernel.fs is unavailable in kernelOwnedFs mode. Build a vfsImage with " +
        "MemoryFileSystem + saveImage() and pass it to kernel.boot() instead.",
      );
    }
    return this.memfs;
  }

  /**
   * Initialize the kernel by spawning the dedicated kernel worker.
   * Legacy path — uses the SAB-shared `kernel.fs` for pre-population.
   * Throws when `kernelOwnedFs` is true; use {@link BrowserKernel.boot} instead.
   */
  async init(kernelWasmBytes?: ArrayBuffer): Promise<void> {
    if (this.kernelOwnedFs) {
      throw new Error("kernel.init() is not available in kernelOwnedFs mode. Use kernel.boot() with a vfsImage.");
    }
    // Always fetch the canonical rootfs.vfs alongside the kernel wasm so
    // the worker can overlay /etc/{passwd,group,hosts,services,...} onto
    // the demo's SAB-backed memfs. Synthetic in-kernel content for those
    // paths was removed in PR 4/5 — without this overlay programs that
    // call getpwnam/gethostbyname fail on legacy-SAB demos.
    const [wasmBytes, rootfsVfsBuf] = await Promise.all([
      kernelWasmBytes
        ? Promise.resolve(kernelWasmBytes)
        : fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(rootfsVfsUrl).then((r) => r.arrayBuffer()),
    ]);

    await this.bootWorker({
      kernelWasmBytes: wasmBytes,
      fsSab: this.fsSab!,
      rootfsImage: new Uint8Array(rootfsVfsBuf),
    });

    // Forward any lazy archive metadata from a pre-loaded VFS image so the
    // worker can materialize archive-backed files on first exec.
    const archiveEntries = this.memfs!.exportLazyArchiveEntries();
    if (archiveEntries.length > 0) {
      this.sendToKernel({ type: "register_lazy_archives", entries: archiveEntries });
    }
  }

  /**
   * Boot the kernel from a pre-built VFS image and spawn the first process.
   * The worker takes ownership of the FS; the main thread no longer has FS
   * access. Returns the first process's exit code.
   *
   * Demos build the VFS image on the main thread using MemoryFileSystem +
   * the helpers in `host/src/vfs/image-helpers`, call `saveImage()` for
   * bytes, then pass them here.
   *
   * Requires `kernelOwnedFs: true` in the constructor options.
   */
  async boot(options: BrowserKernelBootOptions): Promise<{ pid: number; exit: Promise<number> }> {
    if (!this.kernelOwnedFs) {
      throw new Error(
        "kernel.boot() requires kernelOwnedFs: true in BrowserKernel constructor options.",
      );
    }
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
    });

    // Spawn the first process — kernel worker assigns the pid and returns
    // it in the response. Pid is the single source of truth in the worker.
    return this.spawnFirstProcess(options);
  }

  /**
   * Internal: set up the worker, attach handlers, send init, await ready.
   * Both `init()` (legacy fsSab path) and `boot()` (vfsImage path) call here.
   */
  private async bootWorker(opts: {
    kernelWasmBytes: ArrayBuffer;
    fsSab?: SharedArrayBuffer;
    vfsImage?: Uint8Array;
    rootfsImage?: Uint8Array;
  }): Promise<void> {
    // Create the kernel worker
    this.kernelWorkerHandle = new Worker(kernelWorkerEntryUrl, { type: "module" });

    this.kernelWorkerHandle.onmessage = (e: MessageEvent) => {
      this.handleWorkerMessage(e.data as KernelToMainMessage);
    };
    this.kernelWorkerHandle.onerror = (e: ErrorEvent) => {
      console.error("[BrowserKernel] Kernel worker error:", e.message);
      const err = new Error(`Kernel worker error: ${e.message}`);
      for (const [, { reject }] of this.pendingRequests) {
        reject(err);
      }
      this.pendingRequests.clear();
    };

    await new Promise<void>((resolve) => {
      const readyHandler = (e: MessageEvent) => {
        if (e.data?.type === "ready") {
          this.kernelWorkerHandle.removeEventListener("message", readyHandler);
          resolve();
        }
      };
      this.kernelWorkerHandle.addEventListener("message", readyHandler);

      // Slice so the caller's ArrayBuffer isn't detached (allows restart)
      const transferBuf = opts.kernelWasmBytes.slice(0);
      const initMsg: MainToKernelMessage = {
        type: "init",
        kernelWasmBytes: transferBuf,
        fsSab: opts.fsSab,
        vfsImage: opts.vfsImage,
        rootfsImage: opts.rootfsImage,
        shmSab: this.shmSab,
        workerEntryUrl,
        config: {
          maxWorkers: this.options.maxWorkers,
          maxMemoryPages: this.maxPages,
          env: this.options.env,
          enableSyscallLog: this.options.enableSyscallLog,
          syscallLogPtrWidth: this.options.syscallLogPtrWidth,
        },
      };
      this.kernelWorkerHandle.postMessage(initMsg, [transferBuf]);
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

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      // No pid — the kernel worker allocates and returns it.
      programPath: options.argv[0],
      argv: options.argv,
      env: this.mergeEnv(options.env ?? this.options.env),
      cwd: options.cwd,
      pty: options.pty,
      stdin: options.stdin,
      maxPages: this.maxPages,
    }) as number;

    const exit = new Promise<number>((resolve) => {
      this.exitResolvers.set(pid, resolve);
    });

    if (options.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

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
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: { env?: string[]; cwd?: string; stdin?: Uint8Array; pty?: boolean },
  ): Promise<number> {
    const pid = this.nextPid++;
    const requestId = this.nextRequestId++;

    const exitPromise = new Promise<number>((resolve) => {
      this.exitResolvers.set(pid, resolve);
    });

    // Clone programBytes since it gets transferred (detached)
    const bytesToSend = programBytes.slice(0);

    await this.request(requestId, {
      type: "spawn",
      requestId,
      pid,
      programBytes: bytesToSend,
      argv,
      env: this.mergeEnv(options?.env ?? this.options.env),
      cwd: options?.cwd,
      pty: options?.pty,
      stdin: options?.stdin,
      maxPages: this.maxPages,
    }, [bytesToSend]);

    // Register PTY output callback if pty was requested
    if (options?.pty) {
      this.sendToKernel({ type: "register_pty_output", pid });
    }

    return exitPromise;
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

  /** Pick a listener target for the given port. */
  async pickListenerTarget(port: number): Promise<{ pid: number; fd: number } | null> {
    const requestId = this.nextRequestId++;
    return this.request(requestId, {
      type: "pick_listener_target",
      requestId,
      port,
    }) as Promise<{ pid: number; fd: number } | null>;
  }

  /**
   * Register lazy files: creates stubs in the VFS and forwards metadata
   * to the kernel worker so it can materialize on demand via sync XHR.
   */
  registerLazyFiles(entries: Array<{ path: string; url: string; size: number; mode?: number }>): void {
    const lazyEntries: LazyFileEntry[] = [];
    for (const e of entries) {
      const ino = this.memfs.registerLazyFile(e.path, e.url, e.size, e.mode);
      lazyEntries.push({ ino, path: e.path, url: e.url, size: e.size });
    }
    this.sendToKernel({ type: "register_lazy_files", entries: lazyEntries });
  }

  /**
   * Async-materialize a lazy file (or archive-backed file). Useful for
   * data files (not exec targets) the program will open via the VFS —
   * exec paths get auto-materialized by the kernel worker, but
   * arbitrary opens go through the kernel's synchronous read path.
   * Returns true if a fetch happened, false if already materialized
   * or not lazy.
   */
  async ensureMaterialized(path: string): Promise<boolean> {
    return this.memfs.ensureMaterialized(path);
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

  /** Destroy the kernel and release all resources. */
  async destroy(): Promise<void> {
    const requestId = this.nextRequestId++;
    await this.request(requestId, {
      type: "destroy",
      requestId,
    });
    this.kernelWorkerHandle.terminate();
    this.exitResolvers.clear();
    this.pendingRequests.clear();
    this.ptyOutputCallbacks.clear();
  }

  // ── Private helpers ──

  /** Ensure SSL cert env vars are present in the environment array.
   *  These are needed because OpenSSL's compiled-in openssldir is a host
   *  path that doesn't exist in the Wasm VFS. */
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

  private request(requestId: number, msg: MainToKernelMessage, transfer?: Transferable[]): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.sendToKernel(msg, transfer);
    });
  }

  private handleWorkerMessage(msg: KernelToMainMessage): void {
    switch (msg.type) {
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
        this.exitResolvers.delete(msg.pid);
        if (resolver) resolver(msg.status);
        break;
      }
      case "stdout":
        this.options.onStdout?.(msg.data);
        break;
      case "stderr":
        this.options.onStderr?.(msg.data);
        break;
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
