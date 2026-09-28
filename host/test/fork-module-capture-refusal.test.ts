// Externref stage E2, inside the fork module: a capture that meets a raw HOST
// externref is refused with EOPNOTSUPP -- and the refusal leaves the parent
// able to replay, and the next capture in the worker clean.
//
// HOW THE GUEST GETS HERE. `fork-instrument`'s generated
// `__wpk_fork_ref_encode_externref` converts the value with `any.convert_extern`
// and tries the program's own GC layouts; a value no layout claims -- a host
// object, which has no type to test -- reaches
// `__wpk_fork_ref_gc_broker_encode`. (An `extern.convert_any` view of the
// program's own GC object is claimed by its layout and never gets here.) With
// no activation's codec claiming it, the broker's fall-through is the refusal.
//
// WHY A PLACEHOLDER AND A LATCH, NOT `-1`. The save walk is the guest's own
// generated code and has no error path. A `-1` would be published into transit
// slot 0, which the guest clears straight after, so the parent's own abort
// replay would read back NULL where its object was. The module instead hands
// back a real placeholder recipe -- the guest publishes the LIVE value beside
// it -- and latches the errno for the seal, which fails once the journal is
// sealed, and the module abort-replays the parent itself (its run loop,
// `fm_run`, since lane F step 3c): `fork()` returns -EOPNOTSUPP.
//
// The end-to-end version, through a real process Worker, is
// `fork-host-externref-refusal.test.ts`.

import { describe, expect, it } from "vitest";
import {
  ABORT_CAUSE_SEAL,
  DEFAULT_CHILD_PID,
  DIAGNOSTIC_ABORTED,
  admitActivation,
  fixture,
  runFork,
  type Fixture,
} from "./fork-module-capture-fixture";

const EOPNOTSUPP = 95;

const brokerEncode = (f: Fixture, slot: number): number =>
  (f.x.__wpk_fork_ref_gc_broker_encode as (s: number) => number)(slot);
/** What the module reports for a capture its seal refused. */
const refusedAtSeal = {
  kind: DIAGNOSTIC_ABORTED,
  values: [EOPNOTSUPP, ABORT_CAUSE_SEAL, 0, 0, 0],
};

describe("the fork module refuses a raw host externref at capture", () => {
  it("hands back a placeholder, latches EOPNOTSUPP, and refuses the seal", () => {
    const f = fixture();
    let recipe = -1;
    let errno = -1;
    let transitLength = 0;
    const run = runFork(f, {
      duringCapture: () => {
        recipe = brokerEncode(f, 0);
        errno = f.errno();
        transitLength = (f.x.__wpk_fork_ref_gc_transit as WebAssembly.Table).length;
      },
    });
    expect(recipe, "a real placeholder recipe, never -1").toBeGreaterThan(0);
    expect(errno, "the call itself succeeds: the walk has no error path").toBe(0);
    // The guest publishes the live value at `recipe + 1` on its next
    // instruction, so that slot has to exist.
    expect(transitLength).toBeGreaterThan(recipe + 1);
    // The journal sealed before the refusal was reported, so the parent's
    // committed frames are replayable, and the module abort-replays them
    // itself: this is what makes `fork()` return -EOPNOTSUPP instead of the
    // worker dying -- and the refusal, not a later EINVAL, is what it reports.
    expect(run.forkReturn, "fork() returns the refusal").toBe(-EOPNOTSUPP);
    expect(run.forkCalls, "and no child was asked for").toBe(0);
    expect(run.diagnostics, "with the seal's cause").toContainEqual(refusedAtSeal);
  });

  it("starts the next capture in the same worker with no refusal", () => {
    const f = fixture();
    const refused = runFork(f, { duringCapture: () => void brokerEncode(f, 0) });
    expect(refused.forkReturn).toBe(-EOPNOTSUPP);

    // A refusal belongs to the capture that met the host object. Carried over,
    // it would refuse every later fork in this worker.
    const next = runFork(f);
    expect(next.forkReturn, "a capture with no host object seals and forks").toBe(
      DEFAULT_CHILD_PID,
    );
    expect(next.diagnostics).not.toContainEqual(refusedAtSeal);
  });
});

// Constructor provenance, inside the fork module: an immutable array that no
// constructor in the program can rebuild -- here, one only `array.new_data`
// could have made, with no recorded run of it -- refuses the capture with
// EOPNOTSUPP rather than defining a node the child's allocator would trap on.
// The same array with contents a derivable constructor reproduces
// (`array.new_default`) seals cleanly. See docs/fork-reference-support.md,
// "Constructor provenance"; the success path end to end is
// `fork-gc-provenance.test.ts`.
describe("the fork module refuses an array no constructor can rebuild", () => {
  /** Immutable `array i8`: its generic base (1), `array.new_data` of segment
   *  0 (2) and `array.new_default` (3). */
  function immutableBytesCodec(): Uint8Array {
    const layouts = [
      // [id, constructor, fieldStart, provenanceScalarLength]
      [1, 1, 0, 0],
      [2, 5, 1, 8],
      [3, 3, 2, 0],
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

  const SIDE = 1;

  /** Claim a GC recipe for a stand-in object and define it as a 3-element
   *  `array i8` of `elements` under activation `SIDE`'s base layout. */
  function defineArray(f: Fixture, elements: readonly number[]): void {
    const transit = f.x.__wpk_fork_ref_gc_transit as WebAssembly.Table;
    transit.set(0, {});
    const recipe = (f.x.__wpk_fork_ref_gc_claim as (slot: number) => number)(0);
    expect(recipe, `claim errno=${f.errno()}`).toBeGreaterThan(0);
    const reserve = f.x.__wpk_fork_ref_scratch_reserve as (len: number) => number;
    const release = f.x.__wpk_fork_ref_scratch_release as (ptr: number, len: number) => void;
    const staging = reserve(4 + elements.length);
    const view = new DataView(f.memory.buffer);
    view.setUint32(staging, elements.length, true);
    elements.forEach((value, index) => view.setUint8(staging + 4 + index, value));
    (f.x.__wpk_fork_ref_gc_define as (...args: number[]) => void)(
      recipe, SIDE, 0, 1, 2, staging, 4 + elements.length, 0,
    );
    expect(f.errno(), "define itself succeeds: the walk has no error path").toBe(0);
    release(staging, 4 + elements.length);
    transit.set(0, null);
  }

  it("latches EOPNOTSUPP for contents only an unrecorded segment read made", () => {
    const f = fixture();
    expect(admitActivation(f, SIDE, { gcCodec: immutableBytesCodec() })).toBe(0);
    const run = runFork(f, { duringCapture: () => defineArray(f, [1, 2, 3]) });
    // Since the parent lifecycle folded into the module (lane F 1i), a
    // refused seal starts the abort replay itself, exactly as the host-object
    // refusal above does: the parent's committed frames replay and `fork()`
    // returns -EOPNOTSUPP.
    expect(run.forkReturn, "the seal reports the refusal").toBe(-EOPNOTSUPP);
    expect(run.diagnostics, "with the seal's cause").toContainEqual(refusedAtSeal);
  });

  it("seals when a constructor the program has reproduces the contents", () => {
    const f = fixture();
    expect(admitActivation(f, SIDE, { gcCodec: immutableBytesCodec() })).toBe(0);
    // All default: `array.new_default` rebuilds it, so nothing is refused.
    const run = runFork(f, { duringCapture: () => defineArray(f, [0, 0, 0]) });
    expect(run.forkReturn, "an array the program's constructors rebuild seals").toBe(
      DEFAULT_CHILD_PID,
    );
  });
});
