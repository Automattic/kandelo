use wasm_posix_shared::{Errno, signal::NSIG};
extern crate alloc;

use alloc::collections::VecDeque;

use crate::process::{HostIO, Process, ProcessState};

/// First real-time signal number.
pub const SIGRTMIN: u32 = 32;
/// Last real-time signal number (exclusive upper bound for iteration).
pub const SIGRTMAX_PLUS1: u32 = 65;

/// Convert a 1-based signal number to its bitmask position.
/// musl uses 0-based bit positions: signal N maps to bit (N-1).
/// Returns 0 for invalid signal numbers (0 or >= 64).
#[inline]
pub fn sig_bit(signum: u32) -> u64 {
    if signum == 0 || signum >= 65 {
        0
    } else {
        1u64 << (signum - 1)
    }
}

/// Per-signal handler configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalHandler {
    Default,
    Ignore,
    Handler(u32), // Function pointer (index) in guest Wasm -- for future use
}

/// Full sigaction information: handler + flags + mask.
#[derive(Debug, Clone, Copy)]
pub struct SignalAction {
    pub handler: SignalHandler,
    pub flags: u32,
    pub mask: u64,
}

impl SignalAction {
    pub const fn default() -> Self {
        SignalAction {
            handler: SignalHandler::Default,
            flags: 0,
            mask: 0,
        }
    }
}

/// Default action for each signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultAction {
    Terminate,
    Ignore,
    CoreDump, // Treated as terminate in Wasm
    Stop,
    Continue,
}

/// Get the POSIX default action for a signal number.
pub fn default_action(signum: u32) -> DefaultAction {
    use wasm_posix_shared::signal::*;
    match signum {
        SIGHUP | SIGINT | SIGQUIT | SIGILL | SIGTRAP | SIGABRT | SIGBUS | SIGFPE | SIGKILL
        | SIGUSR1 | SIGUSR2 | SIGPIPE | SIGALRM | SIGTERM => DefaultAction::Terminate,
        SIGCHLD | SIGWINCH => DefaultAction::Ignore,
        SIGCONT => DefaultAction::Continue,
        SIGSTOP | SIGTSTP | SIGTTIN | SIGTTOU => DefaultAction::Stop,
        // Unrecognized signals default to terminate
        _ if signum >= 1 && signum < NSIG => DefaultAction::Terminate,
        _ => DefaultAction::Terminate,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DefaultSignalOutcome {
    Continue,
    Stopped,
    Exited,
}

/// Finish a signal-caused process exit, including resource cleanup, before
/// publishing the parent-visible exit record.
pub(crate) fn terminate_process_by_signal(
    proc: &mut Process,
    host: &mut dyn HostIO,
    signum: u32,
) {
    terminate_process_by_signal_impl(proc, None, host, signum);
}

pub(crate) fn terminate_process_by_signal_with_locks(
    proc: &mut Process,
    locks: &mut crate::lock::AdvisoryLockManager,
    host: &mut dyn HostIO,
    signum: u32,
) {
    terminate_process_by_signal_impl(proc, Some(locks), host, signum);
}

fn terminate_process_by_signal_impl(
    proc: &mut Process,
    locks: Option<&mut crate::lock::AdvisoryLockManager>,
    host: &mut dyn HostIO,
    signum: u32,
) {
    proc.sigsuspend_saved_mask = None;
    for thread in proc.thread_states_mut() {
        thread.signals.sigsuspend_saved_mask = None;
    }
    match locks {
        Some(locks) => crate::syscalls::sys_exit_by_signal_with_locks(proc, locks, host, signum),
        None => crate::syscalls::sys_exit_by_signal(proc, host, signum),
    }
}

/// Apply a signal's default action after its pending instance has been
/// consumed. SIGCONT's mandatory resume already happened at generation time.
pub(crate) fn apply_default_signal_action(
    proc: &mut Process,
    host: &mut dyn HostIO,
    signum: u32,
) -> DefaultSignalOutcome {
    apply_default_signal_action_impl(proc, None, host, signum)
}

pub(crate) fn apply_default_signal_action_with_locks(
    proc: &mut Process,
    locks: &mut crate::lock::AdvisoryLockManager,
    host: &mut dyn HostIO,
    signum: u32,
) -> DefaultSignalOutcome {
    apply_default_signal_action_impl(proc, Some(locks), host, signum)
}

fn apply_default_signal_action_impl(
    proc: &mut Process,
    locks: Option<&mut crate::lock::AdvisoryLockManager>,
    host: &mut dyn HostIO,
    signum: u32,
) -> DefaultSignalOutcome {
    match default_action(signum) {
        DefaultAction::Terminate | DefaultAction::CoreDump => {
            terminate_process_by_signal_impl(proc, locks, host, signum);
            DefaultSignalOutcome::Exited
        }
        DefaultAction::Stop => {
            if proc.record_stop(signum) {
                DefaultSignalOutcome::Stopped
            } else {
                DefaultSignalOutcome::Continue
            }
        }
        DefaultAction::Continue | DefaultAction::Ignore => DefaultSignalOutcome::Continue,
    }
}

/// Consume one pending instance for `tid`, preferring its directed queue.
pub(crate) fn dequeue_signal_for(
    proc: &mut Process,
    tid: u32,
    signum: u32,
) -> (u32, i32, i32, i32, i32) {
    if proc.state == ProcessState::Stopped && signum == wasm_posix_shared::signal::SIGKILL {
        proc.clear_signal_everywhere(signum);
        return (signum, 0, 0, proc.pid as i32, proc.uid as i32);
    }
    let info = proc.consume_signal_for(tid, signum).unwrap_or_default();
    let (word_1, word_2) = match info.timer_id {
        Some(timer_id) => (
            timer_id as i32,
            proc.accept_posix_timer_notification(timer_id).unwrap_or(0),
        ),
        None => (proc.pid as i32, proc.uid as i32),
    };
    (signum, info.si_value, info.si_code, word_1, word_2)
}

/// Consume default/ignored pending signals at a syscall boundary. Caught
/// signals stay queued for the guest glue. While stopped, Process selection
/// exposes only SIGKILL; SIGCONT has already resumed at generation time.
pub(crate) fn deliver_pending_signals(proc: &mut Process, host: &mut dyn HostIO) {
    deliver_pending_signals_impl(proc, None, host, crate::process_table::current_tid());
}

pub(crate) fn deliver_pending_signals_with_locks(
    proc: &mut Process,
    locks: &mut crate::lock::AdvisoryLockManager,
    host: &mut dyn HostIO,
) {
    deliver_pending_signals_impl(proc, Some(locks), host, crate::process_table::current_tid());
}

/// Consume default/ignored signals for one exact kernel-owned task.
///
/// Cross-process generation must not interpret the sender's ambient TID in
/// the target process. Callers select a target from the target Process and
/// pass it here; stale, foreign, synthetic, or exited task IDs fail without
/// consuming pending state.
pub(crate) fn deliver_pending_signals_for_tid_with_locks(
    proc: &mut Process,
    locks: &mut crate::lock::AdvisoryLockManager,
    host: &mut dyn HostIO,
    tid: u32,
) -> Result<(), Errno> {
    if !proc.is_live_explicit_tid(tid) {
        return Err(Errno::ESRCH);
    }
    deliver_pending_signals_impl(proc, Some(locks), host, tid);
    Ok(())
}

fn deliver_pending_signals_impl(
    proc: &mut Process,
    mut locks: Option<&mut crate::lock::AdvisoryLockManager>,
    host: &mut dyn HostIO,
    tid: u32,
) {
    loop {
        let Some(signum) = proc.next_deliverable_signal(tid) else {
            break;
        };
        let action = proc.signals.get_action(signum);
        match action.handler {
            SignalHandler::Handler(_) => break,
            SignalHandler::Default => {
                let _ = dequeue_signal_for(proc, tid, signum);
                if apply_default_signal_action_impl(proc, locks.as_deref_mut(), host, signum)
                    != DefaultSignalOutcome::Continue
                {
                    break;
                }
            }
            SignalHandler::Ignore => {
                let _ = dequeue_signal_for(proc, tid, signum);
            }
        }
        if matches!(proc.state, ProcessState::Stopped | ProcessState::Exited) {
            break;
        }
    }
}

/// Check whether setting this handler should discard pending signals.
/// POSIX: "Setting a signal action to SIG_IGN for a signal that is pending shall
/// cause the pending signal to be discarded." Also: "Setting a signal action to
/// SIG_DFL for a signal that is pending and whose default action is to ignore the
/// signal (for example, SIGCHLD), shall cause the pending signal to be discarded."
pub(crate) fn should_discard_pending(signum: u32, handler: &SignalHandler) -> bool {
    match handler {
        SignalHandler::Ignore => true,
        SignalHandler::Default => default_action(signum) == DefaultAction::Ignore,
        SignalHandler::Handler(_) => false,
    }
}

/// Queued signal instance and its siginfo metadata.
#[derive(Debug, Clone, Copy)]
pub struct RtSigEntry {
    pub signum: u32,
    pub si_value: i32,
    /// SI_QUEUE (-1) if sent via sigqueue(), SI_USER (0) if via kill()/raise().
    pub si_code: i32,
    /// Owning POSIX timer for SI_TIMER notifications.
    pub timer_id: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PendingSignalInfo {
    pub si_value: i32,
    pub si_code: i32,
    pub timer_id: Option<u32>,
}

fn consume_pending_info(
    pending: &mut u64,
    queue: &mut VecDeque<RtSigEntry>,
    signum: u32,
) -> PendingSignalInfo {
    if signum == 0 || signum >= NSIG {
        return PendingSignalInfo::default();
    }

    let info = if let Some(pos) = queue.iter().position(|entry| entry.signum == signum) {
        let entry = queue.remove(pos).expect("queued signal index remains valid");
        PendingSignalInfo {
            si_value: entry.si_value,
            si_code: entry.si_code,
            timer_id: entry.timer_id,
        }
    } else {
        PendingSignalInfo::default()
    };

    if !queue.iter().any(|entry| entry.signum == signum) {
        *pending &= !sig_bit(signum);
    }
    info
}

fn remove_timer_info(
    pending: &mut u64,
    queue: &mut VecDeque<RtSigEntry>,
    timer_id: u32,
) -> bool {
    let signum = match queue
        .iter()
        .find(|entry| entry.timer_id == Some(timer_id))
        .map(|entry| entry.signum)
    {
        Some(signum) => signum,
        None => return false,
    };
    queue.retain(|entry| entry.timer_id != Some(timer_id));
    if !queue.iter().any(|entry| entry.signum == signum) {
        *pending &= !sig_bit(signum);
    }
    true
}

/// Per-thread signal state: pending signals + blocked mask + RT queue.
///
/// POSIX distinguishes "directed" signals (sent via `pthread_kill` / `tkill` /
/// `tgkill`) from "shared" signals (sent via `kill` / `sigqueue`). Directed
/// signals target one specific thread and must be delivered to that thread
/// even if other threads have the signal unblocked. Shared signals can be
/// delivered to any thread that does not block them.
///
/// Handlers are process-wide (POSIX) so they live on [`SignalState`], not here.
/// Each thread has its own `blocked` mask (manipulated by `pthread_sigmask`),
/// and its own `pending` / `rt_queue` for directed deliveries.
#[derive(Debug, Clone)]
pub struct PerThreadSignalState {
    /// Bitmask of signals currently blocked by this thread.
    pub blocked: u64,
    /// Bitmask of signals directed to this thread but not yet delivered.
    /// Standard signals (1-31) coalesce; RT signals (32-63) set the bit and
    /// queue one entry per raise in [`rt_queue`].
    pub pending: u64,
    /// Queue of RT-signal and metadata-bearing standard-signal entries
    /// directed at this thread. Parallel bookkeeping to [`SignalState::rt_queue`].
    pub rt_queue: VecDeque<RtSigEntry>,
    /// Saved blocked mask during sigsuspend / ppoll / pselect (per-thread).
    /// Set on first entry into a blocking signal syscall that temporarily swaps
    /// the mask, restored once a signal is dequeued or the call completes.
    pub sigsuspend_saved_mask: Option<u64>,
}

impl PerThreadSignalState {
    pub fn new() -> Self {
        PerThreadSignalState {
            blocked: 0,
            pending: 0,
            rt_queue: VecDeque::new(),
            sigsuspend_saved_mask: None,
        }
    }

    /// Mark a signal as pending on this thread (via tkill/tgkill/pthread_kill).
    /// Returns true on success, false for invalid signal numbers.
    pub fn raise(&mut self, signum: u32) -> bool {
        self.raise_internal(signum, 0, 0) // SI_USER
    }

    /// Mark a signal as pending with an si_value (sigqueue-style).
    pub fn raise_with_value(&mut self, signum: u32, si_value: i32) -> bool {
        self.raise_internal(signum, si_value, -1) // SI_QUEUE
    }

    fn raise_internal(&mut self, signum: u32, si_value: i32, si_code: i32) -> bool {
        if signum == 0 || signum >= NSIG {
            return false;
        }
        if signum >= SIGRTMIN {
            // RT signals: always queue (multiple instances allowed)
            self.rt_queue.push_back(RtSigEntry {
                signum,
                si_value,
                si_code,
                timer_id: None,
            });
        } else if let Some(entry) = self
            .rt_queue
            .iter_mut()
            .find(|entry| entry.signum == signum && entry.timer_id.is_none())
        {
            // Standard non-timer signals coalesce independently of timer
            // notifications using the same signal number.
            if si_code != 0 {
                entry.si_value = si_value;
                entry.si_code = si_code;
            }
        } else {
            self.rt_queue.push_back(RtSigEntry {
                signum,
                si_value,
                si_code,
                timer_id: None,
            });
        }
        self.pending |= sig_bit(signum);
        true
    }

    pub(crate) fn raise_timer(&mut self, signum: u32, si_value: i32, timer_id: u32) -> bool {
        if signum == 0 || signum >= NSIG {
            return false;
        }
        if signum < SIGRTMIN
            && (self.pending & sig_bit(signum)) != 0
            && !self.rt_queue.iter().any(|entry| entry.signum == signum)
        {
            self.rt_queue.push_back(RtSigEntry {
                signum,
                si_value: 0,
                si_code: 0,
                timer_id: None,
            });
        }
        self.pending |= sig_bit(signum);
        self.rt_queue.push_back(RtSigEntry {
            signum,
            si_value,
            si_code: -2,
            timer_id: Some(timer_id),
        });
        true
    }

    pub(crate) fn consume_one_info(&mut self, signum: u32) -> PendingSignalInfo {
        consume_pending_info(&mut self.pending, &mut self.rt_queue, signum)
    }

    pub(crate) fn remove_timer_notification(&mut self, timer_id: u32) -> bool {
        remove_timer_info(&mut self.pending, &mut self.rt_queue, timer_id)
    }

    /// Clear all pending instances of a signal from this thread's pending set.
    pub fn clear_pending(&mut self, signum: u32) {
        if signum > 0 && signum < NSIG {
            self.pending &= !sig_bit(signum);
            self.rt_queue.retain(|e| e.signum != signum);
        }
    }

    /// Consume one directed instance of `signum` regardless of its blocked
    /// state. Standard signals coalesce; RT signals retain the pending bit
    /// until their final queued instance is consumed.
    pub fn consume_one(&mut self, signum: u32) -> Option<(i32, i32)> {
        if signum == 0
            || signum >= NSIG
            || self.pending & sig_bit(signum) == 0
        {
            return None;
        }
        let info = self.consume_one_info(signum);
        Some((info.si_value, info.si_code))
    }

    pub fn is_pending(&self, signum: u32) -> bool {
        signum > 0 && signum < NSIG && (self.pending & sig_bit(signum)) != 0
    }

    /// Check whether a signal is blocked by this thread.
    pub fn is_blocked(&self, signum: u32) -> bool {
        if signum >= NSIG {
            return false;
        }
        (self.blocked & sig_bit(signum)) != 0
    }

    /// Dequeue the lowest-numbered deliverable signal on this thread.
    /// Returns (signum, si_value, si_code) or None.
    pub fn dequeue(&mut self) -> Option<(u32, i32, i32)> {
        let deliverable = self.pending & !self.blocked;
        if deliverable == 0 {
            return None;
        }
        let signum = deliverable.trailing_zeros() + 1;
        if signum >= NSIG {
            return None;
        }
        let (si_value, si_code) = self.consume_one(signum)?;
        Some((signum, si_value, si_code))
    }
}

/// Per-process signal state.
pub struct SignalState {
    /// Full action for each signal (indexed by signal number, 0 unused).
    actions: [SignalAction; 65],
    /// Bitmask of blocked signals.
    pub blocked: u64,
    /// Bitmask of pending signals (standard signals 1-31 are coalesced here;
    /// RT signals 32-63 also set a bit here but are queued in `rt_queue`).
    pub pending: u64,
    /// Queue for real-time signals (32-63). RT signals are queued, not coalesced.
    /// Each entry stores the signal number and optional si_value (from sigqueue).
    rt_queue: VecDeque<RtSigEntry>,
}

impl SignalState {
    pub fn new() -> Self {
        SignalState {
            actions: [SignalAction::default(); 65],
            blocked: 0,
            pending: 0,
            rt_queue: VecDeque::new(),
        }
    }

    /// Get the handler for a signal.
    pub fn get_handler(&self, signum: u32) -> SignalHandler {
        if signum == 0 || signum >= 65 {
            return SignalHandler::Default;
        }
        self.actions[signum as usize].handler
    }

    /// Set the handler for a signal. Returns the old handler.
    /// SIGKILL and SIGSTOP cannot have their handlers changed (POSIX).
    /// Per POSIX: setting SIG_IGN discards pending signals; setting SIG_DFL
    /// for signals whose default action is "ignore" also discards pending signals.
    pub fn set_handler(
        &mut self,
        signum: u32,
        handler: SignalHandler,
    ) -> Result<SignalHandler, ()> {
        use wasm_posix_shared::signal::*;
        if signum == 0 || signum >= 65 {
            return Err(());
        }
        if signum == SIGKILL || signum == SIGSTOP {
            return Err(());
        }
        let old = self.actions[signum as usize].handler;
        self.actions[signum as usize].handler = handler;
        // POSIX: discard pending signals when disposition becomes "ignore"
        if should_discard_pending(signum, &handler) {
            self.clear_pending(signum);
        }
        Ok(old)
    }

    /// Get the full action for a signal.
    pub fn get_action(&self, signum: u32) -> SignalAction {
        if signum == 0 || signum >= 65 {
            return SignalAction::default();
        }
        self.actions[signum as usize]
    }

    /// Set the full action for a signal. Returns the old action.
    /// Per POSIX: setting SIG_IGN discards pending signals; setting SIG_DFL
    /// for signals whose default action is "ignore" also discards pending signals.
    pub fn set_action(&mut self, signum: u32, action: SignalAction) -> Result<SignalAction, ()> {
        use wasm_posix_shared::signal::*;
        if signum == 0 || signum >= 65 {
            return Err(());
        }
        if signum == SIGKILL || signum == SIGSTOP {
            return Err(());
        }
        let old = self.actions[signum as usize];
        self.actions[signum as usize] = action;
        // POSIX: discard pending signals when disposition becomes "ignore"
        if should_discard_pending(signum, &action.handler) {
            self.clear_pending(signum);
        }
        Ok(old)
    }

    /// Apply exec disposition rules without rebuilding pending-signal state.
    ///
    /// Caught dispositions reset to default and ignored dispositions remain
    /// ignored. All per-action flags and masks belong to the old image and are
    /// cleared, including metadata attached to SIG_DFL and SIG_IGN entries.
    /// The process blocked mask, pending bitset, RT queue multiplicity, and
    /// queued siginfo metadata deliberately remain untouched.
    pub fn reset_dispositions_for_exec(&mut self) {
        for action in self.actions.iter_mut().skip(1) {
            let handler = if matches!(action.handler, SignalHandler::Ignore) {
                SignalHandler::Ignore
            } else {
                SignalHandler::Default
            };
            *action = SignalAction {
                handler,
                flags: 0,
                mask: 0,
            };
        }
    }

    /// Mark a signal as pending (via kill/raise — SI_USER).
    /// Standard signals (1-31) are coalesced. RT signals (32-63) are queued.
    /// Bit position = signum - 1 (musl convention: signal N uses bit N-1).
    pub fn raise(&mut self, signum: u32) -> bool {
        self.raise_internal(signum, 0, 0) // SI_USER
    }

    /// Mark a signal as pending with an si_value (for sigqueue — SI_QUEUE).
    pub fn raise_with_value(&mut self, signum: u32, si_value: i32) -> bool {
        self.raise_internal(signum, si_value, -1) // SI_QUEUE
    }

    fn raise_internal(&mut self, signum: u32, si_value: i32, si_code: i32) -> bool {
        if signum == 0 || signum >= 65 {
            return false;
        }
        if should_discard_pending(signum, &self.actions[signum as usize].handler) {
            return true;
        }
        if signum >= SIGRTMIN {
            // RT signals: always queue (multiple instances allowed)
            self.rt_queue.push_back(RtSigEntry {
                signum,
                si_value,
                si_code,
                timer_id: None,
            });
        } else if let Some(entry) = self
            .rt_queue
            .iter_mut()
            .find(|entry| entry.signum == signum && entry.timer_id.is_none())
        {
            // Standard non-timer signals coalesce independently of timer
            // notifications using the same signal number.
            if si_code != 0 {
                entry.si_value = si_value;
                entry.si_code = si_code;
            }
        } else {
            self.rt_queue.push_back(RtSigEntry {
                signum,
                si_value,
                si_code,
                timer_id: None,
            });
        }
        self.pending |= sig_bit(signum);
        true
    }

    pub(crate) fn raise_timer(&mut self, signum: u32, si_value: i32, timer_id: u32) -> bool {
        if signum == 0 || signum >= NSIG {
            return false;
        }
        if signum < SIGRTMIN
            && (self.pending & sig_bit(signum)) != 0
            && !self.rt_queue.iter().any(|entry| entry.signum == signum)
        {
            self.rt_queue.push_back(RtSigEntry {
                signum,
                si_value: 0,
                si_code: 0,
                timer_id: None,
            });
        }
        self.pending |= sig_bit(signum);
        self.rt_queue.push_back(RtSigEntry {
            signum,
            si_value,
            si_code: -2,
            timer_id: Some(timer_id),
        });
        true
    }

    /// Clear a pending signal.
    /// Removes all queued instances (RT or standard sigqueue metadata) and clears the pending bit.
    pub fn clear(&mut self, signum: u32) {
        if signum > 0 && signum < NSIG {
            self.pending &= !sig_bit(signum);
            self.rt_queue.retain(|e| e.signum != signum);
        }
    }

    /// Check if a signal is pending.
    pub fn is_pending(&self, signum: u32) -> bool {
        if signum >= 65 {
            return false;
        }
        (self.pending & sig_bit(signum)) != 0
    }

    /// Return the raw pending signal bitmask.
    pub fn pending_mask(&self) -> u64 {
        self.pending
    }

    pub(crate) fn pending_timer_ids(&self, signum: u32) -> impl Iterator<Item = u32> + '_ {
        self.rt_queue
            .iter()
            .filter(move |entry| entry.signum == signum)
            .filter_map(|entry| entry.timer_id)
    }

    pub(crate) fn remove_timer_notification(&mut self, timer_id: u32) -> bool {
        remove_timer_info(&mut self.pending, &mut self.rt_queue, timer_id)
    }

    /// Clear a signal from the pending set.
    /// Removes all queued instances (RT or standard sigqueue metadata).
    pub fn clear_pending(&mut self, signum: u32) {
        if signum > 0 && signum < NSIG {
            self.pending &= !sig_bit(signum);
            self.rt_queue.retain(|e| e.signum != signum);
        }
    }

    /// Consume one instance of a pending signal (for sigwaitinfo/sigtimedwait).
    /// Unlike dequeue(), this works on any pending signal regardless of blocked mask.
    /// For RT signals, removes one queued instance; clears pending bit only when
    /// no more instances remain. For standard signals, clears the pending bit.
    /// Returns (si_value, si_code) of the consumed signal instance.
    pub fn consume_one(&mut self, signum: u32) -> PendingSignalInfo {
        consume_pending_info(&mut self.pending, &mut self.rt_queue, signum)
    }

    /// Check if a signal is blocked.
    pub fn is_blocked(&self, signum: u32) -> bool {
        if signum >= 65 {
            return false;
        }
        (self.blocked & sig_bit(signum)) != 0
    }

    /// Get the set of pending, unblocked signals.
    pub fn deliverable(&self) -> u64 {
        self.pending & !self.blocked
    }

    /// Peek at the lowest-numbered deliverable signal without removing it.
    pub fn peek_deliverable(&self) -> Option<u32> {
        let deliverable = self.pending & !self.blocked;
        if deliverable == 0 {
            return None;
        }
        let signum = deliverable.trailing_zeros() + 1;
        if signum >= 65 { None } else { Some(signum) }
    }

    /// Dequeue the lowest-numbered deliverable signal.
    /// Standard signals (1-31) are cleared from the pending bitmask.
    /// RT signals (32-63) are dequeued from the queue; the pending bit is
    /// only cleared when no more instances of that signal remain in the queue.
    /// Returns (signum, si_value, si_code). si_value and si_code are 0 for standard signals.
    pub fn dequeue(&mut self) -> Option<(u32, i32, i32)> {
        let deliverable = self.pending & !self.blocked;
        if deliverable == 0 {
            return None;
        }
        // trailing_zeros gives 0-based bit position; signal number = bit + 1
        let signum = deliverable.trailing_zeros() + 1;
        let info = self.consume_one(signum);
        Some((signum, info.si_value, info.si_code))
    }

    /// Check if the next deliverable signal has SA_RESTART set.
    pub fn should_restart(&self) -> bool {
        use wasm_posix_shared::signal::SA_RESTART;
        let deliverable = self.pending & !self.blocked;
        if deliverable == 0 {
            return false;
        }
        let signum = deliverable.trailing_zeros() + 1; // 0-based bit → 1-based signal
        if signum >= 65 {
            return false;
        }
        (self.actions[signum as usize].flags & SA_RESTART) != 0
    }

    /// Reconstruct signal state from parts. Used by fork deserialization.
    /// Pending signals are cleared (per POSIX, child starts with no pending signals).
    pub fn from_parts(handlers: [SignalHandler; 65], blocked: u64) -> Self {
        let mut actions = [SignalAction::default(); 65];
        for (i, h) in handlers.iter().enumerate() {
            actions[i].handler = *h;
        }
        SignalState {
            actions,
            blocked,
            pending: 0,
            rt_queue: VecDeque::new(),
        }
    }

    /// Reconstruct signal state from full actions array (preserves flags/mask).
    pub fn from_actions(actions: [SignalAction; 65], blocked: u64) -> Self {
        SignalState {
            actions,
            blocked,
            pending: 0,
            rt_queue: VecDeque::new(),
        }
    }

    /// Reconstruct signal state for exec. Preserves pending signals (POSIX).
    pub fn from_parts_with_pending(
        handlers: [SignalHandler; 65],
        blocked: u64,
        pending: u64,
    ) -> Self {
        let mut actions = [SignalAction::default(); 65];
        for (i, h) in handlers.iter().enumerate() {
            actions[i].handler = *h;
        }
        // Reconstruct one queued instance for each preserved pending signal.
        let mut rt_queue = VecDeque::new();
        for sig in 1..SIGRTMAX_PLUS1 {
            if (pending & sig_bit(sig)) != 0 {
                rt_queue.push_back(RtSigEntry {
                    signum: sig,
                    si_value: 0,
                    si_code: 0,
                    timer_id: None,
                });
            }
        }
        SignalState {
            actions,
            blocked,
            pending,
            rt_queue,
        }
    }

    /// Get the raw handlers array for serialization.
    pub fn handlers(&self) -> [SignalHandler; 65] {
        let mut handlers = [SignalHandler::Default; 65];
        for (i, a) in self.actions.iter().enumerate() {
            handlers[i] = a.handler;
        }
        handlers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::signal::*;

    #[test]
    fn test_new_signal_state_all_default() {
        let state = SignalState::new();
        assert_eq!(state.get_handler(SIGINT), SignalHandler::Default);
        assert_eq!(state.pending, 0);
        assert_eq!(state.blocked, 0);
    }

    #[test]
    fn test_set_handler() {
        let mut state = SignalState::new();
        let old = state.set_handler(SIGINT, SignalHandler::Ignore).unwrap();
        assert_eq!(old, SignalHandler::Default);
        assert_eq!(state.get_handler(SIGINT), SignalHandler::Ignore);
    }

    #[test]
    fn test_cannot_change_sigkill_handler() {
        let mut state = SignalState::new();
        assert!(state.set_handler(SIGKILL, SignalHandler::Ignore).is_err());
    }

    #[test]
    fn test_cannot_change_sigstop_handler() {
        let mut state = SignalState::new();
        assert!(state.set_handler(SIGSTOP, SignalHandler::Ignore).is_err());
    }

    #[test]
    fn test_raise_and_pending() {
        let mut state = SignalState::new();
        assert!(!state.is_pending(SIGINT));
        state.raise(SIGINT);
        assert!(state.is_pending(SIGINT));
    }

    #[test]
    fn test_blocked_signals() {
        let mut state = SignalState::new();
        state.blocked = sig_bit(SIGINT);
        assert!(state.is_blocked(SIGINT));
        assert!(!state.is_blocked(SIGTERM));
    }

    #[test]
    fn test_deliverable_excludes_blocked() {
        let mut state = SignalState::new();
        state.raise(SIGINT);
        state.raise(SIGTERM);
        state.blocked = sig_bit(SIGINT);
        let d = state.deliverable();
        assert_eq!(d & sig_bit(SIGINT), 0); // blocked
        assert_ne!(d & sig_bit(SIGTERM), 0); // not blocked
    }

    #[test]
    fn test_default_actions() {
        assert_eq!(default_action(SIGINT), DefaultAction::Terminate);
        assert_eq!(default_action(SIGCHLD), DefaultAction::Ignore);
        assert_eq!(default_action(SIGCONT), DefaultAction::Continue);
        assert_eq!(default_action(SIGSTOP), DefaultAction::Stop);
        assert_eq!(default_action(SIGTSTP), DefaultAction::Stop);
        assert_eq!(default_action(SIGTTIN), DefaultAction::Stop);
        assert_eq!(default_action(SIGTTOU), DefaultAction::Stop);
    }

    #[test]
    fn stopped_process_retains_non_kill_signals_pending() {
        use crate::process::{Process, ProcessState, test_host::NoopHost};
        use wasm_posix_shared::wait::EVENT_STOPPED;

        let mut proc = Process::new(51);
        let mut host = NoopHost;
        assert!(proc.record_stop(SIGTSTP));
        assert!(proc.raise_signal(SIGTERM));

        deliver_pending_signals(&mut proc, &mut host);

        assert_eq!(proc.state, ProcessState::Stopped);
        assert!(proc.signals.is_pending(SIGTERM));
        assert_eq!(proc.wait_event.unwrap().event_mask, EVENT_STOPPED);
    }

    #[test]
    fn sigkill_terminates_a_stopped_process() {
        use crate::process::{Process, ProcessState, ThreadInfo, test_host::NoopHost};
        use wasm_posix_shared::wait::{CLD_KILLED, EVENT_EXITED};

        let mut proc = Process::new(52);
        let mut host = NoopHost;
        assert!(proc.record_stop(SIGTSTP));
        proc.add_thread(ThreadInfo::new(99, 0, 0, 0));
        assert!(proc.raise_for_thread(99, SIGKILL));

        deliver_pending_signals(&mut proc, &mut host);

        assert_eq!(proc.state, ProcessState::Exited);
        assert!(!proc.signal_pending_anywhere(SIGKILL));
        let event = proc.wait_event.unwrap();
        assert_eq!(event.event_mask, EVENT_EXITED);
        assert_eq!(event.si_code, CLD_KILLED);
        assert_eq!(event.si_status, SIGKILL as i32);
    }

    #[test]
    fn exact_target_delivery_never_uses_a_foreign_ambient_tid() {
        use crate::lock::AdvisoryLockManager;
        use crate::process::{Process, ProcessState, ThreadInfo, test_host::NoopHost};

        let mut proc = Process::new(60);
        proc.signals.blocked = sig_bit(SIGTERM);
        proc.add_thread(ThreadInfo::new(61, 0, 0, 0));
        assert_eq!(proc.pick_thread_for_shared_signal(SIGTERM), Some(61));
        assert!(proc.raise_signal(SIGTERM));

        let mut locks = AdvisoryLockManager::new();
        let mut host = NoopHost;
        assert_eq!(
            deliver_pending_signals_for_tid_with_locks(
                &mut proc,
                &mut locks,
                &mut host,
                70,
            ),
            Err(Errno::ESRCH),
        );
        assert_eq!(proc.state, ProcessState::Running);
        assert!(proc.signals.is_pending(SIGTERM));

        deliver_pending_signals_for_tid_with_locks(
            &mut proc,
            &mut locks,
            &mut host,
            61,
        )
        .unwrap();
        assert_eq!(proc.state, ProcessState::Exited);
    }

    #[test]
    fn test_from_parts_clears_pending() {
        let handlers = [SignalHandler::Default; 65];
        let state = SignalState::from_parts(handlers, 0x0000_0004);
        assert_eq!(state.blocked, 0x0000_0004);
        assert_eq!(state.pending, 0); // always cleared for fork
    }

    #[test]
    fn test_from_parts_with_pending_preserves_pending() {
        let handlers = [SignalHandler::Default; 65];
        let state = SignalState::from_parts_with_pending(handlers, 0x0000_0004, 0x0000_0008);
        assert_eq!(state.blocked, 0x0000_0004);
        assert_eq!(state.pending, 0x0000_0008);
    }

    #[test]
    fn test_dequeue_returns_lowest_signal() {
        let mut state = SignalState::new();
        state.raise(SIGTERM); // 15
        state.raise(SIGINT); // 2
        state.raise(SIGUSR1); // 10
        // Should dequeue lowest first (SIGINT=2)
        assert_eq!(state.dequeue(), Some((SIGINT, 0, 0)));
        assert_eq!(state.dequeue(), Some((SIGUSR1, 0, 0)));
        assert_eq!(state.dequeue(), Some((SIGTERM, 0, 0)));
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_dequeue_returns_none_when_empty() {
        let mut state = SignalState::new();
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_dequeue_clears_from_pending() {
        let mut state = SignalState::new();
        state.raise(SIGINT);
        assert!(state.is_pending(SIGINT));
        let sig = state.dequeue();
        assert_eq!(sig, Some((SIGINT, 0, 0)));
        assert!(!state.is_pending(SIGINT));
    }

    #[test]
    fn test_dequeue_skips_blocked_signals() {
        let mut state = SignalState::new();
        state.raise(SIGINT); // 2 - blocked
        state.raise(SIGTERM); // 15 - not blocked
        state.blocked = sig_bit(SIGINT);
        // Should skip SIGINT and return SIGTERM
        assert_eq!(state.dequeue(), Some((SIGTERM, 0, 0)));
        // SIGINT is still pending
        assert!(state.is_pending(SIGINT));
        // No more deliverable
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_handlers_accessor() {
        let mut state = SignalState::new();
        state.set_handler(SIGINT, SignalHandler::Ignore).unwrap();
        let handlers = state.handlers();
        assert_eq!(handlers[SIGINT as usize], SignalHandler::Ignore);
        assert_eq!(handlers[SIGTERM as usize], SignalHandler::Default);
    }

    #[test]
    fn test_set_action() {
        let mut state = SignalState::new();
        let action = SignalAction {
            handler: SignalHandler::Handler(42),
            flags: wasm_posix_shared::signal::SA_RESTART,
            mask: 0x04,
        };
        let old = state.set_action(SIGINT, action).unwrap();
        assert_eq!(old.handler, SignalHandler::Default);
        assert_eq!(old.flags, 0);

        let current = state.get_action(SIGINT);
        assert_eq!(current.flags, wasm_posix_shared::signal::SA_RESTART);
        assert_eq!(current.mask, 0x04);
    }

    #[test]
    fn test_exec_resets_action_metadata_and_preserves_only_ignore() {
        let mut state = SignalState::new();
        state
            .set_action(
                SIGINT,
                SignalAction {
                    handler: SignalHandler::Handler(42),
                    flags: wasm_posix_shared::signal::SA_RESTART,
                    mask: 0x04,
                },
            )
            .unwrap();
        state
            .set_action(
                SIGTERM,
                SignalAction {
                    handler: SignalHandler::Ignore,
                    flags: wasm_posix_shared::signal::SA_RESTART,
                    mask: 0x08,
                },
            )
            .unwrap();
        state.actions[wasm_posix_shared::signal::SIGCHLD as usize] = SignalAction {
            handler: SignalHandler::Default,
            flags: wasm_posix_shared::signal::SA_NOCLDWAIT,
            mask: 0x10,
        };

        state.reset_dispositions_for_exec();

        let caught = state.get_action(SIGINT);
        assert!(matches!(caught.handler, SignalHandler::Default));
        assert_eq!(caught.flags, 0);
        assert_eq!(caught.mask, 0);

        let ignored = state.get_action(SIGTERM);
        assert!(matches!(ignored.handler, SignalHandler::Ignore));
        assert_eq!(ignored.flags, 0);
        assert_eq!(ignored.mask, 0);

        let defaulted = state.get_action(wasm_posix_shared::signal::SIGCHLD);
        assert!(matches!(defaulted.handler, SignalHandler::Default));
        assert_eq!(defaulted.flags, 0);
        assert_eq!(defaulted.mask, 0);
    }

    #[test]
    fn test_set_action_cannot_change_sigkill() {
        let mut state = SignalState::new();
        let action = SignalAction {
            handler: SignalHandler::Ignore,
            flags: 0,
            mask: 0,
        };
        assert!(state.set_action(SIGKILL, action).is_err());
    }

    #[test]
    fn test_should_restart() {
        let mut state = SignalState::new();
        let action = SignalAction {
            handler: SignalHandler::Handler(10),
            flags: wasm_posix_shared::signal::SA_RESTART,
            mask: 0,
        };
        state.set_action(SIGINT, action).unwrap();
        state.raise(SIGINT);
        assert!(state.should_restart());
    }

    #[test]
    fn test_should_not_restart_without_flag() {
        let mut state = SignalState::new();
        state
            .set_handler(SIGINT, SignalHandler::Handler(10))
            .unwrap();
        state.raise(SIGINT);
        assert!(!state.should_restart());
    }

    #[test]
    fn test_should_restart_no_pending() {
        let state = SignalState::new();
        assert!(!state.should_restart());
    }

    #[test]
    fn test_sig_ign_discards_pending() {
        let mut state = SignalState::new();
        state.raise(SIGUSR1);
        assert!(state.is_pending(SIGUSR1));
        state.set_handler(SIGUSR1, SignalHandler::Ignore).unwrap();
        assert!(!state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_sig_ign_discards_new_generation_even_while_blocked() {
        let mut state = SignalState::new();
        state.blocked = sig_bit(SIGUSR1);
        state.set_handler(SIGUSR1, SignalHandler::Ignore).unwrap();

        assert!(state.raise(SIGUSR1));
        assert!(!state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_sig_dfl_discards_pending_for_ignored_signal() {
        // SIGCHLD default action is Ignore, so SIG_DFL should discard pending
        let mut state = SignalState::new();
        state
            .set_handler(SIGCHLD, SignalHandler::Handler(42))
            .unwrap();
        state.raise(SIGCHLD);
        assert!(state.is_pending(SIGCHLD));
        state.set_handler(SIGCHLD, SignalHandler::Default).unwrap();
        assert!(!state.is_pending(SIGCHLD));
    }

    #[test]
    fn test_sig_dfl_keeps_pending_for_terminate_signal() {
        // SIGUSR1 default action is Terminate, so SIG_DFL should NOT discard
        let mut state = SignalState::new();
        state.raise(SIGUSR1);
        assert!(state.is_pending(SIGUSR1));
        state.set_handler(SIGUSR1, SignalHandler::Default).unwrap();
        assert!(state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_sig_ign_discards_rt_queue() {
        let mut state = SignalState::new();
        state.raise_with_value(SIGRTMIN, 42);
        state.raise_with_value(SIGRTMIN, 43);
        assert!(state.is_pending(SIGRTMIN));
        state.set_handler(SIGRTMIN, SignalHandler::Ignore).unwrap();
        assert!(!state.is_pending(SIGRTMIN));
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_timer_notifications_are_queued_per_timer() {
        let mut state = SignalState::new();
        state.raise_timer(SIGUSR1, 41, 3);
        state.raise_timer(SIGUSR1, 42, 4);

        let first = state.consume_one(SIGUSR1);
        assert_eq!(first.si_code, -2);
        assert_eq!(first.si_value, 41);
        assert_eq!(first.timer_id, Some(3));
        assert!(state.is_pending(SIGUSR1));

        let second = state.consume_one(SIGUSR1);
        assert_eq!(second.si_code, -2);
        assert_eq!(second.si_value, 42);
        assert_eq!(second.timer_id, Some(4));
        assert!(!state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_removing_one_timer_preserves_other_pending_notification() {
        let mut state = SignalState::new();
        state.raise_timer(SIGUSR1, 41, 3);
        state.raise_timer(SIGUSR1, 42, 4);

        assert!(state.remove_timer_notification(3));
        assert!(state.is_pending(SIGUSR1));
        let remaining = state.consume_one(SIGUSR1);
        assert_eq!(remaining.timer_id, Some(4));
        assert_eq!(remaining.si_value, 42);
        assert!(!state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_timer_and_sigqueue_metadata_do_not_collide() {
        let mut state = SignalState::new();
        state.raise_timer(SIGUSR1, 41, 3);
        state.raise_with_value(SIGUSR1, 99);

        let timer = state.consume_one(SIGUSR1);
        assert_eq!(timer.timer_id, Some(3));
        assert_eq!(timer.si_code, -2);
        assert_eq!(timer.si_value, 41);
        assert!(state.is_pending(SIGUSR1));

        let queued = state.consume_one(SIGUSR1);
        assert_eq!(queued.timer_id, None);
        assert_eq!(queued.si_code, -1);
        assert_eq!(queued.si_value, 99);
        assert!(!state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_removing_timer_preserves_plain_standard_signal() {
        let mut state = SignalState::new();
        state.raise_timer(SIGUSR1, 41, 3);
        state.raise(SIGUSR1);

        assert!(state.remove_timer_notification(3));
        assert!(state.is_pending(SIGUSR1));
        let plain = state.consume_one(SIGUSR1);
        assert_eq!(plain.timer_id, None);
        assert_eq!(plain.si_code, 0);
        assert_eq!(plain.si_value, 0);
        assert!(!state.is_pending(SIGUSR1));
    }

    #[test]
    fn test_block_raise_ignore_unignore_unblock() {
        // Mimics sortix signal/block-raise-ignore-unignore-unblock test
        let mut state = SignalState::new();
        state.blocked = sig_bit(SIGUSR1);
        state.raise(SIGUSR1);
        assert!(state.is_pending(SIGUSR1));
        // SIG_IGN discards pending
        state.set_handler(SIGUSR1, SignalHandler::Ignore).unwrap();
        assert!(!state.is_pending(SIGUSR1));
        // Set a handler — no pending signal to deliver
        state
            .set_handler(SIGUSR1, SignalHandler::Handler(42))
            .unwrap();
        state.blocked = 0;
        assert_eq!(state.deliverable(), 0);
    }
}
