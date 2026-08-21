# DRI port onto kandelo:main — session 10 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-9.md](./2026-06-09-dri-kandelo-port-handoff-9.md). Read that first — this doc only covers what changed in session 10.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle. Wait for user input before each commit.

## TL;DR for next session

1. **All five test gates are GREEN.** Handoff-9's reported gate-3/gate-4 FAILs were stale binaries; a fresh run on this worktree shows 0 FAIL on both libc and POSIX suites. The branch is commit-ready *from a gate perspective*.
2. **User asked to see the browser demo (modeset preset) before staging commits.** Vite startup blocked on stale-ABI / missing package binaries. Fixing it requires source-rebuilding the affected packages locally because the ABI-v15 release index doesn't exist on GitHub yet.
3. **One half-finished workaround is in the working tree** — 8 `packages/registry/*/build.toml` revisions bumped. They did **not** invalidate the xtask resolver cache as `CLAUDE.md` claims; the second `prepare-browser` run reproduced the same v14 coreutils failure. **Decide whether to revert these 8 revision bumps or pursue a different cache-bust** (see §"Revision bump didn't work" below) before staging commits.

## Hard-won facts confirmed in session 10

- **`PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh bash -c '…'`** is still the only way the dev shell starts in this user's environment. Re-confirmed.
- **`WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`** lets SpiderMonkey build on this host. The Nix-shipped Apple SDK is 14.4 (pinned in `packages/registry/spidermonkey/mozconfig-wasm32`); Firefox 140.11.0esr's configure refuses anything below 15.5. The build script at `packages/registry/spidermonkey/build-spidermonkey.sh:31` honours `WASM_POSIX_MACOS_SDK_DIR` as an override. **This env var is NOT in the dev-shell `--keep` list** at `scripts/dev-shell.sh:50-91`; set it inside the inner `bash -c`. SpiderMonkey then built successfully (30,418,036 bytes).
- **`./run.sh browser` does prepare-browser → `cd apps/browser-demos && exec npx vite`** (`run.sh:2084-2098`). The prepare step is `cmd_prepare_browser` which calls `fetch_browser_binaries` then `build_browser`. Bypassing prepare and running Vite directly is possible but every `@binaries/programs/wasm32/<name>.wasm?url` static import must still resolve through `host/src/binary-resolver.ts` — Vite startup hard-fails on any missing or policy-rejected binary.
- **The host TS resolver's policy check** is the gate: `host/src/constants.ts:392-441` `describeWasmArtifactPolicyFailures` rejects a binary whose embedded `__abi_version` doesn't match `ABI_VERSION` (currently 15). Embedded ABI is read by `extractAbiVersion(programBytes)` (`host/src/constants.ts:737-739`) which extracts an `i32.const` from a function export named `__abi_version`. The libc glue compiles in `WASM_POSIX_ABI_VERSION` from `libc/glue/abi_constants.h` and emits that export; every user program is "stamped" with whatever ABI was in `abi_constants.h` at link time.
- **The user-program ABI custom section name is `wasm-posix-abi`** (`crates/shared/src/lib.rs:974`), but in practice user programs don't have that section — the ABI is exposed via the `__abi_version` function export instead. (The custom section is for kernel-side use.)

## All five test gates — CONFIRMED GREEN at end of session 10

Inside the dev shell, with PATH prefix:

| Gate | Command | Status |
|---|---|---|
| 1 | `cargo test -p kandelo --target aarch64-apple-darwin --lib` | **934 passed / 0 failed** |
| 2 | `cd host && npx vitest run` | **668 passed / 0 failed / 151 skipped** (86 files pass / 28 skip) |
| 3 | `scripts/run-libc-tests.sh` | **0 FAIL**, 301 PASS, 21 XFAIL, 1 FLAKE-PASS, 1 TIME |
| 4 | `scripts/run-posix-tests.sh` | **0 FAIL**, all-PASS otherwise, 3 XFAIL, 2 SKIP |
| 5 | `bash scripts/check-abi-version.sh` | clean — snapshot in sync, ABI 15 consistent across `lib.rs` / `abi.ts` / `abi_constants.h` |

Handoff-9 reported 13 libc FAILs and 30 POSIX FAILs but those were stale: `local-binaries/kernel.wasm` was rebuilt at `Jun 9 13:16` (between handoff-9 being written and this session starting). On the rebuilt kernel both suites are clean.

## Browser-demo verification effort — incomplete

User invoked the canonical "/verify after a host-runtime change" rule — wanted to see the modeset pane working in `./run.sh browser` before staging commits. The pipeline ran into stacked issues:

### Discovery 1 — Vite needs every static `@binaries/...` import to resolve

`apps/browser-demos/vite.config.ts:123-152` `resolveBinariesAlias` plugin calls `host/src/binary-resolver.ts:tryResolveBinary` and **hard-errors via `this.error(...)`** if the result is null. There is no fallback. The full list of binaries Vite needs to resolve (from `grep -rho '@binaries/programs/wasm32/[^"]*' apps/browser-demos/pages/`):

```
bash.wasm  coreutils.wasm  curl.wasm  dash.wasm  dinit/dinit.wasm
git/git-remote-http.wasm  git/git.wasm  grep.wasm  lamp.vfs.zst
mariadb-test.vfs.zst  mariadb/mysqltest.wasm  nc.wasm
nginx-php-vfs.vfs.zst  nginx-vfs.vfs.zst  node-vfs.vfs.zst  node.wasm
posix-utils-lite/gencat.wasm  sed.wasm  shell.vfs.zst
spidermonkey-node.wasm  wordpress.vfs.zst
```

### Discovery 2 — 14 binaries in `local-binaries/programs/wasm32/` are stale-ABI

A TypeScript script (`/tmp/check-all-abi.ts` — paste of inline script at end of this doc) walked `local-binaries/programs/wasm32/` and decoded `__abi_version` for each `.wasm`:

```
=== STALE: 14 ===
  coreutils.wasm (ABI 14)
  diffutils/cmp.wasm (ABI 14)
  diffutils/diff.wasm (ABI 14)
  diffutils/diff3.wasm (ABI 14)
  diffutils/sdiff.wasm (ABI 14)
  erlang/erlang.wasm (ABI 11)
  findutils/find.wasm (ABI 14)
  findutils/xargs.wasm (ABI 14)
  gawk.wasm (ABI 14)
  grep.wasm (ABI 14)
  m4.wasm (ABI 14)
  make.wasm (ABI 14)
  perl.wasm (ABI 11)
  sed.wasm (ABI 14)
```

The other 148 wasms in that tree are fresh v15 (including bash, dash, dri-modeset, node, spidermonkey-node, mariadb/mariadbd, php/php — meaning some packages DID rebuild during this session's `prepare-browser`, just not all).

### Discovery 3 — SpiderMonkey source-build works with host SDK

Running `./run.sh prepare-browser` with `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` got past the SDK 14.4-vs-15.5 mismatch and produced `packages/registry/spidermonkey/bin/js.wasm` (30 MB). `node.wasm` and `spidermonkey-node.wasm` are now fresh v15 in `local-binaries`.

### Discovery 4 — VFS composes (lamp / wordpress / shell) gate on stale deps

`build-lamp-vfs-image.ts:73`, `build-wp-vfs-image.ts:62`, etc. all call the resolver to look up child binaries (coreutils.wasm, grep.wasm, …) while composing the `.vfs.zst` image. Stale-ABI children → resolver returns null → `Error: Binary not found: programs/coreutils.wasm`. Both runs of `prepare-browser` failed lamp and wordpress for exactly this reason. The pipeline as a whole still exited 0 because `fetch-binaries.sh` runs under `--allow-stale`.

## What I tried — and the open puzzle

### Attempt 1 — stub the missing binaries with copies of `bash.wasm` / `shell.vfs.zst`

Got past most import errors but `node.wasm` was rejected (likely because `node`'s entry in `packages/registry/*/package.toml` declares fork-instrumentation off but `bash.wasm` ships with fork-instrumentation, triggering `forbidForkInstrumentation` in `describeWasmArtifactPolicyFailures`). User correctly objected — this was a workaround, not a fix.

Stubs were removed. The six files (`curl.wasm`, `node.wasm`, `spidermonkey-node.wasm`, `lamp.vfs.zst`, `node-vfs.vfs.zst`, `wordpress.vfs.zst`) under `local-binaries/programs/wasm32/` no longer exist as stubs. After the first real prepare-browser run, `node.wasm` and `spidermonkey-node.wasm` exist at v15 from genuine source builds. The other four were composes/non-package fetches that prepare-browser couldn't satisfy because of stale deps.

### Attempt 2 — bump `revision` in each stale package's `build.toml`

Per `CLAUDE.md`:
> Bumping `build.toml.revision = N` invalidates every cached archive for that package.

Per session-10 expectation: the xtask resolver computes its `cache_key_sha` from the recipe (which includes `revision`), so bumping should miss the cache and force source-rebuild against the *current* `abi_constants.h` (now stamped v15).

I bumped 8 packages (still in working tree):

```
coreutils    revision 2 -> 3
diffutils    revision 1 -> 2
findutils    revision 1 -> 2
gawk         revision 1 -> 2
grep         revision 2 -> 3
m4           revision 2 -> 3
make         revision 2 -> 3
sed          revision 2 -> 3
```

(erlang and perl skipped — they're in `BROWSER_FETCH_SKIP_PKGS` / `BROWSER_EXTERNAL_GALLERY_PKGS` so prepare-browser wouldn't rebuild them anyway, and the modeset pane doesn't load either.)

### Revision bump didn't work — open question for next session

After bumping and re-running `prepare-browser`, **`local-binaries/programs/wasm32/coreutils.wasm` was STILL at ABI 14** (same mtime, same bytes). Lamp/wordpress VFS composes failed with the same coreutils-not-found error as the first run.

This contradicts `CLAUDE.md`. Possible explanations to investigate:

- The xtask resolver's `cache_key_sha` may not actually include `build.toml.revision`. Need to read `tools/xtask/src/build-deps.rs` (or wherever the cache-key is computed) to confirm.
- The resolver may key on the cache directory name (e.g., `coreutils-9.6-rev2-wasm32-1a81ea1d`) but the `local-binaries/` install step blindly overwrites. The disk cache at `~/.cache/kandelo/programs/coreutils-9.6-rev2-*` from earlier today (Jun 9 13:19) may still satisfy the resolver, and revision-3 cache lookups silently fall back to revision-2 artefacts. Check whether `~/.cache/kandelo/programs/coreutils-9.6-rev3-wasm32-*` exists after the second run.
- The resolver may not run source-build at all when `local-binaries/<pkg>.wasm` already exists, regardless of policy failures, when called via xtask (only host TS does the policy check). The Rust side may just hand the file back.
- The xtask source-build path for coreutils may have silently succeeded but written to a path that doesn't propagate to `local-binaries/`. Verify by `ls ~/.cache/kandelo/programs/coreutils-*` and check if a `rev3` dir exists.

**Decision the next session has to make.** Either:

(a) Find why the revision bump didn't invalidate the cache, fix that mechanism, and keep the 8 revision bumps in commit #6 (alongside the ABI bump). This is the correct fix per `CLAUDE.md` and reviewers will expect it.

(b) Revert the 8 revision bumps and instead just **delete the stale wasm files from `local-binaries/programs/wasm32/`** so the resolver has to source-rebuild (or pre-emptively delete the corresponding `~/.cache/kandelo/programs/<pkg>-*` directories so xtask source-builds them). This is a cleaner local-dev workaround but doesn't fix the underlying issue for anyone else.

(c) Just **delete the stale local-binaries entries + cache dirs** and don't touch any `build.toml` (so no extra files in the PR). The reviewers will then have to do the same thing on their end if they want to demo locally — but the gates already pass without the demo, so this is defensible.

(d) Ignore Vite-startup entirely. Gates are green. The user already saw `dri-cube-pyramid` test pass via vitest (`host/test/dri-cube-pyramid.test.ts` — 3.6s). The PR doesn't strictly need a manual browser-demo verification gate, even though it's the standard rule. **The user explicitly asked for the demo this session** so this option requires a renegotiation.

My personal lean is (a) — pursue why the bump didn't work — but it's a 20-60 minute rabbit hole and not strictly blocking the PR.

## Working-tree state at end of session 10

```
Modified (uncommitted):
  crates/kernel/src/wasm_api.rs                # handoff-7 Diff 1
  crates/kernel/src/syscalls.rs                # handoff-7 Diffs 2/3/4 + handoff-8 Diff A + session-9 Diff D
  crates/shared/src/lib.rs                     # session-9 Diff E (ABI 15)
  host/src/kernel.ts                           # handoff-8 Diff B
  host/src/kernel-worker.ts                    # handoff-8 Diff C
  scripts/build-programs.sh                    # handoff-7 Diff 8
  host/test/dri-smoke.test.ts                  # handoff-7 Diff 5
  host/test/dri-modeset.test.ts                # handoff-7 Diff 6 retarget
  abi/snapshot.json                            # session-9 Diff E (regenerated)
  host/src/generated/abi.ts                    # session-9 Diff E (regenerated)
  libc/glue/abi_constants.h                    # session-9 Diff E (regenerated)
  packages/registry/coreutils/build.toml       # SESSION 10 — revision 2 → 3 (DECISION PENDING)
  packages/registry/diffutils/build.toml       # SESSION 10 — revision 1 → 2 (DECISION PENDING)
  packages/registry/findutils/build.toml       # SESSION 10 — revision 1 → 2 (DECISION PENDING)
  packages/registry/gawk/build.toml            # SESSION 10 — revision 1 → 2 (DECISION PENDING)
  packages/registry/grep/build.toml            # SESSION 10 — revision 2 → 3 (DECISION PENDING)
  packages/registry/m4/build.toml              # SESSION 10 — revision 2 → 3 (DECISION PENDING)
  packages/registry/make/build.toml            # SESSION 10 — revision 2 → 3 (DECISION PENDING)
  packages/registry/sed/build.toml             # SESSION 10 — revision 2 → 3 (DECISION PENDING)
New (untracked):
  programs/dri-modeset.c                       # handoff-7 Diff 6 new fixture
  apps/browser-demos/test/kandelo-modeset.spec.ts
  docs/plans/2026-06-09-dri-kandelo-port-handoff-10.md  # THIS FILE
```

Plus the prior session's untracked: `sysroot64/`, `local-binaries/...`, `host/dist/*` (all gitignored).

There is also a background `prepare-browser-2` run that was still going when this doc was written. Task ID `blmfrti21` in the harness; log at `/tmp/prepare-browser-2.log`. By the time next session reads this it'll have completed (or timed out at 1h).

## Things the next session MUST do — in order

1. **DO NOT proceed to commits yet.** Resolve the revision-bump puzzle (option a/b/c/d above) before staging.

2. **Confirm gates are still green** with a fresh `bash build.sh` + 5-gate run. The session-10 build state is preserved; a quick `cargo test`, `cd host && npx vitest run`, and `bash scripts/check-abi-version.sh` should be enough (gates 3 + 4 are slow but should also still pass).

3. **Decide the demo question.** If pursuing (a): investigate `tools/xtask/src/build-deps.rs` (or grep `cache_key_sha` under `tools/xtask/`). The xtask source-build path must be made to fire when `revision` changes — if it doesn't, that's a real bug in the package system that's worth fixing in this PR. If you go (b) or (c): the cleanup commands are:

   ```bash
   # Force xtask to source-rebuild the 8 stale packages
   rm -f local-binaries/programs/wasm32/{coreutils,gawk,grep,m4,make,sed}.wasm
   rm -rf local-binaries/programs/wasm32/{diffutils,findutils}/
   rm -rf ~/.cache/kandelo/programs/{coreutils,diffutils,findutils,gawk,grep,m4,make,sed}-*

   # Then re-run
   WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
     PATH=/nix/var/nix/profiles/default/bin:$PATH \
     scripts/dev-shell.sh bash -c './run.sh prepare-browser'
   ```

   If pursuing (d): revert the 8 build.toml changes (`git checkout packages/registry/{coreutils,diffutils,findutils,gawk,grep,m4,make,sed}/build.toml`) and skip the demo verification.

4. **After the demo path is sorted, finalize the demo.** `./run.sh browser` should now Just Work with the SDK env var. The earlier Vite startup happened at port 5402 (5401 was held by the failed first attempt — restart the shell or `lsof -ti:5401 | xargs kill -9` first). Modeset demo URL: `http://localhost:5401/?demo=modeset` (or `?demo=cube-pyramid` for the cube-pyramid pane). Preset key list is in `apps/browser-demos/pages/kandelo/presets.ts`.

5. **Then proceed to the 6-commit boundary plan from handoff-9 §"Things the next session MUST do" item 3.** Suggested boundaries unchanged, but commit #6 should additionally include any `build.toml` revision bumps you decide to keep.

   | # | Files | Summary |
   |---|-------|---------|
   | 1 | `wasm_api.rs`, `syscalls.rs` (handoff-7 Diffs 1+2) | fix mmap errno propagation + accept raw bo size |
   | 2 | `syscalls.rs` (handoff-7 Diffs 3+4 + handoff-8 Diff A unit test) | drain PAGE_FLIP synchronously into event_ring |
   | 3 | `host/src/kernel.ts`, `host/src/kernel-worker.ts` (handoff-8 Diffs B+C) | wire primeBindFromSab on DRI mmap |
   | 4 | `build-programs.sh`, `dri-smoke.test.ts`, `dri-modeset.test.ts`, `programs/dri-modeset.c` | test plumbing + retarget dri-modeset |
   | 5 | `syscalls.rs` (session-9 Diff D — handlers + cmdbuf mmap + 5 unit tests) | implement GLIO ioctl protocol for renderD128 GL sessions |
   | 6 | `crates/shared/src/lib.rs`, `abi/snapshot.json`, `host/src/generated/abi.ts`, `libc/glue/abi_constants.h`, *(optionally `packages/registry/*/build.toml` × 8)* | bump ABI_VERSION 14→15 + regenerate snapshot *(+ invalidate package caches if option a/b)* |

   **Wait for user input before each commit** — standing instruction.

## Reference: the inline TS used to decode ABI per binary

```ts
// /tmp/check-all-abi.ts
import { extractAbiVersion } from "<repo>/host/src/constants";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
const ROOT = "<repo>/local-binaries/programs/wasm32";
const stale: string[] = [];
const fresh: string[] = [];
function walk(dir: string, prefix = "") {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, prefix + e + "/");
    else if (e.endsWith(".wasm")) {
      const buf = readFileSync(p);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const abi = extractAbiVersion(ab as ArrayBuffer);
      const rel = prefix + e;
      if (abi === 15) fresh.push(rel);
      else stale.push(rel + " (ABI " + abi + ")");
    }
  }
}
walk(ROOT);
console.log("FRESH:", fresh.length, "\nSTALE:", stale.length);
for (const r of stale) console.log("  " + r);
```

Run with `cd host && PATH=/nix/var/nix/profiles/default/bin:$PATH ../scripts/dev-shell.sh bash -c 'npx tsx /tmp/check-all-abi.ts'`.

## Important constraints, do not violate (carry-forward from v1–v9)

- One PR against `Automattic/kandelo:main`. All five test gates green first. **Session 10 confirms all five are green.**
- Dual-host parity for any `host/src/` touch — automatic for session-9/10 work because `kernel.ts` and `kernel-worker.ts` are shared.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input before each commit.

## Reference points (additions in session 10)

- Apple SDK override for SpiderMonkey: `packages/registry/spidermonkey/build-spidermonkey.sh:31` reads `WASM_POSIX_MACOS_SDK_DIR`; not in dev-shell `--keep` so set inside inner `bash -c`.
- Vite binary resolver: `apps/browser-demos/vite.config.ts:123-152` (plugin) → `host/src/binary-resolver.ts:tryResolveBinary` → `chooseBinaryCandidate` policy filter at `host/src/binary-resolver.ts:274-279`.
- ABI version extraction from user binaries: `host/src/constants.ts:737` (`extractAbiVersion`). Reads `i32.const` from a function export named `__abi_version`.
- Browser binary build groups: `run.sh:1543` `BROWSER_EXTERNAL_GALLERY_PKGS`, `:1549` `BROWSER_FETCH_SKIP_PKGS`, `:1557` `BROWSER_DEPS`, `:1559-1577` `build_browser` / `fetch_browser_binaries`, `:2071-2082` `cmd_prepare_browser`, `:2084-2098` `cmd_browser`.
- Modeset preset definition: `apps/browser-demos/pages/kandelo/presets.ts:121` (`id: "modeset"`). Playwright spec: `apps/browser-demos/test/kandelo-modeset.spec.ts:19` (`"/?demo=modeset"`).
- Cache directory layout for xtask resolver: `~/.cache/kandelo/programs/<pkg>-<ver>-rev<N>-<arch>-<sha>/`. Inspect after a re-run to confirm whether a new `rev<N+1>` dir is created.
- All prior handoffs: `docs/plans/2026-06-08-dri-kandelo-port-handoff{,-2,-3}.md`, `docs/plans/2026-06-09-dri-kandelo-port-handoff{-4,-5,-6,-7,-8,-9}.md`.
