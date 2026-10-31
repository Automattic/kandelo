use super::*;
use crate::package_inventory::{Content, File};
use crate::process_table::{MaintenanceToken, ProcessTable};
use crate::rootfs::package_plan::{Conflict, FileVerification, VerificationError, VerifiedFile};

fn computer() -> Vec<u8> {
    let image = tiny_vfs_described().to_vec();
    let digest = Sha256::digest(&image).into();
    let mut source = image_host(&image);
    load_image(image.len() as u64, &mut source).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
    drop(source);
    image
}

fn regular<'a>(path: &'a [u8], bytes: &[u8]) -> File<'a> {
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

fn complete(
    mut verification: FileVerification,
    table: &ProcessTable,
    token: &MaintenanceToken,
    source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> VerifiedFile {
    while !verification.is_complete() {
        verification.read_more(table, token, 1024, source).unwrap();
    }
    verification.finish(table, token).unwrap()
}

#[test]
fn verifies_package_bytes_in_bounded_steps_and_releases_its_handle() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut source = image_host(&image);
    let bytes: Vec<u8> = (0..45_000u32).map(|number| (number % 251) as u8).collect();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let expected = regular(b"/big.txt", &bytes);
    let mut verification = FileVerification::begin(&expected, &table, &token).unwrap();
    assert_eq!(verification.verified_bytes(), 0);
    assert_eq!(
        verification.read_more(&table, &token, 1000, &mut source),
        Ok(false)
    );
    assert_eq!(verification.verified_bytes(), 1000);
    assert_eq!(verification.total_bytes(), 45000);
    let verified = complete(verification, &table, &token, &mut source);
    verified.revalidate(&table, &token).unwrap();
    assert_eq!(verified.inode(), Some(lstat(b"/big.txt").unwrap().st_ino));
    assert_eq!(
        ROOTFS.with(|state| state
            .inodes
            .iter()
            .flatten()
            .map(|inode| inode.open_count)
            .sum::<u32>()),
        0
    );
}

#[test]
fn user_modified_package_contents_are_conflicts_not_new_baselines() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut source = image_host(&image);
    write_file_at(b"/hello.txt", 0, b"evil! sffs\n", 0o644, false, &mut source).unwrap();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let expected = regular(b"/hello.txt", b"hello sffs\n");
    let mut verification = FileVerification::begin(&expected, &table, &token).unwrap();
    assert_eq!(
        verification.read_more(&table, &token, 64 * 1024, &mut source),
        Err(VerificationError::Conflict(Conflict::Contents))
    );
    assert!(matches!(
        verification.finish(&table, &token),
        Err(VerificationError::Conflict(Conflict::Contents))
    ));
    let mut bytes = [0; 11];
    assert_eq!(
        read_file_at(b"/hello.txt", 0, &mut bytes, &mut source),
        Ok(11)
    );
    assert_eq!(&bytes, b"evil! sffs\n");
}

#[test]
fn collision_and_missing_owned_file_checks_preserve_user_files() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    assert!(matches!(
        VerifiedFile::verify_absence(b"/hello.txt", &table, &token),
        Err(VerificationError::Conflict(Conflict::UnownedCollision))
    ));
    let absence = VerifiedFile::verify_absence(b"/new", &table, &token).unwrap();
    write_file_at(b"/new", 0, b"user-created", 0o644, true, &mut source).unwrap();
    assert_eq!(
        absence.revalidate(&table, &token),
        Err(VerificationError::Conflict(Conflict::UnownedCollision))
    );
    unlink(b"/hello.txt").unwrap();
    assert!(matches!(
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token),
        Err(VerificationError::Conflict(Conflict::MissingOwnedFile))
    ));
}

#[test]
fn metadata_and_symlink_changes_are_not_followed_or_overwritten() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    chmod(b"/hello.txt", 0o600).unwrap();
    assert!(matches!(
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token),
        Err(VerificationError::Conflict(Conflict::Metadata))
    ));
    let expected_link = File {
        path: b"/link",
        package: 0,
        mode: 0o777,
        uid: 0,
        gid: 0,
        content: Content::Symlink(b"hello.txt"),
    };
    assert!(
        FileVerification::begin(&expected_link, &table, &token)
            .unwrap()
            .is_complete()
    );
    assert!(matches!(
        FileVerification::begin(&regular(b"/link", b"hello sffs\n"), &table, &token),
        Err(VerificationError::Conflict(Conflict::FileType))
    ));
    unlink(b"/link").unwrap();
    symlink(b"big.txt", b"/link", 0, 0).unwrap();
    assert!(matches!(
        FileVerification::begin(&expected_link, &table, &token),
        Err(VerificationError::Conflict(Conflict::Contents))
    ));
    let mut bytes = [0; 11];
    assert_eq!(
        read_file_at(b"/hello.txt", 0, &mut bytes, &mut source),
        Ok(11)
    );
    assert_eq!(&bytes, b"hello sffs\n");
}

#[test]
fn transient_reads_resume_without_rehashing_previously_verified_bytes() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let bytes: Vec<u8> = (0..45_000u32).map(|number| (number % 251) as u8).collect();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let mut verification =
        FileVerification::begin(&regular(b"/big.txt", &bytes), &table, &token).unwrap();
    assert_eq!(
        verification.read_more(&table, &token, 1024, &mut |_, _| Err(Errno::EAGAIN)),
        Err(VerificationError::Storage(Errno::EAGAIN))
    );
    assert_eq!(verification.verified_bytes(), 0);
    let mut source = image_host(&image);
    verification
        .read_more(&table, &token, 1024, &mut source)
        .unwrap();
    assert_eq!(verification.verified_bytes(), 1024);
    let mut failed = false;
    while !failed {
        let before = verification.verified_bytes();
        let result = verification.read_more(&table, &token, 1024, &mut |_, output| {
            failed = true;
            output.fill(0xa5);
            Err(Errno::EAGAIN)
        });
        if failed {
            assert_eq!(result, Err(VerificationError::Storage(Errno::EAGAIN)));
            assert_eq!(verification.verified_bytes(), before);
        } else {
            assert!(!result.unwrap());
        }
    }
    complete(verification, &table, &token, &mut source);
}

#[test]
fn verified_files_detect_subsequent_edits_and_stale_maintenance_authority() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let verification =
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token).unwrap();
    let verified = complete(verification, &table, &token, &mut source);
    write_file_at(b"/hello.txt", 0, b"evil! sffs\n", 0o644, false, &mut source).unwrap();
    assert_eq!(
        verified.revalidate(&table, &token),
        Err(VerificationError::Conflict(
            Conflict::ChangedDuringVerification
        ))
    );
    table.leave_maintenance(&token).unwrap();
    let current = table.enter_maintenance().unwrap();
    assert_eq!(
        verified.revalidate(&table, &token),
        Err(VerificationError::Storage(Errno::EPERM))
    );
    assert_eq!(
        verified.revalidate(&table, &current),
        Err(VerificationError::Storage(Errno::EPERM))
    );
    table.leave_maintenance(&current).unwrap();
}

#[test]
fn reload_invalidates_proofs_even_when_inode_metadata_is_reused() {
    let _guard = TestGuard::acquire();
    let mut image = computer();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let verified = complete(
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token).unwrap(),
        &table,
        &token,
        &mut image_host(&image),
    );
    let offset = image
        .windows(11)
        .position(|bytes| bytes == b"hello sffs\n")
        .unwrap();
    image[offset..offset + 11].copy_from_slice(b"evil! sffs\n");
    load_image(image.len() as u64, &mut image_host(&image)).unwrap();
    assert_eq!(verified.inode(), Some(lstat(b"/hello.txt").unwrap().st_ino));
    assert_eq!(
        verified.revalidate(&table, &token),
        Err(VerificationError::ExpiredFilesystem)
    );
}

#[test]
fn dropping_a_verifier_from_an_old_filesystem_does_not_close_a_new_handle() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let old =
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token).unwrap();
    load_image(image.len() as u64, &mut image_host(&image)).unwrap();
    let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
    drop(old);
    assert_eq!(
        ROOTFS.with(|state| state
            .inodes
            .iter()
            .flatten()
            .map(|inode| inode.open_count)
            .sum::<u32>()),
        1
    );
    let mut bytes = [0; 11];
    assert_eq!(read(handle, 0, &mut bytes, &mut image_host(&image)), Ok(11));
    assert_eq!(&bytes, b"hello sffs\n");
    release_handle(handle);
}

#[test]
fn failed_verifier_allocation_and_cancellation_release_open_handles() {
    let _guard = TestGuard::acquire();
    let _image = computer();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let quota = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
    assert!(matches!(
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token),
        Err(VerificationError::Storage(Errno::ENOMEM))
    ));
    drop(quota);
    assert_eq!(
        ROOTFS.with(|state| state
            .inodes
            .iter()
            .flatten()
            .map(|inode| inode.open_count)
            .sum::<u32>()),
        0
    );
    let verification =
        FileVerification::begin(&regular(b"/hello.txt", b"hello sffs\n"), &table, &token).unwrap();
    drop(verification);
    assert_eq!(
        ROOTFS.with(|state| state
            .inodes
            .iter()
            .flatten()
            .map(|inode| inode.open_count)
            .sum::<u32>()),
        0
    );
}

#[test]
fn directory_checks_ignore_user_created_children_but_not_permissions() {
    let _guard = TestGuard::acquire();
    let image = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let expected = File {
        path: b"/dir",
        package: 0,
        mode: 0o755,
        uid: 0,
        gid: 0,
        content: Content::Directory,
    };
    let verified = FileVerification::begin(&expected, &table, &token)
        .unwrap()
        .finish(&table, &token)
        .unwrap();
    write_file_at(b"/dir/user-data", 0, b"keep", 0o644, true, &mut source).unwrap();
    verified.revalidate(&table, &token).unwrap();
    chmod(b"/dir", 0o700).unwrap();
    assert_eq!(
        verified.revalidate(&table, &token),
        Err(VerificationError::Conflict(
            Conflict::ChangedDuringVerification
        ))
    );
}

#[test]
fn matching_immutable_provider_is_verified_without_fetching_old_package_bytes() {
    let _guard = TestGuard::acquire();
    let _image = computer();
    let digest = Sha256::digest(b"hello").into();
    let record = crate::sdef::DeferredRecord {
        ino: 1,
        size: 5,
        archive_id: 0,
        source_path: Vec::new(),
        uri: b"https://packages.invalid/unavailable-old-build".to_vec(),
        digest,
        payload: Vec::new(),
    };
    let provider = crate::sdef::encode(&[], &[record]).unwrap();
    stage_persistent_deferred_file(b"/package", &provider, 0o755, 0, 0).unwrap();
    let mut table = ProcessTable::new();
    let token = table.enter_maintenance().unwrap();
    let expected = File {
        mode: 0o755,
        ..regular(b"/package", b"hello")
    };
    let mut verification = FileVerification::begin(&expected, &table, &token).unwrap();
    assert!(verification.is_complete());
    assert_eq!(
        verification.read_more(&table, &token, 1024, &mut |_, _| panic!(
            "verified binding must not fetch"
        )),
        Ok(true)
    );
    verification.finish(&table, &token).unwrap();
}
