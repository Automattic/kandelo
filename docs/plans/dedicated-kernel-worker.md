# Move Kernel to Dedicated Web Worker

## Context

The `CentralizedKernelWorker` currently runs on the browser's main thread. This was never the intended design — it was a shortcut that causes the main thread to lock up during heavy syscall processing (e.g., MariaDB with 6 channels). The intended architecture runs the kernel in a dedicated web worker, freeing the main thread for UI rendering and coordination only.

Moving the kernel to its own worker also unlocks:
- `Atomics.wait()` (blocked on main thread in Chrome) — enables blocking operations like `nanosleep()` and synchronous `fetch()` networking
- `Atomics.waitAsync` without the V8 microtask chain freeze bug (that bug is main-thread specific)
- No need for the `usePolling` workaround or `setImmediate` polyfill on main thread
- Zero UI jank regardless of syscall load

## Architecture

The kernel worker owns the kernel Wasm instance AND all process lifecycle. The main thread is a thin UI proxy.

```
Main Thread (BrowserKernel)              Kernel Worker
├── UI / rendering                       ├── CentralizedKernelWorker
├── MemoryFileSystem (main copy)         ├── Kernel Wasm instance
├── Service worker bridge ──pipe ops──>  ├── VirtualPlatformIO (fromExisting SABs)
├── PTY terminal ──pty events──>         ├── Syscall processing (Atomics.waitAsync)
├── Page API (spawn, stdin, fs)          ├── Process lifecycle (fork/exec/clone/exit)
└── Connection pump / clients            ├── Process worker creation (sub-workers)
         │                               ├── Exec reads binaries from shared FS
         └──── MessagePort (RPC) ───────>└── Blocking retry management
                                                    │
                                   Process Workers ──┘ (SharedArrayBuffer channels)
```

**Key principle**: The kernel worker is fully autonomous. Fork, exec, clone — all handled inside the kernel worker with zero main thread involvement. Exec reads program binaries from the shared `MemoryFileSystem` (same SAB as main thread's `kernel.fs`), just like a real OS reads executables from disk. Programs are loaded into the filesystem before spawning, and the kernel resolves them at exec time.

## Key Files

| File | Role | Change |
|------|------|--------|
| `examples/browser/lib/browser-kernel.ts` | Main thread coordinator | Major refactor — becomes thin proxy |
| `examples/browser/lib/kernel-worker-entry.ts` | **New** — kernel web worker entry | Create |
| `examples/browser/lib/kernel-worker-protocol.ts` | **New** — message protocol types | Create |
| `host/src/kernel-worker.ts` | CentralizedKernelWorker | Minor — expose methods for worker use |
| `host/src/worker-adapter-browser.ts` | Creates process web workers | Used from kernel worker (sub-workers) |
| `examples/browser/lib/connection-pump.ts` | HTTP → kernel pipe bridge | Async pipe ops |
| `examples/browser/lib/mysql-client.ts` | MySQL wire protocol over pipes | Async pipe ops |
| `examples/browser/lib/redis-client.ts` | RESP protocol over pipes | Async pipe ops |
| `docs/browser-support.md` | Architecture docs | Update |

## Steps

### 1. Update design doc (`docs/browser-support.md`)

Rewrite Architecture section: the kernel runs in a dedicated web worker with `Atomics.waitAsync` for syscall dispatch. Process workers are sub-workers created by the kernel worker. Main thread is UI-only. Exec resolves binaries from the shared filesystem.

### 2. Define message protocol

**New file:** `examples/browser/lib/kernel-worker-protocol.ts`

**Main → Kernel Worker:**
- `init` — kernel wasm bytes, FS SABs, config, worker entry URL
- `spawn` — requestId, programPath (FS path) OR programBytes (inline), argv, env, cwd, options (pty, maxPages, stdinData)
- `terminate_process` — pid, status
- `append_stdin_data` / `set_stdin_data` — pid, data
- `pty_write` / `pty_resize` — pid, data/rows/cols
- `inject_connection` — requestId, pid, fd, peerAddr, peerPort
- `pipe_read` / `pipe_write` — requestId, pid, pipeIdx, data
- `pipe_close_read` / `pipe_close_write` — pid, pipeIdx
- `pipe_is_write_open` — requestId, pid, pipeIdx
- `pick_listener_target` — requestId, port
- `wake_blocked_readers` / `wake_blocked_writers` — pipeIdx
- `is_stdin_consumed` — requestId, pid
- `destroy` — shut down kernel

**Kernel Worker → Main:**
- `ready` — init complete
- `response` — requestId, result (for request/response pairs)
- `exit` — pid, status (process exited)
- `stdout` / `stderr` — pid, data
- `listen_tcp` — pid, fd, port
- `pty_output` — pid, data

Note: no `need_exec` message — exec resolution is entirely within the kernel worker via the shared filesystem.

### 3. Create kernel worker entry point

**New file:** `examples/browser/lib/kernel-worker-entry.ts`

This web worker hosts `CentralizedKernelWorker` and manages all process lifecycle.

**On init message:**
1. Receive kernel wasm bytes, FS SABs, config, worker entry URL
2. Construct PlatformIO in the worker:
   - `MemoryFileSystem.fromExisting(mainFsSab)` — shares SAB with main thread
   - `MemoryFileSystem.fromExisting(shmSab)` — `/dev/shm`
   - `new DeviceFileSystem()`, `new BrowserTimeProvider()`
   - `new VirtualPlatformIO(mounts, timeProvider)`
3. Create `BrowserWorkerAdapter(workerEntryUrl)` — for spawning sub-workers
4. Create `CentralizedKernelWorker` with:
   - `usePolling = false` — use `Atomics.waitAsync` (V8 bug is main-thread-only)
   - Callbacks wired internally (see below)
5. Call `kernelWorker.init(wasmBytes)`
6. Post `{ type: "ready" }` to main thread
7. Start handling messages

**Callback wiring (all within the kernel worker):**
- `onFork`: copy parent memory, pre-compile module (`WebAssembly.compile` gives TurboFan in workers), create child sub-worker via `BrowserWorkerAdapter`, register channels.
- `onExec`: read binary from shared `MemoryFileSystem` at the exec path (e.g., `/usr/bin/grep`). Create new memory, register, create new sub-worker. Falls back to ENOENT if path not found.
- `onClone`: allocate thread channel in shared memory, create thread sub-worker.
- `onExit`: send `{ type: "exit", pid, status }` to main thread for UI updates.
- `onStdout`/`onStderr`: forward to main thread.
- `onListenTcp`: forward to main thread.

**Spawn handler:**
On `spawn` message from main thread:
1. If `programPath` provided, read bytes from shared FS; else use `programBytes`
2. Create `WebAssembly.Memory(shared: true, initial: 17, max: maxPages)`
3. Grow to max, zero channel region
4. `kernelWorker.registerProcess(pid, memory, [channelOffset])`
5. Optional: `setCwd`, `setupPty`, `setStdinData`
6. `workerAdapter.createWorker(initData)` — creates sub-worker
7. Attach exit/error handlers
8. Respond with `{ type: "response", requestId, result: pid }`

**Pipe operation handlers:**
Direct kernel Wasm export calls — synchronous within the worker:
- `kernel_inject_connection(pid, fd, ...)` → return recvPipeIdx
- `kernel_pipe_read(pid, pipeIdx, ...)` → return data
- `kernel_pipe_write(pid, pipeIdx, ...)` → return bytes written
- `kernel_pipe_close_read/write`, `kernel_pipe_is_write_open`
- `scheduleWakeBlockedRetries()`, `retrySyscall()` for wake operations

### 4. Refactor BrowserKernel to thin proxy

Major refactor of `examples/browser/lib/browser-kernel.ts`:

**`init()` changes:**
1. Create MemoryFileSystem SABs on main thread (keep reference for `kernel.fs`)
2. Import kernel worker entry via `?worker&url` for Vite bundling
3. `new Worker(kernelWorkerEntryUrl, { type: "module" })`
4. Send init message with wasm bytes + SABs + config + process worker entry URL
5. Wait for `ready` response
6. Set up message handler for kernel worker events

**Remove entirely:**
- Direct `kernelInstance` / `kernelMemory` references
- All `(kernelWorker as any)` internal access
- `setImmediate` polyfill (not needed on main thread)
- `usePolling = true` setting
- `handleFork`, `handleClone` methods (moved to kernel worker)
- `nextThreadChannelPage` tracking (moved to kernel worker)
- `workerAdapter` (moved to kernel worker)

**Public API becomes async proxy:**
- `spawn()` → send `spawn` message, await response (exit promise wrapping)
- `pipeRead/Write()` → send request, await response via requestId
- `injectConnection()` → send request, await response
- `appendStdinData/setStdinData()` → fire-and-forget message
- `ptyWrite/ptyResize()` → fire-and-forget message
- `pickListenerTarget()` → send request, await response
- `wakeBlockedReaders/Writers()` → fire-and-forget message
- `terminateProcess()` → send message, await response
- `destroy()` → send message, terminate kernel worker
- `get fs()` → returns main thread's MemoryFileSystem (same SAB as kernel worker)

**Event handling from kernel worker:**
- `exit` → resolve exit promise, clean up
- `stdout/stderr` → forward to `options.onStdout/onStderr`
- `listen_tcp` → forward to `options.onListenTcp`
- `pty_output` → forward to PTY output callback

### 5. Make connection-pump.ts async

- `kernel.pipeWrite()` → `await kernel.pipeWrite()`
- `kernel.pipeRead()` → `await kernel.pipeRead()`
- `kernel.pipeIsWriteOpen()` → `await kernel.pipeIsWriteOpen()`
- `kernel.injectConnection()` → `await kernel.injectConnection()`
- `kernel.wakeBlockedReaders/Writers()` — fire-and-forget (no await)
- `handleHttpRequest()` is already async, just add `await`s

### 6. Make mysql-client.ts and redis-client.ts async

Same pattern — all pipe operations become awaited:
- `connect()` → `await kernel.injectConnection()`
- `sendPacket()` → `await kernel.pipeWrite()`
- `readBytes()` → `await kernel.pipeRead()` (already in setTimeout polling loop)

### 7. Update demo pages

Demo pages load programs into `kernel.fs` (MemoryFileSystem) before spawning. Most already do this for config files and data. For exec to work, executables must also be present in the filesystem at known paths (e.g., `/usr/bin/dash`, `/usr/bin/grep`).

`spawn()` can accept either `programPath` (read from FS) or `programBytes` (inline). Both work — inline bytes is a convenience for the initial process; exec always reads from FS.

## Key Design Decisions

1. **Kernel worker is fully autonomous**: Fork, exec, clone all happen in the kernel worker. No main thread round-trip for any process lifecycle operation. Sub-workers (process workers) are created directly by the kernel worker.

2. **Exec reads from the filesystem**: Like a real OS, `exec()` reads binaries from the shared `MemoryFileSystem`. Programs are loaded into the FS by the page before spawning. The kernel worker accesses the same SAB via `MemoryFileSystem.fromExisting()`. No program maps, no exec callbacks.

3. **MemoryFileSystem sharing**: Main thread creates SABs, keeps `MemoryFileSystem.create(sab)` for `kernel.fs`. Kernel worker creates `MemoryFileSystem.fromExisting(sab)`. SharedFS uses `Atomics.compareExchange` / `Atomics.wait` for concurrent access — designed for this.

4. **No polling in kernel worker**: `usePolling = false`, `Atomics.waitAsync` directly. The V8 microtask chain freeze bug is main-thread-only.

5. **Async pipe API on main thread**: All `BrowserKernel` pipe operations become `Promise`-returning. One MessagePort round-trip per call. For MySQL/Redis client polling at 20ms intervals, the sub-ms message latency is negligible.

## Verification

1. **Cargo tests**: `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` (unchanged)
2. **Vitest**: `cd host && npx vitest run` (host tests use Node.js, not browser)
3. **SDK tests**: `cd sdk && npm test` (unchanged)
4. **Browser demo testing** (manually verify each):
   - `cd examples/browser && npx vite --port 5198`
   - PHP CLI: run a script, check output
   - Shell: interactive commands, pipes, command substitution
   - Python: REPL + script
   - MariaDB: bootstrap + SQL queries — **main thread must stay responsive**
   - Redis: SET/GET commands
   - nginx: static page via service worker
   - nginx-php: PHP page via FastCGI
   - WordPress: full page load
5. **libc-test suite**: `scripts/run-libc-tests.sh` — 0 unexpected FAIL
6. **POSIX test suite**: `scripts/run-posix-tests.sh` — 0 FAIL
