//! Owned GL query admission and copyout, shared by immediate queries and the
//! retained-target lifecycle. The owned control engine remains disconnected
//! from public pending dispatch until every host and teardown path is wired.

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::{Errno, gl};

use crate::blocked_retry::StableOfdTarget;
use crate::process::HostIO;

/// Scalar authority captured after the ioctl's session/current validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GlQueryOwner {
    pub target: StableOfdTarget,
    pub pid: i32,
    pub exec_generation: u64,
    pub tid: u32,
    pub session_id: u32,
    pub display_id: u32,
    pub context_id: Option<u32>,
    pub draw_surface_id: Option<u32>,
    pub read_surface_id: Option<u32>,
    pub pointer_width: u8,
}

#[derive(Debug)]
enum Completion {
    Captured,
    Executed(usize),
    Published,
    Failed,
}

/// One immutable first-attempt request. All byte storage belongs to the kernel;
/// addresses are integers, never a borrowed guest-memory or scratch view.
pub struct GlQueryRequest {
    owner: GlQueryOwner,
    op: u32,
    input: Vec<u8>,
    output_address: u64,
    output: Vec<u8>,
    completion: Completion,
    receipt: Option<OwnedReceipt>,
}

impl GlQueryRequest {
    pub fn new(
        owner: GlQueryOwner,
        op: u32,
        input: Vec<u8>,
        output_address: u64,
        output_capacity: usize,
    ) -> Result<Self, Errno> {
        if op == gl::KERNEL_GL_QUERY_CONTROL
            || !matches!(owner.pointer_width, 4 | 8)
            || input.len() > gl::MAX_QUERY_IN_LEN as usize
            || output_capacity > gl::MAX_QUERY_OUT_LEN as usize
        {
            return Err(Errno::EINVAL);
        }
        let mut output = Vec::new();
        output
            .try_reserve_exact(output_capacity)
            .map_err(|_| Errno::ENOMEM)?;
        output.resize(output_capacity, 0);
        Ok(Self {
            owner,
            op,
            input,
            output_address,
            output,
            completion: Completion::Captured,
            receipt: None,
        })
    }

    pub(crate) fn is_captured(&self) -> bool {
        matches!(self.completion, Completion::Captured) && self.receipt.is_none()
    }

    pub fn owner(&self) -> &GlQueryOwner {
        &self.owner
    }
    pub fn operation(&self) -> u32 {
        self.op
    }
    pub fn input(&self) -> &[u8] {
        &self.input
    }
    pub fn output_address(&self) -> u64 {
        self.output_address
    }
    pub fn output_capacity(&self) -> usize {
        self.output.len()
    }

    /// The existing immediate host contract finishes before returning. A
    /// negative result, including EAGAIN, remains EIO; it does not authorize
    /// retaining a host destination or replaying a potentially mutating query.
    pub fn execute_immediate(&mut self, host: &mut dyn HostIO) -> Result<(), Errno> {
        if !self.is_captured() {
            return Err(Errno::EBUSY);
        }
        self.completion = Completion::Failed;
        let written = host.gl_query(
            self.owner.pid,
            self.op,
            &self.input,
            &mut self.output,
            self.owner.session_id,
        );
        if written < 0 || written as usize > self.output.len() {
            return Err(Errno::EIO);
        }
        self.completion = Completion::Executed(written as usize);
        Ok(())
    }

    /// Reacquire destination authority at publication, rather than treating a
    /// first-attempt probe as a lease across a future parked turn. Failure is
    /// terminal for this result: an error-consuming query must not run again.
    pub fn publish_immediate(&mut self, host: &mut dyn HostIO) -> Result<(), Errno> {
        let Completion::Executed(written) = self.completion else {
            return Err(Errno::EINVAL);
        };
        self.completion = Completion::Failed;
        if !self.output.is_empty() {
            crate::syscalls::probe_dri_process_pointer(
                host,
                self.owner.pid,
                self.output_address,
                self.output.len(),
            )?;
        }
        crate::syscalls::write_dri_bytes(
            host,
            self.owner.pid,
            self.output_address,
            &self.output[..written],
        )?;
        self.completion = Completion::Published;
        Ok(())
    }
}

use crate::gl_query_receipt::{self as wire, Control, Mode, Reply};

/// Internal scheduler disposition. None of these variants authorizes a public
/// EAGAIN return, resource release, or kernel-worker channel retirement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GlQueryProgress {
    PendingOwned,
    /// Transport/protocol failure is not proof of rejection or cleanup. The
    /// exact request and OFD remain owned; cancellation/preflight may retry.
    ProtocolFaultOwned,
    /// Native custody is proven retired (or Begin proved no admission). A
    /// Forget attempt has occurred after a terminal ACK; the binding may retire.
    Complete(core::result::Result<(), Errno>),
}
#[derive(Clone, Copy)]
enum ReceiptPhase {
    Begin,
    Poll,
    Retiring {
        mode: Mode,
        outcome: core::result::Result<(), Errno>,
    },
    Done(core::result::Result<(), Errno>),
}
struct OwnedReceipt {
    token: u64,
    begin: Vec<u8>,
    control: [u8; wire::REQUEST_HEADER],
    reply: Vec<u8>,
    phase: ReceiptPhase,
}
fn receipt_codec_errno(error: wire::CodecError) -> Errno {
    match error {
        wire::CodecError::Allocation => Errno::ENOMEM,
        _ => Errno::EINVAL,
    }
}

impl GlQueryRequest {
    pub(crate) fn owned_completion(&self) -> Option<Result<(), Errno>> {
        match self.receipt.as_ref()?.phase {
            ReceiptPhase::Done(outcome) => Some(outcome),
            _ => None,
        }
    }

    pub(crate) fn owned_retiring(&self) -> bool {
        self.receipt.as_ref().is_some_and(|receipt| matches!(receipt.phase,ReceiptPhase::Retiring {..}))
    }

    /// True until a validated terminal ACK proves actual cleanup. This includes
    /// an uncertain Begin return: a transport error cannot revoke admission.
    pub fn owns_external_receipt(&self) -> bool {
        self.receipt
            .as_ref()
            .is_some_and(|r| !matches!(r.phase, ReceiptPhase::Done(_)))
    }

    /// Allocate every control/output buffer before the first host call. Only
    /// registry code holding the exact kernel-issued retry token invokes this.
    pub(crate) fn prepare_owned(&mut self, token: i64) -> Result<(), Errno> {
        if let Some(receipt) = &self.receipt {
            return if receipt.token == token as u64 {
                Ok(())
            } else {
                Err(Errno::EINVAL)
            };
        }
        if !self.is_captured() || token <= 0 {
            return Err(Errno::EINVAL);
        }
        let mut input = Vec::new();
        input
            .try_reserve_exact(self.input.len())
            .map_err(|_| Errno::ENOMEM)?;
        input.extend_from_slice(&self.input);
        let begin = wire::encode_request(&wire::Request {
            control: Control::Begin,
            token: token as u64,
            begin: Some(wire::Begin {
                op: self.op,
                capacity: self.output.len() as u32,
                has_current: self.owner.draw_surface_id.is_some()
                    || self.owner.read_surface_id.is_some(),
                context: self.owner.context_id,
                draw: self.owner.draw_surface_id.unwrap_or(0),
                read: self.owner.read_surface_id.unwrap_or(0),
                input,
            }),
        })
        .map_err(receipt_codec_errno)?;
        let control: [u8; wire::REQUEST_HEADER] = wire::encode_request(&wire::Request {
            control: Control::Poll,
            token: token as u64,
            begin: None,
        })
        .map_err(receipt_codec_errno)?
        .try_into()
        .map_err(|_| Errno::EINVAL)?;
        let mut reply = Vec::new();
        let capacity = wire::REPLY_HEADER
            .checked_add(self.output.len())
            .ok_or(Errno::EINVAL)?;
        reply
            .try_reserve_exact(capacity)
            .map_err(|_| Errno::ENOMEM)?;
        reply.resize(capacity, 0);
        self.receipt = Some(OwnedReceipt {
            token: token as u64,
            begin,
            control,
            reply,
            phase: ReceiptPhase::Begin,
        });
        Ok(())
    }

    /// Cancellation never changes an already requested Commit: copyout and any
    /// exactly-once candidate publication cannot be undone by a later teardown.
    pub(crate) fn cancel_owned(&mut self, error: Errno) -> GlQueryProgress {
        let Some(receipt) = &mut self.receipt else {
            return GlQueryProgress::Complete(Err(error));
        };
        match receipt.phase {
            ReceiptPhase::Done(outcome) => GlQueryProgress::Complete(outcome),
            ReceiptPhase::Begin => {
                // No host call occurred, so there is no external custody.
                receipt.phase = ReceiptPhase::Done(Err(error));
                GlQueryProgress::Complete(Err(error))
            }
            ReceiptPhase::Poll => {
                receipt.phase = ReceiptPhase::Retiring {
                    mode: Mode::Cancel,
                    outcome: Err(error),
                };
                GlQueryProgress::PendingOwned
            }
            ReceiptPhase::Retiring { .. } => GlQueryProgress::PendingOwned,
        }
    }

    /// Advance at most one query control plus one post-ACK Forget. No borrowed
    /// output or guest address-space view survives this synchronous host call.
    pub(crate) fn step_owned(&mut self, host: &mut dyn HostIO) -> GlQueryProgress {
        let Some(receipt) = &mut self.receipt else {
            return GlQueryProgress::ProtocolFaultOwned;
        };
        let (control, mode) = match receipt.phase {
            ReceiptPhase::Begin => (Control::Begin, None),
            ReceiptPhase::Poll => (Control::Poll, None),
            ReceiptPhase::Retiring { mode, .. } => (
                if mode == Mode::Commit {
                    Control::Commit
                } else {
                    Control::Cancel
                },
                Some(mode),
            ),
            ReceiptPhase::Done(outcome) => return GlQueryProgress::Complete(outcome),
        };
        if control == Control::Begin {
            receipt.phase = ReceiptPhase::Poll;
        }
        receipt.control[6..8].copy_from_slice(&(control as u16).to_le_bytes());
        let input = if control == Control::Begin {
            &receipt.begin[..]
        } else {
            &receipt.control[..]
        };
        receipt.reply.fill(0);
        let rc = host.gl_query(
            self.owner.pid,
            gl::KERNEL_GL_QUERY_CONTROL,
            input,
            &mut receipt.reply,
            self.owner.session_id,
        );
        if rc < 0 || rc as usize > receipt.reply.len() {
            return GlQueryProgress::ProtocolFaultOwned;
        }
        let expected = wire::ExpectedReply {
            control,
            token: receipt.token,
            capacity: self.output.len() as u32,
            retirement_mode: mode,
        };
        let reply = match wire::decode_reply(&receipt.reply[..rc as usize], expected) {
            Ok(reply) => reply,
            Err(_) => return GlQueryProgress::ProtocolFaultOwned,
        };
        match reply {
            Reply::Pending => GlQueryProgress::PendingOwned,
            Reply::Ready { result, bytes } => {
                let outcome = if result < 0 {
                    Err(Errno::EIO)
                } else {
                    // Mark before probing/copying; subsequent attempts can only
                    // retire this result, never publish it or execute it again.
                    self.completion = Completion::Failed;
                    let probe = if self.output.is_empty() {
                        Ok(())
                    } else {
                        crate::syscalls::probe_dri_process_pointer(
                            host,
                            self.owner.pid,
                            self.output_address,
                            self.output.len(),
                        )
                        .map(|_| ())
                    };
                    probe.and_then(|_| {
                        crate::syscalls::write_dri_bytes(
                            host,
                            self.owner.pid,
                            self.output_address,
                            &bytes,
                        )
                    })
                };
                if outcome.is_ok() {
                    self.completion = Completion::Published;
                }
                receipt.phase = ReceiptPhase::Retiring {
                    mode: if outcome.is_ok() {
                        Mode::Commit
                    } else {
                        Mode::Cancel
                    },
                    outcome,
                };
                GlQueryProgress::PendingOwned
            }
            Reply::Retiring(mode) => {
                if !matches!(receipt.phase, ReceiptPhase::Retiring { .. }) {
                    receipt.phase = ReceiptPhase::Retiring {
                        mode,
                        outcome: Err(Errno::EIO),
                    };
                }
                GlQueryProgress::PendingOwned
            }
            Reply::Retired { mode, accepted } => {
                let ReceiptPhase::Retiring { outcome, .. } = receipt.phase else {
                    return GlQueryProgress::ProtocolFaultOwned;
                };
                let outcome = if mode == Mode::Commit && !accepted {
                    Err(Errno::EIO)
                } else {
                    outcome
                };
                // This authenticated ACK, not a Forget response, discharges
                // native custody. Forget only removes proven-clean metadata.
                receipt.phase = ReceiptPhase::Done(outcome);
                receipt.control[6..8].copy_from_slice(&(Control::Forget as u16).to_le_bytes());
                let _ = host.gl_query(
                    self.owner.pid,
                    gl::KERNEL_GL_QUERY_CONTROL,
                    &receipt.control,
                    &mut receipt.reply,
                    self.owner.session_id,
                );
                GlQueryProgress::Complete(outcome)
            }
            Reply::Rejected(_) => {
                // Strict codec accepts this only for the first Begin reply.
                receipt.phase = ReceiptPhase::Done(Err(Errno::EIO));
                GlQueryProgress::Complete(Err(Errno::EIO))
            }
        }
    }
}
