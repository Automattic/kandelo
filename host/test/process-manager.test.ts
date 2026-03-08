import { describe, it, expect } from "vitest";
import { ProcessManager } from "../src/process-manager";
import { MockWorkerAdapter } from "../src/worker-adapter";

function createTestPM() {
  const adapter = new MockWorkerAdapter();
  const pm = new ProcessManager({
    wasmBytes: new ArrayBuffer(0),
    kernelConfig: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: false },
    workerAdapter: adapter,
  });
  return { pm, adapter };
}

describe("ProcessManager", () => {
  it("should spawn a process and assign PID 1", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();

    expect(adapter.lastWorker).not.toBeNull();
    expect(adapter.lastWorkerData).toMatchObject({
      type: "init",
      pid: 1,
      ppid: 0,
    });

    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    const pid = await spawnPromise;
    expect(pid).toBe(1);
  });

  it("should track process state as running after ready", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    const info = pm.getProcess(1);
    expect(info).toBeDefined();
    expect(info!.state).toBe("running");
    expect(info!.pid).toBe(1);
    expect(info!.ppid).toBe(0);
  });

  it("should assign incrementing PIDs", async () => {
    const { pm, adapter } = createTestPM();

    const p1 = pm.spawn();
    const worker1 = adapter.lastWorker!;
    worker1.simulateMessage({ type: "ready", pid: 1 });
    expect(await p1).toBe(1);

    const p2 = pm.spawn();
    const worker2 = adapter.lastWorker!;
    worker2.simulateMessage({ type: "ready", pid: 2 });
    expect(await p2).toBe(2);

    expect(pm.getProcessCount()).toBe(2);
  });

  it("should reject spawn if worker sends error", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({
      type: "error",
      pid: 1,
      message: "wasm init failed",
    });
    await expect(spawnPromise).rejects.toThrow("wasm init failed");
  });

  it("should reject spawn if worker exits during init", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateExit(1);
    await expect(spawnPromise).rejects.toThrow("Worker exited with code 1");
  });

  it("should reject spawn if worker throws error event", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateError(new Error("thread crashed"));
    await expect(spawnPromise).rejects.toThrow("thread crashed");
  });

  it("should transition to zombie state on exit message", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    adapter.lastWorker!.simulateMessage({ type: "exit", pid: 1, status: 42 });

    const info = pm.getProcess(1);
    expect(info!.state).toBe("zombie");
    expect(info!.exitStatus).toBe(42);
  });

  it("should terminate a process and remove it", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    await pm.terminate(1);

    expect(pm.getProcess(1)).toBeUndefined();
    expect(pm.getProcessCount()).toBe(0);
  });

  it("should pass ppid option to worker init data", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn({ ppid: 5 });
    expect(adapter.lastWorkerData).toMatchObject({ ppid: 5 });

    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    expect(pm.getProcess(1)!.ppid).toBe(5);
  });
});
