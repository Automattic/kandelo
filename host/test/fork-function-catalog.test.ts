import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { forkFunctionCatalogSnapshotBytes } from "../src/fork-function-catalog-snapshot";
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

describe("bulk function-catalog snapshot", () => {
  it("matches the readable table-only Wasm provider and exposes no mutable bytes", () => {
    const source = readFileSync(new URL("../src/fork-function-catalog-snapshot.ts", import.meta.url), "utf8");
    const start = source.indexOf(" * (module");
    const wat = source.slice(start, source.indexOf(" */", start))
      .split("\n").map(line => line.replace(/^ \* ?/, "")).join("\n");
    const dir = mkdtempSync(join(tmpdir(), "kandelo-function-snapshot-"));
    try {
      writeFileSync(join(dir, "provider.wat"), wat);
      execFileSync("wat2wasm", [join(dir, "provider.wat"), "-o", join(dir, "provider.wasm")]);
      expect(forkFunctionCatalogSnapshotBytes()).toEqual(new Uint8Array(readFileSync(join(dir, "provider.wasm"))));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const bytes = forkFunctionCatalogSnapshotBytes();
    const module = new WebAssembly.Module(bytes as BufferSource);
    expect(WebAssembly.Module.imports(module)).toEqual([
      { module: "env", name: "source", kind: "table" },
      { module: "env", name: "snapshot", kind: "table" },
    ]);
    expect(WebAssembly.Module.exports(module)).toEqual([{ name: "copy", kind: "function" }]);
    bytes.fill(0xff);
    expect(forkFunctionCatalogSnapshotBytes()[0]).toBe(0);
  });

  it("keeps identities and length frozen after source mutation and growth", () => {
    const original = new WebAssembly.Instance(catalogModule()).exports.__wpk_fork_function_catalog as WebAssembly.Table;
    const first = original.get(0), second = original.get(1);
    const source = new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 3 });
    source.set(0, first); source.set(1, second);
    const catalog = new ForkFunctionCatalog();
    catalog.register(0, source);
    source.set(0, second); source.set(1, null); source.grow(1, first);
    expect(catalog.decode({ moduleActivation: 0, ordinal: 0 })).toBe(first);
    expect(catalog.decode({ moduleActivation: 0, ordinal: 1 })).toBe(second);
    expect(catalog.encode(first)).toEqual({ moduleActivation: 0, ordinal: 0 });
    expect(() => catalog.decode({ moduleActivation: 0, ordinal: 2 })).toThrow("out of bounds");
  });

  it("does not leave ghost recipes after a failed registration", () => {
    const source = new WebAssembly.Instance(catalogModule()).exports.__wpk_fork_function_catalog as WebAssembly.Table;
    const value = source.get(0);
    const invalid = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    invalid.set(0, value);
    const catalog = new ForkFunctionCatalog();
    expect(() => catalog.register(7, invalid)).toThrow("non-function entry 1");
    expect(() => catalog.encode(value)).toThrow("absent from");
    expect(() => catalog.decode({ moduleActivation: 7, ordinal: 0 })).toThrow("not registered");
    catalog.register(7, source);
    expect(catalog.encode(value)).toEqual({ moduleActivation: 7, ordinal: 0 });
  });

  it("invalidates an already-used canonical alias when modules change", () => {
    const source = new WebAssembly.Instance(catalogModule()).exports.__wpk_fork_function_catalog as WebAssembly.Table;
    const value = source.get(0);
    const alias = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    alias.set(0, value); alias.set(1, value);
    const catalog = new ForkFunctionCatalog();
    catalog.register(7, alias);
    expect(catalog.encode(value)).toEqual({ moduleActivation: 7, ordinal: 0 });
    catalog.register(2, alias);
    expect(catalog.encode(value)).toEqual({ moduleActivation: 2, ordinal: 0 });
    catalog.unregister(2);
    expect(catalog.encode(value)).toEqual({ moduleActivation: 7, ordinal: 0 });
    catalog.clear();
    expect(() => catalog.encode(value)).toThrow("absent from");
    catalog.register(7, source);
    expect(catalog.decode({ moduleActivation: 7, ordinal: 1 })).toBe(source.get(1));
  });

  it("can register and decode without enumerating functions through JS", () => {
    const source = new WebAssembly.Instance(catalogModule()).exports.__wpk_fork_function_catalog as WebAssembly.Table;
    const catalog = new ForkFunctionCatalog();
    const get = vi.spyOn(WebAssembly.Table.prototype, "get");
    try {
      catalog.register(0, source);
      expect(get).not.toHaveBeenCalled();
      const value = catalog.decode({ moduleActivation: 0, ordinal: 1 });
      expect(get).toHaveBeenCalledTimes(1);
      get.mockClear();
      expect(catalog.encode(value)).toEqual({ moduleActivation: 0, ordinal: 1 });
      expect(get).toHaveBeenCalledTimes(2);
      get.mockClear();
      catalog.encode(value);
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
  });

  it("preserves null, empty-catalog and invalid-ordinal behavior", () => {
    const catalog = new ForkFunctionCatalog();
    catalog.register(0, new WebAssembly.Table({ element: "anyfunc", initial: 0 }));
    expect(catalog.encode(null)).toBeNull();
    expect(catalog.decode(null)).toBeNull();
    expect(() => catalog.encode(1)).toThrow("non-function");
    for (const ordinal of [-1, NaN, 1.5, 0xffff_ffff]) {
      expect(() => catalog.decode({ moduleActivation: 0, ordinal })).toThrow();
    }
  });
});
