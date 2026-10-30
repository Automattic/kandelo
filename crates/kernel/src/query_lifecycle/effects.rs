//! Actual kernel effects custody. No native cleanup ACK is invented here.
use super::registry::{Owner, TakenEffects};
use super::{Completion, Request};
use crate::{
    process::{HostIO, ProcessState},
    process_table::ProcessTable,
};
use wasm_posix_shared::Errno;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Delivered {
    Exec,
    Exit(i32),
    ThreadExit(usize),
    RetryReleased,
    Signaled,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Delivery {
    Ready,
    PendingPhysicalReceiver,
    ProtocolFaultOwned,
    Delivered(Result<Delivered, Errno>),
}

pub(crate) struct EffectsReceiver {
    owner: Owner,
    actual: Option<Result<Completion, Errno>>,
    status: Delivery,
    attempting: bool,
}
impl EffectsReceiver {
    pub(crate) fn new(actual: TakenEffects) -> Self {
        let (owner, actual) = actual.into_parts();
        Self {
            owner,
            actual: Some(actual),
            status: Delivery::Ready,
            attempting: false,
        }
    }
    pub(crate) fn status(&self) -> Delivery {
        self.status
    }
    pub(crate) fn is_delivered(&self) -> bool {
        matches!(self.status, Delivery::Delivered(_))
    }
    #[cfg(test)]
    pub(crate) fn held_completion(&self) -> Option<&Completion> {
        self.actual.as_ref().and_then(|result| result.as_ref().ok())
    }
    fn done(&mut self, result: Result<Delivered, Errno>) -> Delivery {
        // Only scalar completions reach here. Physical removal ownership is
        // kept intact until an actual acknowledged receiver exists.
        self.actual = None;
        self.status = Delivery::Delivered(result);
        self.status
    }
    fn fault(&mut self) -> Delivery {
        self.status = Delivery::ProtocolFaultOwned;
        self.status
    }
    pub(crate) fn step(&mut self, table: &mut ProcessTable, host: &mut dyn HostIO) -> Delivery {
        if self.is_delivered() || self.status == Delivery::ProtocolFaultOwned {
            return self.status;
        }
        if self.attempting {
            return self.fault();
        }
        let Some(actual) = self.actual.as_ref() else {
            return self.fault();
        };
        let completion = match actual {
            Err(error) => return self.done(Err(*error)),
            Ok(completion) => completion,
        };
        if matches!(
            completion,
            Completion::Removed(_) | Completion::InitReaped(_)
        ) {
            self.status = Delivery::PendingPhysicalReceiver;
            return self.status;
        }
        let Some(proc) = table.get(self.owner.pid) else {
            return self.fault();
        };
        let expected_generation = if matches!(completion, Completion::Exec) {
            self.owner.generation.checked_add(1)
        } else {
            Some(self.owner.generation)
        };
        if Some(proc.exec_generation) != expected_generation
            || proc.pointer_width != self.owner.pointer_width
        {
            // An exec can legitimately change pointer width; its scalar
            // completion has no old-memory access. Every memory effect must
            // still match the captured original width and generation exactly.
            if !matches!(completion, Completion::Exec)
                || Some(proc.exec_generation) != expected_generation
            {
                return self.fault();
            }
        }
        let result = match completion {
            Completion::ThreadExit(ctid) => {
                let Request::ThreadExit {
                    pid,
                    tid,
                    clear_child_tid,
                } = self.owner.request
                else {
                    return self.fault();
                };
                if proc.get_thread(tid).is_some() {
                    return self.fault();
                }
                let ctid = *ctid;
                if !matches!(self.owner.pointer_width, 4 | 8)
                    || (self.owner.pointer_width == 4 && ctid > u32::MAX as usize)
                {
                    return self.fault();
                }
                if clear_child_tid && ctid != 0 {
                    if !matches!(proc.state, ProcessState::Running | ProcessState::Stopped) {
                        return self.fault();
                    }
                    // Record before HostIO: a trapped import is not authority
                    // to repeat a write or wake against a replacement memory.
                    self.attempting = true;
                    self.status = Delivery::ProtocolFaultOwned;
                    if host.proc_write_bytes(pid as i32, ctid as u64, &0u32.to_le_bytes()) == 0 {
                        crate::wait_park::with(|parks| {
                            parks.futex_wake(pid, ctid as u64, 1, u32::MAX)
                        });
                    }
                }
                // Preserve Linux clear-TID fault semantics: a failed put_user
                // is ignored, and only a successful store wakes a waiter.
                Delivered::ThreadExit(ctid)
            }
            Completion::Exec => Delivered::Exec,
            Completion::Exit(status) => {
                let Request::Exit {
                    pid,
                    tid,
                    thread_worker,
                    ..
                } = self.owner.request
                else {
                    return self.fault();
                };
                if (!thread_worker && proc.state != ProcessState::Exited)
                    || proc.exit_status != *status
                {
                    return self.fault();
                }
                let status = *status;
                self.attempting = true;
                self.status = Delivery::ProtocolFaultOwned;
                if table.current_pid() == pid && table.current_tid() == tid {
                    table.clear_current_tid_binding();
                }
                crate::syscalls::finish_scm_rights_cleanup(table.advisory_locks_mut(), host);
                table.release_orphaned_ofd_locks();
                Delivered::Exit(status)
            }
            Completion::RetryReleased => {
                let Request::ReleaseRetry { token, .. } = self.owner.request else {
                    return self.fault();
                };
                if proc.blocked_retries.binding_for_token(token).is_some() {
                    return self.fault();
                }
                Delivered::RetryReleased
            }
            Completion::Signaled => {
                let Request::SignalExit { signum, .. } = self.owner.request else {
                    return self.fault();
                };
                if proc.state != ProcessState::Exited || proc.exit_signal != signum {
                    return self.fault();
                }
                Delivered::Signaled
            }
            _ => unreachable!(),
        };
        self.done(Ok(result))
    }
}

/// Current synchronous thread-exit consumer. The same frozen registry entry
/// survives an illegal pending/fault legacy call; ordinary success consumes
/// its effects once and forgets only the delivered scalar observation.
pub(crate) fn thread_exit(
    table: &mut ProcessTable,
    host: &mut dyn HostIO,
    pid: u32,
    tid: u32,
    clear_child_tid: bool,
) -> Result<usize, Errno> {
    super::registry::with_registry(|registry| {
        let handle = registry.admit(
            table,
            Request::ThreadExit {
                pid,
                tid,
                clear_child_tid,
            },
        )?;
        match registry.step(handle, table, host)?.status {
            super::registry::Status::Complete(_) => (),
            _ => panic!("thread exit requires owned lifecycle intent scheduling"),
        }
        let result = match registry.deliver_completion(handle, table, host)? {
            Delivery::Delivered(Ok(Delivered::ThreadExit(ctid))) => Ok(ctid),
            Delivery::Delivered(Err(error)) => Err(error),
            _ => panic!("thread exit requires effects containment"),
        };
        registry.forget(handle)?;
        result
    })?
}
