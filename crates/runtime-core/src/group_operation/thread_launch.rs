//! Native pthread effects retained by the actual clone operation. A prepared
//! Worker receives scalars only; issuing Memory delivery is the commit boundary.
use super::*;
use wasm_posix_shared::group_storage::status as S;
use W::{command as C, effect as E};

pub(super) struct Launch {
    effect: u32,
    sequence: u32,
    entered: bool,
    cancelled: bool,
    committed: bool,
    completing: bool,
    interrupted: Option<(u32, u32)>,
}
impl Launch {
    pub(super) fn new() -> Self {
        Self {
            effect: E::THREAD_OBJECTS,
            sequence: 1,
            entered: false,
            cancelled: false,
            committed: false,
            completing: false,
            interrupted: None,
        }
    }
    pub(super) fn committed(&self) -> bool {
        self.committed
    }
    pub(super) fn succeeded(&self) -> bool {
        self.effect == E::THREAD_SUCCEEDED
    }
    pub(super) fn failed(&self) -> bool {
        self.effect == E::THREAD_FAILED
    }
    fn untouched(&self) -> bool {
        self.effect == E::THREAD_OBJECTS && self.sequence == 1 && !self.entered
    }
    fn next(&mut self, effect: u32) {
        self.effect = effect;
        self.sequence = self
            .sequence
            .checked_add(1)
            .expect("bounded pthread effect sequence");
        self.entered = false;
        self.completing = false;
    }
    pub(super) fn cancel(&mut self) {
        if self.cancelled
            || self.committed
            || matches!(self.effect, E::THREAD_FAILED | E::THREAD_FATAL)
        {
            return;
        }
        self.cancelled = true;
        if self.entered {
            self.interrupted = Some((self.effect, self.sequence));
        }
        self.next(E::THREAD_CANCEL_NATIVE);
    }
}

impl ProcessTable {
    pub fn report_group_thread_setup_failure(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        fact: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        if !matches!(
            fact,
            C::THREAD_SETUP_FAILED | C::THREAD_SETUP_NO_MEMORY | C::THREAD_SETUP_UNAVAILABLE
        ) {
            return Err(Errno::EINVAL);
        }
        let key = Key {
            group: receipt.group,
            token,
        };
        let operation = self
            .group_operations()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt || operation.request.kind != kind::CLONE {
            return Err(Errno::ESRCH);
        }
        let initial = operation.phase == Phase::ThreadLaunch
            && operation
                .thread_launch
                .as_ref()
                .is_some_and(|launch| launch.untouched() || launch.failed());
        let cleaning = operation.failure.is_some()
            && matches!(
                operation.phase,
                Phase::ThreadDetach | Phase::ThreadExit | Phase::ThreadControls | Phase::Done
            );
        if !initial && !cleaning {
            return Err(Errno::EBUSY);
        }
        let mut entry = self
            .group_operations()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let operation = entry.value_mut();
        if initial {
            operation.failure.get_or_insert(match fact {
                C::THREAD_SETUP_NO_MEMORY => Errno::ENOMEM,
                C::THREAD_SETUP_UNAVAILABLE => Errno::EOPNOTSUPP,
                _ => Errno::EIO,
            });
            // No native object effect was issued, or the native owner already
            // completed containment and exact reference detachment.
            operation.phase = Phase::ThreadDetach;
        }
        let result = self.advance_group_operation(operation, host);
        self.group_operations().entries.publish_io(entry);
        result
    }

    pub(super) fn begin_group_thread_cleanup(&mut self, child: ReceiptRecord) -> Result<(), Errno> {
        match self.memory_groups().resolve_receipt(child) {
            Ok(admission) => match self.memory_groups().begin_retirement(admission) {
                Ok(()) | Err(Errno::EBUSY) => Ok(()),
                Err(error) => Err(error),
            },
            Err(Errno::ESRCH) => {
                // An accepted exact native fact can retire admission before
                // the real ThreadState and physical control mapping end.
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if store.status(admission)? & S::STOPPED == 0 {
                    return Err(Errno::EBUSY);
                }
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub fn group_thread_launch_control(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        command: u32,
        sequence: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let key = Key {
            group: receipt.group,
            token,
        };
        let operation = self
            .group_operations()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt
            || operation.request.kind != kind::CLONE
            || operation.phase != Phase::ThreadLaunch
            || operation.thread_launch.is_none()
        {
            return Err(Errno::ESRCH);
        }
        let mut entry = self
            .group_operations()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let operation = entry.value_mut();
        let mut launch = operation.thread_launch.take().ok_or(Errno::EIO)?;
        let result = self.advance_thread_launch(operation, &mut launch, command, sequence, host);
        operation.thread_launch = Some(launch);
        self.group_operations().entries.publish_io(entry);
        result
    }

    pub(super) fn group_clone_parent_stopping(&mut self, receipt: ReceiptRecord) -> bool {
        let live = self
            .memory_group_task(receipt.pid, receipt.tid)
            .ok()
            .flatten()
            .is_some_and(|admission| {
                admission.record() == receipt
                    && self.memory_group_running_admission(admission).is_ok()
            });
        !live
            || self.get(receipt.pid).is_none_or(|process| {
                process.exec_generation != receipt.generation
                    || process.exit_signal != 0
                    || matches!(
                        process.state,
                        crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
                    )
            })
            || self
                .memory_groups()
                .storage_owner(receipt)
                .and_then(|(store, admission)| store.status(admission))
                .map_or(true, |status| {
                    status & (S::STOPPING | S::STOPPED) != 0 || status & S::SOURCE_LIVE == 0
                })
    }

    fn advance_thread_launch(
        &mut self,
        operation: &mut Operation,
        launch: &mut Launch,
        command: u32,
        sequence: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let child = operation.child.ok_or(Errno::EIO)?;
        let native_permission = if !launch.cancelled && matches!(launch.effect, E::THREAD_START | E::THREAD_DELIVER) {
            self.group_native_start_permission(child, host)?
        } else { crate::group_completion::NativeStart::Ready };
        let parent_stopping = self.group_clone_parent_stopping(operation.receipt);
        let child_admitted = self
            .memory_group_task(child.pid, child.tid)
            .ok()
            .flatten()
            .is_some_and(|admission| {
                admission.record() == child
                    && self.memory_group_running_admission(admission).is_ok()
            });
        let child_dead = native_permission == crate::group_completion::NativeStart::Dead || !child_admitted
            || self.get(child.pid).is_none_or(|process| {
                process.exec_generation != child.generation
                    || process.exit_signal != 0
                    || matches!(
                        process.state,
                        crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
                    )
                    || process.get_thread(child.tid).is_none()
            });
        if parent_stopping {
            operation.deliver = false;
        }
        if !launch.committed && (parent_stopping || child_dead) {
            operation.failure.get_or_insert(Errno::ESRCH);
            launch.cancel();
        }
        let stopped = native_permission == crate::group_completion::NativeStart::Stopped || self
            .get(child.pid)
            .is_some_and(|process| process.state == crate::process::ProcessState::Stopped);
        let gated = stopped
            && !launch.cancelled
            && matches!(launch.effect, E::THREAD_START | E::THREAD_DELIVER);
        let mut execute = false;
        if command == C::THREAD_NATIVE_POLL {
            if sequence != 0 {
                return Err(Errno::EINVAL);
            }
        } else if sequence == 0 {
            return Err(Errno::EINVAL);
        } else if sequence < launch.sequence {
            // An interrupted native effect must actually settle before its
            // resources can be disposed. Timeout is not a settlement fact.
            if launch
                .interrupted
                .is_some_and(|(_, interrupted)| interrupted == sequence)
            {
                match command {
                    C::THREAD_NATIVE_COMPLETED
                    | C::THREAD_NATIVE_FAILED
                    | C::THREAD_NATIVE_NO_MEMORY => launch.interrupted = None,
                    C::THREAD_NATIVE_CONSTRUCTOR_UNKNOWN | C::THREAD_NATIVE_PROTOCOL_FAILED => {
                        operation.failure.get_or_insert(Errno::EIO);
                        launch.next(E::THREAD_FATAL);
                    }
                    _ => {}
                }
            }
        } else {
            if sequence != launch.sequence {
                return Err(Errno::EBUSY);
            }
            match command {
                C::THREAD_NATIVE_VALIDATE if launch.entered => execute = !gated,
                C::THREAD_NATIVE_NOT_APPLIED
                    if launch.entered && matches!(launch.effect, E::THREAD_START | E::THREAD_DELIVER) =>
                {
                    // The mechanical adapter reports refusal before postMessage;
                    // a throwing/uncertain postMessage must report FAILED instead.
                    launch.committed = false;
                    launch.next(launch.effect);
                }
                C::THREAD_NATIVE_TIMEOUT if stopped && !launch.cancelled && launch.entered => {}
                C::THREAD_NATIVE_ENTERED
                    if !launch.entered
                        && !matches!(
                            launch.effect,
                            E::THREAD_SUCCEEDED | E::THREAD_FAILED | E::THREAD_FATAL
                        ) =>
                {
                    if !gated {
                        launch.entered = true;
                        // There is no fork replay gate. Delivery may execute the
                        // child before the platform completion report arrives.
                        if launch.effect == E::THREAD_DELIVER {
                            launch.committed = true;
                        }
                        execute = true;
                    }
                }
                C::THREAD_NATIVE_COMPLETED if launch.entered => {
                    match self.complete_thread_native(operation, launch, child, host) {
                        Ok(()) => {}
                        Err(Errno::EAGAIN) if launch.effect == E::THREAD_CANCEL_NATIVE => {
                            launch.completing = true
                        }
                        Err(error) => return Err(error),
                    }
                }
                C::THREAD_NATIVE_FAILED
                | C::THREAD_NATIVE_NO_MEMORY
                | C::THREAD_NATIVE_PROTOCOL_FAILED
                | C::THREAD_NATIVE_CONSTRUCTOR_UNKNOWN
                | C::THREAD_NATIVE_TIMEOUT
                    if launch.entered =>
                {
                    operation
                        .failure
                        .get_or_insert(if command == C::THREAD_NATIVE_NO_MEMORY {
                            Errno::ENOMEM
                        } else {
                            Errno::EIO
                        });
                    if launch.committed
                        || launch.cancelled
                        || matches!(
                            command,
                            C::THREAD_NATIVE_PROTOCOL_FAILED | C::THREAD_NATIVE_CONSTRUCTOR_UNKNOWN
                        )
                    {
                        launch.next(E::THREAD_FATAL);
                    } else {
                        if command != C::THREAD_NATIVE_TIMEOUT {
                            launch.entered = false;
                        }
                        launch.cancel();
                    }
                }
                _ => return Err(Errno::EBUSY),
            }
        }
        if launch.completing && command == C::THREAD_NATIVE_POLL {
            match self.complete_thread_native(operation, launch, child, host) {
                Ok(()) | Err(Errno::EAGAIN) => {}
                Err(error) => return Err(error),
            }
        }
        if launch.effect == E::THREAD_FATAL {
            let groups = self.memory_groups();
            let group = groups.resolve_group(operation.receipt.group)?;
            let store = groups.storage_mut(group)?;
            let root = store.root_for_image(operation.receipt)?;
            let stopped = store.quarantine_image(
                &mut HostMemory {
                    resource: store.resource(),
                    host,
                },
                root,
            );
            groups.quarantine_image_tasks(operation.receipt)?;
            match stopped {
                Ok(()) | Err(Errno::EAGAIN) => {}
                Err(error) => return Err(error),
            }
        }
        let pending = launch.entered && !execute;
        let mut reply =
            Self::group_operation_reply(operation, if pending { E::YIELD } else { launch.effect });
        reply.length = launch.sequence;
        reply.delay = match launch.effect {
            E::THREAD_READY => 10_000,
            E::THREAD_START | E::THREAD_CONTAIN => 30_000,
            _ => 0,
        };
        if gated {
            reply.effect = E::YIELD;
            reply.delay = 0;
        } else if pending && launch.completing {
            reply.delay = 10;
        } else if pending {
            reply.flags |= flags::NATIVE_PENDING;
            if reply.delay == 0 {
                reply.delay = 30_000;
            }
        }
        if execute {
            reply.flags |= flags::NATIVE_EXECUTE;
        }
        Ok(reply)
    }

    fn complete_thread_native(
        &mut self,
        operation: &mut Operation,
        launch: &mut Launch,
        child: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let next = match launch.effect {
            E::THREAD_OBJECTS => E::THREAD_BIND,
            E::THREAD_BIND => {
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if !store.has_platform_references(admission)? {
                    return Err(Errno::EBUSY);
                }
                E::THREAD_CONNECT
            }
            E::THREAD_CONNECT => E::THREAD_START,
            E::THREAD_START => E::THREAD_READY,
            E::THREAD_READY => E::THREAD_RUNTIME,
            E::THREAD_RUNTIME => E::THREAD_DELIVER,
            E::THREAD_DELIVER => E::THREAD_SUCCEEDED,
            E::THREAD_CANCEL_NATIVE => {
                // This clone owner has never issued Memory delivery. A native
                // scalar-only prepared Worker may exist; this is not a false
                // claim that a constructor never ran or Browser terminate joins.
                if launch.committed {
                    return Err(Errno::EBUSY);
                }
                if launch.interrupted.is_some() {
                    return Err(Errno::EAGAIN);
                }
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                store.stop_undelivered_thread(
                    &mut HostMemory {
                        resource: store.resource(),
                        host,
                    },
                    admission,
                )?;
                E::THREAD_CONTAIN
            }
            E::THREAD_CONTAIN => {
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if store.has_platform_references(admission)? {
                    E::THREAD_REFERENCES
                } else {
                    E::THREAD_DISPOSE
                }
            }
            E::THREAD_REFERENCES => {
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if store
                    .pending_platform_references(admission, false)?
                    .is_some()
                {
                    return Err(Errno::EBUSY);
                }
                E::THREAD_DISPOSE
            }
            E::THREAD_DISPOSE => E::THREAD_FAILED,
            _ => return Err(Errno::EBUSY),
        };
        launch.next(next);
        if next == E::THREAD_FAILED {
            operation.failure.get_or_insert(Errno::EIO);
        }
        Ok(())
    }
}
