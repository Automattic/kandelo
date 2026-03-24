use wasm_posix_shared::signal::NSIG;
extern crate alloc;

use alloc::collections::VecDeque;

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
    CoreDump,  // Treated as terminate in Wasm
    Stop,      // Not supported in Wasm
    Continue,  // Not supported in Wasm
}

/// Get the POSIX default action for a signal number.
pub fn default_action(signum: u32) -> DefaultAction {
    use wasm_posix_shared::signal::*;
    match signum {
        SIGHUP | SIGINT | SIGQUIT | SIGILL | SIGTRAP | SIGABRT |
        SIGBUS | SIGFPE | SIGKILL | SIGUSR1 | SIGUSR2 | SIGPIPE |
        SIGALRM | SIGTERM => DefaultAction::Terminate,
        SIGCHLD | SIGWINCH => DefaultAction::Ignore,
        SIGCONT => DefaultAction::Continue,
        SIGSTOP | SIGTSTP => DefaultAction::Stop,
        // Unrecognized signals default to terminate
        _ if signum >= 1 && signum < NSIG => DefaultAction::Terminate,
        _ => DefaultAction::Terminate,
    }
}

/// Queued RT signal entry: signal number + optional si_value.
#[derive(Debug, Clone, Copy)]
pub struct RtSigEntry {
    pub signum: u32,
    pub si_value: i32,
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
    pub fn set_handler(&mut self, signum: u32, handler: SignalHandler) -> Result<SignalHandler, ()> {
        use wasm_posix_shared::signal::*;
        if signum == 0 || signum >= 65 {
            return Err(());
        }
        if signum == SIGKILL || signum == SIGSTOP {
            return Err(());
        }
        let old = self.actions[signum as usize].handler;
        self.actions[signum as usize].handler = handler;
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
        Ok(old)
    }

    /// Mark a signal as pending.
    /// Standard signals (1-31) are coalesced. RT signals (32-63) are queued.
    /// Bit position = signum - 1 (musl convention: signal N uses bit N-1).
    pub fn raise(&mut self, signum: u32) -> bool {
        self.raise_with_value(signum, 0)
    }

    /// Mark a signal as pending with an si_value (for sigqueue).
    pub fn raise_with_value(&mut self, signum: u32, si_value: i32) -> bool {
        if signum == 0 || signum >= 65 {
            return false;
        }
        self.pending |= sig_bit(signum);
        if signum >= SIGRTMIN {
            self.rt_queue.push_back(RtSigEntry { signum, si_value });
        }
        true
    }

    /// Clear a pending signal.
    /// For RT signals, removes all queued instances and clears the pending bit.
    pub fn clear(&mut self, signum: u32) {
        if signum > 0 && signum < NSIG {
            self.pending &= !sig_bit(signum);
            if signum >= SIGRTMIN {
                self.rt_queue.retain(|e| e.signum != signum);
            }
        }
    }

    /// Check if a signal is pending.
    pub fn is_pending(&self, signum: u32) -> bool {
        if signum >= 65 { return false; }
        (self.pending & sig_bit(signum)) != 0
    }

    /// Return the raw pending signal bitmask.
    pub fn pending_mask(&self) -> u64 {
        self.pending
    }

    /// Clear a signal from the pending set.
    /// For RT signals, removes all queued instances and clears the pending bit.
    pub fn clear_pending(&mut self, signum: u32) {
        if signum > 0 && signum < NSIG {
            self.pending &= !sig_bit(signum);
            if signum >= SIGRTMIN {
                self.rt_queue.retain(|e| e.signum != signum);
            }
        }
    }

    /// Consume one instance of a pending signal (for sigwaitinfo/sigtimedwait).
    /// Unlike dequeue(), this works on any pending signal regardless of blocked mask.
    /// For RT signals, removes one queued instance; clears pending bit only when
    /// no more instances remain. For standard signals, clears the pending bit.
    /// Returns the si_value of the consumed RT signal instance (0 for standard signals).
    pub fn consume_one(&mut self, signum: u32) -> i32 {
        if signum == 0 || signum >= NSIG { return 0; }
        if signum >= SIGRTMIN {
            let mut si_value = 0i32;
            if let Some(pos) = self.rt_queue.iter().position(|e| e.signum == signum) {
                si_value = self.rt_queue[pos].si_value;
                self.rt_queue.remove(pos);
            }
            if !self.rt_queue.iter().any(|e| e.signum == signum) {
                self.pending &= !sig_bit(signum);
            }
            si_value
        } else {
            self.pending &= !sig_bit(signum);
            0
        }
    }

    /// Check if a signal is blocked.
    pub fn is_blocked(&self, signum: u32) -> bool {
        if signum >= 65 { return false; }
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
    /// Returns (signum, si_value). si_value is 0 for standard signals.
    pub fn dequeue(&mut self) -> Option<(u32, i32)> {
        let deliverable = self.pending & !self.blocked;
        if deliverable == 0 {
            return None;
        }
        // trailing_zeros gives 0-based bit position; signal number = bit + 1
        let signum = deliverable.trailing_zeros() + 1;
        let mut si_value = 0i32;
        if signum >= SIGRTMIN {
            // RT signal: dequeue one instance from the queue
            if let Some(pos) = self.rt_queue.iter().position(|e| e.signum == signum) {
                si_value = self.rt_queue[pos].si_value;
                self.rt_queue.remove(pos);
            }
            // Only clear the pending bit if no more instances remain
            if !self.rt_queue.iter().any(|e| e.signum == signum) {
                self.pending &= !sig_bit(signum);
            }
        } else {
            // Standard signal: clear from pending bitmask
            self.pending &= !sig_bit(signum);
        }
        Some((signum, si_value))
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
        SignalState { actions, blocked, pending: 0, rt_queue: VecDeque::new() }
    }

    /// Reconstruct signal state for exec. Preserves pending signals (POSIX).
    pub fn from_parts_with_pending(handlers: [SignalHandler; 65], blocked: u64, pending: u64) -> Self {
        let mut actions = [SignalAction::default(); 65];
        for (i, h) in handlers.iter().enumerate() {
            actions[i].handler = *h;
        }
        // Reconstruct RT queue from pending bits (one instance per signal)
        let mut rt_queue = VecDeque::new();
        for sig in SIGRTMIN..SIGRTMAX_PLUS1 {
            if (pending & sig_bit(sig)) != 0 {
                rt_queue.push_back(RtSigEntry { signum: sig, si_value: 0 });
            }
        }
        SignalState { actions, blocked, pending, rt_queue }
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
        state.raise(SIGINT);  // 2
        state.raise(SIGUSR1); // 10
        // Should dequeue lowest first (SIGINT=2)
        assert_eq!(state.dequeue(), Some((SIGINT, 0)));
        assert_eq!(state.dequeue(), Some((SIGUSR1, 0)));
        assert_eq!(state.dequeue(), Some((SIGTERM, 0)));
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
        assert_eq!(sig, Some((SIGINT, 0)));
        assert!(!state.is_pending(SIGINT));
    }

    #[test]
    fn test_dequeue_skips_blocked_signals() {
        let mut state = SignalState::new();
        state.raise(SIGINT);  // 2 - blocked
        state.raise(SIGTERM); // 15 - not blocked
        state.blocked = sig_bit(SIGINT);
        // Should skip SIGINT and return SIGTERM
        assert_eq!(state.dequeue(), Some((SIGTERM, 0)));
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
        state.set_handler(SIGINT, SignalHandler::Handler(10)).unwrap();
        state.raise(SIGINT);
        assert!(!state.should_restart());
    }

    #[test]
    fn test_should_restart_no_pending() {
        let state = SignalState::new();
        assert!(!state.should_restart());
    }
}
