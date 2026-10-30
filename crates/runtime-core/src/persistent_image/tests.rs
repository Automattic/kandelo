use super::*;
use alloc::{vec, vec::Vec};
use core::cell::Cell;

#[cfg(unix)]
struct SparseFile {
    file: std::fs::File,
    path: std::path::PathBuf,
    reads: Cell<u64>,
    partial_failure: Cell<Option<(u64, Errno)>>,
}

#[cfg(unix)]
impl SparseFile {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kandelo-fast-image-{}-{unique}",
            std::process::id()
        ));
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        Self {
            file,
            path,
            reads: Cell::new(0),
            partial_failure: Cell::new(None),
        }
    }
}

#[cfg(unix)]
impl Drop for SparseFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
impl BlockSource for SparseFile {
    fn len(&self) -> u64 {
        self.file.metadata().unwrap().len()
    }
    fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        use std::os::unix::fs::FileExt;
        if let Some((failure_offset, error)) = self.partial_failure.get() {
            if offset == failure_offset {
                let prefix = destination.len().min(7);
                destination[..prefix].fill(0xA5);
                return Err(error);
            }
        }
        self.file
            .read_exact_at(destination, offset)
            .map_err(|_| Errno::EIO)?;
        self.reads.set(self.reads.get() + destination.len() as u64);
        Ok(())
    }
}

#[cfg(unix)]
impl PositionedImageWriter for SparseFile {
    fn get_size(&self) -> Result<u64, Errno> {
        Ok(self.len())
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        use std::os::unix::fs::FileExt;
        self.file
            .write_all_at(bytes, offset)
            .map_err(|_| Errno::EIO)
    }
    fn set_size(&mut self, length: u64) -> Result<(), Errno> {
        self.file.set_len(length).map_err(|_| Errno::EIO)
    }
    fn flush(&mut self) -> Result<(), Errno> {
        self.file.sync_data().map_err(|_| Errno::EIO)
    }
}

struct MemoryFile {
    bytes: RefCell<Vec<u8>>,
    read_bytes: Cell<u64>,
    operations: usize,
    fail_operation: Option<usize>,
    partial_write_failure: bool,
    read_failure: Cell<Option<Errno>>,
}

impl MemoryFile {
    fn new() -> Self {
        Self {
            bytes: RefCell::new(Vec::new()),
            read_bytes: Cell::new(0),
            operations: 0,
            fail_operation: None,
            partial_write_failure: false,
            read_failure: Cell::new(None),
        }
    }

    fn operation(&mut self) -> Result<(), Errno> {
        self.operations += 1;
        if self.fail_operation == Some(self.operations) {
            return Err(Errno::EIO);
        }
        Ok(())
    }
}

impl BlockSource for MemoryFile {
    fn len(&self) -> u64 {
        self.bytes.borrow().len() as u64
    }
    fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if let Some(error) = self.read_failure.get() {
            return Err(error);
        }
        let offset = usize::try_from(offset).map_err(|_| Errno::EIO)?;
        let end = offset.checked_add(destination.len()).ok_or(Errno::EIO)?;
        destination.copy_from_slice(self.bytes.borrow().get(offset..end).ok_or(Errno::EIO)?);
        self.read_bytes
            .set(self.read_bytes.get() + destination.len() as u64);
        Ok(())
    }
}

impl PositionedImageWriter for MemoryFile {
    fn get_size(&self) -> Result<u64, Errno> {
        Ok(BlockSource::len(self))
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        let result = self.operation();
        if result.is_err() && !self.partial_write_failure {
            return result;
        }
        let bytes = if result.is_err() {
            &bytes[..bytes.len().min(7)]
        } else {
            bytes
        };
        let offset = usize::try_from(offset).map_err(|_| Errno::EIO)?;
        let end = offset.checked_add(bytes.len()).ok_or(Errno::EIO)?;
        let mut data = self.bytes.borrow_mut();
        if data.len() < end {
            data.resize(end, 0);
        }
        data[offset..end].copy_from_slice(bytes);
        result
    }
    fn set_size(&mut self, length: u64) -> Result<(), Errno> {
        self.operation()?;
        self.bytes
            .borrow_mut()
            .resize(usize::try_from(length).map_err(|_| Errno::EIO)?, 0);
        Ok(())
    }
    fn flush(&mut self) -> Result<(), Errno> {
        self.operation()
    }
}

fn payload(length: usize) -> Vec<u8> {
    (0..length)
        .map(|position| ((position / DATA_BYTES + position * 17) % 251) as u8)
        .collect()
}

fn crc32c_reference(bytes: &[u8]) -> u32 {
    let mut state = u32::MAX;
    for byte in bytes {
        state ^= *byte as u32;
        for _ in 0..8 {
            state = (state >> 1) ^ if state & 1 != 0 { 0x82F63B78 } else { 0 };
        }
    }
    !state
}

#[test]
fn admission_refusal_preserves_bytes_and_releases_credit_for_retry() {
    use crate::io_buffer::{IO_MEMORY, test_budget};
    let baseline = IO_MEMORY.usage().0;
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let mut target = MemoryFile::new();
        {
            let _limit = test_budget(baseline);
            assert!(matches!(
                ImageBuilder::begin(DATA_BYTES as u64, policy, &mut target),
                Err(Errno::ENOMEM)
            ));
            assert_eq!(target.operations, 0);
            assert_eq!(target.len(), 0);
        }
        let mut builder = ImageBuilder::begin(DATA_BYTES as u64, policy, &mut target).unwrap();
        builder.push_zeroes(DATA_BYTES as u64).unwrap();
        let identity = builder.finish().unwrap();
        assert_eq!(IO_MEMORY.usage().0, baseline);
        {
            let _limit = test_budget(baseline);
            assert!(matches!(
                VerifiedImage::open(&target, identity.digest, CacheConfig::CONSTRAINED),
                Err(Errno::ENOMEM)
            ));
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
        for allowance in [0, 2 * INDEX_BYTES, 2 * (DATA_BYTES + INDEX_BYTES)] {
            let image =
                VerifiedImage::open(&target, identity.digest, CacheConfig::new(1, 1).unwrap())
                    .unwrap();
            let records = IO_MEMORY.usage().0;
            let mut destination = [0xCC; 31];
            {
                let _limit = test_budget(records + allowance);
                let result = image.read_exact_at(0, &mut destination);
                if allowance < 2 * (DATA_BYTES + INDEX_BYTES) {
                    assert_eq!(result, Err(Errno::ENOMEM));
                    assert_eq!(destination, [0xCC; 31]);
                } else {
                    assert_eq!(result, Ok(()));
                    assert_eq!(destination, [0; 31]);
                }
                assert!(IO_MEMORY.usage().0 <= records + allowance);
            }
            image.read_exact_at(0, &mut destination).unwrap();
            assert_eq!(destination, [0; 31]);
            drop(image);
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
    }
}

#[test]
fn admitted_clean_pages_are_reused_when_the_configured_cache_cannot_fully_warm() {
    use crate::io_buffer::{IO_MEMORY, test_budget};
    let baseline = IO_MEMORY.usage().0;
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let data = payload(3 * DATA_BYTES);
        let (file, identity) = build(&data, DATA_BYTES, policy);
        let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
        let records = IO_MEMORY.usage().0;
        {
            let _limit = test_budget(records + 2 * (DATA_BYTES + INDEX_BYTES));
            for block in 0..3 {
                let mut actual = [0; 31];
                image
                    .read_exact_at((block * DATA_BYTES) as u64, &mut actual)
                    .unwrap();
                assert_eq!(
                    actual,
                    data[block * DATA_BYTES..block * DATA_BYTES + actual.len()]
                );
                assert!(IO_MEMORY.usage().0 <= records + 2 * (DATA_BYTES + INDEX_BYTES));
            }
            file.bytes.borrow_mut()[HEADER_BYTES] ^= 1;
            let mut untouched = [0xCC; 31];
            assert_eq!(image.read_exact_at(0, &mut untouched), Err(Errno::EIO));
            assert_eq!(untouched, [0xCC; 31]);
            assert_eq!(
                image.discard_read_caches().unwrap(),
                DATA_BYTES + INDEX_BYTES
            );
            assert_eq!(IO_MEMORY.usage().0, records);
            assert_eq!(image.identity(), identity.digest);
        }
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }
}

#[test]
fn checksum_vectors_and_incremental_updates_match_independent_references() {
    for (bytes, expected) in [
        (b"".as_slice(), 0u32),
        (b"123456789".as_slice(), 0xE3069283),
    ] {
        let mut checksum = Checksum::new(IntegrityPolicy::Crc32c);
        checksum.update(bytes);
        let actual = checksum.finalize();
        assert_eq!(&actual[..4], &expected.to_le_bytes());
        assert_eq!(&actual[4..], &[0; 28]);
    }
    for length in [
        0,
        1,
        31,
        55,
        56,
        63,
        64,
        65,
        DATA_BYTES - 1,
        DATA_BYTES,
        DATA_BYTES + 1,
    ] {
        let bytes = payload(length);
        for chunk in [1, 7, 1024, DATA_BYTES] {
            let mut crc = Checksum::new(IntegrityPolicy::Crc32c);
            let mut sha = Checksum::new(IntegrityPolicy::Sha256);
            for part in bytes.chunks(chunk) {
                crc.update(part);
                sha.update(part);
            }
            assert_eq!(
                &crc.finalize()[..4],
                &crc32c_reference(&bytes).to_le_bytes()
            );
            assert_eq!(sha.finalize(), <[u8; 32]>::from(Sha256::digest(&bytes)));
        }
    }
}

#[test]
fn ordinary_vfsi_container_and_filesystem_features_survive_both_envelopes() {
    use crate::kandelo_image_fs::{KandeloImageFs, kandelo_image_span, metadata_span};
    use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
    use crate::vfsi_container::{ContainerSections, wrap};

    struct Window<'a, Source> {
        source: &'a Source,
        offset: u64,
        length: u64,
    }
    impl<Source: BlockSource> BlockSource for Window<'_, Source> {
        fn len(&self) -> u64 {
            self.length
        }
        fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
            if offset
                .checked_add(destination.len() as u64)
                .filter(|end| *end <= self.length)
                .is_none()
            {
                return Err(Errno::EIO);
            }
            self.source.read_exact_at(
                self.offset.checked_add(offset).ok_or(Errno::EIO)?,
                destination,
            )
        }
    }

    let content = payload(3 * DATA_BYTES + 17);
    let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(4 * 1024 * 1024)).unwrap();
    let directory = writer.mkdir(writer.root(), b"directory", 0o755).unwrap();
    let file = writer
        .create_file(directory, b"content", 0o640, Content::Bytes(&content))
        .unwrap();
    writer.link(directory, b"alias", file).unwrap();
    writer.symlink(directory, b"symbolic", b"content").unwrap();
    writer.set_owner(file, 1001, 1002).unwrap();
    let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
    let metadata = b"{\"version\":1,\"description\":\"integrity envelope fixture\"}";
    let container = wrap(
        &body,
        &ContainerSections {
            lazy_json: b"[]",
            archive_json: None,
            metadata_json: Some(metadata),
            kernel_lazy: None,
        },
    )
    .unwrap();
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let (target, identity) = build(&container, 777, policy);
        let image =
            VerifiedImage::open(&target, identity.digest, CacheConfig::CONSTRAINED).unwrap();
        let (offset, length) = kandelo_image_span(&image).unwrap();
        assert_eq!(length, body.len() as u64);
        let filesystem = KandeloImageFs::mount(Window {
            source: &image,
            offset,
            length,
        })
        .unwrap();
        let root = crate::kandelo_image_fs::ROOT_INO;
        let directory = filesystem.lookup(root, b"directory").unwrap();
        let file = filesystem.lookup(directory, b"content").unwrap();
        assert_eq!(filesystem.lookup(directory, b"alias"), Ok(file));
        let attributes = filesystem.stat_ino(file).unwrap();
        assert_eq!(
            (attributes.nlink, attributes.uid, attributes.gid),
            (2, 1001, 1002)
        );
        assert_eq!(attributes.mode & 0o777, 0o640);
        assert_eq!(attributes.size, content.len() as u64);
        let symbolic = filesystem.lookup(directory, b"symbolic").unwrap();
        assert_eq!(filesystem.read_link(symbolic).unwrap(), b"content");
        let mut actual = vec![0; content.len()];
        assert_eq!(
            filesystem.read_at(file, 0, &mut actual).unwrap(),
            content.len()
        );
        assert_eq!(actual, content);
        let (offset, length) = metadata_span(&image).unwrap().unwrap();
        assert_eq!(length, metadata.len() as u64);
        let mut actual = vec![0; metadata.len()];
        image.read_exact_at(offset, &mut actual).unwrap();
        assert_eq!(actual, metadata);
    }
}

#[test]
fn policy_is_bound_to_identity_and_unknown_modes_or_noncanonical_roots_are_refused() {
    let data = payload(DATA_BYTES + 17);
    let (sha_file, sha_identity) = build(&data, 333, IntegrityPolicy::Sha256);
    let (crc_file, crc_identity) = build(&data, 333, IntegrityPolicy::Crc32c);
    assert_ne!(sha_identity.digest, crc_identity.digest);
    assert!(VerifiedImage::open(&crc_file, sha_identity.digest, CacheConfig::CONSTRAINED).is_err());
    assert!(VerifiedImage::open(&sha_file, crc_identity.digest, CacheConfig::CONSTRAINED).is_err());
    for (file, identity, policy) in [
        (&crc_file, crc_identity, IntegrityPolicy::Crc32c),
        (&sha_file, sha_identity, IntegrityPolicy::Sha256),
    ] {
        let image = VerifiedImage::open(file, identity.digest, CacheConfig::CONSTRAINED).unwrap();
        assert_eq!(image.policy(), policy);
        let pristine = file.bytes.borrow().clone();
        for unknown in [0u32, 3, u32::MAX] {
            file.bytes.borrow_mut()[60..64].copy_from_slice(&unknown.to_le_bytes());
            assert!(matches!(
                VerifiedImage::open(file, identity.digest, CacheConfig::CONSTRAINED),
                Err(Errno::EINVAL)
            ));
        }
        *file.bytes.borrow_mut() = pristine;
    }
    let layout = Layout::new(data.len() as u64, IntegrityPolicy::Crc32c).unwrap();
    let mut root = [0; 32];
    root[4] = 1;
    let (bad_header, bad_identity) = layout.encode(root);
    crc_file.bytes.borrow_mut()[..HEADER_BYTES].copy_from_slice(&bad_header);
    assert!(VerifiedImage::open(&crc_file, bad_identity, CacheConfig::CONSTRAINED).is_err());
}

#[test]
fn automatic_cache_selection_respects_io_limits_and_explicit_requests() {
    assert_eq!(CacheConfig::automatic_for_io_limit(30 * 1024 * 1024), CacheConfig::new(16, 4).unwrap());
    assert_eq!(CacheConfig::automatic_for_io_limit(6 * 1024 * 1024), CacheConfig::new(5, 4).unwrap());
    for limit in [2, 4, 6, 8, 16, 30, 64].map(|mib| mib * 1024 * 1024) {
        let config = CacheConfig::automatic_for_io_limit(limit);
        assert!(config.payload_limit() * 2 <= limit / 8);
        assert!((1..=16).contains(&config.data_pages));
        assert!((1..=4).contains(&config.index_pages));
    }
    assert_eq!(CacheConfig::automatic_for_io_limit(0), CacheConfig::new(1, 1).unwrap());
    for (data, index) in [(1, 1), (2, 2), (16, 4), (64, 64)] {
        assert_eq!(CacheConfig::from_host_limits(data, index), CacheConfig::new(data, index));
    }
    for (data, index) in [(0, 1), (1, 0), (65, 1), (1, 65)] {
        assert_eq!(CacheConfig::from_host_limits(data, index), Err(Errno::EINVAL));
    }
    assert_eq!(CacheConfig::from_host_limits(0, 0).unwrap(),
        CacheConfig::automatic_for_io_limit(crate::io_buffer::IO_MEMORY.usage().1));
}

#[test]
fn automatic_cache_retains_a_hot_working_set_without_whole_image_loading() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let data = payload(64 * DATA_BYTES);
        let (file, identity) = build(&data, DATA_BYTES, policy);
        let image = VerifiedImage::open(&file, identity.digest,
            CacheConfig::automatic_for_io_limit(30 * 1024 * 1024)).unwrap();
        let mut actual = [0; 31];
        for block in 0..16 {
            image.read_exact_at((block * DATA_BYTES) as u64, &mut actual).unwrap();
            assert_eq!(actual, data[block * DATA_BYTES..block * DATA_BYTES + actual.len()]);
        }
        let primed_bytes = file.read_bytes.get();
        assert!(primed_bytes < data.len() as u64 / 2);
        for _ in 0..32 {
            for block in 0..16 {
                image.read_exact_at((block * DATA_BYTES) as u64, &mut actual).unwrap();
                assert_eq!(actual, data[block * DATA_BYTES..block * DATA_BYTES + actual.len()]);
            }
        }
        assert_eq!(file.read_bytes.get(), primed_bytes);
    }
}

#[test]
fn cache_configuration_is_bounded_and_evicted_bytes_are_verified_again() {
    for (data, index) in [(0, 1), (1, 0), (65, 1), (1, 65), (usize::MAX, usize::MAX)] {
        assert_eq!(CacheConfig::new(data, index), Err(Errno::EINVAL));
    }
    assert_eq!(CacheConfig::CONSTRAINED.payload_limit(), 136 * 1024);
    assert_eq!(CacheConfig::DESKTOP.payload_limit(), 544 * 1024);
    assert_eq!(
        CacheConfig::new(64, 64).unwrap().payload_limit(),
        64 * (DATA_BYTES + INDEX_BYTES)
    );
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let data = payload(10 * DATA_BYTES + 17);
        let (file, identity) = build(&data, DATA_BYTES, policy);
        for config in [
            CacheConfig::new(1, 1).unwrap(),
            CacheConfig::CONSTRAINED,
            CacheConfig::DESKTOP,
        ] {
            let image = VerifiedImage::open(&file, identity.digest, config).unwrap();
            let mut actual = [0; 31];
            image.read_exact_at(0, &mut actual).unwrap();
            assert_eq!(actual, data[..31]);
            let before = file.read_bytes.get();
            image.read_exact_at(0, &mut actual).unwrap();
            assert_eq!(file.read_bytes.get(), before);
            file.bytes.borrow_mut()[HEADER_BYTES] ^= 1;
            for block in 1..=config.data_pages {
                image
                    .read_exact_at((block * DATA_BYTES) as u64, &mut actual)
                    .unwrap();
            }
            let mut untouched = [0xCC; 31];
            assert_eq!(image.read_exact_at(0, &mut untouched), Err(Errno::EIO));
            assert_eq!(untouched, [0xCC; 31]);
            let cache = image.cache.borrow();
            let retained = cache
                .data
                .iter()
                .map(|page| page.bytes.capacity())
                .sum::<usize>()
                + cache
                    .index
                    .iter()
                    .map(|page| page.bytes.capacity())
                    .sum::<usize>();
            assert!(retained <= config.payload_limit());
            file.bytes.borrow_mut()[HEADER_BYTES] ^= 1;
        }
    }
}

#[test]
fn partial_writes_never_return_an_identity_and_preexisting_targets_are_not_modified() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let data = payload(DATA_BYTES + 17);
        let (complete, _) = build(&data, DATA_BYTES, policy);
        for failure in 1..=complete.operations {
            let mut file = MemoryFile::new();
            file.fail_operation = Some(failure);
            file.partial_write_failure = true;
            let result = (|| {
                let mut builder = ImageBuilder::begin(data.len() as u64, policy, &mut file)?;
                for bytes in data.chunks(DATA_BYTES) {
                    builder.push(bytes)?;
                }
                builder.finish()
            })();
            assert_eq!(
                result,
                Err(Errno::EIO),
                "partial-write cut {failure} in {policy:?}"
            );
        }
        let mut existing = MemoryFile::new();
        existing.bytes.borrow_mut().extend_from_slice(b"existing");
        assert!(matches!(
            ImageBuilder::begin(1, policy, &mut existing),
            Err(Errno::EINVAL)
        ));
        assert_eq!(&*existing.bytes.borrow(), b"existing");
        assert_eq!(existing.operations, 0);
    }
}

fn build(data: &[u8], chunk: usize, policy: IntegrityPolicy) -> (MemoryFile, ImageIdentity) {
    let mut file = MemoryFile::new();
    let mut builder = ImageBuilder::begin(data.len() as u64, policy, &mut file).unwrap();
    for bytes in data.chunks(chunk) {
        builder.push(bytes).unwrap();
    }
    let identity = builder.finish().unwrap();
    (file, identity)
}

#[test]
fn positioned_reads_match_original_across_headers_blocks_and_index_levels() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fanout = policy.fanout();
        for length in [
            1,
            63,
            DATA_BYTES - 1,
            DATA_BYTES,
            DATA_BYTES + 1,
            fanout * DATA_BYTES,
            (fanout + 1) * DATA_BYTES + 17,
        ] {
            let data = payload(length);
            let (file, identity) = build(&data, 937, policy);
            assert_eq!(file.len(), identity.physical_length);
            let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
            assert_eq!(image.identity(), identity.digest);
            assert_eq!(image.payload_length(), length as u64);
            assert_eq!(file.read_bytes.get(), HEADER_BYTES as u64);
            let mut actual = vec![0; length];
            image.read_exact_at(0, &mut actual).unwrap();
            assert_eq!(actual, data);
            for offset in [0, length / 3, length.saturating_sub(17), length] {
                let count = 31.min(length - offset);
                let mut actual = [0xCC; 31];
                image
                    .read_exact_at(offset as u64, &mut actual[..count])
                    .unwrap();
                assert_eq!(&actual[..count], &data[offset..offset + count]);
                assert!(actual[count..].iter().all(|byte| *byte == 0xCC));
            }
            let before = file.read_bytes.get();
            assert_eq!(image.read_exact_at(u64::MAX, &mut [0]), Err(Errno::EIO));
            assert_eq!(file.read_bytes.get(), before);
        }
    }
}

#[test]
fn stream_chunking_and_sparse_zero_runs_produce_identical_authenticated_bytes() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let mut data = payload(3 * DATA_BYTES + 17);
        data[37..2 * DATA_BYTES + 11].fill(0);
        let (ordinary, identity) = build(&data, DATA_BYTES, policy);
        let mut sparse = MemoryFile::new();
        let mut builder = ImageBuilder::begin(data.len() as u64, policy, &mut sparse).unwrap();
        builder.push(&data[..37]).unwrap();
        builder
            .push_zeroes((2 * DATA_BYTES + 11 - 37) as u64)
            .unwrap();
        for bytes in data[2 * DATA_BYTES + 11..].chunks(73) {
            builder.push(bytes).unwrap();
        }
        assert_eq!(builder.finish().unwrap(), identity);
        assert_eq!(*ordinary.bytes.borrow(), *sparse.bytes.borrow());
    }
}

#[test]
fn unused_bad_data_does_not_scan_at_open_and_is_never_exposed_on_read() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let data = payload(3 * DATA_BYTES);
        let (file, identity) = build(&data, DATA_BYTES, policy);
        file.bytes.borrow_mut()[HEADER_BYTES + 2 * DATA_BYTES + 37] ^= 1;
        let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
        assert_eq!(file.read_bytes.get(), HEADER_BYTES as u64);
        let mut good = [0; 16];
        image.read_exact_at(0, &mut good).unwrap();
        assert_eq!(good, data[..16]);
        let mut untouched = [0xCC; 16];
        assert_eq!(
            image.read_exact_at((2 * DATA_BYTES + 32) as u64, &mut untouched),
            Err(Errno::EIO)
        );
        assert_eq!(untouched, [0xCC; 16]);
        assert_eq!(
            image.read_exact_at((2 * DATA_BYTES + 32) as u64, &mut untouched),
            Err(Errno::EIO)
        );
    }
}

#[test]
fn corrupted_header_proof_page_padding_and_swapped_blocks_fail_closed() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fanout = policy.fanout();
        let data = payload((fanout + 1) * DATA_BYTES + 17);
        let (file, identity) = build(&data, DATA_BYTES, policy);
        let layout = Layout::new(data.len() as u64, policy).unwrap();
        let pristine = file.bytes.borrow().clone();
        for offset in [0, 8, 16, 24, 60, 64, 96] {
            *file.bytes.borrow_mut() = pristine.clone();
            file.bytes.borrow_mut()[offset] ^= 1;
            assert!(VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).is_err());
        }
        for offset in [
            layout.levels[0].offset,
            layout.levels[1].offset,
            layout.levels[0].offset + INDEX_BYTES as u64 + 2 * 32,
        ] {
            *file.bytes.borrow_mut() = pristine.clone();
            file.bytes.borrow_mut()[offset as usize] ^= 1;
            let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
            let mut untouched = [0xCC; 1];
            let target = if offset > layout.levels[0].offset && offset < layout.levels[1].offset {
                fanout * DATA_BYTES
            } else {
                0
            };
            assert_eq!(
                image.read_exact_at(target as u64, &mut untouched),
                Err(Errno::EIO)
            );
            assert_eq!(untouched, [0xCC]);
        }
        *file.bytes.borrow_mut() = pristine;
        let first = file.bytes.borrow()[HEADER_BYTES..HEADER_BYTES + DATA_BYTES].to_vec();
        let second =
            file.bytes.borrow()[HEADER_BYTES + DATA_BYTES..HEADER_BYTES + 2 * DATA_BYTES].to_vec();
        file.bytes.borrow_mut()[HEADER_BYTES..HEADER_BYTES + DATA_BYTES].copy_from_slice(&second);
        file.bytes.borrow_mut()[HEADER_BYTES + DATA_BYTES..HEADER_BYTES + 2 * DATA_BYTES]
            .copy_from_slice(&first);
        let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
        assert_eq!(image.read_exact_at(0, &mut [0]), Err(Errno::EIO));
    }
}

#[test]
fn io_errors_preserve_the_host_failure_and_allow_a_later_verified_retry() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let (file, identity) = build(&payload(DATA_BYTES + 17), 999, policy);
        for error in [Errno::EAGAIN, Errno::ENOSYS, Errno::ENOSPC, Errno::ENOMEM] {
            file.read_failure.set(Some(error));
            assert!(
                matches!(VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP), Err(actual) if actual == error)
            );
            file.read_failure.set(None);
            let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
            file.read_failure.set(Some(error));
            let mut target = [0xCC];
            assert_eq!(image.read_exact_at(0, &mut target), Err(error));
            assert_eq!(target, [0xCC]);
            file.read_failure.set(None);
            image.read_exact_at(0, &mut target).unwrap();
            assert_eq!(target, [0]);
        }
    }
}

#[test]
fn writer_faults_cannot_return_a_finished_image_identity() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let data = payload(3 * DATA_BYTES + 17);
        let (complete, _) = build(&data, DATA_BYTES, policy);
        for failure in 1..=complete.operations {
            let mut file = MemoryFile::new();
            file.fail_operation = Some(failure);
            let result = (|| {
                let mut builder = ImageBuilder::begin(data.len() as u64, policy, &mut file)?;
                for bytes in data.chunks(DATA_BYTES) {
                    builder.push(bytes)?;
                }
                builder.finish()
            })();
            assert_eq!(result, Err(Errno::EIO), "write/length/flush cut {failure}");
        }
        assert_eq!(Layout::new(0, policy), Err(Errno::EINVAL));
        assert_eq!(Layout::new(u64::MAX, policy), Err(Errno::EINVAL));
        let mut file = MemoryFile::new();
        let mut builder = ImageBuilder::begin(1, policy, &mut file).unwrap();
        let before = builder.target.operations;
        assert_eq!(builder.push(&[0, 1]), Err(Errno::EINVAL));
        assert_eq!(builder.target.operations, before);
        assert_eq!(builder.finish(), Err(Errno::EINVAL));
    }
}

#[cfg(unix)]
#[test]
fn two_index_pages_keep_authenticated_leaves_after_consuming_the_parent() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let mut file = SparseFile::new();
        let boundary = (policy.fanout() * DATA_BYTES) as u64;
        let length = boundary + 2 * DATA_BYTES as u64;
        let mut builder = ImageBuilder::begin(length, policy, &mut file).unwrap();
        builder.push_zeroes(length).unwrap();
        let identity = builder.finish().unwrap();
        let image = VerifiedImage::open(&file, identity.digest, CacheConfig::CONSTRAINED).unwrap();
        for offset in [0, boundary] {
            image.read_exact_at(offset, &mut [0]).unwrap();
        }
        let before = file.reads.get();
        for offset in [DATA_BYTES as u64, boundary + DATA_BYTES as u64] {
            image.read_exact_at(offset, &mut [0]).unwrap();
        }
        assert_eq!(file.reads.get() - before, 2 * DATA_BYTES as u64);
        let cache = image.cache.borrow();
        assert!(cache.index.iter().all(|page| page.key.is_some_and(|(level, _)| level == 0)));
        assert!(cache.index.iter().map(|page| page.bytes.capacity()).sum::<usize>() <= 2 * INDEX_BYTES);
    }
}

#[cfg(unix)]
#[test]
fn sparse_32_gib_reopen_reads_only_header_and_demanded_proofs_with_fixed_cache() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let mut file = SparseFile::new();
        let length = 32 * 1024 * 1024 * 1024u64;
        let mut builder = ImageBuilder::begin(length, policy, &mut file).unwrap();
        builder.push_zeroes(length).unwrap();
        let identity = builder.finish().unwrap();
        let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
        assert_eq!(file.reads.get(), HEADER_BYTES as u64);
        for block in 0..32u64 {
            let mut bytes = [0xCC; 31];
            image
                .read_exact_at(block * (1024 * 1024 * 1024), &mut bytes)
                .unwrap();
            assert_eq!(bytes, [0; 31]);
        }
        assert!(file.reads.get() < 3 * 1024 * 1024);
        let cache = image.cache.borrow();
        assert_eq!(cache.data.len(), CacheConfig::DESKTOP.data_pages);
        assert_eq!(cache.index.len(), CacheConfig::DESKTOP.index_pages);
        assert!(
            cache
                .data
                .iter()
                .map(|page| page.bytes.len())
                .sum::<usize>()
                <= CacheConfig::DESKTOP.data_pages * DATA_BYTES
        );
        assert!(
            cache
                .index
                .iter()
                .map(|page| page.bytes.len())
                .sum::<usize>()
                <= CacheConfig::DESKTOP.index_pages * INDEX_BYTES
        );
        println!(
            "32GiB authenticated-image demanded read bytes: {}",
            file.reads.get()
        );
    }
}

#[cfg(unix)]
#[test]
fn partial_index_and_data_failures_after_eviction_never_publish_poisoned_cache_entries() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fanout = policy.fanout();
        let mut file = SparseFile::new();
        let length = (fanout * (CacheConfig::DESKTOP.index_pages + 1) * DATA_BYTES) as u64;
        let mut builder = ImageBuilder::begin(length, policy, &mut file).unwrap();
        builder.push_zeroes(length).unwrap();
        let identity = builder.finish().unwrap();
        let layout = Layout::new(length, policy).unwrap();
        for failure_offset in [layout.levels[0].offset, HEADER_BYTES as u64] {
            for (config, error) in [CacheConfig::new(1, 1).unwrap(), CacheConfig::DESKTOP]
                .into_iter()
                .flat_map(|config| {
                    [Errno::EAGAIN, Errno::EIO, Errno::ENOMEM].map(|error| (config, error))
                })
            {
                let image = VerifiedImage::open(&file, identity.digest, config).unwrap();
                for node in 0..=config.index_pages {
                    image
                        .read_exact_at((node * fanout * DATA_BYTES) as u64, &mut [0])
                        .unwrap();
                }
                {
                    let cache = image.cache.borrow();
                    assert!(cache.data.iter().all(|page| page.key != Some(0)));
                    assert!(cache.index.iter().all(|page| page.key != Some((0, 0))));
                }
                file.partial_failure.set(Some((failure_offset, error)));
                let mut untouched = [0xCC; 31];
                assert_eq!(image.read_exact_at(0, &mut untouched), Err(error));
                assert_eq!(untouched, [0xCC; 31]);
                file.partial_failure.set(None);
                image.read_exact_at(0, &mut untouched).unwrap();
                assert_eq!(untouched, [0; 31]);
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn three_level_nonzero_markers_short_tail_and_swapped_proofs_are_authenticated() {
    for policy in [IntegrityPolicy::Crc32c, IntegrityPolicy::Sha256] {
        let fanout = policy.fanout();
        use std::os::unix::fs::FileExt;
        let mut file = SparseFile::new();
        let boundary = (fanout * fanout * DATA_BYTES) as u64;
        let length = boundary + (fanout * DATA_BYTES) as u64 + DATA_BYTES as u64 + 17;
        let markers = [
            (0, 11),
            (boundary - 1, 22),
            (boundary, 33),
            (boundary + (fanout * DATA_BYTES) as u64, 44),
            (length - 1, 55),
        ];
        let mut builder = ImageBuilder::begin(length, policy, &mut file).unwrap();
        let mut position = 0;
        for (offset, value) in markers {
            if offset > position {
                builder.push_zeroes(offset - position).unwrap();
            }
            builder.push(&[value]).unwrap();
            position = offset + 1;
        }
        let identity = builder.finish().unwrap();
        let layout = Layout::new(length, policy).unwrap();
        assert_eq!(layout.level_count, 3);
        let image =
            VerifiedImage::open(&file, identity.digest, CacheConfig::new(1, 1).unwrap()).unwrap();
        for (offset, value) in markers {
            let mut actual = [0];
            image.read_exact_at(offset, &mut actual).unwrap();
            assert_eq!(actual, [value]);
        }
        for (offset, value) in markers {
            file.file
                .write_all_at(&[value ^ 1], HEADER_BYTES as u64 + offset)
                .unwrap();
            let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
            let mut untouched = [0xCC];
            assert_eq!(image.read_exact_at(offset, &mut untouched), Err(Errno::EIO));
            assert_eq!(untouched, [0xCC]);
            file.file
                .write_all_at(&[value], HEADER_BYTES as u64 + offset)
                .unwrap();
        }
        for (level, first_node, second_node) in [(0, 0, fanout as u64), (1, 0, 1)] {
            let first_offset = layout.node_offset(level, first_node).unwrap();
            let second_offset = layout.node_offset(level, second_node).unwrap();
            let mut first = [0; INDEX_BYTES];
            let mut second = [0; INDEX_BYTES];
            file.file.read_exact_at(&mut first, first_offset).unwrap();
            file.file.read_exact_at(&mut second, second_offset).unwrap();
            assert_ne!(first, second);
            file.file.write_all_at(&second, first_offset).unwrap();
            file.file.write_all_at(&first, second_offset).unwrap();
            let image = VerifiedImage::open(&file, identity.digest, CacheConfig::DESKTOP).unwrap();
            for offset in [0, boundary] {
                let mut untouched = [0xCC];
                assert_eq!(image.read_exact_at(offset, &mut untouched), Err(Errno::EIO));
                assert_eq!(untouched, [0xCC]);
            }
            file.file.write_all_at(&first, first_offset).unwrap();
            file.file.write_all_at(&second, second_offset).unwrap();
        }
    }
}
