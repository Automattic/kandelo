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

function buildForkStateWithPipes(): ArrayBuffer {
  // Build a minimal fork state buffer containing pipe OFDs
  // Binary format (little-endian):
  //   Header: magic(4) + version(4) + total_size(4) = 12 bytes
  //   Scalars: 8 u32s = 32 bytes
  //   Signal state: blocked(8) + handler_count(4) + 0 handlers = 12 bytes
  //   FD table: max_fds(4) + fd_count(4) + 5 entries * 12 = 68 bytes
  //   OFD table: ofd_count(4) + 5 entries * 32 = 164 bytes
  //   Total needed for parsing: 12 + 32 + 12 + 68 + 164 = 288 bytes
  //   Add padding for environment, cwd, rlimits, terminal

  const totalSize = 12 + 32 + 12 + 68 + 164 + 4 + 5 + 256 + 56;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  // Header
  view.setUint32(offset, 0x464F524B, true); offset += 4; // magic
  view.setUint32(offset, 1, true); offset += 4; // version
  view.setUint32(offset, totalSize, true); offset += 4; // total_size

  // Scalars (ppid=1, uid=0, gid=0, euid=0, egid=0, pgid=1, sid=1, umask=0o022)
  view.setUint32(offset, 1, true); offset += 4; // ppid
  view.setUint32(offset, 0, true); offset += 4; // uid
  view.setUint32(offset, 0, true); offset += 4; // gid
  view.setUint32(offset, 0, true); offset += 4; // euid
  view.setUint32(offset, 0, true); offset += 4; // egid
  view.setUint32(offset, 1, true); offset += 4; // pgid
  view.setUint32(offset, 1, true); offset += 4; // sid
  view.setUint32(offset, 0o022, true); offset += 4; // umask

  // Signal state: blocked=0, handler_count=0
  view.setUint32(offset, 0, true); offset += 4; // blocked lo
  view.setUint32(offset, 0, true); offset += 4; // blocked hi
  view.setUint32(offset, 0, true); offset += 4; // handler_count

  // FD table: max_fds=1024, fd_count=5
  view.setUint32(offset, 1024, true); offset += 4; // max_fds
  view.setUint32(offset, 5, true); offset += 4; // fd_count

  // fd 0: stdin -> ofd 0
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  // fd 1: stdout -> ofd 1
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  // fd 2: stderr -> ofd 2
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  // fd 3: pipe read -> ofd 3
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  // fd 4: pipe write -> ofd 4
  view.setUint32(offset, 4, true); offset += 4;
  view.setUint32(offset, 4, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;

  // OFD table: 5 entries
  view.setUint32(offset, 5, true); offset += 4; // ofd_count

  // OFD 0: stdin (Regular, O_RDONLY, handle=0)
  view.setUint32(offset, 0, true); offset += 4; // index
  view.setUint32(offset, 0, true); offset += 4; // file_type=Regular
  view.setUint32(offset, 0, true); offset += 4; // status_flags=O_RDONLY
  view.setBigInt64(offset, 0n, true); offset += 8; // host_handle
  view.setBigInt64(offset, 0n, true); offset += 8; // file_offset
  view.setUint32(offset, 1, true); offset += 4; // ref_count

  // OFD 1: stdout (Regular, O_WRONLY, handle=1)
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4; // Regular
  view.setUint32(offset, 1, true); offset += 4; // O_WRONLY
  view.setBigInt64(offset, 1n, true); offset += 8;
  view.setBigInt64(offset, 0n, true); offset += 8;
  view.setUint32(offset, 1, true); offset += 4;

  // OFD 2: stderr (Regular, O_WRONLY, handle=2)
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4; // Regular
  view.setUint32(offset, 1, true); offset += 4; // O_WRONLY
  view.setBigInt64(offset, 2n, true); offset += 8;
  view.setBigInt64(offset, 0n, true); offset += 8;
  view.setUint32(offset, 1, true); offset += 4;

  // OFD 3: pipe read end (Pipe, O_RDONLY, handle=-1)
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4; // Pipe
  view.setUint32(offset, 0, true); offset += 4; // O_RDONLY
  view.setBigInt64(offset, -1n, true); offset += 8; // kernel-internal pipe
  view.setBigInt64(offset, 0n, true); offset += 8;
  view.setUint32(offset, 1, true); offset += 4;

  // OFD 4: pipe write end (Pipe, O_WRONLY, handle=-1)
  view.setUint32(offset, 4, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4; // Pipe
  view.setUint32(offset, 1, true); offset += 4; // O_WRONLY
  view.setBigInt64(offset, -1n, true); offset += 8; // kernel-internal pipe
  view.setBigInt64(offset, 0n, true); offset += 8;
  view.setUint32(offset, 1, true); offset += 4;

  // Environment: 0 entries
  view.setUint32(offset, 0, true); offset += 4;

  // CWD: "/"
  view.setUint32(offset, 1, true); offset += 4;
  bytes[offset] = 0x2F; offset += 1; // "/"

  // Rlimits: 16 * [soft:u64, hard:u64] = 256 bytes (all zeros)
  offset += 256;

  // Terminal: c_iflag(4) + c_oflag(4) + c_cflag(4) + c_lflag(4) + c_cc(32) + winsize(8) = 56 bytes
  offset += 56;

  return buf;
}

describe("ProcessManager pipe conversion on fork", () => {
  it("should detect pipe OFDs and send conversion messages on fork", async () => {
    const { pm, adapter } = createTestPM();

    // Spawn parent
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;
    const parentWorker = adapter.lastWorker!;

    // Fork parent with pipe OFDs in fork state
    const forkPromise = pm.fork(1);

    // Parent responds with fork state containing pipes
    const forkState = buildForkStateWithPipes();
    parentWorker.simulateMessage({
      type: "fork_state",
      pid: 1,
      data: forkState,
    });

    // Allow microtask queue to flush
    await Promise.resolve();

    // Child worker signals ready
    const childWorker = adapter.lastWorker!;
    childWorker.simulateMessage({ type: "ready", pid: 2 });
    await forkPromise;

    // Both pipe OFDs (indices 3, 4) share host_handle=-1, so they form
    // one pipe group. Each OFD gets its own handle for close tracking.
    // → 2 register_pipe per worker, 2 convert_pipe per worker
    const parentRegisterMsgs = parentWorker.sentMessages.filter(
      (m: any) => m.type === "register_pipe"
    );
    const childRegisterMsgs = childWorker.sentMessages.filter(
      (m: any) => m.type === "register_pipe"
    );

    expect(parentRegisterMsgs.length).toBe(2); // One per OFD (read + write)
    expect(childRegisterMsgs.length).toBe(2);

    // Both register_pipe messages should share the same SharedArrayBuffer
    expect(parentRegisterMsgs[0].buffer).toBe(parentRegisterMsgs[1].buffer);

    // One should be "read" and the other "write"
    const ends = parentRegisterMsgs.map((m: any) => m.end).sort();
    expect(ends).toEqual(["read", "write"]);

    // Both OFD indices should be converted (different handles)
    const parentConvertMsgs = parentWorker.sentMessages.filter(
      (m: any) => m.type === "convert_pipe"
    );
    const childConvertMsgs = childWorker.sentMessages.filter(
      (m: any) => m.type === "convert_pipe"
    );

    expect(parentConvertMsgs.length).toBe(2);
    expect(childConvertMsgs.length).toBe(2);

    // Each OFD gets a different handle
    const parentHandles = parentConvertMsgs.map((m: any) => m.newHandle);
    expect(parentHandles[0]).not.toBe(parentHandles[1]);

    // Verify convert messages reference the correct OFD indices (3 and 4)
    const parentOfdIndices = parentConvertMsgs.map((m: any) => m.ofdIndex).sort();
    expect(parentOfdIndices).toEqual([3, 4]);
  });

  it("should not send pipe messages when fork state has no pipes", async () => {
    const { pm, adapter } = createTestPM();

    // Spawn parent
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;
    const parentWorker = adapter.lastWorker!;

    // Fork with empty fork state (no pipes)
    const forkPromise = pm.fork(1);
    parentWorker.simulateMessage({
      type: "fork_state",
      pid: 1,
      data: new ArrayBuffer(64), // Minimal/invalid fork state with no pipes
    });

    await Promise.resolve();

    const childWorker = adapter.lastWorker!;
    childWorker.simulateMessage({ type: "ready", pid: 2 });
    await forkPromise;

    // No register_pipe or convert_pipe messages
    const parentPipeMsgs = parentWorker.sentMessages.filter(
      (m: any) => m.type === "register_pipe" || m.type === "convert_pipe"
    );
    expect(parentPipeMsgs.length).toBe(0);
  });
});

describe("ProcessManager.deliverSignal()", () => {
  it("should deliver signal to target worker", async () => {
    const { pm, adapter } = createTestPM();

    const p1 = pm.spawn();
    const worker1 = adapter.lastWorker!;
    worker1.simulateMessage({ type: "ready", pid: 1 });
    await p1;

    const p2 = pm.spawn();
    const worker2 = adapter.lastWorker!;
    worker2.simulateMessage({ type: "ready", pid: 2 });
    await p2;

    pm.deliverSignal(2, 15); // SIGTERM

    const signalMsgs = worker2.sentMessages.filter(
      (m: any) => m.type === "deliver_signal"
    );
    expect(signalMsgs).toHaveLength(1);
    expect(signalMsgs[0]).toEqual({ type: "deliver_signal", signal: 15 });
  });

  it("should throw for non-existent process signal delivery", () => {
    const { pm } = createTestPM();
    expect(() => pm.deliverSignal(999, 15)).toThrow();
  });

  it("should throw for zombie process signal delivery", async () => {
    const { pm, adapter } = createTestPM();

    const p = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await p;

    // Transition to zombie
    adapter.lastWorker!.simulateMessage({ type: "exit", pid: 1, status: 0 });

    expect(() => pm.deliverSignal(1, 15)).toThrow();
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
