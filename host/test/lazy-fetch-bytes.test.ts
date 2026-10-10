import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLazyResourceBytes } from "../src/vfs/lazy-fetch-bytes";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";

afterEach(() => vi.useRealTimers());
describe("native rootfs lazy transport retry policy", () => {
  it("reports streamed transfer progress without letting an observer break the read", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }), { headers: { "content-length": "3" } });
    const events: Array<{ status: string; loadedBytes: number; totalBytes?: number }> = [];
    const wiring = buildRootfsLazyWiring((url, progress) =>
      fetchLazyResourceBytes(async () => response, url, 3, progress), event => {
        events.push(event);
        if (event.status === "progress") throw new Error("observer failure");
      });
    const dest = new Uint8Array(3);
    expect(wiring.deferredProvider("uri", 0n, dest)).toBe(-11);
    await wiring.whenFetchSettles();
    expect(wiring.deferredProvider("uri", 0n, dest)).toBe(3);
    expect(dest).toEqual(new Uint8Array([1, 2, 3]));
    expect(events.map(({ status, loadedBytes }) => [status, loadedBytes])).toEqual([
      ["started", 0], ["progress", 2], ["progress", 3], ["complete", 3],
    ]);
    expect(events.filter(event => event.status === "progress").every(event => event.totalBytes === 3)).toBe(true);
  });
  it("retries a transient HTTP response and discards its body before using later bytes", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(body, { status: 502, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const pending = fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancelled).toBe(true);
  });

  it("stops after three transient network failures", async () => {
    vi.useFakeTimers();
    const failure = new TypeError("network failure");
    const fetcher = vi.fn().mockRejectedValue(failure);
    const rejected = expect(fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data")).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([404, 403])("does not retry permanent HTTP %s", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("denied", { status }));
    await expect(fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data")).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps an abort wrapped in a network TypeError terminal", async () => {
    const failure = new TypeError("fetch aborted", { cause: new DOMException("cancelled", "AbortError") });
    const fetcher = vi.fn().mockRejectedValue(failure);
    await expect(fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data")).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps an attacker-controlled Retry-After and does not retry valid bytes", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "999999999" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9])));
    const pending = fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(new Uint8Array([9]));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cancels an oversized advertised body without reading or retrying it", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel: () => { cancelled = true; } }),
      { headers: { "content-length": "9999" } });
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data", 3)).rejects.toThrow("byte bound 3");
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed bytes without Content-Length and preserves failure when cancel rejects", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); },
      cancel() { cancelled = true; throw new TypeError("cleanup network failure"); },
    }));
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(fetchLazyResourceBytes(fetcher, "https://fixture.invalid/data", 3)).rejects.toThrow("byte bound 3");
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

});
