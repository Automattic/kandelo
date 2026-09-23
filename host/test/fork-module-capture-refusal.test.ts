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
// sealed so the host's abort path can replay the parent.
//
// The end-to-end version, through a real process Worker, is
// `fork-host-externref-refusal.test.ts`.

import { describe, expect, it } from "vitest";
import {
  CHANNEL_BASE,
  DRIVE_SLOT_ABORT_BEGIN,
  DRIVE_SLOT_ABORT_END,
  PHASE_ABORT_REPLAY,
  PHASE_IDLE,
  PHASE_SEALED_PARENT,
  RETIRED_INTERN_KIND_EXTERNREF,
  fixture,
  openCapture,
  saveSlotThunk,
  voidSlotThunk,
  type Fixture,
} from "./fork-module-capture-fixture";

const EINVAL = 22;
const EOPNOTSUPP = 95;

/** Bind activation 0's abort-replay slots, which `openCapture` leaves unbound. */
function bindAbortSlots(f: Fixture): void {
  const base = (f.x.fm_drive_table_base as (a: number) => number)(0);
  f.instance.driveTable.set(base + DRIVE_SLOT_ABORT_BEGIN, saveSlotThunk(() => {}) as never);
  f.instance.driveTable.set(base + DRIVE_SLOT_ABORT_END, voidSlotThunk(() => {}) as never);
}

const phase = (f: Fixture): number => Number((f.x.fm_phase as () => number)());
const brokerEncode = (f: Fixture, slot: number): number =>
  (f.x.__wpk_fork_ref_gc_broker_encode as (s: number) => number)(slot);
const seal = (f: Fixture): void => {
  (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
};

describe("the fork module refuses a raw host externref at capture", () => {
  it("hands back a placeholder, latches EOPNOTSUPP, and refuses the seal", () => {
    const f = fixture();
    openCapture(f);

    const recipe = brokerEncode(f, 0);
    expect(recipe, "a real placeholder recipe, never -1").toBeGreaterThan(0);
    expect(f.errno(), "the call itself succeeds: the walk has no error path").toBe(0);
    // The guest publishes the live value at `recipe + 1` on its next
    // instruction, so that slot has to exist.
    expect(
      (f.x.__wpk_fork_ref_gc_transit as WebAssembly.Table).length,
    ).toBeGreaterThan(recipe + 1);

    seal(f);
    expect(f.errno(), "the seal reports the refusal, not a later EINVAL").toBe(
      EOPNOTSUPP,
    );
    // The journal sealed before the refusal was reported, so the parent's
    // committed frames are replayable: this is what lets the worker's abort
    // path make `fork()` return -EOPNOTSUPP instead of dying.
    expect(phase(f), "a refused capture is still a sealed parent").toBe(
      PHASE_SEALED_PARENT,
    );

    bindAbortSlots(f);
    (f.x.fm_parent_replay as (abort: number) => void)(1);
    expect(f.errno(), "the parent's abort replay runs").toBe(0);
    expect(phase(f)).toBe(PHASE_ABORT_REPLAY);
    (f.x.fm_parent_finish as (abort: number) => void)(1);
    expect(f.errno(), "and finishes").toBe(0);
    expect(phase(f)).toBe(PHASE_IDLE);
  });

  it("starts the next capture in the same worker with no refusal", () => {
    const f = fixture();
    openCapture(f);
    brokerEncode(f, 0);
    seal(f);
    expect(f.errno()).toBe(EOPNOTSUPP);
    bindAbortSlots(f);
    (f.x.fm_parent_replay as (abort: number) => void)(1);
    (f.x.fm_parent_finish as (abort: number) => void)(1);
    expect(phase(f)).toBe(PHASE_IDLE);

    // A refusal belongs to the capture that met the host object. Carried over,
    // it would refuse every later fork in this worker.
    openCapture(f);
    seal(f);
    expect(f.errno(), "a capture with no host object seals").toBe(0);
    expect(phase(f)).toBe(PHASE_SEALED_PARENT);
  });

  it("refuses the retired host-externref intern kind", () => {
    const f = fixture();
    openCapture(f);
    const intern = f.x.fm_capture_intern as (k: number, a: number, b: number) => number;
    // A well-formed broker handle, and still no recipe: nothing may name a
    // host externref in a capture graph.
    expect(intern(RETIRED_INTERN_KIND_EXTERNREF, 9, 0)).toBe(-1);
    expect(f.errno()).toBe(EINVAL);
  });
});
