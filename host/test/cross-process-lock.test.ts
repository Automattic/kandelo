import { describe, it, expect } from "vitest";
import { SharedLockTable } from "../src/shared-lock-table";

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
