use alloc::rc::Rc;
use alloc::boxed::Box;
use core::ops::Deref;
use wasm_posix_shared::Errno;
use crate::io_buffer::IO_MEMORY;
use crate::metadata_budget::{MetadataBudget, MetadataReservation};

struct SharedValue<Value> {
    value: Value,
    _reservation: MetadataReservation<'static>,
}

pub(crate) struct IoRc<Value>(Rc<SharedValue<Value>>);

impl<Value> IoRc<Value> {
    pub(crate) fn identity(&self) -> usize { &self.0.value as *const Value as usize }
    #[cfg(test)]
    pub(crate) fn strong_count(&self) -> usize { Rc::strong_count(&self.0) }
    #[cfg(test)]
    pub(crate) fn admitted_bytes(&self) -> usize { self.0._reservation.bytes() }
    pub(crate) fn try_new(value: Value) -> Result<Self, Errno> {
        Self::try_new_in(&IO_MEMORY, value)
    }

    pub(crate) fn try_new_in(budget: &'static MetadataBudget, value: Value) -> Result<Self, Errno> {
        let bytes = core::mem::size_of::<SharedValue<Value>>()
            .checked_add(4 * core::mem::size_of::<usize>())
            .and_then(|bytes| bytes.checked_add(core::mem::align_of::<SharedValue<Value>>()))
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)?;
        let reservation = budget.reserve(bytes)?;
        Rc::try_new(SharedValue { value, _reservation: reservation })
            .map(Self).map_err(|_| Errno::ENOMEM)
    }
}

pub struct IoBox<Value>(Box<SharedValue<Value>>);

impl<Value> IoBox<Value> {
    #[cfg(test)]
    pub fn new(value: Value) -> Self { Self::try_new(value).unwrap() }
    pub fn into_inner(self) -> Value {
        let SharedValue { value, _reservation } = *self.0;
        value
    }
    pub fn try_new(value: Value) -> Result<Self, Errno> {
        let bytes = core::mem::size_of::<SharedValue<Value>>().checked_mul(2).ok_or(Errno::ENOMEM)?;
        let reservation = IO_MEMORY.reserve(bytes)?;
        Box::try_new(SharedValue { value, _reservation: reservation }).map(Self).map_err(|_| Errno::ENOMEM)
    }
}

impl<Value> Deref for IoBox<Value> {
    type Target = Value;
    fn deref(&self) -> &Value { &self.0.value }
}

impl<Value> core::ops::DerefMut for IoBox<Value> {
    fn deref_mut(&mut self) -> &mut Value { &mut self.0.value }
}

impl<Value: core::fmt::Debug> core::fmt::Debug for IoBox<Value> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { self.0.value.fmt(formatter) }
}

#[cfg(test)]
impl<Value: Clone> Clone for IoBox<Value> {
    fn clone(&self) -> Self { Self::try_new((**self).clone()).unwrap() }
}

impl<Value> Clone for IoRc<Value> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}

impl<Value> Deref for IoRc<Value> {
    type Target = Value;
    fn deref(&self) -> &Value { &self.0.value }
}

impl<Value: core::fmt::Debug> core::fmt::Debug for IoRc<Value> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { self.0.value.fmt(formatter) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::cell::Cell;

    struct Dropped(Rc<Cell<usize>>);

    impl Drop for Dropped {
        fn drop(&mut self) { self.0.set(self.0.get() + 1); }
    }

    #[test]
    fn shared_owner_refusal_and_last_reference_release_follow_actual_value_lifetime() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let drops = Rc::new(Cell::new(0));
        BUDGET.set_limit(0).unwrap();
        assert!(matches!(IoRc::try_new_in(&BUDGET, Dropped(drops.clone())), Err(Errno::ENOMEM)));
        assert_eq!(drops.get(), 1);
        assert_eq!(BUDGET.usage().0, 0);
        BUDGET.set_limit(4096).unwrap();
        let owner = IoRc::try_new_in(&BUDGET, Dropped(drops.clone())).unwrap();
        let retained = BUDGET.usage().0;
        BUDGET.set_limit(retained).unwrap();
        let alias = owner.clone();
        assert_eq!(owner.identity(), alias.identity());
        assert_eq!(owner.strong_count(), 2);
        drop(owner);
        assert_eq!(drops.get(), 1);
        assert_eq!(BUDGET.usage().0, retained);
        drop(alias);
        assert_eq!(drops.get(), 2);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn shared_control_refusal_releases_already_admitted_payload() {
        static BUDGET: MetadataBudget = MetadataBudget::new(32);
        let payload = crate::metadata_budget::MetadataBytes::copy_from(&BUDGET, &[7; 16]).unwrap();
        assert_eq!(BUDGET.usage().0, 32);
        assert!(matches!(IoRc::try_new_in(&BUDGET, payload), Err(Errno::ENOMEM)));
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn box_owner_refuses_before_allocation_and_releases_credit_when_value_is_unboxed() {
        let baseline = IO_MEMORY.usage().0;
        let drops = Rc::new(Cell::new(0));
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(IoBox::try_new(Dropped(drops.clone())), Err(Errno::ENOMEM)));
        }
        assert_eq!(IO_MEMORY.usage().0, baseline);
        assert_eq!(drops.get(), 1);
        let owner = IoBox::try_new(Dropped(drops.clone())).unwrap();
        assert!(IO_MEMORY.usage().0 > baseline);
        let value = owner.into_inner();
        assert_eq!(IO_MEMORY.usage().0, baseline);
        assert_eq!(drops.get(), 1);
        drop(value);
        assert_eq!(drops.get(), 2);
    }
}
