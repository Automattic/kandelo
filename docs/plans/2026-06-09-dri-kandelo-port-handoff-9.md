# DRI port onto kandelo:main — session 9 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-8.md](./2026-06-09-dri-kandelo-port-handoff-8.md). Read that first — this doc only covers what changed in session 9.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle.

## Hard-won facts re-confirmed in session 9

- **`PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh bash -c '…'` is the only way the dev shell starts in this user's environment** (nix is not on the inherited PATH).
- **`cd host && npm run build` is mandatory after any `host/src/` edit** before running vitest — the worker thread loads from `host/dist/`. `bash build.sh` does this automatically as part of its pipeline.
- **`bash build.sh` rebuilds kernel.wasm + programs + host/dist + rootfs.vfs** in one go. Use it after kernel edits OR after an `ABI_VERSION` bump, otherwise vitest will see stale binaries.
- The ABI snapshot check runs as gate 5 of the test suite. It compares the regenerated snapshot vs `origin/main`. **Even purely additive runtime changes on this branch will trip it** if prior commits already changed something (e.g., removed an export) without bumping `ABI_VERSION`.

## Gauntlet state at end of session 9

Inside dev shell, with PATH prefix:

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **934/934** pass | + 5 new GLIO unit tests |
| `cd host && npx vitest run` (full suite) | ✅ **709 pass / 0 fail / 110 skipped** | `dri-cube-pyramid` flips green in 3.6s — see Diff D + the C-side trace below |
| `scripts/run-libc-tests.sh` | ⚠️ **13 FAIL** | All in `math/*` (acos/asin family) + `regression/*` (statvfs, strverscmp, syscall-sign-extend, uselocale-0, wcsncpy-read-overflow, wcsstr-false-negative). 21 XFAIL + 1 FLAKE-FAIL. **Almost certainly pre-existing on this branch — gates 3/4 were not run from handoff-7 onward.** Next session MUST triage by running against `origin/main`. |
| `scripts/run-posix-tests.sh` | ⚠️ **30 FAIL** | All in `sigset/*`, `sigsuspend/*`, `sigtimedwait/*`, `sigwaitinfo/*`, `strchr/strcpy/strftime/strlen/strncpy`, `time/1-1`. Same story — needs origin/main baseline. |
| `bash scripts/check-abi-version.sh` | ✅ clean | After Diff E (ABI_VERSION 14→15) + regenerated snapshot. |

The libc + POSIX failures share zero overlap with anything the DRI/GLIO/KMS work touches (no math, no signals, no string ops). Confidence they predate this branch's DRI commits is high but not yet verified.

## What landed in session 9 — STILL UNCOMMITTED

User paused before any commit. Everything below is in working-tree on top of handoff-7 + handoff-8 carry-forwards.

### Diff D — `crates/kernel/src/syscalls.rs` — full GLIO_* dispatch + cmdbuf mmap

Two changes in this file:

**1. `handle_dri_ioctl` (around line 657)** — `use wasm_posix_shared::gl;` added next to the existing `use wasm_posix_shared::dri::*;`, and 10 new arms inserted before `_ => Err(Errno::ENOSYS)` at line ~906:

| Arm | Buf shape | State transitions | Host call |
|---|---|---|---|
| `GLIO_INIT` | `&u32 client_version` | reject `!= gl::OP_VERSION` → ENOSYS; reject `gl.is_some()` → EBUSY; install `GlState { initialized: true, ..default }` | — |
| `GLIO_TERMINATE` | NULL | reject `gl.is_none()` → EINVAL; clear `gl` | `gl_unbind(pid)` |
| `GLIO_CREATE_CONTEXT` | `&GlContextAttrs` (16 B) | reject `client_version not in {2,3}`; reject `!initialized`; reject `context_id.is_some()` → EBUSY; assign `ctx_id=1` | `gl_create_context(pid, 1, attrs)` |
| `GLIO_DESTROY_CONTEXT` | NULL | reject `context_id.is_none()` → EINVAL; clear ctx + current | `gl_destroy_context(pid, ctx_id)` |
| `GLIO_CREATE_SURFACE` | `&GlSurfaceAttrs` (32 B) | reject `kind not in {DEFAULT, PBUFFER}`; reject `!initialized`; reject `surface_id.is_some()` → EBUSY; assign `surface_id=1` | `gl_create_surface(pid, 1, attrs)` |
| `GLIO_DESTROY_SURFACE` | NULL | reject `surface_id.is_none()` → EINVAL; clear surface + current | `gl_destroy_surface(pid, surface_id)` |
| `GLIO_MAKE_CURRENT` | NULL | reject ctx/surface unset → EINVAL; set `current=true` | `gl_make_current(pid, ctx_id, surface_id)` |
| `GLIO_SUBMIT` | `&GlSubmitInfo` (8 B) | reject cmdbuf unbound → EINVAL; reject `offset+length > cmdbuf.len` → EINVAL; bump `submit_seq` | `gl_submit(pid, offset, length)` |
| `GLIO_PRESENT` | NULL | reject `!initialized` → EINVAL | `gl_present(pid)` |
| `GLIO_QUERY` | `&GlQueryInfo` (24 B) | reject `out_buf_len > MAX_QUERY_OUT_LEN` → EINVAL; reject `!initialized` → EINVAL | `proc_read_bytes` → `gl_query` → `proc_write_bytes` |

All borrows scoped so `dri_state_mut(...)` releases before the host call. Buf is never read for NULL-pointer ioctls.

**2. `sys_mmap` renderD128 block (around line 5878)** — added a cmdbuf branch BEFORE the existing bo decode:

```rust
let needs_cmdbuf = offset == 0
    && ofd.dri()
        .and_then(|d| d.gl.as_ref())
        .map(|g| g.initialized && g.cmdbuf.is_none())
        .unwrap_or(false);
if needs_cmdbuf {
    if len != wasm_posix_shared::gl::CMDBUF_LEN { return Err(Errno::EINVAL); }
    let addr_out = proc.memory.mmap_anonymous(addr, len, prot, flags | MAP_ANONYMOUS);
    if addr_out == MAP_FAILED { return Err(Errno::ENOMEM); }
    // re-borrow OFD mutably and record CmdbufBinding { addr, len, submit_seq: 0 }
    host.gl_bind(pid, addr_out, len);
    return Ok(addr_out);
}
```

`offset == 0` is the cmdbuf indicator; bo mmaps always encode `bo_id >= 1` via `(bo_id << 12)`.

**3. Cargo unit tests** at end of `mod tests {}`:

- `glio_init_rejects_version_skew`
- `glio_init_accepts_matching_version_and_marks_initialized` (also EBUSY-on-double-init)
- `glio_create_context_assigns_id_and_rejects_double_create` (also DESTROY → re-create succeeds)
- `glio_submit_rejects_out_of_range_range` (also valid sub-range bumps `submit_seq`)
- `glio_cmdbuf_mmap_validates_length_and_records_binding` (also fallthrough EINVAL on double cmdbuf mmap)

### Diff E — ABI bump 14→15

Three files touched (one-liner each):

- `crates/shared/src/lib.rs`: `pub const ABI_VERSION: u32 = 15;`
- `host/src/generated/abi.ts`: `export const ABI_VERSION = 15 as const;` (regenerated)
- `libc/glue/abi_constants.h`: `#define WASM_POSIX_ABI_VERSION 15u` (regenerated)

Plus `abi/snapshot.json` fully regenerated.

Per CLAUDE.md policy the bump is required because the snapshot diff vs `origin/main` is NOT purely additive:

- **Added** kernel exports: `kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us` (from handoff-6/7 KMS work — present in source but the snapshot had never been regenerated).
- **Removed** kernel exports: `kernel_reserve_host_region`, `kernel_reserve_host_region_at` (from one of the early `kernel(dri):` commits on this branch).
- **Changed sections**: `host_adapter`, `process_memory_layout`.

These break-shape diffs all come from the 14 prior DRI commits on this branch, not from session 9. Session 9 is the first to actually run `check-abi-version.sh` since the DRI port started, so it's the first to surface them.

User answered the [AskUserQuestion]: "Bump ABI_VERSION 14→15 (Recommended)".

### Carry-forward from handoff-7 + handoff-8 (still uncommitted)

Same diffs as listed in handoff-8 §"Uncommitted working-tree state":

```
Modified (uncommitted):
  crates/kernel/src/wasm_api.rs       # handoff-7 Diff 1
  crates/kernel/src/syscalls.rs       # handoff-7 Diffs 2/3/4 + handoff-8 Diff A + session-9 Diff D
  crates/shared/src/lib.rs            # session-9 Diff E
  host/src/kernel.ts                  # handoff-8 Diff B
  host/src/kernel-worker.ts           # handoff-8 Diff C
  scripts/build-programs.sh           # handoff-7 Diff 8
  host/test/dri-smoke.test.ts         # handoff-7 Diff 5
  host/test/dri-modeset.test.ts       # handoff-7 Diff 6 retarget
  abi/snapshot.json                   # session-9 Diff E (regenerated)
  host/src/generated/abi.ts           # session-9 Diff E (regenerated)
  libc/glue/abi_constants.h           # session-9 Diff E (regenerated)
New (untracked):
  programs/dri-modeset.c              # handoff-7 Diff 6 new fixture
  apps/browser-demos/test/kandelo-modeset.spec.ts
  sysroot64/                          # gitignored
  local-binaries/kernel.wasm          # rebuilt against ABI 15
  local-binaries/programs/wasm32/*    # rebuilt against ABI 15
  host/dist/*                         # gitignored
```

## What `dri-cube-pyramid` does now

End-to-end flow with the new GLIO handlers (each side of the fork, in order):

1. `open("/dev/dri/renderD128")` → fd, OFD has `DriOfdState::RenderNode(DriFdState { gl: None, .. })`.
2. `ioctl(fd, GLIO_INIT, &op_version)` → `gl = Some(GlState { initialized: true, .. })`.
3. `mmap(NULL, CMDBUF_LEN, RW, MAP_SHARED, fd, 0)` → new cmdbuf branch fires, allocs anonymous wasm pages, records `CmdbufBinding`, calls `host.gl_bind(pid, addr, CMDBUF_LEN)`.
4. `ioctl(fd, GLIO_CREATE_CONTEXT, &attrs)` → `gl.context_id = Some(1)`, `host.gl_create_context(pid, 1, attrs)`. The host has the fake canvas pre-attached via `kernel.gl.attachCanvas(pid, fakeCanvas)`, so `b.gl` gets the WebGL2 proxy.
5. `ioctl(fd, GLIO_CREATE_SURFACE, &surf)` → `gl.surface_id = Some(1)`.
6. `ioctl(fd, GLIO_MAKE_CURRENT, NULL)` → `gl.current = true`.
7. Per-frame: shader/buffer/draw glue encodes TLVs into the cmdbuf → `_wpk_gl_flush` → `ioctl(fd, GLIO_SUBMIT, &info)` → `host.gl_submit(pid, off, len)` → `drainSubmitQueue` → `decodeAndDispatch` → `GlMuxer.switchTo` fires per `(pid, ctx_id)`.
8. `eglSwapBuffers` → flush + `GLIO_PRESENT` → `host.gl_present` (no-op v1, RAF-driven).
9. After 200 frames each side: `eglDestroySurface`/`eglDestroyContext`/`eglTerminate` → `GLIO_DESTROY_*` + `GLIO_TERMINATE`.

Parent and child end with `_exit(0)`, stdout: `cube_pyramid: parent pid=… rc=0, child pid=… rc=0`, `switchSpy` collects 2 distinct `(pid, ctx_id)` keys.

## Things the next session MUST do

1. **Decide whether libc/POSIX FAILs are pre-existing or regressions.** Concrete recipe:
   ```bash
   git stash -u
   git checkout origin/main -- .   # or worktree-add origin/main; the point is: clean upstream
   bash scripts/build-musl.sh && bash build.sh
   PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh \
     bash -c 'scripts/run-libc-tests.sh 2>&1 | tee /tmp/libc-main.log; \
              scripts/run-posix-tests.sh 2>&1 | tee /tmp/posix-main.log'
   ```
   Then `diff` the FAIL listings against session 9's:
   - Gate 3 FAIL list saved at the top of this doc — math/* (7) + regression/* (6) = 13.
   - Gate 4 FAIL list — sigset (4), sigsuspend (4), sigtimedwait (5), sigwaitinfo (8), str* (8), time (1) = 30.

   If they all reproduce on `origin/main`: pre-existing, document in PR body and move on. If any are new on this branch: bisect across the 14 DRI commits (or just this session's diffs by stashing) and fix.

2. **Restore session-9 state**: `git stash pop`. Run `bash build.sh` again (the stash-pop will leave the working tree mid-state but the local-binaries/ already have the ABI-15 builds).

3. **Stage the commits.** Suggested boundaries (revised from handoff-8):

   | # | Files | Summary |
   |---|-------|---------|
   | 1 | `wasm_api.rs`, `syscalls.rs` (handoff-7 Diffs 1+2) | fix mmap errno propagation + accept raw bo size |
   | 2 | `syscalls.rs` (handoff-7 Diffs 3+4 + handoff-8 Diff A unit test) | drain PAGE_FLIP synchronously into event_ring |
   | 3 | `host/src/kernel.ts`, `host/src/kernel-worker.ts` (handoff-8 Diffs B+C) | wire primeBindFromSab on DRI mmap |
   | 4 | `build-programs.sh`, `dri-smoke.test.ts`, `dri-modeset.test.ts`, `programs/dri-modeset.c` | test plumbing + retarget dri-modeset |
   | 5 | `syscalls.rs` (session-9 Diff D — handlers + cmdbuf mmap + 5 unit tests) | implement GLIO ioctl protocol for renderD128 GL sessions |
   | 6 | `crates/shared/src/lib.rs`, `abi/snapshot.json`, `host/src/generated/abi.ts`, `libc/glue/abi_constants.h` | bump ABI_VERSION 14→15 + regenerate snapshot |

   **Wait for user input before each commit** — standing instruction.

4. **Re-run the full gauntlet after staging** to confirm no commit re-broke anything. Easiest: after the LAST commit, run all five gates one more time.

5. **Do not push at all.** Branch lives on `Automattic/kandelo`. Even the final state stays local until the user runs `gh pr create` themselves.

## Open questions / known gaps

1. **`fork()` does not carry `DriFdState.gl` across.** Verified during session 8/9 that cube_pyramid forks BEFORE eglInitialize, so each side calls GLIO_INIT independently and the gap is invisible for this test. But a program that forks WITH an active GL session would silently lose state on the child. Fix in `crates/kernel/src/fork.rs` (~line 285-405, DriFdState read/write paths) — add the `gl` field to the roundtrip. Out of scope for this PR; track separately.
2. **`GLIO_QUERY` is wired but not exercised by cube_pyramid.** The path is implemented (read input via `proc_read_bytes`, scratch-allocate, call `gl_query`, write back via `proc_write_bytes`, bounded by `MAX_QUERY_OUT_LEN`). It needs an actual test that calls `glGetError` / `glGetShaderiv` etc. from a C program once the lib stubs grow that surface.
3. **The 3 added kernel exports** (`kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`) are now visible in the ABI 15 snapshot. They were added in handoff-6/7. They're additive and don't require host-side wiring to be safe, but if the host worker invokes them, that's only documented in handoff-7's vblank-pump description.

## Important constraints, do not violate (carry-forward from v1–v8)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch — automatic for session-9 work because `kernel.ts` and `kernel-worker.ts` are shared.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input before each commit.

## Reference points

- All prior handoffs: `docs/plans/2026-06-08-dri-kandelo-port-handoff{,-2,-3}.md`, `docs/plans/2026-06-09-dri-kandelo-port-handoff{-4,-5,-6,-7,-8}.md`.
- GLIO ioctl ABI: `crates/shared/src/lib.rs:1812-2012` (`mod gl`).
- GLIO handler block (session 9): `crates/kernel/src/syscalls.rs` arms inserted before line ~906 in `handle_dri_ioctl`.
- Cmdbuf mmap branch (session 9): `crates/kernel/src/syscalls.rs` ~line 5885 in `sys_mmap`'s renderD128 block.
- Host bridge entry points: `host/src/kernel.ts:713-852` (`host_gl_*` import handlers), `host/src/webgl/bridge.ts`, `host/src/webgl/muxer.ts`.
- C-side stubs: `libc/glue/libegl_stub.c`, `libc/glue/libglesv2_stub.c`.
- Test that now passes: `host/test/dri-cube-pyramid.test.ts` — 1 test, 3.6s.
- The `host/dist/` and `PATH=/nix/var/nix/profiles/default/bin:$PATH` traps: top of handoff-8.
- ABI policy: `CLAUDE.md` §"Kernel ABI stability" + `docs/abi-versioning.md`.
