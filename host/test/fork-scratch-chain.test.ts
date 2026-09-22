import { describe, expect, it } from "vitest";

import {
  SCRATCH_CHUNK_COUNT_FIELD,
  arenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * The scratch stack hands the GUEST a raw linear-memory address it writes
 * through directly across a recursive encode. Chaining it means a frame can
 * now land at the base of a fresh chunk, so the release arithmetic --
 * "`ptr` must equal `base + top - need`" -- has to work across a chunk
 * boundary, and must still TRAP when it does not. That trap is the only
 * thing standing between a mis-nested release and silent capture corruption.
 *
 * WHAT DRIVES THE RESET: `driveBumpReset` is `fm_capture_begin`, the fork's
 * designated bump-reset point and one of `reset_bump_heap`'s production
 * callers (the others need a drive table this fixture has none of). The COW
 * scrub is `fm_set_format` itself, which is NOT one of those callers -- that
 * is the whole reason the scrub test exists.
 *
 * BOTH HALVES, EVERY TIME: the chunk count walks the list, so a chunk that
 * was unlinked but never unmapped reads as zero there and only the
 * responder's `SYS_MUNMAP` tally sees it.
 */

// A frame that cannot fit beside another in one chunk, derived from the
// module's own constants rather than picked: one chunk's body is
// ARENA_CHUNK_BYTES - ARENA_CHUNK_HEADER = 65,536 - 32 = 65,504 bytes, so two
// frames of 40,000 cannot share one and the second takes a fresh chunk.
const CHUNK_BODY = 65_536 - 32;
const FRAME = 40_000;

describe("guest-facing scratch chain", () => {
  it("reserves and releases across a chunk boundary", () => {
    const x = arenaFixture("scratch chain boundary");
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "nothing reserved yet").toBe(0);

    // Frame A fits the first chunk; frame B cannot, so it lands at the BASE of
    // a second -- which is the case the old `base + top - need` arithmetic got
    // wrong, because B's `top` restarts rather than continuing A's.
    const a = x.scratchReserve(FRAME);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "one chunk").toBe(1);
    const b = x.scratchReserve(FRAME);
    expect(2 * FRAME, "the fixture's own arithmetic").toBeGreaterThan(CHUNK_BODY);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "the second frame chains").toBe(2);
    // Not merely "different": B must not overlap A, which is the corruption
    // this whole scheme exists to prevent.
    expect(Math.abs(b - a), "frames do not overlap").toBeGreaterThanOrEqual(FRAME);

    // Releasing B pops back to A's chunk; releasing A empties the chain.
    const before = x.munmaps();
    x.scratchRelease(b, FRAME);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "the empty chunk is returned").toBe(1);
    x.scratchRelease(a, FRAME);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "and so is the last one").toBe(0);
    expect(x.munmaps() - before, "one unmap per emptied chunk").toBe(2);
  });

  it("restores the previous chunk's top when a frame pops back into it", () => {
    // A, then B in a fresh chunk, then B released: the next frame must be cut
    // from A's chunk ABOVE A, at the `top` that was frozen when B chained.
    // If the pop lost that top, the next frame would land on A.
    const x = arenaFixture("scratch chain pop");
    const a = x.scratchReserve(FRAME);
    const b = x.scratchReserve(FRAME);
    x.scratchRelease(b, FRAME);
    const c = x.scratchReserve(1_024);
    expect(c, "cut above A, not on it").toBe(a + FRAME);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "in A's chunk").toBe(1);
    x.scratchRelease(c, 1_024);
    x.scratchRelease(a, FRAME);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD)).toBe(0);
  });

  it("gives an oversized frame its own chunk", () => {
    // Larger than a default chunk's body: the chunk is sized to the frame,
    // the same `max(ARENA_CHUNK_BYTES, header + want)` rule the arena uses.
    const x = arenaFixture("scratch chain oversized");
    const big = 3 * CHUNK_BODY;
    const p = x.scratchReserve(big);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD)).toBe(1);
    // The whole frame is addressable: write its last byte and read it back.
    const view = new Uint8Array(x.memory.buffer);
    view[p + big - 1] = 0xa5;
    expect(new Uint8Array(x.memory.buffer)[p + big - 1]).toBe(0xa5);
    x.scratchRelease(p, big);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD)).toBe(0);
  });

  it("traps on a release that does not name the top frame", () => {
    const x = arenaFixture("scratch chain trap");
    const a = x.scratchReserve(1_024);
    // One byte off the top frame's base is not the top frame. The contract is
    // a TRAP, not an errno: "a release that does not match the top means the
    // nesting the whole scheme assumes has been violated, and continuing would
    // hand the next reserve a region that overlaps a live one."
    expect(() => x.scratchRelease(a + 1, 1_024)).toThrow();
    // And a release of the right address with the wrong length is the same
    // violation arriving the other way round.
    expect(() => x.scratchRelease(a, 512)).toThrow();
    // A release with nothing open is the same violation again.
    x.scratchRelease(a, 1_024);
    expect(() => x.scratchRelease(a, 1_024)).toThrow();
  });

  it("returns every chunk when a reset aborts open frames", () => {
    const x = arenaFixture("scratch chain reset");
    // Reserve twice without releasing: two open frames across two chunks.
    x.scratchReserve(FRAME);
    x.scratchReserve(FRAME);
    const chunksHeld = x.stats(SCRATCH_CHUNK_COUNT_FIELD);
    expect(chunksHeld, "two open frames, two chunks").toBe(2);
    const before = x.munmaps();

    x.driveBumpReset(); // `fm_capture_begin` reaches `reset_bump_heap`

    // Every chunk must come back -- the defect the old `SCRATCH_TOP.store(0)`
    // comment records as already fixed, arriving by a new route. BOTH HALVES:
    // the count walks the list, so an unlinked-but-unmapped chunk reads as
    // zero here and only the tally sees it.
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD)).toBe(0);
    expect(x.munmaps() - before).toBe(chunksHeld);
  });

  it("does not hand a COW child the parent's scratch chunks", () => {
    // `set_format_impl` is the COW-child scrub, and it is NOT one of
    // `reset_bump_heap`'s callers -- so without its own release call the child
    // inherits SCRATCH_HEAD pointing at mappings it did not make and never
    // gives them back. This is the leak Task 0 section F describes, for the
    // one chain section F does not cover.
    const x = arenaFixture("scratch chain cow scrub");
    x.scratchReserve(FRAME);
    x.scratchReserve(FRAME);
    const chunksHeld = x.stats(SCRATCH_CHUNK_COUNT_FIELD);
    expect(chunksHeld).toBe(2);
    const before = x.munmaps();

    x.setFormat(); // the scrub: the child's first call into the module

    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "the child inherits no chunks").toBe(0);
    expect(x.munmaps() - before, "one unmap per inherited chunk").toBe(chunksHeld);
  });
});
