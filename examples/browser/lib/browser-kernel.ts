/**
 * BrowserKernel — Thin proxy that communicates with a dedicated kernel
 * web worker via MessagePort. The kernel worker owns the Wasm instance
 * and all process lifecycle (fork/exec/clone/exit).
 *
 * The main thread handles only UI, filesystem setup, and application-level
 * clients (MySQL, Redis) via async pipe operations.
 */

import { MemoryFileSystem, type LazyFileEntry } from "../../../host/src/vfs/memory-fs";
import type {
  MainToKernelMessage,
  KernelToMainMessage,
} from "./kernel-worker-protocol";
import kernelWasmUrl from "../../../host/wasm/wasm_posix_kernel.wasm?url";
import workerEntryUrl from "../../../host/src/worker-entry-browser.ts?worker&url";
import kernelWorkerEntryUrl from "./kernel-worker-entry.ts?worker&url";

const DEFAULT_MAX_PAGES = 16384;

export interface BrowserKernelOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** SharedArrayBuffer size for MemoryFileSystem (default: 16MB) */
  fsSize?: number;
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
}

export class BrowserKernel {
  private kernelWorkerHandle!: Worker;
  private memfs: MemoryFileSystem;
  private fsSab: SharedArrayBuffer;
  private shmSab: SharedArrayBuffer;
  private maxPages: number;
  /** @internal exposed for PtyTerminal pid tracking */
  nextPid = 1;
  private options: Required<
    Pick<BrowserKernelOptions, "maxWorkers" | "fsSize" | "env">
  > &
    BrowserKernelOptions;
  private exitResolvers = new Map<number, (status: number) => void>();
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private nextRequestId = 1;
  private ptyOutputCallbacks = new Map<number, (data: Uint8Array) => void>();

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

    this.fsSab = new SharedArrayBuffer(this.options.fsSize);
    this.shmSab = new SharedArrayBuffer(1024 * 1024);
    this.memfs = MemoryFileSystem.create(this.fsSab);
    MemoryFileSystem.create(this.shmSab); // format shm SAB for kernel worker

    // Create standard directories
    this.memfs.mkdir("/tmp", 0o777);
    this.memfs.mkdir("/home", 0o755);
    this.memfs.mkdir("/dev", 0o755);
    this.memfs.mkdir("/etc", 0o755);

    // Populate /etc/services for getservbyname/getservbyport
    const services = [
      "tcpmux\t\t1/tcp",
      "echo\t\t7/tcp",
      "echo\t\t7/udp",
      "discard\t\t9/tcp\t\tsink null",
      "discard\t\t9/udp\t\tsink null",
      "ftp-data\t20/tcp",
      "ftp\t\t21/tcp",
      "ssh\t\t22/tcp",
      "telnet\t\t23/tcp",
      "smtp\t\t25/tcp\t\tmail",
      "domain\t\t53/tcp",
      "domain\t\t53/udp",
      "http\t\t80/tcp\t\twww",
      "pop3\t\t110/tcp\t\tpop-3",
      "nntp\t\t119/tcp\t\treadnews untp",
      "ntp\t\t123/udp",
      "imap\t\t143/tcp\t\timap2",
      "snmp\t\t161/udp",
      "https\t\t443/tcp",
      "imaps\t\t993/tcp",
      "pop3s\t\t995/tcp",
    ].join("\n") + "\n";
    const fd = this.memfs.open("/etc/services", 0x241, 0o644);
    const enc = new TextEncoder().encode(services);
    this.memfs.write(fd, enc, enc.length, -1);
    this.memfs.close(fd);
  }

  /** Access the underlying MemoryFileSystem for pre-populating files */
  get fs(): MemoryFileSystem {
    return this.memfs;
  }

  /** Initialize the kernel by spawning the dedicated kernel worker */
  async init(kernelWasmBytes?: ArrayBuffer): Promise<void> {
    const wasmBytes =
      kernelWasmBytes ??
      (await fetch(kernelWasmUrl).then((r) => r.arrayBuffer()));

    // Create the kernel worker
    this.kernelWorkerHandle = new Worker(kernelWorkerEntryUrl, { type: "module" });

    // Set up message handler
    this.kernelWorkerHandle.onmessage = (e: MessageEvent) => {
      this.handleWorkerMessage(e.data as KernelToMainMessage);
    };
    this.kernelWorkerHandle.onerror = (e: ErrorEvent) => {
      console.error("[BrowserKernel] Kernel worker error:", e.message);
      // Reject all pending requests so callers don't hang forever
      const err = new Error(`Kernel worker error: ${e.message}`);
      for (const [, { reject }] of this.pendingRequests) {
        reject(err);
      }
      this.pendingRequests.clear();
    };

    // Send init message and wait for ready
    await new Promise<void>((resolve) => {
      const readyHandler = (e: MessageEvent) => {
        if (e.data?.type === "ready") {
          this.kernelWorkerHandle.removeEventListener("message", readyHandler);
          resolve();
        }
      };
      this.kernelWorkerHandle.addEventListener("message", readyHandler);

      const initMsg: MainToKernelMessage = {
        type: "init",
        kernelWasmBytes: wasmBytes,
        fsSab: this.fsSab,
        shmSab: this.shmSab,
        workerEntryUrl,
        config: {
          maxWorkers: this.options.maxWorkers,
          maxMemoryPages: this.maxPages,
          env: this.options.env,
        },
      };

      // Slice so the caller's ArrayBuffer isn't detached (allows restart)
      const transferBuf = wasmBytes.slice(0);
      initMsg.kernelWasmBytes = transferBuf;
      this.kernelWorkerHandle.postMessage(initMsg, [transferBuf]);
    });
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

  /** Register a callback for PTY output data from a process. */
  onPtyOutput(pid: number, callback: (data: Uint8Array) => void): void {
    this.ptyOutputCallbacks.set(pid, callback);
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
        if (cb) cb(msg.data);
        break;
      }
      case "listen_tcp":
        this.options.onListenTcp?.(msg.pid, msg.fd, msg.port);
        break;
    }
  }
}
