import { describe, expect, it } from "vitest";

import { arenaFixture } from "./fork-module-capture-fixture";

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
 * SKIPPED UNTIL TASK 3. This file landed with the arena mechanism, before any
 * store was converted onto it, so `fm_set_activation_resume_catalog` still
 * writes the fixed-BSS catalog and this assertion would be about that catalog
 * rather than about the arena. Task 3 Step 6 puts the resume assignment on the
 * arena and un-skips it. A skipped test nobody un-skips is a test that cannot
 * fail, so that hand-off is named here and in Task 3's own step rather than
 * left to be remembered.
 */

/** The activation seeded, released, and re-seeded below. */
const ACTIVATION = 9;

describe("arena record lifetime", () => {
  // UN-SKIP IN TASK 3.
  it.skip("a released activation's storage is gone, not stale", () => {
    const x = arenaFixture("arena lifetime");

    // Seed three ordinals, then release, then re-seed FIVE different ones.
    x.seedActivationCatalog(ACTIVATION, [10, 20, 30]);
    expect(x.errno()).toBe(0);
    expect(x.slots(1, ACTIVATION, 0), "three slots freed").toBe(3);

    // The re-seed must SUCCEED. A directory entry that survived the release
    // would make this the `EINVAL` re-seed refusal instead.
    x.seedActivationCatalog(ACTIVATION, [11, 22, 33, 44, 55]);
    expect(x.errno(), "re-seeding a released activation").toBe(0);

    // And the module must now hold FIVE, not the first seed's three. A stale
    // address surviving the release reads back the old length here.
    expect(
      x.slots(1, ACTIVATION, 0),
      "five slots freed on the second release",
    ).toBe(5);
  });
});
