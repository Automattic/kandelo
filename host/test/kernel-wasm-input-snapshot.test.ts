import { afterEach, describe, expect, it, vi } from "vitest";

import { WasmPosixKernel } from "../src/kernel";

function memoryImportModule(pointerWidth: 4 | 8): Uint8Array {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    0x02, 0x08, // import section, eight-byte payload
    0x01, // one import
    0x01, 0x6d, // module "m"
    0x01, 0x6d, // field "m"
    0x02, // memory import
    pointerWidth === 8 ? 0x04 : 0x00, // memory64 flag
    0x01, // minimum one page
  ]);
}

function kernel(): WasmPosixKernel {
  return new WasmPosixKernel(
    {
      maxWorkers: 1,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    {} as never,
  );
}

function expectBytes(source: BufferSource | undefined, expected: Uint8Array): void {
  expect(source).toBeInstanceOf(ArrayBuffer);
  expect(
    new Uint8Array(source as ArrayBuffer),
  ).toEqual(expected);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kernel WebAssembly input snapshots", () => {
  it("uses a Uint8Array subclass's intrinsic bytes for both width detection and init compilation", async () => {
    const actual = memoryImportModule(4);
    const decoy = memoryImportModule(8);
    let getterReads = 0;

    class SpoofedUint8Array extends Uint8Array {
      override get buffer(): ArrayBuffer {
        getterReads++;
        return decoy.buffer as ArrayBuffer;
      }

      override get byteOffset(): number {
        getterReads++;
        return decoy.byteOffset;
      }

      override get byteLength(): number {
        getterReads++;
        return decoy.byteLength;
      }
    }

    const source = new SpoofedUint8Array(actual);
    const compileFailure = new Error("stop after capturing compile input");
    let compiledSource: BufferSource | undefined;
    vi.spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
      compiledSource = bytes;
      throw compileFailure;
    });

    const instance = kernel();
    await expect(instance.init(source)).rejects.toBe(compileFailure);

    expect(getterReads).toBe(0);
    expect(instance.getKernelPtrWidth()).toBe(4);
    expectBytes(compiledSource, actual);
  });

  it("uses a DataView subclass's intrinsic window for both width detection and initWithMemory compilation", async () => {
    const actual = memoryImportModule(8);
    const decoy = memoryImportModule(4);
    const prefixLength = 7;
    const backing = new Uint8Array(prefixLength + actual.byteLength + 5);
    backing.fill(0xa5);
    backing.set(actual, prefixLength);
    let getterReads = 0;

    class SpoofedDataView extends DataView {
      override get buffer(): ArrayBuffer {
        getterReads++;
        return decoy.buffer as ArrayBuffer;
      }

      override get byteOffset(): number {
        getterReads++;
        return decoy.byteOffset;
      }

      override get byteLength(): number {
        getterReads++;
        return decoy.byteLength;
      }
    }

    const source = new SpoofedDataView(
      backing.buffer as ArrayBuffer,
      prefixLength,
      actual.byteLength,
    );
    const compileFailure = new Error("stop after capturing compile input");
    let compiledSource: BufferSource | undefined;
    vi.spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
      compiledSource = bytes;
      throw compileFailure;
    });
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });

    const instance = kernel();
    await expect(instance.initWithMemory(source, memory))
      .rejects.toBe(compileFailure);

    expect(getterReads).toBe(0);
    expect(instance.getKernelPtrWidth()).toBe(8);
    expectBytes(compiledSource, actual);
  });
});
