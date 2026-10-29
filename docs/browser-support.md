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
├── Page API (boot, stdin, network)      ├── Boot image bytes (the kernel owns /)
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

- **Kernel in dedicated worker**: Browser syscall notification remains event-driven through `Atomics.waitAsync`; it does not poll channels. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue, allowing syscall handling and worker messages to keep progressing together under multi-process bridge load. Node.js keeps its native/default batching unchanged. The immediate queue yields after
  four milliseconds of continuous work through `scheduler.yield()` where
  available, otherwise through the timer queue. A rejected scheduler yield
  also falls back to a timer. This keeps device clocks, blocked
  syscall retries, and lifecycle timers progressing on WebKit, where an
  uninterrupted MessageChannel chain can starve timers.
- **WebKit process-memory construction**: spawn, exec and ordinary fork
  construct fresh shared memories in disposable allocation workers. Native
  samples found the kernel realm stalled inside JavaScriptCore's synchronous
  memory collection; moving construction to a fresh realm keeps kernel input,
  device clocks and process teardown responsive. The allocator owns admission
  and retirement on every engine. A WebKit fork captures plain bytes before
  yielding and charges its temporary snapshot and pending child memory against
  the existing byte budget. Construction fails after 30 seconds if its worker
  does not reply, and machine shutdown cancels pending construction workers.
  JavaScriptCore's native allocation retry collects the calling realm. A fresh
  worker cannot collect retired wrappers held by the owning kernel realm, so
  a constructor `RangeError` triggers one final allocation in that owner after
  the disposable worker has terminated. It uses the same admitted descriptor
  and ceilings; clone errors and timeouts do not take this path. Native
  collection in this final synchronous attempt can pause the kernel worker.
  A second failure propagates through ordinary allocation rollback, without
  relying on finalizer delivery or reducing the guest's address-space limit.
  This engine boundary requires `blob:` in a deployment's `worker-src` Content
  Security Policy. Node, Chromium and Firefox retain direct construction and
  the same independent-address-space fork semantics.
- **Kernel in dedicated worker**: Browser syscall notification remains event-driven through `Atomics.waitAsync`; it does not poll channels. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue, allowing syscall handling and worker messages to keep progressing together under multi-process bridge load. Node.js keeps its native/default batching unchanged.
- **The kernel owns the filesystem** (`kernel.boot()`): the page hands `BrowserKernel` a pre-built VFS image, the main thread zstd-decodes it and transfers the bytes to the kernel worker, and the kernel parses it and serves `/` itself (`docs/architecture.md`, "Filesystem"); the scratch mounts and `/dev/shm` are an in-kernel tmpfs. The worker then exec()s `argv[0]` as the first user process. The main thread holds no filesystem and is not in the FS hot path. Service-supervised demos run dinit under the first kernel-allocated user PID (100); PID 1 remains the kernel's synthetic init reservation. Single-program demos exec the language interpreter directly.
  Browser harnesses that must stage a transient file between process spawns use
  `BrowserKernel`'s worker RPC methods (`readFileSnapshotFromVfs`,
  `writeFileToVfs`, and `unlinkFileFromVfs`). The owning worker performs those
  through kernel exports (`kernel_rootfs_read_file`, `kernel_rootfs_write_file`,
  `kernel_rootfs_unlink_file`), so live guests see the change and the main
  thread never touches filesystem state.
  Reads follow the same rule. `readFileFromVfs`, `readDirFromVfs` and
  `statVfsPath` ask the worker (both `BrowserKernel` and `NodeKernelHost`
  implement them), and they are the only way `LiveKernelHost.readFile`,
  `readDir`, `stat` and the process list's uid-to-name lookup reach the
  filesystem. There is no synchronous filesystem handle on the kernel object
  for UI code to fall back to; a kernel without these methods makes the call
  fail with an error naming the missing method. A missing path resolves
  `null` from the worker and surfaces as `ENOENT`, not as empty bytes or an
  empty listing. The process list comes from `enumProcs`; directory and
  metadata inspection also expose live `/proc` and `/dev` entries.
  Files, directory snapshots and path metadata come from native inspection
  exports, using the same component-wise namespace walker as guest syscalls.
  This follows links across rootfs, tmpfs and Node foreign mounts. Directory
  entries retain their own symlink type/target and current uid/gid; `stat`
  follows the final link. Inspection uses root credentials from the immutable
  reserved init record without creating a process or borrowing guest file
  descriptors. Directory metadata larger than a scratch lease is streamed
  inside one serialized kernel entry. This inspection API does not read
  generated procfs file contents; normal guest reads still do.
  `subscribeVfsChanges(prefix, cb)` reports native rootfs and scratch-storage
  changes on both hosts. It is disabled until a prefix is watched. Events
  invalidate current state after the kernel call ends, and a bounded queue
  refreshes watched directories on overflow. See `docs/webmcp.md` for limits.
  A quiescent machine can return durable root-image bytes through
  `BrowserKernel.exportRootfsImage()`. The worker rejects export while a guest
  process or teardown is live, serializes it against the same staging and lazy
  materialization RPCs, and returns the image the kernel streams of its live
  `/` (`kernel_rootfs_export_container_read`). Scratch mounts and `/dev/shm`
  are boot-local and are recreated when those bytes start another machine.
- **Transient programs** (`kernel.spawn(programBytes, argv)`): pages that fetch binaries at runtime (test runners, REPLs that load arbitrary user code, benchmark suites) transfer each program's bytes to the worker; the Rust `ProcessTable` allocates the PID and the worker returns it. Top-level creation, guest fork/spawn, and thread clone all draw from that one authoritative task-ID sequence; no browser or host-side allocator exists. There is no main-thread filesystem option: the former `memfs:` constructor option is gone, and every machine boots from an image.
- **Exact module reflection**: each process worker binds a compiled module to
  the exact Wasm bytes that passed artifact admission. Import and export names,
  kinds, and declaration order come from Kandelo's binary contract parser.
  This keeps Node.js, Chromium, Firefox, and WebKit on one path; in particular,
  WebKit can compile ABI 43 exception-reference imports even when its
  `WebAssembly.Module.imports()` API cannot produce descriptors for them.
  Modules created by an external embedder without registered bytes retain the
  native reflection fallback.
- **Signal-wait engine matrix**: the real BrowserKernel worker path runs the
  wasm32 ppoll/pselect interruption matrix and wait4 unknown-option rejection
  on Chromium, Firefox, and WebKit. Chromium and Firefox also run its wasm64
  counterpart. That recorded signal-wait scope is not a current WebKit
  Memory64 capability limit: Playwright WebKit 26.6 validates Memory64 and
  passes the native memory64 fork-process cases described below. WebKit's
  memory64 signal-wait matrix remains a separate coverage gap. Browser injection waits
  on guest-published atomic gates in the real process memory, so acceptance
  does not depend on a fixed event-loop delay.
- **Native fork process matrix**: the native instrumenter runs the
  same SDK/libc fixtures on memory32 and memory64 through real BrowserKernel
  workers in Chromium 153, Firefox 155 and Playwright WebKit 26.6. The matrix
  checks direct/indirect and loop forks, stack carryovers, recursive children,
  signals, pthread entry and allocation-failure recovery. At ABI 53 integration
  commit `d2aaebe3a4`, all 57 checks passed:
  52 positive guest scenarios, three Memory64 probes and two explicit WebKit
  stack-boundary checks, with no skips. WebKit exhausts its native stack on
  this fixture's 4,096-call shape. The test requires the exact stack diagnostic
  and checks root allocation recovery first. A separate 256-call shape retains sixteen live
  128-bit values per activation, forcing another 64 KiB continuation allocation
  while fitting the engine stack. It checks later ENOMEM, parent usability,
  absence of phantom children, page reuse, recovery fork and carry-value
  preservation on every engine and pointer width. This is Playwright coverage,
  not a claim of native Safari testing or Codex execution.
- **Exec reads from filesystem**: Like a real OS, `exec()` reads binaries from the kernel's filesystem. Programs are baked into the VFS image at build time, or are lazy files the image names and the host fetches on first exec. Symlinks are used for multicall binaries (e.g., coreutils).
- **dinit for service supervision**: Multi-process demos (nginx, redis,
  mariadb, nginx-php, wordpress, lamp, mariadb-test) bake `/sbin/dinit` and
  per-service files under `/etc/dinit.d/` into the VFS image via
  `addDinitInit()` (`images/vfs/scripts/dinit-image-helpers.ts`). dinit is the
  first user process, not PID 1. It reaps its directly supervised children and
  handles `depends-on` ordering and bootstrap-then-daemon chains. Synthetic
  PID 1 has no wait loop, so Kandelo does not yet reap children reparented to
  it. Page code waits for service-ready via `onListenTcp` (port-bind)
  callbacks, then starts driving the demo over kernel-loopback TCP or the HTTP
  bridge. The corresponding Node demo commands resolve and authenticate the
  same VFS artifacts, apply only per-run configuration such as a listen port,
  and start image-owned dinit through `NodeKernelHost.spawnFromVfs()`.
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
- IPv4 loopback unicast and multicast route between processes; IPv6 loopback and AF_UNIX datagrams remain process-local
- `LocalVirtualNetwork` attaches multiple browser Kandelo machines to virtual IPv4 addresses in one browser session
- Browser networking backends preserve valid decimal one-, two-, three-, and four-component IPv4 forms, reject malformed/overflowing numeric forms, enforce ASCII host-label syntax and DNS length limits, and synthesize IPv4 addresses only for acceptable hostnames; they do not provide AF_INET6 DNS/transport
- The network lab at `/pages/network/` is intended to run GNU Netcat (`nc`)
  and `curl` against those virtual sockets. Its current browser verification is
  deferred by the multi-kernel scheduling limitation documented below; the
  equivalent packaged-netcat virtual-network path remains covered on Node.js.
- Service worker cookie jar for session persistence (WordPress)
- nginx serves static files and proxies to PHP-FPM via loopback TCP

### Filesystem
- The in-kernel root filesystem and tmpfs hold `/`, the scratch mounts and `/dev/shm`; the browser host mounts no filesystem of its own beneath them (`resolveForBrowser` refuses a scratch mount the tmpfs does not serve).
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
- The wasm32 browser shell includes [tmux 3.8](tmux.md) as a lazy program.
  It uses the ordinary guest PTYs, process model, Unix sockets, libevent,
  and package-owned terminfo database; panes are rendered within xterm.
- Interactive stdin via `appendStdinData` for incremental input
- xterm.js integration. The live Shell pane
  (`apps/browser-demos/pages/kandelo/panes/Shell.tsx`) builds its own
  `Terminal`; `apps/browser-demos/lib/pty-terminal.ts` provides a standalone
  `PtyTerminal` for pages that drive a `BrowserKernel` directly.
- Each visited terminal tab retains its xterm renderer and keeps parsing PTY
  output while hidden, including when the primary view shows syslog or another
  demo surface. Revealing a tab fits and refreshes the retained screen;
  it does not reconstruct a full-screen application from the bounded session
  byte-history tail. Only the active tab receives focus or updates its PTY
  dimensions. Removing a tab disposes its renderer and listeners.
- Guest-created PTYs notify the shared Node/browser runtime when input,
  output, a terminal mode transition, or final endpoint closure changes
  readiness. Poll/select/epoll and blocked reads are rescheduled through the
  runtime's existing retry queues; terminal input wakes readers even before
  an output observer attaches.
- The PTY window size (`TIOCGWINSZ`) is the size of the terminal displaying
  it. Only an `attachPty()` call that passes `{ cols, rows }` (the Shell
  pane's fitted xterm) sets it, sending `SIGWINCH` to the foreground process
  group when it changes. Programmatic writers that share the PTY without
  rendering it — boot-link scripts, demo guide and dock actions,
  `runShellCommand`, `interruptShellForeground` — attach without a size and
  leave the winsize alone, so a full-screen program they launch (`vim`,
  `nano`) fills the visible terminal. A PTY started before any terminal
  reports a size starts at 80×24 until the first sized attach.

#### Clickable links

URLs in terminal output are clickable and always open in a new tab. Both plain
text URLs and OSC 8 hyperlinks go through one policy, decided by
`classifyTerminalLink` in `web-libs/kandelo-session/src/terminal-links.ts` and
wired to xterm.js by `apps/browser-demos/lib/terminal-links.ts`:

- **Third-party destinations** open with `rel="noopener noreferrer"`. A Kandelo
  page URL can carry machine state — a `#k1=` boot descriptor, a share link —
  so the `Referer` header is withheld from anything that is not this machine.
- **Same-origin destinations**, including the machine's own web surface, open
  with `rel="noopener"` and do send a referrer.
- **Loopback URLs an in-machine program printed** (`localhost`, `127.0.0.0/8`,
  `0.0.0.0`, `[::1]`, `[::]`) name a port in the *machine's* network namespace,
  not on the user's computer. The service-worker HTTP bridge forwards exactly
  one machine port to the app prefix, so such a URL is rewritten onto that
  prefix — `http://localhost:8080/wp-admin/` becomes
  `<origin>/computer/<name>/wp-admin/` —
  and only when its port matches the bridged one.
- **Loopback URLs on any other port, or with no bridge running, are not
  linkified at all.** Nothing forwards them, and a click that silently landed
  on the user's own machine would be worse than plain text.
- Only `http:` and `https:` are linkified. `javascript:`, `data:` and `file:`
  URLs a program writes are never clickable.
- An **OSC 8 hyperlink** lets a program choose the visible text and the
  destination independently, so the text can misrepresent where the link goes.
  Following one to a third party keeps xterm.js's confirmation prompt, which
  names the real destination; only the referrer behavior changes. (xterm's
  built-in handler navigates with `window.open` + `location.href`, which does
  send the `Referer`.)

### Framebuffer (`/dev/fb0`)
- 640×400 BGRA32 packed-pixel framebuffer; exclusive process owner.
- The guest pixel buffer lives in its process memory. Browser scanout copies
  those pixels every 16 ms into a fixed-size shared display buffer; the canvas
  never receives the process's full address space. Write-based bindings already
  forward pixel deltas. Node consumers retain direct guest-memory presentation.
- Framebuffer messages carry an execution generation. Exit and exec stop that
  generation's scanout copier and await UI removal of its display binding;
  delayed old-image messages cannot disturb a successor with the same PID.
  Memory growth needs no UI rebind because the copier reads the current guest
  buffer on each tick. Browser consumers use the framebuffer handle rather
  than `getProcessMemory()`.
- `host/src/framebuffer/canvas-renderer.ts::attachCanvas(canvas, registry, pid, opts)` is the consumer-side renderer.
- Keyboard input: the demo page maps focused browser `KeyboardEvent` values to Linux input keycodes, encodes them as MEDIUMRAW bytes, and feeds them through `appendStdinData(pid, …)`; fbDOOM-style software decodes those bytes from the tty. Ctrl+Shift+Esc is reserved as the host escape from keyboard capture.
- Limitations: `fork` does not auto-bind the child; multi-buffering / vsync via
  `FBIOPAN_DISPLAY` is a no-op. Device/CRTC-owned surfaces, per-handle rights,
  serialized presentation, and multi-writer/compositor ownership remain
  follow-up work.

### Mouse input (`/dev/input/mice`)
- Demo pages attach `mousemove` / `mousedown` / `mouseup` listeners to the canvas and call `BrowserKernel.injectMouseEvent(dx, dy, buttons)`. The main thread posts a `mouse_inject` message to the kernel worker, which calls the kernel's `kernel_inject_mouse_event` export. The kernel encodes a 3-byte PS/2 frame and queues it on a global ring; user processes drain the queue via `read("/dev/input/mice", …)`.
- **Pointer Lock recommended.** The DOOM demo calls `canvas.requestPointerLock()` on first click so the browser delivers unbounded relative motion (`MouseEvent.movementX/Y`). Without pointer lock, `clientX/Y` deltas clamp at the canvas edges and feel sluggish for first-person controls. Press `Esc` to release the lock.
- Browser `deltaY` is positive-down; the demo inverts it before injection so the kernel queue holds canonical PS/2 (positive-up) deltas.
- Browser `MouseEvent.button` (0=L, 1=M, 2=R) is mapped to PS/2 button bits (bit0=L, bit1=R, bit2=M). Right-click suppresses the browser context menu via `contextmenu` `preventDefault()`.
- Single-owner device (one process can hold `/dev/input/mice` open at a time; second open from another pid returns `EBUSY`).

The machine's evdev keyboard source remembers the code delivered for each
held key and forwards its release even when focus has moved to browser UI.
Window blur and source shutdown release delivered keys, modifiers, and owned
pointer buttons; queued paste keys are discarded. A modifier-click reconciles
the keyboard state before the display forwards its button press. The Modeset
pane releases both PS/2 and evdev buttons on pointer cancellation, lost pointer
capture, window blur, and input teardown, retaining the last absolute position.

### Audio output (`/dev/dsp`)

- The kernel exposes a playback-only OSS `/dev/dsp` frontend over its generic
  PCM stream core. Applications may write U8, signed 16-bit little-endian, or
  signed 16-bit big-endian mono/stereo PCM at 8–192 kHz. The worklet converts
  those PCM concepts to the browser output format; Web Audio types are not
  exposed to guests.
- The queue is bounded and backpressured. It defaults to four 1024-byte
  fragments (4096 active bytes), within a fixed 65,664-byte transport
  allocation (128-byte control header plus 65,536-byte ring).
  The kernel never drops the oldest samples. Blocking writers sleep for
  capacity, nonblocking writers receive partial progress or `EAGAIN`, and
  `POLLOUT` requires at least one free fragment. Writes may end between PCM
  frame boundaries: later writes continue the same byte stream, while a drain
  pads only a terminal incomplete frame with format-appropriate silence.
- An `AudioWorkletProcessor`, running on the Web Audio render clock, reads the
  bounded PCM mirror, advances its consumer cursor, and outputs silence on
  underrun. A relay in the kernel worker copies newly produced bytes and
  configuration into an independent 65,664-byte shared buffer, and returns
  worklet consumption, underrun and fatal-error publications to Rust. Absolute
  cursors, discard floors and generations preserve one queue and its existing
  capacity; the relay never consumes audio or adds buffering capacity.
  Neither browser main nor the persistent AudioWorklet receives kernel memory.
  The mirror travels over a transferred MessagePort directly to the worklet;
  audio-activity notifications reach the UI as plain messages. The worklet
  remains the only playback clock. Browser-provided Float32 output buffers are
  transient. Consumption wakes blocked writes, `poll()`, and
  `SNDCTL_DSP_SYNC`/close drain waiters in the kernel worker.
- The default 4096-byte queue is about 21.3 ms at 48 kHz stereo S16. A normal
  128-frame worklet render quantum adds about 2.7 ms at 48 kHz; the browser's
  `AudioContext.baseLatency` and `outputLatency` are device-specific and must
  be measured separately. Machine teardown first waits for the shared PCM ring
  to drain. If the context is running, it then suspends the context so Web
  Audio hands already-rendered blocks to the output device and waits a bounded
  interval covering the reported base/output latency and final render quantum
  before releasing the machine's worklet processor. The processor drops its
  shared-memory views, closes its kernel connection, acknowledges release, and
  returns false from rendering. Disconnecting a processor alone is insufficient:
  a source processor returning true retains its transport inside the
  page-wide AudioContext. Isolating that transport also bounds any wrappers
  awaiting collection in this persistent realm. The shared context stays open to
  avoid WebKit's per-context rendering-thread leak, a suspected WebKit defect
  recorded in the runtime workaround registry
  ([`WEBKIT-AUDIOWORKLET-CLOSE-LEAK`](../tests/runtime-workarounds/WEBKIT-AUDIOWORKLET-CLOSE-LEAK/entry.md));
  explicitly supplied private contexts are closed. A suspended or interrupted context is never resumed
  implicitly during teardown.
- **A user gesture is required.** Preparing the PCM driver may leave its
  `AudioContext` suspended. The application must call the session audio-resume
  path from a click, keypress, or other browser-recognized activation. If the
  context is suspended or interrupted, the consumer cursor intentionally
  stops: the queue fills, writers apply backpressure, and drain/close stays
  pending instead of pretending audio played. Resuming the context continues
  from the queued position.
- **Audio demand is a separate signal from audio state.** Every machine gets a
  PCM transport at kernel ready, so the sink's state (`unprepared`,
  `suspended`, `running`, `error`, …) says nothing about whether anything in
  the machine wants audio. The kernel already publishes demand in the shared
  control header: a guest `open()` of `/dev/dsp` bumps the monotonic
  `generation` and leaves `state` non-closed, while the host's transport claim
  touches neither. `KernelHost.getAudioActivity()` /
  `subscribeAudioActivity()` report that, latched for the machine's lifetime,
  and the browser app shows its audio warning only when demand is set — so a
  shell machine stays silent while a machine that has opened the device still
  surfaces a suspended, errored, interrupted or unavailable sink. The latch is
  what keeps the warning up after a program that played one short sound exits.
- Browser policy suspension and interruption are recoverable and do not poison
  the stream. A permanent worklet, processor, or sink failure is latched into
  the shared transport instead: blocked calls wake, `write()` and drain return
  `EIO`, `poll()` reports `POLLERR`, and final close releases the exclusive
  device after discarding only the tail that can no longer be played. A fatal
  failure during an orphan drain likewise discards the unplayable tail and
  releases ownership instead of wedging subsequent opens.
- The one physical device is exclusive by OFD. `dup()` and inherited
  descriptors share it; another `open()` gets `EBUSY`. Explicit final close
  drains. Exit or `CLOEXEC` leaves any queued tail as an orphan drain and keeps
  the device busy until the worklet reaches it. `RESET` is the explicit way to
  discard a tail. A caught signal can interrupt a blocked write, drain, or
  explicit close; write and drain honor `SA_RESTART`, while interrupted close
  leaves the fd valid for the caller to retry.
- Capture, duplex, `mmap`, OSS mixer devices, and kernel multi-client mixing
  are not implemented. `open(O_RDONLY)` and `open(O_RDWR)` fail with
  `ENOTSUP`, so browser software does not discover a fake recording device.

Node uses the same transport and state transitions. Its default headless sink
advances the consumer position from elapsed wall-clock time at the configured
sample rate and emits consumed bytes to an optional observer; it never drains
the queue instantaneously or keeps a second PCM copy. Running ticks follow the
negotiated fragment duration, preserve fractional-frame drift, and use 10 ms
idle polling. Applications therefore see the same write and SDL callback
pacing even when no physical Node audio device is attached.

## Browser Demos

Located in `apps/browser-demos/pages/`:

| Demo | Software | Boot pattern | Features |
|------|----------|--------------|----------|
| simple | C programs | legacy spawn | Basic file I/O, printf |
| shell | bash + coreutils | legacy spawn | Interactive shell with exec, pipes, PATH lookup |
| python | CPython 3.13 | `kernel.boot` | REPL + script runner |
| perl | Perl 5.40 | `kernel.boot` | REPL + script runner |
| php | PHP CLI | `kernel.boot` | Script execution |
| ruby | Ruby 3.3 | `kernel.boot` | REPL + script runner |
| node | SpiderMonkey-backed Node-compatible runtime + npm 10.9.2 | `kernel.boot` | xterm REPL; `npm install` reaches the real registry via the host fetch |
| erlang | OTP 28 BEAM | legacy spawn | Erlang VM, message passing |
| nginx | nginx | dinit | Static file serving via service worker |
| nginx-php | nginx + PHP-FPM | dinit | FastCGI, fork workers |
| nginx-python | nginx + Python (wsgiref) | dinit | Reverse proxy to a standard-library WSGI JSON API over SQLite |
| mariadb | MariaDB 10.5 | dinit | SQL database with threads (Aria/InnoDB) |
| redis | Redis 7.2 + PHP CLI | dinit | Shared voting board plus phpCacheAdmin command console/key browser on 8080, backed by Redis on 6379; share through activity invitations |
| wordpress | nginx + PHP-FPM + WP | dinit | Full stack with SQLite |
| lamp | MariaDB + nginx + PHP-FPM + WP | dinit | Full LAMP stack; website and interactive MySQL connection invitations to the same WordPress database |
| mariadb-test | MariaDB + mysqltest | dinit + spawn | Playwright-driven mysql-test runner |
| benchmark | (per-suite) | legacy spawn | Micro-benchmarks + WordPress + Erlang ring |
| network | bash + GNU Netcat + curl | `kernel.boot` x 3 | Boots multiple local Kandelo machines and verifies UDP datagrams, TCP streams, and HTTP over virtual TCP |
| doom | fbDOOM | legacy spawn | `/dev/fb0` framebuffer + canvas renderer + keyboard via stdin + mouse via `/dev/input/mice` (pointer-locked) + SFX **and** OPL2-synthesized music via `/dev/dsp` → AudioContext. The shareware `doom1.wad` is **fetched at page load** from a commit-pinned CDN URL (SHA-256 verified, Cache API cached); no IWAD ships in the package archive. The image's `/usr/local/bin/fbdoom` is a launch wrapper around the lazy `/usr/bin/fbdoom`: on first launch it writes `screenblocks 10` (the full-width view with the status bar, rather than Doom's default view inset in a tiled border) into a missing `~/.fdoom.tar/default.cfg`, Doom's own per-user config (fbDOOM reads it at startup and saves its settings there when it quits, as every Doom does; doomgeneric had compiled both out), because the home directory is an empty tmpfs on every boot and Doom has no system-wide config. Doom's Screen Size option still changes it. |
| sdl2 | SDL2 GLSL playground | dinit | Live-coding shader editor on SDL2's KMSDRM backend: gap-buffer editor left, GLES2 fragment shader on `/dev/dri/card0` right, chip synth / sound shader through `/dev/dsp`. The binary comes from the `sdl2-demo` package as a lazy file in the image, fetched when the profile first runs it; its shader presets are baked into the image. A `BrowserInputSource` feeds the keyboard and wheel into `/dev/input/event{0,1}`; the Modeset pane owns the pointer and injects framebuffer-absolute coordinates via `sendPointerAbs`. |
| modeset | modeset.c | dinit | GLES2/EGL port of Pavel's WebGL fluid simulation (bloom, sun rays, shading), steered by the mouse through `/dev/input/mice`: each frame renders through the host's WebGL2 bridge, swaps, and waits on a real `drmModePageFlip` on `/dev/dri/card0`. The binary comes from the `modeset` package as a lazy file in the image, fetched when the profile first runs it; the image's `init.shellCommand` (`/usr/local/bin/modeset`) starts it. The Modeset pane bridges the CRTC to an OffscreenCanvas and shows a live PAGE_FLIP counter chip. |
| scummvm | ScummVM 2026.3.0 | dinit | SCUMM engine fullscreen on SDL2's KMSDRM backend with OSS audio — see [ScummVM demo](#scummvm-demo). The image declares `/usr/local/bin/scummvm`, a wrapper that sets SDL's environment and the user's config, then execs the lazy engine. Dock actions fetch and play the freeware games the ScummVM project distributes; any other game is a zipped upload. |
| freeciv | Freeciv 3.2.6 SDL2 client + server | dinit | Lazy game/data archive, GLES2 presentation, and direct TCP multiplayer through network sessions. The Multiplayer dock menu hosts or joins the session host on port 5556. Audio and multicast discovery are disabled; see [Freeciv](freeciv.md). |
| love | Native LÖVE 11.5 games | dinit | SDL2 KMSDRM/EGL/GLES port with Pong, Snake, Breakout, Asteroids, BYTEPATH and SNKRX selectable through the Games dock menu. Starts Pong; switching restarts the process with the selected game directory. The executable and game tree download lazily. SDL2/OSS audio output is verified in Chromium. Steam integration is disabled. See `packages/registry/love/README.md` for the port's compatibility boundaries. |
| wayland | wlcompositor + wlclock + wlpaint + wlterm | dinit | Full Wayland desktop — see [Wayland desktop demo](#wayland-desktop-demo) below. Not listed in the gallery (Omarchy is the desktop shown there); boot it with `?profile=wayland`, which its browser specs use. The four binaries come from the `wayland-demo` package as lazy files in the image, fetched when the desktop first starts them; the image declares one command, `/usr/local/bin/wldesktop`, which brings the compositor up (it takes DRM master and drives KMS) and then starts the three clients once its socket exists. The image also declares `kms-gl-scanout`, so the pump presents the CRTC through the WebGL2 scanout presenter until the compositor's own GL context claims the canvas. |
| omarchy | wlcompositor (dwindle) + dbus-daemon + Quickshell (wallpaper, bar, launcher, notifications, OSD, lock screen) + qtgallery | dinit | Omarchy-shaped desktop — see [Omarchy desktop demo](#omarchy-desktop-demo). The image declares `/usr/local/bin/omarchydesktop`, which starts a session bus, the compositor and the Quickshell shell; windows, including the Qt gallery, are opened from the launcher and keybinds. The shell's binaries are lazy files of the shell image, fetched when the machine boots: `quickshell.wasm` (82 MB), `qtgallery.wasm` (26 MB), `foot.wasm` (6.5 MB) and `dbus-daemon.wasm` (1.5 MB). The desktop data archive also fetches on first read; the terminal-only boot does not download it. |

The "Boot pattern" column reflects how the demo enters the kernel:
- **`kernel.boot`** — `kernelOwnedFs: true`, exec the language interpreter as the first user process.
- **dinit** — `kernelOwnedFs: true`, exec dinit as the first user process (PID 100), which brings up the per-demo service tree; PID 1 remains synthetic.
- **dinit + spawn** — dinit boots the supervised services; the page spawns transient binaries (e.g. mysqltest) via `kernel.spawn()`.
- **spawn** — the page calls `kernel.spawn(programBytes, argv)` for each binary on a booted machine, and the Rust kernel allocates the PID before the worker launches it.

### Wayland desktop demo

The Wayland desktop machine (launched from the gallery, or directly with
`?vfs=<shell image>&profile=wayland`) boots four programs:

- **wlcompositor** — a floating-window Wayland server (`wl_shm`,
  `xdg_shell`, `wl_seat`, `wl_output`) built on the wasm32 libwayland
  port. It opens `/dev/dri/card0`, becomes DRM master, and composites
  all client windows (wallpaper + CSD titlebars + focus border) —
  **on the GPU** when the host has WebGL2 (see below), with a CPU
  dumb-bo blit fallback — while committing real `drmModePageFlip`
  ioctls. Input arrives through the real libinput stack (libevdev on
  `/dev/input/event*`).
- **wlclock** — an animated analog clock (paced by `poll` timeouts;
  hands/ticks drawn with wpkdraw's anti-aliased primitives).
- **wlpaint** — a pointer-driven painting canvas.
- **wlterm** — a libkwl VT100 terminal running a forkpty'd `sh` (bash, as in every Kandelo image).

The Modeset pane bridges card0 to an OffscreenCanvas.

**GPU compositing (default in the browser).** At boot wlcompositor
probes the `/dev/dri/renderD128` GLES bridge (shader compile via sync
queries, which fail cleanly on headless hosts) and, when available,
composites with GLES3: each client `wl_shm` buffer — a gbm dumb bo
whose prime-fd arrived over `SCM_RIGHTS` — is imported on the EGL fd
and bound as a `WebGLTexture` through the
`DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` ioctl (the host uploads pixels
straight from the bo's shared storage; nothing marshals through the
cmdbuf). Frames render as textured quads (wallpaper texture + z-ordered
windows + focus border) in a single cmdbuf flush, so the canvas
transitions atomically between complete frames. The compositor's GL
context claims the CRTC canvas (`markKmsCanvasGlOwned`), the vblank
pump's presenter stands down, and stats slot 7 reports `3`
(`webgl2-gl` in the chip). KMS PAGE_FLIPs still pace frame callbacks
and the flip counters — only pixel production moves to the GPU. The
compositor prints a one-shot `WLC_RENDERER gpu|cpu` marker;
`WLC_NO_GPU=1` forces the CPU path.

**CPU compositing (Node smokes, headless degrade, or `WLC_NO_GPU`).**
The compositor blits committed buffers into the dumb-bo scanout as
before, and the pane's canvas stays in `mode: "webgl2-scanout"`: the
kernel worker's vblank pump owns a WebGL2 context on the canvas and
presents the currently scanned-out framebuffer (the fb latched by the
most recent `PAGE_FLIP`) as a texture draw — the DRM XRGB8888 → RGBA
swizzle happens in the fragment shader and the scaling on the GPU
(trilinear over a per-frame mip chain, so a downscaled desktop doesn't
shimmer). A runtime GPU-compositing failure tears the compositor's EGL
session down, which hands the canvas back to the pump presenter
(`markKmsCanvasGlReleased`) so the desktop keeps painting. A browser
GPU-process crash is detected on the same chain: when the canvas
context is lost, `host_gl_present` fails the guest's `eglSwapBuffers`
with `EIO`, the compositor degrades to CPU compositing, and EGL
teardown returns the canvas to the pump. The kernel worker installs
`webglcontextlost`/`webglcontextrestored` listeners when the canvas is
attached (`hookKmsContextLoss`) — not lazily at presenter build — so
the loss event is cancelled and the browser restores the context even
when the compositor's GL session owned the canvas at loss time; the
rebuilt pump presenter then finds a live context. Both crash rounds
(compositor-owned, then pump-owned) are gated by
`apps/browser-demos/test/kandelo-kms-context-loss.spec.ts`. The rebuilt
presenter inherits the dead session's WebGL2 context — `getContext`
returns the existing one — so it restores the state its draw depends on
rather than assuming fresh-context defaults. Pixel-store state matters
most: a leftover `UNPACK_ROW_LENGTH` or a still-bound
`PIXEL_UNPACK_BUFFER` makes every scanout upload `GL_INVALID_OPERATION`,
which raises no JS exception, so the pump would report presents onto a
black canvas. Six unpack parameters and the `PIXEL_UNPACK_BUFFER`
binding are reset on every rebuild, and
`host/test/dri-kms-stats-sab.test.ts` pins each reset individually
against a fake GL. That fake cannot see a rejected upload. The
real-context gate that could — `kandelo-kms-presenter.spec.ts` — is
deleted, because its fixture worker reached the kernel worker through a
writable instance property and a `tickVblank` cast, and the sealed
instance and the `#tickVblank` private field refuse both.
`kandelo-kms-context-loss.spec.ts` does run on a real context, but it
needs the built desktop binaries and the browser-demo CI job runs a bare
checkout with no binary fetch, so it cannot take the vacated CI slot.
Until that fixture is rebuilt on
`createCentralizedKernelWorkerTestDouble`, no automated gate proves a
rebuilt presenter's uploads are accepted. A
main-thread ResizeObserver reports the pane's device-pixel size so the
presenter renders at display resolution instead of letting the page
compositor rescale an fb-sized bitmap; any letterbox is drawn in GL
with the same contain math the pane's pointer mapping uses.

The desktop itself also fills the pane. A machine declaring
`kms-gl-scanout` mounts its display pane as soon as the kernel is
attached — hidden while booting, but laid out, so it has its real size —
and the boot flow waits for that pane's first size report before starting
init or the machine's command. `host_kms_mode_info` then advertises a
preferred mode matching the pane's aspect ratio
(`round(1080 × aspect) × 1080`, width clamped [1440, 3840]). The wait is
bounded at 5 s; a pane that never reports (no layout) leaves the
connector at the 1920×1080 fallback, which the boot log records. wlcompositor
sizes its scanout from that mode and its placement rules are
edge-anchored (wlterm left, wlclock/wlpaint offsets from the right
edge), so wider panes spread the demo across the full width with no
black bars. The mode is fixed at boot — resizing the browser window
afterwards letterboxes rather than re-modes.

Because the mode is device pixels, a HiDPI pane gets a mode larger than
its CSS box, and nothing in the mode says which of the two it is.
wlcompositor takes the integer `wl_output` scale separately, as
`WLC_SCALE` (clamped 1–3) in its environment, and then keeps two grids: the mode sizes every
scanout, GBM bo, EGL surface and GL viewport, while the mode divided by
the scale is the logical grid clients lay out in. `wl_output.mode`
stays device pixels; `wl_output.scale`, `xdg_output`'s logical size and
`wp_fractional_scale`'s preference (scale × 120) all follow the scale.
A client that honours `wl_surface.set_buffer_scale` attaches a buffer
that covers its window 1:1 and blits without resampling; one that
ignores it is upscaled — soft, but correctly sized.

**The scale comes from the display's physical size.** The page reports
the pane's size twice: in device pixels (the mode) and as a physical size
in millimetres derived from its CSS box — CSS defines 96 px per inch, so
this is the browser's reference size, not a measured panel. The kernel
reports that size on the DRM connector (`mm_width`/`mm_height` from
`DRM_IOCTL_MODE_GETCONNECTOR`, filled from the `host_kms_connector_mm`
import), exactly where a real connector carries its EDID size. Without
`WLC_SCALE`, wlcompositor derives its output scale from it the way
Hyprland's `auto` scale does: the mode's pixels per 96th of an inch,
rounded and clamped to 1–3. A 2× Retina pane gets scale 2 and a 1× pane
scale 1, and the boot log's `WLC_SCALE n source=connector` line says
which. A host with no display (Node) reports 0×0, which keeps scale 1.
The compositor still sends a 0×0 physical size in `wl_output.geometry`
(see foot below), so the DPI only reaches clients as the integer scale.

The desktop's own clients honour it, and none of them had to change to.
libwpkdraw carries the scale instead: `wpk_set_scale()` is a
process-wide setting that `wpk_surface_wrap()` and
`wpk_font_load_default()` capture at call time, every primitive
multiplies its logical coordinates by it, and glyphs are rasterized at
`px * scale` rather than magnified. Metrics — `wpk_text_width()`,
`wpk_font_ascent_px()` — stay logical, so an app's layout is untouched.
libkwl reads `wl_output.scale`, calls `wpk_set_scale()` before any
buffer or font exists, allocates its wl_shm buffers at
`logical × scale`, and sends `wl_surface.set_buffer_scale`. wlterm,
wlclock, wlpaint, klauncher and notify-send are sharp on a HiDPI pane
without a single changed coordinate. wlcompositor never calls
`wpk_set_scale()` — it composites in device pixels already — so its own
drawing multiplies by `g.scale` by hand instead. Its gradient wallpaper
(the fallback when a theme names no image) does that for the grid pitch,
the two font sizes and every text offset.

A third-party client learns the scale from `wl_surface.enter`, which
names the output the surface is on, and it makes that decision once —
before it draws. So the compositor sends the enter when a surface takes
a role (`xdg_surface.get_toplevel`, or a layer surface's first commit),
not when the surface maps. Map is a frame too late: the buffer being
mapped was already drawn at the wrong scale, and for a mako toast one
frame is the whole life of the surface. A client that binds `wl_output`
only after its surface has a role still gets the enter at map.

A layer-shell surface also renegotiates its size after that first
configure — mako recomputes its toast one pixel shorter once it knows
the scale — so every commit of a layer surface re-applies its
double-buffered shell state (size, anchor, margins, exclusive zone,
layer) and answers with a fresh configure when the resolved box moved.
Applying it only on the first commit left mako waiting forever for a
configure that never came, and the toast never appeared.

libkwl also caps an initial window at half the output's width and
three-fifths of its height, scaling both axes by the tighter ratio. A
toolkit client picks its initial size as a constant, and a constant
that suited a 2255×1080 desktop covers nearly all of a 1280×613 one;
the compositor clamps a floating window's position but not its size.
On a desktop roomy enough for the constant this changes nothing.
`host/test/wlcompositor-output-scale-smoke.test.ts` and
`host/test/mako-smoke.test.ts` gate the scaled path at `WLC_SCALE=2`.

The Omarchy themes paint gradient wallpapers for now. Each
`theme.conf` names its two gradient colours (`wallpaper_top`,
`wallpaper_bottom`), and the compositor draws the gradient at the
output's resolution. wlcompositor also supports image wallpapers: a
theme's `wallpaper = <file>` names a KWLP raw-pixel image, which it
centre-crops to the output's aspect and then scales
(`host/test/wlcompositor-theme-smoke.test.ts` covers it), but the shell
image does not ship any. **Short-term follow-up:** ship each theme's
real Omarchy background. The images must come from upstream as sourced
inputs (URL, sha256, license) and be converted to KWLP in the
`wayland-demo` package build. Previously the page decoded them at boot,
which does not exist once machines are declared by the image. Staged at
source resolution (capped at 3840 per axis), the six backgrounds cost
about 49 MB of VFS, so they belong in a lazy archive rather than the
eager image.

Pump presents are change-driven (kernel commit count, with a ~15 Hz
strided-checksum content probe as a backstop) rather than
unconditional at 60 Hz, and a presenter that detects software-GL frame
times (headless Chromium) drops to plain bilinear. The Modeset status
chip appends the active renderer (`webgl2-gl` / `webgl2` / `2d`, from
stats slot 7). The legacy `mode: "2d"` CPU blit (`putImageData` + CPU
swizzle) remains available. GL demos (modeset, sdl2) keep the WebGL2
bridge instead and the pump never touches their canvas.

Interactions, all end-to-end through the compositor:

- **Typing** — `BrowserInputSource` writes keystrokes to `event0`;
  the compositor's libinput picks them up and routes them to the
  keyboard-focused window (wlterm, which echoes through the pty).
- **Window drags** — pressing a CSD titlebar triggers
  `xdg_toplevel.move`; the compositor grabs and the window tracks the
  pointer until release.
- **Drag-painting** — pointer strokes inside wlpaint's canvas paint
  through `wl_pointer` motion events.
- **Pointer** — the Modeset pane maps the host pointer absolutely
  onto the desktop (EV_REL peg-and-jump emulation into
  `event1`; the compositor coalesces each input batch into one repaint
  and treats the peg frame as position-only so the artifact never
  renders). The compositor draws **no software cursor**: the host
  pointer is already visible and mapped 1:1, so a sprite would sit
  exactly under it. The desktop is letterboxed aspect-true into the
  pane (by the presenter's GL viewport in `webgl2-scanout` mode,
  by CSS `object-fit: contain` in the legacy modes) and pointers map
  through the fitted content box using the kernel-reported scanout
  dimensions (stats slots 2/3 — the placeholder canvas's `width`
  attribute tracks the committed display-sized bitmap, not the fb).

Regression gates: `apps/browser-demos/test/kandelo-wayland.spec.ts`
(client connection, the `WLC_RENDERER gpu` marker proving GPU
compositing engaged, typing, window drag, drag-paint liveness via the
PAGE_FLIP counter, and flicker stability via canvas PNG-size
distribution) and the node-side twins under `host/test/wl*-smoke.test.ts`
(including `wldesktop-liveness-smoke.test.ts`).

### Hyprland tiling demo

**Not in the shell image by default.** The Omarchy desktop below is the
same tiling compositor with a desktop shell on top, so the shell image
carries only that one; the `wayland-demo` package still builds the
Hyprland launcher (`hyprdesktop`) and its config
(`hyprland-wlcompositor.conf`) as runtime files for an image that wants
it. As packaged, the Hyprland tiling machine boots the same `wlcompositor`
binary as a Hyprland-class tiling window manager (the floating Wayland desktop
above is its default layout). The image declares one command,
`/usr/local/bin/hyprdesktop`, which starts the compositor with
`WLC_LAYOUT=dwindle` and the image's hyprland.conf-shaped
`/usr/share/kandelo/hyprland/wlcompositor.conf` (named by `WLC_CONFIG`),
waits for its socket, then starts three real clients — one `wlclock` and
two `wlterm` terminals. The foreground terminal's exit ends the desktop.

- **Dwindle tiling.** Every mapped window is retiled into gapped, borderless
  frames by recursively splitting the remaining region along its longer side
  (Hyprland's dwindle default), across nine 1-based workspaces.
- **Client-side resize (the crux).** The compositor composites each surface
  at its native buffer size — it does not scale a window to its tile — so
  tiling requires the *client* to resize. On each retile the compositor
  sends `xdg_toplevel.configure(w,h)`; the libkwl clients rebuild their
  `wl_shm` buffers to match and redraw (`wlclock` recomputes its dial,
  `wlterm` reflows its VT100 grid via `TIOCSWINSZ` + `SIGWINCH`, `wlpaint`
  reallocates its canvas so the toolbar + drawing area fill the whole tile
  instead of a fixed 640×420 corner). Floating clients ignore the initial
  `configure(0,0)`, so the floating Wayland desktop is unchanged.
- **Server-side decorations.** Under `dwindle` the compositor negotiates
  `SERVER_SIDE` decorations, so tiled windows have no titlebar (a floating
  layout keeps client-side CSD).
- **Keybinds.** `Return` launches a terminal, `W` kills the focused window,
  and `1..9` switch workspaces — bound on both `SUPER` (real Hyprland) and
  `CTRL` in the image's `wlcompositor.conf`. Use **`CTRL`** in the browser:
  the OS/browser reserve `SUPER` (Cmd/Win) — `Cmd+W` closes the tab,
  `Cmd+1..9` switch browser tabs — so those never reach the page, while
  `Ctrl+…` does. The compositor also supports move-to-workspace, focus
  cycling, and a `kwlctl` control socket (the `hyprctl` analog), which this
  demo doesn't bind — see architecture.md.
- **New-pane launch keybinds.** Opening a new pane is done Hyprland-style —
  each app has its own `exec` bind rather than a launcher/`rofi` UI:
  `Return`→`wlterm`, `K`→`wlclock` (K as in clo**K** — see the caveat),
  `P`→`wlpaint` (again on both `SUPER` and `CTRL`). Pressing the combo makes
  the compositor `posix_spawnp` the binary from `/usr/local/bin`, and the new
  client tiles into the layout. Unlike on the Wayland desktop, `wlpaint`
  is not started in the initial layout, so `Ctrl+P` is how you summon it.
  **Caveat:** the compositor grabs a bound combo before the focused client,
  so a `CTRL`+letter launch bind shadows the terminal's like-named control key.
  The clock is bound to `K` (not `C`) precisely to leave `Ctrl+C` (SIGINT) to
  the terminal; `Ctrl+W` (killactive) does still shadow `wlterm`'s werase.
  That is the cost of using `CTRL` as the WM modifier in-browser; a real
  Hyprland session on `SUPER` has no such clash.

See
[architecture.md](architecture.md#tiling-window-manager-wlc_layout-workspaces-kwlctl-keybinds).
The tiling paths are gated node-side by
`host/test/wlcompositor-{tiling,resize,kwlctl,keybind,decoration}-smoke.test.ts`
and in the browser through the Omarchy machine
(`apps/browser-demos/test/kandelo-omarchy.spec.ts`, including the
eight-window launch storm that guards the kernel's SCM_RIGHTS fd delivery).

### Omarchy desktop demo

The Omarchy-style desktop machine (`?vfs=<shell image>&profile=omarchy`)
is the tiling desktop above plus the shell that makes it a desktop: a
wallpaper, a status bar, a launcher, notifications, an on-screen display,
a lock screen, and themes. Omarchy is not a program but a set of files
layered over Hyprland, and Omarchy v4 folds its shell — what used to be
swaybg, Waybar, Walker, mako, SwayOSD, hyprlock and hypridle — into one
Quickshell QML process. This machine does the same: it is the same
`wlcompositor` binary with its own
`/usr/share/kandelo/omarchy/wlcompositor.conf`, `.desktop` entries under
`/usr/share/kandelo/applications`, the shell's QML under
`/usr/share/kandelo/quickshell`, and six themes under
`/usr/share/kandelo/themes`. All of it is image data: the `wayland-demo`
package builds it into `kandelo-desktop-data.zip`, which the shell image
registers as a verified lazy archive under `/usr/share/kandelo`. Its first
file read downloads the archive; later reads reuse it. The image declares
one command,
`/usr/local/bin/omarchydesktop`, which starts a `dbus-daemon` session bus
and the compositor, waits for both sockets and the compositor's Hyprland
IPC socket, then starts **Quickshell 0.3.1** on the image's `shell.qml`.
Nothing is staged by the page.

The desktop comes up bare: wallpaper and bar, no windows. As in Omarchy,
the diamond at the bar's far left opens the Omarchy menu on click, so the
launcher is reachable without a keyboard shortcut. The desktop draws no
cursor of its own, so the browser's pointer stays visible over it
(`hostPointer`). Every client is one the user opens, through the binds
below or the launcher. The demo stays alive on the compositor's own
process rather than on a foreground terminal.

The shell reaches the compositor three ways, each a protocol real Hyprland
serves: **hyprland-global-shortcuts-v1**, so a `bind = SUPER, space,
global, quickshell:launcher` line in the compositor's config fires the
shortcut the shell registered under that name (the shell never sees the
key, only the press and release); the **Hyprland IPC** socket pair at
`/tmp/hypr/wlcompositor/` — `j/`-prefixed JSON queries and the
`event>>data` stream — for workspaces, the focused window, `dispatch exec`
and `dispatch theme`; and **ext-session-lock-v1** and
**ext-idle-notify-v1** for the lock screen and the idle monitor. The
QML engine renders through the scenegraph's software adaptation
(`QT_QUICK_BACKEND=software`, which `omarchydesktop` exports to the whole
desktop), and every window of the shell is a wlr-layer-shell surface.

- **The wallpaper.** A background-layer surface painting the theme's
  gradient, with the keybind hints, over the compositor's own wallpaper
  (`Wallpaper.qml`). It is swaybg's place: a client, not the compositor,
  owns what the desktop shows behind the windows.
- **The bar.** A top-layer surface anchored across the top with an
  exclusive zone, so the windows tile *under* it rather than behind it
  (`Bar.qml`). The Omarchy diamond, five workspaces (the focused one in
  the accent colour, occupied ones in the foreground colour), the clock,
  and the focused window's title. Workspaces and the title come from the
  `Hyprland` singleton of Quickshell's Hyprland module, which reads
  `j/monitors`, `j/workspaces` and `j/clients` from the request socket and
  follows `workspacev2`, `openwindow`, `activewindowv2` and the rest on
  the event socket — exactly as it would under Hyprland.
- **Notifications.** The shell's `NotificationServer` owns
  `org.freedesktop.Notifications` on the `dbus-daemon` session bus
  (`Notifications.qml`), through QtDBus linked against the registry's
  `libdbus`. A theme switch reaches `notify-send` through the config's
  `notify =` hook — a real `org.freedesktop.Notifications.Notify` call
  over the bus, which the shell renders as a card in the top-right corner
  that expires after five seconds or on click. The bus address
  (`DBUS_SESSION_BUS_ADDRESS`) is in every desktop process's
  environment, so `notify-send` also works from any terminal.
- **The launcher.** `Ctrl+Space` opens the launcher (`Launcher.qml`), an
  overlay-layer surface that takes the keyboard exclusively — so what you
  type filters its list instead of reaching the terminal underneath. Type
  to narrow, `Up`/`Down` to move, `Enter` to launch (`dispatch exec` over
  the Hyprland IPC: the compositor spawns it and it tiles in), `Esc` to
  dismiss. Entries are the `.desktop` files under
  `/usr/share/kandelo/applications`, read by Quickshell's `DesktopEntries`
  from `XDG_DATA_DIRS`. The registry offers real software from the shell
  image alongside the demo clients: Vim, NetHack and Nano run unmodified
  inside foot (their binaries lazy-fetch from the image's archives on
  first launch), as does the terminal `Ctrl+Return` opens. foot rather
  than `wlterm`: `wlterm` advertises `TERM=vt100` but does not implement
  the VT100 line-drawing character set, so curses borders come out as
  letters. foot is stock upstream foot 1.17.2, a Wayland client of its own
  on the ported font stack — freetype/fontconfig/fcft rasterizing the
  image's Inconsolata through `/usr/share/kandelo/fonts/fonts.conf`
  (`FONTCONFIG_FILE`) — not a `wlterm` wrapper (see
  [architecture.md](architecture.md#stock-upstream-clients-foot--the-font-stack)).
  The Theme Gallery entry is a Qt client: a `QRasterWindow` from the
  `qtgallery` package, painting one card per installed theme — each a
  miniature desktop rendered from that theme's own `theme.conf` palette —
  through QtGui's raster engine and the wayland QPA plugin onto `wl_shm`,
  antialiased where the wpkdraw clients are not. Clicking a card (or
  arrows + Enter) writes `dispatch theme <name>` to the compositor's
  kwlctl socket, and the whole desktop restyles. It reads the same
  `/usr/share/kandelo/fonts/fonts.conf`, which aliases `sans-serif`
  alongside `monospace` to the image's Inconsolata for it. `Esc` or `Q`
  closes it.
- **The menu.** `Ctrl+Alt+Space` opens the Omarchy menu — the same
  launcher at its root level (Apps, Theme). `Enter` descends; the Theme
  submenu lists the installed themes and `Enter` switches live. `Esc` in a
  submenu goes back to the root; `Esc` at the root dismisses.
- **The on-screen display.** A short-lived pill above the bottom edge
  (`Osd.qml`) names what just changed — the theme, on a switch. SwayOSD's
  volume, brightness and caps-lock triggers have no source on this
  machine: the kernel exposes no mixer or backlight, and the compositor
  reports no lock-key state.
- **The lock screen.** `Ctrl+Escape` locks the session (`LockScreen.qml`)
  through ext-session-lock: the compositor blanks the output, renders only
  the lock surface (the clock, the user, a password field), gives it the
  keyboard, and sends `locked` once a blanked frame has flipped. The
  password goes to `login -c maker`, the image's own credential check
  against `/etc/shadow` (the demo user's password is the one the login
  machine documents); on success the shell sends `unlock_and_destroy` and
  the desktop returns, otherwise the field clears and the session stays
  locked. If the shell dies while locked, the compositor keeps the session
  locked, as the protocol requires. An `IdleMonitor` on ext-idle-notify
  locks the session after ten minutes without input — hypridle's job.
  hyprlock authenticates through PAM; there is no PAM here, and `login -c`
  is the same `crypt(3)` check the image's login program runs.
- **Themes.** `Ctrl+Shift+Space` cycles Tokyo Night, Catppuccin, Gruvbox,
  Nord, Everforest and Rosé Pine. One palette file drives the whole
  desktop at once: the compositor's window borders, gaps and wallpaper,
  and everything the shell draws. The compositor emits `theme>><name>` on
  its event socket, the shell re-reads that theme's `theme.conf`
  (`Theme.qml`), and its wallpaper, bar, launcher, cards and lock screen
  take the new palette; the `notify =` hook runs `notify-send`, so the
  switch also shows as a notification. The themes paint gradient
  wallpapers; their real Omarchy backgrounds are a short-term follow-up
  (see the wallpaper note in the Wayland section above).
- **The rest of the keybinds:** `Ctrl+Return` a terminal, `Ctrl+K` a
  clock, `Ctrl+P` a paint canvas; `Ctrl+W` or `Ctrl+Shift+W` closes the
  focused window (the second form leaves a terminal's `Ctrl+W` word-erase
  alone, since the compositor takes a bound key before the client sees
  it); `Ctrl+1..9` switches workspace and `Ctrl+Shift+1..9` moves the
  focused window there; `Ctrl+J` / `Ctrl+Shift+J` cycle focus; and
  `Ctrl+Shift+arrows` swaps the focused window with its neighbour in that
  direction (Hyprland's `swapwindow`, Omarchy's `Super+Shift+arrows`).
  Every bind is mirrored on `SUPER`, as Omarchy binds them; use `CTRL` in
  the browser, which reserves `SUPER` (see the caveat above). Tiled
  windows receive xdg-shell's `tiled_*` states, so a client that keeps
  its own size when floating — SDL, and so ScummVM — takes the tile's.
- **Copy and paste inside the desktop.** The compositor keeps a real
  Wayland clipboard, so text copied in one window pastes in another.
  Omarchy's universal-clipboard binds are in the image: `Super+C` copies,
  `Super+V` pastes, `Super+X` cuts and `Super+A` selects all. Each sends
  the focused window the application's own shortcut — `Ctrl+C`/`Ctrl+V`,
  or `Ctrl+Shift+C`/`Ctrl+Shift+V` for a window tagged `terminal` (foot,
  by its app id, through the same window rule Omarchy uses). On macOS
  these are `Cmd+C`/`Cmd+V`/`Cmd+X`/`Cmd+A`: Cmd reaches the desktop as
  Super, and the page keeps those four keys from the browser. Only `V` is
  also bound on `Ctrl`, so `Ctrl+V` pastes on Windows and Linux too. That
  costs a terminal its literal-next key (`^V`); `Ctrl+C` is deliberately
  not bound, so it still sends SIGINT. The chords Linux and Windows users
  expect are bound too: `Shift+Insert` pastes and `Ctrl+Insert` copies,
  routed by the same terminal tag. In foot, select text with the mouse,
  then `Cmd+C`, `Ctrl+Shift+C` or `Ctrl+Insert`, and paste with `Cmd+V`,
  `Ctrl+V`, `Ctrl+Shift+V` or `Shift+Insert`. Today foot is the only client on this desktop that reads the
  clipboard; the Quickshell shell and the Qt gallery take no pasted
  text.
- **Paste from your own clipboard.** Text copied anywhere on your
  computer pastes into the desktop with the same chord: `Cmd+V` on macOS,
  `Ctrl+V`, `Ctrl+Shift+V` or `Shift+Insert` elsewhere. The page lets the browser's own paste happen, hands
  the text to the machine (through `/dev/kandelo/clipboard` to `kclipd`,
  which makes it the desktop's selection), and only then delivers the
  chord, so the focused window pastes the new text; keys typed meanwhile
  wait behind it. Line endings are converted to LF. The browser never
  asks for clipboard permission, because the text comes from the paste
  you made, and the page reads the clipboard only then. If the text
  cannot be delivered — no agent running, over 1 MiB, or no answer within
  two seconds — a toast in the desktop pane says why, and the chord and
  the keys typed while it was pending are discarded rather than typed
  into the window. Pasting the same host text twice in a row pastes the
  desktop's current selection instead, so a copy made inside the desktop
  since then is kept.
- **Copy to your own clipboard.** A copy chord over the desktop —
  `Cmd+C`/`Cmd+X` on macOS; `Ctrl+Shift+C`, `Ctrl+Insert`, `Ctrl+C` or
  `Ctrl+X` elsewhere — puts what the focused window copies on your
  computer's clipboard. The page starts the clipboard write on the
  chord's keydown and waits up to two seconds for the desktop's new
  selection (reported by `kclipd`); if nothing is copied in that time —
  `Ctrl+C` in a terminal is SIGINT, not copy — your clipboard keeps what
  it had. Only copies made with one of these chords reach your clipboard:
  a copy made from a menu with the mouse stays inside the desktop, and so
  the earlier catch remains for it (copying X on the host, Y from a menu
  in the desktop, then X on the host again pastes Y). Chrome may reserve
  `Ctrl+Shift+C` for its developer tools when they are open; use
  `Ctrl+Insert` then. The write uses a `ClipboardItem` whose text is a
  promise, created during the keydown, because the text arrives after the
  gesture; browsers without `ClipboardItem` fall back to `writeText` once
  the text arrives, which a browser may refuse outside the gesture (the
  Internals log says so). Automated tests cover Chromium; other engines
  are verified by hand.

polkit-gnome has no counterpart here: the machine runs no polkit, so
there is no authentication agent to replace.

#### What is not real yet (deferred work)

The Omarchy machine is an honest imitation in two places, and the gaps
visitors notice come from them. They are recorded here as near-term
follow-ups, not as the end state.

- **The compositor is Kandelo's `wlcompositor`, not Hyprland.** It
  implements the subset of Hyprland the desktop needs — dwindle tiling,
  workspaces, a config-driven bind table, a hyprctl-shaped IPC socket
  that Quickshell's Hyprland module talks to, and the global-shortcut,
  session-lock and idle-notify protocols the shell needs — and every
  behaviour it lacks
  is behaviour real Hyprland has (popups and tooltips, window swapping
  beyond `swapwindow`, animations, the full dispatcher set). **Deferred:
  port real Hyprland.** It needs platform work first: Hyprland renders
  only with OpenGL ES 3 through its `aquamarine` backend, so Kandelo's EGL
  must import dmabufs as EGLImages and provide fence/explicit sync over
  the WebGL2 bridge; aquamarine expects KMS properties, planes and an
  EDID blob from the kernel's connector; and it opens devices through
  libseat and enumerates them through libudev, which here is a stand-in
  with no `/sys` device tree behind it. A wlroots-based compositor with
  its pixman software renderer is the fallback if the EGL work proves
  too large. The dependency graph, each platform gap and a build order
  are in `docs/plans/2026-09-30-real-hyprland-port-inventory.md`.
- **The shell is this repository's QML, not Omarchy's.** Omarchy v4's
  Quickshell configuration is written against real Hyprland and against
  services this machine does not run (PipeWire, UPower, NetworkManager,
  Bluetooth, the system tray). The shell in
  `packages/registry/wayland-demo/desktops/data/quickshell/` plays the
  same roles — wallpaper, bar, launcher and menu, notifications, OSD,
  lock screen, idle monitor — on the same protocols and the same
  Quickshell modules, but it is Kandelo's own configuration. **Deferred:**
  run Omarchy's shell files themselves, once the Hyprland port and the
  services they read exist.

Smaller gaps, each a follow-up:

- **Clipboard gaps.** Copies made without a copy chord (from a menu)
  stay inside the desktop. Touch devices cannot copy or paste between the
  desktop and the host: iOS and iPadOS have no paste chord, and selecting
  text and using the system copy menu is future work in
  `docs/superpowers/specs/2026-10-01-omarchy-clipboard-paste-design.md`.
  Also missing: the clipboard manager Omarchy opens on `Super+Ctrl+V`,
  drag-and-drop, the primary (middle-click) selection, and text formats
  other than plain text.
- **No `xdg_popup`**, so tooltips and menus are refused:
  `xdg_surface.get_popup` is a protocol error for the requesting client
  (its positioner is a real object, so the refusal never takes the
  compositor down). Popup support is a follow-up.
- **Super needs fullscreen keyboard lock.** Omarchy binds everything on
  Super; browsers keep Cmd/Win (Cmd+W closes the tab), so every bind is
  mirrored on Ctrl, which shadows terminal keys such as Ctrl+W. Chromium's
  Keyboard Lock API would let a fullscreen pane receive the real Super
  bindings; Safari and Firefox lack it.
- **`wlterm` advertises `TERM=vt100` without the VT100 line-drawing
  set**, so curses borders print as letters in it (the desktop's
  terminal entries use foot, which has it).
- **No xkb data in the image** (`/usr/share/X11/xkb`): GTK clients log
  that they cannot compile a keymap from names. They receive the
  compositor's keymap, so input works.
- **NetHack's curses interface does not redraw at its intro prompt after
  a resize** (upstream behaviour; the resize itself reaches it — `Ctrl+R`
  redraws).
- **Theme wallpapers are gradients** (see the Wayland section).

#### Quickshell QML limits

One host cost bounds Quickshell in the browser: compiled wasm code.
`quickshell.wasm` is 82 MB (82,203,777 bytes: a MinSizeRel build with the
QtDBus, Hyprland, session-lock and socket modules the shell uses) and
Chromium compiles it to hundreds of MB of machine code, on top of the
running desktop (compositor, qtgallery, foot, dbus-daemon). An earlier
version of this section said every Web Worker compiles its own copy
because isolates do not share a posted module's code. Measurement does
not support that: one `WebAssembly.Module` posted to several workers
shares its machine code in V8 and JavaScriptCore, and only a separate
compilation of the same bytes makes another copy (see
[architecture.md](architecture.md#compiled-module-sharing)). The kernel
worker compiles each distinct program once while a copy is alive and posts
that module to every process and thread worker that runs it. A guest
pthread runs the thread-patched variant of the program's bytes, which is a
second module: compiled once per program, then shared by every thread of
every process running those bytes.

Two facts about this cost were established by measurement on the earlier
single-panel shells, and they still decide what a shell may do:

- It is **not** a guest leak. The guest process holds a flat ~55 MB
  through a 50/s repaint storm on the Node host; only the browser tab's
  native memory grows.
- The **worker count multiplies** the cost, and the **QML content decides
  the per-worker amount**. More workers move the whole tab up (before the
  thread cuts below, 13→17 workers moved the tab from ~4 GB to its ~10 GB
  ceiling). Independently, a content-heavy shell compiles more cold Qt/ICU
  code in every worker: a nested-item panel with localized
  `Qt.formatDateTime` name fields (`dddd`, `MMMM`) mapped at ~9 GB where
  a single-item numeric shell settled at ~5 GB with the same worker count.
  Both the worker count and the shell content are real; neither alone is
  the whole story.

The port keeps every helper thread of a Qt client on the main thread, so
the shell process is one worker and one compiled copy:

- **No Qt helper threads.** The QML type loader runs synchronously
  (`FEATURE_qml_type_loader_thread=OFF` in `build-qtdeclarative.sh`, Qt's
  own single-threaded wasm shape), Quickshell's logger runs on the main
  thread (`packages/registry/quickshell/src/on-thread-logger-on-wasm.patch`),
  the Wayland QPA pumps the display fd from a `QSocketNotifier` on the
  main loop instead of its two reader threads
  (`packages/registry/qtbase/src/wayland-fd-notifier-on-wasm.patch`), and
  QtDBus's connection manager lives on the main thread, its blocking
  queued calls made direct and `waitForFinished` blocking in libdbus
  (`packages/registry/qtbase/src/dbus-manager-on-thread-on-wasm.patch`).
  The scene graph renders in software on the main thread
  (`QT_QUICK_BACKEND=software`, set by `omarchydesktop`).

- **No thread-pool work from the shell.** `Theme.qml` reads theme files
  with `FileView { blockAllReads: true }`: an asynchronous read runs on
  Qt's thread pool, and `blockLoading` only blocks the first read.
  Quickshell's desktop-entry index scans synchronously at start; only a
  rescan after a change under an `applications/` directory uses the pool,
  and nothing on the machine writes there while the desktop runs.

- **A watcher that actually fires.** The kernel used to stub
  `inotify_init` with a fake-success fd that never delivered events,
  which silently disabled the file watching Qt's `QFileSystemWatcher`
  (and glib's `GFileMonitor`) rely on — both only fall back to their
  polling engines when `inotify_init` *fails*. The stubs now return
  `ENOSYS` and the pollers work everywhere.

Measured with the shell in
`packages/registry/wayland-demo/desktops/data/quickshell/` — wallpaper,
a bar with five workspaces, the window title and a numeric clock, the
launcher and menu, notification cards, the OSD and the lock screen —
through the full gate list of `kandelo-omarchy.spec.ts`, which also
runs qtgallery and three foot terminals beside the shell. The figures
are the peak resident size of the page's content process, sampled every
5 s on macOS:

| Engine | Content process | Peak resident size |
|---|---|---|
| Chromium | renderer | 5.2 GB |
| Firefox | content process | 5.1 GB |
| WebKit | WebContent | 7.1 GB |

Two things still bound what a shell may do:

- **Content-heavy shells.** A panel with nested items, a localized
  `Qt.formatDateTime` name field (`dddd`, `ddd`, `MMMM`, `MMM`), or
  `font.bold` (synthesized, since the image ships only a regular
  Inconsolata face) compiles extra cold code in the shell's worker. The
  bar keeps numeric date fields and the regular weight.
- **Any thread.** A `pthread_create` from Quickshell — a helper thread
  re-enabled, an asynchronous `FileView` read, a desktop-entry rescan —
  costs a compiled copy on Chromium and WebKit and does not fit on
  Firefox at all (next section).

The compositor reports `KBD_FOCUS layer=<namespace>` only after mapping a
keyboard-interactive layer and sending its keyboard enter event. Launcher
automation waits for that focus marker before typing; Quickshell's own
`LAUNCHER_READY` reports a queued commit and can precede keyboard ownership.
Repeated desktop automation also scopes window focus to the PID in its
latest `KWLCTL_EXEC` record and waits for that client's exit before
launching another window. Older focus and tile records remain in terminal
history and do not establish that a new window is ready to receive input.

Lock-screen automation also waits for `LOCK_INPUT_READY`, emitted when
Qt assigns active focus to the lock's keyboard input item. The compositor's
`LOCK_SURFACE` reports mapping and can precede that client-side transition;
typing immediately on mapping can arrive before the item handles keys.
Both host and browser acceptance checks retain the wrong-password rejection
and locked-session assertions after this readiness gate.

#### Firefox executable-code limit

SpiderMonkey reserves one fixed 2 GiB region per content process for all
JIT and wasm compiled code (`MaxCodeBytesPerProcess`), shared by every
worker on the page. Compiled wasm code is several times the module's
size, so the region holds one compiled copy of `quickshell.wasm` next to
the rest of the desktop, and not two: the first `pthread_create` in
Quickshell compiles the thread-patched module as a second full copy (once
per program; later threads reuse it), the compile
throws SpiderMonkey's `InternalError: out of memory`, Qt logs
`QThread::start: Thread creation error`, and the surface that thread was
for never maps. This is an engine limit, not a memory shortage — the
process RSS stays far below the machine's capacity when it hits. Chromium
and WebKit have no fixed per-process code cap.

The thread cuts above are what make the desktop fit. The shell process
creates no thread, so the region holds one copy of it, and the Omarchy
spec runs every gate — bar, launcher, Qt gallery, theme switch,
notifications, menu, workspace switch, lock and unlock — on Firefox as
on Chromium (`kandelo-omarchy.spec.ts`, `--project=firefox`, both
tests, run by hand: CI runs the spec on Chromium only). The content
process peaked at 5.1 GB resident during that run.

The spec reads only the terminal rows on screen, and a theme switch
prints more lines than the terminal has rows: the compositor retiles on
every layer-surface commit, even when the work area is unchanged, and a
switch re-commits every shell layer. The launcher's `LAUNCHER_THEME`
line can scroll off between two polls, which one Firefox run in three
hit. The gap is in the spec's observation, not the shell; retiling only
when the work area changes is the compositor follow-up that closes it.

WebKit passes the desktop test and fails the launch-storm test: after
the eight `CTRL+K` launches the machine stops presenting frames (the
Modeset badge's flip count freezes) and the terminal never repaints,
while the page itself still answers. It happens only when the test reads
the terminal every 100 ms during the storm, which is what `expect.poll`
does; a hand-run probe that sends the same eight launches and reads the
terminal every 5 s reaches `TILE n=8` in 5 s, and one launch under
100 ms reads is fine. Chromium and Firefox run the same storm under the same polling
and pass. The cause is not traced; it is a WebKit host interaction, not
a shell or compositor behaviour, and it is open.

See
[architecture.md](architecture.md#desktop-shell-zwlr_layer_shell_v1-kbar-klauncher-themes).
Gated node-side by
`host/test/wlcompositor-{layer-shell,theme,shell-protocols}-smoke.test.ts`,
`host/test/quickshell-shell-smoke.test.ts` and in the browser by
`apps/browser-demos/test/kandelo-omarchy.spec.ts`.

Run the browser app: `cd apps/browser-demos && npm run dev`, then open
`http://127.0.0.1:5401/`.

For a manual OSS playback check after changing the port, first run
`./run.sh clean fbdoom && ./run.sh build fbdoom` so an ignored local artifact
from an older package revision cannot be reused. Then run `./run.sh browser`,
select the fbDOOM demo, and click the framebuffer to satisfy the browser's
audio-activation requirement. The title-screen music checks the software OPL
path; starting a game and firing the pistol checks mixed sound effects. Quit
through DOOM's menu to exercise the normal `/dev/dsp` drain-and-close path.
This demo is a direct OSS consumer, not an SDL test; the `sdl-dsp-test` package
and host audio integration suite exercise the unmodified SDL2 and SDL3 `dsp`
backends. That suite also runs SDL_mixer 2.8.2's unmodified `playwave` example
against deterministic WAVs and compares the Node sink's consumed PCM exactly.
Browser output remains a manual audible check because the production
AudioWorklet intentionally exposes transport cursors, not rendered samples.

### ScummVM demo

The ScummVM machine (`?vfs=<shell image>&profile=scummvm`) runs unmodified
upstream ScummVM fullscreen on `/dev/dri/card0`: SDL2's
KMSDRM backend takes DRM master and renders GLES2 straight to the display,
and audio goes through OSS on `/dev/dsp`. The program
(`/usr/bin/scummvm`) and the GUI data the package declares as runtime files
(themes, icons and fonts under `/usr/share/scummvm`) are lazy files in the
shell image, fetched on first use.

Each engine is a separate plugin, `/usr/lib/scummvm/lib<engine>.so`, and
also a lazy file: the SCUMM engine (with its `scumm-7-8` sub-engine) plus
the engine of every freeware game below (Sky, Drascula, DreamWeb, Queen,
God of Thunder, Griffon, Lure, ADL, Parallaction, CGE, CGE2, SLUDGE and
WAGE). ScummVM's own plugin support loads them with `dlopen` in its
"uncached" mode, opening only the one engine a game needs, by engine id
(`sky` → `libsky.so`). Game detection stays in the program, so the launcher
recognizes every game without loading an engine. A machine therefore
downloads the program plus the one engine of the game it plays. SDL2's
`SDL_LoadObject` is the real loader (the `sdl2` package builds with
`--enable-loadso`), and the program links with `--export-all` so a plugin
resolves every function it imports against it; the package build fails if
any plugin import has no export to bind to. The machine's command is
`/usr/local/bin/scummvm`, a small wrapper in the image that:

- names SDL's backends in the environment. Kandelo has no libudev, so
  SDL's evdev layer only finds the kernel's keyboard and pointer when
  `SDL_EVDEV_DEVICES` lists them (the libudev gap is in the register in
  [package-management.md](package-management.md#packages-that-are-not-real-upstream-builds-yet)).
- seeds `~/scummvm.ini` on first launch. ScummVM rewrites its config
  whenever the user adds a game, so it lives in the writable home rather
  than in image content. `gui_scale` stays at ScummVM's default of 100%;
  that key is the user's own multiplier. The display's factor comes from
  SDL: ScummVM sizes its launcher by `SDL_GetDisplayDPI` (its reference
  is 90 dpi, clamped to 1x-4x), and SDL derives the DPI from the
  connector's physical size, which the kernel reports from the pane. SDL2's
  KMSDRM backend has no DPI query upstream, so the `sdl2` package adds
  one (`patches/0002-kmsdrm-display-dpi-from-connector.patch`). On a
  display at twice the reference density the launcher is drawn at about
  twice the size. Game graphics always scale to the display.

The display's dock offers the freeware games the ScummVM project
distributes: **Play a freeware game** opens a menu of them with each
download's size. The rights holders made these
games freeware (Beneath a Steel Sky's licence, the `readme.txt` inside its
archive and kept beside the data, allows free redistribution as long as
that readme and the copyright notices stay intact). Two catalog games are
listed but disabled, with the reason: Broken Sword 2.5 needs Theora video
and Lua, which the build leaves out, and its 859 MB archive does not fit
the machine's filesystem; Helga Deep in Trouble needs the Wintermute
engine's JPEG support.

The catalog is image content.
`packages/registry/shell/scummvm-freeware-games.json` lists each game's
archive URL on `downloads.scummvm.org`, its size, and the SHA-256 the
ScummVM project publishes beside it; the image builder writes it to
`/usr/local/share/scummvm-play/games.tsv`, and fails if the ScummVM
profile's dock menu does not list exactly its games. Each button and menu
entry is a `dockActions` command: it ends the running ScummVM (the
framebuffer pane signals the `/dev/fb0` owner, described below), then runs
`/usr/local/bin/scummvm-play <game>` in the machine's shell. That script
downloads the archive with the machine's own `curl` — in the browser that
goes through the CORS proxy described below, because the site grants no CORS
— reporting a percentage against the catalog size (the guest receives
downloads as chunked responses, so `curl` never learns the total), starts
with one request for smaller archives or 32 MiB ranges above the proxy's 100
MiB response limit. If any request fails, it switches to 16 MiB ranges with
up to three attempts per range. Completed ranges stay downloaded; an
incomplete attempt is discarded before retrying. If the server ignores
ranges on a smaller archive, it retries the full request. It then checks the
SHA-256, unzips into `/usr/share/scummvm-games/<game>`, and deletes the
archive. ScummVM's own `--add --recursive` then finds the game and records
it as a launcher target, and the script starts that target; a collection
(the WAGE games) opens the launcher instead. A failed download or a digest
mismatch stops there with a message in the machine's terminal; nothing is
started from unverified data. `scummvm-play --list` prints the catalog in
the terminal. A game stays unpacked for the rest of the session, so choosing
it again starts it without downloading; nothing persists across a reboot.

No other game ships with the machine: no Kandelo package carries a commercial
SCUMM title. Sending a `.zip` to the machine (**Load game data** in the
display's dock, or a drop) hands it to the machine's scummvm rule (up to
512 MiB), which extracts it into `/usr/share/scummvm-games` while ScummVM
keeps running; the batch's toast says when it is done. ScummVM's "Add Game"
browser opens in that directory. The extracted game must fit the machine's
filesystem, which lives in kernel memory beside everything else guests have
written (a 1 GiB kernel ceiling on desktop browsers, 768 MiB on constrained
ones such as iOS Safari); an extraction that does not fit fails, and the
toast shows it. The pointer is a real absolute device (`/dev/input/event1`
reports `EV_ABS` positions), and the browser hides its own cursor over the
display because ScummVM draws one.

The Omarchy application launcher also offers Pong, Snake, Breakout,
Asteroids, BYTEPATH, and SNKRX. These run as native LÖVE OpenGL windows
through SDL2's Wayland/EGL backend. The compositor retains DRM master and
physical input ownership; the games receive surface-local pointer and
keyboard events, output-scale-aware drawable sizes, focus, resize, and close
events. The four core examples letterbox their playfield, and BYTEPATH and
SNKRX update their canvas/pointer scales on resize. Game files download
lazily when launched. The LÖVE audio source now mixes static Vorbis/WAV effects
and streamed Vorbis music through SDL2's OSS driver on `/dev/dsp`, including
pitch, volume, looping, and independent clones. Core games have generated
sound effects and an M-key mute toggle; BYTEPATH and SNKRX use upstream audio.
The wasm32 package and shell image have been rebuilt. Headless browser tests
check nonzero audio output from all six games, source controls and streaming,
pointer tracking, and repeated machine switching in Chromium, Firefox, and
Playwright WebKit. They require no desktop-control permission. The full native
Safari repeated-switch follow-up remains incomplete. Audio-only programs can
disable both graphics and window modules through `conf.lua` and use Node's
paced headless audio sink; graphical games require an OpenGL ES context that
Node does not provide. Older binaries may still be silent. Browser playback
requires user activation. SDL2 KMSDRM has no system cursor themes; SNKRX keeps the
default pointer when its optional hand cursor is unavailable. Cursor sizing
on high-density displays remains deferred to compositor work.
See `packages/registry/love/README.md` for its compatibility boundaries.

The same wrapper runs ScummVM on the Omarchy desktop, from the launcher or
as `scummvm` in a terminal. When a compositor socket exists
(`$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY`) the wrapper leaves SDL to pick its
Wayland backend, and ScummVM runs as a GL client in a tile. It is told
it is tiled (xdg-shell's `tiled_*` states), so it takes the tile's size,
and its GL buffer is reallocated to that size (the `libwayland-egl` resize
path in [architecture.md](architecture.md#drmkms-devdricard0-devdrirenderd128)).
Its launcher scales with the display there too: the compositor reports
the connector's physical size in `wl_output.geometry`, and SDL's Wayland
backend derives the DPI from it.

Gated in the browser by `apps/browser-demos/test/kandelo-scummvm.spec.ts`
(the GUI data reaches the guest, the config is writable, an upload is
extracted where the launcher browses, and the freeware menu lists the
catalog with its unrunnable games disabled; tagged `@slow`, since they
download through the proxy, the Steel Sky action and a menu entry each
replace the running ScummVM with their game on its engine plugin). The Wayland path is gated by
`apps/browser-demos/test/kandelo-omarchy.spec.ts`: ScummVM launched from
the launcher is tiled, drawn by the GPU path, and commits a buffer of its
tile's size. Pointer input and the launcher's size on a HiDPI display are
checked by hand (Chromium at a device scale factor of 2), because
Playwright's emulated device scale does not change the size the pane
reports.

### Kandelo session UI

The Kandelo app at `/pages/kandelo/` keeps the running machine as the primary
browser canvas and exposes related tools through a bottom dock. Dock controls
switch between Demo, Terminal, and Internals views, while dock panes open for
new-machine setup, gallery browsing, system config, and sharing. These controls
consume `KernelHost` state and actions rather than replacing the runtime path.

The dock may be collapsed or moved horizontally within the browser viewport;
that placement is UI-only presentation state and does not alter the running
machine, boot descriptor, VFS image, or share/export data.

Theme tokens distinguish decorative fills from readable text. `--k-accent` and
the status colors (`--k-ok`, `--k-warn`, `--k-err`, `--k-info`) supply fills,
borders, and indicators; their `-ink` counterparts supply colored text on app
surfaces. Muted and secondary text also derive from the active palette's text
and surface colors. Solid selected controls pair `--kdock-active-fill` with
`--kdock-active-text`; menus and translucent accent controls use surface text.
This applies to the dock, theme picker, gallery, sharing, and inspector UI in
both light and dark mode. `test/theme-contrast.spec.ts` checks these roles and
shared controls at a minimum text contrast of 4.5:1 across all six palette/mode
combinations, including hover, press, and keyboard focus. It also rejects CSS
that uses decorative hues as text or selected-fill text without its solid fill.
Touch controls and display prompts own opaque backgrounds so guest pixels
cannot wash out their labels. Disabled controls and decorative preset glyphs
are outside that text-contrast check.

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
download completed. Both views reset when the kernel is replaced; neither is
persisted as a machine snapshot.

Cross-origin browser fetches are routed through `public/service-worker.js`,
which defaults to `https://wordpress-playground-cors-proxy.net/?`. Only GET
and HEAD requests are wrapped in the proxy: the proxy exists to make
CORS-less read-only resources readable under COEP, and its only POST
authority is the reviewed `git-upload-pack` boundary, which targets the proxy
URL deliberately. Requests with any other method go directly to their target,
including guest HTTP requests issued by controlled kernel workers, so that
server must grant CORS itself. A CORS-less POST fails at the browser's CORS
boundary; the service worker cannot make it readable. Override the proxy with
`VITE_CORS_PROXY_URL` when testing another proxy:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

An explicit guest `BrowserKernel({ corsProxy })` configuration already directs
requests to the proxy in `NetworkIO`. Those deliberate requests keep their
existing route and header policy. The GET/HEAD automatic-wrapping boundary
applies to unwrapped page and worker requests, including guest fetches from
an embedder without an explicit backend proxy.

Proxy prefixes ending in a bare `?` receive raw target URLs; `?url=`-style
prefixes receive percent-encoded targets.

`BrowserKernel({ corsProxy })` applies one complete immutable proxy profile to
two independent browser transports: guest HTTP(S) requests and external lazy
VFS files or archives. Same-origin lazy assets still use direct `fetch()`. This distinction
matters in a cross-origin-isolated page: lazy materialization must read the
response bytes, so an external response must grant CORS. A CORP header can
satisfy a COEP embedding check, but it does not make an opaque no-CORS response
body readable to JavaScript. Public release assets do not necessarily grant
CORS even though an ordinary command-line client can read them. An explicit
`closedLazyAssets` set remains exhaustive and takes precedence over the network
proxy. A deployment-configured same-origin proxy uses `credentials: "same-origin"`
to admit requests on authenticated hosting, including private Spacefast Spaces.
VFS metadata chooses the artifact target, never this trusted proxy URL. An
external proxy receives `credentials: "omit"`; proxied requests send only the
application origin as Referer (`strict-origin`) for approved-origin admission. Service-worker reprojection uses the same credential rule for
already-proxied requests and automatic cross-origin GET/HEAD wrapping.
The proxy must strip application cookies before contacting the
artifact destination. Redirects to another origin cannot carry those cookies.
Direct same-origin artifact requests keep their caller's credential policy.
The Node.js host is unaffected and continues to fetch its lazy URLs directly.

The current profile allows `Accept`, `Content-Type`, `git-protocol`,
`Range`, `wp_blog`, and `wp_install`, and copies `Range` into
`X-Cors-Proxy-Range` (see "Byte-range reads through the proxy" below). Every
actual proxy boundary projects by case-insensitive field name only and
preserves browser-representable values and occurrences as far as Fetch
permits. Request fields the browser sets or
forbids on every `fetch()` — the Fetch forbidden request-header names plus
browser-owned identity/client-hint fields such as `content-length`,
`accept-encoding`, `transfer-encoding`, and `user-agent` — are omitted for
**any** method, because a guest value for them can never reach the origin
regardless of the allow-list; their omission is the browser's constraint,
not a proxy-imposed loss. This is what lets a body-bearing smart-HTTP
`git-upload-pack` POST traverse the proxy: a browser `git clone https://…`
succeeds because only the application-owned fields, all of which are
allow-listed (`Accept`, `Content-Type`, `git-protocol`), are forwarded. An
anonymous bodyless GET may additionally omit an
application-owned unsupported field and emits a deduplicated diagnostic.
Credential fields (`Authorization`, `Cookie`, `Cookie2`, `Proxy-Authorization`)
are never silently dropped; a request carrying an unsupported one fails before
dispatch. Any other application-owned unsupported field still fails a
credentialed, body-bearing, or non-GET request before dispatch. Direct Fetch
attempts remain unprojected. The development same-origin relay enforces the same
profile as production.

#### Byte-range reads through the proxy

`Range` is in the profile so that a byte-range read (for example, reading a
ZIP archive's central directory from its last 64 KiB without downloading the
archive) can reach the origin. It is relayed opaquely: no Kandelo proxy
boundary parses range syntax.

**Production (measured 2026-09-28).** The default proxy,
`wordpress-playground-cors-proxy.net`, allows `Range` in its preflight and
exposes `Content-Range`, `Accept-Ranges`, and `ETag`. The proxy is a PHP
script hosted on WP Cloud, and WP Cloud's front-end web servers strip the
`Range` header before the request reaches PHP, so a plain `Range` comes back
as `200` with the whole entity. As a documented workaround, that proxy also
reads the same value from `X-Cors-Proxy-Range` and forwards it upstream as
`Range`. The profile names that field in `rangeRequestHeaderAlias`, and every
proxy dispatch (`BrowserCorsProxy.project()` for guest traffic, and the
service worker for page and worker fetches) copies an outgoing `Range` into
it. Both fields carry the same value, which the proxy documents as safe once
`Range` gets through. The alias workaround can be removed as soon as WP Cloud
relays `Range` headers to PHP. A caller's own `X-Cors-Proxy-Range` is never relayed.

**The HTTP cache must stay out of aliased requests.** The browser's HTTP
cache may rewrite `Range` on the wire to fetch only the bytes it has not
stored, but it cannot know that `X-Cors-Proxy-Range` names the same range.
The proxy then answers the alias's range and the cache splices a body shorter
than its `Content-Range`. Measured on 2026-09-28 in Chromium against a
production-shaped fixture (`Cache-Control: no-cache`, strong `ETag`):
overlapping reads of `bytes=50-149` and `bytes=0-199` came back with 50 and
100 bytes. Every aliased request is therefore sent with the Fetch cache mode
`no-store`. WebKit did not show the rewrite.

**Limitation and technical debt: ranged requests through production pay CORS
preflights.** `X-Cors-Proxy-Range` is not a CORS-safelisted request header,
so the browser must send an `OPTIONS` preflight before a request that carries
it, including simple `bytes=N-M` ranges that would otherwise need none.
Measured on 2026-09-28 with five ranged reads of one proxy URL:

| Engine | Preflights for 5 reads |
|---|---|
| Chromium | 5: a `no-store` request skips Chromium's preflight cache |
| WebKit | 1: the preflight is reused for 5 seconds (the Fetch default when the proxy sends no `Access-Control-Max-Age`) |

In Chromium, then, every ranged read costs one extra round trip to the proxy.
A ZIP index read (a tail read, then possibly a directory read) pays it once or
twice. The time cost was not measured. Both the preflights and the `no-store`
mode exist only because of the alias workaround, and both go away when WP
Cloud relays `Range` headers to PHP and the alias is removed; see
`docs/future-improvements.md`.

**`If-Range` is emulated, not relayed.** The proxy's preflight does not
allow `If-Range`, and `If-Range` is never CORS-safelisted, so it is not in
the profile and is never sent. Dropping it would turn a conditional ranged
request into an unconditional one: after the resource changes, a resuming
client would receive a slice of the new version. Instead, the proxy dispatch
applies RFC 9110 section 13.1.5 to the answer. `BrowserCorsProxy.fetch()`
does this for guest traffic, and the service worker for page and worker
fetches. The range goes out without `If-Range`. If the `206` (or a `416` for
a range the resource no longer covers) carries the matching validator, it
stands. Otherwise the dispatch discards it and fetches the whole
representation, exactly what a server whose `If-Range` condition is false
would have sent, since such a server ignores the range. A validator that cannot be confirmed
counts as a mismatch, so doubt costs one extra full request, never a wrong
slice. An entity-tag `If-Range` is confirmed against the proxy-exposed
`ETag`. A date `If-Range` also needs the response's `Date` header to prove
`Last-Modified` is strong, and the proxy does not expose `Date` to scripts,
so through the browser a date `If-Range` always takes the full-request path.
`If-Range` without `Range` is meaningless and is dropped, as servers must
ignore it. Several `If-Range` fields are joined, as Fetch joins them, and
never match. Kandelo's own multi-read code, which issues no `If-Range`, passes
the ETag it already saw to `fetchByteRange()` as `entityTag` and fails the
read if an answer carries a different one.

**Development (`__kandelo_cors_proxy`).** The Vite relay implements the same
profile. It forwards `Range`, honors `X-Cors-Proxy-Range` the way the
production proxy does (an empty alias is ignored, the alias is never
forwarded, and an alias that disagrees with `Range` is a `400`), asks upstream
for the identity encoding on ranged requests and `HEAD` so byte offsets and
sizes address the stored bytes, relays the
upstream status verbatim (a `206` stays a `206`), exposes `Content-Range`, and
streams the body. A `206` that upstream compressed anyway is a `502`, because
its `Content-Range` would describe bytes the relay does not send. The 100 MiB
cap bounds the bytes one response actually carries, so a 16-byte slice of a
4 GiB file is relayed, while an undeclared body that outgrows the cap is cut
off mid-transfer. A client disconnect cancels the upstream request, before or
after response headers. When the upstream fetch itself fails, the `502` body
names why (for example `getaddrinfo ENOTFOUND` or `connect ECONNREFUSED`) and
the target's origin, never its path or query, and the dev server logs the same
line, so a guest's failed download says whether a name, a connection or a
timeout failed.

**Cancellation through the service worker.** Cancelling a proxied read
reaches the relay once response headers have arrived: cancelling the body
cancels the proxied transfer. Before headers it depends on the browser. The
service worker copies the page request's abort signal onto the proxied
request, but measured on 2026-09-26 in Playwright Chromium and WebKit, a page
abort before headers never fired that signal (a plain pass-through
`fetch(event.request)` behaved the same way). The upstream request then runs
until it answers. This is a browser boundary, not relay behavior: a direct
abort of a relay request cancels upstream in both engines.

The 2026-10-19 Playwright Firefox check did not close the upstream transfer
within ten seconds after aborting a page read after its first body chunk.
The same failure reproduced using current main's service worker and the
unchanged development relay; Chromium and WebKit passed that check.
Service-worker body cancellation propagation is therefore not guaranteed
on the tested Firefox path either. This does not affect the proxy's
ability to return range bytes, but an abandoned transfer can remain open.

**Reading an answer.** A `200` answer to a ranged request is legal HTTP: any
server or relay may ignore `Range`. Kandelo code that issues a ranged read
must use `fetchByteRange()` from `host/src/networking/byte-range-fetch.ts`.
It returns `partial` only for a `206` whose `Content-Range` answers the range
requested: the exact bounded range (clamped to the entity's end), the final
bytes for a suffix range, or a run starting at the requested position for an
open-ended range. Its `bytes()` rejects a body of the wrong length. A `200`
becomes `whole-entity`, a body that starts at offset 0 and is never the
slice. Any other answer, including a `206` for a different range or with a
different `ETag` than `entityTag`, becomes `failed`.

Guest HTTP(S) requests reach the proxy through the same profile and get the
relayed status unchanged. The Node.js host never projects guest requests; it
fetches them directly with `Range` and `If-Range` intact. A guest `curl -r`
therefore sees the same `206` on both hosts, including behind the production
proxy, and a resume whose `If-Range` no longer matches sees the same `200`
with the whole current file. The browser path may spend an extra request to
get there.

Bridge initialization now rejects typed CacheStorage and transition failures.
A worker disappearance or lost acknowledgement after `postMessage` remains a
known boundary: the worker may already have committed irreversible
CacheStorage authority, so a client-only timeout could reject while leaving a
discarded bridge authoritative. Closing this gap requires a coordinated
transaction, cancellation acknowledgement, and restart reconciliation.

### Multiple machines under one service worker scope

A single service-worker scope can host several live Kandelo machines at
once, one per booted browser tab. On `init-bridge` the worker mints a
three-word, human-readable name (`adjective-color-noun`, e.g.
`brisk-amber-otter`, drawn from three embedded word lists of 128+ entries
each) and gives that machine its own stable, shareable URL space at
`/<scope>/app/<name>/`. The worker keeps one in-memory `InstanceRecord` per
name in a registry (name -> record), so two tabs under the same scope route
independently and never clobber each other's bridge, cookies, or lifecycle
state.

A request is attributed to a machine one of two ways. A path that already
contains `/app/<name>/` resolves directly to that machine's record; an
unknown or malformed name never falls back to another machine, it is a real
"not found" (see the 503 page below). A root-relative subresource request
with no name in its path — the common case for a page's own same-origin
asset requests — is attributed by the requesting client's id: the first time
the worker resolves a named request for a given client, it remembers that
client is "viewing" that machine, and later nameless requests from the same
tab or iframe keep routing to it. That same client-id bookkeeping is what
makes cross-tab viewing work: opening a machine's `/<scope>/app/<name>/` link
in a second tab reaches the same running machine and relays through the
bridge on the tab that owns it, rather than starting a second machine, because
the name in the URL always takes priority over any per-client attribution.

Nameless GET and HEAD requests redirect into the viewing machine's URL
space. Other methods dispatch once through that machine's bridge with the
original unread request body. WebKit loses body bytes when replaying a
synthetic service-worker 307, so body-bearing methods avoid that redirect
on every engine. Their browser response URL remains the original request
URL; the guest receives the canonical app path and forwarded prefix and
URI. Owner reconciliation, bridge restoration, and the machine's cookie
and session checks are the same as for explicitly named requests.

After idle termination or restart, the worker recovers a nameless request's
machine from the requesting window client's actual same-origin app URL.
It waits for the durable registry and uses the ordinary bridge restoration
handshake. Host documents remain outside machine routing even if their
request supplies an app-shaped referrer; unknown machines fail explicitly.
Recovery enumerates controlled window clients and matches the request's
client id. It does not look up worker clients: Firefox can wait for a
loading worker's imports inside that lookup while the imports wait for
the service-worker response. Worker imports retain ordinary network
fetching without acquiring a machine's viewer authority.

Each machine has its own cookie jar, keyed by its SW-minted name, so session
cookies for one machine (WordPress admin cookies, for example) are never
visible to another machine's requests even though both live under the same
scope's origin.

Each machine's bridge authority (its live `MessagePort`, session id, and
cookie jar) is also persisted to IndexedDB under a per-name key as it is
established, independent of the in-memory registry. If the browser
terminates and restarts the service worker while a machine's host tab is
still open, the worker has lost every live `MessagePort` but still has each
machine's durable authority record. On the next request for that machine it
broadcasts `need-bridge` to window clients and accepts only a
`bridge-restored` reply whose name, app prefix, and session id match that
exact record, re-establishing the bridge and replaying the persisted cookie
jar. This restart is transient: while the worker waits for the owning tab to
respond, the machine is "reconnecting", not offline, and it recovers without
losing session state once the tab answers.

A machine goes terminally offline only when its owning tab actually closes
(a `pagehide`-driven `instance-closing` message, or — for a crashed tab that
never sends one — the worker noticing on a later request that the owning
window client is gone). There is no migration of a machine to a different
host tab: once its host tab is gone, that machine is done, and its durable
authority and cookie jar are dropped. Starting the demo again mints a new
machine under a new name.

When a machine goes offline or starts reconnecting, the worker pushes a
`machine-offline` or `machine-reconnecting` message to every tab currently
viewing it (any client whose viewing map points at that machine, not just the
host tab). Demo pages that render a web preview of the machine map that push
to the preview's `offline` or `reconnecting` status via
`webPreviewForMachineChromeMessage()`
(`web-libs/kandelo-session/src/machine-chrome-message.ts`); the pane keeps
its existing label and URL and only its status and message change, so a
viewer sees the same preview pane report itself unavailable or reconnecting
rather than disappearing. A request that reaches the worker for a machine
that is offline, or whose name was never minted, gets one 503 HTML page
naming the machine — 503 rather than 404, because the name is a valid route,
the machine behind it is just not running here. This is the raw-request
fallback for any request that has no demo chrome to render a status in, such
as loading `/<scope>/app/<name>/` directly with no page-side listener
attached.

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
`"__CORS_PROXY_CONFIG__"`) into the `<head>` of bridged HTML documents without
a Content Security Policy, so it applies to app demos, not just WordPress.
Documents carrying a
`Content-Security-Policy` response header retain their declared script policy:
the bridge does not inject the inline helper or change that header. The
blob-iframe adapter is therefore unavailable in those documents; ordinary
HTML, assets, requests and same-origin iframes still use the bridge.

## VFS Images

### Consumer-owned product selection

VFS product definitions live under `images/vfs/products/` and describe what
an image is. They do not decide where that image appears.
Pages placement is owned only by the Pages VFS product registry.
The Pages registry is
`apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`; test
selection is independently owned by `tests/vfs-products.toml`. Their generated
JSON files are canonical checked projections.

Pages presentation membership is a separate reviewed authority at
`apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json`.
It maps every selected Pages product to the preset IDs that present that image.
The Pages registry check requires exact product-ID parity, requires every
declared preset to exist in `presets.ts`, and verifies the preset's VFS-image
mapping in `live-setup.ts`. The retained Pages composer derives site metadata
from those exact current-main authorities and the built site tree, and binds
each normalized `vfs_image` mapping into the site identity; workflows do not
supply self-authorizing gallery or file inventories.

Hosted Pages publication is disabled, but its registry, producer, and local
fixtures remain reviewable and continue to fail closed. Before disablement,
protected main workflows invoked `scripts/abi-staging-pages-producer.ts produce`
with a bounded handoff naming the exact clean checkout, runtime bundle/root,
built site root, run identity, and current package/archive/program-index roots.
The producer discovered immutable candidate and admission records anonymously,
recaptured package inputs, and executed the normal VFS builders plus both host
evidence supervisors. Every selected product had to carry its exact
current-main recapture. Embedded recaptures remained path-only builder inputs;
only lazy recaptures received Pages input URLs. Embedded product dependencies
used the distinct ABI-, product-, digest-, and byte-bound Pages product URL.
During pre-deployment evidence, canonical Pages and prior-product lazy URLs
remained the image authority while authenticated current bytes were supplied
through a closed local transport.
The exact browser runtime used a dedicated evidence build of the real root UI.
That build kept the exact kernel asset but mapped ordinary demo rootfs and
program fallbacks to unavailable URLs. Candidate VFS and lazy inputs therefore
came only from the protected evidence handoff; an accidental fallback fetch
was observed as a failed, unexpected request instead of making runtime
preparation depend on unrelated package archives before product composition.
An incomplete product set emitted only `readiness.json`; a complete set
emitted the canonical artifacts, site manifest, and inert source tree for the
Pages job.
The canary validated that record before selecting its artifact protocol. A
hold had exactly that one file, reported its digest and blockers, and used
ordinary bounded artifact retention; it never invoked the Pages artifact
action. Only a ready result validated and uploaded the complete inert Pages
source tree.

That hosted rollout remains dormant. Re-enabling it requires a separate
reviewed change that revalidates package-backed product inputs and restores an
explicit deployment trigger; retained readiness files are not authorization.

Selection preserves both lazy boundaries. A consumer may lazily compose a
whole VFS product, and a selected product may in turn retain lazy package
layers. Product-derived package roots are not copied into either consumer
registry. This prevents a product from placing itself on Pages and prevents
Pages or tests from becoming competing software dependency authorities.

The atomic local snapshot gate also drives the one producer-returned, assembled
seven-product tree through the production `/kandelo/` Vite base, service
worker, cross-origin isolation headers, and `BrowserKernel` in Chromium. It
holds the two eager VFS responses, proves no lazy request starts before their
release, then proves each lazy product is fetched only by its representative
profile. It hashes every VFS response and rejects external requests plus
noncanonical identity, load, ABI, length, and digest mutations. The
hidden deployment manifest is only the test's observation ledger; the sealed
build map remains browser authority. This is bounded fixture evidence, not a
claim about hosted candidate publication, a real pull request, canonical
promotion, or production Pages deployment.

Browser demos use pre-built **VFS images** — binary snapshots of a filesystem tree containing all runtime files, directory structure, configs, and symlinks needed by a demo. At runtime the kernel parses the image in place and serves it as `/`, replacing what would otherwise be hundreds or thousands of individual file creation operations. The format (a `VFSI` container holding a KIFS tree plus `SDEF`/`KLZY` sections describing deferred files) is read and written only by Rust: the kernel reads it (`crates/runtime-core/src/rootfs.rs`) and the image writer (`crates/runtime-core/src/kandelo_image_write.rs`) produces it.

### How it works

1. **Build time**: A TypeScript build script creates a `KandeloImageFs`
   (`images/vfs/lib/kandelo-image-fs.ts`), writes files/dirs/symlinks into
   it, and calls `saveImage()` (the `vfs-image-helpers.ts` wrapper) to
   produce a zstd-compressed `.vfs.zst` file. `KandeloImageFs` is a thin
   wrapper over `crates/kandelo-image-module`, a Wasm module with no imports
   (`local-binaries/kandelo_image_module32.wasm`, built by `./run.sh setup`)
   that runs the same Rust writer the kernel uses for export. The exported
   body is sized to the tree; the growth ceiling the machine may use at
   runtime is recorded as a number (`setImageCapacity`), so capacity never
   ships as download bytes.
2. **Runtime**: The page fetches the `.vfs.zst` file and passes it to
   `BrowserKernel.boot()` / `initFromImage()` (or the ownership-taking
   `bootFromOwnedImage()` / `initFromOwnedImage()`). The main thread
   zstd-decodes it and transfers the bytes to the kernel worker; the kernel
   loads it with `kernel_rootfs_load_image`, refusing an image whose ABI,
   seals or deferred-file sections it cannot verify. Files the image only
   names (lazy files and lazy archives) are fetched by the host on first
   read through `host_fetch_deferred`. The image is never rewritten: an
   address in the image-owned grammar (`binaries/programs/...` or
   `kandelo-lazy:programs/...`, each naming its package-mirror path)
   resolves to its package member under `lazyAssetDirectory`, `lazyUrlMap` can still pin an
   individual address, and any other relative address resolves against
   `lazyUrlBase`.

A deployment serves exactly what its images reference, and the browser app
keeps no list of lazy files. Each address an image records names its
package member (`normalizeImageOwnedLazyReference` in
`host/src/vfs/vfs-asset-group-reference.ts`), and the kernel worker
resolves it under the lazy-asset directory the page passes
(`imageOwnedLazyAssetDirectory` in
`apps/browser-demos/lib/init/image-owned-runtime-urls.ts`):

- In a production deployment that directory is the authenticated asset
  group. `scripts/build-local-vfs-asset-group.ts` opens each shipped image,
  lists its lazy entries, and stages exactly those bodies, checked by size
  and SHA-256.
- On the Vite dev server it is the `@kandelo-lazy/` route
  (`apps/browser-demos/vite/dev-lazy-assets.ts`). The route passes the
  member path to the same binary resolver the Node host uses for lazy
  assets (the pinned SourceOnly store under `./run.sh browser`), and only
  that exact answer is served.
- An image that is not a product activation, such as a `?vfs=` URL image,
  resolves its lazy bodies under the deployment's own asset group, when
  there is one; the image's digests still decide whether bytes are
  accepted.
- A production build without an asset group has no lazy-asset directory.
  Addresses then resolve against the deployment base as written, so a body
  it does not serve fails as an I/O error on the read that needs it. Use
  `./run.sh build-browser`, which builds the group.
- The Node host resolves lazy assets through the binary resolver, which
  applies the same rule. `NodeKernelHost` also accepts the directory as
  `rootfsLazyAssetDirectory`, the peer of the browser option, for
  transports keyed by URL such as `rootfsLazyAssets`.

The image records each body's size and digest, and the kernel checks them
on fetch, so where the deployment serves a body from is transport, not
trust. Adding a package to an image needs only the image recipe and the
package's entry in the supported set.

Binaries the browser app imports directly (`@binaries/...`) are the other
consumer. The Node CLI's literal `optionalBinary` built-ins are consumers
too, including each alternative entry point. Each must be an output of a package in
`packages/sets/local-supported.toml`;
`scripts/check-browser-binary-supply.ts` enforces this, and
`tests/package-system/browser-binary-supply.test.ts` runs it in CI. A
default `./run.sh local-build` selects the owners of those host demands beside
the active products. After every supported-tree build the engine also
checks the published projection: each host program demand, the kernel, rootfs
and image-writer artifacts, and every lazy body each product image
references must be present at its declared size, or setup fails naming the
path and its consumer. Optional gallery globs are outside this rule; their
artifacts are optional by design.

Machine-booting Playwright specs treat a missing image the same way.
`gotoMachineOrSkip` fails when the machine's product is one the supported set
declares, and any Vite error overlay fails the spec with its message. Only a
product outside the supported set is skipped as optional content.

The canonical package shell has a 512 MiB filesystem ceiling. Products that
copy that shell and add their own application tree use a separate 768 MiB
profile: the image writer accounts free data bytes and free inodes
separately against the declared ceiling, so merely having free data space
does not guarantee that another file can be created. `saveShellDerivedVfsImage()` rejects a product build
unless at least 64 MiB of data blocks and 8,192 inode slots remain after its
immutable contents are written. This makes runtime allocation space a checked
artifact contract instead of allowing an image to build successfully and then
fail with `ENOSPC` during normal browser initialization. The shared save helper
also preserves the shell's ABI and exact package-shell composition while
rebinding the exact shell artifact as the derived product's direct base and
replacing its builder id and capacity. It validates the inherited experimental
terminal-session declaration and requires
the serialized artifact's encoded growth ceiling and capacity metadata to equal
the 768 MiB product profile. A future product that intentionally needs a larger
reviewed profile must pass that exact ceiling explicitly rather than silently
drifting from its browser consumer; an override cannot select a smaller
profile. Host-tree copies fail the build on any read or VFS write error.
Intentional omissions are declared through the copy helper's `exclude` option,
and every unexcluded symlink must be preserved explicitly or the build fails.

`saveImage()` also walks every resident Wasm file and rejects stale ABI or
fork-instrumentation state. A package that intentionally disables fork
instrumentation may narrow that check only with an exact canonical VFS path in
`wasmArtifactPolicies`; the builder's declaration must agree with the selected
generated package projection. Missing, deferred, non-Wasm, duplicate, or
noncanonical policy paths fail the build, and all other Wasm paths retain the
normal whole-image validation. `skipWasmArtifactCheck` is not an alternative
for a product-specific executable policy. A direct dependency may authorize
such a policy only from its exact immutable xtask program-cache generation,
including the selected cache key and declared source-artifact path. Generic VFS
artifact lookup continues to support relocated build inputs and local source
overrides, but those paths do not carry enough identity to authorize a Wasm
validation exception without a separate content-bound receipt.

### Selecting a machine: `?vfs=` and `&profile=`

A Kandelo VFS image describes the machine it contains, in a tracked
`/etc/kandelo/demo.json` baked into the image
(`web-libs/kandelo-session/src/demo-config.ts`). The browser app holds no
machine identities: no id list, no per-id switch, no per-id spec table. `?vfs=`
alone is therefore enough to boot a first-party machine or a stranger's image,
and both travel one code path.

An image may declare several profiles — the shell image carries `shell`,
`node`, `doom`, `quake`, `modeset`, `sdl2`, `scummvm`, `wayland`, and
`omarchy` — so one channel selects one:

1. `&profile=<id>` on the page URL.
2. else the image's own `defaultProfile`.

`&profile=` is the *only* channel a profile id travels on. A fragment on the
`?vfs=` image URL itself (e.g. `?vfs=https://cdn/shell.vfs.zst%23doom`) is
never read as a profile id, and the app never writes one: `galleryItemUrl`
and every other link the app generates carry `&profile=` alone, with no
fragment appended to the image URL. (URL-identity matching still ignores any
fragment a hand-written `?vfs=` URL happens to carry — a fragment is never
part of a resource's identity — but that is ordinary URL hygiene, not a second
profile channel.)

An id no profile in the image declares is a **loud boot error** naming the
profiles the image does declare — never a silent fall back to its default. An
image with no `/etc/kandelo/demo.json`, or a malformed one, fails the boot
with that reason; nothing synthesizes a fallback machine.

The older `?demo=<id>` parameter is **removed**. It named one of a dozen ids
the app held, which is exactly what image-owned machine definitions delete. It
is ignored rather than rejected, so links in the wild degrade instead of
breaking: `galleryItemUrl` has always written `?vfs=` alongside it, so such a
link still resolves its image and boots that image's declared default profile.

A link shared before the fragment channel was removed may look like
`?demo=doom&vfs=https://cdn/shell.vfs.zst%23doom`: the now-dead `?demo=` and
the now-ignored image-URL fragment both named `doom`. Opening that link today
still resolves the `?vfs=` image, but — since neither `?demo=` nor the
fragment is read — boots the image's declared `defaultProfile` instead of the
profile either of them named. For the shell image that means such a link now
boots plain `shell`, not `doom`. This is an accepted, deliberate cost of
removing the second channel, not a bug: re-sharing the link with `&profile=`
produces a URL that keeps working.

Each built-in VFS image has one trusted source and resource identity. The
loader verifies that the URL exactly matches the current built-in image before
granting its larger resource limit. A query parameter or URL fragment cannot
give an unrelated image that limit; images consumed by the general live host
use the bounded custom-image profile when they do not match. The specialized
Node host always boots its fixed built-in image rather than consuming a `vfs`
override.

Resource ceilings are host policy, not image authority: `runtime.requests` in
`demo.json` is a REQUEST that `live-setup.ts` clamps (worker count, memory
pages, VFS byte ceiling). Gallery membership is likewise curated, in
`apps/browser-demos/pages/kandelo/gallery-roster.json`; an image cannot claim a
place in the gallery by declaring one. Every displayed byte — title, summary,
accent, glyph — still comes from the named product's own tracked demo config.

```typescript
// Typical demo pattern
const [kernelBuf, vfsImageBuf] = await Promise.all([
  fetch(kernelUrl).then(r => r.arrayBuffer()),
  fetch(vfsImageUrl).then(r => r.arrayBuffer()),
]);

const kernel = new BrowserKernel({ onStdout, onStderr });
// The image is decoded on the main thread and handed to the kernel, which
// owns `/` from here on; the page keeps no filesystem.
const { exit } = await kernel.boot({
  kernelWasm: kernelBuf,
  vfsImage: new Uint8Array(vfsImageBuf),
  argv: ["/bin/sh", "-l"],
});
```

### Script-carrying share links

The Share button in the dock produces links of the form
`…/?vfs=<image>&profile=<id>#k1=<payload>`. The fragment is a versioned,
gzip-compressed
boot descriptor (`web-libs/kandelo-session/src/boot-descriptor.ts`) that may
carry optional `inputs` and `parameters` fields. The payload is validated
with hard caps and loud `BootDescriptorError` failures. A malformed or
oversized fragment rejects the boot with a visible error; it never falls
back to booting as if the fragment were absent.

Boot inputs carry named, sha256-verified files materialized into the kernel
VFS before the initial shell. The library in
`web-libs/kandelo-session/src/boot-inputs.ts` validates every input's
compressed bytes, decompresses (gzip-transported payloads are supported),
and verifies the final sha256+byteLength before writing to the VFS. Inputs
are all-or-nothing: if any input fails verification, no changes occur.
Resolver-kind inputs fail materialization loudly when no resolver is
registered (the production registry is empty; inline sources only today).

Opening a script link boots the machine selected by the query parameters
(the fragment cannot select an image the query parameters could not) and
materializes the boot inputs. A script travels as input id `"script"`
→ `/run/kandelo/inputs/script/kandelo-link.sh` (mode 0o755). An input
manifest at `/run/kandelo/boot-input.json` (mode 0o644) records the
materialized result: the manifest's own `version: 1`, the descriptor's
`parameters`, and one entry per successfully materialized input (id,
filename, guest `path`, byteLength, sha256) — not the raw descriptor
`boot.inputs`/`boot.parameters` fields verbatim. When `boot.parameters.runScript`
names the "script" input, that input is printed to the terminal with `cat`
before execution, and then run from the initial interactive shell — `bash`
when the image ships it, `sh` otherwise. The file is left writable so the
visitor can experiment: edit it and re-run it after boot. The script's
source, the invocation, and the script's output are all visible in the
terminal, and the script takes the image's own `init.shellCommand`'s place
in the launch sequence. Navigating to a different machine from the gallery drops
the fragment.

Links built before boot inputs were folded in could carry a top-level
`script: { text }` field on the descriptor (superseded by `boot.inputs` +
`boot.parameters.runScript`). The decoder tolerates that unknown field
rather than rejecting the link, so such a link still boots — but the script
field is ignored: no script is materialized or run. The machine log carries
a visible warning so this isn't silent: a warn-level dmesg line at the start
of boot, from `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`,
names the ignored field.

Caps enforce untrusted-input boundaries: maxBootInputs, 32 KiB carried per
inline input, 2 MiB inflated per input, aggregate input size, 32 KiB
parameters JSON. Zero-byte inputs are accepted; the dialog simply skips
empty scripts during authoring.

Scripts currently run without a confirmation step because every machine the
browser app boots is ephemeral. This is a load-bearing boundary: before any
persistent or restored-machine feature ships, script links must gain an
explicit show-the-script consent step (see the warning at the execution
site in `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` and
`docs/superpowers/specs/2026-09-21-script-bearing-links-design.md`).

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

The tracked JSON file **is** the artifact. A VFS build script never
constructs this object in TypeScript: it calls `writeTrackedDemoConfig(fs,
"packages/registry/<image>/<name>-demo.json")` from
`images/vfs/scripts/tracked-demo-config.ts`, which copies the reviewed file
byte-for-byte to `/etc/kandelo/demo.json`. Every tracked source is listed in
`TRACKED_DEMO_CONFIG_SOURCES` in that same module, and
`scripts/check-image-demo-config.ts` validates all of them and
byte-compares each single-source image's baked copy against its tracked
source. Images without
this file still boot with Kandelo's generic presentation defaults, but the
Kandelo app does not carry demo-specific presentation fallbacks.
Any extra files needed by an image-declared `init.shellCommand` can be
declared in `assets`; the loader stages those paths generically and hash-verifies them when
`sha256` is provided.

The schema is PROFILE-ONLY. `version`, `defaultProfile`, and `profiles` are
the only top-level keys; every machine block below belongs to a
`profiles.<id>` entry, and declaring one at the top level is a validation
error naming it. There is no top-level fallback for a profile that omits a
block — a machine field is read from the selected profile or from nowhere.

Alongside `presentation`, `assets`, `guide`, and `exchange`, a profile may
declare these blocks.

- `identity` — what a listing shows for this profile: `title`, `summary`,
  `accent` (`#rrggbb`), `glyph` (1–4 characters), and optionally `packages`
  (a list of package specs, at most 64). There is no `base` field: the app
  computes `kandelo:shell@abi<N>` from the ABI it was built with, and real
  ABI compatibility is enforced by the `__abi_version` check on binaries.
- `runtime` — what the machine needs: `features` (any of `framebuffer`,
  `kms`, `kms-gl-scanout`, `evdev-input`, `clipboard`) and `requests`
  (`memoryPages`, `maxWorkers`) which the host clamps to its own policy.
  `clipboard` says the image runs an agent on `/dev/kandelo/clipboard`
  (kclipd), so the host turns a browser paste over the machine into an
  offer on it, and a copy chord over the machine into a copy-out from it;
  it rides on the DOM input source, so the parser rejects it
  without `evdev-input`. `kms-gl-scanout`
  additionally routes the KMS surface through the vblank pump's WebGL2
  scanout presenter, which a Wayland compositor needs: its own GL context
  claims the canvas as the steady state, but the presenter has to cover
  boot before that claim and the permanent CPU fallback if the GLES probe
  or a GL frame fails. It refines a KMS display, so the parser rejects it
  without `kms`. There is no `network` flag: it gated no
  socket syscall, and a field that reads like a sandbox control without
  being one is a trap for third-party images.
- `init` — what this machine runs. Exactly one of three mutually exclusive
  shapes, so the exclusivity is structural rather than a cross-block rule:
  - `{ "target": "<name>" }` — a bare dinit service name matching
    `/etc/dinit.d/<name>`. It selects among init configurations the image
    already carries; it is not a command vector.
  - `{ "program", "args", "cwd"?, "uid", "gid" }` — exec a program from the
    image directly as pid 1, for an image that ships no service manager.
    `program` must be an absolute normalized path inside the image. `uid`
    and `gid` are REQUIRED non-negative integers: defaulting to 0 would hand
    root to any image that omitted them, and defaulting to 1000 would invent
    an account convention an image may not share.
  - `{ "shellCommand": "..." }` — a command line (at most 4096 characters)
    run in the machine's login shell after boot. This is the shape for a
    machine that is one program over an ordinary shell, such as fbDOOM or
    the KMS fluid sim; exiting the program returns to that shell.
- `web` — readiness signalling for the web pane: `requiredPorts` (non-empty,
  at most 64), `probeHttp` (defaults to true), and an optional `probePath`
  that must be a plain absolute path.
- `display` — `minWidth`/`minHeight`, the smallest surface the machine
  expects to be usable at. A floor the machine states, not a size it imposes.
- `defaultProfile` (top level) — which profile a bare `?vfs=` URL boots.
  An image with exactly one profile needs no declaration; an image with
  several must name one.

Files reach a machine through Kandelo exchange (`docs/architecture.md`,
"Kandelo exchange"), not through the profile. Dropping files or folders on
the terminal, framebuffer, or display surface, or choosing them with the
dock's "Send files" button, offers them to the machine as one batch. The
machine's agent and its handler rules decide what happens: the game
machines' rules load a WAD, a pak or zipped game data, and the catch-all
saves anything else to `~/Downloads`. Each batch gets a toast with its
status and outcome; outputs the machine publishes appear in a tray with
Save and Dismiss (Save streams through `showSaveFilePicker` where the
browser has it, and otherwise buffers the output and downloads it). A
machine with no agent shows "This machine doesn't accept files" and refuses
the drop. A profile may add presentation hints:

```json
{
  "exchange": { "label": "Load WAD", "accept": [".wad"] }
}
```

`label` adds a labelled button for the picker on the display surface's
dock, and `accept` filters that picker. They are hints only; the guest's
rules stay the authority. The retired `ingest` block is refused with a
message pointing here, never silently ignored.

A profile may also declare up to four dock buttons that replace the machine's
foreground program. The browser UI shows them on the display surface's dock,
before the exchange button:

```json
{
  "dockActions": [
    {
      "id": "demo",
      "label": "Run the demo",
      "description": "Shown as the button's tooltip",
      "restart": "/usr/local/bin/run-demo"
    },
    {
      "id": "freeware",
      "label": "Play a freeware game",
      "menu": [
        {
          "id": "lure",
          "label": "Lure of the Temptress",
          "detail": "6 MB",
          "restart": "/usr/local/bin/scummvm-play lure"
        },
        {
          "id": "helga-deep-in-trouble",
          "label": "Helga Deep in Trouble",
          "unavailable": "needs the Wintermute engine's JPEG support"
        }
      ]
    }
  ]
}
```

An action declares exactly one of `restart` (the button runs it) or `menu`
(the button opens a list of up to 40 entries, and the chosen entry's
`restart` runs the same way). An entry's optional `detail` is shown beside
its label and `group` collects entries under a heading. An entry the image
knows about but cannot run declares `unavailable`, the reason, instead of
`restart`; the menu shows it disabled with that reason, so the gap stays
visible rather than silently missing.

A display machine's command (its `init.shellCommand`) is a long-lived
program that owns the machine's terminal and a single-owner display device,
so running something else means ending that program first. A click does what
a person at the terminal would: the host types the interrupt character
(Ctrl+C) into the machine's shell PTY, which the kernel's line discipline
delivers as `SIGINT` to the foreground process group, and waits for the
shell's prompt to come back (`KernelHost.interruptShellForeground`). The
prompt is the evidence the program exited and released its devices; if it
does not appear within ten seconds the action fails visibly and the command
is not sent. A program that reads its keyboard from a raw-mode terminal, as
fbDOOM does, has turned the line discipline's signal keys off, so Ctrl+C
reaches it as an ordinary keypress and it keeps running, exactly as it would
on any Unix terminal. The framebuffer pane therefore ends its display
program the way the display panes always have: it sends `SIGTERM` to the process
bound to `/dev/fb0` and waits, for at most ten seconds, until that process
has exited and the kernel has released the device; when nothing owns the
device it falls back to Ctrl+C. Only then is `restart` written to the shell,
exactly as if typed. Like `init.shellCommand`, `restart` is the image author's
command, never user input. `id`s must be unique within the profile, and
entry `id`s within their menu.

The runtime treats this file as untrusted image input. It must be a regular
file no larger than 256 KiB, contain valid UTF-8 and JSON, and use a supported
version. The loader validates every profile before using any of them, so a
malformed unselected profile cannot hide behind the current URL. Every
first-party image bakes a reviewed tracked file verbatim, so the baked bytes
and the tracked bytes are identical.

The source-rootfs shell image is the one documented exception. Its
`/etc/kandelo/demo.json` is a deterministic merge of two tracked files —
`packages/registry/shell/source-rootfs-shell-demo.json` (the package-owned
base) and `packages/registry/shell/source-rootfs-shell-demo-profiles.json`
(the image-owned profile overlay) — so the baked bytes are a superset of
either one. The overlay may declare only `version` and `profiles`; the
builder rejects any other top-level key, because composition takes every
other field from the base and would otherwise discard it silently.

VFS images do not need to serialize placeholder device nodes. Both Node and
browser boot replace `/dev` with the authoritative `DeviceFileSystem` and mount
shared memory at `/dev/shm`; image acceptance should exercise devices such as
`/dev/null` only after those runtime mounts exist.

KMS demos use the same metadata path. A profile can set
`runningPrimary` to include `"kms"` and declare an `init.shellCommand` such
as `/usr/local/bin/modeset`; the VFS image must contain that executable. The
Kandelo app attaches the KMS canvas through the generic KMS surface plumbing,
then runs the image-declared command. Do not add browser-loader branches that
import or spawn a specific `modeset.wasm` file.

Display capability and active display ownership are separate. The KMS
surface stays mounted and measurable while the terminal is selected, so
the next graphical application can discover its display size. The UI
offers the live graphics surface while a process holds DRM master. When
that ownership ends, the selected graphics pane returns to the terminal
and releases pointer capture and held buttons. A later graphical owner
reopens the surface. Dock replacements stop the actual display owner, even
when it was launched from a second terminal. Exiting an unrelated process
leaves it unchanged; a Wayland client exiting does not close its compositor's display.

A dock replacement is a real quit followed by a new start. When the old
owner exits, the terminal becomes selected and Demo is unavailable. The
terminal shows the replacement script's progress and any errors. Demo and
its dock controls return when a new process takes display ownership; a
failed command leaves the terminal visible without a display owner.
Progress subscribes through `dispatchShellCommand`'s awaited `beforeWrite`
hook, after the previous command's queue and prompt readiness. The old
program's returning prompt must not be treated as the replacement exiting.
Prompt readiness checks the end of the complete terminal history, so an
earlier prompt cannot make a currently busy terminal appear ready.

A bitmap interface can declare `presentation.displayScale` (0.5–4 CSS
pixels per guest pixel). The browser advertises a virtual display sized
from the CSS content box divided by that scale, at 96 reference DPI.
For example, a 1440×810 CSS pane at scale 1.5 advertises 960×540 at both
1× and 2× browser density. Fonts, artwork, hit targets, cursor hotspots,
and absolute input all use that one guest grid. The whole bitmap is
scaled for presentation; this does not give raster fonts native-density
outlines. The normal connector bounds, 640×480 through 3840×2160, still
apply. Small panes can therefore fit the minimum mode rather than
maintaining the requested scale. Set this before launching a graphical
client; there is no KMS hotplug or automatic client mode switch. The
virtual connector also lists 17 standard resolutions from 640×480 through
3840×2160, deduplicating its preferred mode. Applications can select those
modes through ordinary SDL/libdrm APIs; the browser fits the chosen scanout
and aspect ratio.

Presentation fits the complete selected scanout and cursor inside the
viewport, scaling up or down while preserving aspect ratio. Only the
rendering canvas captures guest keys, leaving host controls usable.
There is no host-side scaling control: changing the preferred mode does
not resize an existing KMS client, and a saved application resolution can
override the preference on relaunch. Applications with display options
can change their selected resolution through those options. A live UI
scaling control needs application-supported relayout or a working display
resize notification path before it can offer a reliable size change.

Omitting `displayScale` preserves native device-pixel output and CSS-derived
physical size, so Wayland compositors and DPI-aware applications retain
ownership of their scaling. This setting belongs to image presentation
metadata, not application font, theme, or coordinate patches.

Pointer input waits for the first published scanout size; the canvas's
initial allocation is not an input coordinate space. Absolute positions
are confined to valid pixel indices, including captured drags outside
the pane and subpixel rounding at its edges, then encoded in the fixed
0–65535 absolute-device range. SDL and libinput can keep their cached
axis bounds across display mode changes. Sending an out-of-window
position to SDL's direct-display backend can clear mouse focus, hiding
its cursor and dropping window focus for subsequent input.
SDL's evdev adapter also maps inclusive device bounds to inclusive
display pixels, for both ordinary input and overflow recovery. LÖVE uses
SDL2's KMSDRM window/input backend and its upstream SDL mouse module; it does
not interpret device units as pixels or add a separate coordinate transform. The
maximum axis sample reaches the last pixel rather than `width` or
`height`; out-of-range device samples are confined to the same bounds.

Clicking a KMS surface with a guest-rendered cursor captures the pointer
when the browser supports it. A brief **Press Esc to release** hint appears;
there are no pointer-capture dock controls or image-specific settings. Capture
starts after the click's down/up reach the guest, preserving that first click.
Touch taps never request capture.

Locked relative mouse motion accumulates in the same fitted scanout grid as
ordinary absolute input, retaining fractional motion and clamping at the
edges without hidden overshoot. Both evdev and PS/2 consumers receive that
position and button state; clicks use the integrated position rather than
frozen browser client coordinates. Escape, window blur, a hidden document,
pane changes, and teardown release capture and held buttons. Rejected
requests surface an error. Surfaces declaring `hostPointer` keep ordinary
browser pointer handling, since locking would hide their only cursor.
Node input devices are unchanged: pointer lock is a browser presentation
facility, with no guest package or device-mode change.

The display also mounts a transparent cursor plane over the scanout.
Linux `MODE_CURSOR` / `MODE_CURSOR2` requests update its shape, hotspot,
and position independently of application frames, through SDL or libdrm.
The worker snapshots cursor pixels and presents changed state at vblank;
it never paints a cursor into a guest's saved scene or uploads the scene
on cursor motion. The overlay uses the scanout's fitted coordinate space
and cannot intercept input. Both Node and browser retain the same cursor
device state; Node has no visual surface unless the embedder attaches one.

DRI pixel backing belongs to kernel buffer references, including unmapped
PRIME imports, framebuffers, and cursor selections. Retiring a process's
host mappings cannot destroy it. Normal close, forced removal, and failed
spawn cleanup release the same kernel references; only the final-reference
notification destroys host storage and derived GPU textures. Spawn also
retains inherited cursor references, balancing its later close/exec path.

CPU-backed mappings publish only bytes changed since each mapping's last
snapshot. Map/unmap, cursor and scanout presentation, foreign-texture
submission, and imported-buffer readiness synchronize through the same
canonical backing. Importers may write; unchanged readers cannot erase
newer pixels. This is boundary synchronization, not live memory aliasing;
applications must synchronize overlapping writers. Each live mapping uses
at most one BO-sized private snapshot inside the disposable kernel worker,
released on unmap, exec, or exit. Neither snapshots nor guest memory views
are sent to persistent browser realms.


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

### Experimental image-owned terminal sessions

An image selects its terminal program with the strict experimental file
`/etc/kandelo/experimental-terminal-session.json`:

```json
{
  "kind": "kandelo-experimental-terminal-session",
  "version": 1,
  "initial": {
    "path": "/usr/bin/login",
    "argv": ["login", "-p", "-f", "maker"],
    "uid": 0,
    "gid": 0
  },
  "afterExit": {
    "path": "/usr/bin/login",
    "argv": ["login", "-p"],
    "uid": 0,
    "gid": 0
  }
}
```

This file completely replaces `/etc/kandelo/shell.json`; the browser neither
reads the old path nor supplies a fallback shell. The experimental name is an
intentional warning that this image-facing session-supervision contract is not
stable. A missing, malformed, oversized, or unsupported declaration fails
loudly.

The loader parses the declaration from the fully staged VFS image, rejects
unknown fields, bounds the document, paths, arguments, and guest IDs, requires
normalized absolute executable paths, and verifies each configured program is
an executable regular file. It then launches the program through the kernel's
normal VFS `exec` path. First-party and custom images use exactly the same
parser and supervisor; image origin does not select terminal behavior.

Each newly allocated logical terminal starts `initial` once. When that process
exits, the same terminal starts `afterExit`, when present, with bounded restart
backoff. Closing and reopening the terminal UI only detaches and reattaches its
renderer; it neither repeats the initial program nor replaces the guest
process. Removing the logical terminal, detaching the kernel, rebooting, or
destroying the host stops its active process and cancels pending restarts.

The canonical rootfs uses root-started `login -p -f maker` as `initial`, then
ordinary `login -p` after logout. Authentication and preauthentication remain
inside the guest `login` program and ordinary VFS account files, not React.
`login` is an eager root-owned `04755` package output; `sudo-lite` and `sudo`
are root-owned `04755` lazy outputs. The writable root image honors those
set-ID modes unless its mount explicitly requests `nosuid`.

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
| Shell | `shell.vfs.zst` | `./run.sh build shell-vfs` | package-built platform rootfs plus shell demo assets; Bash and login are embedded; every other program — sudo, the ordinary command set, and the demo machines' programs — is a first-use package output, and the composer rejects any other program it would embed |
| WordPress | `wordpress.vfs.zst` | `bash images/vfs/scripts/build-wp-vfs-image.sh` | WP files, nginx/PHP configs |
| LAMP | `lamp.vfs.zst` | `bash images/vfs/scripts/build-lamp-vfs-image.sh` | MariaDB + WP + configs |
| MariaDB test | `mariadb-test.vfs.zst` | `bash images/vfs/scripts/build-mariadb-test-vfs-image.sh` | MariaDB + test suite |

Node, WordPress, and LAMP are optional demo profiles. Their VFS asset imports
are resolved only after that profile is requested; loading the main shell does
not require or fetch those image bytes. If the selected profile's local or
resolver-managed artifact is absent, the browser reports that exact missing
image and asks the user to run `./run.sh local-build`.

Normal Vite development resolves exact optional binary URL globs through
the verified binary resolver, including the implicit SourceOnly tree.
The authored legacy mirror need not exist for a built image to be found.
Absent assets remain unavailable; provenance failures propagate instead
of being treated as missing files. Lazy globs admit an asset only when its
loader is called. Each admission checks it together with required and already
admitted assets in one provenance tier; an unused optional image cannot block
an unrelated profile. Production builds still resolve their bundled imports.
The browser benchmark harness refreshes public application images from the
verified resolver on each run; existing public copies do not establish artifact
identity and cannot bypass a missing or rejected package. Explicit SourceOnly
builds retain
their snapshot, syntax, and fallback-denial checks.

Browser binary dependency audits parse authored JavaScript and TypeScript,
including nested source directories. App-root `test-results/` and
`playwright-report/` are reserved for generated browser evidence and are
excluded from that scan. Trace resources can contain network response bodies
saved with MIME-derived extensions; they are not browser source inputs.
Malformed authored modules still fail the audit, with their file path in the
parse error.

The standalone MariaDB demo and MariaDB test images run `mariadbd` as the
`mysql` account (uid/gid 101). Their writable `/data` directories are
therefore serialized as `101:101` with mode `0775`; `/tmp` remains a
root-owned `01777` sticky directory.

Generated VFS images are `.gitignore`d rather than committed. Package-backed
images can be materialized from a current public package archive; the normal
resolver falls back to the package's source recipe when needed. The `run.sh`
script handles this automatically before starting the browser.

### Building VFS images

Package-backed image recipes resolve their declared dependencies rather than
reading another package's source/build side effects. The disabled legacy
`python-vfs` recipe, for example, consumes CPython's `python.wasm` and
`python-runtime.zip` closure. These compatibility recipes are excluded from
staging. For the active browser
products, use the local DAG command in
[Package Management](package-management.md#local-dag-build); it selects the
product manifests and every transitive package input before invoking a
builder. Individual legacy image targets remain available for focused work:

```bash
./run.sh build python-vfs    # Build Python VFS image
./run.sh build shell-vfs     # Build Shell VFS image
```

The main shell target resolves the canonical `packages/registry/shell` package
into `local-binaries`; it does not invoke another package's source tree or
fbDOOM build directly. The package recipe restores the exact package-built
platform rootfs, adds the package-owned shell demo data, and serializes one
image. Bash and `login` are embedded boot inputs. `sudo-lite`, upstream `sudo`,
and the ordinary command set retain authenticated package-backed lazy outputs
that resolve through the normal VFS path on first use.
The command set includes jq 1.8.2 at `/usr/bin/jq` (also `/bin/jq`),
with its bundled Oniguruma regular expressions and decimal-number support.
Its executable stays lazy until first use, including for commands such as
`printf '%s\n' '{"answer":42}' | jq '.answer'`.
PHP 8.5.12's CLI is also a lazy executable at `/usr/bin/php` (with a
`/bin/php` alias). Running `php -r 'echo 6 * 7, PHP_EOL;'` fetches it on
first use. PHP 8.5 includes OPcache in the executable; caching stays disabled
by default. The PHP-FPM images explicitly enable its file-cache-only mode
because cross-process shared-memory caching remains unsupported.
Their cache tree is owned by the PHP-FPM worker account (`nobody`), so
workers can update prewarmed entries and cache new scripts. CLI caching
stays disabled in these images: terminal commands run as `maker`, which
does not own the server cache. To enable CLI caching, explicitly select
a separate writable directory with `-d opcache.enable_cli=1` and
`-d opcache.file_cache=/path/to/your/cache`.
Composer 2.10.3 is a separate lazy archive at `/usr/bin/composer`
(also `/bin/composer`). Its package pins the upstream signed PHAR by SHA-256
and carries the PHAR, curl, and zip PHP extensions. The launcher enables those
extensions for Composer only; invoking `php` keeps its normal configuration.
The archive and PHP executable remain deferred until used. For example,
`composer dump-autoload --no-plugins --no-scripts` generates an autoloader for
a local project. PHP-FPM is not installed by these declarations.
`./run.sh --fetch-only build shell-vfs` refuses source fallback.

Shell-derived packages consume that resolved image as a declared dependency.
Their builders preserve capacity, ABI identity, package-backed lazy transports
and seals, and record the exact shell digest and byte count in their own
metadata. A revision bump on the shell therefore changes the cache key of
`nginx-vfs`, `nginx-php-vfs`, `nginx-python-vfs`, `lamp`, and `wordpress`
through the
normal dependency graph.

Hosted GitHub Pages publication is disabled. Its retained workflow is outside
the active workflow directory, and package activation no longer dispatches a
deployment. The normal `run.sh browser` path and pull-request browser suite
remain active consumers of the same package-built VFS products. Re-enabling a
hosted site requires separate review and fresh package-backed deployment
evidence; an older hosted site is not evidence for the current source or
package index.

The dormant source-rootfs and eager closed-selection implementations
remain diagnostic and historical recovery plumbing. Normal browser startup,
package staging, and active continuous integration do not invoke them. Retired
lazy formats do not gain compatibility shims.

### Adding a new VFS image

1. Create `images/vfs/scripts/build-<name>-vfs-image.ts` — import helpers from `vfs-image-helpers.ts`
2. Create `images/vfs/scripts/build-<name>-vfs-image.sh` — shell wrapper that runs the TypeScript script
3. If the image is consumed by Kandelo, add a tracked
   `packages/registry/<image>/<name>-demo.json`, list it in
   `TRACKED_DEMO_CONFIG_SOURCES`, and bake it with
   `writeTrackedDemoConfig(fs, "<that path>")` from
   `images/vfs/scripts/tracked-demo-config.ts`
4. If the image is consumed by the Kandelo UI, expose it through a gallery
   manifest, preset, or direct `vfs` URL so the UI can fetch the `.vfs.zst`
   image and boot it; the UI reads presentation metadata from the image with
   the image writer module (`KandeloImageFs`) before booting it
5. Add a build target in `run.sh`

The shared helpers in `vfs-image-helpers.ts` provide:
- `writeVfsFile(fs, path, content)` / `writeVfsBinary(fs, path, data)` — write files
- `ensureDirRecursive(fs, path)` — create directory trees
- `symlink(fs, target, path)` — create symlinks
- `walkAndWrite(fs, hostDir, mountPrefix, opts?)` — recursively walk a host directory into the VFS
- `saveImage(fs, outFile)` — export through the Rust writer, check headroom, capacity and Wasm artifacts, compress, and write the image to disk

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

### Local SourceOnly development

`./run.sh browser` is the normal development entry point. It runs or resumes
the complete local SourceOnly DAG, exports its validated
`local-binaries/source-only-v1` projection to Vite, and starts the development
server. It does not fetch a browser binary index. Unchanged package and
product nodes are reused from the content-addressed
cache.

The development server reads VFS products directly from that projection. The
authenticated VFS group below belongs to production output and is generated
only when building a deployable directory-scoped distribution.

### Directory-scoped production hosting

The standalone [`apps/spacefast-cors-proxy`](../apps/spacefast-cors-proxy/README.md)
implements the Playground proxy protocol for Spacefast Functions,
including the range alias used by this browser app. Its production entry uses
ordinary Spacefast Fetch as an explicitly approved workaround: live testing
on 2026-10-15 found that Spacefast rejects the original pinned TCP transport.
URL validation still rejects private IP literals, local host names, credentials
and self-targets, and redirects return through that validation. DNS resolution
and connection-time private-network protection belong to Spacefast in this
mode. Kandelo cannot prevent DNS rebinding; the platform's protection has not
been verified. The optional pinned transport remains available in the core
and covered by local TCP/TLS fixture tests. The entry uses the Space's database
for per-identity token buckets matching Playground's 1,000-token capacity and
100/minute refill. A native PHP Function verifies Spacefast's guest/account
identity and issues a signed, proxy-scoped quota token. Browser transports
persist it on the app's origin, so a separate proxy needs no third-party
cookies. This changes the abuse boundary: new guest identities can get fresh
budgets, unlike Playground's per-IP policy. SQL and PHP are locally tested;
a private live diagnostic verified guest issuance and a proxied fetch.
The existing v9 deployment retains the earlier shared fixed-window limiter.
The app's build command can select this proxy explicitly, and its packager
can colocate the app and `/cors-proxy` in one Space. A live Chromium check on 2026-10-15 verified a guest `curl`
request through the same-origin proxy with HTTP 200 and exit status 0. The live
serving path requires the range alias, omits HEAD Content-Length, and did not
preserve the worker's CORS origin grant in private-Space probes. See that app's
README for commands and the precise scope of validation.
The packager applies isolation headers to document URLs and worker scripts,
including clean document aliases. It leaves large binary downloads on
Spacefast's static serving path: custom isolation headers on files above
100 MiB cause `response_headers_unservable` during finalization.

A production build owns one normalized absolute deployment prefix. Build and
host the output with the same value: output built with `VITE_BASE=/a/` must be
served at `/a/`, and output built with `VITE_BASE=/candidate-b/` must be served
at `/candidate-b/`. A completed build is not freely relocatable, and
`base: "./"` is not a supported substitute for choosing its public path.

`./run.sh build-browser [--base /prefix/] [--out DIR] [--cors-proxy URL] [--signalling-url URL]` performs every step
below for one prefix (default `/`, output `apps/browser-demos/dist`) and
fails if the output lacks `index.html`, `service-worker.js`, the VFS
group, or `signalling/piplet.php`, or contains the private product map.

`--cors-proxy` sets the production `VITE_CORS_PROXY_URL` explicitly inside
the clean development shell. It accepts an absolute proxy prefix or a
same-origin prefix such as `/cors-proxy?url=`. Both endpoint flags override
their exported `VITE_CORS_PROXY_URL` / `VITE_KANDELO_SIGNALLING_URL`
variables. When neither a flag nor its exported variable is set, Vite can
load that value from its normal `.env` files. Without a proxy override, the
existing Playground production default is retained. Spacefast deployment is
optional: the reusable `node scripts/deploy-spacefast.mjs --space ORIGIN` prepares
the combined bundle; `--publish` explicitly publishes it and `--dry-run`
runs local CLI checks instead. The target has no saved default. See the
[deployment guide](../apps/spacefast-cors-proxy/README.md#combined-kandelo-site).
A normal build never publishes or signs in.

The SourceOnly local DAG described in
[Package Management](package-management.md#local-dag-build) is the canonical
way to build the registered VFS products. Produce
`local-binaries/vfs-group` and its private product map, then pass both explicit
paths to each production build:

The group producer pins one SourceOnly authority and captures, verifies and
stages one body at a time. Each capture is limited to 512 MiB (callers may
select a smaller budget); the complete on-disk deployment may be larger.
When reusing a group, compare it within the total byte count verified from
its manifest, rather than applying the per-capture memory ceiling to disk.
Only byte counts and hashes remain in the manifest inventory. Every lazy
body must match its image's size and archive digest before the completed
group and private map are published. A failed capture removes unpublished
staging and preserves the prior generated outputs.

```bash
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
npx tsx scripts/build-local-vfs-asset-group.ts \
  "$PWD/local-binaries/vfs-group" \
  "$PWD/local-binaries/pages-vfs-products.private.json"
export KANDELO_PAGES_PRODUCT_MAP="$PWD/local-binaries/pages-vfs-products.private.json"
export KANDELO_PAGES_VFS_ASSET_GROUP_DIR="$PWD/local-binaries/vfs-group"

VITE_BASE=/a/ npm --prefix apps/browser-demos run build -- \
  --outDir "$PWD/build/a" --emptyOutDir
VITE_BASE=/candidate-b/ npm --prefix apps/browser-demos run build -- \
  --outDir "$PWD/build/candidate-b" --emptyOutDir
```

Vite authenticates and copies the complete group beneath the owning output as
`vfs-groups/release-1/`: manifest, every registered image, and every lazy
asset those images reference. The private map is not published. Changing the public group path
requires regenerating the complete manifest/images/assets handoff, updating
the private map to its new manifest path, and rebuilding the distribution.
Never move a group within an already completed build. Its complete group must
remain beneath the owning prefix; moving only an image or asset also breaks
the authenticated inventory.

Every lazy address names its package-mirror path, so it maps to an asset
by rule: the shell's SDK archive, `kandelo-lazy:programs/wasm32/kandelo-sdk.zip`,
maps to `assets/programs/wasm32/kandelo-sdk.zip`, and its LÖVE examples
archive, `kandelo-lazy:programs/love/share/love-examples.zip`, maps to
`assets/programs/wasm32/love/share/love-examples.zip`, preserving the
package's runtime-file location. An address outside that grammar is
invalid.

Each output places `service-worker.js` at its prefix root. The bootstrap
registers that exact script with its own script-directory scope (`/a/` or
`/candidate-b/`). Servers must not grant a broader scope with
`Service-Worker-Allowed`: one worker must never control `/` or a sibling
deployment. Bridge authority, cookie jar, cross-origin-isolation retry marker,
and lazy VFS cache are separately namespaced by registration scope. Restarting
one worker restores only that prefix's durable state. The Kandelo theme is the
intentional origin-wide exception because it is ordinary `localStorage` UI
preference state, not machine, bridge, cookie, retry, or VFS state.
Within one scope, that bridge authority and cookie jar are further split per
machine by its SW-minted name — see [Multiple machines under one service
worker scope](#multiple-machines-under-one-service-worker-scope) — so
restarting one worker restores every machine that scope was hosting, each
from its own persisted record.

The production coexistence scenario has been measured in Chromium with `/a/`
and `/candidate-b/`: both shells booted, Vim materialized from each prefix's
own lazy cache, and restarting/updating `/a/` left `/candidate-b/` usable and
unchanged. This is evidence for that scenario, not a claim that every browser,
host configuration, or arbitrary prefix pair was exercised.

If one prefix retains a stale worker, unregister only that exact registration
from a page on the same origin, then reload that prefix:

```javascript
const selectedScope = new URL("/a/", location.origin).href;
for (const registration of await navigator.serviceWorker.getRegistrations()) {
  if (registration.scope === selectedScope) await registration.unregister();
}
location.assign(selectedScope);
```

Do not clear all origin storage: that would erase sibling deployment state and
the origin-wide theme preference instead of repairing the selected owner.

During development, `@binaries/...` imports can resolve to canonical package
members outside the checkout. Vite's directory allow list is only transport
plumbing: a pre-serving guard permits the exact regular files approved by the
binary resolver and rechecks their real paths on every request. Other program
cache entries, source-cache files, symlink escapes, malformed filesystem URLs,
and descendants created by replacing an approved file with a directory receive
HTTP 403. Production builds emit ordinary bundled assets and do not expose the
local package cache.

With `WASM_POSIX_RESOLUTION_POLICY=source-only-v1`, the browser build also
requires `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` to be a normalized canonical
absolute directory. Its fixed
`.kandelo/source-only-program-projection-v1.json` authority is capped at
16 MiB and embeds the selected `kandelo-program-packages-v2` projection plus
sorted package nodes and their materialized member mode, size, and SHA-256.
The resolver validates exact node ownership and the complete owning package
closure. It does not fall back to `local-binaries`, fetched/indexed binaries,
the ordinary compiled cache, or an installed host package.

SourceOnly materializations are regular files and may be replaced by a later
producer run. Vite therefore parses one aggregate authority for its lifetime,
captures its authored kernel, rootfs, and program request batch against that
generation, and copies the verified bytes into a private immutable temporary
directory. The complete retained set is limited to 512 MiB before allocation.
Development streams those snapshots from a content-addressed virtual endpoint;
production emits the same snapshots as normal Rollup assets. Exact optional
mirror globs are rewritten through that boundary, while package-output and
public artifact globs are forced absent instead of becoming fallback tiers.
Array-valued globs are rejected before Vite because the browser binary scanner
admits only one exact scalar path per request. SourceOnly also gives Vite a
private snapshot of the commit-bound authored static-file allowlist in
`public/`; every other ambient file is denied in development and omitted from
production regardless of its suffix. The snapshot directory remains owner-only
(`0700`), while its static files use `0644` because Vite preserves those modes
when copying them into the production output. This lets a web server running
as another user read the deployed service worker and other public files.

Native lazy archive activation supports ZIP. Generic gzip, tar and zstd
activation from the former TypeScript filesystem is not implemented; boot
image zstd decoding remains a separate transport operation. Browser worker
builds inline their dynamic imports, while source-level dynamic imports stay
lazy in the shared and Node.js paths. Browser workers trade some initial
parse and download size for an emitted bundle that cannot depend on an entry
after Vite removes its synthetic exports. The production graph guard
rejects every static or dynamic edge back to a stripped entry, including a
binding-free static edge that would still evaluate the stripped entry.

Optional php, SQLite, and benchmark inputs still depend on ambient build
outputs and are therefore rejected under SourceOnly; the supported root build
inputs are `main`, `kandelo`, and `network`.
The configured SourceOnly root remains the only external filesystem root in
Vite's allow list, and direct `/@fs/` requests for its members remain forbidden.
Other pathname resolver APIs validate the named file and artifact policy
against one stable descriptor read, but the returned path remains a
point-in-time result; callers that retain a path across producer runs must
resolve it again.

## Known Limitations

### SharedArrayBuffer restrictions
Chrome rejects SharedArrayBuffer-backed views in `TextDecoder.decode()` and `crypto.getRandomValues()`. Always copy to a temporary non-shared buffer first.

### Network lab multi-kernel completion

The `/pages/network/` demo currently has a browser-worker scheduling
regression when two independent kernel instances run GNU Netcat concurrently.
The UDP payload is delivered through `LocalVirtualNetwork` and appears in the
receiver's stdout, but both process workers can stop making progress before
exit; the subsequent TCP and curl scenarios therefore do not start. The
Playwright scenario is marked as an explicit expected gap until the browser
multi-kernel completion path is fixed. Node.js virtual-network tests continue
to exercise packaged Netcat UDP and TCP traffic, so this limitation does not
claim that browser completion is working based on Node-only evidence.

### No external raw sockets
Browser sandboxing prevents Kandelo from listening on real network ports or opening raw TCP/UDP sockets to arbitrary external peers. Local loopback sockets and `LocalVirtualNetwork` listeners are virtual sockets inside the browser session, so Kandelo machines can still communicate with each other using POSIX UDP/TCP. Browser-facing HTTP server demos use a service worker to intercept HTTP requests and inject them as kernel TCP connections via the connection pump.

Outbound internet traffic leaves through the fetch and TLS bridges, which the guest sees as a NAT link: `eth0` is `10.0.2.15/24`, internet streams report that address from `getsockname`, and DNS names resolve to made-up addresses in `198.18.0.0/15`. The link carries TCP only, so a UDP datagram for anywhere beyond the machine fails with `EHOSTUNREACH` (see [architecture](architecture.md)).

### Purpose-checked browser peer connections

The network panel can also consume optional
[package-declared offer and join procedures](package-sessions.md). Hosts choose
an optional activity and its setup, then create a typed invitation in the
same form that creates a room. Existing rooms can be kept or replaced, and
the panel also offers Leave. Rooms suggest editable, playful random names.
Creating an invitation opens a separate active-session dialog and attempts
to copy its final link; Copy link and Change activity remain available there.
The dialogs keep a stable responsive frame with a scrolling body. The
session name precedes activity and status, with vertical space around
prominent status cards. Descriptions
and package details are collapsed under About this activity. Package-declared
warnings appear only for the selected activity, data source, menu choice or
level; selecting a different option removes the old warning. The
invitation preview applies the same stored/system theme before host setup,
so it does not change palettes when the app mounts. New
invitations include bounded display details so recipients see activity and
host settings, participant prompts and acquisition hints even before host
initialization finishes. Controls remain disabled until those details match
the installed package. Older links populate their prompts after boot. A
prominent readiness card explains the wait before joining. Copy confirmation
and data-transfer progress use the same card, with actual received bytes,
a percentage and a progress bar during transfers. A replacement prepares its data before cancelling the
previous activity's owned terminal family and awaiting its workers; other terminals still require
their own shutdown. Declared data dependencies can be sent over
WebRTC or supplied as acquisition hints and verified local-file choices.
Doom and Quake offer pinned shareware/free data or a file picker even on a
bare shell. Their starting-level pickers use catalogs from pinned data or
bounded directory inspection of an uploaded WAD/PAK. Freeciv uses its bundled data and native pregame lobby. Service
images can share their running website or database; those invitations select
the standard shell client image and omit the server’s demo profile.
An actual framebuffer owner also enables the Demo view on a shell-only
profile, so these activities can display their output without a game profile. Recipients provide
their own participant settings and explicitly join before their copy starts
in a fresh terminal. These declarations are installed package runtime files;
the browser does not hardcode termchat or Doom launch commands. Activity links
defer the selected image's shell auto-command and init target while preparing
its resources. KMS activities mount and measure a real scanout before launch;
they become visible when the guest acquires the display device.

Network sessions carry IPv4 multicast as well as unicast and broadcast, so
[termchat](termchat.md) can discover other running instances and exchange
messages/files through ordinary guest sockets. Membership and filtering stay
in the kernel. This does not expose raw physical LAN sockets to browser code.

The Kandelo app's dock has a network button for **network sessions** between
independent computers that are already running. Creating a session makes this
computer the host of a `10.89.0.0/24` link (`10.89.0.1`) and shows an invite
link carrying a random room token, the session's name, and the machine the
host runs (its `vfs` image and `profile`, as a Share link names them), never
the fragment where startup scripts travel. Opening the link boots that machine
and opens the panel with a Join button; joining always waits for that click, because it shows the hosting
computer this computer's network address. A session admits up to 31 joiners;
the host forwards their traffic in its dedicated kernel worker, and the panel
lists the computers and addresses the worker reports. Booting another machine
or leaving ends this computer's part in the session, and a host leaving ends
it for everyone, with the reason shown. The bare `/pages/peer-network/` page
connects machines it boots itself, with the same transport. Its Doom/Quake
controls select guest applications on the connected machine, rather than
machine profiles. The machine-identity source guard admits only the named
`PeerNetworkGame` selector type; image-owned machine definitions still belong
in `/etc/kandelo/demo.json`.

Both use `purpose: "network-activities-v2"` peer connections, including a
separate reliable `activity-data-v1` channel for explicitly offered data
and `activity-offers-v1` for bounded host activity discovery. A joined
client’s Change activity menu uses only alternative host offers, omitting
its current activity and hiding the button when none remain. New session
separately opens local hosting choices and replaces the client’s room. See
[invitation compatibility and discovery](package-sessions.md#invitation-compatibility-and-discovery).
This channel never exposes a general guest-file read service. The main thread transfers
framed bytes between RTC channels and bounded native MessagePorts. Guest
programs use ordinary IPv4 UDP and TCP sockets; DNS names `host` and
`peer-N` resolve through the worker's segment membership, and broadcasts
reach every computer in the session, so LAN discovery works: in Chromium, a
joiner's `fbdoom -localsearch` finds the hosting computer's server, and
TyrQuake's own menus find each other: on the Quake machine, Multiplayer →
New Game on one computer and Multiplayer → Join a Game → Search for local
games on another list and join the game, with no restart, even though Quake
was already running when the session started. (Upstream TyrQuake 0.71 never
registers its network console commands, so New Game could only start a
one-player game that never listened; the package's
`0005-register-network-console-commands.patch` registers them.) A LAN game
should run as a private server (`fbdoom -privateserver`): the browser's
internet egress carries TCP only, so UDP to Doom's internet master server
fails with `EHOSTUNREACH`, and fbdoom stops with a fatal error when its
registration send fails. The Doom machine's **LAN game** dock menu runs
these commands for the player: a host co-op or deathmatch entry restarts the
game as `fbdoom -server -privateserver -nodes N` (plus `-deathmatch`), so
the host plays and the game starts once N players have joined. While it
waits, each computer shows chocolate-doom's waiting room on its display (who
has joined, drawn with Doom's font, since fbDOOM lacks the textscreen
library upstream uses): the host can press Space to start sooner with
whoever is there, and Esc quits; **Join a LAN game** runs `fbdoom
-autojoin`, which searches the session by broadcast and stops with "No
server found on local LAN" when none answers; and **Back to single player**
restarts the ordinary game without leaving the session. Every player uses
the shareware WAD the machine fetched at boot, so all computers load the
same game data. Node runs the same segment over paired native ports; its
built-in runtime has no WebRTC API, so creating RTC links remains a browser
adapter capability.

Computers find each other through the signalling piplet's rooms. The
development server relays the real `apps/signalling/piplet.php` same-origin
at `<base>__kandelo_signalling`, run by PHP from `apps/signalling/tools.nix`
(or `KANDELO_SIGNALLING_PHP`, or `php` on `PATH`). Production defaults to
the same-origin `<base>signalling/piplet.php`: a build for `/kandelo/` uses
`/kandelo/signalling/piplet.php`. Override it with
`VITE_KANDELO_SIGNALLING_URL` when building; serve a
cross-origin endpoint with CORS. For example:

```bash
VITE_KANDELO_SIGNALLING_URL=/custom/piplet.php ./run.sh build-browser
```

The build forwards this deployment setting into its isolated dev shell.
The endpoint is embedded in the browser bundle; changing it requires a rebuild.
`build-browser` includes a copy of the PHP piplet at
`signalling/piplet.php` in the output directory. Serve that path with
64-bit PHP 8.3 or newer, and make its directory writable by the PHP server
user: the piplet stores session state by replacing its own file. Static-only
hosting cannot execute the included piplet; use a separately hosted PHP
endpoint and the URL override in that case. Replacing the deployed piplet
with a fresh build clears its active sessions.
If the endpoint is unavailable, session creation or joining reports the request
failure in the panel.

The Spacefast combined build includes a TypeScript implementation at
`/signalling`. Pass `--signalling-url /signalling` to `build-browser` to set
`VITE_KANDELO_SIGNALLING_URL` inside the clean build shell. Both computers
must be admitted by the Space's access settings. The endpoint uses MySQL
conditional updates for atomic matching across workers, preserving the PHP
session/room protocol and limits. It shares neither state nor request budget
with `/cors-proxy`. Packaging omits the portable PHP piplet from the
Spacefast output and leaves the original static build intact for WP Cloud.
See [Spacefast signalling](../apps/signalling/spacefast/README.md)
for storage, tests and hosting boundaries. Guest traffic still uses the peer
link; hosting signalling on Spacefast supplies no TURN relay.

WP Cloud remains a supported static host: build with
`--signalling-url /signalling/piplet.php` and keep serving the portable PHP
piplet there. An omitted `--cors-proxy` retains the production Playground
proxy; an explicit URL can instead select a standalone Spacefast proxy.
The separate-site layout is experimental: browser tests cover the protocol,
but Spacefast's live cross-origin serving layer has not been verified.
Build that separate worker with repeated `--allow-referer` origins for every
approved app (including a WP Cloud app's origin if desired). It requires actual
Referer admission as well as CORS grants; absent or unapproved Referers are
403 before upstream work. Preflight uses the approved Origin. These headers
are forgeable by non-browser clients, so the admission rule does not replace
rate limiting or deployment access controls. The worker's durable budget is
a 1,000-token bucket per verified guest/account identity, refilling 100 per
minute. Clearing the guest session and token can obtain a fresh identity;
this is weaker against quota evasion than Playground's IP-based policy.
Same-origin deployment uses Spacefast cookies to verify identity; a separate
proxy issues a narrow signed token that persists on the app's origin, so
third-party cookies are unnecessary. A configured trusted classification
header can enable Playground's search-engine exclusion; none is assumed.
See the
[standalone proxy recipe](../apps/spacefast-cors-proxy/README.md#separate-proxy-site)
for configuration, cross-origin hosting boundaries and the upstream comparison.



UDP uses an unordered channel with zero retransmissions; directory control is
ordered and reliable. The payload cap is the lesser of 65,507 bytes and the
negotiated SCTP ceiling minus 16 bytes. Oversized sends return EMSGSIZE and a
full worker-side bridge returns EAGAIN; admitted UDP can still be lost under RTC
congestion or remote socket closure. Each bridge direction caps pending storage
at 128 frames and one MiB. Membership and control messages are bounded, source
addresses are checked against link ownership, and disconnect removes remote
bindings and routes. Local Chromium checks demonstrate actual guest Netcat
messages in both directions and between joiners, plus two-player Doom and
TyrQuake with both players behind a separate forwarding host. Visible Chromium
checks used the normal browser launch and real PHP signalling server. These
runs require the local loopback ICE fixture: Chromium's loopback launch
flag plus a test-only microphone permission grant in every browser
context, including contexts opened from invitation links. The flag alone
does not expose the loopback interface through Chromium's candidate
filter. No media is captured, and the app does not request this grant.
These checks enable local loopback routes; default ICE failed to find a direct
route in the first visible check and reported that boundary. A Linux network lab
verifies a computer on another network joining with STUN only
(`apps/browser-demos/test/network-lab/`, run with its `run.sh`; it needs Docker,
which on macOS supplies the Linux VM). Each Chromium sits in its own home
network behind its own NAT router, which masquerades the home behind one public
address and drops unsolicited inbound traffic as a household router does; the
only route between the homes is through both NATs, and the only ICE server is
the lab's STUN server. The test checks that each side's selected ICE route is
the other router's public address with nothing relayed, then carries a guest TCP
stream across it. Networks STUN cannot cross (symmetric NATs, which need a TURN
relay), real internet paths between computers, long-duration games, and
Firefox/WebKit guest runtime behavior remain unverified. See the dated
[design and validation record](plans/2026-10-06-webrtc-guest-udp.md).

`web-libs/kandelo-session/src/peer-connection.ts` owns reusable WebRTC
connection setup. A consumer declares a purpose and named data channels with
their delivery options. Optional message chunking is available only for
reliable, ordered channels; raw channels preserve their declared delivery
semantics. This connection API does not itself connect guest sockets.

Connect codes retain the `kandelo1:` prefix and contain a bounded, UTF-8
base64 JSON envelope with SDP, offer/answer type, purpose and channel labels.
Codes are capped at 64 KiB. A different purpose or channel set is rejected
before creating a connection. Old codes without a purpose must be recreated;
there is no legacy compatibility path.

ICE gathering waits at most three seconds before emitting the candidates
available so far. The default servers provide STUN, with no TURN relay;
failure to find a direct route is reported explicitly. Consumers may supply
their own ICE servers. The Kandelo app takes its network sessions' ICE
servers from `VITE_KANDELO_ICE_SERVERS` when it is built or served: a JSON
array in `RTCIceServer` form, up to 8 servers with `stun:`, `stuns:`, `turn:`
or `turns:` URLs and an optional username and credential. A malformed list
fails the session with its reason rather than falling back to the public
defaults, and a deployment that wants peers behind symmetric NATs to connect
names a TURN server there. Missing channel arrival is bounded to 30 seconds after
ICE connects; the manual answer exchange has no deadline. Cancellation closes
pending channels and connections.

The network panel adds a short troubleshooting hint to peer connection
failures and connection timeouts. On detected macOS it points to System
Settings → Privacy & Security → Local Network; on Windows it points to the
browser's Windows Firewall entry. Other platforms get a general reminder
to check both peers' browser permissions, VPNs and firewalls. Platform
detection is best effort (including iPadOS identifying as a Mac); hints do
not inspect permission state or establish the cause of a failure. Invalid
invitations and signalling-server errors retain their own messages without
these peer-link hints. No permission prompts or media access are requested.

Close and failure subscriptions expose established connection teardown.
Late failure subscribers receive the recorded connection error once, so an
ICE failure during an asynchronous consumer handoff is not lost. An orderly
close does not report a connection failure.

Session sharing, which declares its own reliable, ordered and chunked
channels as the `migration` purpose, is not yet on main; it lands with
the session-sharing work in #1372.

`apps/signalling/piplet.php` and `apps/browser-demos/lib/peer-signalling.ts`
carry the offer and answer as opaque connect codes. The server does not
interpret purpose or carry guest traffic. Two shapes share one store:

- A **session** pairs two computers under a human-chosen name. The name
  grants access to its codes; sessions expire after ten minutes and are
  bounded to 256 stored sessions, with a 64 KiB limit per code.
- A **room** matches many computers to one host under a random 20-64 letter
  token. Joiners post offers under the token; the host collects waiting joins
  on each heartbeat and answers or refuses each one. Only the host may
  answer, refuse or close, proven by a random key in the
  `X-Kandelo-Host-Key` header that never leaves the hosting computer; the
  piplet stores only its SHA-256. A room expires 60 seconds after its last
  heartbeat and an unanswered join after 120. Rooms, waiting joins per room,
  names and the whole store are bounded.

Anyone holding a room token can ask to join, and an answered join carries
the host's network addresses, so a token is a capability: share it only with
the people you mean to invite.

### Memory per process
Each process gets a fresh memory layout whose requested initial pages cover the
program's imported minimum memory and low syscall control area; it does not
allocate `maxPages` at spawn. Every process generation receives a newly
constructed `WebAssembly.Memory`, and an exited generation is never reused by a
later process. `maxMemoryPages` still caps each backing's guest brk/mmap growth
and should be tuned for workloads that need large address spaces. Fork
synchronously copies the parent's exact current byte length into another fresh
backing so its observable `memory.size()` and accessible address-space boundary
match the parent before any asynchronous Worker launch work can yield. Before
constructing that backing, fork synchronously checks both live capacity and
the retired-generation count and byte thresholds. Saturated retirement debt
returns `EAGAIN` without allocating or copying another full address space; an
asynchronous pre-copy wait would let another parent thread invalidate the
fork-time snapshot.

Browser `Worker.terminate()` is not treated as proof that a Worker stopped
touching shared memory. Cooperative exit and exec publish an exact terminal
message after worker-main returns. Forced paths drop host aliases without ever
recycling the backing. Whole-kernel destroy terminates nested process/thread
Workers before terminating the containing kernel Worker realm, which is the
final fallback for incomplete graceful detach.

Teardown first wakes blocked Workers into a cooperative exit instead of
terminating them while they wait. `Worker.terminate()` on a Worker blocked
in an atomic wait leaves it waiting, with its thread and memory unreleased,
on Bun 1.3.3 today; Playwright WebKit showed the same on build webkit-2311
and no longer does on webkit-2359, and released Safari has not been
rechecked. The mechanism is described in
[the terminate workaround page](jsc-terminate-atomics-wait-workaround.md);
the evidence, the standalone reproductions and the removal criteria are in
the registry entry
[`JSC-TERMINATE-ATOMICS-WAIT-LEAK`](../tests/runtime-workarounds/JSC-TERMINATE-ATOMICS-WAIT-LEAK/entry.md).

Audio and framebuffer presentation use independent bounded shared buffers.
A view into kernel or guest memory retains the full address space, even when
only a tiny ring or pixel window is visible. Persistent page and worklet realms
must not become owners of those address spaces: dropping a view or disconnecting
a node does not establish a collection deadline. See the device sections above.

Process exit executes `unreachable` inside a disposable Wasm helper. A
`WebAssembly.RuntimeError` constructed and thrown in JavaScript is still a
catchable host exception. Exec retirement pairs the Wasm trap with an exact
private channel marker. A JS exception can enter libc++'s `noexcept`
handler, which writes to the already-retired syscall channel and permanently
parks the discarded Worker. Import adapters can replace a trap's JavaScript
identity, so the Worker boundary recognizes the marker, skips guest cleanup
that could issue more syscalls, and publishes `exec_retired` before its terminal
`memory_quiescent` message. Committed normal exit also bypasses guest cleanup:
its deallocators cannot use a channel after Rust has recorded exit. The
disposable realm releases the remaining state; pthread exit still releases host-side replication locks for
the surviving process. These terminal paths are shared by Node/Bun and browser
workers.
Workers parked after Rust has recorded exit are woken too. A private exit
retirement marker unwinds them without a second exit syscall or exit message,
preserving the recorded status and parent notification. This covers signal
exits and blocked siblings after `exit_group`, which forced termination cannot
reclaim on WebKit.
Browser main allows up to 15 seconds for the kernel worker's bounded cleanup
phases before terminating its realm; a two-second outer deadline can interrupt
exec retirement, process draining, framebuffer release, or PCM draining.

Teardown also retires every pending futex engine wait before deleting its
registration. Clearing a JavaScript map does not cancel `Atomics.waitAsync`:
the engine retains its promise reaction and process memory, even after Worker
termination. Whole-machine teardown retires all waits; per-process teardown
retires only the selected PID's waits.

Boot image composition loads an image once and reads metadata and capacity from
that same verified writer before applying runtime patches. Separate full-image
readers create several Wasm heaps that coexist until garbage collection, which
is especially costly for the WordPress image on iOS. Composition still runs in
a disposable Worker and returns transferable bytes.

`maxProcessMemoryBytes` is a sampled allocation-admission budget, not a hard
aggregate growth cap: direct `WebAssembly.Memory.grow()` has no JavaScript
callback, so the next process allocation is where the allocator observes and
rejects an over-budget live set. A short retirement threshold similarly pauses
new churn after it is crossed, but an already-grown generation or simultaneous
exits can exceed it. JavaScript cannot hard-bound native backing that the
browser engine has not reclaimed. Garbage-collection observations and bounded,
coalesced ordinary-allocation pressure are diagnostic/reclamation aids only.

### JavaScriptCore garbage collection and blocked workers

This is a suspected JavaScriptCore behavior with a tagged workaround in
the syscall glue, recorded in the runtime workaround registry as
[`JSC-BLOCKED-WAIT-GC-STARVATION`](../tests/runtime-workarounds/JSC-BLOCKED-WAIT-GC-STARVATION/entry.md)
(evidence, self-judging attempts, draft report). It is not yet a confirmed
WebKit defect: the standalone page below shows helper-thread pinning only
through a manual stack sample, so the cause is a hypothesis that fits every
measurement. It would apply to JavaScriptCore everywhere: Safari on every
device, and Bun. The machine hang and the effect of the workaround are
measured and do not depend on the hypothesis.

A Kandelo process makes each syscall by writing its channel and waiting in
`memory.atomic.wait32` until the kernel answers. The wait stays inside Wasm,
so the worker does not return to JavaScript or its event loop while it
waits. The suspected mechanism is that JavaScriptCore does not release a
worker's heap access during that wait (reading
`WaiterListManager::waitSyncImpl` suggests a `VMBlockingScope`, not a
heap-access release). A garbage collection that began in the worker's VM
before it blocked, for example because `memory.grow` reported more memory,
needs that worker to stop. Under this hypothesis JavaScriptCore hands the
collection back to the blocked thread, so it finishes only when that thread
runs JavaScript that reaches an allocation slow path.

Until then, under this hypothesis, the collection keeps every shared GC
helper thread that joined it. JavaScriptCore has one small pool of helpers
(six on the tested Mac) for all the page's workers, and helpers choose a
collecting heap at random. A machine with a few idle processes (a shell at
its prompt, a database waiting for a client, PHP-FPM waiting for requests)
would soon pin all of them. Other workers' concurrent collections would
then depend on helpers that never return, which matches what was observed:

- an exiting process worker cannot finish destroying its VM
  (`~VM` → `Heap::lastChanceToFinalize`), so its `WebAssembly.Memory` and
  the reservation it charges (see [Memory per process](#memory-per-process))
  are never released;
- the kernel worker's own collection stalls. When retired reservations have
  filled the pool, creating the next process's memory runs a synchronous
  collection in the kernel worker, which never returns, and every process
  waiting for a syscall answer waits forever.

On the WordPress + MariaDB machine in Playwright's WebKit this hung the
machine within the first few terminal commands (4 of 4 runs stopped after
the first). Stack samples showed all six helpers in
`SlotVisitor::drainFromShared`, six collector threads in
`drainInParallelPassively`, four exiting workers in
`lastChanceToFinalize`, and the kernel in `Heap::waitForCollection`. With
JavaScriptCore's helper threads disabled (`JSC_numberOfGCMarkers=1`), the
same 20-command run passed twice. Web content cannot change that option.
With the workaround below, every run that booted completed all 20
commands (5 of 5; a sixth crashed during boot from the separate
[TextDecoder crash](#webkit-page-process-crash-while-creating-textdecoders)
before its mitigation), and the WebKit cases of
`apps/browser-demos/test/php-web-image-cli.spec.ts` passed 9 of 9.

**Workaround.** On JavaScriptCore each syscall wait is bounded at 100 ms.
After a timeout the glue calls the host import `kernel.kernel_heap_safepoint`
(ABI 52), which allocates a small `ArrayBuffer` and keeps waiting on the same
request. Under this hypothesis the allocation gives the VM an allocation
slow path at which it finishes the handed-off collection and releases its
helpers, so a blocked process is expected to hold a collection for at most
one interval instead of indefinitely. The kernel's answer, and the
syscall's blocking and errno semantics, are unchanged; the timeout is not
visible to the program. V8 and SpiderMonkey are not known to need
safepoints, so on Chromium, Firefox, and Node the host answers the first
timeout with an unbounded wait and the process waits exactly as before. The
host import lives in `host/src/heap-safepoint.ts`; the bounded wait is in
`libc/glue/channel_syscall.c`.

The cost on JavaScriptCore is one wakeup per blocked thread per 100 ms. A
standalone reproduction (24 workers that start a collection and then block)
left all six helpers pinned and seven to eleven collections unfinished; with
safepoints it left none, and waking up without allocating did not help.
This entry stays suspected, for two reasons the measurements do not remove.
The standalone page's helper pinning is read from a manual stack sample, not
reported by the page itself, and a reproduction that needs a manual
observation does not judge itself. It becomes a confirmed WebKit defect only
when a standalone page reports the hang or the pinned helpers on its own,
without a person reading a sample, and the same page passes with the
workaround's allocation. Remove the workaround when JavaScriptCore releases
heap access while a thread is blocked in a synchronous atomic wait, or stops
handing a collection to such a thread.

### WebKit page-process crash while creating TextDecoders

This is a suspected WebKit problem with a tagged mitigation in the host
runtime, recorded in the runtime workaround registry as
[`WEBKIT-TEXTDECODER-WRAPPER-CRASH`](../tests/runtime-workarounds/WEBKIT-TEXTDECODER-WRAPPER-CRASH/entry.md). It is not a confirmed WebKit
bug: there is no standalone reduction, so the cause is a hypothesis that fits
the crash reports and the effect of the mitigation. The WebKit page process
could crash with `SIGSEGV` in
`HashMap<void*, Weak<JSObject>>::add`, called from
`cacheWrapper<TextDecoder>` while JavaScript constructed a `TextDecoder`.
The faulting addresses were data-like (for example `0x0403020100000008`),
so a table WebKit uses to track the worker's DOM wrappers appears to have
been corrupted. JavaScript cannot corrupt WebKit's native heap. In 24 of 25
crash reports the faulting thread was the newest worker, handling its first
message in interpreted code, which is a Kandelo process starting; in the
other it was the kernel worker.

The trigger was the burst of wrappers a process start created. The host
parsed each program's export and import names with a new `TextDecoder` per
name, in the kernel and again in the new process worker, and a PHP binary
exports about 22,000 names. In Playwright's WebKit, booting the
WordPress + MariaDB machine crashed in 5 of 32 runs, 8 of 32 without the
disposable memory-allocation workers, and 8 of 32 with JavaScriptCore's
concurrent collector off, so the crash is not the
[garbage-collection deadlock](#javascriptcore-garbage-collection-and-blocked-workers)
above. It also occurred before the PHP 8.5 upgrade. With one shared decoder
for those names, 32 of 32 boots succeeded. A standalone page that starts
nested workers which each construct 25,000 decoders did not crash, so the
reduction to a WebKit test case is incomplete. The entry becomes a confirmed
WebKit defect only when a standalone page reproduces the crash by itself and
judges its own outcome.

**Mitigation.** Wasm name parsing (`host/src/constants.ts`) and the
thread-patching export scans (`host/src/worker-main.ts`) share one
`TextDecoder`; `decode()` without `stream` keeps no state between calls.
Other host code still constructs decoders per call. A recurrence elsewhere
would be evidence for the hypothesis and a reason to build the standalone
reduction, not a reason to avoid `TextDecoder` as a rule.

### Compiler engine limits

The base shell lazily loads its C/C++ SDK on first use. Compiler acceptance
passes the full sequential C/C++ cases on Node and Chromium, and its C
cases and a small C++ program on the bundled WebKit engine. Firefox passes
the libc++ containers/entropy case using `<random>` in a fresh shell, but
repeated LLVM launches can exhaust its [executable-code arena](#firefox-executable-code-limit).
The engine warns `failed to allocate executable memory for module`, and
the shell reports an I/O error before Clang starts. The compiler browser
test checks that exact boundary and tests fresh-session C++ separately;
large-module sharing/reclamation remains follow-up work.

That template-heavy case fails during compilation on the tested WebKit
engine: Clang's recursive template instantiation exhausts the engine's
native Wasm call stack. The worker reports `Maximum call stack size
exceeded` inside `clang::Sema`; the compile job (`clang -cc1`) dies with
SIGSEGV, and the clang driver reports it and exits 1.
This is separate from the C stack stored in Wasm linear memory. Raising
the compiled program's linker stack size does not enlarge the running
compiler's engine stack. The compiler browser test checks this exact
diagnostic and exit status as a known boundary; it does not treat the
failed compilation as success. See [in-guest compilation](sdk-guide.md#compile-inside-the-base-shell).

### Text-mode web browsing (ELinks) in the browser

The shell image ships ELinks, a text-mode web browser, built with the
QuickJS-NG JavaScript engine. `elinks <url>` browses interactively and
`elinks -dump <url>` prints a page as text. The image's
`/etc/elinks/elinks.conf` turns page JavaScript on (upstream ships it off) and
selects 24-bit color; both are ordinary ELinks options a user can change.

On the Node.js host ELinks uses real TCP sockets. In the browser its requests
cross the same boundary as every other guest HTTP client (the CORS proxy
profile is described under [Kandelo session UI](#kandelo-session-ui)): the
kernel terminates the guest's TLS locally and re-issues the request with
`fetch()` through the CORS proxy. Plain page loads work that way — fetching
`example.com`, Hacker News, a Wikipedia article, DuckDuckGo's HTML search
results, and CNN's lite site were each checked in Chromium. The boundary does
change what a browser-hosted ELinks can do:

- **No cookies, so no logins.** The Fetch API never exposes `Set-Cookie`
  response headers to script, so they cannot be relayed to the guest and
  ELinks never learns a site's cookies. Sites that need a session (logins,
  carts, consent walls that set a cookie) do not work. This is a browser
  limit, not an ELinks setting: ELinks's own cookie support is compiled in and
  works on Node.js. A request that does carry a `Cookie` header is refused
  before dispatch rather than sent without it, as described above.
- **Sites see the real browser's `User-Agent`.** `User-Agent`,
  `Accept-Language`, and `Referer` are set by the browser on every `fetch()`;
  ELinks's values never reach the site. A site that serves simplified HTML to
  text browsers by sniffing the user agent will serve its full page instead.
- **HTTP and HTTPS only.** ELinks is built with Gopher, Gemini, finger, and
  FTP support, but those need raw TCP, which a browser cannot open. They have
  not been tested on Node.js either.
- **Form submission is untested.** A `POST` crosses the proxy only with the
  request headers the proxy profile allows; ELinks's form posts have not been
  checked against it.

The ELinks build itself leaves out features whose libraries Kandelo does not
package: translations (the interface is English), regular-expression search,
international domain names, XBEL bookmark import/export, and brotli or zstd
content decoding. `elinks -version` lists what is compiled in.

### SDL rendering needs GL, which only the browser host provides

SDL2 on Kandelo presents video through its KMSDRM backend with the OpenGL ES 2
renderer, which the browser host bridges to WebGL on the `/dev/dri/card0`
scanout. The Node host has no GL context (`host_gl_query` returns -1), and SDL2's
KMSDRM backend implements no window framebuffer, so SDL's software renderer
cannot present there either. A program that creates an SDL renderer therefore
shows video only in the browser. On Node, `ffplay` reports
`Failed to create window or renderer: Couldn't find matching render driver` and
exits as upstream does (status 0); `ffplay -nodisp` still plays audio through
SDL's OSS backend to `/dev/dsp`, and FFmpeg's own `fbdev` and `oss` outputs work
on both hosts.

Why not a Node software path: it would need either a GL implementation on the
Node host or a KMSDRM window framebuffer in SDL, and SDL's KMSDRM backend has no
framebuffer path upstream. Residual risk: an SDL program that falls back from a
failed renderer differently from ffplay may behave differently on Node than in
the browser.

### npm registry access in the browser

The Node demo uses npm's canonical `https://registry.npmjs.org/` registry.
Registry metadata and tarballs traverse the ordinary browser TLS and configured
proxy boundary. Kandelo does not rewrite registry URLs, package metadata, or
tarball locations and has no npm- or package-specific proxy routing.
