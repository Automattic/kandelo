//! Physical storage belongs to the same ProcessTable owner as admission.

use super::{
    physical::HostMemory, storage::Storage, GroupAdmission, ImageLayout, MemoryGroupId,
    MemoryGroups, Phase, ReplicaDescriptor,
};
use crate::{process::HostIO, IoBox};
use wasm_posix_shared::Errno;

pub struct StorageReply {
    pub descriptor: Option<ReplicaDescriptor>,
    pub value: u64,
    pub wait: Option<super::storage::ProgressWait>,
}
impl StorageReply {
    /// A retry observation may outlive source access. It carries no root,
    /// replica, scratch or layout capability that could launch execution.
    pub(crate) fn encode_progress(observer: wasm_posix_shared::memory_group::ReceiptRecord,
        resource: u64, wait: super::storage::ProgressWait, output: &mut [u8]) -> Result<(), Errno> {
        Self { descriptor: None, value: wait.token, wait: Some(wait) }.encode(output)?;
        observer.encode(&mut output[..32])?;
        output[32..40].copy_from_slice(&resource.to_le_bytes());
        Ok(())
    }
    pub fn encode(&self, output: &mut [u8]) -> Result<(), Errno> {
        use wasm_posix_shared::group_storage::REPLY_BYTES;
        if output.len() != REPLY_BYTES {
            return Err(Errno::EINVAL);
        }
        output.fill(0);
        if let Some(descriptor) = self.descriptor {
            descriptor.receipt.encode(&mut output[..32])?;
            output[32..40].copy_from_slice(&descriptor.resource.to_le_bytes());
            for (offset, value) in [
                (40, descriptor.root),
                (44, descriptor.replica),
                (48, descriptor.scratch),
                (52, descriptor.maximum_physical_pages),
                (56, descriptor.maximum_virtual_pages),
                (60, descriptor.scratch_bytes),
            ] {
                output[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        output[64..72].copy_from_slice(&self.value.to_le_bytes());
        if let Some(wait) = self.wait {
            output[72..76].copy_from_slice(&wait.address.to_le_bytes());
            output[76..80].copy_from_slice(&wait.expected.to_le_bytes());
        }
        Ok(())
    }
}

impl MemoryGroups {
    pub fn storage_snapshot(&mut self, group: MemoryGroupId, host: &mut dyn HostIO,
        output: &mut [u8],
    ) -> Result<(), Errno> {
        if output.len() != wasm_posix_shared::group_storage::SNAPSHOT_BYTES { return Err(Errno::EINVAL); }
        let store = self.storage_mut(group)?;
        let snapshot = store.snapshot(&mut HostMemory { resource: store.resource(), host })?;
        for (bytes, value) in output.chunks_exact_mut(4).zip(snapshot) { bytes.copy_from_slice(&value.to_le_bytes()); }
        Ok(())
    }

    pub fn sweep_storage_objects(&mut self, group: MemoryGroupId, host: &mut dyn HostIO) -> Result<u32, Errno> {
        let store = self.storage_mut(group)?;
        store.sweep_objects(&mut HostMemory { resource: store.resource(), host })
    }
    pub fn storage_action(
        &mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
        action: wasm_posix_shared::group_storage::Action,
        token: u64,
        argument: u32,
        host: &mut dyn HostIO,
    ) -> Result<StorageReply, Errno> {
        use wasm_posix_shared::group_storage::Action as A;
        let group = self.resolve_group(record.group)?;
        let admission = self.storage(group)?.resolve(record)?;
        let mut descriptor = None;
        let mut value = 0;
        let mut wait = None;
        if action == A::Publish {
            descriptor = Some(self.publish_storage(admission)?);
            return Ok(StorageReply {
                descriptor,
                value,
                wait,
            });
        }
        let store = self.storage_mut(group)?;
        let mut memory = HostMemory {
            resource: store.resource(),
            host,
        };
        match action {
            A::Describe => descriptor = Some(store.descriptor(admission)?),
            A::Publish => unreachable!(),
            A::BeginImagePause => {
                value = u64::from(store.begin_operation_pause(&mut memory, admission, token)?)
            }
            A::BeginImageOperation => value = store.begin_image_operation(admission)?,
            A::ImageOperationReady => value = u64::from(store.image_operation_ready(admission, token)?),
            A::FinishImageOperation => store.finish_image_operation(admission, token)?,
            A::ImagePauseAcknowledged | A::ResumeImage => {
                let epoch = u32::try_from(token).map_err(|_| Errno::EINVAL)?;
                if action == A::ResumeImage {
                    store.resume_image(&mut memory, admission, epoch)?;
                } else {
                    value =
                        u64::from(store.image_pause_acknowledged(&mut memory, admission, epoch)?);
                }
            }
            A::StopReplica => store.request_stop(&mut memory, admission)?,
            A::StopImage => store.request_image_stop(
                &mut memory,
                admission,
                (argument != 0).then_some(argument),
            )?,
            A::NoteQuiescent => store.note_quiescent(&mut memory, admission)?,
            A::RevokeSource => store.revoke_source(&mut memory, admission)?,
            A::ReleaseStoppedImage => {
                value = u64::from(store.release_stopped_image(&mut memory, admission)?)
            }
            A::PinNative => value = store.pin_native_observation(&memory, admission, argument)?,
            A::SettleNative => store.settle_native_observation(admission, token)?,
            A::Status => value = u64::from(store.status(admission)?),
            A::InspectWait => value = u64::from(store.inspect_wait(&mut memory, admission)?),
            A::PinChannel | A::PinQueue => {
                wait = Some(store.pin_channel_observation(&memory, admission,
                    (action == A::PinChannel).then_some(argument))?);
                value = wait.unwrap().token;
            }
            A::PausedExtent => {
                value = u64::from(store.paused_extent(
                    &mut memory,
                    admission,
                    u32::try_from(token).map_err(|_| Errno::EINVAL)?,
                )?)
            }
            A::Quarantine => store.quarantine(&mut memory, admission)?,
            A::ContainImage => store.quarantine_image(&mut memory, admission)?,
            A::ReclaimRemoved => {
                let result = store.reclaim_removed_pages(&mut memory, admission)?;
                value = u64::from(result.released_pages) | (u64::from(result.retained_pages) << 32);
            }
            A::SweepObjects => value = u64::from(store.sweep_objects(&mut memory)?),
            A::ProgressBarrier | A::ProgressLocks | A::ProgressPool => {
                use super::storage::ProgressTarget as P;
                let target = match action {
                    A::ProgressPool => P::Pool,
                    A::ProgressBarrier => {
                        P::Barrier(u32::try_from(token).map_err(|_| Errno::EINVAL)?)
                    }
                    _ => P::Locks(u32::try_from(token).map_err(|_| Errno::EINVAL)?),
                };
                wait = store.prepare_progress(&memory, admission, target)?;
                value = wait.map_or(0, |wait| wait.token);
            }
        }
        Ok(StorageReply {
            descriptor,
            value,
            wait,
        })
    }
    /// Reserve the kernel owner before constructing a platform Memory. The
    /// host can refuse construction but cannot substitute a larger ceiling.
    pub fn create_storage(
        &mut self,
        group: MemoryGroupId,
        initial_pages: u32,
        host: &mut dyn HostIO,
    ) -> Result<u64, Errno> {
        let snapshot = self.snapshot(group)?;
        if initial_pages == 0 || initial_pages > snapshot.limits.maximum_pages { return Err(Errno::EINVAL); }
        if !snapshot.accepting || self.groups.get(&group.0).unwrap().storage.is_some() {
            return Err(Errno::EBUSY);
        }
        let lease = self.retain_backing(group)?;
        let prepared =
            Storage::prepare(lease, snapshot.limits.maximum_pages).and_then(IoBox::try_new);
        let storage = match prepared {
            Ok(storage) => storage,
            Err(error) => {
                self.release_backing(lease)?;
                return Err(error);
            }
        };
        self.groups.get_mut(&group.0).unwrap().storage = Some(storage);
        // A construction error guarantees no resource was published. An error
        // after construction retains the owner: failed initialization is not
        // evidence that its foreign memory can be forgotten or reused.
        if let Err(error) = host.group_memory_create(lease.serial, initial_pages, snapshot.limits.maximum_pages)
        {
            self.groups.get_mut(&group.0).unwrap().storage = None;
            self.release_backing(lease)?;
            return Err(error);
        }
        self.groups
            .get_mut(&group.0)
            .unwrap()
            .storage
            .as_mut()
            .unwrap()
            .initialize(&mut HostMemory {
                resource: lease.serial,
                host,
            })?;
        Ok(lease.serial)
    }

    fn storage(&self, group: MemoryGroupId) -> Result<&Storage, Errno> {
        self.groups
            .get(&group.0)
            .ok_or(Errno::ENOENT)?
            .storage
            .as_deref()
            .ok_or(Errno::ENOENT)
    }

    pub(crate) fn storage_mut(&mut self, group: MemoryGroupId) -> Result<&mut Storage, Errno> {
        self.groups
            .get_mut(&group.0)
            .ok_or(Errno::ENOENT)?
            .storage
            .as_deref_mut()
            .ok_or(Errno::ENOENT)
    }

    pub(crate) fn storage_owner(
        &mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<(&mut Storage, GroupAdmission), Errno> {
        let group = self.resolve_group(record.group)?;
        let store = self.storage_mut(group)?;
        let admission = store.resolve(record)?;
        Ok((store, admission))
    }

    pub fn prepare_storage_image(
        &mut self,
        admission: GroupAdmission,
        layout: ImageLayout,
        host: &mut dyn HostIO,
    ) -> Result<ReplicaDescriptor, Errno> {
        if self.task(admission)?.phase != Phase::Prepared {
            return Err(Errno::EBUSY);
        }
        let store = self.storage_mut(admission.group)?;
        let resource = store.resource();
        store.prepare_image(&mut HostMemory { resource, host }, admission, layout)?;
        store.descriptor(admission)
    }

    pub fn prepare_storage_thread(
        &mut self,
        admission: GroupAdmission,
        host: &mut dyn HostIO,
    ) -> Result<ReplicaDescriptor, Errno> {
        if self.task(admission)?.phase != Phase::Prepared {
            return Err(Errno::EBUSY);
        }
        let store = self.storage_mut(admission.group)?;
        let resource = store.resource();
        store.prepare_thread(&mut HostMemory { resource, host }, admission)?;
        store.descriptor(admission)
    }

    pub(crate) fn initialize_storage_thread_control(&mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord, address: u32, length: u32,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let admission = self.resolve_receipt(record)?;
        if self.task(admission)?.phase != Phase::Prepared || record.pid == record.tid {
            return Err(Errno::EBUSY);
        }
        let store = self.storage_mut(admission.group)?;
        let root = store.root_for_image(record)?;
        store.initialize_thread_control(&mut HostMemory { resource: store.resource(), host }, root, address, length)
    }

    pub fn prepare_storage_fork(&mut self,
        parent: wasm_posix_shared::memory_group::ReceiptRecord,
        child: wasm_posix_shared::memory_group::ReceiptRecord,
        epoch: u32, host: &mut dyn HostIO,
    ) -> Result<ReplicaDescriptor, Errno> {
        if parent.group != child.group { return Err(Errno::EACCES); }
        let child = self.resolve_receipt(child)?;
        if self.task(child)?.phase != Phase::Prepared { return Err(Errno::EBUSY); }
        let store = self.storage_mut(child.group)?;
        let parent = store.resolve(parent)?;
        store.prepare_private_fork(&mut HostMemory { resource: store.resource(), host }, parent, epoch, child)?;
        store.descriptor(child)
    }

    pub fn publish_storage(
        &mut self,
        admission: GroupAdmission,
    ) -> Result<ReplicaDescriptor, Errno> {
        if self.task(admission)?.phase != Phase::Running {
            return Err(Errno::EBUSY);
        }
        self.storage_mut(admission.group)?.publish(admission)
    }

    pub fn storage_descriptor(
        &self,
        admission: GroupAdmission,
    ) -> Result<ReplicaDescriptor, Errno> {
        self.storage(admission.group)?.descriptor(admission)
    }

    /// Physical rollback precedes admission cancellation. If the allocator is
    /// busy, the exact receipt and its budget remain available for retry.
    pub fn cancel_unconstructed_with_storage(
        &mut self,
        admission: GroupAdmission,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        if self.task(admission)?.phase != Phase::Prepared {
            return Err(Errno::EBUSY);
        }
        if let Some(store) = self.groups.get_mut(&admission.group.0).ok_or(Errno::ENOENT)?.storage.as_deref_mut() {
            match store.resolve(admission.record()) {
                Ok(owned) => {
                    let resource = store.resource();
                    store.cancel_unpublished(&mut HostMemory { resource, host }, owned)?;
                }
                // A logical reservation can fail before storage preparation.
                Err(Errno::ESRCH) => {}
                Err(error) => return Err(error),
            }
        }
        self.cancel_unconstructed(admission)
    }

    pub fn drop_storage(
        &mut self,
        group: MemoryGroupId,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let store = self.storage(group)?;
        if !store.empty() {
            return Err(Errno::EBUSY);
        }
        let lease = store.backing();
        host.group_memory_drop(lease.serial)?;
        self.groups.get_mut(&group.0).unwrap().storage = None;
        self.release_backing(lease)
    }
}

impl MemoryGroups {
    /// The platform reports one exact native fact. The actual group owner
    /// chooses whether that fact retires execution and records physical stop.
    pub(crate) fn report_worker_fact(&mut self, record: wasm_posix_shared::memory_group::ReceiptRecord,
        fact: u32, host: &mut dyn HostIO) -> Result<bool, Errno>
    {
        let (store, admission) = self.storage_owner(record)?;
        if !store.validate_worker_fact(admission, fact)? { return Ok(false); }
        if store.accepted_worker_fact(admission)? {
            // A terminal fence already retired logical execution. Its later
            // exact native join/absence can still satisfy containment without
            // consuming that logical admission twice.
            store.record_worker_fact(admission, fact);
            return Ok(true);
        }
        match self.task(admission)?.phase {
            Phase::Running | Phase::Stopping => self.begin_retirement(admission)?,
            Phase::Quarantined => {},
            Phase::Prepared => return Err(Errno::EBUSY),
        }
        self.retire_quiescent(admission)?;
        // The actual clone owner may already have stopped an execution whose
        // Memory was never delivered. A later genuine native join still ends
        // logical admission without inventing a second physical stop.
        let (store, physical) = self.storage_owner(record)?;
        if store.status(physical)? & wasm_posix_shared::group_storage::status::STOPPED == 0 {
            self.storage_action(record, wasm_posix_shared::group_storage::Action::NoteQuiescent, 0, 0, host)?;
        }
        let (store, _) = self.storage_owner(record)?;
        store.record_worker_fact(admission, fact);
        crate::wait_park::note_children_changed();
        Ok(true)
    }
}

/// Device I/O on a grouped caller's memory (see `storage::device_io`). These
/// are the only ways a device driver reaches that custody: by the caller's
/// exact task receipt for translation, and by the group that issued a pin
/// for its release.
impl MemoryGroups {
    /// Translate and pin every range of one device request in a single
    /// storage call, so the pinned frames are the frames translated. `admit`
    /// may refuse the request after translation, before anything is pinned.
    pub(crate) fn device_translate_and_pin(
        &mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
        ranges: &[super::storage::DeviceRange],
        host: &mut dyn HostIO,
        admit: impl FnOnce(&[alloc::vec::Vec<wasm_posix_shared::kgpu::Extent>]) -> Result<(), Errno>,
    ) -> Result<
        (
            alloc::vec::Vec<alloc::vec::Vec<wasm_posix_shared::kgpu::Extent>>,
            super::storage::DevicePinId,
        ),
        Errno,
    > {
        let (store, admission) = self.storage_owner(record)?;
        let resource = store.resource();
        store.device_translate_and_pin(&HostMemory { resource, host }, admission, ranges, admit)
    }

    /// Read request metadata from the caller's memory into kernel memory.
    pub(crate) fn device_read(
        &mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
        addr: u64,
        out: &mut [u8],
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let (store, admission) = self.storage_owner(record)?;
        let resource = store.resource();
        store.device_read(&HostMemory { resource, host }, admission, addr, out)
    }

    /// Release a pin the device retired. The group outlives the pin: image
    /// retirement waits for device pins, so a missing group means the pin is
    /// already gone and there is nothing left to release.
    pub(crate) fn device_unpin(&mut self, group: u32, pin: super::storage::DevicePinId) {
        if let Ok(store) = self.resolve_group(group).and_then(|group| self.storage_mut(group)) {
            store.device_unpin(pin);
        }
    }

    /// Distinct frames of `group` that device pins hold; inspection's count.
    pub fn device_pinned_frames(&self, group: MemoryGroupId) -> Result<usize, Errno> {
        Ok(self.storage(group)?.device_pinned_frames())
    }

    /// Distinct device-pinned frames summed over every group with storage.
    /// Groups never share frames, so the sum counts no frame twice.
    pub fn device_pinned_frames_total(&self) -> usize {
        self.groups
            .values()
            .filter_map(|group| group.storage.as_deref())
            .map(|storage| storage.device_pinned_frames())
            .sum()
    }
}
