import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  ForkResumeTable,
  type ForkResumeSlots,
  type ForkResumeTarget,
} from "../src/fork-resume-table";

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
    resumeSlot: (activationId, functionOrdinal) => {
      const slot = (x.fm_resume_slots as (o: number, a: number, r: number) => number)(
        0,
        activationId,
        functionOrdinal,
      );
      if (slot < 0) {
        throw new Error(
          `no slot for activation ${activationId} ordinal ${functionOrdinal} ` +
            `(errno ${errno()})`,
        );
      }
      return slot;
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
  table.bindSlots(slots);

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

  return { table, seed, errno };
}

function target(functionOrdinal: number): ForkResumeTarget {
  // Any live Wasm function works: the table only needs a funcref, and the
  // identity of the thunk is irrelevant to the numbering under test.
  const module = new WebAssembly.Module(
    new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00,
      0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
      0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
    ]),
  );
  return {
    functionOrdinal,
    thunk: new WebAssembly.Instance(module).exports.f as WebAssembly.ExportValue,
  };
}

function register(
  h: Harness,
  activationId: number,
  ordinals: readonly number[],
): void {
  h.seed(activationId, ordinals);
  h.table.registerActivation(activationId, ordinals.map(target));
}

describe("ForkResumeTable, numbered by the module", () => {
  it("reserves slot 0 and numbers from 1", () => {
    // Slot 0 is the "no event" sentinel `resume_peek` returns when a replay has
    // nothing to resume, so no thunk may ever live there.
    const h = harness();
    register(h, 0, [4, 9]);
    expect(h.table.slotsOf(0)).toEqual([1, 2]);
    expect(h.table.table.get(0)).toBeNull();
  });

  it("assigns slots by SORTED ordinal, not registration order", () => {
    // The module sorts the catalog, so the slot a thunk gets is a function of
    // its ordinal and nothing else. Passing the targets in descending order
    // proves the host no longer influences it: this class used to sort too, and
    // a test that passed them sorted could not tell the two apart.
    const h = harness();
    h.seed(0, [7, 2, 5]);
    h.table.registerActivation(0, [target(7), target(2), target(5)]);
    // Placed in call order, so the recorded slots follow the ARGUMENT order
    // while the slot VALUES follow the sorted ordinals: 2 -> 1, 5 -> 2, 7 -> 3.
    expect(h.table.slotsOf(0)).toEqual([3, 1, 2]);
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
    expect(h.table.table.get(1)).not.toBeNull();
    h.table.unregisterActivation(0);
    expect(h.table.table.get(1)).toBeNull();
    expect(h.table.table.get(2)).toBeNull();
  });

  it("refuses a repeated ordinal, in the module", () => {
    // Accepting it would place N-1 thunks where N are expected and shift every
    // later slot by one. The refusal is the module's now; this asserts the host
    // surfaces it rather than inventing a slot.
    const h = harness();
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 1, true);
    new DataView(bytes.buffer).setUint32(4, 1, true);
    expect(() => register(h, 0, [1, 1])).toThrow();
  });

  it("refuses to register before a module is bound", () => {
    const table = new ForkResumeTable("unbound");
    expect(() => table.registerActivation(0, [target(0)])).toThrow(
      /no fork module bound/,
    );
  });

  it("rejects a non-function target and a negative ordinal", () => {
    const h = harness();
    h.seed(0, [1]);
    expect(() =>
      h.table.registerActivation(0, [
        { functionOrdinal: 1, thunk: 7 as unknown as WebAssembly.ExportValue },
      ]),
    ).toThrow(/is not a Wasm function/);
    expect(() =>
      h.table.registerActivation(9, [
        { functionOrdinal: -1, thunk: target(0).thunk },
      ]),
    ).toThrow(/invalid resume function ordinal/);
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
    register(h, 1, []); // seeds an empty catalog, places nothing
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
          h.table.table.get(placed[index]!),
          `activation ${activation} ordinal ${ordinal}`,
        ).not.toBeNull();
      });
    }
  });
});
