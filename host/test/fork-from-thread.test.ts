/**
 * Tests fork() called from a pthread_create'd worker thread.
 *
 * The host runtime must (a) drive the asyncify state machine from the
 * thread worker so the save buffer contains the thread's frames +
 * saved __tls_base/__stack_pointer; (b) route the child Worker into
 * the thread function via `forkChildThreadFnPtr` so the rewind
 * actually reaches the fork() call site (`_start` isn't in the
 * thread's fork-path call chain).
 *
 * Without those, the child rewinds zero __tls_base/__stack_pointer
 * and crashes on its first shadow-stack frame — and the parent's
 * `waitpid` then deadlocks because the host never tells the kernel
 * the child died (see PR #465 for the orthogonal crash-reap fix).
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const forkFromThreadBinary = tryResolveBinary("programs/fork-from-thread.wasm");
const hasFork = !!forkFromThreadBinary;

describe("fork-from-non-main-thread", () => {
  it.skipIf(!hasFork)("a pthread_create'd thread can fork(), child resumes at the fork site", async () => {
    const result = await runCentralizedProgram({
      programPath: forkFromThreadBinary!,
      argv: ["fork-from-thread"],
      timeout: 15_000,
    });

    expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);

    // Parent thread reached the fork-callable code path.
    expect(result.stdout).toContain("THREAD_STARTED");
    expect(result.stdout).toContain("PRE_FORK_THREAD");

    // Parent thread received a positive child pid.
    expect(result.stdout).toMatch(/PARENT_THREAD: child=\d+/);

    // Child resumed inside the thread function, took the pid==0 branch,
    // ran the post-fork code, and exited cleanly. This is the load-bearing
    // expectation: without correct fork-from-thread, the child traps in
    // _start before any thread code runs.
    expect(result.stdout).toContain("CHILD_THREAD: ok");

    // Final PASS line — main thread joined the worker and waitpid()'d
    // the child to a normal exit.
    expect(result.stdout).toContain("PASS");
  });
});
