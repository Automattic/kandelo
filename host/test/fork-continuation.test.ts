import { describe, expect, it } from "vitest";
import {
  ContinuationAllocationError,
  LinkedForkContinuation,
  readLinkedFrameFormat,
  type LinkedFrameFormatDescriptor,
} from "../src/fork-continuation";

const FORMAT: LinkedFrameFormatDescriptor = {
  version: 1,
  ptrWidth: 4,
  alignment: 8,
  flags: 3,
  chunkHeaderSize: 32,
  nodeHeaderSize: 24,
  fixedPrefixSize: 128,
};

function uleb128(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function moduleWithLinkedDescriptor(data: number[]): WebAssembly.Module {
  const name = [...new TextEncoder().encode("kandelo.wpk_fork.linked_frames")];
  const payload = [...uleb128(name.length), ...name, ...data];
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x00, ...uleb128(payload.length), ...payload,
  ]));
}

function linkedDescriptorBytes(): number[] {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x4c, 0x43, 0x46]);
  view.setUint16(4, 1, true);
  view.setUint16(6, 24, true);
  view.setUint8(8, 4);
  view.setUint8(9, 8);
  view.setUint16(10, 3, true);
  view.setUint32(12, 32, true);
  view.setUint32(16, 24, true);
  view.setUint32(20, 128, true);
  return [...bytes];
}

describe("readLinkedFrameFormat", () => {
  it("accepts the exact version-1 descriptor", () => {
    expect(readLinkedFrameFormat(moduleWithLinkedDescriptor(linkedDescriptorBytes())))
      .toEqual(FORMAT);
  });

  it("rejects unknown flags before instantiation", () => {
    const bytes = linkedDescriptorBytes();
    bytes[10] = 7;
    expect(() => readLinkedFrameFormat(moduleWithLinkedDescriptor(bytes)))
      .toThrow("unsupported linked continuation flags");
  });
});

function allocator(memory: WebAssembly.Memory) {
  let next = 65536;
  const allocations: Array<{ addr: number; size: number }> = [];
  const releases: Array<{ addr: number; size: number }> = [];
  return {
    allocations,
    releases,
    allocate(size: number): number {
      const addr = next;
      next += size;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / 65536));
      }
      allocations.push({ addr, size });
      return addr;
    },
    deallocate(addr: number, size: number): void {
      releases.push({ addr, size });
    },
  };
}

function cloneMemory(memory: WebAssembly.Memory): WebAssembly.Memory {
  const clone = new WebAssembly.Memory({
    initial: memory.buffer.byteLength / 65536,
  });
  new Uint8Array(clone.buffer).set(new Uint8Array(memory.buffer));
  return clone;
}

describe("LinkedForkContinuation", () => {
  it("reserves transactionally and replays frames outer-to-inner", () => {
    const parentMemory = new WebAssembly.Memory({ initial: 8 });
    const parentAllocator = allocator(parentMemory);
    const parent = new LinkedForkContinuation(
      parentMemory,
      FORMAT,
      parentAllocator.allocate,
      parentAllocator.deallocate,
      "parent",
    );
    const moduleBuffer = Number(parent.beginUnwind());
    const inner = Number(parent.reserveFrame(16));
    new Uint8Array(parentMemory.buffer, inner, 16).fill(0x11);
    parent.commitFrame(inner);
    const outer = Number(parent.reserveFrame(24));
    new Uint8Array(parentMemory.buffer, outer, 24).fill(0x22);
    parent.commitFrame(outer);
    parent.finishUnwind();

    const childMemory = cloneMemory(parentMemory);
    const childAllocator = allocator(childMemory);
    const child = new LinkedForkContinuation(
      childMemory,
      FORMAT,
      childAllocator.allocate,
      childAllocator.deallocate,
      "child",
    );
    child.attachForReplay(moduleBuffer);
    const replayOuter = Number(child.nextFrame(24));
    const replayInner = Number(child.nextFrame(16));
    expect(new Uint8Array(childMemory.buffer, replayOuter, 24)).toEqual(
      new Uint8Array(24).fill(0x22),
    );
    expect(new Uint8Array(childMemory.buffer, replayInner, 16)).toEqual(
      new Uint8Array(16).fill(0x11),
    );
    child.finishReplayAndRelease();
    expect(childAllocator.releases).toEqual(parentAllocator.allocations);
  });

  it("allocates a multi-page chunk for one frame larger than a Wasm page", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const arenaAllocator = allocator(memory);
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "large-frame",
    );
    arena.beginUnwind();
    const payload = arena.reserveFrame(65536 + 29000);
    arena.commitFrame(payload);
    arena.finishUnwind();

    expect(arenaAllocator.allocations).toEqual([
      { addr: 65536, size: 65536 },
      { addr: 131072, size: 131072 },
    ]);
  });

  it("does not expose an uncommitted reservation to replay", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const arenaAllocator = allocator(memory);
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "uncommitted",
    );
    arena.beginUnwind();
    arena.reserveFrame(32);
    expect(() => arena.finishUnwind()).toThrow("uncommitted frame");
  });

  it("rejects replay when the generated frame size disagrees", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const arenaAllocator = allocator(memory);
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "size-mismatch",
    );
    const moduleBuffer = arena.beginUnwind();
    const payload = arena.reserveFrame(48);
    arena.commitFrame(payload);
    arena.finishUnwind();

    const childMemory = cloneMemory(memory);
    const childAllocator = allocator(childMemory);
    const child = new LinkedForkContinuation(
      childMemory,
      FORMAT,
      childAllocator.allocate,
      childAllocator.deallocate,
      "size-mismatch-child",
    );
    child.attachForReplay(moduleBuffer);
    expect(() => child.nextFrame(47)).toThrow("does not match");
  });

  it("releases a partial chain and reports committed progress on allocation failure", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const releases: Array<{ addr: number; size: number }> = [];
    let allocations = 0;
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      (size) => {
        if (allocations++ > 0) throw new Error("synthetic ENOMEM");
        return 65536;
      },
      (addr, size) => releases.push({ addr, size }),
      "allocation-failure",
    );
    arena.beginUnwind();
    const committed = arena.reserveFrame(32);
    arena.commitFrame(committed);

    expect(() => arena.reserveFrame(65536)).toThrow(
      /committed_frames=1 committed_bytes=32 requested_next_frame=65536.*synthetic ENOMEM/,
    );
    expect(releases).toEqual([{ addr: 65536, size: 65536 }]);
  });

  it("retains committed frames for recoverable abort replay", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    const releases: Array<{ addr: number; size: number }> = [];
    let allocations = 0;
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      (size) => {
        if (allocations++ > 0) {
          throw new ContinuationAllocationError(12, size, "synthetic ENOMEM");
        }
        return 65536;
      },
      (addr, size) => releases.push({ addr, size }),
      "recoverable-allocation-failure",
    );
    arena.beginUnwind();
    const committed = arena.reserveFrame(32);
    arena.commitFrame(committed);

    expect(arena.reserveFrame(65536)).toBe(0);
    expect(arena.abortErrno()).toBe(12);
    expect(releases).toEqual([]);
    expect(Number(arena.nextFrame(32))).toBe(Number(committed));
    arena.finishAbortReplayAndRelease();
    expect(releases).toEqual([{ addr: 65536, size: 65536 }]);
  });

  it("propagates typed root allocation failure without activating unwind", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      (size) => { throw new ContinuationAllocationError(12, size, "root ENOMEM"); },
      () => { throw new Error("nothing was allocated"); },
      "recoverable-root-failure",
    );

    expect(() => arena.beginUnwind()).toThrow(ContinuationAllocationError);
    expect(arena.hasActiveContinuation()).toBe(false);
  });

  it("reports an initial allocation failure before any frame write", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      () => { throw new Error("synthetic initial ENOMEM"); },
      () => { throw new Error("nothing was allocated"); },
      "initial-allocation-failure",
    );

    expect(() => arena.beginUnwind()).toThrow(
      /committed_frames=0 committed_bytes=0.*synthetic initial ENOMEM/,
    );
  });
});
