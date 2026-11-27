//! Fork selects/copies private frames in the kernel. Pointers stay virtual;
//! shared objects retain the same physical pages and their exact ownership.
use super::*;

impl Storage {
    /// Translate one aligned word under the exact live image and page rights.
    /// Foreign-memory callbacks perform only the selected load/store/CAS.
    fn execution_word_address(&self, memory: &impl PhysicalMemory,
        admission: GroupAdmission, address: u32, rights: u32,
    ) -> Result<u32, Errno> {
        let image = self.images.get(&self.owned(admission)?.image).ok_or(Errno::ESRCH)?;
        if address % 4 != 0 || !image.source_live || image.stopping {
            return Err(Errno::EFAULT);
        }
        let table = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let extent = memory.atomic_load(table)?;
        if extent > image.layout.maximum_pages || address / PAGE >= extent { return Err(Errno::EFAULT); }
        let pte = memory.atomic_load(table + layout::ROOT_HEADER_BYTES + address / PAGE * 4)?;
        if pte & 0xfffc != 0 || pte & rights != rights || pte >> 16 == 0 || pte >> 16 >= memory.current_pages()? {
            return Err(Errno::EFAULT);
        }
        Ok((pte & 0xffff0000) + address % PAGE)
    }

    pub(crate) fn execution_word(&self, memory: &impl PhysicalMemory,
        admission: GroupAdmission, address: u32,
    ) -> Result<u32, Errno> {
        memory.atomic_load(self.execution_word_address(memory, admission, address, 1)?)
    }

    pub(crate) fn writable_execution_word(&self, memory: &impl PhysicalMemory,
        admission: GroupAdmission, address: u32,
    ) -> Result<u32, Errno> {
        memory.atomic_load(self.execution_word_address(memory, admission, address, 3)?)
    }

    pub(crate) fn write_execution_word(&self, memory: &mut impl PhysicalMemory,
        admission: GroupAdmission, address: u32, value: u32,
    ) -> Result<(), Errno> {
        let physical = self.execution_word_address(memory, admission, address, 3)?;
        memory.atomic_store(physical, value)
    }

    pub(crate) fn compare_exchange_execution_word(&self, memory: &mut impl PhysicalMemory,
        admission: GroupAdmission, address: u32, expected: u32, value: u32,
    ) -> Result<u32, Errno> {
        let physical = self.execution_word_address(memory, admission, address, 3)?;
        memory.atomic_compare_exchange(physical, expected, value)
    }

    /// A copied pending syscall belongs to the parent. Clear the child's
    /// mailbox before it can be registered or observed by a dispatcher, while
    /// preserving the continuation anchor and every surrounding guest byte.
    pub(crate) fn initialize_fork_channel(
        &self,
        memory: &mut impl PhysicalMemory,
        child: GroupAdmission,
        address: u32,
    ) -> Result<(), Errno> {
        let member = self.owned(child)?;
        let image = self.images.get(&member.image).ok_or(Errno::ESRCH)?;
        if member.exposure != Exposure::Prepared || image.exposed || image.stopping {
            return Err(Errno::EBUSY);
        }
        let length = wasm_posix_shared::channel::MIN_CHANNEL_SIZE as u32;
        let end = address.checked_add(length).ok_or(Errno::EFAULT)?;
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        if address % 4 != 0
            || u64::from(end) > u64::from(memory.atomic_load(root)?) * u64::from(PAGE)
        {
            return Err(Errno::EFAULT);
        }
        const TARGETS: usize =
            (wasm_posix_shared::channel::MIN_CHANNEL_SIZE + 2 * PAGE as usize - 2) / PAGE as usize;
        let mut targets = [(0, 0); TARGETS];
        let mut count = 0;
        let mut cursor = address;
        // Preflight every segment before the first write. A mailbox must be
        // private to this child; a shared-object alias cannot be cleared.
        while cursor < end {
            let entry = memory.atomic_load(root + layout::ROOT_HEADER_BYTES + cursor / PAGE * 4)?;
            let frame = entry >> 16;
            if entry & 0xffff != 3
                || !image.payload.contains(&frame)
                || frame >= memory.current_pages()?
            {
                return Err(Errno::EFAULT);
            }
            let bytes = (end - cursor).min(PAGE - cursor % PAGE);
            targets[count] = (frame * PAGE + cursor % PAGE, bytes);
            count += 1;
            cursor += bytes;
        }
        for (physical, bytes) in &targets[..count] {
            memory.fill(*physical, *bytes, 0)?;
        }
        Ok(())
    }

    pub(crate) fn prepare_private_fork(
        &mut self,
        memory: &mut impl PhysicalMemory,
        parent: GroupAdmission,
        epoch: u32,
        child: GroupAdmission,
    ) -> Result<u64, Errno> {
        self.check_new(child)?;
        let receipt = child.record();
        let child_key = ImageKey {
            pid: receipt.pid,
            generation: receipt.generation,
        };
        let parent_key = self.owned(parent)?.image;
        if receipt.pid != receipt.tid
            || receipt.pid == parent.record().pid
            || self.images.contains_key(&child_key)
        {
            return Err(Errno::EINVAL);
        }
        if !self.image_pause_acknowledged(memory, parent, epoch)? {
            return Err(Errno::EAGAIN);
        }
        let image = self.images.get(&parent_key).ok_or(Errno::ESRCH)?;
        if image.mapping.is_some() {
            return Err(Errno::EBUSY);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let mut copies = IoBuffer::try_filled(self.maximum_pages as usize, u32::MAX)?;
        let mut shared = PreparedMap::<u64, u8>::new();
        let mut shared_owners = IoBuffer::try_with_capacity(image.objects.len())?;
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let prepared = (|| {
            if !self.image_pause_acknowledged(memory, parent, epoch)? {
                return Err(Errno::EAGAIN);
            }
            let original = self.images.get(&parent_key).unwrap();
            let extent = memory.atomic_load(root)?;
            if extent > original.layout.maximum_pages
                || memory.atomic_load(root + 4)? != original.layout.maximum_pages
            {
                return Err(Errno::EIO);
            }
            let mut entries = IoBuffer::try_filled(extent as usize, 0)?;
            let mut private_count = 0;
            // The parent barrier and root growth lock stabilize this image's
            // entries. Other images may grow the backing, but cannot publish
            // those new frames in this table while it is locked.
            let physical_pages = memory.current_pages()?;
            super::super::physical::visit_nonzero(memory, root + layout::ROOT_HEADER_BYTES,
                original.layout.maximum_pages, |at, entry| {
                let physical = entry >> 16;
                if entry & 0xfffc != 0
                    || physical == 0
                    || physical >= physical_pages
                    || physical >= self.maximum_pages
                    || at >= extent
                {
                    return Err(Errno::EIO);
                }
                entries[at as usize] = entry;
                let object = original
                    .objects
                    .keys()
                    .find(|id| {
                        self.objects
                            .get(id)
                            .is_some_and(|object| object.pages.contains(physical))
                    })
                    .copied();
                if let Some(id) = object {
                    if !shared.contains_key(&id) {
                        let member = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(id, 0)?;
                        let owner = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(child_key, 0)?;
                        shared.publish_io(member);
                        shared_owners.push((id, owner));
                    }
                } else if copies[physical as usize] == u32::MAX {
                    copies[physical as usize] = private_count;
                    private_count += 1;
                }
                Ok(())
            })?;
            let layout = ImageLayout {
                initial_pages: extent,
                ..original.layout
            };
            let controls = (u64::from(layout::ROOT_HEADER_BYTES)
                + u64::from(layout.maximum_pages) * 4)
                .div_ceil(u64::from(PAGE)) as u32;
            let scratch = (u64::from(layout::REPLICA_BYTES) + u64::from(layout.scratch_bytes))
                .div_ceil(u64::from(PAGE)) as u32;
            let mut next = Image {
                layout,
                allocation: None,
                payload: IoBuffer::try_filled(private_count as usize, 0)?,
                replicas: PreparedMap::new(),
                exposed: false,
                source_live: true,
                stopping: false,
                pause: None,
                mapping: None,
                objects: shared,
            };
            next.replicas
                .publish_io(PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(receipt.serial, 0)?);
            let mut image_entry =
                PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(child_key, next)?;
            let mut replica_entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
                receipt.serial,
                Replica {
                    admission: child,
                    image: child_key,
                    scratch: None,
                    exposure: Exposure::Prepared,
                    pause: None,
                    pending_wait_drain: false,
                    worker_absent: false,
                    references: References::Unbound,
                    native_join: false,
                    containment: Containment::Unissued,
                    worker_fact: 0,
                    pending_completions: 0,
                },
            )?;
            let allocation = self.pool.as_mut().ok_or(Errno::EAGAIN)?.allocate_image(
                memory,
                controls,
                scratch,
                &mut image_entry.value_mut().payload,
            )?;
            image_entry.value_mut().allocation = Some(allocation);
            replica_entry.value_mut().scratch = Some(allocation.scratch);
            // Custody is registered before foreign copies. Any later failure
            // contains the child and keeps every physical frame charged.
            self.images.publish_io(image_entry);
            self.replicas.publish_io(replica_entry);
            while let Some((id, owner)) = shared_owners.pop() {
                self.objects
                    .get_mut(&id)
                    .ok_or(Errno::EIO)?
                    .images
                    .publish_io(owner);
            }
            let initialized = (|| {
                let image = self.images.get(&child_key).unwrap();
                for (physical, index) in copies.iter().copied().enumerate() {
                    if index != u32::MAX {
                        memory.copy(
                            image.payload[index as usize] * PAGE,
                            physical as u32 * PAGE,
                            PAGE,
                        )?;
                    }
                }
                let child_root = allocation.controls.address();
                memory.write(child_root + 4, &image.layout.maximum_pages.to_le_bytes())?;
                memory.write(child_root + 8, &image.layout.scratch_bytes.to_le_bytes())?;
                memory.atomic_store(child_root + layout::ROOT_RUN, 1)?;
                for (at, entry) in entries.iter().copied().enumerate() {
                    if entry == 0 {
                        continue;
                    }
                    let physical = entry >> 16;
                    let next = if copies[physical as usize] == u32::MAX {
                        physical
                    } else {
                        image.payload[copies[physical as usize] as usize]
                    };
                    memory.atomic_store(
                        child_root + layout::ROOT_HEADER_BYTES + at as u32 * 4,
                        next * PAGE | (entry & 3),
                    )?;
                }
                memory.atomic_store(child_root, extent)?;
                initialize_replica(
                    memory,
                    self.replicas.get(&receipt.serial).unwrap(),
                    child_root,
                )
            })();
            if let Err(error) = initialized {
                self.contain_image(memory, child_key);
                return Err(error);
            }
            Ok(receipt.serial)
        })();
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        prepared
    }
}

#[cfg(test)]
mod tests {
    use super::super::lifecycle_tests::running;
    use super::*;
    use crate::group_memory_change::{Description, Effect};
    fn pte(memory: &impl PhysicalMemory, root: u32, page: u32) -> u32 {
        memory
            .atomic_load(root + layout::ROOT_HEADER_BYTES + page * 4)
            .unwrap()
    }
    #[test]
    fn child_mailbox_initialization_preserves_parent_and_continuation_bytes() {
        let (mut groups, mut storage, mut memory, parent) = running();
        let original = storage.descriptor(parent).unwrap();
        for page in 0..2 {
            memory
                .fill(pte(&memory, original.root, page) & 0xffff0000, PAGE, 0xa5)
                .unwrap();
        }
        let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
        memory
            .atomic_store(original.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
        storage
            .prepare_private_fork(&mut memory, parent, epoch, child)
            .unwrap();
        let copied = storage.descriptor(child).unwrap();
        let channel = 16;
        let end = channel + wasm_posix_shared::channel::MIN_CHANNEL_SIZE as u32;
        storage
            .initialize_fork_channel(&mut memory, child, channel)
            .unwrap();
        let mut bytes = [0; PAGE as usize];
        for page in 0..2 {
            memory
                .read(pte(&memory, original.root, page) & 0xffff0000, &mut bytes)
                .unwrap();
            assert!(bytes.iter().all(|byte| *byte == 0xa5));
            memory
                .read(pte(&memory, copied.root, page) & 0xffff0000, &mut bytes)
                .unwrap();
            for (offset, byte) in bytes.iter().enumerate() {
                let address = page * PAGE + offset as u32;
                assert_eq!(
                    *byte,
                    if (channel..end).contains(&address) {
                        0
                    } else {
                        0xa5
                    }
                );
            }
        }
    }

    #[test]
    fn child_mailbox_initialization_preflights_the_whole_range_before_writing() {
        let (mut groups, mut storage, mut memory, parent) = running();
        let original = storage.descriptor(parent).unwrap();
        let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
        memory
            .atomic_store(original.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
        storage
            .prepare_private_fork(&mut memory, parent, epoch, child)
            .unwrap();
        let copied = storage.descriptor(child).unwrap();
        let first = pte(&memory, copied.root, 0) & 0xffff0000;
        memory.fill(first, PAGE, 0xa5).unwrap();
        memory
            .atomic_store(copied.root + layout::ROOT_HEADER_BYTES + 4, 0)
            .unwrap();
        assert_eq!(
            storage.initialize_fork_channel(&mut memory, child, 16),
            Err(Errno::EFAULT)
        );
        let mut bytes = [0; PAGE as usize];
        memory.read(first, &mut bytes).unwrap();
        assert!(bytes.iter().all(|byte| *byte == 0xa5));
        assert_eq!(
            storage.initialize_fork_channel(&mut memory, parent, 16),
            Err(Errno::EBUSY)
        );
    }

    #[test]
    fn fork_checks_the_sparse_tail_before_allocating_child_pages() {
        let (mut groups, mut storage, mut memory, parent) = running();
        let root = storage.descriptor(parent).unwrap();
        let extent = memory.atomic_load(root.root).unwrap();
        let maximum = memory.atomic_load(root.root + 4).unwrap();
        assert!(extent < maximum);
        let tail = root.root + layout::ROOT_HEADER_BYTES + (maximum - 1) * 4;
        memory.atomic_store(tail, pte(&memory, root.root, 0)).unwrap();
        let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
        memory.atomic_store(root.replica + layout::REPLICA_ACK, epoch).unwrap();
        let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
        let before = storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages;
        assert_eq!(storage.prepare_private_fork(&mut memory, parent, epoch, child), Err(Errno::EIO));
        assert_eq!(storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages, before);
        assert_eq!(storage.descriptor(child), Err(Errno::ESRCH));
        assert_eq!(memory.atomic_load(root.root + layout::ROOT_GROW_LOCK).unwrap(), 0);
    }

    #[test]
    fn fork_copies_private_aliases_once_and_preserves_holes_and_prot_none() {
        let (mut groups, mut storage, mut memory, parent) = running();
        let root = storage.descriptor(parent).unwrap();
        let original = pte(&memory, root.root, 0) & 0xffff0000;
        memory.write(original, b"parent").unwrap();
        memory
            .atomic_store(root.root + layout::ROOT_HEADER_BYTES, original)
            .unwrap();
        memory
            .atomic_store(root.root + layout::ROOT_HEADER_BYTES + 4, original | 1)
            .unwrap();
        memory.atomic_store(root.root, 3).unwrap();
        let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
        let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
        let before = storage
            .pool()
            .unwrap()
            .snapshot(&mut memory)
            .unwrap()
            .allocated_pages;
        assert_eq!(
            storage.prepare_private_fork(&mut memory, parent, epoch, child),
            Err(Errno::EAGAIN)
        );
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            before
        );
        memory
            .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        storage
            .prepare_private_fork(&mut memory, parent, epoch, child)
            .unwrap();
        let descriptor = storage.descriptor(child).unwrap();
        let copied = pte(&memory, descriptor.root, 0);
        assert_ne!(copied, original);
        assert_eq!(copied & 3, 0);
        assert_eq!(pte(&memory, descriptor.root, 1), copied | 1);
        assert_eq!(pte(&memory, descriptor.root, 2), 0);
        assert_eq!(memory.atomic_load(descriptor.root).unwrap(), 3);
        let mut bytes = [0; 6];
        memory.read(copied & 0xffff0000, &mut bytes).unwrap();
        assert_eq!(&bytes, b"parent");
        memory.write(copied & 0xffff0000, b"child!").unwrap();
        memory.read(original, &mut bytes).unwrap();
        assert_eq!(&bytes, b"parent");
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            before + 4
        );
        storage.cancel_unpublished(&mut memory, child).unwrap();
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            before
        );
    }

    #[test]
    fn inherited_shared_storage_keeps_one_physical_identity_and_exact_image_holds() {
        let (mut groups, mut storage, mut memory, parent) = running();
        let root = storage.descriptor(parent).unwrap();
        let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
        memory
            .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        let model =
            crate::memory::GroupSharedMapping::new(parent.record().group, 900, PAGE as usize)
                .unwrap();
        let change = Description {
            token: 900,
            receipt: parent.record(),
            effect: Effect::Map {
                addr: 4 * PAGE as usize,
                len: PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_SHARED | wasm_posix_shared::mmap::MAP_ANONYMOUS,
            },
            population_address: 0,
            population_length: 0,
            shared_object: 900,
            shared_length: u64::from(PAGE),
            shared_offset: 0,
        };
        storage
            .stage_mapping(&mut memory, parent, epoch, change, Some(&model))
            .unwrap();
        storage.publish_mapping(&mut memory, parent, 900).unwrap();
        model
            .install_physical(storage.mapping_binding(parent, 900).unwrap().unwrap())
            .unwrap();
        storage.finish_mapping(&mut memory, parent, 900).unwrap();
        let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
        storage
            .prepare_private_fork(&mut memory, parent, epoch, child)
            .unwrap();
        let child_root = storage.descriptor(child).unwrap().root;
        assert_eq!(pte(&memory, child_root, 4), pte(&memory, root.root, 4));
        assert_eq!(pte(&memory, child_root, 2), 0);
        assert_eq!(pte(&memory, child_root, 3), 0);
        let address = pte(&memory, child_root, 4) & 0xffff0000;
        memory.write(address, b"shared").unwrap();
        assert_eq!(storage.objects.get(&900).unwrap().images.len(), 2);
        storage.cancel_unpublished(&mut memory, child).unwrap();
        assert_eq!(storage.objects.get(&900).unwrap().images.len(), 1);
        let mut bytes = [0; 6];
        memory.read(address, &mut bytes).unwrap();
        assert_eq!(&bytes, b"shared");
    }
}
