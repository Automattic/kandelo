import { describe, expect, it } from "vitest";

import type { RegisteredForkActivation } from "../src/fork-activations";
import { ForkMergedStaticRoots } from "../src/fork-merged-static-roots";
import { WPK_FORK_STATIC_ROOT_CATALOG_EXPORT } from "../src/generated/abi";
import {
  admitActivation,
  fixture,
  sideTemplate,
  type Fixture,
} from "./fork-module-capture-fixture";
import { bind } from "./support/fork-admission";

/**
 * ONE static-root base map, and it is the module's.
 *
 * Activation `a`'s roots occupy `[base(a), base(a) + len_a)` in the merged
 * anyref catalog the module imports, and the module turns a static-root recipe
 * into `base(module_activation) + ordinal`. Two things therefore have to agree:
 * WHERE the host writes a root, and WHAT base the module reads.
 *
 * They are the same number because the host never derives one: the module
 * places each catalog (`fm_bind_activation`'s row) and the host keeps that
 * base only on the live activation record, which `dlclose` drops. A second
 * derivation of the layout is what went wrong before -- `worker-main`
 * recomputed bases at child install and filled the mirror at THOSE, and the
 * child's roots went where nothing looked for them (census 201).
 */

function table(length: number, label: string): WebAssembly.Table {
  const t = new WebAssembly.Table({ element: "anyref" as "anyfunc", initial: length });
  for (let slot = 0; slot < length; slot += 1) {
    t.set(slot, { label, slot } as unknown as WebAssembly.ExportValue);
  }
  return t;
}

/** A registered activation whose only export is its static-root catalog. */
function activation(
  activationId: number,
  staticRootBase: number,
  catalog: WebAssembly.Table,
): RegisteredForkActivation {
  return {
    activationId,
    staticRootBase,
    instance: { exports: { [WPK_FORK_STATIC_ROOT_CATALOG_EXPORT]: catalog } } as never,
  };
}

/**
 * Place `activation`'s static-root catalog the way registration does: admit
 * it, then bind it with no function catalog. The row's `static_root_base`,
 * or -1 with the refusal in `fm_last_errno`.
 */
function placer(f: Fixture): (activation: number, length: number) => number {
  return (activation, length) => {
    if (activation !== 0) admitActivation(f, activation, { template: sideTemplate(activation) });
    return bind(f.x, f.memory, activation, 0, length)?.statics ?? -1;
  };
}

describe("the merged static-root catalog", () => {
  it("fills every live activation at the base the module placed it", () => {
    const f = fixture();
    const place = placer(f);
    const merged = f.instance.staticRootCatalog;
    const roots = new ForkMergedStaticRoots(merged);
    const live = [activation(0, place(0, 3), table(3, "a0")), activation(1, place(1, 2), table(2, "a1"))];
    for (const { staticRootBase, instance } of live) {
      roots.take(staticRootBase, instance.exports[WPK_FORK_STATIC_ROOT_CATALOG_EXPORT] as WebAssembly.Table);
    }
    expect(f.errno()).toBe(0);
    expect(merged.length, "grown to both slices").toBe(5);

    roots.fill(live);
    for (const [id, base, length] of [[0, 0, 3], [1, 3, 2]] as const) {
      for (let ordinal = 0; ordinal < length; ordinal += 1) {
        expect(merged.get(base + ordinal), `activation ${id} ordinal ${ordinal}`)
          .toMatchObject({ label: `a${id}`, slot: ordinal });
      }
    }
  });

  it("MODULE: the same length answers the same base; a different one is refused", () => {
    const f = fixture();
    const place = placer(f);
    expect(place(1, 4)).toBe(0);
    expect(place(2, 8)).toBe(4);
    expect(place(1, 4), "asked again, the range it holds").toBe(0);
    expect(f.errno()).toBe(0);
    expect(place(1, 5), "a second catalog for one activation").toBe(-1);
    expect(f.errno()).toBe(22);
  });
});
