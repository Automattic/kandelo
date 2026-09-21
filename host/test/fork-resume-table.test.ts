import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  ForkResumeTable,
  type ForkResumeAssignment,
  type ForkResumeSlots,
} from "../src/fork-resume-table";
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
 * here is the module's NUMBERING and the host's remaining lifetime record --
 * which activations are registered, which slots each holds, and what
 * `dlclose` nulls.
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

interface Harness {
  readonly table: ForkResumeTable;
  /** Seed an activation's catalog, which is what assigns its slots. */
  readonly seed: (activationId: number, ordinals: readonly number[]) => void;
  readonly errno: () => number;
  /** The module's own resume table, which placement grows and fills. */
  readonly resumeTable: WebAssembly.Table;
  /** The memory the module publishes its record buffer into. */
  readonly memory: WebAssembly.Memory;
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
    ptrWidth: 4,
    reserve: () => MODULE_BASE,
    label: "resume slots",
  });
  const x = fm.exports as Record<string, unknown>;
  // The format resets the catalogs, so it has to come first -- the same
  // ordering `ForkModuleContinuationBackend.setup()` documents.
  (x.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);

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
      const ptr = Number(packed & 0xffff_ffffn);
      const count = Number(packed >> 32n);
      const records = new Uint32Array(memory.buffer, ptr, count * 2);
      return {
        ptr,
        count,
        slots: Array.from({ length: count }, (_, i) => records[i * 2 + 1]!),
      };
    },
    releaseResumeSlots: (activationId) => {
      const freed = (x.fm_resume_slots as (o: number, a: number, r: number) => number)(
        1,
        activationId,
        0,
      );
      if (freed < 0) {
        throw new Error(
          `activation ${activationId} had no slots to release (errno ${errno()})`,
        );
      }
      return freed;
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

  return { table, seed, errno, resumeTable, memory };
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
    expect(h.table.slotsOf(0)).toEqual([1, 2]);
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
    expect(h.table.slotsOf(0)).toEqual([1, 2, 3]);
  });

  it("continues numbering across activations", () => {
    const h = harness();
    register(h, 0, [0, 1]);
    register(h, 1, [0, 1]);
    expect(h.table.slotsOf(0)).toEqual([1, 2]);
    expect(h.table.slotsOf(1)).toEqual([3, 4]);
  });

  it("reuses freed slots smallest-first before growing", () => {
    const h = harness();
    register(h, 0, [0, 1]);
    register(h, 1, [0, 1]);
    h.table.unregisterActivation(0);
    register(h, 2, [0, 1]);
    expect(h.table.slotsOf(2)).toEqual([1, 2]);
    expect(h.table.slotsOf(1)).toEqual([3, 4]);
  });

  it("nulls an unregistered activation's entries", () => {
    // A stale thunk at a freed slot is worse than an empty one: the module may
    // hand that slot to another activation before this side places over it.
    const h = harness();
    register(h, 0, [0, 1]);
    expect(h.table.resumeTable.get(1)).not.toBeNull();
    h.table.unregisterActivation(0);
    expect(h.table.resumeTable.get(1)).toBeNull();
    expect(h.table.resumeTable.get(2)).toBeNull();
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
    // `unregisterActivation` refusing one it never placed thunks for. Asking it
    // again in the module was a second opinion with a wrong answer in it.
    const h = harness();
    register(h, 0, [0, 1]);
    register(h, 1, []); // seeds an empty catalog, publishes (0, 0)
    expect(h.table.slotsOf(1)).toEqual([]);
    expect(() => h.table.unregisterActivation(1)).not.toThrow();
    // And the host still refuses one it never registered, which is where that
    // question belongs.
    expect(() => h.table.unregisterActivation(7)).toThrow(/is not registered/);
    // The numbering is undisturbed: an activation holding nothing frees
    // nothing, so the next one does not silently move up.
    register(h, 2, [0]);
    expect(h.table.slotsOf(2)).toEqual([3]);
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
    h.table.unregisterActivation(1); // dlclose A, freeing 3
    register(h, 3, [0, 1]); // dlopen C:     slot 3 (reused), then 6

    expect(h.table.slotsOf(0)).toEqual([1, 2]);
    expect(h.table.slotsOf(2), "B must keep the slots it was placed at").toEqual([
      4, 5,
    ]);
    expect(h.table.slotsOf(3), "C takes the freed slot first").toEqual([3, 6]);

    // And every placement is where the module says, which is the property that
    // makes divergence unrepresentable rather than merely absent here.
    for (const [activation, ordinals] of [
      [0, [0, 1]],
      [2, [0, 1]],
      [3, [0, 1]],
    ] as const) {
      const placed = h.table.slotsOf(activation);
      ordinals.forEach((ordinal, index) => {
        expect(
          h.table.resumeTable.get(placed[index]!),
          `activation ${activation} ordinal ${ordinal}`,
        ).not.toBeNull();
      });
    }
  });
});
