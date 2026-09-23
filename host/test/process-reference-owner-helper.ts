import {
  ForkExternrefProcessOwner,
  readCapturedExternrefHandover,
} from "../src/fork-externref-process-owner";
import type { ForkExternrefGeneration } from "../src/fork-reference-broker";

export interface TestProcessReferenceInit {
  readonly externrefGenerationId: number;
}

/**
 * Process-owned externref generations for tests that spawn process Workers
 * directly instead of using NodeKernelHost or BrowserKernelHost.
 */
export class TestProcessReferenceOwners {
  private readonly owner = new ForkExternrefProcessOwner();
  private readonly generations = new Map<number, ForkExternrefGeneration>();

  start(pid: number): TestProcessReferenceInit {
    return this.install(this.owner.startGeneration(pid));
  }

  /**
   * Grant a fork child the handles its parent staged, exactly as
   * `process-lifecycle.ts` does: read from the parent's control prefix at
   * `parentControlAddress` (the parent's channel offset minus
   * `FORK_SAVE_BUFFER_SIZE`).
   */
  fork(
    parentPid: number,
    childPid: number,
    parentMemory: WebAssembly.Memory,
    parentControlAddress: number,
  ): TestProcessReferenceInit {
    const parent = this.generations.get(parentPid);
    if (!parent) {
      throw new Error(
        `missing test reference owner for fork parent ${parentPid}`,
      );
    }
    const label = `direct-worker test fork child pid=${childPid}`;
    const child = this.owner.forkGenerationFromCapturedHandles(
      parent,
      childPid,
      readCapturedExternrefHandover(parentMemory, parentControlAddress, label),
      label,
    ).generation;
    return this.install(child);
  }

  release(pid: number): void {
    const generation = this.generations.get(pid);
    if (!generation) return;
    this.generations.delete(pid);
    this.owner.releaseGeneration(generation);
  }

  close(): void {
    for (const pid of [...this.generations.keys()]) this.release(pid);
  }

  private install(
    generation: ForkExternrefGeneration,
  ): TestProcessReferenceInit {
    const pid = generation.pid;
    if (this.generations.has(pid)) {
      this.owner.releaseGeneration(generation);
      throw new Error(`duplicate test reference owner for pid=${pid}`);
    }
    this.generations.set(pid, generation);
    return { externrefGenerationId: generation.id };
  }
}
