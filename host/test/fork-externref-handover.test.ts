import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXTERNREF_HANDOVER_ADDR_OFFSET,
  EXTERNREF_HANDOVER_COUNT_OFFSET,
  readCapturedExternrefHandover,
  writeCapturedExternrefHandover,
} from "../src/fork-externref-process-owner";

/**
 * The parent tells the kernel worker which externref handles its capture
 * interned, through two slots in the host-private control prefix.
 *
 * This replaced the kernel worker reading the parked parent's KFMS arena and
 * running the full segmented-transaction parser over it -- about 4,956 lines of
 * host decoder re-deriving a set the parent already had, on the one thread every
 * process's syscalls serialize through.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const CONTROL = 4096;

function scratch(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 2 });
}

describe("externref handover slots", () => {
  it("round-trips a staged handle list", () => {
    const memory = scratch();
    const at = 8192;
    new Uint32Array(memory.buffer, at, 3).set([7, 9, 11]);
    writeCapturedExternrefHandover(memory, CONTROL, at, 3);
    expect([...readCapturedExternrefHandover(memory, CONTROL)]).toEqual([7, 9, 11]);
  });

  it("reads an unwritten prefix as no handles", () => {
    expect([...readCapturedExternrefHandover(scratch(), CONTROL)]).toEqual([]);
  });

  it("refuses a count reported with no address", () => {
    // The case that makes the address-0 branch a guard rather than a shortcut.
    // A parent that recorded a length and failed to stage would otherwise have
    // `count` words read from the guest's NULL PAGE, and whatever they held
    // would be leased to the child as externref handles.
    const memory = scratch();
    writeCapturedExternrefHandover(memory, CONTROL, 0, 3);
    expect(() => readCapturedExternrefHandover(memory, CONTROL)).toThrow(
      /3 staged handle\(s\) reported with no address/,
    );
  });

  it("refuses a staged range that runs past the parent's memory", () => {
    const memory = scratch();
    writeCapturedExternrefHandover(memory, CONTROL, 8192, 1_000_000);
    // The kernel worker reads a PARKED parent's memory here. A length it cannot
    // satisfy must be reported, not clamped: a short list leases fewer
    // references than the child inherits, which is silent corruption.
    expect(() => readCapturedExternrefHandover(memory, CONTROL)).toThrow(
      /run past the parent's memory/,
    );
  });

  it("does not collide with the dlopen control slots", () => {
    // The dlopen slots live in `worker-main.ts` because INSTRUMENTED WASM reads
    // them and needs per-width offsets. These two are host-to-host only, so
    // they live with their reader -- which means two files describe one prefix,
    // and this is what keeps them apart.
    const workerMain = readFileSync(
      join(repoRoot, "host/src/worker-main.ts"),
      "utf8",
    );
    const dlopen = [
      ...workerMain.matchAll(/const DLOPEN_\w+_OFFSET_WASM\d+ = (\d+);/g),
    ].map((m) => Number(m[1]));
    expect(dlopen.length).toBeGreaterThan(0);
    const ours = [EXTERNREF_HANDOVER_ADDR_OFFSET, EXTERNREF_HANDOVER_COUNT_OFFSET];
    for (const offset of ours) {
      // Each slot is 8 bytes, so a dlopen slot anywhere in [offset, offset+8)
      // would overlap.
      for (const taken of dlopen) {
        expect(
          taken >= offset && taken < offset + 8,
          `dlopen offset ${taken} collides with handover slot ${offset}`,
        ).toBe(false);
      }
    }
    // And both must sit inside the 4 KiB prefix they are carved from.
    for (const offset of ours) expect(offset + 8).toBeLessThanOrEqual(4096);
  });
});
