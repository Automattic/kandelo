//! Caller-native receive preparation and publication. The synchronous Wasm
//! adapter ends its active retry binding between these phases; neither phase
//! delegates descriptor identity or payload ownership to the embedding host.
use crate::{
    IoBuffer,
    lock::AdvisoryLockManager,
    msghdr::{NativeIovec, NativeMsghdr},
    process::{HostIO, Process},
    syscalls,
};
use wasm_posix_shared::Errno;

#[must_use = "publish the received result or explicitly discard its owned resources"]
pub struct GuestRecvmsg {
    pid: u32,
    generation: u64,
    msg_addr: u64,
    width: u8,
    flags: u32,
    header: NativeMsghdr,
    iovecs: IoBuffer<NativeIovec>,
    payload: IoBuffer<u8>,
    addr_staging: IoBuffer<u8>,
    received: syscalls::MessageReceive,
}
impl GuestRecvmsg {
    pub fn receive(
        proc: &mut Process,
        host: &mut dyn HostIO,
        locks: &mut AdvisoryLockManager,
        tid: u32,
        fd: i32,
        msg_addr: u64,
        flags: u32,
    ) -> Result<Self, Errno> {
        // Resolve descriptor/type before reading caller metadata. This also
        // honors an active exact-OFD retry after numeric fd reuse.
        syscalls::recvmsg_socket_index(proc, fd)?;
        let pid = proc.pid as i32;
        let width = proc.pointer_width;
        let header = crate::msghdr::read_msghdr(host, pid, msg_addr, width)?;
        let iovecs =
            crate::msghdr::read_iovecs(host, pid, header.iov_addr, header.iov_count, width)?;
        let capacity = crate::msghdr::iovec_total(&iovecs)?;
        let (rights, name_len) = syscalls::recvmsg_output_shape(proc, fd, capacity, flags)?;
        crate::msghdr::prepare_receive_outputs(
            host, pid, msg_addr, width, &header, &iovecs, rights, name_len,
        )?;
        let mut payload = crate::guest_ptr::zeroed_io_staging(
            capacity,
            wasm_posix_shared::platform_limits::MAX_REPORTABLE_TRANSFER_BYTES,
        )?;
        // Pay only for the possible address prefix of this queued carrier,
        // independently of the caller's larger advertised capacity.
        let addr_capacity = if header.name_addr == 0 {
            0
        } else {
            name_len.min(header.name_len as usize)
        };
        let mut addr_staging =
            crate::guest_ptr::zeroed_io_staging(addr_capacity, addr_capacity.max(1))?;

        let received =
            match syscalls::sys_recvmsg(proc, host, fd, &mut payload, flags, &mut addr_staging) {
                Ok(received) => received,
                Err(Errno::EAGAIN) => {
                    syscalls::ensure_blocking_retry_ofd_binding(
                        proc,
                        locks,
                        host,
                        tid,
                        wasm_posix_shared::Syscall::Recvmsg as u32,
                        fd,
                        None,
                    )?;
                    return Err(Errno::EAGAIN);
                }
                Err(error) => return Err(error),
            };
        Ok(Self {
            pid: proc.pid,
            generation: proc.exec_generation,
            msg_addr,
            width,
            flags,
            header,
            iovecs,
            payload,
            addr_staging,
            received,
        })
    }

    /// Publish only after ending the receive's active retry binding. A result
    /// belongs to its exact process/image and is consumed once. No guest view
    /// or host handle survives this boundary.
    pub fn publish(
        self,
        proc: &mut Process,
        host: &mut dyn HostIO,
        locks: &mut AdvisoryLockManager,
    ) -> Result<usize, Errno> {
        use wasm_posix_shared::fd_flags::FD_CLOEXEC;
        use wasm_posix_shared::socket::{MSG_CMSG_CLOEXEC, MSG_CTRUNC};
        if self.pid != proc.pid || self.generation != proc.exec_generation {
            drop(self);
            unsafe {
                crate::pipe::global_pipe_table().finish_ancillary_transition();
            }
            syscalls::drain_deferred_scm_rights_releases(locks, host);
            return Err(Errno::ESRCH);
        }
        let Self {
            pid,
            msg_addr,
            width,
            flags,
            header,
            iovecs,
            payload,
            addr_staging,
            mut received,
            ..
        } = self;
        let pid = pid as i32;
        let mut result = received.return_len as i32;
        // Publish all result metadata even for a zero-byte datagram: a zero-length
        // message can still carry descriptors and output flags.
        let mut published_control_len = 0u32;
        let mut installed_scm_rights = crate::IoBuffer::new();
        let mut published_name_len: Option<u32> = None;

        let mut output_msg_flags = received.output_flags;
        {
            // Scatter the received bytes back across the caller's iovecs. The
            // receive was bounded by their total, so this cannot overrun; a short
            // result simply leaves the trailing buffers untouched.
            let delivered = received.return_len.min(payload.len());
            if let Err(error) = crate::msghdr::scatter(host, pid, &iovecs, &payload[..delivered]) {
                result = -(error as i32);
            }

            if header.name_addr != 0 {
                let addr_bytes = received.addr_len.min(addr_staging.len());
                if addr_bytes > 0 {
                    if let Err(error) = crate::guest_ptr::write_guest_bytes(
                        host,
                        pid,
                        header.name_addr,
                        &addr_staging[..addr_bytes],
                    ) {
                        result = -(error as i32);
                    }
                }
                // msg_name PRESENCE, not its capacity, controls whether
                // msg_namelen is a value-result field. A non-null zero-capacity
                // pointer still receives the complete length -- that is how a
                // caller learns its address buffer was too small.
                published_name_len = Some(received.addr_len as u32);
            }

            if !received.ancillary_fds.is_empty() {
                let in_flight = core::mem::take(&mut received.ancillary_fds);
                if result < 0 {
                    drop(in_flight);
                    unsafe {
                        crate::pipe::global_pipe_table().finish_ancillary_transition();
                    }
                } else {
                    let fd_flags = if flags & MSG_CMSG_CLOEXEC != 0 {
                        FD_CLOEXEC
                    } else {
                        0
                    };
                    match syscalls::publish_scm_rights(
                        proc,
                        locks,
                        host,
                        in_flight,
                        crate::msghdr::ScmRightsOutput {
                            addr: header.control_addr,
                            capacity: header.control_len,
                            pointer_width: width,
                            fd_flags,
                        },
                    ) {
                        Ok(publication) => {
                            published_control_len = publication.control_len;
                            if publication.truncated {
                                output_msg_flags |= MSG_CTRUNC;
                            }
                            installed_scm_rights = publication.descriptors;
                        }
                        Err(error) => result = -(error as i32),
                    }
                }
            }
        }

        // Publish for a delivered message even when it carried zero bytes: a
        // zero-length datagram still has descriptors and output flags, and the
        // caller must be able to tell "no ancillary data" from a stale length it
        // set before the call.
        //
        // But ONLY for a delivered message. On EAGAIN the host parks a retry and
        // calls again with the same `msghdr`; zeroing `msg_controllen` here would
        // leave that retry with no control capacity, so a descriptor that fitted
        // the caller's buffer the first time would arrive truncated the second.
        // Linux likewise leaves the header untouched on a failed `recvmsg`.
        {
            if let Err(error) = crate::msghdr::write_msghdr_results(
                host,
                pid,
                msg_addr as u64,
                width,
                published_name_len,
                published_control_len,
                output_msg_flags,
            ) {
                result = -(error as i32);
            }
        }

        if result < 0 {
            syscalls::rollback_scm_rights_fds(proc, locks, host, installed_scm_rights);
        }
        syscalls::drain_deferred_scm_rights_releases(locks, host);

        if result < 0 {
            Err(Errno::from_u32((-result) as u32).unwrap_or(Errno::EIO))
        } else {
            Ok(result as usize)
        }
    }
}
