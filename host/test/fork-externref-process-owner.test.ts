// `ForkExternrefProcessOwner`: which externref generation a process image
// holds, and what a fork child is granted.
//
// THE GRANT NO LONGER PARSES AN ARENA. This file used to build a sealed KFMS
// continuation in TypeScript and hand it to `forkGenerationFromContinuation`,
// which walked the parked parent's arena -- in the KERNEL worker, the one
// thread every process's syscalls serialize through -- to re-derive which
// externref handles the fork carried. The parent records each broker handle as
// `fm_capture_intern` interns it, and hands the list over after the seal.
//
// Since the cross-worker host-import transport was removed, nothing registers
// a host value with the owner, so a real grant is always empty. What is left
// to pin: an empty grant starts the child, a failed grant leaves no child
// generation behind, exec retires PID-stable authority, and a handle the
// parent does not own is refused.

import { describe, expect, it } from "vitest";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";

describe("ForkExternrefProcessOwner", () => {
  it("starts a fresh child from an empty captured handle list", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(41);
    const grant = owner.forkGenerationFromCapturedHandles(parent, 42, []);
    expect(grant.handleCount).toBe(0);
    expect(grant.generation.pid).toBe(42);

    // The child's generation outlives the parent's: releasing the parent does
    // not retire the child.
    expect(owner.releaseGeneration(parent)).toBe(true);
    expect(() => owner.startGeneration(42)).toThrow(
      "already has a live generation",
    );
    expect(owner.releaseGeneration(grant.generation)).toBe(true);
    expect(owner.startGeneration(42).pid).toBe(42);
  });

  it("retires PID-stable authority exactly when exec replaces an image", () => {
    const owner = new ForkExternrefProcessOwner();
    const beforeExec = owner.startGeneration(51);

    const afterExec = owner.replaceGeneration(beforeExec);
    expect(afterExec.pid).toBe(51);
    expect(afterExec.id).not.toBe(beforeExec.id);
    expect(() => owner.replaceGeneration(beforeExec)).toThrow("stale");
    expect(() => owner.forkGenerationFromCapturedHandles(beforeExec, 52, []))
      .toThrow("stale");
    expect(
      owner.forkGenerationFromCapturedHandles(afterExec, 52, []).handleCount,
    ).toBe(0);
  });

  it("rolls back a provisional child generation when a handle is not the parent's", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(61);

    // THE BOUND ON TRUSTING THE PARENT'S LIST. The kernel worker takes a
    // process worker's word for the handle set, and the broker is what makes
    // that safe: a handle the parent does not hold is refused, so a wrong list
    // can never reach another process's references.
    expect(() => owner.forkGenerationFromCapturedHandles(parent, 62, [900]))
      .toThrow("unknown externref handle");

    // A failed grant leaves no hidden child generation behind.
    expect(owner.startGeneration(62).pid).toBe(62);
  });

  it("refuses a malformed handle rather than leasing something else", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(63);
    for (const bad of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(
        () => owner.forkGenerationFromCapturedHandles(parent, 64, [bad]),
        `handle ${bad}`,
      ).toThrow("invalid captured externref handle");
    }
    expect(owner.startGeneration(64).pid).toBe(64);
  });
});
