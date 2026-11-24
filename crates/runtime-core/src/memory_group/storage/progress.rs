//! Kernel-selected retry observations. A native wait is scheduling, never a
//! quiescence fence. Its exact pin survives stop and source revocation until
//! the platform reports actual synchronous completion or Promise settlement.
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProgressTarget {
    Barrier(u32),
    Locks(u32),
    Pool,
    NotificationQueue,
}

impl Storage {
    pub(crate) fn prepare_progress(
        &mut self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        target: ProgressTarget,
    ) -> Result<Option<ProgressWait>, Errno> {
        let member = self.owned(admission)?;
        let image = self.images.get(&member.image).ok_or(Errno::ESRCH)?;
        if !image.exposed || member.exposure == Exposure::Prepared {
            return Err(Errno::ESRCH);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let mut address = layout::CONTROL;
        match target {
            ProgressTarget::Pool => {}
            ProgressTarget::NotificationQueue => { address = layout::WAIT_HEADER; }
            ProgressTarget::Locks(epoch) | ProgressTarget::Barrier(epoch) => {
                if image.pause != Some(epoch) || !image.source_live {
                    return Err(Errno::ESRCH);
                }
                if matches!(target, ProgressTarget::Barrier(_)) {
                    let mut pending = None;
                    for (serial, _) in image.replicas.iter() {
                        let replica = self.replicas.get(serial).ok_or(Errno::EIO)?;
                        let (_, _, control) = self.control(memory, replica.admission)?;
                        if memory.atomic_load(control + layout::REPLICA_ACK)? != epoch {
                            pending = Some(control + layout::REPLICA_ACK);
                            break;
                        }
                    }
                    let Some(pending) = pending else {
                        return Ok(None);
                    };
                    address = pending;
                } else if memory.atomic_load(root + layout::ROOT_GROW_LOCK)? != 0 {
                    address = root + layout::ROOT_GROW_LOCK;
                }
            }
        }
        let expected = memory.atomic_load(address)?;
        // Unlike a new data observation, this specific retry may be needed
        // after source revocation. Its target came from this Rust owner, not
        // a host-supplied physical address or a retired allocation.
        let token = self.insert_native_pin(admission, address)?;
        Ok(Some(ProgressWait {
            token,
            address,
            expected,
        }))
    }

    /// Translate a native kernel-channel observation in Rust. The host only
    /// constructs the actual engine view over the returned bounded word.
    pub(crate) fn pin_channel_observation(
        &mut self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        virtual_address: Option<u32>,
    ) -> Result<ProgressWait, Errno> {
        let address = if let Some(address) = virtual_address {
            if address % 4 != 0 {
                return Err(Errno::EFAULT);
            }
            let (_, root, _) = self.control(memory, admission)?;
            let image = self
                .images
                .get(&self.owned(admission)?.image)
                .ok_or(Errno::ESRCH)?;
            let page = address / PAGE;
            if page >= image.layout.maximum_pages || page >= memory.atomic_load(root)? {
                return Err(Errno::EFAULT);
            }
            let entry = memory.atomic_load(root + layout::ROOT_HEADER_BYTES + page * 4)?;
            let physical = entry >> 16;
            if entry & 0xfffc != 0
                || entry & 1 == 0
                || physical == 0
                || physical >= self.maximum_pages
            {
                return Err(Errno::EFAULT);
            }
            physical * PAGE + address % PAGE
        } else {
            layout::WAIT_HEADER
        };
        let token = self.pin_native_observation(memory, admission, address)?;
        Ok(ProgressWait {
            token,
            address,
            expected: memory.atomic_load(address)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::lifecycle_tests::running;
    use super::*;

    #[test]
    fn retirement_progress_remains_pinned_after_revocation_until_exact_settlement() {
        let (_groups, mut storage, mut memory, admission) = running();
        storage
            .request_image_stop(&mut memory, admission, None)
            .unwrap();
        storage.note_quiescent(&mut memory, admission).unwrap();
        storage.revoke_source(&mut memory, admission).unwrap();
        assert_eq!(
            storage.pin_native_observation(&memory, admission, layout::CONTROL),
            Err(Errno::ESRCH)
        );
        let progress = storage
            .prepare_progress(&memory, admission, ProgressTarget::Pool)
            .unwrap()
            .unwrap();
        assert_eq!(progress.address, layout::CONTROL);
        assert_eq!(
            storage.release_stopped_image(&mut memory, admission),
            Err(Errno::EAGAIN)
        );
        storage
            .settle_native_observation(admission, progress.token)
            .unwrap();
        assert_eq!(
            storage.settle_native_observation(admission, progress.token),
            Err(Errno::ESRCH)
        );
        storage
            .release_stopped_image(&mut memory, admission)
            .unwrap();
        assert!(storage.empty());
    }

    #[test]
    fn barrier_progress_targets_only_a_current_unacknowledged_member() {
        let (_groups, mut storage, mut memory, admission) = running();
        let replica = storage.descriptor(admission).unwrap().replica;
        let epoch = storage.begin_image_pause(&mut memory, admission).unwrap();
        assert_eq!(
            storage.prepare_progress(&memory, admission, ProgressTarget::Barrier(epoch + 1)),
            Err(Errno::ESRCH)
        );
        let progress = storage
            .prepare_progress(&memory, admission, ProgressTarget::Barrier(epoch))
            .unwrap()
            .unwrap();
        assert_eq!(progress.address, replica + layout::REPLICA_ACK);
        assert_eq!(progress.expected, 0);
        memory.atomic_store(progress.address, epoch).unwrap();
        assert_eq!(
            storage
                .prepare_progress(&memory, admission, ProgressTarget::Barrier(epoch))
                .unwrap(),
            None
        );
        // ACK/notification is deliberately not pin retirement.
        assert_eq!(storage.pins.len(), 1);
        storage
            .settle_native_observation(admission, progress.token)
            .unwrap();
        storage.resume_image(&mut memory, admission, epoch).unwrap();
        assert_eq!(
            storage.prepare_progress(&memory, admission, ProgressTarget::Locks(epoch)),
            Err(Errno::ESRCH)
        );
    }

    #[test]
    fn prepared_replicas_cannot_orphan_retry_pins_when_cancelled() {
        let (mut groups, mut storage, mut memory, root) = running();
        let thread = groups.prepare_thread(root, 102).unwrap();
        storage.prepare_thread(&mut memory, thread).unwrap();
        assert_eq!(
            storage.prepare_progress(&memory, thread, ProgressTarget::Pool),
            Err(Errno::ESRCH)
        );
        storage.cancel_unpublished(&mut memory, thread).unwrap();
        assert_eq!(storage.pins.len(), 0);
    }

    #[test]
    fn channel_words_are_selected_from_the_current_kernel_pte_and_exact_source() {
        let (_groups, mut storage, mut memory, root) = running();
        let descriptor = storage.descriptor(root).unwrap();
        let page = memory
            .atomic_load(descriptor.root + layout::ROOT_HEADER_BYTES + 4)
            .unwrap()
            >> 16;
        let observation = storage
            .pin_channel_observation(&memory, root, Some(PAGE + 4))
            .unwrap();
        assert_eq!(observation.address, page * PAGE + 4);
        storage
            .settle_native_observation(root, observation.token)
            .unwrap();
        assert_eq!(
            storage.pin_channel_observation(&memory, root, Some(PAGE * 2)),
            Err(Errno::EFAULT)
        );
        memory
            .atomic_store(
                descriptor.root + layout::ROOT_HEADER_BYTES + 4,
                page * PAGE | 2,
            )
            .unwrap();
        assert_eq!(
            storage.pin_channel_observation(&memory, root, Some(PAGE + 4)),
            Err(Errno::EFAULT)
        );
        storage.revoke_source(&mut memory, root).unwrap();
        assert_eq!(
            storage.pin_channel_observation(&memory, root, None),
            Err(Errno::ESRCH)
        );
        assert_eq!(storage.pins.len(), 0);
    }
}
