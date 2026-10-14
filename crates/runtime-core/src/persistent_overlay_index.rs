use crate::persistent_overlay::OverlayStorage;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

const MAGIC: &[u8; 4] = b"KIDX";
const VERSION: u32 = 1;
const TOMBSTONE_VERSION: u32 = 2;
const HEADER_BYTES: usize = 160;
const RECORD_BYTES: usize = 56;
const RECORDS_PER_PAGE: usize = 73;
const PAGE_BYTES: usize = RECORD_BYTES * RECORDS_PER_PAGE;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlockCheckpointEntry {
    pub inode: u64,
    pub block: u64,
    pub offset: u64,
    pub digest: [u8; 32],
}

impl BlockCheckpointEntry {
    pub fn is_tombstone(&self) -> bool {
        self.offset == 0
    }

    fn encode(self) -> [u8; RECORD_BYTES] {
        let mut bytes = [0; RECORD_BYTES];
        bytes[..8].copy_from_slice(&self.inode.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.block.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.offset.to_le_bytes());
        bytes[24..].copy_from_slice(&self.digest);
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != RECORD_BYTES {
            return Err(Errno::EIO);
        }
        let mut digest = [0; 32];
        digest.copy_from_slice(&bytes[24..]);
        Ok(Self {
            inode: u64::from_le_bytes(bytes[..8].try_into().map_err(|_| Errno::EIO)?),
            block: u64::from_le_bytes(bytes[8..16].try_into().map_err(|_| Errno::EIO)?),
            offset: u64::from_le_bytes(bytes[16..24].try_into().map_err(|_| Errno::EIO)?),
            digest,
        })
    }

    fn validate(&self, journal_end: u64, allow_tombstone: bool) -> Result<(), Errno> {
        if self.inode == 0 {
            return Err(Errno::EIO);
        }
        if self.is_tombstone() {
            return if allow_tombstone && self.digest == [0; 32] {
                Ok(())
            } else {
                Err(Errno::EIO)
            };
        }
        if self.offset < 72 || self.offset.checked_add(4096).ok_or(Errno::EIO)? > journal_end {
            return Err(Errno::EIO);
        }
        Ok(())
    }
}

pub struct BlockCheckpoint<S: OverlayStorage> {
    storage: S,
    count: u64,
    journal_end: u64,
    next_sequence: u64,
    cached_page: [u8; PAGE_BYTES],
    cached_page_index: Option<u64>,
}

impl<S: OverlayStorage> BlockCheckpoint<S> {
    pub fn create(
        storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
        next_sequence: u64,
        entries: impl IntoIterator<Item = BlockCheckpointEntry>,
    ) -> Result<Self, Errno> {
        Self::create_checked(
            storage,
            base_digest,
            journal_digest,
            journal_end,
            next_sequence,
            entries.into_iter().map(Ok),
        )
    }

    pub fn create_checked(
        mut storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
        next_sequence: u64,
        entries: impl IntoIterator<Item = Result<BlockCheckpointEntry, Errno>>,
    ) -> Result<Self, Errno> {
        if storage.len()? != 0 {
            return Err(Errno::EEXIST);
        }
        if journal_end < 72 || next_sequence == 0 {
            return Err(Errno::EINVAL);
        }
        let mut page = [0; PAGE_BYTES];
        let mut page_entries = 0usize;
        let mut count = 0u64;
        let mut digest = Sha256::new();
        let mut previous = None;
        let mut has_tombstone = false;
        for entry in entries {
            let entry = entry?;
            entry.validate(journal_end, true)?;
            has_tombstone |= entry.is_tombstone();
            let key = (entry.inode, entry.block);
            if previous.is_some_and(|previous| previous >= key) {
                return Err(Errno::EINVAL);
            }
            let encoded = entry.encode();
            page[page_entries * RECORD_BYTES..(page_entries + 1) * RECORD_BYTES]
                .copy_from_slice(&encoded);
            digest.update(encoded);
            page_entries += 1;
            count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            if page_entries == RECORDS_PER_PAGE {
                let offset = record_offset(count - page_entries as u64)?;
                storage.write_all_at(offset, &page)?;
                page_entries = 0;
            }
            previous = Some(key);
        }
        if page_entries != 0 {
            let offset = record_offset(count - page_entries as u64)?;
            storage.write_all_at(offset, &page[..page_entries * RECORD_BYTES])?;
        }
        storage.flush()?;
        let mut header = [0; HEADER_BYTES];
        header[..4].copy_from_slice(MAGIC);
        let version = if has_tombstone {
            TOMBSTONE_VERSION
        } else {
            VERSION
        };
        header[4..8].copy_from_slice(&version.to_le_bytes());
        header[8..40].copy_from_slice(&base_digest);
        header[40..72].copy_from_slice(&journal_digest);
        header[72..80].copy_from_slice(&journal_end.to_le_bytes());
        header[80..88].copy_from_slice(&count.to_le_bytes());
        header[88..96].copy_from_slice(&next_sequence.to_le_bytes());
        header[96..128].copy_from_slice(&digest.finalize());
        let header_digest = Sha256::digest(&header[..128]);
        header[128..].copy_from_slice(&header_digest);
        storage.write_all_at(0, &header)?;
        storage.flush()?;
        Ok(Self {
            storage,
            count,
            journal_end,
            next_sequence,
            cached_page: [0; PAGE_BYTES],
            cached_page_index: None,
        })
    }

    pub fn open(
        mut storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
    ) -> Result<Self, Errno> {
        if journal_end < 72 {
            return Err(Errno::EIO);
        }
        let mut header = [0; HEADER_BYTES];
        storage.read_exact_at(0, &mut header)?;
        let version = u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?);
        if &header[..4] != MAGIC
            || (version != VERSION && version != TOMBSTONE_VERSION)
            || header[8..40] != base_digest
            || header[40..72] != journal_digest
            || u64::from_le_bytes(header[72..80].try_into().map_err(|_| Errno::EIO)?) != journal_end
            || header[128..] != Sha256::digest(&header[..128])[..]
        {
            return Err(Errno::EIO);
        }
        let count = u64::from_le_bytes(header[80..88].try_into().map_err(|_| Errno::EIO)?);
        let next_sequence = u64::from_le_bytes(header[88..96].try_into().map_err(|_| Errno::EIO)?);
        if next_sequence == 0 {
            return Err(Errno::EIO);
        }
        if storage.len()? != record_offset(count)? {
            return Err(Errno::EIO);
        }
        let mut digest = Sha256::new();
        let mut page = [0; PAGE_BYTES];
        let mut scanned = 0u64;
        let mut previous = None;
        while scanned < count {
            let entries = (count - scanned).min(RECORDS_PER_PAGE as u64) as usize;
            let bytes = &mut page[..entries * RECORD_BYTES];
            storage.read_exact_at(record_offset(scanned)?, bytes)?;
            digest.update(&*bytes);
            for record in bytes.chunks_exact(RECORD_BYTES) {
                let entry = BlockCheckpointEntry::decode(record)?;
                entry.validate(journal_end, version == TOMBSTONE_VERSION)?;
                let key = (entry.inode, entry.block);
                if previous.is_some_and(|previous| previous >= key) {
                    return Err(Errno::EIO);
                }
                previous = Some(key);
            }
            scanned += entries as u64;
        }
        if header[96..128] != digest.finalize()[..] {
            return Err(Errno::EIO);
        }
        Ok(Self {
            storage,
            count,
            journal_end,
            next_sequence,
            cached_page: [0; PAGE_BYTES],
            cached_page_index: None,
        })
    }

    pub fn lookup(
        &mut self,
        inode: u64,
        block: u64,
    ) -> Result<Option<BlockCheckpointEntry>, Errno> {
        let mut low = 0;
        let mut high = self.count;
        while low < high {
            let middle = low + (high - low) / 2;
            let entry = self.read_entry(middle)?;
            match (entry.inode, entry.block).cmp(&(inode, block)) {
                core::cmp::Ordering::Less => low = middle + 1,
                core::cmp::Ordering::Greater => high = middle,
                core::cmp::Ordering::Equal => return Ok(Some(entry)),
            }
        }
        Ok(None)
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    pub fn journal_end(&self) -> u64 {
        self.journal_end
    }

    pub fn entry_at(&mut self, index: u64) -> Result<Option<BlockCheckpointEntry>, Errno> {
        if index >= self.count {
            return Ok(None);
        }
        self.read_entry(index).map(Some)
    }

    pub fn into_storage(self) -> S {
        self.storage
    }

    fn read_entry(&mut self, index: u64) -> Result<BlockCheckpointEntry, Errno> {
        let page_index = index / RECORDS_PER_PAGE as u64;
        if self.cached_page_index != Some(page_index) {
            let first = page_index * RECORDS_PER_PAGE as u64;
            let entries = (self.count - first).min(RECORDS_PER_PAGE as u64) as usize;
            self.storage.read_exact_at(
                record_offset(first)?,
                &mut self.cached_page[..entries * RECORD_BYTES],
            )?;
            self.cached_page_index = Some(page_index);
        }
        let within = index as usize % RECORDS_PER_PAGE;
        BlockCheckpointEntry::decode(
            &self.cached_page[within * RECORD_BYTES..(within + 1) * RECORD_BYTES],
        )
    }
}

fn record_offset(index: u64) -> Result<u64, Errno> {
    index
        .checked_mul(RECORD_BYTES as u64)
        .and_then(|bytes| bytes.checked_add(HEADER_BYTES as u64))
        .ok_or(Errno::EOVERFLOW)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[derive(Default)]
    struct MemoryStorage {
        bytes: Vec<u8>,
        fail_flush: bool,
    }

    impl OverlayStorage for MemoryStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            Ok(self.bytes.len() as u64)
        }

        fn read_exact_at(&mut self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(destination.len()).ok_or(Errno::EIO)?;
            destination.copy_from_slice(self.bytes.get(start..end).ok_or(Errno::EIO)?);
            Ok(())
        }

        fn write_all_at(&mut self, offset: u64, source: &[u8]) -> Result<(), Errno> {
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(source.len()).ok_or(Errno::EIO)?;
            if end > self.bytes.len() {
                self.bytes.resize(end, 0);
            }
            self.bytes[start..end].copy_from_slice(source);
            Ok(())
        }

        fn flush(&mut self) -> Result<(), Errno> {
            if self.fail_flush {
                Err(Errno::EIO)
            } else {
                Ok(())
            }
        }

        fn truncate(&mut self, length: u64) -> Result<(), Errno> {
            self.bytes
                .truncate(usize::try_from(length).map_err(|_| Errno::EIO)?);
            Ok(())
        }
    }

    fn entries() -> Vec<BlockCheckpointEntry> {
        (0..200)
            .map(|block| BlockCheckpointEntry {
                inode: 7,
                block,
                offset: 72 + block * 4096,
                digest: [block as u8; 32],
            })
            .collect()
    }

    #[test]
    fn sorted_checkpoint_reopens_and_finds_blocks_without_a_resident_map() {
        let records = entries();
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            72 + 200 * 4096,
            201,
            records.clone(),
        )
        .unwrap();
        let storage = checkpoint.into_storage();
        assert_eq!(u32::from_le_bytes(storage.bytes[4..8].try_into().unwrap()), 1);
        let mut reopened =
            BlockCheckpoint::open(storage, [1; 32], [2; 32], 72 + 200 * 4096).unwrap();
        assert_eq!(reopened.count(), 200);
        assert_eq!(reopened.next_sequence(), 201);
        for record in records {
            assert_eq!(
                reopened.lookup(record.inode, record.block),
                Ok(Some(record))
            );
        }
        assert_eq!(reopened.lookup(7, 200), Ok(None));
        assert_eq!(reopened.lookup(8, 0), Ok(None));
    }

    #[test]
    fn tombstone_checkpoint_uses_v2_and_v1_remains_readable() {
        let entry = BlockCheckpointEntry {
            inode: 7,
            block: 3,
            offset: 0,
            digest: [0; 32],
        };
        assert!(matches!(
            BlockCheckpoint::create(
                MemoryStorage::default(),
                [1; 32],
                [2; 32],
                72,
                2,
                [BlockCheckpointEntry {
                    digest: [1; 32],
                    ..entry
                }],
            ),
            Err(Errno::EIO)
        ));
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            72,
            2,
            [entry],
        )
        .unwrap();
        let mut storage = checkpoint.into_storage();
        assert_eq!(u32::from_le_bytes(storage.bytes[4..8].try_into().unwrap()), 2);
        let mut reopened = BlockCheckpoint::open(
            MemoryStorage {
                bytes: storage.bytes.clone(),
                ..MemoryStorage::default()
            },
            [1; 32],
            [2; 32],
            72,
        )
        .unwrap();
        assert_eq!(reopened.lookup(7, 3), Ok(Some(entry)));
        storage.bytes[4..8].copy_from_slice(&VERSION.to_le_bytes());
        let digest = Sha256::digest(&storage.bytes[..128]);
        storage.bytes[128..160].copy_from_slice(&digest);
        assert!(matches!(
            BlockCheckpoint::open(storage, [1; 32], [2; 32], 72),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn damaged_or_wrongly_bound_checkpoint_is_rejected() {
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            72 + 200 * 4096,
            201,
            entries(),
        )
        .unwrap();
        let storage = checkpoint.into_storage();
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                [3; 32],
                [2; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                [1; 32],
                [3; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
        let mut damaged = storage.bytes.clone();
        damaged[HEADER_BYTES + 100 * RECORD_BYTES + 5] ^= 1;
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: damaged,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
        let mut truncated = storage.bytes;
        truncated.pop();
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: truncated,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn unsorted_entries_and_failed_flush_cannot_publish_a_checkpoint() {
        let mut unsorted = entries();
        unsorted.swap(0, 1);
        assert!(matches!(
            BlockCheckpoint::create(
                MemoryStorage::default(),
                [1; 32],
                [2; 32],
                72 + 200 * 4096,
                201,
                unsorted
            ),
            Err(Errno::EINVAL)
        ));
        assert!(matches!(
            BlockCheckpoint::create(
                MemoryStorage {
                    fail_flush: true,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                72 + 200 * 4096,
                201,
                entries()
            ),
            Err(Errno::EIO)
        ));
    }
}
