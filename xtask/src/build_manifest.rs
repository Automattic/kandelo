//! Generate a binary-release `manifest.json` from a staging directory.
//!
//! Walks the given directory (non-recursively — the release namespace
//! is intentionally flat, see `docs/binary-releases.md`), computes
//! SHA-256 of every file, extracts metadata from filenames and the
//! per-dir program registry (`examples/libs/<name>/deps.toml` with
//! `kind = "program"`), and writes a deterministic JSON manifest
//! that conforms to `abi/manifest.schema.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_posix_shared as shared;

use crate::build_deps::{compute_sha, parse_target_arch, programs_by_name, Registry};
use crate::deps_manifest::{DepsManifest, ManifestKind, TargetArch};
use crate::repo_root;
use crate::wasm_abi::extract_abi_version;
use crate::JsonMap;

const GENERATOR: &str = concat!("cargo xtask build-manifest ", env!("CARGO_PKG_VERSION"));

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut in_dir: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut tag: Option<String> = None;
    let mut generated_at: Option<String> = None;
    let mut abi_arg: Option<u32> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut arches: Vec<TargetArch> = Vec::new();

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--in" => in_dir = Some(it.next().ok_or("--in requires a path")?.into()),
            "--out" => out_path = Some(it.next().ok_or("--out requires a path")?.into()),
            "--tag" => tag = Some(it.next().ok_or("--tag requires a value")?),
            "--generated-at" => {
                generated_at = Some(it.next().ok_or("--generated-at requires an ISO-8601 value")?)
            }
            "--abi" => {
                abi_arg = Some(
                    it.next()
                        .ok_or("--abi requires <u32>")?
                        .parse()
                        .map_err(|e| format!("--abi: {e}"))?,
                )
            }
            "--registry" => {
                registry_root =
                    Some(PathBuf::from(it.next().ok_or("--registry requires path")?))
            }
            "--arch" => {
                let v = it.next().ok_or("--arch requires wasm32|wasm64")?;
                arches.push(parse_target_arch(&v)?);
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let in_dir = in_dir.ok_or("--in <staging-dir> is required")?;
    let out_path = out_path.ok_or("--out <manifest.json path> is required")?;
    let tag = tag.ok_or("--tag <release-tag> is required")?;

    // When --abi is supplied explicitly, the caller is asking us to
    // stamp archive entries with that ABI value AND verify the tag against
    // it. When --abi is omitted, fall back to the kernel's compiled-in
    // ABI_VERSION (preserves existing legacy-only callers' behavior).
    let abi = abi_arg.unwrap_or(shared::ABI_VERSION);
    verify_tag_matches_abi(&tag, abi)?;

    let generated_at = generated_at.unwrap_or_else(current_utc_iso);

    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };
    let arches = if arches.is_empty() {
        vec![TargetArch::Wasm32, TargetArch::Wasm64]
    } else {
        arches
    };
    let program_meta = programs_by_name(&registry)?;

    let mut entries = Vec::new();
    let mut read_dir: Vec<_> = std::fs::read_dir(&in_dir)
        .map_err(|e| format!("read dir {}: {e}", in_dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("read dir entry: {e}"))?;
    read_dir.sort_by_key(|e| e.file_name());

    // Program names sorted by length descending — we match longest first
    // so `exec-caller` wins over `exec` for a filename like
    // `exec-caller-0.1.0-rev1-abc12345.zip`.
    let mut program_names: Vec<&str> = program_meta.keys().map(|s| s.as_str()).collect();
    program_names.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));

    for dirent in read_dir {
        let path = dirent.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("non-utf8 filename: {}", path.display()))?
            .to_string();
        if name == "manifest.json" {
            continue;
        }
        entries.push(build_entry(&path, &name, &program_meta, &program_names)?);
    }

    // package-system registry walk: for every kind="library" or kind="program"
    // manifest in the registry, fan out across the requested arches.
    // For each (manifest, arch) pair, locate the staged archive at
    // `<in>/{libs,programs}/<name>-<version>-rev<N>-<arch>-<short>.tar.zst`.
    // If present, emit a archive entry; if missing, skip silently —
    // build-manifest catalogs only what's actually staged.
    //
    // The memo is keyed only on `name@version` (see `compute_sha`), so
    // it isn't safe to reuse across arches — wasm32 and wasm64 hash to
    // different shas. Allocate a fresh memo per arch, matching the
    // pattern in `ensure_built`.
    for (_, m) in registry.walk_all()? {
        if !matches!(m.kind, ManifestKind::Library | ManifestKind::Program) {
            continue;
        }
        for &arch in &arches {
            let mut chain: Vec<String> = Vec::new();
            let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
            let sha = compute_sha(&m, &registry, arch, abi, &mut memo, &mut chain)
                .map_err(|e| format!("compute_sha for {} on {:?}: {e}", m.name, arch))?;
            let short = &crate::util::hex(&sha)[..8];
            // Filename: <name>-<v>-rev<N>-abi<N>-<arch>-<short_sha>.tar.zst.
            // Mirrors stage_release's construction.
            let archive_name = format!(
                "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
                m.name,
                m.version,
                m.revision,
                abi,
                arch.as_str(),
                short,
            );
            let subdir = match m.kind {
                ManifestKind::Library => "libs",
                ManifestKind::Program => "programs",
                ManifestKind::Source => unreachable!(),
            };
            let archive_path = in_dir.join(subdir).join(&archive_name);
            if !archive_path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&archive_path)
                .map_err(|e| format!("read {}: {e}", archive_path.display()))?;
            entries.push(build_v2_entry(
                &m,
                arch,
                abi,
                &archive_name,
                &bytes,
                &crate::util::hex(&sha),
            )?);
        }
    }

    // Schema description on `entries` claims "sorted alphabetically by
    // `name`". legacy staging walk is sorted; package-system registry walk is sorted
    // per-arch; but the merged vec is two concatenated runs, not a
    // single sorted sequence. Sort once at the end so the documented
    // invariant holds and cross-release diffs read cleanly.
    entries.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });

    let mut root: JsonMap = BTreeMap::new();
    root.insert("abi_version".into(), json!(abi));
    root.insert("release_tag".into(), json!(tag));
    root.insert("generated_at".into(), json!(generated_at));
    root.insert("generator".into(), json!(GENERATOR));
    root.insert("entries".into(), Value::Array(entries));

    let rendered = render_deterministic(&root);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&out_path, &rendered)
        .map_err(|e| format!("write {}: {e}", out_path.display()))?;
    println!("wrote {}", out_path.display());
    Ok(())
}

fn build_entry(
    path: &Path,
    name: &str,
    program_meta: &BTreeMap<String, DepsManifest>,
    program_names: &[&str],
) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hex_lower(&hasher.finalize());

    let parsed = ParsedName::parse(name, program_names)?;
    let kind = classify_kind(&parsed, &bytes);
    let arch = detect_arch(&parsed, &bytes, kind);

    // Abi version: extract from wasm for plain .wasm assets, and for
    // zip bundles by peeking at the first wasm entry inside.
    let abi_version = match kind {
        "kernel" | "userspace" => extract_abi_version(&bytes),
        "program" if parsed.extension == "zip" => extract_abi_version_from_zip(&bytes),
        "program" if parsed.extension == "wasm" => extract_abi_version(&bytes),
        _ => None,
    };

    let meta = program_meta.get(&parsed.program).ok_or_else(|| {
        format!(
            "no entry for program {:?} in the per-dir registry — \
             every shipped asset must declare source + license via \
             examples/libs/<program>/deps.toml with kind = \"program\"",
            parsed.program
        )
    })?;

    let mut m: JsonMap = BTreeMap::new();
    m.insert("name".into(), json!(name));
    m.insert("program".into(), json!(parsed.program));
    m.insert("kind".into(), json!(kind));
    if let Some(a) = arch {
        m.insert("arch".into(), json!(a));
    }
    if let Some(v) = parsed.upstream_version.as_deref() {
        m.insert("upstream_version".into(), json!(v));
    } else {
        m.insert("upstream_version".into(), Value::Null);
    }
    if let Some(r) = parsed.revision {
        m.insert("revision".into(), json!(r));
    }
    m.insert("size".into(), json!(bytes.len()));
    m.insert("sha256".into(), json!(hash));
    m.insert(
        "abi_version".into(),
        match abi_version {
            Some(v) => json!(v),
            None => Value::Null,
        },
    );
    m.insert("source".into(), source_value(meta));
    m.insert("license".into(), license_value(meta));
    m.insert("advisories".into(), Value::Array(Vec::new()));

    Ok(Value::Object(m.into_iter().collect()))
}

/// Build a archive-shaped manifest entry for a library/program archive.
///
/// archive entries are emitted from the registry walk (not the staging-dir
/// walk) and carry the `[compatibility]` block + `archive_name` /
/// `archive_sha256` symmetry fields. `abi_version` is explicitly null
/// — the archives advertise compatibility via the `compatibility` block
/// instead of the legacy `__abi_version` wasm export sniff.
fn build_v2_entry(
    m: &DepsManifest,
    arch: TargetArch,
    abi: u32,
    archive_name: &str,
    bytes: &[u8],
    cache_key_sha_hex: &str,
) -> Result<Value, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let archive_sha = hex_lower(&hasher.finalize());
    let kind_str = match m.kind {
        ManifestKind::Library => "library",
        ManifestKind::Program => "program",
        ManifestKind::Source => {
            return Err("build_v2_entry called on non-library/program kind".into())
        }
    };

    let mut o: JsonMap = BTreeMap::new();
    o.insert("name".into(), json!(archive_name));
    o.insert("program".into(), json!(m.name));
    o.insert("kind".into(), json!(kind_str));
    o.insert("arch".into(), json!(arch.as_str()));
    o.insert("upstream_version".into(), json!(m.version));
    o.insert("revision".into(), json!(m.revision));
    o.insert("size".into(), json!(bytes.len()));
    o.insert("sha256".into(), json!(archive_sha.clone()));
    o.insert("abi_version".into(), Value::Null);
    o.insert("archive_name".into(), json!(archive_name));
    o.insert("archive_sha256".into(), json!(archive_sha));
    let mut compat: JsonMap = BTreeMap::new();
    compat.insert("target_arch".into(), json!(arch.as_str()));
    compat.insert("abi_versions".into(), json!([abi]));
    compat.insert("cache_key_sha".into(), json!(cache_key_sha_hex));
    o.insert(
        "compatibility".into(),
        Value::Object(compat.into_iter().collect()),
    );
    o.insert("source".into(), source_value(m));
    o.insert("license".into(), license_value(m));
    o.insert("advisories".into(), Value::Array(Vec::new()));
    Ok(Value::Object(o.into_iter().collect()))
}

/// Pulled-apart filename.
///
/// Accepts two conventions, in order of preference:
///   1. `<program>-<version>-rev<N>-<short-sha>.<ext>` — every ported
///      program. Example: `vim-9.1.0900-rev1-a1b2c3d4.zip`.
///   2. `<program>-<short-sha>.<ext>` — kernel/userspace, where
///      upstream version isn't meaningful.
struct ParsedName {
    program: String,
    upstream_version: Option<String>,
    revision: Option<u32>,
    extension: String,
}

impl ParsedName {
    /// `program_names` must be sorted by length descending so we match
    /// the longest known program name first (e.g. `exec-caller` wins
    /// over `exec` for `exec-caller-0.1.0-...`).
    fn parse(name: &str, program_names: &[&str]) -> Result<Self, String> {
        let (stem, ext) = split_ext(name);
        let parts: Vec<&str> = stem.split('-').collect();
        if parts.is_empty() {
            return Err(format!("empty filename stem: {name:?}"));
        }
        let last = parts.last().unwrap();
        if !is_short_hash(last) {
            return Err(format!(
                "filename {name:?} does not end in an 8-char hex hash suffix"
            ));
        }
        let pre = &parts[..parts.len() - 1];

        // Try to recognise the program as a known prefix. Longest match
        // wins because program_names is sorted longest-first.
        let pre_joined = pre.join("-");
        let program = program_names
            .iter()
            .find(|&&p| pre_joined == p || pre_joined.starts_with(&format!("{p}-")))
            .copied()
            .ok_or_else(|| {
                format!(
                    "filename {name:?} doesn't start with a known program name \
                     from the per-dir registry (examples/libs/<name>/deps.toml \
                     with kind = \"program\"). Add the program or rename \
                     the asset."
                )
            })?
            .to_string();

        // What's left after the program prefix?
        let remainder = if pre_joined == program {
            ""
        } else {
            &pre_joined[program.len() + 1..] // +1 for the '-'
        };

        if remainder.is_empty() {
            // <program>-<short-sha>.<ext>
            return Ok(Self {
                program,
                upstream_version: None,
                revision: None,
                extension: ext,
            });
        }

        // Expect "<version>-rev<N>"
        let rem_parts: Vec<&str> = remainder.split('-').collect();
        if rem_parts.len() < 2 {
            return Err(format!(
                "filename {name:?}: segment after program {program:?} must be \
                 <version>-rev<N>, got {remainder:?}"
            ));
        }
        let rev_segment = *rem_parts.last().unwrap();
        let rev = rev_segment
            .strip_prefix("rev")
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or_else(|| {
                format!(
                    "filename {name:?}: last segment before the hash must be \
                     `revN`, got {rev_segment:?}"
                )
            })?;
        let version = rem_parts[..rem_parts.len() - 1].join("-");

        Ok(Self {
            program,
            upstream_version: Some(version),
            revision: Some(rev),
            extension: ext,
        })
    }
}

fn is_short_hash(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn split_ext(name: &str) -> (&str, String) {
    // Multi-extension: .vfs.zst is one logical extension.
    for multi in [".vfs.zst", ".vfs.gz", ".tar.zst", ".tar.gz"] {
        if let Some(stem) = name.strip_suffix(multi) {
            return (stem, multi[1..].to_string());
        }
    }
    match name.rfind('.') {
        Some(i) => (&name[..i], name[i + 1..].to_string()),
        None => (name, String::new()),
    }
}

fn classify_kind(parsed: &ParsedName, bytes: &[u8]) -> &'static str {
    // By filename convention first; fallback to content sniffing for
    // the kernel + userspace cases where the name is fixed.
    if parsed.program == "kernel" || parsed.program == "wasm_posix_kernel" {
        return "kernel";
    }
    if parsed.program == "userspace" || parsed.program == "wasm_posix_userspace" {
        return "userspace";
    }
    if parsed.extension.starts_with("vfs") {
        return "vfs-image";
    }
    if parsed.extension == "zip" {
        return "program";
    }
    // Lone .wasm (rare in our convention but possible for kernel)
    if parsed.extension == "wasm" && is_wasm_magic(bytes) {
        if parsed.program.contains("kernel") {
            return "kernel";
        }
        if parsed.program.contains("userspace") {
            return "userspace";
        }
        return "program";
    }
    "program"
}

fn detect_arch(parsed: &ParsedName, bytes: &[u8], kind: &str) -> Option<&'static str> {
    match kind {
        "vfs-image" => Some("any"),
        _ => {
            if is_wasm_magic(bytes) {
                // All our kernels are wasm64; all user programs are
                // currently wasm32. For bundles (zip), we don't peek
                // inside — trust filename convention and bundle-program
                // to set the right metadata at publish time.
                if parsed.program.contains("kernel") {
                    Some("wasm64")
                } else if parsed.program == "hello64" {
                    Some("wasm64")
                } else {
                    Some("wasm32")
                }
            } else if parsed.extension == "zip" {
                // Program bundle — arch depends on the .wasm inside.
                // We peek into zip entries to make this honest.
                match detect_zip_arch(bytes) {
                    Some(a) => Some(a),
                    None => Some("wasm32"),
                }
            } else {
                None
            }
        }
    }
}

fn is_wasm_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == b"\0asm"
}

/// Peek at the first wasm file inside a zip to extract its
/// `__abi_version` export value (if present).
fn extract_abi_version_from_zip(bytes: &[u8]) -> Option<i64> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).ok()?;
        let name = entry.name().to_string();
        if name.ends_with(".wasm") || name.ends_with("/bin/vim") || name.ends_with("/bin/sh") {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).ok()?;
            if is_wasm_magic(&buf) {
                return extract_abi_version(&buf);
            }
        }
    }
    None
}

/// Peek at the first wasm file inside a zip to determine its arch.
/// Returns None if we can't parse the zip or find a wasm entry.
fn detect_zip_arch(bytes: &[u8]) -> Option<&'static str> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).ok()?;
        if entry.name().ends_with(".wasm") {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).ok()?;
            if is_wasm_magic(&buf) {
                // wasm32 vs wasm64 via import section — wasm32 imports
                // `env.memory` as 32-bit; wasm64 as 64-bit. Tell by the
                // memory limit encoding (flags byte). Simpler: parse
                // with wasmparser.
                use wasmparser::{Parser, Payload};
                for payload in Parser::new(0).parse_all(&buf) {
                    if let Ok(Payload::ImportSection(r)) = payload {
                        for group in r.into_iter() {
                            if let Ok(group) = group {
                                let memory = match group {
                                    wasmparser::Imports::Single(_, i) => match i.ty {
                                        wasmparser::TypeRef::Memory(m) => Some(m),
                                        _ => None,
                                    },
                                    _ => None,
                                };
                                if let Some(m) = memory {
                                    return Some(if m.memory64 { "wasm64" } else { "wasm32" });
                                }
                            }
                        }
                    }
                }
            }
            return Some("wasm32");
        }
    }
    None
}

fn verify_tag_matches_abi(tag: &str, abi_version: u32) -> Result<(), String> {
    let expected = format!("binaries-abi-v{abi_version}");
    if tag == expected {
        Ok(())
    } else {
        Err(format!(
            "tag {tag:?} does not equal {expected:?} — refusing to \
             generate a manifest that would claim a different ABI than \
             `wasm_posix_shared::ABI_VERSION` ({abi_version}). \
             See docs/binary-releases.md."
        ))
    }
}

/// Emit a release-manifest `source` block from a `DepsManifest`.
///
/// package-system emits `{url, sha256}` (was `{url, ref}` in legacy). The `ref` field
/// was display-only and unused by any consumer in this repo; the
/// sha256 is the upstream tarball's content hash, taken verbatim from
/// `[source].sha256` in the per-dir manifest.
fn source_value(m: &DepsManifest) -> Value {
    let mut o: JsonMap = BTreeMap::new();
    o.insert("url".into(), json!(m.source.url));
    o.insert("sha256".into(), json!(m.source.sha256));
    Value::Object(o.into_iter().collect())
}

fn license_value(m: &DepsManifest) -> Value {
    let mut o: JsonMap = BTreeMap::new();
    o.insert("spdx".into(), json!(m.license.spdx));
    if let Some(u) = m.license.url.as_deref() {
        o.insert("url".into(), json!(u));
    }
    Value::Object(o.into_iter().collect())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

// `pub(crate)` so the `stage_release` subcommand can reuse the same
// RFC3339 formatter as `build-manifest`'s default `generated_at`. Both
// emit the same calendar logic; sharing avoids drift.
pub(crate) fn current_utc_iso() -> String {
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

fn render_deterministic(root: &JsonMap) -> String {
    let value = Value::Object(root.clone().into_iter().collect());
    let mut s = serde_json::to_string_pretty(&value).expect("serialize");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use crate::repo_root;
    use serde_json::Value;

    /// Wrap a single entry into a complete manifest doc and validate it
    /// against `abi/manifest.schema.json`. Returns true iff the doc
    /// passes validation.
    fn validates_against_schema(entry: &Value) -> bool {
        let schema_path = repo_root().join("abi/manifest.schema.json");
        let schema_bytes = std::fs::read(&schema_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", schema_path.display()));
        let schema: Value = serde_json::from_slice(&schema_bytes)
            .unwrap_or_else(|e| panic!("parse schema: {e}"));

        let doc = serde_json::json!({
            "abi_version": 1,
            "release_tag": "binaries-abi-v1",
            "generated_at": "2026-01-01T00:00:00Z",
            "generator": "test",
            "entries": [entry],
        });

        // jsonschema 0.18 uses JSONSchema::compile + is_valid; the
        // Validator-named API only landed later in the 0.x series.
        let validator = jsonschema::JSONSchema::compile(&schema)
            .unwrap_or_else(|e| panic!("compile schema: {e}"));
        validator.is_valid(&doc)
    }

    fn sample_v2_lib_entry() -> Value {
        serde_json::json!({
            "name": "zlib-1.3.1-rev1-abi4-wasm32-9acb9405.tar.zst",
            "program": "zlib",
            "kind": "library",
            "arch": "wasm32",
            "upstream_version": "1.3.1",
            "revision": 1,
            "size": 12345,
            "sha256": "0".repeat(64),
            "abi_version": null,
            "archive_name": "zlib-1.3.1-rev1-abi4-wasm32-9acb9405.tar.zst",
            "archive_sha256": "0".repeat(64),
            "compatibility": {
                "target_arch": "wasm32",
                "abi_versions": [4],
                "cache_key_sha": "0".repeat(64),
            },
            "source": { "url": "https://x", "sha256": "0".repeat(64) },
            "license": { "spdx": "Zlib" },
            "advisories": [],
        })
    }

    #[test]
    fn schema_accepts_v2_library_entry() {
        let entry = sample_v2_lib_entry();
        assert!(
            validates_against_schema(&entry),
            "library entry should validate"
        );
    }

    #[test]
    fn schema_rejects_compat_with_short_sha() {
        let mut entry = sample_v2_lib_entry();
        entry["compatibility"]["cache_key_sha"] = serde_json::json!("deadbeef");
        assert!(
            !validates_against_schema(&entry),
            "must reject 8-char sha"
        );
    }

    #[test]
    fn schema_rejects_compat_with_empty_abi_versions() {
        let mut entry = sample_v2_lib_entry();
        entry["compatibility"]["abi_versions"] = serde_json::json!([]);
        assert!(!validates_against_schema(&entry));
    }

    #[test]
    fn schema_rejects_compat_with_unknown_field() {
        let mut entry = sample_v2_lib_entry();
        entry["compatibility"]["spurious"] = serde_json::json!("x");
        assert!(
            !validates_against_schema(&entry),
            "additionalProperties:false must reject unknown field"
        );
    }

    #[test]
    fn schema_rejects_compat_with_uppercase_sha() {
        let mut entry = sample_v2_lib_entry();
        entry["compatibility"]["cache_key_sha"] = serde_json::json!("F".repeat(64));
        assert!(
            !validates_against_schema(&entry),
            "hex pattern must reject uppercase"
        );
    }

    #[test]
    fn schema_rejects_compat_with_too_long_sha() {
        let mut entry = sample_v2_lib_entry();
        entry["compatibility"]["cache_key_sha"] =
            serde_json::json!(format!("{}0", "0".repeat(64)));
        assert!(
            !validates_against_schema(&entry),
            "$ anchor must reject 65-char hex"
        );
    }

    #[test]
    fn schema_still_accepts_v1_program_zip() {
        let entry = serde_json::json!({
            "name": "vim-9.1.0900-rev1-abc12345.zip",
            "program": "vim",
            "kind": "program",
            "arch": "wasm32",
            "upstream_version": "9.1.0900",
            "revision": 1,
            "size": 1,
            "sha256": "0".repeat(64),
            "abi_version": null,
            "source": { "url": "https://x", "sha256": "0".repeat(64) },
            "license": { "spdx": "Vim" },
            "advisories": [],
        });
        assert!(
            validates_against_schema(&entry),
            "legacy zip must keep validating"
        );
    }

    // ----- E.3: registry-walk emission tests -----------------------

    use std::fs;
    use std::path::{Path, PathBuf};

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-build-manifest")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_lib_manifest(registry: &Path, name: &str, version: &str) {
        let dir = registry.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("deps.toml"),
            format!(
                "kind = \"library\"\n\
                 name = \"{name}\"\n\
                 version = \"{version}\"\n\
                 revision = 1\n\
                 [source]\n\
                 url = \"file:///dev/null\"\n\
                 sha256 = \"{}\"\n\
                 [license]\n\
                 spdx = \"MIT\"\n\
                 [outputs]\n\
                 libs = [\"lib/lib{name}.a\"]\n",
                "0".repeat(64),
            ),
        )
        .unwrap();
    }

    fn write_program_manifest(registry: &Path, name: &str, version: &str) {
        let dir = registry.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("deps.toml"),
            format!(
                "kind = \"program\"\n\
                 name = \"{name}\"\n\
                 version = \"{version}\"\n\
                 revision = 1\n\
                 [source]\n\
                 url = \"file:///dev/null\"\n\
                 sha256 = \"{}\"\n\
                 [license]\n\
                 spdx = \"MIT\"\n\
                 [[outputs]]\n\
                 name = \"{name}\"\n\
                 wasm = \"bin/{name}.wasm\"\n",
                "0".repeat(64),
            ),
        )
        .unwrap();
    }

    fn write_source_manifest(registry: &Path, name: &str, version: &str) {
        let dir = registry.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("deps.toml"),
            format!(
                "kind = \"source\"\n\
                 name = \"{name}\"\n\
                 version = \"{version}\"\n\
                 revision = 1\n\
                 [source]\n\
                 url = \"file:///dev/null\"\n\
                 sha256 = \"{}\"\n\
                 [license]\n\
                 spdx = \"MIT\"\n",
                "0".repeat(64),
            ),
        )
        .unwrap();
    }

    /// Compute the the archives name for a manifest at a given arch.
    /// Mirrors the formula the production code uses.
    fn archive_name_for(
        registry_root: &Path,
        manifest_name: &str,
        arch: crate::deps_manifest::TargetArch,
        abi: u32,
    ) -> (String, [u8; 32]) {
        let reg = crate::build_deps::Registry {
            roots: vec![registry_root.to_path_buf()],
        };
        let m = reg.load(manifest_name).unwrap();
        let mut chain = Vec::new();
        let mut memo = std::collections::BTreeMap::new();
        let sha =
            crate::build_deps::compute_sha(&m, &reg, arch, abi, &mut memo, &mut chain).unwrap();
        let short = &crate::util::hex(&sha)[..8];
        let archive_name = format!(
            "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
            m.name,
            m.version,
            m.revision,
            abi,
            arch.as_str(),
            short,
        );
        (archive_name, sha)
    }

    #[test]
    fn build_manifest_emits_v2_library_entry_per_arch() {
        let dir = tempdir("e3-build-manifest");
        let staging = dir.join("staging");
        let registry = dir.join("registry");
        fs::create_dir_all(staging.join("libs")).unwrap();
        fs::create_dir_all(&registry).unwrap();

        write_lib_manifest(&registry, "zlib", "1.3.1");

        let (archive_name, sha) = archive_name_for(
            &registry,
            "zlib",
            crate::deps_manifest::TargetArch::Wasm32,
            4,
        );

        let archive = staging.join("libs").join(&archive_name);
        fs::write(&archive, b"fake-archive-bytes").unwrap();

        let manifest_path = dir.join("manifest.json");
        super::run(vec![
            "--in".into(),
            staging.display().to_string(),
            "--out".into(),
            manifest_path.display().to_string(),
            "--tag".into(),
            "binaries-abi-v4".into(),
            "--abi".into(),
            "4".into(),
            "--registry".into(),
            registry.display().to_string(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let entries = json["entries"].as_array().unwrap();
        let zlib = entries
            .iter()
            .find(|e| e["program"] == "zlib")
            .expect("zlib entry should be present");
        assert_eq!(zlib["kind"], "library");
        assert_eq!(zlib["arch"], "wasm32");
        assert_eq!(zlib["archive_name"], archive_name.as_str());
        assert_eq!(zlib["compatibility"]["target_arch"], "wasm32");
        assert_eq!(
            zlib["compatibility"]["abi_versions"],
            serde_json::json!([4])
        );
        let cache_key_sha = zlib["compatibility"]["cache_key_sha"].as_str().unwrap();
        assert_eq!(cache_key_sha.len(), 64);
        assert_eq!(cache_key_sha, &crate::util::hex(&sha));
    }

    #[test]
    fn build_manifest_skips_lib_entry_when_archive_missing() {
        let dir = tempdir("e3-skip-missing");
        let staging = dir.join("staging");
        let registry = dir.join("registry");
        fs::create_dir_all(staging.join("libs")).unwrap();
        fs::create_dir_all(&registry).unwrap();

        write_lib_manifest(&registry, "zlib", "1.3.1");
        // NO archive pre-staged.

        let manifest_path = dir.join("manifest.json");
        super::run(vec![
            "--in".into(),
            staging.display().to_string(),
            "--out".into(),
            manifest_path.display().to_string(),
            "--tag".into(),
            "binaries-abi-v4".into(),
            "--abi".into(),
            "4".into(),
            "--registry".into(),
            registry.display().to_string(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let entries = json["entries"].as_array().unwrap();
        assert!(
            entries.iter().all(|e| e["program"] != "zlib"),
            "zlib entry should be absent when archive missing; got: {:?}",
            entries
        );
    }

    #[test]
    fn build_manifest_emits_v2_program_entry_per_arch() {
        let dir = tempdir("e3-program");
        let staging = dir.join("staging");
        let registry = dir.join("registry");
        fs::create_dir_all(staging.join("programs")).unwrap();
        fs::create_dir_all(&registry).unwrap();

        write_program_manifest(&registry, "myprog", "0.1.0");

        let (archive_name, _sha) = archive_name_for(
            &registry,
            "myprog",
            crate::deps_manifest::TargetArch::Wasm32,
            4,
        );

        let archive = staging.join("programs").join(&archive_name);
        fs::write(&archive, b"fake-program-archive").unwrap();

        let manifest_path = dir.join("manifest.json");
        super::run(vec![
            "--in".into(),
            staging.display().to_string(),
            "--out".into(),
            manifest_path.display().to_string(),
            "--tag".into(),
            "binaries-abi-v4".into(),
            "--abi".into(),
            "4".into(),
            "--registry".into(),
            registry.display().to_string(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let entries = json["entries"].as_array().unwrap();
        let entry = entries
            .iter()
            .find(|e| e["program"] == "myprog")
            .expect("myprog entry should be present");
        assert_eq!(entry["kind"], "program");
        assert_eq!(entry["arch"], "wasm32");
        assert_eq!(entry["archive_name"], archive_name.as_str());
        assert_eq!(entry["compatibility"]["target_arch"], "wasm32");
    }

    #[test]
    fn build_manifest_skips_source_kind() {
        let dir = tempdir("e3-source");
        let staging = dir.join("staging");
        let registry = dir.join("registry");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&registry).unwrap();

        write_source_manifest(&registry, "pcre2-source", "10.42");

        let manifest_path = dir.join("manifest.json");
        super::run(vec![
            "--in".into(),
            staging.display().to_string(),
            "--out".into(),
            manifest_path.display().to_string(),
            "--tag".into(),
            "binaries-abi-v4".into(),
            "--abi".into(),
            "4".into(),
            "--registry".into(),
            registry.display().to_string(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let entries = json["entries"].as_array().unwrap();
        assert!(
            entries.iter().all(|e| e["program"] != "pcre2-source"),
            "kind=source must NOT produce a archive entry; got: {:?}",
            entries
        );
    }

    #[test]
    fn build_manifest_sorts_entries_by_name() {
        // Pre-E.3 the manifest concatenated the legacy staging walk
        // (sorted) with the package-system registry walk (sorted), so the two
        // groups were each internally ordered but the merged vec was
        // not. Stage a legacy program archive whose name sorts BETWEEN two
        // package-system lib archive names; without the post-merge sort the legacy
        // entry would land first.
        let dir = tempdir("e3-sort");
        let staging = dir.join("staging");
        let registry = dir.join("registry");
        fs::create_dir_all(staging.join("libs")).unwrap();
        fs::create_dir_all(&registry).unwrap();

        write_lib_manifest(&registry, "alib", "1.0.0");
        write_lib_manifest(&registry, "zlib", "1.0.0");
        // Program manifest is required for legacy staging-walk entries —
        // build_entry looks it up via programs_by_name(registry) for
        // source + license decoration.
        write_program_manifest(&registry, "mprog", "1.0.0");

        let (name_a, _) = archive_name_for(
            &registry,
            "alib",
            crate::deps_manifest::TargetArch::Wasm32,
            4,
        );
        let (name_z, _) = archive_name_for(
            &registry,
            "zlib",
            crate::deps_manifest::TargetArch::Wasm32,
            4,
        );
        fs::write(staging.join("libs").join(&name_a), b"a").unwrap();
        fs::write(staging.join("libs").join(&name_z), b"z").unwrap();
        // legacy staging-walk file at the staging root. The 8-char hex
        // suffix is required by ParsedName::parse.
        let v1_name = "mprog-1.0.0-rev1-deadbeef.zip";
        fs::write(staging.join(v1_name), b"x").unwrap();

        let manifest_path = dir.join("manifest.json");
        super::run(vec![
            "--in".into(),
            staging.display().to_string(),
            "--out".into(),
            manifest_path.display().to_string(),
            "--tag".into(),
            "binaries-abi-v4".into(),
            "--abi".into(),
            "4".into(),
            "--registry".into(),
            registry.display().to_string(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let names: Vec<String> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();

        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "entries must be sorted by name");
        // Sanity: confirm the legacy file actually lands between the package-system
        // archives (proves the test exercises the sort, not just a
        // happy-path ordering).
        let pos_a = names.iter().position(|n| n == &name_a).unwrap();
        let pos_v1 = names.iter().position(|n| n == v1_name).unwrap();
        let pos_z = names.iter().position(|n| n == &name_z).unwrap();
        assert!(pos_a < pos_v1 && pos_v1 < pos_z, "got order: {names:?}");
    }

    #[test]
    fn build_manifest_default_arches_include_both_wasm32_and_wasm64() {
        let dir = tempdir("e3-default-arches");
        let staging = dir.join("staging");
        let registry = dir.join("registry");
        fs::create_dir_all(staging.join("libs")).unwrap();
        fs::create_dir_all(&registry).unwrap();

        write_lib_manifest(&registry, "zlib", "1.3.1");

        // Pre-stage BOTH archives — compute each sha separately because
        // arch is in compute_sha's input.
        let (name32, _) = archive_name_for(
            &registry,
            "zlib",
            crate::deps_manifest::TargetArch::Wasm32,
            4,
        );
        let (name64, _) = archive_name_for(
            &registry,
            "zlib",
            crate::deps_manifest::TargetArch::Wasm64,
            4,
        );
        fs::write(staging.join("libs").join(&name32), b"32bit").unwrap();
        fs::write(staging.join("libs").join(&name64), b"64bit").unwrap();

        let manifest_path = dir.join("manifest.json");
        super::run(vec![
            "--in".into(),
            staging.display().to_string(),
            "--out".into(),
            manifest_path.display().to_string(),
            "--tag".into(),
            "binaries-abi-v4".into(),
            "--abi".into(),
            "4".into(),
            "--registry".into(),
            registry.display().to_string(),
            // NO --arch flags — should default to both.
        ])
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let entries = json["entries"].as_array().unwrap();
        let arches: Vec<&str> = entries
            .iter()
            .filter(|e| e["program"] == "zlib")
            .map(|e| e["arch"].as_str().unwrap())
            .collect();
        assert!(arches.contains(&"wasm32"), "wasm32 missing; got {arches:?}");
        assert!(arches.contains(&"wasm64"), "wasm64 missing; got {arches:?}");
    }
}
