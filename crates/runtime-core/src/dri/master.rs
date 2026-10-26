use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicU64, Ordering};

use crate::lock::OfdId;
use wasm_posix_shared::Errno;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MasterHolder {
    pub pid: i32,
    pub ofd_id: OfdId,
    pub lease_id: u64,
}

struct GlobalMaster(UnsafeCell<Option<MasterHolder>>);

unsafe impl Sync for GlobalMaster {}

static LAST_MASTER_LEASE: AtomicU64 = AtomicU64::new(0);

static MASTER: GlobalMaster = GlobalMaster(UnsafeCell::new(None));

fn with_master<R>(f: impl FnOnce(&mut Option<MasterHolder>) -> R) -> R {
    f(unsafe { &mut *MASTER.0.get() })
}

/// Return whether a new file became master. Another alias of the same file
/// succeeds without replacing its presentation owner with the caller's PID.
pub fn try_set_master(pid: i32, ofd_id: OfdId) -> Result<bool, Errno> {
    with_master(|master| {
        if let Some(holder) = *master {
            return if holder.ofd_id == ofd_id { Ok(false) } else { Err(Errno::EBUSY) };
        }
        if ofd_id.0 == 0 { return Err(Errno::EINVAL); }
        let previous = LAST_MASTER_LEASE.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
            |value| value.checked_add(1)).map_err(|_| Errno::EOVERFLOW)?;
        *master = Some(MasterHolder { pid, ofd_id, lease_id: previous + 1 });
        Ok(true)
    })
}

pub fn drop_master(ofd_id: OfdId) -> Option<MasterHolder> {
    with_master(|master| match *master {
        Some(holder) if holder.ofd_id == ofd_id => {
            master.take()
        }
        _ => None,
    })
}

pub fn current() -> Option<MasterHolder> {
    with_master(|m| *m)
}

#[cfg(test)]
pub fn lock_for_test() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    with_master(|m| *m = None);
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_file_becomes_master() {
        let _guard = lock_for_test();
        assert_eq!(try_set_master(1, OfdId(5)), Ok(true));
        let grant = current().unwrap();
        assert_eq!(grant.pid, 1);
        assert_eq!(grant.ofd_id, OfdId(5));
        assert_ne!(grant.lease_id, 0);
    }

    #[test]
    fn inherited_file_keeps_its_master_and_presentation_owner() {
        let _guard = lock_for_test();
        try_set_master(1, OfdId(5)).unwrap();
        assert_eq!(try_set_master(2, OfdId(5)), Ok(false));
        assert_eq!(current().unwrap().pid, 1);
    }

    #[test]
    fn distinct_file_is_busy_even_for_the_same_process_or_reused_slot() {
        let _guard = lock_for_test();
        try_set_master(1, OfdId(5)).unwrap();
        assert_eq!(try_set_master(2, OfdId(6)), Err(Errno::EBUSY));
        assert_eq!(try_set_master(1, OfdId(6)), Err(Errno::EBUSY));
    }

    #[test]
    fn only_the_exact_master_file_can_release_authority() {
        let _guard = lock_for_test();
        try_set_master(1, OfdId(5)).unwrap();
        assert!(drop_master(OfdId(6)).is_none());
        assert!(current().is_some());
        assert!(drop_master(OfdId(5)).is_some());
        assert!(current().is_none());
    }
    #[test]
    fn reacquiring_the_same_file_mints_a_new_grant() {
        let _guard = lock_for_test();
        try_set_master(1, OfdId(5)).unwrap();
        let first = current().unwrap();
        assert_eq!(try_set_master(2, OfdId(5)), Ok(false));
        assert_eq!(current().unwrap().lease_id, first.lease_id);
        assert_eq!(drop_master(OfdId(5)), Some(first));
        try_set_master(2, OfdId(5)).unwrap();
        let renewed = current().unwrap();
        assert!(renewed.lease_id > first.lease_id);
    }

}
