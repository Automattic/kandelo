# Phase B Reproducibility Audit

Date: 2026-05-06
Branch: `phase-b-1-matrix-ci`

## Conclusion

**D3 content-hash gating is viable.** Two pilot packages produced byte-identical `.tar.zst` archives across paired runs in the same Nix dev shell, with provenance (`--build-timestamp`, `--build-host`) pinned to fixed values.

| Package | Kind | Result | Archive sha (filename short-sha) |
|---|---|---|---|
| `zlib` | library, no deps | ✅ PASS | `d380c4e6` |
| `bash` | program, ncurses dep | ✅ PASS | `d4880ab3` |
| `mariadb` | program, pcre2-source dep | ⏭ SKIPPED | — |

## What this certifies

Within the same Nix dev shell on the same host, with provenance inputs pinned:

- The archive-staging pipeline (`xtask::archive_stage`) emits deterministic tar+zstd bytes for `zlib` and `bash`.
- `compute_sha` produces stable cache-key shas for the entire 60-package registry — every package's `cache_key_sha` matched its prior `binaries-abi-v6` release sha when the registry was force-built fresh into the audit cache (e.g. `bash`'s sha is `d4880ab3` both in the existing release archive and in the audit's run-1 staging).

## Methodology

`scripts/reproducibility-audit.sh` runs `xtask stage-release` twice into separate staging dirs, with `--force-rebuild <pkg>` for each pilot package and pinned `--build-timestamp 2026-01-01T00:00:00Z --build-host audit-pilot`. Both runs share the default `~/.cache/wasm-posix-kernel/` so transitive deps come from cache; only the listed pilot packages source-rebuild on each run.

After both runs complete, the script compares each pilot package's `.tar.zst` byte-for-byte (filenames first — if `cache_key_sha` differs the filenames differ — then `cmp -s` if filenames match).

## Issues encountered + corrections (incorporated into the script)

1. **No `xtask archive-stage` subcommand.** The closest production path is `xtask stage-release`. The script calls it directly (not via `scripts/stage-release.sh`, which doesn't forward `--cache-root`).
2. **`.cargo/config.toml` defaults `target = "wasm64-unknown-unknown"`**, so `cargo run -p xtask` without `--target` tries to build xtask for wasm64 (fails — no std for wasm64). The script passes `--target $(rustc -vV | awk '/^host/ {print $2}')`.
3. **Wall-clock `current_utc_iso()` baked into `manifest.toml`'s `[compatibility]` block.** Without pinning `--build-timestamp` and `--build-host`, two consecutive runs would produce different manifest content → different archive bytes → spurious FAIL on every package. The script pins both.
4. **Tag must match the release-tag pattern** (`binaries-abi-v<N>`, `binaries-abi-v<N>-YYYY-MM-DD`, or `pr-<NNN>-staging`). The script uses `pr-99999-staging` to satisfy validation.
5. **Per-run `--cache-root /tmp/...-runN`** caused stage-release to source-rebuild every transitive dep on each run because the per-run cache was empty. This turned the audit from 30-60 min into a 8-16 hour rebuild of the entire registry. Fix: use the shared `~/.cache/wasm-posix-kernel/`. Per-run isolation matters only for the `--force-rebuild` target packages.

## Packages excluded from D3 gating

**`mariadb`** (and its dependents `mariadb-test`, `mariadb-vfs`, `lamp`) — a force-rebuild attempt fails with a CMake configuration error (`Configuring incomplete, errors occurred!`). This is a pre-existing main-branch issue tracked in `docs/package-management-future-work.md` ("Cross-package source-tree reads (mariadb-install pattern)") — not a reproducibility leak. mariadb's reproducibility cannot be tested here until the source-build path is fixed.

For Phase B's CI matrix gating: `mariadb` and its dependents fall back to **D2 (file-path change detection)** until the build issue is resolved, at which point the audit can be re-run for those packages.

## Cross-platform check

Not run. The audit was run only in the local Nix dev shell on macOS aarch64. CI runs Linux Nix, so same-environment reproducibility is the load-bearing case for D3 gating in CI; the cross-shell question (Homebrew clang vs. Nix LLVM) is moot for D3's single-environment use case but still relevant for developer-machine consistency.

## Recommendation for Phase B-1 Task 2 onward

D3 content-hash gating is the default. mariadb / mariadb-test / mariadb-vfs / lamp use D2 fallback as a documented exception. When the mariadb build issue is fixed (tracked separately), the audit can be re-run to upgrade those four to D3.

## Optional follow-up: expand the audit

The 2-package pilot is sufficient signal to ship Phase B-1, but a broader sweep (every library + ~10 representative programs) would build confidence. Estimated cost: ~60-90 min of additional wall-clock for the same shared-cache shape. Not blocking.
