import type { WorkerHandle } from "./worker-adapter";
import type { WorkerToHostMessage } from "./worker-protocol";

const FORK_REPLAY_PENDING = 0;
const FORK_REPLAY_COMMITTED = 1;
const FORK_REPLAY_CANCELLED = -1;
const FORK_REPLAY_GATE_BYTES = Int32Array.BYTES_PER_ELEMENT;

function gateView(buffer: SharedArrayBuffer): Int32Array {
  if (
    !(buffer instanceof SharedArrayBuffer)
    || buffer.byteLength !== FORK_REPLAY_GATE_BYTES
  ) {
    throw new TypeError("fork replay gate must be one shared i32");
  }
  return new Int32Array(buffer);
}

export function createForkReplayGate(): SharedArrayBuffer {
  return new SharedArrayBuffer(FORK_REPLAY_GATE_BYTES);
}

/**
 * Release a child that proved reconstruction reached the inherited fork site.
 */
export function commitForkReplayGate(buffer: SharedArrayBuffer): void {
  const gate = gateView(buffer);
  if (
    Atomics.compareExchange(
      gate,
      0,
      FORK_REPLAY_PENDING,
      FORK_REPLAY_COMMITTED,
    ) !== FORK_REPLAY_PENDING
  ) {
    throw new Error("fork replay gate is no longer pending");
  }
  Atomics.notify(gate, 0);
}

/**
 * Wake a reconstruction Worker that the kernel host is rolling back.
 */
export function cancelForkReplayGate(buffer: SharedArrayBuffer): void {
  const gate = gateView(buffer);
  if (
    Atomics.compareExchange(
      gate,
      0,
      FORK_REPLAY_PENDING,
      FORK_REPLAY_CANCELLED,
    ) === FORK_REPLAY_PENDING
  ) {
    Atomics.notify(gate, 0);
  }
}

/**
 * Stop the child immediately before the inherited fork() returns zero.
 *
 * WHY this is a blocking shared-memory gate: a JavaScript promise cannot be
 * awaited inside a synchronous Wasm import. Process Workers already execute
 * off the main thread and use Atomics.wait for syscall channels, so the same
 * primitive gives Node and browsers one exact two-phase commit boundary.
 */
export function waitForForkReplayCommit(
  buffer: SharedArrayBuffer,
  context: string,
): void {
  const gate = gateView(buffer);
  for (;;) {
    const state = Atomics.load(gate, 0);
    if (state === FORK_REPLAY_COMMITTED) return;
    if (state === FORK_REPLAY_CANCELLED) {
      throw new Error(`${context}: fork replay was cancelled before commit`);
    }
    if (state !== FORK_REPLAY_PENDING) {
      throw new Error(`${context}: invalid fork replay gate state ${state}`);
    }
    Atomics.wait(gate, 0, FORK_REPLAY_PENDING);
  }
}

type ForkReplayCoordinatorPhase =
  | "pending"
  | "ready"
  | "committed"
  | "cancelled";

function cancellationError(context: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(
    `${context}: ${reason === undefined ? "fork replay was cancelled" : String(reason)}`,
  );
}

/**
 * Host-side half of the fork replay two-phase commit.
 *
 * `ready()` records the child Worker proving it reconstructed the inherited
 * fork site, but deliberately leaves the shared gate closed. `commit()` is a
 * separate operation performed only after the entrypoint has revalidated the
 * exact child generation. Any launch, protocol, error, or exit path can call
 * `cancel()` idempotently; a child already blocked in its synchronous Wasm
 * import is woken with cancellation rather than leaked forever.
 */
export class ForkReplayGateCoordinator {
  readonly gate = createForkReplayGate();
  private phase: ForkReplayCoordinatorPhase = "pending";
  private cancelledWith: Error | null = null;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (reason: Error) => void;

  constructor(readonly context: string) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A Worker constructor can fail before handleFork reaches its await. Keep
    // that synchronous rollback from producing an unhandled rejection while
    // preserving the rejected promise for any later waiter.
    void this.readyPromise.catch(() => {});
  }

  get currentPhase(): ForkReplayCoordinatorPhase {
    return this.phase;
  }

  ready(): void {
    if (this.phase === "pending") {
      this.phase = "ready";
      this.resolveReady();
    }
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  commit(): void {
    if (this.phase === "cancelled") {
      throw this.cancelledWith
        ?? new Error(`${this.context}: fork replay was cancelled before commit`);
    }
    if (this.phase !== "ready") {
      throw new Error(
        `${this.context}: cannot commit fork replay while ${this.phase}`,
      );
    }
    commitForkReplayGate(this.gate);
    this.phase = "committed";
  }

  cancel(reason?: unknown): void {
    if (this.phase === "cancelled" || this.phase === "committed") return;
    const error = cancellationError(this.context, reason);
    this.cancelledWith = error;
    this.phase = "cancelled";
    cancelForkReplayGate(this.gate);
    this.rejectReady(error);
  }
}

/**
 * Bind readiness and every premature Worker terminal path to one coordinator.
 *
 * Entry points still own normal process teardown. This observer only controls
 * the launch transaction and is intentionally host-neutral so Node and browser
 * cannot drift in which events release or cancel a fork.
 */
export function observeForkReplayWorker(
  coordinator: ForkReplayGateCoordinator,
  worker: WorkerHandle,
  pid: number,
  isCurrentGeneration: () => boolean,
): void {
  const protocolFailure = (detail: string): void => {
    coordinator.cancel(new Error(`${coordinator.context}: ${detail}`));
  };

  worker.on("message", (raw: unknown) => {
    const message = raw as Partial<WorkerToHostMessage>;
    if (message.type === "fork_replay_ready") {
      if (message.pid !== pid) {
        protocolFailure(
          `Worker reported replay readiness for pid=${String(message.pid)}, expected pid=${pid}`,
        );
      } else if (!isCurrentGeneration()) {
        protocolFailure("stale Worker generation reported replay readiness");
      } else {
        coordinator.ready();
      }
      return;
    }

    if (message.type === "error" || message.type === "exit") {
      if (message.pid !== pid) {
        protocolFailure(
          `Worker reported ${message.type} for pid=${String(message.pid)}, expected pid=${pid}`,
        );
      } else if (message.type === "error") {
        protocolFailure(
          `Worker failed before replay readiness: ${message.message ?? "unknown error"}`,
        );
      } else {
        const exitMessage = message as Partial<
          Extract<WorkerToHostMessage, { type: "exit" }>
        >;
        protocolFailure(
          `Worker exited before replay readiness (status=${String(exitMessage.status)})`,
        );
      }
    }
  });

  worker.on("error", (error: Error) => {
    protocolFailure(
      `Worker error before replay readiness: ${error.message || String(error)}`,
    );
  });
  worker.on("exit", (code: number) => {
    protocolFailure(`Worker exited before replay readiness (code=${code})`);
  });
}
