# DRI port onto kandelo:main — session 2 handoff

Continuation of [2026-06-08-dri-kandelo-port-handoff.md](./2026-06-08-dri-kandelo-port-handoff.md). Read that first — this doc only covers what changed in session 2.

## Goal (unchanged)

Land the entire DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. Replace the legacy standalone `apps/browser-demos/pages/modeset/` page with a **Kandelo React UI pane** that hosts the Pavel fluid-sim demo. All five test gates from CLAUDE.md must pass before opening the PR.

## **Branch policy — this is a correction to the v1 handoff**

The PR branch lives **entirely on `Automattic/kandelo`**, NOT on `mho22/wasm-posix-kernel`. The v1 handoff said "push to mho22" — Brandon says no, push directly to upstream. See [memory/dri_port_branch_target.md](../../../../../.claude/projects/-Users-mho-Work-Projects-kandelo-wasm-posix-kernel/memory/dri_port_branch_target.md).

When ready: `git push upstream explore-direct-rendering-infrastructure` then `gh pr create --repo Automattic/kandelo --base main --head explore-direct-rendering-infrastructure …` (no `mho22:` fork prefix).

## Branch state at end of session 2

- Working branch: `explore-direct-rendering-infrastructure` (created off `dri-kandelo` @ `2bffcfeb5` per Brandon's instruction; `dri-kandelo` retained as a backup pointer at the same SHA).
- Five new commits landed in this session, all local:

```
5fda79a90 kernel(dri): wire KMS card0 ioctls (master, modeset, page-flip, vblank)
78c464bde kernel(dri): wire PRIME_HANDLE_TO_FD / PRIME_FD_TO_HANDLE + close release
ecc8ceaa3 kernel(dri): wire dumb-buffer ioctls + DriOfdState install on open
2fa533577 kernel(dri): port DriOfdState / DriFdState / KmsFdState scaffold
9575d7824 kernel(dri): wire /dev/dri/{card0,renderD128} probe surface
2bffcfeb5 docs(dri): session handoff for dri-kandelo port      (← session-1 tip)
b25ef5942 dri+wpk: bring forward DRI/WebGL surface against kandelo:main
87b410b72 chore: pin third-party GitHub Actions to commit SHAs (#613) ← upstream/main
```

- **NOT pushed.** All five commits are local to the worktree. Push to `upstream` (= `Automattic/kandelo`) when Brandon greenlights.
- Working tree is clean as of session end.

## What landed this session (5 commits, all kernel-side)

Each is a self-contained, tests-passing slice. Combined: kernel unit tests went 881 → **918 passing**, 0 failures. `wasm-posix-shared` still 19/19.

### 1. `9575d7824` — probe surface

- Added `VirtualDevice::DriRenderD128` / `DriCard0` (`host_handle` sentinels -8 / -9, `ino()` 8 / 9). The variants ride the existing `match_virtual_device` → `sys_open` / `sys_openat` → CharDevice OFD pipeline; the single-owner claim branches (`Fb0` / `Mice` / `Dsp`) are explicit `if`-blocks so DRI is multi-process by design without any code change there.
- Added `handle_dri_ioctl(request, buf)` (first-pass signature, replaced in commit 3): `DRM_IOCTL_VERSION` → 1.0.0 + zero-length strings + echoed pointers; `DRM_IOCTL_GET_CAP` → `DUMB_BUFFER` = 1, `PRIME` = IMPORT|EXPORT, unknown = 0; everything else = `ENOSYS`. Wired alongside the Fb0/Dsp dispatchers in `sys_ioctl`.
- Read on a DRI device returns 0 like `Fb0` — the matching arm at `syscalls.rs:1506` was the original compile error from session 1.
- `crates/kernel/src/devfs.rs`: `DevfsEntry::DriDir`, `/dev/dri` listed under `/dev` Root, `getdents64` on `/dev/dri` lists `card0` + `renderD128` as `DT_CHR`.
- `crates/kernel/src/wasm_api.rs`: three new optional exports `kernel_vblank()`, `kernel_kms_commit_count(crtc)`, `kernel_kms_last_frame_us(crtc)`. **Not** in `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` so the manifest shape is unchanged.
- Test impact: `test_virtual_device_roundtrip` now iterates the two new variants, and the "first sentinel past range" assertion moved from `-8` to `-10`.

### 2. `2fa533577` — OFD scaffold

- `crates/kernel/src/ofd.rs`: added `CmdbufBinding`, `GlState`, `PrimeBoState`, `DriFdState`, `KmsFb`, `PendingFlip`, `KmsFdState`, `DriOfdState` (variants `PrimeBo` / `RenderNode` / `Card { dri, kms }`). `OpenFileDesc` gained `dri_state: Option<Box<DriOfdState>>` — boxed so non-DRI OFDs pay one pointer slot. Accessor helpers `dri()` / `dri_mut()` / `kms()` / `kms_mut()` / `prime_bo()` / `take_prime_bo()` route by variant.
- `OfdTable::iter_mut()` added (snapshot had it, needed for close-on-exec / exit cleanup paths).
- `crates/kernel/src/fork.rs`: both `OpenFileDesc` constructors in the fork serialization path pick up `dri_state: None`. Fork-time DRI state cloning is a **separate commit** alongside Process state — see "What's NOT done" below.
- `GlState` and `CmdbufBinding` are scaffold-only (no behavior in this commit). They sit in place for the GLES2 cmdbuf work that's not on the critical path to the modeset demo but exists in `crates/shared/src/gl` already.

### 3. `ecc8ceaa3` — dumb-buffer ioctls + open-installs-state

- `sys_open` / `sys_openat`: new helper `install_dri_state_on_open(proc, ofd_idx, dev)` runs unconditionally for any `match_virtual_device` hit — installs `RenderNode(DriFdState::default())` on renderD128, `Card { dri, kms }` on card0, no-op for everything else.
- `handle_dri_ioctl` refactored to take `(&mut Process, &mut dyn HostIO, ofd_idx, request, buf)`. New helpers `dri_state(proc, ofd_idx)` and `dri_state_mut(proc, ofd_idx)` borrow the per-fd `DriFdState` or return `EBADF`. `release_dri_handle(proc, host, ofd_idx, handle)` is the shared `DESTROY_DUMB` / `GEM_CLOSE` body (decref bo, host `gbm_bo_destroy` on last drop).
- Four new ioctls: `MODE_CREATE_DUMB` (registry alloc → `host.gbm_bo_create` → per-fd handle, three rollback edges); `MODE_MAP_DUMB` (returns `(BoId << 12)` as a stable page-aligned mmap offset — the mmap path decodes it back); `MODE_DESTROY_DUMB` + `GEM_CLOSE` (share `release_dri_handle`).
- **`sys_ioctl` signature changed** from `(proc, fd, request, buf)` → `(proc, host, fd, request, buf)`. This rippled to `kernel_ioctl` (`wasm_api.rs`) and **every test caller** (~30 sites). I used `replace_all` for `sys_ioctl(&mut proc, ` → `sys_ioctl(&mut proc, &mut host,`. Six tests didn't have `host` in scope and got an inline `let mut host = MockHostIO::new();`. The one multi-line `sys_ioctl(\n    &mut proc,\n    fd,\n    …)` call had to be edited by hand (`replace_all` doesn't span lines reliably).
- `MockHostIO`: override `gbm_bo_create` → 0 and `gbm_bo_destroy` → no-op so unit tests exercise the happy path. The default `HostIO` impl still returns `-ENOSYS` — production hosts (Node + Browser) must override.

### 4. `78c464bde` — PRIME ioctls + close-time release

- `PRIME_HANDLE_TO_FD`: look up bo by per-fd handle → `ensure_prime_cookie` (idempotent — re-export reuses) → `incref` the bo → allocate a fresh OFD with `host_handle = -200` (**outside** the `VirtualDevice` sentinel range -1..=-9 so it isn't mis-routed) and `DriOfdState::PrimeBo(PrimeBoState { bo_id, cookie })` → allocate fd with `FD_CLOEXEC` if `req.flags & O_CLOEXEC`. Path = `/dev/dri/prime-{bo_id}-{cookie:x}` for debug visibility.
- `PRIME_FD_TO_HANDLE`: look up target fd → clone its `PrimeBoState` → verify cookie still matches the bo's current cookie (`EACCES` on mismatch — Linux-shape "stale cookie" semantics) → `incref` → register fresh handle in the **destination** fd's namespace.
- Both paths handle rollback for every failure edge so the bo refcount stays consistent.
- `sys_close` got a DRI cleanup hook. The tricky bit: read `ofd.ref_count` BEFORE `dec_ref`; if `ref_count == 1` (this close will free the OFD), `take()` the `dri_state` so we own it. Otherwise leave it — dup-shared OFDs must keep their DRI state. After `dec_ref` returns true, `dri_release_ofd_state(pid, host, ofd_idx, taken)` runs.
- `dri_release_ofd_state` (introduced here, extended in commit 5): walks the `RenderNode`/`Card` handle map decref'ing each bo, or unwraps `PrimeBo` and decrefs once. Last drop fires `host.gbm_bo_destroy`.
- `crates/kernel/src/dri/bo.rs`: `reset_registry` and a new `next_id_for_test() -> BoId` are now `pub(crate)`. Tests use the latter to identify the most recently allocated bo (ioctls return a per-fd handle, not the global BoId). **Gotcha:** never call `next_id_for_test()` from inside a `with_registry(|r| …)` closure — `with_registry` is `UnsafeCell`-based with no locking; reentrance is UB. Compute `bo_id` BEFORE entering the closure. I hit this and learned it.

### 5. `5fda79a90` — KMS card0 surface (the biggest commit)

- Split the ioctl dispatch: card0 → new `handle_dri_card_ioctl`, which falls through to `handle_dri_ioctl` for shared ioctls. renderD128 still routes to `handle_dri_ioctl` directly. New helpers `kms_state(proc, ofd_idx)` / `kms_state_mut(proc, ofd_idx)`.
- Wired ioctls (all from the snapshot, mechanical port): `SET_MASTER` / `DROP_MASTER` (global single-master via `crate::dri::master`, sets `KmsFdState::holds_master`); `MODE_GETRESOURCES` (1 crtc / 1 connector / 1 encoder, dim 1..16384, writes ids out via `HostIO::proc_write_bytes` — `EFAULT` on write failure); `MODE_GETCRTC` / `MODE_GETENCODER` / `MODE_GETCONNECTOR` (id-must-be-1 or `ENOENT`; connector reports `VIRTUAL` + `CONNECTED` + `host.kms_mode_info(1)`); `MODE_ADDFB2` (validates pixel format ∈ {ARGB8888, XRGB8888, RGB565}, enforces stride==bo stride for `CpuShared` bos, registers per-fd `fb_id`, bumps bo refcount, `host.kms_addfb`, rollback on host fail); `MODE_RMFB` (drops fb slot, decrefs bo, `host.kms_rmfb`); `MODE_SETCRTC` (master-gated `EACCES` otherwise, crtc must be 1, fb_id 0 or registered); `MODE_PAGE_FLIP` (same gates + `EBUSY` if pending, bumps `dri::record_kms_commit` so `kernel_kms_commit_count` ticks); `WAIT_VBLANK` (best-effort reply, full handshake deferred to the host pump commit).
- `dri_release_ofd_state` extended for `Card`: drops every fb (each held an extra refcount + needs a `host.kms_rmfb`), then `dri::master::release_if_held(holds_master, pid, ofd_idx, host)`, then the GEM handle namespace. The new `ofd_idx` parameter is so the master release can match `(pid, ofd_idx)` — a non-matching release is a no-op (the global master holder is a different OFD).
- Old test `dri_ioctl_unknown_returns_enosys` rewritten — `MODE_GETRESOURCES` is now implemented, so the assertion uses `0xdead_beef` instead.

## Test gate state at session end

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **918 passing**, 0 failed (881 prior + 37 new DRI/KMS tests) | Run after every commit; clean across all five |
| `cargo test -p wasm-posix-shared` | ✅ 19/19 passing | Run once mid-session, unchanged this session |
| `cd host && npx vitest run` | ❓ Not run | Host TS untouched this session; should still pass but the new DRI test files copied in `b25ef5942` import APIs that don't exist yet and will fail. Investigate before claiming green |
| `scripts/run-libc-tests.sh` | ❓ Not run | Headers added in `b25ef5942` may break a compile; investigate |
| `scripts/run-posix-tests.sh` | ❓ Not run | |
| `bash scripts/check-abi-version.sh` | ❓ Not run | Snapshot needs regen — new exports (`kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`) appear in the wasm. Per CLAUDE.md these are additive-only so no `ABI_VERSION` bump should be needed |

**Brandon's commit-1 doc requirement is not yet met.** CLAUDE.md says new user-facing features need docs updates (`architecture.md`, `posix-status.md`, `porting-guide.md`, `browser-support.md`, `README.md`). The DRI port adds a major surface — the docs commit can land bundled with the ABI snapshot regen at the tail.

## What's NOT done — the remaining commits before Demo+UI

Numbered in the planned landing order. Each is a self-contained commit. Estimates from session 2 actuals: kernel commits each took ~250-700 net LoC of editing including tests; host TS commits will be at least the same.

### **Commit 6 (kernel): mmap on DRI fd → `gbm_bo_bind` + fork inheritance + procfs**

- `crates/kernel/src/memory.rs`: when `mmap` is called on a fd whose OFD has `DriOfdState::RenderNode` or `Card`, decode `offset >> 12` as a `BoId` (the encoding `MODE_MAP_DUMB` set up). Reserve wasm pages via the existing `mmap_anonymous` path, then call `HostIO::gbm_bo_bind(pid, bo_id, addr, len)` to point the wasm region at the bo's SAB slice. `munmap` → `gbm_bo_unbind`. Look for existing mmap logic — `host_handle == VirtualDevice::Fb0.host_handle()` is the pattern to mirror.
- **Fork inheritance**: when fork-instrument copies the OFD table to the child, the child gets a `dri_state: None` today (set in commit 2 to keep fork compiling). The right behavior: clone the `DriOfdState`, and for every `BoId` in `handles` / `fbs` / `PrimeBo` call `crate::dri::with_registry(|r| r.incref(bo_id))` so the parent and child both see live bos. The Card variant's `holds_master` flag should be cleared in the child (master is a singleton — only one process can hold it). Touch `crates/kernel/src/fork.rs` around the `OpenFileDesc` deserialization, plus possibly `crates/kernel/src/fork-instrument/` runtime hooks. **Read `docs/fork-instrumentation.md` first** — the v1 handoff explicitly flags this as the area where Asyncify thinking misleads.
- `crates/kernel/src/procfs.rs` (optional this commit): expose per-fd handle counts under `/proc/self/fdinfo/<fd>` for `RenderNode` / `Card` OFDs. Snapshot has the format. Punt if it's expanding scope.

### **Commit 7 (host TS): `kernel.ts` host-import wiring**

- `host/src/kernel.ts`: add the wasm imports the kernel now reads at runtime — `host_kms_set_master(pid)`, `host_kms_drop_master(pid)`, `host_kms_mode_info(connector_id) → BigInt tuple`, `host_kms_addfb(...) → i32`, `host_kms_rmfb(pid, fb_id)`, `host_kms_set_fb(pid, crtc_id, fb_id)`, `host_gbm_bo_create(pid, bo_id, size, w, h, stride) → i32`, `host_gbm_bo_create_gpu(...)`, `host_gbm_bo_destroy`, `host_gbm_bo_bind`, `host_gbm_bo_unbind`, `host_gl_*` (the full set from `process.rs` HostIO trait), `host_proc_read_bytes(pid, addr, len) → bytes`, `host_proc_write_bytes(pid, addr, bytes) → i32`.
- The snapshot routes these through `KmsRegistry` — already copied to `host/src/dri/kms-registry.ts`. The `host_kms_mode_info` typing is BigInt-tuple-returning; see snapshot commit `5e701f06b host(dri): fix BigInt typing` for the correct shape.

### **Commit 8 (host TS): `kernel-worker.ts` vblank pump + presenter + DRI/WebGL wire-up**

- `host/src/kernel-worker.ts`: vblank pump (`setInterval(16.67ms)` calls `kernel_vblank()`), drain pending flips via the canonical SAB, blit bound fb to an `OffscreenCanvas` presenter.
- The compositor priority predicate in `SubmitQueue` — switch the hardcoded `COMPOSITOR_PRI` to `kms.isMasterPid` (snapshot commit `88e578aea`).
- Wire `host/src/dri/*` (already copied: `kms-registry.ts`, `registry.ts`) and `host/src/webgl/*` (already copied: bridge, index, main-forward, muxer, ops, query, registry, shadow, submit-drain, submit-queue) — these were copied wholesale in `b25ef5942` but not wired into `kernel-worker.ts`. Adapt to upstream's evolved `kernel-worker.ts` shape.

### **Commit 9 (host TS, dual-host parity): host adapter + worker-entry + protocol**

- `host/src/{node,browser}-kernel-host.ts`: `kmsAttachCanvas(canvas, stats)` + `kmsAttachStats(statsSab)` methods that forward `OffscreenCanvas` + stats SAB to the worker via `postMessage({type:"kms_attach_canvas", canvas, stats})`.
- `host/src/{node,browser}-kernel-worker-entry.ts`: register the handler on `handleSpawn`, `handleFork`, **AND `handleExec`**. CLAUDE.md §"Two hosts" §"PR #410" is the canonical warning about forgetting `handleExec`.
- `host/src/{node,browser}-kernel-protocol.ts`: add the new message-type union members.
- **Both hosts in the SAME commit.** Per CLAUDE.md, never land a Node-only host change with a "follow-up" note for browser. Verify with `grep -rn "<symbol>" host/ apps/browser-demos/` for each callsite.

### **Then Demo + UI (the stopping line Brandon set)**

This is where session 2 was supposed to stop. Subsequent session(s):

- Commit 10: Kandelo React UI pane for Pavel fluid-sim demo. Replaces legacy `apps/browser-demos/pages/modeset/` (which is the wrong shape for current Kandelo). New pane lives under `apps/browser-demos/lib/app/panes/`. Spawns `modeset.wasm`, shows the `OffscreenCanvas` + KMS stats grid (`commits`, `last_frame_us`, `width × height`). Inspect existing panes (e.g. `Framebuffer.tsx`) for the pattern.
- Commit 11: Playwright spec — find where `pages/network` or `pages/sqlite-test` tests live and follow that pattern.
- Commit 12 (closing): ABI snapshot regen + docs (`architecture.md`, `posix-status.md`, `porting-guide.md`, `browser-support.md`, `README.md`). Optionally fixups discovered from the 5 test gates.
- PR mechanics: `git push upstream explore-direct-rendering-infrastructure` then `gh pr create --repo Automattic/kandelo --base main --head explore-direct-rendering-infrastructure ...`. Per the v1 handoff, the PR body should call out the replaced 6-PR stack, the dual-host parity table, the test-gate results, the additive-only ABI claim, and that the legacy `modeset` standalone page was dropped.

## Gotchas discovered this session — read before touching the same areas

- **`sys_ioctl` signature changed.** Any future code reading or writing `sys_ioctl` needs `(proc, host, fd, request, buf)` not `(proc, fd, request, buf)`. The tests adapt automatically only because `replace_all` covered them; new test callers must include `&mut host`. Six existing tests had to get an inline `let mut host = MockHostIO::new();` because they didn't have one in scope.
- **`with_registry` is not re-entrant.** `crate::dri::with_registry(|r| …)` operates on an `UnsafeCell` — no locking, no test serialization in the closure itself (the `TEST_REGISTRY_LOCK` is at the test-fn boundary). Calling `crate::dri::bo::next_id_for_test()` from inside another `with_registry` closure creates two `&mut` references to the same data: UB. I learned this the hard way; the pattern is "compute the `BoId` *before* the `with_registry` call":
  ```rust
  let bo_id = crate::dri::bo::next_id_for_test() - 1;
  let alive = crate::dri::with_registry(|r| r.get(bo_id).is_some());
  ```
- **`MockHostIO`'s default `kms_addfb` returns 0 and `proc_write_bytes` returns 0** — that's success in both cases, so KMS tests get a happy path without needing to override. Production hosts will need real implementations.
- **DRI is multi-process; do NOT add a single-owner claim.** This is by design — the `sys_open` / `sys_openat` blocks at `syscalls.rs:758-766` deliberately list only `Fb0` / `Mice` / `Dsp` for `acquire_*_or_busy`. Adding `DriRenderD128` or `DriCard0` there breaks the compositor model.
- **`OpenFileDesc` has new fields.** Any code that constructs `OpenFileDesc { … }` literally (vs. `OfdTable::create`) needs `dri_state: None`. The two existing sites are in `fork.rs:658` and `fork.rs:1257`; both already updated, but watch for new ones in upstream merges.
- **The vblank stats counter is best-effort.** `MODE_PAGE_FLIP` will skip the `dri::record_kms_commit` call if `host.host_clock_gettime` fails. Don't add an `?` operator there — the flip should still queue. This is in the snapshot too; not a bug.
- **`take_prime_bo()` is idempotent** but the sys_close path doesn't currently use it. The close path snapshots `ofd.dri_state.take()` directly, gated on `ref_count == 1`. If you later add an exit-time cleanup loop (which the v1 handoff item 6 mentions for fork inheritance), use the same `ref_count == 1` predicate or you'll double-release on dup-shared OFDs.

## Reference points

- **Session 1 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff.md`. Read it before this one; the file paths and snapshot line ranges there are still authoritative.
- **Snapshot tag**: `dri-kms-kernel-snapshot` (= `14026af9`). Still useful for porting the remaining ioctls and the host TS work. `git show dri-kms-kernel-snapshot:<path>` reads files without checkout.
- **Where the snapshot's host TS lives**: the v1 handoff §"What's already done" §"Host TS scaffold" line lists everything copied in `b25ef5942` already. The work in commits 7-9 is to *wire* these files into upstream's evolved kernel.ts / kernel-worker.ts shape — not to re-port from snapshot.
- **`crate::dri::master`**: the global master holder. `try_set_master(pid, ofd_idx) -> Result<(), EBUSY>`, `drop_master(pid, ofd_idx) -> bool`, `release_if_held(holds_master, pid, ofd_idx, host)`. Test-only: `lock_for_test()` and `current()`.

## Important constraints, do not violate

(Carried forward from v1 handoff, unchanged.)

- **One PR.** Multiple commits in the branch is fine, but only one PR against `Automattic/kandelo`.
- **All five test gates green.** No partial-pass push.
- **Dual-host parity.** Every `host/src/kernel.ts` change has a matching change on both `node-kernel-worker-entry.ts` AND `browser-kernel-worker-entry.ts` (including `handleExec`, see CLAUDE.md §"Two hosts").
- **No Asyncify, anywhere.** Even if the snapshot has it, drop it.
- **Use the Kandelo React UI pane, not a legacy standalone page.**
- **Ask user before any destructive git operation** (force-push, reset --hard, branch delete).
- **NEW: push to `Automattic/kandelo` directly, NOT `mho22/wasm-posix-kernel`.**
