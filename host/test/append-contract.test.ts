import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HostAppendContractError,
  isHostAppendContractError,
} from "../src/append-contract";
import {
  checkedHostFileOffset,
  hostFileOffsetToSafeNumber,
} from "../src/file-offset";
import {
  createWasmPosixKernelTestHarness,
  type WasmPosixKernel,
} from "../src/kernel";
import {
  OPFS_APPEND_CONTRACT_FAILURE,
  OpfsChannelStatus,
} from "../src/vfs/opfs-channel";
import { OpfsFileSystem } from "../src/vfs/opfs";
import { opfsAppendWritableLength } from "../src/vfs/opfs-append";
import { createSessionOwnedHostFileSystem } from "../src/vfs/host-fs";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

function appendImports(
  append: (
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: number | bigint | null,
  ) => { written: number; end: number | bigint },
): {
  memory: WebAssembly.Memory;
  imports: Record<string, (...args: any[]) => any>;
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    io: { append } as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(
      4,
      memory,
      () => ({}),
      () => 4096,
    ),
  }) as WasmPosixKernel & Record<string, any>;
  return {
    memory,
    imports: kernel.testAuthority.buildImportObject(memory).env as Record<
      string,
      (...args: any[]) => any
    >,
  };
}

function replaceNumericGlobals(): () => void {
  const numberDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Number",
  )!;
  const bigIntDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "BigInt",
  )!;
  const hostileNumber = Object.assign(
    () => 0,
    {
      isSafeInteger: () => true,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    },
  );
  Object.defineProperty(globalThis, "Number", {
    ...numberDescriptor,
    value: hostileNumber,
  });
  Object.defineProperty(globalThis, "BigInt", {
    ...bigIntDescriptor,
    value: () => 0n,
  });
  return () => {
    Object.defineProperty(globalThis, "Number", numberDescriptor);
    Object.defineProperty(globalThis, "BigInt", bigIntDescriptor);
  };
}

describe("append outcome authority", () => {
  it("recognizes only privately branded fatal outcomes without hasInstance", () => {
    const ownHasInstance = Object.getOwnPropertyDescriptor(
      HostAppendContractError,
      Symbol.hasInstance,
    );
    const branded = new HostAppendContractError("mutated without an outcome");
    const counterfeit = Object.create(HostAppendContractError.prototype);
    Object.defineProperty(HostAppendContractError, Symbol.hasInstance, {
      configurable: true,
      value: () => {
        throw new Error("hostile Symbol.hasInstance");
      },
    });
    try {
      expect(isHostAppendContractError(branded)).toBe(true);
      expect(isHostAppendContractError(counterfeit)).toBe(false);
    } finally {
      if (ownHasInstance === undefined) {
        delete (HostAppendContractError as any)[Symbol.hasInstance];
      } else {
        Object.defineProperty(
          HostAppendContractError,
          Symbol.hasInstance,
          ownHasInstance,
        );
      }
    }
  });

  it("keeps exact append outcomes after a backend replaces numeric globals", () => {
    const exactEnd = (1n << 53n) + 1n;
    let restoreGlobals: (() => void) | null = null;
    const { memory, imports } = appendImports(() => {
      restoreGlobals = replaceNumericGlobals();
      return { written: 1, end: exactEnd };
    });
    new Uint8Array(memory.buffer, 4096, 1)[0] = 0x41;

    let written: unknown;
    let end: unknown;
    let thrown: unknown;
    try {
      written = imports.host_append(7n, 4096, 1, -1, -1);
      end = imports.host_append_position(7n, 1);
    } catch (error) {
      thrown = error;
    } finally {
      restoreGlobals?.();
    }

    expect(thrown).toBeUndefined();
    expect(written).toBe(1);
    expect(end).toBe(exactEnd);
  });

  it("does not admit an unsafe count after a backend replaces validation", () => {
    let restoreGlobals: (() => void) | null = null;
    const { memory, imports } = appendImports(() => {
      restoreGlobals = replaceNumericGlobals();
      return { written: 0.5, end: 1 };
    });
    new Uint8Array(memory.buffer, 4096, 1)[0] = 0x41;

    let thrown: unknown;
    try {
      imports.host_append(7n, 4096, 1, -1, -1);
    } catch (error) {
      thrown = error;
    } finally {
      restoreGlobals?.();
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/invalid append byte count/i);
  });

  it("keeps positioned-offset checks exact after import-time globals change", () => {
    const restoreGlobals = replaceNumericGlobals();
    let unsafeError: unknown;
    let narrowed: unknown;
    try {
      try {
        checkedHostFileOffset(2 ** 53);
      } catch (error) {
        unsafeError = error;
      }
      narrowed = hostFileOffsetToSafeNumber(123n);
    } finally {
      restoreGlobals();
    }

    expect(String(unsafeError)).toMatch(/EOVERFLOW/);
    expect(narrowed).toBe(123);
  });

  it("promotes malformed OPFS completion outcomes to the fatal contract", () => {
    const dataBuffer = new Uint8Array(16);
    const makeChannel = (
      status: OpfsChannelStatus,
      result: number,
      getI64Arg: () => number,
    ) => ({
      dataBuffer,
      result,
      status: OpfsChannelStatus.Idle,
      opcode: 0,
      setArg: () => {},
      setI64Arg: () => {},
      setPending: () => {},
      waitForComplete: () => status,
      getI64Arg,
    });

    for (const channel of [
      makeChannel(
        OpfsChannelStatus.Error,
        OPFS_APPEND_CONTRACT_FAILURE,
        () => 0,
      ),
      makeChannel(
        OpfsChannelStatus.Complete,
        1,
        () => {
          throw new RangeError("inexact end");
        },
      ),
    ]) {
      let thrown: unknown;
      try {
        new OpfsFileSystem(channel as any).append(
          1,
          new Uint8Array([0x41]),
          1,
          null,
        );
      } catch (error) {
        thrown = error;
      }
      expect(isHostAppendContractError(thrown)).toBe(true);
    }
  });

  it("preflights the complete number-only OPFS append window", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(opfsAppendWritableLength(max - 1, 1, null)).toBe(1);
    expect(opfsAppendWritableLength(max - 1, 2, null)).toBeNull();
    expect(opfsAppendWritableLength(max - 1, 2, max)).toBe(1);
    expect(opfsAppendWritableLength(max, 1, max)).toBe(0);
  });

  it("makes a failed post-write native verification fatal", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-append-contract-"));
    const io = createSessionOwnedHostFileSystem(root);
    const handle = io.open("/result", 0o100 | 0o2, 0o600);
    (io as any).metadata = {
      noteNativeContentChange: () => {
        throw new Error("post-write metadata failure");
      },
    };

    let thrown: unknown;
    try {
      try {
        io.append(handle, new Uint8Array([0x41]), 1, null);
      } catch (error) {
        thrown = error;
      }
      expect(isHostAppendContractError(thrown)).toBe(true);
      expect(readFileSync(join(root, "result"))).toEqual(Buffer.from("A"));
    } finally {
      io.close(handle);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
