import { describe, expect, it } from "vitest";
import { WasmPosixKernel } from "../src/kernel";
import { NodePlatformIO } from "../src/platform/node";

const F_SETLK = 13;
const F_SETLKW = 14;
const F_WRLCK = 1;
const EAGAIN = 11;

type LockCall = [number, number, number, bigint, bigint];

function makeKernel(lockTable: Record<string, unknown>) {
  const kernel = new WasmPosixKernel(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
    new NodePlatformIO(),
  );
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  (kernel as any).memory = memory;
  (kernel as any).sharedLockTable = lockTable;

  const path = "/tmp/blocked.db";
  new TextEncoder().encodeInto(path, new Uint8Array(memory.buffer));

  return { kernel, path };
}

function hostFcntlLock(
  kernel: WasmPosixKernel,
  path: string,
  cmd: number,
  start = 0n,
  len = 128n,
) {
  return (kernel as any).hostFcntlLock(
    0,
    path.length,
    2,
    cmd,
    F_WRLCK,
    Number(start & 0xffffffffn),
    Number((start >> 32n) & 0xffffffffn),
    Number(len & 0xffffffffn),
    Number((len >> 32n) & 0xffffffffn),
    128,
  );
}

describe("WasmPosixKernel fcntl locking import", () => {
  it("returns EAGAIN for conflicting F_SETLK", () => {
    const setLockCalls: LockCall[] = [];
    let setLockWaitCalled = false;
    const { kernel, path } = makeKernel({
      setLock: (...args: LockCall) => {
        setLockCalls.push(args);
        return false;
      },
      setLockWait: () => {
        setLockWaitCalled = true;
      },
    });

    const result = hostFcntlLock(kernel, path, F_SETLK);

    expect(result).toBe(-EAGAIN);
    expect(setLockCalls).toHaveLength(1);
    expect(setLockCalls[0].slice(1)).toEqual([2, F_WRLCK, 0n, 128n]);
    expect(setLockWaitCalled).toBe(false);
  });

  it("returns EAGAIN for conflicting F_SETLKW instead of blocking the kernel worker", () => {
    const setLockCalls: LockCall[] = [];
    let setLockWaitCalled = false;
    const { kernel, path } = makeKernel({
      setLock: (...args: LockCall) => {
        setLockCalls.push(args);
        return false;
      },
      setLockWait: () => {
        setLockWaitCalled = true;
      },
    });

    const result = hostFcntlLock(kernel, path, F_SETLKW);

    expect(result).toBe(-EAGAIN);
    expect(setLockCalls).toHaveLength(1);
    expect(setLockCalls[0].slice(1)).toEqual([2, F_WRLCK, 0n, 128n]);
    expect(setLockWaitCalled).toBe(false);
  });

  it("acquires F_SETLKW through setLock so the worker controls retrying", () => {
    const setLockCalls: LockCall[] = [];
    let setLockWaitCalled = false;
    const { kernel, path } = makeKernel({
      setLock: (...args: LockCall) => {
        setLockCalls.push(args);
        return true;
      },
      setLockWait: () => {
        setLockWaitCalled = true;
      },
    });

    const result = hostFcntlLock(kernel, path, F_SETLKW, 32n, 64n);

    expect(result).toBe(0);
    expect(setLockCalls).toHaveLength(1);
    expect(setLockCalls[0].slice(1)).toEqual([2, F_WRLCK, 32n, 64n]);
    expect(setLockWaitCalled).toBe(false);
  });
});
