// The staging slab is a PER-CALL scratch: every stage lands at its base. An
// admission the slab cannot hold goes to a buffer the module maps to its size
// (`fm_admission_buffer`; its release is proven against the real module in
// `fork-module-admission.test.ts`); any other request the slab cannot hold is
// refused rather than truncated.
//
// WHAT THIS REPLACED. This file used to assert a per-fork REWIND: the slab was
// a bump cursor, because the module kept the POINTER to every durable seed
// (catalog, codec, section) and read it back at every later fork, so a seed
// had to stay put for the life of the worker and only the per-fork stages --
// `stageSides()`, and the since-deleted externref handover -- could be reused. The
// cursor never rewound over them, a long-lived forking program exhausted the
// slab in thousands of forks, and the fix was a mark taken at each fork and
// dropped by any durable stage above it.
//
// None of that survives the module copying its seeds. Catalogs, codecs and
// sections go into the module's own arena records, the template id into its
// own table, all during the entry that seeds them. So the slab holds ONE
// request at a time, the cursor is gone, and the only two
// things left to assert about `stage()` are the two below.
//
// THE COPY ITSELF IS PROVEN ELSEWHERE, against the real module:
// `fork-arena-release.test.ts` seeds a GC codec and then an exception codec
// over the same staging page and the module still answers from the codec's
// own bytes. A stand-in module cannot show that, which is why it is not
// re-asserted here.
import { describe, expect, it } from "vitest";

import { ForkModuleContinuationBackend } from "../src/fork-module-backend";

const STAGING_BASE = 4096;
const STAGING_BYTES = 8192;
/** Where the stand-in module's admission buffer is: above the slab. */
const SCRATCH_BASE = 16384;

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
  const codecLastBytes: number[] = [];
  const bufferRequests: number[] = [];
  const exports: Record<string, (...args: number[]) => number> = {
    fm_last_errno: () => 0,
    fm_parent_begin_capture: (_channel, _arena, sides, _count) => {
      sidesPointers.push(sides);
      return 0x2000;
    },
    fm_admit_activation: (at, len) => {
      codecPointers.push(at);
      // What the module would copy: the last byte of the staged admission.
      codecLastBytes.push(new Uint8Array(memory.buffer)[at + len - 1]);
      return 0;
    },
    fm_admission_buffer: (len) => {
      bufferRequests.push(len);
      return SCRATCH_BASE;
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
    label: "staging scratch harness",
  });
  return { backend, memory, sidesPointers, codecPointers, codecLastBytes, bufferRequests };
}

/** The constructor's `instance` field, which this file only ever stands in for. */
type ForkModuleContinuationBackendInstance = ConstructorParameters<
  typeof ForkModuleContinuationBackend
>[0]["instance"];

const SIDES: readonly number[] = [1, 2, 3];

/**
 * A guest module whose one fork section is `length` bytes, so its admission
 * stages exactly `64 + 12 + length`: the header and one section ref.
 */
function guest(length: number, fill: number): WebAssembly.Module {
  const name = new TextEncoder().encode("kandelo.wpk_fork.gc_codec");
  const uleb = (value: number): number[] => {
    const out: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      out.push(byte);
    } while (value !== 0);
    return out;
  };
  const body = [...uleb(name.length), ...name, ...new Array<number>(length).fill(fill)];
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, ...uleb(body.length), ...body,
  ]));
}

const TEMPLATE = new Uint8Array(32);

describe("staging slab as a per-call scratch", () => {
  it("places every stage at the slab's base, forks and seeds alike", () => {
    const { backend, sidesPointers, codecPointers } = harness();
    const codec = guest(128, 0xab);
    for (let fork = 0; fork < 32; fork += 1) {
      backend.parentBeginCapture(0, 0, SIDES);
      // A dlopen between forks: an admission the old cursor had to keep clear of.
      backend.admitActivation(4 + fork, codec, TEMPLATE);
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
    // 24 bytes of side pairs and a 204-byte admission per iteration: as a
    // cursor, the 8 KiB slab is gone in under forty.
    const codec = guest(128, 0xab);
    expect(() => {
      for (let fork = 0; fork < 2000; fork += 1) {
        backend.parentBeginCapture(0, 0, SIDES);
        backend.admitActivation(4 + fork, codec, TEMPLATE);
      }
    }).not.toThrow();
  });

  it("stages an admission larger than the slab in a buffer the module maps to its size", () => {
    // Exactly the slab's size still goes to the slab, with no buffer.
    const { backend, codecPointers, codecLastBytes, bufferRequests } = harness();
    const body = STAGING_BYTES - 76;
    backend.admitActivation(1, guest(body, 0x5c), TEMPLATE);
    expect(codecPointers).toEqual([STAGING_BASE]);
    expect(bufferRequests).toEqual([]);
    // One byte more asks the module for exactly that many bytes, and the
    // module sees the whole admission there.
    backend.admitActivation(2, guest(body + 1, 0x5d), TEMPLATE);
    expect(bufferRequests).toEqual([STAGING_BYTES + 1]);
    expect(codecPointers).toEqual([STAGING_BASE, SCRATCH_BASE]);
    expect(codecLastBytes).toEqual([0x5c, 0x5d]);
  });

  it("refuses a side list larger than the slab rather than truncating it", () => {
    // THE BOUNDARY, loud, for the one stage that has no mapping: a truncated
    // list would give the module the wrong activations.
    const { backend, sidesPointers } = harness();
    const tooMany = Array.from({ length: STAGING_BYTES / 8 + 1 }, (_, i) => i + 1);
    expect(() => backend.parentBeginCapture(0, 0, tooMany)).toThrow(
      /staging slab exhausted placing 1025 side activation\(s\) \(8200 bytes against a 8192-byte slab\)/,
    );
    expect(sidesPointers).toEqual([]);
  });
});
