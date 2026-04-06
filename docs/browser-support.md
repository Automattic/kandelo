# Browser Support

## Overview

The wasm-posix-kernel runs in modern browsers with SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 16.4+). The centralized kernel architecture uses one kernel Wasm instance in a dedicated web worker, with each process running in a sub-worker.

## Required HTTP Headers

SharedArrayBuffer requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, `SharedArrayBuffer` is undefined and the kernel cannot initialize.

## Architecture

The kernel runs in a dedicated web worker, freeing the main thread for UI rendering and coordination only. The main thread uses `BrowserKernel` as a thin proxy that communicates with the kernel worker via `postMessage`.

```
Main Thread (BrowserKernel)              Kernel Worker
├── UI / rendering                       ├── CentralizedKernelWorker
├── MemoryFileSystem (shared SAB)        ├── Kernel Wasm instance
├── Page API (spawn, stdin, fs)          ├── VirtualPlatformIO (shared SAB)
├── PTY terminal ──pty events──>         ├── Syscall dispatch (Atomics.waitAsync)
├── App clients (MySQL, Redis)           ├── Process lifecycle (fork/exec/clone/exit)
│   └── async pipe ops ────────────────> ├── Process sub-worker creation
│                                        ├── Connection pump (HTTP↔TCP bridge)
│                                        ├── Exec reads binaries from shared FS
└──── MessagePort (RPC) ───────────────> └── Blocking retry management
                                                    │
Service Worker ──MessagePort──> Kernel Worker       │
                                                    │
                                   Process Workers ──┘ (SharedArrayBuffer channels)
```

| Component | Location | Purpose |
|-----------|----------|---------|
| `BrowserKernel` | Main thread | Thin proxy — sends messages to kernel worker |
| `kernel-worker-entry.ts` | Kernel worker | Hosts CentralizedKernelWorker, process lifecycle |
| `CentralizedKernelWorker` | Kernel worker | Kernel instance, handles all syscalls |
| Process Workers | Sub-workers of kernel worker | One per process, communicates via SharedArrayBuffer + Atomics |
| Service Worker | Separate | Intercepts HTTP for nginx/WordPress demos |
| Connection pump | Kernel worker | Bridges HTTP requests to kernel TCP pipes |

### Key Design Decisions

- **Kernel in dedicated worker**: Enables `Atomics.waitAsync` without V8 microtask chain freeze bug (main-thread-only). No need for MessageChannel-based polling. Zero UI jank regardless of syscall load.
- **Shared MemoryFileSystem**: Main thread and kernel worker share the same `SharedArrayBuffer`-backed filesystem via `MemoryFileSystem.fromExisting()`. The main thread writes files (configs, bundles), the kernel worker reads them (exec binaries).
- **Exec reads from filesystem**: Like a real OS, `exec()` reads binaries from the shared filesystem. Programs are loaded into the FS by the page before spawning. Symlinks are used for multicall binaries (e.g., coreutils).
- **Connection pump in kernel worker**: HTTP↔TCP bridge runs inside the kernel worker with synchronous pipe I/O (direct Wasm export calls). Service worker transfers a MessagePort to the kernel worker for HTTP request delivery.
- **App clients on main thread**: MySQL and Redis wire protocol clients stay on the main thread and use async pipe operations via the message protocol.

### Syscall Flow

```
Process Worker → SharedArrayBuffer channel → Atomics.notify
→ CentralizedKernelWorker.handleChannel() → kernel_handle_channel()
→ result written to channel → Atomics.notify → Process Worker resumes
```

### HTTP Request Flow (nginx/WordPress demos)

```
Browser fetch → Service Worker intercepts
→ MessagePort → Kernel Worker (connection pump)
→ kernel_inject_connection() → pipe write (raw HTTP)
→ nginx (Wasm) accepts, processes → pipe read (response)
→ MessagePort → Service Worker → browser Response
```

## Capabilities

### Multi-Process
- `fork()` via Asyncify snapshot/restore — child runs in new sub-worker with copied memory
- `exec()` reads program binary from the shared filesystem, replaces process
- `posix_spawn()` — fork+exec with file actions (addchdir, addfchdir, addclose, adddup2)
- Process groups, wait/waitpid, cross-process signals, pipes

### Threads
- `clone()` with `CLONE_VM|CLONE_THREAD` — shared Memory between parent and thread Workers
- Used by MariaDB (5 threads), Redis (3 background threads)

### Networking
- TCP via kernel pipe-backed connections
- Service worker cookie jar for session persistence (WordPress)
- nginx serves static files and proxies to PHP-FPM via loopback TCP

### Filesystem
- `MemoryFileSystem` — SharedArrayBuffer-based VFS shared between main thread and kernel worker
- `OpfsFileSystem` — Origin Private File System for browser persistence
- `DeviceFileSystem` — `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/ptmx`

### Terminal
- PTY support with full line discipline
- Interactive stdin via `appendStdinData` for incremental input
- xterm.js integration via `PtyTerminal`

## Browser Demos

Located in `examples/browser/pages/`:

| Demo | Software | Features |
|------|----------|----------|
| simple | C programs | Basic file I/O, printf |
| shell | dash + coreutils | Interactive shell with exec, pipes, PATH lookup |
| python | CPython 3.13 | REPL + script runner |
| php | PHP CLI | Script execution |
| nginx | nginx | Static file serving via service worker |
| nginx-php | nginx + PHP-FPM | FastCGI, fork workers |
| mariadb | MariaDB 10.5 | SQL database with threads |
| redis | Redis 7.2 | In-memory store with threads |
| wordpress | nginx + PHP-FPM + WP | Full stack with SQLite |
| lamp | MariaDB + nginx + PHP-FPM + WP | Full LAMP stack |

Run demos: `cd examples/browser && npx vite --port 5198`

## Vite Configuration

```typescript
// vite.config.ts
export default {
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
};
```

## Known Limitations

### SharedArrayBuffer restrictions
Chrome rejects SharedArrayBuffer-backed views in `TextDecoder.decode()` and `crypto.getRandomValues()`. Always copy to a temporary non-shared buffer first.

### No raw server sockets
Browser sandbox prevents listening on ports. nginx/PHP-FPM demos use a service worker to intercept HTTP requests and inject them as kernel TCP connections via the connection pump.

### Memory per process
Each process gets `WebAssembly.Memory(shared: true, initial: maxPages, max: maxPages)`. Shared memory reserves the full virtual address space at construction time, so `maxMemoryPages` should be tuned for multi-process demos (e.g., 4096 pages = 256MB for WordPress with 5+ processes).
