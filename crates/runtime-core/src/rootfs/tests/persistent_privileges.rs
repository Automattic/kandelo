use super::*;

#[derive(Default)]
struct Fault {
    remaining: Option<usize>,
    fail_flush: bool,
    wrote: bool,
}

struct Storage {
    inner: SharedJournalStorage,
    fault: Arc<Mutex<Fault>>,
}

impl OverlayStorage for Storage {
    fn len(&mut self) -> Result<u64, Errno> { self.inner.len() }
    fn read_exact_at(&mut self, offset: u64, output: &mut [u8]) -> Result<(), Errno> {
        self.inner.read_exact_at(offset, output)
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        let mut fault = self.fault.lock();
        let count = fault.remaining.unwrap_or(bytes.len()).min(bytes.len());
        self.inner.write_all_at(offset, &bytes[..count])?;
        if let Some(remaining) = &mut fault.remaining { *remaining -= count; }
        fault.wrote = true;
        if count == bytes.len() { Ok(()) } else { Err(Errno::EIO) }
    }
    fn flush(&mut self) -> Result<(), Errno> {
        let fault = self.fault.lock();
        if fault.fail_flush && fault.wrote { Err(Errno::EIO) } else { self.inner.flush() }
    }
    fn truncate(&mut self, length: u64) -> Result<(), Errno> { self.inner.truncate(length) }
}

fn image() -> Vec<u8> {
    image_with_mode(0o6755)
}

fn image_with_mode(mode: u32) -> Vec<u8> {
    use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
    let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
        size_bytes: 128 * 1024, max_size_bytes: Some(4 * 1024 * 1024),
        growable_to_bytes: 4 * 1024 * 1024, now_ms: 0,
    }, Some(256)).unwrap();
    writer.declare_deferred_section().unwrap();
    writer.create_file(writer.root(), b"resident", mode, Content::Bytes(b"original bytes")).unwrap();
    let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
    crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
        lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
    }).unwrap()
}

fn mount(image: &[u8], storage: SharedJournalStorage) {
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(Box::new(storage), Sha256::digest(image).into(), &mut source).unwrap();
}

fn content(path: &[u8], image: &[u8]) -> Vec<u8> {
    package_upgrade::contents(path, &mut image_host(image))
}

fn stamp(stat: &WasmStat) -> [u64; 12] {
    [stat.st_ino, stat.st_size, stat.st_mode as u64, stat.st_uid as u64, stat.st_gid as u64,
        stat.st_nlink as u64, stat.st_atime_sec, stat.st_atime_nsec as u64,
        stat.st_mtime_sec, stat.st_mtime_nsec as u64, stat.st_ctime_sec, stat.st_ctime_nsec as u64]
}

#[test]
fn privileged_raw_writes_clear_only_required_bits_and_recover_without_timestamp_sync() {
    let _guard = TestGuard::acquire();
    let image = image();
    for path in [b"/resident".as_slice(), b"/created"] {
        for mode in [0o4755, 0o2755, 0o6755, 0o2644, 0o6744] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            mount(&image, storage.clone());
            if path == b"/created" { stage_leaf_bytes(path, b"original bytes", &mut image_host(&image)); }
            chmod(path, mode).unwrap();
            let handle = open(path, O_RDWR, 0, 0, 0).unwrap();
            assert_eq!(write(handle, 0, b"", &mut image_host(&image)), Ok(0));
            truncate_handle(handle, 14, &mut image_host(&image)).unwrap();
            assert_eq!(fstat(handle).unwrap().st_mode & 0o7777, mode);
            assert_eq!(write(handle, 0, b"N", &mut image_host(&image)), Ok(1));
            assert_eq!(fstat(handle).unwrap().st_mode & 0o7777, mode_after_content_write(mode));
            if mode_after_content_write(mode) == mode { sync_persistence().unwrap(); }
            release_handle(handle);
            mount(&image, storage);
            assert_eq!(lstat(path).unwrap().st_mode & 0o7777, mode_after_content_write(mode));
            assert_eq!(content(path, &image), b"Nriginal bytes");
        }
    }
}

#[test]
fn privileged_raw_truncate_and_open_trunc_clear_bits_in_the_content_transaction() {
    let _guard = TestGuard::acquire();
    let image = image();
    for path in [b"/resident".as_slice(), b"/created"] {
        for length in [0, 1, 20] {
            for mode in [0o6755, 0o2644, 0o6744] {
                let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
                mount(&image, storage.clone());
                if path == b"/created" { stage_leaf_bytes(path, b"original bytes", &mut image_host(&image)); }
                chmod(path, mode).unwrap();
                let handle = open(path, O_RDWR, 0, 0, 0).unwrap();
                truncate_handle(handle, length, &mut image_host(&image)).unwrap();
                if mode_after_content_write(mode) == mode { sync_persistence().unwrap(); }
                release_handle(handle);
                mount(&image, storage);
                assert_eq!(lstat(path).unwrap().st_mode & 0o7777, mode_after_content_write(mode));
                let mut expected = b"original bytes".to_vec();
                expected.resize(length as usize, 0);
                assert_eq!(content(path, &image), expected);
            }
        }
    }
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    mount(&image, storage.clone());
    let handle = open(b"/resident", O_RDWR | O_TRUNC, 0, 0, 0).unwrap();
    release_handle(handle);
    mount(&image, storage);
    assert_eq!(lstat(b"/resident").unwrap().st_mode & 0o7777, 0o755);
    assert!(content(b"/resident", &image).is_empty());
}

#[test]
fn every_privileged_content_commit_cut_recovers_old_or_demoted_bytes() {
    let _guard = TestGuard::acquire();
    let image = image();
    for path in [b"/resident".as_slice(), b"/created"] {
        for operation in ["write", "shrink", "grow"] {
            let initial = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            mount(&image, initial.clone());
            if path == b"/created" {
                stage_leaf_bytes(path, b"original bytes", &mut image_host(&image));
                chmod(path, 0o6755).unwrap();
            }
            sync_persistence().unwrap();
            let before = initial.0.lock().clone();
            let mutate = |handle| match operation {
                "write" => write(handle, 0, b"N", &mut image_host(&image)).map(|_| ()),
                "shrink" => truncate_handle(handle, 1, &mut image_host(&image)),
                _ => truncate_handle(handle, 20, &mut image_host(&image)),
            };
            let handle = open(path, O_RDWR, 0, 0, 0).unwrap();
            mutate(handle).unwrap();
            release_handle(handle);
            let expected = content(path, &image);
            let length = initial.0.lock().len() - before.len();
            assert!(length > 60);
            for cut in 0..=length {
                let storage = SharedJournalStorage(Arc::new(Mutex::new(before.clone())));
                let fault = Arc::new(Mutex::new(Fault::default()));
                let mut source = image_host(&image);
                load_image(image.len() as u64, &mut source).unwrap();
                enable_resizable_persistence(Box::new(Storage { inner: storage.clone(), fault: fault.clone() }),
                    Sha256::digest(&image).into(), &mut source).unwrap();
                let handle = open(path, O_RDWR, 0, 0, 0).unwrap();
                let previous = fstat(handle).unwrap();
                *fault.lock() = Fault { remaining: Some(cut), fail_flush: cut == length, wrote: false };
                assert_eq!(mutate(handle), Err(Errno::EIO), "{operation} cut={cut}");
                assert_eq!(stamp(&fstat(handle).unwrap()), stamp(&previous));
                assert_eq!(mutate(handle), Err(Errno::EIO));
                release_handle(handle);
                mount(&image, storage);
                assert_eq!(lstat(path).unwrap().st_mode & 0o7777, if cut == length { 0o755 } else { 0o6755 });
                assert_eq!(content(path, &image), if cut == length { expected.as_slice() } else { b"original bytes" });
            }
        }
    }
}

#[test]
fn privileged_first_prefix_is_durable_before_later_cache_eviction_can_fail() {
    let _guard = TestGuard::acquire();
    let image = image();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    mount(&image, storage.clone());
    stage_leaf_bytes(b"/created", b"", &mut image_host(&image));
    chmod(b"/created", 0o6755).unwrap();
    let before = storage.0.lock().clone();
    let prefix = vec![9; 64 * 4096];
    let handle = open(b"/created", O_RDWR, 0, 0, 0).unwrap();
    assert_eq!(write(handle, 0, &prefix, &mut image_host(&image)), Ok(prefix.len()));
    let committed_length = storage.0.lock().len() - before.len();
    release_handle(handle);
    let storage = SharedJournalStorage(Arc::new(Mutex::new(before)));
    let fault = Arc::new(Mutex::new(Fault::default()));
    let mut source = image_host(&image);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(Box::new(Storage { inner: storage.clone(), fault: fault.clone() }),
        Sha256::digest(&image).into(), &mut source).unwrap();
    let handle = open(b"/created", O_RDWR, 0, 0, 0).unwrap();
    *fault.lock() = Fault { remaining: Some(committed_length + 100), ..Fault::default() };
    let bytes = vec![9; 160 * 4096];
    assert_eq!(write(handle, 0, &bytes, &mut source), Ok(128 * 4096));
    assert_eq!(fstat(handle).unwrap().st_mode & 0o7777, 0o755);
    assert_eq!(sync_persistence(), Err(Errno::EIO));
    release_handle(handle);
    mount(&image, storage);
    assert_eq!(lstat(b"/created").unwrap().st_mode & 0o7777, 0o755);
    assert_eq!(content(b"/created", &image), prefix);
}

#[test]
fn privileged_write_preparation_failure_preserves_content_permissions_and_journal() {
    let _guard = TestGuard::acquire();
    let image = image();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    mount(&image, storage.clone());
    let handle = open(b"/resident", O_RDWR, 0, 0, 0).unwrap();
    let before = storage.0.lock().clone();
    let metadata = fstat(handle).unwrap();
    assert_eq!(write(handle, 0, b"x", |_, _| Err(Errno::EIO)), Err(Errno::EIO));
    assert_eq!(stamp(&fstat(handle).unwrap()), stamp(&metadata));
    assert_eq!(*storage.0.lock(), before);
    reclaim_io_read_caches(None);
    {
        let _quota = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
        assert_eq!(write(handle, 0, b"x", &mut image_host(&image)), Err(Errno::ENOMEM));
    }
    assert_eq!(stamp(&fstat(handle).unwrap()), stamp(&metadata));
    assert_eq!(*storage.0.lock(), before);
    assert_eq!(write(handle, 0, b"x", &mut image_host(&image)), Ok(1));
    release_handle(handle);
}

#[test]
fn persistent_privilege_records_are_versioned_and_survive_owner_changes_and_compaction() {
    let _guard = TestGuard::acquire();
    let image = image();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    mount(&image, storage.clone());
    stage_leaf_bytes(b"/created", b"original bytes", &mut image_host(&image));
    for path in [b"/resident".as_slice(), b"/created"] {
        chmod(path, 0o6755).unwrap();
        let ino = lstat(path).unwrap().st_ino;
        let mut active = PERSISTENT_ROOTFS.lock();
        let record = active.as_mut().unwrap().journal.metadata_value(&OverlayKey::Inode(ino)).unwrap().flatten().unwrap();
        assert_eq!(record[0], 3);
        let mut invalid = record.to_vec();
        invalid[0] = 255;
        assert_eq!(decode_inode_record(&invalid).err(), Some(Errno::EIO));
        if record[1] == 1 {
            invalid[0] = 1;
            assert_eq!(decode_inode_record(&invalid).err(), Some(Errno::EIO));
        }
        drop(active);
        chown(path, 12, 34, false).unwrap();
        let handle = open(path, O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"N", &mut image_host(&image)), Ok(1));
        fchmod(handle, 0o6755).unwrap();
        fchown(handle, u32::MAX, 56, true).unwrap();
        let stat = fstat(handle).unwrap();
        assert_eq!((stat.st_uid, stat.st_gid, stat.st_mode & 0o7777), (12, 56, 0o755));
        fchmod(handle, 0o6755).unwrap();
        release_handle(handle);
    }
    let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
    checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
    activate_persistence_compaction().unwrap();
    let end = compacted.0.lock().len() as u64;
    let mut source = image_host(&image);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence_indexed(Box::new(compacted), Box::new(index), Sha256::digest(&image).into(), end, &mut source).unwrap();
    for path in [b"/resident".as_slice(), b"/created"] {
        let stat = lstat(path).unwrap();
        assert_eq!((stat.st_uid, stat.st_gid, stat.st_mode & 0o7777), (12, 56, 0o6755));
        assert_eq!(content(path, &image), b"Nriginal bytes");
    }
}

#[test]
fn verified_privileged_providers_recover_but_still_refuse_writes_and_substitution() {
    let _guard = TestGuard::acquire();
    let image = image();
    for archive in [false, true] {
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = persistent_providers::source(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), Sha256::digest(&image).into(), &mut source).unwrap();
        let provider = persistent_providers::provider(archive, 0);
        stage_persistent_deferred_file(b"/package", &provider, 0o6755, 12, 34).unwrap();
        let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let end = compacted.0.lock().len() as u64;
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence_indexed(Box::new(compacted), Box::new(index), Sha256::digest(&image).into(), end, &mut source).unwrap();
        assert_eq!(lstat(b"/package").unwrap().st_mode & 0o7777, 0o6755);
        let handle = open(b"/package", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"wrong", &mut source), Err(Errno::EROFS));
        assert_eq!(truncate_handle(handle, 0, &mut source), Err(Errno::EROFS));
        release_handle(handle);
        let mut output = [0; 64];
        let mut substituted = |request, bytes: &mut [u8]| {
            let count = source(request, bytes)?;
            if count != 0 { bytes[0] ^= 1; }
            Ok(count)
        };
        assert_eq!(read_file_at(b"/package", 0, &mut output, &mut substituted), Err(Errno::EIO));
        let count = read_file_at(b"/package", 0, &mut output, &mut source).unwrap();
        assert_eq!(&output[..count], if archive { b"hello\n".as_slice() } else { b"new packaged payload" });
    }
}

#[test]
fn modified_privileged_base_files_export_current_bytes_and_lengths() {
    let _guard = TestGuard::acquire();
    let image = image();
    for length in [1, 20] {
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        mount(&image, storage);
        let handle = open(b"/resident", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(handle, length, &mut image_host(&image)).unwrap();
        assert_eq!(write(handle, 0, b"N", &mut image_host(&image)), Ok(1));
        fchmod(handle, 0o6755).unwrap();
        release_handle(handle);
        let expected = content(b"/resident", &image);
        let bytes = drain_export(8192, &mut image_host(&image));
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).unwrap();
        let ino = filesystem.resolve(b"/resident", true).unwrap();
        let stat = filesystem.stat_ino(ino).unwrap();
        assert_eq!(stat.size, length as u64);
        assert_eq!(stat.mode & 0o7777, 0o6755);
        let mut output = vec![0; stat.size as usize];
        assert_eq!(filesystem.read_at(ino, 0, &mut output), Ok(output.len()));
        assert_eq!(output, expected);
    }
}

#[test]
fn recovery_refuses_privileged_base_content_without_explicit_inode_metadata() {
    let _guard = TestGuard::acquire();
    let image = image();
    for resizable in [false, true] {
        for size_only in [false, true] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            mount(&image, storage.clone());
            let ino = lstat(b"/resident").unwrap().st_ino;
            reset();
            let mut journal = OverlayJournal::open(storage.clone(), Sha256::digest(&image).into()).unwrap();
            journal.commit(&[if size_only {
                Mutation::Put { key: OverlayKey::FileSize(ino), value: 1u64.to_le_bytes().to_vec() }
            } else {
                Mutation::Put { key: OverlayKey::FileBlock { inode: ino, block: 0 }, value: vec![9; 4096] }
            }]).unwrap();
            drop(journal);
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            let before = storage.0.lock().clone();
            let result = if resizable {
                enable_resizable_persistence(Box::new(storage.clone()), Sha256::digest(&image).into(), &mut source)
            } else {
                enable_fixed_persistence(Box::new(storage.clone()), Sha256::digest(&image).into(), &mut source)
            };
            assert_eq!(result, Err(Errno::EIO));
            assert_eq!(*storage.0.lock(), before);
            assert_eq!(lstat(b"/resident").unwrap().st_mode & 0o7777, 0o6755);
        }
    }
    let image = image_with_mode(0o2644);
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    mount(&image, storage.clone());
    let ino = lstat(b"/resident").unwrap().st_ino;
    PERSISTENT_ROOTFS.lock().as_mut().unwrap().journal.commit(&[Mutation::Put {
        key: OverlayKey::FileBlock { inode: ino, block: 0 }, value: vec![9; 4096],
    }]).unwrap();
    mount(&image, storage);
    assert_eq!(lstat(b"/resident").unwrap().st_mode & 0o7777, 0o2644);
    assert_eq!(content(b"/resident", &image), vec![9; 14]);
}

#[test]
fn privileged_deferred_package_upgrade_compaction_and_rollback_preserve_user_files() {
    use crate::package_inventory::{Content, File};
    use crate::process_table::ProcessTable;
    use crate::rootfs::package_upgrade::Upgrade;
    let _guard = TestGuard::acquire();
    for archive in [false, true] {
        let (image, storage, _) = package_upgrade::computer();
        let mut source = persistent_providers::source(&image);
        chmod(b"/hello.txt", 0o4755).unwrap();
        let before = package_upgrade::manifest(b"1", &[File { mode: 0o4755,
            ..package_upgrade::file(b"/hello.txt", b"hello sffs\n") }]);
        write_file_at(crate::rootfs::package_upgrade::INSTALLED, 0, &before, 0o600, true, &mut source).unwrap();
        sync_persistence().unwrap();
        let provider = persistent_providers::provider(archive, 0);
        let payload = if archive { b"hello\n".as_slice() } else { b"new packaged payload" };
        let after = package_upgrade::manifest(b"2", &[File { path: b"/hello.txt", package: 0,
            mode: 0o6755, uid: 0, gid: 0, content: Content::Deferred {
                size: payload.len() as u64, digest: Sha256::digest(payload).into(), provider: &provider,
            } }]);
        let mut table = ProcessTable::new();
        let token = table.enter_maintenance().unwrap();
        let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
        while !upgrade.verify_next(&table, &token, 1024, &mut source).unwrap() {}
        upgrade.prepare(&table, &token, &mut source).unwrap();
        upgrade.stage(0, 0, b"", &table, &token, &mut source).unwrap();
        while !upgrade.verify_staged_next(&table, &token, 1024, &mut source).unwrap() {}
        upgrade.commit(&table, &token).unwrap();
        drop(upgrade);
        let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let end = compacted.0.lock().len() as u64;
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence_indexed(Box::new(compacted.clone()), Box::new(index),
            Sha256::digest(&image).into(), end, &mut source).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_mode & 0o7777, 0o6755);
        assert_eq!(package_upgrade::contents(b"/hello.txt", &mut source), payload);
        let mut rollback = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
        while !rollback.verify_next(&table, &token, 1024, &mut source).unwrap() {}
        while !rollback.verify_staged_next(&table, &token, 1024, &mut source).unwrap() {}
        rollback.commit(&table, &token).unwrap();
        drop(rollback);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(compacted), Sha256::digest(&image).into(), &mut source).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_mode & 0o7777, 0o4755);
        assert_eq!(package_upgrade::contents(b"/hello.txt", &mut source), b"hello sffs\n");
        assert_eq!(package_upgrade::contents(b"/user-post", &mut source), b"retain database and uploads");
        crate::rootfs::package_upgrade::discard_transaction(&table, &token, &mut source).unwrap();
        assert_eq!(write_file_at(b"/user-post", 0, b"still writable", 0o644, true, &mut source), Ok(14));
        drop(storage);
    }
}

#[test]
fn privileged_provider_block_overlays_are_refused_during_recovery() {
    let _guard = TestGuard::acquire();
    let image = image();
    for archive in [false, true] {
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = persistent_providers::source(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), Sha256::digest(&image).into(), &mut source).unwrap();
        let ino = stage_persistent_deferred_file(b"/package", &persistent_providers::provider(archive, 0), 0o6755, 0, 0).unwrap();
        let mut journal = PERSISTENT_ROOTFS.lock();
        journal.as_mut().unwrap().journal.commit(&[Mutation::Put {
            key: OverlayKey::FileBlock { inode: ino, block: 0 }, value: vec![9; 4096],
        }]).unwrap();
        drop(journal);
        let before = storage.0.lock().clone();
        load_image(image.len() as u64, &mut source).unwrap();
        assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), Sha256::digest(&image).into(), &mut source), Err(Errno::EIO));
        assert_eq!(*storage.0.lock(), before);
    }
}

#[test]
fn unhashed_deferred_base_files_cannot_acquire_persisted_privileges() {
    use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
    let _guard = TestGuard::acquire();
    let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
    writer.declare_deferred_section().unwrap();
    writer.create_deferred_file(writer.root(), b"unverified", 0o4755, 32, 0, b"",
        b"https://packages.invalid/unverified", b"", b"").unwrap();
    let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
    let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
        lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
    }).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    mount(&image, storage.clone());
    assert_eq!(lstat(b"/unverified").unwrap().st_mode & 0o7777, 0o755);
    let before = storage.0.lock().clone();
    assert_eq!(chmod(b"/unverified", 0o4755), Err(Errno::EPERM));
    assert_eq!(*storage.0.lock(), before);
    assert_eq!(lstat(b"/unverified").unwrap().st_mode & 0o7777, 0o755);
}
