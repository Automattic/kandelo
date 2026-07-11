import { describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";

describe("MAP_SHARED host interval tracking", () => {
  it("splits a mapping around a partial munmap", () => {
    const worker = createWorker();
    worker.sharedMappings.set(7, new Map([
      [0x10000, { fd: 4, fileOffset: 0x2000, len: 0x30000 }],
    ]));

    worker.cleanupSharedMappings(7, 0x20000, 0x10000);

    expect(Array.from(worker.sharedMappings.get(7)!.entries())).toEqual([
      [0x10000, { fd: 4, fileOffset: 0x2000, len: 0x10000 }],
      [0x30000, { fd: 4, fileOffset: 0x22000, len: 0x10000 }],
    ]);
  });

  it("moves and resizes file-backed metadata with mremap", () => {
    const worker = createWorker();
    worker.sharedMappings.set(9, new Map([
      [0x40000, { fd: 5, fileOffset: 0x6000, len: 0x10000 }],
    ]));

    worker.remapSharedMapping(9, 0x40000, 0x80000, 0x28000);

    expect(worker.sharedMappings.get(9)!.has(0x40000)).toBe(false);
    expect(worker.sharedMappings.get(9)!.get(0x80000)).toEqual({
      fd: 5,
      fileOffset: 0x6000,
      len: 0x28000,
    });
  });

  it("retains mapping-level writeback eligibility after mprotect", () => {
    const worker = createWorker();
    worker.sharedMappings.set(9, new Map([
      [0x40000, {
        fd: 5,
        fileOffset: 0x1000,
        len: 0x30000,
        writable: false,
      }],
    ]));

    worker.updateSharedMappingProtection(9, 0x50000, 0x10000, true);
    worker.updateSharedMappingProtection(9, 0x50000, 0x10000, false);

    expect(worker.sharedMappings.get(9)!.get(0x40000)).toEqual({
      fd: 5,
      fileOffset: 0x1000,
      len: 0x30000,
      writable: true,
    });
  });
});

function createWorker(): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    sharedMappings: new Map(),
  });
}
