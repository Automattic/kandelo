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

  it("should reject spawn if worker sends error and clean up process entry", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({
      type: "error",
      pid: 1,
      message: "wasm init failed",
    });
    await expect(spawnPromise).rejects.toThrow("wasm init failed");
    expect(pm.getProcess(1)).toBeUndefined();
    expect(pm.getProcessCount()).toBe(0);
  });

  it("should reject spawn if worker exits during init and clean up", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateExit(1);
    await expect(spawnPromise).rejects.toThrow("Worker exited with code 1");
    expect(pm.getProcess(1)).toBeUndefined();
    expect(pm.getProcessCount()).toBe(0);
  });

  it("should reject spawn if worker throws error event and clean up", async () => {
    const { pm, adapter } = createTestPM();
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateError(new Error("thread crashed"));
    await expect(spawnPromise).rejects.toThrow("thread crashed");
    expect(pm.getProcess(1)).toBeUndefined();
    expect(pm.getProcessCount()).toBe(0);
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

describe("ProcessManager.fork()", () => {
  it("should fork a running process and create a child", async () => {
    const { pm, adapter } = createTestPM();

    // Spawn parent
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;
    const parentWorker = adapter.lastWorker!;

    // Fork parent
    const forkPromise = pm.fork(1);

    // Parent should receive get_fork_state request
    expect(parentWorker.sentMessages).toContainEqual({ type: "get_fork_state" });

    // Simulate parent responding with fork state
    parentWorker.simulateMessage({
      type: "fork_state",
      pid: 1,
      data: new ArrayBuffer(64),
    });

    // Allow microtask queue to flush so fork() continues after await
    await Promise.resolve();

    // Child worker should have been created with forkState
    const childWorker = adapter.lastWorker!;
    expect(childWorker).not.toBe(parentWorker);
    expect(adapter.lastWorkerData).toMatchObject({
      type: "init",
      pid: 2,
      ppid: 1,
      forkState: expect.any(ArrayBuffer),
    });

    // Simulate child ready
    childWorker.simulateMessage({ type: "ready", pid: 2 });
    const childPid = await forkPromise;

    expect(childPid).toBe(2);
    expect(pm.getProcess(2)!.ppid).toBe(1);
    expect(pm.getProcess(2)!.state).toBe("running");
  });

  it("should reject fork of non-existent process", async () => {
    const { pm } = createTestPM();
    await expect(pm.fork(99)).rejects.toThrow();
  });

  it("should reject fork of non-running process", async () => {
    const { pm, adapter } = createTestPM();
    const p = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await p;

    // Simulate exit
    adapter.lastWorker!.simulateMessage({ type: "exit", pid: 1, status: 0 });

    await expect(pm.fork(1)).rejects.toThrow();
  });
});

describe("ProcessManager.waitpid()", () => {
  it("should return immediately for already-exited child", async () => {
    const { pm, adapter } = createTestPM();

    const p = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await p;

    // Child exits
    adapter.lastWorker!.simulateMessage({ type: "exit", pid: 1, status: 42 });

    const result = await pm.waitpid(1);
    expect(result).toEqual({ pid: 1, status: 42 });
    // Process should be reaped
    expect(pm.getProcess(1)).toBeUndefined();
  });

  it("should wait for child to exit", async () => {
    const { pm, adapter } = createTestPM();

    const p = pm.spawn();
    const worker = adapter.lastWorker!;
    worker.simulateMessage({ type: "ready", pid: 1 });
    await p;

    const waitPromise = pm.waitpid(1);

    // Not yet resolved
    let resolved = false;
    waitPromise.then(() => { resolved = true; });
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    // Child exits
    worker.simulateMessage({ type: "exit", pid: 1, status: 7 });

    const result = await waitPromise;
    expect(result).toEqual({ pid: 1, status: 7 });
    expect(pm.getProcess(1)).toBeUndefined();
  });

  it("should return pid 0 with WNOHANG if child still running", async () => {
    const { pm, adapter } = createTestPM();

    const p = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await p;

    const result = await pm.waitpid(1, 1); // WNOHANG = 1
    expect(result).toEqual({ pid: 0, status: 0 });
    // Process should NOT be reaped
    expect(pm.getProcess(1)).toBeDefined();
  });

  it("should throw for non-existent process", async () => {
    const { pm } = createTestPM();
    await expect(pm.waitpid(99)).rejects.toThrow();
  });
});
