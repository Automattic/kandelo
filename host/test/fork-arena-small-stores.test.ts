import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_OP_ALLOC,
  arenaChunkBytesFromSource,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  arenaFixture,
} from "./fork-module-capture-fixture";
import {
  WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
} from "../src/generated/abi";

/**
 * WHY THIS EXISTS
 *
 * Five small per-activation stores -- the import provenance, the template
 * ids, the table-state elections, and the two catalog-base maps -- were
 * fixed arrays bump-filled within a worker with no release path. Two of them
 * (`ACT_TEMPLATE_ID_COUNT`, `IMPORTED_GLOBAL_PROVENANCE_COUNT`) were not
 * reset even by the COW-child scrub, so a dlopen/dlclose loop monotonically
 * exhausted them: the 65th activation got `E2BIG` for template ids and the
 * 257th coordinate got it for provenance, in a worker that never forked.
 *
 * Now each is an arena record keyed by its activation and released by the
 * same `dlclose` (`fm_resume_slots` op 1) that releases every other record.
 * The first test runs past both of the old numbers; it could not have passed
 * before this task.
 *
 * THE SECOND TEST IS THE ONE TASK 1 COULD NOT WRITE. `arena_extend` sweeps
 * the chunk an outgrown record leaves empty, and every extend test before
 * this reused ONE chunk -- the sweep's cross-chunk half had never executed.
 * The table-state list is the first store to append repeatedly, so it is the
 * first to reach it. Measured on field 101 (the record chunk count) and the
 * `SYS_MUNMAP` tally, NOT on a re-allocation count: a re-allocation count
 * reads the same whether the emptied chunk was returned or not, which is the
 * defect that motivated the sweep.
 */

const EINVAL = 22;
const SPACE_GLOBAL = 0;

/** A record kind no store uses, for `fm_arena_selftest`'s filler record. */
const FILLER_KIND = 99;

/**
 * The list's growth, DERIVED from the module's constants so the assertions
 * below are arithmetic rather than observation:
 *
 *     ARENA_CHUNK_BYTES             = 65_536
 *     ARENA_CHUNK_HEADER            = 32      -> a chunk body is 65,504 bytes
 *     RECORD_HEADER                 = 16, records rounded up to 8
 *     ENTRY_LIST_HEADER             = 8
 *     ENTRY_LIST_FIRST              = 4 entries
 *     TABLE_STATE_OWNER_ENTRY_BYTES = 8
 *
 * The first allocation is `8 + 4 * 8 = 40` payload bytes, and a full list
 * DOUBLES ITS WHOLE PAYLOAD (`arena_extend` by `byte_len`): 40, 80, 160,
 * 320, ... so capacity runs 4, 9, 19, 39, 79, 159, 319, 639, 1_279, 2_559,
 * ... and the push that outgrows capacity `c` creates the next size: push 5
 * makes the 80-byte payload, push 10 the 160, push 20 the 320, and so on --
 * push `c + 1`. The record TOTALS (16 + payload, rounded to 8) are
 *     56, 96, 176, 336, 656, 1_296, 2_576 (push 160), 5_136 (push 320),
 *     10_256 (push 640), 20_496 (push 1_280), 40_976 (push 2_560), ...
 *
 * With a 60,000-byte filler record already in chunk 1 (60,016 with its
 * header), chunk 1 has 5,488 bytes left. The first seven list sizes sum to
 * 56 + 96 + 176 + 336 + 656 + 1,296 + 2,576 = 5,192 and fit; the eighth
 * (5,136, at push 320) does not, so it takes chunk 2. Chunk 1 keeps the
 * filler and is NOT swept. In chunk 2: 5,136 + 10,256 + 20,496 = 35,888
 * fits; the eleventh size (40,976, at push 2,560) does not fit the 29,616
 * left and takes chunk 3 -- and the record it outgrew was the last live byte
 * in chunk 2, so chunk 2 IS swept: the chain reads two chunks, not three,
 * and the munmap tally moves by exactly one.
 *
 * Two earlier drafts of this derivation were wrong and the test said so
 * each time: one grew `8 + 8c` with `c` doubling (push 257 did not cross),
 * one indexed the sizes off by one doubling (a second chunk before push
 * 640). The numbers above were then read off the module with a probe that
 * printed the record's `byte_len` at each push.
 */
const FILLER_BYTES = 60_000;
const PUSH_THAT_CROSSES = 320;
const PUSH_THAT_SWEEPS = 2_560;

const ACTIVATION_FILLER = 21;
const ACTIVATION_LIST = 22;

describe("the five small per-activation stores", () => {
  it("survives more dlopen/dlclose cycles than the old caps allowed", () => {
    const x = arenaFixture("small stores: exhaustion");
    // Two ordinals per activation, so the release has slots to null; the
    // derived free set reuses them, so the table never needs more than this.
    x.growResumeTable(4);
    // THE RESPONDER NEVER REUSES AN ADDRESS. It bump-allocates upward from
    // `MMAP_FLOOR` (12 MiB) and does not grow the 16 MiB memory, so although
    // every cycle below returns both of its chunks, the 33rd cycle's mapping
    // would land past the end of memory and the module would trap writing
    // its header. That is a property of the test rig, not of the module --
    // a kernel reuses freed pages -- so the memory is grown here to hold one
    // directory chunk and one record chunk per cycle, with margin.
    x.memory.grow(300 * 2 + 64);
    for (let act = 1; act <= 300; act += 1) {
      x.seedActivationCatalog(act, [1, 2]);
      expect(x.errno(), `catalog for activation ${act}`).toBe(0);
      x.seedTemplateId(act, act & 0xff);
      expect(x.errno(), `template id for activation ${act}`).toBe(0);
      x.seedTableStateOwner(act, 1, true);
      expect(x.errno(), `table-state owner for activation ${act}`).toBe(0);
      x.seedCatalogBase(act, act * 16);
      expect(x.errno(), `catalog base for activation ${act}`).toBe(0);
      x.seedStaticRootBase(act, act * 4);
      expect(x.errno(), `static-root base for activation ${act}`).toBe(0);
      x.seedImportProvenance(
        SPACE_GLOBAL,
        act,
        0,
        WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
        0,
        BigInt(act),
      );
      expect(x.errno(), `provenance for activation ${act}`).toBe(0);
      x.slots(1, act, 0); // dlclose
      expect(x.errno(), `releasing activation ${act}`).toBe(0);
    }
    // And every chunk goes back.
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "record chunks").toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory chunks").toBe(0);
    // Both halves: the counts walk the chain and cannot see a chunk that was
    // unlinked but never unmapped, so the tally is held beside them. ONE
    // mapping is retained by design and is not the arena's: the bump heap's
    // chunk, mapped by the first seed (the catalog is copied onto the bump)
    // and kept by a durable instance so the next fork does not pay to map it
    // again (`fork-bump-heap.test.ts`). Three hundred cycles of small
    // allocations with no reset between them stay inside that one chunk.
    expect(
      x.mmaps() - x.munmaps(),
      "everything mapped was unmapped, except the heap's one retained chunk",
    ).toBe(1);
  });

  // THE DERIVATION ABOVE IS WRITTEN FOR THE DEFAULT CONSTANT. In the
  // forced-chunk build (`ARENA_CHUNK_BYTES = 4_096`) the filler is an
  // oversized chunk with no room beside it and every list size that fits a
  // 4,064-byte body lands elsewhere, so the push numbers above do not
  // describe that build. The test stands down BY NAME there rather than
  // being weakened: the forced build's own crossing proofs are the record
  // arena's "chained" assertion in `fork-arena-release.test.ts` and the
  // small-frame crossing in `fork-scratch-chain.test.ts`.
  it.skipIf(arenaChunkBytesFromSource() !== 65_536)(
    "returns a chunk an extend empties while a sibling's chunk stays live (default-build derivation)",
    () => {
    const x = arenaFixture("small stores: cross-chunk extend");
    // The sibling: one record that pins chunk 1 for the whole test. The
    // test-only selftest entry is the one way to allocate a record of a
    // chosen size; it is deleted by the task that retires it, at which point
    // this becomes a seeded resume catalog of 15,000 ordinals.
    const filler = x.selftest(ARENA_OP_ALLOC, ACTIVATION_FILLER, FILLER_KIND, FILLER_BYTES);
    expect(x.errno(), "the filler allocates").toBe(0);
    expect(filler, "and has an address").toBeGreaterThan(0n);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "one chunk").toBe(1);
    const munmapsAtStart = x.munmaps();

    for (let owner = 1; owner < PUSH_THAT_CROSSES; owner += 1) {
      x.seedTableStateOwner(ACTIVATION_LIST, owner, true);
      expect(x.errno(), `push ${owner}`).toBe(0);
    }
    expect(
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD),
      "every size up to the seventh fits beside the filler",
    ).toBe(1);

    x.seedTableStateOwner(ACTIVATION_LIST, PUSH_THAT_CROSSES, true);
    expect(x.errno(), `push ${PUSH_THAT_CROSSES}`).toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "the eighth size crosses").toBe(2);
    expect(x.munmaps() - munmapsAtStart, "chunk 1 still holds the filler").toBe(0);

    for (let owner = PUSH_THAT_CROSSES + 1; owner < PUSH_THAT_SWEEPS; owner += 1) {
      x.seedTableStateOwner(ACTIVATION_LIST, owner, true);
      expect(x.errno(), `push ${owner}`).toBe(0);
    }
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "chunk 2 fills").toBe(2);
    expect(x.munmaps() - munmapsAtStart, "nothing returned yet").toBe(0);

    x.seedTableStateOwner(ACTIVATION_LIST, PUSH_THAT_SWEEPS, true);
    expect(x.errno(), `push ${PUSH_THAT_SWEEPS}`).toBe(0);
    // THE SWEEP. The outgrown record was chunk 2's last live byte; the new one
    // is in an oversized chunk 3. Two chunks, not three -- and the tally says
    // the one that left the chain was actually handed back.
    expect(
      x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD),
      "chunk 2 is returned as its last record leaves it",
    ).toBe(2);
    expect(x.munmaps() - munmapsAtStart, "one unmap for the emptied chunk").toBe(1);

    // Every copy preserved every entry: the first, the one that crossed, and
    // the one that swept.
    for (const owner of [1, PUSH_THAT_CROSSES, PUSH_THAT_SWEEPS]) {
      expect(x.tableStateOwned(ACTIVATION_LIST, owner), `owner ${owner} survived`).toBe(1);
    }
    expect(x.tableStateOwned(ACTIVATION_LIST, PUSH_THAT_SWEEPS + 1), "unseeded").toBe(0);

    // Releasing the list returns chunk 3; releasing the filler returns chunk 1.
    x.slots(1, ACTIVATION_LIST, 0);
    expect(x.errno(), "releasing the list").toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "the filler's chunk remains").toBe(1);
    expect(x.munmaps() - munmapsAtStart).toBe(2);
    x.slots(1, ACTIVATION_FILLER, 0);
    expect(x.errno(), "releasing the filler").toBe(0);
    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD)).toBe(0);
    expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD)).toBe(0);
    },
  );

  it("keeps each store's own refusal semantics, which differ on purpose", () => {
    const x = arenaFixture("small stores: refusals");
    const A = 3;

    // Template id: an identical re-seed is idempotent (a COW child re-seeds
    // the hash of the same module's bytes); a DIFFERENT id is two modules
    // under one activation and is refused.
    x.seedTemplateId(A, 0xa5);
    expect(x.errno()).toBe(0);
    x.seedTemplateId(A, 0xa5);
    expect(x.errno(), "same id again").toBe(0);
    x.seedTemplateId(A, 0x5a);
    expect(x.errno(), "a different id under one activation").toBe(EINVAL);

    // Table-state owner: a re-seed UPDATES, deliberately the opposite of the
    // catalogs, because the host re-elects whenever a lower coordinate
    // registers for the same physical table and the incumbent must be
    // demotable. Owner 0 is not a coordinate.
    x.seedTableStateOwner(A, 7, true);
    expect(x.errno()).toBe(0);
    expect(x.tableStateOwned(A, 7)).toBe(1);
    x.seedTableStateOwner(A, 7, false);
    expect(x.errno(), "the demotion is accepted").toBe(0);
    expect(x.tableStateOwned(A, 7), "and takes effect").toBe(0);
    x.seedTableStateOwner(A, 0, true);
    expect(x.errno(), "owner 0").toBe(EINVAL);

    // Provenance: a re-seed of a coordinate UPDATES; an unknown kind is
    // refused, and BASE_IMPORT is a defined kind the host may not publish.
    x.seedImportProvenance(SPACE_GLOBAL, A, 4, WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER, 0, 1n);
    expect(x.errno()).toBe(0);
    x.seedImportProvenance(SPACE_GLOBAL, A, 4, WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER, 0, 2n);
    expect(x.errno(), "the same coordinate again").toBe(0);
    x.seedImportProvenance(SPACE_GLOBAL, A, 5, WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT, 0, 0n);
    expect(x.errno(), "BASE_IMPORT is the election's conclusion, not an input").toBe(EINVAL);
    x.seedImportProvenance(SPACE_GLOBAL, A, 5, 200, 0, 0n);
    expect(x.errno(), "an undefined kind").toBe(EINVAL);

    // The two base maps: seeded once per worker; a re-seed is refused.
    x.seedCatalogBase(A, 100);
    expect(x.errno()).toBe(0);
    x.seedCatalogBase(A, 200);
    expect(x.errno(), "catalog base re-seed").toBe(EINVAL);
    x.seedStaticRootBase(A, 10);
    expect(x.errno()).toBe(0);
    x.seedStaticRootBase(A, 20);
    expect(x.errno(), "static-root base re-seed").toBe(EINVAL);
  });

  it("drops all five in the COW-child scrub so the child can re-seed", () => {
    // The old arrays had three counters the scrub zeroed and two it did not.
    // Now `arena_release_all()` drops every per-activation record but the GC
    // codec, and a child that re-seeds is a child that starts clean: the
    // refusals above must NOT fire on the second seeding.
    const x = arenaFixture("small stores: scrub");
    const A = 4;
    x.seedTemplateId(A, 0x11);
    x.seedTableStateOwner(A, 9, true);
    x.seedCatalogBase(A, 64);
    x.seedStaticRootBase(A, 8);
    x.seedImportProvenance(SPACE_GLOBAL, A, 0, WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER, 0, 7n);
    expect(x.errno()).toBe(0);
    const before = x.munmaps();

    x.setFormat(); // the COW-child scrub

    expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "nothing kept").toBe(0);
    expect(x.munmaps(), "and the chunks went back").toBeGreaterThan(before);
    expect(x.tableStateOwned(A, 9), "the election did not survive").toBe(0);
    // Re-seeds that were refused before the scrub are accepted after it.
    x.seedTemplateId(A, 0x22);
    expect(x.errno(), "a different template id after the scrub").toBe(0);
    x.seedCatalogBase(A, 65);
    expect(x.errno(), "a different catalog base after the scrub").toBe(0);
    x.seedStaticRootBase(A, 9);
    expect(x.errno(), "a different static-root base after the scrub").toBe(0);
  });
});
