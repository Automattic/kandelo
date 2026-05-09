# Decoupled Package Builds — Phase C Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cut the resolver over to `package.toml` as the source of truth for binary URLs, retire `binaries.lock` + `manifest.json`, and restructure `prepare-merge.yml` + `force-rebuild.yml` to use the per-package matrix flow with bot PRs that amend individual `package.toml` files.

**Architecture:** Single atomic PR. After this PR, the legacy stage-release / install-release / manifest.json producer pipeline is gone; the resolver reads each `examples/libs/<name>/package.toml`'s `[binary]` (single) or `[binary.<arch>]` (per-arch) block directly to fetch archives. The Phase B-1 matrix flow is the producer; the new fetch-binaries logic is the consumer. PR-staging archives are referenced via gitignored `package.pr.toml` overlays (per-package) instead of a central `binaries.lock.pr`.

**Tech Stack:** Rust (xtask), Bash (release scripts), GitHub Actions YAML, TypeScript (`host/src/binary-resolver.ts`, browser demos).

**Reference:** `docs/plans/2026-05-05-decoupled-package-builds-design.md` §3.3 (`package.pr.toml` overlay), §5.4 (PR overlay flow), §5.5 (force-rebuild restructure), §6.1 (resolver source-of-truth), §8 Phase C.

---

## Scope

- **Resolver** (`xtask::build_deps::ensure_built` chain + `scripts/fetch-binaries.sh`): reads each `package.toml`'s `[binary.<arch>]` URL+sha directly. No central manifest lookup.
- **PR overlay**: gitignored `examples/libs/<name>/package.pr.toml` (per-package) overlays the in-tree `package.toml`'s `[binary]` block. Replaces `binaries.lock.pr`.
- **Producer cutover**: `xtask stage-release` (and the legacy `build:` job in `staging-build.yml`) retired. The Phase B-1 matrix flow is the only producer.
- **`prepare-merge.yml` + `force-rebuild.yml`**: drive the matrix flow. Bot PR amends per-package `package.toml` files (one change per package: `[binary.<arch>].archive_url` + `archive_sha256`).
- **Delete**: `binaries.lock`, `binaries.lock.pr` references, `manifest.json` generation, `xtask install-release`, `xtask build-manifest`, `xtask stage-release`, `xtask stage-pr-overlay`, `scripts/{stage-release,publish-release,publish-pr-staging,stage-pr-staging,backfill-binary-blocks}.sh`, `abi/binaries-lock.schema.json`.
- **Verify**: every demo (Node + browser) and every test path stays green.

**Out of scope:**
- Adding new packages.
- Changing the per-package archive format (still `.tar.zst`).
- Changing the matrix flow itself (Phase B-1's design stands).
- Adding HTTP retry to fetches (separate cleanup if needed).
- Fixing the pre-existing `regression/pthread_cond-smasher` XPASS (separate fix).

---

## Pre-flight

### Pre-task: branch setup + recon

**Files:** None — verification + investigation only.

**Step 1: Create the worktree.**

```bash
cd /Users/brandon/ai-src/wasm-posix-kernel
git fetch origin main
git worktree add /Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-c-resolver-cutover -b phase-c-resolver-cutover origin/main
```

**Work from `/Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-c-resolver-cutover` for all subsequent tasks.**

**Step 2: Confirm baseline.**

```bash
bash scripts/dev-shell.sh cargo test -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -3
```

Expected: 225+ pass.

**Step 3: Recon — every file referencing `binaries.lock` or `binaries.lock.pr`.**

```bash
grep -rln 'binaries\.lock' . 2>/dev/null \
  | grep -v node_modules | grep -v target | grep -v '\.cache' | grep -v '\.superset' \
  | grep -v 'docs/plans/2026-04' \
  | tee /tmp/binaries-lock-references.txt
```

Expected: ~20 files. Major categories:
- `binaries.lock` itself (top-level pinfile).
- `abi/binaries-lock.schema.json` (JSON schema for the pinfile).
- `host/src/binary-resolver.ts` (Vite-side resolver).
- `host/test/fetch-binaries-allow-stale.test.ts` (vitest).
- `scripts/{fetch-binaries,publish-release,publish-pr-staging,stage-pr-staging,resolve-binary,install-local-binary}.sh`.
- `.github/workflows/{prepare-merge,force-rebuild,staging-build}.yml`.
- `docs/{binary-releases,package-management,abi-versioning}.md`.
- `README.md`, `run.sh`.
- Plan docs (read-only — don't touch frozen ones).

Read 2-3 of each category to ground your understanding. **Don't modify yet.**

**Step 4: Recon — every consumer of `xtask install-release` / `manifest.json`.**

```bash
grep -rnE 'install-release|manifest\.json' xtask/src/ scripts/ .github/workflows/ host/src/ host/test/ 2>/dev/null \
  | grep -v '\.cache' \
  | head -30
```

Note these as the ones to cut over (replace with per-package walk) or delete.

**Step 5: Recon — the resolver code path.**

```bash
grep -nE 'fn ensure_built|fn cmd_resolve|fn resolve_binary' xtask/src/build_deps.rs | head
```

Find `ensure_built`'s implementation; trace what it does today. The current chain (per memory): local-libs/ → cache → remote-fetch → source build. The "remote-fetch" step is what currently uses the URL from `[binary]`. So per-package URL consumption is ALREADY there — Phase C just removes the alternative paths that used `manifest.json`.

**Step 6: Confirm worktree is clean and ready.**

```bash
git status -s | head
```

Expected: only unrelated submodule pointer dirt.

---

## Task 1: Add `package.pr.toml` overlay support in xtask parser

**Files:**
- Modify: `xtask/src/pkg_manifest.rs` (add overlay-merge function)
- Modify: `.gitignore` (add `examples/libs/*/package.pr.toml`)

**Goal:** New `pkg_manifest::load_with_overlay(dir)` reads `package.toml` and, if `package.pr.toml` is present in the same dir, merges its `[binary]` / `[binary.<arch>]` block over the base. Other top-level fields in the overlay are an error (overlay is binary-block-only by design).

**Step 1: Add `.gitignore` entry.**

```bash
echo '' >> .gitignore
echo '# Phase C: per-package PR overlay (CI-generated; merged over package.toml at parse time).' >> .gitignore
echo 'examples/libs/*/package.pr.toml' >> .gitignore
```

**Step 2: Read the existing parser.**

```bash
grep -nE 'pub fn parse|pub fn load|fn parse_binary' xtask/src/pkg_manifest.rs | head
```

**Step 3: Write the failing tests.**

In `xtask/src/pkg_manifest.rs`'s test module, add:

```rust
#[test]
fn overlay_merges_binary_block_over_base() {
    // Base package.toml has [binary.wasm32] with sha "abc".
    // Overlay package.pr.toml has [binary.wasm32] with sha "def".
    // After merge: sha is "def".
    use std::io::Write as _;
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("package.toml"), /* ... base TOML with sha=abc... */).unwrap();
    std::fs::write(tmp.path().join("package.pr.toml"), /* ... overlay with sha=def... */).unwrap();

    let m = DepsManifest::load_with_overlay(tmp.path()).expect("merge");
    assert_eq!(m.binary[&TargetArch::Wasm32].archive_sha256, "def...");
}

#[test]
fn overlay_absent_uses_base() {
    // No package.pr.toml — load_with_overlay returns the base unchanged.
}

#[test]
fn overlay_with_non_binary_field_is_rejected() {
    // package.pr.toml with a top-level `name = "..."` — error.
}
```

(Use the existing fixture conventions in `pkg_manifest.rs`. Read what `fn build_accepts_repo_url_and_commit` does for shape.)

**Step 4: Run the tests; confirm they fail.**

```bash
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') overlay 2>&1 | tail -5
```

**Step 5: Implement `load_with_overlay`.**

```rust
impl DepsManifest {
    /// Load a package.toml with optional package.pr.toml overlay merged in.
    /// Phase C consumer-side entry point.
    pub fn load_with_overlay(dir: &Path) -> Result<Self, String> {
        let base_text = std::fs::read_to_string(dir.join("package.toml"))
            .map_err(|e| format!("read package.toml: {e}"))?;
        let mut manifest = Self::parse(&base_text, dir.to_path_buf())?;

        let overlay_path = dir.join("package.pr.toml");
        if overlay_path.exists() {
            let overlay_text = std::fs::read_to_string(&overlay_path)
                .map_err(|e| format!("read package.pr.toml: {e}"))?;
            apply_pr_overlay(&mut manifest, &overlay_text)?;
        }
        Ok(manifest)
    }
}

/// Parse package.pr.toml as a [binary]-only overlay and merge into manifest.
/// Rejects any non-[binary] field in the overlay.
fn apply_pr_overlay(manifest: &mut DepsManifest, overlay_text: &str) -> Result<(), String> {
    let value: toml::Value = toml::from_str(overlay_text)
        .map_err(|e| format!("parse package.pr.toml: {e}"))?;
    let table = value.as_table().ok_or("package.pr.toml must be a table")?;

    for (key, _) in table.iter() {
        if key != "binary" {
            return Err(format!(
                "package.pr.toml may only override [binary] / [binary.<arch>] — \
                 unexpected top-level field {key:?}. \
                 See docs/plans/2026-05-05-decoupled-package-builds-design.md §3.3."
            ));
        }
    }

    let binary_value = table.get("binary").cloned()
        .ok_or("package.pr.toml has no [binary] section")?;
    let new_binary = parse_binary_block(binary_value)?;

    // Merge: overlay arches replace base arches; missing-from-overlay arches keep base.
    for (arch, bin) in new_binary {
        manifest.binary.insert(arch, bin);
    }
    Ok(())
}
```

(Adapt to the actual struct shape — `manifest.binary` may be `BTreeMap<TargetArch, Binary>` or similar. Match what `parse_binary_block` returns.)

**Step 6: Run the tests; confirm they pass.**

```bash
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') overlay 2>&1 | tail -5
```

**Step 7: Run the full xtask test suite.**

```bash
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -5
```

Expected: existing 225 + new 3 = 228 pass.

**Step 8: Commit.**

```bash
git add .gitignore xtask/src/pkg_manifest.rs
git commit -m "feat(xtask): package.pr.toml overlay merges over base [binary] block

Phase C Task 1. The PR overlay file lives next to each package.toml,
gitignored, and contains only [binary] / [binary.<arch>] entries that
override the base manifest's archive_url + archive_sha256 during a PR
build's lifecycle. Other fields in the overlay are rejected.

DepsManifest::load_with_overlay is the new consumer-side entry point;
falls back to the base when no overlay file exists.

Three new tests cover: merge replaces sha, absent overlay no-ops,
non-binary fields rejected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Resolver consumes per-package URLs (replace `xtask install-release`)

**Files:**
- Modify: `xtask/src/build_deps.rs` (resolver chain — `ensure_built` already supports remote-fetch from `[binary]`; remove any branch that consults `manifest.json`)
- Modify: `scripts/fetch-binaries.sh` (walk per-package)
- Possibly create: `scripts/fetch-binaries-v2.sh` if a clean rewrite is easier than editing in place

**Goal:** `scripts/fetch-binaries.sh` walks every `examples/libs/<name>/package.toml`, calls `xtask build-deps resolve <name> --arch <arch>` for each (consumes `package.toml` directly via the resolver), and places `binaries/programs/<arch>/<name>/...` symlinks. No `manifest.json` lookup.

**Step 1: Read the existing fetch-binaries.sh.**

```bash
cat scripts/fetch-binaries.sh
```

Note the `--allow-stale` flag, the binaries.lock parsing, and the install-release invocation.

**Step 2: Read xtask's `build-deps resolve` and confirm it's a sufficient replacement.**

```bash
grep -nE 'fn cmd_resolve|"resolve"' xtask/src/build_deps.rs | head
```

`xtask build-deps resolve <name> --arch <arch>` should:
- Load the package's `package.toml` (via `load_with_overlay` after Task 1).
- Resolve via the existing chain (local-libs → cache → remote-fetch via `[binary].archive_url` → source build).
- Print/return the canonical cache path.

If `cmd_resolve` doesn't already do this end-to-end (because it currently expects manifest.json context), refactor it to use `load_with_overlay` and the per-package `[binary]` block directly.

**Step 3: Write the new fetch-binaries.sh.**

```bash
#!/usr/bin/env bash
# Phase C version: walks per-package package.toml, applies any
# package.pr.toml overlay, resolves each via xtask build-deps, and
# places binaries/ symlinks.
#
# Replaces the binaries.lock + manifest.json pinfile flow.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"

cd "$REPO_ROOT"

# Build xtask once.
cargo build --release -p xtask --target "$HOST_TARGET"

# Walk each package.toml.
for pkg_dir in examples/libs/*/; do
  pkg=$(basename "$pkg_dir")
  # Skip metadata-only packages (no [build] block; nothing to install).
  if ! grep -q '^\[build\]' "$pkg_dir/package.toml"; then
    continue
  fi
  # Read declared arches from package.toml.
  arches=$(awk -F'[][]' '/^arches *=/ {print $2}' "$pkg_dir/package.toml" \
    | tr -d ' "' | tr ',' ' ')
  arches=${arches:-wasm32}

  for arch in $arches; do
    cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
      build-deps resolve "$pkg" --arch "$arch" \
      --binaries-dir "$REPO_ROOT/binaries"
  done
done
```

If `xtask build-deps resolve` doesn't accept `--binaries-dir`, add that flag (it should symlink the resolved cache entry into the given dir, mirroring what `install-release --binaries-dir` did).

**Step 4: Test fetch-binaries against a single package.**

```bash
rm -rf binaries
bash scripts/dev-shell.sh bash scripts/fetch-binaries.sh
ls binaries/programs/wasm32/bash/
```

Expected: bash.wasm symlink. If it works for one package, it'll work for the rest.

**Step 5: Update host/test/fetch-binaries-allow-stale.test.ts.**

Read the test; replace any `binaries.lock` references with the per-package equivalent. The `--allow-stale` flag's semantics may differ in the new world — investigate.

**Step 6: Commit.**

```bash
git add scripts/fetch-binaries.sh xtask/src/build_deps.rs host/test/fetch-binaries-allow-stale.test.ts
git commit -m "feat(scripts,xtask): fetch-binaries walks per-package package.toml (Phase C Task 2)

Replaces the binaries.lock + manifest.json pinfile flow with a
per-package walk: for each examples/libs/<name>/package.toml with
a [build] block, resolve each declared arch via xtask build-deps
resolve, which consults [binary.<arch>].archive_url + archive_sha256
via DepsManifest::load_with_overlay (Task 1).

Existing binaries.lock at the top level is now unread; deletion
follows in Task 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update host/src/binary-resolver.ts and browser demo paths

**Files:**
- Modify: `host/src/binary-resolver.ts`
- Possibly: any browser demo script that imports binaries via Vite `?url`

**Goal:** Vite-side resolver uses the same `binaries/<arch>/<pkg>/...` symlink layout that fetch-binaries.sh writes. If the layout doesn't change, no host-side updates are needed beyond removing any `binaries.lock` parsing.

**Step 1: Read `host/src/binary-resolver.ts`.**

Identify what role `binaries.lock` plays today. Likely it's used to validate the `binaries/` tree's freshness against the pinned `release_tag`.

**Step 2: Replace `binaries.lock` parsing with per-package check.**

The new shape: walk `examples/libs/*/package.toml`, check that each declared archive's symlink exists under `binaries/`. Or just trust `fetch-binaries.sh` to have done the right thing (no Vite-time validation).

**Step 3: Run vitest to confirm.**

```bash
cd host && npx vitest run; cd ..
```

**Step 4: Commit.**

```bash
git add host/src/binary-resolver.ts host/test/
git commit -m "feat(host): binary-resolver consumes per-package package.toml

Phase C Task 3. The Vite-side resolver no longer reads binaries.lock;
instead trusts fetch-binaries.sh to have populated binaries/ correctly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Restructure prepare-merge.yml to use the matrix flow

**Files:**
- Modify: `.github/workflows/prepare-merge.yml`

**Goal:** prepare-merge no longer cuts a dated `binaries-abi-v<N>-YYYY-MM-DD` release with `manifest.json` + bumps `binaries.lock`. It triggers the matrix flow (re-running against tip-of-main if needed), waits for it to publish per-file archives + `index.toml` to the undated `binaries-abi-v<N>` tag, then opens a bot PR that amends each affected `examples/libs/<name>/package.toml`'s `[binary.<arch>]` block.

**Step 1: Read the existing prepare-merge.yml.**

Note the current structure: ready-to-ship label trigger, build job, lockfile bump, merge gate.

**Step 2: Replace the build/publish step with a matrix invocation.**

Reuse the same matrix shape from `staging-build.yml` (preflight + matrix-build + test-gate + publish + generate-index). Concurrency group: `prepare-merge-singleton` (existing).

After publish + generate-index, a new `bot-pr` job:
- Downloads the post-publish release asset list.
- For each updated `package.toml` (the ones whose archive sha changed this run), update the in-tree `[binary.<arch>].archive_url` + `archive_sha256` + bump `[build].commit` to the merge SHA.
- Commits + opens a bot PR with `merge-gate` status.

This is a non-trivial workflow YAML change. The existing `force-rebuild.yml` has the closest pattern (workflow_dispatch + matrix invocation in B-1's design); model on it.

**Step 3: Test plan.**

You can't fully exercise prepare-merge locally. After committing, the PR's CI run (when Phase C lands and is labeled `ready-to-ship`) will dogfood it. Acceptable.

**Step 4: Commit.**

```bash
git add .github/workflows/prepare-merge.yml
git commit -m "feat(ci): prepare-merge uses matrix flow + per-package amend bot PR

Phase C Task 4. Retires the dated binaries-abi-v<N>-YYYY-MM-DD release
+ binaries.lock bump. The matrix flow (preflight + matrix-build +
test-gate + publish + generate-index from staging-build.yml's pattern)
publishes per-file archives + index.toml to the undated tag; a new
bot-pr step amends each affected package.toml's [binary.<arch>] block
and opens a bot PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Restructure force-rebuild.yml the same way

**Files:**
- Modify: `.github/workflows/force-rebuild.yml`

**Goal:** Same shape as Task 4. Inputs (`packages`, `arches`, `ref`, `skip_tests`, `bump_lockfile` → `bump_packages`) drive the matrix with selected packages bypassing D3. Bot PR amends per-package `package.toml` files instead of bumping `binaries.lock`.

**Step 1: Mirror Task 4's structure.**

The matrix has to support a "bypass D3 for these packages" mode. Either:
- Add a workflow input that the preflight reads to force-include selected packages in the matrix even if their archive is already published.
- Or re-engineer preflight to take an explicit force-list.

Implementer's choice. Mirror the design's §5.5 description.

**Step 2: Commit.**

```bash
git add .github/workflows/force-rebuild.yml
git commit -m "feat(ci): force-rebuild uses matrix flow + per-package amend bot PR

Phase C Task 5. force-rebuild.yml restructure deferred from Phase B-2.
Matrix-driven: selected packages bypass D3 via a force-rebuild list
fed to preflight. Bot PR amends per-package package.toml files
(replaces binaries.lock bump).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Delete `binaries.lock`, `manifest.json` schema, legacy scripts + xtask code

**Files:**
- Delete: `binaries.lock`
- Delete: `abi/binaries-lock.schema.json`
- Delete: `scripts/{stage-release,publish-release,publish-pr-staging,stage-pr-staging,backfill-binary-blocks}.sh`
- Modify or delete: `xtask/src/{install_release,build_manifest,stage_release,stage_pr_overlay}.rs` (these are unused after Tasks 2 + 4 + 5)
- Modify: `xtask/src/main.rs` (remove deleted subcommand dispatches)
- Update: docs (`docs/binary-releases.md`, `docs/package-management.md`, `docs/abi-versioning.md`, `README.md`, `run.sh` if it references)

**Goal:** Remove all the legacy pinfile + monolithic-publish code. After this commit, the producer is solely the matrix flow; the consumer is solely per-package `package.toml` walk.

**Step 1: Delete the dead scripts and lockfile.**

```bash
git rm binaries.lock abi/binaries-lock.schema.json
git rm scripts/{stage-release,publish-release,publish-pr-staging,stage-pr-staging,backfill-binary-blocks}.sh
```

If any of those files have non-trivial logic that the matrix flow doesn't replace, pause and ask before deleting.

**Step 2: Delete xtask's now-dead modules.**

For each of `install_release`, `build_manifest`, `stage_release`, `stage_pr_overlay`: confirm nothing else in xtask calls into them, then `git rm` and remove the `mod` declarations from `main.rs`.

`build_manifest.rs` is complicated because the matrix's `generate-index` job uses `xtask build-index` (Phase B-1). If `build-manifest` is unused everywhere else, delete it. If something still depends on it, leave the module alone but remove the subcommand dispatch.

**Step 3: Update `xtask/src/main.rs` doc comment and usage line.**

Remove `install-release`, `stage-release`, `stage-pr-overlay`, `build-manifest` from the subcommand list. Keep `compute-cache-key-sha`, `archive-stage`, `build-index`, `set-build-commit`, `build-deps`, `dump-abi`, `bundle-program`.

**Step 4: Update docs.**

For each user-facing doc, replace references to `binaries.lock` / `manifest.json` / `xtask install-release` with the new model. Plan docs under `docs/plans/2026-04-*` are frozen; don't touch them.

**Step 5: Verify xtask still builds + tests pass.**

```bash
bash scripts/dev-shell.sh cargo build --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -3
bash scripts/dev-shell.sh cargo test --release -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -5
```

Tests that referenced the deleted modules will need updating or deletion. If a test verifies behavior that's moved (e.g., manifest.json round-trip → moved to per-package round-trip via `host/test/release-roundtrip.test.ts`), update the test target accordingly.

**Step 6: Commit.**

```bash
git add -A
git commit -m "refactor: delete binaries.lock + manifest.json + legacy publish scripts

Phase C Task 6. After Tasks 1-5, the resolver consumes package.toml
directly and the matrix flow is the sole producer. Delete:

- binaries.lock + abi/binaries-lock.schema.json
- scripts/{stage,publish,stage-pr-staging,publish-pr-staging,
  backfill-binary-blocks}-release.sh
- xtask modules: install_release, build_manifest, stage_release,
  stage_pr_overlay (plus their subcommand dispatch in main.rs)
- doc references throughout (binary-releases.md, package-management.md,
  abi-versioning.md, README.md, run.sh)

Frozen historical plan docs under docs/plans/2026-04-* are intentionally
left as-is (archaeological record).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verify all test paths + browser demos

**Files:** None modified — verification only.

**Step 1: cargo unit tests.**

```bash
bash scripts/dev-shell.sh cargo test -p wasm-posix-kernel --target $(rustc -vV | awk '/^host/ {print $2}') --lib 2>&1 | tail -5
```

Expected: 773+ pass, 0 fail.

**Step 2: xtask tests.**

```bash
bash scripts/dev-shell.sh cargo test -p xtask --target $(rustc -vV | awk '/^host/ {print $2}') 2>&1 | tail -5
```

Expected: 228 pass (was 225 + 3 new from Task 1; minus any deleted tests from Task 6).

**Step 3: vitest.**

```bash
cd host && npx vitest run; cd ..
```

Expected: pass; PHP/MariaDB skip if binaries not built. Note: `fetch-binaries-allow-stale.test.ts` was updated in Task 2.

**Step 4: ABI snapshot check.**

```bash
bash scripts/dev-shell.sh bash scripts/check-abi-version.sh 2>&1 | tail -5
```

Expected: exit 0.

**Step 5: Browser demo smoke test.**

This is the most likely place for Phase C to break — Vite imports `binaries/...?url` and the file-tree layout changes are subtle.

```bash
./run.sh browser
# Open the dev URL in a browser; click through:
# - simple (C programs)
# - shell (dash + coreutils)
# - python
# - php
# - nginx
# - mariadb
# - redis
# - wordpress
# Each demo's binary should load without 404s.
```

If any demo 404s on a `binaries/...` import, `fetch-binaries.sh` (Task 2) didn't populate that path; investigate.

For the user-facing report, list which demos you smoke-tested (everything via `./run.sh browser` is fine; mention if anything was skipped).

**Step 6: If all green, push and open PR.**

```bash
git push -u origin phase-c-resolver-cutover
gh pr create --base main \
  --title "feat: Phase C — resolver cutover + force-rebuild restructure" \
  --body "$(cat <<'EOF'
## Summary

Phase C of the decoupled-package-builds initiative — the keystone. Cut the resolver over to package.toml as the source of truth for binary URLs, retire binaries.lock + manifest.json, and restructure prepare-merge.yml + force-rebuild.yml to use the per-package matrix flow with bot PRs that amend individual package.toml files.

After this PR:
- Resolver reads package.toml directly (with optional package.pr.toml overlay during PR builds).
- Matrix flow (from B-1) is the sole producer. Legacy stage-release / install-release pipeline is gone.
- prepare-merge + force-rebuild bot PRs amend per-package package.toml files, not binaries.lock.
- binaries.lock and manifest.json are deleted from the repo.

Reference: docs/plans/2026-05-05-decoupled-package-builds-design.md §3.3, §5.4, §5.5, §6.1, §8 Phase C.

## Test plan

Local (host-side fast subset):
- [x] cargo test -p wasm-posix-kernel --lib — 773+ pass
- [x] cargo test -p xtask — 228 pass (+3 new from Task 1; minus deleted-module tests from Task 6)
- [x] cd host && npx vitest run — pass
- [x] scripts/check-abi-version.sh — exit 0
- [x] ./run.sh browser — smoke-tested simple, shell, python, php, nginx, mariadb, redis, wordpress demos

CI runs the full matrix flow on this PR + the userspace test suites (libc-test, POSIX, sortix).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Risks & open questions

- **Matrix in prepare-merge.** The matrix flow is currently in `staging-build.yml`. Phase C's `prepare-merge.yml` rewrite needs the same matrix structure — either copy-pasted (simpler diff) or extracted into a reusable `workflow_call` workflow (cleaner long-term). Implementer's choice; document in commit message.
- **`binaries/` layout backward-compat.** Browser demos hardcode paths like `binaries/programs/wasm32/bash/bash.wasm` (or similar). If `xtask build-deps resolve --binaries-dir` doesn't write that exact layout, browser demos 404. Verify the layout matches `xtask install-release`'s output (which is what `fetch-binaries.sh` writes today).
- **`scripts/install-local-binary.sh` and `scripts/resolve-binary.sh`.** May or may not need updates depending on what they do. If they reference `binaries.lock`, update; if they wrap `xtask build-deps`, no change.
- **The `regression/pthread_cond-smasher` XPASS** noted in PR #432's CI is still pending fix. May surface again on Phase C's CI run. Pre-existing main issue; orthogonal.
- **`run.sh`** — if it has `binaries.lock`-aware logic (e.g., "verify binaries.lock is up to date before running tests"), update or delete that section.
- **`README.md`** — update the "How to fetch prebuilt binaries" section to reflect the new flow.
- **`fetch-binaries.sh --allow-stale`.** Currently means "tolerate manifest.json's cache_key_sha mismatch with current source." After Phase C, the equivalent might be "skip a package whose archive_url is unreachable." Decide what `--allow-stale` should mean in the new world; document in the script's header.

## Notes for the executor

- **This PR is BIG.** Each task is 200-500 lines of changes. Total is probably 1500-2500 lines net. Reviewable per-commit; don't squash.
- **Don't skip Task 1's overlay tests.** Task 4 + 5's CI YAML rely on the overlay shape; tests pin the contract.
- **The matrix YAML reuse question (Tasks 4-5) is real.** Don't over-engineer; copy-paste is fine if the duplication is bounded. Reusable workflow extraction is its own follow-up.
- **Browser demo smoke tests are the load-bearing verification step.** Spend time here. If any demo 404s, the entire Phase C cutover is broken for end users — this is what `./run.sh browser` catches.
- **Pre-existing main-branch `pthread_cond-smasher` XPASS** is not Phase C's concern. If CI fails on that, comment loudly in the PR but don't try to fix it here.
- **The 6 packages without `[build]`** (kernel, userspace, examples, node, sqlite-cli, pcre2-source) are still excluded — fetch-binaries.sh's loop has the `if grep -q '^\[build\]'` skip per Task 2.
