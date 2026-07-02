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
| `lock.rs` | Advisory file locking (fcntl F_SETLK/F_GETLK) |
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

Host imports (provided by TypeScript):

```
host_read(fd, buf, len) → bytes_read
host_write(fd, buf, len) → bytes_written
host_open(path, flags, mode) → handle
host_close(handle) → 0
host_stat(path, buf) → 0
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
| SharedLockTable | `shared-lock-table.ts` | Cross-process advisory file locks |
| SharedIpcTable | `shared-ipc-table.ts` | SysV IPC (msg queues, semaphores, shm) |
| NodeWorkerAdapter | `worker-adapter.ts` | Creates Node.js worker_threads |
| BrowserWorkerAdapter | `worker-adapter-browser.ts` | Creates Web Workers |

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
8       4      arg0
12      4      arg1
16      4      arg2
20      4      arg3
24      4      arg4
28      4      arg5
32      4      return_value
36      4      errno_value
40      65536  data_buffer (for path strings, read/write buffers, etc.)
```

Total: 65,576 bytes (header 40 bytes + data buffer 65,536 bytes).

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

## Multi-Process Model

### fork()

Fork uses the in-tree `wasm-fork-instrument` tool to snapshot the Wasm call stack (details in [fork-instrumentation.md](fork-instrumentation.md)):

1. User calls `fork()` → musl → `__syscall(SYS_clone, ...)` → glue
2. Host's `kernel_fork` override calls `wpk_fork_unwind_begin(buf)`. The tool-injected export sets state to UNWINDING, initializes `current_pos = frames_start_offset` at `*(buf+0)`, and snapshots every mutable scalar global (including `__tls_base` and `__stack_pointer`) into the buffer's `saved_globals[]` area.
3. The return-to-caller chain unwinds; each instrumented function's postamble writes its frame to the buffer and bumps `current_pos`.
4. Once `_start` returns (top-of-stack), the host sends SYS_FORK through the channel.
5. Kernel's `kernel_fork_process` copies fd table, signals, env, CWD, etc.
6. Host copies the parent's linear memory to a new `WebAssembly.Memory` and spawns a child worker.
7. Child worker calls `wpk_fork_rewind_begin(buf)` — the tool's export restores all saved globals. The host then calls `setupChannelBase(...)` (which reads the now-correct `__tls_base`) and invokes `_start`.
8. Each instrumented function's preamble sees state=REWINDING, reloads its frame, and re-enters the call site where the parent was interrupted. Eventually reaches the `kernel_fork` call site in the leaf function, which returns 0.
9. `wpk_fork_rewind_end` resets state; fork returns 0 in child, child PID in parent.

The instrumentation handles LLVM's new-EH `try_table` output correctly, including fork from inside C++ catch handlers. See [fork-instrumentation.md](fork-instrumentation.md) for the current guarantees and documented unanticipated Wasm-level carve-outs.

### exec()

1. User calls `execve(path, argv, envp)` → kernel returns exec request to host
2. Host resolves `path` to a Wasm binary (via filesystem or program map)
3. `kernel_exec_setup` closes CLOEXEC fds, resets signals, and **resets the program break** (POSIX/Linux behavior — the prior program's brk does not carry over)
4. Host terminates the old worker
5. Host creates fresh `WebAssembly.Memory` and re-registers the PID
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
   resolves the program bytes and instantiates a fresh Worker for the
   child, registered with `skipKernelCreate: true` because the kernel
   already inserted the Process.

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

`mmap` remains coherent because the kernel has one per-process address-space model for brk, mmap, and host-reserved dynamic control ranges. Automatic `mmap` starts at the process's `mmap_base`, not at the legacy fixed 64MB floor. `brk` growth succeeds only when the adjacent range is free; if an mmap region or host-reserved pthread slot occupies the next pages, `brk` fails by returning the old break. `MAP_FIXED`, `munmap`, and `mremap` growth are rejected when they would overlap the reserved prefix, legacy host-control range, or a host-reserved pthread slot. The host grows the process `WebAssembly.Memory` after successful brk/mmap/mremap syscalls and after dynamic pthread-slot reservations so returned guest addresses are backed before user code touches them.

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

`/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/nsswitch.conf`, `/etc/resolv.conf`, etc. are real files inside `host/wasm/rootfs.vfs`, served through the `/` mount. There is no in-kernel synthetic-file shim: any program that calls `getpwnam`, `gethostbyname`, `getservbyname`, etc. reads the same bytes a `cat /etc/passwd` would.

VFS images can also carry image-level metadata outside the guest file tree. The first declaration is `kernelAbi`, an exact `ABI_VERSION` requirement for images that carry ABI-bound Wasm programs. `MemoryFileSystem.readImageMetadata(image)` reads this declaration without materialising the filesystem, and `MemoryFileSystem.assertImageKernelAbi(image, abi)` validates it for callers that already know the running kernel ABI. Legacy/data-only images may omit the field.

### Node host

`NodeKernelHost` accepts `rootfsImage: "default" | ArrayBuffer | Uint8Array | undefined`. With `"default"` (the path used by the vitest suite), the worker reads `host/wasm/rootfs.vfs`, applies `DEFAULT_MOUNT_SPEC` via `resolveForNode`, and constructs a `VirtualPlatformIO` for the kernel. Without it, the worker falls back to raw `NodePlatformIO` (every host path reachable) — kept for legacy callers that haven't migrated.

### Browser host

`BrowserKernel.boot({ vfsImage, ... })` is the kernel-owned VFS path. The worker restores the supplied image (per-demo `.vfs.zst`, typically built on top of the canonical rootfs as a base layer) into a `MemoryFileSystem`, applies `DEFAULT_MOUNT_SPEC` via `resolveForBrowser` (the image becomes the `/` mount; the seven scratch mounts come up empty), and layers `/dev/shm` + `/dev` on top.

The legacy `kernel.spawn(programBytes, argv, { fsSab })` path is still supported for demos that own a single `MemoryFileSystem` SAB at `/` (used by `benchmark`, `erlang`, `shell`). To keep `getpwnam`/`gethostbyname` working on that path after `synthetic_file_content` was removed, the browser kernel worker overlays `/etc/*` from `rootfs.vfs` into the demo SAB at boot (`overlayEtcFromRootfs` in `host/src/browser-kernel-worker-entry.ts`), preserving any `/etc` files the demo wrote itself. This is a temporary bridge until those demos move to the `vfsImage` boot path.

### Lazy Files

`MemoryFileSystem` supports **lazy files** — files registered with a URL and declared size that are only fetched on first access. This enables loading large binaries (e.g., nginx, PHP-FPM, coreutils) without fetching everything upfront — they are only fetched when a process exec's them.

```typescript
// Register a lazy file (creates empty stub, fetches on demand)
const ino = mfs.registerLazyFile("/usr/bin/php", "https://cdn.example.com/php.wasm", 8_500_000);

// Later, materialize before sync access (avoids sync XHR deadlock with service workers)
await mfs.ensureMaterialized("/usr/bin/php");
```

Lazy file metadata (`path`, `url`, `size`, `ino`) can be transferred between instances via `exportLazyEntries()` / `importLazyEntries()` — used when forking workers that share the same SharedArrayBuffer.

### VFS Images

A `MemoryFileSystem` can be serialized to a portable binary image and restored later to boot a new kernel with a pre-populated filesystem. This enables snapshotting an initialized VFS (with all files, directories, symlinks, and permissions) and restoring it without repeating the setup work.

**Save an image:**

```typescript
// Preserve lazy files as URL references (smaller image, requires URLs at restore time)
const image: Uint8Array = await mfs.saveImage();

// Or materialize all lazy files first (self-contained image, no URL dependencies)
const fullImage: Uint8Array = await mfs.saveImage({ materializeAll: true });
```

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

Kandelo browser UI presets use this approach. Each image builder pre-populates a VFS with runtime files, directory structure, configs, and symlinks, then saves it as a `.vfs.zst` file (zstd-compressed; `saveImage()` compresses on write). At runtime, the UI fetches the file and `MemoryFileSystem.fromImage` decompresses transparently - restoring the image replaces thousands of individual file writes with a single buffer copy. The empty regions of the SharedFS allocator compress to almost nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1-3 MB download.

There are two consumption patterns for VFS images, depending on whether the demo wants the kernel worker to fully own the filesystem:

**Kernel-owned VFS (`kernelOwnedFs: true` + `kernel.boot()`).** The main thread never instantiates the `MemoryFileSystem`. Instead, the demo fetches the `.vfs.zst` bytes and hands them to `BrowserKernel.boot({ kernelWasm, vfsImage, argv, env })`. The kernel worker restores the filesystem internally (auto-detecting zstd magic), exec()s `argv[0]` as the first ("init") process, and the main thread becomes a thin client — only routing stdin/stdout, network backend messages, framebuffer events, and HTTP-bridge messages. Service-supervised demos run dinit (`/sbin/dinit --container`) as that init process; dinit reads `/etc/dinit.d/*` from the image and brings up the service tree. Single-program demos (python, perl, php, ruby) exec the language interpreter directly. This is the path new demos should use.

**Legacy main-thread-owned VFS (`memfs:` constructor option + `kernel.spawn()`).** The main thread restores the image into its own `MemoryFileSystem`, hands the SAB to a fresh `BrowserKernel`, and then calls `kernel.spawn(programBytes, argv)` to launch transient binaries. Useful for demos that fetch additional binaries at runtime (test runners, REPLs that load arbitrary code), but the main thread is in the syscall hot path for FS operations. Still used by `benchmark`, `erlang`, and `shell`.

| Demo | VFS Image | Build Script | Boot pattern |
|------|-----------|-------------|--------------|
| Python | `python.vfs.zst` | `build-python-vfs-image.sh` | `kernel.boot` → `python3` |
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
| Erlang | `erlang.vfs.zst` | `build-erlang-vfs-image.sh` | legacy `kernel.spawn` → BEAM |
| Shell | `shell.vfs.zst` | `build-shell-vfs-image.sh` | legacy `kernel.spawn` → dash |
| Benchmark | (multiple) | (per-suite) | legacy `kernel.spawn` |

Build scripts are in `images/vfs/scripts/` and share common helpers (`vfs-image-helpers.ts` for VFS write primitives, `dinit-image-helpers.ts` for the dinit binary + standard rootfs files + service-file rendering). To build all VFS images, use the per-demo scripts above or the convenience targets in `run.sh` (e.g., `./run.sh build python-vfs`).

**Binary format:**

The on-disk file is the raw VFS image below, wrapped in a single zstd
frame. `saveImage()` always writes the compressed form (`.vfs.zst`);
`MemoryFileSystem.fromImage()` accepts either form and auto-detects
the zstd magic (`28 B5 2F FD`) at offset 0 to decide whether to
decompress before parsing.

Decompressed layout:

```
Offset   Size   Field
0        4      Magic: 0x56465349 ("VFSI")
4        4      Version: 1
8        4      Flags: bit 0 = lazy entries included
12       4      SharedArrayBuffer data length (N)
16       N      Raw SharedArrayBuffer bytes (block filesystem)
16+N     4      Lazy entries JSON length (M)
20+N     M      Lazy entries as JSON (UTF-8): [{ino, path, url, size}, ...]
```

## Networking

User-visible networking is POSIX-first. Guest programs call normal AF_INET socket syscalls (`socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `sendto`, `recvfrom`, `poll`, and `select`). The Rust kernel owns the socket file descriptors, UDP queues, TCP listener state, loopback routing, and errno behavior. Host transports plug in below that layer through `NetworkIO`; they are backends, not the userspace-visible abstraction.

Loopback addresses are per Kandelo machine. Routed virtual addresses are explicit backend addresses. For example, the browser network lab attaches separate machines to addresses such as `10.88.0.2`, `10.88.0.3`, and `10.88.0.4`; traffic to `127.0.0.1` stays inside one machine, while traffic to those virtual addresses can cross machines through the backend.

### Local Virtual Network

`LocalVirtualNetwork` (`host/src/networking/virtual-network.ts`) is an in-memory `NetworkIO` backend for multiple Kandelo machines in the same JS session. Each machine receives a `VirtualNetworkBackend` with a stable virtual IPv4 address and optional hostnames. The backend delivers UDP datagrams as bounded message queues and creates paired TCP streams for accepted connections. When a machine detaches, its listeners and endpoints are removed and connected TCP peers observe normal close/reset style readiness through the socket layer.

This backend is used by `apps/browser-demos/pages/network/`, which boots multiple local machines and verifies UDP datagram delivery with `nc -u`, TCP stream delivery with `nc`, and HTTP over virtual TCP with `curl`.

### Node.js

`TcpNetworkBackend` uses Node.js `net.Socket` for external raw TCP. DNS uses `dns.lookup`. Node can therefore provide real socket-level TCP behavior for destinations outside the Kandelo process.

### Browser

Browsers cannot create external raw TCP or UDP sockets. Local loopback and `LocalVirtualNetwork` sockets work because they are virtual sockets behind the POSIX layer. External browser networking currently uses HTTP-oriented backends:

1. **FetchNetworkBackend**: Buffers an entire HTTP request from the Wasm process, sends it via `fetch()`, and returns the raw HTTP response bytes. Works for simple HTTP clients.

2. **Service Worker HTTP Bridge**: For server demos (nginx, WordPress), a service worker intercepts browser `fetch()` requests to a configurable URL prefix (e.g., `/app/`) and forwards them to the kernel via a MessagePort connection pump. The kernel injects the request as a TCP connection to nginx's listening socket, and nginx's response flows back through the pipe to the service worker.

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

Single-open semantics match the typical OSS exclusive-grab model. Owner ownership is released on `close` of the last `/dev/dsp` fd, on `execve`, and on process exit; the ring is flushed at the same time so a successor open hears silence rather than the tail of the previous program. ABI version bumped 7 → 8 to register the new `kernel_drain_audio(i64, i32) -> i32` export plus the three readouts `kernel_audio_sample_rate / channels / pending`. The OSS ioctl encodings live in `crates/shared/src/lib.rs::oss`.

## Signal Subsystem

Signals are delivered at syscall boundaries. When a process has a pending signal:

1. `kernel_handle_channel` checks for pending signals after each syscall
2. If a signal handler is registered (SA_SIGINFO), the kernel writes signal info to the channel's data buffer
3. The glue reads the signal info and calls the handler on the process's stack (or alternate signal stack if SA_ONSTACK)
4. After the handler returns, the glue calls `SYS_RT_SIGRETURN` to restore the signal mask
5. If the signal interrupted a blocking syscall, EINTR is returned

Features: RT signal queuing with `si_value`, cross-process `kill`/`killpg`, `sigaltstack` with shadow stack swap, `sigsuspend`, `sigtimedwait`, `setitimer`/`alarm` via host timers.

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
- `kernel.spawn(programBytes, argv, opts)` — legacy. Allocates a pid on the main thread, posts the wasm bytes to the worker, and starts a process. Kept for transient binary launches (REPLs, test runners, benchmarks) that the kernel can't currently load via fork+exec from a baked binary.

The remaining methods (`pipeRead`/`pipeWrite`, `injectConnection`, stdin/PTY routing, framebuffer registry mirroring, HTTP bridge handoff) are pid-addressed and work the same in both boot paths.

**Browser kernel worker** (`host/src/browser-kernel-worker-entry.ts`): Dedicated web worker that hosts `CentralizedKernelWorker`, following the standard architecture requirement. Process workers are sub-workers created by the kernel worker. The dedicated worker provides a clean event loop for fast `Atomics.waitAsync` notification delivery and avoids V8's microtask freeze bug that occurs on the main thread.

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

**Per-package updates land atomically.** CI's per-matrix-build job runs `scripts/index-update.sh` after producing each archive: it acquires a workflow-level state-lock (`.github/scripts/state-lock.sh`), downloads the current `index.toml`, mutates this package's entry via `xtask index-update`, and uploads the archive + new `index.toml` together. Different release tags (e.g. `binaries-abi-v11` vs `pr-<N>-staging`) use different state-lock subjects, so independent rebuilds don't block each other.

**Last-green fallback.** When a per-package rebuild for `(name, version, arch)` fails, its prior successful `archive_url` is preserved in the entry's `fallback_archive_url` field — consumers keep fetching the last working archive while CI iterates on the rebuild. A subsequent success clears the fallback.

**CI flow.** Per-package matrix builds are driven by `.github/workflows/staging-build.yml` (per-PR staging tags), `prepare-merge.yml` (on `ready-to-ship` label, ships to the durable `binaries-abi-v<N>` release), and `force-rebuild.yml` (manual escape hatch). All three drive the same per-package matrix; each matrix entry independently invokes `scripts/index-update.sh` to publish its archive + index entry atomically.

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
