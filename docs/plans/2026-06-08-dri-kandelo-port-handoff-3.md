# DRI port onto kandelo:main — session 3 handoff

Continuation of [2026-06-08-dri-kandelo-port-handoff-2.md](./2026-06-08-dri-kandelo-port-handoff-2.md). Read that first — this doc only covers what changed in session 3.

## Goal (unchanged)

Land the entire DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. Replace the legacy standalone `apps/browser-demos/pages/modeset/` page with a **Kandelo React UI pane** that hosts the Pavel fluid-sim demo. All five test gates from CLAUDE.md must pass before opening the PR.

## Branch policy (unchanged — correction from v1 still stands)

The PR branch lives **entirely on `Automattic/kandelo`**, NOT on `mho22/wasm-posix-kernel`. See [memory/dri_port_branch_target.md](../../../../../.claude/projects/-Users-mho-Work-Projects-kandelo-wasm-posix-kernel/memory/dri_port_branch_target.md).

When ready: `git push upstream explore-direct-rendering-infrastructure` then `gh pr create --repo Automattic/kandelo --base main --head explore-direct-rendering-infrastructure …` (no `mho22:` fork prefix).

## Branch state at end of session 3

- Working branch: `explore-direct-rendering-infrastructure`.
- One new commit landed in this session, local only:

```
50d7934b9 kernel(dri): wire mmap → gbm_bo_bind + fork/exec inheritance of DriOfdState   ← session-3 tip
5fda79a90 kernel(dri): wire KMS card0 ioctls (master, modeset, page-flip, vblank)
78c464bde kernel(dri): wire PRIME_HANDLE_TO_FD / PRIME_FD_TO_HANDLE + close release
ecc8ceaa3 kernel(dri): wire dumb-buffer ioctls + DriOfdState install on open
2fa533577 kernel(dri): port DriOfdState / DriFdState / KmsFdState scaffold
9575d7824 kernel(dri): wire /dev/dri/{card0,renderD128} probe surface
2bffcfeb5 docs(dri): session handoff for dri-kandelo port
b25ef5942 dri+wpk: bring forward DRI/WebGL surface against kandelo:main
87b410b72 chore: pin third-party GitHub Actions to commit SHAs (#613) ← upstream/main
```

- **NOT pushed.** All six commits are local to the worktree. Push to `upstream` (= `Automattic/kandelo`) when ready.
- Working tree is clean for the kernel files. Pre-existing submodule pointer drift on `libc/musl` and `tests/sortix/os-test` (untouched this session) plus untracked artifacts under `apps/browser-demos/test-results/`, `packages/registry/openssl/src/tls/`, and the `docs/plans/2026-0[567]-*` future-plan docs that arrived in the worktree before session 3.

## What landed this session (1 commit, all kernel-side)

### `50d7934b9` — Commit 6: mmap → `gbm_bo_bind` + fork/exec inheritance of DriOfdState

**Part A — mmap on a DRI fd binds the bo in the process's wasm memory:**

- `crates/kernel/src/process.rs`: new `DriBoBinding { addr, len, bo_id }` and `Process::dri_bindings: Vec<DriBoBinding>`. Mirrors the `fb_binding` slot for `/dev/fb0`.
- `sys_mmap`: a third branch after the Fb0 path. If the OFD's `dri_state` is `RenderNode` or `Card`, decode `(offset >> 12) as BoId`, validate the bo is live in `dri::bo`'s registry and is `CpuShared` (GPU-tier bos reject with `EINVAL`), page-align the requested length (libgbm rounds up to 64 KiB; the kernel mirrors that here so the lengths match), allocate wasm pages via `mmap_anonymous`, then call `HostIO::gbm_bo_bind(pid, bo_id, addr, len)`. On host-side failure the wasm pages get rolled back via `munmap` and ENOMEM bubbles up — no half-bound state.
- `sys_munmap`: drops every `DriBoBinding` fully covered by `[addr, addr+len)` and asks the host to `gbm_bo_unbind(pid, bo_id, addr, len)` before the wasm pages return to the anonymous pool. Mirrors fb teardown.
- `MockHostIO` grew `gbm_bo_bind_calls` / `gbm_bo_unbind_calls` Vecs and a configurable `gbm_bo_bind_rc` so the new tests can assert host invocations + rollback edges. The change is contained — other tests didn't need updating.

**Part B — fork (and exec) inheritance of `DriOfdState`:**

- `crates/kernel/src/fork.rs`: `FORK_VERSION` bumped 8 → 9. **This is a strict-version field**, see `version != FORK_VERSION { return Err(Errno::EINVAL) }` in both `deserialize_fork_state` and `deserialize_exec_state`. Bumping required because the per-OFD record gained a new mandatory byte (the variant tag).
- New helpers `write_dri_state` / `read_dri_state` (plus `write_dri_fd_state` / `read_dri_fd_state` / `write_kms_fd_state` / `read_kms_fd_state`). Wire format:
  - One-byte variant tag: `0 = None`, `1 = RenderNode`, `2 = Card`, `3 = PrimeBo`.
  - `DriFdState` payload: `u32 handle_count`, then `(u32 handle, u32 bo_id)` × count, then `u32 next_handle`. `gl: Option<GlState>` is **not** serialized (scaffold-only per commit 2's notes; child gets `None`).
  - `KmsFdState` payload: `u8 holds_master` (only true on the exec path, see below), `u32 fb_count`, then `(fb_id, bo_id, width, height, pixel_format, stride)` × count, `u32 next_fb_id`, `u32 pending_count`, then `(crtc_id, fb_id, user_data)` × count. `event_ring` is **not** serialized (child can't drain parent's pending events; it gets an empty `VecDeque`).
  - `PrimeBoState` payload: `u32 bo_id`, `u64 cookie`.
- Bo refcount accounting on **deserialize**: every BoId restored on a handle, fb, or PrimeBo gets a `with_registry(|r| r.incref(_))`. The parent's already-counted refs balance with its own close-path decref; the child's own close-path decrefs the increfs added here. **Do not move the increfs to the serialize side** — the fork path runs `serialize → deserialize` sequentially within one kernel and either side works, but the deserialize side is the one that "knows" the new process exists, so failure-rollback localizes there.
- `serialize_fork_state` calls `write_dri_state(_, _, preserve_master=false)`. Fork **always** clears `holds_master` in the child: master is a global singleton (`crate::dri::master`) and the child must `SET_MASTER` itself.
- `serialize_exec_state` calls `write_dri_state(_, _, preserve_master=true)`. Exec keeps process identity, so an inherited card0 OFD legitimately retains its KMS lease across the image swap.
- `dri_bindings` is **not** inherited: child gets `Vec::new()`. The child's wasm memory is a fresh region the host has not been told about; the child must re-mmap to re-establish bindings. Same mental model as `fb_binding`.

**Test gate state at commit time:**

- Kernel unit tests: 918 → **929 passing** (+11 new — 6 mmap, 5 fork/exec). 0 failed.
- Other gates not re-run after Commit 6 (kernel-side changes don't touch them, but ABI snapshot needs regen — see "Still pending" below).

## What's NOT done — the remaining commits before PR

Numbered by the planned landing order. Each is a self-contained commit.

### **Commit 7 (host TS): `kernel.ts` host-import wiring** — NOT STARTED

- `host/src/kernel.ts`: add wasm imports the kernel now calls — `host_gbm_bo_*`, `host_kms_*`, `host_gl_*`, `host_proc_read_bytes`, `host_proc_write_bytes`. The snapshot (`dri-kms-kernel-snapshot` ≅ `14026af9`) has them wired in `host/src/kernel.ts` around lines 580–870.
- **Snapshot dependencies**: the snapshot's imports refer to `this.bos`, `this.gl`, `this.kms`, `this.gl_submit_queue`, `this.gl_muxers`, `this.foreignTextures`, plus a new `getProcessMemory?: (pid: number) => WebAssembly.Memory` callback hung off `KernelCallbacks`. The first four are instances of types already copied to `host/src/dri/{registry,kms-registry}.ts` and `host/src/webgl/*` — but **not yet wired**. The constructor needs to instantiate them, the `KernelCallbacks` interface needs `getProcessMemory`, and the embedder (node/browser kernel-host) needs to thread that callback through.
- Read the snapshot wholesale before porting (`git show dri-kms-kernel-snapshot:host/src/kernel.ts | sed -n '580,870p'` is the relevant range). The Pavel fluid-sim demo (`programs/modeset.c`) uses GLES2 — it imports `<EGL/egl.h>` and `<GLES2/gl2.h>` — so the full GL surface IS needed, you can't scope down to KMS-only.

### **Commit 8 (host TS): `kernel-worker.ts` vblank pump + presenter + DRI/WebGL wire-up** — NOT STARTED

- vblank pump (`setInterval(16.67ms)` → `kernel_vblank()` export), drain pending flips, blit bound fb to an `OffscreenCanvas` presenter.
- Switch `SubmitQueue`'s hardcoded `COMPOSITOR_PRI` to `kms.isMasterPid` (snapshot commit `88e578aea`).
- Wire `host/src/dri/*` and `host/src/webgl/*` (already copied wholesale in `b25ef5942`) into the upstream `kernel-worker.ts` shape.

### **Commit 9 (host TS, dual-host parity): host adapter + worker-entry + protocol** — NOT STARTED

- `host/src/{node,browser}-kernel-host.ts`: `kmsAttachCanvas(canvas, stats)` + `kmsAttachStats(statsSab)` forwarding via `postMessage({type:"kms_attach_canvas", canvas, stats})`.
- `host/src/{node,browser}-kernel-worker-entry.ts`: register the handler on `handleSpawn`, `handleFork`, **AND `handleExec`**. CLAUDE.md §"Two hosts" §"PR #410" is the canonical warning about forgetting `handleExec`.
- `host/src/{node,browser}-kernel-protocol.ts`: extend the message-type union.
- **Both hosts in the SAME commit.**

### **Then Demo + UI (Commit 10) — the stopping line Brandon set**

- Kandelo React UI pane under `apps/browser-demos/lib/app/panes/` (look at `Framebuffer.tsx` for the pattern). Spawns `modeset.wasm`, shows `OffscreenCanvas` + KMS stats grid (`commits`, `last_frame_us`, `width × height`).
- The legacy `apps/browser-demos/pages/modeset/` standalone page is the wrong shape and gets dropped.

### **Commit 11: Playwright spec** — NOT STARTED

- Inspect where `pages/network` or `pages/sqlite-test` Playwright specs live in the current tree and follow that pattern.

### **Commit 12 (closing): ABI snapshot regen + docs** — NOT STARTED

- `bash scripts/check-abi-version.sh update`, inspect `abi/snapshot.json` diff. The new kernel exports (`kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`) are additive-only per CLAUDE.md so **no `ABI_VERSION` bump should be needed**. The FORK_VERSION bump (8 → 9) is internal to fork.rs and not part of the structural ABI snapshot.
- Docs: `architecture.md`, `posix-status.md`, `porting-guide.md`, `browser-support.md`, `README.md` per CLAUDE.md.

## Test gate state at session end

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **929 passing**, 0 failed (918 prior + 11 new) | Run after Commit 6; clean |
| `cargo test -p wasm-posix-shared` | ❓ Not re-run this session | No shared crate changes; should still be 19/19 |
| `cd host && npx vitest run` | ❓ Not run | No host TS changes this session, but the new DRI test files copied in `b25ef5942` still import APIs that don't exist yet and will fail. Investigate before claiming green |
| `scripts/run-libc-tests.sh` | ❓ Not run | |
| `scripts/run-posix-tests.sh` | ❓ Not run | |
| `bash scripts/check-abi-version.sh` | ❓ Not run | Will need `update` after Commits 7–9 since the kernel-wasm import shape may shift if any of those add new declared imports (none expected, but verify) |

## Gotchas discovered this session — read before touching the same areas

- **`FORK_VERSION` is checked strictly.** Both `deserialize_fork_state` (`fork.rs:705`-ish post-edit) and `deserialize_exec_state` (`fork.rs:1310`-ish post-edit) reject any version mismatch with `EINVAL`. The current value is 9. If you add another field to the OFD record (e.g. procfs fdinfo data), either bump again or use the "if remaining ≥ N" forward-compat pattern that the existing v5 mmap-mappings / v8 socket sections use further down.
- **`read_dri_fd_state` / `read_kms_fd_state` incref on the deserialize side** — every `BoId` we restore gets an extra `with_registry(|r| r.incref(_))`. If you later add a code path that calls these helpers from somewhere other than fork/exec deserialize, that incref is going to be wrong. Best fix: rename them to `…_inheriting` to make the side-effect explicit, or factor the incref out of the helpers.
- **`gbm_bo_bind_rc = -(Errno::ENOMEM as i32)` test pattern**: the test for rollback when the host fails uses `MockHostIO::gbm_bo_bind_rc` to inject the failure. Setting it on a fresh MockHostIO right after `MockHostIO::new()` works because it's a plain field with default 0 (= success). New tests of host-failure rollback in this area should follow the same pattern rather than building a new mock.
- **`crate::dri::with_registry` is NOT re-entrant** (still — same gotcha from session 2). Don't call `next_id_for_test()` or other registry methods from inside another `with_registry` closure. Compute the BoId before entering the closure.
- **Process::dri_bindings is NOT inherited on fork/exec.** Mirrored from `fb_binding: None`. If you ever want to inherit them (so a child can see the parent's bo content without re-mmap), you'd need to (a) serialize the bindings into the fork buffer, (b) on deserialize, call `host.gbm_bo_bind(child_pid, …)` for each — but the child's wasm Memory is a fresh allocation so the addrs need re-binding too. Practically nobody needs this — fork+exec immediately is the common case — but mark it as a future enhancement if a test hits it.
- **Card variant `preserve_master` flag is the only asymmetry between fork-serialize and exec-serialize.** All other DRI state survives identically. Don't be tempted to special-case other fields per-mode unless there's a Linux-shape semantic difference.

## Reference points

- **Session 1 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff.md`.
- **Session 2 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-2.md`. Read both before this one.
- **Snapshot tag**: `dri-kms-kernel-snapshot` (≅ `14026af9`). `git show dri-kms-kernel-snapshot:<path>` reads snapshot files without checking out. Still the canonical source for the host TS work in Commits 7–9.
- **`crate::dri::master`**: the global master holder. `try_set_master(pid, ofd_idx) -> Result<(), EBUSY>`, `drop_master(pid, ofd_idx) -> bool`, `release_if_held(holds_master, pid, ofd_idx, host)`. Test-only: `lock_for_test()` and `current()`.
- **`crate::dri::bo`**: `with_registry`, `BoId`, `BoTier`, `GbmBo`, `PrimeCookie`. Test-only: `reset_registry`, `next_id_for_test`, `TEST_REGISTRY_LOCK`.

## Important constraints, do not violate

(Carried forward from v1+v2 handoffs, unchanged.)

- **One PR.** Multiple commits in the branch is fine, but only one PR against `Automattic/kandelo`.
- **All five test gates green.** No partial-pass push.
- **Dual-host parity.** Every `host/src/kernel.ts` change has a matching change on both `node-kernel-worker-entry.ts` AND `browser-kernel-worker-entry.ts` (including `handleExec`, see CLAUDE.md §"Two hosts").
- **No Asyncify, anywhere.** Even if the snapshot has it, drop it.
- **Use the Kandelo React UI pane, not a legacy standalone page.**
- **Ask user before any destructive git operation** (force-push, reset --hard, branch delete).
- **Push to `Automattic/kandelo` directly, NOT `mho22/wasm-posix-kernel`.**
