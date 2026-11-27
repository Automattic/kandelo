//! Pending syscall outcomes retain the exact task's controls independently of
//! native wait pins. A settled engine wait is not permission to publish.
use super::*;
use wasm_posix_shared::channel as C;

#[derive(Debug)]
pub(crate) enum PublicationFailure {
    Busy,
    Fault(Errno),
}

impl Storage {
    pub(crate) fn retain_completion(&mut self, admission: GroupAdmission) -> Result<(), Errno> {
        let member = self.owned(admission)?;
        if self.poisoned || member.exposure == Exposure::Quarantined {
            return Err(Errno::ESRCH);
        }
        let count = member
            .pending_completions
            .checked_add(1)
            .ok_or(Errno::EOVERFLOW)?;
        self.replicas
            .get_mut(&admission.record().serial)
            .unwrap()
            .pending_completions = count;
        Ok(())
    }
    pub(crate) fn release_completion(&mut self, admission: GroupAdmission) -> Result<(), Errno> {
        let count = self
            .owned(admission)?
            .pending_completions
            .checked_sub(1)
            .ok_or(Errno::EINVAL)?;
        self.replicas
            .get_mut(&admission.record().serial)
            .unwrap()
            .pending_completions = count;
        Ok(())
    }
    pub(crate) fn completion_count(&self, admission: GroupAdmission) -> Result<u32, Errno> {
        Ok(self.owned(admission)?.pending_completions)
    }
    // Terminal publication can outlive source revocation. The actual retained
    // completion grants that permission; this translator never creates it.
    fn completion_address(
        &self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        address: u32,
    ) -> Result<u32, Errno> {
        let member = self.owned(admission)?;
        let image = self.images.get(&member.image).ok_or(Errno::ESRCH)?;
        let table = image.allocation.ok_or(Errno::ESRCH)?.controls.address();
        let extent = memory.atomic_load(table)?;
        if address % 4 != 0 || extent > image.layout.maximum_pages || address / PAGE >= extent {
            return Err(Errno::EFAULT);
        }
        let entry = memory.atomic_load(table + layout::ROOT_HEADER_BYTES + address / PAGE * 4)?;
        let frame = entry >> 16;
        if entry & 0xffff != 3
            || frame == 0
            || frame >= memory.current_pages()?
            || !image.payload.contains(&frame)
        {
            return Err(Errno::EFAULT);
        }
        Ok(frame * PAGE + address % PAGE)
    }
    /// Resolve every target before the first store. Fields on one virtual page
    /// share a translation during this synchronous kernel operation. A page
    /// boundary still requires its own private-frame ownership check.
    fn completion_targets<const N: usize>(
        &self, memory: &impl PhysicalMemory, admission: GroupAdmission,
        channel: u32, offsets: [usize; N],
    ) -> Result<[u32; N], Errno> {
        let mut targets = [0; N];
        let mut previous = None;
        for (target, offset) in targets.iter_mut().zip(offsets) {
            let address = channel.checked_add(offset as u32).ok_or(Errno::EFAULT)?;
            if address % 4 != 0 { return Err(Errno::EFAULT); }
            let page = address / PAGE;
            let frame = match previous {
                Some((prior_page, frame)) if prior_page == page => frame,
                _ => self.completion_address(memory, admission, address)? / PAGE,
            };
            previous = Some((page, frame));
            *target = frame * PAGE + address % PAGE;
        }
        Ok(targets)
    }
    pub(crate) fn completion_word(
        &self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        address: u32,
    ) -> Result<u32, Errno> {
        memory.atomic_load(self.completion_address(memory, admission, address)?)
    }
    pub(crate) fn clear_completion_request_flags(&self, memory: &mut impl PhysicalMemory,
        admission: GroupAdmission, channel: u32) -> Result<(), Errno> {
        let address = channel.checked_add(C::REQUEST_FLAGS_OFFSET as u32).ok_or(Errno::EFAULT)?;
        let physical = self.completion_address(memory, admission, address)?;
        memory.atomic_store(physical, 0)
    }
    pub(crate) fn write_completion_signal(
        &self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        channel: u32,
        bytes: &[u8; C::SIG_AREA_SIZE],
    ) -> Result<(), Errno> {
        const WORDS: usize = C::SIG_AREA_SIZE / 4;
        let offsets: [usize; WORDS] = core::array::from_fn(|index| C::SIG_BASE + index * 4);
        let targets = self.completion_targets(memory, admission, channel, offsets)?;
        for (index, address) in targets.into_iter().enumerate() {
            memory.atomic_store(
                address,
                u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap()),
            )?;
        }
        Ok(())
    }
    pub(crate) fn publish_completion(
        &self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        channel: u32,
        value: i64,
        errno: u32,
        unwind: Option<u32>,
    ) -> Result<(), PublicationFailure> {
        let offsets = [
            C::RETURN_OFFSET,
            C::RETURN_OFFSET + 4,
            C::ERRNO_OFFSET,
            C::SIG_SIGNUM,
            C::SIG_HANDLER,
            C::SIG_SI_CODE,
            C::STATUS_OFFSET,
        ];
        let targets = self.completion_targets(memory, admission, channel, offsets)
            .map_err(PublicationFailure::Fault)?;
        let bits = value as u64;
        let payload = [
            bits as u32,
            (bits >> 32) as u32,
            errno,
            wasm_posix_shared::signal::SIGKILL,
            0,
            unwind.unwrap_or(0),
            wasm_posix_shared::ChannelStatus::Complete as u32,
        ];
        crate::memory_group::wait_queue::publish(memory, targets[6], |memory| {
            for index in 0..targets.len() {
                if (3..6).contains(&index) && unwind.is_none() {
                    continue;
                }
                memory.atomic_store(targets[index], payload[index])?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::lifecycle_tests::running;

    #[test]
    fn signal_fields_share_a_page_translation_only_within_one_publication() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        memory.watch_loads(root);
        storage.publish_completion(&mut memory, admission, 0, 41, 0, None).unwrap();
        // Return and errno share a page. Signal fields occupy the next one,
        // then the final status word returns to the first page.
        assert_eq!(memory.watched_loads(), 3);

        let bytes = [0xa5; C::SIG_AREA_SIZE];
        memory.watch_loads(root);
        storage.write_completion_signal(&mut memory, admission, 0, &bytes).unwrap();
        assert_eq!(memory.watched_loads(), 1);

        // Only the first word fits in the two-page image. Failure to
        // translate the rest must leave that first word untouched.
        let address = 2 * PAGE - 4;
        let channel = address - C::SIG_BASE as u32;
        let record = core::array::from_fn(|i| i as u8);
        assert_eq!(storage.write_completion_signal(&mut memory, admission, channel, &record),
            Err(Errno::EFAULT));
        assert_eq!(storage.completion_word(&memory, admission, address).unwrap(), 0);

        storage.grow_private(&mut memory, admission, 1).unwrap();
        memory.watch_loads(root);
        storage.write_completion_signal(&mut memory, admission, channel, &record).unwrap();
        assert_eq!(memory.watched_loads(), 2);
        for (index, bytes) in record.chunks_exact(4).enumerate() {
            let word = storage.completion_word(&memory, admission, address + index as u32 * 4).unwrap();
            assert_eq!(word, u32::from_le_bytes(bytes.try_into().unwrap()));
        }
    }
}
