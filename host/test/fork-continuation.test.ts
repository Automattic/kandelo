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

const PAGE_SIZE = 65_536;

function formatFor(ptrWidth: 4 | 8): LinkedFrameFormatDescriptor {
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === ptrWidth,
  )!;
  return {
    version: WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
    ptrWidth,
    alignment: WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
    flags: WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
    chunkHeaderSize: pointerFormat.chunkHeaderSize,
    nodeHeaderSize: pointerFormat.nodeHeaderSize,
    fixedPrefixSize: 128,
  };
}

const FORMAT = formatFor(4);

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
  let next = PAGE_SIZE;
  const allocations: Array<{ addr: number; size: number }> = [];
  const releases: Array<{ addr: number; size: number }> = [];
  return {
    allocations,
    releases,
    allocate(size: number): number {
      const addr = next;
      next += size;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE_SIZE));
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
    initial: memory.buffer.byteLength / PAGE_SIZE,
  });
  new Uint8Array(clone.buffer).set(new Uint8Array(memory.buffer));
  return clone;
}

function guestPointer(value: number, ptrWidth: 4 | 8): number | bigint {
  return ptrWidth === 8 ? BigInt(value) : value;
}

function writePointer(
  memory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
  addr: number,
  value: number,
): void {
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(addr, BigInt(value), true);
  else view.setUint32(addr, value, true);
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

  it.each([4, 8] as const)(
    "replays a deep multi-chunk wasm%s chain in exact reverse frame order",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      const parentMemory = new WebAssembly.Memory({ initial: 4 });
      const parentAllocator = allocator(parentMemory);
      const parent = new LinkedForkContinuation(
        parentMemory,
        format,
        parentAllocator.allocate,
        parentAllocator.deallocate,
        `deep-wasm${ptrWidth * 8}`,
      );
      const moduleBuffer = parent.beginUnwind();
      const frames = Array.from({ length: 257 }, (_, index) => ({
        size: 4_096 + index % 5 * format.alignment,
        byte: (index * 37) & 0xff,
      }));
      for (const frame of frames) {
        const payload = parent.reserveFrame(guestPointer(frame.size, ptrWidth));
        new Uint8Array(parentMemory.buffer, Number(payload), frame.size).fill(frame.byte);
        parent.commitFrame(payload);
      }
      parent.finishUnwind();
      expect(parentAllocator.allocations.length).toBeGreaterThan(10);

      // Clone before the parent consumes its nodes, exactly as fork gives the
      // child an independent copy of continuation memory.
      const childMemory = cloneMemory(parentMemory);
      parent.beginReplay();
      for (const frame of [...frames].reverse()) {
        const payload = parent.nextFrame(guestPointer(frame.size, ptrWidth));
        const bytes = new Uint8Array(parentMemory.buffer, Number(payload), frame.size);
        expect(bytes[0]).toBe(frame.byte);
        expect(bytes[bytes.length - 1]).toBe(frame.byte);
      }
      parent.finishReplayAndRelease();
      expect(parentAllocator.releases).toEqual(
        [...parentAllocator.allocations].reverse(),
      );

      const childAllocator = allocator(childMemory);
      const child = new LinkedForkContinuation(
        childMemory,
        format,
        childAllocator.allocate,
        childAllocator.deallocate,
        `deep-child-wasm${ptrWidth * 8}`,
      );
      child.attachForReplay(moduleBuffer);
      for (const frame of [...frames].reverse()) {
        const payload = child.nextFrame(guestPointer(frame.size, ptrWidth));
        const bytes = new Uint8Array(childMemory.buffer, Number(payload), frame.size);
        expect(bytes[0]).toBe(frame.byte);
        expect(bytes[bytes.length - 1]).toBe(frame.byte);
      }
      child.finishReplayAndRelease();
      expect(childAllocator.releases).toEqual(
        [...parentAllocator.allocations].reverse(),
      );
    },
  );

  it.each([4, 8] as const)(
    "rejects a two-node wasm%s chunk cycle at its first repeated address",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      const parentMemory = new WebAssembly.Memory({ initial: 5 });
      const parentAllocator = allocator(parentMemory);
      const parent = new LinkedForkContinuation(
        parentMemory,
        format,
        parentAllocator.allocate,
        parentAllocator.deallocate,
        `cycle-parent-wasm${ptrWidth * 8}`,
      );
      const moduleBuffer = parent.beginUnwind();
      const payload = parent.reserveFrame(guestPointer(PAGE_SIZE, ptrWidth));
      parent.commitFrame(payload);
      parent.finishUnwind();
      expect(parentAllocator.allocations).toHaveLength(2);
      const [root, second] = parentAllocator.allocations;
      writePointer(
        parentMemory,
        ptrWidth,
        second!.addr + 8 + 2 * ptrWidth,
        root!.addr,
      );

      const childMemory = cloneMemory(parentMemory);
      const child = new LinkedForkContinuation(
        childMemory,
        format,
        () => { throw new Error("replay must not allocate"); },
        () => { throw new Error("failed attachment must not release"); },
        `cycle-child-wasm${ptrWidth * 8}`,
      );
      expect(() => child.attachForReplay(moduleBuffer)).toThrow(
        "linked continuation chunk cycle",
      );
      expect(child.hasActiveContinuation()).toBe(false);
    },
  );

  it.each([4, 8] as const)(
    "rejects distinct wasm%s chunk headers whose declared ranges overlap",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      const parentMemory = new WebAssembly.Memory({ initial: 8 });
      const parentAllocator = allocator(parentMemory);
      const parent = new LinkedForkContinuation(
        parentMemory,
        format,
        parentAllocator.allocate,
        parentAllocator.deallocate,
        `overlap-parent-wasm${ptrWidth * 8}`,
      );
      const moduleBuffer = parent.beginUnwind();
      const payload = parent.reserveFrame(guestPointer(PAGE_SIZE, ptrWidth));
      parent.commitFrame(payload);
      parent.finishUnwind();
      expect(parentAllocator.allocations).toHaveLength(2);
      const root = parentAllocator.allocations[0]!;
      const second = parentAllocator.allocations[1]!;
      expect(second.size).toBe(2 * PAGE_SIZE);

      const overlapping = second.addr + PAGE_SIZE;
      const copiedHeader = new Uint8Array(
        parentMemory.buffer,
        second.addr,
        format.chunkHeaderSize,
      ).slice();
      new Uint8Array(
        parentMemory.buffer,
        overlapping,
        format.chunkHeaderSize,
      ).set(copiedHeader);
      writePointer(
        parentMemory,
        ptrWidth,
        second.addr + 8 + 2 * ptrWidth,
        overlapping,
      );
      writePointer(
        parentMemory,
        ptrWidth,
        overlapping + 8 + ptrWidth,
        second.addr,
      );
      writePointer(parentMemory, ptrWidth, overlapping + 8 + 2 * ptrWidth, 0);
      writePointer(
        parentMemory,
        ptrWidth,
        overlapping + 8 + 3 * ptrWidth,
        PAGE_SIZE,
      );
      writePointer(
        parentMemory,
        ptrWidth,
        overlapping + 8 + 4 * ptrWidth,
        format.chunkHeaderSize + format.nodeHeaderSize,
      );
      const actualNode = Number(payload) - format.nodeHeaderSize;
      const forgedNode = overlapping + format.chunkHeaderSize;
      const copiedNodeHeader = new Uint8Array(
        parentMemory.buffer,
        actualNode,
        format.nodeHeaderSize,
      ).slice();
      new Uint8Array(
        parentMemory.buffer,
        forgedNode,
        format.nodeHeaderSize,
      ).set(copiedNodeHeader);
      writePointer(parentMemory, ptrWidth, forgedNode + 8, actualNode);
      writePointer(parentMemory, ptrWidth, forgedNode + 8 + ptrWidth, 0);
      writePointer(
        parentMemory,
        ptrWidth,
        forgedNode + 8 + 2 * ptrWidth,
        format.nodeHeaderSize,
      );
      writePointer(
        parentMemory,
        ptrWidth,
        root.addr + 8 + 5 * ptrWidth,
        forgedNode,
      );

      const releases: Array<{ addr: number; size: number }> = [];
      const child = new LinkedForkContinuation(
        cloneMemory(parentMemory),
        format,
        () => { throw new Error("replay must not allocate"); },
        (addr, size) => releases.push({ addr, size }),
        `overlap-child-wasm${ptrWidth * 8}`,
      );
      expect(() => child.attachForReplay(moduleBuffer)).toThrow(
        "linked continuation chunk ranges overlap",
      );
      expect(child.hasActiveContinuation()).toBe(false);
      expect(releases).toEqual([]);
    },
  );

  it.each([4, 8] as const)(
    "rejects a zero wasm%s replay tail when committed frame bytes exist",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      const parentMemory = new WebAssembly.Memory({ initial: 4 });
      const parentAllocator = allocator(parentMemory);
      const parent = new LinkedForkContinuation(
        parentMemory,
        format,
        parentAllocator.allocate,
        parentAllocator.deallocate,
        `missing-tail-parent-wasm${ptrWidth * 8}`,
      );
      const moduleBuffer = parent.beginUnwind();
      const payload = parent.reserveFrame(guestPointer(32, ptrWidth));
      parent.commitFrame(payload);
      parent.finishUnwind();
      const root = parentAllocator.allocations[0]!;
      writePointer(parentMemory, ptrWidth, root.addr + 8 + 5 * ptrWidth, 0);

      const releases: Array<{ addr: number; size: number }> = [];
      const child = new LinkedForkContinuation(
        cloneMemory(parentMemory),
        format,
        () => { throw new Error("replay must not allocate"); },
        (addr, size) => releases.push({ addr, size }),
        `missing-tail-child-wasm${ptrWidth * 8}`,
      );
      expect(() => child.attachForReplay(moduleBuffer)).toThrow(
        "nonempty linked continuation has no replay tail",
      );
      expect(child.hasActiveContinuation()).toBe(false);
      expect(releases).toEqual([]);
    },
  );

  it.each([4, 8] as const)(
    "rejects a nonzero wasm%s replay tail when no frame bytes exist",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      const parentMemory = new WebAssembly.Memory({ initial: 4 });
      const parentAllocator = allocator(parentMemory);
      const parent = new LinkedForkContinuation(
        parentMemory,
        format,
        parentAllocator.allocate,
        parentAllocator.deallocate,
        `unexpected-tail-parent-wasm${ptrWidth * 8}`,
      );
      const moduleBuffer = parent.beginUnwind();
      parent.finishUnwind();
      const root = parentAllocator.allocations[0]!;
      const nodeStart = root.addr + Math.ceil(
        (format.chunkHeaderSize + format.fixedPrefixSize) / format.alignment,
      ) * format.alignment;
      writePointer(
        parentMemory,
        ptrWidth,
        root.addr + 8 + 5 * ptrWidth,
        nodeStart,
      );

      const releases: Array<{ addr: number; size: number }> = [];
      const child = new LinkedForkContinuation(
        cloneMemory(parentMemory),
        format,
        () => { throw new Error("replay must not allocate"); },
        (addr, size) => releases.push({ addr, size }),
        `unexpected-tail-child-wasm${ptrWidth * 8}`,
      );
      expect(() => child.attachForReplay(moduleBuffer)).toThrow(
        "empty linked continuation has a replay tail",
      );
      expect(child.hasActiveContinuation()).toBe(false);
      expect(releases).toEqual([]);
    },
  );

  it.each([4, 8] as const)(
    "revalidates the wasm%s tail before local normal and abort replay",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      for (const replayKind of ["normal", "abort"] as const) {
        const memory = new WebAssembly.Memory({ initial: 4 });
        const arenaAllocator = allocator(memory);
        const arena = new LinkedForkContinuation(
          memory,
          format,
          arenaAllocator.allocate,
          arenaAllocator.deallocate,
          `local-${replayKind}-wasm${ptrWidth * 8}`,
        );
        arena.beginUnwind();
        const payload = arena.reserveFrame(guestPointer(32, ptrWidth));
        arena.commitFrame(payload);
        arena.finishUnwind();
        const root = arenaAllocator.allocations[0]!;
        writePointer(memory, ptrWidth, root.addr + 8 + 5 * ptrWidth, 0);

        const beginReplay = replayKind === "normal"
          ? () => arena.beginReplay()
          : () => arena.beginAbortReplay(12);
        expect(beginReplay).toThrow(
          "nonempty linked continuation has no replay tail",
        );
        expect(arena.hasActiveContinuation()).toBe(true);
        expect(arenaAllocator.releases).toEqual([]);
        arena.cancelUnwindAndRelease();
        expect(arenaAllocator.releases).toEqual([root]);
      }
    },
  );

  it.each([4, 8] as const)(
    "allows a wasm%s allocation abort before any frame was committed",
    (ptrWidth) => {
      const format = formatFor(ptrWidth);
      const memory = new WebAssembly.Memory({ initial: 4 });
      const releases: Array<{ addr: number; size: number }> = [];
      let allocations = 0;
      const arena = new LinkedForkContinuation(
        memory,
        format,
        (size) => {
          if (allocations++ > 0) {
            throw new ContinuationAllocationError(12, size, "synthetic ENOMEM");
          }
          return PAGE_SIZE;
        },
        (addr, size) => releases.push({ addr, size }),
        `empty-abort-wasm${ptrWidth * 8}`,
      );
      arena.beginUnwind();
      expect(arena.reserveFrame(guestPointer(PAGE_SIZE, ptrWidth))).toBe(
        guestPointer(0, ptrWidth),
      );
      expect(arena.abortErrno()).toBe(12);
      arena.finishAbortReplayAndRelease();
      expect(releases).toEqual([{ addr: PAGE_SIZE, size: PAGE_SIZE }]);
    },
  );

  it("bounds an attached chunk chain by the pages available in memory", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "memory-bound-parent",
    );
    const moduleBuffer = arena.beginUnwind();
    for (let index = 0; index < 2; index += 1) {
      const payload = arena.reserveFrame(40_000);
      arena.commitFrame(payload);
    }
    arena.finishUnwind();
    expect(arenaAllocator.allocations).toHaveLength(2);
    const second = arenaAllocator.allocations[1]!;
    writePointer(memory, 4, second.addr + 8 + 2 * FORMAT.ptrWidth, 3 * PAGE_SIZE);

    const child = new LinkedForkContinuation(
      cloneMemory(memory),
      FORMAT,
      () => { throw new Error("replay must not allocate"); },
      () => { throw new Error("failed attachment must not release"); },
      "memory-bound-child",
    );
    expect(() => child.attachForReplay(moduleBuffer)).toThrow(
      "chunk chain exceeds memory",
    );
    expect(child.hasActiveContinuation()).toBe(false);
  });

  it("rejects a reverse link at the exclusive end of the prior chunk", () => {
    const memory = new WebAssembly.Memory({ initial: 5 });
    const arenaAllocator = allocator(memory);
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "boundary-parent",
    );
    const moduleBuffer = arena.beginUnwind();
    const payloads = [];
    for (let index = 0; index < 3; index += 1) {
      const payload = arena.reserveFrame(40_000);
      payloads.push(Number(payload));
      arena.commitFrame(payload);
    }
    arena.finishUnwind();
    expect(arenaAllocator.allocations).toHaveLength(3);
    const prior = arenaAllocator.allocations[1]!;
    const tailNode = payloads[2]! - FORMAT.nodeHeaderSize;
    writePointer(memory, 4, tailNode + 8, prior.addr + prior.size);

    const child = new LinkedForkContinuation(
      cloneMemory(memory),
      FORMAT,
      () => { throw new Error("replay must not allocate"); },
      () => {},
      "boundary-child",
    );
    child.attachForReplay(moduleBuffer);
    expect(() => child.nextFrame(40_000)).toThrow(
      "frame pointer is outside the expected continuation chunk",
    );
  });

  it("rejects a reverse link that skips a frame in the active chunk", () => {
    const memory = new WebAssembly.Memory({ initial: 5 });
    const arenaAllocator = allocator(memory);
    const arena = new LinkedForkContinuation(
      memory,
      FORMAT,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "ordering-parent",
    );
    const moduleBuffer = arena.beginUnwind();
    const payloads = [];
    for (let index = 0; index < 4; index += 1) {
      const payload = arena.reserveFrame(30_000);
      payloads.push(Number(payload));
      arena.commitFrame(payload);
    }
    arena.finishUnwind();
    expect(arenaAllocator.allocations).toHaveLength(2);
    const tailNode = payloads[3]! - FORMAT.nodeHeaderSize;
    const priorChunkNode = payloads[1]! - FORMAT.nodeHeaderSize;
    writePointer(memory, 4, tailNode + 8, priorChunkNode);

    const child = new LinkedForkContinuation(
      cloneMemory(memory),
      FORMAT,
      () => { throw new Error("replay must not allocate"); },
      () => {},
      "ordering-child",
    );
    child.attachForReplay(moduleBuffer);
    expect(() => child.nextFrame(30_000)).toThrow(
      "linked continuation replay skipped a frame",
    );
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
