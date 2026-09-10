import { describe, expect, it } from "vitest";
import {
  removeThreadWorkerRegistryEntry,
  threadWorkerFailureDisposition,
} from "../src/thread-worker-disposition";
import { signalExitStatus, SIGILL, SIGSEGV } from "../src/trap-signals";

// Which message means which signal is decided by
// `wasm_posix_shared::trap_signal` and reached through the kernel's
// `kernel_classify_wasm_trap_signal` export; its own tests live beside it in
// Rust, and `host/test/wasm-trap.test.ts` proves the whole path with real
// trapping guests. What this file tests is the disposition built on top of a
// classification, so the classifier is a stub that states its answers.
const stubClassifier = (answers: Record<string, number>) => (text: string) =>
  answers[text] ?? 0;

describe("pthread worker failure disposition", () => {
  it("treats classified guest traps as process-fatal signal deaths", () => {
    const classify = stubClassifier({
      "RuntimeError: unreachable": SIGILL,
      "RuntimeError: operation does not support unaligned accesses": SIGSEGV,
    });

    expect(
      threadWorkerFailureDisposition(classify, "RuntimeError: unreachable"),
    ).toEqual({
      kind: "guest-fatal-trap",
      exitStatus: signalExitStatus(SIGILL),
      signum: SIGILL,
    });

    expect(
      threadWorkerFailureDisposition(
        classify,
        "RuntimeError: operation does not support unaligned accesses",
      ),
    ).toEqual({
      kind: "guest-fatal-trap",
      exitStatus: signalExitStatus(SIGSEGV),
      signum: SIGSEGV,
    });
  });

  it("does not misclassify host/setup failures as guest signal traps", () => {
    // The kernel answers 0 for text that is not a trap; a launch failure must
    // not become a fatal signal.
    expect(
      threadWorkerFailureDisposition(
        stubClassifier({}),
        "Thread worker failed: No __indirect_function_table export",
      ),
    ).toEqual({
      kind: "host-thread-failure",
    });
  });

  it("retires the per-process registry after its final worker is reclaimed", () => {
    const first = { tid: 11 };
    const second = { tid: 12 };
    const registry = new Map([[42, [first, second]]]);

    expect(removeThreadWorkerRegistryEntry(registry, 42, first)).toBe(true);
    expect(registry.get(42)).toEqual([second]);

    expect(removeThreadWorkerRegistryEntry(registry, 42, second)).toBe(true);
    expect(registry.has(42)).toBe(false);
    expect(removeThreadWorkerRegistryEntry(registry, 42, second)).toBe(false);
  });
});
