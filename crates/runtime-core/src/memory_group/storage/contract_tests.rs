//! Ports of the retired host policy's corruption, capacity and heap contracts.
use super::*;
use crate::group_memory_change::{Description, Effect};
use crate::memory_group::{MemoryGroupLimits, MemoryGroups, physical::tests::Memory};

fn image(maximum_virtual_pages: u32) -> (MemoryGroups, Storage, Memory, GroupAdmission) {
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
