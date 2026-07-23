import { describe, expect, it } from "vitest";
import {
  ContinuationAllocationError,
  invokeForkContinuationBegin,
  LinkedForkContinuation,
  readLinkedFrameFormat,
  type LinkedFrameFormatDescriptor,
} from "../src/fork-continuation";
import {
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
} from "../src/generated/abi";

function addressBeginExport(pointerType: 0x7f | 0x7e): WebAssembly.ExportValue {
  const module = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x01, pointerType, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x09, 0x01, 0x05, 0x62, 0x65, 0x67, 0x69, 0x6e, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]));
  return new WebAssembly.Instance(module).exports.begin!;
}

describe("invokeForkContinuationBegin", () => {
  it("calls wasm32 i32 and wasm64 i64 exports with their native JS types", () => {
    const wasm32Begin = addressBeginExport(0x7f);
    const wasm64Begin = addressBeginExport(0x7e);

    expect(() => invokeForkContinuationBegin(wasm32Begin, 4096, 4, "wasm32"))
      .not.toThrow();
    expect(() => invokeForkContinuationBegin(wasm64Begin, 4096, 8, "wasm64"))
      .not.toThrow();

    // Prove this reaches V8's real i64 boundary rather than a mock function.
    expect(() => (wasm64Begin as (value: number) => void)(4096)).toThrow(TypeError);
  });

  it("rejects missing exports and invalid continuation addresses", () => {
    const wasm32Begin = addressBeginExport(0x7f);
    expect(() => invokeForkContinuationBegin(undefined, 4096, 4, "missing"))
      .toThrow("continuation begin export is not callable");
    expect(() => invokeForkContinuationBegin(wasm32Begin, 0, 4, "zero"))
      .toThrow("invalid continuation address");
    expect(() => invokeForkContinuationBegin(
      wasm32Begin,
      Number.MAX_SAFE_INTEGER + 1,
      4,
      "imprecise",
    )).toThrow("invalid continuation address");
  });
});

const wasm32Format = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === 4)!;
const FORMAT: LinkedFrameFormatDescriptor = {
  version: WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  ptrWidth: 4,
  alignment: WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  flags: WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
  chunkHeaderSize: wasm32Format.chunkHeaderSize,
  nodeHeaderSize: wasm32Format.nodeHeaderSize,
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
  const name = [...new TextEncoder().encode(WPK_FORK_LINKED_FRAME_FORMAT_SECTION)];
  const payload = [...uleb128(name.length), ...name, ...data];
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x00, ...uleb128(payload.length), ...payload,
  ]));
}

function linkedDescriptorBytes(pointerWidth: 4 | 8 = 4): number[] {
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === pointerWidth,
  )!;
  const bytes = new Uint8Array(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC);
  view.setUint16(4, WPK_FORK_LINKED_FRAME_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, true);
  view.setUint8(8, pointerWidth);
  view.setUint8(9, WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT);
  view.setUint16(10, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, true);
  view.setUint32(12, pointerFormat.chunkHeaderSize, true);
  view.setUint32(16, pointerFormat.nodeHeaderSize, true);
  view.setUint32(20, 128, true);
  return [...bytes];
}

describe("readLinkedFrameFormat", () => {
  it("accepts exact generated wasm32 and wasm64 descriptors", () => {
    expect(readLinkedFrameFormat(moduleWithLinkedDescriptor(linkedDescriptorBytes())))
      .toEqual(FORMAT);
    const wasm64Format = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === 8)!;
    expect(readLinkedFrameFormat(moduleWithLinkedDescriptor(linkedDescriptorBytes(8))))
      .toEqual({
        ...FORMAT,
        ptrWidth: 8,
        chunkHeaderSize: wasm64Format.chunkHeaderSize,
        nodeHeaderSize: wasm64Format.nodeHeaderSize,
      });
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
