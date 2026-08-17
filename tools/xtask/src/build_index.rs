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
//! The seed flow extracts each archive's internal `manifest.toml` as
//! the authoritative package identity and compatibility record. It
//! verifies that the transport filename exactly matches the canonical
//! name `archive-stage` would produce from those structured fields,
//! then stamps the manifest data into the per-entry fields the resolver
//! requires. Package names and versions can both contain `-`, so they
//! must never be inferred by splitting the filename.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::index_toml::IndexToml;
use crate::pkg_manifest::{DepsManifest, TargetArch};
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

/// One archive whose structured identity has been recovered from its
/// internal `manifest.toml` and checked against its transport filename.
struct CollectedArchive {
    manifest: DepsManifest,
    archive_sha256: String,
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
///   --abi          <u32>     Cross-checked against each archived
///                            manifest and canonical filename.
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

    for archive in entries {
        let manifest = &archive.manifest;
        let compatibility = manifest
            .compatibility
            .as_ref()
            .expect("collect_archives only returns archived manifests");
        if let Some(prev) = pkg_version.get(&manifest.name) {
            if prev != &manifest.version {
                return Err(format!(
                    "package {:?}: archive {:?} declares version {:?}, but a sibling \
                     arch already declared {:?} — every arch of a package must agree on version",
                    manifest.name, archive.filename, manifest.version, prev,
                ));
            }
        } else {
            pkg_version.insert(manifest.name.clone(), manifest.version.clone());
        }
        if let Some(prev) = pkg_revision.get(&manifest.name) {
            if prev != &manifest.revision {
                return Err(format!(
                    "package {:?}: archive {:?} declares revision {}, but a sibling \
                     arch already declared revision {} — every arch must agree on revision",
                    manifest.name, archive.filename, manifest.revision, prev,
                ));
            }
        } else {
            pkg_revision.insert(manifest.name.clone(), manifest.revision);
        }

        idx.update_entry_success(
            &manifest.name,
            &manifest.version,
            manifest.revision,
            compatibility.target_arch,
            archive.filename,
            archive.archive_sha256,
            compatibility.cache_key_sha.clone(),
            compatibility
                .build_timestamp
                .clone()
                .unwrap_or_else(|| generated_at.clone()),
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

/// Decompress + un-tar an archive in memory, find the
/// `manifest.toml` entry, parse it through
/// `DepsManifest::parse_archived`, and return the validated structured
/// manifest that owns the archive's package identity.
fn read_archive_manifest(bytes: &[u8]) -> Result<DepsManifest, String> {
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
            return DepsManifest::parse_archived(&text, PathBuf::from("/dev/null"));
        }
    }
    Err("archive missing manifest.toml at the root".into())
}

/// Walk `archives_dir` for `*.tar.zst` files, recover each identity from
/// its internal manifest, validate its canonical filename, and compute
/// its sha256. Sorted by (manifest name, target arch) for deterministic
/// output downstream.
fn collect_archives(
    archives_dir: &Path,
    expected_abi: u32,
) -> Result<Vec<CollectedArchive>, String> {
    if !archives_dir.is_dir() {
        return Err(format!(
            "archives-dir {} is not a directory or does not exist",
            archives_dir.display()
        ));
    }
    let mut out: Vec<CollectedArchive> = Vec::new();
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
        let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let sha = hex(&Into::<[u8; 32]>::into(hasher.finalize()));
        let manifest = read_archive_manifest(&bytes).map_err(|e| {
            format!(
                "archive {name}: {e}. The seed flow needs each .tar.zst's internal \
                 manifest.toml to recover its package identity and compatibility."
            )
        })?;
        let compatibility = manifest
            .compatibility
            .as_ref()
            .expect("parse_archived requires compatibility");
        if !compatibility.abi_versions.contains(&expected_abi) {
            return Err(format!(
                "archive {name}: manifest abi_versions {:?} does not include --abi {}",
                compatibility.abi_versions, expected_abi
            ));
        }
        let expected_name = canonical_archive_filename(&manifest, expected_abi);
        if name != expected_name {
            return Err(format!(
                "archive {name:?}: filename does not match manifest identity \
                 {}@{} revision {} for {} at ABI {}; expected {expected_name:?}",
                manifest.name,
                manifest.version,
                manifest.revision,
                compatibility.target_arch.as_str(),
                expected_abi,
            ));
        }
        out.push(CollectedArchive {
            manifest,
            archive_sha256: sha,
            filename: name,
        });
    }
    // Deterministic enumeration order: by (name, arch, filename). Same set
    // of archives → same result regardless of dirent traversal order, including
    // the order in which a duplicate-identity error names the two archives.
    out.sort_by(|a, b| {
        a.manifest.name.cmp(&b.manifest.name).then_with(|| {
            archive_target_arch(a)
                .cmp(&archive_target_arch(b))
                .then_with(|| a.filename.cmp(&b.filename))
        })
    });
    for archives in out.windows(2) {
        let first = &archives[0];
        let second = &archives[1];
        if first.manifest.name == second.manifest.name
            && archive_target_arch(first) == archive_target_arch(second)
        {
            return Err(format!(
                "duplicate archives for package {:?} target {}: {:?} \
                 (cache_key_sha {}, archive_sha256 {}) and {:?} \
                 (cache_key_sha {}, archive_sha256 {}); index recovery \
                 cannot choose between immutable archives",
                first.manifest.name,
                archive_target_arch(first).as_str(),
                first.filename,
                archive_cache_key(first),
                first.archive_sha256,
                second.filename,
                archive_cache_key(second),
                second.archive_sha256,
            ));
        }
    }
    Ok(out)
}

fn archive_target_arch(archive: &CollectedArchive) -> TargetArch {
    archive
        .manifest
        .compatibility
        .as_ref()
        .expect("parse_archived requires compatibility")
        .target_arch
}

fn archive_cache_key(archive: &CollectedArchive) -> &str {
    &archive
        .manifest
        .compatibility
        .as_ref()
        .expect("parse_archived requires compatibility")
        .cache_key_sha
}

/// Reconstruct the transport filename from the archive's validated
/// structured identity. This must match `archive_stage_cli`'s producer
/// format, but is intentionally one-way: no identity field is recovered
/// by splitting this ambiguous string.
fn canonical_archive_filename(manifest: &DepsManifest, abi: u32) -> String {
    let compatibility = manifest
        .compatibility
        .as_ref()
        .expect("parse_archived requires compatibility");
    crate::package_archive_name::render(
        manifest,
        compatibility.target_arch,
        abi,
        &compatibility.cache_key_sha,
    )
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
    /// `read_archive_manifest` (DepsManifest::parse_archived).
    fn write_real_archive(
        dir: &Path,
        name: &str,
        version: &str,
        rev: u32,
        abi: u32,
        arch: &str,
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
        let manifest = DepsManifest::parse_archived(&manifest_text, PathBuf::from("/dev/null"))
            .expect("test archive manifest must parse");
        let target_arch = manifest
            .compatibility
            .as_ref()
            .expect("test archive manifest must have compatibility")
            .target_arch;
        let fname = crate::package_archive_name::render(
            &manifest,
            target_arch,
            abi,
            cache_key_sha,
        );
        let path = dir.join(&fname);
        fs::write(&path, &bytes).unwrap();
        path
    }

    fn read_index(out_path: &Path) -> String {
        fs::read_to_string(out_path).unwrap()
    }

    fn file_sha256(path: &Path) -> String {
        let mut hasher = Sha256::new();
        hasher.update(fs::read(path).unwrap());
        hex(&Into::<[u8; 32]>::into(hasher.finalize()))
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
            &"a".repeat(64),
        );
        write_real_archive(
            &archives,
            "alpha",
            "1.0.0",
            1,
            6,
            "wasm64",
            &"b".repeat(64),
        );
        write_real_archive(
            &archives,
            "beta",
            "2.0.0",
            1,
            6,
            "wasm32",
            &"c".repeat(64),
        );
        write_real_archive(
            &archives,
            "beta",
            "2.0.0",
            1,
            6,
            "wasm64",
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
            text.contains("archive_url = \"alpha-1.0.0-rev1-abi6-wasm32-aaaaaaaa.tar.zst\""),
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
            &"a".repeat(64),
        );
        write_real_archive(
            &archives,
            "alpha",
            "1.0.0",
            1,
            6,
            "wasm64",
            &"b".repeat(64),
        );
        write_real_archive(
            &archives,
            "beta",
            "2.3.4",
            7,
            6,
            "wasm32",
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

    /// A package's architecture slices must agree on version and revision.
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
            &"a".repeat(64),
        );
        write_real_archive(
            &archives,
            "x",
            "1.0.1",
            1,
            6,
            "wasm64",
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

    /// `--abi` mismatch with the structured compatibility record → error.
    #[test]
    fn abi_mismatch_in_manifest_is_rejected() {
        let dir = tempdir("abi-mismatch");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        write_real_archive(
            &archives,
            "x",
            "1.0.0",
            1,
            5,
            "wasm32",
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
            err.contains("manifest abi_versions [5]") && err.contains("--abi 6"),
            "got: {err}"
        );
    }

    #[test]
    fn manifest_identity_handles_hyphens_in_package_name_and_version() {
        let dir = tempdir("hyphenated-identity");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        let cache_key_sha = "a".repeat(64);
        let archive = write_real_archive(
            &archives,
            "spidermonkey-node",
            "140.11.0esr-node.1",
            4,
            39,
            "wasm32",
            &cache_key_sha,
        );

        super::run(vec![
            "--abi".into(),
            "39".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
            "--generated-at".into(),
            "2026-07-14T00:00:00Z".into(),
        ])
        .unwrap();

        let index = crate::index_toml::IndexToml::parse(&read_index(&out)).unwrap();
        assert_eq!(index.packages.len(), 1);
        assert_eq!(index.packages[0].name, "spidermonkey-node");
        assert_eq!(index.packages[0].version, "140.11.0esr-node.1");
        assert_eq!(index.packages[0].revision, 4);
        assert_eq!(
            index.packages[0].binary[&TargetArch::Wasm32]
                .archive_url
                .as_deref(),
            archive.file_name().and_then(|name| name.to_str())
        );
    }

    #[test]
    fn duplicate_manifest_identity_is_rejected_with_both_archive_identities() {
        let dir = tempdir("duplicate-manifest-identity");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        let first_key =
            "0f5290453e6ea7f68e5ee1e50bd6dbf23221368e7aeb7a54c34953cef453920d";
        let second_key =
            "a88651d0cd72a9100a67c90fa4b5600659258b10890c852ff10ab125cf770212";
        let first = write_real_archive(
            &archives,
            "spidermonkey-node",
            "140.11.0esr-node.1",
            4,
            39,
            "wasm32",
            first_key,
        );
        let second = write_real_archive(
            &archives,
            "spidermonkey-node",
            "140.11.0esr-node.1",
            4,
            39,
            "wasm32",
            second_key,
        );
        let first_sha = file_sha256(&first);
        let second_sha = file_sha256(&second);

        let err = super::run(vec![
            "--abi".into(),
            "39".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
        ])
        .expect_err("duplicate package/arch archives must not overwrite one another");

        assert!(err.contains("duplicate archives"), "got: {err}");
        assert!(err.contains("spidermonkey-node"), "got: {err}");
        assert!(err.contains("wasm32"), "got: {err}");
        for value in [
            first.file_name().unwrap().to_str().unwrap(),
            first_key,
            first_sha.as_str(),
            second.file_name().unwrap().to_str().unwrap(),
            second_key,
            second_sha.as_str(),
        ] {
            assert!(err.contains(value), "missing {value:?} from: {err}");
        }
        assert!(!out.exists(), "a rejected inventory must not write an index");
    }

    #[test]
    fn filename_cannot_override_manifest_identity() {
        let dir = tempdir("filename-identity-override");
        let archives = dir.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let out = dir.join("index.toml");

        let cache_key_sha = "b".repeat(64);
        let archive = write_real_archive(
            &archives,
            "trusted-package",
            "1.0-beta-1",
            2,
            39,
            "wasm32",
            &cache_key_sha,
        );
        let misleading_name =
            "attacker-trusted-package-1.0-beta-1-rev2-abi39-wasm32-bbbbbbbb.tar.zst";
        fs::rename(&archive, archives.join(misleading_name)).unwrap();

        let err = super::run(vec![
            "--abi".into(),
            "39".into(),
            "--generator".into(),
            "test".into(),
            "--archives-dir".into(),
            archives.display().to_string(),
            "--out".into(),
            out.display().to_string(),
        ])
        .expect_err("the embedded manifest must own package identity");

        assert!(err.contains("manifest identity"), "got: {err}");
        assert!(err.contains(misleading_name), "got: {err}");
        assert!(err.contains("trusted-package-1.0-beta-1"), "got: {err}");
    }
}
