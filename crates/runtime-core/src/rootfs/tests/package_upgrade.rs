use super::*;
use crate::package_inventory::{self, Content, File, PackageSpec};
use crate::process_table::ProcessTable;
use crate::rootfs::package_upgrade::{self, Error, Phase, Recovery, Upgrade};

pub(super) fn manifest<'a>(version: &[u8], files: &[File<'a>]) -> Vec<u8> {
    package_inventory::encode(
        55,
        [7; 32],
        &[PackageSpec {
            name: b"base",
            version,
            content_digest: None,
            dependencies: &[],
        }],
        files,
    )
    .unwrap()
    .to_vec()
}

pub(super) fn file<'a>(path: &'a [u8], bytes: &[u8]) -> File<'a> {
    File {
        path,
        package: 0,
        mode: 0o644,
        uid: 0,
        gid: 0,
        content: Content::Regular {
            size: bytes.len() as u64,
            digest: Sha256::digest(bytes).into(),
        },
    }
}

fn directory(path: &[u8], mode: u32) -> File<'_> {
    File {
        content: Content::Directory,
        mode,
        ..file(path, b"")
    }
}

fn install_inventory(
    bytes: &[u8],
    source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) {
    assert_eq!(
        write_file_at(package_upgrade::INSTALLED, 0, bytes, 0o600, true, source),
        Ok(bytes.len())
    );
    sync_persistence().unwrap();
}

#[test]
fn package_upgrade_directories_activate_nested_parents_and_metadata_without_losing_user_children() {
    let _guard = TestGuard::acquire();
    let (image, journal, _) = computer();
    let mut source = image_host(&image);
    let before = manifest(
        b"1",
        &[
            directory(b"/dir", 0o755),
            file(b"/dir/nested.txt", b"nested\n"),
            file(b"/hello.txt", b"hello sffs\n"),
        ],
    );
    install_inventory(&before, &mut source);
    write_file_at(b"/dir/user", 0, b"user-created", 0o644, true, &mut source).unwrap();
    let after = manifest(
        b"2",
        &[
            File {
                uid: 12,
                gid: 34,
                ..directory(b"/dir", 0o2750)
            },
            file(b"/dir/nested.txt", b"updated"),
            file(b"/hello.txt", b"hello sffs\n"),
            directory(b"/new", 0o2775),
            directory(b"/new/sub", 0o755),
            file(b"/new/sub/pkg", b"package"),
        ],
    );
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    for index in 0..upgrade.action_count() {
        let bytes = match upgrade.action_path(index).unwrap() {
            b"/dir/nested.txt" => b"updated".as_slice(),
            b"/new/sub/pkg" => b"package",
            _ => b"",
        };
        upgrade
            .stage(index, 0, bytes, &table, &token, &mut source)
            .unwrap();
    }
    verify_staged(&mut upgrade, &table, &token, &mut source);
    assert!(matches!(lstat(b"/new"), Err(Errno::ENOENT)));
    assert_eq!(lstat(b"/dir").unwrap().st_mode & 0o7777, 0o755);
    upgrade.commit(&table, &token).unwrap();
    drop(upgrade);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    let stat = lstat(b"/dir").unwrap();
    assert_eq!(
        (stat.st_mode & 0o7777, stat.st_uid, stat.st_gid),
        (0o2750, 12, 34)
    );
    assert_eq!(contents(b"/dir/user", &mut source), b"user-created");
    assert_eq!(contents(b"/new/sub/pkg", &mut source), b"package");
    assert_eq!(lstat(b"/new").unwrap().st_nlink, 3);
    assert_eq!(lstat(b"/new/sub").unwrap().st_nlink, 2);
    write_file_at(
        b"/new/sub/user-added",
        0,
        b"new user data",
        0o644,
        true,
        &mut source,
    )
    .unwrap();
    let mut rollback = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut rollback, &table, &token, &mut source);
    verify_staged(&mut rollback, &table, &token, &mut source);
    rollback.commit(&table, &token).unwrap();
    let stat = lstat(b"/dir").unwrap();
    assert_eq!(
        (stat.st_mode & 0o7777, stat.st_uid, stat.st_gid),
        (0o755, 0, 0)
    );
    assert_eq!(contents(b"/dir/nested.txt", &mut source), b"nested\n");
    assert_eq!(contents(b"/dir/user", &mut source), b"user-created");
    assert!(matches!(lstat(b"/new/sub/pkg"), Err(Errno::ENOENT)));
    assert_eq!(
        contents(b"/new/sub/user-added", &mut source),
        b"new user data"
    );
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
    package_upgrade::discard_transaction(&table, &token, &mut source).unwrap();
    assert_eq!(
        contents(b"/new/sub/user-added", &mut source),
        b"new user data"
    );
}

#[test]
fn package_upgrade_removed_directories_retain_user_children_and_require_metadata_consistency_for_rollback()
 {
    let _guard = TestGuard::acquire();
    let (image, _journal, _) = computer();
    let mut source = image_host(&image);
    let before = manifest(
        b"1",
        &[
            directory(b"/dir", 0o755),
            file(b"/hello.txt", b"hello sffs\n"),
        ],
    );
    install_inventory(&before, &mut source);
    let after = manifest(b"2", &[file(b"/hello.txt", b"hello sffs\n")]);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    upgrade.commit(&table, &token).unwrap();
    drop(upgrade);
    assert_eq!(contents(b"/dir/nested.txt", &mut source), b"nested\n");
    chmod(b"/dir", 0o700).unwrap();
    let mut rollback = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
    assert!(matches!(
        rollback.verify_next(&table, &token, 1024, &mut source),
        Err(Error::Verification(_))
    ));
    assert_eq!(lstat(b"/dir").unwrap().st_mode & 0o7777, 0o700);
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), after);
}

#[test]
fn package_upgrade_discards_only_empty_private_staged_directories() {
    let _guard = TestGuard::acquire();
    let (image, _journal, before) = computer();
    let after = manifest(
        b"2",
        &[
            file(b"/hello.txt", b"hello sffs\n"),
            directory(b"/new", 0o755),
        ],
    );
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"", &table, &token, &mut source)
        .unwrap();
    let child = b"/var/lib/kandelo/packages/transaction/new/00000000/user";
    write_file_at(child, 0, b"unexpected", 0o644, true, &mut source).unwrap();
    assert_eq!(
        package_upgrade::discard_transaction(&table, &token, &mut source),
        Err(Error::InvalidState)
    );
    assert_eq!(contents(child, &mut source), b"unexpected");
    unlink(child).unwrap();
    package_upgrade::discard_transaction(&table, &token, &mut source).unwrap();
    assert!(matches!(lstat(b"/new"), Err(Errno::ENOENT)));
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
}

pub(super) fn computer() -> (Vec<u8>, SharedJournalStorage, Vec<u8>) {
    let image = tiny_vfs_described().to_vec();
    let mut source = image_host(&image);
    load_image(image.len() as u64, &mut source).unwrap();
    let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(
        Box::new(journal.clone()),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    mkdir_parents_checked(package_inventory::STATE_ROOT, 0o700, 0, 0).unwrap();
    mkdir(package_inventory::STATE_ROOT, 0o700, 0, 0).unwrap();
    let before = manifest(b"1", &[file(b"/hello.txt", b"hello sffs\n")]);
    stage_leaf_bytes(package_upgrade::INSTALLED, &before, &mut source);
    chmod(package_upgrade::INSTALLED, 0o600).unwrap();
    stage_leaf_bytes(b"/user-post", b"retain database and uploads", &mut source);
    sync_persistence().unwrap();
    drop(source);
    (image, journal, before)
}

fn verify_live(
    upgrade: &mut Upgrade,
    table: &ProcessTable,
    token: &crate::process_table::MaintenanceToken,
    source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) {
    while !upgrade.verify_next(table, token, 1024, source).unwrap() {}
}

fn verify_staged(
    upgrade: &mut Upgrade,
    table: &ProcessTable,
    token: &crate::process_table::MaintenanceToken,
    source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) {
    while !upgrade
        .verify_staged_next(table, token, 1024, source)
        .unwrap()
    {}
}

pub(super) fn contents(
    path: &[u8],
    source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Vec<u8> {
    let mut bytes = vec![0; lstat(path).unwrap().st_size as usize];
    let count = read_file_at(path, 0, &mut bytes, source).unwrap();
    assert_eq!(count, bytes.len());
    bytes
}

#[test]
fn package_upgrade_and_rollback_recover_with_user_data_untouched() {
    let _guard = TestGuard::acquire();
    let (image, journal, before) = computer();
    let after = manifest(
        b"2",
        &[
            file(b"/hello.txt", b"updated software"),
            file(b"/new-file", b"new"),
        ],
    );
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    assert_eq!(upgrade.action_count(), 2);
    assert_eq!(
        upgrade.commit(&table, &token),
        Err(Error::Storage(Errno::EBUSY))
    );
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::Transaction(Phase::Pending)
    );
    upgrade
        .stage(0, 0, b"updated software", &table, &token, &mut source)
        .unwrap();
    upgrade
        .stage(1, 0, b"new", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    upgrade.commit(&table, &token).unwrap();
    assert_eq!(contents(b"/hello.txt", &mut source), b"updated software");
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), after);
    drop(upgrade);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal.clone()),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::Transaction(Phase::Active)
    );
    let mut rollback = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut rollback, &table, &token, &mut source);
    verify_staged(&mut rollback, &table, &token, &mut source);
    rollback.commit(&table, &token).unwrap();
    drop(rollback);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::Transaction(Phase::RolledBack)
    );
    assert_eq!(contents(b"/hello.txt", &mut source), b"hello sffs\n");
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
    assert!(matches!(lstat(b"/new-file"), Err(Errno::ENOENT)));
    assert_eq!(
        contents(b"/user-post", &mut source),
        b"retain database and uploads"
    );
    package_upgrade::discard_transaction(&table, &token, &mut source).unwrap();
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::None
    );
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
}

#[test]
fn package_upgrade_refuses_modified_owned_files_and_unowned_collisions_before_staging() {
    let _guard = TestGuard::acquire();
    let (image, _journal, before) = computer();
    let mut source = image_host(&image);
    write_file_at(b"/hello.txt", 0, b"user-edited", 0o644, true, &mut source).unwrap();
    let after = manifest(b"2", &[file(b"/hello.txt", b"replacement")]);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    assert!(matches!(
        upgrade.verify_next(&table, &token, 1024, &mut source),
        Err(Error::Verification(_))
    ));
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
    assert!(matches!(
        lstat(b"/var/lib/kandelo/packages/transaction"),
        Err(Errno::ENOENT)
    ));
    assert_eq!(contents(b"/hello.txt", &mut source), b"user-edited");
    let after = manifest(
        b"2",
        &[
            file(b"/hello.txt", b"hello sffs\n"),
            file(b"/user-post", b"replacement"),
        ],
    );
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    assert!(matches!(
        upgrade.verify_next(&table, &token, 1024, &mut source),
        Err(Error::Verification(_))
    ));
    assert_eq!(
        contents(b"/user-post", &mut source),
        b"retain database and uploads"
    );
}

#[test]
fn pending_package_upgrade_resumes_after_reload_and_preserves_unmodified_upstream_user_edits() {
    let _guard = TestGuard::acquire();
    let (image, journal, _before) = computer();
    let after = manifest(
        b"2",
        &[
            file(b"/hello.txt", b"hello sffs\n"),
            file(b"/new-file", b"new"),
        ],
    );
    let mut source = image_host(&image);
    write_file_at(b"/hello.txt", 0, b"user-edited", 0o644, true, &mut source).unwrap();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    assert_eq!(upgrade.action_count(), 1);
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"n", &table, &token, &mut source)
        .unwrap();
    sync_persistence().unwrap();
    drop(upgrade);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    let mut upgrade = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade
        .stage(0, 1, b"ew", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    upgrade.commit(&table, &token).unwrap();
    assert_eq!(contents(b"/hello.txt", &mut source), b"user-edited");
    assert_eq!(contents(b"/new-file", &mut source), b"new");
}

#[test]
fn package_upgrade_refuses_corrupt_staged_content_and_changed_receipts() {
    let _guard = TestGuard::acquire();
    let (image, _journal, before) = computer();
    let after = manifest(b"2", &[file(b"/hello.txt", b"new")]);
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"bad", &table, &token, &mut source)
        .unwrap();
    assert!(matches!(
        upgrade.verify_staged_next(&table, &token, 1024, &mut source),
        Err(Error::Verification(_))
    ));
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
    drop(upgrade);
    let mut upgrade = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.restart_staging_file(0, &table, &token).unwrap();
    upgrade
        .stage(0, 0, b"new", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    write_file_at(
        b"/var/lib/kandelo/packages/transaction/after",
        0,
        b"bad",
        0o600,
        false,
        &mut source,
    )
    .unwrap();
    assert!(matches!(
        upgrade.commit(&table, &token),
        Err(Error::Verification(_))
    ));
    assert_eq!(contents(b"/hello.txt", &mut source), b"hello sffs\n");
}

#[test]
fn package_upgrade_durable_lazy_replacement_survives_reopen_without_fetching_until_used() {
    let _guard = TestGuard::acquire();
    let (image, journal, _before) = computer();
    let provider = crate::sdef::encode(
        &[],
        &[crate::sdef::DeferredRecord {
            ino: 1,
            size: 5,
            archive_id: 0,
            source_path: Vec::new(),
            uri: b"https://packages.invalid/new".to_vec(),
            digest: Sha256::digest(b"hello").into(),
            payload: Vec::new(),
        }],
    )
    .unwrap();
    let after = manifest(
        b"2",
        &[File {
            content: Content::Deferred {
                size: 5,
                digest: Sha256::digest(b"hello").into(),
                provider: &provider,
            },
            ..file(b"/hello.txt", b"hello")
        }],
    );
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    upgrade.commit(&table, &token).unwrap();
    drop(upgrade);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::Transaction(Phase::Active)
    );
    assert_eq!(lazy_info(b"/hello.txt").unwrap().2, 5);
    let mut fetched = 0;
    let mut output = [0; 5];
    assert_eq!(
        read_file_at(
            b"/hello.txt",
            0,
            &mut output,
            &mut |request: ByteReq, bytes: &mut [u8]| {
                match request {
                    ByteReq::Deferred { uri, offset } if uri == b"https://packages.invalid/new" => {
                        fetched += 1;
                        let start = (offset as usize).min(5);
                        let count = bytes.len().min(5 - start);
                        bytes[..count].copy_from_slice(&b"hello"[start..start + count]);
                        Ok(count)
                    }
                    ByteReq::DiscardDeferred { .. } => Ok(0),
                    request => source(request, bytes),
                }
            }
        ),
        Ok(5)
    );
    assert_eq!(&output, b"hello");
    assert!(fetched > 0);
}

#[test]
fn interrupted_private_staging_can_be_discarded_without_touching_installed_files() {
    let _guard = TestGuard::acquire();
    let (image, _journal, before) = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let root = b"/var/lib/kandelo/packages/transaction";
    mkdir(root, 0o700, 0, 0).unwrap();
    mkdir(b"/var/lib/kandelo/packages/transaction/new", 0o700, 0, 0).unwrap();
    stage_leaf_bytes(
        b"/var/lib/kandelo/packages/transaction/new/00000000",
        b"partial",
        &mut source,
    );
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::Incomplete
    );
    package_upgrade::discard_transaction(&table, &token, &mut source).unwrap();
    assert_eq!(
        package_upgrade::recovery(&table, &token, &mut source).unwrap(),
        Recovery::None
    );
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
    assert_eq!(contents(b"/hello.txt", &mut source), b"hello sffs\n");
    assert_eq!(
        contents(b"/user-post", &mut source),
        b"retain database and uploads"
    );
}

#[derive(Default)]
struct Fault {
    remaining: Option<usize>,
    uncertain_flush: bool,
    wrote: bool,
}

struct Interruptible {
    inner: SharedJournalStorage,
    fault: Arc<Mutex<Fault>>,
}

#[test]
fn package_upgrade_remaps_colliding_archive_ids_without_replacing_old_bindings() {
    let _guard = TestGuard::acquire();
    let (image, journal, _before) = computer();
    let make_provider = |uri: &[u8]| {
        crate::sdef::encode(
            &[crate::sdef::DeferredArchive {
                archive_id: 41,
                bytes: TINY_ZIP.len() as u64,
                uri: uri.to_vec(),
                digest: Sha256::digest(TINY_ZIP).into(),
                payload: Vec::new(),
            }],
            &[crate::sdef::DeferredRecord {
                ino: 1,
                size: 6,
                archive_id: 41,
                source_path: b"etc/small.txt".to_vec(),
                uri: Vec::new(),
                digest: Sha256::digest(b"hello\n").into(),
                payload: Vec::new(),
            }],
        )
        .unwrap()
    };
    let old = make_provider(b"https://packages.invalid/old");
    let next = make_provider(b"https://packages.invalid/next");
    stage_persistent_deferred_file(b"/old-lazy", &old, 0o644, 0, 0).unwrap();
    let after = manifest(
        b"2",
        &[File {
            content: Content::Deferred {
                size: 6,
                digest: Sha256::digest(b"hello\n").into(),
                provider: &next,
            },
            ..file(b"/hello.txt", b"hello\n")
        }],
    );
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    upgrade.commit(&table, &token).unwrap();
    drop(upgrade);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    assert_eq!(lazy_info(b"/old-lazy").unwrap().3, 41);
    assert_ne!(lazy_info(b"/hello.txt").unwrap().3, 41);
    ROOTFS.with(|state| {
        assert_eq!(
            state.archives.get(&41).unwrap().uri.as_ref(),
            b"https://packages.invalid/old"
        );
        let id = state
            .archives
            .iter()
            .find(|(_, entry)| entry.uri.as_ref() == b"https://packages.invalid/next")
            .unwrap()
            .0;
        assert_ne!(*id, 41);
    });
}

#[test]
fn package_upgrade_allocation_refusal_keeps_the_old_namespace_and_allows_retry() {
    let _guard = TestGuard::acquire();
    let (image, journal, before) = computer();
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"updated", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    sync_persistence().unwrap();
    let original = journal.0.lock().clone();
    let quota = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
    assert_eq!(
        upgrade.commit(&table, &token),
        Err(Error::Storage(Errno::ENOMEM))
    );
    drop(quota);
    assert_eq!(*journal.0.lock(), original);
    assert_eq!(contents(package_upgrade::INSTALLED, &mut source), before);
    upgrade.commit(&table, &token).unwrap();
    assert_eq!(contents(b"/hello.txt", &mut source), b"updated");
}

#[test]
fn discarded_upgrade_handles_cannot_change_the_next_transactions_staging() {
    let _guard = TestGuard::acquire();
    let (image, _journal, _before) = computer();
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut old = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut old, &table, &token, &mut source);
    old.prepare(&table, &token, &mut source).unwrap();
    package_upgrade::discard_transaction(&table, &token, &mut source).unwrap();
    let mut current = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut current, &table, &token, &mut source);
    current.prepare(&table, &token, &mut source).unwrap();
    current
        .stage(0, 0, b"updated", &table, &token, &mut source)
        .unwrap();
    assert!(matches!(
        old.restart_staging_file(0, &table, &token),
        Err(Error::Verification(_))
    ));
    assert!(matches!(
        old.stage(0, 0, b"invalid", &table, &token, &mut source),
        Err(Error::Verification(_))
    ));
    verify_staged(&mut current, &table, &token, &mut source);
    current.commit(&table, &token).unwrap();
    assert_eq!(contents(b"/hello.txt", &mut source), b"updated");
}

#[test]
fn package_upgrade_discard_bounds_control_paths_as_well_as_staged_leaves() {
    let _guard = TestGuard::acquire();
    let mut leaves = crate::IoBuffer::new();
    for _ in 0..8198 {
        package_upgrade::push_discard_leaf(&mut leaves, b"").unwrap();
    }
    assert_eq!(
        package_upgrade::push_discard_leaf(
            &mut leaves,
            b"/var/lib/kandelo/packages/transaction/pending"
        ),
        Err(Error::InvalidState)
    );
    assert_eq!(leaves.len(), 8198);
}

#[test]
fn package_upgrade_progress_reports_actual_bounded_verification_and_staging_work() {
    use package_upgrade::VerificationTarget;
    let _guard = TestGuard::acquire();
    let (image, _journal, _before) = computer();
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    assert_eq!(upgrade.progress().changed_files, 1);
    let file = upgrade.staging_file(0).unwrap().unwrap();
    assert_eq!(file.path, b"/hello.txt");
    assert_eq!(file.upload_size, Some(7));
    assert!(!upgrade.verify_next(&table, &token, 1, &mut source).unwrap());
    let progress = upgrade.progress();
    assert_eq!(
        progress.current,
        Some((VerificationTarget::Installed, b"/hello.txt".as_slice()))
    );
    assert_eq!(progress.verified_bytes, 1);
    assert_eq!(progress.total_bytes, 11);
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"updated", &table, &token, &mut source)
        .unwrap();
    assert!(
        !upgrade
            .verify_staged_next(&table, &token, 1, &mut source)
            .unwrap()
    );
    let progress = upgrade.progress();
    assert_eq!(
        progress.current,
        Some((VerificationTarget::Staged, b"/hello.txt".as_slice()))
    );
    assert_eq!(progress.verified_bytes, 1);
    assert_eq!(progress.total_bytes, 7);
    verify_staged(&mut upgrade, &table, &token, &mut source);
    assert!(upgrade.progress().current.is_none());
    assert_eq!(upgrade.progress().installed_files_verified, 1);
    assert_eq!(upgrade.progress().staged_files_verified, 1);
    upgrade.commit(&table, &token).unwrap();
    assert_eq!(upgrade.progress().phase, Phase::Active);
    assert!(matches!(
        upgrade.staging_file(0),
        Err(Error::Storage(Errno::EBUSY))
    ));
}

#[test]
fn same_content_lazy_relocation_retains_durable_local_bytes_through_upgrade_and_rollback() {
    let _guard = TestGuard::acquire();
    let (image, journal, _before) = computer();
    let provider = crate::sdef::encode(
        &[],
        &[crate::sdef::DeferredRecord {
            ino: 1,
            size: 11,
            archive_id: 0,
            source_path: Vec::new(),
            uri: b"https://packages.invalid/unavailable".to_vec(),
            digest: Sha256::digest(b"hello sffs\n").into(),
            payload: Vec::new(),
        }],
    )
    .unwrap();
    let after = manifest(
        b"1",
        &[File {
            content: Content::Deferred {
                size: 11,
                digest: Sha256::digest(b"hello sffs\n").into(),
                provider: &provider,
            },
            ..file(b"/hello.txt", b"hello sffs\n")
        }],
    );
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let original = lstat(b"/hello.txt").unwrap().st_ino;
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    upgrade.commit(&table, &token).unwrap();
    drop(upgrade);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, original);
    assert_eq!(contents(b"/hello.txt", &mut source), b"hello sffs\n");
    let mut rollback = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut rollback, &table, &token, &mut source);
    verify_staged(&mut rollback, &table, &token, &mut source);
    rollback.commit(&table, &token).unwrap();
    assert_eq!(contents(b"/hello.txt", &mut source), b"hello sffs\n");
}

impl OverlayStorage for Interruptible {
    fn len(&mut self) -> Result<u64, Errno> {
        self.inner.len()
    }
    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
        self.inner.read_exact_at(offset, bytes)
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        let mut fault = self.fault.lock();
        let count = fault
            .remaining
            .map_or(bytes.len(), |remaining| remaining.min(bytes.len()));
        self.inner.write_all_at(offset, &bytes[..count])?;
        if let Some(remaining) = &mut fault.remaining {
            *remaining -= count;
        }
        fault.wrote = true;
        if count == bytes.len() {
            Ok(())
        } else {
            Err(Errno::EIO)
        }
    }
    fn flush(&mut self) -> Result<(), Errno> {
        let fault = self.fault.lock();
        if fault.wrote && fault.uncertain_flush {
            Err(Errno::EIO)
        } else {
            self.inner.flush()
        }
    }
    fn truncate(&mut self, length: u64) -> Result<(), Errno> {
        self.inner.truncate(length)
    }
}

#[test]
fn package_upgrade_and_rollback_every_torn_commit_recover_one_complete_set() {
    let _guard = TestGuard::acquire();
    let (image, journal, _) = computer();
    let mut source = image_host(&image);
    let before = manifest(
        b"1",
        &[
            directory(b"/dir", 0o755),
            file(b"/hello.txt", b"hello sffs\n"),
        ],
    );
    install_inventory(&before, &mut source);
    let after = manifest(
        b"2",
        &[
            directory(b"/dir", 0o2750),
            file(b"/hello.txt", b"updated software"),
            directory(b"/new", 0o755),
        ],
    );
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut upgrade = Upgrade::begin(&after, &table, &token, 55, [7; 32], &mut source).unwrap();
    verify_live(&mut upgrade, &table, &token, &mut source);
    upgrade.prepare(&table, &token, &mut source).unwrap();
    upgrade
        .stage(0, 0, b"", &table, &token, &mut source)
        .unwrap();
    upgrade
        .stage(1, 0, b"updated software", &table, &token, &mut source)
        .unwrap();
    upgrade
        .stage(2, 0, b"", &table, &token, &mut source)
        .unwrap();
    verify_staged(&mut upgrade, &table, &token, &mut source);
    let pending = journal.0.lock().clone();
    upgrade.commit(&table, &token).unwrap();
    let active = journal.0.lock().clone();
    drop(upgrade);
    for (snapshot, old_phase, next_phase) in [
        (&pending, Phase::Pending, Phase::Active),
        (&active, Phase::Active, Phase::RolledBack),
    ] {
        load_image(image.len() as u64, &mut source).unwrap();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(snapshot.clone())));
        enable_resizable_persistence(
            Box::new(storage.clone()),
            Sha256::digest(&image).into(),
            &mut source,
        )
        .unwrap();
        let mut upgrade = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
        verify_live(&mut upgrade, &table, &token, &mut source);
        verify_staged(&mut upgrade, &table, &token, &mut source);
        upgrade.commit(&table, &token).unwrap();
        let length = storage.0.lock().len() - snapshot.len();
        drop(upgrade);
        for cut in 0..=length {
            load_image(image.len() as u64, &mut source).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(snapshot.clone())));
            let fault = Arc::new(Mutex::new(Fault::default()));
            enable_resizable_persistence(
                Box::new(Interruptible {
                    inner: storage.clone(),
                    fault: fault.clone(),
                }),
                Sha256::digest(&image).into(),
                &mut source,
            )
            .unwrap();
            let mut upgrade = Upgrade::resume(&table, &token, 55, [7; 32], &mut source).unwrap();
            verify_live(&mut upgrade, &table, &token, &mut source);
            verify_staged(&mut upgrade, &table, &token, &mut source);
            *fault.lock() = Fault {
                remaining: Some(cut),
                uncertain_flush: cut == length,
                wrote: false,
            };
            assert_eq!(
                upgrade.commit(&table, &token),
                Err(Error::Storage(Errno::EIO)),
                "phase={old_phase:?}, cut={cut}"
            );
            assert_eq!(
                contents(package_upgrade::INSTALLED, &mut source),
                if old_phase == Phase::Active {
                    &after
                } else {
                    &before
                }
                .as_slice()
            );
            drop(upgrade);
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(
                Box::new(storage),
                Sha256::digest(&image).into(),
                &mut source,
            )
            .unwrap();
            let expected = if cut == length { next_phase } else { old_phase };
            assert_eq!(
                package_upgrade::recovery(&table, &token, &mut source).unwrap(),
                Recovery::Transaction(expected),
                "phase={old_phase:?}, cut={cut}"
            );
            assert_eq!(
                lstat(b"/dir").unwrap().st_mode & 0o7777,
                if expected == Phase::Active {
                    0o2750
                } else {
                    0o755
                }
            );
            assert_eq!(lstat(b"/new").is_ok(), expected != Phase::Pending);
            assert_eq!(
                contents(package_upgrade::INSTALLED, &mut source),
                if expected == Phase::Active {
                    &after
                } else {
                    &before
                }
                .as_slice()
            );
            assert_eq!(
                contents(b"/hello.txt", &mut source),
                if expected == Phase::Active {
                    b"updated software".as_slice()
                } else {
                    b"hello sffs\n"
                }
            );
            assert_eq!(
                contents(b"/user-post", &mut source),
                b"retain database and uploads"
            );
        }
    }
}
