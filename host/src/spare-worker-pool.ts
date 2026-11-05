/** Spares each Worker adapter keeps: a fork child and its exec replacement. */
export const SPARE_WORKERS = 2;

/**
 * Process and thread Workers started before a launch needs them.
 *
 * Starting a Worker realm and evaluating the worker entry is a fixed cost of
 * every fork, exec and posix_spawn: a fork child and its exec replacement
 * each pay it on the launch path. A spare has evaluated the
 * entry and waits in its event loop for the one init message, so taking it
 * leaves only the init post on the launch path.
 *
 * A spare owns no process state: no Memory, program, channel or pid until
 * the adapter posts its init message. Terminating an unused spare therefore
 * reclaims it on every engine, including JavaScriptCore, whose
 * terminate cannot reclaim a Worker parked in Atomics.wait.
 */
export class SpareWorkerPool<W> {
  private readonly spares: { worker: W; failed: boolean }[] = [];
  private refill: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /**
   * `start` constructs one spare and reports, through its callback, a spare
   * that failed before any launch took it. `discard` terminates a spare.
   */
  constructor(
    private readonly size: number,
    private readonly start: (failed: () => void) => W,
    private readonly discard: (worker: W) => void,
  ) {}

  /** Take a started spare, or `undefined` when none is ready. */
  take(): W | undefined {
    this.scheduleRefill();
    for (let spare = this.spares.shift(); spare; spare = this.spares.shift()) {
      if (!spare.failed) return spare.worker;
      this.discard(spare.worker);
    }
    return undefined;
  }

  /** Terminate every spare and start no more. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refill);
    for (const spare of this.spares.splice(0)) this.discard(spare.worker);
  }

  // The refill runs on a later task, after the taking launch has posted its
  // init message, so constructing the next spare never delays that launch.
  private scheduleRefill(): void {
    if (this.disposed || this.refill !== undefined) return;
    this.refill = setTimeout(() => {
      this.refill = undefined;
      while (!this.disposed && this.spares.length < this.size) {
        const spare = { worker: undefined as W, failed: false };
        // A constructor failure leaves the pool short. The next launch then
        // constructs its own Worker and reports the failure itself.
        try {
          spare.worker = this.start(() => { spare.failed = true; });
        } catch {
          return;
        }
        this.spares.push(spare);
      }
    }, 0);
  }
}
