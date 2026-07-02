/**
 * Tests for WebAssembly dynamic linking support (dylink.0 parsing + loading).
 */

import { describe, it, expect } from "vitest";
import { parseDylinkSection, loadSharedLibrary, loadSharedLibrarySync, DynamicLinker, type LoadSharedLibraryOptions } from "../src/dylink.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function hasCompiler(): boolean {
  try {
    execFileSync("wasm32posix-cc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Build a shared Wasm library from C source. */
function buildSharedLib(source: string, name: string): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-test");
  mkdirSync(dir, { recursive: true });
  const srcPath = join(dir, `${name}.c`);
  const soPath = join(dir, `${name}.so`);
  writeFileSync(srcPath, source);
  execFileSync("wasm32posix-cc",
    ["-shared", "-fPIC", "-O2", srcPath, "-o", soPath],
    { stdio: "pipe" });
  return new Uint8Array(readFileSync(soPath));
}

describe.skipIf(!hasCompiler())("dylink.0 parser", () => {
  it("parses a simple shared library", () => {
    const wasmBytes = buildSharedLib(
      `int add(int a, int b) { return a + b; }`,
      "simple",
    );
    const metadata = parseDylinkSection(wasmBytes);
    expect(metadata).not.toBeNull();
    expect(metadata!.memorySize).toBe(0); // No static data
    expect(metadata!.tableSize).toBe(0);  // No indirect calls
    expect(metadata!.neededDynlibs).toEqual([]);
  });

  it("parses a library with static data", () => {
    const wasmBytes = buildSharedLib(
      `
      static int counter = 42;
      int get_counter(void) { return counter; }
      void inc_counter(void) { counter++; }
      `,
      "with-data",
    );
    const metadata = parseDylinkSection(wasmBytes);
    expect(metadata).not.toBeNull();
    expect(metadata!.memorySize).toBeGreaterThan(0); // Has static data
  });

  it("returns null for non-shared-library Wasm", () => {
    // A minimal valid Wasm module (magic + version + empty)
    const normalWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic
      0x01, 0x00, 0x00, 0x00, // version
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section
    ]);
    const metadata = parseDylinkSection(normalWasm);
    expect(metadata).toBeNull();
  });

  it("returns null for non-Wasm data", () => {
    expect(parseDylinkSection(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe.skipIf(!hasCompiler())("shared library loading", () => {
  function createLoadOptions(): LoadSharedLibraryOptions {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536, // Stack at end of first page
    );
    return {
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 }, // Start heap at 1KB
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    };
  }

  it("loads a simple shared library and calls exported functions", async () => {
    const wasmBytes = buildSharedLib(
      `
      int add(int a, int b) { return a + b; }
      int multiply(int a, int b) { return a * b; }
      `,
      "math",
    );

    const options = createLoadOptions();
    const lib = await loadSharedLibrary("libmath.so", wasmBytes, options);

    expect(lib.name).toBe("libmath.so");
    expect(lib.exports.add).toBeTypeOf("function");
    expect(lib.exports.multiply).toBeTypeOf("function");

    const add = lib.exports.add as Function;
    const multiply = lib.exports.multiply as Function;
    expect(add(3, 4)).toBe(7);
    expect(multiply(5, 6)).toBe(30);
  });

  it("loads a library with mutable static data", async () => {
    const wasmBytes = buildSharedLib(
      `
      static int counter = 10;
      int get_counter(void) { return counter; }
      void inc_counter(void) { counter++; }
      `,
      "counter",
    );

    const options = createLoadOptions();
    const lib = await loadSharedLibrary("libcounter.so", wasmBytes, options);

    const get = lib.exports.get_counter as Function;
    const inc = lib.exports.inc_counter as Function;

    expect(get()).toBe(10);
    inc();
    expect(get()).toBe(11);
    inc();
    inc();
    expect(get()).toBe(13);
  });

  it("deduplicates already-loaded libraries", async () => {
    const wasmBytes = buildSharedLib(
      `int foo(void) { return 42; }`,
      "dedup",
    );

    const options = createLoadOptions();
    const lib1 = await loadSharedLibrary("libdedup.so", wasmBytes, options);
    const lib2 = await loadSharedLibrary("libdedup.so", wasmBytes, options);

    expect(lib1).toBe(lib2); // Same object reference
  });

  it("allocates separate memory regions for multiple libraries", async () => {
    const lib1Bytes = buildSharedLib(
      `static int data1[256] = {1}; int get1(void) { return data1[0]; }`,
      "region1",
    );
    const lib2Bytes = buildSharedLib(
      `static int data2[256] = {2}; int get2(void) { return data2[0]; }`,
      "region2",
    );

    const options = createLoadOptions();
    const lib1 = await loadSharedLibrary("lib1.so", lib1Bytes, options);
    const lib2 = await loadSharedLibrary("lib2.so", lib2Bytes, options);

    // Memory regions should not overlap
    const end1 = lib1.memoryBase + lib1.metadata.memorySize;
    expect(lib2.memoryBase).toBeGreaterThanOrEqual(end1);

    // Both should work independently
    expect((lib1.exports.get1 as Function)()).toBe(1);
    expect((lib2.exports.get2 as Function)()).toBe(2);
  });

  it("handles function pointers (indirect calls through the table)", async () => {
    // Use a function pointer array to force table entries (prevents inlining)
    const wasmBytes = buildSharedLib(
      `
      typedef int (*op_fn)(int, int);
      static int add(int a, int b) { return a + b; }
      static int sub(int a, int b) { return a - b; }
      static op_fn ops[] = {add, sub};
      int apply(int which, int a, int b) { return ops[which](a, b); }
      `,
      "funcptr",
    );

    const metadata = parseDylinkSection(wasmBytes);
    expect(metadata).not.toBeNull();
    expect(metadata!.tableSize).toBeGreaterThan(0); // Function pointer array needs table slots

    const options = createLoadOptions();
    const lib = await loadSharedLibrary("libfuncptr.so", wasmBytes, options);

    const apply = lib.exports.apply as Function;
    expect(apply(0, 10, 3)).toBe(13); // add
    expect(apply(1, 10, 3)).toBe(7);  // sub
  });

  it("resolves cross-library symbols through globalSymbols", async () => {
    // First library provides a function
    const providerBytes = buildSharedLib(
      `int provided_value(void) { return 42; }`,
      "provider",
    );

    // Second library imports and uses it via extern declaration.
    const consumerBytes = buildSharedLib(
      `
      extern int provided_value(void);
      int doubled_value(void) { return provided_value() * 2; }
      `,
      "consumer",
    );

    const options = createLoadOptions();

    // Load provider first — its exports get registered in globalSymbols
    const provider = await loadSharedLibrary("libprovider.so", providerBytes, options);
    expect((provider.exports.provided_value as Function)()).toBe(42);

    // Load consumer — should resolve provided_value from globalSymbols
    const consumer = await loadSharedLibrary("libconsumer.so", consumerBytes, options);
    expect((consumer.exports.doubled_value as Function)()).toBe(84);
  });
});

describe.skipIf(!hasCompiler())("synchronous loading (loadSharedLibrarySync)", () => {
  function createLoadOptions(): LoadSharedLibraryOptions {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    return {
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    };
  }

  it("loads and calls a shared library synchronously", () => {
    const wasmBytes = buildSharedLib(
      `int square(int x) { return x * x; }`,
      "sync-test",
    );

    const options = createLoadOptions();
    const lib = loadSharedLibrarySync("libsync.so", wasmBytes, options);

    const square = lib.exports.square as Function;
    expect(square(7)).toBe(49);
  });
});

describe.skipIf(!hasCompiler())("DynamicLinker", () => {
  function createLinker(): DynamicLinker {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    return new DynamicLinker({
      memory,
      table,
      stackPointer,
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
  }

  it("dlopen + dlsym + dlclose lifecycle", () => {
    const linker = createLinker();
    const wasmBytes = buildSharedLib(
      `int triple(int x) { return x * 3; }`,
      "dl-lifecycle",
    );

    // dlopen
    const handle = linker.dlopenSync("libtriple.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);
    expect(linker.dlerror()).toBeNull();

    // dlsym returns a table index for functions
    const tripleIdx = linker.dlsym(handle, "triple");
    expect(tripleIdx).not.toBeNull();
    expect(typeof tripleIdx).toBe("number");

    // dlclose
    expect(linker.dlclose(handle)).toBe(0);
  });

  it("uses the supplied allocator for side-module memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    );
    let allocSize = 0;
    let allocAlign = 0;
    const linker = new DynamicLinker({
      memory,
      table,
      stackPointer,
      allocateMemory: (size, align) => {
        allocSize = size;
        allocAlign = align;
        return 0x2000;
      },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    });
    const wasmBytes = buildSharedLib(
      `
      int value = 7;
      int get_value(void) { return value; }
      `,
      "dl-allocator",
    );

    const handle = linker.dlopenSync("liballoc.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);
    expect(allocSize).toBeGreaterThan(0);
    expect(allocAlign).toBeGreaterThan(0);
  });

  it("dlerror reports failures", () => {
    const linker = createLinker();

    // Invalid Wasm bytes
    const handle = linker.dlopenSync("bad.so", new Uint8Array([1, 2, 3]));
    expect(handle).toBe(0);
    expect(linker.dlerror()).not.toBeNull();

    // dlerror clears after read
    expect(linker.dlerror()).toBeNull();
  });

  it("dlsym for non-existent symbol returns null", () => {
    const linker = createLinker();
    const wasmBytes = buildSharedLib(
      `int foo(void) { return 1; }`,
      "dl-nosym",
    );

    const handle = linker.dlopenSync("libfoo.so", wasmBytes);
    expect(handle).toBeGreaterThan(0);

    expect(linker.dlsym(handle, "nonexistent")).toBeNull();
    expect(linker.dlerror()).toContain("not found");
  });

  it("deduplicates handles for the same library", () => {
    const linker = createLinker();
    const wasmBytes = buildSharedLib(
      `int bar(void) { return 2; }`,
      "dl-dedup",
    );

    const h1 = linker.dlopenSync("libbar.so", wasmBytes);
    const h2 = linker.dlopenSync("libbar.so", wasmBytes);
    expect(h1).toBe(h2);
  });
});

function hasWat2Wasm(): boolean {
  try {
    execFileSync("wat2wasm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A minimal dylink.0 section (MEM_INFO: mem/table size + align all 0), which
// marks a module as a side module. wat2wasm emits custom sections last, but the
// loader requires dylink.0 first, so it is injected as raw bytes below rather
// than declared in the WAT.
const DYLINK_SECTION = new Uint8Array([
  0x00, 0x0f,                                            // custom section, size 15
  0x08, 0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b, 0x2e, 0x30, // name "dylink.0"
  0x01, 0x04, 0x00, 0x00, 0x00, 0x00,                   // MEM_INFO subsection
]);

/**
 * Assemble a hand-written side module. Using WAT (rather than a compiled C/C++
 * fixture) lets these tests reproduce the exact import shapes a real C++ side
 * module produces — a self-defined symbol that is *also* an env import, and an
 * env.__cpp_exception tag — which no self-contained C fixture can emit.
 */
function assembleSideModule(wat: string, name: string): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-test");
  mkdirSync(dir, { recursive: true });
  const watPath = join(dir, `${name}.wat`);
  const wasmPath = join(dir, `${name}.wasm`);
  writeFileSync(watPath, wat);
  execFileSync("wat2wasm", ["--enable-exceptions", watPath, "-o", wasmPath],
    { stdio: "pipe" });
  const raw = new Uint8Array(readFileSync(wasmPath));
  const out = new Uint8Array(8 + DYLINK_SECTION.length + (raw.length - 8));
  out.set(raw.subarray(0, 8), 0);                          // magic + version
  out.set(DYLINK_SECTION, 8);                              // dylink.0 first
  out.set(raw.subarray(8), 8 + DYLINK_SECTION.length);
  return out;
}

describe.skipIf(!hasWat2Wasm())("weak self-import handling", () => {
  function createLoadOptions(): LoadSharedLibraryOptions {
    return {
      memory: new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true }),
      table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
      stackPointer: new WebAssembly.Global({ value: "i32", mutable: true }, 65536),
      heapPointer: { value: 1024 },
      globalSymbols: new Map(),
      got: new Map(),
      loadedLibraries: new Map(),
    };
  }

  it("routes an unresolved env import to the module's own export", () => {
    // `self_fn` is both imported from env and exported: the shape wasm-ld emits
    // for an interposable weak C++ symbol the module also defines.
    const lib = loadSharedLibrarySync("self-import.so", assembleSideModule(`
      (module
        (import "env" "self_fn" (func $self_fn (result i32)))
        (func (export "self_fn") (result i32) (i32.const 42))
        (func (export "call_self") (result i32) (call $self_fn)))
    `, "self-import"), createLoadOptions());
    expect((lib.exports.call_self as Function)()).toBe(42);
  });

  it("throws loudly when a self-import has no defining export", () => {
    // A genuinely absent symbol must trap at call time, not silently return 0.
    const lib = loadSharedLibrarySync("missing-import.so", assembleSideModule(`
      (module
        (import "env" "missing_fn" (func $missing (result i32)))
        (func (export "call_missing") (result i32) (call $missing)))
    `, "missing-import"), createLoadOptions());
    expect(() => (lib.exports.call_missing as Function)()).toThrow(/not provided/);
  });

  it("provides the __cpp_exception tag to -fwasm-exceptions modules", () => {
    // C++ side modules import this tag; without the host providing it, the
    // module fails to instantiate with "tag import requires a WebAssembly.Tag".
    const lib = loadSharedLibrarySync("tag.so", assembleSideModule(`
      (module
        (import "env" "__cpp_exception" (tag $exc (param i32)))
        (func (export "noop")))
    `, "tag"), createLoadOptions());
    expect(lib.exports.noop).toBeTypeOf("function");
  });
});
