// Constructor provenance inside the fork module: how a run of `array.new_data`
// is recorded, matched, and what happens when it cannot be.
//
// WHY RUNS ARE RECORDED AT ALL. A fork child rebuilds every GC object in a
// fresh instance, and an immutable array can only be rebuilt by re-running an
// allocation instruction (Wasm cannot fill one after allocation). For
// `array.new_data` the operands -- a segment offset -- are not visible in the
// array, and the parent may have dropped the segment, so each DISTINCT run
// `(activation, layout, operands)` is recorded where it happens, keeping the
// hash of the contents its first array had. A capture matches an array to a
// run by that hash. docs/fork-reference-support.md, "Constructor provenance",
// gives the whole argument; these tests pin its four promises:
//
//   * an array is matched to the run that made it, and to no other;
//   * the module keeps NO array alive (no witness is pinned);
//   * when the table cannot grow, recording stops, allocation carries on, and
//     a later fork that meets an array it cannot match is refused with
//     EOPNOTSUPP;
//   * a run recorded before that point still matches.
//
// The guest end to end is `fork-gc-provenance.test.ts`.

import { describe, expect, it } from "vitest";
import {
  CHANNEL_BASE,
  DRIVE_SLOT_ABORT_BEGIN,
  DRIVE_SLOT_ABORT_END,
  MMAP_FAIL_SWITCH,
  PHASE_ABORT_REPLAY,
  PHASE_SEALED_PARENT,
  admitActivation,
  driveBase,
  fixture,
  openCapture,
  saveSlotThunk,
  voidSlotThunk,
  type Fixture,
} from "./fork-module-capture-fixture";

const EOPNOTSUPP = 95;
/** Bit 1 of a provenance token: "send me this run's contents". */
const WANTS_CONTENTS = 2;
const SIDE = 1;

/** An immutable `array i8` type: its generic base layout (1) and one
 *  `array.new_data` layout reading segment 0 (2). Nothing else can build it. */
function dataOnlyCodec(): Uint8Array {
  const layouts = [
    // [id, constructor, fieldStart, provenanceScalarLength]
    [1, 1, 0, 0],
    [2, 5, 1, 8],
  ] as const;
  const bytes = new Uint8Array(16 + layouts.length * 44 + layouts.length * 12);
  const view = new DataView(bytes.buffer);
  bytes.set([75, 70, 71, 67]); // "KFGC"
  view.setUint16(4, 1, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, layouts.length, true);
  view.setUint32(12, layouts.length, true);
  layouts.forEach(([id, constructor, fieldStart, provenanceScalars], index) => {
    const at = 16 + index * 44;
    view.setUint32(at, id, true);
    view.setUint32(at + 4, 0, true); // type ordinal
    bytes[at + 8] = 2; // array
    bytes[at + 9] = constructor;
    view.setUint16(at + 10, 1, true); // REQUIRES_PROVENANCE: immutable
    view.setUint32(at + 12, 1, true); // i8 stride
    view.setUint32(at + 16, fieldStart, true);
    view.setUint32(at + 20, 1, true);
    view.setUint32(at + 24, 0xffffffff, true); // no supertype
    view.setUint32(at + 28, 1, true); // base layout
    view.setUint32(at + 32, 0, true); // segment ordinal
    view.setUint32(at + 36, provenanceScalars, true);
    view.setUint32(at + 40, 0, true);
  });
  for (let index = 0; index < layouts.length; index++) {
    const at = 16 + layouts.length * 44 + index * 12;
    bytes[at] = 1; // i8, immutable, not a reference
    view.setUint32(at + 4, 0, true); // scalar offset
    view.setUint32(at + 8, 0xffffffff, true); // no reference ordinal
  }
  return bytes;
}

function rig(): Fixture {
  const f = fixture();
  expect(admitActivation(f, SIDE, { gcCodec: dataOnlyCodec() })).toBe(0);
  return f;
}

/** One run of `array.new_data $seg offset bytes.length` whose array holds
 *  `bytes`, reported exactly as the instrumented wrapper does. Answers the
 *  token `begin` returned. */
function runArrayNewData(f: Fixture, offset: number, bytes: readonly number[]): number {
  const begin = f.x.__wpk_fork_ref_gc_provenance_begin as (
    ...args: [number, number, number, number, bigint, bigint, number]
  ) => number;
  const contents = f.x.__wpk_fork_ref_gc_provenance_contents as (t: number, b: bigint) => void;
  const end = f.x.__wpk_fork_ref_gc_provenance_end as (t: number) => void;
  const operands = BigInt(offset) | (BigInt(bytes.length) << 32n);
  const token = begin(0, SIDE, 1, 2, operands, 0n, 0);
  expect(token, `begin errno=${f.errno()}`).toBeGreaterThan(0);
  if (token & WANTS_CONTENTS) {
    for (const byte of bytes) contents(token, BigInt(byte));
  }
  end(token);
  expect(f.errno(), "a run never fails the allocation").toBe(0);
  return token;
}

/** Capture one array of `bytes` under the base layout, as the guest codec
 *  defines it, then seal; answers the seal's errno. */
function captureAndSeal(f: Fixture, arrays: readonly (readonly number[])[]): number {
  openCapture(f);
  const transit = f.x.__wpk_fork_ref_gc_transit as WebAssembly.Table;
  const reserve = f.x.__wpk_fork_ref_scratch_reserve as (len: number) => number;
  const release = f.x.__wpk_fork_ref_scratch_release as (ptr: number, len: number) => void;
  for (const bytes of arrays) {
    transit.set(0, {});
    const recipe = (f.x.__wpk_fork_ref_gc_claim as (slot: number) => number)(0);
    expect(recipe, `claim errno=${f.errno()}`).toBeGreaterThan(0);
    const staging = reserve(4 + bytes.length);
    const view = new DataView(f.memory.buffer);
    view.setUint32(staging, bytes.length, true);
    bytes.forEach((value, index) => view.setUint8(staging + 4 + index, value));
    (f.x.__wpk_fork_ref_gc_define as (...args: number[]) => void)(
      recipe, SIDE, 0, 1, 2, staging, 4 + bytes.length, 0,
    );
    expect(f.errno(), "define itself succeeds: the walk has no error path").toBe(0);
    release(staging, 4 + bytes.length);
    transit.set(0, null);
  }
  // A refused seal abort-replays the parent in the module, which drives these.
  const base = driveBase(0);
  f.instance.driveTable.set(base + DRIVE_SLOT_ABORT_BEGIN, saveSlotThunk(() => {}) as never);
  f.instance.driveTable.set(base + DRIVE_SLOT_ABORT_END, voidSlotThunk(() => {}) as never);
  (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
  const errno = f.errno();
  expect((f.x.fm_phase as () => number)(), "sealed, or abort-replaying a refusal").toBe(
    errno === 0 ? PHASE_SEALED_PARENT : PHASE_ABORT_REPLAY,
  );
  return errno;
}

const setFailSwitch = (f: Fixture, on: boolean): void => {
  new DataView(f.memory.buffer).setUint32(MMAP_FAIL_SWITCH, on ? 1 : 0, true);
};

describe("recorded runs of array.new_data", () => {
  it("asks for a run's contents once, and matches an array to the run that made it", () => {
    const f = rig();
    expect(runArrayNewData(f, 0, [1, 2, 3]) & WANTS_CONTENTS, "first run").toBe(WANTS_CONTENTS);
    // Same operands, same immutable segment: same contents. Nothing new.
    expect(runArrayNewData(f, 0, [1, 2, 3]) & WANTS_CONTENTS, "repeat run").toBe(0);
    expect(runArrayNewData(f, 5, [1, 2, 4]) & WANTS_CONTENTS, "other operands").toBe(
      WANTS_CONTENTS,
    );
    expect(captureAndSeal(f, [[1, 2, 3], [1, 2, 4], [1, 2, 3]])).toBe(0);
  });

  it("never matches an array to a run whose contents differ", () => {
    // Same type, same length, one recorded run: only `array.new_data` could
    // have made [1, 2, 5], and no run recorded made it. A match by length
    // alone would rebuild [1, 2, 3] in the child.
    const f = rig();
    runArrayNewData(f, 0, [1, 2, 3]);
    expect(captureAndSeal(f, [[1, 2, 5]])).toBe(EOPNOTSUPP);
  });

  it("keeps no array alive", () => {
    // A kept array (a "witness") would pin the first array of every run for
    // the worker's life. The only reference table the module owns for
    // provenance is the seed-witness table, and runs put nothing in it.
    const f = rig();
    for (let offset = 0; offset < 64; offset++) runArrayNewData(f, offset, [offset, 1]);
    const witnesses = f.x.__wpk_fork_ref_gc_provenance_witness as WebAssembly.Table;
    expect(witnesses.length, "the seed-witness table does not grow").toBe(256);
    for (let slot = 0; slot < witnesses.length; slot++) {
      expect(witnesses.get(slot), `witness slot ${slot}`).toBeNull();
    }
    expect(
      (f.x.__wpk_fork_ref_gc_transit as WebAssembly.Table).get(0),
      "nor is the constructed array left staged",
    ).toBeNull();
  });
});

describe("when the run table cannot grow", () => {
  it("stops recording, keeps allocating, and refuses a fork it cannot rebuild", () => {
    const f = rig();
    setFailSwitch(f, true);
    // The first run needs the table's first mapping, which fails. The
    // allocation is unaffected: a token, no contents wanted, no errno.
    expect(runArrayNewData(f, 0, [1, 2, 3]) & WANTS_CONTENTS).toBe(0);
    setFailSwitch(f, false);
    // Sticky: a mapping that would now succeed does not restart recording,
    // because the records would then describe only some of the runs.
    expect(runArrayNewData(f, 7, [9, 9, 9]) & WANTS_CONTENTS).toBe(0);
    expect(captureAndSeal(f, [[1, 2, 3]]), "an unrecorded run is refused").toBe(EOPNOTSUPP);
  });

  it("still matches the runs it recorded before it stopped", () => {
    const f = rig();
    runArrayNewData(f, 0, [1, 2, 3]);
    // Fill the first mapping to the doubling point (half of 256 entries),
    // then fail the doubling.
    for (let offset = 1; offset < 128; offset++) runArrayNewData(f, offset, [offset]);
    setFailSwitch(f, true);
    expect(runArrayNewData(f, 500, [7, 7]) & WANTS_CONTENTS, "growth failed").toBe(0);
    setFailSwitch(f, false);
    expect(captureAndSeal(f, [[1, 2, 3]]), "a recorded run still matches").toBe(0);
  });
});

// `array.new_elem` on an engine that does not give a segment's items one
// identity. JavaScriptCore evaluates an allocating element item afresh at
// every use, so the elements a capture meets are not the static roots the GC
// codec lists for the segment, and there is nothing to compare them with. The
// module then gives the array the ONLY recorded run that could have made it
// (every other constructor having been tried first), and refuses the fork when
// there is more than one.
describe("recorded runs of array.new_elem, when elements cannot be compared", () => {
  /** An immutable `array (ref $item)`: its generic base (1) and one
   *  `array.new_elem` layout (2) reading segment 0, which the descriptor
   *  lists as two static roots. */
  function elemCodec(): Uint8Array {
    const layouts = [
      [1, 1, 0, 0],
      [2, 6, 1, 8],
    ] as const;
    const table = [1, 0, 2, 2, 0, 2, 1]; // one segment: ordinal 0, roots 0 and 1
    const bytes = new Uint8Array(16 + layouts.length * 44 + layouts.length * 12 + table.length * 4);
    const view = new DataView(bytes.buffer);
    bytes.set([75, 70, 71, 67]); // "KFGC"
    view.setUint16(4, 1, true);
    view.setUint16(6, 16, true);
    view.setUint32(8, layouts.length, true);
    view.setUint32(12, layouts.length, true);
    layouts.forEach(([id, constructor, fieldStart, provenanceScalars], index) => {
      const at = 16 + index * 44;
      view.setUint32(at, id, true);
      bytes[at + 8] = 2; // array
      bytes[at + 9] = constructor;
      view.setUint16(at + 10, 1, true); // REQUIRES_PROVENANCE: immutable
      view.setUint32(at + 12, 0, true); // reference stride
      view.setUint32(at + 16, fieldStart, true);
      view.setUint32(at + 20, 1, true);
      view.setUint32(at + 24, 0xffffffff, true);
      view.setUint32(at + 28, 1, true);
      view.setUint32(at + 32, 0, true); // segment ordinal
      view.setUint32(at + 36, provenanceScalars, true);
    });
    for (let index = 0; index < layouts.length; index++) {
      const at = 16 + layouts.length * 44 + index * 12;
      bytes[at] = 8; // reference
      bytes[at + 1] = 4; // REFERENCE (immutable, non-null)
      view.setUint32(at + 4, 0xffffffff, true);
      view.setUint32(at + 8, 0, true);
    }
    table.forEach((word, index) =>
      view.setUint32(16 + layouts.length * 44 + layouts.length * 12 + index * 4, word, true),
    );
    return bytes;
  }

  function recordElemRun(f: Fixture, offset: number, length: number): void {
    const begin = f.x.__wpk_fork_ref_gc_provenance_begin as (
      ...args: [number, number, number, number, bigint, bigint, number]
    ) => number;
    const token = begin(0, SIDE, 1, 2, BigInt(offset) | (BigInt(length) << 32n), 0n, 0);
    expect(token & WANTS_CONTENTS, "an element run sends no contents").toBe(0);
    (f.x.__wpk_fork_ref_gc_provenance_end as (t: number) => void)(token);
    expect(f.errno()).toBe(0);
  }

  /** Capture a two-element array whose elements are fresh structs, as a
   *  capture meets them on JavaScriptCore, then seal; answers the errno. */
  function captureFreshElements(f: Fixture): number {
    openCapture(f);
    const transit = f.x.__wpk_fork_ref_gc_transit as WebAssembly.Table;
    const claim = f.x.__wpk_fork_ref_gc_claim as (slot: number) => number;
    const define = f.x.__wpk_fork_ref_gc_define as (...args: number[]) => void;
    const elements = [0, 1].map(() => {
      transit.set(0, {});
      const recipe = claim(0);
      define(recipe, SIDE, 0, 1, 1, 0, 0, 0); // a struct with no fields
      transit.set(0, null);
      return recipe;
    });
    const handle = (f.x.__wpk_fork_ref_vector_begin as (n: number) => number)(2);
    for (const recipe of elements) {
      (f.x.__wpk_fork_ref_vector_append as (h: number, r: number) => void)(handle, recipe);
    }
    const vector = (f.x.__wpk_fork_ref_vector_finish as (h: number) => number)(handle);
    transit.set(0, {});
    const array = claim(0);
    const reserve = f.x.__wpk_fork_ref_scratch_reserve as (len: number) => number;
    const staging = reserve(4);
    new DataView(f.memory.buffer).setUint32(staging, 2, true);
    define(array, SIDE, 0, 1, 2, staging, 4, vector);
    expect(f.errno(), "define itself succeeds").toBe(0);
    (f.x.__wpk_fork_ref_scratch_release as (p: number, l: number) => void)(staging, 4);
    transit.set(0, null);
    const base = driveBase(0);
    f.instance.driveTable.set(base + DRIVE_SLOT_ABORT_BEGIN, saveSlotThunk(() => {}) as never);
    f.instance.driveTable.set(base + DRIVE_SLOT_ABORT_END, voidSlotThunk(() => {}) as never);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    return f.errno();
  }

  function elemRig(): Fixture {
    const f = fixture();
    expect(admitActivation(f, SIDE, { gcCodec: elemCodec() })).toBe(0);
    return f;
  }

  it("rebuilds from the only recorded run of that length", () => {
    const f = elemRig();
    recordElemRun(f, 0, 2);
    recordElemRun(f, 0, 2); // the same run again: still one
    recordElemRun(f, 0, 1); // another length: not a candidate
    expect(captureFreshElements(f)).toBe(0);
  });

  it("refuses when two recorded runs could have made it", () => {
    const f = elemRig();
    recordElemRun(f, 0, 2);
    recordElemRun(f, 1, 1);
    recordElemRun(f, 0, 1);
    recordElemRun(f, 5, 2); // a second two-element run
    expect(captureFreshElements(f)).toBe(EOPNOTSUPP);
  });

  it("refuses when no run was recorded", () => {
    const f = elemRig();
    expect(captureFreshElements(f)).toBe(EOPNOTSUPP);
  });
});
