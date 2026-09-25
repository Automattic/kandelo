import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_DIRECTORY_ENTRY_COUNT_FIELD,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  arenaChunkBytesFromSource,
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
 * THE ALLOCATION IS A PRODUCTION ONE. The first test admits two activations
 * with imported-global (KFIG) sections through `fm_admit_activation`, the
 * entry both hosts admit an activation through, sized so the two KFIG records
 * cannot share a chunk -- and then releases them one at a time through
 * `fm_resume_slots` op 1, the `dlclose` entry, watching each chunk go back as
 * its last record leaves it. A TEST FILE THAT ASSERTS ONLY ZEROS is indistinguishable from
 * one that has stopped working, which is why the second test drives the three
 * counts APART as well: three fields returning 0 proves nothing about which
 * counter answered which read, because a collision reads as agreement.
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

/** The activations the tests seed and release. */
const ACTIVATION_A = 11;
const ACTIVATION_B = 12;

/**
 * How many bytes to seed, DERIVED from the module's own constants.
 *
 *     ARENA_CHUNK_BYTES  = 65_536 in the default build (read from the source
 *                          the artifact was built from, so the forced-chunk
 *                          build's 4_096 reaches this file too)
 *     ARENA_CHUNK_HEADER = 32     // ONE header size for every chain (Task 1)
 *     RECORD_HEADER      = 16
 *
 * so a default chunk holds 65,536 - 32 = 65,504 bytes of records, and a
 * record costs 16 bytes of header. Two activations at 40,000 payload bytes
 * each therefore need 2 chunks: 40,016 fits in the first, the second does not
 * (80,032 > 65,504). Each admission also stores a few small records (its
 * template id, linked-frame format and empty resume catalog) BEFORE its KFIG
 * section; B's land in the first chunk's remaining space, beside A's, and
 * only B's KFIG takes the second. In the FORCED build a 40,016-byte record is larger than
 * a 4,064-byte body, so each takes an oversized chunk sized to itself -- two
 * chunks by a different route, and MORE THAN ONE either way, which is the
 * claim the forced build exists to make good on.
 *
 * CAPACITY IS THE CHUNK'S RECORDED `capacity` AT +24, NOT ITS `size`. The
 * two differ whenever `channel_mmap`'s page round-up exceeds the constant,
 * which is every chunk in the forced-chunk build. Deriving this number from
 * `size` here would make the test agree with a bug.
 */
const ARENA_CHUNK_BYTES = arenaChunkBytesFromSource();
const CHUNK_BODY = ARENA_CHUNK_BYTES - 32;
const RECORD_HEADER = 16;
const PAYLOAD = 40_000;
const EXPECTED_CHUNKS = 2;

/** Bytes a record of `payload` occupies: header included, rounded to 8. */
function recordTotal(payload: number): number {
  return Math.ceil((RECORD_HEADER + payload) / 8) * 8;
}

/**
 * A VALID KFIG section of exactly `PAYLOAD` bytes.
 *
 * The seed DECODES what it is handed, so the bytes cannot be filler: this is
 * the real wire format (`crates/fork-codec/src/imported_globals.rs`): a
 * 16-byte header, then records of `24 + module_len + name_len` bytes, owner
 * ids nonzero and unique, import ordinals strictly increasing. The record
 * size is chosen so that a whole number of them fills the payload exactly,
 * and the builder asserts that rather than trusting the arithmetic.
 */
function kfigSection(): Uint8Array {
  const moduleName = new TextEncoder().encode("env");
  const NAME_LEN = 7; // "g" + six digits
  const recordSize = 24 + moduleName.length + NAME_LEN;
  const body = PAYLOAD - 16;
  if (body % recordSize !== 0) {
    throw new Error(`${body} payload bytes is not a whole number of ${recordSize}-byte records`);
  }
  const count = body / recordSize;
  const bytes = new Uint8Array(PAYLOAD);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x46, 0x49, 0x47], 0); // "KFIG"
  view.setUint16(4, 1, true); // version
  view.setUint16(6, 16, true); // header size
  view.setUint32(8, count, true); // record count
  view.setUint32(12, 0, true); // reserved
  let at = 16;
  for (let i = 0; i < count; i += 1) {
    const name = new TextEncoder().encode(`g${String(i).padStart(6, "0")}`);
    view.setUint32(at, recordSize, true);
    view.setUint32(at + 4, i + 1, true); // owner id, nonzero and unique
    bytes[at + 8] = 1; // i32
    bytes[at + 9] = 1; // mutable
    view.setUint16(at + 10, 0, true); // reserved
    view.setUint32(at + 12, moduleName.length, true);
    view.setUint32(at + 16, name.length, true);
    view.setUint32(at + 20, i, true); // import ordinal, strictly increasing
    bytes.set(moduleName, at + 24);
    bytes.set(name, at + 24 + moduleName.length);
    at += recordSize;
  }
  return bytes;
}

describe("arena chunk release", () => {
  it("derives the two-records-need-two-chunks arithmetic from the module's constants", () => {
    // Pinned as its own assertion so a change to a constant fails HERE, with
    // the arithmetic in the message, rather than as a chunk count one test
    // down that could be read as an allocator bug. In the forced build one
    // record does NOT fit a default body and is oversized instead; the second
    // assertion holds in both builds and is the one the chunk count rests on.
    if (ARENA_CHUNK_BYTES === 65_536) {
      expect(recordTotal(PAYLOAD), "one record fits a chunk").toBeLessThanOrEqual(CHUNK_BODY);
    }
    expect(
      EXPECTED_CHUNKS * recordTotal(PAYLOAD),
      "two records do not fit one chunk",
    ).toBeGreaterThan(CHUNK_BODY);
    expect(kfigSection().length, "the section is exactly PAYLOAD bytes").toBe(PAYLOAD);
  });

  it("maps a chunk per record it seeds and unmaps each one as its last record leaves", () => {
    const x = arenaFixture("arena release");
    // The EMPTY state first. NOT `toBeFalsy()`: an unclaimed `fm_stats`
    // field answers -1, and -1 is truthy -- but a `toBe(0)` fails loudly
    // against a module built without the field, which is the case this
    // assertion exists to catch.
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(0);
    // The heap's retained chunk is mapped BEFORE the baseline, so the tallies
    // below count the arena and only the arena (see `warmHeap`).
    x.warmHeap();
    const mmapsBefore = x.mmaps();
    const munmapsBefore = x.munmaps();

    const section = kfigSection();
    expect(x.admit(ACTIVATION_A, { importedGlobals: section }), `admitting activation ${ACTIVATION_A}`)
      .toBe(0);
    expect(x.admit(ACTIVATION_B, { importedGlobals: section }), `admitting activation ${ACTIVATION_B}`)
      .toBe(0);

    // In the default build one chunk holds 65,504 bytes, so the two
    // 40,000-byte KFIG sections take 2 chunks; in the forced build a chunk
    // holds 4,064, so each section is its own oversized chunk. Either way
    // MORE THAN ONE CHUNK EXISTS -- the claim the forced build is here to
    // make good on, asserted by the module's own count rather than by a flag.
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "the record arena chained")
      .toBeGreaterThan(1);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(EXPECTED_CHUNKS);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(1);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(2);
    // The mmap tally is the other half of the seed: a chunk count that rose
    // without a mapping behind it would be a chain of addresses into nothing.
    expect(x.mmaps() - mmapsBefore, "one mmap per chunk, directory included").toBe(
      EXPECTED_CHUNKS + 1,
    );
    expect(x.munmaps() - munmapsBefore, "admission only ever maps").toBe(0);

    // RELEASED ONE AT A TIME, through the dlclose entry. B's KFIG record is
    // alone in the second chunk and everything else shares the first, so B's
    // release must give back exactly the second chunk -- A still holds the
    // first -- and A's the first, with the directory chunk only with the last
    // entry. Asserting only the final zero would pass a sweep that returns
    // everything at the end and nothing in between.
    expect(x.slots(1, ACTIVATION_B, 0), `releasing activation ${ACTIVATION_B}`).toBe(0);
    expect(x.errno()).toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "B's chunk gone, A's kept").toBe(
      EXPECTED_CHUNKS - 1,
    );
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory still holds A").toBe(1);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "one entry left").toBe(1);
    expect(x.munmaps() - munmapsBefore, "B's chunk was actually unmapped").toBe(1);

    expect(x.slots(1, ACTIVATION_A, 0), `releasing activation ${ACTIVATION_A}`).toBe(0);
    expect(x.errno()).toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(0);
    // BOTH HALVES: the list says the chunks are gone, and the tally says the
    // host was asked to take every one of them back -- the records' chunks
    // plus the directory's.
    expect(x.munmaps() - munmapsBefore, "one munmap per chunk released").toBe(
      EXPECTED_CHUNKS + 1,
    );
  });

  it("answers each arena observable from its OWN counter", () => {
    // Three fields returning 0 proves nothing about which counter answered
    // which read -- a collision reads as agreement. So drive the counts APART
    // and require them to differ: one activation with records puts 1 entry in
    // the directory and at least 1 chunk on each chain, and the entry count
    // must track activations while the chunk counts track chunks.
    const x = arenaFixture("arena observables");
    // The release below nulls the activation's table entries STRICTLY; a bare
    // module fixture has no guest to have grown the table.
    x.growResumeTable(8);
    expect(x.admit(ACTIVATION_A, { ordinals: [1, 2, 3] }), `admitting activation ${ACTIVATION_A}`)
      .toBe(0);
    expect(x.admit(ACTIVATION_B, { ordinals: [4, 5, 6] }), `admitting activation ${ACTIVATION_B}`)
      .toBe(0);
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

/**
 * The committed KFGC and KFEC fixtures the `fork-codec` decoder tests use,
 * because admission DECODES both and refuses filler.
 */
const GC_CODEC = new Uint8Array(
  readFileSync(new URL("../../crates/fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url)),
);
const EXCEPTION_CODEC = new Uint8Array(
  readFileSync(
    new URL("../../crates/fork-codec/testdata/exception-codec-wasm32.bin", import.meta.url),
  ),
);

/** An activation admitted with only an exception codec, so the scrub has an entry to drop. */
const ACTIVATION_TAGS_ONLY = 13;
/** An activation nothing admits until the control assertion needs a fresh one. */
const ACTIVATION_FRESH = 14;

describe("GC-codec and exception-tag records", () => {
  it("admits both onto the arena and releases them with the activation", () => {
    const x = arenaFixture("arena codec release");
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(0);
    x.warmHeap(); // the codec decode allocates on the bump; see `warmHeap`
    const mmapsBefore = x.mmaps();
    const munmapsBefore = x.munmaps();

    const both = { gcCodec: GC_CODEC, exceptionCodec: EXCEPTION_CODEC };
    expect(x.admit(ACTIVATION_A, both), "admitting both codecs").toBe(0);

    // The small records share one chunk; the directory took one more.
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(1);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(1);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(1);
    expect(x.mmaps() - mmapsBefore, "one mmap per chunk, directory included").toBe(2);

    // An identical re-admission is a no-op: nothing new is mapped, and
    // nothing is refused. A CONFLICTING codec is refused: an empty section
    // decodes as valid input and differs from the stored bytes.
    expect(x.admit(ACTIVATION_A, both), "identical re-admission").toBe(0);
    expect(x.mmaps() - mmapsBefore, "a re-admission maps nothing").toBe(2);
    expect(
      x.admit(ACTIVATION_A, { ...both, gcCodec: new Uint8Array(0) }),
      "a conflicting GC codec is refused",
    ).toBe(22);
    expect(
      x.admit(ACTIVATION_A, { ...both, exceptionCodec: new Uint8Array(0) }),
      "a conflicting exception codec is refused",
    ).toBe(22);

    // Released through the dlclose entry, which returns 0 freed SLOTS (this
    // activation registered no resume ordinals) and drops both records.
    expect(x.slots(1, ACTIVATION_A, 0), `releasing activation ${ACTIVATION_A}`).toBe(0);
    expect(x.errno()).toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "directory entries").toBe(0);
    expect(x.munmaps() - munmapsBefore, "one munmap per chunk released").toBe(2);
  });

  it("the COW-child scrub drops the GC codec with everything else, and the child's re-admission is a first one", () => {
    // THE RETIRED INHERITED-CODEC CASE. `arena_release_all` once KEPT
    // `REC_KIND_GC_CODEC` on the premise that the native host inherited the
    // parent's codec on a COW child rather than re-seeding it. That premise
    // was false on both hosts (native re-seeds activation 0 after
    // `fm_set_format` on both launch paths; Node re-seeds every replayed
    // activation before anything reads a codec), and keeping the record cost
    // every child up to two inherited 64 KiB mappings. So the scrub is a
    // blind sweep: every chunk goes back, and the child's admission of the
    // SAME codec is accepted as a first one. No entry reads a codec back
    // directly, so "the codec is gone" is observed the way its survival used
    // to be: an admission with a DIFFERENT (empty) section is ACCEPTED where,
    // before the scrub, it was refused with 22 against the stored bytes.
    const x = arenaFixture("arena codec cow scrub");
    x.warmHeap(); // the codec decode allocates on the bump; see `warmHeap`
    expect(
      x.admit(ACTIVATION_A, { gcCodec: GC_CODEC, exceptionCodec: EXCEPTION_CODEC }),
      "admitting A's codecs",
    ).toBe(0);
    expect(
      x.admit(ACTIVATION_TAGS_ONLY, { exceptionCodec: EXCEPTION_CODEC }),
      "admitting a tags-only activation",
    ).toBe(0);
    expect(
      x.admit(ACTIVATION_A, { gcCodec: new Uint8Array(0), exceptionCodec: EXCEPTION_CODEC }),
      "before the scrub a conflicting re-admission is refused",
    ).toBe(22);
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "two activations").toBe(2);
    const held =
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD) + x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD);
    expect(held, "one record chunk and one directory chunk").toBe(2);
    const munmapsBefore = x.munmaps();

    x.setFormat(); // the COW-child scrub

    // Everything is gone, and the mappings went back with it. BOTH HALVES:
    // the counts walk the chains, so an unlinked-but-mapped chunk reads as
    // zero there and only the tally sees it.
    expect(x.stats(ARENA_DIRECTORY_ENTRY_COUNT_FIELD), "no activation survives").toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "no record chunk survives").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "no directory chunk survives").toBe(0);
    expect(x.munmaps() - munmapsBefore, "one unmap per chunk the parent held").toBe(held);

    // The child re-admits, as both hosts do -- here with the GC codec only.
    // Its identical codec is a FIRST admission now (it maps afresh), and a
    // subsequent conflicting one is refused against the bytes the child
    // itself stored -- proof that the child's admission, not an inherited
    // record, is what the module holds.
    const mmapsBefore = x.mmaps();
    expect(x.admit(ACTIVATION_A, { gcCodec: GC_CODEC }), "the child's admission is a first one")
      .toBe(0);
    expect(x.mmaps() - mmapsBefore, "and it maps afresh: nothing was inherited").toBeGreaterThan(0);
    expect(
      x.admit(ACTIVATION_A, { gcCodec: new Uint8Array(0) }),
      "a conflicting codec is refused against the child's own admission",
    ).toBe(22);
    // The control: the same empty section is a legitimate FIRST admission for
    // an activation that has none, so the 22 above is a comparison, not a rule.
    expect(x.admit(ACTIVATION_FRESH, { gcCodec: new Uint8Array(0) }), "an empty first codec")
      .toBe(0);
    // The exception tags were dropped the same way: A now takes an EMPTY
    // exception codec, where before the scrub a different one was refused.
    expect(
      x.admit(ACTIVATION_A, { gcCodec: GC_CODEC, exceptionCodec: new Uint8Array(0) }),
      "A's tags were dropped, so an empty codec is a first one",
    ).toBe(0);
  });
});
