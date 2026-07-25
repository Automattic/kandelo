import { CAPTURED_STDIO, CentralizedKernelWorker } from "../../../../host/src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
} from "../../../../host/src/generated/abi";
import {
  computeProcessMemoryLayout,
  createProcessMemory,
  type ProcessMemoryLayout,
} from "../../../../host/src/process-memory";
import type { KernelScratchRegion } from "../../../../host/src/kernel-scratch";
import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";
import { BrowserTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";

const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const F_SETLK64 = 13;
const F_SETLKW64 = 14;
const F_WRLCK = 1;
const F_UNLCK = 2;
const EAGAIN = 11;
const ENOLCK = 37;
const MAX_LOCK_RECORDS = 4096;
const FLOCK_PTR = 0x4000;

interface RegisteredProcess {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  layout: ProcessMemoryLayout;
}

interface SyscallResult {
  value: number;
  errno: number;
}

interface ScratchArgument {
  kind: "scratch";
  offset: number;
  length: number;
}

type SyscallArgument = number | bigint | ScratchArgument;

type ScratchPreparation =
  | {
      kind: "copy";
      source: Uint8Array;
      destinationOffset: number;
    }
  | {
      kind: "flock";
      start: bigint;
      len: bigint;
      type: number;
    };

function scratchArgument(offset: number, length: number): ScratchArgument {
  return { kind: "scratch", offset, length };
}

interface ChannelInfoForTest {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
}

interface KernelWorkerInternals {
  scratchRegion: KernelScratchRegion;
  kernelInstance: WebAssembly.Instance;
  processes: Map<number, { channels: ChannelInfoForTest[] }>;
  pendingAdvisoryLockRetries: Map<ChannelInfoForTest, unknown>;
  handleFcntlLock(channel: ChannelInfoForTest, args: number[]): void;
  drainAndProcessWakeupEvents(): void;
}

interface FixtureRequest {
  buffer: SharedArrayBuffer;
  kernelWasm: ArrayBuffer;
  identityPath: string;
  capacityPath: string;
}

function internals(worker: CentralizedKernelWorker): KernelWorkerInternals {
  return worker as unknown as KernelWorkerInternals;
}

function makeProcessMemory(): Omit<RegisteredProcess, "pid"> {
  const layout = computeProcessMemoryLayout({
    ptrWidth: 4,
    heapBase: 0x0012_0000,
    minPages: 18,
    maxPages: 1024,
  });
  const memory = createProcessMemory(4, layout);
  const channelOffset = layout.channelOffset;
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
  return { memory, channelOffset, layout };
}

function register(
  worker: CentralizedKernelWorker,
): RegisteredProcess {
  const process = makeProcessMemory();
  const pid = worker.createProcess(CAPTURED_STDIO);
  worker.registerProcess(pid, process.memory, [process.channelOffset], {
    brkBase: process.layout.brkBase,
    mmapBase: process.layout.mmapBase,
    maxAddr: process.layout.maxAddr,
  });
  return { ...process, pid };
}

function issue(
  worker: CentralizedKernelWorker,
  pid: number,
  syscall: number,
  args: readonly SyscallArgument[],
  preparation?: ScratchPreparation,
): SyscallResult {
  const state = internals(worker);
  return state.scratchRegion.withLease((scratch) => {
    // WHY: preparation is data, not a callback receiving the lease. Keeping
    // every scratch operation in this synchronous callback prevents a helper
    // from retaining the lease after withLease revokes it.
    if (preparation?.kind === "copy") {
      scratch.copyFrom(
        preparation.source,
        preparation.destinationOffset,
      );
    } else if (preparation?.kind === "flock") {
      scratch.fill(0, CH_DATA, 32);
      const flock = scratch.dataView(CH_DATA, 32);
      flock.setInt16(0, preparation.type, true);
      flock.setInt16(2, 0, true); // SEEK_SET
      flock.setBigInt64(8, preparation.start, true);
      flock.setBigInt64(16, preparation.len, true);
    }
    const channel = scratch.dataView(0, CH_TOTAL_SIZE);
    channel.setUint32(CH_SYSCALL, syscall, true);
    channel.setUint32(CH_ERRNO, 0, true);
    channel.setBigInt64(CH_RETURN, 0n, true);
    for (let index = 0; index < 6; index++) {
      const argument = args[index] ?? 0;
      if (typeof argument === "object") {
        // WHY: the descriptor carries only an offset and capacity. The
        // lease writes its checked address without exposing a primitive that
        // could outlive revocation.
        scratch.writeAddress(
          CH_ARGS + index * CH_ARG_SIZE,
          argument.offset,
          argument.length,
          "u64-le",
        );
      } else {
        channel.setBigInt64(
          CH_ARGS + index * CH_ARG_SIZE,
          BigInt(argument),
          true,
        );
      }
    }

    const setCurrentTid = state.kernelInstance.exports.kernel_set_current_tid as (
      pid: number,
      tid: number,
    ) => number;
    const bindResult = setCurrentTid(pid, pid);
    if (bindResult !== 0) {
      throw new Error(`kernel_set_current_tid(${pid}, ${pid}) failed: ${bindResult}`);
    }
    scratch.invokeKernelExport("kernel_handle_channel", [
      scratch.exportPointer(0, CH_TOTAL_SIZE),
      CH_TOTAL_SIZE,
      pid,
    ]);
    return {
      value: Number(channel.getBigInt64(CH_RETURN, true)),
      errno: channel.getUint32(CH_ERRNO, true),
    };
  });
}

function openFile(
  worker: CentralizedKernelWorker,
  pid: number,
  path: string,
): number {
  const pathBytes = new TextEncoder().encode(`${path}\0`);
  const result = issue(
    worker,
    pid,
    ABI_SYSCALLS.Open,
    [
      scratchArgument(CH_DATA, pathBytes.byteLength),
      O_RDWR,
      0,
    ],
    {
      kind: "copy",
      source: pathBytes,
      destinationOffset: CH_DATA,
    },
  );
  if (result.errno !== 0 || result.value < 3) {
    throw new Error(
      `kernel open failed for pid ${pid}: value=${result.value} errno=${result.errno}`,
    );
  }
  return result.value;
}

function closeFile(
  worker: CentralizedKernelWorker,
  pid: number,
  fd: number,
): void {
  const result = issue(worker, pid, ABI_SYSCALLS.Close, [fd]);
  if (result.value !== 0 || result.errno !== 0) {
    throw new Error(
      `kernel close failed for pid ${pid}: value=${result.value} errno=${result.errno}`,
    );
  }
}

function writeFlock(
  memory: WebAssembly.Memory,
  start: bigint,
  len: bigint,
  type: number,
  ptr = FLOCK_PTR,
): void {
  new Uint8Array(memory.buffer, ptr, 32).fill(0);
  const flock = new DataView(memory.buffer, ptr, 32);
  flock.setInt16(0, type, true);
  flock.setInt16(2, 0, true); // SEEK_SET
  flock.setBigInt64(8, start, true);
  flock.setBigInt64(16, len, true);
}

function lock(
  worker: CentralizedKernelWorker,
  pid: number,
  fd: number,
  start: bigint,
  len: bigint,
  type = F_WRLCK,
  command = F_SETLK64,
): SyscallResult {
  return issue(
    worker,
    pid,
    ABI_SYSCALLS.Fcntl,
    [
      fd,
      command,
      scratchArgument(CH_DATA, 32),
    ],
    {
      kind: "flock",
      start,
      len,
      type,
    },
  );
}

function prepareProcessFcntl(
  process: RegisteredProcess,
  fd: number,
  command: number,
  start: bigint,
  len: bigint,
  type: number,
): number[] {
  writeFlock(process.memory, start, len, type);
  const args = [fd, command, FLOCK_PTR, 0, 0, 0];
  const channel = new DataView(process.memory.buffer, process.channelOffset);
  channel.setUint32(CH_SYSCALL, ABI_SYSCALLS.Fcntl, true);
  channel.setUint32(CH_ERRNO, 0, true);
  channel.setBigInt64(CH_RETURN, 0n, true);
  for (let index = 0; index < args.length; index++) {
    channel.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index]),
      true,
    );
  }
  return args;
}

function processChannelResult(process: RegisteredProcess): SyscallResult & {
  status: number;
} {
  const channel = new DataView(process.memory.buffer, process.channelOffset);
  return {
    value: Number(channel.getBigInt64(CH_RETURN, true)),
    errno: channel.getUint32(CH_ERRNO, true),
    status: channel.getUint32(CH_STATUS, true),
  };
}

function createEmptyFile(fs: OpfsFileSystem, path: string): void {
  const fd = fs.open(path, O_CREAT | O_TRUNC | O_RDWR, 0o600);
  fs.close(fd);
}

self.onmessage = async (event: MessageEvent<FixtureRequest>) => {
  const { buffer, kernelWasm, identityPath, capacityPath } = event.data;
  const renamedIdentityPath = `${identityPath}-renamed`;
  const opfs = OpfsFileSystem.create(buffer);
  let worker: CentralizedKernelWorker | null = null;
  const pids: number[] = [];
  let response: Record<string, unknown> | null = null;

  try {
    createEmptyFile(opfs, identityPath);
    createEmptyFile(opfs, capacityPath);

    worker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65_536, useSharedMemory: true },
      new VirtualPlatformIO(
        [{ mountPoint: "/", backend: opfs }],
        new BrowserTimeProvider(),
      ),
    );
    await worker.init(kernelWasm);

    pids.push(register(worker).pid);
    const peer = register(worker);
    pids.push(peer.pid);
    const capacityOwner = register(worker);
    pids.push(capacityOwner.pid);
    pids.push(register(worker).pid);

    const ownerFd = openFile(worker, pids[0], identityPath);
    const peerFd = openFile(worker, pids[1], identityPath);
    const independentOpenAcquired = lock(
      worker,
      pids[0],
      ownerFd,
      0n,
      1n,
    );
    const independentOpenConflict = lock(
      worker,
      pids[1],
      peerFd,
      0n,
      1n,
    );

    opfs.rename(identityPath, renamedIdentityPath);
    opfs.unlink(renamedIdentityPath);
    const renamedAndUnlinkedOpenConflict = lock(
      worker,
      pids[1],
      peerFd,
      0n,
      1n,
    );

    createEmptyFile(opfs, identityPath);
    const recreatedFd = openFile(worker, pids[2], identityPath);
    const recreatedPathIsolated = lock(
      worker,
      pids[2],
      recreatedFd,
      0n,
      1n,
    );
    closeFile(worker, pids[2], recreatedFd);

    const state = internals(worker);
    const peerChannel = state.processes.get(pids[1])?.channels[0];
    if (!peerChannel) throw new Error("peer kernel channel is not registered");
    const blockingArgs = prepareProcessFcntl(
      peer,
      peerFd,
      F_SETLKW64,
      0n,
      1n,
      F_WRLCK,
    );
    state.handleFcntlLock(peerChannel, blockingArgs);
    const blockingParkedBeforeUnlock =
      state.pendingAdvisoryLockRetries.has(peerChannel);

    const unlockResult = lock(worker, pids[0], ownerFd, 0n, 1n, F_UNLCK);
    // Direct kernel calls do not run the host's ordinary syscall-completion
    // hook, so explicitly consume the same generic wake stream here.
    state.drainAndProcessWakeupEvents();
    const wakeResult = processChannelResult(peer);
    const blockingWokeAfterUnlock =
      !state.pendingAdvisoryLockRetries.has(peerChannel) &&
      wakeResult.status === CHANNEL_STATUS_COMPLETE &&
      wakeResult.value === 0 &&
      wakeResult.errno === 0;

    closeFile(worker, pids[0], ownerFd);
    closeFile(worker, pids[1], peerFd);

    const capacityFd = openFile(worker, pids[2], capacityPath);
    const capacityPeerFd = openFile(worker, pids[3], capacityPath);
    let capacityInserted = 0;
    for (let index = 0; index < MAX_LOCK_RECORDS; index++) {
      const result = lock(
        worker,
        pids[2],
        capacityFd,
        BigInt(index * 2),
        1n,
      );
      if (result.value !== 0 || result.errno !== 0) {
        throw new Error(
          `capacity lock ${index} failed: value=${result.value} errno=${result.errno}`,
        );
      }
      capacityInserted++;
    }

    const capacityConflict = lock(
      worker,
      pids[3],
      capacityPeerFd,
      0n,
      1n,
    );

    const capacityChannel = state.processes.get(pids[2])?.channels[0];
    if (!capacityChannel) {
      throw new Error("capacity-owner kernel channel is not registered");
    }
    const exhaustionArgs = prepareProcessFcntl(
      capacityOwner,
      capacityFd,
      F_SETLKW64,
      BigInt(MAX_LOCK_RECORDS * 2),
      1n,
      F_WRLCK,
    );
    state.handleFcntlLock(capacityChannel, exhaustionArgs);
    const exhaustion = processChannelResult(capacityOwner);
    const exhaustionWasNotParked =
      !state.pendingAdvisoryLockRetries.has(capacityChannel);

    closeFile(worker, pids[2], capacityFd);
    closeFile(worker, pids[3], capacityPeerFd);

    response = {
      type: "result",
      independentOpenAcquired,
      independentOpenConflict,
      renamedAndUnlinkedOpenConflict,
      recreatedPathIsolated,
      blockingParkedBeforeUnlock,
      unlockResult,
      blockingWokeAfterUnlock,
      wakeResult,
      capacityInserted,
      capacityConflict,
      exhaustion,
      exhaustionWasNotParked,
      expectedErrnos: { EAGAIN, ENOLCK },
    };
  } catch (error) {
    response = {
      type: "error",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  } finally {
    const cleanupErrors: string[] = [];
    if (worker) {
      for (const pid of pids) {
        try {
          worker.unregisterProcess(pid);
        } catch (error) {
          cleanupErrors.push(
            `unregister pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    for (const path of [identityPath, renamedIdentityPath, capacityPath]) {
      try {
        opfs.unlink(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // ENOENT is expected if setup failed before creating this path.
        if (message !== "ENOENT") {
          cleanupErrors.push(`unlink ${path}: ${message}`);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupMessage = `fixture cleanup failed: ${cleanupErrors.join("; ")}`;
      response = response?.type === "error"
        ? { ...response, error: `${String(response.error)}\n${cleanupMessage}` }
        : { type: "error", error: cleanupMessage };
    }
    self.postMessage(response ?? {
      type: "error",
      error: "fixture exited without producing a result",
    });
    self.close();
  }
};
