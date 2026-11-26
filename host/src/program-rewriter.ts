import { computeForkModuleTemplateId } from "./fork-module-state";
import type { ProgramRewriteRequest, ProgramRewriteResponse } from "./memory-instrument-worker";
import type { WorkerHandle } from "./worker-adapter";

/** Custom section of a program that the host rewrites when a process starts it. */
export const MEMORY_REWRITE_AT_EXEC_SECTION = "kandelo.memory.rewrite_at_exec";

export interface ProgramImage {
  bytes: ArrayBuffer;
  module: WebAssembly.Module;
}

export type ProgramRewriteWorkerFactory = (request: ProgramRewriteRequest) => WorkerHandle;

/**
 * Makes the rewritten form of each marked program once per kernel.
 *
 * WHY: the rewrite of a large program takes more than a second, and it is
 * one synchronous call. It runs in a Worker of its own, so the kernel worker
 * keeps serving syscalls. The result depends only on the program bytes, so
 * every later start of the same bytes reuses it.
 */
export class ProgramRewriter {
  readonly #rewritten = new Map<string, Promise<ProgramImage>>();

  constructor(
    private readonly instrumenter: WebAssembly.Module,
    private readonly createWorker: ProgramRewriteWorkerFactory,
    private readonly compile: (bytes: ArrayBuffer) => Promise<WebAssembly.Module>,
  ) {}

  /** The rewritten form of `plain`, or null when `plain` carries no mark. */
  async rewritten(plain: ProgramImage): Promise<ProgramImage | null> {
    if (WebAssembly.Module.customSections(plain.module, MEMORY_REWRITE_AT_EXEC_SECTION).length === 0) return null;
    const id = (await computeForkModuleTemplateId(plain.bytes)).join();
    let rewritten = this.#rewritten.get(id);
    if (rewritten) return rewritten;
    rewritten = this.#rewrite(plain.bytes);
    this.#rewritten.set(id, rewritten);
    rewritten.catch(() => this.#rewritten.delete(id));
    return rewritten;
  }

  async #rewrite(program: ArrayBuffer): Promise<ProgramImage> {
    const worker = this.createWorker({ instrumenter: this.instrumenter, program });
    try {
      const response = await new Promise<ProgramRewriteResponse>((resolve, reject) => {
        worker.on("message", (message) => resolve(message as ProgramRewriteResponse));
        worker.on("error", reject);
        worker.on("exit", (code) => reject(new Error(`program rewrite worker exited: ${code}`)));
      });
      if (response.kind === "failure") throw new Error(response.detail);
      return { bytes: response.program, module: await this.compile(response.program) };
    } finally {
      await worker.terminate();
    }
  }
}
