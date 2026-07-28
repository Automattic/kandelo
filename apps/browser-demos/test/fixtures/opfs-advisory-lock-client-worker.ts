import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  createCentralizedKernelWorkerTestDouble,
} from "../../../../host/src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
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

interface FixtureRequest {
  buffer: SharedArrayBuffer;
  kernelWasm: ArrayBuffer;
  identityPath: string;
  capacityPath: string;
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

function prepareIssue(
  process: RegisteredProcess,
  syscall: number,
  args: readonly SyscallArgument[],
  preparation?: ScratchPreparation,
): void {
  const channel = new DataView(
    process.memory.buffer,
    process.channelOffset,
    CH_TOTAL_SIZE,
  );
  if (preparation?.kind === "copy") {
    new Uint8Array(
      process.memory.buffer,
      process.channelOffset + preparation.destinationOffset,
      preparation.source.byteLength,
    ).set(preparation.source);
  } else if (preparation?.kind === "flock") {
    new Uint8Array(
      process.memory.buffer,
      process.channelOffset + CH_DATA,
      32,
    ).fill(0);
    const flock = new DataView(
      process.memory.buffer,
      process.channelOffset + CH_DATA,
      32,
    );
    flock.setInt16(0, preparation.type, true);
    flock.setInt16(2, 0, true); // SEEK_SET
    flock.setBigInt64(8, preparation.start, true);
    flock.setBigInt64(16, preparation.len, true);
  }
  channel.setUint32(CH_SYSCALL, syscall, true);
  channel.setUint32(CH_ERRNO, 0, true);
  channel.setBigInt64(CH_RETURN, 0n, true);
  for (let index = 0; index < 6; index++) {
    const argument = args[index] ?? 0;
    if (typeof argument === "object") {
      if (
        !Number.isSafeInteger(argument.offset)
        || !Number.isSafeInteger(argument.length)
        || argument.offset < 0
        || argument.length < 0
        || argument.offset + argument.length > CH_TOTAL_SIZE
      ) {
        throw new RangeError("fixture channel pointer is out of range");
      }
      channel.setBigUint64(
        CH_ARGS + index * CH_ARG_SIZE,
        BigInt(process.channelOffset + argument.offset),
        true,
      );
    } else {
      channel.setBigInt64(
        CH_ARGS + index * CH_ARG_SIZE,
        BigInt(argument),
        true,
      );
    }
  }
}

function submitPreparedIssue(process: RegisteredProcess): void {
  const words = new Int32Array(process.memory.buffer);
  const statusIndex =
    (process.channelOffset + CH_STATUS) / Int32Array.BYTES_PER_ELEMENT;
  Atomics.store(words, statusIndex, CHANNEL_STATUS_PENDING);
  Atomics.notify(words, statusIndex, 1);
}

async function waitForIssueCompletion(
  process: RegisteredProcess,
  timeoutMs = 10_000,
): Promise<SyscallResult & { status: number }> {
  const words = new Int32Array(process.memory.buffer);
  const statusIndex =
    (process.channelOffset + CH_STATUS) / Int32Array.BYTES_PER_ELEMENT;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Atomics.load(words, statusIndex) === CHANNEL_STATUS_COMPLETE) {
      // The worker schedules its next wait after publishing completion. Yield
      // once more so a following fixture syscall cannot outrun that relisten.
      await Promise.resolve();
      return processChannelResult(process);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `kernel syscall for pid ${process.pid} did not complete within ${timeoutMs}ms`,
      );
    }
    await Promise.resolve();
    if (Atomics.load(words, statusIndex) !== CHANNEL_STATUS_COMPLETE) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function issue(
  process: RegisteredProcess,
  syscall: number,
  args: readonly SyscallArgument[],
  preparation?: ScratchPreparation,
): Promise<SyscallResult> {
  // Exercise the registered guest mailbox. Kernel scratch, its lease, and all
  // export authority remain encapsulated by CentralizedKernelWorker.
  prepareIssue(process, syscall, args, preparation);
  submitPreparedIssue(process);
  return waitForIssueCompletion(process);
}

async function openFile(
  process: RegisteredProcess,
  path: string,
): Promise<number> {
  const pathBytes = new TextEncoder().encode(`${path}\0`);
  const result = await issue(
    process,
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
      `kernel open failed for pid ${process.pid}: value=${result.value} errno=${result.errno}`,
    );
  }
  return result.value;
}

async function closeFile(
  process: RegisteredProcess,
  fd: number,
): Promise<void> {
  const result = await issue(process, ABI_SYSCALLS.Close, [fd]);
  if (result.value !== 0 || result.errno !== 0) {
    throw new Error(
      `kernel close failed for pid ${process.pid}: value=${result.value} errno=${result.errno}`,
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
  process: RegisteredProcess,
  fd: number,
  start: bigint,
  len: bigint,
  type = F_WRLCK,
  command = F_SETLK64,
): Promise<SyscallResult> {
  return issue(
    process,
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
  const registrations: RegisteredProcess[] = [];
  let response: Record<string, unknown> | null = null;

  try {
    createEmptyFile(opfs, identityPath);
    createEmptyFile(opfs, capacityPath);

    worker = createCentralizedKernelWorkerTestDouble({
      config: {
        maxWorkers: 4,
        dataBufferSize: 65_536,
        useSharedMemory: true,
      },
      io: new VirtualPlatformIO(
        [{ mountPoint: "/", backend: opfs }],
        new BrowserTimeProvider(),
      ),
    });
    await worker.init(kernelWasm);

    const owner = register(worker);
    registrations.push(owner);
    const peer = register(worker);
    registrations.push(peer);
    const capacityOwner = register(worker);
    registrations.push(capacityOwner);
    const capacityPeer = register(worker);
    registrations.push(capacityPeer);

    const ownerFd = await openFile(owner, identityPath);
    const peerFd = await openFile(peer, identityPath);
    const independentOpenAcquired = await lock(
      owner,
      ownerFd,
      0n,
      1n,
    );
    const independentOpenConflict = await lock(
      peer,
      peerFd,
      0n,
      1n,
    );

    opfs.rename(identityPath, renamedIdentityPath);
    opfs.unlink(renamedIdentityPath);
    const renamedAndUnlinkedOpenConflict = await lock(
      peer,
      peerFd,
      0n,
      1n,
    );

    createEmptyFile(opfs, identityPath);
    const recreatedFd = await openFile(capacityOwner, identityPath);
    const recreatedPathIsolated = await lock(
      capacityOwner,
      recreatedFd,
      0n,
      1n,
    );
    await closeFile(capacityOwner, recreatedFd);

    prepareProcessFcntl(
      peer,
      peerFd,
      F_SETLKW64,
      0n,
      1n,
      F_WRLCK,
    );
    submitPreparedIssue(peer);
    // Let the genuine channel listener park F_SETLKW before the owner unlocks.
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const blockingParkedBeforeUnlock =
      processChannelResult(peer).status === CHANNEL_STATUS_PENDING;

    const unlockResult = await lock(owner, ownerFd, 0n, 1n, F_UNLCK);
    const wakeResult = await waitForIssueCompletion(peer);
    const blockingWokeAfterUnlock =
      wakeResult.status === CHANNEL_STATUS_COMPLETE &&
      wakeResult.value === 0 &&
      wakeResult.errno === 0;

    await closeFile(owner, ownerFd);
    await closeFile(peer, peerFd);

    const capacityFd = await openFile(capacityOwner, capacityPath);
    const capacityPeerFd = await openFile(capacityPeer, capacityPath);
    let capacityInserted = 0;
    for (let index = 0; index < MAX_LOCK_RECORDS; index++) {
      const result = await lock(
        capacityOwner,
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

    const capacityConflict = await lock(
      capacityPeer,
      capacityPeerFd,
      0n,
      1n,
    );

    prepareProcessFcntl(
      capacityOwner,
      capacityFd,
      F_SETLKW64,
      BigInt(MAX_LOCK_RECORDS * 2),
      1n,
      F_WRLCK,
    );
    submitPreparedIssue(capacityOwner);
    const exhaustion = await waitForIssueCompletion(capacityOwner);
    const exhaustionWasNotParked =
      exhaustion.status === CHANNEL_STATUS_COMPLETE;

    await closeFile(capacityOwner, capacityFd);
    await closeFile(capacityPeer, capacityPeerFd);

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
      for (const { pid } of registrations) {
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
