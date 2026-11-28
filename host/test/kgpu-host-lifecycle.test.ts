// KgpuHost's worker lifecycle against a scripted worker handle and kernel
// port, with no kernel or GPU worker: the orderings the end-to-end cases in
// kgpu-host.test.ts can only observe indirectly. Ruling R15 is the main one:
// the kernel device is reset only after the failed worker is proven gone,
// since a worker that may still run could write frames the reset releases.
import { describe, expect, it } from "vitest";
import { KgpuHost, type KgpuKernelPort } from "../src/kgpu/kgpu-host";
import { MockWorkerHandle } from "../src/worker-adapter";
import { createWebgl2Backend } from "../src/kgpu/webgl2-backend";
import { createWebGL2Context } from "./support/kgpu-webgl2-double";
import { EEXIST, EIO, ENOENT } from "../src/kgpu/backend";

/** A worker whose termination completes only when the test says so. */
class HeldWorker extends MockWorkerHandle {
  terminations = 0;
  #gone: (() => void) | null = null;
  terminate(): Promise<number> {
    this.terminations++;
    return new Promise<number>(resolve => { this.#gone = () => resolve(1); });
  }
  gone(): void { this.#gone?.(); }
}

function backing(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

/** Let scheduled pumps and promise continuations run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

function harness(memory: () => WebAssembly.Memory | null = (() => { const m = backing(); return () => m; })()) {
  const calls: string[] = [];
  const workers: HeldWorker[] = [];
  const diagnostics: string[] = [];
  const kernel: KgpuKernelPort = {
    drain: () => { calls.push("drain"); return new Uint8Array(0); },
    complete: () => { calls.push("complete"); return 0; },
    reset: () => { calls.push("reset"); },
    setRenderer: available => { calls.push(`renderer ${available}`); },
  };
  const host = new KgpuHost({
    renderer: "webgl2",
    executor: { executorBytes: new ArrayBuffer(8) },
    createWorker: () => { const worker = new HeldWorker(); workers.push(worker); return worker; },
    groupMemory: memory,
    kernel,
    onDiagnostic: message => diagnostics.push(message),
  });
  return { host, calls, workers, diagnostics };
}

describe("KgpuHost lifecycle", () => {
  it("starts no worker before the first kick, then exactly one", async () => {
    const { host, workers } = harness();
    await settle();
    expect(workers).toHaveLength(0);
    host.onKick();
    host.onKick();
    await settle();
    expect(workers).toHaveLength(1);
    expect(host.status().state).toBe("running");
  });

  it("resets the device only after a failed worker is proven gone (R15)", async () => {
    const { host, calls, workers } = harness();
    host.onKick();
    await settle();
    workers[0]!.simulateError(new Error("renderer crashed"));
    await settle();
    // Termination was asked for but has not completed: the worker might
    // still be running, so the kernel must not have released anything.
    expect(workers[0]!.terminations).toBe(1);
    expect(calls).not.toContain("reset");
    expect(host.status().state).toBe("resetting");
    workers[0]!.gone();
    await settle();
    expect(calls.filter(call => call === "reset")).toHaveLength(1);
    // No automatic restart, and the renderer is not set again.
    expect(calls).not.toContain("renderer true");
    expect(host.status()).toMatchObject({ state: "down", resets: 1, workersStarted: 1 });
    host.onKick();
    await settle();
    expect(workers).toHaveLength(1);
  });

  it("resets once for a worker that errors and then exits", async () => {
    const { host, calls, workers } = harness();
    host.onKick();
    await settle();
    workers[0]!.simulateError(new Error("trap"));
    workers[0]!.simulateExit(1);
    workers[0]!.gone();
    await settle();
    expect(calls.filter(call => call === "reset")).toHaveLength(1);
    expect(workers[0]!.terminations).toBe(1);
  });

  it("sets the renderer again only once a restarted worker is ready", async () => {
    const { host, calls, workers } = harness();
    host.onKick();
    await settle();
    workers[0]!.simulateExit(1);
    workers[0]!.gone();
    await settle();
    const restarted = host.restart();
    await settle();
    expect(workers).toHaveLength(2);
    expect(calls).not.toContain("renderer true");
    workers[1]!.simulateMessage({ type: "kandelo.kgpu.worker-ready.v1" });
    await restarted;
    expect(calls.at(-1)).toBe("renderer true");
    expect(host.status()).toMatchObject({ state: "running", workersStarted: 2, resets: 1 });
  });

  it("never resets the device at kernel teardown", async () => {
    const { host, calls, workers } = harness();
    host.onKick();
    await settle();
    const closing = host.terminate();
    workers[0]!.gone();
    await closing;
    workers[0]!.simulateExit(1);
    await settle();
    expect(calls).not.toContain("reset");
    expect(host.status().state).toBe("closed");
  });

  it("fails the worker, without draining, once the group backing it addresses is replaced", async () => {
    // Records name offsets into the backing the kernel uses now; a worker
    // holding the old backing would read and write the wrong memory.
    let current = backing();
    const { host, calls, workers, diagnostics } = harness(() => current);
    host.onKick();
    await settle();
    expect(calls).toContain("drain");
    calls.length = 0;
    current = backing();
    host.onKick();
    await settle();
    expect(calls).not.toContain("drain");
    expect(workers[0]!.terminations).toBe(1);
    expect(diagnostics.join("\n")).toMatch(/backing/);
    workers[0]!.gone();
    await settle();
    expect(calls).toEqual(["reset"]);
  });
});

describe("WebGL 2 backend", () => {
  it("reports a lost context to its owner once, and stays lost", () => {
    const context = createWebGL2Context() as Parameters<typeof createWebgl2Backend>[0];
    let losses = 0;
    const backend = createWebgl2Backend(context, () => { losses++; });
    expect(backend.createContext(1)).toBe(0);
    expect(backend.createSurface(1, 1, 4, 4)).toBe(0);
    expect(backend.isLost()).toBe(false);
    context.canvas!.dispatchEvent(new Event("kgpu-test-lose"));
    context.canvas!.dispatchEvent(new Event("webglcontextlost"));
    expect(losses).toBe(1);
    expect(backend.isLost()).toBe(true);
    // Nothing new is allocated on a lost renderer.
    expect(backend.createContext(2)).toBe(-EIO);
    expect(backend.createSurface(1, 2, 4, 4)).toBe(-EIO);
  });

  /** The double, with every renderbuffer deletion recorded. */
  function recordedDouble() {
    const context = createWebGL2Context() as Parameters<typeof createWebgl2Backend>[0];
    const inner = context.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
    const deleted: unknown[] = [];
    const gl = new Proxy(inner, {
      get(target, key) {
        if (key === "deleteRenderbuffer") return (rb: unknown) => { deleted.push(rb); inner.deleteRenderbuffer!(rb); };
        return Reflect.get(target, key);
      },
    });
    return { context: { gl: gl as unknown as typeof context.gl, canvas: context.canvas }, deleted };
  }

  const read = (backend: ReturnType<typeof createWebgl2Backend>, context: number, w: number, h: number) => {
    const out = new Uint8Array(w * h * 4).fill(0xee);
    return { status: backend.readPixels(context, 0, 0, w, h, out), pixels: Array.from(out) };
  };
  const fill = (rgba: number[], count: number) => Array.from({ length: count }, () => rgba).flat();

  it("keeps each context's named surfaces at their own sizes", () => {
    const backend = createWebgl2Backend(recordedDouble().context);
    expect(backend.createContext(1)).toBe(0);
    expect(backend.createContext(1)).toBe(-EEXIST);
    expect(backend.createContext(2)).toBe(0);
    expect(backend.createSurface(1, 5, 2, 2)).toBe(0);
    expect(backend.createSurface(1, 5, 2, 2)).toBe(-EEXIST);
    expect(backend.createSurface(1, 6, 3, 1)).toBe(0);
    // Names are per context.
    expect(backend.createSurface(2, 5, 1, 1)).toBe(0);
    expect(backend.createSurface(3, 5, 1, 1)).toBe(-ENOENT);

    backend.bindSurface(1, 5);
    backend.clearColor(1, 1, 0, 0, 1);
    backend.clear(1, 0x4000);
    backend.bindSurface(2, 5);
    backend.clearColor(2, 0, 1, 0, 1);
    backend.clear(2, 0x4000);
    // Clear color is context state: rebinding keeps it.
    backend.bindSurface(1, 6);
    backend.clearColor(1, 0, 0, 1, 1);
    backend.clear(1, 0x4000);

    expect(read(backend, 1, 3, 1)).toEqual({ status: 0, pixels: fill([0, 0, 255, 255], 3) });
    backend.bindSurface(1, 5);
    expect(read(backend, 1, 2, 2)).toEqual({ status: 0, pixels: fill([255, 0, 0, 255], 4) });
    expect(read(backend, 2, 1, 1)).toEqual({ status: 0, pixels: [0, 255, 0, 255] });
  });

  it("has no surface bound after binding 0 or destroying the bound one", () => {
    const { context, deleted } = recordedDouble();
    const backend = createWebgl2Backend(context);
    expect(backend.createContext(1)).toBe(0);
    expect(read(backend, 1, 1, 1).status).toBe(-ENOENT);
    expect(backend.createSurface(1, 1, 1, 1)).toBe(0);
    expect(read(backend, 1, 1, 1).status).toBe(-ENOENT);
    backend.bindSurface(1, 1);
    expect(read(backend, 1, 1, 1).status).toBe(0);
    backend.bindSurface(1, 0);
    expect(read(backend, 1, 1, 1).status).toBe(-ENOENT);
    backend.bindSurface(1, 1);
    backend.destroySurface(1, 1);
    expect(deleted).toHaveLength(1);
    expect(read(backend, 1, 1, 1).status).toBe(-ENOENT);
    // The name is free again.
    expect(backend.createSurface(1, 1, 1, 1)).toBe(0);
  });

  it("releases every surface of a destroyed context, and only its own", () => {
    const { context, deleted } = recordedDouble();
    const backend = createWebgl2Backend(context);
    expect(backend.createContext(1)).toBe(0);
    expect(backend.createContext(2)).toBe(0);
    for (const name of [1, 2, 3]) expect(backend.createSurface(1, name, 1, 1)).toBe(0);
    expect(backend.createSurface(2, 1, 1, 1)).toBe(0);
    backend.bindSurface(2, 1);
    backend.destroyContext(1);
    expect(deleted).toHaveLength(3);
    expect(read(backend, 1, 1, 1).status).toBe(-ENOENT);
    expect(read(backend, 2, 1, 1).status).toBe(0);
    // The id may be accepted again, with no surfaces.
    expect(backend.createContext(1)).toBe(0);
    expect(backend.createSurface(1, 1, 1, 1)).toBe(0);
  });
});
