use alloc::alloc::alloc;
use alloc::boxed::Box;
use alloc::vec::Vec;
use core::alloc::Layout;
use core::cmp::Ordering;
use core::iter::FusedIterator;
use wasm_posix_shared::Errno;
use crate::metadata_budget::{MetadataBudget, MetadataReservation, ROOTFS_METADATA};

pub(crate) const DIRENT_MODEL_BYTES: usize = 768;
const ITERATOR_DEPTH: usize = usize::BITS as usize * 2;
type Link = Option<Box<DirectoryNode>>;

struct DirectoryNode {
    name: Vec<u8>,
    inode: u32,
    left: Link,
    right: Link,
    height: u8,
}

const _: () = assert!(core::mem::size_of::<DirectoryNode>() * 2 <= DIRENT_MODEL_BYTES);

#[cfg(test)]
static FAIL_NEXT_NODE: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn fail_next_node_allocation() {
    FAIL_NEXT_NODE.store(true, core::sync::atomic::Ordering::SeqCst);
}

unsafe fn allocate_directory_memory(layout: Layout) -> *mut u8 {
    #[cfg(test)]
    if FAIL_NEXT_NODE.swap(false, core::sync::atomic::Ordering::SeqCst) { return core::ptr::null_mut(); }
    unsafe { alloc(layout) }
}

fn allocate_node(node: DirectoryNode, allocator: unsafe fn(Layout) -> *mut u8) -> Result<Box<DirectoryNode>, Errno> {
    let allocation = unsafe { allocator(Layout::new::<DirectoryNode>()) }.cast::<DirectoryNode>();
    if allocation.is_null() { return Err(Errno::ENOMEM); }
    Ok(unsafe {
        allocation.write(node);
        Box::from_raw(allocation)
    })
}

fn height(link: &Link) -> u8 { link.as_ref().map_or(0, |node| node.height) }

fn update(node: &mut DirectoryNode) { node.height = 1 + height(&node.left).max(height(&node.right)); }

fn rotate_left(mut root: Box<DirectoryNode>) -> Box<DirectoryNode> {
    let mut pivot = root.right.take().expect("directory AVL right child missing");
    root.right = pivot.left.take();
    update(&mut root);
    pivot.left = Some(root);
    update(&mut pivot);
    pivot
}

fn rotate_right(mut root: Box<DirectoryNode>) -> Box<DirectoryNode> {
    let mut pivot = root.left.take().expect("directory AVL left child missing");
    root.left = pivot.right.take();
    update(&mut root);
    pivot.right = Some(root);
    update(&mut pivot);
    pivot
}

fn balance(mut root: Box<DirectoryNode>) -> Box<DirectoryNode> {
    update(&mut root);
    if height(&root.left) > height(&root.right) + 1 {
        let child = root.left.as_ref().expect("directory AVL left child missing");
        if height(&child.right) > height(&child.left) { root.left = root.left.take().map(rotate_left); }
        rotate_right(root)
    } else if height(&root.right) > height(&root.left) + 1 {
        let child = root.right.as_ref().expect("directory AVL right child missing");
        if height(&child.left) > height(&child.right) { root.right = root.right.take().map(rotate_right); }
        rotate_left(root)
    } else { root }
}

fn insert(root: Link, node: Box<DirectoryNode>) -> (Box<DirectoryNode>, Option<u32>) {
    let Some(mut root) = root else { return (node, None) };
    let prior = match node.name.cmp(&root.name) {
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
            let prior = core::mem::replace(&mut root.inode, node.inode);
            return (root, Some(prior));
        }
    };
    (balance(root), prior)
}

fn take_min(mut root: Box<DirectoryNode>) -> (Link, Box<DirectoryNode>) {
    let Some(left) = root.left.take() else { return (root.right.take(), root) };
    let (left, minimum) = take_min(left);
    root.left = left;
    (Some(balance(root)), minimum)
}

fn remove(root: Link, name: &[u8]) -> (Link, Option<Box<DirectoryNode>>) {
    let Some(mut root) = root else { return (None, None) };
    let removed = match name.cmp(&root.name) {
        Ordering::Less => {
            let (child, removed) = remove(root.left.take(), name);
            root.left = child;
            removed
        }
        Ordering::Greater => {
            let (child, removed) = remove(root.right.take(), name);
            root.right = child;
            removed
        }
        Ordering::Equal => {
            let left = root.left.take();
            let Some(right) = root.right.take() else { return (left, Some(root)) };
            let (right, mut successor) = take_min(right);
            successor.left = left;
            successor.right = right;
            return (Some(balance(successor)), Some(root));
        }
    };
    (Some(balance(root)), removed)
}

pub(crate) struct PreparedDirectoryName<'a> {
    node: Box<DirectoryNode>,
    reservation: MetadataReservation<'a>,
}

impl<'a> PreparedDirectoryName<'a> {
    pub(crate) fn new(budget: &'a MetadataBudget, name: &[u8]) -> Result<Self, Errno> {
        Self::prepare(budget, name, false)
    }

    pub(crate) fn new_temporary(budget: &'a MetadataBudget, name: &[u8]) -> Result<Self, Errno> {
        Self::prepare(budget, name, true)
    }

    fn prepare(budget: &'a MetadataBudget, name: &[u8], temporary: bool) -> Result<Self, Errno> {
        Self::prepare_with_allocator(budget, name, temporary, allocate_directory_memory)
    }

    fn prepare_with_allocator(budget: &'a MetadataBudget, name: &[u8], temporary: bool,
        allocator: unsafe fn(Layout) -> *mut u8) -> Result<Self, Errno> {
        let bytes = name.len().checked_mul(2).and_then(|bytes| bytes.checked_add(DIRENT_MODEL_BYTES))
            .ok_or(Errno::ENOMEM)?;
        let mut reservation = if temporary { budget.reserve_temporary(bytes)? } else { budget.reserve(bytes)? };
        let mut owned = Vec::new();
        owned.try_reserve_exact(name.len()).map_err(|_| Errno::ENOMEM)?;
        owned.extend_from_slice(name);
        reservation.resize(owned.capacity().checked_mul(2)
            .and_then(|bytes| bytes.checked_add(DIRENT_MODEL_BYTES)).ok_or(Errno::ENOMEM)?)?;
        let node = allocate_node(DirectoryNode {
            name: owned, inode: 0, left: None, right: None, height: 1,
        }, allocator)?;
        Ok(Self { node, reservation })
    }

    pub(crate) fn name(&self) -> &[u8] { &self.node.name }

    pub(crate) fn reservation_mut(&mut self) -> &mut MetadataReservation<'a> { &mut self.reservation }
}

pub(crate) struct DirectoryEntries<'a> {
    root: Link,
    length: usize,
    reservation: MetadataReservation<'a>,
}

impl DirectoryEntries<'static> {
    pub(crate) fn new() -> Self { Self::with_budget(&ROOTFS_METADATA) }
}

impl<'a> DirectoryEntries<'a> {
    fn with_budget(budget: &'a MetadataBudget) -> Self {
        Self { root: None, length: 0, reservation: budget.empty() }
    }

    pub(crate) fn len(&self) -> usize { self.length }
    pub(crate) fn is_empty(&self) -> bool { self.length == 0 }

    fn find(&self, name: &[u8]) -> Option<&DirectoryNode> {
        let mut current = self.root.as_deref();
        while let Some(node) = current {
            match name.cmp(&node.name) {
                Ordering::Less => current = node.left.as_deref(),
                Ordering::Greater => current = node.right.as_deref(),
                Ordering::Equal => return Some(node),
            }
        }
        None
    }

    pub(crate) fn get(&self, name: &[u8]) -> Option<&u32> { self.find(name).map(|node| &node.inode) }

    pub(crate) fn contains_key(&self, name: &[u8]) -> bool { self.find(name).is_some() }

    pub(crate) fn next_after(&self, name: &[u8]) -> Option<(&Vec<u8>, &u32)> {
        let mut current = self.root.as_deref();
        let mut successor = None;
        while let Some(node) = current {
            if name < node.name.as_slice() {
                successor = Some((&node.name, &node.inode));
                current = node.left.as_deref();
            } else { current = node.right.as_deref(); }
        }
        successor
    }

    pub(crate) fn iter(&self) -> DirectoryIter<'_> {
        let mut iterator = DirectoryIter {
            front: [None; ITERATOR_DEPTH], back: [None; ITERATOR_DEPTH],
            front_depth: 0, back_depth: 0, remaining: self.length, root: self.root.as_deref(),
        };
        iterator.push_left(self.root.as_deref());
        iterator.push_right(self.root.as_deref());
        iterator
    }

    pub(crate) fn keys(&self) -> impl DoubleEndedIterator<Item = &Vec<u8>> + ExactSizeIterator {
        self.iter().map(|(name, _)| name)
    }

    pub(crate) fn values(&self) -> impl DoubleEndedIterator<Item = &u32> + ExactSizeIterator {
        self.iter().map(|(_, inode)| inode)
    }

    pub(crate) fn try_insert(&mut self, name: &[u8], inode: u32) -> Result<Option<u32>, Errno> {
        let prepared = PreparedDirectoryName::new(self.reservation.budget(), name)?;
        Ok(self.insert_prepared(prepared, inode))
    }

    pub(crate) fn insert_prepared(&mut self, mut prepared: PreparedDirectoryName<'a>, inode: u32) -> Option<u32> {
        assert!(core::ptr::eq(self.reservation.budget(), prepared.reservation.budget()));
        prepared.node.inode = inode;
        let (root, prior) = insert(self.root.take(), prepared.node);
        self.root = Some(root);
        if prior.is_none() {
            self.length += 1;
            self.reservation.merge(prepared.reservation);
        }
        prior
    }

    pub(crate) fn remove(&mut self, name: &[u8]) -> Option<u32> {
        let bytes = DIRENT_MODEL_BYTES + self.find(name)?.name.capacity() * 2;
        let (root, removed) = remove(self.root.take(), name);
        self.root = root;
        let prior = removed.expect("directory removal lost existing key").inode;
        self.length -= 1;
        self.reservation.resize(self.reservation.bytes().checked_sub(bytes)
            .expect("directory metadata charge underflow")).expect("directory charge release failed");
        Some(prior)
    }

    pub(crate) fn replace_existing(&mut self, name: &[u8], inode: u32) {
        let mut current = self.root.as_deref_mut();
        while let Some(node) = current {
            match name.cmp(&node.name) {
                Ordering::Less => current = node.left.as_deref_mut(),
                Ordering::Greater => current = node.right.as_deref_mut(),
                Ordering::Equal => { node.inode = inode; return; }
            }
        }
        panic!("prepared directory key missing");
    }

    pub(crate) fn extract_name_credit(&mut self, name: &[u8]) -> MetadataReservation<'a> {
        let stored = &self.find(name).expect("prepared directory key missing").name;
        self.reservation.split(DIRENT_MODEL_BYTES + stored.capacity() * 2)
    }

    pub(crate) fn restore_name_credit(&mut self, reservation: MetadataReservation<'a>) {
        self.reservation.merge(reservation);
    }

    pub(crate) fn remove_prepared(&mut self, name: &[u8], reservation: MetadataReservation<'a>) {
        let stored = &self.find(name).expect("prepared directory key missing").name;
        assert_eq!(reservation.bytes(), DIRENT_MODEL_BYTES + stored.capacity() * 2);
        let (root, removed) = remove(self.root.take(), name);
        self.root = root;
        assert!(removed.is_some());
        self.length -= 1;
        drop(reservation);
    }
}

#[derive(Clone)]
pub(crate) struct DirectoryIter<'a> {
    front: [Option<&'a DirectoryNode>; ITERATOR_DEPTH],
    back: [Option<&'a DirectoryNode>; ITERATOR_DEPTH],
    front_depth: usize,
    back_depth: usize,
    remaining: usize,
    root: Option<&'a DirectoryNode>,
}

#[derive(Clone, Copy)]
pub(crate) struct DirectoryBookmark<'a> {
    root: Option<&'a DirectoryNode>,
    first: Option<&'a [u8]>,
    last: Option<&'a [u8]>,
    remaining: usize,
}

impl<'a> DirectoryBookmark<'a> {
    pub(crate) fn resume(self) -> DirectoryIter<'a> {
        let mut iterator = DirectoryIter {
            front: [None; ITERATOR_DEPTH], back: [None; ITERATOR_DEPTH],
            front_depth: 0, back_depth: 0, remaining: self.remaining, root: self.root,
        };
        let mut current = self.root;
        if let Some(first) = self.first {
            while let Some(node) = current {
                if node.name.as_slice() >= first {
                    iterator.front[iterator.front_depth] = Some(node);
                    iterator.front_depth += 1;
                    current = node.left.as_deref();
                } else { current = node.right.as_deref(); }
            }
        }
        current = self.root;
        if let Some(last) = self.last {
            while let Some(node) = current {
                if node.name.as_slice() <= last {
                    iterator.back[iterator.back_depth] = Some(node);
                    iterator.back_depth += 1;
                    current = node.right.as_deref();
                } else { current = node.left.as_deref(); }
            }
        }
        iterator
    }
}

impl<'a> DirectoryIter<'a> {
    pub(crate) fn bookmark(&self) -> DirectoryBookmark<'a> {
        DirectoryBookmark {
            root: self.root,
            first: self.peek_next().map(|(name, _)| name.as_slice()),
            last: if self.remaining == 0 { None }
                else { self.back[self.back_depth - 1].map(|node| node.name.as_slice()) },
            remaining: self.remaining,
        }
    }

    fn push_left(&mut self, mut node: Option<&'a DirectoryNode>) {
        while let Some(current) = node {
            self.front[self.front_depth] = Some(current);
            self.front_depth += 1;
            node = current.left.as_deref();
        }
    }

    fn push_right(&mut self, mut node: Option<&'a DirectoryNode>) {
        while let Some(current) = node {
            self.back[self.back_depth] = Some(current);
            self.back_depth += 1;
            node = current.right.as_deref();
        }
    }

    pub(crate) fn peek_next(&self) -> Option<(&'a Vec<u8>, &'a u32)> {
        if self.remaining == 0 { return None; }
        let node = self.front[self.front_depth - 1]?;
        Some((&node.name, &node.inode))
    }
}

impl<'a> Iterator for DirectoryIter<'a> {
    type Item = (&'a Vec<u8>, &'a u32);

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 { return None; }
        self.front_depth -= 1;
        let node = self.front[self.front_depth].take().expect("directory iterator front missing");
        self.push_left(node.right.as_deref());
        self.remaining -= 1;
        Some((&node.name, &node.inode))
    }

    fn size_hint(&self) -> (usize, Option<usize>) { (self.remaining, Some(self.remaining)) }
}

impl DoubleEndedIterator for DirectoryIter<'_> {
    fn next_back(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 { return None; }
        self.back_depth -= 1;
        let node = self.back[self.back_depth].take().expect("directory iterator back missing");
        self.push_right(node.left.as_deref());
        self.remaining -= 1;
        Some((&node.name, &node.inode))
    }
}

impl ExactSizeIterator for DirectoryIter<'_> {}
impl FusedIterator for DirectoryIter<'_> {}

impl<'a> IntoIterator for &'a DirectoryEntries<'_> {
    type Item = (&'a Vec<u8>, &'a u32);
    type IntoIter = DirectoryIter<'a>;
    fn into_iter(self) -> Self::IntoIter { self.iter() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::collections::BTreeMap;

    fn verify(root: &Link, minimum: Option<&[u8]>, maximum: Option<&[u8]>) -> (usize, u8) {
        let Some(node) = root else { return (0, 0) };
        assert!(minimum.is_none_or(|minimum| minimum < node.name.as_slice()));
        assert!(maximum.is_none_or(|maximum| node.name.as_slice() < maximum));
        let (left_count, left_height) = verify(&node.left, minimum, Some(&node.name));
        let (right_count, right_height) = verify(&node.right, Some(&node.name), maximum);
        assert!(left_height.abs_diff(right_height) <= 1);
        assert_eq!(node.height, 1 + left_height.max(right_height));
        assert!(usize::from(node.height) < ITERATOR_DEPTH);
        (1 + left_count + right_count, node.height)
    }

    fn check(entries: &DirectoryEntries<'_>, expected: &BTreeMap<Vec<u8>, u32>) {
        assert_eq!(verify(&entries.root, None, None).0, entries.len());
        assert_eq!(entries.len(), expected.len());
        assert_eq!(entries.iter().collect::<Vec<_>>(), expected.iter().collect::<Vec<_>>());
        assert_eq!(entries.iter().rev().collect::<Vec<_>>(), expected.iter().rev().collect::<Vec<_>>());
        let mut actual = entries.iter();
        let mut reference = expected.iter();
        for index in 0..expected.len() {
            assert_eq!(actual.len(), reference.len());
            assert_eq!(actual.peek_next(), reference.clone().next());
            assert_eq!(actual.clone().collect::<Vec<_>>(), reference.clone().collect::<Vec<_>>());
            assert_eq!(actual.bookmark().resume().collect::<Vec<_>>(), reference.clone().collect::<Vec<_>>());
            if index % 2 == 0 { assert_eq!(actual.next(), reference.next()); }
            else { assert_eq!(actual.next_back(), reference.next_back()); }
        }
        assert_eq!(actual.next(), None);
        assert_eq!(actual.next_back(), None);
        assert_eq!(actual.peek_next(), None);
        assert_eq!(actual.len(), 0);
        assert_eq!(actual.bookmark().resume().next(), None);
    }

    #[test]
    fn sorted_and_reverse_insert_delete_and_successor_match_the_ordered_contract() {
        for reverse in [false, true] {
            let budget = MetadataBudget::new(4 * 1024 * 1024);
            let mut entries = DirectoryEntries::with_budget(&budget);
            let mut expected = BTreeMap::new();
            for index in 0..512u32 {
                let number = if reverse { 511 - index } else { index };
                let name = number.to_be_bytes();
                assert_eq!(entries.try_insert(&name, number), Ok(expected.insert(name.to_vec(), number)));
                verify(&entries.root, None, None);
            }
            check(&entries, &expected);
            for index in 0..512u32 {
                let name = index.to_be_bytes();
                assert_eq!(entries.get(&name), expected.get(name.as_slice()));
                assert_eq!(entries.next_after(&name), expected.range::<[u8], _>(
                    (core::ops::Bound::Excluded(name.as_slice()), core::ops::Bound::Unbounded)).next());
                if index % 2 == 0 {
                    assert_eq!(entries.remove(&name), expected.remove(name.as_slice()));
                    verify(&entries.root, None, None);
                }
            }
            check(&entries, &expected);
            for index in (0..512u32).rev() {
                let name = index.to_be_bytes();
                assert_eq!(entries.remove(&name), expected.remove(name.as_slice()));
                verify(&entries.root, None, None);
            }
            check(&entries, &expected);
            assert_eq!(budget.usage().0, 0);
        }
    }

    #[test]
    fn mixed_mutations_and_bidirectional_cursors_match_a_standard_map() {
        let budget = MetadataBudget::new(1024 * 1024);
        let mut entries = DirectoryEntries::with_budget(&budget);
        let mut expected = BTreeMap::new();
        let mut random = 0x7a4b_f38du32;
        for step in 0..6000u32 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let name = (random % 256).to_be_bytes();
            match random % 4 {
                0 => assert_eq!(entries.remove(&name), expected.remove(name.as_slice())),
                1 if expected.contains_key(name.as_slice()) => {
                    entries.replace_existing(&name, step);
                    expected.insert(name.to_vec(), step);
                }
                _ => assert_eq!(entries.try_insert(&name, step), Ok(expected.insert(name.to_vec(), step))),
            }
            verify(&entries.root, None, None);
            if step % 251 == 0 { check(&entries, &expected); }
        }
        check(&entries, &expected);
        assert_eq!(budget.usage().0, entries.len() * (DIRENT_MODEL_BYTES + 8));
        drop(entries);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn node_allocation_failure_releases_name_and_both_admission_classes() {
        unsafe fn exhausted(_: Layout) -> *mut u8 { core::ptr::null_mut() }
        let budget = MetadataBudget::new(4096);
        let mut entries = DirectoryEntries::with_budget(&budget);
        entries.try_insert(b"existing", 3).unwrap();
        let before = budget.usage().0;
        for temporary in [false, true] {
            assert!(matches!(PreparedDirectoryName::prepare_with_allocator(&budget, b"new", temporary, exhausted), Err(Errno::ENOMEM)));
            assert_eq!(budget.usage().0, before);
            assert_eq!(budget.temporary_usage(), 0);
            assert_eq!(entries.iter().collect::<Vec<_>>(), alloc::vec![(&b"existing".to_vec(), &3)]);
        }
    }

    #[test]
    fn prepared_nodes_exchange_removed_credits_without_a_publication_allocation() {
        let charge = DIRENT_MODEL_BYTES + 6;
        let budget = MetadataBudget::new(charge);
        let mut entries = DirectoryEntries::with_budget(&budget);
        entries.try_insert(b"old", 1).unwrap();
        let mut prepared = PreparedDirectoryName::new_temporary(&budget, b"new").unwrap();
        let mut removed = entries.extract_name_credit(b"old");
        budget.exchange(&mut [prepared.reservation_mut()], &mut [&mut removed]).unwrap();
        entries.remove_prepared(b"old", removed);
        entries.insert_prepared(prepared, 2);
        assert_eq!(entries.get(b"old"), None);
        assert_eq!(entries.get(b"new"), Some(&2));
        assert_eq!(budget.usage(), (charge, charge));
        assert_eq!(budget.temporary_usage(), 0);
    }

    #[test]
    fn prepared_names_hold_credits_until_publication_or_abort() {
        let budget = MetadataBudget::new(2 * (DIRENT_MODEL_BYTES + 2));
        let mut entries = DirectoryEntries::with_budget(&budget);
        let prepared = PreparedDirectoryName::new(&budget, b"a").unwrap();
        assert_eq!(budget.usage().0, DIRENT_MODEL_BYTES + 2);
        assert!(entries.is_empty());
        entries.insert_prepared(prepared, 7);
        let replacement = PreparedDirectoryName::new(&budget, b"a").unwrap();
        assert_eq!(entries.insert_prepared(replacement, 8), Some(7));
        assert_eq!(budget.usage().0, DIRENT_MODEL_BYTES + 2);
        assert_eq!(entries.remove(b"a"), Some(8));
        assert_eq!(budget.usage().0, 0);
        drop(PreparedDirectoryName::new(&budget, b"b").unwrap());
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn exhausted_admission_preserves_the_namespace_and_order() {
        let budget = MetadataBudget::new(2 * (DIRENT_MODEL_BYTES + 2));
        let mut entries = DirectoryEntries::with_budget(&budget);
        entries.try_insert(b"z", 9).unwrap();
        entries.try_insert(b"a", 1).unwrap();
        assert_eq!(entries.try_insert(b"b", 2), Err(Errno::ENOMEM));
        assert_eq!(entries.keys().map(Vec::as_slice).collect::<Vec<_>>(), [b"a", b"z"]);
        entries.remove(b"z");
        entries.try_insert(b"b", 2).unwrap();
        assert_eq!(entries.get(b"a".as_slice()), Some(&1));
    }
}
