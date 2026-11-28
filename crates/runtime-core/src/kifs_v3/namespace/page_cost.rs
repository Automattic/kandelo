//! Offline reachability diagnostic. Never walks a tree during guest execution.
use super::*;
use crate::filesystem_tree::{PAGE_BYTES, PageRef, decode_key};
use crate::kifs_v3::{BLOCK_BYTES, BLOCK_UNITS, Superblock, Tree, read_superblock};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};

type Image = Cursor<Vec<u8>>;

#[test]
fn cached_path_walk_keeps_one_leaf_entry_and_sees_namespace_updates() {
    let time = Timestamp { seconds: 4, nanoseconds: 0 };
    let mut fs = KifsNamespace::format(Image::default(), super::super::DEFAULT_VOLUME_BLOCKS, [3; 32], time).unwrap();
    fs.enable_lookup_cache();
    let directory = fs.create(ROOT_INODE, b"work", InodeRecord::new(S_IFDIR | 0o750, 0, 0, time), None).unwrap();
    let file = fs.create(directory, b"file", InodeRecord::new(S_IFREG | 0o640, 14, 25, time), None).unwrap();
    let original = b"/work/file";
    assert_eq!(fs.lookup_path(b"/work").unwrap().0, directory);
    assert_eq!(fs.lookup_path(original).unwrap().0, file);
    let revision = fs.volume.revision;
    let slot = fs.lookup_cache.slot(0, original).unwrap();
    assert!(fs.lookup_cache.get(slot, revision, 0, original).is_none());
    let slot = fs.lookup_cache.slot(directory, b"file").unwrap();
    assert_eq!(fs.lookup_cache.get(slot, revision, directory, b"file").unwrap().0, file);

    fs.update_inode(file, |record| { record.uid = 43; Ok(()) }).unwrap();
    assert_eq!(fs.lookup_path(original).unwrap().1.uid, 43);
    fs.rename((directory, b"file"), (directory, b"renamed"), true, false, time).unwrap();
    assert!(matches!(fs.lookup_path(original), Err(Errno::ENOENT)));
    let (renamed, record) = fs.lookup_path(b"/work/renamed").unwrap();
    assert_eq!((renamed, record.uid), (file, 43));
}

impl PositionedStorage for Image {
    fn len(&mut self) -> Result<u64, Errno> {
        Ok(self.get_ref().len() as u64)
    }
    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
        self.seek(SeekFrom::Start(offset))
            .and_then(|_| self.read_exact(bytes))
            .map_err(|_| Errno::EIO)
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        self.seek(SeekFrom::Start(offset))
            .and_then(|_| self.write_all(bytes))
            .map_err(|_| Errno::EIO)
    }
    fn flush(&mut self) -> Result<(), Errno> {
        Ok(())
    }
    fn truncate(&mut self, length: u64) -> Result<(), Errno> {
        self.get_mut()
            .resize(usize::try_from(length).map_err(|_| Errno::EFBIG)?, 0);
        Ok(())
    }
}

#[derive(Default)]
struct Cost {
    calls: usize,
    appended_index: u64,
    reachable_index: u64,
    data_blocks: u64,
}

// Old pages only reference earlier pages, so they cannot contain a pointer
// into this transaction's suffix. Count before the next mutation begins.
fn reachable(tree: &mut Tree<'_, Image>, node: PageRef, level: u8, first: u64, cost: &mut Cost) {
    if node.number < first {
        return;
    }
    cost.reachable_index += 1;
    let mut bytes = [0; PAGE_BYTES];
    let page = tree.read(node, level, &mut bytes, false).unwrap();
    for slot in 0..page.count {
        let (key, value) = page.record(slot).unwrap();
        if level > 0 {
            reachable(
                tree,
                PageRef::decode(value, node.number).unwrap(),
                level - 1,
                first,
                cost,
            );
        } else if matches!(decode_key(key).unwrap(), Key::Block { .. }) {
            let block = PageRef::decode(value, node.number).unwrap();
            cost.data_blocks += u64::from(block.number >= first);
        }
    }
}

impl Cost {
    fn measure<R>(
        &mut self,
        mount: &mut KifsNamespace<Image>,
        written_blocks: u64,
        mutate: impl FnOnce(&mut KifsNamespace<Image>) -> Result<R, Errno>,
    ) -> R {
        let start = mount.volume.live.end;
        let revision = mount.volume.revision;
        let value = mutate(mount).unwrap();
        assert_eq!(
            mount.volume.revision,
            revision + 1,
            "expected exactly one transaction"
        );
        let root = mount.volume.live;
        let previous_blocks = self.data_blocks;
        reachable(&mut mount.volume.tree(), root.root, root.level, start, self);
        // Each diagnostic write allocates distinct blocks once. All other
        // appended units therefore belong to index pages, including dead ones.
        assert_eq!(self.data_blocks - previous_blocks, written_blocks);
        self.appended_index += root.end - start - written_blocks * BLOCK_UNITS;
        self.calls += 1;
        value
    }

    fn report(&self, operation: &str) {
        println!(
            "page-cost {operation} ops={} appended_index={} reachable_index={} superseded_index={} data_blocks={}",
            self.calls,
            self.appended_index,
            self.reachable_index,
            self.appended_index - self.reachable_index,
            self.data_blocks
        );
    }
}

// Measure the same suffix at publication boundaries. Older roots remain
// readable through our private diagnostic copy of the append-only storage.
// Collect these counts offline so the traversal cannot affect guest timing.
struct Groups {
    first: u64,
    cost: Cost,
    groups: usize,
    written_blocks: u64,
}

impl Groups {
    fn new(mount: &mut KifsNamespace<Image>) -> Self {
        mount.sync().unwrap();
        Self {
            first: mount.volume.live.end,
            cost: Cost::default(),
            groups: 0,
            written_blocks: 0,
        }
    }

    fn finish_group(&mut self, mount: &mut KifsNamespace<Image>, root: Superblock) {
        if self.first == root.end {
            return;
        }
        let before = self.cost.data_blocks;
        reachable(
            &mut mount.volume.tree(),
            root.root,
            root.level,
            self.first,
            &mut self.cost,
        );
        // The workload writes each block once and retires it in a later phase.
        assert_eq!(self.cost.data_blocks - before, self.written_blocks);
        self.cost.appended_index += root.end - self.first - self.written_blocks * BLOCK_UNITS;
        self.first = root.end;
        self.written_blocks = 0;
        self.groups += 1;
    }

    fn observe(&mut self, mount: &mut KifsNamespace<Image>, before: Superblock, blocks: u64) {
        if mount.volume.published_end != self.first {
            assert_eq!(mount.volume.published_end, before.end);
            self.finish_group(mount, before);
        }
        self.written_blocks += blocks;
        self.cost.calls += 1;
    }

    fn report(mut self, mount: &mut KifsNamespace<Image>, phase: &str) {
        mount.sync().unwrap();
        self.finish_group(mount, mount.volume.live);
        self.cost.report(phase);
        println!("published-groups {phase} count={}", self.groups);
    }
}

#[test]
#[ignore = "requires a KIFS volume staged from the local packaged shell"]
fn measure_packaged_shell_transaction_pages() {
    let path = std::env::var_os("KANDELO_KIFS_COST_IMAGE").expect("provide a staged KIFS v3 image");
    let mut image = Cursor::new(std::fs::read(path).unwrap());
    let identity = read_superblock(&mut image, 0).unwrap().unwrap().identity;
    let mut mount = KifsNamespace::open(KifsVolume::open(image, identity).unwrap()).unwrap();
    mount.enable_group_commit();
    let home = mount.lookup(ROOT_INODE, b"home").unwrap().unwrap().0;
    let time = Timestamp {
        seconds: 1,
        nanoseconds: 0,
    };
    let record = InodeRecord {
        mode: S_IFREG | 0o600,
        uid: 0,
        gid: 0,
        links: 0,
        size: 0,
        parent: 0,
        device: 0,
        data_blocks: 0,
        accessed: time,
        modified: time,
        changed: time,
    };
    let directory = InodeRecord {
        mode: S_IFDIR | 0o700,
        ..record
    };
    let parent = mount
        .create(home, b"capacity-test", directory, None)
        .unwrap();
    let mut create = Cost::default();
    let mut one_byte = Cost::default();
    let mut groups = Groups::new(&mut mount);
    for i in 0..512 {
        let name = format!("entry-{i:08}");
        let before = mount.volume.live;
        let inode = create.measure(&mut mount, 0, |fs| {
            fs.create(parent, name.as_bytes(), record, None)
        });
        groups.observe(&mut mount, before, 0);
        let before = mount.volume.live;
        one_byte.measure(&mut mount, 1, |fs| {
            fs.write_file(inode, 0, &[i as u8], time)
        });
        groups.observe(&mut mount, before, 1);
    }
    groups.report(&mut mount, "create-and-write-group");
    create.report("create");
    one_byte.report("one-byte");
    let stream = mount.create(parent, b"stream", record, None).unwrap();
    let chunk = [7; 65536];
    let mut stream_cost = Cost::default();
    let mut groups = Groups::new(&mut mount);
    for i in 0..32 {
        let before = mount.volume.live;
        stream_cost.measure(&mut mount, (chunk.len() / BLOCK_BYTES) as u64, |fs| {
            fs.write_file(stream, i * chunk.len() as u64, &chunk, time)
        });
        groups.observe(&mut mount, before, (chunk.len() / BLOCK_BYTES) as u64);
    }
    groups.report(&mut mount, "stream-write-group");
    stream_cost.report("stream-write");
    let mut remove_stream = Cost::default();
    remove_stream.measure(&mut mount, 0, |fs| {
        fs.unlink_file(parent, b"stream", false, time)
    });
    remove_stream.report("stream-unlink");
    let mut remove = Cost::default();
    let mut groups = Groups::new(&mut mount);
    for i in 0..512 {
        let before = mount.volume.live;
        remove.measure(&mut mount, 0, |fs| {
            fs.unlink_file(parent, format!("entry-{i:08}").as_bytes(), false, time)
        });
        groups.observe(&mut mount, before, 0);
    }
    groups.report(&mut mount, "small-unlink-group");
    remove.report("small-unlink");
    mount.sync().unwrap();
    mount.volume.verify().unwrap();
}

#[test]
#[ignore = "requires a KIFS volume staged from the local packaged shell"]
fn measure_packaged_shell_insertion_order() {
    let path = std::env::var_os("KANDELO_KIFS_COST_IMAGE").expect("provide a staged KIFS v3 image");
    let base = std::fs::read(path).unwrap();
    for order in ["ascending", "descending", "permuted"] {
        let mut image = Cursor::new(base.clone());
        let identity = read_superblock(&mut image, 0).unwrap().unwrap().identity;
        let mut mount = KifsNamespace::open(KifsVolume::open(image, identity).unwrap()).unwrap();
        mount.enable_group_commit();
        let home = mount.lookup(ROOT_INODE, b"home").unwrap().unwrap().0;
        let time = Timestamp {
            seconds: 1,
            nanoseconds: 0,
        };
        let parent = mount
            .create(
                home,
                b"order-test",
                InodeRecord::new(S_IFDIR | 0o700, 0, 0, time),
                None,
            )
            .unwrap();
        let record = InodeRecord::new(S_IFREG | 0o600, 0, 0, time);
        let initial = mount.volume.live;
        for i in 0..1024 {
            let suffix = match order {
                "descending" => 1023 - i,
                "permuted" => i * 505 % 1024,
                _ => i,
            };
            let result = mount.create(
                parent,
                format!("entry-{suffix:08}").as_bytes(),
                record,
                None,
            );
            if let Err(error) = result {
                panic!(
                    "{order} insertion {i}, tree level {}: {error:?}",
                    mount.volume.live.level
                );
            }
        }
        mount.sync().unwrap();
        mount.volume.verify().unwrap();
        let root = mount.volume.live;
        let mut cost = Cost::default();
        reachable(
            &mut mount.volume.tree(),
            root.root,
            root.level,
            initial.end,
            &mut cost,
        );
        println!(
            "insertion-order {order} level={} appended_index={} new_reachable_index={}",
            root.level,
            root.end - initial.end,
            cost.reachable_index
        );
    }
}
