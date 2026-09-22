import { describe, expect, it } from "vitest";

import { arenaFixture } from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * A resume slot is an index into the table a forked guest `call_indirect`s
 * through. One allocator hands them out, smallest freed slot first, and this
 * file is where the numbers it hands out are checked.
 *
 * THERE IS NO FREE LIST IN STORAGE. `resume_free_set` DERIVES the free set at
 * registration -- it walks the directory for every live activation's
 * `(ordinal, slot)` record, marks what those records name as taken, and throws
 * the scratch bitmap away when the call returns. Freeing a slot is the removal
 * of the activation's record, which the arena already does.
 *
 * Three shapes were tried before that one, and the third is not a preference.
 * A fixed `[u64; 1024]` in BSS cost 8 KiB on every fork-capable thread and had
 * an extent one slot narrower than the numbering it indexed. A chain of chunks
 * mapped on demand records the free set AT FREE -- and a `channel_mmap` from
 * the free path never returns when a vfork borrower has been killed by an
 * external fatal signal and the kernel has contained the address space, so the
 * whole program hangs rather than failing. See the note above
 * `RESUME_NEXT_SLOT` in the module for that measurement, and for what is still
 * open about the unmaps the free path does make.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT IS THE SLOT NUMBERS. A free list that
 * merely EXISTS is indistinguishable from one that works until someone reads
 * the slots out of it. That is measured, not argued: an earlier version of
 * these tests asserted the free list's STORAGE -- how much of it appeared and
 * disappeared -- and a perturbation that handed out `slot + 1_000_000` left
 * every one of those assertions green. The module happily kept a free list for
 * slots around 1,000,001, handed those numbers back, and tidied up after
 * itself perfectly. Only the numbers gave it away.
 *
 * So every assertion here goes through `fm_publish_resume_assignment`, which
 * is the reader the guest's own placement shim consumes: asserting these
 * numbers is asserting the numbers the thunks are actually placed at.
 *
 * Beside the numbers, this file asserts two things the numbers cannot show:
 * that a free MAPS nothing, and that a COW child inherits none of the parent's
 * numbering.
 */

/** The activations this file drives the bitmap with. */
const ACTIVATION_A = 21;
const ACTIVATION_B = 22;

describe("resume free-slot bitmap", () => {
  it("hands a freed slot back to the next activation, smallest first", () => {
    const x = arenaFixture("resume free bitmap");
    x.growResumeTable(8);

    // Three ordinals take slots 1, 2, 3 from RESUME_NEXT_SLOT.
    x.seedActivationCatalog(ACTIVATION_A, [10, 20, 30]);
    expect(x.errno(), "seeding activation A").toBe(0);
    expect(x.publishedSlots(ACTIVATION_A), "a fresh activation numbers from 1")
      .toEqual([1, 2, 3]);
    // ASCENDING BY ORDINAL, asserted rather than assumed. The store this
    // replaced compacted by SWAP-REMOVE, so an activation's entries came back
    // in an order that depended on the worker's `dlclose` history; a
    // per-activation record is written once in sorted order and has no
    // ordering to disturb. The published order is what the guest's placement
    // shim applies, and it has never been asserted anywhere.
    expect(
      x.publishedPairs(ACTIVATION_A),
      "the records are ascending by ordinal",
    ).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);

    // THE FREE PATH MAPS NOTHING, and this is the assertion that holds it to
    // that. Measured around the release alone: a release drops the
    // activation's record and its directory entry, both of which only UNMAP,
    // so any mmap between these two reads is a free path that started storing
    // something -- which is the shape that hangs a killed vfork borrower's
    // teardown. See the note above `RESUME_NEXT_SLOT` in the module.
    const mmapsBefore = x.mmaps();

    expect(x.slots(1, ACTIVATION_A, 0), "three slots freed").toBe(3);
    expect(
      x.mmaps() - mmapsBefore,
      "freeing a slot must map nothing",
    ).toBe(0);

    // THE ASSERTION THAT DISTINGUISHES A WORKING FREE LIST from a bitmap that
    // merely exists: seeding three more ordinals must consume the three freed
    // slots rather than growing three fresh ones. If it grew instead, these
    // would be 4, 5, 6.
    x.seedActivationCatalog(ACTIVATION_B, [11, 22, 33]);
    expect(x.errno(), "seeding activation B").toBe(0);
    expect(
      x.publishedSlots(ACTIVATION_B),
      "the reused slots are the freed ones, smallest first",
    ).toEqual([1, 2, 3]);

    // AND THE FREE SET COST NO STORAGE TO KEEP. It was rebuilt here, at
    // registration, from the live records -- on the bump heap, for the length
    // of this one call. Nothing persists between a free and its reuse, so
    // there is no chain to leak and no counter to scrub.
  });

  it("gives a COW child distinct slots rather than the parent's stale ones", () => {
    // `fm_set_format` is the COW-child scrub. It clears the bitmap AND resets
    // `RESUME_NEXT_SLOT` to 1, and the two together are why a stale bit is
    // worse than a wasted number: the allocator would hand out the stale bits
    // and then hand out those same numbers AGAIN as fresh ones. Two ordinals
    // would land on one thunk.
    const x = arenaFixture("resume free bitmap scrub");
    x.growResumeTable(8);
    x.seedActivationCatalog(ACTIVATION_A, [10, 20, 30]);
    expect(x.errno(), "seeding activation A").toBe(0);
    expect(x.slots(1, ACTIVATION_A, 0), "three slots freed into the bitmap").toBe(3);

    x.setFormat();

    x.seedActivationCatalog(ACTIVATION_B, [11, 22, 33, 44, 55]);
    expect(x.errno(), "seeding activation B in the child").toBe(0);
    const slots = x.publishedSlots(ACTIVATION_B);
    expect(slots, "the child numbers from 1 with nothing inherited").toEqual([
      1, 2, 3, 4, 5,
    ]);
    // Spelled out as well as compared: `toEqual` above would also catch this,
    // but a duplicate slot is the specific corruption at stake and a later
    // edit that loosens the comparison should not be able to lose it.
    expect(new Set(slots).size, "no slot is handed out twice").toBe(slots.length);
  });

  it("frees the highest slot the allocator can issue", () => {
    // THE OFF-BY-ONE THIS CAUGHT, and why it still runs now that the shape it
    // caught is gone. Slots number from 1 and registration accepted up to
    // `RESUME_SLOT_CAP` (65,536) LIVE ones, so the highest number the allocator
    // could hand out was 65,536 itself -- while the fixed bitmap, sized
    // `RESUME_SLOT_CAP.div_ceil(64)`, had an EXCLUSIVE extent of exactly
    // 65,536. That last slot was legitimately issued and then refused `ENOSPC`
    // when its activation tried to free it.
    //
    // WHAT THAT COST A RUNNING PROGRAM, which is why this is a test and not a
    // comment: `fm_resume_slots` op 1 turns the refusal into -1,
    // `host/src/fork-module-backend.ts` throws on a non-zero errno, and the
    // throw lands in `resumeTable.clear()` in the vfork child's exit teardown
    // -- before it posts its exit. A full-occupancy worker's child dies on the
    // way out, for a slot it was handed by this module's own allocator.
    //
    // Both the cap and the extent are gone now: there is no fixed table to
    // overrun and no stored bitmap to run past, so that off-by-one is
    // structurally unreachable rather than fixed. This case stays because the
    // BEHAVIOUR it pins is the thing that broke -- the highest slot the
    // allocator can issue round-trips through free and reuse -- and that is
    // asserted at full occupancy rather than against any constant. A test that
    // recomputed the extent from the cap agreed with the bug; a test that
    // drives 65,536 real slots cannot.
    const CAP = 65_536;
    const x = arenaFixture("resume free bitmap extent");
    // The release nulls STRICTLY, so the table must cover every slot about to
    // be freed -- slot CAP included, hence a length of CAP + 1.
    x.growResumeTable(CAP);

    const ordinals = Array.from({ length: CAP }, (_, i) => i);
    x.seedActivationCatalog(ACTIVATION_A, ordinals);
    expect(x.errno(), "seeding a full-occupancy catalog").toBe(0);

    // Every one of them, including slot CAP. Against the fixed bitmap this was
    // -1 with `fm_last_errno` == ENOSPC (28).
    expect(
      x.slots(1, ACTIVATION_A, 0),
      "every issued slot is freeable, including the highest",
    ).toBe(CAP);
    expect(x.errno(), "no slot the allocator issued is unfreeable").toBe(0);

    // AND IT REALLY WENT BACK. A release that reported success while dropping
    // the top slot would leave the next activation numbering from CAP + 1, so
    // the reuse is what distinguishes "freed" from "claimed to free".
    x.seedActivationCatalog(ACTIVATION_B, [7]);
    expect(x.errno(), "seeding activation B").toBe(0);
    expect(
      x.publishedSlots(ACTIVATION_B),
      "the freed slots come back smallest-first, from 1",
    ).toEqual([1]);
  });

  it("frees nothing when an activation holds no slots", () => {
    // A release of an activation with no record must answer the zero-freed
    // SUCCESS it is, not an error. "Never registered" and "registered, holding
    // nothing" are the same answer on this path deliberately: reading the
    // second as an error once cost a real fork, when a side module with no
    // fork-instrumented function seeded an EMPTY resume catalog.
    //
    // The REFUSAL half -- `resume_unregister_impl`'s watermark bound, the only
    // place that notices a caller reaching the module after its memory has been
    // freed -- cannot be reached through any `fm_*` entry, because every slot it
    // sees came out of a record this module wrote. It is proven by perturbing
    // the writer to store `slot + 4`, a number inside the resume table but above
    // the watermark: the release then returns -1 with `fm_last_errno` 22.
    // (`slot + 1_000_000` does NOT prove it -- the strict nulling pass traps on
    // a table index that far out before the bound is ever consulted.)
    const x = arenaFixture("resume free set bound");
    expect(x.slots(1, 99, 0), "an activation holding no slots frees none").toBe(0);
    expect(x.errno(), "zero slots is a success, not an error").toBe(0);
  });
});
