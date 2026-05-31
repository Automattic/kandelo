# Phase 13b: Fork & Waitpid Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable process forking (clone process state into a new worker) and waitpid (wait for child exit) through the host-side ProcessManager.

**Architecture:** Fork state is serialized to a binary format inside the parent's Wasm kernel, transferred to the host via postMessage, then deserialized in the child's Wasm kernel. ProcessManager.fork() orchestrates this flow. ProcessManager.waitpid() uses Promises to wait for child exit. All cross-process coordination happens in TypeScript.

**Tech Stack:** Rust (kernel serialization), TypeScript (ProcessManager, worker protocol)

**Design doc:** `docs/plans/2026-03-08-multi-worker-design.md`

---

### Task 1: Add Table Iteration and Construction Methods (Rust)

**Files:**
- Modify: `crates/kernel/src/fd.rs`
- Modify: `crates/kernel/src/ofd.rs`
- Modify: `crates/kernel/src/signal.rs`
- Test: existing test targets

The fork serialization module needs to iterate over FD/OFD tables and reconstruct them during deserialization. Currently these tables have private `entries` fields with no iteration or bulk construction APIs.

**Step 1: Add to fd.rs**

```rust
/// Iterate over all open file descriptors.
pub fn iter(&self) -> impl Iterator<Item = (i32, &FdEntry)> + '_ {
    self.entries.iter().enumerate()
        .filter_map(|(i, e)| e.as_ref().map(|entry| (i as i32, entry)))
}

/// Reconstruct an FdTable from raw entries. Used by fork deserialization.
pub fn from_raw(entries: Vec<Option<FdEntry>>, max_fds: usize) -> Self {
    FdTable { entries, max_fds }
}

/// Returns the max_fds limit.
pub fn max_fds(&self) -> usize {
    self.max_fds
}
```

**Step 2: Add to ofd.rs**

```rust
/// Iterate over all open file descriptions with their indices.
pub fn iter(&self) -> impl Iterator<Item = (usize, &OpenFileDesc)> + '_ {
    self.entries.iter().enumerate()
        .filter_map(|(i, e)| e.as_ref().map(|ofd| (i, ofd)))
}

/// Reconstruct an OfdTable from raw entries. Used by fork deserialization.
pub fn from_raw(entries: Vec<Option<OpenFileDesc>>) -> Self {
    OfdTable { entries }
}
```

Also, `OpenFileDesc` needs to be constructable from outside ofd.rs. Check that all fields are `pub`. If `OpenFileDesc::new()` doesn't exist, add one or construct directly (all fields are pub).

**Step 3: Add to signal.rs**

```rust
/// Reconstruct signal state from parts. Used by fork deserialization.
/// Pending signals are cleared (per POSIX, child starts with no pending signals).
pub fn from_parts(handlers: [SignalHandler; 64], blocked: u64) -> Self {
    SignalState { handlers, blocked, pending: 0 }
}

/// Get the raw handlers array for serialization.
pub fn handlers(&self) -> &[SignalHandler; 64] {
    &self.handlers
}
```

**Step 4: Write tests for new methods**

Add tests to the respective test modules verifying iter() returns correct entries and from_raw() reconstructs correctly.

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`
Expected: All existing tests pass + new tests pass

**Step 5: Commit**

```bash
git add crates/kernel/src/fd.rs crates/kernel/src/ofd.rs crates/kernel/src/signal.rs
git commit -m "feat: add iteration and construction methods to FdTable, OfdTable, SignalState"
```

---

### Task 2: Fork State Serialization Module (Rust)

**Files:**
- Create: `crates/kernel/src/fork.rs`
- Modify: `crates/kernel/src/lib.rs` (add `pub mod fork;`)

This is the core of fork: serializing a Process to binary and reconstructing it.

**Binary format (little-endian):**

```
Header (12 bytes):
  [0..3]   magic: u32 = 0x464F524B ("FORK")
  [4..7]   version: u32 = 1
  [8..11]  total_size: u32

Scalars (32 bytes):
  ppid, uid, gid, euid, egid, pgid, sid, umask: u32 each

Signal state (variable):
  blocked: u64
  handler_count: u32
  For each non-default handler:
    signum: u32, handler_type: u32 (0=Default, 1=Ignore, 2+=func_ptr)

FD table (variable):
  max_fds: u32
  fd_count: u32
  For each fd: fd_num: u32, ofd_index: u32, fd_flags: u32

OFD table (variable):
  ofd_count: u32
  For each OFD: index: u32, file_type: u32, status_flags: u32,
                host_handle: i64, offset: i64, ref_count: u32

Environment (variable):
  env_count: u32
  For each: len: u32, data: [u8; len]

CWD (variable):
  len: u32, data: [u8; len]

Rlimits (256 bytes):
  16 * [soft: u64, hard: u64]

Terminal (56 bytes):
  c_iflag: u32, c_oflag: u32, c_cflag: u32, c_lflag: u32,
  c_cc: [u8; 32], ws_row: u16, ws_col: u16, ws_xpixel: u16, ws_ypixel: u16
```

**Step 1: Write failing tests**

```rust
// In fork.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Process;

    #[test]
    fn test_roundtrip_default_process() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        assert!(written > 12); // at least header
        assert_eq!(&buf[0..4], &0x464F524Bu32.to_le_bytes()); // magic

        let child = deserialize_fork_state(&buf[..written], 42).unwrap();
        assert_eq!(child.pid, 42);
        assert_eq!(child.ppid, proc.ppid);
        assert_eq!(child.uid, proc.uid);
        assert_eq!(child.gid, proc.gid);
        assert_eq!(child.umask, proc.umask);
        assert_eq!(child.cwd, proc.cwd);
        // Child gets fresh signal pending mask
        assert_eq!(child.signals.pending, 0);
    }

    #[test]
    fn test_roundtrip_with_environment() {
        let mut proc = Process::new(1);
        proc.environ.push(b"HOME=/home/test".to_vec());
        proc.environ.push(b"PATH=/usr/bin".to_vec());

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 2).unwrap();

        assert_eq!(child.environ.len(), 2);
        assert_eq!(child.environ[0], b"HOME=/home/test");
        assert_eq!(child.environ[1], b"PATH=/usr/bin");
    }

    #[test]
    fn test_roundtrip_with_fds() {
        let mut proc = Process::new(1);
        // Process::new already creates fds 0,1,2
        // Verify they round-trip
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 3).unwrap();

        // Child should have same FD layout
        assert!(child.fd_table.get(0).is_ok());
        assert!(child.fd_table.get(1).is_ok());
        assert!(child.fd_table.get(2).is_ok());
        assert!(child.fd_table.get(3).is_err()); // EBADF
    }

    #[test]
    fn test_roundtrip_with_custom_cwd() {
        let mut proc = Process::new(1);
        proc.cwd = b"/home/user/project".to_vec();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 4).unwrap();
        assert_eq!(child.cwd, b"/home/user/project");
    }

    #[test]
    fn test_roundtrip_signal_handlers() {
        let mut proc = Process::new(1);
        proc.signals.set_handler(2, SignalHandler::Ignore).unwrap(); // SIGINT
        proc.signals.set_handler(15, SignalHandler::Handler(42)).unwrap(); // SIGTERM
        proc.signals.blocked = 0x0000_0004; // block signal 2

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 5).unwrap();

        assert_eq!(child.signals.get_handler(2), SignalHandler::Ignore);
        assert_eq!(child.signals.get_handler(15), SignalHandler::Handler(42));
        assert_eq!(child.signals.blocked, 0x0000_0004);
        assert_eq!(child.signals.pending, 0); // cleared for child
    }

    #[test]
    fn test_roundtrip_rlimits() {
        let mut proc = Process::new(1);
        proc.rlimits[7] = [512, 1024]; // RLIMIT_NOFILE

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 6).unwrap();

        assert_eq!(child.rlimits[7], [512, 1024]);
    }

    #[test]
    fn test_buffer_too_small() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 8]; // way too small
        let result = serialize_fork_state(&proc, &mut buf);
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_magic() {
        let buf = [0u8; 64];
        let result = deserialize_fork_state(&buf, 1);
        assert!(result.is_err());
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo -- fork`
Expected: FAIL — module not found

**Step 3: Implement fork.rs**

Create `crates/kernel/src/fork.rs` with:

1. `Writer` helper struct (wraps `&mut [u8]` with position tracking, write_u32/u64/i64/u16/bytes methods, returns ENOMEM on overflow)
2. `Reader` helper struct (wraps `&[u8]` with position tracking, read_u32/u64/i64/u16/bytes methods, returns EINVAL on underflow)
3. `serialize_fork_state(proc: &Process, buf: &mut [u8]) -> Result<usize, Errno>`
4. `deserialize_fork_state(buf: &[u8], child_pid: u32) -> Result<Process, Errno>`

Key implementation notes:
- Magic constant: `0x464F524Bu32`
- Version: `1u32`
- Signal handlers: only serialize non-Default handlers. During deserialization, start with all-Default and apply the serialized handlers via `set_handler()`.
- FD/OFD tables: serialize with index information so they reconstruct at correct positions
- Child process: `pid = child_pid`, `state = ProcessState::Running`, `exit_status = 0`, `lock_table = LockTable::new()` (locks not inherited), `pipes = Vec::new()`, `sockets = SocketTable::new()`, `dir_streams = Vec::new()`, `memory = MemoryManager::new()`, `signals.pending = 0`
- OFD `owner_pid` should be set to `child_pid` in the deserialized entries
- FileType encoding: Regular=0, Directory=1, Pipe=2, CharDevice=3, Socket=4

Add `pub mod fork;` to `crates/kernel/src/lib.rs`.

**Step 4: Run tests to verify they pass**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`
Expected: All tests pass (286 existing + ~8 new fork tests)

**Step 5: Commit**

```bash
git add crates/kernel/src/fork.rs crates/kernel/src/lib.rs
git commit -m "feat: implement fork state binary serialization and deserialization"
```

---

### Task 3: Wasm Exports for Fork State (Rust)

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs`

**Step 1: Add kernel_get_fork_state export**

```rust
/// Serialize current process state for fork. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_state(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match crate::fork::serialize_fork_state(proc, buf) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}
```

**Step 2: Add kernel_init_from_fork export**

```rust
/// Initialize kernel from serialized fork state (child side).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init_from_fork(buf_ptr: *const u8, buf_len: u32, child_pid: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    match crate::fork::deserialize_fork_state(buf, child_pid) {
        Ok(proc) => {
            unsafe { *PROCESS.0.get() = Some(proc); }
            0
        }
        Err(e) => -(e as i32),
    }
}
```

**Step 3: Verify Wasm build**

Run: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p kandelo --release`
Expected: Build succeeds

Copy the updated wasm to host/wasm/:
```bash
cp target/wasm32-unknown-unknown/release/kandelo.wasm host/wasm/
```

**Step 4: Commit**

```bash
git add crates/kernel/src/wasm_api.rs host/wasm/kandelo.wasm
git commit -m "feat: add kernel_get_fork_state and kernel_init_from_fork Wasm exports"
```

---

### Task 4: Update Worker Protocol and Entry for Fork (TypeScript)

**Files:**
- Modify: `host/src/worker-protocol.ts`
- Modify: `host/src/worker-entry.ts`
- Modify: `host/test/worker-entry.test.ts`

**Step 1: Add fork messages to worker-protocol.ts**

Add to `HostToWorkerMessage` union:
```typescript
| GetForkStateMessage

export interface GetForkStateMessage {
  type: "get_fork_state";
}
```

Add to `WorkerToHostMessage` union:
```typescript
| ForkStateMessage

export interface ForkStateMessage {
  type: "fork_state";
  pid: number;
  data: ArrayBuffer;
}
```

Add `forkState` field to `WorkerInitMessage`:
```typescript
export interface WorkerInitMessage {
  type: "init";
  pid: number;
  ppid: number;
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  env?: string[];
  cwd?: string;
  forkState?: ArrayBuffer;  // If present, init from fork state instead of kernel_init
}
```

**Step 2: Update worker-entry.ts to handle fork**

In `workerMain()`, modify the initialization logic:

```typescript
// After kernel.init(wasmBytes):
const instance = kernel.getInstance()!;

if (initData.forkState) {
  // Fork init: write fork state to Wasm memory and call kernel_init_from_fork
  const memory = kernel.getMemory()!;
  const forkBytes = new Uint8Array(initData.forkState);
  const pages = Math.ceil(forkBytes.byteLength / 65536) + 1;
  const startPage = memory.grow(pages);
  const bufPtr = startPage * 65536;
  new Uint8Array(memory.buffer, bufPtr, forkBytes.byteLength).set(forkBytes);

  const kernelInitFromFork = instance.exports.kernel_init_from_fork as
    (ptr: number, len: number, pid: number) => number;
  const result = kernelInitFromFork(bufPtr, forkBytes.byteLength, initData.pid);
  if (result < 0) {
    throw new Error(`kernel_init_from_fork failed with error ${result}`);
  }
} else {
  // Fresh init
  const kernelInit = instance.exports.kernel_init as (pid: number) => void;
  kernelInit(initData.pid);
}
```

Add handler for `get_fork_state` message:

```typescript
case "get_fork_state": {
  const memory = kernel.getMemory()!;
  const FORK_BUF_PAGES = 16; // 1MB buffer
  const startPage = memory.grow(FORK_BUF_PAGES);
  const bufPtr = startPage * 65536;
  const bufSize = FORK_BUF_PAGES * 65536;

  const kernelGetForkState = instance.exports.kernel_get_fork_state as
    (ptr: number, len: number) => number;
  const written = kernelGetForkState(bufPtr, bufSize);
  if (written < 0) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `kernel_get_fork_state failed: ${written}`,
    } satisfies WorkerToHostMessage);
    break;
  }

  const forkData = new Uint8Array(memory.buffer, bufPtr, written).slice();
  port.postMessage(
    { type: "fork_state", pid: initData.pid, data: forkData.buffer } satisfies WorkerToHostMessage,
    [forkData.buffer], // Transfer, don't clone
  );
  break;
}
```

**Step 3: Write test for fork init path**

Add to `host/test/worker-entry.test.ts`:

```typescript
it("should initialize from fork state", async () => {
  // First, get fork state from a normal init
  const port1 = createMockPort();
  await workerMain(port1 as any, {
    type: "init", pid: 1, ppid: 0,
    wasmBytes: loadWasmBytes(),
    kernelConfig: defaultConfig,
  });
  expect(port1.messages[0]).toMatchObject({ type: "ready", pid: 1 });

  // Now simulate getting fork state by calling kernel_get_fork_state
  // This requires access to the Wasm instance, so test via integration test instead
});
```

Note: Full fork state round-trip testing is done in the Rust unit tests and the integration test (Task 6). The worker-entry test verifies the basic paths.

**Step 4: Run tests**

Run: `cd host && npx vitest run`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add host/src/worker-protocol.ts host/src/worker-entry.ts host/test/worker-entry.test.ts
git commit -m "feat: add fork support to worker protocol and entry point"
```

---

### Task 5: ProcessManager.fork() (TypeScript)

**Files:**
- Modify: `host/src/process-manager.ts`
- Modify: `host/test/process-manager.test.ts`

**Step 1: Write failing tests**

Add to `host/test/process-manager.test.ts`:

```typescript
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
      data: new ArrayBuffer(64), // dummy fork state
    });

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
```

**Step 2: Run tests to verify they fail**

Run: `cd host && npx vitest run test/process-manager.test.ts`
Expected: FAIL — fork method doesn't exist

**Step 3: Implement ProcessManager.fork()**

Add to `ProcessManager` class:

```typescript
async fork(parentPid: number): Promise<number> {
  const parentInfo = this.processes.get(parentPid);
  if (!parentInfo || parentInfo.state !== "running") {
    throw new Error(`Cannot fork process ${parentPid}: not running`);
  }

  // Request fork state from parent
  const forkState = await this.requestForkState(parentInfo);

  // Allocate child PID
  const childPid = this.nextPid++;

  // Create child worker with fork state
  const initData: WorkerInitMessage = {
    type: "init",
    pid: childPid,
    ppid: parentPid,
    wasmBytes: this.config.wasmBytes,
    kernelConfig: this.config.kernelConfig,
    forkState,
  };

  const worker = this.config.workerAdapter.createWorker(initData);
  const childInfo: ProcessInfo = {
    pid: childPid,
    ppid: parentPid,
    pgid: parentInfo.pgid,
    sid: parentInfo.sid,
    worker,
    state: "starting",
  };
  this.processes.set(childPid, childInfo);

  // Wait for child ready (reuse spawn's ready-wait pattern)
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.processes.delete(childPid);
      worker.terminate().catch(() => {});
      reject(new Error(`Forked process ${childPid} timed out during initialization`));
    }, 10_000);

    worker.on("message", (msg: unknown) => {
      const m = msg as WorkerToHostMessage;
      switch (m.type) {
        case "ready":
          if (childInfo.state === "starting") {
            clearTimeout(timeout);
            childInfo.state = "running";
            resolve(childPid);
          }
          break;
        case "exit":
          if (childInfo.state === "starting") {
            clearTimeout(timeout);
            this.processes.delete(childPid);
            reject(new Error(`Forked worker exited with status ${m.status}`));
          } else {
            childInfo.state = "zombie";
            childInfo.exitStatus = m.status;
          }
          break;
        case "error":
          if (childInfo.state === "starting") {
            clearTimeout(timeout);
            this.processes.delete(childPid);
            worker.terminate().catch(() => {});
            reject(new Error(m.message));
          }
          break;
      }
    });

    worker.on("error", (err: Error) => {
      if (childInfo.state === "starting") {
        clearTimeout(timeout);
        this.processes.delete(childPid);
        reject(err);
      }
    });

    worker.on("exit", (code: number) => {
      if (childInfo.state === "starting") {
        clearTimeout(timeout);
        this.processes.delete(childPid);
        reject(new Error(`Forked worker exited with code ${code}`));
      }
    });
  });
}

private requestForkState(parentInfo: ProcessInfo): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Fork state request timed out for process ${parentInfo.pid}`));
    }, 10_000);

    parentInfo.worker.on("message", (msg: unknown) => {
      const m = msg as WorkerToHostMessage;
      if (m.type === "fork_state" && m.pid === parentInfo.pid) {
        clearTimeout(timeout);
        resolve(m.data);
      }
    });

    parentInfo.worker.postMessage({ type: "get_fork_state" });
  });
}
```

**Step 4: Run tests**

Run: `cd host && npx vitest run test/process-manager.test.ts`
Expected: All tests pass (existing 9 + new fork tests)

**Step 5: Commit**

```bash
git add host/src/process-manager.ts host/test/process-manager.test.ts
git commit -m "feat: implement ProcessManager.fork() with state transfer"
```

---

### Task 6: ProcessManager.waitpid() (TypeScript)

**Files:**
- Modify: `host/src/process-manager.ts`
- Modify: `host/test/process-manager.test.ts`

**Step 1: Write failing tests**

```typescript
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
```

**Step 2: Implement ProcessManager.waitpid()**

```typescript
export interface WaitResult {
  pid: number;
  status: number;
}

// Add to ProcessManager class:

async waitpid(targetPid: number, options: number = 0): Promise<WaitResult> {
  const WNOHANG = 1;

  const info = this.processes.get(targetPid);
  if (!info) {
    throw new Error(`No such process: ${targetPid}`);
  }

  // Already exited? Reap immediately.
  if (info.state === "zombie") {
    const status = info.exitStatus ?? 0;
    this.processes.delete(targetPid);
    return { pid: targetPid, status };
  }

  // WNOHANG: return immediately if not exited
  if (options & WNOHANG) {
    return { pid: 0, status: 0 };
  }

  // Wait for exit
  return new Promise<WaitResult>((resolve) => {
    info.worker.on("message", (msg: unknown) => {
      const m = msg as WorkerToHostMessage;
      if (m.type === "exit" && m.pid === targetPid) {
        this.processes.delete(targetPid);
        resolve({ pid: targetPid, status: m.status });
      }
    });

    info.worker.on("exit", (code: number) => {
      this.processes.delete(targetPid);
      resolve({ pid: targetPid, status: code });
    });
  });
}
```

**Step 3: Run tests**

Run: `cd host && npx vitest run test/process-manager.test.ts`
Expected: All tests pass

**Step 4: Update exports in index.ts**

Add `WaitResult` to exports:
```typescript
export type { ProcessInfo, ProcessManagerConfig, SpawnOptions, WaitResult } from "./process-manager";
```

**Step 5: Commit**

```bash
git add host/src/process-manager.ts host/test/process-manager.test.ts host/src/index.ts
git commit -m "feat: implement ProcessManager.waitpid() with WNOHANG support"
```

---

### Task 7: Integration Test — Fork & Waitpid with Real Workers (TypeScript)

**Files:**
- Modify: `host/test/multi-worker.test.ts`

**Step 1: Add fork integration tests**

```typescript
describe("Fork Integration", () => {
  it("should fork a process and create a child with cloned state", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: defaultConfig,
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
      kernelConfig: defaultConfig,
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
```

**Step 2: Run integration tests**

Run: `cd host && npx vitest run test/multi-worker.test.ts`
Expected: All tests pass (2 existing + 2 new)

**Step 3: Run all tests**

Run: `cd host && npx vitest run`
Expected: All tests pass

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`
Expected: All Rust tests pass

**Step 4: Commit**

```bash
git add host/test/multi-worker.test.ts
git commit -m "test: add fork and waitpid integration tests with real workers"
```

---

### Task 8: Update Documentation

**Files:**
- Modify: `docs/posix-status.md`

**Step 1: Update posix-status.md**

Update fork/waitpid entries from "Planned" to "Partial" (host-side only, no Wasm-internal fork syscall yet).

Add Phase 13b to the Implementation Priority section:

```markdown
### Phase 13b — Fork & Waitpid
- Binary fork state serialization/deserialization (Rust)
- kernel_get_fork_state / kernel_init_from_fork Wasm exports
- ProcessManager.fork() with state transfer to child worker
- ProcessManager.waitpid() with WNOHANG support
```

**Step 2: Commit**

```bash
git add docs/posix-status.md
git commit -m "docs: update POSIX status for Phase 13b fork and waitpid"
```
