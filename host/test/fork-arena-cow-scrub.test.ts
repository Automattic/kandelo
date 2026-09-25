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
 * WHAT IT DRIVES: the resume assignment is on the arena, so admitting an
 * oversized catalog really does map record and directory chunks, and the scrub
 * really does have something to hand back.
 */

/** The activation whose records the scrub is asked to return. */
const ACTIVATION = 5;

/**
 * Enough resume ordinals that the record cannot sit in a default-sized chunk.
 *
 * DERIVED from the module's own constants rather than asserted:
 * `ARENA_CHUNK_BYTES` is 65,536 and `ARENA_CHUNK_HEADER` 32, so a chunk's body
 * is 65,504 bytes; a resume-assignment record costs `RECORD_HEADER` 16 plus
 * EIGHT bytes per ordinal -- an `(ordinal, slot)` pair each, not the four bytes
 * an earlier draft of this comment said. 20,000 ordinals is 160,016 bytes,
 * comfortably past one chunk's body, so `arena_map_chunk` sizes a chunk to the
 * request rather than handing back a default one.
 */
const ordinalsPastOneChunk = Array.from({ length: 20_000 }, (_, i) => i + 1);

describe("arena COW-child scrub", () => {
  it("a second fm_set_format returns every chunk the first one's records held", () => {
    const x = arenaFixture("arena cow scrub");
    x.admit(ACTIVATION, { ordinals: ordinalsPastOneChunk });
    expect(x.errno(), "admitting the oversized catalog").toBe(0);
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
