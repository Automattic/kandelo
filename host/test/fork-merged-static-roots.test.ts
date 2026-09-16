import { describe, expect, it } from "vitest";

import { ForkMergedStaticRoots } from "../src/fork-merged-static-roots";
import { fixture } from "./fork-module-capture-fixture";

/**
 * ONE static-root base map, and what makes a second one unrepresentable.
 *
 * Activation `a`'s roots occupy `[base(a), base(a) + len_a)` in the merged
 * anyref catalog the module imports, and the module turns a static-root recipe
 * into `base(module_activation) + ordinal`. Two things therefore have to agree:
 * WHERE this class writes a root, and WHAT base the module was told.
 *
 * They are the same number here because this class publishes the base it used.
 * A second derivation of the same layout is what went wrong: `worker-main.ts`
 * used to recompute bases at child-install time from the module's decoded
 * graph -- the running sum of each activation's max referenced ordinal, in
 * ascending activation order -- and fill the mirror at THOSE. It agreed with
 * the registered map only when every activation had static roots, its catalog
 * length equalled its max ordinal plus one, and registration order matched
 * ascending activation id. Otherwise the child's roots went where nothing
 * looked for them, and an unfilled slot is a legal null rather than an error.
 * Census 201.
 */

function table(length: number, label: string): WebAssembly.Table {
  const t = new WebAssembly.Table({ element: "anyref" as "anyfunc", initial: length });
  for (let slot = 0; slot < length; slot += 1) {
    t.set(slot, { label, slot } as unknown as WebAssembly.ExportValue);
  }
  return t;
}

function mirror(): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyref" as "anyfunc", initial: 0 });
}

describe("the merged static-root catalog", () => {
  it("fills at the bases it published, for every activation", () => {
    // The property the deleted second map broke. Activation 1's base is NOT
    // zero, so a fill that used a layout of its own would put its roots at
    // slots 0..1 while the module reads 3..4.
    const published: Array<[number, number]> = [];
    const merged = mirror();
    const roots = new ForkMergedStaticRoots(
      merged,
      (activationId, base) => published.push([activationId, base]),
      "test",
    );
    roots.take(0, table(3, "a0"));
    roots.take(1, table(2, "a1"));
    expect(published).toEqual([
      [0, 0],
      [1, 3],
    ]);

    roots.fill();
    for (const [activation, base, length] of [
      [0, 0, 3],
      [1, 3, 2],
    ] as const) {
      for (let ordinal = 0; ordinal < length; ordinal += 1) {
        expect(
          merged.get(base + ordinal),
          `activation ${activation} ordinal ${ordinal}`,
        ).toMatchObject({ label: `a${activation}`, slot: ordinal });
      }
    }
  });

  it("clears every slot it filled, so a finished fork pins nothing", () => {
    const merged = mirror();
    const roots = new ForkMergedStaticRoots(merged, () => {}, "test");
    roots.take(0, table(2, "a0"));
    roots.fill();
    expect(merged.get(0)).not.toBeNull();
    roots.clear();
    expect(merged.get(0)).toBeNull();
    expect(merged.get(1)).toBeNull();
  });

  it("refuses to register one activation twice", () => {
    const roots = new ForkMergedStaticRoots(mirror(), () => {}, "test");
    roots.take(0, table(1, "a0"));
    expect(() => roots.take(0, table(1, "again"))).toThrow(/registered twice/);
  });

  it("MODULE: a second base for one activation is refused", () => {
    // What makes a second base map unrepresentable rather than merely absent.
    // The host publishes each base once, at registration; anything computing a
    // layout later and seeding it back hits this, and
    // `setActivationStaticRootBase` throws on a non-zero errno. If this ever
    // became idempotent, two maps could coexist again in silence.
    const f = fixture();
    const seed = f.x.fm_set_activation_static_root_base as (a: number, b: number) => void;
    seed(1, 0);
    expect(f.errno(), "the first base").toBe(0);
    seed(1, 8);
    expect(f.errno(), "a second base for the SAME activation is EINVAL").toBe(22);
    // A DIFFERENT activation is fine: the map holds one entry per activation.
    seed(2, 8);
    expect(f.errno(), "a base for another activation").toBe(0);
  });
});
