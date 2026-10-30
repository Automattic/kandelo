//! Owned GL query admission and copyout, shared by immediate queries and the
//! retained-target lifecycle. Deferred host execution is deliberately absent:
//! no request here can claim to own an external receipt or acknowledge cleanup.

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
}

impl GlQueryRequest {
    pub fn new(
        owner: GlQueryOwner,
        op: u32,
        input: Vec<u8>,
        output_address: u64,
        output_capacity: usize,
    ) -> Result<Self, Errno> {
        if !matches!(owner.pointer_width, 4 | 8)
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
        })
    }

    pub(crate) fn is_captured(&self) -> bool {
        matches!(self.completion, Completion::Captured)
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
        if !matches!(self.completion, Completion::Captured) {
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
