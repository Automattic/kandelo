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
    storage.begin_reference_detachment(admission).unwrap();
    storage.complete_reference_detachment(admission).unwrap();
    let second = storage.pending_platform_references(root, true).unwrap().unwrap();
    assert_ne!(first, second);
    let admission = storage.resolve(second).unwrap();
    storage.begin_reference_detachment(admission).unwrap();
    storage.complete_reference_detachment(admission).unwrap();
    assert_eq!(storage.pending_platform_references(root, true).unwrap(), None);
}
