import { describe, expect, it, vi } from "vitest";

import { STRUCT_SIZE_WPK_DRM_MODE_MODEINFO } from "../src/generated/abi";
import { WasmPosixKernel } from "../src/kernel";
import { QOP_GET_ERROR } from "../src/webgl/ops";

function hostileBytes(length: number, reportedLength = 1): Uint8Array {
  class HostileBytes extends Uint8Array {}
  const bytes = new HostileBytes(length);
  Object.defineProperties(bytes, {
    buffer: { get: () => new ArrayBuffer(reportedLength) },
    byteOffset: { get: () => 0 },
    byteLength: { get: () => reportedLength },
    length: { get: () => reportedLength },
    subarray: { value: () => bytes },
  });
  return bytes;
}

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
      callbacks: {},
      sharedPipes: new Map(),
    },
  ) as WasmPosixKernel & Record<string, any>;
  return { kernel, memory };
}

function fullKernelHarness(
  io: Record<string, unknown> = {},
  callbacks: Record<string, unknown> = {},
): {
  kernel: WasmPosixKernel & Record<string, any>;
  memory: WebAssembly.Memory;
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = new WasmPosixKernel(
    {} as any,
    io as any,
    callbacks as any,
  ) as WasmPosixKernel & Record<string, any>;
  Object.assign(kernel, {
    memory,
    instance: { exports: {} },
    kernelPtrWidth: 4,
    apiScratchRegion: null,
  });
  return { kernel, memory };
}

describe("WasmPosixKernel public API scratch ownership", () => {
  it("converts public export pointers losslessly for each Wasm width", () => {
    const { kernel } = kernelHarness({});

    expect(kernel.toKernelPtr(0xffff_ffff)).toBe(0xffff_ffff);
    expect(() => kernel.toKernelPtr(0x1_0000_0000))
      .toThrow(/wasm32/i);
    expect(() => kernel.toKernelPtr(-1)).toThrow(/non-negative/i);
    expect(() => kernel.toKernelPtr(1.5)).toThrow(/integer/i);

    Object.assign(kernel, { kernelPtrWidth: 8 });
    expect(kernel.toKernelPtr(0x1_0000_0000)).toBe(0x1_0000_0000n);
    expect(() =>
      kernel.toKernelPtr(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    ).toThrow(/representable/i);
  });

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

  it("never lends stale scratch bytes when public inputs spoof their length", () => {
    const scratchPointer = 4096;
    const source = hostileBytes(1, 4);
    Uint8Array.prototype.set.call(source, [0x5a]);
    let memory!: WebAssembly.Memory;
    const inspectExactInput = vi.fn((
      _first: number,
      _second: number,
      pointer: number,
      length: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(length).toBe(1);
      expect(new Uint8Array(memory.buffer, pointer, length))
        .toEqual(new Uint8Array([0x5a]));
      return 1;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_send: (
        fd: number,
        pointer: number,
        length: number,
        flags: number,
      ) => inspectExactInput(fd, flags, pointer, length),
      kernel_tcsetattr: inspectExactInput,
    });
    memory = harness.memory;
    new Uint8Array(memory.buffer).fill(
      0xa5,
      scratchPointer,
      scratchPointer + 8,
    );

    expect(harness.kernel.send(7, source)).toBe(1);
    harness.kernel.tcsetattr(7, 0, source);

    expect(inspectExactInput).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(memory.buffer, scratchPointer, 4))
      .toEqual(new Uint8Array([0x5a, 0xa5, 0xa5, 0xa5]));
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

  it("accepts exact public API capacity and rejects capacity plus one", () => {
    const scratchPointer = 4096;
    let memory!: WebAssembly.Memory;
    const send = vi.fn((
      _fd: number,
      pointer: number,
      length: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(length).toBe(65_536);
      const bytes = new Uint8Array(memory.buffer);
      expect(bytes[pointer]).toBe(0x4d);
      expect(bytes[pointer + length - 1]).toBe(0x4d);
      return length;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_send: send,
    });
    memory = harness.memory;
    const kernelBytes = new Uint8Array(memory.buffer);
    kernelBytes.fill(0xa5, scratchPointer + 65_536, scratchPointer + 65_552);

    expect(harness.kernel.send(7, new Uint8Array(65_536).fill(0x4d)))
      .toBe(65_536);
    expect(() => harness.kernel.send(7, new Uint8Array(65_537)))
      .toThrow(/capacity|owned range|scratch/i);
    expect(send).toHaveBeenCalledOnce();
    expect(kernelBytes.subarray(scratchPointer + 65_536, scratchPointer + 65_552))
      .toEqual(new Uint8Array(16).fill(0xa5));
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

  it("bounds exact and capacity-plus-one audio drains to the audio region", () => {
    const scratchPointer = 4096;
    let memory!: WebAssembly.Memory;
    const drain = vi.fn((pointer: number, length: number) => {
      expect(pointer).toBe(scratchPointer);
      expect(length).toBe(65_536);
      new Uint8Array(memory.buffer, pointer, length).fill(0x6d);
      return length;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: () => scratchPointer,
      kernel_drain_audio: drain,
    });
    memory = harness.memory;
    const kernelBytes = new Uint8Array(memory.buffer);
    kernelBytes.fill(0xa5, scratchPointer + 65_536, scratchPointer + 65_552);

    const exact = new Uint8Array(65_536);
    expect(harness.kernel.drainAudio(exact)).toBe(65_536);
    expect(exact.every((byte) => byte === 0x6d)).toBe(true);

    const plusOne = new Uint8Array(65_537).fill(0xa5);
    expect(harness.kernel.drainAudio(plusOne)).toBe(65_536);
    expect(plusOne.subarray(0, 65_536).every((byte) => byte === 0x6d))
      .toBe(true);
    expect(plusOne[65_536]).toBe(0xa5);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(kernelBytes.subarray(scratchPointer + 65_536, scratchPointer + 65_552))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("stages truncate paths through allocator-owned scratch", () => {
    const scratchPointer = 4096;
    const allocate = vi.fn(() => scratchPointer);
    let memory!: WebAssembly.Memory;
    const truncate = vi.fn((
      pointer: number,
      length: number,
      lengthLo: number,
      lengthHi: number,
    ) => {
      expect(pointer).toBe(scratchPointer);
      expect(new TextDecoder().decode(
        new Uint8Array(memory.buffer, pointer, length),
      )).toBe("/tmp/example");
      expect(lengthLo).toBe(7);
      expect(lengthHi).toBe(0);
      return 0;
    });
    const harness = kernelHarness({
      kernel_alloc_scratch: allocate,
      kernel_truncate: truncate,
    });
    memory = harness.memory;

    harness.kernel.truncate("/tmp/example", 7);

    expect(allocate).toHaveBeenCalledTimes(1);
    expect(truncate).toHaveBeenCalledTimes(1);
  });
});

describe("Rust-owned host import ranges", () => {
  it("rejects a truncated kernel source instead of invoking the backend", () => {
    const open = vi.fn(() => 7);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { open } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const pointer = memory.buffer.byteLength - 2;

    expect(imports.env.host_open(pointer, 4, 0, 0)).toBe(-14n);
    expect(open).not.toHaveBeenCalled();
  });

  it("accepts an exact-end source and rejects capacity plus one", () => {
    const write = vi.fn(() => 4);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { write } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const pointer = memory.buffer.byteLength - 4;
    new Uint8Array(memory.buffer, pointer, 4).set([1, 2, 3, 4]);

    expect(imports.env.host_write(9n, pointer, 4)).toBe(4);
    expect(write).toHaveBeenCalledWith(
      9,
      new Uint8Array([1, 2, 3, 4]),
      null,
      4,
    );
    write.mockClear();
    expect(imports.env.host_write(9n, pointer, 5)).toBe(-14);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["null pointer", 0, 1],
    ["negative length", 4096, -1],
    ["fractional length", 4096, 1.5],
    ["unsafe length", 4096, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s before a kernel-source callback", (_name, pointer, length) => {
    const write = vi.fn(() => 0);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { write } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_write(9n, pointer, length)).toBe(-14);
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable wasm64 network source without aliasing", () => {
    const send = vi.fn(() => 1);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      kernelPtrWidth: 8,
      io: { network: { send } },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_net_send(
      1,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      1,
      0,
    )).toBe(-14);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a lossy file-length conversion before PlatformIO", () => {
    const ftruncate = vi.fn();
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { ftruncate } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_ftruncate(
      9n,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    )).toBe(-75);
    expect(ftruncate).not.toHaveBeenCalled();
  });

  it("publishes a staged read without lending kernel memory to PlatformIO", () => {
    let retained: Uint8Array | undefined;
    const read = vi.fn((
      _handle: number,
      destination: Uint8Array,
    ) => {
      retained = destination;
      destination.set([0x41, 0x42]);
      return 2;
    });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { read } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_read(8n, 4096, 4)).toBe(2);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array([0x41, 0x42, 0, 0]));
    retained![0] = 0x7f;
    expect(new Uint8Array(memory.buffer, 4096, 2))
      .toEqual(new Uint8Array([0x41, 0x42]));
  });

  it("rejects an invalid read destination before consuming backend data", () => {
    const read = vi.fn(() => 1);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { read } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_read(
      8n,
      memory.buffer.byteLength - 2,
      4,
    )).toBe(-14);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an invalid wait status destination before reaping", () => {
    const waitpid = vi.fn(() => ({ pid: 42, status: 0 }));
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { io: { waitpid } });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_waitpid(
      42,
      0,
      memory.buffer.byteLength - 2,
    )).toBe(-14);
    expect(waitpid).not.toHaveBeenCalled();
  });

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

    expect(imports.env.host_net_recv(1, 4096, 4, 0)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("uses a producer's intrinsic byte span instead of overridable length properties", () => {
    const output = hostileBytes(20);
    output.fill(0x6b);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          recv: () => output,
        },
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4120);

    expect(imports.env.host_net_recv(1, 4096, 4, 0)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 24))
      .toEqual(new Uint8Array(24).fill(0xa5));
    expect(() => kernel.writeKernelBytes(4096, 4, output))
      .toThrow(/20 exceeds capacity 4/i);
    expect(new Uint8Array(memory.buffer, 4096, 24))
      .toEqual(new Uint8Array(24).fill(0xa5));
  });

  it("rejects a non-typed-array address producer without touching kernel memory", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          getaddrinfo: () => ({
            byteLength: 1,
            length: 20,
            0: 127,
          }),
        },
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 2048, 2).set([0x78, 0]);
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4112);

    expect(imports.env.host_getaddrinfo(2048, 1, 4096, 4)).toBe(-5);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("preserves an asynchronous DNS EAGAIN before producer validation", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      io: {
        network: {
          getaddrinfo: () => {
            throw Object.assign(new Error("DNS pending"), { errno: 11 });
          },
        },
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 2048, 2).set([0x78, 0]);
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4112);

    expect(imports.env.host_getaddrinfo(2048, 1, 4096, 4)).toBe(-11);
    expect(new Uint8Array(memory.buffer, 4096, 16))
      .toEqual(new Uint8Array(16).fill(0xa5));
  });

  it("clips hostile stdin bytes through a plain exact view and preserves the canary", () => {
    const output = hostileBytes(20);
    Uint8Array.prototype.set.call(output, [1, 2, 3, 4, 5]);
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      callbacks: {
        onStdin: () => output,
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer).fill(0xa5, 4096, 4104);

    expect(imports.env.host_read(0n, 4096, 4)).toBe(4);
    expect(new Uint8Array(memory.buffer, 4096, 8))
      .toEqual(new Uint8Array([1, 2, 3, 4, 0xa5, 0xa5, 0xa5, 0xa5]));
  });

  it("rejects a null positive-length getrandom pointer", () => {
    const { kernel, memory } = kernelHarness({});
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_getrandom(0, 1)).toBe(-14);
  });

  it("rejects an unrepresentable wasm64 process-copy destination before a kernel write", () => {
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
      1024,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      4,
    )).toBe(-14);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array(4).fill(0xa5));
  });

  it("rejects null positive-length process transfer ranges", () => {
    const processMemory = new WebAssembly.Memory({ initial: 1 });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      callbacks: {
        getProcessMemory: () => processMemory,
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    new Uint8Array(memory.buffer, 4096, 4).set([1, 2, 3, 4]);
    new Uint8Array(processMemory.buffer, 0, 4).fill(0xa5);

    expect(imports.env.host_proc_write_bytes(7, 0, 4096, 4)).toBe(-14);
    expect(new Uint8Array(processMemory.buffer, 0, 4))
      .toEqual(new Uint8Array(4).fill(0xa5));
    expect(imports.env.host_proc_read_bytes(7, 0, 4096, 4)).toBe(-14);
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("enforces exact process-memory transfer boundaries", () => {
    const processMemory = new WebAssembly.Memory({ initial: 1 });
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, {
      callbacks: {
        getProcessMemory: () => processMemory,
      },
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const processEnd = processMemory.buffer.byteLength;
    new Uint8Array(memory.buffer, 4096, 4).set([1, 2, 3, 4]);

    expect(imports.env.host_proc_write_bytes(
      7,
      processEnd - 4,
      4096,
      4,
    )).toBe(0);
    expect(new Uint8Array(processMemory.buffer, processEnd - 4, 4))
      .toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(imports.env.host_proc_write_bytes(
      7,
      processEnd - 4,
      4096,
      5,
    )).toBe(-14);

    new Uint8Array(processMemory.buffer, processEnd - 4, 4)
      .set([5, 6, 7, 8]);
    expect(imports.env.host_proc_read_bytes(
      7,
      processEnd - 4,
      8192,
      4,
    )).toBe(0);
    expect(new Uint8Array(memory.buffer, 8192, 4))
      .toEqual(new Uint8Array([5, 6, 7, 8]));
    expect(imports.env.host_proc_read_bytes(
      7,
      processEnd - 4,
      8192,
      5,
    )).toBe(-14);
  });

  it("does not wrap a wasm64 futex address onto a low kernel word", () => {
    const { kernel, memory } = kernelHarness({});
    Object.assign(kernel, { kernelPtrWidth: 8 });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const notify = vi.spyOn(Atomics, "notify");

    expect(imports.env.host_futex_wake(0x1_0000_1000n, 1)).toBe(-14);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });

  it("rejects unaligned and end-crossing futex words", () => {
    const { kernel, memory } = kernelHarness({});
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_futex_wake(4097, 1)).toBe(-22);
    expect(imports.env.host_futex_wake(
      memory.buffer.byteLength - 2,
      1,
    )).toBe(-14);
  });

  it("rejects lossy device metadata conversions before registration", () => {
    const { kernel, memory } = fullKernelHarness();
    Object.assign(kernel, { kernelPtrWidth: 8 });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const invalid = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    expect(() =>
      imports.env.host_bind_framebuffer(7, invalid, 4096n, 1, 1, 4, 0)
    ).toThrow(/representable|safe/i);
    expect(kernel.framebuffers.get(7)).toBeUndefined();
    expect(imports.env.host_gbm_bo_create(
      7,
      1,
      invalid,
      1,
      1,
      4,
    )).toBe(-75);
    expect(() => imports.env.host_gl_bind(7, invalid, 4096n))
      .toThrow(/representable|safe/i);
    expect(kernel.gl.get(7)).toBeUndefined();
  });

  it("reports a host BO allocation failure without publishing an entry", () => {
    const { kernel, memory } = fullKernelHarness();
    const create = vi.spyOn(kernel.bos, "create").mockImplementation(() => {
      throw new RangeError("allocation failed");
    });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_gbm_bo_create(7, 1, 4096n, 1, 1, 4))
      .toBe(-12);
    expect(create).toHaveBeenCalledTimes(1);
    expect(kernel.bos.get(7, 1)).toBeUndefined();
  });

  it("preflights GL output before executing a query", () => {
    const { kernel, memory } = fullKernelHarness();
    kernel.gl.bind({ pid: 7, cmdbufAddr: 4096, cmdbufLen: 4096 });
    const getError = vi.fn(() => 0x1234);
    kernel.gl.get(7)!.gl = {
      getError,
    } as unknown as WebGL2RenderingContext;
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };

    expect(imports.env.host_gl_query(
      7,
      QOP_GET_ERROR,
      0,
      0,
      memory.buffer.byteLength - 2,
      4,
    )).toBe(-14);
    expect(getError).not.toHaveBeenCalled();

    expect(imports.env.host_gl_query(
      7,
      QOP_GET_ERROR,
      0,
      0,
      memory.buffer.byteLength - 4,
      4,
    )).toBe(4);
    expect(getError).toHaveBeenCalledTimes(1);
    expect(
      new DataView(memory.buffer).getUint32(
        memory.buffer.byteLength - 4,
        true,
      ),
    ).toBe(0x1234);
  });

  it.each([4, 8] as const)(
    "writes the generated KMS mode size at the exact wasm%d memory boundary",
    (pointerWidth) => {
    const { kernel, memory } = fullKernelHarness();
    Object.assign(kernel, { kernelPtrWidth: pointerWidth });
    const imports = kernel.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const exactPointer =
      memory.buffer.byteLength - STRUCT_SIZE_WPK_DRM_MODE_MODEINFO;
    const pointer = (value: number): number | bigint =>
      pointerWidth === 4 ? value : BigInt(value);

    expect(() =>
      imports.env.host_kms_mode_info(1, pointer(exactPointer))
    ).not.toThrow();
    expect(
      new Uint8Array(
        memory.buffer,
        exactPointer,
        STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
      ).some((byte) => byte !== 0),
    ).toBe(true);
    expect(() =>
      imports.env.host_kms_mode_info(1, pointer(exactPointer + 1))
    ).toThrow(/outside|range/i);
    },
  );

  it("restores the unsigned high bit of a raw wasm32 import pointer", () => {
    const highMemory = new WebAssembly.Memory({
      initial: 32_769,
      maximum: 32_769,
    });
    const { kernel } = fullKernelHarness();
    Object.assign(kernel, {
      memory: highMemory,
      kernelPtrWidth: 4,
    });
    const imports = kernel.buildImportObject(highMemory) as {
      env: Record<string, (...args: any[]) => any>;
    };
    const unsignedPointer = 0x8000_0020;
    const signedImportPointer = unsignedPointer | 0;

    expect(signedImportPointer).toBeLessThan(0);
    expect(() =>
      imports.env.host_kms_mode_info(1, signedImportPointer)
    ).not.toThrow();
    expect(
      new Uint8Array(
        highMemory.buffer,
        unsignedPointer,
        STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
      ).some((byte) => byte !== 0),
    ).toBe(true);
  });
});
