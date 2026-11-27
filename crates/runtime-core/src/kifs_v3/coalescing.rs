//! Coalesce unpublished index edits in the admitted live map. File blocks
//! still go to positioned storage during the write. Publication materializes
//! the edits into ordinary v3 pages before either root replica is updated.
use super::*;
// The key and value share one admitted allocation. Removed keys carry no value.
struct Point {
    bytes: IoBuffer<u8>,
    key_len: usize,
    present: bool,
}

impl Point {
    fn key(&self) -> &[u8] {
        &self.bytes[..self.key_len]
    }
    fn value(&self) -> Option<&[u8]> {
        self.present.then(|| &self.bytes[self.key_len..])
    }
}

#[derive(Default)]
pub(super) struct ChangeMap(IoBuffer<Point>);

impl ChangeMap {
    pub(super) fn new() -> Self {
        Self::default()
    }
    pub(super) fn len(&self) -> usize {
        self.0.len()
    }
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }
    pub(super) fn get(&self, key: &[u8]) -> Option<Option<&[u8]>> {
        self.0
            .binary_search_by(|p| p.key().cmp(key))
            .ok()
            .map(|i| self.0[i].value())
    }
    fn store(&mut self, key: &[u8], value: Option<&[u8]>) -> Result<(), Errno> {
        let mut bytes = IoBuffer::try_with_capacity(key.len() + value.map_or(0, <[u8]>::len))?;
        bytes.extend_from_slice(key);
        if let Some(v) = value {
            bytes.extend_from_slice(v);
        }
        let point = Point {
            bytes,
            key_len: key.len(),
            present: value.is_some(),
        };
        self.store_owned(point)
    }

    fn store_owned(&mut self, point: Point) -> Result<(), Errno> {
        match self.0.binary_search_by(|p| p.key().cmp(point.key())) {
            Ok(i) => self.0[i] = point,
            Err(i) => {
                self.0.try_reserve(1)?;
                self.0.insert(i, point);
            }
        }
        Ok(())
    }
    pub(super) fn merge(&mut self, newer: Self) -> Result<(), Errno> {
        // After reservation no insertion can fail partway through the syscall.
        self.0.try_reserve(newer.len())?;
        for point in newer.0 {
            match self.0.binary_search_by(|p| p.key().cmp(point.key())) {
                Ok(i) => self.0[i] = point,
                Err(i) => self.0.insert(i, point),
            }
        }
        Ok(())
    }
    fn range(&self, bounds: Bounds<'_>) -> &[Point] {
        let lo = bounds
            .after
            .map_or(0, |key| self.0.partition_point(|p| p.key() <= key));
        let hi = bounds
            .end
            .map_or(self.len(), |key| self.0.partition_point(|p| p.key() < key));
        &self.0[lo..hi]
    }
}

fn merged<'a>(older: &'a [Point], newer: &'a [Point]) -> impl Iterator<Item = &'a Point> {
    let mut old = older.iter().peekable();
    let mut new = newer.iter().peekable();
    core::iter::from_fn(move || match (old.peek(), new.peek()) {
        (Some(a), Some(b)) if a.key() < b.key() => old.next(),
        (Some(a), Some(b)) if a.key() == b.key() => {
            old.next();
            new.next()
        }
        (_, Some(_)) => new.next(),
        _ => old.next(),
    })
}

fn edit_list<'a>(older: &'a [Point], newer: &'a [Point]) -> Result<IoBuffer<Edit<'a>>, Errno> {
    let mut edits = IoBuffer::try_with_capacity(older.len() + newer.len())?;
    for point in merged(older, newer) {
        edits.push(Edit::point(point.key(), point.value()));
    }
    Ok(edits)
}

const MAX_KEYS: usize = 2048;

#[derive(Default)]
pub(super) struct Epoch {
    pub enabled: bool,
    pub points: ChangeMap,
    pub base_usage: Option<Usage>,
}

impl Epoch {
    pub(super) fn publication_limit(&self) -> u64 {
        if !self.enabled {
            return 256;
        }
        // Keep the operation and edit counts bounded. Give staged file bytes
        // room to accumulate before automatic publication builds the index.
        1024
    }
}

impl<S: PositionedStorage> Tree<'_, S> {
    pub(super) fn visit_merged(
        &mut self,
        reference: PageRef,
        level: u8,
        first: Option<&[u8]>,
        bounds: Bounds<'_>,
        visit: &mut impl FnMut(&mut S, u64, &[u8], &[u8]) -> Result<bool, Errno>,
    ) -> Result<bool, Errno> {
        // Only modified points in this bounded epoch can shadow the base.
        let local = core::mem::take(&mut self.edits);
        let base = self.base_edits.take();
        let result = (|| {
            let mut pending = merged(
                base.map_or(&[][..], |m| m.range(bounds)),
                local.range(bounds),
            )
            .peekable();
            let end = self.end;
            let completed = self.visit_base(
                reference,
                level,
                first,
                bounds,
                &mut |s, leaf, key, bytes| {
                    while pending.peek().is_some_and(|p| p.key() < key) {
                        let p = pending.next().unwrap();
                        if let Some(v) = p.value() {
                            if !visit(s, end, p.key(), v)? {
                                return Ok(false);
                            }
                        }
                    }
                    if pending.peek().is_some_and(|p| p.key() == key) {
                        let p = pending.next().unwrap();
                        return p.value().map_or(Ok(true), |v| visit(s, end, key, v));
                    }
                    visit(s, leaf, key, bytes)
                },
            )?;
            if completed {
                for p in pending {
                    if let Some(v) = p.value() {
                        if !visit(self.storage, end, p.key(), v)? {
                            return Ok(false);
                        }
                    }
                }
            }
            Ok(completed)
        })();
        self.base_edits = base;
        self.edits = local;
        result
    }
}

impl<S: PositionedStorage> Transaction<'_, S> {
    pub(super) fn can_stage_block_run(
        &mut self,
        inode: u64,
        first: u64,
        count: usize,
        has_inode_edit: bool,
    ) -> Result<bool, Errno> {
        let Some(base) = self.tree.base_edits else {
            return Ok(false);
        };
        if MAX_KEYS - base.len() - self.tree.edits.len() < count + usize::from(has_inode_edit) {
            return Ok(false);
        }
        let previous = EncodedKey::new(Key::Block {
            inode,
            block: first.saturating_sub(1),
        })?;
        let after = if first == 0 {
            &previous.bytes()[..9]
        } else {
            previous.bytes()
        };
        let end = EncodedKey::new(Key::Block {
            inode,
            block: first.checked_add(count as u64).ok_or(Errno::EFBIG)?,
        })?;
        // Validate against the live index, including pending removals. An
        // append beyond EOF must not replace an existing live block reference.
        match self.tree.visit(
            self.next.root,
            self.next.level,
            None,
            Bounds {
                after: Some(after),
                end: Some(end.bytes()),
            },
            &mut |_, _, _, _| Ok(false),
        ) {
            Ok(true) => Ok(true),
            Ok(false) => Err(Errno::EIO),
            Err(Errno::ENOMEM) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(super) fn stage_new_block_run(
        &mut self,
        inode: Option<Edit<'_>>,
        blocks: &[Edit<'_>],
    ) -> Result<(), Errno> {
        if let Some(edit) = inode {
            self.stage_point(edit.key, edit.value, &mut [0; MAX_VALUE_BYTES])?;
        }
        for block in blocks {
            let value = block.value.ok_or(Errno::EIO)?;
            self.tree.edits.store(block.key, Some(value))?;
            self.next.usage.metadata_bytes += record_bytes(block.key, value.len());
            self.next.usage.data_blocks += 1;
        }
        Ok(())
    }

    pub(super) fn stage_edits(&mut self, edits: &[Edit<'_>]) -> Result<(), Errno> {
        let mut old = [0; MAX_VALUE_BYTES];
        for (i, edit) in edits.iter().enumerate() {
            let room =
                MAX_KEYS - self.tree.edits.len() - self.tree.base_edits.map_or(0, ChangeMap::len);
            if room == 0 {
                self.fold_private()?;
                return self.apply_edits(&edits[i..]);
            }
            if let Some(end) = edit.end {
                let mut keys = IoBuffer::new();
                let fits = self.tree.visit(
                    self.next.root,
                    self.next.level,
                    None,
                    Bounds {
                        after: Some(edit.key),
                        end: Some(end),
                    },
                    &mut |_, _, key, value| {
                        if keys.len() + 1 >= room {
                            return Ok(false);
                        }
                        let point = Point {
                            bytes: IoBuffer::copy_from(key)?,
                            key_len: key.len(),
                            present: false,
                        };
                        keys.try_push((point, value.len()))?;
                        Ok(true)
                    },
                )?;
                if !fits {
                    self.fold_private()?;
                    return self.apply_edits(&edits[i..]);
                }
                // Whole-inode block and attribute ranges start at a
                // prefix which cannot itself name a record. A truncation
                // may instead start at a real block key.
                let is_prefix = edit.key.len() == 9 && matches!(edit.key[0], 3 | 4);
                if !is_prefix {
                    self.stage_point(edit.key, None, &mut old)?;
                }
                for (point, value_len) in keys {
                    let key = point.key();
                    self.next.usage.remove_record(key, value_len, key[0] == 3)?;
                    self.tree.edits.store_owned(point)?;
                }
            } else {
                self.stage_point(edit.key, edit.value, &mut old)?;
            }
        }
        Ok(())
    }

    fn fold_private(&mut self) -> Result<(), Errno> {
        let base = self.tree.base_edits.take().ok_or(Errno::EIO)?;
        let newer = core::mem::take(&mut self.tree.edits);
        let edits = edit_list(&base.0, &newer.0)?;
        self.tree.records = None;
        let expected = self.next.usage;
        self.next.usage = self.tree.base_usage;
        if !edits.is_empty() {
            self.apply_edits(&edits)?;
        }
        if self.next.usage != expected {
            return Err(Errno::EIO);
        }
        Ok(())
    }

    fn stage_point(
        &mut self,
        key: &[u8],
        value: Option<&[u8]>,
        old: &mut [u8],
    ) -> Result<(), Errno> {
        let existing = self
            .tree
            .lookup(self.next, key, old)?
            .map(|(n, _)| &old[..n]);
        if existing == value {
            return Ok(());
        }
        let is_block = key[0] == 3;
        if let Some(previous) = existing {
            self.next
                .usage
                .remove_record(key, previous.len(), is_block)?;
        }
        if let Some(new) = value {
            self.next.usage.metadata_bytes += record_bytes(key, new.len());
            self.next.usage.data_blocks += u64::from(is_block);
        }
        self.tree.edits.store(key, value)
    }
}

impl<S: PositionedStorage> KifsVolume<S> {
    pub(super) fn publish_coalesced(&mut self) -> Result<(), Errno> {
        let mut root = self.live;
        root.usage = self.epoch.base_usage.ok_or(Errno::EIO)?;
        // On any failure before publication restore the map. A retry overwrites
        // the failed build starting at the same unpublished end.
        let points = core::mem::take(&mut self.epoch.points);
        let result = (|| {
            let edits = edit_list(&points.0, &[])?;
            let mut tree = self.tree();
            tree.base_edits = None;
            tree.records = None;
            tree.try_append_window = true;
            let mut tx = Transaction {
                stat_changes: Default::default(),
                next: root,
                tree,
                error: None,
            };
            if !edits.is_empty() {
                tx.apply_edits(&edits)?;
            }
            if let Some(window) = &mut tx.tree.appends {
                window.drain(tx.tree.storage)?;
            }
            let mut next = tx.next;
            next.end = tx.tree.end;
            if next.usage != self.live.usage {
                return Err(Errno::EIO);
            }
            self.publish(next)
        })();
        if result.is_err() {
            self.epoch.points = points;
        } else {
            self.epoch.base_usage = None;
            self.records.clear();
        }
        result
    }
}
