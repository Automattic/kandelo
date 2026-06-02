import { describe, expect, it } from "vitest";
import { WasmPosixKernel } from "../src/kernel";
import { NodePlatformIO } from "../src/platform/node";

const F_SETLKW = 14;
const F_WRLCK = 1;
const EAGAIN = 11;

describe("WasmPosixKernel fcntl locking import", () => {
  it("returns EAGAIN for conflicting F_SETLKW instead of blocking the kernel worker", () => {
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

    let setLockWaitCalled = false;
    (kernel as any).sharedLockTable = {
      setLock: () => false,
      setLockWait: () => {
        setLockWaitCalled = true;
      },
    };

    const path = "/tmp/blocked.db";
    new TextEncoder().encodeInto(path, new Uint8Array(memory.buffer));

    const result = (kernel as any).hostFcntlLock(
      0,
      path.length,
      2,
      F_SETLKW,
      F_WRLCK,
      0,
      0,
      0,
      0,
      128,
    );

    expect(result).toBe(-EAGAIN);
    expect(setLockWaitCalled).toBe(false);
  });
});
