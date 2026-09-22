import { describe, expect, it } from "vitest";

import {
  RESUME_FREE_CHUNK_COUNT_FIELD,
  arenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * The resume free-slot bitmap is indexed BY SLOT NUMBER, and the guard that
 * kept an out-of-range slot from corrupting it compared against
 * `RESUME_SLOT_CAP` -- a capacity that happens to sit nearby, not a statement
 * about which slots exist. Worse, it SKIPPED rather than refused.
 *
 * WHAT GOES WRONG WITHOUT THIS TEST: a freed slot past the bitmap's extent is
 * silently not freed. The slot leaks, later numbering drifts, and the module
 * and the guest's resume table place thunks by different rules -- which is a
 * wrong `call_indirect` target, not a trap. The cap is scheduled for deletion,
 * at which point that guard has nothing left to compare against at all.
 *
 * So a slot the bitmap cannot represent is now a loud `ENOSPC` instead of a
 * skip, and slot 0 -- the reserved sentinel -- is a loud `EINVAL`. The tighter
 * bound that reads as though it must also hold, `slot >= RESUME_NEXT_SLOT`,
 * was tried, reverted as "measured false in production", and is BACK: what it
 * caught was real. A vfork child had freed the module's region and kept
 * calling through it, so the watermark it read was a zeroed page rather than a
 * number any writer produces. See the note on `free_bits_mark` in the module.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT IS THE SLOT NUMBERS. A free list that
 * merely EXISTS is indistinguishable from one that works until someone reads
 * the slots out of it. That is measured, not argued: an earlier version of
 * these tests asserted the free list's STORAGE -- how much of it appeared and
 * disappeared -- and a perturbation that freed `slot + 1_000_000` with the
 * bound removed left every one of those assertions green. The module happily
 * kept a free list for slots around 1,000,001, handed those numbers back, and
 * tidied up after itself perfectly. Only the numbers gave it away.
 *
 * So every assertion here goes through `fm_publish_resume_assignment`, which
 * is the reader the guest's own placement shim consumes: asserting these
 * numbers is asserting the numbers the thunks are actually placed at.
 *
 * THE BITMAP IS NOW CHUNKS MAPPED ON DEMAND, not fixed BSS. It was converted
 * once and reverted, on a measurement that the free path could never issue a
 * channel syscall because a vfork child's exit teardown reaches it while the
 * parent is parked on the shared channel. That was refuted afterwards: the
 * SIGSEGV was the host use-after-free above, and with it fixed the same
 * conversion, rebuilt to the same build key, frees from a vfork child's
 * teardown and the guest exits 0. See the note on `FREE_BITS_HEAD` in the
 * module.
 *
 * So the chunk lifecycle is asserted here BESIDE the slot numbers: a chain
 * that maps a chunk and never returns it is a leak the numbers cannot see, and
 * a chunk count alone is blind to a wrong slot NUMBER, which is how an earlier
 * version of these tests stayed green while the module handed out slots around
 * 1,000,001.
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

    // MEASURED AROUND THE FREE ALONE, and the scoping is deliberate: the
    // mmap/munmap tallies are the RESPONDER's, so the record arena shares them.
    // A release MAPS nothing -- `arena_unlink_record`, the chunk sweep and
    // `arena_release_activation` only unmap -- so every mmap between these two
    // reads is the bitmap's, and the number is exact rather than a floor.
    const mmapsBefore = x.mmaps();

    expect(x.slots(1, ACTIVATION_A, 0), "three slots freed").toBe(3);
    expect(
      x.stats(RESUME_FREE_CHUNK_COUNT_FIELD),
      "the free mapped a chunk to record itself in",
    ).toBe(1);
    expect(x.mmaps() - mmapsBefore, "exactly one, and only for the bitmap").toBe(1);

    // And around the REUSE alone, for the same reason in the other direction:
    // a registration allocates (two arena chunks here) but unmaps nothing, so
    // every munmap between these two reads is the bitmap's.
    const munmapsBefore = x.munmaps();

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

    // AND THE CHUNK IT TOOK WENT BACK. The reuse emptied the chunk the free
    // mapped, and an emptied chunk is unlinked and unmapped rather than held
    // for the next free -- otherwise the steady state of a process that frees
    // once and never again is one permanently mapped 64 KiB chunk, which is the
    // fixed reservation this conversion removes.
    //
    // BOTH HALVES. The chunk COUNT is list membership, blind to a chunk that
    // was unlinked but never unmapped, because `channel_munmap` is best-effort
    // by design. The munmap tally sees exactly that case and nothing else.
    expect(
      x.stats(RESUME_FREE_CHUNK_COUNT_FIELD),
      "the reuse emptied the chunk and handed it back",
    ).toBe(0);
    expect(
      x.munmaps() - munmapsBefore,
      "and unmapped it rather than unlinking it and keeping the mapping",
    ).toBe(1);
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

    const munmapsBefore = x.munmaps();
    const held = x.stats(RESUME_FREE_CHUNK_COUNT_FIELD);
    expect(held, "the free left a chunk for the scrub to return").toBe(1);

    x.setFormat();

    // THE CHUNKS GO BACK, and this is the half a cleared root cannot show. The
    // `.fill(0)` this chain replaced was BSS a COW child could simply
    // overwrite; a chain of MAPPINGS is inherited through the memory clone, so
    // clearing the root alone leaks every chunk the parent took -- INVISIBLY,
    // because the count walks the chain and a cleared root reads as empty.
    expect(
      x.stats(RESUME_FREE_CHUNK_COUNT_FIELD),
      "the scrub emptied the chain",
    ).toBe(0);
    expect(
      x.munmaps() - munmapsBefore,
      "one unmap per chunk the scrub released",
    ).toBeGreaterThanOrEqual(held);

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
    // THE OFF-BY-ONE THIS CATCHES. Slots are numbered from 1 and
    // `resume_register_impl` accepts up to `RESUME_SLOT_CAP` (65,536) live
    // ones, so the highest number the allocator can hand out is 65,536
    // itself. The bitmap was sized `RESUME_SLOT_CAP.div_ceil(64)`, making its
    // EXCLUSIVE extent exactly 65,536 -- so that last slot was legitimately
    // issued and then refused `ENOSPC` when its activation tried to free it.
    //
    // WHAT THAT COST A RUNNING PROGRAM, which is why this is a test and not a
    // comment: `fm_resume_slots` op 1 turns the refusal into -1,
    // `host/src/fork-module-backend.ts` throws on a non-zero errno, and the
    // throw lands in `resumeTable.clear()` in the vfork child's exit teardown
    // -- before it posts its exit. A full-occupancy worker's child dies on the
    // way out, for a slot it was handed by this module's own allocator.
    //
    // Asserted at full occupancy rather than against the constants, because
    // the constants are what is wrong: a test that recomputed the extent from
    // `RESUME_SLOT_CAP` would agree with the bug. The module carries the
    // build-time half (a `const _: () = assert!` on the two constants); this
    // is the half that proves the highest issuable slot really round-trips.
    const CAP = 65_536;
    const x = arenaFixture("resume free bitmap extent");
    // The release nulls STRICTLY, so the table must cover every slot about to
    // be freed -- slot CAP included, hence a length of CAP + 1.
    x.growResumeTable(CAP);

    const ordinals = Array.from({ length: CAP }, (_, i) => i);
    x.seedActivationCatalog(ACTIVATION_A, ordinals);
    expect(x.errno(), "seeding a full-occupancy catalog").toBe(0);

    // Every one of them, including slot CAP. Before the fix this was -1 with
    // `fm_last_errno` == ENOSPC (28).
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

  it("marks nothing when an activation holds no slots", () => {
    // Slot 0 is the reserved "no event" sentinel and is never handed out, so a
    // release of an activation holding no slots must mark nothing -- and must
    // do so as the zero-freed SUCCESS it is, not as an error.
    //
    // The refusal half of the bound cannot be reached through any `fm_*` entry:
    // `free_bits_mark` is called only from `resume_unregister_impl`, with slots
    // that came out of the resume index. It is proven by perturbing that caller
    // to free `slot + 1_000_000`, where the release returns -1 and
    // `fm_last_errno` is ENOSPC (28) -- the slot is past the bitmap's extent.
    // Under the old guard that free was silently dropped and the release still
    // reported success.
    const x = arenaFixture("resume free bitmap bound");
    expect(x.slots(1, 99, 0), "an activation holding no slots frees none").toBe(0);
    expect(x.errno(), "zero slots is a success, not an error").toBe(0);
  });
});
