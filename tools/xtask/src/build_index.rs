//! `xtask build-index` — emit `index.toml` from a directory of
//! `.tar.zst` archives.
//!
//! Post binary-resolution-via-index-ledger (design §3.4),
//! `index.toml` is the per-release ledger of build state for every
//! package. Each per-arch entry carries `status`, `archive_url`,
//! `archive_sha256`, `cache_key_sha`, `built_at`, `built_by` —
//! enough for the resolver to fetch + verify against the same
//! recipe inputs that produced the archive.
//!
//! This subcommand is the one-shot seed path used by
//! `scripts/compose-initial-index.sh` when migrating a release from
//! the legacy schema to the new ledger. Day-to-day publishes during
//! CI matrix builds go through `scripts/index-update.sh` +
//! `xtask index-update` (per-package atomic updates under the
//! state-lock), not this command.
//!
//! Filename convention (must match what `archive-stage` writes):
//! `<name>-<version>-rev<N>-abi<N>-<arch>-<short8>.tar.zst`.
//!
//! The seed flow extracts each archive's internal `manifest.toml`
//! to recover `cache_key_sha` + `build_timestamp` (from the
//! `[compatibility]` block) and stamps them into the per-entry
//! fields the resolver requires.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::index_toml::IndexToml;
use crate::pkg_manifest::TargetArch;
use crate::util::hex;

/// Parsed CLI args.
struct Args {
    abi: u32,
    generator: String,
    archives_dir: PathBuf,
    out: PathBuf,
    /// Pinned `generated_at` value. CI passes the commit author timestamp
    /// (same provenance the matrix-build step used) so re-runs produce
    /// byte-identical `index.toml`. Omitted in interactive use → falls
    /// back to wall-clock UTC.
    generated_at: Option<String>,
}

/// Components extracted from an archive filename.
#[derive(Clone, Debug)]
struct ParsedArchive {
    /// Package name (`mariadb`).
    name: String,
    /// Upstream version (`10.5.27`).
    version: String,
    /// Recipe revision (`1`). Same package + version + revision in two
    /// arches must agree on `version`/`name`/`revision`; we don't carry
    /// `revision` into `index.toml` because the consumer keys on
    /// (name, arch, sha) — but we validate consistency below as a
    /// defense against accidentally publishing two archives that claim
    /// the same `(name, arch)` from different recipe revisions.
    revision: u32,
    /// ABI generation embedded in the filename. Cross-checked against
    /// `--abi` so a mistakenly-mixed batch (e.g. abi5 + abi6 archives
    /// in the same dir) fails loud rather than silently producing an
    /// incoherent manifest.
    abi: u32,
    arch: TargetArch,
    /// 8-char hex slot from the filename (cache_key_sha prefix). Not
    /// emitted into index.toml — included here so error messages can
    /// reference the specific archive that failed validation.
    short_sha: String,
    /// Bare filename (relative archive_url). Mirror-friendly per the
    /// design doc's URL semantics: a self-contained source directory
    /// (manifest + archives) is bit-identically mirrorable to any
    /// other host.
    filename: String,
}

/// CLI entry point.
///
/// Required flags (order-independent, both `--flag value` and
/// `--flag=value` accepted):
///   --abi          <u32>     Cross-checked against each archive's
///                            `abi<N>` filename slot; mismatch → error.
///   --generator    <string>  Free-form provenance line, e.g.
///                            `"kandelo CI @ <sha>"`.
///   --archives-dir <dir>     Directory holding the `.tar.zst` archives.
///   --out          <path>    Where to write `index.toml`.
///
/// Optional:
///   --generated-at <RFC3339> Pin the `generated_at` field for byte
///                            determinism (commit author timestamp in CI).
///                            Default: current UTC at run time.
pub fn run(args: Vec<String>) -> Result<(), String> {
    let parsed = parse_args(args)?;
    let entries = collect_archives(&parsed.archives_dir, parsed.abi)?;
    let generated_at = parsed.generated_at.clone().unwrap_or_else(current_utc_iso);

    // Build an IndexToml using the same `update_entry_success` path
    // the per-matrix-job CLI uses — guarantees the seeded ledger is
    // byte-shape-identical to one produced incrementally.
    let mut idx = IndexToml::empty(parsed.abi, generated_at.clone(), parsed.generator.clone());

    // Track each package's (version, revision) so we can detect
    // cross-arch divergence (same package@different revision in two
    // arches is a real bug worth surfacing).
    let mut pkg_revision: BTreeMap<String, u32> = BTreeMap::new();
    let mut pkg_version: BTreeMap<String, String> = BTreeMap::new();

    for (parsed_archive, archive_sha_hex, meta) in entries {
        if let Some(prev) = pkg_version.get(&parsed_archive.name) {
            if prev != &parsed_archive.version {
                return Err(format!(
                    "package {:?}: archive {:?} declares version {:?}, but a sibling \
                     arch already declared {:?} — every arch of a package must agree on version",
                    parsed_archive.name, parsed_archive.filename, parsed_archive.version, prev,
                ));
            }
        } else {
            pkg_version.insert(parsed_archive.name.clone(), parsed_archive.version.clone());
        }
        if let Some(prev) = pkg_revision.get(&parsed_archive.name) {
            if prev != &parsed_archive.revision {
                return Err(format!(
                    "package {:?}: archive {:?} declares revision {}, but a sibling \
                     arch already declared revision {} — every arch must agree on revision",
                    parsed_archive.name, parsed_archive.filename, parsed_archive.revision, prev,
                ));
            }
        } else {
            pkg_revision.insert(parsed_archive.name.clone(), parsed_archive.revision);
        }

        idx.update_entry_success(
            &parsed_archive.name,
            &parsed_archive.version,
            parsed_archive.revision,
            parsed_archive.arch,
            parsed_archive.filename.clone(),
            archive_sha_hex,
            meta.cache_key_sha,
            meta.build_timestamp.unwrap_or_else(|| generated_at.clone()),
            parsed.generator.clone(),
        );
    }

    if let Some(parent) = parsed.out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(&parsed.out, idx.write())
        .map_err(|e| format!("write {}: {e}", parsed.out.display()))?;
    Ok(())
}

/// Metadata extracted from a `.tar.zst`'s internal `manifest.toml`'s
/// `[compatibility]` block. The fields are recipe-stable (the same
/// archive produces the same metadata across decompressions), so
/// re-running `build-index` over the same archives produces a
/// byte-identical `index.toml`.
struct ArchiveMetadata {
    cache_key_sha: String,
    /// `compatibility.build_timestamp` if the archive recorded one
    /// (Phase A-bis onward). Older archives may have None; the
    /// caller falls back to `generated_at` so the entry still has
    /// a `built_at` value.
    build_timestamp: Option<String>,
}

/// Decompress + un-tar an archive in memory, find the
/// `manifest.toml` entry, parse it through
/// `DepsManifest::parse_archived`, and return the
/// `[compatibility]` fields the ledger needs.
fn read_archive_metadata(bytes: &[u8]) -> Result<ArchiveMetadata, String> {
    let decoder =
        zstd::stream::read::Decoder::new(bytes).map_err(|e| format!("zstd decode: {e}"))?;
    let mut tar = tar::Archive::new(decoder);
    let entries = tar.entries().map_err(|e| format!("tar entries: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar entry path: {e}"))?
            .into_owned();
        if path.as_os_str() == "manifest.toml" {
            let mut text = String::new();
            use std::io::Read;
            entry
                .read_to_string(&mut text)
                .map_err(|e| format!("read manifest.toml: {e}"))?;
            let archived = crate::pkg_manifest::DepsManifest::parse_archived(
                &text,
                std::path::PathBuf::from("/dev/null"),
            )?;
            let compat = archived
                .compatibility
                .as_ref()
                .ok_or_else(|| "archived manifest missing [compatibility]".to_string())?;
            return Ok(ArchiveMetadata {
                cache_key_sha: compat.cache_key_sha.clone(),
                build_timestamp: compat.build_timestamp.clone(),
            });
        }
    }
    Err("archive missing manifest.toml at the root".into())
}

/// Walk `archives_dir` for `*.tar.zst` files, parse each filename, and
/// compute its sha256. Returns the parsed entries paired with their
/// computed `archive_sha256`. Sorted by (name, arch) for deterministic
/// output downstream.
fn collect_archives(
    archives_dir: &Path,
    expected_abi: u32,
) -> Result<Vec<(ParsedArchive, String, ArchiveMetadata)>, String> {
    if !archives_dir.is_dir() {
        return Err(format!(
            "archives-dir {} is not a directory or does not exist",
            archives_dir.display()
        ));
    }
    let mut out: Vec<(ParsedArchive, String, ArchiveMetadata)> = Vec::new();
    for dirent in fs::read_dir(archives_dir)
        .map_err(|e| format!("read_dir {}: {e}", archives_dir.display()))?
    {
        let dirent = dirent.map_err(|e| format!("read_dir entry: {e}"))?;
        let path = dirent.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if !name.ends_with(".tar.zst") {
            continue;
        }
        let parsed = parse_archive_filename(&name)?;
        if parsed.abi != expected_abi {
            return Err(format!(
                "archive {name}: filename declares abi{} but --abi is {}",
                parsed.abi, expected_abi
            ));
        }
        let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let sha = hex(&Into::<[u8; 32]>::into(hasher.finalize()));
        let meta = read_archive_metadata(&bytes).map_err(|e| {
            format!(
                "archive {name}: {e}. The seed flow needs each .tar.zst's internal \
                 manifest.toml to recover cache_key_sha + build_timestamp."
            )
        })?;
        out.push((parsed, sha, meta));
    }
    // Deterministic enumeration order: by (name, arch). Same set of
    // archives → same index.toml regardless of dirent traversal order.
    out.sort_by(|a, b| {
        a.0.name
            .cmp(&b.0.name)
            .then_with(|| a.0.arch.as_str().cmp(b.0.arch.as_str()))
    });
    Ok(out)
}

/// Parse `<name>-<version>-rev<N>-abi<N>-<arch>-<short8>.tar.zst`.
/// Lenient on `<name>` and `<version>` (each can contain `-`); rigorous
/// on the trailing 4 segments which have a fixed shape.
fn parse_archive_filename(name: &str) -> Result<ParsedArchive, String> {
    let stem = name
        .strip_suffix(".tar.zst")
        .ok_or_else(|| format!("filename {name:?} does not have .tar.zst suffix"))?;
    let parts: Vec<&str> = stem.split('-').collect();
    // Need at least: name, version, rev<N>, abi<N>, arch, short → 6 parts.
    if parts.len() < 6 {
        return Err(format!(
            "filename {name:?} has too few `-`-separated segments (need at least \
             6: <name>-<version>-rev<N>-abi<N>-<arch>-<short8>)"
        ));
    }
    let short = *parts.last().unwrap();
    if !is_short_sha(short) {
        return Err(format!(
            "filename {name:?}: trailing segment {short:?} must be 8 lowercase hex chars"
        ));
    }
    let arch_seg = parts[parts.len() - 2];
    let arch = match arch_seg {
        "wasm32" => TargetArch::Wasm32,
        "wasm64" => TargetArch::Wasm64,
        other => {
            return Err(format!(
                "filename {name:?}: arch segment {other:?} must be wasm32 or wasm64"
            ));
        }
    };
    let abi_seg = parts[parts.len() - 3];
    let abi: u32 = abi_seg
        .strip_prefix("abi")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            format!("filename {name:?}: 3rd-from-last segment {abi_seg:?} must be `abi<N>`")
        })?;
    let rev_seg = parts[parts.len() - 4];
    let revision: u32 = rev_seg
        .strip_prefix("rev")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            format!("filename {name:?}: 4th-from-last segment {rev_seg:?} must be `rev<N>`")
        })?;
    // Everything before rev<N> is `<name>-<version>`. Find the boundary:
    // version starts at the segment immediately after the package name's
    // last segment. We can't tell where `<name>` ends and `<version>`
    // begins by looking at the string alone (both can contain `-`); we
    // adopt the convention that the LAST `-` before `rev<N>` separates
    // them. That matches every package in the registry today
    // (mariadb-10.5.27, php-8.4.5, ncurses-6.5, ...).
    let pre_rev = &parts[..parts.len() - 4];
    if pre_rev.len() < 2 {
        return Err(format!(
            "filename {name:?}: need at least one segment each for <name> and <version> \
             before rev{revision}"
        ));
    }
    let version = pre_rev[pre_rev.len() - 1].to_string();
    let pkg_name = pre_rev[..pre_rev.len() - 1].join("-");
    if pkg_name.is_empty() {
        return Err(format!("filename {name:?}: empty package name"));
    }
    if version.is_empty() {
        return Err(format!("filename {name:?}: empty version"));
    }
    Ok(ParsedArchive {
        name: pkg_name,
        version,
        revision,
        abi,
        arch,
        short_sha: short.to_string(),
        filename: name.to_string(),
    })
}

fn is_short_sha(s: &str) -> bool {
    s.len() == 8
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Hand-rolled CLI parser. Mirrors the shape of `archive_stage_cli`'s
/// parser for consistency.
fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut abi: Option<u32> = None;
    let mut generator: Option<String> = None;
    let mut archives_dir: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut generated_at: Option<String> = None;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let take_value =
            |it: &mut std::vec::IntoIter<String>, name: &str| -> Result<String, String> {
                it.next().ok_or_else(|| format!("{name} requires a value"))
            };
        if let Some(v) = a.strip_prefix("--abi=") {
            assign_once(
                &mut abi,
                v.parse().map_err(|e| format!("--abi: {e}"))?,
                "--abi",
            )?;
        } else if a == "--abi" {
            let v = take_value(&mut it, "--abi")?;
            assign_once(
                &mut abi,
                v.parse().map_err(|e| format!("--abi: {e}"))?,
                "--abi",
            )?;
        } else if let Some(v) = a.strip_prefix("--generator=") {
            assign_once(&mut generator, v.to_string(), "--generator")?;
        } else if a == "--generator" {
            assign_once(
                &mut generator,
                take_value(&mut it, "--generator")?,
                "--generator",
            )?;
        } else if let Some(v) = a.strip_prefix("--archives-dir=") {
            assign_once(&mut archives_dir, PathBuf::from(v), "--archives-dir")?;
        } else if a == "--archives-dir" {
            assign_once(
                &mut archives_dir,
                PathBuf::from(take_value(&mut it, "--archives-dir")?),
                "--archives-dir",
            )?;
        } else if let Some(v) = a.strip_prefix("--out=") {
            assign_once(&mut out, PathBuf::from(v), "--out")?;
        } else if a == "--out" {
            assign_once(
                &mut out,
                PathBuf::from(take_value(&mut it, "--out")?),
                "--out",
            )?;
        } else if let Some(v) = a.strip_prefix("--generated-at=") {
            assign_once(&mut generated_at, v.to_string(), "--generated-at")?;
        } else if a == "--generated-at" {
            assign_once(
                &mut generated_at,
                take_value(&mut it, "--generated-at")?,
                "--generated-at",
            )?;
        } else {
            return Err(format!("unexpected argument {a:?}"));
        }
    }

    let abi = abi.ok_or("build-index: --abi <u32> is required")?;
    let generator = generator.ok_or("build-index: --generator <string> is required")?;
    let archives_dir = archives_dir.ok_or("build-index: --archives-dir <dir> is required")?;
    let out = out.ok_or("build-index: --out <path> is required")?;
    Ok(Args {
        abi,
        generator,
        archives_dir,
        out,
        generated_at,
    })
}

fn assign_once<T>(slot: &mut Option<T>, value: T, name: &str) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("{name} given more than once"));
    }
    *slot = Some(value);
    Ok(())
}

// Hand-rolled RFC3339 formatter for the default `generated_at` in
// `index.toml`. Avoids pulling `chrono` into xtask for a single
// timestamp.
fn current_utc_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let mut day = secs.div_euclid(86_400);
    let mut year: i64 = 1970;
    loop {
        let len = if is_leap(year) { 366 } else { 365 };
        if day < len {
            break;
        }
        day -= len;
        year += 1;
    }
    let mut month: i64 = 1;
    while day >= days_in_month(month, year) {
        day -= days_in_month(month, year);
        month += 1;
    }
    let day = day + 1;
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(m: i64, y: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-build-index")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Build a real .tar.zst archive matching `name@version-rev@abi-arch`
    /// with a manifest.toml carrying [compatibility]. Returns the
    /// path. The internal manifest content is shaped to satisfy
    /// `read_archive_metadata` (DepsManifest::parse_archived).
    fn write_real_archive(
        dir: &Path,
        name: &str,
        version: &str,
        rev: u32,
        abi: u32,
        arch: &str,
        short: &str,
        cache_key_sha: &str,
    ) -> PathBuf {
        let manifest_text = format!(
            r#"
kind = "library"
name = "{name}"
version = "{version}"
revision = {rev}
depends_on = []

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[outputs]
libs = ["lib/out.a"]

[compatibility]
target_arch = "{arch}"
abi_versions = [{abi}]
cache_key_sha = "{cache_key_sha}"
build_timestamp = "2026-05-05T12:34:56Z"
"#
        );
        let bytes =
            crate::remote_fetch::build_test_archive(&manifest_text, &[("lib/out.a", b"PAYLOAD")]);
        let fname = format!("{name}-{version}-rev{rev}-abi{abi}-{arch}-{short}.tar.zst");
        let path = dir.join(&fname);
        fs::write(&path, &bytes).unwrap();
        path
    }

    fn read_index(out_path: &Path) -> String {
        fs::read_to_string(out_path).unwrap()
    }

    /// Smoke: 2 packages × 2 arches → all 4 entries with status=success,
    /// cache_key_sha + built_at + built_by populated.
    #[test]
    fn smoke_two_packages_two_arches() {
        let dir = tempdir("smoke");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        write_real_archive(
            &archives,
            "alpha",
            "1.0.0",
            1,
            6,
            "wasm32",
            "11111111",
            &"a".repeat(64),
        );
        write_real_archive(
            &archives,
            "alpha",
            "1.0.0",
            1,
            6,
            "wasm64",
            "22222222",
            &"b".repeat(64),
        );
        write_real_archive(
            &archives,
            "beta",
            "2.0.0",
            1,
            6,
            "wasm32",
            "33333333",
            &"c".repeat(64),
        );
        write_real_archive(
            &archives,
            "beta",
            "2.0.0",
            1,
            6,
            "wasm64",
            "44444444",
            &"d".repeat(64),
        );

        super::run(vec![
            "--abi".into(),
            "6".into(),
            "--generator".into(),
            "kandelo CI @ deadbeef".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
            "--generated-at".into(),
            "2026-05-05T12:34:56Z".into(),
        ])
        .unwrap();

        let text = read_index(&out);
        // Header (IndexToml::write() uses single-space `key = value`).
        assert!(text.contains("abi_version = 6"), "got:\n{text}");
        assert!(
            text.contains("generated_at = \"2026-05-05T12:34:56Z\""),
            "got:\n{text}"
        );
        assert!(
            text.contains("generator = \"kandelo CI @ deadbeef\""),
            "got:\n{text}"
        );
        // Both packages present, alphabetical order.
        let alpha_idx = text.find("name = \"alpha\"").expect("alpha header missing");
        let beta_idx = text.find("name = \"beta\"").expect("beta header missing");
        assert!(
            alpha_idx < beta_idx,
            "alpha must precede beta, got:\n{text}"
        );
        // Each package has both arches.
        assert_eq!(text.matches("[packages.binary.wasm32]").count(), 2);
        assert_eq!(text.matches("[packages.binary.wasm64]").count(), 2);
        // status + relative archive_url + cache_key_sha + built_*.
        assert_eq!(text.matches("status = \"success\"").count(), 4);
        assert!(
            text.contains("archive_url = \"alpha-1.0.0-rev1-abi6-wasm32-11111111.tar.zst\""),
            "got:\n{text}"
        );
        assert!(
            text.contains(&format!("cache_key_sha = \"{}\"", "a".repeat(64))),
            "got:\n{text}"
        );
        assert!(
            text.contains("built_at = \"2026-05-05T12:34:56Z\""),
            "got:\n{text}"
        );
        assert!(
            text.contains("built_by = \"kandelo CI @ deadbeef\""),
            "got:\n{text}"
        );
        // Round-trip through IndexToml::parse confirms it.
        let parsed = crate::index_toml::IndexToml::parse(&text)
            .expect("emitted index.toml must parse via IndexToml");
        assert_eq!(parsed.packages.len(), 2);
    }

    /// Empty input dir → still a valid TOML with no packages.
    #[test]
    fn empty_input_produces_valid_header_only_toml() {
        let dir = tempdir("empty");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        super::run(vec![
            "--abi".into(),
            "6".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
            "--generated-at".into(),
            "2026-05-05T00:00:00Z".into(),
        ])
        .unwrap();

        let text = read_index(&out);
        assert!(text.contains("abi_version = 6"), "got:\n{text}");
        assert!(
            !text.contains("[[packages]]"),
            "no packages expected, got:\n{text}"
        );
        // Round-trip through IndexToml's parser to confirm.
        let _ = crate::index_toml::IndexToml::parse(&text).expect("empty index.toml must parse");
    }

    /// A package present only in wasm32 → only the wasm32 block.
    #[test]
    fn missing_arch_only_emits_present_block() {
        let dir = tempdir("missing-arch");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        write_real_archive(
            &archives,
            "solo",
            "1.0.0",
            1,
            6,
            "wasm32",
            "aaaaaaaa",
            &"e".repeat(64),
        );

        super::run(vec![
            "--abi".into(),
            "6".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
            "--generated-at".into(),
            "2026-05-05T00:00:00Z".into(),
        ])
        .unwrap();

        let text = read_index(&out);
        assert!(text.contains("[packages.binary.wasm32]"), "got:\n{text}");
        assert!(
            !text.contains("[packages.binary.wasm64]"),
            "no wasm64 stub expected, got:\n{text}"
        );
        let idx = crate::index_toml::IndexToml::parse(&text).unwrap();
        assert_eq!(idx.packages.len(), 1);
        let pkg = &idx.packages[0];
        assert!(pkg.binary.contains_key(&TargetArch::Wasm32));
        assert!(!pkg.binary.contains_key(&TargetArch::Wasm64));
    }

    /// Same inputs → byte-identical output. `--generated-at` is the only
    /// non-input-derived value, and we pin it.
    #[test]
    fn determinism_byte_identical_on_repeat_invocation() {
        let dir = tempdir("determinism");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();

        write_real_archive(
            &archives,
            "alpha",
            "1.0.0",
            1,
            6,
            "wasm32",
            "11111111",
            &"a".repeat(64),
        );
        write_real_archive(
            &archives,
            "alpha",
            "1.0.0",
            1,
            6,
            "wasm64",
            "22222222",
            &"b".repeat(64),
        );
        write_real_archive(
            &archives,
            "beta",
            "2.3.4",
            7,
            6,
            "wasm32",
            "33333333",
            &"c".repeat(64),
        );

        let common = |out: PathBuf| {
            super::run(vec![
                "--abi".into(),
                "6".into(),
                "--generator".into(),
                "kandelo CI @ deadbeef".into(),
                "--archives-dir".into(),
                archives.display().to_string(),
                "--out".into(),
                out.display().to_string(),
                "--generated-at".into(),
                "2026-05-05T12:34:56Z".into(),
            ])
            .unwrap();
        };

        let out1 = dir.join("index1.toml");
        let out2 = dir.join("index2.toml");
        common(out1.clone());
        common(out2.clone());

        let bytes1 = fs::read(&out1).unwrap();
        let bytes2 = fs::read(&out2).unwrap();
        assert_eq!(
            bytes1, bytes2,
            "two invocations with identical inputs + pinned generated_at must produce \
             byte-identical index.toml"
        );
    }

    /// Duplicate (name, arch) → error. Catches a mistake where two
    /// archives with the same package + arch but different shas land in
    /// the same dir.
    ///
    /// IndexToml::update_entry_success is idempotent on a single
    /// (name, version, arch) key (the second call overwrites the first),
    /// so an earlier `[binary]`-block writer was the one rejecting
    /// duplicates. We don't reject anymore — the build pipeline ensures
    /// uniqueness via the cache_key_sha-suffixed filename — but we DO
    /// reject when two archives have the same (name, arch) AND
    /// different revisions or versions, because that's a real bug.
    /// Test the divergent-version + divergent-revision paths.
    #[test]
    fn divergent_version_across_arches_is_rejected() {
        let dir = tempdir("divergent-ver");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        write_real_archive(
            &archives,
            "x",
            "1.0.0",
            1,
            6,
            "wasm32",
            "11111111",
            &"a".repeat(64),
        );
        write_real_archive(
            &archives,
            "x",
            "1.0.1",
            1,
            6,
            "wasm64",
            "22222222",
            &"b".repeat(64),
        );

        let err = super::run(vec![
            "--abi".into(),
            "6".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
        ])
        .expect_err("divergent version must error");
        assert!(err.contains("version"), "got: {err}");
    }

    /// `--abi` mismatch with the filename's `abi<N>` slot → error.
    /// The filename-vs-CLI check fires before archive bytes are
    /// touched, so a stub archive's contents are sufficient here.
    #[test]
    fn abi_mismatch_in_filename_is_rejected() {
        let dir = tempdir("abi-mismatch");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        // Real archive so collect_archives gets past the read step
        // and into the abi-check (which happens before metadata
        // extraction).
        write_real_archive(
            &archives,
            "x",
            "1.0.0",
            1,
            5,
            "wasm32",
            "11111111",
            &"a".repeat(64),
        );

        let err = super::run(vec![
            "--abi".into(),
            "6".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
        ])
        .expect_err("abi mismatch must error");
        assert!(
            err.contains("abi5") && err.contains("--abi is 6"),
            "got: {err}"
        );
    }

    /// Filename parser: rejects bad shapes with messages that name the
    /// failing segment.
    #[test]
    fn filename_parser_rejects_malformed_inputs() {
        // Missing .tar.zst suffix.
        let err = parse_archive_filename("foo.tar.gz").unwrap_err();
        assert!(err.contains(".tar.zst"), "got: {err}");

        // Too few segments.
        let err = parse_archive_filename("a-b-c.tar.zst").unwrap_err();
        assert!(err.contains("too few"), "got: {err}");

        // Bad short_sha (uppercase).
        let err = parse_archive_filename("x-1.0.0-rev1-abi6-wasm32-AAAAAAAA.tar.zst").unwrap_err();
        assert!(err.contains("8 lowercase hex"), "got: {err}");

        // Bad arch.
        let err = parse_archive_filename("x-1.0.0-rev1-abi6-armv7-aaaaaaaa.tar.zst").unwrap_err();
        assert!(err.contains("wasm32 or wasm64"), "got: {err}");

        // Bad abi prefix.
        let err = parse_archive_filename("x-1.0.0-rev1-foo6-wasm32-aaaaaaaa.tar.zst").unwrap_err();
        assert!(err.contains("abi<N>"), "got: {err}");
    }

    /// Multi-segment package name (e.g. `mariadb-test-10.5.27`) must
    /// parse correctly: the LAST `-` before `rev<N>` is the
    /// name/version boundary.
    #[test]
    fn filename_parser_handles_multi_segment_names() {
        let p = parse_archive_filename("mariadb-test-10.5.27-rev3-abi6-wasm32-abc12345.tar.zst")
            .unwrap();
        assert_eq!(p.name, "mariadb-test");
        assert_eq!(p.version, "10.5.27");
        assert_eq!(p.revision, 3);
        assert_eq!(p.abi, 6);
        assert_eq!(p.arch, TargetArch::Wasm32);
        assert_eq!(p.short_sha, "abc12345");
    }
}
