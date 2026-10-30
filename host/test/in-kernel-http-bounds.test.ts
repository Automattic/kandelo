import { afterEach, describe, expect, it, vi } from "vitest";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { createKernelEntryGatedInstance, isKernelExportFailure, KernelEntryGate } from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { SessionHttpClient } from "../src/networking/session-http";
import type { NetworkIO } from "../src/types";

import {
  BoundedHttpResponseChunks,
  buildRawHttpRequest,
  parseRawHttpResponse,
} from "../src/networking/in-kernel-http";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function httpPumpHarness() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const operations = {
    inject: (): number => 10,
    identify: (_recv: number, _send: number): number => 1,
    write: (_bytes: Uint8Array): number => 0,
    read: (_pipeIndex: number): Uint8Array | null => null,
    writeOpen: (_pipeIndex: number): boolean => true,
  };
  const worker = createCentralizedKernelWorkerTestDouble();
  const readable = vi.fn();
  const closeRead = vi.fn((_pid: number, _pipeIndex: number) => 0);
  const closeWrite = vi.fn((_pid: number, _pipeIndex: number) => 0);
  const reset = vi.fn((_recv: number, _send: number, _token: number) => 0);
  const exports = {
    kernel_pick_tcp_listener_target: (_port: number, _exclude: number, pointer: number) => {
      const view = new DataView(memory.buffer);
      view.setUint32(pointer, 1, true);
      view.setInt32(pointer + 4, 3, true);
      return 1;
    },
    kernel_inject_connection: () => operations.inject(),
    kernel_tcp_connection_id: (recv: number, send: number) => operations.identify(recv, send),
    kernel_reset_tcp_connection: reset,
    kernel_pipe_write: (_pid: number, _pipe: number, pointer: number, length: number) => operations.write(new Uint8Array(memory.buffer, pointer, length)),
    kernel_pipe_read: (_pid: number, _pipe: number, pointer: number, capacity: number) => {
      const bytes = operations.read(_pipe);
      if (!bytes) return 0;
      expect(bytes.length).toBeLessThanOrEqual(capacity);
      new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
      return bytes.length;
    },
    kernel_pipe_is_write_open: (_pid: number, pipeIndex: number) => Number(operations.writeOpen(pipeIndex)),
    kernel_pipe_close_read: closeRead,
    kernel_pipe_close_write: closeWrite,
  };
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(4, memory, () => exports, () => 1024, 4, Object.keys(exports));
  const instance = createKernelEntryGatedInstance(rawInstance, gate);
  const scratch = allocateKernelScratchRegion(memory, instance.exports.kernel_alloc_scratch as (capacity: number) => number, 65536, 4, "HTTP pump test scratch", instance);
  worker.testAuthority.initializeKernelForTest({ instance, gate, mainScratch: scratch, tcpScratch: scratch });
  worker.testAuthority.configureScratchBoundaryHooksForTest({ scheduleWakeBlockedRetries: readable });
  return { worker, operations, readable, closeRead, closeWrite, reset, gate };
}

describe("in-kernel HTTP duplex pump", () => {
  it("defers timeout retirement while the native gate is occupied and settles only after close", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { worker, reset, closeRead, closeWrite, gate } = httpPumpHarness();
    let settled = false;
    const result = worker.sendHttpRequest(80, { method: "GET", url: "/waiting", headers: {}, body: null },
      { timeoutMs: 0.5 }).then(response => { settled = true; return response; });
    await Promise.resolve();
    const callback = timers.mock.calls.at(-1)![0] as () => void;
    clearTimeout(timers.mock.results.at(-1)!.value);
    now.mockReturnValue(3);
    gate.invokeKernelExport("retirement test outer export", () => {
      callback();
      expect(reset).not.toHaveBeenCalled();
      expect(closeRead).not.toHaveBeenCalled();
      expect(closeWrite).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    });
    expect((await result).status).toBe(504);
    expect(reset).toHaveBeenCalledExactlyOnceWith(10, 11, 1);
    expect(closeRead).toHaveBeenCalledExactlyOnceWith(0, 11);
    expect(closeWrite).toHaveBeenCalledExactlyOnceWith(0, 10);
  });

  it("rejects deferred retirement after an unrelated fatal failure without retrying native close", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { worker, reset, closeRead, closeWrite, gate } = httpPumpHarness();
    const result = worker.sendHttpRequest(80, { method: "GET", url: "/queued", headers: {}, body: null }, { timeoutMs: 0.5 });
    await Promise.resolve();
    const callback = timers.mock.calls.at(-1)![0] as () => void;
    clearTimeout(timers.mock.results.at(-1)!.value);
    now.mockReturnValue(3);
    const failure = new Error("unrelated kernel failure");
    const refused = expect(result).rejects.toThrow("response pump failed");
    gate.invokeKernelExport("retirement test poisoned outer export", () => {
      callback();
      worker.failPersistenceWriter(failure);
    });
    await refused;
    expect(reset).not.toHaveBeenCalled();
    expect(closeRead).not.toHaveBeenCalled();
    expect(closeWrite).not.toHaveBeenCalled();
  });

  it("fails closed before wakeups if injection cannot prove the minted identity", async () => {
    const { worker, operations, readable, reset, closeRead, closeWrite } = httpPumpHarness();
    operations.identify = () => 0;
    await expect(worker.sendHttpRequest(80, { method: "GET", url: "/unproven", headers: {}, body: null }))
      .rejects.toThrow("backing identity");
    expect(readable).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(closeRead).not.toHaveBeenCalled();
    expect(closeWrite).not.toHaveBeenCalled();
  });

  it("rejects an active pump after a timer-driven export failure while preserving its fatal identity", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { worker, operations, reset, closeRead, closeWrite } = httpPumpHarness();
    const result = worker.sendHttpRequest(80, { method: "GET", url: "/active-fatal", headers: {}, body: null });
    const refusal = result.catch(error => error);
    await Promise.resolve();
    const callback = timers.mock.calls.at(-1)![0] as () => void;
    clearTimeout(timers.mock.results.at(-1)!.value);
    operations.read = () => { throw new Error("timer-driven native failure"); };
    expect(callback).toThrow("kernel export kernel_pipe_read failed");
    const error = await refusal;
    expect(error.message).toContain("response pump failed");
    expect(isKernelExportFailure(error.cause)).toBe(true);
    expect(reset).not.toHaveBeenCalled();
    expect(closeRead).not.toHaveBeenCalled();
    expect(closeWrite).not.toHaveBeenCalled();
  });

  it("preserves the request failure and refuses stale backing without closing its successor", async () => {
    const { worker, operations, reset, closeRead, closeWrite } = httpPumpHarness();
    let identifications = 0;
    let read = false;
    operations.identify = () => ++identifications;
    operations.read = () => {
      if (read) return null;
      read = true;
      return new Uint8Array(6);
    };
    const error = await worker.sendHttpRequest(80, { method: "GET", url: "/stale", headers: {}, body: null },
      { maxResponseBytes: 5 }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors[0].message).toContain("5-byte bound");
    expect(error.cause.errors[1].message).toContain("no longer owns");
    expect(reset).not.toHaveBeenCalled();
    expect(closeRead).not.toHaveBeenCalled();
    expect(closeWrite).not.toHaveBeenCalled();
  });

  it("reports cleanup refusal rather than a successful timeout acknowledgement", async () => {
    vi.useFakeTimers();
    const { worker, reset, closeRead, closeWrite } = httpPumpHarness();
    reset.mockReturnValue(-12);
    const result = worker.sendHttpRequest(80, { method: "GET", url: "/uncertain", headers: {}, body: null }, { timeoutMs: 1 });
    const refused = expect(result).rejects.toThrow("response pump failed");
    await vi.runAllTimersAsync();
    await refused;
    expect(reset).toHaveBeenCalledExactlyOnceWith(10, 11, 1);
    expect(closeRead).not.toHaveBeenCalled();
    expect(closeWrite).not.toHaveBeenCalled();
  });

  it("successfully drains an asset burst in bounded batches", async () => {
    vi.useFakeTimers();
    const { worker, operations, closeRead, closeWrite, reset } = httpPumpHarness();
    let injected = 0;
    let peak = 0;
    let ready = false;
    const replied = new Set<number>();
    operations.inject = () => {
      const pipeIndex = 10 + 2 * injected++;
      peak = Math.max(peak, injected - closeRead.mock.calls.length);
      return pipeIndex;
    };
    operations.read = pipeIndex => {
      if (!ready || replied.has(pipeIndex)) return null;
      replied.add(pipeIndex);
      return new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    };
    operations.writeOpen = pipeIndex => !replied.has(pipeIndex);
    const requests = Array.from({ length: 64 }, (_, index) => worker.sendHttpRequest(80, {
      method: "GET", url: `/asset-${index}.js`, headers: {}, body: null,
    }, { timeoutMs: 1000 }));
    await Promise.resolve();
    expect(injected).toBe(16);
    ready = true;
    await vi.runAllTimersAsync();
    const results = await Promise.all(requests);
    expect(results.every(result => result.status === 200 && new TextDecoder().decode(result.body) === "ok")).toBe(true);
    expect(injected).toBe(64);
    expect(peak).toBe(16);
    expect(closeRead).toHaveBeenCalledTimes(64);
    expect(closeWrite).toHaveBeenCalledTimes(64);
    expect(reset).not.toHaveBeenCalled();
    expect(new Set(closeRead.mock.calls.map(arguments_ => arguments_[1])).size).toBe(64);
  });

  it("releases admission after injection refusal without retrying ENOMEM", async () => {
    vi.useFakeTimers();
    const { worker, operations } = httpPumpHarness();
    let injections = 0;
    operations.inject = () => { injections++; return -12; };
    const refused = await Promise.allSettled(Array.from({ length: 64 }, () => worker.sendHttpRequest(80, {
      method: "GET", url: "/refused", headers: {}, body: null,
    })));
    expect(refused.every(result => result.status === "rejected" && String(result.reason).includes("failed (-12)"))).toBe(true);
    expect(injections).toBe(64);
    operations.inject = () => 10;
    let replied = false;
    operations.read = () => {
      if (replied) return null;
      replied = true;
      return new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    };
    operations.writeOpen = () => !replied;
    const result = worker.sendHttpRequest(80, { method: "GET", url: "/available", headers: {}, body: null });
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(200);
  });

  it("releases the first permit before retrying empty GET responses", async () => {
    vi.useFakeTimers();
    const { worker, operations, closeRead } = httpPumpHarness();
    let injected = 0;
    let peak = 0;
    const replied = new Set<number>();
    operations.inject = () => {
      const pipeIndex = 10 + 2 * injected++;
      peak = Math.max(peak, injected - closeRead.mock.calls.length);
      return pipeIndex;
    };
    operations.read = pipeIndex => {
      if (replied.has(pipeIndex)) return null;
      replied.add(pipeIndex);
      return new TextEncoder().encode(pipeIndex < 42 ? "HTTP/1.1 200 OK\r\n\r\n"
        : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    };
    operations.writeOpen = pipeIndex => !replied.has(pipeIndex);
    const requests = Array.from({ length: 20 }, () => worker.sendHttpRequest(80, {
      method: "GET", url: "/retry", headers: {}, body: null,
    }, { timeoutMs: 1000 }));
    await vi.runAllTimersAsync();
    expect((await Promise.all(requests)).every(result => new TextDecoder().decode(result.body) === "ok")).toBe(true);
    expect(injected).toBe(36);
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("bounds simultaneous connection injection across an HTTP asset burst", async () => {
    vi.useFakeTimers();
    const { worker, operations, closeRead } = httpPumpHarness();
    let injected = 0;
    let peak = 0;
    operations.inject = () => {
      injected++;
      peak = Math.max(peak, injected - closeRead.mock.calls.length);
      return 10;
    };
    const requests = Array.from({ length: 64 }, (_, index) => worker.sendHttpRequest(80, {
      method: "GET", url: `/asset-${index}.js`, headers: {}, body: null,
    }, { timeoutMs: 100 }));
    await Promise.resolve();
    expect(injected).toBeLessThanOrEqual(16);
    await vi.runAllTimersAsync();
    const results = await Promise.all(requests);
    expect(results.every(result => result.status === 504)).toBe(true);
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("retries full and partial request writes without losing bytes", async () => {
    vi.useFakeTimers();
    const { worker, operations, readable, closeRead, closeWrite } = httpPumpHarness();
    const request = { method: "POST", url: "/upload", headers: {}, body: new Uint8Array(210_000).fill(37) };
    const expected = buildRawHttpRequest(request);
    const received: number[] = [];
    let calls = 0;
    let responded = false;
    operations.write = bytes => {
      calls++;
      const count = calls % 3 === 0 ? 0 : Math.min(32_768, bytes.length);
      received.push(...bytes.subarray(0, count));
      return count;
    };
    operations.read = () => {
      if (received.length !== expected.length || responded) return null;
      responded = true;
      return new TextEncoder().encode("HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok");
    };
    operations.writeOpen = () => !responded;
    const result = worker.sendHttpRequest(80, request);
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(201);
    expect(new Uint8Array(received)).toEqual(expected);
    expect(readable).toHaveBeenCalled();
    expect(closeRead).toHaveBeenCalledExactlyOnceWith(0, 11);
    expect(closeWrite).toHaveBeenCalledExactlyOnceWith(0, 10);
  });

  it("times out a stalled request and releases both host pipe ends", async () => {
    vi.useFakeTimers();
    const { worker, closeRead, closeWrite, reset } = httpPumpHarness();
    const result = worker.sendHttpRequest(80, { method: "POST", url: "/", headers: {}, body: Uint8Array.of(1) }, { timeoutMs: 10 });
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(504);
    expect(closeRead).toHaveBeenCalledOnce();
    expect(closeWrite).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledExactlyOnceWith(10, 11, 1);
  });

  it("enforces the caller's response ceiling through the actual pump", async () => {
    const { worker, operations, closeRead, closeWrite } = httpPumpHarness();
    let read = false;
    operations.read = () => {
      if (read) return null;
      read = true;
      return new Uint8Array(6);
    };
    await expect(worker.sendHttpRequest(80, { method: "GET", url: "/", headers: {}, body: null }, { maxResponseBytes: 5 }))
      .rejects.toThrow("response pump failed");
    expect(closeRead).toHaveBeenCalledOnce();
    expect(closeWrite).toHaveBeenCalledOnce();
  });
});

describe("in-kernel HTTP response bounds", () => {
  it("rejects a response before retaining bytes beyond the caller ceiling", () => {
    const chunks = new BoundedHttpResponseChunks(5);
    chunks.push(new Uint8Array([1, 2, 3]));
    expect(() => chunks.push(new Uint8Array([4, 5, 6]))).toThrow(
      /response exceeds its 5-byte bound/,
    );
    expect([...chunks.concat()]).toEqual([1, 2, 3]);
  });

  it("rejects unframed and malformed HTTP responses", () => {
    expect(() => parseRawHttpResponse(
      new TextEncoder().encode("expected body without HTTP framing"),
    )).toThrow(/header terminator/);
    expect(() => parseRawHttpResponse(
      new TextEncoder().encode("not-http 200 maybe\r\nContent-Length: 0\r\n\r\n"),
    )).toThrow(/status line/);
  });

  it("rejects incomplete content-length and chunked response framing", () => {
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabc",
    ))).toThrow(/Content-Length/);
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "5\r\nabc\r\n0\r\n\r\n",
    ))).toThrow(/chunk/i);
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "3\r\nabc\r\n",
    ))).toThrow(/chunk.*truncated/i);
  });

  it("accepts exactly framed content-length and chunked bodies", () => {
    const fixed = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc",
    ));
    expect(new TextDecoder().decode(fixed.body)).toBe("abc");

    const chunked = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "3\r\nabc\r\n0\r\nX-Trace: ok\r\n\r\n",
    ));
    expect(new TextDecoder().decode(chunked.body)).toBe("abc");
  });

  it("accepts optional header whitespace and bodyless response metadata", () => {
    const head = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length:9\r\nX-Shape:value\r\n\r\n",
    ), "HEAD");
    expect(head.headers["X-Shape"]).toBe("value");
    expect(head.body).toHaveLength(0);

    const notModified = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 304 Not Modified\r\nContent-Length: 9\r\n\r\n",
    ));
    expect(notModified.body).toHaveLength(0);

    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n",
    ))).toThrow(/Content-Length/);
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc",
    ), "HEAD")).toThrow(/must not contain a body/);
  });
});

describe("session HTTP ownership and backpressure", () => {
  function network(response: string) {
    let position = 0;
    const writes: number[] = [], closed: number[] = [];
    let received = "";
    const io: NetworkIO = {
      connect: () => {}, connectStatus: () => 0,
      send: (_handle, bytes) => { writes.push(Math.min(3, bytes.length)); received += new TextDecoder().decode(bytes.subarray(0, 3)); return Math.min(3, bytes.length); },
      recv: () => { if (!received.includes("\r\n\r\n")) throw Object.assign(new Error("EAGAIN"), { errno: 11 });
        if (position++) return new Uint8Array(0); return new TextEncoder().encode(response); },
      close: handle => { closed.push(handle); }, getaddrinfo: () => new Uint8Array([10, 89, 0, 1]),
    };
    return { io, writes, closed };
  }
  it("closes the exact connection after short writes and a decoded response", async () => {
    const { io, writes, closed } = network("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const response = await new SessionHttpClient().fetch(io, new Uint8Array([10, 89, 0, 1]), 8080,
      { method: "GET", url: "/", headers: { Host: "host" }, body: null });
    expect(new TextDecoder().decode(response.body)).toBe("ok");
    expect(writes.length).toBeGreaterThan(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeGreaterThan(0xffffffff);
  });
  it("closes the connection when a response exceeds its byte ceiling", async () => {
    const { io, closed } = network("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    await expect(new SessionHttpClient().fetch(io, new Uint8Array([10, 89, 0, 1]), 8080,
      { method: "GET", url: "/", headers: { Host: "host" }, body: null }, { maxResponseBytes: 10 })).rejects.toThrow(/bound/);
    expect(closed).toHaveLength(1);
  });
  it("cancels a stalled request and releases its timer and handle on leave", async () => {
    const { io, closed } = network("");
    io.connectStatus = () => -11;
    const client = new SessionHttpClient();
    const result = client.fetch(io, new Uint8Array([10, 89, 0, 1]), 8080,
      { method: "GET", url: "/", headers: {}, body: null });
    const rejected = expect(result).rejects.toThrow(/session ended/);
    client.close(); await rejected;
    expect(closed).toHaveLength(1);
  });
});
