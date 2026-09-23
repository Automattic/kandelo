import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_DIRECTORY_ENTRY_COUNT_FIELD,
  ARENA_OP_ALLOC,
  ARENA_OP_EXTEND,
  ARENA_OP_FIND,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  arenaChunkBytesFromSource,
  arenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * The arena landed as a mechanism with no store on it, so every other arena
 * test in this suite asserts the EMPTY state or is `it.skip` until a
 * conversion task un-skips it. That left the allocation and release paths --
 * `arena_map_chunk`, `arena_alloc`, `arena_insert_record`, the chunk chaining,
 * `arena_release_activation` and `arena_release_all` -- with zero live
 * coverage, proven only by a temporary probe that was then deleted.
 *
 * A SUITE WHOSE GUARDS WERE ONLY EVER DEMONSTRATED BY A DELETED SCAFFOLD IS A
 * SUITE THAT GOES GREEN ON A BROKEN ARENA. Twelve tasks build on this
 * foundation. So this file is the durable form of that probe: it allocates
 * real records through `fm_arena_selftest`, reads NON-ZERO chunk counts, and
 * drives both release paths against a non-empty chain.
 *
 * THE DEFECT IT EXISTS TO CATCH, concretely: transpose the `fm_stats` arms so
 * field 101 answers `arena_directory_chunk_count()` and 102 answers
 * `arena_record_chunk_count()`. Both read 0 in the empty state, so every
 * zeros-only assertion in this suite still passes; the module's
 * `FM_STATS_HIGH_FIELDS` const-assert sees only the numbers and not the
 * sources; and the one deferred test that would notice is skipped. Driving
 * the two counts APART is the only thing that catches it, and driving them
 * apart requires allocating. That is what `RECORDS_PER_CHUNK` below is for:
 * the record count and the directory count must differ, so a transposition
 * cannot read as agreement.
 *
 * `fm_arena_selftest` IS TEST-ONLY SURFACE AND A DEBT. Its module doc comment
 * and `docs/surface-budget.json` both record that the task converting the
 * resume assignment deletes it and gives its three ceilings back, at which
 * point this file re-targets onto `fm_set_activation_resume_catalog` -- a real
 * production entry -- and loses nothing.
 */

/** Record kinds, matching the module's `REC_KIND_*`. */
const KIND_KFIG = 2;
const KIND_KFIT = 3;
const KIND_GC_CODEC = 4;

/**
 * A record size that puts exactly one record in a chunk, DERIVED from the
 * module's constants rather than guessed.
 *
 *     ARENA_CHUNK_BYTES  = 65_536
 *     ARENA_CHUNK_HEADER = 32      -> a chunk body is 65,504 bytes
 *     RECORD_HEADER      = 16
 *
 * so a 40,000-byte payload costs 40,016 bytes and two of them (80,032) cannot
 * share a 65,504-byte body. Two records therefore mean two record chunks,
 * while both belong to one activation and so occupy ONE directory entry in ONE
 * directory chunk. 2 != 1 is the asymmetry the transposition check needs.
 */
const CHUNK_BODY_BYTES = 65_536 - 32;
const OVERSIZED_PAYLOAD = 40_000;

/** The activations these records are allocated under. */
const ACTIVATION_A = 21;
const ACTIVATION_B = 22;

/** Unpack `fm_arena_selftest` op 1: count high, pointer low. */
function unpackFind(packed: bigint): { payload: number; byteLen: number } {
  return {
    payload: Number(packed & 0xffff_ffffn),
    byteLen: Number(packed >> 32n),
  };
}

describe("arena allocation", () => {
  it("derives the two-records-per-two-chunks arithmetic from the module's constants", () => {
    // If a later task retunes `ARENA_CHUNK_BYTES`, this fails here with the
    // arithmetic in front of the reader rather than as a confusing chunk-count
    // mismatch three assertions down.
    expect(OVERSIZED_PAYLOAD + 16, "one record fits a chunk body").toBeLessThanOrEqual(
      CHUNK_BODY_BYTES,
    );
    expect(
      2 * (OVERSIZED_PAYLOAD + 16),
      "two records do not",
    ).toBeGreaterThan(CHUNK_BODY_BYTES);
  });

  it("allocates real records, and each observable answers from its OWN counter", () => {
    const x = arenaFixture("arena allocation");
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "nothing mapped yet").toBe(0);

    const first = x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, OVERSIZED_PAYLOAD);
    expect(x.errno(), "allocating the first record").toBe(0);
    expect(first, "a payload address").toBeGreaterThan(0n);

    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "one record chunk").toBe(1);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "one directory chunk").toBe(1);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "one activation").toBe(1);

    // THE SECOND RECORD IS WHAT DRIVES THE COUNTS APART. It cannot share the
    // first chunk's body, so the record chain grows to 2 while the directory
    // stays at 1 chunk and 1 entry -- both records belong to one activation.
    const second = x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIT, OVERSIZED_PAYLOAD);
    expect(x.errno(), "allocating the second record").toBe(0);
    expect(second, "a distinct payload address").not.toBe(first);

    expect(
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD),
      "two oversized records cannot share a chunk body, so the record chain " +
        "is 2 -- and a field answering this from the DIRECTORY counter would " +
        "say 1 here",
    ).toBe(2);
    expect(
      x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD),
      "both records belong to one activation, so the directory is still 1 -- " +
        "and a field answering this from the RECORD counter would say 2",
    ).toBe(1);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "still one activation").toBe(1);

    // A SECOND ACTIVATION moves the entry count without moving the directory
    // chunk count, which separates those two in turn.
    x.selftest(ARENA_OP_ALLOC, ACTIVATION_B, KIND_GC_CODEC, 64);
    expect(x.errno(), "allocating for a second activation").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "two activations").toBe(2);
    expect(
      x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD),
      "one directory chunk still holds both entries",
    ).toBe(1);
  });

  it("refuses a duplicate (activation, kind) and finds what it allocated", () => {
    const x = arenaFixture("arena find");
    const EINVAL = 22;
    const ENOENT = 2;

    expect(x.selftest(ARENA_OP_FIND, ACTIVATION_A, KIND_KFIG, 0), "absent").toBe(-1n);
    expect(x.errno(), "finding a record that was never allocated").toBe(ENOENT);

    const payload = x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, 256);
    expect(x.errno()).toBe(0);

    const found = unpackFind(x.selftest(ARENA_OP_FIND, ACTIVATION_A, KIND_KFIG, 0));
    expect(x.errno()).toBe(0);
    expect(found.payload, "find returns the address alloc handed out").toBe(
      Number(payload),
    );
    expect(found.byteLen, "and the length it was allocated with").toBe(256);

    expect(
      x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, 256),
      "a second record for one (activation, kind) is refused",
    ).toBe(-1n);
    expect(x.errno(), "the duplicate refusal").toBe(EINVAL);
  });

  it("zeroes a payload, and preserves it across an extend", () => {
    const x = arenaFixture("arena extend");
    const payload = Number(x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, 64));
    expect(x.errno()).toBe(0);

    // A fresh view per access: an arena allocation can GROW the shared memory.
    const read = (at: number): number => new DataView(x.memory.buffer).getUint32(at, true);
    const write = (at: number, value: number): void => {
      new DataView(x.memory.buffer).setUint32(at, value, true);
    };

    expect(read(payload), "a fresh record is zeroed").toBe(0);
    expect(read(payload + 60), "all of it, not just the first word").toBe(0);
    write(payload, 0xfeed_face);
    write(payload + 60, 0x0bad_cafe);

    const grown = Number(x.selftest(ARENA_OP_EXTEND, ACTIVATION_A, KIND_KFIG, 32));
    expect(x.errno(), "extending by 32 bytes").toBe(0);
    expect(grown, "extend re-allocates; it never grows in place").not.toBe(payload);

    expect(read(grown), "the old contents were copied").toBe(0xfeed_face);
    expect(read(grown + 60), "all of them").toBe(0x0bad_cafe);
    expect(read(grown + 64), "and the new bytes are zeroed").toBe(0);

    const found = unpackFind(x.selftest(ARENA_OP_FIND, ACTIVATION_A, KIND_KFIG, 0));
    expect(found.payload, "find now answers with the grown record").toBe(grown);
    expect(found.byteLen, "at the grown length").toBe(96);

    // The extend's sweep keeps the outgrown chunk from staying mapped. Both
    // records are small enough to share one chunk, so this stays at 1 -- the
    // assertion that would catch a sweep that unmapped a LIVE chunk.
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "one chunk holds both").toBe(1);
  });

  it("gives every chunk back when the owning activation is released", () => {
    const x = arenaFixture("arena release activation");
    x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, OVERSIZED_PAYLOAD);
    x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIT, OVERSIZED_PAYLOAD);
    expect(x.errno()).toBe(0);
    const held =
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD) +
      x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD);
    expect(held, "two record chunks and one directory chunk").toBe(3);

    const before = x.munmaps();
    expect(before, "munmaps seen while only allocating").toBe(0);

    // op 1 is the per-activation release the host already issues on `dlclose`.
    x.slots(1, ACTIVATION_A, 0);
    expect(x.errno(), "releasing the activation").toBe(0);

    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(0);

    // AND THE MAPPINGS GO BACK. The counts above cannot see this: the unlink
    // happens BEFORE the best-effort `channel_munmap`, so deleting the unmap
    // leaves every count reading zero while every chunk leaks.
    expect(
      x.munmaps() - before,
      "one unmap per arena chunk released; this activation published no " +
        "identity, so the identity registry contributes none",
    ).toBe(held);
  });

  it("a second fm_set_format returns every chunk the first one's records held", () => {
    // THE COW-CHILD SCRUB, against a NON-EMPTY chain. A child's fork-module
    // instance sees the PARENT's already-populated statics, because BSS is not
    // re-zeroed on instantiation and the memory is a clone -- so the child
    // inherits real mappings. Zeroing a root without unmapping leaks every
    // chunk the parent ever took, in a child that may never fork itself.
    //
    // `arena_release_all` is a DIFFERENT function from the per-activation
    // release above, with different unmap bookkeeping (a two-head loop rather
    // than `arena_sweep_record_chunks`), so it needs its own coverage rather
    // than inheriting the assertion above.
    const x = arenaFixture("arena cow scrub live");
    x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, OVERSIZED_PAYLOAD);
    x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIT, OVERSIZED_PAYLOAD);
    x.selftest(ARENA_OP_ALLOC, ACTIVATION_B, KIND_GC_CODEC, 64);
    expect(x.errno()).toBe(0);

    // B's 80-byte record (64 + a 16-byte header) shares A's second chunk in
    // the default build, where an oversized chunk still has 25,488 bytes of
    // room; in the forced-chunk build an oversized chunk is exactly its one
    // record, so B takes a chunk of its own. Derived, not observed.
    const roomBesideOversized =
      Math.max(arenaChunkBytesFromSource(), 32 + OVERSIZED_PAYLOAD + 16) - 32 - (OVERSIZED_PAYLOAD + 16);
    const expectedRecordChunks = roomBesideOversized >= 80 ? 2 : 3;
    const held =
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD) +
      x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD);
    expect(held, "the record chunks and one directory chunk").toBe(expectedRecordChunks + 1);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "two activations").toBe(2);
    const before = x.munmaps();

    x.setFormat(); // the COW-child scrub

    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "records").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "entries").toBe(0);
    // The counts cannot see a mapping leak; the tally can.
    expect(
      x.munmaps() - before,
      "one unmap per chunk the scrub released",
    ).toBe(held);

    // AND THE ARENA STILL WORKS AFTERWARDS. A scrub that cleared the roots but
    // left a stale memo would answer the next lookup with a freed address.
    const after = x.selftest(ARENA_OP_ALLOC, ACTIVATION_A, KIND_KFIG, 64);
    expect(x.errno(), "allocating after a scrub").toBe(0);
    expect(after, "a fresh record, not the refused duplicate of a stale entry")
      .toBeGreaterThan(0n);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "one activation again").toBe(1);
  });
});
