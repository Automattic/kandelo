//! Machine-wide POSIX advisory file-lock state.
//!
//! The kernel's allocator does not reclaim individual allocations.  Keeping
//! every normalized record in one geometrically-grown, high-water `Vec`
//! therefore bounds allocator use while a file-first ordering still gives
//! `O(log n + k)` lookup (`k` is the number of records for one file).

extern crate alloc;

use alloc::vec::Vec;
use core::cmp::Ordering;

use wasm_posix_shared::Errno;

/// Maximum number of normalized records retained by one machine.
pub const MAX_ADVISORY_LOCK_RECORDS: usize = 4096;

/// Stable identity of an open file description.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OfdId(pub u64);

/// Kinds of regular-file-like objects implemented inside the kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum KernelFileKind {
    MemFd,
    SyntheticRegular,
    ProcFsRegular,
}

/// Portable identity of the file object to which a lock applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FileId {
    /// Identity supplied by `host_fstat` on the live open handle.
    Host { dev: u64, ino: u64 },
    /// Identity of an in-kernel regular-file-like object.
    Kernel {
        kind: KernelFileKind,
        object_id: u64,
    },
}

/// POSIX process locks and Linux OFD/flock-style locks have different owners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LockOwner {
    Process(u32),
    OpenFileDescription(OfdId),
    /// BSD flock ownership is OFD-style but uses a namespace independent of
    /// POSIX/OFD byte-range locks, matching Linux-observable behavior.
    Flock(OfdId),
}

impl LockOwner {
    #[inline]
    fn conflicts_in_namespace(self, other: Self) -> bool {
        matches!(self, Self::Flock(_)) == matches!(other, Self::Flock(_))
    }
}

/// A stored record is always a read or write lock; unlock is an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AdvisoryLockType {
    Read,
    Write,
}

/// Exclusive endpoint of a normalized half-open lock range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LockRangeEnd {
    Offset(i64),
    Eof,
}

/// Normalized, absolute, non-empty half-open byte range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LockRange {
    pub start: i64,
    pub end: LockRangeEnd,
}

impl LockRange {
    /// Normalize a POSIX `struct flock` start/length after resolving whence.
    ///
    /// * positive length: `[start, start + len)`
    /// * zero length: `[start, EOF)`
    /// * negative length: `[start + len, start)`
    pub fn normalize(start: i64, len: i64) -> Result<Self, Errno> {
        if start < 0 {
            return Err(Errno::EINVAL);
        }
        if len == 0 {
            return Ok(Self {
                start,
                end: LockRangeEnd::Eof,
            });
        }
        if len > 0 {
            let end = start.checked_add(len).ok_or(Errno::EOVERFLOW)?;
            return Ok(Self {
                start,
                end: LockRangeEnd::Offset(end),
            });
        }

        let normalized_start = start.checked_add(len).ok_or(Errno::EOVERFLOW)?;
        if normalized_start < 0 {
            return Err(Errno::EINVAL);
        }
        Ok(Self {
            start: normalized_start,
            end: LockRangeEnd::Offset(start),
        })
    }

    #[inline]
    fn end_after(&self, start: i64) -> bool {
        match self.end {
            LockRangeEnd::Offset(end) => end > start,
            LockRangeEnd::Eof => true,
        }
    }

    #[inline]
    fn start_before_end(start: i64, end: LockRangeEnd) -> bool {
        match end {
            LockRangeEnd::Offset(end) => start < end,
            LockRangeEnd::Eof => true,
        }
    }

    pub fn overlaps(self, other: Self) -> bool {
        self.end_after(other.start) && Self::start_before_end(self.start, other.end)
    }

    fn touches_or_overlaps(self, other: Self) -> bool {
        let self_before_or_at_other_end = match other.end {
            LockRangeEnd::Offset(end) => self.start <= end,
            LockRangeEnd::Eof => true,
        };
        let other_before_or_at_self_end = match self.end {
            LockRangeEnd::Offset(end) => other.start <= end,
            LockRangeEnd::Eof => true,
        };
        self_before_or_at_other_end && other_before_or_at_self_end
    }

    fn union(self, other: Self) -> Self {
        Self {
            start: self.start.min(other.start),
            end: self.end.max(other.end),
        }
    }

    /// Convert a normalized range back to `l_len` form.
    pub fn len(self) -> i64 {
        match self.end {
            LockRangeEnd::Offset(end) => end - self.start,
            LockRangeEnd::Eof => 0,
        }
    }
}

/// One normalized lock record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockRecord {
    pub file: FileId,
    pub owner: LockOwner,
    pub lock_type: AdvisoryLockType,
    pub range: LockRange,
}

fn record_cmp(left: &LockRecord, right: &LockRecord) -> Ordering {
    left.file
        .cmp(&right.file)
        .then_with(|| left.range.cmp(&right.range))
        .then_with(|| left.owner.cmp(&right.owner))
        .then_with(|| left.lock_type.cmp(&right.lock_type))
}

/// Result metadata used to decide whether parked waiters should be retried.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LockMutation {
    pub changed: bool,
    pub may_unblock: bool,
}

/// The sole advisory-lock authority for a Kandelo machine.
pub struct AdvisoryLockManager {
    records: Vec<LockRecord>,
}

impl AdvisoryLockManager {
    pub const fn new() -> Self {
        Self {
            records: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    #[cfg(test)]
    pub fn capacity(&self) -> usize {
        self.records.capacity()
    }

    #[cfg(test)]
    pub fn records(&self) -> &[LockRecord] {
        &self.records
    }

    /// Find the contiguous slice belonging to one file without inspecting
    /// records belonging to unrelated files.
    fn file_bounds(&self, file: FileId) -> (usize, usize) {
        let start = self.records.partition_point(|record| record.file < file);
        let end = self.records[start..].partition_point(|record| record.file == file) + start;
        (start, end)
    }

    /// Return the deterministic first blocker in file/range/owner order.
    pub fn get_blocking_lock(
        &self,
        file: FileId,
        owner: LockOwner,
        lock_type: AdvisoryLockType,
        range: LockRange,
    ) -> Option<LockRecord> {
        let (start, end) = self.file_bounds(file);
        self.records[start..end].iter().copied().find(|record| {
            record.owner != owner
                && record.owner.conflicts_in_namespace(owner)
                && record.range.overlaps(range)
                && (record.lock_type == AdvisoryLockType::Write
                    || lock_type == AdvisoryLockType::Write)
        })
    }

    /// Return the current whole-file flock mode for one open description.
    /// Flock records have their own namespace and are always coalesced to a
    /// single `[0, EOF)` record, so this lookup is unambiguous.
    pub fn flock_type(&self, file: FileId, ofd_id: OfdId) -> Option<AdvisoryLockType> {
        let (start, end) = self.file_bounds(file);
        self.records[start..end]
            .iter()
            .find(|record| record.owner == LockOwner::Flock(ofd_id))
            .map(|record| record.lock_type)
    }

    /// Apply a normalized set or unlock operation atomically.
    ///
    /// `None` is unlock.  All conflict, logical-capacity, and allocation
    /// checks finish before the record vector is mutated.
    pub fn set_lock(
        &mut self,
        file: FileId,
        owner: LockOwner,
        lock_type: Option<AdvisoryLockType>,
        requested: LockRange,
    ) -> Result<LockMutation, Errno> {
        let (file_start, file_end) = self.file_bounds(file);

        // POSIX conflict takes precedence over resource exhaustion.
        if let Some(requested_type) = lock_type {
            if self.records[file_start..file_end].iter().any(|record| {
                record.owner != owner
                    && record.owner.conflicts_in_namespace(owner)
                    && record.range.overlaps(requested)
                    && (record.lock_type == AdvisoryLockType::Write
                        || requested_type == AdvisoryLockType::Write)
            }) {
                return Err(Errno::EAGAIN);
            }
        }

        // A contiguous request can leave at most one left and one right
        // fragment because records belonging to one owner never overlap.
        let mut left_fragment: Option<LockRecord> = None;
        let mut right_fragment: Option<LockRecord> = None;
        let mut merged_request = requested;
        let mut type_changed = false;

        for record in self.records[file_start..file_end].iter().copied() {
            if record.owner != owner || !record.range.overlaps(requested) {
                continue;
            }

            if record.range.start < requested.start {
                let fragment = LockRecord {
                    range: LockRange {
                        start: record.range.start,
                        end: LockRangeEnd::Offset(requested.start),
                    },
                    ..record
                };
                if lock_type == Some(record.lock_type) {
                    merged_request = merged_request.union(fragment.range);
                } else {
                    left_fragment = Some(fragment);
                }
            }

            if requested.end < record.range.end {
                let LockRangeEnd::Offset(right_start) = requested.end else {
                    unreachable!("EOF cannot precede another range endpoint");
                };
                let fragment = LockRecord {
                    range: LockRange {
                        start: right_start,
                        end: record.range.end,
                    },
                    ..record
                };
                if lock_type == Some(record.lock_type) {
                    merged_request = merged_request.union(fragment.range);
                } else {
                    right_fragment = Some(fragment);
                }
            }

            if let Some(requested_type) = lock_type {
                type_changed |= record.lock_type != requested_type;
            }
        }

        // Coalesce with equal-owner/equal-type neighbours.  Repeating the
        // file-local scan handles a request that bridges records on both
        // sides without allocating a temporary collection.
        if let Some(requested_type) = lock_type {
            loop {
                let before = merged_request;
                for record in self.records[file_start..file_end].iter().copied() {
                    if record.owner == owner
                        && record.lock_type == requested_type
                        && record.range.touches_or_overlaps(merged_request)
                    {
                        merged_request = merged_request.union(record.range);
                    }
                }
                if merged_request == before {
                    break;
                }
            }
        }

        let should_remove = |record: &LockRecord| {
            if record.owner != owner {
                return false;
            }
            if record.range.overlaps(requested) {
                return true;
            }
            match lock_type {
                Some(requested_type) => {
                    record.lock_type == requested_type
                        && record.range.touches_or_overlaps(merged_request)
                }
                None => false,
            }
        };

        let removed_count = self.records[file_start..file_end]
            .iter()
            .filter(|record| should_remove(record))
            .count();
        let piece_count = usize::from(left_fragment.is_some())
            + usize::from(lock_type.is_some())
            + usize::from(right_fragment.is_some());

        if removed_count == 0 && lock_type.is_none() {
            return Ok(LockMutation::default());
        }

        let replacement = lock_type.map(|requested_type| LockRecord {
            file,
            owner,
            lock_type: requested_type,
            range: merged_request,
        });

        // Setting a subrange to its already-effective type is a true no-op.
        if removed_count == 1
            && piece_count == 1
            && left_fragment.is_none()
            && right_fragment.is_none()
            && replacement.is_some_and(|new_record| {
                self.records[file_start..file_end]
                    .iter()
                    .find(|record| should_remove(record))
                    .is_some_and(|old_record| *old_record == new_record)
            })
        {
            return Ok(LockMutation::default());
        }

        let final_len = self
            .records
            .len()
            .checked_sub(removed_count)
            .and_then(|len| len.checked_add(piece_count))
            .ok_or(Errno::ENOLCK)?;
        if final_len > MAX_ADVISORY_LOCK_RECORDS {
            return Err(Errno::ENOLCK);
        }
        self.ensure_capacity(final_len)?;

        // Commit: compact only the target file's slice, shift the unrelated
        // suffix once, then insert the at-most-three normalized pieces.
        let mut write = file_start;
        for read in file_start..file_end {
            let record = self.records[read];
            if should_remove(&record) {
                continue;
            }
            if write != read {
                self.records[write] = record;
            }
            write += 1;
        }
        if write != file_end {
            self.records.drain(write..file_end);
        }

        if let Some(record) = left_fragment {
            self.insert_record(record);
        }
        if let Some(record) = replacement {
            self.insert_record(record);
        }
        if let Some(record) = right_fragment {
            self.insert_record(record);
        }

        debug_assert_eq!(self.records.len(), final_len);
        debug_assert!(
            self.records
                .windows(2)
                .all(|pair| record_cmp(&pair[0], &pair[1]) != Ordering::Greater)
        );

        Ok(LockMutation {
            changed: true,
            may_unblock: (lock_type.is_none() && removed_count != 0) || type_changed,
        })
    }

    /// Remove process-owned locks for one file (POSIX close semantics).
    pub fn remove_process_file(&mut self, pid: u32, file: FileId) -> LockMutation {
        self.remove_file_owner(file, LockOwner::Process(pid))
    }

    /// Remove every record for an owner on one file.
    pub fn remove_file_owner(&mut self, file: FileId, owner: LockOwner) -> LockMutation {
        let (start, end) = self.file_bounds(file);
        let mut write = start;
        for read in start..end {
            let record = self.records[read];
            if record.owner == owner {
                continue;
            }
            if write != read {
                self.records[write] = record;
            }
            write += 1;
        }
        let removed = end - write;
        if removed != 0 {
            self.records.drain(write..end);
        }
        LockMutation {
            changed: removed != 0,
            may_unblock: removed != 0,
        }
    }

    /// Remove all POSIX locks owned by a process (exit/crash semantics).
    pub fn remove_process(&mut self, pid: u32) -> LockMutation {
        self.remove_owner(LockOwner::Process(pid))
    }

    /// Remove OFD/flock locks after the last machine-wide OFD reference closes.
    pub fn remove_ofd(&mut self, ofd_id: OfdId) -> LockMutation {
        let before = self.records.len();
        self.records.retain(|record| {
            !matches!(
                record.owner,
                LockOwner::OpenFileDescription(id) | LockOwner::Flock(id) if id == ofd_id
            )
        });
        let changed = self.records.len() != before;
        LockMutation {
            changed,
            may_unblock: changed,
        }
    }

    fn remove_owner(&mut self, owner: LockOwner) -> LockMutation {
        let before = self.records.len();
        self.records.retain(|record| record.owner != owner);
        let changed = self.records.len() != before;
        LockMutation {
            changed,
            may_unblock: changed,
        }
    }

    fn insert_record(&mut self, record: LockRecord) {
        let index = self
            .records
            .binary_search_by(|existing| record_cmp(existing, &record))
            .unwrap_or_else(|index| index);
        self.records.insert(index, record);
    }

    fn ensure_capacity(&mut self, required: usize) -> Result<(), Errno> {
        if required <= self.records.capacity() {
            return Ok(());
        }
        if required > MAX_ADVISORY_LOCK_RECORDS {
            return Err(Errno::ENOLCK);
        }

        let mut target = self.records.capacity().max(4);
        while target < required {
            target = target.saturating_mul(2).min(MAX_ADVISORY_LOCK_RECORDS);
        }
        self.records
            .try_reserve_exact(target - self.records.len())
            .map_err(|_| Errno::ENOLCK)
    }
}

impl Default for AdvisoryLockManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_file(ino: u64) -> FileId {
        FileId::Host { dev: 1, ino }
    }

    fn process(pid: u32) -> LockOwner {
        LockOwner::Process(pid)
    }

    fn range(start: i64, len: i64) -> LockRange {
        LockRange::normalize(start, len).unwrap()
    }

    fn set(
        manager: &mut AdvisoryLockManager,
        file: FileId,
        owner: LockOwner,
        lock_type: AdvisoryLockType,
        start: i64,
        len: i64,
    ) -> Result<LockMutation, Errno> {
        manager.set_lock(file, owner, Some(lock_type), range(start, len))
    }

    fn fill_separated(manager: &mut AdvisoryLockManager, count: usize) {
        for index in 0..count {
            set(
                manager,
                host_file(1),
                process(1),
                AdvisoryLockType::Write,
                (index * 2) as i64,
                1,
            )
            .unwrap();
        }
    }

    #[test]
    fn grows_beyond_legacy_256_record_limit() {
        let mut manager = AdvisoryLockManager::new();
        fill_separated(&mut manager, 300);
        assert_eq!(manager.len(), 300);
        assert!(manager.capacity() >= 300);
        assert!(manager.capacity() <= MAX_ADVISORY_LOCK_RECORDS);
    }

    #[test]
    fn all_4096_separated_records_succeed_and_4097th_is_enolck() {
        let mut manager = AdvisoryLockManager::new();
        fill_separated(&mut manager, MAX_ADVISORY_LOCK_RECORDS);
        assert_eq!(manager.len(), MAX_ADVISORY_LOCK_RECORDS);
        let snapshot = manager.records().to_vec();
        assert_eq!(
            set(
                &mut manager,
                host_file(1),
                process(1),
                AdvisoryLockType::Write,
                (MAX_ADVISORY_LOCK_RECORDS * 2) as i64,
                1,
            ),
            Err(Errno::ENOLCK)
        );
        assert_eq!(manager.records(), snapshot);
    }

    #[test]
    fn capacity_is_reused_after_unlock() {
        let mut manager = AdvisoryLockManager::new();
        fill_separated(&mut manager, MAX_ADVISORY_LOCK_RECORDS);
        let high_water = manager.capacity();
        manager
            .set_lock(host_file(1), process(1), None, range(20, 1))
            .unwrap();
        assert_eq!(manager.len(), MAX_ADVISORY_LOCK_RECORDS - 1);
        set(
            &mut manager,
            host_file(1),
            process(1),
            AdvisoryLockType::Write,
            20_000,
            1,
        )
        .unwrap();
        assert_eq!(manager.len(), MAX_ADVISORY_LOCK_RECORDS);
        assert_eq!(manager.capacity(), high_water);
    }

    #[test]
    fn conflict_precedes_capacity_failure() {
        let mut manager = AdvisoryLockManager::new();
        fill_separated(&mut manager, MAX_ADVISORY_LOCK_RECORDS);
        assert_eq!(
            set(
                &mut manager,
                host_file(1),
                process(2),
                AdvisoryLockType::Write,
                0,
                1,
            ),
            Err(Errno::EAGAIN)
        );
    }

    #[test]
    fn non_growing_replacement_and_unlock_work_at_capacity() {
        let mut manager = AdvisoryLockManager::new();
        fill_separated(&mut manager, MAX_ADVISORY_LOCK_RECORDS);
        set(
            &mut manager,
            host_file(1),
            process(1),
            AdvisoryLockType::Read,
            0,
            1,
        )
        .unwrap();
        assert_eq!(manager.len(), MAX_ADVISORY_LOCK_RECORDS);
        manager
            .set_lock(host_file(1), process(1), None, range(0, 1))
            .unwrap();
        assert_eq!(manager.len(), MAX_ADVISORY_LOCK_RECORDS - 1);
    }

    #[test]
    fn split_needing_one_more_record_is_atomic_enolck() {
        let mut manager = AdvisoryLockManager::new();
        set(
            &mut manager,
            host_file(1),
            process(1),
            AdvisoryLockType::Write,
            0,
            3,
        )
        .unwrap();
        for index in 1..MAX_ADVISORY_LOCK_RECORDS {
            set(
                &mut manager,
                host_file(1),
                process(1),
                AdvisoryLockType::Write,
                (index as i64) * 2 + 2,
                1,
            )
            .unwrap();
        }
        let snapshot = manager.records().to_vec();
        assert_eq!(
            manager.set_lock(host_file(1), process(1), None, range(1, 1)),
            Err(Errno::ENOLCK)
        );
        assert_eq!(manager.records(), snapshot);
    }

    #[test]
    fn read_read_is_compatible_and_writes_conflict_at_half_open_boundaries() {
        let mut manager = AdvisoryLockManager::new();
        set(
            &mut manager,
            host_file(1),
            process(1),
            AdvisoryLockType::Read,
            10,
            10,
        )
        .unwrap();
        assert!(
            manager
                .get_blocking_lock(
                    host_file(1),
                    process(2),
                    AdvisoryLockType::Read,
                    range(10, 10),
                )
                .is_none()
        );
        assert!(
            manager
                .get_blocking_lock(
                    host_file(1),
                    process(2),
                    AdvisoryLockType::Write,
                    range(19, 1),
                )
                .is_some()
        );
        assert!(
            manager
                .get_blocking_lock(
                    host_file(1),
                    process(2),
                    AdvisoryLockType::Write,
                    range(20, 1),
                )
                .is_none()
        );
    }

    #[test]
    fn eof_and_negative_lengths_are_normalized_without_sentinels_aliasing() {
        assert_eq!(
            range(100, 0),
            LockRange {
                start: 100,
                end: LockRangeEnd::Eof
            }
        );
        assert_eq!(
            range(100, -40),
            LockRange {
                start: 60,
                end: LockRangeEnd::Offset(100)
            }
        );
        assert_eq!(LockRange::normalize(5, -6), Err(Errno::EINVAL));
        assert_eq!(LockRange::normalize(-1, 1), Err(Errno::EINVAL));
        assert_eq!(LockRange::normalize(i64::MAX, 1), Err(Errno::EOVERFLOW));

        let mut manager = AdvisoryLockManager::new();
        set(
            &mut manager,
            host_file(1),
            process(1),
            AdvisoryLockType::Write,
            100,
            0,
        )
        .unwrap();
        assert!(
            manager
                .get_blocking_lock(
                    host_file(1),
                    process(2),
                    AdvisoryLockType::Write,
                    range(i64::MAX, 0),
                )
                .is_some()
        );
    }

    #[test]
    fn replacement_splits_upgrades_downgrades_and_coalesces() {
        let mut manager = AdvisoryLockManager::new();
        let file = host_file(1);
        set(
            &mut manager,
            file,
            process(1),
            AdvisoryLockType::Read,
            0,
            100,
        )
        .unwrap();
        set(
            &mut manager,
            file,
            process(1),
            AdvisoryLockType::Write,
            25,
            50,
        )
        .unwrap();
        assert_eq!(manager.len(), 3);
        assert_eq!(manager.records()[0].range, range(0, 25));
        assert_eq!(manager.records()[1].lock_type, AdvisoryLockType::Write);
        assert_eq!(manager.records()[1].range, range(25, 50));
        assert_eq!(manager.records()[2].range, range(75, 25));

        let mutation = set(
            &mut manager,
            file,
            process(1),
            AdvisoryLockType::Read,
            25,
            50,
        )
        .unwrap();
        assert!(mutation.may_unblock);
        assert_eq!(manager.len(), 1);
        assert_eq!(manager.records()[0].range, range(0, 100));
        assert_eq!(manager.records()[0].lock_type, AdvisoryLockType::Read);
    }

    #[test]
    fn partial_unlock_preserves_both_fragments_and_coalesces_on_relock() {
        let mut manager = AdvisoryLockManager::new();
        let file = host_file(1);
        set(
            &mut manager,
            file,
            process(1),
            AdvisoryLockType::Write,
            0,
            100,
        )
        .unwrap();
        manager
            .set_lock(file, process(1), None, range(40, 20))
            .unwrap();
        assert_eq!(manager.len(), 2);
        assert_eq!(manager.records()[0].range, range(0, 40));
        assert_eq!(manager.records()[1].range, range(60, 40));
        set(
            &mut manager,
            file,
            process(1),
            AdvisoryLockType::Write,
            40,
            20,
        )
        .unwrap();
        assert_eq!(manager.len(), 1);
        assert_eq!(manager.records()[0].range, range(0, 100));
    }

    #[test]
    fn many_files_and_one_dense_file_keep_file_local_lookup_correct() {
        let mut manager = AdvisoryLockManager::new();
        for ino in 1..=512 {
            set(
                &mut manager,
                host_file(ino),
                process(ino as u32),
                AdvisoryLockType::Write,
                0,
                1,
            )
            .unwrap();
        }
        for index in 0..512 {
            set(
                &mut manager,
                host_file(10_000),
                process(1),
                AdvisoryLockType::Read,
                (index * 2) as i64,
                1,
            )
            .unwrap();
        }
        assert!(
            manager
                .get_blocking_lock(
                    host_file(400),
                    process(999),
                    AdvisoryLockType::Write,
                    range(0, 1),
                )
                .is_some()
        );
        assert!(
            manager
                .get_blocking_lock(
                    host_file(10_000),
                    process(2),
                    AdvisoryLockType::Write,
                    range(700, 1),
                )
                .is_some()
        );
        assert!(
            manager
                .get_blocking_lock(
                    host_file(9_999),
                    process(2),
                    AdvisoryLockType::Write,
                    range(0, 1),
                )
                .is_none()
        );
    }

    #[test]
    fn cleanup_by_pid_file_and_ofd_is_precise() {
        let mut manager = AdvisoryLockManager::new();
        let file1 = host_file(1);
        let file2 = host_file(2);
        let ofd = OfdId(77);
        set(
            &mut manager,
            file1,
            process(1),
            AdvisoryLockType::Read,
            0,
            1,
        )
        .unwrap();
        set(
            &mut manager,
            file2,
            process(1),
            AdvisoryLockType::Read,
            0,
            1,
        )
        .unwrap();
        set(
            &mut manager,
            file1,
            process(2),
            AdvisoryLockType::Read,
            0,
            1,
        )
        .unwrap();
        set(
            &mut manager,
            file1,
            LockOwner::OpenFileDescription(ofd),
            AdvisoryLockType::Read,
            0,
            1,
        )
        .unwrap();

        assert!(manager.remove_process_file(1, file1).changed);
        assert_eq!(manager.len(), 3);
        assert!(manager.remove_process(1).changed);
        assert_eq!(manager.len(), 2);
        assert!(manager.remove_ofd(ofd).changed);
        assert_eq!(manager.len(), 1);
        assert_eq!(manager.records()[0].owner, process(2));
    }

    #[test]
    fn deterministic_blocker_reports_lowest_normalized_range() {
        let mut manager = AdvisoryLockManager::new();
        let file = host_file(1);
        set(
            &mut manager,
            file,
            process(20),
            AdvisoryLockType::Read,
            20,
            10,
        )
        .unwrap();
        set(
            &mut manager,
            file,
            process(10),
            AdvisoryLockType::Read,
            10,
            10,
        )
        .unwrap();
        let blocker = manager
            .get_blocking_lock(file, process(30), AdvisoryLockType::Write, range(0, 100))
            .unwrap();
        assert_eq!(blocker.owner, process(10));
        assert_eq!(blocker.range, range(10, 10));
    }

    #[test]
    fn flock_has_an_independent_namespace_but_ofd_lifetime_cleanup() {
        let mut manager = AdvisoryLockManager::new();
        let file = host_file(1);
        let ofd = OfdId(41);
        set(
            &mut manager,
            file,
            LockOwner::OpenFileDescription(ofd),
            AdvisoryLockType::Write,
            0,
            1,
        )
        .unwrap();
        set(
            &mut manager,
            file,
            LockOwner::Flock(ofd),
            AdvisoryLockType::Write,
            0,
            1,
        )
        .unwrap();
        assert_eq!(manager.len(), 2);

        manager
            .set_lock(file, LockOwner::Flock(ofd), None, range(0, 0))
            .unwrap();
        assert_eq!(manager.len(), 1);
        assert_eq!(
            manager.records()[0].owner,
            LockOwner::OpenFileDescription(ofd)
        );

        set(
            &mut manager,
            file,
            LockOwner::Flock(ofd),
            AdvisoryLockType::Read,
            0,
            0,
        )
        .unwrap();
        assert!(manager.remove_ofd(ofd).changed);
        assert!(manager.is_empty());
    }
}
