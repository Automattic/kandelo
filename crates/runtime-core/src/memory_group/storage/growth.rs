//! Private virtual growth uses the actual image's kernel-owned frame pool.
use super::*;

impl Storage {
    pub(crate) fn grow_private(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        delta: u32,
    ) -> Result<u32, Errno> {
        let (key, root, _) = self.control(memory, admission)?;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if self.poisoned || image.stopping || !image.source_live
            || self.owned(admission)?.exposure != Exposure::Exposed
        {
            return Err(Errno::ESRCH);
        }
        if image.mapping.is_some() || image.pause.is_some() {
            return Err(Errno::EAGAIN);
        }
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let result = (|| {
            let old = memory.atomic_load(root)?;
            let maximum = self.images.get(&key).unwrap().layout.maximum_pages;
            if old > maximum || memory.atomic_load(root + 4)? != maximum {
                return Err(Errno::EIO);
            }
            if delta > maximum - old { return Err(Errno::ENOMEM); }
            // memory.grow(0) must work without reserving metadata or frames.
            if delta == 0 { return Ok(old); }
            let mut frames = IoBuffer::try_filled(delta as usize, 0)?;
            self.images.get_mut(&key).unwrap().payload.try_reserve_exact(delta as usize)?;
            for page in old..old + delta {
                if memory.atomic_load(root + layout::ROOT_HEADER_BYTES + page * 4)? != 0 {
                    return Err(Errno::EIO);
                }
            }
            self.pool()?.allocate_pages(memory, &mut frames)?;
            // Retain custody before the first foreign PTE write. A partial
            // publication is containment, never an ordinary growth refusal.
            self.images.get_mut(&key).unwrap().payload.extend_from_slice(&frames);
            for (offset, frame) in frames.iter().copied().enumerate() {
                memory.atomic_store(root + layout::ROOT_HEADER_BYTES + (old + offset as u32) * 4,
                    frame * PAGE | 3)?;
            }
            memory.atomic_store(root, old + delta)?;
            Ok(old)
        })();
        let unlocked = memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)
            .and_then(|()| memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1).map(|_| ()));
        if unlocked.is_err() || result.as_ref().is_err_and(|error| *error == Errno::EIO) {
            self.contain_image(memory, key);
        }
        unlocked?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::contract_tests::image;

    #[test]
    fn growth_owns_zeroed_private_frames_and_retires_them_with_the_image() {
        let (_groups, mut storage, mut memory, root) = image(16);
        let d = storage.descriptor(root).unwrap();
        let before = storage.snapshot(&mut memory).unwrap()[5];
        assert_eq!(storage.grow_private(&mut memory, root, 3), Ok(2));
        assert_eq!(memory.atomic_load(d.root).unwrap(), 5);
        assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before + 3);
        for page in 2..5 {
            let pte = memory.atomic_load(d.root + layout::ROOT_HEADER_BYTES + page * 4).unwrap();
            assert_eq!(pte & 0xffff, 3);
            let mut bytes = [1; PAGE as usize];
            memory.read(pte & 0xffff0000, &mut bytes).unwrap();
            assert!(bytes.iter().all(|byte| *byte == 0));
        }
        storage.note_quiescent(&mut memory, root).unwrap();
        storage.revoke_source(&mut memory, root).unwrap();
        storage.release_stopped_image(&mut memory, root).unwrap();
        assert_eq!(storage.snapshot(&mut memory).unwrap()[5], 1);
    }

    #[test]
    fn refused_growth_and_zero_delta_preserve_extent_and_frame_ownership() {
        let (_groups, mut storage, mut memory, root) = image(4);
        let before = storage.snapshot(&mut memory).unwrap();
        assert_eq!(storage.grow_private(&mut memory, root, u32::MAX), Err(Errno::ENOMEM));
        assert_eq!(storage.grow_private(&mut memory, root, 3), Err(Errno::ENOMEM));
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _budget = crate::io_buffer::test_budget(held);
            assert_eq!(storage.grow_private(&mut memory, root, 0), Ok(2));
        }
        assert_eq!(storage.snapshot(&mut memory).unwrap(), before);
    }

    #[test]
    fn physical_growth_refusal_keeps_the_root_retryable_without_publishing_frames() {
        let (_groups, mut storage, mut memory, root) = image(16);
        let d = storage.descriptor(root).unwrap();
        let before = storage.snapshot(&mut memory).unwrap();
        memory.refuse_growth = true;
        assert_eq!(storage.grow_private(&mut memory, root, 3), Err(Errno::ENOMEM));
        assert_eq!(memory.atomic_load(d.root).unwrap(), 2);
        assert_eq!(memory.atomic_load(d.root + layout::ROOT_GROW_LOCK).unwrap(), 0);
        assert_eq!(storage.snapshot(&mut memory).unwrap(), before);
        memory.refuse_growth = false;
        assert_eq!(storage.grow_private(&mut memory, root, 3), Ok(2));
    }

    #[test]
    fn partial_growth_publication_contains_instead_of_losing_allocated_frames() {
        let (_groups, mut storage, mut memory, root) = image(8);
        let d = storage.descriptor(root).unwrap();
        let before = storage.snapshot(&mut memory).unwrap()[5];
        memory.fail_atomic_store_at(Some(d.root + layout::ROOT_HEADER_BYTES + 3 * 4));
        assert_eq!(storage.grow_private(&mut memory, root, 2), Err(Errno::EIO));
        memory.fail_atomic_store_at(None);
        assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before + 2);
        assert_eq!(storage.snapshot(&mut memory).unwrap()[4], 1);
    }
}
