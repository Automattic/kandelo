//! Byte storage and bounded page caching shared by persistent filesystem formats.
use crate::IoBuffer;
use alloc::boxed::Box;
use wasm_posix_shared::Errno;

pub trait PositionedStorage {
    fn len(&mut self) -> Result<u64, Errno>;
    fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno>;
    fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno>;
    fn flush(&mut self) -> Result<(), Errno>;
    fn truncate(&mut self, len: u64) -> Result<(), Errno>;
}

impl<T: PositionedStorage + ?Sized> PositionedStorage for Box<T> {
    fn len(&mut self) -> Result<u64, Errno> {
        (**self).len()
    }

    fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        (**self).read_exact_at(offset, dst)
    }

    fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
        (**self).write_all_at(offset, src)
    }

    fn flush(&mut self) -> Result<(), Errno> {
        (**self).flush()
    }

    fn truncate(&mut self, len: u64) -> Result<(), Errno> {
        (**self).truncate(len)
    }
}

pub(crate) const READ_CACHE_PAGE_BYTES: usize = 4096;
pub(crate) const READ_CACHE_MAX_BYTES: usize = READ_CACHE_PAGE_BYTES * 32;

pub(crate) struct CachedIndexPage {
    offset: u64,
    length: usize,
    bytes: IoBuffer<u8>,
}

pub(crate) struct IndexReadCache {
    pub(crate) pages: IoBuffer<CachedIndexPage>,
    limit: usize,
}

impl IndexReadCache {
    #[cfg(test)]
    pub(crate) fn set_test_limit(&mut self, limit: usize) {
        self.limit = limit;
    }

    pub(crate) fn new() -> Self {
        let budget = (crate::io_buffer::IO_MEMORY.usage().1 / 64).min(READ_CACHE_MAX_BYTES);
        Self {
            pages: IoBuffer::new(),
            limit: budget / READ_CACHE_PAGE_BYTES,
        }
    }

    pub(crate) fn discard(&mut self) -> bool {
        let owned = self.pages.capacity() != 0;
        self.pages = IoBuffer::new();
        owned
    }

    fn remember(&mut self, offset: u64, source: &[u8]) -> Result<(), Errno> {
        if source.len() > READ_CACHE_PAGE_BYTES {
            return Err(Errno::EIO);
        }
        if self.pages.len() < self.limit {
            let prepared = (|| {
                let mut bytes = IoBuffer::try_filled(READ_CACHE_PAGE_BYTES, 0)?;
                self.pages.try_reserve(1)?;
                bytes[..source.len()].copy_from_slice(source);
                Ok(CachedIndexPage {
                    offset,
                    length: source.len(),
                    bytes,
                })
            })();
            match prepared {
                Ok(page) => {
                    self.pages.push(page);
                    return Ok(());
                }
                Err(Errno::ENOMEM) => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(page) = self.pages.first_mut() {
            page.bytes[..source.len()].copy_from_slice(source);
            page.offset = offset;
            page.length = source.len();
            self.pages.rotate_left(1);
        }
        Ok(())
    }

    pub(crate) fn read_exact_at<S: PositionedStorage>(
        &mut self,
        storage: &mut S,
        offset: u64,
        destination: &mut [u8],
        admit: bool,
    ) -> Result<(), Errno> {
        if destination.len() > READ_CACHE_PAGE_BYTES {
            return Err(Errno::EIO);
        }
        if let Some(position) = self
            .pages
            .iter()
            .position(|page| page.offset == offset && page.length == destination.len())
        {
            destination.copy_from_slice(&self.pages[position].bytes[..destination.len()]);
            self.pages[position..].rotate_left(1);
            return Ok(());
        }
        storage.read_exact_at(offset, destination)?;
        if admit {
            self.remember(offset, destination)
        } else {
            Ok(())
        }
    }
}
