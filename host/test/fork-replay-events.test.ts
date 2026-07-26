import { describe, expect, it } from "vitest";
import {
  FORK_REPLAY_EVENT_SEGMENT_CAPACITY,
  type ForkReplayEventWire,
  encodeForkReplayEventManifest,
  encodeForkReplayEventSegment,
  ForkReplayEventJournal,
  ForkResumeTable,
  validateForkReplayEventWire,
} from "../src/fork-replay-events";

function wasmFunction(): CallableFunction {
  const module = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x07, 0x0b,
  ]));
  return new WebAssembly.Instance(module).exports.f as CallableFunction;
}

function sealedWire(
  journal: ForkReplayEventJournal,
): ForkReplayEventWire & { segments: Uint8Array[] } {
  journal.sealCapture();
  return {
    manifest: journal.capturedManifestPayload(),
    segments: [...journal.capturedSegmentPayloads()],
  };
}

describe("ForkReplayEventJournal", () => {
  it("replays the exact reverse of cross-module frame commit order", () => {
    const parent = new ForkReplayEventJournal();
    parent.beginCapture();
    parent.recordCommit(3, 8);
    parent.recordCommit(3, 4);
    parent.recordCommit(0, 11);
    const wire = sealedWire(parent);
    parent.beginParentReplay();

    expect(parent.peek()).toEqual({ activationId: 0, functionOrdinal: 11 });
    parent.consume(0, 11);
    expect(parent.peek()).toEqual({ activationId: 3, functionOrdinal: 4 });
    parent.consume(3, 4);
    expect(parent.peek()).toEqual({ activationId: 3, functionOrdinal: 8 });
    parent.consume(3, 8);
    expect(parent.peek()).toBeNull();
    parent.finishReplay();

    const child = new ForkReplayEventJournal();
    child.attachChild(wire);
    expect(child.peek()).toEqual({ activationId: 0, functionOrdinal: 11 });
  });

  it("streams multi-page capture and child replay without concatenation", () => {
    const eventCount = FORK_REPLAY_EVENT_SEGMENT_CAPACITY + 3;
    const parent = new ForkReplayEventJournal();
    parent.beginCapture();
    for (let index = 0; index < eventCount; index++) {
      parent.recordCommit(index % 3, index);
    }
    const wire = sealedWire(parent);
    const summary = validateForkReplayEventWire(wire);
    expect(summary.eventCount).toBe(BigInt(eventCount));
    expect(summary.segmentCount).toBe(2n);
    expect(summary.activationIds).toEqual(new Set([0, 1, 2]));
    expect(wire.segments).toHaveLength(2);

    parent.beginParentReplay();
    const child = new ForkReplayEventJournal();
    child.attachChild(wire);
    for (let index = eventCount - 1; index >= 0; index--) {
      const expected = { activationId: index % 3, functionOrdinal: index };
      expect(parent.peek()).toEqual(expected);
      parent.consume(expected.activationId, expected.functionOrdinal);
      expect(child.peek()).toEqual(expected);
      child.consume(expected.activationId, expected.functionOrdinal);
    }
    expect(parent.peek()).toBeNull();
    expect(child.peek()).toBeNull();
    parent.finishReplay();
    child.finishReplay();
  });

  it("requires peek and consume to name the same frame atomically", () => {
    const journal = new ForkReplayEventJournal();
    journal.beginCapture();
    journal.recordCommit(1, 2);
    sealedWire(journal);
    journal.beginParentReplay();
    expect(() => journal.consume(1, 2)).toThrow("without selecting");
    journal.peek();
    expect(() => journal.consume(1, 3)).toThrow("expected 1:2");
  });

  it("drops every page on abort and can begin another capture", () => {
    const journal = new ForkReplayEventJournal();
    journal.beginCapture();
    for (
      let index = 0;
      index < FORK_REPLAY_EVENT_SEGMENT_CAPACITY + 1;
      index++
    ) {
      journal.recordCommit(7, index);
    }
    journal.abort();
    expect(journal.phaseName()).toBe("idle");
    journal.beginCapture();
    journal.recordCommit(1, 2);
    expect(validateForkReplayEventWire(sealedWire(journal)).eventCount).toBe(1n);
  });
});

describe("fork replay event segmented wire", () => {
  function twoPageWire(): ForkReplayEventWire & { segments: Uint8Array[] } {
    const journal = new ForkReplayEventJournal();
    journal.beginCapture();
    for (
      let index = 0;
      index < FORK_REPLAY_EVENT_SEGMENT_CAPACITY + 2;
      index++
    ) {
      journal.recordCommit(index % 2, index);
    }
    return sealedWire(journal);
  }

  it("rejects out-of-order segment sequence numbers", () => {
    const wire = twoPageWire();
    const segments = wire.segments.map((segment) => segment.slice());
    new DataView(segments[1]!.buffer).setBigUint64(8, 0n, true);
    expect(() =>
      validateForkReplayEventWire({ manifest: wire.manifest, segments })
    ).toThrow("out of order");
  });

  it("rejects reordered, duplicated, missing, gapped, and trailing segments", () => {
    const wire = twoPageWire();
    expect(() =>
      validateForkReplayEventWire({
        manifest: wire.manifest,
        segments: [wire.segments[1]!, wire.segments[0]!],
      })
    ).toThrow("out of order");
    expect(() =>
      validateForkReplayEventWire({
        manifest: wire.manifest,
        segments: [wire.segments[0]!, wire.segments[0]!],
      })
    ).toThrow("out of order");
    expect(() =>
      validateForkReplayEventWire({
        manifest: wire.manifest,
        segments: wire.segments.slice(0, -1),
      })
    ).toThrow("expected 2");

    const gapped = wire.segments.map((segment) => segment.slice());
    new DataView(gapped[1]!.buffer).setBigUint64(8, 2n, true);
    expect(() =>
      validateForkReplayEventWire({ manifest: wire.manifest, segments: gapped })
    ).toThrow("out of order");

    const trailingWords = new Uint32Array([8, 13]);
    const trailing = encodeForkReplayEventSegment(trailingWords, 1, 2n);
    expect(() =>
      validateForkReplayEventWire({
        manifest: wire.manifest,
        segments: [...wire.segments, trailing],
      })
    ).toThrow("after its declared segment count 2");
  });

  it("requires every non-final page to be full", () => {
    const wire = twoPageWire();
    const segments = wire.segments.map((segment) => segment.slice());
    new DataView(segments[0]!.buffer).setUint32(
      16,
      FORK_REPLAY_EVENT_SEGMENT_CAPACITY - 1,
      true,
    );
    expect(() =>
      validateForkReplayEventWire({ manifest: wire.manifest, segments })
    ).toThrow(`expected ${FORK_REPLAY_EVENT_SEGMENT_CAPACITY}`);
  });

  it("requires the final page count and bounds to match the manifest", () => {
    const wire = twoPageWire();
    const segments = wire.segments.map((segment) => segment.slice());
    new DataView(segments[1]!.buffer).setUint32(16, 1, true);
    expect(() =>
      validateForkReplayEventWire({ manifest: wire.manifest, segments })
    ).toThrow("expected 2");

    const truncated = wire.segments.map((segment, index) =>
      index === 1 ? segment.subarray(0, segment.byteLength - 1) : segment
    );
    expect(() =>
      validateForkReplayEventWire({
        manifest: wire.manifest,
        segments: truncated,
      })
    ).toThrow("inconsistent bounds");
  });

  it("rejects manifest trailing bytes and nonzero reserved fields", () => {
    const wire = twoPageWire();
    const trailing = new Uint8Array(wire.manifest.byteLength + 1);
    trailing.set(wire.manifest);
    expect(() =>
      validateForkReplayEventWire({ manifest: trailing, segments: wire.segments })
    ).toThrow("inconsistent bounds");
    const reserved = wire.manifest.slice();
    new DataView(reserved.buffer).setUint32(20, 1, true);
    expect(() =>
      validateForkReplayEventWire({ manifest: reserved, segments: wire.segments })
    ).toThrow("reserved");
  });

  it("represents event totals beyond the old contiguous u32 boundary", () => {
    const eventCount = 0x1_0000_0001n;
    const capacity = BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY);
    const segmentCount = (eventCount + capacity - 1n) / capacity;
    const manifest = encodeForkReplayEventManifest(eventCount, segmentCount);
    const view = new DataView(manifest.buffer);
    expect(view.getBigUint64(24, true)).toBe(segmentCount);
    expect(view.getBigUint64(32, true))
      .toBe(eventCount);
  });

  it("rejects unavailable u64 segment totals without lossy number conversion", () => {
    const segmentCount = 0x1_0000_0000n;
    const eventCount =
      (segmentCount - 1n) * BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY) + 1n;
    const manifest = encodeForkReplayEventManifest(eventCount, segmentCount);
    expect(() =>
      validateForkReplayEventWire({ manifest, segments: [] })
    ).toThrow(`expected ${segmentCount}`);
  });

  it("rejects inexact numeric u64 inputs instead of rounding them", () => {
    expect(() =>
      encodeForkReplayEventManifest(
        BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY),
        Number.MAX_SAFE_INTEGER + 1,
      )
    ).toThrow("exact nonnegative integer");
    expect(() =>
      encodeForkReplayEventSegment(
        new Uint32Array([1, 2]),
        1,
        Number.MAX_SAFE_INTEGER + 1,
      )
    ).toThrow("exact nonnegative integer");
  });
});

describe("ForkResumeTable", () => {
  it("reconstructs slots from activation coordinates", () => {
    const first = wasmFunction();
    const second = wasmFunction();
    const table = new ForkResumeTable();
    table.registerActivation(4, [
      { functionOrdinal: 9, thunk: second },
      { functionOrdinal: 3, thunk: first },
    ]);
    const firstSlot = table.slotFor({ activationId: 4, functionOrdinal: 3 });
    expect(firstSlot).toBeGreaterThan(0);
    expect(table.table.get(firstSlot)).toBe(first);
    expect(table.slotFor(null)).toBe(0);
    expect(table.slotFor({ activationId: 4, functionOrdinal: 9 })).toBeGreaterThan(0);
  });

  it("clears unloaded activation roots and reuses private slots", () => {
    const table = new ForkResumeTable();
    table.registerActivation(1, [
      { functionOrdinal: 1, thunk: wasmFunction() },
    ]);
    const slot = table.slotFor({ activationId: 1, functionOrdinal: 1 });
    table.unregisterActivation(1);
    expect(table.table.get(slot)).toBeNull();
    table.registerActivation(2, [
      { functionOrdinal: 7, thunk: wasmFunction() },
    ]);
    expect(table.slotFor({ activationId: 2, functionOrdinal: 7 })).toBe(slot);
  });
});
