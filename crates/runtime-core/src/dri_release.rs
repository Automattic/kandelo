//! Retained final-device effects. A returned legacy void callback is not an ACK.
//!
//! This internal HostIO contract is not wired to a Wasm import or public parking.
//! The original ordered effects remain owned until exact retirement and metadata
//! release have both been acknowledged. Unknown admission is polled, never replayed.
use alloc::vec::Vec;
use core::sync::atomic::{AtomicU64, Ordering};

use crate::{process::HostIO, syscalls::DriReleaseEffect};
use wasm_posix_shared::Errno;

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DriReleaseOwner {
    pub pid: u32,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DriReleaseControl {
    Begin,
    Poll,
    Forget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DriReleasePhase {
    Pending,
    /// No final effects were accepted. This is NOT retirement authority.
    Rejected(Errno),
    Retired,
    /// Only a Forget after an authenticated Retired may consume this ACK.
    Forgotten,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DriReleaseReply {
    pub token: u64,
    pub phase: DriReleasePhase,
}

pub struct DriReleaseRequest<'a> {
    pub owner: DriReleaseOwner,
    pub token: u64,
    pub control: DriReleaseControl,
    /// The same immutable plan is supplied on every control. It never borrows
    /// process memory or resolves a replacement fd, session or BO.
    pub effects: &'a [DriReleaseEffect],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DriReleaseProgress {
    Pending,
    /// The original host record may exist. Only Poll/Forget may follow.
    Uncertain,
    Rejected(Errno),
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum State {
    New,
    Polling,
    Forgetting,
    Rejected(Errno),
    Complete,
}

#[must_use = "final-device effects need an actual acknowledged receiver"]
pub struct DriReleaseTransaction {
    owner: DriReleaseOwner,
    token: u64,
    effects: Vec<DriReleaseEffect>,
    state: State,
}

impl DriReleaseTransaction {
    /// Failure returns the actual effects; allocation/token refusal never drops
    /// a consumed final-reference obligation.
    pub fn new(
        owner: DriReleaseOwner,
        effects: Vec<DriReleaseEffect>,
    ) -> Result<Self, (Errno, Vec<DriReleaseEffect>)> {
        if effects.is_empty() {
            return Ok(Self {
                owner,
                token: 0,
                effects,
                state: State::Complete,
            });
        }
        let token = match NEXT_TOKEN.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < i64::MAX as u64).then_some(n + 1)
        }) {
            Ok(token) => token,
            Err(_) => return Err((Errno::EOVERFLOW, effects)),
        };
        Ok(Self {
            owner,
            token,
            effects,
            state: State::New,
        })
    }

    pub fn is_complete(&self) -> bool {
        self.state == State::Complete
    }

    pub fn step(&mut self, host: &mut dyn HostIO) -> DriReleaseProgress {
        let control = match self.state {
            State::New => DriReleaseControl::Begin,
            State::Polling => DriReleaseControl::Poll,
            State::Forgetting => DriReleaseControl::Forget,
            State::Rejected(error) => return DriReleaseProgress::Rejected(error),
            State::Complete => return DriReleaseProgress::Complete,
        };
        // Record BEFORE HostIO, including a trap or lost response. Never Begin
        // a second time or fall back to the numeric legacy destruction path.
        if control == DriReleaseControl::Begin {
            self.state = State::Polling;
        }
        let Ok(reply) = host.dri_release_control(DriReleaseRequest {
            owner: self.owner,
            token: self.token,
            control,
            effects: &self.effects,
        }) else {
            return DriReleaseProgress::Uncertain;
        };
        if reply.token != self.token {
            return DriReleaseProgress::Uncertain;
        }
        match (control, reply.phase) {
            (DriReleaseControl::Begin | DriReleaseControl::Poll, DriReleasePhase::Pending) => {
                DriReleaseProgress::Pending
            }
            (
                DriReleaseControl::Begin | DriReleaseControl::Poll,
                DriReleasePhase::Rejected(error),
            ) => {
                self.state = State::Rejected(error);
                DriReleaseProgress::Rejected(error)
            }
            (DriReleaseControl::Begin | DriReleaseControl::Poll, DriReleasePhase::Retired) => {
                self.state = State::Forgetting;
                DriReleaseProgress::Pending
            }
            (DriReleaseControl::Forget, DriReleasePhase::Forgotten) => {
                self.state = State::Complete;
                DriReleaseProgress::Complete
            }
            _ => DriReleaseProgress::Uncertain,
        }
    }
}
