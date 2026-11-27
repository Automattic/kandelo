/**
 * The kernel worker's side of the kgpu device: it moves records between the
 * kernel and a disposable GPU worker.
 *
 * Ownership: the kernel owns the device -- contexts, sequence numbers, pins,
 * waits, and what a lost or reset device means for each guest
 * (crates/runtime-core/src/dri/kgpu). The GPU worker and its Rust executor
 * own what a record does. `KgpuHost` owns only the worker's lifecycle and the
 * transport: it drains the kernel outbox into the submission ring, feeds the
 * completion ring back to the kernel, and rings payload-free doorbells.
 *
 * WHY each step is where it is:
 * - The worker starts lazily on the first kick: most machines never render,
 *   and a GPU worker holds a renderer and a 16 MiB executor memory.
 * - A kick arrives inside a kernel entry, so it only schedules work; every
 *   kernel call here is its own later entry, retried after contention.
 * - The kernel is drained only when the previous drain has gone into the
 *   ring, so a stalled worker backs pressure up into the kernel outbox,
 *   where a guest submit answers EAGAIN and is retried (Ruling R13), rather
 *   than into unbounded host memory.
 * - When the worker exits, errors, reports a fault, or breaks the protocol,
 *   it is terminated, and only once termination has completed -- the worker
 *   is proven gone and can no longer touch a pinned frame -- does the kernel
 *   reset the device (`kernel_kgpu_reset`, Ruling R15). There is no
 *   automatic restart: a crash-looping renderer would otherwise churn. The
 *   device stays without a renderer (context creation answers ENODEV) until
 *   the embedder calls `restart()`, which starts a new worker and only then
 *   sets the renderer again.
 */
import { ByteRing } from "../device-worker/ring";
import { retryKernelEntryResult } from "../kernel-entry-retry";
import { KGPU_COMPLETION_SIZE, KGPU_OUTBOX_CAPACITY } from "../generated/abi";
import type { WorkerHandle } from "../worker-adapter";
import {
  GPU_WORKER_FAILED,
  GPU_WORKER_INIT,
  GPU_WORKER_READY,
  type GpuWorkerInit,
  type KgpuExecutorSource,
  type KgpuRenderer,
} from "./protocol";

/** The kernel exports the host drives, each its own kernel entry. Each may
 * throw `KernelReentrantEntryError` under contention and is then retried. */
export interface KgpuKernelPort {
  drain(): Uint8Array;
  complete(records: Uint8Array): number;
  reset(): void;
  setRenderer(available: boolean): void;
}

/** What an embedding host supplies (`KernelConfig.kgpu`). */
export interface KgpuHostConfig {
  /** A new, uninitialized GPU worker (`gpu-worker.ts`); the host posts its
   * init message, with the doorbell port in the transfer list. */
  createWorker: () => WorkerHandle;
  renderer: KgpuRenderer;
  /** Required to render; without it the renderer is never set. */
  executor?: KgpuExecutorSource;
  /** Node: the embedder's WebGL 2 factory module, passed to the worker. */
  webgl2Factory?: string;
}

export interface KgpuHostOptions extends KgpuHostConfig {
  /** The memory group's shared backing, or null if there is none (or more
   * than one: records name backing offsets, not groups). */
  groupMemory: () => WebAssembly.Memory | null;
  kernel: KgpuKernelPort;
  onDiagnostic?: (message: string) => void;
}

export interface KgpuHostStatus {
  state: "idle" | "running" | "resetting" | "down" | "closed";
  workersStarted: number;
  resets: number;
  /** Drained bytes forwarded into submission rings. */
  submittedBytes: number;
  /** Times a drained chunk waited for room in the submission ring. */
  ringFullStalls: number;
  /** Completion records delivered to the kernel. */
  completions: number;
}

/** Forwarded submission bytes travel in chunks this size, so several fit
 * the 64 KiB ring at once. */
const CHUNK_BYTES = 16 * 1024;

interface Session {
  handle: WorkerHandle;
  port: MessagePort;
  /** The group backing the worker was given; records it runs name offsets
   * into this one Memory. */
  memory: WebAssembly.Memory;
  submissions: ByteRing;
  completions: ByteRing;
  /** Drained bytes not yet in the ring, in order. */
  backlog: Uint8Array[];
  ready: Promise<void>;
  failing: boolean;
}

export class KgpuHost {
  readonly #options: KgpuHostOptions;
  #session: Session | null = null;
  #state: KgpuHostStatus["state"] = "idle";
  #resetting: Promise<void> | null = null;
  #pumpScheduled = false;
  #pumping = false;
  #pumpAgain = false;
  readonly #completionBuffer = new Uint8Array(KGPU_COMPLETION_SIZE);
  readonly #stats = { workersStarted: 0, resets: 0, submittedBytes: 0, ringFullStalls: 0, completions: 0 };

  constructor(options: KgpuHostOptions) {
    this.#options = options;
  }

  /** Whether this host can render at all: the kernel's renderer flag is set
   * at init only when this is true. */
  get rendererAvailable(): boolean {
    return this.#options.renderer === "webgl2" && this.#options.executor !== undefined;
  }

  status(): KgpuHostStatus {
    return { state: this.#state, ...this.#stats };
  }

  /** `host_kgpu_kick`: the outbox turned non-empty. Called inside a kernel
   * entry, so it only schedules. */
  onKick(): void {
    if (this.#state === "closed" || this.#state === "resetting" || this.#state === "down") return;
    if (!this.#session) this.#start();
    this.#schedulePump();
  }

  /** A doorbell from the GPU worker: completions or ring room. */
  onDoorbell(): void {
    this.#schedulePump();
  }

  /** Start a new GPU worker after a reset, then set the renderer again once
   * the worker is ready. */
  async restart(): Promise<void> {
    if (!this.rendererAvailable || this.#state === "closed") return;
    await this.#resetting;
    if (this.#session) return this.#session.ready;
    this.#state = "idle";
    const session = this.#start();
    if (!session) return;
    await session.ready;
    await retryKernelEntryResult(() => this.#options.kernel.setRenderer(true));
  }

  /** Kernel teardown: stop the worker. No reset follows; the kernel itself
   * is going away. */
  async terminate(): Promise<void> {
    this.#state = "closed";
    const session = this.#session;
    this.#session = null;
    if (!session) return;
    session.failing = true;
    session.port.close();
    await session.handle.terminate();
  }

  #start(): Session | null {
    const memory = this.#options.groupMemory();
    const executor = this.#options.executor;
    if (!memory || !executor || this.#options.renderer !== "webgl2") {
      // Records are queued but nothing can run them: say so, and release
      // the device as a reset would. No worker exists, so none can still
      // touch a frame.
      this.#diagnostic(!memory ? "kgpu: no single memory-group backing for the GPU worker" : "kgpu: no renderer");
      this.#state = "resetting";
      this.#resetting = this.#reset();
      return null;
    }
    const channel = new MessageChannel();
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => {});
    const handle = this.#options.createWorker();
    this.#stats.workersStarted++;
    const session: Session = {
      handle, port: channel.port1, memory,
      submissions: ByteRing.create(), completions: ByteRing.create(),
      backlog: [], ready, failing: false,
    };
    this.#session = session;
    this.#state = "running";
    handle.on("message", (message: unknown) => {
      const type = (message as { type?: unknown } | null)?.type;
      if (type === GPU_WORKER_READY) readyResolve();
      else if (type === GPU_WORKER_FAILED) {
        const error = new Error(`GPU worker failed: ${String((message as { message?: unknown }).message)}`);
        readyReject(error);
        this.#fail(session, error.message);
      } else this.#fail(session, "GPU worker sent an unknown message");
    });
    handle.on("error", (error: Error) => { readyReject(error); this.#fail(session, `GPU worker error: ${error.message}`); });
    handle.on("exit", (code: number) => {
      readyReject(new Error(`GPU worker exited with ${code}`));
      this.#fail(session, `GPU worker exited with code ${code}`);
    });
    channel.port1.onmessage = () => this.onDoorbell();
    const init: GpuWorkerInit = {
      type: GPU_WORKER_INIT,
      ...executor,
      groupMemory: memory,
      submissions: session.submissions.buffer,
      completions: session.completions.buffer,
      port: channel.port2,
      renderer: this.#options.renderer,
      ...(this.#options.webgl2Factory === undefined ? {} : { webgl2Factory: this.#options.webgl2Factory }),
    };
    try {
      handle.postMessage(init, [channel.port2]);
    } catch (error) {
      this.#fail(session, `GPU worker init could not be sent: ${String(error)}`);
    }
    return session;
  }

  /** Terminate the session's worker, and reset the kernel device only once
   * termination has completed (R15). */
  #fail(session: Session, reason: string): void {
    if (session.failing) return;
    session.failing = true;
    session.port.close();
    if (this.#session !== session) return;
    this.#diagnostic(reason);
    this.#state = "resetting";
    this.#resetting = (async () => {
      try { await session.handle.terminate(); }
      catch (error) { this.#diagnostic(`GPU worker termination failed: ${String(error)}`); }
      if (this.#session === session) this.#session = null;
      await this.#reset();
    })();
  }

  async #reset(): Promise<void> {
    try {
      await retryKernelEntryResult(() => this.#options.kernel.reset());
      this.#stats.resets++;
    } catch (error) {
      this.#diagnostic(`kgpu device reset failed: ${String(error)}`);
    }
    if (this.#state === "resetting") this.#state = "down";
    this.#resetting = null;
  }

  #schedulePump(): void {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    setTimeout(() => {
      this.#pumpScheduled = false;
      void this.#pump();
    }, 0);
  }

  async #pump(): Promise<void> {
    if (this.#pumping) { this.#pumpAgain = true; return; }
    this.#pumping = true;
    try {
      do {
        this.#pumpAgain = false;
        const session = this.#session;
        if (!session || session.failing) return;
        try {
          await this.#pumpOnce(session);
        } catch (error) {
          // Contention is retried inside each call, so anything thrown here
          // is a broken transport or a failed kernel entry.
          this.#fail(session, `kgpu transport fault: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (this.#pumpAgain);
    } finally {
      this.#pumping = false;
    }
  }

  async #pumpOnce(s: Session): Promise<void> {
    const kernel = this.#options.kernel;
    const live = () => this.#session === s && !s.failing;
    // 1. Completions, in order, as one batch.
    const batch: Uint8Array[] = [];
    for (let n; (n = s.completions.pop(this.#completionBuffer)) !== 0;) {
      if (n !== KGPU_COMPLETION_SIZE) throw new Error(`completion ring record of ${n} bytes`);
      batch.push(this.#completionBuffer.slice());
      if (batch.length * KGPU_COMPLETION_SIZE >= KGPU_OUTBOX_CAPACITY) break;
    }
    let doorbell = s.completions.wakeProducer();
    if (batch.length > 0) {
      const bytes = new Uint8Array(batch.length * KGPU_COMPLETION_SIZE);
      batch.forEach((record, i) => bytes.set(record, i * KGPU_COMPLETION_SIZE));
      const status = await retryKernelEntryResult(() => kernel.complete(bytes));
      if (!live()) return;
      this.#stats.completions += batch.length;
      // A refused batch means the adapter and kernel disagree; the kernel
      // has lost every context, and this worker can no longer be trusted.
      if (status < 0) throw new Error(`kernel refused a completion batch (errno ${-status})`);
    }
    // 2. Forward drained submissions; drain again only once the previous
    //    drain is all in the ring. Drained records name offsets into the
    //    group backing the kernel uses now. A worker bound to a backing
    //    since replaced (its group removed and another created) would read
    //    and write the wrong memory, so it is failed, and the device reset,
    //    before a record can reach it.
    if (this.#options.groupMemory() !== s.memory) {
      throw new Error("the memory-group backing the GPU worker addresses was replaced");
    }
    for (;;) {
      while (s.backlog.length > 0 && s.submissions.push(s.backlog[0]!)) {
        this.#stats.submittedBytes += s.backlog.shift()!.byteLength;
      }
      if (s.backlog.length > 0) {
        if (s.submissions.blocked(s.backlog[0]!.byteLength)) { this.#stats.ringFullStalls++; break; }
        continue;
      }
      const drained = await retryKernelEntryResult(() => kernel.drain());
      if (!live()) return;
      if (drained.byteLength === 0) break;
      for (let at = 0; at < drained.byteLength; at += CHUNK_BYTES) {
        s.backlog.push(drained.subarray(at, Math.min(at + CHUNK_BYTES, drained.byteLength)));
      }
    }
    if (s.submissions.wakeConsumer()) doorbell = true;
    // 3. Sleep only on an empty completion ring.
    if (!s.completions.idle()) this.#pumpAgain = true;
    if (doorbell) s.port.postMessage(null);
  }

  #diagnostic(message: string): void {
    this.#options.onDiagnostic?.(message);
  }
}
