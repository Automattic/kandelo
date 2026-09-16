// `ForkExternrefProcessOwner`: who may resolve a broker handle, and when.
//
// THE GRANT NO LONGER PARSES AN ARENA. This file used to build a sealed KFMS
// continuation in TypeScript and hand it to `forkGenerationFromContinuation`,
// which walked the parked parent's arena -- in the KERNEL worker, the one
// thread every process's syscalls serialize through -- to re-derive which
// externref handles the fork carried. The parent already knows them: it
// records each broker handle as `fm_capture_intern` interns it, and hands the
// list over after the seal. So the work disappeared rather than moved, and
// with it went ~4,956 lines of host decoder and this file's arena fixture.
//
// What is left is the part that was always the subject: aliasing collapses to
// one lease, a failed grant leaves no child generation behind, exec retires
// PID-stable authority, and one generation serves the main and pthread import
// adapters.

import { describe, expect, it } from "vitest";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";

describe("ForkExternrefProcessOwner", () => {
  it("leases each aliased handle once before a fresh child starts", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(41);
    const value = { opaque: true };
    const handle = owner.registerForWire(41, owner.generationId(parent), value);

    // The capture interns the same value three times; the recorded set is what
    // the parent hands over, and aliases collapse to ONE lease.
    const grant = owner.forkGenerationFromCapturedHandles(parent, 42, [
      handle,
      handle,
      handle,
    ]);
    expect(grant.handleCount).toBe(1);
    expect(owner.authorizeForWire(42, grant.generation.id, handle)).toBe(value);

    // The child's lease outlives the parent's generation: a forked child holds
    // the reference in its own right, not through its parent.
    owner.releaseGeneration(parent);
    expect(owner.authorizeForWire(42, grant.generation.id, handle)).toBe(value);
    owner.releaseGeneration(grant.generation);
    expect(() => owner.authorizeForWire(42, grant.generation.id, handle))
      .toThrow("stale");
  });

  it("retires PID-stable authority exactly when exec replaces an image", () => {
    const owner = new ForkExternrefProcessOwner();
    const beforeExec = owner.startGeneration(51);
    const beforeId = owner.generationId(beforeExec);
    const handle = owner.registerForWire(51, beforeId, Symbol("old image"));

    const afterExec = owner.replaceGeneration(beforeExec);
    expect(afterExec.pid).toBe(51);
    expect(afterExec.id).not.toBe(beforeId);
    expect(() => owner.authorizeForWire(51, beforeId, handle)).toThrow("stale");
    expect(() => owner.authorizeForWire(51, afterExec.id, handle))
      .toThrow("retired");
  });

  it("rolls back a provisional child generation when a handle is not the parent's", () => {
    const owner = new ForkExternrefProcessOwner();
    const parent = owner.startGeneration(61);

    // THE BOUND ON TRUSTING THE PARENT'S LIST. The kernel worker no longer
    // derives the set itself, so it takes a process worker's word for it --
    // and the broker is what makes that safe: a handle the parent does not
    // hold is refused, so a wrong list can only over- or under-claim within
    // the parent's own generation, never reach another process's references.
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

  it("uses one process generation for main and pthread import adapters", () => {
    const owner = new ForkExternrefProcessOwner();
    const generation = owner.startGeneration(71);
    const idForMainWorker = owner.generationId(generation);
    const idForPthreadWorker = owner.generationId(generation);
    const handle = owner.registerForWire(71, idForMainWorker, "shared");

    expect(owner.authorizeForWire(71, idForPthreadWorker, handle))
      .toBe("shared");
  });
});
