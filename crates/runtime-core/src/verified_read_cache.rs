use crate::io_buffer::IoBuffer;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

pub(crate) const CHUNK_BYTES: usize = 1024 * 1024;
const MAX_TABLE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILES: usize = 64;
const MAX_CHUNKS: usize = 4;

struct VerifiedFile {
    key: u64,
    digest: [u8; 32],
    size: u64,
    chunks: IoBuffer<[u8; 32]>,
}

struct CachedChunk {
    key: u64,
    chunk: usize,
    bytes: IoBuffer<u8>,
}

pub(crate) struct VerifiedReadCache {
    files: IoBuffer<VerifiedFile>,
    chunks: IoBuffer<CachedChunk>,
}

impl VerifiedReadCache {
    pub(crate) const fn new() -> Self {
        Self {
            files: IoBuffer::new(),
            chunks: IoBuffer::new(),
        }
    }

    fn table_bytes(&self) -> usize {
        self.files
            .iter()
            .map(|file| file.chunks.capacity() * 32)
            .sum()
    }

    pub(crate) fn invalidate(&mut self, key: u64) {
        self.files.retain(|file| file.key != key);
        self.chunks.retain(|chunk| chunk.key != key);
    }

    pub(crate) fn retain_file(&mut self, key: Option<u64>) {
        self.chunks.clear();
        self.files.retain(|file| Some(file.key) == key);
    }

    pub(crate) fn prepare(&mut self, key: u64, size: u64) -> Result<Option<IoBuffer<[u8; 32]>>, Errno> {
        self.invalidate(key);
        let count = size.div_ceil(CHUNK_BYTES as u64);
        if count > (MAX_TABLE_BYTES / 32) as u64 {
            return Ok(None);
        }
        let count = count as usize;
        let needed = count * 32;
        while self.files.len() >= MAX_FILES || self.table_bytes() + needed > MAX_TABLE_BYTES {
            let key = self.files.first().ok_or(Errno::EIO)?.key;
            self.invalidate(key);
        }
        loop {
            match allocate_buffer(count) {
                Ok(hashes) => return Ok(Some(hashes)),
                Err(Errno::ENOMEM) if !self.files.is_empty() => {
                    self.invalidate(self.files[0].key);
                }
                Err(Errno::ENOMEM) => return Ok(None),
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) fn allocate_chunk(&mut self, key: u64, length: usize) -> Result<IoBuffer<u8>, Errno> {
        if length > CHUNK_BYTES { return Err(Errno::EINVAL); }
        loop {
            match allocate_buffer(length) {
                Ok(mut bytes) => { bytes.resize(length, 0); return Ok(bytes); }
                Err(Errno::ENOMEM) if !self.chunks.is_empty() => { self.chunks.remove(0); }
                Err(Errno::ENOMEM) if self.files.iter().any(|file| file.key != key) => {
                    let victim = self.files.iter().find(|file| file.key != key).ok_or(Errno::EIO)?.key;
                    self.invalidate(victim);
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) fn install(
        &mut self,
        key: u64,
        digest: [u8; 32],
        size: u64,
        chunks: IoBuffer<[u8; 32]>,
    ) -> Result<(), Errno> {
        if chunks.len() as u64 != size.div_ceil(CHUNK_BYTES as u64)
            || chunks.capacity() > MAX_TABLE_BYTES / 32
        {
            return Err(Errno::EINVAL);
        }
        self.invalidate(key);
        while self.files.len() >= MAX_FILES
            || self.table_bytes() + chunks.capacity() * 32 > MAX_TABLE_BYTES
        {
            let key = self.files.first().ok_or(Errno::EIO)?.key;
            self.invalidate(key);
        }
        if self.files.capacity() == 0 { self.files = allocate_buffer(MAX_FILES)?; }
        self.files.push(VerifiedFile {
            key,
            digest,
            size,
            chunks,
        });
        Ok(())
    }

    pub(crate) fn chunk_digest(
        &mut self,
        key: u64,
        digest: [u8; 32],
        size: u64,
        chunk: usize,
    ) -> Option<[u8; 32]> {
        let index = self
            .files
            .iter()
            .position(|file| file.key == key && file.digest == digest && file.size == size)?;
        let result = self.files[index].chunks.get(chunk).copied()?;
        let record = self.files.remove(index);
        self.files.push(record);
        Some(result)
    }

    pub(crate) fn copy_at(
        &mut self,
        key: u64,
        digest: [u8; 32],
        size: u64,
        offset: u64,
        target: &mut [u8],
    ) -> Option<usize> {
        let chunk = usize::try_from(offset / CHUNK_BYTES as u64).ok()?;
        self.chunk_digest(key, digest, size, chunk)?;
        let index = self
            .chunks
            .iter()
            .position(|entry| entry.key == key && entry.chunk == chunk)?;
        let start = (offset % CHUNK_BYTES as u64) as usize;
        let page = self.chunks.remove(index);
        let count = target.len().min(page.bytes.len().checked_sub(start)?);
        target[..count].copy_from_slice(&page.bytes[start..start + count]);
        self.chunks.push(page);
        Some(count)
    }

    pub(crate) fn install_chunk(
        &mut self,
        key: u64,
        digest: [u8; 32],
        size: u64,
        chunk: usize,
        bytes: IoBuffer<u8>,
    ) -> Result<(), Errno> {
        let expected = self
            .chunk_digest(key, digest, size, chunk)
            .ok_or(Errno::EIO)?;
        let start = (chunk as u64)
            .checked_mul(CHUNK_BYTES as u64)
            .ok_or(Errno::EIO)?;
        let length = size
            .checked_sub(start)
            .ok_or(Errno::EIO)?
            .min(CHUNK_BYTES as u64);
        if bytes.len() as u64 != length
            || bytes.capacity() > CHUNK_BYTES
            || Sha256::digest(&bytes)[..] != expected
        {
            self.invalidate(key);
            return Err(Errno::EIO);
        }
        self.chunks
            .retain(|entry| entry.key != key || entry.chunk != chunk);
        if self.chunks.len() == MAX_CHUNKS {
            self.chunks.remove(0);
        }
        if self.chunks.capacity() == 0 { self.chunks = allocate_buffer(MAX_CHUNKS)?; }
        self.chunks.push(CachedChunk { key, chunk, bytes });
        Ok(())
    }
}

fn allocate_buffer<Value>(capacity: usize) -> Result<IoBuffer<Value>, Errno> {
    IoBuffer::allocate(capacity, false, |values| values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn owned<Value: Copy>(values: &[Value]) -> IoBuffer<Value> {
        let mut result = allocate_buffer(values.len()).unwrap_or_else(|error| {
            panic!("cache fixture allocation failed: {error:?}; budget={:?}", crate::io_buffer::IO_MEMORY.snapshot())
        });
        result.extend_from_slice(values);
        result
    }

    #[test]
    fn chunk_cache_checks_identity_integrity_and_lru_bounds() {
        let (retained, limit) = crate::io_buffer::IO_MEMORY.usage();
        let fixture_allowance = 2 * (MAX_CHUNKS + 2) * CHUNK_BYTES;
        let _budget = crate::io_buffer::test_budget(limit.max(retained + fixture_allowance));
        let mut cache = VerifiedReadCache::new();
        let data = vec![7; CHUNK_BYTES];
        let digest: [u8; 32] = Sha256::digest(&data).into();
        for key in 1..=6 {
            cache
                .install(key, digest, data.len() as u64, owned(&[digest]))
                .unwrap();
            cache
                .install_chunk(key, digest, data.len() as u64, 0, owned(&data))
                .unwrap();
        }
        assert_eq!(cache.chunks.len(), MAX_CHUNKS);
        assert!(
            cache
                .copy_at(1, digest, data.len() as u64, 0, &mut [0; 1])
                .is_none()
        );
        assert_eq!(
            cache.copy_at(3, digest, data.len() as u64, 0, &mut [0; 1]),
            Some(1)
        );
        cache
            .install_chunk(1, digest, data.len() as u64, 0, owned(&data))
            .unwrap();
        assert!(cache.chunks.iter().any(|entry| entry.key == 3));
        assert!(!cache.chunks.iter().any(|entry| entry.key == 4));
        assert!(
            cache
                .copy_at(3, [0; 32], data.len() as u64, 0, &mut [0; 1])
                .is_none()
        );
        assert_eq!(
            cache.install_chunk(3, digest, data.len() as u64, 0, owned(&vec![8; CHUNK_BYTES])),
            Err(Errno::EIO)
        );
        assert!(
            cache
                .chunk_digest(3, digest, data.len() as u64, 0)
                .is_none()
        );
    }

    #[test]
    fn verification_tables_are_bounded_and_oversized_files_need_not_allocate_one() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(baseline + 2 * MAX_TABLE_BYTES
            + 2 * MAX_FILES * core::mem::size_of::<VerifiedFile>()
            + 2 * core::mem::size_of::<[u8; 32]>());
        let mut cache = VerifiedReadCache::new();
        let size = 64 * 1024 * 1024 * 1024;
        for key in 1..=5 {
            let mut hashes = cache.prepare(key, size).unwrap().unwrap();
            hashes.resize((size / CHUNK_BYTES as u64) as usize, [7; 32]);
            cache.install(key, [7; 32], size, hashes).unwrap();
        }
        assert_eq!(cache.table_bytes(), MAX_TABLE_BYTES);
        assert!(cache.chunk_digest(1, [7; 32], size, 0).is_none());
        assert!(cache.prepare(9, u64::MAX).unwrap().is_none());
        for key in 10..80 {
            cache.install(key, [7; 32], 1, owned(&[[7; 32]])).unwrap();
        }
        assert!(cache.files.len() <= MAX_FILES);
        assert!(cache.table_bytes() <= MAX_TABLE_BYTES);
        cache.invalidate(79);
        assert!(cache.chunk_digest(79, [7; 32], 1, 0).is_none());
    }

    #[test]
    fn payload_admission_evicts_old_chunks_without_discarding_verification_identity() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut cache = VerifiedReadCache::new();
        let data = vec![7; CHUNK_BYTES];
        let digest: [u8; 32] = Sha256::digest(&data).into();
        cache.install(7, digest, data.len() as u64, owned(&[digest])).unwrap();
        cache.install_chunk(7, digest, data.len() as u64, 0, owned(&data)).unwrap();
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(used);
            let mut replacement = cache.allocate_chunk(7, CHUNK_BYTES).unwrap();
            replacement.copy_from_slice(&data);
            assert!(cache.chunks.is_empty());
            assert_eq!(cache.chunk_digest(7, digest, data.len() as u64, 0), Some(digest));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, used);
            cache.install_chunk(7, digest, data.len() as u64, 0, replacement).unwrap();
            assert_eq!(cache.copy_at(7, digest, data.len() as u64, 0, &mut [0]), Some(1));
        }
        drop(cache);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }
}
