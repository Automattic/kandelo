//! Remote-fetch resolver path.
//!
//! When a `package.toml` carries a `[binary]` block, the resolver tries to
//! fetch and install the prebuilt archive *before* falling back to a
//! source build. The path slots between "cache miss" and "run build
//! script" in [`build_deps::ensure_built_inner`].
//!
//! # Verification chain
//!
//! Each step short-circuits to `Err`. The caller logs and falls
//! through to the source build on any failure, so a remote fetch can
//! never cause the resolver to refuse to produce an artifact — only
//! ever to take a slower path.
//!
//!   1. **Fetch.** GET the archive over `http(s)://`, or read it from
//!      disk for `file://` (used by tests). Errors → fall through.
//!   2. **Sha256.** Hash the bytes; reject on mismatch with
//!      `[binary].archive_sha256`.
//!   3. **Decompress + extract** into `<canonical>.tmp-<pid>/`.
//!   4. **Parse `manifest.toml`** as an archived manifest (must
//!      contain `[compatibility]`).
//!   5. **`compatibility.target_arch`** must match the resolver's arch.
//!   6. **`compatibility.abi_versions`** must contain the consumer's
//!      kernel ABI version.
//!   7. **`compatibility.cache_key_sha`** must match the locally-
//!      computed cache-key sha (i.e. archive's source recipe + build
//!      tree hash to the same value the consumer would have produced
//!      from source). This is the strict equivalence check —
//!      mismatching name/version is implicitly impossible if the cache
//!      key matches.
//!   8. **Reshape.** Move `artifacts/*` to the temp dir's root and
//!      remove the now-empty `artifacts/` plus `manifest.toml`. The
//!      archive bundle layout (manifest.toml at top, artifacts/ as a
//!      subdir) is *not* the canonical cache layout (lib/, include/,
//!      etc. at top); we flatten before installing.
//!   9. **Atomic rename** into the canonical cache path. If a peer
//!      raced us, discard our tmp.
//!
//! Any error after step 3 cleans up the temp dir before returning.
//!
//! # Security note on `file://`
//!
//! `file://` URLs let tests sidestep a real HTTP server. They are also
//! reachable from a malicious `package.toml` and can read arbitrary
//! local files. That's the user's choice — they put the URL in their
//! own `package.toml`. We do not sanitise.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::pkg_manifest::{Binary, DepsManifest, TargetArch};
use crate::util::hex;

/// Maximum response size we will accept from `fetch_url`. A registry
/// answering with a runaway body would otherwise OOM the resolver.
/// 256 MB comfortably exceeds anything we expect to publish (even a
/// kitchen-sink LAMP bundle is well under this) but bounds memory.
///
/// Truncated responses are caught downstream by the SHA-256 check —
/// `read_to_end(take(LIMIT))` returns OK on hit, and the digest will
/// not match the publisher's expected `archive_sha256`.
const MAX_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;

/// Maximum number of decompressed bytes we will pipe out of the zstd
/// decoder into `tar`. A malicious archive ("zip bomb") could otherwise
/// extract many GB to disk. 1 GB is well above any real published
/// artifact and bounds disk use.
///
/// On overflow, `tar::Archive::unpack` sees a truncated stream and
/// surfaces it as `FetchError::ExtractFailed`.
const MAX_DECOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;

/// Reasons a remote fetch can fail. Caller logs and falls through to
/// source build — none of these is fatal to the resolver.
#[derive(Debug)]
#[allow(dead_code)] // Variant fields are read via Debug formatting.
pub enum FetchError {
    /// Underlying HTTP / file read failed.
    Http(String),
    /// `sha256(bytes)` ≠ `[binary].archive_sha256`.
    ShaMismatch { expected: String, actual: String },
    /// `zstd` decompression failed.
    DecompressFailed(String),
    /// `tar` extraction failed.
    ExtractFailed(String),
    /// `manifest.toml` not present in extracted archive.
    ManifestMissing(String),
    /// `manifest.toml` failed to parse (or compatibility validation).
    ManifestParseError(String),
    /// `compatibility.target_arch` ≠ resolver arch.
    ArchMismatch { expected: TargetArch, found: TargetArch },
    /// Consumer's ABI not in `compatibility.abi_versions`.
    AbiMismatch { current: u32, supported: Vec<u32> },
    /// Archive `cache_key_sha` ≠ locally-computed cache_key sha.
    CacheKeyMismatch { local: String, archived: String },
    /// Filesystem operation (mkdir / rename / read_dir / …) failed.
    IoError(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Http(s) => write!(f, "fetch failed: {s}"),
            FetchError::ShaMismatch { expected, actual } => write!(
                f,
                "archive sha mismatch: expected {expected}, got {actual}"
            ),
            FetchError::DecompressFailed(s) => write!(f, "zstd decompress failed: {s}"),
            FetchError::ExtractFailed(s) => write!(f, "tar extract failed: {s}"),
            FetchError::ManifestMissing(s) => write!(f, "manifest.toml missing: {s}"),
            FetchError::ManifestParseError(s) => write!(f, "manifest.toml parse error: {s}"),
            FetchError::ArchMismatch { expected, found } => write!(
                f,
                "arch mismatch: resolver wants {}, archive has {}",
                expected.as_str(),
                found.as_str()
            ),
            FetchError::AbiMismatch { current, supported } => write!(
                f,
                "abi mismatch: kernel ABI {current}, archive supports {supported:?}"
            ),
            FetchError::CacheKeyMismatch { local, archived } => write!(
                f,
                "cache_key_sha mismatch: local {local}, archive {archived}"
            ),
            FetchError::IoError(s) => write!(f, "io: {s}"),
        }
    }
}

impl std::error::Error for FetchError {}

/// Top-level entry point. Verifies + installs the prebuilt archive
/// described by `binary` into `canonical`. Returns `Ok(())` on a
/// successful install (or on a benign race where another process won
/// the rename); any other condition becomes a `FetchError` and the
/// caller falls through to the source build.
///
/// `target` (the source manifest) is currently only used to plumb
/// shape; the strict equivalence check is via `local_cache_key_sha_hex`.
pub fn fetch_and_install(
    binary: &Binary,
    canonical: &Path,
    _target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    local_cache_key_sha_hex: &str,
) -> Result<(), FetchError> {
    // 1. Fetch.
    let bytes = fetch_url(&binary.archive_url)?;

    // 2. Sha256.
    verify_sha(&bytes, &binary.archive_sha256)?;

    // 3. Decompress + extract into `<canonical>.tmp-<pid>/`.
    let parent = canonical
        .parent()
        .ok_or_else(|| FetchError::IoError(format!(
            "canonical has no parent: {}",
            canonical.display()
        )))?;
    fs::create_dir_all(parent).map_err(|e| FetchError::IoError(format!(
        "create cache parent {}: {e}",
        parent.display()
    )))?;

    let tmp_name = format!(
        "{}.tmp-{}",
        canonical
            .file_name()
            .expect("canonical path has a filename")
            .to_string_lossy(),
        std::process::id()
    );
    let tmp = parent.join(tmp_name);
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    fs::create_dir_all(&tmp).map_err(|e| FetchError::IoError(format!(
        "create temp {}: {e}",
        tmp.display()
    )))?;

    // From here on we own `tmp`; cleanup on every error path.
    if let Err(e) = extract_tar_zst(&bytes, &tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // 4. Parse manifest.toml.
    let manifest_path = tmp.join("manifest.toml");
    if !manifest_path.is_file() {
        let _ = fs::remove_dir_all(&tmp);
        return Err(FetchError::ManifestMissing(format!(
            "expected {}, not found",
            manifest_path.display()
        )));
    }
    let manifest_text = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(FetchError::IoError(format!(
                "read {}: {e}",
                manifest_path.display()
            )));
        }
    };
    let archived = match DepsManifest::parse_archived(&manifest_text, tmp.clone()) {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(FetchError::ManifestParseError(e));
        }
    };
    let compat = archived
        .compatibility
        .as_ref()
        .expect("parse_archived guarantees compatibility");

    // 5. target_arch.
    if compat.target_arch != arch {
        let _ = fs::remove_dir_all(&tmp);
        return Err(FetchError::ArchMismatch {
            expected: arch,
            found: compat.target_arch,
        });
    }

    // 6. abi_versions.
    if !compat.abi_versions.contains(&abi_version) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(FetchError::AbiMismatch {
            current: abi_version,
            supported: compat.abi_versions.clone(),
        });
    }

    // 7. cache_key_sha equivalence.
    if compat.cache_key_sha != local_cache_key_sha_hex {
        let _ = fs::remove_dir_all(&tmp);
        return Err(FetchError::CacheKeyMismatch {
            local: local_cache_key_sha_hex.to_string(),
            archived: compat.cache_key_sha.clone(),
        });
    }

    // 8. Reshape: hoist artifacts/* up to tmp root, drop manifest.toml + artifacts/.
    if let Err(e) = flatten_archive_layout(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // 9. Atomic rename. If a peer raced us, discard ours.
    if canonical.exists() {
        let _ = fs::remove_dir_all(&tmp);
        return Ok(());
    }
    if let Err(e) = fs::rename(&tmp, canonical) {
        // The rename may have failed because a peer process beat us
        // between the `exists()` check above and our `rename(2)` —
        // in which case the install has *already succeeded* (via the
        // peer) and we should report success. Re-check post-failure
        // before surfacing an error.
        let _ = fs::remove_dir_all(&tmp);
        if canonical.exists() {
            return Ok(());
        }
        return Err(FetchError::IoError(format!(
            "atomic rename {} -> {}: {e}",
            tmp.display(),
            canonical.display()
        )));
    }
    Ok(())
}

/// Fetch the archive bytes. Supports `file://` (for tests + local
/// caches) and `http(s)://` (real downloads). Errors are wrapped in
/// `FetchError::Http` regardless of underlying cause — the caller's
/// only response is to fall through to source build.
///
/// # URL-scheme policy
///
/// Plain `http://` is allowed: integrity is ensured by the SHA-256
/// check on the bytes after fetch (`verify_sha`). Confidentiality is
/// not a goal — `archive_sha256` is already public information, sat
/// next to `archive_url` in the consumer's `package.toml`. A MITM cannot
/// substitute bytes that hash to the published digest.
///
/// `file://` is allowed for tests and offline development. The risk
/// is bounded by the user controlling their own `package.toml` registry
/// list — a malicious manifest could read arbitrary local files, but
/// the user already had to add the manifest.
pub(crate) fn fetch_url(url: &str) -> Result<Vec<u8>, FetchError> {
    if let Some(rest) = url.strip_prefix("file://") {
        return fs::read(rest)
            .map_err(|e| FetchError::Http(format!("file://{rest}: {e}")));
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        // Always set timeouts and a UA so a misbehaving registry
        // can't hang the resolver indefinitely and so server logs can
        // attribute the request.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(30))
            .timeout_read(Duration::from_secs(60))
            .user_agent(concat!(
                "wasm-posix-kernel-xtask/",
                env!("CARGO_PKG_VERSION")
            ))
            .build();
        let resp = agent
            .get(url)
            .call()
            .map_err(|e| FetchError::Http(format!("{url}: {e}")))?;
        // Cap response at MAX_RESPONSE_BYTES. A truncated body just
        // produces a SHA mismatch downstream, so no explicit oversize
        // error is needed here.
        let mut bytes: Vec<u8> = Vec::new();
        std::io::Read::take(resp.into_reader(), MAX_RESPONSE_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| FetchError::Http(format!("read {url}: {e}")))?;
        return Ok(bytes);
    }
    Err(FetchError::Http(format!(
        "unsupported url scheme: {url:?} (expected file://, http://, https://)"
    )))
}

/// Sha256(bytes) ≟ `expected_hex` (64-char lowercase hex).
pub(crate) fn verify_sha(bytes: &[u8], expected_hex: &str) -> Result<(), FetchError> {
    let mut h = Sha256::new();
    h.update(bytes);
    let actual: [u8; 32] = h.finalize().into();
    let actual_hex = hex(&actual);
    if actual_hex != expected_hex {
        return Err(FetchError::ShaMismatch {
            expected: expected_hex.to_string(),
            actual: actual_hex,
        });
    }
    Ok(())
}

/// Decompress `bytes` (`.tar.zst`) into `dest`.
///
/// Decompressed output is capped at `MAX_DECOMPRESSED_BYTES` to
/// defend against zip-bomb-style archives that decompress to many
/// times the on-wire size. On overflow the stream truncates mid-tar
/// and the unpack call returns `FetchError::ExtractFailed`.
fn extract_tar_zst(bytes: &[u8], dest: &Path) -> Result<(), FetchError> {
    let decoder = zstd::stream::read::Decoder::new(bytes)
        .map_err(|e| FetchError::DecompressFailed(format!("{e}")))?;
    let bounded = std::io::Read::take(decoder, MAX_DECOMPRESSED_BYTES);
    let mut tar = tar::Archive::new(bounded);
    tar.unpack(dest)
        .map_err(|e| FetchError::ExtractFailed(format!("{e}")))?;
    Ok(())
}

/// After extraction, the temp dir contains `manifest.toml` plus an
/// `artifacts/` subdirectory holding the actual cache layout
/// (`lib/`, `include/`, `lib/pkgconfig/`). The canonical cache layout
/// has those at the *root*. Move them up and drop the wrapper.
fn flatten_archive_layout(tmp: &Path) -> Result<(), FetchError> {
    let artifacts = tmp.join("artifacts");
    if artifacts.is_dir() {
        let rd = fs::read_dir(&artifacts).map_err(|e| FetchError::IoError(format!(
            "read_dir {}: {e}",
            artifacts.display()
        )))?;
        for entry in rd {
            let entry = entry.map_err(|e| FetchError::IoError(format!(
                "read_dir {}: {e}",
                artifacts.display()
            )))?;
            let src = entry.path();
            let dst = tmp.join(entry.file_name());
            fs::rename(&src, &dst).map_err(|e| FetchError::IoError(format!(
                "rename {} -> {}: {e}",
                src.display(),
                dst.display()
            )))?;
        }
        fs::remove_dir_all(&artifacts).map_err(|e| FetchError::IoError(format!(
            "remove {}: {e}",
            artifacts.display()
        )))?;
    }
    let manifest = tmp.join("manifest.toml");
    if manifest.is_file() {
        let _ = fs::remove_file(&manifest);
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Test helpers shared with `build_deps`'s integration tests
// ---------------------------------------------------------------------

/// Build a `.tar.zst` archive containing `manifest.toml` plus
/// `artifacts/<files...>` — the layout produced by the binary-cache
/// publishing pipeline. Used by both this module's unit tests and the
/// remote-fetch integration tests in `build_deps`.
#[cfg(test)]
pub(crate) fn build_test_archive(
    manifest_text: &str,
    artifact_files: &[(&str, &[u8])],
) -> Vec<u8> {
    use std::io::Write;

    let mut tar_bytes: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_bytes);

        let mut header = tar::Header::new_gnu();
        header.set_size(manifest_text.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "manifest.toml", manifest_text.as_bytes())
            .unwrap();

        for (rel, bytes) in artifact_files {
            let path = format!("artifacts/{rel}");
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, &path, *bytes).unwrap();
        }
        builder.finish().unwrap();
    }

    let mut zst_bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = zstd::stream::write::Encoder::new(&mut zst_bytes, 0).unwrap();
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap();
    }
    zst_bytes
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-rfetch")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn verify_sha_accepts_matching_digest() {
        let bytes = b"hello world";
        let mut h = Sha256::new();
        h.update(bytes);
        let digest: [u8; 32] = h.finalize().into();
        let hexd = hex(&digest);
        verify_sha(bytes, &hexd).unwrap();
    }

    #[test]
    fn verify_sha_rejects_mismatched_digest() {
        let bytes = b"hello world";
        let bogus = "0".repeat(64);
        let err = verify_sha(bytes, &bogus).unwrap_err();
        match err {
            FetchError::ShaMismatch { expected, actual } => {
                assert_eq!(expected, bogus);
                assert_ne!(actual, bogus);
            }
            other => panic!("unexpected err: {other:?}"),
        }
    }

    #[test]
    fn fetch_url_reads_file_scheme() {
        let dir = tempdir("file-url");
        let payload = b"some archive bytes";
        let p = dir.join("a.bin");
        fs::write(&p, payload).unwrap();
        let url = format!("file://{}", p.display());
        let got = fetch_url(&url).unwrap();
        assert_eq!(got, payload);
    }

    #[test]
    fn fetch_url_returns_error_for_missing_file() {
        let url = "file:///definitely/not/here-xyz123.bin";
        let err = fetch_url(url).unwrap_err();
        assert!(
            matches!(err, FetchError::Http(_)),
            "unexpected: {err:?}"
        );
    }

    #[test]
    fn fetch_url_rejects_unsupported_scheme() {
        let err = fetch_url("ftp://example.test/x").unwrap_err();
        assert!(matches!(err, FetchError::Http(_)));
    }

    #[test]
    fn extract_tar_zst_round_trips() {
        let manifest = "kind = \"library\"\nname = \"x\"\n";
        let archive = build_test_archive(manifest, &[("lib/libX.a", b"\x00\x01\x02")]);

        let dest = tempdir("extract-rt");
        extract_tar_zst(&archive, &dest).unwrap();
        let m = fs::read_to_string(dest.join("manifest.toml")).unwrap();
        assert_eq!(m, manifest);
        let lib = fs::read(dest.join("artifacts/lib/libX.a")).unwrap();
        assert_eq!(lib, b"\x00\x01\x02");
    }

    #[test]
    fn flatten_archive_layout_hoists_artifacts() {
        let dir = tempdir("flatten");
        fs::write(dir.join("manifest.toml"), "x").unwrap();
        fs::create_dir_all(dir.join("artifacts/lib")).unwrap();
        fs::write(dir.join("artifacts/lib/libZ.a"), b"data").unwrap();

        flatten_archive_layout(&dir).unwrap();

        assert!(!dir.join("manifest.toml").exists());
        assert!(!dir.join("artifacts").exists());
        assert!(dir.join("lib/libZ.a").is_file());
    }
}
