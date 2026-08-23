use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::archive_extract_member::rename_no_replace;
use crate::remote_fetch::{
    MAX_SOURCE_ARCHIVE_BYTES, stream_source_archive_to_file, validate_archive_url,
};

static TRANSACTION_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const TRANSACTION_ATTEMPTS: usize = 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SourceArchiveDisposition {
    Cached,
    Published,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedSourceArchive {
    pub(crate) path: PathBuf,
    pub(crate) disposition: SourceArchiveDisposition,
}

#[cfg(test)]
std::thread_local! {
    static PRIVATE_DIRECTORY_OBSERVER: std::cell::RefCell<Option<Box<dyn Fn(&Path)>>> =
        std::cell::RefCell::new(None);
}

/// Acquire one immutable upstream archive and return its canonical payload.
#[allow(dead_code)] // Consumed by the sequential Task 3C gate.
pub fn fetch_verified_archive(
    cache_root: &Path,
    url: &str,
    sha256: &str,
) -> Result<PathBuf, String> {
    fetch_verified_archive_with_disposition(cache_root, url, sha256).map(|archive| archive.path)
}

pub(crate) fn fetch_verified_archive_with_disposition(
    cache_root: &Path,
    url: &str,
    sha256: &str,
) -> Result<VerifiedSourceArchive, String> {
    fetch_verified_archive_with_disposition_and_before_publish(cache_root, url, sha256, || {})
}

/// Revalidate an already-selected immutable payload without acquiring or
/// publishing anything. Scheduler callbacks run after source work; a payload
/// removed or changed in that gap must fail rather than silently downloading a
/// replacement and reporting success for a different generation.
pub(crate) fn require_verified_archive_hit(
    cache_root: &Path,
    url: &str,
    sha256: &str,
    expected_payload: &Path,
) -> Result<PathBuf, String> {
    validate_digest(sha256)?;
    validate_archive_url(url).map_err(|error| error.to_string())?;
    let archive_root = cache_root.join("source-archives");
    let sha_root = archive_root.join("sha256");
    for (path, label) in [
        (&archive_root, "source archive cache root"),
        (&sha_root, "source archive digest root"),
    ] {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("inspect {label} {}: {error}", path.display()))?;
        validate_real_directory(path, &metadata)?;
    }
    let canonical = sha_root.join(sha256);
    let expected = canonical.join("payload");
    if expected_payload != expected {
        return Err(format!(
            "verified source archive payload changed canonical path: expected {}, got {}",
            expected.display(),
            expected_payload.display()
        ));
    }
    let payload = validate_hit(&canonical, sha256)?;
    if payload != expected_payload {
        return Err(format!(
            "verified source archive payload changed after validation: expected {}, got {}",
            expected_payload.display(),
            payload.display()
        ));
    }
    Ok(payload)
}

fn fetch_verified_archive_with_disposition_and_before_publish<F>(
    cache_root: &Path,
    url: &str,
    sha256: &str,
    before_publish: F,
) -> Result<VerifiedSourceArchive, String>
where
    F: FnOnce(),
{
    fetch_verified_archive_transaction(cache_root, url, sha256, before_publish)
        .map(|(archive, _published_by_caller)| archive)
}

fn fetch_verified_archive_with_before_publish<F>(
    cache_root: &Path,
    url: &str,
    sha256: &str,
    before_publish: F,
) -> Result<(PathBuf, bool), String>
where
    F: FnOnce(),
{
    fetch_verified_archive_transaction(cache_root, url, sha256, before_publish)
        .map(|(archive, published_by_caller)| (archive.path, published_by_caller))
}

fn fetch_verified_archive_transaction<F>(
    cache_root: &Path,
    url: &str,
    sha256: &str,
    before_publish: F,
) -> Result<(VerifiedSourceArchive, bool), String>
where
    F: FnOnce(),
{
    validate_digest(sha256)?;
    validate_archive_url(url).map_err(|error| error.to_string())?;
    let archive_root = ensure_cache_component(cache_root, "source-archives")?;
    let sha_root = ensure_cache_component(&archive_root, "sha256")?;
    let canonical = sha_root.join(sha256);

    match fs::symlink_metadata(&canonical) {
        Ok(_) => {
            return validate_hit(&canonical, sha256).map(|path| {
                (
                    VerifiedSourceArchive {
                        path,
                        disposition: SourceArchiveDisposition::Cached,
                    },
                    false,
                )
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect {}: {error}", canonical.display())),
    }

    let mut transaction = PrivateTransaction::create(&sha_root, sha256)?;
    let payload = transaction.path.join("payload");
    let mut output = open_private_payload(&payload)?;
    stream_source_archive_to_file(url, &mut output, "upstream source archive")
        .map_err(|error| error.to_string())?;
    output
        .flush()
        .map_err(|error| format!("flush {}: {error}", payload.display()))?;
    verify_payload(&payload, sha256)?;
    output
        .sync_all()
        .map_err(|error| format!("sync {}: {error}", payload.display()))?;
    drop(output);
    sync_directory(&transaction.path)?;
    before_publish();

    match rename_no_replace(&transaction.path, &canonical) {
        Ok(()) => {
            transaction.published = true;
            sync_directory(&sha_root)?;
            validate_hit(&canonical, sha256).map(|path| {
                (
                    VerifiedSourceArchive {
                        path,
                        disposition: SourceArchiveDisposition::Published,
                    },
                    true,
                )
            })
        }
        Err(rename_error) => {
            // The private transaction is still ours and is cleaned by Drop.
            // A visible destination can only be accepted after full hit
            // validation; malformed winners are preserved as evidence.
            match fs::symlink_metadata(&canonical) {
                Ok(_) => {
                    let winner = validate_hit(&canonical, sha256)?;
                    sync_directory(&sha_root)?;
                    Ok((
                        VerifiedSourceArchive {
                            path: winner,
                            // The caller crossed the miss-side publication
                            // transaction even when a peer won NOREPLACE.
                            disposition: SourceArchiveDisposition::Published,
                        },
                        false,
                    ))
                }
                Err(_) => Err(format!(
                    "publish {} -> {} without replacement: {rename_error}",
                    transaction.path.display(),
                    canonical.display()
                )),
            }
        }
    }
}

fn validate_digest(digest: &str) -> Result<(), String> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "source archive sha256 must be exactly 64 lowercase hexadecimal characters".to_string(),
        );
    }
    Ok(())
}

fn ensure_cache_component(parent: &Path, name: &str) -> Result<PathBuf, String> {
    ensure_cache_component_with_before_create(parent, name, |_| {})
}

fn ensure_cache_component_with_before_create<F>(
    parent: &Path,
    name: &str,
    before_create: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&Path),
{
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => validate_real_directory(&path, &metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            before_create(&path);
            match create_private_directory(&path) {
                Ok(()) => set_private_directory_permissions(&path)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(&path)
                        .map_err(|error| format!("revalidate {}: {error}", path.display()))?;
                    validate_real_directory(&path, &metadata)?;
                }
                Err(error) => return Err(format!("create {}: {error}", path.display())),
            }
        }
        Err(error) => return Err(format!("inspect {}: {error}", path.display())),
    }
    Ok(path)
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    create_private_directory_with_observer(path, |created| {
        #[cfg(test)]
        PRIVATE_DIRECTORY_OBSERVER.with(|observer| {
            if let Some(observer) = observer.borrow().as_ref() {
                observer(created);
            }
        });
        #[cfg(not(test))]
        let _ = created;
    })
}

fn create_private_directory_with_observer<F>(path: &Path, after_create: F) -> std::io::Result<()>
where
    F: FnOnce(&Path),
{
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(path)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path)?;
    after_create(path);
    Ok(())
}

fn validate_real_directory(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(format!(
            "cache component {} is not a real nonsymlink directory",
            path.display()
        ));
    }
    Ok(())
}

fn validate_hit(canonical: &Path, sha256: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(canonical)
        .map_err(|error| format!("inspect cache hit {}: {error}", canonical.display()))?;
    validate_real_directory(canonical, &metadata)?;
    let entries = fs::read_dir(canonical)
        .map_err(|error| format!("read cache hit {}: {error}", canonical.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read cache hit {}: {error}", canonical.display()))?;
    if entries.len() != 1 || entries[0].file_name() != "payload" {
        return Err(format!(
            "archive cache hit {} must contain exactly one payload",
            canonical.display()
        ));
    }
    let payload = canonical.join("payload");
    verify_payload(&payload, sha256)?;
    Ok(payload)
}

fn verify_payload(payload: &Path, expected: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(payload)
        .map_err(|error| format!("inspect archive payload {}: {error}", payload.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(format!(
            "archive payload {} is not exactly one regular nonsymlink file",
            payload.display()
        ));
    }
    if metadata.len() > MAX_SOURCE_ARCHIVE_BYTES {
        return Err(format!(
            "archive payload {} exceeds raw archive limit of {MAX_SOURCE_ARCHIVE_BYTES} bytes",
            payload.display()
        ));
    }
    let mut file = File::open(payload)
        .map_err(|error| format!("open archive payload {}: {error}", payload.display()))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("stat open archive payload {}: {error}", payload.display()))?;
    if !opened.is_file() || opened.len() > MAX_SOURCE_ARCHIVE_BYTES {
        return Err(format!(
            "archive payload {} changed while opening",
            payload.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
            return Err(format!(
                "archive payload {} changed while opening",
                payload.display()
            ));
        }
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("hash archive payload {}: {error}", payload.display()))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let actual: [u8; 32] = hash.finalize().into();
    let actual = crate::util::hex(&actual);
    if actual != expected {
        return Err(format!(
            "archive payload {} digest mismatch: expected {expected}, got {actual}",
            payload.display()
        ));
    }
    Ok(())
}

struct PrivateTransaction {
    path: PathBuf,
    published: bool,
}

impl PrivateTransaction {
    fn create(parent: &Path, digest: &str) -> Result<Self, String> {
        for _ in 0..TRANSACTION_ATTEMPTS {
            let sequence = TRANSACTION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".{digest}.transaction-{}-{sequence}",
                std::process::id()
            ));
            match create_private_directory(&path) {
                Ok(()) => {
                    if let Err(error) = set_private_directory_permissions(&path) {
                        let _ = fs::remove_dir(&path);
                        return Err(error);
                    }
                    return Ok(Self {
                        path,
                        published: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "create archive transaction {}: {error}",
                        path.display()
                    ));
                }
            }
        }
        Err(format!(
            "could not allocate archive transaction in {}",
            parent.display()
        ))
    }
}

impl Drop for PrivateTransaction {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn open_private_payload(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("create archive payload {}: {error}", path.display()))
}

fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    let directory = File::open(path)
        .map_err(|error| format!("open directory {} for sync: {error}", path.display()))?;
    directory
        .sync_all()
        .map_err(|error| format!("sync directory {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_SOURCE_ARCHIVE_BYTES, PRIVATE_DIRECTORY_OBSERVER,
        ensure_cache_component_with_before_create, fetch_verified_archive,
        fetch_verified_archive_with_before_publish,
    };
    use sha2::{Digest, Sha256};
    use std::fs::{self, File};
    use std::path::Path;
    use std::sync::{Arc, Barrier};

    fn digest(bytes: &[u8]) -> String {
        let mut hash = Sha256::new();
        hash.update(bytes);
        let digest: [u8; 32] = hash.finalize().into();
        crate::util::hex(&digest)
    }

    fn file_url(path: &Path) -> String {
        format!("file://{}", path.display())
    }

    fn transaction_names(root: &Path) -> Vec<String> {
        let sha_root = root.join("source-archives/sha256");
        fs::read_dir(sha_root)
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .filter(|name| name.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg(unix)]
    #[test]
    fn cache_and_transaction_directories_are_private_at_allocation() {
        const CHILD_MARKER: &str = "KANDELO_TEST_PRIVATE_DIRECTORY_ALLOCATION";
        if std::env::var_os(CHILD_MARKER).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "source_archive_cache::tests::cache_and_transaction_directories_are_private_at_allocation",
                    "--nocapture",
                ])
                .env(CHILD_MARKER, "1")
                .status()
                .unwrap();
            assert!(status.success(), "isolated allocation-mode test failed");
            return;
        }

        unsafe extern "C" {
            fn umask(mask: u32) -> u32;
        }
        // SAFETY: this exact-test child process runs no sibling tests, and it
        // exits immediately after this assertion.
        unsafe { umask(0) };

        use std::cell::RefCell;
        use std::os::unix::fs::PermissionsExt;
        use std::rc::Rc;

        let modes = Rc::new(RefCell::new(Vec::new()));
        let observed_modes = Rc::clone(&modes);
        PRIVATE_DIRECTORY_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move |path| {
                observed_modes
                    .borrow_mut()
                    .push(fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777);
            }));
        });

        let root = tempfile::tempdir().unwrap();
        let bytes = b"private at allocation";
        let sha = digest(bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, bytes).unwrap();
        fetch_verified_archive(root.path(), &file_url(&origin), &sha).unwrap();

        PRIVATE_DIRECTORY_OBSERVER.with(|observer| *observer.borrow_mut() = None);
        assert_eq!(&*modes.borrow(), &[0o700, 0o700, 0o700]);
    }

    #[test]
    fn cache_component_already_exists_races_are_revalidated() {
        let root = tempfile::tempdir().unwrap();
        let created =
            ensure_cache_component_with_before_create(root.path(), "source-archives", |path| {
                fs::create_dir(path).unwrap()
            })
            .unwrap();
        assert!(created.is_dir());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let component = root.path().join("source-archives");
            let error =
                ensure_cache_component_with_before_create(root.path(), "source-archives", |path| {
                    symlink(outside.path(), path).unwrap()
                })
                .expect_err("symlink winner must fail revalidation");
            assert!(error.contains("real nonsymlink directory"), "{error}");
            assert!(
                fs::symlink_metadata(component)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
    }

    #[test]
    fn invalid_digests_have_no_cache_side_effects() {
        let root = tempfile::tempdir().unwrap();
        let origin = root.path().join("origin.tar");
        fs::write(&origin, b"bytes").unwrap();
        for invalid in ["abc", &"A".repeat(64), &format!("{}../x", "a".repeat(60))] {
            fetch_verified_archive(root.path(), &file_url(&origin), invalid)
                .expect_err("invalid digest must fail");
        }
        assert!(!root.path().join("source-archives").exists());
    }

    #[test]
    fn miss_publishes_one_complete_digest_directory_and_hit_survives_origin_removal() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"immutable upstream bytes";
        let sha = digest(bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, bytes).unwrap();

        let first = fetch_verified_archive(root.path(), &file_url(&origin), &sha).unwrap();
        assert_eq!(
            first,
            root.path()
                .join(format!("source-archives/sha256/{sha}/payload"))
        );
        assert_eq!(fs::read(&first).unwrap(), bytes);
        assert!(transaction_names(root.path()).is_empty());

        fs::remove_file(origin).unwrap();
        let second = fetch_verified_archive(
            root.path(),
            "https://unreachable.invalid/different-name.tar",
            &sha,
        )
        .unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn unsupported_initial_scheme_is_rejected_even_for_a_verified_hit() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"immutable upstream bytes";
        let sha = digest(bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, bytes).unwrap();
        fetch_verified_archive(root.path(), &file_url(&origin), &sha).unwrap();

        fetch_verified_archive(root.path(), "ftp://example.test/source.tar", &sha)
            .expect_err("unsupported initial scheme");
    }

    #[test]
    fn verified_hit_remains_available_while_offline() {
        let _lock = crate::remote_fetch::OFFLINE_MUTEX.lock().unwrap();
        struct OfflineGuard(Option<std::ffi::OsString>);
        impl Drop for OfflineGuard {
            fn drop(&mut self) {
                unsafe {
                    match self.0.take() {
                        Some(value) => std::env::set_var("WASM_POSIX_OFFLINE", value),
                        None => std::env::remove_var("WASM_POSIX_OFFLINE"),
                    }
                }
            }
        }
        let root = tempfile::tempdir().unwrap();
        let bytes = b"offline immutable archive";
        let sha = digest(bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, bytes).unwrap();
        fetch_verified_archive(root.path(), &file_url(&origin), &sha).unwrap();

        let _guard = OfflineGuard(std::env::var_os("WASM_POSIX_OFFLINE"));
        unsafe { std::env::set_var("WASM_POSIX_OFFLINE", "1") };
        let result = fetch_verified_archive(root.path(), "https://example.test/source.tar", &sha);
        assert!(result.is_ok());

        let missing_sha = digest(b"not cached");
        let error = fetch_verified_archive(
            root.path(),
            "https://invalid.test/not-cached.tar",
            &missing_sha,
        )
        .expect_err("offline miss");
        assert!(error.contains("WASM_POSIX_OFFLINE"), "{error}");
        assert!(
            !root
                .path()
                .join(format!("source-archives/sha256/{missing_sha}"))
                .exists()
        );
        assert!(transaction_names(root.path()).is_empty());
    }

    #[test]
    fn digest_mismatch_publishes_nothing_and_cleans_private_transaction() {
        let root = tempfile::tempdir().unwrap();
        let origin = root.path().join("origin.tar");
        fs::write(&origin, b"wrong bytes").unwrap();
        let expected = digest(b"expected bytes");

        fetch_verified_archive(root.path(), &file_url(&origin), &expected)
            .expect_err("mismatch must fail");

        assert!(
            !root
                .path()
                .join(format!("source-archives/sha256/{expected}"))
                .exists()
        );
        assert!(transaction_names(root.path()).is_empty());
    }

    #[test]
    fn sparse_oversized_origin_is_rejected_from_metadata_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let origin = root.path().join("oversized.tar");
        File::create(&origin)
            .unwrap()
            .set_len(MAX_SOURCE_ARCHIVE_BYTES + 1)
            .unwrap();
        let expected = digest(b"unrelated");

        let error = fetch_verified_archive(root.path(), &file_url(&origin), &expected)
            .expect_err("oversized origin");

        assert!(error.contains("maximum size"), "{error}");
        assert!(transaction_names(root.path()).is_empty());
        assert!(
            !root
                .path()
                .join(format!("source-archives/sha256/{expected}"))
                .exists()
        );
    }

    #[test]
    fn corrupt_hit_fails_closed_without_deletion_or_redownload() {
        let root = tempfile::tempdir().unwrap();
        let expected = digest(b"expected bytes");
        let entry = root
            .path()
            .join(format!("source-archives/sha256/{expected}"));
        fs::create_dir_all(&entry).unwrap();
        fs::write(entry.join("payload"), b"corrupt evidence").unwrap();

        let error = fetch_verified_archive(
            root.path(),
            "https://unreachable.invalid/archive.tar",
            &expected,
        )
        .expect_err("corrupt hit must fail");

        assert!(error.contains("digest"), "{error}");
        assert_eq!(
            fs::read(entry.join("payload")).unwrap(),
            b"corrupt evidence"
        );
    }

    #[test]
    fn malformed_and_sparse_oversized_hits_are_preserved() {
        for kind in [
            "digest-file",
            "missing-payload",
            "payload-directory",
            "oversized",
        ] {
            let root = tempfile::tempdir().unwrap();
            let sha = digest(b"expected bytes");
            let sha_root = root.path().join("source-archives/sha256");
            fs::create_dir_all(&sha_root).unwrap();
            let entry = sha_root.join(&sha);
            match kind {
                "digest-file" => fs::write(&entry, b"evidence").unwrap(),
                "missing-payload" => fs::create_dir(&entry).unwrap(),
                "payload-directory" => fs::create_dir_all(entry.join("payload")).unwrap(),
                "oversized" => {
                    fs::create_dir(&entry).unwrap();
                    let payload = File::create(entry.join("payload")).unwrap();
                    payload.set_len(MAX_SOURCE_ARCHIVE_BYTES + 1).unwrap();
                }
                _ => unreachable!(),
            }

            fetch_verified_archive(root.path(), "https://unreachable.invalid/archive.tar", &sha)
                .expect_err(kind);

            assert!(
                fs::symlink_metadata(&entry).is_ok(),
                "{kind} evidence was deleted"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cache_components_and_payload_are_rejected_without_mutation() {
        use std::os::unix::fs::symlink;

        let bytes = b"archive";
        let sha = digest(bytes);
        for component in ["source-archives", "sha256", "digest", "payload"] {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let origin = root.path().join("origin.tar");
            fs::write(&origin, bytes).unwrap();
            match component {
                "source-archives" => {
                    symlink(outside.path(), root.path().join("source-archives")).unwrap()
                }
                "sha256" => {
                    fs::create_dir(root.path().join("source-archives")).unwrap();
                    symlink(outside.path(), root.path().join("source-archives/sha256")).unwrap();
                }
                "digest" => {
                    fs::create_dir_all(root.path().join("source-archives/sha256")).unwrap();
                    symlink(
                        outside.path(),
                        root.path().join(format!("source-archives/sha256/{sha}")),
                    )
                    .unwrap();
                }
                "payload" => {
                    let entry = root.path().join(format!("source-archives/sha256/{sha}"));
                    fs::create_dir_all(&entry).unwrap();
                    let sentinel = outside.path().join("sentinel");
                    fs::write(&sentinel, bytes).unwrap();
                    symlink(&sentinel, entry.join("payload")).unwrap();
                }
                _ => unreachable!(),
            }
            fetch_verified_archive(root.path(), &file_url(&origin), &sha).expect_err(component);
            assert!(fs::read_dir(outside.path()).unwrap().count() <= 1);
        }
    }

    #[test]
    fn synchronized_acquisitions_validate_one_winner_and_leave_no_transactions() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"concurrent immutable archive".repeat(4096);
        let sha = digest(&bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, &bytes).unwrap();
        let root = Arc::new(root);
        let barrier = Arc::new(Barrier::new(2));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            let sha = sha.clone();
            let url = file_url(&origin);
            joins.push(std::thread::spawn(move || {
                fetch_verified_archive_with_before_publish(root.path(), &url, &sha, || {
                    barrier.wait();
                })
            }));
        }
        let outcomes: Vec<_> = joins
            .into_iter()
            .map(|join| join.join().unwrap().unwrap())
            .collect();
        assert_eq!(outcomes[0].0, outcomes[1].0);
        assert_eq!(
            outcomes.iter().filter(|(_, published)| *published).count(),
            1
        );
        assert_eq!(fs::read(&outcomes[0].0).unwrap(), bytes);
        assert!(transaction_names(root.path()).is_empty());
    }

    #[test]
    fn local_rebuild_receipt_source_archive_reports_miss_and_hit_dispositions() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"one immutable source download";
        let sha = digest(bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, bytes).unwrap();

        let first = super::fetch_verified_archive_with_disposition(
            root.path(),
            &file_url(&origin),
            &sha,
        )
        .unwrap();
        assert_eq!(first.disposition, super::SourceArchiveDisposition::Published);

        fs::remove_file(origin).unwrap();
        let second = super::fetch_verified_archive_with_disposition(
            root.path(),
            "https://unreachable.invalid/archive.tar",
            &sha,
        )
        .unwrap();
        assert_eq!(second.path, first.path);
        assert_eq!(second.disposition, super::SourceArchiveDisposition::Cached);
    }

    #[test]
    fn local_rebuild_receipt_equal_source_archive_peer_winner_is_published_for_miss_side() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"concurrent immutable source bytes".repeat(4096);
        let sha = digest(&bytes);
        let origin = root.path().join("origin.tar");
        fs::write(&origin, &bytes).unwrap();
        let root = Arc::new(root);
        let barrier = Arc::new(Barrier::new(2));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            let sha = sha.clone();
            let url = file_url(&origin);
            joins.push(std::thread::spawn(move || {
                super::fetch_verified_archive_with_disposition_and_before_publish(
                    root.path(),
                    &url,
                    &sha,
                    || {
                        barrier.wait();
                    },
                )
            }));
        }
        let outcomes = joins
            .into_iter()
            .map(|join| join.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert!(outcomes.iter().all(|outcome| {
            outcome.disposition == super::SourceArchiveDisposition::Published
        }));
        assert_eq!(outcomes[0].path, outcomes[1].path);
        assert!(transaction_names(root.path()).is_empty());
    }
}
