use alloc::alloc::alloc;
use alloc::boxed::Box;
use alloc::vec::Vec;
use core::alloc::Layout;
use core::cmp::Ordering;
use wasm_posix_shared::Errno;
use crate::metadata_budget::{MetadataBudget, MetadataReservation, ROOTFS_METADATA};
use crate::persistent_overlay::OverlayKey;

type Link<'a> = Option<Box<Node<'a>>>;

struct Node<'a> {
    key: OverlayKey,
    left: Link<'a>,
    right: Link<'a>,
    height: u8,
    retain_after_validation: bool,
    _reservation: MetadataReservation<'a>,
}

pub(crate) struct PreparedRetainedDirent<'a>(Box<Node<'a>>);

impl<'a> PreparedRetainedDirent<'a> {
    pub(crate) fn reservation_mut(&mut self) -> &mut MetadataReservation<'a> { &mut self.0._reservation }
}

pub(crate) struct RetainedDirents<'a> {
    root: Link<'a>,
    budget: &'a MetadataBudget,
}

fn allocate_node<'a>(node: Node<'a>, allocator: unsafe fn(Layout) -> *mut u8) -> Result<Box<Node<'a>>, Errno> {
    let allocation = unsafe { allocator(Layout::new::<Node<'a>>()) }.cast::<Node<'a>>();
    if allocation.is_null() { return Err(Errno::ENOMEM); }
    Ok(unsafe {
        allocation.write(node);
        Box::from_raw(allocation)
    })
}

fn height(link: &Link<'_>) -> u8 { link.as_ref().map_or(0, |node| node.height) }

fn update(node: &mut Node<'_>) {
    node.height = 1 + height(&node.left).max(height(&node.right));
}

fn rotate_left<'a>(mut root: Box<Node<'a>>) -> Box<Node<'a>> {
    let mut pivot = root.right.take().expect("AVL right child missing");
    root.right = pivot.left.take();
    update(&mut root);
    pivot.left = Some(root);
    update(&mut pivot);
    pivot
}

fn rotate_right<'a>(mut root: Box<Node<'a>>) -> Box<Node<'a>> {
    let mut pivot = root.left.take().expect("AVL left child missing");
    root.left = pivot.right.take();
    update(&mut root);
    pivot.right = Some(root);
    update(&mut pivot);
    pivot
}

fn balance<'a>(mut root: Box<Node<'a>>) -> Box<Node<'a>> {
    update(&mut root);
    if height(&root.left) > height(&root.right) + 1 {
        let child = root.left.as_ref().expect("AVL left child missing");
        if height(&child.right) > height(&child.left) {
            root.left = root.left.take().map(rotate_left);
        }
        rotate_right(root)
    } else if height(&root.right) > height(&root.left) + 1 {
        let child = root.right.as_ref().expect("AVL right child missing");
        if height(&child.left) > height(&child.right) {
            root.right = root.right.take().map(rotate_right);
        }
        rotate_left(root)
    } else { root }
}

fn insert<'a>(root: Link<'a>, prepared: Box<Node<'a>>) -> Box<Node<'a>> {
    let Some(mut root) = root else { return prepared };
    match prepared.key.cmp(&root.key) {
        Ordering::Less => root.left = Some(insert(root.left.take(), prepared)),
        Ordering::Greater => root.right = Some(insert(root.right.take(), prepared)),
        Ordering::Equal => return root,
    }
    balance(root)
}

fn join<'a>(left: Link<'a>, mut middle: Box<Node<'a>>, right: Link<'a>) -> Box<Node<'a>> {
    if height(&left) > height(&right) + 1 {
        let mut root = left.expect("AVL join left child missing");
        root.right = Some(join(root.right.take(), middle, right));
        balance(root)
    } else if height(&right) > height(&left) + 1 {
        let mut root = right.expect("AVL join right child missing");
        root.left = Some(join(left, middle, root.left.take()));
        balance(root)
    } else {
        middle.left = left;
        middle.right = right;
        update(&mut middle);
        middle
    }
}

fn take_min<'a>(mut root: Box<Node<'a>>) -> (Link<'a>, Box<Node<'a>>) {
    let Some(left) = root.left.take() else { return (root.right.take(), root) };
    let (left, minimum) = take_min(left);
    root.left = left;
    (Some(balance(root)), minimum)
}

fn retain<'a>(root: Link<'a>, keep: &mut impl FnMut(&Node<'a>) -> bool) -> Link<'a> {
    let mut root = root?;
    let left = retain(root.left.take(), keep);
    let retained = keep(&root);
    let right = retain(root.right.take(), keep);
    if retained { return Some(join(left, root, right)); }
    drop(root);
    let Some(right) = right else { return left };
    let (right, middle) = take_min(right);
    Some(join(left, middle, right))
}

impl RetainedDirents<'static> {
    pub(crate) fn new() -> Self { Self::with_budget(&ROOTFS_METADATA) }
}

impl<'a> RetainedDirents<'a> {
    fn with_budget(budget: &'a MetadataBudget) -> Self { Self { root: None, budget } }

    pub(crate) fn contains(&self, key: &OverlayKey) -> bool {
        let mut current = self.root.as_ref();
        while let Some(node) = current {
            match key.cmp(&node.key) {
                Ordering::Less => current = node.left.as_ref(),
                Ordering::Greater => current = node.right.as_ref(),
                Ordering::Equal => return true,
            }
        }
        false
    }

    pub(crate) fn prepare(&self, key: &OverlayKey) -> Result<Option<PreparedRetainedDirent<'a>>, Errno> {
        self.prepare_with_class(key, false)
    }

    pub(crate) fn prepare_temporary(&self, key: &OverlayKey) -> Result<Option<PreparedRetainedDirent<'a>>, Errno> {
        self.prepare_with_class(key, true)
    }

    fn prepare_with_class(&self, key: &OverlayKey, temporary: bool) -> Result<Option<PreparedRetainedDirent<'a>>, Errno> {
        let OverlayKey::Dirent { parent, name } = key else { return Err(Errno::EINVAL) };
        if self.contains(key) { return Ok(None); }
        let charge = |capacity: usize| capacity.checked_mul(2)
            .and_then(|bytes| bytes.checked_add(core::mem::size_of::<Node<'a>>() * 2))
            .ok_or(Errno::ENOMEM);
        let mut reservation = if temporary { self.budget.reserve_temporary(charge(name.len())?)? }
            else { self.budget.reserve(charge(name.len())?)? };
        let mut owned = Vec::new();
        owned.try_reserve_exact(name.len()).map_err(|_| Errno::ENOMEM)?;
        owned.extend_from_slice(name);
        reservation.resize(charge(owned.capacity())?)?;
        let node = Node {
            key: OverlayKey::Dirent { parent: *parent, name: owned },
            left: None, right: None, height: 1, retain_after_validation: true, _reservation: reservation,
        };
        Ok(Some(PreparedRetainedDirent(allocate_node(node, alloc)?)))
    }

    pub(crate) fn insert_prepared(&mut self, prepared: PreparedRetainedDirent<'a>) {
        self.root = Some(insert(self.root.take(), prepared.0));
    }

    pub(crate) fn try_insert(&mut self, key: &OverlayKey) -> Result<(), Errno> {
        if let Some(prepared) = self.prepare(key)? { self.insert_prepared(prepared); }
        Ok(())
    }

    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&OverlayKey) -> bool) {
        self.root = retain(self.root.take(), &mut |node| keep(&node.key));
    }

    pub(crate) fn try_retain(&mut self, mut keep: impl FnMut(&OverlayKey) -> Result<bool, Errno>) -> Result<(), Errno> {
        fn validate(root: &mut Link<'_>, keep: &mut impl FnMut(&OverlayKey) -> Result<bool, Errno>) -> Result<(), Errno> {
            if let Some(root) = root {
                validate(&mut root.left, keep)?;
                root.retain_after_validation = keep(&root.key)?;
                validate(&mut root.right, keep)?;
            }
            Ok(())
        }
        validate(&mut self.root, &mut keep)?;
        self.root = retain(self.root.take(), &mut |node| node.retain_after_validation);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn keys(&self) -> Vec<OverlayKey> {
        fn collect(root: &Link<'_>, keys: &mut Vec<OverlayKey>) {
            if let Some(root) = root {
                collect(&root.left, keys);
                keys.push(root.key.clone());
                collect(&root.right, keys);
            }
        }
        let mut keys = Vec::new();
        collect(&self.root, &mut keys);
        keys
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::collections::BTreeSet;

    fn key(number: usize) -> OverlayKey {
        OverlayKey::Dirent { parent: number as u64 % 7, name: number.to_be_bytes().to_vec() }
    }

    fn verify(root: &Link<'_>, minimum: Option<&OverlayKey>, maximum: Option<&OverlayKey>) -> u8 {
        let Some(root) = root else { return 0 };
        assert!(minimum.is_none_or(|minimum| minimum < &root.key));
        assert!(maximum.is_none_or(|maximum| &root.key < maximum));
        let left = verify(&root.left, minimum, Some(&root.key));
        let right = verify(&root.right, Some(&root.key), maximum);
        assert!(left.abs_diff(right) <= 1);
        assert_eq!(root.height, 1 + left.max(right));
        root.height
    }

    #[test]
    fn ordered_adversarial_insert_and_bulk_retain_stay_balanced() {
        for reverse in [false, true] {
            let budget = MetadataBudget::new(4 * 1024 * 1024);
            let mut tree = RetainedDirents::with_budget(&budget);
            let mut expected = BTreeSet::new();
            for number in 0..2048 {
                let key = key(if reverse { 2047 - number } else { number });
                tree.try_insert(&key).unwrap();
                expected.insert(key);
                verify(&tree.root, None, None);
            }
            assert_eq!(tree.keys(), expected.iter().cloned().collect::<Vec<_>>());
            for modulus in [2, 7, 31, 127] {
                tree.retain(|key| match key {
                    OverlayKey::Dirent { name, .. } => usize::from_be_bytes(name.as_slice().try_into().unwrap()) % modulus != 0,
                    _ => unreachable!(),
                });
                expected.retain(|key| match key {
                    OverlayKey::Dirent { name, .. } => usize::from_be_bytes(name.as_slice().try_into().unwrap()) % modulus != 0,
                    _ => unreachable!(),
                });
                verify(&tree.root, None, None);
                assert_eq!(tree.keys(), expected.iter().cloned().collect::<Vec<_>>());
                for number in 0..2048 { assert_eq!(tree.contains(&key(number)), expected.contains(&key(number))); }
            }
            tree.retain(|_| false);
            assert_eq!(budget.usage().0, 0);
        }
    }

    #[test]
    fn preparation_reserves_before_publication_and_abort_releases_everything() {
        let budget = MetadataBudget::new(4096);
        let mut tree = RetainedDirents::with_budget(&budget);
        let prepared = tree.prepare(&key(1)).unwrap().unwrap();
        let charge = budget.usage().0;
        assert!(tree.keys().is_empty());
        budget.set_limit(charge).unwrap();
        assert!(matches!(tree.prepare(&key(2)), Err(Errno::ENOMEM)));
        tree.insert_prepared(prepared);
        assert_eq!(tree.keys(), alloc::vec![key(1)]);
        assert!(tree.prepare(&key(1)).unwrap().is_none());
        assert_eq!(budget.usage().0, charge);
        tree.retain(|_| false);
        let prepared = tree.prepare(&key(2)).unwrap().unwrap();
        drop(prepared);
        assert_eq!(budget.usage().0, 0);
        budget.set_limit(charge - 1).unwrap();
        assert!(matches!(tree.prepare(&key(2)), Err(Errno::ENOMEM)));
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn allocator_exhaustion_returns_enomem_and_releases_prepared_ownership() {
        unsafe fn exhausted(_: Layout) -> *mut u8 { core::ptr::null_mut() }
        let budget = MetadataBudget::new(4096);
        let node = Node {
            key: key(1), left: None, right: None, height: 1, retain_after_validation: true,
            _reservation: budget.reserve(4096).unwrap(),
        };
        assert!(matches!(allocate_node(node, exhausted), Err(Errno::ENOMEM)));
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn fallible_pruning_validates_every_decision_before_reclaiming_any_key() {
        for rejected in 0..8 {
            let budget = MetadataBudget::new(4096);
            let mut tree = RetainedDirents::with_budget(&budget);
            for number in 0..8 { tree.try_insert(&key(number)).unwrap(); }
            let before = tree.keys();
            let usage = budget.usage().0;
            budget.set_limit(usage).unwrap();
            let mut position = 0;
            assert_eq!(tree.try_retain(|_| {
                let current = position;
                position += 1;
                if current == rejected { Err(Errno::EIO) } else { Ok(false) }
            }), Err(Errno::EIO));
            assert_eq!(tree.keys(), before);
            assert_eq!(budget.usage().0, usage);
            tree.try_retain(|candidate| Ok(candidate >= &before[4])).unwrap();
            assert_eq!(tree.keys(), before[4..]);
            assert_eq!(budget.usage().0, usage / 2);
            verify(&tree.root, None, None);
        }
    }

    #[test]
    fn duplicate_preparations_release_unused_nodes_without_changing_the_set() {
        let budget = MetadataBudget::new(4096);
        let mut tree = RetainedDirents::with_budget(&budget);
        let first = tree.prepare(&key(1)).unwrap().unwrap();
        let second = tree.prepare(&key(1)).unwrap().unwrap();
        let combined = budget.usage().0;
        tree.insert_prepared(first);
        tree.insert_prepared(second);
        assert_eq!(budget.usage().0, combined / 2);
        assert_eq!(tree.keys(), alloc::vec![key(1)]);
        drop(tree);
        assert_eq!(budget.usage().0, 0);
    }
}
