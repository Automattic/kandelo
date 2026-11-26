//! Ports of the retired host policy's corruption, capacity and heap contracts.
use super::*;
use crate::group_memory_change::{Description, Effect};
use crate::memory_group::{physical::tests::Memory, MemoryGroupLimits, MemoryGroups};

pub(super) fn image(maximum_virtual_pages: u32) -> (MemoryGroups, Storage, Memory, GroupAdmission) {
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
    let root = groups.prepare_image(group, 100, 1).unwrap();
    storage
        .prepare_image(
            &mut memory,
            root,
            ImageLayout {
                initial_pages: 2,
                maximum_pages: maximum_virtual_pages,
                scratch_bytes: PAGE,
            },
        )
        .unwrap();
    groups.start(root).unwrap();
    storage.publish(root).unwrap();
    (groups, storage, memory, root)
}

#[test]
fn a_peer_scan_refreshes_the_backing_extent_for_newly_visible_frames() {
    let (_groups, storage, memory, root) = image(32);
    let descriptor = storage.descriptor(root).unwrap();
    let key = storage.owned(root).unwrap().image;
    let payload = memory.atomic_load(descriptor.root + layout::ROOT_HEADER_BYTES).unwrap() >> 16;
    let first_extent = descriptor.root / PAGE + 1;
    assert!(payload >= first_extent);
    // Model a grow between the first extent read and a later frame observation.
    memory.next_reported_pages.set(Some(first_extent));
    let mut selected = [false; 32];
    storage.image_pages(&memory, key, &mut selected, false).unwrap();
    assert!(selected[payload as usize]);
}

#[test]
fn corrupt_root_limits_cannot_authorize_retirement() {
    for offset in [4, 8] {
        let (_groups, mut storage, mut memory, root) = image(32);
        let descriptor = storage.descriptor(root).unwrap();
        let saved = memory.atomic_load(descriptor.root + offset).unwrap();
        storage.note_quiescent(&mut memory, root).unwrap();
        storage.revoke_source(&mut memory, root).unwrap();
        let before = storage.snapshot(&mut memory).unwrap()[5];
        memory
            .atomic_store(descriptor.root + offset, saved + 1)
            .unwrap();
        assert_eq!(
            storage.release_stopped_image(&mut memory, root),
            Err(Errno::EIO)
        );
        assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
        memory
            .atomic_store(descriptor.root + offset, saved)
            .unwrap();
        storage.release_stopped_image(&mut memory, root).unwrap();
        assert_eq!(storage.snapshot(&mut memory).unwrap()[5], 1);
    }
}

#[test]
fn epoch_exhaustion_refuses_without_wrapping_or_requesting_another_checkpoint() {
    let (_groups, mut storage, mut memory, root) = image(32);
    let descriptor = storage.descriptor(root).unwrap();
    storage.next_epoch = u64::from(u32::MAX);
    let epoch = storage.begin_image_pause(&mut memory, root).unwrap();
    assert_eq!(epoch, u32::MAX);
    memory
        .atomic_store(descriptor.replica + layout::REPLICA_ACK, epoch)
        .unwrap();
    storage.resume_image(&mut memory, root, epoch).unwrap();
    let before = storage.snapshot(&mut memory).unwrap();
    assert_eq!(
        storage.begin_image_pause(&mut memory, root),
        Err(Errno::EOVERFLOW)
    );
    assert_eq!(storage.next_epoch, u64::from(u32::MAX) + 1);
    assert_eq!(
        memory
            .atomic_load(descriptor.replica + layout::REPLICA_REQUEST)
            .unwrap(),
        0
    );
    assert_eq!(storage.snapshot(&mut memory).unwrap(), before);
}

#[test]
fn a_partially_written_barrier_contains_every_member_without_returning_storage() {
    let (mut groups, mut storage, mut memory, root) = image(32);
    let thread = groups.prepare_thread(root, 101).unwrap();
    storage.prepare_thread(&mut memory, thread).unwrap();
    groups.start(thread).unwrap();
    storage.publish(thread).unwrap();
    let descriptors = [
        storage.descriptor(root).unwrap(),
        storage.descriptor(thread).unwrap(),
    ];
    let before = storage.snapshot(&mut memory).unwrap()[5];
    memory.fail_atomic_store_at(Some(descriptors[1].replica + layout::REPLICA_REQUEST));
    assert_eq!(
        storage.begin_image_pause(&mut memory, root),
        Err(Errno::EIO)
    );
    memory.fail_atomic_store_at(None);
    let snapshot = storage.snapshot(&mut memory).unwrap();
    assert_eq!(snapshot[4], 2);
    assert_eq!(snapshot[5], before);
    for descriptor in descriptors {
        assert_eq!(
            memory
                .atomic_load(descriptor.replica + layout::REPLICA_RUN)
                .unwrap(),
            0
        );
        assert_eq!(
            memory
                .atomic_load(descriptor.root + layout::ROOT_RUN)
                .unwrap(),
            0
        );
    }
    assert_eq!(
        storage.release_stopped_image(&mut memory, root),
        Err(Errno::EAGAIN)
    );
    assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
    assert_eq!(
        storage.begin_image_pause(&mut memory, root),
        Err(Errno::EBUSY)
    );
}

#[test]
fn malformed_or_tail_ptes_keep_the_complete_allocation_at_both_root_capacities() {
    for maximum in [32, 65536] {
        for corruption in 0..4 {
            let (_groups, mut storage, mut memory, root) = image(maximum);
            let descriptor = storage.descriptor(root).unwrap();
            let address = descriptor.root
                + layout::ROOT_HEADER_BYTES
                + if corruption == 3 {
                    (maximum - 1) * 4
                } else {
                    0
                };
            let saved = memory.atomic_load(address).unwrap();
            let invalid = match corruption {
                0 => memory.current_pages().unwrap() * PAGE | 3,
                1 => 3,
                2 => saved | 4,
                _ => memory
                    .atomic_load(descriptor.root + layout::ROOT_HEADER_BYTES)
                    .unwrap(),
            };
            storage.note_quiescent(&mut memory, root).unwrap();
            storage.revoke_source(&mut memory, root).unwrap();
            let before = storage.snapshot(&mut memory).unwrap()[5];
            memory.atomic_store(address, invalid).unwrap();
            assert_eq!(
                storage.release_stopped_image(&mut memory, root),
                Err(Errno::EIO)
            );
            assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
            memory.atomic_store(address, saved).unwrap();
            storage.release_stopped_image(&mut memory, root).unwrap();
            assert_eq!(storage.snapshot(&mut memory).unwrap()[5], 1);
        }
    }
}

#[test]
fn fork_refuses_malformed_and_tail_ptes_before_reserving_child_storage() {
    for maximum in [32, 65536] {
        for corruption in 0..4 {
            let (mut groups, mut storage, mut memory, parent) = image(maximum);
            let root = storage.descriptor(parent).unwrap();
            let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
            memory
                .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
                .unwrap();
            let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
            let pte = root.root + layout::ROOT_HEADER_BYTES;
            let at = if corruption == 3 {
                pte + (maximum - 1) * 4
            } else {
                pte
            };
            let saved = memory.atomic_load(at).unwrap();
            let invalid = match corruption {
                0 => memory.current_pages().unwrap() * PAGE | 3,
                1 => 3,
                2 => saved | 4,
                _ => memory.atomic_load(pte).unwrap(),
            };
            let before = storage.snapshot(&mut memory).unwrap()[5];
            memory.atomic_store(at, invalid).unwrap();
            assert_eq!(
                storage.prepare_private_fork(&mut memory, parent, epoch, child),
                Err(Errno::EIO)
            );
            assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
            assert_eq!(storage.descriptor(child), Err(Errno::ESRCH));
            assert_eq!(
                memory
                    .atomic_load(root.root + layout::ROOT_GROW_LOCK)
                    .unwrap(),
                0
            );
            memory.atomic_store(at, saved).unwrap();
            storage
                .prepare_private_fork(&mut memory, parent, epoch, child)
                .unwrap();
            storage.cancel_unpublished(&mut memory, child).unwrap();
            assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
        }
    }
}

#[test]
fn fork_contention_and_growth_refusal_preserve_the_parent_and_retryable_child() {
    let (mut groups, mut storage, mut memory, parent) = image(32);
    let root = storage.descriptor(parent).unwrap();
    let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
    let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
    let before = storage.snapshot(&mut memory).unwrap()[5];
    assert_eq!(
        storage.prepare_private_fork(&mut memory, parent, epoch, child),
        Err(Errno::EAGAIN)
    );
    memory
        .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
        .unwrap();
    for lock in [root.root + layout::ROOT_GROW_LOCK, layout::CONTROL] {
        memory.atomic_store(lock, 1).unwrap();
        assert_eq!(
            storage.prepare_private_fork(&mut memory, parent, epoch, child),
            Err(Errno::EAGAIN)
        );
        assert_eq!(memory.atomic_load(lock).unwrap(), 1);
        memory.atomic_store(lock, 0).unwrap();
        assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
        assert_eq!(storage.descriptor(child), Err(Errno::ESRCH));
    }
    memory.refuse_growth = true;
    assert_eq!(
        storage.prepare_private_fork(&mut memory, parent, epoch, child),
        Err(Errno::ENOMEM)
    );
    assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
    assert_eq!(storage.descriptor(child), Err(Errno::ESRCH));
    memory.refuse_growth = false;
    storage
        .prepare_private_fork(&mut memory, parent, epoch, child)
        .unwrap();
    storage.cancel_unpublished(&mut memory, child).unwrap();
    assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
    storage.resume_image(&mut memory, parent, epoch).unwrap();
}

#[test]
fn fork_requires_a_current_parent_barrier_without_an_unpublished_mapping() {
    let (mut groups, mut storage, mut memory, parent) = image(32);
    let root = storage.descriptor(parent).unwrap();
    let child = groups.prepare_image(parent.group(), 101, 1).unwrap();
    let thread = groups.prepare_thread(parent, 102).unwrap();
    let epoch = storage.begin_image_pause(&mut memory, parent).unwrap();
    memory
        .atomic_store(root.replica + layout::REPLICA_ACK, epoch)
        .unwrap();
    let change = Description {
        token: 77,
        receipt: parent.record(),
        effect: Effect::Map {
            addr: 4 * PAGE as usize,
            len: PAGE as usize,
            prot: 3,
            flags: wasm_posix_shared::mmap::MAP_PRIVATE | wasm_posix_shared::mmap::MAP_ANONYMOUS,
        },
        population_address: 0,
        population_length: 0,
        shared_object: 0,
        shared_length: 0,
        shared_offset: 0,
    };
    storage
        .stage_mapping(&mut memory, parent, epoch, change, None)
        .unwrap();
    let staged = storage.snapshot(&mut memory).unwrap()[5];
    assert_eq!(
        storage.prepare_private_fork(&mut memory, parent, epoch, child),
        Err(Errno::EBUSY)
    );
    assert_eq!(storage.snapshot(&mut memory).unwrap()[5], staged);
    assert_eq!(storage.descriptor(child), Err(Errno::ESRCH));
    storage.cancel_mapping(&mut memory, parent, 77).unwrap();
    let before = storage.snapshot(&mut memory).unwrap()[5];
    assert_eq!(
        storage.prepare_private_fork(&mut memory, parent, epoch, thread),
        Err(Errno::EINVAL)
    );
    storage.resume_image(&mut memory, parent, epoch).unwrap();
    assert_eq!(
        storage.prepare_private_fork(&mut memory, parent, epoch, child),
        Err(Errno::EAGAIN)
    );
    let next = storage.begin_image_pause(&mut memory, parent).unwrap();
    assert_ne!(next, epoch);
    memory
        .atomic_store(root.replica + layout::REPLICA_ACK, next)
        .unwrap();
    assert_eq!(
        storage.prepare_private_fork(&mut memory, parent, epoch, child),
        Err(Errno::EAGAIN)
    );
    assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
    storage
        .prepare_private_fork(&mut memory, parent, next, child)
        .unwrap();
    storage.cancel_unpublished(&mut memory, child).unwrap();
    assert_eq!(storage.snapshot(&mut memory).unwrap()[5], before);
    storage.resume_image(&mut memory, parent, next).unwrap();
}

fn commit(
    storage: &mut Storage,
    memory: &mut Memory,
    root: GroupAdmission,
    token: u64,
    effect: Effect,
) {
    let descriptor = storage.descriptor(root).unwrap();
    let epoch = storage.begin_image_pause(memory, root).unwrap();
    memory
        .atomic_store(descriptor.replica + layout::REPLICA_ACK, epoch)
        .unwrap();
    let description = Description {
        token,
        receipt: root.record(),
        effect,
        population_address: 0,
        population_length: 0,
        shared_object: 0,
        shared_length: 0,
        shared_offset: 0,
    };
    storage
        .stage_mapping(memory, root, epoch, description, None)
        .unwrap();
    storage.publish_mapping(memory, root, token).unwrap();
    storage.finish_mapping(memory, root, token).unwrap();
    storage.resume_image(memory, root, epoch).unwrap();
}

#[test]
fn heap_regrowth_preserves_partial_page_rights_and_cannot_reuse_retained_frames() {
    let (_groups, mut storage, mut memory, root) = image(32);
    let descriptor = storage.descriptor(root).unwrap();
    let at = |page: u32| descriptor.root + layout::ROOT_HEADER_BYTES + page * 4;
    let original = memory.atomic_load(at(1)).unwrap();
    memory.fill(original & 0xffff0000, PAGE, 0x79).unwrap();
    commit(
        &mut storage,
        &mut memory,
        root,
        1,
        Effect::Protect {
            addr: PAGE as usize,
            len: PAGE as usize,
            prot: 1,
        },
    );
    commit(
        &mut storage,
        &mut memory,
        root,
        2,
        Effect::Break {
            old: 2 * PAGE as usize,
            new: 3 * PAGE as usize + 7,
        },
    );
    let grown = [
        memory.atomic_load(at(2)).unwrap(),
        memory.atomic_load(at(3)).unwrap(),
    ];
    for page in grown {
        memory.fill(page & 0xffff0000, PAGE, 0xa5).unwrap();
    }
    commit(
        &mut storage,
        &mut memory,
        root,
        3,
        Effect::Break {
            old: 3 * PAGE as usize + 7,
            new: PAGE as usize + 7,
        },
    );
    assert_eq!(memory.atomic_load(at(2)).unwrap(), 0);
    assert_eq!(memory.atomic_load(at(3)).unwrap(), 0);
    commit(
        &mut storage,
        &mut memory,
        root,
        4,
        Effect::Break {
            old: PAGE as usize + 7,
            new: 3 * PAGE as usize + 7,
        },
    );
    assert_eq!(memory.atomic_load(at(1)).unwrap(), original & !3 | 1);
    let mut bytes = [0; 32];
    memory.read(original & 0xffff0000, &mut bytes).unwrap();
    assert_eq!(bytes, [0x79; 32]);
    for page in [2, 3] {
        let current = memory.atomic_load(at(page)).unwrap();
        assert!(grown.iter().all(|old| old >> 16 != current >> 16));
        memory.read(current & 0xffff0000, &mut bytes).unwrap();
        assert_eq!(bytes, [0; 32]);
    }
}
