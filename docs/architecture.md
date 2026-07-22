# Architecture

This document describes the internal architecture of Kandelo. It is written for both human developers and AI agents working on the codebase.

## Overview

Kandelo is a shared, multi-process POSIX kernel that runs as WebAssembly. A single kernel Wasm instance manages all processes. The kernel **must** run in a dedicated worker thread (Web Worker in browsers, `worker_thread` in Node.js) — never on the main thread. Each process also runs in its own worker and communicates with the kernel via a SharedArrayBuffer-based channel.

> **Architecture requirement**: All platform hosts MUST run the kernel in a dedicated worker thread. The main thread should only act as a thin proxy for setup, I/O routing, and UI. Running the kernel on the main thread degrades syscall throughput by 3-4x due to event loop overhead from libuv (Node.js) or rendering (browsers).

```
                    ┌──────────────────┐
                    │   Kernel Worker   │
                    │  (single Wasm)    │
                    │                   │
                    │  ProcessTable     │
                    │  ├─ pid 1         │
                    │  ├─ pid 2         │
                    │  └─ pid N         │
                    │                   │
                    │  Fd tables        │
                    │  Advisory locks   │
                    │  Pipe buffers     │
                    │  Signal queues    │
                    │  Socket state     │
                    │  PTY pairs        │
                    └──────┬───────────┘
                           │ Atomics.waitAsync / notify
              ┌────────────┼────────────┐
              │            │            │
     ┌────────┴──┐  ┌─────┴─────┐  ┌──┴────────┐
     │ Worker 1   │  │ Worker 2   │  │ Worker N   │
     │ pid=1      │  │ pid=2      │  │ pid=N      │
     │ User Wasm  │  │ User Wasm  │  │ User Wasm  │
     │ + musl     │  │ + musl     │  │ + musl     │
     │ + glue     │  │ + glue     │  │ + glue     │
     └────────────┘  └───────────┘  └───────────┘
```

## Three Layers

### 1. Kernel (Rust → Wasm)

**Location**: `crates/kernel/`

The kernel is written in Rust, compiled to `wasm32-unknown-unknown` with `no_std` (on wasm32). It exports C-compatible functions that the host calls to handle syscalls.

Key source files:

| File | Purpose |
|------|---------|
| `syscalls.rs` | Syscall dispatch — maps syscall numbers to handler functions |
| `fd.rs` | Per-process file descriptor table (fd → OFD index mapping) |
| `ofd.rs` | Open file descriptions (shared state for dup'd/forked fds) |
| `pipe.rs` | Kernel-space pipe ring buffers with cross-process wakeup |
| `pty.rs` | Pseudoterminal pairs with line discipline (canonical/raw mode) |
| `process.rs` | Process struct, HostIO trait, per-process state |
| `process_table.rs` | ProcessTable — maps PIDs to Process structs |
| `signal.rs` | Signal subsystem: masks, handlers, RT queuing, delivery |
| `socket.rs` | AF_INET and AF_UNIX socket implementation |
| `fork.rs` | Fork/exec state serialization and deserialization |
| `memory.rs` | Memory management (mmap regions, brk tracking) |
| `terminal.rs` | Termios state and ioctl handling |
| `lock.rs` | Machine-wide advisory file-lock manager and POSIX range semantics |
| `wasm_api.rs` | Wasm export/import boundary (`#[no_mangle] extern "C"`) |

Key kernel exports (called by the host):

```
kernel_create_process(pid) → 0
kernel_fork_process(parent_pid, child_pid) → 0
kernel_remove_process(pid) → 0
kernel_handle_channel(channel_offset, pid) → result
kernel_exec_setup(pid) → result
kernel_get_cwd(pid, buf, len) → bytes_written
kernel_set_max_addr(pid, addr) → 0
kernel_set_brk_base(pid, addr) → 0
kernel_set_mmap_base(pid, addr) → 0
kernel_is_fd_nonblock(pid, fd) → bool
```

Normal guest exit closes descriptors before the process becomes reapable.
When the host instead removes a live process after explicit termination or a
worker failure, `kernel_remove_process` drops its inherited resource references
and closes its last-owned host file, directory-iteration, and network handles.
Failed spawn setup drains the same close lists during rollback. Node.js and
browser hosts use the common removal path, so forced termination does not
retain those backend descriptors after the worker is gone.

Host imports (provided by TypeScript):

```
host_read(fd, buf, len) → bytes_read
host_write(fd, buf, len) → bytes_written
host_open(path, flags, mode) → handle
host_close(handle) → 0
host_stat(path, buf) → 0
host_fstat(handle, buf) → 0
host_getrandom(buf, len) → bytes
host_connect(addr, port) → handle
host_send(handle, buf, len) → bytes_sent
host_recv(handle, buf, len) → bytes_received
host_getaddrinfo(host, port, buf, len) → count
```

### 2. Host Runtime (TypeScript)

**Location**: `host/src/`

The host runtime loads and manages the kernel and process workers. It has two main classes:

**`CentralizedKernelWorker`** (`kernel-worker.ts`): The primary runtime. Creates the kernel Wasm instance, manages process registration, listens for syscall channel activity via `Atomics.waitAsync`, and dispatches to the kernel's `kernel_handle_channel` export. **Must be instantiated in a dedicated worker thread**, not on the main thread.

**`WasmPosixKernel`** (`kernel.ts`): Lower-level kernel wrapper that instantiates the Wasm module and provides the host import functions.

Key host components:

| Component | File | Purpose |
|-----------|------|---------|
| CentralizedKernelWorker | `kernel-worker.ts` | Manages kernel instance, process channels, blocking retry |
| SyscallChannel | `channel.ts` | Typed view into SharedArrayBuffer channel region |
| NodePlatformIO | `platform/node.ts` | Direct Node.js filesystem, networking, random (legacy host-fs path) |
| VirtualPlatformIO | `vfs/vfs.ts` | Mount-table router — used by both Node and browser hosts |
| MemoryFileSystem | `vfs/memory-fs.ts` | SharedArrayBuffer-backed in-memory filesystem |
| HostFileSystem | `vfs/host-fs.ts` | Backend that proxies to a Node host directory |
| DeviceFileSystem | `vfs/device-fs.ts` | /dev/null, /dev/zero, /dev/urandom, /dev/ptmx |
| OpfsFileSystem | `vfs/opfs.ts` | Origin Private File System (browser persistence) |
| NetworkIO backends | `networking/*.ts` | Host-side external TCP/HTTP bridges and local virtual UDP/TCP networking |
| Default mount spec | `vfs/default-mounts.ts` (+ `default-mounts-node.ts`) | Canonical mount layout + per-host resolvers |
| SharedPipeBuffer | `shared-pipe-buffer.ts` | Cross-worker pipe ring buffers via SharedArrayBuffer |
| SharedIpcTable | `shared-ipc-table.ts` | SysV IPC (msg queues, semaphores, shm) |
| NodeWorkerAdapter | `worker-adapter.ts` | Creates Node.js worker_threads |
| BrowserWorkerAdapter | `worker-adapter-browser.ts` | Creates Web Workers |

### Advisory file locks

Advisory lock state and semantics live entirely in the Rust kernel. The
machine-wide `ProcessTable` owns one `AdvisoryLockManager`; neither a process
nor the TypeScript host owns a second lock table. The manager starts empty and
retains one high-water `Vec<LockRecord>` sorted by file identity and range.
Binary search selects the contiguous records for a file before range scanning,
so lookup is `O(log n + k)` for `k` records on that file rather than a scan of
unrelated files. The vector grows geometrically, never shrinks, and is bounded
at 4096 normalized records to keep allocation bounded under the Wasm kernel's
non-reclaiming allocator.

Each host-backed regular file is identified by the exact `(st_dev, st_ino)`
returned by `host_fstat` on its live open handle. The open file description
caches that identity; remembered pathnames and pathname hashes are never lock
identity. `VirtualPlatformIO` qualifies device IDs by backend object and
backend-local device, so mounting the same backend object twice preserves
aliases while different backend objects cannot collide. Node obtains device
and inode values from bigint-native stat calls. In-kernel memfds, procfs
regular objects, and read-only synthetic regular files use explicit tagged
kernel-object identities; none derive identity from a pathname hash.

Process locks use the PID owner required by POSIX. OFD locks and `flock()` use
a kernel-global, monotonically allocated open-file-description ID: independent
opens differ, while `dup`, `fork`, and `exec` preserve the ID. `flock()` keeps
Linux-observable OFD-style lifetime in its own namespace, independent of POSIX
and OFD byte-range records. Process locks are not inherited by `fork`; they
survive `exec` under the same PID, except that closing a `FD_CLOEXEC`
descriptor applies the normal close rule. A close removes all process locks
held by that PID on the file; an OFD lock remains until the last machine-wide
reference to its open file description closes. Range
normalization, replacement, splitting, coalescing, conflict selection, and
capacity checks all happen in Rust. Conflicts are reported as `EAGAIN` before
capacity is considered; a mutation that would exceed the record limit or
cannot reserve its final capacity returns `ENOLCK` without partial state.

An `SCM_RIGHTS` queue entry retains the source description's `OfdId`, `FileId`,
and real backing reference. It therefore participates in final-reference
checks even after the sender closes its descriptor. Successful receipt
transfers that retained reference into the receiver without changing lock
ownership; a discarded message or failed receiver fd allocation releases it
and removes OFD/`flock()` records only if it was the true final reference.
Destructors enqueue fixed cleanup metadata into pre-reserved, high-water
storage, and cleanup runs after pipe-table borrows end. The host schedules the
syscall but never stores or examines lock state. Ordinary regular-file offsets
and status flags still live in per-process OFD records, so their sharing across
fork and `SCM_RIGHTS` remains the separate global-OFD gap documented in
[future-improvements.md](future-improvements.md).

ABI 40 removes the required `host_fcntl_lock` import and the public
`SharedLockTable` host-package export. This is an intentional host API break:
embedders must not register or manipulate lock storage. The unchanged guest
`fcntl`, OFD-lock, and `flock` syscall surfaces now reach the Rust manager
directly, which also lets a native Wasm host use the same implementation
without a lock-specific JavaScript binding.

### Cooperative process-runtime interrupts

A process module may import
`env.__wasm_posix_vm_interrupt_after(timed_out_ptr, vm_interrupt_ptr, seconds)`
to request a cooperative runtime deadline. This import is intended for
language runtimes that already poll an interrupt flag at VM safepoints; it is
not a substitute for POSIX signal delivery or a general program-specific
kernel hook.

The process worker forwards each arm or cancellation request to its host's
dedicated kernel worker. The kernel worker owns the JavaScript timer because a
process worker executing a CPU-bound Wasm loop cannot service its own event
loop. At the monotonic deadline the host sets each flag byte with an atomic
store in the process's shared memory. Timer entries retain the exact
process-generation object as well as the PID, so exec, exit, or PID reuse
cannot redirect a stale callback into a replacement process. Deadlines beyond
JavaScript's signed 32-bit timer range are scheduled in bounded chunks.

The imported function and its pointer-width-specific signature are part of
the guest/host ABI. A package that starts importing it must raise its kernel
ABI floor in the same ABI reconciliation that versions and snapshots the new
surface.

Host-runtime failure diagnostics are kept separate from guest file descriptor
2. Worker traps, protocol failures, and failed process or thread transitions
produce typed `host_diagnostic` messages; `NodeKernelHost` and `BrowserKernel`
expose them through `onHostDiagnostic`. An ordinary process exit, including a
nonzero exit used as POSIX control flow, is reported only through its exit
status and is not a host warning. Node records actual host diagnostics on the
embedding process's console, while the browser live-demo consumer records them
in dmesg. Neither path appends host diagnostics to the program's stderr byte
stream, so test harnesses and applications observe only bytes the guest
actually wrote.

### 3. Glue Layer (C)

**Location**: `libc/glue/`

Compiled into every user program. Three main files:

| File | Purpose |
|------|---------|
| `channel_syscall.c` | Channel-based syscall dispatcher. Writes syscall number + args to SharedArrayBuffer, notifies kernel via `Atomics.store` + `Atomics.notify`, waits for response via `Atomics.wait`. Also handles fork (`wasm-fork-instrument` save/restore), clone (thread setup), exec, and signal delivery. |
| `compiler_rt.c` | Compiler runtime: soft-float (`__floatditf`, `__fixunstfdi`, etc.) and 64-bit builtins needed by musl on wasm32. |
| `dlopen.c` | Dynamic loading glue for `dlopen`/`dlsym` via host. |

## Syscall Channel Protocol

Each process has a dedicated channel region in its SharedArrayBuffer memory. The channel is placed in a host-reserved control slab immediately before the guest-managed brk/mmap region, not at the maximum memory address. This lets a process start with a small shared `WebAssembly.Memory` while keeping the channel address stable as guest brk/mmap activity grows memory on demand.

### Channel Layout

```
Offset  Size   Field
0       4      status (Atomics.wait/notify target)
4       4      syscall_number
8       48     arguments (6 × i64)
56      8      return_value (i64)
64      4      errno_value (i32)
68      4      reserved/padding
72      65536  data_buffer (for path strings, read/write buffers, etc.)
```

Total: 65,608 bytes (header 72 bytes + data buffer 65,536 bytes).

Both wasm32 and wasm64 write six 64-bit argument slots. On wasm32, musl's
public variadic `syscall()` entry point still reads 32-bit `long` arguments,
because that is the C calling convention its callers use. The non-variadic
`__syscallN` and cancellation-point `__syscall_cp` paths widen values to 64
bits before calling the glue layer so offsets and lengths are not truncated.

### Status Values

| Value | Name | Meaning |
|-------|------|---------|
| 0 | IDLE | Channel is idle |
| 1 | SYSCALL_READY | Process has written a syscall, kernel should handle it |
| 2 | RESULT_READY | Kernel has written the result, process can read it |
| 3 | RETRY | Kernel needs the host to retry (blocking I/O not ready yet) |

### Syscall Flow

```
Process Worker                          Kernel Worker (host)
─────────────                          ────────────────────
1. Write syscall_number + args
   to channel
2. Atomics.store(status, SYSCALL_READY)
3. Atomics.notify(status)
4. Atomics.wait(status, SYSCALL_READY)
   ─── blocks ───                      5. Atomics.waitAsync detects change
                                        6. Read channel: syscall + args
                                        7. Call kernel_handle_channel(offset, pid)
                                        8. Kernel reads args from process memory
                                        9. Kernel executes syscall logic
                                       10. Kernel writes return_value + errno
                                       11. Atomics.store(status, RESULT_READY)
                                       12. Atomics.notify(status)
13. Atomics.wait returns
14. Read return_value + errno
15. Return to caller
```

### Blocking Syscalls and Retry

Some syscalls (read from empty pipe, accept on socket, poll with timeout) cannot complete immediately. The kernel returns `-EAGAIN` and the host enters a retry loop:

1. Kernel returns EAGAIN for the syscall
2. Host checks if the fd is non-blocking (`kernel_is_fd_nonblock`). If so, return EAGAIN to the process.
3. If blocking: host stores RETRY status, keeps the channel pending
4. When another process writes to the pipe / connects to the socket / etc., the host wakes the pending channel
5. Host re-calls `kernel_handle_channel` — if still EAGAIN, continue waiting; if result ready, write RESULT_READY and notify

This mechanism is critical: the process worker blocks on `Atomics.wait` while the host manages async retry via `Atomics.waitAsync`.

`F_SETLKW` uses the same parking mechanism with a narrower wake contract. A
conflict returns the internal retry result, and the host parks only that lock
request. Unlock, conversion, close, exit, and other Rust-side changes that may
unblock a waiter publish an advisory-lock event through the kernel wake stream;
the host only reschedules parked `F_SETLKW` channels and never reads lock state.
A short retry timer remains a scheduling safety net. `ENOLCK` is a completed
guest-visible failure, not a retry result. Native runtimes can consume the same
generic wake event without implementing advisory-lock storage.

## Multi-Process Model

### fork()

Fork uses the in-tree `wasm-fork-instrument` tool to snapshot the Wasm call stack (details in [fork-instrumentation.md](fork-instrumentation.md)):

1. User calls `fork()` → musl → `__syscall(SYS_clone, ...)` → glue
2. Host's `kernel_fork` override calls `wpk_fork_unwind_begin(buf)`. The tool-injected export sets state to UNWINDING, initializes the absolute frame cursor `current_pos = buf + frames_start_offset` at `*(buf+0)`, and snapshots every mutable scalar global (including `__tls_base` and `__stack_pointer`) into the buffer's `saved_globals[]` area.
3. The return-to-caller chain unwinds; each instrumented function's postamble writes its frame to the buffer and bumps `current_pos`.
4. Once `_start` returns (top-of-stack), the host sends SYS_FORK through the channel.
5. Kernel's `kernel_fork_process` copies process metadata and the fd/OFD tables,
   while inherited stateful descriptors retain references to their existing
   kernel-global backings.
6. Host copies the parent's linear memory to a new `WebAssembly.Memory` and spawns a child worker.
7. Child worker calls `wpk_fork_rewind_begin(buf)` — the tool's export restores all saved globals. The host then calls `setupChannelBase(...)` (which reads the now-correct `__tls_base`) and invokes `_start`.
8. Each instrumented function's preamble sees state=REWINDING, reloads its frame, and re-enters the call site where the parent was interrupted. Eventually reaches the `kernel_fork` call site in the leaf function, which returns 0.
9. `wpk_fork_rewind_end` resets state; fork returns 0 in child, child PID in parent.

The instrumentation handles LLVM's new-EH `try_table` output correctly, including fork from inside C++ catch handlers. See [fork-instrumentation.md](fork-instrumentation.md) for the current guarantees and documented unanticipated Wasm-level carve-outs.

A fork reached directly inside an instrumented dlopened side module uses two
ordered state machines and two save buffers: side then main during unwind, main
then side during rewind. Versioned fork-instrument capability metadata lets
marker-present artifacts prove their role. ABI 16 defines the historical
five-export fallback, while ABI 18 and later require role claims and reject
stale call-graph artifacts. The ABI 36 epoch combines that contract with
side-module replay state and concurrent pthread-fork arbitration. Dlopen replay
records both the parent's memory base and exact table base, including null gaps
left by failed loads. TLS-bearing side modules additionally record their live,
positive `__tls_base`. A child restores the pointer-width-correct mutable
global without calling `__wasm_init_tls`, because copied memory already holds
the parent's live TLS bytes and reinitialization would reset C++ unwinder state
and application `thread_local` values. C++ exceptions and longjmp use one
canonical pointer-width tag identity across the main image and all side
modules; a main-exported tag wins over the host-created fallback.

The dlopen replay list and its atomic pthread-fork lock live in a transient,
host-private control record. The same host build writes and reads that record
during one process lifetime; guest code and persisted artifacts never
interpret it. Changing that record's size is therefore not a guest ABI change,
while the public ABI snapshot/classifier remains authoritative.

Pthread workers have separate Wasm instances, tables, and exception tags, none
of which can be structured-cloned from the process worker. `dlopen()` from a
pthread therefore fails normally with `dlerror()`. If the process has loaded a
side module, `fork()` from a pthread returns `ENOTSUP`; an atomic process lock
excludes a racing main-worker dlopen across the pthread's archive check,
unwind, memory copy, and parent rewind. The supported
direct-main-to-side boundary and the remaining opaque cross-side callback
limitation are specified in
[fork-instrumentation.md](fork-instrumentation.md#fork-from-a-dlopened-side-module).

Fork and non-forking spawn still copy each process's fd and OFD metadata. The
objects whose mutable state must remain identical across those copies use
refcounted kernel-global backings: eventfd counters, timerfd timers, signalfd
masks, memfd contents and cursors, and procfs snapshots and cursors. Pipes,
sockets, PTYs, terminal devices, and listener queues likewise retain their
existing global object identity. Ordinary regular-file OFD metadata, including
the seek position and status flags, is still copied rather than shared; that
remaining POSIX gap is tracked in [posix-status.md](posix-status.md) and
[future-improvements.md](future-improvements.md).

### exec()

1. User calls `execve(path, argv, envp)` → kernel returns exec request to host
2. Host resolves `path` to a Wasm binary (via filesystem or program map)
3. The host compiles the replacement module, checks its ABI marker, and preallocates its fresh `WebAssembly.Memory` before the irreversible transition. It also validates a 4 MiB combined argv/environment representation (UTF-8 strings, NUL terminators, and caller-width pointer entries, with each string limited to one 64 KiB scratch transfer); oversized metadata returns `E2BIG` to the old image. After commit, argv and environment entries cross into the kernel one at a time, so the fixed host scratch allocation is never overrun and an empty environment explicitly clears the prior one.
4. The host validates the exec caller and deferred file actions, then publishes
   and flushes writable tracked mappings while the old image is still live.
   Tracked shared file mappings hold a lifetime-stable host handle independent
   of the guest fd, so closing the original fd does not by itself prevent
   writeback. A failed flush leaves the old mapping trackers and SysV
   attachments in place.
   `kernel_exec_setup` then closes CLOEXEC fds and directory streams and resets
   image-specific state **in place**, including the program break (POSIX/Linux
   behavior — the prior program's brk does not carry over). Exact kernel objects
   behind surviving descriptors are never fork-cloned or reconstructed: socket
   queues, eventfd/epoll/timerfd/signalfd state, memfd contents, procfs
   snapshots, terminal input, and OFD identity therefore survive without
   refcount churn. After that commit the host forgets the old mapping trackers
   and detaches SysV segments. The calling pthread's signal mask and directed
   queue become the process state; sibling workers terminate.
   `alarm()`/`ITIMER_REAL` survives, while `timer_create()` timers are deleted.
   The conformance gaps in [posix-status.md](posix-status.md) still apply,
   notably numeric-fd epoll tracking and main-thread-directed signal
   attribution.
5. Host terminates the old process and sibling-thread workers, then re-registers the PID with the preallocated memory
6. Host parses the new binary's `__heap_base` export and calls `kernel_set_brk_base(pid, __heap_base)` so `brk(0)` returns a value above the new program's data + stack region
7. Host spawns a new worker with the new program binary
8. New program starts from `_start` with the given argv/envp

Step 6 is required: without it, `MemoryManager` falls back to a hardcoded 16MB `INITIAL_BRK`, which can land *inside* the stack region of programs whose data section pushes `__heap_base` above 16MB (mariadbd's `__heap_base ≈ 16.32MB`). Heap allocations there collide with shadow-stack frames during C++ static initialization, corrupting memory and hanging in `__wasm_call_ctors`.

### posix_spawn() (non-forking)

POSIX `posix_spawn` is normally fork+exec done atomically. Our kernel
ships a custom syscall (`SYS_SPAWN = 500`, host-intercepted in
`host/src/kernel-worker.ts`) that builds the child directly — no fork,
no `wpk_fork_*` rewind, no exec replay. This is the fast path popen,
`system`, shell pipelines, nginx-FastCGI, and any direct posix_spawn
caller now take.

1. Glue (`libc/musl-overlay/src/process/wasm32posix/posix_spawn.c`) marshals
   argv + envp + file actions + spawn attrs into a contiguous blob and
   issues `__syscall6(SYS_SPAWN, path, path_len, blob, blob_len,
   &pid_out, 0)`. Wire format documented in
   `docs/plans/2026-05-04-non-forking-posix-spawn-design.md` Section 1.
2. Host (`handleSpawn` in `kernel-worker.ts`) reads the blob from
   caller memory, copies it to kernel scratch, and calls
   `kernel_spawn_process(parent_pid, blob_ptr, blob_len)`.
3. Kernel parses the blob (`crates/kernel/src/spawn.rs::parse_blob` —
   the trust boundary; bails with EINVAL on any malformed offset) and
   calls `ProcessTable::spawn_child`.
4. `spawn_child` allocates the child pid, builds the child Process
   from `Process::new(child_pid)` plus selective inheritance from the
   parent (uid/gid/pgid/sid/cwd/umask/rlimits, fd_table + ofd_table +
   sockets via the `bump_inherited_resource_refcounts` helper that
   fork also uses), applies attrs in POSIX order (SETSID → SETPGROUP →
   SETSIGMASK → SETSIGDEF), then applies file actions in forward
   order. Failure on any action rolls back via `remove_process`.
5. The kernel returns the allocated pid via `pid_out_ptr` in caller
   memory. The host's `onSpawn` callback (Node:
   `host/src/node-kernel-worker-entry.ts::handlePosixSpawn`; Browser:
   `host/src/browser-kernel-worker-entry.ts::handlePosixSpawn`)
   receives the authoritative parent pid, resolves the program bytes,
   instantiates a fresh Worker for the child, and publishes a parented
   `proc_event` spawn notification. The Worker is registered with
   `skipKernelCreate: true` because the kernel already inserted the
   Process; its initialization metadata carries the same parent pid.

PATH search lives in libc (`posix_spawnp.c`); the kernel never sees
PATH-relative names.

The implementation is regression-guarded by a per-process counter:
`kernel_get_fork_count(pid)` returns the number of times that pid has
called `kernel_fork_process`. The vitest harness asserts this stays at
0 across a `posix_spawn` — any non-zero value means the path silently
fell back to fork.

**Browser parity:**

* `BrowserKernel.getForkCount(pid)` mirrors `NodeKernelHost.getForkCount`
  — round-trips a `get_fork_count` message to the kernel-worker entry,
  which calls `kernel_get_fork_count`. Exposed via the public
  `BrowserKernel` API.
* `BrowserKernel.spawn(...)` accepts an `onStarted(pid)` option for
  capturing the spawned pid before awaiting exit (same shape as
  `NodeKernelHost.spawn`).
* End-to-end Playwright coverage lives in
  `apps/browser-demos/test/demos.spec.ts` ("simple: spawn-smoke uses
  non-forking SYS_SPAWN on browser host"). The simple browser page
  registers `/usr/bin/hello` as a lazy file pointing at `hello.wasm`
  via `BrowserKernel.registerLazyFiles`, then spawns spawn-smoke. The
  test asserts stdout contains `OK` + `Hello from`, exit code 0, and
  `data-fork-count=0` on the page (guardrail mirroring the Node
  vitest assertion).
* The structural source-text test (`host/test/spawn-host-parity.test.ts`)
  remains as a fast-CI tripwire for someone removing one of the
  parallel wires.

### clone() (threads)

1. User calls `clone(CLONE_VM | CLONE_THREAD, ...)` → kernel returns clone request
2. Host asks the kernel to reserve one dynamic pthread control slot in the same process address space
3. Host grows the process `WebAssembly.Memory` only far enough to cover that slot
4. Host spawns a new worker that shares the parent's `WebAssembly.Memory`
5. Thread worker runs `centralizedThreadWorkerMain`, calls `__wasm_thread_init` to set up TLS
6. Thread starts executing the given function pointer with the given argument

Threads share memory with the parent (CLONE_VM) but have their own channel, fork-save scratch page, and TLS/control page.

## Memory Layout

Each process has a WebAssembly linear memory (shared, up to 1GB by default). The host does not instantiate that memory at the maximum size. It creates the memory large enough for the wasm import minimum plus the main-thread control pages, then grows it after successful guest allocation syscalls or after dynamically reserving a pthread control slot.

```
Address           Region
0x00000000        Wasm data segment (globals, static data)
0x00110000        Global base (--global-base=1114112)
__heap_base       First linker-free byte exported by the program
control_base      Host-owned low control slab
                  - main page 0: fork-save/scratch
                  - main page 1: syscall channel primary page
                  - main page 2: syscall channel spill page
control_end       End of host-owned control slab
brk_base          Initial brk; brk(0) returns this address
mmap_base         First automatic mmap address; normally equals brk_base
...               Guest-managed brk/mmap address space, with dynamic
                  host-reserved pthread slots interleaved as needed
                  - slot page 0: TLS/control
                  - slot page 1: fork-save/scratch
                  - slot page 2: syscall channel primary page
                  - slot page 3: syscall channel spill page
...
MAX_PAGES         End of memory (1GB default)
```

For current binaries, `control_base` is page-aligned from the larger of the imported-memory minimum and the program's `__heap_base`. The host installs only the main control pages before `_start` can run, then calls `kernel_set_brk_base(pid, control_end)` and `kernel_set_mmap_base(pid, control_end)`. `__heap_base` is therefore treated as "first byte available to the host layout" rather than the value returned by guest `brk(0)`.

The Rust ABI declaration in `crates/shared/src/lib.rs` is the source of truth for this layout and is mirrored into `abi/snapshot.json` plus generated TypeScript constants. The main control area uses three Wasm pages: fork-save/scratch, syscall channel primary, and syscall channel spill. Each pthread slot is four Wasm pages addressed from the slot start: TLS/control, per-thread fork-save/scratch, syscall channel primary, and syscall channel spill. Pthread workers share the process `WebAssembly.Memory`; the host gives each worker a distinct dynamically reserved slot and returns the slot to that process's allocator after thread exit.

Processes may export `__wasm_posix_thread_slots` to declare their maximum concurrent pthread count. A value of `-1` uses the host default, `0` allows no pthreads, and a positive value sets the exact per-process limit. The kernel worker creation options expose `defaultThreadSlots` for the `-1`/missing-export case. The built-in default is 1024: an intentionally arbitrary high limit meant to avoid pthread availability problems for most programs now that slots are reserved on demand. Hosts can lower or raise it with `defaultThreadSlots` when they need a different resource policy. This limit is a resource-control guard, not a static memory reservation.

`mmap` remains coherent because the kernel has one per-process address-space model for brk, mmap, and host-reserved dynamic control ranges. Automatic `mmap` starts at the process's `mmap_base`, not at the legacy fixed 64MB floor. A usable non-fixed address hint is preferred after rounding it down to the 64KB Wasm page boundary; an occupied or invalid hint falls back to the ordinary first-fit search. `brk` growth succeeds only when the adjacent range is free; if an mmap region or host-reserved pthread slot occupies the next pages, `brk` fails by returning the old break. `MAP_FIXED`, `munmap`, and `mremap` growth are rejected when they would overlap the reserved prefix, legacy host-control range, or a host-reserved pthread slot. `munmap` rounds its length up to a Wasm page before updating both kernel mappings and host-owned bindings. The host grows the process `WebAssembly.Memory` after successful brk/mmap/mremap syscalls and after dynamic pthread-slot reservations so returned guest addresses are backed before user code touches them.

### Shared mapping coherence

Different processes have different WebAssembly memories, so a pointer store in
one process cannot immediately mutate another process's linear memory. Kandelo
coordinates anonymous `MAP_SHARED`, SysV SHM attachments, and regular-file
`MAP_SHARED` mappings at guest-to-kernel syscall boundaries. For each mapping,
the host compares process memory with the snapshot that process last observed,
merges only changed byte runs into one authoritative backing, and then imports
peer updates into every stale alias in the calling process. Fork force-publishes
the parent before the child inherits the same backing; `exec`, exit, crash,
`munmap`, `mremap`, and `MAP_FIXED` update backing ownership explicitly.

Regular-file mappings add a backend-qualified stable identity and retain the
original fd's host handle for the mapping lifetime. Identity is derived and
revalidated through that live handle, never by reopening its remembered path.
Node uses native device/inode identity; VFS backends scope device/inode identity
to the handle's backend object, so hard links and the same backend mounted at
more than one path alias correctly without colliding with a different backend.
OPFS assigns session-scoped inode tokens in its worker and uses
`FileSystemHandle.isSameEntry()` to unify simultaneous opens. The token remains
attached to a live file object across rename and unlink, while unlink followed
by recreation receives a different token. OPFS stat transport carries device
and inode as integer `u64` values rather than JavaScript `number`/float64.
Dirty mapped data is published before
direct file reads or writes and before a private mapping takes its snapshot;
successful direct writes, truncation, allocation, splice, and copy operations
invalidate or refresh mapped cache pages. `msync`, replacement, unmap, exec,
and process teardown persist dirty pages through the stable handle, including
after the original guest fd is closed or its pathname is unlinked or renamed.

This is syscall-boundary coherence, not shared physical memory. A process that
only performs direct loads/stores does not publish or import peer changes until
it crosses into the kernel. Futex waits and wakes also target the caller's own
process `SharedArrayBuffer`, so process-shared pthread mutexes/futexes remain
unsupported across PIDs. Shared mappings of in-kernel memfds return `ENOTSUP`,
as do file mappings on any backend that cannot provide stable identity;
`MAP_PRIVATE` is unaffected. File bytes past
the current EOF are zero-filled or discarded on refresh/writeback rather than
raising Linux's `SIGBUS`, and writes made outside Kandelo's file syscall paths
are not detected. The boundary scans are on the syscall hot path; no performance
claim is made without before/after Node and browser benchmarks.

Every spawn or exec computes a fresh layout from the target binary's memory import and `__heap_base`; the layout is per-process and is discarded when the process is unregistered. Fork children copy the parent's current memory length, not the configured maximum, and pthread workers share the owning process memory plus that process's thread allocator. WebAssembly memory cannot shrink, so a fork child may inherit the parent's current byte length, but it does not inherit dead parent pthread slot reservations. Correctness must not depend on page reloads, context resets, periodic kernel resets, or browser garbage collection reclaiming old shared memories.

### Pthread slots and fork

POSIX `fork()` from a multithreaded process creates a child with exactly one live thread: the caller. The child copies the parent's memory bytes, but the host must not restart or retain every parent pthread worker.

The dynamic slot rules follow that POSIX shape:

- fork from the main thread copies memory and kernel process state but inherits no dynamic pthread slot reservations;
- fork from a pthread records `forkBufAddr`, `fnPtr`, `argPtr`, and the caller's exact slot range in `ForkFromThreadContext`;
- after `kernel_fork_process` creates the child kernel process, the host calls `kernel_reserve_host_region_at(childPid, slotStart, slotLen)` to retain only the caller's copied pthread slot;
- the child worker uses the copied pthread fork-save buffer and enters the saved pthread function before `wpk_fork_rewind_begin` replays to the fork call site;
- all other parent pthread slots become ordinary copied memory bytes in the child and may be reused later by child `brk`, `mmap`, or new pthread slots.

Retaining the caller slot instead of migrating its TLS into the main control prefix keeps fork replay simple: `wpk_fork_rewind_begin` restores the saved `__tls_base`, `__stack_pointer`, and other mutable globals exactly as the calling thread wrote them. The cost is one retained 256 KiB address-space reservation for fork-from-pthread children.

### Heap initialization (brk)

The kernel's `MemoryManager` tracks `program_break` per process. On every `spawn` and `exec`, the host parses `__heap_base` from the new program's exports (`extractHeapBase` in `host/src/constants.ts`), computes the low control slab, and calls `kernel_set_brk_base(pid, control_end)` *before* the new worker can issue its first syscall. The new program's first `brk(0)` returns the first guest-managed byte after host control memory, so musl's malloc places the heap above the data, shadow-stack, and host control regions.

The kernel's hardcoded `INITIAL_BRK` (16MB) is a fallback for binaries that don't export `__heap_base`. Programs built with our SDK always export it, so the fallback is rarely used in normal operation. `fork` correctly inherits the parent's brk, mmap base, max address, reserved prefix, and mappings via the kernel's process-state serialization; `exec` resets them (POSIX-correct) and the host installs the new program's computed layout.

## Filesystem

### Mount table model

`VirtualPlatformIO` (`host/src/vfs/vfs.ts`) is the kernel's filesystem router on both hosts. It is configured with a list of `MountConfig { mountPoint, backend, readonly? }` entries and dispatches every path-based syscall to the backend whose mount prefix is the longest match. Cross-mount operations (`rename`, `link`) are rejected with `EXDEV`. A path that matches no mount returns `ENOENT`. `MountConfig.readonly` is currently advisory — write enforcement and full POSIX permission checks are deferred to a follow-up PR.

`FileSystemBackend` (`host/src/vfs/types.ts`) is the per-mount interface (open/read/write/stat/readdir/symlink/...). Two backends are in use today:

- **`MemoryFileSystem`** (`vfs/memory-fs.ts`) — SAB-backed in-memory FS. Used for the rootfs image mount and for browser scratch mounts. Honours uid/gid/mode stored on each inode.
- **`HostFileSystem`** (`vfs/host-fs.ts`) — proxies a Node host directory. Used for Node scratch mounts. Normalises stat uid/gid to `0/0` so the user's macOS/Linux uid does not leak into the kernel. Native creation receives the requested file/directory mode, but later guest `chmod`/`chown` updates are held in VFS metadata only; the Node host never applies native ownership changes.
- **`OpfsFileSystem`** (`vfs/opfs.ts`) — browser-persistent Origin Private File
  System storage. Its dedicated worker assigns exact session-scoped regular-file
  inode tokens and preserves open-file identity through supported moves and
  unlink. Browsers without `FileSystemHandle.isSameEntry()` cannot prove this
  identity and report the unsupported boundary instead of substituting a path.

### Default mount layout

The canonical layout lives in `host/src/vfs/default-mounts.ts` as `DEFAULT_MOUNT_SPEC: MountSpec[]`. `resolveForBrowser` and `resolveForNode` (the latter in `default-mounts-node.ts` so `node:fs`/`node:path` stay out of browser bundles) materialise the spec into `MountConfig[]`:

| Mount point | Source | Browser backend | Node backend |
|-------------|--------|-----------------|--------------|
| `/`         | image (advisory readonly) | `MemoryFileSystem.fromImage(rootfs.vfs)` | `MemoryFileSystem.fromImage(rootfs.vfs)` |
| `/tmp`      | scratch (ephemeral) | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/var/tmp`  | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/var/log`  | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/var/run`  | scratch (ephemeral) | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/home/user`| scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/root`     | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |
| `/srv`      | scratch | empty `MemoryFileSystem` SAB | `HostFileSystem` under sessionDir |

The browser host layers two additional, host-specific mounts on top: `/dev/shm` (the POSIX-semaphore SAB shared with main-thread surfaces) and `/dev` (`DeviceFileSystem` for `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/ptmx`, `/dev/pts/N`). Sticky bits, the uid 1000 owner on `/home/user`, mode `0700` on `/root`, etc. are baked into the rootfs image at build time per the canonical `MANIFEST` and reflected honestly through the `MemoryFileSystem` inode metadata. Scratch mounts on Node start owned by uid/gid 0 because `HostFileSystem` synthesises them.

### rootfs image as the source of truth

`/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/nsswitch.conf`,
`/etc/resolv.conf`, and static OpenSSL policy/trust files under `/etc/ssl` are
real files inside `host/wasm/rootfs.vfs`, served through the `/` mount. Any
program that calls `getpwnam`, `gethostbyname`, `getservbyname`, or OpenSSL's
default configuration/trust lookup reads the same image bytes that `cat` would.
The kernel synthesizes `/etc/mtab` because it reports live mount state; it does
not synthesize static `/etc` policy or trust data.

VFS images can also carry image-level metadata outside the guest file tree. The first declaration is `kernelAbi`, an exact `ABI_VERSION` requirement for images that carry ABI-bound Wasm programs. `MemoryFileSystem.readImageMetadata(image)` reads this declaration without materialising the filesystem, and `MemoryFileSystem.assertImageKernelAbi(image, abi)` validates it for callers that already know the running kernel ABI. Legacy/data-only images may omit the field.

### Node host

`NodeKernelHost` accepts `rootfsImage: "default" | ArrayBuffer | Uint8Array | undefined`. With `"default"` (the path used by the vitest suite), the worker reads `host/wasm/rootfs.vfs`, applies `DEFAULT_MOUNT_SPEC` via `resolveForNode`, and constructs a `VirtualPlatformIO` for the kernel. The image supplies both `/etc/ssl/cert.pem` and `/etc/ssl/certs/ca-certificates.crt`; Node does not silently add them to caller-supplied images. Without a rootfs image, the worker falls back to raw `NodePlatformIO` (every host path reachable) — kept for legacy callers that haven't migrated.

### Browser host

`BrowserKernel.boot({ vfsImage, ... })` is the kernel-owned VFS path. The worker restores the supplied image (per-demo `.vfs.zst`, typically built on top of the canonical rootfs as a base layer) into a `MemoryFileSystem`, applies `DEFAULT_MOUNT_SPEC` via `resolveForBrowser` (the image becomes the `/` mount; the seven scratch mounts come up empty), and layers `/dev/shm` + `/dev` on top. Browser networking then replaces `/etc/ssl/certs/ca-certificates.crt` with its generated per-session MITM root; the image-owned OpenSSL configuration and compiled-in `/etc/ssl/cert.pem` trust path remain unchanged.

The browser test runner and Git test assemble small kernel-owned VFS images with
`createBuildFsWithEtc` in `apps/browser-demos/lib/kernel-owned-boot.ts`, then
serialize them with `finalizeKernelOwnedImage` and boot them through
`BrowserKernel.boot`. Before serialization, the shared host helper
`overlayEtcFromRootfs` in `host/src/vfs/rootfs-overlay.ts` recursively merges
`/etc/**` from the canonical `rootfs.vfs`. Existing leaves and directory
metadata remain caller-owned, while missing canonical descendants such as
`/etc/ssl/openssl.cnf` retain their source modes and ownership. Missing
canonical `/etc` state, short reads, and target capacity failures abort image
assembly instead of producing an incomplete filesystem.

### Lazy Files

`MemoryFileSystem` supports **lazy files** — files registered with a URL and declared size that are only fetched on first access. This enables loading large binaries (e.g., nginx, PHP-FPM, coreutils) without fetching everything upfront — they are only fetched when a process exec's them.

```typescript
// Register a lazy file (creates empty stub, fetches on demand)
const ino = mfs.registerLazyFile("/usr/bin/php", "https://cdn.example.com/php.wasm", 8_500_000);

// Later, materialize before sync access (avoids sync XHR deadlock with service workers)
await mfs.ensureMaterialized("/usr/bin/php");
```

Lazy file metadata (`path`, hard-link aliases, `url`, `size`, `ino`, inode
generation, and data-mutation sequence) can be transferred between instances
via `exportLazyEntries()` / `importLazyEntries()` — used when workers share the
same SharedArrayBuffer. The generation prevents an unlinked lazy inode from
transferring its URL or declared size to a later file that reuses the same
guest-visible inode number. The data sequence prevents an asynchronous fetch
from overwriting guest data written through another worker while the request
was in flight. Live cross-worker imports require both identity fields; only a
legacy image whose filesystem bytes and lazy JSON form one trusted artifact can
adopt older metadata, and only for an untouched empty stub. Filesystem rebasing
preserves hard-link identity for lazy and
concrete files rather than copying aliases into independent inodes. A rebase
walks one quiescent source snapshot, so a peer rename cannot mix lazy paths
from one namespace state with bytes from another.

`registerLazyTree` is the format-neutral grouped form used by schema-3 package
layers. Its serialized metadata adds a closed decoder/media type, immutable
digest and byte count, transport locations, activation policy, complete source
and guest inventory, and regular-inode groups. Existing
`registerLazyArchiveFromEntries` ZIP consumers remain supported. Registration
and `stat` expose declared logical sizes without fetching content. The first
ordinary open/read or executable resolution starts one asynchronous preparation
for the group; guest syscall retries keep its internal `EAGAIN` sentinel out of
the POSIX result. Every member is decoded and checked before an
identity-guarded batch replacement, so failure leaves all pending regular
inodes unchanged. Hard-link aliases use one SharedFS inode and retain that
identity when the lazy metadata is transferred or saved in an image.

The generic-tree schema is revalidated through one closed, bounded path at
live registration, cross-worker import, image restore, and filesystem rebase.
Content, activation, mount prefix, inventory, and pending inode metadata reject
unknown fields, unsafe or oversized strings, count/size disagreement, and
missing, cyclic, or cross-inode hard-link targets before a group is installed.
Hard-link chains are resolved once with cycle state and path compression, so
validation is linear in the inventory size. VFS lazy-file and lazy-archive JSON
sections are each capped at 16 MiB and checked for truncation before JSON
decoding; deferred-tree imports additionally allow at most 512 groups and
100,000 entries per group. A pending metadata-only tree remains valid and must
still verify its immutable payload through its activation policy.

### VFS Images

A `MemoryFileSystem` can be serialized to a portable binary image and restored later to boot a new kernel with a pre-populated filesystem. This enables snapshotting an initialized VFS (with all files, directories, symlinks, and permissions) and restoring it without repeating the setup work.

**Save an image:**

```typescript
// Preserve lazy files as URL references (smaller image, requires URLs at restore time)
const image: Uint8Array = await mfs.saveImage();

// Or materialize all lazy files first (self-contained image, no URL dependencies)
const fullImage: Uint8Array = await mfs.saveImage({ materializeAll: true });
```

Image creation is a quiescent filesystem operation. `saveImage()` rejects a
filesystem with live file or directory descriptors rather than serializing FD
tables, inode open-reference counts, or lock words as durable state. The
resulting bytes contain only filesystem state. Restore also clears those
runtime-only fields in legacy images, so a new machine never inherits handles
or locks from the image builder. Lazy-file and lazy-archive paths are collected
under the same namespace transaction as the filesystem bytes, including names
changed by another worker. `materializeAll: true` resolves both standalone and
archive-backed entries and fails instead of emitting an image that still
depends on a deferred URL.

**Restore from an image:**

```typescript
// Creates a new independent MemoryFileSystem with its own SharedArrayBuffer
const restored = MemoryFileSystem.fromImage(image);
```

The restored filesystem is fully independent — modifications to the original or restored instance don't affect each other. Multiple independent instances can be created from the same image.

When restoring for use in a browser, pass `maxByteLength` to create a growable `SharedArrayBuffer` so the filesystem can expand beyond the image's original size:

```typescript
const restored = MemoryFileSystem.fromImage(image, { maxByteLength: 1024 * 1024 * 1024 });
```

The image must also have been built with a large enough filesystem maximum, for example `MemoryFileSystem.create(sab, 1024 * 1024 * 1024)`. `fromImage(..., { maxByteLength })` only controls the restored buffer's runtime growth ceiling; `statfs`/`df` and allocation remain capped by the image superblock maximum.
Call `MemoryFileSystem.readImageCapacity(image)` when build tooling needs the
serialized buffer length and superblock ceiling without restoring the image.
Call `fromImagePreservingCapacity(image)` to restore a growable buffer with the
same ceiling the image builder recorded.

A consumer that must stage files larger than the image's recorded allocation
ceiling first calls `rebaseToNewFileSystem(requiredMaxBytes)`. Shared image
helpers never treat a partial file as complete: `writeVfsBinary` advances over
positive short writes and throws on zero/negative progress or an underlying
filesystem error, while still closing the descriptor.

Kandelo browser UI presets use this approach. Each image builder pre-populates a VFS with runtime files, directory structure, configs, and symlinks, then saves it as a `.vfs.zst` file (zstd-compressed; `saveImage()` compresses on write). At runtime, the UI fetches the file and `MemoryFileSystem.fromImage` decompresses transparently - restoring the image replaces thousands of individual file writes with a single buffer copy. The empty regions of the SharedFS allocator compress to almost nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1-3 MB download.

There are two consumption patterns for VFS images, depending on whether the demo wants the kernel worker to fully own the filesystem:

**Kernel-owned VFS (`kernelOwnedFs: true` + `kernel.boot()`).** The main thread never instantiates the `MemoryFileSystem`. Instead, the demo fetches the `.vfs.zst` bytes and hands them to `BrowserKernel.boot({ kernelWasm, vfsImage, argv, env })`. The kernel worker restores the filesystem internally (auto-detecting zstd magic), exec()s `argv[0]` as the first ("init") process, and the main thread becomes a thin client — only routing stdin/stdout, network backend messages, framebuffer events, and HTTP-bridge messages. Service-supervised demos run dinit (`/sbin/dinit --container`) as that init process; dinit reads `/etc/dinit.d/*` from the image and brings up the service tree. Single-program demos (python, perl, php, ruby) exec the language interpreter directly. This is the path new demos should use.

**Legacy main-thread-owned VFS (`memfs:` constructor option + `kernel.spawn()`).** The main thread restores the image into its own `MemoryFileSystem`, hands the SAB to a fresh `BrowserKernel`, and then calls `kernel.spawn(programBytes, argv)` to launch transient binaries. Useful for demos that fetch additional binaries at runtime (test runners, REPLs that load arbitrary code), but the main thread is in the syscall hot path for FS operations. Still used by `benchmark`, `erlang`, and `shell`.

| Demo | VFS Image | Build Script | Boot pattern |
|------|-----------|-------------|--------------|
| Python (legacy opt-in) | `python-vfs.vfs.zst` | `packages/registry/python-vfs/build-python-vfs.sh` | `kernel.boot` → `python3` |
| Perl | `perl.vfs.zst` | `build-perl-vfs-image.sh` | `kernel.boot` → `perl` |
| PHP | `php.vfs.zst` | `build-php-vfs-image.sh` | `kernel.boot` → `php` |
| Ruby | `ruby.vfs.zst` | `build-ruby-vfs-image.sh` | `kernel.boot` → `ruby` |
| nginx | `nginx.vfs.zst` | `build-nginx-vfs-image.sh` | `kernel.boot` → dinit → nginx |
| nginx-php | `nginx-php.vfs.zst` | `build-nginx-php-vfs-image.sh` | `kernel.boot` → dinit → php-fpm + nginx |
| Redis | `redis.vfs.zst` | `build-redis-vfs-image.sh` | `kernel.boot` → dinit → redis-server |
| MariaDB | `mariadb.vfs.zst` | `build-mariadb-vfs-image.sh` | `kernel.boot` → dinit → mariadb-bootstrap → mariadbd |
| WordPress | `wordpress.vfs.zst` | `build-wp-vfs-image.sh` | `kernel.boot` → dinit → php-fpm + nginx (SQLite WP) |
| LAMP | `lamp.vfs.zst` | `build-lamp-vfs-image.sh` | `kernel.boot` → dinit → mariadb + php-fpm + nginx |
| MariaDB test | `mariadb-test.vfs.zst` | `build-mariadb-test-vfs-image.sh` | `kernel.boot` → dinit → mariadb; mysqltest via `kernel.spawn` |
| Erlang (legacy opt-in) | `erlang-vfs.vfs.zst` | `packages/registry/erlang-vfs/build-erlang-vfs.sh` | legacy `kernel.spawn` → BEAM |
| Shell | `shell.vfs.zst` | resolver-owned `packages/registry/shell/build-shell.sh` from the reviewed public Homebrew bottle closure | `kernel.spawnFromVfs` → image-owned Homebrew Bash |
| Benchmark | (multiple) | (per-suite) | legacy `kernel.spawn` |

Build scripts are in `images/vfs/scripts/` and share common helpers (`vfs-image-helpers.ts` for VFS write primitives, `dinit-image-helpers.ts` for the dinit binary + standard rootfs files + service-file rendering). To build all VFS images, use the per-demo scripts above or the convenience targets in `run.sh` (e.g., `./run.sh build python-vfs`). The repaired Python and Erlang recipes remain disabled legacy compatibility paths: staging does not publish them, and they are not Homebrew distribution units.

**Binary format:**

`MemoryFileSystem.saveImage()` returns the raw VFS image below. The image
builder helper wraps it in one zstd frame for `.vfs.zst` artifacts;
`MemoryFileSystem.fromImage()` accepts either form and auto-detects the zstd
magic (`28 B5 2F FD`) at offset 0 before parsing.

Runtime snapshots preserve the filesystem's POSIX atime, mtime, and ctime by
default. Reproducible image builders may request a fixed timestamp in the
detached snapshot copy without mutating the live filesystem. `mkrootfs build`
uses this facility for every allocated inode, taking whole Unix seconds from
`SOURCE_DATE_EPOCH` and defaulting to epoch zero when it is unset.

Decompressed layout:

```
Offset   Size   Field
0        4      Magic: 0x56465349 ("VFSI")
4        4      Version: 1
8        4      Flags: bit 0 = lazy files, bit 1 = lazy archives, bit 2 = metadata
12       4      SharedArrayBuffer data length (N)
16       N      Raw SharedArrayBuffer bytes (block filesystem)
16+N     4      Lazy entries JSON length (M)
20+N     M      Lazy-file JSON (identity, aliases, URL, declared size)
...      4+L    Optional lazy-archive/deferred-tree JSON length and bytes (when bit 1 is set)
...      4+P    Optional image-metadata JSON length and bytes (when bit 2 is set)
```

## Networking

User-visible networking is POSIX-first. Guest programs call normal AF_UNIX, AF_INET, and partial AF_INET6 socket syscalls (`socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `sendto`, `recvfrom`, `poll`, and `select`). The Rust kernel owns the socket file descriptors, datagram queues, stream listener state, loopback routing, and errno behavior. Host transports plug in below that layer through `NetworkIO`; they are backends, not the userspace-visible abstraction.

AF_INET and AF_INET6 receive queues are currently bounded at 128 datagrams per
socket. Once that fixed internal queue is full, a newly arriving UDP datagram
is dropped and the already-queued datagrams retain their order. `SO_RCVBUF`
requests are stored but do not size this queue; `getsockopt` continues to report
the fixed default capacity. AF_UNIX datagrams use the same bounded storage but
are reliable: a full receive queue makes the send enter the host's blocking
retry path, or returns `EAGAIN` immediately for an `O_NONBLOCK` or
`MSG_DONTWAIT` send, without discarding queued messages. Queue-capacity,
association, shutdown, close, and pathname changes wake blocked writers and
writable readiness waiters so they can observe either capacity or the new
immediate error.

IPv4 limited broadcast (`255.255.255.255`) is permission-gated: a datagram
send without `SO_BROADCAST` fails with `EACCES`. Kandelo does not provide raw
broadcast delivery, so enabling the option only passes that gate; the send then
reaches the active routing/backend boundary. Directed broadcast addresses are
not modeled.

For AF_INET, AF_INET6, and AF_UNIX datagrams, Linux's input `MSG_TRUNC`
extension reports the original datagram length while copying no more than the
supplied buffer. Without `MSG_PEEK`, the datagram is consumed and any uncopied
suffix is discarded; with `MSG_PEEK`, it remains queued. This receive-side
truncation does not weaken AF_UNIX send reliability or its full-queue
backpressure contract above. The current `recvmsg()` wrapper does not populate
output `msg_flags`, so it cannot report output `MSG_TRUNC` there.

Loopback addresses are scoped to one Kandelo machine, but not every socket path is machine-wide yet. IPv4 and IPv6 loopback TCP and AF_UNIX streams have explicit cross-process paths. Current in-kernel IPv4/IPv6 loopback datagrams, AF_UNIX datagrams, and IPv4 multicast delivery are confined to the sending process. Forked sockets retain their kernel-local bind reservations and local lookup targets, but host-backed UDP endpoint registrations are not yet shared or transferred between processes. AF_INET6 represents `sockaddr_in6`, supports `::`/`::1`, and models dual-stack wildcard stream-port reservation, but it has no external or virtual-network IPv6 transport and no IPv6 multicast delivery. AF_INET6 datagrams therefore report `IPV6_V6ONLY=1`; disabling it fails until dual-stack datagram routing exists.

Routed virtual IPv4 addresses are explicit backend addresses. For example, the browser network lab attaches separate machines to addresses such as `10.88.0.2`, `10.88.0.3`, and `10.88.0.4`; traffic to `127.0.0.1` stays inside one machine, while traffic to those virtual addresses can cross machines through the backend.

### Local Virtual Network

`LocalVirtualNetwork` (`host/src/networking/virtual-network.ts`) is an in-memory `NetworkIO` backend for multiple Kandelo machines in the same JS session. Each machine receives a `VirtualNetworkBackend` with a stable virtual IPv4 address and optional hostnames. The backend delivers UDP datagrams as bounded message queues and creates paired TCP streams for accepted connections. When a machine detaches, its listeners and endpoints are removed. Direct virtual endpoints observe an explicit connection reset; an accepted pipe-bridged endpoint currently maps that reset to EOF/EPIPE because the pipe ABI has no pending-socket-error channel.

Normal TCP close is distinct from that abort path. Bytes queued by the closing endpoint drain before its FIN, and the peer drains those bytes before `recv` reports EOF. The in-kernel loopback and local virtual transports retain an orphaned receive sink that discards later peer sends until the peer closes its own write half; they do not invent a fixed number of successful writes after FIN. The Node backend uses `net.Socket` half-open state and `destroySoon()` so the operating system determines later reset timing after queued bytes and FIN. Explicit receive shutdown remains a refusal path. Enabled `SO_LINGER` is rejected until reset and timed-close modes can be carried coherently through every transport.

This backend is used by `apps/browser-demos/pages/network/`, which boots multiple local machines and verifies UDP datagram delivery with `nc -u`, TCP stream delivery with `nc`, and HTTP over virtual TCP with `curl`.

### Node.js

`TcpNetworkBackend` uses Node.js `net.Socket` for external raw TCP. DNS uses `dns.lookup`. Node can therefore provide real socket-level TCP behavior for destinations outside the Kandelo process.

### Browser

Browsers cannot create external raw TCP or UDP sockets. Local loopback and `LocalVirtualNetwork` sockets work because they are virtual sockets behind the POSIX layer. External browser networking currently uses HTTP-oriented backends:

1. **FetchNetworkBackend**: Buffers an entire HTTP request from the Wasm process, sends it via `fetch()`, and returns the raw HTTP response bytes. Works for simple HTTP clients.

2. **TlsNetworkBackend**: Terminates the guest's TLS connection with a generated, in-VFS CA and sends the decoded HTTP request through browser `fetch()`. Service-worker-controlled apps may proxy cross-origin fetches transparently. Other embedders set `BrowserKernelOptions.corsProxyUrl`; the option crosses the main-thread/worker protocol and routes backend fetches through the application's CORS proxy.

3. **Service Worker HTTP Bridge**: For server demos (nginx, WordPress), a service worker intercepts browser `fetch()` requests to a configurable URL prefix (e.g., `/app/`) and forwards them to the kernel via a MessagePort connection pump. The kernel injects the request as a TCP connection to nginx's listening socket, and nginx's response flows back through the pipe to the service worker.

`TcpNetworkBackend`, `FetchNetworkBackend`, `TlsNetworkBackend`, and `LocalVirtualNetwork` share one numeric-address and hostname validator. It accepts decimal one-, two-, three-, and four-component IPv4 forms within their component widths, rejects malformed or overflowing numeric forms, enforces ASCII host-label syntax and DNS length limits, and preserves one trailing root dot. The Node TCP backend resolves validated names through the host resolver. The browser HTTP fetch/TLS bridges synthesize IPv4 mappings for syntactically acceptable DNS names; `LocalVirtualNetwork` resolves only aliases registered by attached machines. None of the browser paths adds browser DNS resolution or AF_INET6 transport.

WebRTC or proxy-based external transports should attach as additional `NetworkIO` backends behind the same POSIX socket layer rather than adding host-specific socket APIs visible to guest programs.

## Framebuffer (`/dev/fb0`)

The kernel exposes a Linux fbdev surface so unmodified fbdev software (fbDOOM, mplayer-fbdev, etc.) runs without source-level changes.

```
   user process                       kernel                            host
   ─────────────────                  ───────────────                   ────────────
   open("/dev/fb0")     ─────────►   match_virtual_device              (no host call)
                                     CAS FB0_OWNER (single-open)
   ioctl(FBIOGET_*)     ─────────►   fill fb_var_screeninfo /          (no host call)
                                     fb_fix_screeninfo, 640×400 BGRA32
   mmap(fd, len)        ─────────►   memory.mmap_anonymous(len)
                                     record FbBinding(addr,len,w,h)
                                     host.bind_framebuffer(...)  ───►  registry.bind(pid,...)
   *(uint32_t*)px = ... (writes pixels into process Memory SAB —
                         host sees them through the same SAB)
   ioctl(FBIOPAN_DISPLAY) ───────►   no-op success                     (no-op)
```

The pixel buffer lives **inside the process's wasm `Memory`** — a `SharedArrayBuffer`. The host (browser canvas, Node test, etc.) is told `(pid, addr, len, w, h, stride, fmt)` via the `bind_framebuffer` HostIO callback; it builds a typed-array view directly over that range. There is no separate framebuffer SAB, no per-frame syscall, no copy. The host drives presentation via `requestAnimationFrame`.

Cleanup paths (`munmap`, last `close` once unmapped, process exit, `exec`) clear the binding and call `unbind_framebuffer(pid)`. `fork` does not auto-bind the child (one mapping per process; documented limitation).

ABI version bumped 5 → 6 to capture the new `repr(C)` structs `FbBitfield`, `FbVarScreenInfo`, `FbFixScreenInfo`. See `crates/shared/src/lib.rs::fbdev` and `abi/snapshot.json`.

## Mouse input (`/dev/input/mice`)

The kernel exposes a Linux `mousedev` PS/2 surface so unmodified fbdev software (fbDOOM, etc.) gets mouse input from the browser canvas. Direction is reversed vs. fbdev: events flow **host → kernel → process**.

```
   browser main thread                kernel-worker / kernel              user process
   ─────────────────────              ──────────────────────             ─────────────────
   canvas mousemove   ────►  postMessage("mouse_inject")
                             kernel_inject_mouse_event(dx,dy,btn)
                                                   ─────►  mouse::inject_event
                                                           encode 3-byte PS/2 frame
                                                           push to global VecDeque (4096 cap)
                                                                                   ◄────  open("/dev/input/mice", O_RDONLY|O_NONBLOCK)
                                                                                          single-owner via MICE_OWNER (second open from another pid → EBUSY)
                                                                                   ◄────  read(fd, pkt, 3)
                                                           drain bytes from queue
                                                                                   ─────►  decode + apply (e.g. ev_mouse for fbDOOM)
```

The kernel buffers raw 3-byte packets — there is no userspace queue until the process allocates one and tells us about it, and a kernel-side queue lets `read()` complete synchronously without a host round-trip. The buffer is bounded at 4096 packets with whole-packet drop on overflow (≈10s at 400Hz). `poll()` returns `POLLIN` only when bytes are queued; `O_NONBLOCK` reads return `EAGAIN` when empty.

Single-open semantics match real Linux mousedev exclusive-grab. The host inverts browser `deltaY` (browser positive-down → PS/2 positive-up) before injecting, so the kernel queue holds canonical PS/2 sign convention. ABI version bumped 6 → 7 to register the new `kernel_inject_mouse_event(i32, i32, u32) -> ()` export.

## Audio output (`/dev/dsp`)

The kernel exposes an OSS-style `/dev/dsp` character device so unmodified Linux audio software (fbDOOM, etc.) can play sound through a browser `AudioContext`. Direction is reversed vs. mouse: PCM samples flow **process → kernel → host**.

```
   user process                       kernel-worker / kernel                browser main thread
   ────────────                       ──────────────────────                ───────────────────────
   open("/dev/dsp", O_WRONLY)
   ioctl SNDCTL_DSP_SPEED          ──►  audio::set_sample_rate
   ioctl SNDCTL_DSP_STEREO         ──►  audio::set_channels
   ioctl SNDCTL_DSP_SETFMT          ──►  audio::set_format (must be S16_LE)
   write(fd, pcm, len)             ──►  audio::write_pcm
                                       push bytes to 256 KiB ring
                                       (drop oldest whole frames on overflow)
                                                                ◄────────────  setInterval(50ms): drainAudio(maxBytes)
                                       kernel_drain_audio(out_ptr, out_len)
                                       drain whole-frame bytes from ring
                                                                ─────────────►  decode S16 → Float32
                                                                                schedule AudioBufferSourceNode
                                                                                on AudioContext clock
```

The kernel does **not** mix or synthesize audio. The user program (DOOM's mixer in `i_kernel_sound.c` plus the OPL2 software synth in `i_oplmusic.c` + `opl/opl3.c` for music) does that work and writes interleaved S16_LE frames; the kernel ring is just transport. fbDOOM's mixer produces 1280 stereo frames per ~28 ms game tic — slightly more than the 1260 frames the AudioContext consumes per tic — so the ring stays full enough to hide drain jitter, and the drop-oldest-on-overflow policy keeps memory bounded.

Single-open semantics match the typical OSS exclusive-grab model. Ownership is released on `close` of the last `/dev/dsp` fd or on process exit; a surviving non-CLOEXEC fd retains both ownership and queued samples across exec. The ring is flushed when ownership is released so a successor open hears silence rather than the previous owner's tail. ABI version bumped 7 → 8 to register the new `kernel_drain_audio(i64, i32) -> i32` export plus the three readouts `kernel_audio_sample_rate / channels / pending`. The OSS ioctl encodings live in `crates/shared/src/lib.rs::oss`.

## Signal Subsystem

Signals are delivered at syscall boundaries. When a process has a pending signal:

1. `kernel_handle_channel` checks for pending signals after each syscall
2. If a signal handler is registered (SA_SIGINFO), the kernel writes signal info to the channel's data buffer
3. The glue reads the signal info and calls the handler on the process's stack (or alternate signal stack if SA_ONSTACK)
4. After the handler returns, the glue calls `SYS_RT_SIGRETURN` to restore the signal mask
5. If the signal interrupted a blocking syscall, EINTR is returned

Features: RT signal queuing with `si_value`, cross-process `kill`/`killpg`, `sigaltstack` with shadow stack swap, `sigsuspend`, `sigtimedwait`, `setitimer`/`alarm` via host timers.

POSIX timer scheduling is split at an explicit ownership boundary. The shared
Node/browser host owns wall-clock `setTimeout`/`setInterval` scheduling, while
the kernel owns the timer object, notification-pending state, exact
`SIGEV_THREAD_ID` target, `SI_TIMER` metadata, overrun accounting, and queued
signal lifetime. At each expiration the host calls the ABI-required
`kernel_posix_timer_fire` export and wakes only the thread selected by the
kernel (or the eligible process-wide waiters for `SIGEV_SIGNAL`). The host does
not synthesize timer signals or fall back to a process-wide notification.

Musl implements POSIX `SIGEV_THREAD` with a detached helper pthread and an
exact-thread kernel notification. The helper retains the callback and native
`union sigval` locally—including a full-width wasm64 pointer—while the
kernel-facing `sigevent` remains a fixed four-i32 wire. Direct wasm64 signal
notifications therefore remain limited to `sival_int` until that wire is
extended in a later ABI.

Normal exit status and signal termination are stored separately. `_exit()` and
`exit_group()` retain the low eight status bits, including values 128 through
255; a default terminating signal records its signal number independently.
`waitpid()` therefore emits the POSIX wait encoding without guessing that a
high normal exit code was a signal, while host lifecycle callbacks may still
present the conventional shell-style `128 + signal` value.

Child status is a Rust-owned, per-process record covering stop, continue, and
termination. POSIX replacement semantics apply: a new transition replaces
older unconsumed status, ordinary waits consume it, and `waitid(WNOWAIT)` only
peeks. Stopped and continued reports never reap; consuming termination status
does. The host validates every guest output range before asking the kernel to
consume a record, so an `EFAULT` cannot lose child status or reap a zombie.

Default stop actions park execution cooperatively at the syscall boundary. The
kernel emits a process-transition event, and the shared Node/browser host holds
prepared completions by exact channel identity, including every pthread
channel, until SIGCONT. SIGCONT changes state immediately even when blocked,
ignored, or caught; SIGKILL can terminate a stopped process. Current Wasm
workers do not provide arbitrary-instruction preemption, so CPU-bound code that
never reaches a syscall cannot be suspended immediately; that boundary is
documented in `posix-status.md` rather than hidden behind host-specific behavior.

## Browser-Specific Architecture

In the browser, an additional layer wraps the kernel:

```
Main Thread                              Kernel Worker
├── BrowserKernel (thin proxy)           ├── CentralizedKernelWorker
├── UI code (HTML/JS)                    ├── MemoryFileSystem (kernel-owned)
├── App clients (MySQL, Redis)           ├── Kernel Wasm instance
├── HTTP bridge / TCP injection          ├── Process sub-workers
├── Local virtual network                ├── POSIX socket routing
└── PTY terminal (xterm.js)              └── Connection pump, blocking retries
```

**`BrowserKernel`** (`host/src/browser-kernel-host.ts`): Main-thread proxy that communicates with the browser kernel worker via `postMessage`. This is host/runtime code, maintained beside the Node.js host (`host/src/node-kernel-host.ts`). Browser apps and demos consume it; they do not own it. The current API has two boot paths:

- `kernel.boot({ kernelWasm, vfsImage, argv, env, ... })` — preferred. Combined with `kernelOwnedFs: true`, the main thread never holds a `MemoryFileSystem` reference. The kernel worker restores the image and exec()s `argv[0]` as the first process. All FS operations stay inside the worker, off the syscall hot path.
- `kernel.spawn(programBytes, argv, opts)` — legacy. Posts the wasm bytes to the kernel worker, which allocates and registers the process, starts its process worker, and then returns the assigned pid in the spawn response. Kept for transient binary launches (REPLs, test runners, benchmarks) that the kernel can't currently load via fork+exec from a baked binary.

The remaining methods (`pipeRead`/`pipeWrite`, `injectConnection`, stdin/PTY routing, framebuffer registry mirroring, HTTP bridge handoff) are pid-addressed and work the same in both boot paths.

**Browser kernel worker** (`host/src/browser-kernel-worker-entry.ts`): Dedicated web worker that hosts `CentralizedKernelWorker`, following the standard architecture requirement. Process workers are sub-workers created by the kernel worker. Syscall notification remains event-driven through `Atomics.waitAsync`, not channel polling. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue; this keeps syscall handling and worker messages progressing together under multi-process bridge load. Node.js retains its native/default batching unchanged.

**dinit (PID 1)** (`packages/registry/dinit/`): Service-supervised demos boot dinit v0.19.4 (cross-compiled to wasm32) as the first process via `kernel.boot({ argv: ["/sbin/dinit", "--container", ...] })`. The service tree is baked into `/etc/dinit.d/*` at image-build time via `addDinitInit()` in `dinit-image-helpers.ts`. Service types in use: `process` (long-running daemons), `scripted` (one-shot bootstraps that exit cleanly), and `internal` (dependency-only nodes used to express "boot the whole tree" or "pick this engine"). dinit handles SIGCHLD reaping, restarts disabled by default, and inter-service `depends-on` ordering.

**Service Worker** (`apps/browser-demos/public/service-worker.js`): Dual-mode file that acts as both a page bootstrap script (registers itself, enables cross-origin isolation) and a service worker (adds COOP/COEP headers, handles HTTP bridge routing).

### Linux-compatible graphics devices

Kandelo exposes a small Linux-shaped graphics stack through virtual character
devices:

- `/dev/dri/renderD128` accepts the render-node subset used by `libdrm`,
  `libgbm`, EGL, and GLES userspace shims.
- `/dev/dri/card0` adds the KMS subset used for one virtual connector, encoder,
  CRTC, dumb buffers, framebuffer objects, `SET_MASTER`, `SET_CRTC`, and
  `PAGE_FLIP` events.
- `/dev/fb0` remains the simpler framebuffer path for software that writes a
  linear BGRA buffer directly.

The kernel owns the device ABI, fd-local GEM handles, DRM-master ownership,
KMS framebuffer refcounts, BO mmap authorization, and process lifecycle
cleanup. User programs cannot mmap an arbitrary BO id: the mmap offset must
come from `DRM_IOCTL_MODE_MAP_DUMB` on the same open file description. On
`munmap`, `exec`, `exit`, or final fd close, the kernel unbinds BO and GL
memory from the host before those Wasm memory ranges can be reused.

Pixel and GL execution are host responsibilities. The TypeScript host keeps
GBM BO metadata/SAB snapshots, KMS scanout state, and WebGL contexts. GLIO
command buffers live in the user process's Wasm memory; `libGLESv2.a` appends
TLV commands, the kernel validates the submitted range, and the host decodes
the commands against a browser `WebGL2RenderingContext` or a test double in
Node.js. The kernel does not contain GL rendering code.

The user-space libraries are sysroot libraries, not kernel build outputs:
`scripts/build-musl.sh` installs the headers and builds `sysroot/lib/libdrm.a`,
`libgbm.a`, `libEGL.a`, and `libGLESv2.a`, plus matching pkg-config files.
Packages that depend on these APIs link through `wasm32posix-pkg-config` and
declare their resulting program artifacts as packages. The `modeset` demo is
one such package: its VFS image installs `/usr/local/bin/modeset`, and
`/etc/kandelo/demo.json` selects the KMS surface and `autoCommand` that starts
it. The browser loader stays generic; it does not special-case `modeset.wasm`.

## Performance Architecture

### The dedicated worker thread is the optimization

The single most impactful performance decision is running the kernel in a dedicated worker thread (`NodeKernelHost` on Node.js, `BrowserKernel` on browsers). Benchmarked gains from the worker thread architecture vs. running the kernel on the main thread:

| Metric | Main thread | Worker thread | Change |
|--------|------------|---------------|--------|
| pipe_mbps | 10.9 | 24.1 | **+121%** |
| clone_ms | 94.1 | 36.7 | **-61%** |
| fork_ms | 243.8 | 176.9 | **-27%** |
| exec_ms | 186.9 | 171.5 | -8% |
| hello_start_ms | 88.2 | 139.6 | +58% (kernel thread startup cost) |
| file_read_mbps | 236.0 | 188.4 | -20% |

The `hello_start` regression is a fixed one-time cost: spinning up the kernel worker thread (~50ms). For any workload that runs more than a trivial number of syscalls, the dedicated thread wins.

### Do not micro-optimize the syscall hot path

The following "optimizations" in `kernel-worker.ts` were benchmarked and **all made performance worse**:

1. **Syscall argument count tables** (`SYSCALL_ARG_COUNTS`): Reading fewer BigInt args per syscall based on a lookup table. Saved ~nanoseconds per syscall but added branch overhead and a critical correctness risk — if the table uses wrong syscall numbers, args are silently zeroed, breaking networking and other subsystems.

2. **I/O syscall classification** (`IO_SYSCALLS`): Skipping `drainAndProcessWakeupEvents()` for non-I/O syscalls. The drain is cheap when there are no events, and skipping it risks missing wakeups in edge cases.

3. **Cached TypedArray views**: Caching `DataView` and `Int32Array` on channel structs to avoid re-creation. V8 already optimizes `new DataView()` to near-zero cost; the cache adds memory overhead and invalidation complexity for no measurable gain.

4. **Conditional debug ring logging**: Skipping syscall ring buffer entries for 0-arg syscalls. The ring buffer is a fixed-size array push — negligible cost, but valuable for crash diagnostics.

**Why they fail**: The Wasm kernel execution (calling `kernel_handle_channel` which dispatches into Rust-compiled syscall logic) dominates each syscall's wall time. The TypeScript overhead around it — reading 6 args, creating views, draining events, logging — is noise. Micro-optimizing noise adds complexity and risk for no throughput gain.

**What to optimize instead**: If syscall throughput needs improvement, focus on the kernel Wasm code (`crates/kernel/`), the channel protocol, or the worker thread scheduling. The TypeScript host path is not the bottleneck.

## Build System

### Kernel Build

```bash
bash build.sh
```

1. `cargo build` with `-Z build-std=core,alloc` targeting `wasm32-unknown-unknown`
2. Copies `kandelo-kernel.wasm` to `host/wasm/`
3. Builds user programs from `programs/*.c` via `scripts/build-programs.sh`
4. Builds TypeScript host via `npm run build` (tsup → ESM + CJS)
5. Builds the canonical rootfs image via `scripts/build-rootfs.sh`, which invokes the `mkrootfs` CLI (`tools/mkrootfs/`) against the top-level `MANIFEST` + `images/rootfs/` source tree, stamps the current `ABI_VERSION` into image metadata, and writes `host/wasm/rootfs.vfs`

`host/wasm/` is gitignored — `rootfs.vfs`, `kernel.wasm`, and the rest are built artifacts. `tools/mkrootfs/` is the source of the image-builder CLI; the canonical owners/modes/sticky-bits live in `MANIFEST`, the file content under `images/rootfs/`.

Manifest node paths and archive mount points use canonical absolute POSIX
paths. ZIP archives ingested by `mkrootfs` require byte-exact UTF-8 canonical
relative member paths; unsafe aliases or type-conflicting path graphs fail
before VFS mutation. Unix ZIP symlinks retain their validated target payload
and archive-declared ownership, including relative targets with parent
components.

### User Program Compilation

The SDK (`sdk/`) provides `wasm32posix-cc` which wraps clang with:
- `--target=wasm32-unknown-unknown`
- `-matomics -mbulk-memory -mexception-handling` (Wasm features)
- `--sysroot=<path to musl sysroot>`
- Links: `channel_syscall.c` + `compiler_rt.c` + `crt1.o` + `libc.a`
- Linker flags: `--import-memory --shared-memory --max-memory=1073741824`

For programs that use `fork()` or fork-like helpers, the in-tree
`wasm-fork-instrument` tool (see
[fork-instrumentation.md](fork-instrumentation.md)) must be the **last**
post-link pass — after any `wasm-opt -O2`. Build scripts call
`scripts/run-wasm-fork-instrument.sh`, which builds the tool on demand if the
prebuilt `tools/bin/wasm-fork-instrument` is absent. The tool auto-discovers
fork-path functions via call-graph analysis from the `kernel.kernel_fork`
import; no onlylist is needed. Legacy Asyncify artifacts are not supported.

### Package system

Every artifact under `packages/registry/<name>/` is a **package**. Each ships two TOML files:

- **`package.toml`** — the **recipe**: name, version, upstream source pin, license, dependencies, `[build].script_path`. Identity-and-constraints. Project-agnostic; same content across any project that depends on this package.
- **`build.toml`** — the **project view**: `script_path` (this project's actual build), `repo_url` + `commit` (where the recipe lives in this project), publish-time `revision`, and `[binary]` declaring where binaries are published. Differs per project.

Binary resolution does not look at either of those files for archive URLs. Instead, a per-release `index.toml` ledger hosted at `build.toml`'s `index_url` is the single source of truth — see `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md` for the full design and `docs/package-management.md` for the reference manual.

**Resolver flow** (`xtask build-deps resolve`, called from build scripts):

1. Read `packages/registry/<name>/package.toml` for the recipe.
2. Read `packages/registry/<name>/build.toml` for the binary source and publish-time `revision`.
3. `build.toml`'s `[binary]` declares one of:
   - `index_url = "https://.../binaries-abi-v{abi}/index.toml"` — indexed lookup. `{abi}` is substituted with the current `ABI_VERSION` from `crates/shared/src/lib.rs`.
   - `url = "..." sha256 = "..."` — direct archive URL, no index.
4. Indexed flow fetches `index.toml` (cached at `~/.cache/kandelo/indexes/`) and looks up `(name, version, arch)`:
   - `status = "success"` → fetch `archive_url`, verify `archive_sha256`, install.
   - `status = "failed"` / `"pending"` / `"building"` with `fallback_archive_url` set → fetch the last-green archive instead.
   - Anything else → fall through to source build.
5. Every installed archive's internal `manifest.toml`'s `[compatibility]` block is verified against the request (target_arch, abi_versions, cache_key_sha). Any mismatch falls through to source build.

**Per-package updates are serialized by release.** CI's per-matrix-build job
runs `scripts/index-update.sh` after producing each archive: it acquires the
target tag's workflow-level state-lock (`.github/scripts/state-lock.sh`),
downloads the current `index.toml`, mutates this package's entry via `xtask
index-update`, uploads the content-addressed archive, and publishes the updated
ledger. PR staging and Prepare-merge candidate tags are isolated from
consumers. Canonical `binaries-abi-v<N>` writers publish through
`scripts/release-index-state.sh`, whose marker, immutable generation, and
transaction journal make the logical ledger commit crash-recoverable; they do
not replace the canonical ledger with an unjournaled `--clobber`. Different
tags use different state-lock subjects, so independent rebuilds do not block
each other.

Prepare-merge snapshots canonical state through the same script's nonmutating
validation path. It reads a legacy stable index as-is, but managed releases must
have an agreeing marker, immutable generation, and live asset. Transaction
cleanup leftovers do not hide that committed view; incomplete or mismatched
state is left unchanged for scheduled post-merge recovery.

**Last-green fallback.** When a per-package rebuild for `(name, version, arch)` fails, its prior successful `archive_url` is preserved in the entry's `fallback_archive_url` field — consumers keep fetching the last working archive while CI iterates on the rebuild. A subsequent success clears the fallback.

**CI flow.** `.github/workflows/staging-build.yml` builds changed packages into
per-PR staging tags. On `ready-to-ship`, `prepare-merge.yml` snapshots the
canonical ledger into a run-specific merge-candidate release, builds or
promotes packages there, tests that exact synthetic merge, and seals the tested
candidate without changing canonical state. After a reviewer merges the exact
prepared tree, `activate-merge-candidate.yml` verifies the merge identity,
copies and verifies candidate archives, and commits one complete canonical
ledger through the journaled publisher. Its scheduled/manual path also
recovers interrupted canonical transactions even when there is no candidate to
activate. `force-rebuild.yml` remains the manual canonical rebuild escape
hatch.

The legacy `[binary]` block in `package.toml` was removed during the binary-resolution-via-index-ledger migration (see commit log around 2026-05-13). Archived `manifest.toml` bytes inside historical `.tar.zst` files still carry the legacy shape; `xtask`'s `parse_archived` keeps accepting it. `validate_source` rejects it on the source path so stale source files surface immediately.

For schema, resolver behavior, and the build-script contract see [docs/package-management.md](package-management.md). For the release operations (tag convention, `index.toml` shape, fetch-binaries.sh semantics) see [docs/binary-releases.md](binary-releases.md).

## Test Suites

| Suite | Command | What it tests |
|-------|---------|---------------|
| Cargo | `cargo test -p kandelo --target aarch64-apple-darwin --lib` | Kernel unit tests (610+) |
| Vitest | `cd host && npx vitest run` | Host integration tests (227+) — runs real Wasm programs |
| libc-test | `scripts/run-libc-tests.sh` | musl libc conformance (C standard library) |
| POSIX | `scripts/run-posix-tests.sh` | Open POSIX Test Suite (POSIX API conformance) |
| Sortix | `scripts/run-sortix-tests.sh --all` | Sortix os-test suite (4817+ tests, most comprehensive) |

All five suites must pass with 0 unexpected failures before merging changes.
