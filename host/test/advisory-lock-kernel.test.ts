import { describe, expect, it } from "vitest";
import {
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { resolveBinary } from "../src/binary-resolver";
import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
} from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import type { PlatformIO } from "../src/types";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import {
  computeProcessMemoryLayout,
  createProcessMemory,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { CH_TOTAL_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
} from "../src/generated/abi";

const O_RDWR = 2;
const O_CREAT = 0o100;
const F_SETLK64 = 13;
const F_SETLKW64 = 14;
const F_OFD_SETLK = 37;
const F_RDLCK = 0;
const F_WRLCK = 1;
const F_UNLCK = 2;
const EAGAIN = 11;
const ENOLCK = 37;
const MAX_LOCK_RECORDS = 4096;

interface ProcessMemory {
  memory: WebAssembly.Memory;
  channelOffset: number;
  layout: ProcessMemoryLayout;
}

interface SyscallResult {
  value: number;
  errno: number;
}

function loadKernelWasm(): ArrayBuffer {
  const bytes = readFileSync(resolveBinary("kernel.wasm"));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function makeProcessMemory(): ProcessMemory {
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
  pid: number,
): ProcessMemory {
  const entry = makeProcessMemory();
  worker.registerProcess(pid, entry.memory, [entry.channelOffset], {
    brkBase: entry.layout.brkBase,
    mmapBase: entry.layout.mmapBase,
    maxAddr: entry.layout.maxAddr,
    stdio: CAPTURED_STDIO,
  });
  return entry;
}

function issue(
  worker: CentralizedKernelWorker,
  pid: number,
  syscall: number,
  args: Array<number | bigint>,
): SyscallResult {
  const kernelMemory = (worker as any).kernelMemory as WebAssembly.Memory;
  const scratchOffset = (worker as any).scratchOffset as number;
  const channel = new DataView(kernelMemory.buffer, scratchOffset);
  channel.setUint32(CH_SYSCALL, syscall, true);
  channel.setUint32(CH_ERRNO, 0, true);
  channel.setBigInt64(CH_RETURN, 0n, true);
  for (let index = 0; index < 6; index++) {
    channel.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }

  const handleChannel = (worker as any).kernelInstance.exports
    .kernel_handle_channel as (offset: number | bigint, pid: number) => number;
  handleChannel(worker.toKernelPtr(scratchOffset), pid);
  return {
    value: Number(channel.getBigInt64(CH_RETURN, true)),
    errno: channel.getUint32(CH_ERRNO, true),
  };
}

function openFile(
  worker: CentralizedKernelWorker,
  pid: number,
  path: string,
): number {
  const kernelMemory = (worker as any).kernelMemory as WebAssembly.Memory;
  const scratchOffset = (worker as any).scratchOffset as number;
  const pathPtr = scratchOffset + CH_DATA;
  const encoded = new TextEncoder().encode(`${path}\0`);
  new Uint8Array(kernelMemory.buffer).set(encoded, pathPtr);
  const result = issue(worker, pid, ABI_SYSCALLS.Open, [pathPtr, O_RDWR, 0]);
  expect(result.errno).toBe(0);
  expect(result.value).toBeGreaterThanOrEqual(3);
  return result.value;
}

function closeFile(
  worker: CentralizedKernelWorker,
  pid: number,
  fd: number,
): void {
  expect(issue(worker, pid, ABI_SYSCALLS.Close, [fd])).toEqual({
    value: 0,
    errno: 0,
  });
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
  const kernelMemory = (worker as any).kernelMemory as WebAssembly.Memory;
  const scratchOffset = (worker as any).scratchOffset as number;
  const flockPtr = scratchOffset + CH_DATA;
  const flock = new DataView(kernelMemory.buffer, flockPtr, 32);
  new Uint8Array(kernelMemory.buffer, flockPtr, 32).fill(0);
  flock.setInt16(0, type, true);
  flock.setInt16(2, 0, true); // SEEK_SET
  flock.setBigInt64(8, start, true);
  flock.setBigInt64(16, len, true);
  // l_pid remains zero, as required for F_OFD_* commands.
  return issue(worker, pid, ABI_SYSCALLS.Fcntl, [fd, command, flockPtr]);
}

async function makeWorker(
  platform: PlatformIO = new NodePlatformIO(),
): Promise<CentralizedKernelWorker> {
  const worker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65_536, useSharedMemory: true },
    platform,
  );
  await worker.init(loadKernelWasm());
  return worker;
}

describe("Rust advisory locks through the real kernel Wasm", () => {
  it("qualifies file identity by backend object, not mount path", async () => {
    const root = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const first = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const second = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    for (const backend of [first, second]) {
      const handle = backend.open("/file", O_CREAT | O_RDWR, 0o600);
      backend.close(handle);
    }
    // Both independent backends allocate the same first regular-file inode.
    expect(first.stat("/file").ino).toBe(second.stat("/file").ino);

    const platform = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/first", backend: first },
        { mountPoint: "/second", backend: second },
        { mountPoint: "/first-alias", backend: first },
      ],
      new NodeTimeProvider(),
    );
    const worker = await makeWorker(platform);
    const firstPid = 690;
    const secondPid = 691;
    const aliasPid = 692;
    register(worker, firstPid);
    register(worker, secondPid);
    register(worker, aliasPid);

    try {
      const firstFd = openFile(worker, firstPid, "/first/file");
      const secondFd = openFile(worker, secondPid, "/second/file");
      const aliasFd = openFile(worker, aliasPid, "/first-alias/file");

      expect(lock(worker, firstPid, firstFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });
      // Equal backend-local inode values from distinct backend objects do not
      // alias after VirtualPlatformIO qualifies their device namespaces.
      expect(lock(worker, secondPid, secondFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });
      // Two mount points of the same backend still name the same file object.
      expect(lock(worker, aliasPid, aliasFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      closeFile(worker, firstPid, firstFd);
      closeFile(worker, secondPid, secondFd);
      closeFile(worker, aliasPid, aliasFd);
    } finally {
      worker.unregisterProcess(firstPid);
      worker.unregisterProcess(secondPid);
      worker.unregisterProcess(aliasPid);
    }
  });

  it("uses live file identity across aliases, rename, unlink, and recreate", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-advisory-identity-"));
    const original = join(root, "database");
    const alias = join(root, "database-link");
    const renamed = join(root, "database-renamed");
    writeFileSync(original, "old");
    linkSync(original, alias);

    const worker = await makeWorker();
    const ownerPid = 700;
    const peerPid = 701;
    const recreatedPid = 702;
    register(worker, ownerPid);
    register(worker, peerPid);
    register(worker, recreatedPid);

    try {
      const ownerFd = openFile(worker, ownerPid, original);
      // This independent descriptor is deliberately the one closed below:
      // POSIX requires closing any descriptor for the file to drop all of the
      // process's locks, not only the descriptor used to set the lock.
      const ownerAliasFd = openFile(worker, ownerPid, alias);
      const peerFd = openFile(worker, peerPid, alias);

      expect(lock(worker, ownerPid, ownerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      renameSync(original, renamed);
      unlinkSync(alias);
      unlinkSync(renamed);
      // Both live handles still identify the unlinked object.
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      writeFileSync(original, "new");
      const recreatedFd = openFile(worker, recreatedPid, original);
      // A recreated pathname is a different object even while the old inode
      // remains open and locked.
      expect(lock(worker, recreatedPid, recreatedFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, ownerPid, ownerAliasFd);
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      // Forced process removal is the process-worker crash path.
      worker.unregisterProcess(peerPid);
      expect(lock(worker, ownerPid, ownerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, ownerPid, ownerFd);
      closeFile(worker, recreatedPid, recreatedFd);
    } finally {
      worker.unregisterProcess(ownerPid);
      worker.unregisterProcess(peerPid);
      worker.unregisterProcess(recreatedPid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inherit POSIX process locks across fork", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-advisory-process-fork-"));
    const path = join(root, "file");
    writeFileSync(path, "data");
    const worker = await makeWorker();
    const parentPid = 705;
    const childPid = 706;
    const peerPid = 707;
    register(worker, parentPid);
    register(worker, peerPid);

    try {
      const parentFd = openFile(worker, parentPid, path);
      const peerFd = openFile(worker, peerPid, path);
      expect(lock(worker, parentPid, parentFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      const forkProcess = (worker as any).kernelInstance.exports
        .kernel_fork_process as (parent: number, child: number) => number;
      expect(forkProcess(parentPid, childPid)).toBe(0);
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      // Only the parent owns the POSIX record. Closing its descriptor removes
      // the record; the child inherited the fd, but not the process lock.
      closeFile(worker, parentPid, parentFd);
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, childPid, parentFd);
      closeFile(worker, peerPid, peerFd);
      const removeProcess = (worker as any).kernelInstance.exports
        .kernel_remove_process as (pid: number) => number;
      expect(removeProcess(childPid)).toBe(0);
    } finally {
      worker.unregisterProcess(parentPid);
      worker.unregisterProcess(peerPid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps OFD locks through dup and fork until the last machine reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-advisory-ofd-"));
    const path = join(root, "file");
    writeFileSync(path, "data");
    const worker = await makeWorker();
    const ownerPid = 710;
    const childPid = 711;
    const peerPid = 712;
    register(worker, ownerPid);
    register(worker, peerPid);

    try {
      const ownerFd = openFile(worker, ownerPid, path);
      const duplicate = issue(worker, ownerPid, ABI_SYSCALLS.Dup, [ownerFd]);
      expect(duplicate.errno).toBe(0);
      const peerFd = openFile(worker, peerPid, path);

      expect(lock(worker, ownerPid, ownerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: 0, errno: 0 });
      expect(lock(worker, peerPid, peerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: -1, errno: EAGAIN });

      const forkProcess = (worker as any).kernelInstance.exports
        .kernel_fork_process as (parent: number, child: number) => number;
      expect(forkProcess(ownerPid, childPid)).toBe(0);

      closeFile(worker, ownerPid, ownerFd);
      closeFile(worker, ownerPid, duplicate.value);
      // The child inherited the same OfdId, so the lock is still live.
      expect(lock(worker, peerPid, peerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: -1, errno: EAGAIN });

      closeFile(worker, childPid, ownerFd);
      closeFile(worker, childPid, duplicate.value);
      expect(lock(worker, peerPid, peerFd, 0n, 1n, F_WRLCK, F_OFD_SETLK))
        .toEqual({ value: 0, errno: 0 });

      closeFile(worker, peerPid, peerFd);
      const removeProcess = (worker as any).kernelInstance.exports
        .kernel_remove_process as (pid: number) => number;
      expect(removeProcess(childPid)).toBe(0);
    } finally {
      worker.unregisterProcess(ownerPid);
      worker.unregisterProcess(peerPid);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores 4096 separated ranges and reports conflict before exhaustion", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-advisory-capacity-"));
    const path = join(root, "file");
    writeFileSync(path, "capacity");
    const worker = await makeWorker();
    const ownerPid = 720;
    const peerPid = 721;
    register(worker, ownerPid);
    register(worker, peerPid);

    try {
      const fd = openFile(worker, ownerPid, path);
      const peerFd = openFile(worker, peerPid, path);
      for (let index = 0; index < MAX_LOCK_RECORDS; index++) {
        expect(lock(worker, ownerPid, fd, BigInt(index * 2), 1n)).toEqual({
          value: 0,
          errno: 0,
        });
      }

      expect(lock(
        worker,
        ownerPid,
        fd,
        BigInt(MAX_LOCK_RECORDS * 2),
        1n,
        F_WRLCK,
        F_SETLKW64,
      ))
        .toEqual({ value: -1, errno: ENOLCK });
      expect(lock(worker, peerPid, peerFd, 0n, 1n)).toEqual({
        value: -1,
        errno: EAGAIN,
      });

      // Unlock and reuse one normalized-record slot without shrinking the
      // manager's high-water allocation.
      expect(lock(worker, ownerPid, fd, 0n, 1n, F_UNLCK)).toEqual({
        value: 0,
        errno: 0,
      });
      expect(lock(worker, ownerPid, fd, BigInt(MAX_LOCK_RECORDS * 2), 1n))
        .toEqual({ value: 0, errno: 0 });

      // A same-owner conversion is non-growing and still succeeds at capacity.
      expect(lock(worker, ownerPid, fd, 2n, 1n, F_RDLCK)).toEqual({
        value: 0,
        errno: 0,
      });

      closeFile(worker, ownerPid, fd);
      closeFile(worker, peerPid, peerFd);
    } finally {
      worker.unregisterProcess(ownerPid);
      worker.unregisterProcess(peerPid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
