/**
 * Exact worker-owned process-memory retirement fences shared by Node/Bun and
 * browser hosts.
 */
export interface WorkerQuiescence {
  readonly settled: boolean;
  readonly promise: Promise<void>;
  settle(): void;
}

export interface ProcessWorkerIdentity {
  readonly pid: number;
  readonly tid?: number;
}

export interface ProcessWorkerTerminalPort {
  postMessage(message: unknown): void;
  close(): void;
}

/**
 * Run one process-worker activation through its only terminal ownership fence.
 *
 * WHY: Node, Bun, and browser entry modules must publish the fence after
 * worker-main returns on success, cooperative exit, exec retirement, or
 * failure. Keeping the finally path shared prevents one host from closing its
 * realm without acknowledging that it can no longer access process Memory.
 */
export async function runWithProcessWorkerQuiescence(
  port: ProcessWorkerTerminalPort,
  identity: ProcessWorkerIdentity,
  run: () => Promise<void>,
  reportError: (error: unknown) => void,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    try {
      reportError(error);
    } catch {
      // Diagnostics must not suppress the ownership fence.
    }
  } finally {
    try {
      port.postMessage({
        type: "memory_quiescent",
        pid: identity.pid,
        ...(identity.tid === undefined ? {} : { tid: identity.tid }),
      });
    } finally {
      // The message listener/port is otherwise a permanent event-loop root.
      port.close();
    }
  }
}

export function createWorkerQuiescence(): WorkerQuiescence {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    get settled() {
      return settled;
    },
    promise,
    settle() {
      if (settled) return;
      settled = true;
      resolve();
    },
  };
}

export async function waitForWorkerQuiescence(
  quiescence: WorkerQuiescence,
  timeoutMs: number,
): Promise<boolean> {
  if (quiescence.settled) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    quiescence.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return quiescence.settled;
}

export async function waitForExecRetirement(
  retirement: WorkerQuiescence,
  quiescence: WorkerQuiescence,
  timeoutMs: number,
): Promise<boolean> {
  if (retirement.settled && quiescence.settled) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([retirement.promise, quiescence.promise]),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  // exec_retired proves worker-main took the intentional no-SYS_EXIT path;
  // memory_quiescent proves worker-main returned and no longer owns Memory.
  return retirement.settled && quiescence.settled;
}

/** Retire independent realms together only with exact ownership proof.
 * Callers accept actual terminal fences or a sealed never-constructed realm;
 * absence must never settle a memory_quiescent/exec_retired message fence. */
export async function retireWorkerBatch<T>(options: {
  workers: readonly T[];
  mayRetireTogether: boolean;
  retirementProven: (worker: T) => boolean;
  terminate: (worker: T) => Promise<void>;
  release: (worker: T) => void;
}): Promise<boolean> {
  const { workers, retirementProven, terminate, release } = options;
  const retire = async (worker: T): Promise<void> => {
    await terminate(worker);
    // A sibling's acknowledgement never authorizes this realm's metadata.
    release(worker);
  };
  if (options.mayRetireTogether && workers.every(retirementProven)) {
    // WHY: browser termination has an independent settle interval per realm.
    // Serial waits multiply that interval by thread count and can lose a
    // cooperative exit to destroy's forced-retirement deadline. Exact terminal
    // fences prove these guests cannot grow memory while siblings retire.
    const results = await Promise.allSettled(workers.map(retire));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } else {
    // Missing fences retain the existing containment order; a timeout is not
    // evidence that concurrent destruction of live instances is safe.
    for (const worker of workers) await retire(worker);
  }
  // An acknowledgement may arrive while host termination settles. Read exact
  // ownership proofs again rather than freezing a timed-out observation.
  return workers.every(retirementProven);
}
