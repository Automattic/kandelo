//! Physical half of the Rust VM transaction. Its description comes directly
//! from the kernel's logical plan, never from a host reconstruction of mmap.
use super::*;
use crate::{
    group_memory_change::{Description, Effect},
    IoBox,
};

pub(super) struct Mapping {
    description: Description,
    epoch: u32,
    old_extent: u32,
    new_extent: u32,
    before: IoBuffer<u32>,
    after: IoBuffer<u32>,
    allocated: IoBuffer<u32>,
    published: bool,
    holds_root_lock: bool,
    object: Option<super::shared::ObjectHold>,
}
const FRESH: u32 = 0xffff0000;

impl Mapping {
    pub(super) fn staging_bytes(&self) -> usize {
        (self.before.len() + self.after.len() + self.allocated.len()) * 4
    }
}

impl Storage {
    pub(crate) fn cancel_mapping_if_present(&mut self, memory: &mut impl PhysicalMemory,
        admission: GroupAdmission, token: u64,
    ) -> Result<(), Errno> {
        let image = self.images.get(&self.owned(admission)?.image).ok_or(Errno::ESRCH)?;
        if image.mapping.is_none() { return Ok(()); }
        self.cancel_mapping(memory, admission, token)
    }
    pub(crate) fn stage_mapping(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        epoch: u32,
        description: Description,
        model: Option<&crate::memory::GroupSharedMapping>,
    ) -> Result<(), Errno> {
        if description.receipt != admission.record() || description.token == 0 {
            return Err(Errno::ESRCH);
        }
        if !self.image_pause_acknowledged(memory, admission, epoch)? {
            return Err(Errno::EAGAIN);
        }
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if image.mapping.is_some() {
            return Err(Errno::EBUSY);
        }
        let object = if let Some(model) = model {
            if description.shared_object != model.id()
                || description.shared_length != model.length() as u64
                || description.shared_offset % u64::from(PAGE) != 0
            {
                return Err(Errno::EIO);
            }
            let length = match description.effect {
                Effect::Map { len, .. } => len,
                Effect::Remap { new_len, .. } => new_len,
                _ => return Err(Errno::EINVAL),
            };
            if description
                .shared_offset
                .checked_add(length as u64)
                .is_none_or(|end| end > description.shared_length)
            {
                return Err(Errno::EINVAL);
            }
            Some(self.prepare_object(key, model)?)
        } else {
            if description.shared_object != 0
                || description.shared_length != 0
                || description.shared_offset != 0
            {
                return Err(Errno::EIO);
            }
            None
        };
        let introduced = object
            .as_ref()
            .is_some_and(|object| !object.pages.allocated());
        if introduced
            && (!matches!(description.effect, Effect::Map { .. })
                || description.shared_object != description.token)
            || description.population_length != 0
                && object.is_some()
                && (!introduced
                    || description.population_address != 0
                    || description.population_length as u64 != description.shared_length)
        {
            return Err(Errno::EINVAL);
        }
        let maximum = image.layout.maximum_pages;
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let mut mapping = IoBox::try_new(Mapping {
            description,
            epoch,
            old_extent: 0,
            new_extent: 0,
            before: IoBuffer::try_filled(maximum as usize, 0)?,
            after: IoBuffer::try_filled(maximum as usize, 0)?,
            allocated: IoBuffer::new(),
            published: false,
            holds_root_lock: false,
            object: None,
        })?;
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let prepared = (|| {
            if !self.image_pause_acknowledged(memory, admission, epoch)? {
                return Err(Errno::EAGAIN);
            }
            mapping.old_extent = memory.atomic_load(root)?;
            if mapping.old_extent > maximum || memory.atomic_load(root + 4)? != maximum {
                return Err(Errno::EIO);
            }
            mapping.new_extent = mapping.old_extent;
            read_table(memory, root, &mut mapping.before)?;
            for (at, entry) in mapping.before.iter().copied().enumerate() {
                if entry == 0 {
                    continue;
                }
                if entry & 0xfffc != 0
                    || entry >> 16 == 0
                    || at >= mapping.old_extent as usize
                    || entry >> 16 >= memory.current_pages()?
                    || entry >> 16 >= self.maximum_pages
                {
                    return Err(Errno::EIO);
                }
            }
            let Mapping { before, after, .. } = &mut *mapping;
            after.copy_from_slice(before);
            mapping.apply(maximum, object.as_ref().map(|object| &*object.pages))?;
            let fresh = if introduced {
                0
            } else {
                mapping
                    .after
                    .iter()
                    .filter(|entry| **entry & 0xffff0000 == FRESH)
                    .count()
            };
            mapping.allocated = IoBuffer::try_filled(fresh, 0)?;
            // Every private frame is already retained by the kernel allocator.
            // A page table cannot mint custody by naming an unowned frame.
            let image = self.images.get(&key).unwrap();
            let mut custody = [false; layout::MAXIMUM_PAGES as usize];
            for page in image.payload.iter().copied() { custody[page as usize] = true; }
            for id in image.objects.keys() {
                let object = self.objects.get(id).ok_or(Errno::EIO)?;
                for at in 0..object.pages.byte_length() / PAGE as usize {
                    custody[object.pages.page(at)? as usize] = true;
                }
            }
            if mapping.before.iter().any(|entry| *entry >> 16 != 0 && !custody[(*entry >> 16) as usize]) {
                return Err(Errno::EIO);
            }
            self.images.get_mut(&key).unwrap().payload.try_reserve_exact(fresh)?;
            Ok(())
        })();
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        prepared?;
        // Register custody before the physical reservation. An uncertain
        // allocator failure leaves this exact owner available for containment.
        if let Some(object) = object {
            mapping.object = Some(self.publish_object(key, object));
        }
        self.images.get_mut(&key).unwrap().mapping = Some(mapping);
        let result = if introduced {
            let pages = self.object_pages(description.shared_object)?.clone();
            pages.allocate_memory(self.pool.as_mut().ok_or(Errno::EAGAIN)?, memory)
        } else {
            let (pool, images) = (&mut self.pool, &mut self.images);
            let pending = images.get_mut(&key).unwrap().mapping.as_mut().unwrap();
            if pending.allocated.is_empty() {
                Ok(())
            } else {
                pool.as_mut()
                    .ok_or(Errno::EAGAIN)?
                    .allocate_pages(memory, &mut pending.allocated)
            }
        };
        if let Err(error) = result {
            if error == Errno::EIO {
                self.contain_image(memory, key);
            } else {
                if let Some(hold) = self
                    .images
                    .get(&key)
                    .unwrap()
                    .mapping
                    .as_ref()
                    .unwrap()
                    .object
                {
                    self.detach_object(key, hold);
                }
                self.images.get_mut(&key).unwrap().mapping = None;
            }
            return Err(error);
        }
        let shared_pages = if description.shared_object != 0 {
            Some(self.object_pages(description.shared_object)?.clone())
        } else {
            None
        };
        let pending = self.images.get_mut(&key).unwrap().mapping.as_mut().unwrap();
        if let Some(pages) = shared_pages {
            if let Effect::Map {
                addr, len, prot, ..
            } = description.effect
            {
                let offset = (description.shared_offset / u64::from(PAGE)) as usize;
                for at in 0..len / PAGE as usize {
                    pending.after[addr / PAGE as usize + at] =
                        pages.page(offset + at)? * PAGE | (prot & 3);
                }
            }
            return Ok(());
        }
        let Mapping {
            after, allocated, ..
        } = &mut **pending;
        let mut next = 0;
        for entry in after.iter_mut() {
            if *entry & 0xffff0000 == FRESH {
                *entry = allocated[next] * PAGE | (*entry & 3);
                next += 1;
            }
        }
        Ok(())
    }

    pub(crate) fn populate_mapping(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        token: u64,
        offset: u64,
        input: &[u8],
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        let mapping = image.mapping.as_ref().ok_or(Errno::ESRCH)?;
        if mapping.description.token != token
            || mapping.published
            || !self.image_pause_acknowledged(memory, admission, mapping.epoch)?
        {
            return Err(Errno::ESRCH);
        }
        let length = mapping.description.population_length as u64;
        if offset > length || input.len() as u64 > length - offset {
            return Err(Errno::EINVAL);
        }
        if let Some(hold) = mapping.object.filter(|hold| hold.introduced) {
            if mapping.description.population_address != 0
                || length != mapping.description.shared_length
            {
                return Err(Errno::EIO);
            }
            let pages = self.object_pages(hold.id)?;
            let mut copied = 0;
            while copied < input.len() {
                let logical = offset + copied as u64;
                let within = (logical % u64::from(PAGE)) as u32;
                let count = (input.len() - copied).min((PAGE - within) as usize);
                memory.write(
                    pages.page((logical / u64::from(PAGE)) as usize)? * PAGE + within,
                    &input[copied..copied + count],
                )?;
                copied += count;
            }
            return Ok(());
        }
        let base = mapping.description.population_address as u64 + offset;
        let mut copied = 0;
        while copied < input.len() {
            let logical = base + copied as u64;
            let physical = *mapping
                .after
                .get((logical / u64::from(PAGE)) as usize)
                .ok_or(Errno::EIO)?
                >> 16;
            if mapping.allocated.binary_search(&physical).is_err() {
                return Err(Errno::EIO);
            }
            let within = (logical % u64::from(PAGE)) as u32;
            let count = (input.len() - copied).min((PAGE - within) as usize);
            memory.write(physical * PAGE + within, &input[copied..copied + count])?;
            copied += count;
        }
        Ok(())
    }

    pub(crate) fn publish_mapping(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        token: u64,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        let mapping = image.mapping.as_ref().ok_or(Errno::ESRCH)?;
        if mapping.description.token != token
            || mapping.published
            || !self.image_pause_acknowledged(memory, admission, mapping.epoch)?
        {
            return Err(Errno::ESRCH);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        if memory.atomic_compare_exchange(root + layout::ROOT_GROW_LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let mapping = self.images.get_mut(&key).unwrap().mapping.as_mut().unwrap();
        mapping.holds_root_lock = true;
        let result = (|| {
            if memory.atomic_load(root)? != mapping.old_extent {
                return Err(Errno::ESRCH);
            }
            let mut observed = 0;
            super::super::physical::visit_nonzero(memory, root + layout::ROOT_HEADER_BYTES,
                mapping.before.len() as u32, |at, entry| {
                    if mapping.before[at as usize] != entry { return Err(Errno::ESRCH); }
                    observed += 1;
                    Ok(())
                })?;
            if observed != mapping.before.iter().filter(|entry| **entry != 0).count() {
                return Err(Errno::ESRCH);
            }
            // Mark before the first write, so a foreign failure cannot grant
            // unpublished rollback over a partially published page table.
            mapping.published = true;
            write_table(memory, root, &mapping.after)?;
            memory.atomic_store(root, mapping.new_extent)
        })();
        if result.is_err() {
            memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
            memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
            self.images
                .get_mut(&key)
                .unwrap()
                .mapping
                .as_mut()
                .unwrap()
                .holds_root_lock = false;
            if result.as_ref().is_err_and(|error| *error != Errno::ESRCH) {
                self.contain_image(memory, key);
            }
        }
        // The same synchronous kernel entry performs the logical commit and
        // either finish or rollback before returning this shared root lock.
        result
    }

    /// Called synchronously after the logical kernel commit, with replicas
    /// still paused. All metadata capacity was admitted during preparation.
    pub(crate) fn finish_mapping(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        token: u64,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get_mut(&key).ok_or(Errno::ESRCH)?;
        let pending = image.mapping.as_ref().ok_or(Errno::ESRCH)?;
        if pending.description.token != token || !pending.published || !pending.holds_root_lock {
            return Err(Errno::ESRCH);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        let pending = image.mapping.take().unwrap();
        image.payload.extend_from_slice(&pending.allocated);
        if let Some(hold) = pending.object {
            self.objects.get_mut(&hold.id).unwrap().committed = true;
        }
        Ok(())
    }

    pub(crate) fn mapping_binding(
        &self,
        admission: GroupAdmission,
        token: u64,
    ) -> Result<Option<IoArc<SharedPages>>, Errno> {
        let key = self.owned(admission)?.image;
        let pending = self
            .images
            .get(&key)
            .ok_or(Errno::ESRCH)?
            .mapping
            .as_ref()
            .ok_or(Errno::ESRCH)?;
        if pending.description.token != token {
            return Err(Errno::ESRCH);
        }
        pending
            .object
            .filter(|hold| hold.introduced)
            .map(|hold| self.object_pages(hold.id).cloned())
            .transpose()
    }

    pub(crate) fn rollback_mapping(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        token: u64,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        let pending = image.mapping.as_ref().ok_or(Errno::ESRCH)?;
        if pending.description.token != token
            || !pending.published
            || !pending.holds_root_lock
            || !self.image_pause_acknowledged(memory, admission, pending.epoch)?
        {
            return Err(Errno::ESRCH);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        if memory.atomic_load(root + layout::ROOT_GROW_LOCK)? != 1 {
            return Err(Errno::EIO);
        }
        let result = (|| {
            if memory.atomic_load(root)? != pending.new_extent {
                return Err(Errno::EIO);
            }
            for (at, entry) in pending.after.iter().enumerate() {
                if memory.atomic_load(root + layout::ROOT_HEADER_BYTES + at as u32 * 4)? != *entry {
                    return Err(Errno::EIO);
                }
            }
            write_table(memory, root, &pending.before)?;
            memory.atomic_store(root, pending.old_extent)
        })();
        memory.atomic_store(root + layout::ROOT_GROW_LOCK, 0)?;
        memory.atomic_notify(root + layout::ROOT_GROW_LOCK, 1)?;
        if let Err(error) = result {
            self.contain_image(memory, key);
            return Err(error);
        }
        let pending = self.images.get_mut(&key).unwrap().mapping.as_mut().unwrap();
        pending.published = false;
        pending.holds_root_lock = false;
        Ok(())
    }

    pub(crate) fn cancel_mapping(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        token: u64,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        let pending = image.mapping.as_ref().ok_or(Errno::ESRCH)?;
        if pending.description.token != token || pending.published || self.poisoned {
            return Err(Errno::EBUSY);
        }
        let hold = pending.object;
        if !pending.allocated.is_empty() {
            self.pool.as_mut().ok_or(Errno::EAGAIN)?.release_checked(
                memory,
                &pending.allocated,
                |_| Ok(true),
            )?;
        }
        if let Some(hold) = hold.filter(|hold| hold.introduced) {
            let pages = self.object_pages(hold.id)?.clone();
            pages.retire_memory(self.pool.as_mut().ok_or(Errno::EAGAIN)?, memory, |_| {
                Ok(true)
            })?;
        }
        if let Some(hold) = hold {
            self.detach_object(key, hold);
        }
        self.images.get_mut(&key).unwrap().mapping = None;
        Ok(())
    }
}

impl Mapping {
    fn apply(&mut self, maximum: u32, shared: Option<&SharedPages>) -> Result<(), Errno> {
        let interval = |address: usize, length: usize| -> Result<(usize, usize), Errno> {
            if address % PAGE as usize != 0
                || length % PAGE as usize != 0
                || (address as u64)
                    .checked_add(length as u64)
                    .is_none_or(|end| end > u64::from(maximum) * u64::from(PAGE))
            {
                return Err(Errno::EINVAL);
            }
            Ok((address / PAGE as usize, length / PAGE as usize))
        };
        match self.description.effect {
            Effect::Map {
                addr,
                len,
                prot,
                flags,
            } => {
                if (flags & wasm_posix_shared::mmap::MAP_SHARED != 0) != shared.is_some() {
                    return Err(Errno::EIO);
                }
                let (start, count) = interval(addr, len)?;
                if count == 0 {
                    return Err(Errno::EINVAL);
                }
                if let Some(pages) = shared.filter(|pages| pages.allocated()) {
                    let offset = (self.description.shared_offset / u64::from(PAGE)) as usize;
                    for at in 0..count {
                        self.after[start + at] = pages.page(offset + at)? * PAGE | (prot & 3);
                    }
                } else {
                    self.after[start..start + count].fill(FRESH | (prot & 3));
                }
                self.new_extent = self.new_extent.max((start + count) as u32);
            }
            Effect::Unmap { addr, len } => {
                let (start, count) = interval(addr, len)?;
                self.after[start..start + count].fill(0);
            }
            Effect::Protect { addr, len, prot } => {
                let (start, count) = interval(addr, len)?;
                for at in start..start + count {
                    if self.before[at] >> 16 == 0 {
                        return Err(Errno::EIO);
                    }
                    self.after[at] = self.before[at] & 0xffff0000 | (prot & 3);
                }
            }
            Effect::Remap {
                old_addr,
                old_len,
                new_addr,
                new_len,
                prot,
            } => {
                let (old, old_count) = interval(old_addr, old_len)?;
                let (new, new_count) = interval(new_addr, new_len)?;
                if old_count == 0
                    || new_count == 0
                    || self.before[old..old + old_count]
                        .iter()
                        .any(|entry| *entry >> 16 == 0)
                {
                    return Err(Errno::EIO);
                }
                self.after[old..old + old_count].fill(0);
                let offset = (self.description.shared_offset / u64::from(PAGE)) as usize;
                if let Some(pages) = shared {
                    for at in 0..old_count {
                        if self.before[old + at] >> 16 != pages.page(offset + at)? {
                            return Err(Errno::EIO);
                        }
                    }
                }
                for at in 0..new_count {
                    self.after[new + at] = if at < old_count {
                        self.before[old + at]
                    } else if let Some(pages) = shared {
                        pages.page(offset + at)? * PAGE | (prot & 3)
                    } else {
                        FRESH | (prot & 3)
                    };
                }
                self.new_extent = self.new_extent.max((new + new_count) as u32);
            }
            Effect::Break { old, new } => {
                if old as u64 > u64::from(self.old_extent) * u64::from(PAGE)
                    || new as u64 > u64::from(maximum) * u64::from(PAGE)
                {
                    return Err(Errno::EINVAL);
                }
                let low = old.min(new).div_ceil(PAGE as usize);
                let high = old.max(new).div_ceil(PAGE as usize);
                if new < old {
                    self.after[low..high].fill(0);
                } else {
                    for at in low..high {
                        if self.after[at] >> 16 == 0 {
                            self.after[at] = FRESH | 3;
                        }
                    }
                }
                self.new_extent = self.new_extent.max(new.div_ceil(PAGE as usize) as u32);
            }
        }
        Ok(())
    }
}

fn read_table(memory: &impl PhysicalMemory, root: u32, output: &mut [u32]) -> Result<(), Errno> {
    let mut bytes = [0; 4096];
    for (chunk, entries) in output.chunks_mut(1024).enumerate() {
        memory.read(
            root + layout::ROOT_HEADER_BYTES + (chunk * 4096) as u32,
            &mut bytes[..entries.len() * 4],
        )?;
        for (entry, bytes) in entries.iter_mut().zip(bytes.chunks_exact(4)) {
            *entry = u32::from_le_bytes(bytes.try_into().unwrap());
        }
    }
    Ok(())
}
fn write_table(memory: &mut impl PhysicalMemory, root: u32, input: &[u32]) -> Result<(), Errno> {
    let mut bytes = [0; 4096];
    for (chunk, entries) in input.chunks(1024).enumerate() {
        for (at, entry) in entries.iter().enumerate() {
            bytes[at * 4..at * 4 + 4].copy_from_slice(&entry.to_le_bytes());
        }
        memory.write(
            root + layout::ROOT_HEADER_BYTES + (chunk * 4096) as u32,
            &bytes[..entries.len() * 4],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_group::{physical::tests::Memory, storage::lifecycle_tests::running};
    fn description(admission: GroupAdmission, token: u64, effect: Effect) -> Description {
        Description {
            token,
            receipt: admission.record(),
            effect,
            population_address: 0,
            population_length: 0,
            shared_object: 0,
            shared_length: 0,
            shared_offset: 0,
        }
    }
    fn pause(storage: &mut Storage, memory: &mut Memory, admission: GroupAdmission) -> u32 {
        let epoch = storage.begin_image_pause(memory, admission).unwrap();
        let descriptor = storage.descriptor(admission).unwrap();
        memory
            .atomic_store(descriptor.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        epoch
    }
    fn pte(memory: &Memory, root: u32, virtual_page: u32) -> u32 {
        memory
            .atomic_load(root + layout::ROOT_HEADER_BYTES + virtual_page * 4)
            .unwrap()
    }

    #[test]
    fn sparse_publication_rejects_missing_changed_and_new_tail_entries() {
        for (at, replacement) in [(1, 0), (1, 0xffff0003), (2064, 0xffff0003)] {
            let (_groups, mut storage, mut memory, admission) = super::super::contract_tests::image(2065);
            let root = storage.descriptor(admission).unwrap().root;
            let epoch = pause(&mut storage, &mut memory, admission);
            let change = description(admission, 99, Effect::Protect {
                addr: PAGE as usize, len: PAGE as usize, prot: 1,
            });
            storage.stage_mapping(&mut memory, admission, epoch, change, None).unwrap();
            memory.atomic_store(root + layout::ROOT_HEADER_BYTES + at * 4, replacement).unwrap();
            assert_eq!(storage.publish_mapping(&mut memory, admission, 99), Err(Errno::ESRCH));
            assert_eq!(memory.atomic_load(root + layout::ROOT_GROW_LOCK).unwrap(), 0);
        }
    }

    #[test]
    fn removing_a_kernel_grown_private_page_preserves_its_custody_until_reclamation() {
        let (_groups, mut storage, mut memory, admission) = running();
        assert_eq!(storage.grow_private(&mut memory, admission, 1), Ok(2));
        let epoch = pause(&mut storage, &mut memory, admission);
        let change = description(
            admission,
            777,
            Effect::Unmap {
                addr: 2 * PAGE as usize,
                len: PAGE as usize,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, change, None)
            .unwrap();
        storage
            .publish_mapping(&mut memory, admission, 777)
            .unwrap();
        storage.finish_mapping(&mut memory, admission, 777).unwrap();
        storage.resume_image(&mut memory, admission, epoch).unwrap();
        storage.note_quiescent(&mut memory, admission).unwrap();
        storage.revoke_source(&mut memory, admission).unwrap();
        storage
            .release_stopped_image(&mut memory, admission)
            .unwrap();
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            1
        );
    }
    fn shared_change(
        admission: GroupAdmission,
        token: u64,
        id: u64,
        pages: u64,
        offset: u64,
        effect: Effect,
    ) -> Description {
        let mut value = description(admission, token, effect);
        value.shared_object = id;
        value.shared_length = pages * u64::from(PAGE);
        value.shared_offset = offset * u64::from(PAGE);
        value
    }

    #[test]
    fn a_first_suffix_and_later_prefix_alias_share_the_complete_kernel_object() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        let epoch = pause(&mut storage, &mut memory, admission);
        let model = crate::memory::GroupSharedMapping::new(
            admission.record().group,
            100,
            3 * PAGE as usize,
        )
        .unwrap();
        let mut first = shared_change(
            admission,
            100,
            100,
            3,
            1,
            Effect::Map {
                addr: 4 * PAGE as usize,
                len: PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_SHARED,
            },
        );
        first.population_length = 3 * PAGE as usize;
        storage
            .stage_mapping(&mut memory, admission, epoch, first, Some(&model))
            .unwrap();
        storage
            .populate_mapping(&mut memory, admission, 100, 0, b"head")
            .unwrap();
        storage
            .populate_mapping(&mut memory, admission, 100, u64::from(PAGE), b"suffix")
            .unwrap();
        storage
            .publish_mapping(&mut memory, admission, 100)
            .unwrap();
        model
            .install_physical(storage.mapping_binding(admission, 100).unwrap().unwrap())
            .unwrap();
        storage.finish_mapping(&mut memory, admission, 100).unwrap();
        let allocated = storage
            .pool()
            .unwrap()
            .snapshot(&mut memory)
            .unwrap()
            .allocated_pages;
        let alias = shared_change(
            admission,
            101,
            100,
            3,
            0,
            Effect::Map {
                addr: 6 * PAGE as usize,
                len: PAGE as usize,
                prot: 1,
                flags: wasm_posix_shared::mmap::MAP_SHARED,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, alias, Some(&model))
            .unwrap();
        assert!(storage.mapping_binding(admission, 101).unwrap().is_none());
        storage
            .publish_mapping(&mut memory, admission, 101)
            .unwrap();
        storage.finish_mapping(&mut memory, admission, 101).unwrap();
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            allocated
        );
        let binding = model.physical().unwrap();
        assert_eq!(pte(&memory, root, 4) >> 16, binding.page(1).unwrap());
        assert_eq!(pte(&memory, root, 6) >> 16, binding.page(0).unwrap());
        let mut bytes = [0; 4];
        memory
            .read(binding.page(0).unwrap() * PAGE, &mut bytes)
            .unwrap();
        assert_eq!(&bytes, b"head");
        let wrong = crate::memory::GroupSharedMapping::new(
            admission.record().group,
            999,
            3 * PAGE as usize,
        )
        .unwrap();
        assert_eq!(wrong.install_physical(binding), Err(Errno::EINVAL));
        assert!(
            model.only_inode_hold(),
            "physical storage records must not retain the logical model object"
        );
    }

    #[test]
    fn cancelling_a_fresh_object_returns_its_whole_allocation_without_a_binding() {
        let (_groups, mut storage, mut memory, admission) = running();
        let epoch = pause(&mut storage, &mut memory, admission);
        let before = storage
            .pool()
            .unwrap()
            .snapshot(&mut memory)
            .unwrap()
            .allocated_pages;
        let model = crate::memory::GroupSharedMapping::new(
            admission.record().group,
            200,
            3 * PAGE as usize,
        )
        .unwrap();
        let first = shared_change(
            admission,
            200,
            200,
            3,
            1,
            Effect::Map {
                addr: 4 * PAGE as usize,
                len: PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_SHARED,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, first, Some(&model))
            .unwrap();
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            before + 3
        );
        storage.cancel_mapping(&mut memory, admission, 200).unwrap();
        assert!(storage.objects.is_empty());
        assert!(model.physical().is_err());
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
    fn an_inode_binding_keeps_shared_bytes_charged_after_the_last_image() {
        let (_groups, mut storage, mut memory, admission) = running();
        let epoch = pause(&mut storage, &mut memory, admission);
        let model =
            crate::memory::GroupSharedMapping::new(admission.record().group, 300, PAGE as usize)
                .unwrap();
        let first = shared_change(
            admission,
            300,
            300,
            1,
            0,
            Effect::Map {
                addr: 4 * PAGE as usize,
                len: PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_SHARED,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, first, Some(&model))
            .unwrap();
        storage
            .publish_mapping(&mut memory, admission, 300)
            .unwrap();
        model
            .install_physical(storage.mapping_binding(admission, 300).unwrap().unwrap())
            .unwrap();
        storage.finish_mapping(&mut memory, admission, 300).unwrap();
        storage.resume_image(&mut memory, admission, epoch).unwrap();
        storage
            .request_image_stop(&mut memory, admission, None)
            .unwrap();
        storage.note_quiescent(&mut memory, admission).unwrap();
        storage.revoke_source(&mut memory, admission).unwrap();
        storage
            .release_stopped_image(&mut memory, admission)
            .unwrap();
        assert!(!storage.empty());
        assert_eq!(storage.sweep_objects(&mut memory).unwrap(), 0);
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            2
        );
        drop(model);
        assert_eq!(storage.sweep_objects(&mut memory).unwrap(), 1);
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            1
        );
        assert!(storage.empty());
    }

    #[test]
    fn shared_remap_growth_uses_the_existing_object_offset() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        let epoch = pause(&mut storage, &mut memory, admission);
        let model = crate::memory::GroupSharedMapping::new(
            admission.record().group,
            400,
            3 * PAGE as usize,
        )
        .unwrap();
        let first = shared_change(
            admission,
            400,
            400,
            3,
            1,
            Effect::Map {
                addr: 4 * PAGE as usize,
                len: PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_SHARED,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, first, Some(&model))
            .unwrap();
        storage
            .publish_mapping(&mut memory, admission, 400)
            .unwrap();
        model
            .install_physical(storage.mapping_binding(admission, 400).unwrap().unwrap())
            .unwrap();
        storage.finish_mapping(&mut memory, admission, 400).unwrap();
        let count = storage
            .pool()
            .unwrap()
            .snapshot(&mut memory)
            .unwrap()
            .allocated_pages;
        let remap = shared_change(
            admission,
            401,
            400,
            3,
            1,
            Effect::Remap {
                old_addr: 4 * PAGE as usize,
                old_len: PAGE as usize,
                new_addr: 7 * PAGE as usize,
                new_len: 2 * PAGE as usize,
                prot: 3,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, remap, Some(&model))
            .unwrap();
        storage
            .publish_mapping(&mut memory, admission, 401)
            .unwrap();
        storage.finish_mapping(&mut memory, admission, 401).unwrap();
        assert_eq!(pte(&memory, root, 4), 0);
        assert_eq!(
            pte(&memory, root, 7) >> 16,
            model.physical().unwrap().page(1).unwrap()
        );
        assert_eq!(
            pte(&memory, root, 8) >> 16,
            model.physical().unwrap().page(2).unwrap()
        );
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            count
        );
    }
    #[test]
    fn population_touches_only_fresh_unpublished_pages_before_exact_commit() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        let epoch = pause(&mut storage, &mut memory, admission);
        let mut change = description(
            admission,
            1,
            Effect::Map {
                addr: 4 * PAGE as usize,
                len: 2 * PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_PRIVATE,
            },
        );
        change.population_address = 4 * PAGE as usize;
        change.population_length = 2 * PAGE as usize;
        storage
            .stage_mapping(&mut memory, admission, epoch, change, None)
            .unwrap();
        assert_eq!(pte(&memory, root, 4), 0);
        storage
            .populate_mapping(&mut memory, admission, 1, 0, b"populated")
            .unwrap();
        assert_eq!(
            storage.populate_mapping(&mut memory, admission, 1, 2 * u64::from(PAGE), b"x"),
            Err(Errno::EINVAL)
        );
        storage.publish_mapping(&mut memory, admission, 1).unwrap();
        assert_eq!(
            memory.atomic_load(root + layout::ROOT_GROW_LOCK).unwrap(),
            1
        );
        assert_eq!(
            storage.resume_image(&mut memory, admission, epoch),
            Err(Errno::EBUSY)
        );
        let physical = pte(&memory, root, 4) >> 16;
        let mut output = [0; 9];
        memory.read(physical * PAGE, &mut output).unwrap();
        assert_eq!(&output, b"populated");
        assert_eq!(memory.atomic_load(root).unwrap(), 6);
        assert_eq!(
            storage.cancel_mapping(&mut memory, admission, 1),
            Err(Errno::EBUSY)
        );
        storage.finish_mapping(&mut memory, admission, 1).unwrap();
        assert_eq!(
            memory.atomic_load(root + layout::ROOT_GROW_LOCK).unwrap(),
            0
        );
        storage.resume_image(&mut memory, admission, epoch).unwrap();
        assert_eq!(
            storage.finish_mapping(&mut memory, admission, 1),
            Err(Errno::ESRCH)
        );
    }
    #[test]
    fn refusal_restores_the_old_table_before_unpublished_pages_return() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        let before = storage
            .pool()
            .unwrap()
            .snapshot(&mut memory)
            .unwrap()
            .allocated_pages;
        let epoch = pause(&mut storage, &mut memory, admission);
        let change = description(
            admission,
            9,
            Effect::Map {
                addr: 4 * PAGE as usize,
                len: PAGE as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_PRIVATE,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, change, None)
            .unwrap();
        storage.publish_mapping(&mut memory, admission, 9).unwrap();
        assert_ne!(pte(&memory, root, 4), 0);
        storage.rollback_mapping(&mut memory, admission, 9).unwrap();
        assert_eq!(
            memory.atomic_load(root + layout::ROOT_GROW_LOCK).unwrap(),
            0
        );
        assert_eq!(pte(&memory, root, 4), 0);
        assert_eq!(memory.atomic_load(root).unwrap(), 2);
        storage.cancel_mapping(&mut memory, admission, 9).unwrap();
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
    fn protection_and_remap_preserve_physical_identity_and_private_contents() {
        let (_groups, mut storage, mut memory, admission) = running();
        let root = storage.descriptor(admission).unwrap().root;
        let original = pte(&memory, root, 1);
        memory.write((original >> 16) * PAGE, b"same").unwrap();
        let epoch = pause(&mut storage, &mut memory, admission);
        let change = description(
            admission,
            11,
            Effect::Protect {
                addr: PAGE as usize,
                len: PAGE as usize,
                prot: 0,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, change, None)
            .unwrap();
        storage.publish_mapping(&mut memory, admission, 11).unwrap();
        storage.finish_mapping(&mut memory, admission, 11).unwrap();
        assert_eq!(pte(&memory, root, 1), original & 0xffff0000);
        let change = description(
            admission,
            12,
            Effect::Remap {
                old_addr: PAGE as usize,
                old_len: PAGE as usize,
                new_addr: 4 * PAGE as usize,
                new_len: 2 * PAGE as usize,
                prot: 0,
            },
        );
        storage
            .stage_mapping(&mut memory, admission, epoch, change, None)
            .unwrap();
        storage.publish_mapping(&mut memory, admission, 12).unwrap();
        storage.finish_mapping(&mut memory, admission, 12).unwrap();
        assert_eq!(pte(&memory, root, 1), 0);
        assert_eq!(pte(&memory, root, 4), original & 0xffff0000);
        assert_ne!(pte(&memory, root, 5) >> 16, 0);
        let mut bytes = [0; 4];
        memory
            .read((pte(&memory, root, 4) >> 16) * PAGE, &mut bytes)
            .unwrap();
        assert_eq!(&bytes, b"same");
    }
}
