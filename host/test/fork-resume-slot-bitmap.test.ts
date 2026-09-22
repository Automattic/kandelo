import { describe, expect, it } from "vitest";

import { arenaFixture } from "./fork-module-capture-fixture";

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
 * was tried and MEASURED FALSE in production: see the note on `free_bits_mark`
 * in the module, and this task's report.
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
 * WHY THE BITMAP IS STILL FIXED BSS. It was converted to chunks mapped on
 * demand and reverted. Mapping issues a channel syscall, and this free path is
 * reached from the vfork CHILD'S EXIT TEARDOWN while the parent is parked
 * inside its own vfork syscall on the channel the borrowed child shares --
 * SIGSEGV, bisected to the bare syscall rather than to the chunk. See the note
 * on `RESUME_FREE_WORDS` in the module and the handoff in this task's report.
 */

/** The activations this file drives the bitmap with. */
const ACTIVATION_A = 21;
const ACTIVATION_B = 22;

/**
 * Stand in for the guest that normally fills the resume table.
 *
 * `fm_resume_slots` op 1 is the `dlclose` release, and its first pass nulls
 * every one of the activation's table entries with a STRICT `table.set` --
 * strict because a `dlclose` of a registered activation means the thunks were
 * placed, so a slot the table does not have is a real inconsistency and traps
 * rather than being skipped. The module's `__wpk_fork_resume_table` starts at
 * length 1 (slot 0 is the reserved sentinel) and is grown by the guest's
 * `__wpk_fork_place_resume_thunks` shim, which a bare module fixture has none
 * of: the release traps with "table index is out of bounds" before it reaches
 * the bitmap at all.
 *
 * So the table is grown here, to the length the guest would have given it.
 * That is standing in for the guest, not scoping the test down -- the free
 * path under test is reached through the real entry, in its real strict mode,
 * exactly as a `dlclose` reaches it.
 */
function growResumeTable(x: { x: Record<string, unknown> }, slots: number): void {
  const table = x.x.__wpk_fork_resume_table as WebAssembly.Table | undefined;
  expect(table, "the injected module no longer exports its resume table").toBeDefined();
  table!.grow(slots);
  expect(table!.length, "the resume table covers the slots about to be nulled")
    .toBeGreaterThan(slots);
}

describe("resume free-slot bitmap", () => {
  it("hands a freed slot back to the next activation, smallest first", () => {
    const x = arenaFixture("resume free bitmap");
    growResumeTable(x, 8);

    // Three ordinals take slots 1, 2, 3 from RESUME_NEXT_SLOT.
    x.seedActivationCatalog(ACTIVATION_A, [10, 20, 30]);
    expect(x.errno(), "seeding activation A").toBe(0);
    expect(x.publishedSlots(ACTIVATION_A), "a fresh activation numbers from 1")
      .toEqual([1, 2, 3]);

    const mmapsBefore = x.mmaps();

    expect(x.slots(1, ACTIVATION_A, 0), "three slots freed").toBe(3);

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

    // AND IT COSTS NO MAPPING. This is the invariant that makes the free path
    // safe to run from the vfork child's exit teardown, where the parent is
    // parked on the shared channel and a syscall kills the guest. Whoever
    // converts this store to on-demand storage will break this assertion, and
    // that is what it is here for.
    expect(
      x.mmaps() - mmapsBefore,
      "freeing and reusing a slot must issue no syscall",
    ).toBe(0);
  });

  it("gives a COW child distinct slots rather than the parent's stale ones", () => {
    // `fm_set_format` is the COW-child scrub. It clears the bitmap AND resets
    // `RESUME_NEXT_SLOT` to 1, and the two together are why a stale bit is
    // worse than a wasted number: the allocator would hand out the stale bits
    // and then hand out those same numbers AGAIN as fresh ones. Two ordinals
    // would land on one thunk.
    const x = arenaFixture("resume free bitmap scrub");
    growResumeTable(x, 8);
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
