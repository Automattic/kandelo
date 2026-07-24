/**
 * Worker-owned serialization for rootfs snapshots.
 *
 * Worker message handlers may overlap whenever an async handler yields. A
 * rootfs snapshot must therefore close the gate synchronously, wait for
 * already-started mutations, and keep later mutations out until saveImage()
 * has either completed or failed.
 */
export class RootfsSnapshotGate {
  private snapshotActive = false;
  private activeMutations = 0;
  private mutationDrainWaiters: Array<() => void> = [];

  /**
   * Enter a rootfs-affecting operation. The returned release callback must be
   * called exactly once, normally from a finally block.
   */
  beginMutation(operation: string): () => void {
    if (this.snapshotActive) {
      throw new Error(`rootfs export is in progress; cannot ${operation}`);
    }
    this.activeMutations += 1;
    let released = false;
    return () => {
      if (released) {
        throw new Error(`rootfs snapshot mutation released twice: ${operation}`);
      }
      released = true;
      this.activeMutations -= 1;
      if (this.activeMutations === 0) {
        const waiters = this.mutationDrainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
  }

  /**
   * Run one atomic rootfs snapshot.
   *
   * The gate closes before the first await, so messages delivered after this
   * call cannot start a process or mutate/materialize rootfs state. Mutations
   * that entered first are allowed to finish and are included in the image.
   */
  async runSnapshot<T>(snapshot: () => Promise<T>): Promise<T> {
    if (this.snapshotActive) {
      throw new Error("rootfs export is already in progress");
    }
    this.snapshotActive = true;
    try {
      if (this.activeMutations !== 0) {
        await new Promise<void>((resolve) => {
          this.mutationDrainWaiters.push(resolve);
        });
      }
      return await snapshot();
    } finally {
      this.snapshotActive = false;
    }
  }
}
