import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_DIRECTORY_ENTRY_COUNT_FIELD,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  arenaFixture,
  assertDirectoryWithinWalkBound,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * A fixed array could not leak; a chunk list can, so the release path needs an
 * observable. This is the arena's, and it follows
 * `host/test/fork-identity-release.test.ts` deliberately: BOTH halves or
 * neither is a guard.
 *
 * `arena_record_chunk_count()` walks `RECORD_HEAD` and the `next` pointers, so
 * it observes LIST MEMBERSHIP. `arena_release_activation` unlinks a chunk
 * BEFORE calling `channel_munmap`, which is best-effort by design. A chunk
 * unlinked but never unmapped therefore reads as zero here -- blind to exactly
 * the leak the observable exists for. So the `SYS_MUNMAP` tally is asserted
 * beside it: one unmap per chunk released.
 *
 * SCOPE TODAY: the arena has no store on it yet. It landed with the mechanism,
 * before any conversion, so this file asserts the EMPTY state and the
 * observables' own wiring. Task 4 extends it to a real multi-chunk allocation
 * once KFIG sections are arena-backed. Until then the zeros below ARE the
 * assertion -- specifically that the three fields are wired and return 0
 * rather than the -1 an unclaimed `fm_stats` field answers.
 *
 * A TEST FILE THAT ASSERTS ONLY ZEROS is otherwise indistinguishable from one
 * that has stopped working, which is why that scope is stated here rather than
 * left to be inferred. The second test below drives the counts APART and needs
 * a store on the arena to do it; it is `it.skip` until Task 3 puts the resume
 * assignment on the arena, and Task 3 Step 4 un-skips it alongside
 * `fork-arena-lifetime.test.ts` and `fork-arena-cow-scrub.test.ts`.
 *
 * THE FIELD NUMBERS ARE PINNED HERE AND IN THE MODULE. 101, 102 and 105 are
 * chosen from the single table in the plan's Global Constraints, not taken as
 * "the next free index": `fm_stats` answers a high field from an
 * `if field == K` compare placed BEFORE its reference table, so two arms
 * sharing a number is not a compile error -- the second is dead and the first
 * answers both reads with a plausible number from the wrong source. 105 is
 * above Task 10's 104 although this task lands first, for exactly that reason.
 * The module carries a const-assert (`FM_STATS_HIGH_FIELDS`) that turns a
 * reuse into a BUILD failure, and
 * `host/test/fork-module-backend.test.ts` pins the numbers clear of the stats
 * table, which the const-assert cannot see.
 */

/** The activations the second test drives the counters apart with. */
const ACTIVATION_A = 11;
const ACTIVATION_B = 12;

describe("arena chunk release", () => {
  it("wires all three arena observables and starts empty", () => {
    const x = arenaFixture("arena release");
    // NOT `toBeFalsy()`. An unclaimed `fm_stats` field answers -1, and -1 is
    // truthy -- but a `toBe(0)` here fails loudly against a module built
    // without the field, which is the case this assertion exists to catch.
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(0);
  });

  // UN-SKIP IN TASK 3, with the resume assignment on the arena. Until then
  // nothing allocates, so this would assert against an arena that is empty for
  // a reason unrelated to what it tests.
  it.skip("answers each arena observable from its OWN counter", () => {
    // Three fields returning 0 proves nothing about which counter answered
    // which read -- a collision reads as agreement. So drive the counts APART
    // and require them to differ: one activation with records puts 1 entry in
    // the directory and at least 1 chunk on each chain, and the entry count
    // must track activations while the chunk counts track chunks.
    const x = arenaFixture("arena observables");
    x.seedActivationCatalog(ACTIVATION_A, [1, 2, 3]);
    expect(x.errno(), `seeding activation ${ACTIVATION_A}`).toBe(0);
    x.seedActivationCatalog(ACTIVATION_B, [4, 5, 6]);
    expect(x.errno(), `seeding activation ${ACTIVATION_B}`).toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "two activations").toBe(2);
    expect(
      x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD),
      "one directory chunk holds both",
    ).toBe(1);
    x.slots(1, ACTIVATION_B, 0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "one released").toBe(1);
  });

  it("ruling D1-a's directory bound can actually fail, and fails at the right number", () => {
    // EVERY fixture in this suite runs a handful of activations -- the
    // measured maximum is 7 -- so the teardown assertion in
    // `fork-module-capture-fixture.ts` would sit green for the life of this
    // plan whether its comparison is right, whether its message renders, and
    // whether someone later inverts the operator. "It never tripped" and "it
    // cannot trip" look identical from outside. So the helper is driven
    // DIRECTLY with a synthetic count rather than by building 65 real
    // activations, which would be slow and would test the fixture instead of
    // the guard.
    //
    // The "did not fire" case is a SEPARATE assertion rather than a `throw`
    // inside the `try`: a throw there lands in the same `catch` and becomes
    // the message the four `toContain`s are then run against, so the failure
    // would be reported as a missing phrase instead of as a guard that never
    // fired.
    let message: string | null = null;
    try {
      assertDirectoryWithinWalkBound(65);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(
      message,
      "the D1-a bound did not fire at 65 -- it is not a guard",
    ).not.toBeNull();
    expect(message, "names the count").toContain("65");
    expect(message, "names the ruling").toContain("D1-a");
    expect(message, "says it is not a correctness failure").toContain(
      "PERFORMANCE signal, not a correctness failure",
    );
    expect(message, "says not to raise the bound").toContain(
      "do not raise this bound",
    );

    // And 64 must NOT throw, so the boundary is pinned rather than assumed.
    expect(() => assertDirectoryWithinWalkBound(64)).not.toThrow();
  });
});
