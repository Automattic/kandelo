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

- **Kernel in dedicated worker**: Enables `Atomics.waitAsync` without V8 microtask chain freeze bug (main-thread-only). No need for MessageChannel-based polling. Zero UI jank regardless of syscall load.
- **Kernel-owned VFS** (preferred path, `kernelOwnedFs: true` + `kernel.boot()`): the kernel worker restores a pre-built VFS image and exec()s `argv[0]` as the first process. The main thread never instantiates a `MemoryFileSystem` and is not in the FS hot path. Service-supervised demos run dinit (PID 1) inside this image; single-program demos exec the language interpreter directly.
- **Legacy shared VFS** (`memfs:` constructor option + `kernel.spawn()`): main thread holds a `MemoryFileSystem` and shares the SAB with the kernel worker. Used by demos that fetch transient binaries at runtime (test runners, REPLs that load arbitrary user code, benchmark suites). Kept in place until the kernel grows a "spawn-into-running-kernel" path that doesn't need a main-thread pid.
- **Exec reads from filesystem**: Like a real OS, `exec()` reads binaries from the kernel-side `MemoryFileSystem`. Programs are baked into the VFS image at build time (or written by the page in the legacy path before spawning). Symlinks are used for multicall binaries (e.g., coreutils).
- **dinit (PID 1) for service supervision**: Multi-process demos (nginx, redis, mariadb, nginx-php, wordpress, lamp, mariadb-test) bake `/sbin/dinit` and per-service files under `/etc/dinit.d/` into the VFS image via `addDinitInit()` (`images/vfs/scripts/dinit-image-helpers.ts`). dinit handles SIGCHLD reaping, `depends-on` ordering, and bootstrap-then-daemon chains. Page code waits for service-ready via `onListenTcp` (port-bind) callbacks, then starts driving the demo over kernel-loopback TCP or the HTTP bridge.
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
- `fork()` via `wasm-fork-instrument` snapshot/restore — child runs in new sub-worker with copied memory
- `exec()` reads program binary from the shared filesystem, replaces process
- `posix_spawn()` — fork+exec with file actions (addchdir, addfchdir, addclose, adddup2)
- Process groups, wait/waitpid, cross-process signals, pipes

### Threads
- `clone()` with `CLONE_VM|CLONE_THREAD` — shared Memory between parent and thread Workers
- Used by MariaDB (5 threads), Redis (3 background threads)

### Networking
- POSIX AF_INET TCP and UDP inside the kernel, including local loopback and virtual machine-to-machine networking
- `LocalVirtualNetwork` attaches multiple browser Kandelo machines to virtual IPv4 addresses in one browser session
- GNU Netcat (`nc`) and `curl` run against those virtual sockets in the network lab at `/pages/network/`
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
- Single-owner device. Owner is released on close-of-last-fd / `execve` / `exit`; the ring is flushed at the same time so a successor open starts from silence. Format must be `AFMT_S16_LE`; other formats are `EINVAL`.
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
| doom | fbDOOM | legacy spawn | `/dev/fb0` framebuffer + canvas renderer + keyboard via stdin + mouse via `/dev/input/mice` (pointer-locked) + SFX **and** OPL2-synthesized music via `/dev/dsp` → AudioContext. The shareware `doom1.wad` is **fetched at page load** from a Linux-distro mirror (SHA-256 verified, Cache API cached); no IWAD ships in the package archive. |
| sdl2 | SDL2 GLSL playground | legacy spawn | Split-pane shader live-coding playground on a 1920×1080 `/dev/dri/card0` KMS surface (GLES2). Left pane is a gap-buffer code editor (syntax highlighting, selection, undo/redo, clipboard, vertical column memory); right pane renders the fragment shader live, auto-recompiling 250 ms after the last keystroke. F1 edits the **image** shader; F2 edits a **sound** shader whose PCM is synthesized to the host AudioContext (48 kHz stereo) and exposed back to the image shader as an `iAudio` FFT texture. Ctrl+S persists the buffer under `/home/shaders/`, Ctrl+L cycles bundled presets, F5 reloads, ESC quits. Keyboard arrives via evdev (`BrowserInputSource`); no mouse (wheel scrolls the editor). |
| modeset | modeset.c | `kernel.boot` + spawn | Minimal KMS client: opens `/dev/dri/card0`, becomes DRM master, allocates dumb buffers, draws an animated gradient, and commits real `drmModePageFlip` ioctls. The Modeset pane bridges the CRTC to an OffscreenCanvas and shows a live PAGE_FLIP counter chip. |
| wayland | wlcompositor + wlclock + wlpaint + wlterm | `kernel.boot` + spawn | Full Wayland desktop — see [Wayland desktop demo](#wayland-desktop-demo) below. |

The "Boot pattern" column reflects how the demo enters the kernel:
- **`kernel.boot`** — `kernelOwnedFs: true`, exec the language interpreter as the first process.
- **dinit** — `kernelOwnedFs: true`, exec dinit (PID 1), which brings up the per-demo service tree.
- **dinit + spawn** — dinit boots the supervised services; the page spawns transient binaries (e.g. mysqltest) via `kernel.spawn()`.
- **`kernel.boot` + spawn** — the machine boots to a shell; the page stages the demo binaries into the VFS and spawns them via `kernel.spawn()` / `runShellCommand`.
- **legacy spawn** — main thread restores a `MemoryFileSystem`, page calls `kernel.spawn(programBytes, argv)` for each binary.

### Wayland desktop demo

`/?demo=wayland` boots a four-program Wayland desktop:

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
- **wlterm** — a libkwl VT100 terminal running a forkpty'd `dash`.

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
(`markKmsCanvasGlReleased`) so the desktop keeps painting. A
main-thread ResizeObserver reports the pane's device-pixel size so the
presenter renders at display resolution instead of letting the page
compositor rescale an fb-sized bitmap; any letterbox is drawn in GL
with the same contain math the pane's pointer mapping uses.

The desktop itself also fills the pane: the boot flow feeds the pane's
size to the kernel before spawning the compositor, and
`host_kms_mode_info` advertises a preferred mode matching the pane's
aspect ratio (`round(1080 × aspect) × 1080`, width clamped
[1440, 3840]; 1920×1080 fallback when no size is known). wlcompositor
sizes its scanout from that mode and its placement rules are
edge-anchored (wlterm left, wlclock/wlpaint offsets from the right
edge), so wider panes spread the demo across the full width with no
black bars. The mode is fixed at boot — resizing the browser window
afterwards letterboxes rather than re-modes.

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

Run the browser app: `cd apps/browser-demos && npm run dev`, then open
`http://127.0.0.1:5401/`.

Cross-origin browser fetches are routed through `public/service-worker.js`,
which defaults to `https://wordpress-playground-cors-proxy.net/?`. Override it
with `VITE_CORS_PROXY_URL` when testing another proxy:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

Proxy prefixes ending in a bare `?` receive raw target URLs; `?url=`-style
prefixes receive percent-encoded targets.

## VFS Images

Browser demos use pre-built **VFS images** — binary snapshots of a `MemoryFileSystem` containing all runtime files, directory structure, configs, and symlinks needed by a demo. At runtime, restoring a VFS image is a single buffer copy, replacing what would otherwise be hundreds or thousands of individual file creation operations.

### How it works

1. **Build time**: A TypeScript build script creates a `MemoryFileSystem`, writes files/dirs/symlinks into it, and calls `saveImage()` to produce a zstd-compressed `.vfs.zst` file. Empty regions of the SharedFS allocator compress to nearly nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1–3 MB download. If the image should grow or report a larger `df` capacity at runtime, build it with `MemoryFileSystem.create(sab, permittedMaxBytes)` so the filesystem metadata is sized for that capacity.
2. **Runtime**: The demo page fetches the `.vfs.zst` file, calls `MemoryFileSystem.fromImage(imageBytes, { maxByteLength })` (which auto-detects zstd magic and decompresses transparently), and passes the resulting filesystem to `BrowserKernel({ memfs })`. `maxByteLength` makes the restored `SharedArrayBuffer` growable; it does not raise the filesystem maximum beyond the image's superblock limit.

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
| Python | `python.vfs.zst` | `bash images/vfs/scripts/build-python-vfs-image.sh` | CPython stdlib |
| Erlang | `erlang.vfs.zst` | `bash images/vfs/scripts/build-erlang-vfs-image.sh` | OTP runtime |
| Perl | `perl.vfs.zst` | `bash images/vfs/scripts/build-perl-vfs-image.sh` | Perl stdlib |
| Shell | `shell.vfs.zst` | `bash images/vfs/scripts/build-shell-vfs-image.sh` | dash, symlinks, vim runtime |
| Node | `node-vfs.vfs.zst` | `bash images/vfs/scripts/build-node-vfs-image.sh` | npm 10.9.2 dist + writable `/work` |
| WordPress | `wordpress.vfs.zst` | `bash images/vfs/scripts/build-wp-vfs-image.sh` | WP files, nginx/PHP configs |
| LAMP | `lamp.vfs.zst` | `bash images/vfs/scripts/build-lamp-vfs-image.sh` | MariaDB + WP + configs |
| MariaDB test | `mariadb-test.vfs.zst` | `bash images/vfs/scripts/build-mariadb-test-vfs-image.sh` | MariaDB + test suite |

VFS images are `.gitignore`d and must be built locally. The `run.sh` script handles this automatically (e.g., `./run.sh browser` builds any missing VFS images before starting the dev server).

### Building VFS images

Each build script requires the corresponding software to be compiled first (e.g., `build-cpython.sh` before `build-python-vfs-image.sh`). The `run.sh` script orchestrates this:

```bash
./run.sh build python-vfs    # Build Python VFS image
./run.sh build shell-vfs     # Build Shell VFS image
./run.sh build all            # Build everything including all VFS images
```

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

## Known Limitations

### SharedArrayBuffer restrictions
Chrome rejects SharedArrayBuffer-backed views in `TextDecoder.decode()` and `crypto.getRandomValues()`. Always copy to a temporary non-shared buffer first.

### No external raw sockets
Browser sandboxing prevents Kandelo from listening on real network ports or opening raw TCP/UDP sockets to arbitrary external peers. Local loopback sockets and `LocalVirtualNetwork` listeners are virtual sockets inside the browser session, so Kandelo machines can still communicate with each other using POSIX UDP/TCP. Browser-facing HTTP server demos use a service worker to intercept HTTP requests and inject them as kernel TCP connections via the connection pump.

### Memory per process
Each process gets `WebAssembly.Memory(shared: true, initial: layout.initialPages, max: maxPages)`. The initial size covers the program's imported minimum memory, a brk window, and the low syscall control channel; it no longer allocates `maxPages` at spawn. `maxMemoryPages` still caps guest brk/mmap growth and should be tuned for workloads that need large address spaces.

### npm registry access in the browser
The node demo's `npm install` uses `--registry=http://proxy.local/` so registry traffic can pass through the host fetch bridge instead of requiring the JavaScript runtime to own every TLS edge case. The kernel resolves `proxy.local` via `host_getaddrinfo` (it is deliberately absent from the synthetic `/etc/hosts`), and the host-side TLS backend re-routes those requests through the existing cors-proxy (dev) or service worker (prod) onto `https://registry.npmjs.org/`. Tarball URLs in JSON responses are rewritten to the same alias so subsequent fetches stay on the same path.
