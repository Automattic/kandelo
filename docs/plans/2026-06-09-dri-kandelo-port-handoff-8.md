# DRI port onto kandelo:main — session 8 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-7.md](./2026-06-09-dri-kandelo-port-handoff-7.md). Read that first — this doc only covers what changed in session 8.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22`.

## Hard-won facts re-confirmed in session 8

- **`scripts/dev-shell.sh` requires `PATH=/nix/var/nix/profiles/default/bin:$PATH` to be set first** in this user's shell — `nix` is at that absolute path, not on the inherited PATH. Without the prefix, dev-shell errors with `nix: command not found`. Use `PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c '…'` for every gauntlet step.
- **`host/dist/` is the load-bearing artifact for vitest's worker thread**, not `host/src/`. `node-kernel-host.ts:581` prefers `host/dist/node-kernel-worker-entry.js` (a bundled file that inlines `kernel-worker.ts` + `dri/registry.ts`) over the tsx fallback. After any edit to `host/src/`, **must run `cd host && npm run build`** before the test will see the change. v7 missed this; spent ~30 min thinking my fix wasn't running because dist was stale.

## Gauntlet state at end of session 8

Inside dev shell, with PATH prefix:

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **929/929** pass | PAGE_FLIP unit test rewritten for synchronous-drain semantics (see "Diff A" below). |
| `cd host && npx vitest run` (full suite) | 🟡 **708 pass / 1 fail** | Only `dri-cube-pyramid` remains. `dri-dumb-roundtrip` now passes — fix below. |
| `scripts/run-libc-tests.sh` | ⚠️ not re-run this session. |
| `scripts/run-posix-tests.sh` | ⚠️ not re-run this session. |
| `bash scripts/check-abi-version.sh` | ⚠️ not re-run this session. |

## What landed in session 8 — STILL UNCOMMITTED

The user paused me before any commit. Everything below is in working-tree.

### Diff A — `crates/kernel/src/syscalls.rs` PAGE_FLIP unit test rewrite

`kms_addfb_then_setcrtc_then_page_flip_happy_path` (test around line 21510) was broken by handoff-7's PAGE_FLIP synchronous-drain change. The test asserted `kms.pending_flips.len() == 1` and that a back-to-back PAGE_FLIP returned EBUSY — both incompatible with the new semantic where the flip retires synchronously into `event_ring`.

Replaced the assertions with the new contract:
- After one PAGE_FLIP: `pending_flips.is_empty()` + `event_ring.len() == 32` + assert the 32-byte FLIP_COMPLETE record's type=2, length=32, user_data=0x42, crtc_id=1.
- Back-to-back PAGE_FLIP now **succeeds** (no EBUSY) and grows `event_ring` to 64 bytes.

The EBUSY contract still exists in the ioctl handler (line 1238) but is effectively unreachable under v1's synchronous drain.

### Diff B — `host/src/kernel.ts` constructor: wire `setProcessMemoryResolver`

`GbmBoRegistry` already had a `setProcessMemoryResolver(fn)` slot but **nobody ever called it**. The flush path inside `unbind` / `primeBindFromSab` no-ops without a resolver, so the SAB-sync design (parent writes → SAB → child reads) couldn't move bytes across fork even when called.

Added to the `WasmPosixKernel` ctor body (after `this.callbacks = callbacks ?? {}`):

```ts
this.bos.setProcessMemoryResolver((pid) =>
  this.callbacks.getProcessMemory?.(pid),
);
```

The closure reads `this.callbacks` at call time so `mergeCallbacks(...)` still propagates.

### Diff C — `host/src/kernel-worker.ts` post-SYS_MMAP hook: fire `primeBindFromSab`

`primeBindFromSab` was **dead code** — no caller anywhere in `host/src/` or `apps/`. The kernel's `sys_mmap` on `/dev/dri/{render,card}` already invokes `host.gbm_bo_bind` (which records the binding as pure metadata), but the actual SAB→Memory copy was supposed to be deferred until after `ensureProcessMemoryCovers` + the anonymous-mmap zero-fill. That deferred call was missing.

Added inside the file-backed-mmap conditional block (around line 2363, after `populateMmapFromFile`'s `}`):

```ts
const mmapAddr = retVal >>> 0;
const boId = this.kernel.bos.findBindingByAddr(channel.pid, mmapAddr);
if (boId !== undefined) {
  this.kernel.bos.primeBindFromSab(channel.pid, boId, channel.memory);
}
```

This fires on every successful mmap and is a cheap no-op when no bo binding matches. **This is what made `dri-dumb-roundtrip` pass** — the child's mmap of the PRIME-imported bo now sees the parent's gradient.

Note: dual-host parity is automatic here because `host/src/kernel.ts` and `host/src/kernel-worker.ts` are **shared** files used by both `node-kernel-host.ts` and `browser-kernel-host.ts`. No browser-side edit needed.

## Uncommitted working-tree state at end of session 8

Carried forward from handoff-7 + what landed this session:

```
Modified (uncommitted):
  crates/kernel/src/wasm_api.rs      # handoff-7 Diff 1
  crates/kernel/src/syscalls.rs      # handoff-7 Diffs 2/3/4 + session-8 Diff A
  host/src/kernel.ts                 # session-8 Diff B (NEW)
  host/src/kernel-worker.ts          # session-8 Diff C (NEW)
  scripts/build-programs.sh          # handoff-7 Diff 8
  host/test/dri-smoke.test.ts        # handoff-7 Diff 5
  host/test/dri-modeset.test.ts      # handoff-7 Diff 6 retarget
New (untracked):
  programs/dri-modeset.c             # handoff-7 Diff 6 new fixture
  apps/browser-demos/test/kandelo-modeset.spec.ts
  sysroot64/                         # ~1.4 MB, built artifact, gitignored
  local-binaries/kernel.wasm         # rebuilt
  local-binaries/programs/wasm32/dri-modeset.wasm
  local-binaries/programs/wasm32/dumb_roundtrip.wasm  # rebuilt this session
  local-binaries/programs/wasm64/hello64.wasm
  host/dist/*                        # rebuilt this session — gitignored
```

## The remaining failure — `dri-cube-pyramid` — triaged, **not yet fixed**

`programs/cube_pyramid.c` opens `/dev/dri/renderD128`, calls `eglInitialize`, then forks; both sides return rc=1 (the eglInitialize failure return). The test expects rc=0 + `GlMuxer.prototype.switchTo` to be called for ≥2 distinct `(pid, ctx_id)` keys.

### Root cause: the kernel has **zero** GLIO_* ioctl handlers

The host bridge is fully wired:
- `host/src/kernel.ts:719-852` implements every `host_gl_*` import (bind, unbind, create_context, destroy_context, create_surface, destroy_surface, make_current, submit, present, query, bind_foreign_texture).
- `host/src/webgl/{bridge,muxer,registry,submit-drain,query}.ts` decode + dispatch the cmdbuf TLV stream.
- `crates/kernel/src/wasm_api.rs:192-208` declares all `host_gl_*` imports and `WasmHostIO` forwards them (lines 983-1015).
- `crates/kernel/src/ofd.rs:80-130` already has `CmdbufBinding` + `GlState` scaffolding hung off `DriFdState`.

**What's missing**: `handle_dri_ioctl` in `crates/kernel/src/syscalls.rs` (line 650) has no arms for the GLIO opcodes 0x40–0x49 (defined in `crates/shared/src/lib.rs:1829-1838`). Every GLIO ioctl falls through to `_ => Err(Errno::ENOSYS)` at line 906, so `ioctl(fd, GLIO_INIT, &op_version)` in `libc/glue/libegl_stub.c:62` always fails → `eglInitialize` returns `EGL_FALSE` → `gl_setup` returns 1 → both processes `_exit(1)`.

Additionally, `sys_mmap` for renderD128 (line 5878-5928) only handles bo mmaps (offset = `bo_id << 12`). The libegl stub at `libc/glue/libegl_stub.c:74` does `mmap(fd, 0, CMDBUF_LEN=1<<20, ..., MAP_SHARED, 0)` — offset=0 — which currently decodes to `bo_id=0` and fails EINVAL because no bo with id 0 exists.

### Sketch of the fix (this is what I was about to write when context ran low)

Add a complete GLIO handler block in `handle_dri_ioctl` before the `_ => Err(Errno::ENOSYS)` arm. The ABI structs (`GlSubmitInfo`, `GlContextAttrs`, `GlSurfaceAttrs`, `GlQueryInfo`) are already in `wasm_posix_shared::gl::*`.

```rust
GLIO_INIT => {
    if buf.len() < 4 { return Err(Errno::EINVAL); }
    let client_version = u32::from_le_bytes(buf[..4].try_into().unwrap());
    if client_version != wasm_posix_shared::gl::OP_VERSION {
        return Err(Errno::ENOSYS);  // version skew — catch at first contact
    }
    let dri = dri_state_mut(proc, ofd_idx)?;
    if dri.gl.is_some() { return Err(Errno::EBUSY); }
    dri.gl = Some(crate::ofd::GlState { initialized: true, ..Default::default() });
    Ok(())
}
GLIO_TERMINATE => {
    let dri = dri_state_mut(proc, ofd_idx)?;
    if dri.gl.is_none() { return Err(Errno::EINVAL); }
    dri.gl = None;
    host.gl_unbind(pid);
    Ok(())
}
GLIO_CREATE_CONTEXT => {
    // read GlContextAttrs, gate on gl.initialized, assign ctx_id=1
    // (single context in v1), set gl.context_id, call host.gl_create_context.
}
GLIO_DESTROY_CONTEXT => { /* clear ctx_id + gl.current, call host */ }
GLIO_CREATE_SURFACE  => { /* like CREATE_CONTEXT, surface_id=1 */ }
GLIO_DESTROY_SURFACE => { /* like DESTROY_CONTEXT */ }
GLIO_MAKE_CURRENT    => { /* gate on ctx_id+surface_id, set gl.current=true, call host */ }
GLIO_SUBMIT => {
    let info: GlSubmitInfo = read_unaligned(buf);
    let gl = ...; let cmdbuf = gl.cmdbuf.as_ref().ok_or(Errno::EINVAL)?;
    // validate (offset + length) <= cmdbuf.len
    gl.cmdbuf.as_mut().unwrap().submit_seq += 1;
    host.gl_submit(pid, info.offset as usize, info.length as usize);
    Ok(())
}
GLIO_PRESENT => { /* gate on gl.initialized, call host.gl_present */ }
GLIO_QUERY => {
    // For cube_pyramid this can be a no-op stub — none of the C calls
    // in cube_pyramid.c use sync queries (no glGetShaderiv etc.).
    // A real impl reads input from process memory via HostIO::proc_read_bytes,
    // allocates a scratch out_buf, calls host.gl_query, writes back via
    // HostIO::proc_write_bytes. Bound out_buf_len at MAX_QUERY_OUT_LEN.
    Ok(())
}
```

Extend `sys_mmap` (line 5878 block) to handle the cmdbuf:

```rust
if offset == 0 {
    let needs_cmdbuf = ofd.dri()
        .and_then(|d| d.gl.as_ref())
        .map(|g| g.initialized && g.cmdbuf.is_none())
        .unwrap_or(false);
    if needs_cmdbuf {
        if len != wasm_posix_shared::gl::CMDBUF_LEN {
            return Err(Errno::EINVAL);
        }
        let alloc_flags = flags | MAP_ANONYMOUS;
        let addr_out = proc.memory.mmap_anonymous(addr, len, prot, alloc_flags);
        if addr_out == MAP_FAILED { return Err(Errno::ENOMEM); }
        if let Ok(dri) = dri_state_mut(proc, ofd_idx) {
            if let Some(gl) = dri.gl.as_mut() {
                gl.cmdbuf = Some(crate::ofd::CmdbufBinding {
                    addr: addr_out, len, submit_seq: 0,
                });
            }
        }
        host.gl_bind(proc.pid as i32, addr_out, len);
        return Ok(addr_out);
    }
}
// ... existing bo mmap path (decode bo_id from offset>>12)
```

### Why this should make the test pass

- `eglInitialize` → GLIO_INIT succeeds → cmdbuf mmap binds → host_gl_bind fires.
- `eglCreateContext` → GLIO_CREATE_CONTEXT → host_gl_create_context (which in `kernel.ts:729` calls `b.canvas.getContext("webgl2")` — the test injects a fake canvas via `kernel.gl.attachCanvas(pid, fakeCanvas)` BEFORE the worker starts, so `b.canvas` is set and the proxy GL is returned).
- `eglMakeCurrent` → GLIO_MAKE_CURRENT (no-op in host).
- The first `glDrawArrays`/`glClear` → `_wpk_gl_flush()` → GLIO_SUBMIT → `host.gl_submit` → `host_gl_submit` → `drainSubmitQueue(...)` → `decodeAndDispatch` walks TLVs against the fake GL → muxer's `switchTo(b)` fires for `(pid=parent, ctx_id=1)`. Second process's first submit triggers `switchTo` for `(pid=child, ctx_id=1)`. Test's `switchedKeys.size >= 2` passes.
- Both sides reach `_exit(0)` after 200 frames (the test passes `argv=["cube_pyramid", "200"]`).

### Open questions to verify when implementing

1. **Does `glCreateShader` / `glCreateProgram` need a sync query for the return value?** Looking at `libc/glue/libglesv2_stub.c` for `glCreateShader` and `glCreateProgram` — they pick names client-side with a monotonic counter and emit `OP_CREATE_SHADER`/`OP_CREATE_PROGRAM` carrying the chosen u32. No sync query needed. ✓
2. **Does `glBindBuffer(...)` block on anything?** No — pure cmdbuf encode. ✓
3. **Does fork properly carry `gl: Some(GlState)` across?** Need to verify in `crates/kernel/src/fork.rs` — `DriFdState` is serialized but check the `gl` field roundtrips. **TODO for next session: read `fork.rs:285-405` (the DriFdState read/write paths) and add `gl` to the round-trip if missing.** This matters because cube_pyramid forks BEFORE eglInitialize, so each side calls GLIO_INIT independently — both processes open their own renderD128 fd and the OFDs are NOT shared, so fork doesn't need to inherit gl state for this specific test. But it's a correctness gap regardless.
4. **ABI version bump?** GLIO_* ioctls already had numeric assignments and the structs are already in `crates/shared/src/lib.rs`. Adding handlers is purely additive — no `ABI_VERSION` bump needed. Run `bash scripts/check-abi-version.sh update` after the change and verify the snapshot diff is additive-only.

## Things the next session MUST do

1. **Implement the GLIO handlers + cmdbuf mmap path** as sketched above. Single commit, ~150 lines of Rust in `syscalls.rs`.
2. **Re-run vitest** — expect `dri-cube-pyramid` to pass (708→709 pass, 0 fail).
3. **Re-run cargo `--lib`** — expect 929+ pass. Add unit tests for at least GLIO_INIT (version-skew rejection), CREATE_CONTEXT, SUBMIT (out-of-range rejection), and the cmdbuf mmap path (length validation).
4. **Run the remaining gauntlet items** before opening the PR:
   - `scripts/run-libc-tests.sh`
   - `scripts/run-posix-tests.sh`
   - `bash scripts/check-abi-version.sh` (run with `update` first, inspect the diff, then run without `update` to verify clean)
5. **Decide commit boundaries** per handoff-7's suggestion + the new commits:
   | # | Files | Summary |
   |---|-------|---------|
   | 1 | `wasm_api.rs`, `syscalls.rs` (handoff-7 Diffs 1+2) | fix mmap errno propagation + accept raw bo size |
   | 2 | `syscalls.rs` (handoff-7 Diffs 3+4 + session-8 Diff A unit test) | drain PAGE_FLIP synchronously into event_ring |
   | 3 | `host/src/kernel.ts`, `host/src/kernel-worker.ts` (session-8 Diffs B+C) | wire primeBindFromSab on DRI mmap |
   | 4 | `build-programs.sh`, `dri-smoke.test.ts`, `dri-modeset.test.ts`, `programs/dri-modeset.c` | test plumbing + retarget dri-modeset |
   | 5 | `syscalls.rs` (new GLIO handlers + cmdbuf mmap) | implement GLIO ioctl protocol for renderD128 GL sessions |
6. **Wait for user input before each commit** (standing instruction).
7. **Do not push at all** — branch lives on `Automattic/kandelo` only.

## Important constraints, do not violate (carry-forward from v1–v7)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch — for the GLIO work this is automatic because `kernel.ts` and `kernel-worker.ts` are shared. No browser-side edit needed.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input after each commit.

## Reference points

- This handoff and all prior: `docs/plans/2026-06-08-dri-kandelo-port-handoff{,-2,-3}.md`, `docs/plans/2026-06-09-dri-kandelo-port-handoff{-4,-5,-6,-7}.md`.
- GLIO ioctl ABI: `crates/shared/src/lib.rs:1812-2020` (`mod gl`).
- Host bridge entry points: `host/src/kernel.ts:713-852` (`host_gl_*` import handlers), `host/src/webgl/bridge.ts` (cmdbuf TLV walker), `host/src/webgl/muxer.ts` (per-context state switch).
- DRI mmap path: `crates/kernel/src/syscalls.rs:5872-5928` (extend here for offset==0).
- DRI ioctl dispatch: `crates/kernel/src/syscalls.rs:650-908` (extend `handle_dri_ioctl` here).
- C-side stubs: `libc/glue/libegl_stub.c` (eglInitialize → GLIO_INIT → mmap), `libc/glue/libglesv2_stub.c` (_wpk_gl_flush → GLIO_SUBMIT).
- Test that must pass: `host/test/dri-cube-pyramid.test.ts` (expects rc=0 on both sides + ≥2 distinct `switchTo` keys).
- The `host/dist/` staleness trap: see top of this doc. Rebuild via `cd host && npm run build` after any `host/src/` edit.
- The `PATH=/nix/var/nix/profiles/default/bin:$PATH` trap: also at the top of this doc.
