# WebGL / GLES2 (`/dev/dri/renderD128`) — Design

Date: 2026-04-28
Branch: `emdash/explore-webgl-exposition-7afa5`
Worktree: `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-webgl-exposition-7afa5`

## §1. Goals & non-goals

**Goal.** A process running on this kernel can `open("/dev/dri/renderD128")`, bring up a GLES2 / EGL display + context the standard Linux way, link against unmodified `libEGL` + `libGLESv2` headers from Khronos, issue GL calls, and have those calls execute against a real `WebGL2RenderingContext` in the browser. An unmodified `es2gears` build (or equivalent upstream GLES2 demo) runs in `examples/browser/pages/gldemo/` and is visible on a `<canvas>`. Pixels appear; animation runs at the demo's natural frame rate.

**Non-goals (v1).**

- WebGL 1 fallback. WebGL 2 only (GLES 3.0 superset of GLES 2.0). If a browser doesn't have it, the demo is broken — same posture as fbdev requiring SAB.
- KMS / mode-setting / `/dev/dri/card0`. We expose a *render node* only. No `drmModeSetCrtc`, no atomic kernel modesetting. Software that needs a KMS device (`kmscube`, `weston`) is out of scope.
- Multiple GL contexts. One context per process; `eglCreateContext` after the first returns `EGL_BAD_ALLOC`. (Most demos use exactly one.)
- Multiple processes holding the GL device. `GL_DEVICE_OWNER: AtomicI32` enforces single-open, like `FB0_OWNER`. Second open returns `EBUSY`.
- EGL extensions beyond a tiny allow-list (`EGL_KHR_create_context`, `EGL_KHR_surfaceless_context`). `eglQueryString(EGL_EXTENSIONS)` returns that exact set.
- Native window systems. We do not implement Xlib or Wayland. `eglCreateWindowSurface` with a non-null `EGLNativeWindowType` returns `EGL_BAD_NATIVE_WINDOW`. Demos use `eglCreatePbufferSurface` *or* a kernel-defined `EGL_WPK_SURFACE_DEFAULT` sentinel that maps to "the bound canvas."
- GLX. Anything that includes `<GL/glx.h>` is out of scope. Use EGL.
- OpenGL (desktop, not ES). `libGL.so` is not provided. Programs must use `<GLES2/gl2.h>` / `<GLES3/gl3.h>` + `<EGL/egl.h>`.
- Compute shaders / SSBOs / image load-store. WebGL 2 doesn't have them; trying compiles with `#version 310 es` declarations should fail at `glCompileShader` time with the usual error string ("compute shaders not supported").
- DMA-BUF / EGLImage / zero-copy interop with `/dev/fb0`. No.
- `glReadPixels` to a buffer larger than 16 MiB. Returns `GL_OUT_OF_MEMORY`. (Pragmatic cap; the synchronous round-trip cost dominates anyway.)
- Audio (`OpenAL`, `SDL_mixer`). Separate effort, like `/dev/dsp`.
- Mouse and gamepad. Keyboard only, via stdin in raw termios mode (already works for fbDOOM).
- Multi-threaded GL. WebGL contexts are single-threaded; the kernel-side libGLESv2 stub does not protect against concurrent calls from multiple program threads. Threaded GL programs may render incorrectly. (Real GLES2 has the same single-thread requirement; programs that need multi-threaded resource creation usually use shared contexts, which are explicitly out of scope.)
- Persisted shader cache across sessions. Cache lives in process memory only.
- Node.js host actually rendering. Node host parses + validates the cmdbuf and exercises the kernel surface for tests; it does not produce pixels unless `headless-gl` is installed (optional).

**Constraint.** Per CLAUDE.md "never compromise hosted software." The demo gets vendored and patched only as needed for cross-compilation hygiene — never to work around platform gaps. If `es2gears` calls a GL function we haven't routed through the cmdbuf, we route it. Headers (`<EGL/egl.h>`, `<GLES2/gl2.h>`, `<GLES3/gl3.h>`, `<KHR/khrplatform.h>`) come from Khronos unmodified. Programs see exactly the same API surface they see on Linux + Mesa.

**Success criteria.**

1. `programs/gltri.c` (a ~120-line "hello triangle" — clear to grey, draw a coloured triangle, swap, sleep, exit) runs in the browser. The triangle is visible.
2. `es2gears` runs in the browser. Three coloured gears rotate at the demo's natural rate. FPS counter on stdout shows ≥30 fps in Chrome on a 2024 MacBook.
3. The Vitest integration test exercises the cmdbuf decode path on Node (with a recording fake host) and asserts the recorded sequence matches what `gltri.c` should emit (no real WebGL needed for the test to pass).

## §2. Architecture

```
   ┌─ user process (wasm32) ────────────────────┐
   │ es2gears:                                  │
   │   fd  = open("/dev/dri/renderD128")        │
   │   dpy = eglGetDisplay(fd)                  │
   │   eglInitialize(dpy, ...)                  │  → ioctls
   │   ctx = eglCreateContext(dpy, cfg, ...)    │
   │   sfc = eglCreateWindowSurface(            │
   │           dpy, cfg, EGL_WPK_SURFACE_DEFAULT)
   │   eglMakeCurrent(dpy, sfc, sfc, ctx)       │
   │                                            │
   │   cmdbuf = mmap(NULL, CMDBUF_LEN, RW,      │
   │                 SHARED, fd, 0)             │
   │   // libGLESv2 stub appends entries here:  │
   │   glClear(GL_COLOR_BUFFER_BIT) →           │
   │     emit_op(OP_CLEAR, mask)                │
   │   glDrawArrays(...) →                      │
   │     emit_op(OP_DRAW_ARRAYS, mode,first,n)  │
   │                                            │
   │   eglSwapBuffers(dpy, sfc) →               │
   │     ioctl(fd, GLIO_SUBMIT, &si)            │
   │     ioctl(fd, GLIO_PRESENT, NULL)          │
   └────────┬───────────────────────────────────┘
            │ syscalls via channel
   ┌────────▼───────────────────────────────────┐
   │ kernel (wasm64):                           │
   │   devfs: /dev/dri/renderD128 → DriRender0  │
   │   per-process GlBinding {                  │
   │     cmdbuf_addr, cmdbuf_len,               │
   │     ctx_id, surface_id                     │
   │   }                                        │
   │   on first mmap: HostIO::gl_bind(...)      │
   │   on ioctl(GLIO_SUBMIT, &si):              │
   │     HostIO::gl_submit(pid, off, len)       │
   │   on ioctl(GLIO_PRESENT):                  │
   │     HostIO::gl_present(pid)                │
   │   on close/munmap/exit/exec:               │
   │     HostIO::gl_unbind(pid)                 │
   └────────┬───────────────────────────────────┘
            │ HostIO callbacks (no channel; direct host call)
   ┌────────▼───────────────────────────────────┐
   │ host (TypeScript):                         │
   │   GlContextRegistry (mirror of fb registry)│
   │     pid → { ctx_id, surface_id, cmdbufView,│
   │             handleMaps: { buffers,         │
   │               textures, shaders, ... } }   │
   │   gl_submit(pid, off, len):                │
   │     view = process Memory SAB              │
   │     decode TLV stream from [off, off+len)  │
   │     dispatch each op to the WebGL2 ctx     │
   │   gl_present(pid):                         │
   │     no-op in WebGL — the canvas presents   │
   │     automatically after the RAF returns.   │
   │     Used for a fence callback if any       │
   │     waiter is parked on EGL_KHR_fence_sync │
   │     (deferred, see §8).                    │
   └────────────────────────────────────────────┘
```

Three flow paths:

1. **Open / EGL / ioctl path** — channel syscalls. `open` returns an fd backed by `OpenFileKind::DriRender(GlState)`. EGL setup runs through `ioctl(fd, GLIO_*, args)`. Pure kernel, no host involvement except for `gl_bind` (which arms host state but doesn't render).

2. **Cmdbuf submit path** — process `mmap`s a region (e.g. 1 MiB) backed by ordinary anonymous memory (same machinery as fb0 mmap). Stub libGLESv2 appends TLV entries. `ioctl(fd, GLIO_SUBMIT, &si { offset, length })` calls `HostIO::gl_submit(pid, off, len)`. Host reads `[addr+off, addr+off+len)` from the process Memory SAB, decodes, dispatches.

3. **Present / unbind path** — `eglSwapBuffers` is `GLIO_PRESENT`. In WebGL the canvas already presents at the next RAF; this ioctl exists so future fence/sync work has a hook. `close` / `munmap` / process exit / `execve` clear `gl_binding`, drop `GL_DEVICE_OWNER`, call `gl_unbind`.

**Why a cmdbuf, not one syscall per GL call?** A single `glClear + glViewport + glUseProgram + glBindBuffer + glDrawArrays` frame is ~10 calls. A 60 fps app at one syscall per call is 600 channel round-trips/second on a single thread. Real frames issue thousands of calls (uniform updates, attribute pointers, state changes) and that scales linearly. The cmdbuf collapses an entire frame into one channel round-trip plus one host-side decode loop. It also matches how real GPU drivers work, which makes the architecture reviewable on its own merits.

**Why a render node and not `/dev/fb0`?** `/dev/fb0` is a passive pixel buffer; the kernel doesn't know what's drawing what. WebGL is an *active* renderer that needs a context, shaders, state. Reusing `/dev/fb0` would force the bridge to glReadPixels every frame and copy into the fb0 region — wasteful and slow. The render node owns its own canvas; pixels never go through the kernel. (Future option: an `EGL_KHR_image` extension that imports an `/dev/fb0` mapping as a GL texture, for software that wants both. Out of scope.)

### Trade-offs of the cmdbuf design

- **Latency on synchronous calls**: `glGetError`, `glReadPixels`, `glGetUniformLocation` need a value back. They flush the cmdbuf, then run as a separate ioctl with an out buffer. One round-trip per call. Apps that call `glGetError` in their inner loop will be slow. Real GLES2 best practice says don't, so we accept it.
- **No replay safety**: if the host crashes mid-decode we can't re-run the frame because the cmdbuf cursor has already advanced. Acceptable — kernel is in the same process tree as the host; both die together. Not a server.
- **Cmdbuf overflow**: 1 MiB is enough for ~50k typical entries. If a frame overflows, the stub auto-flushes (one ioctl) and continues. Documented; profiled later if it shows up.
- **Object name allocation is client-side**: stub generates client names from a per-context counter. `glGenBuffers(n, names)` returns immediately without round-tripping. Host learns the names on the next op that references them and lazily creates the WebGL object. Wrong name = silent no-op (matches WebGL behaviour for invalid handles). Saves a round-trip per `glGen*`.
- **`memory.grow` invalidates the cmdbuf view**: same as fb0 — host re-reads on the next `gl_submit`. The cmdbuf SAB ref is cached lazily in the registry (`cmdbufView: null` after grow).
- **Single-context lock-in**: blocks resource sharing demos. YAGNI for v1; the upgrade is real but mechanical (per-context handle map already exists; the missing piece is `eglMakeCurrent` switching).
- **Fork drift**: forked child inherits the cmdbuf mmap but not `GL_DEVICE_OWNER`. Child calling `eglMakeCurrent` returns `EGL_NOT_INITIALIZED`. Documented limitation; matches Linux behaviour where GL state is per-process.

A "RPC every call" design (Option A in the exploration) was considered. Rejected because: every nontrivial frame is hundreds of calls; one channel round-trip per call would put the fast path through 30k Atomics/futex operations per second at 60 fps even on a tiny demo. Cmdbuf collapses that to ~120 round-trips/sec.

A "JIT a JS string per frame and `eval` it" design was also considered. Rejected because: CSP forbids `eval` in any sandboxed embedding, and the security review every embedder will run says no.

## §3. Kernel components

**New devfs entries** in `crates/kernel/src/devfs.rs`:

```rust
pub enum DevfsEntry { ..., DriRender0 }
```

`/dev/dri/renderD128` resolves to `DevfsEntry::DriRender0`. Stat as `S_IFCHR`, major 226 (Linux DRM major), minor 128. The `/dev/dri/` directory is also synthetic so `ls /dev/dri` works.

**New OpenFile variant** in `crates/kernel/src/ofd.rs`:

```rust
pub enum OpenFileKind {
  ...,
  DriRender(GlState),
}

pub struct GlState {
  /// Set when eglInitialize succeeded. Required for any other ioctl.
  initialized: bool,
  /// Set when eglCreateContext succeeded. One per fd (single-context).
  context_id: Option<u32>,
  /// Set when eglCreateWindowSurface or eglCreatePbufferSurface succeeded.
  surface_id: Option<u32>,
  /// Set when eglMakeCurrent has been called.
  current: bool,
  /// Set when the cmdbuf has been mmap'd.
  cmdbuf: Option<CmdbufBinding>,
}

pub struct CmdbufBinding {
  /// Offset within the process's wasm Memory.
  addr: usize,
  /// Length in bytes (fixed, e.g. 1 MiB).
  len: usize,
  /// Monotonic submit counter — bumped on every GLIO_SUBMIT. Used by
  /// host-side debug ring to correlate decode failures with submits.
  submit_seq: u64,
}
```

`open("/dev/dri/renderD128", O_RDWR)` enforces single-open via `GL_DEVICE_OWNER: AtomicI32` (pid or `-1`). Second open returns `EBUSY`. `O_NONBLOCK` accepted but ignored. `O_CLOEXEC` honoured by the existing fd-flags machinery.

**ioctls** in `sys_ioctl`:

| ioctl | Action |
|---|---|
| `GLIO_INIT` | Mark `initialized = true`. Returns 0. |
| `GLIO_TERMINATE` | Tear down: `unbind`, drop ctx + surface. Returns 0. |
| `GLIO_CREATE_CONTEXT` | Allocate a context_id (per-fd counter from 1). Calls `HostIO::gl_create_context(pid, ctx_id, attrs)`. Returns `ctx_id` via an out arg in the ioctl struct. |
| `GLIO_DESTROY_CONTEXT` | Call `HostIO::gl_destroy_context(pid, ctx_id)`. Clears `context_id` if it matches. |
| `GLIO_CREATE_SURFACE` | Allocate a surface_id. Calls `HostIO::gl_create_surface(pid, surface_id, kind, attrs)`. `kind` is `WPK_SURFACE_DEFAULT` (canvas) or `WPK_SURFACE_PBUFFER`. |
| `GLIO_DESTROY_SURFACE` | Symmetric. |
| `GLIO_MAKE_CURRENT` | Calls `HostIO::gl_make_current(pid, ctx_id, surface_id)`. Sets `current = true`. |
| `GLIO_SUBMIT` | Reads `{ offset, length }`. Calls `HostIO::gl_submit(pid, offset, length)`. Bumps `submit_seq`. |
| `GLIO_PRESENT` | Calls `HostIO::gl_present(pid)`. |
| `GLIO_QUERY` | Synchronous GL query (`glGetError`, `glGetIntegerv`, `glGetString`, `glReadPixels`, etc.). Reads a `{ op, in_buf_ptr, in_buf_len, out_buf_ptr, out_buf_len }` struct; calls `HostIO::gl_query(pid, op, in, out)`; returns bytes-written-to-out. This is the escape hatch from the cmdbuf. |
| anything else | `ENOTTY`. |

ioctl numbers chosen from the Linux `_IO('D', N)` DRM space (DRM's `'D'` magic) starting at `0x40` to avoid collision with libdrm constants. Wire layout for argument structs is documented + pinned in `crates/shared/src/lib.rs`.

**mmap path** in `sys_mmap`:

When `fd` is a `DriRender` and the GlState is `initialized`, instead of file-backed mapping:

1. Validate `len == CMDBUF_LEN` (1 MiB; constant in `shared::abi`). Mismatch returns `EINVAL`.
2. Allocate via `process.memory.mmap_anonymous(...)`.
3. Record `CmdbufBinding { addr, len, submit_seq: 0 }`.
4. Call `HostIO::gl_bind(pid, addr, len)`.

A second mmap on the same fd returns `EINVAL`. mmap before `GLIO_INIT` returns `EINVAL`.

**Cleanup**:

- `munmap` covering the cmdbuf: clear `cmdbuf`, call `gl_unbind(pid)`.
- `close` of the last fd: drop `GL_DEVICE_OWNER`. Like fb0, the binding survives close until munmap (POSIX shared mmap semantics).
- Process exit / exec: clear all GL state, call `gl_unbind(pid)`, `gl_destroy_context`, `gl_destroy_surface`, drop `GL_DEVICE_OWNER` if owned.
- `fork`: child inherits the cmdbuf mmap (existing behaviour) but **not** the GL device ownership. Child's first `eglMakeCurrent` fails. Documented.

**HostIO trait additions** (`crates/kernel/src/process.rs`):

```rust
fn gl_bind(&mut self, pid: i32, addr: usize, len: usize);
fn gl_unbind(&mut self, pid: i32);

fn gl_create_context(&mut self, pid: i32, ctx_id: u32, attrs: &[u8]);
fn gl_destroy_context(&mut self, pid: i32, ctx_id: u32);
fn gl_create_surface(&mut self, pid: i32, surface_id: u32, kind: u32, attrs: &[u8]);
fn gl_destroy_surface(&mut self, pid: i32, surface_id: u32);
fn gl_make_current(&mut self, pid: i32, ctx_id: u32, surface_id: u32);

fn gl_submit(&mut self, pid: i32, offset: usize, length: usize);
fn gl_present(&mut self, pid: i32);

/// Synchronous GL query. Returns bytes written into `out`, or negative
/// errno on failure. The host owns interpreting `op` (`shared::gl::QueryOp`).
fn gl_query(&mut self, pid: i32, op: u32, input: &[u8], out: &mut [u8]) -> i32;
```

All except `gl_query` are infallible from the kernel's POV — a bridge that's not configured (Node host without `headless-gl`) silently no-ops; the process still runs, just produces no pixels.

**ABI impact**: new `repr(C)` structs `GlSubmitInfo`, `GlContextAttrs`, `GlSurfaceAttrs`, `GlQueryInfo`. New constants `CMDBUF_LEN`, `GLIO_*` numbers, `WPK_SURFACE_*` tags. New `HostIO` host imports `host_gl_*`. Per the existing snapshot policy: `repr(C)` structs are tracked, host imports are tracked. Expect `ABI_VERSION` bump 6 → 7.

## §4. Host components

**New module** `host/src/webgl/registry.ts`:

```ts
export type GlContextHandle = number;   // ctx_id from kernel
export type GlSurfaceHandle = number;   // surface_id from kernel

export interface GlBinding {
  pid: number;
  /** Cmdbuf SAB region. Lazy view; rebuilt on memory.grow. */
  cmdbufAddr: number;
  cmdbufLen: number;
  cmdbufView: Uint8Array | null;

  /** WebGL context, created at gl_create_context time (browser) or null (Node fallback). */
  gl: WebGL2RenderingContext | null;

  /** The HTMLCanvasElement / OffscreenCanvas this context renders into. */
  canvas: HTMLCanvasElement | OffscreenCanvas | null;

  /** Per-context client-name → WebGL object maps. Names are
   *  generated client-side by the libGLESv2 stub; the host fills these
   *  lazily on first reference (or on the GenBuffers/GenTextures op). */
  buffers:  Map<number, WebGLBuffer>;
  textures: Map<number, WebGLTexture>;
  shaders:  Map<number, WebGLShader>;
  programs: Map<number, WebGLProgram>;
  vaos:     Map<number, WebGLVertexArrayObject>;
  fbos:     Map<number, WebGLFramebuffer>;
  rbos:     Map<number, WebGLRenderbuffer>;

  /** Uniform locations: (program, name) → WebGLUniformLocation. Locations
   *  are generated host-side and returned via gl_query. The stub caches
   *  them on the program; the host stores the reverse map for resolution. */
  uniformLocations: Map<string, WebGLUniformLocation>;

  /** Active state needed across decodes (current program, bindings). The
   *  cmdbuf is stateful in the same way real GL is; we track what we need
   *  to translate client names to host objects on subsequent calls. */
  currentProgram: WebGLProgram | null;
}

export class GlContextRegistry {
  bind(pid, addr, len): void;
  unbind(pid): void;
  rebindMemory(pid): void;             // memory.grow, like fb registry
  attachCanvas(pid, canvas): void;     // app calls this to wire pixels
  get(pid): GlBinding | undefined;
  list(): GlBinding[];
  onChange(fn): () => void;
}
```

Pure metadata + lazy view caches; the registry doesn't dispatch GL itself.

**New module** `host/src/webgl/bridge.ts`:

The decoder. One function per GL op group:

```ts
export function decodeAndDispatch(
  binding: GlBinding,
  memorySab: SharedArrayBuffer,
  offset: number,
  length: number,
): void {
  const view = new DataView(memorySab, binding.cmdbufAddr + offset, length);
  let p = 0;
  while (p < length) {
    const op   = view.getUint16(p, true);  p += 2;
    const len  = view.getUint16(p, true);  p += 2;
    dispatch(binding, view, p, op, len);
    p += len;
  }
}
```

`dispatch` is a switch on `op` (a `shared::gl::Op` enum mirrored as a TS const). Each arm decodes its payload, looks up handles via the per-context maps, and calls the WebGL function. Out-of-line shader source / uniform name strings are read from the same view.

Op categories (initial set, ~80 ops total — covers everything `es2gears` uses + a margin):

- State: `Enable`, `Disable`, `Viewport`, `Scissor`, `ClearColor`, `Clear`, `BlendFunc`, `DepthFunc`, `CullFace`, `FrontFace`, `LineWidth`, `PixelStorei`.
- Buffers: `GenBuffers`, `DeleteBuffers`, `BindBuffer`, `BufferData`, `BufferSubData`.
- Textures: `GenTextures`, `DeleteTextures`, `BindTexture`, `TexImage2D`, `TexSubImage2D`, `TexParameteri`, `ActiveTexture`, `GenerateMipmap`.
- Shaders / programs: `CreateShader`, `ShaderSource`, `CompileShader`, `DeleteShader`, `CreateProgram`, `AttachShader`, `LinkProgram`, `UseProgram`, `BindAttribLocation`, `DeleteProgram`.
- Uniforms: `Uniform1i/1f/2f/3f/4f`, `UniformMatrix4fv` (with a host-resolved location).
- Attributes: `EnableVertexAttribArray`, `DisableVertexAttribArray`, `VertexAttribPointer`.
- Draw: `DrawArrays`, `DrawElements`.
- VAO (GLES3): `GenVertexArrays`, `DeleteVertexArrays`, `BindVertexArray`.
- FBO/RBO (GLES3): `GenFramebuffers`, `BindFramebuffer`, `FramebufferTexture2D`, `GenRenderbuffers`, `BindRenderbuffer`, `RenderbufferStorage`, `FramebufferRenderbuffer`, `CheckFramebufferStatus` (sync).

Synchronous queries (handled by `gl_query`, not the cmdbuf):

- `glGetError`, `glGetString`, `glGetIntegerv` / `glGetFloatv`.
- `glGetUniformLocation`, `glGetAttribLocation`.
- `glGetShaderiv` (compile status), `glGetShaderInfoLog`.
- `glGetProgramiv` (link status), `glGetProgramInfoLog`.
- `glReadPixels`.
- `glCheckFramebufferStatus`.

**HostIO impl** (`host/src/kernel.ts`): the `host_gl_*` env imports translate i64 args, look up the registry by pid, and call the bridge. `gl_bind` records the cmdbuf region. `gl_create_context` either constructs `canvas.getContext('webgl2')` (browser, if `attachCanvas` already happened) or stores the request and waits (canvas may attach later). `gl_submit` calls `decodeAndDispatch`. `gl_present` is a no-op for v1 (RAF-driven canvas presents automatically).

**Worker → main forwarding** (browser only): like fbdev, the kernel runs in a worker, but the canvas can be either an `OffscreenCanvas` transferred to the worker (preferred — keeps GL calls in-worker, no extra hop) or a main-thread `HTMLCanvasElement` (fallback for browsers without OffscreenCanvas). When using the main-thread canvas, `kernel-worker-protocol.ts` gains `gl_bind / gl_unbind / gl_submit / gl_present / gl_query` messages; the worker forwards every op. The OffscreenCanvas path is the v1 default.

**Node bridge** (`host/src/webgl/node-bridge.ts`): no-op stub by default. If `headless-gl` is detected (optional dep), wire it in for full rendering in node tests. Either way, the cmdbuf decode runs and a "recording" mode logs the decoded ops to a buffer for tests to assert.

**Browser surface** (`host/src/webgl/canvas.ts`):

```ts
export function attachGlCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  registry: GlContextRegistry,
  pid: number,
): () => void {
  registry.attachCanvas(pid, canvas);
  return () => registry.detachCanvas(pid);
}
```

That's it. No RAF loop — the canvas presents itself when WebGL draws to it. No swizzle. The GL context owns the pixels.

**Why the bridge is its own module not `BrowserKernel`.** Same reasoning as fb0: keeps the platform/application boundary clean. The demo page wires it: `attachGlCanvas(canvas, kernel.gl, pid)`. `BrowserKernel` re-exports `kernel.gl = registry`.

## §5. Stub libEGL + libGLESv2 in the sysroot

Two static archives. *No upstream source* — this is our own surface that emits cmdbuf entries. Goal: keep v1 small enough to hand-write and review without a generator. Total new C: **~800 LoC across two files.**

**`musl-overlay/include/EGL/egl.h`, `eglplatform.h`** — vendored from Khronos unmodified (they're API-stable headers).
**`musl-overlay/include/GLES2/gl2.h`, `gl2platform.h`, `gl2ext.h`** — same.
**`musl-overlay/include/GLES3/gl3.h`, `gl3platform.h`** — same.
**`musl-overlay/include/KHR/khrplatform.h`** — same.

Headers are zero of *our* lines: ~3000 lines of upstream Khronos files vendored into the overlay, the same way `linux/fb.h` was vendored for fbdev.

### `sysroot-overlay/lib/libEGL.a` — ~250 LoC

Built from `glue/libegl_stub.c`. v1 implements 8 functions, enough for the demo:

```c
EGLDisplay eglGetDisplay(EGLNativeDisplayType native);
EGLBoolean eglInitialize(EGLDisplay, EGLint *major, EGLint *minor);
EGLBoolean eglTerminate(EGLDisplay);
EGLBoolean eglChooseConfig(EGLDisplay, const EGLint *attrs, EGLConfig *cfgs, EGLint, EGLint *);
EGLContext eglCreateContext(EGLDisplay, EGLConfig, EGLContext share, const EGLint *attrs);
EGLSurface eglCreatePbufferSurface(EGLDisplay, EGLConfig, const EGLint *);
EGLBoolean eglMakeCurrent(EGLDisplay, EGLSurface draw, EGLSurface read, EGLContext);
EGLBoolean eglSwapBuffers(EGLDisplay, EGLSurface);
```

Plus stubs returning `EGL_BAD_ALLOC` / `EGL_BAD_NATIVE_WINDOW` for the rest of the EGL surface that v1 doesn't route (`eglCreateWindowSurface(non-null)`, `eglCreatePixmapSurface`, `eglWaitGL`, etc.). `eglGetError`, `eglQueryString`, `eglGetProcAddress`, `eglDestroyContext`, `eglDestroySurface` round it out — all small.

The stub holds a single global `struct egl_state { int fd; bool initialized; EGLContext cur_ctx; EGLSurface cur_sfc; EGLint last_error; }`. `eglGetDisplay(EGL_DEFAULT_DISPLAY)` is the trigger that opens `/dev/dri/renderD128`. `eglGetProcAddress` returns the GLES2/3 entry point addresses from libGLESv2 (null for ops the stub doesn't implement, so demos that probe for extensions get a clean answer).

### `sysroot-overlay/lib/libGLESv2.a` — ~550 LoC

Built from `glue/libglesv2_stub.c`. Two parts:

**1. The cmdbuf encoder helper (~80 LoC).** A single `gl_emit(opcode, fmt, ...)` collapses every async GL function into one or two lines:

```c
// glue/libglesv2_stub.c
static uint8_t *cursor;          // current write position in the cmdbuf
static uint8_t *cmdbuf_base;     // start of the mmap'd region
static int      egl_fd = -1;     // set when EGL initializes

static void gl_emit(uint16_t op, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    uint16_t len = compute_payload_len(fmt, ap);
    if (cursor + 4 + len > cmdbuf_base + CMDBUF_LEN) gles_flush();
    write_u16_le(cursor, op);  cursor += 2;
    write_u16_le(cursor, len); cursor += 2;
    va_start(ap, fmt);
    for (const char *p = fmt; *p; p++) {
        switch (*p) {
            case 'u': write_u32_le(cursor, va_arg(ap, uint32_t)); cursor += 4; break;
            case 'i': write_i32_le(cursor, va_arg(ap, int32_t));  cursor += 4; break;
            case 'f': write_f32_le(cursor, va_arg(ap, double));   cursor += 4; break;
            case 'b': {  // pointer + length: variable-length blob
                const void *p = va_arg(ap, const void *);
                size_t n = va_arg(ap, size_t);
                write_u32_le(cursor, (uint32_t)n); cursor += 4;
                memcpy(cursor, p, n); cursor += n;
            } break;
        }
    }
    va_end(ap);
}

static void gles_flush(void) {
    struct gl_submit_info si = {
        .offset = 0,
        .length = (uint32_t)(cursor - cmdbuf_base),
    };
    ioctl(egl_fd, GLIO_SUBMIT, &si);
    cursor = cmdbuf_base;
}
```

**2. ~80 GL entry points (~370 LoC).** With the helper, each async GL function is a single line:

```c
void glClear(GLbitfield mask)                  { gl_emit(OP_CLEAR,       "u",    mask); }
void glClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a)
                                               { gl_emit(OP_CLEAR_COLOR, "ffff", r, g, b, a); }
void glViewport(GLint x, GLint y, GLsizei w, GLsizei h)
                                               { gl_emit(OP_VIEWPORT,    "iiii", x, y, w, h); }
void glDrawArrays(GLenum mode, GLint first, GLsizei count)
                                               { gl_emit(OP_DRAW_ARRAYS, "uii",  mode, first, count); }
void glBufferData(GLenum tgt, GLsizeiptr size, const void *data, GLenum usage)
                                               { gl_emit(OP_BUFFER_DATA, "ubu",  tgt, data, (size_t)size, usage); }
void glShaderSource(GLuint shader, GLsizei count, const GLchar *const *strings, const GLint *lengths) {
    /* concat the strings inline, then one emit */
    /* ~10 LoC, the bulkiest async case */
}
```

That's ~370 LoC for ~80 ops once you average across the easy cases (1 line) and the few variable-length ones (`glShaderSource`, `glBufferData` already shown, `glTexImage2D` similar).

**3. Sync queries (~100 LoC).** ~11 functions that need a return value. Each is ~10-20 LoC: build a `gl_query_info`, flush the pending cmdbuf so prior state lands first, `ioctl(GLIO_QUERY)`, decode the out buffer:

```c
GLenum glGetError(void) {
    gles_flush();
    uint8_t out[4]; struct gl_query_info qi = { .op = QOP_GET_ERROR, .out = out, .out_len = 4 };
    ioctl(egl_fd, GLIO_QUERY, &qi);
    return read_u32_le(out);
}

GLint glGetUniformLocation(GLuint program, const GLchar *name) {
    gles_flush();
    uint8_t in[256]; size_t in_len = encode_get_uniform_loc(in, program, name);
    int32_t loc;     struct gl_query_info qi = { .op = QOP_GET_UNIFORM_LOC,
                                                  .in = in, .in_len = in_len,
                                                  .out = (uint8_t*)&loc, .out_len = 4 };
    ioctl(egl_fd, GLIO_QUERY, &qi);
    return loc;
}
```

Same shape for `glGetIntegerv`, `glGetString`, `glGetAttribLocation`, `glGetShaderiv`, `glGetShaderInfoLog`, `glGetProgramiv`, `glGetProgramInfoLog`, `glCheckFramebufferStatus`, `glReadPixels`. ~11 funcs × ~10-20 LoC = ~150 LoC.

### Why no generator in v1

A YAML schema + Python codegen for the ops table is mechanically nice but adds: (a) a build-time dependency, (b) one more file format to learn during review, (c) a generated artefact that obscures what's actually in tree. With `gl_emit()` doing the heavy lifting, hand-writing 80 one-liners is faster to author *and* faster to review than authoring the generator. Defer until the second port adds 30+ ops or until the manual TS-side opcode mirror starts drifting (see §9).

### Object naming policy

- `glCreateShader` / `glCreateProgram` return host-allocated ids (sync round-trip, low-frequency).
- `glGenBuffers` / `glGenTextures` / `glGenFramebuffers` / `glGenRenderbuffers` / `glGenVertexArrays` allocate client-side from a per-process atomic counter. The Gen op is appended so the host pre-creates WebGL objects on the next submit. Saves a round-trip per `glGen*`.
- `glGetUniformLocation` is sync (returns `GLint`); host allocates the location int. Stub caches `(program, name) → loc` to avoid re-querying.

### Linking

- For v1: programs pass `-lEGL -lGLESv2 -lm` explicitly, like Linux.
- v1.5 polish: `wasm32posix-cc` learns to auto-link libEGL + libGLESv2 when the program's includes reference them (same way it auto-links `channel_syscall.c`).

### Final size table

| File | LoC | Hand-written? |
|---|---|---|
| `musl-overlay/include/{EGL,GLES2,GLES3,KHR}/*.h` | ~3000 | No (Khronos, vendored) |
| `glue/libegl_stub.c` | ~250 | Yes |
| `glue/libglesv2_stub.c` | ~550 | Yes |
| `crates/shared/src/gl.rs` (opcode + query enums) | ~100 | Yes (mirrored to TS by hand in v1) |
| `host/src/webgl/ops.ts` | ~100 | Yes |
| **Total NEW C** | **~800** | |

Same order of magnitude as the fbdev addition (582 LoC `syscalls.rs` + 90 LoC fb.h + 51 LoC fbtest.c).

## §6. Demo program port

**Phase 1 — `programs/gltri.c`** (in-tree, ~120 LoC):

```c
// Open device, init EGL, create context + pbuffer surface, make current.
// Compile a trivial vertex/fragment shader pair (vec4 position, vec3 colour).
// Upload three vertices forming a triangle.
// Loop: glClear; glUseProgram; glDrawArrays(GL_TRIANGLES, 0, 3); eglSwapBuffers.
// Sleep + repeat 600 frames, then exit.
```

This is the "fbtest" of WebGL — proves the stack end-to-end without an upstream port. Built into `host/wasm/gltri.wasm` and used by the integration test.

**Phase 2 — `examples/libs/es2gears/build-es2gears.sh`**:

`es2gears` lives in [Mesa demos](https://gitlab.freedesktop.org/mesa/demos/-/tree/main/src/egl/opengles2). Pure C, single file (`es2gears.c`, ~600 LoC), one Makefile. Cross-compile with `wasm32posix-cc -lEGL -lGLESv2 -lm`.

Expected gotchas, in order of likelihood:

- **`eglGetPlatformDisplay` vs `eglGetDisplay`**: newer es2gears uses the platform variant. Stub both; the platform variant ignores the platform tag in v1.
- **`<GL/gl.h>` includes by accident**: some demos pull in desktop headers. Patch out (it's hygiene, not a platform gap).
- **Window-system code (`x11_eglgears` etc.)**: pick the variant that uses `EGL_DEFAULT_DISPLAY` + a pbuffer surface, not the X11 variant.
- **`gettimeofday` for FPS**: already implemented.
- **fork-instrument**: every wasm goes through it as the last step.

**Phase 3 (post-v1) — a real ported app.** Candidates roughly in order:

- **glmark2-es2** — a real benchmark. Tests our coverage of state changes, state management, batched draws.
- **An SDL2 + GLES2 demo** — proves SDL's video subsystem works on our EGL. Lots of GLES2 software is SDL-based.
- **GZDoom or PrBoom+ with GLES2 backend** — the "DOOM-tier" demo for GL. Stretch.

**Demo page** `examples/browser/pages/gldemo/`:

```
index.html    <canvas tabindex=0 width=400 height=400> + start button
main.ts       wires:
              1. kernel boot
              2. attachGlCanvas(canvas, kernel.gl, pid)
              3. spawn gltri.wasm (or es2gears.wasm)
              4. (optional) keyboard listener → appendStdinData
```

Total surface: one HTML page, one TS file ~60 lines.

## §7. Testing strategy

Three layers, scoped to what each catches.

**Cargo unit tests** (`crates/kernel/src/devfs.rs`, `ofd.rs`, `syscalls.rs`):

- `/dev/dri/renderD128` resolves via `match_devfs_*`, stats as `S_IFCHR` major 226 minor 128. `/dev/dri` directory is listable.
- `open` returns an fd; second open from a different pid returns `EBUSY`; reopen by same pid is allowed; close releases ownership.
- `GLIO_INIT` then `GLIO_CREATE_CONTEXT` allocates a ctx_id and calls `gl_create_context` with the right args (mock `HostIO` records them).
- `GLIO_CREATE_SURFACE` similar; `GLIO_MAKE_CURRENT` stitches them.
- `mmap(fd, CMDBUF_LEN, ...)` records `CmdbufBinding`, mock host receives one `gl_bind`.
- `mmap` before `INIT` → `EINVAL`. `mmap` with wrong len → `EINVAL`. Second mmap → `EINVAL`.
- `ioctl(GLIO_SUBMIT, &si)` calls `gl_submit(pid, off, len)` with the right values; bumps `submit_seq`.
- `ioctl(GLIO_QUERY, &qi)` round-trips an arbitrary input and out buffer.
- `munmap` of cmdbuf → `gl_unbind`; process exit → `gl_unbind` + `gl_destroy_context` + `gl_destroy_surface`; `execve` same.
- `fork` does not auto-bind the child to the GL device.
- Unknown ioctl → `ENOTTY`.

**Vitest integration test** (`host/test/webgl-bridge.test.ts`):

Run `gltri.wasm` via `centralizedTestHelper` against a "recording" host bridge that decodes the cmdbuf into a JSON-friendly op list but does not call any real WebGL. Assert the recorded sequence:

- Begins with `GenBuffers(1, [name=1])`, `BindBuffer(GL_ARRAY_BUFFER, 1)`, `BufferData(...)`.
- Includes `CreateShader(GL_VERTEX_SHADER) → 1`, `ShaderSource(1, …)`, `CompileShader(1)`.
- Each frame contains exactly: `Clear`, `UseProgram`, `EnableVertexAttribArray(0)`, `VertexAttribPointer(0, …)`, `DrawArrays(GL_TRIANGLES, 0, 3)`, then a SUBMIT + PRESENT pair.
- Process exit triggers one `gl_unbind`.

Plus a smaller test that opens the device twice across two pids and asserts the second `open` fails `EBUSY`, and a test for cmdbuf overflow auto-flush (write 2 MiB of trivial ops; assert two SUBMITs).

If `headless-gl` is installed, run the same `gltri.wasm` against the real bridge and `gl.readPixels` the centre of the surface — expect the triangle's colour, not the clear colour.

**Manual browser verification** (the actual gldemo):

1. Triangle renders within ~1s of clicking Start.
2. Three coloured `es2gears` rotate at the demo's natural rate.
3. FPS counter on stdout shows ≥30 fps in Chrome on a 2024 MacBook.
4. Resize: the canvas re-renders crisply (because WebGL, not bitmap blits).
5. Open DevTools → Console: zero errors.

No Playwright pixel test for `es2gears` (rotation makes it brittle); the in-tree `gltri.wasm` Vitest is the structural guard.

**Full project test gauntlet** per CLAUDE.md (all five suites + ABI snapshot must pass with zero regressions):

1. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
2. `cd host && npx vitest run`
3. `scripts/run-libc-tests.sh`
4. `scripts/run-posix-tests.sh`
5. `scripts/run-sortix-tests.sh --all`
6. `bash scripts/check-abi-version.sh`

## §8. ABI & rollout

**ABI surface added**:

- New ioctl numbers `GLIO_*` — switch arms in `sys_ioctl`, not snapshot-visible by themselves but pinned in `crates/shared/src/gl.rs` constants.
- New `repr(C)` structs `GlSubmitInfo`, `GlContextAttrs`, `GlSurfaceAttrs`, `GlQueryInfo` — *snapshot-visible*.
- New `HostIO` host imports `host_gl_bind / host_gl_unbind / host_gl_create_context / host_gl_destroy_context / host_gl_create_surface / host_gl_destroy_surface / host_gl_make_current / host_gl_submit / host_gl_present / host_gl_query` — host-imported, snapshot-visible.
- New constant `CMDBUF_LEN` (1 MiB).
- New constant `OP_VERSION` (the GLES op-table version) so a future op-table change is detectable independently of overall ABI.
- No new syscall numbers, no channel header changes, no asyncify slot changes, no new exported `kernel_*` functions.

**Procedure**:

1. Implement kernel + host work.
2. `bash scripts/check-abi-version.sh update` and inspect `git diff abi/snapshot.json`.
3. The snapshot will grow the new structs + host imports → bump `ABI_VERSION` 6 → 7, commit both files together.

**Rollout sequencing**: three independently-reviewable PRs, *opened as work progresses* but **held — none merged — until the browser demo runs end-to-end and the user confirms**. Manual browser verification of `es2gears` is the validation gate for the whole stack.

1. **PR #1 — Kernel GL device + ioctls + cmdbuf binding + tests.** devfs entry, ofd variant, ioctls, cmdbuf mmap, unit tests. Host glue dead-stubbed in `host/src/kernel.ts`.
2. **PR #2 — Host registry + cmdbuf decoder + Vitest with `gltri.wasm` (recording bridge).** `GlContextRegistry`, decoder, Node-side recording bridge, integration test. Headless-gl optional.
3. **PR #3 — Browser canvas + sysroot stubs + es2gears demo.** `attachGlCanvas`, `libegl_stub.c`, `libglesv2_stub.c`, generator script, `es2gears` build script, demo page, manual browser verification.

After demo confirms, merge in order #1 → #2 → #3.

**Doc updates** per CLAUDE.md:

- `docs/posix-status.md` — add `/dev/dri/renderD128` row.
- `docs/architecture.md` — new "GL render device" section.
- `docs/browser-support.md` — capabilities entry + gldemo link.
- `docs/sdk-guide.md` — note `-lEGL -lGLESv2` linkage and the EGL header set.
- `docs/porting-guide.md` — short subsection on porting GLES2 software.
- `README.md` — `es2gears` in the "ported software" table; new GL demo screenshot.

## §9. What could be improved next (post-v1 roadmap)

Not v1 work; capturing now so reviewers see the cliff edges and so v2 doesn't have to re-derive context.

- **Multiple contexts per process.** v1 hard-fails on a second `eglCreateContext`. Real software (notably any toolkit that uses worker contexts) needs N. Per-context state save/restore on `eglMakeCurrent`. Per-pid handle map already shaped for it; add a `Map<ctx_id, ContextState>`.
- **Shared contexts.** Resource sharing across contexts (`eglCreateContext(share=...)`). Common in Qt/SDL multi-window apps. Requires a per-share-group handle table.
- **Multiple processes holding the GL device.** Drop `GL_DEVICE_OWNER`. Each process gets its own canvas binding; the demo page can choose which process to attach. Touches the host-side registry and the worker→main protocol.
- **WebGPU backend.** WebGL 2 is in maintenance; WebGPU is the future and the only path to compute shaders / multi-threaded GPU access. A WebGPU backend behind the same cmdbuf decoder unlocks GLES 3.1 / 3.2 surface (compute, SSBOs, image load-store) by translating to WGSL + WebGPU pipelines — like Mesa's zink, but targeting WebGPU instead of Vulkan.
- **Compute shaders.** Requires WebGPU (above). Real ML / GPGPU demos become possible.
- **`EGL_KHR_image` + `/dev/fb0` interop.** Import an fb0 mapping as a GL texture; sample it; render-to-texture back into fb0. Lets DOOM-style fb0 software get GL effects without giving up its rendering loop.
- **DMA-BUF.** Mostly relevant if we ever support multiple processes sharing a GPU resource; depends on `EGL_KHR_image`.
- **Fence sync (`EGL_KHR_fence_sync`, `glFenceSync` / `glClientWaitSync`).** Unblocks correctness for double-buffered or pipelined GL software. The `gl_present` callback is already routed for it.
- **Asynchronous queries** (`GL_ANY_SAMPLES_PASSED`, timer queries). Sync queries today; async would need a host→kernel completion callback that wakes a waiting program.
- **Persisted shader cache.** Today shaders compile every run. A binary cache keyed by `(GL_RENDERER, source-hash)` persisted via OPFS or IndexedDB would cut load time on heavy apps. Out of scope until profiling shows it matters.
- **GLX / Xlib backend.** Vast pool of legacy GL software is X11-only. Either implement a minimal X server in the kernel (huge) or vendor an xcb-stub-on-EGL shim that re-targets X11 GL calls to our EGL (smaller). Either way, large.
- **KMS / `/dev/dri/card0`.** Separate effort. Software that does mode-setting (`kmscube`, `weston`, anything assuming it owns the display) needs a real card node. Likely a `card0` that hands out a single fixed CRTC over a fixed connector.
- **OpenGL (desktop, not ES).** Some software wants `libGL.so` and core profile 3.3+. Can be approximated with a libGL stub that translates desktop GL → GLES + WebGL extensions, but the impedance mismatch is real (legacy fixed-function pipeline, etc.). Probably easier to vendor [Regal](https://github.com/p3/regal) or similar.
- **GLES op coverage.** v1 covers the ~80 ops `es2gears` + a margin uses. Each new ported app may add 10-30. Tracked via a "ops used by demo X" list in the test.
- **Schema-driven stub generator.** v1 hand-writes the libGLESv2 entry points using a `gl_emit(op, fmt, ...)` helper, plus a hand-mirrored opcode list in TS (§5). Once the second port adds 30+ ops, or once the manual TS↔C opcode mirror starts drifting in review, introduce `scripts/gen-libglesv2-stub.py` (~150 LoC) reading a YAML schema (`crates/shared/src/gl_ops.yaml`) and emitting both `glue/libglesv2_stub.c` *and* `host/src/webgl/ops.ts` from one source of truth. Bumps `OP_VERSION` so a future op-table change is detectable independently of overall ABI. Don't build it speculatively — wait for the manual approach to actually start hurting.
- **Better cmdbuf encoding.** TLV is simple but verbose. A real GPU driver would use a packed binary protocol with delta-encoding for state. Profile first — likely irrelevant until throughput matters.
- **Multi-threaded GL programs.** Programs calling GL from multiple threads will race on the cmdbuf cursor. Either lock the stub (slow) or require thread-local cmdbufs (more state). Defer until something actually needs it.
- **Browser compatibility shim for non-OffscreenCanvas browsers.** Today the design assumes OffscreenCanvas. Older Safari versions don't have it; we'd fall back to main-thread rendering (already designed but adds protocol complexity). Decide based on browser-support table.
- **Proper EGL error reporting.** v1 returns `EGL_SUCCESS` or one error class per call site. Real software inspects `eglGetError()` after every call. Add a per-process "last EGL error" slot.
