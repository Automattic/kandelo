# DRI port onto kandelo:main — session 60 handoff (session-58+59 committed, SDL2 browser preset wired but app blocked by stale @binaries)

Continuation of [handoff-59](./2026-06-16-dri-kandelo-port-handoff-59.md). Session 60 (1) committed the session-58+59 audit + test-infra work as one commit per the user's session-58 instruction, (2) wired a separate SDL2 demo preset into the Kandelo browser app, (3) followed the user's explicit build chain (`build-musl → build-gles-stubs → ./run.sh browser` inside `dev-shell.sh`), and (4) hit a **pre-existing build-pipeline staleness bug** that blocks `live-setup.ts` from transforming: many `local-binaries/programs/wasm32/*.wasm` are ABI 14/15 from prior sessions, `run.sh`'s `has_X()` gates short-circuit on file existence (no ABI check), and `make` inside `bzip2-src/` etc. reports "up to date" against stale `.o` files because Makefiles don't track `libc/glue/abi_constants.h` as a dependency.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`. **New commit this session: `4f88111bb`** (audit + test-infra, 19 files / +915 / -52). **Not pushed.** PR #709 untouched.
2. **SDL2 browser wiring is uncommitted, working-tree only** — `apps/browser-demos/pages/kandelo/presets.ts` + `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`. Plus deleted-but-uncommitted: `local-binaries/programs/wasm32/{shell,node-vfs,wordpress,lamp}.vfs.zst` and `apps/browser-demos/public/{shell,node-vfs,wordpress,lamp}.vfs.zst` (deleted to try to force rebuild — they didn't rebuild, see §"The blocker").
3. **Vite is up on http://127.0.0.1:5402/** (background task `b6rvjtfo7`) — but requesting `/pages/kandelo/kernel-host/live-setup.ts` returns HTTP 500 because the `@binaries` Vite plugin's `tryResolveBinary` flags multiple imported wasms as stale (ABI 14/15 or fork-instrumentation missing). Vite's dev server STARTS cleanly; the failure only surfaces when a real page is requested.
4. **ABI:** still 16. `crates/shared/src/lib.rs:42` says `ABI_VERSION = 16`; `libc/glue/abi_constants.h` mirrors `16u`.
5. **PR #709:** still untouched. **Do NOT `gh pr *` without explicit in-session permission.**
6. **scripts/check-abi-version.sh:** still BROKEN per handoff-57 §3. Out of scope.

## What this session did

### A. Committed session-58+59 work as single commit `4f88111bb`

User's session-58 instruction was "fix all of these points in one commit only." With session-59's test-infra additions on top, this is one commit covering both. Files: see handoff-58 §"Files changed this session" + handoff-59 §"Files modified this session". 19 files, +915 / -52. Suggested message Option A was used verbatim.

### B. Wired a new "sdl2" Kandelo preset (separate from "modeset" per user)

The Kandelo browser app already has a `Modeset` pane (`apps/browser-demos/pages/kandelo/panes/Modeset.tsx`) that attaches a `<canvas>` to `/dev/dri/card0` via `host.attachKmsDisplay(canvas, crtcId)` — the kernel-side auto-attach resizes the OffscreenCanvas to match the FB before `getContext("webgl2")`. The pane mounts when `presentation.runningPrimary` includes `"kms"`. User said "I prefer having a separate demo between KMS and SDL2," so I added a new `"sdl2"` demo ID alongside `modeset`, not piggybacking on it.

Edits (uncommitted):

| File | Change |
|---|---|
| `apps/browser-demos/pages/kandelo/presets.ts` | New entry `{ id: "sdl2", title: "SDL2 demo", summary: "320×240 SDL2 demo: spinning GLES2 quad on /dev/dri/card0, 440 Hz ALSA tone, ESC quits via evdev. Runs for 5 s.", base: SHELL_BASE, packages: ["bash@local", "coreutils@local"], accent: "#9c27b0", glyph: "S", bootCommand: ["bash","-l","-i"], estimatedUrlBytes: 612 }` placed between `doom` and `evdev`. |
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` | (i) Add `OPTIONAL_BINARY_URLS` globs for `local-binaries/programs/wasm32/sdl2_demo.wasm` + `binaries/programs/wasm32/sdl2_demo.wasm`. (ii) `LIVE_DEMO_IDS += "sdl2"`. (iii) `LIVE_PROFILE_SPECS.sdl2 = { image: "shell", features: ["kms"] }`. (iv) `LiveProfile.sdl2Demo: boolean` field. (v) `sdl2Demo: false` in two static constructors + `sdl2Demo: normalized === "sdl2"` in `profileFor`. (vi) Spawn block after `evdevDemo`: `optionalBinaryUrl(["…/sdl2_demo.wasm"]) → stage at /usr/local/bin/sdl2_demo → attachInputSource(new BrowserInputSource(window), …) → attachAudioDriver({ pcmId: 0, sampleRate: 48_000, channels: 2, periodFrames: 1024, ringBytes: 64*1024 }) → host.runShellCommand("/usr/local/bin/sdl2_demo")`. (vii) `genericPresentationForProfile` accepts `sdl2Demo || …kms` → `genericDemoPresentation("kms")`. (viii) `liveDemoIdForVfsImageUrl`'s ambiguous-shell-fallback exclusion list extended with `"sdl2"`. |

Type-check: 0 errors in the edited files (`cd apps/browser-demos && npx tsc --noEmit -p .` filter to kandelo/* paths). The 67 pre-existing errors are in `lib/connection-pump.ts`, `host/src/kernel-worker.ts` Node-type misses — out of scope.

### C. Ran the full build chain per user's explicit request

```
source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh \
  && bash scripts/dev-shell.sh bash scripts/build-musl.sh \
  && bash scripts/dev-shell.sh bash scripts/build-gles-stubs.sh \
  && bash scripts/dev-shell.sh ./run.sh browser
```

- `build-musl.sh` ✓ — `sysroot/lib/libc.a` produced at Jun 16 19:14 (1,384,658 B).
- `build-gles-stubs.sh` ✓ — `sysroot/lib/{libEGL.a,libGLESv2.a}` produced.
- `./run.sh browser` ran `cmd_prepare_browser` (fetch + build cascade) + `vite`. **The cascade reports `[OK]` for every target but doesn't actually rebuild ABI-stale artifacts** — see §"The blocker."

## The blocker — `run.sh`'s `has_X()` gates are ABI-blind

### What's stale (from `local-binaries/programs/wasm32/`)

Enumerated via `describeWasmArtifactPolicyFailures` + `MemoryFileSystem.readImageMetadata`:

| File | Stale reason |
|---|---|
| `bzip2.wasm` | ABI 15, expected 16 |
| `cube.wasm` | ABI 14, expected 16 |
| `dri_paint.wasm` | ABI 14, expected 16 |
| `js.wasm` | imports `kernel.kernel_fork` without complete `wpk_fork_*` exports |
| `less.wasm` | ABI 15 |
| `msmtpd.wasm` | ABI 15 |
| `nethack.wasm` | ABI 14 |
| `node.wasm` | imports `kernel.kernel_fork` without complete `wpk_fork_*` exports |
| `perl-vfs.vfs.zst` | vfs ABI 14 |
| `perl.wasm` | ABI 14 |
| `posix-utils-lite/tabs.wasm` | ABI 14 |
| `posix-utils-lite/tput.wasm` | ABI 14 |
| `spidermonkey-node.wasm` | same fork-instrumentation issue (ABI 16, exports incomplete) |
| `tcl.wasm` | ABI 15 |
| `unzip.wasm` | ABI 15 |
| `vim.wasm` | ABI 15 |
| `zip.wasm` | ABI 15 |

166 other wasms/vfs files are OK.

### Which of those Vite imports eagerly from `live-setup.ts` (transitive)

These BLOCK the page from loading at request time (Vite's `vite:import-analysis` 500s on the first stale one):

- `bzip2.wasm`, `less.wasm`, `unzip.wasm`, `zip.wasm` — ABI 15, eager.
- `node.wasm`, `spidermonkey-node.wasm` — fork-instrumentation incomplete, eager.
- `shell.vfs.zst`, `node-vfs.vfs.zst`, `wordpress.vfs.zst`, `lamp.vfs.zst` — VFS ABI 14/15, eager.
- `posix-utils-lite/tput.wasm`, `posix-utils-lite/tabs.wasm` — ABI 14, eager (from `shell-lazy-files.ts`).

(`vim.wasm`, `nethack.wasm`, `perl.wasm`, `tcl.wasm`, `msmtpd.wasm`, `cube.wasm`, `dri_paint.wasm`, `js.wasm` are not eager — they're lazy archives or unused by the kandelo entry — they would only fail at spawn time, not at Vite dep-scan.)

### Why the build cascade reports `[OK]` but doesn't rebuild

Two layered bugs:

1. **`has_X()` checks file existence, not ABI:** e.g. `has_node_vfs() { pkg_has_output node-vfs node-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" ]; }`. With the cache_key dirs in `~/.cache/kandelo/programs/node-vfs-0.1.0-rev7-wasm32-*` containing a Jun-10 file (ABI 14), `pkg_has_output` returns true and `build_node_vfs` short-circuits. Same for shell, wordpress, lamp.

2. **Source builds reuse stale `.o` files:** I deleted `local-binaries/programs/wasm32/bzip2.wasm` to force rebuild. The resolver did invoke `packages/registry/bzip2/build-bzip2.sh`, which runs `make`. `make` says `« bzip2 » est à jour` (up to date) because `packages/registry/bzip2/bzip2-src/bzip2.o` is dated Jun 9 (newer than `bzip2.c` source). The Makefile **does not track `libc/glue/abi_constants.h` as a dep**, so even though that header changed (Jun 15) when ABI bumped to 16, `make` doesn't recompile. The resolver "installs" the existing `packages/registry/bzip2/bin/bzip2.wasm` (still ABI 15) into the new cache-key dir and into `local-binaries/`. Now `bzip2.wasm` is dated today but contains the old ABI 15 binary.

Similar pattern affects `less`, `unzip`, `zip`, `msmtpd`, `tcl`, `vim`, `nethack`, `perl`, `posix-utils-lite/*` — anything whose source-tree `.o` files predate the ABI 15→16 bump.

### Separately: `nethack` source-build is broken on this macOS arm64 host

```
==> Host phase: building util tools...
Undefined symbols for architecture arm64:
  "_mons", referenced from: _do_makedefs in makedefs.o
  "_monst_init", referenced from: _do_ext_makedefs in makedefs.o
  "_obj_descr", referenced from: _do_objs in makedefs.o
  "_objects", referenced from: _do_makedefs in makedefs.o
  "_objects_init", referenced from: _do_ext_makedefs in makedefs.o
ld: symbol(s) not found for architecture arm64
clang: error: linker command failed with exit code 1
```

`util/Makefile` expects to link `makedefs` against `../src/{monst,objects}.o`. Those `.o` files aren't being built before the link step. Pre-existing bug. **NOT triggered by SDL2 work** — would affect any from-scratch nethack rebuild on this branch. `build-nethack-zip.sh` has an in-tree fallback (`packages/registry/nethack/{bin,runtime}` from Jun 10), so `shell.vfs.zst` can still be baked without source-rebuilding nethack.wasm.

## What I deleted this session (still uncommitted)

```
local-binaries/programs/wasm32/shell.vfs.zst        (was ABI 14)
local-binaries/programs/wasm32/node-vfs.vfs.zst     (was ABI 14)
local-binaries/programs/wasm32/wordpress.vfs.zst    (was ABI 15)
local-binaries/programs/wasm32/lamp.vfs.zst         (was ABI 15)
apps/browser-demos/public/shell.vfs.zst             (was ABI 14)
apps/browser-demos/public/node-vfs.vfs.zst          (was ABI 14)
apps/browser-demos/public/wordpress.vfs.zst         (was ABI 15)
apps/browser-demos/public/lamp.vfs.zst              (was ABI 15)
```

Re-running `./run.sh browser` did NOT replace these (the build cascade reported `[OK]` per the `has_X` bug above — `pkg_has_output` returned true based on the resolver cache holding the old key entries). Vite plugin then correctly reported them as not found, because the cache symlinks point to ABI-stale targets and the resolver's `chooseBinaryCandidate` filters them out via `hasVfsArtifactPolicyFailures`.

## Three paths next session can take

**Path A — Minimal "dev bypass" so the user sees SDL2 today (≈30 min)**

Add a `WASM_POSIX_DEV_NO_ABI_CHECK=1` escape hatch to `host/src/binary-resolver.ts::hasBinaryArtifactPolicyFailures`:

```ts
function hasBinaryArtifactPolicyFailures(path: string, relPath: string): boolean {
  if (process.env.WASM_POSIX_DEV_NO_ABI_CHECK === "1") return false;
  return hasWasmArtifactPolicyFailures(path, relPath) || hasVfsArtifactPolicyFailures(path);
}
```

Then `WASM_POSIX_DEV_NO_ABI_CHECK=1 ./run.sh browser`. Vite resolves stale binaries; **the kernel will reject them at `spawn()` time** but that's a runtime per-binary error — the SDL2 preset itself uses `sdl2_demo.wasm` (already ABI 16 + correctly fork-instrumented in `local-binaries/`) so SDL2 will boot. Other presets (node, wordpress, lamp) will fail when launched, with a clean ABI-mismatch error message at the kernel boundary.

**Pros:** quick. Lets the user see SDL2 running, audio play, ESC quitting. Doesn't touch the build pipeline.
**Cons:** Other demos visibly broken when launched. The bypass shouldn't be merged without a feature flag.
**Critical sanity check before doing this:** confirm `local-binaries/programs/wasm32/{sdl2_demo.wasm, libdrm/*, alsa-lib/*, libinput-lite/*}` are all ABI 16 and fork-instrumentation-clean. (sdl2_demo.wasm was built at 17:12 today, ABI 16 confirmed via session-58.)

**Path B — Force-rebuild every stale package "properly" (≈half day, some pieces may fail)**

```bash
# Force-invalidate source trees so make actually rebuilds
for pkg in bzip2 less unzip zip msmtpd tcl vim perl posix-utils-lite ncurses; do
  find packages/registry/$pkg/${pkg}-src -name "*.o" -delete 2>/dev/null
  rm -rf packages/registry/$pkg/bin
done

# Same for the .vfs.zst files
rm -f local-binaries/programs/wasm32/{bzip2,less,unzip,zip,msmtpd,vim,perl,nethack,tcl}.wasm
rm -f local-binaries/programs/wasm32/posix-utils-lite/{tput,tabs}.wasm
rm -f local-binaries/programs/wasm32/{node,spidermonkey-node,js}.wasm  # re-fork-instrument
rm -f local-binaries/programs/wasm32/{shell,node-vfs,wordpress,lamp,perl-vfs}.vfs.zst

# Invalidate resolver caches for ABI 16 (current keys only)
# Discover them via: cargo xtask build-deps output-path <pkg> <wasm>
# then rm -rf those dirs (CAREFUL: don't trash unrelated keys)

# Re-run inside dev-shell
bash scripts/dev-shell.sh ./run.sh browser
```

Risks:
- nethack source-build fails (host arm64 link error in `util/makedefs`). Workaround: edit `build-nethack.sh` to also build `src/{monst,objects}.o` with host CC before invoking `make -C util makedefs`. Or sidestep: leave nethack.wasm stale, let `build-nethack-zip.sh`'s in-tree fallback include the ABI-14 binary inside `shell.vfs.zst` — Vite's check on shell.vfs.zst only inspects the outer kernelAbi metadata, not bundled content. nethack would crash at runtime if launched; SDL2 doesn't care.
- node/spidermonkey-node fork-instrumentation re-application — needs `scripts/run-wasm-fork-instrument.sh` to be invoked on them. May already be part of their build scripts; check if the `make clean && re-resolve` cycle from handoff-59 already covers it.

**Pros:** all browser presets actually work. The "right" answer.
**Cons:** time-consuming. Likely a multi-hour iteration with package-by-package rebuilds.

**Path C — Fix the build system: make `has_X()` ABI-aware (≈2 hours, infrastructural)**

Edit `run.sh` so each `has_X()` reads the file's ABI before returning success:

```bash
has_node_vfs() {
    # ABI-aware: prefer pkg_has_output (resolver-managed) but require ABI match
    local path
    path=$(pkg_has_output_path node-vfs node-vfs.vfs.zst) || true
    if [ -n "$path" ] && check_vfs_abi "$path" "$ABI_VERSION"; then return 0; fi
    [ -f "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" ] \
      && check_vfs_abi "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" "$ABI_VERSION"
}
```

Also fix `bzip2-src`-style Makefile staleness: either add `libc/glue/abi_constants.h` to each package's build.toml `inputs` (so the cache_key sha changes, triggering source-build) AND have each `build-<pkg>.sh` invoke `make clean` before `make`. Or just have `build-<pkg>.sh` add `make clean` unconditionally — wasteful but always correct.

**Pros:** root cause fix. Future ABI bumps stop cascading these "phantom [OK]" failures.
**Cons:** touches every `has_X` + every build script. Big patch surface. The right thing eventually but not necessary to see SDL2 working now.

## Files modified this session (uncommitted)

```
# Committed in 4f88111bb (session 58+59 audit/test-infra)
# — see git log -1 --stat 4f88111bb

# Uncommitted, this session:
M apps/browser-demos/pages/kandelo/presets.ts
M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts
D local-binaries/programs/wasm32/shell.vfs.zst
D local-binaries/programs/wasm32/node-vfs.vfs.zst
D local-binaries/programs/wasm32/wordpress.vfs.zst
D local-binaries/programs/wasm32/lamp.vfs.zst
D apps/browser-demos/public/shell.vfs.zst
D apps/browser-demos/public/node-vfs.vfs.zst
D apps/browser-demos/public/wordpress.vfs.zst
D apps/browser-demos/public/lamp.vfs.zst
?? docs/plans/2026-06-17-dri-kandelo-port-handoff-60.md (this file)
```

Plus all the noise that was already untracked at session start (older handoff-*.md plans, openssl/mariadb build artifacts, `host/test/audit-probe.ts`, `apps/browser-demos/test-results/` Playwright dir, etc.) is still untouched.

## Open background tasks

- **`b6rvjtfo7`** — `dev-shell.sh ./run.sh browser` Vite server on http://127.0.0.1:5402/. **Still running.** Cleanup: `TaskStop b6rvjtfo7`.
- Other background tasks (`bxax9pyqs`, `bkrnovyrt`, `bdvpccpys`, `bgulnel00`) are completed.

## Other gotchas to preserve

- The first Vite I started earlier in the session (`bgulnel00`) was on port 5401 and got stopped before the proper build chain. The dev-shell `./run.sh browser` autoselected 5402 because 5401 was lingering. If both are dead by next session, Vite will start on 5401 again.
- Per handoff-59 §"Standing instruction": PR #709 stays as-is, no push, no `gh pr *` without permission.
- `check-abi-version.sh` SIGPIPE bug from handoff-57 §3 still unfixed.

## Standing instruction for session 61 — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-dri-kandelo-port-handoff-60.md` first, then handoff-59/58 for prior context. Branch is `explore-dri-sdl2`, tip `4f88111bb` (committed but NOT pushed). The SDL2 browser preset is wired in `apps/browser-demos/pages/kandelo/presets.ts` + `…/kernel-host/live-setup.ts` (uncommitted) but Vite at http://127.0.0.1:5402/ returns 500 on `/pages/kandelo/kernel-host/live-setup.ts` because ~12 `@binaries` imports resolve to ABI-stale wasm/vfs files. See §'Three paths next session can take' — user likely wants Path A (WASM_POSIX_DEV_NO_ABI_CHECK env-var bypass in `host/src/binary-resolver.ts::hasBinaryArtifactPolicyFailures`, then `WASM_POSIX_DEV_NO_ABI_CHECK=1 bash scripts/dev-shell.sh ./run.sh browser` and visit the Kandelo gallery → 'SDL2 demo' tile to see audio + ESC + (per handoff-58-audit §`e6cc2f5d8`) main-loop ticks). The 5 s self-terminate is hard-coded in `programs/sdl2_demo.c:159`. Path B is force-rebuild every stale package — slow + nethack source-build has a separate macOS arm64 host-link bug ('_mons, _monst_init, _obj_descr, _objects, _objects_init undefined' from util/makedefs). Path C is fix `run.sh`'s `has_X()` to be ABI-aware + add `make clean` to per-package build scripts (right answer, big patch surface). Do NOT push, do NOT `gh pr *` without explicit permission — PR #709 stays untouched. Background task `b6rvjtfo7` may still have a Vite running — TaskStop it before re-launching. `scripts/check-abi-version.sh` still BROKEN per handoff-57 §3. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR command."*
