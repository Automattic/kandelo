import { afterEach, describe, it, expect, vi } from "vitest";
import { MockWorkerAdapter, terminateNodeWorker } from "../src/worker-adapter";

describe("MockWorkerAdapter", () => {
  it("should create a worker handle and capture workerData", () => {
    const adapter = new MockWorkerAdapter();
    const data = { type: "init", pid: 1 };
    const handle = adapter.createWorker(data);
    expect(handle).toBeDefined();
    expect(adapter.lastWorker).not.toBeNull();
    expect(adapter.lastWorkerData).toEqual(data);
  });

  it("should dispatch messages to registered handlers", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    const messages: unknown[] = [];
    handle.on("message", (msg) => messages.push(msg));
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "ready", pid: 1 });
  });

  it("should dispatch error events to registered handlers", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    const errors: Error[] = [];
    handle.on("error", (err) => errors.push(err));
    adapter.lastWorker!.simulateError(new Error("boom"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  it("should dispatch exit events to registered handlers", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    const codes: number[] = [];
    handle.on("exit", (code) => codes.push(code));
    adapter.lastWorker!.simulateExit(42);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toBe(42);
  });

  it("should capture sent messages via postMessage", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    handle.postMessage({ type: "terminate" });
    expect(adapter.lastWorker!.sentMessages).toEqual([{ type: "terminate" }]);
  });
});

describe("terminateNodeWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the worker termination result when it settles before the timeout", async () => {
    const worker = {
      terminate: vi.fn(() => Promise.resolve(0)),
      unref: vi.fn(),
    };

    await expect(terminateNodeWorker(worker, 100)).resolves.toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.unref).not.toHaveBeenCalled();
  });

  it("unrefs and returns a nonzero code when termination does not settle", async () => {
    vi.useFakeTimers();
    const worker = {
      terminate: vi.fn(() => new Promise<number>(() => {})),
      unref: vi.fn(),
    };

    const result = terminateNodeWorker(worker, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.unref).toHaveBeenCalledOnce();
  });
});
