use super::*;
use crate::memory_group::wait_queue;

impl Storage {
    pub(super) fn image_pages(
        &self,
        memory: &impl PhysicalMemory,
        key: ImageKey,
        selected: &mut [bool],
        stable: bool,
    ) -> Result<(), Errno> {
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        let controls = image.allocation.ok_or(Errno::EIO)?.controls;
        let mut mark = |page: u32| -> Result<(), Errno> {
            if page == 0 || page as usize >= selected.len() || page >= memory.current_pages()? {
                return Err(Errno::EIO);
            }
            selected[page as usize] = true;
            Ok(())
        };
        for page in controls.first..controls.first + controls.pages {
            mark(page)?;
        }
        for page in image.payload.iter().copied() {
            mark(page)?;
        }
        let extent = memory.atomic_load(controls.address())?;
        // A corrupted guest header cannot redefine the layout whose frames
        // this Rust owner is about to return to the shared allocator.
        if extent > image.layout.maximum_pages
            || memory.atomic_load(controls.address() + 4)? != image.layout.maximum_pages
            || memory.atomic_load(controls.address() + 8)? != image.layout.scratch_bytes
        {
            return Err(Errno::EIO);
        }
        super::super::physical::visit_nonzero(memory,
            controls.address() + layout::ROOT_HEADER_BYTES, image.layout.maximum_pages, |at, entry| {
                if entry & 0xfffc != 0 || stable && at >= extent { return Err(Errno::EIO); }
                mark(entry >> 16)
            })?;
        for (_, replica) in self.replicas.iter() {
            if replica.image != key {
                continue;
            }
            let extent = replica.scratch.ok_or(Errno::EIO)?;
            for page in extent.first..extent.first + extent.pages {
                mark(page)?;
            }
        }
        Ok(())
    }

    /// No page set comes from TypeScript. The kernel derives the complete set
    /// from its frame records and stable PTEs, then checks every remaining pin.
    pub(crate) fn release_stopped_image(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<u32, Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if self.poisoned
            || image.source_live
            || !image.exposed
            || image.pause.is_some()
            || image.mapping.is_some()
            || self.image_has_operations(key)
            || self.replicas.values().any(|replica| replica.image == key && replica.pending_completions != 0)
            || self.pins.values().any(|pin| pin.image == key)
            || self
                .replicas
                .values()
                .any(|replica| replica.image == key && (replica.exposure != Exposure::Stopped
                    || matches!(replica.references, References::Bound | References::Detaching)))
        {
            return Err(Errno::EAGAIN);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        // Admit scratch before acquiring guest-shared locks. If memory is
        // tight, retaining the owner is safer than dropping its allocation.
        let mut owned = IoBuffer::try_filled(self.maximum_pages as usize, false)?;
        let mut peer = IoBuffer::try_filled(self.maximum_pages as usize, false)?;
        let mut pages = IoBuffer::try_with_capacity(self.maximum_pages as usize)?;
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let prepared = (|| {
            self.image_pages(memory, key, &mut owned, true)?;
            for (id, _) in self.images.get(&key).unwrap().objects.iter() {
                let object = self.objects.get(id).ok_or(Errno::EIO)?;
                if !object.images.contains_key(&key) || !object.committed {
                    return Err(Errno::EIO);
                }
                for at in 0..object.pages.byte_length() / PAGE as usize {
                    let page = object.pages.page(at)?;
                    if self.images.get(&key).unwrap().payload.contains(&page) {
                        return Err(Errno::EIO);
                    }
                    owned[page as usize] = false;
                }
            }

            for (other, _) in self.images.iter() {
                if *other == key {
                    continue;
                }
                peer.fill(false);
                self.image_pages(memory, *other, &mut peer, false)?;
                // Shared pages stay with their object owner. The remaining
                // private/control set must not overlap any peer image.
                if owned.iter().zip(peer.iter()).any(|(a, b)| *a && *b) {
                    return Err(Errno::EIO);
                }
            }
            let mut pinned = false;
            wait_queue::visit_pins(memory, |wait_root, _, address| {
                if wait_root == root || owned.get((address / PAGE) as usize) == Some(&true) {
                    pinned = true;
                }
            })?;
            if pinned
                || self
                    .pins
                    .values()
                    .any(|pin| owned.get((pin.address / PAGE) as usize) == Some(&true))
            {
                return Err(Errno::EAGAIN);
            }
            for (page, used) in owned.iter().enumerate() {
                if *used {
                    pages.push(page as u32);
                }
            }
            Ok(())
        })();
        // Never unlock after freeing the root: another allocator may already
        // own and have initialized the same physical page.
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        prepared?;
        self.pool()?.release_checked(memory, &pages, |memory| {
            // A queue lock becoming busy is a retry, never retirement proof.
            let mut pinned = false;
            // The generic adapter below keeps this scan within the same
            // pool transaction without exporting any release-page authority.
            wait_queue::visit_pins(memory, |wait_root, _, address| {
                if wait_root == root || owned.get((address / PAGE) as usize) == Some(&true) {
                    pinned = true;
                }
            })?;
            Ok(!pinned)
        })?;
        self.replicas.retain(|_, member| member.image != key);
        for (id, _) in self.images.get(&key).unwrap().objects.iter() {
            self.objects
                .get_mut(id)
                .ok_or(Errno::EIO)?
                .images
                .remove(&key);
        }
        self.images.remove(&key);
        Ok(pages.len() as u32)
    }
}
