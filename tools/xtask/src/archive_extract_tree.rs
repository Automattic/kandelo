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

/// The bounds, injectable the way `archive-extract-member` injects its own.
///
/// Not for flexibility — no caller may loosen these — but so a test can prove
/// a bound refuses without building a 256 MiB archive to do it. A bound that
/// is only ever tested by not being hit is a bound nobody has tested.
#[derive(Clone, Copy)]
struct Limits {
    compressed_bytes: u64,
    entries: usize,
    expanded_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            compressed_bytes: MAX_BUNDLE_BYTES,
            entries: MAX_BUNDLE_ENTRIES,
            expanded_bytes: MAX_SOURCE_TREE_BYTES,
        }
    }
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let options = parse_args(args)?;
    extract_tree(&options, Limits::default())
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

fn extract_tree(options: &Options, limits: Limits) -> Result<(), String> {
    let label = options.archive.display().to_string();
    let bytes = fs::read(&options.archive)
        .map_err(|e| format!("archive-extract-tree: read {label}: {e}"))?;
    let len = bytes.len() as u64;
    if len == 0 || len > limits.compressed_bytes {
        return Err(format!("{label} is outside the accepted size bound"));
    }

    let reader = std::io::Cursor::new(&bytes[..]);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| format!("archive-extract-tree: read {label} as a zip: {e}"))?;
    if zip.len() == 0 || zip.len() > limits.entries {
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
        if expanded > limits.expanded_bytes {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// A zip built in memory, so a test can produce archives `zip(1)` refuses
    /// to — which is exactly the shape a hostile one has.
    fn zip_with(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            for (name, body, mode) in entries {
                let options = SimpleFileOptions::default().unix_permissions(*mode);
                if name.ends_with('/') {
                    writer.add_directory(*name, options).expect("dir");
                } else {
                    writer.start_file(*name, options).expect("file");
                    writer.write_all(body).expect("write");
                }
            }
            writer.finish().expect("finish");
        }
        cursor.into_inner()
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("xtask-aet-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("scratch");
            Self(dir)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).expect("write archive");
            path
        }
        fn out(&self) -> PathBuf {
            self.0.join("out")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn options(archive: PathBuf, out: PathBuf, strip: bool, expect: Option<&str>) -> Options {
        Options {
            archive,
            out,
            strip_root: strip,
            expect_root: expect.map(str::to_string),
        }
    }

    #[test]
    fn a_tree_extracts_with_its_single_root_stripped() {
        let scratch = Scratch::new("good");
        let archive = scratch.write(
            "a.zip",
            &zip_with(&[
                ("pkg/", b"", 0o755),
                ("pkg/bin/", b"", 0o755),
                ("pkg/bin/tool", b"tool bytes", 0o755),
                ("pkg/README", b"readme", 0o644),
            ]),
        );
        extract_tree(
            &options(archive, scratch.out(), true, Some("pkg")),
            Limits::default(),
        )
        .expect("extracted");
        assert_eq!(fs::read(scratch.out().join("bin/tool")).expect("tool"), b"tool bytes");
        assert_eq!(fs::read(scratch.out().join("README")).expect("readme"), b"readme");
        // The root itself is stripped, not recreated underneath.
        assert!(!scratch.out().join("pkg").exists());
    }

    #[test]
    fn a_traversing_member_lands_nothing_at_all() {
        // The archive `zip(1)` will not build. Note the assertion is not only
        // that the call failed: a refusal that had already written the safe
        // member would leave a tree a later step builds on.
        let scratch = Scratch::new("evil");
        let archive = scratch.write(
            "a.zip",
            &zip_with(&[("pkg/ok", b"fine", 0o644), ("pkg/../../escaped", b"pwned", 0o644)]),
        );
        assert!(extract_tree(
            &options(archive, scratch.out(), false, None),
            Limits::default()
        )
        .is_err());
        assert!(!scratch.out().join("pkg/ok").exists(), "nothing was written");
    }

    #[test]
    #[cfg(unix)]
    fn a_mode_word_is_narrowed_to_permissions_before_it_reaches_the_filesystem() {
        // Tested against `set_mode` directly, and NOT redundant with the
        // extraction test below — that one cannot express this.
        //
        // The `zip` crate masks `unix_permissions` to 0o777 on write and ORs
        // `S_IFREG` back in on read, so an archive built with it always reports
        // `0o100755` and there is no way to round-trip a setuid bit through it.
        // Archives are not only built with it. A zip's external attributes hold
        // a full mode word, and one crafted elsewhere can carry `0o4755` —
        // which `chmod` honours, because it ignores only the bits ABOVE
        // `0o7777` and setuid is not one of them.
        //
        // So this is the test that keeps the narrowing honest, and it must not
        // be deleted as duplicative of an end-to-end test that cannot reach it.
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("mode-unit");
        let path = scratch.write("f", b"x");
        set_mode(&path, 0o104755).expect("chmod");
        let mode = fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o7777, 0o755, "permission bits only");
        assert_eq!(mode & 0o4000, 0, "and never setuid, whatever the archive said");
    }

    #[test]
    fn an_archive_members_type_bits_never_reach_the_filesystem() {
        // A mode word carries type bits beside permissions, and `0o104755` is
        // a regular file that is also setuid. Handing the whole word to
        // `set_permissions` is how an extracted file acquires a setuid bit
        // nobody in this repository put there.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let scratch = Scratch::new("mode");
            let archive = scratch.write("a.zip", &zip_with(&[("f", b"x", 0o104755)]));
            extract_tree(
                &options(archive, scratch.out(), false, None),
                Limits::default(),
            )
            .expect("extracted");
            let mode = fs::metadata(scratch.out().join("f")).expect("stat").permissions().mode();
            assert_eq!(mode & 0o7777, 0o755, "permission bits only");
            assert_eq!(mode & 0o4000, 0, "and never setuid");
        }
    }

    #[test]
    fn each_bound_refuses_on_its_own() {
        let scratch = Scratch::new("bounds");
        let archive = scratch.write(
            "a.zip",
            &zip_with(&[("a", b"aaaaaaaaaa", 0o644), ("b", b"bbbbbbbbbb", 0o644)]),
        );
        let opts = || options(archive.clone(), scratch.out(), false, None);
        assert!(extract_tree(&opts(), Limits::default()).is_ok(), "unbounded, it extracts");

        // Compressed size.
        assert!(extract_tree(
            &opts(),
            Limits { compressed_bytes: 1, ..Limits::default() }
        )
        .is_err());
        // Entry count.
        assert!(extract_tree(&opts(), Limits { entries: 1, ..Limits::default() }).is_err());
        // Expanded size — the bound a zip bomb crosses while staying small on
        // disk, so it is the one that must not be inferred from the other two.
        assert!(extract_tree(
            &opts(),
            Limits { expanded_bytes: 5, ..Limits::default() }
        )
        .is_err());
    }

    #[test]
    fn an_expected_root_that_does_not_match_is_refused() {
        let scratch = Scratch::new("root");
        let archive = scratch.write(
            "a.zip",
            &zip_with(&[("other/", b"", 0o755), ("other/f", b"x", 0o644)]),
        );
        assert!(extract_tree(
            &options(archive, scratch.out(), true, Some("pkg")),
            Limits::default()
        )
        .is_err());
    }

    #[test]
    fn an_expected_root_without_stripping_is_refused_at_the_arguments() {
        // Asking which top-level directory an archive has, while telling the
        // extractor not to work one out, is a question with no answer. Silently
        // accepting it would answer a different one.
        let args = ["--archive", "a.zip", "--out", "o", "--expect-root", "pkg"]
            .map(str::to_string)
            .to_vec();
        assert!(parse_args(args).is_err());
    }
}
