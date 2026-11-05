use crate::artifact_io::{ArtifactSpool, MappedArtifact};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    fs::Permissions,
    io::Write,
    path::{Path, PathBuf},
};
use wasm_encoder::Encode;
pub use wasm_artifact::original_program::{ORIGINAL_REFERENCE_SECTION, ORIGINAL_REFERENCE_VERSION};
use wasm_artifact::original_program::OriginalProgramReference;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OriginalReference {
    pub length: u64,
    pub sha256: [u8; 32],
}

impl OriginalReference {
    pub fn path(&self, store: &Path) -> PathBuf {
        let digest: String = self
            .sha256
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        store.join("originals").join(format!("{digest}.wasm"))
    }

    fn encode(&self) -> Vec<u8> {
        OriginalProgramReference {
            length: self.length,
            sha256: self.sha256,
        }
        .encode()
        .to_vec()
    }
}

pub fn original_reference(input: &[u8]) -> Result<Option<OriginalReference>> {
    Ok(wasm_artifact::original_program::original_reference(input)?.map(|reference| OriginalReference {
        length: reference.length,
        sha256: reference.sha256,
    }))
}

fn validate_original(input: &[u8]) -> Result<()> {
    ensure!(
        original_reference(input)?.is_none(),
        "use the retained original, not a prepared program"
    );
    crate::native::reject_instrumented_input(input)?;
    crate::native::validate(input)
}

pub fn retain_original(
    input: &MappedArtifact,
    store: &Path,
    permissions: Permissions,
) -> Result<OriginalReference> {
    let reference = reference_for_original(input.bytes())?;
    let destination = reference.path(store);
    let parent = destination.parent().expect("original store has a parent");
    std::fs::create_dir_all(parent).context("creating original-program store")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(input.bytes())?;
    let mut permissions = permissions;
    permissions.set_readonly(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() & 0o444);
    }
    temporary.as_file().set_permissions(permissions)?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(&destination) {
        Ok(_) => {}
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            let retained = load_original(store, &reference, reference.length)?;
            ensure!(
                retained.bytes() == input.bytes(),
                "original-program store content differs"
            );
        }
        Err(error) => return Err(error).context("publishing original program"),
    }
    Ok(reference)
}

pub fn reference_for_original(input: &[u8]) -> Result<OriginalReference> {
    validate_original(input)?;
    Ok(OriginalReference {
        length: input.len() as u64,
        sha256: Sha256::digest(input).into(),
    })
}

pub fn load_original(
    store: &Path,
    reference: &OriginalReference,
    limit: u64,
) -> Result<MappedArtifact> {
    load_original_file(&reference.path(store), reference, limit)
}

pub fn load_original_file(
    path: &Path,
    reference: &OriginalReference,
    limit: u64,
) -> Result<MappedArtifact> {
    ensure!(
        reference.length <= limit,
        "original program exceeds artifact byte budget"
    );
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(metadata.is_file() && !metadata.file_type().is_symlink(),
        "retained original must be a regular non-symlink file");
    validate_original_permissions(metadata.permissions())?;
    let (snapshot, permissions) = MappedArtifact::read(path, reference.length)?;
    validate_original_permissions(permissions)?;
    verify_original(snapshot.bytes(), reference, limit)?;
    Ok(snapshot)
}

fn validate_original_permissions(permissions: Permissions) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(permissions.mode() & 0o7333 == 0,
            "retained original must not be writable, executable or have special mode bits");
    }
    #[cfg(not(unix))]
    let _ = permissions;
    Ok(())
}

pub fn verify_original(input: &[u8], reference: &OriginalReference, limit: u64) -> Result<()> {
    ensure!(
        reference.length <= limit && input.len() as u64 <= limit,
        "original program exceeds artifact byte budget"
    );
    ensure!(
        input.len() as u64 == reference.length
            && Sha256::digest(input)[..] == reference.sha256,
        "retained original-program content mismatch"
    );
    validate_original(input)
}

pub fn attach_original_reference(
    input: &MappedArtifact,
    reference: &OriginalReference,
    limit: u64,
) -> Result<MappedArtifact> {
    ensure!(
        original_reference(input.bytes())?.is_none(),
        "prepared program already references an original"
    );
    let mut section = Vec::new();
    wasm_encoder::CustomSection {
        name: Cow::Borrowed(ORIGINAL_REFERENCE_SECTION),
        data: Cow::Owned(reference.encode()),
    }
    .encode(&mut section);
    let mut spool = ArtifactSpool::new(limit)?;
    spool.write_all(input.bytes())?;
    spool.write_all(&[0])?;
    spool.write_all(&section)?;
    spool.freeze()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn retained_original_permissions_admit_only_read_bits() {
        for mode in 0..=0o7777 {
            assert_eq!(
                validate_original_permissions(Permissions::from_mode(mode)).is_ok(),
                mode & !0o444 == 0,
                "{mode:o}"
            );
        }
    }
}
