import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import { buildDlopenImports } from "../src/worker-main";

type WasmPointer = number | bigint;

type DlopenImport = (
  bytesPtr: WasmPointer,
  bytesLen: number,
  namePtr: WasmPointer,
  nameLen: number,
) => number;

type DlsymImport = (
  handle: number,
  namePtr: WasmPointer,
  nameLen: number,
) => number;

type DlerrorImport = (bufPtr: WasmPointer, bufMax: number) => number;

type DlopenPrepareImport = (
  bytesPtr: WasmPointer,
  bytesLen: number,
  namePtr: WasmPointer,
  nameLen: number,
  flags: number,
) => number;

type DlopenNextImport = (transaction: number) => number;
type DlopenCommitImport = (transaction: number) => number;

const STAGED_CTOR_SIDE_MODULE = Uint8Array.from(
  Buffer.from(
    "0061736d01000000"
      + "000f0864796c696e6b2e30010400000000"
      + "010401600000"
      + "03020100"
      + "071501115f5f7761736d5f63616c6c5f63746f72730000"
      + "0a040102000b",
    "hex",
  ),
);

function createImports(ptrWidth: 4 | 8): {
  memory: WebAssembly.Memory;
  pointer: (value: number) => WasmPointer;
  dlopen: DlopenImport;
  dlsym: DlsymImport;
  dlerror: DlerrorImport;
} {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  const stackPointer = new WebAssembly.Global(
    { value: ptrWidth === 8 ? "i64" : "i32", mutable: true },
    ptrWidth === 8 ? 32_768n : 32_768,
  );
  const support = buildDlopenImports(
    memory,
    4_096,
    128,
    () => table,
    () => stackPointer,
    () => undefined,
    ptrWidth,
    undefined,
    undefined,
    false,
  );
  const pointer = (value: number): WasmPointer => ptrWidth === 8 ? BigInt(value) : value;

  return {
    memory,
    pointer,
    dlopen: support.imports.__wasm_dlopen as DlopenImport,
    dlsym: support.imports.__wasm_dlsym as DlsymImport,
    dlerror: support.imports.__wasm_dlerror as DlerrorImport,
  };
}

describe("dlopen host import pointer widths", () => {
  it("keeps a borrowed vfork child's loader view read-only", () => {
    const memory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      32_768,
    );
    const archiveControlAddr = 128;
    const support = buildDlopenImports(
      memory,
      4_096,
      archiveControlAddr,
      () => table,
      () => stackPointer,
      () => undefined,
      4,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      2,
      "borrowed",
    );
    const controlBefore = new Uint8Array(
      new Uint8Array(memory.buffer, archiveControlAddr - 32, 32),
    );

    expect(support.readForkState()).toMatchObject({
      nextHandle: 2,
      libraries: [],
    });
    expect(() => support.acquireArchiveReader()).toThrow(
      "cannot acquire the dynamic-loader archive reader",
    );
    expect(() => support.resetForkChildLock()).toThrow(
      "cannot reset the parent's dynamic-loader lock",
    );
    expect(() => (
      support.imports.__wasm_dlopen_main as () => number
    )()).toThrow(
      "borrowed vfork child cannot call __wasm_dlopen_main",
    );
    expect(new Uint8Array(memory.buffer, archiveControlAddr - 32, 32)).toEqual(
      controlBefore,
    );
  });

  it.each([4, 8] as const)(
    "reads memory%d pointers without changing int handles, lengths, or results",
    (ptrWidth) => {
      const { memory, pointer, dlopen, dlsym, dlerror } = createImports(ptrWidth);
      const bytes = new Uint8Array(memory.buffer);
      const invalidModule = new Uint8Array([0, 1, 2, 3]);
      const libraryName = new TextEncoder().encode("libinvalid.so");
      const symbolName = new TextEncoder().encode("missing_symbol");
      const moduleOffset = 256;
      const libraryNameOffset = 512;
      const symbolNameOffset = 768;
      const errorOffset = 1_024;
      bytes.set(invalidModule, moduleOffset);
      bytes.set(libraryName, libraryNameOffset);
      bytes.set(symbolName, symbolNameOffset);

      // Pointer arguments follow the memory width, but dlopen.c declares all
      // lengths, handles, and results as int for both targets.
      expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
      expect(dlopen(
        pointer(moduleOffset),
        invalidModule.length,
        pointer(libraryNameOffset),
        libraryName.length,
      )).toBe(0);
      expect(dlsym(0, pointer(symbolNameOffset), symbolName.length)).toBe(0);

      const errorLength = dlerror(pointer(errorOffset), 128);
      expect(errorLength).toBeGreaterThan(0);
      expect(new TextDecoder().decode(bytes.subarray(errorOffset, errorOffset + errorLength)))
        .toBe("symbol not found: missing_symbol");
    },
  );

  it("rejects a memory64 pointer that JavaScript cannot represent exactly", () => {
    const { pointer, dlopen } = createImports(8);
    const unsafePointer = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    expect(() => dlopen(unsafePointer, 1, pointer(0), 0))
      .toThrow("__wasm_dlopen bytes: pointer exceeds JavaScript's exact address range");
    // The checked failure must still release the process-wide dlopen lock.
    expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
  });

  it("requires the BigInt representation supplied by memory64 imports", () => {
    const { pointer, dlopen } = createImports(8);

    expect(() => dlopen(0, 1, pointer(0), 0))
      .toThrow("__wasm_dlopen bytes: expected an exact memory64 pointer");
    expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
  });

  it("unsigned-normalizes a signed memory32 high-bit pointer", () => {
    const { pointer, dlopen } = createImports(4);

    expect(() => dlopen(-1, 1, pointer(0), 0))
      .toThrow(
        "__wasm_dlopen bytes: memory range [4294967295, 4294967296) " +
          "exceeds 65536 bytes",
      );
    expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
  });

  it("rejects a memory32 range that crosses the end of linear memory", () => {
    const { memory, pointer, dlopen } = createImports(4);

    expect(() => dlopen(pointer(memory.buffer.byteLength - 1), 2, pointer(0), 0))
      .toThrow(/__wasm_dlopen bytes: memory range .* exceeds 65536 bytes/);
    expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
  });

  it("retains the loader lease after a premature explicit staged commit", () => {
    const channelOffset = 4_096;
    const archiveControlAddr = 128;
    const memory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      32_768,
    );
    const support = buildDlopenImports(
      memory,
      channelOffset,
      archiveControlAddr,
      () => table,
      () => stackPointer,
      () => undefined,
      4,
      undefined,
      undefined,
      false,
    );
    const prepare = support.imports
      .__wasm_dlopen_prepare as DlopenPrepareImport;
    const next = support.imports.__wasm_dlopen_next as DlopenNextImport;
    const commit = support.imports.__wasm_dlopen_commit as DlopenCommitImport;
    const moduleOffset = 8_192;
    const nameOffset = 8_512;
    const name = new TextEncoder().encode("libstaged-lease.so");
    const bytes = new Uint8Array(memory.buffer);
    bytes.set(STAGED_CTOR_SIDE_MODULE, moduleOffset);
    bytes.set(name, nameOffset);

    let nextMapping = 16_384;
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(
      (array, index, expected) => {
        if (Atomics.load(array, index) !== expected) return "not-equal";
        if (
          array.buffer !== memory.buffer
          || index !== (channelOffset + CH_STATUS) / 4
          || expected !== CHANNEL_STATUS_PENDING
        ) {
          throw new Error("unexpected Atomics.wait in staged-loader test");
        }
        const view = new DataView(memory.buffer);
        const syscall = view.getInt32(channelOffset + CH_SYSCALL, true);
        const result = syscall === ABI_SYSCALLS.Mmap
          ? nextMapping
          : syscall === ABI_SYSCALLS.Munmap
            ? 0
            : -1;
        if (syscall === ABI_SYSCALLS.Mmap) nextMapping += 8_192;
        view.setBigInt64(channelOffset + CH_RETURN, BigInt(result), true);
        view.setUint32(
          channelOffset + CH_ERRNO,
          result < 0 ? 38 : 0,
          true,
        );
        Atomics.store(array, index, CHANNEL_STATUS_COMPLETE);
        return "ok";
      },
    );

    try {
      const transaction = prepare(
        moduleOffset,
        STAGED_CTOR_SIDE_MODULE.length,
        nameOffset,
        name.length,
        0x100,
      );
      expect(transaction).toBeGreaterThan(0);

      const entry = next(transaction);
      expect(entry).toBeGreaterThan(0);
      // Once `next` has issued an entry, commit must wait for ordinary Wasm
      // to execute it. This is a truthful misuse failure, not cancellation.
      expect(commit(transaction)).toBe(0);
      const loaderOwner = new Int32Array(
        memory.buffer,
        archiveControlAddr - 24,
        1,
      );
      expect(loaderOwner[0]).toBe(1);

      (table.get(entry) as () => void)();
      expect(next(transaction)).toBe(0);
      expect(commit(transaction)).toBeGreaterThan(0);
      expect(loaderOwner[0]).toBe(0);
    } finally {
      wait.mockRestore();
    }
  });
});
