//! Join the existing logical VM plan to physical storage inside ProcessTable.
//! The host schedules retries and performs raw platform I/O; it never supplies
//! a reconstructed mapping effect, selects frames, or invokes a commit callback.
use super::*;
use crate::{memory_group::physical::HostMemory, process::HostIO};

impl ProcessTable {
    /// Only opaque kernel-issued identities cross the host boundary. The
    /// logical VM/driver plan supplies all addresses, rights and object holds.
    pub fn group_storage_mapping_action(&mut self,
        receipt: wasm_posix_shared::memory_group::ReceiptRecord,
        command: u32, token: u64, driver: u32, transaction: u64, argument: u32,
        host: &mut dyn HostIO,
    ) -> Result<u32, Errno> {
        use wasm_posix_shared::group_storage::mapping as M;
        let (pid, tid) = (receipt.pid, receipt.tid);
        if !matches!(command, M::STAGE | M::POPULATE | M::COMMIT | M::CANCEL) { return Err(Errno::EINVAL); }
        if driver == 0 && transaction != 0 { return Err(Errno::EINVAL); }
        if command == M::CANCEL {
            // Physical cancellation precedes logical rollback. A busy pool
            // keeps both exact plans for retry. Process removal may already
            // have dropped the logical plan, but never this storage charge.
            let logical = if driver == 0 {
                self.get(pid).filter(|proc| proc.exec_generation == receipt.generation)
                    .and_then(|proc| proc.pending_group_memory_change.as_deref())
                    .and_then(Option::as_ref).map(|pending| pending.description)
            } else {
                match self.get(pid).filter(|proc| proc.exec_generation == receipt.generation) {
                    Some(proc) if crate::owned_resource::has_pending_mapping(proc) =>
                        Some(self.validate_group_owned_mapping(pid, tid, driver, transaction)?),
                    _ => None,
                }
            };
            if let Some(description) = logical {
                if description.receipt != receipt || description.token != token { return Err(Errno::ESRCH); }
            }
            let (store, admission) = self.memory_groups().storage_owner(receipt)?;
            store.cancel_mapping_if_present(&mut HostMemory { resource: store.resource(), host }, admission, token)?;
            if logical.is_some() {
                if driver == 0 { self.cancel_group_memory_change_with_io(pid, tid, token, host)?; }
                else { self.finish_group_owned_mapping(pid, tid, driver, transaction, argument, host)?; }
            }
            return Ok(0);
        }
        let description = if driver == 0 { self.validate_group_memory_change(pid, tid, token)? }
            else { self.validate_group_owned_mapping(pid, tid, driver, transaction)? };
        if description.receipt != receipt || description.token != token { return Err(Errno::ESRCH); }
        match command {
            M::STAGE => {
                if driver == 0 { self.stage_group_storage_mapping(pid, tid, token, argument, host)?; }
                else { self.stage_group_storage_owned_mapping(pid, tid, driver, transaction, argument, host)?; }
            }
            M::POPULATE => {
                if driver != 0 { return Ok(1); }
                return self.advance_group_storage_population(pid, tid, token, host).map(u32::from);
            }
            M::COMMIT => {
                if driver == 0 { self.commit_group_storage_mapping(pid, tid, token, host)?; }
                else { self.commit_group_storage_owned_mapping(pid, tid, driver, transaction, host)?; }
            }
            _ => unreachable!(),
        }
        Ok(0)
    }
    pub fn stage_group_storage_owned_mapping(
        &mut self,
        pid: u32,
        tid: u32,
        token: u32,
        transaction: u64,
        epoch: u32,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let description = self.validate_group_owned_mapping(pid, tid, token, transaction)?;
        let model = crate::owned_resource::grouped_mapping_backing(
            self.get(pid).ok_or(Errno::ESRCH)?,
            token,
        )?;
        let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
        store.stage_mapping(
            &mut HostMemory {
                resource: store.resource(),
                host,
            },
            admission,
            epoch,
            description,
            model.as_ref(),
        )
    }

    pub fn commit_group_storage_owned_mapping(
        &mut self,
        pid: u32,
        tid: u32,
        token: u32,
        transaction: u64,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let description = self.validate_group_owned_mapping(pid, tid, token, transaction)?;
        let model = crate::owned_resource::grouped_mapping_backing(
            self.get(pid).ok_or(Errno::ESRCH)?,
            token,
        )?;
        self.publish_group_storage_mapping(description, model.as_ref(), host, |table, host| {
            let status = table.finish_group_owned_mapping(pid, tid, token, transaction, 0, host)?;
            if status < 0 {
                return Err(Errno::from_u32((-status) as u32).ok_or(Errno::EIO)?);
            }
            Ok(())
        })
    }

    pub fn cancel_group_storage_owned_mapping(
        &mut self,
        pid: u32,
        tid: u32,
        token: u32,
        transaction: u64,
        errno: u32,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let description = self.validate_group_owned_mapping(pid, tid, token, transaction)?;
        let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
        store.cancel_mapping(
            &mut HostMemory {
                resource: store.resource(),
                host,
            },
            admission,
            description.token,
        )?;
        self.finish_group_owned_mapping(pid, tid, token, transaction, errno, host)
            .map(|_| ())
    }

    pub fn stage_group_storage_mapping(
        &mut self,
        pid: u32,
        tid: u32,
        token: u64,
        epoch: u32,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let description = self.validate_group_memory_change(pid, tid, token)?;
        let model = self
            .get(pid)
            .ok_or(Errno::ESRCH)?
            .pending_group_memory_change
            .as_deref()
            .and_then(Option::as_ref)
            .ok_or(Errno::ESRCH)?
            .plan
            .shared_backing()?
            .map(|(model, _, _)| model.clone());
        let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
        store.stage_mapping(
            &mut HostMemory {
                resource: store.resource(),
                host,
            },
            admission,
            epoch,
            description,
            model.as_ref(),
        )
    }

    /// One bounded chunk per entry. EAGAIN retains the exact population cursor;
    /// no transient kernel buffer or foreign-memory view survives a host retry.
    pub fn advance_group_storage_population(
        &mut self,
        pid: u32,
        tid: u32,
        token: u64,
        host: &mut dyn HostIO,
    ) -> Result<bool, Errno> {
        let description = self.validate_group_memory_change(pid, tid, token)?;
        let pending = self
            .get(pid)
            .ok_or(Errno::ESRCH)?
            .pending_group_memory_change
            .as_deref()
            .and_then(Option::as_ref)
            .ok_or(Errno::ESRCH)?;
        let Some(population) = pending.population.as_ref() else {
            return Ok(true);
        };
        if pending.population_eof || pending.population_position == population.len {
            return Ok(true);
        }
        let (source, offset, position, length) = (
            population.source.clone(),
            population.offset,
            pending.population_position,
            population.len,
        );
        let mut bytes = [0; 65536];
        let capacity = bytes.len().min(length - position);
        let count = source.read(
            offset.checked_add(position as u64).ok_or(Errno::EINVAL)?,
            &mut bytes[..capacity],
            host,
        )?;
        if count > capacity {
            return Err(Errno::EIO);
        }
        if count != 0 {
            let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
            store.populate_mapping(
                &mut HostMemory {
                    resource: store.resource(),
                    host,
                },
                admission,
                token,
                position as u64,
                &bytes[..count],
            )?;
        }
        let pending = self
            .get_mut(pid)
            .ok_or(Errno::ESRCH)?
            .pending_group_memory_change
            .as_deref_mut()
            .and_then(Option::as_mut)
            .ok_or(Errno::ESRCH)?;
        pending.population_position += count;
        pending.population_eof = count == 0;
        Ok(pending.population_eof || pending.population_position == length)
    }

    pub fn commit_group_storage_mapping(
        &mut self,
        pid: u32,
        tid: u32,
        token: u64,
        host: &mut dyn HostIO,
    ) -> Result<Description, Errno> {
        let description = self.validate_group_memory_change(pid, tid, token)?;
        let pending = self
            .get(pid)
            .ok_or(Errno::ESRCH)?
            .pending_group_memory_change
            .as_deref()
            .and_then(Option::as_ref)
            .ok_or(Errno::ESRCH)?;
        if pending.population.as_ref().is_some_and(|population| {
            pending.population_position < population.len && !pending.population_eof
        }) {
            return Err(Errno::EBUSY);
        }
        let model = pending
            .plan
            .shared_backing()?
            .map(|(model, _, _)| model.clone());
        self.publish_group_storage_mapping(description, model.as_ref(), host, |table, host| {
            table.commit_group_memory_change_with_io(pid, tid, token, host)
        })
    }

    fn publish_group_storage_mapping<T>(
        &mut self,
        description: Description,
        model: Option<&crate::memory::GroupSharedMapping>,
        host: &mut dyn HostIO,
        commit: impl FnOnce(&mut Self, &mut dyn HostIO) -> Result<T, Errno>,
    ) -> Result<T, Errno> {
        let token = description.token;
        let binding = {
            let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
            store.mapping_binding(admission, token)?
        };
        if let Some(binding) = &binding {
            model.ok_or(Errno::EIO)?.install_physical(binding.clone())?;
        }
        {
            let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
            if let Err(error) = store.publish_mapping(
                &mut HostMemory {
                    resource: store.resource(),
                    host,
                },
                admission,
                token,
            ) {
                if let Some(binding) = &binding {
                    model.unwrap().cancel_physical(binding)?;
                }
                return Err(error);
            }
        }
        let committed = commit(self, host);
        let (store, admission) = self.memory_groups().storage_owner(description.receipt)?;
        match committed {
            Ok(description) => {
                store.finish_mapping(
                    &mut HostMemory {
                        resource: store.resource(),
                        host,
                    },
                    admission,
                    token,
                )?;
                Ok(description)
            }
            Err(error) => {
                store.rollback_mapping(
                    &mut HostMemory {
                        resource: store.resource(),
                        host,
                    },
                    admission,
                    token,
                )?;
                if let Some(binding) = &binding {
                    model.unwrap().cancel_physical(binding)?;
                }
                Err(error)
            }
        }
    }

    pub fn cancel_group_storage_mapping(
        &mut self,
        pid: u32,
        tid: u32,
        token: u64,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let pending = self
            .get(pid)
            .ok_or(Errno::ESRCH)?
            .pending_group_memory_change
            .as_deref()
            .and_then(Option::as_ref)
            .ok_or(Errno::ESRCH)?;
        if pending.description.token != token || pending.description.receipt.tid != tid {
            return Err(Errno::ESRCH);
        }
        let record = pending.description.receipt;
        let (store, admission) = self.memory_groups().storage_owner(record)?;
        store.cancel_mapping(
            &mut HostMemory {
                resource: store.resource(),
                host,
            },
            admission,
            token,
        )?;
        self.cancel_group_memory_change_with_io(pid, tid, token, host)
    }
}
