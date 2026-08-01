/**
 * Worker-realm lifecycle gate for operations that can expose process memory
 * to a newly created process or pthread Worker.
 *
 * Closing the gate is synchronous. Destroy can therefore close admission
 * before its first await, wait for every already-admitted creator, and only
 * then sweep the exact process generations and Worker aliases they installed.
 */
export class ProcessMemoryCreatorGate {
  private open = true;
  private activeCreators = 0;
  private readonly drainWaiters = new Set<() => void>();
  private destroyOperation: Promise<unknown> | undefined;

  /**
   * Run one admitted creator and release its admission on every terminal path.
   */
  run<T>(operation: string, creator: () => T | PromiseLike<T>): Promise<T> {
    return this.runUntilCommitted(operation, () => creator());
  }

  /**
   * Admit a creator whose semantic completion can outlive its installation.
   *
   * `commit()` releases destroy admission once the exact generation and all
   * of its ownership handles are published in the host process registry. The
   * returned operation may remain pending afterward. This is required for
   * vfork: its onFork promise parks the caller until child exec/_exit, but a
   * terminal host destroy must be able to sweep that already-visible child
   * instead of waiting for the parked syscall first.
   *
   * If the creator fails or completes before commit, its terminal path releases
   * admission. Calling commit more than once is harmless so a common finally
   * path cannot double-release the gate.
   */
  runUntilCommitted<T>(
    operation: string,
    creator: (commit: () => void) => T | PromiseLike<T>,
  ): Promise<T> {
    if (!this.open) {
      return Promise.reject(
        new Error(
          `kernel worker is being destroyed; cannot start ${operation}`,
        ),
      );
    }
    this.activeCreators += 1;
    let released = false;
    const commit = () => {
      if (released) return;
      released = true;
      this.releaseCreator();
    };
    let result: T | PromiseLike<T>;
    try {
      result = creator(commit);
    } catch (error) {
      commit();
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(() => {
      commit();
    });
  }

  /**
   * Permanently close admission and wait for creators that entered first.
   *
   * Repeated calls are idempotent because whole-worker destroy is terminal.
   */
  closeAndWait(): Promise<void> {
    this.open = false;
    if (this.activeCreators === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  /**
   * Close admission, drain admitted creators, then run terminal teardown once.
   *
   * WHY: merely awaiting `closeAndWait()` at two call sites leaves it possible
   * for a future destroy edit to start sweeping process maps before the drain.
   * Keeping the ordering in this shared primitive makes that ownership fence
   * executable and makes repeated destroy messages observe the same teardown.
   */
  closeAndRunAfterDrain<T>(
    destroy: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.destroyOperation) {
      return this.destroyOperation as Promise<T>;
    }
    const drained = this.closeAndWait();
    const operation = drained.then(() => destroy());
    // Assign before the first promise continuation can run so a reentrant
    // destroy cannot install a second terminal operation.
    this.destroyOperation = operation;
    return operation;
  }

  private releaseCreator(): void {
    if (this.activeCreators <= 0) {
      throw new Error("process memory creator admission released twice");
    }
    this.activeCreators -= 1;
    if (this.open || this.activeCreators !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
