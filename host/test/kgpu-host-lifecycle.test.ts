// KgpuHost's worker lifecycle against a scripted worker handle and kernel
// port, with no kernel or GPU worker: the orderings the end-to-end cases in
// kgpu-host.test.ts can only observe indirectly. Ruling R15 is the main one:
// the kernel device is reset only after the failed worker is proven gone,
// since a worker that may still run could write frames the reset releases.
import { describe, expect, it } from "vitest";
import { KgpuHost, type KgpuKernelPort } from "../src/kgpu/kgpu-host";
import { MockWorkerHandle } from "../src/worker-adapter";

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
