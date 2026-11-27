use super::*;
use alloc::{format, vec, vec::Vec};

const ID: [u8; 32] = [71; 32];

#[derive(Clone, Default)]
struct Storage {
    live: Vec<u8>,
    durable: Vec<u8>,
    read_bytes: usize,
    writes: usize,
    bytes_written: usize,
    flushes: usize,
    byte_quota: Option<usize>,
    fail_write_call: Option<usize>,
    fail_write: Option<(u64, usize)>,
    flushes_before_failure: Option<usize>,
    corrupt_at_read: Option<usize>,
}

impl Storage {
    fn crash(mut self) -> Self {
        self.live.clone_from(&self.durable);
        self.fail_write = None;
        self.fail_write_call = None;
        self.flushes_before_failure = None;
        self.read_bytes = 0;
        self
    }
}

impl PositionedStorage for Storage {
    fn len(&mut self) -> Result<u64, Errno> {
        Ok(self.live.len() as u64)
    }

    fn read_exact_at(&mut self, offset: u64, output: &mut [u8]) -> Result<(), Errno> {
        let offset = offset as usize;
        output.copy_from_slice(
            self.live
                .get(offset..offset + output.len())
                .ok_or(Errno::EIO)?,
        );
        self.read_bytes += output.len();
        if let Some(index) = self.corrupt_at_read.and_then(|position| position.checked_sub(offset)) {
            if let Some(byte) = output.get_mut(index) {
                *byte ^= 1;
            }
        }
        Ok(())
    }

    fn write_all_at(&mut self, offset: u64, input: &[u8]) -> Result<(), Errno> {
        self.writes += 1;
        if let Some(limit) = self.byte_quota {
            let start = offset as usize;
            if start + input.len() > limit {
                let written = limit.saturating_sub(start);
                if written != 0 {
                    // The host may persist a prefix even when it reports ENOSPC.
                    self.live.resize(self.live.len().max(limit), 0);
                    self.live[start..limit].copy_from_slice(&input[..written]);
                    self.durable.resize(self.durable.len().max(limit), 0);
                    self.durable[start..limit].copy_from_slice(&input[..written]);
                }
                return Err(Errno::ENOSPC);
            }
        }
        let fault = if self.fail_write_call == Some(self.writes) {
            Some((offset, 7))
        } else {
            self.fail_write.filter(|(position, _)| *position == offset)
        };
        let size = fault.map_or(input.len(), |(_, amount)| amount.min(input.len()));
        self.bytes_written += size;
        let offset = offset as usize;
        if offset + size > self.live.len() {
            self.live.resize(offset + size, 0);
        }
        self.live[offset..offset + size].copy_from_slice(&input[..size]);
        if fault.is_some() {
            // Model a partial write reaching storage before it reports failure.
            if self.durable.len() < offset + size {
                self.durable.resize(offset + size, 0);
            }
            self.durable[offset..offset + size].copy_from_slice(&input[..size]);
            return Err(Errno::EIO);
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), Errno> {
        self.flushes += 1;
        if let Some(remaining) = &mut self.flushes_before_failure {
            if *remaining == 0 {
                return Err(Errno::ENOSPC);
            }
            *remaining -= 1;
        }
        self.durable.clone_from(&self.live);
        Ok(())
    }

    fn truncate(&mut self, length: u64) -> Result<(), Errno> {
        self.live.truncate(length as usize);
        Ok(())
    }
}

fn name(name: &[u8]) -> Key<'_> {
    Key::Dirent { parent: 1, name }
}

#[test]
fn compaction_refuses_a_damaged_target_and_an_uncertain_source() {
    let mut volume = KifsVolume::create(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID).unwrap();
    let contents = [31; BLOCK_BYTES];
    volume.transaction(|tx| tx.put_block(1, 0, &contents)).unwrap();
    let saved = volume.storage.durable.clone();
    for position in [16, BLOCK_BYTES + 16, STORAGE_START as usize] {
        let target = Storage { corrupt_at_read: Some(position), ..Storage::default() };
        assert!(matches!(volume.compact_into(target), Err(Errno::EIO)));
        assert_eq!(volume.storage.durable, saved);
    }
    let mut compact = volume.compact_into(Storage::default()).unwrap();
    let mut readback = [0; BLOCK_BYTES];
    assert!(compact.read_block(1, 0, &mut readback).unwrap());
    assert_eq!(readback, contents);
    volume.storage.flushes_before_failure = Some(1);
    assert_eq!(volume.transaction(|tx| tx.put_block(1, 1, &contents)), Err(Errno::ENOSPC));
    assert!(matches!(volume.compact_into(Storage::default()), Err(Errno::ENOSPC)));
}

#[test]
fn a_large_volume_opens_without_loading_its_namespace() {
    let mut builder =
        KifsVolumeBuilder::new(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID).unwrap();
    const FILES: u64 = 48_000;
    let time = Timestamp {
        seconds: 1,
        nanoseconds: 0,
    };
    let root = InodeRecord {
        mode: wasm_posix_shared::mode::S_IFDIR | 0o755,
        uid: 0,
        gid: 0,
        links: 2,
        size: FILES,
        parent: ROOT_INODE,
        device: 0,
        data_blocks: 0,
        accessed: time,
        modified: time,
        changed: time,
    };
    builder
        .push_metadata(Key::Inode(ROOT_INODE), &root.encode().unwrap())
        .unwrap();
    let file = InodeRecord {
        mode: wasm_posix_shared::mode::S_IFREG | 0o644,
        links: 1,
        size: 0,
        parent: 0,
        ..root
    }
    .encode()
    .unwrap();
    for inode in 2..=FILES + 1 {
        builder.push_metadata(Key::Inode(inode), &file).unwrap();
    }
    for entry in 0..FILES {
        builder
            .push_metadata(
                name(format!("name-{entry:05}").as_bytes()),
                &(entry + 2).to_le_bytes(),
            )
            .unwrap();
    }
    let volume = builder.finish(FILES + 2).unwrap();
    let mut storage = volume.into_storage().crash();
    assert_eq!(&storage.live[..8], b"KIFS\x03\0\0\0");
    assert!(storage.len().unwrap() < 12 * 1024 * 1024);
    assert!(matches!(
        KifsVolume::open(storage.clone(), [0; 32]),
        Err(Errno::EIO)
    ));
    let volume = KifsVolume::open(storage, ID).unwrap();
    assert_eq!(volume.storage.read_bytes, 2 * SUPERBLOCK_BYTES + PAGE_BYTES);
    let height = usize::from(volume.live.level) + 1;
    let mut namespace = KifsNamespace::open(volume).unwrap();
    namespace.recover_orphans().unwrap();
    let mut volume = namespace.into_volume();
    // One branch for the root inode, one for the orphan range. No writes
    // or full namespace traversal on a clean writable mount.
    assert!(volume.storage.read_bytes <= 2 * SUPERBLOCK_BYTES + (1 + 2 * height) * PAGE_BYTES);
    std::println!(
        "clean writable mount: {} files, {} logical bytes, {} stored bytes, {} bytes read",
        FILES,
        DEFAULT_VOLUME_BLOCKS * BLOCK_BYTES as u64,
        volume.storage.live.len(),
        volume.storage.read_bytes
    );
    assert_eq!(volume.live.sequence, 1);
    let mut child = [0; 8];
    assert_eq!(volume.lookup(name(b"name-47999"), &mut child), Ok(Some(8)));
    assert_eq!(u64::from_le_bytes(child), 48_001);
    let mut remaining = 0;
    volume
        .for_directory(1, Some(b"name-47996"), |_, _| {
            remaining += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(remaining, 3);
    assert!(volume.usage().allocated_blocks() < DEFAULT_VOLUME_BLOCKS / 32);
    volume.verify().unwrap();
}

#[test]
fn one_budget_rejects_a_whole_batch_and_reclaims_deleted_blocks() {
    let mut volume = KifsVolume::create(Storage::default(), 4, ID).unwrap();
    let first = volume
        .transaction(|tx| {
            let inode = tx.allocate_inode()?;
            tx.put_metadata(Key::Inode(inode), b"inode")?;
            tx.put_metadata(name(b"before"), &inode.to_le_bytes())?;
            tx.put_block(inode, 12_345, &[76; BLOCK_BYTES])?;
            Ok(inode)
        })
        .unwrap();
    assert_eq!(volume.usage().allocated_blocks(), 4);
    assert_eq!(
        volume.transaction(|tx| {
            tx.remove(name(b"before"))?;
            tx.put_metadata(name(b"after"), &first.to_le_bytes())?;
            tx.put_block(first, 0, &[53; BLOCK_BYTES])
        }),
        Err(Errno::ENOSPC)
    );

    let mut entry = [0; 8];
    assert_eq!(volume.lookup(name(b"before"), &mut entry), Ok(Some(8)));
    assert_eq!(volume.lookup(name(b"after"), &mut entry), Ok(None));
    let mut output = [1; BLOCK_BYTES];
    assert_eq!(volume.read_block(first, 0, &mut output), Ok(false));
    assert_eq!(output, [0; BLOCK_BYTES]);

    volume
        .transaction(|tx| {
            tx.remove(Key::Block {
                inode: first,
                block: 12_345,
            })
        })
        .unwrap();
    assert_eq!(volume.usage().allocated_blocks(), 3);
    volume
        .transaction(|tx| {
            tx.put_block(first, 0, &[53; BLOCK_BYTES])?;
            tx.remove(name(b"before"))?;
            tx.put_metadata(name(b"after"), &first.to_le_bytes())
        })
        .unwrap();
    let mut volume = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
    assert_eq!(volume.lookup(name(b"after"), &mut entry), Ok(Some(8)));
    assert_eq!(u64::from_le_bytes(entry), first);
    assert_eq!(volume.read_block(first, 0, &mut output), Ok(true));
    assert_eq!(output, [53; BLOCK_BYTES]);
    volume.verify().unwrap();
}

#[test]
fn an_existing_sparse_root_at_the_depth_ceiling_accepts_a_new_name() {
    // Older insertions could fill the left spine while leaving its right
    // siblings almost empty. Build that valid shape without an old writer.
    fn padded_name(number: u16) -> [u8; 255] {
        let mut bytes = [b'x'; 255];
        bytes[..4].copy_from_slice(format!("{number:04}").as_bytes());
        bytes
    }

    fn subtree(
        tree: &mut Tree<'_, Storage>,
        level: u8,
        spine: bool,
        number: &mut u16,
        usage: &mut Usage,
    ) -> Child {
        let mut page = PageBuilder::new(level);
        // Three 255-byte component names fill a leaf or index page.
        for slot in 0..if spine { 3 } else { 1 } {
            if level == 0 {
                let bytes = padded_name(*number);
                let key = EncodedKey::new(name(&bytes)).unwrap();
                let value = u64::from(*number).to_le_bytes();
                assert!(page.push(&key, &value));
                usage.metadata_bytes += record_bytes(key.bytes(), value.len());
                *number += 1;
            } else {
                let child = subtree(tree, level - 1, spine && slot == 0, number, usage);
                assert!(page.push(&child.first, &child.reference.encode()));
            }
        }
        page.finish();
        Child {
            first: page.first_key(),
            reference: tree.append(&page.bytes).unwrap(),
        }
    }

    let mut volume = KifsVolume::create(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID).unwrap();
    let mut root = volume.live;
    let mut next = 1;
    let mut tree = volume.tree();
    root.root = subtree(&mut tree, MAX_LEVEL, true, &mut next, &mut root.usage).reference;
    root.level = MAX_LEVEL;
    root.end = tree.end;
    volume.publish(root).unwrap();
    let root = volume.live;
    volume.verify().unwrap();

    let original = volume.into_storage().crash();
    let mut reopened = KifsVolume::open(original.clone(), ID).unwrap();
    reopened
        .transaction(|tx| tx.put_metadata(name(&padded_name(0)), &0u64.to_le_bytes()))
        .unwrap();
    // Fail the replacement root page after the lower pages were written.
    let mut failed = KifsVolume::open(original, ID).unwrap();
    failed.storage.fail_write = Some((offset(reopened.live.root.number).unwrap(), 7));
    assert_eq!(
        failed.transaction(|tx| tx.put_metadata(name(&padded_name(0)), &0u64.to_le_bytes())),
        Err(Errno::EIO)
    );
    assert_eq!(failed.live, root);
    let mut rolled_back = KifsVolume::open(failed.into_storage().crash(), ID).unwrap();
    assert_eq!(
        rolled_back.lookup(name(&padded_name(0)), &mut [0; 8]),
        Ok(None)
    );
    rolled_back.verify().unwrap();

    let mut reopened = KifsVolume::open(reopened.into_storage().crash(), ID).unwrap();
    reopened.verify().unwrap();
    for i in 0..next {
        let mut value = [0; 8];
        assert_eq!(
            reopened.lookup(name(&padded_name(i)), &mut value),
            Ok(Some(8))
        );
        assert_eq!(u64::from_le_bytes(value), u64::from(i));
    }
}

#[test]
fn sequential_cursor_reuses_index_pages_and_preserves_sparse_reads() {
    const TOTAL: u64 = 768;
    const INODE: u64 = 2;
    let has_block = |index: u64| index % 7 != 1 && !(112..172).contains(&index) && index < 722;
    let mut builder = KifsVolumeBuilder::new(Storage::default(), 2048, ID).unwrap();
    let mut allocated = 0;
    for index in 0..TOTAL {
        if has_block(index) {
            builder.push_block(INODE, index, &[(index % 251) as u8; BLOCK_BYTES]).unwrap();
            allocated += 1;
        }
    }
    for block in 0..BLOCK_BATCH as u64 {
        builder.push_block(INODE + 1, block, &[222; BLOCK_BYTES]).unwrap();
    }
    let source = builder.finish(4).unwrap().into_storage().crash();
    let mut reads = [0; 2];
    for (mode, indexed_bytes) in reads.iter_mut().enumerate() {
        let mut volume = KifsVolume::open(source.clone(), ID).unwrap();
        assert!(volume.live.level > 1);
        let start = volume.storage.read_bytes;
        let mut output = [0; BLOCK_BATCH * BLOCK_BYTES];
        for first in (0..TOTAL).step_by(BLOCK_BATCH) {
            if mode == 0 {
                volume.stream_cursor = StreamCursor::default();
            }
            volume.read_file_blocks(INODE, first, &mut output).unwrap();
            for (offset, bytes) in output.chunks_exact(BLOCK_BYTES).enumerate() {
                let index = first + offset as u64;
                let byte = if has_block(index) { (index % 251) as u8 } else { 0 };
                assert_eq!(bytes, &[byte; BLOCK_BYTES]);
            }
        }
        *indexed_bytes = volume.storage.read_bytes - start - allocated * BLOCK_BYTES;
        volume.read_file_blocks(INODE + 1, 0, &mut output).unwrap();
        assert_eq!(output, [222; BLOCK_BATCH * BLOCK_BYTES]);
        volume.read_file_blocks(INODE, 0, &mut output).unwrap();
        assert_eq!(&output[..BLOCK_BYTES], &[0; BLOCK_BYTES]);
        assert_eq!(&output[2 * BLOCK_BYTES..3 * BLOCK_BYTES], &[2; BLOCK_BYTES]);
        volume.verify().unwrap();
    }
    assert!(reads[1] < reads[0], "{reads:?}");
    std::println!("STREAM_INDEX_BYTES fresh={} resumed={}", reads[0], reads[1]);
}

#[test]
fn sequential_cursor_recovers_from_memory_refusal_and_rechecks_payload_after_edits() {
    use crate::io_buffer::{IO_MEMORY, test_budget};

    const INODE: u64 = 2;
    let mut builder = KifsVolumeBuilder::new(Storage::default(), 512, ID).unwrap();
    for index in 0..128 {
        builder.push_block(INODE, index, &[7; BLOCK_BYTES]).unwrap();
    }
    let mut volume = builder.finish(3).unwrap();
    let mut bytes = [0; 2 * BLOCK_BYTES];
    let mut read = |volume: &mut KifsVolume<Storage>, first, value| {
        volume.read_file_blocks(INODE, first, &mut bytes).unwrap();
        assert_eq!(bytes, [value; 2 * BLOCK_BYTES]);
    };
    let used = IO_MEMORY.usage().0;
    let page = IoBuffer::try_filled(PAGE_BYTES, 0u8).unwrap();
    let page_charge = IO_MEMORY.usage().0 - used;
    drop(page);
    read(&mut volume, 0, 7);
    {
        let ordinary_scan = page_charge * (usize::from(volume.live.level) + 1);
        let _limit = test_budget(used + ordinary_scan);
        read(&mut volume, 2, 7);
        assert_eq!(IO_MEMORY.usage().0, used);
    }
    read(&mut volume, 4, 7);
    read(&mut volume, 6, 7);

    volume.group_commit = true;
    volume.epoch.enabled = true;
    volume.transaction(|tx| tx.put_metadata(name(b"other"), b"root changed")).unwrap();
    volume.transaction(|tx| {
        tx.put_block(INODE, 8, &[33; BLOCK_BYTES])?;
        tx.put_block(INODE, 9, &[33; BLOCK_BYTES])
    }).unwrap();
    read(&mut volume, 8, 33);
    volume.publish_pending().unwrap();
    read(&mut volume, 10, 7);
    read(&mut volume, 12, 7);

    let key = EncodedKey::new(Key::Block { inode: INODE, block: 14 }).unwrap();
    let mut reference = [0; crate::filesystem_tree::CHILD_BYTES];
    let root = volume.live;
    let (size, leaf) = volume.tree().lookup(root, key.bytes(), &mut reference).unwrap().unwrap();
    let position = PageRef::decode(&reference[..size], leaf).unwrap();
    volume.storage.corrupt_at_read = Some(offset(position.number).unwrap() as usize);
    assert_eq!(volume.read_file_blocks(INODE, 14, &mut bytes), Err(Errno::EIO));
    volume.storage.corrupt_at_read = None;
    let mut reopened = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
    reopened.verify().unwrap();
    reopened.read_file_blocks(INODE, 8, &mut bytes).unwrap();
    assert_eq!(bytes, [33; 2 * BLOCK_BYTES]);
}

#[test]
fn cached_point_descent_preserves_values_and_checks_storage_during_verification() {
    let mut builder = KifsVolumeBuilder::new(Storage::default(), 128, ID).unwrap();
    for i in 0..100u64 {
        let key = format!("entry-{i:04}");
        builder
            .push_metadata(name(key.as_bytes()), &i.to_le_bytes())
            .unwrap();
    }
    let mut volume = builder.finish(101).unwrap();
    assert!(volume.live.level > 0);
    volume.verify().unwrap();
    let mut read_bytes = 0;
    for pass in 0..2 {
        for i in 0..100u64 {
            let key = format!("entry-{:04}", i * 43 % 100);
            let mut value = [0; 8];
            assert_eq!(volume.lookup(name(key.as_bytes()), &mut value), Ok(Some(8)));
            assert_eq!(u64::from_le_bytes(value), i * 43 % 100);
        }
        if pass == 0 {
            read_bytes = volume.storage.read_bytes;
        } else {
            assert_eq!(read_bytes, volume.storage.read_bytes);
        }
    }
    assert_eq!(volume.lookup(name(b"entry-0000"), &mut []), Err(Errno::ERANGE));
    assert_eq!(volume.lookup(name(b"entry-1000"), &mut []), Ok(None));

    let root = offset(volume.live.root.number).unwrap() as usize;
    volume.storage.live[root + 8] ^= 1;
    assert_eq!(volume.verify(), Err(Errno::EIO));
}

#[test]
fn descending_directory_keys_remain_reachable_after_sync_and_restart() {
    let mut volume = KifsVolume::create(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID).unwrap();
    volume.group_commit = true;
    for i in (0..512u64).rev() {
        let key = format!("entry-{i:08}");
        volume.transaction(|tx| tx.put_metadata(name(key.as_bytes()), &i.to_le_bytes())).unwrap();
    }
    volume.publish_pending().unwrap();
    let mut reopened = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
    reopened.verify().unwrap();
    assert!(reopened.live.level <= 4, "sparse chain of index pages");
    for i in 0..512u64 {
        let key = format!("entry-{i:08}");
        let mut value = [0; 8];
        assert_eq!(reopened.lookup(name(key.as_bytes()), &mut value), Ok(Some(8)));
        assert_eq!(u64::from_le_bytes(value), i);
    }
}

#[test]
fn random_updates_split_and_empty_the_tree_with_maximum_length_records() {
    let mut volume = KifsVolume::create(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID).unwrap();
    let mut keys = vec![[b'x'; 255]; 137];
    for (i, key) in keys.iter_mut().enumerate() {
        key[0] = (i + 1) as u8;
        if matches!(key[0], b'/' | b'.') {
            key[0] = 255;
            key[1] = i as u8;
        }
    }
    for group in 0..8 {
        volume
            .transaction(|tx| {
                for i in (0..keys.len()).rev().filter(|i| i % 8 == group) {
                    tx.put_metadata(name(&keys[i]), &[i as u8; MAX_VALUE_BYTES])?;
                }
                Ok(())
            })
            .unwrap();
    }
    assert!(volume.live.level > 1);
    volume.verify().unwrap();
    for (i, key) in keys.iter().enumerate() {
        let mut bytes = [0; MAX_VALUE_BYTES];
        assert_eq!(volume.lookup(name(key), &mut bytes), Ok(Some(bytes.len())));
        assert_eq!(bytes, [i as u8; MAX_VALUE_BYTES]);
    }
    volume
        .transaction(|tx| {
            for key in &keys {
                tx.remove(name(key))?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(volume.usage().metadata_bytes, 0);
    assert_eq!(volume.live.level, 0);
    volume.verify().unwrap();
}

#[test]
fn recover_each_publication_boundary_without_losing_acknowledged_state() {
    let mut volume = KifsVolume::create(Storage::default(), 12, ID).unwrap();
    volume
        .transaction(|tx| tx.put_metadata(name(b"saved"), b"previous"))
        .unwrap();
    let source = volume.into_storage().crash();
    for (first, second, flushes, expect_new) in [
        (None, None, Some(0), false),
        (Some(43), None, None, false),
        (None, None, Some(1), false),
        (None, Some(43), None, true),
        (None, None, Some(2), true),
        (None, None, None, true),
    ] {
        let mut volume = KifsVolume::open(source.clone(), ID).unwrap();
        let first_slot = volume.first_write_slot;
        volume.storage.fail_write = first
            .map(|bytes| (first_slot * BLOCK_BYTES as u64, bytes))
            .or_else(|| second.map(|bytes| ((1 - first_slot) * BLOCK_BYTES as u64, bytes)));
        volume.storage.flushes_before_failure = flushes;
        let result = volume.transaction(|tx| tx.put_metadata(name(b"saved"), b"current!"));
        assert_eq!(
            result.is_ok(),
            first.is_none() && second.is_none() && flushes.is_none()
        );
        if volume.publication_error().is_some() {
            assert!(volume.transaction(|_| Ok(())).is_err());
        }
        let mut reopened = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
        let mut value = [0; 8];
        assert_eq!(reopened.lookup(name(b"saved"), &mut value), Ok(Some(8)));
        assert_eq!(&value, if expect_new { b"current!" } else { b"previous" });
        reopened.verify().unwrap();
    }
}

#[test]
fn group_sync_publishes_data_and_names_together_and_preserves_prior_acknowledgements() {
    let mut volume = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    volume.group_commit = true;
    volume.transaction(|tx| tx.put_block(2, 0, &[1; BLOCK_BYTES])).unwrap();
    volume.transaction(|tx| tx.put_metadata(name(b"one"), b"first")).unwrap();
    let mut disk = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
    assert_eq!(disk.lookup(name(b"one"), &mut [0; 8]), Ok(None));
    volume.publish_pending().unwrap();
    let saved = volume.storage.clone();
    for (flushes, current) in [(Some(0), false), (Some(1), false), (Some(2), true), (None, true)] {
        let mut volume = KifsVolume::open(saved.clone().crash(), ID).unwrap();
        volume.group_commit = true;
        volume.transaction(|tx| tx.put_metadata(name(b"two"), b"second")).unwrap();
        volume.transaction(|tx| tx.put_block(2, 0, &[2; BLOCK_BYTES])).unwrap();
        let mut bytes = [0; BLOCK_BYTES];
        assert!(volume.read_block(2, 0, &mut bytes).unwrap());
        assert_eq!(bytes, [2; BLOCK_BYTES]);
        volume.storage.flushes_before_failure = flushes;
        assert_eq!(volume.publish_pending().is_ok(), flushes.is_none());
        let mut reopened = KifsVolume::open(volume.storage.crash(), ID).unwrap();
        assert_eq!(reopened.lookup(name(b"one"), &mut bytes), Ok(Some(5)));
        assert_eq!(reopened.lookup(name(b"two"), &mut bytes).unwrap().is_some(), current);
        assert!(reopened.read_block(2, 0, &mut bytes).unwrap());
        assert_eq!(bytes, [if current { 2 } else { 1 }; BLOCK_BYTES]);
        reopened.verify().unwrap();
    }
}

#[test]
fn mounted_write_uses_direct_io_when_the_optional_window_is_refused() {
    use crate::io_buffer::{IO_MEMORY, test_budget};

    let mut volume = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    volume.group_commit = true;
    let _limit = test_budget(IO_MEMORY.usage().0 + APPEND_WINDOW_BYTES);
    let writes = volume.storage.writes;
    volume.transaction(|tx| {
        assert!(tx.tree.try_append_window);
        tx.put_block(2, 0, &[7; BLOCK_BYTES])?;
        assert!(tx.tree.appends.is_none());
        assert!(!tx.tree.try_append_window);
        Ok(())
    }).unwrap();
    assert!(volume.storage.writes - writes >= 2);
    volume.publish_pending().unwrap();
    let mut reopened = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
    let mut data = [0; BLOCK_BYTES];
    assert!(reopened.read_block(2, 0, &mut data).unwrap());
    assert_eq!(data, [7; BLOCK_BYTES]);
}

#[test]
fn staged_metadata_and_direct_bulk_payload_skip_optional_window_admission() {
    use wasm_posix_shared::mode::S_IFREG;

    let time = Timestamp { seconds: 4, nanoseconds: 0 };
    let file = InodeRecord::new(S_IFREG | 0o640, 17, 29, time);
    let mut ns =
        KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    ns.enable_group_commit();
    let inode = ns.create(ROOT_INODE, b"stream", file, None).unwrap();

    let mut record = ns.inode(inode).unwrap().unwrap();
    record.uid = 30;
    let writes_before = ns.volume.storage.writes;
    ns.volume.transaction(|tx| {
        tx.put_metadata(Key::Inode(inode), &record.encode()?)?;
        assert!(tx.tree.appends.is_none());
        assert!(tx.tree.try_append_window);
        Ok(())
    }).unwrap();
    assert_eq!(ns.volume.storage.writes, writes_before);

    let payload = [23; BLOCK_BYTES * BLOCK_BATCH];
    record.size = payload.len() as u64;
    record.data_blocks = BLOCK_BATCH as u64;
    ns.volume.transaction(|tx| {
        tx.append_file_blocks(inode, 0, &payload, Some(&record.encode()?))?;
        assert!(tx.tree.appends.is_none());
        assert!(tx.tree.try_append_window);
        Ok(())
    }).unwrap();
    assert_eq!(ns.volume.storage.writes, writes_before + 1);
    assert_eq!(ns.inode(inode).unwrap(), Some(record));

    ns.sync().unwrap();
    let mut volume = KifsVolume::open(ns.into_volume().into_storage().crash(), ID).unwrap();
    volume.verify().unwrap();
    let mut reopened = KifsNamespace::open(volume).unwrap();
    assert_eq!(reopened.lookup(ROOT_INODE, b"stream").unwrap(), Some((inode, record)));
    let mut bytes = [0; BLOCK_BYTES * BLOCK_BATCH];
    assert_eq!(reopened.read_file(inode, 0, &mut bytes), Ok(payload.len()));
    assert_eq!(bytes, payload);
}

#[test]
fn direct_block_run_checks_saved_and_pending_conflicts_before_writing() {
    use wasm_posix_shared::mode::S_IFREG;

    let time = Timestamp { seconds: 4, nanoseconds: 0 };
    let mut ns =
        KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    ns.enable_group_commit();
    let file = InodeRecord::new(S_IFREG | 0o640, 17, 29, time);
    let inode = ns.create(ROOT_INODE, b"stream", file, None).unwrap();
    let payload = [23; APPEND_WINDOW_BYTES];
    let first = 3;
    let position = first * BLOCK_BYTES as u64;
    ns.write_file(inode, position, &payload, time).unwrap();

    let reject_overlap = |ns: &mut KifsNamespace<Storage>| {
        let usage = ns.volume.usage();
        let writes = ns.volume.storage.writes;
        assert_eq!(
            ns.volume.transaction(|tx| {
                tx.append_file_blocks(inode, first - 1, &payload, None)
            }),
            Err(Errno::EIO)
        );
        assert_eq!(ns.volume.storage.writes, writes);
        assert_eq!(ns.volume.usage(), usage);
    };
    reject_overlap(&mut ns);
    ns.sync().unwrap();
    ns.create(ROOT_INODE, b"another", file, None).unwrap();
    reject_overlap(&mut ns);

    let writes = ns.volume.storage.writes;
    ns.volume.cache = PageCache::new();
    ns.volume.storage.corrupt_at_read = Some(offset(ns.volume.live.root.number).unwrap() as usize);
    assert_eq!(
        ns.volume.transaction(|tx| {
            tx.append_file_blocks(inode, first + 4, &payload, None)
        }),
        Err(Errno::EIO)
    );
    assert_eq!(ns.volume.storage.writes, writes);
    ns.volume.storage.corrupt_at_read = None;

    // The saved keys still exist in the base tree. A pending truncation makes
    // them available again, and retry must remain visible through the same inode.
    ns.truncate_file(inode, 0, time).unwrap();
    assert!(!ns.volume.epoch.points.is_empty());
    let replacement = [47; APPEND_WINDOW_BYTES];
    ns.write_file(inode, position, &replacement, time).unwrap();
    let record = ns.inode(inode).unwrap().unwrap();
    assert_eq!(record.data_blocks, 4);
    ns.sync().unwrap();
    let mut volume = KifsVolume::open(ns.into_volume().into_storage().crash(), ID).unwrap();
    volume.verify().unwrap();
    let mut reopened = KifsNamespace::open(volume).unwrap();
    assert_eq!(
        reopened.lookup(ROOT_INODE, b"stream").unwrap(),
        Some((inode, record))
    );
    let mut output = [0; APPEND_WINDOW_BYTES];
    assert_eq!(reopened.read_file(inode, position, &mut output), Ok(output.len()));
    assert_eq!(output, replacement);
}

#[test]
fn coalesced_appends_recover_from_a_partial_spill_or_final_drain() {
    let mut volume = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    volume.group_commit = true;
    let writes = volume.storage.writes;
    volume.transaction(|tx| {
        tx.put_metadata(name(b"saved"), b"before")?;
        tx.put_block(2, 0, &[9; BLOCK_BYTES])
    }).unwrap();
    assert_eq!(volume.storage.writes - writes, 1);
    volume.publish_pending().unwrap();
    let saved = volume.storage.clone();
    let usage = volume.usage();

    let rewrite = |tx: &mut Transaction<'_, Storage>| {
        tx.put_metadata(name(b"saved"), b"after!")?;
        for block in 0..10 {
            tx.put_block(2, block, &[block as u8; BLOCK_BYTES])?;
        }
        let mut data = [0; BLOCK_BYTES];
        for block in [0, 9] {
            assert!(tx.read_block(2, block, &mut data)?);
            assert_eq!(data, [block as u8; BLOCK_BYTES]);
        }
        Ok(())
    };
    volume.transaction(rewrite).unwrap();
    let drains = volume.storage.writes - saved.writes;
    assert!(drains > 1 && drains < 10);
    for call in 1..=drains {
        let mut source = saved.clone().crash();
        source.fail_write_call = Some(source.writes + call);
        let mut volume = KifsVolume::open(source, ID).unwrap();
        volume.group_commit = true;
        assert_eq!(volume.transaction(rewrite), Err(Errno::EIO));
        assert_eq!(volume.usage(), usage);
        let mut text = [0; 6];
        volume.lookup(name(b"saved"), &mut text).unwrap();
        assert_eq!(&text, b"before");
        let mut recovered = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
        let mut data = [0; BLOCK_BYTES];
        assert!(recovered.read_block(2, 0, &mut data).unwrap());
        assert_eq!(data, [9; BLOCK_BYTES]);
        assert!(!recovered.read_block(2, 9, &mut data).unwrap());
        volume.transaction(rewrite).unwrap();
        volume.publish_pending().unwrap();
        let mut recovered = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
        recovered.verify().unwrap();
        recovered.lookup(name(b"saved"), &mut text).unwrap();
        assert_eq!(&text, b"after!");
        assert!(recovered.read_block(2, 9, &mut data).unwrap());
        assert_eq!(recovered.usage().data_blocks, 10);
    }
}

#[test]
fn grouped_writeback_bounds_progress_and_retries_a_refused_data_flush() {
    let mut volume = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    volume.group_commit = true;
    for value in 0..64 {
        volume.transaction(|tx| tx.put_metadata(name(b"count"), &[value])).unwrap();
    }
    let mut previous = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
    assert_eq!(previous.lookup(name(b"count"), &mut [0]), Ok(None));
    // An admission flush must finish before the incoming transaction runs.
    volume.storage.flushes_before_failure = Some(0);
    assert_eq!(volume.transaction(|_| panic!("admitted after failed flush")), Err::<(), _>(Errno::ENOSPC));
    let mut value = [0];
    assert_eq!(volume.lookup(name(b"count"), &mut value), Ok(Some(1)));
    assert_eq!(value, [63]);
    volume.storage.flushes_before_failure = None;
    volume.transaction(|tx| {
        for block in 0..64 {
            tx.put_block(2, block, &[7; BLOCK_BYTES])?;
        }
        Ok(())
    }).unwrap();
    let mut durable = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
    assert_eq!(durable.lookup(name(b"count"), &mut value), Ok(Some(1)));
    assert_eq!(value, [63]);
    assert_eq!(durable.usage().data_blocks, 0);
    // A single transaction can cross the byte threshold well before 64 operations.
    volume.transaction(|tx| tx.put_metadata(name(b"next"), b"x")).unwrap();
    let mut durable = KifsVolume::open(volume.storage.crash(), ID).unwrap();
    assert_eq!(durable.usage().data_blocks, 64);
    assert_eq!(durable.lookup(name(b"next"), &mut value), Ok(None));
    durable.verify().unwrap();
}

#[test]
fn larger_coalescing_epoch_preserves_synced_data_and_retries_quota() {
    use wasm_posix_shared::mode::S_IFREG;

    let time = Timestamp { seconds: 1, nanoseconds: 0 };
    let create = InodeRecord::new(S_IFREG | 0o640, 31, 62, time);
    let mut ns = KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    ns.enable_group_commit();
    let inode = ns.create(ROOT_INODE, b"archive", create, None).unwrap();
    let original = [13; BLOCK_BYTES * BLOCK_BATCH];
    let replacement = [29; BLOCK_BYTES * BLOCK_BATCH];
    ns.write_file(inode, 0, &original, time).unwrap();
    ns.sync().unwrap();

    for position in 1..=8 {
        ns.write_file(inode, (original.len() * position) as u64, &replacement, time).unwrap();
    }
    assert!(ns.volume.pending_operations > 0);
    assert!(ns.volume.live.end - ns.volume.published_end > 256);
    let mut output = [0; BLOCK_BYTES * BLOCK_BATCH];
    let index_start = offset(ns.volume.live.end).unwrap() as usize;
    ns.volume.storage.byte_quota = Some(index_start + 17);
    assert_eq!(ns.sync(), Err(Errno::ENOSPC));
    ns.volume.storage.byte_quota = None;
    ns.volume.storage.flushes_before_failure = Some(0);
    assert_eq!(ns.sync(), Err(Errno::ENOSPC));
    assert_eq!(ns.read_file(inode, original.len() as u64, &mut output), Ok(output.len()));
    assert_eq!(output, replacement);

    let mut prior = KifsVolume::open(ns.volume.storage.clone().crash(), ID).unwrap();
    prior.verify().unwrap();
    let mut prior = KifsNamespace::open(prior).unwrap();
    assert_eq!(prior.read_file(inode, original.len() as u64, &mut output), Ok(0));
    assert_eq!(prior.read_file(inode, 0, &mut output), Ok(output.len()));
    assert_eq!(output, original);

    ns.volume.storage.flushes_before_failure = None;
    ns.sync().unwrap();
    let mut recovered = KifsVolume::open(ns.into_volume().into_storage().crash(), ID).unwrap();
    recovered.verify().unwrap();
    let mut recovered = KifsNamespace::open(recovered).unwrap();
    let (recovered_inode, record) = recovered.lookup_path(b"/archive").unwrap();
    assert_eq!((recovered_inode, record.uid, record.gid), (inode, 31, 62));
    assert_eq!(record.mode & 0o777, 0o640);
    assert_eq!(recovered.read_file(inode, (original.len() * 8) as u64, &mut output), Ok(output.len()));
    assert_eq!(output, replacement);
}

#[test]
fn replacing_a_damaged_replica_preserves_the_only_authoritative_root() {
    let mut volume = KifsVolume::create(Storage::default(), 12, ID).unwrap();
    volume
        .transaction(|tx| tx.put_metadata(name(b"saved"), b"acknowledged"))
        .unwrap();
    let mut storage = volume.into_storage().crash();
    let broken = BLOCK_BYTES + CHECKSUM_START;
    storage.durable[broken] ^= 1;
    let mut volume = KifsVolume::open(storage.crash(), ID).unwrap();
    assert_eq!(volume.first_write_slot, 1);
    volume.storage.fail_write = Some((BLOCK_BYTES as u64, 43));
    assert_eq!(
        volume.transaction(|tx| tx.remove(name(b"saved"))),
        Err(Errno::EIO)
    );
    let mut reopened = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
    let mut value = [0; 12];
    assert_eq!(reopened.lookup(name(b"saved"), &mut value), Ok(Some(12)));
    assert_eq!(&value, b"acknowledged");

    let mut storage = reopened.into_storage().crash();
    storage.durable[STORAGE_START as usize + PAGE_BYTES] ^= 1;
    assert!(matches!(
        KifsVolume::open(storage.crash(), ID),
        Err(Errno::EIO)
    ));
}

#[test]
fn namespace_operations_persist_typed_metadata_and_sparse_content() {
    use wasm_posix_shared::mode::{S_IFLNK, S_IFREG};
    let time = Timestamp {
        seconds: 123,
        nanoseconds: 45,
    };
    let mut mount =
        KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    let record = InodeRecord {
        mode: S_IFREG | 0o640,
        uid: 83,
        gid: 74,
        links: 0,
        size: 0,
        parent: 0,
        device: 0,
        data_blocks: 0,
        accessed: time,
        modified: time,
        changed: time,
    };
    let inode = mount.create(ROOT_INODE, b"file", record, None).unwrap();
    let offset = (1 << 42) + 7;
    mount
        .write_file(inode, offset, b"after a hole", time)
        .unwrap();
    mount.link(inode, ROOT_INODE, b"alias", time).unwrap();
    let target = [b'x'; 705];
    let symbolic = mount
        .create(
            ROOT_INODE,
            b"symbolic",
            InodeRecord {
                mode: S_IFLNK | 0o777,
                ..record
            },
            Some(&target),
        )
        .unwrap();
    let mut volume = mount.into_volume();
    volume.verify().unwrap();
    assert_eq!(volume.usage().data_blocks, 1);
    let mut compacted = volume.compact_into(Storage::default()).unwrap();
    assert_eq!(compacted.usage(), volume.usage());
    assert_eq!(compacted.next_inode(), volume.next_inode());
    assert!(compacted.storage.live.len() < volume.storage.live.len());
    compacted.verify().unwrap();
    let mut reopened =
        KifsNamespace::open(KifsVolume::open(compacted.into_storage().crash(), ID).unwrap())
            .unwrap();
    let (target_inode, metadata) = reopened.lookup(ROOT_INODE, b"alias").unwrap().unwrap();
    assert_eq!(target_inode, inode);
    assert_eq!(
        (
            metadata.uid,
            metadata.gid,
            metadata.links,
            metadata.data_blocks
        ),
        (83, 74, 2, 1)
    );
    assert_eq!(metadata.size, offset + 12);
    let mut data = [4; 14];
    assert_eq!(reopened.read_file(inode, offset - 2, &mut data), Ok(14));
    assert_eq!(&data, b"\0\0after a hole");
    let mut bytes = [0; 640];
    assert_eq!(reopened.read_link(symbolic, &mut bytes), Ok(640));
    assert_eq!(&bytes, &target[..640]);
    reopened
        .unlink_file(ROOT_INODE, b"file", false, time)
        .unwrap();
    reopened
        .unlink_file(ROOT_INODE, b"alias", true, time)
        .unwrap();
    assert!(reopened.lookup(ROOT_INODE, b"alias").unwrap().is_none());
    assert_eq!(reopened.inode(inode).unwrap().unwrap().links, 0);
    assert_eq!(reopened.read_file(inode, offset - 2, &mut data), Ok(14));
    let durable = reopened.into_volume().into_storage().crash();
    // An ENOSPC during the last close is observable at sync. Recovery
    // retries only committed orphan markers even if recovery itself stops.
    for flushes in [0, 1, 2] {
        let mut storage = durable.clone();
        storage.flushes_before_failure = Some(flushes);
        let mut mount = KifsNamespace::open(KifsVolume::open(storage, ID).unwrap()).unwrap();
        assert_eq!(mount.release_orphan(inode), Err(Errno::ENOSPC));
        assert_eq!(mount.sync(), Err(Errno::ENOSPC));
        let storage = mount.into_volume().into_storage().crash();
        let mut mount = KifsNamespace::open(KifsVolume::open(storage, ID).unwrap()).unwrap();
        mount.recover_orphans().unwrap();
        assert!(mount.inode(inode).unwrap().is_none());
        assert_eq!(mount.usage().data_blocks, 0);
        assert_eq!(
            mount.lookup(ROOT_INODE, b"symbolic").unwrap().unwrap().0,
            symbolic
        );
        mount.into_volume().verify().unwrap();
    }
    let mut reopened = KifsNamespace::open(KifsVolume::open(durable, ID).unwrap()).unwrap();
    reopened.reclaim_unlinked(inode).unwrap();
    assert!(reopened.inode(inode).unwrap().is_none());
    let mut volume = reopened.into_volume();
    assert_eq!(volume.usage().data_blocks, 0);
    volume.verify().unwrap();
}

#[test]
fn reclaim_releases_a_multi_page_extent_range_without_copying_deleted_pages() {
    let mut builder =
        KifsVolumeBuilder::new(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID).unwrap();
    builder.push_metadata(Key::Inode(1), b"inode").unwrap();
    builder.push_metadata(Key::Inode(2), b"inode").unwrap();
    const EXTENTS: u64 = 530;
    for number in 0..EXTENTS {
        builder
            .push_block(1, number * 19, &[53; BLOCK_BYTES])
            .unwrap();
    }
    builder.push_block(2, 37, &[18; BLOCK_BYTES]).unwrap();
    let mut volume = builder.finish(3).unwrap();
    let old_end = volume.live.end;
    volume.transaction(|tx| tx.reclaim_inode(1)).unwrap();
    assert_eq!(volume.usage().data_blocks, 1);
    assert!(volume.live.end - old_end < 24);
    let mut data = [0; BLOCK_BYTES];
    assert_eq!(volume.read_block(2, 37, &mut data), Ok(true));
    assert_eq!(data, [18; BLOCK_BYTES]);
    volume.verify().unwrap();
}

#[test]
fn directory_rename_changes_parent_atomically_and_rejects_cycles() {
    use wasm_posix_shared::mode::S_IFDIR;
    let time = Timestamp {
        seconds: 123,
        nanoseconds: 45,
    };
    let mut namespace = KifsNamespace::format(Storage::default(), 259, ID, time).unwrap();
    let template = namespace.inode(ROOT_INODE).unwrap().unwrap();
    let origin = namespace
        .create(ROOT_INODE, b"origin", template, None)
        .unwrap();
    let destination = namespace
        .create(ROOT_INODE, b"destination", template, None)
        .unwrap();
    let child = namespace.create(origin, b"child", template, None).unwrap();
    assert_eq!(
        namespace.rename((ROOT_INODE, b"origin"), (child, b"loop"), true, false, time),
        Err(Errno::EINVAL)
    );
    assert_eq!(namespace.lookup(child, b"..").unwrap().unwrap().0, origin);
    let victim = namespace
        .create(
            destination,
            b"present",
            InodeRecord {
                mode: S_IFDIR | 0o751,
                ..template
            },
            None,
        )
        .unwrap();
    assert_eq!(
        namespace.rename(
            (origin, b"child"),
            (destination, b"present"),
            false,
            false,
            time
        ),
        Err(Errno::EEXIST)
    );
    namespace
        .rename(
            (origin, b"child"),
            (destination, b"present"),
            true,
            true,
            time,
        )
        .unwrap();
    assert!(namespace.lookup(origin, b"child").unwrap().is_none());
    assert_eq!(
        namespace
            .lookup(destination, b"present")
            .unwrap()
            .unwrap()
            .0,
        child
    );
    assert_eq!(
        namespace.lookup(child, b"..").unwrap().unwrap().0,
        destination
    );
    assert_eq!(namespace.inode(victim).unwrap().unwrap().links, 0);
    namespace.reclaim_unlinked(victim).unwrap();
    let mut volume = namespace.into_volume();
    let mut name = [0; 64];
    assert_eq!(
        volume.next_in_directory(destination, None, &mut name),
        Ok(Some((7, child)))
    );
    assert_eq!(&name[..7], b"present");
    assert_eq!(
        volume.next_in_directory(destination, Some(b"present"), &mut name),
        Ok(None)
    );
    volume.verify().unwrap();
}

#[test]
fn deferred_descriptor_spans_pages_and_refuses_missing_payload() {
    let time = Timestamp { seconds: 1, nanoseconds: 0 };
    let mut volume = KifsNamespace::format(Storage::default(), 128, ID, time).unwrap().into_volume();
    let key = |chunk| Key::Attribute { inode: 4, kind: DEFERRED_FILE, chunk };
    let uri = vec![b'u'; MAX_VALUE_BYTES];
    let mut wire = vec![0; 48];
    wire[8..12].copy_from_slice(&(uri.len() as u32).to_le_bytes());
    wire[12..16].copy_from_slice(&(MAX_VALUE_BYTES as u32).to_le_bytes());
    wire[16..48].fill(12);
    wire.extend_from_slice(&uri);
    wire.resize(wire.len() + MAX_VALUE_BYTES, 33);
    volume.transaction(|tx| {
        for (chunk, bytes) in wire.chunks(MAX_VALUE_BYTES).take(2).enumerate() {
            tx.put_metadata(key(chunk as u32), bytes)?;
        }
        Ok(())
    }).unwrap();
    let mut ns = KifsNamespace::open(volume).unwrap();
    assert!(matches!(ns.deferred_file(4), Err(Errno::EIO)));
    let mut volume = ns.into_volume();
    volume.transaction(|tx| tx.put_metadata(key(2), &wire[2 * MAX_VALUE_BYTES..])).unwrap();
    let mut ns = KifsNamespace::open(volume).unwrap();
    let descriptor = ns.deferred_file(4).unwrap().unwrap();
    assert_eq!(&descriptor.address[..], uri.as_slice());
    assert_eq!(descriptor.digest, [12; 32]);
    assert_eq!(descriptor.reference, 0);
    assert!(ns.deferred_file(5).unwrap().is_none());
}
#[test]
fn adjacent_block_updates_split_preserve_holes_and_abort_atomically() {
    use wasm_posix_shared::mode::S_IFREG;

    let time = Timestamp { seconds: 4, nanoseconds: 2 };
    let mut mount = KifsNamespace::format(Storage::default(), 256, ID, time).unwrap();
    mount.enable_group_commit();
    let inode = mount.create(ROOT_INODE, b"file", InodeRecord::new(S_IFREG | 0o644, 12, 34, time), None).unwrap();
    mount.write_file(inode, 0, b"saved", time).unwrap();
    mount.sync().unwrap();
    let volume = mount.into_volume();
    let usage = volume.usage();
    let saved = volume.storage.crash();
    let offset = 3 * BLOCK_BYTES;
    let mut payload = vec![0; (BLOCK_BATCH * 2 + 1) * BLOCK_BYTES + 11];
    for (i, block) in payload.chunks_mut(BLOCK_BYTES).enumerate() { block.fill(i as u8 + 1); }

    let open = |storage| {
        let mut mount = KifsNamespace::open(KifsVolume::open(storage, ID).unwrap()).unwrap();
        mount.enable_group_commit();
        mount
    };
    let mut mount = open(saved.clone());
    mount.write_file(inode, offset as u64, &payload, time).unwrap();
    let volume = mount.into_volume();
    let writes = volume.storage.writes - saved.writes;
    assert!(writes > 1);
    assert_eq!(volume.usage().data_blocks - usage.data_blocks, payload.len().div_ceil(BLOCK_BYTES) as u64);
    let mut mount = KifsNamespace::open(volume).unwrap();
    // Replace a middle block and part of each adjacent block. This breaks a
    // physical run while preserving its neighbors and the hole before it.
    let splice = BLOCK_BATCH * BLOCK_BYTES - 3;
    let overlay = vec![0xee; BLOCK_BYTES + 5];
    mount.write_file(inode, (offset + splice) as u64, &overlay, time).unwrap();
    payload[splice..splice + overlay.len()].copy_from_slice(&overlay);
    mount.sync().unwrap();
    let mut volume = mount.into_volume();
    volume.verify().unwrap();
    let mut reopened = open(volume.storage.crash());
    let mut read = vec![0xfe; offset + payload.len()];
    assert_eq!(reopened.read_file(inode, 0, &mut read), Ok(read.len()));
    assert_eq!(&read[..5], b"saved");
    assert!(read[5..offset].iter().all(|byte| *byte == 0));
    assert_eq!(&read[offset..], &payload);

    for cut in 1..=writes {
        let mut storage = saved.clone();
        storage.fail_write_call = Some(storage.writes + cut);
        let mut mount = open(storage);
        assert_eq!(mount.write_file(inode, offset as u64, &payload, time), Err(Errno::EIO));
        assert_eq!(mount.inode(inode).unwrap().unwrap().size, 5);
        let volume = mount.into_volume();
        assert_eq!(volume.usage(), usage);
        let mut reopened = open(volume.storage.crash());
        assert_eq!(reopened.read_file(inode, 0, &mut read), Ok(5));
        assert_eq!(&read[..5], b"saved");
        // Retry with different content at the reused suffix offsets.
        reopened.write_file(inode, offset as u64, &payload, time).unwrap();
        reopened.sync().unwrap();
        assert_eq!(reopened.read_file(inode, offset as u64, &mut read), Ok(payload.len()));
        assert_eq!(&read[..payload.len()], &payload);
    }
}

#[test]
fn cached_records_follow_the_live_root_after_abort_and_retry() {
    let mut volume = KifsVolume::create(Storage::default(), 64, ID).unwrap();
    volume.group_commit = true;
    let inode = volume.transaction(|tx| {
        let inode = tx.allocate_inode()?;
        tx.put_metadata(Key::Inode(inode), b"before")?;
        Ok(inode)
    }).unwrap();
    let name = Key::Dirent { parent: inode, name: b"name" };
    let record = Key::Inode(inode);
    let mut bytes = [0; 16];
    assert_eq!(volume.lookup(name, &mut bytes), Ok(None));
    let aborted: Result<(), Errno> = volume.transaction(|tx| {
        tx.put_metadata(record, b"intermediate")?;
        tx.put_metadata(name, &inode.to_le_bytes())?;
        assert_eq!(tx.lookup(record, &mut bytes), Ok(Some(12)));
        assert_eq!(&bytes[..12], b"intermediate");
        Err(Errno::ENOSPC)
    });
    assert_eq!(aborted, Err(Errno::ENOSPC));
    assert_eq!(volume.lookup(name, &mut bytes), Ok(None));
    assert_eq!(volume.lookup(record, &mut bytes), Ok(Some(6)));
    assert_eq!(&bytes[..6], b"before");
    volume.transaction(|tx| {
        tx.put_metadata(name, &inode.to_le_bytes())?;
        tx.put_metadata(record, b"after")
    }).unwrap();
    assert_eq!(volume.lookup(name, &mut bytes[..4]), Err(Errno::ERANGE));
    assert_eq!(volume.lookup(name, &mut bytes), Ok(Some(8)));
    assert_eq!(&bytes[..8], &inode.to_le_bytes());
    assert_eq!(volume.lookup(record, &mut bytes), Ok(Some(5)));
    assert_eq!(&bytes[..5], b"after");

    let attr = Key::Attribute { inode, kind: DEFERRED_FILE, chunk: 0 };
    assert_eq!(volume.lookup(attr, &mut []), Ok(None));
    volume.transaction(|tx| tx.put_metadata(attr, b"descriptor")).unwrap();
    assert_eq!(volume.lookup(attr, &mut []), Err(Errno::ERANGE));
    volume.transaction(|tx| tx.reclaim_inode(inode)).unwrap();
    assert_eq!(volume.lookup(attr, &mut []), Ok(None));
}

#[test]
fn same_format_coalescing_quota_retry_and_crash() {
    let time = Timestamp {
        seconds: 100,
        nanoseconds: 0,
    };
    let mut ns =
        KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    let file = InodeRecord::new(wasm_posix_shared::mode::S_IFREG | 0o640, 51, 77, time);
    let saved = ns.create(1, b"saved", file, None).unwrap();
    ns.write_file(saved, 0, b"before", time).unwrap();
    ns.enable_group_commit();
    ns.write_file(saved, 0, b"middle", time).unwrap();
    ns.write_file(saved, 0, b"latest", time).unwrap();
    let fresh = ns.create(1, b"added", file, None).unwrap();
    ns.write_file(fresh, 0, b"second", time).unwrap();
    let usage = ns.usage();

    fn view(ns: &mut KifsNamespace<Storage>, saved: u64, fresh: Option<u64>, data: &[u8]) {
        let (inode, stat) = ns.lookup(1, b"saved").unwrap().unwrap();
        assert_eq!(
            (inode, stat.mode & 0o777, stat.uid, stat.gid),
            (saved, 0o640, 51, 77)
        );
        let mut bytes = [0; 6];
        assert_eq!(ns.read_file(inode, 0, &mut bytes), Ok(6));
        assert_eq!(&bytes, data);
        assert_eq!(ns.lookup(1, b"added").unwrap().map(|(i, _)| i), fresh);
        if let Some(fresh) = fresh {
            assert_eq!(ns.read_file(fresh, 0, &mut bytes), Ok(6));
            assert_eq!(&bytes, b"second");
        }
    }
    fn reopen(disk: Storage) -> KifsNamespace<Storage> {
        let mut volume = KifsVolume::open(disk.crash(), ID).unwrap();
        volume.verify().unwrap();
        KifsNamespace::open(volume).unwrap()
    }
    // Make the uncommitted file blocks durable without publishing the edits.
    // Recovery must still follow the last synced root.
    ns.volume.storage.flush().unwrap();
    let end = offset(ns.volume.live.end).unwrap() as usize;
    assert_eq!(ns.volume.storage.live.len(), end);
    let roots = ns.volume.storage.live[..STORAGE_START as usize].to_vec();
    for partial in [0, 73] {
        ns.volume.storage.byte_quota = Some(end + partial);
        assert_eq!(ns.sync(), Err(Errno::ENOSPC));
        assert_eq!(ns.volume.publication_error(), None);
        assert_eq!(ns.usage(), usage);
        assert_eq!(ns.volume.storage.live[..STORAGE_START as usize], roots);
        view(&mut ns, saved, Some(fresh), b"latest");
        view(
            &mut reopen(ns.volume.storage.clone()),
            saved,
            None,
            b"before",
        );
    }

    // Quota while staging a new syscall must leave earlier writes retryable.
    ns.volume.storage.byte_quota = Some(end + 3);
    assert_eq!(ns.write_file(saved, 0, b"failed", time), Err(Errno::ENOSPC));
    view(&mut ns, saved, Some(fresh), b"latest");
    ns.volume.storage.byte_quota = None;
    ns.sync().unwrap();
    let mut restored = reopen(ns.volume.storage.clone());
    assert_eq!(restored.usage(), usage);
    view(&mut restored, saved, Some(fresh), b"latest");
    // Deletion is visible immediately but neither data nor directory entries
    // can disappear durably in isolation when an index build is interrupted.
    ns.write_file(saved, 0, b"latest", time).unwrap();
    ns.unlink_file(1, b"added", false, time).unwrap();
    ns.volume.storage.byte_quota = Some(offset(ns.volume.live.end).unwrap() as usize + 5);
    assert_eq!(ns.sync(), Err(Errno::ENOSPC));
    view(&mut ns, saved, None, b"latest");
    view(
        &mut reopen(ns.volume.storage.clone()),
        saved,
        Some(fresh),
        b"latest",
    );
    ns.volume.storage.byte_quota = None;
    ns.sync().unwrap();
    view(
        &mut reopen(ns.into_volume().into_storage()),
        saved,
        None,
        b"latest",
    );
}

#[test]
fn same_format_coalescing_each_root_publication_cut() {
    let mut base = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    base.transaction(|tx| tx.put_metadata(name(b"state"), b"old"))
        .unwrap();
    let base = base.into_storage().crash();
    for (cut, expected, poisoned) in [
        (0, b"old", false),
        (1, b"old", true),
        (2, b"new", true),
        (3, b"new", false),
    ] {
        let mut volume = KifsVolume::open(base.clone(), ID).unwrap();
        volume.group_commit = true;
        volume.epoch.enabled = true;
        volume
            .transaction(|tx| tx.put_metadata(name(b"state"), b"tmp"))
            .unwrap();
        volume
            .transaction(|tx| tx.put_metadata(name(b"state"), b"new"))
            .unwrap();
        volume.storage.flushes_before_failure = Some(cut);
        assert_eq!(volume.publish_pending().is_ok(), cut == 3);
        assert_eq!(volume.publication_error().is_some(), poisoned);
        let mut reopened = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
        reopened.verify().unwrap();
        let mut bytes = [0; 3];
        assert_eq!(reopened.lookup(name(b"state"), &mut bytes), Ok(Some(3)));
        assert_eq!(&bytes, expected);
    }
}

#[test]
fn coalescing_unlinks_a_file_larger_than_the_epoch_budget() {
    let time = Timestamp {
        seconds: 109,
        nanoseconds: 0,
    };
    let file = InodeRecord::new(wasm_posix_shared::mode::S_IFREG | 0o644, 1, 1, time);
    let mut ns =
        KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    ns.enable_group_commit();
    let inode = ns.create(1, b"large", file, None).unwrap();
    let data = vec![47; 2050 * BLOCK_BYTES];
    ns.write_file(inode, 0, &data, time).unwrap();
    ns.sync().unwrap();
    // Keep an unrelated staged name visible through the large eager operation.
    let other = ns.create(1, b"unrelated", file, None).unwrap();
    let before = ns.usage();
    let end = offset(ns.volume.live.end).unwrap() as usize;
    ns.volume.storage.byte_quota = Some(end + 33);
    assert_eq!(ns.unlink_file(1, b"large", false, time), Err(Errno::ENOSPC));
    assert_eq!(ns.usage(), before);
    assert_eq!(ns.lookup(1, b"large").unwrap().unwrap().0, inode);
    assert_eq!(ns.lookup(1, b"unrelated").unwrap().unwrap().0, other);
    ns.volume.storage.byte_quota = None;
    assert_eq!(ns.unlink_file(1, b"large", false, time), Ok(inode));
    ns.sync().unwrap();
    let mut disk = KifsVolume::open(ns.into_volume().into_storage().crash(), ID).unwrap();
    disk.verify().unwrap();
    assert_eq!(disk.usage().data_blocks, 0);
    let mut restored = KifsNamespace::open(disk).unwrap();
    assert!(restored.lookup(1, b"large").unwrap().is_none());
    assert_eq!(restored.lookup(1, b"unrelated").unwrap().unwrap().0, other);
}

#[test]
fn coalescing_memory_refusal_keeps_both_views_retryable() {
    use crate::io_buffer::{IO_MEMORY, test_budget};
    let mut volume = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    volume.group_commit = true;
    volume.epoch.enabled = true;
    volume
        .transaction(|tx| tx.put_metadata(name(b"counter"), b"old"))
        .unwrap();
    volume.publish_pending().unwrap();
    volume
        .transaction(|tx| tx.put_metadata(name(b"counter"), b"one"))
        .unwrap();
    volume
        .transaction(|tx| tx.put_metadata(name(b"counter"), b"two"))
        .unwrap();
    let usage = volume.usage();
    {
        let _limit = test_budget(IO_MEMORY.usage().0);
        assert_eq!(
            volume.transaction(|tx| tx.put_metadata(name(b"another"), b"name")),
            Err(Errno::ENOMEM)
        );
        assert_eq!(volume.publish_pending(), Err(Errno::ENOMEM));
        assert_eq!(volume.publication_error(), None);
        assert_eq!(volume.usage(), usage);
        let mut bytes = [0; 3];
        assert_eq!(volume.lookup(name(b"counter"), &mut bytes), Ok(Some(3)));
        assert_eq!(&bytes, b"two");
        assert_eq!(volume.lookup(name(b"another"), &mut bytes), Ok(None));
    }
    let mut crash = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
    let mut bytes = [0; 3];
    crash.lookup(name(b"counter"), &mut bytes).unwrap();
    assert_eq!(&bytes, b"old");
    volume.publish_pending().unwrap();
    let mut saved = KifsVolume::open(volume.into_storage().crash(), ID).unwrap();
    saved.verify().unwrap();
    saved.lookup(name(b"counter"), &mut bytes).unwrap();
    assert_eq!(&bytes, b"two");
    assert_eq!(saved.lookup(name(b"another"), &mut bytes), Ok(None));
}

#[test]
fn staged_metadata_without_storage_growth_retries_sync_and_preserves_identity() {
    use wasm_posix_shared::mode::S_IFREG;

    let time = Timestamp { seconds: 19, nanoseconds: 5 };
    let file = InodeRecord::new(S_IFREG | 0o640, 18, 29, time);
    let mut ns =
        KifsNamespace::format(Storage::default(), DEFAULT_VOLUME_BLOCKS, ID, time).unwrap();
    ns.enable_group_commit();
    let inode = ns.create(ROOT_INODE, b"original", file, None).unwrap();
    ns.write_file(inode, 0, b"old", time).unwrap();
    ns.sync().unwrap();

    // The first operation in an epoch builds its index immediately. Subsequent
    // metadata-only edits can succeed without allocating host file space.
    let other = ns.create(ROOT_INODE, b"other", file, None).unwrap();
    let end = ns.volume.live.end;
    let length = offset(end).unwrap() as usize;
    assert_eq!(ns.volume.storage.live.len(), length);
    let writes = ns.volume.storage.writes;
    ns.volume.storage.byte_quota = Some(length);
    ns.rename(
        (ROOT_INODE, b"original"), (ROOT_INODE, b"renamed"), false, false, time,
    ).unwrap();
    ns.update_inode(inode, |record| {
        record.uid = 35;
        Ok(())
    }).unwrap();
    assert_eq!(ns.volume.storage.writes, writes);
    assert_eq!(ns.volume.live.end, end);
    assert!(ns.lookup(ROOT_INODE, b"original").unwrap().is_none());
    let (found, record) = ns.lookup(ROOT_INODE, b"renamed").unwrap().unwrap();
    assert_eq!((found, record.uid, record.gid), (inode, 35, 29));

    ns.volume.storage.byte_quota = Some(length + 17);
    assert_eq!(ns.sync(), Err(Errno::ENOSPC));
    assert_eq!(ns.volume.publication_error(), None);
    assert_eq!(ns.write_file(inode, 0, b"new", time), Err(Errno::ENOSPC));
    let mut bytes = [0; 3];
    assert_eq!(ns.read_file(inode, 0, &mut bytes), Ok(3));
    assert_eq!(&bytes, b"old");

    let mut durable = KifsVolume::open(ns.volume.storage.clone().crash(), ID).unwrap();
    durable.verify().unwrap();
    let mut durable = KifsNamespace::open(durable).unwrap();
    assert!(durable.lookup(ROOT_INODE, b"renamed").unwrap().is_none());
    assert!(durable.lookup(ROOT_INODE, b"other").unwrap().is_none());
    let (found, record) = durable.lookup(ROOT_INODE, b"original").unwrap().unwrap();
    assert_eq!((found, record.uid), (inode, 18));

    ns.volume.storage.byte_quota = None;
    ns.sync().unwrap();
    let mut durable = KifsVolume::open(ns.into_volume().into_storage().crash(), ID).unwrap();
    durable.verify().unwrap();
    let mut durable = KifsNamespace::open(durable).unwrap();
    assert!(durable.lookup(ROOT_INODE, b"original").unwrap().is_none());
    let (found, record) = durable.lookup(ROOT_INODE, b"renamed").unwrap().unwrap();
    assert_eq!((found, record.uid, record.mode & 0o777), (inode, 35, 0o640));
    assert_eq!(durable.lookup(ROOT_INODE, b"other").unwrap().unwrap().0, other);
    assert_eq!(durable.read_file(inode, 0, &mut bytes), Ok(3));
    assert_eq!(&bytes, b"old");
}

#[test]
fn metadata_only_epoch_publishes_at_the_operation_limit() {
    let mut volume = KifsVolume::create(Storage::default(), 128, ID).unwrap();
    volume.group_commit = true;
    volume.epoch.enabled = true;
    let counter = name(b"counter");
    volume.transaction(|tx| tx.put_metadata(counter, &[0])).unwrap();
    let staged_end = volume.live.end;
    let writes = volume.storage.writes;
    for value in 1..64 {
        volume.transaction(|tx| tx.put_metadata(counter, &[value])).unwrap();
    }
    assert_eq!(volume.live.end, staged_end);
    assert_eq!(volume.storage.writes, writes);
    assert_eq!(volume.pending_operations, 64);
    let mut data = [0];
    let mut recovered = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
    assert_eq!(recovered.lookup(counter, &mut data), Ok(None));

    volume.transaction(|tx| tx.put_metadata(counter, &[64])).unwrap();
    assert_eq!(volume.pending_operations, 1);
    assert_eq!(volume.lookup(counter, &mut data), Ok(Some(1)));
    assert_eq!(data, [64]);
    let mut recovered = KifsVolume::open(volume.storage.clone().crash(), ID).unwrap();
    recovered.verify().unwrap();
    assert_eq!(recovered.lookup(counter, &mut data), Ok(Some(1)));
    assert_eq!(data, [63]);
}

#[test]
fn coalesced_range_removal_accounts_from_the_live_scan() {
    use wasm_posix_shared::mode::S_IFREG;
    let time = Timestamp { seconds: 19, nanoseconds: 0 };
    let record = InodeRecord::new(S_IFREG | 0o640, 18, 29, time);
    let mut ns = KifsNamespace::format(Storage::default(), 256, ID, time).unwrap();
    let inode = ns.create(ROOT_INODE, b"sparse", record, None).unwrap();
    ns.write_file(inode, 0, &[1], time).unwrap();
    ns.write_file(inode, 3 * BLOCK_BYTES as u64, &[3], time).unwrap();
    ns.write_file(inode, 5 * BLOCK_BYTES as u64, &[5], time).unwrap();
    ns.enable_group_commit();
    ns.write_file(inode, 2 * BLOCK_BYTES as u64, &[2], time).unwrap();
    ns.write_file(inode, 5 * BLOCK_BYTES as u64, &[8], time).unwrap();
    ns.write_file(inode, 6 * BLOCK_BYTES as u64, &[6], time).unwrap();
    assert_eq!(ns.usage().data_blocks, 5);
    ns.truncate_file(inode, 3 * BLOCK_BYTES as u64, time).unwrap();
    assert_eq!(ns.usage().data_blocks, 2);
    ns.sync().unwrap();
    let storage = ns.into_volume().into_storage().crash();
    let mut volume = KifsVolume::open(storage, ID).unwrap();
    volume.verify().unwrap();
    let mut ns = KifsNamespace::open(volume).unwrap();
    let (found, stat) = ns.lookup(ROOT_INODE, b"sparse").unwrap().unwrap();
    assert_eq!((found, stat.size, stat.uid, stat.gid), (inode, 3 * BLOCK_BYTES as u64, 18, 29));
    let mut bytes = [5; 4];
    ns.read_file(inode, 2 * BLOCK_BYTES as u64, &mut bytes).unwrap();
    assert_eq!(bytes, [2, 0, 0, 0]);
    ns.read_file(inode, BLOCK_BYTES as u64, &mut bytes).unwrap();
    assert_eq!(bytes, [0; 4]);
}

#[test]
fn partial_append_keeps_existing_prefix_and_initializes_new_blocks() {
    use wasm_posix_shared::mode::S_IFREG;
    let time = Timestamp { seconds: 21, nanoseconds: 0 };
    let record = InodeRecord::new(S_IFREG | 0o640, 18, 29, time);
    for grouped in [false, true] {
        let mut ns = KifsNamespace::format(Storage::default(), 256, ID, time).unwrap();
        if grouped {
            ns.enable_group_commit();
        }
        let inode = ns.create(ROOT_INODE, b"append", record, None).unwrap();
        let prefix = [0x11; BLOCK_BYTES - 2];
        ns.write_file(inode, 0, &prefix, time).unwrap();
        ns.write_file(inode, prefix.len() as u64, &[0x22; 4], time).unwrap();
        let after_hole = 3 * BLOCK_BYTES + 3;
        ns.write_file(inode, after_hole as u64, &[0x33], time).unwrap();
        assert_eq!(ns.usage().data_blocks, 3);
        ns.sync().unwrap();

        let storage = ns.into_volume().into_storage().crash();
        let mut volume = KifsVolume::open(storage, ID).unwrap();
        volume.verify().unwrap();
        let mut reopened = KifsNamespace::open(volume).unwrap();
        let mut bytes = [0xff; 3 * BLOCK_BYTES + 4];
        assert_eq!(reopened.read_file(inode, 0, &mut bytes), Ok(after_hole + 1));
        assert_eq!(&bytes[..prefix.len()], &prefix);
        assert_eq!(&bytes[prefix.len()..prefix.len() + 4], &[0x22; 4]);
        assert!(bytes[prefix.len() + 4..after_hole].iter().all(|&byte| byte == 0));
        assert_eq!(bytes[after_hole], 0x33);
    }
}

#[test]
fn partial_append_rejects_a_live_block_beyond_inode_eof() {
    use wasm_posix_shared::mode::S_IFREG;
    let time = Timestamp { seconds: 21, nanoseconds: 0 };
    let record = InodeRecord::new(S_IFREG | 0o640, 18, 29, time);
    for grouped in [false, true] {
        let mut ns = KifsNamespace::format(Storage::default(), 256, ID, time).unwrap();
        let inode = ns.create(ROOT_INODE, b"append", record, None).unwrap();
        if grouped {
            ns.enable_group_commit();
        }
        ns.volume
            .transaction(|tx| tx.put_block(inode, 0, &[0xee; BLOCK_BYTES]))
            .unwrap();
        assert_eq!(ns.write_file(inode, 0, &[1], time), Err(Errno::EIO));
        assert_eq!(ns.inode(inode).unwrap().unwrap().size, 0);
        let mut bytes = [0; BLOCK_BYTES];
        assert_eq!(ns.volume.read_block(inode, 0, &mut bytes), Ok(true));
        assert_eq!(bytes, [0xee; BLOCK_BYTES]);
    }
}
