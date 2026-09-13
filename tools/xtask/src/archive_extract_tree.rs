//! `xtask archive-extract-tree` — unpack a whole archive into a staging tree.
//!
//! The half of the `staged-product-inputs.ts` port that WRITES, and the caller
//! [`crate::archive_paths`] was waiting for. Its sibling
//! `archive-extract-member` deliberately unpacks one member and no tree; this
//! is the tree case, with the same posture: judge everything first, publish
//! nothing until it is all judged.
//!
//! # The bounds are part of the contract, not a local opinion
//!
//! The TypeScript this replaces refuses an archive over 256 MiB compressed,
//! over 100,000 entries, or expanding past 512 MiB. Those numbers move here
//! unchanged, because an archive that the old path refused and the new path
//! accepts is a regression that no test would notice — it looks like success.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::archive_paths::{plan_entries, SourceEntry};

/// Compressed bytes accepted from one bundle.
const MAX_BUNDLE_BYTES: u64 = 256 * 1024 * 1024;
/// Entries accepted from one bundle.
const MAX_BUNDLE_ENTRIES: usize = 100_000;
/// Bytes the bundle may expand to.
const MAX_SOURCE_TREE_BYTES: u64 = 512 * 1024 * 1024;

struct Options {
    archive: PathBuf,
    out: PathBuf,
    strip_root: bool,
    expect_root: Option<String>,
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let options = parse_args(args)?;
    extract_tree(&options)
}

fn parse_args(args: Vec<String>) -> Result<Options, String> {
    let mut archive = None;
    let mut out = None;
    let mut strip_root = false;
    let mut expect_root = None;
    let mut rest = args.into_iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--archive" => archive = Some(PathBuf::from(require_value(&mut rest, "--archive")?)),
            "--out" => out = Some(PathBuf::from(require_value(&mut rest, "--out")?)),
            "--strip-root" => strip_root = true,
            "--expect-root" => expect_root = Some(require_value(&mut rest, "--expect-root")?),
            other => return Err(format!("archive-extract-tree: unknown argument {other}")),
        }
    }
    // `--expect-root` without `--strip-root` asks a question nothing computes
    // an answer to. Accepting it would be answering a different question.
    if expect_root.is_some() && !strip_root {
        return Err("archive-extract-tree: --expect-root requires --strip-root".to_string());
    }
    Ok(Options {
        archive: archive.ok_or("archive-extract-tree: --archive is required")?,
        out: out.ok_or("archive-extract-tree: --out is required")?,
        strip_root,
        expect_root,
    })
}

fn require_value(
    rest: &mut impl Iterator<Item = String>,
    flag: &str,
) -> Result<String, String> {
    rest.next()
        .ok_or_else(|| format!("archive-extract-tree: {flag} needs a value"))
}

fn extract_tree(options: &Options) -> Result<(), String> {
    let label = options.archive.display().to_string();
    let bytes = fs::read(&options.archive)
        .map_err(|e| format!("archive-extract-tree: read {label}: {e}"))?;
    let len = bytes.len() as u64;
    if len == 0 || len > MAX_BUNDLE_BYTES {
        return Err(format!("{label} is outside the accepted size bound"));
    }

    let reader = std::io::Cursor::new(&bytes[..]);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| format!("archive-extract-tree: read {label} as a zip: {e}"))?;
    if zip.len() == 0 || zip.len() > MAX_BUNDLE_ENTRIES {
        return Err(format!("{label} entry count is outside the accepted bound"));
    }

    // Read the directory FIRST, in full, so the plan judges the whole archive
    // before a byte is written.
    let mut sources = Vec::with_capacity(zip.len());
    let mut expanded = 0u64;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|e| format!("archive-extract-tree: {label} entry {index}: {e}"))?;
        expanded = expanded
            .checked_add(entry.size())
            .ok_or_else(|| format!("{label} expands beyond the accepted bound"))?;
        if expanded > MAX_SOURCE_TREE_BYTES {
            return Err(format!("{label} expands beyond the accepted bound"));
        }
        sources.push(SourceEntry {
            path: entry.name().to_string(),
            is_directory: entry.is_dir(),
            is_link: entry.is_symlink(),
            mode: entry.unix_mode().unwrap_or(if entry.is_dir() { 0o755 } else { 0o644 }),
        });
    }

    let planned = plan_entries(
        &sources,
        &label,
        options.strip_root,
        options.expect_root.as_deref(),
    )?;

    fs::create_dir_all(&options.out)
        .map_err(|e| format!("archive-extract-tree: create {}: {e}", options.out.display()))?;

    for entry in planned.iter() {
        let destination = options.out.join(&entry.path);
        // Belt on braces: the plan already refused every path that could leave
        // the output directory, and this says so again where the write happens.
        // A rule proven far from its use is a rule someone can move away from.
        if !destination.starts_with(&options.out) {
            return Err(format!("{label} entry would escape the output directory"));
        }
        if entry.is_directory {
            fs::create_dir_all(&destination)
                .map_err(|e| format!("archive-extract-tree: mkdir {}: {e}", destination.display()))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("archive-extract-tree: mkdir {}: {e}", parent.display())
            })?;
        }
        let mut source = zip
            .by_index(entry.source_index)
            .map_err(|e| format!("archive-extract-tree: {label} member: {e}"))?;
        let mut contents = Vec::with_capacity(source.size() as usize);
        source
            .read_to_end(&mut contents)
            .map_err(|e| format!("archive-extract-tree: read {}: {e}", entry.path))?;
        fs::write(&destination, &contents)
            .map_err(|e| format!("archive-extract-tree: write {}: {e}", destination.display()))?;
        set_mode(&destination, entry.mode)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    // Only the permission bits: an archive's mode word carries type bits too,
    // and handing those to `set_permissions` is how an extracted file acquires
    // a setuid bit nobody in this repository put there.
    let permissions = fs::Permissions::from_mode(mode & 0o777);
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("archive-extract-tree: chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}
