use alloc::vec::{IntoIter, Vec};
use alloc::collections::VecDeque;
use core::ops::{Deref, DerefMut};
use wasm_posix_shared::Errno;
use crate::metadata_budget::{MetadataBudget, MetadataReservation};

pub(crate) const DEFAULT_IO_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const WRITEBACK_BYTES: usize = 2 * 1024 * 1024;
pub(crate) static IO_MEMORY: MetadataBudget = MetadataBudget::tracked(DEFAULT_IO_BYTES - WRITEBACK_BYTES, &crate::metadata_budget::FILESYSTEM_ADMISSION);
pub(crate) static WRITEBACK_MEMORY: MetadataBudget = MetadataBudget::tracked(WRITEBACK_BYTES, &crate::metadata_budget::FILESYSTEM_ADMISSION);

pub(crate) fn reserve_payload(bytes: usize, writeback: bool) -> Result<MetadataReservation<'static>, Errno> {
    let budget = if writeback { &WRITEBACK_MEMORY } else { &IO_MEMORY };
    budget.reserve(bytes.checked_mul(2).ok_or(Errno::ENOMEM)?)
}

pub struct IoBuffer<Value> {
    values: Vec<Value>,
    reservation: MetadataReservation<'static>,
}

impl<Value> Default for IoBuffer<Value> {
    fn default() -> Self { Self::new() }
}

impl<Value> crate::prepared_map::MapMemory for IoBuffer<Value> {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl<Value> IoBuffer<Value> {
    pub const fn new() -> Self {
        Self::new_in(&IO_MEMORY)
    }

    pub fn try_with_capacity(capacity: usize) -> Result<Self, Errno> {
        let mut buffer = Self::new();
        buffer.try_reserve_exact(capacity)?;
        Ok(buffer)
    }

    pub fn try_reserve_exact(&mut self, additional: usize) -> Result<(), Errno> {
        let capacity = self.values.len().checked_add(additional).ok_or(Errno::ENOMEM)?;
        self.reserve_with(capacity, |values| values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))
    }

    pub fn try_reserve(&mut self, additional: usize) -> Result<(), Errno> {
        let length = self.values.len().checked_add(additional).ok_or(Errno::ENOMEM)?;
        if length <= self.values.capacity() { return Ok(()); }
        let capacity = length.max(self.values.capacity().saturating_mul(2)).max(4);
        self.reserve_with(capacity, |values| values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))
            .or_else(|_| self.reserve_with(length, |values| values.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)))
    }

    #[cfg(test)]
    pub(crate) fn try_adopt(values: Vec<Value>) -> Result<Self, Errno> {
        let bytes = values.capacity().checked_mul(core::mem::size_of::<Value>()).ok_or(Errno::ENOMEM)?;
        Ok(Self { values, reservation: reserve_payload(bytes, false)? })
    }

    pub(crate) const fn new_in(budget: &'static MetadataBudget) -> Self {
        Self { values: Vec::new(), reservation: budget.empty() }
    }

    pub(crate) fn budget(&self) -> &'static MetadataBudget {
        self.reservation.budget()
    }

    pub(crate) fn allocate(
        capacity: usize,
        writeback: bool,
        allocate: impl FnOnce(&mut Vec<Value>) -> Result<(), Errno>,
    ) -> Result<Self, Errno> {
        let bytes = capacity.checked_mul(core::mem::size_of::<Value>()).ok_or(Errno::ENOMEM)?;
        let reservation = reserve_payload(bytes, writeback)?;
        let mut result = Self { values: Vec::new(), reservation };
        allocate(&mut result.values)?;
        if result.values.capacity() < capacity { return Err(Errno::EIO); }
        result.reconcile()?;
        Ok(result)
    }

    fn reconcile(&mut self) -> Result<(), Errno> {
        self.reservation.resize(self.values.capacity().checked_mul(core::mem::size_of::<Value>())
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)?)
    }

    pub(crate) fn reserve_with(
        &mut self,
        capacity: usize,
        allocate: impl FnOnce(&mut Vec<Value>) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if capacity <= self.values.capacity() { return Ok(()); }
        let bytes = capacity.checked_mul(core::mem::size_of::<Value>())
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)?;
        let mut replacement = self.reservation.budget().reserve(bytes)?;
        let mut values = Vec::new();
        allocate(&mut values)?;
        if !values.is_empty() || values.capacity() < capacity { return Err(Errno::EIO); }
        let actual = values.capacity().checked_mul(core::mem::size_of::<Value>())
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)?;
        replacement.resize(actual)?;
        values.append(&mut self.values);
        self.values = values;
        self.reservation = replacement;
        Ok(())
    }

    pub(crate) fn capacity(&self) -> usize { self.values.capacity() }
    pub fn as_slice(&self) -> &[Value] { &self.values }
    pub(crate) fn clear(&mut self) { self.values.clear(); }
    pub fn truncate(&mut self, length: usize) { self.values.truncate(length); }
    pub(crate) fn pop(&mut self) -> Option<Value> { self.values.pop() }
    pub(crate) fn remove(&mut self, index: usize) -> Value { self.values.remove(index) }
    pub(crate) fn swap_remove(&mut self, index: usize) -> Value { self.values.swap_remove(index) }
    pub(crate) fn retain(&mut self, keep: impl FnMut(&Value) -> bool) { self.values.retain(keep); }
    pub(crate) fn retain_mut(&mut self, keep: impl FnMut(&mut Value) -> bool) { self.values.retain_mut(keep); }

    pub fn push(&mut self, value: Value) {
        assert!(self.values.len() < self.values.capacity(), "I/O buffer publication lacks admitted capacity");
        self.values.push(value);
    }

    pub fn try_push(&mut self, value: Value) -> Result<(), Errno> {
        if self.values.len() == self.values.capacity() {
            let capacity = self.values.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?.max(4);
            self.reserve_with(capacity, |values| {
                values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
            })?;
        }
        self.push(value);
        Ok(())
    }

    pub(crate) fn insert(&mut self, index: usize, value: Value) {
        assert!(self.values.len() < self.values.capacity(), "I/O buffer insertion lacks admitted capacity");
        self.values.insert(index, value);
    }
}

impl<Value: Copy> IoBuffer<Value> {
    pub fn try_filled(length: usize, value: Value) -> Result<Self, Errno> {
        let mut buffer = Self::try_with_capacity(length)?;
        buffer.resize(length, value);
        Ok(buffer)
    }

    pub fn copy_from(values: &[Value]) -> Result<Self, Errno> {
        let mut buffer = Self::try_with_capacity(values.len())?;
        buffer.extend_from_slice(values);
        Ok(buffer)
    }

    pub(crate) fn resize(&mut self, length: usize, value: Value) {
        assert!(length <= self.values.capacity(), "I/O buffer resize lacks admitted capacity");
        self.values.resize(length, value);
    }

    pub fn extend_from_slice(&mut self, values: &[Value]) {
        assert!(values.len() <= self.values.capacity() - self.values.len(), "I/O buffer extension lacks admitted capacity");
        self.values.extend_from_slice(values);
    }
}

impl<Value> Deref for IoBuffer<Value> {
    type Target = [Value];
    fn deref(&self) -> &[Value] { &self.values }
}

impl<Value> DerefMut for IoBuffer<Value> {
    fn deref_mut(&mut self) -> &mut [Value] { &mut self.values }
}

impl<Value> AsRef<[Value]> for IoBuffer<Value> {
    fn as_ref(&self) -> &[Value] { &self.values }
}

impl<Value: core::fmt::Debug> core::fmt::Debug for IoBuffer<Value> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { self.values.fmt(formatter) }
}

impl<Value: PartialEq, Other: AsRef<[Value]> + ?Sized> PartialEq<Other> for IoBuffer<Value> {
    fn eq(&self, other: &Other) -> bool { self.values == other.as_ref() }
}

impl<Value: Eq> Eq for IoBuffer<Value> {}

impl core::fmt::Write for IoBuffer<u8> {
    fn write_str(&mut self, value: &str) -> core::fmt::Result {
        self.try_reserve(value.len()).map_err(|_| core::fmt::Error)?;
        self.extend_from_slice(value.as_bytes());
        Ok(())
    }
}

impl IoBuffer<u8> {
    pub(crate) fn try_write_fmt(&mut self, arguments: core::fmt::Arguments<'_>) -> Result<(), Errno> {
        core::fmt::write(self, arguments).map_err(|_| Errno::ENOMEM)
    }

    pub(crate) fn formatted(arguments: core::fmt::Arguments<'_>) -> Result<Self, Errno> {
        let mut output = Self::new();
        output.try_write_fmt(arguments)?;
        Ok(output)
    }
}

#[cfg(test)]
impl<Value: Clone> Clone for IoBuffer<Value> {
    fn clone(&self) -> Self {
        let mut cloned = Self::try_with_capacity(self.len()).unwrap();
        for value in self { cloned.push(value.clone()); }
        cloned
    }
}

pub struct IoIntoIter<Value> {
    values: IntoIter<Value>,
    _reservation: MetadataReservation<'static>,
}

impl<Value> Iterator for IoIntoIter<Value> {
    type Item = Value;
    fn next(&mut self) -> Option<Value> { self.values.next() }
    fn size_hint(&self) -> (usize, Option<usize>) { self.values.size_hint() }
}

impl<Value> ExactSizeIterator for IoIntoIter<Value> {}

impl<Value> DoubleEndedIterator for IoIntoIter<Value> {
    fn next_back(&mut self) -> Option<Value> { self.values.next_back() }
}

impl<Value> IntoIterator for IoBuffer<Value> {
    type Item = Value;
    type IntoIter = IoIntoIter<Value>;
    fn into_iter(self) -> Self::IntoIter {
        IoIntoIter { values: self.values.into_iter(), _reservation: self.reservation }
    }
}

impl<'a, Value> IntoIterator for &'a IoBuffer<Value> {
    type Item = &'a Value;
    type IntoIter = core::slice::Iter<'a, Value>;
    fn into_iter(self) -> Self::IntoIter { self.values.iter() }
}

impl<'a, Value> IntoIterator for &'a mut IoBuffer<Value> {
    type Item = &'a mut Value;
    type IntoIter = core::slice::IterMut<'a, Value>;
    fn into_iter(self) -> Self::IntoIter { self.values.iter_mut() }
}

pub struct IoDeque<Value> {
    values: VecDeque<Value>,
    reservation: MetadataReservation<'static>,
}

impl<Value> IoDeque<Value> {
    pub const fn new() -> Self {
        Self { values: VecDeque::new(), reservation: IO_MEMORY.empty() }
    }

    pub fn try_reserve(&mut self, additional: usize) -> Result<(), Errno> {
        let length = self.values.len().checked_add(additional).ok_or(Errno::ENOMEM)?;
        if length <= self.values.capacity() { return Ok(()); }
        let capacity = length.max(self.values.capacity().saturating_mul(2)).max(4);
        self.reserve_capacity(capacity).or_else(|_| self.reserve_capacity(length))
    }

    fn reserve_capacity(&mut self, capacity: usize) -> Result<(), Errno> {
        let bytes = capacity.checked_mul(core::mem::size_of::<Value>()).ok_or(Errno::ENOMEM)?;
        let mut reservation = reserve_payload(bytes, false)?;
        let mut values = VecDeque::new();
        values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)?;
        let actual = values.capacity().checked_mul(core::mem::size_of::<Value>())
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)?;
        reservation.resize(actual)?;
        values.append(&mut self.values);
        self.values = values;
        self.reservation = reservation;
        Ok(())
    }

    pub fn push_back(&mut self, value: Value) {
        assert!(self.values.len() < self.values.capacity(), "I/O queue publication lacks admitted capacity");
        self.values.push_back(value);
    }

    pub fn pop_front(&mut self) -> Option<Value> { self.values.pop_front() }
    pub(crate) fn remove(&mut self, index: usize) -> Option<Value> { self.values.remove(index) }
    pub fn clear(&mut self) { self.values.clear(); }
}

impl<Value> Default for IoDeque<Value> { fn default() -> Self { Self::new() } }

impl<Value: core::fmt::Debug> core::fmt::Debug for IoDeque<Value> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { self.values.fmt(formatter) }
}

impl<Value: Copy> IoDeque<Value> {
    pub(crate) fn extend_from_slice(&mut self, values: &[Value]) {
        assert!(values.len() <= self.values.capacity() - self.values.len(), "I/O queue extension lacks admitted capacity");
        self.values.extend(values.iter().copied());
    }

    pub(crate) fn try_clone_with_headroom(&self, additional: usize) -> Result<Self, Errno> {
        let mut cloned = Self::new();
        cloned.try_reserve(self.len().checked_add(additional).ok_or(Errno::ENOMEM)?)?;
        for value in self.values.iter().copied() { cloned.push_back(value); }
        Ok(cloned)
    }
}

impl<Value> Deref for IoDeque<Value> {
    type Target = VecDeque<Value>;
    fn deref(&self) -> &Self::Target { &self.values }
}

impl<'a, Value> IntoIterator for &'a mut IoDeque<Value> {
    type Item = &'a mut Value;
    type IntoIter = alloc::collections::vec_deque::IterMut<'a, Value>;
    fn into_iter(self) -> Self::IntoIter { self.values.iter_mut() }
}

pub struct IoDequeIntoIter<Value> {
    values: alloc::collections::vec_deque::IntoIter<Value>,
    _reservation: MetadataReservation<'static>,
}

impl<Value> Iterator for IoDequeIntoIter<Value> {
    type Item = Value;
    fn next(&mut self) -> Option<Value> { self.values.next() }
    fn size_hint(&self) -> (usize, Option<usize>) { self.values.size_hint() }
}

impl<Value> IntoIterator for IoDeque<Value> {
    type Item = Value;
    type IntoIter = IoDequeIntoIter<Value>;
    fn into_iter(self) -> Self::IntoIter {
        IoDequeIntoIter { values: self.values.into_iter(), _reservation: self.reservation }
    }
}

#[cfg(test)]
pub(crate) struct IoBudgetGuard(usize);

#[cfg(test)]
pub(crate) fn test_budget(limit: usize) -> IoBudgetGuard {
    let previous = IO_MEMORY.usage().1;
    IO_MEMORY.set_limit(limit).unwrap();
    IoBudgetGuard(previous)
}

#[cfg(test)]
impl Drop for IoBudgetGuard {
    fn drop(&mut self) { IO_MEMORY.set_limit(self.0).unwrap(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filled_buffer_refuses_before_publication_and_owns_retained_capacity() {
        let baseline = IO_MEMORY.usage().0;
        {
            let _limit = test_budget(baseline);
            assert!(matches!(IoBuffer::try_filled(4096, 7u8), Err(Errno::ENOMEM)));
        }
        assert_eq!(IO_MEMORY.usage().0, baseline);
        let buffer = IoBuffer::try_filled(4096, 7u8).unwrap();
        assert_eq!(buffer.len(), 4096);
        assert!(buffer.iter().all(|byte| *byte == 7));
        assert!(IO_MEMORY.usage().0 >= baseline + 8192);
        drop(buffer);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn fallible_push_preserves_move_only_owners_and_retries_after_reclaim() {
        use alloc::rc::Rc;
        use core::cell::Cell;
        struct Owner(Rc<Cell<usize>>);
        impl Drop for Owner {
            fn drop(&mut self) { self.0.set(self.0.get() + 1); }
        }
        let baseline = IO_MEMORY.usage().0;
        let dropped = Rc::new(Cell::new(0));
        let mut values = IoBuffer::new();
        {
            let _limit = test_budget(baseline);
            assert_eq!(values.try_push(Owner(dropped.clone())), Err(Errno::ENOMEM));
            assert!(values.is_empty());
            assert_eq!(dropped.get(), 1);
        }
        for _ in 0..4 { values.try_push(Owner(dropped.clone())).unwrap(); }
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = test_budget(retained);
            assert_eq!(values.try_push(Owner(dropped.clone())), Err(Errno::ENOMEM));
            assert_eq!(values.len(), 4);
            assert_eq!(IO_MEMORY.usage().0, retained);
            assert_eq!(dropped.get(), 2);
        }
        values.try_push(Owner(dropped.clone())).unwrap();
        assert_eq!(values.len(), 5);
        drop(values);
        assert_eq!(dropped.get(), 7);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    fn buffer(capacity: usize) -> Result<IoBuffer<u64>, Errno> {
        IoBuffer::allocate(capacity, false, |values| values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))
    }

    #[test]
    fn deque_wrap_growth_refusal_exact_fallback_and_consumption_retain_credit() {
        let baseline = IO_MEMORY.usage().0;
        let mut values = IoDeque::new();
        values.try_reserve(4).unwrap();
        for value in 0u64..4 { values.push_back(value); }
        assert_eq!(values.pop_front(), Some(0));
        assert_eq!(values.pop_front(), Some(1));
        values.push_back(4);
        values.push_back(5);
        let old_credit = IO_MEMORY.usage().0 - baseline;
        let replacement_credit = 2 * 5 * core::mem::size_of::<u64>();
        {
            let _limit = test_budget(baseline + replacement_credit);
            assert_eq!(values.try_reserve(1), Err(Errno::ENOMEM));
            assert!(values.iter().copied().eq([2, 3, 4, 5]));
            assert_eq!(IO_MEMORY.usage().0, baseline + old_credit);
        }
        {
            let _limit = test_budget(baseline + old_credit + replacement_credit);
            values.try_reserve(1).unwrap();
            values.push_back(6);
            assert!(values.iter().copied().eq([2, 3, 4, 5, 6]));
            let held = IO_MEMORY.usage().0;
            let mut iterator = values.into_iter();
            for expected in 2..7 { assert_eq!(iterator.next(), Some(expected)); }
            assert_eq!(iterator.next(), None);
            assert_eq!(IO_MEMORY.usage().0, held);
            drop(iterator);
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn ownership_and_consuming_iterator_retain_actual_capacity_credit() {
        let baseline = IO_MEMORY.usage().0;
        let mut values = buffer(8).unwrap();
        let charge = values.capacity() * core::mem::size_of::<u64>() * 2;
        values.push(7);
        values.push(9);
        assert_eq!(IO_MEMORY.usage().0, baseline + charge);
        let mut iterator = values.into_iter();
        assert_eq!(iterator.next(), Some(7));
        assert_eq!(IO_MEMORY.usage().0, baseline + charge);
        assert_eq!(iterator.next(), Some(9));
        assert_eq!(iterator.next(), None);
        assert_eq!(IO_MEMORY.usage().0, baseline + charge);
        drop(iterator);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn quota_and_overflow_refuse_before_allocator_and_failed_allocations_release_credit() {
        let baseline = IO_MEMORY.usage().0;
        {
            let _limit = test_budget(baseline);
            assert_eq!(IoBuffer::<u64>::allocate(1, false, |_| panic!("allocator called after denied admission")), Err(Errno::ENOMEM));
        }
        assert_eq!(IoBuffer::<u64>::allocate(usize::MAX, false, |_| panic!("allocator called after overflow")), Err(Errno::ENOMEM));
        assert_eq!(IoBuffer::<u64>::allocate(8, false, |_| Err(Errno::ENOMEM)), Err(Errno::ENOMEM));
        assert_eq!(IO_MEMORY.usage().0, baseline);
        {
            let _limit = test_budget(baseline + 16);
            assert_eq!(IoBuffer::<u64>::allocate(1, false, |values| {
                values.try_reserve_exact(2).map_err(|_| Errno::ENOMEM)
            }), Err(Errno::ENOMEM));
        }
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn growth_charges_both_buffers_and_preserves_original_on_every_refusal() {
        let baseline = IO_MEMORY.usage().0;
        let mut values = buffer(8).unwrap();
        values.extend_from_slice(&[11, 13]);
        let old = IO_MEMORY.usage().0;
        {
            let _limit = test_budget(old + 16 * 16 - 1);
            assert_eq!(values.reserve_with(16, |_| panic!("growth allocator called after denied admission")), Err(Errno::ENOMEM));
            assert_eq!(&*values, &[11, 13]);
            assert_eq!(IO_MEMORY.usage().0, old);
        }
        assert_eq!(values.reserve_with(16, |_| Err(Errno::ENOMEM)), Err(Errno::ENOMEM));
        assert_eq!(&*values, &[11, 13]);
        {
            let _limit = test_budget(old + 16 * 16);
            assert_eq!(values.reserve_with(16, |replacement| {
                replacement.try_reserve_exact(17).map_err(|_| Errno::ENOMEM)
            }), Err(Errno::ENOMEM));
            assert_eq!(&*values, &[11, 13]);
            assert_eq!(IO_MEMORY.usage().0, old);
        }
        values.reserve_with(16, |replacement| replacement.try_reserve_exact(16).map_err(|_| Errno::ENOMEM)).unwrap();
        assert_eq!(&*values, &[11, 13]);
        assert_eq!(IO_MEMORY.usage().0, baseline + values.capacity() * 16);
        drop(values);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn ordinary_exhaustion_cannot_spend_writeback_headroom() {
        let baseline = IO_MEMORY.usage().0;
        let writeback_before = WRITEBACK_MEMORY.usage().0;
        let _limit = test_budget(baseline);
        assert_eq!(buffer(1), Err(Errno::ENOMEM));
        let values = IoBuffer::<u8>::allocate(4096, true, |values| values.try_reserve_exact(4096).map_err(|_| Errno::ENOMEM)).unwrap();
        assert_eq!(IO_MEMORY.usage().0, baseline);
        assert_eq!(WRITEBACK_MEMORY.usage().0, writeback_before + values.capacity() * 2);
        drop(values);
        assert_eq!(WRITEBACK_MEMORY.usage().0, writeback_before);
    }

    #[test]
    fn move_only_growth_preserves_owners_on_refusal_and_moves_without_cloning() {
        struct Owner {
            allocation: alloc::boxed::Box<u64>,
            drops: alloc::rc::Rc<core::cell::Cell<usize>>,
        }
        impl Drop for Owner {
            fn drop(&mut self) { self.drops.set(self.drops.get() + 1); }
        }
        let baseline = IO_MEMORY.usage().0;
        let drops = alloc::rc::Rc::new(core::cell::Cell::new(0));
        let mut values = IoBuffer::new();
        values.reserve_with(1, |values| values.try_reserve_exact(1).map_err(|_| Errno::ENOMEM)).unwrap();
        values.push(Owner { allocation: alloc::boxed::Box::new(19), drops: drops.clone() });
        let address = &*values[0].allocation as *const u64;
        let old = IO_MEMORY.usage().0;
        let charge = 2 * 2 * core::mem::size_of::<Owner>();
        {
            let _limit = test_budget(old + charge - 1);
            assert_eq!(values.reserve_with(2, |_| panic!("allocation after refused ownership admission")), Err(Errno::ENOMEM));
        }
        assert_eq!(values.reserve_with(2, |_| Err(Errno::ENOMEM)), Err(Errno::ENOMEM));
        {
            let _limit = test_budget(old + charge);
            assert_eq!(values.reserve_with(2, |replacement| {
                replacement.try_reserve_exact(3).map_err(|_| Errno::ENOMEM)
            }), Err(Errno::ENOMEM));
        }
        assert_eq!(values.len(), 1);
        assert_eq!(&*values[0].allocation as *const u64, address);
        assert_eq!(drops.get(), 0);
        assert_eq!(IO_MEMORY.usage().0, old);
        values.reserve_with(2, |replacement| replacement.try_reserve_exact(2).map_err(|_| Errno::ENOMEM)).unwrap();
        assert_eq!(&*values[0].allocation as *const u64, address);
        assert_eq!(drops.get(), 0);
        assert_eq!(IO_MEMORY.usage().0, baseline + values.capacity() * core::mem::size_of::<Owner>() * 2);
        drop(values);
        assert_eq!(drops.get(), 1);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn growth_rejects_populated_replacement_without_mutating_original() {
        let baseline = IO_MEMORY.usage().0;
        let mut values = buffer(1).unwrap();
        values.push(23);
        let old = IO_MEMORY.usage().0;
        assert_eq!(values.reserve_with(2, |replacement| {
            replacement.try_reserve_exact(2).map_err(|_| Errno::ENOMEM)?;
            replacement.push(29);
            Ok(())
        }), Err(Errno::EIO));
        assert_eq!(&*values, &[23]);
        assert_eq!(IO_MEMORY.usage().0, old);
        drop(values);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }
}
