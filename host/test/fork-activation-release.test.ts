import { describe, expect, it } from "vitest";

import { FORK_ACTIVATION_DRIVE_BINDINGS } from "../src/fork-module-backend";
import {
  admitActivation,
  bindActivation,
  fixture,
  openCapture,
  sideTemplate,
  type Fixture,
} from "./fork-module-capture-fixture";

/** The per-activation drive stride: one slot per binding, as the host binds it. */
const FORK_ACTIVATION_DRIVE_SLOTS = FORK_ACTIVATION_DRIVE_BINDINGS.length;

/**
 * `dlclose` releases an activation through the MODULE, including the slots it
 * holds in the three tables the module imports.
 *
 * The module places each activation's merged function catalog and static-root
 * catalog (the lowest gap live activations leave) and numbers its drive-table
 * stride, so it is the one that clears them: `fm_resume_slots` op 1 nulls all
 * three through an injected `table.fill` and drops the records, and the next
 * placement takes the range again. The host keeps no copy of any range. These
 * tests run the built fork module; the real-worker loop is
 * `fork-dlclose-activation.test.ts`.
 */

const EINVAL = 22;

/** `(module (func (export "f")))`: one real function to put in a funcref slot. */
const FUNCTION = new WebAssembly.Instance(
  new WebAssembly.Module(
    new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x04, 0x01,
      0x02, 0x00, 0x0b,
    ]),
  ),
).exports.f as WebAssembly.ExportValue;

function module(f: Fixture) {
  const call = (name: string) => f.x[name] as (...args: number[]) => number;
  return {
    /**
     * Admit and bind `activation` as a `dlopen` registers it, placing its two
     * merged catalogs at the lengths given; the row's two bases, or -1 each
     * with the refusal in `fm_last_errno`.
     */
    place: (activation: number, funcLen: number, staticLen: number) => {
      expect(admitActivation(f, activation, { template: sideTemplate(activation) })).toBe(0);
      const row = bindActivation(f.x, f.memory, activation, funcLen, staticLen);
      return { func: row?.func ?? -1, statics: row?.statics ?? -1 };
    },
    release: (activation: number, unplaced = false) =>
      call("fm_resume_slots")(unplaced ? 2 : 1, activation, 0),
    slotToRecipe: call("fm_funcref_slot_to_recipe"),
  };
}

/** Grow `table` to `length` and fill every slot, as registration does. */
function fillAll(table: WebAssembly.Table, length: number, value: unknown): void {
  if (table.length < length) table.grow(length - table.length);
  for (let slot = 0; slot < length; slot += 1) table.set(slot, value as never);
}

function nulls(table: WebAssembly.Table, from: number, to: number): boolean[] {
  return Array.from({ length: to - from }, (_, index) => table.get(from + index) === null);
}

describe("releasing an activation through the fork module", () => {
  it("nulls exactly the closed activation's catalog, static-root and drive slots", () => {
    const f = fixture();
    const m = module(f);
    expect(m.place(1, 3, 2)).toEqual({ func: 0, statics: 0 });
    expect(m.place(2, 2, 2)).toEqual({ func: 3, statics: 2 });
    const { functionCatalog, staticRootCatalog, driveTable } = f.instance;
    fillAll(functionCatalog, 5, FUNCTION);
    fillAll(staticRootCatalog, 4, { root: true });
    fillAll(driveTable, 3 * FORK_ACTIVATION_DRIVE_SLOTS, FUNCTION);

    expect(m.release(1), "activation 1 held no resume slots").toBe(0);
    expect(f.errno()).toBe(0);

    expect(nulls(functionCatalog, 0, 5)).toEqual([true, true, true, false, false]);
    expect(nulls(staticRootCatalog, 0, 4)).toEqual([true, true, false, false]);
    const stride = FORK_ACTIVATION_DRIVE_SLOTS;
    expect(nulls(driveTable, 0, stride).every((cleared) => !cleared), "activation 0's stride").toBe(true);
    expect(nulls(driveTable, stride, 2 * stride).every(Boolean), "activation 1's stride").toBe(true);
    expect(nulls(driveTable, 2 * stride, 3 * stride).every((cleared) => !cleared), "activation 2's").toBe(true);
  });

  it("gives a released range to the next placement, so the tables stay bounded", () => {
    const f = fixture();
    const m = module(f);
    // Activation 1 holds functions and no static roots: a zero-length range,
    // which every later placement's lowest gap passes over.
    expect(m.place(1, 10, 0).func).toBe(0);
    const { functionCatalog } = f.instance;
    // 200 open/close cycles of a second library. Each `dlopen` gets a NEW
    // activation id (the host does not reuse ids yet), and still takes the
    // range the previous `dlclose` gave back.
    for (let cycle = 0; cycle < 200; cycle += 1) {
      const id = 2 + cycle;
      const { func: base, statics } = m.place(id, 7, 3);
      expect(base, `cycle ${cycle}`).toBe(10);
      expect(statics, `cycle ${cycle}`).toBe(0);
      fillAll(functionCatalog, base + 7, FUNCTION);
      m.release(id);
      expect(f.errno(), `cycle ${cycle}`).toBe(0);
      expect(functionCatalog.get(base), `cycle ${cycle} cleared`).toBeNull();
    }
    expect(functionCatalog.length, "one catalog of each, not 200").toBe(17);
    // The LOWEST gap that fits: with [0, 10) freed below a live [10, 17), a
    // 7 goes at 0, a 4 does not fit the 3 left and goes past the end, and a 3
    // fills the rest of the gap.
    expect(m.place(300, 7, 0).func).toBe(10);
    m.release(1);
    expect(m.place(301, 7, 0).func).toBe(0);
    expect(m.place(302, 4, 0).func).toBe(17);
    expect(m.place(303, 3, 0).func).toBe(7);
  });

  it("refuses a slot no live range holds, rather than naming a closed library", () => {
    const f = fixture();
    const m = module(f);
    m.place(1, 4, 0);
    m.place(2, 4, 0);
    m.release(1);
    openCapture(f, [2]);
    expect(m.slotToRecipe(5), "a slot of the live range").toBeGreaterThanOrEqual(0);
    expect(f.errno()).toBe(0);
    expect(m.slotToRecipe(1), "a slot of the released range").toBe(-1);
    expect(f.errno()).toBe(EINVAL);
  });

  it("releases a dlopen that failed before its tables were grown (op 2)", () => {
    const f = fixture();
    const m = module(f);
    expect(m.place(5, 64, 64)).toEqual({ func: 0, statics: 0 });
    // Nothing grew the tables: the clamped fill has nothing to clear.
    expect(f.instance.functionCatalog.length).toBe(0);
    expect(m.release(5, true)).toBe(0);
    expect(f.errno()).toBe(0);
    expect(m.place(5, 8, 8).func, "a reused id starts from nothing").toBe(0);
    expect(f.errno()).toBe(0);
  });
});
