use core::cell::UnsafeCell;

use crate::process::HostIO;
use wasm_posix_shared::Errno;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MasterHolder {
    pub pid: i32,
    pub ofd_idx: usize,
}

struct GlobalMaster(UnsafeCell<Option<MasterHolder>>);

unsafe impl Sync for GlobalMaster {}

static MASTER: GlobalMaster = GlobalMaster(UnsafeCell::new(None));

fn with_master<R>(f: impl FnOnce(&mut Option<MasterHolder>) -> R) -> R {
    f(unsafe { &mut *MASTER.0.get() })
}

pub fn try_set_master(pid: i32, ofd_idx: usize) -> Result<(), Errno> {
    with_master(|m| {
        if let Some(h) = *m {
            if h.pid == pid && h.ofd_idx == ofd_idx {
                return Ok(());
            }
            return Err(Errno::EBUSY);
        }
        *m = Some(MasterHolder { pid, ofd_idx });
        Ok(())
    })
}

pub fn drop_master(pid: i32, ofd_idx: usize) -> bool {
    with_master(|m| match *m {
        Some(h) if h.pid == pid && h.ofd_idx == ofd_idx => {
            *m = None;
            true
        }
        _ => false,
    })
}

pub fn release_if_held(
    holds_master: bool,
    pid: i32,
    ofd_idx: usize,
    host: &mut dyn HostIO,
) {
    if holds_master && drop_master(pid, ofd_idx) {
        host.kms_drop_master(pid);
    }
}

#[cfg(test)]
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
    fn try_set_master_first_caller_wins() {
        let _g = lock_for_test();
        assert!(try_set_master(1, 5).is_ok());
        assert_eq!(current(), Some(MasterHolder { pid: 1, ofd_idx: 5 }));
    }

    #[test]
    fn try_set_master_same_ofd_is_idempotent() {
        let _g = lock_for_test();
        try_set_master(1, 5).unwrap();
        assert!(try_set_master(1, 5).is_ok());
    }

    #[test]
    fn try_set_master_different_caller_returns_ebusy() {
        let _g = lock_for_test();
        try_set_master(1, 5).unwrap();
        assert_eq!(try_set_master(2, 5), Err(Errno::EBUSY));
        assert_eq!(try_set_master(1, 6), Err(Errno::EBUSY));
    }

    #[test]
    fn drop_master_only_succeeds_for_holder() {
        let _g = lock_for_test();
        try_set_master(1, 5).unwrap();
        assert!(!drop_master(2, 5));
        assert!(current().is_some());
        assert!(drop_master(1, 5));
        assert!(current().is_none());
    }
}
