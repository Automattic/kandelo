import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
  type CentralizedKernelWorker,
} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import type { PlatformIO } from "../src/types";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  createSysvMirrorStub,
  SYSV_MIRROR_EXPORT_NAMES,
  type SysvMirrorStub,
  type SysvMirrorStubOptions,
} from "./support/sysv-mirror-stub";

const KERNEL_EXPORT_NAMES = [
  "kernel_ipc_shm_read_chunk",
  "kernel_ipc_shm_record_mapping_for_process",
  "kernel_ipc_shmat_for_process",
  "kernel_ipc_shmdt_addr_for_process",
  "kernel_ipc_shmdt_for_process",
  ...SYSV_MIRROR_EXPORT_NAMES,
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
  /**
   * Cached count of processes owning SysV attachments. The mirror itself is
   * Rust-owned; this is the predicate the host gates every entry into it on.
   */
  sysvActivePidCount: number;
}

interface InheritanceHarness {
  readonly worker: CentralizedKernelWorker;
  readonly state: SharedInheritanceState;
  readonly kernelMemory: WebAssembly.Memory;
  readonly implementations: Record<string, unknown>;
  /** Stand-in for the Rust-owned SysV byte-coherence mirror. */
  readonly sysv: SysvMirrorStub;
  /**
   * Seed a parent attachment and make the host's gate see it, exactly as a
   * successful `shmat` would have.
   */
  seedSysv(pid: number, addr: number, segId: number, size: number): void;
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
    readonly sysv?: SysvMirrorStubOptions;
  } = {},
): InheritanceHarness {
  const sysv = createSysvMirrorStub(options.sysv);
  const implementations: Record<string, unknown> = {
    kernel_ipc_shm_read_chunk: () => 0,
    kernel_ipc_shm_record_mapping_for_process: () => 0,
    kernel_ipc_shmat_for_process: () => -1,
    kernel_ipc_shmdt_addr_for_process: () => 0,
    kernel_ipc_shmdt_for_process: () => 0,
    ...sysv.exports,
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
    sysvActivePidCount: 0,
  };
  for (const [name, value] of Object.entries(state)) {
    setWorkerState(
      worker,
      name as keyof SharedInheritanceState,
      value,
    );
  }
  return {
    worker,
    state,
    kernelMemory,
    implementations,
    sysv,
    seedSysv(pid, addr, segId, size) {
      sysv.seed(pid, addr, { segId, size, readOnly: false });
      state.sysvActivePidCount = sysv.attachments.size;
      setWorkerState(worker, "sysvActivePidCount", sysv.attachments.size);
    },
  };
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
    harness.seedSysv(parentPid, sysvAddr, 11, length);

    expect(() => {
      harness.worker.inheritProcessSharedMappings(parentPid, childPid);
    }).toThrow(/changed during shared mapping inheritance/);

    expect(reentrantErrors).toHaveLength(1);
    expect(reentrantErrors[0]).toBeInstanceOf(KernelReentrantEntryError);
    expect(shmat).not.toHaveBeenCalled();
    expect(shmdt).not.toHaveBeenCalled();
    // Validation runs before the kernel is entered at all, so the SysV
    // transaction never starts.
    expect(harness.sysv.calls).toEqual([]);
    expect(backing.refCount).toBe(1);
    expect(harness.state.sharedMappings.has(childPid)).toBe(false);
    expect(harness.sysv.count(childPid)).toBe(0);
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

  // The per-attachment attach/record/detach interleaving and its rollback
  // ordering moved into the kernel, where the whole transaction commits or
  // unwinds as one. It is covered by
  // `SharedMappingTable::inherit_sysv_attachments`'s tests in
  // `crates/runtime-core/src/memory.rs`, four of which are rollback paths.
  // What remains a host concern, and is tested here, is that a refused
  // transaction leaves no child state behind and leaves the entry generation
  // reusable for a retry.
  it("leaves no child state and a reusable generation when SysV inheritance is refused", async () => {
    const parentPid = 51;
    const childPid = 52;
    const anonymousAddr = 0x1000;
    const firstSysvAddr = 0x2000;
    const secondSysvAddr = 0x3000;
    const size = 16;
    const backingKey = "anon:test";
    const anonymousBytes = new Uint8Array(size).fill(0x31);
    const childMemory = processMemory();
    new Uint8Array(childMemory.buffer).fill(0x77);
    const harness = makeHarness({
      sysv: { fail: { kernel_shared_mapping_sysv_inherit: -12 } },
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
    harness.seedSysv(parentPid, firstSysvAddr, 11, size);
    harness.seedSysv(parentPid, secondSysvAddr, 12, size);

    expect(() => {
      harness.worker.inheritProcessSharedMappings(parentPid, childPid);
    }).toThrow(/SysV shared-memory inheritance failed for pid=52: errno 12/);

    expect(harness.sysv.callsTo("kernel_shared_mapping_sysv_inherit")).toEqual([
      {
        name: "kernel_shared_mapping_sysv_inherit",
        args: [parentPid, childPid, BigInt(childMemory.buffer.byteLength)],
      },
    ]);
    // The anonymous half must not have published either: a refused SysV
    // transaction aborts the whole inheritance, not just its own half.
    expect(backing.refCount).toBe(1);
    expect(harness.state.sharedMappings.has(childPid)).toBe(false);
    expect(harness.sysv.count(childPid)).toBe(0);
    expect(new Uint8Array(childMemory.buffer)[anonymousAddr]).toBe(0x77);
    expect(new Uint8Array(childMemory.buffer)[firstSysvAddr]).toBe(0x77);

    // Expected errno rollback leaves the generation reusable.
    await Promise.resolve();
    harness.implementations.kernel_shared_mapping_sysv_inherit = (
      _parentPid: number,
      pid: number,
    ): number => {
      for (const [addr, attachment] of harness.sysv.attachments.get(parentPid)!) {
        harness.sysv.seed(pid, addr, attachment);
      }
      return 0;
    };
    harness.worker.inheritProcessSharedMappings(parentPid, childPid);

    expect(backing.refCount).toBe(2);
    expect(harness.state.sharedMappings.get(childPid)?.size).toBe(1);
    expect(harness.sysv.count(childPid)).toBe(2);
    expect(new Uint8Array(childMemory.buffer)[anonymousAddr]).toBe(0x31);
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
    expect(harness.sysv.count(childPid)).toBe(0);
    expect(new Uint8Array(childMemory.buffer)[firstAddr]).toBe(0x66);
    expect(new Uint8Array(childMemory.buffer)[secondAddr]).toBe(0x66);
  });

  // The host used to re-check here that a parent SysV address above 4 GiB
  // could not be narrowed into the kernel's pointer model. That guard is gone
  // because the case became unconstructible rather than merely unhandled: an
  // attachment enters the mirror only through
  // `kernel_shared_mapping_sysv_track`, whose address parameter IS the
  // kernel's `usize`, and the host's `toKernelPtr` refuses an address it
  // cannot represent before the export is ever called. A wasm32 kernel's
  // mirror therefore cannot hold an address a wasm32 kernel cannot name.
  // The equivalent guard on the shmdt path, which takes an address straight
  // from the guest, is still exercised in `shared-memory-coherence.test.ts`.
});
