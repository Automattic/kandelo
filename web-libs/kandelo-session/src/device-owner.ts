// Stopping the program that owns a single-owner device, such as /dev/fb0, and
// waiting until the device is free. `/dev/fb0` returns EBUSY on a second open
// (kernel `acquire_fb0_or_busy`), so a new instance cannot start until the old
// one has exited and the kernel's exit path has released the binding. The
// display panes' dock actions use this before typing their own command.

import type { KernelHost } from "./kernel-host";

/** POSIX SIGTERM. Default disposition terminates a process with no handler. */
export const SIGTERM = 15;

/**
 * End the process that owns a single-owner device and wait until the device
 * is free: SIGTERM, then the caller's release evidence (default: the pid's
 * exit). The display panes stop their program this way because a program
 * that reads its keyboard from a raw-mode terminal, as fbDOOM does, never
 * sees Ctrl+C as a signal.
 */
export async function stopDeviceOwner(
  host: KernelHost,
  pid: number,
  options: {
    waitForRelease?: (pid: number, signal: AbortSignal) => Promise<void>;
    timeoutMs: number;
  },
): Promise<void> {
  const { waitForRelease, timeoutMs } = options;
  // Start watching before signalling, or a fast exit lands before we listen.
  // The abort signal also guarantees bounded listener lifetime on timeout.
  const releaseAbort = new AbortController();
  let releasePromise: Promise<void>;
  try {
    releasePromise = waitForRelease
      ? waitForRelease(pid, releaseAbort.signal)
      : waitForProcessExit(host, pid, { signal: releaseAbort.signal });
  } catch (error) {
    releasePromise = Promise.reject(error);
  }
  const released = waitUntil(releasePromise, timeoutMs, `process ${pid} did not exit within ${timeoutMs}ms`);
  // If signalProcess throws we never await `released`; keep its eventual
  // timeout rejection from surfacing as an unhandled rejection.
  released.catch(() => {});
  try {
    // An already-dead pid resolves false. The subscribed-then-enumerated
    // release wait still settles truthfully without requiring a future event.
    await host.signalProcess(pid, SIGTERM);
    await released;
  } finally {
    releaseAbort.abort();
  }
}

/**
 * Resolve once `pid` has exited. Subscribe before enumerating so neither an
 * already-finished process nor an exit racing the initial query can wedge the
 * caller.
 */
export function waitForProcessExit(
  host: KernelHost,
  pid: number,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let off = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      off();
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(new Error(`wait for pid ${pid} was cancelled`));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    off = host.subscribeProcessEvents((event) => {
      if (event.kind === "exit" && event.pid === pid) finish();
    });
    if (settled) off();

    void host.enumProcs().then(
      (processes) => {
        const running = processes.some(
          (process) => process.pid === pid && process.state !== "Z",
        );
        if (!running) finish();
      },
      (error) => finish(error),
    );
  });
}

function waitUntil<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
