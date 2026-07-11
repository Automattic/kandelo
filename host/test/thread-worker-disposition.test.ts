import { describe, expect, it } from "vitest";
import {
  removeThreadWorkerRegistryEntry,
  threadWorkerFailureDisposition,
} from "../src/thread-worker-disposition";
import { signalExitStatus, SIGILL, SIGSEGV } from "../src/trap-signals";

describe("pthread worker failure disposition", () => {
  it("treats classified guest traps as process-fatal signal deaths", () => {
    expect(threadWorkerFailureDisposition("RuntimeError: unreachable")).toEqual({
      kind: "guest-fatal-trap",
      exitStatus: signalExitStatus(SIGILL),
      signum: SIGILL,
    });

    expect(
      threadWorkerFailureDisposition("RuntimeError: operation does not support unaligned accesses"),
    ).toEqual({
      kind: "guest-fatal-trap",
      exitStatus: signalExitStatus(SIGSEGV),
      signum: SIGSEGV,
    });
  });

  it("does not misclassify host/setup failures as guest signal traps", () => {
    expect(
      threadWorkerFailureDisposition("Thread worker failed: No __indirect_function_table export"),
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
