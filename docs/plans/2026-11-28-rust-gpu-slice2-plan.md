# Rust GPU slice 2: userspace driver skeleton — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A C program that uses only the Khronos EGL 1.5 and GLES 2.0 headers links a Rust `libkandelo_gl.a`, creates a pbuffer and an ES2 context, clears, reads the pixels back and swaps, in Firefox, WebKit and Chromium, over slice 1's kgpu path.

**Architecture:** A new no_std Rust crate, `crates/kandelo-gl`, is built as one wasm32 static library that defines both the EGL and the GLES2 entry points. It models EGL and GL state in process, encodes `kgpu-stream` records into a heap command buffer, and calls `kandelo.kgpu.v1` only to create contexts, submit and wait. The command stream gains sized surfaces (stream version 2). The executor and the WebGL 2 backend hold surfaces as named per-context objects instead of a fixed 4x4 surface per context.

**Tech stack:** Rust nightly no_std + alloc (`sdk/rust/wasm32-unknown-kandelo.json`, `-Z build-std=core,alloc,compiler_builtins`), `crates/kgpu-stream`, `crates/gpu-executor`, TypeScript GPU worker (`host/src/kgpu`), Playwright.

**Spec:** `docs/plans/2026-11-27-rust-gpu-driver-design.md` (approved). Slice 1's plan and ledger, `docs/plans/2026-11-27-rust-gpu-slice1-plan.md` and `.superpowers/sdd/2026-11-27-rust-gpu-slice1-plan/progress.md` (rulings R1–R22), describe the foundation this builds on.

**Scope decisions for this slice (made by the controller under the maintainer's speed authorization, 2026-11-28):**

- **Surfaceless and pbuffer only.** The design lists "EGL on GBM, Wayland and surfaceless; clear and swap" for slice 2. Window swap on GBM and Wayland needs a present path and a buffer tier the kgpu executor does not have. Today `libgbm` and `libwayland-egl` hand EGL old-stack GPU-tier BOs (`libc/glue/gbm_window.h`, `libc/glue/wayland-native.h`). Changing them now would change the live old stack. GBM and Wayland platforms move to slice 5 (presentation). Here, `eglSwapBuffers` on a pbuffer has no effect and returns `EGL_TRUE`, as EGL 1.5 §3.10.1 requires.
- **One archive, not yet in the sysroot.** The library builds as `local-binaries/libkandelo_gl.a` and is linked only by the slice's test programs. `sysroot/lib/libEGL.a` and `libGLESv2.a` (old stack) stay untouched until slice 8, which decides how `-lEGL`/`-lGLESv2` and `egl.pc`/`glesv2.pc` reach the new archive. This avoids a world rebuild during slices 2–7. It also avoids two Rust archives, with duplicate `core`/`alloc`, in one program.
- **wasm32 only (maintainer decision, 2026-11-28: an initial limitation).** kgpu needs a memory group, and groups are memory32 only; there is no wasm64 Kandelo Rust target either. No package that builds for wasm64 uses GL today; only the old stack's own wasm64 archives and the wasm64 variants of its host tests do. Document it as a known limitation. At the switch (slice 8) the wasm64 GL archives and those test variants go away with the old stack, so a wasm64 GL program fails to link. Lifting the limitation depends on memory groups gaining memory64.
- **Only implemented entry points are defined.** Programs that call a GL or EGL function this slice does not define fail to link, which is truthful. A defined function that receives a valid enum the skeleton does not model yet writes `kandelo-gl: <function> <enum hex> not implemented` to stderr and calls `abort()`. It never answers a made-up value.
- **No sharing yet.** `eglCreateContext` with a `share_context` other than `EGL_NO_CONTEXT` fails with `EGL_BAD_MATCH`. A surface's storage lives in the kgpu context it was first made current with. Making it current with a different context fails with `EGL_BAD_MATCH`, and the driver writes a diagnostic naming the limitation. Slice 3 (share groups) or slice 5 (surfaces as kernel BOs) removes this.

## Global constraints

- **Clean room.** Never read or port `host/src/webgl/**`, `libc/glue/libglesv2_stub.c`, `libc/glue/libegl_stub.c`, `libc/glue/gl_abi.h`, or the architecture doc's description of their internals. `libc/glue/libwayland-egl.c` includes `gl_abi.h`; don't follow that include. Permitted sources: the Khronos EGL 1.5 and OpenGL ES 2.0.25 specifications, the WebGL 2 specification, the headers in `libc/musl-overlay/include/{EGL,GLES2,KHR}`, and Mesa as a design reference.
- **No coexistence machinery.** Add no flag or shim that selects between stacks. No package and no sysroot file changes to use the new library in this slice.
- **Never wait unless the GPU must answer.** `glGet*`, `glGetError`, `glGetString`, `eglQuery*`, `eglGetConfigAttrib`, `glViewport`, `glClearColor` and `glClear` make no kgpu call. The only calls that may wait are `glReadPixels`, `glFinish` and `eglInitialize`'s device probe. `glFlush`, and `eglSwapBuffers` on a pbuffer, submit without waiting.
- **Loud driver defects.** An unexpected kgpu error is never swallowed. Unexpected means anything other than `-EIO` (context lost), `-ENODEV` and `-EOPNOTSUPP` at init, or `-EAGAIN` (already retried by the host). The driver writes `kandelo-gl: <call> failed: <errno>` to stderr and marks the context lost.
- **ABI.** The base ABI-56 program digest must not change (`scripts/check-abi-version.sh`). The stream format carries its own version: `KGPU_STREAM_VERSION` becomes 2. If `abi/snapshot.json` changes because generated kgpu headers change, bump `HOST_ADAPTER_VERSION` only, and regenerate through `cargo xtask dump-abi`.
- **Rust-first.** Validation and state live in Rust (`kandelo-gl`, `gpu-executor`). The TypeScript backend performs WebGL calls only.
- **Repository rules.** Use `scripts/dev-shell.sh` for every build and test. Run one vitest or Playwright run at a time. Never use `git stash`, `git reset --hard` or `git checkout -- <path>`. Stage explicit paths. Commit titles use `Area: Purpose`, and commit bodies wrap at 72 columns. Host target triple: `aarch64-apple-darwin`. Do not run world builds, `prepare-browser`, `setup --all` or the whole host suite.

## Review focus

1. **GL calls with no current context.** They must do nothing and return a zero or empty value (`glGetError` returns `GL_NO_ERROR`, `glGetString` returns NULL), never crash. Pinned in Task 4.
2. **Two threads, two contexts.** Current context and EGL error are per thread. One thread's GL errors and state never show in the other. Pinned in Task 3 (EGL) and Task 4 (GL).
3. **Bad `glReadPixels` arguments:**
   - negative width or height → `GL_INVALID_VALUE`;
   - a format/type other than RGBA/UNSIGNED_BYTE or the implementation read pair → `GL_INVALID_OPERATION`;
   - a zero-area read → no submit;
   - a NULL pointer with nonzero area → `GL_INVALID_VALUE` (a Kandelo choice: GLES gives no defined behavior, and the driver must not hand the kernel address 0).

   None of these submits. Pinned in Task 4.
4. **Destroying a current surface or context.** Deletion is deferred until it is no longer current anywhere (EGL 1.5 §3.7.3, §3.5.6). Making a surface current on a second thread while it's current on the first → `EGL_BAD_ACCESS`. Pinned in Task 3.
5. **GPU loss mid-program.** `-EIO` from a wait marks the context lost and writes one diagnostic line:
   - `eglSwapBuffers` and `eglMakeCurrent` then fail with `EGL_CONTEXT_LOST`;
   - later GL calls do nothing;
   - nothing hangs.

   Pinned in Task 4 (native fake) and Task 5 (Node host with the worker killed).

---

### Task 1: Sized surfaces in the stream, executor and WebGL 2 backend

**Files:**
- Modify:
  - `crates/kgpu-stream/src/lib.rs`
  - `crates/gpu-executor/src/{lib.rs,backend.rs,tests.rs}` and the executor's import shell module
  - `host/src/kgpu/webgl2-backend.ts`, `host/src/kgpu/gpu-worker.ts`
  - the R7 WebGL 2 test double under `host/test/support/`
  - `programs/kgpu-clear.c`
  - the generator `tools/xtask/src/dump_abi.rs`, plus regenerated `libc/musl-overlay/include/kandelo/kgpu_stream.h`, `host/src/generated/abi.ts` and `abi/snapshot.json`
- Test:
  - `crates/kgpu-stream` unit tests
  - `crates/gpu-executor/src/tests.rs`
  - `host/test/kgpu-host.test.ts`
  - `apps/browser-demos/test/kgpu-clear.spec.ts` (unchanged assertions)

**Interfaces:**
- Produces, in `kgpu-stream`:
  - `KGPU_STREAM_VERSION = 2`.
  - New ops: `SurfaceCreate = 5 { surface: u32, width: u32, height: u32 }`, `SurfaceDestroy = 6 { surface: u32 }`, `SurfaceBind = 7 { surface: u32 }`. `surface == 0` in Bind means "no draw surface"; 0 is never a valid name to create.
  - `MAX_SURFACE_DIM: u32 = 4096`.
  - Encoder methods `surface_create(surface, w, h)`, `surface_destroy(surface)` and `surface_bind(surface)`. The `Command` enum gains matching variants.
- Produces, in the executor `Backend` trait (replacing slice 1's `create_surface(context, w, h)` / `destroy_surface(context)`):

```rust
fn create_surface(&mut self, context: u32, surface: u32, width: u32, height: u32) -> Result<(), i32>;
fn destroy_surface(&mut self, context: u32, surface: u32);
fn bind_surface(&mut self, context: u32, surface: u32); // 0 = none
fn destroy_context(&mut self, context: u32);            // releases all its surfaces
```

- Executor rules. Each violation faults the submitting context; the read-once and isolation rules are unchanged.
  - Context create allocates no surface.
  - `SurfaceCreate` with a name already live in the context, 0, or a dimension of 0 or above `MAX_SURFACE_DIM` faults.
  - `SurfaceDestroy` or `SurfaceBind` of an unknown name faults. Destroying the bound surface leaves no surface bound.
  - `Clear` or `ReadPixels` with no surface bound faults.
  - A context may hold at most 64 surfaces (`MAX_SURFACES_PER_CONTEXT = 64` in `gpu-executor`).

- [ ] **Step 1: Write failing tests.**
  - `kgpu-stream`: `surface_ops_round_trip` (encode, then decode, gives equal `Command`s) and `rejects_version_1_stream`.
  - Executor (recording backend):
    - `surface_create_bind_clear_read`
    - `clear_without_bound_surface_faults`
    - `duplicate_surface_name_faults`
    - `surface_dim_above_max_faults`
    - `surface_zero_name_faults`
    - `destroy_bound_surface_unbinds`
    - `destroy_context_releases_surfaces` (the backend records `destroy_context` once)
    - `sixty_fifth_surface_faults`
- [ ] **Step 2: Run them; confirm they fail.**
  - `scripts/dev-shell.sh cargo test -p kgpu-stream -p kandelo-gpu-executor --target aarch64-apple-darwin`
- [ ] **Step 3: Implement** the ops, the executor surface table per context and the trait change. In `webgl2-backend.ts`, each surface is a framebuffer with an RGBA8 renderbuffer of its size, keyed by `(context, surface)`, and `bind_surface` binds that framebuffer. Update the test double the same way.
  - Update `programs/kgpu-clear.c` to emit `SurfaceCreate(1, 4, 4)` and `SurfaceBind(1)` before its viewport. Its output must not change.
  - Rebuild the executor (`crates/gpu-executor/build-wasm.sh`) and the kernel only if the kernel validates stream versions (check `crates/runtime-core/src/dri/kgpu`).
  - Regenerate the ABI outputs.
- [ ] **Step 4: Run the tests and confirm they pass.**
  - Rust: the cargo command above.
  - `cd host && npx vitest run test/kgpu-host.test.ts test/kgpu-boundary.test.ts test/kgpu-host-lifecycle.test.ts`
  - `scripts/dev-shell.sh bash scripts/build-programs.sh`, then `cd apps/browser-demos && npx playwright test test/kgpu-clear.spec.ts --project=chromium` (one engine here; Task 5 runs all three).
  - `scripts/dev-shell.sh bash scripts/check-abi-version.sh` must pass with the program digest unchanged.
- [ ] **Step 5: Commit** `GPU: Give kgpu contexts sized, named surfaces`.

### Task 2: The `kandelo-gl` crate and toolchain proof

**Files:**
- Create:
  - `crates/kandelo-gl/Cargo.toml`: lib `kandelo_gl`, `crate-type = ["staticlib", "rlib"]`, depends on `kgpu-stream`. Add it to the root workspace members.
  - `crates/kandelo-gl/src/lib.rs`: `#![no_std]` outside tests, `extern crate alloc`.
  - `crates/kandelo-gl/src/{sys.rs,kgpu.rs}`
  - `crates/kandelo-gl/build-wasm.sh`
  - `programs/kgpu-gl-link.c`
- Modify: `scripts/build-programs.sh` (one case arm), `.gitignore` only if `local-binaries/` isn't already ignored.
- Test: `host/test/kgpu-gl-link.test.ts`

**Interfaces:**
- Produces, in `sys.rs`:
  - The global allocator over musl `malloc`, `free`, `realloc` and `aligned_alloc` (precedent `programs/rust/alloc-demo/src/lib.rs`).
  - A `#[panic_handler]` that writes `kandelo-gl: panic: <message>` with `write(2, …)`, then calls `abort()`.
  - `fn diag(args: core::fmt::Arguments)` writes one stderr line.
- Produces, in `kgpu.rs`:

```rust
pub trait Device {               // the one seam between driver and kernel
    fn context_create(&mut self) -> Result<u32, i32>;          // negative errno on Err
    fn context_destroy(&mut self, context: u32) -> Result<(), i32>;
    fn submit(&mut self, context: u32, stream: &[u8], buffers: &[Buffer]) -> Result<u64, i32>;
    fn wait(&mut self, context: u32, seqno: u64, timeout_ns: i64) -> Result<(), i32>;
}
pub struct Buffer { pub addr: u64, pub len: u32, pub access: u32 }
pub struct KgpuDevice;           // wasm32: calls the import below; others: unimplemented
#[cfg(any(test, feature = "fake"))]
pub struct FakeDevice { /* records every call; decodes streams with kgpu-stream;
                          scripted results; `calls() -> usize` counts kgpu trips */ }
```

  The import is `#[link(wasm_import_module = "kandelo.kgpu.v1")] extern "C" { fn __kandelo_kgpu_v1(arg: *mut u8, size: i32, op: i32) -> i32; }`, matching `libc/musl-overlay/include/kandelo/kgpu.h:22-23`. The argument structs mirror that header (sizes 8, 8, 40, 16 and 24). Pin them with const asserts.
- Produces: `crates/kandelo-gl/build-wasm.sh` builds with `--target sdk/rust/wasm32-unknown-kandelo.json -Z build-std=core,alloc,compiler_builtins --release`, with `panic=abort`, and copies the archive to `local-binaries/libkandelo_gl.a`. It refuses to run outside `scripts/dev-shell.sh` the way `crates/gpu-executor/build-wasm.sh` does.
- Produces: the exported C symbol `eglGetError` returning `EGL_SUCCESS` (0x3000). It is the only API in this task; Task 3 replaces it with the real per-thread error.

- [ ] **Step 1: Write the failing test** `host/test/kgpu-gl-link.test.ts`.
  - It builds `programs/kgpu-gl-link.c`, which calls `eglGetError()`, prints `egl error 0x3000` and exits 0. Build with `compileSdkFixture` or the `build-programs.sh` output, whichever `kgpu-host.test.ts` uses.
  - It converts the program with `sdk/bin/wasm32posix-shared-memory`, runs it grouped on the Node host, and asserts exit 0 and that output line.
  - A second case asserts that the fork-instrumented, group-converted module validates and that its imports include only `env.memory`, the normal host imports and `kandelo.kgpu.v1.__kandelo_kgpu_v1`.
- [ ] **Step 2: Run it; confirm it fails** (archive missing).
- [ ] **Step 3: Implement** the crate, the build script and a `build-programs.sh` case arm.
  - The arm builds `kgpu-gl-*.c` and `kgpu-egl-*.c` against `-I` overlay headers plus `local-binaries/libkandelo_gl.a`. It must **not** append `sysroot/lib/libEGL.a` or `libGLESv2.a`, so make the auto-append at `scripts/build-programs.sh:256-262` skip these programs.
  - If wasm-ld reports duplicate `compiler_builtins` symbols against compiler-rt, or feature mismatches, fix that in the crate's build flags. Never add `-Wl,--allow-multiple-definition`. If no fix exists, stop and report.
- [ ] **Step 4: Run** `scripts/dev-shell.sh bash crates/kandelo-gl/build-wasm.sh`, then `scripts/dev-shell.sh bash scripts/build-programs.sh`, then the test. Expected: PASS. Also run `scripts/dev-shell.sh cargo test -p kandelo-gl --target aarch64-apple-darwin`; it must compile.
- [ ] **Step 5: Commit** `GPU: Build the kandelo-gl driver as a guest static library`. Record the archive size (bytes) in the commit body.

### Task 3: EGL 1.5 model (surfaceless platform, pbuffers)

**Files:**
- Create: `crates/kandelo-gl/src/egl/{mod.rs,display.rs,config.rs,surface.rs,context.rs,thread.rs,entry.rs}`
- Test: `crates/kandelo-gl/src/egl/tests.rs`

**Interfaces:**
- Consumes: `Device`, `FakeDevice`, `diag` (Task 2). Task 4 consumes the `Context` handle and `thread::current()`.
- Produces: exported `extern "C"` entry points with exact Khronos signatures, from `libc/musl-overlay/include/EGL/egl.h`:
  - `eglGetError`, `eglGetDisplay`, `eglGetPlatformDisplay`
  - `eglInitialize`, `eglTerminate`, `eglQueryString`
  - `eglGetConfigs`, `eglChooseConfig`, `eglGetConfigAttrib`
  - `eglCreatePbufferSurface`, `eglDestroySurface`, `eglQuerySurface`
  - `eglBindAPI`, `eglQueryAPI`
  - `eglCreateContext`, `eglDestroyContext`, `eglMakeCurrent`
  - `eglGetCurrentContext`, `eglGetCurrentSurface`, `eglGetCurrentDisplay`, `eglQueryContext`
  - `eglSwapBuffers`, `eglSwapInterval`, `eglWaitClient`, `eglReleaseThread`, `eglGetProcAddress`

  Each one is a thin `extern "C"` wrapper over a safe Rust function that takes `&mut impl Device`, so the tests drive the same code with `FakeDevice`.
- Produces: `thread::current() -> Option<(DisplayRef, ContextRef)>` and `ContextRef::kgpu_context() -> u32`, plus the global driver lock (`spin::Mutex`-style over `core::sync::atomic`). Per-thread state (current context, EGL error, bound API) uses `#[thread_local]`.
- Values the model must return:
  - Displays: `EGL_DEFAULT_DISPLAY` and `eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA = 0x31DD, EGL_DEFAULT_DISPLAY, NULL)` return the same single display. Any other platform → `EGL_BAD_PARAMETER`.
  - `eglInitialize` reports major 1, minor 5. It probes the device by creating and destroying one kgpu context. `-ENODEV` or `-EOPNOTSUPP` → `EGL_NOT_INITIALIZED`; any other error → diagnostic plus `EGL_NOT_INITIALIZED`. Initialize is reference-free (a repeat call succeeds), and terminate makes resources invalid once they are not current.
  - `eglQueryString`:
    - `EGL_VENDOR = "Kandelo"`, `EGL_VERSION = "1.5 kandelo-gl"`, `EGL_CLIENT_APIS = "OpenGL_ES"`.
    - `EGL_EXTENSIONS` on the display = `"EGL_KHR_surfaceless_context EGL_KHR_no_config_context"`.
    - With `EGL_NO_DISPLAY` = `"EGL_EXT_client_extensions EGL_EXT_platform_base EGL_KHR_platform_base EGL_MESA_platform_surfaceless"`.
  - Configs: exactly one, ID 1:
    - RGBA 8/8/8/8, buffer size 32, depth 0, stencil 0, samples 0;
    - `EGL_SURFACE_TYPE = EGL_PBUFFER_BIT`, `EGL_RENDERABLE_TYPE = EGL_CONFORMANT = EGL_OPENGL_ES2_BIT`;
    - `EGL_COLOR_BUFFER_TYPE = EGL_RGB_BUFFER`, `EGL_CONFIG_CAVEAT = EGL_NONE`;
    - `EGL_MAX_PBUFFER_WIDTH = EGL_MAX_PBUFFER_HEIGHT = 4096`, `EGL_MAX_PBUFFER_PIXELS = 4096*4096`.

    `eglChooseConfig` follows EGL 1.5 §3.4.1 matching and sorting rules for every attribute in the attribute table.
  - Contexts:
    - `EGL_CONTEXT_CLIENT_VERSION` / `EGL_CONTEXT_MAJOR_VERSION` must be 2. The EGL 1.5 default is 1, and ES1 is unsupported, so an omitted version or any value other than 2 → `EGL_BAD_MATCH`.
    - A `share_context` other than `EGL_NO_CONTEXT` → `EGL_BAD_MATCH`.
    - `eglBindAPI` with anything other than `EGL_OPENGL_ES_API` returns `EGL_FALSE` with `EGL_BAD_PARAMETER`.

    Each EGL context owns one kgpu context, created at `eglCreateContext`.
  - Fork: the driver records `getpid()` at `eglInitialize`. If any EGL entry point sees a different pid, the child did not inherit the kernel's kgpu contexts. The driver then drops all display, context and surface state without issuing kgpu destroys, and continues as if never initialized: the entry point answers as for an uninitialized display. The design doc says an inherited context fails, as on Linux, and the child may initialize anew.
  - Surfaces:
    - pbuffer width and height in 1..=4096 (`EGL_BAD_PARAMETER` otherwise);
    - `EGL_LARGEST_PBUFFER` is accepted, with sizes clamped to the maximum;
    - texture attributes other than `EGL_NO_TEXTURE` → `EGL_BAD_MATCH`.

    The surface gets a driver-chosen nonzero name. Its executor storage is created lazily, the first time it is made current: `SurfaceCreate` and `SurfaceBind` are queued into that context's command buffer, which Task 4 provides. Until Task 4 lands, use a local `Vec<u8>` encoder.
  - `eglMakeCurrent`:
    - draw must equal read (`EGL_BAD_MATCH` otherwise, a documented skeleton limit);
    - `EGL_NO_SURFACE` with a context is allowed (surfaceless);
    - a surface current on another thread → `EGL_BAD_ACCESS`;
    - a surface bound to another kgpu context → `EGL_BAD_MATCH` plus diagnostic;
    - a context lost → `EGL_CONTEXT_LOST`.

    On first binding of a context to a surface, it sets the GL viewport to the surface size (Task 4 owns the GL state, so expose a hook `on_first_bind(width, height)`).
  - `eglSwapBuffers` on a pbuffer → submit pending work without waiting, return `EGL_TRUE`. On no surface → `EGL_BAD_SURFACE`.
  - `eglSwapInterval` stores the clamped value (min 0, max 1).
  - `eglGetProcAddress` returns the address of any EGL or GL function this crate exports, and NULL otherwise.

- [ ] **Step 1: Write failing tests** (all against `FakeDevice`):
  - `initialize_reports_1_5`
  - `initialize_without_renderer_is_not_initialized` (fake returns -19)
  - `query_strings_exact`
  - `one_config_with_exact_attribs`
  - `choose_config_rejects_depth_request` (asking `EGL_DEPTH_SIZE 1` yields 0 configs)
  - `es1_and_es3_contexts_bad_match`
  - `share_context_bad_match`
  - `pbuffer_bounds`
  - `make_current_surfaceless_ok`
  - `surface_current_on_two_threads_bad_access` (std threads in tests)
  - `per_thread_error_isolated`
  - `destroy_current_surface_deferred` (storage destroy is queued only after release)
  - `surface_with_second_context_bad_match`
  - `swap_pbuffer_submits_without_wait` (fake shows submit, no wait)
  - `get_proc_address_known_and_unknown`
  - `pid_change_drops_state_without_destroys` (inject the pid through a test hook; the fake records no `context_destroy`)
  - `queries_make_no_device_calls` (`FakeDevice::calls()` unchanged across `eglQueryString`, `eglGetConfigAttrib`, `eglQuerySurface`, `eglQueryContext` and `eglGetError`)
- [ ] **Step 2: Run them; confirm they fail.** `scripts/dev-shell.sh cargo test -p kandelo-gl --target aarch64-apple-darwin egl`
- [ ] **Step 3: Implement.** Handles are opaque nonzero pointers-as-ids (`EGLDisplay` = 1; configs, contexts and surfaces from per-kind counters), never real pointers.
- [ ] **Step 4: Run** the tests (PASS) and `build-wasm.sh` (links).
- [ ] **Step 5: Commit** `GPU: Model EGL 1.5 surfaceless displays, pbuffers and contexts`.

### Task 4: GLES2 skeleton: state, errors, clear, readback

**Files:**
- Create: `crates/kandelo-gl/src/gles/{mod.rs,state.rs,cmdbuf.rs,entry.rs}`
- Test: `crates/kandelo-gl/src/gles/tests.rs`

**Interfaces:**
- Consumes: Task 3's `thread::current()`, `ContextRef` and `on_first_bind`.
- Produces: `CommandBuffer`, one per EGL context, owning a heap `Vec<u8>` stream. It provides:
  - `encoder()`;
  - `flush(dev) -> Result<Option<u64>, i32>`, which submits if non-empty and returns the seqno;
  - `finish(dev)`, which is flush plus wait on the last seqno.

  It auto-flushes before a record would push the stream past `KGPU_MAX_STREAM` (1 MiB).
- Produces exported GLES2 functions with exact signatures from `libc/musl-overlay/include/GLES2/gl2.h`:
  - `glGetError`, `glGetString`, `glGetIntegerv`, `glGetFloatv`, `glGetBooleanv`
  - `glViewport`, `glClearColor`, `glClear`, `glReadPixels`, `glFlush`, `glFinish`
- Modeled values:
  - `glGetString`: `GL_VENDOR = "Kandelo"`, `GL_RENDERER = "kandelo-gl (WebGL 2)"`, `GL_VERSION = "OpenGL ES 2.0 kandelo-gl"`, `GL_SHADING_LANGUAGE_VERSION = "OpenGL ES GLSL ES 1.00"`, `GL_EXTENSIONS = ""`. Any other name → `GL_INVALID_ENUM` and NULL.
  - Modeled `glGet*` pnames: `GL_VIEWPORT`, `GL_COLOR_CLEAR_VALUE`, `GL_MAX_VIEWPORT_DIMS` (4096, 4096), `GL_RED_BITS`/`GREEN`/`BLUE`/`ALPHA` (8; 0 with no surface), `GL_DEPTH_BITS` and `GL_STENCIL_BITS` (0), `GL_IMPLEMENTATION_COLOR_READ_FORMAT` (`GL_RGBA`), `GL_IMPLEMENTATION_COLOR_READ_TYPE` (`GL_UNSIGNED_BYTE`).
  - Other valid GLES2 pnames → `diag` "not implemented" plus `abort()`. Invalid pnames → `GL_INVALID_ENUM`.
  - Conversions between integer, float and boolean queries follow GLES 2.0.25 §6.1.2. Clear-color floats map to integers by the color rule.
- Behavior:
  - Errors are per context; the first error sticks until `glGetError` reads it.
  - `glViewport` with negative w/h → `GL_INVALID_VALUE`, and is clamped to `GL_MAX_VIEWPORT_DIMS`.
  - `glClearColor` clamps to [0,1].
  - `glClear` with bits outside `COLOR|DEPTH|STENCIL` → `GL_INVALID_VALUE`.
  - `glClear` with no surface bound (surfaceless) → `GL_INVALID_FRAMEBUFFER_OPERATION` and nothing encoded.
  - Viewport, clear color and clear are encoded only when a surface is bound. Redundant state isn't re-encoded.
  - `glReadPixels`: validation as in Review focus 3, then encode `ReadPixels` with buffer index 0 = `{addr: pixels, len: w*h*4, access: WRITE}`, flush and wait.
  - Wait results:
    - `-EIO` → context lost, one diagnostic, and pixels are left untouched;
    - `-ETIMEDOUT` cannot occur (infinite timeout) and would be a defect.
  - No current context: every function is a no-op returning 0, NULL or `GL_NO_ERROR`.

- [ ] **Step 1: Write failing tests** (FakeDevice):
  - `clear_and_read_encodes_exact_stream` (decoded commands equal `[SurfaceCreate(n,16,8), SurfaceBind(n), Viewport(0,0,16,8), ClearColor(0.2,0.4,0.6,1.0), Clear(0x4000), ReadPixels(0,0,16,8,0)]`, with buffer 0 of len 512 WRITE)
  - `get_calls_make_no_device_calls`
  - `viewport_defaults_to_surface_size`
  - `first_error_sticks`
  - `clear_surfaceless_invalid_framebuffer_operation`
  - `clear_bad_mask_invalid_value`
  - `read_pixels_negative_invalid_value`
  - `read_pixels_bad_format_invalid_operation`
  - `read_pixels_zero_area_no_submit`
  - `read_pixels_null_invalid_value`
  - `no_current_context_is_noop`
  - `two_threads_errors_isolated`
  - `eio_wait_loses_context` (after it: `eglSwapBuffers` false with `EGL_CONTEXT_LOST`, `glClear` encodes nothing, exactly one diagnostic)
  - `stream_auto_flushes_before_1mib`
  - `unmodeled_valid_pname_aborts` (run in a subprocess or via `#[should_panic]` on the test build's abort hook)
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `scripts/dev-shell.sh cargo test -p kandelo-gl --target aarch64-apple-darwin` (PASS) and `build-wasm.sh` (links).
- [ ] **Step 5: Commit** `GPU: Model the GLES2 clear and readback skeleton`.

### Task 5: End to end on Node and three browsers, plus docs

**Files:**
- Create:
  - `programs/kgpu-egl-clear.c`: only `<EGL/egl.h>` and `<GLES2/gl2.h>`. It:
    - gets the display through `eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, …)`;
    - initializes, chooses a pbuffer ES2 config, and creates a 16x8 pbuffer and an ES2 context;
    - makes them current, clears to 0.2/0.4/0.6/1.0, reads 16x8 RGBA into a 0xee-filled buffer, and swaps;
    - prints `pixel <i> r g b a` for pixels 0, 63 and 127, and `egl ok`;
    - on failure prints `kgpu-egl-clear: <call> failed: 0x<egl error>` and exits 1.
  - `programs/kgpu-egl-fork.c`: initializes and makes current, then forks.
    - The child calls `eglTerminate`, then repeats the whole sequence from `eglInitialize` and must read 51 102 153 255.
    - The parent waits and also reads back correctly.
    - Prints `child ok` and `parent ok`.
  - `apps/browser-demos/test/kgpu-egl-clear.spec.ts`, modeled on `kgpu-clear.spec.ts`.
- Modify:
  - `host/test/kgpu-host.test.ts`: add cases.
  - `docs/architecture.md`, "Kernel GPU execution (kgpu)": add a "Userspace driver (slice 2)" subsection, update the surface description, and list the known gaps from the scope decisions above.
  - `docs/plans/2026-11-27-rust-gpu-driver-design.md`, Delivery slices: note that GBM and Wayland moved to slice 5, and why.

- [ ] **Step 1: Write the failing tests.**
  - Node, with the kgpu WebGL 2 test double as renderer:
    - `egl_clear_reads_back` (pixels 51 102 153 255, `egl ok`)
    - `egl_fork_child_reinitializes`
  - Node, with no renderer: `egl_without_renderer_reports_not_initialized` (output `kgpu-egl-clear: eglInitialize failed: 0x3001`, exit 1).
  - Node: `egl_worker_crash_loses_context`. Terminate the GPU worker while the program is parked in `glReadPixels`. Expect a `kandelo-gl:` diagnostic and `eglSwapBuffers failed: 0x300e`, and the process exits.
  - Browser spec, on each engine: `egl_clear_reads_back`, plus the post-exit pin invariant of 20 runs, as in `kgpu-clear.spec.ts`.
- [ ] **Step 2: Build and run; confirm they fail.**
  - `build-wasm.sh`, then `build-programs.sh`, then the Node tests.
  - Then `npx playwright test test/kgpu-egl-clear.spec.ts --project=firefox`.
- [ ] **Step 3: Fix failures at their owning layer.**
- [ ] **Step 4: Run the final slice validation, and record exactly what ran.**
  - `scripts/dev-shell.sh cargo test -p kandelo-gl -p kgpu-stream -p kandelo-gpu-executor -p runtime-core --target aarch64-apple-darwin`
  - `cd host && npx vitest run test/kgpu-*.test.ts`
  - Both specs (`kgpu-clear`, `kgpu-egl-clear`) on Firefox, WebKit and Chromium, in that order, one run at a time.
  - `scripts/dev-shell.sh bash scripts/check-abi-version.sh`.
- [ ] **Step 5: Commit** `GPU: Prove EGL and GLES2 clear end to end on kandelo-gl`.
