import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  CHANNEL_BASE,
  MMAP_COUNTER,
  MMAP_FLOOR,
  MUNMAP_COUNTER,
  startChannelResponder,
} from "./fork-module-capture-fixture";

/**
 * WHY THIS EXISTS
 *
 * `identity_chunk_count()` was written as the observable for the identity
 * release path -- "a fixed array could not leak; a chunk list can, so the
 * release path needs an observable" -- and its doc comment named
 * `fork-identity-capacity.test.ts` as the test that asserts it returns to zero.
 * That file reads this module's Rust source with a regex and never calls into
 * the module. Nothing ever called `identity_chunk_count`: it had exactly one
 * reference in the repository, its own definition, and every build printed
 * `warning: function identity_chunk_count is never used`.
 *
 * So the function is now reachable through an `fm_stats` field, and this file
 * is the test the corrected comment names. It CALLS THE MODULE -- it does not
 * read its source -- because a source-reading test cannot distinguish a release
 * path that runs from one that does not.
 *
 * THE CHUNK COUNT ALONE IS NOT ENOUGH, and this test asserts both halves.
 * `identity_chunk_count()` walks `IDENTITY_HEAD` and the `next` pointers, so it
 * observes LIST MEMBERSHIP. `release_identity_activation` unlinks a chunk and
 * THEN calls `channel_munmap` best-effort ("a munmap hiccup must not fail an
 * otherwise-complete dlclose"). A chunk that is unlinked but never unmapped
 * therefore reads as zero -- which means the count, on its own, is blind to
 * exactly the leak the observable exists for. So the release is also asserted
 * against the responder's `SYS_MUNMAP` tally: the module's own list says what
 * it still BELIEVES it holds, and the counter says what it actually ASKED the
 * host to give back. Each catches a defect the other cannot, and both are
 * required here rather than split across two files.
 */

/**
 * `fm_stats` field for `identity_chunk_count()`, matching the module's
 * `IDENTITY_CHUNK_COUNT_FIELD`.
 *
 * NOT the first free index. The reference table `fm_stats` indexes is
 * contiguous from 0 and grows by one whenever a counter is appended, and the
 * module's check runs before that table -- so a field adjacent to the table
 * would be claimed by the next counter added and would shadow it. 100 leaves a
 * gap no counter can grow into, which costs nothing because `stats.get()`
 * already answers -1 for any unclaimed field. That -1 is also what makes this
 * test fail loudly rather than silently against a module without the field.
 * `host/test/fork-module-backend.test.ts` pins the two apart.
 */
const IDENTITY_CHUNK_COUNT_FIELD = 100;

/** `fm_set_identity_group` space for imported globals (`IMPORT_SPACE_GLOBAL`). */
const SPACE_GLOBAL = 0;

/** The activation these identities are published under and released with. */
const ACTIVATION = 7;

/**
 * How many identities to publish, DERIVED from the module's own constants
 * rather than asserted.
 *
 * `crates/fork-module/src/lib.rs` declares, beside the chunk layout:
 *
 *     IDENTITY_CHUNK_BYTES  = 65_536
 *     IDENTITY_CHUNK_HEADER = 16
 *     IDENTITY_ENTRY_BYTES  = 16
 *     IDENTITY_ENTRIES_PER_CHUNK = (65_536 - 16) / 16 = 4_095
 *
 * so one 64 KiB chunk holds 4,095 entries. Publishing 4,100 DISTINCT owners
 * therefore fills the first chunk and puts 5 entries in a second:
 * `ceil(4100 / 4095) == 2`. Owners must differ -- a repeated
 * `(space, activation, owner)` UPDATES its entry in place instead of appending,
 * so repeating one owner 4,100 times would never leave the first chunk.
 */
const ENTRIES_PER_CHUNK = (65_536 - 16) / 16;
const IDENTITIES = 4_100;
const EXPECTED_CHUNKS = Math.ceil(IDENTITIES / ENTRIES_PER_CHUNK);

interface FixtureModule {
  /** Read an `fm_stats` field. */
  stats: (field: number) => number;
  /** The responder's running `SYS_MUNMAP` tally, read out of shared memory. */
  munmaps: () => number;
  /** `fm_set_identity_group(space, activation, owner, groupId)`. */
  identity: (
    space: number,
    activation: number,
    owner: number,
    groupId: number,
  ) => void;
  /** `fm_resume_slots(op, activation, ordinal)`; op 1 is the dlclose release. */
  slots: (op: number, activation: number, ordinal: number) => number;
  /** The sticky errno of the most recent export call. */
  errno: () => number;
}

/**
 * Instantiate the shipped fork-module with a SERVICED syscall channel.
 *
 * The channel is not optional here: identity storage is on demand, so a publish
 * issues `SYS_MMAP` through the channel and a module without a responder
 * answers `EINVAL` instead of storing anything. Same shape as the fixture in
 * `host/test/fork-module-imported-globals-seed.test.ts`.
 */
function instantiateFixtureModule(): FixtureModule {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm"))),
    memory,
    ptrWidth: 4,
    reserve: () => 8 * 1024 * 1024,
    label: "identity release",
  });
  const x = fm.exports as Record<string, unknown>;
  // THE TALLIES ARE ASKED FOR EXPLICITLY. They are what the release assertion
  // reads, and a responder started without them keeps answering syscalls while
  // counting nothing -- so the assertion goes red against a zero that says
  // nothing about the module.
  startChannelResponder({
    memory,
    channelBase: CHANNEL_BASE,
    floor: MMAP_FLOOR,
    counters: { mmap: MMAP_COUNTER, munmap: MUNMAP_COUNTER },
  });
  (x.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);
  return {
    stats: (field) => Number((x.fm_stats as (f: number) => bigint)(field)),
    // A fresh view each read: `channel_mmap` GROWS the shared memory, and a
    // `DataView` taken before a growth is not guaranteed to survive it.
    munmaps: () => new DataView(memory.buffer).getUint32(MUNMAP_COUNTER, true),
    identity: x.fm_set_identity_group as FixtureModule["identity"],
    slots: x.fm_resume_slots as FixtureModule["slots"],
    errno: () => (x.fm_last_errno as () => number)(),
  };
}

describe("identity chunk release", () => {
  it("returns every chunk an activation filled when it is released", () => {
    const x = instantiateFixtureModule();
    const chunks = (): number => x.stats(IDENTITY_CHUNK_COUNT_FIELD);

    expect(chunks(), "nothing mapped before any publish").toBe(0);

    for (let owner = 1; owner <= IDENTITIES; owner += 1) {
      x.identity(SPACE_GLOBAL, ACTIVATION, owner, owner);
    }
    expect(x.errno(), `publishing ${IDENTITIES} identities`).toBe(0);

    // The EXACT count, not `toBeGreaterThan(1)`. The constants above fix it at
    // 2, and "more than one" would also be satisfied by a publishing loop that
    // failed partway in some manner that happened to leave two chunks -- which
    // is the state the zero below would then be asserted against.
    expect(
      chunks(),
      `${IDENTITIES} identities at ${ENTRIES_PER_CHUNK} per chunk is ` +
        `${EXPECTED_CHUNKS} chunks`,
    ).toBe(EXPECTED_CHUNKS);

    // Publishing only ever MAPS. If this is not zero, the counter is picking up
    // something other than the release and the delta below could reach its
    // expected value by coincidence.
    const munmapsBefore = x.munmaps();
    expect(munmapsBefore, "munmaps seen while only publishing").toBe(0);

    // op 1 is the per-activation release the host already issues on `dlclose`.
    x.slots(1, ACTIVATION, 0);
    expect(x.errno(), `releasing activation ${ACTIVATION}`).toBe(0);

    expect(
      chunks(),
      "every chunk the activation filled is unlinked and returned; a chunk " +
        "list leaks where the old fixed array could not, so the release is " +
        "the part worth guarding",
    ).toBe(0);

    // AND THE MAPPINGS GO BACK. The assertion above cannot see this. The count
    // walks the list, and `release_identity_activation` unlinks a chunk BEFORE
    // it calls `channel_munmap` -- which is deliberately best-effort, because a
    // munmap hiccup must not fail an otherwise-complete `dlclose`. Delete the
    // munmap call and the list still empties, so the count still reads zero
    // while every 64 KiB mapping the activation ever took is leaked. That is
    // precisely the failure mode "a fixed array could not leak; a chunk list
    // can" names, so the count alone would be an observable blind to the thing
    // it exists for.
    //
    // The expected delta is the same derived number, for the same reason: the
    // activation owned every entry in both chunks, so both empty and both are
    // returned. One `SYS_MUNMAP` per chunk.
    expect(
      x.munmaps() - munmapsBefore,
      `releasing an activation that filled ${EXPECTED_CHUNKS} chunks returns ` +
        "one mapping per chunk; the chunk count above cannot see this, because " +
        "the unlink happens before the best-effort munmap",
    ).toBe(EXPECTED_CHUNKS);
  });
});
