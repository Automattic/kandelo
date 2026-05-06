# Decoupled Package Builds — Phase A Implementation Plan

> **Status: COMPLETE.** Landed on main as PR #413 (squash-merged commit `482c1dd1a`) on 2026-05-05. The 6-commit task series executed cleanly via the subagent-driven-development skill with two-stage review per task. This document is preserved as a historical record of the work.

**Goal:** Rename `deps.toml` → `package.toml` across all 61 package files, the xtask Rust modules, shell scripts, workflow YAML, and docs. Pure mechanical rename — no behavior change, no schema additions.

**Architecture:** Single-PR refactor. Tests, CI, and release flows continue to use `binaries.lock` and produce the same artifacts. The rename is a prerequisite for Phases B and C of the decoupled-package-builds design (`docs/plans/2026-05-05-decoupled-package-builds-design.md`), which require `package.toml` to be the source of truth.

**Tech Stack:** Rust (xtask), TOML (manifests), Bash (build/release scripts), GitHub Actions YAML.

**Scope decision: schema additions deferred.** The design specified Phase A would also add optional `kernel_abi`, `source`, and `[provenance]` fields. A scoping pass found the proposed top-level `source = "<URL>"` collides with the existing `[source]` table (upstream tarball URL+sha). Resolving the collision needs a naming decision (rename to `software_source`? repurpose the existing `[source]` block?) better made in a follow-up where the new fields are actually consumed. **Phase A ships rename only.** A small follow-up PR adds the optional fields with the chosen names.

---

## Pre-flight

### Pre-task: branch setup

**Files:**
- None — this is a setup step.

**Step 1: Create a clean branch off `main`.**

```bash
git fetch origin main
git checkout -b phase-a-rename-deps-to-package origin/main
```

**Step 2: Verify clean baseline.**

```bash
git status                  # should be clean
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -5
```

Expected: xtask builds without errors. (We'll verify the full test suite is also green at task end; baseline build is enough here.)

**Step 3: Confirm 61 deps.toml files exist.**

```bash
find examples/libs -name "deps.toml" | wc -l
```

Expected: `61`. (If different, the rest of the plan's counts are off — investigate before proceeding.)

---

## Task 1: Rename `deps.toml` files (mechanical bulk rename)

**Files:**
- Rename: `examples/libs/*/deps.toml` → `examples/libs/*/package.toml` (61 files)

**Step 1: Bulk-rename via `git mv`.**

```bash
for f in $(find examples/libs -name "deps.toml"); do
  git mv "$f" "$(dirname "$f")/package.toml"
done
```

**Step 2: Verify count.**

```bash
find examples/libs -name "package.toml" | wc -l         # should be 61
find examples/libs -name "deps.toml" | wc -l            # should be 0
```

**Step 3: Verify the rename didn't break TOML parsing.**

```bash
# Just spot-check a few files round-trip through `toml` parsing.
nix develop --accept-flake-config --command bash -c '
  for f in examples/libs/{bash,mariadb,nginx,curl,php}/package.toml; do
    [ -f "$f" ] && python3 -c "import tomllib; tomllib.loads(open(\"$f\",\"rb\").read().decode())" && echo "ok: $f"
  done
'
```

Expected: 5 lines of `ok: ...`. (No actual parse errors expected — `git mv` doesn't change content.)

**Step 4: Build will fail at this point (xtask still expects `deps.toml`).** Don't try to test yet — Tasks 2–5 fix the references. Just commit the file moves so the rename is reviewable in isolation.

**Step 5: Commit.**

```bash
git status -s | wc -l       # should be ~122 lines (61 deletes + 61 adds)
git commit -m "refactor(packages): rename examples/libs/*/deps.toml to package.toml

Mechanical bulk rename via 'git mv'. Build is broken at this commit
(xtask, scripts, workflows still expect deps.toml); subsequent commits
in this PR fix the references. Ships in one PR per the Phase A plan
in docs/plans/2026-05-05-decoupled-package-builds-phase-a-plan.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Update xtask Rust references

**Files:**
- Modify: `xtask/src/archive_stage.rs` (~10 string literals + 2 doc comments)
- Modify: `xtask/src/build_deps.rs` (string literals)
- Modify: `xtask/src/build_manifest.rs` (~7 string literals + doc comments)
- Modify: `xtask/src/bundle_program.rs` (1 error message)
- Modify: `xtask/src/deps_manifest.rs` (string literals + doc comments)
- Modify: `xtask/src/install_release.rs` (string literals)
- Modify: `xtask/src/main.rs` (CLI help text and any path references)
- Modify: `xtask/src/remote_fetch.rs` (string literals)
- Modify: `xtask/src/stage_pr_overlay.rs` (string literals + 1 fixture path)
- Modify: `xtask/src/stage_release.rs` (string literals + 2 fixture paths)

**Step 1: Survey all `deps.toml` literals in xtask.**

```bash
grep -rn '"deps\.toml"' xtask/src/
grep -rn 'deps\.toml' xtask/src/  # broader sweep (includes doc comments)
```

Expected: ~30 hits across 10 files. Read each in context — most are file path joins like `dir.join("deps.toml")`, but some are user-facing error messages that should be updated for clarity.

**Step 2: Replace all `"deps.toml"` literals with `"package.toml"`.**

```bash
# Path-style literals (function args). Keep doc comments for separate review.
find xtask/src -name '*.rs' -exec \
  sed -i.bak 's/"deps\.toml"/"package.toml"/g' {} \;

# Doc comments and bare-word references (e.g. "the deps.toml at ...").
# Review each by hand — sed across all of these would over-rename.
grep -rn 'deps\.toml' xtask/src/         # what's left should be doc/comments
```

Then update the doc-comment references by hand — e.g. in `xtask/src/build_manifest.rs:6,229,359` and similar, change "examples/libs/<name>/deps.toml" → "examples/libs/<name>/package.toml" and "deps.toml" → "package.toml" in error messages.

```bash
rm xtask/src/*.bak                      # clean up sed backups
```

**Step 3: Verify nothing references `deps.toml` left in xtask.**

```bash
grep -rn 'deps\.toml' xtask/src/
```

Expected: zero hits.

**Step 4: Build xtask.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -10
```

Expected: clean build. If a unit test fixture under `xtask/src/stage_release.rs` or `xtask/src/stage_pr_overlay.rs` writes a literal `deps.toml` filename, it'll now fail to find it after rename — fix by updating the fixture string.

**Step 5: Run xtask unit tests.**

```bash
cargo test --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -20
```

Expected: all xtask unit tests pass. Watch for fixture path mismatches — most likely surfaces in `archive_stage` tests (5 fixture sites) and `stage_release` tests (2 fixture sites).

**Step 6: Commit.**

```bash
git add xtask/src/
git commit -m "refactor(xtask): update string literals deps.toml -> package.toml

Mechanical follow-up to the file rename in the prior commit. xtask
unit tests now find the renamed fixture file in their tempdirs.
No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rename Rust module `deps_manifest.rs` → `pkg_manifest.rs`

**Files:**
- Rename: `xtask/src/deps_manifest.rs` → `xtask/src/pkg_manifest.rs`
- Modify: `xtask/src/main.rs` (or wherever `mod deps_manifest;` is declared)
- Modify: every Rust file using `crate::deps_manifest::*`

**Step 1: Find references to the module.**

```bash
grep -rn 'deps_manifest' xtask/src/
```

Expected: at least one `mod deps_manifest;` declaration plus `use crate::deps_manifest::...` imports across other files.

**Step 2: Rename the file.**

```bash
git mv xtask/src/deps_manifest.rs xtask/src/pkg_manifest.rs
```

**Step 3: Update module declaration and imports.**

```bash
grep -rln 'deps_manifest' xtask/src/ | xargs sed -i.bak 's/deps_manifest/pkg_manifest/g'
rm xtask/src/*.bak
```

**Step 4: Verify no `deps_manifest` references remain.**

```bash
grep -rn 'deps_manifest' xtask/src/
```

Expected: zero hits.

**Step 5: Build + test.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -5
cargo test --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -10
```

Expected: clean build, tests pass.

**Step 6: Commit.**

```bash
git add xtask/src/
git commit -m "refactor(xtask): rename deps_manifest module to pkg_manifest

Module hosts the parser/types for examples/libs/*/package.toml; the
old name reflects the original 'dependency' framing before the file
became a full package manifest.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Update shell scripts

**Files:**
- Modify: `scripts/stage-release.sh`
- Modify: `scripts/fetch-binaries.sh`
- Modify: `scripts/backfill-binary-blocks.sh`
- Modify: `scripts/test-allow-stale.sh`
- Modify: `examples/libs/nginx/build-nginx.sh`
- Modify: `examples/libs/wordpress/build-wordpress.sh`
- (And any other `*.sh` that references `deps.toml`.)

**Step 1: Survey shell-script references.**

```bash
grep -rln 'deps\.toml' scripts/ examples/libs/*/build-*.sh
```

Expected: ~6 files.

**Step 2: Replace literal references.**

```bash
grep -rl 'deps\.toml' scripts/ examples/libs/*/build-*.sh \
  | xargs sed -i.bak 's/deps\.toml/package.toml/g'
find scripts examples/libs -name '*.bak' -delete
```

**Step 3: Spot-check at least one updated script for context-sensitive cases.**

```bash
grep -nE 'package\.toml|deps\.toml' scripts/stage-release.sh
```

Expected: only `package.toml` references; no leftover `deps.toml`. Look for any English prose ("the deps.toml at ...") that the sed pass renamed mechanically; verify the result still reads cleanly.

**Step 4: Verify scripts still parse (bash -n).**

```bash
for f in scripts/stage-release.sh scripts/fetch-binaries.sh \
         scripts/backfill-binary-blocks.sh scripts/test-allow-stale.sh \
         examples/libs/nginx/build-nginx.sh \
         examples/libs/wordpress/build-wordpress.sh; do
  bash -n "$f" && echo "ok: $f"
done
```

Expected: 6 lines of `ok: ...`.

**Step 5: Commit.**

```bash
git add scripts/ examples/libs/*/build-*.sh
git commit -m "refactor(scripts): update deps.toml -> package.toml references

Mechanical update across release tooling and per-package build
scripts. No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Update workflow YAML

**Files:**
- Modify: `.github/workflows/staging-build.yml`
- Modify: `.github/workflows/prepare-merge.yml`
- Modify: `.github/workflows/force-rebuild.yml`
- Modify: any other workflow referencing `deps.toml` (currently 3 known)

**Step 1: Survey.**

```bash
grep -rln 'deps\.toml' .github/workflows/
```

Expected: 3 files.

**Step 2: Replace and verify cache-key inputs are still correct.**

```bash
grep -rl 'deps\.toml' .github/workflows/ \
  | xargs sed -i.bak 's/deps\.toml/package.toml/g'
rm .github/workflows/*.bak
```

Several workflows have `actions/cache@v4` keys that hash `examples/libs/**/deps.toml` — those become `examples/libs/**/package.toml`, which after rename glob-matches the renamed files. **Cache will invalidate once on first run after this PR merges**, which is correct behaviour (the renamed files have the same content but a different glob target).

**Step 3: Verify no `deps\.toml` references remain.**

```bash
grep -rn 'deps\.toml' .github/workflows/
```

Expected: zero hits.

**Step 4: YAML lint.**

```bash
# If yamllint or actionlint is in the dev shell:
nix develop --accept-flake-config --command bash -c '
  command -v actionlint >/dev/null && actionlint .github/workflows/*.yml || \
  command -v yamllint  >/dev/null && yamllint .github/workflows/*.yml || \
  echo "no lint tool available; skipping"
'
```

If no lint tool is available, skip — the next CI run after PR push will catch invalid YAML. (The substitution is mechanical and unlikely to break syntax.)

**Step 5: Commit.**

```bash
git add .github/workflows/
git commit -m "refactor(ci): update workflow deps.toml refs to package.toml

Includes cache-key glob inputs (examples/libs/**/deps.toml ->
examples/libs/**/package.toml). Caches will invalidate once on first
run, which is correct — the renamed files have the same content but
a different glob target.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update non-plan docs

**Files:**
- Modify: `README.md`
- Modify: `docs/package-management.md`
- Modify: `docs/binary-releases.md`
- Modify: `docs/package-management-future-work.md`
- Modify: `host/test/release-roundtrip.test.ts`
- Modify: `abi/manifest.schema.json` (the `description` strings reference `deps.toml`)
- Skip: `docs/plans/2026-04-{25,26,27}-deps-management-*.md` (frozen historical plans per the capstone commit's policy)
- Skip: `docs/plans/2026-04-29-pr-package-builds-{design,plan}.md` (frozen historical plans)

**Step 1: Survey.**

```bash
grep -rln 'deps\.toml' README.md docs/ abi/ host/ \
  | grep -v '/plans/2026-04-' \
  | grep -v '/plans/2026-05-05-decoupled'   # the new design refers to the new name
```

Expected: ~6 files.

**Step 2: Update each, prose-aware.**

For each file:
- `README.md` — narrative; check the rename reads naturally (e.g. "each `package.toml` declares ...").
- `docs/package-management.md` — primary doc for the system; many references; check examples.
- `docs/binary-releases.md` — release flow; references registry layout.
- `docs/package-management-future-work.md` — references; should rename cleanly.
- `host/test/release-roundtrip.test.ts` — test references the registry layout.
- `abi/manifest.schema.json` — `description` fields mention `deps.toml`.

Mechanical sed pass first, then read each by hand:

```bash
for f in README.md docs/package-management.md docs/binary-releases.md \
         docs/package-management-future-work.md \
         host/test/release-roundtrip.test.ts \
         abi/manifest.schema.json; do
  sed -i.bak 's/deps\.toml/package.toml/g' "$f"
done
find . -maxdepth 3 -name '*.bak' -delete
```

**Step 3: Verify the doc test still passes.**

```bash
cd host && npx vitest run release-roundtrip 2>&1 | tail -20
cd ..
```

Expected: pass. The test references the registry layout (which is now `package.toml`); if it constructs a fixture file, the literal must be updated too.

**Step 4: Verify schema.**

```bash
nix develop --accept-flake-config --command python3 -c '
import json
schema = json.load(open("abi/manifest.schema.json"))
print("schema parses ok")
'
```

Expected: `schema parses ok`.

**Step 5: Commit.**

```bash
git add README.md docs/ abi/ host/
git commit -m "docs: update deps.toml -> package.toml references

Updates user-facing docs, schema description strings, and the
release-roundtrip test fixture. Historical plan docs under
docs/plans/2026-04-* are intentionally left as-is (frozen artefacts).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification (all five test suites)

**Files:** None modified — verification only.

This step runs the project's full test matrix per `CLAUDE.md`. Phase A is mechanical, so everything should pass. If any suite fails, the failure points at a missed reference.

**Step 1: cargo unit tests.**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -20
```

Expected: 539+ tests pass, 0 failures.

**Step 2: vitest host integration tests.**

```bash
cd host && npx vitest run 2>&1 | tail -30
cd ..
```

Expected: all test files pass.

**Step 3: musl libc-test.**

```bash
nix develop --accept-flake-config --command bash scripts/run-libc-tests.sh 2>&1 | tail -30
```

Expected: 0 unexpected failures (XFAIL/TIME are acceptable per CLAUDE.md).

**Step 4: Open POSIX Test Suite.**

```bash
nix develop --accept-flake-config --command bash scripts/run-posix-tests.sh 2>&1 | tail -30
```

Expected: 0 FAIL (UNRES/SKIP are acceptable).

**Step 5: Sortix os-test.**

```bash
nix develop --accept-flake-config --command bash scripts/run-sortix-tests.sh --all 2>&1 | tail -10
```

Expected: 0 FAIL, 0 XPASS. Pre-existing TIMEOUTs (e.g. `phase-7-pthread-fixes` baseline of 4) are acceptable.

**Step 6: ABI snapshot check.**

```bash
nix develop --accept-flake-config --command bash scripts/check-abi-version.sh 2>&1 | tail -10
```

Expected: exit 0. Phase A is a pure file rename — should NOT bump `ABI_VERSION` or change `abi/snapshot.json`.

**Step 7: If everything green, push and open the PR.**

```bash
git push -u origin phase-a-rename-deps-to-package
gh pr create \
  --title "refactor(packages): rename examples/libs/*/deps.toml to package.toml" \
  --body "$(cat <<'EOF'
## Summary

Phase A of the decoupled-package-builds design (`docs/plans/2026-05-05-decoupled-package-builds-design.md`).

- Renames 61 `examples/libs/*/deps.toml` files to `package.toml`.
- Renames Rust module `xtask/src/deps_manifest.rs` to `pkg_manifest.rs`.
- Updates string literals in xtask, shell scripts, workflows, docs, and the schema.
- No behavior change. `binaries.lock` is unchanged. CI flows are unchanged. The release tag and content-addressed cache are unchanged.

Schema additions (`kernel_abi`, `source`, `[provenance]`) are deferred to a follow-up PR — the design's proposed top-level `source` field collides with the existing `[source]` table, and resolving the naming needs a separate decision.

## Test plan

- [ ] `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — 539+ pass
- [ ] `cd host && npx vitest run` — all pass
- [ ] `scripts/run-libc-tests.sh` — 0 unexpected fails
- [ ] `scripts/run-posix-tests.sh` — 0 FAIL
- [ ] `scripts/run-sortix-tests.sh --all` — 0 FAIL, 0 XPASS
- [ ] `scripts/check-abi-version.sh` — exit 0 (no ABI bump)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the executor

- **Per CLAUDE.md, all five test suites must pass before claiming work complete.** Don't skip suites 3–5 — they catch ABI/syscall regressions that unit tests miss.
- **`nix develop --accept-flake-config --command ...`** is the canonical way to run wasm builds (memory: `feedback_always-use-nix-shell-for-builds.md`). Don't use Homebrew clang directly.
- **CI cache invalidation is one-time and expected** when workflow `actions/cache@v4` glob inputs change from `**/deps.toml` to `**/package.toml`. Don't try to preserve the old cache.
- **Frozen historical plan docs** under `docs/plans/2026-04-*-deps-management-*` and `docs/plans/2026-04-29-pr-package-builds-*` are intentionally left untouched. They're historical artefacts; rewriting them would lose archaeological value.
- **The `deps-cache-v2-f-capstone` branch** is on a separate worktree and is not a dependency of this PR. That branch's `3b5e18a75` commit does *symbol/doc* renames (sha domain `wasm-posix-deps.v2` → `wasm-posix-pkg`, doc titles) but does NOT rename `deps.toml` files. If the user wants to land that branch's work, it can rebase on top of Phase A's rename — the conflict surface is small (mostly doc text).
- **If a sub-task introduces test regressions**, do not attempt to "patch around" them — the rename is mechanical, so any regression points at a missed reference. Find the missed reference instead.
