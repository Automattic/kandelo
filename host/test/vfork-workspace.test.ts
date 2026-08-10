import { describe, expect, it } from "vitest";
import { BorrowedVforkWorkspace } from "../src/vfork-workspace";
import { ThreadPageAllocator } from "../src/thread-allocator";

const PAGE = 65_536;

function memory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 6,
    maximum: 6,
    shared: true,
  });
}

describe("borrowed vfork workspace", () => {
  it("gives the child a private syscall channel, replay prefix, and scratch page", () => {
    const shared = new WebAssembly.Memory({
      initial: 10,
      maximum: 10,
      shared: true,
    });
    const parentChannelOffset = 2 * PAGE;
    const allocator = new ThreadPageAllocator({
      firstSlotStartPage: 6,
      maxPageExclusive: 10,
      reservedSlots: 0,
    });
    const childControl = allocator.allocateHostControl(shared);
    const workspace = new BorrowedVforkWorkspace(
      shared,
      4,
      {
        prefixAddress: childControl.forkSaveOffset,
        prefixBytes: 64,
        scratchAddress: childControl.tlsOffset,
        scratchBytes: PAGE,
      },
      "private child control",
    );

    expect(childControl.channelOffset).not.toBe(parentChannelOffset);
    expect(childControl.channelOffset).not.toBe(childControl.forkSaveOffset);
    expect(childControl.channelOffset).not.toBe(childControl.tlsOffset);
    expect(childControl.forkSaveOffset).not.toBe(childControl.tlsOffset);
    expect(workspace.reservePrefix({
      activationId: 0,
      byteLength: 64,
      alignment: 16,
    })).toBe(childControl.forkSaveOffset);
    const scratch = workspace.allocateScratch(16);
    expect(scratch).toBe(childControl.tlsOffset);
    workspace.deallocateScratch(scratch, 16);
    workspace.assertAttachComplete();
  });

  it.each([4, 8] as const)(
    "allocates exact wasm%s prefixes and LIFO scratch without overlap",
    (ptrWidth) => {
      const shared = memory();
      const workspace = new BorrowedVforkWorkspace(
        shared,
        ptrWidth,
        {
          prefixAddress: PAGE + 4_096,
          prefixBytes: 96,
          scratchAddress: 3 * PAGE,
          scratchBytes: PAGE,
        },
        `wasm${ptrWidth * 8} test workspace`,
      );
      const first = workspace.reservePrefix({
        activationId: 0,
        byteLength: 32,
        alignment: 16,
      });
      const second = workspace.reservePrefix({
        activationId: 4,
        byteLength: 64,
        alignment: 16,
      });
      expect(first).toBe(ptrWidth === 8 ? BigInt(PAGE + 4_096) : PAGE + 4_096);
      expect(second).toBe(ptrWidth === 8
        ? BigInt(PAGE + 4_128)
        : PAGE + 4_128);

      const outer = workspace.allocateScratch(32);
      const inner = workspace.allocateScratch(64);
      new Uint8Array(shared.buffer, inner, 64).fill(0xa5);
      expect(() => workspace.deallocateScratch(outer, 32)).toThrow(
        "not LIFO-exact",
      );
      workspace.deallocateScratch(inner, 64);
      expect(new Uint8Array(shared.buffer, inner, 64)).toEqual(
        new Uint8Array(64),
      );
      workspace.deallocateScratch(outer, 32);
      workspace.assertAttachComplete();
    },
  );

  it("rejects overlap, exhaustion, and an incomplete admitted prefix", () => {
    const shared = memory();
    expect(() => new BorrowedVforkWorkspace(shared, 4, {
      prefixAddress: PAGE,
      prefixBytes: PAGE,
      scratchAddress: PAGE + 32,
      scratchBytes: 64,
    })).toThrow("overlap");

    const workspace = new BorrowedVforkWorkspace(shared, 4, {
      prefixAddress: PAGE,
      prefixBytes: 32,
      scratchAddress: 3 * PAGE,
      scratchBytes: 16,
    });
    expect(() => workspace.reservePrefix({
      activationId: 0,
      byteLength: 33,
      alignment: 16,
    })).toThrow("exceeds 32 admitted bytes");
    expect(() => workspace.allocateScratch(17)).toThrow(
      "exceeds 16 admitted bytes",
    );
    expect(() => workspace.assertAttachComplete()).toThrow(
      "consumed 0 prefix bytes",
    );
  });
});
