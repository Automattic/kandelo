//! Exact pthread scratch retirement and control-slot reuse. The virtual slot
//! comes from MemoryManager; neither its address nor freed pages come from JS.
use super::*;
use crate::memory_group::wait_queue;

impl Storage {
    /// Only the kernel launch driver can prove that no Worker construction
    /// effect was issued. This is not a host-callable quiescence substitute.
    pub(crate) fn release_unstarted_thread(&mut self, memory: &mut impl PhysicalMemory,
        admission: GroupAdmission, address: u32, length: u32,
        release_control: impl FnOnce() -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        let member = self.owned(admission)?;
        if admission.record().pid == admission.record().tid || member.exposure == Exposure::Quarantined {
            return Err(Errno::EBUSY);
        }
        let key = member.image;
        let (_, _, control) = self.control(memory, admission)?;
        memory.atomic_store(control + layout::REPLICA_RUN, 0)?;
        self.replicas.get_mut(&admission.record().serial).unwrap().exposure = Exposure::Stopped;
        self.release_control_storage(memory, admission, address, length, true, release_control)?;
        self.images.get_mut(&key).ok_or(Errno::ESRCH)?.replicas.remove(&admission.record().serial);
        Ok(())
    }

    /// The ProcessTable MM supplies this exact task's reserved virtual slot.
    /// Preflight every private frame before the first store. No host allocator
    /// chooses the slot or charges a second pthread quota.
    pub(crate) fn initialize_thread_control(&self, memory: &mut impl PhysicalMemory,
        root: GroupAdmission, address: u32, length: u32,
    ) -> Result<(), Errno> {
        let key = self.owned(root)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if !image.source_live || !image.exposed || image.stopping || image.pause.is_some() {
            return Err(Errno::EAGAIN);
        }
        const PAGES: usize = wasm_posix_shared::process_memory::PAGES_PER_THREAD_SLOT as usize;
        if address % PAGE != 0 || length != PAGES as u32 * PAGE { return Err(Errno::EINVAL); }
        let table = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let extent = memory.atomic_load(table)?;
        if extent > image.layout.maximum_pages { return Err(Errno::EIO); }
        if u64::from(address) + u64::from(length) > u64::from(extent) * u64::from(PAGE) {
            return Err(Errno::EFAULT);
        }
        let physical_pages = memory.current_pages()?;
        let mut targets = [0u32; PAGES];
        for (index, virtual_page) in (address / PAGE..address / PAGE + PAGES as u32).enumerate() {
            let pte = memory.atomic_load(table + layout::ROOT_HEADER_BYTES + virtual_page * 4)?;
            let frame = pte >> 16;
            if pte & 3 != 3 || frame == 0 || frame >= physical_pages { return Err(Errno::EFAULT); }
            if !image.payload.contains(&frame) || targets[..index].contains(&frame) { return Err(Errno::EIO); }
            targets[index] = frame;
        }
        for frame in targets { memory.fill(frame * PAGE, PAGE, 0)?; }
        Ok(())
    }

    pub(crate) fn release_stopped_thread(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        control_address: u32,
        control_length: u32,
        release_control: impl FnOnce() -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if control_length == 0 { return Err(Errno::EINVAL); }
        let member = self.owned(admission)?;
        if admission.record().pid == admission.record().tid || member.exposure != Exposure::Stopped
        {
            return Err(Errno::EBUSY);
        }
        if matches!(member.references, References::Bound | References::Detaching) { return Err(Errno::EAGAIN); }
        if member.pending_wait_drain {
            self.request_stop(memory, admission)?;
        }
        self.release_control_storage(
            memory,
            admission,
            control_address,
            control_length,
            true,
            release_control,
        )
    }

    /// Once ProcessTable has discarded this exact image's MM, its virtual
    /// control slot cannot be rebound. Scratch still belongs to the stopped
    /// replica until its real native and SDK observations have settled.
    pub(crate) fn release_retired_image_thread(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        let member = self.owned(admission)?;
        if admission.record().pid == admission.record().tid || member.exposure != Exposure::Stopped {
            return Err(Errno::EBUSY);
        }
        if matches!(member.references, References::Bound | References::Detaching) { return Err(Errno::EAGAIN); }
        if member.pending_wait_drain {
            self.request_stop(memory, admission)?;
        }
        self.release_control_storage(memory, admission, 0, 0, true, || Ok(()))
    }

    pub(crate) fn release_unconstructed_control(
        &mut self,
        memory: &mut impl PhysicalMemory,
        image: GroupAdmission,
        address: u32,
        length: u32,
        release_control: impl FnOnce() -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if length == 0 { return Err(Errno::EINVAL); }
        self.release_control_storage(memory, image, address, length, false, release_control)
    }

    fn release_control_storage(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        address: u32,
        length: u32,
        return_scratch: bool,
        release_control: impl FnOnce() -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        let member = self.owned(admission)?;
        let image = self.images.get(&member.image).ok_or(Errno::ESRCH)?;
        if image.mapping.is_some() || return_scratch && self.task_has_operations(admission) {
            return Err(Errno::EAGAIN);
        }
        if length % PAGE != 0
            || address % PAGE != 0
            || u64::from(address) + u64::from(length)
                > u64::from(image.layout.maximum_pages) * u64::from(PAGE)
        {
            return Err(Errno::EINVAL);
        }
        let (_, root, control) = self.control(memory, admission)?;
        let mut targets = [false; layout::MAXIMUM_PAGES as usize];
        let scratch = member.scratch.ok_or(Errno::EIO)?;
        let mut allocation = IoBuffer::try_with_capacity(if return_scratch {
            scratch.pages as usize
        } else {
            0
        })?;
        if return_scratch {
            for page in scratch.first..scratch.first + scratch.pages {
                targets[page as usize] = true;
                allocation.push(page);
            }
            if memory.atomic_load(control + layout::REPLICA_WAIT_NODE)? != 0 {
                return Err(Errno::EAGAIN);
            }
        }
        let end = ((u64::from(address) + u64::from(length)) / u64::from(PAGE)) as u32;
        for at in address / PAGE..end {
            let entry = memory.atomic_load(root + layout::ROOT_HEADER_BYTES + at * 4)?;
            let page = entry >> 16;
            if entry & 0xffff != 3
                || page == 0
                || page >= self.maximum_pages
                || page >= memory.current_pages()?
            {
                return Err(Errno::EIO);
            }
            targets[page as usize] = true;
        }
        if self.pins.values().any(|pin| {
            targets[(pin.address / PAGE) as usize]
                || return_scratch && pin.serial == admission.record().serial
        }) {
            return Err(Errno::EAGAIN);
        }
        self.pool.as_mut().ok_or(Errno::EAGAIN)?.release_checked(
            memory,
            &allocation,
            |memory| {
                let mut pinned = false;
                wait_queue::visit_pins(memory, |wait_root, wait_replica, target| {
                    if targets.get((target / PAGE) as usize) == Some(&true)
                        || return_scratch && wait_root == root && wait_replica == control
                    {
                        pinned = true;
                    }
                })?;
                if pinned {
                    return Ok(false);
                }
                // Logical rebind authority is consumed under the same bitmap
                // fence, before any scratch bit can be reused by another task.
                release_control()?;
                Ok(true)
            },
        )?;
        if return_scratch {
            self.replicas.remove(&admission.record().serial);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::lifecycle_tests::running;
    use super::*;
    use crate::{
        group_memory_change::{Description, Effect},
        memory_group::{physical::tests::Memory, MemoryGroups},
    };
    const ADDRESS: u32 = 4 * PAGE;
    const LENGTH: u32 = 4 * PAGE;
    #[test]
    fn initialization_clears_virtual_controls_without_touching_a_permuted_neighbor() {
        let (_groups, storage, mut memory, root) = controls();
        let table = storage.descriptor(root).unwrap().root + layout::ROOT_HEADER_BYTES;
        for frame in storage.images.get(&storage.owned(root).unwrap().image).unwrap().payload.iter() {
            memory.fill(*frame * PAGE, PAGE, 0xa7).unwrap();
        }
        let neighbor = memory.atomic_load(table).unwrap();
        let first = memory.atomic_load(table + ADDRESS / PAGE * 4).unwrap();
        memory.atomic_store(table, first).unwrap();
        memory.atomic_store(table + ADDRESS / PAGE * 4, neighbor).unwrap();
        let pages = memory.current_pages().unwrap();
        storage.initialize_thread_control(&mut memory, root, ADDRESS, LENGTH).unwrap();
        assert_eq!(memory.current_pages().unwrap(), pages);
        let mut bytes = [0; 16];
        memory.read(first & 0xffff0000, &mut bytes).unwrap();
        assert_eq!(bytes, [0xa7; 16]);
        for page in ADDRESS / PAGE..(ADDRESS + LENGTH) / PAGE {
            let frame = memory.atomic_load(table + page * 4).unwrap() & 0xffff0000;
            memory.read(frame, &mut bytes).unwrap();
            assert_eq!(bytes, [0; 16]);
        }
    }

    #[test]
    fn initialization_preflights_the_last_page_before_clearing_any_control() {
        for corrupt in [1, 2] {
            let (_groups, storage, mut memory, root) = controls();
            let table = storage.descriptor(root).unwrap().root + layout::ROOT_HEADER_BYTES;
            let first = memory.atomic_load(table + ADDRESS / PAGE * 4).unwrap();
            let last = memory.atomic_load(table + ((ADDRESS + LENGTH) / PAGE - 1) * 4).unwrap();
            memory.fill(first & 0xffff0000, PAGE, 0xa7).unwrap();
            memory.atomic_store(table + ((ADDRESS + LENGTH) / PAGE - 1) * 4,
                if corrupt == 1 { last & !2 } else { first }).unwrap();
            assert_eq!(storage.initialize_thread_control(&mut memory, root, ADDRESS, LENGTH),
                Err(if corrupt == 1 { Errno::EFAULT } else { Errno::EIO }));
            let mut bytes = [0; 16];
            memory.read(first & 0xffff0000, &mut bytes).unwrap();
            assert_eq!(bytes, [0xa7; 16]);
        }
    }

    #[test]
    fn initialization_refuses_live_image_barriers_and_wrong_slot_extents() {
        let (_groups, mut storage, mut memory, root) = controls();
        assert_eq!(storage.initialize_thread_control(&mut memory, root, ADDRESS + 1, LENGTH), Err(Errno::EINVAL));
        assert_eq!(storage.initialize_thread_control(&mut memory, root, ADDRESS, LENGTH - PAGE), Err(Errno::EINVAL));
        assert_eq!(storage.initialize_thread_control(&mut memory, root, ADDRESS + LENGTH, LENGTH), Err(Errno::EFAULT));
        storage.begin_image_pause(&mut memory, root).unwrap();
        assert_eq!(storage.initialize_thread_control(&mut memory, root, ADDRESS, LENGTH), Err(Errno::EAGAIN));
    }

    fn controls() -> (MemoryGroups, Storage, Memory, GroupAdmission) {
        let (groups, mut storage, mut memory, root) = running();
        let descriptor = storage.descriptor(root).unwrap();
        let epoch = storage.begin_image_pause(&mut memory, root).unwrap();
        memory
            .atomic_store(descriptor.replica + layout::REPLICA_ACK, epoch)
            .unwrap();
        let change = Description {
            token: 1000,
            receipt: root.record(),
            effect: Effect::Map {
                addr: ADDRESS as usize,
                len: LENGTH as usize,
                prot: 3,
                flags: wasm_posix_shared::mmap::MAP_PRIVATE
                    | wasm_posix_shared::mmap::MAP_ANONYMOUS,
            },
            population_address: 0,
            population_length: 0,
            shared_object: 0,
            shared_length: 0,
            shared_offset: 0,
        };
        storage
            .stage_mapping(&mut memory, root, epoch, change, None)
            .unwrap();
        storage.publish_mapping(&mut memory, root, 1000).unwrap();
        storage.finish_mapping(&mut memory, root, 1000).unwrap();
        storage.resume_image(&mut memory, root, epoch).unwrap();
        (groups, storage, memory, root)
    }
    fn thread(
        groups: &mut MemoryGroups,
        storage: &mut Storage,
        memory: &mut Memory,
        root: GroupAdmission,
    ) -> GroupAdmission {
        let thread = groups.prepare_thread(root, 101).unwrap();
        storage.prepare_thread(memory, thread).unwrap();
        groups.start(thread).unwrap();
        storage.publish(thread).unwrap();
        thread
    }
    fn physical_control(storage: &Storage, memory: &Memory, root: GroupAdmission) -> u32 {
        let root = storage.descriptor(root).unwrap().root;
        memory
            .atomic_load(root + layout::ROOT_HEADER_BYTES + ADDRESS / PAGE * 4)
            .unwrap()
            & 0xffff0000
    }

    #[test]
    fn metadata_progress_keeps_its_exact_replica_receipt_until_settlement() {
        let (mut groups, mut storage, mut memory, root) = controls();
        let thread = thread(&mut groups, &mut storage, &mut memory, root);
        let progress = storage
            .prepare_progress(&memory, thread, super::super::ProgressTarget::Pool)
            .unwrap()
            .unwrap();
        storage.note_quiescent(&mut memory, thread).unwrap();
        assert_eq!(
            storage.release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || panic!(
                "metadata observer still owns this receipt"
            )),
            Err(Errno::EAGAIN)
        );
        storage
            .settle_native_observation(thread, progress.token)
            .unwrap();
        storage
            .release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || Ok(()))
            .unwrap();
        assert_eq!(storage.resolve(thread.record()), Err(Errno::ESRCH));
    }

    #[test]
    fn reaped_image_threads_return_only_scratch_after_exact_observers_settle() {
        let (mut groups, mut storage, mut memory, root) = controls();
        let thread = thread(&mut groups, &mut storage, &mut memory, root);
        let mapped = physical_control(&storage, &memory, root);
        let before = storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages;
        assert_eq!(storage.release_retired_image_thread(&mut memory, thread), Err(Errno::EBUSY));
        storage.note_quiescent(&mut memory, thread).unwrap();
        let progress = storage.prepare_progress(&memory, thread, super::super::ProgressTarget::Pool).unwrap().unwrap();
        assert_eq!(storage.release_retired_image_thread(&mut memory, thread), Err(Errno::EAGAIN));
        storage.settle_native_observation(thread, progress.token).unwrap();
        storage.release_retired_image_thread(&mut memory, thread).unwrap();
        assert_eq!(storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages, before - 2);
        assert_eq!(physical_control(&storage, &memory, root), mapped);
        assert_eq!(storage.release_retired_image_thread(&mut memory, thread), Err(Errno::ESRCH));
    }

    #[test]
    fn native_target_pins_block_reuse_after_worker_stop_until_actual_settlement() {
        let (mut groups, mut storage, mut memory, root) = controls();
        let thread = thread(&mut groups, &mut storage, &mut memory, root);
        let calls = core::cell::Cell::new(0);
        assert_eq!(
            storage.release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || {
                calls.set(calls.get() + 1);
                Ok(())
            }),
            Err(Errno::EBUSY)
        );
        storage.note_quiescent(&mut memory, thread).unwrap();
        let target = physical_control(&storage, &memory, root);
        let pin = storage
            .pin_native_observation(&memory, root, target)
            .unwrap();
        let before = storage
            .pool()
            .unwrap()
            .snapshot(&mut memory)
            .unwrap()
            .allocated_pages;
        assert_eq!(
            storage.release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || {
                calls.set(calls.get() + 1);
                Ok(())
            }),
            Err(Errno::EAGAIN)
        );
        assert_eq!(calls.get(), 0);
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            before
        );
        storage.settle_native_observation(root, pin).unwrap();
        storage
            .release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            before - 2
        );
        assert_eq!(storage.descriptor(thread), Err(Errno::ESRCH));
        assert_eq!(
            physical_control(&storage, &memory, root),
            target,
            "mapped control pages stay reserved for reuse"
        );
    }

    #[test]
    fn a_returning_peer_waiter_keeps_the_old_control_target_pinned() {
        let (mut groups, mut storage, mut memory, root) = controls();
        let thread = thread(&mut groups, &mut storage, &mut memory, root);
        storage.note_quiescent(&mut memory, thread).unwrap();
        let descriptor = storage.descriptor(root).unwrap();
        let target = physical_control(&storage, &memory, root);
        for (at, value) in [
            (layout::WAIT_HEADER + 16, 1),
            (layout::WAIT_NODES, layout::WAIT_STOPPED),
            (layout::WAIT_NODES + 8, target),
            (layout::WAIT_NODES + 12, descriptor.root),
            (layout::WAIT_NODES + 16, descriptor.replica),
            (
                descriptor.replica + layout::REPLICA_WAIT_NODE,
                layout::WAIT_NODES,
            ),
        ] {
            memory.atomic_store(at, value).unwrap();
        }
        let calls = core::cell::Cell::new(0);
        assert_eq!(
            storage.release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || {
                calls.set(1);
                Ok(())
            }),
            Err(Errno::EAGAIN)
        );
        assert_eq!(calls.get(), 0);
        memory
            .atomic_store(layout::WAIT_NODES, layout::WAIT_FREE)
            .unwrap();
        memory.atomic_store(layout::WAIT_HEADER + 16, 0).unwrap();
        memory
            .atomic_store(descriptor.replica + layout::REPLICA_WAIT_NODE, 0)
            .unwrap();
        storage
            .release_stopped_thread(&mut memory, thread, ADDRESS, LENGTH, || {
                calls.set(1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn unconstructed_rebind_refusal_leaves_mapped_storage_and_slot_authority_unchanged() {
        let (_groups, mut storage, mut memory, root) = controls();
        let before = storage.pool().unwrap().snapshot(&mut memory).unwrap();
        assert_eq!(
            storage.release_unconstructed_control(&mut memory, root, ADDRESS, LENGTH, || Err(
                Errno::EBUSY
            )),
            Err(Errno::EBUSY)
        );
        assert_eq!(
            storage.pool().unwrap().snapshot(&mut memory).unwrap(),
            before
        );
        storage
            .release_unconstructed_control(&mut memory, root, ADDRESS, LENGTH, || Ok(()))
            .unwrap();
        assert_eq!(
            storage.pool().unwrap().snapshot(&mut memory).unwrap(),
            before
        );
        assert_eq!(
            storage.release_unconstructed_control(
                &mut memory,
                root,
                ADDRESS + 1,
                LENGTH,
                || panic!("invalid interval reached logical rebind")
            ),
            Err(Errno::EINVAL)
        );
    }
}
