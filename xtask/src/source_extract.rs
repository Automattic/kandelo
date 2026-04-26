//! Source-kind archive fetch + extract. Reused by the resolver
//! when a `kind = "source"` manifest has no [build].script.
//!
//! Format detection is purely on URL extension. The resolver
//! never inspects archive bytes for magic numbers — the URL is
//! authoritative because the manifest's source.sha256 anchors
//! both the bytes and the format.

use std::fs;
use std::io::Read;
use std::path::Path;

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
        let path = url
            .split_once('?')
            .map(|(p, _)| p)
            .unwrap_or(url);
        let path = path
            .split_once('#')
            .map(|(p, _)| p)
            .unwrap_or(path);
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
pub fn fetch_and_extract(
    url: &str,
    sha256_hex: &str,
    dest: &Path,
) -> Result<(), String> {
    let bytes = fetch_url(url).map_err(|e| format!("{e}"))?;
    verify_sha(&bytes, sha256_hex).map_err(|e| format!("{e}"))?;
    let format = ArchiveFormat::from_url(url)?;
    extract(&bytes, format, dest)?;
    flatten_single_top_level(dest)?;
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
            let mut zip =
                zip::ZipArchive::new(cursor).map_err(|e| format!("zip parse: {e}"))?;
            // ZipArchive::extract trusts each entry's declared
            // uncompressed_size from the central directory and
            // applies no aggregate cap. Pre-flight by summing
            // declared sizes and reject if the total exceeds
            // MAX_DECOMPRESSED_BYTES — mirrors the Read::take cap
            // applied to every tar variant above.
            let mut total: u64 = 0;
            for i in 0..zip.len() {
                let f = zip
                    .by_index(i)
                    .map_err(|e| format!("zip entry {i}: {e}"))?;
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
    let metadata = fs::metadata(&only_path)
        .map_err(|e| format!("stat {}: {e}", only_path.display()))?;
    if !metadata.is_dir() {
        return Ok(());
    }
    // Move children one level up.
    for child in fs::read_dir(&only_path)
        .map_err(|e| format!("read_dir {}: {e}", only_path.display()))?
    {
        let child = child.map_err(|e| format!("read_dir entry: {e}"))?;
        let from = child.path();
        let to = dest.join(child.file_name());
        fs::rename(&from, &to)
            .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
    }
    fs::remove_dir(&only_path)
        .map_err(|e| format!("rmdir {}: {e}", only_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::Write;

    fn make_tar_gz_with_top_dir() -> (Vec<u8>, &'static str) {
        // Construct a tarball containing a single top-level dir
        // `pcre2-10.42/` with one file `pcre2-10.42/README` whose
        // contents are `hello\n`.
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(
                &mut tar_bytes,
                flate2::Compression::default(),
            );
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
            let enc = flate2::write::GzEncoder::new(
                &mut tar_bytes,
                flate2::Compression::default(),
            );
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
}
