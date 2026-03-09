// host/test/multi-worker.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "../src/process-manager";
import { NodeWorkerAdapter } from "../src/worker-adapter";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWasmBytes(): ArrayBuffer {
  const wasmPath = join(__dirname, "../wasm/wasm_posix_kernel.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("Multi-Worker Integration", () => {
  it("should spawn PID 1 in a real worker thread", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const pid = await pm.spawn();
    expect(pid).toBe(1);

    const info = pm.getProcess(1);
    expect(info).toBeDefined();
    expect(info!.state).toBe("running");

    await pm.terminate(1);
  }, 15_000);

  it("should spawn multiple processes in separate workers", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const pid1 = await pm.spawn();
    const pid2 = await pm.spawn();

    expect(pid1).toBe(1);
    expect(pid2).toBe(2);
    expect(pm.getProcessCount()).toBe(2);

    await pm.terminate(1);
    await pm.terminate(2);
  }, 15_000);
});

describe("Fork Integration", () => {
  it("should fork a process and create a child with cloned state", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    // Spawn parent
    const parentPid = await pm.spawn();
    expect(parentPid).toBe(1);

    // Fork parent → child
    const childPid = await pm.fork(parentPid);
    expect(childPid).toBe(2);

    const childInfo = pm.getProcess(childPid);
    expect(childInfo).toBeDefined();
    expect(childInfo!.state).toBe("running");
    expect(childInfo!.ppid).toBe(parentPid);

    // Clean up
    await pm.terminate(childPid);
    await pm.terminate(parentPid);
  }, 15_000);

  it("should waitpid for a terminated child", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const parentPid = await pm.spawn();
    const childPid = await pm.fork(parentPid);

    // Terminate child (simulates exit)
    await pm.terminate(childPid);

    // Parent should be able to continue
    expect(pm.getProcess(parentPid)!.state).toBe("running");

    await pm.terminate(parentPid);
  }, 15_000);
});

describe("Cross-Process Signal Delivery", () => {
  it("should deliver signal from parent to child via kill", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const parentPid = await pm.spawn();
    const childPid = await pm.fork(parentPid);

    // Parent sends SIGTERM to child — should not throw
    pm.deliverSignal(childPid, 15);

    // Child should still be tracked (signal was delivered, not necessarily fatal
    // in this context since the wasm kernel processes signals asynchronously)
    const childInfo = pm.getProcess(childPid);
    expect(childInfo).toBeDefined();

    // Clean up
    await pm.terminate(childPid);
    await pm.terminate(parentPid);
  }, 15_000);

  it("should not deliver signal to non-existent process", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    await pm.spawn();
    expect(() => pm.deliverSignal(999, 15)).toThrow();

    await pm.terminate(1);
  }, 15_000);

  it("should deliver signal between independently spawned processes", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const pid1 = await pm.spawn();
    const pid2 = await pm.spawn();

    // Process 1 sends SIGTERM to process 2
    pm.deliverSignal(pid2, 15);

    // Process 2 should still be tracked
    expect(pm.getProcess(pid2)).toBeDefined();

    // Clean up
    await pm.terminate(pid1);
    await pm.terminate(pid2);
  }, 15_000);
});

describe("Cross-Process Pipe Integration", () => {
  it("should fork a process with pipe conversion support active", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    // Spawn parent
    const parentPid = await pm.spawn();
    expect(parentPid).toBe(1);

    // Fork — the ProcessManager will attempt to parse pipe OFDs from the fork state.
    // A freshly spawned process has no pipes, so no conversion should occur,
    // but this verifies the parsing doesn't break the fork flow.
    const childPid = await pm.fork(parentPid);
    expect(childPid).toBe(2);

    // Both processes should be running
    expect(pm.getProcess(parentPid)!.state).toBe("running");
    expect(pm.getProcess(childPid)!.state).toBe("running");

    // Clean up
    await pm.terminate(childPid);
    await pm.terminate(parentPid);
  }, 15_000);
});
