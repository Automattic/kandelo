# DRI port onto kandelo:main — session handoff

## Goal

Land the entire DRI/WebGL/KMS stack from `mho22/wasm-posix-kernel` PRs
#58/#61/#62/#63/#64/#65/#66 as **one** pull request against
`Automattic/kandelo:main`. Replace the legacy standalone
`apps/browser-demos/pages/modeset/` page with a **Kandelo React UI pane**
that hosts the Pavel-fluid-sim demo. All five test gates from
`CLAUDE.md` must pass before opening the PR.

## Branch state at end of this session

- Working branch: `dri-kandelo` (off `upstream/main` @ `87b410b72`).
- Safety tag preserving the entire 6-PR stack from the old fork:
  `dri-kms-kernel-snapshot` (= `14026af97e106916d77c2cdef94f736b06c30208`).
- Local branch retained as backup: `dri-kms-kernel`.
- One commit on `dri-kandelo` so far: `b25ef5942 dri+wpk: bring forward DRI/WebGL surface against kandelo:main`.
- Uncommitted edits in `crates/kernel/src/syscalls.rs` (added two
  `VirtualDevice` variants; **the file no longer compiles** —
  see "Immediate next step" below).

## Project drift to be aware of

The old fork was based on **very old** kandelo state (merge base with
`upstream/main` is `1bb7ae015`, a Phase 1 POSIX milestone commit). The
divergence is **933 commits on our side, 893 commits on theirs**, which
includes three load-bearing changes that the snapshot's DRI code is
built on top of and must be **reworked**, not just ported:

1. **Asyncify is dead.** Upstream replaced it with
   `wasm-fork-instrument` + `wpk_fork_*` exports
   (`docs/fork-instrumentation.md`). Anything in the snapshot referring
   to `ASYNCIFY_SAVE_SLOTS` / `AsyncifySaveSlot` / asyncify-onlylists /
   `--asyncify` is invalid. The DRI fork/clone integration in the
   snapshot was Asyncify-shaped — that path must be rewritten against
   `crates/fork-instrument/` and the upstream `fork.rs` shape.
2. **Project renamed.** Cargo package is now `kandelo` (lib name
   `kandelo_kernel`). Tests run with `cargo test -p kandelo …`,
   **not** `cargo test -p wasm-posix-kernel …`. The CLAUDE.md was
   updated upstream — the in-tree version under
   `worktrees/kandelo/wasm-posix-kernel/.../CLAUDE.md` reflects the new
   one. Don't be fooled by the worktree path.
3. **`ABI_VERSION` jumped from 11 → 14.** Upstream added new syscalls,
   `HostAdapterManifest`, new channel state, etc. The DRI work was
   designed against ABI 11. Any DRI-affecting struct/syscall added on
   top is **additive-only** for now (no further bump) — but only as
   long as the ABI snapshot regenerates cleanly.

## What's already done (committed)

In commit `b25ef5942`:

- **Shared ABI** (`crates/shared/src/lib.rs`): appended `pub mod gl`
  (cmdbuf opcodes + GLES2 sync-query tags + marshalled ioctl arg
  structs), `pub mod dri` (DRM ioctl numbers, fourcc constants, KMS
  struct definitions), plus `gl_tests` / `dri_tests`. **All 19 shared
  unit tests pass** (`cargo test -p wasm-posix-shared`). No
  `ABI_VERSION` bump.
- **Kernel `dri/` module** (`crates/kernel/src/dri/{mod,bo,master}.rs`):
  bo registry + global master tracking + KMS vblank/commit counters.
  Declared via `pub mod dri;` in `crates/kernel/src/lib.rs`. **17 DRI
  unit tests pass.**
- **HostIO trait extensions** (`crates/kernel/src/process.rs`,
  injected before the closing `}` of the trait, line ~200): added
  `gbm_bo_*`, `gl_*`, `kms_*`, `proc_read_bytes`, `proc_write_bytes`
  default impls. **Every method has a default impl** (the snapshot
  left several un-defaulted; I added defaults so upstream's existing
  HostIO impls compile unchanged).
- **libc stubs**: full `libdrm_stub.c`, `libgbm_stub.c`, `libegl_stub.c`,
  `libglesv2_stub.c` + the shared `gl_abi.h`.
- **musl-overlay headers**: `drm/`, `GLES2/`, `EGL/`, `KHR/`, `gbm.h`,
  `xf86drm.h`, `xf86drmMode.h`, `sys/ioccom.h`.
- **Example programs**: `cube.c`, `cube_pyramid.c`, `dri-smoke.c`,
  `dri_paint.c`, `dumb_roundtrip.c`, `kms-pageflip-smoke.c`,
  `libdrm-kms-smoke.c`, `modeset.c` (the Pavel fluid-sim port).
- **Build script**: `scripts/build-gles-stubs.sh`.
- **Design docs**: `docs/plans/2026-04-28-webgl-gles2-{design,plan}.md`,
  `docs/plans/2026-05-18-dri-design.md`.
- **Host TS scaffold**: `host/src/dri/` (kms-registry, registry),
  `host/src/webgl/` (bridge, index, main-forward, muxer, ops, query,
  registry, shadow, submit-drain, submit-queue). **Not wired** —
  copied wholesale from snapshot, will need adaptation to
  upstream's evolved `kernel.ts` / `kernel-worker.ts` shape.
- **Host TS tests**: `host/test/{dri,webgl}-*.test.ts`. **Not yet
  runnable** — they import APIs that don't exist on upstream's
  host runtime yet.

## What's in-flight (uncommitted) at session end

`crates/kernel/src/syscalls.rs`:

- Added `VirtualDevice::DriRenderD128` and `VirtualDevice::DriCard0`
  to the enum at line 60, the `host_handle()` map, the
  `from_host_handle()` map, the `ino()` map, and the
  `match_virtual_device()` matcher (lines ~60–135).
- **Compile error**: the `match dev` at **line 1506** (inside
  `sys_read`'s CharDevice handler) doesn't yet cover the two new
  variants. The compiler's suggestion (`VirtualDevice::DriRenderD128 |
  VirtualDevice::DriCard0 => todo!()`) is the right shape; it should
  return `0` like `Fb0` (DRI device read is not a thing in user
  space — clients mmap or ioctl). There may be **other matches**
  upstream's syscalls.rs that also need new arms — grep for
  `match.*VirtualDevice` or `VirtualDevice::Fb0 =>` to find them.

## What's NOT done (the long tail)

In dependency order:

### Kernel side

1. **Finish the `VirtualDevice` exhaustiveness fix** described above.
2. **Wire `/dev/dri/*` through `sys_open`.** The
   `match_virtual_device` matcher returns the new variants, but
   `sys_open` must accept them and create a `CharDevice` OFD with the
   negative `host_handle`. Follow the `Fb0`/`Dsp` pattern at
   `syscalls.rs:204–355`. Skip the "single-owner claim" — DRI is
   multi-process by design.
3. **DRI ioctl dispatch.** Snapshot has
   `handle_dri_ioctl` (renderD128 surface, snapshot lines 623–1141)
   and `handle_dri_card_ioctl` (card0/KMS surface, snapshot lines
   1143–1405). These reference `Process::dri_handles` and
   `DriOfdState` / `KmsFdState` on the OFD — neither exists on
   upstream. Pragmatic path:
   - First pass: stub `DRM_IOCTL_VERSION` (returns "wpk" driver
     name + date + desc) and `DRM_IOCTL_GET_CAP` (returns 0 for
     unknown caps) inline in `sys_ioctl`, so libdrm's `drmOpen()`
     and version probe succeed. Everything else returns ENOSYS.
     This unblocks the modeset binary at least to the point of
     creating a bo.
   - Second pass: port `Process::dri_handles: BTreeMap<u32, BoId>`
     and the OFD-level `DriFdState` / `KmsFdState` from snapshot
     (`crates/kernel/src/ofd.rs`, snapshot lines ~250–360); then
     port the full ioctl handlers and call into `HostIO::gbm_bo_*`
     / `HostIO::kms_*`.
4. **`devfs.rs`**: `match_devfs_dir` should report `/dev/dri` as a
   directory entry (so `ls /dev` shows it), and `getdents64` on
   `/dev/dri` should list `card0` and `renderD128`. See snapshot's
   `crates/kernel/src/devfs.rs` for the additions.
5. **`ofd.rs`**: port `DriFdState`, `KmsFdState`, and the
   `DriOfdState` enum that consolidates per-fd DRI state. Snapshot
   lines ~120–290.
6. **`fork.rs` / `process.rs` / `process_table.rs`**: clone
   `dri_handles` on fork, drop on exit/exec, drop master on final
   close. **Asyncify is gone** — the snapshot's fork-side rewind of
   DRI state is irrelevant; the new `wasm-fork-instrument` path
   serializes via `wpk_fork_*` exports. Read
   `docs/fork-instrumentation.md` before touching anything in this
   area.
7. **`wasm_api.rs`**: add kernel exports `kernel_vblank`,
   `kernel_kms_commit_count`, `kernel_kms_last_frame_us`. Snapshot
   has them at lines ~700–900.
8. **`memory.rs`**: mmap on a `DriFdState` OFD should call into
   `HostIO::gbm_bo_bind` rather than allocating anon pages.
9. **`procfs.rs`**: snapshot exposes per-process DRI handle count
   under `/proc/self/fdinfo/<fd>` — port if time permits.

### Host TypeScript side

10. **`host/src/kernel.ts`**: wire `host_kms_*` + `host_gl_*` +
    `host_proc_read_bytes` / `host_proc_write_bytes` imports. The
    snapshot routes through `KmsRegistry` (already copied to
    `host/src/dri/kms-registry.ts`). Need to also add `host_kms_mode_info`
    with `BigInt` return-tuple typing (the snapshot's
    `5e701f06b host(dri): fix BigInt typing` commit captures the
    correct shape).
11. **`host/src/kernel-worker.ts`**: add vblank pump (
    `tickVblank()` runs on a `setInterval(16.67ms)`), call
    `kernel_vblank()` export, drain pending flips via the canonical
    SAB, blit bound fb to an `OffscreenCanvas` presenter. Compositor
    predicate in `SubmitQueue` already exists upstream — switch the
    hardcoded `COMPOSITOR_PRI` to `kms.isMasterPid` (snapshot commit
    `88e578aea`).
12. **`host/src/{node,browser}-kernel-host.ts`**: add
    `kmsAttachCanvas()` / `kmsAttachStats()` methods that forward
    `OffscreenCanvas` + stats SAB to the worker via
    `postMessage({type:"kms_attach_canvas", canvas, stats})`. The
    worker-entry counterparts in
    `host/src/{node,browser}-kernel-worker-entry.ts` must register the
    handler **on `handleSpawn`, `handleFork`, AND `handleExec`** —
    CLAUDE.md §"Two hosts" §"PR #410" is the canonical warning
    about forgetting `handleExec`.
13. **`host/src/{node,browser}-kernel-protocol.ts`**: add the new
    message-type union members.

### Demo + UI

14. **Kandelo React UI pane** for the modeset/fluid-sim demo. The
    legacy `apps/browser-demos/pages/modeset/{index.html, main.ts}`
    page is the wrong shape for current kandelo — those pages were
    standalone Vite entries; the new browser-demos pages
    (`benchmark`, `git-test`, `kandelo`, `mariadb-test`, `network`,
    `sqlite-test`, `test-runner`) are mostly redirects or test
    harnesses, and the **real** Kandelo UI lives under
    `apps/browser-demos/lib/app/` (App.tsx, Sidebar.tsx,
    `apps/browser-demos/lib/app/panes/`). The pane to add: a Pavel
    fluid-sim viewer that spawns `modeset.wasm` and shows the live
    canvas (OffscreenCanvas transferred from the kernel worker)
    plus the KMS stats grid (`commits`, `last_frame_us`,
    `width`x`height`). Inspect existing panes (e.g. `Framebuffer.tsx`)
    for the pattern.
15. **Playwright spec** under the kandelo browser-demo test tree
    (snapshot has it at `apps/browser-demos/test/modeset.spec.ts` but
    the test infra has shifted — find where `pages/network` or
    `pages/sqlite-test` tests live and follow that pattern).

### Test gates (CLAUDE.md)

16. `cargo test -p kandelo --target aarch64-apple-darwin --lib` →
    must pass (currently does, but the new ioctl/devfs/ofd code will
    need its own tests).
17. `cd host && npx vitest run` → must pass (currently DRI tests
    don't even import — they reference APIs not yet present on
    upstream's kernel.ts/kernel-worker.ts).
18. `scripts/run-libc-tests.sh` → must pass with 0 unexpected FAIL.
    DRI work shouldn't regress libc surface, but the musl-overlay
    header additions might break a compile somewhere; investigate
    any new FAILs.
19. `scripts/run-posix-tests.sh` → must pass with 0 FAIL.
20. `bash scripts/check-abi-version.sh` → must exit 0. After all
    the kernel additions, the ABI snapshot will have new exports
    (`kernel_vblank` etc.) and new ioctl-number constants — these
    are **additive-only** so no `ABI_VERSION` bump should be needed.
    Regenerate with `bash scripts/check-abi-version.sh update`,
    inspect the diff, commit alongside source.

### PR mechanics

21. Branch needs to be pushed to `mho22/wasm-posix-kernel` (NOT to
    Automattic/kandelo — that's reserved for upstream maintainers
    pushing branches). Then `gh pr create --repo Automattic/kandelo
    --base main --head mho22:dri-kandelo …`.
22. PR body should call out:
    - The replaced 6-PR stack from the old fork.
    - Dual-host parity table (CLAUDE.md §"Two hosts").
    - Test-gate results.
    - That `ABI_VERSION` did NOT bump (additive only).
    - That the legacy `modeset` standalone page was DROPPED in
      favor of the Kandelo React UI pane.

## Useful pre-computed reference points

- `git diff f9c17d13cc dri-kms-kernel-snapshot -- <file>` — DRI
  delta vs the PR's nominal base (works even though
  `f9c17d13c` is not an ancestor of HEAD, because it's a tree-diff).
- `git show dri-kms-kernel-snapshot:<path>` — read snapshot files
  without checking out.
- Snapshot `crates/kernel/src/syscalls.rs` saved to
  `/tmp/snapshot-syscalls.rs` during this session (gone after
  reboot).
- Key snapshot line ranges (in `dri-kms-kernel-snapshot`):
  - `shared/src/lib.rs:1165–1365` — `pub mod gl`
  - `shared/src/lib.rs:1388–1788` — `pub mod dri`
  - `shared/src/lib.rs:1790–1908` — `dri_tests`
  - `kernel/src/syscalls.rs:623–1141` — `handle_dri_ioctl`
  - `kernel/src/syscalls.rs:1143–1405` — `handle_dri_card_ioctl`
  - `kernel/src/process.rs:25–327` — `HostIO` trait (with DRI block
    around lines 175–326)

## Important constraints, do not violate

- **One PR.** Multiple commits in the branch is fine, but only one
  PR against `Automattic/kandelo`.
- **All five test gates green.** No partial-pass push.
- **Dual-host parity.** Every `host/src/kernel.ts` change has a
  matching change on both `node-kernel-worker-entry.ts` AND
  `browser-kernel-worker-entry.ts` (including `handleExec`, see
  CLAUDE.md §"Two hosts").
- **No Asyncify, anywhere.** Even if the snapshot has it, drop it.
- **Use the Kandelo React UI pane, not a legacy standalone page.**
- **Ask user before any destructive git operation** (force-push,
  reset --hard, branch delete) — the user is a kandelo maintainer
  and a wrong push affects shared state.
