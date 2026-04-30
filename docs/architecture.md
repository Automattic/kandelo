# Architecture

This document describes the internal architecture of Kandelo. It is written for both human developers and AI agents working on the codebase.

## Overview

Kandelo is a centralized, multi-process POSIX kernel that runs as WebAssembly. A single kernel Wasm instance manages all processes. The kernel **must** run in a dedicated worker thread (Web Worker in browsers, `worker_thread` in Node.js) — never on the main thread. Each process also runs in its own worker and communicates with the kernel via a SharedArrayBuffer-based channel.

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
| NodePlatformIO | `platform/node.ts` | Node.js filesystem, networking, random |
| VirtualPlatformIO | `vfs/vfs.ts` | Browser VFS with mountable backends |
| MemoryFileSystem | `vfs/memory-fs.ts` | SharedArrayBuffer-backed in-memory filesystem |
| DeviceFileSystem | `vfs/device-fs.ts` | /dev/null, /dev/zero, /dev/urandom, /dev/ptmx |
| OpfsFileSystem | `vfs/opfs.ts` | Origin Private File System (browser persistence) |
| SharedPipeBuffer | `shared-pipe-buffer.ts` | Cross-worker pipe ring buffers via SharedArrayBuffer |
| SharedLockTable | `shared-lock-table.ts` | Cross-process advisory file locks |
| SharedIpcTable | `shared-ipc-table.ts` | SysV IPC (msg queues, semaphores, shm) |
| NodeWorkerAdapter | `worker-adapter.ts` | Creates Node.js worker_threads |
| BrowserWorkerAdapter | `worker-adapter-browser.ts` | Creates Web Workers |

### 3. Glue Layer (C)

**Location**: `glue/`

Compiled into every user program. Three main files:

| File | Purpose |
|------|---------|
| `channel_syscall.c` | Channel-based syscall dispatcher. Writes syscall number + args to SharedArrayBuffer, notifies kernel via `Atomics.store` + `Atomics.notify`, waits for response via `Atomics.wait`. Also handles fork (Asyncify save/restore), clone (thread setup), exec, and signal delivery. |
| `compiler_rt.c` | Compiler runtime: soft-float (`__floatditf`, `__fixunstfdi`, etc.) and 64-bit builtins needed by musl on wasm32. |
| `dlopen.c` | Dynamic loading glue for `dlopen`/`dlsym` via host. |

## Syscall Channel Protocol

Each process has a dedicated channel region in its SharedArrayBuffer memory. The channel is placed at the end of the address space (last 2 pages = 128KB) to avoid collision with heap and mmap regions.

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

Fork uses Binaryen Asyncify to snapshot the Wasm call stack:

1. User calls `fork()` → musl → `__syscall(SYS_clone, ...)` → glue
2. Glue calls Asyncify unwind to save the call stack to a buffer
3. Returns to host with "fork requested" status
4. Host copies parent's entire Wasm memory to a new `WebAssembly.Memory`
5. Kernel's `kernel_fork_process` copies fd table, signals, env, CWD, etc.
6. Host spawns a new worker with the copied memory
7. Child worker starts Asyncify rewind, restoring the call stack
8. Fork returns 0 in child, child PID in parent

Key detail: Asyncify restores Wasm locals but NOT globals. The `__stack_pointer` and `__tls_base` globals are saved/restored explicitly by the glue at offsets near the asyncify buffer.

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

### clone() (threads)

1. User calls `clone(CLONE_VM | CLONE_THREAD, ...)` → kernel returns clone request
2. Host allocates a new channel region and TLS area in the SAME shared memory
3. Host spawns a new worker that shares the parent's `WebAssembly.Memory`
4. Thread worker runs `centralizedThreadWorkerMain`, calls `__wasm_thread_init` to set up TLS
5. Thread starts executing the given function pointer with the given argument

Threads share memory with the parent (CLONE_VM) but have their own channel and TLS region.

## Memory Layout

Each process has a WebAssembly linear memory (shared, up to 1GB by default):

```
Address           Region
0x00000000        Wasm data segment (globals, static data)
0x00110000        Global base (--global-base=1114112)
__heap_base       Heap start (brk grows up)
0x04000000        MMAP base (64MB) — mmap regions grow up
...
MAX_PAGES-4       Thread channel + TLS regions (grow down)
MAX_PAGES-2       Main process channel (last 2 pages)
MAX_PAGES         End of memory (1GB default)
```

The channel occupies the last 2 pages (128KB). Thread channels are allocated counting down from the main channel, with 3 pages per thread (2 for channel + 1 for TLS).

### Heap initialization (brk)

The kernel's `MemoryManager` tracks `program_break` per process. On every `spawn` and `exec`, the host parses `__heap_base` from the new program's exports (`extractHeapBase` in `host/src/constants.ts`) and calls `kernel_set_brk_base(pid, __heap_base)` *before* the new worker can issue its first syscall. The new program's first `brk(0)` then returns its own `__heap_base`, so musl's malloc places the heap above the data and shadow-stack regions.

The kernel's hardcoded `INITIAL_BRK` (16MB) is a fallback for binaries that don't export `__heap_base`. Programs built with our SDK always export it, so the fallback is never used in normal operation. `fork` correctly inherits the parent's brk via the kernel's process-state serialization; `exec` resets it (POSIX-correct) and the host re-installs it from the new program's `__heap_base`.

## Filesystem

### Node.js

`NodePlatformIO` passes filesystem operations directly to Node.js `fs` APIs. The kernel tracks its own fd table and path resolution, but actual file content comes from the host filesystem.

### Browser

The browser uses a layered VFS (`VirtualPlatformIO`):

```
/           → MemoryFileSystem (SharedArrayBuffer-backed, shared between main thread and kernel worker)
/dev/       → DeviceFileSystem (null, zero, urandom, ptmx, pts/N)
/persistent → OpfsFileSystem (Origin Private File System, browser persistence)
```

`MemoryFileSystem` is critical: it's how the main thread pre-populates files (configs, wasm binaries, runtime libraries) that the kernel worker can then read. Both threads share the same `SharedArrayBuffer`, with the filesystem's internal btree structure built directly in the buffer.

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

Most browser demos use this approach. Each demo has a build script that pre-populates a VFS with runtime files, directory structure, configs, and symlinks, then saves it as a `.vfs.zst` file (zstd-compressed; `saveImage()` compresses on write). At runtime, the demo fetches the file and `MemoryFileSystem.fromImage` decompresses transparently — restoring the image replaces thousands of individual file writes with a single buffer copy. The empty regions of the SharedFS allocator compress to almost nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1–3 MB download.

There are two consumption patterns for VFS images, depending on whether the demo wants the kernel worker to fully own the filesystem:

**Kernel-owned VFS (`kernelOwnedFs: true` + `kernel.boot()`).** The main thread never instantiates the `MemoryFileSystem`. Instead, the demo fetches the `.vfs.zst` bytes and hands them to `BrowserKernel.boot({ kernelWasm, vfsImage, argv, env })`. The kernel worker restores the filesystem internally (auto-detecting zstd magic), exec()s `argv[0]` as the first ("init") process, and the main thread becomes a thin client — only routing stdin/stdout, TCP injection, framebuffer events, and HTTP-bridge messages. Service-supervised demos run dinit (`/sbin/dinit --container`) as that init process; dinit reads `/etc/dinit.d/*` from the image and brings up the service tree. Single-program demos (python, perl, php, ruby) exec the language interpreter directly. This is the path new demos should use.

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

Build scripts are in `examples/browser/scripts/` and share common helpers (`vfs-image-helpers.ts` for VFS write primitives, `dinit-image-helpers.ts` for the dinit binary + standard rootfs files + service-file rendering). To build all VFS images, use the per-demo scripts above or the convenience targets in `run.sh` (e.g., `./run.sh build python-vfs`).

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

### Node.js

`TcpNetworkBackend` uses Node.js `net.Socket` for raw TCP. DNS via `dns.lookup`. This gives real socket-level behavior.

### Browser

Browsers cannot create raw TCP connections. Two strategies:

1. **FetchNetworkBackend**: Buffers an entire HTTP request from the Wasm process, sends it via `fetch()`, and returns the raw HTTP response bytes. Works for simple HTTP clients.

2. **Service Worker HTTP Bridge**: For server demos (nginx, WordPress), a service worker intercepts browser `fetch()` requests to a configurable URL prefix (e.g., `/app/`) and forwards them to the kernel via a MessagePort connection pump. The kernel injects the request as a TCP connection to nginx's listening socket, and nginx's response flows back through the pipe to the service worker.

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
└── PTY terminal (xterm.js)              └── Connection pump, blocking retries
```

**`BrowserKernel`** (`examples/browser/lib/browser-kernel.ts`): Main-thread proxy that communicates with the kernel worker via `postMessage`. The current API has two boot paths:

- `kernel.boot({ kernelWasm, vfsImage, argv, env, ... })` — preferred. Combined with `kernelOwnedFs: true`, the main thread never holds a `MemoryFileSystem` reference. The kernel worker restores the image and exec()s `argv[0]` as the first process. All FS operations stay inside the worker, off the syscall hot path.
- `kernel.spawn(programBytes, argv, opts)` — legacy. Allocates a pid on the main thread, posts the wasm bytes to the worker, and starts a process. Kept for transient binary launches (REPLs, test runners, benchmarks) that the kernel can't currently load via fork+exec from a baked binary.

The remaining methods (`pipeRead`/`pipeWrite`, `injectConnection`, stdin/PTY routing, framebuffer registry mirroring, HTTP bridge handoff) are pid-addressed and work the same in both boot paths.

**Kernel Worker** (`examples/browser/lib/kernel-worker-entry.ts`): Dedicated web worker that hosts `CentralizedKernelWorker`, following the standard architecture requirement. Process workers are sub-workers created by the kernel worker. The dedicated worker provides a clean event loop for fast `Atomics.waitAsync` notification delivery and avoids V8's microtask freeze bug that occurs on the main thread.

**dinit (PID 1)** (`examples/libs/dinit/`): Service-supervised demos boot dinit v0.19.4 (cross-compiled to wasm32) as the first process via `kernel.boot({ argv: ["/sbin/dinit", "--container", ...] })`. The service tree is baked into `/etc/dinit.d/*` at image-build time via `addDinitInit()` in `dinit-image-helpers.ts`. Service types in use: `process` (long-running daemons), `scripted` (one-shot bootstraps that exit cleanly), and `internal` (dependency-only nodes used to express "boot the whole tree" or "pick this engine"). dinit handles SIGCHLD reaping, restarts disabled by default, and inter-service `depends-on` ordering.

**Service Worker** (`examples/browser/public/service-worker.js`): Dual-mode file that acts as both a page bootstrap script (registers itself, enables cross-origin isolation) and a service worker (adds COOP/COEP headers, handles HTTP bridge routing).

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
2. Copies `wasm_posix_kernel.wasm` to `host/wasm/`
3. Builds user programs from `programs/*.c` via `scripts/build-programs.sh`
4. Builds TypeScript host via `npm run build` (tsup → ESM + CJS)

### User Program Compilation

The SDK (`sdk/`) provides `wasm32posix-cc` which wraps clang with:
- `--target=wasm32-unknown-unknown`
- `-matomics -mbulk-memory -mexception-handling` (Wasm features)
- `--sysroot=<path to musl sysroot>`
- Links: `channel_syscall.c` + `compiler_rt.c` + `crt1.o` + `libc.a`
- Linker flags: `--import-memory --shared-memory --max-memory=1073741824`

For programs that use `fork()`, Binaryen's `wasm-opt --asyncify` post-processing is required to enable call stack save/restore.

## Test Suites

| Suite | Command | What it tests |
|-------|---------|---------------|
| Cargo | `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` | Kernel unit tests (610+) |
| Vitest | `cd host && npx vitest run` | Host integration tests (227+) — runs real Wasm programs |
| libc-test | `scripts/run-libc-tests.sh` | musl libc conformance (C standard library) |
| POSIX | `scripts/run-posix-tests.sh` | Open POSIX Test Suite (POSIX API conformance) |
| Sortix | `scripts/run-sortix-tests.sh --all` | Sortix os-test suite (4817+ tests, most comprehensive) |

All five suites must pass with 0 unexpected failures before merging changes.
