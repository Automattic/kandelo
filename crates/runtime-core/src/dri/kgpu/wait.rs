//! What a parked `kandelo.kgpu.v1` call waits for, and which kgpu wake
//! sources can change its answer.
//!
//! Ownership: the GPU device (`super`) parks callers in the kernel's one
//! parking owner (`crate::wait_park`) and decides their results; this module
//! is the small vocabulary both sides share. It exists so the parking owner
//! can select kgpu parks for the device's settle pass without knowing any
//! device state: the device answers, `wait_park` only routes.

use crate::wait_queue::WakeSource;

/// One parked kgpu call, carried by `wait_park::Resume::Kgpu`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KgpuPark {
    /// `KGPU_OP_WAIT`: until `context` retires `seqno`, is lost or
    /// destroyed, a caught signal arrives, or the deadline passes.
    Wait {
        device: u32,
        context: u32,
        seqno: u64,
    },
    /// `KGPU_OP_SUBMIT` whose record waits in the device's backlog because
    /// the outbox was full. The submission is already committed (its seqno
    /// assigned and its frames pinned); the park is backpressure only.
    Submit { device: u32, seqno: u64 },
}

impl KgpuPark {
    /// The source this park registers with the wait queue.
    pub fn source(&self) -> WakeSource {
        match *self {
            KgpuPark::Wait {
                device,
                context,
                seqno,
            } => WakeSource::KgpuSeqno {
                device,
                context,
                seqno,
            },
            KgpuPark::Submit { device, .. } => WakeSource::KgpuOutbox { device },
        }
    }

    /// Whether a fired source can change this park's answer. Retirement is
    /// cumulative per context, so retiring `s` concerns every waiter at or
    /// below `s`; loss and destruction fire `u64::MAX`.
    pub fn concerned_by(&self, fired: WakeSource) -> bool {
        match (*self, fired) {
            (
                KgpuPark::Wait {
                    device,
                    context,
                    seqno,
                },
                WakeSource::KgpuSeqno {
                    device: d,
                    context: c,
                    seqno: s,
                },
            ) => device == d && context == c && seqno <= s,
            (KgpuPark::Submit { device, .. }, WakeSource::KgpuOutbox { device: d }) => device == d,
            _ => false,
        }
    }

    /// Whether a caught signal ends the park (with `EINTR`).
    ///
    /// A held submission is not interruptible: it is already committed, so
    /// `EINTR` would tell the driver a queued submission failed, and
    /// returning early would let a signal storm grow the backlog without
    /// bound. The signal stays pending until the outbox admits the record.
    pub fn signal_interrupts(&self) -> bool {
        matches!(self, KgpuPark::Wait { .. })
    }
}

/// Whether `source` is one of the GPU device's (its settle pass consumes it,
/// not the generic re-execution pass).
pub fn is_kgpu_source(source: WakeSource) -> bool {
    matches!(
        source,
        WakeSource::KgpuSeqno { .. } | WakeSource::KgpuOutbox { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retirement_concerns_waiters_at_or_below_it_on_its_own_context() {
        let wait = KgpuPark::Wait {
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
        assert!(!wait.concerned_by(WakeSource::KgpuOutbox { device: 0 }));
        let submit = KgpuPark::Submit {
            device: 0,
            seqno: 2,
        };
        assert!(submit.concerned_by(WakeSource::KgpuOutbox { device: 0 }));
        assert!(!submit.concerned_by(fired(3, 9)));
        assert!(wait.signal_interrupts());
        assert!(!submit.signal_interrupts());
        assert!(is_kgpu_source(wait.source()) && is_kgpu_source(submit.source()));
        assert!(!is_kgpu_source(WakeSource::AdvisoryLock));
    }
}
