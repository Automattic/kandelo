import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  MockWorkerAdapter,
  NodeWorkerAdapter,
  nodeWorkerInitialization,
  nodeWorkerOptions,
  nodeWorkerStackSizeMb,
} from "../src/worker-adapter";
import { receiveNodeWorkerInit } from "../src/worker-entry";
import { NODE_WORKER_INIT_BY_MESSAGE } from "../src/node-worker-initialization";

async function expectUnsupportedWorkerInit(
  adapter: NodeWorkerAdapter,
): Promise<void> {
  const worker = adapter.createWorker({
    type: "unsupported_worker_init_for_transport_test",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("worker did not receive its initialization")),
        5_000,
      );
      worker.on("error", (error) => {
        clearTimeout(timeout);
        try {
          expect(error.message).toContain("Unknown worker init type");
          resolve();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
      worker.on("exit", (code) => {
        if (code !== 0) return;
        clearTimeout(timeout);
        reject(new Error("worker exited without rejecting unsupported init"));
      });
    });
  } finally {
    await worker.terminate();
  }
}

describe("MockWorkerAdapter", () => {
  it("should create a worker handle and capture workerData", () => {
    const adapter = new MockWorkerAdapter();
    const data = { type: "init", pid: 100 };
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
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 100 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "ready", pid: 100 });
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

  it("keeps built-in process memory out of the workerData startup path", () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const init = { type: "centralized_init", memory };

    expect(nodeWorkerInitialization(init, true)).toEqual({
      transport: "message",
      workerDataValue: NODE_WORKER_INIT_BY_MESSAGE,
      initialMessage: init,
    });
    expect(nodeWorkerInitialization(init, false)).toEqual({
      transport: "worker-data",
      workerDataValue: init,
    });
  });

  it("detaches the one-shot process-init listener after delivery", async () => {
    const port = new EventEmitter();
    const init = { type: "centralized_init", pid: 101 };
    const received = receiveNodeWorkerInit(
      port,
      NODE_WORKER_INIT_BY_MESSAGE,
    );

    expect(port.listenerCount("message")).toBe(1);
    port.emit("message", init);
    await expect(received).resolves.toBe(init);
    expect(port.listenerCount("message")).toBe(0);
  });

  it("rejects missing initialization instead of waiting forever", async () => {
    const port = new EventEmitter();

    await expect(receiveNodeWorkerInit(port, undefined)).rejects.toThrow(
      "Node worker initialization is missing",
    );
    expect(port.listenerCount("message")).toBe(0);
  });

  it("runs the built-in worker through one-shot message initialization", async () => {
    await expectUnsupportedWorkerInit(new NodeWorkerAdapter());
  });

  it("preserves workerData for the public worker entry", async () => {
    await expectUnsupportedWorkerInit(
      new NodeWorkerAdapter(
        new URL("../src/worker-entry.ts", import.meta.url),
      ),
    );
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
