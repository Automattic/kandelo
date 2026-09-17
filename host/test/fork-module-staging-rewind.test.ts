// The staging slab's per-fork region must be REUSED, and its durable region
// must never be handed out twice.
//
// `ForkModuleContinuationBackend` stages every pre-fork buffer into one 256 KiB
// slab in guest memory with a bump cursor. Twelve of its callers are per-WORKER
// seeds that must outlive every fork. TWO are per-FORK -- `stageSides()` (8
// bytes per side activation, at both `parentBeginCapture` and `installChild`)
// and `stageExternrefHandover()` (4 bytes per handle) -- and the cursor never
// rewound over them, so a long-lived forking program consumed the slab
// permanently and eventually failed a fork that had done nothing wrong with
// "staging slab exhausted". A dlopen program at three side activations spends
// 24 bytes a fork and reaches it in roughly eleven thousand of them.
//
// The rewind cannot be blind, which is the second assertion here. `dlopen`
// AFTER a fork registers a new activation and stages its GC codec, resume
// catalog and exception codec above the mark that fork took. Rewinding to that
// mark on the next fork would hand a live codec's address out a second time and
// overwrite it with side-activation pairs -- a wrong child, silently, rather
// than an error. A durable stage therefore drops the mark so the next fork
// takes a fresh one above it.
//
// Both assertions read the ADDRESS the backend hands the module, which is the
// only thing about the cursor a caller can observe.
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
    label: "staging rewind harness",
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

describe("staging slab per-fork region", () => {
  it("places each fork's side-activation pairs at the same address", () => {
    const { backend, sidesPointers } = harness();
    for (let fork = 0; fork < 32; fork += 1) {
      backend.parentBeginCapture(0, 0, SIDES);
      backend.stageExternrefHandover([7, 8, 9, 10]);
    }
    expect(sidesPointers).toHaveLength(32);
    // Not merely "bounded": IDENTICAL. A cursor that grows by any amount per
    // fork is the defect, and a slab large enough to hide 32 forks would hide
    // a per-fork leak too.
    expect(new Set(sidesPointers).size).toBe(1);
  });

  it("does not exhaust the slab over more forks than the slab has room for", () => {
    const { backend } = harness();
    // 24 bytes of side pairs plus 16 of handover per fork: unrewound, the 8 KiB
    // slab is gone in ~200 forks.
    expect(() => {
      for (let fork = 0; fork < 2000; fork += 1) {
        backend.parentBeginCapture(0, 0, SIDES);
        backend.stageExternrefHandover([7, 8, 9, 10]);
      }
    }).not.toThrow();
  });

  it("never rewinds over a codec staged by a dlopen between two forks", () => {
    const { backend, memory, sidesPointers, codecPointers } = harness();
    const codec = new Uint8Array(128).fill(0xab);

    backend.parentBeginCapture(0, 0, SIDES);
    // The dlopen: a new activation's durable seed, staged above the fork mark.
    backend.setActivationGcCodec(4, codec);
    backend.parentBeginCapture(0, 0, SIDES);

    expect(codecPointers).toHaveLength(1);
    const [codecAt] = codecPointers;
    const [, secondSidesAt] = sidesPointers;
    // The second fork's pairs must land clear of the codec, not on top of it.
    expect(secondSidesAt).toBeGreaterThanOrEqual(codecAt + codec.length);
    // And the codec's bytes must still be the codec's.
    expect(
      new Uint8Array(memory.buffer, codecAt, codec.length).every(
        (byte) => byte === 0xab,
      ),
    ).toBe(true);
  });
});
