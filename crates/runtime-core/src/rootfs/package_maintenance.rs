use super::package_upgrade::{Error, Progress, Recovery, StagingFile, Upgrade};
use super::{ByteReq, package_upgrade, sync_persistence};
use crate::IoBuffer;
use crate::process_table::{MaintenanceToken, ProcessTable};
use core::sync::atomic::{AtomicBool, Ordering};
use wasm_posix_shared::Errno;

static BOOT_REQUIRES_MAINTENANCE: AtomicBool = AtomicBool::new(false);

pub(crate) fn guest_admission_blocked() -> bool {
    BOOT_REQUIRES_MAINTENANCE.load(Ordering::SeqCst)
}

pub(super) fn release_boot_admission() {
    BOOT_REQUIRES_MAINTENANCE.store(false, Ordering::SeqCst);
}

pub(super) fn block_boot_admission() {
    BOOT_REQUIRES_MAINTENANCE.store(true, Ordering::SeqCst);
}

pub fn assess_boot_runtime(
    table: &ProcessTable,
    program_abi: u32,
    program_digest: [u8; 32],
    base_only: bool,
    source: &mut Source<'_>,
) -> Result<bool, Error> {
    table.require_boot_configuration()?;
    if !base_only && !super::fixed_persistence_enabled() {
        return Err(Errno::EOPNOTSUPP.into());
    }
    if base_only && (super::fixed_persistence_enabled() || super::image_length().is_none()) {
        return Err(Errno::EINVAL.into());
    }
    if program_abi != wasm_posix_shared::ABI_VERSION || program_digest == [0; 32] {
        return Err(Errno::EINVAL.into());
    }
    block_boot_admission();
    let base_compatible = super::ROOTFS.with(|state| {
        crate::image_policy::check_declared_abi(
            state.image_metadata.as_ref().map(|bytes| bytes.as_slice()), program_abi,
        ).is_ok()
    });
    if base_only && !base_compatible {
        return Ok(true);
    }
    let blocked = match package_upgrade::runtime_boot_admission(program_abi, program_digest, base_compatible, source) {
        Ok(compatible) => !compatible,
        Err(error @ Error::Storage(Errno::ENOMEM | Errno::ENOSPC)) => return Err(error),
        Err(_) => true,
    };
    BOOT_REQUIRES_MAINTENANCE.store(blocked, Ordering::SeqCst);
    Ok(blocked)
}

pub(super) fn inspect_boot_admission(source: &mut Source<'_>) {
    BOOT_REQUIRES_MAINTENANCE.store(true, Ordering::SeqCst);
    let blocked = package_upgrade::boot_requires_maintenance(source).unwrap_or(true);
    BOOT_REQUIRES_MAINTENANCE.store(blocked, Ordering::SeqCst);
}

type Source<'a> = dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno> + 'a;

pub struct Maintenance {
    token: Option<MaintenanceToken>,
    incoming: IoBuffer<u8>,
    upgrade: Option<Upgrade>,
    program_abi: u32,
    program_digest: [u8; 32],
}

impl Maintenance {
    pub fn enter(
        table: &mut ProcessTable,
        program_abi: u32,
        program_digest: [u8; 32],
    ) -> Result<Self, Error> {
        if !super::resizable_persistence_enabled() {
            return Err(Errno::EOPNOTSUPP.into());
        }
        if program_abi == 0 || program_abi > i32::MAX as u32 || program_digest == [0; 32] {
            return Err(Errno::EINVAL.into());
        }
        let token = table.enter_maintenance()?;
        Ok(Self {
            token: Some(token),
            incoming: crate::package_inventory::metadata_buffer(),
            upgrade: None,
            program_abi,
            program_digest,
        })
    }

    fn token(&self, table: &ProcessTable) -> Result<&MaintenanceToken, Error> {
        let token = self.token.as_ref().ok_or(Errno::EPERM)?;
        if !table.holds_maintenance(token) {
            return Err(Errno::EPERM.into());
        }
        Ok(token)
    }

    pub fn upload_inventory(
        &mut self,
        table: &ProcessTable,
        offset: usize,
        bytes: &[u8],
    ) -> Result<usize, Error> {
        self.token(table)?;
        if self.upgrade.is_some() {
            return Err(Errno::EBUSY.into());
        }
        if offset != self.incoming.len() || bytes.len() > 64 * 1024 {
            return Err(Errno::EINVAL.into());
        }
        let length = offset.checked_add(bytes.len()).ok_or(Errno::E2BIG)?;
        if length > crate::package_inventory::MAX_BYTES {
            return Err(Errno::E2BIG.into());
        }
        self.incoming.try_reserve(bytes.len())?;
        self.incoming.extend_from_slice(bytes);
        Ok(length)
    }

    pub fn begin_upgrade(
        &mut self,
        table: &ProcessTable,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        let token = self.token(table)?;
        if self.upgrade.is_some() {
            return Err(Errno::EBUSY.into());
        }
        let upgrade = Upgrade::begin(
            &self.incoming,
            table,
            token,
            self.program_abi,
            self.program_digest,
            source,
        )?;
        self.upgrade = Some(upgrade);
        self.incoming = crate::package_inventory::metadata_buffer();
        Ok(())
    }

    pub fn resume_upgrade(
        &mut self,
        table: &ProcessTable,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        let token = self.token(table)?;
        if self.upgrade.is_some() {
            return Err(Errno::EBUSY.into());
        }
        self.upgrade = Some(Upgrade::resume(
            table,
            token,
            self.program_abi,
            self.program_digest,
            source,
        )?);
        self.incoming = crate::package_inventory::metadata_buffer();
        Ok(())
    }

    pub fn resume_from_source(
        &mut self,
        table: &ProcessTable,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        self.token(table)?;
        if self.upgrade.is_some() {
            return Err(Errno::EBUSY.into());
        }
        let digest = crate::package_inventory::Inventory::decode(&self.incoming)?.digest();
        self.incoming = crate::package_inventory::metadata_buffer();
        let upgrade = Upgrade::resume(table, self.token(table)?, self.program_abi, self.program_digest, source)?;
        if !upgrade.matches_source_inventory(digest) {
            return Err(Errno::EPROTO.into());
        }
        self.upgrade = Some(upgrade);
        Ok(())
    }

    pub fn recovery(
        &self,
        table: &ProcessTable,
        source: &mut Source<'_>,
    ) -> Result<Recovery, Error> {
        package_upgrade::recovery(table, self.token(table)?, source)
    }

    pub fn cancel_operation(&mut self, table: &ProcessTable) -> Result<(), Error> {
        self.token(table)?;
        self.upgrade = None;
        self.incoming = crate::package_inventory::metadata_buffer();
        Ok(())
    }

    pub fn discard_transaction(
        &mut self,
        table: &ProcessTable,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        self.cancel_operation(table)?;
        package_upgrade::discard_transaction(table, self.token(table)?, source)
    }

    pub fn progress(&self) -> Option<Progress<'_>> {
        self.upgrade.as_ref().map(Upgrade::progress)
    }

    pub fn staging_file(&self, index: usize) -> Result<Option<StagingFile<'_>>, Error> {
        self.upgrade
            .as_ref()
            .ok_or(Errno::EINVAL)?
            .staging_file(index)
    }

    fn operation(
        &mut self,
        table: &ProcessTable,
    ) -> Result<(&mut Upgrade, &MaintenanceToken), Error> {
        self.token(table)?;
        Ok((
            self.upgrade.as_mut().ok_or(Errno::EINVAL)?,
            self.token.as_ref().ok_or(Errno::EPERM)?,
        ))
    }

    pub fn verify_next(
        &mut self,
        table: &ProcessTable,
        maximum_bytes: usize,
        source: &mut Source<'_>,
    ) -> Result<bool, Error> {
        let (upgrade, token) = self.operation(table)?;
        upgrade.verify_next(table, token, maximum_bytes, source)
    }

    pub fn prepare(&mut self, table: &ProcessTable, source: &mut Source<'_>) -> Result<(), Error> {
        let (upgrade, token) = self.operation(table)?;
        upgrade.prepare(table, token, source)
    }

    pub fn stage(
        &mut self,
        table: &ProcessTable,
        index: usize,
        offset: u64,
        bytes: &[u8],
        source: &mut Source<'_>,
    ) -> Result<usize, Error> {
        let (upgrade, token) = self.operation(table)?;
        upgrade.stage(index, offset, bytes, table, token, source)
    }

    pub fn restart_staging_file(
        &mut self,
        table: &ProcessTable,
        index: usize,
    ) -> Result<(), Error> {
        let (upgrade, token) = self.operation(table)?;
        upgrade.restart_staging_file(index, table, token)
    }

    pub fn verify_staged_next(
        &mut self,
        table: &ProcessTable,
        maximum_bytes: usize,
        source: &mut Source<'_>,
    ) -> Result<bool, Error> {
        let (upgrade, token) = self.operation(table)?;
        upgrade.verify_staged_next(table, token, maximum_bytes, source)
    }

    pub fn commit(&mut self, table: &ProcessTable) -> Result<(), Error> {
        let (upgrade, token) = self.operation(table)?;
        upgrade.commit(table, token)
    }

    pub fn leave(
        &mut self,
        table: &mut ProcessTable,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        self.cancel_operation(table)?;
        match self.recovery(table, source)? {
            Recovery::Incomplete | Recovery::Transaction(package_upgrade::Phase::Pending) => {
                return Err(Errno::EBUSY.into());
            }
            _ => {}
        }
        package_upgrade::check_installed_runtime(self.program_abi, self.program_digest, source)?;
        sync_persistence()?;
        table.leave_maintenance(self.token.as_ref().ok_or(Errno::EPERM)?)?;
        release_boot_admission();
        self.token = None;
        Ok(())
    }
}

pub mod control;
