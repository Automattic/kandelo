//! Kernel-owned page identity for direct shared objects.
//!
//! The inode and VMAs retain this binding. A host receives only a backing
//! resource and physical byte ranges, never the object's logical identity or
//! its page-selection/lifetime decisions.

use super::{
    physical::{HostMemory, PagePool, PhysicalMemory},
    GroupBackingLease,
};
use crate::{io_owner::IoArc, process::HostIO, IoBuffer};
use core::sync::atomic::{AtomicU8, Ordering};
use wasm_posix_shared::{program_extensions::memory_group_v3 as layout, Errno};

const PREPARED: u8 = 0;
const ALLOCATED: u8 = 1;
const RETIRED: u8 = 2;
const UNCERTAIN: u8 = 3;
const PAGE: u32 = layout::PAGE_BYTES;

pub(crate) struct SharedPages {
    group: u32,
    object: u64,
    resource: u64,
    pages: spin::Mutex<IoBuffer<u32>>,
    phase: AtomicU8,
}

impl core::fmt::Debug for SharedPages {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("SharedPages")
            .field("group", &self.group)
            .field("resource", &self.resource)
            .field("phase", &self.phase.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl SharedPages {
    /// Admit the complete vector and its shared owner before reserving any
    /// foreign pages. Cloning this metadata cannot fail after publication.
    pub(crate) fn prepare(
        backing: GroupBackingLease,
        object: u64,
        count: u32,
    ) -> Result<IoArc<Self>, Errno> {
        if object == 0 {
            return Err(Errno::EINVAL);
        }
        if count == 0 || count >= layout::MAXIMUM_PAGES {
            return Err(Errno::ENOMEM);
        }
        let pages = IoBuffer::try_filled(count as usize, 0)?;
        IoArc::try_new(Self {
            group: backing.group.as_raw(),
            object,
            resource: backing.serial,
            pages: spin::Mutex::new(pages),
            phase: AtomicU8::new(PREPARED),
        })
    }

    pub(crate) fn group(&self) -> u32 {
        self.group
    }
    pub(crate) fn object(&self) -> u64 {
        self.object
    }
    pub(crate) fn contains(&self, page: u32) -> bool {
        self.allocated() && self.pages.lock().binary_search(&page).is_ok()
    }
    pub(crate) fn resource(&self) -> u64 {
        self.resource
    }
    pub(crate) fn byte_length(&self) -> usize {
        self.pages.lock().len() * PAGE as usize
    }
    pub(crate) fn allocated(&self) -> bool {
        self.phase.load(Ordering::Acquire) == ALLOCATED
    }

    pub(crate) fn with_pages<T>(&self, work: impl FnOnce(u64, &[u32]) -> T) -> Result<T, Errno> {
        let pages = self.pages.lock();
        self.check(&pages, 0, 0)?;
        Ok(work(self.resource, &pages))
    }

    pub(crate) fn allocate(&self, pool: &mut PagePool, host: &mut dyn HostIO) -> Result<(), Errno> {
        self.allocate_memory(
            pool,
            &mut HostMemory {
                resource: self.resource,
                host,
            },
        )
    }

    pub(crate) fn allocate_memory(
        &self,
        pool: &mut PagePool,
        memory: &mut impl PhysicalMemory,
    ) -> Result<(), Errno> {
        let mut pages = self.pages.lock();
        if self.phase.load(Ordering::Acquire) != PREPARED {
            return Err(Errno::EALREADY);
        }
        match pool.allocate_pages(memory, &mut pages) {
            Ok(()) => {
                self.phase.store(ALLOCATED, Ordering::Release);
                Ok(())
            }
            Err(error) => {
                if error == Errno::EIO {
                    self.phase.store(UNCERTAIN, Ordering::Release);
                }
                Err(error)
            }
        }
    }

    pub(crate) fn read(
        &self,
        offset: u64,
        output: &mut [u8],
        host: &mut dyn HostIO,
    ) -> Result<usize, Errno> {
        self.read_memory(
            offset,
            output,
            &HostMemory {
                resource: self.resource,
                host,
            },
        )
    }

    fn read_memory(
        &self,
        offset: u64,
        output: &mut [u8],
        memory: &impl PhysicalMemory,
    ) -> Result<usize, Errno> {
        let pages = self.pages.lock();
        self.check(&pages, offset, output.len())?;
        let mut copied = 0;
        while copied < output.len() {
            let logical = offset + copied as u64;
            let within = (logical % u64::from(PAGE)) as u32;
            let count = output
                .len()
                .saturating_sub(copied)
                .min((PAGE - within) as usize);
            let page = pages[(logical / u64::from(PAGE)) as usize];
            memory.read(page * PAGE + within, &mut output[copied..copied + count])?;
            copied += count;
        }
        Ok(copied)
    }

    pub(crate) fn write(
        &self,
        offset: u64,
        input: &[u8],
        host: &mut dyn HostIO,
    ) -> Result<usize, Errno> {
        self.write_memory(
            offset,
            input,
            &mut HostMemory {
                resource: self.resource,
                host,
            },
        )
    }

    fn write_memory(
        &self,
        offset: u64,
        input: &[u8],
        memory: &mut impl PhysicalMemory,
    ) -> Result<usize, Errno> {
        let pages = self.pages.lock();
        self.check(&pages, offset, input.len())?;
        let mut copied = 0;
        while copied < input.len() {
            let logical = offset + copied as u64;
            let within = (logical % u64::from(PAGE)) as u32;
            let count = input
                .len()
                .saturating_sub(copied)
                .min((PAGE - within) as usize);
            let page = pages[(logical / u64::from(PAGE)) as usize];
            memory.write(page * PAGE + within, &input[copied..copied + count])?;
            copied += count;
        }
        Ok(copied)
    }

    fn check(&self, pages: &[u32], offset: u64, length: usize) -> Result<(), Errno> {
        match self.phase.load(Ordering::Acquire) {
            ALLOCATED => {}
            PREPARED => return Err(Errno::EAGAIN),
            _ => return Err(Errno::EIO),
        }
        let end = offset.checked_add(length as u64).ok_or(Errno::EINVAL)?;
        if end > pages.len() as u64 * u64::from(PAGE) {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    /// Only the kernel storage owner calls this after its object/image holds
    /// and native observations permit release. The final fence is rechecked
    /// under the physical allocator lock before any ownership bit changes.
    pub(crate) fn retire(
        &self,
        pool: &mut PagePool,
        host: &mut dyn HostIO,
        validate: impl FnOnce(&mut dyn PhysicalMemory) -> Result<bool, Errno>,
    ) -> Result<(), Errno> {
        self.retire_memory(
            pool,
            &mut HostMemory {
                resource: self.resource,
                host,
            },
            validate,
        )
    }

    pub(crate) fn retire_memory(
        &self,
        pool: &mut PagePool,
        memory: &mut impl PhysicalMemory,
        validate: impl FnOnce(&mut dyn PhysicalMemory) -> Result<bool, Errno>,
    ) -> Result<(), Errno> {
        let pages = self.pages.lock();
        if self.phase.load(Ordering::Acquire) != ALLOCATED {
            return Err(Errno::ESRCH);
        }
        match pool.release_checked(memory, &pages, validate) {
            Ok(()) => {
                self.phase.store(RETIRED, Ordering::Release);
                Ok(())
            }
            Err(error) => {
                if error == Errno::EIO {
                    self.phase.store(UNCERTAIN, Ordering::Release);
                }
                Err(error)
            }
        }
    }

    pub(crate) fn page(&self, index: usize) -> Result<u32, Errno> {
        let pages = self.pages.lock();
        if !self.allocated() {
            return Err(Errno::EAGAIN);
        }
        pages.get(index).copied().ok_or(Errno::EINVAL)
    }
}

#[cfg(test)]
mod tests {
    use super::super::physical::tests::Memory;
    use super::super::{MemoryGroupLimits, MemoryGroups};
    use super::*;

    fn backing() -> (MemoryGroups, GroupBackingLease) {
        let mut groups = MemoryGroups::new();
        groups.configure(16, 1).unwrap();
        let group = groups
            .create(MemoryGroupLimits {
                maximum_pages: 16,
                maximum_processes: 8,
                maximum_tasks: 16,
            })
            .unwrap();
        let lease = groups.retain_backing(group).unwrap();
        (groups, lease)
    }

    #[test]
    fn descriptor_bytes_and_mapped_stores_share_fragmented_kernel_pages() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        pool.allocate_contiguous(&mut memory, 4).unwrap();
        pool.release_checked(&mut memory, &[1, 3], |_| Ok(true))
            .unwrap();
        let (_groups, lease) = backing();
        let storage = SharedPages::prepare(lease, 101, 2).unwrap();
        storage.allocate_memory(&mut pool, &mut memory).unwrap();
        assert_eq!((storage.page(0).unwrap(), storage.page(1).unwrap()), (1, 3));
        storage
            .write_memory(u64::from(PAGE - 2), b"abcd", &mut memory)
            .unwrap();
        let mut bytes = [0; 2];
        memory.read(2 * PAGE - 2, &mut bytes).unwrap();
        assert_eq!(&bytes, b"ab");
        memory.read(3 * PAGE, &mut bytes).unwrap();
        assert_eq!(&bytes, b"cd");
        memory.write(3 * PAGE + 1, b"Z").unwrap();
        let mut descriptor = [0; 4];
        storage
            .read_memory(u64::from(PAGE - 2), &mut descriptor, &memory)
            .unwrap();
        assert_eq!(&descriptor, b"abcZ");
    }

    #[test]
    fn refused_allocation_cannot_be_read_as_page_zero() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        let (_groups, lease) = backing();
        let storage = SharedPages::prepare(lease, 101, 2).unwrap();
        assert_eq!(
            storage.read_memory(0, &mut [0], &memory),
            Err(Errno::EAGAIN)
        );
        memory.refuse_growth = true;
        assert_eq!(
            storage.allocate_memory(&mut pool, &mut memory),
            Err(Errno::ENOMEM)
        );
        assert_eq!(
            storage.write_memory(0, b"x", &mut memory),
            Err(Errno::EAGAIN)
        );
    }

    #[test]
    fn bounds_and_retirement_are_checked_before_any_descriptor_write() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        let (_groups, lease) = backing();
        let storage = SharedPages::prepare(lease, 101, 1).unwrap();
        storage.allocate_memory(&mut pool, &mut memory).unwrap();
        storage.write_memory(0, b"before", &mut memory).unwrap();
        assert_eq!(
            storage.write_memory(u64::from(PAGE - 1), b"bad", &mut memory),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            storage.write_memory(u64::MAX, b"bad", &mut memory),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            storage.retire_memory(&mut pool, &mut memory, |_| Ok(false)),
            Err(Errno::EAGAIN)
        );
        let mut bytes = [0; 6];
        storage.read_memory(0, &mut bytes, &memory).unwrap();
        assert_eq!(&bytes, b"before");
        storage
            .retire_memory(&mut pool, &mut memory, |_| Ok(true))
            .unwrap();
        pool.allocate_contiguous(&mut memory, 1).unwrap();
        assert_eq!(
            storage.write_memory(0, b"stale", &mut memory),
            Err(Errno::EIO)
        );
        assert_eq!(
            storage.retire_memory(&mut pool, &mut memory, |_| Ok(true)),
            Err(Errno::ESRCH)
        );
    }
}
