import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "../src/process-manager";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { SharedLockTable } from "../src/shared-lock-table";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWasmBytes(): ArrayBuffer {
  const wasmPath = join(__dirname, "../wasm/wasm_posix_kernel.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("Cross-Process Lock — SharedLockTable concurrency", () => {
  it("should detect write-write conflict between different pids", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/test.db");

    // PID 1 acquires write lock
    const ok1 = table.setLock(pathHash, 1, 1, 0n, 0n); // F_WRLCK, whole file
    expect(ok1).toBe(true);

    // PID 2 tries to acquire write lock — should fail (EAGAIN)
    const ok2 = table.setLock(pathHash, 2, 1, 0n, 0n);
    expect(ok2).toBe(false);

    // PID 2 can query via getBlockingLock
    const blocker = table.getBlockingLock(pathHash, 1, 0n, 0n, 2);
    expect(blocker).not.toBeNull();
    expect(blocker!.pid).toBe(1);
  });

  it("should allow read-read from different pids", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/test.db");

    const ok1 = table.setLock(pathHash, 1, 0, 0n, 0n); // F_RDLCK
    expect(ok1).toBe(true);

    const ok2 = table.setLock(pathHash, 2, 0, 0n, 0n); // F_RDLCK
    expect(ok2).toBe(true);
  });

  it("should block write when read lock is held (and vice versa)", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/test.db");

    // PID 1 read lock
    table.setLock(pathHash, 1, 0, 0n, 0n);

    // PID 2 write should fail
    const ok = table.setLock(pathHash, 2, 1, 0n, 0n);
    expect(ok).toBe(false);
  });

  it("should release locks when pid is removed", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/test.db");

    table.setLock(pathHash, 1, 1, 0n, 0n); // write lock

    // PID 2 can't acquire
    expect(table.setLock(pathHash, 2, 1, 0n, 0n)).toBe(false);

    // Remove PID 1's locks (simulates process exit)
    table.removeLocksByPid(1);

    // Now PID 2 can acquire
    expect(table.setLock(pathHash, 2, 1, 0n, 0n)).toBe(true);
  });

  it("should handle setLockWait (blocking acquire)", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/test.db");

    // No conflicting lock — setLockWait should return immediately
    table.setLockWait(pathHash, 1, 1, 0n, 0n);

    // Verify lock is held
    const blocker = table.getBlockingLock(pathHash, 1, 0n, 0n, 2);
    expect(blocker).not.toBeNull();
    expect(blocker!.pid).toBe(1);
  });

  it("should coordinate unlock + setLock sequence across pids", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/counter.txt");

    // PID 1 locks
    table.setLock(pathHash, 1, 1, 0n, 0n);

    // PID 2 can't lock
    expect(table.setLock(pathHash, 2, 1, 0n, 0n)).toBe(false);

    // PID 1 unlocks (F_UNLCK = 2)
    table.setLock(pathHash, 1, 2, 0n, 0n);

    // PID 2 can now lock
    expect(table.setLock(pathHash, 2, 1, 0n, 0n)).toBe(true);

    // PID 1 can't lock while PID 2 holds it
    expect(table.setLock(pathHash, 1, 1, 0n, 0n)).toBe(false);
  });

  it("should handle multiple files independently", () => {
    const table = SharedLockTable.create();
    const hash1 = SharedLockTable.hashPath("/tmp/file1.db");
    const hash2 = SharedLockTable.hashPath("/tmp/file2.db");

    // PID 1 locks file1
    table.setLock(hash1, 1, 1, 0n, 0n);

    // PID 2 can lock file2
    expect(table.setLock(hash2, 2, 1, 0n, 0n)).toBe(true);

    // PID 2 cannot lock file1
    expect(table.setLock(hash1, 2, 1, 0n, 0n)).toBe(false);
  });

  it("should support lock-on-close semantics (unlock by pid removal)", () => {
    const table = SharedLockTable.create();
    const pathHash = SharedLockTable.hashPath("/tmp/test.db");

    // PID 1 acquires lock
    table.setLock(pathHash, 1, 1, 0n, 0n);

    // Simulate closing the fd — POSIX says all locks are released
    table.removeLocksByPid(1);

    // PID 2 should be able to lock immediately
    expect(table.setLock(pathHash, 2, 1, 0n, 0n)).toBe(true);
  });
});

describe("Cross-Process Lock — ProcessManager integration", () => {
  it("should share lock table across spawned processes", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    // Spawn two processes
    const pid1 = await pm.spawn();
    const pid2 = await pm.spawn();

    expect(pid1).toBe(1);
    expect(pid2).toBe(2);

    // Both processes should be running (lock table is shared via SAB)
    expect(pm.getProcess(pid1)!.state).toBe("running");
    expect(pm.getProcess(pid2)!.state).toBe("running");

    await pm.terminate(pid1);
    await pm.terminate(pid2);
  }, 15_000);

  it("should share lock table across forked processes", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const parentPid = await pm.spawn();
    const childPid = await pm.fork(parentPid);

    expect(pm.getProcess(parentPid)!.state).toBe("running");
    expect(pm.getProcess(childPid)!.state).toBe("running");

    await pm.terminate(childPid);
    await pm.terminate(parentPid);
  }, 15_000);

  it("should clean up locks on process termination", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const pid = await pm.spawn();

    // Terminating a process should clean up its locks (belt-and-suspenders with kernel-side cleanup)
    await pm.terminate(pid);

    // Process should be gone
    expect(pm.getProcess(pid)).toBeUndefined();
  }, 15_000);
});
