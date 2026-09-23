import { describe, expect, it } from "vitest";

import { WASM_PAGE_SIZE } from "../src/constants";
import {
  CHANNEL_BASE,
  SCRATCH_CHUNK_COUNT_FIELD,
  arenaChunkBytesFromSource,
  arenaFixture,
  fixture,
  seedTemplateId,
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
/** The constant the artifact was BUILT with (see `arenaChunkBytesFromSource`). */
const BUILT_CHUNK_BYTES = arenaChunkBytesFromSource();

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
    // Where C lands depends on the BUILT chunk size: A's chunk holds
    // `max(ARENA_CHUNK_BYTES, header + FRAME) - header` bytes, which in the
    // default build leaves 25,504 above A and in the forced-chunk build is
    // exactly FRAME -- an oversized chunk sized to its one frame -- so C must
    // take a fresh chunk there. Either way the frozen `top` decides, and
    // either way C is never cut ON A.
    const roomAboveA = Math.max(BUILT_CHUNK_BYTES, 32 + FRAME) - 32 - FRAME;
    if (roomAboveA >= 1_024) {
      expect(c, "cut above A, not on it").toBe(a + FRAME);
      expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "in A's chunk").toBe(1);
    } else {
      expect(c, "a fresh chunk, since A's is exactly its frame").not.toBe(a + FRAME);
      expect(Math.abs(c - a), "and it does not overlap A").toBeGreaterThanOrEqual(FRAME);
      expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "two chunks").toBe(2);
    }
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

  // THE FORCED-CHUNK BUILD'S CROSSING. Two 3,000-byte frames share one
  // 65,504-byte body in the default build and cannot share a 4,064-byte one,
  // so this crossing is unreachable at the default `ARENA_CHUNK_BYTES` and
  // routine at the forced 4,096. The test reads the constant from the source
  // the artifact was built from rather than being told which build it is in,
  // and stands down BY NAME in the default build instead of being quietly
  // weakened: the 40,000-byte frames above chain in both builds, but by the
  // oversized path, which is a different code path from a frame that fits a
  // chunk and still lands at the base of a fresh one.
  const SMALL_FRAME = 3_000;
  const BUILT_CHUNK_BODY = BUILT_CHUNK_BYTES - 32;
  it.skipIf(BUILT_CHUNK_BODY >= 2 * SMALL_FRAME)(
    "chains two frames that would share a default chunk (forced-chunk build only)",
    () => {
      const x = arenaFixture("scratch chain forced crossing");
      const a = x.scratchReserve(SMALL_FRAME);
      expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "one chunk").toBe(1);
      const b = x.scratchReserve(SMALL_FRAME);
      expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "the scratch chain chained").toBeGreaterThan(1);
      expect(Math.abs(b - a), "frames do not overlap").toBeGreaterThanOrEqual(SMALL_FRAME);
      const before = x.munmaps();
      x.scratchRelease(b, SMALL_FRAME);
      x.scratchRelease(a, SMALL_FRAME);
      expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD)).toBe(0);
      expect(x.munmaps() - before, "one unmap per emptied chunk").toBe(2);
    },
  );

  it("floors a zero-length frame at one unit, so the chain never holds an empty chunk", () => {
    // `scratch_align(0)` used to be 0: a zero-length reserve on an empty
    // chain mapped a chunk with NO frame in it, a nested reserve/release then
    // found `top == need` and popped that chunk, and the outer release
    // trapped at `cur == 0`. Every emission site floors its length at 1, so
    // no generated code reaches this; the module now holds its own invariant
    // instead of borrowing the guest's. Reserve and release share the floor,
    // so the release still names the top frame.
    const x = arenaFixture("scratch chain zero-length");
    const outer = x.scratchReserve(0);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "the frame occupies a chunk").toBe(1);
    const inner = x.scratchReserve(64);
    expect(inner - outer, "the zero-length frame is one 16-byte unit").toBe(16);
    x.scratchRelease(inner, 64);
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "the outer frame keeps the chunk").toBe(1);
    expect(() => x.scratchRelease(outer, 0), "the outer release names its frame").not.toThrow();
    expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD), "and returns the chunk").toBe(0);
  });

  it("seals a capture whose scratch exceeded a page and reports the true high-water", () => {
    // THE NEWLY REACHABLE VFORK REFUSAL, module half. The old 64 KiB static
    // cell TRAPPED the parent on the first frame that did not fit, so the
    // kernel's vfork admission gate -- `scratchBytes > WASM_PAGE_SIZE` refuses
    // with EAGAIN (`kernel-worker.ts`, `process-lifecycle.ts`) -- could never
    // be reached with a number above a page. The chained stack seals instead
    // and reports what the capture actually opened, and the kernel refuses
    // THAT number truthfully; `host/test/multi-worker.test.ts` pins the
    // kernel half. Accepted as the truthful failure: a refused vfork over a
    // trapped parent.
    //
    // NODE/BROWSER ONLY. `crates/host-native` routes the scratch imports to
    // a host-owned fixed page, never imports `fm_borrowed_replay_workspace`,
    // and its `handle_fork` reads only the mode word, so there is neither a
    // producer nor a consumer of this number there -- a pre-existing
    // host-parity boundary in the capture-side scratch path, older than the
    // chained stack, closed by routing native's scratch imports to the module
    // rather than by inventing a native gate.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "the capture opens").toBe(0);
    const reserve = f.x.__wpk_fork_ref_scratch_reserve as (n: number) => number;
    const release = f.x.__wpk_fork_ref_scratch_release as (p: number, n: number) => void;
    const a = reserve(FRAME);
    const b = reserve(FRAME);
    expect(2 * FRAME, "two frames open at once exceed a wasm page").toBeGreaterThan(WASM_PAGE_SIZE);
    release(b, FRAME);
    release(a, FRAME);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "the parent seals rather than trapping").toBe(0);
    const reported = Number(
      (f.x.fm_borrowed_replay_workspace as (field: number) => bigint)(1),
    );
    expect(f.errno(), "field 1 is the scratch high-water").toBe(0);
    expect(reported, "the reported scratch is what the capture opened").toBe(2 * FRAME);
    expect(reported, "and it is the number the kernel gate refuses").toBeGreaterThan(
      WASM_PAGE_SIZE,
    );
  });
});
