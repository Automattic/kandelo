//! Source-kind archive fetch + extract. Reused by the resolver
//! when a `kind = "source"` manifest has no [build].script_path.
//!
//! Format detection is purely on URL extension. The resolver
//! never inspects archive bytes for magic numbers — the URL is
//! authoritative because the manifest's source.sha256 anchors
//! both the bytes and the format.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::remote_fetch::{fetch_url, verify_sha};

/// Decompressed-output cap. Protects against zip-bomb-style
/// archives. 4 GiB is generous — typical source tarballs we
/// extract are 10–100 MiB; PHP, MariaDB, Erlang vendored sources
/// are the largest at <1 GiB. Tightening below 4 GiB risks
/// false-positive on Erlang OTP source.
const MAX_DECOMPRESSED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub enum ArchiveFormat {
    TarGz,
    TarXz,
    TarBz2,
    TarZst,
    Zip,
    Tar,
}

impl ArchiveFormat {
    /// Detect from URL extension. Falls through to an error when
    /// no known suffix matches — the resolver surfaces that to
    /// the user verbatim.
    pub fn from_url(url: &str) -> Result<Self, String> {
        // Strip any "?query" or "#fragment" before suffix matching
        // so URLs with auth tokens / anchors still detect format.
        let path = url.split_once('?').map(|(p, _)| p).unwrap_or(url);
        let path = path.split_once('#').map(|(p, _)| p).unwrap_or(path);
        let lc = path.to_ascii_lowercase();
        // Order matters: .tar.gz must be checked before .gz, etc.
        if lc.ends_with(".tar.gz") || lc.ends_with(".tgz") {
            Ok(Self::TarGz)
        } else if lc.ends_with(".tar.xz") || lc.ends_with(".txz") {
            Ok(Self::TarXz)
        } else if lc.ends_with(".tar.bz2") || lc.ends_with(".tbz2") || lc.ends_with(".tbz") {
            Ok(Self::TarBz2)
        } else if lc.ends_with(".tar.zst") || lc.ends_with(".tzst") {
            Ok(Self::TarZst)
        } else if lc.ends_with(".zip") {
            Ok(Self::Zip)
        } else if lc.ends_with(".tar") {
            Ok(Self::Tar)
        } else {
            Err(format!(
                "could not detect archive format from URL extension: {url:?} \
                 (supported: .tar.gz, .tgz, .tar.xz, .txz, .tar.bz2, .tbz2, .tbz, \
                  .tar.zst, .tzst, .zip, .tar)"
            ))
        }
    }
}

/// Fetch + verify + extract a source archive into `dest`. The
/// caller is responsible for using a tmp dir + atomic rename.
///
/// On success the directory contains the archive's contents. If
/// the archive contained exactly one top-level entry (a directory),
/// that segment is *stripped* — consumers see source files at the
/// cache directory's root, not nested inside `<name>-<version>/`.
pub fn fetch_and_extract(url: &str, sha256_hex: &str, dest: &Path) -> Result<(), String> {
    let bytes = fetch_url(url).map_err(|e| format!("{e}"))?;
    verify_sha(&bytes, sha256_hex).map_err(|e| format!("{e}"))?;
    let format = ArchiveFormat::from_url(url)?;
    extract(&bytes, format, dest)?;
    flatten_single_top_level(dest)?;
    Ok(())
}

// This entry point and its private helper graph are consumed by the sequential
// Task 3C gate. Keep the allowances item-scoped so unrelated code stays linted.
/// Extract an already verified archive into a new caller-owned directory.
#[allow(dead_code)]
pub fn extract_verified_archive(
    archive: &Path,
    source_url: &str,
    destination: &Path,
) -> Result<(), String> {
    extract_verified_archive_with_excluded_members(archive, source_url, destination, &[])
}

/// Extract a verified archive while omitting an exact, manifest-authorized
/// set of pre-flatten archive members. This exists for upstream archives that
/// cannot be represented on the host filesystem (for example, `BUILD` and
/// `build/` on case-insensitive macOS volumes). Exclusions are fail-closed:
/// every path must be portable, sorted, unique, present exactly once, and name
/// a regular file rather than a directory or link.
#[allow(dead_code)]
pub fn extract_verified_archive_with_excluded_members(
    archive: &Path,
    source_url: &str,
    destination: &Path,
    excluded_members: &[String],
) -> Result<(), String> {
    let format = ArchiveFormat::from_url(source_url)?;
    let excluded_members = validate_excluded_members(excluded_members)?;
    let archive_metadata = fs::symlink_metadata(archive)
        .map_err(|error| format!("inspect verified archive {}: {error}", archive.display()))?;
    if archive_metadata.file_type().is_symlink() || !archive_metadata.file_type().is_file() {
        return Err(format!(
            "verified archive {} must be a regular nonsymlink file",
            archive.display()
        ));
    }
    ensure_destination_absent(destination)?;
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "extraction destination {} has no parent",
            destination.display()
        )
    })?;
    validate_destination_parent(parent)?;

    let input = File::open(archive)
        .map_err(|error| format!("open verified archive {}: {error}", archive.display()))?;
    let opened_metadata = input
        .metadata()
        .map_err(|error| format!("stat verified archive {}: {error}", archive.display()))?;
    if !opened_metadata.is_file() {
        return Err(format!(
            "verified archive {} changed while opening",
            archive.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if archive_metadata.dev() != opened_metadata.dev()
            || archive_metadata.ino() != opened_metadata.ino()
        {
            return Err(format!(
                "verified archive {} changed while opening",
                archive.display()
            ));
        }
    }

    fs::create_dir(destination).map_err(|error| {
        format!(
            "create extraction destination {}: {error}",
            destination.display()
        )
    })?;
    set_private_directory_permissions(destination)?;

    match format {
        ArchiveFormat::TarGz => extract_tar_reader_with_excluded_members(
            flate2::read::GzDecoder::new(input),
            destination,
            "tar.gz",
            MAX_DECOMPRESSED_BYTES,
            &excluded_members,
        )?,
        ArchiveFormat::TarXz => extract_tar_reader_with_excluded_members(
            xz2::read::XzDecoder::new(input),
            destination,
            "tar.xz",
            MAX_DECOMPRESSED_BYTES,
            &excluded_members,
        )?,
        ArchiveFormat::TarBz2 => extract_tar_reader_with_excluded_members(
            bzip2::read::BzDecoder::new(input),
            destination,
            "tar.bz2",
            MAX_DECOMPRESSED_BYTES,
            &excluded_members,
        )?,
        ArchiveFormat::TarZst => {
            let decoder = zstd::stream::read::Decoder::new(input)
                .map_err(|error| format!("zstd decoder: {error}"))?;
            extract_tar_reader_with_excluded_members(
                decoder,
                destination,
                "tar.zst",
                MAX_DECOMPRESSED_BYTES,
                &excluded_members,
            )?;
        }
        ArchiveFormat::Tar => {
            extract_tar_reader_with_excluded_members(
                input,
                destination,
                "tar",
                MAX_DECOMPRESSED_BYTES,
                &excluded_members,
            )?;
        }
        ArchiveFormat::Zip => {
            let zip = zip::ZipArchive::new(input).map_err(|error| format!("zip parse: {error}"))?;
            extract_zip_with_excluded_members(
                zip,
                destination,
                MAX_DECOMPRESSED_BYTES,
                &excluded_members,
            )?;
        }
    }
    validate_extracted_tree(destination, destination)?;
    flatten_single_top_level(destination)?;
    validate_extracted_tree(destination, destination)?;
    Ok(())
}

#[allow(dead_code)]
fn ensure_destination_absent(destination: &Path) -> Result<(), String> {
    match fs::symlink_metadata(destination) {
        Ok(_) => Err(format!(
            "extraction destination {} already exists; refusing to replace it",
            destination.display()
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "inspect destination {}: {error}",
            destination.display()
        )),
    }
}

#[allow(dead_code)]
fn validate_destination_parent(parent: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| format!("inspect destination parent {}: {error}", parent.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(format!(
            "destination parent {} must be a real nonsymlink directory",
            parent.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        unsafe extern "C" {
            fn geteuid() -> u32;
        }
        // SAFETY: geteuid has no arguments or memory-safety preconditions.
        let current_uid = unsafe { geteuid() };
        if metadata.uid() != current_uid {
            return Err(format!(
                "destination parent {} is not owned by the current user",
                parent.display()
            ));
        }
        if metadata.permissions().mode() & 0o022 != 0 {
            return Err(format!(
                "destination parent {} is group/other-writable",
                parent.display()
            ));
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

#[allow(dead_code)]
struct CappedReader<R> {
    inner: R,
    remaining: u64,
    label: &'static str,
}

#[allow(dead_code)]
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
        let allowed = self.remaining.min(buffer.len() as u64) as usize;
        if allowed != 0 {
            let count = self.inner.read(&mut buffer[..allowed])?;
            self.remaining -= count as u64;
            return Ok(count);
        }
        let mut extra = [0u8; 1];
        if self.inner.read(&mut extra)? == 0 {
            Ok(0)
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} exceeds decompressed-output limit", self.label),
            ))
        }
    }
}

#[allow(dead_code)]
fn extract_tar_reader<R: Read>(
    reader: R,
    destination: &Path,
    label: &'static str,
    limit: u64,
) -> Result<(), String> {
    extract_tar_reader_with_excluded_members(reader, destination, label, limit, &BTreeSet::new())
}

fn validate_excluded_members(members: &[String]) -> Result<BTreeSet<String>, String> {
    for member in members {
        if member.is_empty()
            || member.len() > 4_096
            || member
                .chars()
                .any(|character| matches!(character, '\0' | '\n' | '\r' | '\\'))
            || member.split('/').any(|component| {
                component.is_empty()
                    || component.len() > 255
                    || component == "."
                    || component == ".."
            })
            || Path::new(member).is_absolute()
            || Path::new(member)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!(
                "excluded archive member must be a bounded portable relative path, got {member:?}"
            ));
        }
    }
    if members.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(
            "excluded archive members must be bytewise sorted and contain no duplicates"
                .to_string(),
        );
    }
    Ok(members.iter().cloned().collect())
}

fn should_exclude_archive_member(
    relative: &Path,
    is_regular: bool,
    expected: &BTreeSet<String>,
    seen: &mut BTreeSet<String>,
) -> Result<bool, String> {
    let Some(relative) = relative.to_str() else {
        return Ok(false);
    };
    if !expected.contains(relative) {
        return Ok(false);
    }
    if !is_regular {
        return Err(format!(
            "excluded archive member {relative:?} must be a regular file"
        ));
    }
    if !seen.insert(relative.to_string()) {
        return Err(format!(
            "excluded archive member {relative:?} appears more than once"
        ));
    }
    Ok(true)
}

fn require_all_excluded_members_seen(
    expected: &BTreeSet<String>,
    seen: &BTreeSet<String>,
) -> Result<(), String> {
    if let Some(missing) = expected.difference(seen).next() {
        return Err(format!(
            "excluded archive member {missing:?} was not present exactly once as a regular file"
        ));
    }
    Ok(())
}

#[allow(dead_code)]
fn extract_tar_reader_with_excluded_members<R: Read>(
    reader: R,
    destination: &Path,
    label: &'static str,
    limit: u64,
    excluded_members: &BTreeSet<String>,
) -> Result<(), String> {
    let capped = CappedReader::new(reader, limit, label);
    let mut archive = tar::Archive::new(capped);
    let mut seen_excluded_members = BTreeSet::new();
    let entries = archive
        .entries()
        .map_err(|error| format!("{label} entries: {error}"))?;
    for (index, entry) in entries.enumerate() {
        let mut entry = entry.map_err(|error| format!("{label} entry {index}: {error}"))?;
        if entry.header().entry_type().is_pax_global_extensions() {
            // PAX global headers carry metadata for later members; they are
            // not filesystem entries. Ignore the metadata rather than
            // materializing its conventional `pax_global_header` pathname.
            continue;
        }
        let raw_path = entry
            .path()
            .map_err(|error| format!("{label} entry {index} path: {error}"))?;
        let relative = normalize_entry_path(&raw_path)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if should_exclude_archive_member(
            &relative,
            entry.header().entry_type().is_file(),
            excluded_members,
            &mut seen_excluded_members,
        )? {
            continue;
        }
        validate_entry_type_and_link(&entry, &relative)?;
        prepare_entry_path(destination, &relative)?;
        let unpacked = entry
            .unpack_in(destination)
            .map_err(|error| format!("{label} unpack {}: {error}", relative.display()))?;
        if !unpacked {
            return Err(format!(
                "{label} entry {} would leave the extraction destination",
                relative.display()
            ));
        }
    }
    require_all_excluded_members_seen(excluded_members, &seen_excluded_members)
}

#[allow(dead_code)]
fn validate_entry_type_and_link<R: Read>(
    entry: &tar::Entry<'_, R>,
    relative: &Path,
) -> Result<(), String> {
    let kind = entry.header().entry_type();
    if kind.is_file() || kind.is_dir() {
        return Ok(());
    }
    if kind.is_symlink() || kind.is_hard_link() {
        let target = entry
            .link_name()
            .map_err(|error| format!("read link target for {}: {error}", relative.display()))?
            .ok_or_else(|| format!("link {} has no target", relative.display()))?;
        let base_depth = if kind.is_symlink() {
            relative.parent().map(normal_component_count).unwrap_or(0)
        } else {
            0
        };
        validate_contained_link_target(&target, base_depth, relative)?;
        return Ok(());
    }
    Err(format!(
        "archive entry {} has unsupported special type {:?}",
        relative.display(),
        kind
    ))
}

#[allow(dead_code)]
fn normalize_entry_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "archive entry path {} is absolute or contains parent traversal",
                    path.display()
                ));
            }
        }
    }
    Ok(normalized)
}

#[allow(dead_code)]
fn normal_component_count(path: &Path) -> usize {
    path.components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
}

#[allow(dead_code)]
fn validate_contained_link_target(
    target: &Path,
    initial_depth: usize,
    link_path: &Path,
) -> Result<(), String> {
    let mut depth = initial_depth;
    for component in target.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir if depth != 0 => depth -= 1,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "archive link {} target {} leaves the extraction destination",
                    link_path.display(),
                    target.display()
                ));
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn prepare_entry_path(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            let Component::Normal(part) = component else {
                continue;
            };
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                        return Err(format!(
                            "archive entry would write through unsafe ancestor {}",
                            current.display()
                        ));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir(&current)
                        .map_err(|error| format!("create {}: {error}", current.display()))?;
                }
                Err(error) => return Err(format!("inspect {}: {error}", current.display())),
            }
        }
    }
    let final_path = root.join(relative);
    if let Ok(metadata) = fs::symlink_metadata(&final_path)
        && metadata.file_type().is_symlink()
    {
        return Err(format!(
            "archive entry would replace or follow symlink {}",
            final_path.display()
        ));
    }
    Ok(())
}

#[allow(dead_code)]
fn extract_zip(
    archive: zip::ZipArchive<File>,
    destination: &Path,
    limit: u64,
) -> Result<(), String> {
    extract_zip_with_excluded_members(archive, destination, limit, &BTreeSet::new())
}

#[allow(dead_code)]
fn extract_zip_with_excluded_members(
    mut archive: zip::ZipArchive<File>,
    destination: &Path,
    limit: u64,
    excluded_members: &BTreeSet<String>,
) -> Result<(), String> {
    let mut total = 0u64;
    let mut seen_excluded_members = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("zip entry {index}: {error}"))?;
        let relative = normalize_entry_path(Path::new(entry.name()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let unix_type = entry.unix_mode().unwrap_or(0) & 0o170000;
        if should_exclude_archive_member(
            &relative,
            !entry.is_dir() && (unix_type == 0 || unix_type == 0o100000),
            excluded_members,
            &mut seen_excluded_members,
        )? {
            continue;
        }
        if unix_type != 0 && unix_type != 0o040000 && unix_type != 0o100000 {
            return Err(format!(
                "zip entry {} has unsupported special type",
                relative.display()
            ));
        }
        prepare_entry_path(destination, &relative)?;
        let output = destination.join(&relative);
        if entry.is_dir() {
            match fs::create_dir(&output) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(&output)
                        .map_err(|error| format!("inspect {}: {error}", output.display()))?;
                    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                        return Err(format!("zip directory {} is occupied", output.display()));
                    }
                }
                Err(error) => return Err(format!("create {}: {error}", output.display())),
            }
            continue;
        }
        if total.saturating_add(entry.size()) > limit {
            return Err(format!(
                "zip extract exceeds {limit}-byte decompressed-output limit"
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(entry.unix_mode().unwrap_or(0o600) & 0o777);
        }
        let mut target = options
            .open(&output)
            .map_err(|error| format!("create zip output {}: {error}", output.display()))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = entry
                .read(&mut buffer)
                .map_err(|error| format!("read zip entry {}: {error}", relative.display()))?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .ok_or_else(|| "zip decompressed byte count overflowed".to_string())?;
            if total > limit {
                return Err(format!(
                    "zip extract exceeds {limit}-byte decompressed-output limit"
                ));
            }
            target
                .write_all(&buffer[..count])
                .map_err(|error| format!("write zip output {}: {error}", output.display()))?;
        }
    }
    require_all_excluded_members_seen(excluded_members, &seen_excluded_members)
}

#[allow(dead_code)]
fn validate_extracted_tree(root: &Path, directory: &Path) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("read extracted directory {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("read extracted entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect extracted entry {}: {error}", path.display()))?;
        if metadata.file_type().is_dir() {
            validate_extracted_tree(root, &path)?;
        } else if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path)
                .map_err(|error| format!("read extracted symlink {}: {error}", path.display()))?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| format!("extracted entry {} left root", path.display()))?;
            validate_contained_link_target(
                &target,
                relative.parent().map(normal_component_count).unwrap_or(0),
                relative,
            )?;
        } else if !metadata.file_type().is_file() {
            return Err(format!(
                "extracted entry {} has unsupported special type",
                path.display()
            ));
        }
    }
    Ok(())
}

fn extract(bytes: &[u8], format: ArchiveFormat, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    match format {
        ArchiveFormat::TarGz => {
            let r = flate2::read::GzDecoder::new(bytes);
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.gz unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::TarXz => {
            let r = xz2::read::XzDecoder::new(bytes);
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.xz unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::TarBz2 => {
            let r = bzip2::read::BzDecoder::new(bytes);
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.bz2 unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::TarZst => {
            let r = zstd::stream::read::Decoder::new(bytes)
                .map_err(|e| format!("zstd decoder: {e}"))?;
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.zst unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::Tar => {
            // The cap is redundant for plain `.tar` since the
            // fetcher already enforces MAX_RESPONSE_BYTES on the
            // raw download — a tar's uncompressed size equals its
            // wire size. Kept for symmetry with the compressed
            // variants so future format additions don't get a
            // half-applied policy.
            let bounded = std::io::Read::take(bytes, MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::Zip => {
            // The zip crate works on Read+Seek, not streams. A
            // `Cursor` over the in-memory bytes satisfies both
            // traits without forcing an on-disk tempfile or a
            // runtime tempfile dependency.
            let cursor = std::io::Cursor::new(bytes);
            let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("zip parse: {e}"))?;
            // ZipArchive::extract trusts each entry's declared
            // uncompressed_size from the central directory and
            // applies no aggregate cap. Pre-flight by summing
            // declared sizes and reject if the total exceeds
            // MAX_DECOMPRESSED_BYTES — mirrors the Read::take cap
            // applied to every tar variant above.
            let mut total: u64 = 0;
            for i in 0..zip.len() {
                let f = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
                total = total.saturating_add(f.size());
                if total > MAX_DECOMPRESSED_BYTES {
                    return Err(format!(
                        "zip extract refused: declared uncompressed size \
                         exceeds {MAX_DECOMPRESSED_BYTES} bytes (zip-bomb guard)"
                    ));
                }
            }
            zip.extract(dest).map_err(|e| format!("zip extract: {e}"))?;
        }
    }
    Ok(())
}

/// If `dest` contains exactly one entry and that entry is a
/// directory, move its contents up into `dest` and remove the
/// wrapper. Mirrors the pattern of every upstream tarball
/// (`pcre2-10.42/...`, `php-8.3.0/...`, etc.).
fn flatten_single_top_level(dest: &Path) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dest)
        .map_err(|e| format!("read_dir {}: {e}", dest.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read_dir {}: {e}", dest.display()))?;
    if entries.len() != 1 {
        return Ok(());
    }
    let only = entries.pop().unwrap();
    let only_path = only.path();
    let metadata = fs::symlink_metadata(&only_path)
        .map_err(|e| format!("stat {}: {e}", only_path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Ok(());
    }
    // Move children one level up.
    for child in
        fs::read_dir(&only_path).map_err(|e| format!("read_dir {}: {e}", only_path.display()))?
    {
        let child = child.map_err(|e| format!("read_dir entry: {e}"))?;
        let from = child.path();
        let to = dest.join(child.file_name());
        fs::rename(&from, &to)
            .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
    }
    fs::remove_dir(&only_path).map_err(|e| format!("rmdir {}: {e}", only_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::{Cursor, Write};

    fn make_tar_gz_with_top_dir() -> (Vec<u8>, &'static str) {
        // Construct a tarball containing a single top-level dir
        // `pcre2-10.42/` with one file `pcre2-10.42/README` whose
        // contents are `hello\n`.
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::default());
            let mut builder = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_path("pcre2-10.42/README").unwrap();
            header.set_size(6);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"hello\n"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        (tar_bytes, "hello\n")
    }

    #[test]
    fn extract_tar_gz_strips_single_top_level_dir() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        let (bytes, expected) = make_tar_gz_with_top_dir();
        extract(&bytes, ArchiveFormat::TarGz, &dest).unwrap();
        flatten_single_top_level(&dest).unwrap();
        let readme = dest.join("README");
        assert!(readme.is_file(), "expected README at {}", readme.display());
        let actual = std::fs::read_to_string(readme).unwrap();
        assert_eq!(actual, expected);
        // `pcre2-10.42` must NOT exist anymore.
        assert!(!dest.join("pcre2-10.42").exists());
    }

    #[test]
    fn extract_preserves_multiple_top_level_entries() {
        // Build a tarball with TWO top-level entries and confirm
        // we DON'T flatten (the wrapper-stripping rule is "exactly
        // one entry").
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::default());
            let mut builder = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_path("a.txt").unwrap();
            header.set_size(2);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"a\n"[..]).unwrap();
            let mut header2 = tar::Header::new_gnu();
            header2.set_path("b.txt").unwrap();
            header2.set_size(2);
            header2.set_mode(0o644);
            header2.set_cksum();
            builder.append(&header2, &b"b\n"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        extract(&tar_bytes, ArchiveFormat::TarGz, &dest).unwrap();
        flatten_single_top_level(&dest).unwrap();
        assert!(dest.join("a.txt").is_file());
        assert!(dest.join("b.txt").is_file());
    }

    #[test]
    fn from_url_detects_known_extensions() {
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar.gz").unwrap(),
            ArchiveFormat::TarGz
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tgz").unwrap(),
            ArchiveFormat::TarGz
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar.xz").unwrap(),
            ArchiveFormat::TarXz
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.txz").unwrap(),
            ArchiveFormat::TarXz
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar.bz2").unwrap(),
            ArchiveFormat::TarBz2
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tbz2").unwrap(),
            ArchiveFormat::TarBz2
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tbz").unwrap(),
            ArchiveFormat::TarBz2
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar.zst").unwrap(),
            ArchiveFormat::TarZst
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tzst").unwrap(),
            ArchiveFormat::TarZst
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.zip").unwrap(),
            ArchiveFormat::Zip
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar").unwrap(),
            ArchiveFormat::Tar
        ));
    }

    #[test]
    fn from_url_rejects_unknown_extension() {
        let err = ArchiveFormat::from_url("https://x/p.rar").unwrap_err();
        assert!(err.contains("could not detect"), "got: {err}");
    }

    #[test]
    fn from_url_handles_query_string_and_fragment() {
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar.gz?token=abc").unwrap(),
            ArchiveFormat::TarGz,
        ));
        assert!(matches!(
            ArchiveFormat::from_url("https://x/p.tar.xz#frag").unwrap(),
            ArchiveFormat::TarXz,
        ));
    }

    #[test]
    fn extract_tar_zst_round_trips() {
        // Build a minimal tarball, wrap with a zstd encoder, and
        // confirm the .tar.zst extract path actually wires the
        // zstd decoder correctly. Format-detection alone wouldn't
        // catch a wiring bug like decoder mis-construction.
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_path("hello.txt").unwrap();
            header.set_size(6);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"world\n"[..]).unwrap();
            builder.into_inner().unwrap();
        }
        let mut zst_bytes: Vec<u8> = Vec::new();
        {
            let mut enc = zstd::stream::write::Encoder::new(&mut zst_bytes, 0).unwrap();
            enc.write_all(&tar_bytes).unwrap();
            enc.finish().unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        extract(&zst_bytes, ArchiveFormat::TarZst, &dest).unwrap();
        flatten_single_top_level(&dest).unwrap();
        let hello = dest.join("hello.txt");
        assert!(hello.is_file(), "expected hello.txt at {}", hello.display());
        let actual = std::fs::read_to_string(hello).unwrap();
        assert_eq!(actual, "world\n");
    }

    #[test]
    fn fetch_and_extract_via_file_url_succeeds() {
        // Materialize the fixture tarball, point a file:// URL at
        // it, and run the full fetch_and_extract pipeline.
        let dir = tempfile::tempdir().unwrap();
        let (bytes, _) = make_tar_gz_with_top_dir();
        let archive = dir.path().join("p.tar.gz");
        File::create(&archive).unwrap().write_all(&bytes).unwrap();

        let mut h = Sha256::new();
        h.update(&bytes);
        let sha_hex: [u8; 32] = h.finalize().into();
        let sha_hex = crate::util::hex(&sha_hex);

        let dest = dir.path().join("out");
        let url = format!("file://{}", archive.display());
        fetch_and_extract(&url, &sha_hex, &dest).unwrap();
        assert!(dest.join("README").is_file());
    }

    fn wrapper_tar() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut builder = tar::Builder::new(&mut bytes);
        let mut header = tar::Header::new_gnu();
        header.set_path("wrapper/README").unwrap();
        header.set_size(6);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, &b"hello\n"[..]).unwrap();
        builder.finish().unwrap();
        drop(builder);
        bytes
    }

    fn encode_fixture(suffix: &str) -> Vec<u8> {
        let tar = wrapper_tar();
        match suffix {
            ".tar" => tar,
            ".tar.gz" | ".tgz" => {
                let mut out = Vec::new();
                let mut encoder =
                    flate2::write::GzEncoder::new(&mut out, flate2::Compression::default());
                encoder.write_all(&tar).unwrap();
                encoder.finish().unwrap();
                out
            }
            ".tar.xz" | ".txz" => {
                let mut out = Vec::new();
                let mut encoder = xz2::write::XzEncoder::new(&mut out, 6);
                encoder.write_all(&tar).unwrap();
                encoder.finish().unwrap();
                out
            }
            ".tar.bz2" | ".tbz2" | ".tbz" => {
                let mut out = Vec::new();
                let mut encoder =
                    bzip2::write::BzEncoder::new(&mut out, bzip2::Compression::default());
                encoder.write_all(&tar).unwrap();
                encoder.finish().unwrap();
                out
            }
            ".tar.zst" | ".tzst" => zstd::stream::encode_all(Cursor::new(tar), 0).unwrap(),
            ".zip" => {
                let mut out = Cursor::new(Vec::new());
                {
                    let mut zip = zip::ZipWriter::new(&mut out);
                    zip.add_directory("wrapper/", zip::write::SimpleFileOptions::default())
                        .unwrap();
                    zip.start_file("wrapper/README", zip::write::SimpleFileOptions::default())
                        .unwrap();
                    zip.write_all(b"hello\n").unwrap();
                    zip.finish().unwrap();
                }
                out.into_inner()
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn verified_extraction_supports_every_suffix_and_flattens_real_wrapper() {
        for suffix in [
            ".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2", ".tbz", ".tar.zst", ".tzst",
            ".zip", ".tar",
        ] {
            let root = tempfile::tempdir().unwrap();
            let archive = root.path().join(format!("source{suffix}"));
            fs::write(&archive, encode_fixture(suffix)).unwrap();
            let destination = root.path().join("out");

            extract_verified_archive(
                &archive,
                &format!("https://example.test/source{suffix}"),
                &destination,
            )
            .unwrap_or_else(|error| panic!("{suffix}: {error}"));

            assert_eq!(
                fs::read(destination.join("README")).unwrap(),
                b"hello\n",
                "{suffix}"
            );
            assert!(!destination.join("wrapper").exists(), "{suffix}");
        }
    }

    #[test]
    fn verified_extraction_skips_only_exact_manifest_bound_regular_members() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("dinit.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut build_doc = tar::Header::new_gnu();
            build_doc.set_path("dinit-0.19.4/BUILD").unwrap();
            build_doc.set_size(13);
            build_doc.set_mode(0o644);
            build_doc.set_cksum();
            builder.append(&build_doc, &b"instructions\n"[..]).unwrap();

            let mut makefile = tar::Header::new_gnu();
            makefile.set_path("dinit-0.19.4/build/Makefile").unwrap();
            makefile.set_size(8);
            makefile.set_mode(0o644);
            makefile.set_cksum();
            builder.append(&makefile, &b"all:\n\t:\n"[..]).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let destination = root.path().join("out");

        extract_verified_archive_with_excluded_members(
            &archive,
            "https://example.test/dinit.tar",
            &destination,
            &["dinit-0.19.4/BUILD".to_string()],
        )
        .unwrap();

        assert_eq!(
            fs::read_dir(&destination)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            vec![std::ffi::OsString::from("build")]
        );
        assert_eq!(
            fs::read(destination.join("build/Makefile")).unwrap(),
            b"all:\n\t:\n"
        );

        let missing_destination = root.path().join("missing");
        let error = extract_verified_archive_with_excluded_members(
            &archive,
            "https://example.test/dinit.tar",
            &missing_destination,
            &[
                "dinit-0.19.4/BUILD".to_string(),
                "dinit-0.19.4/MISSING".to_string(),
            ],
        )
        .unwrap_err();
        assert!(
            error.contains("was not present"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn verified_extraction_ignores_pax_global_metadata() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("source.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut pax = tar::Header::new_gnu();
            pax.set_path("pax_global_header").unwrap();
            pax.set_entry_type(tar::EntryType::XGlobalHeader);
            pax.set_size(0);
            pax.set_mode(0o644);
            pax.set_cksum();
            builder.append(&pax, std::io::empty()).unwrap();

            let mut file = tar::Header::new_gnu();
            file.set_path("wrapper/README").unwrap();
            file.set_size(6);
            file.set_mode(0o644);
            file.set_cksum();
            builder.append(&file, &b"hello\n"[..]).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let destination = root.path().join("out");

        extract_verified_archive(&archive, "https://example.test/source.tar", &destination)
            .unwrap();

        assert_eq!(fs::read(destination.join("README")).unwrap(), b"hello\n");
        assert!(!destination.join("pax_global_header").exists());
    }

    #[test]
    fn verified_extraction_rejects_every_existing_destination_without_mutation() {
        let fixture = encode_fixture(".tar");
        for kind in ["file", "directory"] {
            let root = tempfile::tempdir().unwrap();
            let archive = root.path().join("source.tar");
            fs::write(&archive, &fixture).unwrap();
            let destination = root.path().join("out");
            if kind == "file" {
                fs::write(&destination, b"sentinel").unwrap();
            } else {
                fs::create_dir(&destination).unwrap();
                fs::write(destination.join("sentinel"), b"sentinel").unwrap();
            }
            extract_verified_archive(&archive, "https://example.test/source.tar", &destination)
                .expect_err(kind);
            if kind == "file" {
                assert_eq!(fs::read(&destination).unwrap(), b"sentinel");
            } else {
                assert_eq!(fs::read(destination.join("sentinel")).unwrap(), b"sentinel");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn verified_extraction_rejects_symlink_objects_and_unsafe_parent() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = tempfile::tempdir().unwrap();
        let real_archive = root.path().join("real.tar");
        fs::write(&real_archive, encode_fixture(".tar")).unwrap();
        let archive_link = root.path().join("source.tar");
        symlink(&real_archive, &archive_link).unwrap();
        extract_verified_archive(
            &archive_link,
            "https://example.test/source.tar",
            &root.path().join("out"),
        )
        .expect_err("archive symlink");
        extract_verified_archive(
            root.path(),
            "https://example.test/source.tar",
            &root.path().join("directory-archive-out"),
        )
        .expect_err("archive directory");

        let destination_link = root.path().join("dest-link");
        let sentinel = root.path().join("sentinel");
        fs::write(&sentinel, b"sentinel").unwrap();
        symlink(&sentinel, &destination_link).unwrap();
        extract_verified_archive(
            &real_archive,
            "https://example.test/source.tar",
            &destination_link,
        )
        .expect_err("destination symlink");
        assert_eq!(fs::read(&sentinel).unwrap(), b"sentinel");

        let dangling = root.path().join("dangling");
        symlink(root.path().join("missing"), &dangling).unwrap();
        extract_verified_archive(&real_archive, "https://example.test/source.tar", &dangling)
            .expect_err("dangling destination symlink");

        let unsafe_parent = root.path().join("unsafe");
        fs::create_dir(&unsafe_parent).unwrap();
        fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
        let unsafe_destination = unsafe_parent.join("out");
        extract_verified_archive(
            &real_archive,
            "https://example.test/source.tar",
            &unsafe_destination,
        )
        .expect_err("group/other-writable parent");
        assert!(!unsafe_destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn verified_extraction_rejects_escaping_symlink_and_leaves_partial_tree() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("hostile.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut file = tar::Header::new_gnu();
            file.set_path("partial.txt").unwrap();
            file.set_size(7);
            file.set_mode(0o644);
            file.set_cksum();
            builder.append(&file, &b"partial"[..]).unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("escape").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            link.set_mode(0o777);
            link.set_link_name("../outside").unwrap();
            link.set_cksum();
            builder.append(&link, std::io::empty()).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, b"sentinel").unwrap();
        let destination = root.path().join("out");

        extract_verified_archive(&archive, "https://example.test/hostile.tar", &destination)
            .expect_err("escaping link");

        assert_eq!(fs::read(&outside).unwrap(), b"sentinel");
        assert_eq!(
            fs::read(destination.join("partial.txt")).unwrap(),
            b"partial"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verified_extraction_never_flattens_a_lone_top_level_symlink() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("link.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut link = tar::Header::new_gnu();
            link.set_path("only").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            link.set_mode(0o777);
            link.set_link_name(".").unwrap();
            link.set_cksum();
            builder.append(&link, std::io::empty()).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let destination = root.path().join("out");

        extract_verified_archive(&archive, "https://example.test/link.tar", &destination).unwrap();

        assert!(
            fs::symlink_metadata(destination.join("only"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn verified_extraction_supports_only_contained_links_and_never_writes_through_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("links.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut file = tar::Header::new_gnu();
            file.set_path("wrapper/original").unwrap();
            file.set_size(5);
            file.set_mode(0o644);
            file.set_cksum();
            builder.append(&file, &b"bytes"[..]).unwrap();
            let mut symlink = tar::Header::new_gnu();
            symlink.set_path("wrapper/link").unwrap();
            symlink.set_entry_type(tar::EntryType::Symlink);
            symlink.set_size(0);
            symlink.set_mode(0o777);
            symlink.set_link_name("original").unwrap();
            symlink.set_cksum();
            builder.append(&symlink, std::io::empty()).unwrap();
            let mut hardlink = tar::Header::new_gnu();
            hardlink.set_path("wrapper/hard").unwrap();
            hardlink.set_entry_type(tar::EntryType::Link);
            hardlink.set_size(0);
            hardlink.set_mode(0o644);
            hardlink.set_link_name("wrapper/original").unwrap();
            hardlink.set_cksum();
            builder.append(&hardlink, std::io::empty()).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let destination = root.path().join("out");
        extract_verified_archive(&archive, "https://example.test/links.tar", &destination).unwrap();
        assert_eq!(fs::read(destination.join("link")).unwrap(), b"bytes");
        assert_eq!(fs::read(destination.join("hard")).unwrap(), b"bytes");

        let archive = root.path().join("write-through.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut directory = tar::Header::new_gnu();
            directory.set_path("inside").unwrap();
            directory.set_entry_type(tar::EntryType::Directory);
            directory.set_size(0);
            directory.set_mode(0o755);
            directory.set_cksum();
            builder.append(&directory, std::io::empty()).unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("alias").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            link.set_mode(0o777);
            link.set_link_name("inside").unwrap();
            link.set_cksum();
            builder.append(&link, std::io::empty()).unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("alias/forbidden").unwrap();
            file.set_size(4);
            file.set_mode(0o644);
            file.set_cksum();
            builder.append(&file, &b"evil"[..]).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let destination = root.path().join("write-through-out");
        extract_verified_archive(
            &archive,
            "https://example.test/write-through.tar",
            &destination,
        )
        .expect_err("write through extracted symlink");
        assert!(!destination.join("inside/forbidden").exists());
    }

    #[test]
    fn verified_extraction_rejects_absolute_traversal_and_special_entries() {
        for (label, path, entry_type) in [
            ("absolute", "/outside", tar::EntryType::Regular),
            ("traversal", "../outside", tar::EntryType::Regular),
            ("special", "device", tar::EntryType::Char),
        ] {
            let root = tempfile::tempdir().unwrap();
            let archive = root.path().join("hostile.tar");
            let mut bytes = Vec::new();
            {
                let mut builder = tar::Builder::new(&mut bytes);
                let mut header = tar::Header::new_gnu();
                header.set_path("placeholder").unwrap();
                header.set_entry_type(entry_type);
                header.set_size(if entry_type.is_file() { 1 } else { 0 });
                header.set_mode(0o644);
                if label != "special" {
                    let name = &mut header.as_mut_bytes()[..100];
                    name.fill(0);
                    name[..path.len()].copy_from_slice(path.as_bytes());
                }
                header.set_cksum();
                if entry_type.is_file() {
                    builder.append(&header, &b"x"[..]).unwrap();
                } else {
                    builder.append(&header, std::io::empty()).unwrap();
                }
                builder.finish().unwrap();
            }
            fs::write(&archive, bytes).unwrap();
            let outside = root.path().join("outside");
            fs::write(&outside, b"sentinel").unwrap();
            let destination = root.path().join("out");

            extract_verified_archive(&archive, "https://example.test/hostile.tar", &destination)
                .expect_err(label);

            assert_eq!(fs::read(&outside).unwrap(), b"sentinel");
        }

        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("hardlink.tar");
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            let mut hardlink = tar::Header::new_gnu();
            hardlink.set_path("escape").unwrap();
            hardlink.set_entry_type(tar::EntryType::Link);
            hardlink.set_size(0);
            hardlink.set_mode(0o644);
            hardlink.set_link_name("../outside").unwrap();
            hardlink.set_cksum();
            builder.append(&hardlink, std::io::empty()).unwrap();
            builder.finish().unwrap();
        }
        fs::write(&archive, bytes).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, b"sentinel").unwrap();
        extract_verified_archive(
            &archive,
            "https://example.test/hardlink.tar",
            &root.path().join("out"),
        )
        .expect_err("escaping hardlink");
        assert_eq!(fs::read(outside).unwrap(), b"sentinel");

        let archive = root.path().join("traversal.zip");
        let mut zip_bytes = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut zip_bytes);
            zip.start_file("../outside", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"evil").unwrap();
            zip.finish().unwrap();
        }
        fs::write(&archive, zip_bytes.into_inner()).unwrap();
        extract_verified_archive(
            &archive,
            "https://example.test/traversal.zip",
            &root.path().join("zip-out"),
        )
        .expect_err("zip traversal");
        assert_eq!(fs::read(root.path().join("outside")).unwrap(), b"sentinel");
    }

    #[test]
    fn tar_and_zip_actual_output_are_bounded() {
        let root = tempfile::tempdir().unwrap();
        let tar_destination = root.path().join("tar-out");
        fs::create_dir(&tar_destination).unwrap();
        extract_tar_reader(
            Cursor::new(wrapper_tar()),
            &tar_destination,
            "tar fixture",
            100,
        )
        .expect_err("tar cap");

        let zip_path = root.path().join("fixture.zip");
        fs::write(&zip_path, encode_fixture(".zip")).unwrap();
        let zip = zip::ZipArchive::new(File::open(&zip_path).unwrap()).unwrap();
        let zip_destination = root.path().join("zip-out");
        fs::create_dir(&zip_destination).unwrap();
        extract_zip(zip, &zip_destination, 4).expect_err("zip cap");
    }
}
