# DRI port onto kandelo:main — session 7 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-6.md](./2026-06-09-dri-kandelo-port-handoff-6.md). Read that first — this doc only covers what changed in session 7.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Per the user's standing instruction the branch lives on Automattic/kandelo only; do **not** push to mho22.

## Hard-won facts the v6 handoff got wrong

- **Vitest MUST be run inside `scripts/dev-shell.sh`.** The pinned `nodejs_24` in `flake.nix` is **24.15.0**, which has `--experimental-wasm-exnref` enabled by default. The user's host `nvm` Node is 24.13.0 (default OFF), so running `cd host && npx vitest run` directly produces **79 failures** (dash/bash/coreutils binaries use the new EH proposal and trap with `WebAssembly.compile(): invalid value type 'exn'`). Inside the dev shell the same command produces the canonical **7 failures** the handoff predicted. This took 30 minutes to figure out — write it down somewhere durable.
- The "7 failures" reported by v6 are correct **only inside the dev shell**. Don't trust raw vitest numbers from outside.

## Branch state at end of session 7

Working branch: `explore-direct-rendering-infrastructure`. The **one** new commit landed this session is:

```
6474e912c build(dri): link libdrm/libgbm into DRI programs + auto-link EGL/GLES2
873093270 kandelo(dri): wire Modeset surface into MachineView + modeset preset
…(see handoff-5 for commits 1–11)…
```

So we're at 12 local commits ahead of `origin/main`. Everything else this session is in **uncommitted working-tree diffs** that the user paused me before committing.

## Gauntlet state at end of session 7

Inside the dev shell (mandatory):

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib mmap_dri` | ✅ 5/5 pass | Verified the syscalls.rs change below doesn't regress existing DRI mmap unit tests. Full `--lib` run not done yet this session. |
| `cd host && npx vitest run` (DRI subset) | ✅ **dri-smoke / dri-modeset / dri-kms-pageflip all pass**; ❓ **dri-dumb-roundtrip still fails**; **dri-cube-pyramid not re-run since the kernel rebuild**. |
| `scripts/run-libc-tests.sh` | ⚠️ not re-run this session. Was green in v6. |
| `scripts/run-posix-tests.sh` | ⚠️ not re-run this session. Was green in v6. |
| `bash scripts/check-abi-version.sh` | ⚠️ definitely drifted further — see "Things the next session must double-check" below. |

The `wasm64.test.ts` 2 failures noted by v6 went away after **building sysroot64**:

```bash
scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix
scripts/dev-shell.sh bash scripts/build-programs.sh
```

`sysroot64/lib/libc.a` (1.4 MB) builds in ~18s; then `build-programs.sh` picks up the wasm64 path and emits `local-binaries/programs/wasm64/hello64.wasm`. That's an environment fix only — no code change. Just make sure sysroot64 exists.

## Uncommitted working-tree diffs at end of session 7 — DO NOT LOSE

The user told me to write everything down before /clear, because the changes below collectively fix 3 of the 5 DRI failures and are NOT trivial to re-derive.

### Diff 1 — `crates/kernel/src/wasm_api.rs` SYS_MMAP errno propagation

**Root cause.** The channel dispatcher's `SYS_MMAP` branch was `kernel_mmap(...) as i32`. `kernel_mmap` returns `usize` (MAP_FAILED on error = `usize::MAX = 0xFFFFFFFF`). Cast to `i32` it becomes `-1`. The dispatcher's "negative result = errno" contract then treats `-1` as `errno = EPERM = 1`. So every mmap error surfaced to user space as "Operation not permitted" instead of the actual `Errno`.

**Fix.** Call `syscalls::sys_mmap` directly in the SYS_MMAP dispatch branch, preserving the real `Errno`. Mirror `kernel_mmap`'s `ensure_memory_covers` + `deliver_pending_signals` behavior. Patch sits in `dispatch_channel_syscall` around line 2974:

```rust
46 => {
    // SYS_MMAP: (addr, len, prot, flags, fd, pgoffset)
    // musl sends page offset (off / 4096) as a6.
    // Call sys_mmap directly so the errno reaches the channel
    // dispatcher — going through kernel_mmap would squash every
    // Errno variant to MAP_FAILED (usize::MAX), and `as i32`
    // turns that into -1, which the dispatcher interprets as
    // -EPERM.
    let pgoff = a6 as u32;
    let byte_off = ((pgoff as u64) << 12) as i64;
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mmap(
        proc, &mut host, a1 as usize, a2 as usize,
        a3 as u32, a4 as u32, a5, byte_off,
    ) {
        Ok(addr) => {
            if a3 as u32 != 0 {
                let end = addr.saturating_add(a2 as usize);
                ensure_memory_covers(end);
            }
            addr as i32
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}
```

### Diff 2 — `crates/kernel/src/syscalls.rs` DRI mmap length check

**Root cause.** The kernel rejected `mmap(fd=dri, len=bo_size)` because it required `len == aligned_bo_size` (rounded up to 64 KB wasm page). But neither `libgbm_stub.c` (`mmap(NULL, bo->size, ...)`) nor `programs/dri-smoke.c` (`mmap(NULL, cd.size, ...)`) ever rounds up. The comment in the kernel said "libgbm rounds the map length" but `libgbm_stub.c` does NOT. Result: every direct-syscall mmap on a 640×400×4 = 1 024 000-byte bo failed with EINVAL.

**Fix.** Accept either the raw `bo_size` OR the page-aligned size. `proc.memory.mmap_anonymous` rounds to wasm page internally, so both requests map the same number of pages; we just record the binding length the caller asked for. The existing unit tests pass `aligned_bo_size`, so they keep working. Patch in `sys_mmap` around line 5848:

```rust
// Accept either the raw bo size (matching what DRM_IOCTL_MODE_
// CREATE_DUMB returned and what the libgbm stub + direct
// mmap callers pass) or the wasm-page-aligned size some
// consumers round to. `mmap_anonymous` rounds to a wasm
// page internally, so either request maps the same number
// of pages; we just track the binding length the caller
// asked for.
let aligned_bo_size = (bo_size as usize)
    .checked_add(0xFFFF)
    .ok_or(Errno::EINVAL)?
    & !0xFFFF;
if len != bo_size as usize && len != aligned_bo_size {
    return Err(Errno::EINVAL);
}
```

### Diff 3 — `crates/kernel/src/syscalls.rs` synchronous PAGE_FLIP → event_ring drain

**Root cause.** `DRM_IOCTL_MODE_PAGE_FLIP` pushed onto `kms.pending_flips`, but nothing in the kernel **ever** popped from `pending_flips` and nothing **ever** wrote to `kms.event_ring`. The v6 handoff comment said "the vblank pump drains it into the event ring", but the vblank pump (`kernel_vblank` in `host/src/kernel-worker.ts`) only bumps a global counter; it does not touch `pending_flips` or `event_ring`. So every second `PAGE_FLIP` ioctl returned EBUSY (the previous `pending_flip` never went away) and `drmHandleEvent` → `read(card0)` returned 0 bytes (the `event_ring` stayed empty).

**Fix.** In `PAGE_FLIP` ioctl: after pushing the `PendingFlip`, immediately pop it and serialize a `DRM_EVENT_FLIP_COMPLETE` record (32 bytes, type=2, length=32, user_data, tv_sec/tv_usec from `CLOCK_MONOTONIC`, sequence from `vblank_tick()`, crtc_id) into `kms.event_ring`. Patch around line 1242 of `syscalls.rs`. This makes PAGE_FLIP semantically synchronous from the test bench's view, matching the comment in the in-line patch:

> v1 simplification: the host vblank pump exists only to refresh canvases + counters, so the test-bench can run PAGE_FLIP → drmHandleEvent without a real 60 Hz tick driving event delivery.

### Diff 4 — `crates/kernel/src/syscalls.rs` `sys_read` on `/dev/dri/card0`

**Root cause.** Same as Diff 3 — `sys_read` for `VirtualDevice::DriCard0` returned 0 (EOF), so even if `event_ring` were populated, no event reached user space. Patch around line 2356: split `DriCard0` out of the "return 0" virtual-device set and drain `kms.event_ring` one byte at a time into `buf`. EAGAIN on empty + O_NONBLOCK; otherwise `Ok(0)` so `drmHandleEvent` treats it as a "no events this round" tick.

### Diff 5 — `host/test/dri-smoke.test.ts` 20 s `it()` timeout

The inner `Promise.race` timeout is 10 s but the default vitest `testTimeout` is 5 s, so the test was always racing the outer first. Trivially: `it("…", async () => { … }, 20_000);`.

### Diff 6 — `host/test/dri-modeset.test.ts` retargeted

`programs/modeset.wasm` is now Pavel's fluid-sim, which never prints "modeset OK frames=...". I created a **new** test fixture `programs/dri-modeset.c` (copied from the historical `d741378d8:programs/modeset.c` and re-prefaced) and updated the test to load `programs/dri-modeset.wasm`. `scripts/build-programs.sh`'s DRI case block now also routes `dri-modeset.c` to `libgbm.a + libdrm.a`.

### Diff 7 — `scripts/build-programs.sh` (the prerequisite, not the new fix)

This is the **6474e912c** linker-fix commit. Committed.

### Diff 8 — `scripts/build-programs.sh` for `dri-modeset.c`

One line in the DRI case block:

```sh
modeset.c|dri-modeset.c|dri_paint.c|dumb_roundtrip.c)
```

## Working-tree state for the next session (file list)

```
Modified (uncommitted):
  crates/kernel/src/wasm_api.rs      # Diff 1
  crates/kernel/src/syscalls.rs      # Diffs 2, 3, 4
  scripts/build-programs.sh          # Diff 8 (Diff 7 already committed)
  host/test/dri-smoke.test.ts        # Diff 5
  host/test/dri-modeset.test.ts      # Diff 6 retarget
New (untracked):
  programs/dri-modeset.c             # Diff 6 new fixture
  apps/browser-demos/test/kandelo-modeset.spec.ts  # carried forward from v6, untouched
  sysroot64/                         # ~1.4 MB, built artifact, gitignored
  local-binaries/kernel.wasm         # rebuilt with Diffs 1–4
  local-binaries/programs/wasm32/dri-modeset.wasm
  local-binaries/programs/wasm64/hello64.wasm
```

## The two remaining DRI failures (NOT addressed this session)

### `test/dri-dumb-roundtrip.test.ts`

Status at end of session: still failing with the same symptom v6 reported — `FAIL: child pixel (0,0) = 0x00000000; want 0xff000000` (child exit status 0x400 = exit code 4 from `_exit(4)` in `dumb_roundtrip.c`).

The flow:
1. parent opens renderD128, `gbm_bo_create(256×256)`, `gbm_bo_map`, writes a gradient (`(0xFF<<24) | (x<<16) | (y<<8)`).
2. parent `gbm_bo_get_fd(bo)` → prime fd.
3. parent `fork()`.
4. child `gbm_bo_import(GBM_BO_IMPORT_FD, prime)`, `gbm_bo_map`, reads pixel (0,0) — finds `0x00000000`, want `0xff000000`.

The child sees an empty bo where the parent's gradient should be. The handoff diagnosis is "PRIME export isn't carrying the bo binding through fork, or the child's mmap isn't pulling the SAB region the parent wrote into."

**Where to start looking.** `host/src/dri/registry.ts` `bind()` is documented as "Pure metadata at this point: the actual SAB→Memory prime is deferred to `primeBindFromSab`, called after the kernel-worker post-syscall path has grown the Memory and zero-filled the mmap region." So look for `primeBindFromSab` in `host/src/kernel-worker.ts` and confirm it actually fires on the child's mmap path after fork. The PRIME inheritance path is `crates/kernel/src/fork.rs` for `DriOfdState::PrimeBo` — verify that's preserved across fork. The host's `gbm_bo_bind` is in `host/src/dri/registry.ts:219`, and the parent's writes to the wasm Memory at `[addr, addr+len)` need to be flushed into the bo's canonical SAB at the parent's mmap-write or at `gbm_bo_get_fd` time, then re-primed into the child's wasm Memory after the child's mmap. If the parent's writes never reach the canonical SAB, the child reads zeros — that's exactly the failure.

### `test/dri-cube-pyramid.test.ts`

Not re-run this session after the kernel rebuild. v6 reported "both forked processes return rc=1. Likely an EGL/GLES2 stub gap in the host's `host_gl_*` bridge for some path the cube_pyramid demo exercises." That diagnosis predates this session's three kernel fixes — re-run before sinking time:

```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/dri-cube-pyramid.test.ts'
```

## Things the next session MUST double-check before opening the PR

1. **Full vitest run inside the dev shell**:
   ```bash
   scripts/dev-shell.sh bash -c 'cd host && npx vitest run' 2>&1 | tail -30
   ```
   Expect: 5 → 2 failures (only `dri-dumb-roundtrip` + maybe `dri-cube-pyramid`).

2. **Full cargo `--lib` run** (we only ran `mmap_dri` filter):
   ```bash
   scripts/dev-shell.sh bash -c 'cargo test -p kandelo --target aarch64-apple-darwin --lib'
   ```
   Expect: 929 passed, 0 failed (handoff-6 reported 929 passed). The Diff 3 change to the `PAGE_FLIP` ioctl handler **does** affect unit tests at `kms_addfb_then_setcrtc_then_page_flip_happy_path` (line ~21460) and `assert_eq!(kms.pending_flips.len(), 1);` at line 21530 — that assertion will now fail because the flip is immediately drained. **Update that unit test to assert `event_ring.len() == 32` instead, or to inspect `pending_flips` before the synchronous drain by splitting the ioctl handler.**

3. **`bash scripts/check-abi-version.sh`** — v6 said the drift was the three additive exports `kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`. This session didn't add any exports but the syscall behaviour around PAGE_FLIP changed. Structural snapshot probably stays clean; semantic ABI didn't change either (PAGE_FLIP retires synchronously now but the return contract — `Ok(())` on success — is unchanged). `check-abi-version.sh update` then inspect the diff and decide.

4. **libc-test + open-posix-testsuite** — re-run; the SYS_MMAP errno propagation fix (Diff 1) means every mmap failure used to surface as EPERM and now surfaces as the real errno. Posix tests that check `mmap` errno may now PASS where they previously XFAILed — verify and update the expected-failure ledger if needed.

## Important constraints, do not violate (carry-forward from v1–v6)

- **One PR against `Automattic/kandelo:main`.**
- **All five test gates green before the PR opens.**
- **Dual-host parity** for any `host/src/` touch — Diffs 1–4 are kernel/host-agnostic so no parity concern. Diffs 5–8 are tests/build scripts only.
- **No Asyncify, anywhere.**
- **Use the Kandelo React UI pane, not a legacy standalone page.**
- **Ask before any destructive git op.**
- **Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`.**
- **Wait for user input after each commit.** Standing instruction from session 6+7.

## Suggested commit boundary for the four uncommitted kernel changes

Diffs 1 (mmap errno) and 2 (mmap len check) are one logical change — "fix mmap error reporting + accept raw bo size from libgbm/dri-smoke." Diffs 3 and 4 (PAGE_FLIP synchronous drain + DRI card0 read drainage) are a second logical change — "kms(dri): drain PAGE_FLIP events synchronously for v1 test bench." Diffs 5/6/8 (test plumbing + new fixture) plus the new `programs/dri-modeset.c` file are a third — "test(dri): retarget dri-modeset against new CLI fixture + bump dri-smoke timeout."

Roughly three commits, in that order. Each one is independently testable.

## Reference points

- **Session 1–6 handoffs**: `docs/plans/2026-06-08-dri-kandelo-port-handoff{,-2,-3}.md` and `docs/plans/2026-06-09-dri-kandelo-port-handoff{-4,-5,-6}.md`.
- **The dev-shell Node 24.15.0 vs nvm 24.13.0 trap**: see top of this doc. Use `scripts/dev-shell.sh` or nothing.
- **The PAGE_FLIP → event_ring v1 simplification**: see in-line patch comment in `syscalls.rs` PAGE_FLIP handler. Production may want to switch this to "vblank pump drains" once the pump actually has drain logic, but for v1 the synchronous path matches the test expectations and matches what a real DRM vblank IRQ would do before the next ioctl.
- **`programs/modeset.c` is now Pavel's fluid-sim**, not the CLI. Don't use `modeset.wasm` as a test fixture — use `dri-modeset.wasm` (new, from `programs/dri-modeset.c`).
