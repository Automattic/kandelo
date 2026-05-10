//! Publish-time writeback into `examples/libs/<name>/package.toml`.
//!
//! Two writeback paths live here:
//!
//!   * `set_build_commit` (Phase A-bis Task 5): stamps `[build].commit`
//!     with the SHA of the building commit when an archive is
//!     published. If the manifest has no `[build]` block (third-party
//!     packages, or first-party packages without a build script —
//!     kernel, userspace, examples, node, sqlite-cli, pcre2-source),
//!     the writeback is a silent no-op. We never *create* a `[build]`
//!     block; that would change the manifest's shape and is a
//!     maintainer-only operation.
//!
//!   * `set_package_binary` (Phase C Task 4): updates the
//!     `[binary.<arch>]` (multi-arch) or `[binary]` (single-arch)
//!     block's `archive_url` + `archive_sha256` fields when the
//!     per-package matrix-build flow uploads a fresh archive to the
//!     durable release. Used by the `amend-package-toml` job in
//!     `.github/workflows/prepare-merge.yml` to rewrite the in-tree
//!     `package.toml` for each rebuilt (package, arch) so consumers
//!     resolve the new URL after the bot PR merges.
//!
//! The writeback uses `toml_edit::DocumentMut` (not the value-only
//! `toml` parser) so comments and layout in the on-disk file survive
//! round-trip. Idempotent by construction: the second invocation with
//! the same inputs produces a byte-identical file; with different
//! inputs the values are overwritten in place.

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

/// Set `[binary.<arch>].archive_url` + `archive_sha256` (per-arch
/// shape) or `[binary].archive_url` + `archive_sha256` (bare shape) in
/// the package.toml at `toml_path`.
///
/// Shape selection mirrors the resolver
/// (`pkg_manifest.rs::parse_binary_block`): we look at the existing
/// `[binary]` block's structure, NOT at the manifest's `arches` field.
///
///   * If `[binary]` has `archive_url` (scalar) at the top → bare
///     shape. The resolver always interprets this as wasm32-only, so
///     we accept ONLY `arch = "wasm32"` here. A bare-shape package
///     that wants a wasm64 archive must first declare
///     `[binary.wasm64]` in the manifest by hand (a maintainer
///     decision, not the bot's).
///   * If `[binary]` has `wasm32` / `wasm64` sub-tables → per-arch
///     shape. We update the requested sub-table in place; other
///     arches are left untouched.
///   * If `[binary]` is missing entirely (the package has never
///     published before) → fall back to `arches`: present and
///     non-empty → per-arch, otherwise bare. This is the only case
///     where `arches` participates in shape selection, because there's
///     no existing `[binary]` to inspect.
///
/// Mixed shapes (a `[binary]` block with both top-level scalars and
/// arch sub-tables) are rejected — the resolver rejects them too, and
/// the disagreement is for the maintainer to resolve.
///
/// Returns `Ok(())` on success. Errors include: file I/O, TOML parse
/// errors, a malformed existing `[binary]` block (set to a scalar
/// instead of a table), a mixed-shape `[binary]`, or `--arch wasm64`
/// against a bare-shape `[binary]`.
///
/// Idempotency: if the existing fields already match the supplied
/// values, the file is rewritten with byte-identical contents (see
/// `toml_edit`'s formatting-preserving guarantees). Calling twice is a
/// no-op for the consumer.
pub fn set_package_binary(
    toml_path: &Path,
    arch: &str,
    archive_url: &str,
    archive_sha256: &str,
) -> Result<(), String> {
    if archive_url.is_empty() {
        return Err("archive_url must not be empty".into());
    }
    if archive_sha256.len() != 64
        || !archive_sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    {
        return Err(format!(
            "archive_sha256 must be 64-char lowercase hex, got {archive_sha256:?}"
        ));
    }
    if archive_url.chars().any(|c| c.is_whitespace()) {
        return Err(format!("archive_url {archive_url:?} contains whitespace"));
    }
    if !matches!(arch, "wasm32" | "wasm64") {
        return Err(format!("arch must be wasm32 or wasm64, got {arch:?}"));
    }

    let text = fs::read_to_string(toml_path)
        .map_err(|e| format!("read {}: {e}", toml_path.display()))?;
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("parse {}: {e}", toml_path.display()))?;

    // Detect shape from the existing [binary] block's structure
    // (matching the resolver in pkg_manifest.rs::parse_binary_block).
    // When [binary] is missing entirely we fall back to `arches` —
    // that's the only case where `arches` informs shape, because
    // there's no existing block to inspect.
    let shape = detect_binary_shape(&doc, toml_path)?;

    match shape {
        BinaryShape::PerArch => {
            // Ensure or create [binary] as a table, then
            // [binary.<arch>] as a sub-table. We must keep any other
            // arch's sub-table intact.
            if doc.get("binary").is_none() {
                doc["binary"] = Item::Table(toml_edit::Table::new());
            }
            let binary_type = doc
                .get("binary")
                .map(Item::type_name)
                .unwrap_or("missing");
            let binary = doc
                .get_mut("binary")
                .and_then(|i| i.as_table_mut())
                .ok_or_else(|| {
                    format!(
                        "{}: [binary] is not a table (got {})",
                        toml_path.display(),
                        binary_type
                    )
                })?;

            if binary.get(arch).is_none() {
                let mut sub = toml_edit::Table::new();
                sub.set_implicit(false);
                binary.insert(arch, Item::Table(sub));
            }
            let entry = binary
                .get_mut(arch)
                .and_then(|i| i.as_table_mut())
                .ok_or_else(|| {
                    format!(
                        "{}: [binary.{}] is not a table",
                        toml_path.display(),
                        arch
                    )
                })?;
            entry.set_implicit(false);
            entry.insert("archive_url", value(archive_url));
            entry.insert("archive_sha256", value(archive_sha256));
        }
        BinaryShape::Bare => {
            // C3 fix: a bare [binary] block is wasm32-only by resolver
            // convention. Refuse to silently write a wasm64 archive
            // into a slot that downstream consumers will hand to
            // wasm32 processes.
            if arch != "wasm32" {
                return Err(format!(
                    "{}: package has bare [binary] (wasm32-only); cannot write \
                     wasm64 archive into it. Either declare [binary.wasm64] in the \
                     manifest first, or fix the matrix to not target wasm64 for \
                     this package.",
                    toml_path.display()
                ));
            }
            if doc.get("binary").is_none() {
                doc["binary"] = Item::Table(toml_edit::Table::new());
            }
            let binary = doc
                .get_mut("binary")
                .and_then(|i| i.as_table_mut())
                .ok_or_else(|| {
                    format!("{}: [binary] is not a table", toml_path.display())
                })?;
            binary.set_implicit(false);
            binary.insert("archive_url", value(archive_url));
            binary.insert("archive_sha256", value(archive_sha256));
        }
    }

    fs::write(toml_path, doc.to_string())
        .map_err(|e| format!("write {}: {e}", toml_path.display()))?;
    Ok(())
}

/// Shape of an existing (or to-be-created) `[binary]` block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BinaryShape {
    /// `[binary.wasm32]` / `[binary.wasm64]` sub-tables.
    PerArch,
    /// Top-level `archive_url` + `archive_sha256` scalars (wasm32-only).
    Bare,
}

/// Decide the shape of the package.toml's `[binary]` block.
///
/// Mirrors `pkg_manifest.rs::parse_binary_block`'s detection: when
/// `[binary]` exists, its OWN structure decides the shape (a top-level
/// `archive_url` → bare; arch sub-tables → per-arch). When `[binary]`
/// is missing, we fall back to `arches` (present + non-empty →
/// per-arch, otherwise bare).
///
/// Mixed-shape `[binary]` blocks (top-level scalars next to arch
/// sub-tables) are rejected with the same error the resolver emits.
fn detect_binary_shape(
    doc: &DocumentMut,
    toml_path: &Path,
) -> Result<BinaryShape, String> {
    if let Some(existing) = doc.get("binary") {
        let table = existing.as_table().ok_or_else(|| {
            format!(
                "{}: [binary] is not a table (got {})",
                toml_path.display(),
                existing.type_name()
            )
        })?;
        let has_bare = table.contains_key("archive_url")
            || table.contains_key("archive_sha256");
        let has_per_arch =
            table.contains_key("wasm32") || table.contains_key("wasm64");
        if has_bare && has_per_arch {
            return Err(format!(
                "{}: [binary] mixes the bare form (archive_url at the top) with \
                 per-arch sub-tables ([binary.wasm32] / [binary.wasm64]). \
                 Pick one shape.",
                toml_path.display()
            ));
        }
        if has_per_arch {
            return Ok(BinaryShape::PerArch);
        }
        if has_bare {
            return Ok(BinaryShape::Bare);
        }
        // [binary] exists but is empty (a maintainer placeholder).
        // Fall through to the `arches`-based heuristic below.
    }

    // No existing [binary] (or empty): use `arches` as the tiebreaker.
    let multi_arch = doc
        .get("arches")
        .and_then(|i| i.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if multi_arch {
        Ok(BinaryShape::PerArch)
    } else {
        Ok(BinaryShape::Bare)
    }
}

/// CLI entry point: `xtask set-package-binary --package-toml <path>
/// --arch <wasm32|wasm64> --archive-url <url> --archive-sha256 <hex>`.
pub fn run_set_package_binary(args: Vec<String>) -> Result<(), String> {
    let mut toml_path: Option<PathBuf> = None;
    let mut arch: Option<String> = None;
    let mut archive_url: Option<String> = None;
    let mut archive_sha256: Option<String> = None;

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
            "--arch" => {
                arch = Some(it.next().ok_or("--arch requires <wasm32|wasm64>")?)
            }
            "--archive-url" => {
                archive_url = Some(it.next().ok_or("--archive-url requires <url>")?)
            }
            "--archive-sha256" => {
                archive_sha256 =
                    Some(it.next().ok_or("--archive-sha256 requires <hex>")?)
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let toml_path = toml_path.ok_or("--package-toml is required")?;
    let arch = arch.ok_or("--arch is required")?;
    let archive_url = archive_url.ok_or("--archive-url is required")?;
    let archive_sha256 = archive_sha256.ok_or("--archive-sha256 is required")?;

    set_package_binary(&toml_path, &arch, &archive_url, &archive_sha256)?;
    let shape_label = match shape_of_disk(&toml_path)? {
        BinaryShape::PerArch => format!(".{arch}"),
        BinaryShape::Bare => String::new(),
    };
    println!(
        "set [binary{}] in {} (sha {})",
        shape_label,
        toml_path.display(),
        &archive_sha256[..8]
    );
    Ok(())
}

/// Re-detect the on-disk shape of `[binary]` for the post-write log
/// line. The writer itself runs its own probe inline; this exists
/// only to keep the log message accurate.
fn shape_of_disk(toml_path: &Path) -> Result<BinaryShape, String> {
    let text = fs::read_to_string(toml_path)
        .map_err(|e| format!("read {}: {e}", toml_path.display()))?;
    let doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("parse {}: {e}", toml_path.display()))?;
    detect_binary_shape(&doc, toml_path)
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

    // Multi-arch fixture: declares `arches = [...]` so the writeback
    // hits the `[binary.<arch>]` sub-table path.
    const FIXTURE_MULTI_ARCH: &str = r#"kind = "program"
name = "mariadb"
version = "10.5.28"
revision = 1
kernel_abi = 7
depends_on = []
arches = ["wasm32", "wasm64"]

[source]
url = "https://example.com/mariadb-10.5.28.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "GPL-2.0-only"

[build]
script_path = "examples/libs/mariadb/build-mariadb.sh"
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"

[[outputs]]
name = "mariadbd"
wasm = "mariadbd.wasm"

[binary.wasm32]
archive_url = "https://example.com/old-wasm32.tar.zst"
archive_sha256 = "1111111111111111111111111111111111111111111111111111111111111111"

[binary.wasm64]
archive_url = "https://example.com/old-wasm64.tar.zst"
archive_sha256 = "2222222222222222222222222222222222222222222222222222222222222222"
"#;

    // Single-arch fixture: no `arches = [...]` field, so the writeback
    // hits the bare `[binary]` block. Mirrors examples/libs/dinit/.
    const FIXTURE_SINGLE_ARCH: &str = r#"kind = "program"
name = "dinit"
version = "0.19.4"
revision = 1
kernel_abi = 7
depends_on = []

[source]
url = "https://example.com/dinit-0.19.4.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Apache-2.0"

[build]
script_path = "examples/libs/dinit/build-dinit.sh"
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"

[[outputs]]
name = "dinit"
wasm = "dinit.wasm"

[binary]
archive_url = "https://example.com/old-dinit.tar.zst"
archive_sha256 = "3333333333333333333333333333333333333333333333333333333333333333"
"#;

    const NEW_URL_32: &str =
        "https://github.com/example/wasm-posix-kernel/releases/download/binaries-abi-v7/mariadb-10.5.28-rev1-abi7-wasm32-deadbeef.tar.zst";
    const NEW_SHA_32: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NEW_URL_64: &str =
        "https://github.com/example/wasm-posix-kernel/releases/download/binaries-abi-v7/mariadb-10.5.28-rev1-abi7-wasm64-cafef00d.tar.zst";
    const NEW_SHA_64: &str =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn updates_one_arch_in_multi_arch_block() {
        let dir = tempdir("multi-one");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_MULTI_ARCH).unwrap();

        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        let after = fs::read_to_string(&path).unwrap();

        let doc: toml::Value = toml::from_str(&after).unwrap();
        let bin = doc.get("binary").unwrap();
        // wasm32 reflects the new values.
        let w32 = bin.get("wasm32").unwrap();
        assert_eq!(
            w32.get("archive_url").and_then(|v| v.as_str()),
            Some(NEW_URL_32)
        );
        assert_eq!(
            w32.get("archive_sha256").and_then(|v| v.as_str()),
            Some(NEW_SHA_32)
        );
        // wasm64 is untouched.
        let w64 = bin.get("wasm64").unwrap();
        assert_eq!(
            w64.get("archive_url").and_then(|v| v.as_str()),
            Some("https://example.com/old-wasm64.tar.zst")
        );
        assert_eq!(
            w64.get("archive_sha256").and_then(|v| v.as_str()),
            Some("2222222222222222222222222222222222222222222222222222222222222222")
        );
    }

    #[test]
    fn updates_both_arches_independently() {
        // Two writes; each should land in its own sub-table without
        // perturbing the other.
        let dir = tempdir("multi-both");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_MULTI_ARCH).unwrap();

        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        set_package_binary(&path, "wasm64", NEW_URL_64, NEW_SHA_64).unwrap();

        let after = fs::read_to_string(&path).unwrap();
        let doc: toml::Value = toml::from_str(&after).unwrap();
        let bin = doc.get("binary").unwrap();
        assert_eq!(
            bin.get("wasm32")
                .and_then(|t| t.get("archive_url"))
                .and_then(|v| v.as_str()),
            Some(NEW_URL_32)
        );
        assert_eq!(
            bin.get("wasm32")
                .and_then(|t| t.get("archive_sha256"))
                .and_then(|v| v.as_str()),
            Some(NEW_SHA_32)
        );
        assert_eq!(
            bin.get("wasm64")
                .and_then(|t| t.get("archive_url"))
                .and_then(|v| v.as_str()),
            Some(NEW_URL_64)
        );
        assert_eq!(
            bin.get("wasm64")
                .and_then(|t| t.get("archive_sha256"))
                .and_then(|v| v.as_str()),
            Some(NEW_SHA_64)
        );
    }

    #[test]
    fn updates_single_arch_bare_binary_block() {
        let dir = tempdir("single");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_SINGLE_ARCH).unwrap();

        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        let after = fs::read_to_string(&path).unwrap();

        let doc: toml::Value = toml::from_str(&after).unwrap();
        let bin = doc.get("binary").unwrap();
        // The bare scalars must remain scalars (not get nested under
        // [binary.wasm32]).
        assert_eq!(
            bin.get("archive_url").and_then(|v| v.as_str()),
            Some(NEW_URL_32)
        );
        assert_eq!(
            bin.get("archive_sha256").and_then(|v| v.as_str()),
            Some(NEW_SHA_32)
        );
        // No accidental sub-tables introduced.
        assert!(
            bin.get("wasm32").is_none(),
            "single-arch shape must not introduce [binary.wasm32]"
        );
        assert!(
            bin.get("wasm64").is_none(),
            "single-arch shape must not introduce [binary.wasm64]"
        );
    }

    #[test]
    fn idempotent_when_values_already_match() {
        let dir = tempdir("multi-idempotent");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_MULTI_ARCH).unwrap();

        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        let first = fs::read_to_string(&path).unwrap();
        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        let second = fs::read_to_string(&path).unwrap();
        assert_eq!(first, second, "second call must produce identical bytes");
    }

    #[test]
    fn rejects_bad_sha() {
        let dir = tempdir("bad-sha");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_MULTI_ARCH).unwrap();
        // Wrong length.
        let err = set_package_binary(&path, "wasm32", NEW_URL_32, "abc").unwrap_err();
        assert!(err.contains("64-char"), "got: {err}");
        // Uppercase rejected.
        let err = set_package_binary(
            &path,
            "wasm32",
            NEW_URL_32,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .unwrap_err();
        assert!(err.contains("64-char"), "got: {err}");
    }

    #[test]
    fn rejects_bad_arch() {
        let dir = tempdir("bad-arch");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_MULTI_ARCH).unwrap();
        let err =
            set_package_binary(&path, "x86_64", NEW_URL_32, NEW_SHA_32).unwrap_err();
        assert!(err.contains("wasm32 or wasm64"), "got: {err}");
    }

    #[test]
    fn rejects_empty_url() {
        let dir = tempdir("empty-url");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_MULTI_ARCH).unwrap();
        let err =
            set_package_binary(&path, "wasm32", "", NEW_SHA_32).unwrap_err();
        assert!(err.contains("must not be empty"), "got: {err}");
    }

    // C2 fix: shape detection is driven by [binary]'s structure, not
    // by the manifest's `arches` field. The two fixtures below exercise
    // the disagreement cases that the old `arches`-driven detector got
    // wrong.

    /// Fixture: declares `arches = ["wasm32", "wasm64"]` but [binary]
    /// is bare. The OLD detector would route this through the
    /// per-arch path and reject the scalar archive_url under [binary]
    /// as "scalar in multi-arch" — blocking the amend. The NEW
    /// detector treats the [binary] block's shape as authoritative
    /// and writes through the bare path.
    const FIXTURE_ARCHES_DECLARED_BUT_BARE: &str = r#"kind = "program"
name = "weird"
version = "1.0"
revision = 1
kernel_abi = 7
depends_on = []
arches = ["wasm32", "wasm64"]

[source]
url = "https://example.com/weird-1.0.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[build]
script_path = "examples/libs/weird/build.sh"

[[outputs]]
name = "weird"
wasm = "weird.wasm"

[binary]
archive_url = "https://example.com/old.tar.zst"
archive_sha256 = "4444444444444444444444444444444444444444444444444444444444444444"
"#;

    /// Fixture: declares `arches = ["wasm32"]` (single-arch, explicit)
    /// alongside a bare [binary]. The OLD detector would route this
    /// through the per-arch path because `arches` was present;
    /// the NEW detector reads the bare [binary] and stays bare.
    const FIXTURE_ARCHES_SINGLE_BUT_BARE: &str = r#"kind = "program"
name = "single-explicit"
version = "1.0"
revision = 1
kernel_abi = 7
depends_on = []
arches = ["wasm32"]

[source]
url = "https://example.com/se-1.0.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[build]
script_path = "examples/libs/se/build.sh"

[[outputs]]
name = "se"
wasm = "se.wasm"

[binary]
archive_url = "https://example.com/se-old.tar.zst"
archive_sha256 = "5555555555555555555555555555555555555555555555555555555555555555"
"#;

    /// Fixture: NO `arches` field, but `[binary]` already has per-arch
    /// sub-tables. The OLD detector would treat this as bare-shape
    /// because `arches` was absent and reject the per-arch
    /// sub-tables as "mixed shape". The NEW detector reads `[binary]`
    /// directly and routes through the per-arch path.
    const FIXTURE_NO_ARCHES_PER_ARCH_BINARY: &str = r#"kind = "program"
name = "implicit-multi"
version = "1.0"
revision = 1
kernel_abi = 7
depends_on = []

[source]
url = "https://example.com/im-1.0.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[build]
script_path = "examples/libs/im/build.sh"

[[outputs]]
name = "im"
wasm = "im.wasm"

[binary.wasm32]
archive_url = "https://example.com/im-wasm32-old.tar.zst"
archive_sha256 = "6666666666666666666666666666666666666666666666666666666666666666"

[binary.wasm64]
archive_url = "https://example.com/im-wasm64-old.tar.zst"
archive_sha256 = "7777777777777777777777777777777777777777777777777777777777777777"
"#;

    #[test]
    fn shape_from_bare_binary_overrides_arches_present() {
        // C2: `arches = [...]` declared, but [binary] is bare. We must
        // honour [binary]'s shape (bare) and accept the wasm32 write.
        let dir = tempdir("shape-bare-with-arches");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_ARCHES_DECLARED_BUT_BARE).unwrap();

        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        let after = fs::read_to_string(&path).unwrap();

        let doc: toml::Value = toml::from_str(&after).unwrap();
        let bin = doc.get("binary").unwrap();
        // Bare scalars stayed bare — no [binary.wasm32] sub-table
        // sneaked in.
        assert_eq!(
            bin.get("archive_url").and_then(|v| v.as_str()),
            Some(NEW_URL_32)
        );
        assert_eq!(
            bin.get("archive_sha256").and_then(|v| v.as_str()),
            Some(NEW_SHA_32)
        );
        assert!(
            bin.get("wasm32").is_none(),
            "bare-shape [binary] must not grow a [binary.wasm32] sub-table"
        );
    }

    #[test]
    fn shape_from_bare_binary_with_single_arches_entry() {
        // C2 variant: `arches = ["wasm32"]` (single-arch, explicit) +
        // bare [binary]. Old detector wrongly routed through per-arch.
        let dir = tempdir("shape-single-explicit");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_ARCHES_SINGLE_BUT_BARE).unwrap();

        set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32).unwrap();
        let after = fs::read_to_string(&path).unwrap();

        let doc: toml::Value = toml::from_str(&after).unwrap();
        let bin = doc.get("binary").unwrap();
        assert_eq!(
            bin.get("archive_url").and_then(|v| v.as_str()),
            Some(NEW_URL_32)
        );
        assert!(
            bin.get("wasm32").is_none(),
            "single-arch [binary] must stay bare even when `arches = [\"wasm32\"]`"
        );
    }

    #[test]
    fn shape_from_per_arch_binary_overrides_arches_absent() {
        // C2 reverse: no `arches` field, but [binary.wasm32] /
        // [binary.wasm64] sub-tables exist. Honour the [binary] shape
        // (per-arch).
        let dir = tempdir("shape-per-arch-no-arches");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_NO_ARCHES_PER_ARCH_BINARY).unwrap();

        set_package_binary(&path, "wasm64", NEW_URL_64, NEW_SHA_64).unwrap();
        let after = fs::read_to_string(&path).unwrap();

        let doc: toml::Value = toml::from_str(&after).unwrap();
        let bin = doc.get("binary").unwrap();
        // wasm64 sub-table updated.
        assert_eq!(
            bin.get("wasm64")
                .and_then(|t| t.get("archive_url"))
                .and_then(|v| v.as_str()),
            Some(NEW_URL_64)
        );
        // wasm32 sub-table preserved.
        assert_eq!(
            bin.get("wasm32")
                .and_then(|t| t.get("archive_url"))
                .and_then(|v| v.as_str()),
            Some("https://example.com/im-wasm32-old.tar.zst")
        );
        // Bare scalars must not have been grafted onto [binary].
        assert!(bin.get("archive_url").is_none());
    }

    #[test]
    fn rejects_wasm64_against_bare_binary() {
        // C3: `--arch wasm64` against a bare [binary] (which the
        // resolver treats as wasm32-only) must be rejected loudly,
        // not silently overwrite the wasm32 slot.
        let dir = tempdir("c3-bare-wasm64");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_SINGLE_ARCH).unwrap();

        let err = set_package_binary(&path, "wasm64", NEW_URL_64, NEW_SHA_64)
            .unwrap_err();
        assert!(
            err.contains("bare [binary]") && err.contains("wasm64"),
            "C3 error message should mention bare/wasm64; got: {err}"
        );

        // The file must be UNCHANGED — no silent corruption of the
        // wasm32 slot.
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(after, FIXTURE_SINGLE_ARCH);
    }

    #[test]
    fn rejects_wasm64_against_bare_binary_even_when_arches_present() {
        // C2 + C3 combined: `arches = ["wasm32", "wasm64"]` declared
        // but [binary] is bare. Old detector would have used the
        // per-arch path for wasm64 (which would be a different bug).
        // New detector sees bare and rejects wasm64.
        let dir = tempdir("c2-c3-bare-with-arches");
        let path = dir.join("package.toml");
        fs::write(&path, FIXTURE_ARCHES_DECLARED_BUT_BARE).unwrap();

        let err = set_package_binary(&path, "wasm64", NEW_URL_64, NEW_SHA_64)
            .unwrap_err();
        assert!(
            err.contains("bare [binary]"),
            "expected bare-shape rejection; got: {err}"
        );
    }

    #[test]
    fn rejects_mixed_shape_binary() {
        // Defensive: a [binary] block that mixes scalars and arch
        // sub-tables is a maintainer error. We must not silently
        // pick a side.
        let mixed = r#"kind = "program"
name = "mixed"
version = "1.0"
revision = 1
kernel_abi = 7
depends_on = []

[source]
url = "https://example.com/m.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[build]
script_path = "examples/libs/m/build.sh"

[[outputs]]
name = "m"
wasm = "m.wasm"

[binary]
archive_url = "https://example.com/old.tar.zst"
archive_sha256 = "8888888888888888888888888888888888888888888888888888888888888888"

[binary.wasm64]
archive_url = "https://example.com/old-w64.tar.zst"
archive_sha256 = "9999999999999999999999999999999999999999999999999999999999999999"
"#;
        let dir = tempdir("mixed");
        let path = dir.join("package.toml");
        fs::write(&path, mixed).unwrap();

        let err = set_package_binary(&path, "wasm32", NEW_URL_32, NEW_SHA_32)
            .unwrap_err();
        assert!(
            err.contains("mixes the bare form")
                || err.contains("mix"),
            "expected mixed-shape rejection; got: {err}"
        );
    }
}
