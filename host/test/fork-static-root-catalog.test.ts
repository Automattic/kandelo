import { describe, expect, it } from "vitest";
import {
  ForkStaticRootCatalog,
} from "../src/fork-static-root-catalog";

function externrefTable(values: readonly unknown[]): WebAssembly.Table {
  const table = new WebAssembly.Table({
    element: "externref",
    initial: values.length,
    maximum: values.length,
  });
  values.forEach((value, index) => table.set(index, value));
  return table;
}

describe("ForkStaticRootCatalog", () => {
  it("canonicalizes aliases and resolves the fresh child's root", () => {
    const parentRoot = Object.freeze({ activation: "parent" });
    const parent = new ForkStaticRootCatalog();
    const parentHarvest = externrefTable([parentRoot, parentRoot]);
    parent.register(4, parentHarvest);
    expect(parentHarvest.get(0)).toBeNull();
    expect(parentHarvest.get(1)).toBeNull();

    expect(parent.encode(parentRoot)).toEqual({
      moduleActivation: 4,
      ordinal: 0,
    });

    const childRoot = Object.freeze({ activation: "child" });
    const child = new ForkStaticRootCatalog();
    child.register(4, externrefTable([childRoot, childRoot]));
    const decoded = child.decode(parent.encode(parentRoot)!);

    expect(decoded).toBe(childRoot);
    expect(decoded).not.toBe(parentRoot);
  });

  it("uses the first activation coordinate for an imported shared root", () => {
    const imported = Object.freeze({ imported: true });
    const catalogs = new ForkStaticRootCatalog();
    catalogs.register(2, externrefTable([imported]));
    catalogs.register(7, externrefTable([imported]));

    expect(catalogs.encode(imported)).toEqual({
      moduleActivation: 2,
      ordinal: 0,
    });
    catalogs.unregister(2);
    expect(catalogs.encode(imported)).toEqual({
      moduleActivation: 7,
      ordinal: 0,
    });
  });

  it("rejects duplicate activation registration and invalid recipes", () => {
    const catalogs = new ForkStaticRootCatalog();
    catalogs.register(3, externrefTable([null]));
    expect(() => catalogs.register(3, externrefTable([]))).toThrow(
      /already registered/,
    );
    expect(() =>
      catalogs.decode({ moduleActivation: 3, ordinal: 1 })
    ).toThrow(/out of bounds/);
    expect(() =>
      catalogs.decode({ moduleActivation: 9, ordinal: 0 })
    ).toThrow(/not registered/);
  });
});
