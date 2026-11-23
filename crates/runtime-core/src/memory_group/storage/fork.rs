//! Fork selects/copies private frames in the kernel. Pointers stay virtual;
//! shared objects retain the same physical pages and their exact ownership.
use super::*;

impl Storage {
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
        let mut entries = IoBuffer::try_filled(image.layout.maximum_pages as usize, 0)?;
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
            let mut private_count = 0;
            for at in 0..original.layout.maximum_pages {
                let entry = memory.atomic_load(root + layout::ROOT_HEADER_BYTES + at * 4)?;
                entries[at as usize] = entry;
                if entry == 0 {
                    continue;
                }
                let physical = entry >> 16;
                if entry & 0xfffc != 0
                    || physical == 0
                    || physical >= memory.current_pages()?
                    || physical >= self.maximum_pages
                    || at >= extent
                {
                    return Err(Errno::EIO);
                }
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
            }
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
                for (at, entry) in entries.iter().copied().enumerate().take(extent as usize) {
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
