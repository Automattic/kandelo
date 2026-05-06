//! Publish-time writeback into `examples/libs/<name>/package.toml`.
//!
//! Phase A-bis Task 5: when CI publishes a fresh `[binary].archive_url`
//! + `archive_sha256` for a package, it also stamps `[build].commit`
//! with the SHA of the building commit. This module owns the in-place
//! TOML edit so the logic is unit-testable and shared by any future
//! caller (workflow YAML, helper shell scripts, ad-hoc maintainer
//! tooling).
//!
//! Scope is intentionally narrow:
//!   * Only `[build].commit` is touched here. The existing
//!     `[binary.<arch>]` writeback path (today: manual via
//!     `scripts/backfill-binary-blocks.sh`; Phase C: per-package CI
//!     amend) lives elsewhere — extending that path with a parallel
//!     binary-fields update belongs in Phase B/C, not here.
//!   * If the manifest has no `[build]` block (third-party packages,
//!     or first-party packages with no build script — kernel,
//!     userspace, examples, node, sqlite-cli, pcre2-source), the
//!     writeback is a silent no-op. We never *create* a `[build]`
//!     block; that would change the manifest's shape and is a
//!     maintainer-only operation.
//!
//! The writeback uses `toml_edit::DocumentMut` (not the value-only
//! `toml` parser) so comments and layout in the on-disk file survive
//! round-trip. Idempotent by construction: the second invocation with
//! the same SHA produces a byte-identical file; with a different SHA
//! the value is overwritten in place.

use std::fs;
use std::path::{Path, PathBuf};

use toml_edit::{value, DocumentMut, Item};

/// Set `[build].commit = "<commit_sha>"` in the package.toml at
/// `toml_path`, preserving the rest of the file's formatting.
///
/// Returns `Ok(true)` if the file was rewritten (a `[build]` block
/// existed and the commit field was set or updated), `Ok(false)` if
/// no `[build]` block was present (silent skip — see module docs).
///
/// Idempotency: if the existing `[build].commit` already equals
/// `commit_sha`, the file is left untouched (no rewrite, no mtime
/// bump) and the function still returns `Ok(true)`.
pub fn set_build_commit(toml_path: &Path, commit_sha: &str) -> Result<bool, String> {
    if commit_sha.is_empty() {
        return Err("commit_sha must not be empty".into());
    }
    // Lightweight sanity: full hex SHAs are 40 chars; reject anything
    // that's clearly not a SHA so we don't silently stamp a tag name
    // or "HEAD" into the file. We do not enforce length 40 because
    // future SCMs (or shorter dev-mode SHAs) might legitimately use a
    // different shape; reject only obvious garbage (whitespace, etc).
    if commit_sha.chars().any(|c| c.is_whitespace()) {
        return Err(format!(
            "commit_sha {commit_sha:?} contains whitespace"
        ));
    }

    let text = fs::read_to_string(toml_path)
        .map_err(|e| format!("read {}: {e}", toml_path.display()))?;
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("parse {}: {e}", toml_path.display()))?;

    let build = match doc.get_mut("build") {
        Some(b) => b,
        None => return Ok(false),
    };
    let build_table = match build.as_table_like_mut() {
        Some(t) => t,
        None => {
            return Err(format!(
                "{}: [build] is not a table (got {:?})",
                toml_path.display(),
                build.type_name()
            ))
        }
    };

    // Idempotency: if the value is already correct, don't rewrite.
    if let Some(existing) = build_table.get("commit").and_then(Item::as_str) {
        if existing == commit_sha {
            return Ok(true);
        }
    }

    build_table.insert("commit", value(commit_sha));

    fs::write(toml_path, doc.to_string())
        .map_err(|e| format!("write {}: {e}", toml_path.display()))?;
    Ok(true)
}

/// CLI entry point: `xtask set-build-commit --package-toml <path> --commit <sha>`.
///
/// Wired from `main.rs`. The expected caller is a CI step (or a
/// helper shell script) that has both the manifest path and the
/// building commit SHA in scope. Plumbing the SHA via a CLI flag
/// (rather than calling `git rev-parse HEAD` inside this code) keeps
/// the function pure and testable, and matches how
/// `${{ github.sha }}` flows through the rest of our workflows.
pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut toml_path: Option<PathBuf> = None;
    let mut commit: Option<String> = None;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--package-toml" => {
                toml_path = Some(
                    it.next()
                        .ok_or("--package-toml requires path")?
                        .into(),
                )
            }
            "--commit" => {
                commit = Some(it.next().ok_or("--commit requires <sha>")?)
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let toml_path = toml_path.ok_or("--package-toml is required")?;
    let commit = commit.ok_or("--commit is required")?;

    let wrote = set_build_commit(&toml_path, &commit)?;
    if wrote {
        println!("set [build].commit = {} in {}", commit, toml_path.display());
    } else {
        println!(
            "skipped {} (no [build] block — third-party or no build script)",
            toml_path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tempdir(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "wpk-update-pkg-{label}-{nanos}-{n}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Fixture: a first-party library with a [build] block but no commit yet.
    /// Mirrors the post-Task-4 backfilled shape.
    const FIXTURE_WITH_BUILD: &str = r#"# Per-library manifest
kind = "library"
name = "zlib"
version = "1.3.1"
revision = 1
depends_on = []
arches = ["wasm32", "wasm64"]

[source]
url = "https://example.com/zlib-1.3.1.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Zlib"

[build]
script_path = "examples/libs/zlib/build-zlib.sh"
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"

[outputs]
libs = ["lib/libz.a"]
headers = ["include/zlib.h"]

[binary.wasm32]
archive_url = "https://example.com/zlib-wasm32.tar.zst"
archive_sha256 = "1111111111111111111111111111111111111111111111111111111111111111"
"#;

    /// Fixture: a source-only or no-build-script package — no [build] block.
    /// Mirrors the 6 first-party packages that Task 4 deliberately left alone.
    const FIXTURE_WITHOUT_BUILD: &str = r#"kind = "source"
name = "pcre2-source"
version = "10.45"
revision = 1
depends_on = []

[source]
url = "https://example.com/pcre2-10.45.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[outputs]
libs = []
headers = []
"#;

    #[test]
    fn writes_commit_when_build_block_present() {
        let dir = tempdir("write");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_WITH_BUILD).unwrap();

        let sha = "abcdef1234567890abcdef1234567890abcdef12";
        let wrote = set_build_commit(&path, sha).unwrap();
        assert!(wrote, "writeback should report wrote=true for [build] case");

        let after = fs::read_to_string(&path).unwrap();
        // Parse with the strict pkg_manifest parser to confirm the
        // edit is structurally valid (not just a substring match).
        let doc: toml::Value = toml::from_str(&after).unwrap();
        let commit = doc
            .get("build")
            .and_then(|v| v.get("commit"))
            .and_then(|v| v.as_str())
            .expect("[build].commit must be present after writeback");
        assert_eq!(commit, sha);

        // Surrounding fields must survive (formatting + co-tenants).
        assert!(after.contains("script_path = \"examples/libs/zlib/build-zlib.sh\""));
        assert!(after.contains("repo_url    = \"https://github.com/wasm-posix-kernel/wasm-posix-kernel.git\""));
        assert!(after.contains("[binary.wasm32]"));
    }

    #[test]
    fn skips_silently_when_build_block_absent() {
        let dir = tempdir("skip");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_WITHOUT_BUILD).unwrap();

        let wrote = set_build_commit(&path, "deadbeef").unwrap();
        assert!(!wrote, "writeback must report wrote=false for no-[build] case");

        // File must be byte-identical — we never create a [build] block.
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(after, FIXTURE_WITHOUT_BUILD);
        // Defensive: parser must not see a [build] block.
        let doc: toml::Value = toml::from_str(&after).unwrap();
        assert!(
            doc.get("build").is_none(),
            "writeback must not synthesize a [build] block"
        );
    }

    #[test]
    fn overwrites_existing_commit_on_rebase() {
        // A subsequent publish (e.g. after a force-push) must replace
        // the prior SHA, not append a duplicate or fail.
        let dir = tempdir("overwrite");
        let path = dir.join("package.toml");
        // Use a recognizable stale SHA that does NOT collide with
        // any other field in FIXTURE_WITH_BUILD (the source.sha256
        // placeholder is all-zeros, so we can't use that).
        let stale_sha = "1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let seeded = String::from(FIXTURE_WITH_BUILD).replace(
            "repo_url    = \"https://github.com/wasm-posix-kernel/wasm-posix-kernel.git\"",
            &format!(
                "repo_url    = \"https://github.com/wasm-posix-kernel/wasm-posix-kernel.git\"\ncommit      = \"{stale_sha}\"",
            ),
        );
        fs::write(&path, &seeded).unwrap();

        let new_sha = "fedcba9876543210fedcba9876543210fedcba98";
        let wrote = set_build_commit(&path, new_sha).unwrap();
        assert!(wrote);

        let after = fs::read_to_string(&path).unwrap();
        let doc: toml::Value = toml::from_str(&after).unwrap();
        let commit = doc
            .get("build")
            .and_then(|v| v.get("commit"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(commit, new_sha, "stale SHA must be overwritten");
        // Stale SHA must not survive anywhere in the file.
        assert!(
            !after.contains(stale_sha),
            "old commit must not linger after overwrite"
        );
    }

    #[test]
    fn idempotent_no_op_when_commit_already_matches() {
        // Same SHA called twice must not perturb the file — neither
        // contents nor mtime.
        let dir = tempdir("idempotent");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_WITH_BUILD).unwrap();

        let sha = "abcdef1234567890abcdef1234567890abcdef12";
        set_build_commit(&path, sha).unwrap();
        let after_first = fs::read_to_string(&path).unwrap();

        // Second invocation with the same SHA: result must be byte-identical.
        let wrote = set_build_commit(&path, sha).unwrap();
        assert!(wrote, "second call still reports wrote=true (block present)");
        let after_second = fs::read_to_string(&path).unwrap();
        assert_eq!(after_first, after_second);
    }

    #[test]
    fn rejects_empty_commit() {
        let dir = tempdir("empty");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_WITH_BUILD).unwrap();
        let err = set_build_commit(&path, "").unwrap_err();
        assert!(err.contains("must not be empty"), "got error: {err}");
    }

    #[test]
    fn rejects_whitespace_in_commit() {
        let dir = tempdir("ws");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_WITH_BUILD).unwrap();
        let err = set_build_commit(&path, "abc def").unwrap_err();
        assert!(err.contains("whitespace"), "got error: {err}");
    }
}
