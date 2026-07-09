# DRI port onto kandelo:main — session 59 handoff (vitest 882/1/19, audit fixes + exnref-flag + ABI-16 rebuilds, uncommitted)

Continuation of [handoff-58](./2026-06-16-dri-kandelo-port-handoff-58.md). Session 59 attacked the vitest failure cluster *before* committing — per the user's "tests must pass first, especially vitest" directive — and brought the suite from **710/151/41** to **882/1/19**. The single remaining failure pre-existed at tip `e6cc2f5d8`. Working tree still uncommitted; the user paused before the commit so the next session can carry the handoff forward.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2` (tracking `origin/explore-dri-sdl2`). Tip `e6cc2f5d8`. **No new commits pushed this session.**
2. **PR #709:** untouched. User's "leave it as-is" from session 57 still stands. **Do NOT `gh pr *` without explicit in-session permission.**
3. **ABI:** still 16. No structural snapshot drift this session.
4. **Working tree:** ~16 modified/new files. Includes everything in handoff-58's table PLUS this session's three additions (`host/vitest.config.ts`, `host/test/fork-dlopen-replay-e2e.test.ts`, `packages/registry/erlang/test/erlang.test.ts`) and the freshly-compiled `packages/registry/erlang/demo/ring.beam`.
5. **Tests at end of session:** cargo not re-run since handoff-58 (1072/0 stands), vitest **882/1/19** (was 710/151/41 baseline), libc-test/posix-tests not re-run (no kernel changes).
6. **The 1 remaining vitest failure** is `installs cowsay with npm and runs its package bin` in `packages/registry/spidermonkey/test/spidermonkey-node-compat.test.ts`. **It was already failing at tip `e6cc2f5d8`** with an ABI-mismatch signature; rebuilding spidermonkey-node to ABI 16 changed the symptom to `Cannot find module '/usr/local/lib/kandelo/npm-runner.js'`. Deep mount-vs-bootstrap issue; the user accepted it as out-of-scope-but-document.

## What this session changed

### A. Vitest config — enable `--experimental-wasm-exnref` for forks

`host/vitest.config.ts` `poolOptions.forks.execArgv = ["--experimental-wasm-exnref"]`. Cached user binaries (php/erlang/spidermonkey/wordpress/mariadb) are compiled with `-fwasm-exceptions` and embed the `exn` value type; Node 24 keeps the wasm-exnref proposal behind a flag, and `NODE_OPTIONS` doesn't accept `--experimental-*` flags. Net: instant +79 passing tests (151 → 72) once the fork has the flag. Worker_threads spawned by NodeKernelHost inherit `process.execArgv` so the flag propagates to the kernel worker + process workers automatically.

**Diagnostic confirmed via** `host/test/exnref-probe.test.ts` (since deleted) which printed `process.execArgv` from the fork.

### B. Source-rebuild stale binaries against ABI 16

Upstream `binaries-abi-v16/index.toml` doesn't exist (returns 404 — release not published yet); the v15 release was the last published. Resolver fell back to source builds. Successfully rebuilt:

| Package | Build path | Notes |
|---|---|---|
| spidermonkey | `cargo run -p xtask -- build-deps resolve spidermonkey` | Failed first with "SDK 14.4 too old, need 15.5+". Fix: set `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` **inside** the dev-shell `bash -c` (the dev-shell's `--ignore-environment` + curated `--keep` list strips env vars not in the keep list). System SDK is 26.5. Output: `local-binaries/programs/wasm32/js.wasm` (ABI 16). |
| spidermonkey-node | resolve cascade | Output: `local-binaries/programs/wasm32/spidermonkey-node.wasm` + `node.wasm` (ABI 16). |
| node | resolve cascade | Same binary as spidermonkey-node's node.wasm (shared script). |
| php | resolve | **First rebuild produced ABI 15** because `php-src/`'s `.o` files persisted from a prior build (PHP's libtool doesn't track `libc/glue/abi_constants.h` as a dep). Fix: `make -C php-src clean && rm -rf /Users/mho/.cache/kandelo/programs/php-8.3.2-rev3-wasm32-4614de05` then re-resolve. Second rebuild: ABI 16. |
| erlang | resolve | Came out clean ABI 16 first try. |

**Other stale binaries** (24 total at session start — see handoff-58 §"Files changed this session" if needed for the full list) **were NOT rebuilt** because no failing test depends on them (`bzip2`, `less`, `nethack`, `nginx`, `quickjs`, `ruby`, `tcl`, `texlive/pdftex`, `unzip`, `vim`, `zip`, etc.). The resolver gates ABI mismatches in `binary-resolver.ts::hasWasmArtifactPolicyFailures` so those tests skip cleanly.

**SDK + dev-shell environment caveat:** the SpiderMonkey build *requires* macOS SDK ≥ 15.5 for the build host (clang `arm64-apple-darwin25.5.0` needs a SDK that's at least 15.5 — system Xcode/CommandLineTools provides 26.5). The Nix flake currently pins `apple-sdk-14.4`, which the build script reads from `xcrun --show-sdk-path` *if* `WASM_POSIX_MACOS_SDK_DIR` is unset. The dev-shell strips env vars, so passing the SDK from outside doesn't work — must set it **inside** the dev-shell `bash -c`:

```bash
PATH="/nix/var/nix/profiles/default/bin:$PATH" bash scripts/dev-shell.sh bash -c '
  export WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
  cargo run --target aarch64-apple-darwin --manifest-path tools/xtask/Cargo.toml -- build-deps resolve spidermonkey
'
```

This is undocumented anywhere — worth a follow-up note in `docs/cross-compilation` or wherever the dev-shell quirks live.

### C. erlang.test.ts — pass `--experimental-wasm-exnref` to spawned subprocess

`runErlang` in `packages/registry/erlang/test/erlang.test.ts` was calling `execFileSync("npx", ["tsx", serveScript, ...])`. The spawned `npx tsx` is a fresh Node process — it does NOT inherit `process.execArgv` from the vitest fork. So even with our vitest.config fix, the spawned tsx subprocess lacked the wasm-exnref flag and erlang.wasm (built with `-fwasm-exceptions`) failed to compile.

Fix: switch to `execFileSync(process.execPath, ["--experimental-wasm-exnref", "--import", "tsx", serveScript, ...])`. The kernel worker_thread that serve.ts spins up still inherits process.execArgv from the spawned Node. Net: +4 erlang tests pass.

### D. fork-dlopen-replay-e2e.test.ts — fallback LLVM_BIN discovery

Test hardcoded `LLVM_BIN = "/opt/homebrew/opt/llvm@21/bin"` — Homebrew-only. On a Nix dev-shell host (no Homebrew LLVM, clang via `/nix/store/.../clang-wrapper-21.1.7/bin`), the path doesn't exist and the test fails on `execSync(${CLANG}...)`.

Fix: `discoverLlvmBin()` helper — honors `process.env.LLVM_BIN`, then checks the Homebrew default, then falls back to `command -v clang` (resolves to whatever is on PATH). Added `hasClang` to the existing `describe.skipIf` so the test skips cleanly when no clang is available rather than hard-failing.

### E. erlang ring benchmark — compile `ring.beam`

`packages/registry/erlang/demo/.gitignore` carries `!ring.beam` (a negation) — indicating ring.beam IS supposed to be tracked. Wasn't present in the worktree, though. `ring.erl` source is in the demo dir. After running `erlc ring.erl` (in dev-shell with Erlang 28 on PATH), `ring.beam` was compiled. Net: +1 erlang test (`runs ring benchmark with message passing`) pass.

**Question for next session:** should `ring.beam` be checked into git, or should the erlang test setup invoke `erlc ring.erl` before running? Probably the latter — but that's a separate concern.

## The 1 remaining failure

```
FAIL ../packages/registry/spidermonkey/test/spidermonkey-node-compat.test.ts
  > SpiderMonkey Node compatibility runtime > npm package installation > installs cowsay with npm and runs its package bin
```

**Symptom (post-rebuild):** `Cannot find module '/usr/local/lib/kandelo/npm-runner.js'` thrown from `_runMainScriptIfPresent` (defined at `packages/registry/node-compat/bootstrap.js:4553`). `std.loadFile(_mainScriptPath)` returns null.

**Symptom (pre-rebuild, at tip `e6cc2f5d8`):** `ABI version mismatch — kernel advertises 16, user program built against 14`. Same test, different failure mode — the rebuild legitimately fixed the ABI half but exposed an underlying issue we don't yet understand.

**Test setup:**
- Writes `npm-runner.js` to a host helperDir under `mkdtempSync(tmpdir())`.
- Constructs `NodeKernelHost` with `extraMounts: [{ mountPoint: "/usr/local/lib/kandelo", hostPath: helperDir, readonly: true }, …]`.
- Spawns `host.spawn(nodeBytes, ["node", "/usr/local/lib/kandelo/npm-runner.js", "npm", "install", …])`.

**What I tested:**
- ABI of the rebuilt spidermonkey-node.wasm: **16** ✓
- Other passing tests in the same file (`evaluates Node-style -e scripts`, `provides Buffer, path, util, …`) use the same `nodeBytes` and pass cleanly — so the binary itself is fine.
- `extraMounts` is wired through `NodeKernelHostOptions` → kernel-worker `init` → `buildVirtualPlatformIO(rootfsImage, extraMounts)` in `host/src/node-kernel-worker-entry.ts:551`.
- Other passing tests don't load files via `std.loadFile` from `extraMounts`-mounted paths.

**Hypothesis (untested):** `std.loadFile` is SpiderMonkey's shell-level file API, possibly bypassing the kernel VFS layer that extraMounts hooks into. If `std.loadFile` reads from a different syscall path (e.g., `host_fs` direct rather than VFS-routed `open`), it would never see the mounted helperDir at `/usr/local/lib/kandelo/`. The fact that `npm install` (which uses `require()` and `fs.readFileSync` from the Node-compat shim, which DO go through libc → channel_syscall) might work once we get past the bootstrap suggests this is bootstrap-specific.

**Why this is out-of-scope for PR #709:** The test was already failing at tip before this session; the audit work in PR #709 doesn't touch `std.loadFile`, `node-compat/bootstrap.js`, or extraMounts. Fixing it requires either:
1. Refactoring `_runMainScriptIfPresent` to use `require`-style loading (which goes through libc) instead of `std.loadFile`.
2. Making `std.loadFile` route through the VFS layer (kernel-side change).
3. Marking the test `skipIf` until the bootstrap is reworked (acceptable for now since it pre-existed).

## Files modified this session (uncommitted)

Builds on handoff-58's table — all of handoff-58's files PLUS:

| File | Change | Why |
|---|---|---|
| `host/vitest.config.ts` | +`poolOptions.forks.execArgv = ["--experimental-wasm-exnref"]` | §A — enable exnref for fork workers. |
| `packages/registry/erlang/test/erlang.test.ts` | swap `execFileSync("npx", …)` → `execFileSync(process.execPath, ["--experimental-wasm-exnref", "--import", "tsx", …])` | §C — flag the spawned subprocess. |
| `host/test/fork-dlopen-replay-e2e.test.ts` | `discoverLlvmBin()` fallback; `hasClang` in skipIf | §D — graceful skip when no clang. |
| `packages/registry/erlang/demo/ring.beam` (NEW) | compiled from `ring.erl` via `erlc` | §E — required by the erlang ring benchmark test. Untracked but ignore-rule `!ring.beam` whitelists it. |
| `local-binaries/programs/wasm32/js.wasm` (REBUILT, ABI 16) | source build via xtask | §B. |
| `local-binaries/programs/wasm32/spidermonkey-node.wasm` (REBUILT, ABI 16) | source build via xtask | §B. |
| `local-binaries/programs/wasm32/node.wasm` (REBUILT, ABI 16) | source build via xtask | §B. |
| `local-binaries/programs/wasm32/php/php.wasm` (REBUILT, ABI 16) | source build via xtask after `make clean` | §B. |
| `local-binaries/programs/wasm32/php/php-fpm.wasm` (REBUILT, ABI 16) | same | §B. |
| `local-binaries/programs/wasm32/php/opcache.so` (REBUILT) | same | §B. |
| `local-binaries/programs/wasm32/erlang/erlang.wasm` (REBUILT, ABI 16) | source build via xtask | §B. |
| `local-binaries/programs/wasm32/erlang/erlang-otp.tar.zst` (REBUILT) | same | §B. |

All of handoff-58's audit-fix files (programs/sdl2_demo.c, host/test/sdl2-demo.test.ts, crates/kernel/src/audio/pcm_ioctl.rs, host/src/kernel-worker.ts, packages/registry/sdl2/build.toml, packages/registry/sdl2/patches/0002-polling-audio-eagain.patch, scripts/build-programs.sh, docs/architecture.md, docs/posix-status.md) remain modified.

The NEW handoff-58 files (`host/test/ioctl-encoded-marshalling.test.ts`, `host/test/gbm-surface-ring.test.ts`, `programs/gbm_surface_smoke.c`, `docs/plans/2026-06-16-dri-kandelo-port-handoff-58.md`, `docs/plans/2026-06-16-dri-kandelo-port-handoff-58-audit.md`) are still untracked-new.

## Test progression this session

| Stage | Pass / Fail / Skip |
|---|---|
| Baseline (handoff-58 end) | 710 / 151 / 41 |
| After exnref flag in vitest.config.ts | 789 / 72 / 41 (+79 pass) |
| After spidermonkey + spidermonkey-node + node + erlang rebuilds | 837 / 24 / 41 (+48 pass) |
| After erlang.test fix + LLVM_BIN fallback + ring.beam | 881 / 2 / 19 (+44 pass, 22 unskipped) |
| After PHP v3 rebuild (ABI 16) | **882 / 1 / 19** (+1 pass) |

Net: **-150 failures**, 0 regressions.

## Suggested commit when resuming

The user previously said "fix all of these [8 audit] points in one commit only" (handoff-58). With session-59's additions, the commit scope grew to include the test-infra fixes and the rebuilt binaries. Two reasonable groupings:

**Option A: one big commit** ("everything that made the suite go from 151 → 1 fail")
```
audit(sdl2) + tests(host/erlang): trim WHAT-comments, IoctlEncoded helper + tests, polling-audio cap error, gbm-ring smoke, docs, vitest exnref flag, erlang subprocess flag, llvm-bin fallback

Devil's-advocate audit follow-up for PR #709 + the cluster of test-infrastructure fixes needed to get vitest from 151 fail → 1 fail.

Audit fixes (see docs/plans/2026-06-16-dri-kandelo-port-handoff-58-audit.md):
  - programs/sdl2_demo.c + host/test/sdl2-demo.test.ts: trim WHAT-comments,
    rename test, drop redundant SDL_PumpAudioDevices extern.
  - crates/kernel/src/audio/pcm_ioctl.rs: 3 regression tests for cf610100d.
  - host/src/kernel-worker.ts + host/test/ioctl-encoded-marshalling.test.ts:
    extract computeIoctlEncodedSize helper + 6 boundary tests.
  - programs/gbm_surface_smoke.c + host/test/gbm-surface-ring.test.ts:
    lock/release/has_free_buffers smoke + vitest.
  - packages/registry/sdl2/patches/0002-polling-audio-eagain.patch
    (rev3 → rev4): surface SDL_SetError on >8 concurrent opens.
  - docs/{architecture,posix-status}.md: document ALSA direct path,
    IoctlEncoded, polling-audio, KMS surface, 2-BO gbm ring, GL cmdbuf.

Test-infra fixes (this session):
  - host/vitest.config.ts: poolOptions.forks.execArgv +=
    [--experimental-wasm-exnref]. Lets cached php/erlang/spidermonkey/
    wordpress/mariadb (built with -fwasm-exceptions) compile.
  - packages/registry/erlang/test/erlang.test.ts: spawn node with the
    flag rather than `npx tsx`, since execArgv doesn't inherit across
    process spawn.
  - host/test/fork-dlopen-replay-e2e.test.ts: discoverLlvmBin() falls
    back to `command -v clang` when /opt/homebrew is absent; skipIf
    when no clang is found at all.

Tests: cargo 1072/0 (handoff-58, no kernel changes since), vitest 882/1/19
(was 710/151/41; 1 remaining fail = installs cowsay with npm, pre-existing
at tip e6cc2f5d8 — see docs/plans/2026-06-16-dri-kandelo-port-handoff-59.md
§"The 1 remaining failure"), libc-test/posix-tests GREEN per handoff-58.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

**Option B: two commits** — split audit fixes from test-infra fixes. Cleaner history but the user's session-58 instruction was "one commit only" so I'd default to A.

## Other gotchas to preserve

### check-abi-version.sh still broken

Per handoff-57 Finding §3 — pipefail+grep-q SIGPIPE. Local gauntlet `bash scripts/check-abi-version.sh` exits 1 (false negative). CI doesn't run it. Out-of-scope for PR #709; fix as separate PR.

### Branches in the cache

`~/.cache/kandelo/programs/php-8.3.2-rev3-wasm32-*` accumulated MANY entries (22+) this session because the cache_key_sha is content-derived. The fresh build at `4614de05` is the only one with ABI 16; older keys with ABI 14/15 are still on disk. Safe to delete in cleanup but not load-bearing.

### node.wasm fallback in spidermonkey-node-compat.test.ts

The test does `const nodeWasm = tryResolveBinary("programs/node.wasm") ?? ../bin/node.wasm`. The `packageBuild` fallback path **bypasses** the resolver's ABI policy check — it just `existsSync` checks. So if the local `packages/registry/spidermonkey/bin/node.wasm` is stale-ABI, the test would have used it anyway (silently). Worth a follow-up to wrap the fallback in `extractAbiVersion === ABI_VERSION ? path : null`.

## Standing instruction for session 60 — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-16-dri-kandelo-port-handoff-59.md` first, then handoff-58 + handoff-58-audit.md for prior context. Branch is `explore-dri-sdl2`, tip `e6cc2f5d8` (pushed, unchanged in sessions 58+59). Working tree has ~16 modified/new files + rebuilt binaries — see §'Files modified this session' for the table. Tests at handoff time: cargo 1072/0 (from handoff-58, no kernel changes), vitest **882/1/19** (was 710/151/41 baseline — net -150 failures). The 1 remaining vitest fail is `installs cowsay with npm` in spidermonkey-node-compat.test.ts (pre-existing at tip; see §'The 1 remaining failure'). libc-test + posix-tests not re-run (no kernel changes). **Top priorities, in order:** (1) commit all uncommitted files in a SINGLE commit per the user's session-58 instruction; suggested message in handoff-59 §'Suggested commit'. (2) DO NOT push, DO NOT `gh pr *` without explicit in-session permission — PR #709 stays as-is. (3) Decide whether to file a follow-up about the cowsay test (likely skipIf-gate or refactor `_runMainScriptIfPresent` to use `require` instead of `std.loadFile`). (4) `bash scripts/check-abi-version.sh` still BROKEN. Run vitest under `dev-shell.sh` for the LLVM_BIN env (host/test/fork-dlopen-replay-e2e.test.ts now also discovers clang via `command -v`, so plain `npx vitest run` works too — but dev-shell is the canonical entry). Auto-mode default; bias to action on read-only investigation, pause before any commit/push/PR command."*
