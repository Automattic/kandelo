//! Physical-memory operations for kernel-owned groups.
//!
//! A host supplies foreign-memory byte and atomic operations. Page selection,
//! capacity checks, allocation publication and rollback belong to the kernel.
//! The bitmap is the kernel allocation record, never a mirrored host allocator.

use wasm_posix_shared::{program_extensions::memory_group_v3 as layout, Errno};

const PAGE: u32 = layout::PAGE_BYTES;
const LOCK: u32 = layout::CONTROL;
const HIGH_WATER: u32 = layout::CONTROL + 4;
const MAXIMUM: u32 = layout::CONTROL + 8;
const MAGIC: u32 = layout::CONTROL + 12;

/// Mechanical access to one already identified backing. Implementations must
/// refresh their views after growth and must not choose pages or retain a
/// kernel buffer after the synchronous call returns.
pub trait PhysicalMemory {
    fn current_pages(&self) -> Result<u32, Errno>;
    /// The primitive WebAssembly operation: return the previous page count.
    fn grow(&mut self, additional_pages: u32) -> Result<u32, Errno>;
    fn read(&self, address: u32, output: &mut [u8]) -> Result<(), Errno>;
    fn write(&mut self, address: u32, input: &[u8]) -> Result<(), Errno>;
    fn fill(&mut self, address: u32, length: u32, byte: u8) -> Result<(), Errno>;
    fn copy(&mut self, destination: u32, source: u32, length: u32) -> Result<(), Errno>;
    fn atomic_load(&self, address: u32) -> Result<u32, Errno>;
    fn next_nonzero(&self, address: u32, words: u32) -> Result<u64, Errno> {
        if address < PAGE || address % 4 != 0 || words > 65536
            || u64::from(address) + u64::from(words) * 4 > u64::from(self.current_pages()?) * u64::from(PAGE) {
            return Err(Errno::EINVAL);
        }
        for index in 0..words {
            let value = self.atomic_load(address + index * 4)?;
            if value != 0 { return Ok((u64::from(index + 1) << 32) | u64::from(value)); }
        }
        Ok(0)
    }
    fn atomic_store(&mut self, address: u32, value: u32) -> Result<(), Errno>;
    fn atomic_compare_exchange(
        &mut self,
        address: u32,
        expected: u32,
        value: u32,
    ) -> Result<u32, Errno>;
    fn atomic_notify(&mut self, address: u32, count: u32) -> Result<u32, Errno>;
}

/// Clear adjacent selected frames with one foreign-memory call. The input
/// is the pool's increasing selection, so runs never cross an occupied page.
fn zero_selected_pages(
    memory: &mut impl PhysicalMemory,
    pages: impl Iterator<Item = u32>,
) -> Result<(), Errno> {
    let mut pages = pages.peekable();
    while let Some(first) = pages.next() {
        let mut end = first + 1;
        while pages.next_if_eq(&end).is_some() {
            end += 1;
        }
        memory.fill(first * PAGE, (end - first) * PAGE, 0)?;
    }
    Ok(())
}

/// The adapter is bound to the kernel-issued resource, never a host-selected
/// image or an object-id lookup. All page ownership stays in the caller.
pub(crate) struct HostMemory<'a> {
    pub resource: u64,
    pub host: &'a mut dyn crate::process::HostIO,
}

impl PhysicalMemory for HostMemory<'_> {
    fn current_pages(&self) -> Result<u32, Errno> {
        self.host.group_memory_pages(self.resource)
    }
    fn grow(&mut self, additional: u32) -> Result<u32, Errno> {
        self.host.group_memory_grow(self.resource, additional)
    }
    fn read(&self, address: u32, output: &mut [u8]) -> Result<(), Errno> {
        self.host.group_memory_read(self.resource, address, output)
    }
    fn write(&mut self, address: u32, input: &[u8]) -> Result<(), Errno> {
        self.host.group_memory_write(self.resource, address, input)
    }
    fn fill(&mut self, address: u32, length: u32, byte: u8) -> Result<(), Errno> {
        self.host
            .group_memory_fill(self.resource, address, length, byte)
    }
    fn copy(&mut self, destination: u32, source: u32, length: u32) -> Result<(), Errno> {
        self.host
            .group_memory_copy(self.resource, destination, source, length)
    }
    fn atomic_load(&self, address: u32) -> Result<u32, Errno> {
        self.host.group_memory_atomic_load(self.resource, address)
    }
    fn next_nonzero(&self, address: u32, words: u32) -> Result<u64, Errno> {
        self.host.group_memory_next_nonzero(self.resource, address, words)
    }
    fn atomic_store(&mut self, address: u32, value: u32) -> Result<(), Errno> {
        self.host
            .group_memory_atomic_store(self.resource, address, value)
    }
    fn atomic_compare_exchange(
        &mut self,
        address: u32,
        expected: u32,
        value: u32,
    ) -> Result<u32, Errno> {
        self.host
            .group_memory_atomic_compare_exchange(self.resource, address, expected, value)
    }
    fn atomic_notify(&mut self, address: u32, count: u32) -> Result<u32, Errno> {
        self.host
            .group_memory_atomic_notify(self.resource, address, count)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Extent {
    pub first: u32,
    pub pages: u32,
}

impl Extent {
    pub fn address(self) -> u32 {
        self.first * PAGE
    }
    fn end(self) -> u32 {
        self.first + self.pages
    }
    fn contains(self, page: u32) -> bool {
        page >= self.first && page < self.end()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ImageAllocation {
    pub controls: Extent,
    pub scratch: Extent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Snapshot {
    pub maximum_pages: u32,
    pub allocated_pages: u32,
    pub high_water_pages: u32,
    pub physical_extent_pages: u32,
}

type Bitmap = [u8; layout::BITMAP_BYTES as usize];

/// Private to the kernel memory-group implementation. In particular, the host
/// cannot select an arbitrary retirement set through this primitive.
pub(crate) struct PagePool {
    maximum_pages: u32,
    poisoned: bool,
}

impl PagePool {
    pub(crate) fn is_poisoned(&self) -> bool {
        self.poisoned
    }
    pub fn initialize(memory: &mut impl PhysicalMemory, maximum_pages: u32) -> Result<Self, Errno> {
        let pool = Self {
            maximum_pages,
            poisoned: false,
        };
        if !(2..=layout::MAXIMUM_PAGES).contains(&maximum_pages) {
            return Err(Errno::EINVAL);
        }
        let extent = memory.current_pages()?;
        if extent == 0 || extent > maximum_pages {
            return Err(Errno::EINVAL);
        }
        // Never reset an existing allocator, including a partially live queue.
        let mut fresh = [0u8; PAGE as usize];
        memory.read(0, &mut fresh)?;
        if fresh.iter().any(|byte| *byte != 0) {
            return Err(Errno::EINVAL);
        }
        memory.write(HIGH_WATER, &1u32.to_le_bytes())?;
        memory.write(MAXIMUM, &maximum_pages.to_le_bytes())?;
        memory.write(layout::BITMAP, &1u32.to_le_bytes())?;
        memory.atomic_store(MAGIC, layout::MAGIC)?;
        Ok(pool)
    }

    fn validate(&self, memory: &impl PhysicalMemory) -> Result<(), Errno> {
        if self.poisoned
            || memory.atomic_load(MAGIC)? != layout::MAGIC
            || word(memory, MAXIMUM)? != self.maximum_pages
            || !(1..=self.maximum_pages).contains(&word(memory, HIGH_WATER)?)
            || word(memory, layout::BITMAP)? & 1 == 0
        {
            return Err(Errno::EIO);
        }
        Ok(())
    }

    fn locked<M: PhysicalMemory, T>(
        &mut self,
        memory: &mut M,
        operation: impl FnOnce(&mut Self, &mut M, &mut Bitmap) -> Result<T, Errno>,
    ) -> Result<T, Errno> {
        self.validate(memory)?;
        if memory.atomic_compare_exchange(LOCK, 0, 1)? != 0 {
            return Err(Errno::EAGAIN);
        }
        let result = (|| {
            self.validate(memory)?;
            let mut bitmap = [0; layout::BITMAP_BYTES as usize];
            memory.read(layout::BITMAP, &mut bitmap)?;
            operation(self, memory, &mut bitmap)
        })();
        let released = memory
            .atomic_store(LOCK, 0)
            .and_then(|()| memory.atomic_notify(LOCK, 1).map(|_| ()));
        if released.is_err() || result.as_ref().is_err_and(|error| *error == Errno::EIO) {
            // An uncertain foreign-memory write/unlock is containment, never
            // an allocation refusal after which these pages may be reused.
            self.poisoned = true;
        }
        released?;
        result
    }

    fn ensure_extent(&self, memory: &mut impl PhysicalMemory, end: u32) -> Result<(), Errno> {
        if end > self.maximum_pages {
            return Err(Errno::ENOMEM);
        }
        let current = memory.current_pages()?;
        if end > current && memory.grow(end - current)? != current {
            return Err(Errno::EIO);
        }
        Ok(())
    }

    fn publish(
        &mut self,
        memory: &mut impl PhysicalMemory,
        bitmap: &Bitmap,
        end: u32,
    ) -> Result<(), Errno> {
        // All fallible preparation/zeroing precedes bitmap publication. Any
        // unexpected publication failure poisons this owner rather than
        // treating an uncertain allocation as unpublished rollback.
        self.poisoned = true;
        memory.write(layout::BITMAP, bitmap)?;
        let high_water = word(memory, HIGH_WATER)?.max(end);
        memory.write(HIGH_WATER, &high_water.to_le_bytes())?;
        self.poisoned = false;
        Ok(())
    }

    pub fn allocate_contiguous(
        &mut self,
        memory: &mut impl PhysicalMemory,
        pages: u32,
    ) -> Result<Extent, Errno> {
        if pages == 0 {
            return Err(Errno::EINVAL);
        }
        if pages >= self.maximum_pages {
            return Err(Errno::ENOMEM);
        }
        self.locked(memory, |pool, memory, bitmap| {
            let first = find_run(bitmap, pool.maximum_pages, pages, None).ok_or(Errno::ENOMEM)?;
            let extent = Extent { first, pages };
            pool.ensure_extent(memory, extent.end())?;
            memory.fill(extent.address(), pages * PAGE, 0)?;
            for page in first..extent.end() {
                set_used(bitmap, page, true);
            }
            pool.publish(memory, bitmap, extent.end())?;
            Ok(extent)
        })
    }

    /// Virtual payload pages can occupy fragmented physical holes. Busy and
    /// exhausted outcomes preserve both the caller's output and allocation bits.
    pub fn allocate_pages(
        &mut self,
        memory: &mut impl PhysicalMemory,
        output: &mut [u32],
    ) -> Result<(), Errno> {
        if output.is_empty() {
            return Err(Errno::EINVAL);
        }
        if output.len() >= self.maximum_pages as usize {
            return Err(Errno::ENOMEM);
        }
        self.locked(memory, |pool, memory, bitmap| {
            let last =
                select_last(bitmap, pool.maximum_pages, output.len(), &[]).ok_or(Errno::ENOMEM)?;
            pool.ensure_extent(memory, last + 1)?;
            zero_selected_pages(memory, (1..=last).filter(|page| !used(bitmap, *page)))?;
            for (at, page) in (1..=last).filter(|page| !used(bitmap, *page)).enumerate() {
                output[at] = page;
            }
            for page in output.iter().copied() {
                set_used(bitmap, page, true);
            }
            pool.publish(memory, bitmap, last + 1)
        })
    }

    pub fn allocate_image(
        &mut self,
        memory: &mut impl PhysicalMemory,
        controls_pages: u32,
        scratch_pages: u32,
        payload: &mut [u32],
    ) -> Result<ImageAllocation, Errno> {
        if controls_pages == 0 || scratch_pages == 0 {
            return Err(Errno::EINVAL);
        }
        let total = u64::from(controls_pages) + u64::from(scratch_pages) + payload.len() as u64;
        if total >= u64::from(self.maximum_pages) {
            return Err(Errno::ENOMEM);
        }
        self.locked(memory, |pool, memory, bitmap| {
            let controls_first = controls_pages >= scratch_pages;
            let (first_count, second_count) = if controls_first {
                (controls_pages, scratch_pages)
            } else {
                (scratch_pages, controls_pages)
            };
            let first = Extent {
                first: find_run(bitmap, pool.maximum_pages, first_count, None)
                    .ok_or(Errno::ENOMEM)?,
                pages: first_count,
            };
            let second = Extent {
                first: find_run(bitmap, pool.maximum_pages, second_count, Some(first))
                    .ok_or(Errno::ENOMEM)?,
                pages: second_count,
            };
            let result = if controls_first {
                ImageAllocation {
                    controls: first,
                    scratch: second,
                }
            } else {
                ImageAllocation {
                    controls: second,
                    scratch: first,
                }
            };
            let last_payload =
                select_last(bitmap, pool.maximum_pages, payload.len(), &[first, second])
                    .ok_or(Errno::ENOMEM)?;
            let end = first.end().max(second.end()).max(last_payload + 1);
            pool.ensure_extent(memory, end)?;
            memory.fill(first.address(), first.pages * PAGE, 0)?;
            memory.fill(second.address(), second.pages * PAGE, 0)?;
            let selected = |page: &u32| {
                !used(bitmap, *page) && !first.contains(*page) && !second.contains(*page)
            };
            zero_selected_pages(memory, (1..=last_payload).filter(selected))?;
            for (at, page) in (1..=last_payload).filter(selected).enumerate() {
                payload[at] = page;
            }
            for page in first.first..first.end() {
                set_used(bitmap, page, true);
            }
            for page in second.first..second.end() {
                set_used(bitmap, page, true);
            }
            for page in payload.iter().copied() {
                set_used(bitmap, page, true);
            }
            pool.publish(memory, bitmap, end)?;
            Ok(result)
        })
    }

    /// The storage owner supplies its exact ordered custody and final fence
    /// check. No ownership bit changes before every input and fence is valid.
    pub fn release_checked(
        &mut self,
        memory: &mut impl PhysicalMemory,
        pages: &[u32],
        validate: impl FnOnce(&mut dyn PhysicalMemory) -> Result<bool, Errno>,
    ) -> Result<(), Errno> {
        if pages.iter().enumerate().any(|(at, page)| {
            *page == 0 || *page >= self.maximum_pages || (at > 0 && *page <= pages[at - 1])
        }) {
            return Err(Errno::EINVAL);
        }
        self.locked(memory, |pool, memory, bitmap| {
            if pages.iter().any(|page| !used(bitmap, *page)) {
                return Err(Errno::EINVAL);
            }
            if !validate(memory)? {
                return Err(Errno::EAGAIN);
            }
            for page in pages {
                set_used(bitmap, *page, false);
            }
            let end = word(memory, HIGH_WATER)?;
            pool.publish(memory, bitmap, end)
        })
    }

    pub fn snapshot(&mut self, memory: &mut impl PhysicalMemory) -> Result<Snapshot, Errno> {
        self.locked(memory, |pool, memory, bitmap| {
            Ok(Snapshot {
                maximum_pages: pool.maximum_pages,
                allocated_pages: (0..pool.maximum_pages)
                    .filter(|page| used(bitmap, *page))
                    .count() as u32,
                high_water_pages: word(memory, HIGH_WATER)?,
                physical_extent_pages: memory.current_pages()?,
            })
        })
    }
}

fn word(memory: &impl PhysicalMemory, address: u32) -> Result<u32, Errno> {
    let mut bytes = [0; 4];
    memory.read(address, &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}
fn used(bitmap: &Bitmap, page: u32) -> bool {
    bitmap[(page / 8) as usize] & (1 << (page % 8)) != 0
}
fn set_used(bitmap: &mut Bitmap, page: u32, value: bool) {
    let byte = &mut bitmap[(page / 8) as usize];
    let mask = 1 << (page % 8);
    if value {
        *byte |= mask;
    } else {
        *byte &= !mask;
    }
}
fn find_run(bitmap: &Bitmap, maximum: u32, count: u32, exclude: Option<Extent>) -> Option<u32> {
    let mut run = 0;
    for page in 1..maximum {
        if used(bitmap, page) || exclude.is_some_and(|extent| extent.contains(page)) {
            run = 0;
        } else {
            run += 1;
            if run == count {
                return Some(page + 1 - count);
            }
        }
    }
    None
}
fn select_last(bitmap: &Bitmap, maximum: u32, count: usize, exclude: &[Extent]) -> Option<u32> {
    if count == 0 {
        return Some(0);
    }
    let mut found = 0;
    for page in 1..maximum {
        if !used(bitmap, page) && !exclude.iter().any(|extent| extent.contains(page)) {
            found += 1;
            if found == count {
                return Some(page);
            }
        }
    }
    None
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use alloc::{vec, vec::Vec};

    pub(in crate::memory_group) struct Memory {
        pub(in crate::memory_group) fill_calls: Vec<(u32, u32)>,
        pub(in crate::memory_group) copy_calls: Vec<(u32, u32, u32)>,
        bytes: Vec<u8>,
        maximum: u32,
        pub(in crate::memory_group) refuse_growth: bool,
        fail_bitmap_write: bool,
        pub(in crate::memory_group) fail_write_after_at: Option<u32>,
        fail_atomic_store_at: Option<u32>,
        pub(in crate::memory_group) next_reported_pages: core::cell::Cell<Option<u32>>,
        watched_load: Option<u32>,
        watched_loads: core::cell::Cell<usize>,
        fail_read_at: Option<u32>,
    }
    impl Memory {
        pub(in crate::memory_group) fn fail_read_at(&mut self, address: Option<u32>) {
            self.fail_read_at = address;
        }
        pub(in crate::memory_group) fn watch_loads(&mut self, address: u32) {
            self.watched_load = Some(address);
            self.watched_loads.set(0);
        }
        pub(in crate::memory_group) fn watched_loads(&self) -> usize {
            self.watched_loads.get()
        }
        pub(in crate::memory_group) fn fail_bitmap_writes(&mut self, fail: bool) {
            self.fail_bitmap_write = fail;
        }
        pub(in crate::memory_group) fn fail_atomic_store_at(&mut self, address: Option<u32>) {
            self.fail_atomic_store_at = address;
        }
        pub(in crate::memory_group) fn new(maximum: u32) -> Self {
            Self {
                bytes: vec![0; PAGE as usize],
                fill_calls: Vec::new(),
                copy_calls: Vec::new(),
                maximum,
                refuse_growth: false,
                fail_bitmap_write: false,
                fail_write_after_at: None,
                fail_atomic_store_at: None,
                next_reported_pages: core::cell::Cell::new(None),
                watched_load: None,
                watched_loads: core::cell::Cell::new(0),
                fail_read_at: None,
            }
        }
        fn store(&mut self, address: u32, value: u32) {
            self.write(address, &value.to_le_bytes()).unwrap();
        }
    }
    impl PhysicalMemory for Memory {
        fn current_pages(&self) -> Result<u32, Errno> {
            Ok(self.next_reported_pages.take().unwrap_or(self.bytes.len() as u32 / PAGE))
        }
        fn grow(&mut self, extra: u32) -> Result<u32, Errno> {
            let old = self.current_pages()?;
            if self.refuse_growth || extra > self.maximum - old {
                return Err(Errno::ENOMEM);
            }
            self.bytes.resize(((old + extra) * PAGE) as usize, 0);
            Ok(old)
        }
        fn read(&self, address: u32, output: &mut [u8]) -> Result<(), Errno> {
            if self.fail_read_at == Some(address) {
                return Err(Errno::EIO);
            }
            output.copy_from_slice(
                self.bytes
                    .get(address as usize..address as usize + output.len())
                    .ok_or(Errno::EFAULT)?,
            );
            Ok(())
        }
        fn write(&mut self, address: u32, input: &[u8]) -> Result<(), Errno> {
            if self.fail_bitmap_write && address == layout::BITMAP {
                return Err(Errno::EIO);
            }
            self.bytes
                .get_mut(address as usize..address as usize + input.len())
                .ok_or(Errno::EFAULT)?
                .copy_from_slice(input);
            if self.fail_write_after_at == Some(address) {
                return Err(Errno::EIO);
            }
            Ok(())
        }
        fn fill(&mut self, address: u32, length: u32, value: u8) -> Result<(), Errno> {
            self.fill_calls.push((address, length));
            self.bytes
                .get_mut(address as usize..address as usize + length as usize)
                .ok_or(Errno::EFAULT)?
                .fill(value);
            Ok(())
        }
        fn copy(&mut self, destination: u32, source: u32, length: u32) -> Result<(), Errno> {
            self.copy_calls.push((destination, source, length));
            self.bytes.copy_within(
                source as usize..(source + length) as usize,
                destination as usize,
            );
            Ok(())
        }
        fn atomic_load(&self, address: u32) -> Result<u32, Errno> {
            if self.watched_load == Some(address) {
                self.watched_loads.set(self.watched_loads.get() + 1);
            }
            word(self, address)
        }
        fn atomic_store(&mut self, address: u32, value: u32) -> Result<(), Errno> {
            self.write(address, &value.to_le_bytes())?;
            // A foreign operation can fail after its write became visible.
            if self.fail_atomic_store_at == Some(address) {
                return Err(Errno::EIO);
            }
            Ok(())
        }
        fn atomic_compare_exchange(
            &mut self,
            address: u32,
            expected: u32,
            value: u32,
        ) -> Result<u32, Errno> {
            let old = word(self, address)?;
            if old == expected {
                self.store(address, value);
            }
            Ok(old)
        }
        fn atomic_notify(&mut self, _: u32, _: u32) -> Result<u32, Errno> {
            Ok(0)
        }
    }

    #[test]
    fn clearing_selected_runs_does_not_touch_a_live_page() {
        let mut memory = Memory::new(8);
        memory.grow(6).unwrap();
        memory.fill(PAGE, 6 * PAGE, 0x7b).unwrap();
        memory.fill_calls.clear();
        zero_selected_pages(&mut memory, [1, 2, 4, 5, 6].into_iter()).unwrap();
        assert_eq!(memory.fill_calls, [(PAGE, 2 * PAGE), (4 * PAGE, 3 * PAGE)]);
        let mut byte = [0];
        for (page, expected) in [(1, 0), (2, 0), (3, 0x7b), (4, 0), (5, 0), (6, 0)] {
            memory.read(page * PAGE, &mut byte).unwrap();
            assert_eq!(byte, [expected]);
        }
    }

    #[test]
    fn allocation_reserves_metadata_and_reuses_zeroed_retired_pages() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        let first = pool.allocate_contiguous(&mut memory, 2).unwrap();
        assert_eq!(first, Extent { first: 1, pages: 2 });
        memory.fill(first.address(), 2 * PAGE, 0xa5).unwrap();
        pool.release_checked(&mut memory, &[1, 2], |_| Ok(true))
            .unwrap();
        assert_eq!(pool.allocate_contiguous(&mut memory, 2).unwrap(), first);
        assert!(memory.bytes[PAGE as usize..3 * PAGE as usize]
            .iter()
            .all(|byte| *byte == 0));
        assert_eq!(
            pool.snapshot(&mut memory).unwrap(),
            Snapshot {
                maximum_pages: 16,
                allocated_pages: 3,
                high_water_pages: 3,
                physical_extent_pages: 3,
            }
        );
    }

    #[test]
    fn busy_operations_preserve_custody_and_do_not_block_the_kernel() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        memory.store(LOCK, 1);
        let before = memory.bytes.clone();
        let mut output = [99, 98];
        assert_eq!(
            pool.allocate_pages(&mut memory, &mut output),
            Err(Errno::EAGAIN)
        );
        assert_eq!(pool.snapshot(&mut memory), Err(Errno::EAGAIN));
        assert_eq!(output, [99, 98]);
        assert_eq!(memory.bytes, before);
        memory.store(LOCK, 0);
        pool.allocate_pages(&mut memory, &mut output).unwrap();
        assert_eq!(output, [1, 2]);
        memory.store(LOCK, 1);
        let before = memory.bytes.clone();
        assert_eq!(
            pool.release_checked(&mut memory, &output, |_| Ok(true)),
            Err(Errno::EAGAIN)
        );
        assert_eq!(memory.bytes, before);
        memory.store(LOCK, 0);
        pool.release_checked(&mut memory, &output, |_| Ok(true))
            .unwrap();
        assert_eq!(pool.snapshot(&mut memory).unwrap().allocated_pages, 1);
    }

    #[test]
    fn fragmented_reuse_zeroes_selected_pages_without_touching_live_neighbors() {
        let mut memory = Memory::new(8);
        let mut pool = PagePool::initialize(&mut memory, 8).unwrap();
        pool.allocate_contiguous(&mut memory, 7).unwrap();
        memory.fill(PAGE, 7 * PAGE, 0xa5).unwrap();
        pool.release_checked(&mut memory, &[1, 3, 5], |_| Ok(true))
            .unwrap();
        let mut selected = [99; 3];
        pool.allocate_pages(&mut memory, &mut selected).unwrap();
        assert_eq!(selected, [1, 3, 5]);
        for page in 1..8 {
            let expected = if selected.contains(&page) { 0 } else { 0xa5 };
            let mut bytes = [0; PAGE as usize];
            memory.read(page * PAGE, &mut bytes).unwrap();
            assert!(bytes.iter().all(|byte| *byte == expected));
        }
        let before = memory.bytes.clone();
        let mut output = [99];
        assert_eq!(
            pool.allocate_pages(&mut memory, &mut output),
            Err(Errno::ENOMEM)
        );
        assert_eq!(output, [99]);
        assert_eq!(memory.bytes, before);
    }

    #[test]
    fn scattered_growth_stops_at_the_last_selected_page_and_preserves_refused_output() {
        let mut memory = Memory::new(8);
        let mut pool = PagePool::initialize(&mut memory, 8).unwrap();
        let mut selected = [99; 4];
        pool.allocate_pages(&mut memory, &mut selected).unwrap();
        assert_eq!(selected, [1, 2, 3, 4]);
        assert_eq!(memory.current_pages().unwrap(), 5);
        memory.refuse_growth = true;
        let before = memory.bytes.clone();
        let mut output = [99; 2];
        assert_eq!(
            pool.allocate_pages(&mut memory, &mut output),
            Err(Errno::ENOMEM)
        );
        assert_eq!(pool.allocate_contiguous(&mut memory, 2), Err(Errno::ENOMEM));
        assert_eq!(output, [99; 2]);
        assert_eq!(memory.bytes, before);
    }

    #[test]
    fn independent_pools_reserve_their_own_metadata_and_allow_empty_image_payloads() {
        let mut a = Memory::new(16);
        let mut b = Memory::new(16);
        let mut first = PagePool::initialize(&mut a, 16).unwrap();
        let mut second = PagePool::initialize(&mut b, 16).unwrap();
        let image = first.allocate_image(&mut a, 3, 2, &mut []).unwrap();
        assert_eq!(image.controls, Extent { first: 1, pages: 3 });
        assert_eq!(image.scratch, Extent { first: 4, pages: 2 });
        a.fill(PAGE, 5 * PAGE, 0xff).unwrap();
        assert_eq!(second.snapshot(&mut b).unwrap().allocated_pages, 1);
        assert_eq!(second.allocate_contiguous(&mut b, 1).unwrap().first, 1);
        assert!(b.bytes[PAGE as usize..].iter().all(|byte| *byte == 0));
        assert_eq!(first.snapshot(&mut a).unwrap().allocated_pages, 6);
        assert_eq!(a.current_pages().unwrap(), 6);
    }

    #[test]
    fn invalid_capacities_and_extents_refuse_before_lock_or_metadata_mutation() {
        for maximum in [0, 1, layout::MAXIMUM_PAGES + 1, u32::MAX] {
            let mut memory = Memory::new(16);
            let before = memory.bytes.clone();
            assert!(matches!(
                PagePool::initialize(&mut memory, maximum),
                Err(Errno::EINVAL)
            ));
            assert_eq!(memory.bytes, before);
        }
        let mut memory = Memory::new(8);
        let mut pool = PagePool::initialize(&mut memory, 8).unwrap();
        memory.store(LOCK, 1);
        let before = memory.bytes.clone();
        assert_eq!(pool.allocate_contiguous(&mut memory, 0), Err(Errno::EINVAL));
        assert_eq!(
            pool.allocate_pages(&mut memory, &mut []),
            Err(Errno::EINVAL)
        );
        for (controls, scratch) in [(0, 2), (1, 0)] {
            assert_eq!(
                pool.allocate_image(&mut memory, controls, scratch, &mut []),
                Err(Errno::EINVAL)
            );
        }
        assert_eq!(
            pool.allocate_image(&mut memory, u32::MAX, 1, &mut []),
            Err(Errno::ENOMEM)
        );
        assert_eq!(memory.bytes, before);
        memory.store(LOCK, 0);
        memory.store(MAXIMUM, 7);
        let before = memory.bytes.clone();
        assert_eq!(pool.snapshot(&mut memory), Err(Errno::EIO));
        assert_eq!(memory.bytes, before);
    }

    #[test]
    fn image_allocation_uses_fragmented_payload_without_stealing_control_runs() {
        let mut memory = Memory::new(12);
        let mut pool = PagePool::initialize(&mut memory, 12).unwrap();
        pool.allocate_contiguous(&mut memory, 10).unwrap();
        pool.release_checked(&mut memory, &[1, 2, 4, 6, 7, 8, 10], |_| Ok(true))
            .unwrap();
        let mut payload = [0; 2];
        let image = pool
            .allocate_image(&mut memory, 2, 3, &mut payload)
            .unwrap();
        assert_eq!(image.controls, Extent { first: 1, pages: 2 });
        assert_eq!(image.scratch, Extent { first: 6, pages: 3 });
        assert_eq!(payload, [4, 10]);
    }

    #[test]
    fn growth_refusal_does_not_publish_any_part_of_an_image() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        memory.refuse_growth = true;
        let before = memory.bytes.clone();
        let mut payload = [91, 92];
        assert_eq!(
            pool.allocate_image(&mut memory, 1, 2, &mut payload),
            Err(Errno::ENOMEM)
        );
        assert_eq!(payload, [91, 92]);
        assert_eq!(memory.bytes, before);
        memory.refuse_growth = false;
        assert!(pool.allocate_image(&mut memory, 1, 2, &mut payload).is_ok());
    }

    #[test]
    fn retirement_checks_the_entire_set_and_exact_fence_before_mutation() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        pool.allocate_contiguous(&mut memory, 3).unwrap();
        let before = memory.bytes.clone();
        for invalid in [&[1, 1][..], &[2, 1], &[0, 1], &[1, 4]] {
            assert_eq!(
                pool.release_checked(&mut memory, invalid, |_| Ok(true)),
                Err(Errno::EINVAL)
            );
            assert_eq!(memory.bytes, before);
        }
        assert_eq!(
            pool.release_checked(&mut memory, &[1, 2], |_| Ok(false)),
            Err(Errno::EAGAIN)
        );
        assert_eq!(memory.bytes, before);
        pool.release_checked(&mut memory, &[1, 2], |_| Ok(true))
            .unwrap();
        assert_eq!(
            pool.release_checked(&mut memory, &[1, 2], |_| Ok(true)),
            Err(Errno::EINVAL)
        );
        assert_eq!(pool.snapshot(&mut memory).unwrap().allocated_pages, 2);
    }

    #[test]
    fn kernel_allocator_obeys_existing_shared_bitmap_ownership() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        memory.grow(3).unwrap();
        memory.store(layout::BITMAP, 0b1111);
        memory.store(HIGH_WATER, 4);
        assert_eq!(pool.allocate_contiguous(&mut memory, 2).unwrap().first, 4);
        assert_eq!(pool.snapshot(&mut memory).unwrap().allocated_pages, 6);
    }

    #[test]
    fn failed_publication_cannot_be_retried_as_free_storage() {
        let mut memory = Memory::new(16);
        let mut pool = PagePool::initialize(&mut memory, 16).unwrap();
        memory.fail_bitmap_write = true;
        assert_eq!(pool.allocate_contiguous(&mut memory, 2), Err(Errno::EIO));
        memory.fail_bitmap_write = false;
        assert_eq!(pool.allocate_contiguous(&mut memory, 1), Err(Errno::EIO));
    }

    #[test]
    fn initialization_never_resets_existing_or_corrupt_metadata() {
        let mut memory = Memory::new(16);
        let _pool = PagePool::initialize(&mut memory, 16).unwrap();
        let before = memory.bytes.clone();
        assert!(matches!(
            PagePool::initialize(&mut memory, 16),
            Err(Errno::EINVAL)
        ));
        assert_eq!(memory.bytes, before);
    }
}

/// Visit atomic observations in address order. This does not grant a coherent
/// snapshot: callers retain their existing locks, barriers and custody checks.
pub(crate) fn visit_nonzero(memory: &impl PhysicalMemory, address: u32, words: u32,
    mut visit: impl FnMut(u32, u32) -> Result<(), Errno>) -> Result<(), Errno> {
    if address < PAGE || address % 4 != 0 || words > 65536
        || u64::from(address) + u64::from(words) * 4 > u64::from(memory.current_pages()?) * u64::from(PAGE) {
        return Err(Errno::EINVAL);
    }
    let mut first = 0;
    while first < words {
        let packed = memory.next_nonzero(address + first * 4, words - first)?;
        if packed == 0 { break; }
        let step = (packed >> 32) as u32;
        let entry = packed as u32;
        if step == 0 || step > words - first || entry == 0 { return Err(Errno::EIO); }
        first += step;
        visit(first - 1, entry)?;
    }
    Ok(())
}
