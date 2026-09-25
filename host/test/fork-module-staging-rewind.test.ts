// The staging slab is a PER-CALL scratch: every stage lands at its base. An
// admission -- the only thing a host stages since lane F stage 1d took the
// side-activation list out of the capture and child seeds -- that the slab
// cannot hold goes to a buffer the module maps to its size
// (`fm_admission_buffer`; its release is proven against the real module in
// `fork-module-admission.test.ts`).
//
// WHAT THIS REPLACED. This file used to assert a per-fork REWIND: the slab was
// a bump cursor, because the module kept the POINTER to every durable seed
// (catalog, codec, section) and read it back at every later fork, so a seed
// had to stay put for the life of the worker and only the per-fork stages --
// `stageSides()` and the externref handover, both since deleted -- could be
// reused. The cursor never rewound over them, a long-lived forking program
// exhausted the slab in thousands of forks, and the fix was a mark taken at
// each fork and dropped by any durable stage above it.
//
// None of that survives the module copying its seeds. Catalogs, codecs and
// sections go into the module's own arena records, the template id into its
// own table, all during the entry that seeds them. So the slab holds ONE
// request at a time, the cursor is gone, and the things left to assert about
// `stage()` are the ones below.
//
// THE COPY ITSELF IS PROVEN ELSEWHERE, against the real module:
// `fork-arena-release.test.ts` admits codecs and sections over the same
// staging page and the module still answers from its own copies. A stand-in
// module cannot show that, which is why it is not re-asserted here.
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
  const codecPointers: number[] = [];
  const codecLastBytes: number[] = [];
  const bufferRequests: number[] = [];
  const exports: Record<string, (...args: number[]) => number> = {
    fm_last_errno: () => 0,
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
  return { backend, memory, codecPointers, codecLastBytes, bufferRequests };
}

/** The constructor's `instance` field, which this file only ever stands in for. */
type ForkModuleContinuationBackendInstance = ConstructorParameters<
  typeof ForkModuleContinuationBackend
>[0]["instance"];

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
  it("places every admission at the slab's base", () => {
    const { backend, codecPointers } = harness();
    const codec = guest(128, 0xab);
    for (let dlopen = 0; dlopen < 32; dlopen += 1) {
      backend.admitActivation(4 + dlopen, codec, TEMPLATE);
    }
    expect(codecPointers).toHaveLength(32);
    // Not merely "bounded": IDENTICAL. A cursor that grows by any amount per
    // call is the exhaustion this slab used to reach, and a slab large enough
    // to hide 32 calls would hide a leak too.
    expect(new Set(codecPointers)).toEqual(new Set([STAGING_BASE]));
  });

  it("does not exhaust the slab over more calls than it has room for", () => {
    const { backend } = harness();
    // A 204-byte admission per iteration: as a cursor, the 8 KiB slab is gone
    // in about forty.
    const codec = guest(128, 0xab);
    expect(() => {
      for (let dlopen = 0; dlopen < 2000; dlopen += 1) {
        backend.admitActivation(4 + dlopen, codec, TEMPLATE);
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
});
