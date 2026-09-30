# Direct Rendering Infrastructure (DRI) — Design

Date: 2026-05-18
Branch: `emdash/explore-direct-rendering-infrastructure-9vbaz`
Worktree: `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz`

## §1. Goals & non-goals

**Goal.** Make the wasm-posix-kernel a credible Linux-like host for the
*whole* userland that real desktops grow on top of GL: a process can
`open("/dev/dri/card0")` to talk to a mode-setting device, allocate
shareable pixel buffers via a GBM-shaped surface, hand those buffers to
the compositor without copying, and have the compositor present them on
a host `<canvas>` / OffscreenCanvas. A second process can
`open("/dev/dri/renderD128")` to get its own GL context against the
*same* backend without the two contexts trampling each other. Keyboard
and mouse arrive through `/dev/input/event*` with an `evdev` ioctl
surface wide enough for `libinput` / SDL2 to probe. Audio sits behind
`/dev/snd/*` with the shape `ALSA` / `SDL` expect (the first cut is a
silent dummy backend; the surface is what counts). A minimal seat
(focus + clipboard) and a custom-protocol compositor — *not Wayland
yet* — light up a panel, desktop, popup menus and the first
ported-app demos (file manager + SDL2 demo window). WebGPU lands later
as a *second* GPU device alongside `renderD128`; a Wayland compat
layer is named and deferred.

This design is the **architectural roof** the next eight to twelve
plans will fit under. The doc that follows it
(`2026-05-18-dri-buffer-sharing-plan.md` and onward) implements the
roof one ridge beam at a time.

**Non-goals (this design / v1).**

- **A second renderer.** WebGL 2 (via the `/dev/dri/renderD128` v1
  surface, see §2) stays the only GL backend. WebGPU is a second
  device file (`/dev/dri/card1` or `renderD129`), planned for after
  the core DRI surface is solid. No translation layer in v1.
- **Wayland wire-compatibility.** We expose Linux-shaped device files
  and a *custom*, in-process compositor protocol. Wayland-protocol
  apps need an out-of-process display server, a unix-socket wire
  format, libwayland-client linkage, and a stack we have not built.
  Deferred to the post-v1 "Wayland compat layer" milestone.
- **X11.** Not planned. Anything assuming `DISPLAY=:0` is unsupported.
- **Multi-monitor / hot-plug.** One CRTC, one connector, one mode,
  the size of the bound `<canvas>`. `drmModeGetResources` reports
  exactly one of each. Hot-plug uevents are stubbed.
- **Hardware cursor planes / overlay planes.** Single primary plane
  per CRTC. Cursor is a compositor-software sprite.
- **GBM-on-anything-but-the-render-node.** v1 ties the GBM device to
  the same fd as `renderD128`; an independent GBM-on-`/dev/udmabuf`
  surface is out of scope.
- **Full evdev coverage.** Keyboard (KEY_*) + mouse (REL_X/Y, BTN_*)
  + scroll wheel. No tablets, no joysticks, no force-feedback, no
  multi-touch (`ABS_MT_*`) in v1.
- **ALSA control plane.** `/dev/snd/controlC0` returns minimal
  fixed responses; no full mixer surface. PCM playback only
  (`pcmC0D0p`); no capture (`pcmC0D0c`).
- **Real audio in v1.** Dummy backend that swallows samples and
  fires the period-elapsed callback on time. Surface is correct;
  bytes go to `/dev/null`. WebAudio backend is its own milestone.
- **Browser DOM compositor.** The "compositor" is a wasm program
  the kernel boots as PID 1's child; it draws into a framebuffer
  the kernel presents via the existing fbdev path (so we reuse
  fbdev's RAF pump). It does **not** assemble HTML elements.
- **POSIX guarantees on DRM / evdev / ALSA ioctls.** None of these
  device subsystems are POSIX; they are *Linux uAPI*. The bar is
  "matches Linux closely enough that unmodified libdrm / libinput /
  alsa-lib / SDL2 can probe + drive them" (the broader Unix-like
  bar from the user's brief). Where Linux semantics fight with our
  single-process / single-canvas reality (e.g. master/lease, render
  vs primary node distinction) we cite the Linux behaviour, then
  document the WPK simplification in the same paragraph.
- **Security model.** No DRM auth tokens, no `DRM_IOCTL_AUTH_MAGIC`,
  no render-node ACLs beyond the existing process-table credentials.
  All processes on the kernel are equally trusted (consistent with
  the rest of the project).

**Constraint, from CLAUDE.md.** "Never compromise hosted software."
`libdrm`, `libgbm`, `libinput`, `alsa-lib`, `SDL2` get vendored as
upstream sources. If they call an ioctl we don't route, we route it.
If they need a header, the header is Khronos / kernel-uapi / alsa-lib
vendored byte-for-byte under `musl-overlay/include/`. No
behaviour-altering patches; only cross-compilation hygiene (the same
shape as the `wsi/wpk.c` backend added for `eglut` in the GL plan).

**Constraint, from the user's brief.** Two PRs of a host change must
land in the same commit — Node and Browser parity is load-bearing.
Every host-side feature in this design names both runtimes in its
`§ host components` paragraph; an implementation that wires Node-only
or Browser-only is *not* the design.

**Success criteria.** The design succeeds when its implementation
yields, in order, all five of the validation milestones in §10. The
load-bearing milestone is **(D) SDL2 spinning-cube window**: an
unmodified upstream SDL2 + GLES2 program runs in the browser, the
compositor decorates its window, keyboard + mouse work via evdev,
audio plays (silently) without underrun warnings, and the buffer the
SDL2 program drew into reaches the canvas without an intermediate
`glReadPixels` copy. If that demo runs, the rest of the userland
flows.

## §2. Where v1 ends and v2 begins

This design **strictly builds on** the GL v1 surface landed in PRs
[#33](https://github.com/mho22/wasm-posix-kernel/pull/33),
[#36](https://github.com/mho22/wasm-posix-kernel/pull/36) and
[#38](https://github.com/mho22/wasm-posix-kernel/pull/38) — see
`docs/plans/2026-04-28-webgl-gles2-{design,plan}.md` for the full
write-up. A short summary so this doc reads stand-alone:

| v1 (landed in the explore-webgl chain) | v2 (this design) |
|---|---|
| `/dev/dri/renderD128` only — *render* node | adds `/dev/dri/card0` — *primary* (mode-setting) node |
| 1 GL context per process, 1 process holding the device | N processes share the device; multiplexer (§5) sequences submits |
| Per-process 1 MiB TLV cmdbuf, mmap'd from the device fd | unchanged; cmdbuf is now per-`(pid, ctx_id)` |
| `WPK_SURFACE_PBUFFER` + `WPK_SURFACE_DEFAULT` (the bound canvas) | adds `WPK_SURFACE_GBM` — surface backed by a GBM buffer object (§4) |
| No buffer sharing, no DMA-BUF, no EGLImage | introduces GBM bo handles, prime fds, `EGL_KHR_image_base` + `EGL_EXT_image_dma_buf_import` (§4) |
| `GL_DEVICE_OWNER: AtomicI32` enforces single-open | dropped; replaced by the multiplexer's per-context ownership (§5) |
| `eglSwapBuffers` ≡ `ioctl(GLIO_PRESENT)` (no-op) | unchanged for `WPK_SURFACE_DEFAULT`; for `WPK_SURFACE_GBM` it returns a GBM bo handle to the compositor |
| Cube demo `programs/cube.c` two-process via fork+pipe | unchanged; survives the multiplexer (the second process is what motivated it) |

The v1 cmdbuf, EGL stubs, libGLESv2 stubs, `host_gl_*` host imports,
and `OffscreenCanvas`-in-the-kernel-worker bridge are all reused
verbatim. **No v1 ioctl numbers, op tables, or struct layouts change
in v2 — additions only.** `OP_VERSION` may bump; `ABI_VERSION` bumps
only where v2 introduces a new `repr(C)` struct or changes the
channel layout (see §11).

The v1 chain's PRs (#1, #3, #33, #36, #38) are still **open** in the
mho22 fork as of 2026-05-18; the merge gate is the gldemo working
end-to-end in the maintainer's browser. **This v2 design assumes the
v1 chain lands as-is**, and the v2 implementation branches off
v1's tip (`explore-webgl-exposition-demo`, base of PR #38). If the
maintainer requests v1 changes during review, this design adapts; no
v2 implementation work starts before v1 lands.

## §3. Architecture — the whole DRI stack

The Linux DRI stack splits responsibility three ways:

1. **DRM kernel driver** owns the GPU, allocates buffers (GBM), sets
   modes (KMS).
2. **DRI client** (`libdrm` + `libgbm` + a GL implementation) talks
   to the driver via `/dev/dri/*` ioctls; gets back framebuffer
   handles, GL contexts.
3. **Display server / compositor** (`Xorg` / `weston` /
   `kwin_wayland`) owns the screen, composes client buffers into the
   primary framebuffer via the same KMS API.

We mirror the split end-to-end, with one consolidation: the "GPU" is
the host browser's `WebGL2RenderingContext`, the "DRM kernel driver"
is our Rust kernel, and the "display server" is a wasm process the
kernel boots at startup.

```
   ┌─ SDL2 app (wasm32) ───────────────────────────────┐
   │  SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO)        │
   │  SDL_CreateWindow(...) ──────────────────────┐    │
   │  SDL_GL_CreateContext(...) ─────────────────┐│    │
   │  audio = SDL_OpenAudioDevice(NULL, 0, ...) ─┤│    │
   │  input = libinput_path_add_device(li, ...)──┤│    │
   │                                             │┘    │
   │  draw into a GBM-backed pbuffer  (frames/s) │     │
   │  eglSwapBuffers ──────────────┐             │     │
   └────────┬──────────────────────┼─────────────┼─────┘
            │                      │             │
            │ /dev/dri/renderD128  │ /dev/snd/   │ /dev/input/
            │ /dev/dri/card0       │ pcmC0D0p    │ event0,event1
            │                      │             │
   ┌────────▼──────────────────────▼─────────────▼─────┐
   │ kernel (wasm64):                                  │
   │   devfs: card0, renderD128, event0/event1,        │
   │          pcmC0D0p, controlC0, snd/seq, snd/timer  │
   │   DRI:  GbmBoTable, FenceTable, FbHandleTable     │
   │   GL:   GlContextRegistry (multiplexer, §5)       │
   │   evdev: ring buffer per fd + EVIOCG* ioctls      │
   │   ALSA: per-pcm ring + status mmap + interrupt    │
   │         scheduling (timer-driven dummy backend)   │
   └────────┬──────────────────────┬─────────────┬─────┘
            │ host_gl_*            │ host_audio_*│ host_input_*
            │ host_gbm_*           │             │
            │ host_kms_*           │             │
   ┌────────▼──────────────────────▼─────────────▼─────┐
   │ host (TypeScript, kernel worker):                 │
   │   GlContextRegistry + GBM buffer pool             │
   │     bo_id → { width, height, format,              │
   │               backing: WebGLTexture | OffscreenCanvas
   │               | Uint8Array (CPU) }                │
   │   KmsState: { mode, primary_fb_id, vblank_phase } │
   │   AudioBackend: dummy (period timer in kernel     │
   │     worker) | WebAudio (main thread, post-v1)     │
   │   InputBackend: pointer/key listeners on the      │
   │     compositor canvas → evdev ring writes         │
   └────────┬──────────────────────────────────────────┘
            │
   ┌────────▼──────────────────────────────────────────┐
   │ wpkcompositor (wasm32, kernel boots at PID 2):    │
   │   - reads input via libinput on /dev/input/event* │
   │   - owns /dev/dri/card0 as DRM master             │
   │   - manages client surfaces via custom protocol   │
   │     (Unix-socket-shaped pipe in /run/wpk/comp)    │
   │   - draws panel, desktop background, window       │
   │     decorations using a small in-tree draw lib    │
   │   - composes via GLES2 (renderD128) and presents  │
   │     the result by setting a GBM bo as the primary │
   │     fb on the CRTC                                │
   └───────────────────────────────────────────────────┘
```

Four data planes, each with their own design section:

1. **Buffer plane** (§4) — GBM bos and the dma-buf-shaped handles
   that pass between processes. The cmdbuf carries no pixels;
   pixels live in bos.
2. **Render plane** (§5) — GL contexts, sequenced through the
   multiplexer onto the single host `WebGL2RenderingContext`. The
   render plane writes to bos.
3. **Display plane** (§6) — KMS, owned by the compositor. The
   display plane reads bos and presents them on the bound canvas.
4. **HID plane** (§7) — evdev and the seat. Drives the compositor's
   focus + clipboard + cursor.

A fifth plane (audio, §8) is independent of the rendering chain; it
shares the worker-callback machinery with the visual planes but the
data path is wholly separate.

## §4. Buffer allocation & sharing model — the GBM/dma-buf analog

This is the design's centre. Every other section depends on the
answer to: *what is a "buffer"?*

### §4.1 The model in one paragraph

A **buffer object** (`bo`) is the unit of pixel storage. A bo is
created by the *render-node* fd via the GBM ioctl surface; it has a
width, height, drm-fourcc format, modifier, stride, and an
opaque-to-clients **bo handle** (`u32`). The same fd can mmap the bo
into the process's address space (CPU access). To pass the bo to
*another* process, the owner calls `DRM_IOCTL_PRIME_HANDLE_TO_FD`,
gets a **prime fd** back, sends it over a unix-socket-shaped pipe
(`SCM_RIGHTS` is the Linux mechanism — see §4.6 for our equivalent),
and the receiver imports it with `DRM_IOCTL_PRIME_FD_TO_HANDLE` to
get a *local* bo handle. The bo's backing memory is shared; both
processes see the same pixels. The compositor receives prime fds from
clients, imports them, and uses
`DRM_IOCTL_MODE_ADDFB2 (PRIME-imported bo) → fb_id` plus
`DRM_IOCTL_MODE_PAGE_FLIP` to put the client's pixels on screen.
GL surface objects created with `WPK_SURFACE_GBM` *render directly
into the bo's backing* via `EGL_EXT_image_dma_buf_import` — no
`glReadPixels` involved.

### §4.2 What a bo *is* in our world

bos exist on **three tiers**, transparent to clients:

| Tier | When chosen | Backing | Cross-process? |
|---|---|---|---|
| **GPU** | `format ∈ {ARGB8888, XRGB8888, RGB565}` AND `modifier ∈ {LINEAR}` AND `use & SCANOUT` AND OffscreenCanvas available AND host runs WebGL2 | `WebGLTexture` attached to an `OffscreenCanvas` owned by the kernel worker | Yes — texture stays in the kernel worker; importer gets a *handle* to the same `WebGLTexture` |
| **CPU shared** | `use & LINEAR` OR cmdbuf-mappable required OR no GPU tier available | `SharedArrayBuffer` slice in a kernel-owned pool | Yes — same SAB region mapped into N process Memorys (kernel-side `MAP_SHARED`, see §4.3) |
| **CPU private** | Internal scratch (e.g. compositor's font atlas during text rasterizer init) | `Uint8Array` in the kernel worker; never exported | No — `DRM_IOCTL_PRIME_HANDLE_TO_FD` returns `EINVAL` |

The bo header in the kernel:

```rust
// crates/kernel/src/dri/bo.rs
pub struct GbmBo {
    pub id: BoId,           // global u32, allocated from monotonic counter
    pub width: u32,
    pub height: u32,
    pub format: u32,        // drm_fourcc (DRM_FORMAT_ARGB8888, ...)
    pub modifier: u64,      // DRM_FORMAT_MOD_LINEAR for v1; INVALID rejected
    pub stride: u32,        // host-decided; reported back via GBM_BO_GET_STRIDE
    pub size: u64,          // stride * height for LINEAR
    pub usage: u32,         // GBM_BO_USE_SCANOUT | RENDERING | LINEAR | ...
    pub tier: BoTier,       // Gpu | CpuShared | CpuPrivate
    pub created_by: Pid,
    pub refcount: u32,      // owner + each prime-import bumps; close decrements
    pub prime_handle: Option<PrimeHandle>,   // kernel-side cookie; see §4.6
    pub kms_fb_id: Option<FbId>,             // if used as a KMS framebuffer
}
```

The host-side mirror tracks the actual backing:

```ts
// host/src/dri/gbm-registry.ts
interface HostBoBacking {
  id: number;
  // Exactly one of these is non-null:
  gpuTexture: { canvas: OffscreenCanvas, tex: WebGLTexture } | null;
  cpuShared: { sab: SharedArrayBuffer, offset: number, length: number } | null;
  cpuPrivate: Uint8Array | null;
  // For all tiers:
  width: number; height: number; format: number; stride: number;
}
```

### §4.3 mmap of a bo into process Memory

`mmap(fd, length, PROT_READ|PROT_WRITE, MAP_SHARED, dri_fd, bo_offset)`
where `bo_offset` is the value returned by `DRM_IOCTL_MODE_MAP_DUMB`
(Linux convention — the offset is a fake address space the driver
hands you to identify which bo to map; we adopt this verbatim).

- **GPU tier**: returns `EINVAL`. GPU-backed bos are not CPU-mappable
  in v1. Software that needs both calls `gbm_bo_create` with
  `GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING` and gets a CPU-shared
  bo instead.
- **CPU shared**: the kernel allocates a region inside the process's
  wasm `Memory` (anonymous mmap) and the host wires
  `MemoryManager::mmap_shared(addr, len, sab, offset)` to *point*
  that region at the bo's SAB slice. Writes through the wasm pointer
  hit the bo's backing directly. (`MemoryManager::mmap_shared` is
  new in v2 — extends the existing file-backed MAP_SHARED machinery
  to a bring-your-own-SAB case.)
- **CPU private**: same as CPU shared but the SAB is owned solely by
  the kernel worker (not transferable). mmap still works; the
  process sees the pixels; just don't try to prime-export it.

mmap is per-process; the bo can be mmap'd into N processes
simultaneously as long as each one has prime-imported it (the prime
import is what gives a process the right to map). The owner can
mmap without an explicit prime round-trip.

### §4.4 The ioctl surface

We add a `DRM` major (`'d'`, 0x64) ioctl block to `sys_ioctl`. ioctl
numbers track Linux UAPI (see
`linux/include/uapi/drm/drm.h` + `linux/include/uapi/drm/drm_mode.h`).
The v2 PR vendors `drm.h`, `drm_mode.h`, `drm_fourcc.h` into
`musl-overlay/include/drm/` verbatim. Programs `#include <drm/drm.h>`
and the numbers line up.

The ioctl surface we route in v2 (Linux name → our action):

**Buffer management:**

| Linux ioctl | Action |
|---|---|
| `DRM_IOCTL_MODE_CREATE_DUMB` | allocate a CPU-shared bo via GBM (dumb buffer = simple CPU-mappable bo) |
| `DRM_IOCTL_MODE_MAP_DUMB` | return `bo_offset` for mmap |
| `DRM_IOCTL_MODE_DESTROY_DUMB` | decref bo |
| `DRM_IOCTL_GEM_CLOSE` | decref bo (GEM-style) |
| `DRM_IOCTL_PRIME_HANDLE_TO_FD` | export bo as prime fd (§4.6) |
| `DRM_IOCTL_PRIME_FD_TO_HANDLE` | import prime fd as local bo handle |

**GBM-shape (libgbm uses these via libdrm):**

| libgbm call | Underlying ioctl |
|---|---|
| `gbm_create_device(fd)` | no ioctl; libgbm stub returns a handle |
| `gbm_bo_create(...)` | `DRM_IOCTL_MODE_CREATE_DUMB` or `*_CREATE` for GPU tier |
| `gbm_bo_get_fd(bo)` | `DRM_IOCTL_PRIME_HANDLE_TO_FD` |
| `gbm_bo_get_modifier(bo)` | tracked client-side, returned from CREATE |
| `gbm_bo_map(bo, ...)` | mmap on the dri fd at `bo_offset` |
| `gbm_surface_create(...)` | wraps a triple-buffered set of bos (§4.5) |
| `gbm_surface_lock_front_buffer` | dequeue the most recently rendered bo |
| `gbm_surface_release_buffer(bo)` | mark bo available again |

**KMS (compositor-only, see §6):**

| `DRM_IOCTL_MODE_GETRESOURCES` | enumerate CRTCs, connectors, encoders |
| `DRM_IOCTL_MODE_GETCRTC` / `_SETCRTC` | mode-setting (single fixed mode) |
| `DRM_IOCTL_MODE_GETCONNECTOR` / `_GETENCODER` | introspection |
| `DRM_IOCTL_MODE_ADDFB2` / `_RMFB` | wrap a bo as a `fb_id` |
| `DRM_IOCTL_MODE_PAGE_FLIP` | atomic flip; fires a vblank event (§6.3) |
| `DRM_IOCTL_MODE_ATOMIC` | one-shot atomic commit (v1 just delegates to PAGE_FLIP for the single-plane case) |
| `DRM_IOCTL_SET_MASTER` / `DROP_MASTER` | required for KMS calls; compositor takes master at boot |
| `DRM_IOCTL_VERSION` | returns `{name:"wpk", date:..., desc:"WPK virtual GPU"}` |
| `DRM_IOCTL_GET_CAP` (DRM_CAP_DUMB_BUFFER, DRM_CAP_PRIME, ...) | report supported caps |

**Render-node restrictions.** Per Linux semantics, render nodes
(`renderD128`) reject KMS ioctls with `EACCES`; primary nodes
(`card0`) require `DRM_MASTER` for KMS ops. We honour this so
unmodified libdrm probing works.

### §4.5 GBM surface (triple-buffered set of bos)

The most common GBM usage is *not* `gbm_bo_create`; it's
`gbm_surface_create` + repeated `eglSwapBuffers`. A GBM surface is a
*set* of bos (typically 3 — front/back/pending) that EGL rotates
through. `eglCreateWindowSurface(dpy, cfg, gbm_surface)` returns an
EGL surface that draws into the back bo; `eglSwapBuffers` atomically
moves back→front and gives the client a fresh back bo. The compositor
then calls `gbm_surface_lock_front_buffer` to get the front bo,
`drmModeAddFB2` it, page-flip it. After the flip vblank lands,
`gbm_surface_release_buffer` returns the bo to the pool.

We mirror this exactly. The new `WPK_SURFACE_GBM` EGL surface kind
(extending v1's `WPK_SURFACE_DEFAULT` and `WPK_SURFACE_PBUFFER`)
takes a `gbm_surface` handle in its attrs. The kernel allocates
*three* bos at creation, tracks `{front, back, free[]}`, and rotates
on each `GLIO_PRESENT`. The host bridge points the WebGL framebuffer
at the current back bo's `WebGLTexture` (GPU tier) or at a CPU
upload path (CPU shared tier — used when SCANOUT-only without
rendering capability is requested).

### §4.6 Prime fds without `SCM_RIGHTS`

Linux uses `SCM_RIGHTS` on a unix socket to pass fds between
processes. We have unix sockets (added in
`docs/plans/2026-03-08-phase6-sockets-plan.md`) but the
fd-passing-via-control-message machinery is partial. v2 adds it for
the DRI case via a narrow path:

- A **prime fd** is a process-local fd in `OpenFileKind::PrimeBo {
  bo_id: BoId, cookie: u64 }`. The cookie is a global, monotonic,
  unguessable token issued at `PRIME_HANDLE_TO_FD` time and stored
  on the bo's `prime_handle` field. The cookie is the
  capability — knowing the bo_id is not enough.
- To pass it, the sender uses `sendmsg` with `SCM_RIGHTS` carrying
  the prime fd over the compositor's unix socket. Kernel-side, the
  receiver's `recvmsg` creates a new `OpenFileKind::PrimeBo` with
  the same `(bo_id, cookie)`. Sender's fd can be `close`d
  independently; the bo refcount on `prime_handle` is what keeps the
  bo alive.
- `DRM_IOCTL_PRIME_FD_TO_HANDLE` on a `PrimeBo` fd looks up
  `(bo_id, cookie)`; cookie mismatch → `EACCES`. Sucessful import
  increments the bo refcount and returns a per-process handle.

This sidesteps the question of whether our generic `SCM_RIGHTS`
implementation is complete; it scopes the requirement to "carry one
prime fd over the compositor socket," which is the only DRI use case.
The wider `SCM_RIGHTS` work remains a separate plan.

### §4.7 Trade-offs locked in

- **Three tiers, not one.** A pure-GPU model is simpler but breaks
  any software that calls `gbm_bo_map` (notably the compositor when
  it draws decorations into the client surface's bo for SSD). A
  pure-CPU model is slower (every frame is a texture upload).
  Three tiers cover the cases; tier selection is automatic from
  the `usage` flags GBM clients already pass.
- **Same fd for GBM and GL.** `gbm_create_device(fd)` takes the
  dri fd; v1 already exposes per-process state on the
  `OpenFileKind::DriRender` fd. Reusing the fd avoids inventing a
  fourth ownership model. Cost: clients that open two GL contexts
  through one dri fd (rare; usually two opens) share the same GBM
  device. Mitigation: GBM device handle is itself a per-fd thing,
  so the libgbm stub can hand out distinct ones.
- **LINEAR-only modifier in v1.** Tiled / compressed modifiers (the
  long list in `drm_fourcc.h`) require GPU-aware swizzling. We
  report `DRM_FORMAT_MOD_LINEAR` only and reject others. Real
  software fields this gracefully (it's the modifier-negotiation
  case).
- **Prime fd cookie space is global**, not per-bo. A leak in the
  refcount could let a stale fd resurrect a freed bo if the BoId
  is reused. Mitigation: `BoId` is monotonic, never reused;
  cookie collision on a still-live bo is the only failure window,
  and the cookie is 64-bit unguessable.
- **`gbm_bo_map` cache flush hooks (`gbm_bo_map_flags` + `*_unmap`)**
  are honoured as no-ops. WebGL's coherency model is "draw on the
  worker, see on the worker"; we don't have a coherent shared
  mapping CPU↔GPU to flush. For LINEAR CPU-shared bos this is
  correct; for GPU bos `gbm_bo_map` returns `EINVAL` (see §4.3) so
  the question doesn't arise.

## §5. N-guest → 1-host GL multiplexer

v1 enforces single-open. v2's job here: let N processes hold their
own GL contexts against the *single* host `WebGL2RenderingContext`
without one process's state mutations corrupting another's.

### §5.1 The model

The host has exactly one `WebGL2RenderingContext` per
`OffscreenCanvas`. WebGL is implicitly stateful: bound textures, the
current program, the bound framebuffer, enabled vertex attributes,
viewport / scissor, blend / depth state — all *global to the
context*. A multiplexer that switches between N client contexts must
either:

- **(A) Pin each client to its own host context** — every process
  gets its own OffscreenCanvas + WebGL2 context. Easy, no
  multiplexing, breaks the moment the compositor wants to *sample*
  client bos as textures (cross-context texture sharing isn't a
  WebGL thing).
- **(B) One host context, save/restore on every submit boundary** —
  the multiplexer captures the WebGL state before yielding to
  another client and restores on return. ~120 ints + ~64 small
  arrays of state to save; ~30 µs/save on a 2024 MacBook.
- **(C) One host context, *re-establish* state from a per-client
  shadow on every submit** — instead of saving the host's current
  state then restoring it later, each client maintains a shadow of
  *its* state in the cmdbuf (uniform values, bindings, current
  program, etc.), and the multiplexer re-applies the client's
  shadow when its turn comes up. No save needed; switch cost is
  bounded by *one client's* state size.

We go with **(C)**, with two refinements:

- **Per-context VAO + per-context FBO.** Both already isolate
  attribute and target state in WebGL — the multiplexer's "switch"
  for these is `gl.bindVertexArray(ctx.vao)` + `gl.bindFramebuffer(
  ctx.fbo)`. Free.
- **Lazy switch.** If consecutive submits come from the *same*
  client, no switch. Hot path is single-client (one app drawing
  N frames in a row); the switch cost shows up only at frame
  boundaries when the compositor preempts a client.

### §5.2 Per-context shadow

Each `GlBinding` (per-(pid, ctx_id), see v1 §3) gains:

```ts
interface GlShadowState {
  // Set by every state-changing op on submit; replayed on context switch.
  viewport: [number, number, number, number];
  scissor: [number, number, number, number] | null;     // null if disabled
  clearColor: [number, number, number, number];
  clearDepth: number;
  depthFunc: number;
  cullFace: number | null;
  frontFace: number;
  blendEnabled: boolean;
  blendFunc: { srcRGB: number, dstRGB: number, srcA: number, dstA: number };
  depthTestEnabled: boolean;
  // ... ~40 entries covering everything in the v1 op table that mutates state
  currentProgram: WebGLProgram | null;
  vao: WebGLVertexArrayObject;          // per-context, created at make-current
  fbo: WebGLFramebuffer | null;         // null = default fb (the canvas)
  textureUnits: (WebGLTexture | null)[]; // [GL_TEXTURE0..GL_TEXTUREn]
  activeTexture: number;
  // Uniform values are *not* shadowed — they live on WebGLProgram, which
  // survives context switches. Re-binding the program is enough.
}
```

The multiplexer's switch:

```ts
function switchTo(target: GlBinding) {
  if (current === target) return;
  const s = target.shadow;
  gl.bindVertexArray(s.vao);
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
  gl.viewport(...s.viewport);
  if (s.scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...s.scissor); }
  else gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(...s.clearColor);
  // ... ~40 lines of state re-application
  if (s.currentProgram) gl.useProgram(s.currentProgram);
  for (let i = 0; i < s.textureUnits.length; i++) {
    if (s.textureUnits[i]) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, s.textureUnits[i]);
    }
  }
  gl.activeTexture(gl.TEXTURE0 + s.activeTexture);
  current = target;
}
```

Cost ballpark: 40-80 WebGL calls per switch, each ~1 µs in Chrome
2024, ≈ 60-100 µs. At 60 fps with one switch per frame (compositor
preempting one client at a time) the overhead is < 0.6% of a frame.
For ≥ 4 clients all drawing concurrently, the switch cost stays linear
in *number of switches*, not number of clients.

### §5.3 Submit ordering & fairness

Submits arrive on the kernel-host channel; the kernel forwards them
to the host worker via `host_gl_submit(pid, ctx_id, offset, len)`.
Today this is a direct call; in v2 the host worker maintains a
**submit queue** keyed by `(pid, ctx_id)`:

```ts
class SubmitQueue {
  pending: Map<string, { binding: GlBinding, frames: Frame[] }> = new Map();
  // Drained in priority order; default is round-robin by (pid, ctx_id).
  // Compositor (special pid) jumps ahead of everyone.
  drain() {
    while (this.pending.size > 0) {
      const next = this.pickNext();         // round-robin
      const frame = next.frames.shift();
      if (!frame) { this.pending.delete(next.key); continue; }
      switchTo(next.binding);
      decodeAndDispatch(next.binding, frame.memorySab, frame.off, frame.len);
    }
  }
  pickNext(): QueueEntry { /* ... */ }
}
```

Two priorities:

- **`COMPOSITOR_PRI`**: the compositor process (PID 2) gets head-of-
  queue on every drain. Justified by KMS semantics — page-flips
  drive the display heartbeat; client frames are wasted work if
  they preempt a present.
- **`CLIENT_PRI`**: everyone else, FIFO within priority. v1's single
  client + cube demo's second process both run here.

We do **not** preempt in the middle of a submit. The cmdbuf is the
atomic unit; once a submit starts decoding, it runs to completion
before the next switch. This keeps WebGL's implicit ordering
guarantees intact (frame N's draws complete before frame N+1's start)
and removes a class of races at near-zero throughput cost (max
extra latency = one frame of one client = ~16 ms at the worst case
for an interactive client; in practice frames are 1-3 ms).

### §5.4 Compositor's privileged hooks

The compositor needs three things ordinary clients don't:

1. **Sample a client's bo as a texture.** Added v2 ioctl
   `GLIO_BIND_FOREIGN_TEXTURE(local_handle = u32, bo_id = u32)`.
   Resolves the bo (must be a GPU-tier bo the compositor has
   prime-imported); creates a local `WebGLTexture` view on the same
   underlying `OffscreenCanvas`. Implementation: the host bridge
   maintains an `id → WebGLTexture` map across all kernel-worker GL
   contexts (they all share the same `WebGL2RenderingContext`, so
   `WebGLTexture` handles are inter-usable when the multiplexer
   tracks them properly).
2. **Atomic present with vblank fence.** A `GLIO_PRESENT_KMS` ioctl
   that hooks the GBM bo rotation in §4.5 to a KMS page-flip event
   on `card0`. The compositor calls this instead of
   `eglSwapBuffers`. The flip event drives the `DRM_EVENT_VBLANK`
   the compositor `read()`s from `card0`.
3. **Promotion to `COMPOSITOR_PRI`.** Compositor takes `DRM_MASTER`
   on `card0` at boot; that flag promotes its (pid, ctx_id)s in
   the multiplexer queue. Future enhancement: explicit
   `DRM_MASTER_TRANSFER` for compositor restart.

### §5.5 Trade-offs locked in

- **One host context, multiple guests** is the architectural call;
  the per-bo `WebGLTexture` map breaks otherwise. If a future browser
  splits WebGL contexts hard enough that texture sharing fails, the
  multiplexer rebases to a different sharing model (e.g. one canvas
  per CRTC, compositor only); the *ioctl surface* stays.
- **No GL preemption mid-submit.** Submits are atomic. A pathological
  client with a 1 MiB worst-case cmdbuf (~50 ms of WebGL work)
  blocks the compositor for one cmdbuf. Acceptable v2 behaviour;
  v3 cuts huge submits into chunks if profiling shows it.
- **`pickNext` is plain round-robin.** Future schedulers (priority
  inheritance, deadline) are easy to add; over-engineering is easy
  to avoid.

## §6. `/dev/dri/card0` — KMS surface for the compositor

The primary node. Linux name; we implement enough of it that an
unmodified `libdrm` compiles and probes it, and the compositor can
mode-set, attach framebuffers, page-flip.

### §6.1 What the device represents

A single virtual display:

```
Resources:
  CRTC      0    (the only one)
  Connector 0    (type DRM_MODE_CONNECTOR_VIRTUAL, status connected)
  Encoder   0    (type DRM_MODE_ENCODER_VIRTUAL, attached to CRTC 0)
  Plane     0    (type DRM_PLANE_TYPE_PRIMARY, on CRTC 0)
```

The connected mode is the bound canvas's CSS pixel size, reported
once at boot (host-side: `attachCompositorCanvas(canvas)` records
`canvas.clientWidth × canvas.clientHeight`; v2 doesn't track size
changes — TODO §15). Refresh rate is reported as 60 Hz; the actual
RAF pump's cadence drives vblank events.

### §6.2 Open rules

Open `/dev/dri/card0` requires a process to subsequently call
`DRM_IOCTL_SET_MASTER` to be allowed to perform mode-set ioctls.
Master is a single slot: one master at a time. The compositor takes
master at boot; second `SET_MASTER` returns `EBUSY` (Linux returns
`EACCES`; we match `EACCES`). Non-master opens still get device
introspection (`GETRESOURCES`, `GETCONNECTOR`, `VERSION`, `GET_CAP`).

### §6.3 vblank events

When `MODE_PAGE_FLIP` runs:

1. Host worker swaps the displayed bo (records the new
   `primary_fb_id` in `KmsState`).
2. Posts a frame to the kernel's fb-presentation path so the host
   main thread blits / commits the bo's pixels to the bound canvas
   on the next RAF.
3. After the host RAF fires, the kernel-worker wakes up the
   compositor with a synthetic `DRM_EVENT_VBLANK` packet on its
   `card0` fd's read side. The compositor's event loop is a poll
   on `card0` + the input devices + the compositor unix socket.

This is the project's existing fbdev RAF pump (canvas-renderer.ts),
extended with: a hook that fires *after* commit to schedule the
vblank event delivery. The fbdev framebuffer remains usable for
`fbDOOM`-style non-DRI software; KMS clients use the same canvas
through a different code path.

### §6.4 What is intentionally not implemented in v1

- **Atomic ioctl with multiple planes.** v1 `_ATOMIC` accepts a
  property set that names only the primary plane; multi-plane
  commits return `EINVAL`. Single-plane apps work; the compositor's
  cursor is software (drawn into the primary).
- **Mode list.** `MODE_GETCONNECTOR` returns exactly one mode (the
  canvas size). `MODE_DPMS` is accepted and ignored. Software that
  probes for "is the display on" sees yes.
- **Hot-plug uevents.** `card0` doesn't emit uevents. The
  compositor refreshes its state on a debounced canvas-resize
  callback (post-v1; for v1 the canvas is a fixed size at boot).

## §7. Input — evdev + the seat

A real DRI userland needs `evdev` because that's what `libinput`
reads and `libinput` is what every modern desktop input stack uses.
We add `/dev/input/event0` (keyboard) and `/dev/input/event1`
(mouse), behind the existing `/dev/input/` directory in devfs
(`/dev/input/mice` was added in PR
[#459](https://github.com/mho22/wasm-posix-kernel/pull/459) for the
fbDOOM mouse work; we extend the same directory).

### §7.1 The wire format

Each `event*` fd, on `read`, returns one or more
`struct input_event` (16 bytes on Linux x86_64; 24 bytes on
wasm32-ilp32; the layout is documented uAPI):

```c
struct input_event {
    struct timeval time;   // 8 bytes on wasm32 (i32 sec + i32 usec)
    __u16 type;
    __u16 code;
    __s32 value;
};
```

Per-fd, the kernel maintains a ring buffer (32 KiB, ≈ 2000 events).
Producer is the host input backend (browser event listeners on the
compositor canvas, or Node test harness). Consumer is the
`read`-ing process. `O_NONBLOCK` short-reads with `EAGAIN`; blocking
`read` parks on the channel until events arrive.

### §7.2 ioctls

Wide enough that `libinput`'s probe (`udev_device_get_*` returning
synthetic attributes from us, plus `EVIOCG*` reads on the fd) passes
without modification.

| ioctl | Action |
|---|---|
| `EVIOCGVERSION` | return `0x010001` |
| `EVIOCGID` | return `{bustype:BUS_VIRTUAL, vendor:0, product:0, version:1}` |
| `EVIOCGNAME(len)` | "wpk virtual keyboard" / "wpk virtual mouse" |
| `EVIOCGPHYS(len)` | "wpk0/input0" / "wpk0/input1" |
| `EVIOCGUNIQ(len)` | empty |
| `EVIOCGPROP(len)` | property bitmap (mouse advertises `INPUT_PROP_POINTER`) |
| `EVIOCGBIT(0, len)` | event-type bitmap (`EV_SYN`, `EV_KEY`, `EV_REL` for mouse; `EV_SYN`, `EV_KEY`, `EV_REP`, `EV_LED`, `EV_MSC` for keyboard) |
| `EVIOCGBIT(EV_KEY, len)` | the full KEY_* bitmap (keyboard) or BTN_LEFT/RIGHT/MIDDLE (mouse) |
| `EVIOCGBIT(EV_REL, len)` | REL_X, REL_Y, REL_WHEEL (mouse) |
| `EVIOCGABS(axis)` | `EINVAL` (no absolute axes in v1; no `ABS_MT_*`) |
| `EVIOCGKEY(len)` | current pressed-key state |
| `EVIOCGLED(len)` | LED state (all zero) |
| `EVIOCGRAB` | grab/ungrab the device (compositor takes grabs for sandbox; v1 single-master = always granted) |
| `EVIOCREVOKE` | revoke a previously granted fd (`EBUSY` if never granted; v1 ignored) |

The bitmap responses are precomputed `const` blobs in
`crates/kernel/src/dri/evdev_caps.rs`. Generating them from the
Linux `input-event-codes.h` (vendored under `musl-overlay/include/
linux/`) keeps the bitmap and the headers in sync.

### §7.3 The seat

A `Seat` is the libinput abstraction for "this user's input devices,
plus where focus is". Seat state lives in the *compositor*, not the
kernel. The kernel surface is just the event devices; the seat is
how the compositor interprets them.

- **Focus.** Compositor maintains a focus stack of client surfaces;
  KEY events go to the focused client via the compositor's per-
  client `event_queue` (a pipe). REL events go through the
  pointer-position state; clicks are dispatched by hit-test.
- **Clipboard.** Two paste mechanisms in real desktops: PRIMARY
  (middle-click), CLIPBOARD (Ctrl-C). v1 implements CLIPBOARD only,
  in-memory in the compositor, exposed to clients via a custom
  compositor-protocol message (no X selection emulation).

The seat design here is intentionally thin: enough to drive a panel
+ desktop + popup menu, not enough to support inhibitors, DnD, IME.

## §8. Audio — `/dev/snd/*` + dummy backend

Real SDL2 audio init fails hard if the device probe returns nothing;
the dummy backend exists so SDL_OpenAudioDevice succeeds without
making sound.

### §8.1 Devices

| Path | Major/minor | Purpose |
|---|---|---|
| `/dev/snd/controlC0` | 116:0 | card-level control (mixer surface; minimal) |
| `/dev/snd/pcmC0D0p` | 116:1 | PCM playback device 0 of card 0 |
| `/dev/snd/timer` | 116:2 | timer subsystem (one ioctl, returns dummy timer) |
| `/dev/snd/seq` | 116:1 | sequencer (stub; MIDI software gracefully degrades) |

### §8.2 ioctl shape

ALSA's userspace lives entirely in alsa-lib; alsa-lib turns API
calls into ioctls. We vendor `sound/asound.h` from Linux uAPI under
`musl-overlay/include/sound/` and route the SNDRV_PCM_IOCTL_*
subset alsa-lib needs to drive a simple playback stream:

- `SNDRV_PCM_IOCTL_PVERSION`
- `SNDRV_PCM_IOCTL_INFO`
- `SNDRV_PCM_IOCTL_HW_PARAMS` / `_HW_REFINE` / `_HW_FREE`
- `SNDRV_PCM_IOCTL_SW_PARAMS`
- `SNDRV_PCM_IOCTL_PREPARE` / `_START` / `_DROP` / `_PAUSE`
- `SNDRV_PCM_IOCTL_STATUS`
- `SNDRV_PCM_IOCTL_WRITEI_FRAMES` (interleaved write)
- `SNDRV_PCM_IOCTL_MMAP_*` (status + control pages; period IRQ
  delivery)

For mmap mode (the fast path SDL2 prefers), the kernel allocates
two small pages — `mmap_status` (read-only to client; written by
backend) and `mmap_control` (read-write; appl_ptr lives here) — and
maps them into the process. The backend's "interrupt" is a kernel-
worker timer that fires every `period_size / sample_rate` and
advances `hw_ptr` in mmap_status; the client's `poll`/`select` on
the pcm fd wakes on that.

### §8.3 Dummy backend implementation

Lives in the kernel worker. Maintains, per opened pcm:

```ts
interface DummyPcm {
  pid: number;
  sampleRate: number;       // from HW_PARAMS
  channels: number;
  format: number;           // SNDRV_PCM_FORMAT_S16_LE typical
  periodSize: number;       // frames per period
  bufferSize: number;       // frames total
  hwPtr: number;            // mmap_status->hw_ptr
  applPtr: number;          // mmap_control->appl_ptr (read from process)
  intervalMs: number;       // periodSize * 1000 / sampleRate
  timer: NodeJS.Timer | number;  // setInterval handle
}
```

On `_START`: schedule the period timer. On `_DROP` / `_PAUSE`:
cancel. On tick: `hwPtr += periodSize`, wake `poll` waiters.
WRITEI_FRAMES writes are discarded after a checksum is computed
(for tests; the test asserts the checksum matches the expected
silence pattern).

### §8.4 WebAudio backend (post-v1)

The dummy is the v1 ship. A WebAudio backend swaps the dummy for
a real audio output:

- Main thread owns `AudioContext` + `AudioWorkletNode` (browser);
  Node ignores or wires to `speaker`.
- Worker → main protocol carries `audio_period(pcm_id, pcm_data)`
  messages; main appends to the AudioWorklet's ring.
- Latency target: 2× period_size; underruns logged.

The dummy's period timer becomes the worklet's `process` callback;
everything else stays.

## §9. Compositor + userland

The compositor is **a wasm program the kernel boots at PID 2**. It
links against an in-tree static "draw lib" + libinput + libgbm +
libegl + libdrm. It is not part of the kernel; it is the first user
of the surface this design adds.

### §9.1 Boot sequence

PID 1 is `init` (existing); v2 adds a small change: if
`/etc/wpk/compositor` exists, init `fork+exec`s it as PID 2 before
starting the user shell. The browser demo's `init` sets that file
in its rootfs.

The compositor's startup:

```c
int dri_fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
ioctl(dri_fd, DRM_IOCTL_SET_MASTER, NULL);            // become master
gbm = gbm_create_device(dri_fd);
egl = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, NULL);
eglInitialize(egl, NULL, NULL);
ctx = eglCreateContext(...);
surf = eglCreateWindowSurface(egl, cfg, gbm_surface, NULL);
eglMakeCurrent(...);
mkdir("/run/wpk", 0755);
sock = socket(AF_UNIX, SOCK_STREAM, 0);
bind(sock, "/run/wpk/comp", ...);
listen(sock, 16);
input = libinput_path_create_context(...);
libinput_path_add_device(input, "/dev/input/event0");
libinput_path_add_device(input, "/dev/input/event1");
pollfd fds[] = { {dri_fd, POLLIN}, {sock, POLLIN}, {libinput_fd, POLLIN} };
for (;;) { poll(fds, 3, -1); /* dispatch */ }
```

Approximately 200 LoC for the bring-up + 600 LoC for the draw
surface + window decorations + 300 LoC for the panel + 150 LoC
for the popup menu engine = **~1.2 kLoC** of in-tree compositor.

### §9.2 Custom protocol (not Wayland)

> **⚠️ AMENDED (2026-07-08).** v1 now uses **Wayland**, not this custom
> wire. See [`2026-07-08-dri-wayland-compositor-plan.md`](2026-07-08-dri-wayland-compositor-plan.md).
> The frame format below is retained as history.

The wire is a binary frame format on the unix socket:

```
struct wpk_msg {
    u32 length;     // including this header
    u32 type;       // WPK_MSG_*
    u8  payload[];  // type-specific
};
```

Message inventory v1 (~24 types):

- `CREATE_SURFACE { width, height, format } → surface_id`
- `DESTROY_SURFACE { surface_id }`
- `ATTACH_BUFFER { surface_id, prime_fd }` — client passes a prime
  fd over `SCM_RIGHTS`; compositor `recvmsg`s it, imports as bo,
  binds to the surface.
- `COMMIT { surface_id }` — atomic "this buffer is now the surface"
- `SET_TITLE { surface_id, title_utf8 }`
- `SET_TYPE { surface_id, type }` — toplevel | popup | panel
- `INPUT_KEYBOARD { keycode, state, modifiers }`
- `INPUT_POINTER_MOTION { x, y }`
- `INPUT_POINTER_BUTTON { button, state }`
- `INPUT_POINTER_AXIS { axis, value }`
- `FOCUS_IN { surface_id }` / `FOCUS_OUT { surface_id }`
- `CLIPBOARD_SET { mime_type, payload_offset, payload_len }`
  (payload in a follow-up `CLIPBOARD_DATA` message)
- `CLIPBOARD_REQUEST { mime_type }` / `CLIPBOARD_DATA { ... }`
- `WINDOW_CLOSE { surface_id }`

This is **purposefully smaller** than Wayland: no global registry,
no version negotiation, no XDG-shell-style state machine. The cost:
Wayland-only apps don't run unmodified. The benefit: ~24 message
types vs. Wayland's ~200, and a one-week implementation rather than
a quarter.

The Wayland compat layer (post-v1, see §15) bridges
`libwayland-server`'s wire to this protocol if/when Wayland-app
support becomes a goal.

### §9.3 The draw lib + text rasterizer

In-tree `examples/libs/wpkdraw/` (matches the package layout). Single
static archive (`libwpkdraw.a`) used by the compositor and by panel /
file-manager:

- 2D primitives over GBM bo (CPU tier): rect, line, alpha-blend
  composite.
- A minimal text rasterizer: `stb_truetype.h` (single-header,
  vendored) + a fixed-DPI cache. One bundled font
  (DejaVu Sans, regular, 512 KB) at `/usr/share/fonts/default.ttf`.
- A widget primitive layer: button, label, panel-strip, popup-menu.

~1500 LoC total. The rasterizer also unblocks any future userland UI
(file-manager, settings panel, terminal embedding, etc.).

### §9.4 Seed apps

- `examples/libs/wpkfm/` — a file-manager. Tree view, list view,
  open-with menu, ~800 LoC, links libwpkdraw + libwpkcompositor
  client lib.
- An SDL2 + GLES2 demo window — port of `gltri`, plus an
  `SDL_OpenAudioDevice` dummy beep to exercise the audio stack.

### §9.5 Why custom protocol, not Wayland, in v1

> **⚠️ REVERSED (2026-07-08).** The conclusion of this section no longer
> holds: v1 *is* Wayland. Feasibility exploration confirmed every primitive
> Wayland needs (AF_UNIX + SCM_RIGHTS + parking epoll) already exists and is
> tested, and the libffi risk is contained by a Wayland-scoped shim. See
> [`2026-07-08-dri-wayland-compositor-plan.md`](2026-07-08-dri-wayland-compositor-plan.md)
> §1–§4. Kept below as the original rationale.

Wayland is two pieces: wire (libwayland-server / -client; ~5 kLoC)
and protocol (xdg-shell, wp_seat, wp_data_device_manager, ...).
A Wayland *server* needs:

- The wire (vendored, doable)
- Object registry + bind/unbind state machine (non-trivial)
- xdg-shell server (~2 kLoC + the spec)
- wp_seat with keyboard / pointer / touch / data_device (~1 kLoC)
- wp_compositor + wp_subcompositor + wp_subsurface (~500 LoC)
- A buffer protocol (wl_shm or linux-dmabuf-unstable-v1)

That is a 6-week milestone before the *first* demo runs. The
custom protocol gets us to "compositor decorates an SDL2 window" in
~1 week, and the post-v1 Wayland compat layer reuses the same KMS /
GBM / multiplexer surface — the work isn't wasted, it's
re-prioritised.

## §10. Validation milestones

In dependency order. Each is a working demo a reviewer can run.

| # | Milestone | What it proves | Underlying work |
|---|---|---|---|
| (A) | **GBM dumb-buffer round-trip** — two processes allocate a 256×256 ARGB8888 bo via `DRM_IOCTL_MODE_CREATE_DUMB`, one writes a gradient, prime-passes the fd to the other, second `mmap`s and verifies the gradient | bo lifecycle, prime fd, CPU-shared tier, refcount | §4.1–4.6 |
| (B) | **Multiplexer cube-pair** — two processes each open `/dev/dri/renderD128`, each draw a spinning cube to their own `WPK_SURFACE_DEFAULT`, both visible interleaved on the canvas | multiplexer, per-context shadow, second canvas binding | §5.1–5.3 |
| (C) | **KMS page-flip + vblank** — a tiny test program takes master on `card0`, allocates two GBM bos, alternates page-flips between them, reads vblank events, terminates cleanly | KMS surface, page-flip event delivery, master | §6 |
| (D) | **SDL2 spinning-cube window** — unmodified upstream SDL2 + GLES2 cube demo runs in the compositor; mouse drag rotates; ESC quits; audio init succeeds (silent); compositor decorates the window | end-to-end DRI stack | all of §4–9 |
| (E) | **File-manager + popup menus** — wpkfm browses the rootfs, right-click opens context menu, double-click launches a second SDL2 demo window | seat focus, clipboard, second client | §7, §9 |

Browser verification of (D) is the load-bearing gate; if (D) does
not run in Chrome on the maintainer's machine, no v2 PR merges.
Pattern follows v1 (gldemo gate).

## §11. ABI, host & kernel surface delta

**New `repr(C)` structs.** Each adds a snapshot row.

- `WpkDrmModeCreateDumb` (mirrors Linux `struct drm_mode_create_dumb`)
- `WpkDrmModeMapDumb` (mirrors `struct drm_mode_map_dumb`)
- `WpkDrmModeGetResources` / `_GetCrtc` / `_GetConnector` /
  `_GetEncoder` / `_GetPlane`
- `WpkDrmModeAddFb2` / `_RmFb`
- `WpkDrmModePageFlip` / `_Atomic`
- `WpkDrmPrimeHandleFd` (both directions; libdrm uses one struct)
- `WpkInputEvent` (24-byte wasm32 layout — see §7.1)
- `WpkSndPcmInfo` / `_HwParams` / `_SwParams` / `_Status`

**New ioctl number block** in `crates/shared/src/dri.rs`. Numbers
match Linux UAPI (DRM `'d'` magic 0x64; input `'E'` magic 0x45;
sound `'A'` magic 0x41). Mirrored from the vendored headers; the
ABI snapshot includes the `(magic, nr, struct_size)` triples so an
accidental drift fails CI.

**New host imports** (`HostIO` trait, kernel-side):

```rust
fn gbm_bo_create(&mut self, pid: i32, args: &WpkDrmModeCreateDumb) -> i32;
fn gbm_bo_destroy(&mut self, pid: i32, bo_id: u32) -> i32;
fn gbm_bo_map(&mut self, pid: i32, bo_id: u32) -> usize;    // returns process addr
fn gbm_bo_export_fd(&mut self, pid: i32, bo_id: u32) -> i32;
fn gbm_bo_import_fd(&mut self, pid: i32, prime_fd: i32) -> u32;

fn kms_get_resources(&mut self, pid: i32, out: &mut [u8]) -> i32;
fn kms_set_crtc(&mut self, pid: i32, args: &[u8]) -> i32;
fn kms_page_flip(&mut self, pid: i32, crtc: u32, fb_id: u32) -> i32;
fn kms_set_master(&mut self, pid: i32) -> i32;
fn kms_drop_master(&mut self, pid: i32) -> i32;

fn evdev_open(&mut self, pid: i32, dev: u32) -> i32;
fn evdev_read(&mut self, pid: i32, fd: i32, out: &mut [u8]) -> i32;
fn evdev_ioctl(&mut self, pid: i32, fd: i32, req: u32, arg: &mut [u8]) -> i32;

fn snd_pcm_open(&mut self, pid: i32, dev: u32, flags: u32) -> i32;
fn snd_pcm_ioctl(&mut self, pid: i32, fd: i32, req: u32, arg: &mut [u8]) -> i32;
fn snd_pcm_write(&mut self, pid: i32, fd: i32, frames: u64, data: &[u8]) -> i32;
```

**Channel layout: unchanged.** Asyncify slots: unchanged. Existing
syscall numbers: unchanged. The v2 surface is *additive*. Expect
`ABI_VERSION` bump 7 → 8 in the PR that lands the snapshot.

**New `kernel_*` exports**: none. Existing host-import pump handles
the new methods.

## §12. Testing strategy

The CLAUDE.md gauntlet plus new suites scoped to each milestone:

- **Cargo unit tests** under `crates/kernel/src/dri/`: bo lifecycle,
  refcount semantics, prime cookie validation, ioctl arg shape,
  multiplexer state shadow application, evdev ring overflow, snd
  period timer accounting.
- **Vitest integration** under `host/test/dri-*.spec.ts`: GBM
  registry, multiplexer fairness, KMS event delivery, evdev event
  injection (the test seeds the kernel evdev rings; a wasm test
  program `read`s and asserts).
- **libc-test / POSIX**: must remain at zero unexpected failures
  through every v2 PR. v2 doesn't touch syscalls that libc-test
  covers, so this is a no-regression check, not a coverage gain.
- **ABI snapshot**: regen + commit per Brandon's additive-only rule
  (`docs/abi-versioning.md`); v2 PRs that add structs commit
  snapshot deltas alongside; the one that bumps `ABI_VERSION` does
  so explicitly with a rationale paragraph in the PR body.
- **Playwright browser specs** under `examples/browser/test/`: one
  per milestone (A)–(E). The (D) spec is the gate: it launches the
  SDL2 cube demo, polls for first paint (canvas pixel sample), then
  injects a click and asserts the rotation responds.
- **Manual browser verification** per CLAUDE.md item 6: every PR
  that touches host runtime code runs `./run.sh browser` and
  inspects the affected demo before merge.

## §13. POSIX / Unix-like compliance notes

Per the user's brief: when POSIX has an opinion, follow POSIX; when
it doesn't, follow the broader Unix-like world (which here means
Linux UAPI). Concretely:

- **`open`, `close`, `read`, `write`, `mmap`, `munmap`, `ioctl`,
  `poll`, `select`, `fcntl`** — POSIX-defined surface, already
  POSIX-compliant via the existing kernel; v2's new device files
  ride that surface and inherit the compliance. The `ioctl`
  *request numbers* are Linux-specific, but `ioctl` itself
  (request-number opacity, errno on unknown request) follows POSIX
  IEEE 1003.1.
- **`/dev/dri/*` device-file shape** — Linux UAPI. POSIX does not
  describe DRM. We track Linux strictly: same major (226), same
  minor allocation (card0=0, renderD128=128), same `S_IFCHR` mode,
  same ioctl numbers. Rationale: `libdrm` is the only client
  surface that matters, and it has Linux baked in.
- **`/dev/input/event*`** — Linux UAPI. Same posture; `libinput`
  bakes Linux in.
- **`/dev/snd/*`** — Linux ALSA UAPI; same posture. The OSS
  surface (`/dev/dsp`) coexists from prior work — we don't migrate
  OSS clients to ALSA.
- **`SCM_RIGHTS`** — POSIX-defined for fd-passing over unix
  sockets. v2's narrow `SCM_RIGHTS` adds the prime-fd code path
  but doesn't deviate from POSIX semantics for other fd kinds. A
  future general-purpose `SCM_RIGHTS` plan completes coverage.
- **`fork` interaction with DRI fds** — POSIX inherits open fds
  across fork. We honour: child gets the dri fds. Per-fd state
  (GBM bos owned by the parent, GL contexts, KMS master) does
  **not** transfer; the child holding the fd can do *only*
  introspection ops until it allocates its own bos / contexts.
  This matches Linux DRM behaviour (master is per-fd-not-inherited;
  GEM handles are per-fd; `fork` gives the child a duplicated fd
  with empty state). The behaviour is documented in
  `docs/posix-status.md`'s "non-POSIX device behaviour" section.

## §14. Rollout — the user's 12-item roadmap, mapped to PRs

The user's brief listed twelve roadmap items. Each becomes one
plan + one or more PRs (Brandon-style: design PR first, impl PRs
after). The bracketed-prefix branch convention `[explore-…]` from
the v1 chain is preserved for this exploration; final branch
names drop the bracket-prefix when reformatted for upstream merge
per Brandon's style.

| # | User's roadmap item | Plan doc | PRs |
|---|---|---|---|
| 1 | renderD128: buffer + sharing model design doc | **this doc, §4** | this design PR + the plan PR that follows it |
| 2 | renderD128: N-guest→1-host GL multiplexer | `2026-05-25-dri-multiplexer-plan.md` | `kernel(dri): bo + multiplexer surface` / `host(dri): GBM registry + queue` / `examples(dri): cube-pair + dumb-buf demos` |
| 3 | evdev ioctl surface (full enough for SDL/libinput) | `2026-06-01-dri-evdev-plan.md` | `kernel(dri): /dev/input/event0,1 + EVIOC*` / `host(dri): input listeners → ring writes` / `examples(dri): evdev probe test` |
| 4 | ALSA shape — minimal, dummy backend | `2026-06-08-dri-alsa-plan.md` | `kernel(dri): /dev/snd surface` / `host(dri): dummy backend + mmap status` / `examples(dri): aplay-silence test` |
| 5 | SDL2 port (validation milestone — milestone D) | `2026-06-15-sdl2-port-plan.md` | `pkg(sdl2): cross-compile + recipe` / `examples(sdl2): cube demo` |
| 6 | Minimal text rasterizer in a shared draw lib | `2026-06-22-wpkdraw-plan.md` | `pkg(wpkdraw): rasterizer + primitives` |
| 7 | Custom-protocol compositor | `2026-06-29-wpkcompositor-plan.md` | `pkg(wpkcompositor): wire + KMS master + boot` / `init: optional PID 2 compositor` |
| 8 | Seat: focus + minimal clipboard | folded into #7 | one PR within the compositor series |
| 9 | wpk-panel / wpk-desktop / popup menu | `2026-07-13-wpk-shell-plan.md` | `pkg(wpkshell): panel/desktop/popup` |
| 10 | Seed apps: file manager + SDL demo window | `2026-07-20-wpk-seed-apps-plan.md` | one PR per app |
| 11 | WebGPU as second GPU device | `2026-08-…-webgpu-design.md` | post-v1 |
| 12 | Wayland compat layer (much later, optional) | deferred | post-v1 |

Roadmap is sequential: each item depends on the prior. Skipping (3)
breaks (5) at SDL2 init; skipping (4) breaks (5) at audio init;
skipping (6) leaves the compositor with nothing to draw; skipping
(7) leaves the SDL2 demo with no window manager.

## §15. What this design intentionally does not cover

> **⚠️ AMENDED (2026-07-08).** Wayland is **promoted** from a deferred
> post-v1 compat layer to the v1 display protocol. See
> [`2026-07-08-dri-wayland-compositor-plan.md`](2026-07-08-dri-wayland-compositor-plan.md).
> The remaining items below (WebGPU, unmodified GTK/Qt, full libffi) stay
> deferred.

- **WebGPU.** Mentioned as a second device-file later; the WebGPU
  ioctl surface diverges enough from DRM/GBM (different memory
  model, queue model, no GEM) that it gets its own design doc.
- **Wayland wire / xdg-shell server.** Named, planned, deferred.
- **X11.** No.
- **DMA-BUF beyond prime fds within our single process tree.** No
  cross-process-group exchange; our "exchange" is two wasm
  processes in the same kernel.
- **GLES 3.1 / 3.2 (compute, SSBOs, image load-store).** Lives in
  the WebGPU device, not renderD128.
- **Persisted shader cache, ICD loader, AMDGPU/Intel-specific
  extensions.** Out.
- **Canvas resize, hot-plug, DPMS power management, multi-monitor.**
  Out.
- **Power management of the GL device.** No idle suspend, no GPU
  reset; pages stay live until `close`.
- **DRM authentication (`DRM_IOCTL_AUTH_MAGIC`), render-node
  permissions beyond process credentials.** Out.
- **`udev` / `libudev` directly.** We provide a small `libudev`
  stub that returns the right strings for our two evdev devices +
  the dri device + the snd devices; full udev rules / hot-plug
  events are out.

## §16. Open questions

These need decisions before the §14 plan docs land. Captured here
so a reviewer can weigh in early.

1. **Compositor process model.** PID 2 booted by init (current
   design) vs. a kernel-internal compositor (would skip the wire
   protocol entirely). PID 2 wins on Linux-shape and reuses the
   existing process / fd machinery; the kernel-internal compositor
   wins on ~1 kLoC less code. Recommendation: PID 2, for the same
   reason DRM lives outside the kernel on Linux even though it
   could live inside.
2. **GBM bo `usage` to tier mapping table.** §4.2's "automatic from
   `usage`" rule has cases (`SCANOUT | LINEAR` without
   `RENDERING`) where two tiers are admissible. Tentative rule:
   prefer CPU-shared when LINEAR is requested *and* the bo is
   small (< 1 MiB), else GPU. Final rule needs profiling on real
   compositor workload.
3. **vblank cadence.** Drive vblanks from the host RAF (real
   display heartbeat) or from a kernel-worker `setInterval(16)`
   (predictable, not display-coupled)? RAF is correct for
   "frames the user sees"; setInterval is correct for "frames the
   software expects when running headless". Both are 1-line
   switches; recommend RAF in browser, setInterval in Node.
4. **Multiplexer scheduler.** Round-robin (§5.3) is the v1 call.
   Need to decide whether COMPOSITOR_PRI promotion is enough, or
   whether per-client weight (e.g. inverse of cmdbuf size) helps.
   Profile under (D) before deciding.
5. **In-tree compositor vs. ported `weston`-or-similar.** Porting
   `weston` (Wayland reference) would deliver a richer userland
   for free, but pulls in the full Wayland stack and re-opens the
   compat-layer question for v1. The custom in-tree compositor is
   the v1 ship. Recommendation noted; revisit after milestone (D).
6. **Should evdev events use `SYS_TIME_REALTIME` or
   `MONOTONIC` timestamps?** Linux made `MONOTONIC` the default
   in 2014. We do too.

---

**End of design.** Next document:
`docs/plans/2026-05-25-dri-buffer-sharing-plan.md` —
implementation plan for §4, the foundation everything else depends
on.
