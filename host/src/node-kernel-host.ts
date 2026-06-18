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
  MainToKernelMessage,
  KernelToMainMessage,
  ResolveExecRequestMessage,
} from "./node-kernel-protocol";
import type { ProcessSnapshot, SyscallTraceEvent } from "./kernel-worker";
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type { InputSource } from "./input/input-source";
import type { AudioDriver, AudioRing } from "./audio/audio-driver";

export type { HttpRequest, HttpResponse };

function currentModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}

const MODULE_DIR = currentModuleDir();
const DESTROY_REQUEST_TIMEOUT_MS = 2_000;

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
  /** Called when a process writes PTY output */
  onPtyOutput?: (pid: number, data: Uint8Array) => void;
  /** Called when a process is spawned, execs a new program, or exits.
   *  Used by Inspector-style UIs to refresh their process table without
   *  polling. */
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
  extraMounts?: Array<{ mountPoint: string; hostPath: string; readonly?: boolean }>;
}

export interface SpawnOptions {
  env?: string[];
  cwd?: string;
  /** Initial real/effective user ID for the process. */
  uid?: number;
  /** Initial real/effective group ID for the process. */
  gid?: number;
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
  /** Called after the process has been created and started */
  onStarted?: (pid: number) => void | Promise<void>;
}

export class NodeKernelHost {
  private worker!: NodeThreadWorker;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private exitResolvers = new Map<number, (status: number) => void>();
  private unclaimedExitStatuses = new Map<number, { status: number; sequence: number }>();
  private exitSequence = 0;
  private _nextRequestId = 1;
  private options: NodeKernelHostOptions;

  constructor(options?: NodeKernelHostOptions) {
    this.options = options ?? {};
  }

  /** Initialize the kernel by spawning a dedicated worker_thread */
  async init(kernelWasmBytes?: ArrayBuffer): Promise<void> {
    const wasmBytes = kernelWasmBytes ?? loadKernelWasm();
    const rootfsImage = resolveRootfsImage(this.options.rootfsImage);

    this.worker = spawnKernelWorkerThread();

    this.worker.on("message", (msg: KernelToMainMessage) => {
      this.handleWorkerMessage(msg);
    });
    this.worker.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const [, { reject }] of this.pendingRequests) {
        reject(error);
      }
      this.pendingRequests.clear();
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
        extraMounts: this.options.extraMounts,
        enableTcpNetwork: this.options.enableTcpNetwork,
      };
      this.worker.postMessage(initMsg);
    });
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
      env: options?.env,
      cwd: options?.cwd,
      uid: options?.uid,
      gid: options?.gid,
      pty: options?.pty,
      ptyCols: options?.ptyCols,
      ptyRows: options?.ptyRows,
      stdin: options?.stdin,
      maxAddr: options?.maxAddr,
    }) as number;

    const unclaimedExitStatus = this.unclaimedExitStatuses.get(pid);
    if (
      unclaimedExitStatus !== undefined &&
      unclaimedExitStatus.sequence > spawnStartedBeforeExitSequence
    ) {
      this.unclaimedExitStatuses.delete(pid);
    } else if (unclaimedExitStatus !== undefined) {
      // PIDs can be reused. An older unclaimed exit for the same numeric PID
      // must not satisfy this new spawn, or callers observe an immediate
      // success while the new process is still running.
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
   * Push one evdev record into the kernel's `/dev/input/event{0,1}`
   * ring. Mirrors `BrowserKernel.injectInputEvent`. The Node host
   * doesn't have a DOM source; tests drive evdev traffic directly
   * via this entry point.
   */
  injectInputEvent(
    device: 0 | 1,
    ev_type: number,
    code: number,
    value: number,
  ): void {
    this.sendToWorker({
      type: "input_event_inject",
      device,
      ev_type,
      code,
      value,
    });
  }

  /**
   * Tell the kernel the current host canvas dimensions so EVIOCGABS
   * on `/dev/input/event1` reports the right `ABS_X.maximum` /
   * `ABS_Y.maximum`. Mirrors `BrowserKernel.setInputCanvasDims`.
   */
  setInputCanvasDims(width: number, height: number): void {
    this.sendToWorker({ type: "set_input_canvas_dims", width, height });
  }

  /**
   * Wire an `InputSource` into the kernel: sets canvas dims, then
   * starts the source with a dispatch callback that funnels each
   * emitted record through `injectInputEvent`. Mirrors
   * `BrowserKernel.attachInputSource` — dual-host parity per
   * CLAUDE.md §"Two hosts".
   *
   * On the Node host the source is typically a `NodeInputSource`
   * (no-op) so the init path is symmetric with the browser; tests
   * call `injectInputEvent` directly afterwards.
   */
  attachInputSource(
    source: InputSource,
    dims: { width: number; height: number },
  ): void {
    this.setInputCanvasDims(dims.width, dims.height);
    source.start((ev) =>
      this.injectInputEvent(ev.device, ev.ev_type, ev.code, ev.value),
    );
  }

  /**
   * Allocate a kernel-memory SAB ring for `pcmId` of `byteLen` bytes
   * and bind it via `kernel_audio_init_sab`. Returns the ring window
   * the host AudioDriver should view as `Int16Array(buffer, offset, …)`.
   * Mirrors the Browser-side method of the same name — dual-host
   * parity per CLAUDE.md §"Two hosts".
   */
  async audioAllocRing(pcmId: number, byteLen: number): Promise<AudioRing> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "audio_alloc_ring",
      requestId,
      pcmId,
      byteLen,
    });
    return result as AudioRing;
  }

  /**
   * Fire-and-forget period tick into the kernel. Used by the
   * AudioDriver's `kernelTick` callback to advance `mmap_status.hw_ptr`
   * and wake `POLLOUT` waiters parked on `/dev/snd/pcmC0D<pcmId>p`.
   */
  audioPeriodTick(pcmId: number, framesConsumed: number): void {
    this.sendToWorker({
      type: "audio_period_tick",
      pcmId,
      framesConsumed,
    });
  }

  /**
   * Read the current `mmap_control.appl_ptr` for any OFD bound to
   * `pcmId`. Kept on the Node host for dual-host parity even though
   * `NodeAudioDriver` does not currently poll — vitest specs and
   * future Node-side drivers can use it.
   */
  async audioGetApplPtr(pcmId: number): Promise<number> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "audio_get_appl_ptr",
      requestId,
      pcmId,
    });
    return result as number;
  }

  /**
   * Read-only probes mirroring `BrowserKernel.audioGetHwPtr` /
   * `audioGetState` for dual-host parity (CLAUDE.md §"Two hosts").
   * `NodeAudioDriver` does not currently poll them, but vitest specs
   * and future Node-side drivers can.
   */
  async audioGetHwPtr(pcmId: number): Promise<number> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "audio_get_hw_ptr",
      requestId,
      pcmId,
    });
    return result as number;
  }

  async audioGetState(pcmId: number): Promise<number> {
    const requestId = this._nextRequestId++;
    const result = await this.request(requestId, {
      type: "audio_get_state",
      requestId,
      pcmId,
    });
    return result as number;
  }

  /**
   * Wire an `AudioDriver` into the kernel: allocates a SAB ring,
   * registers it, then starts the driver with a `kernelTick` callback
   * that funnels each period boundary into `kernel_audio_period_tick`.
   * Mirrors `BrowserKernel.attachAudioDriver` — dual-host parity per
   * CLAUDE.md §"Two hosts".
   *
   * On the Node host the driver is typically a `NodeAudioDriver`
   * (setInterval-driven dummy) so the init path is symmetric with the
   * browser; tests can call `audioPeriodTick` directly afterwards.
   */
  async attachAudioDriver(
    driver: AudioDriver,
    opts: {
      pcmId?: number;
      sampleRate?: number;
      channels?: number;
      periodFrames?: number;
      ringBytes?: number;
    } = {},
  ): Promise<void> {
    const pcmId = opts.pcmId ?? 0;
    const sampleRate = opts.sampleRate ?? 48_000;
    const channels = opts.channels ?? 2;
    const periodFrames = opts.periodFrames ?? 1024;
    const ringBytes = opts.ringBytes ?? 64 * 1024;
    const ring = await this.audioAllocRing(pcmId, ringBytes);
    let cachedApplPtr = 0;
    let inFlight = false;
    const getApplPtr = (id: number): number => {
      if (!inFlight) {
        inFlight = true;
        this.audioGetApplPtr(id)
          .then((v) => {
            cachedApplPtr = v;
          })
          .catch(() => {
            /* swallow — keep last good value */
          })
          .finally(() => {
            inFlight = false;
          });
      }
      return cachedApplPtr;
    };
    await driver.start(
      pcmId,
      sampleRate,
      channels,
      periodFrames,
      ring,
      (id, frames) => this.audioPeriodTick(id, frames),
      getApplPtr,
    );
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

  /** Destroy the kernel and release all resources */
  async destroy(): Promise<void> {
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
    await this.worker.terminate();
    this.exitResolvers.clear();
    this.pendingRequests.clear();
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
        this.options.onProcessEvent?.({ kind: msg.kind, pid: msg.pid, ppid: msg.ppid });
        break;
      }
      case "stdout":
        this.options.onStdout?.(msg.pid, msg.data);
        break;
      case "stderr":
        this.options.onStderr?.(msg.pid, msg.data);
        break;
      case "pty_output":
        this.options.onPtyOutput?.(msg.pid, msg.data);
        break;
      case "resolve_exec":
        this.handleResolveExec(msg);
        break;
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
    const path = resolveRootfsArtifact();
    const buf = readFileSync(path);
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

function resolveRootfsArtifact(): string {
  try {
    return resolveBinary("rootfs.vfs");
  } catch (rootfsError) {
    try {
      return resolveBinary("programs/rootfs.vfs");
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
