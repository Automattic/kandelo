import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  arenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * `set_format_impl` is the COW-child scrub: a child's fork-module instance
 * sees the PARENT's already-populated statics, because BSS is not re-zeroed on
 * instantiation and the memory is a clone. Today the scrub resets counters;
 * the arenas behind them are static BSS the child simply overwrites.
 *
 * A CHAIN IS DIFFERENT. The child inherits real mappings. Zeroing the root
 * without unmapping leaks every 64 KiB chunk the parent ever took, in a child
 * that may outlive it. The scrub therefore RELEASES, and the release needs a
 * serviced channel -- so it is sequenced AFTER `fm_set_format` stores
 * `CHANNEL_BASE`, not before.
 *
 * SKIPPED UNTIL TASK 3. Nothing is on the arena yet, so
 * `ordinalsSpanningTwoChunks` would seed the fixed-BSS catalog and the
 * `toBeGreaterThan(0)` below would fail for a reason that is not a defect.
 * Task 3 Step 6 un-skips it. The scrub itself IS wired in this task --
 * `arena_release_all()` runs today -- so the code this file names exists and
 * only its exercise is deferred.
 */

/** The activation whose records the scrub is asked to return. */
const ACTIVATION = 5;

/**
 * Enough resume ordinals to need more than one `ARENA_CHUNK_BYTES` chunk.
 *
 * DERIVED from the module's own constants rather than asserted:
 * `ARENA_CHUNK_BYTES` is 65,536 and `ARENA_CHUNK_HEADER` 32, so a chunk's body
 * is 65,504 bytes; a resume-assignment record costs `RECORD_HEADER` 16 plus
 * four bytes per ordinal. 20,000 ordinals is 80,016 bytes, past one chunk's
 * body and short of two.
 */
const ordinalsSpanningTwoChunks = Array.from({ length: 20_000 }, (_, i) => i + 1);

describe("arena COW-child scrub", () => {
  // UN-SKIP IN TASK 3.
  it.skip("a second fm_set_format returns every chunk the first one's records held", () => {
    const x = arenaFixture("arena cow scrub");
    x.seedActivationCatalog(ACTIVATION, ordinalsSpanningTwoChunks);
    expect(x.errno(), "seeding the oversized catalog").toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD)).toBeGreaterThan(0);
    const before = x.munmaps();
    const held =
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD) +
      x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD);

    x.setFormat(); // the COW-child scrub

    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "records").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory").toBe(0);
    // The counts above cannot see a mapping leak; the tally can.
    expect(
      x.munmaps() - before,
      "one unmap per chunk the scrub released",
    ).toBe(held);
  });
});
