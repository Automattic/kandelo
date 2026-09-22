import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_ENTRY_COUNT_FIELD,
  arenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * Four of the stores this arena replaces recorded ABSOLUTE guest addresses
 * into their payloads by design, and `activation_catalog()` hands back
 * `&'static [u32]` into that storage. The `'static` was safe only because
 * nothing ever freed. This arena frees, so the discipline that makes it honest
 * -- payload records never move, and a release removes the directory entry
 * FIRST -- has to be asserted rather than described.
 *
 * WHAT WOULD BE WRONG WITHOUT IT, and what this catches: if a release left the
 * directory entry behind, or if a record ever moved, the second seed below
 * would read the FIRST seed's ordinals out of reused memory. That is a wrong
 * value, not a trap, and no other test in the suite looks at it.
 *
 * WHAT IT DRIVES: `fm_set_activation_resume_catalog` now allocates the
 * activation's `(ordinal, slot)` record in the arena, so a seed / release /
 * re-seed round trip is a real allocate / free / allocate through the chunk
 * chain and the directory.
 */

/** The activation seeded and released below. */
const ACTIVATION = 9;
/** The activation seeded into whatever memory the release returned. */
const LATER = 10;

describe("arena record lifetime", () => {
  it("a released activation's storage is gone, not stale", () => {
    const x = arenaFixture("arena lifetime");
    // The release nulls the activation's table entries STRICTLY; a bare module
    // fixture has no guest to have grown the table. See the fixture's own note.
    x.growResumeTable(8);

    x.seedActivationCatalog(ACTIVATION, [10, 20, 30]);
    expect(x.errno()).toBe(0);
    expect(x.publishedPairs(ACTIVATION), "three records, ascending").toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(x.slots(1, ACTIVATION, 0), "three slots freed").toBe(3);

    // THE DIRECTORY ENTRY WENT WITH THE RECORD. An entry left behind is the
    // failure this file exists for: the next `arena_find` for this activation
    // would follow a chain whose records are gone.
    expect(
      x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD),
      "the released activation owns nothing",
    ).toBe(0);
    // And a second release finds nothing rather than stale bytes -- as the
    // zero-freed SUCCESS it is, not an error. "Never registered" and "holds
    // nothing" are the same answer here on purpose; reading the second as an
    // error once cost a real fork.
    expect(x.slots(1, ACTIVATION, 0), "nothing left to release").toBe(0);
    expect(x.errno(), "releasing nothing is a success").toBe(0);

    // A LATER ACTIVATION LANDS IN THE MEMORY THE RELEASE RETURNED, and must
    // read back ITS OWN ordinals. A record that moved, or a stale address, is a
    // wrong VALUE here rather than a trap, and no other test looks at it.
    // Its slots are the freed 1, 2, 3 first -- smallest-first reuse -- then two
    // fresh ones.
    x.seedActivationCatalog(LATER, [11, 22, 33, 44, 55]);
    expect(x.errno(), "seeding after the release").toBe(0);
    expect(x.publishedPairs(LATER), "its own five, not the first seed's three")
      .toEqual([
        [11, 1],
        [22, 2],
        [33, 3],
        [44, 4],
        [55, 5],
      ]);
    expect(x.slots(1, LATER, 0), "five slots freed on the second release").toBe(5);
  });

  it("re-seeds the process-wide catalog over its own released record", () => {
    // THE SAME-ACTIVATION ROUND TRIP, which the activation-keyed entry above
    // cannot drive. `fm_set_activation_resume_catalog` REFUSES a re-seed by
    // design -- `set_activation_resume_catalog_impl` scans its index and
    // answers `EINVAL` for an activation it has already seen, once per worker,
    // and a release of the resume slots does not clear that index. That guard
    // belongs to a different store and is not what this file is about.
    //
    // `fm_set_resume_catalog` is the entry that DOES re-decide: it is activation
    // 0's, the host calls it once per worker, and `resume_reseed` frees the old
    // assignment before registering the new one. So it is the one that exercises
    // release-then-allocate on a single activation through the arena, which is
    // the lifetime this file asserts.
    const x = arenaFixture("arena lifetime reseed");
    x.seedProcessCatalog([10, 20, 30]);
    expect(x.errno(), "the first seed").toBe(0);
    expect(x.publishedPairs(0)).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);

    // The re-seed frees the three slots and allocates a NEW record for five.
    // Its slots are the freed 1, 2, 3 reused smallest-first, then 4 and 5.
    x.seedProcessCatalog([11, 22, 33, 44, 55]);
    expect(x.errno(), "the re-seed").toBe(0);
    expect(x.publishedPairs(0), "five records, none of them the old three")
      .toEqual([
        [11, 1],
        [22, 2],
        [33, 3],
        [44, 4],
        [55, 5],
      ]);
    expect(
      x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD),
      "one activation, one entry -- the re-seed did not leave two",
    ).toBe(1);
  });
});
