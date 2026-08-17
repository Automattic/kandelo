# DRI port onto kandelo:main — session 11 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-10.md](./2026-06-09-dri-kandelo-port-handoff-10.md). Read that first — this doc only covers what changed in session 11, plus a real bug that blocks the demo verification gate.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle. Wait for user input before each commit.

## TL;DR for next session

1. **Cleanup-then-rebuild path worked** (handoff-10 option (c)). Deleted the 14 stale-ABI binaries from `local-binaries/programs/wasm32/` AND the matching `~/.cache/kandelo/programs/<pkg>-*` directories. Re-ran `prepare-browser` with the SpiderMonkey SDK env var; 64/64 packages resolved, `lamp.vfs.zst` (43 MB) + `wordpress.vfs.zst` (40 MB) composed cleanly. **The 8 `build.toml` revision bumps from handoff-10 were never in the working tree to begin with.** The cache-bust question remains open as a postmortem (§"Open postmortem" below) but unblocked the PR path.
2. **Real bug fixed: KMS attach × React StrictMode.** `LiveKernelHost.attachKmsDisplay` was unconditionally calling `canvas.transferControlToOffscreen()`, which throws "Cannot transfer control from a canvas for more than one time." on React 18 StrictMode's second effect-mount. Fixed by memoizing the handle in a `WeakMap<HTMLCanvasElement, KmsDisplayHandle>` on `LiveKernelHost`. The first-call semantics are unchanged.
3. **Real bug found, NOT fixed: GL canvas auto-wire is missing for production demos.** The host-side WebGL2 bridge's `attachCanvas(pid, canvas)` is **only ever called by `host/test/dri-cube-pyramid.test.ts:126,196`**. No production caller in `host/src/`, `web-libs/`, or `apps/browser-demos/` wires a real demo's `pid` to a real `<canvas>`, so `host_gl_create_context` returns early at `host/src/kernel.ts:740` (the `if (!b.canvas) return;` guard), `b.gl` stays `null`, every subsequent `host_gl_submit` no-ops, and Pavel's fluid sim (`programs/modeset.c`) silently fails every shader compile/link. The PAGE_FLIP counter still ticks because the binary continues to call `drmModePageFlip` against the uninitialized scanout BO — explaining the user-observed symptom: **counter ticking, canvas blank, 27× `shader compile FAILED [name]:` in dmesg**.
4. **The user picked option A** (auto-wire on KMS scanout binding) to fix #3. **The work was NOT started this session.** Stub design + architectural conflict are documented below.

## Confirmed green / unchanged from session 10

- Gate 1 (cargo): `cargo test -p kandelo --target aarch64-apple-darwin --lib` — **green** at end of session 10. **Not re-run this session** (no kernel-side changes made).
- Gate 5 (ABI): `bash scripts/check-abi-version.sh` — **not re-run this session** but `abi_constants.h`, `abi/snapshot.json`, and `crates/shared/src/lib.rs` are unchanged from handoff-10.
- Gate 3 (libc) / Gate 4 (POSIX): unchanged from handoff-10 (no kernel rebuild this session).

## Gate 2 (vitest) — caveats

Re-ran `cd host && npx vitest run` with the post-fix tree: **798 passed / 5 failed / 19 skipped** across 114 test files (4 files failed, 104 passed, 6 skipped). Handoff-10 reported "668 / 0 / 151 skipped (86 files / 28 skip)" — different totals because the WordPress vitest specs were **skipped** in handoff-10 (no built binary) and now run for the first time (binary built during this session's `prepare-browser-3`). The 5 failures concentrate in `packages/registry/wordpress/test/wordpress-site-editor.test.ts` — at least one failure is a 10-minute install timeout ("WordPress install did not complete within 10 minute…" at `:189-191`, error at `:267`), strongly suggesting environment-load flakes during a hot system (`prepare-browser-3` ran for ~30 minutes finishing the WP/LAMP composes). The kernel-host.ts memoization edit only touches `attachKmsDisplay`, which no vitest spec invokes; it cannot cause these failures.

**Next session must re-run vitest cleanly on an idle system before the PR** to confirm whether the 5 WP failures are env-induced flakes or real regressions. If they survive a clean run, they need a fix or a documented skip before the PR.

## What worked

### Cleanup-then-rebuild (option C from handoff-10)

```bash
rm -f local-binaries/programs/wasm32/{coreutils,gawk,grep,m4,make,sed}.wasm
rm -rf local-binaries/programs/wasm32/{diffutils,findutils}/
rm -rf ~/.cache/kandelo/programs/{coreutils,diffutils,findutils,gawk,grep,m4,make,sed}-*

WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
  PATH=/nix/var/nix/profiles/default/bin:$PATH \
  scripts/dev-shell.sh bash -c './run.sh prepare-browser'
```

Outcome: all 8 packages source-rebuilt at v15 (mtimes Jun 9 16:04–16:07); `lamp.vfs.zst` 43 MB / `wordpress.vfs.zst` 40 MB composed cleanly; `fetch-binaries: resolved=64 total=64 skipped=14`. Verified ABI per artifact via inline TS using `host/src/constants.ts:extractAbiVersion`.

### StrictMode KMS-attach fix (the one edit ready to commit)

File: `web-libs/kandelo-session/src/kernel-host.ts` (~10 lines added).

Added a class field:
```ts
private kmsHandles = new WeakMap<HTMLCanvasElement, KmsDisplayHandle>();
```

And memoized `attachKmsDisplay`:
```ts
const cached = this.kmsHandles.get(canvas);
if (cached) return cached;
// ... existing transferControlToOffscreen + kmsAttachCanvas ...
this.kmsHandles.set(canvas, handle);
return handle;
```

Purely additive. First-call semantics unchanged. WeakMap allows the handle to drop naturally when the canvas is GC'd. Comment in the source explains the StrictMode reason — leave that comment in place.

### Playwright spec regex fix

File: `apps/browser-demos/test/kandelo-modeset.spec.ts` (~2 lines).

Changed:
```ts
.toMatch(/[1-9]\d*\s+flips/);
```
to:
```ts
// Pane CSS applies text-transform: uppercase, so match case-insensitively.
.toMatch(/[1-9]\d*\s+flips/i);
```

The pane header is `style.textTransform = "uppercase"` (`apps/browser-demos/pages/kandelo/panes/Modeset.tsx:131`), so the rendered string is `121342 FLIPS · 56µs`, not `… flips ….`. After both edits + a fresh `prepare-browser-3`, the spec **passes in 3.0s** against the running vite at `http://localhost:5401`.

But: the passing spec is **misleading**. It only verifies the kernel-side PAGE_FLIP counter ticks. The actual canvas is blank because of bug #3 below. The spec needs to be augmented with a pixel-content check before it can stand in for "demo verifies" — note this in the PR description.

## The real bug — production GL canvas auto-wire is missing

### Symptom (user-observed at `http://localhost:5401/?demo=modeset`)

- Boot log reaches `kandelo: spawning modeset...` at t≈0.45s
- Then 27 dmesg lines: 9× `shader compile FAILED [name]:` (vertex) + 9× `shader compile FAILED [name]:` (fragment) + 9× `program link FAILED [name]:` — for curl/vorticity/divergence/clear/pressure/gradsub/advect/splat/display, in that order
- Canvas stays blank
- Flip counter ticks (and ticks fast — well above 60 Hz per the user's reading)

### Root cause

The GL bridge expects an `attachCanvas(pid, canvas)` call to bind the demo process's `pid` to an HTMLCanvasElement/OffscreenCanvas before that process calls `eglCreateContext`. In production code paths, **nothing calls it**.

Reproduction: `grep -rn "attachCanvas\|attachGlCanvas" host/src/ web-libs/ apps/browser-demos/` — only the registry definition itself (`host/src/webgl/registry.ts:165`) and the cube-pyramid vitest fixture (`host/test/dri-cube-pyramid.test.ts:126,196`) match.

Code path that fails silently:
1. `live-setup.ts:1039` — `void spawnLazy(kernel, "/usr/local/bin/modeset", modesetWasmUrl, ["modeset"], tick);` — spawns the binary, but **only** spawns. No `attachCanvas` call follows.
2. modeset.c → `eglCreateContext` (programs/modeset.c:821) → `host_gl_create_context` (`host/src/kernel.ts:729-757`).
3. `host/src/kernel.ts:740`: `if (!b.canvas) return;` — fires because no one attached. The function returns before constructing a WebGL2 context.
4. `b.gl` stays `null`.
5. Each `host_gl_submit` from the binary returns at `host/src/kernel.ts:788` (`if (!b.forward && !b.gl) return;`) — every shader compile, link, draw call is a host-side no-op.
6. From the binary's perspective: `glGetShaderiv(sh, GL_COMPILE_STATUS, &ok)` returns 0 (uninitialized; the bridge never wrote a status back), so each `compile_shader()` (modeset.c:275-289) and `link_program()` (modeset.c:291-306) prints its FAILED log line.
7. Render loop continues. `eglSwapBuffers` (modeset.c:897) returns success (no real GPU to swap). `drmModePageFlip` (`kms_pageflip_wait`, modeset.c:898) succeeds because the KMS path is independent of GL. The kernel ticks `kms.commit_count[crtc_id]`. The KMS pump blits the (uninitialized / all-zeros) scanout BO via `canvas.getContext("2d") → putImageData` (kernel-worker.ts:8329-8364). Canvas stays blank because the BO contains no rendered pixels.

### Why this wasn't caught earlier

- Gate 1 (cargo) doesn't touch the host-side GL bridge.
- Gate 2 (vitest) has `dri-modeset.test.ts` and `dri-cube-pyramid.test.ts`. The former uses the `dri-modeset.wasm` **test fixture** which doesn't compile shaders (it's the short-lived libdrm/libgbm CLI from session 9, see `programs/dri-modeset.c:1-35`). The latter manually calls `kernel.gl.attachCanvas(childPid, fakeCanvas)` at `:126,196` — masking exactly this missing wire.
- Gates 3/4 don't run user binaries.
- Gate 5 is structural.
- The Playwright spec I wired up regex-passes because it only checks the flip-counter string, not pixel content.

The wiring gap is the kind that "all green, demo broken" fails to catch unless the spec asserts on rendered pixels.

## Option A — fix sketch (what the user picked, NOT implemented)

**Goal:** auto-attach the KMS-registered OffscreenCanvas to whichever process creates a WebGL2 context against the same CRTC.

### Where the canvas lives

- `web-libs/kandelo-session/src/kernel-host.ts:1465` `attachKmsDisplay(canvas, crtcId)` calls `canvas.transferControlToOffscreen()` and hands the resulting `OffscreenCanvas` to `kernel.kmsAttachCanvas(crtcId, offscreen, statsSab)`.
- `host/src/browser-kernel-host.ts:826` `kmsAttachCanvas` forwards into the kernel worker.
- `host/src/kernel-worker.ts:8299` `attachKmsCanvas(crtc_id, canvas, statsSab)` stores `canvas` in `this.kmsCanvases: Map<number, OffscreenCanvas>` (`:783`), eagerly calls `canvas.getContext("2d")` (line 8304) to set up the CPU-blit path, and starts the vblank pump.

### The architectural conflict — read this before coding

**A single canvas can only have ONE context type.** Once `getContext("2d")` succeeds on an OffscreenCanvas, every later `getContext("webgl2")` on the same canvas returns `null` (and vice versa). Today's KMS pump grabs the 2D context at attach time (kernel-worker.ts:8304). If we also want `host_gl_create_context` (kernel.ts:741) to grab `webgl2` on the same OffscreenCanvas, the 2D acquisition must move out of the eager path.

This means option A is not just "add a call to `gl.attachCanvas`". It is:

1. **Decouple 2D-context acquisition from `attachKmsCanvas`.** Store the OffscreenCanvas eagerly, but defer `getContext` until first use, OR pick the context type based on which path arrives first.
2. **Track which context type each CRTC's canvas holds** (`kmsContextMode: Map<crtcId, "2d" | "webgl2">`).
3. **Wire `host_gl_create_context` to query the KMS canvas registry** for the pid's CRTC and attach if found.
4. **Tell the vblank pump (kernel-worker.ts:8329 `tickVblank`) to skip the CPU blit when the canvas is owned by `webgl2`.** The KMS commit counter (slots 5/6) still ticks unconditionally — that's the kernel-side state, not pixel state.
5. **Decide what `eglSwapBuffers` means for a WebGL2-owned canvas.** In Pavel's port the `display` pass writes to the default framebuffer, so the OffscreenCanvas already shows the right pixels after the draw. `eglSwapBuffers` in this world is roughly a `gl.flush()` (already implicit each tick). The PAGE_FLIP ioctl from the user program still drives the kernel-side commit counter — that's correct as long as nothing relies on the scanout BO actually mirroring what's on the canvas.
6. **Match pid ↔ CRTC.** The kernel-side tracks DRM master via `this.kernel.kms.isMasterPid(pid)` (already used by `gl_submit_queue` at `host/src/kernel.ts:183`). Use that: at `host_gl_create_context`, if `b.canvas == null` AND the kernel reports the pid is master on a CRTC, look up `this.kmsCanvases.get(crtcId)` and attach. If multiple CRTCs ever land (today: one), iterate.

### Minimal implementation skeleton (NOT YET WRITTEN)

```ts
// host/src/kernel-worker.ts — make context acquisition lazy
attachKmsCanvas(crtc_id, canvas, statsSab) {
  this.kmsCanvases.set(crtc_id, canvas);            // store offscreen
  // DEFER getContext until tickVblank or gl attach; do NOT eagerly grab 2D
  if (statsSab) this.kmsStatsViews.set(crtc_id, new Int32Array(statsSab));
  this.startVblankPump();
}

// Pick context lazily, exclusively per crtc
private ensureKmsContext(crtc_id, prefer: "2d" | "webgl2"): boolean {
  if (this.kmsContextMode.has(crtc_id)) return this.kmsContextMode.get(crtc_id) === prefer;
  const canvas = this.kmsCanvases.get(crtc_id);
  if (!canvas) return false;
  if (prefer === "2d") {
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    this.kmsContexts.set(crtc_id, ctx);
    this.kmsContextMode.set(crtc_id, "2d");
  } else {
    this.kmsContextMode.set(crtc_id, "webgl2");   // kernel.ts will create the WebGL2 ctx itself
  }
  return true;
}

// host/src/kernel.ts — wire host_gl_create_context to KMS
host_gl_create_context: (pid, ctxId, ...) => {
  const b = this.gl.get(pid);
  if (!b) return;
  b.contextId = ctxId;
  if (b.forward) { b.forward.onCreateContext(); return; }
  if (!b.canvas) {
    // Auto-attach the KMS canvas for whichever CRTC `pid` holds master on.
    // The kernel-side state model (KmsState) tracks master ownership.
    const crtc = this.kms.masterCrtcForPid(pid);             // NEW helper, see below
    if (crtc != null && this.callbacks.getKmsCanvas) {
      const canvas = this.callbacks.getKmsCanvas(crtc);      // wires to kernel-worker.kmsCanvases
      if (canvas) {
        this.gl.attachCanvas(pid, canvas);
        b.canvas = canvas;
      }
    }
  }
  if (!b.canvas) return;
  const ctx = b.canvas.getContext("webgl2", { ... }) as WebGL2RenderingContext | null;
  // ... existing extension enabling ...
  b.gl = ctx;
}

// host/src/kernel-worker.ts — vblank pump skips CPU blit when GL owns the canvas
private tickVblank() {
  vblankFn?.();
  for (const [crtc_id, ctx] of this.kmsContexts) {
    if (this.kmsContextMode.get(crtc_id) !== "2d") continue;   // GL paints directly
    // ... existing kernel.kms.scanoutBytes + putImageData blit ...
  }
  // ... existing slot 5/6 updates (unconditional) ...
}
```

### Open question on master-tracking

`this.kms.masterCrtcForPid(pid)` doesn't exist yet. Two options:

- **(A.1)** Add it as a new export on the WasmPosixKernel Rust side, then expose through `this.kms` on the host. ABI-additive (no version bump needed since it's a new export). This is the cleanest match for "auto-wire to KMS scanout binding".
- **(A.2)** Heuristic without master-tracking: "first eglCreateContext caller after any kmsAttachCanvas gets the canvas for crtc 1". This works for the present `one-CRTC, one-renderer` reality but is brittle for any future multi-renderer demo. Document the heuristic loudly. ~5 lines.

Both work for the modeset demo today. (A.1) is the right shape long-term. If you go (A.1), it'll add a kernel export — check whether `bash scripts/check-abi-version.sh` flags it as additive-only (it should; new exports don't bump `ABI_VERSION`).

### Estimated diff size

- (A.1) full version: ~150 lines across kernel-worker.ts + kernel.ts + a small Rust helper + a callback prop on `KernelCallbacks`.
- (A.2) heuristic: ~30–50 lines.

The user picked option A explicitly. (A.1) is the recommended shape, (A.2) is the smaller fallback.

## Open postmortem — handoff-10's revision-bump mystery

Background: handoff-10 claimed bumping `revision` in 8 `build.toml` files **didn't** invalidate the xtask resolver cache. Session 11 found:

- The 8 bumps **were not in the working tree** at session 11 start (`git status -s packages/registry/` reported clean for all 8). Either they were never made, were stashed elsewhere, or were reverted between handoff-10 being written and session 11 starting.
- The xtask test suite at `tools/xtask/src/build_deps.rs:3122-3151` asserts `cache_key_sha` **does** include `build.toml.revision`. So in theory a bump should invalidate.
- After our cleanup-then-rebuild, all 8 packages source-rebuilt cleanly. The `~/.cache/kandelo/programs/` dirs that exist post-rebuild still show `rev2` / `rev1` (matching the unchanged `build.toml`), so the resolver IS using the current revision — but the cache hit happens because the same `cache_key_sha` is reproducible against the same recipe.

The actual mystery: in handoff-10 the user reported that even with bumped revisions the rebuild produced the same v14 `coreutils.wasm`. If the bumps really were applied at that point, the most likely explanation is **`xtask build-deps` short-circuited on the existing `local-binaries/programs/wasm32/coreutils.wasm` without re-resolving** (it pre-validated the artifact via path heuristic, not via `cache_key_sha`). The session-11 cleanup worked precisely because it removed both the artifact and the cache. Worth a one-liner in `tools/xtask/src/build_deps.rs:894-935` next session: a comment explaining that **clearing `local-binaries/` is required**, not just bumping revisions, to force a stale-artifact re-resolve. That avoids the next dev hitting the same surprise.

CLAUDE.md currently says:

> **Bumping `build.toml.revision = N` invalidates every cached archive for that package.**

This is true for the **cache** but not for the **install side**. Suggest amending to:

> Bumping `build.toml.revision = N` invalidates every cached archive for that package. **Note:** `local-binaries/programs/wasm32/<pkg>.wasm` is the install destination, not part of the cache key. A bump alone won't re-resolve a stale local-binaries artifact; delete it first if you want to force a rebuild.

Don't make that doc edit until next session can confirm the install-side short-circuit empirically.

## Working-tree state at end of session 11

```
Modified (uncommitted) — same as handoff-10 plus:
  web-libs/kandelo-session/src/kernel-host.ts            # SESSION 11 — KMS-attach StrictMode memoization
  apps/browser-demos/test/kandelo-modeset.spec.ts        # SESSION 11 — regex /flips/i (case-insensitive)
                                                          # (file was untracked in handoff-10; now still untracked, edited)

Unchanged from handoff-10 (also still in working tree):
  crates/kernel/src/wasm_api.rs                          # handoff-7 Diff 1
  crates/kernel/src/syscalls.rs                          # handoff-7 Diffs 2/3/4 + handoff-8 Diff A + session-9 Diff D
  crates/shared/src/lib.rs                               # session-9 Diff E (ABI 15)
  host/src/kernel.ts                                     # handoff-8 Diff B
  host/src/kernel-worker.ts                              # handoff-8 Diff C
  scripts/build-programs.sh                              # handoff-7 Diff 8
  host/test/dri-smoke.test.ts                            # handoff-7 Diff 5
  host/test/dri-modeset.test.ts                          # handoff-7 Diff 6 retarget
  abi/snapshot.json                                      # session-9 Diff E (regenerated)
  host/src/generated/abi.ts                              # session-9 Diff E (regenerated)
  libc/glue/abi_constants.h                              # session-9 Diff E (regenerated)

New (untracked) — same as handoff-10 plus session-11 doc:
  programs/dri-modeset.c                                 # handoff-7 Diff 6 new fixture
  apps/browser-demos/test/kandelo-modeset.spec.ts        # handoff-9, edited in session 11
  docs/plans/2026-06-09-dri-kandelo-port-handoff-11.md   # THIS FILE
```

Plus the prior session's untracked: `sysroot64/`, `local-binaries/...`, `host/dist/*` (all gitignored).

Per-session-10 the 8 `packages/registry/<pkg>/build.toml` revision bumps are **NOT** present.

## Things the next session MUST do — in order

1. **DO NOT proceed to the 6-commit boundary plan yet.** The user explicitly asked to see pixels rendering in the canvas before any commits.

2. **Implement option A.** Auto-wire the KMS-registered OffscreenCanvas to the modeset process's GL binding so `host_gl_create_context` finds a canvas to bind WebGL2 to. Sketch above. Touches:
   - `host/src/kernel-worker.ts` — make `attachKmsCanvas` defer the `getContext` choice; add `ensureKmsContext(crtc, "2d"|"webgl2")`; have `tickVblank` skip the CPU blit when GL owns the canvas.
   - `host/src/kernel.ts` — in `host_gl_create_context`, when `b.canvas == null`, look up the master-pid's CRTC and auto-attach.
   - **(A.1) only):** add a kernel-side `kms_master_crtc_for_pid` Rust helper + export it. Verify additive ABI (no `ABI_VERSION` bump).
   - `host/src/webgl/registry.ts` — verify `attachCanvas` works with an OffscreenCanvas (signature already accepts `HTMLCanvasElement | OffscreenCanvas`).
   - Possibly `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` — no edit expected unless you want to make the pane display a banner while WebGL2 initializes.

3. **Verify the fix in the browser.** Run `./run.sh browser` (or `npx vite --port 5401 --strictPort` from `apps/browser-demos/` if prepare-browser is already cached), open `http://localhost:5401/?demo=modeset`, confirm Pavel's fluid sim is rendering on the canvas. Move the mouse over the canvas — Pavel's sim splats velocity + dye on pointer input. Watch dmesg: the 27 `shader compile FAILED` lines should be **gone**.

4. **Upgrade the Playwright spec.** `apps/browser-demos/test/kandelo-modeset.spec.ts` currently checks flip count only. Add a pixel-content check: grab `await page.locator("canvas").screenshot()`, decode, assert at least one pixel is non-zero (or non-`var(--k-fb-bg)`). Otherwise this spec keeps passing on shader-fail-but-flip-tick regressions.

5. **Re-confirm gates 1, 2, 5 are clean on an idle system.** Gates 3, 4 if you have the time (slow; reuse handoff-10's status if working-tree changes don't touch the kernel/musl side).
   - **Important:** the 5 vitest fails in session 11 (WordPress site-editor) need either (a) to vanish on a clean run (env-induced flakes), (b) a `test.skip` with a docs reference, or (c) a real fix. If still red, surface to the user before committing.

6. **Update the 6-commit plan to include the new work.** Session 10's plan (commits #1 through #6) was scoped around uncommitted modifications in the working tree as of handoff-10. Session 11 added two more file-level changes that need to land somewhere. Suggested adjustment:

   | # | Files | Summary |
   |---|-------|---------|
   | 1 | `wasm_api.rs`, `syscalls.rs` (handoff-7 Diffs 1+2) | fix mmap errno propagation + accept raw bo size |
   | 2 | `syscalls.rs` (handoff-7 Diffs 3+4 + handoff-8 Diff A unit test) | drain PAGE_FLIP synchronously into event_ring |
   | 3 | `host/src/kernel.ts`, `host/src/kernel-worker.ts` (handoff-8 Diffs B+C) | wire primeBindFromSab on DRI mmap |
   | 4 | `build-programs.sh`, `dri-smoke.test.ts`, `dri-modeset.test.ts`, `programs/dri-modeset.c`, **`apps/browser-demos/test/kandelo-modeset.spec.ts` (case-insensitive flips regex + new pixel-content assertion)** | test plumbing + retarget dri-modeset + modeset Playwright spec |
   | 5 | `syscalls.rs` (session-9 Diff D — handlers + cmdbuf mmap + 5 unit tests) | implement GLIO ioctl protocol for renderD128 GL sessions |
   | 6 | `crates/shared/src/lib.rs`, `abi/snapshot.json`, `host/src/generated/abi.ts`, `libc/glue/abi_constants.h` | bump ABI_VERSION 14→15 + regenerate snapshot |
   | **7 (NEW)** | **`web-libs/kandelo-session/src/kernel-host.ts` (StrictMode KMS-attach memoization), `host/src/kernel.ts` (host_gl_create_context auto-attach), `host/src/kernel-worker.ts` (defer KMS context acquisition, skip 2D blit when GL owns canvas), possibly a kernel-side `kms_master_crtc_for_pid` Rust helper if going (A.1)** | **host(dri): wire KMS scanout canvas to WebGL2 GL session + memoize KMS attach across StrictMode remounts** |

   Wait for user input before each commit — standing instruction.

## Important constraints, do not violate (carry-forward from v1–v10)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch — kernel-worker.ts is shared, kernel.ts is shared. Confirm both hosts work after option A lands.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input before each commit.

## Reference points (additions in session 11)

- KMS attach memoization site: `web-libs/kandelo-session/src/kernel-host.ts:1457-1490` (the `attachKmsDisplay` method); the `kmsHandles` field was added near the other private fields around `:713-714`.
- Production `attachCanvas` callers — only test code: `host/test/dri-cube-pyramid.test.ts:126,196`. Anyone else who needs WebGL2 has to go through `host_gl_create_context` (`host/src/kernel.ts:729-757`) which requires `b.canvas != null` to do anything useful.
- KMS-canvas storage: `host/src/kernel-worker.ts:783` (`kmsCanvases: Map<number, OffscreenCanvas>`), `:8299` (`attachKmsCanvas`), `:8329` (`tickVblank` blit loop).
- The 27 `shader compile FAILED` log lines come from `programs/modeset.c:286` (`compile_shader`) and `:303` (`link_program`). Both return the failed object instead of bailing — so render loop continues, eglSwapBuffers / drmModePageFlip keep ticking the flip counter against an uninitialized scanout BO.
- Modeset preset's spawn site: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts:1034-1039` (`else if (profile.modesetDemo)` → `spawnLazy(kernel, "/usr/local/bin/modeset", modesetWasmUrl, ["modeset"], tick);`).
- Master-tracking in the kernel: `this.kms.isMasterPid(pid)` used at `host/src/kernel.ts:183` — same registry can yield "which CRTC is this pid master on", needs a thin helper.
- WebGL bridge architecture lives under `host/src/webgl/` (10 files, 1480 lines): `registry.ts` (per-pid bindings), `bridge.ts` (cmd opcode interpreter with `gl.shaderSource`/`gl.compileShader` at `:287/:292`), `muxer.ts` (per-context state mirror), `submit-drain.ts`, `submit-queue.ts`, `query.ts`, `ops.ts`, `shadow.ts`, `main-forward.ts`, `index.ts`.
- All prior handoffs: `docs/plans/2026-06-08-dri-kandelo-port-handoff{,-2,-3}.md`, `docs/plans/2026-06-09-dri-kandelo-port-handoff{-4,-5,-6,-7,-8,-9,-10}.md`.
