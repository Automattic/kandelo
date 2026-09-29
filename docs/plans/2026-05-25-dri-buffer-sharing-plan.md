# DRI v2 — Buffer + Sharing Plan (`/dev/dri/renderD128` GBM dumb-buffer + prime fd)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Add the GBM dumb-buffer allocation + prime-fd sharing surface on top of the v1 `/dev/dri/renderD128` device. Programs follow the standard Linux flow: `open` the render node → `DRM_IOCTL_MODE_CREATE_DUMB` (allocate a CPU-shared `bo`) → `DRM_IOCTL_MODE_MAP_DUMB` (get the mmap offset) → `mmap(fd, len, PROT_READ|PROT_WRITE, MAP_SHARED, fd, bo_offset)` → write/read pixels → `DRM_IOCTL_PRIME_HANDLE_TO_FD` (export bo as prime fd) → pass the prime fd to a peer process via `fork`-inherited fds (v2 SCM_RIGHTS is a separate plan) → peer `DRM_IOCTL_PRIME_FD_TO_HANDLE` (import) → peer mmaps the same bo and sees the same pixels. The proof-of-concept demo is **milestone (A) of the v2 design**: two processes round-trip a 256×256 ARGB8888 gradient through a shared bo.

**Architecture:** The bo's backing pixels live in a kernel-owned `SharedArrayBuffer` slice (CPU-shared tier, see design §4.2). On `mmap` of a bo, the kernel allocates an anonymous region inside the process's wasm `Memory` (existing `MemoryManager::mmap_anonymous`) and calls the new `HostIO::gbm_bo_bind(pid, addr, bo_id)` callback; the host points that wasm-memory region at the bo's SAB slice via `MemoryManager::mmap_shared(addr, len, sab, offset)` — a new extension to the existing `mmap_anonymous` path. Writes through the wasm pointer hit the bo's SAB directly. No per-frame syscalls, no copies. `PRIME_HANDLE_TO_FD` allocates a new `OpenFileKind::PrimeBo { bo_id, cookie }` OFD; `PRIME_FD_TO_HANDLE` looks up `(bo_id, cookie)` and returns a per-process handle. fork inherits the prime-fd OFD by ref-bump on the bo. Companion design doc: `docs/plans/2026-05-18-dri-design.md` §4.

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser + Node), C user programs cross-compiled with `wasm32posix-cc`, hand-written `libgbm.a` + minimal `libdrm.a` (≤ 400 LoC C) in the sysroot, Linux UAPI headers (`drm/drm.h`, `drm/drm_mode.h`, `drm/drm_fourcc.h`) vendored unmodified into `musl-overlay/include/drm/`.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §4 (Buffer allocation & sharing model). The bo three-tier model (GPU / CPU-shared / CPU-private) is described in §4.2; **v1 of the buffer plan implements CPU-shared only**. GPU-tier bos (WebGLTexture-backed) require the multiplexer wired up and are deferred to the next plan (`docs/plans/2026-06-XX-dri-multiplexer-plan.md`).

**Stack base:** v1 GLES2 demo branch tip — `explore-webgl-exposition-demo` (PR #38's head). The bo plan extends v1's `OpenFileKind`-side state (`Process::gl_state`, `VirtualDevice::DriRender0`, `HostIO::gl_*`) without modifying its existing surface.

**Branch:** `emdash/explore-direct-rendering-infrastructure-buffer-plan-XXXXX` (chained off the previous DRI exploration branch per the user's "every new branch chains off the previous, except for new explorations" rule — the buffer plan is no longer a *new* exploration, it's the next step in DRI). Three sub-branches stack off it for the three PRs.

**Final PR base:** `explore-webgl-exposition-demo`. **Do not merge** until Brandon validates the design, the plan, and Phase C's manual browser verification — see CLAUDE.md "no merge before Brandon's validation" rule.

**Three PRs, coordinated merge.** Each task below is one commit. Three PR boundaries are marked. PR titles mirror Brandon's `scope(area): action` shape:

1. `kernel(dri): GBM dumb-buffer + prime fd + bo mmap`
2. `host(dri): GbmRegistry + SAB-backed bo store + mmap_shared`
3. `examples(dri): dumb-buffer round-trip demo + vitest spec`

PR base/head topology (stacked per the user's branching rule):

```
explore-webgl-exposition-demo       (v1 tip; base of the chain)
 └── …-buffer-plan-XXXXX            (this plan PR; base = v1 tip)
      └── …-buffer-kernel           (PR #1: kernel(dri))
           └── …-buffer-host        (PR #2: host(dri))
                └── …-buffer-demo   (PR #3: examples(dri))
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass with zero regressions before any PR is opened, and re-run before final merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a regression. Phase C adds: manual `./run.sh browser` verification of the dumb-buf demo (CLAUDE.md item 6).

**ABI impact:** **Additive only — no `ABI_VERSION` bump.** Per `docs/abi-versioning.md` (PR #490 policy): new `repr(C)` structs in `shared::dri`, new ioctl numbers in the unused DRM `'d'` magic range, new `host_gbm_*` host imports. Existing struct layouts, syscall numbers, channel layout, kernel exports — all unchanged. The PR that lands the snapshot diff cites this rule explicitly (Phase A Task A10).

---

## Pre-implementation review

Devil's-advocate pass, 2026-05-19. Each item below is either *fixed in
place* in this plan (corrections to the drafted prose) or *open for the
implementation PR to address* (a bug, missing test, or architectural
concern in the design as drafted).

### Correctness — fixed in place

- **`DRM_IOCTL_VERSION` was `0xc018_6400` (Linux 64-bit value).** On
  wasm32-ilp32 every field of `struct drm_version` is 4 bytes — three
  `int`, three `__kernel_size_t`, three `char *` — for a 36-byte struct
  and an ioctl encoding of `0xc024_6400`. *Folded the correction into
  Task A1 Step 1; deleted the Step 1.5 self-correction artifact.* The
  remaining seven `DRM_IOCTL_*` numbers were re-derived from `_IOWR`
  by hand against the actual `repr(C)` struct sizes and all match
  upstream Linux.
- **`WpkDrmVersion` had a misleading "pointers come first on Linux"
  comment and a trailing "Field order above is illustrative" hedge.**
  Field order *is* correct (interleaved `(len, ptr)` triples). *Removed
  the hedge, filled in the missing byte-offset annotations, stated the
  ordering convention positively.*
- **`bo.rs` Task A2 used `super::super::super::shared::dri::*`.** Invalid
  module path — `super::super::super` from `crates/kernel/src/dri/bo.rs`
  exits the crate root. `shared` is a sibling crate
  (`crates/shared/`); the kernel imports it everywhere else as
  `wasm_posix_shared::*` (e.g. `wasm_api.rs:26-27`). *Replaced with a
  `use wasm_posix_shared::dri::DRM_FORMAT_MOD_LINEAR;` import and the
  bare name at the call site.*
- **Task A10 said "8 new `host_gbm_*` imports"; Task A4 introduces 5.**
  *Corrected to "5 new `host_gbm_*` imports (`_create / _destroy /
  _bind / _unbind / _prime_exported`)".*
- **Task C4 child verified pixels via hardcoded `cpx[y * 256 + x]`** but
  the parent writes via `bo->stride/4`. They coincide at 256×ARGB8888
  (stride 1024 → 256 px) but silently diverge at other widths/bpp.
  *Switched child to `cbo->stride/4` to mirror the writer.*

### Correctness — open, address in the implementation PRs

- **Task A9 close-path refcount bug as drafted.** "When releasing an OFD
  with `prime_bo: Some(p)`, call `decref(...)`" — but OFDs are
  reference-counted across the fd-table (`dup` and `fork` share an OFD
  via the same `OpenFileDesc` slot). The bo decref must fire only when
  the **OFD's own refcount drops to zero**, not on every fd `close()`.
  Action: scope the decref to the "destroy OFD" path, *not* the "close
  fd" path, and add a vitest spec that `dup` + `close` on a prime fd
  preserves the bo until the last fd closes.
- **Task A8 mmap unwind path is a stub.** The plan says
  `if rc < 0 { /* unwind: munmap_anonymous + return rc */ }`. The unwind
  must (a) call `munmap_anonymous(addr, length)`, (b) return the
  original `rc`, and (c) if `munmap_anonymous` itself fails, log and
  proceed (matching the Linux kernel's behaviour — leaking pages is
  preferable to a tighter loop in cleanup). Spell this out; don't leave
  the `/* … */` placeholder.
- **Cross-lock policy is implicit.** Tasks A6/A7/A9 acquire
  `BoRegistry`, `HOST_IO`, and `PROCESS_TABLE` in mixed orders, but
  always release each lock before taking the next (no nested holds), so
  there's no deadlock in the drafted code. Action: add a doc-block to
  the top of `crates/kernel/src/dri/mod.rs`: *"Never hold two of
  {BoRegistry, HOST_IO, PROCESS_TABLE} at once. Copy out under the
  first lock, then re-enter under the second."*

### Architecture — open

- **Task B2 (`mmap_shared`) fallback is hand-wavy.** "Fall back to
  per-tick `Atomics` sync between the bo SAB and process Memory" —
  without per-frame syscalls there's no host-side trigger for a "tick".
  If `WebAssembly.Memory` cannot be aliased to a slice of an arbitrary
  SAB across Chrome/Firefox/Safari, the **real** fallback is to
  allocate every process's `Memory` from a global SAB pool that the
  host can address by `(sab_offset)` — a larger redesign of
  `MemoryManager`. **Run the B2 spike *first* in Phase B**, before B3.
  Gate the rest of Phase B on its outcome; if the spike forces the
  pool redesign, this plan needs an amendment (not a follow-up).
- **Task B3 cites a commit unreachable from this branch.** "Pattern
  mirrors v1's `host_gl_*` wiring (commit `ec29a571` on
  `explore-webgl-exposition-kernel`)." This branch is based on `main`;
  the commit lives on a separate exploration chain. At implementation
  time, retrieve it via
  `git show explore-webgl-exposition-kernel:host/src/kernel.ts`, or
  inline the pattern into B3 to make the task self-contained.

### Missing tests — add in the implementation PRs

- **`prime_handle_to_fd` idempotence on re-export.** Trade-offs claim
  the prime cookie is idempotent on re-export (`ensure_prime_cookie`
  enforces this), but Task A7's tests don't assert it. Add: two
  consecutive `PRIME_HANDLE_TO_FD` calls on the same handle yield prime
  fds carrying the **same** cookie.
- **`mmap` without a local handle returns `EACCES`.** Task A8 enforces
  this (`if !proc.dri_handles.values().any(...) { return EACCES }`)
  but no test exercises it. Add to A8 Step 3.
- **`dup` + `close` on a prime fd preserves the bo.** Companion to the
  close-path refcount fix above.
- **Prime fd from a foreign process (no fork lineage) is rejected.**
  With SCM_RIGHTS deferred, the only path to receive a prime fd is
  fork-inherit; an importer that didn't fork from the exporter should
  fail with `EBADF` or `EACCES`. Add a defensive test to A7's
  `prime_round_trip_two_processes` that confirms the setup matches
  the fork path (not arbitrary fd-injection).

### Trade-offs verified against the design doc (`2026-05-18-dri-design.md` §4)

- **GEM handles per-Process** (not per-fd) — matches design §4: v1 is
  single-owner, namespace on `Process`. ✓ **Cross-plan follow-up
  (added 2026-05-19 session 4):** plan 3
  (`docs/plans/2026-06-01-dri-multiplexer-plan.md`) Task A2 *lifts*
  this to per-`OpenFileDesc` (`DriFdState`) as the structural refactor
  that enables N-concurrent-opens. Every plan-2 callsite touched by
  Tasks A3, A6-A9 is rewritten by plan 3 A2 Step 2 (the kernel
  resolves `pid → fd_table → OFD → dri.handles` instead of
  `pid → proc.dri_handles`). The per-Process choice in this plan is
  thus an explicit incremental-landability simplification, not a
  permanent shape — plan 2 lands first as drafted, plan 3 lifts.
  Plan 3's Pre-implementation review walks the per-fd lift in detail.
- **CPU-shared tier only** — matches §4.2. ✓ **Cross-plan follow-up:**
  plan 3 Task A3 activates the reserved `BoTier::Gpu` variant via a
  new `BoRegistry::alloc_gpu` (separate method, not a parameter on
  `alloc`) and `DRM_IOCTL_WPK_CREATE_GPU_BO`. Plan 2's `BoTier` enum
  surface stays unchanged; plan 3 only adds new call sites.
- **`drm_version` zero-length strings in v1** — design doesn't require
  strings; libdrm/libgbm tolerate empty. ✓
- **`SCM_RIGHTS` deferred to the sockets plan** — matches §13. ✓

### Cross-plan follow-ups (lifts and replacements landing in plan 3)

- The **"close-path refcount bug" flagged above under "Correctness —
  open"** (every `close(prime_fd)` decremented the bo; the decref
  should be at OFD-final-release, not per-fd-close) is **not** fixed
  inside this plan. Plan 3 Task A5 introduces an `on_final_close`
  hook on `OpenFileDesc` that fires only when the OFD's refcount
  drops to zero, and explicitly **replaces** plan 2 Task A9 Step 2's
  per-`close` decref. Reviewers walking plan 2 in isolation: this is
  the documented bug; the fix is in the next plan, not in a plan-2
  amendment. Plan 2 PRs should still ship the per-`close` decref
  (matches the drafted code) — plan 3 PR #1 rewrites the path. The
  alternative — fixing it in plan 2 — would defer plan 2's landability
  on an OFD-refcount-hook refactor that doesn't belong in the buffer
  plan's scope.
- The **two OFD-side optional fields** (`prime_bo` here; plan 3 adds
  `dri`) are flagged in plan 3's Pre-impl review as a candidate for
  consolidation into a single `Option<Box<DriOfdState>>` enum. No
  action needed in plan 2; mentioned for cross-plan awareness.

### Cross-plan amendment from plan 8's devil's-advocate

Plan 8's devil's-advocate pass (session 9) caught a `gbm_bo_map`
signature mismatch across plans 2 / 4 / 8. Plan 2's libgbm stub
(Task C3, line 1730+) is sketched calling `gbm_bo_map` with 9 args
(trailing NULLs); plan 4's modeset demo (Task C2, line 2099) mirrors
the 9-arg shape; plan 8's `wpk_surface_create` calls an 8-arg shape
with `&map_data` in the stride slot (pointer-shape mismatch). None
of the three matches upstream Mesa `libgbm`'s prototype
`void *gbm_bo_map(struct gbm_bo *bo, uint32_t x, uint32_t y,
uint32_t width, uint32_t height, uint32_t flags, uint32_t *stride,
void **map_data)`.

*Resolution for plan 2:* implement the libgbm stub C3 at the
upstream 8-arg shape — `(bo, x, y, w, h, flags, uint32_t *stride,
void **map_data)`. The `stride` out-param is redundant with
`gbm_bo_get_stride(bo)` but the upstream signature includes it for
historical reasons; callers that pass `NULL` for `stride` should
fetch via `gbm_bo_get_stride`. Plan 4's modeset demo (C2) and plan
8's `wpk_surface_create` re-issue at the 8-arg call shape. The
stub implementation under `glue/libgbm_stub.c` does an mmap of the
bo's SAB-backed pages (already host-resident; no syscall round-
trip) and writes the bo's stride into `*stride` if non-NULL, and a
NULL handle into `*map_data` (the v1 stub doesn't track per-map
opaque state; `gbm_bo_unmap` is a no-op). One additional cargo
test under Task C3: `gbm_bo_map_signature_matches_upstream` —
compile-time check that the signature matches the Mesa upstream
prototype (header parity).

### Cross-plan amendment from plan 7's devil's-advocate — gbm_surface follow-up (LOAD-BEARING)

Plan 7's devil's-advocate pass (session 8) escalated this plan's
**`gbm_surface_create` deferral** (this plan's "What this plan
doesn't cover", line 1869+) into a **LOAD-BEARING cross-plan
blocker**. SDL2 2.30's KMSDRM backend (`SDL_kmsdrmvideo.c::KMSDRM_CreateSurfaces`)
calls `gbm_surface_create_with_modifiers`, `gbm_surface_lock_front_buffer`,
`gbm_surface_release_buffer`, and `gbm_surface_has_free_buffers` —
**none of which plan 2's libgbm stub (C3) ships**. Plan 7 PR #2
(`sysroot(sdl2): SDL2 configure — KMSDRM + ALSA + evdev only`) is
**blocked on this gap closing**; plans 9–11 (compositor, wpk-shell,
seed apps with GL) also need `gbm_surface_*` for their EGL swap-
chains.

*Resolution (plan-2 follow-up PR landed BEFORE plan 7 PR #2 can
merge):* extend plan 2's libgbm stub with a `gbm_surface` shim.
Surface model:

- **A `gbm_surface` owns a small ring of bos** (v1: 3-bo triple
  buffer, configurable via `gbm_surface_set_buffer_count(s, n)`)
  — semantically a swap-chain over plan 2's existing `gbm_bo`
  primitives. No new kernel surface; new state lives entirely
  inside the C stub.
- **`gbm_surface_create_with_modifiers(dev, w, h, format, modifiers,
  count)` and `gbm_surface_create(dev, w, h, format, flags)`** —
  allocate the bo ring eagerly (3 × `gbm_bo_create` under the
  hood with `GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR`); return an
  opaque `struct gbm_surface *` carrying the ring + a "currently
  acquired" pointer-set.
- **`gbm_surface_lock_front_buffer(s)`** — atomically marks the
  *most-recently-rendered* bo as "locked-by-scanout" and returns
  it; the EGL/GLES rendering side draws into the *next-free* bo.
  The "most-recently-rendered" pointer advances on every
  `eglSwapBuffers` (or, in our case, the libegl-stub's `eglSwap`
  shim — see plan 3 amendment below).
- **`gbm_surface_release_buffer(s, bo)`** — caller (typically the
  KMS presenter that finished scanning out) releases the lock;
  the bo returns to the free pool.
- **`gbm_surface_has_free_buffers(s)`** — returns nonzero iff at
  least one bo is in the free pool (rendering can proceed without
  blocking on present).
- **No GBM_BO_TRANSFER_WRITE coherence concern** — the bos are
  plan 2's existing CPU-shared tier; mmap writes alias the SAB
  directly per the existing trade-off.

The stub holds the ring in user-space C state (no kernel-side
`gbm_surface_*` types — keeps the kernel ABI surface
unchanged). The `eglSwapBuffers` semantic comes from plan 3's
libegl-stub follow-up (see cross-plan amendment below in plan 3).

*Package layout:* extend `examples/libs/libgbm/` (which plan 2 C3
ships under `glue/libgbm_stub.c`) — `gbm_surface_*` becomes one
additional `.c` file in the same package, archived into the same
`libgbm.a`. **Increment `build.toml.revision`** when this lands
(post-merge of plan 2 PR #3, before plan 7 PR #2 opens).

*Cargo + Vitest tests under the plan-2-follow-up PR:*
- `gbm_surface_create_allocates_three_bos` — assert
  `BoRegistry.count()` rises by exactly 3 after a
  `gbm_surface_create(640, 480, ARGB8888, 0)`.
- `gbm_surface_lock_then_release_round_trip` — lock, release,
  lock again returns *a different* bo (front-buffer rotation).
- `gbm_surface_has_free_buffers_returns_false_when_all_locked` —
  lock all 3 bos without releasing; assert subsequent
  `_has_free_buffers` returns 0.
- `gbm_surface_destroy_frees_all_bos` — destroy a 3-bo surface
  with one locked; assert `BoRegistry.count()` returns to baseline
  AFTER the locked bo is released (lock-time bo ref keeps it
  alive past `gbm_surface_destroy`; matches Mesa semantics).

*Branch topology:* the plan-2-follow-up PR bases on plan 2 PR #3's
`…-buffer-demo` tip and is the **gate for plan 7 PR #2**. PR
title: `[explore-dri] sysroot(dri): libgbm — gbm_surface ring +
lock/release/has_free`. Aligns with the design doc §2 line 122
re-reading ("v1 cmdbuf, EGL stubs, libGLESv2 stubs … are all
reused verbatim") — design doc's "reused verbatim" was incorrect
about the stub-as-static-lib shape; the static-lib carriers live
in this follow-up plus plan 3's libegl-stub / libgles2-stub
follow-up. Together the two follow-ups close plan 7's
open-architecture #2.

*Cross-plan link:* plan 3 below carries the matching libEGL.a +
libGLESv2.a static-lib follow-up — the two follow-ups land
together (single inter-plan PR set) or in sequence (plan 2 first
since plan 3 imports `gbm_surface *` from plan 2's header).

### Cross-plan amendment from plan 9's devil's-advocate — gbm_bo_import cookie contract + gbm_bo_get_fd freshness + SCANOUT+RENDERING+LINEAR ring (LOAD-BEARING)

Plan 9's devil's-advocate pass (session 10) surfaced three contracts
this plan must lock in EXPLICITLY before plan 9's compositor opens.
Each closes a use-after-free or wrong-stride hazard plan 9 D3 +
E1 would silently hit otherwise.

1. **`gbm_bo_import(GBM_BO_IMPORT_FD, &data, ...)` MUST internally
   issue `DRM_IOCTL_PRIME_FD_TO_HANDLE`.** Per design §13, prime
   fds carry `OpenFileKind::PrimeBo { bo_id, cookie }`. The cookie
   is verified + the bo refcount is bumped inside the
   PRIME_FD_TO_HANDLE ioctl. Plan 9's `compositor_handle_attach_buffer`
   (D3 line 1145) closes the prime fd IMMEDIATELY after calling
   `gbm_bo_import`, relying on the import call having already
   bumped the kernel-side refcount. **Contract: the libgbm
   wrapper MUST issue PRIME_FD_TO_HANDLE under the hood; the
   caller MUST be free to `close(data.fd)` immediately on
   success.** Without this, the import is a fd-borrow and the
   close is a use-after-free. Document explicitly in the C3 task
   body when extending the stub; add a cargo test that asserts
   bo refcount is 1 after `gbm_bo_import` + `close(prime_fd)` and
   the bo remains accessible. The test guard fires in plan 9's
   missing-tests register.
2. **`gbm_bo_get_fd(bo)` returns a FRESH prime fd per call
   (incrementing kernel-side refcount), not a cached fd.** Plan
   9 E1's `wpk_surface_present_via_compositor` calls
   `gbm_bo_get_fd(s->bo_front)` once per present and `close(pfd)`
   after `wpk_client_attach_buffer`. The pattern depends on the
   call ALWAYS allocating a fresh PrimeBo OFD (i.e., the wrapper
   issues `DRM_IOCTL_PRIME_HANDLE_TO_FD` per invocation). Match
   upstream Mesa semantics; document in the gbm_surface follow-up.
3. **The compositor's `gbm_surface` uses `GBM_BO_USE_SCANOUT |
   GBM_BO_USE_RENDERING`.** Plan 9 D2 line 1063-1064 requests
   this combination. Plan 2's follow-up ring tags bos as
   `GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR` (line 250) — the
   RENDERING flag isn't mentioned. **Contract: the libgbm stub
   treats SCANOUT, RENDERING, and LINEAR as equivalent in v1
   (always LINEAR / always SAB-backed / always scanout-capable);
   any combination of flags passes the same allocation path.**
   Document explicitly so the EGL stub + compositor + plan 7's
   SDL2 KMSDRM backend all see the same behavior.

These three contracts gate plan 9 implementation start (see plan
9 open-architecture #3 for the LOAD-BEARING flag on #1
specifically). All three are pinned at plan 2 follow-up impl time;
no kernel changes required (the ioctls already exist per design
§13).

### Deliberately not flagged

- `drm_prime_handle.fd` is `__s32` (signed) — plan correctly types it
  `i32`. ✓
- wasm32 `time_t` width — §4 carries no timestamps. ✓
- `DRM_FORMAT_*` little-endian fourcc constants — verbatim from Linux
  UAPI; checked by eye. ✓

---

## Phase A — Kernel GBM bo + prime fd surface (PR #1)

The kernel learns to allocate bos, hand out prime fds, and bind bo memory into the process's wasm address space on `mmap`. No host wiring yet — Phase A's tests are pure cargo (kernel-internal), and the `HostIO::gbm_*` callbacks are stubbed out in `host/test/centralized-test-helper.ts` to capture call args.

### Task A1: Shared ABI module `shared::dri`

**Files:**
- Modify: `crates/shared/src/lib.rs` — add `pub mod dri` near the other ABI modules (next to `pub mod fbdev`).

**Step 1: Add the constants and structs**

Append after `pub mod fbdev { … }` in `crates/shared/src/lib.rs`:

```rust
/// Linux DRM `/dev/dri/*` ABI — ioctl numbers, fourcc constants, and
/// marshalled argument structs.
///
/// Numbers are encoded with `_IOWR('d', nr, struct)` where `'d' = 0x64`.
/// Struct field offsets must match the Linux ABI byte-for-byte; bumping
/// `ABI_VERSION` is not required for *adding* new structs (additive
/// compatibility, see `docs/abi-versioning.md`), but any change to an
/// existing struct's layout requires a snapshot regen and a version bump.
pub mod dri {
    /// DRM ioctl magic ('d').
    pub const DRM_IOCTL_BASE: u32 = 0x64;

    // --- ioctl numbers -----------------------------------------------------
    // Derivation: dir=11 (READ|WRITE), size=struct sizeof, magic='d', nr=…
    // Encoded: (dir << 30) | (size << 16) | (magic << 8) | nr
    // The constants below are the byte-for-byte Linux values; the tests in
    // Step 2 re-derive them from `_IOWR!` to catch drift.

    /// `_IOWR('d', 0x00, drm_version)` — driver name / date / desc query.
    /// `struct drm_version` is 36 bytes on wasm32 (ilp32: 3 × `int` + 3 ×
    /// `__kernel_size_t` + 3 × `char *`, all 4-byte). Ioctl number encodes
    /// 36 → `0xc0246400`. Linux x86_64's 60-byte layout is not us.
    pub const DRM_IOCTL_VERSION: u32 = 0xc024_6400;

    /// `_IOWR('d', 0x0c, drm_get_cap)` — feature capability query.
    pub const DRM_IOCTL_GET_CAP: u32 = 0xc010_640c;

    /// `_IOW('d', 0x09, drm_gem_close)` — drop a GEM handle.
    pub const DRM_IOCTL_GEM_CLOSE: u32 = 0x4008_6409;

    /// `_IOWR('d', 0x2d, drm_prime_handle)` — export bo as prime fd.
    pub const DRM_IOCTL_PRIME_HANDLE_TO_FD: u32 = 0xc00c_642d;

    /// `_IOWR('d', 0x2e, drm_prime_handle)` — import prime fd as bo handle.
    pub const DRM_IOCTL_PRIME_FD_TO_HANDLE: u32 = 0xc00c_642e;

    /// `_IOWR('d', 0xb2, drm_mode_create_dumb)` — allocate dumb buffer.
    pub const DRM_IOCTL_MODE_CREATE_DUMB: u32 = 0xc020_64b2;

    /// `_IOWR('d', 0xb3, drm_mode_map_dumb)` — fetch dumb-buffer mmap offset.
    pub const DRM_IOCTL_MODE_MAP_DUMB: u32 = 0xc010_64b3;

    /// `_IOWR('d', 0xb4, drm_mode_destroy_dumb)` — drop dumb buffer.
    pub const DRM_IOCTL_MODE_DESTROY_DUMB: u32 = 0xc004_64b4;

    // --- DRM_GET_CAP keys (clients call to probe features) ----------------

    pub const DRM_CAP_DUMB_BUFFER: u64 = 0x1;
    pub const DRM_CAP_PRIME: u64 = 0x5;
    pub const DRM_PRIME_CAP_IMPORT: u64 = 0x1;
    pub const DRM_PRIME_CAP_EXPORT: u64 = 0x2;

    // --- DRM_FORMAT_* fourcc constants (subset needed for v1) -------------

    /// `'A','R','2','4'` little-endian, BGRA-in-memory.
    pub const DRM_FORMAT_ARGB8888: u32 = 0x3432_5241;
    /// `'X','R','2','4'` little-endian, BGRX-in-memory.
    pub const DRM_FORMAT_XRGB8888: u32 = 0x3432_5258;
    /// `'R','G','1','6'` 5-6-5 LE.
    pub const DRM_FORMAT_RGB565: u32 = 0x3635_3147;

    /// `DRM_FORMAT_MOD_LINEAR` — the only modifier we accept in v1.
    pub const DRM_FORMAT_MOD_LINEAR: u64 = 0;

    // --- marshalled structs ------------------------------------------------

    /// Linux `struct drm_mode_create_dumb` (32 bytes, identical layout on
    /// wasm32 and x86_64 — fixed-width fields only).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCreateDumb {
        pub height: u32,  // 0   in
        pub width: u32,   // 4   in
        pub bpp: u32,     // 8   in    bits-per-pixel (32 for ARGB8888)
        pub flags: u32,   // 12  in    must be 0
        pub handle: u32,  // 16  out   process-local bo handle
        pub pitch: u32,   // 20  out   stride in bytes
        pub size: u64,    // 24  out   total bytes (pitch * height)
                          // total: 32
    }

    /// Linux `struct drm_mode_map_dumb` (16 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeMapDumb {
        pub handle: u32, // 0   in
        pub pad: u32,    // 4   reserved
        pub offset: u64, // 8   out   pass to mmap() as the file offset
                         // total: 16
    }

    /// Linux `struct drm_mode_destroy_dumb` (4 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeDestroyDumb {
        pub handle: u32, // 0
                         // total: 4
    }

    /// Linux `struct drm_gem_close` (8 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGemClose {
        pub handle: u32, // 0
        pub pad: u32,    // 4
                         // total: 8
    }

    /// Linux `struct drm_prime_handle` (12 bytes). Reused both for
    /// HANDLE_TO_FD (handle → fd, flags=O_CLOEXEC|O_RDWR-ish) and
    /// FD_TO_HANDLE (fd → handle).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmPrimeHandle {
        pub handle: u32, // 0   in/out
        pub flags: u32,  // 4   in    O_CLOEXEC/O_RDWR; we accept any, store none
        pub fd: i32,     // 8   in/out   signed (-1 on error sentinel; -EBADF tests)
                         // total: 12
    }

    /// Linux `struct drm_get_cap` (16 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGetCap {
        pub capability: u64, // 0  in   DRM_CAP_* constant
        pub value: u64,      // 8  out
                             // total: 16
    }

    /// Linux `struct drm_version` — used by `DRM_IOCTL_VERSION`. 36 bytes on
    /// wasm32 (ilp32: 3 × `int` + 3 × `__kernel_size_t` + 3 × `char *`, all
    /// 4-byte). Field order matches `include/uapi/drm/drm.h` — interleaved
    /// `(len, ptr)` triples (not "lens first, then ptrs"). The kernel reads
    /// `*_len` (caller-allocated capacity), writes strings via the three
    /// pointers, and updates `*_len` to bytes actually written. v1 writes
    /// zero-length strings (see Task A5); the field shape is fixed for the
    /// future string-write path.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmVersion {
        pub version_major: i32,       // 0
        pub version_minor: i32,       // 4
        pub version_patchlevel: i32,  // 8
        pub name_len: u32,            // 12   in/out
        pub name_ptr: u32,            // 16   wasm32 user pointer
        pub date_len: u32,            // 20   in/out
        pub date_ptr: u32,            // 24   wasm32 user pointer
        pub desc_len: u32,            // 28   in/out
        pub desc_ptr: u32,            // 32   wasm32 user pointer
                                      // total: 36
    }
}
```

**Step 2: Add a static-assert + ioctl-encoding test**

Append to the `#[cfg(test)] mod` block in `crates/shared/src/lib.rs`:

```rust
#[cfg(test)]
mod dri_tests {
    use super::dri::*;
    use core::mem::size_of;

    /// `_IOWR(magic, nr, type)` packs (dir, size, magic, nr) into a u32.
    /// Mirrors include/uapi/asm-generic/ioctl.h.
    const fn ioc(dir: u32, magic: u32, nr: u32, size: u32) -> u32 {
        (dir << 30) | (size << 16) | (magic << 8) | nr
    }
    const IOC_READ: u32 = 2;
    const IOC_WRITE: u32 = 1;

    #[test]
    fn struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<WpkDrmModeCreateDumb>(), 32);
        assert_eq!(size_of::<WpkDrmModeMapDumb>(), 16);
        assert_eq!(size_of::<WpkDrmModeDestroyDumb>(), 4);
        assert_eq!(size_of::<WpkDrmGemClose>(), 8);
        assert_eq!(size_of::<WpkDrmPrimeHandle>(), 12);
        assert_eq!(size_of::<WpkDrmGetCap>(), 16);
        assert_eq!(size_of::<WpkDrmVersion>(), 36);
    }

    #[test]
    fn ioctl_numbers_match_linux_uapi() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(DRM_IOCTL_VERSION,
            ioc(iowr, 'd' as u32, 0x00, size_of::<WpkDrmVersion>() as u32));
        assert_eq!(DRM_IOCTL_GET_CAP,
            ioc(iowr, 'd' as u32, 0x0c, size_of::<WpkDrmGetCap>() as u32));
        assert_eq!(DRM_IOCTL_GEM_CLOSE,
            ioc(IOC_WRITE, 'd' as u32, 0x09, size_of::<WpkDrmGemClose>() as u32));
        assert_eq!(DRM_IOCTL_PRIME_HANDLE_TO_FD,
            ioc(iowr, 'd' as u32, 0x2d, size_of::<WpkDrmPrimeHandle>() as u32));
        assert_eq!(DRM_IOCTL_PRIME_FD_TO_HANDLE,
            ioc(iowr, 'd' as u32, 0x2e, size_of::<WpkDrmPrimeHandle>() as u32));
        assert_eq!(DRM_IOCTL_MODE_CREATE_DUMB,
            ioc(iowr, 'd' as u32, 0xb2, size_of::<WpkDrmModeCreateDumb>() as u32));
        assert_eq!(DRM_IOCTL_MODE_MAP_DUMB,
            ioc(iowr, 'd' as u32, 0xb3, size_of::<WpkDrmModeMapDumb>() as u32));
        assert_eq!(DRM_IOCTL_MODE_DESTROY_DUMB,
            ioc(iowr, 'd' as u32, 0xb4, size_of::<WpkDrmModeDestroyDumb>() as u32));
    }
}
```

**Step 3: Run the tests**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib dri_tests
```

Expected: 2 tests pass. Layout bugs surface here, not on a real wasm program.

**Step 4: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(dri): shared ABI module — DRM_IOCTL_* numbers + GBM structs"
```

---

### Task A2: `BoRegistry` global static + `BoId` allocator

**Files:**
- Create: `crates/kernel/src/dri/mod.rs`
- Create: `crates/kernel/src/dri/bo.rs`
- Modify: `crates/kernel/src/lib.rs` — `pub mod dri;`.

**Step 1: Create the `dri` submodule**

`crates/kernel/src/dri/mod.rs`:

```rust
//! DRI v2 — buffer (GBM) and KMS support for /dev/dri/*.
//!
//! v1 of this module covers the **buffer-sharing** surface only (this
//! plan): bo allocation, mmap binding, prime-fd export/import. The
//! multiplexer (§5) and KMS card0 (§6) live in their own submodules
//! added by later plans.

pub mod bo;

pub use bo::{BoId, BoRegistry, GbmBo, BoTier};
```

`crates/kernel/src/dri/bo.rs`:

```rust
//! GBM buffer-object registry: a single global `BoRegistry` owns every
//! live bo across processes. Per-process state (the GEM-handle → BoId
//! map) lives on `Process::dri_handles`. The bo registry is the source
//! of truth for refcount + backing.
//!
//! Cross-process semantics:
//! - `gbm_bo_create` (CREATE_DUMB) bumps a fresh BoId, refcount = 1,
//!   inserts the bo, returns a process-local handle pointing at it.
//! - `prime_handle_to_fd` allocates a new `OpenFileKind::PrimeBo`
//!   carrying `(BoId, cookie)`; refcount += 1.
//! - `prime_fd_to_handle` on a PrimeBo OFD bumps refcount, inserts
//!   another process-local handle mapping. The receiver can `mmap`
//!   the bo through this handle just like the creator.
//! - `gem_close` (or implicit close of the last process-local handle
//!   for a bo) decrements refcount. Refcount-to-zero frees the
//!   underlying SAB.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use spin::Mutex;
use wasm_posix_shared::dri::DRM_FORMAT_MOD_LINEAR;

/// Global, monotonic bo id. Never reused; freed bos leave a "tombstone"
/// gap so a leaked prime fd cookie cannot resurrect a different bo.
pub type BoId = u32;

/// Cookie for prime-fd capability check. A bo's cookie is set at first
/// `prime_handle_to_fd` and stays for the bo's lifetime; an importer
/// that doesn't match it gets EACCES.
pub type PrimeCookie = u64;

/// Bo tier (see design §4.2). v1 of this plan implements `CpuShared`
/// only; the others are reserved variants so the enum surface is
/// stable when later plans add them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoTier {
    /// CPU-shared SAB-backed bo. Host owns the SAB; the kernel-side
    /// `host_handle` references it indirectly via `BoId → SAB` in the
    /// host's `GbmRegistry`. mmap binds wasm-memory at the SAB.
    CpuShared,
    /// Reserved for §4.2 "GPU tier" — WebGLTexture-backed, exported
    /// via `EGL_EXT_image_dma_buf_import`. Not implemented in v1.
    Gpu,
    /// Reserved for §4.2 "CPU private" — kernel-worker-local
    /// `Uint8Array`. Not implemented in v1.
    CpuPrivate,
}

#[derive(Debug, Clone)]
pub struct GbmBo {
    pub id: BoId,
    pub width: u32,
    pub height: u32,
    pub format: u32,    // DRM_FORMAT_* (ARGB8888 etc.)
    pub modifier: u64,  // DRM_FORMAT_MOD_LINEAR only in v1
    pub stride: u32,    // bytes per row, host-decided
    pub size: u64,      // stride * height
    pub bpp: u32,       // matches CREATE_DUMB.bpp; 32 for ARGB8888
    pub tier: BoTier,
    pub refcount: u32,
    pub prime_cookie: Option<PrimeCookie>,
}

#[derive(Default)]
pub struct BoRegistry {
    next_id: BoId,
    next_cookie: u64,
    map: BTreeMap<BoId, GbmBo>,
}

static REGISTRY: Mutex<BoRegistry> = Mutex::new(BoRegistry {
    next_id: 1,
    next_cookie: 1,
    map: BTreeMap::new(),
});

pub fn with_registry<R>(f: impl FnOnce(&mut BoRegistry) -> R) -> R {
    f(&mut REGISTRY.lock())
}

impl BoRegistry {
    pub fn alloc(
        &mut self,
        width: u32,
        height: u32,
        bpp: u32,
        format: u32,
    ) -> &mut GbmBo {
        let id = self.next_id;
        self.next_id += 1;
        let stride = ((width * bpp).div_ceil(8) + 3) & !3; // round up to 4
        let size = (stride as u64) * (height as u64);
        let bo = GbmBo {
            id,
            width,
            height,
            format,
            modifier: DRM_FORMAT_MOD_LINEAR,
            stride,
            size,
            bpp,
            tier: BoTier::CpuShared,
            refcount: 1,
            prime_cookie: None,
        };
        self.map.insert(id, bo);
        self.map.get_mut(&id).unwrap()
    }

    pub fn get(&self, id: BoId) -> Option<&GbmBo> { self.map.get(&id) }
    pub fn get_mut(&mut self, id: BoId) -> Option<&mut GbmBo> {
        self.map.get_mut(&id)
    }

    pub fn incref(&mut self, id: BoId) -> Option<u32> {
        let bo = self.map.get_mut(&id)?;
        bo.refcount = bo.refcount.checked_add(1)?;
        Some(bo.refcount)
    }

    /// Returns Some(new_refcount). When new_refcount drops to 0, the
    /// caller MUST also call `host_io.gbm_bo_destroy(bo_id)` to drop
    /// the host-side SAB before forgetting the bo.
    pub fn decref(&mut self, id: BoId) -> Option<u32> {
        let bo = self.map.get_mut(&id)?;
        bo.refcount = bo.refcount.saturating_sub(1);
        let rc = bo.refcount;
        if rc == 0 {
            self.map.remove(&id);  // tombstone: id is not reused
        }
        Some(rc)
    }

    /// Issues a fresh, unguessable cookie for first PRIME_HANDLE_TO_FD
    /// on this bo. Idempotent: subsequent exports of the same bo reuse
    /// the existing cookie (Linux-shape).
    pub fn ensure_prime_cookie(&mut self, id: BoId) -> Option<PrimeCookie> {
        let bo = self.map.get_mut(&id)?;
        if let Some(c) = bo.prime_cookie {
            return Some(c);
        }
        // Cookie is monotonic + a 32-bit nonce. v1 doesn't need
        // crypto-grade unguessability since the kernel boundary is
        // process-level; we just want low collision risk across reboots.
        let c = self.next_cookie | ((self.next_id as u64) << 32);
        self.next_cookie = self.next_cookie.wrapping_add(1);
        bo.prime_cookie = Some(c);
        Some(c)
    }
}
```

**Step 2: Cargo tests**

Append to `crates/kernel/src/dri/bo.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_assigns_monotonic_ids() {
        with_registry(|r| {
            let a = r.alloc(64, 64, 32, 0).id;
            let b = r.alloc(64, 64, 32, 0).id;
            assert!(b > a);
        });
    }

    #[test]
    fn decref_to_zero_removes() {
        with_registry(|r| {
            let id = r.alloc(64, 64, 32, 0).id;
            assert_eq!(r.decref(id), Some(0));
            assert!(r.get(id).is_none());
        });
    }

    #[test]
    fn incref_then_decref_keeps_alive() {
        with_registry(|r| {
            let id = r.alloc(64, 64, 32, 0).id;
            r.incref(id);
            assert_eq!(r.decref(id), Some(1));
            assert!(r.get(id).is_some());
            r.decref(id);
        });
    }

    #[test]
    fn prime_cookie_is_idempotent() {
        with_registry(|r| {
            let id = r.alloc(64, 64, 32, 0).id;
            let c1 = r.ensure_prime_cookie(id).unwrap();
            let c2 = r.ensure_prime_cookie(id).unwrap();
            assert_eq!(c1, c2);
            r.decref(id);
        });
    }

    #[test]
    fn stride_rounds_up_to_4_bytes() {
        with_registry(|r| {
            // 17px wide @ 32bpp → naive 68 bytes; should round to 68 already.
            let bo = r.alloc(17, 1, 32, 0);
            assert_eq!(bo.stride, 68);
            let id = bo.id;
            r.decref(id);
            // 17px @ 8bpp → naive 17 bytes; round to 20.
            let bo2 = r.alloc(17, 1, 8, 0);
            assert_eq!(bo2.stride, 20);
            let id2 = bo2.id;
            r.decref(id2);
        });
    }
}
```

**Step 3: Wire it up**

In `crates/kernel/src/lib.rs`, add `pub mod dri;` alongside the other modules.

**Step 4: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dri::bo
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add crates/kernel/src/dri/ crates/kernel/src/lib.rs
git commit -m "kernel(dri): BoRegistry + BoId allocator (CPU-shared tier only)"
```

---

### Task A3: `Process::dri_handles` map + `PrimeBoState` ofd kind

**Files:**
- Modify: `crates/kernel/src/process.rs` — add `dri_handles: BTreeMap<u32, BoId>` field on `Process`.
- Modify: `crates/kernel/src/ofd.rs` — add `PrimeBoState` struct, hung off `OpenFileDesc` via a new optional field. v2 keeps the existing `FileType` enum unchanged (PrimeBo OFDs use `FileType::CharDevice` — see Trade-offs).
- Modify: `crates/kernel/src/fork.rs` — fork resets `dri_handles` to empty (per design §13 "fork interaction"); existing PrimeBo OFDs survive the dup because the bo refcount tracks the OFD copy.

**Step 1: Add `dri_handles` to `Process`**

In `crates/kernel/src/process.rs`, after `fb_binding: Option<FbBinding>`:

```rust
    /// Per-process GEM-handle → global BoId map for `/dev/dri/renderD128`.
    ///
    /// Linux GEM handles are per-fd; we collapse to per-process because v1
    /// of renderD128 is single-owner (see Trade-offs in the buffer plan).
    /// When the multiplexer plan lifts single-owner, this becomes per-fd.
    pub dri_handles: BTreeMap<u32, crate::dri::BoId>,
    /// Next handle id to issue; never wraps below 1. Linux numbers handles
    /// per-fd starting at 1; we mirror that, scoped per-process.
    pub dri_next_handle: u32,
```

Default-initialise in `Process::new()` and every fork/exec path: `dri_handles: BTreeMap::new(), dri_next_handle: 1`.

**Step 2: Add `PrimeBoState` to `OpenFileDesc`**

In `crates/kernel/src/ofd.rs`:

```rust
/// State for a prime-fd OFD — capability cookie binding fd → bo.
#[derive(Clone, Debug)]
pub struct PrimeBoState {
    pub bo_id: crate::dri::BoId,
    pub cookie: crate::dri::PrimeCookie,
}

// On `OpenFileDesc`, add:
//     pub prime_bo: Option<PrimeBoState>,
// Default to None.
```

Set `file_type: FileType::CharDevice` on PrimeBo OFDs to keep the existing select/poll/dup paths unchanged. The `host_handle` field is reused as a sentinel: `-200` for prime-bo OFDs (alongside the existing `-1..-7` for VirtualDevice and `-100/-160` for synthetic-file/devfs-dir).

**Step 3: fork inherits prime-fd OFDs**

In `crates/kernel/src/fork.rs`, around the OFD-table dup: existing logic already bumps OFD refcount per fd dup (the OFD-table is shared by ref-count). We just need to bump the bo refcount once per prime-bo OFD inherited. Find every fork path that walks the fd table and, for each fd whose OFD has `prime_bo: Some(_)`, call `crate::dri::with_registry(|r| r.incref(bo_id))`.

Reset `dri_handles` to empty in the child:

```rust
// In Process::clone_for_fork (or wherever the child Process is built):
dri_handles: BTreeMap::new(),
dri_next_handle: 1,
```

The rationale (design §13): GEM handles are per-fd state on Linux; `fork` gives the child a fresh GEM namespace through the same fd. The child has to import the inherited prime-fd OFDs explicitly via `PRIME_FD_TO_HANDLE` to address bos.

**Step 4: Cargo tests**

Append to `crates/kernel/src/dri/bo.rs` (or a new `bo_fork_tests.rs`):

```rust
#[test]
fn prime_inherit_bumps_refcount() {
    with_registry(|r| {
        let id = r.alloc(64, 64, 32, 0).id;
        r.incref(id);            // simulate prime-fd export
        r.incref(id);            // simulate fork-inherited dup
        assert_eq!(r.get(id).unwrap().refcount, 3);
        // Drop creator's handle, fork child's prime fd, exported prime fd
        r.decref(id);
        r.decref(id);
        assert_eq!(r.get(id).unwrap().refcount, 1);
        r.decref(id);
        assert!(r.get(id).is_none());
    });
}
```

**Step 5: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dri
```

Expected: previous tests + new one all pass.

**Step 6: Commit**

```bash
git add crates/kernel/src/process.rs crates/kernel/src/ofd.rs crates/kernel/src/fork.rs crates/kernel/src/dri/
git commit -m "kernel(dri): Process::dri_handles + PrimeBoState ofd + fork inherit"
```

---

### Task A4: `HostIO` GBM trait methods (5 methods)

**Files:**
- Modify: `crates/kernel/src/process.rs` — extend the `HostIO` trait.
- Modify: `host/test/centralized-test-helper.ts` — stub the new methods to capture call args for kernel-side cargo tests.

**Step 1: Extend the trait**

Append to the `HostIO` trait in `crates/kernel/src/process.rs`:

```rust
    // --- DRI v2 buffer-sharing surface (this plan) -----------------------

    /// Allocate host-side SAB backing for a freshly-created bo. Called
    /// once per `DRM_IOCTL_MODE_CREATE_DUMB`. Host returns the host's
    /// internal id for the SAB slice (which the kernel doesn't otherwise
    /// use — host-side bo lookup is by `bo_id`). Returns ≥ 0 on success,
    /// negative errno on failure.
    fn gbm_bo_create(&mut self, pid: i32, bo_id: u32, size: u64, width: u32,
        height: u32, stride: u32, format: u32) -> i32;

    /// Free host-side SAB backing for a bo whose refcount has reached 0.
    fn gbm_bo_destroy(&mut self, pid: i32, bo_id: u32);

    /// Bind a bo's SAB slice into a process's wasm `Memory` at `addr` for
    /// `len` bytes. Called from the mmap path once `mmap_anonymous` has
    /// reserved the wasm pages. After this returns, writes to `[addr,
    /// addr+len)` go directly to the SAB slice.
    fn gbm_bo_bind(&mut self, pid: i32, bo_id: u32, addr: usize, len: usize)
        -> i32;

    /// Unbind a prior `gbm_bo_bind` — called from munmap / process-exit
    /// before the wasm pages are returned to the anonymous pool.
    fn gbm_bo_unbind(&mut self, pid: i32, bo_id: u32, addr: usize,
        len: usize);

    /// Notify the host that a prime fd has been exported. The host
    /// doesn't need to do anything for v1 (the SAB is already shared
    /// across processes; export/import is a kernel-side bookkeeping
    /// op) — this exists so future tiers (GPU-tier with EGLImage)
    /// can hook here.
    fn gbm_bo_prime_exported(&mut self, pid: i32, bo_id: u32);
```

**Step 2: Stub in the test helper**

In `host/test/centralized-test-helper.ts`, the existing mock host has a `mockHostIo` shape. Add:

```ts
const gbmCalls: Array<{op: string, args: any}> = [];

const gbmStubs = {
  gbm_bo_create: (pid: number, bo_id: number, size: bigint, w: number,
      h: number, stride: number, format: number) => {
    gbmCalls.push({op: 'create', args: {pid, bo_id, size, w, h, stride, format}});
    return 0;  // success
  },
  gbm_bo_destroy: (pid: number, bo_id: number) => {
    gbmCalls.push({op: 'destroy', args: {pid, bo_id}});
  },
  gbm_bo_bind: (pid: number, bo_id: number, addr: number, len: number) => {
    gbmCalls.push({op: 'bind', args: {pid, bo_id, addr, len}});
    return 0;
  },
  gbm_bo_unbind: (pid: number, bo_id: number, addr: number, len: number) => {
    gbmCalls.push({op: 'unbind', args: {pid, bo_id, addr, len}});
  },
  gbm_bo_prime_exported: (pid: number, bo_id: number) => {
    gbmCalls.push({op: 'prime_exported', args: {pid, bo_id}});
  },
};
```

Export `gbmCalls` so kernel-driven host tests can assert against the recorded sequence.

**Step 3: Run**

```bash
cargo build -p wasm-posix-kernel --target aarch64-apple-darwin
```

Expected: builds clean. Trait additions must be matched in any concrete `HostIO` impl in the kernel test fixtures (`host_io.rs`-style mocks). The cargo build is the proof; any missing impls fail at compile time.

**Step 4: Commit**

```bash
git add crates/kernel/src/process.rs host/test/centralized-test-helper.ts
git commit -m "kernel(dri): HostIO trait — gbm_bo_create / _destroy / _bind / _unbind / _prime_exported"
```

---

### Task A5: `DRM_IOCTL_VERSION` + `DRM_IOCTL_GET_CAP` (introspection ioctls)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `sys_ioctl`'s dispatch to recognise the new `'d'` magic, and add `handle_dri_ioctl()`.

**Step 1: Recognise the DRM magic**

In `sys_ioctl` (around line 7080 — the existing match where `/dev/fb0` is routed to `handle_fb_ioctl`), add a sibling case that routes any ioctl whose host_handle matches `VirtualDevice::DriRender0` (added in v1) into a new `handle_dri_ioctl(pid, request, buf)`.

**Step 2: Implement the two introspection ops**

In a new helper at the bottom of `crates/kernel/src/syscalls.rs`:

```rust
fn handle_dri_ioctl(pid: i32, request: u32, buf: &mut [u8])
    -> Result<(), Errno>
{
    use wasm_posix_shared::dri::*;

    match request {
        DRM_IOCTL_VERSION => {
            if buf.len() < core::mem::size_of::<WpkDrmVersion>() {
                return Err(Errno::EINVAL);
            }
            let v_in: WpkDrmVersion = unsafe {
                core::ptr::read_unaligned(buf.as_ptr() as *const _)
            };
            // We don't write the strings back in v1 — clients that need
            // the name/date/desc strings get an empty buffer (name_len=0
            // out). libdrm uses these only for log lines. If client passes
            // name_len > 0, we write at most that many bytes into the
            // user pointer via a host trampoline (deferred — v1 returns
            // zero-length).
            let v_out = WpkDrmVersion {
                version_major: 1,
                version_minor: 0,
                version_patchlevel: 0,
                name_len: 0, name_ptr: v_in.name_ptr,
                date_len: 0, date_ptr: v_in.date_ptr,
                desc_len: 0, desc_ptr: v_in.desc_ptr,
            };
            unsafe {
                core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, v_out);
            }
            Ok(())
        }

        DRM_IOCTL_GET_CAP => {
            if buf.len() < core::mem::size_of::<WpkDrmGetCap>() {
                return Err(Errno::EINVAL);
            }
            let mut cap: WpkDrmGetCap = unsafe {
                core::ptr::read_unaligned(buf.as_ptr() as *const _)
            };
            cap.value = match cap.capability {
                DRM_CAP_DUMB_BUFFER => 1,
                DRM_CAP_PRIME       => DRM_PRIME_CAP_IMPORT | DRM_PRIME_CAP_EXPORT,
                _                    => 0,  // unknown caps return 0 (Linux-shape)
            };
            unsafe {
                core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, cap);
            }
            Ok(())
        }

        // Remaining DRM ioctls handled in Tasks A6 / A7.
        _ => Err(Errno::ENOTTY),
    }
}
```

**Step 3: Cargo test**

Add a test under `crates/kernel/src/dri/` (or in `syscalls`'s existing tests area): drive `handle_dri_ioctl(0, DRM_IOCTL_GET_CAP, &mut buf)` with `cap.capability = DRM_CAP_DUMB_BUFFER` and assert `cap.value == 1`.

**Step 4: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib syscalls
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/dri/
git commit -m "kernel(dri): DRM_IOCTL_VERSION + DRM_IOCTL_GET_CAP introspection"
```

---

### Task A6: `DRM_IOCTL_MODE_CREATE_DUMB` / `MAP_DUMB` / `DESTROY_DUMB` / `GEM_CLOSE`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `handle_dri_ioctl()` with the four bo-management ioctls.
- Test under `crates/kernel/src/dri/tests.rs` (new).

**Step 1: Implement the four ioctls**

Extend `handle_dri_ioctl()`:

```rust
// In the same match … =>
DRM_IOCTL_MODE_CREATE_DUMB => {
    if buf.len() < core::mem::size_of::<WpkDrmModeCreateDumb>() {
        return Err(Errno::EINVAL);
    }
    let mut req: WpkDrmModeCreateDumb = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    if req.flags != 0 { return Err(Errno::EINVAL); }
    if req.width == 0 || req.height == 0 { return Err(Errno::EINVAL); }
    if req.bpp != 32 && req.bpp != 16 { return Err(Errno::EINVAL); }

    // Insert into the global registry. We don't know the DRM_FORMAT yet —
    // CREATE_DUMB is format-agnostic on Linux; libgbm picks a format
    // separately. We store 0 here; PRIME_HANDLE_TO_FD doesn't need it
    // either. Format only matters when the bo is wrapped as a KMS fb
    // (Phase B of the multiplexer plan).
    let (bo_id, size, stride) = crate::dri::with_registry(|r| {
        let bo = r.alloc(req.width, req.height, req.bpp, 0);
        (bo.id, bo.size, bo.stride)
    });

    // Notify the host so it can allocate the backing SAB. If the host
    // refuses (OOM, etc.), roll back the bo allocation.
    let host_rc = HOST_IO.lock().gbm_bo_create(pid, bo_id, size,
        req.width, req.height, stride, 0);
    if host_rc < 0 {
        crate::dri::with_registry(|r| { r.decref(bo_id); });
        return Err(Errno::ENOMEM);
    }

    // Bind a process-local handle.
    let proc_table = PROCESS_TABLE.lock();
    let proc = proc_table.get_mut(pid).ok_or(Errno::ESRCH)?;
    let handle = proc.dri_next_handle;
    proc.dri_next_handle = proc.dri_next_handle.checked_add(1)
        .ok_or(Errno::EMFILE)?;
    proc.dri_handles.insert(handle, bo_id);

    req.handle = handle;
    req.pitch = stride;
    req.size = size;
    unsafe {
        core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, req);
    }
    Ok(())
}

DRM_IOCTL_MODE_MAP_DUMB => {
    if buf.len() < core::mem::size_of::<WpkDrmModeMapDumb>() {
        return Err(Errno::EINVAL);
    }
    let mut req: WpkDrmModeMapDumb = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    // Resolve handle → BoId.
    let bo_id = {
        let pt = PROCESS_TABLE.lock();
        let proc = pt.get(pid).ok_or(Errno::ESRCH)?;
        *proc.dri_handles.get(&req.handle).ok_or(Errno::ENOENT)?
    };
    // The "mmap offset" is just the BoId left-shifted into the upper
    // bits so it can't collide with file offsets. The kernel-side
    // mmap path (Task A7) decodes the offset back to a BoId.
    req.offset = (bo_id as u64) << 12;  // page-aligned
    unsafe {
        core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, req);
    }
    Ok(())
}

DRM_IOCTL_MODE_DESTROY_DUMB => {
    if buf.len() < core::mem::size_of::<WpkDrmModeDestroyDumb>() {
        return Err(Errno::EINVAL);
    }
    let req: WpkDrmModeDestroyDumb = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    release_dri_handle(pid, req.handle)?;
    Ok(())
}

DRM_IOCTL_GEM_CLOSE => {
    if buf.len() < core::mem::size_of::<WpkDrmGemClose>() {
        return Err(Errno::EINVAL);
    }
    let req: WpkDrmGemClose = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    release_dri_handle(pid, req.handle)?;
    Ok(())
}
```

And the helper:

```rust
fn release_dri_handle(pid: i32, handle: u32) -> Result<(), Errno> {
    let bo_id = {
        let mut pt = PROCESS_TABLE.lock();
        let proc = pt.get_mut(pid).ok_or(Errno::ESRCH)?;
        proc.dri_handles.remove(&handle).ok_or(Errno::ENOENT)?
    };
    let new_rc = crate::dri::with_registry(|r| r.decref(bo_id))
        .ok_or(Errno::EINVAL)?;
    if new_rc == 0 {
        HOST_IO.lock().gbm_bo_destroy(pid, bo_id);
    }
    Ok(())
}
```

**Step 2: Cargo tests**

In a new `crates/kernel/src/dri/tests.rs` (or extend `bo.rs::tests`):

```rust
#[test]
fn create_destroy_roundtrip() {
    // Drive handle_dri_ioctl directly with a mock HostIO.
    // Assert: CREATE_DUMB returns handle ≥ 1, sets size = stride*height,
    // bo registry has one entry; DESTROY_DUMB decrements to zero;
    // host's destroy callback fires.
    // … see test pattern in fbdoom plan Task A6.
}
```

**Step 3: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dri
```

**Step 4: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/dri/
git commit -m "kernel(dri): DRM_IOCTL_MODE_{CREATE,MAP,DESTROY}_DUMB + GEM_CLOSE"
```

---

### Task A7: `DRM_IOCTL_PRIME_HANDLE_TO_FD` / `PRIME_FD_TO_HANDLE`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `handle_dri_ioctl()` with the two prime-fd ioctls.

**Step 1: Export — `PRIME_HANDLE_TO_FD`**

Inside the same match:

```rust
DRM_IOCTL_PRIME_HANDLE_TO_FD => {
    if buf.len() < core::mem::size_of::<WpkDrmPrimeHandle>() {
        return Err(Errno::EINVAL);
    }
    let mut req: WpkDrmPrimeHandle = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    // Resolve process-local handle → BoId.
    let bo_id = {
        let pt = PROCESS_TABLE.lock();
        let proc = pt.get(pid).ok_or(Errno::ESRCH)?;
        *proc.dri_handles.get(&req.handle).ok_or(Errno::ENOENT)?
    };

    // Materialise the prime cookie (idempotent).
    let cookie = crate::dri::with_registry(|r|
        r.ensure_prime_cookie(bo_id)).ok_or(Errno::EINVAL)?;

    // Bump refcount for the new OFD that will hold this prime fd.
    crate::dri::with_registry(|r| r.incref(bo_id));

    // Allocate a fresh fd in the calling process. Use the same
    // path the existing `/dev/dri/renderD128` open uses
    // (CharDevice with sentinel host_handle = -200 for PrimeBo).
    let mut pt = PROCESS_TABLE.lock();
    let proc = pt.get_mut(pid).ok_or(Errno::ESRCH)?;
    let new_fd = proc.alloc_fd_with_ofd(|ofd| {
        ofd.file_type = FileType::CharDevice;
        ofd.host_handle = -200;
        ofd.path = format!("/dev/dri/prime-{}-{:x}",
            bo_id, cookie).into_bytes();
        ofd.prime_bo = Some(PrimeBoState { bo_id, cookie });
    })?;

    req.fd = new_fd as i32;
    unsafe {
        core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, req);
    }
    HOST_IO.lock().gbm_bo_prime_exported(pid, bo_id);
    Ok(())
}
```

**Step 2: Import — `PRIME_FD_TO_HANDLE`**

```rust
DRM_IOCTL_PRIME_FD_TO_HANDLE => {
    if buf.len() < core::mem::size_of::<WpkDrmPrimeHandle>() {
        return Err(Errno::EINVAL);
    }
    let mut req: WpkDrmPrimeHandle = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    // Look up the prime-fd OFD.
    let (bo_id, cookie) = {
        let pt = PROCESS_TABLE.lock();
        let proc = pt.get(pid).ok_or(Errno::ESRCH)?;
        let ofd_idx = proc.fd_table.get(req.fd as i32)
            .ok_or(Errno::EBADF)?;
        let ofd = pt.ofds.entries.get(ofd_idx as usize)
            .and_then(|o| o.as_ref()).ok_or(Errno::EBADF)?;
        let p = ofd.prime_bo.clone().ok_or(Errno::EINVAL)?;
        (p.bo_id, p.cookie)
    };

    // Capability check: cookie must match the bo's current cookie.
    let bo_cookie = crate::dri::with_registry(|r|
        r.get(bo_id).and_then(|b| b.prime_cookie))
        .ok_or(Errno::EACCES)?;
    if bo_cookie != cookie { return Err(Errno::EACCES); }

    // Bump refcount for the new local handle.
    crate::dri::with_registry(|r| r.incref(bo_id));

    // Allocate a new process-local handle.
    let mut pt = PROCESS_TABLE.lock();
    let proc = pt.get_mut(pid).ok_or(Errno::ESRCH)?;
    let handle = proc.dri_next_handle;
    proc.dri_next_handle += 1;
    proc.dri_handles.insert(handle, bo_id);

    req.handle = handle;
    unsafe {
        core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, req);
    }
    Ok(())
}
```

**Step 3: Cargo tests**

Add round-trip tests under `crates/kernel/src/dri/tests.rs`:

```rust
#[test]
fn prime_round_trip_two_processes() {
    // Setup: two Process entries (pids 1 and 2).
    // Process 1: CREATE_DUMB → handle h1 → PRIME_HANDLE_TO_FD → fd f1
    //   manually copy ofd into process 2's fd table (simulating fork's
    //   inherit; in the real demo this is fork+pipe).
    // Process 2: PRIME_FD_TO_HANDLE on its inherited fd → handle h2.
    // Assert: h2 ≠ h1 (different namespace) but both resolve to same BoId.
    //   bo.refcount == 3 (creator + exported prime fd + importer's handle).
    //   GEM_CLOSE(h1) on process 1: refcount=2, host destroy NOT called.
    //   close(f1) on process 1: refcount=1.
    //   GEM_CLOSE(h2) on process 2: refcount=0, host destroy called once.
}

#[test]
fn prime_cookie_mismatch_returns_eaccess() {
    // Manually craft a PrimeBoState with a stale cookie; importer gets EACCES.
}
```

**Step 4: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dri
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/dri/
git commit -m "kernel(dri): DRM_IOCTL_PRIME_HANDLE_TO_FD + PRIME_FD_TO_HANDLE"
```

---

### Task A8: mmap path — bind bo SAB into process Memory

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend the `mmap` syscall path on `/dev/dri/renderD128` to decode the `bo_offset` (from MAP_DUMB) and call `HostIO::gbm_bo_bind`.

**Step 1: Decode bo_offset in `sys_mmap`**

Around the existing `mmap` dispatch (the same point that handles `mmap` of `/dev/fb0`): match on the OFD's `host_handle` against `VirtualDevice::DriRender0.host_handle()`, then look at the `offset` arg:

```rust
// In sys_mmap, post-resolve-fd, before the anonymous path:
if let Some(vd) = VirtualDevice::from_host_handle(ofd.host_handle) {
    if vd == VirtualDevice::DriRender0 {
        // Decode bo_offset: top bits are BoId, bottom bits should be 0
        // (page-aligned encoding from MAP_DUMB).
        let bo_id = (offset >> 12) as u32;
        let bo = crate::dri::with_registry(|r| r.get(bo_id).cloned())
            .ok_or(Errno::EINVAL)?;
        // Resolve which local handle the calling process has for this
        // bo; reject if none (Linux requires the caller to hold a handle).
        let pt = PROCESS_TABLE.lock();
        let proc = pt.get(pid).ok_or(Errno::ESRCH)?;
        if !proc.dri_handles.values().any(|&id| id == bo_id) {
            return Err(Errno::EACCES);
        }
        drop(pt);

        // Length must be ≤ bo.size, rounded up to page boundary.
        if (length as u64) > bo.size {
            return Err(Errno::EINVAL);
        }

        // Reserve anonymous wasm pages via existing mmap_anonymous, then
        // notify host to redirect them at the bo's SAB.
        let addr = MemoryManager::with(pid, |mm|
            mm.mmap_anonymous(hint as usize, length, prot, flags))?;
        let rc = HOST_IO.lock().gbm_bo_bind(pid, bo_id, addr, length);
        if rc < 0 { /* unwind: munmap_anonymous + return rc */ }
        // Record the binding so munmap can call gbm_bo_unbind.
        // Use a small per-process Vec<(addr, len, bo_id)> on Process.
        return Ok(addr as i64);
    }
}
```

(Adapt the actual `mmap_anonymous` call to whatever the current syscalls.rs API is — the framework is the same: reserve, bind, record.)

**Step 2: Add `dri_mmaps` tracking on Process**

```rust
// in Process:
pub dri_mmaps: Vec<DriMmap>,

pub struct DriMmap {
    pub addr: usize,
    pub len: usize,
    pub bo_id: u32,
}
```

**Step 3: Cargo test**

Verify: after CREATE_DUMB → MAP_DUMB → mmap, the kernel's `dri_mmaps` records the binding; the host stub recorded a single `gbm_bo_bind` call with matching args.

**Step 4: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/process.rs
git commit -m "kernel(dri): mmap(/dev/dri/renderD128, bo_offset) binds bo into process Memory"
```

---

### Task A9: cleanup — munmap / close / exit / execve / fork

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `munmap`, `close`, and process-exit paths to release bo refcounts.
- Modify: `crates/kernel/src/wasm_api.rs` — `SYS_EXIT_GROUP` cleanup.
- Modify: `crates/kernel/src/fork.rs` — reset child's `dri_mmaps` (fork doesn't inherit mmaps of dri fds — they're per-process memory).

**Step 1: munmap**

In `sys_munmap`, before returning: check `dri_mmaps` for a matching `(addr, len)`. If found, call `HOST_IO.lock().gbm_bo_unbind(pid, bo_id, addr, len)` and remove the entry. Note: this does **not** decref the bo; the handle is what holds the refcount. munmap only undoes the address-space binding.

**Step 2: close**

In `sys_close`, when releasing an OFD with `prime_bo: Some(p)`, call `crate::dri::with_registry(|r| r.decref(p.bo_id))` and if it returns Some(0) call `HOST_IO.lock().gbm_bo_destroy(pid, p.bo_id)`.

**Step 3: process exit**

In `wasm_api.rs::process_exit` (or the `SYS_EXIT_GROUP` handler): iterate through `proc.dri_handles` and `proc.dri_mmaps`; for each:
- unbind every dri_mmap;
- decref every dri_handles entry;
- close every OFD with prime_bo (handled by the existing OFD-cleanup loop, since we hook into `release_dri_handle`-equivalent logic).

**Step 4: execve**

execve zeros the address space. The existing `Process::reset_for_execve` (or equivalent) clears fb_binding; replicate for `dri_mmaps`. Per-process handles (`dri_handles`) survive execve only if the corresponding fds are CLOEXEC-not-set; let the fd-cleanup logic that already handles CLOEXEC drive `release_dri_handle` for closed fds.

**Step 5: fork**

(Already done in Task A3.) Add a regression test: parent mmaps a bo at addr A; fork; parent's dri_mmaps still contains A; child's dri_mmaps is empty (child has the inherited bo SAB but doesn't address it as a mmap until its own MAP_DUMB+mmap).

**Step 6: Cargo tests**

```rust
#[test]
fn close_drops_prime_fd_refcount() { /* … */ }

#[test]
fn process_exit_releases_all_bos() {
    // Setup: process owns 3 bos (handles + 1 mmap'd).
    // Drive process_exit; assert: all 3 bos destroyed, host got 3
    // destroy callbacks + 1 unbind callback.
}
```

**Step 7: Run + Commit**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
git add crates/kernel/src/
git commit -m "kernel(dri): cleanup — munmap / close / exit / execve / fork"
```

---

### Task A10: ABI snapshot regen (additive — no `ABI_VERSION` bump)

**Files:**
- Modify: `abi/snapshot.json` (auto-generated).
- DO NOT modify: `crates/shared/src/lib.rs` `ABI_VERSION` — additive changes don't require a bump per `docs/abi-versioning.md`.

**Step 1: Regenerate**

```bash
bash scripts/check-abi-version.sh update
```

**Step 2: Inspect the diff**

```bash
git diff abi/snapshot.json
```

Expected diff: new entries under `marshalled_structs` for `WpkDrmModeCreateDumb`, `WpkDrmModeMapDumb`, `WpkDrmModeDestroyDumb`, `WpkDrmGemClose`, `WpkDrmPrimeHandle`, `WpkDrmGetCap`, `WpkDrmVersion`. New entries for the 5 new `host_gbm_*` imports (`_create / _destroy / _bind / _unbind / _prime_exported`). **No** changes to any *existing* row — if you see one, stop and investigate.

**Step 3: Verify**

```bash
bash scripts/check-abi-version.sh
```

Expected: exit 0 — additive-compat classification passes.

**Step 4: Commit**

```bash
git add abi/snapshot.json
git commit -m "kernel(dri): regen ABI snapshot — additive GBM ioctl + host imports"
```

---

### Task A11: Phase A — full gauntlet + open PR #1

**Step 1: Run the full gauntlet** (CLAUDE.md):

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Expected: zero regressions vs the v1 baseline.

**Step 2: Push the branch**

```bash
git push -u origin emdash/explore-direct-rendering-infrastructure-buffer-kernel-XXXXX
```

(Do not push to upstream remote — only the user's `mho22` fork.)

**Step 3: Open the draft PR**

PR title: `[explore-dri] kernel(dri): GBM dumb-buffer + prime fd + bo mmap`

PR body template:

```markdown
## Summary
- Add the GBM dumb-buffer ioctl surface on top of v1's `/dev/dri/renderD128`:
  `MODE_CREATE_DUMB`, `MAP_DUMB`, `DESTROY_DUMB`, `GEM_CLOSE`,
  `PRIME_HANDLE_TO_FD`, `PRIME_FD_TO_HANDLE`, `VERSION`, `GET_CAP`.
- Introduce a global `BoRegistry` (one entry per live bo, refcounted)
  with per-Process GEM-handle namespaces.
- mmap(`/dev/dri/renderD128`, bo_offset) binds the bo's SAB into the
  process's wasm `Memory` via a new `HostIO::gbm_bo_bind` callback.
  Pixels live in the host SAB; writes go through the wasm pointer
  with no per-frame syscall.
- Prime fds are scoped to a narrow `OpenFileKind::PrimeBoState`
  carrying a `(bo_id, cookie)` capability; importer mismatches return
  `EACCES`.

## Why
Milestone (A) of the v2 DRI design (`docs/plans/2026-05-18-dri-design.md`
§4) — bo lifecycle + cross-process sharing — is a precondition for
every other milestone (multiplexer, KMS, compositor). v1 only had
the GL command-buffer surface; this PR adds the buffer surface.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
Additive only — no `ABI_VERSION` bump. New `repr(C)` structs in
`shared::dri`, new ioctl numbers in the unused DRM `'d'` magic range,
new `host_gbm_*` host imports. No existing struct, ioctl, or import
changed. Classified additive-compat by
`scripts/check-abi-version.sh` (PR #490 policy).

## Notes
- Host wiring is in the follow-up `host(dri)` PR; this PR's tests
  use the stubbed `HostIO::gbm_*` in `centralized-test-helper.ts`,
  which captures call args.
- `DRM_IOCTL_MODE_ADDFB2` / `_PAGE_FLIP` / `_GETRESOURCES` are KMS
  (card0); deferred to the multiplexer/KMS plan.
- `gbm_bo_map` cache-flush no-ops (`_flags`) follow Linux semantics
  for LINEAR; verified against the design §4.7 trade-off.
```

**Do not merge.** Mark draft until Brandon validates.

---

## Phase B — Host GbmRegistry + SAB-backed bo store + `mmap_shared` (PR #2)

Phase B wires the kernel's `HostIO::gbm_*` callbacks to a real host-side `GbmRegistry`. The bo's SAB lives here; processes see it through wasm-memory aliasing via a new `MemoryManager.mmap_shared(addr, len, sab, offset)` API. Tests under `host/test/dri-*.spec.ts` exercise the full kernel↔host loop via a wasm test program (Phase C ships the program; B's tests use a recording bridge).

### Task B1: `GbmRegistry` host module

**Files:**
- Create: `host/src/dri/gbm-registry.ts`.

```ts
// host/src/dri/gbm-registry.ts

export interface HostBo {
  id: number;
  width: number;
  height: number;
  stride: number;
  size: number;
  sab: SharedArrayBuffer;     // CPU-shared tier — the only tier in v1.
  byteOffset: number;          // always 0 in v1 (one SAB per bo)
}

export class GbmRegistry {
  private bos = new Map<number, HostBo>();

  create(boId: number, width: number, height: number,
         stride: number, size: number, _format: number): number {
    const sab = new SharedArrayBuffer(size);
    this.bos.set(boId, { id: boId, width, height, stride, size, sab,
                          byteOffset: 0 });
    return 0;
  }

  destroy(boId: number): void {
    this.bos.delete(boId);
  }

  get(boId: number): HostBo | undefined { return this.bos.get(boId); }
}
```

Cover with a unit test under `host/test/dri-gbm-registry.spec.ts`: create / destroy / refcount-free SAB.

**Commit:** `host(dri): GbmRegistry module + unit tests`

---

### Task B2: `MemoryManager.mmap_shared`

**Files:**
- Modify: `host/src/memory.ts` (or wherever `MemoryManager` lives on the host).

Extend the wasm-`Memory`-aliasing path so that a region `[addr, addr+len)` can be redirected at an arbitrary SAB slice. The existing `mmap_anonymous` allocates pages in the process's `Memory`; `mmap_shared` overlays *its* SAB view onto a slice of another SAB. Implementation in browsers without `SharedArrayBuffer.prototype.transfer`: copy on bind + write-through trap is not feasible; instead we share the buffer at process-`Memory`-creation time so every process's `Memory` *is* a slice of a global SAB pool, and `mmap_shared` just records the redirection in a translation table that read/write helpers consult.

(The exact mechanism may need a small spike — see "Risk register" below. If a true zero-copy redirection isn't tractable across browsers, fall back to per-tick `Atomics.store` syncs between the bo SAB and process Memory. v1 is a non-perf-critical demo, so the fallback is acceptable for milestone (A).)

**Commit:** `host(dri): MemoryManager.mmap_shared — alias wasm Memory at a SAB slice`

---

### Task B3: Wire `host_gbm_*` imports into kernel-worker

**Files:**
- Modify: `host/src/kernel.ts` — register the five `gbm_*` callbacks as host imports.
- Modify: `host/src/kernel-worker.ts` — forward them to `GbmRegistry` + `MemoryManager`.

Trivial plumbing once B1 + B2 are in. Pattern mirrors v1's `host_gl_*` wiring (see commit `ec29a571` on `explore-webgl-exposition-kernel`).

**Dual-host parity (CLAUDE.md): both `host/src/node-kernel-worker-entry.ts` and `examples/browser/lib/kernel-worker-entry.ts` must wire the same callbacks. Symmetry check is mandatory before commit.**

**Commit:** `host(dri): wire host_gbm_* imports — kernel-worker → GbmRegistry`

---

### Task B4: `dumbtest.wasm` + Vitest integration

**Files:**
- Create: `programs/dumbtest.c` — minimal C program that opens `/dev/dri/renderD128`, CREATE_DUMBs a 64×64 ARGB8888 bo, mmaps it, writes a known pattern, returns 0 on success.
- Add: `host/test/dri-buffer.spec.ts` — runs the compiled `dumbtest.wasm` through the centralized kernel, asserts the host's `GbmRegistry` ends up with the expected SAB contents.

**Commit:** `host(dri): dumbtest + vitest integration spec`

---

### Task B5: Phase B — full gauntlet + open PR #2

PR title: `[explore-dri] host(dri): GbmRegistry + SAB-backed bo store + mmap_shared`

Body: Summary / Why / Verification / Dual-host parity proof (browser entry + Node entry both wired, both tested) / Notes.

---

## Phase C — DRM headers, libgbm stub, demo program (PR #3)

Phase C is the user-facing surface: vendored Linux UAPI headers, a small `libgbm.a` + `libdrm.a` (~250 LoC C total) in the sysroot, and the milestone-(A) demo. The demo is two processes via `fork`: parent CREATE_DUMBs a 256×256 bo, writes a gradient, PRIME_HANDLE_TO_FDs, passes the fd through an inherited pipe; child reads the fd, PRIME_FD_TO_HANDLEs, mmaps, verifies the gradient byte-for-byte, exits 0.

### Task C1: Vendor `linux/include/uapi/drm/*` headers

**Files:**
- Create: `musl-overlay/include/drm/drm.h`, `drm_mode.h`, `drm_fourcc.h` — verbatim from a pinned Linux release (e.g. v6.10 LTS).

Add the pinned source URL + sha256 to a `musl-overlay/include/drm/SOURCE.txt`. Headers stay byte-for-byte upstream — any kernel-side wasm32 size differences are handled by the ioctl number tests in Task A1, not by header edits.

**Commit:** `kernel(dri): vendor Linux UAPI drm/{drm,drm_mode,drm_fourcc}.h`

---

### Task C2: `glue/libdrm_stub.c` — minimal libdrm

The demo only needs `drmIoctl()` (a thin ioctl wrapper) and `drmGetVersion()` (for compatibility with libgbm's probe). Plus `drmCloseBufferHandle()` which is `ioctl(DRM_IOCTL_GEM_CLOSE)`.

```c
// glue/libdrm_stub.c — ~80 LoC
#include <drm/drm.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

int drmIoctl(int fd, unsigned long request, void *arg) {
    int ret;
    do { ret = ioctl(fd, request, arg); } while (ret < 0 && errno == EINTR);
    return ret;
}

typedef struct _drmVersion {
    int version_major, version_minor, version_patchlevel;
    int name_len; char *name;
    int date_len; char *date;
    int desc_len; char *desc;
} drmVersion, *drmVersionPtr;

drmVersionPtr drmGetVersion(int fd) {
    drmVersionPtr v = calloc(1, sizeof(*v));
    // … fill via DRM_IOCTL_VERSION, allocate string buffers, return.
    return v;
}

void drmFreeVersion(drmVersionPtr v) {
    if (!v) return;
    free(v->name); free(v->date); free(v->desc); free(v);
}

int drmCloseBufferHandle(int fd, uint32_t handle) {
    struct drm_gem_close req = { .handle = handle, .pad = 0 };
    return drmIoctl(fd, DRM_IOCTL_GEM_CLOSE, &req);
}
```

Build to `sysroot/lib/libdrm.a`.

**Commit:** `sysroot(dri): libdrm stub — drmIoctl + drmGetVersion + drmCloseBufferHandle`

---

### Task C3: `glue/libgbm_stub.c` — minimal libgbm

```c
// glue/libgbm_stub.c — ~150 LoC
#include <gbm.h>
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <drm/drm_fourcc.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
// ...

struct gbm_device { int fd; };
struct gbm_bo {
    struct gbm_device *dev;
    uint32_t handle, width, height, stride;
    uint64_t size, modifier;
    uint32_t format;
    void *map_addr; size_t map_len;
};

struct gbm_device *gbm_create_device(int fd) {
    struct gbm_device *d = calloc(1, sizeof(*d));
    d->fd = fd; return d;
}
void gbm_device_destroy(struct gbm_device *d) { free(d); }

struct gbm_bo *gbm_bo_create(struct gbm_device *dev,
        uint32_t w, uint32_t h, uint32_t format, uint32_t flags) {
    struct drm_mode_create_dumb req = {
        .width = w, .height = h, .bpp = 32, .flags = 0
    };
    if (drmIoctl(dev->fd, DRM_IOCTL_MODE_CREATE_DUMB, &req) < 0)
        return NULL;
    struct gbm_bo *bo = calloc(1, sizeof(*bo));
    bo->dev = dev; bo->handle = req.handle;
    bo->width = w; bo->height = h;
    bo->stride = req.pitch; bo->size = req.size;
    bo->format = format; bo->modifier = DRM_FORMAT_MOD_LINEAR;
    return bo;
}
// ... gbm_bo_destroy, gbm_bo_get_fd, gbm_bo_import,
//     gbm_bo_get_width/height/stride/format/modifier, gbm_bo_map.
```

Build to `sysroot/lib/libgbm.a`. Vendor `<gbm.h>` from libgbm's release archive into `musl-overlay/include/gbm.h`.

**Commit:** `sysroot(dri): libgbm stub — gbm_bo_create / _destroy / _get_fd / _import / _map`

---

### Task C4: `programs/dumb_roundtrip.c` — milestone (A) demo

```c
// programs/dumb_roundtrip.c — ~120 LoC
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <gbm.h>
#include <drm/drm.h>

int main(void) {
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror("open renderD128"); return 1; }

    struct gbm_device *dev = gbm_create_device(fd);
    struct gbm_bo *bo = gbm_bo_create(dev, 256, 256,
        DRM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR);
    if (!bo) { perror("gbm_bo_create"); return 1; }

    // Map bo and write a known gradient.
    uint32_t *px = gbm_bo_map(bo, 0, 0, 256, 256, 0, NULL, NULL, NULL);
    for (int y = 0; y < 256; y++)
        for (int x = 0; x < 256; x++)
            px[y * (bo->stride/4) + x] = (255 << 24) | (x << 16) | (y << 8);

    // Export prime fd.
    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) { perror("get_fd"); return 1; }

    // Pipe to pass to child.
    int p[2]; if (pipe(p) < 0) return 1;

    pid_t pid = fork();
    if (pid == 0) {
        // child: read prime fd (passed via inherited fd table), import,
        // mmap, verify gradient byte-for-byte. exit 0 on success.
        close(p[1]);
        struct gbm_device *cdev = gbm_create_device(fd);
        struct gbm_bo *cbo = gbm_bo_import(cdev, GBM_BO_IMPORT_FD,
            &(struct gbm_import_fd_data){ .fd = prime, .width = 256,
                .height = 256, .stride = 256*4,
                .format = DRM_FORMAT_ARGB8888 }, 0);
        if (!cbo) { perror("import"); _exit(2); }
        uint32_t *cpx = gbm_bo_map(cbo, 0, 0, 256, 256, 0, NULL, NULL, NULL);
        uint32_t cstride_px = cbo->stride / 4;  // match parent's writer stride
        for (int y = 0; y < 256; y++)
            for (int x = 0; x < 256; x++) {
                uint32_t want = (255 << 24) | (x << 16) | (y << 8);
                if (cpx[y * cstride_px + x] != want) {
                    fprintf(stderr, "mismatch at %d,%d\n", x, y);
                    _exit(3);
                }
            }
        _exit(0);
    }
    // parent: wait, exit 0 if child exited 0.
    int st; waitpid(pid, &st, 0);
    return WIFEXITED(st) && WEXITSTATUS(st) == 0 ? 0 : 1;
}
```

Build with `wasm32posix-cc -o programs/dumb_roundtrip.wasm programs/dumb_roundtrip.c -lgbm -ldrm`. Wire into `scripts/build-programs.sh`.

**Commit:** `examples(dri): dumb_roundtrip — milestone (A) two-process bo round-trip`

---

### Task C5: End-to-end Vitest spec

**Files:**
- Add: `host/test/dri-dumb-roundtrip.spec.ts` — runs `dumb_roundtrip.wasm` under the centralised kernel, asserts the child exits 0 (gradient round-tripped successfully).

**Commit:** `host(dri): vitest — dumb_roundtrip end-to-end`

---

### Task C6: Manual browser verification (the gate)

Per CLAUDE.md item 6. Build the demo, drop it into `examples/browser/pages/dridemo/` (an HTML page that runs `dumb_roundtrip.wasm` and pretty-prints the exit code), `./run.sh browser`, navigate to the page in Chrome, confirm: child exits 0, page reports "milestone (A) PASS".

**No commit yet for this task — verification only.** If the demo fails in browser but passes in Node, that's a host-parity bug (CLAUDE.md "dual-host parity" — see PR #410 cautionary tale). Fix and re-run before opening PR #3.

---

### Task C7: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(dri): dumb-buffer round-trip demo + browser spec`

Body: Summary / Why / Verification (the gauntlet + browser screenshot) / Dual-host parity proof / Notes.

---

## Final coordinated merge

When all three PRs (kernel, host, examples) are reviewed and approved, and Brandon has signed off on the demo running cleanly in browser + Node:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → PR #3's base.
4. Squash-merge PR #3 → `explore-webgl-exposition-demo`.
5. Tag: `[explore-dri-buffer] milestone (A) merged at <sha>` in the next session-handoff doc.

**Do not push to upstream until v1 itself merges upstream.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **CPU-shared tier only in this plan.** GPU-tier bos (WebGLTexture-backed) need the multiplexer + EGLImage path; deferred to the multiplexer plan. Demos in this plan that need CPU access (milestone A) work; demos that need GPU sampling (milestone B's cube-pair) belong in the next plan.
- **GEM handles per-Process, not per-fd.** Linux is per-fd; we mirror v1's `gl_state`-on-Process decision (single-owner in v1, lifted in the multiplexer plan when single-owner is too). Cost: a process can't have two independent renderD128 fds with disjoint handle namespaces — but in v1 a process can't have two opens at all (single-owner), so the constraint is invisible.
- **Prime cookie is a single u64 per bo, not per-export.** A future hardening pass could rotate cookies per-export; v1 trusts that the bo-id namespace + 64-bit cookie make accidental collision negligible.
- **`drm_version` strings written zero-length in v1.** libdrm and libgbm log the driver name on init; they tolerate empty strings. A full string-write path requires a host trampoline to write into the caller's wasm pointer; not worth the complexity for milestone (A). Add when SDL2 / libinput depend on the strings (Phase D in the design's roadmap).
- **No `DRM_IOCTL_MODE_GETRESOURCES` / KMS in this plan.** card0 is a separate device file with its own design (§6); the buffer plan is renderD128 only.
- **Fork inherits prime-fd OFDs, not GEM handles.** Matches Linux semantics: child has the fd, must `PRIME_FD_TO_HANDLE` to get an addressable handle.

---

## Risk register

1. **`MemoryManager.mmap_shared` cross-browser feasibility (Task B2)** — Chrome / Firefox / Safari may differ on whether a `Memory`-backing SAB can be aliased to a slice of another SAB. A spike under `host/test/dri-mmap_shared.spec.ts` runs first thing in Phase B. If true zero-copy aliasing isn't viable, fall back to per-tick `Atomics`-driven sync between the bo SAB and process Memory; the demo loses zero-copy but still passes correctness.
2. **`fork`-inherited prime-fd OFD refcount races.** Cargo unit tests cover the single-threaded case; the kernel's GKL means there's no concurrent fork during a refcount change. Still worth a comment in `prime_handle_to_fd` describing the invariant.
3. **`drm_mode_create_dumb.bpp != 32` paths.** v1 of the plan accepts 16 and 32; 8-bit and 24-bit are deferred. If the demo or libgbm probes with bpp=24, return `EINVAL` cleanly — libgbm's probe loop falls back to 32.
4. **`gbm_bo_import` on a freshly-fork-inherited prime fd before PRIME_FD_TO_HANDLE.** The child's `dri_handles` is empty after fork; `gbm_bo_map` requires a local handle. The demo (Task C4) calls `gbm_bo_import` explicitly, which triggers PRIME_FD_TO_HANDLE. Test case in Task A7 verifies the round-trip.

---

## What this plan doesn't cover (deferred)

- **Multiplexer (§5).** N processes with N GL contexts on one host WebGL2RenderingContext. Next plan.
- **GBM surface (`gbm_surface_create` + EGL window surface).** A triple-buffered rotation of bos for `eglSwapBuffers`. Next plan (after multiplexer — they share the GL-host wiring).
- **KMS / card0 (§6).** Page-flip, vblank, master/slave. Plan after multiplexer.
- **GPU-tier bos + EGLImage.** Same plan as multiplexer.
- **`SCM_RIGHTS` for prime-fd passing over unix sockets.** Milestone (A) uses fork+inherit; the compositor (PID 2) talking to clients needs SCM_RIGHTS, which lives in the existing phase-6-sockets plan (`docs/plans/2026-03-08-phase6-sockets-plan.md`). Audit + finish it before the compositor plan opens.
- **DRM_FORMAT_MOD_*** beyond `LINEAR`.
- **Multi-renderD-node** (renderD129 = WebGPU). Post-v1.

---

End of plan.
