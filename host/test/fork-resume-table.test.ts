import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  ForkResumeTable,
  type ForkResumeAssignment,
  type ForkResumeSlots,
} from "../src/fork-resume-table";
import { startChannelResponder } from "./fork-module-capture-fixture";
import { standInGuest } from "./support/resume-placement-stand-in";

/**
 * The resume-slot numbering, against the REAL module rather than a regex.
 *
 * The module's `resume_peek` returns an index into the table this class holds,
 * so a slot the two sides number differently makes the guest `call_indirect`
 * into a real function that is the wrong one. Nothing traps; the process simply
 * resumes at the wrong place.
 *
 * # What this file used to be, and why that was not enough
 *
 * It tested a slot ALLOCATOR that lived in `fork-resume-table.ts`, plus one
 * case that matched four REGEXES against `crates/fork-codec/src/replay_journal.rs`
 * to check the module still spelled the same four rules. Both halves passed
 * throughout, and the two numberings could still disagree -- because the rules
 * were never the problem. WHEN each table was built was. The host built one per
 * WORKER and mutated it; the module built a fresh one per FORK, so it never had
 * freed slots to reuse. `dlclose` of a library while a later-loaded one is
 * still open is enough to make them differ, and the last test here reproduces
 * exactly that sequence.
 *
 * There is one allocator now, in the module, and this file drives the real one.
 *
 * # What this file tests after the placement cutover, and what it does not
 *
 * `registerActivation` no longer writes the table. It publishes the module's
 * decision and hands the guest its own `(ptr, count)`; the guest's emitted
 * `__wpk_fork_place_resume_thunks` does the copying. So what is under test
 * here is the module's NUMBERING -- which slots each activation holds, and
 * what `dlclose` nulls.
 *
 * That the host writes NOTHING is asserted directly, by "places NOTHING
 * itself when the guest's shim does nothing". Every other case here would
 * still pass if a host-side placement loop were restored beside the shim --
 * because a second writer producing the same slots is invisible to an
 * assertion about slots -- so the deletion needs a case that fails when the
 * table is correct for the wrong reason.
 *
 * The placement itself is applied by `standInGuest`, a JavaScript stand-in.
 * That is deliberate: these cases need arbitrary catalogs, and a real
 * instrumented guest's ordinals are whatever its own instrumentation
 * produced. Whether the REAL emitted reader agrees with the REAL Rust writer
 * is a different question, answered by `fork-resume-assignment.test.ts`
 * against both real artifacts in one shared memory. Nothing here is evidence
 * about that seam.
 *
 * ORDINALS ARE DENSE HERE, 0..n-1, because that is what the instrumenter
 * emits: `emit_resume_catalog` asserts `func_ordinal == slot`, and the shim
 * uses the ordinal as the catalog table INDEX. Sparse ordinals -- which
 * earlier versions of these cases used -- describe a guest that cannot exist.
 */

const PAGE = 65536;
const MODULE_BASE = 8 * 1024 * 1024;
const CHANNEL_BASE = 4 * PAGE;
const CATALOG_AT = 12 * 1024 * 1024;
/**
 * Where the responder starts handing out mappings: above the staged catalogs
 * at 12 MiB, inside the 16 MiB this harness declares.
 *
 * WHY THERE IS A RESPONDER AT ALL. Seeding a catalog REGISTERS it, and
 * registration allocates the activation's `(ordinal, slot)` record in the
 * arena, which maps its chunks through `CHANNEL_BASE`. With nobody behind that
 * address `channel_syscall` parks in `memory_atomic_wait32` with no deadline,
 * so the file does not fail -- it hangs, and takes its vitest worker with it.
 */
const MMAP_FLOOR = 13 * 1024 * 1024;

interface Harness {
  readonly table: ForkResumeTable;
  /** Seed an activation's catalog, which is what assigns its slots. */
  readonly seed: (activationId: number, ordinals: readonly number[]) => void;
  readonly errno: () => number;
  /** The module's own resume table, which placement grows and fills. */
  readonly resumeTable: WebAssembly.Table;
  /** The memory the module publishes its record buffer into. */
  readonly memory: WebAssembly.Memory;
  /** The module's own exports, for reading its slot record back. */
  readonly exports: Record<string, unknown>;
}

function harness(): Harness {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    ),
    memory,
    reserve: () => MODULE_BASE,
    label: "resume slots",
  });
  const x = fm.exports as Record<string, unknown>;
  startChannelResponder({ memory, channelBase: CHANNEL_BASE, floor: MMAP_FLOOR });
  // The format resets the catalogs, so it has to come first -- the same
  // ordering `ForkModuleContinuationBackend.setup()` documents.
  (x.fm_set_format as (...a: number[]) => void)(4, 0, 0, CHANNEL_BASE);

  const errno = () => (x.fm_last_errno as () => number)();
  const slots: ForkResumeSlots = {
    // THE REAL EXPORT, not a stand-in: the numbering under test is the
    // module's, and this is how production asks for a whole activation of it.
    publishResumeAssignment: (activationId): ForkResumeAssignment => {
      const packed = (x.fm_publish_resume_assignment as (a: number) => bigint)(
        activationId,
      );
      if (packed === -1n) {
        throw new Error(
          `no assignment for activation ${activationId} (errno ${errno()})`,
        );
      }
      return {
        ptr: Number(packed & 0xffff_ffffn),
        count: Number(packed >> 32n),
      };
    },
  };

  const table = new ForkResumeTable("resume slots");
  // The MODULE's table, not one this test minted: it owns and exports it now,
  // so binding anything else here would test a table nothing else can see.
  const resumeTable = x.__wpk_fork_resume_table as unknown as WebAssembly.Table;
  table.bindSlots(slots, resumeTable);

  const seed = (activationId: number, ordinals: readonly number[]): void => {
    const bytes = new Uint8Array(ordinals.length * 4);
    const view = new DataView(bytes.buffer);
    ordinals.forEach((o, i) => view.setUint32(i * 4, o >>> 0, true));
    new Uint8Array(memory.buffer, CATALOG_AT, bytes.length).set(bytes);
    (x.fm_set_activation_resume_catalog as (a: number, p: number, c: number) => void)(
      activationId,
      CATALOG_AT,
      ordinals.length,
    );
    expect(errno(), `seeding activation ${activationId}`).toBe(0);
  };

  return { table, seed, errno, resumeTable, memory, exports: x };
}

/**
 * `dlclose`: the one module release `ForkActivations.forget` issues, which
 * frees the activation's slots with everything else the module holds for it.
 */
function release(h: Harness, activationId: number): void {
  const freed = (h.exports.fm_resume_slots as (o: number, a: number, r: number) => number)(
    1,
    activationId,
    0,
  );
  if (freed < 0) {
    throw new Error(`releasing activation ${activationId} failed (errno ${h.errno()})`);
  }
}

/**
 * The slots one activation holds, READ BACK FROM THE MODULE.
 *
 * This used to be `ForkResumeTable.slotsOf`, a copy the host kept so it could
 * null those entries on `dlclose`. The module nulls them itself now, so the
 * host keeps no copy and there is nothing on that side to ask. Asking the
 * module directly is the stronger question anyway: every case below then
 * checks the allocator's own record rather than a transcription of it.
 *
 * An activation that holds nothing publishes `(0, 0)`, which decodes to the
 * empty list -- the same answer `slotsOf` gave for an activation with an empty
 * catalog, and for one that has been released.
 */
function slotsOf(h: Harness, activationId: number): number[] {
  const packed = (
    h.exports.fm_publish_resume_assignment as (a: number) => bigint
  )(activationId);
  if (packed === -1n) {
    throw new Error(
      `publishing activation ${activationId} failed with errno ${h.errno()}`,
    );
  }
  const ptr = Number(packed & 0xffff_ffffn);
  const count = Number(packed >> 32n);
  if (count === 0) return [];
  // `(ordinal: u32, slot: u32)`, stride 8, so slot `i` is word `i * 2 + 1`.
  const records = new Uint32Array(h.memory.buffer, ptr, count * 2);
  return Array.from({ length: count }, (_, i) => records[i * 2 + 1]!);
}

/** A fresh, distinct Wasm function. The numbering does not read the thunk. */
const THUNK_MODULE = new WebAssembly.Module(
  new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]),
);

function mintThunk(): WebAssembly.ExportValue {
  return new WebAssembly.Instance(THUNK_MODULE).exports.f as WebAssembly.ExportValue;
}

/** A guest declaring `ordinals`, whose placement lands real funcrefs. */
function guest(h: Harness, ordinals: readonly number[]): WebAssembly.Instance {
  const thunks = new Map(ordinals.map((ordinal) => [ordinal, mintThunk()]));
  return standInGuest({
    memory: h.memory,
    resumeTable: h.resumeTable,
    ordinals,
    thunkFor: (ordinal) => {
      const thunk = thunks.get(ordinal);
      if (thunk === undefined) {
        throw new Error(`placement asked for ordinal ${ordinal}, not declared`);
      }
      return thunk;
    },
  });
}

function register(
  h: Harness,
  activationId: number,
  ordinals: readonly number[],
): void {
  h.seed(activationId, ordinals);
  h.table.registerActivation(activationId, guest(h, ordinals));
}

describe("ForkResumeTable, numbered by the module", () => {
  it("reserves slot 0 and numbers from 1", () => {
    // Slot 0 is the "no event" sentinel `resume_peek` returns when a replay has
    // nothing to resume, so no thunk may ever live there.
    const h = harness();
    register(h, 0, [0, 1]);
    expect(slotsOf(h, 0)).toEqual([1, 2]);
    expect(h.table.resumeTable.get(0)).toBeNull();
  });

  it("assigns slots by SORTED ordinal, not seeding order", () => {
    // The module sorts the catalog, so the slot a thunk gets is a function of
    // its ordinal and nothing else. The catalog is seeded out of order to prove
    // the host no longer influences it: this class used to sort too, and a test
    // that seeded them sorted could not tell the two apart.
    //
    // CONTRACT CHANGE, recorded rather than quietly rewritten. This case used
    // to seed [7, 2, 5], pass the targets in that same order, and assert
    // `slotsOf(0) === [3, 1, 2]` -- the recorded slots followed the HOST's
    // argument order while their values followed the module's sorted ordinals.
    // There is no argument order now: the host hands the guest one buffer the
    // module wrote, and the module writes it ascending by ordinal. So the
    // recorded list is the module's order, [1, 2, 3], and the fact the old
    // assertion encoded -- that the VALUES come from the sorted ordinals and
    // not from the order the host saw them -- is still what is being checked.
    const h = harness();
    h.seed(0, [2, 0, 1]);
    h.table.registerActivation(0, guest(h, [2, 0, 1]));
    expect(slotsOf(h, 0)).toEqual([1, 2, 3]);
  });

  it("continues numbering across activations", () => {
    const h = harness();
    register(h, 0, [0, 1]);
    register(h, 1, [0, 1]);
    expect(slotsOf(h, 0)).toEqual([1, 2]);
    expect(slotsOf(h, 1)).toEqual([3, 4]);
  });

  it("reuses freed slots smallest-first before growing", () => {
    const h = harness();
    register(h, 0, [0, 1]);
    register(h, 1, [0, 1]);
    release(h, 0);
    register(h, 2, [0, 1]);
    expect(slotsOf(h, 2)).toEqual([1, 2]);
    expect(slotsOf(h, 1)).toEqual([3, 4]);
  });

  it("nulls an unregistered activation's entries, in the module", () => {
    // A stale thunk at a freed slot is worse than an empty one: the allocator
    // may hand that slot to another activation before anything places over it,
    // and a resume through it lands in a real function of the right type, so
    // nothing traps.
    //
    // THE NULLING IS THE MODULE'S NOW, and this is the case that says so. The
    // host performed it until this change, on the argument that "Rust cannot
    // hold a funcref, therefore the host has to clear the table" -- true
    // premise, false inference, because clearing writes `ref.null func`. There
    // is no `Table.set` left anywhere in `host/src`, so the only thing that
    // can be producing these nulls is the emitted
    // `table.set $resume (ref.null func)` the release drives.
    const h = harness();
    register(h, 0, [0, 1]);
    expect(h.table.resumeTable.get(1)).not.toBeNull();
    release(h, 0);
    expect(h.table.resumeTable.get(1)).toBeNull();
    expect(h.table.resumeTable.get(2)).toBeNull();
  });

  it("nulls PLACED slots when a catalog is re-seeded over them", () => {
    // THE RE-SEED PATH, pinned. `fm_set_activation_resume_catalog` seeds a
    // catalog, and seeding over one already seeded RENUMBERS the activation:
    // `resume_reseed` returns its slots to the free bitmap and assigns fresh
    // ones from the new ordinal set. Anything left in a returned slot is a
    // stale thunk at a slot the allocator is about to hand out again -- a real
    // function of the right type, so a later resume through it runs instead of
    // faulting. Census 194.
    //
    // That path nulls LENIENTLY: it is the one caller that can reach the free
    // routine before any placement, because seeding is what ASSIGNS slots, so
    // a slot past the end of the table provably holds nothing and is skipped
    // rather than trapped on. `fork-module-instance.test.ts` covers that half
    // by seeding two catalogs with no guest anywhere. This covers the half
    // that matters for correctness: when the thunks HAVE been placed, the
    // re-seed clears them.
    const h = harness();
    const setGlobalCatalog = (ordinals: readonly number[]): void => {
      const bytes = new Uint8Array(ordinals.length * 4);
      const view = new DataView(bytes.buffer);
      ordinals.forEach((o, i) => view.setUint32(i * 4, o >>> 0, true));
      new Uint8Array(h.memory.buffer, CATALOG_AT, bytes.length).set(bytes);
      (h.exports.fm_set_activation_resume_catalog as (a: number, p: number, c: number) => void)(
        0,
        CATALOG_AT,
        ordinals.length,
      );
      expect(h.errno(), "seeding activation 0's catalog").toBe(0);
    };

    setGlobalCatalog([0, 1, 2]);
    expect(slotsOf(h, 0)).toEqual([1, 2, 3]);
    h.table.registerActivation(0, guest(h, [0, 1, 2]));
    expect(h.resumeTable.get(1)).not.toBeNull();
    expect(h.resumeTable.get(2)).not.toBeNull();
    expect(h.resumeTable.get(3)).not.toBeNull();

    // Re-seed with a SHORTER catalog, so slots 2 and 3 are freed and not
    // immediately reassigned. A re-seed that did not null would leave live
    // thunks in both.
    setGlobalCatalog([0]);
    expect(slotsOf(h, 0)).toEqual([1]);
    expect(h.resumeTable.get(1), "slot 1 was freed and reassigned").toBeNull();
    expect(h.resumeTable.get(2), "slot 2 was freed").toBeNull();
    expect(h.resumeTable.get(3), "slot 3 was freed").toBeNull();
  });

  it("rejects every op but the release", () => {
    // OP 0 IS DELETED -- the per-coordinate slot query the host used while it
    // placed each thunk itself. The guard that proved it had no callers left
    // was a grep, justified by "a surviving caller fails at INSTANTIATION".
    // That justification assumed the whole ENTRY went; it did not, because op
    // 1 is still the `dlclose` release. So a surviving op-0 caller now gets a
    // quiet -1 with EINVAL instead of failing to instantiate, and this is the
    // assertion that makes the rejection a contract rather than a fallthrough.
    const h = harness();
    h.seed(0, [0, 1]);
    const slots = h.exports.fm_resume_slots as (
      op: number,
      activation: number,
      ordinal: number,
    ) => number;
    const EINVAL = 22;
    // Op 2 is the lenient release of a `dlopen` that failed part way.
    for (const op of [0, 3, 0xffff_ffff]) {
      expect(slots(op, 0, 0), `op ${op}`).toBe(-1);
      expect(h.errno(), `errno after op ${op}`).toBe(EINVAL);
    }
    // And the activation still holds everything it did, so a rejected op is a
    // refusal rather than a partial release.
    expect(slotsOf(h, 0)).toEqual([1, 2]);
  });

  it("refuses a repeated ordinal, in the module", () => {
    // Accepting it would place N-1 thunks where N are expected and shift every
    // later slot by one. The refusal is the module's now; this asserts the host
    // surfaces it rather than inventing a slot.
    const h = harness();
    expect(() => register(h, 0, [0, 0])).toThrow();
  });

  it("refuses to register before a module is bound", () => {
    const h = harness();
    const unbound = new ForkResumeTable("unbound");
    expect(() => unbound.registerActivation(0, guest(h, [0]))).toThrow(
      /no fork module bound/,
    );
    // And the table itself is refused by name, rather than answering undefined
    // and failing later inside a `table.set` that names nothing.
    expect(() => unbound.resumeTable).toThrow(/no fork module bound/);
  });

  it("refuses a guest that cannot place its own thunks", () => {
    // REPLACES "rejects a non-function target and a negative ordinal". Those
    // two assertions guarded a per-thunk argument list that no longer exists:
    // nothing is passed in but the instance, so there is no ordinal for the
    // host to validate and no thunk for it to type-check. What can still be
    // wrong is the INSTANCE, and in exactly one way the old path could not
    // reach -- an artifact instrumented by a toolchain that predates the
    // placement shim. It is refused by name here rather than failing as
    // `undefined is not a function` at the call.
    const h = harness();
    h.seed(0, [0]);
    const withoutShim = { exports: {} } as unknown as WebAssembly.Instance;
    expect(() => h.table.registerActivation(0, withoutShim)).toThrow(
      /exports no __wpk_fork_place_resume_thunks/,
    );
  });

  it("refuses a guest seeded from a different artifact", () => {
    // NEW, and it is the O(1) replacement for a check the per-thunk loop used
    // to make: `forkResumeTargetsFromInstance` read every catalog entry and
    // `resumeSlot` refused a coordinate the module had not assigned, so a
    // module seeded from one artifact and instantiated from another was caught
    // at the first ordinal. The counts are compared instead.
    const h = harness();
    h.seed(0, [0, 1, 2]);
    expect(() => h.table.registerActivation(0, guest(h, [0, 1]))).toThrow(
      /are not the same artifact/,
    );
  });

  it("refuses a guest with thunks the module was seeded with NONE of", () => {
    // THE OTHER DIRECTION, and the one an early return is tempted to skip.
    // "The module assigned nothing" and "this guest has nothing to place" are
    // different facts: an EMPTY seeded catalog against an instance exporting
    // two thunks is a mismatch, not an empty activation. The count comparison
    // has to run at `count === 0` too, or the only thing left to notice is a
    // bare `undefined element` trap inside a fork child later.
    //
    // This is not hypothetical. `crates/host-native`'s own placement helper
    // returned early on `count === 0` -- ahead of this very check -- until it
    // was moved below it, so the native host silently accepted exactly this
    // guest while the JavaScript host named it.
    const h = harness();
    h.seed(0, []);
    expect(() => h.table.registerActivation(0, guest(h, [0, 1]))).toThrow(
      /are not the same artifact/,
    );
  });

  it("places NOTHING itself when the guest's shim does nothing", () => {
    // THE DELETION, ASSERTED. Placement used to be a host loop -- one
    // `fm_resume_slots` op-0 query, one `table.get` and one `table.set` per
    // fork-instrumented function -- and this change's whole purpose is that
    // the host performs none of it. A guest whose shim reports the count it
    // was asked for and writes nothing therefore leaves the resume table
    // exactly as it found it: length 1, holding only the reserved sentinel.
    //
    // This is a guard against restoring the write, not against a broken
    // guest. Every other case in this file would still pass with a host loop
    // running beside the shim, because a second writer producing the same
    // slots is invisible to an assertion about slots. A belt-and-braces
    // placement can only be caught by a case that fails when the table is
    // correct for the wrong reason.
    const h = harness();
    h.seed(0, [0, 1]);
    const inert = {
      exports: {
        __wpk_fork_place_resume_thunks: (_pairs: number, count: number) => count,
        __wpk_fork_resume_catalog: new WebAssembly.Table({
          element: "anyfunc",
          initial: 2,
        }),
      },
    } as unknown as WebAssembly.Instance;
    h.table.registerActivation(0, inert);
    expect(
      h.resumeTable.length,
      "the host grew or wrote the resume table during registration",
    ).toBe(1);
    // The module still holds the assignment, because nothing about placement
    // failing changes what was assigned.
    expect(slotsOf(h, 0)).toEqual([1, 2]);

    // AND RELEASE IS WHERE THE INERT SHIM SURFACES. The module nulls each slot
    // it is about to free, and slot 1 is past the end of a table the shim
    // never grew, so its `table.set` traps on the table's own bounds. That is
    // deliberate: a range guard there would turn "the guest never placed
    // anything" into a silent no-op. The trap arrives as an exception at the
    // release call, exactly as the host's own `Table.set` threw a `RangeError`
    // before this moved.
    expect(() => release(h, 0)).toThrow();
    // NOTHING WAS HALF-RELEASED. The module nulls every slot before it frees
    // any, so a trap in the nulling pass leaves the assignment intact -- and
    // `ForkActivations.forget` drops its record only after the module returns,
    // so both still agree the activation is live and a retry is possible
    // rather than an unrecoverable "not registered".
    expect(slotsOf(h, 0)).toEqual([1, 2]);
    expect(() => release(h, 0)).toThrow();
  });

  it("registers and releases an activation with NO resume targets", () => {
    // THE SECOND REGRESSION, and the one that cost a real fork. A side module
    // with no fork-instrumented function seeds an EMPTY resume catalog --
    // `libneeded-provider.so` in `fork-from-dlopen-side-module-e2e` is exactly
    // that. It holds no slots, so it leaves no entry in the module's
    // assignment, and the release path read "no entries" as "never
    // registered". The child's `dlclose` failed, the child exited non-zero, and
    // the parent reported only that its child had died: no stack, no message,
    // exit 8.
    //
    // Whether an activation was registered is the HOST's question, answered by
    // `ForkActivations.forget` refusing one it does not have. Asking it again
    // in the module was a second opinion with a wrong answer in it.
    const h = harness();
    register(h, 0, [0, 1]);
    register(h, 1, []); // seeds an empty catalog, publishes (0, 0)
    expect(slotsOf(h, 1)).toEqual([]);
    expect(() => release(h, 1)).not.toThrow();
    // The numbering is undisturbed: an activation holding nothing frees
    // nothing, so the next one does not silently move up.
    register(h, 2, [0]);
    expect(slotsOf(h, 2)).toEqual([3]);
  });

  it("keeps ONE numbering across a dlclose that frees a low slot", () => {
    // THE REGRESSION. This sequence is what the two allocators disagreed on:
    //
    //   dlopen A (1 target), dlopen B (2), dlclose A, dlopen C (2), then fork.
    //   host:   B at 4,5   C at 3,6      (3 was freed by A and reused first)
    //   module: B at 3,4   C at 5,6      (fresh per-fork table, ascending id)
    //
    // Three coordinates disagreed, so the guest resumed into another
    // activation's thunk -- a real function of the right type, so nothing
    // trapped. Neither side broke any of the four rules; the host's table had
    // freed slots and the module's, rebuilt per fork, never did.
    //
    // There is one allocator now, so the question this asserts is simply that
    // the placement follows it: B keeps the slots it was given, and C takes the
    // freed one.
    const h = harness();
    register(h, 0, [0, 1]); // main program: slots 1, 2
    register(h, 1, [0]);    // dlopen A:     slot 3
    register(h, 2, [0, 1]); // dlopen B:     slots 4, 5
    release(h, 1); // dlclose A, freeing 3
    register(h, 3, [0, 1]); // dlopen C:     slot 3 (reused), then 6

    expect(slotsOf(h, 0)).toEqual([1, 2]);
    expect(slotsOf(h, 2), "B must keep the slots it was placed at").toEqual([
      4, 5,
    ]);
    expect(slotsOf(h, 3), "C takes the freed slot first").toEqual([3, 6]);

    // And every placement is where the module says, which is the property that
    // makes divergence unrepresentable rather than merely absent here.
    for (const [activation, ordinals] of [
      [0, [0, 1]],
      [2, [0, 1]],
      [3, [0, 1]],
    ] as const) {
      const placed = slotsOf(h, activation);
      ordinals.forEach((ordinal, index) => {
        expect(
          h.table.resumeTable.get(placed[index]!),
          `activation ${activation} ordinal ${ordinal}`,
        ).not.toBeNull();
      });
    }
  });
});
