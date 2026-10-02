import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WasmModuleCache } from "../src/wasm-module-cache";

/** An empty module plus one custom section, so `tag` changes the bytes. */
function moduleBytes(tag: string, padding = 0): ArrayBuffer {
  const name = new TextEncoder().encode(tag);
  const payload = new Uint8Array(1 + name.length + padding);
  payload[0] = name.length;
  payload.set(name, 1);
  // Section payloads stay under 128 bytes so the size is a one-byte LEB128.
  expect(payload.length).toBeLessThan(128);
  const bytes = new Uint8Array(8 + 2 + payload.length);
  bytes.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, payload.length]);
  bytes.set(payload, 10);
  return bytes.buffer;
}

function copy(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}

const noRetention = { maxBytes: 0, idleMs: 0 };

function forceGc(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

describe("WasmModuleCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("compiles identical bytes once, whatever buffer carries them", async () => {
    const compile = vi.fn((bytes: ArrayBuffer) => WebAssembly.compile(bytes));
    const cache = new WasmModuleCache({ compile });
    const bytes = moduleBytes("a");

    const first = await cache.programModule(bytes);
    const second = await cache.programModule(copy(bytes));
    const third = await cache.programModule(copy(bytes));

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ compiles: 1, hits: 2, digests: 3 });
  });

  it("never reuses a module for different bytes", async () => {
    const cache = new WasmModuleCache();
    const a = await cache.programModule(moduleBytes("a"));
    const b = await cache.programModule(moduleBytes("b"));
    // Same length, one differing byte: the digest, not the size, decides.
    expect(moduleBytes("a").byteLength).toBe(moduleBytes("b").byteLength);
    expect(b).not.toBe(a);
    expect(cache.stats().compiles).toBe(2);
  });

  it("joins concurrent requests for the same bytes to one compilation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compile = vi.fn(async (bytes: ArrayBuffer) => {
      await gate;
      return WebAssembly.compile(bytes);
    });
    const cache = new WasmModuleCache({ compile });
    const bytes = moduleBytes("a");

    const requests = [
      cache.programModule(copy(bytes)),
      cache.programModule(copy(bytes)),
      cache.programModule(copy(bytes)),
    ];
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
    release();
    const [first, second, third] = await Promise.all(requests);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ compiles: 1, joins: 2 });
  });

  it("reports compile failures to every caller and never caches them", async () => {
    const cache = new WasmModuleCache();
    const invalid = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x7f])
      .buffer;

    await expect(Promise.all([
      cache.programModule(copy(invalid)),
      cache.programModule(copy(invalid)),
    ])).rejects.toBeInstanceOf(WebAssembly.CompileError);
    await expect(cache.programModule(copy(invalid)))
      .rejects.toBeInstanceOf(WebAssembly.CompileError);

    expect(cache.stats()).toMatchObject({
      compiles: 2,
      compileFailures: 2,
      joins: 1,
      liveEntries: 0,
    });
  });

  it("keys thread modules on the program bytes and patches once", async () => {
    const compile = vi.fn((bytes: ArrayBuffer) => WebAssembly.compile(bytes));
    const cache = new WasmModuleCache({ compile });
    const program = moduleBytes("program");
    const patch = vi.fn(() => moduleBytes("thread"));

    const programModule = await cache.programModule(program);
    const thread = await cache.threadModule(program, patch);
    const sameProgramOtherProcess = copy(program);
    const otherThread = await cache.threadModule(sameProgramOtherProcess, patch);

    expect(thread).not.toBe(programModule);
    expect(otherThread).toBe(thread);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(2);
    // The program's own buffer was hashed at launch and is not hashed again.
    expect(cache.stats().digests).toBe(2);
  });

  it("uses the program module when the thread patch leaves the bytes unchanged", async () => {
    const compile = vi.fn((bytes: ArrayBuffer) => WebAssembly.compile(bytes));
    const cache = new WasmModuleCache({ compile });
    const program = moduleBytes("no-start-section");

    const programModule = await cache.programModule(program);
    const thread = await cache.threadModule(program, (bytes) => bytes);

    expect(thread).toBe(programModule);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("bounds retention by bytes, keeps the most recently launched, and skips oversized modules", async () => {
    const small = moduleBytes("s");
    const cache = new WasmModuleCache({
      retention: { maxBytes: small.byteLength * 2, idleMs: 60_000 },
    });

    await cache.programModule(moduleBytes("a"));
    await cache.programModule(moduleBytes("b"));
    expect(cache.stats()).toMatchObject({ retainedEntries: 2 });
    // A third launch evicts the least recently launched one.
    await cache.programModule(moduleBytes("c"));
    expect(cache.stats()).toMatchObject({
      retainedEntries: 2,
      retainedBytes: small.byteLength * 2,
    });
    // A module larger than the whole bound is never retained.
    await cache.programModule(moduleBytes("big", 40));
    expect(cache.stats()).toMatchObject({ retainedEntries: 2 });
  });

  it("releases retained modules once their idle window passes", async () => {
    vi.useFakeTimers();
    const cache = new WasmModuleCache({
      retention: { maxBytes: 1 << 20, idleMs: 30_000 },
      now: () => Date.now(),
    });
    await cache.programModule(moduleBytes("a"));
    await vi.advanceTimersByTimeAsync(20_000);
    await cache.programModule(moduleBytes("b"));
    expect(cache.stats().retainedEntries).toBe(2);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(cache.stats().retainedEntries).toBe(1);
    // A launch renews the window for that module only.
    await cache.programModule(moduleBytes("b"));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(cache.stats().retainedEntries).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(cache.stats()).toMatchObject({ retainedEntries: 0, retainedBytes: 0 });
  });

  it("holds no module alive once its last user drops it", async () => {
    const gc = forceGc();
    // A plain counter: a vi.fn() would itself retain every returned module.
    let compiles = 0;
    const cache = new WasmModuleCache({
      compile: (bytes) => {
        compiles += 1;
        return WebAssembly.compile(bytes);
      },
      retention: noRetention,
    });
    const bytes = moduleBytes("a");

    let user: WebAssembly.Module | null = await cache.programModule(copy(bytes));
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    // A live user keeps the entry shareable.
    expect(await cache.programModule(copy(bytes))).toBe(user);
    expect(compiles).toBe(1);

    user = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    expect(cache.stats().liveEntries).toBe(0);
    await cache.programModule(copy(bytes));
    expect(compiles).toBe(2);
  });

  it("clear() drops every entry and retained module", async () => {
    const compile = vi.fn((bytes: ArrayBuffer) => WebAssembly.compile(bytes));
    const cache = new WasmModuleCache({ compile });
    const bytes = moduleBytes("a");
    const before = await cache.programModule(bytes);
    cache.clear();
    expect(cache.stats()).toMatchObject({ liveEntries: 0, retainedEntries: 0 });
    const after = await cache.programModule(copy(bytes));
    expect(after).not.toBe(before);
    expect(compile).toHaveBeenCalledTimes(2);
  });
});
