# Decoupled Package Builds — Phase B Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the monolithic publish step with per-package matrix CI, add content-hash-based skip gating (D3), restructure publish + force-rebuild around per-file uploads + `index.toml`, and add the F2 status artifact. Make the new release tag `binaries-abi-v<N>` undated. Tighten `kernel_abi` validation to required. After Phase B, the new infrastructure runs alongside `binaries.lock` (still source-of-truth); Phase C cuts the resolver over.

**Architecture:** Additive — failures don't break existing flows. The new release artifacts are publishable but not yet consumed by `main`. A reproducibility audit (Task 0) is a hard prerequisite — D3 only works if `cache_key_sha` is bit-reproducible across machines.

**Tech Stack:** Rust (xtask), Bash (release scripts), GitHub Actions YAML (matrix workflow + jobs), `actions/cache@v4` (toolchain cache layer), `actions/github-script@v7` (sticky PR comment).

**Reference:** `docs/plans/2026-05-05-decoupled-package-builds-design.md` §5, §6.3, §8 Phase B.

**Scope decision: split into two PRs.**

Phase B is large enough that a single PR is hard to review. Natural split:

- **Phase B-1 (this plan, Tasks 0–7):** Reproducibility audit, `xtask` CLI surface for cache-sha computation, pre-flight + matrix + toolchain-cache + per-file uploads + `index.toml` generation. Resolver still consumes `binaries.lock`; the new flow runs in parallel and produces durable artifacts but doesn't yet drive consumers.
- **Phase B-2 (Tasks 8–11, separate plan):** F2 sticky PR comment, `force-rebuild.yml` restructure, dated→undated tag switch, `kernel_abi` field tightened to required.

Both PRs land within the Phase B umbrella before Phase C starts.

---

## Pre-flight

### Pre-task: scoping + branch setup

**Files:** None — verification + branch creation only.

**Step 1: Confirm origin/main is post-PR-#416 and post-PR-#421.**

```bash
git fetch origin main
git log --oneline origin/main -3
```

Expected: PR #421 (Phase A-bis) merged. If not, **STOP** — Phase B depends on Phase A-bis's `[build]` schema (`script_path`, `repo_url`, `commit`) and the existence of the `xtask set-build-commit` subcommand.

**Step 2: Create the worktree.**

```bash
cd /Users/brandon/ai-src/wasm-posix-kernel
git worktree add /Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-b-1-matrix-ci -b phase-b-1-matrix-ci origin/main
```

**Work from `/Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-b-1-matrix-ci` for all subsequent tasks.**

**Step 3: Confirm xtask builds clean.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -3
cargo test --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -5
```

Expected: clean build; 190+ tests pass (post-Phase-A-bis baseline was 188 + 2 from the back-compat fix at SHA `fa86b1683`).

**Step 4: Quick recon on `compute_sha`.**

```bash
grep -n 'pub fn compute_sha\|fn compute_sha' xtask/src/build_deps.rs | head
```

Expected: `compute_sha` at line ~197 — internal function used by the resolver. Phase B-1 Task 1 promotes it to a CLI subcommand.

---

## Task 0: Reproducibility audit

**Files:**
- Create: `docs/plans/2026-05-06-phase-b-reproducibility-audit.md` (audit log)
- Create: `scripts/reproducibility-audit.sh` (audit runner script)

**Goal:** Verify that every package's `cache_key_sha` is bit-reproducible across (a) two consecutive builds in the same Nix shell on the same machine, and (b) two builds in different Nix shells (e.g., macOS vs Linux). Fix any non-determinism leaks before relying on D3 gating.

**Why first:** D3 gating skips matrix entries whose `cache_key_sha` is already published. If `cache_key_sha` differs spuriously between CI runs (because of timestamp leaks, locale differences, non-pinned tool versions), the gate misfires — either spuriously rebuilding everything, or skipping packages that should rebuild. Either failure mode breaks the partial-publish guarantees Phase B is meant to deliver.

The known leak is the Homebrew clang vs Nix LLVM 21 producer divergence surfaced in PR #407 (memory: `feedback_always-use-nix-shell-for-builds.md`). There may be others.

**Step 1: Write the audit script.**

Create `scripts/reproducibility-audit.sh`:

```bash
#!/usr/bin/env bash
# Builds every package twice in the same Nix shell and diffs the
# resulting .tar.zst archives + cache_key_sha values.
#
# Usage:
#   bash scripts/reproducibility-audit.sh                    # all packages
#   bash scripts/reproducibility-audit.sh bash zlib          # subset
#
# Output: per-package "PASS" / "FAIL: <reason>" in /tmp/repro-audit.log
# Exits 0 if all PASS; exits 1 if any FAIL.

set -euo pipefail

mode="${1:-all}"
log=/tmp/repro-audit.log
: > "$log"

# (Implementation: pick targets, build to /tmp/build-1/<pkg>, then
# /tmp/build-2/<pkg>, diff archives byte-for-byte, log result.)
# Leave the actual implementation up to the executor — the structure
# is: clean cache; build pkg twice into separate dirs; sha256 each
# tarball; assert equal; if not, run `diff -r` of staged trees and
# log the divergent files.
```

**Step 2: Run the audit on the current state of `main`.**

```bash
bash scripts/reproducibility-audit.sh 2>&1 | tee /tmp/repro-audit.log
echo "exit code: $?"
```

This will likely surface multiple leaks. Common suspects:

- **Timestamps embedded in tarball entries.** `tar` by default writes mtime; archives produced milliseconds apart will differ. Check `xtask::archive_stage` for any non-deterministic mtime handling.
- **Locale-sensitive sort order.** A `find ... | sort` step that respects `LC_COLLATE` will produce different orderings across locales.
- **Non-pinned tool versions.** Anything in PATH that's not under the Nix flake's purview (e.g., a Homebrew-installed `clang` shadowing the Nix one).
- **Build-script `__DATE__` / `__TIME__` macros.** C-preprocessor injects build-time constants into the binary.
- **Random PRNG seeds.** Some build systems include a build-time-random hash for cache-busting.

**Step 3: Fix each leak.**

Each leak gets its own commit. Examples:

- For tar mtime: set a deterministic mtime (e.g., 0 or the source tarball's mtime) in `xtask::archive_stage`.
- For sort: use `LC_ALL=C sort` everywhere.
- For `__DATE__`: set `SOURCE_DATE_EPOCH` in the build environment so reproducible-builds-aware compilers use a deterministic value.
- For unpinned tools: add to the Nix flake's tool list; remove any `PATH` extension that pulls from outside Nix.

Per-fix commit pattern:

```bash
git add <files>
git commit -m "fix(repro): <one-line description of the leak>

<one-paragraph explanation of what was leaking and how the fix
addresses it>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**Step 4: Re-run the audit until 0 FAIL.**

```bash
bash scripts/reproducibility-audit.sh 2>&1 | tee -a /tmp/repro-audit.log
```

If a particular package can't be made reproducible after reasonable effort (e.g., has a transitive dep that injects randomness), document the limitation and mark that package for D2 fallback (file-path change detection) in Task 2's matrix gating.

**Step 5: Run the cross-platform audit.**

If you have access to both macOS-Homebrew and Linux-Nix environments, build a representative subset of packages on both and diff. If the audit was done only in Nix shell, document this as a limitation; CI runs on Linux Nix so same-environment reproducibility is the load-bearing case.

**Step 6: Write the audit log.**

Create `docs/plans/2026-05-06-phase-b-reproducibility-audit.md`:

```markdown
# Phase B Reproducibility Audit

Date: 2026-05-XX
Branch: phase-b-1-matrix-ci

## Summary

| Package | Same-shell repro | Cross-shell repro | Notes |
|---|---|---|---|
| bash | ✅ | ✅ | |
| ... | ... | ... | ... |

## Leaks found and fixes

1. <leak description> → fixed in commit <sha>
2. ...

## Packages excluded from D3 gating

(If any couldn't be made reproducible.)

## Methodology

(Brief description of how the audit was run.)
```

**Step 7: Commit the audit script + log + any final fix.**

```bash
git add scripts/reproducibility-audit.sh docs/plans/2026-05-06-phase-b-reproducibility-audit.md
git commit -m "docs(plans): Phase B reproducibility audit

Audit log + runner script. All N packages reproducible same-shell;
M leaks found and fixed in prior commits in this PR. Per-fix detail
in the audit log.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**Risk:** This task is open-ended — number of leaks is unknown until we look. Budget 1-3 days. If the audit reveals showstopper-level non-determinism (e.g., a fundamental build-script issue across many packages), pause Phase B and address as its own initiative.

---

## Task 1: `xtask compute-cache-key-sha` CLI subcommand

**Files:**
- Modify: `xtask/src/main.rs` (subcommand dispatch)
- Modify: `xtask/src/build_deps.rs` (expose `compute_sha` via the new subcommand)
- Possibly: `xtask/src/build_deps.rs` test module (test the CLI surface)

**Goal:** Add `cargo xtask compute-cache-key-sha --package examples/libs/bash --arch wasm32` that prints the package's `cache_key_sha` (64-hex). The pre-flight workflow (Task 2) calls this for every (package, arch) pair to decide which matrix entries to skip.

**Step 1: Find `compute_sha` and understand its inputs.**

```bash
grep -nB 2 -A 20 'pub fn compute_sha' xtask/src/build_deps.rs | head -40
```

It already exists as an internal function. The subcommand wraps it with CLI argument parsing and stdout output.

**Step 2: Write the failing test.**

In `xtask/src/build_deps.rs`'s test module:

```rust
#[test]
fn compute_cache_key_sha_subcommand_prints_64_hex() {
    // (Use the test harness to invoke the subcommand against a
    // fixture package.toml, capture stdout, assert it's exactly
    // 64 hex chars + newline.)
}

#[test]
fn compute_cache_key_sha_changes_when_input_changes() {
    // Bump revision in fixture; assert sha differs.
}
```

**Step 3: Run the tests; confirm they fail.**

```bash
cargo test --release -p xtask --target aarch64-apple-darwin compute_cache_key_sha 2>&1 | tail -5
```

Expected: FAIL — function/subcommand doesn't exist yet.

**Step 4: Implement the subcommand.**

In `xtask/src/main.rs`, add the dispatch entry. In `xtask/src/build_deps.rs`, add the public CLI function:

```rust
pub fn run_compute_cache_key_sha(args: &[String]) -> Result<(), String> {
    // Parse --package <path> --arch <wasm32|wasm64>
    // Load DepsManifest, build target graph, call compute_sha,
    // print hex sha to stdout.
}
```

The CLI surface should be minimal and stable — it'll be called from the GHA pre-flight job many times.

**Step 5: Run the tests; confirm they pass.**

```bash
cargo test --release -p xtask --target aarch64-apple-darwin compute_cache_key_sha 2>&1 | tail -5
```

**Step 6: Smoke against a real package.**

```bash
cargo run --release -p xtask --target aarch64-apple-darwin --quiet -- \
  compute-cache-key-sha --package examples/libs/bash --arch wasm32
```

Expected: a 64-hex string + newline. Run twice; should produce the same output.

**Step 7: Commit.**

```bash
git add xtask/src/main.rs xtask/src/build_deps.rs
git commit -m "feat(xtask): compute-cache-key-sha CLI subcommand

Wraps the existing internal compute_sha function as a stable CLI
surface. Phase B-1 pre-flight workflow calls this for every
(package, arch) pair to decide which matrix entries to skip.

Output is exactly 64 hex chars + newline on stdout. Errors go to
stderr.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pre-flight workflow job — compute shas + narrow matrix

**Files:**
- Modify: `.github/workflows/staging-build.yml`

**Goal:** A new GHA job runs first, computes `cache_key_sha` for every (package, arch), probes the target release for an existing archive, and emits a JSON list of "matrix entries that need to run." The matrix uses this as its `strategy.matrix.include` source.

**Step 1: Read today's `staging-build.yml`.**

Understand the existing single-job flow. The new pre-flight job replaces the "decide what to do" preamble; the matrix replaces the monolithic build step.

**Step 2: Write the pre-flight job.**

```yaml
preflight:
  runs-on: ubuntu-latest
  outputs:
    matrix: ${{ steps.compute.outputs.matrix }}
    abi:    ${{ steps.compute.outputs.abi }}
  steps:
    - uses: actions/checkout@v4
    # ... (Nix setup, cargo cache, etc.)
    - name: Build xtask
      run: nix develop --accept-flake-config --command cargo build --release -p xtask
    - name: Compute matrix
      id: compute
      run: |
        # For each (package, arch) where package.toml has [build]:
        #   sha=$(cargo xtask compute-cache-key-sha --package ... --arch ...)
        #   probe binaries-abi-v<N>/<name>-<arch>-<sha>.tar.zst
        #   if not present, add {package, arch, sha} to matrix
        # Emit JSON via $GITHUB_OUTPUT
```

The probe is a `gh release view` or `curl --head` against the asset URL. If the file exists, skip; else include.

**Step 3: Wire the per-package matrix to consume preflight's output.**

```yaml
build:
  needs: [preflight, toolchain-cache]   # toolchain-cache is Task 3
  if: ${{ needs.preflight.outputs.matrix != '[]' }}
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      include: ${{ fromJSON(needs.preflight.outputs.matrix) }}
  steps:
    - # restore toolchain cache
    - # build the single (package, arch) pair
    - # upload archive as workflow artifact (NOT yet to release)
```

**Step 4: Commit.**

```bash
git add .github/workflows/staging-build.yml
git commit -m "feat(ci): pre-flight job computes matrix from cache_key_sha probe

The staging-build workflow gains a preflight job that runs xtask
compute-cache-key-sha for every (package, arch) pair, probes the
target release for an existing archive, and emits a narrowed matrix
of entries that need to rebuild. Skipped entries don't even start
a job.

Builds on Task 0's reproducibility audit — D3 gating is only sound
when cache_key_sha is bit-reproducible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**Note:** The matrix job stub above is incomplete — Tasks 3 (toolchain cache) and 4 (per-package build step) flesh it out. This task lands the pre-flight + matrix scaffolding; it should be commented out or guarded by `if: false` until Tasks 3-4 land, OR all three land in one commit. Implementer's call.

---

## Task 3: Toolchain cache job

**Files:**
- Modify: `.github/workflows/staging-build.yml`

**Goal:** A separate job builds the musl sysroot + libc++ once, uploads them as a GHA cache layer keyed on `scripts/build-musl.sh` + `scripts/build-libcxx.sh` + `glue/` content hash. Matrix entries restore from this cache instead of rebuilding the toolchain N times.

**Step 1: Add the `toolchain-cache` job.**

```yaml
toolchain-cache:
  runs-on: ubuntu-latest
  outputs:
    cache-key: ${{ steps.key.outputs.value }}
  steps:
    - uses: actions/checkout@v4
    - # Nix setup
    - name: Compute cache key
      id: key
      run: echo "value=musl-sysroot-v3-${{ runner.os }}-$(...)" >> $GITHUB_OUTPUT
    - uses: actions/cache@v4
      id: cache
      with:
        path: |
          sysroot
          sysroot64
        key: ${{ steps.key.outputs.value }}
    - name: Build sysroot
      if: steps.cache.outputs.cache-hit != 'true'
      run: |
        nix develop --accept-flake-config --command bash scripts/build-musl.sh
        nix develop --accept-flake-config --command bash scripts/build-musl.sh --arch wasm64posix
        nix develop --accept-flake-config --command bash scripts/build-libcxx.sh
        # ...
```

The existing prepare-merge.yml has an equivalent step — copy and adapt.

**Step 2: Have the matrix job restore the toolchain cache.**

```yaml
build:
  needs: [preflight, toolchain-cache]
  steps:
    - uses: actions/checkout@v4
    - # Nix setup
    - uses: actions/cache@v4
      with:
        path: |
          sysroot
          sysroot64
        key: ${{ needs.toolchain-cache.outputs.cache-key }}
        fail-on-cache-miss: true
    - # build the package
```

**Step 3: Commit.**

```bash
git add .github/workflows/staging-build.yml
git commit -m "feat(ci): toolchain-cache job + matrix-side restore

Builds musl + libc++ once per cache-key-equivalence-class, uploads
to actions/cache@v4. Per-package matrix entries restore from this
cache instead of rebuilding the toolchain N times. Cuts CI minutes
substantially and matches today's prepare-merge.yml caching shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Per-package matrix build step

**Files:**
- Modify: `.github/workflows/staging-build.yml`

**Goal:** Each matrix entry runs the actual build for one (package, arch) and uploads the resulting `.tar.zst` as a GHA workflow artifact (not yet to the release). Failures fail just that entry; other entries continue.

**Step 1: Write the build step.**

```yaml
build:
  needs: [preflight, toolchain-cache]
  if: ${{ needs.preflight.outputs.matrix != '[]' }}
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      include: ${{ fromJSON(needs.preflight.outputs.matrix) }}
  steps:
    - uses: actions/checkout@v4
    - # Nix setup, cargo cache
    - # toolchain-cache restore (from Task 3)
    - name: Build ${{ matrix.package }} (${{ matrix.arch }})
      run: |
        nix develop --accept-flake-config --command \
          cargo run -p xtask --quiet -- archive-stage \
            --package "${{ matrix.package }}" \
            --arch "${{ matrix.arch }}" \
            --out "$RUNNER_TEMP/staged"
    - name: Upload archive as workflow artifact
      uses: actions/upload-artifact@v4
      with:
        name: ${{ matrix.package }}-${{ matrix.arch }}
        path: ${{ runner.temp }}/staged/*.tar.zst
        retention-days: 7
```

**Step 2: Commit.**

```bash
git add .github/workflows/staging-build.yml
git commit -m "feat(ci): per-package matrix build + artifact upload

Each matrix entry runs xtask archive-stage for a single (package,
arch) and uploads the resulting .tar.zst as a workflow artifact.
fail-fast: false so failed entries don't cancel siblings. Tasks
5-6 add the post-matrix gate that runs tests against the union of
artifacts before publishing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Post-matrix test gate

**Files:**
- Modify: `.github/workflows/staging-build.yml`

**Goal:** After all matrix entries finish (or a subset succeed), download all archive artifacts and run the 5 test suites against the union. This preserves today's "test before publish" safety property.

**Step 1: Add a `test-gate` job.**

```yaml
test-gate:
  needs: [build]
  runs-on: ubuntu-latest
  if: always()        # run even if some matrix entries failed
  steps:
    - uses: actions/checkout@v4
    - # Nix setup, toolchain-cache restore
    - name: Download all matrix artifacts
      uses: actions/download-artifact@v4
      with:
        path: $RUNNER_TEMP/staged-archives
    - name: Place binaries/ symlinks pointing at staged archives
      run: |
        # similar to force-rebuild.yml's existing install-release step:
        nix develop --accept-flake-config --command \
          cargo run -p xtask -- install-release \
            --manifest <synthesized-from-artifacts> \
            --archive-base "file://$RUNNER_TEMP/staged-archives" \
            --binaries-dir binaries
    - name: Build kernel + test programs
      run: |
        nix develop --accept-flake-config --command bash -c '
          cargo build --release -p wasm-posix-kernel \
            -Z build-std=core,alloc \
            -Z build-std-features=panic_immediate_abort
          # etc.
        '
    - name: Run cargo + vitest
      run: |
        nix develop --accept-flake-config --command bash -c '
          cargo test -p wasm-posix-kernel --target $(rustc -vV | awk "/^host/ {print \$2}") --lib
          cd host && npx vitest run
        '
    - name: Run libc-test
      run: nix develop --accept-flake-config --command bash scripts/run-libc-tests.sh
    - name: Run POSIX tests
      run: nix develop --accept-flake-config --command bash scripts/run-posix-tests.sh
    - name: Run sortix
      run: nix develop --accept-flake-config --command bash scripts/run-sortix-tests.sh --all
```

**Step 2: Commit.**

```bash
git add .github/workflows/staging-build.yml
git commit -m "feat(ci): post-matrix test gate runs 5 suites against staged artifacts

After the per-package matrix completes, a single test-gate job
downloads all uploaded archives, places binaries/ symlinks via
xtask install-release, and runs the 5 test suites (cargo, vitest,
libc-test, POSIX, sortix --all). Preserves today's test-before-
publish safety property.

if: always() so the gate runs even when some matrix entries failed
— last-green fallback covers consumers; tests verify what was
actually built this round.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Per-file uploads to release tag

**Files:**
- Modify: `.github/workflows/staging-build.yml`
- Possibly modify: `xtask/src/stage_release.rs` if a per-file upload helper is needed

**Goal:** After `test-gate` passes, a `publish` job uploads each successful archive directly to the release tag (`pr-<NNN>-staging` for PR builds, `binaries-abi-v<N>` for prepare-merge / force-rebuild). One asset per (package, arch); no monolithic combined archive.

**Step 1: Write the publish job.**

```yaml
publish:
  needs: [build, test-gate]
  if: needs.test-gate.result == 'success'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Download all archive artifacts
      uses: actions/download-artifact@v4
      with:
        path: $RUNNER_TEMP/staged-archives
    - name: Compute release tag
      id: tag
      run: |
        # PR build → pr-<NNN>-staging; prepare-merge → binaries-abi-v<N> (undated)
        # force-rebuild handled separately (Task 9).
    - name: Upload archives
      run: |
        for f in $RUNNER_TEMP/staged-archives/*/*.tar.zst; do
          gh release upload "${{ steps.tag.outputs.value }}" "$f" --clobber
        done
```

The `--clobber` is intentional — re-runs may upload the same asset (same sha → identical bytes); GHA accepts the overwrite.

**Step 2: Commit.**

```bash
git add .github/workflows/staging-build.yml
git commit -m "feat(ci): per-file uploads to release tag after test-gate

After tests pass, the publish job uploads each archive directly
to the release tag. One asset per (package, arch); no monolithic
combined archive. --clobber on the upload so re-runs with
identical bytes are no-ops.

Tag is pr-<NNN>-staging for PR builds; prepare-merge targets the
undated binaries-abi-v<N> tag (Task 10 flips this).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `index.toml` generation + upload

**Files:**
- Create: `xtask/src/build_index_toml.rs` (or add to existing module — implementer's call)
- Modify: `xtask/src/main.rs` (subcommand dispatch)
- Modify: `.github/workflows/staging-build.yml` (post-publish step)

**Goal:** After `publish` uploads all archives, a final job generates `index.toml` from the asset list and uploads it to the same release tag. The manifest format matches `docs/plans/2026-05-05-decoupled-package-builds-design.md` §3.2.

**Step 1: Write the failing test for index generation.**

In a new test module:

```rust
#[test]
fn build_index_toml_from_manifests_and_assets() {
    // Fixture: 3 mock package.toml files + their archive shas.
    // Call build_index_toml.
    // Assert output is well-formed TOML, lists all 3 packages
    // with relative archive_url + correct archive_sha256.
}
```

**Step 2: Implement.**

```rust
pub fn build_index_toml(
    abi_version: u32,
    generator: &str,
    packages: &[(DepsManifest, &str /* archive filename */, &str /* sha256 */)],
) -> String {
    // Emit the format from §3.2 of the design.
}
```

**Step 3: Add the subcommand.**

```bash
cargo run -p xtask -- build-index --abi 7 --output index.toml \
  --asset bash-wasm32-abc.tar.zst:abc123... \
  --asset bash-wasm64-def.tar.zst:def456... \
  ...
```

**Step 4: Add the post-publish workflow step.**

```yaml
generate-index:
  needs: [publish]
  if: needs.publish.result == 'success'
  steps:
    - # download artifact metadata
    - name: Generate index.toml
      run: |
        cargo run -p xtask -- build-index ...
    - name: Upload index.toml
      run: |
        gh release upload "${{ inputs.tag }}" index.toml --clobber
```

**Step 5: Commit.**

```bash
git add xtask/src/ .github/workflows/staging-build.yml
git commit -m "feat(xtask,ci): index.toml generation + upload

After per-file uploads, generate index.toml from the asset list
and upload it to the same release tag. Format per design §3.2:
abi_version, generator, [[packages]] array with per-arch archive
URL (relative) + sha256.

If the matrix had failures, index.toml lists only the green
packages. The F2 status artifact (Phase B-2 Task 8) carries the
full per-package result table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## (Phase B-1 ends here. Tasks 8-11 ship in a separate Phase B-2 PR.)

The natural break point: after Task 7, the new flow exists end-to-end (preflight → matrix → test-gate → publish → index.toml) and produces durable artifacts. The resolver still reads `binaries.lock`, so production is unaffected.

## Final verification (before pushing Phase B-1)

```bash
# Local cheap subset (per Phase A's pattern):
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cargo test -p xtask --target aarch64-apple-darwin
cd host && npx vitest run; cd ..
nix develop --accept-flake-config --command bash scripts/check-abi-version.sh
```

CI's userspace suites (libc-test, POSIX, sortix) gate on the actual matrix run when the PR is opened — that's the dogfood test.

Push and open PR:

```bash
git push -u origin phase-b-1-matrix-ci
gh pr create --base main \
  --title "feat(ci): Phase B-1 — per-package matrix + content-hash gating + index.toml" \
  --body "$(cat <<'EOF'
## Summary

Phase B-1 of the decoupled-package-builds initiative. Stands up the per-package matrix CI alongside the existing flow.

- **Reproducibility audit (Task 0):** every package now produces a bit-reproducible cache_key_sha. Audit log + leak fixes documented in docs/plans/2026-05-06-phase-b-reproducibility-audit.md.
- **xtask compute-cache-key-sha (Task 1):** stable CLI surface for the GHA pre-flight job.
- **Pre-flight + matrix + toolchain-cache + per-file uploads + index.toml generation (Tasks 2-7):** new CI flow. Resolver still reads binaries.lock; the new artifacts are publishable but unconsumed by main.

After this PR, Phase B-2 follows with: F2 sticky PR comment (Task 8), force-rebuild restructure (Task 9), undated tag switch (Task 10), kernel_abi required (Task 11).

Reference: docs/plans/2026-05-05-decoupled-package-builds-design.md §5, §6.3, §8 Phase B.

## Test plan

- [x] cargo test -p wasm-posix-kernel — pass
- [x] cargo test -p xtask — pass (with new compute-cache-key-sha + build-index tests)
- [x] vitest — pass
- [x] check-abi-version.sh — exit 0
- [x] reproducibility audit — 0 FAIL
- [ ] (this PR's CI runs the new matrix flow against itself — that's the dogfood test)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Risks & open questions

- **Reproducibility audit blast radius (Task 0).** Unknown # of leaks; if showstoppers, Phase B-1 is blocked until they're fixed. Worst case the audit becomes its own multi-PR initiative.
- **Pre-flight job's release-asset probe.** The probe is one HTTP HEAD per (package, arch). For 60-ish (package, arch) pairs that's 60 HEAD requests at the start of every CI run. Cheap (sub-second) but worth profiling. If it becomes a bottleneck, batch-list the release assets once and check locally.
- **`fail-fast: false` matrix uses CI minutes proportional to package count.** A bad commit that breaks 30 packages burns 30 jobs' worth of CI time. Mitigation: matrix entries that fail fast (e.g., setup error before build) burn ~30s each; only an actual build failure burns ~5 min. Acceptable, but worth watching.
- **Test-gate job downloads ALL artifacts.** For 60 packages × ~5 MB each = ~300 MB. Fine on GHA-hosted runners but worth measuring.
- **`actions/cache@v4` GHA cache eviction.** Toolchain cache can be evicted under storage pressure. Cache miss → toolchain-cache job rebuilds (~10 min). Matrix entries that depend on it will block until cache is restored. Acceptable; same as today.
- **`if: always()` on test-gate may run when 0 matrix entries succeeded.** Test-gate against an empty staged-archives dir is meaningless — should detect and skip. Cheap to handle; remember to add the guard.
- **Concurrency with `prepare-merge-singleton`.** Today's force-rebuild and prepare-merge serialize via this group. Phase B-1's staging-build runs on every PR push and is NOT in the singleton — that's correct (PR-staging releases are independent). When force-rebuild restructure lands (Phase B-2 Task 9), it stays in the singleton.

## Notes for the executor

- **Per CLAUDE.md, all 5 test suites are the gate** for "tests pass." Phase B-1's CI runs those against the new matrix flow on PR push — the suites' results are CI's verification gate, not a local one.
- **`nix develop --accept-flake-config --command ...` for any wasm/sysroot work.** Don't use Homebrew clang directly (memory: `feedback_always-use-nix-shell-for-builds.md`).
- **The reproducibility audit is the most uncertain task.** If it surfaces a fundamental reproducibility issue (e.g., libc++'s build emits a non-deterministic hash), pause the plan and ask before pushing fixes that span unrelated subsystems.
- **Don't squash commits between tasks** — each task's commit should land separately so the bot PR review can comment on individual tasks. Squashing is fine *within* a task if multiple steps would otherwise create artifact noise.
- **`xtask` test count baseline:** 190 (post-Phase-A-bis SHA `fa86b1683`). Each task that adds tests should report the new count in its commit message.
