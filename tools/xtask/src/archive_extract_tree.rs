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
    // `--archive -` reads the archive from stdin.
    //
    // Not a convenience. The caller this replaces sometimes holds its archive
    // as BYTES with no path — it reads them out of a VFS image — and the
    // alternative is writing a quarter-gigabyte to a temporary file so a
    // subprocess can read it straight back. A pipe is the same bytes without
    // the round trip, and without a temporary file to leak or to leave
    // world-readable.
    let from_stdin = options.archive.as_os_str() == "-";
    let label = if from_stdin {
        "<stdin>".to_string()
    } else {
        options.archive.display().to_string()
    };
    let bytes = if from_stdin {
        read_bounded(std::io::stdin(), limits.compressed_bytes, &label)?
    } else {
        fs::read(&options.archive)
            .map_err(|e| format!("archive-extract-tree: read {label}: {e}"))?
    };
    let len = bytes.len() as u64;
    if len == 0 || len > limits.compressed_bytes {
        return Err(format!("{label} is outside the accepted size bound"));
    }

    // FORMAT BY MAGIC, not by file name. An archive's extension is a claim by
    // whoever named the file; its first bytes are a claim by whoever wrote it,
    // and only the second is the thing being read. The TypeScript this replaces
    // dispatches the same three ways, and an archive it accepted that this
    // rejected would be a regression nobody would read as one.
    match bytes.as_slice() {
        [0x1f, 0x8b, ..] => {
            let decoder = flate2::read::GzDecoder::new(&bytes[..]);
            return extract_tar(decoder, options, limits, &label);
        }
        [0x28, 0xb5, 0x2f, 0xfd, ..] => {
            let decoder = zstd::stream::read::Decoder::new(&bytes[..])
                .map_err(|e| format!("archive-extract-tree: open zstd stream {label}: {e}"))?;
            return extract_tar(decoder, options, limits, &label);
        }
        [0x50, 0x4b, ..] => {}
        _ => {
            return Err(format!(
                "{label} is not a supported gzip/zstd TAR or ZIP archive"
            ))
        }
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

    create_staging_dir(&options.out)?;

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

/// Unpack a tar stream, whatever decompressed it.
///
/// Read entirely into memory before anything is judged, for the same reason the
/// zip path reads its directory first: a plan cannot refuse an archive it has
/// only seen half of.
fn extract_tar<R: Read>(
    reader: R,
    options: &Options,
    limits: Limits,
    label: &str,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    let mut sources = Vec::new();
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    let mut expanded = 0u64;

    let entries = archive
        .entries()
        .map_err(|e| format!("archive-extract-tree: read tar directory from {label}: {e}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| format!("archive-extract-tree: read tar entry from {label}: {e}"))?;
        if sources.len() >= limits.entries {
            return Err(format!("{label} entry count is outside the accepted bound"));
        }
        let header = entry.header().clone();
        let path = entry
            .path()
            .map_err(|e| format!("archive-extract-tree: {label} entry path: {e}"))?
            .to_string_lossy()
            .into_owned();
        let size = header.size().unwrap_or(0);
        expanded = expanded
            .checked_add(size)
            .ok_or_else(|| format!("{label} expands beyond the accepted bound"))?;
        if expanded > limits.expanded_bytes {
            return Err(format!("{label} expands beyond the accepted bound"));
        }
        let kind = header.entry_type();
        let mut body = Vec::new();
        if kind.is_file() {
            entry
                .read_to_end(&mut body)
                .map_err(|e| format!("archive-extract-tree: read {path} from {label}: {e}"))?;
        }
        sources.push(SourceEntry {
            path,
            is_directory: kind.is_dir(),
            // Symlinks AND hardlinks. Both name a target the archive does not
            // control, and a hardlink additionally aliases bytes that may
            // already have been judged under another name.
            is_link: kind.is_symlink() || kind.is_hard_link(),
            mode: header.mode().unwrap_or(0o644),
        });
        bodies.push(body);
    }
    if sources.is_empty() {
        return Err(format!("{label} entry count is outside the accepted bound"));
    }

    let planned = plan_entries(&sources, label, options.strip_root, options.expect_root.as_deref())?;
    create_staging_dir(&options.out)?;
    for entry in planned.iter() {
        let destination = options.out.join(&entry.path);
        if !destination.starts_with(&options.out) {
            return Err(format!("{label} entry would escape the output directory"));
        }
        if entry.is_directory {
            fs::create_dir_all(&destination).map_err(|e| {
                format!("archive-extract-tree: mkdir {}: {e}", destination.display())
            })?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("archive-extract-tree: mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&destination, &bodies[entry.source_index])
            .map_err(|e| format!("archive-extract-tree: write {}: {e}", destination.display()))?;
        set_mode(&destination, entry.mode)?;
    }
    Ok(())
}

/// Read a stream, refusing one that exceeds `limit`.
///
/// Bounded AS it is read, not after. Reading a hostile stream to the end and
/// then measuring it is the bound arriving too late to matter — the memory is
/// already spent by the time the number is known.
///
/// A separate function so it can be tested with a slice standing in for the
/// pipe: a test cannot hand this process a stdin, and a bound no test can
/// reach is a bound nobody has checked.
fn read_bounded(reader: impl Read, limit: u64, label: &str) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    // One byte past the limit, so exceeding it is observable rather than
    // silently truncated into something that parses.
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut buffer)
        .map_err(|e| format!("archive-extract-tree: read {label}: {e}"))?;
    if buffer.len() as u64 > limit {
        return Err(format!("{label} is outside the accepted size bound"));
    }
    Ok(buffer)
}

/// Create the staging directory at 0o700, as the TypeScript does.
///
/// A staging tree is world-readable for the whole time it is being populated
/// otherwise, which is a window nobody needs and nothing gains from.
fn create_staging_dir(out: &Path) -> Result<(), String> {
    fs::create_dir_all(out)
        .map_err(|e| format!("archive-extract-tree: create {}: {e}", out.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(out, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("archive-extract-tree: chmod {}: {e}", out.display()))?;
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

    /// A gzip-compressed tar, built in memory.
    fn targz_with(entries: &[(&str, &[u8], u32, bool)]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (name, body, mode, is_dir) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_mode(*mode);
                header.set_size(if *is_dir { 0 } else { body.len() as u64 });
                header.set_entry_type(if *is_dir {
                    tar::EntryType::Directory
                } else {
                    tar::EntryType::Regular
                });
                header.set_cksum();
                builder.append_data(&mut header, *name, &body[..]).expect("append");
            }
            builder.finish().expect("finish tar");
        }
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar_bytes).expect("gzip");
        encoder.finish().expect("gzip finish")
    }

    #[test]
    fn a_gzipped_tar_extracts_by_its_MAGIC_not_its_name() {
        // The file is called `a.zip` deliberately. An extension is a claim by
        // whoever named the file; the first bytes are a claim by whoever wrote
        // it, and only the second is the thing being read.
        let scratch = Scratch::new("targz");
        let archive = scratch.write(
            "a.zip",
            &targz_with(&[
                ("pkg/", b"", 0o755, true),
                ("pkg/bin/tool", b"tool bytes", 0o755, false),
            ]),
        );
        extract_tree(
            &options(archive, scratch.out(), true, Some("pkg")),
            Limits::default(),
        )
        .expect("extracted");
        assert_eq!(
            fs::read(scratch.out().join("bin/tool")).expect("tool"),
            b"tool bytes",
        );
    }

    #[test]
    fn each_tar_bound_refuses_on_its_own_too() {
        // The tar path carries its OWN copies of the entry-count and expanded
        // -size checks, because it streams where the zip path reads a central
        // directory. `each_bound_refuses_on_its_own` above uses a ZIP, so it
        // proves nothing about these — two mutants survived saying exactly
        // that. Duplicated logic needs duplicated tests, or half of it is
        // defended by nothing.
        let scratch = Scratch::new("tarbounds");
        let archive = scratch.write(
            "a.tgz",
            &targz_with(&[
                ("a", b"aaaaaaaaaa", 0o644, false),
                ("b", b"bbbbbbbbbb", 0o644, false),
            ]),
        );
        let opts = || options(archive.clone(), scratch.out(), false, None);
        assert!(extract_tree(&opts(), Limits::default()).is_ok(), "unbounded, it extracts");
        assert!(
            extract_tree(&opts(), Limits { entries: 1, ..Limits::default() }).is_err(),
            "entry count",
        );
        assert!(
            extract_tree(&opts(), Limits { expanded_bytes: 5, ..Limits::default() }).is_err(),
            "expanded size — the bound a decompression bomb crosses while the \
             archive on disk stays small",
        );
    }

    #[test]
    fn a_tar_hardlink_is_refused_like_a_symlink() {
        // A hardlink names a target the archive does not control, and aliases
        // bytes that may already have been judged under another name.
        let scratch = Scratch::new("hardlink");
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Link);
            header.set_link_name("pkg/real").expect("link name");
            header.set_cksum();
            builder.append_data(&mut header, "pkg/alias", &[][..]).expect("append");
            builder.finish().expect("finish");
        }
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar_bytes).expect("gzip");
        let archive = scratch.write("a.tgz", &encoder.finish().expect("gzip finish"));
        assert!(extract_tree(
            &options(archive, scratch.out(), false, None),
            Limits::default()
        )
        .is_err());
    }

    #[test]
    fn an_archive_in_no_supported_format_is_refused_by_name() {
        // Not "read it as a zip and fail confusingly" — say which three
        // formats are supported, because that is the actionable sentence.
        let scratch = Scratch::new("unknown");
        let archive = scratch.write("a.bin", b"not an archive at all");
        let error = extract_tree(
            &options(archive, scratch.out(), false, None),
            Limits::default(),
        )
        .expect_err("refused");
        assert!(error.contains("not a supported"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn the_staging_directory_is_not_world_readable_while_it_fills() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("staging");
        let archive = scratch.write("a.zip", &zip_with(&[("f", b"x", 0o644)]));
        extract_tree(
            &options(archive, scratch.out(), false, None),
            Limits::default(),
        )
        .expect("extracted");
        let mode = fs::metadata(scratch.out()).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "the staging tree is the extractor's own");
    }

    #[test]
    fn a_bounded_read_refuses_a_stream_that_exceeds_its_limit() {
        assert_eq!(read_bounded(&b"abcd"[..], 10, "fixture").expect("under"), b"abcd");
        assert_eq!(read_bounded(&b"abcd"[..], 4, "fixture").expect("exact"), b"abcd");
        assert!(read_bounded(&b"abcde"[..], 4, "fixture").is_err(), "one byte over");
    }

    /// A stream that never ends, and notices being over-read.
    ///
    /// A finite slice cannot test the `take`: five bytes exceed a four-byte
    /// limit whether or not the read is bounded, so the length check refuses
    /// either way and the mutant survives. The `take` is a MEMORY bound, and
    /// the only thing that can observe it is a stream that would not stop.
    struct Endless {
        read: usize,
    }

    impl Read for Endless {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.read += buf.len();
            assert!(
                self.read < 1 << 20,
                "read {} bytes from an endless stream: the bound is not \
                 stopping the read, only measuring it afterwards",
                self.read,
            );
            buf.fill(0);
            Ok(buf.len())
        }
    }

    #[test]
    fn a_bounded_read_stops_reading_rather_than_measuring_afterwards() {
        // The property the length check cannot express: an endless stream must
        // be ABANDONED near the limit, not consumed and then judged. Without
        // the `take` this runs until the reader's own assertion fires — which
        // is H-11's mutant-detectable-by-hanging, made to fail fast instead.
        let error = read_bounded(Endless { read: 0 }, 64, "fixture")
            .expect_err("an endless stream exceeds any limit");
        assert!(error.contains("outside the accepted size bound"), "{error}");
    }

    #[test]
    fn a_dash_names_stdin_and_is_not_a_file_called_dash() {
        // The parse, not the read: a test cannot hand this process a stdin,
        // but it can pin that `-` is recognised rather than opened as a path.
        // Proven end to end by piping a zip through the real verb; pinned here
        // so a refactor cannot quietly turn `-` back into a filename.
        let args = ["--archive", "-", "--out", "o"].map(str::to_string).to_vec();
        let parsed = parse_args(args).expect("parsed");
        assert_eq!(parsed.archive.as_os_str(), "-");
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
