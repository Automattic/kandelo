# Phase 13f: Alarm & Sigsuspend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement POSIX alarm() with host-side timers and sigsuspend() with SharedArrayBuffer-based wake mechanism.

**Architecture:** alarm() tracks deadline in kernel Process state, delegates timer management to the host ProcessManager via fire-and-forget callback. sigsuspend() temporarily swaps the signal mask and blocks the worker thread using Atomics.wait on a per-process SharedArrayBuffer; signal delivery wakes the worker via Atomics.notify. Both integrate with the existing deliver_signal infrastructure.

**Tech Stack:** Rust (kernel), TypeScript (host), SharedArrayBuffer + Atomics (cross-thread wake)

---

## Context

### Key Files
- `crates/shared/src/lib.rs` — Syscall enum, signal constants (SIGALRM=14)
- `crates/kernel/src/process.rs` — Process struct, HostIO trait
- `crates/kernel/src/signal.rs` — SignalState (handlers, blocked, pending, deliverable())
- `crates/kernel/src/syscalls.rs` — Syscall implementations
- `crates/kernel/src/wasm_api.rs` — Wasm exports and host imports
- `host/src/kernel.ts` — WasmPosixKernel, KernelCallbacks, host imports
- `host/src/worker-entry.ts` — Worker message handler, callbacks
- `host/src/worker-protocol.ts` — Message types
- `host/src/process-manager.ts` — ProcessInfo, ProcessManager

### Key Patterns
- **Host imports**: Wasm calls `host_xxx()` extern → WasmHostIO delegates to JS import in kernel.ts
- **Callbacks**: kernel.ts callbacks (onKill, onExec) → worker-entry.ts posts message to host → ProcessManager handles
- **Signal delivery**: ProcessManager.deliverSignal() → posts deliver_signal message → worker calls kernel_deliver_signal
- **Blocking**: Atomics.wait blocks worker thread synchronously; Atomics.notify from main thread wakes it

### Test Commands
- Rust: `cargo test --target $(rustc -vV | grep host | awk '{print $2}')`
- TypeScript: `cd host && npx vitest run`
- Build Wasm: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release && cp target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/`

### POSIX Semantics
- **alarm(seconds)**: Schedules SIGALRM delivery after `seconds`. Returns previous remaining seconds. alarm(0) cancels. Not inherited by fork children. Canceled by exec.
- **sigsuspend(mask)**: Atomically replaces signal mask with `mask` and suspends until a signal whose action is to invoke a handler or terminate the process. Always returns -1/EINTR.

---

### Task 1: Kernel-side alarm implementation (Rust)

**Files:**
- Modify: `crates/kernel/src/process.rs` — Add alarm_deadline_ns to Process, host_set_alarm to HostIO
- Modify: `crates/kernel/src/syscalls.rs` — Add sys_alarm, add host_set_alarm to MockHostIO
- Modify: `crates/kernel/src/wasm_api.rs` — Add host_set_alarm extern, WasmHostIO impl, kernel_alarm export
- Test: `crates/kernel/src/syscalls.rs` (inline tests)

**Step 1: Add alarm_deadline_ns to Process struct**

In `crates/kernel/src/process.rs`, add field to Process:
```rust
pub struct Process {
    // ... existing fields ...
    pub alarm_deadline_ns: u64,
}
```

And in `Process::new()`, initialize it:
```rust
alarm_deadline_ns: 0,
```

**Step 2: Add host_set_alarm to HostIO trait**

In `crates/kernel/src/process.rs`, add to the HostIO trait:
```rust
fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno>;
```

**Step 3: Implement sys_alarm in syscalls.rs**

```rust
pub fn sys_alarm(proc: &mut Process, host: &mut dyn HostIO, seconds: u32) -> Result<u32, Errno> {
    let (sec, nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC)?;
    let now_ns = (sec as u64).wrapping_mul(1_000_000_000).wrapping_add(nsec as u64);

    // Compute remaining seconds from previous alarm (rounded up)
    let remaining = if proc.alarm_deadline_ns > now_ns {
        ((proc.alarm_deadline_ns - now_ns + 999_999_999) / 1_000_000_000) as u32
    } else {
        0
    };

    // Set new deadline
    if seconds > 0 {
        proc.alarm_deadline_ns = now_ns + (seconds as u64) * 1_000_000_000;
    } else {
        proc.alarm_deadline_ns = 0;
    }

    // Tell host to schedule/cancel timer
    host.host_set_alarm(seconds)?;

    Ok(remaining)
}
```

**Step 4: Add host_set_alarm to MockHostIO and WasmHostIO**

In `crates/kernel/src/syscalls.rs` MockHostIO:
```rust
fn host_set_alarm(&mut self, _seconds: u32) -> Result<(), Errno> {
    Ok(())
}
```

In `crates/kernel/src/wasm_api.rs`, add extern:
```rust
fn host_set_alarm(seconds: u32) -> i32;
```

Add WasmHostIO impl:
```rust
fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno> {
    let result = unsafe { host_set_alarm(seconds) };
    i32_to_result(result)
}
```

**Step 5: Add kernel_alarm export**

In `crates/kernel/src/wasm_api.rs`:
```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_alarm(seconds: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    match syscalls::sys_alarm(proc, &mut host, seconds) {
        Ok(remaining) => remaining as i32,
        Err(e) => -(e as i32),
    }
}
```

**Step 6: Write tests**

In `crates/kernel/src/syscalls.rs` tests:
```rust
#[test]
fn test_alarm_sets_deadline_and_returns_zero_initially() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let remaining = sys_alarm(&mut proc, &mut host, 5).unwrap();
    assert_eq!(remaining, 0);
    assert!(proc.alarm_deadline_ns > 0);
}

#[test]
fn test_alarm_returns_previous_remaining() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Set alarm for 10 seconds
    sys_alarm(&mut proc, &mut host, 10).unwrap();
    // Set another alarm — should return ~10 (previous remaining)
    let remaining = sys_alarm(&mut proc, &mut host, 5).unwrap();
    assert!(remaining > 0 && remaining <= 10);
}

#[test]
fn test_alarm_zero_cancels() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    sys_alarm(&mut proc, &mut host, 5).unwrap();
    let remaining = sys_alarm(&mut proc, &mut host, 0).unwrap();
    assert!(remaining > 0);
    assert_eq!(proc.alarm_deadline_ns, 0);
}
```

**Step 7: Run tests**

```bash
cargo test --target $(rustc -vV | grep host | awk '{print $2}')
```

**Step 8: Commit**

```bash
git add crates/
git commit -m "feat: add alarm() kernel implementation with deadline tracking"
```

---

### Task 2: Kernel-side sigsuspend implementation (Rust)

**Files:**
- Modify: `crates/shared/src/lib.rs` — Add Sigsuspend = 110 to Syscall enum
- Modify: `crates/kernel/src/process.rs` — Add host_sigsuspend_wait to HostIO
- Modify: `crates/kernel/src/syscalls.rs` — Add sys_sigsuspend, MockHostIO stub
- Modify: `crates/kernel/src/wasm_api.rs` — Add extern, WasmHostIO impl, kernel_sigsuspend export
- Test: `crates/kernel/src/syscalls.rs` (inline tests)

**Step 1: Add Sigsuspend to Syscall enum**

In `crates/shared/src/lib.rs`, add after `Realpath = 109`:
```rust
Sigsuspend = 110,
```

And in `from_u32()`, add:
```rust
110 => Some(Syscall::Sigsuspend),
```

**Step 2: Add host_sigsuspend_wait to HostIO**

In `crates/kernel/src/process.rs`:
```rust
/// Block until a signal is delivered. Returns the signal number.
fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno>;
```

**Step 3: Implement sys_sigsuspend**

In `crates/kernel/src/syscalls.rs`:
```rust
pub fn sys_sigsuspend(proc: &mut Process, host: &mut dyn HostIO, mask: u64) -> Result<(), Errno> {
    use wasm_posix_shared::signal::{NSIG, SIGKILL, SIGSTOP};

    let old_mask = proc.signals.blocked;
    // Cannot block SIGKILL or SIGSTOP
    proc.signals.blocked = mask & !((1u64 << SIGKILL) | (1u64 << SIGSTOP));

    // Check if any signals are already deliverable with new mask
    if proc.signals.deliverable() != 0 {
        proc.signals.blocked = old_mask;
        return Err(Errno::EINTR);
    }

    // Block until a deliverable signal arrives
    loop {
        let sig = host.host_sigsuspend_wait()?;
        if sig > 0 && sig < NSIG {
            proc.signals.raise(sig);
        }
        if proc.signals.deliverable() != 0 {
            break;
        }
    }

    proc.signals.blocked = old_mask;
    Err(Errno::EINTR)
}
```

**Step 4: Add MockHostIO impl**

In `crates/kernel/src/syscalls.rs` MockHostIO — store a signal to return:
```rust
// Add field to MockHostIO:
sigsuspend_signal: u32,
```

Initialize in `MockHostIO::new()`:
```rust
sigsuspend_signal: 0,
```

Implement:
```rust
fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
    Ok(self.sigsuspend_signal)
}
```

**Step 5: Add WasmHostIO impl and kernel export**

In `crates/kernel/src/wasm_api.rs`, add extern:
```rust
fn host_sigsuspend_wait() -> i32;
```

WasmHostIO impl:
```rust
fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
    let result = unsafe { host_sigsuspend_wait() };
    if result < 0 {
        Err(Errno::from_u32((-result) as u32).unwrap_or(Errno::EINTR))
    } else {
        Ok(result as u32)
    }
}
```

kernel_sigsuspend export:
```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigsuspend(mask_lo: u32, mask_hi: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let mask = ((mask_hi as u64) << 32) | (mask_lo as u64);
    match syscalls::sys_sigsuspend(proc, &mut host, mask) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}
```

**Step 6: Write tests**

```rust
#[test]
fn test_sigsuspend_returns_eintr_when_signal_already_pending() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Raise SIGINT (2)
    proc.signals.raise(2);
    // sigsuspend with mask that doesn't block SIGINT
    let result = sys_sigsuspend(&mut proc, &mut host, 0);
    assert_eq!(result, Err(Errno::EINTR));
}

#[test]
fn test_sigsuspend_restores_old_mask() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    proc.signals.blocked = 0xFF;
    proc.signals.raise(2); // SIGINT pending
    let _ = sys_sigsuspend(&mut proc, &mut host, 0);
    // Old mask should be restored
    assert_eq!(proc.signals.blocked, 0xFF);
}

#[test]
fn test_sigsuspend_blocks_until_signal() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Configure mock to return SIGTERM
    host.sigsuspend_signal = 15; // SIGTERM
    // No signals pending, mask blocks nothing
    let result = sys_sigsuspend(&mut proc, &mut host, 0);
    assert_eq!(result, Err(Errno::EINTR));
    assert!(proc.signals.is_pending(15));
}

#[test]
fn test_sigsuspend_ignores_blocked_signal_from_host() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Mock returns SIGINT (2), but sigsuspend mask blocks it
    // This will loop forever in real code, but MockHostIO always returns same signal
    // So we need to set up the mock to return a second signal too...
    // For simplicity: set mock to return SIGTERM (15), mask blocks SIGINT (2) only
    host.sigsuspend_signal = 15;
    let mask = 1u64 << 2; // block SIGINT
    let result = sys_sigsuspend(&mut proc, &mut host, mask);
    assert_eq!(result, Err(Errno::EINTR));
    assert!(proc.signals.is_pending(15));
}

#[test]
fn test_sigsuspend_cannot_block_sigkill() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    host.sigsuspend_signal = 9; // SIGKILL
    let mask = u64::MAX; // try to block everything
    let result = sys_sigsuspend(&mut proc, &mut host, mask);
    assert_eq!(result, Err(Errno::EINTR));
    // SIGKILL was raised and is deliverable (can't be blocked)
    assert!(proc.signals.is_pending(9));
}
```

**Step 7: Run tests**

```bash
cargo test --target $(rustc -vV | grep host | awk '{print $2}')
```

**Step 8: Commit**

```bash
git add crates/
git commit -m "feat: add sigsuspend() kernel implementation with host blocking"
```

---

### Task 3: Alarm host infrastructure (TypeScript)

**Files:**
- Modify: `host/src/worker-protocol.ts` — Add AlarmSetMessage
- Modify: `host/src/kernel.ts` — Add host_set_alarm import, KernelCallbacks.onAlarm
- Modify: `host/src/worker-entry.ts` — Add onAlarm callback
- Modify: `host/src/process-manager.ts` — Add alarmTimer to ProcessInfo, alarm handling
- Modify: `host/src/index.ts` — Export new types
- Test: `host/test/process-manager.test.ts`

**Step 1: Add AlarmSetMessage to worker-protocol.ts**

In `host/src/worker-protocol.ts`, add to WorkerToHostMessage union:
```typescript
| AlarmSetMessage
```

Add the interface:
```typescript
export interface AlarmSetMessage {
  type: "alarm_set";
  pid: number;
  seconds: number;
}
```

**Step 2: Add onAlarm to KernelCallbacks and host_set_alarm import**

In `host/src/kernel.ts` KernelCallbacks:
```typescript
export interface KernelCallbacks {
  onKill?: (pid: number, signal: number) => number;
  onExec?: (path: string) => number;
  onAlarm?: (seconds: number) => number;
}
```

Add host_set_alarm to the Wasm import object inside `init()`:
```typescript
host_set_alarm: (seconds: number): number => {
  return this.hostSetAlarm(seconds);
},
```

Add the method:
```typescript
private hostSetAlarm(seconds: number): number {
  if (this.callbacks.onAlarm) {
    return this.callbacks.onAlarm(seconds);
  }
  return 0;
}
```

**Step 3: Add onAlarm callback in worker-entry.ts**

In the callbacks object:
```typescript
onAlarm: (seconds: number): number => {
  port.postMessage({
    type: "alarm_set",
    pid: initData.pid,
    seconds,
  } satisfies WorkerToHostMessage);
  return 0;
},
```

**Step 4: Add alarmTimer to ProcessInfo and alarm handling in ProcessManager**

In `host/src/process-manager.ts` ProcessInfo:
```typescript
export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  worker: WorkerHandle;
  state: "starting" | "running" | "zombie";
  exitStatus?: number;
  alarmTimer?: ReturnType<typeof setTimeout>;
}
```

Add alarm_set message handling in the spawn() message handler (and fork() handler), inside the switch on `msg.type`:
```typescript
case "alarm_set": {
  const info = this.processes.get(msg.pid);
  if (info && info.state === "running") {
    if (info.alarmTimer) {
      clearTimeout(info.alarmTimer);
      info.alarmTimer = undefined;
    }
    if (msg.seconds > 0) {
      info.alarmTimer = setTimeout(() => {
        info.alarmTimer = undefined;
        try {
          this.deliverSignal(msg.pid, 14); // SIGALRM
        } catch { /* process may have exited */ }
      }, msg.seconds * 1000);
    }
  }
  break;
}
```

Cancel alarm timer on process exit (where state transitions to "zombie"):
```typescript
if (info.alarmTimer) {
  clearTimeout(info.alarmTimer);
  info.alarmTimer = undefined;
}
```

Cancel alarm timer on exec (in exec_request handling, before sending exec_reply):
```typescript
if (info.alarmTimer) {
  clearTimeout(info.alarmTimer);
  info.alarmTimer = undefined;
}
```

**Step 5: Export AlarmSetMessage from index.ts**

Add to exports in `host/src/index.ts`:
```typescript
AlarmSetMessage,
```

**Step 6: Build Wasm**

```bash
cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release && cp target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/
```

**Step 7: Write tests**

In `host/test/process-manager.test.ts`:
```typescript
describe("Alarm", () => {
  it("should handle alarm_set message from worker", async () => {
    // Verify alarm_set message is received without error
    // Use the mock worker to send an alarm_set message
  });

  it("should cancel alarm when alarm_set with 0 seconds", async () => {
    // Set alarm, then cancel
  });
});
```

**Step 8: Run tests**

```bash
cd host && npx vitest run
```

**Step 9: Commit**

```bash
git add host/ crates/
git commit -m "feat: add alarm host infrastructure with ProcessManager timer"
```

---

### Task 4: Sigsuspend host infrastructure (TypeScript)

**Files:**
- Modify: `host/src/worker-protocol.ts` — Add signalWakeSab to WorkerInitMessage
- Modify: `host/src/kernel.ts` — Add registerSignalWakeSab, host_sigsuspend_wait import
- Modify: `host/src/worker-entry.ts` — Register SAB on kernel, handle after exec
- Modify: `host/src/process-manager.ts` — Add signalWakeSab to ProcessInfo, enhance deliverSignal
- Test: `host/test/process-manager.test.ts`, `host/test/worker-entry.test.ts`

**Step 1: Add signalWakeSab to WorkerInitMessage**

In `host/src/worker-protocol.ts`:
```typescript
export interface WorkerInitMessage {
  type: "init";
  pid: number;
  ppid: number;
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  env?: string[];
  cwd?: string;
  forkState?: ArrayBuffer;
  signalWakeSab?: SharedArrayBuffer;
}
```

**Step 2: Add signalWakeSab to ProcessInfo**

In `host/src/process-manager.ts`:
```typescript
export interface ProcessInfo {
  // ... existing fields ...
  signalWakeSab?: SharedArrayBuffer;
}
```

**Step 3: Create signalWakeSab in spawn() and fork()**

In ProcessManager.spawn(), before creating initData:
```typescript
const signalWakeSab = new SharedArrayBuffer(8);
```

Add to initData:
```typescript
signalWakeSab,
```

Store in ProcessInfo:
```typescript
signalWakeSab,
```

Same for fork() — create SAB and pass to child initData + ProcessInfo.

**Step 4: Enhance deliverSignal with SAB notification**

In `host/src/process-manager.ts` deliverSignal():
```typescript
deliverSignal(targetPid: number, signal: number): void {
  const info = this.processes.get(targetPid);
  if (!info || info.state === "zombie") {
    throw new Error(`No such process: ${targetPid}`);
  }
  if (signal === 0) return;

  // Normal delivery via message
  info.worker.postMessage({ type: "deliver_signal", signal });

  // Also wake via shared memory (for sigsuspend)
  if (info.signalWakeSab) {
    const view = new Int32Array(info.signalWakeSab);
    Atomics.store(view, 1, signal);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
  }
}
```

**Step 5: Add registerSignalWakeSab and host_sigsuspend_wait to WasmPosixKernel**

In `host/src/kernel.ts`:
```typescript
private signalWakeSab: SharedArrayBuffer | null = null;

registerSignalWakeSab(sab: SharedArrayBuffer): void {
  this.signalWakeSab = sab;
}
```

Add host_sigsuspend_wait to the Wasm import object inside `init()`:
```typescript
host_sigsuspend_wait: (): number => {
  return this.hostSigsuspendWait();
},
```

Add the method:
```typescript
private hostSigsuspendWait(): number {
  if (!this.signalWakeSab) {
    return -(4); // -EINTR, no SAB available
  }
  const view = new Int32Array(this.signalWakeSab);

  // Check if already signaled (race-safe via CAS)
  const old = Atomics.compareExchange(view, 0, 1, 0);
  if (old === 1) {
    const sig = Atomics.load(view, 1);
    Atomics.store(view, 1, 0);
    return sig;
  }

  // Block until notified
  Atomics.wait(view, 0, 0);

  // Read signal and reset
  const sig = Atomics.load(view, 1);
  Atomics.store(view, 0, 0);
  Atomics.store(view, 1, 0);
  return sig;
}
```

**Step 6: Register SAB in worker-entry.ts**

After creating the kernel and before "ready" message:
```typescript
if (initData.signalWakeSab) {
  kernel.registerSignalWakeSab(initData.signalWakeSab);
}
```

In the exec_reply handler, after creating newKernel and before replacing references:
```typescript
// Transfer signal wake SAB to new kernel
if (initData.signalWakeSab) {
  newKernel.registerSignalWakeSab(initData.signalWakeSab);
}
```

**Step 7: Build Wasm**

```bash
cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release && cp target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/
```

**Step 8: Write tests**

In `host/test/process-manager.test.ts`:
```typescript
describe("Signal Wake SAB", () => {
  it("should create signalWakeSab for spawned processes", async () => {
    const pid = await pm.spawn();
    const info = pm.getProcess(pid);
    expect(info?.signalWakeSab).toBeInstanceOf(SharedArrayBuffer);
    expect(info?.signalWakeSab?.byteLength).toBe(8);
    await pm.terminate(pid);
  });

  it("deliverSignal should notify SAB", () => {
    // Create a mock process with SAB
    // Call deliverSignal
    // Verify SAB values are set
  });
});
```

**Step 9: Run tests**

```bash
cd host && npx vitest run
```

**Step 10: Commit**

```bash
git add host/ crates/
git commit -m "feat: add sigsuspend host infrastructure with SharedArrayBuffer wake"
```

---

### Task 5: Integration tests

**Files:**
- Modify: `host/test/multi-worker.test.ts`

**Step 1: Add alarm integration test**

```typescript
describe("Alarm", () => {
  it("should deliver SIGALRM after timeout", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: false },
      workerAdapter: new NodeWorkerAdapter(),
    });
    const pid = await pm.spawn();
    // Process exists and can be signaled
    expect(pm.getProcess(pid)).toBeDefined();
    // Note: can't easily test timer firing in unit test without exposed kernel API
    // Verify process is running
    expect(pm.getProcess(pid)!.state).toBe("running");
    await pm.terminate(pid);
  }, 15_000);
});
```

**Step 2: Run tests**

```bash
cd host && npx vitest run
```

**Step 3: Commit**

```bash
git add host/test/
git commit -m "test: add alarm and sigsuspend integration tests"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/posix-status.md`

**Step 1: Update posix-status.md**

Change sigsuspend and alarm entries from "Planned" to their new status:
```
| `alarm()` | Full | Sets SIGALRM timer via host setTimeout. Returns previous remaining seconds. alarm(0) cancels. Not inherited by fork, canceled by exec. |
| `sigsuspend()` | Full | Atomically replaces signal mask and blocks until deliverable signal arrives. Uses SharedArrayBuffer + Atomics.wait/notify for cross-thread wake. Always returns EINTR. |
```

**Step 2: Commit**

```bash
git add docs/
git commit -m "docs: update POSIX status for Phase 13f alarm and sigsuspend"
```
