# DRI v2 — N-guest → 1-host GL multiplexer plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Lift v1's single-open constraint on `/dev/dri/renderD128`. Allow N
processes — each with one or more GL contexts — to share the single host
`WebGL2RenderingContext` via per-context state shadows + lazy switch (design
§5, option C). Add the compositor head-of-queue priority lane. Activate the
GPU-tier bos plan 2 reserved (§4.2). The proof-of-concept demo is two
unrelated processes each rendering a spinning cube into their own bo, both
visible on the same OffscreenCanvas. The compositor itself (PID 2) is **not**
in this plan — it gets its own plan (§9 of the design). The compositor
priority lane is exercised by a "fake compositor pid 2" in vitest.

**Architecture:** The host's single `WebGL2RenderingContext` lives in the
kernel-worker (v1's choice; do not move it). Each `(pid, ctx_id)` binding
gains a per-context `GlShadowState` (~40 entries — viewport, scissor,
clearColor/Depth, blend, depth/cull/front-face, current program,
texture-unit bindings, etc.), a per-context VAO, and a per-context FBO.
The host muxer's `switchTo(target)` rebinds VAO/FBO and re-applies state on
every cross-client submit. If consecutive submits come from the same
binding, `switchTo` is a no-op (lazy switch, design §5.2). Submissions are
queued by `(pid, ctx_id)` with two priority lanes: `COMPOSITOR_PRI` (PID 2)
head-of-queue, `CLIENT_PRI` everyone else, FIFO within lane. Submits are
atomic — no preemption mid-cmdbuf (design §5.5). On the kernel side, this
plan **lifts plan 2's `dri_handles`-on-Process choice to per-fd**
(`OpenFileDesc::dri_handles`) — Linux-shape semantics, anticipated by plan
2's Trade-offs. The same lift applies to v1's `gl_state` (which v1 placed
on `Process` for single-owner). GPU-tier bos are backed by host
`WebGLTexture` objects; foreign-texture bind (`GLIO_BIND_FOREIGN_TEXTURE`)
lets one client sample another's bo as a texture via the shared host
context's `WebGLTexture` namespace. Companion design doc:
`docs/plans/2026-05-18-dri-design.md` §5 + §4.2.

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser + Node), C
user programs cross-compiled with `wasm32posix-cc`. Builds on plan 2's
`libgbm.a` + `libdrm.a` stubs; extends libgbm to handle
`GBM_BO_USE_RENDERING` (routes to the GPU-tier ioctl).

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §5
(multiplexer) and §4.2 (bo tiers — GPU tier activates here). POSIX vs Linux
UAPI: `open`/`close`/`mmap`/`ioctl` are POSIX; the GLIO_* / DRM_IOCTL_* /
shadow-state design is our own (no Linux analog — Mesa's
`mesa_glthread` is the nearest cousin, conceptually).

**Consistency with plan 2:**
- Plan 2 placed `dri_handles` on `Process` ("v1 is single-owner; lifted by
  the multiplexer plan when single-owner is too"). **This plan does the
  lift.** Task A2 moves state from `Process` to `OpenFileDesc` and updates
  every call site touched by plan 2 (Phase A Tasks A3, A6-A9). Plan 2's
  Pre-implementation review names per-fd-vs-per-Process as a deliberate v1
  simplification; verifying this lift is part of the devil's-advocate pass
  against plans 2 + 3 together.
- Plan 2's `BoTier::Gpu` enum variant was reserved but unimplemented. This
  plan activates it (Task A3, B7).
- Plan 2's `mmap_shared` (B2) carries the bo SAB backing for the CPU-shared
  tier. The GPU tier does **not** use `mmap_shared` — GPU-tier bos have no
  CPU-mapped backing (the bytes live in `WebGLTexture` storage, not a SAB).
  Plan 2's risk register #1 (cross-browser `mmap_shared` viability) is
  independent of this plan; if plan 2 falls back to SAB-pool redesign,
  this plan still works as written for the GPU tier.

**Stack base:** Plan 2's tip — `…-buffer-demo` (plan 2 PR #3's head).
This plan extends plan 2's `BoRegistry`, `OpenFileDesc`, and host
`GbmRegistry` without breaking any of plan 2's tests. v1's GLES2 surface
(`host_gl_*` imports, `GLIO_*` ioctls in `shared::gles`, `Process::gl_state`)
is the load-bearing scaffolding under everything.

**Branch:** `emdash/explore-direct-rendering-infrastructure-multiplexer-plan-XXXXX`
(chains off the previous DRI branch per the user's branching rule).
Three sub-branches stack off it for the three implementation PRs.

**Final PR base:** Plan 2's `…-buffer-demo` branch tip. **Do not merge**
until Brandon validates the design, plan 2 lands, and Phase C's manual
browser verification passes. CLAUDE.md "no merge before Brandon's
validation" rule.

**Three PRs, coordinated merge.** Each task below is one commit. PR
titles follow Brandon's `scope(area): action` shape:

1. `kernel(dri): per-fd gl_state + per-fd dri_handles + GPU-tier bos + foreign-texture ioctl`
2. `host(dri): GlMuxer + shadow state + WebGLTexture cross-context map + GPU-tier bo backing`
3. `examples(dri): two-cube multiplex demo + vitest interleave spec`

PR base/head topology (stacked per the user's branching rule):

```
explore-webgl-exposition-demo                   (v1 tip)
 └── …-buffer-plan-XXXXX                        (plan 2 PR base)
      └── …-buffer-kernel  (plan 2 PR #1)
           └── …-buffer-host  (plan 2 PR #2)
                └── …-buffer-demo  (plan 2 PR #3)
                     └── …-multiplexer-plan-YYYYY    (this plan PR base)
                          └── …-mux-kernel    (PR #1)
                               └── …-mux-host    (PR #2)
                                    └── …-mux-demo  (PR #3)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass with zero
regressions before any PR is opened, and re-run before final merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds manual `./run.sh browser` verification of the
two-cube demo (CLAUDE.md item 6).

**ABI impact:** **Additive only — no `ABI_VERSION` bump.** Per
`docs/abi-versioning.md` (PR #490 policy):
- New ioctl numbers in the existing DRM `'d'` magic range (`0xE0..0xE2`,
  unused by Linux 6.x DRM): `DRM_IOCTL_WPK_CREATE_GPU_BO`,
  `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE`. Naming: `WPK_*` for our extensions
  to keep them distinguishable from upstream Linux DRM ioctls if the
  vendored headers are ever audited side-by-side with mainline.
- New `repr(C)` struct `WpkDrmGpuBoCreate` in `shared::dri`.
- One new `host_gl_*` import: `host_gl_bind_foreign_texture`. Plan 2's
  five `host_gbm_*` imports remain unchanged; v1's ten `host_gl_*` imports
  unchanged.
- `BoTier::Gpu` variant on the kernel-internal `BoTier` enum was already
  reserved in plan 2's `crates/kernel/src/dri/bo.rs`; no ABI surface,
  not in `shared::dri`. Activating it requires no snapshot change.
- No change to v1's `GLIO_*` numbers, v1's `GlSubmitInfo` /
  `GlContextAttrs` / `GlSurfaceAttrs` / `GlQueryInfo` structs, channel
  layout, syscall numbers, kernel exports, asyncify slots.

Existing structs, ioctls, and imports — all unchanged.

---

## Pre-implementation review

Devil's-advocate pass, 2026-05-19 (session 4 — same-day continuation
of the plan 2 + plan 3 drafts). Each item below is either *fixed in
place* (a correction to the drafted prose, already applied) or *open
for the implementation PR to address* (a bug, missing test, or
architectural concern in the design as drafted). Cross-plan
consistency was checked with plan 2's review section in the same
session — the per-`Process`→per-OFD lift is the load-bearing seam, so
each plan-2 callsite was walked against its plan-3 sibling.

### Correctness — fixed in place

- **`gl_next_ctx_id` overflow returns `EMFILE` in the Risk register
  but the narrative section never named an errno.** `EMFILE` is the
  fd-table-vs-rlimit errno; a context-table exhaustion is a
  kernel-allocation failure, which Linux's GL stacks (and POSIX
  generally) signal with `ENOMEM`. *Switched the Risk register entry
  to `ENOMEM` with the reasoning inline.* Implementation
  (`GLIO_CREATE_CONTEXT`) must match: `proc.gl_next_ctx_id.checked_add(1)
  .ok_or(Errno::ENOMEM)?`.
- **`GLIO_UNBIND_FOREIGN_TEXTURE` was named in the `WpkDrmBindForeignTexture`
  docstring but never defined anywhere.** No such opcode exists; the
  bind lifetime is tied to the bo's lifetime (the bo is the canonical
  `WebGLTexture` owner). When the bo's refcount drops to zero,
  `gbm_bo_destroy(pid, bo_id)` on the host deletes the texture and
  every binding to it is invalidated. *Rewrote the docstring to spell
  out the bo-scoped lifetime and to remove the phantom opcode.*
- **`GlShadowState.vao` was typed `WebGLVertexArrayObject` (non-null)
  with a placeholder `null as unknown as WebGLVertexArrayObject` in
  `defaultShadow`.** Type-system lie — a binding accessed before
  `MAKE_CURRENT` would carry the `null`-shaped sentinel and
  silently propagate. *Switched the type to `WebGLVertexArrayObject |
  null`; `switchTo` already calls `gl.bindVertexArray(s.vao)`, which
  accepts `null` (unbinds) so the runtime behaviour is unchanged but
  the lie is gone.*
- **`SubmitQueue.pickNext` left exhausted entries in `byKey` + the
  lane until they cycled back to the head.** A heavy client that
  bursts one frame per microtask would balloon `byKey` proportional to
  the drain backlog. *Added `releaseIfEmpty(entry)` for drain to call
  after popping the last frame; `byKey` and the lane drop the entry
  promptly. Drain in B4 now calls it after each `decodeAndDispatch`.*
- **Task A3 (`DRM_IOCTL_WPK_CREATE_GPU_BO`) unwind was asymmetric
  with plan 2's Task A6 unwind.** If the OFD handle lookup failed
  after the host had already allocated the texture, the code
  decremented the kernel registry but never called
  `gbm_bo_destroy(pid, bo_id)` on the host — host-side `WebGLTexture`
  leaked. *Restructured the per-fd handle allocation as a closure
  whose `Err` arm decrements the registry **and** calls
  `gbm_bo_destroy`, mirroring plan 2 A6's unwind shape. Spelled out
  the borrow-checker scoping note so the `(immut → mut)` re-borrow on
  `PROCESS_TABLE` is unambiguous; the prior sketch held an immutable
  `proc` reference while taking `pt.ofds.entries` mutably.*

### Correctness — open, address in the implementation PRs

- **`on_final_close` passes the *closing* process's pid to
  `host_io.gl_destroy_context(pid, ctx_id)` and `gbm_bo_destroy(pid,
  bo_id)`.** When the OFD has been fork-inherited, the closer's pid
  is not the creator's pid; the host's binding registry is keyed by
  the creator's pid + ctx_id. This **silently** leaks the host-side
  context (and any bo whose host record is keyed by pid). Action: the
  OFD must record the *creator* pid for each binding + bo, and
  `on_final_close` passes the recorded creator pid. Alternative
  (more invasive): drop pid from the host destroy API entirely and
  key host-side bindings by a globally-unique kernel-side id (a
  `(BoId, ctx_id)` pair scoped to the OFD). Decide before Task A5.
- **Two OFD-side optional dri fields (`prime_bo` from plan 2 +
  `dri` from plan 3) on `OpenFileDesc`.** Plan 2 added
  `prime_bo: Option<PrimeBoState>`; plan 3 adds
  `dri: Option<Box<DriFdState>>`. They're disjoint use cases (an OFD
  is either a renderD128 open OR a prime-bo OFD, never both), so a
  single `dri: Option<Box<DriOfdState>>` enum
  (`{ RenderNode(DriFdState), PrimeBo(PrimeBoState) }`) is cleaner.
  Not strictly a correctness bug — two `None`-everywhere fields
  cost ~16 bytes per OFD — but worth a refactor at A2 land time
  rather than carrying drift into plan 4.
- **GLIO_SUBMIT (v1) carries `ctx_id` but does the kernel resolve it
  via the **submitting** fd's OFD?** Plan 3 B5 walks back the
  `ofd_id` import argument by asserting `(pid, ctx_id)` is unique
  per-Process (since `gl_next_ctx_id` is per-Process). That holds for
  the *host* lookup, but the *kernel* dispatcher still needs to find
  the binding's per-fd-state to update the shadow on each submit.
  Plan 3 doesn't pin which fd's OFD the kernel consults at GLIO_SUBMIT
  time — the fd from the ioctl syscall, presumably. Verify v1's
  GLIO_SUBMIT dispatcher already has the fd in scope (it should:
  every ioctl path receives `(pid, fd, request, ...)`). Document
  explicitly at Task B5 + B4.

### Architecture — open

- **Lift of `gl_state` to OFD (Task A2) is overreach if GL bindings
  must NOT survive fork.** WebGL semantics: contexts are
  process-scoped; a forked child cannot meaningfully use a
  parent-created context (the underlying host `WebGL2RenderingContext`
  is owned by the kernel-worker, not duplicated per-process, but the
  user-visible binding state is per-process by convention). If
  `gl.bindings` lives on the OFD (shared by fork), the child after
  fork holds a per-fd reference to the parent's bindings; subsequent
  `MAKE_CURRENT` from the child onto an inherited binding is
  undefined-by-spec. Two viable resolutions:
  (a) **Lift only `dri_handles` to OFD; keep `gl_state` on Process.**
      Lower blast radius; preserves v1's GL-state-on-Process invariant;
      compatible with B5's "per-Process `gl_next_ctx_id`" decision.
      Cost: a process can't have two `/dev/dri/renderD128` fds with
      disjoint GL-binding namespaces — but plan 3's GL-multiplexing
      model is per-Process anyway (one process, N contexts via
      `GLIO_CREATE_CONTEXT`, all sharing the host context).
  (b) **Lift `gl.bindings` to OFD but clear on fork.** Forces
      OFD-copy-on-fork for renderD128 OFDs, breaking the "OFD shared
      by ref" invariant — much larger change.
  *Lean: (a).* Task A2 should be split: `dri_handles` + `dri_mmaps`-
  isn't-here-anyway → OFD; `gl_state` → stays on Process. The plan
  3 narrative around B5 ("`gl_next_ctx_id` per-Process keeps the host
  key unambiguous") works *better* under (a). Decide before any kernel
  code lands.
- **`WpkDrmGpuBoCreate` reuses the same 16-byte buffer for in and
  out (`format`/`usage` slots get overwritten with `handle`/`stride`
  on return).** No Linux DRM ioctl does this; every `_IOWR` carries
  explicit out fields after the in fields (cf. `drm_mode_create_dumb`:
  in `{height, width, bpp, flags}`, out `{handle, pitch, size}`). The
  caller's libgbm wrapper has to remember not to inspect `format` /
  `usage` after the call. Cost vs benefit: keeping the struct at
  16 bytes saves 8–12 bytes of ABI surface; restructuring to in
  `{width, height, format, usage}` + out `{handle, stride, pad}`
  (24 or 28 bytes, ioctl encoding changes to `0xc018_64e0` or
  `0xc01c_64e0`) makes the surface conventional and self-documenting.
  *Lean: restructure to dedicated out fields.* Update the ioctl
  encoding + the `ioc(…)` self-test accordingly. Decide before any
  kernel code lands.
- **`BoRegistry::alloc_gpu` is a separate method vs adding a `tier`
  parameter to `alloc`** — the plan vacillates ("recommended:
  `alloc_gpu`" in the narrative, but the open-question list under
  Pre-impl-review-as-drafted asked "lean: parameter — fewer call
  sites diverge"). The two paths diverge in what they do: the
  CPU-shared path computes `stride` + `size` from `bpp` and pre-
  allocates a SAB-sized region; the GPU path does neither (host's
  `WebGLTexture` picks its own layout, `stride = 0`). A `tier`
  parameter would carry both branches in a single method with a
  noisy match. *Lean: keep `alloc_gpu` separate* — clearer contract,
  one less foot-gun for callers that pass the wrong bpp for GPU bos.
  Match the plan body to the lean; remove the conflicting note from
  the open-question list.
- **0xE0+ nr-range collision with Linux v6.x DRM** isn't yet
  verified against the header plan 2 Task C1 vendors. As of v6.10
  mainline `include/uapi/drm/drm.h`, DRM nrs run 0x00..0xCF densely;
  `0xD0..0xD3` recently picked up SYNCOBJ extensions and `0xD4`
  (`MODE_CLOSEFB`) has been proposed for v6.11+. `0xE0+` is unused as
  far as I can see, but the plan PR can't land until plan 2's Task C1
  actually vendors the header and we grep for `'d', 0xE0` /
  `'d', 0xE1`. If a collision appears (e.g., the vendored snapshot is
  v6.12+ and someone has filled `0xE0`), choose the lowest free nr
  ≥ `0xF0` and re-derive both `DRM_IOCTL_WPK_*` constants in Task
  A1 + their ioctl-encoding tests.

### Missing tests — add in the implementation PRs

- **`fork` + GL context survival.** Behaviour depends on the
  architecture-open resolution above. Under (a) `gl_state` on
  Process, the test asserts: child after fork has empty
  `gl_state.bindings`; child's `MAKE_CURRENT(ctx_id=N)` (N created by
  parent pre-fork) returns `EINVAL`. Under (b) lift to OFD with
  clear-on-fork, the test asserts the same outcome via a different
  mechanism. Either way, the regression test must exist.
- **Two opens of `/dev/dri/renderD128` on the same process yield
  distinct `DriFdState`s.** Already in Task A2 Step 4 as
  `two_opens_yield_distinct_handle_namespaces`. ✓ noted, just
  confirming.
- **`WPK_BIND_FOREIGN_TEXTURE` on a non-existent `ctx_id` returns a
  clean errno (`EINVAL`) rather than silently binding to ctx 0.**
  Task A4's test list covers tier mismatch and handle resolution but
  not ctx_id validation. Add.
- **Bo destruction invalidates all foreign-texture bindings.** Test
  pid 10 creates GPU bo handle 1, pid 11 binds it via prime+
  `BIND_FOREIGN_TEXTURE` as its own `gl_texture_id = T`. Pid 10
  `GEM_CLOSE` and `close(prime fd)` → bo refcount → 0 → host
  `gbm_bo_destroy` fires → pid 11's `T` is now invalid. Pid 11's
  next sampler binding via `T` should produce `GL_INVALID_OPERATION`
  in the cmdbuf (or whatever the v1 cmdbuf decoder returns for an
  invalid texture handle). Without this test, the bo-as-owner
  contract isn't observably enforced.
- **`COMPOSITOR_PRI` precedence test uses a fake compositor pid.**
  The fixture must permit setting `pid=2` for a kernel-side fake
  process (the centralized-kernel test helper currently allocates
  pids monotonically from a base; the test needs to construct the
  fake compositor with an explicit pid). Verify the helper supports
  this; if not, B8 Step 5 (the priority assertion) is unrunnable.

### Trade-offs verified against the design doc (`2026-05-18-dri-design.md` §5 + §4.2)

- **One host `WebGL2RenderingContext` for all bindings** — matches
  design §5.1 option C. ✓
- **Per-context shadow + lazy switchTo** — matches §5.2. ✓
- **Submits are atomic — no preemption mid-cmdbuf** — matches §5.5.
  Acknowledged starvation risk for compositor under a pathological
  client cmdbuf is in the Risk register. ✓
- **`COMPOSITOR_PRI` hardcoded to PID 2 in this plan; `DRM_MASTER` on
  card0 layered by plan 4** — matches §6's KMS-master role. The
  hand-off shape is recorded in Task B3's COMPOSITOR_PRI comment.
  Verify alignment when plan 4 drafts.
- **GPU-tier bos have no CPU-mapped backing; `mmap(/dev/dri/renderD128,
  gpu_bo_offset)` returns EINVAL** — matches design §4.2 ("GPU tier
  is texture-only; readback via separate ioctl future-plan"). ✓
- **Additive ABI only — no `ABI_VERSION` bump** — matches the
  `docs/abi-versioning.md` policy (PR #490). The ABI snapshot diff
  in A6 covers only new structs + the new `host_gl_*` import; no
  existing surface changes. ✓ (Confirmed by walking the plan-2
  ABI shape; the per-fd lift is purely a kernel-internal data layout
  change with no ABI surface.)

### Deliberately not flagged

- `_IOWR('d', 0xE0, 16)` = `0xc010_64e0` and `_IOWR('d', 0xE1, 16)`
  = `0xc010_64e1` — re-derived via the same `ioc(...)` helper plan 2
  Task A1 introduced; matches the plan body's constants exactly. ✓
- `gl_next_ctx_id` resets to 1 on fork (B5 Step 1). The child shares
  no GL contexts with the parent, so starting from 1 is correct —
  same as Linux's GL drivers (per-fd ctx tables, fresh on dup). ✓
- `host_gl_bind_foreign_texture` import is *additive*; v1's ten
  `host_gl_*` imports are unchanged, so the per-Process-ctx_id
  decision (B5) doesn't propagate into the v1 ABI surface. ✓
- `WebGL2RenderingContext` namespace addressability is symmetric
  across bindings — verified against the WebGL2 spec (section "WebGL
  Object Lifecycle"). ✓
- `queueMicrotask` drain coalescing — both Node and browser provide
  the same microtask semantics. ✓ dual-host parity verified by
  inspection.
- Branch topology (`…-mux-kernel` → `…-mux-host` → `…-mux-demo`
  stacked on `…-buffer-demo`) — coherent with plan 2's stack base
  and the user's "each branch chains off the previous" rule. ✓

### Cross-plan amendment from plan 4's devil's-advocate

Plan 4's review found that the `DRM_MASTER` → `COMPOSITOR_PRI` swap
is **not** a one-line callsite change as plan 4's narrative claimed,
because plan 3 B3 (above) lands `SubmitQueue` without a constructor
and references a module-level `const COMPOSITOR_PID = 2` in two
methods (`enqueue` + `releaseIfEmpty`). Plan 4 B4 adds a constructor
argument `(isCompositor: (pid: number) => boolean)` and rewires both
methods — that's a constructor-signature change plus two call-site
swaps, not a one-line edit.

**Resolution (lands inside this plan, not deferred):** plan 3 B3
defines `SubmitQueue` with the constructor-callback shape from the
start, defaulting to the PID-2 predicate so plan-3-era tests pass
unchanged:

```ts
export class SubmitQueue {
  private compositor: QueueEntry[] = [];
  private clients: QueueEntry[] = [];
  private byKey = new Map<string, QueueEntry>();

  /** `isCompositor(pid)` decides lane bucketing. Plan 4 wires this
   * to `kmsRegistry.isMasterPid(pid)`; until then the default is
   * the plan-3 hardcode (`pid === 2`). */
  constructor(
    private isCompositor: (pid: number) => boolean = (pid) => pid === 2,
  ) {}

  enqueue(binding: GlBinding, frame: SubmitFrame): void {
    // … this.isCompositor(binding.pid) ? this.compositor : this.clients …
  }

  releaseIfEmpty(entry: QueueEntry): void {
    // … this.isCompositor(entry.binding.pid) ? this.compositor : this.clients …
  }

  isEmpty(): boolean { return this.byKey.size === 0; }
}
```

With this shape, plan 4 B4 becomes genuinely a one-line edit at the
construction site in `kernel-worker.ts`:

```ts
- const queue = new SubmitQueue();
+ const queue = new SubmitQueue((pid) => kmsRegistry.isMasterPid(pid));
```

…and plan 3's vitest (queue with `pid=2`, `pid=10`, `pid=11`) keeps
passing on the default. Plan 4 drops the `COMPOSITOR_PID` constant
*from the SubmitQueue module* but keeps it in the test fixture as
the default-predicate reference.

**Action for plan 3 B3 implementation:** ship `SubmitQueue` with the
constructor-callback shape, not the module-level `const`. Replace
the `COMPOSITOR_PID` const at the top of `submit-queue.ts` with an
explicit default argument in the constructor signature. The Vitest
spec at B3 also uses the default; the new test added in plan 4 B5
overrides the predicate to exercise master-driven priority.

### Cross-plan amendment from plan 7's devil's-advocate — libEGL.a + libGLESv2.a follow-up (LOAD-BEARING)

Plan 7's devil's-advocate pass (session 8) escalated the **missing
user-space static-lib carriers** for EGL + GLES2 + GBM surface API
into a **LOAD-BEARING cross-plan blocker**. Design doc §2 line 122
says v1's stubs "are all reused verbatim" — but this worktree's v1
EGL + GLES2 surface lives entirely as *host-side imports* in
`host/src/gl/*` and `host_gl_*` wasm imports. There is **no
`sysroot/lib/libEGL.a` or `sysroot/lib/libGLESv2.a`**; no
`examples/libs/libegl-stub/` or `examples/libs/libgles2-stub/`
package. SDL2's KMSDRM video backend
(`SDL_kmsdrmvideo.c::SDL_GL_LoadLibrary`) link-checks both via
`-lEGL -lGLESv2`. Plan 7 PR #2 **cannot link** without these
archives existing. Plans 8–11's GL-using seed apps inherit the
same gap.

*Resolution (plan-3-follow-up PR landed BEFORE plan 7 PR #2 can
merge, in tandem with plan 2's gbm_surface follow-up):* ship two
new packages — `examples/libs/libegl-stub/` and
`examples/libs/libgles2-stub/` — that wrap plan 3's `host_gl_*`
imports + v1's host-side GL state into the standard EGL 1.5 /
GLES 2.0 public API surface.

**`libegl-stub`** ships:

- **`eglGetDisplay(native_dpy)`** — `native_dpy` is a
  `struct gbm_device *` (per Mesa's `EGL_PLATFORM_GBM_KHR`
  binding). Stub returns a single static `EGLDisplay` handle
  (v1 supports one display).
- **`eglInitialize(dpy, &maj, &min)`** — returns EGL 1.5 (5.5);
  the host-side GL is GLES 2.0-capable per v1's design.
- **`eglChooseConfig` / `eglGetConfigAttrib`** — exposes one
  static `EGLConfig` matching ARGB8888 + depth24 + stencil8 +
  one GLES2 renderable bit. SDL2 picks it immediately and
  doesn't iterate.
- **`eglCreateContext`** — calls plan 3's
  `DRM_IOCTL_WPK_CREATE_GPU_BO`-adjacent context-allocation
  pathway (the host already allocates GL contexts on
  `host_gl_create_context`); the stub maps `EGLContext` →
  v1's `gl_context_id`. Per-OFD context state per plan 3 A2's
  per-OFD lift.
- **`eglCreateWindowSurface(dpy, config, native_win, attrib_list)`**
  — `native_win` is a `struct gbm_surface *` (from plan 2's
  gbm_surface follow-up, see cross-plan amendment in plan 2
  above). The stub remembers the binding `(EGLSurface →
  gbm_surface)`; rendering targets the surface's currently-
  acquired bo's WebGLTexture-backed framebuffer.
- **`eglMakeCurrent(dpy, draw, read, ctx)`** — sets the host-
  side "current context"; v1 is single-thread so this is just
  `current_egl_ctx = ctx`.
- **`eglSwapBuffers(dpy, surface)`** — calls
  `gbm_surface_lock_front_buffer(s)` semantically: the bo
  currently bound as draw target rotates to "locked-by-scanout",
  and the next-free bo becomes the new draw target. The KMS
  presenter (plan 4) sees the new front bo on the next
  `MODE_PAGE_FLIP` (or `MODE_ADDFB2 → SETCRTC` on first frame).
  Coordination with plan 2's gbm_surface follow-up is the
  load-bearing point: the two must agree on the
  front-buffer-rotation cadence.
- **`eglDestroyContext` / `eglDestroySurface` /
  `eglTerminate`** — release host-side handles, free the
  surface's bo ring (via `gbm_surface_destroy`).
- **`eglGetError`** — returns `EGL_SUCCESS` in v1; stub doesn't
  surface host-side GL errors via EGL (callers can call
  `glGetError` for that).
- **No `EGL_KHR_image_base` / `EGLImage` in v1.** The Mesa
  driver exposes it; SDL2's KMSDRM backend doesn't require it.
  Plan 9's compositor will need it for client surface sharing
  — flag as a sub-plan when plan 9 lands.

**`libgles2-stub`** ships:

- **All GLES 2.0 entry points wrapping plan 3's `host_gl_*`
  imports.** v1's existing host-side surface already handles the
  GL state — the stub is mostly mechanical 1:1 routing
  (`glClear` → `host_gl_clear`, `glDrawArrays` →
  `host_gl_draw_arrays`, etc.). Stub returns success;
  `glGetError` returns `GL_NO_ERROR` until the host signals
  otherwise.
- **`<GLES2/gl2.h>` + `<GLES2/gl2ext.h>` headers vendored** from
  Khronos's reference repo, unmodified.
- **Function pointer trampolines** — SDL2 dlsym-loads GL
  entrypoints in the dynamic case but in our wasm32 static-only
  world the symbols are linked directly. Provide every
  GLES 2.0 entry as a real exported symbol; no `dlsym` redirect.

*Package shapes:*

```toml
# examples/libs/libegl-stub/package.toml
name = "libegl-stub"
version = "1.5.0"
license = "MIT"
description = "EGL 1.5 stub over v1's host-side GL contexts"

[source]
type = "local"  # in-tree, no upstream

[deps]
libgbm = "0.1.0"    # plan 2 — for gbm_surface; the follow-up
                    # ships libgbm at this version

[build]
script_path = "build.sh"
```

```toml
# examples/libs/libgles2-stub/package.toml
name = "libgles2-stub"
version = "2.0.0"
license = "MIT"
description = "GLES 2.0 stub wrapping plan 3's host_gl_* imports"

[source]
type = "local"

[deps]
# No external deps — talks directly to host_gl_* imports.

[build]
script_path = "build.sh"
```

Both build with hand-rolled `wasm32posix-cc -c -O2` + `llvm-ar
rcs` invocations; no upstream sources to vendor.

*Cargo + Vitest tests under the plan-3-follow-up PR:*
- `egl_initialize_returns_1_5` — assert maj/min = 1/5.
- `egl_choose_config_returns_argb8888_d24s8` — assert single
  config's attribs match the SDL2 KMSDRM expectations.
- `egl_create_context_then_make_current` — assert the host's
  current-context tracker updates.
- `egl_swap_buffers_rotates_gbm_surface_front` — chain plan 2's
  `gbm_surface_lock_front_buffer` test through an `eglSwapBuffers`
  call; assert the same bo round-trip.
- `gles2_glClear_routes_to_host_gl_clear` — host stub captures
  the call args.

*Branch topology:* the plan-3-follow-up PR stacks on plan 2's
gbm_surface follow-up tip (since libegl-stub depends on
`libgbm`'s gbm_surface_*). PR title: `[explore-dri] sysroot(dri):
libEGL + libGLESv2 stubs — user-space carriers for the v1
host_gl_* surface`. The two follow-ups (plan 2 + plan 3 GL
stack) together close plan 7's open-architecture #2 and unblock
plan 7 PR #2 merge.

*Why this lives in plan 3 (not plan 2 or plan 7):* the GL state
+ `host_gl_*` imports + per-OFD context tables are all plan 3
surface; the libegl-stub is the user-space mirror of plan 3's
host-side GL infrastructure. Plan 2 owns gbm (buffers); plan 3
owns GL (contexts + commands). Plan 7's SDL2 just consumes both.

*Cross-plan link:* the matching plan 2 follow-up
(`gbm_surface_*`) is documented in plan 2's review under
"Cross-plan amendment from plan 7's devil's-advocate — gbm_surface
follow-up (LOAD-BEARING)". Both follow-ups land before plan 7
PR #2; the ordering is plan 2 first (libgbm gains gbm_surface)
then plan 3 (libegl-stub + libgles2-stub depend on the new
libgbm surface).

---

## Phase A — kernel: per-fd state + GPU-tier bo + foreign-texture ioctl (PR #1)

The kernel learns to (a) keep per-`OpenFileDesc` GL and bo state instead
of per-`Process`, (b) allocate GPU-tier bos via a new ioctl, and (c)
authorise the foreign-texture bind. Multiplexing itself lives entirely on
the host (Phase B); the kernel doesn't know about scheduling.

### Task A1: Shared ABI module additions

**Files:**
- Modify: `crates/shared/src/lib.rs` — extend `pub mod dri` with the new
  ioctl numbers and struct.

**Step 1: Add the constants and struct**

Append inside `pub mod dri { … }`:

```rust
    // --- WPK extensions ('d' magic, nrs 0xE0+ — unused by Linux 6.x) ----

    /// `_IOWR('d', 0xE0, WpkDrmGpuBoCreate)` — allocate a GPU-tier bo.
    /// Plan 2's `MODE_CREATE_DUMB` covers CPU-shared bos (LINEAR, mmap'able).
    /// This ioctl covers the GPU tier (§4.2): the bo's backing is a host
    /// `WebGLTexture`, not a SAB; the bo is unmappable on the CPU side and
    /// is intended for sampling / rendering via the multiplexer.
    pub const DRM_IOCTL_WPK_CREATE_GPU_BO: u32 = 0xc010_64e0;

    /// `_IOWR('d', 0xE1, WpkDrmBindForeignTexture)` — bind a foreign bo as
    /// a `WebGLTexture` in the caller's GL context. The caller must
    /// already hold a local bo handle (via PRIME_FD_TO_HANDLE), and the
    /// bo must be GPU-tier. Used by the compositor to sample client bos
    /// and by `gbm_bo_import` callers that want texture-side access.
    pub const DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE: u32 = 0xc010_64e1;

    /// Linux-shape `struct` for the GPU-bo allocator. 16 bytes on wasm32
    /// (4 × u32). `format` and `usage` are passed through to libgbm's
    /// `gbm_bo_create(format, usage)` from the user side.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGpuBoCreate {
        pub width: u32,   // 0   in
        pub height: u32,  // 4   in
        pub format: u32,  // 8   in    DRM_FORMAT_* (ARGB8888 etc.)
        pub usage: u32,   // 12  in    GBM_BO_USE_* bitmask
                          // out via separate fields: see WpkDrmGpuBoCreate.out
    }

    // Returned via piggy-backed write — the kernel writes back over the
    // same buffer with `handle, stride, size` packed in. Size of the
    // round-trip struct is fixed at 16 bytes; we reuse `format`/`usage`
    // slots for `handle`/`stride` on the return path. Avoids a second
    // ioctl. **Verify this is acceptable in the devil's-advocate pass —
    // a separate `WpkDrmGpuBoCreateOut` struct may be clearer.**
    //
    // Layout on return:
    //   0..4   width    (echoed back, unchanged)
    //   4..8   height   (echoed back, unchanged)
    //   8..12  handle   (out — process-local; was `format`)
    //   12..16 stride   (out — bytes; was `usage`)
    //
    // The 16-byte size is preserved (ioctl encoding stays 0xc010_64e0).

    /// `_IOWR('d', 0xE1, WpkDrmBindForeignTexture)` arg shape. 16 bytes
    /// on wasm32 (4 × u32). After the call, the caller's GL context has
    /// a `WebGLTexture` accessible by `gl_texture_id` until the bo's
    /// refcount drops to zero — the bo is the canonical owner; bo
    /// destruction (last `GEM_CLOSE` / OFD-final-close) deletes the
    /// underlying `WebGLTexture` and invalidates every binding to it.
    /// There is no separate `UNBIND_FOREIGN_TEXTURE` ioctl: bind
    /// lifetime is tied to the bo lifetime, scoped by the bo refcount.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmBindForeignTexture {
        pub bo_handle: u32,    // 0   in    caller's local GEM handle
        pub gl_target: u32,    // 4   in    GL_TEXTURE_2D etc.
        pub ctx_id: u32,       // 8   in    caller's GL ctx_id
        pub gl_texture_id: u32, // 12  out   the WebGLTexture id assigned
                                //          (also writable as a sampler binding)
    }
```

**Step 2: Add static-assert + ioctl-encoding tests**

Append to the existing `dri_tests` mod block in `crates/shared/src/lib.rs`
(introduced by plan 2 Task A1 Step 2):

```rust
    #[test]
    fn wpk_extension_sizes_match_wasm32() {
        assert_eq!(size_of::<WpkDrmGpuBoCreate>(), 16);
        assert_eq!(size_of::<WpkDrmBindForeignTexture>(), 16);
    }

    #[test]
    fn wpk_extension_ioctl_numbers() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(DRM_IOCTL_WPK_CREATE_GPU_BO,
            ioc(iowr, 'd' as u32, 0xE0, size_of::<WpkDrmGpuBoCreate>() as u32));
        assert_eq!(DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE,
            ioc(iowr, 'd' as u32, 0xE1, size_of::<WpkDrmBindForeignTexture>() as u32));
    }
```

**Step 3: Run**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib dri_tests
```

Expected: plan-2 tests still pass; 2 new tests pass.

**Step 4: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(dri): shared ABI — WPK GPU bo + foreign-texture ioctl numbers"
```

---

### Task A2: Lift per-`Process` state to per-`OpenFileDesc`

**The structural refactor.** Plan 2 placed `dri_handles`, `dri_next_handle`,
and `dri_mmaps` on `Process`; v1 placed `gl_state` on `Process`. Both
choices were v1's single-owner simplification. This task lifts them to
`OpenFileDesc`, matching Linux semantics. fork inherits the OFD via
ref-count (shared state across fork — exactly Linux's per-fd behaviour); a
fresh `open()` of `/dev/dri/renderD128` yields an OFD with empty state.

**Files:**
- Modify: `crates/kernel/src/ofd.rs` — add `DriFdState` and `GlFdState`
  hung off `OpenFileDesc`.
- Modify: `crates/kernel/src/process.rs` — remove `dri_handles`,
  `dri_next_handle`, `dri_mmaps`, `gl_state` (and any v1 helper methods).
- Modify: `crates/kernel/src/syscalls.rs` — update every dispatcher that
  reads/writes the moved state to go through `OpenFileDesc` instead.
- Modify: `crates/kernel/src/fork.rs` — drop the "reset child's
  dri_handles" code (plan 2 Task A3 Step 3); the OFD-table dup already
  gives the child shared per-fd state. Keep the dri_mmaps reset (mmaps
  are tied to address space, not fd — clearing on fork is correct).

**Step 1: Add `DriFdState` and `GlFdState` to `OpenFileDesc`**

In `crates/kernel/src/ofd.rs`:

```rust
/// Per-fd state for `/dev/dri/renderD128` opens (plan 3 lift).
/// Multiple fds pointing at the same OFD (`dup`, fork-inherit) share
/// the same state; a new `open()` gets a fresh `OpenFileDesc` with
/// `DriFdState::default()`.
#[derive(Default, Clone, Debug)]
pub struct DriFdState {
    /// GEM-handle → global BoId map. v1 of renderD128 (plan 2) placed
    /// this on `Process`; this lift moves it here for Linux semantics.
    pub handles: BTreeMap<u32, crate::dri::BoId>,
    /// Next handle id to issue per this fd. Linux numbers from 1.
    pub next_handle: u32,
    /// v1 GL context-binding bookkeeping (lifted from `Process::gl_state`).
    /// Each entry is a `(ctx_id → GlBinding)` row. `GlBinding`'s shape is
    /// unchanged from v1; only its container moves.
    pub gl: GlFdState,
}

#[derive(Default, Clone, Debug)]
pub struct GlFdState {
    /// (ctx_id) → GlBinding. v1 has at most one binding per Process;
    /// per-fd lift allows N per-fd (multiple `glCreateContext` on one fd).
    pub bindings: BTreeMap<u32, crate::gles::GlBinding>,
    /// Currently-bound ctx for `MAKE_CURRENT` semantics.
    pub current_ctx_id: Option<u32>,
}

// On `OpenFileDesc`, add:
//     pub dri: Option<Box<DriFdState>>,  // boxed: only present for renderD128 OFDs
// Initialise to `Some(Box::default())` in the open path for
// `/dev/dri/renderD128`; `None` for every other file.
```

`next_handle` initial value: 1 (`DriFdState::default()` writes
`next_handle: 0` since `u32::default() == 0`; override in the open path or
add a `Default` impl that sets it to 1).

**Step 2: Move all call sites**

Walk plan 2's Phase A Tasks A3, A6-A9 and v1's GL syscall paths. Each
reference like:

```rust
let mut pt = PROCESS_TABLE.lock();
let proc = pt.get_mut(pid).ok_or(Errno::ESRCH)?;
let bo_id = *proc.dri_handles.get(&req.handle).ok_or(Errno::ENOENT)?;
```

becomes:

```rust
let mut pt = PROCESS_TABLE.lock();
let proc = pt.get(pid).ok_or(Errno::ESRCH)?;
let ofd_idx = proc.fd_table.get(fd as i32).ok_or(Errno::EBADF)?;
let ofd = pt.ofds.entries.get_mut(ofd_idx as usize)
    .and_then(|o| o.as_mut()).ok_or(Errno::EBADF)?;
let dri = ofd.dri.as_mut().ok_or(Errno::ENOTTY)?;
let bo_id = *dri.handles.get(&req.handle).ok_or(Errno::ENOENT)?;
```

Same shape for: CREATE_DUMB handle insert, MAP_DUMB handle lookup,
DESTROY_DUMB / GEM_CLOSE handle remove, PRIME_HANDLE_TO_FD handle lookup,
PRIME_FD_TO_HANDLE handle insert, mmap path handle-existence check.

**Lock-order note** (carries the policy from plan 2's Pre-impl review): the
typical sequence is `PROCESS_TABLE.lock()` → resolve OFD → operate on
`ofd.dri`. The `BoRegistry` and `HOST_IO` locks are still taken separately
and released before the next lock. The new shape adds OFD access inside
the `PROCESS_TABLE.lock()` scope — verify no code path now holds
`PROCESS_TABLE` *and* `BoRegistry` simultaneously. (The
`with_registry(...)` calls run after the process-table lock is dropped.)

**Step 3: fork inherits per-fd state via OFD dup**

In `crates/kernel/src/fork.rs`: delete the lines that reset
`dri_handles` / `dri_next_handle` to empty in the child (plan 2 Task A3
Step 3 introduced these — now wrong, since per-fd state SHOULD be
inherited along with the fd-table). Keep the `dri_mmaps` reset; mmaps are
per-address-space, not per-fd. (Actually `dri_mmaps` may itself move to
the OFD in a future lift if mmap binding becomes fd-local — but for plan
3 the address-space binding stays per-Process: a mmap on a renderD128 fd
is a memory binding in the calling process's wasm Memory, not in the OFD.)

The fork-inherit cargo test from plan 2 Task A3 Step 4 must be **updated**:
parent's `dri_handles` (now on the OFD) IS shared with child after fork;
both processes see the same handles through the same fd. A separate test
covers: child opens its own `/dev/dri/renderD128` after fork — gets a fresh
OFD with empty handles.

**Step 4: Cargo tests**

Add to `crates/kernel/src/dri/tests.rs` (or analogous):

```rust
#[test]
fn two_opens_yield_distinct_handle_namespaces() {
    // Process 1 open A: CREATE_DUMB → handle 1
    // Process 1 open B (second open of /dev/dri/renderD128): handle 1 too,
    //   but pointing at a different bo. Verify the two OFDs' DriFdState
    //   are independent.
}

#[test]
fn fork_inherits_handle_namespace_through_shared_fd() {
    // Process 1 open: CREATE_DUMB → handle 1
    // Process 1 fork → Process 2.
    // Process 2 looks up handle 1 on the inherited fd → resolves to same BoId.
}

#[test]
fn fork_child_open_gets_fresh_namespace() {
    // Process 1 open + CREATE_DUMB → handle 1.
    // Fork. Child OPENS its own renderD128 → handle 1 on the new OFD is
    // absent (ENOENT on GEM_CLOSE).
}
```

**Step 5: Run**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
```

Expected: plan-2's tests pass after the call-site updates; 3 new tests pass.

**Step 6: Commit**

```bash
git add crates/kernel/src/ofd.rs crates/kernel/src/process.rs \
        crates/kernel/src/syscalls.rs crates/kernel/src/fork.rs \
        crates/kernel/src/dri/
git commit -m "kernel(dri): lift dri_handles + gl_state to per-OpenFileDesc"
```

---

### Task A3: Activate `BoTier::Gpu` — `DRM_IOCTL_WPK_CREATE_GPU_BO`

**Files:**
- Modify: `crates/kernel/src/dri/bo.rs` — add a `tier` parameter to
  `BoRegistry::alloc` (default `CpuShared` for back-compat with plan 2's
  call sites; new call site passes `Gpu`).
- Modify: `crates/kernel/src/syscalls.rs` — add the new ioctl branch in
  `handle_dri_ioctl()`.
- Modify: `crates/kernel/src/process.rs` — extend the `HostIO` trait with
  `gbm_bo_create_gpu` (returns 0 on success, ENOMEM otherwise — pattern
  parallels plan 2's `gbm_bo_create`).

**Step 1: `BoRegistry::alloc_gpu` (or `tier` parameter)**

Recommended shape: add an explicit `alloc_gpu` rather than extending
`alloc`'s signature; the SAB-allocation comment on `alloc` doesn't apply
to GPU bos and a separate method keeps the contract clearer.

```rust
impl BoRegistry {
    pub fn alloc_gpu(
        &mut self,
        width: u32,
        height: u32,
        format: u32,
        _usage: u32,
    ) -> &mut GbmBo {
        let id = self.next_id;
        self.next_id += 1;
        // GPU-tier stride: undefined at the kernel level; the host's
        // WebGLTexture picks its own layout. We return 0 to the user —
        // libgbm GPU bos don't promise a CPU-visible stride.
        let bo = GbmBo {
            id,
            width,
            height,
            format,
            modifier: DRM_FORMAT_MOD_LINEAR,  // honour the field; semantics moot for GPU
            stride: 0,
            size: 0,
            bpp: 0,
            tier: BoTier::Gpu,
            refcount: 1,
            prime_cookie: None,
        };
        self.map.insert(id, bo);
        self.map.get_mut(&id).unwrap()
    }
}
```

**Step 2: New ioctl branch in `handle_dri_ioctl`**

```rust
DRM_IOCTL_WPK_CREATE_GPU_BO => {
    if buf.len() < core::mem::size_of::<WpkDrmGpuBoCreate>() {
        return Err(Errno::EINVAL);
    }
    let req: WpkDrmGpuBoCreate = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    if req.width == 0 || req.height == 0 { return Err(Errno::EINVAL); }
    // Format check: ARGB8888 / XRGB8888 / RGB565 only in v1; reject others
    // (libgbm probes; same shape as plan 2 Task A6's bpp check).
    match req.format {
        DRM_FORMAT_ARGB8888 | DRM_FORMAT_XRGB8888 | DRM_FORMAT_RGB565 => {},
        _ => return Err(Errno::EINVAL),
    }

    let (bo_id,) = crate::dri::with_registry(|r| {
        let bo = r.alloc_gpu(req.width, req.height, req.format, req.usage);
        (bo.id,)
    });

    let host_rc = HOST_IO.lock().gbm_bo_create_gpu(pid, bo_id,
        req.width, req.height, req.format, req.usage);
    if host_rc < 0 {
        crate::dri::with_registry(|r| { r.decref(bo_id); });
        return Err(Errno::ENOMEM);
    }

    // Allocate a per-fd handle (uses the lifted DriFdState).
    // Symmetry with plan 2 A6 unwind: if anything below fails we must
    // call `gbm_bo_destroy` to release the host-side SAB/texture, not
    // just decref the kernel registry — plan 2's review flagged this
    // shape under "Correctness — open".
    //
    // Borrow note: hold `PROCESS_TABLE` mutably for the whole hop; the
    // immutable `pt.get(pid)` is dropped before we take `ofds.entries`
    // mutably (NLL drops the immut borrow at end-of-statement). Spell
    // out the intermediate `let ofd_idx = …;` so the borrow scoping is
    // unambiguous to readers.
    let handle_result: Result<u32, Errno> = (|| {
        let mut pt = PROCESS_TABLE.lock();
        let ofd_idx = pt.get(pid).ok_or(Errno::ESRCH)?
            .fd_table.get(fd as i32).ok_or(Errno::EBADF)?;
        let ofd = pt.ofds.entries.get_mut(ofd_idx as usize)
            .and_then(|o| o.as_mut()).ok_or(Errno::EBADF)?;
        let dri = ofd.dri.as_mut().ok_or(Errno::ENOTTY)?;
        let h = dri.next_handle.checked_add(1).ok_or(Errno::ENOMEM)?;
        dri.next_handle = h;
        dri.handles.insert(h, bo_id);
        Ok(h)
    })();
    let handle = match handle_result {
        Ok(h) => h,
        Err(e) => {
            crate::dri::with_registry(|r| { r.decref(bo_id); });
            HOST_IO.lock().gbm_bo_destroy(pid, bo_id);
            return Err(e);
        }
    };

    // Pack the return values into the buffer:
    //   0..4  width  (echoed)
    //   4..8  height (echoed)
    //   8..12 handle
    //   12..16 stride (= 0 for GPU tier)
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&req.width.to_le_bytes());
    out[4..8].copy_from_slice(&req.height.to_le_bytes());
    out[8..12].copy_from_slice(&handle.to_le_bytes());
    // out[12..16] stays 0 (stride for GPU tier is undefined)
    buf[..16].copy_from_slice(&out);
    Ok(())
}
```

**Step 3: `HostIO::gbm_bo_create_gpu`**

```rust
    /// Allocate a GPU-tier bo: host creates a WebGLTexture of the given
    /// dimensions/format, ready for foreign-texture binding and for
    /// rendering via the multiplexer. Returns 0 on success, < 0 on error.
    fn gbm_bo_create_gpu(&mut self, pid: i32, bo_id: u32, width: u32,
        height: u32, format: u32, usage: u32) -> i32;
```

Stub it in `host/test/centralized-test-helper.ts` to capture call args.

**Step 4: Cargo + commit**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib dri
git add crates/kernel/ crates/shared/ host/test/centralized-test-helper.ts
git commit -m "kernel(dri): activate BoTier::Gpu + DRM_IOCTL_WPK_CREATE_GPU_BO"
```

---

### Task A4: `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — new branch in `handle_dri_ioctl`.
- Modify: `crates/kernel/src/process.rs` — `HostIO::gl_bind_foreign_texture`.

**Step 1: Ioctl branch**

```rust
DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE => {
    if buf.len() < core::mem::size_of::<WpkDrmBindForeignTexture>() {
        return Err(Errno::EINVAL);
    }
    let mut req: WpkDrmBindForeignTexture = unsafe {
        core::ptr::read_unaligned(buf.as_ptr() as *const _)
    };
    // Resolve handle → BoId via per-fd state.
    let bo_id = {
        let pt = PROCESS_TABLE.lock();
        let proc = pt.get(pid).ok_or(Errno::ESRCH)?;
        let ofd_idx = proc.fd_table.get(fd as i32).ok_or(Errno::EBADF)?;
        let ofd = pt.ofds.entries.get(ofd_idx as usize)
            .and_then(|o| o.as_ref()).ok_or(Errno::EBADF)?;
        let dri = ofd.dri.as_ref().ok_or(Errno::ENOTTY)?;
        *dri.handles.get(&req.bo_handle).ok_or(Errno::ENOENT)?
    };
    // Tier check: must be GPU-tier.
    let is_gpu = crate::dri::with_registry(|r|
        r.get(bo_id).map(|bo| bo.tier == BoTier::Gpu));
    match is_gpu {
        Some(true) => {},
        Some(false) => return Err(Errno::EINVAL),  // CPU bo can't be a texture
        None => return Err(Errno::EBADF),
    }
    // Ask host for the WebGLTexture id.
    let gl_tex_id = HOST_IO.lock().gl_bind_foreign_texture(pid,
        req.ctx_id, bo_id, req.gl_target);
    if gl_tex_id < 0 { return Err(Errno::EINVAL); }
    req.gl_texture_id = gl_tex_id as u32;
    unsafe {
        core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, req);
    }
    Ok(())
}
```

**Step 2: `HostIO::gl_bind_foreign_texture`**

```rust
    /// Make the GPU-tier bo `bo_id` available as a `WebGLTexture` in the
    /// caller's GL context. Returns the WebGLTexture id (≥ 0) on success;
    /// < 0 on error.
    fn gl_bind_foreign_texture(&mut self, pid: i32, ctx_id: u32,
        bo_id: u32, gl_target: u32) -> i32;
```

**Step 3: Cargo tests**

```rust
#[test]
fn bind_foreign_texture_rejects_cpu_tier() {
    // CREATE_DUMB → BoTier::CpuShared; WPK_BIND_FOREIGN_TEXTURE → EINVAL.
}

#[test]
fn bind_foreign_texture_resolves_local_handle() {
    // WPK_CREATE_GPU_BO → handle 1, BoTier::Gpu.
    // WPK_BIND_FOREIGN_TEXTURE on handle 1 → host called once with bo_id.
}
```

**Step 4: Commit**

```bash
git add crates/kernel/ host/test/
git commit -m "kernel(dri): DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE"
```

---

### Task A5: Cleanup — fork / close / exit / execve for per-fd state

**Files:**
- Modify: `crates/kernel/src/fork.rs` — already covered in Task A2 Step 3
  (delete plan-2's reset of `dri_handles`; per-fd state is now shared via
  OFD dup, no special handling needed).
- Modify: `crates/kernel/src/syscalls.rs` (close path) — OFD destruction
  must decref every bo in `dri.handles` and call host destroy callbacks
  for refcount-0.
- Modify: `crates/kernel/src/wasm_api.rs` — `SYS_EXIT_GROUP` cleanup
  iterates the process's fd table; per-fd state goes away naturally as
  OFDs are released.
- Modify: execve cleanup: closes CLOEXEC fds (which trigger the close-path
  cleanup above); per-fd DriFdState dies with each closed OFD.

**Step 1: OFD destruction releases bos**

In `crates/kernel/src/ofd.rs` (or wherever OFD refcount hits zero — Linux
calls this `__fput`), add a hook:

```rust
impl OpenFileDesc {
    /// Called when the OFD's refcount reaches zero (last fd referencing
    /// it has been closed). Plan 2's `prime_bo` decref is part of this.
    /// Plan 3's `dri.handles` and `dri.gl.bindings` cleanup is here too.
    pub fn on_final_close(&mut self, pid: i32, host_io: &mut dyn HostIO) {
        if let Some(dri) = self.dri.take() {
            // Release every GEM handle this fd held.
            for (_h, bo_id) in dri.handles {
                let new_rc = crate::dri::with_registry(|r| r.decref(bo_id))
                    .unwrap_or(0);
                if new_rc == 0 { host_io.gbm_bo_destroy(pid, bo_id); }
            }
            // Tear down every GL context this fd opened.
            for (ctx_id, _binding) in dri.gl.bindings {
                host_io.gl_destroy_context(pid, ctx_id);
            }
        }
        if let Some(p) = self.prime_bo.take() {
            let new_rc = crate::dri::with_registry(|r| r.decref(p.bo_id))
                .unwrap_or(0);
            if new_rc == 0 { host_io.gbm_bo_destroy(pid, p.bo_id); }
        }
    }
}
```

Wire `on_final_close` into the existing OFD-final-release path. This
**replaces** plan 2 Task A9 Step 2's per-close decref (which was the bug
flagged in plan 2's Pre-impl review — "decref on every fd close"). Per-fd
state release is now correctly at the OFD level, not the fd level.

**Step 2: `dri_mmaps` stays on Process — fork / exit cleanup unchanged**

Plan 2's `Process::dri_mmaps` doesn't move; mmaps are per-address-space.
The munmap path / `SYS_EXIT_GROUP` mmap teardown is unchanged from plan 2.

**Step 3: Cargo tests**

```rust
#[test]
fn dup_then_close_preserves_bos_until_final_close() {
    // open /dev/dri/renderD128 → fd0; CREATE_DUMB → handle 1, bo refcount 1.
    // dup(fd0) → fd1 (same OFD).
    // close(fd0) → bo refcount unchanged (OFD still has a reference).
    // close(fd1) → OFD destroyed → on_final_close → bo refcount → 0,
    //   gbm_bo_destroy fired exactly once.
}

#[test]
fn fork_inherit_then_double_close_correctly_decrefs() {
    // Process A: open fd → CREATE_DUMB → bo refcount 1.
    // Process A fork → Process B (inherits the fd, same OFD).
    //   OFD refcount = 2 (one fd in each process).
    // Process A close(fd) → OFD refcount = 1, bo refcount unchanged.
    // Process B close(fd) → OFD destroyed → bo refcount → 0,
    //   gbm_bo_destroy fired once.
}
```

**Step 4: Commit**

```bash
git add crates/kernel/
git commit -m "kernel(dri): per-OFD release — final-close decrefs bos + tears down gl ctxs"
```

---

### Task A6: ABI snapshot regen (additive)

**Files:**
- Modify: `abi/snapshot.json` (auto-generated).
- DO NOT modify: `ABI_VERSION` (additive).

**Step 1: Regenerate**

```bash
bash scripts/check-abi-version.sh update
```

**Step 2: Inspect**

```bash
git diff abi/snapshot.json
```

Expected diff: new entries for `WpkDrmGpuBoCreate`, `WpkDrmBindForeignTexture`,
and the one new `host_gl_bind_foreign_texture` import. **No** changes to any
*existing* row.

**Step 3: Verify + commit**

```bash
bash scripts/check-abi-version.sh
git add abi/snapshot.json
git commit -m "kernel(dri): regen ABI snapshot — additive WPK GPU-bo + foreign-texture"
```

---

### Task A7: Phase A — full gauntlet + open PR #1

**Step 1: Gauntlet**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

**Step 2: Push the branch**

```bash
git push -u origin emdash/explore-direct-rendering-infrastructure-mux-kernel-XXXXX
```

**Step 3: Open the draft PR**

Title: `[explore-dri] kernel(dri): per-fd gl_state + per-fd dri_handles + GPU-tier bos + foreign-texture ioctl`

Body template (Brandon style):

```markdown
## Summary
- Lift v1's per-`Process` `gl_state` and plan 2's per-`Process` `dri_handles`
  to per-`OpenFileDesc` (`DriFdState`). fork inherits the OFD; new `open`
  gets a fresh namespace. Matches Linux per-fd semantics.
- Activate `BoTier::Gpu` reserved by plan 2: add
  `DRM_IOCTL_WPK_CREATE_GPU_BO` (in our reserved `0xE0+` nr range of the
  DRM `'d'` magic). GPU-tier bos are unmappable on CPU; host backs them
  with `WebGLTexture` (Phase B).
- Add `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` for the foreign-texture
  sampling case (compositor sampling client bos; future-plan).
- OFD-final-close hook releases bos and tears down GL contexts —
  replaces plan 2's "decref on every fd close" bug flagged in its
  Pre-impl review.

## Why
Plan 3 of the DRI v2 design (`docs/plans/2026-05-18-dri-design.md` §5)
requires N processes to hold their own GL contexts concurrently. Per-`Process`
state from v1 + plan 2 is the wrong granularity for that. This PR pays the
refactor cost up-front; Phase B/C build on top without further moves.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
Additive only — no `ABI_VERSION` bump. Two new ioctl numbers in the
unused DRM `'d'` magic `0xE0+` range; two new `repr(C)` structs in
`shared::dri`; one new `host_gl_*` import.

## Notes
- Per-fd lift updates every call site introduced by plan 2 (Tasks A3, A6-A9)
  + v1's GL syscall paths.
- Compositor priority (`COMPOSITOR_PRI` for PID 2) lives entirely in the
  host muxer (PR #2) — kernel does not schedule.
- `GLIO_PRESENT_KMS` is deferred to the KMS plan (`/dev/dri/card0`).
```

**Do not merge.**

---

## Phase B — host: `GlMuxer` + shadow + cross-context map (PR #2)

Phase B is where most of the new work lives. The kernel-worker grows a
`GlMuxer` (one per OffscreenCanvas / `WebGL2RenderingContext`), a
`SubmitQueue`, and a cross-context `WebGLTexture` map.

### Task B1: `GlShadowState` type + cmdbuf decoder updates

**Files:**
- Create: `host/src/webgl/shadow.ts`.
- Modify: `host/src/webgl/cmdbuf.ts` (or wherever v1's TLV decoder lives) —
  every state-changing op writes the corresponding field on the active
  binding's shadow before/after issuing the WebGL call.

```ts
// host/src/webgl/shadow.ts
export interface GlShadowState {
  // Viewport / scissor
  viewport: [number, number, number, number];      // x, y, w, h
  scissor: [number, number, number, number] | null; // null = SCISSOR_TEST disabled

  // Clear state
  clearColor: [number, number, number, number];
  clearDepth: number;
  clearStencil: number;

  // Depth / stencil / blend
  depthTestEnabled: boolean;
  depthFunc: number;
  depthMask: boolean;
  stencilTestEnabled: boolean;
  blendEnabled: boolean;
  blendFunc: { srcRGB: number, dstRGB: number, srcA: number, dstA: number };
  blendEquation: { rgb: number, a: number };

  // Rasterizer
  cullFaceEnabled: boolean;
  cullFace: number;
  frontFace: number;
  polygonOffsetFillEnabled: boolean;
  polygonOffset: { factor: number, units: number };

  // Program + VAO + FBO (per-context isolated, but state nonetheless)
  currentProgram: WebGLProgram | null;
  vao: WebGLVertexArrayObject | null;  // null pre-MAKE_CURRENT; populated thereafter
  fbo: WebGLFramebuffer | null;        // null = default fb

  // Texture units
  activeTexture: number;           // GL_TEXTURE0 + N (just N here, 0..N)
  textureUnits: (WebGLTexture | null)[]; // [TEX0..TEX_MAX_UNITS-1]

  // Pixel store
  unpackAlignment: number;
  packAlignment: number;
}

export function defaultShadow(maxTexUnits: number): GlShadowState {
  return {
    viewport: [0, 0, 0, 0],
    scissor: null,
    clearColor: [0, 0, 0, 0],
    clearDepth: 1,
    clearStencil: 0,
    depthTestEnabled: false,
    depthFunc: 0x0201,   // GL_LESS
    depthMask: true,
    stencilTestEnabled: false,
    blendEnabled: false,
    blendFunc: { srcRGB: 1, dstRGB: 0, srcA: 1, dstA: 0 },  // ONE, ZERO
    blendEquation: { rgb: 0x8006, a: 0x8006 },              // FUNC_ADD
    cullFaceEnabled: false,
    cullFace: 0x0405,    // GL_BACK
    frontFace: 0x0901,   // GL_CCW
    polygonOffsetFillEnabled: false,
    polygonOffset: { factor: 0, units: 0 },
    currentProgram: null,
    vao: null,           // set at MAKE_CURRENT
    fbo: null,
    activeTexture: 0,
    textureUnits: new Array(maxTexUnits).fill(null),
    unpackAlignment: 4,
    packAlignment: 4,
  };
}
```

The cmdbuf decoder (v1's `dispatchTLV` or equivalent) gets updated so each
state-mutating op writes the shadow:

```ts
case OP_VIEWPORT: {
  const [x, y, w, h] = readArgs4(buf, off);
  binding.shadow.viewport = [x, y, w, h];
  gl.viewport(x, y, w, h);
  break;
}
case OP_USE_PROGRAM: {
  const progId = readArg(buf, off);
  const prog = binding.programs.get(progId);
  binding.shadow.currentProgram = prog;
  gl.useProgram(prog);
  break;
}
// … ~40 cases total. Mechanical translation of the v1 op table.
```

**Symmetry rule:** every op that touches WebGL state-machine state writes
the shadow, even if the value didn't change. The muxer assumes the shadow
is the source of truth at submit-end; partial-write shadows break
`switchTo`.

**Cargo / vitest:** unit-test that for each opcode in the v1 op table, the
shadow field listed in `GlShadowState` is updated correctly. Drive a
single-binding cmdbuf with one op of each type, assert
`binding.shadow.<field>` matches the input args.

**Commit:** `host(dri): GlShadowState type + cmdbuf shadow-write updates`

---

### Task B2: `GlMuxer` — `switchTo` + lazy current-tracking

**Files:**
- Create: `host/src/webgl/muxer.ts`.

```ts
// host/src/webgl/muxer.ts
import type { GlShadowState } from './shadow';

export interface GlBinding {
  pid: number;
  ctx_id: number;
  shadow: GlShadowState;
  // … existing v1 fields: programs, buffers, textures, etc.
}

export class GlMuxer {
  private current: GlBinding | null = null;

  constructor(private gl: WebGL2RenderingContext) {}

  /** No-op if target === current (lazy switch). */
  switchTo(target: GlBinding): void {
    if (this.current === target) return;
    const s = target.shadow;
    const gl = this.gl;

    gl.bindVertexArray(s.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);

    if (s.scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(s.scissor[0], s.scissor[1], s.scissor[2], s.scissor[3]);
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }

    gl.clearColor(s.clearColor[0], s.clearColor[1], s.clearColor[2], s.clearColor[3]);
    gl.clearDepth(s.clearDepth);
    gl.clearStencil(s.clearStencil);

    if (s.depthTestEnabled) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.depthFunc(s.depthFunc);
    gl.depthMask(s.depthMask);

    if (s.stencilTestEnabled) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);

    if (s.blendEnabled) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    gl.blendFuncSeparate(s.blendFunc.srcRGB, s.blendFunc.dstRGB,
                         s.blendFunc.srcA, s.blendFunc.dstA);
    gl.blendEquationSeparate(s.blendEquation.rgb, s.blendEquation.a);

    if (s.cullFaceEnabled) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    gl.cullFace(s.cullFace);
    gl.frontFace(s.frontFace);

    if (s.polygonOffsetFillEnabled) gl.enable(gl.POLYGON_OFFSET_FILL);
    else gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(s.polygonOffset.factor, s.polygonOffset.units);

    gl.useProgram(s.currentProgram);

    for (let i = 0; i < s.textureUnits.length; i++) {
      const tex = s.textureUnits[i];
      if (tex) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      }
    }
    gl.activeTexture(gl.TEXTURE0 + s.activeTexture);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, s.unpackAlignment);
    gl.pixelStorei(gl.PACK_ALIGNMENT, s.packAlignment);

    this.current = target;
  }

  invalidateCurrent(): void { this.current = null; }
}
```

**Vitest:** create a mock `WebGL2RenderingContext` (jest-style spy) and
two GlBindings with distinct shadows. Call `switchTo(B1)`, assert all
state-applying methods fired with B1's values. Call `switchTo(B1)` again,
assert no calls (lazy). Call `switchTo(B2)`, assert state methods fired
with B2's values. Cycle costs measured here are sanity-checks, not perf
gates.

**Commit:** `host(dri): GlMuxer with lazy switchTo + shadow replay`

---

### Task B3: `SubmitQueue` — round-robin + `COMPOSITOR_PRI`

**Files:**
- Create: `host/src/webgl/submit-queue.ts`.

```ts
// host/src/webgl/submit-queue.ts
import type { GlBinding } from './muxer';

interface QueueEntry {
  key: string;          // `${pid}:${ctx_id}`
  binding: GlBinding;
  frames: SubmitFrame[];
}

interface SubmitFrame {
  memorySab: SharedArrayBuffer;
  off: number;
  len: number;
}

export class SubmitQueue {
  private compositor: QueueEntry[] = [];   // head-of-queue lane
  private clients: QueueEntry[] = [];      // FIFO within
  private byKey = new Map<string, QueueEntry>();

  /** `isCompositor(pid)` decides lane bucketing at enqueue +
   * release time. Plan 4 (KMS) wires this to
   * `kmsRegistry.isMasterPid(pid)`; the default predicate matches
   * the original plan-3 PID-2 hardcode so this plan's tests pass
   * unchanged. See plan 4's Pre-impl review "Cross-plan amendment
   * from plan 4's devil's-advocate" above for the why. */
  constructor(
    private isCompositor: (pid: number) => boolean = (pid) => pid === 2,
  ) {}

  enqueue(binding: GlBinding, frame: SubmitFrame): void {
    const key = `${binding.pid}:${binding.ctx_id}`;
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { key, binding, frames: [] };
      this.byKey.set(key, entry);
      (this.isCompositor(binding.pid) ? this.compositor : this.clients).push(entry);
    }
    entry.frames.push(frame);
  }

  /** Returns the next entry to drain (or null if empty). The caller
   * shifts one frame off the returned entry; if the entry is then empty
   * the caller must call `releaseIfEmpty(entry)` to evict it from the
   * lane + `byKey`. (Inlining the eviction here would force the queue
   * to know the drain's atomic-write semantics; cleaner to let drain
   * own the cycle.) */
  pickNext(): QueueEntry | null {
    // Compositor head-of-queue.
    while (this.compositor.length > 0) {
      const e = this.compositor[0];
      if (e.frames.length > 0) return e;
      this.compositor.shift();
      this.byKey.delete(e.key);
    }
    // Round-robin among clients.
    while (this.clients.length > 0) {
      const e = this.clients[0];
      if (e.frames.length > 0) {
        // Rotate: pop head, push tail (round-robin between drains).
        this.clients.shift();
        this.clients.push(e);
        return e;
      }
      this.clients.shift();
      this.byKey.delete(e.key);
    }
    return null;
  }

  /** Drain calls this after popping the last frame from an entry, so
   * `byKey` and the lane drop the now-empty entry promptly. Without
   * this, exhausted entries linger until they cycle back to the head
   * (the rotate-on-pickNext path) and bloat `byKey` for the duration. */
  releaseIfEmpty(entry: QueueEntry): void {
    if (entry.frames.length > 0) return;
    this.byKey.delete(entry.key);
    const lane = this.isCompositor(entry.binding.pid) ? this.compositor
                                                      : this.clients;
    const i = lane.indexOf(entry);
    if (i >= 0) lane.splice(i, 1);
  }

  isEmpty(): boolean { return this.byKey.size === 0; }
}
```

**Vitest:** queue with three clients (`pid=2`, `pid=10`, `pid=11`) each
with one frame. Assert `pickNext()` returns `pid=2` first, then `pid=10`,
then `pid=11`. Then enqueue a second frame for `pid=10`; assert next
`pickNext()` returns `pid=11` (round-robin advanced past the head), then
`pid=10`.

**Edge: fairness floor.** Currently a never-emptying compositor queue
starves clients. Acceptable for v2 (the compositor is well-behaved by
construction — design §9.x). Add a comment marking this as a known
property; v3 can add a watchdog or token-bucket.

**Commit:** `host(dri): SubmitQueue — compositor head-of-queue + client round-robin`

---

### Task B4: Wire `submit` → queue → muxer drain

**Files:**
- Modify: `host/src/webgl/bridge.ts` (or wherever v1's `host_gl_submit`
  handler lives).
- Modify: `host/src/kernel-worker.ts` if the drain trigger lives there.

Replace v1's direct `decodeAndDispatch(...)` call with:

```ts
// Old (v1):
function onSubmit(pid: number, ctx_id: number, off: number, len: number) {
  const binding = getBinding(pid, ctx_id);
  decodeAndDispatch(binding, memorySab, off, len);
}

// New (v2):
function onSubmit(pid: number, ctx_id: number, off: number, len: number) {
  const binding = getBinding(pid, ctx_id);
  queue.enqueue(binding, { memorySab, off, len });
  drainSoon();  // microtask-defer drain to coalesce multi-submit bursts
}

let draining = false;
function drainSoon() {
  if (draining) return;
  draining = true;
  queueMicrotask(() => {
    draining = false;
    drain();
  });
}

function drain() {
  while (!queue.isEmpty()) {
    const entry = queue.pickNext();
    if (!entry) break;
    const frame = entry.frames.shift()!;
    muxer.switchTo(entry.binding);
    decodeAndDispatch(entry.binding, frame.memorySab, frame.off, frame.len);
    queue.releaseIfEmpty(entry);  // drop now-empty entries promptly
  }
}
```

The `queueMicrotask` defer coalesces consecutive submits before any
WebGL work runs — turns N back-to-back submits from the same binding
into one switch + N dispatches.

**Dual-host parity (CLAUDE.md):** both `host/src/node-kernel-worker-entry.ts`
and `examples/browser/lib/kernel-worker-entry.ts` must wire the queue +
muxer the same way. Symmetry check mandatory before commit.

**Vitest:** drive two submits from `pid=10` followed by two from `pid=11`,
assert `muxer.switchTo` was called exactly twice (once for each
distinct pid), `decodeAndDispatch` four times in the expected order.

**Commit:** `host(dri): wire submit → SubmitQueue + GlMuxer drain (dual-host)`

---

### Task B5: Per-fd GL binding lookup (companion to A2)

**Files:**
- Modify: `host/src/webgl/registry.ts` (v1's GlBinding registry).

v1 likely keyed bindings by `(pid, ctx_id)` — a flat map. With per-fd
state on the kernel side, the host's binding key is conceptually `(pid,
fd, ctx_id)`. But the host doesn't see `fd` directly; the kernel
translates fd → OFD-id before calling `host_gl_*`. So the host's key
becomes `(pid, ofd_id, ctx_id)` — where `ofd_id` is a new stable u32 the
kernel sends with every `host_gl_*` call.

This is a small extension of v1's `host_gl_*` import signatures: each
call now takes an extra `ofd_id: u32` argument. **This counts as a
change to existing imports, not additive** — would break v1 if shipped
in isolation. **Mitigation:** plan 3 PR #1 (kernel) already updates
every call site (Task A2 Step 2 moves the dispatcher to look up state
via OFD). Both sides change together; ABI snapshot for the kernel-side
wasm export of `host_gl_*` import signatures changes. **This forces an
`ABI_VERSION` bump** if not handled carefully.

**Reconsideration:** the cleanest path is to *not* change v1's
`host_gl_*` signatures at all. Instead, the kernel keeps a side-table
`pid → currently_open_dri_fd → ofd_id` and the host indexes by `(pid,
ctx_id)` as before — same as v1. The per-fd lift is purely internal to
the kernel; the host's binding key stays at `(pid, ctx_id)`. Single
process can't have two contexts with the same ctx_id anyway (ctx_ids
are unique per kernel context-create).

Walk back the additional `ofd_id` arg. v1 host import signatures unchanged.
**No ABI bump. Per-fd state stays a kernel-internal refactor.**

The trade-off: a process holding two `/dev/dri/renderD128` fds (which
plan 2 disallowed under single-owner, but is now technically allowed
post-lift) cannot disambiguate its bindings by fd at the host. We
mitigate by: kernel ensures `ctx_id` allocation is global per-`Process`
(not per-fd) — i.e., the kernel's `Process` keeps a `gl_next_ctx_id:
u32` counter, and every `GLIO_CREATE_CONTEXT` regardless of which fd
allocates from the same counter. This keeps `(pid, ctx_id)` unique on
the host even when contexts come from different fds.

`gl_next_ctx_id` is therefore a **per-Process** field added in Task A2
(complementing per-fd `DriFdState`). It is the *only* GL-related field
that stays on `Process`; everything else moved to OFD.

**Step 1: Add `gl_next_ctx_id` to `Process`**

```rust
// In Process:
pub gl_next_ctx_id: u32,  // monotonic, never reused; survives ctx destroy.
```

Initialise to 1 at `Process::new()` and at fork (child gets its own
counter; if parent had ctxs 1..5, child starts at 1 — fork copies
neither bindings nor counter, since GL contexts don't survive fork in
WebGL semantics).

**Step 2: Update `GLIO_CREATE_CONTEXT` dispatch**

The CREATE_CONTEXT path (v1) does:

```rust
let ctx_id = proc.gl_next_ctx_id;
proc.gl_next_ctx_id += 1;
ofd.dri.as_mut().unwrap().gl.bindings.insert(ctx_id, GlBinding::new(...));
host_io.gl_create_context(pid, ctx_id, ...);
```

ctx_id is globally unique per-Process; binding lives on the OFD.

**Step 3: Cargo + vitest**

Test: two fds on the same process create contexts → ctx_ids 1, 2 (not
1, 1). Binding lookup by `(pid, ctx_id)` resolves to the right OFD.

**Commit:** `host(dri): per-fd binding lookup via per-Process ctx_id counter`

---

### Task B6: `WebGLTexture` cross-context map + `host_gl_bind_foreign_texture`

**Files:**
- Modify: `host/src/webgl/registry.ts` — add a global `BoId →
  WebGLTexture` map (one entry per GPU-tier bo).
- Modify: `host/src/kernel.ts` — register `host_gl_bind_foreign_texture`.

```ts
// host/src/webgl/registry.ts
class ForeignTextureRegistry {
  private boTextures = new Map<number /* BoId */, WebGLTexture>();

  /** Called by the host's gbm_bo_create_gpu callback to allocate the texture. */
  allocate(boId: number, width: number, height: number,
           format: number, gl: WebGL2RenderingContext): void {
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    // (texImage2D internalFormat / format / type derived from `format`
    //  — handled in a switch table; see Step 2.)
    this.boTextures.set(boId, tex);
  }

  /** Called from host_gl_bind_foreign_texture (kernel → host). */
  bind(boId: number, ctx_id: number, gl_target: number): number {
    const tex = this.boTextures.get(boId);
    if (!tex) return -1;
    // The texture is shared across all bindings on the same
    // WebGL2RenderingContext, so simply expose its id-as-handle.
    // We assign a per-ctx synthetic id (so the kernel returns a uint
    // the userland can pass back as a sampler binding via the v1
    // GL TLV cmdbuf).
    const id = this.allocSyntheticId(ctx_id, tex);
    return id;
  }

  /** Called when the bo is destroyed (refcount → 0). */
  free(boId: number, gl: WebGL2RenderingContext): void {
    const tex = this.boTextures.get(boId);
    if (tex) {
      gl.deleteTexture(tex);
      this.boTextures.delete(boId);
    }
  }

  // Synthetic-id machinery omitted; pattern mirrors v1's program/buffer
  // id allocator in `host/src/webgl/registry.ts`.
}
```

**Why this works:** all `WebGLTexture` objects created by *any* binding
on the same `WebGL2RenderingContext` are mutually addressable from any
other binding (the WebGL spec puts objects in the context's namespace,
not the user-program namespace). The muxer's `switchTo` doesn't need to
re-bind foreign textures — they're addressable identically from any
binding once the texture-unit binding is correct.

**Vitest:** allocate a GPU bo, bind as foreign texture to two distinct
bindings, assert the same `WebGLTexture` object is reachable from both
(spy on `gl.bindTexture` calls — same underlying texture handle).

**Commit:** `host(dri): foreign-texture cross-context bind via shared registry`

---

### Task B7: GPU-tier bo backing in `GbmRegistry`

**Files:**
- Modify: `host/src/dri/gbm-registry.ts` (created in plan 2 Task B1).

```ts
// Extend HostBo with a tier discriminator:
export type HostBo =
  | { tier: 'cpu_shared'; id: number; width: number; height: number;
      stride: number; size: number; sab: SharedArrayBuffer; byteOffset: number; }
  | { tier: 'gpu';        id: number; width: number; height: number;
      format: number; texture: WebGLTexture; };

// Extend GbmRegistry:
export class GbmRegistry {
  private bos = new Map<number, HostBo>();

  createGpu(boId: number, width: number, height: number, format: number,
            _usage: number, gl: WebGL2RenderingContext,
            foreignTex: ForeignTextureRegistry): number {
    foreignTex.allocate(boId, width, height, format, gl);
    // texture is canonical home; we keep a weak reference here too.
    const tex = foreignTex.peek(boId);
    this.bos.set(boId, { tier: 'gpu', id: boId, width, height, format,
                          texture: tex! });
    return 0;
  }

  // Existing `create` from plan 2 stays — handles the CpuShared tier.
}
```

**Vitest:** create a GPU bo, assert `GbmRegistry.bos.get(boId).tier === 'gpu'`
and `bos.get(boId).texture` is a valid `WebGLTexture`.

**Commit:** `host(dri): GPU-tier bos in GbmRegistry — WebGLTexture-backed`

---

### Task B8: End-to-end vitest — two-pid interleaved submits

**Files:**
- Create: `host/test/dri-multiplex.spec.ts`.

Drive a centralized-kernel fixture that:

1. Forks two "process worker" fixtures with distinct pids (10 and 11).
2. Each pid opens `/dev/dri/renderD128`, creates a GL context, makes it
   current, submits a tiny cmdbuf (clear to a distinct colour).
3. Asserts `GlMuxer.switchTo` was called twice (once per pid), in submit
   order.
4. Asserts the final fb contents are pid-10's last clear, then pid-11's
   last clear, in order.
5. Adds a "fake compositor" submit (pid=2) between pid-10's and pid-11's
   submits. Asserts the compositor's submit drained *before* pid-11's
   even though pid-11 enqueued first.

**Commit:** `host(dri): vitest — two-pid multiplex + compositor priority`

---

### Task B9: Phase B — full gauntlet + open PR #2

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Push, open draft PR.

Title: `[explore-dri] host(dri): GlMuxer + shadow state + WebGLTexture cross-context map + GPU-tier bo backing`

Body: Summary / Why / Verification / **Dual-host parity proof** (both
Node and browser kernel-worker entries wire the queue + muxer; symmetry
verified before commit) / Notes (compositor priority is hardcoded to
PID 2; KMS plan layers DRM_MASTER on top).

---

## Phase C — demo + vitest + browser (PR #3)

### Task C1: `programs/cube_pyramid.c` — two processes, two spinning cubes

**Files:**
- Create: `programs/cube_pyramid.c`.

```c
// Two processes, each draws a spinning cube into its own bo.
// Process A: red cube. Process B: blue cube. Compositor side intentionally
// absent in this demo (plan 3's compositor priority is exercised only in
// vitest).
//
// The demo's purpose is to verify the multiplexer correctly arbitrates
// two concurrent GL contexts under no compositor.

int main(void) {
    pid_t pid = fork();
    if (pid == 0) {
        // child: blue cube, drawing N frames
        draw_cube_loop(/*colour=*/0x000000ff, /*frames=*/300);
        _exit(0);
    }
    // parent: red cube, drawing N frames concurrently
    draw_cube_loop(/*colour=*/0xff000000, /*frames=*/300);
    int st; waitpid(pid, &st, 0);
    return WIFEXITED(st) && WEXITSTATUS(st) == 0 ? 0 : 1;
}

static void draw_cube_loop(uint32_t colour, int frames) {
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    // … standard EGL/GLES2 init via v1's libEGL/libGLESv2 stubs.
    // Each frame: clear, rotate, draw, present.
}
```

Build: `wasm32posix-cc -o programs/cube_pyramid.wasm programs/cube_pyramid.c
-lEGL -lGLESv2 -lgbm -ldrm`. Wire into `scripts/build-programs.sh`.

**Commit:** `examples(dri): cube_pyramid — two-process multiplex demo`

---

### Task C2: vitest — end-to-end multiplex spec

**Files:**
- Create: `host/test/dri-cube-pyramid.spec.ts`.

Runs `cube_pyramid.wasm` under the centralised kernel; asserts:
- Both child and parent return 0.
- The host muxer logged ≥ 2 distinct (pid, ctx_id) switches during the
  run.
- The canvas's final pixel buffer (via `gl.readPixels`) contains both
  colours.

**Commit:** `host(dri): vitest — cube-pyramid end-to-end multiplex`

---

### Task C3: Manual browser verification (the gate)

CLAUDE.md item 6. Build the demo, drop into `examples/browser/pages/cubepyramid/`
(HTML page that runs `cube_pyramid.wasm` and visibly shows two spinning
cubes side-by-side). `./run.sh browser`, navigate, confirm: two cubes,
both spinning, no console errors.

**No commit yet for this task — verification only.** If the demo fails
in browser but passes in Node, that's a host-parity bug (CLAUDE.md
"dual-host parity" — see PR #410 cautionary tale). Fix and re-run
before opening PR #3.

---

### Task C4: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(dri): two-cube multiplex demo + browser spec`

Body: Summary / Why / Verification (gauntlet + browser screenshot) /
Dual-host parity proof / Notes.

---

## Final coordinated merge

When all three PRs (kernel, host, examples) are reviewed and approved,
and Brandon has signed off on the demo running cleanly in browser + Node:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → PR #3's base.
4. Squash-merge PR #3 → plan 2's `…-buffer-demo` (or wherever plan 2's
   tip lives at the time).
5. Tag: `[explore-dri-mux] milestone (multiplexer) merged at <sha>` in
   the next session-handoff doc.

**Do not push to upstream until v1 + plan 2 + plan 3 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **One host context for everyone** (design §5.1 option C). If a future
  browser splits WebGL contexts hard enough that cross-binding texture
  sharing fails, the muxer rebases (e.g. one canvas per CRTC, compositor
  only) but the kernel-side ioctl surface stays.
- **`COMPOSITOR_PRI` hardcoded to PID 2** in plan 3's host muxer. Plan 4
  (KMS) layers `DRM_MASTER` on `/dev/dri/card0` over the top — at that
  point PID-2-as-compositor becomes "PID 2 happens to also hold
  DRM_MASTER", and the priority promotion lookup can shift to the
  `DRM_MASTER` flag without changing the muxer's public shape.
- **No mid-cmdbuf preemption** (design §5.5). A pathological client with
  a 1 MiB cmdbuf (~50 ms of WebGL work) blocks the compositor for one
  cmdbuf. Acceptable v2 behaviour; v3 cuts large submits into chunks if
  profiling shows it.
- **Per-Process `gl_next_ctx_id` counter** (not per-fd). Rationale:
  keeps the host's `(pid, ctx_id)` key unambiguous even when contexts
  come from different fds on the same process. The kernel pays the cost
  of one extra `Process` field; the host stays at v1's signature shape.
- **GPU-tier bos are unmappable on CPU.** `mmap(/dev/dri/renderD128,
  gpu_bo_offset)` returns `EINVAL`. The texture data lives only in
  WebGL space; no CPU read-back path in plan 3. Future plan (compositor
  + readback for screencapture) adds `glReadPixels` over a separate
  ioctl.
- **`switchTo` re-applies state unconditionally on each switch** (no
  per-field diff). Simpler; the ~40-call cost is small at frame
  boundaries. A diff-based optimisation can be added later if profiling
  shows it.

---

## Risk register

1. **Cross-binding `WebGLTexture` reachability** depends on all bindings
   sharing the same `WebGL2RenderingContext`. v1's architecture already
   does this (single OffscreenCanvas in the kernel-worker). If a future
   v2 fix puts the canvas back on the main thread or splits contexts,
   the foreign-texture surface breaks. Mitigation: vitest in Task B6
   asserts cross-binding reachability on every CI run.
2. **Compositor starvation of clients.** A misbehaving compositor that
   continuously enqueues frames will block all clients. Plan 3 accepts
   this as the cost of the simple priority rule; a fairness floor
   (e.g. compositor yields after N consecutive frames) is a v3 addition.
3. **Shadow-state completeness.** Every state-mutating WebGL call must
   update the shadow. If v1's TLV op table omits one (or a future op is
   added without a shadow update), `switchTo` silently corrupts state.
   Mitigation: Task B1 vitest covers each opcode; an integration test
   in Task B8 cross-binding clears with each verifies no corruption.
4. **`gl_next_ctx_id` overflow.** u32 ceiling is 2³² contexts per
   process — interactive workloads create ≪10 contexts in their
   lifetime. Document the wrap-at-overflow behaviour (returns
   `ENOMEM` — Linux's GL drivers use `ENOMEM` for context-table
   exhaustion; `EMFILE` is reserved for fd-table exhaustion against
   rlimit, semantically wrong here) in `GLIO_CREATE_CONTEXT`.
5. **fork+exec timing.** Per-fd state survives fork via OFD dup; exec
   closes CLOEXEC fds (which drops the OFD ref). Test that fork + exec
   without CLOEXEC retains the GL context (intended) and with CLOEXEC
   tears it down (also intended).
6. **`mmap_shared` from plan 2 is GPU-tier-irrelevant** (GPU bos aren't
   CPU-mappable). If plan 2's risk #1 forces the SAB-pool redesign,
   plan 3's GPU tier is unaffected — but the CPU-shared codepaths that
   plan 3 still uses (e.g. for the cube's vertex buffer staging) inherit
   plan 2's outcome.

---

## What this plan doesn't cover (deferred)

- **KMS / `/dev/dri/card0`** — page-flip, vblank, `DRM_MASTER`. Plan 4.
- **`GLIO_PRESENT_KMS`** ioctl — couples to card0; plan 4.
- **`DRM_MASTER`-driven `COMPOSITOR_PRI` lookup** — replaces the
  PID-2 hardcode at plan 4 time.
- **GPU-bo CPU readback** (`glReadPixels`-over-ioctl, for screencapture)
  — out of scope for v2.
- **Multi-canvas / multi-CRTC** — one canvas per CRTC is design's
  fallback if cross-context texture sharing fails; not implemented in v2.
- **Compositor itself** — the userland compositor (`wpkcompositor`,
  PID 2) gets its own plan (§9 of the design, plans 8-9 of the rollout).
  Plan 3 only exercises the priority lane via a vitest "fake
  compositor" pid.
- **`evdev`, `ALSA`** — independent device surfaces; plans 5 and 6.
- **SDL2 port** — milestone (D); needs plans 3 + 4 + 5 + 6 first.

---

End of plan.
