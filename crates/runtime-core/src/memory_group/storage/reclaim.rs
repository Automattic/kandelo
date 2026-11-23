use super::*;
use crate::memory_group::wait_queue;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Reclaimed {
    pub released_pages: u32,
    pub retained_pages: u32,
}

#[cfg(test)]
mod tests {
    use super::super::lifecycle_tests::running;
    use super::*;
    use crate::{
        group_memory_change::{Description, Effect},
        memory_group::physical::tests::Memory,
    };
    fn unmap(
        storage: &mut Storage,
        memory: &mut Memory,
        admission: GroupAdmission,
        token: u64,
        page: u32,
    ) {
        let root = storage.descriptor(admission).unwrap();
        let epoch = storage.begin_image_pause(memory, admission).unwrap();
        memory
            .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        let change = Description {
            token,
            receipt: admission.record(),
            effect: Effect::Unmap {
                addr: (page * PAGE) as usize,
                len: PAGE as usize,
            },
            population_address: 0,
            population_length: 0,
            shared_object: 0,
            shared_length: 0,
            shared_offset: 0,
        };
        storage
            .stage_mapping(memory, admission, epoch, change, None)
            .unwrap();
        storage.publish_mapping(memory, admission, token).unwrap();
        storage.finish_mapping(memory, admission, token).unwrap();
        storage.resume_image(memory, admission, epoch).unwrap();
    }

    #[test]
    fn removed_frames_return_only_after_native_settlement_and_are_never_claimed_again_by_the_old_image(
    ) {
        let (_groups, mut storage, mut memory, admission) = running();
        let descriptor = storage.descriptor(admission).unwrap();
        let entry = memory
            .atomic_load(descriptor.root + layout::ROOT_HEADER_BYTES + 4)
            .unwrap();
        let old_page = entry >> 16;
        let pin = storage
            .pin_native_observation(&memory, admission, old_page * PAGE)
            .unwrap();
        unmap(&mut storage, &mut memory, admission, 1, 1);
        assert_eq!(
            storage
                .reclaim_removed_pages(&mut memory, admission)
                .unwrap(),
            Reclaimed {
                released_pages: 0,
                retained_pages: 1
            }
        );
        storage.settle_native_observation(admission, pin).unwrap();
        assert_eq!(
            storage
                .reclaim_removed_pages(&mut memory, admission)
                .unwrap(),
            Reclaimed {
                released_pages: 1,
                retained_pages: 0
            }
        );
        let reused = storage
            .pool()
            .unwrap()
            .allocate_contiguous(&mut memory, 1)
            .unwrap();
        assert_eq!(reused.first, old_page);
        memory.write(reused.address(), b"new owner").unwrap();
        assert_eq!(
            storage
                .reclaim_removed_pages(&mut memory, admission)
                .unwrap()
                .released_pages,
            0
        );
        storage.note_quiescent(&mut memory, admission).unwrap();
        storage.revoke_source(&mut memory, admission).unwrap();
        storage
            .release_stopped_image(&mut memory, admission)
            .unwrap();
        let mut bytes = [0; 9];
        memory.read(reused.address(), &mut bytes).unwrap();
        assert_eq!(&bytes, b"new owner");
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            2
        );
    }

    #[test]
    fn an_alias_keeps_its_frame_until_the_final_pte_is_removed() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        let aliased = memory
            .atomic_load(root + layout::ROOT_HEADER_BYTES + 4)
            .unwrap();
        memory
            .atomic_store(root + layout::ROOT_HEADER_BYTES + 8, aliased)
            .unwrap();
        memory.atomic_store(root, 3).unwrap();
        unmap(&mut storage, &mut memory, admission, 2, 1);
        assert_eq!(
            storage
                .reclaim_removed_pages(&mut memory, admission)
                .unwrap()
                .released_pages,
            0
        );
        assert_eq!(
            memory
                .atomic_load(root + layout::ROOT_HEADER_BYTES + 8)
                .unwrap(),
            aliased
        );
        unmap(&mut storage, &mut memory, admission, 3, 2);
        assert_eq!(
            storage
                .reclaim_removed_pages(&mut memory, admission)
                .unwrap()
                .released_pages,
            1
        );
    }
}

impl Storage {
    pub(crate) fn reclaim_removed_pages(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<Reclaimed, Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if !image.source_live || image.mapping.is_some() {
            return Err(Errno::EAGAIN);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let mut current = [false; layout::MAXIMUM_PAGES as usize];
        let mut pinned = [false; layout::MAXIMUM_PAGES as usize];
        let mut peer = [false; layout::MAXIMUM_PAGES as usize];
        let mut pages = IoBuffer::try_with_capacity(image.payload.len())?;
        let mut detach = IoBuffer::try_with_capacity(image.objects.len())?;
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let result = (|| {
            let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
            for at in 0..image.layout.maximum_pages {
                let entry = memory.atomic_load(root + layout::ROOT_HEADER_BYTES + at * 4)?;
                if entry == 0 {
                    continue;
                }
                let page = entry >> 16;
                if entry & 0xfffc != 0
                    || page == 0
                    || page >= self.maximum_pages
                    || page >= memory.current_pages()?
                {
                    return Err(Errno::EIO);
                }
                current[page as usize] = true;
            }
            // Controls cannot be candidates even if a damaged private-frame
            // record happens to name one. Refuse it instead of freeing it.
            let controls = image.allocation.ok_or(Errno::EIO)?.controls;
            for page in controls.first..controls.first + controls.pages {
                current[page as usize] = true;
            }
            for member in self.replicas.values().filter(|member| member.image == key) {
                let scratch = member.scratch.ok_or(Errno::EIO)?;
                for page in scratch.first..scratch.first + scratch.pages {
                    current[page as usize] = true;
                }
            }
            wait_queue::visit_pins(memory, |_, _, target| {
                if let Some(pin) = pinned.get_mut((target / PAGE) as usize) {
                    *pin = true;
                }
            })?;
            for pin in self.pins.values() {
                pinned[(pin.address / PAGE) as usize] = true;
            }
            for page in image.payload.iter().copied() {
                if !current[page as usize] && !pinned[page as usize] {
                    pages.push(page);
                }
            }
            pages.sort_unstable();
            for (other, _) in self.images.iter() {
                if *other == key {
                    continue;
                }
                peer.fill(false);
                self.image_pages(
                    memory,
                    *other,
                    &mut peer[..self.maximum_pages as usize],
                    false,
                )?;
                if pages.iter().any(|page| peer[*page as usize]) {
                    return Err(Errno::EIO);
                }
            }
            for id in image.objects.keys() {
                let object = self.objects.get(id).ok_or(Errno::EIO)?;
                let mut retained = false;
                for at in 0..object.pages.byte_length() / PAGE as usize {
                    let page = object.pages.page(at)? as usize;
                    retained |= current[page] || pinned[page];
                }
                if !retained {
                    detach.push(*id);
                }
            }
            if !pages.is_empty() {
                self.pool.as_mut().ok_or(Errno::EAGAIN)?.release_checked(
                    memory,
                    &pages,
                    |memory| {
                        let mut observed = false;
                        wait_queue::visit_pins(memory, |_, _, target| {
                            if pages.binary_search(&(target / PAGE)).is_ok() {
                                observed = true;
                            }
                        })?;
                        Ok(!observed)
                    },
                )?;
            }
            let image = self.images.get_mut(&key).unwrap();
            image
                .payload
                .retain(|page| pages.binary_search(page).is_err());
            for id in detach.iter() {
                image.objects.remove(id);
                self.objects
                    .get_mut(id)
                    .ok_or(Errno::EIO)?
                    .images
                    .remove(&key);
            }
            let retained_pages = image
                .payload
                .iter()
                .filter(|page| !current[**page as usize])
                .count() as u32;
            Ok(Reclaimed {
                released_pages: pages.len() as u32,
                retained_pages,
            })
        })();
        // The root itself was excluded from the candidate set and is still
        // owned here even after private frames become available to a peer.
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        result
    }
}
