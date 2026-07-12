/**
 * BrowserKernel — main-thread proxy tests.
 *
 * BrowserKernel runs in the browser main thread and spawns a dedicated Web
 * Worker that hosts CentralizedKernelWorker. We can't actually run that
 * worker in vitest (Vite-specific URL imports + Web Worker API), so these
 * tests stub `globalThis.Worker` with a fake that captures messages and
 * lets the test simulate replies. This validates BrowserKernel's
 * message-protocol contract without booting a real kernel.
 *
 * Higher-level integration coverage of the same `fetchInKernel` path runs
 * through Node in `in-kernel-http.test.ts`, which exercises the actual
 * kernel-worker pump end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { HttpResponse } from "../src/networking";

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------

interface CapturedMessage {
  data: any;
  transfer: Transferable[];
}

class MockWorker {
  static instances: MockWorker[] = [];
  url: string | URL;
  options: any;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  sent: CapturedMessage[] = [];
  terminated = false;

  constructor(url: string | URL, options?: any) {
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }
  postMessage(data: unknown, transfer: Transferable[] = []) {
    this.sent.push({ data, transfer });
  }
  addEventListener(_type: string, _h: (e: any) => void) {
    // BrowserKernel registers a `message` listener for the ready handshake
    // via addEventListener; route to onmessage so simulateMessage hits both.
    if (_type === "message") this._extra.push(_h);
  }
  removeEventListener(_type: string, h: (e: any) => void) {
    const idx = this._extra.indexOf(h);
    if (idx >= 0) this._extra.splice(idx, 1);
  }
  terminate() {
    this.terminated = true;
  }
  /** Test helper. */
  simulateMessage(data: unknown) {
    const ev = { data };
    this.onmessage?.(ev as any);
    for (const h of [...this._extra]) h(ev);
  }
  /** Last message of a given `type`. */
  lastMessage(type: string): any | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if ((this.sent[i]!.data as any)?.type === type) return this.sent[i]!.data;
    }
    return undefined;
  }

  private _extra: Array<(e: any) => void> = [];
}

// SharedArrayBuffer + WebAssembly.Memory aren't available in some Node
// configurations. We use the real ones (Node supports them) but stub the
// kernelOwnedFs path so the constructor doesn't try to format a SAB.
async function loadBrowserKernel() {
  // Dynamic import after globals are stubbed.
  const mod = await import("../src/browser-kernel-host");
  return mod.BrowserKernel as typeof import("../src/browser-kernel-host").BrowserKernel;
}


describe("BrowserKernel", () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker as any);
    // Provide a fetch stub for kernel.init() / boot() default kernelWasm
    // fetch path. Tests that exercise init/boot pass kernelWasm explicitly,
    // but the constructor logs reference globalThis.fetch when it shouldn't —
    // this is a defensive stub to keep failures readable.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("BrowserKernel test should not fetch");
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs without spawning a worker (kernel-owned VFS)", async () => {
    const BrowserKernel = await loadBrowserKernel();
    // The constructor allocates only the small shm SAB — no VFS SAB and no
    // worker until boot()/initFromImage().
    new BrowserKernel({ kernelOwnedFs: true });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("boot() spawns a worker, sends init, and resolves on `ready`", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });

    const bootPromise = kernel.boot({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      argv: ["/init"],
    });

    // Worker should be created and the init message posted.
    await new Promise((r) => setTimeout(r, 0)); // let the constructor microtask flush
    expect(MockWorker.instances).toHaveLength(1);
    const w = MockWorker.instances[0]!;
    const init = w.lastMessage("init");
    expect(init).toBeDefined();
    expect(init.argv).toBeUndefined(); // argv goes in the spawn message
    expect(init.kernelWasmBytes).toBeInstanceOf(ArrayBuffer);

    // Simulate the worker becoming ready, then reply to the spawn request.
    w.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));

    // BrowserKernel followed up with a spawn request.
    const spawn = w.lastMessage("spawn");
    expect(spawn).toBeDefined();
    expect(spawn.argv).toEqual(["/init"]);
    expect(typeof spawn.requestId).toBe("number");

    // Worker replies with the assigned pid.
    w.simulateMessage({ type: "response", requestId: spawn.requestId, result: 100 });
    const { pid, exit } = await bootPromise;
    expect(pid).toBe(100);

    // Exit promise — fires only when the worker reports exit.
    let exitResolved: number | null = null;
    exit.then((c) => { exitResolved = c; });
    expect(exitResolved).toBeNull();
    w.simulateMessage({ type: "exit", pid: 100, status: 7 });
    expect(await exit).toBe(7);
  });

  it("forwards posix_spawn parentage from the browser kernel worker", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const processEvents: Array<{
      kind: "spawn" | "exec" | "exit";
      pid: number;
      ppid?: number;
      exitStatus?: number;
    }> = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onProcessEvent: (event) => processEvents.push(event),
    });

    const bootPromise = kernel.boot({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      argv: ["/init"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const spawn = worker.lastMessage("spawn");
    worker.simulateMessage({ type: "response", requestId: spawn.requestId, result: 100 });
    await bootPromise;

    processEvents.length = 0;
    worker.simulateMessage({ type: "proc_event", kind: "spawn", pid: 2, ppid: 100 });
    worker.simulateMessage({ type: "proc_event", kind: "exec", pid: 2 });

    expect(processEvents).toEqual([
      { kind: "spawn", pid: 2, ppid: 100 },
      { kind: "exec", pid: 2 },
    ]);
  });

  it("readFileFromVfs round-trips a path to the worker and back", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    void kernel.boot({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0), argv: ["/init"] });
    await new Promise((r) => setTimeout(r, 0));
    const w = MockWorker.instances[0]!;
    w.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));

    const readPromise = kernel.readFileFromVfs("/sqlite/testrunner.db");
    await new Promise((r) => setTimeout(r, 0));
    const read = w.lastMessage("read_vfs_file");
    expect(read).toBeDefined();
    expect(read.path).toBe("/sqlite/testrunner.db");
    const bytes = new Uint8Array([1, 2, 3]);
    w.simulateMessage({ type: "response", requestId: read.requestId, result: bytes });
    expect(await readPromise).toEqual(bytes);
  });

  describe("fetchInKernel", () => {
    async function bootedKernel() {
      const BrowserKernel = await loadBrowserKernel();
      const kernel = new BrowserKernel({ kernelOwnedFs: true });
      const bootPromise = kernel.boot({
        kernelWasm: new ArrayBuffer(8),
        vfsImage: new Uint8Array(0),
        argv: ["/init"],
      });
      await new Promise((r) => setTimeout(r, 0));
      const w = MockWorker.instances[0]!;
      w.simulateMessage({ type: "ready" });
      await new Promise((r) => setTimeout(r, 0));
      const spawn = w.lastMessage("spawn");
      w.simulateMessage({ type: "response", requestId: spawn.requestId, result: 100 });
      await bootPromise;
      return { kernel, worker: w };
    }

    it("emits an http_request message with the right shape", async () => {
      const { kernel, worker } = await bootedKernel();

      const fetchPromise = kernel.fetchInKernel(8080, {
        method: "GET",
        url: "/foo?bar=1",
        headers: { Host: "x" },
        body: null,
      });

      await new Promise((r) => setTimeout(r, 0));
      const msg = worker.lastMessage("http_request");
      expect(msg).toBeDefined();
      expect(msg.port).toBe(8080);
      expect(msg.request).toEqual({
        method: "GET",
        url: "/foo?bar=1",
        headers: { Host: "x" },
        body: null,
      });
      expect(typeof msg.requestId).toBe("number");

      // Reply with a parsed response.
      const response: HttpResponse = {
        status: 201,
        headers: { "X-Origin": "kernel" },
        body: new TextEncoder().encode("ok"),
      };
      worker.simulateMessage({
        type: "response",
        requestId: msg.requestId,
        result: response,
      });

      const got = await fetchPromise;
      expect(got.status).toBe(201);
      expect(got.headers).toEqual({ "X-Origin": "kernel" });
      expect(new TextDecoder().decode(got.body)).toBe("ok");
    });

    it("forwards a custom timeout in the message", async () => {
      const { kernel, worker } = await bootedKernel();

      const p = kernel.fetchInKernel(
        9000,
        { method: "GET", url: "/", headers: {}, body: null },
        { timeoutMs: 1234 },
      );
      await new Promise((r) => setTimeout(r, 0));
      const msg = worker.lastMessage("http_request");
      expect(msg.timeoutMs).toBe(1234);
      worker.simulateMessage({
        type: "response",
        requestId: msg.requestId,
        result: { status: 200, headers: {}, body: new Uint8Array(0) },
      });
      await p; // settle
    });

    it("rejects when the worker reports an error for the request", async () => {
      const { kernel, worker } = await bootedKernel();

      const fetchPromise = kernel.fetchInKernel(8080, {
        method: "GET",
        url: "/",
        headers: {},
        body: null,
      });

      await new Promise((r) => setTimeout(r, 0));
      const msg = worker.lastMessage("http_request");
      worker.simulateMessage({
        type: "response",
        requestId: msg.requestId,
        result: null,
        error: "No in-kernel listener for port 8080",
      });

      await expect(fetchPromise).rejects.toThrow(/No in-kernel listener/);
    });

    it("each call uses a fresh requestId", async () => {
      const { kernel, worker } = await bootedKernel();

      const a = kernel.fetchInKernel(8080, {
        method: "GET", url: "/a", headers: {}, body: null,
      });
      const b = kernel.fetchInKernel(8080, {
        method: "GET", url: "/b", headers: {}, body: null,
      });
      await new Promise((r) => setTimeout(r, 0));

      const httpReqs = worker.sent
        .map((m) => m.data)
        .filter((d: any) => d?.type === "http_request");
      expect(httpReqs).toHaveLength(2);
      const ids = new Set(httpReqs.map((r: any) => r.requestId));
      expect(ids.size).toBe(2);

      // Resolve in reversed order — verifies ID-based correlation.
      worker.simulateMessage({
        type: "response",
        requestId: (httpReqs[1] as any).requestId,
        result: { status: 200, headers: {}, body: new TextEncoder().encode("B") },
      });
      worker.simulateMessage({
        type: "response",
        requestId: (httpReqs[0] as any).requestId,
        result: { status: 200, headers: {}, body: new TextEncoder().encode("A") },
      });
      const [respA, respB] = await Promise.all([a, b]);
      expect(new TextDecoder().decode(respA.body)).toBe("A");
      expect(new TextDecoder().decode(respB.body)).toBe("B");
    });
  });

  it("destroy() terminates the worker", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const bootPromise = kernel.boot({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      argv: ["/init"],
    });
    await new Promise((r) => setTimeout(r, 0));
    const w = MockWorker.instances[0]!;
    w.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));
    const spawn = w.lastMessage("spawn");
    w.simulateMessage({ type: "response", requestId: spawn.requestId, result: 100 });
    await bootPromise;

    const destroyPromise = kernel.destroy();
    await new Promise((r) => setTimeout(r, 0));
    const destroyMsg = w.lastMessage("destroy");
    expect(destroyMsg).toBeDefined();
    w.simulateMessage({ type: "response", requestId: destroyMsg.requestId, result: true });
    await destroyPromise;
    expect(w.terminated).toBe(true);
  });
});
