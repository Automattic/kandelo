/**
 * A process-scoped cooperative VM-interrupt timer.
 *
 * Process workers cannot reliably run their own timer while executing a
 * CPU-bound Wasm loop. The kernel worker owns this timer instead and writes
 * the runtime's interrupt flags through the process's shared memory.
 *
 * The generation object is deliberately part of every entry. Task IDs are
 * never reassigned, but exec preserves its PID while replacing the host-side
 * execution generation. Neither a queued timer callback nor a stale worker
 * message may act on that replacement image.
 */

export const MAX_VM_INTERRUPT_TIMER_DELAY_MS = 0x7fffffff;

export interface VmInterruptProcessGeneration {
  readonly memory: WebAssembly.Memory;
}

export interface VmInterruptTimerRequest {
  timedOutPtr: number;
  vmInterruptPtr: number;
  seconds: number;
}

export interface VmInterruptTimerScheduler<Handle = ReturnType<typeof setTimeout>> {
  /** Monotonic milliseconds. */
  now(): number;
  set(callback: () => void, delayMs: number): Handle;
  clear(handle: Handle): void;
}

interface TimerEntry<Generation, Handle> {
  generation: Generation;
  deadlineMs: number;
  timedOutPtr: number;
  vmInterruptPtr: number;
  handle?: Handle;
}

function defaultScheduler(): VmInterruptTimerScheduler {
  return {
    now: () => performance.now(),
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle),
  };
}

function sharedFlags(
  generation: VmInterruptProcessGeneration,
  timedOutPtr: number,
  vmInterruptPtr: number,
): Uint8Array<SharedArrayBuffer> | null {
  // TypeScript's WebAssembly.Memory.buffer declaration is ArrayBuffer even
  // when the memory descriptor used `shared: true`; narrow from unknown so a
  // real SharedArrayBuffer remains representable without an impossible
  // ArrayBuffer & SharedArrayBuffer intersection.
  const buffer: unknown = generation.memory.buffer;
  if (
    typeof SharedArrayBuffer === "undefined" ||
    !(buffer instanceof SharedArrayBuffer)
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(timedOutPtr) ||
    timedOutPtr < 0 ||
    timedOutPtr >= buffer.byteLength ||
    !Number.isSafeInteger(vmInterruptPtr) ||
    vmInterruptPtr < 0 ||
    vmInterruptPtr >= buffer.byteLength
  ) {
    return null;
  }
  return new Uint8Array(buffer);
}

export class VmInterruptTimerManager<
  Generation extends VmInterruptProcessGeneration,
  Handle = ReturnType<typeof setTimeout>,
> {
  private readonly entries = new Map<number, TimerEntry<Generation, Handle>>();

  constructor(
    private readonly currentGeneration: (pid: number) => Generation | undefined,
    private readonly scheduler: VmInterruptTimerScheduler<Handle> =
      defaultScheduler() as VmInterruptTimerScheduler<Handle>,
  ) {}

  /**
   * Apply the runtime hook's arm/cancel request for the listener-owned PID.
   * Non-positive durations cancel the current generation's timer.
   */
  handleRequest(
    pid: number,
    generation: Generation,
    request: VmInterruptTimerRequest,
  ): boolean {
    if (request.seconds > 0) {
      return this.arm(pid, generation, request);
    }
    return this.cancel(pid, generation);
  }

  /** Replace any existing timer for the same current process generation. */
  arm(
    pid: number,
    generation: Generation,
    request: VmInterruptTimerRequest,
  ): boolean {
    if (this.currentGeneration(pid) !== generation) return false;

    // A new request replaces the previous timer even when the new request is
    // malformed. This matches timer-set semantics and prevents an old deadline
    // from surviving a rejected re-arm.
    this.clear(pid);

    if (!Number.isFinite(request.seconds) || !(request.seconds > 0)) return false;
    if (!sharedFlags(generation, request.timedOutPtr, request.vmInterruptPtr)) {
      return false;
    }

    const now = this.scheduler.now();
    const delayMs = request.seconds * 1000;
    const deadlineMs = now + delayMs;
    if (!Number.isFinite(now) || !Number.isFinite(delayMs) || !Number.isFinite(deadlineMs)) {
      return false;
    }

    const entry: TimerEntry<Generation, Handle> = {
      generation,
      deadlineMs,
      timedOutPtr: request.timedOutPtr,
      vmInterruptPtr: request.vmInterruptPtr,
    };
    this.entries.set(pid, entry);
    this.schedule(pid, entry);
    return true;
  }

  /** Cancel only when the caller still owns the current execution generation. */
  cancel(pid: number, generation: Generation): boolean {
    if (this.currentGeneration(pid) !== generation) return false;
    this.clear(pid, generation);
    return true;
  }

  /** Clear a PID timer, optionally restricted to one exact generation. */
  clear(pid: number, generation?: Generation): boolean {
    const entry = this.entries.get(pid);
    if (!entry || (generation !== undefined && entry.generation !== generation)) {
      return false;
    }
    if (entry.handle !== undefined) {
      this.scheduler.clear(entry.handle);
      entry.handle = undefined;
    }
    this.entries.delete(pid);
    return true;
  }

  clearAll(): void {
    for (const [pid] of this.entries) this.clear(pid);
  }

  get activeCount(): number {
    return this.entries.size;
  }

  private schedule(pid: number, entry: TimerEntry<Generation, Handle>): void {
    if (
      this.entries.get(pid) !== entry ||
      this.currentGeneration(pid) !== entry.generation
    ) {
      this.discardIfCurrent(pid, entry);
      return;
    }

    const remainingMs = entry.deadlineMs - this.scheduler.now();
    if (remainingMs <= 0) {
      this.fire(pid, entry);
      return;
    }

    // Browser and Node timers clamp/overflow beyond a signed 32-bit delay.
    // Schedule in chunks and recompute against the monotonic deadline after
    // every wake. Ceil prevents a fractional delay from firing early.
    const delayMs = Math.min(
      MAX_VM_INTERRUPT_TIMER_DELAY_MS,
      Math.max(1, Math.ceil(remainingMs)),
    );
    const handle = this.scheduler.set(() => {
      if (this.entries.get(pid) !== entry || entry.handle !== handle) return;
      entry.handle = undefined;
      this.schedule(pid, entry);
    }, delayMs);
    entry.handle = handle;
  }

  private fire(pid: number, entry: TimerEntry<Generation, Handle>): void {
    if (
      this.entries.get(pid) !== entry ||
      this.currentGeneration(pid) !== entry.generation
    ) {
      this.discardIfCurrent(pid, entry);
      return;
    }

    const flags = sharedFlags(
      entry.generation,
      entry.timedOutPtr,
      entry.vmInterruptPtr,
    );
    this.entries.delete(pid);
    entry.handle = undefined;
    if (!flags) return;

    Atomics.store(flags, entry.timedOutPtr, 1);
    Atomics.store(flags, entry.vmInterruptPtr, 1);
  }

  private discardIfCurrent(pid: number, entry: TimerEntry<Generation, Handle>): void {
    if (this.entries.get(pid) !== entry) return;
    if (entry.handle !== undefined) {
      this.scheduler.clear(entry.handle);
      entry.handle = undefined;
    }
    this.entries.delete(pid);
  }
}
