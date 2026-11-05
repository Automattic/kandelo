import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredByteSpool, MAX_DEFERRED_IO_BYTES, type DeferredByteStorage } from "../src/vfs/deferred-byte-spool";
import { openNodeDeferredByteStorage } from "../src/vfs/node-deferred-byte-storage";
import { openOpfsDeferredByteStorage } from "../src/vfs/opfs-deferred-byte-storage";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";
import { StorageMemoryBudget } from "../src/vfs/storage-memory-budget";
import { configureRootfsOverlayFromImage, readNamespaceFileRangeWithRetry, readRootfsFileWithRetry } from "../src/process-lifecycle";
import { readPreparedExecTarget } from "../src/exec-target";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function memoryStorage(): DeferredByteStorage & { bytes: Uint8Array; close: ReturnType<typeof vi.fn> } {
  const bytes = new Uint8Array(256 * 1024);
  return {
    bytes,
    readAt: (offset, destination) => {
      const length = Math.min(3, destination.byteLength);
      destination.set(bytes.subarray(offset, offset + length));
      return length;
    },
    writeAt: (offset, source) => {
      const length = Math.min(3, source.byteLength);
      bytes.set(source.subarray(0, length), offset);
      return length;
    },
    close: vi.fn(),
  };
}

describe("positioned deferred byte staging", () => {
  it("refuses metadata before acquiring host storage", async () => {
    const budget = new StorageMemoryBudget(512);
    const acquire = vi.fn(memoryStorage);
    await expect(DeferredByteSpool.open(acquire, budget)).rejects.toMatchObject({ code: "ENOMEM" });
    expect(acquire).not.toHaveBeenCalled();
    expect(budget.used).toBe(0);
  });

  it("releases prepared metadata after failed storage acquisition", async () => {
    const budget = new StorageMemoryBudget(8192);
    await expect(DeferredByteSpool.open(async () => { throw new Error("open refused"); }, budget)).rejects.toThrow("open refused");
    expect(budget.used).toBe(0);
    const spool = await DeferredByteSpool.open(memoryStorage, budget);
    await spool.close();
    expect(budget.used).toBe(0);
  });

  it("bounds queued requests before retaining their callbacks and preserves completed sources during cancellation", async () => {
    const budget = new StorageMemoryBudget(8192);
    const storage = memoryStorage();
    const spool = await DeferredByteSpool.open(() => storage, budget);
    const source = await spool.fetch(async () => new Response(new Uint8Array([7])), "ready", 1);
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const active = spool.fetch(async () => { begin(); return new Promise<Response>(() => {}); }, "active", 1);
    const rejectActive = expect(active).rejects.toBeDefined();
    await started;
    const queued = spool.fetch(async () => new Response(new Uint8Array([8])), "queued", 1);
    const rejectQueued = expect(queued).rejects.toBeDefined();
    const refused = vi.fn(async () => new Response(new Uint8Array([9])));
    await expect(spool.fetch(refused, "refused", 1)).rejects.toMatchObject({ code: "ENOMEM" });
    expect(refused).not.toHaveBeenCalled();
    spool.cancelTransfers();
    const bytes = new Uint8Array(1);
    expect(source.readAt(0, bytes)).toBe(1);
    expect(bytes[0]).toBe(7);
    await Promise.all([rejectActive, rejectQueued]);
    expect(storage.close).not.toHaveBeenCalled();
    await spool.close();
    expect(budget.used).toBe(0);
    expect(() => source.readAt(0, bytes)).toThrow();
  });
  it("times out ignored fetch cancellation, advances the queue, and discards a late response", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writes = vi.fn(storage.writeAt);
    const spool = new DeferredByteSpool({ ...storage, writeAt: writes }, 100);
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let finish!: (response: Response) => void;
    let failure: unknown;
    let healthy: Awaited<ReturnType<DeferredByteSpool["fetch"]>> | undefined;
    let healthyFailure: unknown;
    const first = spool.fetch(async () => {
      begin();
      return new Promise<Response>(resolve => { finish = resolve; });
    }, "stalled", 8).catch(error => { failure = error; });
    const second = spool.fetch(async () => new Response(new Uint8Array(8).fill(7)), "healthy", 8)
      .then(source => { healthy = source; }, error => { healthyFailure = error; });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toMatchObject({ name: "TimeoutError", code: "ETIMEDOUT" });
      expect(healthy?.length).toBe(8);
      expect(healthyFailure).toBeUndefined();
      await Promise.all([first, second]);
      const before = writes.mock.calls.length;
      let cancelled!: () => void;
      const discarded = new Promise<void>(resolve => { cancelled = resolve; });
      finish(new Response(new ReadableStream({ cancel: cancelled })));
      await discarded;
      expect(writes).toHaveBeenCalledTimes(before);
      const target = new Uint8Array(8);
      expect(healthy!.readAt(0, target)).toBe(8);
      expect(target).toEqual(new Uint8Array(8).fill(7));
    } finally {
      await spool.close();
    }
  });

  it.each(["body", "HTTP error cleanup"])("times out stalled %s even when stream cancellation never settles", async kind => {
    vi.useFakeTimers();
    const spool = new DeferredByteSpool(memoryStorage(), 100);
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let failure: unknown;
    const stalled = spool.fetch(async () => new Response(new ReadableStream({
      pull() { begin(); },
      cancel,
    }), { status: kind === "body" ? 200 : 503 }), "stalled", 1).catch(error => { failure = error; });
    let completed = false;
    let nextFailure: unknown;
    const next = spool.fetch(async () => new Response(new Uint8Array([9])), "next", 1)
      .then(() => { completed = true; }, error => { nextFailure = error; });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toMatchObject({ name: "TimeoutError", code: "ETIMEDOUT" });
      expect(completed).toBe(true);
      expect(nextFailure).toBeUndefined();
      await Promise.all([stalled, next]);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      await spool.close();
    }
  });

  it("renews the inactivity deadline only for received bytes, not total download duration", async () => {
    vi.useFakeTimers();
    const spool = new DeferredByteSpool(memoryStorage(), 100);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let progressed: (() => void) | undefined;
    const result = spool.fetch(async () => new Response(new ReadableStream({
      start(value) { controller = value; begin(); },
    })), "slow", 4, () => progressed?.());
    try {
      await started;
      for (const value of [1, 2, 3, 4]) {
        const observed = new Promise<void>(resolve => { progressed = resolve; });
        controller.enqueue(new Uint8Array([value]));
        await observed;
        await vi.advanceTimersByTimeAsync(80);
      }
      controller.close();
      const source = await result;
      const target = new Uint8Array(4);
      expect(source.readAt(0, target)).toBe(4);
      expect([...target]).toEqual([1, 2, 3, 4]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await spool.close();
    }
  });

  it.each(["interval", "eager"])("does not let %s empty chunks keep a dead transfer alive", async kind => {
    vi.useFakeTimers();
    const spool = new DeferredByteSpool(memoryStorage(), 100);
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let timer: ReturnType<typeof setInterval> | undefined;
    let failure: unknown;
    const stalled = spool.fetch(async () => new Response(new ReadableStream({
      start(controller) {
        if (kind === "interval") timer = setInterval(() => controller.enqueue(new Uint8Array()), 10);
        begin();
      },
      pull(controller) { if (kind === "eager") controller.enqueue(new Uint8Array()); },
      cancel() { clearInterval(timer); },
    })), "empty", 1).catch(error => { failure = error; });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toMatchObject({ name: "TimeoutError", code: "ETIMEDOUT" });
      await stalled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clearInterval(timer!);
      await spool.close();
    }
  });

  it("closes active and queued ignored fetches promptly and rejects new work after close", async () => {
    const storage = memoryStorage();
    const spool = new DeferredByteSpool(storage);
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const blocked = spool.fetch(async () => { begin(); return new Promise<Response>(() => {}); }, "stuck", 1);
    const later = vi.fn(async () => new Response(new Uint8Array([2])));
    const queued = spool.fetch(later, "queued", 1);
    const failures = Promise.all([expect(blocked).rejects.toBeDefined(), expect(queued).rejects.toBeDefined()]);
    await started;
    await spool.close();
    await failures;
    await expect(spool.fetch(later, "closed", 1)).rejects.toBeDefined();
    expect(later).not.toHaveBeenCalled();
    expect(storage.close).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "rejects an invalid inactivity timeout %s", (timeout) => {
      expect(() => new DeferredByteSpool(memoryStorage(), timeout)).toThrow(RangeError);
    },
  );

  it.each(["inspection", "ranged inspection", "prepared exec"])("allows a long %s read despite wall-clock changes while bytes progress", async kind => {
    vi.useFakeTimers();
    let available = false;
    let progressAt: number | undefined;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const native = {
      rootfsReadFile: () => {
        if (!available) throw Object.assign(new Error("pending"), { errno: 11 });
        return new Uint8Array([7]);
      },
      rootfsInspectFileRange: vi.fn((_path: string, _offset: number, _length: number) => {
        if (!available) throw Object.assign(new Error("pending"), { errno: 11 });
        return new Uint8Array([7]);
      }),
      execTargetSize: () => 1n,
      execTargetRead: (_owner: number, _target: number, _offset: bigint, destination: Uint8Array) => {
        if (!available) return -11;
        destination[0] = 7;
        return 1;
      },
      execTargetCancel: vi.fn(() => 0),
      deferredFetchSettled: () => pending,
      deferredFetchProgressAt: () => progressAt,
    };
    let failure: unknown;
    let bytes: Uint8Array | null | undefined;
    const operation = kind === "inspection"
      ? readRootfsFileWithRetry(native as unknown as Parameters<typeof readRootfsFileWithRetry>[0], "/slow")
      : kind === "ranged inspection"
        ? readNamespaceFileRangeWithRetry(native as unknown as Parameters<typeof readNamespaceFileRangeWithRetry>[0], "/slow", 8, 1)
        : readPreparedExecTarget(native, 1, 2);
    const result = operation.then(value => { bytes = value; }, error => { failure = error; });
    await vi.advanceTimersByTimeAsync(20_000);
    progressAt = performance.now();
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(failure).toBeUndefined();
    available = true;
    finish();
    await result;
    expect(bytes).toEqual(new Uint8Array([7]));
    expect(native.execTargetCancel).not.toHaveBeenCalled();
    if (kind === "ranged inspection") expect(native.rootfsInspectFileRange).toHaveBeenCalledWith("/slow", 8, 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["inspection", "ranged inspection", "prepared exec"])("keeps the %s backstop without deferred byte progress", async kind => {
    vi.useFakeTimers();
    const native = {
      rootfsReadFile: () => { throw Object.assign(new Error("pending"), { errno: 11 }); },
      rootfsInspectFileRange: () => { throw Object.assign(new Error("pending"), { errno: 11 }); },
      execTargetSize: () => 1n,
      execTargetRead: () => -11,
      execTargetCancel: vi.fn(() => 0),
      deferredFetchSettled: () => new Promise<void>(() => {}),
      deferredFetchProgressAt: () => undefined,
    };
    let failure: unknown;
    const operation = kind === "inspection"
      ? readRootfsFileWithRetry(native as unknown as Parameters<typeof readRootfsFileWithRetry>[0], "/stuck")
      : kind === "ranged inspection"
        ? readNamespaceFileRangeWithRetry(native as unknown as Parameters<typeof readNamespaceFileRangeWithRetry>[0], "/stuck", 0, 1)
        : readPreparedExecTarget(native, 1, 2);
    const result = operation.catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failure).toMatchObject({ errno: 110 });
    await result;
    expect(native.execTargetCancel).toHaveBeenCalledTimes(kind === "prepared exec" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allocates from received bytes and relocates growing retries without damaging other slots", async () => {
    const storage = memoryStorage();
    const spool = new DeferredByteSpool(storage);
    try {
      await spool.fetch(async () => new Response(new Uint8Array(8).fill(1)), "short", 96 * 1024 * 1024);
      const other = await spool.fetch(async () => new Response(new Uint8Array(8).fill(2)), "other", 8);
      let chunks = 0;
      const grown = await spool.fetch(async () => new Response(new ReadableStream({
        pull(controller) {
          if (++chunks <= 2) controller.enqueue(new Uint8Array(8).fill(3));
          else controller.close();
        },
      })), "short", 96 * 1024 * 1024);
      const larger = new Uint8Array(16);
      expect(grown.readAt(0, larger)).toBe(16);
      expect(larger).toEqual(new Uint8Array(16).fill(3));
      const smaller = new Uint8Array(8);
      expect(other.readAt(0, smaller)).toBe(8);
      expect(smaller).toEqual(new Uint8Array(8).fill(2));
      expect(storage.bytes.subarray(32).every(byte => byte === 0)).toBe(true);
    } finally {
      await spool.close();
    }
  });

  it("isolates native URI slots even when deployment aliases resolve to the same address", async () => {
    const spool = new DeferredByteSpool(memoryStorage());
    let provider!: ReturnType<typeof buildRootfsLazyWiring>["deferredProvider"];
    let settled!: ReturnType<typeof buildRootfsLazyWiring>["whenFetchSettles"];
    const native = {
      configureRootfsOverlay: (
        value: typeof provider, _prefixes: string[], _nosuid: boolean,
        _length: number, _read: unknown, wait: typeof settled,
      ) => { provider = value; settled = wait; },
      rootfsLazyResourceLimits: () => new Map([["first", 8], ["second", 8]]),
    } as unknown as Parameters<typeof configureRootfsOverlayFromImage>[0];
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array(8).fill(++calls)));
    configureRootfsOverlayFromImage(native, {
      imageRead: () => 0,
      imageLength: 0,
      foreignPrefixes: [],
      nosuid: true,
      lazyFetcher: fetcher,
      lazyUrlMap: { first: "https://same.invalid/data", second: "https://same.invalid/data" },
      deferredByteSpool: spool,
    })();
    try {
      const target = new Uint8Array(8);
      expect(provider("first", 0n, target)).toBe(-11);
      await settled();
      expect(provider("first", 0n, target)).toBe(8);
      expect(target).toEqual(new Uint8Array(8).fill(1));
      expect(provider("second", 0n, target)).toBe(-11);
      await settled();
      expect(provider("second", 0n, target)).toBe(8);
      expect(target).toEqual(new Uint8Array(8).fill(2));
      expect(provider("first", 0n, target)).toBe(8);
      expect(target).toEqual(new Uint8Array(8).fill(1));
      expect(fetcher.mock.calls.every(([url]) => url === "https://same.invalid/data")).toBe(true);
    } finally {
      await spool.close();
    }
  });

  it("streams a 96 MiB response without arrayBuffer or resource-sized staging writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-deferred-byte-test-"));
    const backing = openNodeDeferredByteStorage(directory);
    let writes = 0;
    let maxWrite = 0;
    let maxRead = 0;
    const spool = new DeferredByteSpool({
      ...backing,
      writeAt: (offset, bytes) => {
        writes++;
        maxWrite = Math.max(maxWrite, bytes.byteLength);
        return backing.writeAt(offset, bytes);
      },
      readAt: (offset, bytes) => {
        maxRead = Math.max(maxRead, bytes.byteLength);
        return backing.readAt(offset, bytes);
      },
    });
    const size = 96 * 1024 * 1024;
    let sent = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (sent === size) return controller.close();
        const bytes = new Uint8Array(MAX_DEFERRED_IO_BYTES).fill(86);
        sent += bytes.byteLength;
        controller.enqueue(bytes);
      },
    }));
    const arrayBuffer = vi.spyOn(response, "arrayBuffer").mockRejectedValue(new Error("whole resource read"));
    try {
      const source = await spool.fetch(async () => response, "large", size);
      expect(source.length).toBe(size);
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(readdirSync(directory)).toEqual([]);
      expect(writes).toBe(size / MAX_DEFERRED_IO_BYTES);
      expect(maxWrite).toBeLessThanOrEqual(MAX_DEFERRED_IO_BYTES);
      const destination = new Uint8Array(2 * MAX_DEFERRED_IO_BYTES + 7);
      expect(source.readAt(size - destination.byteLength, destination)).toBe(destination.byteLength);
      expect(destination.every(byte => byte === 86)).toBe(true);
      expect(maxRead).toBeLessThanOrEqual(MAX_DEFERRED_IO_BYTES);
      expect(source.readAt(size, destination)).toBe(0);
      await spool.close();
      expect(() => source.readAt(0, destination)).toThrow();
      await spool.close();
    } finally {
      await spool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates resources, completes short I/O, and reuses a rejected URI's extent", async () => {
    const storage = memoryStorage();
    const spool = new DeferredByteSpool(storage);
    let calls = 0;
    const wiring = buildRootfsLazyWiring((url) => spool.fetch(async () => {
      calls++;
      return new Response(new Uint8Array(8).fill(url === "first" ? calls : 99));
    }, url, 8));
    const target = new Uint8Array(8);
    expect(wiring.deferredProvider("first", 0n, target)).toBe(-11);
    await wiring.whenFetchSettles();
    expect(wiring.deferredProvider("first", 0n, target)).toBe(8);
    expect(target).toEqual(new Uint8Array(8).fill(1));
    expect(wiring.deferredProvider("second", 0n, target)).toBe(-11);
    await wiring.whenFetchSettles();
    expect(wiring.deferredProvider("second", 0n, target)).toBe(8);
    expect(target).toEqual(new Uint8Array(8).fill(99));
    wiring.discardDeferred("first");
    expect(wiring.deferredProvider("first", 0n, target)).toBe(-11);
    await wiring.whenFetchSettles();
    expect(wiring.deferredProvider("first", 0n, target)).toBe(8);
    expect(target).toEqual(new Uint8Array(8).fill(3));
    expect(storage.bytes.subarray(0, 8)).toEqual(target);
    expect(storage.bytes.subarray(8, 16)).toEqual(new Uint8Array(8).fill(99));
    expect(storage.bytes.subarray(16).every(byte => byte === 0)).toBe(true);
    await spool.close();
    expect(storage.close).toHaveBeenCalledTimes(1);
  });

  it("serializes downloads before fetching and aborts active and queued work on close", async () => {
    const storage = memoryStorage();
    const spool = new DeferredByteSpool(storage);
    const cancelled = vi.fn();
    const firstFetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const secondFetcher = vi.fn(async () => new Response(new Uint8Array([2])));
    const first = spool.fetch(firstFetcher, "first", 1);
    const second = spool.fetch(secondFetcher, "second", 1);
    const firstFailure = expect(first).rejects.toBeDefined();
    const secondFailure = expect(second).rejects.toBeDefined();
    await vi.waitFor(() => expect(firstFetcher).toHaveBeenCalledTimes(1));
    expect(secondFetcher).not.toHaveBeenCalled();
    await spool.close();
    await Promise.all([firstFailure, secondFailure]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(secondFetcher).not.toHaveBeenCalled();
    expect(storage.close).toHaveBeenCalledTimes(1);
  });

  it("does not publish oversized, failed, or short storage output", async () => {
    for (const count of [0, -5, Number.NaN, 999]) {
      const spool = new DeferredByteSpool({ ...memoryStorage(), writeAt: () => count });
      await expect(spool.fetch(async () => new Response(new Uint8Array([1])), "bad", 1)).rejects.toThrow();
      await spool.close();
    }
    const storage = memoryStorage();
    const write = vi.fn(storage.writeAt);
    const spool = new DeferredByteSpool({ ...storage, writeAt: write });
    await expect(spool.fetch(async () => new Response(new Uint8Array(9)), "oversized", 8)).rejects.toThrow("bound");
    expect(write).not.toHaveBeenCalled();
    const source = await spool.fetch(async () => new Response(new Uint8Array([7])), "good", 1);
    await expect(spool.fetch(async () => new Response(new Uint8Array()), "good", -1)).rejects.toThrow();
    expect(source.length).toBe(1);
    await spool.close();
    for (const count of [0, -5, Number.NaN, 999]) {
      const broken = new DeferredByteSpool({ ...memoryStorage(), readAt: () => count });
      const source = await broken.fetch(async () => new Response(new Uint8Array([1])), "bad-read", 1);
      expect(() => source.readAt(0, new Uint8Array(1))).toThrow();
      await broken.close();
    }
  });

  it.each([
    [Object.assign(new Error("quota"), { code: "ENOSPC" }), -28],
    [new DOMException("quota", "QuotaExceededError"), -28],
    [Object.assign(new Error("memory"), { code: "ENOMEM" }), -12],
    [Object.assign(new Error("readonly"), { code: "EROFS" }), -30],
    [new Error("I/O"), -5],
  ])("preserves a terminal transport storage errno", async (error, errno) => {
    const spool = new DeferredByteSpool({ ...memoryStorage(), writeAt: () => { throw error; } });
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1])));
    const wiring = buildRootfsLazyWiring(url => spool.fetch(fetcher, url, 1));
    expect(wiring.deferredProvider("uri", 0n, new Uint8Array(1))).toBe(-11);
    await wiring.whenFetchSettles();
    expect(wiring.deferredProvider("uri", 0n, new Uint8Array(1))).toBe(errno);
    expect(wiring.deferredProvider("uri", 0n, new Uint8Array(1))).toBe(errno);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await spool.close();
  });

  it("restarts a transient partial download at the beginning of its extent", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const spool = new DeferredByteSpool(storage);
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      if (++attempts > 1) return new Response(new Uint8Array([7, 8, 9]));
      let pulls = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (++pulls === 1) controller.enqueue(new Uint8Array([1, 2]));
          else controller.error(new TypeError("network disconnected"));
        },
      }));
    });
    const result = spool.fetch(fetcher, "retry", 3);
    await vi.runAllTimersAsync();
    const source = await result;
    const destination = new Uint8Array(3);
    expect(source.readAt(0, destination)).toBe(3);
    expect(destination).toEqual(new Uint8Array([7, 8, 9]));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await spool.close();
  });
});

describe("OPFS deferred byte storage ownership", () => {
  it("reclaims abandoned stores, preserves live owners and unrelated entries, and bounces shared views", async () => {
    const files = new Map<string, { open: boolean; bytes: Uint8Array }>();
    const abandoned = "spool-11111111-1111-1111-1111-111111111111";
    files.set(abandoned, { open: false, bytes: new Uint8Array() });
    files.set("unrelated", { open: false, bytes: new Uint8Array() });
    let accessFailure: unknown;
    const fileHandle = (name: string) => ({
      kind: "file",
      createSyncAccessHandle: async () => {
        if (accessFailure !== undefined) throw accessFailure;
        const file = files.get(name)!;
        if (file.open) throw new DOMException("busy", "NoModificationAllowedError");
        file.open = true;
        return {
          read: (destination: Uint8Array, { at }: { at: number }) => {
            expect(destination.buffer).not.toBeInstanceOf(SharedArrayBuffer);
            const count = Math.min(destination.byteLength, Math.max(0, file.bytes.byteLength - at));
            destination.set(file.bytes.subarray(at, at + count));
            return count;
          },
          write: (source: Uint8Array, { at }: { at: number }) => {
            expect(source.buffer).not.toBeInstanceOf(SharedArrayBuffer);
            if (file.bytes.byteLength < at + source.byteLength) {
              const larger = new Uint8Array(at + source.byteLength);
              larger.set(file.bytes);
              file.bytes = larger;
            }
            file.bytes.set(source, at);
            return source.byteLength;
          },
          close: () => { file.open = false; },
        };
      },
    });
    const directory = {
      async *entries() { for (const name of files.keys()) yield [name, fileHandle(name)]; },
      getFileHandle: async (name: string) => {
        if (!files.has(name)) files.set(name, { open: false, bytes: new Uint8Array() });
        return fileHandle(name);
      },
      removeEntry: async (name: string) => {
        if (files.get(name)?.open) throw new Error("removed a live store");
        files.delete(name);
      },
    };
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
          if (held.has(name) && options.ifAvailable) return callback(null);
          if (held.has(name)) throw new Error("Unexpected concurrent cleanup in unit test");
          held.add(name);
          try { return await callback({ name }); } finally { held.delete(name); }
        },
      },
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
    });
    const first = await openOpfsDeferredByteStorage();
    expect(files.has(abandoned)).toBe(false);
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.fill(7);
    expect(first.writeAt(0, shared)).toBe(4);
    const second = await openOpfsDeferredByteStorage();
    shared.fill(0);
    expect(first.readAt(0, shared)).toBe(4);
    expect([...shared]).toEqual([7, 7, 7, 7]);
    expect(files.size).toBe(3);
    await first.close();
    await first.close();
    await second.close();
    expect([...files.keys()]).toEqual(["unrelated"]);
    expect(held.size).toBe(0);
    expect(() => first.readAt(0, shared)).toThrow("closed");
    accessFailure = new DOMException("quota", "QuotaExceededError");
    await expect(openOpfsDeferredByteStorage()).rejects.toBe(accessFailure);
    expect([...files.keys()]).toEqual(["unrelated"]);
    expect(held.size).toBe(0);
  });
});
