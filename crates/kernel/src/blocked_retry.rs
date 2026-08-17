//! Stable kernel-owned targets for host-driven blocking retries.
//!
//! The host may retain immutable request bytes while a syscall sleeps, but a
//! numeric fd, POSIX message-queue descriptor, or System V IPC id can be
//! closed and reused before the retry. These bindings retain the exact kernel
//! object and policy selected by the first attempt. The opaque token is only a
//! lookup key; ownership remains in the kernel until an exact release or
//! process lifecycle cleanup consumes the binding.

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use crate::ipc::{PinnedMsgQueue, PinnedSemSet};
use crate::lock::OfdId;
use crate::mqueue::PinnedMqueueDescriptor;
use crate::pipe::InFlightFd;

/// One normalized syscall family whose retry target must remain stable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BlockingRetryOperation {
    Read,
    Write,
    Fcntl,
    Pread,
    Pwrite,
    Accept,
    Connect,
    Send,
    Recv,
    Sendto,
    Recvfrom,
    Sendmsg,
    Recvmsg,
    Flock,
    Sendfile,
    CopyFileRange,
    Splice,
    MqSend,
    MqReceive,
    MsgSend,
    MsgReceive,
    Semop,
}

impl BlockingRetryOperation {
    /// Normalize vector variants to the one scalar operation Rust executes
    /// after the host has flattened their iovecs.
    pub(crate) fn from_syscall(syscall: u32) -> Result<Self, Errno> {
        use wasm_posix_shared::abi::extended_syscalls;

        match syscall {
            3 | 82 => Ok(Self::Read),
            4 | 81 => Ok(Self::Write),
            10 => Ok(Self::Fcntl),
            53 => Ok(Self::Accept),
            54 => Ok(Self::Connect),
            55 => Ok(Self::Send),
            56 => Ok(Self::Recv),
            62 => Ok(Self::Sendto),
            63 => Ok(Self::Recvfrom),
            64
            | extended_syscalls::SYS_PREADV
            | extended_syscalls::SYS_PREADV2 => Ok(Self::Pread),
            65
            | extended_syscalls::SYS_PWRITEV
            | extended_syscalls::SYS_PWRITEV2 => Ok(Self::Pwrite),
            137 => Ok(Self::Sendmsg),
            138 => Ok(Self::Recvmsg),
            extended_syscalls::SYS_FLOCK => Ok(Self::Flock),
            extended_syscalls::SYS_ACCEPT4 => Ok(Self::Accept),
            extended_syscalls::SYS_SENDFILE => Ok(Self::Sendfile),
            extended_syscalls::SYS_COPY_FILE_RANGE => Ok(Self::CopyFileRange),
            extended_syscalls::SYS_SPLICE => Ok(Self::Splice),
            extended_syscalls::SYS_MQ_TIMEDSEND => Ok(Self::MqSend),
            extended_syscalls::SYS_MQ_TIMEDRECEIVE => Ok(Self::MqReceive),
            extended_syscalls::SYS_MSGSND => Ok(Self::MsgSend),
            extended_syscalls::SYS_MSGRCV => Ok(Self::MsgReceive),
            extended_syscalls::SYS_SEMOP => Ok(Self::Semop),
            _ => Err(Errno::EINVAL),
        }
    }

    pub(crate) fn is_single_ofd(self) -> bool {
        matches!(
            self,
            Self::Read
                | Self::Write
                | Self::Fcntl
                | Self::Pread
                | Self::Pwrite
                | Self::Accept
                | Self::Connect
                | Self::Send
                | Self::Recv
                | Self::Sendto
                | Self::Recvfrom
                | Self::Sendmsg
                | Self::Recvmsg
                | Self::Flock
        )
    }

    pub(crate) fn is_pair_ofd(self) -> bool {
        matches!(self, Self::Sendfile | Self::CopyFileRange | Self::Splice)
    }
}

/// Return whether one host-owned immutable retry snapshot deliberately has no
/// kernel target capability.
///
/// WHY: token zero is an affirmative ownership classification, not a fallback
/// for a syscall omitted from [`BlockingRetryOperation::from_syscall`]. A new
/// parked operation must either retain its exact Rust target or be added to
/// this reviewed list; otherwise the token query fails closed.
fn is_explicit_host_only_snapshot_syscall(syscall: u32) -> bool {
    use wasm_posix_shared::Syscall;
    use wasm_posix_shared::abi::extended_syscalls;

    syscall == Syscall::Open as u32
        || syscall == Syscall::Openat as u32
        || syscall == Syscall::Poll as u32
        || syscall == Syscall::Select as u32
        || syscall == extended_syscalls::SYS_RT_SIGTIMEDWAIT
        || syscall == extended_syscalls::SYS_PPOLL
        || syscall == extended_syscalls::SYS_PSELECT6
}

/// Return whether one syscall result means the host may own a sleeping retry.
///
/// Most retryable kernel operations surface EAGAIN. connect(2) deliberately
/// translates its host handshake sentinel into EINPROGRESS/EALREADY, but a
/// blocking caller still sleeps and therefore needs the same stable target.
pub(crate) fn result_needs_target(syscall: u32, errno: u32) -> bool {
    errno == Errno::EAGAIN as u32
        || (syscall == 54
            && (errno == Errno::EINPROGRESS as u32 || errno == Errno::EALREADY as u32))
}

/// Exact process-local OFD slot plus its non-reusable machine identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StableOfdTarget {
    pub(crate) original_fd: i32,
    pub(crate) ofd_idx: usize,
    pub(crate) ofd_id: OfdId,
}

/// Resource authority retained by one blocked operation.
///
/// Capabilities are deliberately non-Clone. Exact release consumes the enum,
/// preventing a second caller from decrementing the same kernel-owned pin.
pub(crate) enum BlockingRetryTarget {
    Ofd(StableOfdTarget),
    OfdPair {
        input: StableOfdTarget,
        output: StableOfdTarget,
    },
    Sendmsg {
        carrier: StableOfdTarget,
        ancillary: Vec<InFlightFd>,
    },
    Mqueue(PinnedMqueueDescriptor),
    SysvMessage(PinnedMsgQueue),
    SysvSemaphore(PinnedSemSet),
}

impl BlockingRetryTarget {
    fn supports(&self, operation: BlockingRetryOperation) -> bool {
        match self {
            Self::Ofd(_) => {
                operation.is_single_ofd() && operation != BlockingRetryOperation::Sendmsg
            }
            Self::OfdPair { .. } => operation.is_pair_ofd(),
            Self::Sendmsg { .. } => operation == BlockingRetryOperation::Sendmsg,
            Self::Mqueue(_) => matches!(
                operation,
                BlockingRetryOperation::MqSend | BlockingRetryOperation::MqReceive
            ),
            Self::SysvMessage(_) => matches!(
                operation,
                BlockingRetryOperation::MsgSend | BlockingRetryOperation::MsgReceive
            ),
            Self::SysvSemaphore(_) => operation == BlockingRetryOperation::Semop,
        }
    }
}

pub(crate) struct BlockingRetryBinding {
    pub(crate) token: i64,
    pub(crate) tid: u32,
    pub(crate) operation: BlockingRetryOperation,
    pub(crate) target: BlockingRetryTarget,
}

/// Per-process binding registry.
///
/// A `Vec` keeps the common one-blocked-call-per-task case compact and avoids
/// a second tree allocation. Tokens never wrap or reuse during a process
/// lifetime; exhaustion is a truthful terminal error.
pub(crate) struct BlockingRetryState {
    next_token: u64,
    bindings: Vec<BlockingRetryBinding>,
    active: Option<(u32, i64, BlockingRetryOperation)>,
    dispatch_tid: Option<u32>,
    bound_tid: Option<u32>,
}

impl BlockingRetryState {
    pub(crate) fn new() -> Self {
        Self {
            next_token: 1,
            bindings: Vec::new(),
            active: None,
            dispatch_tid: None,
            bound_tid: None,
        }
    }

    pub(crate) fn bind_task(&mut self, tid: u32) {
        self.bound_tid = Some(tid);
    }

    pub(crate) fn clear_bound_task(&mut self, tid: u32) {
        if self.bound_tid == Some(tid) {
            self.bound_tid = None;
        }
    }

    pub(crate) fn bound_tid(&self) -> Option<u32> {
        self.bound_tid
    }

    /// Reserve storage and a nonzero signed-Wasm token before the target is
    /// pinned. This ordering lets callers fail without needing rollback.
    pub(crate) fn prepare_insert(&mut self) -> Result<i64, Errno> {
        if self.next_token > i64::MAX as u64 {
            return Err(Errno::EOVERFLOW);
        }
        self.bindings.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
        let token = self.next_token as i64;
        self.next_token += 1;
        Ok(token)
    }

    pub(crate) fn insert_prepared(
        &mut self,
        token: i64,
        tid: u32,
        operation: BlockingRetryOperation,
        target: BlockingRetryTarget,
    ) -> Result<(), (Errno, BlockingRetryTarget)> {
        if !target.supports(operation) {
            return Err((Errno::EINVAL, target));
        }
        if token <= 0
            || self
                .bindings
                .iter()
                .any(|binding| binding.token == token || binding.tid == tid)
        {
            return Err((Errno::EBUSY, target));
        }
        self.bindings.push(BlockingRetryBinding {
            token,
            tid,
            operation,
            target,
        });
        Ok(())
    }

    pub(crate) fn token_for(
        &self,
        tid: u32,
        operation: BlockingRetryOperation,
    ) -> Result<i64, Errno> {
        self.bindings
            .iter()
            .find(|binding| binding.tid == tid && binding.operation == operation)
            .map(|binding| binding.token)
            .ok_or(Errno::ENOENT)
    }

    /// Return a positive exact-target token, or zero only for an explicitly
    /// classified host-only immutable snapshot.
    ///
    /// WHY: making Rust answer this question removes a duplicated TypeScript
    /// allowlist. A newly mapped operation with no binding still fails ENOENT,
    /// while an unknown operation fails EINVAL, so protocol drift cannot
    /// silently downgrade it to an unpinned retry.
    pub(crate) fn token_for_syscall(&self, tid: u32, syscall: u32) -> Result<i64, Errno> {
        let operation = match BlockingRetryOperation::from_syscall(syscall) {
            Ok(operation) => operation,
            Err(Errno::EINVAL) if is_explicit_host_only_snapshot_syscall(syscall) => {
                return Ok(0);
            }
            Err(error) => return Err(error),
        };
        self.token_for(tid, operation)
    }

    pub(crate) fn has_binding_for_tid(&self, tid: u32) -> bool {
        self.bindings.iter().any(|binding| binding.tid == tid)
    }

    pub(crate) fn activate(
        &mut self,
        tid: u32,
        token: i64,
        operation: BlockingRetryOperation,
    ) -> Result<(), Errno> {
        if self.active.is_some() {
            return Err(Errno::EBUSY);
        }
        let binding = self
            .bindings
            .iter()
            .find(|binding| binding.token == token)
            .ok_or(Errno::ENOENT)?;
        if binding.tid != tid || binding.operation != operation {
            return Err(Errno::EINVAL);
        }
        self.active = Some((tid, token, operation));
        Ok(())
    }

    pub(crate) fn clear_active(&mut self) {
        self.active = None;
    }

    /// Admit a direct socket-message export, returning whether it installed
    /// the active token that its caller must later clear.
    ///
    /// A channel-dispatched call passes token zero after the outer dispatcher
    /// has already activated the exact operation. Foreign task/operation
    /// state is rejected without mutation.
    pub(crate) fn activate_direct(
        &mut self,
        tid: u32,
        token: i64,
        operation: BlockingRetryOperation,
    ) -> Result<bool, Errno> {
        if token == 0 {
            if let Some((active_tid, _, active_operation)) = self.active {
                if active_tid != tid {
                    return Err(Errno::EBUSY);
                }
                return if active_operation == operation {
                    Ok(false)
                } else {
                    Err(Errno::EINVAL)
                };
            }
            return if self.has_binding_for_tid(tid) {
                Err(Errno::EBUSY)
            } else {
                Ok(false)
            };
        }
        if token < 0 {
            return Err(Errno::EINVAL);
        }
        self.activate(tid, token, operation)?;
        Ok(true)
    }

    pub(crate) fn active_tid(&self) -> Option<u32> {
        self.active.map(|(tid, _, _)| tid)
    }

    pub(crate) fn begin_dispatch(&mut self, tid: u32) -> Result<(), Errno> {
        if self.dispatch_tid.is_some() {
            return Err(Errno::EBUSY);
        }
        self.dispatch_tid = Some(tid);
        Ok(())
    }

    /// Enter a direct export that may be nested under channel dispatch.
    ///
    /// WHY: sendmsg/recvmsg are callable both directly and through the channel
    /// dispatcher. A nested call must share the already-proven TID without
    /// clearing its caller's dispatch authority, while a different TID must
    /// never replace that authority.
    pub(crate) fn enter_dispatch(&mut self, tid: u32) -> Result<bool, Errno> {
        match self.dispatch_tid {
            None => {
                self.dispatch_tid = Some(tid);
                Ok(true)
            }
            Some(active_tid) if active_tid == tid => Ok(false),
            Some(_) => Err(Errno::EBUSY),
        }
    }

    pub(crate) fn dispatch_tid(&self) -> Option<u32> {
        self.dispatch_tid
    }

    pub(crate) fn clear_dispatch(&mut self) {
        self.dispatch_tid = None;
    }

    pub(crate) fn active_binding(
        &self,
        tid: u32,
        operation: BlockingRetryOperation,
    ) -> Result<Option<&BlockingRetryBinding>, Errno> {
        let Some((active_tid, token, active_operation)) = self.active else {
            return Ok(None);
        };
        if active_tid != tid || active_operation != operation {
            return Err(Errno::EINVAL);
        }
        self.bindings
            .iter()
            .find(|binding| binding.token == token)
            .map(Some)
            .ok_or(Errno::ENOENT)
    }

    /// Return the binding already validated by [`Self::activate`].
    ///
    /// WHY: syscall implementations hold `&mut Process`, which originated
    /// from the global process table. Re-reading that table merely to recover
    /// the current TID would create an aliased reference to the same Process.
    /// Activation happens before that borrow reaches the syscall layer and
    /// records the exact task/operation under serialized kernel entry.
    pub(crate) fn active_binding_current(
        &self,
    ) -> Result<Option<&BlockingRetryBinding>, Errno> {
        let Some((_, token, _)) = self.active else {
            return Ok(None);
        };
        self.bindings
            .iter()
            .find(|binding| binding.token == token)
            .map(Some)
            .ok_or(Errno::ENOENT)
    }

    pub(crate) fn active_mqueue(
        &self,
        tid: u32,
        operation: BlockingRetryOperation,
    ) -> Result<Option<&PinnedMqueueDescriptor>, Errno> {
        let Some(binding) = self.active_binding(tid, operation)? else {
            return Ok(None);
        };
        match &binding.target {
            BlockingRetryTarget::Mqueue(pinned) => Ok(Some(pinned)),
            _ => Err(Errno::EINVAL),
        }
    }

    pub(crate) fn active_sysv_message(
        &self,
        tid: u32,
        operation: BlockingRetryOperation,
    ) -> Result<Option<&PinnedMsgQueue>, Errno> {
        let Some(binding) = self.active_binding(tid, operation)? else {
            return Ok(None);
        };
        match &binding.target {
            BlockingRetryTarget::SysvMessage(pinned) => Ok(Some(pinned)),
            _ => Err(Errno::EINVAL),
        }
    }

    pub(crate) fn active_sysv_semaphore(
        &self,
        tid: u32,
    ) -> Result<Option<&PinnedSemSet>, Errno> {
        let Some(binding) = self.active_binding(tid, BlockingRetryOperation::Semop)? else {
            return Ok(None);
        };
        match &binding.target {
            BlockingRetryTarget::SysvSemaphore(pinned) => Ok(Some(pinned)),
            _ => Err(Errno::EINVAL),
        }
    }

    pub(crate) fn take_exact(
        &mut self,
        tid: u32,
        token: i64,
    ) -> Result<BlockingRetryBinding, Errno> {
        if self
            .active
            .is_some_and(|(active_tid, active_token, _)| {
                active_tid == tid && active_token == token
            })
        {
            return Err(Errno::EBUSY);
        }
        let index = self
            .bindings
            .iter()
            .position(|binding| binding.tid == tid && binding.token == token)
            .ok_or(Errno::ENOENT)?;
        Ok(self.bindings.swap_remove(index))
    }

    pub(crate) fn take_for_tid(&mut self, tid: u32) -> Option<BlockingRetryBinding> {
        if self.bound_tid == Some(tid) {
            self.bound_tid = None;
        }
        if self.dispatch_tid == Some(tid) {
            self.dispatch_tid = None;
        }
        if self.active.is_some_and(|(active_tid, _, _)| active_tid == tid) {
            self.active = None;
        }
        // insert_prepared rejects a second binding for the same TID. Returning
        // the one owned value directly keeps thread-exit cleanup allocation
        // free even when the machine is already out of memory.
        self.bindings
            .iter()
            .position(|binding| binding.tid == tid)
            .map(|index| self.bindings.swap_remove(index))
    }

    pub(crate) fn take_all(&mut self) -> Vec<BlockingRetryBinding> {
        self.bound_tid = None;
        self.dispatch_tid = None;
        self.active = None;
        core::mem::take(&mut self.bindings)
    }

    #[cfg(test)]
    pub(crate) fn binding_count(&self) -> usize {
        self.bindings.len()
    }
}

impl Default for BlockingRetryState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ofd_target(fd: i32, ofd_idx: usize, ofd_id: u64) -> BlockingRetryTarget {
        BlockingRetryTarget::Ofd(StableOfdTarget {
            original_fd: fd,
            ofd_idx,
            ofd_id: OfdId(ofd_id),
        })
    }

    fn insert(
        state: &mut BlockingRetryState,
        tid: u32,
        operation: BlockingRetryOperation,
        target: BlockingRetryTarget,
    ) -> i64 {
        let token = state.prepare_insert().unwrap();
        state
            .insert_prepared(token, tid, operation, target)
            .map_err(|(error, _)| error)
            .unwrap();
        token
    }

    #[test]
    fn pending_connect_results_need_the_same_target_as_eagain() {
        assert!(result_needs_target(54, Errno::EINPROGRESS as u32));
        assert!(result_needs_target(54, Errno::EALREADY as u32));
        assert!(result_needs_target(53, Errno::EAGAIN as u32));
        assert!(!result_needs_target(54, Errno::ECONNREFUSED as u32));
        assert!(!result_needs_target(53, Errno::EINPROGRESS as u32));
    }

    #[test]
    fn rust_is_the_single_authority_for_whether_a_retry_needs_a_token() {
        use wasm_posix_shared::Syscall;
        use wasm_posix_shared::abi::extended_syscalls;

        let mut state = BlockingRetryState::new();
        for syscall in [
            Syscall::Open as u32,
            Syscall::Openat as u32,
            Syscall::Poll as u32,
            Syscall::Select as u32,
            extended_syscalls::SYS_RT_SIGTIMEDWAIT,
            extended_syscalls::SYS_PPOLL,
            extended_syscalls::SYS_PSELECT6,
        ] {
            assert!(is_explicit_host_only_snapshot_syscall(syscall));
            assert_eq!(state.token_for_syscall(17, syscall), Ok(0));
        }
        assert!(!is_explicit_host_only_snapshot_syscall(u32::MAX));
        assert_eq!(state.token_for_syscall(17, u32::MAX), Err(Errno::EINVAL));
        assert_eq!(state.token_for_syscall(17, 3), Err(Errno::ENOENT));

        let token = insert(
            &mut state,
            17,
            BlockingRetryOperation::Read,
            ofd_target(3, 4, 5),
        );
        assert_eq!(state.token_for_syscall(17, 3), Ok(token));
        assert_eq!(state.token_for_syscall(17, 82), Ok(token));
    }

    #[test]
    fn token_activation_requires_exact_task_and_operation() {
        let mut state = BlockingRetryState::new();
        let token = insert(
            &mut state,
            17,
            BlockingRetryOperation::Read,
            ofd_target(3, 4, 5),
        );

        assert_eq!(
            state.activate(18, token, BlockingRetryOperation::Read),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            state.activate(17, token, BlockingRetryOperation::Write),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            state.activate(17, token + 1, BlockingRetryOperation::Read),
            Err(Errno::ENOENT)
        );
        state
            .activate(17, token, BlockingRetryOperation::Read)
            .unwrap();
        assert!(state.active_binding(17, BlockingRetryOperation::Read).unwrap().is_some());
        assert_eq!(
            state.take_exact(17, token).map(|_| ()),
            Err(Errno::EBUSY)
        );
        state.clear_active();
        assert_eq!(state.take_exact(18, token).map(|_| ()), Err(Errno::ENOENT));
        assert!(state.take_exact(17, token).is_ok());
        assert_eq!(state.take_exact(17, token).map(|_| ()), Err(Errno::ENOENT));
    }

    #[test]
    fn socket_operations_keep_exact_token_families() {
        for (syscall, operation) in [
            (55, BlockingRetryOperation::Send),
            (56, BlockingRetryOperation::Recv),
            (62, BlockingRetryOperation::Sendto),
            (63, BlockingRetryOperation::Recvfrom),
        ] {
            assert_eq!(BlockingRetryOperation::from_syscall(syscall), Ok(operation));
        }
    }

    #[test]
    fn nested_direct_dispatch_cannot_replace_or_clear_another_task() {
        let mut state = BlockingRetryState::new();
        state.begin_dispatch(19).unwrap();
        assert_eq!(state.enter_dispatch(19), Ok(false));
        assert_eq!(state.enter_dispatch(20), Err(Errno::EBUSY));
        assert_eq!(state.dispatch_tid(), Some(19));
        assert_eq!(state.begin_dispatch(20), Err(Errno::EBUSY));
        assert_eq!(state.dispatch_tid(), Some(19));
        state.clear_dispatch();
        assert_eq!(state.enter_dispatch(20), Ok(true));
        assert_eq!(state.dispatch_tid(), Some(20));
    }

    #[test]
    fn direct_activation_preserves_foreign_and_wrong_operation_state() {
        let mut state = BlockingRetryState::new();
        let token = insert(
            &mut state,
            19,
            BlockingRetryOperation::Sendmsg,
            BlockingRetryTarget::Sendmsg {
                carrier: StableOfdTarget {
                    original_fd: 3,
                    ofd_idx: 4,
                    ofd_id: OfdId(5),
                },
                ancillary: Vec::new(),
            },
        );
        state
            .activate(19, token, BlockingRetryOperation::Sendmsg)
            .unwrap();

        assert_eq!(
            state.activate_direct(19, 0, BlockingRetryOperation::Recvmsg),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            state.activate_direct(20, 0, BlockingRetryOperation::Sendmsg),
            Err(Errno::EBUSY)
        );
        assert!(state
            .active_binding(19, BlockingRetryOperation::Sendmsg)
            .unwrap()
            .is_some());
        assert_eq!(
            state.activate_direct(19, 0, BlockingRetryOperation::Sendmsg),
            Ok(false)
        );
    }

    #[test]
    fn two_tasks_interleave_without_replacing_each_others_binding() {
        let mut state = BlockingRetryState::new();
        let read_token = insert(
            &mut state,
            21,
            BlockingRetryOperation::Read,
            ofd_target(3, 7, 11),
        );
        let write_token = insert(
            &mut state,
            22,
            BlockingRetryOperation::Write,
            ofd_target(3, 8, 12),
        );

        assert_eq!(state.binding_count(), 2);
        state
            .activate(21, read_token, BlockingRetryOperation::Read)
            .unwrap();
        assert_eq!(
            state.activate(22, write_token, BlockingRetryOperation::Write),
            Err(Errno::EBUSY)
        );
        state.clear_active();
        state
            .activate(22, write_token, BlockingRetryOperation::Write)
            .unwrap();
        assert!(state.active_binding(22, BlockingRetryOperation::Write).unwrap().is_some());
        state.clear_active();

        let removed = state.take_for_tid(21).unwrap();
        assert_eq!(removed.token, read_token);
        assert_eq!(state.binding_count(), 1);
        assert_eq!(
            state.token_for(22, BlockingRetryOperation::Write),
            Ok(write_token)
        );
    }

    #[test]
    fn lifecycle_take_clears_every_process_owned_task_mirror() {
        let mut state = BlockingRetryState::new();
        let token = insert(
            &mut state,
            21,
            BlockingRetryOperation::Read,
            ofd_target(3, 7, 11),
        );
        state.bind_task(21);
        state.begin_dispatch(21).unwrap();
        state
            .activate(21, token, BlockingRetryOperation::Read)
            .unwrap();

        assert!(state.take_for_tid(21).is_some());
        assert_eq!(state.bound_tid(), None);
        assert_eq!(state.dispatch_tid(), None);
        assert_eq!(state.active_tid(), None);

        let second = insert(
            &mut state,
            22,
            BlockingRetryOperation::Write,
            ofd_target(4, 8, 12),
        );
        state.bind_task(22);
        state.begin_dispatch(22).unwrap();
        state
            .activate(22, second, BlockingRetryOperation::Write)
            .unwrap();

        assert_eq!(state.take_all().len(), 1);
        assert_eq!(state.bound_tid(), None);
        assert_eq!(state.dispatch_tid(), None);
        assert_eq!(state.active_tid(), None);
    }

    #[test]
    fn one_task_cannot_hold_two_pending_operations() {
        let mut state = BlockingRetryState::new();
        let token = insert(
            &mut state,
            31,
            BlockingRetryOperation::Read,
            ofd_target(3, 1, 1),
        );
        let second = state.prepare_insert().unwrap();
        let rejected = state.insert_prepared(
            second,
            31,
            BlockingRetryOperation::Write,
            ofd_target(4, 2, 2),
        );
        assert!(matches!(rejected, Err((Errno::EBUSY, _))));
        assert_eq!(
            state.token_for(31, BlockingRetryOperation::Read),
            Ok(token)
        );
        assert_eq!(state.binding_count(), 1);
    }

    #[test]
    fn target_kind_must_match_the_operation() {
        let mut state = BlockingRetryState::new();
        let token = state.prepare_insert().unwrap();
        assert!(matches!(
            state.insert_prepared(
                token,
                32,
                BlockingRetryOperation::Sendmsg,
                ofd_target(3, 1, 1),
            ),
            Err((Errno::EINVAL, BlockingRetryTarget::Ofd(_)))
        ));
        assert_eq!(state.binding_count(), 0);
    }

    #[test]
    fn mqueue_binding_keeps_the_unlinked_closed_queue_and_policy_stable() {
        let mut queues = crate::mqueue::MqueueTable::new();
        let mqd = queues
            .mq_open("/retry", 0o100 | 2, 0o600, 1, 32, true)
            .unwrap();
        let pin = queues.pin_descriptor(mqd).unwrap();
        let mut state = BlockingRetryState::new();
        let token = insert(
            &mut state,
            41,
            BlockingRetryOperation::MqReceive,
            BlockingRetryTarget::Mqueue(pin),
        );

        queues.mq_unlink("/retry").unwrap();
        queues.mq_close(mqd).unwrap();
        state
            .activate(41, token, BlockingRetryOperation::MqReceive)
            .unwrap();
        let pin = state
            .active_mqueue(41, BlockingRetryOperation::MqReceive)
            .unwrap()
            .unwrap();
        assert_eq!(queues.pinned_is_nonblock(pin), Ok(false));
        assert_eq!(queues.pinned_descriptor_msgsize(pin), Ok(32));
        state.clear_active();

        let binding = state.take_exact(41, token).unwrap();
        let BlockingRetryTarget::Mqueue(pin) = binding.target else {
            panic!("expected mqueue binding");
        };
        queues.release_pinned_descriptor(pin).unwrap();
    }

    #[test]
    fn sysv_bindings_observe_removal_instead_of_redirecting() {
        let mut ipc = crate::ipc::IpcTable::new();
        let qid = ipc.msgget(0, 0o1000 | 0o666, 1, 0, 0).unwrap();
        let queue_pin = ipc.pin_msg_queue(qid).unwrap();
        let semid = ipc.semget(0, 1, 0o1000 | 0o666, 1, 0, 0).unwrap();
        let sem_pin = ipc.pin_sem_set(semid).unwrap();

        let mut state = BlockingRetryState::new();
        let queue_token = insert(
            &mut state,
            51,
            BlockingRetryOperation::MsgReceive,
            BlockingRetryTarget::SysvMessage(queue_pin),
        );
        let sem_token = insert(
            &mut state,
            52,
            BlockingRetryOperation::Semop,
            BlockingRetryTarget::SysvSemaphore(sem_pin),
        );
        ipc.msgctl(qid, 0, 1, 0, 0).unwrap();
        ipc.semctl(semid, 0, 0, 1, 0, 0, 0).unwrap();

        state
            .activate(51, queue_token, BlockingRetryOperation::MsgReceive)
            .unwrap();
        let queue_pin = state
            .active_sysv_message(51, BlockingRetryOperation::MsgReceive)
            .unwrap()
            .unwrap();
        assert_eq!(
            ipc.msgrcv_pinned(queue_pin, 8, 0, 0, 1, 0, 0)
                .unwrap_err(),
            Errno::EIDRM
        );
        state.clear_active();

        state
            .activate(52, sem_token, BlockingRetryOperation::Semop)
            .unwrap();
        let sem_pin = state.active_sysv_semaphore(52).unwrap().unwrap();
        let decrement = [crate::ipc::SemOp {
            num: 0,
            op: -1,
            flg: 0,
        }];
        assert_eq!(
            ipc.semop_pinned(sem_pin, &decrement, 1, 0, 0),
            Err(Errno::EIDRM)
        );
        state.clear_active();

        let queue = state.take_exact(51, queue_token).unwrap();
        let BlockingRetryTarget::SysvMessage(queue_pin) = queue.target else {
            panic!("expected SysV message binding");
        };
        ipc.release_msg_queue_pin(queue_pin).unwrap();
        let semaphore = state.take_exact(52, sem_token).unwrap();
        let BlockingRetryTarget::SysvSemaphore(sem_pin) = semaphore.target else {
            panic!("expected SysV semaphore binding");
        };
        ipc.release_sem_set_pin(sem_pin).unwrap();
    }
}
