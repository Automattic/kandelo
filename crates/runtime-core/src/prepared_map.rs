use alloc::alloc::alloc;
use alloc::boxed::Box;
use alloc::vec::Vec;
use core::alloc::Layout;
use core::borrow::Borrow;
use core::cmp::Ordering;
use core::ops::{Index, Range};
use core::mem::MaybeUninit;
use wasm_posix_shared::Errno;
use crate::metadata_budget::{MetadataBudget, MetadataReservation};

pub(crate) const DEFAULT_JOURNAL_STATE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const JOURNAL_WRITEBACK_HEADROOM: usize = 256 * 1024;
pub(crate) static JOURNAL_STATE_MEMORY: MetadataBudget = MetadataBudget::tracked(DEFAULT_JOURNAL_STATE_BYTES - JOURNAL_WRITEBACK_HEADROOM, &crate::metadata_budget::FILESYSTEM_ADMISSION);
pub(crate) static JOURNAL_WRITEBACK_MEMORY: MetadataBudget = MetadataBudget::tracked(JOURNAL_WRITEBACK_HEADROOM, &crate::metadata_budget::FILESYSTEM_ADMISSION);

pub(crate) fn writeback_reserve_in_use() -> bool { JOURNAL_WRITEBACK_MEMORY.usage().0 != 0 }

#[cfg(test)]
pub(crate) struct JournalBudgetGuard(usize);

#[cfg(test)]
pub(crate) fn test_budget(limit: usize) -> JournalBudgetGuard {
    let previous = JOURNAL_STATE_MEMORY.usage().1;
    JOURNAL_STATE_MEMORY.set_limit(limit).unwrap();
    JournalBudgetGuard(previous)
}

#[cfg(test)]
impl Drop for JournalBudgetGuard {
    fn drop(&mut self) { JOURNAL_STATE_MEMORY.set_limit(self.0).unwrap(); }
}

pub(crate) trait MapMemory {
    fn heap_bytes(&self) -> Result<usize, Errno>;
}

macro_rules! scalar_memory {
    ($($scalar:ty),*) => { $(impl MapMemory for $scalar {
        fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
    })* };
}

scalar_memory!(u8, u16, u32, u64, usize, i32, i64);

impl MapMemory for (u64, u64) {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl MapMemory for Vec<u8> {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(self.capacity()) }
}

impl MapMemory for alloc::string::String {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(self.capacity()) }
}

impl<Value: MapMemory> MapMemory for Option<Value> {
    fn heap_bytes(&self) -> Result<usize, Errno> { self.as_ref().map_or(Ok(0), MapMemory::heap_bytes) }
}

const ITERATOR_DEPTH: usize = usize::BITS as usize * 2;
type Link<Key, Value> = Option<Box<Node<Key, Value>>>;

struct Node<Key, Value> {
    key: Key,
    value: Value,
    left: Link<Key, Value>,
    right: Link<Key, Value>,
    height: u8,
    _reservation: MetadataReservation<'static>,
}

pub(crate) struct PreparedEntry<Key, Value>(Box<Node<Key, Value>>);

impl<Value> PreparedEntry<u64, Value> {
    pub(crate) fn replace_key(&mut self, key: u64) { self.0.key = key; }
}

#[cfg(test)]
static FAIL_AFTER: core::sync::atomic::AtomicUsize = core::sync::atomic::AtomicUsize::new(usize::MAX);

#[cfg(test)]
pub(crate) fn fail_after_allocations(successes: usize) {
    FAIL_AFTER.store(successes, core::sync::atomic::Ordering::SeqCst);
}

#[cfg(test)]
fn check_node_allocation() -> Result<(), Errno> {
    let remaining = FAIL_AFTER.load(core::sync::atomic::Ordering::SeqCst);
    if remaining != usize::MAX {
        FAIL_AFTER.store(remaining.wrapping_sub(1), core::sync::atomic::Ordering::SeqCst);
        if remaining == 0 { return Err(Errno::ENOMEM); }
    }
    Ok(())
}

pub(crate) struct PreparedMapSlot<Key, Value> {
    allocation: Box<MaybeUninit<Node<Key, Value>>>,
    reservation: MetadataReservation<'static>,
}

impl<Key, Value> PreparedMapSlot<Key, Value> {
    pub(crate) fn new_in(budget: &'static MetadataBudget, heap_bytes: usize) -> Result<Self, Errno> {
        let reservation = PreparedEntry::<Key, Value>::reserve_in(budget, heap_bytes)?;
        #[cfg(test)]
        check_node_allocation()?;
        let allocation = Box::try_new(MaybeUninit::uninit()).map_err(|_| Errno::ENOMEM)?;
        Ok(Self { allocation, reservation })
    }
}

impl<Key: MapMemory, Value: MapMemory> PreparedMapSlot<Key, Value> {
    pub(crate) fn finish(self, key: Key, value: Value) -> Result<PreparedEntry<Key, Value>, Errno> {
        let Self { mut allocation, mut reservation } = self;
        let heap = key.heap_bytes()?.checked_add(value.heap_bytes()?).ok_or(Errno::ENOMEM)?;
        reservation.resize(PreparedEntry::<Key, Value>::memory_bytes(heap)?)?;
        allocation.write(Node { key, value, left: None, right: None, height: 1, _reservation: reservation });
        Ok(PreparedEntry(unsafe { allocation.assume_init() }))
    }
}

impl<Key, Value> PreparedEntry<Key, Value> {
    fn detached(mut node: Box<Node<Key, Value>>) -> Self {
        assert!(node.left.is_none() && node.right.is_none(), "prepared map entry still has children");
        node.height = 1;
        Self(node)
    }

    pub(crate) fn memory_bytes(heap_bytes: usize) -> Result<usize, Errno> {
        core::mem::size_of::<Node<Key, Value>>().checked_add(heap_bytes)
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)
    }

    pub(crate) fn reserve(heap_bytes: usize) -> Result<MetadataReservation<'static>, Errno> {
        if writeback_reserve_in_use() { return Err(Errno::ENOMEM); }
        Self::reserve_in(&JOURNAL_STATE_MEMORY, heap_bytes)
    }

    pub(crate) fn reserve_in(budget: &'static MetadataBudget, heap_bytes: usize) -> Result<MetadataReservation<'static>, Errno> {
        budget.reserve(Self::memory_bytes(heap_bytes)?)
    }

    pub(crate) fn reserve_writeback(heap_bytes: usize) -> Result<MetadataReservation<'static>, Errno> {
        Self::reserve(heap_bytes).or_else(|_| JOURNAL_WRITEBACK_MEMORY.reserve(Self::memory_bytes(heap_bytes)?))
    }

    pub(crate) fn key(&self) -> &Key { &self.0.key }
    pub(crate) fn value(&self) -> &Value { &self.0.value }
    pub(crate) fn value_mut(&mut self) -> &mut Value { &mut self.0.value }

    pub(crate) fn into_reserved_value(self) -> (Value, MetadataReservation<'static>) {
        let Node { value, _reservation, .. } = *self.0;
        (value, _reservation)
    }

    fn into_pair(self) -> (Key, Value) {
        let Node { key, value, .. } = *self.0;
        (key, value)
    }
}

impl<Key: MapMemory, Value: MapMemory> PreparedEntry<Key, Value> {
    pub(crate) fn new(key: Key, value: Value) -> Result<Self, Errno> {
        let heap = key.heap_bytes()?.checked_add(value.heap_bytes()?).ok_or(Errno::ENOMEM)?;
        Self::new_reserved(key, value, Self::reserve(heap)?)
    }

    pub(crate) fn new_writeback(key: Key, value: Value) -> Result<Self, Errno> {
        let heap = key.heap_bytes()?.checked_add(value.heap_bytes()?).ok_or(Errno::ENOMEM)?;
        Self::new_reserved(key, value, Self::reserve_writeback(heap)?)
    }

    pub(crate) fn new_reserved(key: Key, value: Value, reservation: MetadataReservation<'static>) -> Result<Self, Errno> {
        if !core::ptr::eq(reservation.budget(), &JOURNAL_STATE_MEMORY)
            && !core::ptr::eq(reservation.budget(), &JOURNAL_WRITEBACK_MEMORY) { return Err(Errno::EIO); }
        Self::new_reserved_in(reservation.budget(), key, value, reservation)
    }

    pub(crate) fn new_reserved_in(budget: &'static MetadataBudget, key: Key, value: Value, mut reservation: MetadataReservation<'static>) -> Result<Self, Errno> {
        if !core::ptr::eq(reservation.budget(), budget) { return Err(Errno::EIO); }
        let heap = key.heap_bytes()?.checked_add(value.heap_bytes()?).ok_or(Errno::ENOMEM)?;
        reservation.resize(Self::memory_bytes(heap)?)?;
        #[cfg(test)]
        check_node_allocation()?;
        let allocation = unsafe { alloc(Layout::new::<Node<Key, Value>>()) }.cast::<Node<Key, Value>>();
        if allocation.is_null() { return Err(Errno::ENOMEM); }
        let node = Node { key, value, left: None, right: None, height: 1, _reservation: reservation };
        Ok(Self(unsafe {
            allocation.write(node);
            Box::from_raw(allocation)
        }))
    }
}

pub struct PreparedMap<Key, Value> {
    root: Link<Key, Value>,
    length: usize,
}

impl<Key, Value> MapMemory for PreparedMap<Key, Value> {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl<Key, Value> Default for PreparedMap<Key, Value> {
    fn default() -> Self { Self::new() }
}

impl<Key, Value> PreparedMap<Key, Value> {
    pub const fn new() -> Self { Self { root: None, length: 0 } }
}

fn height<Key, Value>(link: &Link<Key, Value>) -> u8 { link.as_ref().map_or(0, |node| node.height) }

fn update<Key, Value>(node: &mut Node<Key, Value>) {
    node.height = 1 + height(&node.left).max(height(&node.right));
}

fn rotate_left<Key, Value>(mut root: Box<Node<Key, Value>>) -> Box<Node<Key, Value>> {
    let mut pivot = root.right.take().expect("prepared map right child missing");
    root.right = pivot.left.take();
    update(&mut root);
    pivot.left = Some(root);
    update(&mut pivot);
    pivot
}

fn rotate_right<Key, Value>(mut root: Box<Node<Key, Value>>) -> Box<Node<Key, Value>> {
    let mut pivot = root.left.take().expect("prepared map left child missing");
    root.left = pivot.right.take();
    update(&mut root);
    pivot.right = Some(root);
    update(&mut pivot);
    pivot
}

fn balance<Key, Value>(mut root: Box<Node<Key, Value>>) -> Box<Node<Key, Value>> {
    update(&mut root);
    if height(&root.left) > height(&root.right) + 1 {
        let child = root.left.as_ref().expect("prepared map left child missing");
        if height(&child.right) > height(&child.left) { root.left = root.left.take().map(rotate_left); }
        rotate_right(root)
    } else if height(&root.right) > height(&root.left) + 1 {
        let child = root.right.as_ref().expect("prepared map right child missing");
        if height(&child.left) > height(&child.right) { root.right = root.right.take().map(rotate_right); }
        rotate_left(root)
    } else { root }
}

fn insert<Key: Ord, Value>(root: Link<Key, Value>, mut node: Box<Node<Key, Value>>) -> (Box<Node<Key, Value>>, Option<PreparedEntry<Key, Value>>) {
    let Some(mut root) = root else { return (node, None) };
    let prior = match node.key.cmp(&root.key) {
        Ordering::Less => {
            let (child, prior) = insert(root.left.take(), node);
            root.left = Some(child);
            prior
        }
        Ordering::Greater => {
            let (child, prior) = insert(root.right.take(), node);
            root.right = Some(child);
            prior
        }
        Ordering::Equal => {
            node.left = root.left.take();
            node.right = root.right.take();
            node.height = root.height;
            return (node, Some(PreparedEntry::detached(root)));
        }
    };
    (balance(root), prior)
}

fn join<Key, Value>(left: Link<Key, Value>, mut middle: Box<Node<Key, Value>>, right: Link<Key, Value>) -> Box<Node<Key, Value>> {
    if height(&left) > height(&right) + 1 {
        let mut root = left.expect("prepared map join left missing");
        root.right = Some(join(root.right.take(), middle, right));
        balance(root)
    } else if height(&right) > height(&left) + 1 {
        let mut root = right.expect("prepared map join right missing");
        root.left = Some(join(left, middle, root.left.take()));
        balance(root)
    } else {
        middle.left = left;
        middle.right = right;
        update(&mut middle);
        middle
    }
}

fn take_min<Key, Value>(mut root: Box<Node<Key, Value>>) -> (Link<Key, Value>, Box<Node<Key, Value>>) {
    let Some(left) = root.left.take() else { return (root.right.take(), root) };
    let (left, minimum) = take_min(left);
    root.left = left;
    (Some(balance(root)), minimum)
}

fn remove<Key: Ord + Borrow<Query>, Value, Query: Ord + ?Sized>(root: Link<Key, Value>, key: &Query) -> (Link<Key, Value>, Option<PreparedEntry<Key, Value>>) {
    let Some(mut root) = root else { return (None, None) };
    let removed = match key.cmp(root.key.borrow()) {
        Ordering::Less => {
            let (left, removed) = remove(root.left.take(), key);
            root.left = left;
            removed
        }
        Ordering::Greater => {
            let (right, removed) = remove(root.right.take(), key);
            root.right = right;
            removed
        }
        Ordering::Equal => {
            let left = root.left.take();
            let right = root.right.take();
            let replacement = match right {
                None => left,
                Some(right) => {
                    let (right, middle) = take_min(right);
                    Some(join(left, middle, right))
                }
            };
            return (replacement, Some(PreparedEntry::detached(root)));
        }
    };
    (Some(balance(root)), removed)
}

fn for_each_mut<'scope, Key, Value>(root: &'scope mut Link<Key, Value>, visit: &mut impl FnMut(&'scope mut Value)) {
    if let Some(root) = root {
        for_each_mut(&mut root.left, visit);
        visit(&mut root.value);
        for_each_mut(&mut root.right, visit);
    }
}

fn retain<Key, Value>(root: Link<Key, Value>, keep: &mut impl FnMut(&Key, &mut Value) -> bool, removed: &mut usize) -> Link<Key, Value> {
    let mut root = root?;
    let left = retain(root.left.take(), keep, removed);
    let retained = keep(&root.key, &mut root.value);
    let right = retain(root.right.take(), keep, removed);
    if retained { return Some(join(left, root, right)); }
    *removed += 1;
    drop(root);
    let Some(right) = right else { return left };
    let (right, middle) = take_min(right);
    Some(join(left, middle, right))
}

impl<Key: Ord, Value> PreparedMap<Key, Value> {
    pub fn len(&self) -> usize { self.length }
    pub fn is_empty(&self) -> bool { self.length == 0 }
    pub fn clear(&mut self) { self.root = None; self.length = 0; }

    pub fn get<Query: Ord + ?Sized>(&self, key: &Query) -> Option<&Value> where Key: Borrow<Query> {
        self.get_by(|candidate| key.cmp(candidate.borrow()))
    }

    pub(crate) fn get_by(&self, compare: impl Fn(&Key) -> Ordering) -> Option<&Value> {
        let mut current = self.root.as_deref();
        while let Some(node) = current {
            match compare(&node.key) {
                Ordering::Less => current = node.left.as_deref(),
                Ordering::Greater => current = node.right.as_deref(),
                Ordering::Equal => return Some(&node.value),
            }
        }
        None
    }

    pub fn contains_key<Query: Ord + ?Sized>(&self, key: &Query) -> bool where Key: Borrow<Query> { self.get(key).is_some() }

    pub fn get_mut<Query: Ord + ?Sized>(&mut self, key: &Query) -> Option<&mut Value> where Key: Borrow<Query> {
        let mut current = self.root.as_deref_mut();
        while let Some(node) = current {
            match key.cmp(node.key.borrow()) {
                Ordering::Less => current = node.left.as_deref_mut(),
                Ordering::Greater => current = node.right.as_deref_mut(),
                Ordering::Equal => return Some(&mut node.value),
            }
        }
        None
    }

    pub fn remove<Query: Ord + ?Sized>(&mut self, key: &Query) -> Option<Value> where Key: Borrow<Query> {
        self.remove_entry(key).map(|entry| entry.into_reserved_value().0)
    }

    pub(crate) fn prepare_io(&self, key: Key, value: Value) -> Result<PreparedEntry<Key, Value>, Errno>
    where Key: MapMemory, Value: MapMemory {
        if self.contains_key(&key) { return Err(Errno::EEXIST); }
        let heap = key.heap_bytes()?.checked_add(value.heap_bytes()?).ok_or(Errno::ENOMEM)?;
        let reservation = PreparedEntry::<Key, Value>::reserve_in(&crate::io_buffer::IO_MEMORY, heap)?;
        PreparedEntry::new_reserved_in(&crate::io_buffer::IO_MEMORY, key, value, reservation)
    }

    pub(crate) fn publish_io(&mut self, prepared: PreparedEntry<Key, Value>) {
        assert!(!self.contains_key(prepared.key()), "prepared map key changed before publication");
        self.insert_prepared(prepared);
    }

    pub(crate) fn try_insert_io(&mut self, key: Key, value: Value) -> Result<Option<Value>, Errno>
    where Key: MapMemory, Value: MapMemory {
        if let Some(existing) = self.get_mut(&key) { return Ok(Some(core::mem::replace(existing, value))); }
        let prepared = self.prepare_io(key, value)?;
        self.publish_io(prepared);
        Ok(None)
    }

    pub(crate) fn try_clone_io(&self) -> Result<Self, Errno>
    where Key: Copy + MapMemory, Value: Copy + MapMemory {
        let mut cloned = Self::new();
        for (key, value) in self { cloned.try_insert_io(*key, *value)?; }
        Ok(cloned)
    }

    pub(crate) fn into_pairs(self) -> MapIntoIter<Key, Value> { MapIntoIter { map: self } }

    #[cfg(test)]
    pub(crate) fn insert(&mut self, key: Key, value: Value) -> Option<Value>
    where Key: MapMemory, Value: MapMemory { self.try_insert_io(key, value).unwrap() }

    pub(crate) fn at_or_before(&self, key: &Key) -> Option<(&Key, &Value)> {
        let mut current = self.root.as_deref();
        let mut predecessor = None;
        while let Some(node) = current {
            match key.cmp(&node.key) {
                Ordering::Less => current = node.left.as_deref(),
                Ordering::Equal => return Some((&node.key, &node.value)),
                Ordering::Greater => {
                    predecessor = Some((&node.key, &node.value));
                    current = node.right.as_deref();
                }
            }
        }
        predecessor
    }

    pub(crate) fn last_key_value(&self) -> Option<(&Key, &Value)> {
        let mut current = self.root.as_deref()?;
        while let Some(right) = current.right.as_deref() { current = right; }
        Some((&current.key, &current.value))
    }

    pub(crate) fn next_after(&self, key: &Key) -> Option<(&Key, &Value)> {
        let mut current = self.root.as_deref();
        let mut successor = None;
        while let Some(node) = current {
            if key < &node.key {
                successor = Some((&node.key, &node.value));
                current = node.left.as_deref();
            } else { current = node.right.as_deref(); }
        }
        successor
    }

    pub(crate) fn insert_prepared(&mut self, prepared: PreparedEntry<Key, Value>) -> Option<PreparedEntry<Key, Value>> {
        let (root, prior) = insert(self.root.take(), prepared.0);
        self.root = Some(root);
        if prior.is_none() { self.length += 1; }
        prior
    }

    pub(crate) fn remove_entry<Query: Ord + ?Sized>(&mut self, key: &Query) -> Option<PreparedEntry<Key, Value>> where Key: Borrow<Query> {
        let (root, removed) = remove(self.root.take(), key);
        self.root = root;
        if removed.is_some() { self.length -= 1; }
        removed
    }

    pub(crate) fn pop_first(&mut self) -> Option<PreparedEntry<Key, Value>> {
        let (root, first) = take_min(self.root.take()?);
        self.root = root;
        self.length -= 1;
        Some(PreparedEntry::detached(first))
    }

    pub(crate) fn for_each_mut<'scope>(&'scope mut self, mut visit: impl FnMut(&'scope mut Value)) {
        for_each_mut(&mut self.root, &mut visit);
    }

    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&Key, &mut Value) -> bool) {
        let mut removed = 0;
        self.root = retain(self.root.take(), &mut keep, &mut removed);
        self.length -= removed;
    }

    pub fn iter(&self) -> MapIter<'_, Key, Value> {
        let mut iterator = MapIter { stack: [None; ITERATOR_DEPTH], depth: 0, remaining: self.length };
        iterator.push_left(self.root.as_deref());
        iterator
    }

    pub fn values(&self) -> impl ExactSizeIterator<Item = &Value> + Clone { self.iter().map(|(_, value)| value) }

    pub fn keys(&self) -> impl ExactSizeIterator<Item = &Key> + Clone { self.iter().map(|(key, _)| key) }

    pub(crate) fn range(&self, range: Range<Key>) -> MapRange<'_, Key, Value> {
        let mut iterator = MapRange { stack: [None; ITERATOR_DEPTH], depth: 0, end: range.end };
        let mut current = self.root.as_deref();
        while let Some(node) = current {
            if node.key >= range.start {
                iterator.stack[iterator.depth] = Some(node);
                iterator.depth += 1;
                current = node.left.as_deref();
            } else { current = node.right.as_deref(); }
        }
        iterator
    }
}

pub struct MapIter<'a, Key, Value> {
    stack: [Option<&'a Node<Key, Value>>; ITERATOR_DEPTH],
    depth: usize,
    remaining: usize,
}

impl<Key, Value> Clone for MapIter<'_, Key, Value> {
    fn clone(&self) -> Self {
        Self { stack: self.stack, depth: self.depth, remaining: self.remaining }
    }
}

impl<'a, Key, Value> MapIter<'a, Key, Value> {
    fn push_left(&mut self, mut current: Option<&'a Node<Key, Value>>) {
        while let Some(node) = current {
            self.stack[self.depth] = Some(node);
            self.depth += 1;
            current = node.left.as_deref();
        }
    }
}

impl<'a, Key, Value> Iterator for MapIter<'a, Key, Value> {
    type Item = (&'a Key, &'a Value);
    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 { return None; }
        self.depth -= 1;
        let node = self.stack[self.depth].take().expect("prepared map iterator missing node");
        self.push_left(node.right.as_deref());
        self.remaining -= 1;
        Some((&node.key, &node.value))
    }
    fn size_hint(&self) -> (usize, Option<usize>) { (self.remaining, Some(self.remaining)) }
}

impl<Key, Value> ExactSizeIterator for MapIter<'_, Key, Value> {}
impl<Key, Value> core::iter::FusedIterator for MapIter<'_, Key, Value> {}

pub(crate) struct MapRange<'a, Key, Value> {
    stack: [Option<&'a Node<Key, Value>>; ITERATOR_DEPTH],
    depth: usize,
    end: Key,
}

impl<'a, Key: Ord, Value> Iterator for MapRange<'a, Key, Value> {
    type Item = (&'a Key, &'a Value);
    fn next(&mut self) -> Option<Self::Item> {
        if self.depth == 0 { return None; }
        self.depth -= 1;
        let node = self.stack[self.depth].take().expect("prepared map range missing node");
        if node.key >= self.end { self.depth = 0; return None; }
        let mut current = node.right.as_deref();
        while let Some(child) = current {
            self.stack[self.depth] = Some(child);
            self.depth += 1;
            current = child.left.as_deref();
        }
        Some((&node.key, &node.value))
    }
}

impl<Key: Ord, Value> core::iter::FusedIterator for MapRange<'_, Key, Value> {}

impl<Key: Ord, Value> Index<&Key> for PreparedMap<Key, Value> {
    type Output = Value;
    fn index(&self, key: &Key) -> &Value { self.get(key).expect("prepared map key missing") }
}

impl<'a, Key: Ord, Value> IntoIterator for &'a PreparedMap<Key, Value> {
    type Item = (&'a Key, &'a Value);
    type IntoIter = MapIter<'a, Key, Value>;
    fn into_iter(self) -> Self::IntoIter { self.iter() }
}

impl<Key: Ord + core::fmt::Debug, Value: core::fmt::Debug> core::fmt::Debug for PreparedMap<Key, Value> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_map().entries(self.iter()).finish()
    }
}

pub struct MapIntoIter<Key, Value> { map: PreparedMap<Key, Value> }

impl<Key: Ord, Value> Iterator for MapIntoIter<Key, Value> {
    type Item = (Key, Value);
    fn next(&mut self) -> Option<Self::Item> { self.map.pop_first().map(PreparedEntry::into_pair) }
    fn size_hint(&self) -> (usize, Option<usize>) { (self.map.len(), Some(self.map.len())) }
}

impl<Key: Ord, Value> ExactSizeIterator for MapIntoIter<Key, Value> {}

#[cfg(test)]
impl<Key: Ord + Copy + MapMemory, Value: Copy + MapMemory> Clone for PreparedMap<Key, Value> {
    fn clone(&self) -> Self { self.try_clone_io().unwrap() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_slot_owns_allocation_before_value_and_finishes_at_full_allowance() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let slot = PreparedMapSlot::<u32, u64>::new_in(&BUDGET, 0).unwrap();
        let held = BUDGET.usage().0;
        BUDGET.set_limit(held).unwrap();
        fail_after_allocations(0);
        let entry = slot.finish(10, 20).unwrap();
        let mut map = PreparedMap::new();
        map.publish_io(entry);
        fail_after_allocations(usize::MAX);
        assert_eq!(map.get(&10), Some(&20));
        assert_eq!(BUDGET.usage().0, held);
        drop(map);
        assert_eq!(BUDGET.usage().0, 0);
        BUDGET.set_limit(4096).unwrap();
        drop(PreparedMapSlot::<u32, u64>::new_in(&BUDGET, 0).unwrap());
        assert_eq!(BUDGET.usage().0, 0);
        fail_after_allocations(0);
        assert!(matches!(PreparedMapSlot::<u32, u64>::new_in(&BUDGET, 0), Err(Errno::ENOMEM)));
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn prepared_slot_failed_value_reconciliation_releases_allocation_and_credit() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let slot = PreparedMapSlot::<u32, Vec<u8>>::new_in(&BUDGET, 0).unwrap();
        BUDGET.set_limit(BUDGET.usage().0).unwrap();
        assert!(matches!(slot.finish(1, vec![7; 16]), Err(Errno::ENOMEM)));
        assert_eq!(BUDGET.usage().0, 0);
        BUDGET.set_limit(4096).unwrap();
    }

    #[test]
    fn mutable_walk_can_lend_disjoint_values_for_one_borrow() {
        let mut map = PreparedMap::<u32, u64>::new();
        map.insert(1, 10);
        map.insert(2, 20);
        let mut values = Vec::new();
        map.for_each_mut(|value| values.push(value));
        *values[0] += 1;
        *values[1] += 2;
        drop(values);
        assert_eq!(map.get(&1), Some(&11));
        assert_eq!(map.get(&2), Some(&22));
    }

    #[test]
    fn detached_nodes_keep_leaf_heights_and_avl_balance_when_transferred() {
        fn validate(root: &Link<u64, u64>) -> u8 {
            let Some(node) = root else { return 0; };
            let left = validate(&node.left);
            let right = validate(&node.right);
            assert!(left.abs_diff(right) <= 1);
            assert_eq!(node.height, left.max(right) + 1);
            node.height
        }
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut source = PreparedMap::new();
        let mut destination = PreparedMap::new();
        for key in 0u64..=6 { source.try_insert_io(key, key).unwrap(); }
        for key in [1u64, 0] { destination.try_insert_io(key, key).unwrap(); }
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            let mut removed = source.remove_entry(&3).unwrap();
            assert_eq!(removed.0.height, 1);
            removed.replace_key(2);
            destination.publish_io(removed);
            validate(&source.root);
            validate(&destination.root);
        }
        drop(source);
        drop(destination);
        let mut source = PreparedMap::new();
        let mut destination = PreparedMap::new();
        for key in 0u64..128 { source.try_insert_io(key, key).unwrap(); }
        {
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(held);
            while let Some(key) = source.root.as_ref().map(|node| node.key) {
                let mut removed = source.remove_entry(&key).unwrap();
                removed.replace_key(key + 1000);
                destination.publish_io(removed);
                validate(&source.root);
                validate(&destination.root);
                assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            }
        }
        drop(source);
        drop(destination);
        let mut first = PreparedMap::new();
        for key in [1u64, 2] { first.try_insert_io(key, key).unwrap(); }
        assert_eq!(first.pop_first().unwrap().0.height, 1);
        drop(first);
        let mut replaced = PreparedMap::new();
        for key in [1u64, 0, 2] { replaced.try_insert_io(key, key).unwrap(); }
        let replacement = PreparedMap::new().prepare_io(1u64, 99u64).unwrap();
        assert_eq!(replaced.insert_prepared(replacement).unwrap().0.height, 1);
        validate(&replaced.root);
        drop(replaced);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }
    use alloc::collections::BTreeMap;
    use alloc::vec::Vec;

    fn verify(root: &Link<u32, u32>, minimum: Option<u32>, maximum: Option<u32>) -> (usize, u8) {
        let Some(root) = root else { return (0, 0) };
        assert!(minimum.is_none_or(|key| key < root.key));
        assert!(maximum.is_none_or(|key| root.key < key));
        let (left_count, left) = verify(&root.left, minimum, Some(root.key));
        let (right_count, right) = verify(&root.right, Some(root.key), maximum);
        assert!(left.abs_diff(right) <= 1);
        assert_eq!(root.height, 1 + left.max(right));
        (1 + left_count + right_count, root.height)
    }

    #[test]
    fn insertion_pruning_ranges_and_successors_match_a_standard_map() {
        let mut actual = PreparedMap::default();
        let mut expected = BTreeMap::new();
        let mut random = 0x72fb_4c23u32;
        for step in 0..6000 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let key = random % 512;
            let prior = actual.insert_prepared(PreparedEntry::new(key, step).unwrap());
            assert_eq!(prior.as_ref().map(|entry| *entry.value()), expected.insert(key, step));
            if step % 131 == 0 {
                actual.retain(|key, value| { *value += 1; key % 7 != 0 });
                expected.retain(|key, value| { *value += 1; key % 7 != 0 });
                assert_eq!(actual.iter().collect::<Vec<_>>(), expected.iter().collect::<Vec<_>>());
                assert_eq!(actual.last_key_value(), expected.last_key_value());
                for start in [0, 63, 300, 511, 512] {
                    assert_eq!(actual.range(start..start + 20).collect::<Vec<_>>(), expected.range(start..start + 20).collect::<Vec<_>>());
                    assert_eq!(actual.next_after(&start), expected.range((core::ops::Bound::Excluded(start), core::ops::Bound::Unbounded)).next());
                    assert_eq!(actual.at_or_before(&start), expected.range(..=start).next_back());
                }
            }
            assert_eq!(verify(&actual.root, None, None).0, actual.len());
            assert_eq!(actual.len(), expected.len());
        }
        actual.retain(|key, _| *key == 1);
        verify(&actual.root, None, None);
        actual.clear();
        assert!(actual.is_empty());
        assert_eq!(actual.last_key_value(), None);
        assert_eq!(actual.at_or_before(&0), None);
    }

    #[test]
    fn mutable_lookup_and_predecessors_cover_scalar_boundaries_without_new_credit() {
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        let mut map = PreparedMap::default();
        for key in [0, 9, u32::MAX] {
            map.insert_prepared(PreparedEntry::new(key, key).unwrap());
        }
        let used = JOURNAL_STATE_MEMORY.usage().0;
        {
            let _limit = test_budget(used);
            *map.get_mut(&9).unwrap() = 27;
            assert_eq!(map.get_mut(&8), None);
            assert_eq!(map.at_or_before(&8), Some((&0, &0)));
            assert_eq!(map.at_or_before(&9), Some((&9, &27)));
            assert_eq!(map.at_or_before(&u32::MAX), Some((&u32::MAX, &u32::MAX)));
            assert_eq!(map.last_key_value(), Some((&u32::MAX, &u32::MAX)));
            assert_eq!(JOURNAL_STATE_MEMORY.usage().0, used);
        }
        drop(map);
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
    }

    #[test]
    fn removal_and_mutable_visits_match_a_standard_map_without_allocating() {
        let mut actual = PreparedMap::default();
        let mut expected = BTreeMap::new();
        let mut random = 0x72fb_4c23u32;
        for step in 0..6000 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let key = random % 512;
            if step % 3 == 0 {
                let removed = actual.remove_entry(&key);
                assert_eq!(removed.as_ref().map(|entry| *entry.value()), expected.remove(&key));
            } else {
                actual.insert_prepared(PreparedEntry::new(key, step).unwrap());
                expected.insert(key, step);
            }
            if step % 131 == 0 {
                actual.for_each_mut(|value| *value += 1);
                for value in expected.values_mut() { *value += 1; }
                assert_eq!(actual.iter().collect::<Vec<_>>(), expected.iter().collect::<Vec<_>>());
            }
            assert_eq!(verify(&actual.root, None, None).0, actual.len());
            assert_eq!(actual.len(), expected.len());
        }
        fail_after_allocations(0);
        for (key, value) in expected {
            let entry = actual.remove_entry(&key).unwrap();
            assert_eq!(*entry.value(), value);
            assert_eq!(verify(&actual.root, None, None).0, actual.len());
        }
        assert!(actual.is_empty());
        assert!(matches!(PreparedEntry::new(1u32, 2u32), Err(Errno::ENOMEM)));
    }

    #[test]
    fn caller_budget_is_checked_and_removed_values_keep_their_credit() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        static OTHER: MetadataBudget = MetadataBudget::new(4096);
        let journal_usage = JOURNAL_STATE_MEMORY.usage();
        let bytes = PreparedEntry::<u64, Vec<u8>>::memory_bytes(16).unwrap();
        let reservation = PreparedEntry::<u64, Vec<u8>>::reserve_in(&BUDGET, 16).unwrap();
        assert!(matches!(PreparedEntry::new_reserved_in(&OTHER, 1u64, Vec::<u8>::new(), reservation), Err(Errno::EIO)));
        assert_eq!(BUDGET.usage().0, 0);
        let reservation = PreparedEntry::<u64, Vec<u8>>::reserve_in(&BUDGET, 16).unwrap();
        let mut value = Vec::with_capacity(16);
        value.extend_from_slice(b"owned");
        let entry = PreparedEntry::new_reserved_in(&BUDGET, 1u64, value, reservation).unwrap();
        let mut map = PreparedMap::default();
        map.insert_prepared(entry);
        let (value, credit) = map.remove_entry(&1).unwrap().into_reserved_value();
        assert_eq!(value, b"owned");
        assert!(map.is_empty());
        assert_eq!(BUDGET.usage().0, bytes);
        drop(value);
        drop(credit);
        assert_eq!(BUDGET.usage().0, 0);
        assert_eq!(JOURNAL_STATE_MEMORY.usage(), journal_usage);
    }

    #[test]
    fn borrowed_iterator_clones_do_not_clone_values_or_allocate() {
        struct Owner(u32);
        impl MapMemory for Owner {
            fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
        }
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        let mut map = PreparedMap::default();
        for key in 0..32 { map.insert_prepared(PreparedEntry::new(key, Owner(key)).unwrap()); }
        let retained = JOURNAL_STATE_MEMORY.usage().0;
        {
            let _limit = test_budget(retained);
            let mut first = map.values();
            assert_eq!(first.next().unwrap().0, 0);
            let mut second = first.clone();
            assert_eq!(second.len(), 31);
            assert_eq!(first.next().unwrap().0, 1);
            assert_eq!(second.next().unwrap().0, 1);
            assert_eq!(second.count(), 30);
            assert_eq!(first.count(), 30);
            assert_eq!(JOURNAL_STATE_MEMORY.usage().0, retained);
        }
        drop(map);
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
    }

    #[test]
    fn failed_preparation_leaves_existing_entries_unchanged() {
        let mut actual = PreparedMap::default();
        actual.insert_prepared(PreparedEntry::new(1, 7).unwrap());
        fail_after_allocations(0);
        assert!(matches!(PreparedEntry::new(2, 8), Err(Errno::ENOMEM)));
        assert_eq!(actual.get(&1), Some(&7));
        assert!(!actual.contains_key(&2));
        actual.insert_prepared(PreparedEntry::new(2, 8).unwrap());
        assert_eq!(actual.len(), 2);
    }

    #[test]
    fn byte_credits_follow_replacement_ownership_until_the_retired_entry_drops() {
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        let mut key = Vec::with_capacity(256);
        key.extend_from_slice(b"key");
        let mut value = Vec::with_capacity(512);
        value.extend_from_slice(b"old");
        let old_bytes = PreparedEntry::<Vec<u8>, Vec<u8>>::memory_bytes(key.capacity() + value.capacity()).unwrap();
        let entry = PreparedEntry::new(key, value).unwrap();
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline + old_bytes);
        let mut map = PreparedMap::default();
        map.insert_prepared(entry);
        let key = b"key".to_vec();
        let value = b"new".to_vec();
        let new_bytes = PreparedEntry::<Vec<u8>, Vec<u8>>::memory_bytes(key.capacity() + value.capacity()).unwrap();
        let retired = map.insert_prepared(PreparedEntry::new(key, value).unwrap()).unwrap();
        assert_eq!(retired.value(), b"old");
        assert_eq!(map.len(), 1);
        assert_eq!(map.get(&b"key".to_vec()).unwrap(), b"new");
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline + old_bytes + new_bytes);
        drop(retired);
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline + new_bytes);
        map.clear();
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
    }

    #[test]
    fn aggregate_admission_precedes_node_allocation_and_preserves_existing_entries() {
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        let bytes = PreparedEntry::<u64, u64>::memory_bytes(0).unwrap();
        let _budget = test_budget(baseline + bytes);
        let mut map = PreparedMap::default();
        map.insert_prepared(PreparedEntry::new(1u64, 7u64).unwrap());
        fail_after_allocations(0);
        assert!(matches!(PreparedEntry::new(2u64, 8u64), Err(Errno::ENOMEM)));
        assert_eq!(map.get(&1), Some(&7));
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline + bytes);
        map.clear();
        assert!(matches!(PreparedEntry::new(2u64, 8u64), Err(Errno::ENOMEM)));
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
        map.insert_prepared(PreparedEntry::new(2u64, 8u64).unwrap());
        assert_eq!(map.get(&2), Some(&8));
    }

    #[test]
    fn pruning_releases_only_removed_nodes_and_admitted_heap_capacity() {
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        let mut map = PreparedMap::default();
        let bytes = PreparedEntry::<u64, Vec<u8>>::memory_bytes(16).unwrap();
        for key in 0u64..64 {
            let mut value = Vec::with_capacity(16);
            value.push(key as u8);
            map.insert_prepared(PreparedEntry::new(key, value).unwrap());
        }
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline + 64 * bytes);
        map.retain(|key, _| key % 4 == 0);
        assert_eq!(map.len(), 16);
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline + 16 * bytes);
        drop(map);
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
    }

    #[test]
    fn byte_overflow_and_failed_allocation_do_not_leak_admission() {
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        assert!(matches!(PreparedEntry::<u64, u64>::reserve(usize::MAX), Err(Errno::ENOMEM)));
        fail_after_allocations(0);
        assert!(matches!(PreparedEntry::new(1u64, 2u64), Err(Errno::ENOMEM)));
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
    }

    #[test]
    fn pressure_and_limit_changes_observe_prepared_as_well_as_published_nodes() {
        let baseline = JOURNAL_STATE_MEMORY.usage().0;
        let bytes = PreparedEntry::<u64, u64>::memory_bytes(0).unwrap();
        let _budget = test_budget(baseline + 4 * bytes);
        let first = PreparedEntry::new(1u64, 1u64).unwrap();
        assert!(!crate::rootfs::journal_state_memory_pressure());
        let second = PreparedEntry::new(2u64, 2u64).unwrap();
        assert!(crate::rootfs::journal_state_memory_pressure());
        let before = JOURNAL_STATE_MEMORY.usage();
        assert_eq!(JOURNAL_STATE_MEMORY.set_limit(before.0 - 1), Err(Errno::ENOMEM));
        assert_eq!(JOURNAL_STATE_MEMORY.usage(), before);
        drop(second);
        assert!(!crate::rootfs::journal_state_memory_pressure());
        drop(first);
        assert_eq!(JOURNAL_STATE_MEMORY.usage().0, baseline);
    }
}
