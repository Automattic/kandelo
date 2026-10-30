export type StorageClose = () => undefined;
export type StorageCloseRegistrar = (close: StorageClose) => StorageClose;

export class StorageCloseLedger {
  private readonly pending = new Set<StorageClose>();
  private retiring = false;
  private unprovenCleanup: { failure: unknown } | null = null;
  private activeOperations = 0;
  private operationDrain: Promise<void> | undefined;
  private resolveOperationDrain: (() => void) | undefined;

  async run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.retiring) throw new Error("storage close ledger is retiring");
    this.activeOperations++;
    try {
      return await operation();
    } finally {
      this.activeOperations--;
      if (this.activeOperations === 0) {
        const resolve = this.resolveOperationDrain;
        this.resolveOperationDrain = undefined;
        resolve?.();
      }
    }
  }

  beginRetirement(): Promise<void> {
    this.retiring = true;
    this.operationDrain ??= this.activeOperations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => { this.resolveOperationDrain = resolve; });
    return this.operationDrain;
  }

  readonly retain: StorageCloseRegistrar = (close) => {
    let release: StorageClose | undefined = close;
    let rejected: { failure: unknown } | null = null;
    let closing = false;
    const managed: StorageClose = () => {
      if (rejected !== null) throw rejected.failure;
      if (release === undefined) return;
      if (closing) {
        const failure = new Error("storage close reentered before completion");
        this.unprovenCleanup ??= { failure };
        throw failure;
      }
      closing = true;
      try {
        release();
      } catch (failure) {
        rejected = { failure };
        throw failure;
      } finally {
        closing = false;
      }
      release = undefined;
      this.pending.delete(managed);
    };
    try {
      if (this.retiring) throw new Error("storage close ledger is retiring");
      this.pending.add(managed);
    } catch (registrationFailure) {
      try {
        managed();
      } catch (failure) {
        this.unprovenCleanup ??= { failure };
        throw new AggregateError(
          [registrationFailure, failure],
          "storage close registration and cleanup failed",
        );
      }
      throw registrationFailure;
    }
    return managed;
  };

  closeAll(): void {
    this.retiring = true;
    if (this.activeOperations !== 0) {
      throw new Error("storage operations have not drained");
    }
    const failures: unknown[] = [];
    for (const close of this.pending) {
      try {
        close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (this.unprovenCleanup !== null) {
      failures.push(this.unprovenCleanup.failure);
    }
    if (failures.length !== 0) {
      throw new AggregateError(failures, "storage close obligations remain unproven");
    }
  }
}
