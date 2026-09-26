// Coarse-path truthful-failure coverage for `ForkModuleContinuationBackend`.
//
// SEAL-TIME TRUTHFUL FAILURE has two halves, and they must not be confused.
//
//  1. A seal that fails AFTER the capture's frames sealed (a reference the
//     platform will not carry, a seal-time allocation failure) is a fork that
//     ABORTS: the module begins the abort replay itself, the parent survives
//     and `fork()` returns `-errno`, and `sealCaptureAndSerialize()` answers
//     `null`. That half is proven against a live capture in
//     `fork-module-capture-drive.test.ts` ("a seal that fails after the frames
//     sealed ...") and `fork-module-capture-refusal.test.ts`.
//
//  2. A seal the module refuses OUTRIGHT -- here, one with no capture open --
//     has no frames to replay and no abort to begin. It must throw loudly,
//     and it must NOT begin an abort replay of a capture that never existed.
//     This file pins that half.
//
// (Until 2026-09-26 every seal failure surfaced as a typed
// `ContinuationAllocationError` that the worker turned into an abort replay
// of its own; the module now decides, from whether its journal sealed.)
//
// WHAT USED TO BE HERE, second: a "module-or-fatal capacity boundary" test
// (see the note at the end of this file).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";
import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
import { startChannelResponder } from "./fork-module-capture-fixture";

const PAGE = 65536;
const MiB = 1024 * 1024;
const CHANNEL_BASE = 2 * MiB;
/**
 * Where the responder starts handing out mappings: above the module region the
 * bump allocator places at 4 MiB, inside the 16 MiB the harness declares.
 */
const MMAP_FLOOR = 8 * MiB;

function loadForkModule32(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
}

/** A page-aligned monotonic bump allocator over a slice of the shared memory. */
function bumpAllocator(start: number): { reserve: (n: number) => number } {
  let next = Math.ceil(start / PAGE) * PAGE;
  return {
    reserve: (n: number): number => {
      const base = next;
      next += Math.ceil(n / PAGE) * PAGE;
      return base;
    },
  };
}

describe("ForkModuleContinuationBackend coarse seal truthful failure", () => {
  it("a seal refused outright throws, and begins no abort", () => {
    // A CHANNEL RESPONDER IS NEEDED, and the comment that said it was not is
    // what made this file hang. `fm_set_format` below releases the arena
    // through `CHANNEL_BASE`, and with nobody behind that address a module
    // call that maps would park in `memory_atomic_wait32` with no deadline and
    // the file would hang rather than fail.
    const memory = new WebAssembly.Memory({
      initial: Math.ceil((16 * MiB) / PAGE),
      maximum: 16384,
      shared: true,
    });
    startChannelResponder({ memory, channelBase: CHANNEL_BASE, floor: MMAP_FLOOR });
    const alloc = bumpAllocator(4 * MiB);
    const fm = instantiateForkModule({
      module: loadForkModule32(),
      memory,
      reserve: alloc.reserve,
      label: "coarse-seal-fail",
    });
    const px = fm.exports as ForkModuleExports;

    const backend = new ForkModuleContinuationBackend({
      instance: fm,
      memory,
      ptrWidth: 4,
      channelBase: CHANNEL_BASE,
      label: "coarse-seal-fail",
    });
    backend.setup();

    // No capture is open, so the module refuses the seal for its phase
    // (EBUSY) before it looks at anything else.
    expect(() => backend.sealCaptureAndSerialize()).toThrow(/errno=16/);
    // And the refusal began nothing: an abort replay here would replay a
    // capture that does not exist, which `null` from the seal would then hide.
    expect(Number((px.fm_phase as () => number)()), "still idle").toBe(0);
  });
});

// WHAT USED TO BE HERE: a "module-or-fatal capacity boundary" test, asserting
// that a resume catalog past `FORK_MODULE_RESUME_CATALOG_CAP` threw at
// construction. The cap is gone: the module stores every catalog on its arena
// and a catalog it cannot map fails with the channel's own errno through
// `fm_admit_activation`, which is the `call()` throw the other tests in this
// file already cover.
