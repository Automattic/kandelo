/**
 * The kernel worker's contract with its GPU worker.
 *
 * Ownership: `KgpuHost` (kernel worker) creates the rings, the doorbell
 * channel and the init message; `gpu-worker.ts` consumes them. The init
 * message is the only structured message either side sends on the worker's
 * own channel besides the worker's single `ready`/`failed` report; all
 * traffic after that is ring records plus payload-free doorbells on `port`.
 *
 * Node loads the GPU worker through native TypeScript stripping, so this
 * file and everything the worker imports use explicit `.ts` specifiers and
 * erasable syntax only.
 */

export const GPU_WORKER_INIT = "kandelo.kgpu.worker-init.v1" as const;

/**
 * Executor linear memory, in 64 KiB pages. The module declares 2 MiB initial
 * and a 256 MiB ceiling; the worker supplies its own, smaller ceiling.
 *
 * WHY 16 MiB: JavaScriptCore charges a Memory's declared maximum against
 * the page's reservation pool at construction (runtime-memory-profile.ts),
 * so the ceiling is spent whether or not it is used. Slice 1's steady state
 * is the worker's three reusable buffers -- one outbox-sized record (256
 * KiB), one maximal stream (1 MiB) and one completion -- plus the executor's
 * per-call plan of a maximal stream (at most 87,381 of the smallest,
 * 12-byte, records, decoded to 24 bytes each: about 2 MiB) and per-context
 * state for at most 256 contexts. That is under 4 MiB at worst, so 16 MiB
 * leaves 4x headroom for allocator fragmentation while keeping one GPU
 * worker's charge small.
 */
export const GPU_EXECUTOR_INITIAL_PAGES = 32;
export const GPU_EXECUTOR_MAX_PAGES = 256;

export type KgpuRenderer = "webgl2" | "null";

/** Where the worker gets the executor module's bytes. */
export type KgpuExecutorSource = { executorBytes: ArrayBuffer } | { executorUrl: string };

export interface GpuWorkerInit {
  type: typeof GPU_WORKER_INIT;
  executorBytes?: ArrayBuffer;
  executorUrl?: string;
  /** The memory group's shared backing: the only guest memory the worker
   * receives, read and written only at the extents records name. */
  groupMemory: WebAssembly.Memory;
  /** Ring of forwarded submission bytes (kernel worker -> GPU worker). */
  submissions: SharedArrayBuffer;
  /** Ring of 24-byte completion records (GPU worker -> kernel worker). */
  completions: SharedArrayBuffer;
  /** Doorbells in both directions: payload-free messages. */
  port: MessagePort;
  renderer: KgpuRenderer;
  /** Node only: a module URL whose `createWebGL2Context()` returns
   * `{ gl, canvas }`, supplied by the embedder. Browsers use an
   * OffscreenCanvas. */
  webgl2Factory?: string;
}

export type GpuWorkerReport =
  | { type: "kandelo.kgpu.worker-ready.v1" }
  | { type: "kandelo.kgpu.worker-failed.v1"; message: string };

export const GPU_WORKER_READY = "kandelo.kgpu.worker-ready.v1" as const;
export const GPU_WORKER_FAILED = "kandelo.kgpu.worker-failed.v1" as const;
