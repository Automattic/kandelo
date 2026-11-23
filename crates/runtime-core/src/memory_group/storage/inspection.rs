use super::*;

impl Storage {
    pub(crate) fn inspect_wait(&self, memory: &mut impl PhysicalMemory, admission: GroupAdmission) -> Result<u32, Errno> {
        let (_, root, control) = self.control(memory, admission)?;
        Ok(match crate::memory_group::wait_queue::inspect(memory, root, control)? {
            crate::memory_group::wait_queue::WaitState::None => 0,
            crate::memory_group::wait_queue::WaitState::Waiting => 1,
            crate::memory_group::wait_queue::WaitState::Returning => 2,
        })
    }
    pub(crate) fn snapshot(&mut self, memory: &mut impl PhysicalMemory)
        -> Result<[u32; wasm_posix_shared::group_storage::SNAPSHOT_FIELDS.len()], Errno> {
        let pool = self.pool()?.snapshot(memory)?;
        let count = |value: usize| u32::try_from(value).map_err(|_| Errno::EOVERFLOW);
        let mut staging = 0usize;
        for image in self.images.values() {
            if let Some(pending) = image.mapping.as_ref() {
                staging = staging.checked_add(pending.staging_bytes()).ok_or(Errno::EOVERFLOW)?;
            }
        }
        let mut unacknowledged = 0;
        for member in self.replicas.values() {
            if let Some(epoch) = member.pause {
                let (_, _, control) = self.control(memory, member.admission)?;
                if memory.atomic_load(control + layout::REPLICA_ACK)? != epoch {
                    unacknowledged += 1;
                }
            }
        }
        Ok([
            self.backing.group.as_raw(), count(self.images.len())?, count(self.replicas.len())?,
            count(self.replicas.values().filter(|r| r.exposure == Exposure::Exposed).count())?,
            count(self.replicas.values().filter(|r| r.exposure == Exposure::Quarantined).count())?,
            pool.allocated_pages,
            count(self.replicas.values().filter(|r| r.pending_wait_drain).count())?, count(self.pins.len())?, count(staging)?,
            // All private custody is one deduplicated kernel vector. Removed
            // pages remain charged there until reclaim/retirement, without
            // historical host-side PTE tuples retaining reused frame numbers.
            0,
            count(self.objects.len())?, count(self.objects.values().map(|o| o.pages.byte_length() / PAGE as usize).sum())?,
            count(self.objects.values().map(|o| o.images.len()).sum())?,
            pool.maximum_pages, pool.high_water_pages, pool.physical_extent_pages,
            count(self.images.values().filter(|image| image.pause.is_some()).count())?, count(unacknowledged)?,
            // Observed atomics only. Inspection neither takes nor releases Q,
            // and these copied words never authorize storage reclamation.
            memory.atomic_load(layout::WAIT_HEADER)?, memory.atomic_load(layout::WAIT_HEADER + 16)?,
        ])
    }
    pub(crate) fn status(&self, admission: GroupAdmission) -> Result<u32, Errno> {
        use wasm_posix_shared::group_storage::status as S;
        let replica = self.owned(admission)?;
        let image = self.images.get(&replica.image).ok_or(Errno::ESRCH)?;
        Ok(if replica.exposure == Exposure::Prepared {
            S::PREPARED
        } else {
            0
        } | if replica.exposure == Exposure::Stopped {
            S::STOPPED
        } else {
            0
        } | if image.exposed && image.replicas.is_empty() {
            S::IMAGE_STOPPED
        } else {
            0
        } | if image.pause.is_some() { S::PAUSED } else { 0 }
            | if image.stopping { S::STOPPING } else { 0 }
            | if image.source_live { S::SOURCE_LIVE } else { 0 }
            | if !image.exposed {
                S::IMAGE_UNEXPOSED
            } else {
                0
            })
    }

    pub(crate) fn paused_extent(
        &self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        epoch: u32,
    ) -> Result<u32, Errno> {
        if !self.image_pause_acknowledged(memory, admission, epoch)? {
            return Err(Errno::EAGAIN);
        }
        let (_, root, _) = self.control(memory, admission)?;
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let result = (|| {
            if !self.image_pause_acknowledged(memory, admission, epoch)? {
                return Err(Errno::EAGAIN);
            }
            let image = self
                .images
                .get(&self.owned(admission)?.image)
                .ok_or(Errno::ESRCH)?;
            let extent = memory.atomic_load(root)?;
            if memory.atomic_load(root + 4)? != image.layout.maximum_pages
                || extent > image.layout.maximum_pages
            {
                return Err(Errno::EIO);
            }
            Ok(extent)
        })();
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        result
    }

    pub(crate) fn quarantine(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        if self.owned(admission)?.exposure == Exposure::Stopped {
            return Ok(());
        }
        let result = self.request_stop(memory, admission);
        self.replicas
            .get_mut(&admission.record().serial)
            .unwrap()
            .exposure = Exposure::Quarantined;
        result
    }

    pub(crate) fn quarantine_image(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        let root = self.root_for_image(admission.record())?;
        let result = self.request_image_stop(memory, root, None);
        // Even queue contention cannot leave another member executing while
        // the kernel is about to latch a fatal uncertainty. No page is freed.
        self.contain_image(memory, key);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::lifecycle_tests::running;

    #[test]
    fn inspection_reports_real_pause_acknowledgements_without_touching_the_queue_lock() {
        let (_groups, mut storage, mut memory, root) = running();
        let descriptor = storage.descriptor(root).unwrap();
        let epoch = storage.begin_image_pause(&mut memory, root).unwrap();
        let snapshot = storage.snapshot(&mut memory).unwrap();
        assert_eq!(&snapshot[16..], &[1, 1, 0, 0]);
        memory.atomic_store(descriptor.replica + layout::REPLICA_ACK, epoch).unwrap();
        memory.atomic_store(layout::WAIT_HEADER, 1).unwrap();
        let snapshot = storage.snapshot(&mut memory).unwrap();
        assert_eq!(&snapshot[16..], &[1, 0, 1, 0]);
        assert_eq!(memory.atomic_load(layout::WAIT_HEADER).unwrap(), 1);
        memory.atomic_store(layout::WAIT_HEADER, 0).unwrap();
        storage.resume_image(&mut memory, root, epoch).unwrap();
        assert_eq!(&storage.snapshot(&mut memory).unwrap()[16..], &[0, 0, 0, 0]);
    }
}
