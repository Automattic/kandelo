import { describe, expect, it } from "vitest";

import {
  ARENA_DIRECTORY_CHUNK_COUNT_FIELD,
  ARENA_RECORD_CHUNK_COUNT_FIELD,
  INTERN_KIND_EXTERNREF,
  PAGE,
  arenaFixture,
  captureArena,
  fixture,
  type ArenaFixture,
  type Fixture,
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

/**
 * WHY THIS EXISTS
 *
 * `CapturedExternrefs` is a bump-heap allocation now, and the bump heap is
 * reset at four points during a single fork. `begin_capture_impl` clears the
 * set and calls `begin_unwind_impl`, which may reset the bump -- so a set
 * cleared BEFORE that call, if clearing allocated, would be handed back out
 * to the next allocation. A reclaimed bump region is REUSED, not poisoned,
 * so the failure is a wrong externref lease, not a trap, and nothing else in
 * the suite would see it.
 *
 * The assertion is therefore on the VALUES, not on a count: capture a known
 * set of externrefs and require every one to come back identical -- through
 * more entries than the old 4,096-entry static held, so the set has been
 * moved by bump reallocation several times before it is read.
 *
 * WHAT THE PERTURBATION HAS TO BE, for the batch task: the shipped reset is
 * non-allocating and is also performed inside `reset_bump_heap`, so merely
 * reordering the two calls in `begin_capture_impl` leaves this green. The
 * ordering only carries weight once the reset allocates. To see this red:
 * make `reset_captured_externrefs` allocate (`Vec::with_capacity(8)`),
 * remove it from `reset_bump_heap`, and move it back above
 * `begin_unwind_impl` -- all three, which is the shape the brief described.
 */

const captured = (f: Fixture): { count: number; at: (i: number) => number } => ({
  count: (f.x.fm_captured_externref_count as () => number)(),
  at: (i) => Number((f.x.fm_captured_externref as (i: number) => bigint)(i)),
});

describe("captured externref set on the bump heap", () => {
  it("reports the externrefs it captured, not whatever reused their storage", () => {
    // Distinct handles, more of them than the old static held.
    const known = Array.from({ length: 4_200 }, (_, i) => 11 + i * 7);
    const f = fixture();
    captureArena(
      f,
      known.map((handle) => [INTERN_KIND_EXTERNREF, handle, 0] as const),
    );
    const set = captured(f);
    expect(set.count, "no cap: every intern is recorded").toBe(known.length);
    for (let i = 0; i < known.length; i += 1) {
      expect(set.at(i), `externref ${i}`).toBe(known[i]);
    }
    // One past the end is a truthful failure, not a fabricated handle.
    expect(set.at(known.length)).toBeLessThan(0);
  });

  it("starts the next capture in the same worker from an empty set", () => {
    // The set must not carry a previous capture's handles into the next one,
    // and the next one's storage is cut from the same retained heap chunk the
    // first one used -- which is the reuse a stale buffer would read through.
    const f = fixture();
    captureArena(f, [
      [INTERN_KIND_EXTERNREF, 5, 0],
      [INTERN_KIND_EXTERNREF, 6, 0],
      [INTERN_KIND_EXTERNREF, 7, 0],
    ]);
    expect(captured(f).count).toBe(3);

    // Back to idle; a durable worker keeps its heap chunks across this.
    (f.x.fm_abort as () => void)();
    expect(f.errno()).toBe(0);
    captureArena(f, [[INTERN_KIND_EXTERNREF, 9, 0]]);

    const set = captured(f);
    expect(set.count, "only this capture's handle").toBe(1);
    expect(set.at(0)).toBe(9);
    expect(set.at(1)).toBeLessThan(0);
  });
});
