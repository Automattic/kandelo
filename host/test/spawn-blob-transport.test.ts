import { describe, expect, it, vi } from "vitest";

import {
  CentralizedKernelWorker,
  SPAWN_BLOB_MAX_BYTES,
} from "../src/kernel-worker";
import {
  CH_DATA_SIZE,
  CH_TOTAL_SIZE,
  HOST_INTERCEPTED_SYSCALLS,
} from "../src/generated/abi";

const E2BIG = 7;
const EFAULT = 14;
const EINVAL = 22;
const EIO = 5;
const ENOMEM = 12;
const ENAMETOOLONG = 36;

describe("SYS_SPAWN blob transport", () => {
  it("uses one reusable kernel-owned buffer for blobs larger than a syscall channel", async () => {
    const parentPid = 7;
    const childPid = 42;
    const path = new TextEncoder().encode("/bin/child");
    const envp = Array.from(
      { length: 96 },
      (_, index) => `SPAWN_ENV_${index}=${"x".repeat(1024)}`,
    );
    const blob = buildSpawnBlob(["child", "success"], envp);
    expect(blob.byteLength).toBeGreaterThan(CH_TOTAL_SIZE);

    const processMemory = sharedMemoryFor(4096 + blob.byteLength);
    const processBytes = new Uint8Array(processMemory.buffer);
    const pathPtr = 256;
    const blobPtr = 4096;
    const pidOutPtr = 512;
    processBytes.set(path, pathPtr);
    processBytes.set(blob, blobPtr);

    const kernelMemory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
    const kernelBytes = new Uint8Array(kernelMemory.buffer);
    const generalScratchOffset = 1024;
    const largeScratchOffset = 2 * CH_TOTAL_SIZE;
    kernelBytes.fill(
      0xa5,
      generalScratchOffset,
      generalScratchOffset + CH_TOTAL_SIZE,
    );
    const allocScratch = vi.fn(() => largeScratchOffset);
    const kernelSpawn = vi.fn((
      actualParentPid: number,
      actualCallerTid: number,
      actualBlobPtr: number,
      actualBlobLen: number,
    ) => {
      expect(actualParentPid).toBe(parentPid);
      expect(actualCallerTid).toBe(parentPid);
      expect(actualBlobPtr).toBe(largeScratchOffset);
      expect(actualBlobLen).toBe(blob.byteLength);
      expect(
        kernelBytes.slice(actualBlobPtr, actualBlobPtr + actualBlobLen),
      ).toEqual(blob);
      return childPid;
    });
    const onSpawn = vi.fn(() => new Promise<number>(() => {}));
    const channel = createChannel(parentPid, processMemory);
    const worker = createWorker({
      callbacks: {
        onResolveSpawn: vi.fn(async () => resolvedProgram()),
        onSpawn,
      },
      processes: new Map([[
        parentPid,
        { channels: [channel], memory: processMemory, ptrWidth: 4 },
      ]]),
      kernelMemory,
      scratchOffset: generalScratchOffset,
      largeSpawnScratchOffset: 0,
      kernelInstance: {
        exports: {
          kernel_alloc_scratch: allocScratch,
          kernel_spawn_process: kernelSpawn,
        },
      },
    });
    const args = [
      pathPtr,
      path.byteLength,
      blobPtr,
      blob.byteLength,
      pidOutPtr,
      0,
    ];

    worker.handleSpawn(channel, args);
    await Promise.resolve();
    await Promise.resolve();

    expect(allocScratch).toHaveBeenCalledOnce();
    expect(allocScratch).toHaveBeenCalledWith(SPAWN_BLOB_MAX_BYTES);
    expect(kernelSpawn).toHaveBeenCalledOnce();
    expect(onSpawn).toHaveBeenCalledWith(
      parentPid,
      childPid,
      expect.any(Object),
      envp,
    );
    expect(
      kernelBytes.slice(
        generalScratchOffset,
        generalScratchOffset + CH_TOTAL_SIZE,
      ),
    ).toEqual(new Uint8Array(CH_TOTAL_SIZE).fill(0xa5));

    worker.handleSpawnAfterResolve(
      channel,
      args,
      parentPid,
      parentPid,
      pidOutPtr,
      blob,
      blob.byteLength,
      resolvedProgram(),
      envp,
    );
    expect(allocScratch).toHaveBeenCalledOnce();
    expect(kernelSpawn).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary spawn blobs in the existing channel-sized scratch", () => {
    const blob = buildSpawnBlob(["child"], ["A=B"]);
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const scratchOffset = 1024;
    const allocScratch = vi.fn();
    const kernelSpawn = vi.fn(() => 42);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      scratchOffset,
      kernelInstance: {
        exports: {
          kernel_alloc_scratch: allocScratch,
          kernel_spawn_process: kernelSpawn,
        },
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blob.byteLength, 0, 0],
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      ["A=B"],
    );

    expect(allocScratch).not.toHaveBeenCalled();
    expect(kernelSpawn).toHaveBeenCalledWith(
      7,
      7,
      scratchOffset,
      blob.byteLength,
    );
    expect(
      new Uint8Array(kernelMemory.buffer).slice(
        scratchOffset,
        scratchOffset + blob.byteLength,
      ),
    ).toEqual(blob);
  });

  it.each([
    {
      name: "the exact channel-size boundary",
      blobLen: CH_TOTAL_SIZE,
      expectedOffset: 1024,
      expectedAllocations: 0,
    },
    {
      name: "the first byte above the channel-size boundary",
      blobLen: CH_TOTAL_SIZE + 1,
      expectedOffset: 2 * CH_TOTAL_SIZE,
      expectedAllocations: 1,
    },
  ])("selects the bounded transport at $name", ({
    blobLen,
    expectedOffset,
    expectedAllocations,
  }) => {
    const blob = new Uint8Array(blobLen).fill(0x5a);
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const allocScratch = vi.fn(() => 2 * CH_TOTAL_SIZE);
    const kernelSpawn = vi.fn(() => 42);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      scratchOffset: 1024,
      largeSpawnScratchOffset: 0,
      kernelInstance: {
        exports: {
          kernel_alloc_scratch: allocScratch,
          kernel_spawn_process: kernelSpawn,
        },
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blobLen, 0, 0],
      7,
      7,
      0,
      blob,
      blobLen,
      resolvedProgram(),
      [],
    );

    expect(allocScratch).toHaveBeenCalledTimes(expectedAllocations);
    expect(kernelSpawn).toHaveBeenCalledWith(
      7,
      7,
      expectedOffset,
      blobLen,
    );
  });

  it("accepts the exact whole-blob transport maximum", () => {
    const blob = new Uint8Array(SPAWN_BLOB_MAX_BYTES);
    const largeScratchOffset = 1024;
    const requiredBytes = largeScratchOffset + blob.byteLength;
    const pages = Math.ceil(requiredBytes / 65_536);
    const kernelMemory = new WebAssembly.Memory({
      initial: pages,
      maximum: pages,
    });
    const kernelSpawn = vi.fn(() => 42);
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn(() => new Promise<number>(() => {})) },
      kernelMemory,
      scratchOffset: 0,
      largeSpawnScratchOffset: 0,
      kernelInstance: {
        exports: {
          kernel_alloc_scratch: vi.fn(() => largeScratchOffset),
          kernel_spawn_process: kernelSpawn,
        },
      },
    });

    worker.handleSpawnAfterResolve(
      createChannel(7, sharedMemoryFor(65_536)),
      [0, 0, 0, blob.byteLength, 0, 0],
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(kernelSpawn).toHaveBeenCalledWith(
      7,
      7,
      largeScratchOffset,
      SPAWN_BLOB_MAX_BYTES,
    );
  });

  it("returns ENOMEM without touching the kernel when large transport allocation fails", () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const kernelSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn() },
      completeChannel,
      kernelMemory: new WebAssembly.Memory({ initial: 2, maximum: 2 }),
      scratchOffset: 1024,
      kernelInstance: {
        exports: {
          kernel_alloc_scratch: vi.fn(() => 0),
          kernel_spawn_process: kernelSpawn,
        },
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];

    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(kernelSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      ENOMEM,
    );
  });

  it("rejects a large transport allocation outside kernel memory", () => {
    const blob = new Uint8Array(CH_TOTAL_SIZE + 1);
    const completeChannel = vi.fn();
    const kernelSpawn = vi.fn();
    const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const worker = createWorker({
      callbacks: { onSpawn: vi.fn() },
      completeChannel,
      kernelMemory,
      scratchOffset: 1024,
      kernelInstance: {
        exports: {
          kernel_alloc_scratch: vi.fn(
            () => kernelMemory.buffer.byteLength - blob.byteLength + 1,
          ),
          kernel_spawn_process: kernelSpawn,
        },
      },
    });
    const channel = createChannel(7, sharedMemoryFor(65_536));
    const args = [0, 0, 0, blob.byteLength, 0, 0];

    worker.handleSpawnAfterResolve(
      channel,
      args,
      7,
      7,
      0,
      blob,
      blob.byteLength,
      resolvedProgram(),
      [],
    );

    expect(kernelSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      EIO,
    );
  });

  it.each([
    {
      name: "path range",
      args: (memoryBytes: number) => [
        memoryBytes - 2,
        4,
        256,
        40,
        128,
        0,
      ],
      errno: EFAULT,
    },
    {
      name: "blob range",
      args: (memoryBytes: number) => [64, 4, memoryBytes - 8, 40, 128, 0],
      errno: EFAULT,
    },
    {
      name: "pid output range",
      args: (memoryBytes: number) => [64, 4, 256, 40, memoryBytes - 2, 0],
      errno: EFAULT,
    },
    {
      name: "fractional blob length",
      args: (_memoryBytes: number) => [64, 4, 256, 40.5, 128, 0],
      errno: EINVAL,
    },
    {
      name: "empty blob",
      args: (_memoryBytes: number) => [64, 4, 256, 0, 128, 0],
      errno: EINVAL,
    },
    {
      name: "truncated blob header",
      args: (_memoryBytes: number) => [64, 4, 256, 39, 128, 0],
      errno: EINVAL,
    },
    {
      name: "PATH_MAX-byte path",
      args: (_memoryBytes: number) => [64, 4096, 256, 40, 128, 0],
      errno: ENAMETOOLONG,
    },
  ])("rejects an invalid $name before resolution", ({ args, errno }) => {
    const memory = sharedMemoryFor(65_536);
    const bytes = new Uint8Array(memory.buffer);
    bytes.set(new TextEncoder().encode("/bin"), 64);
    bytes.fill(0, 256, 296);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      processes: new Map([[7, { channels: [channel], memory, ptrWidth: 4 }]]),
      completeChannel,
    });
    const syscallArgs = args(memory.buffer.byteLength);

    worker.handleSpawn(channel, syscallArgs);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      syscallArgs,
      undefined,
      -1,
      errno,
    );
  });

  it("rejects a whole spawn representation above its explicit transport bound", () => {
    const memory = sharedMemoryFor(65_536);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      processes: new Map([[7, { channels: [channel], memory, ptrWidth: 4 }]]),
      completeChannel,
    });
    const args = [0, 0, 256, SPAWN_BLOB_MAX_BYTES + 1, 0, 0];

    worker.handleSpawn(channel, args);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      E2BIG,
    );
  });

  it("enforces exec's per-entry ARG_MAX transport contract before resolution", () => {
    const blob = buildSpawnBlob(["child"], [`A=${"x".repeat(CH_DATA_SIZE)}`]);
    const memory = sharedMemoryFor(4096 + blob.byteLength);
    const bytes = new Uint8Array(memory.buffer);
    const path = new TextEncoder().encode("/bin/child");
    const pathPtr = 256;
    const blobPtr = 4096;
    bytes.set(path, pathPtr);
    bytes.set(blob, blobPtr);
    const channel = createChannel(7, memory);
    const completeChannel = vi.fn();
    const onResolveSpawn = vi.fn();
    const worker = createWorker({
      callbacks: { onResolveSpawn, onSpawn: vi.fn() },
      processes: new Map([[7, { channels: [channel], memory, ptrWidth: 4 }]]),
      completeChannel,
    });
    const args = [
      pathPtr,
      path.byteLength,
      blobPtr,
      blob.byteLength,
      0,
      0,
    ];

    worker.handleSpawn(channel, args);

    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      args,
      undefined,
      -1,
      E2BIG,
    );
  });
});

function createWorker(overrides: Record<string, unknown>): any {
  const worker = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    callbacks: {},
    processes: new Map(),
    channelTids: new Map(),
    hostReaped: new Set(),
    sharedMappings: new Map(),
    tcpListenerTargets: new Map(),
    tcpListenerRRIndex: new Map(),
    tcpListeners: new Map(),
    epollInterests: new Map(),
    completeChannel: vi.fn(),
    ...overrides,
  });
  const kernelInstance = worker.kernelInstance ?? { exports: {} };
  worker.kernelInstance = {
    ...kernelInstance,
    exports: {
      kernel_get_process_exit_signal: vi.fn(() => -1),
      ...(kernelInstance.exports ?? {}),
    },
  };
  return worker;
}

function createChannel(pid: number, memory: WebAssembly.Memory): any {
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer),
    consecutiveSyscalls: 0,
  };
}

function sharedMemoryFor(requiredBytes: number): WebAssembly.Memory {
  const pages = Math.ceil(requiredBytes / 65_536);
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function buildSpawnBlob(argv: readonly string[], envp: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const argvBytes = argv.map((value) => encoder.encode(`${value}\0`));
  const envpBytes = envp.map((value) => encoder.encode(`${value}\0`));
  const headerBytes = 40;
  const offsetsBytes = (argv.length + envp.length) * 4;
  const stringsBytes = [...argvBytes, ...envpBytes]
    .reduce((total, value) => total + value.byteLength, 0);
  const blob = new Uint8Array(headerBytes + offsetsBytes + stringsBytes);
  const view = new DataView(blob.buffer);
  view.setUint32(0, argv.length, true);
  view.setUint32(4, envp.length, true);

  let stringsCursor = 0;
  let offsetCursor = headerBytes;
  const stringsStart = headerBytes + offsetsBytes;
  for (const value of [...argvBytes, ...envpBytes]) {
    view.setUint32(offsetCursor, stringsCursor, true);
    offsetCursor += 4;
    blob.set(value, stringsStart + stringsCursor);
    stringsCursor += value.byteLength;
  }
  return blob;
}

function resolvedProgram() {
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ]);
  return {
    programBytes: bytes.buffer,
    programModule: new WebAssembly.Module(bytes),
    argv: [],
  };
}
