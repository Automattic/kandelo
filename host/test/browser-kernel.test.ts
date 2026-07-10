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
import { createHash } from "node:crypto";
import { WASM_PAGE_SIZE } from "../src/constants";
import type { HttpResponse } from "../src/networking";

const defaultArtifactModuleState = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../src/browser-kernel-default-artifacts", () => {
  defaultArtifactModuleState.loads += 1;
  return {
    browserKernelDefaultArtifactUrls: {
      kernelWasm: "stub://default-kernel",
      rootfsVfs: "stub://default-rootfs",
    },
  };
});

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------

interface CapturedMessage {
  data: any;
  transfer: Transferable[];
}

class MockWorker {
  static instances: MockWorker[] = [];
  static detachTransfers = false;
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
    if (MockWorker.detachTransfers) {
      const cloned = structuredClone(data, { transfer });
      this.sent.push({ data: cloned, transfer: [...transfer] });
      return;
    }
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
    MockWorker.detachTransfers = false;
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

  it("does not load or fetch default artifacts when both byte arrays are explicit", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const kernelWasm = new Uint8Array([1, 2, 3]).buffer;
    const vfsImage = new Uint8Array([4, 5, 6]);
    const initPromise = kernel.initFromImage({ kernelWasm, vfsImage });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const init = worker.lastMessage("init");
    expect(defaultArtifactModuleState.loads).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(new Uint8Array(init.kernelWasmBytes)).toEqual(
      new Uint8Array(kernelWasm),
    );
    expect(init.vfsImage).toBe(vfsImage);

    worker.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("fetches the bundled kernel only when kernel bytes are omitted", async () => {
    const defaultKernel = new Uint8Array([7, 8, 9]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("stub://default-kernel");
      return {
        arrayBuffer: async () => defaultKernel.buffer.slice(0),
      };
    }));
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const vfsImage = new Uint8Array([10, 11]);
    const initPromise = kernel.initFromImage({ vfsImage });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const init = worker.lastMessage("init");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(init.kernelWasmBytes)).toEqual(defaultKernel);
    expect(init.vfsImage).toBe(vfsImage);

    worker.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("fetches the bundled rootfs only for the default VFS sentinel", async () => {
    const defaultRootfs = new Uint8Array([12, 13, 14]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("stub://default-rootfs");
      return {
        arrayBuffer: async () => defaultRootfs.buffer.slice(0),
      };
    }));
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const kernelWasm = new Uint8Array([15, 16]).buffer;
    const initPromise = kernel.initFromImage({
      kernelWasm,
      vfsImage: "default",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const init = worker.lastMessage("init");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(init.kernelWasmBytes)).toEqual(
      new Uint8Array(kernelWasm),
    );
    expect(init.vfsImage).toEqual(defaultRootfs);

    worker.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("snapshots and transfers an exhaustive lazy-asset binding to the worker", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const source = new Uint8Array([1, 2, 3, 4]);
    const url = "https://github.com/example/project/releases/download/v1/a.tar.gz";
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      closedLazyAssets: [{
        url,
        sha256: createHash("sha256").update(source).digest("hex"),
        size: source.byteLength,
        bytes: source,
      }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const captured = worker.sent.find(({ data }) => data?.type === "init")!;
    const sentAsset = captured.data.closedLazyAssets[0];
    expect(sentAsset.bytes).not.toBe(source);
    expect(captured.transfer).toContain(sentAsset.bytes.buffer);
    expect(captured.transfer).not.toContain(source.buffer);
    source.fill(9);
    expect(sentAsset.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));

    worker.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("preserves caller bytes through initFromImage copy semantics", async () => {
    MockWorker.detachTransfers = true;
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const sourceBuffer = new ArrayBuffer(4);
    new Uint8Array(sourceBuffer).set([1, 2, 3, 4]);
    const source = new Uint8Array(sourceBuffer);
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: source,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const captured = worker.sent.find(({ data }) => data?.type === "init")!;
    expect(captured.transfer).not.toContain(sourceBuffer);
    expect(sourceBuffer.byteLength).toBe(4);
    expect(source).toEqual(new Uint8Array([1, 2, 3, 4]));
    source.fill(9);
    expect(captured.data.vfsImage).toEqual(new Uint8Array([1, 2, 3, 4]));

    worker.simulateMessage({ type: "ready" });
    await initPromise;
    expect(sourceBuffer.byteLength).toBe(4);
  });

  it("detaches exactly the caller-owned VFS buffer through initFromOwnedImage", async () => {
    MockWorker.detachTransfers = true;
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const owned = new ArrayBuffer(4);
    new Uint8Array(owned).set([4, 3, 2, 1]);
    const initPromise = kernel.initFromOwnedImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: owned,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const captured = worker.sent.find(({ data }) => data?.type === "init")!;
    expect(owned.byteLength).toBe(0);
    expect(captured.data.vfsImage).toEqual(new Uint8Array([4, 3, 2, 1]));

    worker.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("boots and spawns from a caller-owned VFS image", async () => {
    MockWorker.detachTransfers = true;
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const owned = new ArrayBuffer(3);
    new Uint8Array(owned).set([7, 8, 9]);
    const bootPromise = kernel.bootFromOwnedImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: owned,
      argv: ["/bin/init"],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    expect(owned.byteLength).toBe(0);
    worker.simulateMessage({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const spawn = worker.lastMessage("spawn");
    expect(spawn.programPath).toBe("/bin/init");
    worker.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 100,
    });
    const { exit } = await bootPromise;
    worker.simulateMessage({ type: "exit", pid: 100, status: 0 });
    await expect(exit).resolves.toBe(0);
  });

  it("keeps an explicitly empty lazy transport closed in the worker", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      closedLazyAssets: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    expect(worker.lastMessage("init").closedLazyAssets).toEqual([]);
    worker.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("boot() spawns a worker, sends init, and resolves on `ready`", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      corsProxyUrl: "https://proxy.example/?url=",
    });

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
    expect(init.config.corsProxyUrl).toBe("https://proxy.example/?url=");

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

  it("preserves a short spawnFromVfs exit that precedes the spawn response continuation", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const spawnPromise = kernel.spawnFromVfs("/bin/true", ["/bin/true"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const spawn = worker.lastMessage("spawn");
    worker.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 101,
    });
    // A tiny process can exit before the resolved request promise resumes and
    // installs its pid-indexed waiter on the browser main thread.
    worker.simulateMessage({ type: "exit", pid: 101, status: 0 });

    const { pid, exit } = await spawnPromise;
    expect(pid).toBe(101);
    expect(await Promise.race([
      exit,
      new Promise<number>((resolve) => setTimeout(() => resolve(-999), 50)),
    ])).toBe(0);
  });

  it("uses the worker pid when fork has reserved the preceding pid", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const bootPromise = kernel.boot({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      argv: ["/bin/parent"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initialSpawn = worker.lastMessage("spawn");
    worker.simulateMessage({
      type: "response",
      requestId: initialSpawn.requestId,
      result: 100,
    });
    await bootPromise;
    worker.simulateMessage({ type: "proc_event", kind: "spawn", pid: 101, ppid: 100 });

    const onStarted = vi.fn();
    const exitPromise = kernel.spawn(new ArrayBuffer(8), ["/bin/true"], {
      onStarted,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const spawn = worker.lastMessage("spawn");

    // The main thread cannot know that a guest fork has reserved pid 101 but
    // has not yet finished registering its process worker. Only the Rust
    // kernel's authoritative task-ID allocator can assign the next ID safely.
    expect(spawn).not.toHaveProperty("pid");
    worker.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 102,
    });
    worker.simulateMessage({ type: "exit", pid: 102, status: 0 });

    expect(await Promise.race([
      exitPromise,
      new Promise<number>((resolve) => setTimeout(() => resolve(-999), 50)),
    ])).toBe(0);
    expect(onStarted).toHaveBeenCalledWith(102);
  });

  it("delivers host diagnostics without contaminating guest stderr", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const onHostDiagnostic = vi.fn();
    const onStderr = vi.fn();
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic,
      onStderr,
    });

    const bootPromise = kernel.boot({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      argv: ["/init"],
    });
    await new Promise((r) => setTimeout(r, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));
    const spawn = worker.lastMessage("spawn");
    worker.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 100,
    });
    await bootPromise;

    worker.simulateMessage({
      type: "host_diagnostic",
      pid: 100,
      status: 132,
      source: "worker-main error message",
      message: "[process-worker] RuntimeError: unreachable",
    });

    expect(onHostDiagnostic).toHaveBeenCalledOnce();
    expect(onHostDiagnostic).toHaveBeenCalledWith({
      pid: 100,
      status: 132,
      source: "worker-main error message",
      message: "[process-worker] RuntimeError: unreachable",
    });
    expect(onStderr).not.toHaveBeenCalled();
  });

  it("attributes browser stdout and stderr to the emitting process", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const onProcessStdout = vi.fn();
    const onProcessStderr = vi.fn();
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onProcessStdout,
      onProcessStderr,
    });
    const handle = (
      kernel as unknown as { handleWorkerMessage(message: unknown): void }
    ).handleWorkerMessage.bind(kernel);
    const stdout = new Uint8Array([1, 2]);
    const stderr = new Uint8Array([3, 4]);

    handle({ type: "stdout", pid: 41, data: stdout });
    handle({ type: "stderr", pid: 314, data: stderr });

    expect(onProcessStdout).toHaveBeenCalledWith(41, stdout);
    expect(onProcessStderr).toHaveBeenCalledWith(314, stderr);
  });

  it("reports a worker-level error as a host diagnostic, not guest stderr", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const onHostDiagnostic = vi.fn();
    const onStderr = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic,
      onStderr,
    });

    const bootPromise = kernel.boot({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
      argv: ["/init"],
    });
    await new Promise((r) => setTimeout(r, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));
    const spawn = worker.lastMessage("spawn");
    worker.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 100,
    });
    const { exit } = await bootPromise;
    const exitRejection = expect(exit).rejects.toThrow(
      "Kernel worker error: worker crashed",
    );

    worker.onerror?.({ message: "worker crashed" });
    await exitRejection;

    expect(onHostDiagnostic).toHaveBeenCalledOnce();
    expect(onHostDiagnostic).toHaveBeenCalledWith({
      pid: 0,
      source: "kernel worker",
      message: "[BrowserKernel] kernel worker error: worker crashed",
    });
    expect(onStderr).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[BrowserKernel] kernel worker error: worker crashed",
    );
  });

  it("fails pending and future work when the kernel worker reports a fatal instance", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const spawnPromise = kernel.spawnFromVfs("/bin/sleep", ["/bin/sleep"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const spawn = worker.lastMessage("spawn");
    worker.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 101,
    });
    const { exit } = await spawnPromise;

    const pendingRequest = kernel.getKernelMemoryPages();
    const fatalMessage = "reserved transfer execution trapped";
    const pendingRejection = expect(pendingRequest).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );
    const exitRejection = expect(exit).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );
    const messagesBeforeFatal = worker.sent.length;

    worker.simulateMessage({ type: "kernel_fatal", error: fatalMessage });

    await Promise.all([pendingRejection, exitRejection]);
    expect(worker.terminated).toBe(true);

    await expect(kernel.getKernelMemoryPages()).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );
    expect(worker.sent).toHaveLength(messagesBeforeFatal);
  });

  it("rejects initialization when the kernel becomes fatal before ready", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;

    worker.simulateMessage({
      type: "kernel_fatal",
      error: "kernel initialization trapped",
    });

    await expect(initPromise).rejects.toThrow(
      "Kernel worker failed: kernel initialization trapped",
    );
    expect(worker.terminated).toBe(true);
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
    worker.simulateMessage({ type: "proc_event", kind: "spawn", pid: 101, ppid: 100 });
    worker.simulateMessage({ type: "proc_event", kind: "exec", pid: 101 });

    expect(processEvents).toEqual([
      { kind: "spawn", pid: 101, ppid: 100 },
      { kind: "exec", pid: 101 },
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

  it("signalProcess round-trips through the browser kernel worker", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const signalPromise = kernel.signalProcess(41, 15);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const signal = worker.lastMessage("signal_process");
    expect(signal).toMatchObject({ pid: 41, signum: 15 });
    worker.simulateMessage({
      type: "response",
      requestId: signal.requestId,
      result: true,
    });
    await expect(signalPromise).resolves.toBe(true);
  });

  it("mutates files through the VFS-owning worker with lossless snapshots", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((r) => setTimeout(r, 0));
    const w = MockWorker.instances[0]!;
    w.simulateMessage({ type: "ready" });
    await initPromise;

    const original = new Uint8Array([9, 8, 7]);
    const writePromise = kernel.writeFileToVfs("/php-src/generated.php", original, 0o640);
    await new Promise((r) => setTimeout(r, 0));
    const write = w.lastMessage("write_vfs_file");
    expect(write).toMatchObject({
      path: "/php-src/generated.php",
      mode: 0o640,
    });
    expect(write.data).toEqual(original);
    expect(write.data).not.toBe(original);
    w.simulateMessage({
      type: "response",
      requestId: write.requestId,
      result: true,
    });
    await writePromise;

    const snapshotPromise = kernel.readFileSnapshotFromVfs("/php-src/generated.php");
    await new Promise((r) => setTimeout(r, 0));
    const read = w.lastMessage("read_vfs_file");
    expect(read).toMatchObject({
      path: "/php-src/generated.php",
      includeMode: true,
    });
    const snapshot = { data: new Uint8Array([1, 2]), mode: 0o751 };
    w.simulateMessage({
      type: "response",
      requestId: read.requestId,
      result: snapshot,
    });
    expect(await snapshotPromise).toEqual(snapshot);

    const unlinkPromise = kernel.unlinkFileFromVfs("/php-src/generated.php");
    await new Promise((r) => setTimeout(r, 0));
    const unlink = w.lastMessage("unlink_vfs_file");
    expect(unlink.path).toBe("/php-src/generated.php");
    w.simulateMessage({
      type: "response",
      requestId: unlink.requestId,
      result: true,
    });
    expect(await unlinkPromise).toBe(true);
  });

  it("rejects rootfs export before the kernel worker is initialized", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });

    await expect(kernel.exportRootfsImage()).rejects.toThrow(
      "rootfs export requires an initialized kernel",
    );
    expect(MockWorker.instances).toHaveLength(0);
    await expect(kernel.destroy()).resolves.toBeUndefined();
  });

  it("returns the exact rootfs bytes supplied by the worker", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const exportPromise = kernel.exportRootfsImage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = worker.lastMessage("export_rootfs_image");
    expect(request).toMatchObject({ type: "export_rootfs_image" });
    const expected = new Uint8Array([0, 255, 7, 91]);
    worker.simulateMessage({
      type: "response",
      requestId: request.requestId,
      result: expected,
    });

    const actual = await exportPromise;
    expect(actual).toBe(expected);
    expect(actual).toEqual(new Uint8Array([0, 255, 7, 91]));
  });

  it("fails closed for malformed and rejected rootfs export responses", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const malformedPromise = kernel.exportRootfsImage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const malformed = worker.lastMessage("export_rootfs_image");
    worker.simulateMessage({
      type: "response",
      requestId: malformed.requestId,
      result: [1, 2, 3],
    });
    await expect(malformedPromise).rejects.toThrow(
      "kernel worker returned an invalid rootfs image",
    );

    const rejectedPromise = kernel.exportRootfsImage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejected = worker.lastMessage("export_rootfs_image");
    worker.simulateMessage({
      type: "response",
      requestId: rejected.requestId,
      result: null,
      error: "rootfs export is already in progress",
    });
    await expect(rejectedPromise).rejects.toThrow(
      "rootfs export is already in progress",
    );
  });

  it("keeps concurrent rootfs export responses paired to their requests", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const first = kernel.exportRootfsImage();
    const second = kernel.exportRootfsImage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const requests = worker.sent
      .map(({ data }) => data)
      .filter((message) => message?.type === "export_rootfs_image");
    expect(requests).toHaveLength(2);

    worker.simulateMessage({
      type: "response",
      requestId: requests[1].requestId,
      result: null,
      error: "rootfs export is already in progress",
    });
    worker.simulateMessage({
      type: "response",
      requestId: requests[0].requestId,
      result: new Uint8Array([4, 2]),
    });

    await expect(first).resolves.toEqual(new Uint8Array([4, 2]));
    await expect(second).rejects.toThrow(
      "rootfs export is already in progress",
    );
  });

  it("reads and validates kernel allocator page telemetry", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const pagesPromise = kernel.getKernelMemoryPages();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = worker.lastMessage("get_kernel_memory_pages");
    expect(request).toBeDefined();
    worker.simulateMessage({
      type: "response",
      requestId: request.requestId,
      result: 321,
    });
    await expect(pagesPromise).resolves.toBe(321);

    const invalidPromise = kernel.getKernelMemoryPages();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const invalidRequest = worker.lastMessage("get_kernel_memory_pages");
    worker.simulateMessage({
      type: "response",
      requestId: invalidRequest.requestId,
      result: "321",
    });
    await expect(invalidPromise).rejects.toThrow("invalid memory-page count");
  });

  it("reads and validates retained spawn scratch telemetry", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const capacityPromise = kernel.getSpawnScratchCapacity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = worker.lastMessage("get_spawn_scratch_capacity");
    expect(request).toBeDefined();
    worker.simulateMessage({
      type: "response",
      requestId: request.requestId,
      result: 84_386,
    });
    await expect(capacityPromise).resolves.toBe(84_386);

    const invalidPromise = kernel.getSpawnScratchCapacity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const invalidRequest = worker.lastMessage("get_spawn_scratch_capacity");
    worker.simulateMessage({
      type: "response",
      requestId: invalidRequest.requestId,
      result: -1,
    });
    await expect(invalidPromise).rejects.toThrow(
      "invalid spawn scratch capacity",
    );
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

  it("destroy() terminates the worker after graceful generation detach", async () => {
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
    w.simulateMessage({
      type: "response",
      requestId: destroyMsg.requestId,
      result: { gracefulDetachComplete: true },
    });
    await destroyPromise;
    expect(w.terminated).toBe(true);
  });

  it("uses worker-realm termination as the final release fallback", async () => {
    const diagnostics: string[] = [];
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((r) => setTimeout(r, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initPromise;

    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    (
      kernel as unknown as {
        handleWorkerMessage(message: unknown): void;
      }
    ).handleWorkerMessage({
      type: "fb_bind",
      pid: 41,
      generation: 1,
      addr: 0,
      len: WASM_PAGE_SIZE,
      w: 128,
      h: 128,
      stride: 512,
      fmt: "BGRA32",
      memory,
    });
    (
      kernel as unknown as {
        pendingPtyOutput: Map<number, Uint8Array[]>;
      }
    ).pendingPtyOutput.set(41, [new Uint8Array([1])]);

    const destroyPromise = kernel.destroy();
    await new Promise((r) => setTimeout(r, 0));
    const destroyMsg = worker.lastMessage("destroy");
    worker.simulateMessage({
      type: "response",
      requestId: destroyMsg.requestId,
      result: { gracefulDetachComplete: false },
    });
    await destroyPromise;

    expect(worker.terminated).toBe(true);
    expect(kernel.getProcessMemory(41)).toBeUndefined();
    expect(kernel.framebuffers.get(41)).toBeUndefined();
    expect(
      (
        kernel as unknown as {
          pendingPtyOutput: Map<number, Uint8Array[]>;
        }
      ).pendingPtyOutput.size,
    ).toBe(0);
    expect(diagnostics).toEqual([
      expect.stringContaining("incomplete graceful generation detach"),
    ]);
  });

  it("fails closed when PTY output floods the pre-listener race window", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const testable = kernel as unknown as {
      handleWorkerMessage(message: unknown): void;
      pendingPtyOutput: Map<number, unknown>;
      pendingPtyOutputBytes: number;
      pendingPtyOutputChunks: number;
    };

    const chunk = new Uint8Array(4_096);
    for (let index = 0; index < 17; index += 1) {
      testable.handleWorkerMessage({
        type: "pty_output",
        pid: 41,
        data: chunk,
      });
    }

    expect(testable.pendingPtyOutput.size).toBe(0);
    expect(testable.pendingPtyOutputBytes).toBe(0);
    expect(testable.pendingPtyOutputChunks).toBe(0);
    expect(() => kernel.onPtyOutput(41, vi.fn())).toThrow(
      "PTY output exceeded the 65536-byte pre-listener limit",
    );

    // Once the boundary fails, further candidate messages must not allocate.
    for (let index = 0; index < 100; index += 1) {
      testable.handleWorkerMessage({
        type: "pty_output",
        pid: 41,
        data: chunk,
      });
    }
    expect(testable.pendingPtyOutput.size).toBe(0);
    expect(testable.pendingPtyOutputBytes).toBe(0);
    expect(testable.pendingPtyOutputChunks).toBe(0);
  });

  it("bounds graceful destroy wait before terminating the worker realm", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: string[] = [];
      const BrowserKernel = await loadBrowserKernel();
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });
      const testable = kernel as unknown as {
        workerStarted: boolean;
        initialized: boolean;
        kernelWorkerHandle: { terminated: boolean; terminate(): void };
        pendingRequests: Map<number, unknown>;
        request(): Promise<never>;
      };
      const worker = new MockWorker("mock://kernel");
      testable.workerStarted = true;
      testable.initialized = true;
      testable.kernelWorkerHandle = worker;
      testable.pendingRequests.set(99, {});
      testable.request = vi.fn(() => new Promise<never>(() => {}));

      const destroyPromise = kernel.destroy();
      await vi.advanceTimersByTimeAsync(2_000);
      await destroyPromise;

      expect(worker.terminated).toBe(true);
      expect(testable.pendingRequests.size).toBe(0);
      expect(diagnostics).toEqual([
        expect.stringContaining("timed out after 2000ms"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears browser aliases when worker termination itself throws", async () => {
    const diagnostics: string[] = [];
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    const testable = kernel as unknown as {
      workerStarted: boolean;
      initialized: boolean;
      kernelWorkerHandle: MockWorker;
      pendingRequests: Map<number, unknown>;
      request(): Promise<{ gracefulDetachComplete: true }>;
    };
    const worker = new MockWorker("mock://kernel");
    worker.terminate = () => {
      throw new Error("injected terminate failure");
    };
    testable.workerStarted = true;
    testable.initialized = true;
    testable.kernelWorkerHandle = worker;
    testable.pendingRequests.set(99, {});
    testable.request = vi.fn(async () => ({
      gracefulDetachComplete: true,
    }));

    await kernel.destroy();

    expect(testable.pendingRequests.size).toBe(0);
    expect(diagnostics).toEqual([
      expect.stringContaining(
        "kernel-worker realm termination failed: injected terminate failure",
      ),
    ]);
  });

  it("drops framebuffer Memory aliases on clean and trap exits", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const dispatch = (
      kernel as unknown as {
        handleWorkerMessage(message: unknown): void;
      }
    ).handleWorkerMessage.bind(kernel);

    for (const [pid, status] of [[41, 0], [42, -1]] as const) {
      const memory = new WebAssembly.Memory({
        initial: 1,
        maximum: 1,
        shared: true,
      });
      dispatch({
        type: "fb_bind",
        pid,
        generation: pid,
        addr: 0,
        len: WASM_PAGE_SIZE,
        w: 128,
        h: 128,
        stride: 512,
        fmt: "BGRA32",
        memory,
      });
      expect(kernel.getProcessMemory(pid)).toBe(memory);
      expect(kernel.framebuffers.get(pid)).toBeDefined();

      dispatch({ type: "exit", pid, generation: pid, status });
      expect(kernel.getProcessMemory(pid)).toBeUndefined();
      expect(kernel.framebuffers.get(pid)).toBeUndefined();
    }
  });

  it("keeps an exec successor when stale framebuffer messages arrive", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const worker = new MockWorker("mock://kernel");
    (
      kernel as unknown as { kernelWorkerHandle: MockWorker }
    ).kernelWorkerHandle = worker;
    const dispatch = (
      kernel as unknown as {
        handleWorkerMessage(message: unknown): void;
      }
    ).handleWorkerMessage.bind(kernel);
    const pid = 41;
    const oldMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const successorMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });

    const bind = (
      generation: number,
      memory: WebAssembly.Memory,
    ) => dispatch({
      type: "fb_bind",
      pid,
      generation,
      addr: 64,
      len: 1024,
      w: 16,
      h: 16,
      stride: 64,
      fmt: "BGRA32",
      memory,
    });
    bind(1, oldMemory);
    bind(2, successorMemory);

    // WHY: exec preserves the PID. Queued teardown from generation 1 must
    // never clear or reinstall its alias after generation 2 is visible.
    dispatch({
      type: "fb_rebind_memory",
      pid,
      generation: 1,
      memory: oldMemory,
    });
    dispatch({ type: "fb_unbind", pid, generation: 1 });
    dispatch({ type: "exit", pid, generation: 1, status: 0 });
    dispatch({
      type: "fb_release_generation",
      requestId: 73,
      pid,
      generation: 1,
    });

    expect(kernel.getProcessMemory(pid)).toBe(successorMemory);
    expect(kernel.framebuffers.get(pid)).toBeDefined();
    expect(worker.lastMessage("fb_release_generation_ack")).toEqual({
      type: "fb_release_generation_ack",
      requestId: 73,
    });

    dispatch({
      type: "fb_release_generation",
      requestId: 74,
      pid,
      generation: 2,
    });
    expect(kernel.getProcessMemory(pid)).toBeUndefined();
    expect(kernel.framebuffers.get(pid)).toBeUndefined();
    expect(worker.lastMessage("fb_release_generation_ack")).toEqual({
      type: "fb_release_generation_ack",
      requestId: 74,
    });

    // A bind from the just-released generation can be queued around teardown.
    // Keep a short terminal tombstone until the worker observes the ACK.
    bind(2, successorMemory);
    expect(kernel.getProcessMemory(pid)).toBeUndefined();
    expect(kernel.framebuffers.get(pid)).toBeUndefined();
    expect(
      (
        kernel as unknown as {
          fbGenerationByPid: Map<
            number,
            { generation: number; released: boolean }
          >;
        }
      ).fbGenerationByPid.get(pid),
    ).toEqual({ generation: 2, released: true });

    dispatch({ type: "fb_forget_generation", pid, generation: 2 });
    expect(
      (
        kernel as unknown as {
          fbGenerationByPid: Map<number, unknown>;
        }
      ).fbGenerationByPid.has(pid),
    ).toBe(false);
  });

  it("allows an ordinary same-generation framebuffer reopen after unbind", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const dispatch = (
      kernel as unknown as {
        handleWorkerMessage(message: unknown): void;
      }
    ).handleWorkerMessage.bind(kernel);
    const pid = 51;
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const bind = () => dispatch({
      type: "fb_bind",
      pid,
      generation: 3,
      addr: 64,
      len: 1024,
      w: 16,
      h: 16,
      stride: 64,
      fmt: "BGRA32",
      memory,
    });

    bind();
    dispatch({ type: "fb_unbind", pid, generation: 3 });
    expect(kernel.getProcessMemory(pid)).toBeUndefined();
    bind();
    expect(kernel.getProcessMemory(pid)).toBe(memory);
  });
});
