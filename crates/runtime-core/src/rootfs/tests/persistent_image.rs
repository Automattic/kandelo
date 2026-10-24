use super::*;
use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
use crate::persistent_image::{
    CacheConfig, DATA_BYTES, HEADER_BYTES, ImageBuilder, ImageIdentity, IntegrityPolicy,
    PositionedImageWriter,
};
use crate::vfsi_container::{ContainerSections, wrap};

static PHYSICAL_IMAGE: Mutex<Option<Arc<Mutex<Vec<u8>>>>> = Mutex::new(None);
static PHYSICAL_READ_BYTES: AtomicU64 = AtomicU64::new(0);
const MARKER: &[u8] = b"Kandelo positioned integrity corruption marker 20261021";
const MARKER_OFFSET: usize = 3 * DATA_BYTES + 37;

impl PositionedImageWriter for SharedJournalStorage {
    fn get_size(&self) -> Result<u64, Errno> {
        Ok(self.0.lock().len() as u64)
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        OverlayStorage::write_all_at(self, offset, bytes)
    }
    fn set_size(&mut self, length: u64) -> Result<(), Errno> {
        self.0
            .lock()
            .resize(usize::try_from(length).map_err(|_| Errno::EIO)?, 0);
        Ok(())
    }
    fn flush(&mut self) -> Result<(), Errno> {
        OverlayStorage::flush(self)
    }
}

struct Fixture {
    bytes: Arc<Mutex<Vec<u8>>>,
    identity: ImageIdentity,
    content: Vec<u8>,
    corruption_offset: usize,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        reset();
        *PHYSICAL_IMAGE.lock() = None;
    }
}

fn physical_read(offset: u64, destination: &mut [u8]) -> Result<usize, Errno> {
    let bytes = PHYSICAL_IMAGE
        .lock()
        .as_ref()
        .cloned()
        .ok_or(Errno::ENOSYS)?;
    let bytes = bytes.lock();
    let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
    let remaining = bytes.get(start..).ok_or(Errno::EIO)?;
    let count = remaining.len().min(destination.len()).min(1021);
    destination[..count].copy_from_slice(&remaining[..count]);
    PHYSICAL_READ_BYTES.fetch_add(count as u64, Ordering::SeqCst);
    Ok(count)
}

struct UnopenedStorage;

impl OverlayStorage for UnopenedStorage {
    fn len(&mut self) -> Result<u64, Errno> {
        panic!("identity rejection must precede storage access")
    }
    fn read_exact_at(&mut self, _offset: u64, _destination: &mut [u8]) -> Result<(), Errno> {
        panic!("identity rejection must precede storage access")
    }
    fn write_all_at(&mut self, _offset: u64, _bytes: &[u8]) -> Result<(), Errno> {
        panic!("identity rejection must precede storage access")
    }
    fn flush(&mut self) -> Result<(), Errno> {
        panic!("identity rejection must precede storage access")
    }
    fn truncate(&mut self, _length: u64) -> Result<(), Errno> {
        panic!("identity rejection must precede storage access")
    }
}

#[test]
fn checked_regular_reads_reuse_bounded_traversal_for_plain_fixed_and_resizable_mounts() {
    let _guard = TestGuard::acquire();
    assert!(core::mem::size_of::<ImageReadCursor>() < 16 * 1024);
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        for persistence in [None, Some(false), Some(true)] {
            let fixture = fixture_with_size(policy, 5 * 1024 * 1024 + 17, 8 * 1024 * 1024);
            load_persistent_image(fixture.identity.physical_length, fixture.identity.digest,
                CacheConfig::CONSTRAINED, physical_read, no_bytes()).unwrap();
            if let Some(resizable) = persistence {
                let journal = Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
                if resizable { enable_resizable_persistence(journal, fixture.identity.digest, &mut no_bytes()).unwrap(); }
                else { enable_fixed_persistence(journal, fixture.identity.digest, &mut no_bytes()).unwrap(); }
            }
            PHYSICAL_READ_BYTES.store(0, Ordering::SeqCst);
            let mut actual = alloc::vec![0; fixture.content.len()];
            for (index, chunk) in actual.chunks_mut(DATA_BYTES).enumerate() {
                assert_eq!(read_file_at(b"/file", (index * DATA_BYTES) as i64, chunk, no_bytes()), Ok(chunk.len()));
            }
            let physical_reads = PHYSICAL_READ_BYTES.load(Ordering::SeqCst);
            assert_eq!(actual, fixture.content);
            assert!(physical_reads < actual.len() as u64 * 5,
                "{policy:?}/{persistence:?} read {physical_reads} physical bytes for {} file bytes", actual.len());
            let mut tail = [0xCC; 31];
            let tail_offset = fixture.content.len() - 7;
            assert_eq!(read_file_at(b"/alias", tail_offset as i64, &mut tail, no_bytes()), Ok(7));
            assert_eq!(&tail[..7], &fixture.content[tail_offset..]);
            assert_eq!(&tail[7..], &[0xCC; 24]);
            assert_eq!(read_file_at(b"/file", fixture.content.len() as i64, &mut tail, no_bytes()), Ok(0));
        }
    }
}

#[test]
fn checked_double_indirect_export_bounds_physical_reads_and_preserves_journal_edits() {
    let _guard = TestGuard::acquire();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let mut fixture = fixture_with_size(policy, 5 * 1024 * 1024 + 17, 8 * 1024 * 1024);
        load_persistent_image(fixture.identity.physical_length, fixture.identity.digest,
            CacheConfig::CONSTRAINED, physical_read, no_bytes()).unwrap();
        let journal = Arc::new(Mutex::new(Vec::new()));
        enable_resizable_persistence(Box::new(SharedJournalStorage(journal)), fixture.identity.digest, &mut no_bytes()).unwrap();
        let offset = 4 * 1024 * 1024 + 37;
        write_file_at(b"/file", offset as i64, b"journal-edit", 0o640, false, no_bytes()).unwrap();
        fixture.content[offset..offset + 12].copy_from_slice(b"journal-edit");
        sync_persistence().unwrap();
        PHYSICAL_READ_BYTES.store(0, Ordering::SeqCst);
        let mut exported = Vec::new();
        let mut chunk = alloc::vec![0; DATA_BYTES];
        loop {
            let count = export_container_read(exported.len() as i64, &mut chunk, &mut no_bytes()).unwrap();
            if count == 0 { break; }
            exported.extend_from_slice(&chunk[..count]);
            assert!(exported.len() as u64 <= fixture.identity.payload_length);
        }
        let physical_reads = PHYSICAL_READ_BYTES.load(Ordering::SeqCst);
        assert!(physical_reads < exported.len() as u64 * 5,
            "{policy:?} read {physical_reads} physical bytes for {} exported bytes", exported.len());
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&exported).unwrap()).unwrap();
        let ino = filesystem.resolve(b"/file", true).unwrap();
        let mut actual = alloc::vec![0; fixture.content.len()];
        assert_eq!(filesystem.read_at(ino, 0, &mut actual), Ok(actual.len()));
        assert_eq!(actual, fixture.content);
        assert_eq!(filesystem.resolve(b"/alias", true), Ok(ino));
        std::println!("{policy:?} double-indirect export: physical={physical_reads} emitted={}", exported.len());
    }
}

#[test]
fn wrong_identity_never_opens_fixed_resizable_or_indexed_journal_storage() {
    let _guard = TestGuard::acquire();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fixture = fixture(policy);
        load(&fixture).unwrap();
        let mut wrong = fixture.identity.digest;
        wrong[17] ^= 1;
        assert_eq!(
            enable_fixed_persistence(Box::new(UnopenedStorage), wrong, &mut no_bytes()),
            Err(Errno::EIO)
        );
        assert_eq!(
            enable_resizable_persistence(Box::new(UnopenedStorage), wrong, &mut no_bytes()),
            Err(Errno::EIO)
        );
        assert_eq!(
            enable_fixed_persistence_indexed(
                Box::new(UnopenedStorage),
                Box::new(UnopenedStorage),
                wrong,
                72,
                &mut no_bytes()
            ),
            Err(Errno::EIO)
        );
        assert_eq!(
            enable_resizable_persistence_indexed(
                Box::new(UnopenedStorage),
                Box::new(UnopenedStorage),
                wrong,
                72,
                &mut no_bytes()
            ),
            Err(Errno::EIO)
        );
    }
}

#[test]
fn pressure_reclaims_verified_base_pages_without_losing_binding_or_skipping_reverification() {
    let _guard = TestGuard::acquire();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fixture = fixture(policy);
        load(&fixture).unwrap();
        let mut actual = [0; 31];
        read_file_at(b"/file", MARKER_OFFSET as i64, &mut actual, no_bytes()).unwrap();
        assert_eq!(&actual, &MARKER[..31]);
        let before = io_budget_usage().0;
        fixture.bytes.lock()[fixture.corruption_offset] ^= 1;
        reclaim_io_read_caches(None);
        assert!(io_budget_usage().0 < before);
        assert_eq!(persistent_image_binding(), Some(fixture.identity));
        let reads = PHYSICAL_READ_BYTES.load(Ordering::SeqCst);
        let mut untouched = [0xCC; 31];
        assert_eq!(
            read_file_at(b"/file", MARKER_OFFSET as i64, &mut untouched, no_bytes()),
            Err(Errno::EIO)
        );
        assert_eq!(untouched, [0xCC; 31]);
        assert!(PHYSICAL_READ_BYTES.load(Ordering::SeqCst) > reads);
    }
}

#[test]
fn failed_replacement_mount_drops_old_and_new_identity_then_allows_retry() {
    let _guard = TestGuard::acquire();
    let baseline = io_budget_usage().0;
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let first = fixture(policy);
        load(&first).unwrap();
        assert!(read_file_at(b"/file", 0, &mut [0; 31], no_bytes()).is_ok());
        let replacement_policy = match policy {
            IntegrityPolicy::Crc32c => IntegrityPolicy::Sha256,
            IntegrityPolicy::Sha256 => IntegrityPolicy::Crc32c,
        };
        let replacement = fixture(replacement_policy);
        assert_ne!(first.identity.digest, replacement.identity.digest);
        replacement.bytes.lock()[HEADER_BYTES] ^= 1;
        assert_eq!(load(&replacement), Err(Errno::EINVAL));
        assert_eq!(image_length(), None);
        assert_eq!(persistent_image_binding(), None);
        assert_eq!(io_budget_usage().0, baseline);
        assert!(lstat(b"/file").is_err());
        replacement.bytes.lock()[HEADER_BYTES] ^= 1;
        load(&replacement).unwrap();
        assert_eq!(persistent_image_binding(), Some(replacement.identity));
        assert!(read_file_at(b"/file", 0, &mut [0; 31], no_bytes()).is_ok());
    }
}

fn fixture(policy: IntegrityPolicy) -> Fixture {
    fixture_with_size(policy, 8 * DATA_BYTES + 17, 4 * 1024 * 1024)
}

fn fixture_with_size(policy: IntegrityPolicy, content_bytes: usize, image_bytes: u64) -> Fixture {
    let mut content = (0..content_bytes)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    content[MARKER_OFFSET..MARKER_OFFSET + MARKER.len()].copy_from_slice(MARKER);
    let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(image_bytes)).unwrap();
    let root = writer.root();
    let file = writer
        .create_file(root, b"file", 0o640, Content::Bytes(&content))
        .unwrap();
    writer.link(root, b"alias", file).unwrap();
    writer.symlink(root, b"link", b"file").unwrap();
    writer.set_owner(file, 101, 102).unwrap();
    writer.declare_deferred_section().unwrap();
    let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
    let container = wrap(
        &body,
        &ContainerSections {
            lazy_json: b"[]",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        },
    )
    .unwrap();
    let corruption_offset = HEADER_BYTES
        + container
            .windows(MARKER.len())
            .position(|window| window == MARKER)
            .unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let mut target = SharedJournalStorage(bytes.clone());
    let mut builder = ImageBuilder::begin(container.len() as u64, policy, &mut target).unwrap();
    for chunk in container.chunks(999) {
        builder.push(chunk).unwrap();
    }
    let identity = builder.finish().unwrap();
    *PHYSICAL_IMAGE.lock() = Some(bytes.clone());
    PHYSICAL_READ_BYTES.store(0, Ordering::SeqCst);
    Fixture {
        bytes,
        identity,
        content,
        corruption_offset,
    }
}

fn load(fixture: &Fixture) -> Result<usize, Errno> {
    load_persistent_image(
        fixture.identity.physical_length,
        fixture.identity.digest,
        CacheConfig::new(1, 1).unwrap(),
        physical_read,
        no_bytes(),
    )
}

#[test]
fn verified_mount_reads_and_resizable_journal_recovery_use_the_retained_source() {
    let _guard = TestGuard::acquire();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fixture = fixture(policy);
        assert!(load(&fixture).unwrap() >= 4);
        assert_eq!(image_length(), Some(fixture.identity.payload_length));
        assert_eq!(persistent_image_binding(), Some(fixture.identity));
        assert!(PHYSICAL_READ_BYTES.load(Ordering::SeqCst) < fixture.identity.payload_length / 2);
        let file = lstat(b"/file").unwrap();
        let alias = lstat(b"/alias").unwrap();
        assert_eq!(file.st_ino, alias.st_ino);
        assert_eq!((file.st_uid, file.st_gid), (101, 102));
        let mut actual = [0; 71];
        assert_eq!(
            read_file_at(b"/link", MARKER_OFFSET as i64, &mut actual, no_bytes()).unwrap(),
            actual.len()
        );
        assert_eq!(
            &actual[..],
            &fixture.content[MARKER_OFFSET..MARKER_OFFSET + actual.len()]
        );
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut wrong = fixture.identity.digest;
        wrong[0] ^= 1;
        assert_eq!(
            enable_resizable_persistence(Box::new(storage.clone()), wrong, &mut no_bytes()),
            Err(Errno::EIO)
        );
        assert!(storage.0.lock().is_empty());
        enable_resizable_persistence(
            Box::new(storage.clone()),
            fixture.identity.digest,
            &mut no_bytes(),
        )
        .unwrap();
        assert_eq!(
            write_file_at(b"/alias", 100, b"persisted", 0o640, false, no_bytes()).unwrap(),
            9
        );
        sync_persistence().unwrap();
        reset();
        assert_eq!(persistent_image_binding(), None);
        load(&fixture).unwrap();
        enable_resizable_persistence(Box::new(storage), fixture.identity.digest, &mut no_bytes())
            .unwrap();
        let mut actual = [0; 200];
        assert_eq!(
            read_file_at(b"/link", 0, &mut actual, no_bytes()).unwrap(),
            actual.len()
        );
        let mut expected = fixture.content[..actual.len()].to_vec();
        expected[100..109].copy_from_slice(b"persisted");
        assert_eq!(actual.as_slice(), expected);
    }
}

#[test]
fn corrupt_unread_file_data_is_refused_before_guest_buffer_exposure() {
    let _guard = TestGuard::acquire();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fixture = fixture(policy);
        fixture.bytes.lock()[fixture.corruption_offset] ^= 1;
        load(&fixture).unwrap();
        let mut untouched = [0xCC; 31];
        assert_eq!(
            read_file_at(b"/file", MARKER_OFFSET as i64, &mut untouched, no_bytes()),
            Err(Errno::EIO)
        );
        assert_eq!(untouched, [0xCC; 31]);
        fixture.bytes.lock()[fixture.corruption_offset] ^= 1;
        assert_eq!(
            read_file_at(b"/file", MARKER_OFFSET as i64, &mut untouched, no_bytes()).unwrap(),
            untouched.len()
        );
        assert_eq!(&untouched, &MARKER[..31]);
    }
}

#[test]
fn failed_verified_mount_and_plain_reload_release_integrity_state() {
    let _guard = TestGuard::acquire();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let baseline = io_budget_usage().0;
        let fixture = fixture(policy);
        fixture.bytes.lock()[HEADER_BYTES] ^= 1;
        assert_eq!(load(&fixture), Err(Errno::EINVAL));
        assert_eq!(persistent_image_binding(), None);
        assert_eq!(io_budget_usage().0, baseline);
        fixture.bytes.lock()[HEADER_BYTES] ^= 1;
        load(&fixture).unwrap();
        let ordinary = tiny_vfs_with_kernel_lazy(&klzy_section(&[], &[]));
        load_image(ordinary.len() as u64, image_host(&ordinary)).unwrap();
        assert_eq!(persistent_image_binding(), None);
        let mut actual = [0; 5];
        assert_eq!(
            read_file_at(b"/hello.txt", 0, &mut actual, image_host(&ordinary)).unwrap(),
            5
        );
        assert_eq!(&actual, b"hello");
        reset();
        assert_eq!(io_budget_usage().0, baseline);
    }
}
