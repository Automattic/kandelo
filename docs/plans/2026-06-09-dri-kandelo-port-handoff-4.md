# DRI port onto kandelo:main — session 4 handoff

Continuation of [2026-06-08-dri-kandelo-port-handoff-3.md](./2026-06-08-dri-kandelo-port-handoff-3.md). Read that first — this doc only covers what changed in session 4.

## Goal (unchanged)

Land the entire DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. Replace the legacy standalone `apps/browser-demos/pages/modeset/` page (already absent in this tree) with a **Kandelo React UI pane** that hosts the Pavel fluid-sim demo. All five test gates from CLAUDE.md must pass before opening the PR.

## Branch policy (unchanged)

PR branch lives **entirely on `Automattic/kandelo`**, NOT on `mho22/wasm-posix-kernel`. See [memory/dri_port_branch_target.md](../../../../../.claude/projects/-Users-mho-Work-Projects-kandelo-wasm-posix-kernel/memory/dri_port_branch_target.md) (note: the memory file referenced in the v2/v3 handoffs does not actually exist on disk; policy is carried forward from those docs).

When ready: `git push upstream explore-direct-rendering-infrastructure` then `gh pr create --repo Automattic/kandelo --base main --head explore-direct-rendering-infrastructure …` (no `mho22:` fork prefix).

## Branch state at end of session 4

- Working branch: `explore-direct-rendering-infrastructure`.
- Four new commits landed in this session, all local:

```
ddb4e45d2 kandelo(dri): Modeset React pane + KandeloHost.attachKmsDisplay API   ← session-4 tip
d514eaed2 host(dri): kmsAttachCanvas/kmsAttachStats forwarding on both hosts
e1f09bea3 kernel-worker(dri): vblank pump + KMS presenter + getProcessMemory wire
76ee7b93f kernel(dri): wire host_gbm/kms/gl/proc imports through to host TS
50d7934b9 kernel(dri): wire mmap → gbm_bo_bind + fork/exec inheritance of DriOfdState
5fda79a90 kernel(dri): wire KMS card0 ioctls (master, modeset, page-flip, vblank)
78c464bde kernel(dri): wire PRIME_HANDLE_TO_FD / PRIME_FD_TO_HANDLE + close release
ecc8ceaa3 kernel(dri): wire dumb-buffer ioctls + DriOfdState install on open
2fa533577 kernel(dri): port DriOfdState / DriFdState / KmsFdState scaffold
9575d7824 kernel(dri): wire /dev/dri/{card0,renderD128} probe surface
2bffcfeb5 docs(dri): session handoff for dri-kandelo port
b25ef5942 dri+wpk: bring forward DRI/WebGL surface against kandelo:main
87b410b72 chore: pin third-party GitHub Actions to commit SHAs (#613) ← upstream/main
```

- **NOT pushed.** All ten DRI commits are local to the worktree. Push to `upstream` (= `Automattic/kandelo`) when greenlit.
- Working tree clean for the kernel/host files. Pre-existing submodule pointer drift on `libc/musl` and `tests/sortix/os-test` (untouched this session) plus untracked artifacts under `apps/browser-demos/test-results/`, `packages/registry/openssl/src/tls/`, and the `docs/plans/2026-0[567]-*` future-plan docs.

## What landed this session (4 commits)

### `76ee7b93f` — Commit 7: kernel.ts host-import wiring (+ kernel-side WasmHostIO bridge)

**The handoff plan named this commit as host-TS-only, but discovered the kernel-side `WasmHostIO` bridge was also missing — without it the new TS host imports would never be invoked.** Both halves landed together since they are the minimum unit that actually functions.

- `crates/kernel/src/wasm_api.rs`: new `extern "C"` declarations for `host_gbm_bo_{create,destroy,create_gpu,bind,unbind}`, `host_gl_{bind,unbind,create_context,destroy_context,create_surface,destroy_surface,make_current,submit,present,query,bind_foreign_texture}`, `host_kms_{set_master,drop_master,mode_info,addfb,rmfb,set_fb}`, `host_proc_{read,write}_bytes`. New `WasmHostIO` method impls forward each `HostIO` trait method to the matching extern. All additive — no existing extern, impl, or signature changed.
- `host/src/kernel.ts`: imports the existing `host/src/dri/{registry,kms-registry}` and `host/src/webgl/{registry,bridge,query,submit-queue,muxer,submit-drain}` modules. `WasmPosixKernel` instance fields `bos`/`kms`/`gl`/`foreignTextures`/`gl_submit_queue`/`gl_muxers` track per-pid state. `KernelCallbacks` gains `getProcessMemory?: (pid) => WebAssembly.Memory`. `buildImportObject` grows ~25 new host functions wired straight through to the registries. New private `writeKernelBytes` mirror of `readKernelBytes` for the query / mode-info / proc-read return paths.

**Gotcha for future-you:** `host_gbm_bo_create_gpu` looks up the compositor's GL context via `this.gl.get(2)?.gl`. Pid 2 is hardcoded as "the compositor" — when a real Kandelo compositor process is introduced this needs to switch to `kms.masterPid` or equivalent.

### `e1f09bea3` — Commit 8: kernel-worker.ts vblank pump + presenter

- `CentralizedKernelWorker` gains `getProcessMemory` callback into the kernel's `KernelCallbacks` so `host_gl_submit` / `host_gl_query` / `host_proc_{read,write}_bytes` can reach the per-pid wasm `Memory` registered in `this.processes`.
- New `attachKmsCanvas(crtc_id, canvas, statsSab?)` and `attachKmsStats(crtc_id, statsSab)` methods. The latter exists so WebGL-rendered demos can get page-flip telemetry without a 2D blit canvas.
- `startVblankPump()` runs `setInterval(1000/60)` and calls `tickVblank()`. The pump uses `.unref()` so Node process exit isn't blocked.
- `tickVblank()` calls `kernel_vblank()` to drain pending page-flips, then for each registered canvas pulls `kms.currentFb` + `kms.scanoutBytes`, blits opaque RGBA8888 into a per-CRTC cached `Uint8ClampedArray<ArrayBuffer>` (explicitly typed because `new ImageData(scratch, w, h)` rejects SAB-backed views under stricter TS), and `putImageData`s the result. Atomically writes (frame count, ts, width, height, blit µs) into stats slots 0..4. For every stats SAB ≥ 7 slots, writes `kernel_kms_commit_count` and `kernel_kms_last_frame_us` into slots 5/6.
- New accessor getters `get bos()` / `get gl()` / `get kms()` on the worker that delegate to `this.kernel`. The pre-existing `getKernel()` / `get framebuffers()` / `getProcessMemory()` accessors at `kernel-worker.ts:7145-7235` were NOT duplicated — when I first added them mid-class I hit `TS2393 Duplicate function implementation` and had to remove the dupes.

### `d514eaed2` — Commit 9: dual-host parity for kmsAttach*

- `host/src/{browser,node}-kernel-protocol.ts`: new `KmsAttachCanvasMessage { type: "kms_attach_canvas", crtcId, canvas: OffscreenCanvas, stats? }` and `KmsAttachStatsMessage { type: "kms_attach_stats", crtcId, stats }`. Both `MainToKernelMessage` unions extended.
- `host/src/{browser,node}-kernel-host.ts`: new `kmsAttachCanvas(crtcId, canvas, stats?)` and `kmsAttachStats(crtcId, stats)` methods. Browser host transfers the canvas (`postMessage(msg, [canvas])`); Node host passes it raw because Node lacks a native `OffscreenCanvas` and the worker no-ops when no polyfill is wired.
- `host/src/{browser,node}-kernel-worker-entry.ts`: new `case "kms_attach_canvas"` / `case "kms_attach_stats"` arms in the top-level main→worker switch, forwarding to `kernelWorker.attachKmsCanvas` / `attachKmsStats`.
- **CLAUDE.md §"Two hosts" §"PR #410" check:** the KMS attach messages are singleton kernel-worker messages (the OffscreenCanvas / stats SAB belong to the worker, not per-process). They do NOT need parallel wiring inside `handleSpawn`/`handleFork`/`handleExec`. PR #410's failure mode was per-process worker listeners that forgot the exec path; that doesn't apply here.

### `ddb4e45d2` — Commit 10: Modeset React pane + KandeloHost.attachKmsDisplay

- `web-libs/kandelo-session/src/kernel-host.ts`:
  - `KernelLike` gains optional `kmsAttachCanvas` / `kmsAttachStats` methods. `BrowserKernel` already implements them (commit 9), so just exposing them through the interface is enough.
  - New `KmsDisplayHandle` type with `crtcId`, `stats: Int32Array`, `close()`. Slot layout documented in the JSDoc.
  - `KernelHost` gains `attachKmsDisplay(canvas, crtcId?: number): KmsDisplayHandle | null`. Default `crtcId = 1` matches the single CRTC the kernel advertises via `MODE_GETRESOURCES`.
  - `LiveKernelHost.attachKmsDisplay` lazy-allocates a 64-byte SAB (7 i32 slots aligned to 64), transfers the canvas via `transferControlToOffscreen`, and forwards to `kernel.kmsAttachCanvas`. Returns null when the wrapped kernel lacks the method (older ABI) or the canvas can't be transferred (Node without polyfill).
- `apps/browser-demos/pages/kandelo/panes/Modeset.tsx`: new pane following the `Framebuffer` pattern. Attaches the canvas on `status === "running"` mount, polls the stats SAB at 4 Hz for the status bar (frame count, scanout WxH, blit µs, PAGE_FLIP commits, last flip µs). The CRTC id is a prop (defaults to 1) so a future multi-CRTC layout can mount multiple instances. Surfaces an error if the kernel ABI doesn't expose `attachKmsCanvas`.
- **The legacy `apps/browser-demos/pages/modeset/` standalone page was already gone** when session 4 started — nothing to drop. The v2/v3 handoffs were written against an older tree state.
- **Layout integration deferred:** the new pane is NOT wired into `MachineView` yet. Adding it requires extending the `PrimarySurface` union (currently `"terminal" | "framebuffer" | "web" | "syslog"`) and the `SurfaceAvailability` plumbing in `LiveKernelHost`. Punted to a follow-up so this commit could land focused.

## Test gate state at session end

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **929 passing**, 0 failed | Run before and after commit 7; clean |
| `cargo test -p wasm-posix-shared` | ❓ Not re-run | No shared crate changes |
| `cd host && npx vitest run` | ❌ **Cannot run locally** | Vitest's `global-setup.ts` needs `wasm32posix-cc` on PATH, which transitively needs an LLVM install (the dev shell runs `nix develop` to provide it). The Mac dev env here has neither. Compare `npx tsc --noEmit` error count instead — 30 pre/post-commit (host) and 66 in apps/browser-demos (8 fewer than pre, since the new `attachKmsDisplay` method satisfies previously-`any` references). **All 30 host errors and the apps/browser-demos errors are pre-existing**, not caused by these commits |
| `scripts/run-libc-tests.sh` | ❓ Not run | Needs LLVM / dev shell |
| `scripts/run-posix-tests.sh` | ❓ Not run | Needs LLVM / dev shell |
| `bash scripts/check-abi-version.sh` | ❌ **Drifted** | The check fails because `kernel_vblank` / `kernel_kms_commit_count` / `kernel_kms_last_frame_us` exports were added in commit 9575d7824 (commit 1) but the snapshot was never regenerated. Running `bash scripts/check-abi-version.sh update` produces a 16-line diff showing exactly those three additive entries; the script then accepts the diff as additive-compatible with no `ABI_VERSION` bump needed. **Per the v3 handoff plan, the regen lands in the closing Commit 12** alongside docs — DO NOT commit the regen in any other commit unless that policy changes |

## What's NOT done — the remaining commits before PR

Numbered by the planned landing order. Each is a self-contained commit.

### **Commit 11 (UI): wire Modeset into MachineView + layout** — NOT STARTED

The pane exists but is unreachable from the demo UI. The minimum hookup:

- `web-libs/kandelo-session/src/kernel-host.ts`: extend `PrimarySurface` (if it lives there — verify; it might be in `demo-config.ts` instead). Add `"modeset"` or `"kms"`. Extend `SurfaceAvailability` with the matching boolean.
- `LiveKernelHost`: refresh `surfaceAvailability.modeset` when `this.kernel.kmsAttachCanvas` is defined (treat the method's presence as availability — there is no `onChange` event for KMS state today, so this is set once on `attachKernel` and never updated).
- `apps/browser-demos/pages/kandelo/views/MachineView.tsx`: `surfaceLabel` arm for `"modeset"`; `resolveDemoSurface` may need to include it as a demo-spawnable surface. Decide whether the Modeset pane shares the Display slot (mutually exclusive with Framebuffer / WebPreview) or gets its own panel — the cheapest version is to extend the Display pane's switch with a third arm, but that conflates `/dev/fb0` and CRTC scanout. A separate "Modeset" surface in the layout dropdown is cleaner.
- `apps/browser-demos/pages/kandelo/panes/Display.tsx`: optionally branch to `<Modeset />` when the demo declares the modeset surface.
- A Kandelo demo descriptor that picks `modeset` as the primary surface — probably a new `images/vfs/demo-configs/modeset.json` or wherever the existing demos live; the v3 handoff didn't name a specific location. Look at how the fluid-sim / fbdoom demos declare themselves.

### **Commit 12 (Playwright spec)** — NOT STARTED

The v3 handoff said to look at `pages/network` or `pages/sqlite-test` Playwright specs and follow that pattern. Quick `find apps/browser-demos -name "*.spec.ts"` will turn them up. The smoke test should:

- Spawn `modeset` (binary already exists at `local-binaries/programs/wasm32/modeset.wasm`).
- Wait for the Modeset pane to show non-zero `stats.commitCount`.
- Optionally capture an OffscreenCanvas frame and assert it's not all zeros.

### **Commit 13 (closing): ABI snapshot regen + docs** — NOT STARTED

- `bash scripts/check-abi-version.sh update`, inspect `abi/snapshot.json` diff. The script already confirms this is an additive change (`kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`) — no `ABI_VERSION` bump needed.
- Docs per CLAUDE.md §Documentation: `architecture.md` (kernel KMS / DRI surface), `posix-status.md` (new ioctls), `porting-guide.md`, `browser-support.md` (the new OffscreenCanvas attachment path), `README.md` (mention the modeset demo).

## Gotchas discovered this session — read before touching the same areas

- **`Uint8ClampedArray<ArrayBuffer>` vs `Uint8ClampedArray<ArrayBufferLike>`.** TS's stricter generic insists `ImageData(data, w, h)` reject SAB-backed views. In commit 8 I had to type the cached scratch buffer as `Uint8ClampedArray<ArrayBuffer>` and construct it explicitly as `new Uint8ClampedArray(new ArrayBuffer(need)) as Uint8ClampedArray<ArrayBuffer>` so `new ImageData(scratch, w, h)` typechecks. The default `new Uint8ClampedArray(need)` returns `Uint8ClampedArray<ArrayBufferLike>` which fails the overload check.
- **Pre-existing accessors collide with new ones in `kernel-worker.ts`.** The class already has `getKernel()` / `get framebuffers()` / `getProcessMemory()` at line ~7145 and a tail block of methods. When adding new methods at the END of the class, do not redeclare these — TS will throw `TS2393 Duplicate function implementation`. Add only the genuinely new symbols.
- **Vitest can't run without LLVM.** The global-setup compiles `examples/thread-exit-group.c` synchronously before any test file loads. On a Mac dev env without LLVM (or without `scripts/dev-shell.sh` and a working `nix develop`), vitest exits before reporting whether any tests pass. Use `npx tsc --noEmit` as a proxy for "did I break the type-check," but treat it as advisory only — actual test-gate green is a CI-machine question for this session's tip.
- **The kernel-side WasmHostIO bridge is just as load-bearing as the host-TS imports.** The v3 handoff phrasing "the wasm imports the kernel now calls" was misleading — the kernel side didn't actually call them yet. Without the extern decls + impl in `wasm_api.rs`, the wasm module never references the new env imports, so the JS-side host functions sit unused. Both halves MUST land together; this is why commit 7 ended up being kernel+host instead of host-only.
- **Pid 2 is the hardcoded compositor in `host_gbm_bo_create_gpu`.** When a real Kandelo compositor process exists this needs replacement. Search for `this.gl.get(2)?.gl` in `host/src/kernel.ts` to find the call site.
- **`attachKmsDisplay` returns `null` on older kernels.** The Modeset pane shows an explicit error in this case — do NOT silently render an empty canvas, that confuses users into thinking the program never started.
- **`OffscreenCanvas.transferControlToOffscreen()` only works once.** If the pane unmounts and remounts (e.g. layout change), the second `attachKmsDisplay` call will throw `InvalidStateError`. Today's pane stores the handle in a ref and skips re-attach when it's already set — this works for the linear demo flow but won't survive layout-driven remounts. Track a fix in the layout-integration commit (11).

## Reference points

- **Session 1 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff.md`.
- **Session 2 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-2.md`.
- **Session 3 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-3.md`.
- **Snapshot tag**: `dri-kms-kernel-snapshot` (≅ `14026af9`). `git show dri-kms-kernel-snapshot:<path>` reads snapshot files without checking out. Still useful for any leftover host TS or apps-side bits that need porting (e.g. layout integration may reference the snapshot's `MachineView` shape).
- **Modeset binary**: `local-binaries/programs/wasm32/modeset.wasm` already exists (169871 bytes), built from `programs/modeset.c`. The wasm sysroot has `libGLESv2.a`, `libgbm.a`, `libEGL.a`, so the binary should run against the now-wired kernel.
- **Stats SAB slot layout** (documented on `KmsDisplayHandle` and in `Modeset.tsx` and `kernel-worker.ts:tickVblank`):
  - 0: frame count (host pump, monotonic)
  - 1: last blit timestamp (ms)
  - 2: scanout width
  - 3: scanout height
  - 4: last blit µs
  - 5: kernel-side PAGE_FLIP commit count
  - 6: kernel-side last frame µs

## Important constraints, do not violate

(Carried forward from v1+v2+v3 handoffs, unchanged.)

- **One PR.** Multiple commits in the branch is fine, but only one PR against `Automattic/kandelo`.
- **All five test gates green.** No partial-pass push. The ABI gate currently fails — Commit 13 fixes that.
- **Dual-host parity.** Every `host/src/kernel.ts` change has a matching change on both `node-kernel-worker-entry.ts` AND `browser-kernel-worker-entry.ts` (including `handleExec`, see CLAUDE.md §"Two hosts"). Verified for the commit-9 surface; future changes touching host code must re-run the symmetry grep.
- **No Asyncify, anywhere.**
- **Use the Kandelo React UI pane, not a legacy standalone page.** (The legacy page is already absent in this tree.)
- **Ask user before any destructive git operation** (force-push, reset --hard, branch delete).
- **Push to `Automattic/kandelo` directly, NOT `mho22/wasm-posix-kernel`.**
