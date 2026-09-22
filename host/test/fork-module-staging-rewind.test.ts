// The staging slab is a PER-CALL scratch: every stage lands at its base, and
// a request the slab cannot hold is refused rather than truncated.
//
// WHAT THIS REPLACED. This file used to assert a per-fork REWIND: the slab was
// a bump cursor, because the module kept the POINTER to every durable seed
// (catalog, codec, section) and read it back at every later fork, so a seed
// had to stay put for the life of the worker and only the two per-fork stages
// -- `stageSides()` and `stageExternrefHandover()` -- could be reused. The
// cursor never rewound over them, a long-lived forking program exhausted the
// slab in thousands of forks, and the fix was a mark taken at each fork and
// dropped by any durable stage above it.
//
// None of that survives the module copying its seeds. Catalogs, codecs and
// sections go into the module's own arena records, the template id into its
// own table, all during the entry that seeds them; the externref handover is
// read by the kernel during the fork syscall the worker blocks in next. So the
// slab holds ONE request at a time, the cursor is gone, and the only two
// things left to assert about `stage()` are the two below.
//
// THE COPY ITSELF IS PROVEN ELSEWHERE, against the real module:
// `fork-arena-release.test.ts` seeds a GC codec and then an exception codec
// over the same staging page and the module still answers from the codec's
// own bytes. A stand-in module cannot show that, which is why it is not
// re-asserted here.
import { describe, expect, it } from "vitest";

import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
import type { ForkSideActivation } from "../src/fork-activations";
import type { LinkedFrameFormatDescriptor } from "../src/fork-continuation";

const STAGING_BASE = 4096;
const STAGING_BYTES = 8192;

/**
 * A stand-in module that records the pointer each entry is given.
 *
 * Nothing here interprets the bytes: the claim is about WHERE the backend
 * places them, so a recorder is the whole of what the module has to be.
 */
function harness() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const sidesPointers: number[] = [];
  const codecPointers: number[] = [];
  const exports: Record<string, (...args: number[]) => number> = {
    fm_last_errno: () => 0,
    fm_parent_begin_capture: (_channel, _arena, sides, _count) => {
      sidesPointers.push(sides);
      return 0x2000;
    },
    fm_set_activation_gc_codec: (_activation, at, _len) => {
      codecPointers.push(at);
      return 0;
    },
  };
  const backend = new ForkModuleContinuationBackend({
    instance: {
      exports,
      stagingBase: STAGING_BASE,
      stagingBytes: STAGING_BYTES,
    } as unknown as ForkModuleContinuationBackendInstance,
    memory,
    ptrWidth: 4,
    format: { ptrWidth: 4, fixedPrefixSize: 64 } as LinkedFrameFormatDescriptor,
    catalogOrdinals: [],
    label: "staging scratch harness",
  });
  return { backend, memory, sidesPointers, codecPointers };
}

/** The constructor's `instance` field, which this file only ever stands in for. */
type ForkModuleContinuationBackendInstance = ConstructorParameters<
  typeof ForkModuleContinuationBackend
>[0]["instance"];

const SIDES: readonly ForkSideActivation[] = [
  { id: 1, fixedPrefix: 64 },
  { id: 2, fixedPrefix: 64 },
  { id: 3, fixedPrefix: 64 },
] as unknown as readonly ForkSideActivation[];

describe("staging slab as a per-call scratch", () => {
  it("places every stage at the slab's base, forks and seeds alike", () => {
    const { backend, sidesPointers, codecPointers } = harness();
    const codec = new Uint8Array(128).fill(0xab);
    for (let fork = 0; fork < 32; fork += 1) {
      backend.parentBeginCapture(0, 0, SIDES);
      backend.stageExternrefHandover([7, 8, 9, 10]);
      // A dlopen between forks: a seed the old cursor had to keep clear of.
      backend.setActivationGcCodec(4 + fork, codec);
    }
    expect(sidesPointers).toHaveLength(32);
    expect(codecPointers).toHaveLength(32);
    // Not merely "bounded": IDENTICAL, and the same address for a seed as for
    // a fork's sides. A cursor that grows by any amount per call is the
    // exhaustion this slab used to reach, and a slab large enough to hide 32
    // calls would hide a leak too.
    expect(new Set([...sidesPointers, ...codecPointers])).toEqual(new Set([STAGING_BASE]));
  });

  it("does not exhaust the slab over more calls than it has room for", () => {
    const { backend } = harness();
    // 24 bytes of side pairs, 16 of handover and 128 of codec per iteration:
    // as a cursor, the 8 KiB slab is gone in under fifty.
    const codec = new Uint8Array(128).fill(0xab);
    expect(() => {
      for (let fork = 0; fork < 2000; fork += 1) {
        backend.parentBeginCapture(0, 0, SIDES);
        backend.stageExternrefHandover([7, 8, 9, 10]);
        backend.setActivationGcCodec(4 + fork, codec);
      }
    }).not.toThrow();
  });

  it("refuses a request larger than the slab rather than truncating it", () => {
    // THE BOUNDARY, loud. A truncated section would be refused by the module's
    // decoder at best and seed a wrong one at worst, so the backend refuses
    // first and says both sizes. Exactly the slab's size still fits.
    const { backend, memory } = harness();
    const exact = new Uint8Array(STAGING_BYTES).fill(0x5c);
    backend.setActivationGcCodec(1, exact);
    expect(
      new Uint8Array(memory.buffer, STAGING_BASE, STAGING_BYTES).every((b) => b === 0x5c),
      "a request of exactly the slab's size is staged whole",
    ).toBe(true);
    const over = new Uint8Array(STAGING_BYTES + 1).fill(0x5d);
    expect(() => backend.setActivationGcCodec(2, over)).toThrow(
      /staging slab exhausted placing activation 2 GC codec \(8193 bytes against a 8192-byte slab\)/,
    );
    // And the refusal wrote nothing: the previous stage's bytes are intact.
    expect(
      new Uint8Array(memory.buffer, STAGING_BASE, STAGING_BYTES).every((b) => b === 0x5c),
      "a refused request leaves the slab as it was",
    ).toBe(true);
  });
});
