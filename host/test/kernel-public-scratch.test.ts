import { describe, expect, it, vi } from "vitest";

import { WasmPosixKernel } from "../src/kernel";

function kernelHarness(exports: Record<string, unknown>): {
  kernel: WasmPosixKernel & Record<string, any>;
  memory: WebAssembly.Memory;
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = Object.assign(
    Object.create(WasmPosixKernel.prototype),
    {
      memory,
      instance: { exports },
      kernelPtrWidth: 4,
      apiScratchRegion: null,
    },
  ) as WasmPosixKernel & Record<string, any>;
  return { kernel, memory };
}

describe("WasmPosixKernel public API scratch ownership", () => {
  it("sends from an allocator-owned region without touching low kernel memory", () => {
    const scratchPointer = 4096;
    const allocate = vi.fn(() => scratchPointer);
    let memory!: WebAssembly.Memory;
    const send = vi.fn((
      _fd: number,
      pointer: number,
      length: number,
      _flags: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(
        new Uint8Array(memory.buffer, pointer, length),
      ).toEqual(new Uint8Array([1, 2, 3, 4]));
      return length;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: allocate,
      kernel_send: send,
    });
    memory = harness.memory;
    new Uint8Array(memory.buffer).fill(0xa5, 0, 64);

    expect(harness.kernel.send(7, new Uint8Array([1, 2, 3, 4]))).toBe(4);

    expect(allocate).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(memory.buffer, 0, 64))
      .toEqual(new Uint8Array(64).fill(0xa5));
  });

  it("rejects an allocator range outside current kernel memory", () => {
    const send = vi.fn();
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => 131_056,
      kernel_send: send,
    });

    expect(() => kernel.send(7, new Uint8Array(32)))
      .toThrow(/outside|scratch|range/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a request larger than the public API allocation", () => {
    const send = vi.fn();
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => 4096,
      kernel_send: send,
    });

    expect(() => kernel.send(7, new Uint8Array(65_537)))
      .toThrow(/capacity|owned range|scratch/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not drain audio through an allocator range it does not own", () => {
    const drain = vi.fn(() => 1);
    const { kernel } = kernelHarness({
      kernel_alloc_scratch: () => 131_056,
      kernel_drain_audio: drain,
    });

    expect(kernel.drainAudio(new Uint8Array(32))).toBe(0);
    expect(drain).not.toHaveBeenCalled();
  });
});

describe("Rust-owned host import ranges", () => {
  it("rejects network output larger than the Rust-provided capacity", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          recv: () => new Uint8Array(8).fill(0x6b),
        },
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4112);

    expect(imports.env.host_net_recv(1, 4096n, 4, 0)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it.each([
    ["null", 0n],
    ["unrepresentable", BigInt(Number.MAX_SAFE_INTEGER) + 1n],
  ])("rejects a %s positive-length getrandom pointer", (_name, pointer) => {
    const { kernel, memory } = kernelHarness({});
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_getrandom(pointer, 1)).toBe(-14);
  });

  it("rejects an unrepresentable wasm64 process source before a kernel write", () => {
    const processMemory = new WebAssembly.Memory({ initial: 1 });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      kernelPtrWidth: 8,
      callbacks: {
        getProcessMemory: () => processMemory,
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4100);

    expect(imports.env.host_proc_read_bytes(
      7,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      4096n,
      4,
    )).toBe(-14);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array(4).fill(0xa5));
  });
});
