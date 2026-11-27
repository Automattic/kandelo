//! What a parked `kandelo.kgpu.v1` wait waits for, and which kgpu wake
//! sources can change its answer.
//!
//! Ownership: the GPU device (`super`) parks waiting callers in the kernel's
//! one parking owner (`crate::wait_park`) and decides their results; this
//! module is the small vocabulary both sides share. It exists so the parking
//! owner can select kgpu parks for the device's settle pass without knowing
//! any device state: the device answers, `wait_park` only routes.
//!
//! Only waits park here. A submission that finds the outbox full commits
//! nothing and answers `EAGAIN` for the host to re-execute (Ruling R13), so
//! its outputs reach the guest through the ordinary output path.

use crate::wait_queue::WakeSource;

/// One parked `KGPU_OP_WAIT`, carried by `wait_park::Resume::Kgpu`: it ends
/// when `context` retires `seqno`, is lost or destroyed, a caught signal
/// arrives, or the deadline passes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KgpuPark {
    pub device: u32,
    pub context: u32,
    pub seqno: u64,
}

impl KgpuPark {
    /// The source this park registers with the wait queue.
    pub fn source(&self) -> WakeSource {
        WakeSource::KgpuSeqno {
            device: self.device,
            context: self.context,
            seqno: self.seqno,
        }
    }

    /// Whether a fired source can change this park's answer. Retirement is
    /// cumulative per context, so retiring `s` concerns every waiter at or
    /// below `s`; loss and destruction fire `u64::MAX`.
    pub fn concerned_by(&self, fired: WakeSource) -> bool {
        match fired {
            WakeSource::KgpuSeqno {
                device,
                context,
                seqno,
            } => device == self.device && context == self.context && self.seqno <= seqno,
            _ => false,
        }
    }
}

/// Whether `source` is one of the GPU device's (its settle pass consumes it,
/// not the generic re-execution pass).
pub fn is_kgpu_source(source: WakeSource) -> bool {
    matches!(source, WakeSource::KgpuSeqno { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retirement_concerns_waiters_at_or_below_it_on_its_own_context() {
        let wait = KgpuPark {
            device: 0,
            context: 3,
            seqno: 5,
        };
        let fired = |context, seqno| WakeSource::KgpuSeqno {
            device: 0,
            context,
            seqno,
        };
        assert!(wait.concerned_by(fired(3, 5)));
        assert!(wait.concerned_by(fired(3, 9)));
        assert!(wait.concerned_by(fired(3, u64::MAX)));
        assert!(!wait.concerned_by(fired(3, 4)));
        assert!(!wait.concerned_by(fired(4, 9)));
        assert!(!wait.concerned_by(WakeSource::KgpuSeqno {
            device: 1,
            context: 3,
            seqno: 9
        }));
        assert!(!wait.concerned_by(WakeSource::AdvisoryLock));
        assert!(is_kgpu_source(wait.source()));
        assert!(!is_kgpu_source(WakeSource::AdvisoryLock));
    }
}
