//! `rt_sigtimedwait`, `sigsuspend` and `pause`, owned by the kernel.
//!
//! # Why this exists
//!
//! Until step 4 of `docs/plans/2026-09-27-guest-waits-into-rust.md` the kernel
//! answered these syscalls only "now or `EAGAIN`", and the host decided when
//! to ask again: `sigsuspend`/`pause` were re-run every 10 ms, a
//! `sigtimedwait` without a timeout every 500 ms, and a signal generation woke
//! a host list that every signal source had to remember to touch. Whether a
//! signal ends one of these waits is a question about kernel state only: the
//! thread's pending set, its mask, and the signal's disposition.
//!
//! Now the caller parks in [`crate::wait_park`]:
//!
//! * `sigsuspend`/`pause` park with the temporary mask installed (as before,
//!   in the process's signal-mask-wait record) and end the way every park ends
//!   on a signal: the sweep interrupts them with `EINTR` once a pending,
//!   unblocked signal targets the thread. The host then delivers that signal,
//!   as it did when its poll found one.
//! * `rt_sigtimedwait` parks with its set and optional deadline. When a signal
//!   in the set becomes pending for the thread the kernel takes it, writes the
//!   caller's `siginfo_t`, and answers the signal number ([`SigWait::report`]);
//!   that runs before the generic sweep, so a set member is taken rather than
//!   delivered. A caught signal outside the set interrupts it with `EINTR`;
//!   the deadline answers `EAGAIN`.
//!
//! None of the three is restarted by `SA_RESTART` (signal(7)).

use wasm_posix_shared::signal::NSIG;
use wasm_posix_shared::Errno;

use crate::process::{HostIO, Process};
use crate::process_wire::{write_siginfo, NativeSiginfo, ProcessDataModel};
use crate::syscalls::GuestTask;

/// One signal taken by a `sigtimedwait`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TakenSignal {
    pub signum: u32,
    pub value_bits: u64,
    pub code: i32,
    /// `si_pid`, or `si_timerid` for a POSIX timer.
    pub word_1: i32,
    /// `si_uid`, or `si_overrun` for a POSIX timer.
    pub word_2: i32,
}

/// Take the lowest pending signal in `mask` for `tid` (its own directed
/// signals and the process's shared ones), consuming it as delivery would.
pub fn take_signal_for(proc: &mut Process, tid: u32, mask: u64) -> Option<TakenSignal> {
    let pending_in_mask = proc.pending_for(tid) & mask;
    if pending_in_mask == 0 {
        return None;
    }
    let signum = pending_in_mask.trailing_zeros() + 1;
    if signum >= NSIG {
        return None;
    }
    let info = proc.consume_signal_for(tid, signum)?;
    let (word_1, word_2) = match info.timer_id {
        Some(timer_id) => (
            timer_id as i32,
            proc.accept_posix_timer_notification(timer_id).unwrap_or(0),
        ),
        None => (info.sender_pid as i32, info.sender_uid as i32),
    };
    Some(TakenSignal {
        signum,
        value_bits: info.si_value_bits,
        code: info.si_code,
        word_1,
        word_2,
    })
}

/// One parked `rt_sigtimedwait`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SigWait {
    /// The set the caller waits on.
    pub mask: u64,
    /// The caller's `siginfo_t *` (0 when the caller passed NULL).
    pub info: u64,
    /// The requested timeout, for an image-build kernel's logical clock.
    pub timeout_ns: Option<u64>,
}

impl SigWait {
    /// `EFAULT` unless the `siginfo_t` destination is addressable.
    pub fn probe(&self, host: &mut dyn HostIO, task: GuestTask) -> Result<(), Errno> {
        if self.info == 0 {
            return Ok(());
        }
        let len = data_model(task)?.siginfo_size();
        let mut scratch = [0u8; 160];
        if host.proc_read_bytes(task.pid as i32, self.info, &mut scratch[..len]) < 0 {
            return Err(Errno::EFAULT);
        }
        Ok(())
    }

    /// Write `taken` to the caller's `siginfo_t` and return the syscall value.
    pub fn report(
        &self,
        host: &mut dyn HostIO,
        task: GuestTask,
        taken: &TakenSignal,
    ) -> Result<i32, Errno> {
        if self.info != 0 {
            let model = data_model(task)?;
            let mut bytes = [0u8; 160];
            let bytes = &mut bytes[..model.siginfo_size()];
            write_siginfo(
                bytes,
                NativeSiginfo {
                    signo: taken.signum as i32,
                    code: taken.code,
                    word_1: taken.word_1,
                    // Keep uid/timer-overrun bits lossless across the
                    // signed/unsigned siginfo union views.
                    word_2_bits: taken.word_2 as u32,
                    value_bits: taken.value_bits,
                },
                model,
            )?;
            if host.proc_write_bytes(task.pid as i32, self.info, bytes) < 0 {
                return Err(Errno::EFAULT);
            }
        }
        Ok(taken.signum as i32)
    }
}

fn data_model(task: GuestTask) -> Result<ProcessDataModel, Errno> {
    ProcessDataModel::from_width(i64::from(task.pointer_width))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::signal::{SIGUSR1, SIGUSR2};

    #[test]
    fn only_a_signal_in_the_set_is_taken() {
        let mut proc = Process::new(7);
        proc.raise_signal(SIGUSR2);
        let usr1 = crate::signal::sig_bit(SIGUSR1);
        assert_eq!(take_signal_for(&mut proc, 7, usr1), None);
        proc.raise_signal(SIGUSR1);
        let taken = take_signal_for(&mut proc, 7, usr1).expect("taken");
        assert_eq!(taken.signum, SIGUSR1);
        assert_eq!(take_signal_for(&mut proc, 7, usr1), None, "consumed once");
        assert_ne!(proc.pending_for(7) & crate::signal::sig_bit(SIGUSR2), 0);
    }
}
