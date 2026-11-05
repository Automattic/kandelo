//! Kernel-owned activation of the exchange agent.
//!
//! The platform starts the image's agent, `/usr/libexec/kandelo/exchange-agent`,
//! when a batch needs a consumer and at no other time. The kernel decides; the
//! host only launches, through the same exec-target and Worker path as a
//! `posix_spawn` child. Linux's `call_usermodehelper` has the same shape.
//!
//! This module is the decision. It learns of events as they happen (a
//! consumer opened or closed `events`, the agent was reaped, a launch failed)
//! and asks the host to call back with the time ([`ActivationCheck`]); the
//! host then calls `kernel_exchange_activate`, which runs [`decide`]. Time
//! only matters there: the backoff after failures (250 ms, doubling, at most
//! 5 s) and the reset once a consumer has been ready for 2 s.
//!
//! The agent's parent is the synthetic init, which reaps it at once (init's
//! SIGCHLD is ignored); the reap reports its status here.
//!
//! [`ActivationCheck`]: super::batches::Notification::ActivationCheck

use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use super::batches::{self, Notification};

/// The platform–image contract: an executable here means the machine accepts
/// files.
pub const AGENT_PATH: &[u8] = b"/usr/libexec/kandelo/exchange-agent";
pub const INITIAL_BACKOFF_MS: u64 = 250;
pub const MAX_BACKOFF_MS: u64 = 5_000;
/// A consumer ready this long clears the failure count.
pub const READY_RESET_MS: u64 = 2_000;

/// Whether the platform may start the agent (the embedder's
/// `exchange.activation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    OnDemand,
}

/// Why the last activation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The agent exited with this status before opening `events`.
    Exit(i32),
    /// A signal ended it before it opened `events`.
    Signal(u32),
    /// Exec failed (ENOENT, EACCES, ENOEXEC, an ABI mismatch, ...).
    Errno(u32),
}

/// What the host shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsumerState {
    /// Activation is on, no executable is at the agent path, and no
    /// consumer holds `events`: offers fail at once.
    Unavailable,
    /// No consumer; an offer activates the agent (or, with activation off,
    /// waits for some consumer).
    Idle,
    /// Activated or backing off; nothing holds `events` yet.
    Starting,
    /// A consumer holds `events`.
    Ready,
}

/// What [`decide`] concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Create the agent's process and have the host launch it.
    Launch,
    Nothing,
}

struct State {
    mode: Mode,
    /// The agent the kernel launched last, until it is reaped.
    agent: Option<u32>,
    /// Launched and not yet seen to open `events`.
    starting: bool,
    failures: u32,
    /// A failure happened; its backoff starts at the next decision.
    backoff_pending: bool,
    backoff_until: Option<u64>,
    /// A consumer opened `events`; its ready time is taken at the next
    /// decision.
    ready_pending: bool,
    ready_since: Option<u64>,
    /// The consumer closed; how long it was ready is measured at the next
    /// decision (the reset rule needs the time).
    closed_pending: bool,
    last_failure: Option<Failure>,
    available: bool,
    reported: Option<(ConsumerState, Mode, Option<Failure>)>,
}

impl State {
    const fn new() -> Self {
        State {
            mode: Mode::Off,
            agent: None,
            starting: false,
            failures: 0,
            backoff_pending: false,
            backoff_until: None,
            ready_pending: false,
            ready_since: None,
            closed_pending: false,
            last_failure: None,
            available: false,
            reported: None,
        }
    }
}

struct Global {
    locked: AtomicBool,
    state: UnsafeCell<State>,
}

// SAFETY: `locked` serializes every access; no reference escapes `with`.
unsafe impl Sync for Global {}

static GLOBAL: Global = Global { locked: AtomicBool::new(false), state: UnsafeCell::new(State::new()) };

/// Lock order: this, then batches (notifications are pushed under it).
fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    while GLOBAL
        .locked
        .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        spin_loop();
    }
    struct Unlock;
    impl Drop for Unlock {
        fn drop(&mut self) {
            GLOBAL.locked.store(false, Ordering::Release);
        }
    }
    let _unlock = Unlock;
    // SAFETY: see `Global`.
    f(unsafe { &mut *GLOBAL.state.get() })
}

/// Set the embedder's choice, once at boot.
pub fn configure(mode: Mode) {
    with(|state| state.mode = mode);
    request_check();
}

pub fn mode() -> Mode {
    with(|state| state.mode)
}

/// Ask the host for a decision soon: something activation depends on changed.
pub fn request_check() {
    batches::push_notification(Notification::ActivationCheck);
}

/// A consumer opened `events`.
pub fn on_consumer_open() {
    with(|state| {
        state.starting = false;
        state.ready_pending = true;
    });
    request_check();
}

/// The consumer's description went away.
pub fn on_consumer_close() {
    with(|state| state.closed_pending = true);
    request_check();
}

/// A child of init was reaped. Only the agent matters: exiting before it
/// opened `events` is a failure.
pub fn on_reaped(pid: u32, exit_status: i32, exit_signal: u32) {
    let relevant = with(|state| {
        if state.agent != Some(pid) {
            return false;
        }
        state.agent = None;
        if state.starting {
            state.starting = false;
            fail(state, if exit_signal != 0 { Failure::Signal(exit_signal) } else { Failure::Exit(exit_status) });
        }
        true
    });
    if relevant {
        request_check();
    }
}

/// The host could not launch the agent (its process record is gone).
pub fn on_launch_failed(pid: u32, errno: u32) {
    let relevant = with(|state| {
        if state.agent != Some(pid) {
            return false;
        }
        state.agent = None;
        state.starting = false;
        fail(state, Failure::Errno(errno));
        true
    });
    if relevant {
        request_check();
    }
}

fn fail(state: &mut State, failure: Failure) {
    state.failures = state.failures.saturating_add(1);
    state.last_failure = Some(failure);
    state.backoff_pending = true;
}

/// The agent's process exists and the host is launching it.
pub fn launched(pid: u32) {
    with(|state| {
        state.agent = Some(pid);
        state.starting = true;
    });
}

/// Creating the agent's process failed in the kernel itself.
pub fn on_create_failed(errno: u32) {
    with(|state| fail(state, Failure::Errno(errno)));
    request_check();
}

fn backoff_ms(failures: u32) -> u64 {
    let doublings = failures.saturating_sub(1).min(16);
    (INITIAL_BACKOFF_MS << doublings).min(MAX_BACKOFF_MS)
}

/// Decide at `now_ms`. `agent_available` is whether an executable is at
/// [`AGENT_PATH`]; `awaiting_consumer` whether a batch waits for one.
pub fn decide(now_ms: u64, agent_available: bool, awaiting_consumer: bool, consumer_present: bool) -> Decision {
    let (decision, report) = with(|state| {
        state.available = agent_available;
        if state.ready_pending {
            state.ready_pending = false;
            state.ready_since = Some(now_ms);
        }
        if state.ready_since.is_some_and(|since| now_ms.saturating_sub(since) >= READY_RESET_MS) {
            state.failures = 0;
        }
        if state.closed_pending {
            state.closed_pending = false;
            state.ready_since = None;
        }
        if state.backoff_pending {
            state.backoff_pending = false;
            let delay = backoff_ms(state.failures);
            state.backoff_until = Some(now_ms + delay);
            batches::push_notification(Notification::ActivationTimer { delay_ms: delay as u32 });
        }
        if state.backoff_until.is_some_and(|until| now_ms >= until) {
            state.backoff_until = None;
        }
        let decision = if state.mode == Mode::OnDemand
            && agent_available
            && awaiting_consumer
            && !consumer_present
            && !state.starting
            && state.backoff_until.is_none()
        {
            Decision::Launch
        } else {
            Decision::Nothing
        };
        (decision, current(state, consumer_present, decision))
    });
    if let Some((consumer, mode, failure)) = report {
        batches::push_notification(Notification::ConsumerState { state: consumer, mode, failure });
    }
    decision
}

/// The state to report, if it changed since the last report.
fn current(state: &mut State, consumer_present: bool, decision: Decision) -> Option<(ConsumerState, Mode, Option<Failure>)> {
    let consumer = if consumer_present {
        ConsumerState::Ready
    } else if state.starting || decision == Decision::Launch || state.backoff_until.is_some() {
        ConsumerState::Starting
    } else if state.mode == Mode::OnDemand && !state.available {
        ConsumerState::Unavailable
    } else {
        ConsumerState::Idle
    };
    let now = (consumer, state.mode, state.last_failure);
    if state.reported == Some(now) {
        None
    } else {
        state.reported = Some(now);
        Some(now)
    }
}

/// Forget everything. Kernel teardown and tests.
pub fn reset() {
    with(|state| *state = State::new());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exchange::batches::tests::TestGuard;
    use crate::exchange::batches::take_notifications;

    fn reports() -> alloc::vec::Vec<Notification> {
        take_notifications()
            .into_iter()
            .filter(|note| matches!(note, Notification::ConsumerState { .. } | Notification::ActivationTimer { .. }))
            .collect()
    }

    #[test]
    fn it_launches_only_when_a_batch_waits_and_nothing_consumes() {
        let _guard = TestGuard::acquire();
        reset();
        configure(Mode::OnDemand);
        assert_eq!(decide(0, true, false, false), Decision::Nothing, "nothing waits");
        assert_eq!(decide(0, true, true, true), Decision::Nothing, "a consumer exists");
        assert_eq!(decide(0, false, true, false), Decision::Nothing, "no agent");
        assert!(reports().contains(&Notification::ConsumerState {
            state: ConsumerState::Unavailable,
            mode: Mode::OnDemand,
            failure: None,
        }));
        assert_eq!(decide(0, true, true, false), Decision::Launch);
        launched(42);
        assert_eq!(decide(1, true, true, false), Decision::Nothing, "already starting");
        on_consumer_open();
        assert_eq!(decide(2, true, false, true), Decision::Nothing);
        assert!(reports().contains(&Notification::ConsumerState {
            state: ConsumerState::Ready,
            mode: Mode::OnDemand,
            failure: None,
        }));
        configure(Mode::Off);
        on_consumer_close();
        assert_eq!(decide(3, true, true, false), Decision::Nothing, "activation off");
        reset();
    }

    #[test]
    fn failures_back_off_doubling_to_five_seconds_and_reset_once_ready() {
        let _guard = TestGuard::acquire();
        reset();
        configure(Mode::OnDemand);
        let mut now = 0;
        let mut delays = alloc::vec::Vec::new();
        for pid in 10..17 {
            assert_eq!(decide(now, true, true, false), Decision::Launch, "attempt {pid}");
            launched(pid);
            on_reaped(pid, 1, 0);
            assert_eq!(decide(now, true, true, false), Decision::Nothing, "backing off");
            let delay = reports()
                .into_iter()
                .find_map(|note| match note {
                    Notification::ActivationTimer { delay_ms } => Some(delay_ms),
                    _ => None,
                })
                .unwrap();
            delays.push(delay);
            now += u64::from(delay);
        }
        assert_eq!(delays, [250, 500, 1000, 2000, 4000, 5000, 5000]);

        // An agent that became ready for 2 s clears the count.
        assert_eq!(decide(now, true, true, false), Decision::Launch);
        launched(20);
        on_consumer_open();
        decide(now, true, false, true);
        decide(now + READY_RESET_MS, true, false, true);
        on_consumer_close();
        on_reaped(20, 0, 0);
        assert_eq!(decide(now + READY_RESET_MS, true, true, false), Decision::Launch, "a ready exit is no failure");
        launched(21);
        on_launch_failed(21, 8);
        decide(now + READY_RESET_MS, true, true, false);
        assert!(reports().contains(&Notification::ActivationTimer { delay_ms: 250 }));
        reset();
    }

    #[test]
    fn a_consumer_ready_for_two_seconds_clears_failures_even_after_it_exits() {
        let _guard = TestGuard::acquire();
        reset();
        configure(Mode::OnDemand);
        // Three failures build up a backoff.
        let mut now = 0;
        for pid in 40..43 {
            assert_eq!(decide(now, true, true, false), Decision::Launch);
            launched(pid);
            on_reaped(pid, 1, 0);
            decide(now, true, true, false);
            now += 10_000;
        }
        reports();
        // An agent becomes ready, runs 60 s, closes events and exits: no
        // decision ran while it was ready.
        assert_eq!(decide(now, true, true, false), Decision::Launch);
        launched(50);
        on_consumer_open();
        decide(now, true, false, true);
        now += 60_000;
        on_consumer_close();
        on_reaped(50, 0, 0);
        decide(now, true, false, false);
        // The next failure starts the backoff over.
        assert_eq!(decide(now, true, true, false), Decision::Launch);
        launched(51);
        on_reaped(51, 1, 0);
        decide(now, true, true, false);
        assert!(reports().contains(&Notification::ActivationTimer { delay_ms: 250 }));
        reset();
    }

    #[test]
    fn other_children_of_init_do_not_count() {
        let _guard = TestGuard::acquire();
        reset();
        configure(Mode::OnDemand);
        assert_eq!(decide(0, true, true, false), Decision::Launch);
        launched(30);
        on_reaped(31, 1, 0);
        assert_eq!(decide(0, true, true, false), Decision::Nothing, "still starting");
        reset();
    }
}
