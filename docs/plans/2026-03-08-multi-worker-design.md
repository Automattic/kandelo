# Multi-Worker Process Architecture Design

## Goal

Enable multi-process POSIX support (fork, exec, waitpid, cross-process signals, cross-process pipes) by running each process as a dedicated worker thread.

## Architecture

### Overview

The host TypeScript layer becomes the multi-process coordinator via a new `ProcessManager` class. Each process gets its own worker (Node.js `worker_threads` or Web Worker) with its own Wasm instance. The existing kernel Rust code continues managing per-process state with minimal changes.

```
┌───────────────────────────────────────────────────────┐
│                ProcessManager (Host)                   │
│  processTable: Map<PID, WorkerHandle>                  │
│  sharedPipes: Map<PipeId, SharedPipeBuffer>            │
│  waitQueues: Map<PID, Waiter[]>                        │
│  exitStatuses: Map<PID, {status, rusage}>              │
├──────────┬──────────┬──────────┬──────────────────────┤
│ Worker 1 │ Worker 2 │ Worker 3 │       ...             │
│ (PID 1)  │ (PID 2)  │ (PID 3)  │                       │
│ Wasm Inst│ Wasm Inst│ Wasm Inst│                       │
│ Kernel   │ Kernel   │ Kernel   │                       │
└──────────┴──────────┴──────────┴──────────────────────┘

Communication:
  Worker ↔ Host: postMessage (control) + SharedArrayBuffer (data/blocking)
```

### Design Decisions

**DD1: Kernel stays per-process, host coordinates.**
The Rust kernel code manages per-process state (fd table, signals, etc.) unchanged. Cross-process coordination happens in TypeScript. This avoids complex shared-memory data structures in Wasm and leverages the existing host-delegation pattern.

**DD2: SharedArrayBuffer for blocking and data transfer.**
Workers block via `Atomics.wait()` on SharedArrayBuffer. Pipe data for cross-process pipes uses SharedArrayBuffer ring buffers. Control messages (fork request, signal delivery) use `postMessage`.

**DD3: Pipe conversion on fork.**
Before fork, pipes are kernel-internal (PipeBuffer in Rust). On fork, any pipe with endpoints in different processes gets converted to a host-managed SharedPipeBuffer. The kernel sees these as host-delegated I/O (positive host handles), using existing `host_read`/`host_write` paths.

**DD4: Binary serialization for fork state.**
The kernel provides `kernel_get_fork_state()` and `kernel_init_from_fork()` exports. Fork state is serialized to a binary format in Wasm memory, read by the host, sent to the child worker via postMessage, and deserialized by the child kernel.

**DD5: Cooperative signal checking.**
Signals are delivered by setting a flag in the kernel. The kernel checks for pending deliverable signals at syscall boundaries. For blocked workers (Atomics.wait), the host can interrupt by writing to a "signal pending" word in shared memory and using Atomics.notify.

**DD6: Abstract over Node.js and Browser workers.**
A `WorkerAdapter` interface abstracts worker creation. `NodeWorkerAdapter` wraps `worker_threads`, `BrowserWorkerAdapter` wraps Web Workers. The ProcessManager uses the adapter, not concrete worker types.

## Components

### 1. ProcessManager (TypeScript, host-side)

Manages the process table and coordinates cross-process operations.

```typescript
interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  worker: Worker;
  wasm: WasmPosixKernel;
  state: 'running' | 'zombie';
  exitStatus?: number;
  // SharedArrayBuffer for blocking operations (waitpid, etc.)
  syncBuffer: SharedArrayBuffer;
}

class ProcessManager {
  private processes: Map<number, ProcessInfo>;
  private nextPid: number;
  private sharedPipes: Map<number, SharedPipeBuffer>;
  private wasmBytes: BufferSource;
  private platformIO: PlatformIO;

  async fork(parentPid: number): Promise<number>;
  async exec(pid: number, wasmBytes: BufferSource): Promise<void>;
  processExit(pid: number, status: number): void;
  deliverSignal(targetPid: number, sig: number): void;
  waitpid(parentPid: number, targetPid: number, options: number): number;
}
```

### 2. SharedPipeBuffer (TypeScript, host-side)

Ring buffer backed by SharedArrayBuffer for cross-process pipe I/O.

```typescript
class SharedPipeBuffer {
  private sab: SharedArrayBuffer;
  // Layout in SharedArrayBuffer:
  //   [0..3]   head (Uint32, atomic)
  //   [4..7]   tail (Uint32, atomic)
  //   [8..11]  len  (Uint32, atomic)
  //   [12..15] flags (Uint32, atomic: read_open, write_open)
  //   [16..N]  data ring buffer (default 64KB)

  write(data: Uint8Array): number;   // Atomic write, Atomics.notify reader
  read(buf: Uint8Array): number;     // Atomic read, Atomics.notify writer
  closeRead(): void;
  closeWrite(): void;
}
```

### 3. WorkerAdapter (TypeScript, abstraction)

```typescript
interface WorkerAdapter {
  createWorker(scriptPath: string): WorkerHandle;
  postMessage(worker: WorkerHandle, msg: any, transfer?: Transferable[]): void;
  onMessage(worker: WorkerHandle, handler: (msg: any) => void): void;
  terminate(worker: WorkerHandle): void;
}
```

### 4. Kernel Extensions (Rust)

New kernel exports:

```rust
// Serialize process state for fork. Returns bytes written.
kernel_get_fork_state(buf_ptr: *mut u8, buf_len: u32) -> i32

// Initialize kernel from serialized fork state (child side).
kernel_init_from_fork(buf_ptr: *const u8, buf_len: u32, child_pid: u32) -> i32

// Deliver a signal from external source (host).
kernel_deliver_signal(sig: u32) -> i32

// Convert a local pipe to a host-managed pipe (after fork).
// Replaces kernel PipeBuffer with host handle delegation.
kernel_convert_pipe_to_host(pipe_idx: u32, host_handle: i64) -> i32
```

New host imports:

```rust
extern "C" {
    fn host_fork() -> i64;           // Returns child PID (parent) or 0 (child)
    fn host_waitpid(pid: i32, options: u32) -> i64;  // Returns (pid << 32) | status
    fn host_exit(status: i32);       // Notify host of process exit
    fn host_kill(pid: i32, sig: u32) -> i32;  // Cross-process signal
}
```

## Flows

### Fork Flow

```
Parent Worker                    Host (ProcessManager)           Child Worker
     │                                │                              │
     │ kernel calls host_fork()       │                              │
     ├───────postMessage──────────────►│                              │
     │                                │ allocate child PID            │
     │                                │ create child worker           │
     │                                │──────────────────────────────►│
     │                                │                              │
     │ kernel_get_fork_state()        │                              │
     │◄───────postMessage─────────────┤                              │
     │ writes state to Wasm memory    │                              │
     ├───────postMessage──────────────►│                              │
     │ (state bytes)                  │                              │
     │                                │ load Wasm module              │
     │                                │ write state to child memory   │
     │                                │ kernel_init_from_fork()       │
     │                                │──────────────────────────────►│
     │                                │                              │ init done
     │                                │◄──────────────────────────────┤
     │                                │                              │
     │                                │ convert shared pipes          │
     │                                │ kernel_convert_pipe_to_host() │
     │◄──────(both workers)───────────┤──────────────────────────────►│
     │                                │                              │
     │ host_fork() returns child_pid  │                              │
     │◄───────postMessage─────────────┤                              │
     │                                │                              │
```

### Waitpid Flow

```
Parent Worker              Host                    Child Worker
     │                      │                           │
     │ host_waitpid(pid)    │                           │
     ├─────────────────────►│                           │
     │                      │ child still running?      │
     │ Atomics.wait()       │ yes → block parent        │
     │ (blocked)            │                           │
     │                      │                           │ host_exit(status)
     │                      │◄──────────────────────────┤
     │                      │ record exit status         │
     │                      │ send SIGCHLD to parent     │
     │ Atomics.notify()     │                           │
     │◄────────────────────┤│ terminate child worker    │
     │ returns status       │                           ✗
```

### Cross-Process Signal Flow

```
Source Worker               Host                    Target Worker
     │                      │                           │
     │ host_kill(pid, sig)  │                           │
     ├─────────────────────►│                           │
     │                      │ look up target worker      │
     │                      │ postMessage: signal         │
     │                      │──────────────────────────►│
     │ returns 0            │                           │ kernel_deliver_signal(sig)
     │◄────────────────────┤│                           │ sets signal pending
```

## Fork State Serialization Format

Binary format, little-endian:

```
Header:
  [0..3]   magic: 0x464F524B ("FORK")
  [4..7]   version: 1
  [8..11]  total_size: u32

Process identity:
  [12..15] ppid: u32 (set to parent's pid)
  [16..19] uid: u32
  [20..23] gid: u32
  [24..27] euid: u32
  [28..31] egid: u32
  [32..35] pgid: u32
  [36..39] sid: u32
  [40..43] umask: u32

Signal state:
  [44..51] blocked_mask: u64
  [52..55] handler_count: u32 (N)
  [56..56+N*8] handlers: [(signum: u32, handler_type: u32)] * N
    handler_type: 0=Default, 1=Ignore, 2+=handler_ptr

FD table:
  [offset] fd_count: u32 (M)
  For each fd (M entries):
    fd: i32
    ofd_index: u32
    fd_flags: u32

OFD table:
  [offset] ofd_count: u32 (K)
  For each OFD (K entries):
    file_type: u32
    status_flags: u32
    host_handle: i64
    offset: i64
    ref_count: u32

Environment:
  [offset] env_count: u32 (E)
  For each env var:
    len: u32
    data: [u8; len]

CWD:
  [offset] cwd_len: u32
  [offset+4] cwd_data: [u8; cwd_len]

Resource limits:
  [offset] 16 * [soft: u64, hard: u64] = 256 bytes

Terminal state:
  [offset] 48 bytes (c_iflag, c_oflag, c_cflag, c_lflag, c_cc[32])

Window size:
  [offset] 8 bytes (ws_row, ws_col, ws_xpixel, ws_ypixel as u16)
```

## Implementation Phases

### Phase 13a: Multi-Worker Infrastructure
- WorkerAdapter interface + Node.js implementation
- ProcessManager class (process table, worker lifecycle)
- Worker entry point script
- Init process (PID 1) creation

### Phase 13b: Fork & Waitpid
- Fork state serialization/deserialization (Rust)
- host_fork, host_waitpid, host_exit imports
- kernel_get_fork_state, kernel_init_from_fork exports
- ProcessManager.fork(), waitpid(), processExit()
- SIGCHLD delivery on child exit

### Phase 13c: Cross-Process Pipes
- SharedPipeBuffer class (SharedArrayBuffer ring buffer with atomics)
- Pipe conversion on fork (kernel_convert_pipe_to_host)
- Host pipe read/write via SharedPipeBuffer
- Blocking read/write with Atomics.wait/notify

### Phase 13d: Cross-Process Signals
- host_kill import
- kernel_deliver_signal export
- ProcessManager.deliverSignal()
- Signal interruption of blocked workers

### Phase 13e: Exec
- host_exec import
- Load new Wasm binary in worker
- Preserve fd table (close O_CLOEXEC fds)
- Reset signal handlers to default

### Phase 13f: Alarm & Sigsuspend
- alarm() with host timer
- sigsuspend() with signal-based wake
