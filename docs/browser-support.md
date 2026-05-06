# Browser Support

## Overview

Kandelo runs in modern browsers with SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 16.4+). The centralized kernel architecture uses one kernel Wasm instance in a dedicated web worker, with each process running in a sub-worker.

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
├── Page API (boot, stdin, TCP)          ├── MemoryFileSystem (kernel-owned)
├── PTY terminal ──pty events──>         ├── Kernel Wasm instance
├── HTTP bridge / TCP injection          ├── Syscall dispatch (Atomics.waitAsync)
├── App clients (MySQL, Redis)           ├── Process lifecycle (fork/exec/clone/exit)
│   └── async pipe ops ────────────────> ├── Process sub-worker creation
│                                        ├── Connection pump (HTTP↔TCP bridge)
│                                        ├── Exec reads binaries from VFS
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
- **Kernel-owned VFS** (preferred path, `kernelOwnedFs: true` + `kernel.boot()`): the kernel worker restores a pre-built VFS image and exec()s `argv[0]` as the first process. The main thread never instantiates a `MemoryFileSystem` and is not in the FS hot path. Service-supervised demos run dinit (PID 1) inside this image; single-program demos exec the language interpreter directly.
- **Legacy shared VFS** (`memfs:` constructor option + `kernel.spawn()`): main thread holds a `MemoryFileSystem` and shares the SAB with the kernel worker. Used by demos that fetch transient binaries at runtime (test runners, REPLs that load arbitrary user code, benchmark suites). Kept in place until the kernel grows a "spawn-into-running-kernel" path that doesn't need a main-thread pid.
- **Exec reads from filesystem**: Like a real OS, `exec()` reads binaries from the kernel-side `MemoryFileSystem`. Programs are baked into the VFS image at build time (or written by the page in the legacy path before spawning). Symlinks are used for multicall binaries (e.g., coreutils).
- **dinit (PID 1) for service supervision**: Multi-process demos (nginx, redis, mariadb, nginx-php, wordpress, lamp, mariadb-test) bake `/sbin/dinit` and per-service files under `/etc/dinit.d/` into the VFS image via `addDinitInit()` (`examples/browser/scripts/dinit-image-helpers.ts`). dinit handles SIGCHLD reaping, `depends-on` ordering, and bootstrap-then-daemon chains. Page code waits for service-ready via `onListenTcp` (port-bind) callbacks, then starts driving the demo over kernel-loopback TCP or the HTTP bridge.
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

### Framebuffer (`/dev/fb0`)
- 640×400 BGRA32 packed-pixel framebuffer; single-process owner.
- The pixel buffer lives in the process's `WebAssembly.Memory` (a `SharedArrayBuffer`); the kernel notifies the host of `(pid, addr, len, w, h, stride, fmt)` on `mmap`, and the host renders via `requestAnimationFrame` + a 2D-canvas `putImageData` per frame.
- `host/src/framebuffer/canvas-renderer.ts::attachCanvas(canvas, registry, pid, opts)` is the consumer-side renderer.
- Keyboard input: the demo page maps browser `KeyboardEvent.code` to AT-set-1 scancodes and feeds them through `appendStdinData(pid, …)`; fbDOOM-style software (which puts the tty into MEDIUMRAW mode) decodes those bytes as scancodes.
- Limitations: no audio (`/dev/dsp`); no mouse; `fork` does not auto-bind the child; multi-buffering / vsync via `FBIOPAN_DISPLAY` is a no-op.

## Browser Demos

Located in `examples/browser/pages/`:

| Demo | Software | Boot pattern | Features |
|------|----------|--------------|----------|
| simple | C programs | legacy spawn | Basic file I/O, printf |
| shell | dash + coreutils | legacy spawn | Interactive shell with exec, pipes, PATH lookup |
| python | CPython 3.13 | `kernel.boot` | REPL + script runner |
| perl | Perl 5.40 | `kernel.boot` | REPL + script runner |
| php | PHP CLI | `kernel.boot` | Script execution |
| ruby | Ruby 3.3 | `kernel.boot` | REPL + script runner |
| erlang | OTP 28 BEAM | legacy spawn | Erlang VM, message passing |
| nginx | nginx | dinit | Static file serving via service worker |
| nginx-php | nginx + PHP-FPM | dinit | FastCGI, fork workers |
| mariadb | MariaDB 10.5 | dinit | SQL database with threads (Aria/InnoDB) |
| redis | Redis 7.2 | dinit | In-memory store with threads |
| wordpress | nginx + PHP-FPM + WP | dinit | Full stack with SQLite |
| lamp | MariaDB + nginx + PHP-FPM + WP | dinit | Full LAMP stack |
| mariadb-test | MariaDB + mysqltest | dinit + spawn | Playwright-driven mysql-test runner |
| benchmark | (per-suite) | legacy spawn | Micro-benchmarks + WordPress + Erlang ring |
| doom | fbDOOM | legacy spawn | `/dev/fb0` framebuffer + canvas renderer + keyboard via stdin |

The "Boot pattern" column reflects how the demo enters the kernel:
- **`kernel.boot`** — `kernelOwnedFs: true`, exec the language interpreter as the first process.
- **dinit** — `kernelOwnedFs: true`, exec dinit (PID 1), which brings up the per-demo service tree.
- **dinit + spawn** — dinit boots the supervised services; the page spawns transient binaries (e.g. mysqltest) via `kernel.spawn()`.
- **legacy spawn** — main thread restores a `MemoryFileSystem`, page calls `kernel.spawn(programBytes, argv)` for each binary.

Run demos: `cd examples/browser && npx vite --port 5198`

## VFS Images

Browser demos use pre-built **VFS images** — binary snapshots of a `MemoryFileSystem` containing all runtime files, directory structure, configs, and symlinks needed by a demo. At runtime, restoring a VFS image is a single buffer copy, replacing what would otherwise be hundreds or thousands of individual file creation operations.

### How it works

1. **Build time**: A TypeScript build script creates a `MemoryFileSystem`, writes files/dirs/symlinks into it, and calls `saveImage()` to produce a `.vfs` binary file.
2. **Runtime**: The demo page fetches the `.vfs` file, calls `MemoryFileSystem.fromImage(imageBytes, { maxByteLength })` to restore it, and passes the resulting filesystem to `BrowserKernel({ memfs })`.

```typescript
// Typical demo pattern
const [kernelBuf, vfsImageBuf] = await Promise.all([
  fetch(kernelUrl).then(r => r.arrayBuffer()),
  fetch(vfsImageUrl).then(r => r.arrayBuffer()),
]);

const memfs = MemoryFileSystem.fromImage(
  new Uint8Array(vfsImageBuf),
  { maxByteLength: 512 * 1024 * 1024 },
);

const kernel = await BrowserKernel.create({ kernelWasm: kernelBuf, memfs });
```

### VFS images per demo

| Demo | Image | Build command | What's inside |
|------|-------|--------------|---------------|
| Python | `python.vfs` | `bash examples/browser/scripts/build-python-vfs-image.sh` | CPython stdlib |
| Erlang | `erlang.vfs` | `bash examples/browser/scripts/build-erlang-vfs-image.sh` | OTP runtime |
| Perl | `perl.vfs` | `bash examples/browser/scripts/build-perl-vfs-image.sh` | Perl stdlib |
| Shell | `shell.vfs` | `bash examples/browser/scripts/build-shell-vfs-image.sh` | dash, symlinks, vim runtime |
| WordPress | `wordpress.vfs` | `bash examples/browser/scripts/build-wp-vfs-image.sh` | WP files, nginx/PHP configs |
| LAMP | `lamp.vfs` | `bash examples/browser/scripts/build-lamp-vfs-image.sh` | MariaDB + WP + configs |
| MariaDB test | `mariadb-test.vfs` | `bash examples/browser/scripts/build-mariadb-test-vfs-image.sh` | MariaDB + test suite |

VFS images are `.gitignore`d and must be built locally. The `run.sh` script handles this automatically (e.g., `./run.sh browser` builds any missing VFS images before starting the dev server).

### Building VFS images

Each build script requires the corresponding software to be compiled first (e.g., `build-cpython.sh` before `build-python-vfs-image.sh`). The `run.sh` script orchestrates this:

```bash
./run.sh build python-vfs    # Build Python VFS image
./run.sh build shell-vfs     # Build Shell VFS image
./run.sh build all            # Build everything including all VFS images
```

### Adding a new VFS image

1. Create `examples/browser/scripts/build-<name>-vfs-image.ts` — import helpers from `vfs-image-helpers.ts`
2. Create `examples/browser/scripts/build-<name>-vfs-image.sh` — shell wrapper that runs the TypeScript script
3. Update the demo's `main.ts` to fetch the `.vfs` file and use `MemoryFileSystem.fromImage()`
4. Add a build target in `run.sh`

The shared helpers in `vfs-image-helpers.ts` provide:
- `writeVfsFile(fs, path, content)` / `writeVfsBinary(fs, path, data)` — write files
- `ensureDirRecursive(fs, path)` — create directory trees
- `symlink(fs, target, path)` — create symlinks
- `walkAndWrite(fs, hostDir, mountPrefix, opts?)` — recursively walk a host directory into the VFS
- `saveImage(fs, outFile)` — save and write the image to disk

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
