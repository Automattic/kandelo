/**
 * Tests for WebAssembly dynamic linking support (dylink.0 parsing + loading).
 */

import { describe, it, expect } from "vitest";
import {
  createLongjmpTag,
  parseDylinkSection,
  loadSharedLibrary,
  loadSharedLibrarySync,
  DynamicLinker,
  FORK_CAP_DYLINK_MAIN,
  FORK_CAP_SIDE_ENTRY,
  FORK_CAPABILITIES_SECTION,
  FORK_CAPABILITIES_VERSION,
  forkInstrumentRoleAvailable,
  readForkInstrumentCapabilityClaim,
  readForkInstrumentCapabilities,
  type LoadSharedLibraryOptions,
  type SideModuleForkState,
} from "../src/dylink.ts";
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

/** Compile a tiny side module and prepend the required first dylink.0 section. */
function appendCustomSection(module: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payloadSize = 1 + nameBytes.length + data.length;
  if (nameBytes.length >= 128 || payloadSize >= 128) {
    throw new Error("test custom section helper only supports one-byte LEB lengths");
  }
  const section = new Uint8Array(2 + payloadSize);
  section[0] = 0;
  section[1] = payloadSize;
  section[2] = nameBytes.length;
  section.set(nameBytes, 3);
  section.set(data, 3 + nameBytes.length);
  const out = new Uint8Array(module.length + section.length);
  out.set(module);
  out.set(section, module.length);
  return out;
}

function buildDylinkWat(
  wat: string,
  name: string,
  forkCapabilities?: number,
  tableSize = 0,
  memorySize = 0,
  wat2wasmFlags: string[] = [],
): Uint8Array {
  const dir = join(tmpdir(), "wasm-dylink-wat-test");
  mkdirSync(dir, { recursive: true });
  const watPath = join(dir, `${name}.wat`);
  const wasmPath = join(dir, `${name}.wasm`);
  writeFileSync(watPath, wat);
  execFileSync("wat2wasm", ["--enable-threads", ...wat2wasmFlags, watPath, "-o", wasmPath], {
    stdio: "pipe",
  });
  const module = new Uint8Array(readFileSync(wasmPath));
  const dylinkName = new TextEncoder().encode("dylink.0");
  // Memory-info subsection: size=0, align=0, table size=0, table align=0.
  const payload = new Uint8Array(1 + dylinkName.length + 6);
  payload[0] = dylinkName.length;
  payload.set(dylinkName, 1);
  payload.set([1, 4, memorySize, 0, tableSize, 0], 1 + dylinkName.length);
  const section = new Uint8Array(2 + payload.length);
  section[0] = 0;
  section[1] = payload.length;
  section.set(payload, 2);
  const out = new Uint8Array(module.length + section.length);
  out.set(module.subarray(0, 8), 0);
  out.set(section, 8);
  out.set(module.subarray(8), 8 + section.length);
  return forkCapabilities === undefined
    ? out
    : appendCustomSection(
        out,
        FORK_CAPABILITIES_SECTION,
        new Uint8Array([FORK_CAPABILITIES_VERSION, forkCapabilities]),
      );
}

describe.skipIf(typeof WebAssembly.Tag !== "function")("longjmp tag identity", () => {
  const cases = [
    { ptrWidth: 4 as const, wasmType: "i32", value: 37 },
    { ptrWidth: 8 as const, wasmType: "i64", value: 37n },
  ];

  it.each(cases)(
    "shares one process-owned $wasmType tag with a side module",
    ({ ptrWidth, wasmType, value }) => {
      const wasmBytes = buildDylinkWat(`
        (module
          (import "env" "memory" (memory 1 100 shared))
          (tag $longjmp (import "env" "__c_longjmp") (param ${wasmType}))
          (func (export "throw_longjmp") (param $value ${wasmType})
            local.get $value
            throw $longjmp))
      `, `longjmp-${wasmType}`, undefined, 0, 0, ["--enable-exceptions"]);
      const options = createSideForkLoadOptions();
      const longjmpTag = createLongjmpTag(ptrWidth)!;
      options.ptrWidth = ptrWidth;
      options.longjmpTag = longjmpTag;
      // A same-named main export is not authoritative for this reserved tag.
      options.globalSymbols.set("__c_longjmp", () => 0);

      const lib = loadSharedLibrarySync(`liblongjmp-${wasmType}.so`, wasmBytes, options);
      const throwLongjmp = lib.exports.throw_longjmp as (arg: number | bigint) => void;
      let caught: unknown;
      try {
        throwLongjmp(value);
      } catch (error) {
        caught = error;
      }

      const WasmException = (WebAssembly as typeof WebAssembly & {
        Exception: new (...args: unknown[]) => Error;
      }).Exception;
      expect(caught).toBeInstanceOf(WasmException);
      const exception = caught as Error & {
        is: (tag: WebAssembly.Tag) => boolean;
        getArg: (tag: WebAssembly.Tag, index: number) => unknown;
      };
      expect(exception.is(longjmpTag)).toBe(true);
      expect(exception.getArg(longjmpTag, 0)).toBe(value);
    },
  );

  it.each(cases)(
    "creates one pointer-width-aware $wasmType fallback for standalone linkers",
    ({ ptrWidth, wasmType, value }) => {
      const wasmBytes = buildDylinkWat(`
        (module
          (import "env" "memory" (memory 1 100 shared))
          (tag $longjmp (import "env" "__c_longjmp") (param ${wasmType}))
          (func (export "throw_longjmp") (param $value ${wasmType})
            local.get $value
            throw $longjmp))
      `, `fallback-longjmp-${wasmType}`, undefined, 0, 0, ["--enable-exceptions"]);
      const options = createSideForkLoadOptions();
      options.ptrWidth = ptrWidth;

      const first = loadSharedLibrarySync(`libfallback-${wasmType}-one.so`, wasmBytes, options);
      const fallbackTag = options.longjmpTag!;
      expect(fallbackTag).toBeInstanceOf(WebAssembly.Tag);
      const second = loadSharedLibrarySync(`libfallback-${wasmType}-two.so`, wasmBytes, options);
      expect(options.longjmpTag).toBe(fallbackTag);

      for (const lib of [first, second]) {
        let caught: unknown;
        try {
          (lib.exports.throw_longjmp as (arg: number | bigint) => void)(value);
        } catch (error) {
          caught = error;
        }
        const exception = caught as {
          is: (tag: WebAssembly.Tag) => boolean;
          getArg: (tag: WebAssembly.Tag, index: number) => unknown;
        };
        expect(exception.is(fallbackTag)).toBe(true);
        expect(exception.getArg(fallbackTag, 0)).toBe(value);
      }
    },
  );

  it("rejects a lookalike tag before side-module instantiation", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (tag $longjmp (import "env" "__c_longjmp") (param i32)))
    `, "invalid-longjmp-tag", undefined, 0, 0, ["--enable-exceptions"]);
    const options = createSideForkLoadOptions();
    options.longjmpTag = {} as WebAssembly.Tag;

    expect(() => loadSharedLibrarySync("libinvalid-longjmp.so", wasmBytes, options))
      .toThrow(/__c_longjmp must be an actual WebAssembly\.Tag/);
  });
});

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

function createSideForkLoadOptions(): LoadSharedLibraryOptions {
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

describe("side-module fork contract", () => {
  it("rejects an uninstrumented side module that imports fork", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-uninstrumented");
    const options = createSideForkLoadOptions();
    options.sideModuleFork = {
      setActiveFork: () => {},
      clearActiveFork: () => {},
      invokeMainFork: () => 0,
    };

    expect(() => loadSharedLibrarySync("libbadfork.so", wasmBytes, options))
      .toThrow(/requires complete side-module instrumentation/);
  });

  it("applies the generated ABI transition to a legacy five-export side artifact", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "wpk_fork_unwind_begin") (param i32))
        (func (export "wpk_fork_unwind_end"))
        (func (export "wpk_fork_rewind_begin") (param i32))
        (func (export "wpk_fork_rewind_end"))
        (func (export "wpk_fork_state") (result i32) i32.const 0)
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-generic");
    const options = createSideForkLoadOptions();
    options.sideModuleFork = {
      setActiveFork: () => {},
      clearActiveFork: () => {},
      invokeMainFork: () => 0,
    };

    const load = () => loadSharedLibrarySync("liblegacyfork.so", wasmBytes, options);
    const legacyAllowed = forkInstrumentRoleAvailable(
      { present: false, flags: 0 },
      FORK_CAP_SIDE_ENTRY,
    );
    if (legacyAllowed) {
      expect(load).not.toThrow();
    } else {
      expect(load).toThrow(/versioned side-entry capability/);
    }
  });

  it("makes missing side and main role claims mandatory at ABI 17", () => {
    const wasmBytes = buildDylinkWat(`
      (module (import "env" "memory" (memory 1 100 shared)))
    `, "legacy-capability-absence");
    const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
    const claim = readForkInstrumentCapabilityClaim(module);

    expect(claim).toEqual({ present: false, flags: 0 });
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_SIDE_ENTRY, 16)).toBe(true);
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_DYLINK_MAIN, 16)).toBe(true);
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_SIDE_ENTRY, 17)).toBe(false);
    expect(forkInstrumentRoleAvailable(claim, FORK_CAP_DYLINK_MAIN, 17)).toBe(false);
    expect(forkInstrumentRoleAvailable(
      { present: true, flags: FORK_CAP_SIDE_ENTRY },
      FORK_CAP_DYLINK_MAIN,
      16,
    )).toBe(false);
  });

  it("rejects a marker-present artifact that does not claim side-entry coverage", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "wpk_fork_unwind_begin") (param i32))
        (func (export "wpk_fork_unwind_end"))
        (func (export "wpk_fork_rewind_begin") (param i32))
        (func (export "wpk_fork_rewind_end"))
        (func (export "wpk_fork_state") (result i32) i32.const 0)
        (func (export "side_fork") (result i32) call $fork))
    `, "side-fork-wrong-marker", 0);
    const options = createSideForkLoadOptions();
    options.sideModuleFork = {
      setActiveFork: () => {},
      clearActiveFork: () => {},
      invokeMainFork: () => 0,
    };

    expect(() => loadSharedLibrarySync("libwrongmarker.so", wasmBytes, options))
      .toThrow(/versioned side-entry capability/);
  });

  it("reads the versioned side-entry capability independently", () => {
    const wasmBytes = buildDylinkWat(`
      (module (import "env" "memory" (memory 1 100 shared)))
    `, "side-capability-marker", FORK_CAP_SIDE_ENTRY);
    const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
    expect(readForkInstrumentCapabilityClaim(module)).toEqual({
      present: true,
      flags: FORK_CAP_SIDE_ENTRY,
    });
    expect(readForkInstrumentCapabilities(module)).toBe(FORK_CAP_SIDE_ENTRY);
  });

  it("rejects a malformed marker even during the ABI-16 compatibility window", () => {
    const base = buildDylinkWat(`
      (module (import "env" "memory" (memory 1 100 shared)))
    `, "malformed-capability-marker");
    const wasmBytes = appendCustomSection(
      base,
      FORK_CAPABILITIES_SECTION,
      new Uint8Array([FORK_CAPABILITIES_VERSION]),
    );
    const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);

    expect(() => readForkInstrumentCapabilityClaim(module))
      .toThrow(/malformed kandelo\.wpk_fork\.capabilities custom section/);
  });

  it("reports an explicit stale-main diagnostic for a valid side artifact", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func (export "wpk_fork_unwind_begin") (param i32))
        (func (export "wpk_fork_unwind_end"))
        (func (export "wpk_fork_rewind_begin") (param i32))
        (func (export "wpk_fork_rewind_end"))
        (func (export "wpk_fork_state") (result i32) i32.const 0)
        (func (export "side_fork") (result i32) call $fork))
    `, "side-with-stale-main", FORK_CAP_SIDE_ENTRY);
    const options = createSideForkLoadOptions();
    options.sideModuleForkUnavailableReason =
      "main module lacks the versioned dlopen-main fork capability; rebuild it";

    expect(() => loadSharedLibrarySync("libside.so", wasmBytes, options))
      .toThrow(/main module lacks the versioned dlopen-main fork capability; rebuild it/);
  });

  it("drives repeated instrumented side-module forks through exact states", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (global $state (mut i32) (i32.const 0))
        (global $buf (mut i32) (i32.const 0))
        (func (export "wpk_fork_unwind_begin") (param $addr i32)
          local.get $addr
          global.set $buf
          i32.const 1
          global.set $state)
        (func (export "wpk_fork_unwind_end")
          i32.const 0
          global.set $state)
        (func (export "wpk_fork_rewind_begin") (param $addr i32)
          local.get $addr
          global.set $buf
          i32.const 2
          global.set $state)
        (func (export "wpk_fork_rewind_end")
          i32.const 0
          global.set $state)
        (func (export "wpk_fork_state") (result i32)
          global.get $state)
        (func (export "side_fork_with_local") (result i32)
          i32.const 41
          call $fork
          i32.add))
    `, "side-fork-instrumented", FORK_CAP_SIDE_ENTRY);
    const options = createSideForkLoadOptions();
    let forkResult = 0;
    let active: SideModuleForkState | null = null;
    options.sideModuleFork = {
      setActiveFork: (state) => {
        expect(active).toBeNull();
        active = state;
      },
      clearActiveFork: (state) => {
        expect(active).toBe(state);
        active = null;
      },
      invokeMainFork: () => forkResult,
    };

    const lib = loadSharedLibrarySync("libsidefork.so", wasmBytes, options);
    const sideFork = lib.exports.side_fork_with_local as () => number;
    const state = lib.instance.exports.wpk_fork_state as () => number;
    const unwindEnd = lib.instance.exports.wpk_fork_unwind_end as () => void;
    const rewindBegin = lib.instance.exports.wpk_fork_rewind_begin as (addr: number) => void;

    for (const expectedForkResult of [101, 202]) {
      forkResult = 0;
      expect(sideFork()).toBe(41);
      expect(state()).toBe(1);
      expect(active?.forkBufAddr).toBe(lib.forkBufAddr);

      unwindEnd();
      forkResult = expectedForkResult;
      rewindBegin(lib.forkBufAddr!);
      expect(sideFork()).toBe(41 + expectedForkResult);
      expect(state()).toBe(0);
      expect(active).toBeNull();
    }
  });

  it("allows independent extensions but rejects visible side-to-side fork nesting", () => {
    const options = createSideForkLoadOptions();
    options.sideModuleFork = {
      setActiveFork: () => {},
      clearActiveFork: () => {},
      invokeMainFork: () => 0,
    };
    const provider = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "provider_value") (result i32) i32.const 7))
    `, "fork-provider");
    loadSharedLibrarySync("libprovider.so", provider, options);

    const independentFork = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "fork" (func $fork (result i32)))
        (global $state (mut i32) (i32.const 0))
        (func (export "wpk_fork_unwind_begin") (param i32)
          i32.const 1 global.set $state)
        (func (export "wpk_fork_unwind_end") i32.const 0 global.set $state)
        (func (export "wpk_fork_rewind_begin") (param i32)
          i32.const 2 global.set $state)
        (func (export "wpk_fork_rewind_end") i32.const 0 global.set $state)
        (func (export "wpk_fork_state") (result i32) global.get $state)
        (func (export "side_fork") (result i32) call $fork))
    `, "independent-fork-side", FORK_CAP_SIDE_ENTRY);
    loadSharedLibrarySync("libindependent-fork.so", independentFork, options);

    const visibleConsumer = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "side_fork" (func $side_fork (result i32)))
        (func (export "nested") (result i32) call $side_fork))
    `, "visible-side-consumer");
    expect(() => loadSharedLibrarySync("libnested.so", visibleConsumer, options))
      .toThrow(/fork-capable side-module nesting/);
  });
});

describe("dylink symbol interposition", () => {
  it("preserves first-definition GOT bindings for duplicate function and data exports", () => {
    const firstBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "duplicate_function") (result i32) i32.const 1)
        (global (export "duplicate_data") i32 (i32.const 12)))
    `, "first-duplicate-exports", undefined, 0, 16);
    const secondBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "duplicate_function") (result i32) i32.const 2)
        (global (export "duplicate_data") i32 (i32.const 28)))
    `, "second-duplicate-exports", undefined, 0, 16);
    const options = createSideForkLoadOptions();
    const functionGot = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    const dataGot = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    options.got.set("duplicate_function", functionGot);
    options.got.set("duplicate_data", dataGot);

    const first = loadSharedLibrarySync("libfirst.so", firstBytes, options);
    const firstFunctionBinding = options.globalSymbols.get("duplicate_function");
    const firstDataBinding = options.globalSymbols.get("duplicate_data");
    const firstFunctionGot = functionGot.value;
    const firstDataGot = dataGot.value;
    const tableLengthAfterFirst = options.table.length;

    const second = loadSharedLibrarySync("libsecond.so", secondBytes, options);

    expect(options.globalSymbols.get("duplicate_function")).toBe(firstFunctionBinding);
    expect(options.globalSymbols.get("duplicate_data")).toBe(firstDataBinding);
    expect(functionGot.value).toBe(firstFunctionGot);
    expect(dataGot.value).toBe(firstDataGot);
    expect((first.exports.duplicate_function as () => number)()).toBe(1);
    expect((second.exports.duplicate_function as () => number)()).toBe(2);
    expect((second.exports.duplicate_data as WebAssembly.Global).value)
      .not.toBe((first.exports.duplicate_data as WebAssembly.Global).value);
    expect(options.table.length).toBe(tableLengthAfterFirst + 1);
    expect(options.table.get(options.table.length - 1))
      .toBe(second.exports.duplicate_function);
  });
});

describe("dylink replay layout and rollback", () => {
  it("pads replay to the exact parent table base and rejects overshoot", () => {
    const wasmBytes = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "value") (result i32) i32.const 9))
    `, "replay-table-base");
    const parent = createSideForkLoadOptions();
    parent.table.grow(4);
    const parentLib = loadSharedLibrarySync("liblayout.so", wasmBytes, parent);
    expect(parentLib.tableBase).toBe(5);

    const child = createSideForkLoadOptions();
    const childLib = loadSharedLibrarySync("liblayout.so", wasmBytes, child, {
      memoryBase: parentLib.memoryBase,
      tableBase: parentLib.tableBase,
    });
    expect(childLib.tableBase).toBe(parentLib.tableBase);
    expect(child.table.length).toBe(parent.table.length);

    const overshot = createSideForkLoadOptions();
    overshot.table.grow(parentLib.tableBase);
    expect(() => loadSharedLibrarySync("liblayout.so", wasmBytes, overshot, {
      memoryBase: parentLib.memoryBase,
      tableBase: parentLib.tableBase,
    })).toThrow(/past parent base/);
  });

  it("clears failed-load table entries and records the surviving gap", () => {
    const options = createSideForkLoadOptions();
    const deallocated: Array<{ addr: number; size: number }> = [];
    options.allocateMemory = () => 0x2000;
    options.deallocateMemory = (addr, size) => deallocated.push({ addr, size });
    const invalid = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (import "env" "missing" (func $missing))
        (func (export "never") call $missing))
    `, "failed-table-growth", undefined, 2, 16);
    expect(() => loadSharedLibrarySync("libfailed.so", invalid, options)).toThrow();
    expect(options.table.length).toBe(3);
    expect(options.table.get(1)).toBeNull();
    expect(options.table.get(2)).toBeNull();
    expect(options.loadedLibraries.size).toBe(0);
    expect(deallocated).toEqual([{ addr: 0x2000, size: 16 }]);

    const valid = buildDylinkWat(`
      (module
        (import "env" "memory" (memory 1 100 shared))
        (func (export "survivor") (result i32) i32.const 1))
    `, "surviving-after-failure");
    const survivor = loadSharedLibrarySync("libsurvivor.so", valid, options);
    expect(survivor.tableBase).toBe(3);

    const child = createSideForkLoadOptions();
    const replayed = loadSharedLibrarySync("libsurvivor.so", valid, child, {
      memoryBase: survivor.memoryBase,
      tableBase: survivor.tableBase,
    });
    expect(replayed.tableBase).toBe(3);
    expect(child.table.length).toBe(options.table.length);
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
