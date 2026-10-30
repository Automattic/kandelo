//! Kernel custody for resumable lifecycle intents. No handle is exported yet.
//! GKL protects the accompanying process table; try-lock rejects registry
//! reentry instead of permitting a second mutable owner across a host call.
use super::{Completion, Intent, Progress, Request};
use crate::{
    exec_target::PreparedExecOwner, lock::OfdId, process::HostIO, process_table::ProcessTable,
};
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

const MAX_INTENTS: usize = 64;
static REGISTRY: spin::Mutex<IntentRegistry> = spin::Mutex::new(IntentRegistry::new());

/// Future kernel wrappers must acquire GKL before accessing the actual table.
/// This lock also rejects synchronous reentry from a native host callback.
pub(crate) fn with_registry<T>(f: impl FnOnce(&mut IntentRegistry) -> T) -> Result<T, Errno> {
    let mut registry = REGISTRY.try_lock().ok_or(Errno::EBUSY)?;
    Ok(f(&mut registry))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Handle(i64);
impl Handle {
    pub(crate) fn from_raw(raw: i64) -> Result<Self, Errno> {
        if raw <= 0 {
            Err(Errno::EINVAL)
        } else {
            Ok(Self(raw))
        }
    }
    pub(crate) fn raw(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Owner {
    pub(crate) pid: u32,
    pub(crate) generation: u64,
    pub(crate) request: Request,
}

/// Copied observation only. It never owns a removal's handle lists or CTID
/// publication authority; the actual Completion stays in the registry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Completed {
    Exec,
    Exit(i32),
    ThreadExit,
    Removed,
    RetryReleased,
    Signaled,
    InitReaped { pid: u32, status: i32, signal: u32 },
}
impl Completed {
    fn of(completion: &Completion) -> Self {
        match completion {
            Completion::Exec => Self::Exec,
            Completion::Exit(status) => Self::Exit(*status),
            Completion::ThreadExit(_) => Self::ThreadExit,
            Completion::Removed(_) => Self::Removed,
            Completion::RetryReleased => Self::RetryReleased,
            Completion::Signaled => Self::Signaled,
            Completion::InitReaped(reap) => Self::InitReaped {
                pid: reap.pid,
                status: reap.exit_status,
                signal: reap.exit_signal,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Status {
    Captured,
    PendingOwned,
    ProtocolFaultOwned,
    /// No consuming operation happened; retry or explicit abandonment remains
    /// possible. Unlike a finished error, this is not takeable completion.
    Refused(Errno),
    Abandoning {
        query_cleanup_started: bool,
        fault: bool,
    },
    Abandoned {
        query_cleanup_started: bool,
        target_cancelled: bool,
        invalidated: bool,
    },
    Complete(Result<Completed, Errno>),
    /// Actual effects moved to a trusted Rust receiver, not executed or ACKed
    /// by the host. Scalar tombstone remains budgeted until explicit Forget.
    Taken(Result<Completed, Errno>),
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Snapshot {
    pub(crate) handle: Handle,
    pub(crate) owner: Owner,
    pub(crate) status: Status,
}

/// The caller must install a real Rust effects receiver before taking this
/// owner. Moving custody is not evidence that cleanup/publication ran. In
/// particular, old-generation CTID effects must not target a replacement image.
#[must_use = "install a real effects receiver; taken completion still owns lifecycle effects"]
pub(crate) struct TakenEffects {
    owner: Owner,
    result: Result<Completion, Errno>,
}
impl TakenEffects {
    pub(crate) fn into_parts(self) -> (Owner, Result<Completion, Errno>) {
        (self.owner, self.result)
    }
}

#[derive(Clone, Copy)]
struct ExecLease {
    token: u32,
    ofd_idx: usize,
    ofd_id: OfdId,
    owner: PreparedExecOwner,
}
struct Live {
    intent: Intent,
    query_cleanup_started: bool,
    abandoning: bool,
    status: Status,
}
enum State {
    Live(Live),
    Complete(Result<Completion, Errno>),
    Abandoned(Status),
    Taken(Result<Completed, Errno>),
}
struct Entry {
    handle: Handle,
    owner: Owner,
    exec: Option<ExecLease>,
    state: State,
}
impl Entry {
    fn snapshot(&self) -> Snapshot {
        let status = match &self.state {
            State::Live(live) => live.status,
            State::Complete(result) => {
                Status::Complete(result.as_ref().map(Completed::of).map_err(|e| *e))
            }
            State::Abandoned(status) => *status,
            State::Taken(result) => Status::Taken(*result),
        };
        Snapshot {
            handle: self.handle,
            owner: self.owner,
            status,
        }
    }
}

pub(crate) struct IntentRegistry {
    entries: Vec<Entry>,
    next_handle: Option<i64>,
    limit: usize,
}
impl IntentRegistry {
    const fn new() -> Self {
        Self {
            entries: Vec::new(),
            next_handle: Some(1),
            limit: MAX_INTENTS,
        }
    }
    #[cfg(test)]
    pub(crate) fn for_test(limit: usize, next: i64) -> Self {
        assert!(limit <= MAX_INTENTS && next > 0);
        Self {
            entries: Vec::new(),
            next_handle: Some(next),
            limit,
        }
    }
    fn index(&self, handle: Handle) -> Result<usize, Errno> {
        self.entries
            .iter()
            .position(|entry| entry.handle == handle)
            .ok_or(Errno::ENOENT)
    }
    pub(crate) fn inspect(&self, handle: Handle) -> Result<Snapshot, Errno> {
        Ok(self.entries[self.index(handle)?].snapshot())
    }
    pub(crate) fn admit(
        &mut self,
        table: &ProcessTable,
        request: Request,
    ) -> Result<Handle, Errno> {
        if self.entries.len() >= self.limit {
            return Err(Errno::ENOSPC);
        }
        let next = self.next_handle.ok_or(Errno::EOVERFLOW)?;
        // Reserve the entire registry entry before any lifecycle/native work.
        self.entries
            .try_reserve_exact(1)
            .map_err(|_| Errno::ENOMEM)?;
        let intent = Intent::capture(table, request)?;
        let proc = table.get(request.pid()).ok_or(Errno::ESRCH)?;
        let exec = match request {
            Request::Exec { pid, tid, target } => {
                table.validate_task(pid, tid)?;
                let prepared = proc.prepared_exec_targets.get(target)?;
                prepared
                    .owner()
                    .validate_process(pid, tid, intent.generation)?;
                Some(ExecLease {
                    token: target,
                    ofd_idx: prepared.ofd_ref().0,
                    ofd_id: prepared.ofd_id(),
                    owner: prepared.owner(),
                })
            }
            Request::SpawnExec {
                parent,
                child,
                target,
            } => {
                if table.get(parent).is_none() || proc.ppid != parent {
                    return Err(Errno::ESRCH);
                }
                let prepared = proc.prepared_exec_targets.get(target)?;
                prepared
                    .owner()
                    .validate_spawn(parent, child, intent.generation)?;
                Some(ExecLease {
                    token: target,
                    ofd_idx: prepared.ofd_ref().0,
                    ofd_id: prepared.ofd_id(),
                    owner: prepared.owner(),
                })
            }
            _ => {
                if !intent.may_preflight(table)? {
                    return Err(Errno::ECHILD);
                }
                None
            }
        };
        let handle = Handle(next);
        self.next_handle = next.checked_add(1);
        let owner = Owner {
            pid: request.pid(),
            generation: intent.generation,
            request,
        };
        self.entries.push(Entry {
            handle,
            owner,
            exec,
            state: State::Live(Live {
                intent,
                query_cleanup_started: false,
                abandoning: false,
                status: Status::Captured,
            }),
        });
        Ok(handle)
    }
    pub(crate) fn step(
        &mut self,
        handle: Handle,
        table: &mut ProcessTable,
        host: &mut dyn HostIO,
    ) -> Result<Snapshot, Errno> {
        let index = self.index(handle)?;
        let entry = &mut self.entries[index];
        let State::Live(live) = &mut entry.state else {
            return Ok(entry.snapshot());
        };
        if live.abandoning {
            return self.abandon(handle, table, host);
        }
        match live.intent.step(table, host) {
            Ok(Progress::PendingOwned) => {
                live.query_cleanup_started = true;
                live.status = Status::PendingOwned;
            }
            Ok(Progress::ProtocolFaultOwned) => {
                live.query_cleanup_started = true;
                live.status = Status::ProtocolFaultOwned;
            }
            Ok(Progress::Complete(completion)) => entry.state = State::Complete(Ok(completion)),
            Err(error) if live.intent.finished => entry.state = State::Complete(Err(error)),
            Err(error) => {
                // A normal exec/remove invalidates old resources. Never use
                // an old token/FD against its replacement process image.
                if table
                    .get(entry.owner.pid)
                    .is_none_or(|proc| proc.exec_generation != entry.owner.generation)
                {
                    entry.state = State::Complete(Err(Errno::ESRCH));
                } else {
                    live.status = Status::Refused(error);
                }
            }
        }
        Ok(entry.snapshot())
    }
    pub(crate) fn abandon(
        &mut self,
        handle: Handle,
        table: &mut ProcessTable,
        host: &mut dyn HostIO,
    ) -> Result<Snapshot, Errno> {
        let index = self.index(handle)?;
        let entry = &mut self.entries[index];
        let State::Live(live) = &mut entry.state else {
            return match entry.state {
                State::Abandoned(_) => Ok(entry.snapshot()),
                _ => Err(Errno::EBUSY),
            };
        };
        live.abandoning = true;
        let Some(proc) = table
            .get_mut(entry.owner.pid)
            .filter(|proc| proc.exec_generation == entry.owner.generation)
        else {
            entry.state = State::Abandoned(Status::Abandoned {
                query_cleanup_started: live.query_cleanup_started,
                target_cancelled: false,
                invalidated: true,
            });
            return Ok(entry.snapshot());
        };
        if live.query_cleanup_started {
            match crate::syscalls::preflight_gl_query_teardown(
                proc,
                host,
                live.intent.request.cleanup_tid(),
            ) {
                crate::syscalls::GlQueryTeardown::Ready => (),
                pending => {
                    live.status = Status::Abandoning {
                        query_cleanup_started: true,
                        fault: pending == crate::syscalls::GlQueryTeardown::ProtocolFaultOwned,
                    };
                    return Ok(entry.snapshot());
                }
            }
        }
        let mut target_cancelled = false;
        let mut invalidated = false;
        if let Some(exact) = entry.exec {
            match proc.prepared_exec_targets.retained_identity(exact.token) {
                Ok(target)
                    if target.ofd_ref.0 == exact.ofd_idx
                        && target.ofd_id == exact.ofd_id
                        && target.owner == exact.owner =>
                {
                    if target.retiring {
                        live.status = Status::Abandoning {
                            query_cleanup_started: live.query_cleanup_started,
                            fault: true,
                        };
                        return Ok(entry.snapshot());
                    }
                }
                Ok(_) => {
                    live.status = Status::Abandoning {
                        query_cleanup_started: live.query_cleanup_started,
                        fault: true,
                    };
                    return Ok(entry.snapshot());
                }
                Err(_) => invalidated = true, // Normal explicit target cancel already owns cleanup.
            }
            if !invalidated {
                let (proc, locks) = table
                    .process_and_advisory_locks(entry.owner.pid)
                    .ok_or(Errno::ESRCH)?;
                if crate::exec_target::cancel(proc, locks, host, entry.owner.pid, exact.token)
                    .is_err()
                {
                    live.status = Status::Abandoning {
                        query_cleanup_started: live.query_cleanup_started,
                        fault: true,
                    };
                    return Ok(entry.snapshot());
                }
                target_cancelled = true;
            }
        }
        entry.state = State::Abandoned(Status::Abandoned {
            query_cleanup_started: live.query_cleanup_started,
            target_cancelled,
            invalidated,
        });
        Ok(entry.snapshot())
    }
    /// Transfer actual non-Clone effects to a trusted Rust receiver. This is
    /// NOT a native cleanup ACK, host completion or proof of effect execution.
    pub(crate) fn take_completion(&mut self, handle: Handle) -> Result<TakenEffects, Errno> {
        let index = self.index(handle)?;
        let entry = &mut self.entries[index];
        let State::Complete(result) = &entry.state else {
            return Err(Errno::EBUSY);
        };
        let summary = result.as_ref().map(Completed::of).map_err(|e| *e);
        let State::Complete(result) = core::mem::replace(&mut entry.state, State::Taken(summary))
        else {
            unreachable!()
        };
        Ok(TakenEffects {
            owner: entry.owner,
            result,
        })
    }
    pub(crate) fn forget(&mut self, handle: Handle) -> Result<(), Errno> {
        let index = self.index(handle)?;
        if !matches!(
            self.entries[index].state,
            State::Taken(_) | State::Abandoned(_)
        ) {
            return Err(Errno::EBUSY);
        }
        self.entries.remove(index);
        Ok(())
    }
}
