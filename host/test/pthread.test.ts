import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pthreadBinary = join(__dirname, "../../examples/test-pthread.wasm");
const hasBinary = existsSync(pthreadBinary);
const threadExitGroupBinary = join(__dirname, "../../examples/thread-exit-group.wasm");
const hasThreadExitGroupBinary = existsSync(threadExitGroupBinary);
const slotChurnBinary = join(__dirname, "../../examples/pthread-slot-churn.wasm");
const hasSlotChurnBinary = existsSync(slotChurnBinary);

describe.skipIf(!hasBinary)("pthread", () => {
  it("creates a thread that modifies shared state and returns a value", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: pthreadBinary,
      timeout: 30_000,
    });

    expect(stdout).toContain("creating thread");
    expect(stdout).toContain("joining thread");
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe.skipIf(!hasThreadExitGroupBinary)("thread process exit", () => {
  it("preserves exit(0) from a non-main thread while the main thread is blocked", async () => {
    for (let i = 0; i < 10; i++) {
      const { exitCode, stderr } = await runCentralizedProgram({
        programPath: threadExitGroupBinary,
        argv: ["thread-exit-group"],
        timeout: 10_000,
      });

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    }
  }, 30_000);
});

describe.skipIf(!hasSlotChurnBinary)("pthread slot reuse", () => {
  // The pthread slot arena is a limit on *concurrent* threads, not on threads
  // ever created. POSIX gives `pthread_create` EAGAIN only when "the system
  // lacked the necessary resources to create another thread, or the
  // system-imposed limit on the total number of threads in a process
  // {PTHREAD_THREADS_MAX} would be exceeded" -- both conditions about threads
  // that exist now. A joined thread has released its resources, so a
  // create/join loop must run indefinitely.
  //
  // The fixture runs 17 rounds, one more than the 16 slots the native Wasmtime
  // host reserved per process when this test was written, and only ever has
  // one thread live. It is the Node half of a deliberate cross-host pair; the
  // native half is `smoke_pthread_slot_reuse_across_join` in
  // `crates/host-native/src/lib.rs`. The point of the pair is that both hosts
  // must agree, so neither may be changed without the other.
  it("reuses a joined thread's slot across many sequential threads", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: slotChurnBinary,
      timeout: 30_000,
    });

    expect(stdout).toContain("PTHREAD_SLOT_CHURN_PASS");
    expect(exitCode).toBe(0);
  }, 30_000);
});
