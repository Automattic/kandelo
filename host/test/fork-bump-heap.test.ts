import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  PAGE,
  arenaFixture,
  type ArenaFixture,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * `HEAP_FLOOR` was 1 MiB of static BSS reserved out of the guest's mmap
 * window whether a program forked or not -- "a fork CHILD re-seeds its
 * catalogs while the kernel is still creating it, and a syscall there is
 * refused". That justification was RETRACTED: forcing every activation's GC
 * codec onto its own mapping during child seeding left
 * `fork-module-gc-replay.test.ts` green. A fork child's `channel_mmap` IS
 * serviced.
 *
 * So the floor is gone and the first chunk comes from `channel_mmap` like
 * any other. The assertion that matters is that a module which has done
 * nothing holds NOTHING -- which is the whole point of the change, and which
 * the 1 MiB static made untestable.
 *
 * THE OBSERVABLE, precisely: the responder's `SYS_MMAP` tally. Seeding a
 * catalog maps arena chunks too (a directory chunk and a record chunk), so
 * the heap's own mapping is the tally LESS the arena's chunk counts, which
 * `fm_stats` reports. `resume_register_impl` is what allocates on the bump
 * (`catalog.to_vec()`), so a three-ordinal catalog is enough to make the
 * allocator grow.
 *
 * WHAT `fm_abort` REACHES: `abort_impl`, which is the vfork BORROWED child's
 * last releasing call before the host returns its module region to the
 * kernel (`worker-main.ts`, "borrowed fork-module region"). The static floor
 * used to go with that region; a mapped chunk does not, so the module returns
 * it there -- and ONLY there. A durable worker keeps its chunks across an
 * abort, because retaining them is what makes growth a one-time cost.
 */

const ACTIVATION = 3;

/**
 * A borrowed workspace for the release test: page 7, free in the fixture's
 * layout (counters on page 5, catalog staging on page 6, `MODULE_BASE` at
 * 8 MiB) and below the responder's range. `set_borrowed_workspace_impl`
 * checks only that the region is non-empty and inside memory; what matters
 * here is that seeding it marks this instance as a BORROWED one.
 */
const BORROWED_WORKSPACE = 7 * PAGE;

function arenaChunks(x: ArenaFixture): number {
  return (
    x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD) +
    x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD)
  );
}

describe("bump heap floor", () => {
  it("holds no heap before the first allocation", () => {
    const x = arenaFixture("bump heap floor");
    // `arenaFixture` has already run `fm_set_format`, the first module call
    // every host makes. Instantiation plus that call maps nothing: the scrub
    // must not allocate before `CHANNEL_BASE` is stored (a bump allocation
    // there has no channel to map through and comes back null), and with no
    // floor there is nothing else to hold.
    expect(x.mmaps(), "instantiation alone maps nothing").toBe(0);

    x.seedActivationCatalog(ACTIVATION, [1, 2, 3]);
    expect(x.errno(), "seeding a three-ordinal catalog").toBe(0);
    expect(
      x.mmaps() - arenaChunks(x),
      "the first real work maps a heap chunk beside the arena's",
    ).toBeGreaterThan(0);
  });

  it("keeps the grown chunk for the next allocation", () => {
    // Retained, so a worker pays for growth once. A second seed that also
    // allocates must be served from the chunk the first one mapped: the tally
    // moves only by whatever arena chunks the second seed adds, which the
    // arena's own counts report.
    const x = arenaFixture("bump heap retention");
    x.seedActivationCatalog(ACTIVATION, [1, 2, 3]);
    expect(x.errno()).toBe(0);
    const mapsAfterFirst = x.mmaps();
    const arenaAfterFirst = arenaChunks(x);

    x.seedActivationCatalog(ACTIVATION + 1, [4, 5, 6]);
    expect(x.errno()).toBe(0);
    expect(x.mmaps() - mapsAfterFirst, "no second heap chunk").toBe(
      arenaChunks(x) - arenaAfterFirst,
    );
  });

  it("keeps a durable worker's chunks across an abort", () => {
    const x = arenaFixture("bump heap abort, durable");
    x.seedActivationCatalog(ACTIVATION, [1, 2, 3]);
    expect(x.errno()).toBe(0);
    const before = x.munmaps();

    (x.x.fm_abort as () => void)();
    expect(x.errno(), "abort is legal from idle").toBe(0);

    expect(x.munmaps() - before, "a durable worker returns nothing").toBe(0);
  });

  it("returns a borrowed instance's chunks on abort", () => {
    const x = arenaFixture("bump heap abort, borrowed");
    (x.x.fm_set_borrowed_workspace as (base: number, bytes: number) => void)(
      BORROWED_WORKSPACE,
      PAGE,
    );
    expect(x.errno(), "seeding the borrowed workspace").toBe(0);
    x.seedActivationCatalog(ACTIVATION, [1, 2, 3]);
    expect(x.errno()).toBe(0);
    const heapChunks = x.mmaps() - arenaChunks(x);
    expect(heapChunks, "the seed grew the heap").toBeGreaterThan(0);
    const unmapsBefore = x.munmaps();
    const mapsBefore = x.mmaps();

    (x.x.fm_abort as () => void)();
    expect(x.errno()).toBe(0);

    // Exactly the heap's chunks, and only those: the arena's records belong
    // to `fm_resume_slots` op 1 and the COW scrub, not to abort.
    expect(x.munmaps() - unmapsBefore, "one unmap per heap chunk").toBe(
      heapChunks,
    );
    expect(arenaChunks(x), "the arena is untouched").toBeGreaterThan(0);
    // The list was FORGOTTEN, not merely unmapped: the next allocation maps
    // afresh rather than reusing an address the kernel took back.
    x.seedActivationCatalog(ACTIVATION + 1, [4, 5, 6]);
    expect(x.errno()).toBe(0);
    expect(x.mmaps() - mapsBefore, "a fresh chunk after the release").toBe(
      heapChunks,
    );
  });
});
