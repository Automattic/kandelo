import { describe, expect, it, vi } from "vitest";
import { ImageManifestMemoryScope, MAX_IMAGE_MANIFEST_BYTES } from "../src/vfs/image-manifest-memory";
import { decodeInspectionResourceLimits } from "../src/vfs/rootfs-inspection";
import { OverlayGenerationMetadata, OVERLAY_GENERATION_BASE_BYTES } from "../src/vfs/overlay-generation-metadata";
import { selectRootfsHostMetadataBytes } from "../src/runtime-memory-profile";
import { StorageMemoryBudget, StorageMetadataMap, STORAGE_ENTRY_BYTES, storageEntryBytes, validateStorageMemoryUsage } from "../src/vfs/storage-memory-budget";
import { selectImageBinding, validateImageBindingState, UnprovenImageFreshnessError, type ImageBindingIdentity } from "../src/vfs/image-binding-state";
import { nativeOverlayControlCall } from "./fixtures/native-overlay-activation";
import { ERRNO } from "../src/generated/abi";

function bindingIdentity(generation: number, label: string, initialized = true, version = 6): ImageBindingIdentity {
  return { generation, digest: label, content: label, initialized, version };
}

describe("persistent active image binding selection", () => {
  const source = bindingIdentity(3, "source");
  const target = bindingIdentity(4, "target");

  it("does not make a prepared replacement authoritative before primary commit", async () => {
    const prepared = { phase: "prepared" as const, source, target };
    expect(await selectImageBinding(nativeOverlayControlCall, source, prepared)).toEqual({ choice: "source", repair: true });
    expect(await selectImageBinding(nativeOverlayControlCall, null, prepared)).toEqual({ choice: "source", repair: true });
    expect(await selectImageBinding(nativeOverlayControlCall, target, prepared)).toEqual({ choice: "target", repair: true });
    await expect(selectImageBinding(nativeOverlayControlCall, bindingIdentity(3, "different source"), prepared)).rejects.toThrow(UnprovenImageFreshnessError);
  });

  it("uses the active current pair rather than an older intact primary", async () => {
    const active = { phase: "active" as const, target };
    expect(await selectImageBinding(nativeOverlayControlCall, source, active)).toEqual({ choice: "target", repair: true });
    expect(await selectImageBinding(nativeOverlayControlCall, null, active)).toEqual({ choice: "target", repair: true });
    expect(await selectImageBinding(nativeOverlayControlCall, target, active)).toEqual({ choice: "target", repair: false });
    await expect(selectImageBinding(nativeOverlayControlCall, bindingIdentity(4, "ambiguous target"), active)).rejects.toThrow(UnprovenImageFreshnessError);
  });

  it("repairs a missing binding and does not regress a newer committed primary", async () => {
    const latest = bindingIdentity(5, "latest");
    expect(await selectImageBinding(nativeOverlayControlCall, null, null)).toEqual({ choice: "empty", repair: false });
    expect(await selectImageBinding(nativeOverlayControlCall, latest, null)).toEqual({ choice: "primary", repair: true });
    for (const binding of [{ phase: "active" as const, target }, { phase: "prepared" as const, source, target }]) {
      expect(await selectImageBinding(nativeOverlayControlCall, latest, binding)).toEqual({ choice: "primary", repair: true });
    }
  });

  it("admits same-pair initialization without confusing it with a new image", async () => {
    const pending = bindingIdentity(0, "uninitialized", false);
    const ready = { ...bindingIdentity(0, "initialized"), content: pending.content };
    await validateImageBindingState(nativeOverlayControlCall, { phase: "prepared", source: pending, target: ready });
    expect(await selectImageBinding(nativeOverlayControlCall, pending, { phase: "active", target: ready })).toEqual({ choice: "target", repair: true });
    expect(await selectImageBinding(nativeOverlayControlCall, ready, { phase: "active", target: pending })).toEqual({ choice: "primary", repair: true });
  });

  it.each([1, 2, 3, 4, 5, 7])("refuses unsupported envelope version %s in every selection position", async version => {
    const unsupported = { ...source, version };
    await expect(selectImageBinding(nativeOverlayControlCall, unsupported, null)).rejects.toThrow(UnprovenImageFreshnessError);
    await expect(selectImageBinding(nativeOverlayControlCall, unsupported, { phase: "active", target })).rejects.toThrow(UnprovenImageFreshnessError);
    await expect(selectImageBinding(nativeOverlayControlCall, null, { phase: "prepared", source: unsupported, target })).rejects.toThrow(UnprovenImageFreshnessError);
    await expect(selectImageBinding(nativeOverlayControlCall, null, { phase: "active", target: unsupported })).rejects.toThrow(UnprovenImageFreshnessError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses invalid generation %s", async generation => {
    await expect(selectImageBinding(nativeOverlayControlCall, source, { phase: "active", target: { ...target, generation } })).rejects.toThrow(UnprovenImageFreshnessError);
  });

  it("refuses skipped generations, deinitialization and cross-image same-generation preparations", async () => {
    for (const invalid of [
      { phase: "prepared" as const, source, target: bindingIdentity(5, "skipped") },
      { phase: "prepared" as const, source: { ...source, initialized: false }, target },
      { phase: "prepared" as const, source, target: { ...source, initialized: false } },
      { phase: "prepared" as const, source, target: bindingIdentity(source.generation, "different") },
      { phase: "active" as const, target: { ...target, version: 4 } },
    ]) await expect(validateImageBindingState(nativeOverlayControlCall, invalid)).rejects.toThrow(UnprovenImageFreshnessError);
  });

  it("does not turn protocol or resource failures into image damage or fallback", async () => {
    for (const errno of [ERRNO.EINVAL, ERRNO.ENOSYS, ERRNO.ENOMEM, ERRNO.ENOSPC]) {
      const call = vi.fn(() => -errno);
      await expect(selectImageBinding(call, source, { phase: "active", target })).rejects.toMatchObject({ errno });
      await expect(validateImageBindingState(call, { phase: "active", target })).rejects.not.toBeInstanceOf(UnprovenImageFreshnessError);
      for (const [operation, packet] of call.mock.calls as unknown as Array<[number, Uint8Array]>) {
        expect([19, 20]).toContain(operation);
        expect(packet.length).toBe(64);
      }
    }
    const failure = new Error("worker refused");
    await expect(selectImageBinding(async () => { throw failure; }, source, null)).rejects.toBe(failure);
  });

  it("refuses malformed native replies without selecting any image", async () => {
    for (const reply of [0, 1, new Uint8Array(7), new Uint8Array(9), Uint8Array.of(4, 0, 0, 0, 0, 0, 0, 0), Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0)]) {
      await expect(selectImageBinding(() => reply, source, null)).rejects.not.toBeInstanceOf(UnprovenImageFreshnessError);
    }
    await expect(validateImageBindingState(() => new Uint8Array(8), { phase: "active", target })).rejects.toThrow(/geometry/);
  });

  it("does not coerce nonnumeric identity fields into valid wire numbers", async () => {
    for (const value of [null, false, "6", "0", {}, 6n]) {
      for (const field of ["version", "generation"] as const) {
        const invalid = { ...target, [field]: value } as unknown as ImageBindingIdentity;
        await expect(selectImageBinding(nativeOverlayControlCall, source, { phase: "active", target: invalid })).rejects.toThrow(UnprovenImageFreshnessError);
      }
    }
  });
});

function resources(entries: [string, bigint][]): Uint8Array {
  const records = entries.map(([name, limit]) => {
    const text = new TextEncoder().encode(name);
    const bytes = new Uint8Array(12 + text.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, text.length, true);
    bytes.set(text, 4);
    view.setBigUint64(4 + text.length, limit, true);
    return bytes;
  });
  const bytes = new Uint8Array(records.reduce((sum, record) => sum + record.length, 0));
  let offset = 0;
  for (const record of records) { bytes.set(record, offset); offset += record.length; }
  return bytes;
}

describe("host storage metadata ownership", () => {
  it("retains manifest parse overlap and reclaims the exact operation owner", () => {
    const budget = new StorageMemoryBudget(65536);
    const first = new ImageManifestMemoryScope(budget);
    const second = new ImageManifestMemoryScope(budget);
    first.retain(2000);
    second.retain(2000);
    const full = budget.used;
    expect(() => first.retain(1500)).toThrow(expect.objectContaining({ code: "ENOMEM" }));
    expect(budget.used).toBe(full);
    second.dispose();
    first.retain(1500);
    first.dispose();
    first.dispose();
    expect(budget.used).toBe(0);
    expect(() => first.encode({})).toThrow("disposed");
  });

  it("rejects oversized serialized input before parsing and permits a smaller retry", () => {
    const budget = new StorageMemoryBudget(65536);
    const scope = new ImageManifestMemoryScope(budget);
    const baseline = budget.used;
    for (const size of [-1, NaN, MAX_IMAGE_MANIFEST_BYTES + 1, 65536]) {
      expect(() => scope.retain(size)).toThrow(expect.objectContaining({ code: "ENOMEM" }));
      expect(budget.used).toBe(baseline);
    }
    scope.retain(100);
    scope.dispose();
    expect(budget.used).toBe(0);
  });

  it("admits JSON output before stringify and rolls back a refused encode", () => {
    const budget = new StorageMemoryBudget(32768);
    const scope = new ImageManifestMemoryScope(budget);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const baseline = budget.used;
      expect(() => scope.encode({ large: "x".repeat(65536) })).toThrow(expect.objectContaining({ code: "ENOMEM" }));
      expect(stringify).not.toHaveBeenCalled();
      expect(budget.used).toBe(baseline);
      expect(scope.encode({ small: true })).toBe('{"small":true}');
      expect(stringify).toHaveBeenCalledOnce();
    } finally { stringify.mockRestore(); scope.dispose(); }
    expect(budget.used).toBe(0);
  });

  it("models escaped Unicode, sparse arrays and repeated noncyclic values", () => {
    const budget = new StorageMemoryBudget(65536);
    const scope = new ImageManifestMemoryScope(budget);
    const repeated = { text: "\"\\\n\u0001é漢😀\ud800" };
    const input = { left: repeated, right: repeated, absent: undefined, array: [undefined, NaN, Infinity, false] };
    const encoded = JSON.stringify(input);
    const baseline = budget.used;
    expect(scope.encode(input)).toBe(encoded);
    expect(budget.used - baseline).toBe(STORAGE_ENTRY_BYTES + new TextEncoder().encode(encoded).byteLength * 12);
    scope.dispose();
    expect(budget.used).toBe(0);
  });

  it("refuses accessors, conversion hooks, cycles and excessive depth without consuming credit", () => {
    const budget = new StorageMemoryBudget(65536);
    const scope = new ImageManifestMemoryScope(budget);
    const getter = vi.fn(() => "surprise");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const conversion = vi.fn(() => "surprise");
    const array = Object.assign([], { toJSON: conversion });
    const cycle: { next?: unknown } = {};
    cycle.next = cycle;
    let nested: unknown = {};
    for (let depth = 0; depth < 65; depth++) nested = { next: nested };
    const baseline = budget.used;
    for (const invalid of [accessor, array, cycle, nested, new Date(), undefined]) {
      expect(() => scope.encode(invalid)).toThrow(TypeError);
      expect(budget.used).toBe(baseline);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(conversion).not.toHaveBeenCalled();
    scope.dispose();
    expect(budget.used).toBe(0);
  });

  it("serializes generation owners, rolls back failed discovery and retains published metadata until disposal", () => {
    const budget = new StorageMemoryBudget(OVERLAY_GENERATION_BASE_BYTES + 16 * STORAGE_ENTRY_BYTES + 4);
    const metadata = new OverlayGenerationMetadata(budget);
    const first = metadata.enter();
    first.retainSlot("g0");
    expect(budget.used).toBe(budget.limit);
    first.retainSlot("g0");
    expect(() => first.retainSlot("g1")).toThrow(expect.objectContaining({ code: "ENOMEM" }));
    expect(() => metadata.enter()).toThrow(expect.objectContaining({ code: "EBUSY" }));
    expect(() => metadata.dispose()).toThrow("active owner");
    first.finish(false);
    expect(budget.used).toBe(OVERLAY_GENERATION_BASE_BYTES);
    expect(() => first.retainSlot("g0")).toThrow("released");
    const next = metadata.enter();
    next.retainSlot("g0");
    next.finish(true);
    first.finish(false);
    expect(budget.used).toBe(budget.limit);
    metadata.dispose();
    metadata.dispose();
    expect(budget.used).toBe(0);
    expect(() => metadata.enter()).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid limit %s", limit => {
    expect(() => new StorageMemoryBudget(limit)).toThrow(RangeError);
  });

  it("scales the shared host allowance independently of logical image capacity", () => {
    expect(selectRootfsHostMetadataBytes(1024)).toBe(8 * 1024 * 1024);
    expect(selectRootfsHostMetadataBytes()).toBe(16 * 1024 * 1024);
  });

  it("retains prior credits after refusal and permits retry after exact-owner release", () => {
    const budget = new StorageMemoryBudget(16);
    const first = budget.reserve(12);
    expect(() => budget.reserve(5)).toThrow(expect.objectContaining({ code: "ENOMEM", errno: 12 }));
    expect(budget.used).toBe(12);
    expect(budget.peak).toBe(12);
    expect(() => first.resize(17)).toThrow();
    expect(first.size).toBe(12);
    const second = budget.reserve(4);
    first.resize(8);
    second.resize(8);
    expect(budget.used).toBe(16);
    expect(budget.peak).toBe(16);
    first.release();
    first.release();
    expect(budget.used).toBe(8);
    expect(() => first.resize(1)).toThrow("released");
    second.release();
    expect(budget.used).toBe(0);
    expect(budget.peak).toBe(16);
    expect(Object.isFrozen(second)).toBe(true);
    expect(validateStorageMemoryUsage(budget.snapshot())).toEqual({ used: 0, peak: 16, limit: 16 });
  });

  it("rejects malformed or contradictory storage-memory observations", () => {
    for (const value of [null, 1, {}, { used: 0, peak: 1, limit: 0 }, { used: 2, peak: 1, limit: 3 },
      { used: 0, peak: 4, limit: 3 }, { used: -1, peak: 1, limit: 3 }, { used: 0, peak: NaN, limit: 3 }]) {
      expect(() => validateStorageMemoryUsage(value)).toThrow("invalid storage memory usage");
    }
  });

  it("admits map keys before publication and releases deleted, cleared and disposed owners", () => {
    const budget = new StorageMemoryBudget(STORAGE_ENTRY_BYTES + storageEntryBytes("uri"));
    const table = new StorageMetadataMap<string, number>(budget);
    table.set("uri", 1);
    const full = budget.used;
    table.set("uri", 2);
    expect(budget.used).toBe(full);
    expect(() => table.set("next", 3)).toThrow(expect.objectContaining({ code: "ENOMEM" }));
    expect([...table]).toEqual([["uri", 2]]);
    expect(budget.used).toBe(full);
    expect(table.delete("absent")).toBe(false);
    expect(table.delete("uri")).toBe(true);
    expect(budget.used).toBe(STORAGE_ENTRY_BYTES);
    table.set("uri", 4);
    table.clear();
    expect(budget.used).toBe(STORAGE_ENTRY_BYTES);
    table.dispose();
    table.dispose();
    expect(budget.used).toBe(0);
    expect(() => table.set("uri", 5)).toThrow("disposed");
  });

  it("rolls back credit when physical map publication throws", () => {
    const budget = new StorageMemoryBudget(8192);
    const table = new StorageMetadataMap<string, number>(budget);
    const original = Map.prototype.set;
    let failure: unknown;
    try {
      Map.prototype.set = function (key, value) {
        if (this === table) throw new RangeError("injected allocation refusal");
        return original.call(this, key, value);
      };
      try { table.set("uri", 1); } catch (error) { failure = error; }
    } finally { Map.prototype.set = original; }
    expect(failure).toBeInstanceOf(RangeError);
    expect(table.size).toBe(0);
    expect(budget.used).toBe(STORAGE_ENTRY_BYTES);
    table.set("uri", 1);
    table.dispose();
    expect(budget.used).toBe(0);
  });

  it("retains decoded resource ownership but releases temporary input conversion", () => {
    const budget = new StorageMemoryBudget(8192);
    const entries = [["asset/π", 42n], ["asset/second", 64n]] satisfies [string, bigint][];
    const table = decodeInspectionResourceLimits(resources(entries), budget);
    expect([...table]).toEqual(entries.map(([name, size]) => [name, Number(size)]));
    expect(budget.used).toBe(STORAGE_ENTRY_BYTES + storageEntryBytes("asset/π") + storageEntryBytes("asset/second"));
    table.dispose();
    expect(budget.used).toBe(0);
  });

  it("refuses oversized resource strings before decoding and can retry after reclamation", () => {
    const budget = new StorageMemoryBudget(8192);
    const occupied = budget.reserve(7000);
    expect(() => decodeInspectionResourceLimits(resources([["asset", 1n]]), budget)).toThrow(expect.objectContaining({ code: "ENOMEM" }));
    expect(budget.used).toBe(7000);
    occupied.release();
    expect(() => decodeInspectionResourceLimits(resources([["x".repeat(8192), 1n]]), budget))
      .toThrow(expect.objectContaining({ code: "ENOMEM" }));
    expect(budget.used).toBe(0);
    const table = decodeInspectionResourceLimits(resources([["asset", 1n]]), budget);
    table.dispose();
    expect(budget.used).toBe(0);
  });

  it.each(["truncated", "overflow"])("reclaims all partially decoded owners after %s input", fault => {
    const budget = new StorageMemoryBudget(8192);
    const input = resources([["first", 1n], ["second", fault === "overflow" ? 2n ** 63n : 2n]]);
    expect(() => decodeInspectionResourceLimits(fault === "truncated" ? input.subarray(0, input.length - 1) : input, budget)).toThrow();
    expect(budget.used).toBe(0);
  });
});
