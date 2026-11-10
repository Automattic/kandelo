import { describe, expect, it, vi } from "vitest";
import { GbmBoRegistry } from "../src/dri/registry";

const SIZE = 4096;
function harness() {
  const memories = new Map([100, 200].map(pid => [pid,
    new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true })]));
  const epochs = new Map([[100, 0n], [200, 0n]]);
  const running = new Set<number>();
  const changed = (pid: number) => epochs.set(pid, epochs.get(pid)! + 1n);
  const registry = new GbmBoRegistry({
    getProcessMemory: pid => memories.get(pid),
    getProcessQuiescentEpoch: pid => running.has(pid) ? -1n : epochs.get(pid)!,
    onProcessMemoryChanged: changed,
  });
  registry.create({ pid: 100, bo_id: 1, size: SIZE, w: 32, h: 32, stride: 128 });
  for (const [pid, memory] of memories) {
    expect(registry.bind(pid, 1, 0, SIZE)).toBe(0);
    expect(registry.primeBindFromSab(pid, 1, memory)).toBe(true);
  }
  const bytes = (pid: number) => new Uint8Array(memories.get(pid)!.buffer, 0, SIZE);
  return { registry, memories, epochs, running, changed, bytes };
}

/** Count the actual comparison-view constructions, rather than calls to a
 * publication method that can legitimately return without examining bytes. */
function comparisonViews(work: () => void): number {
  const Native = Uint32Array;
  const ctor = vi.spyOn(globalThis, "Uint32Array").mockImplementation(function (
    buffer: any, offset?: number, length?: number,
  ) { return new Native(buffer, offset, length); } as any);
  try { work(); return ctor.mock.calls.length; }
  finally { ctor.mockRestore(); }
}

describe("GBM coherence without redundant full-buffer work", () => {
  it("reuses parked comparisons and performs no copies for current readers", () => {
    const h = harness();
    expect(comparisonViews(() => h.registry.syncToSab(1))).toBeGreaterThan(0);
    expect(comparisonViews(() => h.registry.syncToSab(1))).toBe(0);
    const copies = vi.spyOn(Uint8Array.prototype, "set");
    try {
      h.registry.syncImportsForPid(200, h.memories.get(200)!);
      expect(copies).not.toHaveBeenCalled();
    } finally { copies.mockRestore(); }
  });

  it("compares active writers every time and sees stores after a resume", () => {
    const h = harness();
    h.registry.syncToSab(1);
    h.running.add(100);
    h.bytes(100)[17] = 91;
    expect(comparisonViews(() => h.registry.syncToSab(1))).toBeGreaterThan(0);
    h.bytes(100)[18] = 73;
    h.registry.syncImportsForPid(200, h.memories.get(200)!);
    expect([...h.bytes(200).slice(17, 19)]).toEqual([91, 73]);
    h.running.delete(100); h.changed(100);
    h.bytes(100)[19] = 55;
    h.registry.syncImportsForPid(200, h.memories.get(200)!);
    expect(h.bytes(200)[19]).toBe(55);
  });

  it("does not treat a checked prefix as a checked whole mapping", () => {
    const h = harness();
    h.changed(100);
    h.bytes(100)[3000] = 91;
    h.registry.syncToSab(1, 64);
    expect(h.registry.readPixelView(1)![3000]).toBe(0);
    h.registry.syncToSab(1);
    expect(h.registry.readPixelView(1)![3000]).toBe(91);
  });

  it("retains writes made by a reader during an import for its next publication", () => {
    const h = harness();
    h.running.add(200); h.changed(100);
    h.bytes(100)[17] = 91;
    const set = Uint8Array.prototype.set;
    let injected = false;
    const copy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
      this: Uint8Array, source: ArrayLike<number>, offset = 0,
    ) {
      set.call(this, source, offset);
      if (this.buffer === h.memories.get(200)!.buffer && !injected) {
        injected = true;
        h.bytes(200)[17] = 92;
        h.bytes(200)[10] = 73;
      }
    });
    try { h.registry.syncImportsForPid(200, h.memories.get(200)!); }
    finally { copy.mockRestore(); }
    expect(injected).toBe(true);
    h.registry.syncToSab(1);
    expect(h.registry.readPixelView(1)![17]).toBe(92);
    expect(h.registry.readPixelView(1)![10]).toBe(73);
  });

  it("invalidates host-write epochs and still observes unrestricted canonical views", () => {
    const h = harness();
    const before = h.epochs.get(200)!;
    const pixels = new Uint8Array(SIZE); pixels[29] = 71;
    expect(h.registry.publishDevicePixels(1, pixels)).toBe(true);
    expect(h.epochs.get(200)!).toBeGreaterThan(before);
    expect(h.bytes(200)[29]).toBe(71);
    h.registry.syncToSab(1);
    const escaped = h.registry.pixelView(1)!;
    escaped[29] = 72;
    h.registry.syncImportsForPid(200, h.memories.get(200)!);
    expect(h.bytes(200)[29]).toBe(72);
    escaped[29] = 73;
    h.registry.syncImportsForPid(200, h.memories.get(200)!);
    expect(h.bytes(200)[29]).toBe(73);
  });

  it("retains a retiring writer's revision across staged mapping replacement", () => {
    const h = harness();
    h.changed(100);
    h.bytes(100)[17] = 91;
    expect(h.registry.bind(100, 1, 0, SIZE)).toBe(0);
    expect(h.registry.writeCount(1)).toBeGreaterThan(0);
    h.registry.syncImportsForPid(200, h.memories.get(200)!);
    expect(h.bytes(200)[17]).toBe(91);
  });

  it("drops old comparison proofs when the epoch authority changes", () => {
    const h = harness();
    h.registry.syncToSab(1);
    h.registry.setProcessMemoryCoherence(() => 1n, undefined);
    h.bytes(100)[17] = 91;
    h.registry.syncToSab(1);
    expect(h.registry.readPixelView(1)![17]).toBe(91);
  });
});
