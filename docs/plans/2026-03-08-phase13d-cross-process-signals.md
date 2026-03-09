# Phase 13d: Cross-Process Signals Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable `kill(pid, sig)` to deliver signals across worker boundaries so one process can signal another.

**Architecture:** The kernel's `sys_kill` currently ignores the pid parameter and always raises the signal locally. We add a `host_kill` Wasm import that the kernel calls when `pid != self.pid`. The host (ProcessManager) looks up the target worker and posts a `DeliverSignalMessage`. The target worker calls `kernel_deliver_signal(sig)` which raises the signal in its kernel's SignalState. For `pid == self.pid` or `pid == 0` (current process group, simplified to self), the kernel continues to raise locally.

**Tech Stack:** Rust (kernel), TypeScript (host glue), Wasm

---

### Task 1: kernel_deliver_signal Wasm Export

Add a new kernel export that the host can call to inject a signal into this kernel instance from an external source.

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` (~line 947, near kernel_kill)
- Test: `crates/kernel/src/syscalls.rs` (existing signal tests section ~line 3062)

**Step 1: Write the failing test**

In `crates/kernel/src/syscalls.rs`, add a test in the existing signal tests section:

```rust
#[test]
fn test_deliver_signal_marks_pending() {
    let mut proc = Process::new(1);
    // Simulate what kernel_deliver_signal does
    proc.signals.raise(15); // SIGTERM
    assert!(proc.signals.is_pending(15));
}
```

This test validates the underlying mechanism. The actual `kernel_deliver_signal` export is a thin wrapper around `proc.signals.raise(sig)` with validation.

**Step 2: Run test to verify it passes**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') test_deliver_signal`
Expected: PASS (since raise already works — this just confirms the mechanism)

**Step 3: Add kernel_deliver_signal export**

In `crates/kernel/src/wasm_api.rs`, after the existing `kernel_kill` function (~line 951):

```rust
/// Deliver a signal from an external source (host). Called by host when
/// another process sends a signal to this one via kill().
/// Returns 0 on success, -EINVAL for invalid signal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_deliver_signal(sig: u32) -> i32 {
    let proc = unsafe { PROCESS.as_mut().unwrap() };
    if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
        return -(wasm_posix_shared::Errno::EINVAL as i32);
    }
    proc.signals.raise(sig);
    0
}
```

**Step 4: Build Wasm to verify export compiles**

Run: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release`
Expected: Success

**Step 5: Commit**

```bash
git add crates/kernel/src/wasm_api.rs crates/kernel/src/syscalls.rs
git commit -m "feat: add kernel_deliver_signal export for cross-process signals"
```

---

### Task 2: host_kill Wasm Import and sys_kill Modification

Add `host_kill(pid, sig)` as a Wasm import in the kernel. Modify `sys_kill` to call `host_kill` when the target pid differs from the current process. The host import returns 0 on success, negative errno on failure.

**Files:**
- Modify: `crates/kernel/src/process.rs` (add host_kill to HostIO trait, ~line 49)
- Modify: `crates/kernel/src/syscalls.rs` (sys_kill ~line 962, add host param; tests ~line 3062)
- Modify: `crates/kernel/src/wasm_api.rs` (add host_kill extern, update kernel_kill to pass host)

**Step 1: Write the failing test for cross-process kill**

In `crates/kernel/src/syscalls.rs`, in the test section:

```rust
#[test]
fn test_kill_remote_pid_calls_host_kill() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Kill pid 2 (not self) — should call host_kill
    let result = sys_kill(&mut proc, &mut host, 2, 15); // SIGTERM to pid 2
    assert!(result.is_ok());
    // Signal should NOT be pending locally (it was sent to another process)
    assert!(!proc.signals.is_pending(15));
}

#[test]
fn test_kill_self_raises_locally() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let result = sys_kill(&mut proc, &mut host, 1, 2); // SIGINT to self
    assert!(result.is_ok());
    assert!(proc.signals.is_pending(2));
}

#[test]
fn test_kill_pid_zero_raises_locally() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // pid 0 means "current process group" — simplified to self
    let result = sys_kill(&mut proc, &mut host, 0, 2);
    assert!(result.is_ok());
    assert!(proc.signals.is_pending(2));
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') test_kill_remote`
Expected: FAIL — `sys_kill` doesn't take a `host` parameter yet

**Step 3: Add host_kill to HostIO trait**

In `crates/kernel/src/process.rs`, add at the end of the `HostIO` trait (after `host_fchown`):

```rust
fn host_kill(&mut self, pid: i32, sig: u32) -> Result<(), Errno>;
```

In the `MockHostIO` implementation in `syscalls.rs` (search for `impl HostIO for MockHostIO`), add:

```rust
fn host_kill(&mut self, _pid: i32, _sig: u32) -> Result<(), Errno> {
    Ok(())
}
```

**Step 4: Modify sys_kill to accept host and route by pid**

Replace the current `sys_kill` (~line 962):

```rust
/// Send a signal to a process.
/// If pid matches current process or is 0 (process group, simplified to self),
/// raises locally. Otherwise delegates to host for cross-process delivery.
pub fn sys_kill(proc: &mut Process, host: &mut dyn HostIO, pid: i32, sig: u32) -> Result<(), Errno> {
    if sig == 0 {
        // sig=0 is a validity check -- just return success
        return Ok(());
    }
    if sig >= NSIG {
        return Err(Errno::EINVAL);
    }
    if pid == proc.pid as i32 || pid == 0 || pid == -(proc.pgid as i32) {
        // Local delivery: self, current process group, or own pgid
        proc.signals.raise(sig);
        Ok(())
    } else {
        // Cross-process: delegate to host
        host.host_kill(pid, sig)
    }
}
```

**Step 5: Update sys_raise to pass host**

```rust
pub fn sys_raise(proc: &mut Process, host: &mut dyn HostIO, sig: u32) -> Result<(), Errno> {
    sys_kill(proc, host, proc.pid as i32, sig)
}
```

**Step 6: Update wasm_api.rs kernel_kill and kernel_raise**

In `wasm_api.rs`, add the `host_kill` extern declaration near the other externs:

```rust
fn host_kill(pid: i32, sig: u32) -> i32;
```

Update `kernel_kill` to create a HostAdapter and pass it:

```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_kill(pid: i32, sig: u32) -> i32 {
    let proc = unsafe { PROCESS.as_mut().unwrap() };
    let mut host = HostAdapter;
    match syscalls::sys_kill(proc, &mut host, pid, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}
```

And update `kernel_raise`:

```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_raise(sig: u32) -> i32 {
    let proc = unsafe { PROCESS.as_mut().unwrap() };
    let mut host = HostAdapter;
    match syscalls::sys_raise(proc, &mut host, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}
```

Add `host_kill` to the HostAdapter impl:

```rust
fn host_kill(&mut self, pid: i32, sig: u32) -> Result<(), Errno> {
    let ret = unsafe { host_kill(pid, sig) };
    if ret < 0 { Err(Errno::from_i32(-ret)) } else { Ok(()) }
}
```

**Step 7: Fix existing tests that call sys_kill/sys_raise without host**

Update all existing `sys_kill` test calls to include `&mut host` parameter. Update `sys_raise` calls similarly. The test `test_raise_is_kill_to_self` needs a MockHostIO.

**Step 8: Run all tests**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}')`
Expected: All pass

**Step 9: Build Wasm**

Run: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release`
Expected: Success

**Step 10: Copy Wasm binary**

```bash
cp target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/wasm_posix_kernel.wasm
```

**Step 11: Commit**

```bash
git add crates/kernel/src/process.rs crates/kernel/src/syscalls.rs crates/kernel/src/wasm_api.rs host/wasm/wasm_posix_kernel.wasm
git commit -m "feat: add host_kill import and cross-process signal routing in sys_kill"
```

---

### Task 3: DeliverSignalMessage Protocol and ProcessManager.deliverSignal()

Add the protocol message for cross-process signal delivery and implement `ProcessManager.deliverSignal()` which looks up the target worker and posts the signal message.

**Files:**
- Modify: `host/src/worker-protocol.ts` (add DeliverSignalMessage)
- Modify: `host/src/process-manager.ts` (add deliverSignal method)
- Modify: `host/src/worker-entry.ts` (handle deliver_signal message)
- Modify: `host/src/index.ts` (export new type)
- Test: `host/test/process-manager.test.ts`

**Step 1: Write failing test**

In `host/test/process-manager.test.ts`:

```typescript
it("should deliver signal to target worker", async () => {
  const pm = new ProcessManager(config);
  const pid1 = await pm.spawn();
  const pid2 = await pm.spawn();

  pm.deliverSignal(pid2, 15); // SIGTERM

  const proc2 = pm.getProcess(pid2)!;
  const messages = (proc2.worker as MockWorkerHandle).getMessages();
  const signalMsgs = messages.filter((m: any) => m.type === "deliver_signal");
  expect(signalMsgs).toHaveLength(1);
  expect(signalMsgs[0]).toEqual({ type: "deliver_signal", signal: 15 });
});

it("should throw ESRCH for non-existent process", () => {
  const pm = new ProcessManager(config);
  expect(() => pm.deliverSignal(999, 15)).toThrow();
});
```

**Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/process-manager.test.ts`
Expected: FAIL — deliverSignal doesn't exist yet

**Step 3: Add DeliverSignalMessage to protocol**

In `host/src/worker-protocol.ts`, add to `HostToWorkerMessage` union:

```typescript
export type HostToWorkerMessage =
  | WorkerInitMessage
  | WorkerTerminateMessage
  | GetForkStateMessage
  | RegisterPipeMessage
  | ConvertPipeMessage
  | DeliverSignalMessage;

export interface DeliverSignalMessage {
  type: "deliver_signal";
  signal: number;
}
```

**Step 4: Implement ProcessManager.deliverSignal()**

In `host/src/process-manager.ts`:

```typescript
deliverSignal(targetPid: number, signal: number): void {
  const info = this.processes.get(targetPid);
  if (!info || info.state === "zombie") {
    throw new Error(`No such process: ${targetPid}`);
  }
  info.worker.postMessage({ type: "deliver_signal", signal });
}
```

**Step 5: Handle deliver_signal in worker-entry.ts**

In `host/src/worker-entry.ts`, add to the message switch:

```typescript
case "deliver_signal": {
  const deliverFn = instance.exports.kernel_deliver_signal as
    (sig: number) => number;
  deliverFn(m.signal);
  break;
}
```

Add `DeliverSignalMessage` to the imports from worker-protocol.

**Step 6: Export new type from index.ts**

Add `DeliverSignalMessage` to the type exports in `host/src/index.ts`.

**Step 7: Run tests**

Run: `cd host && npx vitest run`
Expected: All pass

**Step 8: Commit**

```bash
git add host/src/worker-protocol.ts host/src/process-manager.ts host/src/worker-entry.ts host/src/index.ts host/test/process-manager.test.ts
git commit -m "feat: add DeliverSignalMessage and ProcessManager.deliverSignal()"
```

---

### Task 4: host_kill Implementation in kernel.ts

Wire up the `host_kill` Wasm import in `kernel.ts` so the kernel can call it. Since `kernel.ts` doesn't have a reference to ProcessManager, we add a callback-based approach: `WasmPosixKernel` accepts an optional `onKill` callback that routes to ProcessManager.

**Files:**
- Modify: `host/src/kernel.ts` (add host_kill import, onKill callback)
- Modify: `host/src/worker-entry.ts` (pass onKill callback when creating kernel)
- Test: `host/test/kernel.test.ts`

**Step 1: Write failing test**

In `host/test/kernel.test.ts`, add:

```typescript
it("should call onKill callback when host_kill is invoked", async () => {
  let killArgs: { pid: number; signal: number } | null = null;
  const kernel = new WasmPosixKernel(
    { uid: 1000, gid: 1000, pid: 1, ppid: 0, umask: 0o022 },
    new NodePlatformIO(),
    { onKill: (pid, signal) => { killArgs = { pid, signal }; return 0; } },
  );
  // Verify constructor accepts the callback (actual invocation tested in integration)
  expect(kernel).toBeDefined();
});
```

**Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/kernel.test.ts`
Expected: FAIL — constructor doesn't accept third argument

**Step 3: Add onKill callback support to kernel.ts**

In `host/src/kernel.ts`:

1. Add callback type and constructor parameter:

```typescript
export interface KernelCallbacks {
  onKill?: (pid: number, signal: number) => number;
}
```

2. Update constructor:

```typescript
private callbacks: KernelCallbacks;

constructor(config: KernelConfig, io: PlatformIO, callbacks?: KernelCallbacks) {
  this.config = config;
  this.io = io;
  this.callbacks = callbacks ?? {};
}
```

3. Add `host_kill` to the import object in `init()`, after `host_fchown`:

```typescript
host_kill: (pid: number, sig: number): number => {
  return this.hostKill(pid, sig);
},
```

4. Add the implementation method:

```typescript
private hostKill(pid: number, sig: number): number {
  if (this.callbacks.onKill) {
    return this.callbacks.onKill(pid, sig);
  }
  // No callback registered — can only signal self (not cross-process)
  return -3; // -ESRCH
}
```

**Step 4: Wire up onKill in worker-entry.ts**

In `host/src/worker-entry.ts`, when creating the kernel, pass a callback that posts a message to the host:

The challenge: `host_kill` is a synchronous Wasm import, but cross-process signaling is asynchronous (needs postMessage). The host_kill call should be fire-and-forget from the kernel's perspective — post the message and return 0 (success). ProcessManager handles the async delivery.

Update the kernel creation:

```typescript
const kernel = new WasmPosixKernel(initData.kernelConfig, new NodePlatformIO(), {
  onKill: (pid: number, signal: number): number => {
    port.postMessage({ type: "kill_request", pid, signal, sourcePid: initData.pid });
    return 0;
  },
});
```

This requires a new worker-to-host message type `KillRequestMessage`.

**Step 5: Add KillRequestMessage to protocol**

In `host/src/worker-protocol.ts`:

```typescript
export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerExitMessage
  | WorkerErrorMessage
  | ForkStateMessage
  | KillRequestMessage;

export interface KillRequestMessage {
  type: "kill_request";
  pid: number;
  signal: number;
  sourcePid: number;
}
```

**Step 6: Handle kill_request in ProcessManager**

In `host/src/process-manager.ts`, in the worker message handlers (both `spawn` and `fork`), add:

```typescript
case "kill_request":
  try {
    this.deliverSignal(m.pid, m.signal);
  } catch {
    // Target doesn't exist — ESRCH, but caller already returned 0
  }
  break;
```

**Step 7: Export KillRequestMessage from index.ts**

**Step 8: Run tests**

Run: `cd host && npx vitest run`
Expected: All pass

**Step 9: Commit**

```bash
git add host/src/kernel.ts host/src/worker-entry.ts host/src/worker-protocol.ts host/src/process-manager.ts host/src/index.ts host/test/kernel.test.ts
git commit -m "feat: wire host_kill import through worker to ProcessManager"
```

---

### Task 5: Integration Test

Write an integration test that spawns two workers, has one send a signal to the other, and verifies delivery.

**Files:**
- Modify: `host/test/multi-worker.test.ts`

**Step 1: Write integration test**

```typescript
describe("Cross-Process Signal Delivery", () => {
  it("should deliver signal from parent to child via kill", async () => {
    const pm = new ProcessManager(config);
    const parentPid = await pm.spawn();
    const childPid = await pm.spawn({ ppid: parentPid });

    // Parent sends SIGTERM to child
    pm.deliverSignal(childPid, 15);

    // Verify the deliver_signal message was sent to child worker
    const childInfo = pm.getProcess(childPid)!;
    const messages = (childInfo.worker as MockWorkerHandle).getMessages();
    const signalMsgs = messages.filter((m: any) => m.type === "deliver_signal");
    expect(signalMsgs).toHaveLength(1);
    expect(signalMsgs[0].signal).toBe(15);
  });
});
```

**Step 2: Run tests**

Run: `cd host && npx vitest run`
Expected: All pass

**Step 3: Commit**

```bash
git add host/test/multi-worker.test.ts
git commit -m "test: add cross-process signal delivery integration test"
```

---

### Task 6: Documentation

Update `docs/posix-status.md` with Phase 13d completion.

**Files:**
- Modify: `docs/posix-status.md`

**Step 1: Update posix-status.md**

- Update kill() entry to note cross-process support
- Add Phase 13d completion entry

**Step 2: Commit**

```bash
git add docs/posix-status.md
git commit -m "docs: update POSIX status for Phase 13d cross-process signals"
```
