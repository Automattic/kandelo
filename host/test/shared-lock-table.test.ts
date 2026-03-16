import { describe, it, expect } from "vitest";
import { SharedLockTable } from "../src/shared-lock-table";

describe("SharedLockTable", () => {
  it("should create with default capacity", () => {
    const table = SharedLockTable.create();
    expect(table.getBuffer()).toBeInstanceOf(SharedArrayBuffer);
  });

  it("should reconstruct from existing buffer", () => {
    const table1 = SharedLockTable.create(64);
    table1.setLock(123, 1, 1, 0n, 100n); // write lock
    const table2 = SharedLockTable.fromBuffer(table1.getBuffer());
    const blocker = table2.getBlockingLock(123, 1, 0n, 100n, 2);
    expect(blocker).not.toBeNull();
    expect(blocker!.pid).toBe(1);
  });

  it("should detect write-write conflict between different pids", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 100n); // pid 1: write lock [0,100)
    const blocker = table.getBlockingLock(100, 1, 50n, 50n, 2); // pid 2 wants write
    expect(blocker).not.toBeNull();
    expect(blocker!.pid).toBe(1);
    expect(blocker!.lockType).toBe(1); // F_WRLCK
  });

  it("should not conflict for same pid", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 100n); // pid 1: write lock
    const blocker = table.getBlockingLock(100, 1, 0n, 100n, 1); // same pid
    expect(blocker).toBeNull();
  });

  it("should allow read-read from different pids", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 0, 0n, 100n); // pid 1: read lock
    const blocker = table.getBlockingLock(100, 0, 0n, 100n, 2); // pid 2 wants read
    expect(blocker).toBeNull();
  });

  it("should detect read-write conflict", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 0, 0n, 100n); // pid 1: read lock
    const blocker = table.getBlockingLock(100, 1, 50n, 50n, 2); // pid 2 wants write
    expect(blocker).not.toBeNull();
  });

  it("should detect write-read conflict", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 100n); // pid 1: write lock
    const blocker = table.getBlockingLock(100, 0, 50n, 50n, 2); // pid 2 wants read
    expect(blocker).not.toBeNull();
  });

  it("should not conflict for non-overlapping ranges", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 50n); // pid 1: write [0,50)
    const blocker = table.getBlockingLock(100, 1, 50n, 50n, 2); // pid 2: [50,100)
    expect(blocker).toBeNull();
  });

  it("should not conflict for different path hashes", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 100n); // path_hash 100
    const blocker = table.getBlockingLock(200, 1, 0n, 100n, 2); // path_hash 200
    expect(blocker).toBeNull();
  });

  it("should handle zero-length (to EOF) locks", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 100n, 0n); // write lock from 100 to EOF
    expect(table.getBlockingLock(100, 1, 200n, 50n, 2)).not.toBeNull();
    expect(table.getBlockingLock(100, 1, 0n, 100n, 2)).toBeNull();
  });

  it("should remove lock on unlock", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 100n); // write lock
    expect(table.getBlockingLock(100, 1, 0n, 100n, 2)).not.toBeNull();
    table.setLock(100, 1, 2, 0n, 100n); // F_UNLCK
    expect(table.getBlockingLock(100, 1, 0n, 100n, 2)).toBeNull();
  });

  it("should replace same-pid lock on same range (upgrade)", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 0, 0n, 100n); // read lock
    table.setLock(100, 1, 1, 0n, 100n); // upgrade to write lock
    const blocker = table.getBlockingLock(100, 1, 0n, 100n, 2);
    expect(blocker).not.toBeNull();
    expect(blocker!.lockType).toBe(1); // F_WRLCK
  });

  it("should return false on conflict with setLock (EAGAIN)", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 100n); // pid 1: write lock
    const result = table.setLock(100, 2, 1, 0n, 100n); // pid 2: write lock
    expect(result).toBe(false);
  });

  it("should removeLocksByPid", () => {
    const table = SharedLockTable.create();
    table.setLock(100, 1, 1, 0n, 50n);
    table.setLock(200, 1, 0, 0n, 100n);
    table.setLock(100, 2, 1, 50n, 50n); // different pid
    table.removeLocksByPid(1);
    // pid 1 locks gone
    expect(table.getBlockingLock(100, 1, 0n, 50n, 3)).toBeNull();
    expect(table.getBlockingLock(200, 0, 0n, 100n, 3)).toBeNull();
    // pid 2 lock still present
    expect(table.getBlockingLock(100, 1, 50n, 50n, 3)).not.toBeNull();
  });

  it("hashPath should be deterministic", () => {
    const hash1 = SharedLockTable.hashPath("/tmp/test.db");
    const hash2 = SharedLockTable.hashPath("/tmp/test.db");
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("number");
  });

  it("hashPath should produce different hashes for different paths", () => {
    const hash1 = SharedLockTable.hashPath("/tmp/a.db");
    const hash2 = SharedLockTable.hashPath("/tmp/b.db");
    expect(hash1).not.toBe(hash2);
  });
});
