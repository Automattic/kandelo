//! `xtask archive-extract-member` — copy one package member to one file.
//!
//! The command deliberately does not unpack an archive tree. It streams one
//! exact regular member into a private sibling file, validates the remainder
//! of the archive, and only then publishes the complete output atomically.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::package_archive_limits::{
    MAX_PACKAGE_ARCHIVE_DECOMPRESSED_BYTES, MAX_PACKAGE_ARCHIVE_MEMBER_BYTES,
};

const TEMP_FILE_ATTEMPTS: usize = 1_024;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Eq, PartialEq)]
struct Options {
    archive: PathBuf,
    member: String,
    out: PathBuf,
}

#[derive(Clone, Copy)]
struct Limits {
    decompressed_bytes: u64,
    member_bytes: u64,
}

const PACKAGE_LIMITS: Limits = Limits {
    decompressed_bytes: MAX_PACKAGE_ARCHIVE_DECOMPRESSED_BYTES,
    member_bytes: MAX_PACKAGE_ARCHIVE_MEMBER_BYTES,
};

/// Copy one exact regular member from a `.tar.zst` package archive.
///
/// Usage:
///
/// ```text
/// cargo xtask archive-extract-member \
///   --archive <package.tar.zst> \
///   --member <portable/relative/path> \
///   --out <new-file>
/// ```
///
/// The output must not already exist. This no-replace contract prevents two
/// concurrent candidates from silently replacing one another.
pub fn run(args: Vec<String>) -> Result<(), String> {
    let options = parse_args(args)?;
    validate_member_request(&options.member)?;
    extract_member(
        &options.archive,
        &options.member,
        &options.out,
        PACKAGE_LIMITS,
    )
}

fn parse_args(args: Vec<String>) -> Result<Options, String> {
    let mut archive = None;
    let mut member = None;
    let mut out = None;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--archive" => {
                let value = args
                    .next()
                    .ok_or_else(|| "archive-extract-member: --archive needs a path".to_string())?;
                assign_once(&mut archive, PathBuf::from(value), "--archive")?;
            }
            "--member" => {
                let value = args
                    .next()
                    .ok_or_else(|| "archive-extract-member: --member needs a path".to_string())?;
                assign_once(&mut member, value, "--member")?;
            }
            "--out" => {
                let value = args
                    .next()
                    .ok_or_else(|| "archive-extract-member: --out needs a path".to_string())?;
                assign_once(&mut out, PathBuf::from(value), "--out")?;
            }
            _ if arg.starts_with("--archive=") => {
                assign_once(
                    &mut archive,
                    PathBuf::from(arg.trim_start_matches("--archive=")),
                    "--archive",
                )?;
            }
            _ if arg.starts_with("--member=") => {
                assign_once(
                    &mut member,
                    arg.trim_start_matches("--member=").to_string(),
                    "--member",
                )?;
            }
            _ if arg.starts_with("--out=") => {
                assign_once(
                    &mut out,
                    PathBuf::from(arg.trim_start_matches("--out=")),
                    "--out",
                )?;
            }
            _ => {
                return Err(format!("archive-extract-member: unknown argument {arg:?}"));
            }
        }
    }

    Ok(Options {
        archive: archive
            .ok_or_else(|| "archive-extract-member: --archive <path> is required".to_string())?,
        member: member
            .ok_or_else(|| "archive-extract-member: --member <path> is required".to_string())?,
        out: out.ok_or_else(|| "archive-extract-member: --out <path> is required".to_string())?,
    })
}

fn assign_once<T>(slot: &mut Option<T>, value: T, flag: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        return Err(format!(
            "archive-extract-member: {flag} may be provided only once"
        ));
    }
    Ok(())
}

fn validate_member_request(member: &str) -> Result<(), String> {
    let invalid = member.is_empty()
        || member.len() > 4_096
        || member.contains('\0')
        || member.contains('\\')
        || member.starts_with('/')
        || member.ends_with('/')
        || member.split('/').any(|component| {
            component.is_empty() || component == "." || component == ".." || component.len() > 255
        })
        || Path::new(member).is_absolute()
        || Path::new(member)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)));
    if invalid {
        return Err(format!(
            "archive-extract-member: --member must be a normalized portable relative path, got {member:?}"
        ));
    }
    Ok(())
}

fn extract_member(
    archive_path: &Path,
    requested_member: &str,
    out: &Path,
    limits: Limits,
) -> Result<(), String> {
    ensure_destination_absent(out)?;
    let archive_file = File::open(archive_path).map_err(|e| {
        format!(
            "archive-extract-member: open archive {}: {e}",
            archive_path.display()
        )
    })?;
    let archive_metadata = archive_file.metadata().map_err(|e| {
        format!(
            "archive-extract-member: inspect archive {}: {e}",
            archive_path.display()
        )
    })?;
    if !archive_metadata.is_file() {
        return Err(format!(
            "archive-extract-member: archive must be a regular file: {}",
            archive_path.display()
        ));
    }

    let decoder = zstd::stream::read::Decoder::new(BufReader::new(archive_file)).map_err(|e| {
        format!(
            "archive-extract-member: open zstd stream {}: {e}",
            archive_path.display()
        )
    })?;
    let bounded = CappedReader::new(
        decoder,
        limits.decompressed_bytes,
        "decompressed package archive",
    );
    let mut archive = tar::Archive::new(bounded);
    let mut staged = None;
    let mut matches = 0usize;

    {
        let entries = archive.entries().map_err(|e| {
            format!(
                "archive-extract-member: read tar directory from {}: {e}",
                archive_path.display()
            )
        })?;
        for entry in entries {
            let mut entry = entry.map_err(|e| {
                format!(
                    "archive-extract-member: read tar entry from {}: {e}",
                    archive_path.display()
                )
            })?;
            if entry.path_bytes().as_ref() != requested_member.as_bytes() {
                continue;
            }

            matches += 1;
            if matches > 1 {
                return Err(format!(
                    "archive-extract-member: member {requested_member:?} appears more than once in {}",
                    archive_path.display()
                ));
            }
            if entry.header().entry_type() != tar::EntryType::Regular {
                return Err(format!(
                    "archive-extract-member: member {requested_member:?} is not a regular file in {}",
                    archive_path.display()
                ));
            }
            let declared_size = entry.size();
            if declared_size > limits.member_bytes {
                return Err(format!(
                    "archive-extract-member: member {requested_member:?} declares {declared_size} bytes, exceeding the {}-byte package member limit",
                    limits.member_bytes
                ));
            }

            let mut output = StagedOutput::new(out)?;
            let stage_path = output.path().to_path_buf();
            let copied = {
                let mut writer = BufWriter::new(output.file_mut()?);
                let copied = io::copy(&mut entry, &mut writer).map_err(|e| {
                    format!(
                        "archive-extract-member: copy member {requested_member:?} from {}: {e}",
                        archive_path.display()
                    )
                })?;
                writer.flush().map_err(|e| {
                    format!(
                        "archive-extract-member: flush staged member {}: {e}",
                        stage_path.display()
                    )
                })?;
                copied
            };
            if copied != declared_size {
                return Err(format!(
                    "archive-extract-member: member {requested_member:?} declared {declared_size} bytes but yielded {copied}"
                ));
            }
            staged = Some(output);
        }
    }

    // WHY: finding the member is not enough. A duplicate or truncated tail
    // must invalidate the candidate before its output becomes visible.
    let mut bounded = archive.into_inner();
    io::copy(&mut bounded, &mut io::sink()).map_err(|e| {
        format!(
            "archive-extract-member: validate the remainder of {}: {e}",
            archive_path.display()
        )
    })?;

    let staged = staged.ok_or_else(|| {
        format!(
            "archive-extract-member: member {requested_member:?} is missing from {}",
            archive_path.display()
        )
    })?;
    staged.publish()
}

fn ensure_destination_absent(out: &Path) -> Result<(), String> {
    let parent = out
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent_metadata = fs::metadata(parent).map_err(|e| {
        format!(
            "archive-extract-member: inspect output parent {}: {e}",
            parent.display()
        )
    })?;
    if !parent_metadata.is_dir() {
        return Err(format!(
            "archive-extract-member: output parent is not a directory: {}",
            parent.display()
        ));
    }
    if out.file_name().is_none() {
        return Err(format!(
            "archive-extract-member: --out must name a file, got {}",
            out.display()
        ));
    }
    match fs::symlink_metadata(out) {
        Ok(_) => Err(format!(
            "archive-extract-member: refusing to replace existing output {}",
            out.display()
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "archive-extract-member: inspect output {}: {e}",
            out.display()
        )),
    }
}

struct StagedOutput {
    destination: PathBuf,
    path: PathBuf,
    file: Option<File>,
    published: bool,
}

impl StagedOutput {
    fn new(destination: &Path) -> Result<Self, String> {
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        for _ in 0..TEMP_FILE_ATTEMPTS {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".archive-extract-member-{}-{sequence}.tmp",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        destination: destination.to_path_buf(),
                        path,
                        file: Some(file),
                        published: false,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(format!(
                        "archive-extract-member: create private stage {}: {e}",
                        path.display()
                    ));
                }
            }
        }
        Err(format!(
            "archive-extract-member: could not allocate a private stage below {}",
            parent.display()
        ))
    }

    fn file_mut(&mut self) -> Result<&mut File, String> {
        self.file.as_mut().ok_or_else(|| {
            "archive-extract-member: internal error: staged output is already closed".to_string()
        })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn publish(mut self) -> Result<(), String> {
        let file = self.file.take().ok_or_else(|| {
            "archive-extract-member: internal error: staged output is already closed".to_string()
        })?;
        file.sync_all().map_err(|e| {
            format!(
                "archive-extract-member: sync complete staged output {}: {e}",
                self.path.display()
            )
        })?;
        drop(file);

        // WHY: the early existence check is only diagnostic; another writer
        // can race it. A no-replace rename is the publication boundary that
        // guarantees neither candidate overwrites the other.
        rename_no_replace(&self.path, &self.destination).map_err(|e| {
            format!(
                "archive-extract-member: publish {} as {} without replacement: {e}",
                self.path.display(),
                self.destination.display()
            )
        })?;
        self.published = true;
        Ok(())
    }
}

impl Drop for StagedOutput {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
    }

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both pointers remain valid NUL-terminated UTF-16 strings for the
    // call. Omitting MOVEFILE_REPLACE_EXISTING preserves the no-replace rule.
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    windows
)))]
fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "this host does not provide atomic no-replace rename",
    ))
}

struct CappedReader<R> {
    inner: R,
    remaining: u64,
    label: &'static str,
}

impl<R> CappedReader<R> {
    fn new(inner: R, limit: u64, label: &'static str) -> Self {
        Self {
            inner,
            remaining: limit,
            label,
        }
    }
}

impl<R: Read> Read for CappedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut probe = [0u8; 1];
            return match self.inner.read(&mut probe) {
                Ok(0) => Ok(0),
                Ok(_) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{} exceeds its byte limit", self.label),
                )),
                Err(e) => Err(e),
            };
        }
        let allowed = usize::try_from(self.remaining.min(buffer.len() as u64))
            .expect("allowed read size is bounded by a usize buffer length");
        let read = self.inner.read(&mut buffer[..allowed])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::TempDir;

    enum FixtureEntry<'a> {
        File(&'a str, &'a [u8]),
        Directory(&'a str),
        Symlink(&'a str, &'a str),
        Hardlink(&'a str, &'a str),
    }

    fn package_archive(entries: &[FixtureEntry<'_>]) -> Vec<u8> {
        let mut compressed = Vec::new();
        {
            let encoder = zstd::stream::write::Encoder::new(&mut compressed, 0).unwrap();
            let mut builder = tar::Builder::new(encoder);
            for fixture in entries {
                let mut header = tar::Header::new_gnu();
                match fixture {
                    FixtureEntry::File(path, bytes) => {
                        header.set_entry_type(tar::EntryType::Regular);
                        header.set_size(bytes.len() as u64);
                        header.set_mode(0o644);
                        header.set_cksum();
                        builder.append_data(&mut header, path, *bytes).unwrap();
                    }
                    FixtureEntry::Directory(path) => {
                        header.set_entry_type(tar::EntryType::Directory);
                        header.set_size(0);
                        header.set_mode(0o755);
                        header.set_cksum();
                        builder.append_data(&mut header, path, io::empty()).unwrap();
                    }
                    FixtureEntry::Symlink(path, target) => {
                        header.set_entry_type(tar::EntryType::Symlink);
                        header.set_size(0);
                        header.set_mode(0o777);
                        header.set_link_name(target).unwrap();
                        header.set_cksum();
                        builder.append_data(&mut header, path, io::empty()).unwrap();
                    }
                    FixtureEntry::Hardlink(path, target) => {
                        header.set_entry_type(tar::EntryType::Link);
                        header.set_size(0);
                        header.set_mode(0o644);
                        header.set_link_name(target).unwrap();
                        header.set_cksum();
                        builder.append_data(&mut header, path, io::empty()).unwrap();
                    }
                }
            }
            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }
        compressed
    }

    fn write_archive(root: &TempDir, bytes: &[u8]) -> PathBuf {
        let archive = root.path().join("package.tar.zst");
        fs::write(&archive, bytes).unwrap();
        archive
    }

    fn assert_no_stage(root: &TempDir) {
        let leftovers: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| {
                name.to_string_lossy()
                    .starts_with(".archive-extract-member-")
            })
            .collect();
        assert!(leftovers.is_empty(), "private stages remain: {leftovers:?}");
    }

    #[test]
    fn extracts_exact_regular_member_and_not_its_neighbors() {
        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[
                FixtureEntry::File("manifest.toml", b"metadata"),
                FixtureEntry::File("artifacts/shell.vfs.zst", b"wanted bytes"),
                FixtureEntry::File("artifacts/other", b"other bytes"),
            ]),
        );
        let out = root.path().join("shell.vfs.zst");

        run(vec![
            "--archive".into(),
            archive.display().to_string(),
            "--member".into(),
            "artifacts/shell.vfs.zst".into(),
            "--out".into(),
            out.display().to_string(),
        ])
        .unwrap();

        assert_eq!(fs::read(out).unwrap(), b"wanted bytes");
        assert_no_stage(&root);
    }

    #[cfg(unix)]
    #[test]
    fn successful_output_keeps_private_stage_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[FixtureEntry::File(
                "artifacts/shell.vfs.zst",
                b"wanted bytes",
            )]),
        );
        let out = root.path().join("shell.vfs.zst");

        extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS).unwrap();

        assert_eq!(
            fs::metadata(out).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_no_stage(&root);
    }

    #[test]
    fn missing_member_leaves_no_output_or_stage() {
        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[FixtureEntry::File("artifacts/other", b"other")]),
        );
        let out = root.path().join("shell.vfs.zst");

        let error = extract_member(&archive, "artifacts/missing", &out, PACKAGE_LIMITS)
            .expect_err("missing member must fail");

        assert!(error.contains("is missing"), "{error}");
        assert!(!out.exists());
        assert_no_stage(&root);
    }

    #[test]
    fn duplicate_after_first_match_discards_complete_stage() {
        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[
                FixtureEntry::File("artifacts/shell.vfs.zst", b"first"),
                FixtureEntry::File("artifacts/padding", b"padding"),
                FixtureEntry::File("artifacts/shell.vfs.zst", b"second"),
            ]),
        );
        let out = root.path().join("shell.vfs.zst");

        let error = extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS)
            .expect_err("duplicate member must fail");

        assert!(error.contains("appears more than once"), "{error}");
        assert!(!out.exists());
        assert_no_stage(&root);
    }

    #[test]
    fn directories_and_links_are_not_regular_members() {
        for (label, fixture) in [
            (
                "directory",
                FixtureEntry::Directory("artifacts/shell.vfs.zst"),
            ),
            (
                "symlink",
                FixtureEntry::Symlink("artifacts/shell.vfs.zst", "other"),
            ),
            (
                "hardlink",
                FixtureEntry::Hardlink("artifacts/shell.vfs.zst", "other"),
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let archive = write_archive(&root, &package_archive(&[fixture]));
            let out = root.path().join("shell.vfs.zst");

            let error = extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS)
                .expect_err(label);

            assert!(error.contains("not a regular file"), "{label}: {error}");
            assert!(!out.exists());
            assert_no_stage(&root);
        }
    }

    #[test]
    fn member_limit_is_checked_before_copying() {
        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[FixtureEntry::File("artifacts/shell.vfs.zst", b"12345")]),
        );
        let out = root.path().join("shell.vfs.zst");

        let error = extract_member(
            &archive,
            "artifacts/shell.vfs.zst",
            &out,
            Limits {
                decompressed_bytes: 16 * 1024,
                member_bytes: 4,
            },
        )
        .expect_err("oversized member must fail");

        assert!(error.contains("exceeding the 4-byte"), "{error}");
        assert!(!out.exists());
        assert_no_stage(&root);
    }

    #[test]
    fn decompressed_limit_after_member_discards_stage() {
        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[
                FixtureEntry::File("artifacts/shell.vfs.zst", b"complete"),
                FixtureEntry::File("artifacts/padding", &[b'x'; 2_048]),
            ]),
        );
        let out = root.path().join("shell.vfs.zst");

        let error = extract_member(
            &archive,
            "artifacts/shell.vfs.zst",
            &out,
            Limits {
                decompressed_bytes: 1_536,
                member_bytes: 1_024,
            },
        )
        .expect_err("oversized decompressed archive must fail");

        assert!(error.contains("exceeds its byte limit"), "{error}");
        assert!(!out.exists());
        assert_no_stage(&root);
    }

    #[test]
    fn truncated_archive_never_publishes_the_member() {
        let root = tempfile::tempdir().unwrap();
        let mut bytes = package_archive(&[
            FixtureEntry::File("artifacts/shell.vfs.zst", &[b'a'; 32 * 1024]),
            FixtureEntry::File("artifacts/padding", &[b'b'; 32 * 1024]),
        ]);
        bytes.truncate(bytes.len() / 2);
        let archive = write_archive(&root, &bytes);
        let out = root.path().join("shell.vfs.zst");

        extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS)
            .expect_err("truncated archive must fail");

        assert!(!out.exists());
        assert_no_stage(&root);
    }

    #[test]
    fn malformed_non_zstd_input_never_creates_an_output() {
        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(&root, b"this is not a zstd frame");
        let out = root.path().join("shell.vfs.zst");

        extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS)
            .expect_err("malformed zstd input must fail");

        assert!(!out.exists());
        assert_no_stage(&root);
    }

    #[test]
    fn rejects_unsafe_or_non_normalized_member_requests() {
        for member in [
            "",
            ".",
            "..",
            "/absolute",
            "a/",
            "./a",
            "a/./b",
            "a/../b",
            "a//b",
            r"a\b",
        ] {
            let error = validate_member_request(member).expect_err(member);
            assert!(error.contains("normalized portable relative"), "{error}");
        }
        validate_member_request("artifacts/shell.vfs.zst").unwrap();
    }

    #[test]
    fn occupied_output_is_preserved_without_reading_archive() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("not-even-an-archive");
        fs::write(&archive, b"invalid").unwrap();
        let out = root.path().join("shell.vfs.zst");
        fs::write(&out, b"existing").unwrap();

        let error = extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS)
            .expect_err("occupied output must fail first");

        assert!(error.contains("refusing to replace"), "{error}");
        assert_eq!(fs::read(&out).unwrap(), b"existing");
        assert_no_stage(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_output_and_its_target_are_preserved() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let archive = write_archive(
            &root,
            &package_archive(&[FixtureEntry::File(
                "artifacts/shell.vfs.zst",
                b"replacement",
            )]),
        );
        let target = root.path().join("target");
        fs::write(&target, b"sentinel").unwrap();
        let out = root.path().join("shell.vfs.zst");
        symlink(&target, &out).unwrap();

        let error = extract_member(&archive, "artifacts/shell.vfs.zst", &out, PACKAGE_LIMITS)
            .expect_err("symlink output must fail");

        assert!(error.contains("refusing to replace"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"sentinel");
        assert_eq!(fs::read_link(&out).unwrap(), target);
        assert_no_stage(&root);
    }

    #[test]
    fn cap_accepts_exact_limit_and_rejects_one_more_byte() {
        let mut exact = CappedReader::new(Cursor::new(b"1234"), 4, "fixture");
        let mut bytes = Vec::new();
        exact.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"1234");

        let mut over = CappedReader::new(Cursor::new(b"12345"), 4, "fixture");
        let error = over
            .read_to_end(&mut Vec::new())
            .expect_err("fifth byte must exceed cap");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("fixture exceeds"));
    }

    #[test]
    fn cli_requires_each_named_argument_exactly_once() {
        let parsed = parse_args(vec![
            "--archive=a.tar.zst".into(),
            "--member".into(),
            "artifacts/shell.vfs.zst".into(),
            "--out=out.vfs.zst".into(),
        ])
        .unwrap();
        assert_eq!(
            parsed,
            Options {
                archive: PathBuf::from("a.tar.zst"),
                member: "artifacts/shell.vfs.zst".into(),
                out: PathBuf::from("out.vfs.zst"),
            }
        );

        let duplicate = parse_args(vec![
            "--archive=a".into(),
            "--archive".into(),
            "b".into(),
            "--member=m".into(),
            "--out=o".into(),
        ])
        .expect_err("duplicate archive flag");
        assert!(duplicate.contains("--archive may be provided only once"));

        for args in [
            vec!["--archive=a".into(), "--member=m".into()],
            vec!["--archive=a".into(), "--out=o".into()],
            vec!["--member=m".into(), "--out=o".into()],
        ] {
            assert!(parse_args(args).is_err());
        }
    }
}
