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

/**
 * Wait for a sibling thread to leave an address space discarded by exec.
 *
 * A thread can race exec by completing its ordinary thread-exit path before
 * the host queues the private exec-retirement marker. Those dispositions are
 * mutually exclusive, but both are authoritative only after the wrapper's
 * exact `memory_quiescent` fence proves that the Worker realm has returned.
 */
export async function waitForThreadExecRetirement(
  retirement: WorkerQuiescence,
  threadExit: WorkerQuiescence,
  quiescence: WorkerQuiescence,
  timeoutMs: number,
): Promise<boolean> {
  if ((retirement.settled || threadExit.settled) && quiescence.settled) {
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([
      Promise.race([retirement.promise, threadExit.promise]),
      quiescence.promise,
    ]),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return (retirement.settled || threadExit.settled) && quiescence.settled;
}
