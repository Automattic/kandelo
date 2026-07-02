# WebGL / GLES2 (`/dev/dri/renderD128`) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Expose WebGL 2 to wasm processes through a Linux DRM render-node — `/dev/dri/renderD128`, single-owner, `S_IFCHR` major 226 minor 128. Programs follow the standard Linux flow: `open` the device → `eglGetDisplay` / `eglInitialize` / `eglCreateContext` / `eglCreatePbufferSurface` / `eglMakeCurrent` (each a `GLIO_*` ioctl) → `mmap` an ~1 MiB command buffer from the device fd. A small hand-written `libEGL.a` + `libGLESv2.a` in the sysroot append TLV entries (`{u16 op, u16 len, payload}`) to the cmdbuf via a single `gl_emit(op, fmt, ...)` helper; `eglSwapBuffers` is `ioctl(GLIO_SUBMIT)` + `ioctl(GLIO_PRESENT)`. Sync GL calls (`glGetError`, `glReadPixels`, `glGetUniformLocation`, etc.) bypass the cmdbuf via `ioctl(GLIO_QUERY)`. Host decodes the cmdbuf and dispatches against a real `WebGL2RenderingContext` (browser, OffscreenCanvas in the kernel worker) or a recording fake (Node tests). An unmodified `es2gears` build runs in `examples/browser/pages/gldemo/` and is visible on a `<canvas>`.

**Architecture:** Pixels never go through the kernel. The cmdbuf lives inside the process's wasm `Memory` SAB (same machinery as fbdev's mmap). On `mmap` of `/dev/dri/renderD128`, the kernel allocates an anonymous region in process memory and calls `HostIO::gl_bind(pid, addr, len)`. The libGLESv2 stub appends TLV entries; `eglSwapBuffers` issues `ioctl(GLIO_SUBMIT, &si{offset,length})` which calls `HostIO::gl_submit(pid, off, len)`. Host reads `[addr+off, addr+off+len)` from the cached process Memory SAB, decodes TLVs, and dispatches each op against a `WebGL2RenderingContext` owned by `GlContextRegistry`. Companion design doc: `docs/plans/2026-04-28-webgl-gles2-design.md`.

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser + Node), C user programs cross-compiled with `wasm32posix-cc`, hand-written `libEGL.a` + `libGLESv2.a` (~800 LoC total) in the sysroot, Khronos headers (`EGL/`, `GLES2/`, `GLES3/`, `KHR/`) vendored unmodified, `es2gears` from [Mesa demos](https://gitlab.freedesktop.org/mesa/demos/-/tree/main/src/egl/opengles2) plus its `eglut` harness (`src/egl/eglut/eglut.c` + `wsi/wsi.c`) and `src/util/matrix.c`, all byte-for-byte upstream. We author one new file — `wsi/wpk.c` (~80 LoC, Task C5b) — following the same shape as the upstream `wsi/x11.c` and `wsi/wayland.c` backends.

**Validation status (2026-04-28):** A throwaway OffscreenCanvas + cmdbuf spike was run before this plan was written. With 40,000 ops/frame in a recording-bridge worker, the dispatch loop sustained avg 0.70 ms / peak 1.20 ms / 1430 fps / 57.21 Mops/s — i.e. ~4% of the 60fps frame budget at 4× the design's target ops/frame. WebGL 2 inside a Web Worker via `OffscreenCanvas` is confirmed working in at least the user's default browser; cross-browser (Firefox / Safari) verification is part of Phase C, Task C8. Numbers above are not load-bearing for the plan, but they are the reason the cmdbuf design moves forward instead of being rethought.

**Three PRs, single coordinated merge.** Each task below is committed as a single commit. Three PR boundaries are marked. **None merge** until Phase C's manual browser verification passes and the user explicitly confirms — see `framebuffer-fbdoom-initiative.md` in memory for the precedent.

PR base / head topology (stacked, per the user's branching rule — every step branches off the previous):

```
main
 └── explore-webgl-exposition-design        (design RFC; PR #1 in mho22 fork)
      └── explore-webgl-exposition-plan     (this plan; PR in mho22 fork — base = design RFC)
           └── explore-webgl-exposition-kernel  (PR #1: base = explore-webgl-exposition-plan)
                └── explore-webgl-exposition-host    (PR #2: base = explore-webgl-exposition-kernel)
                     └── explore-webgl-exposition-demo  (PR #3: base = explore-webgl-exposition-host)
```

PR titles (mirror Brandon's `scope(area): action (#N)` shape):

1. `kernel(gles): /dev/dri/renderD128 device + EGL/GL ioctls + cmdbuf mmap`
2. `host(gles): GlContextRegistry + cmdbuf decoder + Vitest with gltri.wasm`
3. `examples(gldemo): es2gears + browser GLES2 demo`

**Verification gauntlet** (CLAUDE.md): all of the below must pass with zero regressions before any PR is opened, and re-run before the final merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a regression.

**ABI impact:** Expect `ABI_VERSION` 6 → 7 in Task A9. New `repr(C)` structs (`GlSubmitInfo`, `GlContextAttrs`, `GlSurfaceAttrs`, `GlQueryInfo`), new `host_gl_*` host imports, new `OP_VERSION` constant for the GLES op-table independently of overall ABI.

---

## Pre-implementation review (2026-04-28)

Before kernel work began, a devil's-advocate pass cross-referenced the plan against the actual `es2gears` source and Mesa's `eglut` harness, and audited the cmdbuf format against es2gears's per-op data sizes. Findings, applied to this plan in the same commit:

1. **`es2gears.c` does not call EGL directly** — it uses Mesa's `eglut` harness (`src/egl/eglut/eglut.c`), which has WSI backends (`wsi/x11.c`, `wsi/wayland.c`). The original Task C6 build script compiled only `es2gears.c` and would have failed to link. Resolution:
   - **New Task C5b** authors `wsi/wpk.c` (~80 LoC, follows the same shape as the existing X11 / Wayland backends, sets `_eglut->surface_type = EGL_WINDOW_BIT` and `win->native.u.window = (EGLNativeWindowType)EGL_WPK_SURFACE_DEFAULT`). This is *the* idiomatic way eglut is extended to a new platform — it is **not** a platform-gap patch, and `es2gears.c` + `eglut.c` top-level remain byte-for-byte upstream.
   - **Task C6 build script** rewritten to compile `es2gears.c` + `eglut.c` + `wsi/wsi.c` + `wsi/wpk.c` + `src/util/matrix.c`.
   - **Task C6 Step 3 "gotchas"** dropped the misleading "switch to pbuffer if non-X variant" suggestion (eglut is the right layer).

2. **GL surface-coverage audit** — `nm`-equivalent on `es2gears.c` produced 24 distinct `gl*` entry points. Cross-checked against the plan's `OP_*` table:
   - 23 of 24 covered.
   - **Missing: `glUniform4fv`** (array form). The plan had `OP_UNIFORM4F` (scalar 4-arg) but es2gears uses `glUniform4fv(LightSourcePosition_location, 1, LightSourcePosition)`. Without this op the gears would render unlit (lighting uniform never sets). Resolution: **`OP_UNIFORM4FV: u16 = 0x0406` added to Task A1's `gl` module + opcode-uniqueness test.**

3. **`eglBindAPI` missing from libEGL stub** — `eglut.c:140` calls it before `eglCreateContext`. Resolution: stub added to Task C2's listing (no-op returning `EGL_TRUE`).

4. **Cmdbuf u16 envelope cap is fine for v1, becomes a wall in v2** — the TLV layout is `{u16 op, u16 payload_len, payload}`, capping any single op at 65 535 bytes. Largest es2gears op (`glBufferData` for the 20-tooth gear) = 958 vertices × 24 bytes = **~23 KB**, comfortably under the cap. No textures. **For es2gears v1 this is fine.** For any v2 demo with textures > 64 KB (which is most of them — a 256×256 RGBA texture is 256 KB), `OP_TEX_IMAGE_2D` would not fit. Recorded as an explicit v1 constraint in "Trade-offs already locked in" + risk register; v2 widens the envelope to `u32` (which is itself an ABI break, future plan responsibility).

5. **`OP_VERSION` vs. `ABI_VERSION` divergence rule is implicit but coherent** — opcode-set additions (no struct shape change) bump `OP_VERSION` only; struct layout / syscall number / channel / asyncify changes bump `ABI_VERSION`. This is what risk-register row 2 already does. No edit needed; flagged here so reviewers don't re-litigate.

6. **GLES 2 vs WebGL 2 / GLES 3 mix is intentional** — `libGLESv2.a` ships both ES 2 and ES 3 entry points (mirrors how Linux does it: one `libGLESv2.so` covers both). Programs select via `EGL_CONTEXT_CLIENT_VERSION`. The opcode table mixes families on purpose; that is correct.

These findings are recorded so a fresh session can pick up the current plan as-of, without re-deriving the audit.

---

## Second pre-implementation review (2026-04-28, audit redo)

A second devil's-advocate pass focused on the gaps the first pass left open: kernel-side ioctl validation, the libGLESv2 cmdbuf-encoder, the eglut WSI contract checked against the actual upstream sources (`/tmp/mesa-demos-check/src/egl/eglut/wsi/wsi.{h,c}`), and process-level concerns that had been hand-waved (single-threaded GL, OP_VERSION runtime check, B5 phase ordering). Findings, applied in the same commit:

7. **`Task C5b`'s WSI skeleton omits the actual eglut backend contract.** The first pass committed to "follows the same shape as `wsi/x11.c`" without enumerating the contract. Reading `wsi/wsi.h` shows backends export a single `<backend>_wsi_interface()` returning a `struct eglut_wsi_interface` of function pointers; `wsi/wsi.c`'s `_eglutGetWindowSystemInterface()` dispatches via `#if defined(WAYLAND_SUPPORT) ... #elif defined(X11_SUPPORT)` with **no `#else` fallback** — and Mesa upstream has no `WPK_SUPPORT` branch. The original §C5b skeleton only defined five `static` functions that nothing references; it would link-fail at Task C6's link step. Resolution:
   - §C5b rewritten to export `struct eglut_wsi_interface wpk_wsi_interface(void)` populating the function-pointer struct.
   - §C5b adds a one-line patch to `wsi/wsi.c` adding `#elif defined(WPK_SUPPORT) return wpk_wsi_interface();`. This is *cross-compilation hygiene* (the same shape Mesa already uses for X11/Wayland) — not a platform-gap workaround. The build defines `-DWPK_SUPPORT` instead of `-DX11_SUPPORT` / `-DWAYLAND_SUPPORT`.
   - §C5b's "Reference: what eglut expects from a backend" snippet replaced — the `_eglutNative*` wrappers live in `wsi/wsi.c`, not in backends.

8. **`GLIO_QUERY` allocates `vec![0u8; qi.out_buf_len]` with no upper bound** — a wasm process can pass `qi.out_buf_len = 0xFFFFFFFE` and OOM the kernel worker. Resolution:
   - Task A1 declares `MAX_QUERY_OUT_LEN: u32 = 64 * 1024` (chosen to fit the largest realistic sync-query output: shader info logs, framebuffer status, glReadPixels of a 64×64 thumbnail = 16 KB).
   - Task A6 `GLIO_QUERY` handler rejects `qi.out_buf_len > MAX_QUERY_OUT_LEN` with `EINVAL` *before* allocating.

9. **`gl_emit` truncates payload length to u16 silently.** The risk-register row "Single op > 64 KB" promised an `assert(len <= UINT16_MAX)` in the libGLESv2 stub, but Task C3's listing didn't include it. Without the guard, a large `glBufferData` payload silently corrupts the cmdbuf and the host mis-decodes everything after. Resolution: Task C3 Step 2 adds an explicit overflow check in `gl_emit` that aborts the process with a stderr diagnostic rather than truncating.

10. **`OP_VERSION` runtime check was promised in A1's doc-comment but no task implemented it.** Without an actual exchange, an OP_VERSION drift (different libGLESv2 stub vs running kernel) is silent. Resolution:
    - Task A6 `GLIO_INIT` handler now reads a 4-byte `op_version` argument from `buf[0..4]` and rejects mismatches with `ENOSYS`.
    - Task C2 `eglInitialize` passes `OP_VERSION` (from `glue/gl_abi.h`) as the ioctl argument.
    - Task A1's GLIO_INIT documentation updated to reflect the new arg.

11. **`Task C3`'s `glBufferSubData` example is broken** — format `"iibb"` is missing `target`, the two `b` markers consume only one (ptr,len) pair (the literal `NULL, 0`). Even with the "real impl: use a custom payload writer" comment, the example would copy verbatim. Resolution: Task C3 Step 3 replaces the broken example with a working `gl_emit(OP_BUFFER_SUB_DATA, "uib", target, off, data, size)` that matches Task B3's decoder layout.

12. **Uniform-location indexing collides after deletes.** Task B3's `runGlQuery` uses `idx = b.uniformLocations.size + 1` — after insert+delete, `size` decreases and the next insert collides. Plus the Map is keyed by string (`\`${idx}\``) but the cmdbuf returns it as int — `Map<string, ...>` and `Map<number, ...>` lookups don't interoperate. Resolution:
    - Task B1 `GlBinding` adds a `nextUniformLoc: number` monotonic counter and changes `uniformLocations: Map<number, WebGLUniformLocation>` (number-keyed).
    - Task B3 `runGlQuery` uses `++b.nextUniformLoc` and stores under the integer key.

13. **`GLIO_PRESENT` lacks the `state.current` guard that `GLIO_SUBMIT` has** — a process could call PRESENT before MAKE_CURRENT and the host would receive an unbound dispatch. Resolution: Task A6's `GLIO_PRESENT` arm now mirrors `GLIO_SUBMIT`'s `if !state.current { return Err(EINVAL); }` check.

14. **Single-threaded GL was hand-waved.** Task C3's `static uint8_t *g_cursor` is process-global; two threads in one wasm process calling GL race on it. Documented now as a Trade-off bullet: v1 promises GL is single-threaded per-process; if two threads call GL concurrently, the cmdbuf appends race and the result is undefined. v2 will either lock the cursor (simple, slow) or use per-thread cmdbufs (complex, fast). The libGLESv2 stub does **not** assert single-threaded use in v1 — that would require pulling `pthread_self()` into the GL hot path.

15. **B5's test layer crosses the PR-#2 boundary** — `gltri.wasm` only exists after Phase C, so PR #2's gauntlet ships the cmdbuf decoder with synthetic-only TLV tests. The existing inline note at the bottom of B5 mentioned this but didn't elevate it. Resolution: added as a Trade-off bullet ("PR #2 ships with synthetic-only decoder tests") and to PR #2's description checklist so reviewers know the integration test only lights up after PR #3 lands.

(Findings 7–15 are this commit's contribution; 1–6 are from the first review pass.)

---

## Phase A — Kernel GL render-node surface (PR #1)

### Task A1: Shared ABI constants & structs (`shared::gl`)

**Files:**
- Modify: `crates/shared/src/lib.rs` — add `gl` module near other ABI types (mirror `mqueue` / `socket` / `fbdev` placement).

**Step 1: Add the constants and structs**

Append to `crates/shared/src/lib.rs`:

```rust
/// GLES / EGL ABI: ioctl numbers, opcode enum, query enum, and marshalled
/// argument structs for `/dev/dri/renderD128`.
///
/// These are part of the kernel↔user-space ABI: any change requires bumping
/// `ABI_VERSION` (see crate root) and updating `abi/snapshot.json`.
pub mod gl {
    /// Cmdbuf mmap length (1 MiB). Single fixed size in v1; see
    /// the design doc §3 "Cmdbuf overflow".
    pub const CMDBUF_LEN: usize = 1 << 20;

    /// Version of the GLES op-table. Bumped independently of `ABI_VERSION`
    /// when the cmdbuf opcode set changes; the libGLESv2 stub records this
    /// at compile time and the host refuses to decode a mismatched cmdbuf.
    pub const OP_VERSION: u32 = 1;

    // --- ioctl request numbers (DRM 'D' magic, starting at 0x40) -----------

    // GLIO_INIT takes a pointer to a `u32` carrying the client's compile-time
    // `OP_VERSION`. The kernel rejects mismatches with `ENOSYS` so a process
    // built against an older op-table can't talk to a newer kernel (and vice
    // versa) without the divergence being caught at first contact rather than
    // surfacing later as a silent decode error. See A6's GLIO_INIT handler.
    pub const GLIO_INIT:            u32 = 0x40;
    pub const GLIO_TERMINATE:       u32 = 0x41;
    pub const GLIO_CREATE_CONTEXT:  u32 = 0x42;
    pub const GLIO_DESTROY_CONTEXT: u32 = 0x43;
    pub const GLIO_CREATE_SURFACE:  u32 = 0x44;
    pub const GLIO_DESTROY_SURFACE: u32 = 0x45;
    pub const GLIO_MAKE_CURRENT:    u32 = 0x46;
    pub const GLIO_SUBMIT:          u32 = 0x47;
    pub const GLIO_PRESENT:         u32 = 0x48;
    pub const GLIO_QUERY:           u32 = 0x49;

    // --- surface kind tags -------------------------------------------------

    pub const WPK_SURFACE_DEFAULT: u32 = 1;   // "the bound canvas"
    pub const WPK_SURFACE_PBUFFER: u32 = 2;   // off-screen pbuffer

    /// Upper bound on `GlQueryInfo.out_buf_len`. The kernel allocates a
    /// scratch buffer of this size before forwarding the query to the
    /// host; capping prevents a malicious wasm process from passing
    /// `0xFFFFFFFE` and OOMing the kernel worker.
    ///
    /// 64 KiB comfortably fits every realistic sync-query output: shader
    /// info logs (typically ~1 KB), program info logs, `glGetString`
    /// results, framebuffer-completeness, and `glReadPixels` of a 64×64
    /// RGBA thumbnail (16 KB). Demos that need to read back a full
    /// framebuffer should do it in tiles.
    pub const MAX_QUERY_OUT_LEN: u32 = 64 * 1024;

    // --- cmdbuf opcodes (see host/src/webgl/ops.ts for the TS mirror) ------
    //
    // Layout: TLV `{u16 op, u16 payload_len, payload[payload_len]}` little-
    // endian. Payload formats are documented inline next to the libGLESv2
    // stub call sites in glue/libglesv2_stub.c.

    pub const OP_CLEAR:                       u16 = 0x0001;
    pub const OP_CLEAR_COLOR:                 u16 = 0x0002;
    pub const OP_VIEWPORT:                    u16 = 0x0003;
    pub const OP_SCISSOR:                     u16 = 0x0004;
    pub const OP_ENABLE:                      u16 = 0x0005;
    pub const OP_DISABLE:                     u16 = 0x0006;
    pub const OP_BLEND_FUNC:                  u16 = 0x0007;
    pub const OP_DEPTH_FUNC:                  u16 = 0x0008;
    pub const OP_CULL_FACE:                   u16 = 0x0009;
    pub const OP_FRONT_FACE:                  u16 = 0x000A;
    pub const OP_LINE_WIDTH:                  u16 = 0x000B;
    pub const OP_PIXEL_STOREI:                u16 = 0x000C;

    pub const OP_GEN_BUFFERS:                 u16 = 0x0100;
    pub const OP_DELETE_BUFFERS:              u16 = 0x0101;
    pub const OP_BIND_BUFFER:                 u16 = 0x0102;
    pub const OP_BUFFER_DATA:                 u16 = 0x0103;
    pub const OP_BUFFER_SUB_DATA:             u16 = 0x0104;

    pub const OP_GEN_TEXTURES:                u16 = 0x0200;
    pub const OP_DELETE_TEXTURES:             u16 = 0x0201;
    pub const OP_BIND_TEXTURE:                u16 = 0x0202;
    pub const OP_TEX_IMAGE_2D:                u16 = 0x0203;
    pub const OP_TEX_SUB_IMAGE_2D:            u16 = 0x0204;
    pub const OP_TEX_PARAMETERI:              u16 = 0x0205;
    pub const OP_ACTIVE_TEXTURE:              u16 = 0x0206;
    pub const OP_GENERATE_MIPMAP:             u16 = 0x0207;

    pub const OP_CREATE_SHADER:               u16 = 0x0300;
    pub const OP_SHADER_SOURCE:               u16 = 0x0301;
    pub const OP_COMPILE_SHADER:              u16 = 0x0302;
    pub const OP_DELETE_SHADER:               u16 = 0x0303;
    pub const OP_CREATE_PROGRAM:              u16 = 0x0304;
    pub const OP_ATTACH_SHADER:               u16 = 0x0305;
    pub const OP_LINK_PROGRAM:                u16 = 0x0306;
    pub const OP_USE_PROGRAM:                 u16 = 0x0307;
    pub const OP_BIND_ATTRIB_LOCATION:        u16 = 0x0308;
    pub const OP_DELETE_PROGRAM:              u16 = 0x0309;

    pub const OP_UNIFORM1I:                   u16 = 0x0400;
    pub const OP_UNIFORM1F:                   u16 = 0x0401;
    pub const OP_UNIFORM2F:                   u16 = 0x0402;
    pub const OP_UNIFORM3F:                   u16 = 0x0403;
    pub const OP_UNIFORM4F:                   u16 = 0x0404;
    pub const OP_UNIFORM_MATRIX4FV:           u16 = 0x0405;
    /// `glUniform4fv(location, count, value)` — vector form. es2gears uses
    /// this for the directional light position. `OP_UNIFORM4F` (scalar) is a
    /// different signature; both are needed.
    pub const OP_UNIFORM4FV:                  u16 = 0x0406;

    pub const OP_ENABLE_VERTEX_ATTRIB_ARRAY:  u16 = 0x0500;
    pub const OP_DISABLE_VERTEX_ATTRIB_ARRAY: u16 = 0x0501;
    pub const OP_VERTEX_ATTRIB_POINTER:       u16 = 0x0502;
    pub const OP_DRAW_ARRAYS:                 u16 = 0x0503;
    pub const OP_DRAW_ELEMENTS:               u16 = 0x0504;

    pub const OP_GEN_VERTEX_ARRAYS:           u16 = 0x0600;
    pub const OP_DELETE_VERTEX_ARRAYS:        u16 = 0x0601;
    pub const OP_BIND_VERTEX_ARRAY:           u16 = 0x0602;

    pub const OP_GEN_FRAMEBUFFERS:            u16 = 0x0700;
    pub const OP_BIND_FRAMEBUFFER:            u16 = 0x0701;
    pub const OP_FRAMEBUFFER_TEXTURE_2D:      u16 = 0x0702;
    pub const OP_GEN_RENDERBUFFERS:           u16 = 0x0703;
    pub const OP_BIND_RENDERBUFFER:           u16 = 0x0704;
    pub const OP_RENDERBUFFER_STORAGE:        u16 = 0x0705;
    pub const OP_FRAMEBUFFER_RENDERBUFFER:    u16 = 0x0706;

    // --- sync query op tags (used in GlQueryInfo.op) -----------------------

    pub const QOP_GET_ERROR:             u32 = 0x01;
    pub const QOP_GET_STRING:            u32 = 0x02;
    pub const QOP_GET_INTEGERV:          u32 = 0x03;
    pub const QOP_GET_FLOATV:            u32 = 0x04;
    pub const QOP_GET_UNIFORM_LOC:       u32 = 0x05;
    pub const QOP_GET_ATTRIB_LOC:        u32 = 0x06;
    pub const QOP_GET_SHADERIV:          u32 = 0x07;
    pub const QOP_GET_SHADER_INFO_LOG:   u32 = 0x08;
    pub const QOP_GET_PROGRAMIV:         u32 = 0x09;
    pub const QOP_GET_PROGRAM_INFO_LOG:  u32 = 0x0A;
    pub const QOP_READ_PIXELS:           u32 = 0x0B;
    pub const QOP_CHECK_FB_STATUS:       u32 = 0x0C;

    // --- marshalled ioctl argument structs ---------------------------------

    /// Argument to `GLIO_SUBMIT`. Total: 8 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlSubmitInfo {
        /// Byte offset within the cmdbuf at which to start decoding.
        pub offset: u32,
        /// Number of bytes to decode (must end on a TLV boundary).
        pub length: u32,
    }

    /// Argument to `GLIO_CREATE_CONTEXT`. Total: 16 bytes.
    /// Mirrors a tiny subset of EGL config attrs; v1 only consults
    /// `client_version`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlContextAttrs {
        /// EGL client version (2 → GLES 2, 3 → GLES 3).
        pub client_version: u32,
        /// Reserved for `share_context`, debug bit, robustness bit, etc.
        pub reserved: [u32; 3],
    }

    /// Argument to `GLIO_CREATE_SURFACE`. Total: 32 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlSurfaceAttrs {
        /// `WPK_SURFACE_DEFAULT` or `WPK_SURFACE_PBUFFER`.
        pub kind: u32,
        /// Pbuffer width (default-canvas surfaces ignore this).
        pub width: u32,
        /// Pbuffer height (default-canvas surfaces ignore this).
        pub height: u32,
        /// EGL config id (opaque; v1 reports a single config "1").
        pub config_id: u32,
        /// Reserved.
        pub reserved: [u32; 4],
    }

    /// Argument to `GLIO_QUERY`. Total: 24 bytes.
    /// `in_buf_ptr` / `out_buf_ptr` are wasm-process addresses; the kernel
    /// validates them before forwarding to `HostIO::gl_query`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlQueryInfo {
        /// One of the `QOP_*` tags above.
        pub op: u32,
        /// Process-relative pointer to the input bytes (NUL for ops
        /// that take no input, e.g. `QOP_GET_ERROR`).
        pub in_buf_ptr: u32,
        /// Length of input in bytes.
        pub in_buf_len: u32,
        /// Process-relative pointer to the output buffer.
        pub out_buf_ptr: u32,
        /// Capacity of the output buffer in bytes.
        pub out_buf_len: u32,
        /// Reserved for a future async-completion handle.
        pub reserved: u32,
    }
}
```

**Step 2: Add a static-assert test**

Append to `crates/shared/src/lib.rs` test module:

```rust
#[cfg(test)]
mod gl_tests {
    use super::gl::*;
    use core::mem::size_of;

    #[test]
    fn struct_sizes_match_abi() {
        assert_eq!(size_of::<GlSubmitInfo>(),    8);
        assert_eq!(size_of::<GlContextAttrs>(), 16);
        assert_eq!(size_of::<GlSurfaceAttrs>(), 32);
        assert_eq!(size_of::<GlQueryInfo>(),    24);
    }

    #[test]
    fn cmdbuf_len_is_one_mib() {
        assert_eq!(CMDBUF_LEN, 1024 * 1024);
    }

    #[test]
    fn opcodes_are_unique() {
        // Anti-collision sentinel: if two opcodes are accidentally the
        // same value, this test surfaces it before the host bridge does.
        let ops: &[u16] = &[
            OP_CLEAR, OP_CLEAR_COLOR, OP_VIEWPORT, OP_SCISSOR,
            OP_ENABLE, OP_DISABLE, OP_BLEND_FUNC, OP_DEPTH_FUNC,
            OP_CULL_FACE, OP_FRONT_FACE, OP_LINE_WIDTH, OP_PIXEL_STOREI,
            OP_GEN_BUFFERS, OP_DELETE_BUFFERS, OP_BIND_BUFFER,
            OP_BUFFER_DATA, OP_BUFFER_SUB_DATA,
            OP_GEN_TEXTURES, OP_DELETE_TEXTURES, OP_BIND_TEXTURE,
            OP_TEX_IMAGE_2D, OP_TEX_SUB_IMAGE_2D, OP_TEX_PARAMETERI,
            OP_ACTIVE_TEXTURE, OP_GENERATE_MIPMAP,
            OP_CREATE_SHADER, OP_SHADER_SOURCE, OP_COMPILE_SHADER,
            OP_DELETE_SHADER, OP_CREATE_PROGRAM, OP_ATTACH_SHADER,
            OP_LINK_PROGRAM, OP_USE_PROGRAM, OP_BIND_ATTRIB_LOCATION,
            OP_DELETE_PROGRAM,
            OP_UNIFORM1I, OP_UNIFORM1F, OP_UNIFORM2F, OP_UNIFORM3F,
            OP_UNIFORM4F, OP_UNIFORM4FV, OP_UNIFORM_MATRIX4FV,
            OP_ENABLE_VERTEX_ATTRIB_ARRAY, OP_DISABLE_VERTEX_ATTRIB_ARRAY,
            OP_VERTEX_ATTRIB_POINTER, OP_DRAW_ARRAYS, OP_DRAW_ELEMENTS,
            OP_GEN_VERTEX_ARRAYS, OP_DELETE_VERTEX_ARRAYS, OP_BIND_VERTEX_ARRAY,
            OP_GEN_FRAMEBUFFERS, OP_BIND_FRAMEBUFFER, OP_FRAMEBUFFER_TEXTURE_2D,
            OP_GEN_RENDERBUFFERS, OP_BIND_RENDERBUFFER, OP_RENDERBUFFER_STORAGE,
            OP_FRAMEBUFFER_RENDERBUFFER,
        ];
        let mut sorted = ops.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ops.len(), "duplicate opcode in OP_* table");
    }
}
```

**Step 3: Run the tests**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib gl_tests
```

Expected: 3 tests pass. Layout bugs surface here cheaply.

**Step 4: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(gles): shared ABI module — GLIO/QOP/OP constants + arg structs"
```

---

### Task A2: `VirtualDevice::DriRender0` variant + path matching

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` (`VirtualDevice` enum + `match_virtual_device`, near where `Fb0` was added in fbdev)

**Step 1: Failing tests**

Append to `syscalls.rs` test module:

```rust
#[test]
fn match_virtual_device_recognizes_dri_renderd128() {
    assert_eq!(match_virtual_device(b"/dev/dri/renderD128"),
               Some(VirtualDevice::DriRender0));
    // No card0 (KMS) and no other render nodes in v1.
    assert_eq!(match_virtual_device(b"/dev/dri/card0"),       None);
    assert_eq!(match_virtual_device(b"/dev/dri/renderD129"),  None);
}

#[test]
fn dri_render0_has_unique_host_handle_sentinel() {
    let h = VirtualDevice::DriRender0.to_host_handle();
    assert_eq!(VirtualDevice::from_host_handle(h), Some(VirtualDevice::DriRender0));
    // Distinct from every existing virtual device.
    assert_ne!(h, VirtualDevice::Null.to_host_handle());
    assert_ne!(h, VirtualDevice::Zero.to_host_handle());
    assert_ne!(h, VirtualDevice::Urandom.to_host_handle());
    assert_ne!(h, VirtualDevice::Full.to_host_handle());
    assert_ne!(h, VirtualDevice::Fb0.to_host_handle());
}
```

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib match_virtual_device_recognizes_dri_renderd128
```

Expected: compile error, `DriRender0` unknown.

**Step 3: Implement**

Extend `enum VirtualDevice` with `DriRender0`. Update:

- `to_host_handle`: add `VirtualDevice::DriRender0 => -6,` (next sentinel after Fb0's -5; grep first to confirm).
- `from_host_handle`: add `-6 => Some(VirtualDevice::DriRender0),`.
- `to_minor`: add `VirtualDevice::DriRender0 => 128,` (the Linux render-node minor).
- `match_virtual_device`: add `b"/dev/dri/renderD128" => Some(VirtualDevice::DriRender0),`.

Extend `virtual_device_stat` to return `S_IFCHR` with major **226** (Linux DRM major) and minor **128** for `DriRender0`. Mirror how `Fb0` was wired (major 29, minor 0).

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dri_render0
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs
git commit -m "kernel(gles): VirtualDevice::DriRender0 + /dev/dri/renderD128 path match"
```

---

### Task A3: devfs entry — `/dev/dri/` directory + `renderD128`

**Files:**
- Modify: `crates/kernel/src/devfs.rs`

**Step 1: Failing tests**

Append to `devfs.rs` test module:

```rust
#[test]
fn dev_dri_is_listable_directory() {
    let mut entries = list_devfs(b"/dev/dri").unwrap();
    entries.sort();
    assert_eq!(entries, vec![b"renderD128".to_vec()]);
}

#[test]
fn dev_dri_renderd128_stats_as_chr_226_128() {
    let st = stat_devfs(b"/dev/dri/renderD128").unwrap();
    assert_eq!(st.st_mode & S_IFMT, S_IFCHR);
    assert_eq!(major(st.st_rdev), 226);
    assert_eq!(minor(st.st_rdev), 128);
}
```

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dev_dri
```

**Step 3: Implement**

Extend `pub enum DevfsEntry` with `DriRender0`. In the directory-listing path, register `/dev/dri/` as a synthetic directory containing exactly one entry, `renderD128`, that resolves to `DevfsEntry::DriRender0`. Stat resolution returns `S_IFCHR | 0o660`, major 226, minor 128.

Mirror the structure that `Fb0` uses; the difference is the directory prefix — `/dev/dri/` is itself synthetic, where `/dev/fb0` was a top-level entry.

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dev_dri
```

**Step 5: Commit**

```bash
git add crates/kernel/src/devfs.rs
git commit -m "kernel(gles): devfs /dev/dri/renderD128 (S_IFCHR 226:128) + /dev/dri dir"
```

---

### Task A4: `HostIO` GL trait methods (10 methods)

**Files:**
- Modify: `crates/kernel/src/process.rs` (the `pub trait HostIO`)
- Modify: `crates/kernel/src/wasm_api.rs` (`impl HostIO for WasmHostIO`)
- Modify: `crates/kernel/src/syscalls.rs` (no-op defaults on `MockHostIO`, `TrackingHostIO`, `NetMock`, `SymlinkMock`, `LoopMock`, `RelSymlinkMock` — grep `impl HostIO for` to enumerate)

**Step 1: Add to the trait**

In `crates/kernel/src/process.rs`, append to `pub trait HostIO`:

```rust
    /// Notify the host that process `pid` has mapped its GL cmdbuf at the
    /// given offset within its wasm `Memory`. Length is always
    /// `shared::gl::CMDBUF_LEN` in v1.
    fn gl_bind(&mut self, pid: i32, addr: usize, len: usize);

    /// Notify the host that the GL cmdbuf for `pid` is gone (`munmap`,
    /// process exit, or exec). Idempotent.
    fn gl_unbind(&mut self, pid: i32);

    /// Allocate a host-side WebGL context. `ctx_id` is the per-fd id chosen
    /// by the kernel; `attrs` is a marshalled `GlContextAttrs`.
    fn gl_create_context(&mut self, pid: i32, ctx_id: u32, attrs: &[u8]);
    fn gl_destroy_context(&mut self, pid: i32, ctx_id: u32);

    /// Allocate a host-side surface (default canvas or pbuffer).
    fn gl_create_surface(&mut self, pid: i32, surface_id: u32, attrs: &[u8]);
    fn gl_destroy_surface(&mut self, pid: i32, surface_id: u32);

    /// Bind ctx + surface as the current rendering target for `pid`.
    fn gl_make_current(&mut self, pid: i32, ctx_id: u32, surface_id: u32);

    /// Decode and dispatch one cmdbuf submit. `offset` / `length` are within
    /// the bound cmdbuf region (validated by the kernel against `CMDBUF_LEN`).
    fn gl_submit(&mut self, pid: i32, offset: usize, length: usize);

    /// Flush any pending GL work and signal "frame ready". v1 no-op (canvas
    /// presents on the next RAF); kept as a hook for future fence/sync work.
    fn gl_present(&mut self, pid: i32);

    /// Synchronous GL query (`glGetError`, `glReadPixels`, etc.).
    /// Returns bytes written into `out`, or negative errno on failure.
    fn gl_query(&mut self, pid: i32, op: u32, input: &[u8], out: &mut [u8]) -> i32;
```

**Step 2: No-op defaults on every mock impl**

In `crates/kernel/src/syscalls.rs`, for each `impl HostIO for ...` block (grep `impl HostIO for` — there are six in this file as of fbdev), add:

```rust
fn gl_bind(&mut self, _pid: i32, _addr: usize, _len: usize) {}
fn gl_unbind(&mut self, _pid: i32) {}
fn gl_create_context(&mut self, _pid: i32, _ctx_id: u32, _attrs: &[u8]) {}
fn gl_destroy_context(&mut self, _pid: i32, _ctx_id: u32) {}
fn gl_create_surface(&mut self, _pid: i32, _surface_id: u32, _attrs: &[u8]) {}
fn gl_destroy_surface(&mut self, _pid: i32, _surface_id: u32) {}
fn gl_make_current(&mut self, _pid: i32, _ctx_id: u32, _surface_id: u32) {}
fn gl_submit(&mut self, _pid: i32, _offset: usize, _length: usize) {}
fn gl_present(&mut self, _pid: i32) {}
fn gl_query(&mut self, _pid: i32, _op: u32, _input: &[u8], _out: &mut [u8]) -> i32 { 0 }
```

`TrackingHostIO` records calls in `pub gl_bind_calls: Vec<(i32, usize, usize)>` etc. — mirror what fbdev did with `bind_framebuffer_calls`. We will assert against these in Tasks A6–A8.

**Step 3: Wire `WasmHostIO` to host imports**

In `crates/kernel/src/wasm_api.rs`, declare and forward to ten new `extern "C"` host imports — `host_gl_bind`, `host_gl_unbind`, `host_gl_create_context`, `host_gl_destroy_context`, `host_gl_create_surface`, `host_gl_destroy_surface`, `host_gl_make_current`, `host_gl_submit`, `host_gl_present`, `host_gl_query`. Mirror the `host_bind_framebuffer` pattern. The `attrs` slices need a `(ptr, len)` ABI pair on the wasm side; reuse the `host_*` helper used by other byte-slice-passing imports.

```rust
extern "C" {
    fn host_gl_bind(pid: i32, addr: usize, len: usize);
    fn host_gl_unbind(pid: i32);
    fn host_gl_create_context(pid: i32, ctx_id: u32, attrs_ptr: usize, attrs_len: usize);
    fn host_gl_destroy_context(pid: i32, ctx_id: u32);
    fn host_gl_create_surface(pid: i32, surface_id: u32, attrs_ptr: usize, attrs_len: usize);
    fn host_gl_destroy_surface(pid: i32, surface_id: u32);
    fn host_gl_make_current(pid: i32, ctx_id: u32, surface_id: u32);
    fn host_gl_submit(pid: i32, offset: usize, length: usize);
    fn host_gl_present(pid: i32);
    fn host_gl_query(pid: i32, op: u32,
                     in_ptr: usize, in_len: usize,
                     out_ptr: usize, out_len: usize) -> i32;
}
```

`impl HostIO for WasmHostIO` forwards each call. Until Phase B wires the host TS side, these resolve to host-side stubs that we'll write in Task B2.

**Step 4: Build to confirm trait coherence**

```bash
cargo build -p wasm-posix-kernel --target aarch64-apple-darwin
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib --no-run
```

Expected: clean compile. "trait method not implemented" errors mean a mock impl was missed.

**Step 5: Commit**

```bash
git add crates/kernel/src/process.rs crates/kernel/src/wasm_api.rs crates/kernel/src/syscalls.rs
git commit -m "kernel(gles): HostIO trait — gl_bind / gl_submit / gl_query / etc."
```

---

### Task A5: `OpenFileKind::DriRender(GlState)` + `Process::gl_binding` + `GL_DEVICE_OWNER`

**Files:**
- Modify: `crates/kernel/src/ofd.rs` — add `OpenFileKind::DriRender(GlState)` and the `GlState` / `CmdbufBinding` types.
- Modify: `crates/kernel/src/process.rs` — add `pub gl_binding: Option<GlBinding>`.
- Modify: `crates/kernel/src/process_table.rs` — add `pub static GL_DEVICE_OWNER: AtomicI32 = AtomicI32::new(-1);` next to `FB0_OWNER`.

**Step 1: Failing tests**

Append to `syscalls.rs` test module:

```rust
#[test]
fn open_dri_renderd128_is_single_owner_across_pids() {
    use crate::process_table::GL_DEVICE_OWNER;
    use core::sync::atomic::Ordering;

    let (mut pa, mut host_a) = test_helpers::new_proc_with_pid(11);
    let (mut pb, mut host_b) = test_helpers::new_proc_with_pid(12);

    // pid=11 opens — succeeds, owns the device.
    let _fd = sys_open(&mut pa, &mut host_a, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    assert_eq!(GL_DEVICE_OWNER.load(Ordering::SeqCst), 11);

    // pid=12 attempts — EBUSY.
    let err = sys_open(&mut pb, &mut host_b, b"/dev/dri/renderD128", O_RDWR, 0).unwrap_err();
    assert_eq!(err, Errno::EBUSY);

    // Same pid (11) re-opens — allowed.
    let _fd2 = sys_open(&mut pa, &mut host_a, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
}
```

Reset the owner between tests via `GL_DEVICE_OWNER.store(-1, Ordering::SeqCst)` in the test helper teardown.

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib open_dri_renderd128_is_single_owner_across_pids
```

**Step 3: Implement**

In `crates/kernel/src/ofd.rs`:

```rust
/// Per-fd state for an open `/dev/dri/renderD128` handle.
#[derive(Clone, Debug, Default)]
pub struct GlState {
    /// Set after `GLIO_INIT` succeeded.
    pub initialized: bool,
    /// Allocated by `GLIO_CREATE_CONTEXT`. One per fd in v1.
    pub context_id: Option<u32>,
    /// Allocated by `GLIO_CREATE_SURFACE`.
    pub surface_id: Option<u32>,
    /// Set after `GLIO_MAKE_CURRENT`.
    pub current: bool,
    /// Set when the cmdbuf has been mmap'd.
    pub cmdbuf: Option<CmdbufBinding>,
}

/// Live cmdbuf mapping for a process's GL fd.
#[derive(Clone, Copy, Debug)]
pub struct CmdbufBinding {
    /// Offset within the process's wasm `Memory`.
    pub addr: usize,
    /// Length in bytes (`shared::gl::CMDBUF_LEN`).
    pub len: usize,
    /// Monotonic `GLIO_SUBMIT` counter — used for host-side debug ring
    /// correlation, never read by user space.
    pub submit_seq: u64,
}

pub enum OpenFileKind {
    // ... existing ...
    DriRender(GlState),
}
```

In `process.rs`:

```rust
/// Per-process bookkeeping for a live GL device binding.
#[derive(Clone, Copy, Debug)]
pub struct GlBinding {
    pub cmdbuf_addr: usize,
    pub cmdbuf_len:  usize,
}

// inside struct Process:
pub gl_binding: Option<GlBinding>,
```

Initialize to `None` in every `Process::new` / `Process::fork_from`.

In `process_table.rs`:

```rust
use core::sync::atomic::{AtomicI32, Ordering};
pub static GL_DEVICE_OWNER: AtomicI32 = AtomicI32::new(-1);
```

In `sys_open`'s CharDevice branch, when the path resolves to `VirtualDevice::DriRender0`:

```rust
if dev == VirtualDevice::DriRender0 {
    let pid = proc.pid;
    match GL_DEVICE_OWNER.compare_exchange(-1, pid, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => { /* we own it */ }
        Err(other) if other == pid => { /* re-open by same pid: allow */ }
        Err(_) => return Err(Errno::EBUSY),
    }
    let kind = OpenFileKind::DriRender(GlState::default());
    return Ok(allocate_ofd(proc, kind, /* ... */));
}
```

Drop the owner: in `sys_close` when the closed fd was the *last* OFD reference into a `DriRender` (refcount via existing OFD machinery; mirror PTY ownership cleanup in `pty.rs`), and in process exit / exec (Task A8), CAS pid → -1.

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib open_dri_renderd128
```

**Step 5: Commit**

```bash
git add crates/kernel/src/ofd.rs crates/kernel/src/process.rs \
        crates/kernel/src/process_table.rs crates/kernel/src/syscalls.rs
git commit -m "kernel(gles): single-owner /dev/dri/renderD128 + GlState ofd variant"
```

---

### Task A6: `GLIO_*` ioctl handlers

**Files:**
- Modify: `crates/kernel/src/syscalls.rs::sys_ioctl`

**Step 1: Failing tests**

Append to test module:

```rust
fn open_gl(p: &mut Process, h: &mut impl HostIO) -> i32 {
    sys_open(p, h, b"/dev/dri/renderD128", O_RDWR, 0).unwrap()
}

/// Helper: invoke GLIO_INIT with the matching OP_VERSION.
fn glio_init_ok(p: &mut Process, fd: i32) {
    use wasm_posix_shared::gl::*;
    let mut buf = OP_VERSION.to_le_bytes();
    sys_ioctl(p, fd, GLIO_INIT, &mut buf).unwrap();
}

#[test]
fn glio_init_marks_initialized() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);
    let ofd = p.ofd_for_fd(fd).unwrap();
    let OpenFileKind::DriRender(s) = &ofd.kind else { panic!() };
    assert!(s.initialized);
}

#[test]
fn glio_init_rejects_op_version_mismatch() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    let mut buf = (OP_VERSION + 1).to_le_bytes();
    let err = sys_ioctl(&mut p, fd, GLIO_INIT, &mut buf).unwrap_err();
    assert_eq!(err, Errno::ENOSYS);
}

#[test]
fn glio_create_context_calls_host_with_attrs() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);
    let mut attrs = GlContextAttrs { client_version: 2, reserved: [0; 3] };
    let mut buf = [0u8; 16];
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, attrs); }
    sys_ioctl(&mut p, fd, GLIO_CREATE_CONTEXT, &mut buf).unwrap();
    assert_eq!(h.gl_create_context_calls.len(), 1);
    let (pid, ctx_id, recorded_attrs) = &h.gl_create_context_calls[0];
    assert_eq!(*pid, p.pid);
    assert_eq!(*ctx_id, 1);              // first context is id 1
    assert_eq!(recorded_attrs.len(), 16);
}

#[test]
fn glio_make_current_requires_ctx_and_surface() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);
    // No context yet → EINVAL.
    let err = sys_ioctl(&mut p, fd, GLIO_MAKE_CURRENT, &mut [][..]).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}

#[test]
fn glio_query_rejects_oversize_out_buf() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    init_ctx_surface_and_make_current(&mut p, &mut h, fd);
    let qi = GlQueryInfo {
        op: QOP_GET_ERROR,
        in_buf_ptr: 0, in_buf_len: 0,
        out_buf_ptr: 0, out_buf_len: MAX_QUERY_OUT_LEN + 1,
        reserved: 0,
    };
    let mut buf = [0u8; 24];
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, qi); }
    let err = sys_ioctl(&mut p, fd, GLIO_QUERY, &mut buf).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}

#[test]
fn glio_present_requires_make_current() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);
    // No MAKE_CURRENT → EINVAL.
    let err = sys_ioctl(&mut p, fd, GLIO_PRESENT, &mut [][..]).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}

#[test]
fn glio_submit_bumps_seq_and_calls_host() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    init_ctx_surface_and_make_current(&mut p, &mut h, fd);
    // (helper that runs INIT → CREATE_CONTEXT → CREATE_SURFACE → MAKE_CURRENT)

    let si = GlSubmitInfo { offset: 0, length: 64 };
    let mut buf = [0u8; 8];
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, si); }
    sys_ioctl(&mut p, fd, GLIO_SUBMIT, &mut buf).unwrap();
    sys_ioctl(&mut p, fd, GLIO_SUBMIT, &mut buf).unwrap();

    assert_eq!(h.gl_submit_calls.len(), 2);
    let ofd = p.ofd_for_fd(fd).unwrap();
    let OpenFileKind::DriRender(s) = &ofd.kind else { panic!() };
    assert_eq!(s.cmdbuf.unwrap().submit_seq, 2);
}

#[test]
fn unknown_dri_ioctl_returns_enotty() {
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    let mut buf = [0u8; 8];
    let err = sys_ioctl(&mut p, fd, 0xDEADu32, &mut buf).unwrap_err();
    assert_eq!(err, Errno::ENOTTY);
}
```

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib glio_
```

**Step 3: Implement**

In `sys_ioctl`, after the existing FIONBIO/FIOASYNC/FIONREAD branches, before the fbdev branch:

```rust
let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
if let OpenFileKind::DriRender(_) = &ofd.kind {
    return handle_gl_ioctl(proc, host, fd, request, buf);
}
```

`fn handle_gl_ioctl`:

```rust
fn handle_gl_ioctl(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    request: u32,
    buf: &mut [u8],
) -> Result<(), Errno> {
    use wasm_posix_shared::gl::*;
    let ofd_idx = proc.fd_table.get(fd)?.ofd_ref;
    let ofd = proc.ofd_table.get_mut(ofd_idx.0).ok_or(Errno::EBADF)?;
    let OpenFileKind::DriRender(state) = &mut ofd.kind else { return Err(Errno::ENOTTY) };

    match request {
        GLIO_INIT => {
            // Client passes its compile-time OP_VERSION. Reject mismatches
            // up-front so the divergence surfaces here, not as a silent
            // cmdbuf decode error later.
            if buf.len() < 4 { return Err(Errno::EINVAL); }
            let client_op_version: u32 = unsafe {
                core::ptr::read_unaligned(buf.as_ptr() as *const u32)
            };
            if client_op_version != wasm_posix_shared::gl::OP_VERSION {
                return Err(Errno::ENOSYS);
            }
            state.initialized = true;
            Ok(())
        }
        GLIO_TERMINATE => {
            // Tear down — see Task A8 for the equivalent on close/exit.
            if let Some(b) = state.cmdbuf.take()  { host.gl_unbind(proc.pid); proc.gl_binding = None; let _ = b; }
            if let Some(c) = state.context_id.take() { host.gl_destroy_context(proc.pid, c); }
            if let Some(s) = state.surface_id.take() { host.gl_destroy_surface(proc.pid, s); }
            state.current = false;
            state.initialized = false;
            Ok(())
        }
        GLIO_CREATE_CONTEXT => {
            if !state.initialized { return Err(Errno::EINVAL); }
            if state.context_id.is_some() { return Err(Errno::EINVAL); }
            if buf.len() < 16 { return Err(Errno::EINVAL); }
            let ctx_id = 1u32;            // single context per fd
            host.gl_create_context(proc.pid, ctx_id, &buf[..16]);
            state.context_id = Some(ctx_id);
            Ok(())
        }
        GLIO_DESTROY_CONTEXT => {
            if let Some(c) = state.context_id.take() {
                host.gl_destroy_context(proc.pid, c);
                state.current = false;
            }
            Ok(())
        }
        GLIO_CREATE_SURFACE => {
            if !state.initialized { return Err(Errno::EINVAL); }
            if state.surface_id.is_some() { return Err(Errno::EINVAL); }
            if buf.len() < 32 { return Err(Errno::EINVAL); }
            let surface_id = 1u32;
            host.gl_create_surface(proc.pid, surface_id, &buf[..32]);
            state.surface_id = Some(surface_id);
            Ok(())
        }
        GLIO_DESTROY_SURFACE => {
            if let Some(s) = state.surface_id.take() {
                host.gl_destroy_surface(proc.pid, s);
                state.current = false;
            }
            Ok(())
        }
        GLIO_MAKE_CURRENT => {
            let (Some(c), Some(s)) = (state.context_id, state.surface_id) else {
                return Err(Errno::EINVAL);
            };
            host.gl_make_current(proc.pid, c, s);
            state.current = true;
            Ok(())
        }
        GLIO_SUBMIT => {
            if !state.current { return Err(Errno::EINVAL); }
            let cmdbuf = state.cmdbuf.as_mut().ok_or(Errno::EINVAL)?;
            if buf.len() < 8 { return Err(Errno::EINVAL); }
            let si: GlSubmitInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
            if (si.offset as usize) + (si.length as usize) > cmdbuf.len {
                return Err(Errno::EINVAL);
            }
            cmdbuf.submit_seq += 1;
            host.gl_submit(proc.pid, si.offset as usize, si.length as usize);
            Ok(())
        }
        GLIO_PRESENT => {
            if !state.current { return Err(Errno::EINVAL); }
            host.gl_present(proc.pid);
            Ok(())
        }
        GLIO_QUERY => {
            if !state.current { return Err(Errno::EINVAL); }
            if buf.len() < 24 { return Err(Errno::EINVAL); }
            let qi: GlQueryInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
            // Cap the kernel-side scratch allocation so a malicious process
            // can't pass `out_buf_len = 0xFFFFFFFE` and OOM the kernel.
            if qi.out_buf_len > MAX_QUERY_OUT_LEN {
                return Err(Errno::EINVAL);
            }
            // Resolve in / out slices via the existing process-memory helpers.
            let input  = proc.memory.slice(qi.in_buf_ptr  as usize, qi.in_buf_len  as usize)?;
            let mut out_buf = vec![0u8; qi.out_buf_len as usize];
            let n = host.gl_query(proc.pid, qi.op, input, &mut out_buf);
            if n < 0 { return Err(Errno::from_negative(n)); }
            proc.memory.write(qi.out_buf_ptr as usize, &out_buf[..n as usize])?;
            Ok(())
        }
        _ => Err(Errno::ENOTTY),
    }
}
```

(`Errno::from_negative` already exists for negative-errno marshalling — grep to confirm; otherwise inline `Errno::from_raw(-n)`.)

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib glio_
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs
git commit -m "kernel(gles): GLIO_INIT/CREATE_*/MAKE_CURRENT/SUBMIT/PRESENT/QUERY ioctls"
```

---

### Task A7: mmap path — bind cmdbuf

**Files:**
- Modify: `crates/kernel/src/syscalls.rs::sys_mmap`

**Step 1: Failing tests**

```rust
#[test]
fn mmap_dri_renderd128_records_cmdbuf_and_calls_host() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);  // helper from A6 tests — passes OP_VERSION

    let addr = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN,
                        PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
    assert_ne!(addr, 0);

    assert_eq!(h.gl_bind_calls.len(), 1);
    assert_eq!(h.gl_bind_calls[0], (p.pid, addr, CMDBUF_LEN));
    assert_eq!(p.gl_binding.unwrap().cmdbuf_addr, addr);
    assert_eq!(p.gl_binding.unwrap().cmdbuf_len, CMDBUF_LEN);
}

#[test]
fn mmap_before_init_returns_einval() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    let err = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN,
                       PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}

#[test]
fn mmap_with_wrong_len_returns_einval() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);  // helper from A6 tests — passes OP_VERSION
    let err = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN + 4096,
                       PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}

#[test]
fn second_mmap_of_dri_renderd128_returns_einval() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);  // helper from A6 tests — passes OP_VERSION
    let _a = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN,
                      PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
    let err = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN,
                       PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}
```

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib mmap_dri_renderd128
```

**Step 3: Implement**

In `sys_mmap`, after the fbdev `Fb0` branch, mirror the same structure for `DriRender`:

```rust
if !flags_contains_anonymous && fd >= 0 {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if let OpenFileKind::DriRender(state) = &ofd.kind {
        if !state.initialized { return Err(Errno::EINVAL); }
        if state.cmdbuf.is_some()    { return Err(Errno::EINVAL); }
        if len != shared::gl::CMDBUF_LEN { return Err(Errno::EINVAL); }

        let addr_out = proc.memory.mmap_anonymous(addr, len, prot, flags | MAP_ANONYMOUS);
        if addr_out == MAP_FAILED { return Err(Errno::ENOMEM); }

        // Update OFD state.
        let ofd_mut = proc.ofd_table.get_mut(entry.ofd_ref.0).unwrap();
        if let OpenFileKind::DriRender(s) = &mut ofd_mut.kind {
            s.cmdbuf = Some(CmdbufBinding { addr: addr_out, len, submit_seq: 0 });
        }
        proc.gl_binding = Some(GlBinding { cmdbuf_addr: addr_out, cmdbuf_len: len });
        host.gl_bind(proc.pid, addr_out, len);
        return Ok(addr_out);
    }
}
```

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib mmap_dri_renderd128 mmap_before_init mmap_with_wrong_len second_mmap_of_dri
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs
git commit -m "kernel(gles): mmap(/dev/dri/renderD128) binds 1MiB cmdbuf and notifies host"
```

---

### Task A8: cleanup — `munmap` / `close` / process-exit / `execve` / `fork`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs::sys_munmap`, `sys_close`, `sys_execve`
- Modify: `crates/kernel/src/process.rs` (process drop / cleanup hook)
- Modify: `crates/kernel/src/wasm_api.rs::kernel_remove_process` if a hook lives there
- Modify: `crates/kernel/src/syscalls.rs::sys_fork` to ensure `child.gl_binding = None` and child does not inherit `GL_DEVICE_OWNER`.

**Step 1: Failing tests**

```rust
#[test]
fn munmap_of_cmdbuf_clears_binding_and_unbinds_host() {
    use wasm_posix_shared::gl::*;
    let (mut p, mut h) = test_helpers::new_proc_with_tracking_host();
    let fd = open_gl(&mut p, &mut h);
    glio_init_ok(&mut p, fd);  // helper from A6 tests — passes OP_VERSION
    let addr = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN,
                        PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
    sys_munmap(&mut p, &mut h, addr, CMDBUF_LEN).unwrap();
    assert!(p.gl_binding.is_none());
    assert_eq!(h.gl_unbind_calls, vec![p.pid]);
}

#[test]
fn process_exit_releases_gl_owner_and_cleans_up_host() {
    use wasm_posix_shared::gl::*;
    use crate::process_table::GL_DEVICE_OWNER;
    use core::sync::atomic::Ordering;

    let mut h = test_helpers::new_tracking_host();
    {
        let mut p = test_helpers::new_proc_with(h.borrow_mut());
        let fd = open_gl(&mut p, &mut h);
        glio_init_ok(&mut p, fd);  // helper from A6 tests — passes OP_VERSION
        init_ctx_surface_and_make_current(&mut p, &mut h, fd);
        let _addr = sys_mmap(&mut p, &mut h, 0, CMDBUF_LEN,
                             PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
        // p dropped — simulates exit
    }
    assert_eq!(GL_DEVICE_OWNER.load(Ordering::SeqCst), -1);
    assert!(!h.gl_unbind_calls.is_empty());
    assert!(!h.gl_destroy_context_calls.is_empty());
    assert!(!h.gl_destroy_surface_calls.is_empty());
}

#[test]
fn fork_does_not_inherit_gl_device_ownership() {
    use crate::process_table::GL_DEVICE_OWNER;
    use core::sync::atomic::Ordering;
    let (mut parent, mut h) = test_helpers::new_proc_with_tracking_host();
    let _fd = open_gl(&mut parent, &mut h);
    // pre-condition: parent owns it.
    assert_eq!(GL_DEVICE_OWNER.load(Ordering::SeqCst), parent.pid);

    let child = test_helpers::fork(&parent, /* new_pid */ parent.pid + 1);
    assert!(child.gl_binding.is_none());
    // Child trying to call eglMakeCurrent (i.e. GLIO_MAKE_CURRENT) cannot
    // succeed because it does not own the device fd state machine; this is
    // exercised more directly in B5.
}
```

**Step 2: Run, observe failure**

**Step 3: Implement**

In `sys_munmap` — accept `host: &mut dyn HostIO`, then after the existing `proc.memory.munmap(addr, len)`:

```rust
if let Some(b) = proc.gl_binding {
    if addr <= b.cmdbuf_addr && addr + len >= b.cmdbuf_addr + b.cmdbuf_len {
        proc.gl_binding = None;
        host.gl_unbind(proc.pid);
        // Also clear the cmdbuf record on the matching OFD.
        for ofd in proc.ofd_table.iter_mut() {
            if let OpenFileKind::DriRender(s) = &mut ofd.kind {
                s.cmdbuf = None;
            }
        }
    }
}
```

In `sys_close` — when the closed fd was the *last* OFD reference into a `DriRender`, CAS `GL_DEVICE_OWNER` from `pid → -1` (mirror `FB0_OWNER` close-path cleanup). Do not call `gl_unbind` here; that's tied to the cmdbuf mapping, not the fd lifetime.

In `sys_execve` — clear all `DriRender` ofds, drop owner, call `gl_unbind` + `gl_destroy_context` + `gl_destroy_surface` if their respective ids are set, then proceed with the normal exec replacement.

In process-exit cleanup (`Process::drop` or `kernel_remove_process` — search `host.unbind_framebuffer` to find the parallel hook):

```rust
if proc.gl_binding.is_some() {
    host.gl_unbind(proc.pid);
}
for ofd in proc.ofd_table.iter() {
    if let OpenFileKind::DriRender(s) = &ofd.kind {
        if let Some(c) = s.context_id { host.gl_destroy_context(proc.pid, c); }
        if let Some(s) = s.surface_id { host.gl_destroy_surface(proc.pid, s); }
    }
}
let _ = GL_DEVICE_OWNER.compare_exchange(proc.pid, -1, Ordering::SeqCst, Ordering::SeqCst);
```

In `sys_fork` — after `child.fb_binding = None`, add `child.gl_binding = None;` and ensure no entry duplicates the parent's `OpenFileKind::DriRender` state (the child inherits the cmdbuf mmap pages but not the OFD's `GlState`).

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib munmap_of_cmdbuf process_exit_releases_gl_owner fork_does_not_inherit_gl
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/process.rs crates/kernel/src/wasm_api.rs
git commit -m "kernel(gles): munmap/close/exit/exec/fork cleanup for /dev/dri/renderD128"
```

---

### Task A9: ABI snapshot regen + version bump 6 → 7

**Files:**
- Modify: `crates/shared/src/lib.rs` (`ABI_VERSION` line 20)
- Modify: `abi/snapshot.json` (regenerated by script)

**Step 1: Run snapshot update**

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json | head -200
```

**Step 2: Inspect the diff**

The diff should show new entries for: `GlSubmitInfo`, `GlContextAttrs`, `GlSurfaceAttrs`, `GlQueryInfo` (under `marshalled_structs`); `host_gl_bind` / `host_gl_unbind` / `host_gl_create_context` / `host_gl_destroy_context` / `host_gl_create_surface` / `host_gl_destroy_surface` / `host_gl_make_current` / `host_gl_submit` / `host_gl_present` / `host_gl_query` (under `host_imports`); and possibly the `OpenFileKind::DriRender(GlState)` enum variant if your snapshot script tracks tagged-union shapes (check `scripts/check-abi-version.sh`).

If the diff matches expectations, bump.

**Step 3: Bump**

In `crates/shared/src/lib.rs`, change:

```rust
pub const ABI_VERSION: u32 = 6;
```

to:

```rust
pub const ABI_VERSION: u32 = 7;
```

**Step 4: Verify**

```bash
bash scripts/check-abi-version.sh
```

Expected: exit 0.

**Step 5: Commit**

```bash
git add crates/shared/src/lib.rs abi/snapshot.json
git commit -m "kernel(gles): bump ABI_VERSION 6→7 for GL device structs and host imports"
```

---

### Task A10: Phase A — full gauntlet + open PR #1

**Files:** none (verification only)

**Step 1: Run all six suites**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

Record pass/fail/xfail counts in the format Brandon uses for PR descriptions:

```
- cargo test -p wasm-posix-kernel --lib                — N / 0
- (cd host && npx vitest run)                          — N pass / N skip / 0 fail
- scripts/run-libc-tests.sh                            — N PASS / 0 FAIL / N XFAIL / N TIME
- scripts/run-posix-tests.sh                           — N PASS / 0 FAIL / N XFAIL / N SKIP
- scripts/run-sortix-tests.sh --all                    — N PASS / 0 FAIL / N XFAIL / 0 XPASS / 0 TIMEOUT
- bash scripts/check-abi-version.sh                    — clean
```

If any non-pre-existing failure appears, fix the root cause before opening the PR.

**Step 2: Push branch and open PR #1**

```bash
git push -u origin explore-webgl-exposition-kernel
gh pr create --draft --repo mho22/wasm-posix-kernel \
  --base explore-webgl-exposition-plan --head explore-webgl-exposition-kernel \
  --title "kernel(gles): /dev/dri/renderD128 device + EGL/GL ioctls + cmdbuf mmap" \
  --body "..."
```

PR body: link to design RFC PR (`#1` in mho22 fork) and to `docs/plans/2026-04-28-webgl-gles2-design.md` + `-plan.md`. Summarise what landed (Tasks A1–A9). Note this is part 1/3 of a coordinated stack — explicitly: "Holds for merge until Phase C (browser GL demo) is verified — see plan." Mark `Draft`. Include the full 6-suite gauntlet block.

---

## Phase B — Host registry + cmdbuf decoder + tests (PR #2)

### Task B1: `GlContextRegistry` module

**Files:**
- Create: `host/src/webgl/registry.ts`
- Create: `host/src/webgl/index.ts` (barrel)
- Create: `host/test/webgl-registry.test.ts`

**Step 1: Failing test**

```ts
// host/test/webgl-registry.test.ts
import { describe, expect, it } from 'vitest';
import { GlContextRegistry } from '../src/webgl/registry.js';

describe('GlContextRegistry', () => {
  it('binds and retrieves', () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0x10000, cmdbufLen: 1 << 20 });
    const b = reg.get(7)!;
    expect(b.pid).toBe(7);
    expect(b.cmdbufView).toBeNull();          // lazy
    expect(b.gl).toBeNull();                  // not yet attached
    expect(b.buffers.size).toBe(0);
  });

  it('unbind is idempotent', () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.unbind(7);
    reg.unbind(7);                            // no throw
    expect(reg.get(7)).toBeUndefined();
  });

  it('rebindMemory invalidates the cached cmdbuf view', () => {
    const reg = new GlContextRegistry();
    const sab = new SharedArrayBuffer(1 << 20);
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    const b = reg.get(7)!;
    b.cmdbufView = new Uint8Array(sab, 0, 4);
    reg.rebindMemory(7);
    expect(reg.get(7)?.cmdbufView).toBeNull();
  });

  it('attachCanvas creates a WebGL2 context lazily', () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    const canvas = new OffscreenCanvas(64, 64);
    reg.attachCanvas(7, canvas);
    const b = reg.get(7)!;
    expect(b.canvas).toBe(canvas);
    // gl is lazily constructed at gl_create_context time, not at attach time;
    // attach only wires the surface. (Tested in Task B2 integration.)
    expect(b.gl).toBeNull();
  });

  it('onChange notifies bind/unbind events', () => {
    const reg = new GlContextRegistry();
    const seen: Array<[number, string]> = [];
    const off = reg.onChange((pid, ev) => seen.push([pid, ev]));
    reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 4 });
    reg.unbind(7);
    off();
    reg.bind({ pid: 8, cmdbufAddr: 0, cmdbufLen: 4 });
    expect(seen).toEqual([[7, 'bind'], [7, 'unbind']]);
  });
});
```

**Step 2: Run, observe failure**

```bash
(cd host && npx vitest run webgl-registry)
```

**Step 3: Implement**

```ts
// host/src/webgl/registry.ts
export type GlContextHandle = number;
export type GlSurfaceHandle = number;

export interface GlBinding {
  pid: number;
  cmdbufAddr: number;
  cmdbufLen: number;
  cmdbufView: Uint8Array | null;

  gl: WebGL2RenderingContext | null;
  canvas: HTMLCanvasElement | OffscreenCanvas | null;

  contextId: GlContextHandle | null;
  surfaceId: GlSurfaceHandle | null;

  buffers:  Map<number, WebGLBuffer>;
  textures: Map<number, WebGLTexture>;
  shaders:  Map<number, WebGLShader>;
  programs: Map<number, WebGLProgram>;
  vaos:     Map<number, WebGLVertexArrayObject>;
  fbos:     Map<number, WebGLFramebuffer>;
  rbos:     Map<number, WebGLRenderbuffer>;
  /** Number-keyed (NOT string-keyed) so the cmdbuf int round-trips
   *  cleanly. Indices are assigned by `++nextUniformLoc` so insert/
   *  delete cycles cannot collide. */
  uniformLocations: Map<number, WebGLUniformLocation>;
  /** Monotonic counter for `uniformLocations`; never decremented. */
  nextUniformLoc: number;

  currentProgram: WebGLProgram | null;
}

type Bind = Pick<GlBinding, 'pid' | 'cmdbufAddr' | 'cmdbufLen'>;

export class GlContextRegistry {
  private bindings = new Map<number, GlBinding>();
  private listeners = new Set<(pid: number, ev: 'bind' | 'unbind') => void>();

  bind(b: Bind): void {
    this.bindings.set(b.pid, {
      ...b,
      cmdbufView: null,
      gl: null,
      canvas: null,
      contextId: null,
      surfaceId: null,
      buffers: new Map(), textures: new Map(), shaders: new Map(),
      programs: new Map(), vaos: new Map(), fbos: new Map(), rbos: new Map(),
      uniformLocations: new Map(),
      nextUniformLoc: 0,
      currentProgram: null,
    });
    for (const l of this.listeners) l(b.pid, 'bind');
  }

  unbind(pid: number): void {
    if (!this.bindings.delete(pid)) return;
    for (const l of this.listeners) l(pid, 'unbind');
  }

  get(pid: number): GlBinding | undefined { return this.bindings.get(pid); }
  list(): GlBinding[] { return [...this.bindings.values()]; }

  rebindMemory(pid: number): void {
    const b = this.bindings.get(pid);
    if (b) b.cmdbufView = null;
  }

  attachCanvas(pid: number, canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const b = this.bindings.get(pid);
    if (b) b.canvas = canvas;
  }

  detachCanvas(pid: number): void {
    const b = this.bindings.get(pid);
    if (b) { b.canvas = null; b.gl = null; }
  }

  onChange(fn: (pid: number, ev: 'bind' | 'unbind') => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}
```

```ts
// host/src/webgl/index.ts
export { GlContextRegistry } from './registry.js';
export type { GlBinding } from './registry.js';
```

**Step 4: Pass**

```bash
(cd host && npx vitest run webgl-registry)
```

**Step 5: Commit**

```bash
git add host/src/webgl host/test/webgl-registry.test.ts
git commit -m "host(gles): GlContextRegistry — pid-keyed handle maps + lazy view"
```

---

### Task B2: Wire `host_gl_*` imports into kernel-worker

**Files:**
- Modify: `host/src/kernel-worker.ts` (or wherever the kernel wasm imports are bound — grep `host_bind_framebuffer` to find).
- Modify: wherever `FramebufferRegistry` lives at runtime (the centralized kernel worker host) — add `gl: GlContextRegistry` next to it.
- Modify: `host/test/centralized-test-helper.ts` — expose `kernel.gl` for tests.

**Step 1: Implement**

In the imports object construction, beside `host_bind_framebuffer`, add:

```ts
import { GlContextRegistry } from './webgl/registry.js';
import { decodeAndDispatch } from './webgl/bridge.js';   // Task B3
import { runGlQuery }        from './webgl/query.js';     // Task B3

const gl = new GlContextRegistry();

const imports = {
  // ... existing
  env: {
    // ...
    host_gl_bind(pid: number, addr: number, len: number) {
      gl.bind({ pid, cmdbufAddr: addr, cmdbufLen: len });
    },
    host_gl_unbind(pid: number) { gl.unbind(pid); },

    host_gl_create_context(pid: number, ctxId: number,
                           attrsPtr: number, attrsLen: number) {
      const b = gl.get(pid);
      if (!b || !b.canvas) return;     // canvas not attached yet — see Task B4
      b.gl = (b.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false })
              as WebGL2RenderingContext | null);
      b.contextId = ctxId;
      void attrsPtr; void attrsLen;    // v1 ignores attrs beyond client_version
    },
    host_gl_destroy_context(pid: number, _ctxId: number) {
      const b = gl.get(pid);
      if (b) { b.gl = null; b.contextId = null; b.currentProgram = null; }
    },

    host_gl_create_surface(pid: number, sid: number,
                           _ap: number, _al: number) {
      const b = gl.get(pid); if (b) b.surfaceId = sid;
    },
    host_gl_destroy_surface(pid: number, _sid: number) {
      const b = gl.get(pid); if (b) b.surfaceId = null;
    },
    host_gl_make_current(_pid: number, _ctx: number, _sfc: number) {
      // No-op: WebGL2 is per-context; we already track binding. Hook for future
      // multi-context work.
    },

    host_gl_submit(pid: number, offset: number, length: number) {
      const b = gl.get(pid);
      if (!b || !b.gl) return;
      if (!b.cmdbufView) {
        const sab = kernel.getProcessMemorySab(pid);
        b.cmdbufView = new Uint8Array(sab, b.cmdbufAddr, b.cmdbufLen);
      }
      decodeAndDispatch(b, offset, length);
    },
    host_gl_present(_pid: number) {
      // RAF-driven canvas presents automatically. No-op in v1.
    },
    host_gl_query(pid: number, op: number,
                  inPtr: number, inLen: number,
                  outPtr: number, outLen: number): number {
      const b = gl.get(pid);
      if (!b || !b.gl) return -1;       // EPERM — better than silent zero
      const memSab = kernel.getProcessMemorySab(pid);
      const input  = new Uint8Array(memSab, inPtr,  inLen);
      const out    = new Uint8Array(memSab, outPtr, outLen);
      return runGlQuery(b, op, input, out);
    },
  },
};
```

Expose `kernel.gl = gl`. Hook the existing memory-replaced event to call `gl.rebindMemory(pid)` (mirror the fb path).

**Step 2: Type-check**

```bash
(cd host && npx tsc --noEmit)
```

(Will fail until Task B3 lands `bridge.ts` and `query.ts`. Wire the imports against placeholder modules that throw `not-implemented`, or land B2 + B3 in adjacent commits within the same task.)

**Step 3: Commit (after B3 lands)**

```bash
git add host/src
git commit -m "host(gles): wire host_gl_* imports into kernel worker"
```

---

### Task B3: Cmdbuf decoder — TLV walker + per-op dispatch

**Files:**
- Create: `host/src/webgl/bridge.ts` (the TLV decoder + dispatch table)
- Create: `host/src/webgl/query.ts` (sync query handler)
- Create: `host/src/webgl/ops.ts` (TS mirror of `shared::gl::OP_*` and `QOP_*`)

**Step 1: TS mirror of opcodes**

```ts
// host/src/webgl/ops.ts
export const OP_CLEAR                       = 0x0001;
export const OP_CLEAR_COLOR                 = 0x0002;
// ... mirror every OP_* in shared::gl exactly, in the same order ...
export const OP_FRAMEBUFFER_RENDERBUFFER    = 0x0706;

export const QOP_GET_ERROR             = 0x01;
export const QOP_GET_STRING            = 0x02;
// ... mirror every QOP_* ...
export const QOP_CHECK_FB_STATUS       = 0x0C;

/** Bumped in lockstep with `shared::gl::OP_VERSION`. */
export const OP_VERSION = 1;
```

**Step 2: TLV walker**

```ts
// host/src/webgl/bridge.ts
import type { GlBinding } from './registry.js';
import * as O from './ops.js';

export function decodeAndDispatch(
  b: GlBinding,
  offset: number,
  length: number,
): void {
  const view = new DataView(b.cmdbufView!.buffer, b.cmdbufView!.byteOffset + offset, length);
  const gl = b.gl!;
  let p = 0;
  while (p < length) {
    const op  = view.getUint16(p, true);
    const len = view.getUint16(p + 2, true);
    p += 4;
    dispatch(gl, b, view, p, op, len);
    p += len;
  }
}

function dispatch(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  v: DataView,
  p: number,
  op: number,
  _len: number,
): void {
  switch (op) {
    // ----- state -----
    case O.OP_CLEAR:        gl.clear(v.getUint32(p, true)); return;
    case O.OP_CLEAR_COLOR:  gl.clearColor(v.getFloat32(p, true), v.getFloat32(p+4, true),
                                           v.getFloat32(p+8, true), v.getFloat32(p+12, true)); return;
    case O.OP_VIEWPORT:     gl.viewport(v.getInt32(p, true), v.getInt32(p+4, true),
                                          v.getInt32(p+8, true), v.getInt32(p+12, true)); return;
    case O.OP_SCISSOR:      gl.scissor(v.getInt32(p, true), v.getInt32(p+4, true),
                                         v.getInt32(p+8, true), v.getInt32(p+12, true)); return;
    case O.OP_ENABLE:       gl.enable(v.getUint32(p, true)); return;
    case O.OP_DISABLE:      gl.disable(v.getUint32(p, true)); return;
    case O.OP_BLEND_FUNC:   gl.blendFunc(v.getUint32(p, true), v.getUint32(p+4, true)); return;
    case O.OP_DEPTH_FUNC:   gl.depthFunc(v.getUint32(p, true)); return;
    case O.OP_CULL_FACE:    gl.cullFace(v.getUint32(p, true)); return;
    case O.OP_FRONT_FACE:   gl.frontFace(v.getUint32(p, true)); return;
    case O.OP_LINE_WIDTH:   gl.lineWidth(v.getFloat32(p, true)); return;
    case O.OP_PIXEL_STOREI: gl.pixelStorei(v.getUint32(p, true), v.getInt32(p+4, true)); return;

    // ----- buffers -----
    case O.OP_GEN_BUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i*4, true);
        b.buffers.set(name, gl.createBuffer()!);
      } return;
    }
    case O.OP_DELETE_BUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i*4, true);
        gl.deleteBuffer(b.buffers.get(name) ?? null);
        b.buffers.delete(name);
      } return;
    }
    case O.OP_BIND_BUFFER:
      gl.bindBuffer(v.getUint32(p, true), b.buffers.get(v.getUint32(p+4, true)) ?? null);
      return;
    case O.OP_BUFFER_DATA: {
      const target = v.getUint32(p, true);
      const dataLen = v.getUint32(p + 4, true);
      const usage = v.getUint32(p + 8 + dataLen, true);
      const data = new Uint8Array(v.buffer, v.byteOffset + p + 8, dataLen);
      gl.bufferData(target, data, usage);
      return;
    }
    case O.OP_BUFFER_SUB_DATA: {
      const target = v.getUint32(p, true);
      const off    = v.getInt32(p + 4, true);
      const dataLen= v.getUint32(p + 8, true);
      const data   = new Uint8Array(v.buffer, v.byteOffset + p + 12, dataLen);
      gl.bufferSubData(target, off, data);
      return;
    }

    // ----- textures, shaders/programs, uniforms, attribs, draws, VAOs, FBOs -----
    // (one arm per OP_* — see design doc §4 "Op categories" for the full list.
    //  Each arm decodes its TLV payload, looks up handles via b.{buffers,
    //  textures, shaders, programs, vaos, fbos, rbos}, and calls the WebGL
    //  function. Unknown opcodes throw — surface decode bugs loudly during
    //  development rather than silently skipping.)
    default:
      throw new Error(`gl bridge: unknown op 0x${op.toString(16)} at offset ${p - 4}`);
  }
}
```

A complete one-line-per-op dispatch is roughly 250 LoC; treat the abbreviated body above as the structural template.

**Step 3: Sync query handler**

```ts
// host/src/webgl/query.ts
import type { GlBinding } from './registry.js';
import * as O from './ops.js';

export function runGlQuery(
  b: GlBinding,
  op: number,
  input: Uint8Array,
  out: Uint8Array,
): number {
  const gl = b.gl!;
  switch (op) {
    case O.QOP_GET_ERROR: {
      new DataView(out.buffer, out.byteOffset, 4).setUint32(0, gl.getError(), true);
      return 4;
    }
    case O.QOP_GET_INTEGERV: {
      const pname = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true);
      const val = gl.getParameter(pname) ?? 0;
      new DataView(out.buffer, out.byteOffset, 4).setInt32(0, Number(val), true);
      return 4;
    }
    case O.QOP_GET_UNIFORM_LOC: {
      // input layout: u32 program_name, u32 name_len, name_bytes...
      const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
      const program = b.programs.get(dv.getUint32(0, true));
      const nameLen = dv.getUint32(4, true);
      const name    = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc     = program ? gl.getUniformLocation(program, name) : null;
      if (loc) {
        // Monotonic — never reuse an index, even after deletes. Map.size
        // is the wrong source: it decreases on delete and would collide.
        const idx = ++b.nextUniformLoc;
        b.uniformLocations.set(idx, loc);
        new DataView(out.buffer, out.byteOffset, 4).setInt32(0, idx, true);
      } else {
        new DataView(out.buffer, out.byteOffset, 4).setInt32(0, -1, true);
      }
      return 4;
    }
    // ... QOP_GET_STRING, QOP_GET_SHADERIV, QOP_GET_SHADER_INFO_LOG,
    //     QOP_GET_PROGRAMIV, QOP_GET_PROGRAM_INFO_LOG, QOP_READ_PIXELS,
    //     QOP_CHECK_FB_STATUS, QOP_GET_ATTRIB_LOC, QOP_GET_FLOATV,
    //     QOP_GET_STRING ...
    default:
      return -22;       // EINVAL
  }
}
```

**Step 4: Unit tests for the decoder using a fake WebGL2 context**

```ts
// host/test/webgl-bridge.test.ts
import { describe, expect, it } from 'vitest';
import { decodeAndDispatch } from '../src/webgl/bridge.js';
import * as O from '../src/webgl/ops.js';
import { GlContextRegistry } from '../src/webgl/registry.js';

class RecordingGl {
  log: Array<[string, unknown[]]> = [];
  clearColor(...a: number[]) { this.log.push(['clearColor', a]); }
  clear(m: number)           { this.log.push(['clear', [m]]); }
  viewport(...a: number[])   { this.log.push(['viewport', a]); }
  // … one stub per op the test exercises ...
  createBuffer(): unknown    { return { buf: this.log.length }; }
  bindBuffer(...a: unknown[]){ this.log.push(['bindBuffer', a]); }
}

describe('cmdbuf decode', () => {
  it('walks ClearColor + Clear + Viewport in order', () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 64 });
    const b = reg.get(1)!;
    const sab = new SharedArrayBuffer(64);
    b.cmdbufView = new Uint8Array(sab, 0, 64);
    b.gl = new RecordingGl() as unknown as WebGL2RenderingContext;

    const dv = new DataView(sab);
    let p = 0;
    // ClearColor(0.1, 0.2, 0.3, 1.0)
    dv.setUint16(p, O.OP_CLEAR_COLOR, true); dv.setUint16(p+2, 16, true); p += 4;
    dv.setFloat32(p, 0.1, true);  dv.setFloat32(p+4, 0.2, true);
    dv.setFloat32(p+8, 0.3, true); dv.setFloat32(p+12, 1.0, true); p += 16;
    // Clear(0x4000)
    dv.setUint16(p, O.OP_CLEAR, true); dv.setUint16(p+2, 4, true); p += 4;
    dv.setUint32(p, 0x4000, true); p += 4;
    // Viewport(0,0,640,400)
    dv.setUint16(p, O.OP_VIEWPORT, true); dv.setUint16(p+2, 16, true); p += 4;
    dv.setInt32(p, 0, true); dv.setInt32(p+4, 0, true);
    dv.setInt32(p+8, 640, true); dv.setInt32(p+12, 400, true); p += 16;

    decodeAndDispatch(b, 0, p);
    const log = (b.gl as unknown as RecordingGl).log;
    expect(log[0][0]).toBe('clearColor');
    expect(log[1][0]).toBe('clear');
    expect(log[2][0]).toBe('viewport');
    expect(log[2][1]).toEqual([0, 0, 640, 400]);
  });
});
```

**Step 5: Run**

```bash
(cd host && npx vitest run webgl-bridge)
```

**Step 6: Commit**

```bash
git add host/src/webgl/bridge.ts host/src/webgl/query.ts host/src/webgl/ops.ts \
        host/test/webgl-bridge.test.ts
git commit -m "host(gles): cmdbuf TLV decoder + per-op dispatch + sync query handler"
```

---

### Task B4: Worker→main GL protocol — OffscreenCanvas transfer (+ main-thread fallback)

**Files:**
- Modify: `host/src/kernel-worker-protocol.ts` (or wherever postMessage shapes are typed) — add `gl_attach_canvas` / `gl_detach_canvas` message variants.
- Modify: `host/src/kernel.ts` (BrowserKernel) — add `attachGlCanvas(pid, HTMLCanvasElement | OffscreenCanvas)` that either transfers an OffscreenCanvas to the kernel worker (preferred) or sets up a forwarding proxy (fallback).
- Modify: `host/src/webgl/main-forward.ts` (new) — main-thread fallback: receives `gl_*` messages from the kernel worker and applies them to a local `WebGL2RenderingContext`. v1 only handles `gl_create_context` / `gl_create_surface` / `gl_make_current` / `gl_submit` / `gl_present` / `gl_query`. The bridge module is reused.

**Step 1: Decision — OffscreenCanvas first**

When the embedder calls `attachGlCanvas(canvas, ...)`, prefer:

```ts
if ('transferControlToOffscreen' in canvas) {
  const off = (canvas as HTMLCanvasElement).transferControlToOffscreen();
  worker.postMessage({ type: 'gl_attach_canvas', pid, canvas: off }, [off]);
} else {
  // Older Safari etc. — fall back to main-thread proxy.
  attachGlMainProxy(canvas as HTMLCanvasElement, pid);
}
```

In the worker, on `gl_attach_canvas`, call `kernel.gl.attachCanvas(pid, msg.canvas)`. The transferred OffscreenCanvas is then the surface of every subsequent WebGL call. No GL message ever crosses the worker→main boundary on the OffscreenCanvas path — this is what the spike validated.

**Step 2: Main-thread fallback**

For the fallback, the kernel worker buffers cmdbuf submits and forwards them to the main thread. Reuse `decodeAndDispatch` on the main side; the registry is duplicated (small), the `gl` reference points at a real `WebGL2RenderingContext` from `canvas.getContext('webgl2')`.

```ts
// host/src/webgl/main-forward.ts
import { GlContextRegistry } from './registry.js';
import { decodeAndDispatch } from './bridge.js';

export function setupMainForward(
  worker: Worker,
  canvas: HTMLCanvasElement,
  pid: number,
): () => void {
  const reg = new GlContextRegistry();
  reg.bind({ pid, cmdbufAddr: 0, cmdbufLen: 0 });   // we don't have the SAB here

  const onMsg = (e: MessageEvent) => {
    const m = e.data;
    if (m?.type === 'gl_create_context') {
      const b = reg.get(pid)!;
      b.gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      b.canvas = canvas;
    } else if (m?.type === 'gl_submit') {
      const b = reg.get(pid)!;
      b.cmdbufView = new Uint8Array(m.bytes);    // worker already sliced the SAB
      decodeAndDispatch(b, 0, m.bytes.byteLength);
    }
    // ... attach/destroy/query passthrough ...
  };
  worker.addEventListener('message', onMsg);
  return () => worker.removeEventListener('message', onMsg);
}
```

**Step 3: Type-check + minimal unit test**

A unit test that exercises the OffscreenCanvas path is hard to write headlessly (vitest's jsdom doesn't implement WebGL). The structural guarantee in `webgl-registry.test.ts` (Task B1) — that `attachCanvas` accepts an OffscreenCanvas — is the test budget here. The end-to-end signal lives in Task B5 + Task C8.

```bash
(cd host && npx tsc --noEmit)
```

**Step 4: Commit**

```bash
git add host/src/kernel-worker-protocol.ts host/src/kernel.ts \
        host/src/webgl/main-forward.ts
git commit -m "host(gles): OffscreenCanvas transfer + main-thread fallback proxy"
```

---

### Task B5: `gltri.c` test program + Vitest recording-bridge integration test

**Files:**
- Create: `programs/gltri.c` (~120 LoC; the in-tree "hello triangle").
- Create: `programs/Makefile` entry / `scripts/build-programs.sh` hook so `gltri.wasm` builds.
- Create: `host/test/webgl-integration.test.ts`
- Create: `host/src/webgl/recording-bridge.ts` — shadow of `bridge.ts` that decodes ops into a JSON list instead of dispatching. Reuses the same TLV walker.

**Step 1: Write `gltri.c`**

```c
// programs/gltri.c
//
// Minimal WebGL/GLES2 hello: clear to dark grey, draw a single coloured
// triangle, swap. 600 frames then exit.
//
// Build: wasm32posix-cc programs/gltri.c -lEGL -lGLESv2 -lm -o gltri.wasm
//
// Used by host/test/webgl-integration.test.ts as the "fbtest" of GLES.
// Cannot rely on the libEGL/libGLESv2 stubs being present in the sysroot
// until Phase C; this file builds *only* in Phase C and the integration
// test depends on Phase C's build artefacts.

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <stdio.h>
#include <unistd.h>

static const char VS[] =
  "attribute vec2 a_pos;\n"
  "attribute vec3 a_col;\n"
  "varying   vec3 v_col;\n"
  "void main() { v_col = a_col; gl_Position = vec4(a_pos, 0.0, 1.0); }\n";

static const char FS[] =
  "precision mediump float;\n"
  "varying vec3 v_col;\n"
  "void main() { gl_FragColor = vec4(v_col, 1.0); }\n";

static GLuint compile(GLenum kind, const char *src) {
  GLuint s = glCreateShader(kind);
  glShaderSource(s, 1, &src, NULL);
  glCompileShader(s);
  GLint ok; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[512]; glGetShaderInfoLog(s, sizeof log, NULL, log); fprintf(stderr, "shader: %s\n", log); _exit(1); }
  return s;
}

int main(void) {
  EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  EGLint maj, min; eglInitialize(dpy, &maj, &min);
  EGLConfig cfg; EGLint n;
  EGLint cfg_attrs[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
                         EGL_RED_SIZE,8, EGL_GREEN_SIZE,8, EGL_BLUE_SIZE,8,
                         EGL_NONE };
  eglChooseConfig(dpy, cfg_attrs, &cfg, 1, &n);
  EGLint ctx_attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
  EGLContext ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctx_attrs);
  EGLint sfc_attrs[] = { EGL_WIDTH, 400, EGL_HEIGHT, 400, EGL_NONE };
  EGLSurface sfc = eglCreatePbufferSurface(dpy, cfg, sfc_attrs);
  eglMakeCurrent(dpy, sfc, sfc, ctx);

  GLuint vs = compile(GL_VERTEX_SHADER, VS);
  GLuint fs = compile(GL_FRAGMENT_SHADER, FS);
  GLuint prog = glCreateProgram();
  glAttachShader(prog, vs); glAttachShader(prog, fs);
  glBindAttribLocation(prog, 0, "a_pos");
  glBindAttribLocation(prog, 1, "a_col");
  glLinkProgram(prog);

  static const float verts[] = {
    -0.6f, -0.5f,  1, 0, 0,
     0.6f, -0.5f,  0, 1, 0,
     0.0f,  0.6f,  0, 0, 1,
  };
  GLuint vbo; glGenBuffers(1, &vbo);
  glBindBuffer(GL_ARRAY_BUFFER, vbo);
  glBufferData(GL_ARRAY_BUFFER, sizeof verts, verts, GL_STATIC_DRAW);

  glViewport(0, 0, 400, 400);
  glUseProgram(prog);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 5*sizeof(float), (void*)0);
  glEnableVertexAttribArray(1); glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 5*sizeof(float), (void*)(2*sizeof(float)));

  for (int frame = 0; frame < 600; frame++) {
    glClearColor(0.1f, 0.1f, 0.1f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    eglSwapBuffers(dpy, sfc);
  }

  write(1, "ok\n", 3);
  return 0;
}
```

**Step 2: Recording bridge**

```ts
// host/src/webgl/recording-bridge.ts
import type { GlBinding } from './registry.js';
import * as O from './ops.js';

export type RecordedOp = { op: string; args: unknown[] };

export function decodeRecording(
  b: GlBinding,
  offset: number,
  length: number,
): RecordedOp[] {
  const view = new DataView(b.cmdbufView!.buffer,
                            b.cmdbufView!.byteOffset + offset, length);
  const ops: RecordedOp[] = [];
  let p = 0;
  while (p < length) {
    const op  = view.getUint16(p, true);
    const len = view.getUint16(p + 2, true);
    p += 4;
    ops.push(decodeOne(view, p, op, len));
    p += len;
  }
  return ops;
}

function decodeOne(v: DataView, p: number, op: number, _len: number): RecordedOp {
  // Reuse the same payload-reading logic as bridge.ts but emit { op, args }
  // instead of calling gl.*. One arm per OP_*. Names are the lower-case GL
  // function name (e.g. 'clear', 'drawArrays') for assertion ergonomics.
  // ~150 LoC; mirror bridge.ts.
  switch (op) {
    case O.OP_CLEAR:        return { op: 'clear', args: [v.getUint32(p, true)] };
    case O.OP_CLEAR_COLOR:  return { op: 'clearColor',
      args: [v.getFloat32(p, true), v.getFloat32(p+4, true),
             v.getFloat32(p+8, true), v.getFloat32(p+12, true)] };
    case O.OP_DRAW_ARRAYS:  return { op: 'drawArrays',
      args: [v.getUint32(p, true), v.getInt32(p+4, true), v.getInt32(p+8, true)] };
    // ... full set ...
    default: return { op: `unknown(0x${op.toString(16)})`, args: [] };
  }
}
```

**Step 3: Vitest integration test**

```ts
// host/test/webgl-integration.test.ts
import { describe, expect, it } from 'vitest';
import { runProgram } from './centralized-test-helper.js';
import { decodeRecording } from '../src/webgl/recording-bridge.js';

describe('webgl integration (recording bridge)', () => {
  it('gltri.wasm emits the expected per-frame op sequence', async () => {
    const recorded: Array<{ op: string; args: unknown[] }> = [];
    const { kernel, pid, stdout } = await runProgram(
      'build/programs/gltri.wasm',
      {
        // Override gl_submit to record instead of dispatch.
        glRecorder: (b, off, len) => {
          for (const r of decodeRecording(b, off, len)) recorded.push(r);
        },
      },
    );
    await stdout.waitFor('ok\n');

    // Initialization phase contains shader compile + program link.
    expect(recorded.find(r => r.op === 'createShader')).toBeDefined();
    expect(recorded.find(r => r.op === 'shaderSource')).toBeDefined();
    expect(recorded.find(r => r.op === 'compileShader')).toBeDefined();
    expect(recorded.find(r => r.op === 'createProgram')).toBeDefined();
    expect(recorded.find(r => r.op === 'linkProgram')).toBeDefined();
    expect(recorded.find(r => r.op === 'genBuffers')).toBeDefined();
    expect(recorded.find(r => r.op === 'bufferData')).toBeDefined();

    // 600 frames each with: clearColor, clear, drawArrays.
    const draws = recorded.filter(r => r.op === 'drawArrays');
    expect(draws.length).toBe(600);
    for (const d of draws) {
      expect(d.args).toEqual([0x0004 /* GL_TRIANGLES */, 0, 3]);
    }

    // Process exit triggered one gl_unbind.
    expect(kernel.gl.get(pid)).toBeUndefined();
  });

  it('second open of /dev/dri/renderD128 fails EBUSY across pids', async () => {
    const { kernel: _k1, pid: pidA } = await runProgram('build/programs/gltri.wasm');
    const errno = await runProgram('build/programs/glopen-only.wasm', { expectExit: 1 })
      .then(r => r.exitErrno);
    expect(errno).toBe(16 /* EBUSY */);
    void pidA;
  });

  it('cmdbuf overflow triggers auto-flush', async () => {
    // gloverflow.wasm: emit ~2 MiB of trivial state changes, expect 2+ submits.
    let submits = 0;
    await runProgram('build/programs/gloverflow.wasm', {
      glRecorder: (_b, _o, _l) => { submits++; },
    });
    expect(submits).toBeGreaterThanOrEqual(2);
  });
});
```

`glopen-only.c` and `gloverflow.c` are tiny (~30 LoC each) helpers in `programs/`.

**Step 4: Run**

```bash
scripts/build-programs.sh    # builds gltri.wasm + helpers (depends on Phase C
                             # libEGL.a / libGLESv2.a being in the sysroot)
(cd host && npx vitest run webgl-integration)
```

**Step 5: Commit**

```bash
git add programs/gltri.c programs/glopen-only.c programs/gloverflow.c \
        scripts/build-programs.sh \
        host/src/webgl/recording-bridge.ts host/test/webgl-integration.test.ts
git commit -m "host(gles): gltri.wasm + recording-bridge integration test"
```

> **Phase ordering note.** Task B5 references `gltri.wasm`, which can only be cross-compiled once Phase C lands the sysroot stubs (libEGL/libGLESv2). In practice: land Tasks B1–B4 + B6–B7 in PR #2, then add the in-tree C programs and integration tests as part of PR #3 (Phase C), wiring them up in Task C5. The test file lives in `host/test/` and runs against PR #3's wasm artefacts. Mark this ordering explicitly in the PR #2 description so reviewers know why `gltri.wasm` integration tests don't yet exist on PR #2's branch.

---

### Task B6: Optional `headless-gl` real-bridge smoke test

**Files:**
- Modify: `host/test/webgl-integration.test.ts` (add a `describe.skipIf` for headless-gl absence).

**Step 1: Detect optional dependency**

```ts
let realGl: { default: unknown } | null = null;
try { realGl = await import('gl'); } catch { /* skipping real-bridge test */ }

describe.skipIf(realGl === null)('webgl integration (headless-gl)', () => {
  it('gltri.wasm renders and glReadPixels returns the triangle colour', async () => {
    const { kernel, pid } = await runProgram('build/programs/gltri.wasm', {
      headlessGl: realGl,
      canvasSize: { width: 400, height: 400 },
    });
    // After the run, sample the centre pixel via a kernel test hook.
    const px = await kernel.gl.readPixelsAt(pid, 200, 200, 1, 1);
    // Centre pixel sits roughly on the green/red boundary; assert it isn't
    // the dark-grey clear colour.
    expect(px[0] + px[1] + px[2]).toBeGreaterThan(50);
  });
});
```

`headless-gl` is documented as an optional dev dep in `host/package.json`:

```json
"optionalDependencies": {
  "gl": "^7.0.0"
}
```

**Step 2: Run (locally only — CI may skip)**

```bash
(cd host && npm install --include=optional gl)
(cd host && npx vitest run webgl-integration)
```

**Step 3: Commit**

```bash
git add host/test/webgl-integration.test.ts host/package.json
git commit -m "host(gles): optional headless-gl real-bridge smoke test"
```

---

### Task B7: Phase B — full gauntlet + open PR #2

**Files:** none (verification only)

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

Then push and open PR #2 in mho22's fork (draft, hold-for-merge):

```bash
git push -u origin explore-webgl-exposition-host
gh pr create --draft --repo mho22/wasm-posix-kernel \
  --base explore-webgl-exposition-kernel --head explore-webgl-exposition-host \
  --title "host(gles): GlContextRegistry + cmdbuf decoder + Vitest with gltri.wasm" \
  --body "..."
```

PR body: cross-link to PR #1 + design RFC. List Tasks B1–B6. Note the Phase-ordering caveat from Task B5 (integration tests for `gltri.wasm` actually land in PR #3 because they need the sysroot stubs).

---

## Phase C — Sysroot stubs + browser GL demo (PR #3)

### Task C1: Khronos headers vendored

**Files:**
- Create: `musl-overlay/include/EGL/egl.h`
- Create: `musl-overlay/include/EGL/eglplatform.h`
- Create: `musl-overlay/include/GLES2/gl2.h`
- Create: `musl-overlay/include/GLES2/gl2platform.h`
- Create: `musl-overlay/include/GLES2/gl2ext.h`
- Create: `musl-overlay/include/GLES3/gl3.h`
- Create: `musl-overlay/include/GLES3/gl3platform.h`
- Create: `musl-overlay/include/KHR/khrplatform.h`

**Step 1: Vendor verbatim**

Download the API-stable headers from the [Khronos OpenGL Registry](https://registry.khronos.org/EGL/api/EGL/) and [GLES Registry](https://registry.khronos.org/OpenGL/api/GLES2/). Place each at the path shown above. Do not modify them. Total: ~3000 lines of upstream code.

**Step 2: Make them visible to `wasm32posix-cc`**

The `wasm32posix-cc` toolchain wraps clang with the `musl-overlay/` include search path already; verify:

```bash
echo '#include <EGL/egl.h>' | wasm32posix-cc -E -x c - 2>&1 | head -5
echo '#include <GLES2/gl2.h>' | wasm32posix-cc -E -x c - 2>&1 | head -5
```

Expected: includes resolve, no errors.

**Step 3: Commit**

```bash
git add musl-overlay/include/EGL musl-overlay/include/GLES2 \
        musl-overlay/include/GLES3 musl-overlay/include/KHR
git commit -m "sysroot(gles): vendor EGL/GLES2/GLES3/KHR headers from Khronos"
```

---

### Task C2: `glue/libegl_stub.c` (~250 LoC)

**Files:**
- Create: `glue/libegl_stub.c`

**Step 1: Implement**

Single global `struct egl_state { int fd; bool initialized; EGLContext cur_ctx; EGLSurface cur_sfc; EGLint last_error; uint8_t *cmdbuf; };` plus the eight v1 entry points + small stubs:

```c
// glue/libegl_stub.c
//
// Hand-written EGL implementation for /dev/dri/renderD128.
// See docs/plans/2026-04-28-webgl-gles2-design.md §5.

#include <EGL/egl.h>
#include <EGL/eglplatform.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "glue/gl_abi.h"   // mirror of shared::gl::* — see Task C3.

static struct {
  int fd;
  bool initialized;
  EGLContext cur_ctx;
  EGLSurface cur_sfc;
  EGLint last_error;
  uint8_t *cmdbuf;
  uint8_t *cursor;
} S = { .fd = -1, .last_error = EGL_SUCCESS };

static int open_renderd(void) {
  if (S.fd >= 0) return S.fd;
  S.fd = open("/dev/dri/renderD128", O_RDWR);
  if (S.fd < 0) S.last_error = EGL_BAD_ALLOC;
  return S.fd;
}

EGLDisplay eglGetDisplay(EGLNativeDisplayType native) {
  (void)native;
  if (open_renderd() < 0) return EGL_NO_DISPLAY;
  return (EGLDisplay)(intptr_t)1;
}

EGLBoolean eglInitialize(EGLDisplay dpy, EGLint *maj, EGLint *min) {
  (void)dpy;
  if (S.fd < 0) { S.last_error = EGL_NOT_INITIALIZED; return EGL_FALSE; }
  // Pass our compile-time OP_VERSION so the kernel can reject mismatches
  // up-front (see A6's GLIO_INIT handler). A drift here surfaces as
  // EGL_NOT_INITIALIZED rather than as a silent cmdbuf decode error
  // later.
  uint32_t client_op_version = OP_VERSION;
  if (ioctl(S.fd, GLIO_INIT, &client_op_version) < 0) {
    S.last_error = EGL_NOT_INITIALIZED;
    return EGL_FALSE;
  }
  S.initialized = true;
  if (maj) *maj = 1; if (min) *min = 5;
  return EGL_TRUE;
}

EGLBoolean eglTerminate(EGLDisplay dpy) {
  (void)dpy;
  if (S.fd >= 0) ioctl(S.fd, GLIO_TERMINATE, NULL);
  if (S.cmdbuf) { munmap(S.cmdbuf, CMDBUF_LEN); S.cmdbuf = NULL; }
  if (S.fd >= 0) { close(S.fd); S.fd = -1; }
  S.initialized = false;
  return EGL_TRUE;
}

EGLBoolean eglChooseConfig(EGLDisplay dpy, const EGLint *attrs,
                           EGLConfig *cfgs, EGLint cnt, EGLint *num) {
  (void)dpy; (void)attrs;
  if (cfgs && cnt >= 1) cfgs[0] = (EGLConfig)(intptr_t)1;
  if (num) *num = 1;
  return EGL_TRUE;
}

EGLContext eglCreateContext(EGLDisplay dpy, EGLConfig cfg,
                            EGLContext share, const EGLint *attrs) {
  (void)dpy; (void)cfg; (void)share;
  if (!S.initialized) { S.last_error = EGL_NOT_INITIALIZED; return EGL_NO_CONTEXT; }
  struct gl_context_attrs ca = { .client_version = 2 };
  for (const EGLint *p = attrs; attrs && *p != EGL_NONE; p += 2) {
    if (*p == EGL_CONTEXT_CLIENT_VERSION) ca.client_version = (uint32_t)p[1];
  }
  if (ioctl(S.fd, GLIO_CREATE_CONTEXT, &ca) < 0) { S.last_error = EGL_BAD_ALLOC; return EGL_NO_CONTEXT; }
  S.cur_ctx = (EGLContext)(intptr_t)1;
  return S.cur_ctx;
}

EGLSurface eglCreatePbufferSurface(EGLDisplay dpy, EGLConfig cfg, const EGLint *attrs) {
  (void)dpy; (void)cfg;
  if (!S.initialized) { S.last_error = EGL_NOT_INITIALIZED; return EGL_NO_SURFACE; }
  struct gl_surface_attrs sa = { .kind = WPK_SURFACE_PBUFFER, .config_id = 1 };
  for (const EGLint *p = attrs; attrs && *p != EGL_NONE; p += 2) {
    if      (*p == EGL_WIDTH)  sa.width  = (uint32_t)p[1];
    else if (*p == EGL_HEIGHT) sa.height = (uint32_t)p[1];
  }
  if (ioctl(S.fd, GLIO_CREATE_SURFACE, &sa) < 0) { S.last_error = EGL_BAD_ALLOC; return EGL_NO_SURFACE; }
  S.cur_sfc = (EGLSurface)(intptr_t)1;
  return S.cur_sfc;
}

EGLSurface eglCreateWindowSurface(EGLDisplay dpy, EGLConfig cfg,
                                  EGLNativeWindowType win, const EGLint *attrs) {
  (void)dpy; (void)cfg; (void)attrs;
  if (win != EGL_WPK_SURFACE_DEFAULT) {
    S.last_error = EGL_BAD_NATIVE_WINDOW; return EGL_NO_SURFACE;
  }
  struct gl_surface_attrs sa = { .kind = WPK_SURFACE_DEFAULT, .config_id = 1 };
  if (ioctl(S.fd, GLIO_CREATE_SURFACE, &sa) < 0) { S.last_error = EGL_BAD_ALLOC; return EGL_NO_SURFACE; }
  S.cur_sfc = (EGLSurface)(intptr_t)1;
  return S.cur_sfc;
}

EGLBoolean eglMakeCurrent(EGLDisplay dpy, EGLSurface draw, EGLSurface read, EGLContext ctx) {
  (void)dpy; (void)read;
  if (!S.initialized) { S.last_error = EGL_NOT_INITIALIZED; return EGL_FALSE; }
  if (draw != S.cur_sfc || ctx != S.cur_ctx) { S.last_error = EGL_BAD_MATCH; return EGL_FALSE; }
  if (ioctl(S.fd, GLIO_MAKE_CURRENT, NULL) < 0) { S.last_error = EGL_BAD_MATCH; return EGL_FALSE; }
  // Map the cmdbuf on first MakeCurrent.
  if (!S.cmdbuf) {
    S.cmdbuf = mmap(NULL, CMDBUF_LEN, PROT_READ | PROT_WRITE, MAP_SHARED, S.fd, 0);
    if (S.cmdbuf == MAP_FAILED) { S.cmdbuf = NULL; S.last_error = EGL_BAD_ALLOC; return EGL_FALSE; }
    S.cursor = S.cmdbuf;
    gles_init_cmdbuf(S.cmdbuf, &S.cursor, S.fd);    // exported by libGLESv2 stub
  }
  return EGL_TRUE;
}

EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface sfc) {
  (void)dpy; (void)sfc;
  gles_flush();                                       // exported by libGLESv2 stub
  ioctl(S.fd, GLIO_PRESENT, NULL);
  return EGL_TRUE;
}

EGLint eglGetError(void)             { EGLint e = S.last_error; S.last_error = EGL_SUCCESS; return e; }
const char *eglQueryString(EGLDisplay dpy, EGLint name) {
  (void)dpy;
  if (name == EGL_VENDOR)     return "wasm-posix-kernel";
  if (name == EGL_VERSION)    return "1.5";
  if (name == EGL_EXTENSIONS) return "EGL_KHR_create_context EGL_KHR_surfaceless_context";
  return "";
}

void (*eglGetProcAddress(const char *procname))(void) {
  // v1: only forward to the libGLESv2 entries that exist; otherwise NULL.
  return gles_get_proc_address(procname);
}

EGLBoolean eglDestroyContext(EGLDisplay dpy, EGLContext ctx) {
  (void)dpy; (void)ctx;
  if (S.fd >= 0 && S.cur_ctx) ioctl(S.fd, GLIO_DESTROY_CONTEXT, NULL);
  S.cur_ctx = NULL;
  return EGL_TRUE;
}

EGLBoolean eglDestroySurface(EGLDisplay dpy, EGLSurface sfc) {
  (void)dpy; (void)sfc;
  if (S.fd >= 0 && S.cur_sfc) ioctl(S.fd, GLIO_DESTROY_SURFACE, NULL);
  S.cur_sfc = NULL;
  return EGL_TRUE;
}

EGLBoolean eglWaitGL(void)   { gles_flush(); return EGL_TRUE; }
EGLBoolean eglSwapInterval(EGLDisplay dpy, EGLint interval) { (void)dpy; (void)interval; return EGL_TRUE; }

// eglut calls eglBindAPI(EGL_OPENGL_ES_API) before eglCreateContext. v1
// only supports GLES, so this is a no-op that always succeeds. (Real EGL
// would track the bound API and reject GLES context creation under
// EGL_OPENGL_API; we don't need that distinction yet.)
EGLBoolean eglBindAPI(EGLenum api) { (void)api; return EGL_TRUE; }
```

**Step 2: Static archive build**

See Task C4.

**Step 3: Commit (after Task C3)**

Co-commit with libGLESv2 to keep the EGL ↔ GLES split self-consistent.

---

### Task C3: `glue/libglesv2_stub.c` (~550 LoC) — `gl_emit()` + 80 entry points + sync queries

**Files:**
- Create: `glue/libglesv2_stub.c`
- Create: `glue/gl_abi.h` — C mirror of `shared::gl::*` constants/structs.

**Step 1: `gl_abi.h`**

```c
// glue/gl_abi.h
//
// Mirror of crates/shared/src/gl.rs. Hand-maintained in v1; promoted to a
// generated artefact in v2 (see design doc §9). On every change here, also
// edit shared::gl and bump shared::gl::OP_VERSION + ABI_VERSION as warranted.
#ifndef WPK_GL_ABI_H
#define WPK_GL_ABI_H
#include <stdint.h>

#define CMDBUF_LEN          (1u << 20)
#define OP_VERSION          1u

#define GLIO_INIT            0x40
#define GLIO_TERMINATE       0x41
#define GLIO_CREATE_CONTEXT  0x42
#define GLIO_DESTROY_CONTEXT 0x43
#define GLIO_CREATE_SURFACE  0x44
#define GLIO_DESTROY_SURFACE 0x45
#define GLIO_MAKE_CURRENT    0x46
#define GLIO_SUBMIT          0x47
#define GLIO_PRESENT         0x48
#define GLIO_QUERY           0x49

#define WPK_SURFACE_DEFAULT  1u
#define WPK_SURFACE_PBUFFER  2u
#define EGL_WPK_SURFACE_DEFAULT ((void*)(intptr_t)0xDEFA017)

// Opcodes — keep in lockstep with shared::gl::OP_*.
#define OP_CLEAR                       0x0001
#define OP_CLEAR_COLOR                 0x0002
// ... full set ...
#define OP_FRAMEBUFFER_RENDERBUFFER    0x0706

// Sync query op tags.
#define QOP_GET_ERROR                  0x01
// ... full set ...
#define QOP_CHECK_FB_STATUS            0x0C

struct gl_submit_info { uint32_t offset, length; };
struct gl_context_attrs { uint32_t client_version; uint32_t reserved[3]; };
struct gl_surface_attrs { uint32_t kind, width, height, config_id, reserved[4]; };
struct gl_query_info {
  uint32_t op, in_buf_ptr, in_buf_len, out_buf_ptr, out_buf_len, reserved;
};
#endif
```

**Step 2: `gl_emit()` core (~80 LoC)**

```c
// glue/libglesv2_stub.c
#include <GLES2/gl2.h>
#include <GLES3/gl3.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>

#include "glue/gl_abi.h"

static uint8_t *g_base = NULL;
static uint8_t *g_cursor = NULL;
static int      g_fd = -1;

void gles_init_cmdbuf(uint8_t *base, uint8_t **cursor_out, int fd) {
  g_base = base; g_cursor = base; g_fd = fd;
  *cursor_out = g_cursor;
}

void gles_flush(void) {
  if (!g_base || !g_cursor || g_cursor == g_base) return;
  struct gl_submit_info si = { .offset = 0, .length = (uint32_t)(g_cursor - g_base) };
  ioctl(g_fd, GLIO_SUBMIT, &si);
  g_cursor = g_base;
}

static inline void w_u16(uint8_t **c, uint16_t v) { memcpy(*c, &v, 2); *c += 2; }
static inline void w_u32(uint8_t **c, uint32_t v) { memcpy(*c, &v, 4); *c += 4; }
static inline void w_i32(uint8_t **c, int32_t v)  { memcpy(*c, &v, 4); *c += 4; }
static inline void w_f32(uint8_t **c, float v)    { memcpy(*c, &v, 4); *c += 4; }
static inline void w_blob(uint8_t **c, const void *p, size_t n) {
  w_u32(c, (uint32_t)n); memcpy(*c, p, n); *c += n;
}

static size_t fmt_payload_len(const char *fmt, va_list ap) {
  size_t n = 0;
  va_list copy; va_copy(copy, ap);
  for (const char *p = fmt; *p; p++) {
    switch (*p) {
      case 'u': case 'i': case 'f': va_arg(copy, uint32_t); n += 4; break;
      case 'b': {
        (void)va_arg(copy, const void *);
        size_t blen = va_arg(copy, size_t);
        n += 4 + blen; break;
      }
    }
  }
  va_end(copy);
  return n;
}

static void gl_emit(uint16_t op, const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  size_t plen = fmt_payload_len(fmt, ap);
  va_end(ap);
  // The TLV envelope is `{u16 op, u16 payload_len, payload}`; payload_len
  // is u16 so a single op cannot exceed 65 535 bytes. v1 demos (es2gears)
  // top out at ~23 KB; bigger payloads (e.g. glTexImage2D for a >64 KB
  // texture, or a giant glBufferData) would silently truncate via the
  // u16 cast and corrupt the cmdbuf for everything after. v2 widens the
  // envelope to u32 (ABI break — own design pass). For v1, fail loudly:
  if (plen > 0xFFFF) {
    fprintf(stderr,
            "gl_emit: payload %zu > 65535 (single-op TLV cap, v1 limit)\n",
            plen);
    abort();
  }
  if (g_cursor + 4 + plen > g_base + CMDBUF_LEN) gles_flush();
  va_start(ap, fmt);
  uint8_t *c = g_cursor;
  w_u16(&c, op); w_u16(&c, (uint16_t)plen);
  for (const char *p = fmt; *p; p++) {
    switch (*p) {
      case 'u': w_u32(&c, va_arg(ap, uint32_t)); break;
      case 'i': w_i32(&c, va_arg(ap, int32_t)); break;
      case 'f': w_f32(&c, (float)va_arg(ap, double)); break;
      case 'b': {
        const void *bp = va_arg(ap, const void *);
        size_t blen = va_arg(ap, size_t);
        w_blob(&c, bp, blen); break;
      }
    }
  }
  va_end(ap);
  g_cursor = c;
}
```

**Step 3: Per-op entry points (~370 LoC for ~80 ops)**

```c
// State
void glClear(GLbitfield mask) { gl_emit(OP_CLEAR, "u", (uint32_t)mask); }
void glClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a) {
  gl_emit(OP_CLEAR_COLOR, "ffff", r, g, b, a);
}
void glViewport(GLint x, GLint y, GLsizei w, GLsizei h) {
  gl_emit(OP_VIEWPORT, "iiii", x, y, w, h);
}
void glScissor(GLint x, GLint y, GLsizei w, GLsizei h) {
  gl_emit(OP_SCISSOR, "iiii", x, y, w, h);
}
void glEnable(GLenum cap)   { gl_emit(OP_ENABLE,  "u", (uint32_t)cap); }
void glDisable(GLenum cap)  { gl_emit(OP_DISABLE, "u", (uint32_t)cap); }
// ... blendFunc, depthFunc, cullFace, frontFace, lineWidth, pixelStorei ...

// Buffers
static uint32_t g_next_buffer = 1;
void glGenBuffers(GLsizei n, GLuint *out) {
  // client-side names — host learns them on first BindBuffer/BufferData
  uint32_t names[16];
  if (n > 16) n = 16;
  for (GLsizei i = 0; i < n; i++) {
    names[i] = g_next_buffer++;
    out[i] = names[i];
  }
  // Append OP_GEN_BUFFERS so host pre-allocates.
  // payload: u32 n, then n × u32
  // Use 'b' opcode.
  gl_emit(OP_GEN_BUFFERS, "b", names, (size_t)n * 4);
}
void glDeleteBuffers(GLsizei n, const GLuint *names) {
  gl_emit(OP_DELETE_BUFFERS, "b", names, (size_t)n * 4);
}
void glBindBuffer(GLenum target, GLuint buf) {
  gl_emit(OP_BIND_BUFFER, "uu", (uint32_t)target, (uint32_t)buf);
}
void glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
  gl_emit(OP_BUFFER_DATA, "ubu", (uint32_t)target, data, (size_t)size, (uint32_t)usage);
}
void glBufferSubData(GLenum target, GLintptr off, GLsizeiptr size, const void *data) {
  // Payload: u32 target, i32 offset, blob{u32 size, bytes...}.
  // Matches Task B3's decoder layout for OP_BUFFER_SUB_DATA.
  gl_emit(OP_BUFFER_SUB_DATA, "uib",
          (uint32_t)target, (int32_t)off, data, (size_t)size);
}

// Textures, shaders/programs, uniforms, vertex attribs, draws, VAOs, FBOs:
// one `gl_emit` per function, payload format determined by the op.
// ~350 LoC total once all ~80 are in.

// Sync queries — flush, then GLIO_QUERY.
GLenum glGetError(void) {
  gles_flush();
  uint32_t out;
  struct gl_query_info qi = {
    .op = QOP_GET_ERROR, .out_buf_ptr = (uint32_t)(uintptr_t)&out, .out_buf_len = 4,
  };
  ioctl(g_fd, GLIO_QUERY, &qi);
  return (GLenum)out;
}

GLint glGetUniformLocation(GLuint program, const GLchar *name) {
  gles_flush();
  uint8_t in[256];
  size_t name_len = strlen(name);
  if (8 + name_len > sizeof in) return -1;
  uint32_t prog_u32 = program, name_len_u32 = (uint32_t)name_len;
  memcpy(in,     &prog_u32,     4);
  memcpy(in + 4, &name_len_u32, 4);
  memcpy(in + 8, name, name_len);

  int32_t loc;
  struct gl_query_info qi = {
    .op = QOP_GET_UNIFORM_LOC,
    .in_buf_ptr  = (uint32_t)(uintptr_t)in,  .in_buf_len  = (uint32_t)(8 + name_len),
    .out_buf_ptr = (uint32_t)(uintptr_t)&loc, .out_buf_len = 4,
  };
  ioctl(g_fd, GLIO_QUERY, &qi);
  return loc;
}

// glGetIntegerv, glGetString, glGetAttribLocation, glGetShaderiv,
// glGetShaderInfoLog, glGetProgramiv, glGetProgramInfoLog,
// glCheckFramebufferStatus, glReadPixels — ~150 LoC total.

void *gles_get_proc_address(const char *name) {
  // Linear scan of ~80 entries. Returns NULL if name isn't a function we
  // implement, so callers that probe for extensions get a clean answer.
  // Simple table — ~50 LoC.
  // ...
  return NULL;
}
```

**Step 4: Build the static archives**

See Task C4.

**Step 5: Commit (one commit for both stubs + the abi header)**

```bash
git add glue/libegl_stub.c glue/libglesv2_stub.c glue/gl_abi.h
git commit -m "sysroot(gles): hand-written libEGL + libGLESv2 stubs (~800 LoC)"
```

---

### Task C4: Sysroot library build — `libEGL.a` + `libGLESv2.a`

**Files:**
- Modify: `build.sh` (the top-level kernel/sysroot build) to compile `glue/libegl_stub.c` and `glue/libglesv2_stub.c` into static archives placed at `sysroot-overlay/lib/libEGL.a` and `sysroot-overlay/lib/libGLESv2.a`.
- Modify: `wasm32posix-cc` (the wrapper) to auto-link `-lEGL -lGLESv2` when the program includes `<EGL/egl.h>` or `<GLES2/gl2.h>` (mirror the existing auto-link of `channel_syscall.c`).

**Step 1: Build commands**

In `build.sh`, after the existing musl-overlay compile loop, append:

```bash
echo "[build] glue/libegl_stub.o + libEGL.a"
"$CLANG" --target=wasm32 -Os -fPIC -I "$REPO_ROOT/musl-overlay/include" \
  -c "$REPO_ROOT/glue/libegl_stub.c" -o "$BUILD_OUT/libegl_stub.o"
"$LLVM_AR" rcs "$REPO_ROOT/sysroot-overlay/lib/libEGL.a" "$BUILD_OUT/libegl_stub.o"

echo "[build] glue/libglesv2_stub.o + libGLESv2.a"
"$CLANG" --target=wasm32 -Os -fPIC -I "$REPO_ROOT/musl-overlay/include" \
  -c "$REPO_ROOT/glue/libglesv2_stub.c" -o "$BUILD_OUT/libglesv2_stub.o"
"$LLVM_AR" rcs "$REPO_ROOT/sysroot-overlay/lib/libGLESv2.a" "$BUILD_OUT/libglesv2_stub.o"
```

**Step 2: Auto-link in `wasm32posix-cc`**

The wrapper currently inspects sources / includes for `channel_syscall.c` triggers; extend that logic to add `-lEGL -lGLESv2` (and `-lm`) when any include line resolves to a file under `musl-overlay/include/EGL/` or `musl-overlay/include/GLES{2,3}/`. Conservative behaviour: if the user passes `-lEGL` explicitly, do not double-add.

**Step 3: Smoke build**

```bash
bash build.sh
ls sysroot-overlay/lib/libEGL.a sysroot-overlay/lib/libGLESv2.a

# Try compiling an empty program that just includes the headers — proves
# linkage works.
cat > /tmp/glsmoke.c <<'EOF'
#include <EGL/egl.h>
#include <GLES2/gl2.h>
int main(void) { (void)eglGetDisplay; (void)glClear; return 0; }
EOF
wasm32posix-cc /tmp/glsmoke.c -o /tmp/glsmoke.wasm
```

Expected: builds without unresolved symbols.

**Step 4: Commit**

```bash
git add build.sh sdk/wasm32posix-cc.* sysroot-overlay/lib/.gitignore
git commit -m "sysroot(gles): build libEGL.a + libGLESv2.a; auto-link in wasm32posix-cc"
```

(The `.gitignore` adjustment is to track or skip the `.a` artefacts depending on existing repo policy — check how `libchannel.a` etc. are handled.)

---

### Task C5: `programs/gltri.c` builds and runs in Vitest

**Files:**
- Modify: `scripts/build-programs.sh` — append `gltri.c`, `glopen-only.c`, `gloverflow.c` to the build list. (Source files were created in Task B5; this task makes them buildable now that the sysroot stubs exist.)
- Modify: `host/test/centralized-test-helper.ts` if a `glRecorder` hook is needed at the test-helper level (Task B5 referenced it).

**Step 1: Build**

```bash
scripts/build-programs.sh
ls -la build/programs/gltri.wasm build/programs/glopen-only.wasm build/programs/gloverflow.wasm
```

Expected: all three artefacts present, each ≥10 KiB.

**Step 2: Run the deferred Vitest from B5**

```bash
(cd host && npx vitest run webgl-integration)
```

Expected: pass. The recording-bridge assertions in B5's test land here for the first time.

**Step 3: Commit**

```bash
git add scripts/build-programs.sh host/test/centralized-test-helper.ts
git commit -m "examples(gldemo): build gltri/glopen-only/gloverflow + enable B5 tests"
```

---

### Task C5b: `eglut` WPK backend (`wsi/wpk.c`)

`es2gears.c` does not call EGL directly — it uses Mesa's `eglut` harness, which in turn delegates to a WSI backend (`wsi/x11.c` or `wsi/wayland.c` upstream). The clean way to ship es2gears unmodified is to author a third backend, `wsi/wpk.c`, alongside the existing two. This is the same extension pattern Mesa uses; it does **not** count as a platform-gap patch and `eglut.c` itself stays byte-for-byte upstream.

**Files:**
- Create: `examples/libs/es2gears/wpk-backend/wsi/wpk.c` (~90 LoC, structurally mirrors the existing `wsi/x11.c` — see `/tmp/mesa-demos-check/src/egl/eglut/wsi/x11.c` for the reference shape).
- Create: `examples/libs/es2gears/patches/0001-eglut-wsi-add-wpk-support.patch` — one-line addition to `wsi/wsi.c`'s `_eglutGetWindowSystemInterface()` adding a `WPK_SUPPORT` branch alongside `WAYLAND_SUPPORT` / `X11_SUPPORT`. **Cross-compilation hygiene** — same shape Mesa already uses for its own backends; not a platform-gap workaround.
- The cross-compile in Task C6 builds these together with the upstream `eglut.c` + `wsi/wsi.c` (with patch applied) under `-DWPK_SUPPORT`.

**Reference: the actual eglut backend contract (from `wsi/wsi.h` + `wsi/wsi.c`)**

The first review pass got this wrong. Backends do **not** export `_eglutNative*` directly — those wrappers live in `wsi/wsi.c` and trampoline through `_eglut->wsi.<fn>()`. Each backend instead exports a single function returning a struct of function pointers:

```c
// from wsi/wsi.h:
struct eglut_wsi_interface {
   void (*init_display)(void);
   void (*fini_display)(void);
   void (*init_window)(struct eglut_window *win, const char *title,
                       int x, int y, int w, int h);
   void (*event_loop)(void);
   void (*fini_window)(struct eglut_window *win);
};

#ifdef WPK_SUPPORT
struct eglut_wsi_interface wpk_wsi_interface(void);
#endif

// from wsi/wsi.c (after our patch):
struct eglut_wsi_interface
_eglutGetWindowSystemInterface(void)
{
#if defined(WAYLAND_SUPPORT) && defined(X11_SUPPORT)
   ...
#elif defined(WAYLAND_SUPPORT)
   return wayland_wsi_interface();
#elif defined(X11_SUPPORT)
   return x11_wsi_interface();
#elif defined(WPK_SUPPORT)              // ← one-line addition
   return wpk_wsi_interface();
#endif
}
```

`eglut.c` itself remains byte-for-byte upstream — it calls `_eglut->wsi = _eglutGetWindowSystemInterface()` once, then dispatches every native call through `_eglut->wsi.<fn>()`.

**Step 1: Implement the WPK backend (`wsi/wpk.c`)**

```c
// examples/libs/es2gears/wpk-backend/wsi/wpk.c
//
// eglut WSI backend for wasm-posix-kernel. Same shape as wsi/x11.c:
// static fn impls + a single `wpk_wsi_interface()` exporter that
// populates the function-pointer struct. No native window system —
// every window maps to "the default canvas" via the
// EGL_WPK_SURFACE_DEFAULT sentinel that our libEGL recognizes.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
#include <EGL/egl.h>

#include "eglutint.h"
#include "wsi.h"

// The same magic value that libegl_stub.c (Task C2) recognizes as
// "the bound canvas." Defined in <EGL/eglext.h> in our overlay; for
// compilation independence we redeclare it here.
#ifndef EGL_WPK_SURFACE_DEFAULT
#define EGL_WPK_SURFACE_DEFAULT ((void*)(intptr_t)0xDEFA017)
#endif

static struct termios saved_termios;
static int termios_saved = 0;

static void
wpk_init_display(void)
{
   // No native display — eglGetDisplay(EGL_DEFAULT_DISPLAY) is what opens
   // /dev/dri/renderD128 inside libEGL.
   _eglut->native_dpy = EGL_DEFAULT_DISPLAY;
   _eglut->surface_type = EGL_WINDOW_BIT;
}

static void
wpk_fini_display(void)
{
   _eglut->native_dpy = NULL;
}

static void
wpk_init_window(struct eglut_window *win, const char *title,
                int x, int y, int w, int h)
{
   (void)title; (void)x; (void)y;

   // Hand the libEGL stub our magic sentinel; everything downstream
   // (eglCreateWindowSurface) expects to recognize it.
   win->native.u.window = (EGLNativeWindowType)EGL_WPK_SURFACE_DEFAULT;
   win->native.width = w;
   win->native.height = h;
}

static void
wpk_fini_window(struct eglut_window *win)
{
   (void)win;
}

// Put stdin into raw mode so single-key reads work the same way
// fbDOOM's keyboard input does.
static void
raw_termios_install(void)
{
   struct termios t;
   if (tcgetattr(0, &saved_termios) == 0) {
      t = saved_termios;
      t.c_lflag &= ~(ICANON | ECHO);
      t.c_cc[VMIN] = 0;
      t.c_cc[VTIME] = 0;
      if (tcsetattr(0, TCSANOW, &t) == 0) termios_saved = 1;
   }
}

static void
raw_termios_restore(void)
{
   if (termios_saved) tcsetattr(0, TCSANOW, &saved_termios);
}

static void
wpk_event_loop(void)
{
   // Trivial loop: pump idle + display callbacks. The kernel host's
   // RAF loop is what actually paces us — eglSwapBuffers blocks on
   // GLIO_PRESENT until the host is ready for the next frame.
   raw_termios_install();
   atexit(raw_termios_restore);

   while (!_eglut->redisplay) {
      char buf[8];
      int n = read(0, buf, sizeof buf);
      if (n > 0 && _eglut->current && _eglut->current->keyboard_cb) {
         for (int i = 0; i < n; i++)
            _eglut->current->keyboard_cb(buf[i]);
      }
      if (_eglut->idle_cb) _eglut->idle_cb();
      if (_eglut->current && _eglut->current->display_cb)
         _eglut->current->display_cb();
   }
}

// The single exported symbol — populated from the function-pointer
// struct declared in wsi/wsi.h. wsi.c's _eglutGetWindowSystemInterface()
// returns the result of this when -DWPK_SUPPORT is defined.
struct eglut_wsi_interface
wpk_wsi_interface(void)
{
   struct eglut_wsi_interface iface = {
      .init_display = wpk_init_display,
      .fini_display = wpk_fini_display,
      .init_window  = wpk_init_window,
      .event_loop   = wpk_event_loop,
      .fini_window  = wpk_fini_window,
   };
   return iface;
}
```

(The exact eglut internals — `_eglut->current`, `_eglut->idle_cb`, `_eglut->redisplay`, the `keyboard_cb` / `display_cb` pointers, the `EGLUT_KEY_*` codes for arrow keys — should be lifted from `eglutint.h` at port time. Cross-check against the cloned mesa-demos repo before committing.)

**Step 2: Patch `wsi/wsi.c` to add a `WPK_SUPPORT` branch**

```diff
--- a/src/egl/eglut/wsi/wsi.c
+++ b/src/egl/eglut/wsi/wsi.c
@@ -19,6 +19,8 @@ _eglutGetWindowSystemInterface(void)
    return wayland_wsi_interface();
 #elif defined(X11_SUPPORT)
    return x11_wsi_interface();
+#elif defined(WPK_SUPPORT)
+   return wpk_wsi_interface();
 #endif
 }
```

The corresponding declaration in `wsi/wsi.h` (already present for X11/Wayland under `#ifdef`) gets a parallel `#ifdef WPK_SUPPORT` block. This is the same `#elif` pattern Mesa upstream already uses for its own backends and is the idiomatic way to add a new platform — patching `wsi.c` is *cross-compilation hygiene*, not a platform-gap workaround.

**Step 3: Validate the backend compiles + exports the symbol**

A standalone compile against the headers, plus a quick `wasm-objdump` to confirm `wpk_wsi_interface` is in fact exported (a static-only build would silently link-fail at C6 with no diagnostic until the eglut harness tried to dispatch through `_eglut->wsi.<fn>()`):

```bash
wasm32posix-cc -c -DWPK_SUPPORT \
  -I"$REPO_ROOT/examples/libs/es2gears/mesa-demos-src/src/egl/eglut" \
  -I"$REPO_ROOT/musl-overlay/include" \
  examples/libs/es2gears/wpk-backend/wsi/wpk.c \
  -o /tmp/wpk-backend.o
wasm-objdump -x /tmp/wpk-backend.o | grep -F 'wpk_wsi_interface'
```

Expected: clean compile, and `wpk_wsi_interface` shows up as a non-static export.

**Step 4: Commit**

```bash
git add examples/libs/es2gears/wpk-backend/ \
        examples/libs/es2gears/patches/0001-eglut-wsi-add-wpk-support.patch
git commit -m "examples(gldemo): eglut WSI backend for wpk (wsi/wpk.c + wsi.c patch)"
```

---

### Task C6: `examples/libs/es2gears/build-es2gears.sh`

**Files:**
- Create: `examples/libs/es2gears/build-es2gears.sh`
- Possibly: `examples/libs/es2gears/patches/*.patch` — only for cross-compile hygiene.

`es2gears.c` itself is just the demo body; the EGL boilerplate lives in `eglut.c` + a WSI backend (`wsi/x11.c`, `wsi/wayland.c`, plus our new `wsi/wpk.c` from Task C5b). The build links them all together. Both `eglut.c` and `es2gears.c` are byte-for-byte upstream — no platform-gap patches.

**Step 1: Build script**

```bash
#!/usr/bin/env bash
# examples/libs/es2gears/build-es2gears.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/mesa-demos-src"

if [ ! -d "$SRC" ]; then
  git clone --depth 1 https://gitlab.freedesktop.org/mesa/demos "$SRC"
fi

OUT="$REPO_ROOT/examples/browser/public/assets/gldemo/es2gears.wasm"
mkdir -p "$(dirname "$OUT")"

# Apply local patches (cross-compile hygiene only — never platform gaps).
for p in "$HERE"/patches/*.patch; do
  [ -f "$p" ] && (cd "$SRC" && patch -p1 --batch --forward < "$p" || true)
done

# es2gears depends on eglut + a WSI backend + matrix.c. We link the
# upstream eglut + wsi/wsi.c + util/matrix.c byte-for-byte, plus our
# own wsi/wpk.c (Task C5b) as the platform backend. wsi/wsi.c gets
# the one-line `WPK_SUPPORT` patch applied above (cross-compile
# hygiene — same shape Mesa uses for X11/Wayland). `eglut.c` and
# `es2gears.c` themselves remain byte-for-byte upstream.
#
# `-DWPK_SUPPORT` selects our backend in `_eglutGetWindowSystemInterface()`.
EGLUT_DIR="$SRC/src/egl/eglut"
UTIL_DIR="$SRC/src/util"
WPK_BACKEND="$HERE/wpk-backend/wsi/wpk.c"

wasm32posix-cc \
  -Os -DEGL_DEFAULT_DISPLAY=0 -DWPK_SUPPORT \
  -I"$REPO_ROOT/musl-overlay/include" \
  -I"$EGLUT_DIR" \
  -I"$UTIL_DIR" \
  "$SRC/src/egl/opengles2/es2gears.c" \
  "$EGLUT_DIR/eglut.c" \
  "$EGLUT_DIR/wsi/wsi.c" \
  "$WPK_BACKEND" \
  "$UTIL_DIR/matrix.c" \
  -lEGL -lGLESv2 -lm \
  -o "$OUT"

# Run fork-instrument (project convention).
"$REPO_ROOT/sdk/fork-instrument" "$OUT"

echo "built: $OUT"
```

**Step 2: Run**

```bash
bash examples/libs/es2gears/build-es2gears.sh
ls -la examples/browser/public/assets/gldemo/es2gears.wasm
```

Expected: ~80–150 KiB wasm (slightly larger than the original "single-file" estimate because eglut + matrix are now included).

**Step 3: Likely gotchas**

Apply patches as needed for these (in increasing order of likelihood):

- `eglGetPlatformDisplay`: the upstream variant some demos use. If unresolved, patch `eglGetPlatformDisplay(...)` → `eglGetDisplay(EGL_DEFAULT_DISPLAY)`. This is a *cross-compilation hygiene* patch, not a platform-gap workaround.
- Stray `<GL/gl.h>` includes: patch out.
- `eglut.c` references X11 / Wayland headers under `#ifdef`: should be guarded by `HAVE_X11` / `HAVE_WAYLAND` and not built into the wpk binary. If they leak in, add `-DHAVE_NONE_OF_THE_ABOVE` or whatever the existing convention is.
- `gettimeofday` and `usleep`: already implemented.

Surface-creation does **not** belong on this list — it is handled at the eglut WSI layer (Task C5b's `wsi/wpk.c` writes the `EGL_WPK_SURFACE_DEFAULT` sentinel into `win->native.u.window`, and the libEGL stub from Task C2 recognizes it). Do **not** patch `eglCreateWindowSurface` calls in `es2gears.c` or `eglut.c`.

**Step 4: Commit**

```bash
git add examples/libs/es2gears/build-es2gears.sh examples/libs/es2gears/patches/
git commit -m "examples(gldemo): es2gears cross-compile script"
```

---

### Task C7: GL demo page (`examples/browser/pages/gldemo/`)

**Files:**
- Create: `examples/browser/pages/gldemo/index.html`
- Create: `examples/browser/pages/gldemo/main.ts`
- Modify: `examples/browser/vite.config.ts` (or whatever registers pages) to include the new page.

**Step 1: HTML**

```html
<!-- examples/browser/pages/gldemo/index.html -->
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>GLES2 demo (es2gears on wasm-posix-kernel)</title>
  <style>
    body { background: #111; color: #ccc; font-family: monospace; margin: 0; padding: 20px; }
    canvas { display: block; background: #000; outline: none; image-rendering: pixelated; }
    #row { display: flex; gap: 12px; align-items: center; }
    #status { margin-top: 8px; }
  </style>
</head>
<body>
  <h1>GLES2 — es2gears</h1>
  <div id="row">
    <button id="start">Start</button>
    <select id="prog">
      <option value="gltri">hello triangle</option>
      <option value="es2gears" selected>es2gears</option>
    </select>
  </div>
  <canvas id="gl" tabindex="0" width="400" height="400"></canvas>
  <div id="status">Click Start to boot.</div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

**Step 2: TS**

```ts
// examples/browser/pages/gldemo/main.ts
import { BrowserKernel } from '../../lib/browser-kernel.js';
import { attachGlCanvas } from '../../../host/src/webgl/canvas.js';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const progSel  = document.getElementById('prog')  as HTMLSelectElement;
const canvas   = document.getElementById('gl')    as HTMLCanvasElement;
const status   = document.getElementById('status')!;

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  progSel.disabled  = true;
  status.textContent = 'Booting kernel...';

  const kernel = await BrowserKernel.create();

  status.textContent = 'Spawning ' + progSel.value + '.wasm ...';
  const url = '/assets/gldemo/' + progSel.value + '.wasm';
  const wasmBytes = await fetch(url).then(r => r.arrayBuffer());
  const pid = await kernel.spawn(new Uint8Array(wasmBytes), {
    argv: [progSel.value], env: ['HOME=/home/gl', 'TERM=linux'], cwd: '/home/gl',
  });

  attachGlCanvas(canvas, kernel.gl, pid);

  canvas.focus();
  canvas.addEventListener('keydown', (e) => {
    const ch = e.key.length === 1 ? e.key.charCodeAt(0) : null;
    if (ch !== null) {
      kernel.appendStdinData(pid, new Uint8Array([ch]));
      e.preventDefault();
    }
  });
  canvas.addEventListener('click', () => canvas.focus());

  status.textContent = 'Running. (es2gears prints FPS to stdout.)';
});
```

`attachGlCanvas` lives in `host/src/webgl/canvas.ts` and is a tiny shim over the registry — created in this task or in Task B4 if the OffscreenCanvas-transfer plumbing already lives there.

**Step 3: Run dev server**

```bash
cd examples/browser && npm run dev
```

Open the printed URL, navigate to the gldemo page. Click Start. Pick "hello triangle" first (smaller risk surface), then "es2gears".

**Step 4: Commit**

```bash
git add examples/browser/pages/gldemo/ examples/browser/vite.config.ts \
        host/src/webgl/canvas.ts
git commit -m "examples(gldemo): browser GL demo page wiring kernel + canvas + keyboard"
```

---

### Task C8: Manual browser verification (the gate)

**Files:** none (manual)

Per CLAUDE.md "for UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete."

**Run through the success criteria from the design doc (§1):**

1. `gltri.wasm` triangle renders within ~1 s of clicking Start. The triangle is visible at ~the centre of the canvas.
2. `es2gears.wasm`: three coloured gears rotate at the demo's natural rate.
3. The demo's stdout FPS counter shows ≥30 fps in Chrome on a 2024 MacBook.
4. Canvas resize re-renders crisply (because WebGL, not bitmap blits).
5. DevTools → Console: zero errors.

**Cross-browser (the spike was one browser only):**

- Chrome (or Chromium-derived: Edge / Brave): GitHub Actions runs against this; treat as the baseline.
- Safari: Apple WebKit — has a history of OffscreenCanvas + WebGL2 quirks. If `gl_create_context` returns null in the worker, fall back to the main-thread proxy (Task B4) and re-test.
- Firefox: Gecko — historically the fastest WebGL2 path; expected to "just work."

If any browser fails, **do not compromise the demo or the kernel**. Identify whether the gap is (a) an unimplemented kernel surface, (b) a host glue bug, (c) a build / sysroot issue, (d) a browser-specific OffscreenCanvas constraint. Fix the root cause, add a regression test where possible.

**Step 1: Re-run the full gauntlet**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

**Step 2: Update docs (CLAUDE.md "Documentation" section)**

- `docs/posix-status.md` — add `/dev/dri/renderD128` row + EGL/GLES2 surface coverage.
- `docs/architecture.md` — new "GL render device" section: the cmdbuf model, the OffscreenCanvas thread story, the Khronos-headers vendoring decision.
- `docs/browser-support.md` — note WebGL2 + OffscreenCanvas as new requirements; cross-browser matrix.
- `docs/sdk-guide.md` — note `-lEGL -lGLESv2` linkage and the EGL header set; auto-link mentioned.
- `docs/porting-guide.md` — short subsection on porting GLES2 software (the `eglGetDisplay`/`pbuffer surface`/`EGL_WPK_SURFACE_DEFAULT` pattern, the cmdbuf invisibility, the sync-query cost).
- `README.md` — `es2gears` in "ported software" + new GL demo screenshot.

```bash
git add docs/ README.md
git commit -m "docs(gles): document /dev/dri/renderD128 surface and gldemo page"
```

**Step 3: Push and open PR #3**

```bash
git push -u origin explore-webgl-exposition-demo
gh pr create --draft --repo mho22/wasm-posix-kernel \
  --base explore-webgl-exposition-host --head explore-webgl-exposition-demo \
  --title "examples(gldemo): es2gears + browser GLES2 demo" \
  --body "..."
```

PR body: cross-link design RFC, plan doc, PRs #1 + #2 in the fork. Summarise C1–C7. Note this is part 3/3. Include the full 6-suite gauntlet block, the cross-browser matrix (which browsers were tested and which combos passed), and an inline screenshot of the running demo for visual confirmation.

**Step 4: Notify user**

Tell the user: "All three implementation PRs are open and verified. The browser GL demo runs through the success criteria across {Chrome, Firefox, Safari — actual list}. Ready to merge in order #1 → #2 → #3 within mho22/wasm-posix-kernel?" Wait for explicit approval.

---

## Final coordinated merge

When the user confirms:

```bash
gh pr ready <pr1> --repo mho22/wasm-posix-kernel
gh pr merge <pr1> --repo mho22/wasm-posix-kernel --squash
gh pr ready <pr2> --repo mho22/wasm-posix-kernel
gh pr merge <pr2> --repo mho22/wasm-posix-kernel --squash
gh pr ready <pr3> --repo mho22/wasm-posix-kernel
gh pr merge <pr3> --repo mho22/wasm-posix-kernel --squash
```

Then on `main` of `mho22/wasm-posix-kernel`, run the full gauntlet one more time to confirm the merged state matches the validated state.

```bash
git checkout main && git pull
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

**Upstream submission (separate decision after merge.)** Per the user's preference, the upstream submission to `brandonpayton/wasm-posix-kernel` is a separate conversation that happens *after* the fork's `main` is green. Options at that point:

- Open a single rebased PR upstream containing the merged stack.
- Cherry-pick the three commits onto a new upstream branch and open them as a 1–3 PR series mirroring the fork's stack.

Discuss with the user before doing either; do not auto-push to upstream.

**Memory update.** Save a project memory entry — `webgl-gles2-shipped.md` — recording: merge commit SHA, `ABI_VERSION` 6 → 7, `OP_VERSION` 1, the cross-browser matrix from C8, and any notable lessons (e.g. "OffscreenCanvas transfer worked first-time on $browser; the main-thread fallback was/wasn't needed"). Reference the design RFC and plan doc commit SHAs for archaeology.

---

## Rollout summary table

| PR | Branch       | Base                              | Phase | New LoC (rough) | New tests | ABI bump |
|----|--------------|-----------------------------------|-------|-----------------|-----------|----------|
| #1 | `explore-webgl-exposition-kernel` | `explore-webgl-exposition-plan`   | A: kernel surface       | ~600 Rust | ~25 cargo unit tests | 6→7 in A9 |
| #2 | `explore-webgl-exposition-host`   | `explore-webgl-exposition-kernel` | B: host registry/decoder| ~500 TS   | ~6 vitest tests       | none     |
| #3 | `explore-webgl-exposition-demo`   | `explore-webgl-exposition-host`   | C: sysroot + demo       | ~800 C + ~150 TS + ~3000 vendored headers | manual browser + ~3 vitest from B5 deferred | none     |

Total: ~1900 LoC of new code (excluding vendored Khronos headers) across three PRs, mirroring fbdev's ~1500-LoC three-PR stack with the larger surface that GL demands.

## Trade-offs already locked in (don't relitigate during implementation)

These were chosen in the design RFC (`docs/plans/2026-04-28-webgl-gles2-design.md` §2 + §5) and pinned by the spike result. Implementation should follow them; if a counter-argument surfaces, raise it as a comment on the relevant PR rather than silently changing course:

- **Cmdbuf TLV format** beats one-syscall-per-call (perf) and beats `eval`-of-JS-string (CSP).
- **TLV envelope is `{u16 op, u16 payload_len, payload}`** — single-op payload capped at 65 535 bytes in v1. Sufficient for `es2gears` (largest op ~23 KB). Any v2 demo with a >64 KB texture upload (e.g. `glTexImage2D` for a 256² RGBA image = 256 KB) will not fit; v2 widens to `u32 payload_len` and bumps `ABI_VERSION`. Do **not** silently widen during v1 implementation — it's an ABI break and requires its own design pass.
- **Render node**, not `/dev/fb0` reuse (semantic correctness + read-back cost).
- **Single context, single owner, single canvas** in v1 (parallels `FB0_OWNER` posture).
- **Hand-written stub, no generator** in v1 (~80-LoC `gl_emit()` is the smallest viable shape; generator deferred to v2 per design §9).
- **OffscreenCanvas in the kernel worker** as the default; main-thread fallback is supported but second-class.
- **Khronos headers vendored unmodified** (no fork; they're stable API headers).
- **`es2gears` ships unmodified** — the EGL surface boilerplate lives in Mesa's `eglut` harness (`eglut.c` + `wsi/<backend>.c`). We add a new backend `wsi/wpk.c` (Task C5b) following the same pattern as the upstream X11 / Wayland backends. `wsi/wsi.c` gets a one-line `#elif defined(WPK_SUPPORT)` patch to add the dispatch arm — same shape Mesa upstream uses for X11 / Wayland, classified as cross-compilation hygiene. `eglut.c` and `es2gears.c` themselves are byte-for-byte upstream. No platform-gap patches.
- **`gltri.c` is the structural test guard, not a Playwright pixel snapshot** (rotation makes snapshots brittle).
- **GL is single-threaded per process in v1.** The libGLESv2 stub keeps a process-global `g_cursor` into the shared cmdbuf; two threads in one process calling GL concurrently race on the cursor and produce undefined output. The stub does **not** assert single-threaded use (that would require `pthread_self()` on the GL hot path). v2 will pick: (a) lock the cursor (simple, slow), or (b) per-thread cmdbufs (complex, fast). v1 demos (`gltri`, `es2gears`) are single-threaded and don't hit this.
- **PR #2 ships with synthetic-only decoder tests.** Task B5's `gltri.wasm` integration test depends on libEGL/libGLESv2 from Phase C and only lights up after PR #3's sysroot stubs land. PR #2's gauntlet exercises the TLV decoder against hand-rolled SharedArrayBuffer fixtures only, not real C-side encoder output. The B5 inline note already flags this; calling it out here so PR #2 reviewers know the integration tier comes online with PR #3.

## Risk register

Issues that could derail the stack mid-implementation, with the planned response:

| Risk | Detection | Response |
|------|-----------|----------|
| Safari OffscreenCanvas + WebGL2 incompatibility | Task C8 cross-browser pass | Promote main-thread fallback (Task B4) to first-class; add capability detect in `attachGlCanvas`. |
| `es2gears` upstream uses something not in our op set | Task C6 build / Task C8 verify | Add the missing op to `shared::gl::OP_*` + bridge.ts + libGLESv2 stub; bump `OP_VERSION` (no `ABI_VERSION` bump unless a struct changes). |
| Cmdbuf overflow at 1 MiB on a heavy demo | Vitest cmdbuf-overflow test in B5 + manual gldemo run | Auto-flush already in `gl_emit`; if perf shows multi-flush per frame, raise `CMDBUF_LEN` (note: ABI snapshot tracks the constant — bump if changed). |
| Single op > 64 KB (TLV envelope cap, v1) | libGLESv2 stub `assert(len <= UINT16_MAX)` at gl_emit time; would also surface as a host decoder error | Affects any demo doing big texture uploads or large `glBufferData`. Out of scope for v1 (`es2gears` doesn't trigger). For v2: widen to `u32 payload_len`, bump `ABI_VERSION` and `OP_VERSION`. Do not silently widen mid-implementation. |
| Sync query latency dominates on `glGetError`-spammy demos | Manual gldemo with FPS readout | Document; advise patching the demo to not call `glGetError` per call (per the design doc trade-off note). Don't add a JS-side fast-path cache in v1. |
| `wasm32posix-cc` auto-link breaks an existing program that explicitly links `-lEGL` | Existing test gauntlet | The auto-link logic must be additive only (skip when already in the linker invocation). Verify on existing programs in `programs/`. |
| ABI snapshot diff is larger than expected (e.g. tracks tagged-union variants) | Task A9 diff inspection | Either accept and bump `ABI_VERSION` regardless, or refine `scripts/check-abi-version.sh` filters — discuss with user before changing the script. |
| `OP_VERSION` drift between client (libGLESv2) and kernel | Task A6 `GLIO_INIT` op_version check; surfaces at `eglInitialize` time as `EGL_NOT_INITIALIZED` | Bump in lockstep across `shared::gl::OP_VERSION`, `host/src/webgl/ops.ts`, and `glue/gl_abi.h` in the same commit. Mismatched stub vs kernel produces a clean `ENOSYS` from the kernel rather than a silent decode error. |
| Sync query OOM via `out_buf_len = 0xFFFFFFFE` | Task A6 `GLIO_QUERY` rejects `out_buf_len > MAX_QUERY_OUT_LEN` (64 KiB) with `EINVAL` | Fixed kernel-side cap; demos needing >64 KiB output (full-framebuffer reads) tile their reads. The cap is itself part of the ABI — bumping it is an `ABI_VERSION` change. |
| Two threads in one process calling GL concurrently | No detection in v1 (per Trade-off above); silent cmdbuf corruption | Document v1 = single-threaded GL in porting guide. v2 plans either cursor-lock or per-thread cmdbufs. |

## What this plan doesn't cover (all v2 — see design doc §9)

- Multiple contexts / shared contexts.
- Multiple processes holding the GL device.
- WebGPU backend.
- Compute shaders, SSBOs, image load-store.
- `EGL_KHR_image` interop with `/dev/fb0`.
- DMA-BUF.
- `EGL_KHR_fence_sync` / async queries.
- Persisted shader cache (OPFS / IndexedDB).
- GLX / Xlib backend.
- KMS / `/dev/dri/card0`.
- Desktop OpenGL (`libGL.so`).
- Schema-driven libGLESv2 generator.

When v2 work starts, write a separate design + plan doc pair pointed at one of these threads. Do not graft them onto this plan.
