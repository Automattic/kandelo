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
//!   7. **`compatibility.git_inputs`** must exactly match the current
//!      package's declared immutable Git inputs.
//!   8. **`compatibility.cache_key_sha`** must match the locally-
//!      computed cache-key sha (i.e. archive's source recipe + build
//!      tree hash to the same value the consumer would have produced
//!      from source). This is the strict equivalence check —
//!      mismatching name/version is implicitly impossible if the cache
//!      key matches.
//!   9. **Reshape.** Move `artifacts/*` to the temp dir's root and
//!      remove the now-empty `artifacts/` plus `manifest.toml`. The
//!      archive bundle layout (manifest.toml at top, artifacts/ as a
//!      subdir) is *not* the canonical cache layout (lib/, include/,
//!      etc. at top); we flatten before installing.
//!   10. **Atomic rename** into the canonical cache path. If a peer
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

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::pkg_manifest::{Binary, BuildToml, DepsManifest, GitBuildInput, TargetArch};
use crate::util::hex;

/// Maximum response size we will accept from `fetch_url` and archive
/// downloads. A registry answering with a runaway body would otherwise
/// OOM the resolver or fill the cache filesystem. 256 MB comfortably
/// exceeds anything we expect to publish (even a kitchen-sink LAMP
/// bundle is well under this) but bounds resource use.
///
/// Truncated responses are caught downstream by the SHA-256 check —
/// `read_to_end(take(LIMIT))` returns OK on hit, and the digest will
/// not match the publisher's expected `archive_sha256`.
const MAX_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;
const DOWNLOAD_BUFFER_BYTES: usize = 64 * 1024;
const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_secs(5);
const DOWNLOAD_PROGRESS_BYTES: u64 = 8 * 1024 * 1024;
const HTTP_ARCHIVE_DOWNLOAD_DEADLINE: Duration = Duration::from_secs(60 * 60);

/// Maximum number of decompressed bytes we will pipe out of the zstd
/// decoder into `tar`. A malicious archive ("zip bomb") could otherwise
/// extract many GB to disk. 1 GB is well above any real published
/// artifact and bounds disk use.
///
/// On overflow, `tar::Archive::unpack` sees a truncated stream and
/// surfaces it as `FetchError::ExtractFailed`.
const MAX_DECOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;

/// HTTP archive fetch retry budget. GitHub Release asset downloads can
/// intermittently return 5xx from the CDN; retrying the bounded fetch is
/// cheaper than failing an otherwise-green matrix job.
const HTTP_FETCH_ATTEMPTS: usize = 3;
const HTTP_FETCH_BACKOFF: Duration = Duration::from_secs(5);

/// Reasons a remote fetch can fail. Caller logs and falls through to
/// source build — none of these is fatal to the resolver.
#[derive(Debug)]
#[allow(dead_code)] // Some validation variants are only constructed on fallback paths.
pub enum FetchError {
    /// Underlying HTTP / file read failed.
    Http(String),
    /// A read timeout, stall detector, or overall download deadline fired.
    Timeout(String),
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
    ArchMismatch {
        expected: TargetArch,
        found: TargetArch,
    },
    /// Consumer's ABI not in `compatibility.abi_versions`.
    AbiMismatch { current: u32, supported: Vec<u32> },
    /// Archive `cache_key_sha` ≠ locally-computed cache_key sha.
    CacheKeyMismatch { local: String, archived: String },
    /// Archive external-Git provenance differs from current build.toml.
    GitInputsMismatch {
        expected: Vec<GitBuildInput>,
        archived: Vec<GitBuildInput>,
    },
    /// Filesystem operation (mkdir / rename / read_dir / …) failed.
    IoError(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Http(s) if looks_like_timeout(s) => write!(f, "download timeout: {s}"),
            FetchError::Http(s) => write!(f, "network fetch failed: {s}"),
            FetchError::Timeout(s) => write!(f, "download timeout: {s}"),
            FetchError::ShaMismatch { expected, actual } => {
                write!(f, "archive sha mismatch: expected {expected}, got {actual}")
            }
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
            FetchError::GitInputsMismatch { expected, archived } => write!(
                f,
                "immutable git inputs mismatch: current build.toml {expected:?}, archive {archived:?}"
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
    target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    local_cache_key_sha_hex: &str,
) -> Result<(), FetchError> {
    fetch_and_install_direct(
        &binary.archive_url,
        &binary.archive_sha256,
        canonical,
        target,
        arch,
        abi_version,
        local_cache_key_sha_hex,
    )
}

/// Like [`fetch_and_install`], but takes the archive URL + sha
/// directly instead of reading them from a [`Binary`] struct. Used
/// by the index-lookup resolution path (post
/// binary-resolution-via-index-ledger), where the URL + sha come
/// from an `index.toml` entry rather than `package.toml`.
#[allow(clippy::too_many_arguments)]
pub fn fetch_and_install_direct(
    archive_url: &str,
    archive_sha256: &str,
    canonical: &Path,
    target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    local_cache_key_sha_hex: &str,
) -> Result<(), FetchError> {
    // 1. Prepare cache parent and stream the archive into a sibling temp file.
    let parent = canonical.parent().ok_or_else(|| {
        FetchError::IoError(format!("canonical has no parent: {}", canonical.display()))
    })?;
    fs::create_dir_all(parent).map_err(|e| {
        FetchError::IoError(format!("create cache parent {}: {e}", parent.display()))
    })?;
    let archive_file =
        fetch_archive_to_temp_file(archive_url, archive_sha256, parent, &target.spec())?;

    // 2. Decompress + extract into `<canonical>.tmp-<pid>/`.
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
    fs::create_dir_all(&tmp)
        .map_err(|e| FetchError::IoError(format!("create temp {}: {e}", tmp.display())))?;

    // From here on we own `tmp`; cleanup on every error path.
    if let Err(e) = extract_tar_zst_file(archive_file.path(), &tmp) {
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

    // 7. Immutable external Git inputs must match as exact ordered tuples.
    // Cache-key participation is necessary but insufficient evidence here:
    // compare the human-auditable archived provenance directly so an archive
    // cannot claim a different source identity under a copied cache key.
    let expected_git_inputs = if target.dir.join("build.toml").exists() {
        match BuildToml::load(&target.dir) {
            Ok(build) => build.git_inputs,
            Err(e) => {
                let _ = fs::remove_dir_all(&tmp);
                return Err(FetchError::ManifestParseError(format!(
                    "load current build.toml git inputs: {e}"
                )));
            }
        }
    } else {
        Vec::new()
    };
    if compat.git_inputs != expected_git_inputs {
        let _ = fs::remove_dir_all(&tmp);
        return Err(FetchError::GitInputsMismatch {
            expected: expected_git_inputs,
            archived: compat.git_inputs.clone(),
        });
    }

    // 8. cache_key_sha equivalence.
    if compat.cache_key_sha != local_cache_key_sha_hex {
        let _ = fs::remove_dir_all(&tmp);
        return Err(FetchError::CacheKeyMismatch {
            local: local_cache_key_sha_hex.to_string(),
            archived: compat.cache_key_sha.clone(),
        });
    }

    // 9. Reshape: hoist artifacts/* up to tmp root, drop manifest.toml + artifacts/.
    if let Err(e) = flatten_archive_layout(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // 10. Atomic rename. If a peer raced us, discard ours.
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
        return fs::read(rest).map_err(|e| FetchError::Http(format!("file://{rest}: {e}")));
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        // Honor WASM_POSIX_OFFLINE: when set to a non-empty, non-"0"
        // value (e.g. by `scripts/fetch-binaries.sh --offline`), refuse
        // to issue HTTP requests. Surfaces as `FetchError::Http` so the
        // caller falls through to source build the same way a network
        // failure would.
        if std::env::var_os("WASM_POSIX_OFFLINE").is_some_and(|v| !v.is_empty() && v != "0") {
            return Err(FetchError::Http(format!(
                "WASM_POSIX_OFFLINE is set; refusing to fetch {url}. \
                 Run without --offline or pre-populate the cache."
            )));
        }
        return fetch_http_url(url, HTTP_FETCH_ATTEMPTS, HTTP_FETCH_BACKOFF);
    }
    Err(FetchError::Http(format!(
        "unsupported url scheme: {url:?} (expected file://, http://, https://)"
    )))
}

#[derive(Debug)]
struct TempArchiveFile {
    path: PathBuf,
}

impl TempArchiveFile {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempArchiveFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn fetch_archive_to_temp_file(
    url: &str,
    archive_sha256: &str,
    temp_dir: &Path,
    label: &str,
) -> Result<TempArchiveFile, FetchError> {
    let (tmp, mut file) = create_temp_archive_file(temp_dir, label)?;
    let fetch_result = if let Some(rest) = url.strip_prefix("file://") {
        copy_file_url_to_temp(rest, &mut file)
    } else if url.starts_with("http://") || url.starts_with("https://") {
        if std::env::var_os("WASM_POSIX_OFFLINE").is_some_and(|v| !v.is_empty() && v != "0") {
            Err(FetchError::Http(format!(
                "WASM_POSIX_OFFLINE is set; refusing to fetch {url}. \
                 Run without --offline or pre-populate the cache."
            )))
        } else {
            fetch_http_archive_to_file(url, &mut file, label)
        }
    } else {
        Err(FetchError::Http(format!(
            "unsupported url scheme: {url:?} (expected file://, http://, https://)"
        )))
    };

    if let Err(e) = fetch_result {
        drop(file);
        drop(tmp);
        return Err(e);
    }
    file.flush()
        .map_err(|e| FetchError::IoError(format!("flush {}: {e}", tmp.path().display())))?;
    drop(file);

    match verify_sha_file(tmp.path(), archive_sha256) {
        Ok(()) => Ok(tmp),
        Err(e) => {
            drop(tmp);
            Err(e)
        }
    }
}

fn create_temp_archive_file(
    dir: &Path,
    label: &str,
) -> Result<(TempArchiveFile, File), FetchError> {
    let safe_label = sanitize_temp_label(label);
    for counter in 0..1000 {
        let path = dir.join(format!(
            ".tmp-{safe_label}-archive-{}-{counter}",
            std::process::id()
        ));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((TempArchiveFile { path }, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(FetchError::IoError(format!(
                    "create temp archive {}: {e}",
                    path.display()
                )));
            }
        }
    }
    Err(FetchError::IoError(format!(
        "could not allocate temp archive file in {}",
        dir.display()
    )))
}

fn sanitize_temp_label(label: &str) -> String {
    let mut out = String::new();
    for ch in label.chars() {
        if out.len() >= 48 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() {
        out.push_str("archive");
    }
    out
}

fn copy_file_url_to_temp(rest: &str, dest: &mut File) -> Result<(), FetchError> {
    let mut source =
        File::open(rest).map_err(|e| FetchError::Http(format!("file://{rest}: {e}")))?;
    let mut copied = 0u64;
    let mut buf = [0u8; DOWNLOAD_BUFFER_BYTES];
    loop {
        let n = source
            .read(&mut buf)
            .map_err(|e| FetchError::Http(format!("file://{rest}: read failed: {e}")))?;
        if n == 0 {
            break;
        }
        copied = checked_download_size(copied, n as u64)?;
        dest.write_all(&buf[..n])
            .map_err(|e| FetchError::IoError(format!("write temp archive: {e}")))?;
    }
    Ok(())
}

fn fetch_http_archive_to_file(url: &str, file: &mut File, label: &str) -> Result<(), FetchError> {
    let attempts = HTTP_FETCH_ATTEMPTS.max(1);
    let agent = build_http_agent();
    let started = Instant::now();
    let deadline = started
        .checked_add(HTTP_ARCHIVE_DOWNLOAD_DEADLINE)
        .unwrap_or(started);
    let mut progress = DownloadProgress::new(label, url, started);
    let mut downloaded = 0u64;
    let mut total = None;
    let mut last_error: Option<HttpArchiveAttemptError> = None;
    let mut attempts_used = 0usize;

    eprintln!("remote_fetch: downloading archive for {label} from {url}");

    for attempt in 1..=attempts {
        attempts_used = attempt;
        if Instant::now() >= deadline {
            return Err(FetchError::Timeout(format!(
                "{label} from {url} exceeded {} download deadline",
                format_duration(HTTP_ARCHIVE_DOWNLOAD_DEADLINE)
            )));
        }

        let resume = downloaded > 0;
        if resume {
            eprintln!(
                "remote_fetch: resuming archive download for {label} at {}{}",
                format_bytes(downloaded),
                total
                    .map(|t| format!(" / {}", format_bytes(t)))
                    .unwrap_or_default()
            );
        }

        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        if remaining.is_zero() {
            return Err(FetchError::Timeout(format!(
                "{label} from {url} exceeded {} download deadline",
                format_duration(HTTP_ARCHIVE_DOWNLOAD_DEADLINE)
            )));
        }

        let mut req = agent.get(url).timeout(remaining);
        let range_header;
        if resume {
            range_header = format!("bytes={downloaded}-");
            req = req.set("Range", &range_header);
        }

        let response = match req.call() {
            Ok(resp) => resp,
            Err(err) => {
                let attempt_error = HttpArchiveAttemptError::from_ureq(err);
                last_error = Some(attempt_error);
                if !last_error.as_ref().unwrap().retryable || attempt == attempts {
                    break;
                }
                warn_retry(label, url, last_error.as_ref().unwrap(), attempt, attempts);
                sleep_for_retry(deadline);
                continue;
            }
        };

        match handle_http_archive_response(
            response,
            file,
            label,
            &mut progress,
            &mut downloaded,
            &mut total,
            resume,
            deadline,
        ) {
            Ok(()) => return Ok(()),
            Err(ArchiveTransferError::Fatal(e)) => return Err(e),
            Err(ArchiveTransferError::Attempt(attempt_error)) => {
                last_error = Some(attempt_error);
                if !last_error.as_ref().unwrap().retryable || attempt == attempts {
                    break;
                }
                warn_retry(label, url, last_error.as_ref().unwrap(), attempt, attempts);
                sleep_for_retry(deadline);
            }
        }
    }

    let last_error = last_error.unwrap_or_else(|| {
        HttpArchiveAttemptError::network("download failed without an HTTP response".to_string())
    });
    let message = format!(
        "{url}: {} after {attempts_used} attempt(s)",
        last_error.message
    );
    if last_error.timeout {
        Err(FetchError::Timeout(message))
    } else {
        Err(FetchError::Http(message))
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_http_archive_response(
    resp: ureq::Response,
    file: &mut File,
    label: &str,
    progress: &mut DownloadProgress,
    downloaded: &mut u64,
    total: &mut Option<u64>,
    resume_requested: bool,
    deadline: Instant,
) -> Result<(), ArchiveTransferError> {
    let status = resp.status();
    let content_length = parse_content_length(resp.header("Content-Length"))?;
    let mut expected_response_bytes = content_length;

    match status {
        200 => {
            if resume_requested {
                eprintln!(
                    "remote_fetch: server ignored Range for {label}; restarting archive download"
                );
                restart_temp_file(file, downloaded, total)?;
                progress.reset(*downloaded, *total);
            } else if *downloaded != 0 {
                restart_temp_file(file, downloaded, total)?;
                progress.reset(*downloaded, *total);
            }
            *total = content_length;
        }
        206 => {
            let range = parse_content_range(resp.header("Content-Range"))?;
            if range.start != *downloaded {
                return Err(HttpArchiveAttemptError::non_retryable(format!(
                    "invalid Content-Range start {}; expected {}",
                    range.start, *downloaded
                ))
                .into());
            }
            let range_len = range.end - range.start + 1;
            if let Some(len) = content_length
                && len != range_len
            {
                return Err(HttpArchiveAttemptError::non_retryable(format!(
                    "Content-Length {len} disagrees with Content-Range length {range_len}"
                ))
                .into());
            }
            expected_response_bytes = Some(range_len);
            if let Some(range_total) = range.total {
                if range_total < range.end + 1 {
                    return Err(HttpArchiveAttemptError::non_retryable(format!(
                        "invalid Content-Range total {range_total} for end {}",
                        range.end
                    ))
                    .into());
                }
                if let Some(existing) = *total
                    && existing != range_total
                {
                    return Err(HttpArchiveAttemptError::non_retryable(format!(
                        "Content-Range total changed from {existing} to {range_total}"
                    ))
                    .into());
                }
                *total = Some(range_total);
            }
        }
        other => {
            return Err(HttpArchiveAttemptError::non_retryable(format!(
                "unexpected HTTP status {other}"
            ))
            .into());
        }
    }

    progress.set_total(*total);
    file.seek(SeekFrom::Start(*downloaded))
        .map_err(|e| FetchError::IoError(format!("seek temp archive: {e}")))?;
    let start = *downloaded;
    let written = stream_http_body_to_file(
        resp.into_reader(),
        file,
        downloaded,
        *total,
        progress,
        deadline,
    )?;

    if let Some(expected) = expected_response_bytes
        && written != expected
    {
        return Err(HttpArchiveAttemptError::network(format!(
            "response ended after {} from offset {}, expected {}",
            format_bytes(written),
            format_bytes(start),
            format_bytes(expected)
        ))
        .into());
    }

    if let Some(expected_total) = *total {
        if *downloaded == expected_total {
            progress.finish(*downloaded);
            return Ok(());
        }
        if *downloaded < expected_total {
            return Err(HttpArchiveAttemptError::network(format!(
                "response ended at {}, expected total {}",
                format_bytes(*downloaded),
                format_bytes(expected_total)
            ))
            .into());
        }
        return Err(HttpArchiveAttemptError::non_retryable(format!(
            "downloaded {}, exceeding expected total {}",
            format_bytes(*downloaded),
            format_bytes(expected_total)
        ))
        .into());
    }

    progress.finish(*downloaded);
    Ok(())
}

fn stream_http_body_to_file<R: Read>(
    mut reader: R,
    file: &mut File,
    downloaded: &mut u64,
    total: Option<u64>,
    progress: &mut DownloadProgress,
    deadline: Instant,
) -> Result<u64, ArchiveTransferError> {
    let start = *downloaded;
    let mut buf = [0u8; DOWNLOAD_BUFFER_BYTES];
    loop {
        if Instant::now() >= deadline {
            return Err(HttpArchiveAttemptError::timeout(
                "overall download deadline reached".to_string(),
                false,
            )
            .into());
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let timeout =
                    e.kind() == std::io::ErrorKind::TimedOut || looks_like_timeout(&e.to_string());
                let message = format!("read failed after {}: {e}", format_bytes(*downloaded));
                return Err(if timeout {
                    HttpArchiveAttemptError::timeout(message, true).into()
                } else {
                    HttpArchiveAttemptError::network(message).into()
                });
            }
        };
        let new_downloaded = checked_download_size(*downloaded, n as u64)?;
        if let Some(expected_total) = total
            && new_downloaded > expected_total
        {
            return Err(HttpArchiveAttemptError::non_retryable(format!(
                "downloaded {}, exceeding expected total {}",
                format_bytes(new_downloaded),
                format_bytes(expected_total)
            ))
            .into());
        }
        file.write_all(&buf[..n])
            .map_err(|e| FetchError::IoError(format!("write temp archive: {e}")))?;
        *downloaded = new_downloaded;
        progress.maybe_report(*downloaded);
    }
    Ok(*downloaded - start)
}

fn restart_temp_file(
    file: &mut File,
    downloaded: &mut u64,
    total: &mut Option<u64>,
) -> Result<(), FetchError> {
    file.set_len(0)
        .map_err(|e| FetchError::IoError(format!("truncate temp archive: {e}")))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| FetchError::IoError(format!("seek temp archive: {e}")))?;
    *downloaded = 0;
    *total = None;
    Ok(())
}

fn checked_download_size(current: u64, added: u64) -> Result<u64, FetchError> {
    let Some(next) = current.checked_add(added) else {
        return Err(FetchError::Http(
            "archive download byte count overflowed u64".to_string(),
        ));
    };
    if next > MAX_RESPONSE_BYTES {
        return Err(FetchError::Http(format!(
            "archive exceeds maximum size {}",
            format_bytes(MAX_RESPONSE_BYTES)
        )));
    }
    Ok(next)
}

#[derive(Debug)]
struct HttpArchiveAttemptError {
    message: String,
    retryable: bool,
    timeout: bool,
}

impl HttpArchiveAttemptError {
    fn network(message: String) -> Self {
        Self {
            message,
            retryable: true,
            timeout: false,
        }
    }

    fn non_retryable(message: String) -> Self {
        Self {
            message,
            retryable: false,
            timeout: false,
        }
    }

    fn timeout(message: String, retryable: bool) -> Self {
        Self {
            message,
            retryable,
            timeout: true,
        }
    }

    fn from_ureq(err: ureq::Error) -> Self {
        let retryable = is_retryable_ureq_error(&err);
        let message = err.to_string();
        let timeout = looks_like_timeout(&message);
        Self {
            message,
            retryable,
            timeout,
        }
    }
}

enum ArchiveTransferError {
    Attempt(HttpArchiveAttemptError),
    Fatal(FetchError),
}

impl From<HttpArchiveAttemptError> for ArchiveTransferError {
    fn from(value: HttpArchiveAttemptError) -> Self {
        Self::Attempt(value)
    }
}

impl From<FetchError> for ArchiveTransferError {
    fn from(value: FetchError) -> Self {
        Self::Fatal(value)
    }
}

#[derive(Debug, Clone, Copy)]
struct ContentRange {
    start: u64,
    end: u64,
    total: Option<u64>,
}

fn parse_content_length(value: Option<&str>) -> Result<Option<u64>, HttpArchiveAttemptError> {
    value
        .map(|s| {
            s.trim().parse::<u64>().map_err(|_| {
                HttpArchiveAttemptError::non_retryable(format!("invalid Content-Length {s:?}"))
            })
        })
        .transpose()
}

fn parse_content_range(value: Option<&str>) -> Result<ContentRange, HttpArchiveAttemptError> {
    let value = value.ok_or_else(|| {
        HttpArchiveAttemptError::non_retryable("206 response missing Content-Range".to_string())
    })?;
    let Some(rest) = value.trim().strip_prefix("bytes ") else {
        return Err(HttpArchiveAttemptError::non_retryable(format!(
            "unsupported Content-Range {value:?}"
        )));
    };
    let Some((range_part, total_part)) = rest.split_once('/') else {
        return Err(HttpArchiveAttemptError::non_retryable(format!(
            "invalid Content-Range {value:?}"
        )));
    };
    let Some((start, end)) = range_part.split_once('-') else {
        return Err(HttpArchiveAttemptError::non_retryable(format!(
            "invalid Content-Range {value:?}"
        )));
    };
    let start = start.parse::<u64>().map_err(|_| {
        HttpArchiveAttemptError::non_retryable(format!("invalid Content-Range start {value:?}"))
    })?;
    let end = end.parse::<u64>().map_err(|_| {
        HttpArchiveAttemptError::non_retryable(format!("invalid Content-Range end {value:?}"))
    })?;
    if end < start {
        return Err(HttpArchiveAttemptError::non_retryable(format!(
            "invalid Content-Range with end before start: {value:?}"
        )));
    }
    let total = if total_part == "*" {
        None
    } else {
        Some(total_part.parse::<u64>().map_err(|_| {
            HttpArchiveAttemptError::non_retryable(format!("invalid Content-Range total {value:?}"))
        })?)
    };
    Ok(ContentRange { start, end, total })
}

fn warn_retry(
    label: &str,
    url: &str,
    err: &HttpArchiveAttemptError,
    attempt: usize,
    attempts: usize,
) {
    eprintln!(
        "remote_fetch: WARN archive download for {label} from {url}: {} (attempt {attempt}/{attempts}); retrying in {}s",
        err.message,
        HTTP_FETCH_BACKOFF.as_secs()
    );
}

fn sleep_for_retry(deadline: Instant) {
    if HTTP_FETCH_BACKOFF.is_zero() {
        return;
    }
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::ZERO);
    let sleep_for = HTTP_FETCH_BACKOFF.min(remaining);
    if !sleep_for.is_zero() {
        std::thread::sleep(sleep_for);
    }
}

struct DownloadProgress<'a> {
    label: &'a str,
    url: &'a str,
    started: Instant,
    last_report_at: Instant,
    last_report_bytes: u64,
    total: Option<u64>,
}

impl<'a> DownloadProgress<'a> {
    fn new(label: &'a str, url: &'a str, started: Instant) -> Self {
        Self {
            label,
            url,
            started,
            last_report_at: started,
            last_report_bytes: 0,
            total: None,
        }
    }

    fn set_total(&mut self, total: Option<u64>) {
        self.total = total;
    }

    fn reset(&mut self, downloaded: u64, total: Option<u64>) {
        self.last_report_at = Instant::now();
        self.last_report_bytes = downloaded;
        self.total = total;
    }

    fn maybe_report(&mut self, downloaded: u64) {
        let now = Instant::now();
        if downloaded.saturating_sub(self.last_report_bytes) < DOWNLOAD_PROGRESS_BYTES
            && now.duration_since(self.last_report_at) < DOWNLOAD_PROGRESS_INTERVAL
        {
            return;
        }
        self.last_report_at = now;
        self.last_report_bytes = downloaded;
        eprintln!(
            "remote_fetch: still downloading {}: {}{} at {} ({})",
            self.label,
            format_bytes(downloaded),
            self.total
                .map(|t| format!(" / {}", format_bytes(t)))
                .unwrap_or_default(),
            format_rate(downloaded, now.duration_since(self.started)),
            self.url
        );
    }

    fn finish(&mut self, downloaded: u64) {
        let now = Instant::now();
        eprintln!(
            "remote_fetch: downloaded archive for {}: {}{} at {}",
            self.label,
            format_bytes(downloaded),
            self.total
                .map(|t| format!(" / {}", format_bytes(t)))
                .unwrap_or_default(),
            format_rate(downloaded, now.duration_since(self.started))
        );
    }
}

fn verify_sha_file(path: &Path, expected_hex: &str) -> Result<(), FetchError> {
    let mut file = File::open(path)
        .map_err(|e| FetchError::IoError(format!("open {}: {e}", path.display())))?;
    let mut h = Sha256::new();
    let mut buf = [0u8; DOWNLOAD_BUFFER_BYTES];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| FetchError::IoError(format!("read {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
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

fn build_http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!(
            "kandelo-tools/xtask/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
}

fn looks_like_timeout(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("deadline")
        || lower.contains("stall")
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

fn format_rate(bytes: u64, elapsed: Duration) -> String {
    let secs = elapsed.as_secs_f64();
    if secs <= f64::EPSILON {
        return "0 B/s".to_string();
    }
    format!("{}/s", format_bytes((bytes as f64 / secs) as u64))
}

fn format_duration(duration: Duration) -> String {
    let secs = duration.as_secs();
    if secs >= 60 {
        format!("{}m{}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

fn fetch_http_url(url: &str, attempts: usize, backoff: Duration) -> Result<Vec<u8>, FetchError> {
    let attempts = attempts.max(1);
    // Always set timeouts and a UA so a misbehaving registry can't hang
    // the resolver indefinitely and so server logs can attribute the
    // request.
    let agent = build_http_agent();

    let mut last_error = String::new();
    for attempt in 1..=attempts {
        match fetch_http_url_once(&agent, url) {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                let retryable = err.retryable;
                last_error = err.message;
                if !retryable || attempt == attempts {
                    break;
                }
                eprintln!(
                    "fetch_url: WARN {url}: {last_error} (attempt {attempt}/{attempts}); retrying in {}s",
                    backoff.as_secs()
                );
                if !backoff.is_zero() {
                    std::thread::sleep(backoff);
                }
            }
        }
    }

    Err(FetchError::Http(format!(
        "{url}: {last_error} after {attempts} attempt(s)"
    )))
}

struct HttpFetchAttemptError {
    message: String,
    retryable: bool,
}

fn fetch_http_url_once(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, HttpFetchAttemptError> {
    let resp = agent.get(url).call().map_err(|e| HttpFetchAttemptError {
        retryable: is_retryable_ureq_error(&e),
        message: e.to_string(),
    })?;
    // Cap response at MAX_RESPONSE_BYTES. A truncated body just
    // produces a SHA mismatch downstream, so no explicit oversize
    // error is needed here.
    let mut bytes: Vec<u8> = Vec::new();
    std::io::Read::take(resp.into_reader(), MAX_RESPONSE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| HttpFetchAttemptError {
            retryable: true,
            message: format!("read failed: {e}"),
        })?;
    Ok(bytes)
}

fn is_retryable_ureq_error(err: &ureq::Error) -> bool {
    match err {
        ureq::Error::Status(code, _) => *code == 429 || *code >= 500,
        ureq::Error::Transport(_) => true,
    }
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
#[cfg(test)]
fn extract_tar_zst(bytes: &[u8], dest: &Path) -> Result<(), FetchError> {
    extract_tar_zst_reader(bytes, dest)
}

fn extract_tar_zst_file(path: &Path, dest: &Path) -> Result<(), FetchError> {
    let file = File::open(path)
        .map_err(|e| FetchError::IoError(format!("open {}: {e}", path.display())))?;
    extract_tar_zst_reader(file, dest)
}

fn extract_tar_zst_reader<R: Read>(reader: R, dest: &Path) -> Result<(), FetchError> {
    let decoder = zstd::stream::read::Decoder::new(reader)
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
        let rd = fs::read_dir(&artifacts)
            .map_err(|e| FetchError::IoError(format!("read_dir {}: {e}", artifacts.display())))?;
        for entry in rd {
            let entry = entry.map_err(|e| {
                FetchError::IoError(format!("read_dir {}: {e}", artifacts.display()))
            })?;
            let src = entry.path();
            let dst = tmp.join(entry.file_name());
            fs::rename(&src, &dst).map_err(|e| {
                FetchError::IoError(format!(
                    "rename {} -> {}: {e}",
                    src.display(),
                    dst.display()
                ))
            })?;
        }
        fs::remove_dir_all(&artifacts)
            .map_err(|e| FetchError::IoError(format!("remove {}: {e}", artifacts.display())))?;
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
pub(crate) fn build_test_archive(manifest_text: &str, artifact_files: &[(&str, &[u8])]) -> Vec<u8> {
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
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-rfetch")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        let digest: [u8; 32] = h.finalize().into();
        hex(&digest)
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
    fn remote_fetch_rejects_git_provenance_different_from_current_build() {
        let dir = tempdir("git-input-mismatch");
        let package_dir = dir.join("registry/demo");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.toml"),
            r#"
kind = "library"
name = "demo"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/demo.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = ["lib/libdemo.a"]
"#,
        )
        .unwrap();
        fs::write(
            package_dir.join("build.toml"),
            r#"
script_path = "packages/registry/demo/build-demo.sh"
repo_url = "https://example.test/kandelo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision = 1
[[git_inputs]]
name = "tap"
repository = "https://example.test/current-tap.git"
commit = "1111111111111111111111111111111111111111"
[binary]
index_url = "https://example.test/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();
        let target = DepsManifest::load_with_overlay(&package_dir).unwrap();
        let cache_key = "a".repeat(64);
        let archived_manifest = format!(
            r#"
kind = "library"
name = "demo"
version = "1.0.0"
revision = 1
depends_on = []
[source]
url = "https://example.test/demo.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = ["lib/libdemo.a"]
[compatibility]
target_arch = "wasm32"
abi_versions = [4]
cache_key_sha = "{cache_key}"
[[compatibility.git_inputs]]
name = "tap"
repository = "https://example.test/different-tap.git"
commit = "2222222222222222222222222222222222222222"
"#
        );
        let archive = build_test_archive(
            &archived_manifest,
            &[("lib/libdemo.a", b"archive bytes")],
        );
        let archive_path = dir.join("demo.tar.zst");
        fs::write(&archive_path, &archive).unwrap();
        let archive_sha = sha256_hex(&archive);
        let canonical = dir.join("cache/libs/demo");
        let err = fetch_and_install_direct(
            &format!("file://{}", archive_path.display()),
            &archive_sha,
            &canonical,
            &target,
            TargetArch::Wasm32,
            4,
            &cache_key,
        )
        .unwrap_err();
        match err {
            FetchError::GitInputsMismatch { expected, archived } => {
                assert_eq!(expected[0].repository, "https://example.test/current-tap.git");
                assert_eq!(archived[0].repository, "https://example.test/different-tap.git");
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(!canonical.exists());
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
    fn fetch_http_url_retries_transient_5xx() {
        let url = serve_http_responses(vec![
            (502, b"bad gateway".to_vec()),
            (200, b"archive bytes".to_vec()),
        ]);

        let got = fetch_http_url(&url, 3, Duration::ZERO).unwrap();
        assert_eq!(got, b"archive bytes");
    }

    #[test]
    fn fetch_archive_streams_http_to_temp_file() {
        let payload = b"streamed archive bytes".repeat(4096);
        let expected = payload.clone();
        let served = payload.clone();
        let sha = sha256_hex(&payload);
        let url = serve_http_handler(1, move |_, request| {
            assert!(request_header(&request, "Range").is_none());
            TestHttpResponse::new(200)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", served.len().to_string())
                .body(served.clone())
        });

        let dir = tempdir("archive-http-stream");
        let archive = fetch_archive_to_temp_file(&url, &sha, &dir, "streamed-http").unwrap();
        assert_eq!(fs::read(archive.path()).unwrap(), expected);
    }

    #[test]
    fn fetch_archive_resumes_after_midstream_failure_with_ranges() {
        let payload = b"resumable archive bytes".repeat(8192);
        let split = 37_000usize;
        let expected = payload.clone();
        let served = payload.clone();
        let sha = sha256_hex(&payload);
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let server_ranges = Arc::clone(&ranges);
        let url = serve_http_handler(2, move |idx, request| {
            let range = request_header(&request, "Range");
            server_ranges.lock().unwrap().push(range.clone());
            match idx {
                0 => TestHttpResponse::new(200)
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Length", served.len().to_string())
                    .body(served[..split].to_vec()),
                1 => {
                    let expected_range = format!("bytes={split}-");
                    assert_eq!(range.as_deref(), Some(expected_range.as_str()));
                    TestHttpResponse::new(206)
                        .header("Accept-Ranges", "bytes")
                        .header(
                            "Content-Range",
                            format!("bytes {split}-{}/{}", served.len() - 1, served.len()),
                        )
                        .header("Content-Length", (served.len() - split).to_string())
                        .body(served[split..].to_vec())
                }
                _ => unreachable!(),
            }
        });

        let dir = tempdir("archive-http-resume");
        let archive = fetch_archive_to_temp_file(&url, &sha, &dir, "resume-http").unwrap();
        assert_eq!(fs::read(archive.path()).unwrap(), expected);
        let ranges = ranges.lock().unwrap();
        let expected_range = format!("bytes={split}-");
        assert_eq!(ranges[0], None);
        assert_eq!(ranges[1].as_deref(), Some(expected_range.as_str()));
    }

    #[test]
    fn fetch_archive_restarts_when_range_is_ignored() {
        let payload = b"range ignored archive bytes".repeat(8192);
        let split = 41_000usize;
        let expected = payload.clone();
        let served = payload.clone();
        let sha = sha256_hex(&payload);
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let server_ranges = Arc::clone(&ranges);
        let url = serve_http_handler(2, move |idx, request| {
            let range = request_header(&request, "Range");
            server_ranges.lock().unwrap().push(range);
            match idx {
                0 => TestHttpResponse::new(200)
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Length", served.len().to_string())
                    .body(served[..split].to_vec()),
                1 => TestHttpResponse::new(200)
                    .header("Content-Length", served.len().to_string())
                    .body(served.clone()),
                _ => unreachable!(),
            }
        });

        let dir = tempdir("archive-http-range-ignored");
        let archive = fetch_archive_to_temp_file(&url, &sha, &dir, "range-ignored").unwrap();
        assert_eq!(fs::read(archive.path()).unwrap(), expected);
        let ranges = ranges.lock().unwrap();
        let expected_range = format!("bytes={split}-");
        assert_eq!(ranges[0], None);
        assert_eq!(ranges[1].as_deref(), Some(expected_range.as_str()));
    }

    #[test]
    fn fetch_archive_sha_mismatch_fails_and_removes_temp_file() {
        let payload = b"bad sha archive bytes".repeat(1024);
        let served = payload.clone();
        let good_sha_for_other_bytes = sha256_hex(b"different bytes");
        let url = serve_http_handler(1, move |_, _| {
            TestHttpResponse::new(200)
                .header("Content-Length", served.len().to_string())
                .body(served.clone())
        });

        let dir = tempdir("archive-http-sha-mismatch");
        let err = fetch_archive_to_temp_file(&url, &good_sha_for_other_bytes, &dir, "bad-sha")
            .unwrap_err();
        assert!(
            matches!(err, FetchError::ShaMismatch { .. }),
            "unexpected: {err:?}"
        );
        let leftovers = fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn fetch_archive_reads_file_scheme_to_temp_file() {
        let src_dir = tempdir("archive-file-src");
        let out_dir = tempdir("archive-file-out");
        let payload = b"local file archive bytes".repeat(1024);
        let sha = sha256_hex(&payload);
        let src = src_dir.join("archive.tar.zst");
        fs::write(&src, &payload).unwrap();
        let url = format!("file://{}", src.display());

        let archive = fetch_archive_to_temp_file(&url, &sha, &out_dir, "file-archive").unwrap();
        assert_eq!(fs::read(archive.path()).unwrap(), payload);
    }

    #[test]
    fn fetch_url_returns_error_for_missing_file() {
        let url = "file:///definitely/not/here-xyz123.bin";
        let err = fetch_url(url).unwrap_err();
        assert!(matches!(err, FetchError::Http(_)), "unexpected: {err:?}");
    }

    #[test]
    fn fetch_url_rejects_unsupported_scheme() {
        let err = fetch_url("ftp://example.test/x").unwrap_err();
        assert!(matches!(err, FetchError::Http(_)));
    }

    fn serve_http_responses(responses: Vec<(u16, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let reason = match status {
                    200 => "OK",
                    429 => "Too Many Requests",
                    502 => "Bad Gateway",
                    _ => "Status",
                };
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        format!("http://{addr}/archive.tar.zst")
    }

    #[derive(Debug)]
    struct TestHttpResponse {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl TestHttpResponse {
        fn new(status: u16) -> Self {
            Self {
                status,
                headers: Vec::new(),
                body: Vec::new(),
            }
        }

        fn header(mut self, name: &str, value: impl ToString) -> Self {
            self.headers.push((name.to_string(), value.to_string()));
            self
        }

        fn body(mut self, body: Vec<u8>) -> Self {
            self.body = body;
            self
        }
    }

    fn serve_http_handler<F>(requests: usize, mut handler: F) -> String
    where
        F: FnMut(usize, String) -> TestHttpResponse + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for idx in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_request(&mut stream);
                let response = handler(idx, request);
                write_test_response(&mut stream, response);
            }
        });
        format!("http://{addr}/archive.tar.zst")
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    request.extend_from_slice(&buf[..n]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(e) => panic!("read request failed: {e}"),
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn request_header(request: &str, name: &str) -> Option<String> {
        request.lines().find_map(|line| {
            let (header_name, value) = line.split_once(':')?;
            header_name
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }

    fn write_test_response(stream: &mut TcpStream, response: TestHttpResponse) {
        let reason = match response.status {
            200 => "OK",
            206 => "Partial Content",
            429 => "Too Many Requests",
            502 => "Bad Gateway",
            _ => "Status",
        };
        write!(stream, "HTTP/1.1 {} {reason}\r\n", response.status).unwrap();
        for (name, value) in response.headers {
            write!(stream, "{name}: {value}\r\n").unwrap();
        }
        write!(stream, "Connection: close\r\n\r\n").unwrap();
        stream.write_all(&response.body).unwrap();
    }

    /// `WASM_POSIX_OFFLINE=1` (or any non-empty, non-"0" value) must
    /// short-circuit `fetch_url` for http(s) URLs before any network
    /// I/O. We verify by setting the env var, calling fetch_url with a
    /// URL whose hostname (.test TLD per RFC 2606) cannot resolve, and
    /// asserting the error message names the offline guard rather than
    /// a DNS/connect failure. `file://` is intentionally NOT gated by
    /// the flag — local archives are still readable offline.
    #[test]
    fn offline_env_var_blocks_fetch() {
        // `set_var` is process-global; serialize with the env-mutex
        // pattern established in host_tool_probe so parallel tests
        // don't observe a leaked WASM_POSIX_OFFLINE.
        static OFFLINE_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = OFFLINE_MUTEX.lock().unwrap();

        struct OfflineGuard {
            prior: Option<std::ffi::OsString>,
        }
        impl OfflineGuard {
            fn install(value: &str) -> Self {
                let prior = std::env::var_os("WASM_POSIX_OFFLINE");
                // SAFETY (edition 2024): set_var is unsafe because it
                // mutates process-global env. We hold OFFLINE_MUTEX,
                // and Drop restores the prior value even on panic.
                unsafe {
                    std::env::set_var("WASM_POSIX_OFFLINE", value);
                }
                Self { prior }
            }
        }
        impl Drop for OfflineGuard {
            fn drop(&mut self) {
                // SAFETY: see OfflineGuard::install.
                unsafe {
                    match &self.prior {
                        Some(v) => std::env::set_var("WASM_POSIX_OFFLINE", v),
                        None => std::env::remove_var("WASM_POSIX_OFFLINE"),
                    }
                }
            }
        }

        let _guard = OfflineGuard::install("1");
        let url = "https://invalid.test/foo";
        let err = fetch_url(url).unwrap_err();
        match err {
            FetchError::Http(s) => {
                assert!(
                    s.contains("WASM_POSIX_OFFLINE"),
                    "expected offline guard message, got: {s}"
                );
                assert!(s.contains(url), "expected URL in offline error, got: {s}");
            }
            other => panic!("expected FetchError::Http, got: {other:?}"),
        }
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
