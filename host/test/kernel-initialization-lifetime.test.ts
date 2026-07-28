import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const emptyModule = new WebAssembly.Module(new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]));

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

type TestEngine = {
  compile: (bytes: BufferSource) => Promise<WebAssembly.Module>;
  instantiate: (
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance>;
};

function kernel(engine: TestEngine): WasmPosixKernel {
  return createWasmPosixKernelTestHarness({
    config: {
      maxWorkers: 1,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    engine,
    initialized: false,
  });
}

function installSuccessfulEngine(
  pointerWidth: 4 | 8,
  implementations: Record<string, unknown>,
  allocator: (capacity: number) => number | bigint,
){
  const compile = vi.fn(async (_bytes: BufferSource) => emptyModule);
  let activeMemory: WebAssembly.Memory | null = null;
  const instantiate = vi.fn(async (
    _module: WebAssembly.Module,
    importObject: WebAssembly.Imports,
  ) => {
    activeMemory = (
      importObject as { env: { memory: WebAssembly.Memory } }
    ).env.memory;
    return createKernelScratchTestInstance(
      pointerWidth,
      activeMemory,
      () => implementations,
      allocator,
      pointerWidth,
    );
  });
  return {
    compile,
    instantiate,
    engine: { compile, instantiate },
    memory: () => {
      if (!activeMemory) throw new Error("kernel memory was not instantiated");
      return activeMemory;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WasmPosixKernel initialization lifetime", () => {
  it.each([4, 8] as const)(
    "keeps wasm%d public and audio scratch bound to its first generation",
    async (pointerWidth) => {
      let allocationIndex = 0;
      let activeMemory: WebAssembly.Memory;
      const allocator = vi.fn((_capacity: number) => {
        const pointer = allocationIndex++ === 0 ? 4_096 : 131_072;
        return pointerWidth === 8 ? BigInt(pointer) : pointer;
      });
      const send = vi.fn((
        _fd: number,
        pointer: number | bigint,
        length: number,
      ) => {
        expect(new Uint8Array(
          activeMemory.buffer,
          Number(pointer),
          length,
        )).toEqual(new Uint8Array([1, 2, 3, 4]));
        return length;
      });
      const drainAudio = vi.fn((
        pointer: number | bigint,
        length: number,
      ) => {
        const output = new Uint8Array(
          activeMemory.buffer,
          Number(pointer),
          Math.min(length, 4),
        );
        output.set([9, 8, 7, 6]);
        return output.byteLength;
      });
      const engine = installSuccessfulEngine(
        pointerWidth,
        {
          kernel_send: send,
          kernel_drain_audio: drainAudio,
        },
        allocator,
      );
      const instance = kernel(engine.engine);
      await instance.init(memoryImportModule(pointerWidth));
      activeMemory = engine.memory();
      const firstMemoryPages = instance.getMemoryPageCount();
      expect(firstMemoryPages).not.toBeNull();
      expect(Object.getOwnPropertyNames(instance)).not.toContain("memory");
      expect(Object.getOwnPropertyNames(instance)).not.toContain("instance");
      expect(Object.getOwnPropertyNames(instance)).not.toContain("rawInstance");
      expect(Object.getOwnPropertyNames(instance)).not.toContain(
        "kernelEntryGate",
      );

      expect(instance.send(7, new Uint8Array([1, 2, 3, 4]))).toBe(4);
      const firstAudio = new Uint8Array(4);
      expect(instance.drainAudio(firstAudio)).toBe(4);
      expect(firstAudio).toEqual(new Uint8Array([9, 8, 7, 6]));

      const replacement = instance.init(memoryImportModule(pointerWidth));
      await expect(replacement).rejects.toThrow(/already initialized/i);

      expect(engine.compile).toHaveBeenCalledOnce();
      expect(engine.instantiate).toHaveBeenCalledOnce();
      expect(instance.getMemoryPageCount()).toBe(firstMemoryPages);
      expect(instance.getKernelPtrWidth()).toBe(pointerWidth);

      expect(instance.send(7, new Uint8Array([1, 2, 3, 4]))).toBe(4);
      const secondAudio = new Uint8Array(4);
      expect(instance.drainAudio(secondAudio)).toBe(4);
      expect(secondAudio).toEqual(new Uint8Array([9, 8, 7, 6]));
      expect(allocator).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(drainAudio).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a concurrent initializer before it can replace candidate state", async () => {
    let releaseCompile!: (module: WebAssembly.Module) => void;
    const compileGate = new Promise<WebAssembly.Module>((resolve) => {
      releaseCompile = resolve;
    });
    const compile = vi.fn((_bytes: BufferSource) => compileGate);
    const instantiate = vi.fn(async (
      _module: WebAssembly.Module,
      importObject: WebAssembly.Imports,
    ) => {
      const memory = (
        importObject as { env: { memory: WebAssembly.Memory } }
      ).env.memory;
      return createKernelScratchTestInstance(
        4,
        memory,
        () => ({}),
        () => 4_096,
      );
    });
    const instance = kernel({ compile, instantiate });

    const first = instance.init(memoryImportModule(4));
    await expect(
      instance.init(memoryImportModule(4)),
    ).rejects.toThrow(/already in progress/i);

    releaseCompile(emptyModule);
    await expect(first).resolves.toBeUndefined();
    expect(compile).toHaveBeenCalledOnce();
    expect(instantiate).toHaveBeenCalledOnce();
    expect(instance.getMemoryPageCount()).not.toBeNull();
  });

  it("clears a failed first instantiation and permits one clean retry", async () => {
    const failure = new Error("synthetic instantiation failure");
    const compile = vi.fn(async (_bytes: BufferSource) => emptyModule);
    let attempt = 0;
    let activeMemory: WebAssembly.Memory | null = null;
    const instantiate = vi.fn(async (
      _module: WebAssembly.Module,
      importObject: WebAssembly.Imports,
    ) => {
      if (attempt++ === 0) throw failure;
      activeMemory = (
        importObject as { env: { memory: WebAssembly.Memory } }
      ).env.memory;
      return createKernelScratchTestInstance(
        8,
        activeMemory,
        () => ({}),
        () => 4_096n,
        8,
      );
    });
    const instance = kernel({ compile, instantiate });

    await expect(
      instance.init(memoryImportModule(8)),
    ).rejects.toBe(failure);
    expect(instance.getMemoryPageCount()).toBeNull();
    expect(instance.getKernelPtrWidth()).toBe(4);

    await expect(
      instance.init(memoryImportModule(8)),
    ).resolves.toBeUndefined();
    expect(instance.getMemoryPageCount()).toBe(
      activeMemory!.buffer.byteLength / 65_536,
    );
    expect(instance.getKernelPtrWidth()).toBe(8);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(instantiate).toHaveBeenCalledTimes(2);
  });
});
