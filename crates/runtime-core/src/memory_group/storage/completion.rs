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
        let mut targets = [0u32; WORDS];
        for (index, target) in targets.iter_mut().enumerate() {
            let address = channel
                .checked_add((C::SIG_BASE + index * 4) as u32)
                .ok_or(Errno::EFAULT)?;
            *target = self.completion_address(memory, admission, address)?;
        }
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
        let mut targets = [0u32; 7];
        for (target, offset) in targets.iter_mut().zip(offsets) {
            let address = channel
                .checked_add(offset as u32)
                .ok_or(PublicationFailure::Fault(Errno::EFAULT))?;
            *target = self
                .completion_address(memory, admission, address)
                .map_err(PublicationFailure::Fault)?;
        }
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
