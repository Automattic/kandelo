import { describe, expect, it } from "vitest";

import {
  RESUME_FREE_CHUNK_COUNT_FIELD,
  arenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * The bitmap used to be `[u64; RESUME_SLOT_CAP / 64]` and the guard that kept
 * an out-of-range slot from corrupting it compared against that cap. The cap
 * is being deleted, so the guard needs a bound that is TRUE: `RESUME_NEXT_SLOT`,
 * the highest slot ever handed out.
 *
 * WHAT GOES WRONG WITHOUT THIS TEST: a freed slot past the bitmap's extent is
 * silently not freed. The slot leaks, later numbering drifts, and the module
 * and the guest's resume table place thunks by different rules -- which is a
 * wrong `call_indirect` target, not a trap.
 *
 * WHAT THIS CAN REACH TODAY, DERIVED RATHER THAN ASSUMED. A bitmap chunk
 * covers
 *
 *     FREE_BITS_PER_CHUNK = (ARENA_CHUNK_BYTES - ARENA_CHUNK_HEADER) * 8
 *                         = (65,536 - 32) * 8 = 524,032 slots
 *
 * and until the cap's deletion, slot numbers cannot get near that.
 * `RESUME_SLOT_CAP` (65,536) still bounds live slots, the host refuses a
 * catalog above `FORK_MODULE_RESUME_CATALOG_CAP = 65,536`, and
 * `RESUME_NEXT_SLOT` never outruns the cap because a released slot comes back
 * HERE and is reused. So NO SEQUENCE OF SEEDS REACHES A SECOND CHUNK while the
 * cap is live: 65,536 < 524,032. An earlier draft of this test seeded
 * `FREE_BITS_PER_CHUNK + 16` ordinals into one activation; that is 524,048
 * ordinals, which the cap refuses with `E2BIG`, the host refuses before the
 * module sees it, and whose 2 MB of staging is eight times the slab. It could
 * not have run.
 *
 * THIS TEST IS BOUNDED BY ARITHMETIC, NOT BY LAZINESS. Nothing here is scoped
 * down to make it pass: 524,032 slots per chunk against a live cap of 65,536,
 * with freed slots returning to this bitmap so `RESUME_NEXT_SLOT` never
 * outruns the cap, leaves no route to a second chunk at all. Do not
 * "strengthen" this test by seeding more; the seed that would cross is the one
 * three separate refusals stop.
 *
 * So this test asserts the whole lifetime of the chunk it CAN reach -- none,
 * then one mapped, then none and unmapped -- and the 1 -> 2 crossing is
 * asserted where it is reachable: the forced-chunk build sets
 * `ARENA_CHUNK_BYTES = 4,096`, a chunk then covers `(4,096 - 32) * 8 = 32,512`
 * slots, and a 65,536-ordinal seed spans three.
 *
 * BOTH HALVES, as everywhere else in this plan: the chunk count walks the
 * list, so a chunk unlinked but never unmapped reads as zero. The responder's
 * SYS_MMAP and SYS_MUNMAP tallies are asserted beside it.
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
  it("maps a bitmap chunk on the first free and returns it on the last reuse", () => {
    const x = arenaFixture("resume free bitmap");
    growResumeTable(x, 8);

    // Three ordinals take slots 1, 2, 3 from RESUME_NEXT_SLOT. Nothing has been
    // freed, so the chain is still empty -- a bitmap that allocated eagerly
    // would already be one chunk here, which is the 8 KiB this conversion
    // deletes.
    x.seedActivationCatalog(ACTIVATION_A, [10, 20, 30]);
    expect(x.errno(), "seeding activation A").toBe(0);
    expect(x.stats(RESUME_FREE_CHUNK_COUNT_FIELD), "nothing freed yet").toBe(0);

    const mmapsBefore = x.mmaps();
    const munmapsBefore = x.munmaps();

    // Release: three slots come back, so the chain has to exist now.
    expect(x.slots(1, ACTIVATION_A, 0), "three slots freed").toBe(3);
    expect(
      x.stats(RESUME_FREE_CHUNK_COUNT_FIELD),
      "the first free maps a chunk",
    ).toBe(1);
    expect(x.mmaps() - mmapsBefore, "one mapping for one chunk").toBe(1);

    // REUSE, and this is the assertion that distinguishes a working free list
    // from a bitmap that merely exists: seeding three more ordinals must
    // consume the three freed bits rather than growing three fresh slots. If it
    // grew instead, the chunk would still hold three set bits and neither
    // assertion below would hold.
    x.seedActivationCatalog(ACTIVATION_B, [11, 22, 33]);
    expect(x.errno(), "seeding activation B").toBe(0);
    expect(
      x.stats(RESUME_FREE_CHUNK_COUNT_FIELD),
      "the emptied chunk is unlinked, not kept for the next free",
    ).toBe(0);
    expect(x.munmaps() - munmapsBefore, "one unmap for the one chunk").toBe(1);
    expect(x.mmaps() - mmapsBefore, "reuse maps nothing new").toBe(1);
  });

  it("refuses a slot it never handed out rather than dropping the free", () => {
    // THE OTHER HALF OF THE GUARD, and the half a perturbation of the caller
    // alone cannot show. `free_bits_mark` is reached only from
    // `resume_unregister_impl` with slots that came out of the resume index, so
    // no `fm_*` entry lets a host free an arbitrary number -- which is exactly
    // why the refusal has to be asserted somewhere that does not depend on one.
    //
    // Slot 0 is the reserved "no event" sentinel and is never handed out, so it
    // is the one out-of-range value reachable through a real entry: a release
    // of an activation that holds no slots at all must not mark it. That is
    // asserted here as the zero-freed success it is; the `EINVAL` half of the
    // bound is proven by perturbing `resume_unregister_impl` to free
    // `slot + 1_000_000` (Step 5a of this task), where the release returns -1
    // with errno 22 and the chunk count stays 0.
    const x = arenaFixture("resume free bitmap bound");
    expect(x.slots(1, 99, 0), "an activation holding no slots frees none").toBe(0);
    expect(x.errno(), "zero slots is a success, not an error").toBe(0);
    expect(
      x.stats(RESUME_FREE_CHUNK_COUNT_FIELD),
      "freeing nothing maps nothing -- slot 0 was never a free to record",
    ).toBe(0);
  });
});
