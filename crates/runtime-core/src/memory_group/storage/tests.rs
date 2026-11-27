use super::*;
use crate::memory_group::{physical::tests::Memory, MemoryGroupLimits, MemoryGroups};

pub(super) fn running() -> (MemoryGroups, Storage, Memory, GroupAdmission) {
    let mut groups = MemoryGroups::new();
    groups.configure(32, 1).unwrap();
    let group = groups
        .create(MemoryGroupLimits {
            maximum_pages: 32,
            maximum_processes: 8,
            maximum_tasks: 16,
        })
        .unwrap();
    let mut storage = Storage::prepare(groups.retain_backing(group).unwrap(), 32).unwrap();
    let mut memory = Memory::new(32);
    storage.initialize(&mut memory).unwrap();
    let admission = groups.prepare_image(group, 100, 1).unwrap();
    storage
        .prepare_image(
            &mut memory,
            admission,
            ImageLayout {
                initial_pages: 2,
                maximum_pages: 32,
                scratch_bytes: PAGE,
            },
        )
        .unwrap();
    groups.start(admission).unwrap();
    storage.publish(admission).unwrap();
    (groups, storage, memory, admission)
}

#[test]
fn terminal_fence_does_not_authorize_worker_reference_disposal() {
    let (_groups, mut storage, mut memory, admission) = running();
    storage.bind_platform_references(admission, true).unwrap();
    storage.note_quiescent(&mut memory, admission).unwrap();
    assert_eq!(storage.begin_reference_detachment(admission), Err(Errno::EBUSY));
    assert_eq!(storage.complete_reference_detachment(admission), Err(Errno::EBUSY));
}

#[test]
fn containment_requires_an_issued_effect_and_the_exact_native_join_capability() {
    for joins in [false, true] {
        let (_groups, mut storage, mut memory, admission) = running();
        storage.bind_platform_references(admission, joins).unwrap();
        assert_eq!(storage.begin_worker_containment(admission), Err(Errno::EBUSY));
        assert_eq!(storage.complete_worker_containment(admission, joins), Err(Errno::EBUSY));
        storage.note_quiescent(&mut memory, admission).unwrap();
        let before = storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages;
        assert!(storage.begin_worker_containment(admission).unwrap());
        assert_eq!(storage.complete_worker_containment(admission, !joins), Err(if joins { Errno::EBUSY } else { Errno::EINVAL }));
        assert_eq!(storage.begin_reference_detachment(admission), Err(Errno::EBUSY));
        storage.revoke_source(&mut memory, admission).unwrap();
        assert_eq!(storage.release_stopped_image(&mut memory, admission), Err(Errno::EAGAIN));
        assert_eq!(storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages, before);
        storage.complete_worker_containment(admission, joins).unwrap();
        assert_eq!(storage.complete_worker_containment(admission, joins), Err(Errno::EBUSY));
        assert!(!storage.begin_worker_containment(admission).unwrap());
        assert!(storage.begin_reference_detachment(admission).unwrap());
        storage.complete_reference_detachment(admission).unwrap();
        storage.release_stopped_image(&mut memory, admission).unwrap();
        assert_eq!(storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages, 1);
    }
}

#[test]
fn native_stop_fact_keeps_an_issued_containment_acknowledgement_outstanding() {
    use wasm_posix_shared::retirement_control::command as C;
    for fact in [C::NATIVE_JOIN, C::SEALED_ABSENCE] {
        let (_groups, mut storage, mut memory, root) = running();
        storage.bind_platform_references(root, true).unwrap();
        storage.note_quiescent(&mut memory, root).unwrap();
        assert!(storage.begin_worker_containment(root).unwrap());
        storage.record_worker_fact(root, fact);
        // The native fact is true, but the already-issued native operation
        // must acknowledge before its objects and receipt can be discarded.
        assert_eq!(storage.begin_reference_detachment(root), Err(Errno::EBUSY));
        storage.complete_worker_containment(root, fact == C::NATIVE_JOIN).unwrap();
        assert!(storage.begin_reference_detachment(root).unwrap());
        assert_eq!(storage.complete_worker_containment(root, fact == C::NATIVE_JOIN), Err(Errno::EBUSY));
    }
}

#[test]
fn uncertain_thread_contains_the_entire_exact_image_without_returning_pages() {
    let (mut groups, mut storage, mut memory, root) = running();
    let thread = groups.prepare_thread(root, 101).unwrap();
    storage.prepare_thread(&mut memory, thread).unwrap();
    groups.start(thread).unwrap();
    storage.publish(thread).unwrap();
    let descriptors = [storage.descriptor(root).unwrap(), storage.descriptor(thread).unwrap()];
    let before = storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages;
    storage.quarantine_image(&mut memory, thread).unwrap();
    let snapshot = storage.snapshot(&mut memory).unwrap();
    assert_eq!(snapshot[1..3], [1, 2]);
    assert_eq!(snapshot[4], 2);
    assert_eq!(snapshot[5], before);
    for (admission, descriptor) in [root, thread].into_iter().zip(descriptors) {
        assert_eq!(storage.descriptor(admission), Err(Errno::EIO));
        assert_eq!(memory.atomic_load(descriptor.replica + layout::REPLICA_RUN).unwrap(), 0);
        assert_eq!(storage.pin_native_observation(&memory, admission, descriptor.replica), Err(Errno::ESRCH));
    }
    assert_eq!(storage.release_stopped_image(&mut memory, root), Err(Errno::EAGAIN));
    assert_eq!(storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages, before);
}

#[test]
fn uncertain_bitmap_publication_forbids_any_later_physical_control_write() {
    let (_groups, mut storage, mut memory, admission) = running();
    let root = storage.descriptor(admission).unwrap().root;
    storage.note_quiescent(&mut memory, admission).unwrap();
    storage.revoke_source(&mut memory, admission).unwrap();
    memory.fail_bitmap_writes(true);
    assert_eq!(
        storage.release_stopped_image(&mut memory, admission),
        Err(Errno::EIO)
    );
    memory.fail_bitmap_writes(false);
    // These words could belong to a new allocator owner after an uncertain
    // bitmap write. The stale image must never touch them again.
    memory.atomic_store(root + layout::ROOT_RUN, 99).unwrap();
    memory
        .atomic_store(root + layout::ROOT_GROW_LOCK, 77)
        .unwrap();
    assert_eq!(
        storage.revoke_source(&mut memory, admission),
        Err(Errno::EIO)
    );
    assert_eq!(
        storage.release_stopped_image(&mut memory, admission),
        Err(Errno::EIO)
    );
    assert_eq!(memory.atomic_load(root + layout::ROOT_RUN).unwrap(), 99);
    assert_eq!(
        memory.atomic_load(root + layout::ROOT_GROW_LOCK).unwrap(),
        77
    );
}

#[test]
fn native_settlement_is_distinct_from_stop_and_worker_quiescence() {
    let (_groups, mut storage, mut memory, admission) = running();
    let descriptor = storage.descriptor(admission).unwrap();
    let pin = storage
        .pin_native_observation(&memory, admission, descriptor.replica + layout::REPLICA_ACK)
        .unwrap();
    let before = storage.pool().unwrap().snapshot(&mut memory).unwrap();
    storage
        .request_image_stop(&mut memory, admission, None)
        .unwrap();
    assert_eq!(
        storage.release_stopped_image(&mut memory, admission),
        Err(Errno::EAGAIN)
    );
    storage.note_quiescent(&mut memory, admission).unwrap();
    storage.revoke_source(&mut memory, admission).unwrap();
    assert_eq!(
        storage.release_stopped_image(&mut memory, admission),
        Err(Errno::EAGAIN)
    );
    assert_eq!(
        storage.pool().unwrap().snapshot(&mut memory).unwrap(),
        before
    );
    storage.settle_native_observation(admission, pin).unwrap();
    assert_eq!(
        storage.settle_native_observation(admission, pin),
        Err(Errno::ESRCH)
    );
    assert_eq!(
        storage
            .release_stopped_image(&mut memory, admission)
            .unwrap(),
        before.allocated_pages - 1
    );
    assert!(storage.empty());
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

#[test]
fn prepared_members_prevent_partial_barriers_and_new_members_cannot_join_a_pause() {
    let (mut groups, mut storage, mut memory, admission) = running();
    let thread = groups.prepare_thread(admission, 101).unwrap();
    storage.prepare_thread(&mut memory, thread).unwrap();
    let root = storage.descriptor(admission).unwrap();
    assert_eq!(
        storage.begin_image_pause(&mut memory, admission),
        Err(Errno::EBUSY)
    );
    assert_eq!(
        memory
            .atomic_load(root.replica + layout::REPLICA_REQUEST)
            .unwrap(),
        0
    );
    storage.cancel_unpublished(&mut memory, thread).unwrap();
    groups.cancel_unconstructed(thread).unwrap();
    let epoch = storage.begin_image_pause(&mut memory, admission).unwrap();
    let thread = groups.prepare_thread(admission, 102).unwrap();
    assert_eq!(
        storage.prepare_thread(&mut memory, thread),
        Err(Errno::ESRCH)
    );
    assert!(!storage
        .image_pause_acknowledged(&mut memory, admission, epoch)
        .unwrap());
    memory
        .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
        .unwrap();
    assert!(storage
        .image_pause_acknowledged(&mut memory, admission, epoch)
        .unwrap());
    storage.resume_image(&mut memory, admission, epoch).unwrap();
    storage.prepare_thread(&mut memory, thread).unwrap();
}

#[test]
fn stale_barriers_cannot_resume_new_epochs_or_a_stopping_image() {
    let (_groups, mut storage, mut memory, admission) = running();
    let first = storage.begin_image_pause(&mut memory, admission).unwrap();
    storage.resume_image(&mut memory, admission, first).unwrap();
    let second = storage.begin_image_pause(&mut memory, admission).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        storage.resume_image(&mut memory, admission, first),
        Err(Errno::ESRCH)
    );
    storage
        .request_image_stop(&mut memory, admission, None)
        .unwrap();
    assert!(!storage
        .image_pause_acknowledged(&mut memory, admission, second)
        .unwrap());
    assert_eq!(
        storage.resume_image(&mut memory, admission, second),
        Err(Errno::ESRCH)
    );
    assert_eq!(
        storage.begin_image_pause(&mut memory, admission),
        Err(Errno::EBUSY)
    );
}

#[test]
fn queue_pins_and_contention_keep_retired_image_pages_charged() {
    let (_groups, mut storage, mut memory, admission) = running();
    let descriptor = storage.descriptor(admission).unwrap();
    storage.note_quiescent(&mut memory, admission).unwrap();
    storage.revoke_source(&mut memory, admission).unwrap();
    memory.atomic_store(layout::WAIT_HEADER, 1).unwrap();
    assert_eq!(
        storage.release_stopped_image(&mut memory, admission),
        Err(Errno::EAGAIN)
    );
    memory.atomic_store(layout::WAIT_HEADER, 0).unwrap();
    // An unlinked STOPPED node still belongs to a returning native waiter.
    memory.atomic_store(layout::WAIT_HEADER + 16, 1).unwrap();
    memory
        .atomic_store(layout::WAIT_NODES, layout::WAIT_STOPPED)
        .unwrap();
    memory
        .atomic_store(layout::WAIT_NODES + 8, descriptor.root)
        .unwrap();
    memory
        .atomic_store(layout::WAIT_NODES + 12, descriptor.root)
        .unwrap();
    assert_eq!(
        storage.release_stopped_image(&mut memory, admission),
        Err(Errno::EAGAIN)
    );
    memory
        .atomic_store(layout::WAIT_NODES, layout::WAIT_FREE)
        .unwrap();
    memory.atomic_store(layout::WAIT_HEADER + 16, 0).unwrap();
    storage
        .release_stopped_image(&mut memory, admission)
        .unwrap();
}


#[test]
fn stopped_storage_remains_owned_until_exact_platform_reference_acknowledgement() {
    let (_groups, mut storage, mut memory, root) = running();
    storage.bind_platform_references(root, false).unwrap();
    assert_eq!(storage.bind_platform_references(root, false), Err(Errno::EBUSY));
    assert_eq!(storage.begin_reference_detachment(root), Err(Errno::EBUSY));
    assert_eq!(storage.complete_reference_detachment(root), Err(Errno::EBUSY));
    storage.request_image_stop(&mut memory, root, None).unwrap();
    storage.note_quiescent(&mut memory, root).unwrap();
    storage.revoke_source(&mut memory, root).unwrap();
    let before = storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages;
    assert_eq!(storage.pending_platform_references(root, true).unwrap(), Some(root.record()));
    assert_eq!(storage.release_stopped_image(&mut memory, root), Err(Errno::EAGAIN));
    assert!(storage.begin_worker_containment(root).unwrap());
    storage.complete_worker_containment(root, false).unwrap();
    assert!(storage.begin_reference_detachment(root).unwrap());
    assert!(storage.begin_reference_detachment(root).unwrap());
    assert_eq!(storage.release_stopped_image(&mut memory, root), Err(Errno::EAGAIN));
    assert_eq!(storage.pool().unwrap().snapshot(&mut memory).unwrap().allocated_pages, before);
    storage.complete_reference_detachment(root).unwrap();
    assert_eq!(storage.complete_reference_detachment(root), Err(Errno::EBUSY));
    assert!(!storage.begin_reference_detachment(root).unwrap());
    assert_eq!(storage.pending_platform_references(root, true).unwrap(), None);
    storage.release_stopped_image(&mut memory, root).unwrap();
}
#[test]
fn image_owner_selects_every_bound_pthread_before_allowing_detachment() {
    let (mut groups, mut storage, mut memory, root) = running();
    let thread = groups.prepare_thread(root, 101).unwrap();
    storage.prepare_thread(&mut memory, thread).unwrap();
    groups.start(thread).unwrap(); storage.publish(thread).unwrap();
    storage.bind_platform_references(root, false).unwrap();
    storage.bind_platform_references(thread, false).unwrap();
    storage.request_image_stop(&mut memory, root, None).unwrap();
    storage.note_quiescent(&mut memory, root).unwrap();
    storage.note_quiescent(&mut memory, thread).unwrap();
    assert_eq!(storage.release_retired_image_thread(&mut memory, thread), Err(Errno::EAGAIN));
    let first = storage.pending_platform_references(root, true).unwrap().unwrap();
    let admission = storage.resolve(first).unwrap();
    assert!(storage.begin_worker_containment(admission).unwrap());
    storage.complete_worker_containment(admission, false).unwrap();
    storage.begin_reference_detachment(admission).unwrap();
    storage.complete_reference_detachment(admission).unwrap();
    let second = storage.pending_platform_references(root, true).unwrap().unwrap();
    assert_ne!(first, second);
    let admission = storage.resolve(second).unwrap();
    assert!(storage.begin_worker_containment(admission).unwrap());
    storage.complete_worker_containment(admission, false).unwrap();
    storage.begin_reference_detachment(admission).unwrap();
    storage.complete_reference_detachment(admission).unwrap();
    assert_eq!(storage.pending_platform_references(root, true).unwrap(), None);
}

/// Device I/O translates guest ranges to backing extents and pins frames
/// until the device retires the work. Reclaim and retirement must honor
/// those pins exactly as they honor native observation pins.
mod device_io {
    use super::super::reclaim::{tests::unmap, Reclaimed};
    use super::*;
    use wasm_posix_shared::kgpu::Extent as DeviceExtent;

    const TABLE: u32 = layout::ROOT_HEADER_BYTES;

    /// Point a virtual page at a frame, growing the backing to hold it:
    /// translation refuses frames beyond the backing's current size.
    fn map(memory: &mut Memory, root: u32, page: u32, pte: u32) {
        let current = memory.current_pages().unwrap();
        if pte >> 16 >= current {
            memory.grow((pte >> 16) + 1 - current).unwrap();
        }
        memory.atomic_store(root + TABLE + page * 4, pte).unwrap();
    }

    fn extent(frame: u32, at: u32, len: u32) -> DeviceExtent {
        DeviceExtent { offset: u64::from(frame * PAGE + at), len, pad: 0 }
    }

    fn allocated(storage: &mut Storage, memory: &mut Memory) -> u32 {
        storage.pool().unwrap().snapshot(memory).unwrap().allocated_pages
    }

    #[test]
    fn device_extents_single_page() {
        let (_groups, storage, memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let root = storage.descriptor(admission).unwrap().root;
        let frame = memory.atomic_load(root + TABLE + 4).unwrap() >> 16;
        assert_eq!(
            storage.device_extents(&memory, image, u64::from(PAGE + 100), 200, true),
            Ok(vec![extent(frame, 100, 200)])
        );
        assert_eq!(
            storage.device_extents(&memory, image, u64::from(PAGE + 100), 0, true),
            Ok(vec![])
        );
    }

    #[test]
    fn device_extents_merges_adjacent_frames() {
        let (_groups, storage, mut memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let root = storage.descriptor(admission).unwrap().root;
        map(&mut memory, root, 0, 5 << 16 | 3);
        map(&mut memory, root, 1, 6 << 16 | 3);
        assert_eq!(
            storage.device_extents(&memory, image, 100, PAGE + 100, false),
            Ok(vec![extent(5, 100, PAGE + 100)])
        );
    }

    #[test]
    fn device_extents_splits_discontiguous_frames() {
        let (_groups, storage, mut memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let root = storage.descriptor(admission).unwrap().root;
        map(&mut memory, root, 0, 5 << 16 | 3);
        map(&mut memory, root, 1, 9 << 16 | 3);
        assert_eq!(
            storage.device_extents(&memory, image, 100, PAGE + 100, true),
            Ok(vec![extent(5, 100, PAGE - 100), extent(9, 0, 200)])
        );
    }

    #[test]
    fn device_extents_unmapped_is_efault() {
        let (_groups, storage, mut memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let root = storage.descriptor(admission).unwrap().root;
        // Beyond the image's current extent of two pages.
        assert_eq!(
            storage.device_extents(&memory, image, u64::from(2 * PAGE), 4, false),
            Err(Errno::EFAULT)
        );
        // A range that starts mapped and runs past the extent.
        assert_eq!(
            storage.device_extents(&memory, image, u64::from(PAGE), PAGE + 1, false),
            Err(Errno::EFAULT)
        );
        assert_eq!(
            storage.device_extents(&memory, image, u64::MAX - 1, 4, false),
            Err(Errno::EFAULT)
        );
        map(&mut memory, root, 1, 0);
        assert_eq!(
            storage.device_extents(&memory, image, 0, PAGE + 4, false),
            Err(Errno::EFAULT)
        );
    }

    #[test]
    fn device_extents_write_to_readonly_is_efault() {
        let (_groups, storage, mut memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let root = storage.descriptor(admission).unwrap().root;
        map(&mut memory, root, 0, 5 << 16 | 1);
        assert_eq!(
            storage.device_extents(&memory, image, 8, 16, false),
            Ok(vec![extent(5, 8, 16)])
        );
        assert_eq!(
            storage.device_extents(&memory, image, 8, 16, true),
            Err(Errno::EFAULT)
        );
    }

    #[test]
    fn device_pin_rejects_extents_outside_the_backing() {
        let (_groups, mut storage, _memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        for bad in [
            DeviceExtent { pad: 1, ..extent(5, 0, 4) },
            extent(5, 0, 0),
            extent(0, 0, 4),
            extent(31, PAGE - 4, 8),
        ] {
            assert_eq!(storage.device_pin(image, &[bad]), Err(Errno::EINVAL));
        }
        assert_eq!(storage.device_pinned_frames(), 0);
    }

    #[test]
    fn pinned_frames_survive_reclaim() {
        let (_groups, mut storage, mut memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let extents = storage
            .device_extents(&memory, image, u64::from(PAGE), PAGE, false)
            .unwrap();
        let old_page = (extents[0].offset / u64::from(PAGE)) as u32;
        let pin = storage.device_pin(image, &extents).unwrap();
        assert_eq!(storage.device_pinned_frames(), 1);
        unmap(&mut storage, &mut memory, admission, 1, 1);
        assert_eq!(
            storage.reclaim_removed_pages(&mut memory, admission).unwrap(),
            Reclaimed { released_pages: 0, retained_pages: 1 }
        );
        let other = storage.pool().unwrap().allocate_contiguous(&mut memory, 1).unwrap();
        assert_ne!(other.first, old_page);
        storage.device_unpin(pin);
        // Releasing an id that no longer exists is a no-op.
        storage.device_unpin(pin);
        assert_eq!(storage.device_pinned_frames(), 0);
        assert_eq!(
            storage.reclaim_removed_pages(&mut memory, admission).unwrap(),
            Reclaimed { released_pages: 1, retained_pages: 0 }
        );
        let reused = storage.pool().unwrap().allocate_contiguous(&mut memory, 1).unwrap();
        assert_eq!(reused.first, old_page);
    }

    #[test]
    fn retirement_waits_for_device_pins() {
        let (_groups, mut storage, mut memory, admission) = running();
        let image = storage.owned(admission).unwrap().image;
        let extents = storage
            .device_extents(&memory, image, 0, 2 * PAGE, true)
            .unwrap();
        let pin = storage.device_pin(image, &extents).unwrap();
        storage.note_quiescent(&mut memory, admission).unwrap();
        storage.revoke_source(&mut memory, admission).unwrap();
        let before = allocated(&mut storage, &mut memory);
        assert_eq!(
            storage.release_stopped_image(&mut memory, admission),
            Err(Errno::EAGAIN)
        );
        assert_eq!(allocated(&mut storage, &mut memory), before);
        storage.device_unpin(pin);
        storage.release_stopped_image(&mut memory, admission).unwrap();
        assert_eq!(allocated(&mut storage, &mut memory), 1);
        assert!(storage.empty());
    }
}
