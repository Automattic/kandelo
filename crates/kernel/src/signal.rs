extern crate alloc;

/// Per-signal handler configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalHandler {
    Default,
    Ignore,
    Handler(u32), // Function pointer (index) in guest Wasm -- for future use
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

/// Per-process signal state.
pub struct SignalState {
    /// Handler for each signal (indexed by signal number, 0 unused).
    handlers: [SignalHandler; 64],
    /// Bitmask of blocked signals.
    pub blocked: u64,
    /// Bitmask of pending signals.
    pub pending: u64,
}

impl SignalState {
    pub fn new() -> Self {
        SignalState {
            handlers: [SignalHandler::Default; 64],
            blocked: 0,
            pending: 0,
        }
    }

    /// Get the handler for a signal.
    pub fn get_handler(&self, signum: u32) -> SignalHandler {
        if signum == 0 || signum >= 64 {
            return SignalHandler::Default;
        }
        self.handlers[signum as usize]
    }

    /// Set the handler for a signal. Returns the old handler.
    /// SIGKILL and SIGSTOP cannot have their handlers changed (POSIX).
    pub fn set_handler(&mut self, signum: u32, handler: SignalHandler) -> Result<SignalHandler, ()> {
        use wasm_posix_shared::signal::*;
        if signum == 0 || signum >= 64 {
            return Err(());
        }
        if signum == SIGKILL || signum == SIGSTOP {
            return Err(());
        }
        let old = self.handlers[signum as usize];
        self.handlers[signum as usize] = handler;
        Ok(old)
    }

    /// Mark a signal as pending.
    pub fn raise(&mut self, signum: u32) -> bool {
        if signum == 0 || signum >= 64 {
            return false;
        }
        self.pending |= 1u64 << signum;
        true
    }

    /// Clear a pending signal.
    pub fn clear(&mut self, signum: u32) {
        if signum > 0 && signum < 64 {
            self.pending &= !(1u64 << signum);
        }
    }

    /// Check if a signal is pending.
    pub fn is_pending(&self, signum: u32) -> bool {
        if signum >= 64 { return false; }
        (self.pending & (1u64 << signum)) != 0
    }

    /// Check if a signal is blocked.
    pub fn is_blocked(&self, signum: u32) -> bool {
        if signum >= 64 { return false; }
        (self.blocked & (1u64 << signum)) != 0
    }

    /// Get the set of pending, unblocked signals.
    pub fn deliverable(&self) -> u64 {
        self.pending & !self.blocked
    }

    /// Reconstruct signal state from parts. Used by fork deserialization.
    /// Pending signals are cleared (per POSIX, child starts with no pending signals).
    pub fn from_parts(handlers: [SignalHandler; 64], blocked: u64) -> Self {
        SignalState { handlers, blocked, pending: 0 }
    }

    /// Reconstruct signal state for exec. Preserves pending signals (POSIX).
    pub fn from_parts_with_pending(handlers: [SignalHandler; 64], blocked: u64, pending: u64) -> Self {
        SignalState { handlers, blocked, pending }
    }

    /// Get the raw handlers array for serialization.
    pub fn handlers(&self) -> &[SignalHandler; 64] {
        &self.handlers
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
        state.blocked = 1u64 << SIGINT;
        assert!(state.is_blocked(SIGINT));
        assert!(!state.is_blocked(SIGTERM));
    }

    #[test]
    fn test_deliverable_excludes_blocked() {
        let mut state = SignalState::new();
        state.raise(SIGINT);
        state.raise(SIGTERM);
        state.blocked = 1u64 << SIGINT;
        let d = state.deliverable();
        assert_eq!(d & (1u64 << SIGINT), 0); // blocked
        assert_ne!(d & (1u64 << SIGTERM), 0); // not blocked
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
        let handlers = [SignalHandler::Default; 64];
        let state = SignalState::from_parts(handlers, 0x0000_0004);
        assert_eq!(state.blocked, 0x0000_0004);
        assert_eq!(state.pending, 0); // always cleared for fork
    }

    #[test]
    fn test_from_parts_with_pending_preserves_pending() {
        let handlers = [SignalHandler::Default; 64];
        let state = SignalState::from_parts_with_pending(handlers, 0x0000_0004, 0x0000_0008);
        assert_eq!(state.blocked, 0x0000_0004);
        assert_eq!(state.pending, 0x0000_0008);
    }

    #[test]
    fn test_handlers_accessor() {
        let mut state = SignalState::new();
        state.set_handler(SIGINT, SignalHandler::Ignore).unwrap();
        let handlers = state.handlers();
        assert_eq!(handlers[SIGINT as usize], SignalHandler::Ignore);
        assert_eq!(handlers[SIGTERM as usize], SignalHandler::Default);
    }
}
