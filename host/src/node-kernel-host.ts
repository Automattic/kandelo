/**
 * NodeKernelHost — Main-thread proxy that communicates with a dedicated
 * kernel worker_thread via messages. The kernel worker owns the Wasm
 * instance and all process lifecycle (fork/exec/clone/exit).
 *
 * Analogous to BrowserKernel but for Node.js: no SharedArrayBuffer VFS,
 * no worker entry URLs, TCP bridging handled natively by NodePlatformIO.
 *
 * Usage:
 *   const host = new NodeKernelHost({ onStdout: (pid, data) => ... });
 *   await host.init();
 *   const exitCode = await host.spawn(programBytes, ["hello"], { env: [...] });
 *   await host.destroy();
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Worker as NodeThreadWorker } from "node:worker_threads";
import { resolveBinary } from "./binary-resolver";
import type {
  HostDiagnostic,
  MainToKernelMessage,
  KernelToMainMessage,
  ResolveExecRequestMessage,
} from "./node-kernel-protocol";
import type { ProcessSnapshot, SyscallTraceEvent } from "./kernel-worker";
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type { LazyDownloadEvent } from "./vfs/memory-fs";
import {
  snapshotClosedLazyAssets,
  type ClosedLazyAsset,
} from "./vfs/closed-lazy-assets";

export type { HttpRequest, HttpResponse };

function currentModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}

const MODULE_DIR = currentModuleDir();
const DESTROY_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_SSL_ENV = [
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
] as const;

export interface NodeKernelHostOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** Maximum wasm memory pages per process (default: 16384 = 1GB). Initial
   *  memory is smaller and grows on demand up to this cap. */
  maxPages?: number;
  /** Host default pthread slots when a wasm binary declares -1 (default: 16). */
  defaultThreadSlots?: number;
  /** Size of the data buffer for syscall data transfer (default: 65536).
   *  Increase for programs that do large pwrite() calls (e.g. InnoDB). */
  dataBufferSize?: number;
  /** Virtual path → host filesystem path for exec resolution inside the worker */
  execPrograms?: Record<string, string>;
  /** Attach a real-TCP backend in the worker so wasm programs can dial
   *  external hosts via Node `net.Socket`. */
  enableTcpNetwork?: boolean;
  /** Called when a process writes to stdout */
  onStdout?: (pid: number, data: Uint8Array) => void;
  /** Called when a process writes to stderr */
  onStderr?: (pid: number, data: Uint8Array) => void;
  /** Called for host-runtime diagnostics that are not guest stderr. */
  onHostDiagnostic?: (diagnostic: HostDiagnostic) => void;
  /** Called as lazy VFS files or trees are fetched on demand. */
  onLazyDownload?: (event: LazyDownloadEvent) => void;
  /** Called when a process writes PTY output */
  onPtyOutput?: (pid: number, data: Uint8Array) => void;
  /** Called when a process is spawned, execs a new program, or exits.
   *  Used by Inspector-style UIs to refresh their process table without
   *  polling. Kernel-internal fork and posix_spawn events carry `ppid`;
   *  the synthetic root spawn does not. */
  onProcessEvent?: (event: { kind: "spawn" | "exec" | "exit"; pid: number; ppid?: number; exitStatus?: number }) => void;
  /**
   * Called when the worker can't resolve an exec path locally.
   * Return the program bytes or null if not found.
   */
  onResolveExec?: (path: string) => ArrayBuffer | null | Promise<ArrayBuffer | null>;
  /**
   * Opt in to mount-based VFS for this kernel boot.
   *
   *   - `"default"` — load `<repoRoot>/host/wasm/rootfs.vfs`, falling back
   *     to the resolver-managed `programs/rootfs.vfs` artifact, and apply
   *     `DEFAULT_MOUNT_SPEC` via `resolveForNode`. The worker constructs
   *     a `VirtualPlatformIO` (rootfs at `/`, host-fs scratch dirs at
   *     `/tmp` etc.).
   *   - `ArrayBuffer | Uint8Array` — use the supplied image bytes
   *     instead of reading from disk. Same mount spec applied.
   *   - `undefined` (default) — use raw `NodePlatformIO` (every host
   *     path reachable). Preserves the pre-cutover behaviour for the
   *     direct-host-fs callers (demos, scripts) that haven't migrated
   *     to a VFS-only world yet.
   */
  rootfsImage?: "default" | ArrayBuffer | Uint8Array;
  /**
   * Resolve relative lazy URLs embedded in rootfsImage before transport.
   * This is the Node peer of BrowserKernel's lazyUrlBase contract.
   */
  rootfsLazyUrlBase?: string;
  /**
   * Exhaustive exact URL-to-byte transport for lazy entries in rootfsImage.
   * Intended for offline and pre-publication acceptance: when set, unbound
   * URLs fail instead of falling through to ambient network fetch.
   */
  rootfsLazyAssets?: readonly ClosedLazyAsset[];
  extraMounts?: Array<{
    mountPoint: string;
    hostPath: string;
    readonly?: boolean;
    /** Virtual owner for existing host-backed mount entries. Defaults to root. */
    uid?: number;
    /** Virtual group for existing host-backed mount entries. Defaults to root. */
    gid?: number;
  }>;
}

export interface SpawnOptions {
  env?: string[];
  cwd?: string;
  /** Initial real/effective user ID for the process. */
  uid?: number;
  /** Initial real/effective group ID for the process. */
  gid?: number;
  /** Finite stdin buffer. If omitted for a non-PTY spawn without onStarted,
   * stdin defaults to an immediate EOF. */
  stdin?: Uint8Array;
  /** Optional pre-compiled module for the supplied program bytes. */
  programModule?: WebAssembly.Module;
  pty?: boolean;
  /** Initial PTY winsize. Applied before the wasm program starts so the
   *  first TIOCGWINSZ returns the correct cols/rows. */
  ptyCols?: number;
  ptyRows?: number;
  /** Limit heap growth to protect thread channel pages */
  maxAddr?: number;
  /** Called after the process has been created and started. When this is set
   * and no stdin buffer is supplied, stdin remains open for appendStdinData(). */
  onStarted?: (pid: number) => void | Promise<void>;
}

export class NodeKernelHost {
  private worker!: NodeThreadWorker;
  private workerStarted = false;
  private initialized = false;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private exitResolvers = new Map<number, (status: number) => void>();
  private unclaimedExitStatuses = new Map<number, { status: number; sequence: number }>();
  private exitSequence = 0;
  private _nextRequestId = 1;
  private options: NodeKernelHostOptions;
  private lazyDownloadListeners = new Set<(event: LazyDownloadEvent) => void>();

  constructor(options?: NodeKernelHostOptions) {
    this.options = options ?? {};
  }

  /** Initialize the kernel by spawning a dedicated worker_thread */
  async init(kernelWasmBytes?: ArrayBuffer): Promise<void> {
    const wasmBytes = kernelWasmBytes ?? loadKernelWasm();
    const rootfsImage = resolveRootfsImage(this.options.rootfsImage);
    if (this.options.rootfsLazyAssets !== undefined && rootfsImage === null) {
      throw new Error("rootfsLazyAssets requires rootfsImage");
    }
    if (this.options.rootfsLazyUrlBase !== undefined && rootfsImage === null) {
      throw new Error("rootfsLazyUrlBase requires rootfsImage");
    }
    if (this.options.rootfsLazyUrlBase === "") {
      throw new Error("rootfsLazyUrlBase must not be empty");
    }
    const rootfsLazyAssets = this.options.rootfsLazyAssets === undefined
      ? undefined
      : snapshotClosedLazyAssets(this.options.rootfsLazyAssets);

    this.worker = spawnKernelWorkerThread();
    this.workerStarted = true;

    this.worker.on("message", (msg: KernelToMainMessage) => {
      this.handleWorkerMessage(msg);
    });
    this.worker.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const [, { reject }] of this.pendingRequests) {
        reject(error);
      }
      this.pendingRequests.clear();
      const diagnostic: HostDiagnostic = {
        pid: 0,
        source: "kernel worker",
        message: `[NodeKernelHost] kernel worker error: ${error.message}`,
      };
      // A worker-level error cannot send a typed message itself. Preserve the
      // same callback contract and a visible default without treating the
      // failure as guest stderr.
      console.error(diagnostic.message);
      try {
        this.options.onHostDiagnostic?.(diagnostic);
      } catch (callbackError) {
        console.error("[NodeKernelHost] onHostDiagnostic callback failed:", callbackError);
      }
    });

    // Send init and wait for ready
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.worker.removeListener("message", readyHandler);
        this.worker.removeListener("error", errorHandler);
        this.worker.removeListener("exit", exitHandler);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const readyHandler = (msg: KernelToMainMessage) => {
        if (msg.type === "ready") {
          settle(resolve);
        }
      };
      const errorHandler = (err: Error) => {
        settle(() => reject(err));
      };
      const exitHandler = (code: number) => {
        settle(() => reject(new Error(`kernel worker exited before ready (code ${code})`)));
      };
      this.worker.on("message", readyHandler);
      this.worker.once("error", errorHandler);
      this.worker.once("exit", exitHandler);

      const initMsg: MainToKernelMessage = {
        type: "init",
        kernelWasmBytes: wasmBytes,
        config: {
          maxWorkers: this.options.maxWorkers ?? 4,
          maxPages: this.options.maxPages,
          defaultThreadSlots: this.options.defaultThreadSlots,
          dataBufferSize: this.options.dataBufferSize ?? 65536,
          useSharedMemory: true,
        },
        execPrograms: this.options.execPrograms,
        rootfsImage: rootfsImage ?? undefined,
        rootfsLazyUrlBase: this.options.rootfsLazyUrlBase,
        rootfsLazyAssets,
        extraMounts: this.options.extraMounts,
        enableTcpNetwork: this.options.enableTcpNetwork,
      };
      const transfer = (rootfsLazyAssets ?? []).map(
        (asset) => asset.bytes.buffer as ArrayBuffer,
      );
      this.worker.postMessage(initMsg, transfer);
    });
    this.initialized = true;
  }

  /**
   * Spawn a new process. Returns a promise that resolves with the exit code.
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: SpawnOptions,
  ): Promise<number> {
    const requestId = this._nextRequestId++;
    const spawnStartedBeforeExitSequence = this.exitSequence;
    const stdin =
      options?.stdin ??
      (!options?.pty && !options?.onStarted ? new Uint8Array() : undefined);

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      programBytes,
      // Avoid forwarding externally compiled WebAssembly.Module objects through
      // the main thread -> kernel worker -> process worker chain. Reusing that
      // two-hop clone with SpiderMonkey's shared-memory worker runtime can leave
      // later process workers stuck before exit. The option remains an API hint;
      // Node's dedicated kernel worker compiles/caches fork and pthread modules
      // internally where it can pass them across a single worker boundary.
      argv,
      env: mergeEnv(options?.env ?? []),
      cwd: options?.cwd,
      uid: options?.uid,
      gid: options?.gid,
      pty: options?.pty,
      ptyCols: options?.ptyCols,
      ptyRows: options?.ptyRows,
      stdin,
      maxAddr: options?.maxAddr,
    }) as number;

    const unclaimedExitStatus = this.unclaimedExitStatuses.get(pid);
    if (
      unclaimedExitStatus !== undefined &&
      unclaimedExitStatus.sequence > spawnStartedBeforeExitSequence
    ) {
      this.unclaimedExitStatuses.delete(pid);
    } else if (unclaimedExitStatus !== undefined) {
      // Defensively discard a stale unclaimed exit for this numeric identity.
      // The current kernel never reuses task IDs, so a nonmatching sequence is
      // host bookkeeping from an obsolete generation, not this spawn's exit.
      this.unclaimedExitStatuses.delete(pid);
    }
    const exitPromise = unclaimedExitStatus !== undefined &&
      unclaimedExitStatus.sequence > spawnStartedBeforeExitSequence
      ? Promise.resolve(unclaimedExitStatus.status)
      : new Promise<number>((resolve) => {
          this.exitResolvers.set(pid, resolve);
        });

    this.options.onProcessEvent?.({ kind: "spawn", pid });

    // Process is now running
    if (options?.onStarted) {
      await options.onStarted(pid);
    }

    return exitPromise;
  }

  /** Append data to a process's stdin buffer (process sees more data, no EOF) */
  appendStdinData(pid: number, data: Uint8Array): void {
    this.sendToWorker({ type: "append_stdin_data", pid, data });
  }

  /** Set a process's stdin data (complete buffer with implicit EOF) */
  setStdinData(pid: number, data: Uint8Array): void {
    this.sendToWorker({ type: "set_stdin_data", pid, data });
  }

  /** Write data to the PTY master for a process */
  ptyWrite(pid: number, data: Uint8Array): void {
    this.sendToWorker({ type: "pty_write", pid, data });
  }

  /** Resize the PTY for a process */
  ptyResize(pid: number, rows: number, cols: number): void {
    this.sendToWorker({ type: "pty_resize", pid, rows, cols });
  }

  /**
   * Hand an `OffscreenCanvas` to the kernel worker as the scanout
   * target for KMS CRTC `crtcId`. Mirrors `BrowserKernel.kmsAttachCanvas`.
   *
   * Under Node, `OffscreenCanvas` is only available when the host wires
   * a polyfill (none ships with kandelo). Without one, the worker's
   * `attachKmsCanvas` is a no-op and only `kmsAttachStats` is useful.
   */
  kmsAttachCanvas(
    crtcId: number,
    canvas: OffscreenCanvas,
    stats?: SharedArrayBuffer,
    opts?: { mode?: "auto" | "2d" | "webgl2" },
  ): void {
    this.sendToWorker({ type: "kms_attach_canvas", crtcId, canvas, stats, opts });
  }

  /**
   * Register a stats SAB for KMS CRTC `crtcId` without binding a
   * scanout canvas. The worker still writes `commit_count` and
   * `last_frame_us` into slots 5/6 each vblank tick.
   */
  kmsAttachStats(crtcId: number, stats: SharedArrayBuffer): void {
    this.sendToWorker({ type: "kms_attach_stats", crtcId, stats });
  }

  /**
   * Send an HTTP request to a server running inside the kernel and return
   * the parsed response. Bypasses real TCP by using the kernel's injected
   * connection path directly. Prototype API.
   *
   * The in-kernel server must already be listening on `port`. Each call
   * opens a fresh injected connection.
   */
  async fetchInKernel(
    port: number,
    request: HttpRequest,
    options?: { timeoutMs?: number },
  ): Promise<HttpResponse> {
    const requestId = this._nextRequestId++;
    return this.request(requestId, {
      type: "http_request",
      requestId,
      port,
      request,
      timeoutMs: options?.timeoutMs,
    }) as Promise<HttpResponse>;
  }

  /**
   * Read the kernel's per-process fork counter. Used by the spawn
   * regression tests to assert a SYS_SPAWN call didn't fall back to
   * fork — `getForkCount(parent)` should return the same value before
   * and after a `posix_spawn`.
   *
   * Returns `u64::MAX` (as `bigint`) if the pid does not exist; callers
   * should compare against an explicit before-value.
   */
  async getForkCount(pid: number): Promise<bigint> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "get_fork_count",
      requestId,
      pid,
    });
    return typeof result === "bigint" ? result : BigInt(result as number);
  }

  /**
   * Return the kernel Wasm instance's current size in 64 KiB pages.
   * This is kernel allocator telemetry, not guest process memory.
   */
  async getKernelMemoryPages(): Promise<number> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "get_kernel_memory_pages",
      requestId,
    });
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error(`kernel worker returned an invalid memory-page count: ${String(result)}`);
    }
    return result;
  }

  /**
   * Snapshot the kernel's process table — one row per live process. Used
   * by Kandelo's Inspector → Procs tab. Mirrors `BrowserKernel.enumProcs`.
   */
  async enumProcs(): Promise<ProcessSnapshot[]> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "enum_procs",
      requestId,
    });
    return (result as ProcessSnapshot[]) ?? [];
  }

  /**
   * Read `/proc/[pid]/maps` for a foreign process. Returns the raw text
   * (one line per mapping), `""` if the process has no mappings, or
   * `null` if the pid is gone.
   */
  async readProcMaps(pid: number): Promise<string | null> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "read_proc_maps",
      requestId,
      pid,
    });
    return (result as string | null) ?? null;
  }

  /**
   * Subscribe to the kernel-worker's syscall trace. Returns an
   * unsubscribe function. Mirrors `BrowserKernel.subscribeSyscalls`.
   */
  subscribeSyscalls(cb: (event: SyscallTraceEvent) => void): () => void {
    this.syscallListeners.add(cb);
    if (this.syscallListeners.size === 1) {
      this.sendToWorker({ type: "set_syscall_trace", enabled: true });
      this.startSyscallPoll();
    }
    return () => {
      this.syscallListeners.delete(cb);
      if (this.syscallListeners.size === 0) {
        this.sendToWorker({ type: "set_syscall_trace", enabled: false });
        this.stopSyscallPoll();
      }
    };
  }

  private syscallListeners = new Set<(event: SyscallTraceEvent) => void>();
  private syscallPollTimer: ReturnType<typeof setInterval> | null = null;

  private startSyscallPoll(): void {
    if (this.syscallPollTimer !== null) return;
    this.syscallPollTimer = setInterval(() => {
      void this.drainAndFanSyscalls();
    }, 250);
  }

  private stopSyscallPoll(): void {
    if (this.syscallPollTimer === null) return;
    clearInterval(this.syscallPollTimer);
    this.syscallPollTimer = null;
  }

  private async drainAndFanSyscalls(): Promise<void> {
    if (this.syscallListeners.size === 0) return;
    const requestId = this._nextRequestId++;
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

  /** Terminate a specific process */
  async terminateProcess(pid: number, status = -1): Promise<void> {
    const requestId = this._nextRequestId++;
    await this.request(requestId, {
      type: "terminate_process",
      requestId,
      pid,
      status,
    });
    const resolver = this.exitResolvers.get(pid);
    this.exitResolvers.delete(pid);
    if (resolver) resolver(status);
  }

  /** Subscribe to worker-owned lazy VFS transport progress. */
  subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void): () => void {
    this.lazyDownloadListeners.add(cb);
    return () => {
      this.lazyDownloadListeners.delete(cb);
    };
  }

  /**
   * Serialize the quiescent worker-owned root filesystem for a later boot.
   * The root image is durable; boot-scoped scratch and device mounts are not.
   * Callers must wait for every guest process to exit before invoking this.
   */
  async exportRootfsImage(): Promise<Uint8Array> {
    if (!this.initialized) {
      throw new Error("rootfs export requires an initialized kernel");
    }
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "export_rootfs_image",
      requestId,
    });
    if (!(result instanceof Uint8Array)) {
      throw new Error("kernel worker returned an invalid rootfs image");
    }
    return result;
  }

  /** Destroy the kernel and release all resources */
  async destroy(): Promise<void> {
    if (!this.workerStarted) return;
    if (this.initialized) {
      const requestId = this._nextRequestId++;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.request(requestId, { type: "destroy", requestId }),
          new Promise((resolve) => {
            timeoutId = setTimeout(resolve, DESTROY_REQUEST_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Worker may have already exited
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
    await this.worker.terminate().catch(() => {});
    this.workerStarted = false;
    this.initialized = false;
    this.exitResolvers.clear();
    this.pendingRequests.clear();
    this.lazyDownloadListeners.clear();
  }

  // ── Private ──

  private sendToWorker(msg: MainToKernelMessage): void {
    this.worker.postMessage(msg);
  }

  private request(requestId: number, msg: MainToKernelMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.sendToWorker(msg);
    });
  }

  private handleWorkerMessage(msg: KernelToMainMessage): void {
    switch (msg.type) {
      case "ready":
        // The temporary init listener resolves readiness. The permanent
        // listener also receives the message, so account for it explicitly.
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
        // Kernel-internal fork / exec / posix_spawn. The host doesn't
        // see these via NodeKernelHost.spawn (forks happen inside the
        // wasm kernel without going through the request/response loop).
        const event = msg.kind === "spawn"
          ? { kind: msg.kind, pid: msg.pid, ppid: msg.ppid }
          : { kind: msg.kind, pid: msg.pid };
        this.options.onProcessEvent?.(event);
        break;
      }
      case "stdout":
        this.options.onStdout?.(msg.pid, msg.data);
        break;
      case "stderr":
        this.options.onStderr?.(msg.pid, msg.data);
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
      case "pty_output":
        this.options.onPtyOutput?.(msg.pid, msg.data);
        break;
      case "resolve_exec":
        this.handleResolveExec(msg);
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
          `[NodeKernelHost] unknown kernel-worker message type: ${String((msg as { type?: unknown }).type)}`,
        );
        break;
      }
    }
  }

  private emitLazyDownload(event: LazyDownloadEvent): void {
    try {
      this.options.onLazyDownload?.(event);
    } catch {
      // Host callbacks must not break worker message delivery.
    }
    for (const listener of this.lazyDownloadListeners) {
      try {
        listener(event);
      } catch {
        // One observer must not starve the remaining listeners.
      }
    }
  }

  private async handleResolveExec(msg: ResolveExecRequestMessage): Promise<void> {
    let programBytes: ArrayBuffer | null = null;
    if (this.options.onResolveExec) {
      programBytes = await this.options.onResolveExec(msg.path);
    }
    this.sendToWorker({
      type: "resolve_exec_response",
      requestId: msg.requestId,
      programBytes,
    });
  }
}

// ── Module-level helpers ──

function mergeEnv(env: string[]): string[] {
  const result = [...env];
  for (const entry of DEFAULT_SSL_ENV) {
    const key = entry.split("=", 1)[0];
    if (!result.some((existing) => existing.startsWith(`${key}=`))) {
      result.push(entry);
    }
  }
  return result;
}

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(resolveBinary("kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Materialise the rootfs image bytes the worker will mount at `/`.
 * Returns `null` when the caller hasn't opted in; the worker then
 * falls back to raw `NodePlatformIO` (legacy host-fs passthrough).
 */
function resolveRootfsImage(
  override: "default" | ArrayBuffer | Uint8Array | undefined,
): ArrayBuffer | null {
  if (override === undefined) return null;
  if (override === "default") {
    const artifact = resolveRootfsArtifact();
    const buf = readFileSync(artifact.selectedPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  if (override instanceof Uint8Array) {
    // Copy into a fresh ArrayBuffer — the source might live in a
    // SharedArrayBuffer, which the worker init protocol doesn't accept.
    const out = new ArrayBuffer(override.byteLength);
    new Uint8Array(out).set(override);
    return out;
  }
  return override;
}

export interface ResolvedRootfsArtifact {
  resolverRequest: "rootfs.vfs" | "programs/rootfs.vfs";
  selectedPath: string;
}

export function resolveRootfsArtifact(
  resolver: (request: string) => string = resolveBinary,
): ResolvedRootfsArtifact {
  try {
    return {
      resolverRequest: "rootfs.vfs",
      selectedPath: resolver("rootfs.vfs"),
    };
  } catch (rootfsError) {
    try {
      return {
        resolverRequest: "programs/rootfs.vfs",
        selectedPath: resolver("programs/rootfs.vfs"),
      };
    } catch (programsError) {
      const rootfsMessage = rootfsError instanceof Error ? rootfsError.message : String(rootfsError);
      const programsMessage = programsError instanceof Error ? programsError.message : String(programsError);
      throw new Error(
        `rootfsImage:"default" requested but no rootfs image was available.\n` +
          `Tried rootfs.vfs:\n${rootfsMessage}\n` +
          `Tried programs/rootfs.vfs:\n${programsMessage}\n` +
          `Run scripts/build-rootfs.sh, fetch/build the rootfs package, or pass explicit bytes.`,
      );
    }
  }
}

/** Spawn a worker_thread running node-kernel-worker-entry.ts */
function spawnKernelWorkerThread(): NodeThreadWorker {
  const entryTs = join(MODULE_DIR, "node-kernel-worker-entry.ts");
  const entryJs = join(MODULE_DIR, "node-kernel-worker-entry.js");
  const distJs = entryTs.replace(/\/src\/([^/]+)\.ts$/, "/dist/$1.js");

  // Check for compiled .js version first (much faster startup)
  if (compiledEntryIsCurrent(entryTs, distJs)) {
    return new NodeThreadWorker(distJs);
  }
  if (compiledEntryIsCurrent(entryTs, entryJs)) {
    return new NodeThreadWorker(entryJs);
  }

  // Fallback: tsx eval bootstrap
  const require = createRequire(pathToFileURL(join(MODULE_DIR, "node-kernel-host.js")).href);
  const tsxApiPath = require.resolve("tsx/esm/api");
  const tsxApiUrl = pathToFileURL(tsxApiPath).href;
  const entryUrl = pathToFileURL(entryTs).href;
  const bootstrap = [
    `import { register } from '${tsxApiUrl}';`,
    `register();`,
    `await import('${entryUrl}');`,
  ].join("\n");
  return new NodeThreadWorker(bootstrap, { eval: true });
}

function compiledEntryIsCurrent(sourcePath: string, compiledPath: string): boolean {
  if (!existsSync(compiledPath)) return false;
  if (!existsSync(sourcePath)) return true;
  return statSync(compiledPath).mtimeMs >= statSync(sourcePath).mtimeMs;
}
