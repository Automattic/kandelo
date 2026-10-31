use alloc::vec::Vec;
use core::ops::Deref;
use spin::Mutex;
use wasm_posix_shared::Errno;

pub(crate) const DEFAULT_ROOTFS_METADATA_BYTES: usize = 64 * 1024 * 1024;
pub(crate) static FILESYSTEM_ADMISSION: AdmissionTracker = AdmissionTracker::new();
pub(crate) static ROOTFS_METADATA: MetadataBudget = MetadataBudget::tracked(DEFAULT_ROOTFS_METADATA_BYTES, &FILESYSTEM_ADMISSION);

#[derive(Debug)]
pub(crate) struct AdmissionTracker { state: Mutex<(u128, u128)> }

impl AdmissionTracker {
    pub(crate) const fn new() -> Self { Self { state: Mutex::new((0, 0)) } }

    fn replace(&self, previous: usize, next: usize) {
        let mut state = self.state.lock();
        state.0 = state.0.checked_sub(previous as u128).expect("admission tracker underflow")
            .checked_add(next as u128).expect("admission tracker overflow");
        state.1 = state.1.max(state.0);
    }

    pub(crate) fn snapshot(&self) -> (u128, u128) { *self.state.lock() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BudgetSnapshot {
    pub limit: usize,
    pub live: usize,
    pub temporary: usize,
    pub peak_live: usize,
    pub peak_temporary: usize,
    pub peak_total: usize,
}

#[derive(Debug)]
struct BudgetState { limit: usize, used: usize, temporary: usize, peak_live: usize, peak_temporary: usize, peak_total: usize }

#[derive(Debug)]
pub(crate) struct MetadataBudget { state: Mutex<BudgetState>, tracker: Option<&'static AdmissionTracker> }

impl MetadataBudget {
    pub(crate) const fn new(limit: usize) -> Self {
        Self { state: Mutex::new(BudgetState { limit, used: 0, temporary: 0,
            peak_live: 0, peak_temporary: 0, peak_total: 0 }), tracker: None }
    }

    pub(crate) const fn tracked(limit: usize, tracker: &'static AdmissionTracker) -> Self {
        Self { tracker: Some(tracker), ..Self::new(limit) }
    }

    fn record(&self, state: &mut BudgetState, previous: usize) {
        let total = state.used.checked_add(state.temporary).expect("admission usage overflow");
        state.peak_live = state.peak_live.max(state.used);
        state.peak_temporary = state.peak_temporary.max(state.temporary);
        state.peak_total = state.peak_total.max(total);
        if previous != total {
            if let Some(tracker) = self.tracker { tracker.replace(previous, total); }
        }
    }

    pub(crate) fn snapshot(&self) -> BudgetSnapshot {
        let state = self.state.lock();
        BudgetSnapshot { limit: state.limit, live: state.used, temporary: state.temporary,
            peak_live: state.peak_live, peak_temporary: state.peak_temporary, peak_total: state.peak_total }
    }

    pub(crate) fn reserve(&self, bytes: usize) -> Result<MetadataReservation<'_>, Errno> {
        let mut state = self.state.lock();
        let used = state.used.checked_add(bytes).ok_or(Errno::ENOMEM)?;
        used.checked_add(state.temporary).ok_or(Errno::ENOMEM)?;
        if used > state.limit { return Err(Errno::ENOMEM); }
        let previous = state.used + state.temporary;
        state.used = used;
        self.record(&mut state, previous);
        Ok(MetadataReservation { budget: self, bytes, temporary: false })
    }

    pub(crate) const fn empty(&self) -> MetadataReservation<'_> {
        MetadataReservation { budget: self, bytes: 0, temporary: false }
    }

    pub(crate) fn reserve_temporary(&self, bytes: usize) -> Result<MetadataReservation<'_>, Errno> {
        let mut state = self.state.lock();
        let used = state.temporary.checked_add(bytes).ok_or(Errno::ENOMEM)?;
        used.checked_add(state.used).ok_or(Errno::ENOMEM)?;
        if used > state.limit.saturating_mul(2) { return Err(Errno::ENOMEM); }
        let previous = state.used + state.temporary;
        state.temporary = used;
        self.record(&mut state, previous);
        Ok(MetadataReservation { budget: self, bytes, temporary: true })
    }

    pub(crate) fn set_limit(&self, limit: usize) -> Result<(), Errno> {
        let mut state = self.state.lock();
        if state.used > limit || state.temporary > limit.saturating_mul(2) { return Err(Errno::ENOMEM); }
        state.limit = limit;
        Ok(())
    }

    pub(crate) fn usage(&self) -> (usize, usize) {
        let state = self.state.lock();
        (state.used, state.limit)
    }

    #[cfg(test)]
    pub(crate) fn temporary_usage(&self) -> usize { self.state.lock().temporary }

    pub(crate) fn exchange(
        &self,
        promote: &mut [&mut MetadataReservation<'_>],
        demote: &mut [&mut MetadataReservation<'_>],
    ) -> Result<(), Errno> {
        let total = |reservations: &[&mut MetadataReservation<'_>], temporary| {
            reservations.iter().try_fold(0usize, |bytes, reservation| {
                if !core::ptr::eq(self, reservation.budget) || reservation.temporary != temporary {
                    return Err(Errno::EIO);
                }
                bytes.checked_add(reservation.bytes).ok_or(Errno::ENOMEM)
            })
        };
        let promoted = total(promote, true)?;
        let demoted = total(demote, false)?;
        let mut state = self.state.lock();
        let used = state.used.checked_sub(demoted).ok_or(Errno::EIO)?
            .checked_add(promoted).ok_or(Errno::ENOMEM)?;
        let temporary = state.temporary.checked_sub(promoted).ok_or(Errno::EIO)?
            .checked_add(demoted).ok_or(Errno::ENOMEM)?;
        used.checked_add(temporary).ok_or(Errno::ENOMEM)?;
        if used > state.limit || temporary > state.limit.saturating_mul(2) {
            return Err(Errno::ENOMEM);
        }
        let previous = state.used + state.temporary;
        state.used = used;
        state.temporary = temporary;
        self.record(&mut state, previous);
        for reservation in promote { reservation.temporary = false; }
        for reservation in demote { reservation.temporary = true; }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct MetadataReservation<'a> { budget: &'a MetadataBudget, bytes: usize, temporary: bool }

impl<'a> MetadataReservation<'a> {
    pub(crate) fn bytes(&self) -> usize { self.bytes }
    pub(crate) fn budget(&self) -> &'a MetadataBudget { self.budget }

    pub(crate) fn split(&mut self, bytes: usize) -> Self {
        self.bytes = self.bytes.checked_sub(bytes).expect("metadata reservation split underflow");
        Self { budget: self.budget, bytes, temporary: self.temporary }
    }

    pub(crate) fn resize(&mut self, bytes: usize) -> Result<(), Errno> {
        let mut state = self.budget.state.lock();
        let current = if self.temporary { state.temporary } else { state.used };
        let used = current.checked_sub(self.bytes).ok_or(Errno::EIO)?
            .checked_add(bytes).ok_or(Errno::ENOMEM)?;
        let other = if self.temporary { state.used } else { state.temporary };
        used.checked_add(other).ok_or(Errno::ENOMEM)?;
        let limit = if self.temporary { state.limit.saturating_mul(2) } else { state.limit };
        if used > limit { return Err(Errno::ENOMEM); }
        let previous = state.used + state.temporary;
        if self.temporary { state.temporary = used; } else { state.used = used; }
        self.budget.record(&mut state, previous);
        self.bytes = bytes;
        Ok(())
    }

    pub(crate) fn merge(&mut self, mut other: Self) {
        assert!(core::ptr::eq(self.budget, other.budget));
        assert_eq!(self.temporary, other.temporary);
        self.bytes = self.bytes.checked_add(other.bytes).expect("metadata reservation overflow");
        other.bytes = 0;
    }
}

impl Drop for MetadataReservation<'_> {
    fn drop(&mut self) {
        let mut state = self.budget.state.lock();
        let previous = state.used + state.temporary;
        let used = if self.temporary { &mut state.temporary } else { &mut state.used };
        *used = used.checked_sub(self.bytes).expect("metadata reservation underflow");
        self.budget.record(&mut state, previous);
    }
}

pub(crate) struct MetadataBytes<'a> { bytes: Vec<u8>, reservation: MetadataReservation<'a> }

impl<'a> MetadataBytes<'a> {
    pub(crate) fn empty(budget: &'a MetadataBudget) -> Self {
        Self { bytes: Vec::new(), reservation: budget.empty() }
    }

    pub(crate) fn copy_from(budget: &'a MetadataBudget, source: &[u8]) -> Result<Self, Errno> {
        let reservation = budget.reserve(source.len().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(source.len()).map_err(|_| Errno::ENOMEM)?;
        bytes.extend_from_slice(source);
        let mut result = Self { bytes, reservation };
        result.reservation.resize(result.bytes.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        Ok(result)
    }

    pub(crate) fn from_vec(budget: &'a MetadataBudget, bytes: Vec<u8>) -> Result<Self, Errno> {
        let reservation = budget.reserve(bytes.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        Ok(Self { bytes, reservation })
    }

    pub(crate) fn zeroed(budget: &'a MetadataBudget, length: usize) -> Result<Self, Errno> {
        let reservation = budget.reserve(length.checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
        bytes.resize(length, 0);
        let mut result = Self { bytes, reservation };
        result.reservation.resize(result.bytes.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        Ok(result)
    }

    pub(crate) fn as_mut_slice(&mut self) -> &mut [u8] { &mut self.bytes }
}

impl Deref for MetadataBytes<'_> {
    type Target = Vec<u8>;
    fn deref(&self) -> &Vec<u8> { &self.bytes }
}

impl AsRef<[u8]> for MetadataBytes<'_> {
    fn as_ref(&self) -> &[u8] { &self.bytes }
}

impl<Other: AsRef<[u8]> + ?Sized> PartialEq<Other> for MetadataBytes<'_> {
    fn eq(&self, other: &Other) -> bool { self.bytes.as_slice() == other.as_ref() }
}

pub(crate) fn render_filesystem_memory() -> Result<crate::IoBuffer<u8>, Errno> {
    let owners = [
        ("namespace", ROOTFS_METADATA.snapshot()),
        ("journal", crate::prepared_map::JOURNAL_STATE_MEMORY.snapshot()),
        ("journal_writeback", crate::prepared_map::JOURNAL_WRITEBACK_MEMORY.snapshot()),
        ("io", crate::io_buffer::IO_MEMORY.snapshot()),
        ("io_writeback", crate::io_buffer::WRITEBACK_MEMORY.snapshot()),
    ];
    let (current, peak) = FILESYSTEM_ADMISSION.snapshot();
    let mut bytes = crate::IoBuffer::try_with_capacity(2048)?;
    bytes.try_write_fmt(format_args!("version 1\nunits admission_credits\nlifetime kernel\naggregate current={} peak={}\n", current, peak))?;
    for (name, owner) in owners {
        bytes.try_write_fmt(format_args!(
            "{} live={} temporary={} limit={} peak_live={} peak_temporary={} peak_total={}\n",
            name, owner.live, owner.temporary, owner.limit, owner.peak_live, owner.peak_temporary, owner.peak_total,
        ))?;
    }
    Ok(bytes)
}

impl core::fmt::Debug for MetadataBytes<'_> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { self.bytes.fmt(formatter) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_peaks_count_actual_overlap_and_ignore_refused_or_transferred_credits() {
        static TRACKER: AdmissionTracker = AdmissionTracker::new();
        let first = MetadataBudget::tracked(100, &TRACKER);
        let second = MetadataBudget::tracked(100, &TRACKER);
        let mut live = first.reserve(80).unwrap();
        let mut staged = first.reserve_temporary(60).unwrap();
        let other = second.reserve(30).unwrap();
        assert_eq!(TRACKER.snapshot(), (170, 170));
        assert_eq!(first.snapshot(), BudgetSnapshot { limit: 100, live: 80, temporary: 60,
            peak_live: 80, peak_temporary: 60, peak_total: 140 });
        assert!(first.reserve(21).is_err());
        assert!(staged.resize(201).is_err());
        assert_eq!(first.exchange(&mut [&mut staged], &mut []), Err(Errno::ENOMEM));
        assert_eq!(TRACKER.snapshot(), (170, 170));
        let mut removed = live.split(50);
        assert_eq!(first.exchange(&mut [&mut staged], &mut [&mut removed]), Ok(()));
        assert_eq!(TRACKER.snapshot(), (170, 170));
        assert_eq!(first.snapshot().peak_live, 90);
        drop(removed);
        assert_eq!(TRACKER.snapshot(), (120, 170));
        drop(other);
        live.resize(40).unwrap();
        assert_eq!(TRACKER.snapshot(), (100, 170));
        live.merge(staged);
        assert_eq!(TRACKER.snapshot(), (100, 170));
        let split = live.split(10);
        assert_eq!(TRACKER.snapshot(), (100, 170));
        drop(split);
        assert_eq!(TRACKER.snapshot(), (90, 170));
        drop(live);
        assert_eq!(TRACKER.snapshot(), (0, 170));
        let later = second.reserve(100).unwrap();
        assert_eq!(TRACKER.snapshot(), (100, 170));
        drop(later);
        assert_eq!(TRACKER.snapshot(), (0, 170));
    }

    #[test]
    fn historical_peak_survives_reclaim_and_a_lowered_limit() {
        let budget = MetadataBudget::new(100);
        let live = budget.reserve(90).unwrap();
        drop(live);
        budget.set_limit(10).unwrap();
        assert_eq!(budget.snapshot(), BudgetSnapshot { limit: 10, live: 0, temporary: 0,
            peak_live: 90, peak_temporary: 0, peak_total: 90 });
    }

    #[test]
    fn diagnostic_formatting_refuses_without_admission_or_tracker_leak() {
        let current = crate::io_buffer::IO_MEMORY.usage().0;
        let before = FILESYSTEM_ADMISSION.snapshot();
        let _limit = crate::io_buffer::test_budget(current);
        assert!(matches!(render_filesystem_memory(), Err(Errno::ENOMEM)));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, current);
        assert_eq!(FILESYSTEM_ADMISSION.snapshot(), before);
    }

    #[test]
    fn exchange_admits_replacement_at_the_resident_limit() {
        let budget = MetadataBudget::new(100);
        let mut live = budget.reserve(100).unwrap();
        let mut removed = live.split(70);
        let mut staged = budget.reserve_temporary(70).unwrap();
        assert_eq!(budget.exchange(&mut [&mut staged], &mut [&mut removed]), Ok(()));
        assert_eq!(budget.usage(), (100, 100));
        assert_eq!(budget.state.lock().temporary, 70);
        live.merge(staged);
        drop(removed);
        assert_eq!(budget.state.lock().temporary, 0);
        drop(live);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn rejected_exchange_preserves_both_classes_and_all_credits() {
        let budget = MetadataBudget::new(100);
        let mut live = budget.reserve(100).unwrap();
        let mut removed = live.split(70);
        let mut staged = budget.reserve_temporary(71).unwrap();
        assert_eq!(budget.exchange(&mut [&mut staged], &mut [&mut removed]), Err(Errno::ENOMEM));
        assert_eq!(budget.usage().0, 100);
        assert_eq!(budget.state.lock().temporary, 71);
        live.merge(removed);
        staged.resize(70).unwrap();
        assert_eq!(budget.exchange(&mut [&mut staged], &mut []), Err(Errno::ENOMEM));
        drop(live);
        assert_eq!(budget.exchange(&mut [&mut staged], &mut []), Ok(()));
        assert_eq!(budget.usage().0, 70);
        drop(staged);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn exchange_checks_budget_identity_classes_and_temporary_headroom() {
        let budget = MetadataBudget::new(100);
        let other = MetadataBudget::new(100);
        let mut live = budget.reserve(100).unwrap();
        let mut foreign = other.reserve_temporary(1).unwrap();
        assert_eq!(budget.exchange(&mut [&mut foreign], &mut [&mut live]), Err(Errno::EIO));
        assert_eq!(budget.exchange(&mut [&mut live], &mut []), Err(Errno::EIO));
        let mut temporary = budget.reserve_temporary(200).unwrap();
        assert_eq!(budget.exchange(&mut [], &mut [&mut live]), Err(Errno::ENOMEM));
        temporary.resize(100).unwrap();
        assert_eq!(budget.exchange(&mut [], &mut [&mut live]), Ok(()));
        assert_eq!(budget.usage().0, 0);
        assert_eq!(budget.state.lock().temporary, 200);
        drop((live, temporary, foreign));
        assert_eq!(budget.state.lock().temporary, 0);
        assert_eq!(other.state.lock().temporary, 0);
    }

    #[test]
    fn admission_resize_and_drop_preserve_exact_usage() {
        let budget = MetadataBudget::new(100);
        let mut first = budget.reserve(60).unwrap();
        assert_eq!(budget.usage(), (60, 100));
        assert!(matches!(budget.reserve(41), Err(Errno::ENOMEM)));
        assert_eq!(first.resize(101), Err(Errno::ENOMEM));
        assert_eq!(budget.usage(), (60, 100));
        first.resize(20).unwrap();
        first.merge(budget.reserve(80).unwrap());
        assert_eq!(first.bytes(), 100);
        assert_eq!(budget.set_limit(99), Err(Errno::ENOMEM));
        first.resize(40).unwrap();
        budget.set_limit(40).unwrap();
        drop(first);
        assert_eq!(budget.usage(), (0, 40));
    }

    #[test]
    fn owned_bytes_admit_before_copy_and_release_after_drop() {
        let budget = MetadataBudget::new(16);
        let bytes = MetadataBytes::copy_from(&budget, b"eight888").unwrap();
        assert_eq!(bytes.as_slice(), b"eight888");
        assert_eq!(budget.usage(), (16, 16));
        assert!(matches!(MetadataBytes::copy_from(&budget, b"x"), Err(Errno::ENOMEM)));
        drop(bytes);
        assert_eq!(budget.usage(), (0, 16));
        let mut zeroed = MetadataBytes::zeroed(&budget, 8).unwrap();
        zeroed.as_mut_slice()[3] = 9;
        assert_eq!(zeroed[3], 9);
    }

    #[test]
    fn capacity_and_arithmetic_limits_are_not_silent() {
        let budget = MetadataBudget::new(64);
        let mut bytes = Vec::with_capacity(32);
        bytes.extend_from_slice(b"one");
        let owned = MetadataBytes::from_vec(&budget, bytes).unwrap();
        assert_eq!(budget.usage(), (64, 64));
        drop(owned);
        assert!(matches!(MetadataBytes::zeroed(&budget, usize::MAX), Err(Errno::ENOMEM)));
        assert_eq!(budget.usage(), (0, 64));
        let unlimited = MetadataBudget::new(usize::MAX);
        let reservation = unlimited.reserve(usize::MAX).unwrap();
        assert!(matches!(unlimited.reserve(1), Err(Errno::ENOMEM)));
        drop(reservation);
        assert_eq!(unlimited.usage().0, 0);
    }

    #[test]
    fn temporary_headroom_cannot_consume_unbounded_memory_or_change_live_quota() {
        let budget = MetadataBudget::new(100);
        let live = budget.reserve(100).unwrap();
        let temporary = budget.reserve_temporary(200).unwrap();
        assert_eq!(budget.usage(), (100, 100));
        assert!(matches!(budget.reserve_temporary(1), Err(Errno::ENOMEM)));
        assert!(matches!(budget.reserve(1), Err(Errno::ENOMEM)));
        assert_eq!(budget.set_limit(99), Err(Errno::ENOMEM));
        drop(live);
        assert_eq!(budget.set_limit(50), Err(Errno::ENOMEM));
        drop(temporary);
        budget.set_limit(50).unwrap();
        assert_eq!(budget.usage(), (0, 50));
    }

    #[test]
    fn combined_usage_cannot_overflow_between_resident_and_temporary_classes() {
        let budget = MetadataBudget::new(usize::MAX);
        let mut live = budget.reserve(usize::MAX - 2).unwrap();
        let mut temporary = budget.reserve_temporary(2).unwrap();
        assert!(matches!(budget.reserve(1), Err(Errno::ENOMEM)));
        assert!(matches!(budget.reserve_temporary(1), Err(Errno::ENOMEM)));
        assert_eq!(live.resize(usize::MAX - 1), Err(Errno::ENOMEM));
        assert_eq!(temporary.resize(3), Err(Errno::ENOMEM));
        assert_eq!(live.bytes(), usize::MAX - 2);
        assert_eq!(temporary.bytes(), 2);
        drop(live);
        temporary.resize(usize::MAX).unwrap();
        assert!(matches!(budget.reserve(1), Err(Errno::ENOMEM)));
        drop(temporary);
        assert_eq!(budget.usage().0, 0);
    }
}
