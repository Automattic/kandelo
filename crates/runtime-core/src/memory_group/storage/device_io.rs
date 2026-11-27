//! Device I/O custody for grouped images.
//!
//! A device (first the GPU executor) reads and writes the group's shared
//! backing, never a process's address space. This storage owner is the only
//! authority that knows which backing frames a grouped image's virtual range
//! names and when those frames may be returned to the allocator, so it both
//! translates guest ranges into backing extents and holds the pins that keep
//! those frames from being reclaimed or reused until the device retires the
//! work. Pins live in kernel records, never in group pages, so a guest cannot
//! forge or drop one. Names stay device-neutral so a later generic driver
//! model can reuse them.
use super::*;
use alloc::vec::Vec;
use wasm_posix_shared::kgpu::Extent as DeviceExtent;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DevicePinId(u64);

/// One guest range a device request names, with the access the device needs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DeviceRange {
    pub addr: u64,
    pub len: u32,
    pub write: bool,
}

/// One device's hold on a set of frames. Unlike a native pin, which keeps a
/// single observed word alive, a device pin covers every frame of a request.
pub(super) struct DevicePin {
    pub(super) image: ImageKey,
    /// Sorted and unique, so release checks can binary-search them.
    pub(super) frames: IoBuffer<u32>,
}

impl MapMemory for DevicePin {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}

impl Storage {
    /// Translate `len` bytes at guest `addr` into backing extents, merging
    /// physically adjacent frames. Each PTE is read once with the same rights
    /// checks as `execution_word_address`; the caller pins the result before
    /// any mapping change can be published, so the extents stay exact.
    pub(in crate::memory_group) fn device_extents(
        &self,
        memory: &impl PhysicalMemory,
        image: ImageKey,
        addr: u64,
        len: u32,
        write: bool,
    ) -> Result<Vec<DeviceExtent>, Errno> {
        let record = self.images.get(&image).ok_or(Errno::ESRCH)?;
        if self.poisoned || self.pool.as_ref().is_some_and(PagePool::is_poisoned) {
            return Err(Errno::EIO);
        }
        if len == 0 {
            return Ok(Vec::new());
        }
        if !record.source_live || record.stopping {
            return Err(Errno::EFAULT);
        }
        let end = addr.checked_add(u64::from(len)).ok_or(Errno::EFAULT)?;
        let table = record.allocation.ok_or(Errno::EIO)?.controls.address();
        let extent = memory.atomic_load(table)?;
        if extent > record.layout.maximum_pages || end > u64::from(extent) * u64::from(PAGE) {
            return Err(Errno::EFAULT);
        }
        let rights = if write { 3 } else { 1 };
        let current = memory.current_pages()?;
        let mut extents: Vec<DeviceExtent> = Vec::new();
        let mut cursor = addr;
        while cursor < end {
            // `end` is within the image extent, so the page index fits u32.
            let page = (cursor / u64::from(PAGE)) as u32;
            let within = (cursor % u64::from(PAGE)) as u32;
            let span = u64::from(PAGE - within).min(end - cursor) as u32;
            let pte = memory.atomic_load(table + layout::ROOT_HEADER_BYTES + page * 4)?;
            let frame = pte >> 16;
            if pte & 0xfffc != 0
                || pte & rights != rights
                || frame == 0
                || frame >= current
                || frame >= self.maximum_pages
            {
                return Err(Errno::EFAULT);
            }
            let offset = u64::from(pte & 0xffff_0000) + u64::from(within);
            match extents.last_mut() {
                // The merged total never exceeds `len`, so it fits u32.
                Some(last) if last.offset + u64::from(last.len) == offset => last.len += span,
                _ => {
                    extents.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
                    extents.push(DeviceExtent {
                        offset,
                        len: span,
                        pad: 0,
                    });
                }
            }
            cursor += u64::from(span);
        }
        Ok(extents)
    }

    /// Hold every frame the extents touch until `device_unpin`. Extents come
    /// from `device_extents`, but are rechecked here: a pin outside the
    /// backing or on the allocator's own frame 0 would protect nothing real.
    pub(in crate::memory_group) fn device_pin(
        &mut self,
        image: ImageKey,
        extents: &[DeviceExtent],
    ) -> Result<DevicePinId, Errno> {
        if !self.images.contains_key(&image) {
            return Err(Errno::ESRCH);
        }
        let page = u64::from(PAGE);
        let limit = u64::from(self.maximum_pages) * page;
        let mut count = 0usize;
        for extent in extents {
            let end = extent
                .offset
                .checked_add(u64::from(extent.len))
                .ok_or(Errno::EINVAL)?;
            if extent.pad != 0 || extent.len == 0 || extent.offset < page || end > limit {
                return Err(Errno::EINVAL);
            }
            count = count
                .checked_add(((end - 1) / page - extent.offset / page + 1) as usize)
                .ok_or(Errno::EINVAL)?;
        }
        let mut frames = IoBuffer::try_with_capacity(count)?;
        for extent in extents {
            let end = extent.offset + u64::from(extent.len);
            for frame in extent.offset / page..=(end - 1) / page {
                frames.push(frame as u32);
            }
        }
        frames.sort_unstable();
        let mut previous = None;
        frames.retain(|frame| previous.replace(*frame) != Some(*frame));
        let token = self.next_device_pin;
        let next = token.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let entry =
            PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(token, DevicePin { image, frames })?;
        self.device_pins.publish_io(entry);
        self.next_device_pin = next;
        Ok(DevicePinId(token))
    }

    /// Translate every range of one device request and pin all their frames,
    /// for the image `admission` executes.
    ///
    /// WHY one method: `device_pin` trusts that its extents still name the
    /// frames translation read. Translating and pinning inside one call, with
    /// no release of the storage borrow between them, is what makes that
    /// true: no mapping change can be published in between. A request that
    /// names no bytes at all is refused rather than given an empty pin, and
    /// poisoned storage refuses before reading any PTE.
    ///
    /// `admit` sees the translation before anything is pinned; its error
    /// ends the call with nothing held. A driver uses it to refuse work it
    /// has no room to queue, so a refusal never strands a pin.
    pub(in crate::memory_group) fn device_translate_and_pin(
        &mut self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        ranges: &[DeviceRange],
        admit: impl FnOnce(&[Vec<DeviceExtent>]) -> Result<(), Errno>,
    ) -> Result<(Vec<Vec<DeviceExtent>>, DevicePinId), Errno> {
        let image = self.owned(admission)?.image;
        let mut translated = Vec::new();
        translated.try_reserve(ranges.len()).map_err(|_| Errno::ENOMEM)?;
        let mut total = 0usize;
        for range in ranges {
            let extents = self.device_extents(memory, image, range.addr, range.len, range.write)?;
            total += extents.len();
            translated.push(extents);
        }
        if total == 0 {
            return Err(Errno::EINVAL);
        }
        admit(&translated)?;
        let mut all = Vec::new();
        all.try_reserve(total).map_err(|_| Errno::ENOMEM)?;
        for extents in &translated {
            all.extend_from_slice(extents);
        }
        let pin = self.device_pin(image, &all)?;
        Ok((translated, pin))
    }

    /// Copy `out.len()` bytes at guest `addr` of the image `admission`
    /// executes into kernel memory, through the same translation a device
    /// request uses. The kernel reads request metadata (a stream header, a
    /// buffer table) this way exactly once, so a guest that rewrites it later
    /// cannot change what the kernel validated.
    pub(in crate::memory_group) fn device_read(
        &self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        addr: u64,
        out: &mut [u8],
    ) -> Result<(), Errno> {
        let image = self.owned(admission)?.image;
        let len = u32::try_from(out.len()).map_err(|_| Errno::EFAULT)?;
        let mut at = 0usize;
        for extent in self.device_extents(memory, image, addr, len, false)? {
            // Extents lie inside the backing, whose size fits u32.
            let offset = u32::try_from(extent.offset).map_err(|_| Errno::EFAULT)?;
            let end = at + extent.len as usize;
            memory.read(offset, &mut out[at..end])?;
            at = end;
        }
        Ok(())
    }

    /// Only the device's retirement of the work ends a pin. An id that was
    /// already released (or never issued) has nothing left to release.
    pub(in crate::memory_group) fn device_unpin(&mut self, pin: DevicePinId) {
        self.device_pins.remove(&pin.0);
    }

    /// Distinct frames held by any device pin.
    pub(in crate::memory_group) fn device_pinned_frames(&self) -> usize {
        let mut seen = [false; layout::MAXIMUM_PAGES as usize];
        let mut count = 0;
        for frame in self.device_pins.values().flat_map(|pin| pin.frames.iter()) {
            if !core::mem::replace(&mut seen[*frame as usize], true) {
                count += 1;
            }
        }
        count
    }

    /// Whether any device pin holds `frame`. Every path that returns frames
    /// to the allocator refuses one held here, as it does a native pin.
    pub(super) fn device_pinned(&self, frame: u32) -> bool {
        self.device_pins
            .values()
            .any(|pin| pin.frames.binary_search(&frame).is_ok())
    }
}
