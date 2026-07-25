import { afterEach, describe, expect, it, vi } from "vitest";

import { WasmPosixKernel } from "../src/kernel";
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

function installSuccessfulEngine(
  pointerWidth: 4 | 8,
  implementations: Record<string, unknown>,
  allocator: (capacity: number) => number | bigint,
): {
  compile: ReturnType<typeof vi.spyOn>;
  instantiate: ReturnType<typeof vi.spyOn>;
  memory: () => WebAssembly.Memory;
} {
  const compile = vi
    .spyOn(WebAssembly, "compile")
    .mockResolvedValue(emptyModule);
  let activeMemory: WebAssembly.Memory | null = null;
  const instantiate = vi.spyOn(WebAssembly, "instantiate");
  instantiate.mockImplementation((async (
    _module: WebAssembly.Module,
    importObject?: WebAssembly.Imports,
  ) => {
    activeMemory = (
      importObject as { env: { memory: WebAssembly.Memory } }
    ).env.memory;
    return createKernelScratchTestInstance(
      pointerWidth,
      activeMemory,
      () => implementations,
      allocator,
    );
  }) as never);
  return {
    compile,
    instantiate,
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
      const instance = kernel();
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
      const suppliedMemory = new WebAssembly.Memory({
        initial: 4,
        maximum: 4,
        shared: true,
      });

      if (pointerWidth === 4) {
        await instance.init(memoryImportModule(pointerWidth));
      } else {
        await instance.initWithMemory(
          memoryImportModule(pointerWidth),
          suppliedMemory,
        );
      }
      activeMemory = engine.memory();
      const firstMemory = instance.getMemory();
      const firstInstance = instance.getInstance();

      expect(instance.send(7, new Uint8Array([1, 2, 3, 4]))).toBe(4);
      const firstAudio = new Uint8Array(4);
      expect(instance.drainAudio(firstAudio)).toBe(4);
      expect(firstAudio).toEqual(new Uint8Array([9, 8, 7, 6]));

      const replacementMemory = new WebAssembly.Memory({
        initial: 4,
        maximum: 4,
        shared: true,
      });
      const replacement = pointerWidth === 4
        ? instance.initWithMemory(
            memoryImportModule(pointerWidth),
            replacementMemory,
          )
        : instance.init(memoryImportModule(pointerWidth));
      await expect(replacement).rejects.toThrow(/already initialized/i);

      expect(engine.compile).toHaveBeenCalledOnce();
      expect(engine.instantiate).toHaveBeenCalledOnce();
      expect(instance.getMemory()).toBe(firstMemory);
      expect(instance.getInstance()).toBe(firstInstance);
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
    const instance = kernel();
    let releaseCompile!: (module: WebAssembly.Module) => void;
    const compileGate = new Promise<WebAssembly.Module>((resolve) => {
      releaseCompile = resolve;
    });
    const compile = vi
      .spyOn(WebAssembly, "compile")
      .mockReturnValue(compileGate);
    const instantiate = vi.spyOn(WebAssembly, "instantiate");
    instantiate.mockImplementation((async (
      _module: WebAssembly.Module,
      importObject?: WebAssembly.Imports,
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
    }) as never);

    const first = instance.init(memoryImportModule(4));
    const competingMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    await expect(
      instance.initWithMemory(memoryImportModule(4), competingMemory),
    ).rejects.toThrow(/already in progress/i);

    releaseCompile(emptyModule);
    await expect(first).resolves.toBeUndefined();
    expect(compile).toHaveBeenCalledOnce();
    expect(instantiate).toHaveBeenCalledOnce();
    expect(instance.getMemory()).not.toBe(competingMemory);
  });

  it("clears a failed first instantiation and permits one clean retry", async () => {
    const instance = kernel();
    const failure = new Error("synthetic instantiation failure");
    const compile = vi
      .spyOn(WebAssembly, "compile")
      .mockResolvedValue(emptyModule);
    let attempt = 0;
    const instantiate = vi.spyOn(WebAssembly, "instantiate");
    instantiate.mockImplementation((async (
      _module: WebAssembly.Module,
      importObject?: WebAssembly.Imports,
    ) => {
      if (attempt++ === 0) throw failure;
      const memory = (
        importObject as { env: { memory: WebAssembly.Memory } }
      ).env.memory;
      return createKernelScratchTestInstance(
        8,
        memory,
        () => ({}),
        () => 4_096n,
      );
    }) as never);
    const memory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });

    await expect(
      instance.initWithMemory(memoryImportModule(8), memory),
    ).rejects.toBe(failure);
    expect(instance.getMemory()).toBeNull();
    expect(instance.getInstance()).toBeNull();
    expect(instance.getKernelPtrWidth()).toBe(4);

    await expect(
      instance.initWithMemory(memoryImportModule(8), memory),
    ).resolves.toBeUndefined();
    expect(instance.getMemory()).toBe(memory);
    expect(instance.getInstance()).not.toBeNull();
    expect(instance.getKernelPtrWidth()).toBe(8);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(instantiate).toHaveBeenCalledTimes(2);
  });
});
