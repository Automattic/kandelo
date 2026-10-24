//! Blocking syscalls the kernel parks and re-executes itself.
//!
//! # Why this exists
//!
//! Step 5 of `docs/plans/2026-09-27-guest-waits-into-rust.md`. A blocking
//! syscall whose answer depends on state another task changes -- an advisory
//! lock, a pipe, a socket -- used to return `EAGAIN` to the host, which kept
//! the channel and re-ran the syscall on a wake event or a 10/50 ms timer.
//! The decision "has the state changed enough to complete this call?" is
//! kernel control flow, so the kernel now parks the caller with the call it
//! must re-execute ([`RetryOp`], invariant 3 of `wait_queue`: the retry
//! target lives on the sleeper) and re-runs it itself whenever one of its
//! wake sources fires. The host only publishes the answer.
//!
//! Pointer arguments are the caller's own addresses (as for every other
//! kernel-owned wait), read and written through the cross-memory primitive,
//! so nothing staged per call has to outlive the park.
//!
//! The descriptor is pinned, not re-resolved. A parked call holds the
//! kernel's blocked-retry binding for its open file description
//! (`crate::blocked_retry`, `token`), exactly as the host-driven retry did:
//! another thread may close the descriptor and reuse its number while the
//! call sleeps, and the re-execution must still act on the file the caller
//! named, never on whatever now has that number. The kernel takes the binding
//! when it parks the call and releases it when the park completes
//! ([`crate::wait_park::Parks::take_released_retry_bindings`]); thread exit,
//! exec and process teardown release it through their own lifecycle cleanup.

use wasm_posix_shared::{Errno, WasmFlock};

use crate::blocked_retry::BlockingRetryOperation;
use crate::lock::AdvisoryLockManager;
use crate::process::{HostIO, Process};

/// One parked blocking call, with exactly the arguments it was issued with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryOp {
    /// `fcntl(F_SETLKW / F_SETLKW64 / F_OFD_SETLKW)`. The `struct flock` is
    /// read once, when the call starts: POSIX gives the request the values
    /// at the call, and a set-lock never writes it back.
    FcntlLock { fd: i32, cmd: u32, flock: WasmFlock, token: i64 },
    /// Blocking `flock(LOCK_SH / LOCK_EX)`.
    Flock { fd: i32, operation: u32, token: i64 },
}

impl RetryOp {
    /// The wake source that can change this call's answer.
    pub fn source(&self) -> crate::wait_queue::WakeSource {
        match self {
            RetryOp::FcntlLock { .. } | RetryOp::Flock { .. } => {
                crate::wait_queue::WakeSource::AdvisoryLock
            }
        }
    }

    /// The blocked-retry binding that pins this call's target.
    pub fn token(&self) -> i64 {
        match *self {
            RetryOp::FcntlLock { token, .. } | RetryOp::Flock { token, .. } => token,
        }
    }

    fn operation(&self) -> BlockingRetryOperation {
        match self {
            RetryOp::FcntlLock { .. } => BlockingRetryOperation::Fcntl,
            RetryOp::Flock { .. } => BlockingRetryOperation::Flock,
        }
    }

    /// Run the call once more, as task `tid`, against current state and the
    /// pinned target. `Err(EAGAIN)` means it would still block.
    pub fn attempt(
        &self,
        proc: &mut Process,
        locks: &mut AdvisoryLockManager,
        host: &mut dyn HostIO,
        tid: u32,
    ) -> Result<i32, Errno> {
        proc.blocked_retries.activate(tid, self.token(), self.operation())?;
        let result = match *self {
            RetryOp::FcntlLock { fd, cmd, mut flock, .. } => {
                crate::syscalls::sys_fcntl_lock(proc, locks, fd, cmd, &mut flock, host).map(|()| 0)
            }
            RetryOp::Flock { fd, operation, .. } => {
                crate::syscalls::sys_flock(proc, locks, fd, operation, host).map(|()| 0)
            }
        };
        proc.blocked_retries.clear_active();
        result
    }
}

/// Whether an `fcntl` lock command blocks on a conflict.
pub fn fcntl_lock_blocks(cmd: u32) -> bool {
    use wasm_posix_shared::fcntl_cmd::F_OFD_SETLKW;
    // 7 = F_SETLKW, 14 = F_SETLKW64 (ILP32 numbering).
    cmd == 7 || cmd == 14 || cmd == F_OFD_SETLKW
}

/// Whether a `flock` operation blocks on a conflict.
pub fn flock_blocks(operation: u32) -> bool {
    use wasm_posix_shared::flock_op::{LOCK_NB, LOCK_UN};
    operation & LOCK_NB == 0 && operation & !LOCK_NB != LOCK_UN
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wait_park::{Parks, Resume};
    use crate::wait_queue::{WaitKind, WakeSource};
    use alloc::vec;

    #[test]
    fn only_the_blocking_forms_park() {
        assert!(fcntl_lock_blocks(7));
        assert!(fcntl_lock_blocks(14));
        assert!(fcntl_lock_blocks(wasm_posix_shared::fcntl_cmd::F_OFD_SETLKW));
        assert!(!fcntl_lock_blocks(6));
        assert!(!fcntl_lock_blocks(13));
        use wasm_posix_shared::flock_op::{LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN};
        assert!(flock_blocks(LOCK_EX));
        assert!(flock_blocks(LOCK_SH));
        assert!(!flock_blocks(LOCK_EX | LOCK_NB));
        assert!(!flock_blocks(LOCK_UN));
    }

    #[test]
    fn a_parked_lock_is_offered_for_re_execution_only_after_lock_state_changes() {
        let mut parks = Parks::new();
        let op = RetryOp::Flock { fd: 3, operation: wasm_posix_shared::flock_op::LOCK_EX, token: 9 };
        let generation = parks
            .park(4, 4, WaitKind::AdvisoryLock, vec![WakeSource::AdvisoryLock], None, Resume::Retry(op))
            .unwrap();
        assert!(parks.take_dirty_retry_waiters().is_empty(), "nothing changed yet");
        parks.note_advisory_lock_changed_for_test();
        let waiters = parks.take_dirty_retry_waiters();
        assert_eq!(waiters.len(), 1);
        assert_eq!(waiters[0].3, op);
        // Still blocked: stays parked, and is not offered again until the
        // next change.
        assert!(parks.take_dirty_retry_waiters().is_empty());
        parks.note_advisory_lock_changed_for_test();
        let (id, _, _, op) = parks.take_dirty_retry_waiters()[0];
        assert!(parks.finish_retry_waiter(id, op, 0));
        let done = parks.take_completions();
        assert_eq!((done[0].generation, done[0].value, done[0].flags), (generation, 0, 0));
        assert_eq!(parks.take_released_retry_bindings(), vec![(4, 4, 9)]);
    }

    #[test]
    fn every_completion_of_a_parked_call_releases_its_binding() {
        use wasm_posix_shared::flock_op::LOCK_EX;
        // Cancellation and signal interruption end the park without a
        // re-execution; the pin must not outlive them.
        let mut parks = Parks::new();
        let op = |token| RetryOp::Flock { fd: 3, operation: LOCK_EX, token };
        parks
            .park(4, 4, WaitKind::AdvisoryLock, vec![WakeSource::AdvisoryLock], None, Resume::Retry(op(1)))
            .unwrap();
        parks
            .park(4, 5, WaitKind::AdvisoryLock, vec![WakeSource::AdvisoryLock], None, Resume::Retry(op(2)))
            .unwrap();
        assert!(parks.cancel_task(4, 5));
        assert_eq!(parks.take_released_retry_bindings(), vec![(4, 5, 2)]);
        // A retired task's binding is its lifecycle cleanup's to release.
        parks.retire_task(4, 4);
        assert!(parks.take_released_retry_bindings().is_empty());
    }
}
