/**
 * The GPU worker: a disposable worker the kernel worker's `KgpuHost` starts
 * to run kgpu submissions through the Rust executor on one renderer.
 *
 * Ownership: the kernel owns contexts, sequence numbers, pins and waits; the
 * executor module (crates/gpu-executor) owns every decision about a record;
 * this shell owns only transport. It pops forwarded submission bytes from
 * the submission ring, reassembles whole records, copies each submit's
 * stream bytes out of the memory group's backing into executor memory --
 * once, before the executor reads them -- calls `ge_handle`, and pushes the
 * one completion record each call returns. It holds no guest memory except
 * the group backing, and touches that only at extents a record names.
 *
 * WHY its own worker: the executor drives a renderer that needs an event
 * loop of its own, and a renderer fault or hang must be containable by
 * terminating one disposable worker. The kernel worker then resets the
 * kernel device (Ruling R15). The worker never blocks: no `Atomics.wait`;
 * it sleeps in its event loop and wakes on payload-free doorbell messages.
 *
 * Executor rules this shell keeps: every pointer it passes is inside a live
 * `ge_alloc` allocation; `ge_handle` answers exactly 24 (one completion) or
 * the shell treats the worker as faulted; and nothing calls back into the
 * executor from inside a `kgpu_backend` import. A context the executor has
 * reported lost gets no stream bytes copied for its later records, since
 * the kernel released that context's pins (Ruling R16). A lost renderer
 * (WebGL context loss) is the worker's own failure: it stops handling
 * records and reports itself failed, so the device is reset.
 *
 * Browsers run this file as a module Worker (`gpu-worker.ts?worker&url`) and
 * it starts itself on its first message; Node starts it through
 * `gpu-worker-node.ts`.
 */
import { ByteRing } from "../device-worker/ring.ts";
import {
  KGPU_COMPLETION_CONTEXT_LOST,
  KGPU_COMPLETION_SIZE,
  KGPU_EXTENT_SIZE,
  KGPU_MAX_EXTENTS,
  KGPU_MAX_STREAM,
  KGPU_OUTBOX_CAPACITY,
  KGPU_PROTOCOL_VERSION,
  KGPU_RECORD_FIELDS,
  KGPU_SUBMISSION_CONTEXT_DESTROY,
  KGPU_SUBMISSION_SUBMIT,
} from "../generated/abi.ts";
import { EFAULT, EINVAL, ENOMEM, type KgpuBackend } from "./backend.ts";
import { createNullBackend } from "./null-backend.ts";
import {
  GPU_EXECUTOR_INITIAL_PAGES,
  GPU_EXECUTOR_MAX_PAGES,
  GPU_WORKER_FAILED,
  GPU_WORKER_INIT,
  GPU_WORKER_READY,
  type GpuWorkerInit,
  type GpuWorkerReport,
} from "./protocol.ts";
import { RecordAssembler, streamExtents } from "./records.ts";
import { createOffscreenWebgl2, createWebgl2Backend, type KgpuWebgl2Context } from "./webgl2-backend.ts";

const F = KGPU_RECORD_FIELDS;
const RENDERER_LOST = "WebGL context lost";
/** The largest pixel readback the shell stages; larger answers ENOMEM. */
const MAX_READBACK_BYTES = 64 * 1024 * 1024;

interface ExecutorExports {
  memory: WebAssembly.Memory;
  ge_version(): number;
  ge_alloc(len: number): number;
  ge_free(ptr: number, len: number): void;
  ge_handle(recordPtr: number, recordLen: number, streamPtr: number, streamLen: number, outPtr: number): number;
}

function validInit(message: unknown): message is GpuWorkerInit {
  const m = message as Partial<GpuWorkerInit> | null;
  return !!m && m.type === GPU_WORKER_INIT
    && m.groupMemory instanceof WebAssembly.Memory
    && m.submissions instanceof SharedArrayBuffer && m.completions instanceof SharedArrayBuffer
    && !!m.port && typeof (m.port as MessagePort).postMessage === "function"
    && (m.renderer === "webgl2" || m.renderer === "null")
    && (m.executorBytes instanceof ArrayBuffer || typeof m.executorUrl === "string");
}

async function openRenderer(init: GpuWorkerInit, onLost: () => void): Promise<KgpuBackend> {
  if (init.renderer === "null") return createNullBackend();
  let context: KgpuWebgl2Context | null;
  if (init.webgl2Factory !== undefined) {
    const factory = await import(/* @vite-ignore */ init.webgl2Factory) as { createWebGL2Context?: () => KgpuWebgl2Context };
    if (typeof factory.createWebGL2Context !== "function") throw new Error("WebGL 2 factory exports no createWebGL2Context");
    context = factory.createWebGL2Context();
  } else {
    context = createOffscreenWebgl2();
  }
  if (!context) throw new Error("this realm cannot create a WebGL 2 context");
  return createWebgl2Backend(context, onLost);
}

/** Start the worker from its init message; `report` reaches the kernel
 * worker on the worker's own channel. Resolves once the worker is serving
 * doorbells, or has reported why it cannot. */
export async function startGpuWorker(message: unknown, report: (report: GpuWorkerReport) => void): Promise<void> {
  const fail = (error: unknown) => report({ type: GPU_WORKER_FAILED, message: String(error instanceof Error ? error.message : error).slice(0, 512) });
  if (!validInit(message)) return fail("invalid GPU worker init message");
  const init = message;
  try {
    let shell: GpuShell | null = null;
    let lostBeforeStart = false;
    const backend = await openRenderer(init, () => {
      if (shell) shell.rendererLost();
      else lostBeforeStart = true;
    });
    const bytes = init.executorBytes ?? await (await fetch(init.executorUrl!)).arrayBuffer();
    const memory = new WebAssembly.Memory({ initial: GPU_EXECUTOR_INITIAL_PAGES, maximum: GPU_EXECUTOR_MAX_PAGES });
    shell = new GpuShell(init, backend, memory, fail);
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory }, kgpu_backend: shell.imports() });
    shell.attach(instance.exports as unknown as ExecutorExports);
    if (lostBeforeStart || backend.isLost()) throw new Error(RENDERER_LOST);
    init.port.onmessage = () => shell.pump();
    report({ type: GPU_WORKER_READY });
    // Records forwarded before the worker was listening are already queued.
    shell.pump();
  } catch (error) {
    fail(error);
  }
}

class GpuShell {
  readonly #submissions: ByteRing;
  readonly #completions: ByteRing;
  readonly #assembler = new RecordAssembler();
  readonly #chunk = new Uint8Array(ByteRing.maxRecordBytes());
  /** Completions the full completion ring has not taken yet, in order. */
  readonly #pending: Uint8Array[] = [];
  /** Contexts the executor reported lost and has not yet seen destroyed. */
  readonly #lost = new Set<number>();
  #exports: ExecutorExports | null = null;
  #record = 0;
  #stream = 0;
  #out = 0;
  #scratch = new Uint8Array(0);
  #failed = false;
  #pumping = false;
  /** The renderer is gone (a lost WebGL context). */
  #rendererLost = false;

  // Plain fields, not parameter properties: Node's type stripping cannot
  // emit those.
  readonly init: GpuWorkerInit;
  readonly backend: KgpuBackend;
  readonly memory: WebAssembly.Memory;
  readonly fail: (error: unknown) => void;

  constructor(init: GpuWorkerInit, backend: KgpuBackend, memory: WebAssembly.Memory, fail: (error: unknown) => void) {
    this.init = init;
    this.backend = backend;
    this.memory = memory;
    this.fail = fail;
    this.#submissions = new ByteRing(init.submissions);
    this.#completions = new ByteRing(init.completions);
  }

  attach(exports: ExecutorExports): void {
    if (exports.ge_version() !== KGPU_PROTOCOL_VERSION) {
      throw new Error(`executor speaks kgpu protocol ${exports.ge_version()}, expected ${KGPU_PROTOCOL_VERSION}`);
    }
    // Reusable buffers for the worker's life: one outbox-sized record, one
    // maximal stream and one completion (protocol.ts sizes the memory).
    this.#record = exports.ge_alloc(KGPU_OUTBOX_CAPACITY);
    this.#stream = exports.ge_alloc(KGPU_MAX_STREAM);
    this.#out = exports.ge_alloc(KGPU_COMPLETION_SIZE);
    if (!this.#record || !this.#stream || !this.#out) throw new Error("executor could not allocate its transport buffers");
    this.#exports = exports;
  }

  /** The `kgpu_backend` imports. None calls back into the executor. */
  imports(): WebAssembly.ModuleImports {
    const b = this.backend;
    return {
      create_surface: (context: number, width: number, height: number) => b.createSurface(context >>> 0, width >>> 0, height >>> 0),
      destroy_surface: (context: number) => b.destroySurface(context >>> 0),
      viewport: (context: number, x: number, y: number, w: number, h: number) => b.viewport(context >>> 0, x, y, w, h),
      clear_color: (context: number, r: number, g: number, bl: number, a: number) => b.clearColor(context >>> 0, r, g, bl, a),
      clear: (context: number, mask: number) => b.clear(context >>> 0, mask >>> 0),
      read_pixels: (context: number, x: number, y: number, w: number, h: number, extents: number, count: number) =>
        this.#readPixels(context >>> 0, x, y, w, h, extents >>> 0, count >>> 0),
      is_lost: () => (b.isLost() ? 1 : 0),
    };
  }

  /** Read pixels into a scratch buffer, then write them across the
   * destination extents of the group backing. Every extent is checked
   * before any byte is written. */
  #readPixels(context: number, x: number, y: number, w: number, h: number, extentsPtr: number, count: number): number {
    if (w < 0 || h < 0 || count > KGPU_MAX_EXTENTS) return -EINVAL;
    const bytes = w * h * 4;
    if (bytes > MAX_READBACK_BYTES) return -ENOMEM;
    if (extentsPtr + count * KGPU_EXTENT_SIZE > this.memory.buffer.byteLength) return -EFAULT;
    const table = new DataView(this.memory.buffer, extentsPtr, count * KGPU_EXTENT_SIZE);
    const group = new Uint8Array(this.init.groupMemory.buffer);
    const extents: { offset: number; length: number }[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const offset = Number(table.getBigUint64(i * KGPU_EXTENT_SIZE + F.extent.offset, true));
      const length = table.getUint32(i * KGPU_EXTENT_SIZE + F.extent.len, true);
      if (offset + length > group.byteLength) return -EFAULT;
      extents.push({ offset, length });
      total += length;
    }
    // The executor hands exactly the bytes the read writes.
    if (total !== bytes) return -EINVAL;
    if (this.#scratch.byteLength < bytes) this.#scratch = new Uint8Array(bytes);
    const pixels = this.#scratch.subarray(0, bytes);
    const status = this.backend.readPixels(context, x, y, w, h, pixels);
    if (status !== 0) return status;
    let at = 0;
    for (const { offset, length } of extents) {
      group.set(pixels.subarray(at, at + length), offset);
      at += length;
    }
    return 0;
  }

  /** The backend lost its renderer. Every context on it is gone, which only
   * a device reset expresses truthfully: report this worker failed, so
   * KgpuHost terminates it and resets the kernel device once it is gone
   * (R15), rather than keep claiming a renderer. Inside a pump the event
   * came from a GL call the executor made, so the report waits until the
   * executor has returned. */
  rendererLost(): void {
    this.#rendererLost = true;
    if (!this.#pumping) this.#failRendererLost();
  }

  #failRendererLost(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.fail(new Error(RENDERER_LOST));
  }

  /** Doorbell: move every record and completion that can move now. */
  pump(): void {
    if (this.#failed || this.#pumping || !this.#exports) return;
    this.#pumping = true;
    try {
      this.#run();
    } catch (error) {
      // The executor or a backend threw (a trap, or a renderer fault): its
      // state can no longer be trusted, so stop and let KgpuHost terminate
      // this worker and reset the kernel device.
      this.#failed = true;
      this.fail(error);
    } finally {
      this.#pumping = false;
    }
    if (this.#rendererLost) this.#failRendererLost();
  }

  #run(): void {
    let doorbell = false;
    for (;;) {
      // Records after a renderer loss are moot: the device is being reset.
      if (this.#rendererLost) return;
      while (this.#pending.length > 0 && this.#completions.push(this.#pending[0]!)) this.#pending.shift();
      if (this.#pending.length > 0) {
        if (this.#completions.blocked(KGPU_COMPLETION_SIZE)) break;
        continue;
      }
      if (this.#handleStaged()) continue;
      const n = this.#submissions.pop(this.#chunk);
      if (n > 0) {
        this.#assembler.append(this.#chunk.subarray(0, n));
        continue;
      }
      if (this.#submissions.idle()) break;
    }
    if (this.#completions.wakeConsumer()) doorbell = true;
    if (this.#submissions.wakeProducer()) doorbell = true;
    if (doorbell) this.init.port.postMessage(null);
  }

  /** Handle every whole staged record while completions can be queued;
   * returns whether it handled any. */
  #handleStaged(): boolean {
    let handled = false;
    for (let record; this.#pending.length === 0 && !this.#rendererLost && (record = this.#assembler.next()) !== null;) {
      const completion = this.#handle(record);
      if (!this.#completions.push(completion)) this.#pending.push(completion);
      handled = true;
    }
    return handled;
  }

  #handle(record: Uint8Array): Uint8Array {
    const exports = this.#exports!;
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    const kind = view.getUint32(F.submission.kind, true);
    const context = view.getUint32(F.submission.context, true);
    // Executor memory may grow inside any call, so views are made fresh.
    new Uint8Array(this.memory.buffer, this.#record, record.byteLength).set(record);
    const streamLength = kind === KGPU_SUBMISSION_SUBMIT && !this.#lost.has(context) ? this.#copyStream(record) : 0;
    const written = exports.ge_handle(this.#record, record.byteLength, this.#stream, streamLength, this.#out);
    if (written !== KGPU_COMPLETION_SIZE) throw new Error(`ge_handle answered ${written}, expected one completion`);
    const completion = new Uint8Array(this.memory.buffer, this.#out, KGPU_COMPLETION_SIZE).slice();
    if (new DataView(completion.buffer).getUint32(F.completion.kind, true) === KGPU_COMPLETION_CONTEXT_LOST) {
      this.#lost.add(context);
    }
    if (kind === KGPU_SUBMISSION_CONTEXT_DESTROY) this.#lost.delete(context);
    return completion;
  }

  /** Copy a submit's stream bytes, extent by extent, from the group backing
   * into the executor's stream buffer: the only read of those bytes. A
   * stream that is too long or reaches past the backing copies nothing, and
   * the executor refuses its length mismatch as a fault of that context. */
  #copyStream(record: Uint8Array): number {
    const extents = streamExtents(record);
    const group = new Uint8Array(this.init.groupMemory.buffer);
    let total = 0;
    for (const { offset, length } of extents) {
      if (offset + length > group.byteLength) return 0;
      total += length;
    }
    if (total > KGPU_MAX_STREAM) return 0;
    const target = new Uint8Array(this.memory.buffer, this.#stream, total);
    let at = 0;
    for (const { offset, length } of extents) {
      target.set(group.subarray(offset, offset + length), at);
      at += length;
    }
    return total;
  }
}

// A browser module Worker starts itself from its first message.
const scope = globalThis as unknown as {
  WorkerGlobalScope?: unknown;
  postMessage?: (message: unknown) => void;
  addEventListener?: (type: string, listener: (event: MessageEvent) => void, options?: { once?: boolean }) => void;
};
if (scope.WorkerGlobalScope !== undefined && typeof scope.addEventListener === "function") {
  scope.addEventListener("message", (event) => {
    void startGpuWorker(event.data, (report) => scope.postMessage!(report));
  }, { once: true });
}
