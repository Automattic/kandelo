import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CentralizedKernelWorker } from "../src/kernel-worker";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A reader at the tail of /dev/kmsg, end to end on the Node host.
 *
 * The Rust unit tests prove what the device returns and that writing a record
 * notifies epoll waiters, on the native build and through an in-process
 * stand-in for the host. What they cannot show, and this does, with the real
 * wasm32 kernel and the real host retry loop:
 *
 *  - a blocking read() at the tail is parked by the host and retried until a
 *    record arrives, and is not completed early or twice;
 *  - O_NONBLOCK is answered EAGAIN rather than parked;
 *  - poll() and an edge-triggered epoll waiter are woken by a logged record.
 *    The epoll case is the one that needs the kernel's notification: an
 *    EPOLLET waiter reports nothing it was not notified of, so it would wait
 *    forever if the wake were removed;
 *  - a parked kmsg read lands in the host's default timer retry, not in a
 *    pipe/accept event wake.
 *
 * The guest (examples/kmsg_tail_test.c) judges its own result. It reads the
 * log back at the tail and checks the record is the one its forked "poker"
 * caused, by pid, so a wake that delivered some earlier record cannot pass.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/kmsg_tail_test.wasm");

// Vitest's default of 5 s is shorter than a loaded machine needs to boot a
// kernel and fork a guest. A hang still fails, at this bound.
const TEST_TIMEOUT_MS = 90_000;

async function runMode(mode: string, pokeDelayMs?: number) {
  return runCentralizedProgram({
    programPath,
    argv: ["kmsg_tail_test", mode, ...(pokeDelayMs === undefined ? [] : [String(pokeDelayMs)])],
    timeout: 60_000,
    useDefaultRootfs: false,
  });
}

describe("/dev/kmsg at the tail", () => {
  it("parks a blocking read until the record is logged, then returns it once", async () => {
    const result = await runMode("block");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("READY\nkmsg-tail-block-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);

  it("answers an O_NONBLOCK read EAGAIN instead of parking it", async () => {
    const result = await runMode("nonblock");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("READY\nkmsg-tail-nonblock-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);

  it("wakes poll(POLLIN) when a record is logged", async () => {
    const result = await runMode("poll");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("READY\nkmsg-tail-poll-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);

  // Fails by hanging, not by a wrong value, if the kernel stops notifying
  // epoll waiters when it logs a record: the guest's wait would never return.
  it("wakes an edge-triggered epoll waiter when a record is logged", async () => {
    const result = await runMode("epollet");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("READY\nkmsg-tail-epollet-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);

  // The host picks a retry strategy for a parked read from what the fd is: a
  // pipe or socket registers for its pipe's readiness events, anything else
  // falls to a 10 ms timer retry. A kmsg fd has no pipe, so it must be the
  // timer. This looks at the real CentralizedKernelWorker (main-thread
  // harness) while a real guest is parked, rather than a mock of it.
  it("parks a blocked kmsg read in the host's timer retry, not a pipe wake", async () => {
    interface ParkedRetry {
      channel: { pid: number };
      timer: unknown;
      pipeIndices: number[];
      acceptIndices?: number[];
      isWriteRetry?: boolean;
    }
    interface WorkerInternals {
      pendingPollRetries: Map<unknown, ParkedRetry>;
      pendingPipeReaders: Map<number, unknown[]>;
      pendingPipeWriters: Map<number, unknown[]>;
    }
    const seenTimers = new Set<unknown>();
    let parked: ParkedRetry | undefined;
    let pipeReadersWhileParked = -1;
    let pipeWritersWhileParked = -1;
    let sampling = true;

    const sample = async (kernel: CentralizedKernelWorker, pid: number) => {
      const internals = kernel as unknown as WorkerInternals;
      while (sampling) {
        for (const entry of internals.pendingPollRetries.values()) {
          if (entry.channel.pid !== pid) continue;
          parked ??= entry;
          seenTimers.add(entry.timer);
          pipeReadersWhileParked = internals.pendingPipeReaders.size;
          pipeWritersWhileParked = internals.pendingPipeWriters.size;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    // The poker waits long enough that the reader is parked for ~1.5 s, which
    // is many 10 ms retries.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["kmsg_tail_test", "block", "1500"],
      timeout: 60_000,
      useDefaultRootfs: false,
      onKernelReady: (kernel, pid) => {
        void sample(kernel, pid);
      },
    }).finally(() => {
      sampling = false;
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("READY\nkmsg-tail-block-ok\n");

    // It was parked in the default timer retry...
    expect(parked, "the blocked read never appeared in pendingPollRetries").toBeDefined();
    // ...with no pipe or accept readiness token: kernel_get_fd_pipe_idx is
    // negative for this fd, which is what routes it here. The export is not
    // callable from a test (the kernel instance is private to the worker), so
    // this is its observable consequence: the READ_LIKE branch would have
    // registered a pending pipe reader and returned before the default retry.
    expect(parked!.pipeIndices).toEqual([]);
    expect(parked!.acceptIndices ?? []).toEqual([]);
    expect(parked!.isWriteRetry).toBe(false);
    expect(pipeReadersWhileParked).toBe(0);
    expect(pipeWritersWhileParked).toBe(0);
    // ...and it was retried repeatedly while nothing was logged: each retry is
    // a fresh timer, so several distinct ones mean the loop was really cycling.
    expect(seenTimers.size).toBeGreaterThanOrEqual(3);
  }, TEST_TIMEOUT_MS);
});
