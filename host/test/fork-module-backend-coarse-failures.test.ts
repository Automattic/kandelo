// Coarse-path truthful-failure coverage for `ForkModuleContinuationBackend`.
//
// This file preserves the two truthful-failure contracts that were previously
// asserted through the now-deleted FINE-GRAINED backend wrappers
// (`fork-module-backend-abort.test.ts`), retargeted at the COARSE per-phase
// API the host actually drives in production (control-flow inversion: item #1).
// The fine-grained `beginUnwind`/`finishUnwindAndSerialize`/`beginAbort`/
// `finishAbort`/... wrappers and their `fm_*` module exports were removed once
// every fork phase routed through the coarse `fm_parent_*`/`fm_child_*` entries,
// so the same failure contracts are re-proven on those coarse entries here.
//
//  1. SEAL-TIME TRUTHFUL FAILURE: a capture SEAL the module cannot complete must
//     surface a TYPED `ContinuationAllocationError` (the coordinator reroutes it
//     to abort-replay: parent preserved, `fork()` returns `-errno`, no child),
//     NOT the generic `requireOk` throw that would escape and trap the worker.
//     With the JS continuation fallback gone, no module failure site may trap.
//     Exercised on the coarse `sealCaptureAndSerialize()` (`fm_parent_seal_
//     capture`), the production seal entry, which carries the identical typed-
//     error contract the fine-grained `finishUnwindAndSerialize` did.
//
//  2. MODULE-OR-FATAL CAPACITY BOUNDARY: the co-resident module backs EVERY
//     fork; there is no JS continuation fallback. A fork the module cannot back
//     (here: a resume catalog larger than the module's static BSS cap) must FAIL
//     LOUD at construction, never silently drop to a deleted JS route.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";
import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
import { ContinuationAllocationError } from "../src/fork-continuation";
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
  it("a coarse seal the module cannot complete throws a TYPED ContinuationAllocationError, not a worker-trapping generic throw", () => {
    // A CHANNEL RESPONDER IS NEEDED, and the comment that said it was not is
    // what made this file hang. The coarse seal itself still fails at
    // `build_seal_plan_impl` (no capture open -> EINVAL) before it tries to
    // channel-mmap the journal-image chunk -- that part is unchanged, and it is
    // the `sealCaptureAndSerialize` branch under test. `fm_set_format` below
    // releases the arena through `CHANNEL_BASE`, and with nobody behind that
    // address a module call that maps would park in `memory_atomic_wait32`
    // with no deadline and the file would hang rather than fail.
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

    // No capture is open, so the coarse seal cannot build its drive plan and the
    // module returns a truthful errno. The backend MUST translate that into a
    // typed `ContinuationAllocationError` (routed to abort-replay), never a bare
    // `requireOk` Error that would escape `sealCapture` and trap the worker.
    let caught: unknown;
    try {
      backend.sealCaptureAndSerialize();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContinuationAllocationError);
    expect((caught as ContinuationAllocationError).errno).not.toBe(0);
  });
});

// WHAT USED TO BE HERE: a "module-or-fatal capacity boundary" test, asserting
// that a resume catalog past `FORK_MODULE_RESUME_CATALOG_CAP` threw at
// construction. The cap is gone: the module stores every catalog on its arena
// and a catalog it cannot map fails with the channel's own errno through
// `fm_admit_activation`, which is the `call()` throw the other tests in this
// file already cover.
