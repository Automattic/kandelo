//! Native fork progression retained inside the actual fork operation.
//! Native effects carry an exact sequence; pending native waits do not prevent
//! the kernel from selecting cancellation and cleanup on a later entry.
use super::*;
use wasm_posix_shared::{
    group_storage::{status as S, Action},
    memory_group::TaskAction,
};
use W::{command as C, effect as E};

pub(super) struct Launch {
    effect: u32,
    sequence: u32,
    entered: bool,
    cancelled: bool,
    committed: bool,
    contained: bool,
    completing: bool,
}
impl Launch {
    pub(super) fn new() -> Self {
        Self {
            effect: E::FORK_OBJECTS,
            sequence: 1,
            entered: false,
            cancelled: false,
            committed: false,
            contained: false,
            completing: false,
        }
    }
    pub(super) fn succeeded(&self) -> bool {
        self.effect == E::FORK_SUCCEEDED
    }
    pub(super) fn committed(&self) -> bool {
        self.committed
    }
    pub(super) fn failed(&self) -> bool {
        self.effect == E::FORK_FAILED
    }
    pub(super) fn untouched(&self) -> bool {
        self.effect == E::FORK_OBJECTS && self.sequence == 1 && !self.entered
    }
    fn next(&mut self, effect: u32) {
        self.effect = effect;
        self.sequence = self
            .sequence
            .checked_add(1)
            .expect("bounded fork effect sequence");
        self.entered = false;
        self.completing = false;
    }
    pub(super) fn cancel(&mut self) {
        if self.cancelled || self.committed || matches!(self.effect, E::FORK_FAILED | E::FORK_FATAL)
        {
            return;
        }
        self.cancelled = true;
        self.next(E::FORK_CANCEL_NATIVE);
    }
}
impl ProcessTable {
    /// A callback that never entered the native owner reports a platform fact,
    /// not a guest errno. A partially abandoned native launch is uncertainty.
    pub fn report_group_fork_setup_failure(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        no_memory: bool,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let key = Key {
            group: receipt.group,
            token,
        };
        let owner = self
            .group_operations()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if owner.receipt != receipt || owner.request.kind != kind::FORK {
            return Err(Errno::ESRCH);
        }
        let initial = owner.phase == Phase::ForkLaunch
            && owner
                .launch
                .as_ref()
                .is_some_and(|launch| launch.untouched() || launch.failed());
        let cancelled = owner.failure.is_some()
            && matches!(
                owner.phase,
                Phase::ForkCancel
                    | Phase::ForkRetireTransport
                    | Phase::ForkRemoveTransport
                    | Phase::ForkRemoveKernel
                    | Phase::ForkComplete
                    | Phase::Done
            );
        if !initial && !cancelled {
            return Err(Errno::EBUSY);
        }
        let mut entry = self
            .group_operations()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let owner = entry.value_mut();
        if initial {
            owner
                .failure
                .get_or_insert(if no_memory { Errno::ENOMEM } else { Errno::EIO });
            owner.phase = Phase::ForkCancel;
        }
        let result = self.advance_group_operation(owner, host);
        self.group_operations().entries.publish_io(entry);
        result
    }

    pub(crate) fn validate_fork_control_start(
        &mut self,
        record: ReceiptRecord,
    ) -> Result<(), Errno> {
        if self
            .group_operations()
            .entries
            .values()
            .any(|operation| operation.child == Some(record) && operation.launch.is_some())
        {
            return Err(Errno::EBUSY);
        }
        Ok(())
    }
    pub fn group_fork_launch_control(
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
            || operation.request.kind != kind::FORK
            || operation.phase != Phase::ForkLaunch
            || operation.launch.is_none()
        {
            return Err(Errno::ESRCH);
        }
        let mut entry = self
            .group_operations()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let result = self.advance_fork_launch(entry.value_mut(), command, sequence, host);
        self.group_operations().entries.publish_io(entry);
        result
    }
    fn advance_fork_launch(
        &mut self,
        operation: &mut Operation,
        command: u32,
        sequence: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let child = operation.child.ok_or(Errno::EIO)?;
        let mut launch = operation.launch.take().ok_or(Errno::EIO)?;
        let result =
            self.advance_fork_launch_owned(operation, &mut launch, child, command, sequence, host);
        operation.launch = Some(launch);
        result
    }
    fn advance_fork_launch_owned(
        &mut self,
        operation: &mut Operation,
        launch: &mut Launch,
        child: ReceiptRecord,
        command: u32,
        sequence: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        // Process exit is authoritative immediately. Its native realm/storage
        // teardown may arrive later and cannot be required to cancel a fork.
        let parent_live = self
            .memory_group_task(operation.receipt.pid, operation.receipt.tid)
            .ok()
            .flatten()
            .is_some_and(|admission| {
                admission.record() == operation.receipt
                    && self.memory_group_running_admission(admission).is_ok()
            });
        let parent_stopping = !parent_live
            || self
                .memory_groups()
                .storage_owner(operation.receipt)
                .and_then(|(store, admission)| store.status(admission))
                .map_or(true, |state| {
                    state & (S::STOPPING | S::STOPPED) != 0 || state & S::SOURCE_LIVE == 0
                });
        let child_dead = self.get(child.pid).is_none_or(|proc| {
            proc.exec_generation != child.generation
                || proc.exit_signal != 0
                || matches!(
                    proc.state,
                    crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
                )
        });
        if parent_stopping {
            operation.deliver = false;
        }
        if !launch.committed && (parent_stopping || child_dead) {
            operation.failure.get_or_insert(Errno::ESRCH);
            launch.cancel();
        }
        let child_stopped = self
            .get(child.pid)
            .is_some_and(|proc| proc.state == crate::process::ProcessState::Stopped);
        let mut execute = false;
        if command != C::FORK_NATIVE_POLL && sequence == 0 {
            return Err(Errno::EINVAL);
        }
        if command == C::FORK_NATIVE_POLL {
            if sequence != 0 {
                return Err(Errno::EINVAL);
            }
        } else if sequence < launch.sequence {
            // A cancelled native listener/constructor may finish later. This
            // observation cannot authorize the replacement cleanup effect.
        } else {
            if sequence != launch.sequence {
                return Err(Errno::EBUSY);
            }
            match command {
                C::FORK_NATIVE_VALIDATE if launch.entered => {
                    execute =
                        !(child_stopped && launch.effect == E::FORK_DELIVER && !launch.cancelled);
                }
                C::FORK_NATIVE_NOT_APPLIED
                    if launch.entered && launch.effect == E::FORK_DELIVER && !launch.cancelled =>
                {
                    launch.next(E::FORK_DELIVER);
                }
                C::FORK_NATIVE_TIMEOUT if child_stopped && !launch.cancelled && launch.entered => {}
                C::FORK_NATIVE_ENTERED
                    if !launch.entered
                        && !matches!(
                            launch.effect,
                            E::FORK_SUCCEEDED | E::FORK_FAILED | E::FORK_FATAL
                        ) =>
                {
                    if !(child_stopped && launch.effect == E::FORK_DELIVER && !launch.cancelled) {
                        launch.entered = true;
                        execute = true;
                    }
                }
                C::FORK_NATIVE_COMPLETED if launch.entered => {
                    match self.complete_fork_native(operation, launch, child, host) {
                        Ok(()) => {}
                        Err(Errno::EAGAIN)
                            if matches!(launch.effect, E::FORK_CANCEL_NATIVE | E::FORK_REPLAY) =>
                        {
                            launch.completing = true
                        }
                        Err(error) => return Err(error),
                    }
                }
                C::FORK_NATIVE_FAILED
                | C::FORK_NATIVE_PROTOCOL_FAILED
                | C::FORK_NATIVE_NO_MEMORY
                | C::FORK_NATIVE_TIMEOUT
                | C::FORK_NATIVE_CONSTRUCTOR_UNKNOWN
                    if launch.entered =>
                {
                    let error = if command == C::FORK_NATIVE_NO_MEMORY {
                        Errno::ENOMEM
                    } else {
                        Errno::EIO
                    };
                    operation.failure.get_or_insert(error);
                    if launch.committed
                        || matches!(
                            command,
                            C::FORK_NATIVE_PROTOCOL_FAILED | C::FORK_NATIVE_CONSTRUCTOR_UNKNOWN
                        )
                        || matches!(
                            launch.effect,
                            E::FORK_REFERENCES | E::FORK_DEACTIVATE | E::FORK_DISPOSE
                        )
                    {
                        launch.next(E::FORK_FATAL);
                    } else if launch.cancelled {
                        if launch.effect == E::FORK_WAIT_STOP && !launch.contained {
                            launch.next(E::FORK_CONTAIN);
                        } else {
                            launch.next(E::FORK_FATAL);
                        }
                    } else {
                        launch.cancel();
                    }
                }
                _ => return Err(Errno::EBUSY),
            }
        }
        if launch.completing && command == C::FORK_NATIVE_POLL {
            match self.complete_fork_native(operation, launch, child, host) {
                Ok(()) | Err(Errno::EAGAIN) => {}
                Err(error) => return Err(error),
            }
        }
        // Publish actual task/storage state before asking the host to build
        // the envelope. No raw task-start sequence belongs to the adapter.
        if launch.effect == E::FORK_PUBLISH && !launch.entered {
            let (store, admission) = self.memory_groups().storage_owner(child)?;
            if store.status(admission)? & S::PREPARED != 0 {
                self.memory_group_task_action(child, TaskAction::Start)?;
                if self
                    .memory_groups()
                    .storage_action(child, Action::Publish, 0, 0, host)
                    .is_err()
                {
                    launch.next(E::FORK_FATAL);
                }
            }
        }
        let paused = child_stopped && !launch.cancelled && !launch.committed;
        let pending = launch.entered && !execute;
        let mut reply =
            Self::group_operation_reply(operation, if pending { E::YIELD } else { launch.effect });
        reply.length = launch.sequence;
        // Long native waits have a kernel-selected deadline; their callback or
        // a kernel cancellation notification wakes the mechanical dispatcher.
        reply.delay = match launch.effect {
            E::FORK_READY => 10_000,
            E::FORK_START | E::FORK_REPLAY | E::FORK_WAIT_STOP => 30_000,
            _ => 0,
        };
        if paused && (pending || launch.effect == E::FORK_DELIVER && !execute) {
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
    fn complete_fork_native(
        &mut self,
        operation: &mut Operation,
        launch: &mut Launch,
        child: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let next = match launch.effect {
            E::FORK_OBJECTS => E::FORK_PUBLISH,
            E::FORK_PUBLISH => E::FORK_BIND,
            E::FORK_BIND => {
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if !store.has_platform_references(admission)? {
                    return Err(Errno::EBUSY);
                }
                E::FORK_REGISTER
            }
            E::FORK_REGISTER => E::FORK_CONNECT,
            E::FORK_CONNECT => E::FORK_START,
            E::FORK_START => E::FORK_READY,
            E::FORK_READY => E::FORK_DELIVER,
            E::FORK_DELIVER => E::FORK_REPLAY,
            E::FORK_REPLAY => {
                let proc = self.get(child.pid).ok_or(Errno::ESRCH)?;
                if proc.state == crate::process::ProcessState::Stopped {
                    return Err(Errno::EAGAIN);
                }
                if proc.exec_generation != child.generation || proc.exit_signal != 0 {
                    return Err(Errno::ESRCH);
                }
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                let resource = store.resource();
                if store
                    .commit_fork_replay(&mut HostMemory { resource, host }, admission)
                    .is_err()
                {
                    // CAS may have committed before a foreign notify failed.
                    // Never roll this child back based on an ambiguous error.
                    launch.committed = true;
                    E::FORK_FATAL
                } else {
                    launch.committed = true;
                    E::FORK_RUNTIME
                }
            }
            E::FORK_RUNTIME => E::FORK_SUCCEEDED,
            E::FORK_CANCEL_NATIVE => {
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if store.status(admission)? & S::PREPARED != 0 {
                    E::FORK_DISPOSE
                } else {
                    let resource = store.resource();
                    store.cancel_fork_replay(&mut HostMemory { resource, host }, admission)?;
                    self.memory_groups()
                        .storage_action(child, Action::StopImage, 0, 0, host)?;
                    E::FORK_SEAL
                }
            }
            E::FORK_SEAL => {
                if self.fork_native_stopped(child)? {
                    E::FORK_CONTAIN
                } else {
                    E::FORK_WAIT_STOP
                }
            }
            E::FORK_WAIT_STOP => {
                if !self.fork_native_stopped(child)? {
                    return Err(Errno::EBUSY);
                }
                if launch.contained {
                    E::FORK_REFERENCES
                } else {
                    E::FORK_CONTAIN
                }
            }
            E::FORK_CONTAIN => {
                launch.contained = true;
                if self.fork_native_stopped(child)? {
                    E::FORK_REFERENCES
                } else {
                    E::FORK_WAIT_STOP
                }
            }
            E::FORK_REFERENCES => {
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if store
                    .pending_platform_references(admission, true)?
                    .is_some()
                {
                    return Err(Errno::EBUSY);
                }
                E::FORK_DEACTIVATE
            }
            E::FORK_DEACTIVATE => E::FORK_DISPOSE,
            E::FORK_DISPOSE => E::FORK_FAILED,
            _ => return Err(Errno::EBUSY),
        };
        launch.next(next);
        // The original fork owner still owns child physical reclamation,
        // kernel removal and completion publication after native cleanup.
        if next == E::FORK_FAILED {
            operation.failure.get_or_insert(Errno::EIO);
        }
        Ok(())
    }
    fn fork_native_stopped(&mut self, child: ReceiptRecord) -> Result<bool, Errno> {
        let (store, admission) = self.memory_groups().storage_owner(child)?;
        Ok(store.status(admission)? & S::STOPPED != 0 && store.accepted_worker_fact(admission)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        group_layout::Layout,
        grouped_exec::tests::{grouped, Fixture as ProcessFixture},
        memory_group::{ImageLayout, MemoryGroupLimits},
    };
    use wasm_posix_shared::retirement_control as R;
    struct Fixture<H> {
        process: ProcessFixture,
        host: H,
        parent: ReceiptRecord,
        child: ReceiptRecord,
        token: u64,
        resource: u64,
        child_control: u32,
    }
    fn fixture() -> Fixture<impl HostIO> {
        let mut process = ProcessFixture::new();
        let table = &mut process.table;
        table.memory_groups().configure(2048, 1).unwrap();
        let group = table
            .memory_groups()
            .create(MemoryGroupLimits {
                maximum_pages: 2048,
                maximum_processes: 4,
                maximum_tasks: 8,
            })
            .unwrap();
        let mut host = crate::exec_control::tests::storage_host();
        table
            .memory_groups()
            .create_storage(group, 1, &mut host)
            .unwrap();
        let parent = table
            .prepare_process_memory_group(group, process.pid)
            .unwrap();
        let layout = Layout::artifact(&grouped(3), 2048).unwrap();
        let descriptor = table
            .memory_groups()
            .prepare_storage_image(
                parent,
                ImageLayout {
                    initial_pages: layout.0[0] as u32,
                    maximum_pages: 2048,
                    scratch_bytes: 65536,
                },
                &mut host,
            )
            .unwrap();
        table
            .memory_group_task_action(parent.record(), TaskAction::Start)
            .unwrap();
        table.memory_groups().publish_storage(parent).unwrap();
        table
            .install_group_memory_layout(layout.record(parent.record()))
            .unwrap();
        // A real caller is blocked in its mailbox while the kernel copies it.
        // Seed both channel pages so the operation tests catch stale requests.
        for address in [
            layout.0[4] as u32,
            layout.0[4] as u32 + wasm_posix_shared::channel::MIN_CHANNEL_SIZE as u32 - 4,
        ] {
            let entry = host
                .group_memory_atomic_load(
                    descriptor.resource,
                    descriptor.root
                        + wasm_posix_shared::program_extensions::memory_group_v3::ROOT_HEADER_BYTES
                        + address / 65536 * 4,
                )
                .unwrap();
            host.group_memory_atomic_store(
                descriptor.resource,
                (entry & 0xffff0000) + address % 65536,
                0xa5a5a5a5,
            )
            .unwrap();
        }
        let anchor = layout.0[4] as u32 - wasm_posix_shared::process_memory::FORK_SAVE_BUFFER_SIZE;
        let entry = host
            .group_memory_atomic_load(
                descriptor.resource,
                descriptor.root
                    + wasm_posix_shared::program_extensions::memory_group_v3::ROOT_HEADER_BYTES
                    + anchor / 65536 * 4,
            )
            .unwrap();
        host.group_memory_atomic_store(
            descriptor.resource,
            (entry & 0xffff0000) + anchor % 65536,
            65536 + 32,
        )
        .unwrap();
        let mut input = [0; W::REQUEST_BYTES];
        input[..4].copy_from_slice(&kind::FORK.to_le_bytes());
        input[4..8]
            .copy_from_slice(&wasm_posix_shared::abi::host_intercepted::SYS_FORK.to_le_bytes());
        let first = table
            .begin_group_operation(parent.record(), &input, &mut host)
            .unwrap();
        let epoch = host
            .group_memory_atomic_load(
                descriptor.resource,
                descriptor.replica
                    + wasm_posix_shared::program_extensions::memory_group_v3::REPLICA_REQUEST,
            )
            .unwrap();
        host.group_memory_atomic_store(
            descriptor.resource,
            descriptor.replica
                + wasm_posix_shared::program_extensions::memory_group_v3::REPLICA_ACK,
            epoch,
        )
        .unwrap();
        let allocating = table
            .poll_group_operation(parent.record(), first.operation, None, &mut host)
            .unwrap();
        assert_eq!(allocating.effect, E::KERNEL_FORK_CREATE);
        let pages = table
            .group_operation_fork_create_input(parent.record(), first.operation)
            .unwrap();
        let child_pid = table
            .fork_group_memory_process(parent.record(), pages)
            .unwrap();
        table
            .finish_group_operation_fork_create(parent.record(), first.operation, Ok(child_pid))
            .unwrap();
        let copied = table
            .poll_group_operation(parent.record(), first.operation, None, &mut host)
            .unwrap();
        assert_eq!(copied.effect, E::FORK_LAUNCH);
        let child = ReceiptRecord::decode(&copied.payload[..32]).unwrap();
        let (_, admission) = table.memory_groups().storage_owner(child).unwrap();
        let (store, _) = table.memory_groups().storage_owner(child).unwrap();
        let child_descriptor = store.descriptor(admission).unwrap();
        Fixture {
            process,
            host,
            parent: parent.record(),
            child,
            token: first.operation,
            resource: descriptor.resource,
            child_control: child_descriptor.replica,
        }
    }
    fn clone_fixture() -> Fixture<impl HostIO> {
        let mut f = fixture();
        let runtime = f.until(E::FORK_RUNTIME);
        f.step(runtime);
        f.process
            .table
            .report_group_fork_effect(f.parent, f.token, C::FORK_LAUNCHED, 0, &mut f.host)
            .unwrap();
        f.process
            .table
            .acknowledge_group_operation(f.parent, f.token)
            .unwrap();
        let channel = f.process.table.group_task_channel(f.parent).unwrap();
        for (address, value) in [
            (channel + wasm_posix_shared::channel::DATA_OFFSET as u32, 37),
            (
                channel + wasm_posix_shared::channel::DATA_OFFSET as u32 + 4,
                91,
            ),
            (0x12000, 0x1234),
            (0x12004, 0x5678),
        ] {
            clone_word(&mut f, address, Some(value));
        }
        f
    }

    fn clone_word<H: HostIO>(f: &mut Fixture<H>, address: u32, write: Option<u32>) -> u32 {
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(f.parent)
            .unwrap();
        let mut memory = HostMemory {
            resource: store.resource(),
            host: &mut f.host,
        };
        if let Some(value) = write {
            store
                .write_execution_word(&mut memory, admission, address, value)
                .unwrap();
        }
        store.execution_word(&memory, admission, address).unwrap()
    }

    fn clone_request(flags: u32, parent_tid: u32) -> [u8; W::REQUEST_BYTES] {
        let mut bytes = [0; W::REQUEST_BYTES];
        bytes[..4].copy_from_slice(&kind::CLONE.to_le_bytes());
        bytes[4..8]
            .copy_from_slice(&wasm_posix_shared::abi::extended_syscalls::SYS_CLONE.to_le_bytes());
        for (index, value) in [flags, 0x17000, parent_tid, 0x13000, 0x12004, 0]
            .into_iter()
            .enumerate()
        {
            bytes[8 + index * 8..16 + index * 8].copy_from_slice(&u64::from(value).to_le_bytes());
        }
        bytes
    }

    fn settle_clone_observer<H: HostIO>(f: &mut Fixture<H>, reply: &Reply) {
        if reply.effect == E::WAIT_NATIVE && reply.wait_token != 0 {
            f.process
                .table
                .memory_groups()
                .storage_action(
                    f.parent,
                    Action::SettleNative,
                    reply.wait_token,
                    0,
                    &mut f.host,
                )
                .unwrap();
        }
    }

    fn finish_failed_clone<H: HostIO>(f: &mut Fixture<H>, mut reply: Reply) -> Reply {
        for _ in 0..64 {
            match reply.effect {
                E::COMPLETE => return reply,
                E::DETACH_THREAD_BINDING => {
                    reply = f
                        .process
                        .table
                        .report_group_thread_binding(f.parent, reply.operation, true, &mut f.host)
                        .unwrap();
                    continue;
                }
                E::KERNEL_THREAD_EXIT => {
                    let target = f
                        .process
                        .table
                        .group_operation_thread_exit_target(f.parent, reply.operation)
                        .unwrap();
                    assert!(!f
                        .process
                        .table
                        .group_operation_thread_exit_clears_child_tid(f.parent, reply.operation)
                        .unwrap());
                    let (process, locks) = f
                        .process
                        .table
                        .process_and_advisory_locks(target.pid)
                        .unwrap();
                    crate::syscalls::cleanup_exiting_thread_with_state(
                        process,
                        locks,
                        &mut f.host,
                        target.tid,
                    )
                    .unwrap();
                    f.process
                        .table
                        .memory_groups()
                        .note_thread_exit(crate::memory_group::GroupExecution {
                            pid: target.pid,
                            tid: target.tid,
                            exec_generation: target.generation,
                        })
                        .unwrap();
                    f.process
                        .table
                        .finish_group_operation_thread_exit(f.parent, reply.operation)
                        .unwrap();
                }
                _ => {}
            }
            if reply.wait_token != 0 {
                f.process
                    .table
                    .memory_groups()
                    .storage_action(
                        f.parent,
                        Action::SettleNative,
                        reply.wait_token,
                        0,
                        &mut f.host,
                    )
                    .unwrap();
            }
            reply = f
                .process
                .table
                .poll_group_operation(f.parent, reply.operation, None, &mut f.host)
                .unwrap();
        }
        panic!(
            "failed clone retained an unexpected effect {}",
            reply.effect
        );
    }

    #[test]
    fn grouped_clone_preflights_before_allocating_a_task_or_writing_parent_tid() {
        let mut f = clone_fixture();
        for (flags, address, errno) in [
            (0, 0x12000, Errno::ENOSYS),
            (0x390100, 0, Errno::EFAULT),
            (0x390100, 0x12001, Errno::EFAULT),
            (0x390100, 0xffff0000, Errno::EFAULT),
        ] {
            let request = clone_request(flags, address);
            let reply = f
                .process
                .table
                .begin_group_operation(f.parent, &request, &mut f.host)
                .unwrap();
            assert_eq!((reply.effect, reply.errno), (E::COMPLETE, errno as u32));
            assert_eq!(clone_word(&mut f, 0x12000, None), 0x1234);
            f.process
                .table
                .acknowledge_group_operation(f.parent, reply.operation)
                .unwrap();
        }
        let tid = f
            .process
            .table
            .create_thread(f.parent.pid, f.parent.tid, 0, 0, 0)
            .unwrap();
        assert_eq!(
            tid,
            f.child.pid + 1,
            "preflight refusals consumed a task identity"
        );
    }

    #[test]
    fn grouped_clone_cancel_restores_parent_word_and_reclaims_the_exact_task() {
        let mut f = clone_fixture();
        let request = clone_request(0x390100, 0x12000);
        let reply = f
            .process
            .table
            .begin_group_operation(f.parent, &request, &mut f.host)
            .unwrap();
        let offset = W::layout::THREAD_RECEIPT_OFFSET;
        let child = ReceiptRecord::decode(&reply.payload[offset..offset + 32]).unwrap();
        assert_eq!(child.tid, f.child.pid + 1);
        assert_eq!(clone_word(&mut f, 0x12000, None), child.tid);
        assert!(f
            .process
            .table
            .get(child.pid)
            .unwrap()
            .get_thread(child.tid)
            .is_some());
        assert_eq!(
            f.process
                .table
                .memory_group_task_action(child, TaskAction::Start),
            Err(Errno::EBUSY)
        );
        assert_eq!(
            f.process
                .table
                .acknowledge_group_operation(f.parent, reply.operation),
            Err(Errno::EBUSY)
        );
        settle_clone_observer(&mut f, &reply);
        let cancelled = f
            .process
            .table
            .poll_group_operation(
                f.parent,
                reply.operation,
                Some(Errno::EIO as u32),
                &mut f.host,
            )
            .unwrap();
        let done = finish_failed_clone(&mut f, cancelled);
        assert_eq!((done.effect, done.errno), (E::COMPLETE, Errno::EIO as u32));
        assert_ne!(done.flags & flags::THREAD_RETIRED, 0);
        assert_eq!(clone_word(&mut f, 0x12000, None), 0x1234);
        assert_eq!(
            clone_word(&mut f, 0x12004, None),
            0x5678,
            "unstarted failure cleared child_tid"
        );
        assert!(f
            .process
            .table
            .get(child.pid)
            .unwrap()
            .get_thread(child.tid)
            .is_none());
        assert!(f
            .process
            .table
            .memory_groups()
            .resolve_receipt(child)
            .is_err());
        f.process
            .table
            .acknowledge_group_operation(f.parent, done.operation)
            .unwrap();
    }

    #[test]
    fn grouped_clone_cancel_preserves_an_intervening_user_parent_tid_write() {
        let mut f = clone_fixture();
        let reply = f
            .process
            .table
            .begin_group_operation(f.parent, &clone_request(0x390100, 0x12000), &mut f.host)
            .unwrap();
        clone_word(&mut f, 0x12000, Some(0x778899));
        settle_clone_observer(&mut f, &reply);
        let cancelled = f
            .process
            .table
            .poll_group_operation(
                f.parent,
                reply.operation,
                Some(Errno::ENOMEM as u32),
                &mut f.host,
            )
            .unwrap();
        let done = finish_failed_clone(&mut f, cancelled);
        assert_eq!(done.errno, Errno::ENOMEM as u32);
        assert_eq!(clone_word(&mut f, 0x12000, None), 0x778899);
        f.process
            .table
            .acknowledge_group_operation(f.parent, done.operation)
            .unwrap();
    }

    #[test]
    fn grouped_clone_refuses_readonly_parent_tid_without_allocating() {
        let mut f = clone_fixture();
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(f.parent)
            .unwrap();
        let descriptor = store.descriptor(admission).unwrap();
        let address = descriptor.root
            + wasm_posix_shared::program_extensions::memory_group_v3::ROOT_HEADER_BYTES
            + 4;
        let pte = f
            .host
            .group_memory_atomic_load(f.resource, address)
            .unwrap();
        f.host
            .group_memory_atomic_store(f.resource, address, pte & !2)
            .unwrap();
        let reply = f
            .process
            .table
            .begin_group_operation(f.parent, &clone_request(0x110100, 0x12000), &mut f.host)
            .unwrap();
        assert_eq!(
            (reply.effect, reply.errno),
            (E::COMPLETE, Errno::EFAULT as u32)
        );
        assert_eq!(clone_word(&mut f, 0x12000, None), 0x1234);
        f.process
            .table
            .acknowledge_group_operation(f.parent, reply.operation)
            .unwrap();
        f.host
            .group_memory_atomic_store(f.resource, address, pte)
            .unwrap();
        let tid = f
            .process
            .table
            .create_thread(f.parent.pid, f.parent.tid, 0, 0, 0)
            .unwrap();
        assert_eq!(tid, f.child.pid + 1);
    }

    #[test]
    fn grouped_clone_queued_cancellation_has_no_task_or_parent_tid_effect() {
        let mut f = clone_fixture();
        clone_word(&mut f, 0x12008, Some(0x9abc));
        let first = f
            .process
            .table
            .begin_group_operation(f.parent, &clone_request(0x390100, 0x12000), &mut f.host)
            .unwrap();
        let queued = f
            .process
            .table
            .begin_group_operation(f.parent, &clone_request(0x390100, 0x12008), &mut f.host)
            .unwrap();
        assert_eq!(queued.effect, E::WAIT_OPERATION);
        assert_eq!(clone_word(&mut f, 0x12008, None), 0x9abc);
        let cancelled = f
            .process
            .table
            .poll_group_operation(
                f.parent,
                queued.operation,
                Some(Errno::EIO as u32),
                &mut f.host,
            )
            .unwrap();
        assert_eq!(cancelled.effect, E::COMPLETE);
        assert_eq!(cancelled.flags & flags::THREAD_RETIRED, 0);
        f.process
            .table
            .acknowledge_group_operation(f.parent, cancelled.operation)
            .unwrap();
        settle_clone_observer(&mut f, &first);
        let cancelled = f
            .process
            .table
            .poll_group_operation(
                f.parent,
                first.operation,
                Some(Errno::EIO as u32),
                &mut f.host,
            )
            .unwrap();
        let done = finish_failed_clone(&mut f, cancelled);
        f.process
            .table
            .acknowledge_group_operation(f.parent, done.operation)
            .unwrap();
        assert_eq!(clone_word(&mut f, 0x12008, None), 0x9abc);
        let tid = f
            .process
            .table
            .create_thread(f.parent.pid, f.parent.tid, 0, 0, 0)
            .unwrap();
        assert_eq!(
            tid,
            f.child.pid + 2,
            "queued clone allocated before owning its turn"
        );
    }

    #[test]
    fn grouped_clone_keeps_its_original_entry_until_binding_failure_reclamation() {
        use wasm_posix_shared::program_extensions::memory_group_v3 as G;
        let mut f = clone_fixture();
        let mut reply = f
            .process
            .table
            .begin_group_operation(f.parent, &clone_request(0x390100, 0x12000), &mut f.host)
            .unwrap();
        let offset = W::layout::THREAD_RECEIPT_OFFSET;
        let child = ReceiptRecord::decode(&reply.payload[offset..offset + 32]).unwrap();
        let channel = f.process.table.group_task_channel(f.parent).unwrap();
        clone_word(
            &mut f,
            channel + wasm_posix_shared::channel::DATA_OFFSET as u32,
            Some(999),
        );
        for _ in 0..32 {
            if reply.effect == E::PREPARE_THREAD_BINDING {
                break;
            }
            settle_clone_observer(&mut f, &reply);
            let (store, admission) = f
                .process
                .table
                .memory_groups()
                .storage_owner(f.parent)
                .unwrap();
            let descriptor = store.descriptor(admission).unwrap();
            let epoch = f
                .host
                .group_memory_atomic_load(f.resource, descriptor.replica + G::REPLICA_REQUEST)
                .unwrap();
            f.host
                .group_memory_atomic_store(f.resource, descriptor.replica + G::REPLICA_ACK, epoch)
                .unwrap();
            reply = f
                .process
                .table
                .poll_group_operation(f.parent, reply.operation, None, &mut f.host)
                .unwrap();
        }
        assert_eq!(reply.effect, E::PREPARE_THREAD_BINDING);
        assert_eq!(
            u32::from_le_bytes(reply.payload[28..32].try_into().unwrap()),
            37
        );
        assert_eq!(
            u32::from_le_bytes(reply.payload[32..36].try_into().unwrap()),
            91
        );
        assert_eq!(
            ReceiptRecord::decode(&reply.payload[offset..offset + 32]).unwrap(),
            child
        );
        let failed = f
            .process
            .table
            .report_group_thread_binding_failure(f.parent, reply.operation, true, &mut f.host)
            .unwrap();
        let done = finish_failed_clone(&mut f, failed);
        assert_eq!(done.errno, Errno::ENOMEM as u32);
        assert_eq!(clone_word(&mut f, 0x12000, None), 0x1234);
        assert_eq!(clone_word(&mut f, 0x12004, None), 0x5678);
        assert!(f
            .process
            .table
            .memory_groups()
            .resolve_receipt(child)
            .is_err());
        f.process
            .table
            .acknowledge_group_operation(f.parent, done.operation)
            .unwrap();
    }

    fn bound_clone() -> (Fixture<impl HostIO>, u64, ReceiptRecord) {
        use wasm_posix_shared::program_extensions::memory_group_v3 as G;
        let mut f = clone_fixture();
        let mut reply = f
            .process
            .table
            .begin_group_operation(f.parent, &clone_request(0x390100, 0x12000), &mut f.host)
            .unwrap();
        for _ in 0..32 {
            if reply.effect == E::PREPARE_THREAD_BINDING {
                break;
            }
            settle_clone_observer(&mut f, &reply);
            let (store, admission) = f
                .process
                .table
                .memory_groups()
                .storage_owner(f.parent)
                .unwrap();
            let descriptor = store.descriptor(admission).unwrap();
            let epoch = f
                .host
                .group_memory_atomic_load(f.resource, descriptor.replica + G::REPLICA_REQUEST)
                .unwrap();
            f.host
                .group_memory_atomic_store(f.resource, descriptor.replica + G::REPLICA_ACK, epoch)
                .unwrap();
            reply = f
                .process
                .table
                .poll_group_operation(f.parent, reply.operation, None, &mut f.host)
                .unwrap();
        }
        assert_eq!(reply.effect, E::PREPARE_THREAD_BINDING);
        let offset = W::layout::THREAD_RECEIPT_OFFSET;
        let child = ReceiptRecord::decode(&reply.payload[offset..offset + 32]).unwrap();
        let channel = u32::from_le_bytes(reply.payload[20..24].try_into().unwrap());
        f.process
            .table
            .enter_group_thread_binding(child, reply.operation, channel)
            .unwrap();
        let bound = f
            .process
            .table
            .report_group_thread_binding(f.parent, reply.operation, false, &mut f.host)
            .unwrap();
        assert_eq!(bound.effect, E::THREAD_LAUNCH);
        (f, reply.operation, child)
    }

    fn thread_native<H: HostIO>(
        f: &mut Fixture<H>,
        token: u64,
        command: u32,
        sequence: u32,
    ) -> Reply {
        f.process
            .table
            .group_thread_launch_control(f.parent, token, command, sequence, &mut f.host)
            .unwrap()
    }
    fn thread_step<H: HostIO>(
        f: &mut Fixture<H>,
        token: u64,
        child: ReceiptRecord,
        reply: Reply,
    ) -> Reply {
        let entered = thread_native(f, token, C::THREAD_NATIVE_ENTERED, reply.length);
        assert_ne!(entered.flags & flags::NATIVE_EXECUTE, 0);
        if reply.effect == E::THREAD_BIND {
            f.process
                .table
                .retirement_control(
                    child,
                    R::command::BIND_REFERENCES,
                    R::NATIVE_JOIN_CAPABILITY,
                    &mut f.host,
                )
                .unwrap();
        }
        if reply.effect == E::THREAD_REFERENCES {
            assert_eq!(
                f.process
                    .table
                    .retirement_control(child, R::command::BEGIN_REFERENCES, 0, &mut f.host)
                    .unwrap()
                    .effect,
                R::DETACH_PLATFORM
            );
            f.process
                .table
                .retirement_control(child, R::command::REFERENCES_DETACHED, 0, &mut f.host)
                .unwrap();
        }
        thread_native(f, token, C::THREAD_NATIVE_COMPLETED, reply.length)
    }
    fn thread_until<H: HostIO>(
        f: &mut Fixture<H>,
        token: u64,
        child: ReceiptRecord,
        effect: u32,
    ) -> Reply {
        let mut reply = thread_native(f, token, C::THREAD_NATIVE_POLL, 0);
        for _ in 0..32 {
            if reply.effect == effect {
                return reply;
            }
            reply = thread_step(f, token, child, reply);
        }
        panic!(
            "missing native thread effect {effect}, actual {}",
            reply.effect
        );
    }

    #[test]
    fn grouped_clone_native_owner_selects_startup_and_commits_exact_child_result() {
        let (mut f, token, child) = bound_clone();
        let success = thread_until(&mut f, token, child, E::THREAD_SUCCEEDED);
        assert_eq!(success.errno, 0);
        let done = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        assert_eq!(
            (done.effect, done.value, done.errno),
            (E::COMPLETE, i64::from(child.tid), 0)
        );
        assert_eq!(clone_word(&mut f, 0x12000, None), child.tid);
        f.process
            .table
            .acknowledge_group_operation(f.parent, token)
            .unwrap();
    }

    #[test]
    fn grouped_clone_native_cancel_before_delivery_reclaims_without_false_worker_absence() {
        let (mut f, token, child) = bound_clone();
        let ready = thread_until(&mut f, token, child, E::THREAD_READY);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, ready.length);
        let failed = thread_native(&mut f, token, C::THREAD_NATIVE_FAILED, ready.length);
        assert_eq!(failed.effect, E::THREAD_CANCEL_NATIVE);
        thread_until(&mut f, token, child, E::THREAD_FAILED);
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(child)
            .unwrap();
        assert!(
            !store.accepted_worker_fact(admission).unwrap(),
            "kernel non-delivery became a fake native fact"
        );
        let cleanup = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        let done = finish_failed_clone(&mut f, cleanup);
        assert_eq!(done.errno, Errno::EIO as u32);
        assert_eq!(clone_word(&mut f, 0x12000, None), 0x1234);
        assert_eq!(clone_word(&mut f, 0x12004, None), 0x5678);
        f.process
            .table
            .acknowledge_group_operation(f.parent, token)
            .unwrap();
    }

    #[test]
    fn grouped_clone_native_stale_observation_cannot_acknowledge_cleanup() {
        let (mut f, token, child) = bound_clone();
        let ready = thread_until(&mut f, token, child, E::THREAD_READY);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, ready.length);
        f.process
            .table
            .poll_group_operation(f.parent, token, Some(Errno::EINTR as u32), &mut f.host)
            .unwrap();
        let stale = thread_native(&mut f, token, C::THREAD_NATIVE_COMPLETED, ready.length);
        assert_eq!(stale.effect, E::THREAD_CANCEL_NATIVE);
        assert_eq!(stale.flags & flags::NATIVE_EXECUTE, 0);
        assert!(matches!(
            f.process.table.group_thread_launch_control(
                f.parent,
                token,
                C::THREAD_NATIVE_COMPLETED,
                stale.length,
                &mut f.host
            ),
            Err(Errno::EBUSY)
        ));
    }

    #[test]
    fn grouped_clone_native_memory_delivery_failure_is_fatal_and_retained() {
        let (mut f, token, child) = bound_clone();
        let delivery = thread_until(&mut f, token, child, E::THREAD_DELIVER);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, delivery.length);
        assert_eq!(clone_word(&mut f, 0x12000, None), child.tid);
        let failure = thread_native(&mut f, token, C::THREAD_NATIVE_FAILED, delivery.length);
        assert_eq!(failure.effect, E::THREAD_FATAL);
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(child)
            .unwrap();
        assert_eq!(
            store.status(admission).unwrap()
                & wasm_posix_shared::group_storage::status::SOURCE_LIVE,
            0
        );
        let group = f
            .process
            .table
            .memory_groups()
            .resolve_group(child.group)
            .unwrap();
        assert_eq!(
            f.process
                .table
                .memory_groups()
                .snapshot(group)
                .unwrap()
                .quarantined_tasks,
            2
        );
        assert!(f
            .process
            .table
            .get(child.pid)
            .unwrap()
            .get_thread(child.tid)
            .is_some());
        assert_eq!(
            f.process.table.acknowledge_group_operation(f.parent, token),
            Err(Errno::EBUSY)
        );
    }

    #[test]
    fn grouped_clone_native_child_exit_during_delivery_does_not_rollback_creation() {
        let (mut f, token, child) = bound_clone();
        let delivery = thread_until(&mut f, token, child, E::THREAD_DELIVER);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, delivery.length);
        let (process, locks) = f
            .process
            .table
            .process_and_advisory_locks(child.pid)
            .unwrap();
        crate::syscalls::cleanup_exiting_thread_with_state(process, locks, &mut f.host, child.tid)
            .unwrap();
        f.process
            .table
            .memory_groups()
            .note_thread_exit(crate::memory_group::GroupExecution {
                pid: child.pid,
                tid: child.tid,
                exec_generation: child.generation,
            })
            .unwrap();
        let success = thread_native(&mut f, token, C::THREAD_NATIVE_COMPLETED, delivery.length);
        assert_eq!(success.effect, E::THREAD_SUCCEEDED);
        let done = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        assert_eq!((done.value, done.errno), (i64::from(child.tid), 0));
        assert_eq!(clone_word(&mut f, 0x12000, None), child.tid);
    }

    #[test]
    fn grouped_clone_native_stopped_process_cannot_construct_or_deliver() {
        let (mut f, token, child) = bound_clone();
        let start = thread_until(&mut f, token, child, E::THREAD_START);
        f.process.table.get_mut(child.pid).unwrap().state = crate::process::ProcessState::Stopped;
        let gated = thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, start.length);
        assert_eq!(gated.effect, E::YIELD);
        assert_eq!(gated.flags & flags::NATIVE_EXECUTE, 0);
        assert_eq!(gated.delay, 0);
        f.process.table.get_mut(child.pid).unwrap().state = crate::process::ProcessState::Running;
        assert_ne!(
            thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, start.length).flags
                & flags::NATIVE_EXECUTE,
            0
        );
    }

    #[test]
    fn grouped_clone_native_cancellation_waits_for_the_exact_interrupted_observer() {
        let (mut f, token, child) = bound_clone();
        let ready = thread_until(&mut f, token, child, E::THREAD_READY);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, ready.length);
        f.process
            .table
            .poll_group_operation(f.parent, token, Some(Errno::EINTR as u32), &mut f.host)
            .unwrap();
        let cancel = thread_native(&mut f, token, C::THREAD_NATIVE_POLL, 0);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, cancel.length);
        let pending = thread_native(&mut f, token, C::THREAD_NATIVE_COMPLETED, cancel.length);
        assert_eq!(pending.effect, E::YIELD);
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(child)
            .unwrap();
        assert_eq!(
            store.status(admission).unwrap() & wasm_posix_shared::group_storage::status::STOPPED,
            0
        );
        thread_native(&mut f, token, C::THREAD_NATIVE_TIMEOUT, ready.length);
        assert_eq!(
            thread_native(&mut f, token, C::THREAD_NATIVE_POLL, 0).effect,
            E::YIELD
        );
        thread_native(&mut f, token, C::THREAD_NATIVE_FAILED, ready.length);
        thread_until(&mut f, token, child, E::THREAD_FAILED);
        let cleanup = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        let done = finish_failed_clone(&mut f, cleanup);
        assert_eq!(done.errno, Errno::EINTR as u32);
    }

    #[test]
    fn grouped_clone_native_late_uncertain_constructor_still_quarantines_custody() {
        let (mut f, token, child) = bound_clone();
        let start = thread_until(&mut f, token, child, E::THREAD_START);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, start.length);
        f.process
            .table
            .poll_group_operation(f.parent, token, Some(Errno::EIO as u32), &mut f.host)
            .unwrap();
        let late = thread_native(
            &mut f,
            token,
            C::THREAD_NATIVE_CONSTRUCTOR_UNKNOWN,
            start.length,
        );
        assert_eq!(late.effect, E::THREAD_FATAL);
        let group = f
            .process
            .table
            .memory_groups()
            .resolve_group(child.group)
            .unwrap();
        assert_eq!(
            f.process
                .table
                .memory_groups()
                .snapshot(group)
                .unwrap()
                .quarantined_tasks,
            2
        );
        assert_eq!(
            f.process.table.acknowledge_group_operation(f.parent, token),
            Err(Errno::EBUSY)
        );
    }

    #[test]
    fn grouped_clone_native_join_after_non_delivery_stop_keeps_physical_cleanup_owned() {
        let (mut f, token, child) = bound_clone();
        let ready = thread_until(&mut f, token, child, E::THREAD_READY);
        thread_native(&mut f, token, C::THREAD_NATIVE_ENTERED, ready.length);
        thread_native(&mut f, token, C::THREAD_NATIVE_FAILED, ready.length);
        let contain = thread_until(&mut f, token, child, E::THREAD_CONTAIN);
        assert_ne!(
            f.process
                .table
                .retirement_control(child, R::command::NATIVE_JOIN, 0, &mut f.host)
                .unwrap()
                .flags
                & R::STOP_ACCEPTED,
            0
        );
        assert!(f
            .process
            .table
            .memory_groups()
            .resolve_receipt(child)
            .is_err());
        assert!(f.process.table.memory_groups().storage_owner(child).is_ok());
        thread_step(&mut f, token, child, contain);
        thread_until(&mut f, token, child, E::THREAD_FAILED);
        let cleanup = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        let done = finish_failed_clone(&mut f, cleanup);
        assert_eq!(done.errno, Errno::EIO as u32);
        assert!(f
            .process
            .table
            .memory_groups()
            .storage_owner(child)
            .is_err());
    }

    #[test]
    fn grouped_clone_native_parent_exit_after_handoff_suppresses_only_publication() {
        let (mut f, token, child) = bound_clone();
        thread_until(&mut f, token, child, E::THREAD_SUCCEEDED);
        f.process.table.get_mut(child.pid).unwrap().state = crate::process::ProcessState::Exited;
        let done = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        assert_eq!(
            (done.effect, done.value, done.errno),
            (E::COMPLETE, i64::from(child.tid), 0)
        );
        assert_eq!(done.flags & flags::DELIVER, 0);
        assert!(f
            .process
            .table
            .get(child.pid)
            .unwrap()
            .get_thread(child.tid)
            .is_some());
        assert_eq!(clone_word(&mut f, 0x12000, None), child.tid);
    }

    #[test]
    fn grouped_clone_native_pending_fatal_exit_after_handoff_suppresses_publication() {
        let (mut f, token, child) = bound_clone();
        thread_until(&mut f, token, child, E::THREAD_SUCCEEDED);
        let parent = f.process.table.get_mut(child.pid).unwrap();
        assert_eq!(parent.state, crate::process::ProcessState::Running);
        parent.exit_signal = 9;
        let done = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        assert_eq!(
            (done.effect, done.value, done.errno),
            (E::COMPLETE, i64::from(child.tid), 0)
        );
        assert_eq!(done.flags & flags::DELIVER, 0);
        assert!(f.process.table.get(child.pid).unwrap().get_thread(child.tid).is_some());
        assert_eq!(clone_word(&mut f, 0x12000, None), child.tid);
    }

    #[test]
    fn grouped_clone_native_parent_stop_after_handoff_retains_result_until_continue() {
        let (mut f, token, child) = bound_clone();
        thread_until(&mut f, token, child, E::THREAD_SUCCEEDED);
        f.process.table.get_mut(child.pid).unwrap().state = crate::process::ProcessState::Stopped;
        let parked = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        assert_eq!(parked.effect, E::YIELD);
        assert_eq!(
            f.process.table.acknowledge_group_operation(f.parent, token),
            Err(Errno::EBUSY)
        );
        f.process.table.get_mut(child.pid).unwrap().state = crate::process::ProcessState::Running;
        let done = f
            .process
            .table
            .poll_group_operation(f.parent, token, None, &mut f.host)
            .unwrap();
        assert_eq!(
            (done.effect, done.value, done.errno),
            (E::COMPLETE, i64::from(child.tid), 0)
        );
        assert_ne!(done.flags & flags::DELIVER, 0);
    }

    impl<H: HostIO> Fixture<H> {
        fn call(&mut self, command: u32, sequence: u32) -> Reply {
            self.process
                .table
                .group_fork_launch_control(
                    self.parent,
                    self.token,
                    command,
                    sequence,
                    &mut self.host,
                )
                .unwrap()
        }
        fn poll(&mut self) -> Reply {
            self.call(C::FORK_NATIVE_POLL, 0)
        }
        fn step(&mut self, reply: Reply) -> Reply {
            let entered = self.call(C::FORK_NATIVE_ENTERED, reply.length);
            assert_eq!(
                (entered.effect, entered.length),
                (reply.effect, reply.length)
            );
            assert_ne!(entered.flags & flags::NATIVE_EXECUTE, 0);
            if reply.effect == E::FORK_BIND {
                self.process
                    .table
                    .retirement_control(self.child, R::command::BIND_REFERENCES, 0, &mut self.host)
                    .unwrap();
            }
            self.call(C::FORK_NATIVE_COMPLETED, reply.length)
        }
        fn until(&mut self, effect: u32) -> Reply {
            let mut reply = self.poll();
            while reply.effect != effect {
                reply = self.step(reply);
            }
            reply
        }
        fn gate(&mut self) -> u32 {
            self.host.group_memory_atomic_load(self.resource, self.child_control + wasm_posix_shared::program_extensions::memory_group_v3::REPLICA_FORK_REPLAY).unwrap()
        }
    }
    #[test]
    fn actual_fork_owner_clears_the_copied_mailbox_before_issuing_any_worker_effect() {
        let mut f = fixture();
        let channel = f.process.table.get(f.parent.pid).unwrap().main_channel_addr as u32;
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(f.parent)
            .unwrap();
        let parent_root = store.descriptor(admission).unwrap().root;
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(f.child)
            .unwrap();
        let child_root = store.descriptor(admission).unwrap().root;
        for address in [
            channel,
            channel + wasm_posix_shared::channel::MIN_CHANNEL_SIZE as u32 - 4,
        ] {
            for (root, expected) in [(parent_root, 0xa5a5a5a5), (child_root, 0)] {
                let entry = f.host.group_memory_atomic_load(f.resource,
                    root + wasm_posix_shared::program_extensions::memory_group_v3::ROOT_HEADER_BYTES + address / 65536 * 4).unwrap();
                assert_eq!(
                    f.host
                        .group_memory_atomic_load(
                            f.resource,
                            (entry & 0xffff0000) + address % 65536
                        )
                        .unwrap(),
                    expected
                );
            }
        }
        assert_eq!(f.poll().effect, E::FORK_OBJECTS);
    }
    #[test]
    fn kernel_emits_the_validated_continuation_and_refuses_malformed_anchor_geometry() {
        let mut f = fixture();
        let layout = f
            .process
            .table
            .group_fork_launch_layout(f.parent, &mut f.host)
            .unwrap();
        assert_eq!(layout.0[0], W::layout::MAIN);
        assert_eq!(layout.0[1], 65536 + 32);
        let anchor = layout.0[6] - wasm_posix_shared::process_memory::FORK_SAVE_BUFFER_SIZE;
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(f.parent)
            .unwrap();
        let root = store.descriptor(admission).unwrap().root;
        let pte = f
            .host
            .group_memory_atomic_load(f.resource, root + 64 + anchor / 65536 * 4)
            .unwrap();
        f.host
            .group_memory_atomic_store(f.resource, (pte & 0xffff0000) + anchor % 65536, 65536 + 33)
            .unwrap();
        assert!(matches!(
            f.process
                .table
                .group_fork_launch_layout(f.parent, &mut f.host),
            Err(Errno::EFAULT)
        ));
    }

    #[test]
    fn setup_failure_is_classified_in_rust_and_cannot_abandon_an_entered_native_launch() {
        for no_memory in [false, true] {
            let mut f = fixture();
            let cancelled = f
                .process
                .table
                .report_group_fork_setup_failure(f.parent, f.token, no_memory, &mut f.host)
                .unwrap();
            assert_eq!(cancelled.effect, E::FORK_REMOVE_TRANSPORT);
            assert_eq!(
                cancelled.errno,
                if no_memory { Errno::ENOMEM } else { Errno::EIO } as u32
            );
        }
        let mut f = fixture();
        let objects = f.poll();
        f.call(C::FORK_NATIVE_ENTERED, objects.length);
        assert!(matches!(
            f.process
                .table
                .report_group_fork_setup_failure(f.parent, f.token, false, &mut f.host),
            Err(Errno::EBUSY)
        ));
    }

    #[test]
    fn pthread_layout_and_replay_recipe_come_from_exact_kernel_caller_and_control_owner() {
        use wasm_posix_shared::program_extensions::memory_group_v3 as G;
        let mut f = fixture();
        let runtime = f.until(E::FORK_RUNTIME);
        f.step(runtime);
        f.process
            .table
            .report_group_fork_effect(f.parent, f.token, C::FORK_LAUNCHED, 0, &mut f.host)
            .unwrap();
        f.process
            .table
            .acknowledge_group_operation(f.parent, f.token)
            .unwrap();
        let (store, admission) = f
            .process
            .table
            .memory_groups()
            .storage_owner(f.parent)
            .unwrap();
        let descriptor = store.descriptor(admission).unwrap();
        let channel = f.process.table.group_task_channel(f.parent).unwrap();
        for (offset, value) in [(0, 37), (4, 91)] {
            let address = channel + wasm_posix_shared::channel::DATA_OFFSET as u32 + offset;
            let pte = f
                .host
                .group_memory_atomic_load(
                    f.resource,
                    descriptor.root + G::ROOT_HEADER_BYTES + address / 65536 * 4,
                )
                .unwrap();
            f.host
                .group_memory_atomic_store(f.resource, (pte & 0xffff0000) + address % 65536, value)
                .unwrap();
        }
        let mut request = [0; W::REQUEST_BYTES];
        request[..4].copy_from_slice(&kind::CLONE.to_le_bytes());
        request[4..8]
            .copy_from_slice(&wasm_posix_shared::abi::extended_syscalls::SYS_CLONE.to_le_bytes());
        for (index, value) in [0x290100u32, 0x12000, 0, 0x13000, 0x14000, 0]
            .into_iter()
            .enumerate()
        {
            request[8 + index * 8..16 + index * 8].copy_from_slice(&u64::from(value).to_le_bytes());
        }
        let mut reply = f
            .process
            .table
            .begin_group_operation(f.parent, &request, &mut f.host)
            .unwrap();
        let offset = W::layout::THREAD_RECEIPT_OFFSET;
        let tid = ReceiptRecord::decode(&reply.payload[offset..offset + 32])
            .unwrap()
            .tid;
        for _ in 0..16 {
            if reply.effect == E::PREPARE_THREAD_BINDING {
                break;
            }
            if reply.wait_token != 0 {
                f.process
                    .table
                    .memory_groups()
                    .storage_action(
                        f.parent,
                        Action::SettleNative,
                        reply.wait_token,
                        0,
                        &mut f.host,
                    )
                    .unwrap();
            }
            let epoch = f
                .host
                .group_memory_atomic_load(f.resource, descriptor.replica + G::REPLICA_REQUEST)
                .unwrap();
            f.host
                .group_memory_atomic_store(f.resource, descriptor.replica + G::REPLICA_ACK, epoch)
                .unwrap();
            reply = f
                .process
                .table
                .poll_group_operation(f.parent, reply.operation, None, &mut f.host)
                .unwrap();
        }
        assert_eq!(reply.effect, E::PREPARE_THREAD_BINDING);
        let words: alloc::vec::Vec<u32> = reply.payload[..W::layout::THREAD_BYTES]
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert_eq!(&words[6..], &[channel, 37, 91, 0x12000, 0x13000, 0x14000]);
        assert_eq!(
            words[5],
            words[0] * 65536
                + wasm_posix_shared::process_memory::THREAD_SLOT_CHANNEL_PRIMARY_PAGE * 65536
        );
        let entry = f
            .process
            .table
            .get(f.parent.pid)
            .unwrap()
            .get_thread(tid)
            .unwrap()
            .grouped_entry
            .unwrap();
        assert_eq!(
            (entry.function, entry.argument, entry.slot_start),
            (37, 91, reply.value as u32)
        );
        // The former preallocated preparation wire is unsupported before
        // it can mint another owner for this already allocated child.
        let mut legacy = request;
        legacy[..4].copy_from_slice(&4u32.to_le_bytes());
        legacy[56..60].copy_from_slice(&tid.to_le_bytes());
        assert!(matches!(
            f.process
                .table
                .begin_group_operation(f.parent, &legacy, &mut f.host),
            Err(Errno::EINVAL)
        ));
        let child = f
            .process
            .table
            .memory_group_task(f.parent.pid, tid)
            .unwrap()
            .unwrap()
            .record();
        assert!(matches!(
            f.process
                .table
                .enter_group_thread_binding(child, 0, words[5]),
            Err(Errno::ESRCH)
        ));
        assert!(matches!(
            f.process
                .table
                .enter_group_thread_binding(child, reply.operation, words[5] + 4),
            Err(Errno::EINVAL)
        ));
        assert!(matches!(
            f.process.table.report_group_thread_binding(
                f.parent,
                reply.operation,
                false,
                &mut f.host
            ),
            Err(Errno::EBUSY)
        ));
        assert_eq!(
            f.process
                .table
                .enter_group_thread_binding(child, reply.operation, words[5])
                .unwrap()
                .effect,
            E::PREPARE_THREAD_BINDING
        );
        assert!(matches!(
            f.process
                .table
                .enter_group_thread_binding(child, reply.operation, words[5]),
            Err(Errno::EBUSY)
        ));
        let failure = f
            .process
            .table
            .report_group_thread_binding_failure(f.parent, reply.operation, false, &mut f.host)
            .unwrap();
        assert_eq!(
            (failure.effect, failure.errno),
            (E::DETACH_THREAD_BINDING, Errno::EIO as u32)
        );
        let exit = f
            .process
            .table
            .report_group_thread_binding(f.parent, reply.operation, true, &mut f.host)
            .unwrap();
        assert_eq!(exit.effect, E::KERNEL_THREAD_EXIT);
        let target = f
            .process
            .table
            .group_operation_thread_exit_target(f.parent, reply.operation)
            .unwrap();
        assert_eq!(target.tid, tid);
        let (process, locks) = f
            .process
            .table
            .process_and_advisory_locks(target.pid)
            .unwrap();
        crate::syscalls::cleanup_exiting_thread_with_state(process, locks, &mut f.host, tid)
            .unwrap();
        f.process
            .table
            .memory_groups()
            .note_thread_exit(crate::memory_group::GroupExecution {
                pid: target.pid,
                tid,
                exec_generation: target.generation,
            })
            .unwrap();
        f.process
            .table
            .finish_group_operation_thread_exit(f.parent, reply.operation)
            .unwrap();
        let retired = f
            .process
            .table
            .poll_group_operation(f.parent, reply.operation, None, &mut f.host)
            .unwrap();
        assert_eq!(
            (retired.effect, retired.errno),
            (E::COMPLETE, Errno::EIO as u32)
        );
        assert_ne!(retired.flags & flags::THREAD_RETIRED, 0);
        assert!(f
            .process
            .table
            .get(target.pid)
            .unwrap()
            .get_thread(tid)
            .is_none());
        assert!(f.process.table.memory_group_task(target.pid, tid).is_err());
        f.process
            .table
            .acknowledge_group_operation(f.parent, reply.operation)
            .unwrap();
    }
    #[test]
    fn actual_fork_owner_drives_native_launch_commits_its_gate_and_transfers_once() {
        use wasm_posix_shared::program_extensions::memory_group_v3 as L;
        let mut f = fixture();
        assert!(matches!(
            f.process
                .table
                .memory_group_task_action(f.child, TaskAction::Start),
            Err(Errno::EBUSY)
        ));
        let first = f.poll();
        assert_eq!(first.effect, E::FORK_OBJECTS);
        assert!(matches!(
            f.process.table.group_fork_launch_control(
                f.parent,
                f.token,
                C::FORK_NATIVE_COMPLETED,
                first.length,
                &mut f.host
            ),
            Err(Errno::EBUSY)
        ));
        let replay = f.until(E::FORK_REPLAY);
        assert_eq!(f.gate(), L::REPLAY_PENDING);
        assert!(matches!(
            f.process.table.report_group_fork_effect(
                f.parent,
                f.token,
                C::FORK_LAUNCHED,
                0,
                &mut f.host
            ),
            Err(Errno::EBUSY)
        ));
        let runtime = f.step(replay);
        assert_eq!(
            (runtime.effect, f.gate()),
            (E::FORK_RUNTIME, L::REPLAY_COMMITTED)
        );
        assert_eq!(f.step(runtime).effect, E::FORK_SUCCEEDED);
        let transferred = f
            .process
            .table
            .report_group_fork_effect(f.parent, f.token, C::FORK_LAUNCHED, 0, &mut f.host)
            .unwrap();
        assert_eq!(
            (transferred.effect, transferred.value, transferred.errno),
            (E::COMPLETE, i64::from(f.child.pid), 0)
        );
        f.process
            .table
            .acknowledge_group_operation(f.parent, f.token)
            .unwrap();
    }
    #[test]
    fn native_effect_identity_blocks_wrong_sequence_and_duplicate_execution() {
        let mut f = fixture();
        let first = f.poll();
        assert!(matches!(
            f.process.table.group_fork_launch_control(
                f.parent,
                f.token,
                C::FORK_NATIVE_ENTERED,
                first.length + 1,
                &mut f.host
            ),
            Err(Errno::EBUSY)
        ));
        let mut wrong = f.parent;
        wrong.generation += 1;
        assert!(matches!(
            f.process.table.group_fork_launch_control(
                wrong,
                f.token,
                C::FORK_NATIVE_ENTERED,
                first.length,
                &mut f.host
            ),
            Err(Errno::ESRCH)
        ));
        f.call(C::FORK_NATIVE_ENTERED, first.length);
        assert!(matches!(
            f.process.table.group_fork_launch_control(
                f.parent,
                f.token,
                C::FORK_NATIVE_ENTERED,
                first.length,
                &mut f.host
            ),
            Err(Errno::EBUSY)
        ));
        let next = f.call(C::FORK_NATIVE_COMPLETED, first.length);
        let stale = f.call(C::FORK_NATIVE_COMPLETED, first.length);
        assert_eq!((stale.effect, stale.length), (next.effect, next.length));
        assert_eq!(stale.flags & flags::NATIVE_EXECUTE, 0);
    }
    #[test]
    fn kernel_classifies_resource_and_generic_native_failures_without_host_errno_policy() {
        for (command, error) in [
            (C::FORK_NATIVE_FAILED, Errno::EIO),
            (C::FORK_NATIVE_NO_MEMORY, Errno::ENOMEM),
        ] {
            let mut f = fixture();
            let first = f.poll();
            f.call(C::FORK_NATIVE_ENTERED, first.length);
            let cancel = f.call(command, first.length);
            assert_eq!(
                (cancel.effect, cancel.errno),
                (E::FORK_CANCEL_NATIVE, error as u32)
            );
            let dispose = f.step(cancel);
            assert_eq!(dispose.effect, E::FORK_DISPOSE);
            let failed = f.step(dispose);
            assert_eq!(
                (failed.effect, failed.errno),
                (E::FORK_FAILED, error as u32)
            );
        }
    }
    #[test]
    fn parent_stop_cancels_a_pending_native_wait_and_late_ready_cannot_commit() {
        use wasm_posix_shared::program_extensions::memory_group_v3 as L;
        let mut f = fixture();
        let ready = f.until(E::FORK_READY);
        f.call(C::FORK_NATIVE_ENTERED, ready.length);
        assert_ne!(f.poll().flags & flags::NATIVE_PENDING, 0);
        f.process
            .table
            .memory_groups()
            .storage_action(f.parent, Action::StopImage, 0, 0, &mut f.host)
            .unwrap();
        let cancel = f.poll();
        assert_eq!(cancel.effect, E::FORK_CANCEL_NATIVE);
        let late = f.call(C::FORK_NATIVE_COMPLETED, ready.length);
        assert_eq!((late.effect, late.length), (cancel.effect, cancel.length));
        assert_eq!(late.flags & flags::NATIVE_EXECUTE, 0);
        let seal = f.step(cancel);
        assert_eq!(seal.effect, E::FORK_SEAL);
        assert_eq!(f.gate(), L::REPLAY_CANCELLED);
        let waiting = f.step(seal);
        assert_eq!(waiting.effect, E::FORK_WAIT_STOP);
        f.process
            .table
            .retirement_control(f.child, R::command::WORKER_FENCE, 0, &mut f.host)
            .unwrap();
        let contain = f.step(waiting);
        assert_eq!(contain.effect, E::FORK_CONTAIN);
        let refs = f.step(contain);
        assert_eq!(refs.effect, E::FORK_REFERENCES);
        f.process
            .table
            .retirement_control(f.child, R::command::BEGIN_REFERENCES, 0, &mut f.host)
            .unwrap();
        f.process
            .table
            .retirement_control(f.child, R::command::REFERENCES_DETACHED, 0, &mut f.host)
            .unwrap();
        let deactivate = f.step(refs);
        assert_eq!(deactivate.effect, E::FORK_DEACTIVATE);
        let dispose = f.step(deactivate);
        assert_eq!(dispose.effect, E::FORK_DISPOSE);
        assert_eq!(f.step(dispose).effect, E::FORK_FAILED);
        let retire = f
            .process
            .table
            .poll_group_operation(f.parent, f.token, Some(Errno::ESRCH as u32), &mut f.host)
            .unwrap();
        assert_eq!(retire.effect, E::FORK_RETIRE_TRANSPORT);
        assert_eq!(retire.flags & flags::DELIVER, 0);
    }
    #[test]
    fn normal_exit_cancels_uncommitted_fork_without_waiting_for_host_storage_stop() {
        for parent_exits in [true, false] {
            let mut f = fixture();
            let ready = f.until(E::FORK_READY);
            f.call(C::FORK_NATIVE_ENTERED, ready.length);
            let pid = if parent_exits {
                f.parent.pid
            } else {
                f.child.pid
            };
            crate::syscalls::sys_exit(f.process.table.get_mut(pid).unwrap(), &mut f.host, 0);
            assert_eq!(
                f.process.table.get(pid).unwrap().state,
                crate::process::ProcessState::Exited
            );
            let cancelled = f.poll();
            assert_eq!(
                (cancelled.effect, cancelled.errno),
                (E::FORK_CANCEL_NATIVE, Errno::ESRCH as u32)
            );
            let late = f.call(C::FORK_NATIVE_COMPLETED, ready.length);
            assert_eq!(
                (late.effect, late.length),
                (cancelled.effect, cancelled.length)
            );
            assert_eq!(late.flags & flags::NATIVE_EXECUTE, 0);
            if parent_exits {
                assert_eq!(late.flags & flags::DELIVER, 0);
            }
        }
    }
    #[test]
    fn stopped_parent_remains_live_and_does_not_cancel_its_fork() {
        let mut f = fixture();
        let ready = f.until(E::FORK_READY);
        f.call(C::FORK_NATIVE_ENTERED, ready.length);
        f.process.table.get_mut(f.parent.pid).unwrap().state =
            crate::process::ProcessState::Stopped;
        let waiting = f.poll();
        assert_eq!((waiting.effect, waiting.errno), (E::YIELD, 0));
        let deliver = f.call(C::FORK_NATIVE_COMPLETED, ready.length);
        assert_eq!((deliver.effect, deliver.errno), (E::FORK_DELIVER, 0));
        let replay = f.step(deliver);
        assert_eq!(f.step(replay).effect, E::FORK_RUNTIME);
    }
    #[test]
    fn stopped_child_suspends_deadlines_and_defers_delivery_and_replay_commit() {
        use crate::process::ProcessState;
        use wasm_posix_shared::program_extensions::memory_group_v3 as L;
        let mut f = fixture();
        let ready = f.until(E::FORK_READY);
        f.call(C::FORK_NATIVE_ENTERED, ready.length);
        f.process.table.get_mut(f.child.pid).unwrap().state = ProcessState::Stopped;
        let paused = f.poll();
        assert_eq!(
            (paused.effect, paused.delay, paused.errno),
            (E::YIELD, 0, 0)
        );
        f.call(C::FORK_NATIVE_TIMEOUT, ready.length);
        assert_eq!(f.poll().errno, 0);
        let waiting_delivery = f.call(C::FORK_NATIVE_COMPLETED, ready.length);
        assert_eq!(
            (waiting_delivery.effect, waiting_delivery.delay),
            (E::YIELD, 0)
        );
        let not_entered = f.call(C::FORK_NATIVE_ENTERED, waiting_delivery.length);
        assert_eq!(not_entered.flags & flags::NATIVE_EXECUTE, 0);
        f.process.table.get_mut(f.child.pid).unwrap().state = ProcessState::Running;
        let deliver = f.poll();
        assert_eq!(deliver.effect, E::FORK_DELIVER);
        let replay = f.step(deliver);
        f.call(C::FORK_NATIVE_ENTERED, replay.length);
        f.process.table.get_mut(f.child.pid).unwrap().state = ProcessState::Stopped;
        let still_waiting = f.call(C::FORK_NATIVE_COMPLETED, replay.length);
        assert_eq!((still_waiting.effect, still_waiting.delay), (E::YIELD, 0));
        assert_eq!(f.gate(), L::REPLAY_PENDING);
        f.process.table.get_mut(f.child.pid).unwrap().state = ProcessState::Running;
        assert_eq!(f.poll().effect, E::FORK_RUNTIME);
        assert_eq!(f.gate(), L::REPLAY_COMMITTED);
    }
    #[test]
    fn constructor_uncertainty_retains_the_actual_child_instead_of_faking_rollback() {
        let mut f = fixture();
        let start = f.until(E::FORK_START);
        f.call(C::FORK_NATIVE_ENTERED, start.length);
        let fatal = f.call(C::FORK_NATIVE_CONSTRUCTOR_UNKNOWN, start.length);
        assert_eq!(fatal.effect, E::FORK_FATAL);
        let group = f
            .process
            .table
            .memory_groups()
            .resolve_group(f.child.group)
            .unwrap();
        let snapshot = f.process.table.memory_groups().snapshot(group).unwrap();
        assert_eq!((snapshot.images, snapshot.tasks), (2, 2));
        assert!(f.process.table.get(f.child.pid).is_some());
    }
    #[test]
    fn cancellation_after_commit_cannot_remove_an_already_released_child() {
        let mut f = fixture();
        let replay = f.until(E::FORK_REPLAY);
        let runtime = f.step(replay);
        f.process
            .table
            .memory_groups()
            .storage_action(f.parent, Action::StopImage, 0, 0, &mut f.host)
            .unwrap();
        let still_runtime = f.poll();
        assert_eq!(still_runtime.effect, E::FORK_RUNTIME);
        assert_eq!(still_runtime.errno, 0);
        assert_eq!(f.step(runtime).effect, E::FORK_SUCCEEDED);
        let transferred = f
            .process
            .table
            .report_group_fork_effect(f.parent, f.token, C::FORK_LAUNCHED, 0, &mut f.host)
            .unwrap();
        assert_eq!(transferred.value, i64::from(f.child.pid));
        assert_eq!(transferred.flags & flags::DELIVER, 0);
        assert!(f.process.table.get(f.child.pid).is_some());
    }
}
