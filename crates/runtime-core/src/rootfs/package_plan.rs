use super::*;
use crate::package_inventory::{Content, File};
use crate::process_table::{MaintenanceToken, ProcessTable};

const VERIFY_CHUNK_BYTES: usize = 64 * 1024;
static FILESYSTEM_EPOCH: AtomicU64 = AtomicU64::new(1);
static EPOCH_EXHAUSTED: AtomicBool = AtomicBool::new(false);

pub(super) fn invalidate_filesystem() {
    if FILESYSTEM_EPOCH
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |epoch| {
            epoch.checked_add(1)
        })
        .is_err()
    {
        EPOCH_EXHAUSTED.store(true, Ordering::SeqCst);
    }
}

pub(super) fn filesystem_epoch() -> Result<u64, Errno> {
    if EPOCH_EXHAUSTED.load(Ordering::SeqCst) {
        return Err(Errno::EOVERFLOW);
    }
    Ok(FILESYSTEM_EPOCH.load(Ordering::SeqCst))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Conflict {
    MissingOwnedFile,
    UnownedCollision,
    FileType,
    Metadata,
    Contents,
    ChangedDuringVerification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationError {
    Conflict(Conflict),
    Storage(Errno),
    ExpiredFilesystem,
}

impl From<Errno> for VerificationError {
    fn from(error: Errno) -> Self {
        Self::Storage(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    ino: u64,
    generation: u64,
    kind: u32,
    mode: u32,
    uid: u32,
    gid: u32,
    size: u64,
    source_digest: [u8; 32],
}

fn observe(path: &[u8]) -> Result<Option<Stamp>, Errno> {
    if !crate::package_inventory::valid_path(path)
        && !path.starts_with(b"/var/lib/kandelo/packages/")
    {
        return Err(Errno::EINVAL);
    }
    if !owns_path(path) {
        return Err(Errno::EXDEV);
    }
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let index = match state.walk(root, &split_components(path)) {
            Ok(index) => index,
            Err(Errno::ENOENT) => return Ok(None),
            Err(error) => return Err(error),
        };
        let inode = state.get(index).ok_or(Errno::EIO)?;
        let stat = inode.stat();
        let kind = stat.st_mode & S_IFMT;
        Ok(Some(Stamp {
            ino: inode.ino,
            generation: if kind == S_IFDIR {
                0
            } else {
                inode.content_gen
            },
            kind,
            mode: inode.mode,
            uid: inode.uid,
            gid: inode.gid,
            size: if kind == S_IFDIR { 0 } else { stat.st_size },
            source_digest: inode.deferred_digest,
        }))
    })
}

fn require_maintenance(
    table: &ProcessTable,
    token: &MaintenanceToken,
) -> Result<(), VerificationError> {
    if table.holds_maintenance(token) {
        Ok(())
    } else {
        Err(Errno::EPERM.into())
    }
}

pub struct VerifiedFile {
    path: crate::IoBuffer<u8>,
    stamp: Option<Stamp>,
    maintenance: u64,
    epoch: u64,
}

impl VerifiedFile {
    pub fn path(&self) -> &[u8] {
        &self.path
    }
    pub fn inode(&self) -> Option<u64> {
        self.stamp.map(|stamp| stamp.ino)
    }

    pub fn verify_absence(
        path: &[u8],
        table: &ProcessTable,
        token: &MaintenanceToken,
    ) -> Result<Self, VerificationError> {
        if !crate::package_inventory::valid_path(path) {
            return Err(Errno::EINVAL.into());
        }
        require_maintenance(table, token)?;
        let maintenance = table.maintenance_identity(token)?;
        let epoch = filesystem_epoch()?;
        if observe(path)?.is_some() {
            return Err(VerificationError::Conflict(Conflict::UnownedCollision));
        }
        Ok(Self {
            path: crate::package_inventory::metadata_copy(path)?,
            stamp: None,
            maintenance,
            epoch,
        })
    }

    pub fn revalidate(
        &self,
        table: &ProcessTable,
        token: &MaintenanceToken,
    ) -> Result<(), VerificationError> {
        require_maintenance(table, token)?;
        if table.maintenance_identity(token)? != self.maintenance {
            return Err(Errno::EPERM.into());
        }
        if filesystem_epoch()? != self.epoch {
            return Err(VerificationError::ExpiredFilesystem);
        }
        match (self.stamp, observe(&self.path)?) {
            (expected, actual) if expected == actual => Ok(()),
            (None, Some(_)) => Err(VerificationError::Conflict(Conflict::UnownedCollision)),
            (Some(_), None) => Err(VerificationError::Conflict(Conflict::MissingOwnedFile)),
            _ => Err(VerificationError::Conflict(
                Conflict::ChangedDuringVerification,
            )),
        }
    }
}

struct ReadHandle {
    handle: i64,
    epoch: u64,
}

impl Drop for ReadHandle {
    fn drop(&mut self) {
        if filesystem_epoch().ok() == Some(self.epoch) {
            release_handle(self.handle);
        }
    }
}

pub struct FileVerification {
    file: VerifiedFile,
    handle: Option<ReadHandle>,
    buffer: crate::IoBuffer<u8>,
    digest: Sha256,
    expected: [u8; 32],
    offset: u64,
    size: u64,
    complete: bool,
    failed: Option<Conflict>,
}

impl FileVerification {
    pub fn begin(
        expected: &File<'_>,
        table: &ProcessTable,
        token: &MaintenanceToken,
    ) -> Result<Self, VerificationError> {
        if !crate::package_inventory::valid_path(expected.path) {
            return Err(Errno::EINVAL.into());
        }
        Self::begin_at(expected, expected.path, table, token)
    }

    pub(super) fn begin_at(
        expected: &File<'_>,
        path: &[u8],
        table: &ProcessTable,
        token: &MaintenanceToken,
    ) -> Result<Self, VerificationError> {
        require_maintenance(table, token)?;
        let maintenance = table.maintenance_identity(token)?;
        let epoch = filesystem_epoch()?;
        let stamp =
            observe(path)?.ok_or(VerificationError::Conflict(Conflict::MissingOwnedFile))?;
        let kind = match expected.content {
            Content::Directory => S_IFDIR,
            Content::Symlink(_) => S_IFLNK,
            _ => S_IFREG,
        };
        if stamp.kind != kind {
            return Err(VerificationError::Conflict(Conflict::FileType));
        }
        if (stamp.mode, stamp.uid, stamp.gid) != (expected.mode, expected.uid, expected.gid) {
            return Err(VerificationError::Conflict(Conflict::Metadata));
        }
        let mut verification = Self {
            file: VerifiedFile {
                path: crate::package_inventory::metadata_copy(path)?,
                stamp: Some(stamp),
                maintenance,
                epoch,
            },
            handle: None,
            buffer: crate::IoBuffer::new(),
            digest: Sha256::new(),
            expected: [0; 32],
            offset: 0,
            size: 0,
            complete: false,
            failed: None,
        };
        match expected.content {
            Content::Directory => verification.complete = true,
            Content::Symlink(target) => {
                if stamp.size != target.len() as u64 {
                    return Err(VerificationError::Conflict(Conflict::Contents));
                }
                let mut bytes = crate::IoBuffer::try_filled(target.len(), 0)?;
                if readlink(path, &mut bytes)? != target.len() || bytes.as_ref() != target {
                    return Err(VerificationError::Conflict(Conflict::Contents));
                }
                verification.complete = true;
            }
            Content::Regular { size, digest } | Content::Deferred { size, digest, .. } => {
                if size > i64::MAX as u64 || digest == [0; 32] {
                    return Err(Errno::EINVAL.into());
                }
                if stamp.size != size {
                    return Err(VerificationError::Conflict(Conflict::Contents));
                }
                verification.size = size;
                verification.expected = digest;
                let bound = ROOTFS.with(|state| {
                    let root = state.mount_root()?;
                    let index = state.walk(root, &split_components(path))?;
                    let inode = state.get(index).ok_or(Errno::EIO)?;
                    let content_bound = inode.deferred_digest == digest
                            && matches!(
                                inode.kind,
                                InodeKind::BaseRegular { .. } | InodeKind::LazyMember { .. }
                            );
                    let archive_bound = match expected.content {
                        Content::Deferred { provider, .. } => provider_record::matches_unhashed_archive_member(state, inode, provider, size, digest)?,
                        _ => false,
                    };
                    Ok::<_, Errno>(content_bound || archive_bound)
                })?;
                if bound || (size == 0 && Sha256::digest([]).as_slice() == digest) {
                    verification.offset = size;
                    verification.complete = true;
                } else if size == 0 {
                    return Err(VerificationError::Conflict(Conflict::Contents));
                } else {
                    verification.handle = Some(ReadHandle {
                        handle: open(path, O_RDONLY, 0, 0, 0)?,
                        epoch,
                    });
                    verification.buffer = crate::IoBuffer::try_filled(
                        (size.min(VERIFY_CHUNK_BYTES as u64)) as usize,
                        0,
                    )?;
                }
            }
        }
        Ok(verification)
    }

    pub fn path(&self) -> &[u8] {
        self.file.path()
    }
    pub fn verified_bytes(&self) -> u64 {
        self.offset
    }
    pub fn total_bytes(&self) -> u64 {
        self.size
    }
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn read_more(
        &mut self,
        table: &ProcessTable,
        token: &MaintenanceToken,
        maximum_bytes: usize,
        source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
    ) -> Result<bool, VerificationError> {
        require_maintenance(table, token)?;
        self.file.revalidate(table, token)?;
        if let Some(conflict) = self.failed {
            return Err(VerificationError::Conflict(conflict));
        }
        if self.complete {
            return Ok(true);
        }
        if maximum_bytes == 0 {
            return Err(Errno::EINVAL.into());
        }
        let length = self
            .size
            .saturating_sub(self.offset)
            .min(maximum_bytes.min(self.buffer.len()) as u64) as usize;
        let handle = self.handle.as_ref().ok_or(Errno::EIO)?.handle;
        let count = read(
            handle,
            self.offset as i64,
            &mut self.buffer[..length],
            source,
        )?;
        if count == 0 || count > length {
            return Err(Errno::EIO.into());
        }
        self.digest.update(&self.buffer[..count]);
        self.offset = self.offset.checked_add(count as u64).ok_or(Errno::EIO)?;
        self.file.revalidate(table, token)?;
        if self.offset == self.size {
            if self.digest.clone().finalize().as_slice() != self.expected {
                self.failed = Some(Conflict::Contents);
                self.handle = None;
                return Err(VerificationError::Conflict(Conflict::Contents));
            }
            self.complete = true;
            self.handle = None;
        }
        Ok(self.complete)
    }

    pub fn finish(
        self,
        table: &ProcessTable,
        token: &MaintenanceToken,
    ) -> Result<VerifiedFile, VerificationError> {
        self.file.revalidate(table, token)?;
        if let Some(conflict) = self.failed {
            return Err(VerificationError::Conflict(conflict));
        }
        if !self.complete {
            return Err(Errno::EBUSY.into());
        }
        Ok(self.file)
    }
}
