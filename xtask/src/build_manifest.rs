//! Generate a binary-release `manifest.json` from a staging directory.
//!
//! Walks the given directory (non-recursively — the release namespace
//! is intentionally flat, see `docs/binary-releases.md`), computes
//! SHA-256 of every file, extracts metadata from filenames and
//! `abi/program-metadata.toml`, and writes a deterministic JSON
//! manifest that conforms to `abi/manifest.schema.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_posix_shared as shared;

use crate::program_metadata::{load_program_metadata, ProgramMetadata};
use crate::wasm_abi::extract_abi_version;
use crate::JsonMap;

const GENERATOR: &str = concat!("cargo xtask build-manifest ", env!("CARGO_PKG_VERSION"));

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut in_dir: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut tag: Option<String> = None;
    let mut generated_at: Option<String> = None;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--in" => in_dir = Some(it.next().ok_or("--in requires a path")?.into()),
            "--out" => out_path = Some(it.next().ok_or("--out requires a path")?.into()),
            "--tag" => tag = Some(it.next().ok_or("--tag requires a value")?),
            "--generated-at" => {
                generated_at = Some(it.next().ok_or("--generated-at requires an ISO-8601 value")?)
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let in_dir = in_dir.ok_or("--in <staging-dir> is required")?;
    let out_path = out_path.ok_or("--out <manifest.json path> is required")?;
    let tag = tag.ok_or("--tag <release-tag> is required")?;

    verify_tag_matches_abi(&tag, shared::ABI_VERSION)?;

    let generated_at = generated_at.unwrap_or_else(current_utc_iso);

    let program_meta = load_program_metadata()?;

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

    let mut root: JsonMap = BTreeMap::new();
    root.insert("abi_version".into(), json!(shared::ABI_VERSION));
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
    program_meta: &BTreeMap<String, ProgramMetadata>,
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
            "no entry for program {:?} in abi/program-metadata.toml — \
             every shipped asset must declare source + license",
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
    m.insert("source".into(), meta.source_value());
    m.insert("license".into(), meta.license_value());
    m.insert("advisories".into(), Value::Array(Vec::new()));

    Ok(Value::Object(m.into_iter().collect()))
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
                     from abi/program-metadata.toml. Add the program or rename \
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

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

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

fn render_deterministic(root: &JsonMap) -> String {
    let value = Value::Object(root.clone().into_iter().collect());
    let mut s = serde_json::to_string_pretty(&value).expect("serialize");
    s.push('\n');
    s
}
