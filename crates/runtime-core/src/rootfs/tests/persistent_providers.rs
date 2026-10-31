use super::*;
use crate::sdef::{DeferredArchive, DeferredRecord};

fn roomy_image() -> Vec<u8> {
    use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
    let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(2 * 1024 * 1024)).unwrap();
    writer.declare_deferred_section().unwrap();
    let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
    crate::vfsi_container::wrap(
        &body,
        &crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        },
    )
    .unwrap()
}

fn provider(archive: bool, payload_bytes: usize) -> Vec<u8> {
    let data: &[u8] = if archive {
        b"hello\n"
    } else {
        b"new packaged payload"
    };
    let record = DeferredRecord {
        ino: 1,
        size: data.len() as u64,
        archive_id: if archive { 71 } else { 0 },
        source_path: if archive {
            b"etc/small.txt".to_vec()
        } else {
            Vec::new()
        },
        uri: if archive {
            Vec::new()
        } else {
            b"https://packages.invalid/program".to_vec()
        },
        digest: Sha256::digest(data).into(),
        payload: vec![b'p'; payload_bytes],
    };
    let archives = if archive {
        vec![DeferredArchive {
            archive_id: 71,
            bytes: TINY_ZIP.len() as u64,
            uri: b"https://packages.invalid/archive".to_vec(),
            digest: Sha256::digest(TINY_ZIP).into(),
            payload: vec![b'a'; payload_bytes],
        }]
    } else {
        Vec::new()
    };
    crate::sdef::encode(&archives, &[record]).unwrap()
}

fn source<'a>(image: &'a [u8]) -> impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno> + 'a {
    move |request, output| {
        let (bytes, offset) = match request {
            ByteReq::Image { offset } => (image, offset),
            ByteReq::Deferred { uri, offset } if uri == b"https://packages.invalid/program" => {
                (b"new packaged payload".as_slice(), offset)
            }
            ByteReq::Deferred { uri, offset } if uri == b"https://packages.invalid/archive" => {
                (TINY_ZIP, offset)
            }
            ByteReq::DiscardDeferred { .. } => return Ok(0),
            _ => return Err(Errno::ENOENT),
        };
        let start = usize::try_from(offset)
            .map_err(|_| Errno::EIO)?
            .min(bytes.len());
        let count = output.len().min(bytes.len() - start);
        output[..count].copy_from_slice(&bytes[start..start + count]);
        Ok(count)
    }
}

#[test]
fn durable_providers_preserve_full_descriptors_and_reads_after_indexed_compaction() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    for archive in [false, true] {
        for indexed in [false, true] {
            let mut bytes = source(image);
            load_image(image.len() as u64, &mut bytes).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
            let descriptor = provider(archive, crate::sdef::MAX_PAYLOAD_LEN as usize);
            let ino =
                stage_persistent_deferred_file(b"/package", &descriptor, 0o755, 12, 34).unwrap();
            assert_persistent_cached_usage();
            chmod(b"/package", 0o750).unwrap();
            persistent_statfs().unwrap();
            assert_persistent_cached_usage();
            let metadata = lstat(b"/package").unwrap();
            if indexed {
                prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
            }
            let checkpoint_end = compacted.0.lock().len() as u64;
            load_image(image.len() as u64, &mut bytes).unwrap();
            if indexed {
                enable_resizable_persistence_indexed(
                    Box::new(compacted),
                    Box::new(index),
                    digest,
                    checkpoint_end,
                    &mut bytes,
                )
                .unwrap();
            } else {
                enable_resizable_persistence(Box::new(storage), digest, &mut bytes).unwrap();
            }
            let restored = lstat(b"/package").unwrap();
            assert_eq!(restored.st_ino, ino);
            assert_eq!(restored.st_mode, metadata.st_mode);
            assert_eq!((restored.st_uid, restored.st_gid), (12, 34));
            assert_eq!(restored.st_size, metadata.st_size);
            ROOTFS.with(|state| {
                let root = state.mount_root().unwrap();
                let inode = state.get(state.walk(root, &[b"package"]).unwrap()).unwrap();
                assert_eq!(inode.persistent_provider.as_ref(), descriptor.as_slice());
            });
            let mut output = [0; 64];
            let count = read_file_at(b"/package", 0, &mut output, &mut bytes).unwrap();
            assert_eq!(
                &output[..count],
                if archive {
                    b"hello\n".as_slice()
                } else {
                    b"new packaged payload".as_slice()
                }
            );
            persistent_statfs().unwrap();
            assert_persistent_cached_usage();
        }
    }
}

#[test]
fn provider_activation_and_rollback_keep_package_sets_and_user_files() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    let old = lstat(b"/hello.txt").unwrap().st_ino;
    let user = stage_leaf_bytes(b"/user", b"keep my database", &mut bytes);
    let next =
        stage_persistent_deferred_file(b"/staged", &provider(false, 0), 0o755, 0, 0).unwrap();
    let mut edits = [
        namespace_activation::LeafReplacement {
            parent: 1,
            name: b"hello.txt",
            expected: Some(old),
            replacement: Some(next),
        },
        namespace_activation::LeafReplacement {
            parent: 1,
            name: b"rollback",
            expected: None,
            replacement: Some(old),
        },
        namespace_activation::LeafReplacement {
            parent: 1,
            name: b"staged",
            expected: Some(next),
            replacement: None,
        },
    ];
    activate_leaf_edits(&edits).unwrap();
    load_image(image.len() as u64, &mut bytes).unwrap();
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    let mut output = [0; 64];
    assert_eq!(
        read_file_at(b"/hello.txt", 0, &mut output, &mut bytes),
        Ok(20)
    );
    assert_eq!(&output[..20], b"new packaged payload");
    edits[0].expected = Some(next);
    edits[0].replacement = Some(old);
    edits[1].expected = Some(old);
    edits[1].replacement = Some(next);
    activate_leaf_edits(&edits[..2]).unwrap();
    load_image(image.len() as u64, &mut bytes).unwrap();
    enable_resizable_persistence(Box::new(storage), digest, &mut bytes).unwrap();
    assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, old);
    assert_eq!(lstat(b"/user").unwrap().st_ino, user);
    assert_eq!(
        read_file_at(b"/hello.txt", 0, &mut output, &mut bytes),
        Ok(11)
    );
    assert_eq!(&output[..11], b"hello sffs\n");
}

#[test]
fn provider_admission_refuses_bad_versions_missing_hashes_and_live_descriptors_without_writes() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    let before = storage.0.lock().clone();
    let descriptor = provider(false, 0);
    for variant in 0..4 {
        let mut invalid = descriptor.clone();
        match variant {
            0 => invalid[4] = 255,
            1 => invalid
                [crate::sdef::HEADER_SIZE as usize + 32..crate::sdef::HEADER_SIZE as usize + 64]
                .fill(0),
            2 => invalid.push(0),
            _ => {
                invalid.truncate(12);
            }
        }
        assert!(stage_persistent_deferred_file(b"/invalid", &invalid, 0o755, 0, 0).is_err());
        assert!(lstat(b"/invalid").is_err());
        assert_eq!(*storage.0.lock(), before);
    }
    let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
    assert_eq!(
        stage_persistent_deferred_file(b"/busy", &descriptor, 0o755, 0, 0),
        Err(Errno::EBUSY)
    );
    release_handle(handle);
    assert_eq!(
        stage_persistent_deferred_file(b"/setid", &descriptor, 0o4755, 0, 0),
        Err(Errno::EPERM)
    );
    assert_eq!(*storage.0.lock(), before);
}

#[test]
fn provider_archive_id_conflicts_never_replace_the_existing_provider() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    let descriptor = provider(true, 0);
    stage_persistent_deferred_file(b"/first", &descriptor, 0o644, 0, 0).unwrap();
    let before = storage.0.lock().clone();
    assert_eq!(
        set_archive_source(71, b"https://wrong.invalid", &[1; 32]),
        Err(Errno::EBUSY)
    );
    assert_eq!(set_archive_payload(71, b"changed"), Err(Errno::EBUSY));
    let mut conflicting = crate::sdef::decode(&descriptor).unwrap();
    conflicting.archives[0].uri = b"https://packages.invalid/wrong".to_vec();
    let conflicting = crate::sdef::encode(&conflicting.archives, &conflicting.records).unwrap();
    assert_eq!(
        stage_persistent_deferred_file(b"/conflict", &conflicting, 0o644, 0, 0),
        Err(Errno::EIO)
    );
    assert_eq!(*storage.0.lock(), before);
    assert!(lstat(b"/conflict").is_err());
    let mut output = [0; 64];
    assert_eq!(read_file_at(b"/first", 0, &mut output, &mut bytes), Ok(6));
    assert_eq!(&output[..6], b"hello\n");
}

#[test]
fn provider_staging_every_torn_write_and_uncertain_flush_recovers_complete_binding_or_absence() {
    struct InterruptedStorage {
        inner: SharedJournalStorage,
        remaining: usize,
        uncertain_flush: bool,
        wrote: bool,
    }
    impl OverlayStorage for InterruptedStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            self.inner.len()
        }
        fn read_exact_at(&mut self, offset: u64, output: &mut [u8]) -> Result<(), Errno> {
            self.inner.read_exact_at(offset, output)
        }
        fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
            let count = self.remaining.min(bytes.len());
            self.inner.write_all_at(offset, &bytes[..count])?;
            self.remaining -= count;
            self.wrote = true;
            if count == bytes.len() {
                Ok(())
            } else {
                Err(Errno::EIO)
            }
        }
        fn flush(&mut self) -> Result<(), Errno> {
            if self.wrote && self.uncertain_flush {
                Err(Errno::EIO)
            } else {
                self.inner.flush()
            }
        }
        fn truncate(&mut self, length: u64) -> Result<(), Errno> {
            self.inner.truncate(length)
        }
    }
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    let before = storage.0.lock().clone();
    let descriptor = provider(false, 0);
    stage_persistent_deferred_file(b"/staged", &descriptor, 0o755, 0, 0).unwrap();
    let length = storage.0.lock().len() - before.len();
    for cut in 0..=length {
        load_image(image.len() as u64, &mut bytes).unwrap();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(before.clone())));
        enable_resizable_persistence(
            Box::new(InterruptedStorage {
                inner: storage.clone(),
                remaining: cut,
                uncertain_flush: cut == length,
                wrote: false,
            }),
            digest,
            &mut bytes,
        )
        .unwrap();
        let old_tree = export_tree();
        assert_eq!(
            stage_persistent_deferred_file(b"/staged", &descriptor, 0o755, 0, 0),
            Err(Errno::EIO),
            "cut={cut}"
        );
        assert_eq!(export_tree(), old_tree, "cut={cut}");
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0, "cut={cut}");
        let damaged = storage.0.lock().clone();
        assert_eq!(
            stage_persistent_deferred_file(b"/staged", &descriptor, 0o755, 0, 0),
            Err(Errno::EIO)
        );
        assert_eq!(*storage.0.lock(), damaged);
        load_image(image.len() as u64, &mut bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
        assert_eq!(*storage.0.lock(), damaged);
        if cut == length {
            let mut output = [0; 20];
            assert_eq!(read_file_at(b"/staged", 0, &mut output, &mut bytes), Ok(20));
            assert_eq!(&output, b"new packaged payload");
        } else {
            assert!(matches!(lstat(b"/staged"), Err(Errno::ENOENT)), "cut={cut}");
        }
    }
}

#[test]
fn durable_provider_rejects_corrupt_transport_and_unjournaled_descriptor_rewrites() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    stage_persistent_deferred_file(b"/package", &provider(false, 0), 0o755, 0, 0).unwrap();
    let before = storage.0.lock().clone();
    assert_eq!(
        set_deferred_payload(b"/package", b"changed"),
        Err(Errno::EBUSY)
    );
    assert_eq!(
        set_deferred_source(b"/package", b"https://wrong.invalid", &[1; 32]),
        Err(Errno::EBUSY)
    );
    let mut output = [0; 20];
    assert_eq!(
        read_file_at(
            b"/package",
            0,
            &mut output,
            |request, output| match request {
                ByteReq::DiscardDeferred { .. } => Ok(0),
                _ => {
                    output.fill(b'x');
                    Ok(output.len())
                }
            }
        ),
        Err(Errno::EIO)
    );
    assert_eq!(
        read_file_at(b"/package", 0, &mut output, &mut bytes),
        Ok(20)
    );
    assert_eq!(&output, b"new packaged payload");
    assert_eq!(*storage.0.lock(), before);
}

#[test]
fn recovery_refuses_future_provider_inode_versions_without_repairing_source() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    for invalid in [0, 1, 3] {
        load_image(image.len() as u64, &mut bytes).unwrap();
        let ino = ROOTFS.with(|state| state.next_ino);
        let metadata = PersistentInodeMetadata::from_inode(&Inode::new(
            InodeKind::PersistentRegular,
            0o755,
            0,
            0,
            0,
            ino,
        ));
        let mut record = encode_persistent_inode(
            &provider_record::inode(ino, &provider(false, 0), metadata).unwrap(),
        )
        .unwrap();
        record[0] = invalid;
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(storage.clone(), digest).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::Inode(ino),
                    value: record,
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 1,
                        name: b"future".to_vec(),
                    },
                    value: ino.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        drop(journal);
        let before = storage.0.lock().clone();
        let tree = export_tree();
        assert_eq!(
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes),
            Err(Errno::EIO)
        );
        assert_eq!(export_tree(), tree);
        assert_eq!(*storage.0.lock(), before);
        assert!(persistence_recovery_is_pristine());
    }
}

#[test]
fn multiple_large_provider_records_compact_and_convert_with_byte_bounded_transactions() {
    let _guard = TestGuard::acquire();
    let image = roomy_image();
    let digest = Sha256::digest(&image).into();
    for convert in [false, true] {
        let mut bytes = source(&image);
        load_image(image.len() as u64, &mut bytes).unwrap();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
        let descriptor = provider(true, crate::sdef::MAX_PAYLOAD_LEN as usize);
        let mut names = Vec::new();
        for number in 0..8 {
            let name = alloc::format!("/package-{number}").into_bytes();
            let ino = stage_persistent_deferred_file(&name, &descriptor, 0o644, 0, 0).unwrap();
            names.push((name, ino));
        }
        assert_persistent_cached_usage();
        let original = storage.0.lock().clone();
        if convert {
            let (converted, checkpoint) =
                crate::persistent_overlay::convert_unindexed_resizable_journal(
                    &mut storage.clone(),
                    compacted.clone(),
                    index.clone(),
                    digest,
                )
                .unwrap();
            drop((converted, checkpoint));
        } else {
            prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
            checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
            activate_persistence_compaction().unwrap();
        }
        assert_eq!(*storage.0.lock(), original);
        let end = compacted.0.lock().len() as u64;
        load_image(image.len() as u64, &mut bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(compacted),
            Box::new(index),
            digest,
            end,
            &mut bytes,
        )
        .unwrap();
        for (name, ino) in names {
            assert_eq!(lstat(&name).unwrap().st_ino, ino);
            let mut output = [0; 6];
            assert_eq!(read_file_at(&name, 0, &mut output, &mut bytes), Ok(6));
            assert_eq!(&output, b"hello\n");
        }
        persistent_statfs().unwrap();
        assert_persistent_cached_usage();
    }
}

#[test]
fn last_provider_unlink_reclaims_archive_metadata_but_not_shared_or_open_bindings() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage), digest, &mut bytes).unwrap();
    for number in 0..64 {
        let mut decoded = crate::sdef::decode(&provider(true, 0)).unwrap();
        decoded.archives[0].archive_id += number;
        decoded.records[0].archive_id += number;
        let descriptor = crate::sdef::encode(&decoded.archives, &decoded.records).unwrap();
        stage_persistent_deferred_file(b"/churn", &descriptor, 0o644, 0, 0).unwrap();
        link(b"/churn", b"/alias").unwrap();
        unlink(b"/churn").unwrap();
        let handle = open(b"/alias", O_RDONLY, 0, 0, 0).unwrap();
        unlink(b"/alias").unwrap();
        assert_eq!(ROOTFS.with(|state| state.archives.len()), 1);
        let mut output = [0; 6];
        assert_eq!(read(handle, 0, &mut output, &mut bytes), Ok(6));
        assert_eq!(&output, b"hello\n");
        release_handle(handle);
        assert_eq!(ROOTFS.with(|state| state.archives.len()), 0);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }
}

#[test]
fn provider_staging_scratch_refusal_preserves_namespace_and_source_and_can_retry() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    let digest = Sha256::digest(image).into();
    let mut bytes = source(image);
    load_image(image.len() as u64, &mut bytes).unwrap();
    let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
    enable_resizable_persistence(Box::new(storage.clone()), digest, &mut bytes).unwrap();
    let original = storage.0.lock().clone();
    let tree = export_tree();
    let descriptor = provider(false, crate::sdef::MAX_PAYLOAD_LEN as usize);
    let quota = crate::prepared_map::test_budget(journal_state_budget_usage().0 + 512);
    assert_eq!(
        stage_persistent_deferred_file(b"/refused", &descriptor, 0o755, 0, 0),
        Err(Errno::ENOMEM)
    );
    drop(quota);
    assert_eq!(*storage.0.lock(), original);
    assert_eq!(export_tree(), tree);
    assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    stage_persistent_deferred_file(b"/refused", &descriptor, 0o755, 0, 0).unwrap();
    assert!(lstat(b"/refused").is_ok());
}
