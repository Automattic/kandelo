# Binary Resolution via Index Ledger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the dual-storage of archive URLs between `package.toml` and the GitHub release with a single source of truth (`index.toml` ledger), atomically updated by CI via a generalized state-lock. Eliminate the `amend-package-toml` job class.

**Architecture:** Add new schema parsers (`build.toml`, `.wasm-posix-pkg.toml`, revised `index.toml`) and a new resolver path (index lookup → fetch). Build these alongside the existing code so the resolver can dual-path during development. Migrate all 53 packages and delete the old `[binary]`-block code path in one late-phase atomic commit. Verify with the full test suite plus a clean-fetch test plus the browser demo before merge.

**Tech Stack:** Rust (xtask), Bash (workflow scripts), TOML (schema), GitHub Actions (CI), Vitest (host tests), Cargo (kernel + xtask tests).

**Design reference:** `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md` (PR #457).

---

## Phase 0: Setup

### Task 0.1: Verify worktree state

**Files:**
- Read: `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md`

**Step 1: Confirm we're on the right branch**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `design/binary-resolution-via-index-ledger`

**Step 2: Confirm working tree is clean**

Run: `git status --short`
Expected: empty output (no uncommitted changes)

**Step 3: Re-read the design doc**

Read `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md` end-to-end. Pay special attention to:
- §3 (schema for all four files)
- §4 (resolver pseudocode)
- §5.1 (matrix-build job steps)
- §6 (migration steps)

This plan assumes you have that context loaded. Don't proceed to Phase 1 without it.

---

## Phase 1: Generalize the state-lock

### Task 1.1: Add unit tests for state-lock.sh subject parameter

**Files:**
- Create: `.github/scripts/test-state-lock.sh`

**Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# Test that state-lock.sh respects the <subject> positional arg
# by mapping it into a per-subject git ref.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/state-lock.sh"

# Capture the lock ref name the script would use for a given subject.
# This is a dry-run-only test (no actual git operations); it inspects
# the script's behavior via an environment variable hook we'll add.
test_subject_maps_to_ref() {
  local subject="$1"
  local expected_ref="$2"
  local actual_ref
  actual_ref=$(STATE_LOCK_DRY_RUN=1 bash "$SCRIPT" acquire "$subject" 2>&1 | grep -oE 'refs/heads/[^ ]+' | head -1)
  if [ "$actual_ref" != "$expected_ref" ]; then
    echo "FAIL: subject=$subject expected_ref=$expected_ref actual=$actual_ref" >&2
    return 1
  fi
  echo "PASS: subject=$subject → $actual_ref"
}

test_subject_maps_to_ref "durable-release" "refs/heads/github-actions/state-lock/durable-release"
test_subject_maps_to_ref "binaries-abi-v8" "refs/heads/github-actions/state-lock/binaries-abi-v8"
test_subject_maps_to_ref "pr-423-staging" "refs/heads/github-actions/state-lock/pr-423-staging"
```

**Step 2: Run test to verify it fails**

Run: `bash .github/scripts/test-state-lock.sh`
Expected: FAIL (script doesn't exist yet OR doesn't accept subject)

**Step 3: Commit the failing test**

```bash
git add .github/scripts/test-state-lock.sh
git commit -m "test(state-lock): subject parameter maps to per-subject ref"
```

### Task 1.2: Generalize `durable-release-lock.sh` → `state-lock.sh`

**Files:**
- Read: `.github/scripts/durable-release-lock.sh`
- Create: `.github/scripts/state-lock.sh`

**Step 1: Copy the existing lock script as the starting point**

Run: `cp .github/scripts/durable-release-lock.sh .github/scripts/state-lock.sh`

**Step 2: Modify state-lock.sh to accept `<subject>` positional arg**

Edit `.github/scripts/state-lock.sh`:
- Change the env var name from `DURABLE_RELEASE_LOCK_REF` to `STATE_LOCK_REF` (with a backward-compat fallback that reads `DURABLE_RELEASE_LOCK_REF` if `STATE_LOCK_REF` is unset).
- Change the env var name from `DURABLE_RELEASE_LOCK_POLL_SECONDS` to `STATE_LOCK_POLL_SECONDS` (with same backward-compat).
- Change the env var name from `DURABLE_RELEASE_LOCK_STALE_SECONDS` to `STATE_LOCK_STALE_SECONDS` (same).
- Update `usage()` to: `echo "usage: $0 acquire <subject>|release" >&2`
- In `acquire()`, before the main loop, set: `LOCK_REF="refs/heads/github-actions/state-lock/${SUBJECT:?subject required}"`
- Accept `STATE_LOCK_DRY_RUN=1`: when set, `acquire` echoes the computed ref name and exits 0 without contacting the remote.
- Update `case` block: `acquire) SUBJECT="${2:?usage}" ; acquire ;;`

**Step 3: Run the test from Task 1.1**

Run: `bash .github/scripts/test-state-lock.sh`
Expected: PASS for all three subject mappings.

**Step 4: Commit**

```bash
git add .github/scripts/state-lock.sh
git commit -m "feat(state-lock): generalize durable-release-lock to take subject param"
```

### Task 1.3: Migrate existing call sites to `state-lock.sh`

**Files:**
- Modify: `.github/workflows/prepare-merge.yml` (find calls to `durable-release-lock.sh`)
- Modify: `.github/workflows/force-rebuild.yml` (find calls)

**Step 1: Find existing call sites**

Run: `grep -rn "durable-release-lock.sh" .github/`
Expected: ≥2 hits in `prepare-merge.yml` and `force-rebuild.yml`.

**Step 2: Replace each call site**

For each `bash .github/scripts/durable-release-lock.sh acquire` → `bash .github/scripts/state-lock.sh acquire durable-release`.
For each `bash .github/scripts/durable-release-lock.sh release` → `bash .github/scripts/state-lock.sh release`.

The subject `durable-release` preserves the existing lock ref name (`refs/heads/github-actions/state-lock/durable-release` is new but equivalent — concurrent in-flight runs will use the new ref). After this PR merges, the old `refs/heads/github-actions/durable-release-lock` ref is dead; delete it manually after confirming no workflow uses it.

**Step 3: Confirm workflows still YAML-parse**

Run: `yamllint .github/workflows/prepare-merge.yml .github/workflows/force-rebuild.yml` (or any YAML validator available).
Expected: no parse errors.

**Step 4: Commit**

```bash
git add .github/workflows/prepare-merge.yml .github/workflows/force-rebuild.yml
git commit -m "refactor(ci): migrate existing call sites to state-lock.sh"
```

### Task 1.4: Delete `durable-release-lock.sh`

**Files:**
- Delete: `.github/scripts/durable-release-lock.sh`

**Step 1: Confirm no remaining call sites**

Run: `grep -rn "durable-release-lock" .github/ scripts/ 2>/dev/null`
Expected: zero hits in scripts/workflows; doc references in CLAUDE.md are fine to keep (or update separately).

**Step 2: Delete the file**

Run: `git rm .github/scripts/durable-release-lock.sh`

**Step 3: Commit**

```bash
git commit -m "chore(state-lock): remove now-unused durable-release-lock.sh"
```

---

## Phase 2: xtask schema parsers — `build.toml`

### Task 2.1: Add a failing test for `BuildToml::parse` with valid input

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs` (add new test at end of `tests` mod)

**Step 1: Add the failing test**

```rust
#[test]
fn parses_build_toml_with_named_source() {
    let toml = r#"
script_path = "packages/registry/foo/build-foo.sh"
repo_url = "https://github.com/example/foo.git"
commit = "abc123"

[binary]
source = "first-party"
"#;
    let bt = BuildToml::parse(toml).expect("should parse");
    assert_eq!(bt.script_path, "packages/registry/foo/build-foo.sh");
    assert_eq!(bt.repo_url, "https://github.com/example/foo.git");
    assert_eq!(bt.commit, "abc123");
    assert!(matches!(bt.binary, BinarySource::Named { ref name } if name == "first-party"));
}
```

**Step 2: Run to verify it fails to compile**

Run: `cargo build -p xtask --target aarch64-apple-darwin 2>&1 | head -20`
Expected: compile error — `BuildToml`, `BinarySource` not found.

**Step 3: Commit the failing test**

```bash
git add tools/xtask/src/pkg_manifest.rs
git commit -m "test(pkg-manifest): parse build.toml with named source"
```

### Task 2.2: Implement minimal `BuildToml::parse` + `BinarySource` for named source

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs`

**Step 1: Add the struct + parser**

Add to `pkg_manifest.rs` (near the existing `PackageManifest` definition):

```rust
/// build.toml — project's view of how a package was built and where its
/// binary is published. Sibling to package.toml (which is the recipe).
/// See docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md §3.2.
#[derive(Clone, Debug)]
pub struct BuildToml {
    pub script_path: String,
    pub repo_url: String,
    pub commit: String,
    pub binary: BinarySource,
}

#[derive(Clone, Debug)]
pub enum BinarySource {
    /// `[binary] source = "<name>"` — looks up <name> in .wasm-posix-pkg.toml.
    Named { name: String },
    /// `[binary] index_url = "<URL>"` — inline index URL, no .wasm-posix-pkg.toml needed.
    Inline { index_url: String },
    /// `[binary] url = "<URL>" sha256 = "<sha>"` — direct archive URL.
    Direct { url: String, sha256: String },
}

#[derive(serde::Deserialize)]
struct BuildTomlRaw {
    script_path: String,
    repo_url: String,
    commit: String,
    binary: BinaryRaw,
}

#[derive(serde::Deserialize)]
struct BinaryRaw {
    source: Option<String>,
    index_url: Option<String>,
    url: Option<String>,
    sha256: Option<String>,
}

impl BuildToml {
    pub fn parse(s: &str) -> Result<Self, String> {
        let raw: BuildTomlRaw = toml::from_str(s).map_err(|e| format!("build.toml parse: {e}"))?;
        let binary = match (raw.binary.source, raw.binary.index_url, raw.binary.url) {
            (Some(name), None, None) => BinarySource::Named { name },
            (None, Some(index_url), None) => BinarySource::Inline { index_url },
            (None, None, Some(url)) => {
                let sha256 = raw.binary.sha256.ok_or_else(|| {
                    "build.toml [binary] url requires sha256".to_string()
                })?;
                BinarySource::Direct { url, sha256 }
            }
            _ => return Err(
                "build.toml [binary] must specify exactly one of: source, index_url, url".to_string()
            ),
        };
        Ok(BuildToml {
            script_path: raw.script_path,
            repo_url: raw.repo_url,
            commit: raw.commit,
            binary,
        })
    }
}
```

**Step 2: Run the test from Task 2.1**

Run: `cargo test -p xtask --target aarch64-apple-darwin parses_build_toml_with_named_source`
Expected: PASS.

**Step 3: Commit**

```bash
git add tools/xtask/src/pkg_manifest.rs
git commit -m "feat(pkg-manifest): BuildToml::parse for named source form"
```

### Task 2.3: Add tests for inline and direct binary forms

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs` (add two more tests)

**Step 1: Write two failing tests**

```rust
#[test]
fn parses_build_toml_with_inline_source() {
    let toml = r#"
script_path = "packages/registry/foo/build.sh"
repo_url = "https://github.com/example/foo.git"
commit = "abc"
[binary]
index_url = "https://other.example/binaries-v{abi}/index.toml"
"#;
    let bt = BuildToml::parse(toml).unwrap();
    assert!(matches!(bt.binary, BinarySource::Inline { ref index_url }
                     if index_url == "https://other.example/binaries-v{abi}/index.toml"));
}

#[test]
fn parses_build_toml_with_direct_url() {
    let toml = r#"
script_path = "x"
repo_url = "y"
commit = "z"
[binary]
url = "https://example.com/foo.tar.zst"
sha256 = "abc"
"#;
    let bt = BuildToml::parse(toml).unwrap();
    assert!(matches!(bt.binary, BinarySource::Direct { ref url, ref sha256 }
                     if url == "https://example.com/foo.tar.zst" && sha256 == "abc"));
}

#[test]
fn rejects_build_toml_with_multiple_binary_forms() {
    let toml = r#"
script_path = "x"
repo_url = "y"
commit = "z"
[binary]
source = "first-party"
url = "https://example.com/x.tar.zst"
sha256 = "abc"
"#;
    let err = BuildToml::parse(toml).unwrap_err();
    assert!(err.contains("exactly one of"), "got: {err}");
}

#[test]
fn rejects_build_toml_direct_url_without_sha() {
    let toml = r#"
script_path = "x"
repo_url = "y"
commit = "z"
[binary]
url = "https://example.com/x.tar.zst"
"#;
    let err = BuildToml::parse(toml).unwrap_err();
    assert!(err.contains("requires sha256"), "got: {err}");
}
```

**Step 2: Run tests — should already pass given Task 2.2's implementation**

Run: `cargo test -p xtask --target aarch64-apple-darwin parses_build_toml`
Expected: 4 tests PASS.

If any fail, fix the implementation in `pkg_manifest.rs` to match.

**Step 3: Commit**

```bash
git add tools/xtask/src/pkg_manifest.rs
git commit -m "test(pkg-manifest): BuildToml inline/direct/validation tests"
```

---

## Phase 3: xtask schema parsers — `.wasm-posix-pkg.toml`

### Task 3.1: Add `WasmPkgConfig` parser with a failing test

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs`

**Step 1: Add the failing test**

```rust
#[test]
fn parses_wasm_pkg_config_with_two_sources() {
    let toml = r#"
[sources.first-party]
index_url = "https://github.com/foo/foo/releases/download/binaries-abi-v{abi}/index.toml"

[sources.fun-pack]
index_url = "https://github.com/funpack/funpack/releases/download/binaries-v{abi}/index.toml"
"#;
    let cfg = WasmPkgConfig::parse(toml).unwrap();
    assert_eq!(cfg.sources.len(), 2);
    assert!(cfg.sources.contains_key("first-party"));
    assert!(cfg.sources.contains_key("fun-pack"));
    assert!(cfg.sources["first-party"].index_url.contains("foo/foo"));
}
```

**Step 2: Run to verify fail**

Run: `cargo build -p xtask --target aarch64-apple-darwin 2>&1 | head -10`
Expected: `WasmPkgConfig not found`.

**Step 3: Commit failing test**

```bash
git add tools/xtask/src/pkg_manifest.rs
git commit -m "test(pkg-manifest): parse .wasm-posix-pkg.toml"
```

### Task 3.2: Implement `WasmPkgConfig::parse`

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs`

**Step 1: Add the struct + parser**

```rust
/// .wasm-posix-pkg.toml — repo-root named-source definitions.
/// See design §3.3.
#[derive(Clone, Debug)]
pub struct WasmPkgConfig {
    pub sources: std::collections::BTreeMap<String, SourceDef>,
}

#[derive(Clone, Debug)]
pub struct SourceDef {
    pub index_url: String,
}

impl WasmPkgConfig {
    pub fn parse(s: &str) -> Result<Self, String> {
        #[derive(serde::Deserialize)]
        struct Raw {
            sources: std::collections::BTreeMap<String, SourceDefRaw>,
        }
        #[derive(serde::Deserialize)]
        struct SourceDefRaw {
            index_url: String,
        }
        let raw: Raw = toml::from_str(s).map_err(|e| format!(".wasm-posix-pkg.toml parse: {e}"))?;
        let sources = raw
            .sources
            .into_iter()
            .map(|(k, v)| (k, SourceDef { index_url: v.index_url }))
            .collect();
        Ok(WasmPkgConfig { sources })
    }

    /// Resolve a named source to its index URL with `{abi}` substituted.
    pub fn resolve_source(&self, name: &str, abi: u32) -> Result<String, String> {
        let def = self
            .sources
            .get(name)
            .ok_or_else(|| format!("unknown source '{name}' (not in .wasm-posix-pkg.toml)"))?;
        Ok(def.index_url.replace("{abi}", &abi.to_string()))
    }
}
```

**Step 2: Add a test for `resolve_source` `{abi}` substitution**

```rust
#[test]
fn wasm_pkg_config_substitutes_abi_in_index_url() {
    let toml = r#"
[sources.first-party]
index_url = "https://example.com/binaries-abi-v{abi}/index.toml"
"#;
    let cfg = WasmPkgConfig::parse(toml).unwrap();
    let resolved = cfg.resolve_source("first-party", 8).unwrap();
    assert_eq!(resolved, "https://example.com/binaries-abi-v8/index.toml");
}

#[test]
fn wasm_pkg_config_errors_on_unknown_source() {
    let cfg = WasmPkgConfig::parse(r#"[sources.foo]
index_url = "https://example.com/{abi}/idx.toml"
"#).unwrap();
    let err = cfg.resolve_source("missing", 8).unwrap_err();
    assert!(err.contains("unknown source"), "got: {err}");
}
```

**Step 3: Run tests**

Run: `cargo test -p xtask --target aarch64-apple-darwin wasm_pkg_config`
Expected: 3 tests PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/pkg_manifest.rs
git commit -m "feat(pkg-manifest): WasmPkgConfig parser + source resolution"
```

---

## Phase 4: xtask schema parsers — revised `package.toml`

### Task 4.1: Add a test that the new package.toml parser rejects old `[binary]` block

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs`

**Step 1: Write the failing test**

This test exercises the parser's NEW behavior: the `[binary]` block (and `revision`, `[build].repo_url`, `[build].commit`) are no longer allowed in `package.toml`. We'll parse them as `#[serde(deny_unknown_fields)]`-style errors so old files fail loud.

```rust
#[test]
fn package_toml_rejects_legacy_binary_block() {
    let toml = r#"
name = "foo"
version = "1.0"
kernel_abi = 8

[source]
url = "https://example.com/foo.tar.gz"
sha256 = "abc"

[license]
spdx = "MIT"

[build]
script_path = "packages/registry/foo/build.sh"

[binary.wasm32]
archive_url = "https://example.com/foo-wasm32.tar.zst"
archive_sha256 = "def"
"#;
    let err = PackageManifest::parse(toml).unwrap_err();
    assert!(
        err.contains("[binary]") || err.contains("binary"),
        "expected error mentioning [binary], got: {err}"
    );
}

#[test]
fn package_toml_rejects_legacy_revision_field() {
    let toml = r#"
name = "foo"
version = "1.0"
revision = 1
kernel_abi = 8

[source]
url = "https://example.com/foo.tar.gz"
sha256 = "abc"

[license]
spdx = "MIT"

[build]
script_path = "packages/registry/foo/build.sh"
"#;
    let err = PackageManifest::parse(toml).unwrap_err();
    assert!(err.contains("revision"), "expected error mentioning revision, got: {err}");
}

#[test]
fn package_toml_accepts_minimal_new_format() {
    let toml = r#"
name = "foo"
version = "1.0"
kernel_abi = 8
depends_on = []

[source]
url = "https://example.com/foo.tar.gz"
sha256 = "abc"

[license]
spdx = "MIT"

[build]
script_path = "packages/registry/foo/build.sh"
"#;
    let pkg = PackageManifest::parse(toml).expect("should parse");
    assert_eq!(pkg.name, "foo");
    assert_eq!(pkg.version, "1.0");
    assert_eq!(pkg.kernel_abi, Some(8));
}
```

**Step 2: Run to verify the first two fail (parser still accepts legacy)**

Run: `cargo test -p xtask --target aarch64-apple-darwin package_toml_rejects_legacy`
Expected: 2 tests FAIL (parser still accepts the old format).

**Step 3: Commit failing tests**

```bash
git add tools/xtask/src/pkg_manifest.rs
git commit -m "test(pkg-manifest): reject legacy [binary] / revision in package.toml"
```

### Task 4.2: Remove legacy fields from package.toml parser

**Files:**
- Modify: `tools/xtask/src/pkg_manifest.rs`

**Step 1: Find the relevant structs**

Locate `PackageManifestRaw` (the `#[derive(serde::Deserialize)]` struct backing the `package.toml` parser). It likely has fields like `revision`, `binary`, and a `[build]` block with `repo_url` and `commit`.

**Step 2: Delete the legacy fields**

In `PackageManifestRaw`:
- Remove `revision` field.
- Remove `binary` field (or whatever map holds `[binary.<arch>]`).
- In the nested `BuildRaw` struct, remove `repo_url` and `commit`. Keep only `script_path`.

Add `#[serde(deny_unknown_fields)]` to `PackageManifestRaw` and `BuildRaw` so unrecognized fields fail loud with a clear error.

**Step 3: Update `PackageManifest` struct fields** to drop `revision`, `binary`, and the `Build` struct's `repo_url`/`commit`.

**Step 4: Fix every compile error** that results. Many places in `build_deps.rs`, `update_pkg_manifest.rs`, `build_index.rs`, `archive_stage.rs` read these fields. For now, replace each read site with a `// TODO: migrate to BuildToml / IndexEntry` placeholder that either returns a sentinel or `todo!()`. We'll wire them properly in later phases.

**Step 5: Run the three tests from Task 4.1**

Run: `cargo test -p xtask --target aarch64-apple-darwin package_toml_`
Expected: all three PASS. (The first two reject the legacy fields; the third parses the new minimal format.)

**Step 6: Commit (with broken downstream callers as TODOs)**

```bash
git add tools/xtask/src/pkg_manifest.rs tools/xtask/src/*.rs
git commit -m "feat(pkg-manifest): drop [binary]/revision from package.toml schema

Replaces broken read sites with todo!() placeholders to be fixed in
later phases that introduce IndexEntry/BuildToml-based reads."
```

---

## Phase 5: xtask schema — `index.toml` ledger

### Task 5.1: Add a test for parsing the new `IndexToml` schema with `status` fields

**Files:**
- Create: `tools/xtask/src/index_toml.rs`
- Modify: `tools/xtask/src/main.rs` (add `mod index_toml;`)

**Step 1: Write the failing test**

In `tools/xtask/src/index_toml.rs`:

```rust
//! Parser + writer for the index.toml ledger.
//! See docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md §3.4.

#![cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_index_toml_with_success_entry() {
        let toml = r#"
abi_version  = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "foo-1.0-rev1-abi8-wasm32-abc12345.tar.zst"
archive_sha256 = "deadbeef"
cache_key_sha  = "abc12345"
built_at       = "2026-05-13T00:00:00Z"
built_by       = "https://example.com/run/1"
"#;
        let idx = IndexToml::parse(toml).unwrap();
        assert_eq!(idx.abi_version, 8);
        assert_eq!(idx.packages.len(), 1);
        let pkg = &idx.packages[0];
        assert_eq!(pkg.name, "foo");
        let entry = pkg.binary.get(&TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(entry.archive_url.as_deref(), Some("foo-1.0-rev1-abi8-wasm32-abc12345.tar.zst"));
    }

    #[test]
    fn parses_index_toml_with_failed_entry_and_fallback() {
        let toml = r#"
abi_version  = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm64]
status                  = "failed"
error                   = "linker error"
last_attempt            = "2026-05-13T00:00:00Z"
fallback_archive_url    = "foo-1.0-rev1-abi8-wasm64-old.tar.zst"
fallback_archive_sha256 = "olddeadbeef"
fallback_cache_key_sha  = "oldcachekey"
fallback_built_at       = "2026-05-12T00:00:00Z"
"#;
        let idx = IndexToml::parse(toml).unwrap();
        let entry = &idx.packages[0].binary[&TargetArch::Wasm64];
        assert_eq!(entry.status, EntryStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("linker error"));
        assert_eq!(entry.fallback_archive_url.as_deref(), Some("foo-1.0-rev1-abi8-wasm64-old.tar.zst"));
    }
}
```

**Step 2: Run to verify it fails to compile**

Run: `cargo build -p xtask --target aarch64-apple-darwin 2>&1 | head -10`
Expected: `index_toml not found` or `IndexToml not found`.

**Step 3: Commit failing test (no implementation yet)**

```bash
git add tools/xtask/src/index_toml.rs tools/xtask/src/main.rs
git commit -m "test(index-toml): parse success and failed-with-fallback entries"
```

### Task 5.2: Implement `IndexToml` parser

**Files:**
- Modify: `tools/xtask/src/index_toml.rs`

**Step 1: Add the schema + parser**

Write the parser at the top of `tools/xtask/src/index_toml.rs`. Use `serde` for deserialization. Define:

- `pub struct IndexToml { abi_version: u32, generated_at: String, generator: String, packages: Vec<PackageEntry> }`
- `pub struct PackageEntry { name: String, version: String, revision: u32, binary: BTreeMap<TargetArch, BinaryEntry> }`
- `pub struct BinaryEntry { status: EntryStatus, archive_url: Option<String>, archive_sha256: Option<String>, cache_key_sha: Option<String>, built_at: Option<String>, built_by: Option<String>, error: Option<String>, last_attempt: Option<String>, last_attempt_by: Option<String>, fallback_archive_url: Option<String>, fallback_archive_sha256: Option<String>, fallback_cache_key_sha: Option<String>, fallback_built_at: Option<String> }`
- `pub enum EntryStatus { Pending, Building, Success, Failed }` with `serde(rename_all = "lowercase")`.

`IndexToml::parse(s: &str) -> Result<Self, String>` uses `toml::from_str`.

Use `crate::pkg_manifest::TargetArch` for the arch type.

**Step 2: Add a `lookup` method**

```rust
impl IndexToml {
    pub fn lookup(&self, name: &str, version: &str, arch: TargetArch) -> Option<&BinaryEntry> {
        self.packages
            .iter()
            .find(|p| p.name == name && p.version == version)?
            .binary
            .get(&arch)
    }
}
```

**Step 3: Run the tests**

Run: `cargo test -p xtask --target aarch64-apple-darwin index_toml`
Expected: both tests PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/index_toml.rs
git commit -m "feat(index-toml): parser + lookup for new ledger schema"
```

### Task 5.3: Add `IndexToml::write` (round-trip writer)

**Files:**
- Modify: `tools/xtask/src/index_toml.rs`

**Step 1: Write a round-trip test**

```rust
#[test]
fn index_toml_round_trips_byte_identical() {
    let original = r#"abi_version = 8
generated_at = "2026-05-13T00:00:00Z"
generator = "test"

[[packages]]
name = "foo"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "foo.tar.zst"
archive_sha256 = "abc"
cache_key_sha = "def"
built_at = "2026-05-13T00:00:00Z"
built_by = "https://example.com/run/1"
"#;
    let idx = IndexToml::parse(original).unwrap();
    let written = idx.write();
    let reparsed = IndexToml::parse(&written).unwrap();
    assert_eq!(reparsed.abi_version, idx.abi_version);
    assert_eq!(reparsed.packages.len(), idx.packages.len());
    // Byte-identical is nice-to-have but not required; semantic equality is sufficient.
}
```

**Step 2: Implement `write()`**

Hand-format the TOML in `IndexToml::write(&self) -> String` to match the schema in design §3.4. Order: top-level keys (`abi_version`, `generated_at`, `generator`) → `[[packages]]` blocks sorted alphabetically by name → within each package, arches sorted (`wasm32` before `wasm64`).

Do NOT use `toml::to_string` directly — it sorts table keys alphabetically and would emit `archive_sha256` before `archive_url` etc.

**Step 3: Run the test**

Run: `cargo test -p xtask --target aarch64-apple-darwin index_toml_round_trips`
Expected: PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/index_toml.rs
git commit -m "feat(index-toml): write() round-trips the ledger schema"
```

### Task 5.4: Add `IndexToml::update_entry` with last-green fallback logic

**Files:**
- Modify: `tools/xtask/src/index_toml.rs`

**Step 1: Write tests for the success/failed/fallback transitions**

```rust
#[test]
fn update_entry_success_overwrites_current_and_clears_fallback() {
    let mut idx = IndexToml::empty(8, "now".into(), "test".into());
    idx.update_entry_success(
        "foo", "1.0", 1, TargetArch::Wasm32,
        "foo-new.tar.zst".into(), "newsha".into(), "newkey".into(),
        "now".into(), "run-url".into(),
    );
    let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
    assert_eq!(entry.status, EntryStatus::Success);
    assert_eq!(entry.archive_url.as_deref(), Some("foo-new.tar.zst"));
    assert!(entry.fallback_archive_url.is_none());
}

#[test]
fn update_entry_failed_moves_current_to_fallback() {
    let mut idx = IndexToml::empty(8, "now".into(), "test".into());
    // First publish a success.
    idx.update_entry_success(
        "foo", "1.0", 1, TargetArch::Wasm32,
        "foo-good.tar.zst".into(), "goodsha".into(), "goodkey".into(),
        "t1".into(), "run1".into(),
    );
    // Then fail a rebuild.
    idx.update_entry_failed(
        "foo", "1.0", 1, TargetArch::Wasm32,
        "linker error".into(), "t2".into(), "run2".into(),
    );
    let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
    assert_eq!(entry.status, EntryStatus::Failed);
    assert_eq!(entry.error.as_deref(), Some("linker error"));
    assert!(entry.archive_url.is_none());
    assert_eq!(entry.fallback_archive_url.as_deref(), Some("foo-good.tar.zst"));
}

#[test]
fn update_entry_failed_preserves_existing_fallback() {
    let mut idx = IndexToml::empty(8, "now".into(), "test".into());
    // First failure with no prior success → no fallback.
    idx.update_entry_failed(
        "foo", "1.0", 1, TargetArch::Wasm32,
        "first error".into(), "t1".into(), "run1".into(),
    );
    let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
    assert!(entry.fallback_archive_url.is_none());
}
```

**Step 2: Implement the methods**

```rust
impl IndexToml {
    pub fn empty(abi: u32, ts: String, gen: String) -> Self {
        IndexToml { abi_version: abi, generated_at: ts, generator: gen, packages: vec![] }
    }

    pub fn update_entry_success(
        &mut self,
        name: &str,
        version: &str,
        revision: u32,
        arch: TargetArch,
        archive_url: String,
        archive_sha256: String,
        cache_key_sha: String,
        built_at: String,
        built_by: String,
    ) {
        let entry = self.entry_mut(name, version, revision, arch);
        // New success: overwrites current, clears fallback.
        entry.status = EntryStatus::Success;
        entry.archive_url = Some(archive_url);
        entry.archive_sha256 = Some(archive_sha256);
        entry.cache_key_sha = Some(cache_key_sha);
        entry.built_at = Some(built_at);
        entry.built_by = Some(built_by);
        entry.error = None;
        entry.last_attempt = None;
        entry.last_attempt_by = None;
        entry.fallback_archive_url = None;
        entry.fallback_archive_sha256 = None;
        entry.fallback_cache_key_sha = None;
        entry.fallback_built_at = None;
    }

    pub fn update_entry_failed(
        &mut self,
        name: &str,
        version: &str,
        revision: u32,
        arch: TargetArch,
        error: String,
        last_attempt: String,
        last_attempt_by: String,
    ) {
        let entry = self.entry_mut(name, version, revision, arch);
        // If we had a current success, move it to fallback (only if no existing fallback —
        // we never overwrite a fallback because that's the last good copy).
        if entry.status == EntryStatus::Success && entry.fallback_archive_url.is_none() {
            entry.fallback_archive_url = entry.archive_url.take();
            entry.fallback_archive_sha256 = entry.archive_sha256.take();
            entry.fallback_cache_key_sha = entry.cache_key_sha.take();
            entry.fallback_built_at = entry.built_at.take();
        } else {
            // Either no prior success or already have a fallback — clear current archive fields.
            entry.archive_url = None;
            entry.archive_sha256 = None;
            entry.cache_key_sha = None;
            entry.built_at = None;
            entry.built_by = None;
        }
        entry.status = EntryStatus::Failed;
        entry.error = Some(error);
        entry.last_attempt = Some(last_attempt);
        entry.last_attempt_by = Some(last_attempt_by);
    }

    fn entry_mut(&mut self, name: &str, version: &str, revision: u32, arch: TargetArch) -> &mut BinaryEntry {
        if !self.packages.iter().any(|p| p.name == name && p.version == version) {
            self.packages.push(PackageEntry {
                name: name.into(),
                version: version.into(),
                revision,
                binary: BTreeMap::new(),
            });
        }
        let pkg = self
            .packages
            .iter_mut()
            .find(|p| p.name == name && p.version == version)
            .unwrap();
        pkg.binary.entry(arch).or_insert_with(BinaryEntry::default)
    }
}
```

Add `#[derive(Default)]` to `BinaryEntry`.

**Step 3: Run tests**

Run: `cargo test -p xtask --target aarch64-apple-darwin update_entry`
Expected: 3 tests PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/index_toml.rs
git commit -m "feat(index-toml): update_entry with last-green fallback semantics"
```

---

## Phase 6: Resolver — `index_lookup` + new fetch path

### Task 6.1: Add a failing test that the resolver fetches via index lookup

**Files:**
- Modify: `tools/xtask/src/build_deps.rs` (test mod at end)

**Step 1: Write the failing test**

This test sets up a fake source on disk (`file://` URL), populates an `index.toml`, points a `build.toml` at it, and verifies the resolver fetches the indexed archive.

```rust
#[test]
fn resolver_fetches_via_index_lookup() {
    // 1. Create temp dir with a published archive and an index.toml.
    let tmp = tempfile::tempdir().unwrap();
    let source_dir = tmp.path().join("source");
    std::fs::create_dir_all(&source_dir).unwrap();

    let archive_bytes = remote_fetch::build_test_archive(
        "foo", "1.0", 1, 8, TargetArch::Wasm32, "cachekey-foo-wasm32",
    );
    let archive_filename = "foo-1.0-rev1-abi8-wasm32-cachekey-.tar.zst";  // placeholder
    let archive_path = source_dir.join(archive_filename);
    std::fs::write(&archive_path, &archive_bytes).unwrap();
    let archive_sha = hex(&sha256(&archive_bytes));

    let index_toml = format!(r#"abi_version = 8
generated_at = "now"
generator = "test"

[[packages]]
name = "foo"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "{archive_filename}"
archive_sha256 = "{archive_sha}"
cache_key_sha = "cachekey-foo-wasm32"
built_at = "now"
built_by = "test"
"#);
    let index_path = source_dir.join("index.toml");
    std::fs::write(&index_path, &index_toml).unwrap();

    // 2. Create a package.toml + build.toml that point at this source.
    let pkg_dir = tmp.path().join("pkg-foo");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(pkg_dir.join("package.toml"), r#"
name = "foo"
version = "1.0"
kernel_abi = 8

[source]
url = "https://example.com/foo.tar.gz"
sha256 = "ignored-for-this-test"

[license]
spdx = "MIT"

[build]
script_path = "build.sh"
"#).unwrap();

    let index_url = format!("file://{}", index_path.display());
    std::fs::write(pkg_dir.join("build.toml"), format!(r#"
script_path = "build.sh"
repo_url = "https://example.com"
commit = "abc"

[binary]
index_url = "{index_url}"
"#)).unwrap();

    // 3. Run the resolver.
    let cache = tmp.path().join("cache");
    let opts = ResolveOpts {
        binaries_dir: None,
        local_libs_dir: None,
        cache_dir: &cache,
        force_rebuild: false,
        repo_root: None,
    };
    let result = cmd_resolve(&pkg_dir, TargetArch::Wasm32, &opts).unwrap();

    // 4. Assert the resolver installed the archive (cache populated).
    assert!(result.canonical.exists());
}
```

**Step 2: Run to verify it fails**

Run: `cargo test -p xtask --target aarch64-apple-darwin resolver_fetches_via_index_lookup`
Expected: FAIL — `cmd_resolve` doesn't know about `build.toml` or index lookup yet.

**Step 3: Commit failing test**

```bash
git add tools/xtask/src/build_deps.rs
git commit -m "test(build-deps): resolver fetches via index lookup"
```

### Task 6.2: Implement `load_build_toml` + `load_index` helpers

**Files:**
- Modify: `tools/xtask/src/build_deps.rs`

**Step 1: Add helper functions**

```rust
use crate::pkg_manifest::{BuildToml, BinarySource, WasmPkgConfig};
use crate::index_toml::IndexToml;

/// Load `build.toml` from a package directory.
fn load_build_toml(package_dir: &Path) -> Result<BuildToml, String> {
    let path = package_dir.join("build.toml");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    BuildToml::parse(&content)
}

/// Load and parse `.wasm-posix-pkg.toml` from the repo root. Returns
/// `Ok(None)` if the file doesn't exist (a project may use only inline
/// sources).
fn load_wasm_pkg_config(repo_root: &Path) -> Result<Option<WasmPkgConfig>, String> {
    let path = repo_root.join(".wasm-posix-pkg.toml");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    WasmPkgConfig::parse(&content).map(Some)
}

/// Resolve a `BinarySource` to a concrete index URL (or None for direct URL).
fn resolve_index_url(
    binary: &BinarySource,
    config: Option<&WasmPkgConfig>,
    abi: u32,
) -> Result<Option<String>, String> {
    match binary {
        BinarySource::Named { name } => {
            let cfg = config.ok_or_else(|| {
                format!("build.toml uses [binary] source = '{name}' but no .wasm-posix-pkg.toml found")
            })?;
            Ok(Some(cfg.resolve_source(name, abi)?))
        }
        BinarySource::Inline { index_url } => {
            Ok(Some(index_url.replace("{abi}", &abi.to_string())))
        }
        BinarySource::Direct { .. } => Ok(None),
    }
}
```

**Step 2: Add a test for resolve_index_url**

```rust
#[test]
fn resolve_index_url_with_named_source() {
    let cfg = WasmPkgConfig::parse(r#"
[sources.fp]
index_url = "https://e.com/abi-v{abi}/i.toml"
"#).unwrap();
    let binary = BinarySource::Named { name: "fp".into() };
    let url = resolve_index_url(&binary, Some(&cfg), 8).unwrap();
    assert_eq!(url.as_deref(), Some("https://e.com/abi-v8/i.toml"));
}

#[test]
fn resolve_index_url_with_inline() {
    let binary = BinarySource::Inline { index_url: "https://e.com/abi-v{abi}/i.toml".into() };
    let url = resolve_index_url(&binary, None, 8).unwrap();
    assert_eq!(url.as_deref(), Some("https://e.com/abi-v8/i.toml"));
}

#[test]
fn resolve_index_url_with_direct_returns_none() {
    let binary = BinarySource::Direct { url: "x".into(), sha256: "y".into() };
    let url = resolve_index_url(&binary, None, 8).unwrap();
    assert!(url.is_none());
}
```

**Step 3: Run tests**

Run: `cargo test -p xtask --target aarch64-apple-darwin resolve_index_url`
Expected: 3 PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/build_deps.rs
git commit -m "feat(build-deps): load_build_toml + resolve_index_url helpers"
```

### Task 6.3: Implement `fetch_index` with offline caching

**Files:**
- Modify: `tools/xtask/src/build_deps.rs` (or new `tools/xtask/src/index_cache.rs`)

**Step 1: Write test for online fetch + cache write**

```rust
#[test]
fn fetch_index_writes_cache_on_first_online_fetch() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().join("cache");

    // Stage an index.toml at a file:// URL.
    let idx_path = tmp.path().join("index.toml");
    std::fs::write(&idx_path, r#"abi_version = 8
generated_at = "t"
generator = "test"
"#).unwrap();
    let url = format!("file://{}", idx_path.display());

    let idx = fetch_index(&url, &cache_dir).unwrap();
    assert_eq!(idx.abi_version, 8);

    // Cache file should exist now.
    let cache_files: Vec<_> = std::fs::read_dir(&cache_dir).unwrap().collect();
    assert_eq!(cache_files.len(), 1);
}

#[test]
fn fetch_index_falls_back_to_cache_when_offline() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();

    // Manually seed the cache.
    let url = "https://example.com/abi-v8/index.toml";
    let key = sha256_hex(url.as_bytes());
    let cache_path = cache_dir.join(format!("index-{}.toml", &key[..16]));
    std::fs::write(&cache_path, r#"abi_version = 8
generated_at = "t"
generator = "cached"
"#).unwrap();

    // Force offline.
    std::env::set_var("WASM_POSIX_OFFLINE", "1");
    let idx = fetch_index(url, &cache_dir).unwrap();
    std::env::remove_var("WASM_POSIX_OFFLINE");

    assert_eq!(idx.generator, "cached");
}
```

**Step 2: Implement `fetch_index`**

```rust
fn fetch_index(index_url: &str, cache_dir: &Path) -> Result<IndexToml, String> {
    let key = hex(&sha256(index_url.as_bytes()));
    let cache_path = cache_dir.join(format!("index-{}.toml", &key[..16]));

    // Try online first (unless offline mode is set).
    let offline = std::env::var_os("WASM_POSIX_OFFLINE")
        .is_some_and(|v| !v.is_empty() && v != "0");

    if !offline {
        match crate::remote_fetch::fetch_url(index_url) {
            Ok(bytes) => {
                std::fs::create_dir_all(cache_dir).ok();
                std::fs::write(&cache_path, &bytes)
                    .map_err(|e| format!("cache write {}: {e}", cache_path.display()))?;
                let s = std::str::from_utf8(&bytes)
                    .map_err(|e| format!("index.toml UTF-8: {e}"))?;
                return IndexToml::parse(s);
            }
            Err(e) => {
                eprintln!("warning: index fetch from {index_url} failed ({e}); using cache if available");
            }
        }
    }

    // Fall back to cache.
    let content = std::fs::read_to_string(&cache_path)
        .map_err(|e| format!("read cached index {}: {e}", cache_path.display()))?;
    IndexToml::parse(&content)
}
```

**Step 3: Run tests**

Run: `cargo test -p xtask --target aarch64-apple-darwin fetch_index`
Expected: 2 PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/build_deps.rs
git commit -m "feat(build-deps): fetch_index with offline cache fallback"
```

### Task 6.4: Wire `cmd_resolve` to use the index lookup path

**Files:**
- Modify: `tools/xtask/src/build_deps.rs`

**Step 1: Update `cmd_resolve` to load build.toml + fetch index + dispatch**

In the resolver function (the one with the existing `[binary]` block path), replace the existing remote-fetch branch:

```rust
// REPLACES the old `if !force_rebuild && let Some(binary) = target.binary.get(&arch)` block.

if !force_rebuild {
    let build_toml = match load_build_toml(package_dir) {
        Ok(bt) => bt,
        Err(_e) => {
            // No build.toml — fall through to source build.
            // (After migration, every package has a build.toml; this is a defensive path.)
            // eprintln!("warning: no build.toml for {pkg}; falling back to source build");
            return source_build_branch();
        }
    };

    let abi = crate::shared_abi::ABI_VERSION;
    let config = load_wasm_pkg_config(&repo_root)?;
    let index_url = resolve_index_url(&build_toml.binary, config.as_ref(), abi)?;

    match (&build_toml.binary, index_url) {
        (BinarySource::Direct { url, sha256 }, _) => {
            // Form 3 — direct archive URL. No index.
            match remote_fetch::fetch_and_install_direct(
                url,
                sha256,
                &canonical,
                target,
                arch,
                abi_version,
                &cache_key_sha_hex,
            ) {
                Ok(()) => return Ok((canonical, transitive)),
                Err(e) => {
                    eprintln!(
                        "warning: direct fetch for {} from {} failed ({}); falling back to source build",
                        target.spec(), url, e,
                    );
                }
            }
        }
        (_, Some(idx_url)) => {
            // Form 1 or 2 — index lookup.
            let cache_dir = dirs_cache_dir().join("wasm-posix-kernel");
            match fetch_index(&idx_url, &cache_dir) {
                Ok(index) => {
                    if let Some(entry) = index.lookup(&target.name, &target.version, arch) {
                        let entry_to_use = match entry.status {
                            EntryStatus::Success if entry.archive_url.is_some() => entry,
                            EntryStatus::Failed | EntryStatus::Pending | EntryStatus::Building
                                if entry.fallback_archive_url.is_some() => entry,
                            _ => {
                                eprintln!(
                                    "warning: index entry for {} status={:?} with no usable archive; falling back to source build",
                                    target.spec(), entry.status,
                                );
                                return source_build_branch();
                            }
                        };

                        let (url, sha) = if entry_to_use.status == EntryStatus::Success {
                            (entry_to_use.archive_url.as_ref().unwrap().clone(),
                             entry_to_use.archive_sha256.as_ref().unwrap().clone())
                        } else {
                            (entry_to_use.fallback_archive_url.as_ref().unwrap().clone(),
                             entry_to_use.fallback_archive_sha256.as_ref().unwrap().clone())
                        };

                        // Resolve relative URL against the index URL.
                        let abs_url = resolve_relative(&idx_url, &url);

                        match remote_fetch::fetch_and_install_direct(
                            &abs_url, &sha, &canonical, target, arch, abi_version, &cache_key_sha_hex,
                        ) {
                            Ok(()) => return Ok((canonical, transitive)),
                            Err(e) => {
                                eprintln!(
                                    "warning: index-based fetch for {} from {} failed ({}); falling back to source build",
                                    target.spec(), abs_url, e,
                                );
                            }
                        }
                    } else {
                        eprintln!(
                            "warning: no index entry for {} in {}; falling back to source build",
                            target.spec(), idx_url,
                        );
                    }
                }
                Err(e) => {
                    eprintln!(
                        "warning: index fetch from {} failed ({}); falling back to source build",
                        idx_url, e,
                    );
                }
            }
        }
        _ => unreachable!(),
    }
}

// source_build_branch() — same as the existing fallback path below.
```

Refactor as needed to fit the existing code structure. The key invariant is: after this block, either we returned `Ok((canonical, transitive))` from a successful fetch, OR we fell through to the source-build path.

**Step 2: Add `fetch_and_install_direct` to `remote_fetch.rs`**

A variant of the existing `fetch_and_install` that takes URL + sha256 explicitly instead of reading them from a `[binary]` struct. Internally it does the same work: fetch, verify_sha, extract, verify target_arch + abi + cache_key_sha.

**Step 3: Run the test from Task 6.1**

Run: `cargo test -p xtask --target aarch64-apple-darwin resolver_fetches_via_index_lookup`
Expected: PASS.

**Step 4: Run all resolver tests**

Run: `cargo test -p xtask --target aarch64-apple-darwin`
Expected: all tests pass. The existing tests that used `[binary]` in `package.toml` will fail — that's OK; fix them by migrating their test fixtures to the new build.toml + index.toml shape (next task).

**Step 5: Commit**

```bash
git add tools/xtask/src/build_deps.rs tools/xtask/src/remote_fetch.rs
git commit -m "feat(build-deps): index-lookup resolver path with last-green fallback"
```

### Task 6.5: Migrate existing resolver tests to the new schema

**Files:**
- Modify: `tools/xtask/src/build_deps.rs` (the `tests` mod has ~20 tests that build fake package.toml's with `[binary]` blocks)

**Step 1: Run failing tests to enumerate**

Run: `cargo test -p xtask --target aarch64-apple-darwin 2>&1 | grep "FAILED" | head -30`
Expected: a list of test names.

**Step 2: For each failing test, migrate its fixture**

The pattern is: each test builds an in-memory `package.toml` with a `[binary]` block. Change them to:
- `package.toml` without `[binary]`.
- A new `build.toml` in the same temp dir with the binary source declaration.
- A staged `index.toml` (file:// URL) for the resolver to look up.

This is mechanical. Don't change the test's intent; just update the fixture shape.

**Step 3: Run tests until all pass**

Run: `cargo test -p xtask --target aarch64-apple-darwin`
Expected: ALL PASS.

**Step 4: Commit**

```bash
git add tools/xtask/src/build_deps.rs
git commit -m "test(build-deps): migrate resolver tests to build.toml + index.toml fixtures"
```

---

## Phase 7: `index-update` xtask subcommand

### Task 7.1: Add a failing test for `xtask index-update` (success path)

**Files:**
- Create: `tools/xtask/src/index_update.rs`
- Modify: `tools/xtask/src/main.rs` (add `mod index_update;` + dispatch)

**Step 1: Write the test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_update_success_writes_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let idx_path = tmp.path().join("index.toml");
        std::fs::write(&idx_path, IndexToml::empty(8, "t".into(), "test".into()).write()).unwrap();

        let archive_path = tmp.path().join("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst");
        std::fs::write(&archive_path, b"fake archive bytes").unwrap();

        run_index_update(&[
            "--index-path", idx_path.to_str().unwrap(),
            "--package", "foo",
            "--version", "1.0",
            "--revision", "1",
            "--arch", "wasm32",
            "--status", "success",
            "--archive-path", archive_path.to_str().unwrap(),
            "--archive-name", "foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst",
            "--cache-key-sha", "deadbeefcafebabe",
            "--built-at", "2026-05-13T00:00:00Z",
            "--built-by", "https://example.com/run/1",
        ]).unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        let entry = updated.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(entry.archive_url.as_deref(), Some("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst"));
    }
}
```

**Step 2: Run to verify fail (module doesn't exist)**

**Step 3: Commit failing test**

```bash
git add tools/xtask/src/index_update.rs tools/xtask/src/main.rs
git commit -m "test(index-update): success-path writes entry into index.toml"
```

### Task 7.2: Implement `run_index_update`

**Files:**
- Modify: `tools/xtask/src/index_update.rs`, `tools/xtask/src/main.rs`

**Step 1: Implement**

Parse args (file path, package, version, revision, arch, status, archive-path, etc.). Read current `index.toml`. Compute archive sha256 from `archive-path`. Call `index.update_entry_success(...)` or `index.update_entry_failed(...)` depending on `--status`. Write back to `index-path`.

The CLI signature matches the bash wrapper that workflows will use.

**Step 2: Register in `main.rs`**

```rust
"index-update" => index_update::run_index_update(rest),
```

**Step 3: Run the test**

Run: `cargo test -p xtask --target aarch64-apple-darwin index_update`
Expected: PASS.

**Step 4: Add a test for the failed-status path**

```rust
#[test]
fn index_update_failed_moves_existing_success_to_fallback() {
    // Stage an index with an existing success entry, then run with --status failed.
    // Verify the previous URL is now in fallback_archive_url and status is failed.
}
```

Run + pass.

**Step 5: Commit**

```bash
git add tools/xtask/src/index_update.rs tools/xtask/src/main.rs
git commit -m "feat(index-update): xtask subcommand for atomic ledger mutations"
```

---

## Phase 8: Scripts — `scripts/index-update.sh` and `scripts/compose-initial-index.sh`

### Task 8.1: Write `scripts/index-update.sh` (wrapper around lock + download + xtask + upload)

**Files:**
- Create: `scripts/index-update.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/index-update.sh — acquire state-lock, download index.toml from
# release, mutate via `xtask index-update`, upload back, release lock.
#
# Usage (called by per-package matrix-build jobs):
#   bash scripts/index-update.sh \
#     --target-tag binaries-abi-v8 \
#     --package mariadb \
#     --version 10.5.28 \
#     --revision 1 \
#     --arch wasm32 \
#     --status success \
#     --archive-path "$RUNNER_TEMP/staged/mariadb-...-wasm32-abc12345.tar.zst" \
#     --archive-name "mariadb-...-wasm32-abc12345.tar.zst" \
#     --cache-key-sha abc12345...
set -euo pipefail

# Parse args into env vars (simple key=value parser).
# ...

# 1. Acquire lock for target-tag.
bash .github/scripts/state-lock.sh acquire "$TARGET_TAG"
trap 'bash .github/scripts/state-lock.sh release' EXIT

# 2. Download current index.toml (or start empty if it doesn't exist).
INDEX_PATH="$(mktemp)"
if gh release view "$TARGET_TAG" --json assets --jq '.assets[].name' \
     | grep -q '^index\.toml$'; then
  gh release download "$TARGET_TAG" --pattern index.toml --dir "$(dirname "$INDEX_PATH")" --clobber
  mv "$(dirname "$INDEX_PATH")/index.toml" "$INDEX_PATH"
else
  # Bootstrap: empty index.
  cargo run --release -p xtask --target "$(rustc -vV | awk '/^host/ {print $2}')" --quiet -- \
    index-bootstrap --abi "${ABI}" --out "$INDEX_PATH"
fi

# 3. Mutate via xtask.
cargo run --release -p xtask --target "$(rustc -vV | awk '/^host/ {print $2}')" --quiet -- \
  index-update \
    --index-path "$INDEX_PATH" \
    --package "$PACKAGE" \
    --version "$VERSION" \
    --revision "$REVISION" \
    --arch "$ARCH" \
    --status "$STATUS" \
    ${ARCHIVE_PATH:+--archive-path "$ARCHIVE_PATH"} \
    ${ARCHIVE_NAME:+--archive-name "$ARCHIVE_NAME"} \
    ${CACHE_KEY_SHA:+--cache-key-sha "$CACHE_KEY_SHA"} \
    ${ERROR:+--error "$ERROR"} \
    --built-at "$(date -u +%FT%TZ)" \
    --built-by "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

# 4. Upload back to release.
gh release upload "$TARGET_TAG" "$INDEX_PATH#index.toml" --clobber --repo "$GITHUB_REPOSITORY"

# 5. Lock released by trap.
```

**Step 2: chmod + smoke test (with mock environment)**

Run: `chmod +x scripts/index-update.sh`
Run: `bash scripts/index-update.sh --help` (add `--help` handler if needed) → confirm script runs.

**Step 3: Commit**

```bash
git add scripts/index-update.sh
git commit -m "feat(index-update): bash wrapper for atomic per-package ledger update"
```

### Task 8.2: Write `scripts/compose-initial-index.sh`

**Files:**
- Create: `scripts/compose-initial-index.sh`

**Step 1: Write the script**

One-shot script for seeding `index.toml` when migrating. Walks the release's existing archives, builds an `index.toml` with `status = success` for each, uploads it.

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET_TAG="${1:?usage: $0 <target-tag>}"
ABI="${2:?usage: $0 <target-tag> <abi>}"

# Download every existing archive into a temp dir.
TMP="$(mktemp -d)"
gh release download "$TARGET_TAG" --pattern '*.tar.zst' --dir "$TMP" --clobber

# Use existing xtask build-index command (we'll adapt it slightly to emit the new schema in Task 5).
cargo run --release -p xtask --target "$(rustc -vV | awk '/^host/ {print $2}')" --quiet -- \
  build-index \
    --abi "$ABI" \
    --generator "compose-initial-index @ $(git rev-parse HEAD)" \
    --archives-dir "$TMP" \
    --out "$TMP/index.toml" \
    --generated-at "$(date -u +%FT%TZ)"

# Upload the new index.
gh release upload "$TARGET_TAG" "$TMP/index.toml" --clobber

echo "compose-initial-index: seeded $TARGET_TAG with $(grep -c '^\[\[packages\]\]' "$TMP/index.toml") entries"
```

**Step 2: chmod + commit**

```bash
chmod +x scripts/compose-initial-index.sh
git add scripts/compose-initial-index.sh
git commit -m "feat(compose-initial-index): one-shot script to seed index.toml from release archives"
```

### Task 8.3: Update `xtask build-index` to emit the new schema

**Files:**
- Modify: `tools/xtask/src/build_index.rs`

**Step 1: Add a test for the new schema**

```rust
#[test]
fn build_index_emits_status_success_for_present_archives() {
    let tmp = tempfile::tempdir().unwrap();
    // Stage one fake archive with the right filename convention.
    let archive = tmp.path().join("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst");
    // Build a minimal valid wasm-posix archive (with a compat manifest inside).
    let bytes = crate::remote_fetch::build_test_archive("foo", "1.0", 1, 8, TargetArch::Wasm32, "deadbeef");
    std::fs::write(&archive, &bytes).unwrap();

    let out = tmp.path().join("index.toml");
    run(vec![
        "--abi".into(), "8".into(),
        "--generator".into(), "test".into(),
        "--archives-dir".into(), tmp.path().to_str().unwrap().into(),
        "--out".into(), out.to_str().unwrap().into(),
        "--generated-at".into(), "2026-05-13T00:00:00Z".into(),
    ]).unwrap();

    let content = std::fs::read_to_string(&out).unwrap();
    assert!(content.contains("status = \"success\""), "got:\n{content}");
    assert!(content.contains("cache_key_sha"), "got:\n{content}");
}
```

**Step 2: Update `build_index.rs::run` to emit `status`, `cache_key_sha`, `built_at`, `built_by` per arch entry**

Refactor `BinaryEntry` writes to include the new fields.

**Step 3: Run the test**

Run: `cargo test -p xtask --target aarch64-apple-darwin build_index_emits_status`
Expected: PASS.

**Step 4: Run all build_index tests + ensure existing tests still pass (or are updated)**

Run: `cargo test -p xtask --target aarch64-apple-darwin build_index`
Expected: all PASS.

**Step 5: Commit**

```bash
git add tools/xtask/src/build_index.rs
git commit -m "feat(build-index): emit new index.toml schema with status + cache_key_sha"
```

---

## Phase 9: Migration data

### Task 9.1: Create `.wasm-posix-pkg.toml`

**Files:**
- Create: `.wasm-posix-pkg.toml`

**Step 1: Write the file**

```toml
# .wasm-posix-pkg.toml — named source definitions for build.toml [binary] source = "..."
# See docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md §3.3.

[sources.first-party]
index_url = "https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v{abi}/index.toml"
```

**Step 2: Commit**

```bash
git add .wasm-posix-pkg.toml
git commit -m "feat(packages): add .wasm-posix-pkg.toml with first-party source"
```

### Task 9.2: Write the bulk migration script

**Files:**
- Create: `scripts/migrate-package-tomls.sh` (one-shot; can be deleted after this PR lands)

**Step 1: Write the script**

For each `packages/registry/<pkg>/package.toml`:

1. Parse the existing `package.toml` to extract `[build].script_path`, `[build].repo_url`, `[build].commit`.
2. Use `xtask` (add a `migrate-package-toml` subcommand, OR do it with `sed`/`awk` inline) to:
   - Remove `revision = ...`
   - Remove the entire `[binary.*]` block(s)
   - Remove `[build].repo_url` and `[build].commit` (keep `script_path`)
3. Write a new `build.toml` in the same directory containing:
   - `script_path = "<from old package.toml>"`
   - `repo_url    = "<from old package.toml, or upstream default>"`
   - `commit      = "<current main HEAD at PR creation time>"`
   - `[binary]\nsource = "first-party"\n`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HEAD_COMMIT="${MIGRATION_COMMIT:-$(git rev-parse HEAD)}"

for ptoml in packages/registry/*/package.toml; do
  pkg_dir="$(dirname "$ptoml")"
  pkg=$(basename "$pkg_dir")
  echo "migrating $pkg..."

  # Extract [build] fields from old package.toml.
  script_path=$(awk '/^\[build\]/,/^\[/' "$ptoml" | grep '^script_path' | sed 's/.*= *"\(.*\)".*/\1/')
  repo_url=$(awk '/^\[build\]/,/^\[/' "$ptoml" | grep '^repo_url' | sed 's/.*= *"\(.*\)".*/\1/')

  # Default repo_url if missing.
  repo_url="${repo_url:-https://github.com/wasm-posix-kernel/wasm-posix-kernel.git}"

  # Write build.toml.
  cat > "$pkg_dir/build.toml" <<EOF
script_path = "${script_path}"
repo_url    = "${repo_url}"
commit      = "${HEAD_COMMIT}"

[binary]
source = "first-party"
EOF

  # Strip [binary.*], revision, [build].repo_url, [build].commit from package.toml.
  python3 - "$ptoml" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
# Drop revision line.
text = re.sub(r'^revision\s*=.*\n', '', text, flags=re.MULTILINE)
# Drop entire [binary.*] blocks (and bare [binary]).
text = re.sub(r'^\[binary(\.[^\]]+)?\][^\[]*', '', text, flags=re.MULTILINE)
# In [build] block, drop repo_url and commit.
def strip_build(m):
    inner = m.group(2)
    inner = re.sub(r'^repo_url\s*=.*\n', '', inner, flags=re.MULTILINE)
    inner = re.sub(r'^commit\s*=.*\n', '', inner, flags=re.MULTILINE)
    return m.group(1) + inner
text = re.sub(r'(\[build\]\n)((?:[^\[]|\n)*)', strip_build, text, count=1)
with open(path, 'w') as f:
    f.write(text)
PY
done

echo "migrated $(ls packages/registry/*/build.toml | wc -l) package(s)"
```

**Step 2: Run on a copy of one package first**

```bash
# Test on a single package to verify script behavior.
cp -r packages/registry/bash /tmp/bash-test
(cd /tmp/bash-test && bash $REPO_ROOT/scripts/migrate-package-tomls.sh)
# Inspect output: cat /tmp/bash-test/package.toml /tmp/bash-test/build.toml
```

**Step 3: When the script is correct, run on the real tree**

Run: `MIGRATION_COMMIT=$(git rev-parse HEAD) bash scripts/migrate-package-tomls.sh`

**Step 4: Verify with xtask**

Run: `cargo test -p xtask --target aarch64-apple-darwin pkg_manifest`
Expected: all parser tests pass.

For each migrated package, the xtask parser should accept the new `package.toml` and `build.toml` cleanly.

**Step 5: Commit**

```bash
git add packages/registry/*/package.toml packages/registry/*/build.toml scripts/migrate-package-tomls.sh
git commit -m "chore(packages): migrate 53 package.toml + add build.toml siblings

Stripped [binary] blocks, revision, [build].repo_url, [build].commit
from package.toml. Created build.toml for each, declaring [binary]
source = \"first-party\".

Migration script preserved at scripts/migrate-package-tomls.sh for
future reference; safe to delete after this PR lands."
```

### Task 9.3: Compose and upload the initial `binaries-abi-v8/index.toml`

**Files:**
- One-shot operation (no files committed).

**Step 1: Run the compose script**

Run: `bash scripts/compose-initial-index.sh binaries-abi-v8 8`

**Step 2: Verify with curl**

Run: `curl -L https://github.com/brandonpayton/wasm-posix-kernel/releases/download/binaries-abi-v8/index.toml | head -30`
Expected: index.toml with the new schema, listing the current 68 archives.

**Step 3: Verify resolver can use it**

Run: `rm -rf ~/.cache/wasm-posix-kernel && bash scripts/fetch-binaries.sh`
Expected: `resolved=63 total=63 skipped=6, 0 failures`.

Diagnose any failures before proceeding. The most likely issues:
- Resolver can't find a package in the index (a `name`/`version` mismatch between `package.toml` and the archive filename).
- Cache_key_sha verification failure (the archive's internal cache_key doesn't match what the resolver computes — indicates a mismatch between the migrated `package.toml` and the published archive's recipe).

**Step 4: (No commit needed — this is a release-side operation.)**

---

## Phase 10: Workflow updates

### Task 10.1: Update `prepare-merge.yml`

**Files:**
- Modify: `.github/workflows/prepare-merge.yml`

**Step 1: Remove the `publish` job's archive-upload step from the separate job**

The new matrix-build does upload + index-update inline. Delete the standalone `publish` job entirely.

**Step 2: Remove `generate-index`, `amend-package-toml` jobs**

Delete in their entirety.

**Step 3: Update `matrix-build` to include the per-job atomic flow**

Add steps per the design §5.1:
1. Build archive (already exists).
2. Acquire state-lock with subject = target_tag.
3. Upload archive to release.
4. Update index.toml entry via `scripts/index-update.sh`.
5. Release state-lock.
6. On failure: record `--status failed` with error info (also serialized through lock).

**Step 4: Update `merge-gate-finalize` to post merge-gate on the original PR HEAD**

There's no bot PR anymore. Post the status directly on `pull_request.head.sha`. Rename to `merge-gate-post` or fold into `merge-gate-empty-matrix`.

**Step 5: Run YAML lint**

Run: `yamllint .github/workflows/prepare-merge.yml` (or any local validator).
Expected: no errors.

**Step 6: Commit**

```bash
git add .github/workflows/prepare-merge.yml
git commit -m "refactor(prepare-merge): per-matrix-job atomic publish + index update"
```

### Task 10.2: Update `staging-build.yml`

**Files:**
- Modify: `.github/workflows/staging-build.yml`

Same shape as Task 10.1: fold publish + generate-index into matrix-build per-job; serialize via state-lock with subject = pr-`<N>`-staging (per-PR staging tag → different lock subject → no contention with durable-release runs).

**Step 1: Apply changes**

**Step 2: Lint**

**Step 3: Commit**

```bash
git add .github/workflows/staging-build.yml
git commit -m "refactor(staging-build): per-matrix-job atomic publish + index update"
```

### Task 10.3: Update `force-rebuild.yml`

Same shape.

**Commit:**

```bash
git commit -m "refactor(force-rebuild): per-matrix-job atomic publish + index update"
```

### Task 10.4: Delete `check-package-toml-tags.sh`

**Files:**
- Delete: `scripts/check-package-toml-tags.sh`
- Modify: `.github/workflows/prepare-merge.yml` (remove the invocations from Task 10.1 if they're still present — should already be gone from the merge-gate-empty-matrix and merge-gate-finalize changes)

**Step 1: Confirm no remaining references**

Run: `grep -rn "check-package-toml-tags" .github/ scripts/`
Expected: zero hits.

**Step 2: Delete**

Run: `git rm scripts/check-package-toml-tags.sh`

**Step 3: Commit**

```bash
git commit -m "chore: remove check-package-toml-tags.sh (no URLs in package.toml to drift)"
```

---

## Phase 11: Documentation

### Task 11.1: Update `docs/architecture.md`

**Files:**
- Modify: `docs/architecture.md`

**Step 1: Find the package-management section**

Run: `grep -n "package.toml\|binary\[" docs/architecture.md | head -20`

**Step 2: Update the description**

Mention:
- package.toml = recipe; build.toml = project view + binary source.
- index.toml = ledger at the release; single source of truth for resolution.
- Resolver flow: load build.toml → fetch index → look up → fetch archive.

**Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): describe index-ledger binary resolution"
```

### Task 11.2: Mark §3.1 of the original design doc as superseded

**Files:**
- Modify: `docs/plans/2026-05-05-decoupled-package-builds-design.md`

**Step 1: Add a note at the top of §3.1**

> **Note (2026-05-13):** This section's "kept duplication for resolver-fetches-with-package.toml-alone" trade-off is superseded by `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md`. The dual-storage design caused four bugs in two weeks (#454, #455, #456, #439 fallout); the revised design removes `archive_url`/`archive_sha256` from `package.toml` and makes `index.toml` the source of truth.

**Step 2: Commit**

```bash
git add docs/plans/2026-05-05-decoupled-package-builds-design.md
git commit -m "docs(plans): mark §3.1 of decoupled-package-builds-design as superseded"
```

---

## Phase 12: Final verification

### Task 12.1: Run all five test suites from CLAUDE.md

**Step 1: Cargo tests**

Run: `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
Expected: 539+ tests, 0 failures.

**Step 2: Vitest**

Run: `cd host && npx vitest run`
Expected: all PASS (PHP tests skip if binary not built; that's OK).

**Step 3: libc-test**

Run: `scripts/run-libc-tests.sh`
Expected: 0 unexpected failures.

**Step 4: Open POSIX**

Run: `scripts/run-posix-tests.sh`
Expected: 0 FAIL.

**Step 5: ABI snapshot**

Run: `bash scripts/check-abi-version.sh`
Expected: exit 0.

If anything fails, diagnose and fix before proceeding.

### Task 12.2: Clean-fetch verification

**Step 1: Wipe cache**

Run: `rm -rf ~/.cache/wasm-posix-kernel`

**Step 2: Run fetch-binaries**

Run: `bash scripts/fetch-binaries.sh`
Expected: `resolved=63 total=63 skipped=6, 0 failures`.

If failures, diagnose:
- Index lookup miss: `index.toml` on release doesn't have entry → check Task 9.3's seeding.
- Archive fetch failure: URL malformed → check resolver's `resolve_relative` logic.
- Cache_key mismatch: archive's internal cache_key ≠ locally computed → check `build_deps`'s cache_key computation.

### Task 12.3: Browser demo verification

**Step 1: Build**

Run: `./run.sh clean all && bash scripts/build-musl.sh && bash build.sh`

**Step 2: Launch browser**

Run: `./run.sh browser`

**Step 3: Manually verify in browser**

- Open WordPress demo. Confirm `install.php` renders.
- Confirm PHP, MariaDB, nginx all boot.
- Confirm dinit `[OK]` output for all services.

If anything is broken, diagnose. Most likely cause: a package's `package.toml`/`build.toml` migration introduced a parsing error or wrong `source` reference.

### Task 12.4: Confirm everything is committed and pushed

**Step 1: Status**

Run: `git status`
Expected: clean.

**Step 2: Push**

Run: `git push -u origin design/binary-resolution-via-index-ledger`

**Step 3: Update PR #457 to include the implementation**

Either:
- Push to the existing design PR branch (turns design PR into design+implementation PR).
- Open a new PR for implementation only.

Decide based on review preferences. If design has already been reviewed and approved, opening a separate implementation PR is cleaner. If design is still being reviewed, combining is fine.

---

## Open follow-ups / future work

These are explicitly NOT in this plan but should be tracked for after merge:

- Index update batching for huge repos (design §7).
- Multi-source resolution fallback (design §7).
- Index cache TTL warnings (design §7).
- Package signing (design §7).
- `wasm-posix-pkg` CLI tooling (separate effort).
- Migrate `force-rebuild.yml` to use the new state-lock subject naming consistently (Task 1.3 partially does this; full rename to `state-lock.sh` should land in the same commit as the workflow updates).

---

## Plan exit criteria

The implementation is complete and ready to merge when:

- All 12 phases' tasks committed.
- `git status` clean.
- Five-suite test check passes (Task 12.1).
- Clean-fetch test passes (Task 12.2).
- Browser demo verified manually (Task 12.3).
- PR #457 (or its implementation successor) is ready for review.

---

## Notes for the implementer

- **Use the `superpowers:executing-plans` skill** to work through this task-by-task. Don't batch multiple tasks unless they're trivially related (e.g., a fix for a typo you spot while doing the previous task).
- **The order matters.** Phase 2-7 builds the new path. Phase 9 migrates data. Phase 10 swaps workflows. If you skip ahead to Phase 9 before the resolver works, you'll have a broken tree with no way to test.
- **TDD throughout.** Every code change has a test that demonstrates the change is correct. Run the test before AND after writing the implementation; you should see FAIL→PASS.
- **Commit after every passing test.** This plan's history is the audit trail; keep commits small and topical.
- **If something is unclear in the design doc, stop and re-read it.** The design doc was written carefully via brainstorming; the answers are usually there.
- **CLAUDE.md test verification.** Tasks 12.1-12.3 are the verification gate. Do not claim the implementation is complete without running all of them.
