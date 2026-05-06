# Decoupled Package Builds — Phase A-bis Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land the schema additions decided in `docs/plans/2026-05-05-decoupled-package-builds-design.md` §3.1 — extended `[build]` block (`script_path` rename, `repo_url`, `commit`) + optional top-level `kernel_abi` — and backfill 55 first-party `package.toml` files. Update parser, resolver, and CI publish flow to consume.

**Architecture:** Schema-shaped but mechanical. Parser changes localized to `xtask/src/pkg_manifest.rs`; resolver script-path resolution updated in `xtask/src/build_deps.rs`; backfill is a scripted edit across 55 files; CI patch updates the publish flow to fill `[build].commit`.

**Tech Stack:** Rust (xtask), TOML (manifests), Bash (build/release scripts), GitHub Actions YAML.

**Scope notes:**
- `[build]` stays **optional** in the parser. Tightening to "required for first-party" is deferred to Phase B (when the CI matrix gates on it). For now we backfill where applicable.
- 5 packages have no build script (examples, kernel, node, sqlite-cli, userspace) — they're already excluded from `stage_release` per the existing "no build script" check. Phase A-bis leaves them alone; `docs/package-management-future-work.md` tracks adding wrappers.
- 1 source-kind package (pcre2-source) — `[build]` is not applicable; left alone.

---

## Pre-flight

### Pre-task: confirm worktree state

**Files:** None — verification only.

**Step 1: Confirm baseline.**

```bash
pwd                              # should be the phase-a-bis-schema worktree
git status                       # clean except for submodule/.superset noise
git log --oneline -1             # should show the latest origin/main HEAD
```

The worktree at `/Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-a-bis-schema` was created off `origin/main` after PR #416 merged. The branch is `phase-a-bis-schema-additions`. Don't run `git checkout` — it's already on the right branch.

**Step 2: Quick recon (read-only — no commit).**

```bash
# Counts that the plan assumes — re-verify before starting.
find examples/libs -name 'package.toml' | wc -l          # 61

# Packages with [build] today: 10
grep -l '^\[build\]' examples/libs/*/package.toml | wc -l

# Packages with build-*.sh script but NO [build] block: ~45
for f in examples/libs/*/package.toml; do
  d=$(dirname "$f")
  if ! grep -q '^\[build\]' "$f" && ls "$d"/build-*.sh >/dev/null 2>&1; then
    echo "$f"
  fi
done | wc -l
```

If counts differ, pause and report — the rest of the plan calibrates against the survey.

**Step 3: Confirm xtask builds clean.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -3
```

Expected: clean build. Failures here mean the worktree state is off; pause and report.

---

## Task 1: Parser update — rename `script` → `script_path`, add new fields

**Files:**
- Modify: `xtask/src/pkg_manifest.rs` (parser)
- Modify: any inline test fixtures within that file (TOML strings used for parser tests)

**Goal:** The parser accepts the new schema. The old `[build].script` field name is rejected with a "use script_path" error so stale data surfaces immediately. New fields (`script_path`, `repo_url`, `commit`, top-level `kernel_abi`) are all `Option`; nothing is required yet.

**Step 1: Read current `Build` struct + the `Raw` parser type.**

Locate the relevant code:
```bash
grep -n 'pub struct Build\|pub struct Raw\|Build::default\|impl Default for Build' xtask/src/pkg_manifest.rs
```

The current shape (post-rename PR #413):
```rust
#[derive(Debug, Clone, Deserialize)]
pub struct Build {
    pub script: Option<String>,
}
```

**Step 2: Update `Build` struct with new fields.**

Replace with:
```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Build {
    pub script_path: Option<String>,
    pub repo_url:    Option<String>,
    pub commit:      Option<String>,
}
```

The `#[serde(deny_unknown_fields)]` attribute is what causes the parser to reject the old `script` field with a clear error. (Verify this attribute isn't already absent for a reason — check the prior commit history of the file.)

If `#[serde(deny_unknown_fields)]` would also reject other legitimate fields that we don't know about, fall back to a manual error in the parser:

```rust
// In the parser entry point, after deserialize:
if raw_toml.contains("[build]") && raw_toml.contains("script ") {
    return Err("use [build].script_path (repo-relative path) instead of [build].script (package-dir-relative); see docs/plans/2026-05-05-decoupled-package-builds-design.md §3.1".into());
}
```

Choose whichever fits cleanly with the existing parser style.

**Step 3: Update the `Raw` parser type to add `kernel_abi`.**

Locate `pub struct Raw` (or whatever the de-sugared serde shape is — there's a `Raw` type around line 511 of pre-Phase-A-bis `pkg_manifest.rs`). Add:

```rust
#[serde(default)]
pub kernel_abi: Option<u32>,
```

The corresponding field on the public `DepsManifest` type also gets `kernel_abi: Option<u32>`. Wire it through the constructor / validator that turns `Raw` into `DepsManifest`.

**Step 4: Update parser tests + fixture TOML strings.**

Search the file for inline TOML fixtures used by parser tests:
```bash
grep -n '\[build\]' xtask/src/pkg_manifest.rs
```

Any test fixture using `script = "..."` updates to `script_path = "examples/libs/<name>/build-<name>.sh"` (or whatever path the fixture is simulating). Add at least one new test that:
- Verifies a fixture with the new `[build]` shape parses correctly.
- Verifies a fixture with the old `[build].script` field is rejected with a clear error message.
- Verifies a fixture with `kernel_abi = 6` parses.
- Verifies a fixture without `kernel_abi` parses (it's optional).

**Step 5: Build + test the parser.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -5
```

Expected: clean build. Other consumers of `Build.script` (the resolver, manifest builder) will probably fail to compile because the field name changed. **That's OK** — Task 2 fixes the resolver. For Task 1's commit, suppress those compile errors temporarily by:

- Renaming references to `.script` → `.script_path` mechanically (sed pass) IF they're trivial paths. If they require semantic changes (like resolving relative to repo root vs package dir), leave them for Task 2 and accept that `cargo build -p xtask` may fail on this commit.

**Strategic choice for the implementer:** If the rename consumers are simple (`build.script` → `build.script_path` and the semantics still work), do them in Task 1 and keep `cargo build` green. If they need real semantic changes, leave Task 1 with a knowingly-broken build (similar to Phase A's Task 1) and let Task 2 fix it. **Default to the green-build path** unless there's a reason not to.

**Step 6: Run parser unit tests.**

```bash
cargo test --release -p xtask --target aarch64-apple-darwin pkg_manifest 2>&1 | tail -20
```

Expected: all parser tests pass.

**Step 7: Commit.**

```bash
git add xtask/src/pkg_manifest.rs
git commit -m "feat(xtask): extend [build] schema + add optional kernel_abi

Adds the schema fields decided in docs/plans/2026-05-05-decoupled-
package-builds-design.md §3.1:

- [build].script_path replaces [build].script (renamed to make the
  path canonical; semantics change from package-dir-relative to
  repo-relative).
- [build].repo_url declares the clonable URL of the source repo.
- [build].commit is filled by CI at publish time.
- top-level kernel_abi is optional; will be enforced in Phase B
  when the CI matrix wires it into the ABI-floor check.

The old [build].script field is rejected with a clear error so
stale data surfaces immediately. All existing parser tests updated
to use the new shape; new tests cover the rejection path and the
kernel_abi field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Resolver update — script_path resolves against repo root

**Files:**
- Modify: `xtask/src/build_deps.rs` (the resolver / `ensure_built` path)
- Possibly: `xtask/src/install_release.rs`, `xtask/src/stage_release.rs` (any other consumer of the build script path)

**Goal:** When the resolver invokes the build script (cache miss → source build), it computes the script's local path as `<repo_root>/<script_path>`. Today it joins `<package_dir>/<script>`.

**Step 1: Find consumers of the build script path.**

```bash
grep -n 'build\.script\|\.script_path\|build-.*\.sh' xtask/src/build_deps.rs
```

The relevant call site is where the resolver invokes `bash <path>` for a source rebuild. Today that path is `<package_dir>/<script>`; it needs to become `<repo_root>/<script_path>`.

**Step 2: Identify the repo root in the resolver context.**

The resolver must know the repo root to resolve `script_path`. Look at how the resolver currently locates the package dir — it walks from a known starting point (likely the repo root or workspace root). If `repo_root` isn't already a variable, derive it (`cargo metadata` provides it; or walk up from the workspace `Cargo.toml`).

**Step 3: Update the script-invocation site.**

Replace the existing `<package_dir>/<script>` join with `<repo_root>/<script_path>`. Handle the fallback:

- If `[build]` is absent (third-party packages might omit it), fall back to the existing convention `examples/libs/<name>/build-<name>.sh` — but compute the path against repo root, not package dir.

**Step 4: Update tests that exercise the resolver's source-build path.**

```bash
grep -n 'fn test.*build\|fn test.*resolve\|registry_find_returns_first_hit\|build_into_cache' xtask/src/build_deps.rs
```

Test fixtures that write `package.toml` files with the old `[build].script = ...` need updating to new `script_path` semantics. Where fixtures invoke the resolver and expect it to find a script, the fixture must produce a path that the resolver finds against the test's repo-root analog.

This is the trickiest test surface in the PR — fixture environments often simulate package layouts with temp dirs. The "repo root" in those tests is whatever the fixture sets up. Update fixtures consistently.

**Step 5: Build + test xtask.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -5
cargo test --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -10
```

Expected: clean build, 178+ tests pass.

If a test fails for an unexpected reason (not directly traceable to the rename), STOP and ask. Phase A-bis is mechanical at the resolver level — no business logic changes.

**Step 6: Commit.**

```bash
git add xtask/src/
git commit -m "feat(xtask): resolver consumes [build].script_path against repo root

The resolver previously joined <package_dir>/<script> to find the
build script. With [build].script_path being repo-relative, it now
joins <repo_root>/<script_path>. The fallback for missing [build]
blocks (the build-<name>.sh convention) also resolves against repo
root, so first-party and convention-using packages reach the same
canonical path.

Test fixtures that set up package layouts updated to the new
semantics. xtask unit tests still 178/0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backfill — modify 10 existing `[build]` blocks

**Files:** 10 `package.toml` files that already have a `[build]` block:
`dinit`, `erlang-vfs`, `lamp`, `mariadb-test`, `mariadb-vfs`, `nginx`, `perl-vfs`, `python-vfs`, `shell`, `wordpress`.

**Goal:** Rename `script` → `script_path` with full repo-relative path. Add `repo_url`.

**Step 1: List the 10 files.**

```bash
grep -l '^\[build\]' examples/libs/*/package.toml
```

Confirm the list matches the 10 expected. If different, the survey was off — re-check before continuing.

**Step 2: For each file, transform the `[build]` block.**

Today's shape:
```toml
[build]
script = "build-nginx.sh"
```

Becomes:
```toml
[build]
script_path = "examples/libs/nginx/build-nginx.sh"
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"
```

A scripted approach:
```bash
for f in $(grep -l '^\[build\]' examples/libs/*/package.toml); do
  pkg=$(basename "$(dirname "$f")")
  # Capture current script value
  script=$(awk '/^\[build\]/,/^$/' "$f" | grep '^script[[:space:]]*=' | sed 's/.*= *"//; s/".*//')
  # Build replacement [build] block
  python3 - "$f" "$pkg" "$script" <<'PY'
import sys, re
path, pkg, script = sys.argv[1:4]
text = open(path).read()
new_block = f'''[build]
script_path = "examples/libs/{pkg}/{script}"
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"
'''
text = re.sub(r'^\[build\]\nscript = "[^"]+"\n', new_block, text, flags=re.MULTILINE)
open(path, 'w').write(text)
PY
done
```

Or perform 10 manual edits if the scripted approach is too brittle for your taste — the rename is bounded enough either way.

**Step 3: Verify the result.**

```bash
# Every package that had [build] should now have script_path + repo_url.
for f in $(grep -l '^\[build\]' examples/libs/*/package.toml); do
  echo "=== $f ==="
  awk '/^\[build\]/,/^$/' "$f"
done | head -60
```

Spot-check 2-3 manually.

**Step 4: Verify each modified `package.toml` parses.**

```bash
cargo run --release -p xtask --target aarch64-apple-darwin -- build-deps parse examples/libs/nginx 2>&1 | tail -3
```

(Use whatever the relevant `xtask build-deps` subcommand is for parse-validation. Check `cargo xtask --help`.)

If parsing fails, the most likely cause is a script field that didn't have the conventional name — re-read the original file and adjust.

**Step 5: Commit.**

```bash
git add examples/libs/
git commit -m "refactor(packages): migrate 10 existing [build] blocks to new schema

For each of the 10 packages that already declared [build].script
(dinit, erlang-vfs, lamp, mariadb-test, mariadb-vfs, nginx,
perl-vfs, python-vfs, shell, wordpress):
- Rename script -> script_path with the full repo-relative path
- Add repo_url

[build].commit stays absent; CI will fill it on next publish.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Backfill — add `[build]` to 45 packages without one

**Files:** 45 `package.toml` files for first-party packages that have a `build-<name>.sh` script but no `[build]` block.

**Goal:** Each gets a `[build]` block with `script_path = "examples/libs/<name>/build-<name>.sh"` and `repo_url`. The resolver previously found these scripts via the convention; this commit makes the path explicit so the schema is consistent.

**Step 1: Compute the target list.**

```bash
for f in examples/libs/*/package.toml; do
  d=$(dirname "$f")
  pkg=$(basename "$d")
  if ! grep -q '^\[build\]' "$f" && ls "$d"/build-*.sh >/dev/null 2>&1; then
    script=$(ls "$d"/build-*.sh | head -1 | xargs basename)
    echo "$pkg|$script|$f"
  fi
done > /tmp/phase-a-bis-targets.txt
wc -l /tmp/phase-a-bis-targets.txt    # expected ~45
head -5 /tmp/phase-a-bis-targets.txt
```

If the count is off significantly, pause and ask.

**Step 2: Decide where in the file to insert `[build]`.**

The conventional ordering in existing files:
1. Top-level fields (`name`, `version`, `revision`, `depends_on`, etc.)
2. `[source]`
3. `[license]`
4. `[build]`
5. `[[outputs]]` (for `kind = "program"`)
6. `[binary.<arch>]`

Insert `[build]` immediately after `[license]`. If `[license]` doesn't have a trailing blank line, add one.

**Step 3: Scripted insert.**

```bash
while IFS='|' read -r pkg script path; do
  python3 - "$path" "$pkg" "$script" <<'PY'
import sys, re
path, pkg, script = sys.argv[1:4]
text = open(path).read()
new_block = f'''
[build]
script_path = "examples/libs/{pkg}/{script}"
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"
'''
# Insert after the [license] block. The [license] block ends at a blank
# line or at the start of the next section; find that boundary.
if '[license]' not in text:
    print(f"WARN: {path} has no [license] block; skipping", file=sys.stderr)
    sys.exit(1)
# Insert immediately before the line that starts the section AFTER [license].
# The license block content extends through the next blank line.
parts = text.split('\n[license]\n', 1)
header, after_license_marker = parts
# after_license_marker contains the [license] body + everything after.
# Find the end of [license] body (next blank line followed by a section header).
m = re.search(r'\n(\n\[)', after_license_marker)
if not m:
    print(f"WARN: {path} [license] block unterminated; skipping", file=sys.stderr)
    sys.exit(1)
license_body = after_license_marker[:m.start()]
rest = after_license_marker[m.start():]
out = header + '\n[license]\n' + license_body + new_block + rest
open(path, 'w').write(out)
PY
done < /tmp/phase-a-bis-targets.txt
```

**The python script is best-effort.** If the existing files have non-conventional layout, the insert may fail or produce ugly output. After running, eyeball ~5 of the modified files to confirm the insert is clean. If layout breaks, fall back to manual edits for the affected packages.

**Step 4: Verify.**

```bash
# Should now have 55 (10 from Task 3 + 45 from Task 4) packages with [build].
grep -l '^\[build\]' examples/libs/*/package.toml | wc -l    # expected 55

# Spot-check 3 random packages.
for pkg in mariadb cpython libcurl; do
  echo "=== $pkg ==="
  awk '/^\[build\]/,/^$/' "examples/libs/$pkg/package.toml"
done
```

**Step 5: Parse-validate each modified file.**

```bash
for f in examples/libs/*/package.toml; do
  cargo run --release -p xtask --target aarch64-apple-darwin --quiet -- build-deps parse "$(dirname "$f")" 2>&1 | grep -i error && echo "FAILED: $f"
done
```

Any failures: fix manually (most likely a layout that broke the python script). All 61 packages should parse — including the 6 left untouched (5 no-script + 1 source).

**Step 6: Commit.**

```bash
git add examples/libs/
git commit -m "feat(packages): backfill [build] block on 45 first-party packages

Adds [build] to every first-party package that has a build-<name>.sh
script but lacked an explicit block. The path that the resolver
previously found via convention is now declared directly:

  [build]
  script_path = \"examples/libs/<name>/build-<name>.sh\"
  repo_url    = \"https://github.com/wasm-posix-kernel/wasm-posix-kernel.git\"

The 6 first-party packages without [build] are intentionally left as-is:
- examples, kernel, node, sqlite-cli, userspace: no build script;
  already excluded from stage_release. Adding wrappers is tracked
  in docs/package-management-future-work.md.
- pcre2-source: kind = \"source\", [build] not applicable.

[build].commit stays absent in this commit; CI fills on next publish.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CI publish flow — fill `[build].commit` at publish time

**Files:**
- Modify: `xtask/src/stage_release.rs` (or wherever `[binary].archive_url` + `archive_sha256` are filled in)
- Possibly: `.github/workflows/force-rebuild.yml`, `.github/workflows/prepare-merge.yml` (where the bot PR is opened to bump pinned URLs)

**Goal:** When the publish flow updates a `package.toml` with new `[binary].archive_url` and `archive_sha256`, it also updates `[build].commit` with the building commit's SHA. Same lifecycle as the binary fields.

**Step 1: Find the existing `archive_url` / `archive_sha256` writeback site.**

```bash
grep -rn 'archive_url\|archive_sha256\|\[binary\.wasm32\]\|\[binary\.wasm64\]' xtask/src/stage_release.rs xtask/src/build_manifest.rs xtask/src/install_release.rs | head -20
```

The relevant code is the function that rewrites a `package.toml` after staging archives. (Not just builds the published `manifest.json` — the in-tree `package.toml` itself gets URLs+shas back-edited via the bot PR flow.)

**Step 2: Add `[build].commit` writeback.**

Where the writeback function updates `archive_url` / `archive_sha256`, add a parallel update for `[build].commit`. The commit SHA comes from `git rev-parse HEAD` in the worktree being published from. Plumb that value through to the writeback function.

If the writeback uses `toml_edit` (or a similar in-place TOML editor), this is a small change: navigate to `["build"]["commit"]` and set the value. If `[build]` doesn't exist (third-party package), skip (don't create it).

**Step 3: Update the workflow YAML if needed.**

If `force-rebuild.yml` or `prepare-merge.yml` constructs the writeback inputs, plumb the commit SHA in. (Likely already available as `${{ github.sha }}` in workflow context.)

**Step 4: Add a unit test for the writeback path.**

In whatever test file covers the writeback (likely in `stage_release.rs`'s test module), add a fixture that:
- Sets up a `package.toml` with `[build]` but no `commit`.
- Invokes the writeback with a fake commit SHA.
- Asserts the resulting file has `commit = "<that SHA>"`.

**Step 5: Build + test.**

```bash
cargo build --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -3
cargo test --release -p xtask --target aarch64-apple-darwin 2>&1 | tail -10
```

Expected: clean build, all tests pass.

**Step 6: Commit.**

```bash
git add xtask/src/ .github/workflows/
git commit -m "feat(xtask,ci): fill [build].commit at publish time

When the publish flow back-edits a package.toml with new
[binary].archive_url and archive_sha256, also update [build].commit
with the SHA of the building commit. Mirrors the existing
binary-fields lifecycle and is idempotent with the bot PR flow.

Skipped when [build] is absent (third-party packages).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verify + push + PR

**Files:** None modified — verification only.

Same approach as Phase A's Task 7 (run the cheap host-side suites locally, defer the expensive userspace suites to CI).

**Step 1: cargo unit tests.**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -10
```

Expected: 539+ pass, 0 fail.

**Step 2: vitest.**

```bash
cd host && npx vitest run 2>&1 | tail -15
cd ..
```

If the worktree is fresh and vitest's globalSetup fails on `wasm32posix-cc ENOENT`, you'll need to build the sysroot once. See Phase A's plan note about this for the workaround.

Expected: all test files pass (PHP/MariaDB tests skip if their binaries aren't built; that's normal).

**Step 3: ABI snapshot check.**

```bash
nix develop --accept-flake-config --command bash scripts/check-abi-version.sh 2>&1 | tail -5
```

Expected: exit 0. Phase A-bis is schema work — should NOT change the kernel ABI surface.

**Step 4: If all 3 green, push and open PR.**

```bash
git push -u origin phase-a-bis-schema-additions
gh pr create \
  --base main \
  --title "feat(packages): Phase A-bis — extend [build] schema + add kernel_abi" \
  --body "$(cat <<'EOF'
## Summary

Phase A-bis of the decoupled-package-builds initiative. Schema-shaped follow-up to PR #413's rename.

- Parser (`xtask/src/pkg_manifest.rs`): rename `[build].script` → `[build].script_path` (semantics: repo-relative path, not package-dir-relative). Add `[build].repo_url` and `[build].commit`. Add optional top-level `kernel_abi`. Old field name rejected with a clear error.
- Resolver (`xtask/src/build_deps.rs`): consume `script_path` against repo root.
- Backfill: 10 existing `[build]` blocks migrated to new field name + repo_url; 45 packages get a fresh `[build]` block; 6 packages intentionally left as-is (5 program-kind without build script + 1 source-kind).
- CI publish flow: `[build].commit` filled at publish time alongside `[binary].archive_url` + `archive_sha256`.

Design reference: `docs/plans/2026-05-05-decoupled-package-builds-design.md` §3.1.

## Test plan

Local (host-side fast subset):
- [x] `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — pass
- [x] `cargo test -p xtask --target aarch64-apple-darwin` — pass
- [x] `cd host && npx vitest run` — pass
- [x] `scripts/check-abi-version.sh` — exit 0 (no ABI change expected)

CI gates the userspace suites (libc-test, POSIX, sortix).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If any local check fails, STOP and report — Phase A-bis is mechanical, regressions point at a missed transition.

---

## Risks & open questions

- **Parser tests using `script` (not `script_path`).** xtask has unit-test-style fixtures in `pkg_manifest.rs` and `stage_release.rs`. Both must update consistently with the rename. If you find a test fixture you missed, CI catches it; for local dev, `cargo test -p xtask` should be the gate.
- **Resolver script-path resolution semantics may surface in tests.** Tests that simulate package layouts in temp dirs need their "repo root" to be set up sensibly. If a test is failing because its fixture set up a package dir but no enclosing repo root, fix the fixture rather than the resolver.
- **The python-script approach for Task 4's bulk insert** is best-effort. If a `package.toml`'s structure deviates from the conventional ordering, the script may insert `[build]` in the wrong place. Eyeball the result; manual fix-ups are cheap.
- **`[build]` not enforced as required.** Phase B will tighten this when the CI matrix gates on it. Phase A-bis ships the schema; Phase B enforces.
- **The 5 first-party packages without build scripts** (kernel, userspace, examples, node, sqlite-cli) intentionally don't get `[build]`. This is a known gap tracked in `docs/package-management-future-work.md` ("Ship kernel.wasm + userspace.wasm in the release"). Don't try to retrofit a `[build]` for them in this PR.

## Notes for the executor

- **Per CLAUDE.md, the test gates are per-CLAUDE.md** — but Phase A's user preference (memory: `feedback_defer-to-pr-ci.md`) said to defer userspace suites to CI on push. Phase A-bis follows the same convention.
- `nix develop --accept-flake-config --command ...` for any wasm/sysroot work. Don't use Homebrew clang directly.
- **`[build].commit` empty-state must be allowed.** The CI publish flow fills it. Newly-created packages, packages between rebuilds, and the just-edited backfill state all have `commit` absent. Parser must accept this.
- **Branch base is `origin/main` at HEAD `399c43689`** (the merge commit of PR #416, which landed the design + Phase A retrospective). Don't try to base on an older main.
