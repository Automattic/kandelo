import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWasmFunctionImports,
} from "../src/constants";
import {
  defineForkExternrefImport,
  forkExternrefImportMailboxBytes,
  type ForkExternrefImportWake,
} from "../src/fork-externref-import-mailbox";
import {
  ForkHostImportOwnerRuntime,
  ForkHostImportWorkerRuntime,
} from "../src/fork-host-import-runtime";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import {
  ForkExternrefTokenCache,
} from "../src/fork-reference-broker";
import {
  isForkWorkerExceptionCapability,
} from "../src/fork-worker-exception-capability";

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

function importedFunctionsModule(): ArrayBuffer {
  const typeSection = section(1, [
    2,
    0x60, 2, 0x7f, 0x63, 0x6f, 1, 0x64, 0x6f,
    0x60, 1, 0x7f, 1, 0x7f,
  ]);
  const importSection = section(2, [
    2,
    ...name("host"), ...name("opaque"), 0, 0,
    ...name("env"), ...name("local"), 0, 1,
  ]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
  ]).buffer;
}

function taggedImportModule(): ArrayBuffer {
  const typeSection = section(1, [
    1,
    0x60, 0, 0,
  ]);
  const importSection = section(2, [
    1,
    ...name("env"), ...name("throw_tagged"), 0, 0,
  ]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
  ]).buffer;
}

function typedBoundaryImportsModule(): ArrayBuffer {
  const typeSection = section(1, [
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
    0x63, 0x65, 0x00, // (ref null shared 0)
    2,
    0x68, // contref
    0x74, // noexnref
  ]);
  const importSection = section(2, [
    1,
    ...name("typed"), ...name("all"), 0, 0,
  ]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
  ]).buffer;
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
  execFileSync("wat2wasm", [
    ...flags,
    watPath,
    "-o",
    wasmPath,
  ]);
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

describe("production fork host-import routing", () => {
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
      { code: 0x63, heapType: 0, shared: true },
    ]);
    expect(imported?.signature.resultTypes).toEqual([
      { code: 0x68, shared: false },
      { code: 0x74, shared: false },
    ]);
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

      const processOwner = new ForkExternrefProcessOwner();
      const generation = processOwner.startGeneration(408);
      const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
      const ownerWorker = ownerRuntime.createWorker({
        pid: generation.pid,
        generationId: generation.id,
        authorizeSender: () => {},
      });
      const workerRuntime = new ForkHostImportWorkerRuntime(
        ownerWorker.init,
        generation.pid,
        generation.id,
        new ForkExternrefTokenCache(generation.id),
        (wake) => expect(ownerWorker.dispatch(wake)).toBe(true),
      );

      const vectorProvider = new WebAssembly.Instance(
        new WebAssembly.Module(vectorProviderBytes),
      );
      const vectorId =
        vectorProvider.exports.id as CallableFunction;
      const routedVector = workerRuntime.routeImportObject(
        vectorConsumerBytes,
        { m: { id: vectorId } },
      );
      expect(routedVector.m!.id).toBe(vectorId);
      const vectorConsumer = new WebAssembly.Instance(
        new WebAssembly.Module(vectorConsumerBytes),
        routedVector,
      );
      expect((vectorConsumer.exports.run as CallableFunction)()).toBe(3);

      const exceptionProvider = new WebAssembly.Instance(
        new WebAssembly.Module(exceptionProviderBytes),
      );
      const exceptionId =
        exceptionProvider.exports.id as CallableFunction;
      const routedException = workerRuntime.routeImportObject(
        exceptionConsumerBytes,
        { m: { id: exceptionId } },
      );
      expect(routedException.m!.id).toBe(exceptionId);
      const exceptionConsumer = new WebAssembly.Instance(
        new WebAssembly.Module(exceptionConsumerBytes),
        routedException,
      );
      expect((exceptionConsumer.exports.run as CallableFunction)()).toBe(77);
      ownerWorker.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses exact artifact signatures and routes only registered opaque imports", () => {
    const bytes = importedFunctionsModule();
    expect(readWasmFunctionImports(bytes)).toEqual([
      {
        module: "host",
        name: "opaque",
        importOrdinal: 0,
        functionIndex: 0,
        signature: {
          params: [0x7f, 0x63],
          results: [0x64],
          paramTypes: [
            { code: 0x7f, shared: false },
            { code: 0x63, heapType: -17, shared: false },
          ],
          resultTypes: [{ code: 0x64, heapType: -17, shared: false }],
        },
      },
      {
        module: "env",
        name: "local",
        importOrdinal: 1,
        functionIndex: 1,
        signature: {
          params: [0x7f],
          results: [0x7f],
          paramTypes: [{ code: 0x7f, shared: false }],
          resultTypes: [{ code: 0x7f, shared: false }],
        },
      },
    ]);

    const processOwner = new ForkExternrefProcessOwner();
    const generation = processOwner.startGeneration(401);
    const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
    const opaque = defineForkExternrefImport(
      100,
      ["i32", "externref"],
      ["externref"],
    );
    const seen: unknown[] = [];
    ownerRuntime.register(
      "host",
      "opaque",
      opaque,
      (_context, scalar, value) => {
        expect(scalar).toBe(9);
        seen.push(value);
        return value;
      },
    );

    let current = true;
    const ownerWorker = ownerRuntime.createWorker({
      pid: generation.pid,
      generationId: generation.id,
      authorizeSender: () => {
        if (!current) throw new Error("replaced Worker");
      },
    });
    const tokens = new ForkExternrefTokenCache(generation.id);
    const wakes: ForkExternrefImportWake[] = [];
    const workerRuntime = new ForkHostImportWorkerRuntime(
      structuredClone(ownerWorker.init),
      generation.pid,
      generation.id,
      tokens,
      (wake) => {
        wakes.push(wake);
        expect(ownerWorker.dispatch(wake)).toBe(true);
      },
    );
    const local = (value: number): number => value + 1;
    const routed = workerRuntime.routeImportObject(bytes, {
      host: { opaque: () => "unsafe local fallback" },
      env: { local },
    });
    const realValue = { ownerOnly: true };
    const handle = processOwner.registerForWire(
      generation.pid,
      generation.id,
      realValue,
    );
    const token = tokens.materialize(handle);

    expect(
      (routed.host!.opaque as CallableFunction)(9, token),
    ).toBe(token);
    expect(seen).toEqual([realValue]);
    const wakeCount = wakes.length;
    expect((routed.env!.local as CallableFunction)(4)).toBe(5);
    // The scalar memory-local fast path does not call the owner.
    expect(wakes).toHaveLength(wakeCount);

    current = false;
    expect(() =>
      (routed.host!.opaque as CallableFunction)(9, token)
    ).toThrow(/Unauthorized/);
    ownerWorker.close();
  });

  it("preserves a primitive rethrow and unwraps its capture-time child token", () => {
    const bytes = importedFunctionsModule();
    const processOwner = new ForkExternrefProcessOwner();
    const generation = processOwner.startGeneration(402);
    const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
    const opaque = defineForkExternrefImport(
      101,
      ["i32", "externref"],
      ["externref"],
    );
    const seen: unknown[] = [];
    ownerRuntime.register(
      "host",
      "opaque",
      opaque,
      (_context, _scalar, value) => {
        seen.push(value);
        return value;
      },
    );
    const ownerWorker = ownerRuntime.createWorker({
      pid: generation.pid,
      generationId: generation.id,
      authorizeSender: () => {},
    });
    const tokens = new ForkExternrefTokenCache(generation.id);
    const workerRuntime = new ForkHostImportWorkerRuntime(
      ownerWorker.init,
      generation.pid,
      generation.id,
      tokens,
      (wake) => {
        expect(ownerWorker.dispatch(wake)).toBe(true);
      },
    );
    const routed = workerRuntime.routeImportObject(bytes, {
      host: { opaque: () => undefined },
      env: {
        local: () => {
          throw null;
        },
      },
    });
    const importThrown = thrownBy(
      routed.env!.local as CallableFunction,
    );
    expect(importThrown).toBeNull();
    const normalizedNull =
      workerRuntime.localExceptions.normalizeUnclaimedForkException(
        importThrown,
      );
    expect(tokens.encode(normalizedNull)).not.toBeNull();

    expect(
      (routed.host!.opaque as CallableFunction)(1, normalizedNull),
    ).toBeNull();
    expect(seen).toEqual([null]);
    ownerWorker.close();
  });

  it("preserves an Error rethrow and captures a stable child capability", () => {
    const bytes = importedFunctionsModule();
    const processOwner = new ForkExternrefProcessOwner();
    const generation = processOwner.startGeneration(403);
    const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
    const opaque = defineForkExternrefImport(
      102,
      ["i32", "externref"],
      ["externref"],
    );
    let observed: unknown;
    ownerRuntime.register(
      "host",
      "opaque",
      opaque,
      (_context, _scalar, value) => {
        observed = value;
        return value;
      },
    );
    const ownerWorker = ownerRuntime.createWorker({
      pid: generation.pid,
      generationId: generation.id,
      authorizeSender: () => {},
    });
    const tokens = new ForkExternrefTokenCache(generation.id);
    const workerRuntime = new ForkHostImportWorkerRuntime(
      ownerWorker.init,
      generation.pid,
      generation.id,
      tokens,
      (wake) => {
        expect(ownerWorker.dispatch(wake)).toBe(true);
      },
    );
    const error = new RangeError("Worker-local range failure");
    const routed = workerRuntime.routeImportObject(bytes, {
      host: { opaque: () => undefined },
      env: {
        local: () => {
          throw error;
        },
      },
    });
    const importThrown = thrownBy(routed.env!.local as CallableFunction);
    expect(importThrown).toBe(error);
    const normalized =
      workerRuntime.localExceptions.normalizeUnclaimedForkException(
        importThrown,
      );
    const echoed = (routed.host!.opaque as CallableFunction)(1, normalized);

    expect(echoed).toBe(normalized);
    expect(isForkWorkerExceptionCapability(observed)).toBe(true);
    expect(observed).toMatchObject({
      kind: "error",
      name: "RangeError",
      message: error.message,
    });
    ownerWorker.close();
  });

  it("preserves exact imported-tag exception semantics before fork capture", () => {
    const processOwner = new ForkExternrefProcessOwner();
    const generation = processOwner.startGeneration(405);
    const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
    const ownerWorker = ownerRuntime.createWorker({
      pid: generation.pid,
      generationId: generation.id,
      authorizeSender: () => {},
    });
    const workerRuntime = new ForkHostImportWorkerRuntime(
      ownerWorker.init,
      generation.pid,
      generation.id,
      new ForkExternrefTokenCache(generation.id),
      (wake) => {
        expect(ownerWorker.dispatch(wake)).toBe(true);
      },
    );
    const exception = new WebAssembly.Exception(
      new WebAssembly.Tag({ parameters: [] }),
      [],
    );
    const routed = workerRuntime.routeImportObject(
      taggedImportModule(),
      {
        env: {
          throw_tagged: () => {
            throw exception;
          },
        },
      },
    );

    expect(
      thrownBy(routed.env!.throw_tagged as CallableFunction),
    ).toBe(exception);
    ownerWorker.close();
  });

  it("keeps imported-tag Catch and CatchRef matching on the real Wasm boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-import-tag-"));
    try {
      const watPath = join(directory, "import-tag.wat");
      const wasmPath = join(directory, "import-tag.wasm");
      writeFileSync(watPath, `(module
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
          (throw_ref)))`);
      execFileSync("wat2wasm", [
        "--enable-exceptions",
        watPath,
        "-o",
        wasmPath,
      ]);
      const file = readFileSync(wasmPath);
      const bytes = file.buffer.slice(
        file.byteOffset,
        file.byteOffset + file.byteLength,
      ) as ArrayBuffer;
      const processOwner = new ForkExternrefProcessOwner();
      const generation = processOwner.startGeneration(406);
      const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
      const ownerWorker = ownerRuntime.createWorker({
        pid: generation.pid,
        generationId: generation.id,
        authorizeSender: () => {},
      });
      const workerRuntime = new ForkHostImportWorkerRuntime(
        ownerWorker.init,
        generation.pid,
        generation.id,
        new ForkExternrefTokenCache(generation.id),
        (wake) => {
          expect(ownerWorker.dispatch(wake)).toBe(true);
        },
      );
      const tag = new WebAssembly.Tag({ parameters: ["i32"] });
      let arbitraryThrown: unknown;
      const routed = workerRuntime.routeImportObject(bytes, {
        env: {
          tag,
          throw_tagged: () => {
            throw new WebAssembly.Exception(tag, [37]);
          },
          throw_any: () => {
            throw arbitraryThrown;
          },
        },
      });
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(bytes),
        routed,
      );

      expect((instance.exports.catch_plain as CallableFunction)()).toBe(37);
      expect((instance.exports.catch_ref as CallableFunction)()).toBe(37);
      const workerObject = Object.freeze({ callback: () => 1 });
      for (const value of [workerObject, -0, "exact primitive"]) {
        arbitraryThrown = value;
        expect(
          Object.is(
            thrownBy(
              instance.exports.catch_all_rethrow as CallableFunction,
            ),
            value,
          ),
        ).toBe(true);
      }
      ownerWorker.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allocates one distinct catalog-sized mailbox per pthread Worker", () => {
    const processOwner = new ForkExternrefProcessOwner();
    const generation = processOwner.startGeneration(404);
    const ownerRuntime = new ForkHostImportOwnerRuntime(processOwner);
    const wideDescriptor = defineForkExternrefImport(
      91,
      Array(33).fill("i32"),
      Array(19).fill("i32"),
    );
    ownerRuntime.register(
      "host",
      "wide",
      wideDescriptor,
      (_context, ...args) => args.slice(0, 19),
    );
    const main = ownerRuntime.createWorker({
      pid: generation.pid,
      generationId: generation.id,
      authorizeSender: () => {},
    });
    const pthread = ownerRuntime.createWorker({
      pid: generation.pid,
      generationId: generation.id,
      authorizeSender: () => {},
    });

    expect(main.init.mailbox).not.toBe(pthread.init.mailbox);
    const expectedBytes = forkExternrefImportMailboxBytes({
      params: 33,
      results: 19,
    });
    expect(main.init.mailbox.byteLength).toBe(expectedBytes);
    expect(pthread.init.mailbox.byteLength).toBe(expectedBytes);
    expect(main.init.senderId).not.toBe(pthread.init.senderId);
    const mainRuntime = new ForkHostImportWorkerRuntime(
      main.init,
      generation.pid,
      generation.id,
      new ForkExternrefTokenCache(generation.id),
      (wake) => expect(main.dispatch(wake)).toBe(true),
    );
    const pthreadRuntime = new ForkHostImportWorkerRuntime(
      pthread.init,
      generation.pid,
      generation.id,
      new ForkExternrefTokenCache(generation.id),
      (wake) => expect(pthread.dispatch(wake)).toBe(true),
    );
    const args = Array.from({ length: 33 }, (_, index) => index);
    const expectedResults = args.slice(0, 19);
    expect(mainRuntime.caller.call(wideDescriptor, args)).toEqual(
      expectedResults,
    );
    expect(pthreadRuntime.caller.call(wideDescriptor, args)).toEqual(
      expectedResults,
    );
    mainRuntime.clear();
    pthreadRuntime.clear();
    main.close();
    pthread.close();
  });
});
