//! Generate a binary-release `manifest.json` from a staging directory.
//!
//! Walks the given directory (non-recursively — the release namespace
//! is intentionally flat, see `docs/binary-releases.md`), computes
//! SHA-256 of every file, extracts `__abi_version` from wasm files
//! that export it, and writes a deterministic JSON manifest.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_posix_shared as shared;

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
                // Escape hatch so reproducible builds / tests can pin the
                // timestamp rather than capturing wall-clock time.
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

    let mut entries = Vec::new();
    let mut read_dir: Vec<_> = std::fs::read_dir(&in_dir)
        .map_err(|e| format!("read dir {}: {e}", in_dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("read dir entry: {e}"))?;
    read_dir.sort_by_key(|e| e.file_name());

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
        // Skip the manifest itself if it happens to be in the staging
        // dir already — we don't want the manifest to contain itself.
        if name == "manifest.json" {
            continue;
        }
        entries.push(build_entry(&path, &name)?);
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

fn build_entry(path: &Path, name: &str) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hex_lower(&hasher.finalize());

    let (kind, abi_version) = classify(name, &bytes);

    let mut m: JsonMap = BTreeMap::new();
    m.insert("name".into(), json!(name));
    m.insert("kind".into(), json!(kind));
    m.insert("size".into(), json!(bytes.len()));
    m.insert("sha256".into(), json!(hash));
    m.insert(
        "abi_version".into(),
        match abi_version {
            Some(v) => json!(v),
            None => Value::Null,
        },
    );
    Ok(Value::Object(m.into_iter().collect()))
}

/// Produce a `(kind, abi_version)` tuple for an asset.
///
/// `kind` is auto-detected from filename + (for wasm) module exports.
/// `abi_version` is extracted from the `__abi_version` function export
/// if the function body is a single `i32.const N` / `i64.const N`
/// instruction — which is how `channel_syscall.c` compiles it.
fn classify(name: &str, bytes: &[u8]) -> (&'static str, Option<i64>) {
    if name.ends_with(".tar.zst")
        || name.ends_with(".tar.gz")
        || name.ends_with(".tar")
        || name.ends_with(".zip")
    {
        return ("vfs-image", None);
    }
    if !name.ends_with(".wasm") {
        return ("asset", None);
    }
    // wasm: inspect for marker kind hints
    let abi_version = extract_abi_version(bytes);
    let kind = if name.contains("kernel") {
        "kernel"
    } else if name.contains("userspace") {
        "userspace"
    } else {
        "program"
    };
    (kind, abi_version)
}

fn extract_abi_version(bytes: &[u8]) -> Option<i64> {
    use wasmparser::{ExternalKind, FunctionBody, Operator, Parser, Payload, TypeRef};

    // Find the local-function index for `__abi_version` and then
    // inspect its body. Signature-level info isn't enough — we need
    // the constant return value.
    let mut imported_funcs: u32 = 0;
    let mut export_func_idx: Option<u32> = None;
    let mut code_bodies: Vec<FunctionBody> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.ok()?;
        match payload {
            Payload::ImportSection(r) => {
                for group in r {
                    let group = group.ok()?;
                    let tick = |ty: TypeRef, imp: &mut u32| match ty {
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => *imp += 1,
                        _ => {}
                    };
                    match group {
                        wasmparser::Imports::Single(_, i) => tick(i.ty, &mut imported_funcs),
                        wasmparser::Imports::Compact1 { items, .. } => {
                            for item in items {
                                let item = item.ok()?;
                                tick(item.ty, &mut imported_funcs);
                            }
                        }
                        wasmparser::Imports::Compact2 { ty, names, .. } => {
                            for n in names {
                                let _ = n.ok()?;
                                tick(ty, &mut imported_funcs);
                            }
                        }
                    }
                }
            }
            Payload::ExportSection(r) => {
                for exp in r {
                    let exp = exp.ok()?;
                    if exp.name == "__abi_version"
                        && matches!(exp.kind, ExternalKind::Func | ExternalKind::FuncExact)
                    {
                        export_func_idx = Some(exp.index);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                code_bodies.push(body);
            }
            _ => {}
        }
    }

    let exp_idx = export_func_idx?;
    // Export index is absolute (imports + locals). Code section
    // entries are 0..N over local functions only.
    if exp_idx < imported_funcs {
        return None; // __abi_version was imported, not local — unusual
    }
    let local_idx = (exp_idx - imported_funcs) as usize;
    let body = code_bodies.get(local_idx)?;

    let mut reader = body.get_operators_reader().ok()?;
    let first = reader.read().ok()?;
    match first {
        Operator::I32Const { value } => Some(value as i64),
        Operator::I64Const { value } => Some(value),
        _ => None,
    }
}

fn verify_tag_matches_abi(tag: &str, abi_version: u32) -> Result<(), String> {
    // Accept either `binaries-abi-v<N>` prefix (dated tag) or
    // `binaries-abi-v<N>-anything`. The first component determines
    // the claimed ABI.
    let prefix = format!("binaries-abi-v{abi_version}");
    if tag == prefix || tag.starts_with(&format!("{prefix}-")) {
        Ok(())
    } else {
        Err(format!(
            "tag {tag:?} does not begin with {prefix:?} — refusing to \
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

/// Minimalist ISO-8601 UTC printer. We don't pull in chrono for a
/// single field that the manifest uses as provenance only. Format:
/// `YYYY-MM-DDTHH:MM:SSZ`.
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
    let day = day + 1; // 1-indexed
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
