import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  MockWorkerAdapter,
  NodeWorkerAdapter,
  nodeWorkerOptions,
  nodeWorkerStackSizeMb,
} from "../src/worker-adapter";

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

describe("NodeWorkerAdapter stack policy", () => {
  it("uses 32 MiB by default and validates explicit overrides", () => {
    expect(nodeWorkerStackSizeMb(undefined)).toBe(32);
    expect(nodeWorkerStackSizeMb("48")).toBe(48);
    expect(() => nodeWorkerStackSizeMb("0")).toThrow(/invalid/);
    expect(() => nodeWorkerStackSizeMb("-1")).toThrow(/invalid/);
    expect(() => nodeWorkerStackSizeMb("not-a-number")).toThrow(/invalid/);
  });

  it("preserves other resource limits when setting the stack limit", () => {
    expect(nodeWorkerOptions({ pid: 7 }, {
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })).toMatchObject({
      workerData: { pid: 7 },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        stackSizeMb: 32,
      },
    });
  });

  it("runs a deeply recursive Wasm workload inside the configured worker stack", async () => {
    const adapter = new NodeWorkerAdapter(
      new URL("./fixtures/deep-wasm-recursion-worker.mjs", import.meta.url),
    );
    const worker = adapter.createWorker({
      wasmPath: fileURLToPath(
        new URL("./fixtures/deep-wasm-recursion.wasm", import.meta.url),
      ),
      depth: 300_000,
    });

    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`deep Wasm worker exited ${code}`));
        });
      });
      expect(result).toEqual({ result: 300_000 });
    } finally {
      await worker.terminate();
    }
  }, 20_000);

  it("supports the default four concurrent process-worker stack reservations", async () => {
    const adapter = new NodeWorkerAdapter(
      new URL("./fixtures/deep-wasm-recursion-worker.mjs", import.meta.url),
    );
    const wasmPath = fileURLToPath(
      new URL("./fixtures/deep-wasm-recursion.wasm", import.meta.url),
    );
    const workers = Array.from({ length: 4 }, () =>
      adapter.createWorker({ wasmPath, depth: 100_000 }));

    try {
      const results = await Promise.all(workers.map((worker) =>
        new Promise<unknown>((resolve, reject) => {
          worker.on("message", resolve);
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`deep Wasm worker exited ${code}`));
          });
        })));
      expect(results).toEqual(Array.from({ length: 4 }, () => ({ result: 100_000 })));
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 20_000);
});
