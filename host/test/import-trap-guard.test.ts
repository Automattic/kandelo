import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWasmFunctionImports } from "../src/constants";
import {
  guardFunctionImport,
  guardImportObject,
} from "../src/import-trap-guard";

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function name(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function moduleBytes(typeSection: number[], importSection: number[]): ArrayBuffer {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
  ]).buffer;
}

/** `env.local: (i32) -> i32`, `env.throw_tagged: () -> ()`, and a memory. */
function scalarImportsModule(): ArrayBuffer {
  return moduleBytes(
    section(1, [
      2,
      0x60, 1, 0x7f, 1, 0x7f,
      0x60, 0, 0,
    ]),
    section(2, [
      3,
      ...name("env"), ...name("local"), 0, 0,
      ...name("env"), ...name("throw_tagged"), 0, 1,
      ...name("env"), ...name("memory"), 2, 0, 1,
    ]),
  );
}

function typedBoundaryImportsModule(): ArrayBuffer {
  return moduleBytes(
    section(1, [
      1,
      0x60,
      12,
      0x7b, // v128
      0x70, // funcref
      0x6f, // externref
      0x6e, // anyref
      0x6d, // eqref
      0x6c, // i31ref
      0x6b, // structref
      0x6a, // arrayref
      0x69, // exnref
      0x63, 0x00, // (ref null 0)
      0x64, 0x00, // (ref 0)
      // The shared prefix (0x65) is only defined before an ABSTRACT heap
      // type: `heaptype ::= 0x65 ht:absheaptype`. A concrete type carries
      // sharedness on its definition, not on references to it.
      0x63, 0x65, 0x6f, // (ref null (shared extern))
      2,
      0x68, // contref
      0x74, // noexnref
    ]),
    section(2, [
      1,
      ...name("typed"), ...name("all"), 0, 0,
    ]),
  );
}

function compileWat(
  directory: string,
  stem: string,
  source: string,
  flags: readonly string[] = [],
): ArrayBuffer {
  const watPath = join(directory, `${stem}.wat`);
  const wasmPath = join(directory, `${stem}.wasm`);
  writeFileSync(watPath, source);
  execFileSync("wat2wasm", [...flags, watPath, "-o", wasmPath]);
  const file = readFileSync(wasmPath);
  return file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
}

function thrownBy(fn: () => unknown): unknown {
  let didThrow = false;
  let thrown: unknown;
  try {
    fn();
  } catch (value) {
    didThrow = true;
    thrown = value;
  }
  expect(didThrow).toBe(true);
  return thrown;
}

function localImport() {
  const imported = readWasmFunctionImports(scalarImportsModule())
    .find((entry) => entry.name === "local");
  if (!imported) throw new Error("fixture lost env.local");
  return imported;
}

describe("import trap guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("retains complete scalar, vector, abstract, and concrete import types", () => {
    const [imported] = readWasmFunctionImports(
      typedBoundaryImportsModule(),
    );
    expect(imported?.signature.params).toEqual([
      0x7b, 0x70, 0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x69,
      0x63, 0x64, 0x63,
    ]);
    expect(imported?.signature.paramTypes).toEqual([
      { code: 0x7b, shared: false },
      { code: 0x70, shared: false },
      { code: 0x6f, shared: false },
      { code: 0x6e, shared: false },
      { code: 0x6d, shared: false },
      { code: 0x6c, shared: false },
      { code: 0x6b, shared: false },
      { code: 0x6a, shared: false },
      { code: 0x69, shared: false },
      { code: 0x63, heapType: 0, shared: false },
      { code: 0x64, heapType: 0, shared: false },
      { code: 0x63, heapType: -17, shared: true },
    ]);
    expect(imported?.signature.resultTypes).toEqual([
      { code: 0x68, shared: false },
      { code: 0x74, shared: false },
    ]);
  });

  it("re-raises a nested Wasm trap as a fresh trap, not the JS error object", () => {
    const original = new WebAssembly.RuntimeError("nested Wasm trap");
    const guarded = guardFunctionImport(localImport(), () => {
      throw original;
    });

    const trapped = thrownBy(() => guarded(1));
    expect(trapped).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(trapped).not.toBe(original);
  });

  it("passes returns, receivers, and ordinary throws through exactly", () => {
    const receiver = { base: 40 };
    const guarded = guardFunctionImport(
      localImport(),
      function (this: { base: number }, value: number): number {
        return this.base + value;
      },
    );
    expect(Reflect.apply(guarded, receiver, [2])).toBe(42);

    for (const value of [
      Object.freeze({ workerOnly: () => 1 }),
      new RangeError("ordinary"),
      -0,
      "exact primitive",
      Symbol("exact"),
      undefined,
    ]) {
      const throwing = guardFunctionImport(localImport(), () => {
        throw value;
      });
      expect(Object.is(thrownBy(() => throwing(0)), value)).toBe(true);
    }
  });

  it("logs a trap's origin only when trap diagnostics are enabled", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const guarded = guardFunctionImport(localImport(), () => {
      throw new WebAssembly.RuntimeError("origin marker");
    });

    thrownBy(() => guarded(0));
    expect(error).not.toHaveBeenCalled();

    vi.stubEnv("WASM_POSIX_FORK_TRAP_DIAG", "1");
    thrownBy(() => guarded(0));
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /ordinal=0: origin marker/,
    );
  });

  it("guards every function import and leaves the rest of the object intact", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const local = (value: number): number => value + 1;
    const unrelated = (): number => 7;
    const imports: WebAssembly.Imports = {
      env: { local, throw_tagged: () => {}, memory },
      other: { unrelated },
    };
    const guarded = guardImportObject(scalarImportsModule(), imports);

    expect(guarded.env!.local).not.toBe(local);
    expect((guarded.env!.local as CallableFunction)(4)).toBe(5);
    expect(guarded.env!.memory).toBe(memory);
    // Modules the artifact never imports from are not rewritten.
    expect(guarded.other).toBe(imports.other);
    // The caller's import object is not mutated.
    expect(imports.env!.local).toBe(local);
  });

  it("keeps v128 and exnref imports on a direct Wasm-to-Wasm boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-typed-import-"));
    try {
      const vectorProviderBytes = compileWat(
        directory,
        "vector-provider",
        `(module
          (func (export "id") (param v128) (result v128)
            local.get 0))`,
      );
      const vectorConsumerBytes = compileWat(
        directory,
        "vector-consumer",
        `(module
          (import "m" "id" (func $id (param v128) (result v128)))
          (func (export "run") (result i32)
            v128.const i32x4 1 2 3 4
            call $id
            i32x4.extract_lane 2))`,
      );
      const exceptionProviderBytes = compileWat(
        directory,
        "exception-provider",
        `(module
          (func (export "id") (param exnref) (result exnref)
            local.get 0))`,
        ["--enable-exceptions"],
      );
      const exceptionConsumerBytes = compileWat(
        directory,
        "exception-consumer",
        `(module
          (import "m" "id" (func $id (param exnref) (result exnref)))
          (tag $tag (param i32))
          (func (export "run") (result i32)
            (block $done (result i32)
              (try_table (result i32) (catch $tag $done)
                (block $captured (result i32 exnref)
                  (try_table (result i32 exnref)
                    (catch_ref $tag $captured)
                    i32.const 77
                    throw $tag))
                call $id
                throw_ref))))`,
        ["--enable-exceptions"],
      );

      const vectorProvider = new WebAssembly.Instance(
        new WebAssembly.Module(vectorProviderBytes),
      );
      const vectorId = vectorProvider.exports.id as CallableFunction;
      const guardedVector = guardImportObject(
        vectorConsumerBytes,
        { m: { id: vectorId } },
      );
      expect(guardedVector.m!.id).toBe(vectorId);
      const vectorConsumer = new WebAssembly.Instance(
        new WebAssembly.Module(vectorConsumerBytes),
        guardedVector,
      );
      expect((vectorConsumer.exports.run as CallableFunction)()).toBe(3);

      const exceptionProvider = new WebAssembly.Instance(
        new WebAssembly.Module(exceptionProviderBytes),
      );
      const exceptionId = exceptionProvider.exports.id as CallableFunction;
      const guardedException = guardImportObject(
        exceptionConsumerBytes,
        { m: { id: exceptionId } },
      );
      expect(guardedException.m!.id).toBe(exceptionId);
      const exceptionConsumer = new WebAssembly.Instance(
        new WebAssembly.Module(exceptionConsumerBytes),
        guardedException,
      );
      expect((exceptionConsumer.exports.run as CallableFunction)()).toBe(77);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves an imported-tag exception thrown through a guarded import", () => {
    const exception = new WebAssembly.Exception(
      new WebAssembly.Tag({ parameters: [] }),
      [],
    );
    const guarded = guardImportObject(scalarImportsModule(), {
      env: {
        local: (value: number) => value,
        throw_tagged: () => {
          throw exception;
        },
      },
    });

    const throwTagged = guarded.env!.throw_tagged as CallableFunction;
    expect(thrownBy(() => throwTagged())).toBe(exception);
  });

  it("keeps imported-tag Catch and CatchRef matching on the real Wasm boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-import-tag-"));
    try {
      const bytes = compileWat(
        directory,
        "import-tag",
        `(module
        (import "env" "tag" (tag $tag (param i32)))
        (import "env" "throw_tagged" (func $throw_tagged))
        (import "env" "throw_any" (func $throw_any))
        (func (export "catch_plain") (result i32)
          (block $caught (result i32)
            (try_table (result i32) (catch $tag $caught)
              call $throw_tagged
              i32.const -1)))
        (func (export "catch_ref") (result i32)
          (block $caught (result i32 exnref)
            (try_table (result i32 exnref) (catch_ref $tag $caught)
              call $throw_tagged
              i32.const -1
              ref.null exn))
          drop)
        (func (export "catch_all_rethrow")
          (block $caught (result exnref)
            (try_table (result exnref) (catch_all_ref $caught)
              call $throw_any
              unreachable))
          (throw_ref)))`,
        ["--enable-exceptions"],
      );
      const tag = new WebAssembly.Tag({ parameters: ["i32"] });
      let arbitraryThrown: unknown;
      const guarded = guardImportObject(bytes, {
        env: {
          // The JS-API lib types omit Tag from ImportValue.
          tag: tag as unknown as WebAssembly.ImportValue,
          throw_tagged: () => {
            throw new WebAssembly.Exception(tag, [37]);
          },
          throw_any: () => {
            throw arbitraryThrown;
          },
        },
      });
      expect(guarded.env!.tag).toBe(tag);
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(bytes),
        guarded,
      );

      expect((instance.exports.catch_plain as CallableFunction)()).toBe(37);
      expect((instance.exports.catch_ref as CallableFunction)()).toBe(37);
      const workerObject = Object.freeze({ callback: () => 1 });
      for (const value of [workerObject, -0, "exact primitive"]) {
        arbitraryThrown = value;
        expect(
          Object.is(
            thrownBy(() =>
              (instance.exports.catch_all_rethrow as CallableFunction)()
            ),
            value,
          ),
        ).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
