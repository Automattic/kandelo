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
import { PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS } from "../src/kernel-realm-destroy";

const defaultArtifactModuleState = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../src/vfs/opfs-file-reference", () => ({ referenceOpfsFile: async () => ({ path: ["probe.vfs"] }) }));
vi.mock("../src/browser-kernel-default-artifacts", () => {
  defaultArtifactModuleState.loads += 1;
  return {
    browserKernelDefaultArtifactUrls: {
      kernelWasm: "stub://default-kernel",
    },
    // WHY a function, not a URL constant: the canonical rootfs is resolved on
    // demand so it stays out of every entry point's eager dependency graph.
    browserDefaultRootfsVfsUrl: async () => "stub://default-rootfs",
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

function stubPersistenceWebLocks(): Set<string> {
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string, _options: unknown, operation: (lock: object | null) => Promise<unknown>) => {
        if (held.has(name)) return operation(null);
        held.add(name);
        try {
          return await operation({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
  return held;
}

// SharedArrayBuffer + WebAssembly.Memory aren't available in some Node
// configurations. We use the real ones (Node supports them) but stub the
// kernelOwnedFs path so the constructor doesn't try to format a SAB.
async function loadBrowserKernel() {
  // Dynamic import after globals are stubbed.
  const mod = await import("../src/browser-kernel-host");
  return mod.BrowserKernel as typeof import("../src/browser-kernel-host").BrowserKernel;
}

function browserAudioGlobals() {
  const addModule = vi.fn(async () => {});
  const context = {
    state: "suspended" as AudioContextState,
    sampleRate: 48_000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    renderQuantumSize: 128,
    destination: {},
    audioWorklet: { addModule },
    onstatechange: null as (() => void) | null,
    resume: vi.fn(async function (this: typeof context) {
      this.state = "running";
      this.onstatechange?.();
    }),
    suspend: vi.fn(async function (this: typeof context) {
      this.state = "suspended";
      this.onstatechange?.();
    }),
    close: vi.fn(async function (this: typeof context) {
      this.state = "closed";
      this.onstatechange?.();
    }),
  };
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn((message: { type: string }) => {
      if (message.type === "detach") queueMicrotask(() => port.onmessage?.({ data: { type: "detached" } } as MessageEvent));
    }),
    close: vi.fn(),
  };
  const node = {
    port,
    onprocessorerror: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  let nodeOptions: AudioWorkletNodeOptions | undefined;
  const AudioContextCtor = vi.fn(function () {
    return context;
  });
  const AudioWorkletNodeCtor = vi.fn(function (
    _context: AudioContext,
    _name: string,
    options: AudioWorkletNodeOptions,
  ) {
    nodeOptions = options;
    return node;
  });
  vi.stubGlobal("AudioContext", AudioContextCtor);
  vi.stubGlobal("AudioWorkletNode", AudioWorkletNodeCtor);
  return {
    addModule,
    context,
    node,
    AudioContextCtor,
    AudioWorkletNodeCtor,
    get nodeOptions() { return nodeOptions; },
  };
}


describe("BrowserKernel", () => {
  beforeEach(() => {
    // [RUNTIME-WORKAROUND: WEBKIT-AUDIOWORKLET-CLOSE-LEAK]
    // browser-pcm-driver.ts holds one page-wide AudioContext in module scope
    // and deliberately never closes it, so without this reset a later test's
    // driver reuses an earlier test's mock context and its own suspend/close
    // spies are never called.
    vi.resetModules();
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

  it("routes scalar snapshot progress only to its live export request", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const init = kernel.initFromImage({ kernelWasm: new ArrayBuffer(1), vfsImage: Uint8Array.of(1) });
    await new Promise(resolve => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await init;
    const progress = vi.fn();
    const exporting = kernel.exportRootfsImageToFile({} as FileSystemFileHandle, progress);
    await vi.waitFor(() => expect(worker.lastMessage("export_rootfs_image_to_file")).toBeDefined());
    const request = worker.lastMessage("export_rootfs_image_to_file");
    expect(request.file).toEqual({ path: ["probe.vfs"] });
    expect(request.reportProgress).toBe(true);
    const event = { phase: "verifying", completed: 4, total: 8 };
    worker.simulateMessage({ type: "rootfs_image_export_progress", requestId: request.requestId + 1, progress: event });
    expect(progress).not.toHaveBeenCalled();
    worker.simulateMessage({ type: "rootfs_image_export_progress", requestId: request.requestId, progress: event });
    expect(progress).toHaveBeenCalledExactlyOnceWith(event);
    worker.simulateMessage({ type: "response", requestId: request.requestId, result: { length: 8, chunkBytes: 1024 * 1024, chunkSha256: ["a".repeat(64)] } });
    await exporting;
    worker.simulateMessage({ type: "rootfs_image_export_progress", requestId: request.requestId, progress: event });
    expect(progress).toHaveBeenCalledTimes(1);
    const rejected = kernel.exportRootfsImageToFile({} as FileSystemFileHandle, progress);
    await vi.waitFor(() => expect(worker.lastMessage("export_rootfs_image_to_file").requestId).not.toBe(request.requestId));
    const failedRequest = worker.lastMessage("export_rootfs_image_to_file");
    worker.simulateMessage({ type: "response", requestId: failedRequest.requestId, error: "storage full" });
    await expect(rejected).rejects.toThrow("storage full");
    worker.simulateMessage({ type: "rootfs_image_export_progress", requestId: failedRequest.requestId, progress: event });
    expect(progress).toHaveBeenCalledTimes(1);
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
        ok: true,
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

    // The rootfs URL is resolved on demand, so boot waits on a dynamic module
    // load and one extra await before the worker is constructed.
    while (MockWorker.instances.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
      lazyAssetDirectory: "https://example.test/deployment/vfs-group/",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const captured = worker.sent.find(({ data }) => data?.type === "init")!;
    expect(owned.byteLength).toBe(0);
    expect(captured.data.vfsImage).toEqual(new Uint8Array([4, 3, 2, 1]));
    expect(captured.data.lazyAssetDirectory).toBe("https://example.test/deployment/vfs-group/");

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

  it("snapshots the complete CORS proxy configuration before worker startup", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const allowedRequestHeaderNames = [
      "Accept",
      "content-type",
      "Accept",
    ];
    const corsProxy = {
      url: "https://proxy.example/?url=",
      allowedRequestHeaderNames,
      allowAnonymousGetHeaderOmission: true,
    };
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      corsProxy,
    });
    corsProxy.url = "https://mutated.example/?url=";
    allowedRequestHeaderNames.splice(
      0,
      allowedRequestHeaderNames.length,
      "x-mutated",
    );

    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(MockWorker.instances).toHaveLength(1);
    const w = MockWorker.instances[0]!;
    const init = w.lastMessage("init");
    expect(init.config.corsProxy).toEqual({
      url: "https://proxy.example/?url=",
      allowedRequestHeaderNames: ["Accept", "content-type", "Accept"],
      allowAnonymousGetHeaderOmission: true,
    });
    expect(Object.isFrozen(init.config.corsProxy)).toBe(true);
    expect(
      Object.isFrozen(init.config.corsProxy.allowedRequestHeaderNames),
    ).toBe(true);

    w.simulateMessage({ type: "ready" });
    await initPromise;
  });

  it("rejects a malformed CORS proxy configuration before starting a worker", async () => {
    const BrowserKernel = await loadBrowserKernel();

    expect(() => new BrowserKernel({
      kernelOwnedFs: true,
      corsProxy: {
        url: "file:///tmp/not-a-proxy",
        allowedRequestHeaderNames: ["accept"],
        allowAnonymousGetHeaderOmission: true,
      },
    })).toThrow("browser CORS proxy URL must be an HTTP(S) URL");

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
    await new Promise((r) => setTimeout(r, 0));
    expect(MockWorker.instances).toHaveLength(1);
    const w = MockWorker.instances[0]!;
    const init = w.lastMessage("init");
    expect(init).toBeDefined();
    expect(init.argv).toBeUndefined();
    expect(init.kernelWasmBytes).toBeInstanceOf(ArrayBuffer);

    // Simulate the worker becoming ready, then reply to the spawn request.
    w.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));

    const spawn = w.lastMessage("spawn");
    expect(spawn).toBeDefined();
    expect(spawn.argv).toEqual(["/init"]);
    expect(typeof spawn.requestId).toBe("number");

    w.simulateMessage({
      type: "response",
      requestId: spawn.requestId,
      result: 100,
    });
    const { pid, exit } = await bootPromise;
    expect(pid).toBe(100);

    let exitResolved: number | null = null;
    exit.then((code) => { exitResolved = code; });
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

    const owner = kernel.getOwnedJobLifetime();
    expect(owner.closed).toBe(false);
    worker.onerror?.({ message: "worker crashed" });
    await exitRejection;
    expect(owner.closed).toBe(true);

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

    const owner = kernel.getOwnedJobLifetime();
    expect(owner.closed).toBe(false);
    worker.simulateMessage({ type: "kernel_fatal", error: fatalMessage });

    await Promise.all([pendingRejection, exitRejection]);
    expect(worker.terminated).toBe(true);
    expect(owner.closed).toBe(true);

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

  it("readDirFromVfs round-trips a path to the worker and back", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    void kernel.boot({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0), argv: ["/init"] });
    await new Promise((r) => setTimeout(r, 0));
    const w = MockWorker.instances[0]!;
    w.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));

    const listPromise = kernel.readDirFromVfs("/home/maker/mcp");
    await new Promise((r) => setTimeout(r, 0));
    const list = w.lastMessage("read_vfs_dir");
    expect(list).toBeDefined();
    expect(list.path).toBe("/home/maker/mcp");
    const entries = [
      { name: "run_command.json", type: 8, mode: 0o100644, size: 12, uid: 0, gid: 0 },
    ];
    w.simulateMessage({ type: "response", requestId: list.requestId, result: entries });
    expect(await listPromise).toEqual(entries);
  });

  it("subscribeVfsChanges watches a prefix in the worker and fans out matching events", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    void kernel.boot({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0), argv: ["/init"] });
    await new Promise((r) => setTimeout(r, 0));
    const w = MockWorker.instances[0]!;
    w.simulateMessage({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));

    const seen: unknown[] = [];
    const off = kernel.subscribeVfsChanges("/home/maker/mcp", (event) => seen.push(event));
    const offOther = kernel.subscribeVfsChanges("/home/maker/mcp", () => {});
    expect(w.sent.filter(({ data }) => (data as any).type === "watch_vfs_changes").map(({ data }) => data)).toEqual([
      { type: "watch_vfs_changes", prefix: "/home/maker/mcp", enabled: true },
    ]);

    const inside = { kind: "modify", path: "/home/maker/mcp/foo.json", t: 1 };
    const outside = { kind: "delete", path: "/home/maker/foo.json", t: 2 };
    w.simulateMessage({ type: "vfs_change", event: inside });
    w.simulateMessage({ type: "vfs_change", event: outside });
    expect(seen).toEqual([inside]);

    off();
    expect(w.lastMessage("watch_vfs_changes").enabled).toBe(true);
    offOther();
    expect(w.lastMessage("watch_vfs_changes")).toEqual({ type: "watch_vfs_changes", prefix: "/home/maker/mcp", enabled: false });
    w.simulateMessage({ type: "vfs_change", event: inside });
    expect(seen).toEqual([inside]);
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

  it("rejects outstanding browser filesystem and HTTP requests after realm shutdown", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialized = kernel.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initialized;
    const settled = vi.fn();
    const requests = [
      kernel.readFileFromVfs("/pending"),
      kernel.fetchInKernel(80, { method: "GET", url: "/pending", headers: {}, body: new Uint8Array() }),
    ];
    for (const request of requests) {
      void request.then(() => settled("unexpected success"), error => settled(error));
    }

    const destroyed = kernel.destroy();
    await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
    const sentWhileClosing = worker.sent.length;
    const duringShutdown = Promise.allSettled([
      kernel.readFileFromVfs("/during-destroy"),
      kernel.fetchInKernel(80, { method: "GET", url: "/during-destroy", headers: {}, body: null }),
    ]);
    expect(worker.sent).toHaveLength(sentWhileClosing);
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await destroyed;
    for (const result of await duringShutdown) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("kernel host is not accepting requests");
    }

    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2), { timeout: 500 });
    for (const [error] of settled.mock.calls) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("kernel host destroyed");
    }
    expect(worker.terminated).toBe(true);
    const sent = worker.sent.length;
    await expect(kernel.readFileFromVfs("/after-destroy")).rejects.toThrow("kernel host is not accepting requests");
    await expect(kernel.fetchInKernel(80, { method: "GET", url: "/after-destroy", headers: {}, body: null }))
      .rejects.toThrow("kernel host is not accepting requests");
    expect(worker.sent).toHaveLength(sent);
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

    const owner = kernel.getOwnedJobLifetime();
    expect(owner.closed).toBe(false);
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
    expect(owner.closed).toBe(true);
    expect(kernel.getPersistenceShutdownFailure()).toBeNull();
  });

  it("uses worker-realm termination after incomplete graceful detach", async () => {
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

    const memory = new SharedArrayBuffer(WASM_PAGE_SIZE);
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
      pixels: memory,
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
    expect(kernel.framebuffers.get(41)?.hostBuffer?.buffer).toBeUndefined();
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

  it("allows worker cleanup to finish beyond the old two-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: string[] = [];
      const BrowserKernel = await loadBrowserKernel();
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.message),
      });
      const testable = kernel as unknown as {
        workerStarted: boolean;
        initialized: boolean;
        kernelWorkerHandle: MockWorker;
        request(): Promise<{ gracefulDetachComplete: true }>;
      };
      const worker = new MockWorker("mock://kernel");
      testable.workerStarted = true;
      testable.initialized = true;
      testable.kernelWorkerHandle = worker;
      testable.request = vi.fn(() => new Promise(resolve => {
        setTimeout(() => resolve({ gracefulDetachComplete: true }), 3_500);
      }));

      const destroyed = kernel.destroy();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(worker.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await destroyed;
      expect(worker.terminated).toBe(true);
      expect(diagnostics).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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
      testable.pendingRequests.set(99, { resolve: vi.fn(), reject: vi.fn() });
      testable.request = vi.fn(() => new Promise<never>(() => {}));

      const destroyPromise = kernel.destroy();
      await vi.advanceTimersByTimeAsync(15_000);
      await destroyPromise;

      expect(worker.terminated).toBe(true);
      expect(testable.pendingRequests.size).toBe(0);
      expect(diagnostics).toEqual([
        expect.stringContaining("timed out after 15000ms"),
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
    testable.pendingRequests.set(99, { resolve: vi.fn(), reject: vi.fn() });
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

  it("requires a computer identity for browser rootfs persistence", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    await expect(kernel.initFromOpfsImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle,
      experimentalFixedPersistenceName: "unnamed-computer-journal",
    })).rejects.toThrow("requires a computer name or lease");
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("holds a persistent journal lease until its worker realm terminates", async () => {
    const held = stubPersistenceWebLocks();
    const BrowserKernel = await loadBrowserKernel();
    const options = {
      kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle,
      experimentalFixedPersistenceName: "journal-lease-probe",
      persistentComputerName: "journal-lease-probe",
    };
    const first = new BrowserKernel({ kernelOwnedFs: true });
    const initialBoot = first.initFromOpfsImage(options);
    await expect(first.initFromOpfsImage({
      ...options,
      experimentalFixedPersistenceName: "other-journal-lease-probe",
    })).rejects.toThrow("already running");
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const firstWorker = MockWorker.instances[0]!;
    firstWorker.simulateMessage({ type: "ready" });
    await initialBoot;
    await expect(first.initFromOpfsImage(options)).rejects.toThrow("already running");

    const competing = new BrowserKernel({ kernelOwnedFs: true });
    const competingOptions = { ...options, persistentComputerName: "other-journal-lease-computer" };
    await expect(competing.initFromOpfsImage(competingOptions)).rejects.toThrow("journal is already open");
    expect(MockWorker.instances).toHaveLength(1);

    const testable = first as unknown as {
      initialized: boolean;
      workerStarted: boolean;
      request(): Promise<{ gracefulDetachComplete: true }>;
    };
    testable.request = vi.fn(async () => ({ gracefulDetachComplete: true }));
    firstWorker.terminate = () => { throw new Error("injected terminate failure"); };
    await first.destroy();
    expect(testable.workerStarted).toBe(true);
    expect(first.hasUnconfirmedKernelQuiescence()).toBe(true);
    await expect(competing.initFromOpfsImage(competingOptions)).rejects.toThrow("journal is already open");

    firstWorker.terminate = () => { firstWorker.terminated = true; };
    await first.destroy();
    expect(testable.workerStarted).toBe(false);
    expect(first.hasUnconfirmedKernelQuiescence()).toBe(false);
    expect(held.size).toBe(0);

    const retry = competing.initFromOpfsImage(competingOptions);
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    MockWorker.instances[1]!.simulateMessage({ type: "ready" });
    await retry;
    (competing as unknown as { request(): Promise<{ gracefulDetachComplete: true }> }).request =
      vi.fn(async () => ({ gracefulDetachComplete: true }));
    await competing.destroy();
    expect(held.size).toBe(0);

    const failed = new BrowserKernel({ kernelOwnedFs: true });
    const failedBoot = failed.initFromOpfsImage(options);
    const failedBootRejection = expect(failedBoot).rejects.toThrow("injected initialization failure");
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(3));
    const failedWorker = MockWorker.instances[2]!;
    const rejectedCleanup = vi.fn(async () => { throw new Error("injected storage close failure"); });
    (failed as unknown as { request(): Promise<unknown> }).request = rejectedCleanup;
    failedWorker.simulateMessage({ type: "init_error", error: "injected initialization failure" });
    await failedBootRejection;
    expect(rejectedCleanup).toHaveBeenCalledOnce();
    expect(failed.hasUnconfirmedKernelQuiescence()).toBe(true);
    expect(held.size).toBe(2);
  });

  it.each(["fixed", "resizable"] as const)("retains %s initialization ownership without assuming partial storage is closed", async (mode) => {
    for (const outcome of ["ordinary", "fatal"] as const) {
      const held = stubPersistenceWebLocks();
      const BrowserKernel = await loadBrowserKernel();
      const name = `failed-init-${mode}-${outcome}`;
      const kernel = new BrowserKernel({ kernelOwnedFs: true });
      const initialization = kernel.initFromOpfsImage({
        kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
        persistentComputerName: name,
        ...(mode === "fixed" ? { experimentalFixedPersistenceName: name } : { experimentalResizablePersistenceName: name }),
      });
      const rejection = expect(initialization).rejects.toThrow(outcome === "fatal" ? "injected fatal init" : "injected partial init");
      await vi.waitFor(() => expect(MockWorker.instances.some(worker => worker.lastMessage("init")?.persistentComputerName === name
        || worker.lastMessage("init")?.experimentalFixedPersistenceName === name
        || worker.lastMessage("init")?.experimentalResizablePersistenceName === name)).toBe(true));
      const worker = MockWorker.instances[MockWorker.instances.length - 1]!;
      expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(true);
      expect(held.size).toBe(2);
      const rejectedCleanup = vi.fn(async () => { throw new Error("injected storage close failure"); });
      (kernel as unknown as { request(): Promise<unknown> }).request = rejectedCleanup;
      worker.simulateMessage(outcome === "fatal" ? { type: "kernel_fatal", error: "injected fatal init" }
        : { type: "init_error", error: "injected partial init" });
      await rejection;
      expect(rejectedCleanup).toHaveBeenCalledTimes(outcome === "ordinary" ? 1 : 0);
      expect(worker.terminated).toBe(true);
      expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(true);
      expect(held.size).toBe(2);
      await expect(kernel.initFromOpfsImage({
        kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
        persistentComputerName: name, experimentalFixedPersistenceName: name,
      })).rejects.toThrow("already running");
      const competing = new BrowserKernel({ kernelOwnedFs: true });
      await expect(competing.initFromOpfsImage({
        kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
        persistentComputerName: `${name}-other`, experimentalFixedPersistenceName: name,
      })).rejects.toThrow("journal is already open");
    }
  });

  it.each(["fixed", "resizable"] as const)("releases %s failed-init ownership only after acknowledged storage closure", async (mode) => {
    const held = stubPersistenceWebLocks();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const name = `acknowledged-init-${mode}`;
    const options = {
      kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
      persistentComputerName: name,
      ...(mode === "fixed" ? { experimentalFixedPersistenceName: name } : { experimentalResizablePersistenceName: name }),
    };
    const initialization = kernel.initFromOpfsImage(options);
    const rejected = expect(initialization).rejects.toThrow("injected initialization refusal");
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "init_error", error: "injected initialization refusal" });
    await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
    expect(held.size).toBe(2);
    expect(worker.terminated).toBe(false);
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await rejected;
    expect(worker.terminated).toBe(true);
    expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(false);
    expect(held.size).toBe(0);

    const retry = kernel.initFromOpfsImage(options);
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    const successor = MockWorker.instances[1]!;
    successor.simulateMessage({ type: "ready" });
    await retry;
    worker.simulateMessage({ type: "init_error", error: "late old initialization error" });
    worker.simulateMessage({ type: "kernel_fatal", error: "late old fatal error" });
    expect(held.size).toBe(2);
    expect(successor.terminated).toBe(false);
    (kernel as unknown as { request(): Promise<unknown> }).request =
      vi.fn(async () => ({ gracefulDetachComplete: true }));
    await kernel.destroy();
    expect(held.size).toBe(0);
  });

  it.each(["fixed", "resizable"] as const)("retains %s failed-init ownership after a malformed close acknowledgement", async (mode) => {
    const held = stubPersistenceWebLocks();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const name = `malformed-init-${mode}`;
    const initialization = kernel.initFromOpfsImage({
      kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
      persistentComputerName: name,
      ...(mode === "fixed" ? { experimentalFixedPersistenceName: name } : { experimentalResizablePersistenceName: name }),
    });
    const rejected = expect(initialization).rejects.toThrow("injected initialization refusal");
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "init_error", error: "injected initialization refusal" });
    await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId, result: {} });
    await rejected;
    expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(true);
    expect(held.size).toBe(2);
  });

  it.each(["fixed", "resizable"] as const)("retains %s failed-init ownership after timeout and a late close acknowledgement", async (mode) => {
    vi.useFakeTimers();
    try {
      const held = stubPersistenceWebLocks();
      const BrowserKernel = await loadBrowserKernel();
      const kernel = new BrowserKernel({ kernelOwnedFs: true });
      const name = `timed-out-init-${mode}`;
      const initialization = kernel.initFromOpfsImage({
        kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
        persistentComputerName: name,
        ...(mode === "fixed" ? { experimentalFixedPersistenceName: name } : { experimentalResizablePersistenceName: name }),
      });
      const rejected = expect(initialization).rejects.toThrow("injected initialization refusal");
      await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
      const worker = MockWorker.instances[0]!;
      worker.simulateMessage({ type: "init_error", error: "injected initialization refusal" });
      await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
      const requestId = worker.lastMessage("destroy").requestId;
      await vi.advanceTimersByTimeAsync(PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS);
      await rejected;
      worker.simulateMessage({ type: "response", requestId, result: { gracefulDetachComplete: true } });
      expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(true);
      expect(held.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands off a journal lease only after acknowledged worker teardown", async () => {
    const held = stubPersistenceWebLocks();
    const { acquireBrowserPersistenceJournalLease, withHeldBrowserPersistenceJournals } =
      await import("../src/browser-persistence-journal-lease");
    const BrowserKernel = await loadBrowserKernel();
    const options = {
      kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle,
      experimentalFixedPersistenceName: "handoff-source-journal",
      persistentComputerName: "handoff-computer",
    };
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialization = kernel.initFromOpfsImage(options);
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    MockWorker.instances[0]!.simulateMessage({ type: "ready" });
    await initialization;
    expect(() => kernel.takePersistentJournalLeaseAfterDestroy()).toThrow("not quiescent");
    kernel.reservePersistentJournalLeaseForHandoff();
    (kernel as unknown as { request(): Promise<{ gracefulDetachComplete: true }> }).request =
      vi.fn(async () => ({ gracefulDetachComplete: true }));
    await kernel.destroy();
    expect(held.has("kandelo-rootfs-journal:handoff-source-journal")).toBe(true);
    expect(held.has("kandelo-fixed-rootfs-runtime:handoff-computer")).toBe(false);
    const source = kernel.takePersistentJournalLeaseAfterDestroy();
    expect(source.journalName).toBe("handoff-source-journal");
    expect(() => kernel.takePersistentJournalLeaseAfterDestroy()).toThrow("not quiescent");
    const target = await acquireBrowserPersistenceJournalLease("handoff-target-journal");
    await withHeldBrowserPersistenceJournals(
      source, target, source.journalName, target.journalName,
      async () => {
        await expect(source()).rejects.toThrow("still claimed");
        await expect(target()).rejects.toThrow("still claimed");
      },
    );
    const competing = new BrowserKernel({ kernelOwnedFs: true });
    await expect(competing.initFromOpfsImage({ ...options, persistentComputerName: "other-computer" }))
      .rejects.toThrow("journal is already open");
    await target();
    await source();
    expect(held.size).toBe(0);
  });

  it("retains a journal lease when browser destroy times out without storage acknowledgement", async () => {
    const held = stubPersistenceWebLocks();
    const BrowserKernel = await loadBrowserKernel();
    const options = {
      kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle,
      experimentalFixedPersistenceName: "timed-out-journal",
      persistentComputerName: "timed-out-journal",
    };
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialization = kernel.initFromOpfsImage(options);
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initialization;
    kernel.reservePersistentJournalLeaseForHandoff();

    vi.useFakeTimers();
    try {
      let lateResponse!: (value: unknown) => void;
      const testable = kernel as unknown as { request(): Promise<unknown> };
      testable.request = vi.fn(() => new Promise((resolve) => { lateResponse = resolve; }));
      const destruction = kernel.destroy();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(worker.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS - 2_000);
      await destruction;
      expect(worker.terminated).toBe(true);
      expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(true);
      expect(held.has("kandelo-rootfs-journal:timed-out-journal")).toBe(true);
      expect(() => kernel.takePersistentJournalLeaseAfterDestroy()).toThrow("not quiescent");

      lateResponse({ gracefulDetachComplete: true });
      await Promise.resolve();
      expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(true);
      await expect(kernel.initFromOpfsImage(options)).rejects.toThrow("already running");
      const competing = new BrowserKernel({ kernelOwnedFs: true });
      await expect(competing.initFromOpfsImage({ ...options, persistentComputerName: "other-timed-out-computer" })).rejects.toThrow("journal is already open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps persistent browser ownership until delayed storage shutdown is acknowledged", async () => {
    const held = stubPersistenceWebLocks();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialization = kernel.initFromOpfsImage({
      kernelWasm: new ArrayBuffer(8), vfsImageFile: {} as FileSystemFileHandle,
      experimentalResizablePersistenceName: "delayed-storage", persistentComputerName: "delayed-storage",
    });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready" });
    await initialization;
    vi.useFakeTimers();
    try {
      const testable = kernel as unknown as { request(): Promise<unknown> };
      testable.request = () => new Promise((resolve) => setTimeout(() => resolve({ gracefulDetachComplete: true }), 2_500));
      const destruction = kernel.destroy();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(worker.terminated).toBe(false);
      expect(held.has("kandelo-rootfs-journal:delayed-storage")).toBe(true);
      await vi.advanceTimersByTimeAsync(499);
      await destruction;
      expect(worker.terminated).toBe(true);
      expect(held.size).toBe(0);
      expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(false);
      expect(kernel.getPersistenceShutdownFailure()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("shares a page computer lease with its kernel and blocks another journal namespace", async () => {
    const held = stubPersistenceWebLocks();
    const { acquireBrowserPersistenceComputerLease } = await import("../src/browser-persistence-computer-lease");
    const BrowserKernel = await loadBrowserKernel();
    const lease = await acquireBrowserPersistenceComputerLease("shared-computer");
    const options = {
      kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle,
      experimentalFixedPersistenceName: "first-computer-journal",
      persistentComputerName: "shared-computer",
      persistenceComputerLease: lease,
    };
    const first = new BrowserKernel({ kernelOwnedFs: true });
    const initialization = first.initFromOpfsImage(options);
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    MockWorker.instances[0]!.simulateMessage({ type: "ready" });
    await initialization;
    await expect(lease()).rejects.toThrow("still owned by a kernel");

    const competing = new BrowserKernel({ kernelOwnedFs: true });
    const otherJournal = { ...options, experimentalFixedPersistenceName: "second-computer-journal", persistenceComputerLease: undefined };
    await expect(competing.initFromOpfsImage(otherJournal)).rejects.toThrow("computer is already running");
    expect(MockWorker.instances).toHaveLength(1);
    (first as unknown as { request(): Promise<{ gracefulDetachComplete: true }> }).request =
      vi.fn(async () => ({ gracefulDetachComplete: true }));
    await first.destroy();
    await expect(competing.initFromOpfsImage(otherJournal)).rejects.toThrow("computer is already running");
    await lease();

    const retry = competing.initFromOpfsImage(otherJournal);
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    MockWorker.instances[1]!.simulateMessage({ type: "ready" });
    await retry;
    (competing as unknown as { request(): Promise<{ gracefulDetachComplete: true }> }).request =
      vi.fn(async () => ({ gracefulDetachComplete: true }));
    await competing.destroy();
    expect(held.size).toBe(0);
  });

  it("does not let an old kernel claim release a newer computer lease claim", async () => {
    const held = stubPersistenceWebLocks();
    const { acquireBrowserPersistenceComputerLease, claimBrowserPersistenceComputerLease } =
      await import("../src/browser-persistence-computer-lease");
    const lease = await acquireBrowserPersistenceComputerLease("claim-generation");
    const releaseOldClaim = claimBrowserPersistenceComputerLease(lease);
    releaseOldClaim();
    const releaseNewClaim = claimBrowserPersistenceComputerLease(lease);
    releaseOldClaim();
    await expect(lease()).rejects.toThrow("still owned by a kernel");
    releaseNewClaim();
    await lease();
    expect(held.size).toBe(0);
  });

  it("releases a journal lease after an acknowledged storage close with other teardown errors", async () => {
    const held = stubPersistenceWebLocks();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialization = kernel.initFromOpfsImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle,
      experimentalFixedPersistenceName: "acknowledged-journal",
      persistentComputerName: "acknowledged-journal",
    });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    MockWorker.instances[0]!.simulateMessage({ type: "ready" });
    await initialization;
    const testable = kernel as unknown as { request(): Promise<unknown> };
    testable.request = vi.fn(async () => ({
      gracefulDetachComplete: false,
      persistenceSyncFailure: "injected sync failure",
    }));
    await kernel.destroy();
    expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(false);
    expect(kernel.getPersistenceShutdownFailure()).toBe("injected sync failure");
    expect(held.size).toBe(0);
  });

  it("drops framebuffer pixel mirrors on clean and trap exits", async () => {
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const dispatch = (
      kernel as unknown as {
        handleWorkerMessage(message: unknown): void;
      }
    ).handleWorkerMessage.bind(kernel);

    for (const [pid, status] of [[41, 0], [42, -1]] as const) {
      const memory = new SharedArrayBuffer(WASM_PAGE_SIZE);
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
        pixels: memory,
      });
      expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBe(memory);
      expect(kernel.framebuffers.get(pid)).toBeDefined();

      dispatch({ type: "exit", pid, generation: pid, status });
      expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBeUndefined();
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
    const oldMemory = new SharedArrayBuffer(WASM_PAGE_SIZE);
    const successorMemory = new SharedArrayBuffer(WASM_PAGE_SIZE);

    const bind = (
      generation: number,
      memory: SharedArrayBuffer,
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
      pixels: memory,
    });
    bind(1, oldMemory);
    bind(2, successorMemory);

    // WHY: exec preserves the PID. Queued teardown from generation 1 must
    // never clear or reinstall its alias after generation 2 is visible.
    bind(1, oldMemory);
    dispatch({ type: "fb_unbind", pid, generation: 1 });
    dispatch({ type: "exit", pid, generation: 1, status: 0 });
    dispatch({
      type: "fb_release_generation",
      requestId: 73,
      pid,
      generation: 1,
    });

    expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBe(successorMemory);
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
    expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBeUndefined();
    expect(kernel.framebuffers.get(pid)).toBeUndefined();
    expect(worker.lastMessage("fb_release_generation_ack")).toEqual({
      type: "fb_release_generation_ack",
      requestId: 74,
    });

    // A bind from the just-released generation can be queued around teardown.
    // Keep a short terminal tombstone until the worker observes the ACK.
    bind(2, successorMemory);
    expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBeUndefined();
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
    const memory = new SharedArrayBuffer(WASM_PAGE_SIZE);
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
      pixels: memory,
    });

    bind();
    dispatch({ type: "fb_unbind", pid, generation: 3 });
    expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBeUndefined();
    bind();
    expect(kernel.framebuffers.get(pid)?.hostBuffer?.buffer).toBe(memory);
  });

  it("does not attach unused PCM memory when user activation primes the audio clock", async () => {
    const audio = browserAudioGlobals();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialized = kernel.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready", pcmPort: { close: vi.fn() } });
    await initialized;
    expect(kernel.getAudioState()).toBe("unprepared");
    expect(audio.AudioContextCtor).not.toHaveBeenCalled();
    const resumed = kernel.resumeAudio();
    expect(audio.context.resume).toHaveBeenCalledOnce();
    await resumed;
    expect(kernel.getAudioState()).toBe("running");
    expect(audio.addModule).not.toHaveBeenCalled();
    expect(audio.AudioWorkletNodeCtor).not.toHaveBeenCalled();
    const destroyed = kernel.destroy();
    await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await destroyed;
    expect(audio.context.suspend).toHaveBeenCalledOnce();
    expect(audio.node.port.postMessage).not.toHaveBeenCalled();
    expect(audio.AudioWorkletNodeCtor).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it("automatically binds later guest demand even without UI activity subscribers", async () => {
    const audio = browserAudioGlobals();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialized = kernel.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready", pcmPort: { close: vi.fn() } });
    await initialized;
    const unsubscribe = kernel.onAudioActivityChange(() => {});
    unsubscribe();
    await kernel.resumeAudio();
    expect(audio.AudioWorkletNodeCtor).not.toHaveBeenCalled();
    worker.simulateMessage({ type: "audio_activity" });
    await vi.waitFor(() => expect(audio.AudioWorkletNodeCtor).toHaveBeenCalledOnce());
    expect(audio.AudioContextCtor).toHaveBeenCalledOnce();
    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(kernel.getAudioActivity()).toBe(true);
    expect(kernel.getAudioState()).toBe("running");
    const destroyed = kernel.destroy();
    await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await destroyed;
    expect(audio.node.port.postMessage.mock.calls.filter(([message]) => message.type === "detach")).toHaveLength(1);
  });

  it("forwards the PCM connection without receiving kernel memory", async () => {
    const audio = browserAudioGlobals();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      audioWorkletUrl: "/assets/kandelo-pcm-output.js",
    });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    const pcmPort = { close: vi.fn() };

    worker.simulateMessage({ type: "ready", pcmPort });
    expect(kernel.getAudioActivity()).toBe(false);
    worker.simulateMessage({ type: "audio_activity" });
    await initPromise;
    await vi.waitFor(() => {
      expect(kernel.getAudioState()).toBe("suspended");
    });

    expect(audio.AudioContextCtor).toHaveBeenCalledOnce();
    expect(audio.addModule).toHaveBeenCalledWith(
      "/assets/kandelo-pcm-output.js",
    );
    expect(audio.AudioWorkletNodeCtor).toHaveBeenCalledWith(
      audio.context,
      "kandelo-pcm-output",
      expect.any(Object),
    );
    expect(audio.nodeOptions?.processorOptions.buffer).toBeUndefined();
    expect(audio.node.port.postMessage).toHaveBeenCalledWith(
      { type: "attach", port: pcmPort }, [pcmPort],
    );
    expect(kernel.getAudioActivity()).toBe(true);
    expect(audio.node.connect).toHaveBeenCalledWith(audio.context.destination);
  });

  it("settles browser PCM before terminating the worker and leaves the shared context open", async () => {
    const audio = browserAudioGlobals();
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initPromise = kernel.initFromImage({
      kernelWasm: new ArrayBuffer(8),
      vfsImage: new Uint8Array(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({
      type: "ready",
      pcmPort: { close: vi.fn() },
    });
    worker.simulateMessage({ type: "audio_activity" });
    await initPromise;
    await vi.waitFor(() => {
      expect(kernel.getAudioState()).toBe("suspended");
    });
    await kernel.resumeAudio();

    const teardownOrder: string[] = [];
    let finishPcmSettlement!: () => void;
    audio.context.suspend.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          teardownOrder.push("pcm-pipeline-settle");
          finishPcmSettlement = () => {
            audio.context.state = "suspended";
            audio.context.onstatechange?.();
            resolve();
          };
        }),
    );
    audio.context.close.mockImplementationOnce(async () => {
      teardownOrder.push("pcm-context-close");
      audio.context.state = "closed";
      audio.context.onstatechange?.();
    });
    vi.spyOn(worker, "terminate").mockImplementationOnce(() => {
      teardownOrder.push("kernel-worker-terminate");
      worker.terminated = true;
    });

    const destroyPromise = kernel.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const destroy = worker.lastMessage("destroy");
    worker.simulateMessage({
      type: "response",
      requestId: destroy.requestId,
      result: { gracefulDetachComplete: true },
    });
    // Wait on a monotone observable. settleOutputPipeline bounds its own wait
    // at MAX_OUTPUT_PIPELINE_SETTLE_MS, so polling for exact array equality
    // raced that bound: teardown could advance past the settle step between
    // two polls and the array would never equal the single-element snapshot.
    await vi.waitFor(() => {
      expect(audio.context.suspend).toHaveBeenCalled();
    });
    expect(teardownOrder[0]).toBe("pcm-pipeline-settle");
    expect(audio.context.close).not.toHaveBeenCalled();
    finishPcmSettlement();
    await destroyPromise;

    // [RUNTIME-WORKAROUND: WEBKIT-AUDIOWORKLET-CLOSE-LEAK]
    // The AudioContext is page-wide (PR #1410): closing one per machine
    // leaves a WebCore AudioWorklet rendering thread parked forever on WebKit
    // (a suspected WebKit defect). Teardown suspends the pipeline and
    // unhooks this machine's worklet node, then leaves the context open and
    // suspended for the next machine to reuse.
    expect(teardownOrder).toEqual([
      "pcm-pipeline-settle",
      "kernel-worker-terminate",
    ]);
    expect(audio.context.close).not.toHaveBeenCalled();
    expect(audio.context.state).toBe("suspended");
    expect(audio.node.disconnect).toHaveBeenCalledOnce();
    expect(audio.node.port.close).toHaveBeenCalledOnce();
    expect(kernel.getAudioState()).toBe("unavailable");
  });

  it("invokes native resume in the caller's stack even before worklet module loading completes", async () => {
    const audio = browserAudioGlobals();
    let loaded!: () => void;
    audio.addModule.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
    const BrowserKernel = await loadBrowserKernel();
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    const initialized = kernel.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready", pcmPort: { close: vi.fn() } });
    worker.simulateMessage({ type: "audio_activity" });
    await initialized;
    const resumed = kernel.resumeAudio();
    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(audio.AudioWorkletNodeCtor).not.toHaveBeenCalled();
    loaded();
    await resumed;
    expect(audio.AudioWorkletNodeCtor).toHaveBeenCalledOnce();
    expect(kernel.getAudioState()).toBe("running");
  });

  it("permits kernel replacement after confirmed audio memory detach while quarantining context reuse", async () => {
    const audio = browserAudioGlobals();
    const BrowserKernel = await loadBrowserKernel();
    const diagnostics: string[] = [];
    const kernel = new BrowserKernel({ kernelOwnedFs: true,
      onHostDiagnostic: event => diagnostics.push(event.message) });
    const initialized = kernel.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready", pcmPort: { close: vi.fn() } });
    worker.simulateMessage({ type: "audio_activity" });
    await initialized;
    await vi.waitFor(() => expect(kernel.getAudioState()).toBe("suspended"));
    let completeResume!: () => void;
    audio.context.resume.mockImplementationOnce(() => new Promise<void>(resolve => {
      completeResume = () => { audio.context.state = "running"; resolve(); };
    }));
    const resume = kernel.resumeAudio().catch(error => error);
    await vi.waitFor(() => expect(audio.context.resume).toHaveBeenCalledOnce());
    const destroyed = kernel.destroy();
    await vi.waitFor(() => expect(worker.lastMessage("destroy")).toBeDefined());
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await destroyed;
    expect(worker.terminated).toBe(true);
    expect(audio.node.port.postMessage.mock.calls.filter(([message]) => message.type === "detach")).toHaveLength(1);
    expect(diagnostics.some(message => message.includes("PCM audio context is quarantined"))).toBe(true);
    const successor = new BrowserKernel({ kernelOwnedFs: true,
      onHostDiagnostic: event => diagnostics.push(event.message) });
    const replacement = successor.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    const replacementWorker = MockWorker.instances[1]!;
    replacementWorker.simulateMessage({ type: "ready", pcmPort: { close: vi.fn() } });
    replacementWorker.simulateMessage({ type: "audio_activity" });
    await replacement;
    await vi.waitFor(() => expect(successor.getAudioState()).toBe("unavailable"));
    await expect(successor.resumeAudio()).rejects.toThrow("context is quarantined");
    expect(audio.AudioWorkletNodeCtor).toHaveBeenCalledOnce();
    completeResume();
    expect((await resume).message).toBe("PCM output is closed");
    await expect(successor.resumeAudio()).rejects.toThrow("context is quarantined");
    const replacementDestroyed = successor.destroy();
    await vi.waitFor(() => expect(replacementWorker.lastMessage("destroy")).toBeDefined());
    replacementWorker.simulateMessage({ type: "response", requestId: replacementWorker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await replacementDestroyed;
  });

  it("keeps kernel and storage handoff independent of unconfirmed audio mirror retirement", async () => {
    const audio = browserAudioGlobals();
    audio.node.port.postMessage.mockImplementation(() => {});
    const BrowserKernel = await loadBrowserKernel();
    const diagnostics: string[] = [];
    const kernel = new BrowserKernel({ kernelOwnedFs: true,
      onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.message) });
    const initializing = kernel.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await new Promise(resolve => setTimeout(resolve, 0));
    const worker = MockWorker.instances[0]!;
    worker.simulateMessage({ type: "ready", pcmPort: { close: vi.fn() } });
    worker.simulateMessage({ type: "audio_activity" });
    await initializing;
    await vi.waitFor(() => expect(kernel.getAudioState()).toBe("suspended"));
    const held = stubPersistenceWebLocks();
    const request = navigator.locks.request as unknown as (
      name: string, options: unknown, operation: (lock: object | null) => Promise<unknown>,
    ) => Promise<unknown>;
    let releaseAcquisition!: () => void;
    let enteredAcquisition!: () => void;
    const acquisitionPaused = new Promise<void>(resolve => { enteredAcquisition = resolve; });
    const acquisitionResumed = new Promise<void>(resolve => { releaseAcquisition = resolve; });
    vi.stubGlobal("navigator", { locks: {
      request: (name: string, options: unknown, operation: (lock: object | null) => Promise<unknown>) =>
        request(name, options, async lock => {
          if (name.startsWith("kandelo-rootfs-journal:")) {
            enteredAcquisition();
            await acquisitionResumed;
          }
          return operation(lock);
        }),
    } });
    const waitingSuccessor = new BrowserKernel({ kernelOwnedFs: true });
    const pendingBoot = waitingSuccessor.initFromOpfsImage({ kernelWasm: new ArrayBuffer(8),
      vfsImageFile: {} as FileSystemFileHandle, persistentComputerName: "audio-retirement-race",
      experimentalResizablePersistenceName: "audio-retirement-race" });
    await acquisitionPaused;
    let releaseModule!: () => void;
    const moduleReady = new Promise<void>(resolve => { releaseModule = resolve; });
    audio.addModule.mockImplementationOnce(() => moduleReady);
    const { BrowserPcmDriver } = await import("../src/audio/browser-pcm-driver");
    const waitingDriver = new BrowserPcmDriver({ workletUrl: "/pending-worklet.js" });
    const pendingPrepare = expect(waitingDriver.prepareRemote({ close: vi.fn() } as unknown as MessagePort))
      .rejects.toThrow("transport retirement is unconfirmed");
    const destruction = kernel.destroy();
    await new Promise(resolve => setTimeout(resolve, 0));
    worker.simulateMessage({ type: "response", requestId: worker.lastMessage("destroy").requestId,
      result: { gracefulDetachComplete: true } });
    await destruction;
    expect(worker.terminated).toBe(true);
    expect(kernel.getPersistenceShutdownFailure()).toBeNull();
    expect(kernel.hasUnconfirmedKernelQuiescence()).toBe(false);
    expect(diagnostics.some(message => message.includes("PCM output shutdown failed"))).toBe(true);
    releaseAcquisition();
    releaseModule();
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    MockWorker.instances[1]!.simulateMessage({ type: "ready" });
    await pendingBoot;
    await pendingPrepare;
    expect(audio.AudioWorkletNodeCtor).toHaveBeenCalledOnce();
    audio.node.port.onmessage?.({ data: { type: "detached" } } as MessageEvent);
    const successor = new BrowserKernel({ kernelOwnedFs: true });
    const successorBoot = successor.initFromImage({ kernelWasm: new ArrayBuffer(8), vfsImage: new Uint8Array(0) });
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(3));
    MockWorker.instances[2]!.simulateMessage({ type: "ready" });
    await successorBoot;
    for (const [machine, realm] of [[waitingSuccessor, MockWorker.instances[1]!], [successor, MockWorker.instances[2]!]] as const) {
      const closed = machine.destroy();
      await vi.waitFor(() => expect(realm.lastMessage("destroy")).toBeDefined());
      realm.simulateMessage({ type: "response", requestId: realm.lastMessage("destroy").requestId,
        result: { gracefulDetachComplete: true } });
      await closed;
    }
    expect(held.size).toBe(0);
  });
});
