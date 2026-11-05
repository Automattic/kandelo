use super::*;
use crate::package_inventory::{Content, Inventory};
use crate::rootfs::package_producer::Builder;

fn builder() -> Builder {
    Builder::new(55, [7; 32], b"shell-family", b"1").unwrap()
}

struct BudgetLimit {
    budget: &'static crate::metadata_budget::MetadataBudget,
    previous: usize,
}

impl BudgetLimit {
    fn new(budget: &'static crate::metadata_budget::MetadataBudget, limit: usize) -> Self {
        let previous = budget.usage().1;
        budget.set_limit(limit).unwrap();
        Self { budget, previous }
    }
}

impl Drop for BudgetLimit {
    fn drop(&mut self) { self.budget.set_limit(self.previous).unwrap(); }
}

#[test]
fn package_producer_metadata_does_not_consume_file_cache_credits() {
    let _guard = TestGuard::acquire();
    let io_before = crate::io_buffer::IO_MEMORY.usage().0;
    let package_before = crate::metadata_budget::PACKAGE_METADATA.usage().0;
    let _limit = BudgetLimit::new(&crate::io_buffer::IO_MEMORY, io_before);
    let mut producer = builder();
    producer.add(b"/", None, &mut |_, _| panic!("directory metadata read file bytes")).unwrap();
    let bytes = producer.finish().unwrap();
    assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, io_before);
    assert!(crate::metadata_budget::PACKAGE_METADATA.usage().0 > package_before);
    assert_eq!(Inventory::decode(&bytes).unwrap().files().len(), 1);
    drop(bytes);
    assert_eq!(crate::metadata_budget::PACKAGE_METADATA.usage().0, package_before);
}

#[test]
fn package_producer_metadata_admission_refuses_without_leaks_and_can_retry() {
    let _guard = TestGuard::acquire();
    let before = crate::metadata_budget::PACKAGE_METADATA.usage().0;
    {
        let _limit = BudgetLimit::new(&crate::metadata_budget::PACKAGE_METADATA, before + 16);
        assert!(matches!(Builder::new(55, [7; 32], b"base", b"1"), Err(Errno::ENOMEM)));
        assert_eq!(crate::metadata_budget::PACKAGE_METADATA.usage().0, before);
    }
    drop(builder());
    assert_eq!(crate::metadata_budget::PACKAGE_METADATA.usage().0, before);
    let report = crate::metadata_budget::render_filesystem_memory().unwrap();
    assert!(core::str::from_utf8(&report).unwrap().contains("packages live="));
}

#[test]
fn package_producer_owns_only_selected_files_and_emits_canonical_native_inventory() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    let data = vec![42; 180_001];
    write_file_at(b"/big.txt", 0, &data, 0o755, true, &mut source).unwrap();
    chown(b"/big.txt", 12, 34, false).unwrap();
    let mut producer = builder();
    for path in [b"/link".as_slice(), b"/big.txt", b"/dir"] {
        producer.add(path, None, &mut source).unwrap();
    }
    let bytes = producer.finish().unwrap();
    let inventory = Inventory::decode(&bytes).unwrap();
    assert_eq!(inventory.packages().len(), 1);
    assert_eq!(inventory.packages()[0].name, b"shell-family");
    let files = inventory.files();
    assert_eq!(files.iter().map(|file| file.path).collect::<Vec<_>>(), vec![b"/big.txt".as_slice(), b"/dir", b"/link"]);
    assert_eq!((files[0].mode, files[0].uid, files[0].gid), (0o755, 12, 34));
    assert_eq!(files[0].content, Content::Regular { size: data.len() as u64, digest: Sha256::digest(&data).into() });
    assert_eq!(files[1].content, Content::Directory);
    assert!(matches!(files[2].content, Content::Symlink(_)));
    let mut repeated = builder();
    for file in files { repeated.add(file.path, None, &mut source).unwrap(); }
    assert_eq!(repeated.finish().unwrap(), bytes);
}

#[test]
fn package_producer_refuses_mounted_journals_and_invalidated_source_images() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    let mut producer = builder();
    producer.add(b"/hello.txt", None, &mut source).unwrap();
    load_image(image.len() as u64, &mut source).unwrap();
    assert_eq!(producer.add(b"/big.txt", None, &mut source), Err(Errno::EBUSY));
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
    let (_image, _journal, _) = super::package_upgrade::computer();
    assert!(matches!(Builder::new(55, [7; 32], b"base", b"1"), Err(Errno::EPERM)));
}

#[test]
fn package_producer_refuses_changed_contents_metadata_duplicates_and_unsafe_paths() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    let mut producer = builder();
    producer.add(b"/hello.txt", None, &mut source).unwrap();
    write_file_at(b"/hello.txt", 0, b"edited", 0o644, true, &mut source).unwrap();
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
    let mut producer = builder();
    producer.add(b"/hello.txt", None, &mut source).unwrap();
    chmod(b"/hello.txt", 0o600).unwrap();
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
    let mut producer = builder();
    for path in [b"/run/session".as_slice(), b"/var/lib/kandelo/packages/installed", b"/dir/../hello.txt", b"/dir//child"] {
        assert_eq!(producer.add(path, None, &mut source), Err(Errno::EINVAL));
    }
    producer.add(b"/hello.txt", None, &mut source).unwrap();
    producer.add(b"/hello.txt", None, &mut source).unwrap();
    assert!(matches!(producer.finish(), Err(Errno::EEXIST)));
}

#[test]
fn package_producer_preserves_verified_standalone_and_archive_bindings_without_fetching() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    insert_lazy_file(b"/standalone", 0, b"", 15, 0o755, 0, 0, 700,
        b"https://packages.invalid/program", &[9; 32], b"standalone transport").unwrap();
    declare_archive(71, 123_456).unwrap();
    set_archive_source(71, b"https://packages.invalid/archive", &[10; 32]).unwrap();
    set_archive_payload(71, b"archive transport").unwrap();
    insert_lazy_file(b"/member", 71, b"bin/program", 42, 0o640, 12, 34, 701, b"", b"", b"").unwrap();
    let mut producer = builder();
    let mut no_fetch = |_, _: &mut [u8]| -> Result<usize, Errno> { panic!("producer fetched deferred bytes") };
    assert_eq!(producer.add(b"/standalone", Some([8; 32]), &mut no_fetch), Err(Errno::EIO));
    producer.add(b"/standalone", None, &mut no_fetch).unwrap();
    assert_eq!(producer.add(b"/member", None, &mut no_fetch), Err(Errno::EOPNOTSUPP));
    producer.add(b"/member", Some([11; 32]), &mut no_fetch).unwrap();
    let bytes = producer.finish().unwrap();
    let inventory = Inventory::decode(&bytes).unwrap();
    let Content::Deferred { size, digest, provider } = inventory.files()[0].content else { panic!("archive binding missing") };
    assert_eq!((size, digest), (42, [11; 32]));
    let section = crate::sdef::decode(provider).unwrap();
    assert_eq!(section.records[0].ino, 1);
    assert_eq!(section.records[0].source_path, b"bin/program");
    assert_eq!(section.archives[0].digest, [10; 32]);
    assert_eq!(section.archives[0].uri, b"https://packages.invalid/archive");
    assert_eq!(section.archives[0].payload, b"archive transport");
    assert_eq!(inventory.files()[1].content.file_identity(), Some((15, [9; 32])));
    let mut table = crate::process_table::ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let verification = crate::rootfs::package_plan::FileVerification::begin(&inventory.files()[0], &table, &token).unwrap();
    assert!(verification.is_complete());
    set_archive_source(71, b"https://packages.invalid/other", &[12; 32]).unwrap();
    let verification = crate::rootfs::package_plan::FileVerification::begin(&inventory.files()[0], &table, &token).unwrap();
    assert!(!verification.is_complete());
}

#[test]
fn package_producer_does_not_publish_partial_capture_after_read_failure() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    let mut producer = builder();
    assert_eq!(producer.add(b"/hello.txt", None, &mut |_, _| Err(Errno::EAGAIN)), Err(Errno::EAGAIN));
    producer.add(b"/hello.txt", None, &mut source).unwrap();
    assert_eq!(Inventory::decode(&producer.finish().unwrap()).unwrap().files().len(), 1);
    assert_eq!(ROOTFS.with(|state| state.inodes.iter().flatten().map(|inode| inode.open_count).sum::<u32>()), 0);
}

#[test]
fn package_producer_revalidates_complete_deferred_and_archive_descriptions() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let mut source = image_host(image);
    load_image(image.len() as u64, &mut source).unwrap();
    insert_lazy_file(b"/standalone", 0, b"", 15, 0o755, 0, 0, 700,
        b"https://packages.invalid/program", &[9; 32], b"old transport").unwrap();
    let mut producer = builder();
    producer.add(b"/standalone", None, &mut source).unwrap();
    set_deferred_payload(b"/standalone", b"new transport").unwrap();
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
    let mut producer = builder();
    producer.add(b"/standalone", None, &mut source).unwrap();
    set_deferred_source(b"/standalone", b"https://packages.invalid/other", &[10; 32]).unwrap();
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
    declare_archive(71, 123_456).unwrap();
    set_archive_source(71, b"https://packages.invalid/archive", &[10; 32]).unwrap();
    insert_lazy_file(b"/member", 71, b"bin/program", 42, 0o640, 12, 34, 701, b"", b"", b"").unwrap();
    let mut producer = builder();
    producer.add(b"/member", Some([11; 32]), &mut source).unwrap();
    set_archive_payload(71, b"new archive transport").unwrap();
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
}

#[test]
fn package_producer_archive_binding_proofs_and_reads_cannot_reuse_an_old_source_cache() {
    let _guard = TestGuard::acquire();
    build_lazy_tree();
    set_archive_source(7, &archive_uri(7), &crate::sdef::digest_of(TINY_ZIP)).unwrap();
    let (mut source, calls) = make_byte_source(Vec::new(), vec![(7, TINY_ZIP.to_vec())]);
    let mut bytes = [0; 16];
    assert_eq!(read_file_at(b"/lazy/f", 0, &mut bytes, &mut source), Ok(16));
    assert_eq!(bytes, [b'a'; 16]);
    assert_eq!(calls.get(), 1);
    let mut producer = builder();
    producer.add(b"/lazy/f", Some(Sha256::digest([b'a'; 4096]).into()), &mut source).unwrap();
    let inventory_bytes = producer.finish().unwrap();
    let inventory = Inventory::decode(&inventory_bytes).unwrap();
    let mut table = crate::process_table::ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let proof = crate::rootfs::package_plan::FileVerification::begin(&inventory.files()[0], &table, &token).unwrap();
    assert!(proof.is_complete());
    set_archive_source(7, &archive_uri(7), &[33; 32]).unwrap();
    assert!(matches!(proof.finish(&table, &token), Err(crate::rootfs::package_plan::VerificationError::Conflict(_))));
    assert_eq!(read_file_at(b"/lazy/f", 0, &mut bytes, &mut source), Err(Errno::EIO));
    assert_eq!(calls.get(), 2);
}

fn inherited_archive_inventory() -> crate::IoBuffer<u8> {
    let image = tiny_vfs_described();
    load_image(image.len() as u64, &mut image_host(image)).unwrap();
    declare_archive(71, 123_456).unwrap();
    set_archive_source(71, b"https://packages.invalid/archive", &[10; 32]).unwrap();
    set_archive_payload(71, b"transport").unwrap();
    insert_lazy_file(b"/member", 71, b"bin/program", 42, 0o640, 12, 34, 701, b"", b"", b"").unwrap();
    let mut producer = builder();
    producer.add(b"/member", Some([11; 32]), &mut |_, _| panic!("archive fetch")).unwrap();
    producer.finish().unwrap()
}

#[test]
fn package_producer_inherits_archive_hash_without_fetching_or_retaining_input() {
    let _guard = TestGuard::acquire();
    let inventory = inherited_archive_inventory();
    let mut producer = builder();
    assert_eq!(producer.inherit(&inventory), Ok(1));
    drop(inventory);
    producer.add(b"/member", None, &mut |_, _| panic!("archive fetch")).unwrap();
    let bytes = producer.finish().unwrap();
    let parsed = Inventory::decode(&bytes).unwrap();
    assert_eq!(parsed.files()[0].content.file_identity(), Some((42, [11; 32])));
}

#[test]
fn package_producer_inheritance_uses_logical_archive_identity_not_local_ids() {
    let _guard = TestGuard::acquire();
    let inventory = inherited_archive_inventory();
    unlink(b"/member").unwrap();
    declare_archive(72, 123_456).unwrap();
    set_archive_source(72, b"https://packages.invalid/archive", &[10; 32]).unwrap();
    set_archive_payload(72, b"transport").unwrap();
    insert_lazy_file(b"/member", 72, b"bin/program", 42, 0o640, 12, 34, 702, b"", b"", b"").unwrap();
    let mut producer = builder();
    producer.inherit(&inventory).unwrap();
    producer.add(b"/member", None, &mut |_, _| panic!("archive fetch")).unwrap();
    let bytes = producer.finish().unwrap();
    let parsed = Inventory::decode(&bytes).unwrap();
    let Content::Deferred { provider, .. } = parsed.files()[0].content else { panic!("provider missing") };
    assert_eq!(crate::sdef::decode(provider).unwrap().records[0].archive_id, 72);
}

#[test]
fn package_producer_inheritance_refuses_changed_sources_and_allows_explicit_hash_retry() {
    let _guard = TestGuard::acquire();
    for change in 0..6 {
        let inventory = inherited_archive_inventory();
        match change {
            0 => set_archive_source(71, b"https://packages.invalid/other", &[10; 32]).unwrap(),
            1 => set_archive_source(71, b"https://packages.invalid/archive", &[12; 32]).unwrap(),
            2 => set_archive_payload(71, b"other transport").unwrap(),
            3 => set_deferred_payload(b"/member", b"other member transport").unwrap(),
            _ => {
                unlink(b"/member").unwrap();
                let (path, size) = if change == 4 { (b"bin/other".as_slice(), 42) } else { (b"bin/program".as_slice(), 43) };
                insert_lazy_file(b"/member", 71, path, size, 0o640, 12, 34, 702, b"", b"", b"").unwrap();
            }
        }
        let mut producer = builder();
        producer.inherit(&inventory).unwrap();
        assert_eq!(producer.add(b"/member", None, &mut |_, _| panic!("archive fetch")), Err(Errno::EOPNOTSUPP));
        producer.add(b"/member", Some([13; 32]), &mut |_, _| panic!("archive fetch")).unwrap();
        assert_eq!(Inventory::decode(&producer.finish().unwrap()).unwrap().files().len(), 1);
    }
}

#[test]
fn package_producer_inheritance_failure_does_not_publish_partial_state() {
    let _guard = TestGuard::acquire();
    let before = crate::metadata_budget::PACKAGE_METADATA.usage().0;
    {
        let inventory = inherited_archive_inventory();
        let mut producer = builder();
        assert_eq!(producer.inherit(b"bad inventory"), Err(Errno::EIO));
        let incompatible = crate::package_inventory::encode(54, [8; 32],
            &[crate::package_inventory::PackageSpec { name: b"base", version: b"1", content_digest: None, dependencies: &[] }], &[]).unwrap();
        assert!(producer.inherit(&incompatible).is_err());
        {
            let used = crate::metadata_budget::PACKAGE_METADATA.usage().0;
            let _limit = BudgetLimit::new(&crate::metadata_budget::PACKAGE_METADATA, used);
            assert_eq!(producer.inherit(&inventory), Err(Errno::ENOMEM));
        }
        assert_eq!(producer.inherit(&inventory), Ok(1));
        assert_eq!(producer.inherit(&inventory), Err(Errno::EBUSY));
        producer.add(b"/member", None, &mut |_, _| panic!("archive fetch")).unwrap();
        assert_eq!(producer.inherit(&inventory), Err(Errno::EBUSY));
    }
    assert_eq!(crate::metadata_budget::PACKAGE_METADATA.usage().0, before);
}

#[test]
fn package_producer_inheritance_refuses_unproven_standalone_and_reloaded_sources() {
    let _guard = TestGuard::acquire();
    let inventory = inherited_archive_inventory();
    unlink(b"/member").unwrap();
    insert_lazy_file(b"/member", 0, b"", 42, 0o640, 12, 34, 702,
        b"https://packages.invalid/archive", b"", b"").unwrap();
    let mut producer = builder();
    producer.inherit(&inventory).unwrap();
    assert_eq!(producer.add(b"/member", None, &mut |_, _| panic!("source fetch")), Err(Errno::EOPNOTSUPP));
    let image = tiny_vfs_described();
    load_image(image.len() as u64, &mut image_host(image)).unwrap();
    assert_eq!(producer.inherit(&inventory), Err(Errno::EBUSY));
    assert!(matches!(producer.finish(), Err(Errno::EBUSY)));
}
