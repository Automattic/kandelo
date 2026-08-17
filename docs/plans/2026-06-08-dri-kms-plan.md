# DRI v2 — KMS plan (`/dev/dri/card0`)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Add the second DRI device node, `/dev/dri/card0`, exposing
Linux KMS (Kernel Modesetting) ioctls. Unmodified libdrm + SDL2's
`KMSDRM` backend should be able to: open card0, take `DRM_MASTER`,
`MODE_GETRESOURCES` to discover the single CRTC + single connector +
single mode, `MODE_ADDFB2` to wrap a bo (allocated via
`/dev/dri/renderD128` in plan 2 + 3) as a framebuffer id, `MODE_SETCRTC`
to attach the fb to the CRTC, then `MODE_PAGE_FLIP` repeatedly with
`read(card0)` returning `drm_event_vblank` records. **The
priority-promotion hand-off from plan 3** — `COMPOSITOR_PRI` in the
host `SubmitQueue` — flips from "hardcoded `pid == 2`" to "the process
that currently holds `DRM_MASTER` on `/dev/dri/card0`". Plan 3's
SubmitQueue API surface stays unchanged; only the priority-assignment
lookup is rewired.

**Architecture:** Single CRTC (`crtc_id = 1`), single connector
(`connector_id = 1`, type `DRM_MODE_CONNECTOR_VIRTUAL` — the closest
match for the OffscreenCanvas-as-display abstraction), single mode
(matches the OffscreenCanvas size; configurable per-host via
`attachKmsCanvas(connector_id, canvas, mode)`, default 1280×720 at
60 Hz). `MODE_ADDFB2` allocates a fresh `fb_id` and records
`{bo_id, width, height, format, stride}`; `MODE_SETCRTC` records the
binding `{crtc_id → fb_id}` for the kernel and notifies the host via
a new `host_kms_set_fb(crtc_id, fb_id, bo_id, mode)` import.
`MODE_PAGE_FLIP` records a pending flip and arms the vblank tick; on
the next vblank the host calls back into the kernel (`kernel_vblank`
export, additive to the existing kernel→host import set) and the
kernel produces a `drm_event_vblank` record on the master's per-OFD
event ring. `read(card0)` drains the ring (semantically `read` returns
one or more whole event records; partial reads are not supported by
DRM). Vblank cadence is host-driven: `requestAnimationFrame` on
browsers (in the kernel-worker if `OffscreenCanvas`-rAF is supported,
else routed from main thread via `postMessage`), `setInterval(16.67)`
on Node. The host owns the timer; the kernel only knows "vblank tick
happened, fire any pending flip". Companion design doc:
`docs/plans/2026-05-18-dri-design.md` §6 (`/dev/dri/card0`) + §16 q3
(vblank cadence).

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser + Node),
C user programs cross-compiled with `wasm32posix-cc`. Extends plan 2's
`libdrm.a` stub with the KMS subset (`drmModeGetResources`,
`drmModeGetConnector`, `drmModeGetCrtc`, `drmModeAddFB2`,
`drmModeRmFB`, `drmModeSetCrtc`, `drmModePageFlip`, `drmModeWaitVBlank`,
`drmHandleEvent` for the event-record dispatcher). No new userland
library stubs (libgbm covers bo allocation; SDL2 talks to libdrm
directly for KMS).

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §6 (KMS,
single CRTC/connector/mode, page-flip → vblank) + §16 q3 (vblank
cadence resolution). The DRM_MASTER-as-COMPOSITOR_PRI swap is design
§5.4 + §6.3 — the rule is "the process holding `DRM_MASTER` on card0
gets head-of-queue scheduling on the multiplexer." POSIX vs Linux
UAPI: `open`/`close`/`mmap`/`ioctl`/`read`/`poll` are POSIX; KMS
ioctl numbers + struct shapes + `DRM_MASTER` semantics + `drm_event_*`
record layout are Linux UAPI, followed strictly.

**Consistency with plans 2 + 3:**
- Plan 2 introduced `VirtualDevice::DriRender0` + `OpenFileKind::DriRender`
  for `/dev/dri/renderD128`. Plan 4 adds `VirtualDevice::DriCard0` +
  `OpenFileKind::DriCard` for `/dev/dri/card0` — a separate device
  node with its own ioctl dispatcher. Render-node-only ioctls
  (`PRIME_HANDLE_TO_FD`, `MODE_CREATE_DUMB`) are also valid on card0
  (Linux allows this); we forward those to the existing
  `handle_dri_render_ioctl()` so callers that hold only a card0 fd
  can still allocate bos. The reverse (KMS ioctls on a render-node fd)
  returns `EOPNOTSUPP` (Linux returns `ENOTSUPP`/`EOPNOTSUPP`
  depending on driver; we pick `EOPNOTSUPP`, which has a POSIX
  errno number).
- Plan 3's `COMPOSITOR_PRI` is currently `binding.pid === 2` in
  `host/src/webgl/submit-queue.ts`. Plan 4 Task B4 replaces this
  with `kmsRegistry.isMasterPid(binding.pid)`, where the host
  mirrors the kernel's `DRM_MASTER`-holder state via a host-import
  callback fired on every `DRM_IOCTL_SET_MASTER` / `DROP_MASTER` /
  close-while-holding-master. Plan 3's narrative ("when KMS plan
  arrives, swap the lookup; SubmitQueue API stays the same") matches
  the change; verified.
- Plan 2's `BoRegistry` bos (CpuShared) and plan 3's GPU-tier bos are
  both legal targets for `MODE_ADDFB2`. The fb's `pitches[0]` must
  equal the bo's `stride` (for CpuShared) or 0 (for GPU-tier — host
  defines the texture's row pitch and we don't expose it to the
  caller). The fb's `pixel_format` must equal the bo's `format`. The
  fb id namespace is per-OFD on the card0 fd; fork inherits via OFD
  dup. Reasoning matches plan 3 A2's per-OFD lift.
- Plan 3 carried over a load-bearing **open** architecture question
  (per-OFD vs per-Process for `gl_state`). Plan 4 makes no assumption
  about its resolution; the KMS code touches no GL state and is
  orthogonal. If plan 3's review lands on (a) "keep `gl_state` on
  Process", plan 4's kms_fb_id namespace stays per-OFD (matches
  Linux). If on (b) lift, same outcome — plan 4 is unaffected.

**Stack base:** Plan 3's `…-mux-demo` branch tip (plan 3 PR #3's
head). Plan 4 extends plan 3's kernel `dri::*` module + host
`webgl/submit-queue.ts` + plan 2's `libdrm.a` stub without breaking
either's tests.

**Branch:** `emdash/explore-direct-rendering-infrastructure-kms-plan-XXXXX`
(chains off the previous DRI branch per the user's branching rule).
Three sub-branches stack off it for the three PRs.

**Final PR base:** Plan 3's `…-mux-demo` branch tip. **Do not merge**
until Brandon validates the design, plan 3 lands, and Phase C's
manual browser verification passes. CLAUDE.md "no merge before
Brandon's validation" rule.

**Three PRs, coordinated merge.** Each task below is one commit. PR
titles follow Brandon's `scope(area): action` shape:

1. `kernel(dri): /dev/dri/card0 + KMS ioctls + DRM_MASTER + vblank ring`
2. `host(dri): KmsRegistry + vblank tick (RAF/setInterval) + master-driven SubmitQueue priority`
3. `examples(dri): modeset demo + browser spec`

PR base/head topology (stacked per the user's branching rule):

```
explore-webgl-exposition-demo                   (v1 tip)
 └── …-buffer-plan-XXXXX                        (plan 2 PR base)
      └── …-buffer-kernel  (plan 2 PR #1)
           └── …-buffer-host  (plan 2 PR #2)
                └── …-buffer-demo  (plan 2 PR #3)
                     └── …-multiplexer-plan-YYYYY    (plan 3 PR base)
                          └── …-mux-kernel    (plan 3 PR #1)
                               └── …-mux-host    (plan 3 PR #2)
                                    └── …-mux-demo  (plan 3 PR #3)
                                         └── …-kms-plan-ZZZZZ      (this plan PR base)
                                              └── …-kms-kernel    (PR #1)
                                                   └── …-kms-host    (PR #2)
                                                        └── …-kms-demo  (PR #3)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass with
zero regressions before any PR is opened, and re-run before final
merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds manual `./run.sh browser` verification of the
modeset demo (CLAUDE.md item 6) — the page-flip → vblank loop is
visible as a 60-FPS counter incrementing on-canvas.

**ABI impact:** **Additive only — no `ABI_VERSION` bump.** Per
`docs/abi-versioning.md` (PR #490 policy):
- New `repr(C)` structs in `shared::dri` for the KMS subset:
  `WpkDrmModeCardRes` (64 bytes), `WpkDrmModeGetConnector` (88 bytes),
  `WpkDrmModeGetEncoder` (20 bytes), `WpkDrmModeGetCrtc` (96 bytes —
  includes `drm_mode_modeinfo`), `WpkDrmModeModeinfo` (68 bytes),
  `WpkDrmModeFbCmd2` (96 bytes), `WpkDrmModeCrtcPageFlip` (24 bytes),
  `WpkDrmEventVblank` (32 bytes — matches upstream `drm_event_vblank`
  layout: header + user_data + tv_sec + tv_usec + sequence + crtc_id),
  `WpkDrmWaitVblankRequest` /
  `_Reply` (12 + 12 bytes). All sizes are wasm32-ilp32-validated by
  the same `_IOWR`-derivation tests plan 2 Task A1 introduced
  (verified: `ioc(iowr, 'd', nr, size_of::<T>())` matches the Linux
  number for each).
- New ioctl numbers — all are existing **Linux** DRM ioctl numbers
  (we follow the UAPI verbatim; we do **not** prefix with `WPK_`):
  - `DRM_IOCTL_SET_MASTER = _IO('d', 0x1e) = 0x0000_641e`
  - `DRM_IOCTL_DROP_MASTER = _IO('d', 0x1f) = 0x0000_641f`
  - `DRM_IOCTL_MODE_GETRESOURCES = _IOWR('d', 0xa0, …) = 0xc040_64a0`
  - `DRM_IOCTL_MODE_GETCRTC = _IOWR('d', 0xa1, …) = 0xc060_64a1`
  - `DRM_IOCTL_MODE_SETCRTC = _IOWR('d', 0xa2, …) = 0xc060_64a2`
  - `DRM_IOCTL_MODE_GETENCODER = _IOWR('d', 0xa6, …) = 0xc014_64a6`
  - `DRM_IOCTL_MODE_GETCONNECTOR = _IOWR('d', 0xa7, …) = 0xc058_64a7`
  - `DRM_IOCTL_MODE_PAGE_FLIP = _IOWR('d', 0xb0, …) = 0xc018_64b0`
  - `DRM_IOCTL_MODE_RMFB = _IOWR('d', 0xaf, u32) = 0xc004_64af`
  - `DRM_IOCTL_MODE_ADDFB2 = _IOWR('d', 0xb8, …) = 0xc060_64b8`
  - `DRM_IOCTL_WAIT_VBLANK = _IOWR('d', 0x3a, …) = 0xc018_643a`
  - Sizes encoded in each constant are verified vs the wasm32 struct
    `size_of` in Task A1 Step 2 (`ioctl_numbers_match_linux_uapi`).
- New kernel-wasm export: `kernel_vblank()` — host fires this on every
  vblank tick; kernel checks each card0 OFD for pending flips and
  produces event records. *(Note: this is a kernel **export**, not
  an import. Additive exports do not change existing signatures —
  permitted under the ABI policy.)*
- New `host_kms_*` imports: `host_kms_set_fb` (forwarded SET_CRTC),
  `host_kms_addfb` (host learns about a new fb_id → bo binding so
  it can present it on vblank), `host_kms_rmfb`, `host_kms_set_master`
  (notify host that master changed — drives SubmitQueue priority),
  `host_kms_drop_master`.
- No change to v1 `host_gl_*` imports, plan 2 `host_gbm_*` imports,
  plan 3 `host_gl_bind_foreign_texture`, any existing struct layout,
  any existing ioctl number, channel layout, syscall numbers, or
  asyncify slots.

Existing structs, ioctls, imports, and exports — all unchanged.

---

## Pre-implementation review

Devil's-advocate pass run in the next session after drafting; findings
below are structured Brandon-style. The five inline fixes were folded
back into the plan body in the same session; the open correctness +
open architecture items are load-bearing and must be picked before any
kernel code lands.

### Inline fixes (5 — folded into the plan body)

- **`WpkDrmEventVblank` was 24 bytes (header + user_data + tv_sec +
  tv_usec); upstream `drm_event_vblank` is 32 bytes (adds `sequence`
  + `crtc_id` to the tail).** The 24-byte size was the wrong call:
  SDL2's `KMSDRM` backend uses libdrm `drmHandleEvent` with
  `version = 3` and a `page_flip_handler2` callback whose signature is
  `(fd, sequence, tv_sec, tv_usec, crtc_id, user_data)` — it *reads*
  both `sequence` and `crtc_id` off the record. Truncating would feed
  the v3 handler garbage for `crtc_id` and shift `user_data` by 8
  bytes. Plus the demo's frame-pacing assertion at C2 wants the real
  `sequence` count, not zero-stubs. *Bumped to 32 bytes: added
  `sequence: u32` + `crtc_id: u32` at the tail; struct-size assertion
  in A1 Step 2 lifted to 32; `kernel_vblank` producer in A7 writes
  both fields; libdrm parser in C1 reads 32 bytes per record; the
  page-flip-event vitest in B5 asserts 32 bytes, not 24.*
- **`MODE_ADDFB2` (A5) didn't increment the bo's refcount.** The fb
  binding keeps the bo alive (per the plan's own trade-off: "MODE_-
  DESTROYDUMB on a fb-bound bo … the fb keeps the bo alive via the
  refcount until RMFB"), but the code as drafted never called
  `BoRegistry::incref(bo_id)` on `MODE_ADDFB2` and never called
  `decref` on `MODE_RMFB` / `on_final_close`. Result: a caller that
  ADDFB2'd a bo and then closed every prime-fd holding it would see
  the bo destroyed mid-scanout. *Fixed: A5 calls `incref` after the
  fb is recorded; A6 (RMFB) calls `decref(bo_id)` on the bo retired
  from `KmsFdState.fbs`; A10's `on_final_close` decrements once per
  remaining `KmsFb` before draining the table.*
- **`MODE_ADDFB2` (A5) ignored the `host_io.kms_addfb` return code.**
  Plan 2 + plan 3 convention: host returns `i32`, kernel checks
  `< 0` and unwinds. A5 as drafted swallowed the error. *Fixed:
  `if rc < 0` arm decrements the bo refcount, removes the fb from
  `KmsFdState.fbs`, and returns `ENOMEM`. Mirrors plan 2 A6's host-
  side-alloc-failure unwind exactly.*
- **`DRM_IOCTL_DROP_MASTER` (A3) didn't drain `pending_flips`.** If
  the master called PAGE_FLIP and then DROP_MASTER before vblank
  fired, the flip lingered. Then if the same OFD took master again,
  the stale flip fired on the next vblank — surprising. (Also: if a
  different OFD took master in between, the stale-flip-on-re-master
  would surface on a CRTC the new master never asked to flip.)
  *Fixed: A3 DROP_MASTER drains `pending_flips` (no events emitted —
  Linux has no "flip-aborted" event). A10's `on_final_close` does
  the same.*
- **`kms_drop_master(pid)` host arg is the closer's pid, not the
  original master's**, when `on_final_close` fires on a fork-inherited
  card0 OFD. The host's `KmsRegistry.dropMaster()` is global (no pid
  param), but the `HostIO::kms_drop_master(pid)` signature carries
  one for symmetry with `kms_set_master`. Risk: any host code that
  uses `pid` for re-bucketing (SubmitQueue priority cleanup, log
  attribution) sees the wrong pid. *Fixed: A10 documents that the
  pid passed on close is for logging only; host's `KmsRegistry` must
  always treat master-drop as global. Also added an assertion-style
  cargo test (under Missing tests below).*

### Correctness — open, address before kernel PR opens

- **`MODE_ADDFB2` handle namespace on the card0 OFD is undefined.**
  A5 calls `resolve_handle_on_card0_ofd(pid, fd, req.handles[0])` —
  but `KmsFdState` as drafted holds only `fbs / next_fb_id /
  holds_master / pending_flips / event_ring`. There is no handle
  table. A card0-side handle namespace is mandatory: Linux scopes
  ADDFB2 handles to the card0 fd, populated via PRIME_FD_TO_HANDLE
  on card0. Two clean resolutions, pick before any kernel code lands:
  (a) **Add `handles: BTreeMap<u32, BoId>` + `next_handle: u32` to
      `KmsFdState`.** Symmetric with plan 3 A2's `DriFdState`;
      duplicates the handle-namespace machinery on two OFD-side state
      blobs.
  (b) **Card0 OFDs also carry a `dri: Option<Box<DriFdState>>`**
      (the same `DriFdState` plan 3 lifted to the renderD128 OFD).
      A card0 OFD is then `dri = Some(...), kms = Some(...)`; a
      renderD128 OFD is `dri = Some(...), kms = None`. Pulls the
      handle-namespace handler in the kernel to a single
      implementation.
  *Lean: (b) plus folding both fields into the
  `Option<Box<DriOfdState>>` enum the handoff-4 follow-up flagged*
  — `enum DriOfdState { RenderNode(DriFdState), Card { dri:
  DriFdState, kms: KmsFdState } }`. This means the OFD-consolidation
  refactor lands **inside plan 4**, not as a deferred follow-up.
- **`kernel_vblank()` lock-order claim (A7) is wrong.** A7 says
  "lock order: ofd table only; no PROCESS_TABLE", but per plan 3 A3
  the OFD table lives inside `PROCESS_TABLE` (`pt.ofds.entries`).
  `with_ofds_mut` doesn't exist as drafted. Either
  (a) `kernel_vblank` takes `PROCESS_TABLE.lock()` briefly and iterates
      `pt.ofds.entries.iter_mut()`. The iteration is O(open card0
      OFDs) — typically 1-3 — so the lock window is microseconds,
      acceptable for the host calling kernel_vblank at 60 Hz.
  (b) Refactor: split OFDs into their own table (`OFD_TABLE`) with
      a distinct lock, so vblank-tick doesn't bottleneck syscalls.
      Larger surface; cross-cutting against every plan that touched
      `pt.ofds.entries`.
  *Lean: (a) for v1.* Document the lock in A7. Re-evaluate if
  profiling under Phase C shows syscall jitter aligned with vblank
  ticks.
- **`MODE_GETCRTC` (A4) needs a current-`fb_id` source, but nobody
  tracks it.** SETCRTC currently calls `host_io.kms_set_fb` and
  returns; the kernel doesn't remember the binding. GETCRTC has
  nowhere to read it from. Two resolutions:
  (a) **Kernel-global `crtc_state: BTreeMap<u32, u32>`** (crtc_id →
      fb_id), updated by SETCRTC, read by GETCRTC. CRTCs are
      kernel-wide (not per-OFD); single CRTC means a one-entry map
      or even a `static AtomicU32`.
  (b) **Add `host_kms_get_fb(crtc_id) -> u32` import.** Host's
      `KmsRegistry.crtcBindings` is the source of truth. Avoids
      duplicating kernel-side state but adds a host round-trip on
      every GETCRTC.
  *Lean: (a)* — one `AtomicU32` per CRTC, read+write are cheap, and
  GETCRTC is rare enough that the round-trip-cost argument doesn't
  apply (drm-userspace probes GETCRTC at startup, then SETCRTCs).

### Architecture — open (load-bearing, pick before any kernel code lands)

- **COMPOSITOR_PRI swap is NOT a one-line change in `SubmitQueue`.**
  Plan 3 B3 references a module-level `const COMPOSITOR_PID = 2` in
  *two* callsites (`enqueue` and `releaseIfEmpty`) and has no
  constructor. Plan 4 B4 adds a constructor argument
  `(isCompositor: (pid: number) => boolean)` and rewires both
  callsites — that's a **constructor signature change** plus two
  call-site swaps. The handoff-4 framing ("plan 3's SubmitQueue API
  surface stays unchanged — only the construction callsite changes")
  is only correct if **plan 3 lands with the constructor-callback
  shape from the start**. The clean path:
  - Plan 3 B3 lands SubmitQueue as
    `constructor(private isCompositor: (pid: number) => boolean
    = (pid) => pid === COMPOSITOR_PID)` — default preserves plan 3's
    PID-2 test behaviour; plan 4 B4 then is genuinely a one-line
    construction-site change in `kernel-worker.ts`.
  - Plan 4 B4 stops claiming "SubmitQueue API surface stays
    unchanged" since the **default-argument** shape *is* an API
    change (back-compatible, but visible) and Brandon-style honesty
    matters.
  *This requires a follow-up note on plan 3's review section.*
  Added below as a "Cross-plan amendment to plan 3" subsection of
  plan 3's Pre-impl review.
- **`vblank_wait::wake_all()` over-wakes `read(card0)` blockers.**
  A7 calls `wake_all()` after producing events for masters with
  pending flips. A8's `read(card0)` blocks when `event_ring` is
  empty. `wake_all()` wakes every blocked card0 reader on every
  vblank tick — including readers whose ring is still empty (a
  non-master, or a master with no pending flip on this tick). They
  re-block immediately. Meanwhile A9's `WAIT_VBLANK` semantically
  *wants* to wake every caller on every tick. Two queues, not one:
  - `read_wait_queue`: woken only when a record is pushed to the
    OFD's ring (per-OFD wake, not broadcast).
  - `wait_vblank_queue`: woken on every `kernel_vblank()` tick
    (broadcast, semantically a "next-tick" barrier).
  *Lean: split into two functions* —
  `vblank_wait::wake_event_reader(ofd_idx)` (called from A7 only
  for OFDs that got new records) + `vblank_wait::tick_wake_all()`
  (called once at the end of `kernel_vblank` for `WAIT_VBLANK`
  callers). Document the two wait queues at A7 + A8 + A9.
- **Host-side bo tier dispatch for vblank presenter is implicit.**
  Plan 4 B2's `presentFbToCanvas(fb, …)` is sketched as "WebGL2
  blit or 2D putImageData" — but the host has to *know* whether the
  fb's bo is CPU-shared (use `putImageData` from the SAB) or GPU-tier
  (`blitFramebuffer` from the WebGLTexture). The `HostFb` struct in
  B1 carries `bo_id` only; tier lookup is via `GbmRegistry`. Plan 2's
  `GbmRegistry` sketch (line 1547) shows `sab: SharedArrayBuffer` —
  CPU-shared only. Plan 3 A3's `gbm_bo_create_gpu` import allocates
  WebGLTextures on the host but the registry's storage shape for
  GPU bos isn't pinned down in plan 3. *Resolution to confirm at
  plan-4 land time:* `GbmRegistry` carries
  `entry: { tier: 'cpu', sab: SAB } | { tier: 'gpu', tex:
  WebGLTexture }` and exposes `getTier(bo_id)` + tier-specific
  accessors. `KmsRegistry.presentFbToCanvas` dispatches on
  `gbm.getTier(fb.bo_id)`. If plan 2's `GbmRegistry` doesn't carry
  this, plan 4 B1 amends it (additive — no ABI change since this is
  pure host state).
- **`attachKmsCanvas(connector_id, canvas, mode)` host API is
  named in the Architecture section but never defined anywhere in
  plan 4 or earlier plans.** It owns the OffscreenCanvas →
  `connector_id` binding and feeds `host_io.kms_mode_info`. Without
  it, B1 / B2 don't know which canvas to present to. *Resolution:*
  spell out the API + wire-up in Task B3 (sketch:
  `kernel.attachKmsCanvas({ connector_id: 1, canvas, mode: { hdisp:
  1280, vdisp: 720, vrefresh: 60 } })`; KmsRegistry stores the
  binding; `kms_mode_info` returns the stored mode; vblank-tick
  paints into this canvas). Document the call shape at B3.

### Missing tests — add to implementation PRs

- **GPU-tier bo through PAGE_FLIP, end-to-end.** Allocate via
  `WPK_CREATE_GPU_BO`, ADDFB2 with `pitches[0] = 0`, SETCRTC,
  PAGE_FLIP; assert the host's vblank-tick presenter dispatched the
  GPU path (blit from WebGLTexture, not putImageData from SAB).
  Vitest spec in Phase B, manual confirm in Phase C.
- **Forked-child takes master after parent drops.** Process A opens
  card0 + SET_MASTER, forks → child shares the OFD. A: DROP_MASTER.
  Child: SET_MASTER on the same fd. Assert child holds master
  globally (master holder = child's pid; SubmitQueue priority
  flips).
- **`SETCRTC(fb_id)` with an RMFB'd fb_id returns ENOENT.** The
  validation in A5 reads `KmsFdState.fbs`; RMFB removes the entry;
  test that a SETCRTC after RMFB rejects cleanly.
- **`MODE_PAGE_FLIP` EBUSY → vblank → next PAGE_FLIP succeeds.**
  Covers the (CRTC, OFD) throttle lifecycle: queue, second-queue
  rejected EBUSY, drive `kernel_vblank()`, queue accepted.
- **Host receives `kms_drop_master` exactly once on
  fork-inherited-master final-close.** Process A opens card0,
  SET_MASTER, forks; child inherits OFD; A close(fd) → OFD ref = 1,
  no kms_drop_master fires; child close(fd) → OFD destroyed → exactly
  one kms_drop_master fires (with the closer's pid, which is the
  child's). Guards against the host using the pid arg for state.
- **Double `SET_MASTER` from the same OFD is idempotent.** A3's
  fast-path returns `Ok` on already-held; lock the semantic.

### Trade-offs verified against the design doc + handoff requirements

- **`MODE_ADDFB2` accepts both `BoTier::CpuShared` and
  `BoTier::Gpu`.** A5's tier check is
  `matches!(bo.tier, BoTier::CpuShared) && req.pitches[0] != bo.stride
  → EINVAL`; GPU-tier with `stride == 0` (per plan 3 A3) bypasses
  the pitch check. Matches design §6.1 "compositor scans out from
  GPU bo" and handoff-4's explicit ask. ✓
- **Vblank cadence host-driven** (design §16 q3). RAF in browser
  (kernel-worker if supported, else main-thread routed via
  postMessage), `setInterval(16.67)` in Node. Risk register #1
  flags cross-browser RAF-in-worker feasibility as a Phase B spike.
  ✓
- **Single CRTC / single connector / single mode** (design §6.1).
  Connector type `DRM_MODE_CONNECTOR_VIRTUAL = 15` matches upstream.
  ✓
- **`DRM_MASTER`-as-`COMPOSITOR_PRI`** (design §5.4 + §6.3). Master
  holder's pid drives SubmitQueue priority lane bucketing.
  Subject to architecture-open #1 above. ✓ (mechanism), ⚠
  (constructor-signature consequence flagged).
- **One in-flight PAGE_FLIP per (CRTC, OFD)** matches Linux
  EBUSY-on-double-flip. ✓
- **Cross-fd handle import via `PRIME_FD_TO_HANDLE`** is the only
  path from renderD128 bo → card0 fb. Linux Mesa drivers do this
  too. Subject to correctness-open #1 above (the handle namespace
  field must actually exist on the card0 OFD). ✓ (semantics),
  ⚠ (field missing on `KmsFdState`).
- **Additive ABI only — no `ABI_VERSION` bump** (PR #490 policy).
  ✓ All new structs / ioctl numbers / `host_kms_*` imports / the
  `kernel_vblank` export; no existing surface touched. Verified
  against `docs/abi-versioning.md`.
- **Master-revoke-on-final-close** is race-free (single Mutex CAS
  in `dri::master`). ✓
- **execve revokes master via CLOEXEC**: the card0 fd is dropped on
  execve, refcount → 0 (if last ref), `on_final_close` runs,
  master released. ✓
- **`ASYNCIFY_SAVE_SLOTS` not touched** — A8/A9 reuse the existing
  asyncify suspend/resume primitive (same shape pipes/ttys use for
  blocking reads). The "save slot count" is a fixed scratch area,
  not "one per blocked thread"; reuse is ABI-safe. ✓

### Deliberately not flagged

- Linux UAPI ioctl numbers (`'d'` magic, nrs `0x1e/0x1f/0x3a/
  0xa0..0xa7/0xaf..0xb0/0xb8`) — verified vs `include/uapi/drm/drm.h`
  at v6.10 mainline; no collision with WPK extensions at `0xE0+`
  (plan 3 A1) or with plan 2's `0x00/0x09/0x0c/0x2d/0x2e/0xb2..0xb4`.
  ✓
- `DRM_MODE_CONNECTOR_VIRTUAL = 15` matches `drm_mode.h`. ✓
- `DRM_EVENT_VBLANK = 1` / `DRM_EVENT_FLIP_COMPLETE = 2` match
  upstream `drm.h`. ✓
- Render-node-only ioctls (`PRIME_*`, `MODE_*DUMB*`, `GEM_CLOSE`,
  `VERSION`, `GET_CAP`, plus plan 3's `WPK_CREATE_GPU_BO` +
  `WPK_BIND_FOREIGN_TEXTURE`) pass through from card0 to plan 2's
  `handle_dri_ioctl()`. Linux allows the inverse on real drivers
  too. ✓
- `kernel_vblank()` is a kernel **export**, not an import; additive
  exports are allowed without an `ABI_VERSION` bump per
  `docs/abi-versioning.md`. ✓
- POSIX-first: `open` / `close` / `read` / `poll` / `ioctl`
  semantics on card0 follow POSIX; only the ioctl numbers + struct
  shapes + `drm_event_vblank` record bytes are Linux UAPI. ✓
- Stacked-PR topology (kms-kernel → kms-host → kms-demo) matches
  the user's branch-chaining rule and plans 2 + 3's stack shape. ✓

### Cross-plan amendment from plan 5's devil's-advocate

Plan 5's devil's-advocate pass flagged a parallel concern in this
plan: **plan 4's `event_ring: VecDeque<u8>` is unbounded**. If a
userspace process opens `/dev/dri/card0`, takes master, queues
page-flips, and never `read`s, every vblank with a pending flip
appends a 32-byte `WpkDrmEventVblank` record forever. At 60 Hz with
a misbehaved client, the ring grows ~1.9 KB/s — not catastrophic
over minutes, but the unbounded shape is a correctness gap that
plan 5 noticed because its own ring needs a bound for the same
reason (held-down key autorepeat would explode within seconds).

The shape of the fix is different from plan 5's, though. plan 5
borrows Linux's evdev `SYN_DROPPED` convention; Linux's DRM UAPI has
no equivalent (no `DRM_EVENT_DROPPED` record type — Linux's drm core
just silently drops events when its per-fd event queue is full,
relying on the userspace driver to not lag this badly). *Resolution
for plan 4:* bound `KmsFdState.event_ring` at 64 records (2 KiB; ~1 s
of unread 60 Hz vblanks); on overflow, drop the *oldest* record
silently. No new event type, no userspace-visible signal — matches
what real Linux DRM does. Folded into A7's producer block at plan-4
impl time (Task A7 Step 1 sketch: `if event_ring.len() >=
KMS_EVENT_RING_MAX_BYTES { for _ in 0..32 { event_ring.pop_front(); }
}` before `push_event_record`). Constants live in `KmsFdState`
alongside `pending_flips`: `pub const KMS_EVENT_RING_MAX_RECORDS:
usize = 64;` and `pub const KMS_EVENT_RING_MAX_BYTES: usize =
KMS_EVENT_RING_MAX_RECORDS * 32;`. One new cargo test under A7:
`event_ring_overflow_drops_oldest_silently` — push 100 records
without reading, assert ring stays at exactly 64 records (2048
bytes) and the *most recent* 64 are kept.

### Cross-plan amendment from plan 6's devil's-advocate

Plan 6's devil's-advocate pass quantified an OFD-table-lock
contention figure that upgrades the urgency of this plan's
open-architecture #2 ("split OFD table out of PROCESS_TABLE").
Plan 5 already added a producer at 1000+ Hz (autorepeat + drag);
plan 6's per-quantum `kernel_audio_period_tick` adds another at
~375 Hz (after plan 6 inline fix #4 collapsed accumulator to
per-quantum). Combined worst case under load: input (1000+ Hz) +
audio (~375 Hz) + vblank (60 Hz) + WAIT_VBLANK consumers + WRITEI
from userland = ~1500+ Hz acquisitions on the shared
`PROCESS_TABLE` mutex. Lock window per acquisition is still
O(open OFDs), but contention probability scales non-linearly with
producer rate; SDL2 game loops in plan 7 will exercise all three
streams simultaneously under real workloads.

*Resolution:* the open-architecture #2 timing changes from "defer
to focused PR after plans 4+5 ship, no later than pre-SDL2-port-
merge" to "**block plan 7 (SDL2) merge on Phase C profiling — if
any of the three tick handlers shows >5% of its wall time in lock
acquisition under a representative SDL2 workload, the OFD-table-
split refactor is a hard prerequisite for plan 7 merge.**" The
profiling step lands in plan 7's Phase C; the refactor (if
triggered) is a focused inter-plan PR. Cross-plan note also added
to plan 5's open-architecture #1 + plan 6's open-architecture
section (which is where this concern is concretised).

### Cross-plan amendment from plan 8's devil's-advocate

Plan 8's devil's-advocate pass (session 9) confirms that this
plan's `PAGE_FLIP_EVENT` + per-OFD `event_ring` + `drmHandleEvent`
parser path is the canonical idiom for vsync-paced rendering.
wpkdraw's `wpk_surface_present` (plan 8 A3), the modeset demo
(this plan, C2 line 2103-2111), and SDL2's KMSDRM
`SwapWindow` (plan 7) all use the same `drmModePageFlip(...
PAGE_FLIP_EVENT) + drmHandleEvent` two-call pattern. Plan 8 inline
fix #2 catches one consumer that initially used `WAIT_VBLANK` for
flip-completion instead — the `WAIT_VBLANK` broadcast-wake is for
*free-running vblank polling without a queued flip*, not for
flip-completion waits.

*Resolution for this plan:* add a one-line note under
"Deliberately not flagged" calling out the two distinct
idioms (next to the existing `DRM_EVENT_VBLANK` / `DRM_EVENT_FLIP_COMPLETE`
constant block): "PAGE_FLIP_EVENT + drmHandleEvent is the canonical
flip-completion-wait pattern (plans 4 C2, 7 SwapWindow, 8 wpk_surface_present
all converge on it); WAIT_VBLANK without PAGE_FLIP_EVENT is the
free-running vblank-only pattern, used by libdrm clients that want
to pace without queueing a flip (rare; SDL2 KMSDRM doesn't use
it)." No code change in this plan; doc clarification only.

Plan 8's pass also caught the `gbm_bo_map` signature mismatch
flagged in plan 2's review — this plan's modeset demo (C2 line
2099) calls `gbm_bo_map` with 9 args; plan 2's libgbm stub C3
will re-issue at upstream Mesa's 8-arg shape `(bo, x, y, w, h,
flags, uint32_t *stride, void **map_data)`. *Resolution for this
plan's C2:* update the demo to match — `gbm_bo_map(bo, 0, 0,
mode.hdisplay, mode.vdisplay, 0, NULL, &map_data)` with stride
fetched separately via `gbm_bo_get_stride(bo)`. Folds into C2 at
impl time after plan 2's stub lands at the canonical shape.

### Cross-plan amendment from plan 9's devil's-advocate

Plan 9's devil's-advocate pass (session 10) confirms this plan's
OFD-final-close auto-drop of `DRM_MASTER` (lines 403-406 + 1116)
is sufficient for plan 9's compositor crash-recovery path. When
the compositor process at PID 2 dies (SIGKILL or normal exit), its
card0 OFD's refcount drops to zero, `on_final_close` fires, and
`drop_master(ofd_idx)` releases master globally. Plan 9 does NOT
require a separate `drmDropMaster` ioctl on graceful compositor
shutdown — though plan 9 inline fix #6 ships one as defensive
hygiene under the goto-chain cleanup. The kernel-side contract
this plan locks in covers both paths.

Plan 9 also relies on this plan's per-(CRTC, OFD) **one-in-flight
page-flip throttle** (lines 567-576 of this plan's A6) to bound
the compositor's render-rate. Plan 9 inline fix #8 adds a user-
space guard `gbm_surface_has_free_buffers` check before
`compositor_render_frame` to gracefully stall when the ring is
exhausted; the underlying throttle in this plan is what makes the
stall observable. No code change in this plan; the existing
throttle contract is the canonical one.

*Resolution:* note added to "Deliberately not flagged" — "OFD-
final-close auto-drop is sufficient for compositor-process-death;
plan 9 does NOT require a separate drmDropMaster ioctl on
graceful shutdown."

---

## Phase A — kernel: card0 device + KMS ioctls + DRM_MASTER + vblank ring (PR #1)

The kernel learns to (a) recognise `/dev/dri/card0` as a distinct
virtual device, (b) dispatch the KMS ioctl subset, (c) track
`DRM_MASTER` ownership on the card0 OFD, (d) accumulate pending
page-flips into a per-OFD vblank-event ring drained by `read(card0)`,
and (e) export `kernel_vblank()` so the host can drive the tick.

### Task A1: Shared ABI module additions

**Files:**
- Modify: `crates/shared/src/lib.rs` — extend `pub mod dri` with the
  KMS ioctl numbers, structs, and event-record layouts.

**Step 1: Constants and structs**

Append inside `pub mod dri { … }`:

```rust
    // --- KMS ioctl numbers ('d' magic, Linux UAPI verbatim) ---------------
    // (Plan 2 covers 0x00, 0x09, 0x0c, 0x2d, 0x2e, 0xb2, 0xb3, 0xb4.
    //  Plan 3 covers WPK extensions at 0xE0, 0xE1.
    //  Plan 4 (this file) covers 0x1e, 0x1f, 0x3a, 0xa0-0xa7, 0xaf-0xb0, 0xb8.)

    /// `_IO('d', 0x1e)` — request `DRM_MASTER` on this fd.
    pub const DRM_IOCTL_SET_MASTER: u32 = 0x0000_641e;

    /// `_IO('d', 0x1f)` — release `DRM_MASTER` if held.
    pub const DRM_IOCTL_DROP_MASTER: u32 = 0x0000_641f;

    /// `_IOWR('d', 0x3a, WpkDrmWaitVblankUnion)` — block until next vblank.
    /// The Linux struct is a union of request/reply; we encode the request
    /// shape on input and overwrite with the reply on output. 12 bytes on
    /// wasm32 (3 × u32, since the union body is `u32 type + u32 seq + u64
    /// signal`-or-`u32 tv_sec + u32 tv_usec` — 12 bytes either way).
    pub const DRM_IOCTL_WAIT_VBLANK: u32 = 0xc018_643a;

    /// `_IOWR('d', 0xa0, WpkDrmModeCardRes)` — get crtc/connector/encoder
    /// counts + ids. 64 bytes (4 × u64 + 4 × u32 + 4 × u32 = 32 + 16 + 16).
    pub const DRM_IOCTL_MODE_GETRESOURCES: u32 = 0xc040_64a0;

    /// `_IOWR('d', 0xa1, WpkDrmModeGetCrtc)` — get current CRTC state.
    /// 96 bytes (drm_mode_crtc).
    pub const DRM_IOCTL_MODE_GETCRTC: u32 = 0xc060_64a1;

    /// `_IOWR('d', 0xa2, WpkDrmModeGetCrtc)` — set CRTC: attach fb +
    /// connectors + mode. Same struct as GETCRTC, in/out shape.
    pub const DRM_IOCTL_MODE_SETCRTC: u32 = 0xc060_64a2;

    /// `_IOWR('d', 0xa6, WpkDrmModeGetEncoder)` — get encoder shape.
    /// 20 bytes (5 × u32).
    pub const DRM_IOCTL_MODE_GETENCODER: u32 = 0xc014_64a6;

    /// `_IOWR('d', 0xa7, WpkDrmModeGetConnector)` — get connector shape +
    /// EDID + modes. 88 bytes on wasm32.
    pub const DRM_IOCTL_MODE_GETCONNECTOR: u32 = 0xc058_64a7;

    /// `_IOWR('d', 0xaf, u32)` — remove fb id, freeing the binding.
    pub const DRM_IOCTL_MODE_RMFB: u32 = 0xc004_64af;

    /// `_IOWR('d', 0xb0, WpkDrmModeCrtcPageFlip)` — queue a page-flip;
    /// completes on next vblank, fires `drm_event_vblank` on the master
    /// fd's event ring. 24 bytes (3 × u32 + u64 user_data).
    pub const DRM_IOCTL_MODE_PAGE_FLIP: u32 = 0xc018_64b0;

    /// `_IOWR('d', 0xb8, WpkDrmModeFbCmd2)` — allocate fb id wrapping a bo
    /// (or up to 4 bos for multi-plane formats — we only support single-
    /// plane in v1). 96 bytes on wasm32.
    pub const DRM_IOCTL_MODE_ADDFB2: u32 = 0xc060_64b8;

    // --- Connector type constants (subset) --------------------------------

    /// `DRM_MODE_CONNECTOR_VIRTUAL` = 15. Best match for the
    /// OffscreenCanvas-as-display abstraction.
    pub const DRM_MODE_CONNECTOR_VIRTUAL: u32 = 15;

    /// `DRM_MODE_CONNECTED` = 1. The single connector is always connected
    /// (the canvas is always present from the kernel's POV).
    pub const DRM_MODE_CONNECTED: u32 = 1;

    // --- Event types (for the read(card0) record stream) ------------------

    /// `DRM_EVENT_VBLANK` = 1. Posted on `drmWaitVBlank` completion;
    /// **not** posted on page-flip completion (page-flips use
    /// `DRM_EVENT_FLIP_COMPLETE`).
    pub const DRM_EVENT_VBLANK: u32 = 1;

    /// `DRM_EVENT_FLIP_COMPLETE` = 2. Posted on page-flip completion.
    pub const DRM_EVENT_FLIP_COMPLETE: u32 = 2;

    // --- marshalled structs -----------------------------------------------

    /// `struct drm_mode_card_res`. 64 bytes on wasm32 (4 × u64 ptrs + 8 ×
    /// u32). Linux uses `__u64` for the four count/id ptr fields to keep
    /// the struct portable across x86_32 / x86_64; we mirror that — the
    /// wasm32 pointer occupies the low 32 bits, top 32 bits are zero on
    /// input and ignored on the kernel side.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCardRes {
        pub fb_id_ptr: u64,           // 0   in    u32-array ptr (caller-allocated)
        pub crtc_id_ptr: u64,         // 8   in
        pub connector_id_ptr: u64,    // 16  in
        pub encoder_id_ptr: u64,      // 24  in
        pub count_fbs: u32,           // 32  in/out (caller's array len; kernel's count)
        pub count_crtcs: u32,         // 36  in/out
        pub count_connectors: u32,    // 40  in/out
        pub count_encoders: u32,      // 44  in/out
        pub min_width: u32,           // 48  out
        pub max_width: u32,           // 52  out
        pub min_height: u32,          // 56  out
        pub max_height: u32,          // 60  out
                                      // total: 64
    }

    /// `struct drm_mode_modeinfo`. 68 bytes. Single-mode display has one
    /// fixed instance; clients query via `MODE_GETCONNECTOR`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeModeinfo {
        pub clock: u32,           // 0
        pub hdisplay: u16,        // 4
        pub hsync_start: u16,     // 6
        pub hsync_end: u16,       // 8
        pub htotal: u16,          // 10
        pub hskew: u16,           // 12
        pub vdisplay: u16,        // 14
        pub vsync_start: u16,     // 16
        pub vsync_end: u16,       // 18
        pub vtotal: u16,          // 20
        pub vscan: u16,           // 22
        pub vrefresh: u32,        // 24
        pub flags: u32,           // 28
        pub mode_type: u32,       // 32
        pub name: [u8; 32],       // 36..68
                                  // total: 68
    }

    /// `struct drm_mode_crtc`. 96 bytes on wasm32 (4 × u32 crtc_id/fb_id/
    /// x/y + u64 set_connectors_ptr + u32 count_connectors + u32 gamma_size
    /// + u32 mode_valid + WpkDrmModeModeinfo (68 bytes) — packed with
    /// trailing pad to round up to 8-byte align).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetCrtc {
        pub set_connectors_ptr: u64,  // 0   in   u32-array ptr (SETCRTC only)
        pub count_connectors: u32,    // 8   in   (SETCRTC only)
        pub crtc_id: u32,             // 12  in/out
        pub fb_id: u32,               // 16  in/out  fb to attach (SETCRTC), current fb (GETCRTC)
        pub x: u32,                   // 20  in/out
        pub y: u32,                   // 24  in/out
        pub gamma_size: u32,          // 28  out
        pub mode_valid: u32,          // 32  in/out
        pub mode: WpkDrmModeModeinfo, // 36..104
                                      // total: 104 (Linux says 96; wasm32 alignment differs)
        // NB: the Linux struct is 96 bytes because `__u64 set_connectors_ptr`
        // forces 8-byte alignment of the struct; on wasm32 the 8-byte
        // alignment of the leading u64 is the same, but `WpkDrmModeModeinfo`
        // ends at offset 104 if it starts at 36. **Verify with the ioctl
        // -encoding test at Task A1 Step 2 against the Linux number
        // `0xc060_64a1` (size 0x60 = 96).** If the real wasm32 layout
        // produces 104, encode the ioctl as `0xc068_64a1` (size 0x68 =
        // 104) and document the wasm32-ilp32 deviation.
    }

    /// `struct drm_mode_get_connector`. Truncated v1 shape: we report
    /// 1 mode, 0 encoders-other-than-current, 0 props. Total 88 bytes:
    /// 3 × u64 ptrs (24) + 13 × u32 (52) + 12 trailing bytes round-up.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetConnector {
        pub encoders_ptr: u64,         // 0   in
        pub modes_ptr: u64,            // 8   in   ptr to drm_mode_modeinfo array
        pub props_ptr: u64,            // 16  in
        pub prop_values_ptr: u64,      // 24  in
        pub count_modes: u32,          // 32  in/out
        pub count_props: u32,          // 36  in/out
        pub count_encoders: u32,       // 40  in/out
        pub encoder_id: u32,           // 44  out   current encoder
        pub connector_id: u32,         // 48  in/out
        pub connector_type: u32,       // 52  out   DRM_MODE_CONNECTOR_VIRTUAL
        pub connector_type_id: u32,    // 56  out   = 1
        pub connection: u32,           // 60  out   DRM_MODE_CONNECTED
        pub mm_width: u32,             // 64  out   physical width (mm); we report 0
        pub mm_height: u32,            // 68  out
        pub subpixel: u32,             // 72  out
        pub pad: u32,                  // 76
                                       // total: 80 (Linux 88 — verify; see CrtcGetCrtc note)
    }

    /// `struct drm_mode_get_encoder`. 20 bytes (5 × u32).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetEncoder {
        pub encoder_id: u32,           // 0   in/out
        pub encoder_type: u32,         // 4   out
        pub crtc_id: u32,              // 8   out
        pub possible_crtcs: u32,       // 12  out   bitmask
        pub possible_clones: u32,      // 16  out   bitmask
                                       // total: 20
    }

    /// `struct drm_mode_fb_cmd2`. 96 bytes on wasm32: 5 × u32 (fb_id,
    /// width, height, pixel_format, flags) = 20, then 4 × u32 handles +
    /// 4 × u32 pitches + 4 × u32 offsets = 48, then 4 × u64 modifiers =
    /// 32. Total = 100. **NB: Linux is 96 because of an alignment quirk
    /// (the 4 × u64 modifier array forces 8-byte align of struct end);
    /// on wasm32 the same applies, so total may differ. Verify and pick
    /// the encoding accordingly.**
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeFbCmd2 {
        pub fb_id: u32,                 // 0   out
        pub width: u32,                 // 4   in
        pub height: u32,                // 8   in
        pub pixel_format: u32,          // 12  in   DRM_FORMAT_*
        pub flags: u32,                 // 16  in
        pub handles: [u32; 4],          // 20  in   bo handles (single-plane: handle[0] only)
        pub pitches: [u32; 4],          // 36  in
        pub offsets: [u32; 4],          // 52  in
        pub modifier: [u64; 4],         // 64..96  in   DRM_FORMAT_MOD_LINEAR for all
                                        // total: 96 (verify wasm32 layout)
    }

    /// `struct drm_mode_crtc_page_flip`. 24 bytes (3 × u32 + u64).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCrtcPageFlip {
        pub crtc_id: u32,               // 0   in
        pub fb_id: u32,                 // 4   in
        pub flags: u32,                 // 8   in   PAGE_FLIP_EVENT etc.
        pub reserved: u32,              // 12
        pub user_data: u64,             // 16  in   passed back in event
                                        // total: 24
    }

    /// `struct drm_event_vblank` (the record `read(card0)` returns).
    /// 8-byte `drm_event` header (`type, length`) + 24-byte body
    /// (`user_data, tv_sec, tv_usec, sequence, crtc_id`) = 32 bytes
    /// total. Matches upstream `drm_event_vblank` in
    /// `include/uapi/drm/drm.h` exactly. **Critical:** SDL2's `KMSDRM`
    /// backend uses libdrm's `drmHandleEvent` with `version = 3` and
    /// the `page_flip_handler2` callback whose signature is
    /// `(fd, sequence, tv_sec, tv_usec, crtc_id, user_data)` — it
    /// *reads* both `sequence` and `crtc_id`. Truncating to 24 would
    /// feed v3 the wrong bytes; the libdrm stub in Task C1 reads 32
    /// bytes per record in lockstep with this layout.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmEventVblank {
        pub ev_type: u32,               // 0    DRM_EVENT_VBLANK or _FLIP_COMPLETE
        pub length: u32,                // 4    sizeof(WpkDrmEventVblank) = 32
        pub user_data: u64,             // 8    from page-flip request
        pub tv_sec: u32,                // 16   MONOTONIC seconds (kernel uptime)
        pub tv_usec: u32,               // 20   MONOTONIC microseconds
        pub sequence: u32,              // 24   per-CRTC monotonic vblank counter
        pub crtc_id: u32,               // 28   which CRTC fired this vblank
                                        // total: 32
    }

    /// `struct drm_wait_vblank_request`. Union member (input side).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmWaitVblankRequest {
        pub req_type: u32,              // 0   _DRM_VBLANK_RELATIVE etc.
        pub sequence: u32,              // 4   absolute or relative count
        pub signal: u64,                // 8   future-plan; v1 ignores
                                        // total: 16   (NB: Linux is 12 because no padding
                                        //              between u32+u32 and u64; verify our
                                        //              repr(C) doesn't add padding on wasm32.)
    }

    /// `struct drm_wait_vblank_reply`. Union member (output side).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmWaitVblankReply {
        pub rep_type: u32,              // 0
        pub sequence: u32,              // 4
        pub tv_sec: u32,                // 8
        pub tv_usec: u32,               // 12
                                        // total: 16
    }
```

**Step 2: Static-assert + ioctl-encoding tests**

Append to the existing `dri_tests` mod in `crates/shared/src/lib.rs`
(introduced by plan 2 Task A1 Step 2, extended by plan 3 Task A1
Step 2):

```rust
    #[test]
    fn kms_struct_sizes_match_wasm32_repr_c() {
        assert_eq!(size_of::<WpkDrmModeCardRes>(), 64);
        assert_eq!(size_of::<WpkDrmModeModeinfo>(), 68);
        assert_eq!(size_of::<WpkDrmModeGetEncoder>(), 20);
        assert_eq!(size_of::<WpkDrmModeCrtcPageFlip>(), 24);
        // 32 bytes (header + user_data + tv_sec + tv_usec + sequence
        // + crtc_id) — matches upstream `drm_event_vblank` so SDL2's
        // page_flip_handler2 reads the right fields.
        assert_eq!(size_of::<WpkDrmEventVblank>(), 32);
        // The three structs marked **verify** above must have their
        // size asserted here against whatever `repr(C)` actually
        // produces on wasm32; the ioctl encodings below must match.
        // If a layout assertion fails, fix the struct (not the ioctl
        // number).
        assert_eq!(size_of::<WpkDrmModeGetCrtc>(), 0x60 /* = 96; verify */);
        assert_eq!(size_of::<WpkDrmModeGetConnector>(), 0x58 /* = 88; verify */);
        assert_eq!(size_of::<WpkDrmModeFbCmd2>(), 0x60 /* = 96; verify */);
        assert_eq!(size_of::<WpkDrmWaitVblankRequest>(), 0x10 /* = 16 */);
        assert_eq!(size_of::<WpkDrmWaitVblankReply>(), 0x10);
    }

    #[test]
    fn kms_ioctl_numbers_match_linux_uapi() {
        let iowr = IOC_READ | IOC_WRITE;
        let io = 0u32;
        assert_eq!(DRM_IOCTL_SET_MASTER,
            ioc(io, 'd' as u32, 0x1e, 0));
        assert_eq!(DRM_IOCTL_DROP_MASTER,
            ioc(io, 'd' as u32, 0x1f, 0));
        assert_eq!(DRM_IOCTL_WAIT_VBLANK,
            ioc(iowr, 'd' as u32, 0x3a, 0x18 /* 24 — union size */));
        assert_eq!(DRM_IOCTL_MODE_GETRESOURCES,
            ioc(iowr, 'd' as u32, 0xa0, size_of::<WpkDrmModeCardRes>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETCRTC,
            ioc(iowr, 'd' as u32, 0xa1, size_of::<WpkDrmModeGetCrtc>() as u32));
        assert_eq!(DRM_IOCTL_MODE_SETCRTC,
            ioc(iowr, 'd' as u32, 0xa2, size_of::<WpkDrmModeGetCrtc>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETENCODER,
            ioc(iowr, 'd' as u32, 0xa6, size_of::<WpkDrmModeGetEncoder>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETCONNECTOR,
            ioc(iowr, 'd' as u32, 0xa7, size_of::<WpkDrmModeGetConnector>() as u32));
        assert_eq!(DRM_IOCTL_MODE_RMFB,
            ioc(iowr, 'd' as u32, 0xaf, 4));
        assert_eq!(DRM_IOCTL_MODE_PAGE_FLIP,
            ioc(iowr, 'd' as u32, 0xb0, size_of::<WpkDrmModeCrtcPageFlip>() as u32));
        assert_eq!(DRM_IOCTL_MODE_ADDFB2,
            ioc(iowr, 'd' as u32, 0xb8, size_of::<WpkDrmModeFbCmd2>() as u32));
    }
```

**Step 3: Run**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib dri_tests
```

Expected: plan 2 + plan 3 tests still pass; 2 new tests pass. **If any
layout assertion fails, fix the struct first** (add/remove pad fields,
inspect with `cargo expand`), then re-derive the ioctl number to
match the *actual* `size_of` value. The Linux number is the target,
but the wasm32 layout is reality — if they diverge, the wasm32 number
is what we encode and we document the deviation.

**Step 4: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(dri): shared ABI — KMS ioctl numbers + structs + event records"
```

---

### Task A2: `VirtualDevice::DriCard0` + devfs entry + `OpenFileKind::DriCard`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `VirtualDevice` and
  `match_virtual_device` for `/dev/dri/card0`.
- Modify: `crates/kernel/src/devfs.rs` — add `card0` next to the
  existing `renderD128` entry.
- Modify: `crates/kernel/src/ofd.rs` — add `OpenFileKind::DriCard` and
  extend plan 3's `DriFdState` with a `kms: Option<Box<KmsFdState>>`
  field. `KmsFdState` carries the per-card0-fd state.

**Step 1: Device enum**

In `crates/kernel/src/syscalls.rs` `VirtualDevice` enum (around lines
58-95 per the handoff §"Where to look in the tree"):

```rust
pub enum VirtualDevice {
    // … existing variants …
    DriRender0,   // /dev/dri/renderD128 (plan 2 + 3)
    DriCard0,     // /dev/dri/card0     (plan 4 — this task)
}
```

Extend `match_virtual_device` (around line 117) to map
`/dev/dri/card0` → `DriCard0`.

**Step 2: devfs entry**

In `crates/kernel/src/devfs.rs`, alongside the synthetic
`renderD128` entry, add:

```rust
synthetic_entry("card0", DT_CHR, 226, 0),  // major=226 (DRM), minor=0
```

(The minor numbers are conventional but not load-bearing — Linux
allocates dynamically.)

**Step 3: `KmsFdState` on the OFD**

In `crates/kernel/src/ofd.rs`, append plan 3's `DriFdState`
definition (or, if the architecture-open from plan 3 lands on
"`dri_handles` lifts to OFD but `gl_state` stays on Process",
`DriFdState` already exists at this point):

```rust
/// Per-fd state for `/dev/dri/card0` opens. **Per-OFD lift is
/// uncontroversial here — fb ids in Linux really are per-fd, not
/// per-process, and there's no fork-inherit-GL-bindings hazard.**
#[derive(Default, Clone, Debug)]
pub struct KmsFdState {
    /// fb-id → KmsFb (the bound bo + dimensions + format + stride).
    pub fbs: BTreeMap<u32, KmsFb>,
    /// Next fb id to issue. Linux numbers fb ids globally per-master;
    /// we scope per-OFD which is stricter than Linux but harmless.
    pub next_fb_id: u32,
    /// Holds DRM_MASTER on this OFD's card0 fd. Only one OFD across
    /// the kernel can hold master at a time (enforced by Task A3).
    pub holds_master: bool,
    /// Pending page-flips (queue depth 1 per CRTC in v1; v2 may bump).
    /// (crtc_id, target_fb_id, user_data) — flipped on next vblank.
    pub pending_flips: Vec<PendingFlip>,
    /// Event records queued for read(card0). The ring drains in FIFO.
    pub event_ring: VecDeque<u8>,  // raw bytes; records are 24-byte aligned
}

#[derive(Clone, Debug)]
pub struct KmsFb {
    pub bo_id: u32,
    pub width: u32,
    pub height: u32,
    pub pixel_format: u32,
    pub stride: u32,
}

#[derive(Clone, Debug)]
pub struct PendingFlip {
    pub crtc_id: u32,
    pub fb_id: u32,
    pub user_data: u64,
}
```

Attach the OFD-side DRI state. Per the Pre-impl review
("correctness-open #1" — card0 OFDs need a handle namespace for
ADDFB2), the cleanest landing is to consolidate plan 2's `prime_bo`,
plan 3's `dri`, and plan 4's `kms` into a single
`Option<Box<DriOfdState>>` enum **in this task** (not as a deferred
follow-up):

```rust
pub enum DriOfdState {
    PrimeBo(PrimeBoState),                    // plan 2 (renderD128 PRIME export)
    RenderNode(DriFdState),                   // plan 3 (renderD128 GL + handles)
    Card { dri: DriFdState, kms: KmsFdState }, // plan 4 (this task)
}

pub struct OpenFileDesc {
    // … existing fields …
    pub dri_state: Option<Box<DriOfdState>>,  // single field; replaces
                                              // plan 2's `prime_bo`
                                              // and plan 3's `dri`.
}
```

`open("/dev/dri/card0")` constructs
`Some(Box::new(DriOfdState::Card { dri: DriFdState::default(), kms:
KmsFdState::default() }))`. The `Card` variant carries plan 3's
`DriFdState` for the bo-handle namespace `MODE_ADDFB2` reads against
(populated by `PRIME_FD_TO_HANDLE` on card0 — same code path plan 3
A2 already wired for renderD128). The two-field-on-Card shape keeps
the GL state separate from the KMS state for clarity even though
they share the same OFD.

(Plan 2's commits + plan 3's commits land with the simpler
`Option<Box<...>>` shape per the original plan-doc text; this
consolidation lands as the *first* commit of plan 4 Phase A, so the
churn surfaces as one rename-style commit, not as drift across
plans.)

**Step 4: Cargo tests**

```rust
#[test]
fn open_card0_yields_kms_state() {
    // Open /dev/dri/card0 → OFD.kms is Some, .dri is None
    // (vs renderD128 which is the opposite).
}

#[test]
fn fork_inherits_kms_state_via_ofd_dup() {
    // Same OFD shared = same KmsFdState (Linux per-fd semantics
    // preserved through fork's ref-bump).
}
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/devfs.rs \
        crates/kernel/src/ofd.rs
git commit -m "kernel(dri): add /dev/dri/card0 + KmsFdState on OFD"
```

---

### Task A3: `DRM_IOCTL_SET_MASTER` / `DROP_MASTER` + global master state

**Files:**
- Modify: `crates/kernel/src/dri/mod.rs` (or a new
  `crates/kernel/src/dri/master.rs`) — add the kernel-wide
  master-holder lookup.
- Modify: `crates/kernel/src/syscalls.rs` — dispatcher branches for
  the two ioctls in a new `handle_dri_card_ioctl()`.
- Modify: `crates/kernel/src/process.rs` — `HostIO::kms_set_master`
  and `HostIO::kms_drop_master` to notify the host's
  SubmitQueue-priority lookup.

**Step 1: Global master holder**

In `crates/kernel/src/dri/master.rs`:

```rust
//! DRM_MASTER ownership tracking for /dev/dri/card0.
//!
//! Linux semantics: at most one fd per card holds DRM_MASTER at any
//! time. Master is taken via `DRM_IOCTL_SET_MASTER`, released via
//! `DRM_IOCTL_DROP_MASTER`, and revoked when the holding fd's OFD
//! is destroyed (i.e., on `on_final_close`). The current master's
//! pid is the COMPOSITOR_PRI source for plan 3's SubmitQueue.

use spin::Mutex;

static MASTER: Mutex<Option<MasterHolder>> = Mutex::new(None);

#[derive(Clone, Copy, Debug)]
pub struct MasterHolder {
    pub pid: i32,
    pub ofd_idx: usize,  // OFD slot, for revoke-on-close lookup
}

/// Try to claim master. Returns Ok if the caller now holds master.
/// EBUSY if another fd already holds it. EACCES is **not** returned
/// (we don't have per-uid permissions in v1).
pub fn try_set_master(pid: i32, ofd_idx: usize) -> Result<(), crate::Errno> {
    let mut m = MASTER.lock();
    if let Some(h) = *m {
        if h.ofd_idx == ofd_idx { return Ok(()); }  // already held
        return Err(crate::Errno::EBUSY);
    }
    *m = Some(MasterHolder { pid, ofd_idx });
    Ok(())
}

/// Release if the caller holds master. No-op otherwise.
pub fn drop_master(ofd_idx: usize) -> bool {
    let mut m = MASTER.lock();
    if let Some(h) = *m {
        if h.ofd_idx == ofd_idx {
            *m = None;
            return true;
        }
    }
    false
}

/// Current master holder's pid, if any. Used by SubmitQueue priority
/// (host queries this via a new kernel-export-callback during
/// `host_kms_set_master` notification).
pub fn current_master_pid() -> Option<i32> {
    MASTER.lock().map(|h| h.pid)
}
```

**Step 2: Dispatcher**

In `handle_dri_card_ioctl()` (sibling of plan 2's
`handle_dri_ioctl()`, which we keep for renderD128 and now
*also* call via fall-through for the shared
`PRIME_*`/`MODE_*DUMB*`/`GEM_CLOSE`/`VERSION`/`GET_CAP` ioctls valid
on both nodes):

```rust
fn handle_dri_card_ioctl(pid: i32, fd: i32, request: u32, buf: &mut [u8])
    -> Result<(), Errno>
{
    use wasm_posix_shared::dri::*;

    match request {
        DRM_IOCTL_SET_MASTER => {
            let ofd_idx = resolve_card0_ofd_idx(pid, fd)?;
            crate::dri::master::try_set_master(pid, ofd_idx)?;
            // Mark the OFD's local flag for fast-path checks.
            with_card0_ofd(ofd_idx, |kms| kms.holds_master = true);
            HOST_IO.lock().kms_set_master(pid);
            Ok(())
        }
        DRM_IOCTL_DROP_MASTER => {
            let ofd_idx = resolve_card0_ofd_idx(pid, fd)?;
            if crate::dri::master::drop_master(ofd_idx) {
                with_card0_ofd_mut(ofd_idx, |kms| {
                    kms.holds_master = false;
                    // Drain any pending flips — Linux has no
                    // flip-aborted event, so the queued flips
                    // simply vanish. Without this drain, a stale
                    // flip would fire on the next vblank if this
                    // OFD re-took master, surprising the new
                    // master (or a *different* OFD that takes
                    // master in between).
                    kms.pending_flips.clear();
                });
                // pid is the closer/dropper, used for host-side
                // logging only — KmsRegistry.dropMaster() is global.
                HOST_IO.lock().kms_drop_master(pid);
            }
            Ok(())
        }
        // … Tasks A4/A5/A6/A7 add: GETRESOURCES, GETCRTC, SETCRTC,
        //    GETENCODER, GETCONNECTOR, ADDFB2, RMFB, PAGE_FLIP,
        //    WAIT_VBLANK …
        //
        // Pass-through (render-node ioctls valid on card0 — Linux
        // allows this):
        DRM_IOCTL_VERSION | DRM_IOCTL_GET_CAP | DRM_IOCTL_GEM_CLOSE
        | DRM_IOCTL_PRIME_HANDLE_TO_FD | DRM_IOCTL_PRIME_FD_TO_HANDLE
        | DRM_IOCTL_MODE_CREATE_DUMB | DRM_IOCTL_MODE_MAP_DUMB
        | DRM_IOCTL_MODE_DESTROY_DUMB
        | DRM_IOCTL_WPK_CREATE_GPU_BO | DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE
            => handle_dri_ioctl(pid, fd, request, buf),
        _ => Err(Errno::EOPNOTSUPP),
    }
}
```

**Step 3: HostIO additions**

```rust
    fn kms_set_master(&mut self, pid: i32);
    fn kms_drop_master(&mut self, pid: i32);
```

Stub in `host/test/centralized-test-helper.ts`.

**Step 4: Cargo tests**

```rust
#[test]
fn second_set_master_returns_ebusy() { /* … */ }

#[test]
fn drop_master_then_other_can_take_it() { /* … */ }

#[test]
fn final_close_releases_master() {
    // Process A opens card0, SET_MASTER, fork → child also has the OFD.
    // Process A close(fd) → OFD refcount = 1, master still held (B has it).
    // Process B close(fd) → OFD destroyed → master released globally.
    // Process C opens card0, SET_MASTER → succeeds.
}
```

**Step 5: Commit**

```bash
git add crates/kernel/src/dri/master.rs crates/kernel/src/dri/mod.rs \
        crates/kernel/src/syscalls.rs crates/kernel/src/process.rs \
        host/test/centralized-test-helper.ts
git commit -m "kernel(dri): DRM_MASTER + SET_MASTER/DROP_MASTER ioctls"
```

---

### Task A4: Resource introspection — `GETRESOURCES`, `GETCONNECTOR`, `GETENCODER`, `GETCRTC`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend
  `handle_dri_card_ioctl()` with the four introspection ioctls.

Single CRTC (`crtc_id = 1`), single encoder (`encoder_id = 1`,
`possible_crtcs = 0b1`), single connector (`connector_id = 1`,
type = `DRM_MODE_CONNECTOR_VIRTUAL`, connected, one mode). The mode
is sourced from the host on first `MODE_GETRESOURCES` via a new
`HostIO::kms_mode_info(connector_id) -> WpkDrmModeModeinfo`
callback; cached for the duration of the OFD.

**Step 1: GETRESOURCES**

```rust
DRM_IOCTL_MODE_GETRESOURCES => {
    let req: WpkDrmModeCardRes = read_struct(buf)?;
    // Write back the counts the kernel knows.
    let resp = WpkDrmModeCardRes {
        count_fbs: with_card0_ofd_kms(pid, fd, |k| k.fbs.len() as u32)?,
        count_crtcs: 1,
        count_connectors: 1,
        count_encoders: 1,
        min_width: 1, max_width: 16384,
        min_height: 1, max_height: 16384,
        ..req
    };
    write_struct(buf, &resp)?;
    // If caller passed non-zero count_* with arrays, populate them via
    // proc_write_at(pid, ptr_field, slice). The {crtc,connector,encoder}_id
    // arrays each get a single-element [1] write.
    if req.count_crtcs >= 1 && req.crtc_id_ptr != 0 {
        proc_write_u32(pid, req.crtc_id_ptr as u32, &[1u32])?;
    }
    if req.count_connectors >= 1 && req.connector_id_ptr != 0 {
        proc_write_u32(pid, req.connector_id_ptr as u32, &[1u32])?;
    }
    if req.count_encoders >= 1 && req.encoder_id_ptr != 0 {
        proc_write_u32(pid, req.encoder_id_ptr as u32, &[1u32])?;
    }
    // fb_id_ptr is populated from KmsFdState.fbs keys (caller's first
    // call has count_fbs = 0 to probe).
    Ok(())
}
```

**Step 2: GETCONNECTOR / GETENCODER / GETCRTC**

Same pattern — write the fixed single-instance values back, populate
caller arrays if non-zero capacity. GETCONNECTOR returns one mode
(via `kms_mode_info` from the host on first call, cached per-OFD).

**Step 3: Cargo tests**

```rust
#[test]
fn getresources_reports_1_crtc_1_connector_1_encoder() { /* … */ }

#[test]
fn getconnector_reports_virtual_connected_with_one_mode() { /* … */ }
```

**Step 4: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/process.rs
git commit -m "kernel(dri): KMS introspection — GETRESOURCES, GET{CONNECTOR,ENCODER,CRTC}"
```

---

### Task A5: `MODE_ADDFB2` + `MODE_RMFB` + `MODE_SETCRTC`

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — three ioctl branches.

**Step 1: ADDFB2**

```rust
DRM_IOCTL_MODE_ADDFB2 => {
    let mut req: WpkDrmModeFbCmd2 = read_struct(buf)?;
    if req.width == 0 || req.height == 0 { return Err(Errno::EINVAL); }
    // Single-plane only in v1 — handles[1..4] must be zero.
    if req.handles[1] != 0 || req.handles[2] != 0 || req.handles[3] != 0 {
        return Err(Errno::EINVAL);
    }
    // Format must be one we accept (matches plan 2 + plan 3 lists).
    match req.pixel_format {
        DRM_FORMAT_ARGB8888 | DRM_FORMAT_XRGB8888 | DRM_FORMAT_RGB565 => {},
        _ => return Err(Errno::EINVAL),
    }
    // Resolve handle → BoId via the CALLER's renderD128-fd OFD state —
    // ADDFB2 takes bo handles which were issued via the same per-fd
    // DriFdState namespace. **Trade-off:** Linux scopes ADDFB2 handles
    // to the card0 fd, *not* the renderD128 fd. To match Linux we look
    // up against the same OFD as the card0 ioctl is being called on —
    // which means the caller must hold both card0 + renderD128 on the
    // SAME process AND have done a PRIME_FD_TO_HANDLE round-trip to
    // import the bo into the card0 fd's handle namespace. Document.
    let bo_id = resolve_handle_on_card0_ofd(pid, fd, req.handles[0])?;
    // Tier check: bo can be CpuShared or Gpu (both legal for scanout).
    let bo = crate::dri::with_registry(|r| r.get(bo_id).cloned())
        .ok_or(Errno::ENOENT)?;
    // Validate pitches[0] vs bo.stride for CpuShared (must match);
    // for Gpu tier, pitches[0] is ignored (host owns the layout).
    if matches!(bo.tier, crate::dri::BoTier::CpuShared)
        && req.pitches[0] != bo.stride
    {
        return Err(Errno::EINVAL);
    }
    // Pin the bo alive for the duration of the fb binding. Plan 2
    // refcount semantics: the fb keeps the bo alive until RMFB (or
    // on_final_close) — see "Trade-offs already locked in", item
    // `MODE_DESTROYDUMB on a fb-bound bo`. Increment BEFORE inserting
    // so the closure can return Err without leaking the ref.
    crate::dri::with_registry(|r| r.incref(bo_id));
    // Allocate fb_id, record binding.
    let fb_alloc: Result<u32, Errno> = with_card0_ofd_kms_mut(pid, fd, |k| {
        let id = k.next_fb_id.checked_add(1).ok_or(Errno::ENOMEM)?;
        k.next_fb_id = id;
        k.fbs.insert(id, KmsFb {
            bo_id, width: req.width, height: req.height,
            pixel_format: req.pixel_format,
            stride: req.pitches[0],
        });
        Ok::<_, Errno>(id)
    })?;
    let fb_id = match fb_alloc {
        Ok(id) => id,
        Err(e) => {
            crate::dri::with_registry(|r| r.decref(bo_id));
            return Err(e);
        }
    };
    // Notify host. Plan 2 / plan 3 convention: rc < 0 means host-side
    // allocation failed — unwind kernel state to keep registries in
    // lockstep (mirrors plan 2 A6's unwind shape).
    let rc = HOST_IO.lock().kms_addfb(pid, fb_id, bo_id, req.width,
        req.height, req.pixel_format, req.pitches[0]);
    if rc < 0 {
        with_card0_ofd_kms_mut(pid, fd, |k| { k.fbs.remove(&fb_id); })?;
        crate::dri::with_registry(|r| r.decref(bo_id));
        return Err(Errno::ENOMEM);
    }
    req.fb_id = fb_id;
    write_struct(buf, &req)?;
    Ok(())
}
```

**Step 2: RMFB**

```rust
DRM_IOCTL_MODE_RMFB => {
    let fb_id = read_u32(buf)?;
    // Drop the fb binding and release the bo pin in lockstep.
    let bo_id = with_card0_ofd_kms_mut(pid, fd, |k|
        k.fbs.remove(&fb_id).map(|fb| fb.bo_id).ok_or(Errno::ENOENT)
    )??;
    crate::dri::with_registry(|r| r.decref(bo_id));
    HOST_IO.lock().kms_rmfb(pid, fb_id);
    Ok(())
}
```

**Step 3: SETCRTC**

```rust
DRM_IOCTL_MODE_SETCRTC => {
    let req: WpkDrmModeGetCrtc = read_struct(buf)?;
    // Must hold DRM_MASTER on this fd.
    if !with_card0_ofd_kms(pid, fd, |k| k.holds_master)? {
        return Err(Errno::EACCES);
    }
    if req.crtc_id != 1 { return Err(Errno::ENOENT); }
    // fb_id = 0 means "disable CRTC"; otherwise validate.
    if req.fb_id != 0 {
        let _ = with_card0_ofd_kms(pid, fd, |k|
            k.fbs.get(&req.fb_id).cloned()).ok_or(Errno::ENOENT)?;
    }
    HOST_IO.lock().kms_set_fb(pid, req.crtc_id, req.fb_id);
    Ok(())
}
```

**Step 4: HostIO**

```rust
    fn kms_addfb(&mut self, pid: i32, fb_id: u32, bo_id: u32, w: u32,
        h: u32, format: u32, pitch: u32) -> i32;
    fn kms_rmfb(&mut self, pid: i32, fb_id: u32);
    fn kms_set_fb(&mut self, pid: i32, crtc_id: u32, fb_id: u32) -> i32;
```

**Step 5: Cargo tests**

```rust
#[test]
fn addfb_rejects_multi_plane_handles() { /* handles[1]=2 → EINVAL */ }

#[test]
fn addfb_validates_pitch_for_cpushared_bos() { /* pitch mismatch → EINVAL */ }

#[test]
fn addfb_accepts_gpu_tier_bos() { /* GPU bo + pitch ignored → OK */ }

#[test]
fn setcrtc_requires_master() { /* non-master → EACCES */ }

#[test]
fn setcrtc_with_fb_zero_disables_crtc() { /* OK; host sees fb_id=0 */ }
```

**Step 6: Commit**

```bash
git add crates/kernel/ host/test/
git commit -m "kernel(dri): MODE_ADDFB2 / RMFB / SETCRTC"
```

---

### Task A6: `MODE_PAGE_FLIP` queues + per-CRTC throttle

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — branch.

```rust
DRM_IOCTL_MODE_PAGE_FLIP => {
    let req: WpkDrmModeCrtcPageFlip = read_struct(buf)?;
    if req.crtc_id != 1 { return Err(Errno::ENOENT); }
    if !with_card0_ofd_kms(pid, fd, |k| k.holds_master)? {
        return Err(Errno::EACCES);
    }
    let _ = with_card0_ofd_kms(pid, fd, |k|
        k.fbs.get(&req.fb_id).cloned()).ok_or(Errno::ENOENT)?;
    // Throttle: one pending flip per CRTC per OFD. Returns EBUSY if
    // a flip is already pending — matches Linux behaviour.
    with_card0_ofd_kms_mut(pid, fd, |k| {
        if k.pending_flips.iter().any(|p| p.crtc_id == req.crtc_id) {
            return Err(Errno::EBUSY);
        }
        k.pending_flips.push(PendingFlip {
            crtc_id: req.crtc_id, fb_id: req.fb_id,
            user_data: req.user_data,
        });
        Ok(())
    })??;
    Ok(())  // the page-flip fires on next vblank (Task A7 + A8)
}
```

**Cargo:** test EBUSY on second flip pre-vblank; test EACCES without
master.

**Commit:** `kernel(dri): MODE_PAGE_FLIP queue + one-in-flight throttle`

---

### Task A7: `kernel_vblank()` export — fire pending flips, post event records

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` — add the kernel-wasm
  export `kernel_vblank()`.

```rust
/// Called from the host on every vblank tick. Walks every card0 OFD
/// with `holds_master = true` and `pending_flips` non-empty; for each
/// pending flip, posts a DRM_EVENT_FLIP_COMPLETE record into the
/// OFD's event ring and clears the pending entry. Wakes any task
/// blocked on `read(card0)` or `drmWaitVBlank` on that OFD.
#[no_mangle]
pub extern "C" fn kernel_vblank() {
    let now = crate::time::monotonic_us();  // CLOCK_MONOTONIC per
                                            // design §16 q6 — same
                                            // clock evdev uses in
                                            // plan 5.
    // Per-CRTC monotonic vblank counter. Single CRTC (id=1) in v1;
    // a kernel-global AtomicU32 suffices. Multi-CRTC v2+ becomes
    // a `BTreeMap<u32, AtomicU32>`.
    let seq = crate::dri::vblank_seq::tick(1 /* crtc_id */);
    // Lock order: PROCESS_TABLE (OFDs live inside it per plan 3 A3's
    // `pt.ofds.entries` shape). HOST_IO must not be held — we never
    // call into the host inside this loop. The lock window is
    // O(open card0 OFDs) which is typically 1–3 — microseconds at
    // 60 Hz tick rate, well below syscall-latency floor. (If
    // profiling under Phase C shows vblank-aligned syscall jitter,
    // the architecture-open "split OFD table out of PROCESS_TABLE"
    // resolution kicks in.)
    let mut woken: Vec<usize> = Vec::new();
    {
        let mut pt = PROCESS_TABLE.lock();
        for (idx, slot) in pt.ofds.entries.iter_mut().enumerate() {
            let Some(ofd) = slot.as_mut() else { continue; };
            let Some(kms) = ofd.kms.as_mut() else { continue; };
            if !kms.holds_master { continue; }
            if kms.pending_flips.is_empty() { continue; }
            for flip in core::mem::take(&mut kms.pending_flips) {
                let ev = WpkDrmEventVblank {
                    ev_type: DRM_EVENT_FLIP_COMPLETE,
                    length: core::mem::size_of::<WpkDrmEventVblank>() as u32,
                    user_data: flip.user_data,
                    tv_sec: (now / 1_000_000) as u32,
                    tv_usec: (now % 1_000_000) as u32,
                    sequence: seq,
                    crtc_id: flip.crtc_id,
                };
                push_event_record(&mut kms.event_ring, &ev);
            }
            woken.push(idx);
        }
    }
    // Two distinct wait-queues (see architecture-open "wake_all
    // overshoots"):
    //   - event-ring readers wake only when their ring grew; per-OFD.
    //   - WAIT_VBLANK callers wake on every tick; broadcast.
    for idx in woken {
        crate::dri::vblank_wait::wake_event_reader(idx);
    }
    crate::dri::vblank_wait::tick_wake_all();
}
```

**Cargo tests:** stub-call `kernel_vblank()` directly; assert event
ring length = pending_flips count beforehand; assert pending_flips is
empty after; assert the record bytes round-trip via `drmHandleEvent`
in the C demo (Task C3).

**Commit:** `kernel(dri): kernel_vblank export — drain pending flips into event ring`

---

### Task A8: `read(/dev/dri/card0)` returns event records; `poll/select` semantics

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — `sys_read` for OFDs with
  `kms: Some(_)` drains the event ring.

```rust
// In sys_read, before the host-handle fast path, for VirtualDevice::DriCard0:
if let Some(kms) = ofd.kms.as_mut() {
    if kms.event_ring.is_empty() {
        // Block in asyncify on the per-OFD event-reader queue;
        // resumed when `kernel_vblank()` pushes a record onto
        // *this* OFD's ring (Task A7's `wake_event_reader(idx)`).
        // Note: this is the narrow wake; the broad
        // `tick_wake_all()` resolves `WAIT_VBLANK` callers instead.
        crate::dri::vblank_wait::block_event_reader(ofd_idx)?;
    }
    // Drain whole records — DRM ABI: never partial records.
    let mut written = 0;
    while let Some(record_len) = peek_next_record_len(&kms.event_ring) {
        if written + record_len > user_buf.len() { break; }
        for _ in 0..record_len {
            user_buf[written] = kms.event_ring.pop_front().unwrap();
            written += 1;
        }
    }
    return Ok(written);
}
```

`poll(card0, POLLIN)` returns ready iff `!event_ring.is_empty()`;
straightforward extension of the existing pollable-fd dispatcher.

**Cargo tests:** assert `read` returns exactly one 24-byte record per
queued flip; assert `read` blocks if no events; assert `kernel_vblank`
unblocks the reader.

**Commit:** `kernel(dri): read(card0) drains event ring + poll(POLLIN) on events`

---

### Task A9: `DRM_IOCTL_WAIT_VBLANK` — synchronous wait

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — branch in
  `handle_dri_card_ioctl()`.

```rust
DRM_IOCTL_WAIT_VBLANK => {
    let req: WpkDrmWaitVblankRequest = read_struct(buf)?;
    // _DRM_VBLANK_RELATIVE | _DRM_VBLANK_SECONDARY etc. — v1 supports
    // RELATIVE only; sequence is the count of vblanks to wait.
    let to_wait = req.sequence.max(1);
    for _ in 0..to_wait {
        // Broadcast tick queue — every kernel_vblank tick wakes
        // every WAIT_VBLANK caller, regardless of master / OFD.
        // Distinct from the per-OFD `block_event_reader` used by
        // `read(card0)`.
        crate::dri::vblank_wait::block_for_next_tick()?;
    }
    let now = crate::time::monotonic_us();
    let reply = WpkDrmWaitVblankReply {
        rep_type: req.req_type,
        sequence: 0,  // we don't track a real sequence; v1 stub
        tv_sec: (now / 1_000_000) as u32,
        tv_usec: (now % 1_000_000) as u32,
    };
    write_struct(buf, &reply)?;
    Ok(())
}
```

The `vblank_wait` module exposes a thread-park primitive resumed by
`kernel_vblank()` (Task A7). It is a sibling of the existing
asyncify-park primitives (no new asyncify save slot needed — reuses
the existing one). **Verify the ASYNCIFY_SAVE_SLOTS constant isn't
touched** — that's a load-bearing ABI value.

**Cargo:** test `WAIT_VBLANK` blocks until next `kernel_vblank()` call.

**Commit:** `kernel(dri): DRM_IOCTL_WAIT_VBLANK + per-OFD vblank wait queue`

---

### Task A10: Cleanup — close / exit / execve revokes master + drops fbs

**Files:**
- Modify: `crates/kernel/src/ofd.rs` — extend the
  `on_final_close` hook plan 3 A5 introduced.

```rust
impl OpenFileDesc {
    pub fn on_final_close(&mut self, pid: i32, host_io: &mut dyn HostIO,
        ofd_idx: usize)
    {
        // … plan 2's prime_bo cleanup …
        // … plan 3's dri.handles + dri.gl.bindings cleanup …
        if let Some(kms) = self.kms.take() {
            // Revoke DRM_MASTER if held (race-free: ofd_idx is the
            // key). pid passed here is the *closer's* pid, not the
            // original master's — fork-inherited card0 OFDs make
            // that gap visible. Host uses pid for log attribution
            // only; `KmsRegistry.dropMaster()` is global. Documented
            // in the host-API B3 callback contract.
            if crate::dri::master::drop_master(ofd_idx) {
                host_io.kms_drop_master(pid);
            }
            // Drop fb_id → bo bindings, releasing the bo pin each
            // fb held (plan 2 refcount semantics). Order matters:
            // decref the bo BEFORE notifying the host so the host
            // sees the rmfb after the bo refcount has dropped (a
            // host-side fb that still references the bo can pick
            // its own destroy ordering).
            for (fb_id, fb) in kms.fbs {
                crate::dri::with_registry(|r| r.decref(fb.bo_id));
                host_io.kms_rmfb(pid, fb_id);
            }
            // pending_flips drop silently — Linux has no
            // flip-aborted event. event_ring is GC'd with the OFD.
        }
    }
}
```

execve: CLOEXEC drops the fd → on_final_close runs (if last ref) →
master released.

fork: OFD is shared by ref; no special handling — child inheriting the
card0 OFD also inherits master access (Linux allows this; child must
DROP_MASTER explicitly if parent wants to revoke).

**Cargo tests:** master holder exec → master released; fork-shared
master OFD → final-close releases.

**Commit:** `kernel(dri): on_final_close releases master + drops fbs`

---

### Task A11: ABI snapshot regen (additive)

**Files:**
- Modify: `abi/snapshot.json` (auto-generated).
- DO NOT modify: `ABI_VERSION` (additive).

Expected diff: new entries for each of the KMS structs + ioctl
numbers + 5 new `host_kms_*` imports + the new `kernel_vblank` export.
**No** changes to any existing row.

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
bash scripts/check-abi-version.sh
git add abi/snapshot.json
git commit -m "kernel(dri): regen ABI snapshot — additive KMS surface"
```

---

### Task A12: Phase A — full gauntlet + open PR #1

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Push, open draft PR.

Title: `[explore-dri] kernel(dri): /dev/dri/card0 + KMS ioctls + DRM_MASTER + vblank ring`

Body (Brandon style):

```markdown
## Summary
- Add `/dev/dri/card0` as a second DRI device node (sibling of plan 2's
  `/dev/dri/renderD128`).
- Implement the KMS ioctl subset SDL2 + weston need: `SET_MASTER`,
  `DROP_MASTER`, `MODE_GETRESOURCES`, `GETCONNECTOR`, `GETENCODER`,
  `GETCRTC`, `SETCRTC`, `ADDFB2`, `RMFB`, `PAGE_FLIP`, `WAIT_VBLANK`.
- `kernel_vblank()` export — host fires this on every vblank tick;
  kernel posts `DRM_EVENT_FLIP_COMPLETE` into the master's per-OFD
  event ring, drained by `read(card0)`.
- `DRM_MASTER` ownership: at most one OFD across the kernel holds it;
  `on_final_close` revokes. Plan 3's `COMPOSITOR_PRI` host-side lookup
  will rewire to "master holder pid" in PR #2 (host).

## Why
Plan 4 of the DRI v2 design (`docs/plans/2026-05-18-dri-design.md` §6)
— the modesetting + page-flip surface, prerequisite for the
compositor (plans 8–9) and for SDL2's `KMSDRM` backend (plan 7,
milestone D).

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
Additive only — no `ABI_VERSION` bump. New `repr(C)` structs in
`shared::dri`, new ioctl numbers in the existing DRM `'d'` magic
(verbatim Linux UAPI numbers), 5 new `host_kms_*` imports, 1 new
`kernel_vblank` export. No existing surface changes.

## Notes
- Render-node-only ioctls (`PRIME_*`, `MODE_*DUMB*`) pass through
  from `card0` to `renderD128`'s dispatcher; KMS ioctls on
  renderD128 return EOPNOTSUPP.
- Vblank tick is host-driven (PR #2); kernel only knows "tick
  happened, drain pending flips."
- DRM_MASTER → SubmitQueue priority swap lands in PR #2 — see
  plan 3's COMPOSITOR_PRI for the prior hardcoded shape.
```

**Do not merge.**

---

## Phase B — host: `KmsRegistry` + vblank tick + master-driven SubmitQueue priority (PR #2)

### Task B1: `KmsRegistry` module

**Files:**
- Create: `host/src/dri/kms-registry.ts`.

```ts
// host/src/dri/kms-registry.ts
import type { GbmRegistry } from './gbm-registry';

export interface HostFb {
  fb_id: number;
  bo_id: number;
  width: number;
  height: number;
  pixel_format: number;
  stride: number;
}

export class KmsRegistry {
  private fbs = new Map<number /* fb_id */, HostFb>();
  private crtcBindings = new Map<number /* crtc_id */, number /* fb_id */>();
  private masterPid: number | null = null;

  constructor(private gbm: GbmRegistry) {}

  addFb(fb: HostFb): void { this.fbs.set(fb.fb_id, fb); }
  rmFb(fb_id: number): void {
    this.fbs.delete(fb_id);
    // Detach from any CRTC bound to this fb.
    for (const [crtc, bound] of this.crtcBindings) {
      if (bound === fb_id) this.crtcBindings.set(crtc, 0);
    }
  }
  setFb(crtc_id: number, fb_id: number): void {
    this.crtcBindings.set(crtc_id, fb_id);
  }
  currentFb(crtc_id: number): HostFb | undefined {
    const id = this.crtcBindings.get(crtc_id) ?? 0;
    return id === 0 ? undefined : this.fbs.get(id);
  }

  setMasterPid(pid: number): void { this.masterPid = pid; }
  dropMaster(): void { this.masterPid = null; }
  /** True if `pid` holds DRM_MASTER on card0 right now. */
  isMasterPid(pid: number): boolean { return this.masterPid === pid; }
}
```

**Vitest:** `addFb` / `rmFb` / `setFb` lifecycle, `isMasterPid`
post-set/drop.

**Commit:** `host(dri): KmsRegistry — fb table + crtc bindings + master tracking`

---

### Task B2: Vblank tick — RAF in browser, setInterval in Node

**Files:**
- Create: `host/src/dri/vblank.ts`.
- Modify: `examples/browser/lib/browser-kernel.ts` — wire RAF
  (kernel-worker if supported, else main-thread routed via
  postMessage).
- Modify: `host/src/node-kernel-host.ts` — wire setInterval.

```ts
// host/src/dri/vblank.ts
export interface VblankSource {
  start(onTick: () => void): void;
  stop(): void;
}

export class NodeVblankSource implements VblankSource {
  private timer: NodeJS.Timeout | null = null;
  start(onTick: () => void) {
    this.timer = setInterval(onTick, 1000 / 60);  // 16.67 ms
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export class WorkerRafVblankSource implements VblankSource {
  // Use `requestAnimationFrame` inside the kernel-worker if available
  // (OffscreenCanvas-backed workers support it on recent Chrome/Edge).
  // Otherwise, fall back to receiving 'raf' messages from the main
  // thread via postMessage.
  start(onTick: () => void) {
    if (typeof requestAnimationFrame === 'function') {
      const loop = () => { onTick(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    } else {
      addEventListener('message', (e: MessageEvent) => {
        if (e.data?.type === 'raf') onTick();
      });
      postMessage({ type: 'raf-subscribe' });
    }
  }
  stop() { /* …unsubscribe… */ }
}
```

The driver of `onTick` in both cases is:

```ts
function onVblankTick() {
  // Present the current fb on each CRTC's canvas.
  for (const crtc of [/* 1 */ ]) {
    const fb = kmsRegistry.currentFb(crtc);
    if (fb) presentFbToCanvas(fb, /* via WebGL2 blit or 2D putImageData */);
  }
  // Tell the kernel a vblank happened so it can drain pending flips.
  kernel.exports.kernel_vblank();
}
```

**Dual-host parity (CLAUDE.md):** both Node and browser entries must
attach a `VblankSource` at host init. Symmetry check before commit.

**Vitest:** fake-timer drives `NodeVblankSource.start(...)`; assert
`onTick` called N times after N ticks of fake timer.

**Commit:** `host(dri): vblank tick — RAF (browser) + setInterval (Node)`

---

### Task B3: Wire `host_kms_*` imports

**Files:**
- Modify: `host/src/kernel.ts` — register the 5 new callbacks.
- Modify: `host/src/kernel-worker.ts` — forward to `KmsRegistry`.

Trivial plumbing once B1 + B2 are in. Pattern mirrors plan 2's
`host_gbm_*` wiring and plan 3's `host_gl_*` extension.

**Dual-host parity:** wire in both `host/src/node-kernel-worker-entry.ts`
and `examples/browser/lib/kernel-worker-entry.ts`. Symmetry check
mandatory.

**Commit:** `host(dri): wire host_kms_* imports — kernel-worker → KmsRegistry (dual-host)`

---

### Task B4: `SubmitQueue.COMPOSITOR_PRI` ← `KmsRegistry.isMasterPid`

**Files:**
- Modify: `host/src/webgl/submit-queue.ts`.

Plan 3 hardcoded `COMPOSITOR_PID = 2`. This task replaces the lookup
with a callable supplied at queue construction:

```ts
// host/src/webgl/submit-queue.ts
export class SubmitQueue {
  constructor(private isCompositor: (pid: number) => boolean) {}

  enqueue(binding: GlBinding, frame: SubmitFrame): void {
    const key = `${binding.pid}:${binding.ctx_id}`;
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { key, binding, frames: [] };
      this.byKey.set(key, entry);
      (this.isCompositor(binding.pid) ? this.compositor : this.clients)
        .push(entry);
    }
    entry.frames.push(frame);
  }
  // … pickNext / releaseIfEmpty unchanged …
}
```

The `releaseIfEmpty` also gets the same callable:

```ts
releaseIfEmpty(entry: QueueEntry): void {
  if (entry.frames.length > 0) return;
  this.byKey.delete(entry.key);
  const lane = this.isCompositor(entry.binding.pid) ? this.compositor
                                                    : this.clients;
  const i = lane.indexOf(entry);
  if (i >= 0) lane.splice(i, 1);
}
```

Kernel-worker construction passes `(pid) => kmsRegistry.isMasterPid(pid)`.

Backwards-compat note: a process can hold COMPOSITOR_PRI without
having taken DRM_MASTER yet (race between
`SubmitQueue.enqueue(pid=2)` and the master being taken). Two
acceptable outcomes:
- (a) Master-promotion-after-the-fact: the SubmitQueue **does not
  re-classify** already-enqueued entries when master changes. The
  entry stays in whichever lane it was put in at enqueue time; the
  *next* enqueue from that pid is classified per the *new* master.
  Pragmatic; matches plan 3's enqueue-once shape.
- (b) Reclassification on master change: when `isMasterPid` flips for
  a pid, walk the queue and move entries between lanes. Stricter, but
  requires the queue to expose a re-bucket API and `KmsRegistry` to
  call it on every master transition.

*Lean: (a).* The host's typical pattern is: compositor takes master
at boot before any client submits. (b) is a future optimisation if
profiling shows it.

**Vitest:** new test in `host/test/dri-multiplex.spec.ts` replaces
the plan 3 "fake compositor pid 2" assertion with "process holds
master → COMPOSITOR_PRI; drops → CLIENT_PRI"; plan 3's prior
PID-2 assertion is updated to use a `KmsRegistry` stub that returns
true for the fake compositor's pid.

**Commit:** `host(dri): SubmitQueue priority via KmsRegistry.isMasterPid (replaces plan 3 pid==2 hardcode)`

---

### Task B5: Vitest — page-flip → vblank event round-trip

**Files:**
- Create: `host/test/dri-kms-pageflip.spec.ts`.

Setup:
- Open card0 from a fixture process, SET_MASTER.
- Open renderD128, CREATE_DUMB a 256×256 bo, write a colour.
- ADDFB2 wrapping that bo → fb_id.
- SETCRTC(crtc=1, fb=fb_id, mode=…) — host's canvas now shows the
  pixels.
- PAGE_FLIP(crtc=1, fb=fb_id, user_data=0xdeadbeef).
- Drive one fake vblank tick: `kernel.exports.kernel_vblank()`.
- `read(card0, buf, 32)` → assert: 32 bytes returned, parses as
  `DRM_EVENT_FLIP_COMPLETE`, `length == 32`, `user_data == 0xdeadbeef`,
  `sequence == 1` (first tick on crtc=1), `crtc_id == 1`.

**Commit:** `host(dri): vitest — page-flip → vblank event round-trip`

---

### Task B6: Phase B — full gauntlet + open PR #2

Push, open draft PR.

Title: `[explore-dri] host(dri): KmsRegistry + vblank tick (RAF/setInterval) + master-driven SubmitQueue priority`

Body: Summary / Why / Verification / **Dual-host parity proof** (both
Node and browser kernel-worker entries wire VblankSource + KmsRegistry
+ rewired SubmitQueue priority; symmetry verified before commit) /
Notes (plan 3's PID-2 hardcode is removed; compositor demos that
relied on it must now SET_MASTER on card0 first).

---

## Phase C — sysroot + demo + browser (PR #3)

### Task C1: `libdrm.a` stub — KMS surface

**Files:**
- Modify: `glue/libdrm_stub.c` (~+200 LoC).

Add: `drmModeGetResources`, `drmModeFreeResources`, `drmModeGetCrtc`,
`drmModeFreeCrtc`, `drmModeSetCrtc`, `drmModeGetConnector`,
`drmModeFreeConnector`, `drmModeGetEncoder`, `drmModeFreeEncoder`,
`drmModeAddFB2`, `drmModeRmFB`, `drmModePageFlip`, `drmModeWaitVBlank`,
`drmHandleEvent` (event dispatcher: `read(fd)` + parse + call
user-supplied `page_flip_handler` callback).

Each is a thin libc-style wrapper around `drmIoctl` (already exists
from plan 2 C2) — allocate caller-side buffers, populate ptrs, call
ioctl, transcribe results into the libdrm-shape return structs.
`drmHandleEvent` reads 32-byte records in a loop (matching our
`WpkDrmEventVblank`, which mirrors upstream `drm_event_vblank`
exactly) and dispatches by `ev_type`: `DRM_EVENT_VBLANK` →
`vblank_handler`, `DRM_EVENT_FLIP_COMPLETE` → `page_flip_handler` if
ctx.version == 2 else `page_flip_handler2` if version ≥ 3 (passes
`crtc_id` as a sixth argument — that's the field SDL2's KMSDRM
backend reads).

**Commit:** `sysroot(dri): libdrm stub — KMS subset (GetResources, AddFB2, SetCrtc, PageFlip, HandleEvent, WaitVBlank)`

---

### Task C2: `programs/modeset.c` — minimal modeset demo

**Files:**
- Create: `programs/modeset.c`.

```c
// programs/modeset.c — ~150 LoC
// Opens card0, takes master, sets a mode, allocates a bo via libgbm
// on renderD128 (cross-fd via PRIME_HANDLE_TO_FD round-trip into
// card0's handle namespace), wraps as fb via ADDFB2, SETCRTC, then
// page-flips a 60-FPS counter for 5 seconds. exit 0 if no errors +
// at least 250 vblank events received.

int main(void) {
    int card = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    int render = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    drmSetMaster(card);

    drmModeRes *res = drmModeGetResources(card);
    uint32_t crtc_id = res->crtcs[0];
    uint32_t connector_id = res->connectors[0];
    drmModeConnector *conn = drmModeGetConnector(card, connector_id);
    drmModeModeInfo mode = conn->modes[0];

    struct gbm_device *gbm = gbm_create_device(render);
    struct gbm_bo *bo = gbm_bo_create(gbm, mode.hdisplay, mode.vdisplay,
        GBM_FORMAT_XRGB8888, GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);

    // Cross-fd handle import: export from renderD128 then import to card0.
    int prime = gbm_bo_get_fd(bo);
    uint32_t card_handle;
    {
      struct drm_prime_handle p = { .fd = prime, .flags = 0 };
      drmIoctl(card, DRM_IOCTL_PRIME_FD_TO_HANDLE, &p);
      card_handle = p.handle;
    }

    uint32_t fb_id;
    {
      struct drm_mode_fb_cmd2 add = {
        .width = mode.hdisplay, .height = mode.vdisplay,
        .pixel_format = DRM_FORMAT_XRGB8888,
        .handles = { card_handle, 0, 0, 0 },
        .pitches = { gbm_bo_get_stride(bo), 0, 0, 0 },
        .offsets = { 0, 0, 0, 0 },
        .modifier = { DRM_FORMAT_MOD_LINEAR, 0, 0, 0 },
      };
      drmIoctl(card, DRM_IOCTL_MODE_ADDFB2, &add);
      fb_id = add.fb_id;
    }

    drmModeSetCrtc(card, crtc_id, fb_id, 0, 0, &connector_id, 1, &mode);

    int events = 0;
    for (int i = 0; i < 300 && events < 250; i++) {
      // Draw a frame counter at top-left.
      uint32_t *px = gbm_bo_map(bo, 0, 0, mode.hdisplay, mode.vdisplay,
          0, NULL, NULL, NULL);
      draw_counter(px, gbm_bo_get_stride(bo)/4, i);

      drmModePageFlip(card, crtc_id, fb_id, DRM_MODE_PAGE_FLIP_EVENT,
          (void*)(uintptr_t)i);

      // Wait for the event via drmHandleEvent.
      drmEventContext ctx = {
        .version = 2,
        .page_flip_handler = on_flip,  // increments `events`
      };
      drmHandleEvent(card, &ctx);
    }

    drmDropMaster(card);
    return events >= 250 ? 0 : 1;
}
```

Build with `wasm32posix-cc -o programs/modeset.wasm programs/modeset.c
-lgbm -ldrm`. Wire into `scripts/build-programs.sh`.

**Commit:** `examples(dri): modeset demo — page-flip + frame counter + vblank events`

---

### Task C3: Vitest end-to-end

**Files:**
- Create: `host/test/dri-modeset.spec.ts`.

Runs `modeset.wasm` under the centralised kernel with a fake vblank
source (60 ticks/sec via fake timers). Asserts exit code 0 after
~5 simulated seconds; asserts the canvas's pixel buffer contains the
"frame counter at top-left" pattern at the expected sequence count.

**Commit:** `host(dri): vitest — modeset end-to-end with fake vblank source`

---

### Task C4: Manual browser verification (the gate)

CLAUDE.md item 6. Build the demo, drop into
`examples/browser/pages/modeset/`. `./run.sh browser`, navigate, watch
the frame counter increment smoothly at 60 FPS for 5 seconds. If the
counter stalls or RAF doesn't fire inside the worker, fall back to
main-thread RAF routing (Task B2's else branch) and re-verify.

**No commit yet for this task — verification only.** If the browser
demo fails but Node passes, that's a host-parity bug — PR #410
cautionary tale.

---

### Task C5: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(dri): modeset demo + browser spec`

Body: Summary / Why / Verification (gauntlet + browser screenshot of
the counter) / Dual-host parity proof / Notes.

---

## Final coordinated merge

When all three PRs (kernel, host, examples) are reviewed and approved,
and Brandon has signed off on the demo running cleanly in browser +
Node:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → PR #3's base.
4. Squash-merge PR #3 → plan 3's `…-mux-demo` (or wherever plan 3's
   tip lives at the time).
5. Tag: `[explore-dri-kms] milestone (KMS) merged at <sha>` in the
   next session-handoff doc.

**Do not push to upstream until v1 + plan 2 + plan 3 + plan 4 are
all merged upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Single CRTC, single connector, single mode** (design §6.1).
  Multi-CRTC / multi-monitor is a post-v1 redesign (one canvas per
  CRTC, host-level fan-out). The single-mode constraint matches the
  fact that the OffscreenCanvas dimensions are fixed at attachment.
- **`DRM_MASTER` is the COMPOSITOR_PRI source** (design §5.4 + §6.3).
  Plan 3's PID-2 hardcode is removed in Task B4. A process that
  doesn't take master on card0 cannot get head-of-queue scheduling
  on the multiplexer — by design.
- **Vblank cadence is host-driven** (design §16 q3). RAF (browser) or
  16.67 ms setInterval (Node). The kernel does not have its own
  timer; it learns "tick happened" via the `kernel_vblank` export.
- **Legacy modeset only** (no `DRM_IOCTL_MODE_ATOMIC`). Atomic
  modesetting is a v2 feature for plane composition + commit phases;
  the demo + SDL2's `KMSDRM` backend use legacy SETCRTC + PAGE_FLIP.
  Atomic is post-v1.
- **One in-flight page-flip per CRTC per OFD** (matches Linux
  EBUSY-on-double-flip behaviour). A compositor that wants more
  in-flight (triple-buffered) submits via different fbs; the throttle
  is per (crtc, OFD), not per fb.
- **Cross-fd bo handle import**: plan 2's `PRIME_FD_TO_HANDLE` round-
  trip is the only way to make a renderD128-allocated bo addressable
  from a card0 fd. Linux Mesa drivers do the same; SDL2's KMSDRM
  backend does too. No need for a side-channel "handle pool"
  abstraction.
- **`MODE_ADDFB2` accepts both `BoTier::CpuShared` and `BoTier::Gpu`
  bos.** GPU-tier bos are valid scanout targets (the compositor's
  primary use case). The `pitches[0]` check is skipped for
  GPU-tier (host knows the texture's row pitch).
- **No GAMMA / no cursor plane / no overlay plane** in v1. SDL2's
  KMSDRM backend doesn't require them; the wpkcompositor (plan 9)
  may want them later.
- **Master is per-OFD, not per-Process.** Fork-inherits via OFD ref
  bump (matches Linux). The child can DROP_MASTER independently of
  the parent's wishes (also Linux-shape).

---

## Risk register

1. **`requestAnimationFrame` in workers is patchy across browsers.**
   Chrome ≥ 88 supports it on OffscreenCanvas-backed workers; Firefox
   support is partial as of 2024. The fallback is main-thread RAF
   routed via postMessage. Run Task B2 first thing in Phase B; gate
   the demo's frame budget on the actual cross-browser jitter. If
   postMessage-routed RAF turns out to be too jittery (>5 ms p99
   beyond 16.67 ms), the demo may need a tolerance band in its
   "events ≥ 250 in 300 frames" assertion.
2. **`drm_event_vblank` record layout mismatch with Linux.** The
   24-byte size assumed here may not match upstream (Linux is
   typically 32 bytes with `sequence` + `crtc_id`). The C demo +
   libdrm `drmHandleEvent` parser must agree with the kernel's
   record producer; if the upstream layout is wider, update both
   sides in lockstep (record size determines the per-record advance
   in the ring read). Task A1 Step 2 must assert the exact size to
   prevent silent drift.
3. **DRM_MASTER race between SubmitQueue enqueue and master change.**
   See Task B4's (a) vs (b) trade-off — picked (a) for simplicity,
   means a process briefly classified as compositor-pri-but-not-yet-
   master gets a one-frame head-of-queue benefit. Acceptable.
4. **`MODE_GETCRTC` / `WpkDrmModeGetCrtc` size mismatch with Linux.**
   Marked **verify** in the struct definition — if `repr(C)` produces
   104 bytes on wasm32 (Linux is 96), encode the ioctl as
   `0xc068_64a1` instead of `0xc060_64a1`. Document the wasm32
   deviation in `docs/architecture.md` § DRM section once Task A1
   lands.
5. **Pending-flip queue depth = 1 means a hot compositor that page-
   flips every frame can starve `EBUSY`-returning clients.** Plan 3's
   "no preemption mid-cmdbuf" risk is the analogous case for GL
   submits; plan 4's analog for KMS is "no flip-batching". v2-level
   compositor (plan 9) may need to bump queue depth to 2 (front +
   pending) per CRTC.
6. **Cross-fd handle import lock order.** ADDFB2 on card0 dereferences
   a handle issued via PRIME_FD_TO_HANDLE on card0 (which itself
   referenced a bo created on renderD128). The lock dance is:
   `PROCESS_TABLE` → OFD card0 lookup → release → `BoRegistry`. Same
   policy as plan 2 + plan 3; verify the ADDFB2 path doesn't violate
   "never hold two of {BoRegistry, HOST_IO, PROCESS_TABLE}".

---

## What this plan doesn't cover (deferred)

- **Atomic modesetting** (`DRM_IOCTL_MODE_ATOMIC`). v2+.
- **Multi-CRTC / multi-monitor** (one canvas per CRTC). v2+.
- **Cursor / overlay planes** (`MODE_GETPLANE`,
  `DRM_IOCTL_MODE_CURSOR2`). v2+ — compositor may want them.
- **GAMMA / colour calibration** (`DRM_IOCTL_MODE_GAMMA_GET/SET`).
  Out of scope.
- **Hot-plug** (uevent). The single connector is always present from
  the kernel's POV; no hot-plug events.
- **`DRM_IOCTL_MODE_CREATE_BLOB`** (for atomic-modeset prop values).
  Tied to atomic. Out of scope.
- **`MODE_DESTROYDUMB` on a fb-bound bo**. We allow the destroy to
  succeed silently; the fb keeps the bo alive via the refcount until
  RMFB. (Matches plan 2's refcount semantics.)
- **evdev** (`/dev/input/event*`). Plan 5.
- **ALSA** (`/dev/snd/*`). Plan 6.
- **SDL2 port** (milestone D, plan 7) — requires plans 3 + 4 + 5 + 6.
- **wpkcompositor** (plans 8-9) — the PID-2-or-whoever-has-master
  binary itself.

---

End of plan.
