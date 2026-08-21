# DRI port onto kandelo:main — session 62 handoff (cache_key mechanism clarified, simple+VFS rebuilds underway, build-script staleness is the real bug)

Continuation of [handoff-61](./2026-06-17-dri-kandelo-port-handoff-61.md). Session 62 (1) identified the producer of `sdl2.vfs.zst` — it's actually `shell.vfs.zst` accessed under a synthetic label, (2) fixed `packages/registry/nethack/build-nethack.sh`'s host-link bug, (3) made espeak-ng optional in `images/vfs/scripts/build-shell-vfs-image.ts` because its sources aren't vendored, (4) successfully rebuilt `shell.vfs.zst` and `node-vfs.vfs.zst` to ABI 16, (5) **discovered the real cache-staleness mechanism** — the user corrected an incorrect rev-bump approach mid-session.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`. **Tip still `4f88111bb`.** Not pushed. PR #709 untouched.
2. **`sdl2.vfs.zst` is NOT a real file.** The SDL2 preset has `image: "shell"` (`live-setup.ts:356`). The error label `${profile.id}.vfs.zst` from `live-setup.ts:1118` produces the synthetic string `sdl2.vfs.zst` when the real file (`shell.vfs.zst`) fails the ABI check. Handoff-61 §"Step 2 — identify what produces sdl2.vfs.zst" is answered: nothing produces it; it's a label.
3. **The cache_key DOES include `abi_version`** — `tools/xtask/src/build_deps.rs:303` (`h.update(abi_version.to_le_bytes())`). The user pointed out that msmtpd has always been `revision = 1` and yet rebuilds correctly across ABI bumps. The mechanism: an ABI bump shifts the cache_key sha for every library/program package via this hash input. So bumping revisions to force rebuild is **wrong** — the cache_key already changes. **Reverted any revision bumps I made (see §"Working tree state").**
4. **The actual bug, then, is per-package build-script staleness — exactly what handoff-60 §2 diagnosed.** When the resolver computes a fresh ABI 16 cache_key (e.g. `bzip2-1.0.8-rev2-wasm32-dcec481e`), it invokes `packages/registry/bzip2/build-bzip2.sh`, which runs `make`. `make` sees the existing `.o` files dated newer than the `.c` sources and reports "up to date" without recompiling against the new `libc/glue/abi_constants.h`. The build script then copies the ABI-15 binary to `BIN_DIR` and `install_local_binary` writes it INTO the ABI 16 cache dir. The resolver returns success with a stale binary. Re-running `cargo xtask build-deps resolve bzip2` hits the populated cache dir, validates it (`validate_cache_artifacts` only checks artifact presence, NOT wasm ABI), and returns the ABI 15 binary again.
5. **Successful ABI 16 rebuilds this session:**
   - `local-binaries/programs/wasm32/shell.vfs.zst` — 326 KB, ABI 16 ✓ (confirmed via `MemoryFileSystem.readImageMetadata`)
   - `local-binaries/programs/wasm32/node-vfs.vfs.zst` — 1.9 MB, ABI 16 ✓
   - `local-binaries/programs/wasm32/nethack.wasm` — 5.5 MB, ABI 16 ✓ (fresh source build worked with the host-link fix)
6. **PR #709:** still untouched. Do NOT `gh pr *` without explicit in-session permission.

## What this session did

### A. Identified the synthetic `sdl2.vfs.zst` label

- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts:1115-1119`: `MemoryFileSystem.assertImageKernelAbi(new Uint8Array(vfsBytes), ABI_VERSION, ${profile.id}.vfs.zst)`.
- `LIVE_PROFILE_SPECS.sdl2 = { image: "shell", features: ["kms"] }` (line 356).
- `vfsImageUrlForPreset(id)` → `VFS_URLS[LIVE_PROFILE_SPECS[liveId].image]` → `shellVfsUrl` from `@binaries/programs/wasm32/shell.vfs.zst`.

So **rebuilding `shell.vfs.zst` to ABI 16 is sufficient** for the SDL2 preset's VFS check to pass. The "sdl2.vfs.zst requires kernel ABI 14" error was misleading.

### B. Fixed nethack `util/makedefs` host-link

`packages/registry/nethack/build-nethack.sh`, before the `make -C util makedefs` line in the host phase:

```bash
# Wipe stale wasm32 src/*.o files so util/Makefile's recipes
# (`$(OBJDIR)/{monst,objects,drawing,decl,alloc,dlb}.o:`) rebuild
# them with host CC before linking. A prior phase-2 cross build leaves
# wasm32 ELFs here that host `cc` can't link against —
# Undefined symbols: _mons, _monst_init, _obj_descr, _objects, _objects_init.
rm -f "$SRC_DIR/src/monst.o" "$SRC_DIR/src/objects.o" \
      "$SRC_DIR/src/drawing.o" "$SRC_DIR/src/decl.o" \
      "$SRC_DIR/src/alloc.o" "$SRC_DIR/src/dlb.o"
```

Validated: `cargo xtask build-deps resolve nethack` completed cleanly, produced `5.4M` nethack.wasm at ABI 16, installed into `local-binaries/programs/wasm32/nethack.wasm` + cache at `~/.cache/kandelo/programs/nethack-3.6.7-rev6-wasm32-690c41fd/`.

### C. Made espeak-ng optional in shell-vfs-image builder

`images/vfs/scripts/build-shell-vfs-image.ts::populateEspeakRuntime`:

```ts
function populateEspeakRuntime(fs: MemoryFileSystem): void {
  let espeakWasmPath: string;
  try {
    espeakWasmPath = resolveVfsArtifact("programs/espeak-ng.wasm", "espeak-ng");
  } catch {
    console.log("  espeak-ng.wasm not available — skipping espeak runtime");
    return;
  }
  // ...
  if (!existsSync(dataDir)) {
    console.log(`  espeak-ng-data not found at ${dataDir} — skipping espeak runtime`);
    return;
  }
  // ...
}
```

**Reason:** `packages/registry/espeak-ng/build.toml` declares `inputs = [..., "packages/registry/espeak-ng/pcaudiolib-src/src/audio.c", "packages/registry/espeak-ng/pcaudiolib-src/src/audio_kandelo.c"]` but neither the espeak-ng-src nor pcaudiolib-src trees are vendored in this worktree. The resolver refuses to invoke the build script because declared inputs are missing. `cargo xtask build-deps resolve espeak-ng` fails with `build input "packages/registry/espeak-ng/pcaudiolib-src/src/audio.c" not found`. The SDL2 demo doesn't need espeak; this change unblocks shell.vfs.zst. **May need to be reverted (or properly fixed by adding vendor cloning) before merging if espeak-demo functionality matters.**

### D. Cache_key mechanism — corrected understanding

**Initial wrong hypothesis (now reverted):** revisions need to be bumped because `~/.cache/kandelo/programs/bzip2-1.0.8-rev2-wasm32-dcec481e/bzip2.wasm` is ABI 15, suggesting cache_key matched stale entries.

**User correction:** "msmtpd has always been revision = 1." Implied: the cache_key auto-invalidates on ABI bumps.

**Verified via xtask source:** `tools/xtask/src/build_deps.rs:303` and the doc-comment at `tools/xtask/src/build_deps.rs:201-206`:
> ABI-bump propagation: a kernel ABI bump shifts every library and program leaf sha (because abi_version is in their input set), and those shifts ripple up to their consumers via the per-dep `hex(dep_sha)` tail.

So cache_key DOES change on ABI bumps. The ABI 16 cache dir `bzip2-rev2-…-dcec481e` was created Jun 16 19:15. The binary inside is ABI 15 because **the build script produced an ABI 15 binary at ABI 16 cache_key time**. Then `install_local_binary` wrote that stale binary into the fresh ABI 16 cache dir. Subsequent `resolve` calls hit the cache dir (it exists), call `validate_cache_artifacts` (which only checks presence, not ABI), return success.

**Bug source:** the per-package Makefiles don't track `libc/glue/abi_constants.h`. On an ABI bump:
1. Resolver computes new cache_key for ABI 16.
2. No cache dir at that key → resolver invokes `build-bzip2.sh`.
3. `make` sees `bzip2-src/*.o` dated newer than `bzip2-src/*.c` (because previous build left them).
4. `make` reports "up to date" — no compilation against new `abi_constants.h`.
5. Build script copies stale `bzip2` binary to `BIN_DIR/bzip2.wasm`.
6. `install_local_binary` writes stale binary into the ABI 16 cache dir.
7. Cache dir now exists with stale binary. Future resolves hit it. Bug persists.

**Correct fix (per handoff-60 §2, not yet applied):** Each `build-<pkg>.sh` should run `make clean` (or `find . -name '*.o' -delete`) before `make`. Bumping `revision` is a sledgehammer that masks the bug but doesn't fix it — and conflicts with package-management policy (revision bumps are publish-time signals, not cache-busters; bumping for a doc-only or environment fix triggers needless matrix rebuilds across other ABI versions).

### E. Verified Vite-eager `@binaries` import status (post shell+node-vfs rebuild)

Audited all 90 distinct eager `@binaries/...` imports across `apps/browser-demos/`. `tryResolveBinary` returns null for **6 stale imports** that block Vite's `vite:import-analysis`:

- `programs/wasm32/less.wasm` — ABI 15 cached at `less-668-rev2-wasm32-b22fdec1/`
- `programs/wasm32/bzip2.wasm` — ABI 15 cached at `bzip2-1.0.8-rev2-wasm32-dcec481e/`
- `programs/wasm32/zip.wasm` — ABI 15
- `programs/wasm32/unzip.wasm` — ABI 15
- `programs/wasm32/wordpress.vfs.zst` — ABI 14 (binaries/programs/wasm32/ symlink)
- `programs/wasm32/lamp.vfs.zst` — ABI 14 (binaries/programs/wasm32/ symlink)

All other 84 imports pass policy. Notably:
- `node.wasm` policy passes — `node` and `spidermonkey-node` declare `fork_instrumentation = "disabled"` in `package.toml`, so the resolver's `disablesForkInstrumentation` returns true and the fork-export check is skipped.
- `nginx-vfs.vfs.zst`, `nginx-php-vfs.vfs.zst` have **no** `kernelAbi` declared in their metadata — `MemoryFileSystem.assertImageKernelAbi` accepts undeclared images (legacy compatibility), so they pass.

## Working tree state at handoff (uncommitted)

```
M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts        (from session 60 — SDL2 wiring, unchanged this session)
M apps/browser-demos/pages/kandelo/presets.ts                       (from session 60 — SDL2 wiring, unchanged this session)
M images/vfs/scripts/build-shell-vfs-image.ts                       (new this session — espeak optional)
M packages/registry/nethack/build-nethack.sh                        (new this session — pre-clean stale src/*.o)
?? docs/plans/2026-06-17-dri-kandelo-port-handoff-62.md             (this file)
[earlier handoff plan .md files, untracked, present from prior sessions]
```

`packages/registry/{bzip2,less,unzip,zip,msmtpd}/build.toml` should be UNCHANGED — I bumped revisions earlier and reverted before commit. Confirm with `git diff packages/registry/{bzip2,less,unzip,zip,msmtpd}/build.toml` → should be empty.

`packages/registry/{bzip2,less,unzip,zip,msmtpd}` source trees: stale `.o` and `bin/` directories were deleted earlier this session. They were cleaned at session start and the rev-3 builds did populate fresh artifacts, but the revert means future `resolve` calls fall back to the rev-2 cache containing the original stale binaries. **Re-cleaning the .o files is the right next move (see §"What the next session must do" §1).**

## What the next session must do

### Step 1 — fix per-package build-script staleness (the actual root cause)

This is the structural fix handoff-60 §2 called out. Two complementary approaches:

**Option (a) — quick & surgical:** add `make clean` (or `find . -name '*.o' -delete` for packages without a `clean` target) to the top of each `build-<pkg>.sh` between source-extract and `make`. Affected: `bzip2`, `less`, `unzip`, `zip`, `msmtpd`. Check `wordpress`, `lamp`, `php`, `nginx`, `mariadb` build scripts too — handoff-60 implied the same Makefile-staleness pattern but those packages have bigger build trees, so `make clean` may have other side effects.

**Option (b) — proper:** add `libc/glue/abi_constants.h` to each package's build.toml `inputs` field. Then ABI bumps change the inputs hash, which changes the cache_key sha, AND incidentally produce a different `~/.cache/kandelo/programs/<pkg>-<v>-rev<r>-wasm32-<NEW-sha>/` directory — fresh, empty. The resolver invokes the build script with no pre-existing cache to mask staleness. But `make` STILL won't recompile against the new header unless we also do (a), because `.o` mtimes in the source tree are independent of the cache key. So (b) alone is insufficient.

**Recommendation: do both.** (a) ensures clean builds, (b) hardens the invalidation contract for future ABI bumps. Tackle (a) first since it directly unblocks this session.

### Step 2 — delete the poisoned ABI-stale cache dirs

After (a) is in place, the cached dirs `~/.cache/kandelo/programs/{bzip2,less,unzip,zip,msmtpd}-*-rev*-wasm32-*` still contain stale binaries at the ABI 16 cache_key. The resolver will validate (`validate_cache_artifacts` checks presence) and return them as-is without re-running the build script.

```bash
for pkg in bzip2 less unzip zip msmtpd; do
  rm -rf ~/.cache/kandelo/programs/${pkg}-*
done
```

Also delete the freshly-built rev-3 dirs created earlier this session (they were the bumped-and-reverted attempt). Look for `*-rev3-wasm32-*` for those 5 packages and remove.

### Step 3 — resolve the 6 stale eager imports

```bash
# bzip2, less, unzip, zip, msmtpd at unchanged revision will now actually rebuild
# at ABI 16, because:
#   - cache_key is for ABI 16 (xtask-side)
#   - cache dir is empty (deleted above)
#   - build script invokes make clean first (Step 1)
PATH="/nix/var/nix/profiles/default/bin:$PATH" bash scripts/dev-shell.sh bash -c '
  HOST_TARGET=$(rustc -vV | awk "/^host/ {print \$2}")
  for pkg in bzip2 less unzip zip msmtpd wordpress lamp; do
    echo "===== $pkg ====="
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve $pkg
  done
'
```

`wordpress` depends on `msmtpd` (already in the list above), `nginx`, `php`, `dinit`, `shell` — `shell` is already at ABI 16, `dinit` passes policy, `nginx` + `php` may or may not. Watch the log.

`lamp` depends on `mariadb` (large build) + everything wordpress needs. Highest risk of new failures.

### Step 4 — verify Vite

```bash
PATH="/nix/var/nix/profiles/default/bin:$PATH" bash scripts/dev-shell.sh bash -c './run.sh browser' &
# Wait for "Local: http://127.0.0.1:540x"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5401/pages/kandelo/kernel-host/live-setup.ts
# Expect 200, was 500 in handoff-60/61.
```

Open the Kandelo gallery, click the "SDL2 demo" tile, expect:
- Boot succeeds (no ABI mismatch error)
- 440 Hz tone + spinning quad
- ESC quits via evdev
- 5 s self-terminate (hard-coded in `programs/sdl2_demo.c:159`)

## Things NOT to do

- **Do NOT** bump `revision` fields in `build.toml` files to force rebuilds. Per the user: "msmtpd has always been revision = 1." Revisions are publish-time signals (one-shot republish on output-bytes change); cache_key already includes ABI version. Bumping revs to bust cache pollutes the package history and triggers needless rebuilds for other ABI versions.
- **Do NOT** re-introduce a `WASM_POSIX_DEV_NO_ABI_CHECK`-style bypass — same as session 61's warning. The user called that approach "idiotic."
- **Do NOT** `git commit` the SDL2 wiring, espeak fix, or nethack fix until the demo actually boots end-to-end. A green-on-paper commit that crashes at runtime is worse than no commit. (The espeak optional-skip and nethack pre-clean are independently useful fixes that could be committed once verified — but verify first.)
- **Do NOT** `gh pr *` without explicit permission. PR #709 stays as-is.
- **Do NOT** `git push`.
- **Do NOT** spend time iterating on `scripts/check-abi-version.sh` SIGPIPE — still broken per handoff-57 §3 and orthogonal.

## Open background tasks

All session-62 background tasks completed before this handoff. The Monitor `bw13u5cvn` timed out cleanly. No stray Vite or build processes expected.

## Standing instruction for session 63 — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-dri-kandelo-port-handoff-62.md` first, then handoff-61/60/59/58 for prior context. Branch is `explore-dri-sdl2`, tip `4f88111bb` (NOT pushed, PR #709 untouched). Last session fixed nethack's util/makedefs host-link bug + made espeak-ng optional in `images/vfs/scripts/build-shell-vfs-image.ts` + rebuilt `shell.vfs.zst` + `node-vfs.vfs.zst` to ABI 16. The critical mid-session correction: `cargo xtask` computes cache_key including ABI version (`tools/xtask/src/build_deps.rs:303`), so msmtpd-style packages auto-invalidate on ABI bumps — DO NOT bump revisions to force rebuild. The real bug is per-package build-script staleness: `make` honors existing `.o` mtimes and reports 'up to date' against stale objects, build scripts copy the ABI 15 binary into a freshly-keyed ABI 16 cache dir, future resolves hit that poisoned cache. Fix: add `make clean` (or equivalent `.o` cleanup) to the top of `packages/registry/{bzip2,less,unzip,zip,msmtpd}/build-<pkg>.sh` (Option (a) in handoff-62 §'Step 1'), then `rm -rf ~/.cache/kandelo/programs/{bzip2,less,unzip,zip,msmtpd}-*` to wipe the poisoned cache, then re-run `cargo xtask build-deps resolve` for bzip2, less, unzip, zip, msmtpd, wordpress, lamp inside `dev-shell.sh`. SDL2 demo unblocks once Vite's 6 stale eager imports (`bzip2.wasm`, `less.wasm`, `zip.wasm`, `unzip.wasm`, `wordpress.vfs.zst`, `lamp.vfs.zst`) resolve to ABI 16 artifacts. Working tree state: `live-setup.ts` + `presets.ts` (SDL2 wiring, from sessions 58-60) + `build-shell-vfs-image.ts` (espeak optional, this session) + `build-nethack.sh` (pre-clean, this session) — none committed. DO NOT push, DO NOT `gh pr *` without explicit permission. `scripts/check-abi-version.sh` still BROKEN per handoff-57 §3 — out of scope. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR command."*
