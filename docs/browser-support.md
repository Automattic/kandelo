# Browser Support

## Overview

The wasm-posix-kernel runs in modern browsers with SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 16.4+). The centralized kernel architecture uses one kernel Wasm instance on the main thread, with each process running in a dedicated Web Worker.

## Required HTTP Headers

SharedArrayBuffer requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, `SharedArrayBuffer` is undefined and the kernel cannot initialize.

## Architecture

The browser uses `BrowserKernel` (`examples/browser/lib/browser-kernel.ts`) which wraps `CentralizedKernelWorker`. Key components:

| Component | Purpose |
|-----------|---------|
| `CentralizedKernelWorker` | Kernel instance on main thread, handles all syscalls |
| `BrowserKernel` | High-level wrapper with fork/exec/clone/exit handling |
| Web Workers | One per process, communicates via SharedArrayBuffer + Atomics |
| Service Worker | Intercepts HTTP for nginx/WordPress demos |
| `BrowserWorkerAdapter` | Creates Web Workers for process/thread spawning |

### Syscall Flow

```
Process Worker → SharedArrayBuffer channel → Atomics.notify
→ CentralizedKernelWorker.handleChannel() → kernel_handle_channel()
→ result written to channel → Atomics.notify → Process Worker resumes
```

## Capabilities

### Multi-Process
- `fork()` via Asyncify snapshot/restore — child runs in new Worker with copied memory
- `exec()` via `onExec` callback — resolves paths to Wasm binaries, replaces process
- `posix_spawn()` — fork+exec with file actions (addchdir, addfchdir, addclose, adddup2)
- Process groups, wait/waitpid, cross-process signals, pipes

### Threads
- `clone()` with `CLONE_VM|CLONE_THREAD` — shared Memory between parent and thread Workers
- Used by MariaDB (5 threads), Redis (3 background threads)

### Networking
- TCP via `FetchBackend` (browser fetch API mapped to kernel sockets)
- Service worker cookie jar for session persistence (WordPress)
- nginx serves static files and proxies to PHP-FPM via Unix domain sockets

### Filesystem
- `MemoryFileSystem` — in-memory VFS for all demos
- `OpfsFileSystem` — Origin Private File System for browser persistence
- `SharedFS` — SharedArrayBuffer-based FS shared between workers

### Terminal
- PTY support with full line discipline (PR #181)
- Interactive stdin via `appendStdinData` for incremental input

## Browser Demos

Located in `examples/browser/pages/`:

| Demo | Software | Features |
|------|----------|----------|
| simple | C programs | Basic file I/O, printf |
| shell | dash + coreutils | Interactive shell with exec, pipes, PATH lookup |
| python | CPython 3.13 | REPL + script runner |
| php | PHP CLI | Script execution |
| nginx | nginx | Static file serving |
| nginx-php | nginx + PHP-FPM | FastCGI, fork workers |
| mariadb | MariaDB 10.5 | SQL database with threads |
| redis | Redis 7.2 | In-memory store with threads |
| wordpress | nginx + PHP-FPM + WP | Full LAMP stack |

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

### nanosleep() blocks the thread
`nanosleep()` uses `Atomics.wait()` which blocks the calling thread. On the main thread, this freezes the UI. Process Workers are unaffected since they run in dedicated Web Workers.

### No raw server sockets
Browser sandbox prevents listening on ports. nginx/PHP-FPM demos use a service worker to intercept HTTP requests and inject them as kernel TCP connections.

### Main thread kernel
The kernel runs on the main thread (not a Worker) because it needs synchronous access to all process memories. Long-running kernel operations can briefly block the UI.
