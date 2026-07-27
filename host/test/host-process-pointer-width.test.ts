import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const PID = 73;
const MAP_PRIVATE = 0x02;
const MAP_FIXED = 0x10;
const MAP_ANONYMOUS = 0x20;
const FUTEX_WAIT = 0;
const FUTEX_REQUEUE = 3;
const FUTEX_WAKE_OP = 5;

function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
}

function workerHarness(
  pointerWidth: 4 | 8 = 8,
  kernelPointerWidth: 4 | 8 = pointerWidth,
) {
  const memory = sharedMemory();
  const kernelMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
  });
  const completeChannelRaw = vi.fn();
  const completeChannel = vi.fn();
  const relistenChannel = vi.fn();
  const synchronizeSharedMemoryForBoundary = vi.fn();
  const kernelHandle = vi.fn();
  const kernelExports: Record<string, unknown> = {
    kernel_dequeue_signal: () => 0,
    kernel_get_process_exit_signal: () => -1,
    kernel_handle_channel: kernelHandle,
    kernel_set_current_tid: () => 0,
  };
  const worker = createCentralizedKernelWorkerTestDouble();
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    kernelPointerWidth,
    {
      kernelExports,
    },
  );
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
    completeChannelRaw,
    relistenChannel,
    synchronizeSharedMemoryForBoundary,
  });
  const [processChannel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: PID,
      memory,
      channelOffsets: [0],
      pointerWidth,
    });
  return {
    completeChannel,
    completeChannelRaw,
    kernelHandle,
    kernelExports,
    memory,
    processChannel,
    relistenChannel,
    synchronizeSharedMemoryForBoundary,
    worker,
  };
}

function writeSyscall(
  processChannel: {
    readonly memory: WebAssembly.Memory;
    readonly channelOffset: number;
  },
  syscallNr: number,
  args: readonly bigint[],
): void {
  const view = new DataView(
    processChannel.memory.buffer,
    processChannel.channelOffset,
  );
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, syscallNr, true);
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      args[index] ?? 0n,
      true,
    );
  }
}

describe("handwritten host process-pointer width checks", () => {
  it("keeps a lossless wasm64 MAP_FIXED address above 4 GiB out of low memory", () => {
    const h = workerHarness(8);
    const lowAlias = 0x8000;
    const highAddress = 0x1_0000_8000n;
    const processBytes = new Uint8Array(h.memory.buffer);
    processBytes[lowAlias] = 0xa5;
    writeSyscall(h.processChannel, ABI_SYSCALLS.Mmap, [
      highAddress,
      4096n,
      3n,
      BigInt(MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS),
      -1n,
      0n,
    ]);

    h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      h.processChannel,
    );

    expect(h.kernelHandle).not.toHaveBeenCalled();
    expect(h.completeChannel).toHaveBeenCalledWith(
      h.processChannel,
      ABI_SYSCALLS.Mmap,
      [Number(highAddress), 4096, 3, MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0],
      undefined,
      -1,
      12,
    );
    expect(processBytes[lowAlias]).toBe(0xa5);
  });

  it.each([
    {
      name: "wasm32 upper pointer bits",
      pointerWidth: 4 as const,
      address: 0x1_0000_4000n,
      errno: 14,
    },
    {
      name: "wasm64 address above Number.MAX_SAFE_INTEGER",
      pointerWidth: 8 as const,
      address: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      errno: 14,
    },
  ])("rejects $name before synchronization or dispatch", ({
    pointerWidth,
    address,
    errno,
  }) => {
    const h = workerHarness(pointerWidth);
    writeSyscall(h.processChannel, ABI_SYSCALLS.Mmap, [
      address,
      4096n,
      3n,
      BigInt(MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS),
      -1n,
      0n,
    ]);

    h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      h.processChannel,
    );

    expect(h.synchronizeSharedMemoryForBoundary).not.toHaveBeenCalled();
    expect(h.kernelHandle).not.toHaveBeenCalled();
    expect(h.completeChannelRaw).toHaveBeenCalledWith(
      h.processChannel,
      -1,
      errno,
    );
  });

  it("rejects pointer-plus-length overflow before synchronization or dispatch", () => {
    const h = workerHarness(8);
    writeSyscall(h.processChannel, ABI_SYSCALLS.Mmap, [
      BigInt(Number.MAX_SAFE_INTEGER - 1024),
      2048n,
      3n,
      BigInt(MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS),
      -1n,
      0n,
    ]);

    h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      h.processChannel,
    );

    expect(h.synchronizeSharedMemoryForBoundary).not.toHaveBeenCalled();
    expect(h.kernelHandle).not.toHaveBeenCalled();
    expect(h.completeChannelRaw).toHaveBeenCalledWith(
      h.processChannel,
      -1,
      22,
    );
  });

  it("accepts only lossless mmap-style returned addresses for the caller", () => {
    const wasm64 = workerHarness(8);
    const highAddress = 0x1_0000_5000n;
    expect((wasm64.worker as any).normalizeKernelSyscallResult(
      wasm64.processChannel,
      ABI_SYSCALLS.Mmap,
      highAddress,
      0,
    )).toEqual({
      retVal: Number(highAddress),
      publicationRetVal: Number(highAddress),
      errVal: 0,
    });
    expect((wasm64.worker as any).normalizeKernelSyscallResult(
      wasm64.processChannel,
      ABI_SYSCALLS.Mremap,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      0,
    )).toEqual({ retVal: -1, publicationRetVal: -1, errVal: 75 });

    const wasm32 = workerHarness(4);
    expect((wasm32.worker as any).normalizeKernelSyscallResult(
      wasm32.processChannel,
      ABI_SYSCALLS.Brk,
      highAddress,
      0,
    )).toEqual({ retVal: -1, publicationRetVal: -1, errVal: 75 });
  });

  it("does not mistake a high wasm64 host reservation for a low u32 sentinel", () => {
    const h = workerHarness(8);
    const highAddress = 0x1_ffff_ffffn;
    h.kernelExports.kernel_reserve_host_region = vi.fn(() => highAddress);

    expect(h.worker.reserveHostRegion(PID, 4096)).toBe(Number(highAddress));
  });

  it("rejects an invalid dynamic reservation length before entering Wasm", () => {
    const h = workerHarness(8);
    const reserve = vi.fn(() => 0x20_000n);
    h.kernelExports.kernel_reserve_host_region = reserve;

    expect(() => h.worker.reserveHostRegion(PID, -1)).toThrow(
      /failed to reserve -1 bytes/,
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(h.worker.reserveHostRegion(PID, 4096)).toBe(0x20_000);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("losslessly normalizes signed high-bit wasm32 host reservations", () => {
    const h = workerHarness(4);
    const highAddress = 0x8000_5000;
    const signedExportResult = highAddress | 0;
    h.kernelExports.kernel_reserve_host_region =
      vi.fn(() => signedExportResult);
    h.kernelExports.kernel_reserve_host_region_at =
      vi.fn(() => signedExportResult);

    expect(h.worker.reserveHostRegion(PID, 4096)).toBe(highAddress);
    expect(h.worker.reserveHostRegionAt(PID, highAddress, 4096)).toBe(
      highAddress,
    );
  });

  it("uses the kernel width to normalize a wasm32 export for a wasm64 guest", () => {
    const h = workerHarness(8, 4);
    const highAddress = 0x8000_5000;
    const signedExportResult = highAddress | 0;
    const reserve = vi.fn(() => signedExportResult);
    const reserveAt = vi.fn(() => signedExportResult);
    h.kernelExports.kernel_reserve_host_region = reserve;
    h.kernelExports.kernel_reserve_host_region_at = reserveAt;

    expect(h.worker.reserveHostRegion(PID, 4096)).toBe(highAddress);
    expect(h.worker.reserveHostRegionAt(PID, highAddress, 4096)).toBe(
      highAddress,
    );
    expect(reserve).toHaveBeenCalledWith(PID, 4096);
    // The genuine wasm32 boundary presents the same address bits to its
    // JavaScript import as a signed i32; the host normalizes only the export
    // result back into the guest's unsigned logical address.
    expect(reserveAt).toHaveBeenCalledWith(PID, signedExportResult, 4096);
  });

  it("rejects a fixed reservation outside a wasm32 guest before a wasm64 export", () => {
    const h = workerHarness(4, 8);
    const reserveAt = vi.fn(() => 0x1_0000_0000n);
    h.kernelExports.kernel_reserve_host_region_at = reserveAt;

    expect(() =>
      h.worker.reserveHostRegionAt(PID, 0x1_0000_0000, 4096)
    ).toThrow(/failed to reserve pthread control memory/);
    expect(reserveAt).not.toHaveBeenCalled();

    // Caller-domain rejection happens before the entry scope. It must not
    // poison the genuine kernel generation or prevent a later valid request.
    h.kernelExports.kernel_reserve_host_region_at =
      vi.fn(() => 0x20_000n);
    expect(h.worker.reserveHostRegionAt(PID, 0x20_000, 4096)).toBe(0x20_000);
  });

  it("rejects a returned reservation whose end exceeds the wasm32 guest domain", () => {
    const h = workerHarness(4, 8);
    h.kernelExports.kernel_reserve_host_region =
      vi.fn(() => 0xffff_f000n);

    let failure: unknown;
    try {
      h.worker.reserveHostRegion(PID, 8192);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /void kernel ingress dynamic host-region reservation/,
    );
    expect((failure as Error & { cause?: unknown }).cause).toMatchObject({
      message: expect.stringMatching(/failed to reserve 8192 bytes/),
    });
  });

  it("accepts a wasm32 reservation whose exclusive end is exactly 4 GiB", () => {
    const h = workerHarness(4, 8);
    h.kernelExports.kernel_reserve_host_region =
      vi.fn(() => 0xffff_0000n);

    expect(h.worker.reserveHostRegion(PID, 0x1_0000)).toBe(0xffff_0000);
  });

  it("does not treat a kernel64 0xffffffff address as the wasm32 failure sentinel", () => {
    const h = workerHarness(8, 8);
    h.kernelExports.kernel_reserve_host_region =
      vi.fn(() => 0xffff_ffffn);

    expect(h.worker.reserveHostRegion(PID, 1)).toBe(0xffff_ffff);
  });

  it("rejects a high wasm64 futex uaddr2 before it can wake a low alias", () => {
    const h = workerHarness(8);
    const primary = 0x1000;
    const highSecond = 0x1_0000_2000n;
    const notify = vi.spyOn(Atomics, "notify");
    try {
      writeSyscall(h.processChannel, ABI_SYSCALLS.Futex, [
        BigInt(primary),
        BigInt(FUTEX_WAKE_OP),
        1n,
        1n,
        highSecond,
        0n,
      ]);
      h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
        h.processChannel,
      );

      expect(notify).not.toHaveBeenCalled();
      expect(h.completeChannelRaw).toHaveBeenCalledWith(
        h.processChannel,
        -1,
        14,
      );
    } finally {
      notify.mockRestore();
    }
  });

  it("treats futex timeout and uaddr2 slots according to the operation", () => {
    const h = workerHarness(8);
    const primary = 0x1000;
    const second = 0x2000;
    const truncatedTimeout = h.memory.buffer.byteLength - 8;

    writeSyscall(h.processChannel, ABI_SYSCALLS.Futex, [
      BigInt(primary),
      BigInt(FUTEX_WAIT),
      1n,
      BigInt(truncatedTimeout),
      0n,
      0n,
    ]);
    h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      h.processChannel,
    );
    expect(h.completeChannelRaw).toHaveBeenLastCalledWith(
      h.processChannel,
      -1,
      14,
    );

    h.completeChannelRaw.mockClear();
    writeSyscall(h.processChannel, ABI_SYSCALLS.Futex, [
      BigInt(primary),
      BigInt(FUTEX_REQUEUE),
      1n,
      -1n,
      BigInt(second),
      0n,
    ]);
    h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      h.processChannel,
    );
    expect(h.completeChannelRaw).toHaveBeenCalledWith(
      h.processChannel,
      expect.any(Number),
      0,
    );
  });

  it.each([
    [-1n, 0n],
    [0n, -1n],
    [0n, 1_000_000_000n],
  ])(
    "rejects a non-normalized futex timeout (%s, %s) before waiting",
    (seconds, nanoseconds) => {
      const h = workerHarness(8);
      const primary = 0x1000;
      const timeout = 0x2000;
      const view = new DataView(h.memory.buffer);
      view.setInt32(primary, 0, true);
      view.setBigInt64(timeout, seconds, true);
      view.setBigInt64(timeout + 8, nanoseconds, true);
      const waitAsync = vi.spyOn(Atomics, "waitAsync").mockReturnValue({
        async: false,
        value: "not-equal",
      });
      try {
        writeSyscall(h.processChannel, ABI_SYSCALLS.Futex, [
          BigInt(primary),
          BigInt(FUTEX_WAIT),
          0n,
          BigInt(timeout),
          0n,
          0n,
        ]);
        h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
          h.processChannel,
        );

        expect(waitAsync).not.toHaveBeenCalled();
        expect(h.completeChannelRaw).toHaveBeenCalledWith(
          h.processChannel,
          -1,
          22,
        );
      } finally {
        waitAsync.mockRestore();
      }
    },
  );

  it("rejects a futex word that crosses the current memory boundary", () => {
    const h = workerHarness(8);
    const crossingWord = h.memory.buffer.byteLength - 2;
    writeSyscall(h.processChannel, ABI_SYSCALLS.Futex, [
      BigInt(crossingWord),
      BigInt(FUTEX_WAIT),
      0n,
      0n,
      0n,
      0n,
    ]);
    h.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      h.processChannel,
    );
    expect(h.completeChannelRaw).toHaveBeenCalledWith(
      h.processChannel,
      -1,
      14,
    );
  });
});
