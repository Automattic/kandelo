import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";

function catalogModule(): WebAssembly.Module {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-funcref-catalog-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  writeFileSync(wat, `(module
    (table $catalog (export "__wpk_fork_function_catalog") 2 2 funcref)
    (func $first (result i32) i32.const 17)
    (func $second (result i32) i32.const 29)
    (elem (table $catalog) (i32.const 0) func $first $second)
  )`);
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  return new WebAssembly.Module(readFileSync(wasm));
}

describe("ForkFunctionCatalog", () => {
  it("reconstructs the same logical function from a fresh module instance", () => {
    const module = catalogModule();
    const parentInstance = new WebAssembly.Instance(module);
    const childInstance = new WebAssembly.Instance(module);
    const parentTable = parentInstance.exports.__wpk_fork_function_catalog as WebAssembly.Table;
    const childTable = childInstance.exports.__wpk_fork_function_catalog as WebAssembly.Table;

    const parent = new ForkFunctionCatalog();
    parent.register(0, parentTable);
    const recipe = parent.encode(parentTable.get(1));
    expect(recipe).toEqual({ moduleActivation: 0, ordinal: 1 });

    const child = new ForkFunctionCatalog();
    child.register(0, childTable);
    const reconstructed = child.decode(recipe);
    expect(reconstructed).not.toBe(parentTable.get(1));
    expect(reconstructed).toBe(childTable.get(1));
    expect((reconstructed as () => number)()).toBe(29);
  });

  it("keeps side-module activation identities distinct", () => {
    const module = catalogModule();
    const mainTable = new WebAssembly.Instance(module).exports
      .__wpk_fork_function_catalog as WebAssembly.Table;
    const sideTable = new WebAssembly.Instance(module).exports
      .__wpk_fork_function_catalog as WebAssembly.Table;
    const catalog = new ForkFunctionCatalog();
    catalog.register(0, mainTable);
    catalog.register(7, sideTable);

    expect(catalog.encode(mainTable.get(0))).toEqual({
      moduleActivation: 0,
      ordinal: 0,
    });
    expect(catalog.encode(sideTable.get(0))).toEqual({
      moduleActivation: 7,
      ordinal: 0,
    });
  });

  it("reconstructs a side-module funcref written into the shared process table", () => {
    const module = catalogModule();
    const parentMain = new WebAssembly.Instance(module);
    const parentSide = new WebAssembly.Instance(module);
    const parentSideCatalog = parentSide.exports
      .__wpk_fork_function_catalog as WebAssembly.Table;
    const processTable = new WebAssembly.Table({
      element: "anyfunc",
      initial: 1,
      maximum: 1,
    });
    processTable.set(0, parentSideCatalog.get(1));

    const parent = new ForkFunctionCatalog();
    parent.register(
      0,
      parentMain.exports.__wpk_fork_function_catalog as WebAssembly.Table,
    );
    parent.register(9, parentSideCatalog);
    const recipe = parent.encode(processTable.get(0));
    expect(recipe).toEqual({ moduleActivation: 9, ordinal: 1 });

    const childMain = new WebAssembly.Instance(module);
    const childSide = new WebAssembly.Instance(module);
    const childSideCatalog = childSide.exports
      .__wpk_fork_function_catalog as WebAssembly.Table;
    const child = new ForkFunctionCatalog();
    child.register(
      0,
      childMain.exports.__wpk_fork_function_catalog as WebAssembly.Table,
    );
    child.register(9, childSideCatalog);
    const reconstructed = child.decode(recipe);
    expect(reconstructed).toBe(childSideCatalog.get(1));
    expect(reconstructed).not.toBe(processTable.get(0));
    expect((reconstructed as () => number)()).toBe(29);
  });

  it("rejects an unregistered foreign-instance function instead of encoding the wrong module", () => {
    const module = catalogModule();
    const first = new WebAssembly.Instance(module);
    const second = new WebAssembly.Instance(module);
    const catalog = new ForkFunctionCatalog();
    catalog.register(
      0,
      first.exports.__wpk_fork_function_catalog as WebAssembly.Table,
    );
    const foreign = (
      second.exports.__wpk_fork_function_catalog as WebAssembly.Table
    ).get(0);
    expect(() => catalog.encode(foreign)).toThrow("absent from");
  });

  it("rebinds shared function aliases when a module is unloaded", () => {
    const module = catalogModule();
    const source = new WebAssembly.Instance(module).exports
      .__wpk_fork_function_catalog as WebAssembly.Table;
    const value = source.get(0);
    const first = new WebAssembly.Table({
      element: "anyfunc",
      initial: 1,
      maximum: 1,
    });
    const second = new WebAssembly.Table({
      element: "anyfunc",
      initial: 1,
      maximum: 1,
    });
    first.set(0, value);
    second.set(0, value);

    const catalog = new ForkFunctionCatalog();
    catalog.register(7, second);
    catalog.register(2, first);
    expect(catalog.encode(value)).toEqual({
      moduleActivation: 2,
      ordinal: 0,
    });
    catalog.unregister(2);
    expect(catalog.encode(value)).toEqual({
      moduleActivation: 7,
      ordinal: 0,
    });
    catalog.unregister(7);
    expect(() => catalog.encode(value)).toThrow("absent from");
  });
});
