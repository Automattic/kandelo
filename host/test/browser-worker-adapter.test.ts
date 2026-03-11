import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BrowserWorkerAdapter } from "../src/worker-adapter-browser";

// ---------------------------------------------------------------------------
// Mock Web Worker for Node.js test environment
// ---------------------------------------------------------------------------

class MockBrowserWorker {
  url: string | URL;
  options: any;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  sentMessages: unknown[] = [];
  terminated = false;

  constructor(url: string | URL, options?: any) {
    this.url = url;
    this.options = options;
  }

  postMessage(msg: unknown, _transfer?: any[]) {
    this.sentMessages.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  // --- Test helpers ---

  simulateMessage(data: unknown) {
    this.onmessage?.({ data });
  }

  simulateError(message: string) {
    this.onerror?.({ message });
  }
}

// Keep a reference to the last constructed MockBrowserWorker so tests
// can interact with it after BrowserWorkerAdapter creates one internally.
let lastMockWorker: MockBrowserWorker | null = null;
const OriginalMockBrowserWorker = MockBrowserWorker;

function TrackingMockBrowserWorker(
  this: MockBrowserWorker,
  url: string | URL,
  options?: any,
) {
  const instance = new OriginalMockBrowserWorker(url, options);
  lastMockWorker = instance;
  return instance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrowserWorkerAdapter", () => {
  beforeEach(() => {
    lastMockWorker = null;
    vi.stubGlobal("Worker", TrackingMockBrowserWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- createWorker -------------------------------------------------------

  describe("createWorker", () => {
    it("should create a Worker with the entry URL and module type", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      adapter.createWorker({ pid: 1 });

      expect(lastMockWorker).not.toBeNull();
      expect(lastMockWorker!.url).toBe("worker.js");
      expect(lastMockWorker!.options).toEqual({ type: "module" });
    });

    it("should accept a URL object as entry", () => {
      const url = new URL("https://example.com/worker.js");
      const adapter = new BrowserWorkerAdapter(url);
      adapter.createWorker({});

      expect(lastMockWorker!.url).toBe(url);
    });

    it("should send workerData via postMessage", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const initData = { type: "init", pid: 42, wasmBytes: new ArrayBuffer(8) };
      adapter.createWorker(initData);

      expect(lastMockWorker!.sentMessages).toHaveLength(1);
      expect(lastMockWorker!.sentMessages[0]).toEqual(initData);
    });

    it("should return a WorkerHandle", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});

      expect(handle).toBeDefined();
      expect(typeof handle.postMessage).toBe("function");
      expect(typeof handle.on).toBe("function");
      expect(typeof handle.off).toBe("function");
      expect(typeof handle.terminate).toBe("function");
    });
  });

  // ---- BrowserWorkerHandle message routing --------------------------------

  describe("message event routing", () => {
    it("should route Worker onmessage to registered message handlers", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const received: unknown[] = [];

      handle.on("message", (msg) => received.push(msg));
      lastMockWorker!.simulateMessage({ type: "ready", pid: 1 });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: "ready", pid: 1 });
    });

    it("should support multiple message handlers", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const a: unknown[] = [];
      const b: unknown[] = [];

      handle.on("message", (msg) => a.push(msg));
      handle.on("message", (msg) => b.push(msg));
      lastMockWorker!.simulateMessage("hello");

      expect(a).toEqual(["hello"]);
      expect(b).toEqual(["hello"]);
    });

    it("should not throw when message fires with no handlers", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      adapter.createWorker({});

      // No handlers registered -- should not throw
      expect(() => lastMockWorker!.simulateMessage("orphan")).not.toThrow();
    });
  });

  // ---- BrowserWorkerHandle error routing ----------------------------------

  describe("error event routing", () => {
    it("should route Worker onerror to registered error handlers as Error", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const errors: Error[] = [];

      handle.on("error", (err) => errors.push(err));
      lastMockWorker!.simulateError("something went wrong");

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0].message).toBe("something went wrong");
    });

    it("should not throw when error fires with no handlers", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      adapter.createWorker({});

      expect(() =>
        lastMockWorker!.simulateError("unhandled"),
      ).not.toThrow();
    });
  });

  // ---- BrowserWorkerHandle postMessage ------------------------------------

  describe("postMessage forwarding", () => {
    it("should forward postMessage to the underlying Worker", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});

      // First message is the workerData init, so start fresh
      lastMockWorker!.sentMessages.length = 0;

      handle.postMessage({ type: "exec", cmd: "ls" });
      expect(lastMockWorker!.sentMessages).toEqual([
        { type: "exec", cmd: "ls" },
      ]);
    });

    it("should pass transfer array when provided", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      lastMockWorker!.sentMessages.length = 0;

      // Spy on the underlying postMessage to verify transfer argument
      const spy = vi.spyOn(lastMockWorker!, "postMessage");
      const buf = new ArrayBuffer(16);
      handle.postMessage(buf, [buf]);

      expect(spy).toHaveBeenCalledWith(buf, [buf]);
    });

    it("should pass empty array when no transfer argument given", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      lastMockWorker!.sentMessages.length = 0;

      const spy = vi.spyOn(lastMockWorker!, "postMessage");
      handle.postMessage("ping");

      expect(spy).toHaveBeenCalledWith("ping", []);
    });
  });

  // ---- BrowserWorkerHandle terminate --------------------------------------

  describe("terminate", () => {
    it("should call terminate on the underlying Worker", async () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});

      await handle.terminate();
      expect(lastMockWorker!.terminated).toBe(true);
    });

    it("should fire exit handlers with code 0", async () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const exitCodes: number[] = [];

      handle.on("exit", (code) => exitCodes.push(code));
      await handle.terminate();

      expect(exitCodes).toEqual([0]);
    });

    it("should return 0", async () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const code = await handle.terminate();
      expect(code).toBe(0);
    });
  });

  // ---- BrowserWorkerHandle off (unregister) -------------------------------

  describe("off (unregister handler)", () => {
    it("should stop dispatching to a removed message handler", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const received: unknown[] = [];

      const handler = (msg: unknown) => received.push(msg);
      handle.on("message", handler);
      lastMockWorker!.simulateMessage("first");
      expect(received).toHaveLength(1);

      handle.off("message", handler);
      lastMockWorker!.simulateMessage("second");
      expect(received).toHaveLength(1); // still 1
    });

    it("should stop dispatching to a removed error handler", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const errors: Error[] = [];

      const handler = (err: Error) => errors.push(err);
      handle.on("error", handler);
      lastMockWorker!.simulateError("first");
      expect(errors).toHaveLength(1);

      handle.off("error", handler);
      lastMockWorker!.simulateError("second");
      expect(errors).toHaveLength(1);
    });

    it("should stop dispatching to a removed exit handler", async () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});
      const codes: number[] = [];

      const handler = (code: number) => codes.push(code);
      handle.on("exit", handler);
      handle.off("exit", handler);
      await handle.terminate();

      expect(codes).toHaveLength(0);
    });

    it("should be a no-op for unregistered handlers", () => {
      const adapter = new BrowserWorkerAdapter("worker.js");
      const handle = adapter.createWorker({});

      // Should not throw even when removing a handler that was never added
      expect(() => handle.off("message", () => {})).not.toThrow();
    });
  });
});
