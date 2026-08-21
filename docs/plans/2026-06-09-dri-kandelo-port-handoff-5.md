# DRI port onto kandelo:main — session 5 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-4.md](./2026-06-09-dri-kandelo-port-handoff-4.md). Read that first — this doc only covers what changed in session 5.

## Goal (unchanged)

Land the entire DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. Replace the (already-absent) legacy standalone modeset page with a Kandelo React UI pane that hosts Pavel's WebGL fluid sim. All five test gates from CLAUDE.md must pass before opening the PR.

## Branch policy (unchanged)

PR branch lives **entirely on `Automattic/kandelo`**, NOT on `mho22/wasm-posix-kernel`. Push to `upstream` only after greenlit. Eleven local commits as of session-5 tip — none pushed.

## Branch state at end of session 5

- Working branch: `explore-direct-rendering-infrastructure`.
- One new commit landed in this session, local-only:

```
873093270 kandelo(dri): wire Modeset surface into MachineView + modeset preset  ← session-5 tip
ddb4e45d2 kandelo(dri): Modeset React pane + KandeloHost.attachKmsDisplay API
…(see handoff-4 for commits 1–10)…
```

- **NOT pushed.** Working tree clean for the kernel/host/UI files. Same pre-existing submodule pointer drift on `libc/musl` and `tests/sortix/os-test`, and the same untracked artifacts as session 4.

## What landed this session (1 commit)

### `873093270` — Commit 11: Modeset surface in MachineView + modeset preset

The Modeset pane existed (committed in session 4 as `ddb4e45d2`) but was unreachable from the demo UI. This commit wires it into the Kandelo session machinery as a sibling to `framebuffer` / `web`.

**Surface name.** Chose **`"kms"`** (not `"modeset"`) for the new `PrimarySurface` variant. Rationale: the surface concept is the KMS pipeline (CRTC + PAGE_FLIP + GBM+GL); `modeset` is just the name of the binary that currently drives it. A future fluid-sim/Wayland-style binary on the same pipeline still mounts the same surface. Pane is still called `Modeset.tsx` (matches the binary), surface key in the union is `kms`.

**Why a sibling surface (not folded into `framebuffer`).** Even ignoring WebGL, `/dev/fb0` has 1 mmap'd buffer + no modeset/CRTC concept; `/dev/dri/card0` has N buffers, page-flip queue, modeset metadata, and (for this binary) a WebGL/EGL/GBM context that has no analog in fbdev. The Modeset pane also exposes different stats (PAGE_FLIP commits, vblank µs) than the Framebuffer pane (bound pid).

**Files touched:**

- `web-libs/kandelo-session/src/kernel-host.ts`
  - `PrimarySurface` union += `"kms"`.
  - `SurfaceAvailability.kms` added; `DEFAULT_SURFACE_AVAILABILITY.kms = false`.
  - `setSurfaceAvailability` no-op check extended to include `kms`.
  - New `refreshKmsAvailability()`: `kms: Boolean(this.kernel?.kmsAttachCanvas)`. There is no `onChange` event for kernel-side KMS state today, so this is set once on `attachKernel` and never updated — consistent with the v4 handoff's note.
  - Called from constructor, `attachKernel`, `detachKernel` (sets to false), `halt` (sets to false).

- `web-libs/kandelo-session/src/demo-config.ts`
  - `PRIMARY_SURFACES` parser set += `"kms"` (so VFS-side `demo.json` can declare `runningPrimary: ["kms", …]`).
  - `GenericDemoPresentationKind` += `"kms"`, with `genericDemoPresentation("kms")` returning `{ bootPrimary: "syslog", runningPrimary: ["kms", "terminal", "syslog"], terminalAccess: "drawer", internalsAccess: "drawer" }`.

- `web-libs/kandelo-session/src/demo-guides.ts`
  - `builtinDemoPresentation("modeset")` returns `genericDemoPresentation("kms")` so a stale VFS without an `/etc/kandelo/demo.json` still gets the right surface for the modeset preset.

- `apps/browser-demos/pages/kandelo/panes/Display.tsx`
  - New optional `surface?: PrimarySurface` prop. When `surface === "kms"` → mount `<Modeset/>`; `"framebuffer"` → `<Framebuffer/>`; `"web"` → `<WebPreviewPane/>`. Legacy fallback (`web` if a preview exists, else `framebuffer`) preserved for any caller that doesn't pass `surface`.

- `apps/browser-demos/pages/kandelo/views/MachineView.tsx`
  - `<Display surface={demoSurface ?? undefined} />` — the demo surface slot is now KMS-aware.
  - `surfaceLabel("kms") = "Modeset"`.
  - `resolveDemoSurface` accepts `web | framebuffer | kms`.

- `apps/browser-demos/pages/kandelo/presets.ts`
  - New `"modeset"` `Preset` entry: shell base, no extra packages, `bootCommand: ["bash", "-l", "-i"]`. Binary itself is staged separately (see live-setup).

- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
  - `LIVE_DEMO_IDS` += `"modeset"`.
  - `LIVE_PROFILE_SPECS.modeset = { image: "shell", features: ["kms"] }`. The shell VFS image is reused; the `modeset` binary is host-staged from `binaries/programs/wasm32/modeset.wasm` (or the local-binaries variant) via the existing `optionalBinaryUrl` glob pattern — same approach as fbtest.
  - New `LiveProfile.modesetDemo: boolean` (parallels `framebufferTest`).
  - `customVfsProfile`, software-profile, and `profileFor` constructors all set `modesetDemo`. `profileFor` flips it on when `normalized === "modeset"`.
  - In `bootProfile` post-init: `else if (profile.modesetDemo) { … spawnLazy(kernel, "/usr/local/bin/modeset", modesetWasmUrl, ["modeset"], tick); }` — mirrors fbtest staging.
  - `genericPresentationForProfile` now picks `"kms"` when `profile.modesetDemo || features.includes("kms")` **before** the framebuffer check.
  - `liveDemoIdForVfsImageUrl` fallback now excludes `modeset` (alongside `doom`) so a bare shell-image URL without a hash doesn't auto-launch the modeset binary.

## Test gate state at session end

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **929 passing**, 0 failed | No kernel touch this session; ran clean. |
| `cd host && npx vitest run` | ⛔ **Blocked locally** | `wasm32posix-cc` not on PATH; needs nix dev shell. `nix` is not installed in this worktree env (`which nix` → not found), so `scripts/dev-shell.sh bash` can't run either. CI gate. |
| `cd apps/browser-demos && npx tsc --noEmit` | ⚠️ 68 errors, **all pre-existing** | Compared per-file: my modified files surface only the long-standing `live-setup.ts:260` `isWebKitLikeBrowser()` boolean-called-as-function bug + the same Vite-import warnings handoff-4 noted. No new errors introduced. Treat as advisory (handoff-4's policy). |
| `cd host && npx tsc --noEmit` | ⚠️ 9 host/src errors, all pre-existing | Vite `?url`/`?worker&url` module typings + `ImportMeta.env`. Untracked openssl files add 124 more rootDir errors that aren't this branch's problem. |
| `scripts/run-libc-tests.sh` | ⛔ Blocked locally | Same toolchain gate. |
| `scripts/run-posix-tests.sh` | ⛔ Blocked locally | Same toolchain gate. |
| `bash scripts/check-abi-version.sh` | ❌ **Still drifted** (expected) | Same three additive exports as in v4: `kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`. Per the v3/v4 policy the regen lands in the closing commit, NOT here. |

## What's NOT done — the remaining commits before PR

### **Commit 12 (Playwright spec)** — NOT STARTED

The v3/v4 handoffs said to look at `pages/network` or `pages/sqlite-test` Playwright specs and follow that pattern. `find apps/browser-demos -name "*.spec.ts"` will turn them up. The smoke test should:

- Spawn `modeset` (binary is at `local-binaries/programs/wasm32/modeset.wasm`, 169871 bytes per v4).
- Wait for the Modeset pane to show non-zero `stats.commitCount` (slot 5 in the SAB).
- Optionally capture an OffscreenCanvas frame and assert it's not all zeros.

Reachable URL: with the new preset live, `/?demo=modeset` should boot the shell, stage `/usr/local/bin/modeset`, spawn it, and surface the Modeset pane as the demo slot.

### **Commit 13 (closing): ABI snapshot regen + docs** — NOT STARTED

- `bash scripts/check-abi-version.sh update`, inspect `abi/snapshot.json` diff. The script already confirms this is an additive change (`kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`) — no `ABI_VERSION` bump needed.
- Docs per CLAUDE.md §Documentation: `architecture.md` (kernel KMS / DRI surface), `posix-status.md` (new ioctls), `porting-guide.md`, `browser-support.md` (the new OffscreenCanvas attachment path + KMS demo metadata), `README.md` (mention the modeset demo).

## Gotchas discovered this session

- **Pavel's modeset.c uses EGL/GLES2/GBM** — verified by inspecting `programs/modeset.c`. So the KMS pipeline isn't just "a fancier framebuffer"; it carries a WebGL context the host renders via the `host_gl_*` bridge. The `Modeset` pane today still does a `putImageData` 2D blit (per `kernel-worker.tickVblank()`), but the GPU presentation path through `host_gl_present` is wired and waiting for the next demo iteration. **Implication**: keep `kms` as a sibling surface — it can't be folded into `framebuffer` even if you wanted to, because `/dev/fb0` has no GL context.
- **`isWebKitLikeBrowser` boolean-called-as-function bug** at `live-setup.ts:260` is **pre-existing** (the const is declared boolean on lines 258-259 then called on 260). Not in scope for this commit; flag if you tidy it.
- **Multiple presets sharing the shell VFS image** now includes `doom` AND `modeset`. The `liveDemoIdForVfsImageUrl` fallback path used to do `matches.find((id) => id !== "doom")`; I extended it to also exclude `modeset` so a bare shell-image URL without `#modeset` hash doesn't accidentally auto-launch the modeset binary. The `#modeset` hash still wins via the earlier `isLiveDemoId(hashId) && baseUrl === profileVfsBaseUrl(hashId)` check.
- **The Modeset pane's `attachKmsDisplay` returns null on older kernels**, and its `transferControlToOffscreen()` only fires once per canvas (see v4 gotchas). The new layout integration mounts Display once per demo surface change; if the user pins a different primary and comes back, the Modeset effect's `handleRef.current` guard short-circuits the re-attach. Track a clean detach API on `KmsDisplayHandle.close()` (today it's a no-op) before any layout shuffler can remount this pane in production.
- **Vitest still cannot run without LLVM** locally — same as v4. The TS `--noEmit` check is the only available proxy on this Mac without nix.

## Reference points

- **Session 1 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff.md`.
- **Session 2 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-2.md`.
- **Session 3 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-3.md`.
- **Session 4 handoff**: `docs/plans/2026-06-09-dri-kandelo-port-handoff-4.md`.
- **Modeset binary**: `local-binaries/programs/wasm32/modeset.wasm` (169871 bytes) — Pavel fluid sim via EGL/GLES2/GBM. Source: `programs/modeset.c`.
- **Stats SAB slot layout** (unchanged from v4):
  - 0: frame count (host pump)
  - 1: last blit timestamp (ms)
  - 2: scanout width
  - 3: scanout height
  - 4: last blit µs
  - 5: kernel-side PAGE_FLIP commit count
  - 6: kernel-side last frame µs
- **New surface key**: `"kms"` in `PrimarySurface` union (kernel-host.ts:312-ish). Pane name is still `Modeset`.

## Important constraints, do not violate

(Carried forward from v1–v4, unchanged.)

- **One PR.** Eleven commits in the branch is fine; one PR against `Automattic/kandelo`.
- **All five test gates green.** No partial-pass push. ABI gate still fails — Commit 13 fixes that.
- **Dual-host parity.** No host code touched this session (the changes are kandelo-session + UI). If Commit 12 or 13 touches `host/src/`, re-apply the symmetry grep.
- **No Asyncify, anywhere.**
- **Use the Kandelo React UI pane, not a legacy standalone page.**
- **Ask user before any destructive git operation** (force-push, reset --hard, branch delete).
- **Push to `Automattic/kandelo` directly, NOT `mho22/wasm-posix-kernel`.**
