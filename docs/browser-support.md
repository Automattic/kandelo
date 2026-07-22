# Browser Support

> **Contributor note — dual-host parity is load-bearing.** The browser host is a peer of the Node.js host, not a follower. Any change touching host-runtime behavior MUST land symmetrically on both hosts, **in the same PR**. See [`CLAUDE.md`](../CLAUDE.md#two-hosts-browser-and-nodejs--dual-host-parity-is-load-bearing) for the hard requirements. PR #388 (brk-base) and PR #410 (worker exit message) both shipped one-sided fixes that left browser behavior broken for users; those are the failure modes this rule exists to prevent.

## Overview

Kandelo runs in modern browsers with SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 16.4+). The shared-kernel architecture uses one kernel Wasm instance in a dedicated web worker, with each process running in a sub-worker.

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
├── Page API (boot, stdin, network)      ├── MemoryFileSystem (kernel-owned)
├── PTY terminal ──pty events──>         ├── Kernel Wasm instance
├── HTTP bridge / TCP injection          ├── Syscall dispatch (Atomics.waitAsync)
├── Local virtual network                ├── POSIX socket routing
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
| `BrowserKernel` | `host/src/browser-kernel-host.ts` | Main-thread proxy that sends messages to the browser kernel worker |
| Browser kernel worker entry | `host/src/browser-kernel-worker-entry.ts` | Hosts CentralizedKernelWorker and owns process lifecycle |
| `CentralizedKernelWorker` | Kernel worker | Kernel instance, handles all syscalls |
| Process Workers | Sub-workers of kernel worker | One per process, communicates via SharedArrayBuffer + Atomics |
| Service Worker | `apps/browser-demos/public/service-worker.js` | Intercepts HTTP for nginx/WordPress demos |
| Connection pump | `host/src/browser-kernel-worker-entry.ts` | Bridges HTTP requests to kernel TCP pipes |

### Key Design Decisions

- **Kernel in dedicated worker**: Browser syscall notification remains event-driven through `Atomics.waitAsync`; it does not poll channels. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue, allowing syscall handling and worker messages to keep progressing together under multi-process bridge load. Node.js keeps its native/default batching unchanged.
- **Kernel-owned VFS** (preferred path, `kernelOwnedFs: true` + `kernel.boot()`): the kernel worker restores a pre-built VFS image and exec()s `argv[0]` as the first process. The main thread never instantiates a `MemoryFileSystem` and is not in the FS hot path. Service-supervised demos run dinit (PID 1) inside this image; single-program demos exec the language interpreter directly.
  Browser harnesses that must stage a transient file between process spawns use
  `BrowserKernel`'s worker RPC methods (`readFileSnapshotFromVfs`,
  `writeFileToVfs`, and `unlinkFileFromVfs`). The owning worker performs those
  mutations through the mounted VFS; the main thread never receives the live
  VFS `SharedArrayBuffer`.
- **Legacy shared VFS** (`memfs:` constructor option + `kernel.spawn()`): main thread holds a `MemoryFileSystem` and shares the SAB with the kernel worker. Used by demos that fetch transient binaries at runtime (test runners, REPLs that load arbitrary user code, benchmark suites). The main thread transfers each program's bytes, but the kernel worker allocates and returns its pid so top-level spawns and guest forks share one authoritative sequence.
- **Exec reads from filesystem**: Like a real OS, `exec()` reads binaries from the kernel-side `MemoryFileSystem`. Programs are baked into the VFS image at build time (or written by the page in the legacy path before spawning). Symlinks are used for multicall binaries (e.g., coreutils).
- **dinit (PID 1) for service supervision**: Multi-process demos (nginx, redis, mariadb, nginx-php, wordpress, lamp, mariadb-test) bake `/sbin/dinit` and per-service files under `/etc/dinit.d/` into the VFS image via `addDinitInit()` (`images/vfs/scripts/dinit-image-helpers.ts`). dinit handles SIGCHLD reaping, `depends-on` ordering, and bootstrap-then-daemon chains. Page code waits for service-ready via `onListenTcp` (port-bind) callbacks, then starts driving the demo over kernel-loopback TCP or the HTTP bridge.
- **Connection pump in kernel worker**: HTTP↔TCP bridge runs inside the kernel worker with synchronous pipe I/O (direct Wasm export calls). Service worker transfers a MessagePort to the kernel worker for HTTP request delivery.
- **App clients on main thread**: MySQL and Redis wire protocol clients stay on the main thread and use async pipe operations via the message protocol.
- **Rust-owned advisory locks**: the browser host does not hold advisory-lock
  records in a `SharedArrayBuffer` or inspect their ranges. The machine-wide
  Rust `ProcessTable` manager is authoritative. When a blocking `F_SETLKW`
  conflicts, the browser worker parks that syscall channel; a Rust advisory-lock
  wake event reschedules parked lock requests after unlock, conversion, close,
  or process teardown. `ENOLCK` completes immediately, and the short retry
  timer is only a scheduling safety net. Descriptors queued through
  `SCM_RIGHTS` retain their Rust `OfdId`, `FileId`, and backing reference, so
  sender close, successful receipt, discard, and receiver-allocation failure
  all use the same final-reference rule without host-side lock inspection.

### ABI 40 host-package migration

ABI 40 removes the kernel's `host_fcntl_lock` import and removes the public
`wasm-posix-host` exports `SharedLockTable` and `LockInfo`, along with
`WasmPosixKernel.registerSharedLockTable()`. This is an intentional breaking
host-package API change, not a deprecation shim. Embedders must stop importing,
constructing, registering, or crash-resetting a shared lock table. The guest
`fcntl`, OFD-lock, and `flock` APIs remain available; all lock state, ownership,
range operations, and the 4096-normalized-record policy now live in the kernel
Wasm.

The host `StatResult.dev` and `StatResult.ino` fields now accept
`number | bigint`, and Node-backed adapters return `bigint` so device and inode
identities cannot lose precision. Embedders that serialize these values or use
number-only arithmetic must handle `bigint` explicitly. The kernel marshalling
contract remains exact unsigned 64-bit values.

### Syscall Flow

```
Process Worker → SharedArrayBuffer channel → Atomics.notify
→ CentralizedKernelWorker.handleChannel() → kernel_handle_channel()
→ result written to channel → Atomics.notify → Process Worker resumes
```

### HTTP Request Flow (nginx/WordPress demos)

```
Browser fetch → Service Worker intercepts
→ MessagePort → BrowserKernel.fetchInKernel() → Kernel Worker
→ kernel_inject_connection() → pipe write (raw HTTP)
→ nginx (Wasm) accepts, processes → pipe read (response)
→ MessagePort → Service Worker → browser Response
```

Injected TCP pipes live in the kernel's global pipe table (`pid == 0` for
`kernel_pipe_*` host calls), so a listener inherited across fork can accept the
connection in any nginx worker. The standalone nginx image runs with
`master_process on` and `worker_processes 2`.

AF_UNIX stream listeners use the same shared-queue ownership model. This is the
path used by pre-fork PHP-FPM workers: a connection is queued once and whichever
worker wins `accept()` materializes its own connected socket around the global
pipe pair.

## Capabilities

### Multi-Process
- `fork()` via `wasm-fork-instrument` snapshot/restore — child runs in new sub-worker with copied memory
- `exec()` reads program binary from the shared filesystem, replaces process
- `posix_spawn()` — non-forking child creation with file actions (addchdir, addfchdir, addclose, adddup2)
- Process groups, wait/waitpid, cross-process signals, pipes

### Threads
- `clone()` with `CLONE_VM|CLONE_THREAD` — shared Memory between parent and thread Workers
- Used by MariaDB (5 threads), Redis (3 background threads)

### Networking
- POSIX AF_INET TCP and UDP inside the kernel, including local loopback and virtual IPv4 machine-to-machine networking
- Partial AF_INET6 streams and datagrams for `::`/`::1`; loopback streams have a cross-process path, while datagrams remain process-local, and neither provides external or virtual-network IPv6
- In-kernel IPv4/IPv6 loopback datagrams, AF_UNIX datagrams, and IPv4 multicast are process-local; machine-wide datagram routing is still pending
- `LocalVirtualNetwork` attaches multiple browser Kandelo machines to virtual IPv4 addresses in one browser session
- Browser networking backends preserve valid decimal one-, two-, three-, and four-component IPv4 forms, reject malformed/overflowing numeric forms, enforce ASCII host-label syntax and DNS length limits, and synthesize IPv4 addresses only for acceptable hostnames; they do not provide AF_INET6 DNS/transport
- GNU Netcat (`nc`) and `curl` run against those virtual sockets in the network lab at `/pages/network/`
- Service worker cookie jar for session persistence (WordPress)
- nginx serves static files and proxies to PHP-FPM via loopback TCP

### Filesystem
- `MemoryFileSystem` — SharedArrayBuffer-based VFS shared between main thread and kernel worker
- `OpfsFileSystem` — Origin Private File System for browser persistence. Its
  worker assigns session-scoped inode tokens to regular files and uses
  `FileSystemHandle.isSameEntry()` to unify simultaneous opens. Tokens remain
  stable for live handles across supported rename and unlink; unlink followed
  by recreation is a different identity. Device and inode cross the OPFS
  channel as exact unsigned 64-bit integers. A browser that lacks the required
  identity or move primitive reports the unsupported boundary rather than
  substituting a pathname identity. The OPFS proxy owns namespace mutation for
  its origin during a session and sweeps its hidden unlink-while-open orphan
  directory at startup; running multiple independent proxy workers against the
  same origin concurrently is not a supported coherence model. Regular-file
  `fsync()` calls the browser's file-handle `flush()` operation. Directory
  `fsync()` succeeds after already-completed directory operations because the
  File System API exposes no directory flush primitive; it is not an
  additional crash-durability barrier.
- `DeviceFileSystem` — `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/ptmx`
- Stable-identity regular files, including OPFS regular files on supported
  browsers, can be shared across process memories through the host mapping
  cache, but updates become visible at syscall boundaries rather than
  immediately on direct loads/stores. Cross-process futex waits/wakes remain
  unsupported; see [architecture.md](architecture.md#shared-mapping-coherence).
- Advisory locking uses `host_fstat` on the live open handle and the same
  backend-qualified identity. If a filesystem backend cannot provide a stable,
  exact identity, locking fails truthfully with `ENOLCK`; it never falls back
  to hashing the remembered path.

### Terminal
- PTY support with full line discipline
- Interactive stdin via `appendStdinData` for incremental input
- xterm.js integration via `PtyTerminal`

### Framebuffer (`/dev/fb0`)
- 640×400 BGRA32 packed-pixel framebuffer; exclusive process owner.
- The pixel buffer lives in the process's `WebAssembly.Memory` (a `SharedArrayBuffer`); the kernel notifies the host of `(pid, addr, len, w, h, stride, fmt)` on `mmap`, and the host renders via `requestAnimationFrame` + a 2D-canvas `putImageData` per frame.
- `host/src/framebuffer/canvas-renderer.ts::attachCanvas(canvas, registry, pid, opts)` is the consumer-side renderer.
- Keyboard input: the demo page maps focused browser `KeyboardEvent` values to Linux input keycodes, encodes them as MEDIUMRAW bytes, and feeds them through `appendStdinData(pid, …)`; fbDOOM-style software decodes those bytes from the tty. Ctrl+Shift+Esc is reserved as the host escape from keyboard capture.
- Limitations: `fork` does not auto-bind the child; multi-buffering / vsync via `FBIOPAN_DISPLAY` is a no-op.

### Mouse input (`/dev/input/mice`)
- Demo pages attach `mousemove` / `mousedown` / `mouseup` listeners to the canvas and call `BrowserKernel.injectMouseEvent(dx, dy, buttons)`. The main thread posts a `mouse_inject` message to the kernel worker, which calls the kernel's `kernel_inject_mouse_event` export. The kernel encodes a 3-byte PS/2 frame and queues it on a global ring; user processes drain the queue via `read("/dev/input/mice", …)`.
- **Pointer Lock recommended.** The DOOM demo calls `canvas.requestPointerLock()` on first click so the browser delivers unbounded relative motion (`MouseEvent.movementX/Y`). Without pointer lock, `clientX/Y` deltas clamp at the canvas edges and feel sluggish for first-person controls. Press `Esc` to release the lock.
- Browser `deltaY` is positive-down; the demo inverts it before injection so the kernel queue holds canonical PS/2 (positive-up) deltas.
- Browser `MouseEvent.button` (0=L, 1=M, 2=R) is mapped to PS/2 button bits (bit0=L, bit1=R, bit2=M). Right-click suppresses the browser context menu via `contextmenu` `preventDefault()`.
- Single-owner device (one process can hold `/dev/input/mice` open at a time; second open from another pid returns `EBUSY`).

### Audio output (`/dev/dsp`)
- The kernel exposes an OSS-style `/dev/dsp` character device. User programs `open(O_WRONLY)`, configure rate / channels / format via `SNDCTL_DSP_*` ioctls, and `write()` interleaved 16-bit-LE PCM. The kernel buffers samples in a 256 KiB ring (~1.5 s of stereo S16 @ 44.1 kHz). On overflow the *oldest* whole frame drops — same trade-off real OSS hardware makes under hardware overrun.
- Demo pages drive a `setInterval` loop (~50 ms cadence) that calls `BrowserKernel.drainAudio(maxBytes)`. The kernel-worker drains the ring via the `kernel_drain_audio` wasm export (which respects whole-frame boundaries so stereo L/R never tear) and posts the bytes back. Main thread converts S16 → Float32, builds an `AudioBuffer`, and schedules an `AudioBufferSourceNode` on the `AudioContext` clock with a small lookahead so brief drain hiccups don't underrun.
- Single-owner device. A non-CLOEXEC fd retains ownership and queued samples across `execve`; last close or process exit releases the owner and flushes the ring so a successor starts from silence. Format must be `AFMT_S16_LE`; other formats are `EINVAL`.
- **AudioContext gesture requirement.** `new AudioContext()` starts suspended in modern browsers and only resumes after a user gesture. The DOOM demo creates the context immediately after the user's "Start" click (which is itself a gesture), so `audioCtx.resume()` succeeds without a separate prompt.

## Browser Demos

Located in `apps/browser-demos/pages/`:

| Demo | Software | Boot pattern | Features |
|------|----------|--------------|----------|
| simple | C programs | legacy spawn | Basic file I/O, printf |
| shell | dash + coreutils | legacy spawn | Interactive shell with exec, pipes, PATH lookup |
| python | CPython 3.13 | `kernel.boot` | REPL + script runner |
| perl | Perl 5.40 | `kernel.boot` | REPL + script runner |
| php | PHP CLI | `kernel.boot` | Script execution |
| ruby | Ruby 3.3 | `kernel.boot` | REPL + script runner |
| node | SpiderMonkey-backed Node-compatible runtime + npm 10.9.2 | `kernel.boot` | xterm REPL; `npm install` reaches the real registry via the host fetch |
| erlang | OTP 28 BEAM | legacy spawn | Erlang VM, message passing |
| nginx | nginx | dinit | Static file serving via service worker |
| nginx-php | nginx + PHP-FPM | dinit | FastCGI, fork workers |
| mariadb | MariaDB 10.5 | dinit | SQL database with threads (Aria/InnoDB) |
| redis | Redis 7.2 | dinit | In-memory store with threads |
| wordpress | nginx + PHP-FPM + WP | dinit | Full stack with SQLite |
| lamp | MariaDB + nginx + PHP-FPM + WP | dinit | Full LAMP stack |
| mariadb-test | MariaDB + mysqltest | dinit + spawn | Playwright-driven mysql-test runner |
| benchmark | (per-suite) | legacy spawn | Micro-benchmarks + WordPress + Erlang ring |
| network | dash + GNU Netcat + curl | `kernel.boot` x 3 | Boots multiple local Kandelo machines and verifies UDP datagrams, TCP streams, and HTTP over virtual TCP |
| doom | fbDOOM | legacy spawn | `/dev/fb0` framebuffer + canvas renderer + keyboard via stdin + mouse via `/dev/input/mice` (pointer-locked) + SFX **and** OPL2-synthesized music via `/dev/dsp` → AudioContext. The shareware `doom1.wad` is **fetched at page load** from a commit-pinned CDN URL (SHA-256 verified, Cache API cached); no IWAD ships in the package archive. |

The "Boot pattern" column reflects how the demo enters the kernel:
- **`kernel.boot`** — `kernelOwnedFs: true`, exec the language interpreter as the first process.
- **dinit** — `kernelOwnedFs: true`, exec dinit (PID 1), which brings up the per-demo service tree.
- **dinit + spawn** — dinit boots the supervised services; the page spawns transient binaries (e.g. mysqltest) via `kernel.spawn()`.
- **legacy spawn** — main thread restores a `MemoryFileSystem`, page calls `kernel.spawn(programBytes, argv)` for each binary, and the kernel worker allocates the pid.

Run the browser app: `cd apps/browser-demos && npm run dev`, then open
`http://127.0.0.1:5401/`.

### Kandelo session UI

The Kandelo app at `/pages/kandelo/` keeps the running machine as the primary
browser canvas and exposes related tools through a bottom dock. Dock controls
switch between Demo, Terminal, and Internals views, while dock panes open for
new-machine setup, gallery browsing, system config, and sharing. These controls
consume `KernelHost` state and actions rather than replacing the runtime path.

The dock may be collapsed or moved horizontally within the browser viewport;
that placement is UI-only presentation state and does not alter the running
machine, boot descriptor, VFS image, or share/export data.

Image-declared demo guides from `/etc/kandelo/demo.json` remain part of the
machine presentation owned by the demo image. Guide actions may run terminal or
web actions through `KernelHost`, but they do not replace process supervision,
VFS state, networking, or runtime behavior.

Lazy VFS diagnostics have two intentionally different `KernelHost` views.
`lazyDownloadHistory()` is a 512-event chronological ring for recent transport
detail. `lazyDownloadSummaries()` is the complete attached-kernel-lifecycle
ledger: it retains one latest record per distinct asset, including its
first/start/update times and complete raw-event count. Its size grows with the
number of distinct assets retrieved during that kernel lifecycle; it has no
fixed asset cap. `subscribeLazyDownloadSummaries()` reports both event updates
and lifecycle resets. The Lazy Load inspector and acceptance tests use the
summary ledger, so response chunk volume cannot erase evidence that an earlier
bottle completed. Both views reset when the kernel is replaced; neither is
persisted as a machine snapshot.

Cross-origin browser fetches are routed through `public/service-worker.js`,
which defaults to `https://wordpress-playground-cors-proxy.net/?`. Override it
with `VITE_CORS_PROXY_URL` when testing another proxy:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

Proxy prefixes ending in a bare `?` receive raw target URLs; `?url=`-style
prefixes receive percent-encoded targets.

### Blob-URL iframes (service-worker boundary)

The service worker can only bridge requests from documents it **controls**. A
`blob:` document is not service-worker-controlled (and has no base URL), so its
subresource requests bypass the bridge and hit the static origin instead of the
in-kernel server. This is a real browser boundary, not a Kandelo bug.

It surfaces in the WordPress block/site editor, whose canvas iframe is mounted
from `URL.createObjectURL(new Blob([html]))`: the canvas's
`load-scripts.php`/`load-styles.php` and block-asset requests would 404 against
the origin even though nginx serves them correctly over the bridge.

`public/blob-iframe-interceptor.js` is a reusable, framework-free DOM patch that
neutralizes this class of issue. It hooks `Blob`/`URL.createObjectURL` and the
`HTMLIFrameElement` `src` setter/`setAttribute` so that any iframe pointed at a
`text/html` blob URL is instead rendered from `srcdoc` (an `about:srcdoc`
document, which the service worker *does* control). It is idempotent and a no-op
unless a text/html blob URL is used as an iframe src. The service worker inlines
it (via the `"__BLOB_IFRAME_INTERCEPTOR__"` build-time placeholder, mirroring
`"__CORS_PROXY_URL__"`) into the `<head>` of every bridged HTML document, so it
applies to all app demos, not just WordPress.

## VFS Images

Browser demos use pre-built **VFS images** — binary snapshots of a `MemoryFileSystem` containing all runtime files, directory structure, configs, and symlinks needed by a demo. At runtime, restoring a VFS image is a single buffer copy, replacing what would otherwise be hundreds or thousands of individual file creation operations.

### How it works

1. **Build time**: A TypeScript build script creates a `MemoryFileSystem`, writes files/dirs/symlinks into it, and calls `saveImage()` to produce a zstd-compressed `.vfs.zst` file. Empty regions of the SharedFS allocator compress to nearly nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1–3 MB download. If the image should grow or report a larger `df` capacity at runtime, build it with `MemoryFileSystem.create(sab, permittedMaxBytes)` so the filesystem metadata is sized for that capacity.
2. **Runtime**: The demo page fetches the `.vfs.zst` file, calls `MemoryFileSystem.fromImage(imageBytes, { maxByteLength })` (which auto-detects zstd magic and decompresses transparently), and passes the resulting filesystem to `BrowserKernel({ memfs })`. `maxByteLength` makes the restored `SharedArrayBuffer` growable; it does not raise the filesystem maximum beyond the image's superblock limit.

The canonical Homebrew shell has a 512 MiB filesystem ceiling. Products that
copy that shell and add their own application tree use a separate 768 MiB
profile: SharedFS derives its fixed inode-table size from the declared byte
ceiling, so merely having free data blocks does not guarantee that another
file can be created. `saveShellDerivedVfsImage()` rejects a product build
unless at least 64 MiB of data blocks and 8,192 inode slots remain after its
immutable contents are written. This makes runtime allocation space a checked
artifact contract instead of allowing an image to build successfully and then
fail with `ENOSPC` during normal browser initialization. The shared save helper
also requires the image's effective growth ceiling to equal the 768 MiB product
profile. A future product that intentionally needs a larger reviewed profile
must pass that exact ceiling explicitly rather than silently drifting from its
browser consumer. Host-tree copies fail the build on any read or VFS write
error; intentional omissions are declared through the copy helper's `exclude`
option.

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

### Kandelo demo metadata

VFS images can also carry UI presentation metadata at `/etc/kandelo/demo.json`.
The Kandelo live loader reads this file immediately after restoring the image,
before kernel instantiation, and uses it to decide which surface should be
primary during boot and after the demo is ready. This keeps demo-specific UI
preferences with the image instead of hardcoding them in the page loader.

```json
{
  "version": 1,
  "profiles": {
    "wordpress-sqlite": {
      "presentation": {
        "bootPrimary": "syslog",
        "runningPrimary": ["web", "terminal", "syslog"],
        "terminalAccess": "drawer",
        "internalsAccess": "drawer"
      }
    }
  }
}
```

Use `writeKandeloDemoConfig()` from
`images/vfs/scripts/kandelo-demo-config.ts` in VFS build scripts. Images
without this file still boot with Kandelo's generic presentation defaults, but
the Kandelo app does not carry demo-specific presentation fallbacks.
Any extra files needed by an image-declared `autoCommand` can be declared in
`assets`; the loader stages those paths generically and hash-verifies them when
`sha256` is provided.

The runtime treats this file as untrusted image input. It must be a regular
file no larger than 256 KiB, contain valid UTF-8 and JSON, and use a supported
version. The loader validates every profile before using any of them, so a
malformed unselected profile cannot hide behind the current URL. Producers
that already have a reviewed canonical JSON file may copy those exact bytes;
the bottle-built main shell uses `homebrew/main-shell-demo.json` as the single
source shared with the legacy image builder.

VFS images do not need to serialize placeholder device nodes. Both Node and
browser boot replace `/dev` with the authoritative `DeviceFileSystem` and mount
shared memory at `/dev/shm`; image acceptance should exercise devices such as
`/dev/null` only after those runtime mounts exist.

KMS demos use the same metadata path. A profile can set
`runningPrimary` to include `"kms"` and provide an `autoCommand` such as
`/usr/local/bin/modeset`; the VFS image must contain that executable. The
Kandelo app attaches the KMS canvas through the generic KMS surface plumbing,
then runs the image-declared command. Do not add browser-loader branches that
import or spawn a specific `modeset.wasm` file.

Images can also declare an optional `guide`. When `guide` is absent, Kandelo
does not render a demo panel; this is the intended shape for demos where the
primary surface is enough, such as WordPress and Doom. A guide can contain
button groups, an editable shell script, and optional companion HTML:

```json
{
  "version": 1,
  "profiles": {
    "node": {
      "guide": {
        "title": "Node.js demo",
        "groups": [{
          "title": "REPL",
          "actions": [
            {
              "id": "enter-repl",
              "label": "Open REPL",
              "kind": "terminal.run",
              "payload": "node"
            },
            {
              "id": "send-expression",
              "label": "Send expr",
              "kind": "terminal.write",
              "payload": "process.version\n"
            }
          ]
        }]
      }
    }
  }
}
```

### Image-owned default shells

An image that contains its own interactive shell can select it with
`/etc/kandelo/shell.json`:

```json
{
  "version": 1,
  "path": "/home/linuxbrew/.linuxbrew/bin/dash",
  "argv": ["dash", "-l", "-i"]
}
```

The Kandelo browser loader validates this file before boot, verifies that
`path` is an executable regular file in the restored VFS, and starts it through
the kernel's normal VFS `exec` path. It does not download or overwrite the
legacy Bash and Dash programs when this declaration is present. Images without
the file retain the existing `/bin/bash` fallback.

The declaration deliberately does not contain environment variables, a
working directory, or user IDs. Those remain boot-descriptor policy; the image
owns only the executable it contains and its startup arguments. Paths must be
absolute and normalized, argument counts and byte sizes are bounded, shell
executables are limited to 64 MiB, extra fields are rejected, and an
unsupported version fails loudly.

Login shells read `/etc/profile`. Kandelo's rootfs and shell images source
readable `/etc/profile.d/*.sh` fragments there, so an image composer can add
package-manager environment setup without teaching the browser about a
particular package or prefix.

`terminal.run` sends a command through the persistent PTY-backed shell.
`terminal.write` sends raw text to that PTY, which is useful for entering input
into an already-running REPL. `guide.companion.srcDoc` runs in a sandboxed
iframe and has no direct kernel access; it can only request parent-approved
actions by posting `{ type: "kandelo.demoAction", actionId }`.

When changing metadata for an existing package-backed image, bump that
package's `build.toml` `revision` so published/fetched binaries are rebuilt.
For local browser artifacts, force a rebuild with `./run.sh rebuild <target>`.

### VFS images per demo

| Demo | Image | Build command | What's inside |
|------|-------|--------------|---------------|
| Python (legacy opt-in) | `python-vfs.vfs.zst` | `bash packages/registry/python-vfs/build-python-vfs.sh` | ABI-bound CPython interpreter, complete stdlib, license, aliases, and demo metadata |
| Erlang (legacy opt-in) | `erlang-vfs.vfs.zst` | `bash packages/registry/erlang-vfs/build-erlang-vfs.sh` | ABI-bound BEAM emulator, relocatable core OTP tree, executable helpers, and boot files |
| Perl | `perl.vfs.zst` | `bash images/vfs/scripts/build-perl-vfs-image.sh` | Perl stdlib |
| Shell | `shell.vfs.zst` | `./run.sh build shell-vfs` | platform base plus the exact reviewed 38-Formula public Homebrew bottle closure, compatibility links, profile, and image-owned Homebrew Bash |
| Node | `node-vfs.vfs.zst` | `bash images/vfs/scripts/build-node-vfs-image.sh` | npm 10.9.2 dist + writable `/work` |
| WordPress | `wordpress.vfs.zst` | `bash images/vfs/scripts/build-wp-vfs-image.sh` | WP files, nginx/PHP configs |
| LAMP | `lamp.vfs.zst` | `bash images/vfs/scripts/build-lamp-vfs-image.sh` | MariaDB + WP + configs |
| MariaDB test | `mariadb-test.vfs.zst` | `bash images/vfs/scripts/build-mariadb-test-vfs-image.sh` | MariaDB + test suite |

Node, WordPress, and LAMP are optional demo profiles. Their VFS asset imports
are resolved only after that profile is requested; loading the main shell does
not require or fetch those image bytes. If the selected profile's local or
resolver-managed artifact is absent, the browser reports that exact missing
image and asks the user to run `./run.sh fetch`.

The standalone MariaDB demo and MariaDB test images run `mariadbd` as the
`mysql` account (uid/gid 101). Their writable `/data` directories are
therefore serialized as `101:101` with mode `0775`; `/tmp` remains a
root-owned `01777` sticky directory.

Generated VFS images are `.gitignore`d rather than committed. Package-backed
images can be materialized from a current public package archive; the normal
resolver falls back to the package's source recipe when needed. The `run.sh`
script handles this automatically before starting the browser.

Homebrew-derived browser images are external artifacts, not bundled into the
app. The trusted Homebrew publisher first pours wasm32 bottles into a
precomposed `.vfs.zst`, boots those exact bytes in Node and Chromium, and runs
the tap-selected smoke command. When the caller seals that dependency-bearing
acceptance as required, the publisher stores the exact image, report, evidence,
and `kandelo-homebrew-vfs.json` descriptor in the source tap's public,
content-addressed `homebrew-vfs-sha256-<image-sha256>` release. The descriptor's
`launch.value` is the anonymous image URL accepted by the normal browser
`?vfs=<url>` path. The publisher anonymously reads every release asset back and
verifies its digest and size before reporting success.

The main shell can also consume explicitly selected Homebrew runtime layers
through version-1 boot-descriptor mounts whose source is `package-layer`.
These mounts are root overlays described by an unauthenticated HTTPS URL plus
an exact descriptor byte count and `sha256:<digest>` reference. The shared
host consumer verifies the descriptor and its binding to the exact loaded
shell image, ABI, and Homebrew composition before it adds any paths. Selected
layers must have disjoint non-base packages and filesystem ownership.
Runtime-layer composition currently requires each layer reference to name one
requested root equal to its layer ID. The wider 128-name descriptor/parser
bound is shared with planning and leaves room for collection artifacts, but it
does not turn this boot mount into a multi-root layer. Phase 3 composes the
multi-root main shell through the bottle-collection primitive instead.
Schema-5 direct-bottle `deferred_trees` carry a complete source inventory and guest
projection: paths, types, modes, links, regular-inode groups, materialization
provenance, immutable content identity, a closed decoder/media-type pair, and
one to eight byte-identical immutable HTTPS transports. Exactly one
transport is the bundle's browser-readable release asset; additional transports
may name the canonical public bottle or another immutable mirror. The descriptor has its own
`homebrew-runtime-layer-sha256-<bundle-sha256>` identity, independent from the
eager `homebrew-vfs-sha256-<image-sha256>` acceptance release. Its canonical
bundle hash covers the lower shell package-output receipt and composition,
package and tap provenance, complete tree inventory and payload identity, and
the exact VFS/report/Node/Chromium evidence identities. The bundle's
self-derived release URL and the hash itself are excluded to avoid a circular
identity; external transport records remain bound. The consumer recomputes the
canonical hash, requires the closed descriptor's canonical-json-v1 byte
encoding, and verifies the derived release URL before registering paths.
Deferred content remains lazy inside the serialized kernel-owned VFS.
Registration, `stat`, and `readdir` do not fetch it. The first ordinary
open/read, mapping, or executable resolution downloads and verifies the whole
owning bottle; transports are tried in descriptor order until one passes the
same digest and size identity, and all members are bounded, decoded, and
verified before one identity-guarded batch commit. There is no per-file or
byte-range retrieval inside the gzip/TAR. A failed fetch, digest,
decode, inventory check, or allocation leaves every regular inode pending and
retryable. Hard-link inventory members are restored as names of the same inode,
including across VFS image save/restore. A metadata-only tree remains deferred
through serialization and is still verified at first-use or boot-prefetch even
though it has no regular stub to replace. Descriptors with no package-layer
mounts retain the ordinary shell behavior and fetch no runtime-layer bytes.
Across all selected layers, at most 512 layer-owned packages may be added. The
base image's already-pending deferred groups and the newly selected bottle
trees share one 512-group serialization budget. Pending generic deferred trees
whose resource claims are serialized also share the aggregate compressed-byte,
expanded-byte, payload-byte, and source-plus-guest-entry budgets with newly
selected bottles. Each byte budget is 512 MiB for the complete pending
collection while each independently fetched tree remains bounded to 256 MiB;
the collection and each tree are also limited to 100,000 inventory entries.
Legacy ZIP groups such as the current Vim and NetHack groups carry no aggregate
byte/entry claims in their old metadata, so they consume the shared group
budget only.
The consumer restores the base image and composes every selected layer in a
private filesystem, publishing that filesystem to boot only after registration
and every required boot-prefetch succeeds. Allocation, collision, validation,
and transport failures therefore cannot expose a partially composed namespace.
If this private browser-side transaction fails, the consumer reports its
discarded `SharedArrayBuffer` to the boot lifecycle before rethrowing the
original error. Failed and superseded boots then run the same bounded WebKit
reclamation pass used after kernel teardown, so repeated failures do not leave
untracked staged images on the persistent main thread.

The Homebrew collection producer emits one candidate tree per selected Formula
and keeps that Formula's finalized bottle `.tar.gz` byte-for-byte as the tree
payload. Its closed schema can represent the production shell's 32 requested
roots under the shared 128-request bound, but Phase 3 calls
`buildHomebrewOriginalBottleCollection` directly; it does not publish or boot
that collection as one multi-root runtime layer. The later shell composer
chooses the embedded/deferred partition. A
complete source inventory describes every TAR member. A separate
guest projection binds those members to the keg, reviewed link-manifest copies,
the builder-owned `opt` link, ownership, modes, and hard-link inode groups.
Ordinary archive copies must preserve the source mode; an explicit
`archive-copy-mode` record is required when a reviewed link manifest overrides
it. Deterministic `zip-v1` remains accepted for already-published schema-4
layers and non-Homebrew deferred archives, but is not produced as a substitute
for an original Homebrew bottle.

The source inventory and materialization provenance are additive deferred-tree
metadata. Existing schema-4 ZIP descriptors and serialized legacy deferred
trees remain valid on the new host. An older host rejects a direct-bottle
descriptor because the closed object contains fields it does not understand;
it does not reinterpret the bottle as the older one-source-per-guest-entry
shape. These metadata additions do not change the kernel/process ABI or the
ABI binding carried by a VFS image.

Boot accepts at most eight package layers and 16 MiB of descriptor bytes in
aggregate. The shared consumer additionally caps aggregate compressed payload
bytes, expanded bytes, and entry count. Boot-prefetch downloads use at most two
workers. Each package's declared keg and `opt` link must match its indexed
paths. Every schema-5 ancestor at or below `/home/linuxbrew/.linuxbrew` must be
declared in the aggregate guest projection. Equal-mode `mergeable-directory`
claims can create an absent directory once or reuse an equal-mode lower-image
directory; undeclared ancestors, unequal modes, and non-directory collisions
fail closed. The consumer also rejects archive reuse across package ownership
domains.

```json
{
  "path": "/",
  "source": "package-layer",
  "name": "python",
  "url": "https://example.invalid/immutable-python-layer.json",
  "ref": "sha256:<64 lowercase hexadecimal characters>",
  "bytes": 12345
}
```

The object shape is closed: package-layer mounts do not accept inline data,
ephemeral flags, credentials in the URL, or non-root target paths.

No Perl, Python, or Erlang layer URL is built into the browser. Concrete
entries require immutable published descriptor/content identities derived from
their finalized bottle sidecars; missing or mismatched identities fail boot
instead of falling back to a standalone language VFS. This substrate does not
change the main-shell composition: the Bash-plus-required-closure embedding and
any default-shell cutover remain explicit later producer decisions.

That direct release proves only its configured acceptance image; it does not
set generic package browser flags. The separate gallery path first boots a
package image in the browser UI and runs its smoke command, such as
`/home/linuxbrew/.linuxbrew/bin/file --version`. Only then may generated
Homebrew sidecars and gallery `index.toml` set `browser_compatible = true`.
Generic gallery archives are currently retained as run diagnostics rather than
published as durable gallery releases.

A Homebrew gallery entry is visible only when its `index.toml` package record
is wasm32 success, has an `archive_url`, and sets
`browser_compatible = true`. Launch-time archive failures are surfaced in the
UI instead of silently hiding the rest of the gallery.

### Building VFS images

Package-backed image recipes resolve their declared dependencies rather than
reading another package's source/build side effects. The disabled legacy
`python-vfs` recipe, for example, consumes CPython's `python.wasm` and
`python-runtime.zip` closure. These compatibility recipes are excluded from
staging and are not the Homebrew distribution unit. The `run.sh` script
orchestrates explicit resolver builds:

```bash
./run.sh build python-vfs    # Build Python VFS image
./run.sh build shell-vfs     # Build Shell VFS image
./run.sh build all            # Build everything including all VFS images
```

The main shell target resolves the `shell` package into `local-binaries`; it
does not invoke the image recipe directly or source-build fbDOOM first. On a
cache or index miss, that package's source recipe anonymously provisions the
immutable `homebrew-tap-core` commit declared in `build.toml`, verifies the
reviewed Brewfile and migration lock, and composes exclusively from public
bottles. `./run.sh --fetch-only build shell-vfs` keeps the stricter consumer
contract and refuses that source fallback.

### Adding a new VFS image

1. Create `images/vfs/scripts/build-<name>-vfs-image.ts` — import helpers from `vfs-image-helpers.ts`
2. Create `images/vfs/scripts/build-<name>-vfs-image.sh` — shell wrapper that runs the TypeScript script
3. If the image is consumed by Kandelo, write `/etc/kandelo/demo.json` via `writeKandeloDemoConfig()`
4. If the image is consumed by the Kandelo UI, expose it through a gallery manifest, preset, or direct `vfs` URL so the UI can fetch the `.vfs.zst` image and use `MemoryFileSystem.fromImage()` (which auto-decompresses)
5. Add a build target in `run.sh`

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

During development, `@binaries/...` imports can resolve to canonical package
members outside the checkout. Vite's directory allow list is only transport
plumbing: a pre-serving guard permits the exact regular files approved by the
binary resolver and rechecks their real paths on every request. Other program
cache entries, source-cache files, symlink escapes, malformed filesystem URLs,
and descendants created by replacing an approved file with a directory receive
HTTP 403. Production builds emit ordinary bundled assets and do not expose the
local package cache.

## Known Limitations

### SharedArrayBuffer restrictions
Chrome rejects SharedArrayBuffer-backed views in `TextDecoder.decode()` and `crypto.getRandomValues()`. Always copy to a temporary non-shared buffer first.

### No external raw sockets
Browser sandboxing prevents Kandelo from listening on real network ports or opening raw TCP/UDP sockets to arbitrary external peers. Local loopback sockets and `LocalVirtualNetwork` listeners are virtual sockets inside the browser session, so Kandelo machines can still communicate with each other using POSIX UDP/TCP. Browser-facing HTTP server demos use a service worker to intercept HTTP requests and inject them as kernel TCP connections via the connection pump.

### Memory per process
Each process gets `WebAssembly.Memory(shared: true, initial: layout.initialPages, max: maxPages)`. The initial size covers the program's imported minimum memory, a brk window, and the low syscall control channel; it no longer allocates `maxPages` at spawn. `maxMemoryPages` still caps guest brk/mmap growth and should be tuned for workloads that need large address spaces.

### npm registry access in the browser
The node demo's `npm install` uses `--registry=http://proxy.local/` so registry traffic can pass through the host fetch bridge instead of requiring the JavaScript runtime to own every TLS edge case. The kernel resolves `proxy.local` via `host_getaddrinfo` (it is deliberately absent from the synthetic `/etc/hosts`), and the host-side TLS backend re-routes those requests through the existing cors-proxy (dev) or service worker (prod) onto `https://registry.npmjs.org/`. Tarball URLs in JSON responses are rewritten to the same alias so subsequent fetches stay on the same path.
