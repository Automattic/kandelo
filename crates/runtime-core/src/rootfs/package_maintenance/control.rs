use super::*;
use crate::rootfs::package_plan::{Conflict, VerificationError};
use crate::rootfs::package_upgrade::VerificationTarget;
use wasm_posix_shared::package_maintenance_wire as wire;

pub struct Controller {
    session: Option<Maintenance>,
    last_error: Option<Error>,
}

impl Default for Controller {
    fn default() -> Self {
        Self::new()
    }
}

pub fn error_errno(error: Error) -> Errno {
    match error {
        Error::Storage(error) | Error::Verification(VerificationError::Storage(error)) => error,
        Error::Verification(VerificationError::Conflict(conflict)) => match conflict {
            Conflict::MissingOwnedFile => Errno::ENOENT,
            Conflict::UnownedCollision => Errno::EEXIST,
            Conflict::FileType => Errno::EINVAL,
            _ => Errno::EBUSY,
        },
        Error::Verification(VerificationError::ExpiredFilesystem) => Errno::EBUSY,
        Error::UnsupportedPath => Errno::EOPNOTSUPP,
        Error::InvalidState => Errno::EIO,
    }
}

fn error_kind(error: Option<Error>) -> u32 {
    match error {
        None => wire::ERROR_NONE,
        Some(Error::Storage(_) | Error::Verification(VerificationError::Storage(_))) => {
            wire::ERROR_STORAGE
        }
        Some(Error::Verification(VerificationError::ExpiredFilesystem)) => {
            wire::ERROR_EXPIRED_FILESYSTEM
        }
        Some(Error::UnsupportedPath) => wire::ERROR_UNSUPPORTED_PATH,
        Some(Error::InvalidState) => wire::ERROR_INVALID_STATE,
        Some(Error::Verification(VerificationError::Conflict(conflict))) => match conflict {
            Conflict::MissingOwnedFile => wire::ERROR_MISSING,
            Conflict::UnownedCollision => wire::ERROR_COLLISION,
            Conflict::FileType => wire::ERROR_TYPE,
            Conflict::Metadata => wire::ERROR_METADATA,
            Conflict::Contents => wire::ERROR_CONTENTS,
            Conflict::ChangedDuringVerification => wire::ERROR_CHANGED,
        },
    }
}

fn put_u32(bytes: &mut [u8], offset: u32, value: u32) {
    bytes[offset as usize..offset as usize + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: u32, value: u64) {
    bytes[offset as usize..offset as usize + 8].copy_from_slice(&value.to_le_bytes());
}

impl Controller {
    pub const fn new() -> Self {
        Self {
            session: None,
            last_error: None,
        }
    }

    pub fn call(
        &mut self,
        table: &mut ProcessTable,
        opcode: u32,
        index: u32,
        offset: u64,
        bytes: &mut [u8],
        source: &mut Source<'_>,
    ) -> Result<usize, Error> {
        let result = if bytes.len() > wire::MAX_BUFFER_BYTES as usize {
            Err(Errno::E2BIG.into())
        } else {
            self.dispatch(table, opcode, index, offset, bytes, source)
        };
        if opcode != wire::OP_LAST_ERROR {
            self.last_error = result.as_ref().err().copied();
        }
        result
    }

    fn dispatch(
        &mut self,
        table: &mut ProcessTable,
        opcode: u32,
        index: u32,
        offset: u64,
        bytes: &mut [u8],
        source: &mut Source<'_>,
    ) -> Result<usize, Error> {
        if offset != 0 && !matches!(opcode, wire::OP_UPLOAD_INVENTORY | wire::OP_STAGE) {
            return Err(Errno::EINVAL.into());
        }
        if index != 0
            && !matches!(
                opcode,
                wire::OP_VERIFY_INSTALLED
                    | wire::OP_STAGE
                    | wire::OP_VERIFY_STAGED
                    | wire::OP_STAGING_FILE
                    | wire::OP_RESTART_STAGING_FILE
                    | wire::OP_COMPACTION_NEEDED
                    | wire::OP_ASSESS_BOOT
            )
        {
            return Err(Errno::EINVAL.into());
        }
        if !bytes.is_empty()
            && !matches!(
                opcode,
                wire::OP_ENTER
                    | wire::OP_ASSESS_BOOT
                    | wire::OP_UPLOAD_INVENTORY
                    | wire::OP_STAGE
                    | wire::OP_PROGRESS
                    | wire::OP_STAGING_FILE
            )
        {
            return Err(Errno::EINVAL.into());
        }
        if opcode == wire::OP_LAST_ERROR {
            return Ok(error_kind(self.last_error) as usize);
        }
        if opcode == wire::OP_BOOT_BLOCKED {
            if super::super::image_length().is_none() {
                return Err(Errno::EOPNOTSUPP.into());
            }
            return Ok(usize::from(super::guest_admission_blocked()));
        }
        if matches!(opcode, wire::OP_ENTER | wire::OP_ASSESS_BOOT) {
            if self.session.is_some() {
                return Err(Errno::EBUSY.into());
            }
            if bytes.len() != wire::ENTER_BYTES as usize {
                return Err(Errno::EINVAL.into());
            }
            if bytes[..4] != wire::VERSION.to_le_bytes() || bytes[4..8] != [0; 4] {
                return Err(Errno::EOPNOTSUPP.into());
            }
            let digest = bytes[wire::ENTER_DIGEST_OFFSET as usize..]
                .try_into()
                .map_err(|_| Errno::EINVAL)?;
            if opcode == wire::OP_ASSESS_BOOT {
                if index > wire::BOOT_BASE_ONLY { return Err(Errno::EINVAL.into()); }
                return super::assess_boot_runtime(table, wasm_posix_shared::ABI_VERSION, digest, index == wire::BOOT_BASE_ONLY, source)
                    .map(usize::from);
            }
            self.session = Some(Maintenance::enter(
                table,
                wasm_posix_shared::ABI_VERSION,
                digest,
            )?);
            return Ok(0);
        }
        let session = self.session.as_mut().ok_or(Errno::EPERM)?;
        session.token(table)?;
        match opcode {
            wire::OP_COMPACTION_NEEDED => {
                if !matches!(index, wire::OP_PREPARE | wire::OP_STAGE | wire::OP_COMMIT
                    | wire::OP_DISCARD | wire::OP_RESTART_STAGING_FILE)
                { return Err(Errno::EINVAL.into()); }
                Ok(usize::from(super::super::maintenance_compaction_needed(index == wire::OP_COMMIT)?))
            }
            wire::OP_LEAVE => {
                session.leave(table, source)?;
                self.session = None;
                Ok(0)
            }
            wire::OP_RECOVERY => Ok(match session.recovery(table, source)? {
                Recovery::None => wire::RECOVERY_NONE,
                Recovery::Incomplete => wire::RECOVERY_INCOMPLETE,
                Recovery::Transaction(phase) => match phase {
                    package_upgrade::Phase::Pending => wire::RECOVERY_PENDING,
                    package_upgrade::Phase::Active => wire::RECOVERY_ACTIVE,
                    package_upgrade::Phase::RolledBack => wire::RECOVERY_ROLLED_BACK,
                },
            } as usize),
            wire::OP_UPLOAD_INVENTORY => session.upload_inventory(
                table,
                usize::try_from(offset).map_err(|_| Errno::EOVERFLOW)?,
                bytes,
            ),
            wire::OP_BEGIN => {
                session.begin_upgrade(table, source)?;
                Ok(0)
            }
            wire::OP_RESUME => {
                session.resume_upgrade(table, source)?;
                Ok(0)
            }
            wire::OP_RESUME_FROM_SOURCE => {
                session.resume_from_source(table, source)?;
                Ok(0)
            }
            wire::OP_VERIFY_INSTALLED | wire::OP_VERIFY_STAGED => {
                if index == 0 || index > wire::MAX_BUFFER_BYTES {
                    return Err(Errno::EINVAL.into());
                }
                let complete = if opcode == wire::OP_VERIFY_INSTALLED {
                    session.verify_next(table, index as usize, source)?
                } else {
                    session.verify_staged_next(table, index as usize, source)?
                };
                Ok(usize::from(complete))
            }
            wire::OP_PREPARE => {
                session.prepare(table, source)?;
                Ok(0)
            }
            wire::OP_STAGE => session.stage(table, index as usize, offset, bytes, source),
            wire::OP_COMMIT => {
                session.commit(table)?;
                Ok(0)
            }
            wire::OP_CANCEL => {
                session.cancel_operation(table)?;
                Ok(0)
            }
            wire::OP_DISCARD => {
                session.discard_transaction(table, source)?;
                Ok(0)
            }
            wire::OP_RESTART_STAGING_FILE => {
                session.restart_staging_file(table, index as usize)?;
                Ok(0)
            }
            wire::OP_PROGRESS => {
                let progress = session.progress();
                let path = progress
                    .as_ref()
                    .and_then(|progress| progress.current.map(|(_, path)| path))
                    .unwrap_or(b"");
                let length = wire::PROGRESS_HEADER_BYTES as usize + path.len();
                if bytes.len() < length {
                    return Err(Errno::ENOBUFS.into());
                }
                bytes[..length].fill(0);
                put_u32(bytes, wire::PROGRESS_VERSION_OFFSET, wire::VERSION);
                put_u64(
                    bytes,
                    wire::PROGRESS_INCOMING_BYTES_OFFSET,
                    session.incoming.len() as u64,
                );
                put_u32(bytes, wire::PROGRESS_PATH_LENGTH_OFFSET, path.len() as u32);
                bytes[wire::PROGRESS_HEADER_BYTES as usize..length].copy_from_slice(path);
                if let Some(progress) = progress {
                    put_u32(bytes, wire::PROGRESS_PHASE_OFFSET, progress.phase as u32);
                    put_u32(
                        bytes,
                        wire::PROGRESS_FILE_COUNT_OFFSET,
                        progress.changed_files as u32,
                    );
                    put_u32(
                        bytes,
                        wire::PROGRESS_INSTALLED_COUNT_OFFSET,
                        progress.installed_files_verified as u32,
                    );
                    put_u32(
                        bytes,
                        wire::PROGRESS_STAGED_COUNT_OFFSET,
                        progress.staged_files_verified as u32,
                    );
                    put_u32(
                        bytes,
                        wire::PROGRESS_CURRENT_KIND_OFFSET,
                        progress
                            .current
                            .map_or(wire::CURRENT_NONE, |(target, _)| match target {
                                VerificationTarget::Installed => wire::CURRENT_INSTALLED,
                                VerificationTarget::Staged => wire::CURRENT_STAGED,
                            }),
                    );
                    put_u64(
                        bytes,
                        wire::PROGRESS_VERIFIED_BYTES_OFFSET,
                        progress.verified_bytes,
                    );
                    put_u64(
                        bytes,
                        wire::PROGRESS_TOTAL_BYTES_OFFSET,
                        progress.total_bytes,
                    );
                }
                Ok(length)
            }
            wire::OP_STAGING_FILE => {
                let file = session.staging_file(index as usize)?;
                let path = file.as_ref().map_or(b"".as_slice(), |file| file.path);
                let length = wire::STAGING_HEADER_BYTES as usize + path.len();
                if bytes.len() < length {
                    return Err(Errno::ENOBUFS.into());
                }
                bytes[..length].fill(0);
                put_u32(
                    bytes,
                    wire::STAGING_KIND_OFFSET,
                    file.as_ref().map_or(wire::STAGING_REMOVED, |file| {
                        if file.upload_size.is_some() {
                            wire::STAGING_UPLOAD
                        } else {
                            wire::STAGING_KERNEL
                        }
                    }),
                );
                put_u32(bytes, wire::STAGING_PATH_LENGTH_OFFSET, path.len() as u32);
                put_u64(
                    bytes,
                    wire::STAGING_SIZE_OFFSET,
                    file.and_then(|file| file.upload_size).unwrap_or(0),
                );
                bytes[wire::STAGING_HEADER_BYTES as usize..length].copy_from_slice(path);
                Ok(length)
            }
            _ => Err(Errno::EINVAL.into()),
        }
    }
}
