import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
  type CentralizedKernelWorker,
} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import type { PlatformIO } from "../src/types";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const KERNEL_EXPORT_NAMES = [
  "kernel_ipc_shm_read_chunk",
  "kernel_ipc_shmat_for_process",
  "kernel_ipc_shmdt_for_process",
] as const;

interface TestProcessRegistration {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channels: readonly unknown[];
  readonly ptrWidth: 4 | 8;
  readonly explicitMaxAddr: boolean;
}

interface TestSharedMapping {
  readonly fd: number;
  readonly fileOffset: number;
  readonly len: number;
  readonly writable: boolean;
  readonly backingKind: "anonymous" | "file";
  readonly backingKey: string;
  readonly snapshot: Uint8Array;
  readonly seenVersion: number;
}

interface TestSysvMapping {
  readonly segId: number;
  readonly size: number;
  readonly readOnly: boolean;
  readonly snapshot: Uint8Array;
  readonly seenVersion: number;
}

interface TestAnonymousBacking {
  readonly key: string;
  readonly bytes: Uint8Array;
  refCount: number;
  version: number;
}

interface TestFileBacking {
  readonly key: string;
  readonly handle: number;
  readonly writable: boolean;
  readonly size: number;
  readonly sizeValid: boolean;
  readonly pages: Map<number, Uint8Array>;
  readonly dirtyPages: Set<number>;
  refCount: number;
  version: number;
}

interface SharedInheritanceState {
  processes: Map<number, TestProcessRegistration>;
  sharedMappings: Map<number, Map<number, TestSharedMapping>>;
  anonymousSharedBackings: Map<string, TestAnonymousBacking>;
  sharedMmapBackings: Map<string, TestFileBacking>;
  shmMappings: Map<number, Map<number, TestSysvMapping>>;
  shmSegmentVersions: Map<number, number>;
}

interface InheritanceHarness {
  readonly worker: CentralizedKernelWorker;
  readonly state: SharedInheritanceState;
  readonly kernelMemory: WebAssembly.Memory;
  readonly implementations: Record<string, unknown>;
}

function processMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
}

function processRegistration(
  pid: number,
  memory: WebAssembly.Memory,
): TestProcessRegistration {
  return {
    pid,
    memory,
    channels: [],
    ptrWidth: 4,
    explicitMaxAddr: true,
  };
}

function setWorkerState(
  worker: CentralizedKernelWorker,
  name: keyof SharedInheritanceState,
  value: SharedInheritanceState[keyof SharedInheritanceState],
): void {
  if (!Object.prototype.hasOwnProperty.call(worker, name)) {
    throw new Error(`test worker is missing production state ${name}`);
  }
  Reflect.set(worker, name, value);
}

function makeHarness(
  options: {
    readonly io?: Partial<PlatformIO>;
    readonly implementations?: Record<string, unknown>;
  } = {},
): InheritanceHarness {
  const implementations: Record<string, unknown> = {
    kernel_ipc_shm_read_chunk: () => 0,
    kernel_ipc_shmat_for_process: () => -1,
    kernel_ipc_shmdt_for_process: () => 0,
    ...options.implementations,
  };
  const worker = createCentralizedKernelWorkerTestDouble({
    io: options.io as PlatformIO | undefined,
  });
  const kernelMemory = new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
  });
  installKernelWorkerTestScratch(worker, kernelMemory, 4_096, 4, {
    kernelExports: implementations,
    kernelExportNames: KERNEL_EXPORT_NAMES,
  });
  const state: SharedInheritanceState = {
    processes: new Map(),
    sharedMappings: new Map(),
    anonymousSharedBackings: new Map(),
    sharedMmapBackings: new Map(),
    shmMappings: new Map(),
    shmSegmentVersions: new Map(),
  };
  for (const [name, value] of Object.entries(state)) {
    setWorkerState(
      worker,
      name as keyof SharedInheritanceState,
      value,
    );
  }
  return { worker, state, kernelMemory, implementations };
}

describe("shared-memory inheritance entry authority", () => {
  it("keeps child ownership private across a reentrant host backing read", () => {
    const parentPid = 41;
    const childPid = 42;
    const mapAddr = 0x1000;
    const length = 32;
    const backingKey = "file:test";
    const childMemory = processMemory();
    new Uint8Array(childMemory.buffer, mapAddr, length).fill(0x55);
    let harness!: InheritanceHarness;
    let retainedBackendView: Uint8Array | undefined;
    const reentrantErrors: unknown[] = [];
    const observations: Array<{
      readonly childMapped: boolean;
      readonly refCount: number;
      readonly firstByte: number;
    }> = [];
    const io = {
      read: (
        _handle: number,
        output: Uint8Array,
        _offset: number | bigint | null,
        count: number,
      ) => {
        const backing =
          harness.state.sharedMmapBackings.get(backingKey)!;
        observations.push({
          childMapped: harness.state.sharedMappings.has(childPid),
          refCount: backing.refCount,
          firstByte:
            new Uint8Array(childMemory.buffer)[mapAddr]!,
        });
        try {
          harness.worker.inheritProcessSharedMappings(parentPid, childPid);
        } catch (error) {
          reentrantErrors.push(error);
        }
        retainedBackendView = output;
        output.fill(0xa7, 0, count);
        return count;
      },
    } as unknown as Partial<PlatformIO>;
    harness = makeHarness({ io });
    const backing: TestFileBacking = {
      key: backingKey,
      handle: 7,
      writable: true,
      size: length,
      sizeValid: true,
      pages: new Map(),
      dirtyPages: new Set(),
      refCount: 1,
      version: 0,
    };
    harness.state.processes.set(
      childPid,
      processRegistration(childPid, childMemory),
    );
    harness.state.sharedMmapBackings.set(backingKey, backing);
    harness.state.sharedMappings.set(parentPid, new Map([
      [mapAddr, {
        fd: 4,
        fileOffset: 0,
        len: length,
        writable: true,
        backingKind: "file",
        backingKey,
        snapshot: new Uint8Array(length),
        seenVersion: 0,
      }],
    ]));

    harness.worker.inheritProcessSharedMappings(parentPid, childPid);

    expect(observations).toEqual([{
      childMapped: false,
      refCount: 1,
      firstByte: 0x55,
    }]);
    expect(reentrantErrors).toHaveLength(1);
    expect(reentrantErrors[0]).toBeInstanceOf(KernelReentrantEntryError);
    expect(backing.refCount).toBe(2);
    expect(harness.state.sharedMappings.get(childPid)?.size).toBe(1);
    expect(
      Array.from(
        new Uint8Array(childMemory.buffer, mapAddr, length),
      ),
    ).toEqual(Array(length).fill(0xa7));

    // WHY: a PlatformIO implementation may retain the view it was given.
    // The staged read must publish an owned copy, not let that backend mutate
    // the backing cache or inherited process bytes after the lease commits.
    retainedBackendView!.fill(0x19);
    expect(backing.pages.get(0)?.[0]).toBe(0xa7);
    expect(new Uint8Array(childMemory.buffer)[mapAddr]).toBe(0xa7);
  });

  it("rejects an in-place child memory replacement before Rust attachment or publication", () => {
    const parentPid = 45;
    const childPid = 46;
    const sharedAddr = 0x1000;
    const sysvAddr = 0x2000;
    const length = 16;
    const backingKey = "file:memory-replacement";
    const originalMemory = processMemory();
    const replacementMemory = processMemory();
    new Uint8Array(originalMemory.buffer).fill(0x55);
    new Uint8Array(replacementMemory.buffer).fill(0x66);
    const childRegistration =
      processRegistration(childPid, originalMemory);
    const reentrantErrors: unknown[] = [];
    let harness!: InheritanceHarness;
    const shmat = vi.fn(() => length);
    const shmdt = vi.fn(() => 0);
    const io = {
      read: (
        _handle: number,
        output: Uint8Array,
        _offset: number | bigint | null,
        count: number,
      ) => {
        try {
          harness.worker.inheritProcessSharedMappings(parentPid, childPid);
        } catch (error) {
          reentrantErrors.push(error);
        }
        Reflect.set(childRegistration, "memory", replacementMemory);
        output.fill(0xa7, 0, count);
        return count;
      },
    } as unknown as Partial<PlatformIO>;
    harness = makeHarness({
      io,
      implementations: {
        kernel_ipc_shmat_for_process: shmat,
        kernel_ipc_shmdt_for_process: shmdt,
      },
    });
    const backing: TestFileBacking = {
      key: backingKey,
      handle: 8,
      writable: true,
      size: length,
      sizeValid: true,
      pages: new Map(),
      dirtyPages: new Set(),
      refCount: 1,
      version: 0,
    };
    harness.state.processes.set(childPid, childRegistration);
    harness.state.sharedMmapBackings.set(backingKey, backing);
    harness.state.sharedMappings.set(parentPid, new Map([
      [sharedAddr, {
        fd: 4,
        fileOffset: 0,
        len: length,
        writable: true,
        backingKind: "file",
        backingKey,
        snapshot: new Uint8Array(length),
        seenVersion: 0,
      }],
    ]));
    harness.state.shmMappings.set(parentPid, new Map([
      [sysvAddr, {
        segId: 11,
        size: length,
        readOnly: false,
        snapshot: new Uint8Array(length),
        seenVersion: 0,
      }],
    ]));

    expect(() => {
      harness.worker.inheritProcessSharedMappings(parentPid, childPid);
    }).toThrow(/changed during shared mapping inheritance/);

    expect(reentrantErrors).toHaveLength(1);
    expect(reentrantErrors[0]).toBeInstanceOf(KernelReentrantEntryError);
    expect(shmat).not.toHaveBeenCalled();
    expect(shmdt).not.toHaveBeenCalled();
    expect(backing.refCount).toBe(1);
    expect(harness.state.sharedMappings.has(childPid)).toBe(false);
    expect(harness.state.shmMappings.has(childPid)).toBe(false);
    expect(new Uint8Array(originalMemory.buffer)[sharedAddr]).toBe(0x55);
    expect(new Uint8Array(originalMemory.buffer)[sysvAddr]).toBe(0x55);
    expect(new Uint8Array(replacementMemory.buffer)[sharedAddr]).toBe(0x66);
    expect(new Uint8Array(replacementMemory.buffer)[sysvAddr]).toBe(0x66);
  });

  it("rejects an oversized backing write result without exposing cached bytes", () => {
    const pid = 47;
    const backingKey = "file:write-result";
    const page = new Uint8Array(4096).fill(0x6a);
    let harness!: InheritanceHarness;
    let retainedBackendView: Uint8Array | undefined;
    const reentrantErrors: unknown[] = [];
    const io = {
      write: (
        _handle: number,
        input: Uint8Array,
        _offset: number | bigint | null,
        count: number,
      ) => {
        retainedBackendView = input;
        try {
          harness.worker.finalizeAddressSpaceForExec(pid + 1);
        } catch (error) {
          reentrantErrors.push(error);
        }
        // A backend may be buggy or hostile, but it cannot claim ownership of
        // one byte beyond the exact slice supplied by this write iteration.
        return count + 1;
      },
    } as unknown as Partial<PlatformIO>;
    harness = makeHarness({ io });
    const backing: TestFileBacking = {
      key: backingKey,
      handle: 9,
      writable: true,
      size: 16,
      sizeValid: true,
      pages: new Map([[0, page]]),
      dirtyPages: new Set([0]),
      refCount: 1,
      version: 0,
    };
    harness.state.sharedMmapBackings.set(backingKey, backing);
    harness.state.sharedMappings.set(pid, new Map([
      [0x1000, {
        fd: 4,
        fileOffset: 0,
        len: 16,
        writable: true,
        backingKind: "file",
        backingKey,
        snapshot: new Uint8Array(16),
        seenVersion: 0,
      }],
    ]));

    expect(harness.worker.finalizeAddressSpaceForExec(pid)).toBe(0);

    expect(reentrantErrors).toHaveLength(1);
    expect(reentrantErrors[0]).toBeInstanceOf(KernelReentrantEntryError);
    expect(retainedBackendView).toHaveLength(16);
    expect(backing.refCount).toBe(0);
    expect(backing.dirtyPages.has(0)).toBe(true);
    expect(harness.state.sharedMmapBackings.get(backingKey)).toBe(backing);
    expect(harness.state.sharedMappings.has(pid)).toBe(false);

    // The backend saw only an owned write snapshot. Retaining and mutating it
    // after return cannot rewrite the still-dirty authoritative cache.
    retainedBackendView!.fill(0x19);
    expect(backing.pages.get(0)?.[0]).toBe(0x6a);
    expect(harness.worker.finalizeAddressSpaceForExec(pid + 2)).toBe(0);
  });

  it("holds gate ownership across a host-only backing write", () => {
    const pid = 48;
    const backingKey = "file:host-only-write";
    const page = new Uint8Array(4096).fill(0x72);
    let harness!: InheritanceHarness;
    let retainedBackendView: Uint8Array | undefined;
    const reentrantErrors: unknown[] = [];
    const io = {
      write: (
        _handle: number,
        input: Uint8Array,
        _offset: number | bigint | null,
        count: number,
      ) => {
        retainedBackendView = input;
        try {
          harness.worker.finalizeAddressSpaceForExec(pid);
        } catch (error) {
          reentrantErrors.push(error);
        }
        return count;
      },
    } as unknown as Partial<PlatformIO>;
    harness = makeHarness({ io });
    const backing: TestFileBacking = {
      key: backingKey,
      handle: 10,
      writable: true,
      size: 16,
      sizeValid: true,
      pages: new Map([[0, page]]),
      dirtyPages: new Set([0]),
      refCount: 1,
      version: 0,
    };
    harness.state.sharedMmapBackings.set(backingKey, backing);

    expect((harness.worker as any).flushSharedMmapBackingRange(
      backing,
      0,
      16,
    )).toBe(true);

    expect(reentrantErrors).toHaveLength(1);
    expect(reentrantErrors[0]).toBeInstanceOf(KernelReentrantEntryError);
    expect(backing.dirtyPages.has(0)).toBe(false);
    retainedBackendView!.fill(0x21);
    expect(backing.pages.get(0)?.[0]).toBe(0x72);
    expect(harness.worker.finalizeAddressSpaceForExec(pid)).toBe(0);
  });

  it("rolls back an earlier SysV attachment before publishing any child state", async () => {
    const parentPid = 51;
    const childPid = 52;
    const anonymousAddr = 0x1000;
    const firstSysvAddr = 0x2000;
    const secondSysvAddr = 0x3000;
    const size = 16;
    const backingKey = "anon:test";
    const anonymousBytes = new Uint8Array(size).fill(0x31);
    const segments = new Map<number, Uint8Array>([
      [11, new Uint8Array(size).fill(0x41)],
      [12, new Uint8Array(size).fill(0x42)],
    ]);
    const childMemory = processMemory();
    new Uint8Array(childMemory.buffer).fill(0x77);
    let harness!: InheritanceHarness;
    const shmat = vi.fn((_pid: number, segId: number) =>
      segId === 11 ? size : -12);
    const shmdt = vi.fn(() => 0);
    const readChunk = vi.fn((
      segId: number,
      offset: number,
      pointer: number,
      maxLength: number,
    ) => {
      const segment = segments.get(segId)!;
      const length = Math.min(maxLength, segment.byteLength - offset);
      new Uint8Array(harness.kernelMemory.buffer).set(
        segment.subarray(offset, offset + length),
        pointer,
      );
      return length;
    });
    harness = makeHarness({
      implementations: {
        kernel_ipc_shm_read_chunk: readChunk,
        kernel_ipc_shmat_for_process: shmat,
        kernel_ipc_shmdt_for_process: shmdt,
      },
    });
    const backing: TestAnonymousBacking = {
      key: backingKey,
      bytes: anonymousBytes,
      refCount: 1,
      version: 0,
    };
    harness.state.processes.set(
      childPid,
      processRegistration(childPid, childMemory),
    );
    harness.state.anonymousSharedBackings.set(backingKey, backing);
    harness.state.sharedMappings.set(parentPid, new Map([
      [anonymousAddr, {
        fd: -1,
        fileOffset: 0,
        len: size,
        writable: true,
        backingKind: "anonymous",
        backingKey,
        snapshot: new Uint8Array(size),
        seenVersion: 0,
      }],
    ]));
    const sysvMapping = (segId: number): TestSysvMapping => ({
      segId,
      size,
      readOnly: false,
      snapshot: new Uint8Array(size),
      seenVersion: 0,
    });
    harness.state.shmMappings.set(parentPid, new Map([
      [firstSysvAddr, sysvMapping(11)],
      [secondSysvAddr, sysvMapping(12)],
    ]));

    expect(() => {
      harness.worker.inheritProcessSharedMappings(parentPid, childPid);
    }).toThrow(/SysV shmat inheritance failed for segment 12/);

    expect(shmat.mock.calls).toEqual([
      [childPid, 11, firstSysvAddr, 0],
      [childPid, 12, secondSysvAddr, 0],
    ]);
    expect(readChunk).toHaveBeenCalledOnce();
    expect(shmdt).toHaveBeenCalledExactlyOnceWith(childPid, 11);
    expect(backing.refCount).toBe(1);
    expect(harness.state.sharedMappings.has(childPid)).toBe(false);
    expect(harness.state.shmMappings.has(childPid)).toBe(false);
    expect(
      new Uint8Array(childMemory.buffer)[anonymousAddr],
    ).toBe(0x77);
    expect(
      new Uint8Array(childMemory.buffer)[firstSysvAddr],
    ).toBe(0x77);

    // Expected errno rollback leaves the generation reusable.
    await Promise.resolve();
    shmat.mockImplementation(() => size);
    harness.worker.inheritProcessSharedMappings(parentPid, childPid);

    expect(backing.refCount).toBe(2);
    expect(harness.state.sharedMappings.get(childPid)?.size).toBe(1);
    expect(harness.state.shmMappings.get(childPid)?.size).toBe(2);
    expect(
      new Uint8Array(childMemory.buffer)[anonymousAddr],
    ).toBe(0x31);
    expect(
      new Uint8Array(childMemory.buffer)[firstSysvAddr],
    ).toBe(0x41);
    expect(
      new Uint8Array(childMemory.buffer)[secondSysvAddr],
    ).toBe(0x42);
  });

  it("restores bytes and prior refcounts if host publication fails mid-retain", () => {
    const parentPid = 61;
    const childPid = 62;
    const firstAddr = 0x1000;
    const secondAddr = 0x2000;
    const size = 16;
    const childMemory = processMemory();
    new Uint8Array(childMemory.buffer).fill(0x66);
    const harness = makeHarness();
    const firstBacking: TestAnonymousBacking = {
      key: "anon:first",
      bytes: new Uint8Array(size).fill(0x11),
      refCount: 1,
      version: 0,
    };
    let secondRefCount = 1;
    const secondBacking = {
      key: "anon:second",
      bytes: new Uint8Array(size).fill(0x22),
      version: 0,
    } as TestAnonymousBacking;
    Object.defineProperty(secondBacking, "refCount", {
      configurable: false,
      enumerable: true,
      get: () => secondRefCount,
      set: (_value: number) => {
        throw new Error("injected retain publication failure");
      },
    });
    harness.state.processes.set(
      childPid,
      processRegistration(childPid, childMemory),
    );
    harness.state.anonymousSharedBackings.set(
      firstBacking.key,
      firstBacking,
    );
    harness.state.anonymousSharedBackings.set(
      secondBacking.key,
      secondBacking,
    );
    const mapping = (backing: TestAnonymousBacking): TestSharedMapping => ({
      fd: -1,
      fileOffset: 0,
      len: size,
      writable: true,
      backingKind: "anonymous",
      backingKey: backing.key,
      snapshot: new Uint8Array(size),
      seenVersion: 0,
    });
    harness.state.sharedMappings.set(parentPid, new Map([
      [firstAddr, mapping(firstBacking)],
      [secondAddr, mapping(secondBacking)],
    ]));

    let failure: unknown;
    try {
      harness.worker.inheritProcessSharedMappings(parentPid, childPid);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(
      (failure as Error & { cause?: unknown }).cause,
    ).toEqual(expect.objectContaining({
      message: "injected retain publication failure",
    }));
    expect(firstBacking.refCount).toBe(1);
    expect(secondRefCount).toBe(1);
    expect(harness.state.sharedMappings.has(childPid)).toBe(false);
    expect(harness.state.shmMappings.has(childPid)).toBe(false);
    expect(new Uint8Array(childMemory.buffer)[firstAddr]).toBe(0x66);
    expect(new Uint8Array(childMemory.buffer)[secondAddr]).toBe(0x66);
  });

  it("rejects a non-lossless wasm64 SysV address before attachment", () => {
    const parentPid = 71;
    const childPid = 72;
    const highAddress = 0x1_0000_0000;
    const shmat = vi.fn(() => 16);
    const harness = makeHarness({
      implementations: {
        kernel_ipc_shmat_for_process: shmat,
      },
    });
    harness.state.processes.set(
      childPid,
      processRegistration(childPid, processMemory()),
    );
    harness.state.shmMappings.set(parentPid, new Map([
      [highAddress, {
        segId: 11,
        size: 16,
        readOnly: false,
        snapshot: new Uint8Array(16),
        seenVersion: 0,
      }],
    ]));

    expect(() => {
      harness.worker.inheritProcessSharedMappings(parentPid, childPid);
    }).toThrow(/Cannot inherit SysV mapping/);
    expect(shmat).not.toHaveBeenCalled();
    expect(harness.state.shmMappings.has(childPid)).toBe(false);
  });
});
