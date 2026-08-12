use crate::abi_staging::canonical_json::validate_sha256;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_LOCAL_OBJECT_BYTES: usize = 64 * 1024 * 1024;
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalNamespaceV1 {
    Candidate,
    Canonical,
    Source,
}

impl LocalNamespaceV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::Canonical => "canonical",
            Self::Source => "source",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "candidate" => Ok(Self::Candidate),
            "canonical" => Ok(Self::Canonical),
            "source" => Ok(Self::Source),
            _ => Err(format!("unknown local transport namespace {value:?}")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedLocalObjectV1 {
    pub namespace: LocalNamespaceV1,
    pub sha256: String,
    pub bytes: u64,
    pub immutable_reference: String,
}

#[derive(Debug)]
pub struct LocalContentAddressedTransport {
    root: PathBuf,
}

#[derive(Clone, Debug)]
pub struct LocalAnonymousReader {
    root: PathBuf,
}

impl LocalContentAddressedTransport {
    pub fn create(root: &Path) -> Result<Self, String> {
        validate_new_root(root)?;
        fs::create_dir(root).map_err(|error| {
            format!(
                "cannot create local content-addressed transport {}: {error}",
                root.display()
            )
        })?;
        assert_directory(root, "local transport root")?;
        for namespace in [
            LocalNamespaceV1::Candidate,
            LocalNamespaceV1::Canonical,
            LocalNamespaceV1::Source,
        ] {
            let namespace_root = root.join(namespace.as_str());
            fs::create_dir(&namespace_root).map_err(|error| {
                format!(
                    "cannot create local transport namespace {}: {error}",
                    namespace_root.display()
                )
            })?;
            let objects = namespace_root.join("sha256");
            fs::create_dir(&objects).map_err(|error| {
                format!(
                    "cannot create local transport object directory {}: {error}",
                    objects.display()
                )
            })?;
        }
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    pub fn publish(
        &self,
        namespace: LocalNamespaceV1,
        bytes: &[u8],
    ) -> Result<PublishedLocalObjectV1, String> {
        if bytes.is_empty() || bytes.len() > MAX_LOCAL_OBJECT_BYTES {
            return Err(format!(
                "local object must contain 1 through {MAX_LOCAL_OBJECT_BYTES} bytes"
            ));
        }
        self.validate_layout()?;
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let object_root = self.object_root(namespace)?;
        let object_path = object_root.join(&sha256);
        let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = object_root.join(format!(
            ".publish-{}-{sequence}-{sha256}",
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "cannot create local transport temporary object {}: {error}",
                    temporary.display()
                )
            })?;
        let publish_result = (|| {
            file.write_all(bytes).map_err(|error| {
                format!(
                    "cannot write local transport temporary object {}: {error}",
                    temporary.display()
                )
            })?;
            file.sync_all().map_err(|error| {
                format!(
                    "cannot sync local transport temporary object {}: {error}",
                    temporary.display()
                )
            })?;
            drop(file);

            match fs::hard_link(&temporary, &object_path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    verify_object(&object_path, bytes, &sha256).map_err(|detail| {
                        format!(
                            "local transport digest collision or corrupt prior object: {detail}"
                        )
                    })
                }
                Err(error) => Err(format!(
                    "cannot publish local transport object {}: {error}",
                    object_path.display()
                )),
            }
        })();
        let cleanup_result = fs::remove_file(&temporary).map_err(|error| {
            format!(
                "cannot remove local transport temporary object {}: {error}",
                temporary.display()
            )
        });
        publish_result?;
        cleanup_result?;
        verify_object(&object_path, bytes, &sha256)?;

        let byte_count = u64::try_from(bytes.len())
            .map_err(|_| "local object byte count does not fit in u64".to_string())?;
        Ok(PublishedLocalObjectV1 {
            namespace,
            sha256: sha256.clone(),
            bytes: byte_count,
            immutable_reference: format!(
                "local-fixture:sha256:{sha256}?namespace={}&bytes={byte_count}",
                namespace.as_str()
            ),
        })
    }

    pub fn anonymous_reader(&self) -> Result<LocalAnonymousReader, String> {
        self.validate_layout()?;
        Ok(LocalAnonymousReader {
            root: self.root.clone(),
        })
    }

    fn validate_layout(&self) -> Result<(), String> {
        assert_directory(&self.root, "local transport root")?;
        for namespace in [
            LocalNamespaceV1::Candidate,
            LocalNamespaceV1::Canonical,
            LocalNamespaceV1::Source,
        ] {
            self.object_root(namespace)?;
        }
        Ok(())
    }

    fn object_root(&self, namespace: LocalNamespaceV1) -> Result<PathBuf, String> {
        let namespace_root = self.root.join(namespace.as_str());
        assert_directory(&namespace_root, "local transport namespace")?;
        let object_root = namespace_root.join("sha256");
        assert_directory(&object_root, "local transport object root")?;
        Ok(object_root)
    }

    #[cfg(test)]
    fn object_path(&self, namespace: LocalNamespaceV1, sha256: &str) -> PathBuf {
        self.root
            .join(namespace.as_str())
            .join("sha256")
            .join(sha256)
    }
}

impl LocalAnonymousReader {
    pub fn read(&self, reference: &str) -> Result<Vec<u8>, String> {
        let parsed = parse_reference(reference)?;
        let namespace_root = self.root.join(parsed.namespace.as_str());
        assert_directory(&self.root, "anonymous transport root")?;
        assert_directory(&namespace_root, "anonymous transport namespace")?;
        let object_root = namespace_root.join("sha256");
        assert_directory(&object_root, "anonymous transport object root")?;
        let path = object_root.join(&parsed.sha256);
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!("cannot inspect anonymous local object {}: {error}", path.display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "anonymous local object {} must be a regular nonsymlink file",
                path.display()
            ));
        }
        if metadata.len() != parsed.bytes {
            return Err("anonymous local object byte count does not match its reference".to_string());
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .and_then(|file| {
                file.take(MAX_LOCAL_OBJECT_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| format!("cannot read anonymous local object: {error}"))?;
        if bytes.len() > MAX_LOCAL_OBJECT_BYTES {
            return Err("anonymous local object exceeds its size limit".to_string());
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != parsed.sha256 {
            return Err("anonymous local object SHA-256 does not match its reference".to_string());
        }
        Ok(bytes)
    }
}

#[derive(Debug)]
struct ParsedReferenceV1 {
    namespace: LocalNamespaceV1,
    sha256: String,
    bytes: u64,
}

fn parse_reference(reference: &str) -> Result<ParsedReferenceV1, String> {
    const PREFIX: &str = "local-fixture:sha256:";
    let suffix = reference
        .strip_prefix(PREFIX)
        .ok_or_else(|| "local transport reference has an unsupported scheme".to_string())?;
    let (sha256, query) = suffix
        .split_once('?')
        .ok_or_else(|| "local transport reference is missing its exact namespace".to_string())?;
    validate_sha256(sha256)?;
    let mut parts = query.split('&');
    let namespace = parts
        .next()
        .and_then(|value| value.strip_prefix("namespace="))
        .ok_or_else(|| "local transport reference is missing namespace".to_string())?;
    let bytes = parts
        .next()
        .and_then(|value| value.strip_prefix("bytes="))
        .ok_or_else(|| "local transport reference is missing byte count".to_string())?;
    if parts.next().is_some() {
        return Err("local transport reference contains unknown parameters".to_string());
    }
    let namespace = LocalNamespaceV1::parse(namespace)?;
    let bytes = bytes
        .parse::<u64>()
        .map_err(|_| "local transport reference byte count is invalid".to_string())?;
    if bytes == 0 || bytes > MAX_LOCAL_OBJECT_BYTES as u64 {
        return Err("local transport reference byte count is outside policy".to_string());
    }
    Ok(ParsedReferenceV1 {
        namespace,
        sha256: sha256.to_string(),
        bytes,
    })
}

fn validate_new_root(root: &Path) -> Result<(), String> {
    if root.as_os_str().is_empty() || root.file_name().is_none() {
        return Err("local transport root must name a new directory".to_string());
    }
    let parent = root
        .parent()
        .ok_or_else(|| "local transport root must have a parent".to_string())?;
    assert_directory(parent, "local transport parent")?;
    match fs::symlink_metadata(root) {
        Ok(_) => Err(format!(
            "local transport root {} already exists",
            root.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "cannot inspect local transport root {}: {error}",
            root.display()
        )),
    }
}

fn assert_directory(path: &Path, field: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {field} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{field} {} must be a nonsymlink directory", path.display()));
    }
    Ok(())
}

fn verify_object(path: &Path, expected: &[u8], sha256: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect local object {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "local object {} must be a regular nonsymlink file",
            path.display()
        ));
    }
    if metadata.len() != expected.len() as u64 {
        return Err(format!("local object {} byte count differs", path.display()));
    }
    let actual = fs::read(path)
        .map_err(|error| format!("cannot read local object {}: {error}", path.display()))?;
    if actual != expected || format!("{:x}", Sha256::digest(&actual)) != sha256 {
        return Err(format!("local object {} bytes differ", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_anonymously_reads_digest_addressed_objects() {
        let parent = tempfile::tempdir().unwrap();
        let transport = LocalContentAddressedTransport::create(&parent.path().join("transport"))
            .unwrap();
        let published = transport
            .publish(LocalNamespaceV1::Candidate, b"candidate bytes")
            .unwrap();
        assert_eq!(published.namespace, LocalNamespaceV1::Candidate);
        assert!(published.immutable_reference.contains(&published.sha256));
        assert_eq!(
            transport
                .anonymous_reader()
                .unwrap()
                .read(&published.immutable_reference)
                .unwrap(),
            b"candidate bytes"
        );
    }

    #[test]
    fn keeps_candidate_canonical_and_source_namespaces_separate() {
        let parent = tempfile::tempdir().unwrap();
        let transport = LocalContentAddressedTransport::create(&parent.path().join("transport"))
            .unwrap();
        let candidate = transport
            .publish(LocalNamespaceV1::Candidate, b"same bytes")
            .unwrap();
        let canonical = transport
            .publish(LocalNamespaceV1::Canonical, b"same bytes")
            .unwrap();
        let source = transport
            .publish(LocalNamespaceV1::Source, b"same bytes")
            .unwrap();
        assert_eq!(candidate.sha256, canonical.sha256);
        assert_eq!(canonical.sha256, source.sha256);
        assert_ne!(candidate.immutable_reference, canonical.immutable_reference);
        assert_ne!(canonical.immutable_reference, source.immutable_reference);
        assert!(transport
            .object_path(LocalNamespaceV1::Candidate, &candidate.sha256)
            .is_file());
        assert!(transport
            .object_path(LocalNamespaceV1::Canonical, &canonical.sha256)
            .is_file());
        assert!(transport
            .object_path(LocalNamespaceV1::Source, &source.sha256)
            .is_file());
    }

    #[test]
    fn repeated_identical_publication_is_idempotent_but_collision_fails() {
        let parent = tempfile::tempdir().unwrap();
        let transport = LocalContentAddressedTransport::create(&parent.path().join("transport"))
            .unwrap();
        let first = transport
            .publish(LocalNamespaceV1::Candidate, b"stable")
            .unwrap();
        assert_eq!(
            transport
                .publish(LocalNamespaceV1::Candidate, b"stable")
                .unwrap(),
            first
        );

        fs::write(
            transport.object_path(LocalNamespaceV1::Canonical, &first.sha256),
            b"forged",
        )
        .unwrap();
        assert!(transport
            .publish(LocalNamespaceV1::Canonical, b"stable")
            .unwrap_err()
            .contains("collision"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_traversal_in_storage_and_readback() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let transport = LocalContentAddressedTransport::create(&parent.path().join("transport"))
            .unwrap();
        let outside = parent.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let candidate_root = parent.path().join("transport/candidate");
        fs::remove_dir_all(&candidate_root).unwrap();
        symlink(&outside, &candidate_root).unwrap();
        assert!(transport
            .publish(LocalNamespaceV1::Candidate, b"bytes")
            .unwrap_err()
            .contains("nonsymlink"));
    }

    #[test]
    fn interrupted_temporary_file_does_not_change_a_prior_object() {
        let parent = tempfile::tempdir().unwrap();
        let transport = LocalContentAddressedTransport::create(&parent.path().join("transport"))
            .unwrap();
        let prior = transport
            .publish(LocalNamespaceV1::Candidate, b"prior")
            .unwrap();
        fs::write(
            parent.path().join("transport/candidate/sha256/.publish-interrupted"),
            b"partial",
        )
        .unwrap();

        assert_eq!(
            transport
                .anonymous_reader()
                .unwrap()
                .read(&prior.immutable_reference)
                .unwrap(),
            b"prior"
        );
    }

    #[test]
    fn references_reject_mutable_aliases_and_tampered_identity() {
        let parent = tempfile::tempdir().unwrap();
        let transport = LocalContentAddressedTransport::create(&parent.path().join("transport"))
            .unwrap();
        let reader = transport.anonymous_reader().unwrap();
        assert!(reader.read("local-fixture:latest").is_err());
        assert!(reader
            .read(&format!(
                "local-fixture:sha256:{}?namespace=candidate&bytes=1",
                "a".repeat(64)
            ))
            .is_err());
    }
}
