import { describe, expect, it } from "vitest";

import { ExecutableModuleCache } from "../src/executable-module-cache";

const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function bytes(...suffix: number[]): ArrayBuffer {
  const value = new Uint8Array(EMPTY_WASM.byteLength + suffix.length);
  value.set(EMPTY_WASM);
  value.set(suffix, EMPTY_WASM.byteLength);
  return value.buffer;
}

describe("ExecutableModuleCache", () => {
  it("returns a module only for byte-identical executable contents", () => {
    const cache = new ExecutableModuleCache<string>({
      maxEntries: 2,
      maxAliases: 32,
      maxRetainedBytes: 1024,
    });
    const original = bytes(1, 2, 3, 4, 5);
    const module = new WebAssembly.Module(EMPTY_WASM);
    cache.set("/bin/tool", original, module, "metadata");

    expect(cache.get("/bin/tool", original.slice(0))).toEqual({
      module,
      metadata: "metadata",
    });
    expect(cache.get("/bin/tool", bytes(1, 2, 3, 4, 6))).toBeUndefined();
    expect(cache.stats()).toMatchObject({
      hits: 1,
      misses: 1,
      contentMismatches: 1,
      retainedEntries: 0,
      retainedAliases: 0,
      retainedBytes: 0,
    });
  });

  it("shares exact executable content reached through different paths", () => {
    const cache = new ExecutableModuleCache<string>({
      maxEntries: 1,
      maxAliases: 32,
      maxRetainedBytes: 1024,
    });
    const original = bytes(1, 2, 3);
    const module = new WebAssembly.Module(EMPTY_WASM);
    cache.set("/bin/tool", original, module, "content metadata");

    expect(cache.get("/usr/bin/tool", original.slice(0))).toEqual({
      module,
      metadata: "content metadata",
    });
    expect(cache.stats()).toMatchObject({
      hits: 1,
      contentAliasHits: 1,
      retainedEntries: 1,
      retainedAliases: 2,
      retainedBytes: original.byteLength,
    });
  });

  it("does not confuse equal-size executables with different content", () => {
    const cache = new ExecutableModuleCache<null>({
      maxEntries: 2,
      maxAliases: 32,
      maxRetainedBytes: 1024,
    });
    cache.set(
      "/bin/first",
      bytes(1),
      new WebAssembly.Module(EMPTY_WASM),
      null,
    );

    expect(cache.get("/bin/second", bytes(2))).toBeUndefined();
    expect(cache.stats()).toMatchObject({
      contentAliasHits: 0,
      misses: 1,
      retainedEntries: 1,
      retainedAliases: 1,
    });
  });

  it("keeps shared content when one alias changes", () => {
    const cache = new ExecutableModuleCache<null>({
      maxEntries: 2,
      maxAliases: 32,
      maxRetainedBytes: 1024,
    });
    const original = bytes(1);
    const module = new WebAssembly.Module(EMPTY_WASM);
    cache.set("/bin/tool", original, module, null);
    expect(cache.get("/usr/bin/tool", original)).toBeDefined();

    expect(cache.get("/bin/tool", bytes(2))).toBeUndefined();
    expect(cache.get("/usr/bin/tool", original)).toEqual({ module, metadata: null });
    expect(cache.stats()).toMatchObject({
      contentMismatches: 1,
      retainedEntries: 1,
      retainedAliases: 1,
    });
  });

  it("bounds retained pathname aliases independently of content", () => {
    const cache = new ExecutableModuleCache<null>({
      maxEntries: 2,
      maxAliases: 2,
      maxRetainedBytes: 1024,
    });
    const original = bytes(1);
    const module = new WebAssembly.Module(EMPTY_WASM);
    cache.set("/bin/tool", original, module, null);
    expect(cache.get("/usr/bin/tool", original)).toBeDefined();
    cache.set("/bin/other", bytes(2), module, null);

    expect(cache.stats()).toMatchObject({
      aliasEvictions: 1,
      retainedEntries: 2,
      retainedAliases: 2,
    });
    expect(cache.get("/bin/tool", original)).toEqual({ module, metadata: null });
    expect(cache.stats()).toMatchObject({
      aliasEvictions: 2,
      retainedEntries: 2,
      retainedAliases: 2,
    });
  });

  it("owns comparison bytes instead of trusting a caller-owned buffer", () => {
    const cache = new ExecutableModuleCache<null>({
      maxEntries: 1,
      maxAliases: 32,
      maxRetainedBytes: 1024,
    });
    const original = bytes(7);
    const module = new WebAssembly.Module(EMPTY_WASM);
    cache.set("/bin/tool", original, module, null);
    new Uint8Array(original)[EMPTY_WASM.byteLength] = 8;

    expect(cache.get("/bin/tool", bytes(7))).toEqual({ module, metadata: null });
  });

  it("bounds retained byte copies with least-recently-used eviction", () => {
    const cache = new ExecutableModuleCache<number>({
      maxEntries: 2,
      maxAliases: 32,
      maxRetainedBytes: 18,
    });
    const module = new WebAssembly.Module(EMPTY_WASM);
    const first = bytes(1);
    const second = bytes(2);
    const third = bytes(3);
    cache.set("first", first, module, 1);
    cache.set("second", second, module, 2);
    expect(cache.get("first", first)).toBeDefined();
    cache.set("third", third, module, 3);

    expect(cache.get("second", second)).toBeUndefined();
    expect(cache.get("first", first)).toBeDefined();
    expect(cache.get("third", third)).toBeDefined();
    expect(cache.stats()).toMatchObject({
      evictions: 1,
      retainedEntries: 2,
      retainedBytes: 18,
    });
  });

  it("does not retain a single executable larger than its byte budget", () => {
    const cache = new ExecutableModuleCache<null>({
      maxEntries: 1,
      maxAliases: 32,
      maxRetainedBytes: 8,
    });
    const oversized = bytes(1);
    cache.set("large", oversized, new WebAssembly.Module(EMPTY_WASM), null);

    expect(cache.get("large", oversized)).toBeUndefined();
    expect(cache.stats().retainedBytes).toBe(0);
  });
});
