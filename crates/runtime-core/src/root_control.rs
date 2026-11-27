//! Actual ProcessTable ownership from root admission through native startup.
//! Platform failures request exact absence proof; constructor uncertainty retains custody.
use crate::{
    group_layout::Layout,
    io_buffer::IO_MEMORY,
    memory_group::{GroupAdmission, ReplicaDescriptor, StorageReply},
    prepared_map::{MapMemory, PreparedMap, PreparedMapSlot},
    process::HostIO,
    process_table::ProcessTable,
};
use wasm_posix_shared::{
    Errno,
    group_operation::{Reply, effect},
    memory_group::ReceiptRecord,
    root_control::{command as C, effect as E, phase as P},
};
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Key(u32, u64);
impl MapMemory for Key {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
struct Root {
    admission: GroupAdmission,
    layout: Layout,
    phase: u32,
    descriptor: Option<ReplicaDescriptor>,
    failure: Option<Errno>,
    pending_effect: u32,
    entered_effect: u32,
}
impl MapMemory for Root {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
pub(crate) struct Roots {
    entries: PreparedMap<Key, Root>,
}
impl Roots {
    pub(crate) const fn new() -> Self {
        Self {
            entries: PreparedMap::new(),
        }
    }
}
impl ProcessTable {
    pub(crate) fn validate_root_control_start(
        &mut self,
        record: ReceiptRecord,
    ) -> Result<(), Errno> {
        if self
            .root_controls()
            .entries
            .get(&Key(record.group, record.serial))
            .is_some()
        {
            // A live root operation owns admission. Its entry is removed only
            // while its own continuation runs under the same kernel borrow.
            return Err(Errno::EBUSY);
        }
        Ok(())
    }

    pub fn begin_root_control(
        &mut self,
        group: u32,
        pid: u32,
        ceiling: u32,
        default_slots: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        if ceiling == 0 || ceiling > 65536 {
            return Err(Errno::EINVAL);
        }
        let id = self.memory_groups().resolve_group(group)?;
        let artifact =
            crate::exec_target::attached_group_artifact(self.get(pid).ok_or(Errno::ESRCH)?, host)?;
        let layout = Layout::configured(artifact, ceiling, default_slots)?;
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let admission = self.prepare_process_memory_group(id, pid)?;
        let record = admission.record();
        let entry = slot.finish(
            Key(group, record.serial),
            Root {
                admission,
                layout,
                phase: P::PREPARING,
                descriptor: None,
                failure: None,
                pending_effect: 0,
                entered_effect: 0,
            },
        )?;
        self.root_controls().entries.publish_io(entry);
        // After minting, unexpected failure means retained kernel ownership;
        // never tell the host that no receipt was admitted.
        match self.root_control(record, C::POLL, host) {
            Ok(reply) => Ok(reply),
            Err(error) => panic!("retained root continuation failed for {record:?}: {error:?}"),
        }
    }
    pub fn root_control(
        &mut self,
        record: ReceiptRecord,
        command: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        self.root_control_effect(record, command, 0, host)
    }
    pub fn root_control_effect(
        &mut self,
        record: ReceiptRecord,
        command: u32,
        argument: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let key = Key(record.group, record.serial);
        let root = self.root_controls().entries.get(&key).ok_or(Errno::ESRCH)?;
        if root.admission.record() != record {
            return Err(Errno::ESRCH);
        }
        if command == C::ACK {
            if argument != 0
                || root.pending_effect != 0
                || !matches!(root.phase, P::CANCELLED | P::FINISHED)
            {
                return Err(Errno::EBUSY);
            }
            self.root_controls().entries.remove(&key);
            return Ok(Reply::new(record, record.serial, effect::COMPLETE));
        }
        let mut entry = self
            .root_controls()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let result = self.advance_root(entry.value_mut(), command, argument, host);
        self.root_controls().entries.publish_io(entry);
        result
    }
    fn root_cleanup_effect(&mut self, root: &Root) -> Result<u32, Errno> {
        let record = root.admission.record();
        let current_exited = self.get(record.pid).is_some_and(|process|
            process.exec_generation == record.generation
                && process.state == crate::process::ProcessState::Exited);
        match self.memory_groups().storage_owner(root.admission.record()) {
            Ok((store, admission)) if store.accepted_worker_fact(admission)? => Ok(E::RETIRE_IMAGE),
            // Construction completed, but no guest backing was delivered. The
            // exact prepared realm must acknowledge cancellation, not absence.
            Ok(_) if root.entered_effect == 0
                && matches!(root.pending_effect, E::WAIT_READY | E::DELIVER_LAUNCH)
                && current_exited
                => Ok(E::CANCEL_PREPARED_WORKER),
            Ok(_) => Ok(E::SEAL_ABSENCE),
            // An ordinary exit/teardown may already have joined exact native
            // and reference retirement. The root continuation never revives it.
            Err(Errno::ESRCH) => Ok(E::DISCARD_TRANSPORT),
            Err(error) => Err(error),
        }
    }
    fn advance_root(
        &mut self,
        root: &mut Root,
        command: u32,
        argument: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let record = root.admission.record();
        if !matches!(command, C::PLATFORM_COMPLETED | C::PLATFORM_FAILED | C::ENTER_NATIVE) && argument != 0 {
            return Err(Errno::EINVAL);
        }
        match command {
            C::POLL => {}
            C::CANCEL
                if matches!(
                    root.phase,
                    P::PREPARING | P::PREPARED | P::CANCELLING | P::CANCELLED
                ) =>
            {
                if root.phase != P::CANCELLED {
                    root.phase = P::CANCELLING;
                }
            }
            C::CANCEL if root.pending_effect == E::SCHEDULE_START && root.entered_effect == 0 => {
                root.failure = Some(Errno::ESRCH);
                root.pending_effect = self.root_cleanup_effect(root)?;
            }
            C::LAUNCH if root.phase == P::PREPARED && root.pending_effect == 0 => {
                // Publication and task admission are kernel mutations, not a
                // host-selected pair of raw calls. Failed publication remains
                // charged and must pass through the same proof-based cleanup.
                self.memory_group_task_action(
                    record,
                    wasm_posix_shared::memory_group::TaskAction::Start,
                )?;
                root.phase = P::LAUNCHING;
                match self.memory_groups().storage_action(
                    record,
                    wasm_posix_shared::group_storage::Action::Publish,
                    0,
                    0,
                    host,
                ) {
                    Ok(_) => root.pending_effect = E::PUBLISH_TRANSPORT,
                    Err(_) => {
                        root.failure = Some(Errno::EIO);
                        root.pending_effect = E::SEAL_ABSENCE;
                    }
                }
            }
            C::PLATFORM_COMPLETED | C::PLATFORM_FAILED => {
                if argument == 0 || root.pending_effect != argument || root.phase == P::CONTAINED {
                    return Err(Errno::EBUSY);
                }
                if command == C::PLATFORM_FAILED {
                    root.failure = Some(Errno::EIO);
                    let cleanup = self.root_cleanup_effect(root)?;
                    root.pending_effect = if argument == E::DISCARD_TRANSPORT
                        || argument == E::RETIRE_IMAGE && cleanup != E::DISCARD_TRANSPORT
                        || argument == E::SEAL_ABSENCE && cleanup == E::SEAL_ABSENCE
                        || argument == E::CANCEL_PREPARED_WORKER && cleanup != E::RETIRE_IMAGE && cleanup != E::DISCARD_TRANSPORT
                    {
                        root.phase = P::CONTAINED;
                        E::CONTAIN_FAILURE
                    } else {
                        cleanup
                    };
                } else {
                    root.pending_effect = match argument {
                        E::PUBLISH_TRANSPORT => E::BIND_WORKER,
                        E::BIND_WORKER => {
                            let (store, admission) = self.memory_groups().storage_owner(record)?;
                            // Bind is not acknowledged merely because a host
                            // callback returned. Actual storage owns the fact.
                            if !store.has_platform_references(admission)? {
                                return Err(Errno::EBUSY);
                            }
                            E::REGISTER_PROCESS
                        }
                        E::REGISTER_PROCESS => E::CONNECT_IMPORTS,
                        E::CONNECT_IMPORTS => E::SCHEDULE_START,
                        E::SCHEDULE_START => {
                            if root.entered_effect != E::SCHEDULE_START { return Err(Errno::EBUSY); }
                            E::WAIT_READY
                        }
                        E::WAIT_READY => E::DELIVER_LAUNCH,
                        E::DELIVER_LAUNCH => {
                            if root.entered_effect != E::DELIVER_LAUNCH { return Err(Errno::EBUSY); }
                            root.phase = P::FINISHED;
                            0
                        }
                        E::CANCEL_PREPARED_WORKER => match self.memory_groups().storage_owner(record) {
                            Ok((store, admission)) if store.accepted_worker_fact(admission)? => E::RETIRE_IMAGE,
                            Ok(_) => return Err(Errno::EBUSY),
                            // The normal exit owner may finish after the real
                            // terminal fence but before this native effect ACK.
                            Err(Errno::ESRCH) => E::DISCARD_TRANSPORT,
                            Err(error) => return Err(error),
                        },
                        E::SEAL_ABSENCE => {
                            let (store, admission) = self.memory_groups().storage_owner(record)?;
                            if !store.accepted_worker_fact(admission)?
                                || !store.worker_absence(admission)?
                            {
                                return Err(Errno::EBUSY);
                            }
                            E::RETIRE_IMAGE
                        }
                        E::RETIRE_IMAGE => {
                            if !matches!(
                                self.memory_groups().storage_owner(record),
                                Err(Errno::ESRCH)
                            ) {
                                return Err(Errno::EBUSY);
                            }
                            E::DISCARD_TRANSPORT
                        }
                        E::DISCARD_TRANSPORT => {
                            root.phase = P::CANCELLED;
                            0
                        }
                        _ => return Err(Errno::EBUSY),
                    };
                    root.entered_effect = 0;
                }
            }
            C::ENTER_NATIVE if matches!(argument, E::SCHEDULE_START | E::DELIVER_LAUNCH)
                && root.pending_effect == argument && root.entered_effect == 0 => {}
            _ => return Err(Errno::EBUSY),
        }
        if matches!(root.pending_effect, E::SCHEDULE_START | E::WAIT_READY | E::DELIVER_LAUNCH) && root.entered_effect == 0 {
            use crate::group_completion::NativeStart;
            match self.group_native_start_permission(record, host)? {
                NativeStart::Stopped if root.pending_effect != E::WAIT_READY => {
                    root.phase = P::WAITING;
                    let mut reply = root.reply(effect::YIELD); reply.delay = 10; return Ok(reply);
                }
                NativeStart::Dead => {
                    root.failure = Some(Errno::ESRCH);
                    root.pending_effect = self.root_cleanup_effect(root)?;
                }
                NativeStart::Ready | NativeStart::Stopped => {
                    root.phase = P::LAUNCHING;
                    if command == C::ENTER_NATIVE {
                        root.entered_effect = root.pending_effect;
                        let mut reply = root.reply(root.pending_effect);
                        reply.flags |= wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE;
                        return Ok(reply);
                    }
                }
            }
        }
        if root.pending_effect == E::RETIRE_IMAGE && self.retirement_control_retains(record) {
            // A signal/exit owner may already be draining this exact image.
            // Retain the root operation and let that owner finish, rather than
            // asking the host to select between competing lifecycle scripts.
            let mut reply = root.reply(effect::YIELD);
            reply.delay = 1;
            return Ok(reply);
        }
        if root.pending_effect != 0 {
            return Ok(root.reply(root.pending_effect));
        }
        if matches!(root.phase, P::PREPARING | P::PREPARED)
            && self.get(record.pid).is_none_or(|proc| {
                proc.exec_generation != record.generation || proc.exit_signal != 0
            })
        {
            root.failure = Some(Errno::ESRCH);
            root.phase = P::CANCELLING;
        }
        if root.phase == P::PREPARING {
            match self.memory_groups().prepare_storage_image(
                root.admission,
                crate::memory_group::ImageLayout {
                    initial_pages: root.layout.0[0] as u32,
                    maximum_pages: root.layout.0[1] as u32,
                    scratch_bytes: 65536,
                },
                host,
            ) {
                Ok(descriptor) => {
                    root.descriptor = Some(descriptor);
                    root.phase = P::PREPARED;
                }
                Err(Errno::EAGAIN) => return Ok(root.reply(effect::YIELD)),
                Err(error) => {
                    root.failure = Some(error);
                    root.phase = P::CANCELLING;
                }
            }
        }
        if root.phase == P::CANCELLING {
            match self
                .memory_groups()
                .cancel_unconstructed_with_storage(root.admission, host)
            {
                Ok(()) => {}
                Err(Errno::EAGAIN) => return Ok(root.reply(effect::YIELD)),
                Err(error) => return Err(error),
            }
            self.memory_groups()
                .retire_image(record.pid, record.generation)?;
            root.descriptor = None;
            root.phase = P::CANCELLED;
        }
        Ok(root.reply(effect::COMPLETE))
    }
}
impl Root {
    fn reply(&self, kind: u32) -> Reply {
        let record = self.admission.record();
        let mut reply = Reply::new(record, record.serial, kind);
        reply.value = i64::from(self.phase);
        reply.errno = self.failure.map_or(0, |e| e as u32);
        reply.payload_bytes = wasm_posix_shared::group_operation::PAYLOAD_BYTES as u32;
        for (index, value) in self.layout.0.iter().enumerate() {
            reply.payload[index * 8..index * 8 + 8].copy_from_slice(&value.to_le_bytes());
        }
        if let Some(descriptor) = self.descriptor {
            StorageReply {
                descriptor: Some(descriptor),
                value: 0,
                wait: None,
            }
            .encode(&mut reply.storage)
            .expect("root descriptor reply");
        }
        reply
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{memory_group::MemoryGroupLimits, process::test_host::NoopHost};
    fn fixture() -> (ProcessTable, u32, crate::memory_group::MemoryGroupId) {
        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        // Metadata is retained by the successful executable commit. NoopHost
        // deliberately cannot supply executable reads for this cached path.
        table.get_mut(pid).unwrap().grouped_artifact = Some(
            crate::group_layout::Artifact::read(&crate::grouped_exec::tests::grouped(3)).unwrap(),
        );
        table.memory_groups().configure(2048, 1).unwrap();
        let group = table
            .memory_groups()
            .create(MemoryGroupLimits {
                maximum_pages: 2048,
                maximum_processes: 2,
                maximum_tasks: 8,
            })
            .unwrap();
        (table, pid, group)
    }
    fn prepared() -> (ProcessTable, impl HostIO, ReceiptRecord) {
        let (mut table, pid, group) = fixture();
        let mut host = crate::exec_control::tests::storage_host();
        table
            .memory_groups()
            .create_storage(group, 1, &mut host)
            .unwrap();
        let reply = table
            .begin_root_control(group.as_raw(), pid, 2048, 8, &mut host)
            .unwrap();
        assert_eq!(reply.value, i64::from(P::PREPARED));
        (table, host, reply.receipt)
    }
    fn complete(
        table: &mut ProcessTable,
        host: &mut dyn HostIO,
        record: ReceiptRecord,
        issued: u32,
    ) -> Reply {
        if matches!(issued, E::SCHEDULE_START | E::DELIVER_LAUNCH) {
            let permission = table.root_control_effect(record, C::ENTER_NATIVE, issued, host).unwrap();
            assert_ne!(permission.flags & wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE, 0);
        }
        table
            .root_control_effect(record, C::PLATFORM_COMPLETED, issued, host)
            .unwrap()
    }
    fn bound(table: &mut ProcessTable, host: &mut dyn HostIO, record: ReceiptRecord) {
        table
            .retirement_control(
                record,
                wasm_posix_shared::retirement_control::command::BIND_REFERENCES,
                0,
                host,
            )
            .unwrap();
    }
    #[test]
    fn actual_kernel_root_selects_launch_steps_and_retains_a_stopped_constructor() {
        let (mut table, mut host, record) = prepared();
        assert!(matches!(
            table.memory_group_task_action(
                record,
                wasm_posix_shared::memory_group::TaskAction::Start
            ),
            Err(Errno::EBUSY)
        ));
        let reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
        assert_eq!(reply.effect, E::PUBLISH_TRANSPORT);
        assert!(matches!(
            table.root_control_effect(
                record,
                C::PLATFORM_COMPLETED,
                E::REGISTER_PROCESS,
                &mut host
            ),
            Err(Errno::EBUSY)
        ));
        let mut wrong = record;
        wrong.serial += 1;
        assert!(matches!(
            table.root_control(wrong, C::POLL, &mut host),
            Err(Errno::ESRCH)
        ));
        assert_eq!(
            complete(&mut table, &mut host, record, reply.effect).effect,
            E::BIND_WORKER
        );
        assert!(matches!(
            table.root_control_effect(record, C::PLATFORM_COMPLETED, E::BIND_WORKER, &mut host),
            Err(Errno::EBUSY)
        ));
        bound(&mut table, &mut host, record);
        assert_eq!(
            complete(&mut table, &mut host, record, E::BIND_WORKER).effect,
            E::REGISTER_PROCESS
        );
        assert_eq!(
            complete(&mut table, &mut host, record, E::REGISTER_PROCESS).effect,
            E::CONNECT_IMPORTS
        );
        assert_eq!(
            complete(&mut table, &mut host, record, E::CONNECT_IMPORTS).effect,
            E::SCHEDULE_START
        );
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Stopped;
        let waiting = table.root_control_effect(record, C::ENTER_NATIVE, E::SCHEDULE_START, &mut host).unwrap();
        assert_eq!((waiting.effect, waiting.value), (effect::YIELD, i64::from(P::WAITING)));
        assert!(matches!(
            table.root_control(record, C::ACK, &mut host),
            Err(Errno::EBUSY)
        ));
        assert_eq!(table.root_controls().entries.len(), 1);
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Running;
        let permission = table.root_control_effect(record, C::ENTER_NATIVE, E::SCHEDULE_START, &mut host).unwrap();
        assert_ne!(permission.flags & wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE, 0);
        let started = table.root_control_effect(record, C::PLATFORM_COMPLETED, E::SCHEDULE_START, &mut host).unwrap();
        assert_eq!(started.effect, E::WAIT_READY);
        assert!(matches!(
            table.root_control(record, C::ACK, &mut host),
            Err(Errno::EBUSY)
        ));
        assert_eq!(
            complete(&mut table, &mut host, record, E::WAIT_READY).effect,
            E::DELIVER_LAUNCH
        );
        assert_eq!(
            complete(&mut table, &mut host, record, E::DELIVER_LAUNCH).value,
            i64::from(P::FINISHED)
        );
        assert!(matches!(
            table.root_control_effect(record, C::ENTER_NATIVE, E::SCHEDULE_START, &mut host),
            Err(Errno::EBUSY)
        ));
        table.root_control(record, C::ACK, &mut host).unwrap();
        assert_eq!(table.root_controls().entries.len(), 0);
    }
    #[test]
    fn root_default_stop_and_delivery_each_require_a_live_exact_kernel_grant() {
        let (mut table, mut host, record) = prepared();
        let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
        while reply.effect != E::SCHEDULE_START {
            if reply.effect == E::BIND_WORKER { bound(&mut table, &mut host, record); }
            reply = complete(&mut table, &mut host, record, reply.effect);
        }
        assert!(table.get_mut(record.pid).unwrap().raise_signal(wasm_posix_shared::signal::SIGSTOP));
        let held = table.root_control_effect(record, C::ENTER_NATIVE, E::SCHEDULE_START, &mut host).unwrap();
        assert_eq!((held.effect, held.value), (effect::YIELD, i64::from(P::WAITING)));
        assert_eq!(held.flags & wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE, 0);
        assert!(matches!(table.root_control_effect(record, C::PLATFORM_COMPLETED, E::SCHEDULE_START, &mut host), Err(Errno::EBUSY)));
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Running;
        // No signal scan allocation may be required to grant this effect.
        let held_bytes = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _budget = crate::io_buffer::test_budget(held_bytes);
            assert_eq!(complete(&mut table, &mut host, record, E::SCHEDULE_START).effect, E::WAIT_READY);
        }
        assert_eq!(complete(&mut table, &mut host, record, E::WAIT_READY).effect, E::DELIVER_LAUNCH);
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Stopped;
        assert_eq!(table.root_control_effect(record, C::ENTER_NATIVE, E::DELIVER_LAUNCH, &mut host).unwrap().effect, effect::YIELD);
        assert!(matches!(table.root_control_effect(record, C::PLATFORM_COMPLETED, E::DELIVER_LAUNCH, &mut host), Err(Errno::EBUSY)));
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Running;
        assert_eq!(complete(&mut table, &mut host, record, E::DELIVER_LAUNCH).value, i64::from(P::FINISHED));
        table.root_control(record, C::ACK, &mut host).unwrap();
    }

    #[test]
    fn root_setup_failure_requires_real_absence_and_reference_retirement_before_rollback() {
        use wasm_posix_shared::retirement_control as R;
        for failed in [
            E::PUBLISH_TRANSPORT,
            E::BIND_WORKER,
            E::REGISTER_PROCESS,
            E::CONNECT_IMPORTS,
            E::SCHEDULE_START,
        ] {
            let (mut table, mut host, record) = prepared();
            let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
            while reply.effect != failed {
                if reply.effect == E::BIND_WORKER {
                    bound(&mut table, &mut host, record);
                }
                reply = complete(&mut table, &mut host, record, reply.effect);
            }
            reply = table
                .root_control_effect(record, C::PLATFORM_FAILED, failed, &mut host)
                .unwrap();
            assert_eq!(reply.effect, E::SEAL_ABSENCE);
            assert!(matches!(
                table.root_control_effect(
                    record,
                    C::PLATFORM_COMPLETED,
                    E::SEAL_ABSENCE,
                    &mut host
                ),
                Err(Errno::EBUSY)
            ));
            if failed == E::PUBLISH_TRANSPORT || failed == E::BIND_WORKER {
                bound(&mut table, &mut host, record);
            }
            table
                .retirement_control(record, R::command::SEALED_ABSENCE, 0, &mut host)
                .unwrap();
            assert_eq!(
                complete(&mut table, &mut host, record, E::SEAL_ABSENCE).effect,
                E::RETIRE_IMAGE
            );
            assert!(matches!(
                table.root_control_effect(
                    record,
                    C::PLATFORM_COMPLETED,
                    E::RETIRE_IMAGE,
                    &mut host
                ),
                Err(Errno::EBUSY)
            ));
            assert_eq!(
                table
                    .retirement_control(record, R::command::BEGIN_IMAGE, 0, &mut host)
                    .unwrap()
                    .effect,
                R::DETACH_PLATFORM
            );
            assert_eq!(
                table
                    .retirement_control(record, R::command::PLATFORM_DETACHED, 0, &mut host)
                    .unwrap()
                    .effect,
                R::DETACH_REFERENCES
            );
            table
                .retirement_control(record, R::command::BEGIN_REFERENCES, 0, &mut host)
                .unwrap();
            table
                .retirement_control(record, R::command::REFERENCES_DETACHED, 0, &mut host)
                .unwrap();
            assert_eq!(
                table
                    .retirement_control(record, R::command::POLL, 0, &mut host)
                    .unwrap()
                    .effect,
                effect::COMPLETE
            );
            table
                .retirement_control(record, R::command::ACK, 0, &mut host)
                .unwrap();
            assert_eq!(
                complete(&mut table, &mut host, record, E::RETIRE_IMAGE).effect,
                E::DISCARD_TRANSPORT
            );
            assert!(matches!(
                table.root_control(record, C::ACK, &mut host),
                Err(Errno::EBUSY)
            ));
            assert_eq!(
                complete(&mut table, &mut host, record, E::DISCARD_TRANSPORT).value,
                i64::from(P::CANCELLED)
            );
            table.root_control(record, C::ACK, &mut host).unwrap();
            let group = table.memory_groups().resolve_group(record.group).unwrap();
            let snapshot = table.memory_groups().snapshot(group).unwrap();
            assert_eq!(
                (snapshot.tasks, snapshot.images, snapshot.processes),
                (0, 0, 0)
            );
        }
    }
    #[test]
    fn pending_root_cancellation_uses_already_accepted_absence_instead_of_a_second_native_proof() {
        use wasm_posix_shared::retirement_control as R;
        let (mut table, mut host, record) = prepared();
        let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
        while reply.effect != E::SCHEDULE_START {
            if reply.effect == E::BIND_WORKER {
                bound(&mut table, &mut host, record);
            }
            reply = complete(&mut table, &mut host, record, reply.effect);
        }
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Stopped;
        assert_eq!(table.root_control(record, C::POLL, &mut host).unwrap().effect, effect::YIELD);
        table
            .retirement_control(record, R::command::SEALED_ABSENCE, 0, &mut host)
            .unwrap();
        assert_eq!(
            table
                .root_control(record, C::CANCEL, &mut host)
                .unwrap()
                .effect,
            E::RETIRE_IMAGE
        );
    }
    #[test]
    fn pending_root_joins_an_existing_exact_retirement_before_issuing_release() {
        use wasm_posix_shared::retirement_control as R;
        let (mut table, mut host, record) = prepared();
        let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
        while reply.effect != E::SCHEDULE_START {
            if reply.effect == E::BIND_WORKER {
                bound(&mut table, &mut host, record);
            }
            reply = complete(&mut table, &mut host, record, reply.effect);
        }
        table.get_mut(record.pid).unwrap().state = crate::process::ProcessState::Stopped;
        assert_eq!(table.root_control(record, C::POLL, &mut host).unwrap().effect, effect::YIELD);
        table
            .retirement_control(record, R::command::SEALED_ABSENCE, 0, &mut host)
            .unwrap();
        table
            .retirement_control(record, R::command::BEGIN_IMAGE, 0, &mut host)
            .unwrap();
        let wait = table
            .root_control(record, C::CANCEL, &mut host)
            .unwrap();
        assert_eq!((wait.effect, wait.delay), (effect::YIELD, 1));
        assert_eq!(
            table
                .root_control(record, C::POLL, &mut host)
                .unwrap()
                .effect,
            effect::YIELD
        );
        table
            .retirement_control(record, R::command::PLATFORM_DETACHED, 0, &mut host)
            .unwrap();
        table
            .retirement_control(record, R::command::BEGIN_REFERENCES, 0, &mut host)
            .unwrap();
        table
            .retirement_control(record, R::command::REFERENCES_DETACHED, 0, &mut host)
            .unwrap();
        table
            .retirement_control(record, R::command::POLL, 0, &mut host)
            .unwrap();
        table
            .retirement_control(record, R::command::ACK, 0, &mut host)
            .unwrap();
        assert_eq!(
            table
                .root_control(record, C::POLL, &mut host)
                .unwrap()
                .effect,
            E::RETIRE_IMAGE
        );
        assert_eq!(
            complete(&mut table, &mut host, record, E::RETIRE_IMAGE).effect,
            E::DISCARD_TRANSPORT
        );
        complete(&mut table, &mut host, record, E::DISCARD_TRANSPORT);
        table.root_control(record, C::ACK, &mut host).unwrap();
    }
    #[test]
    fn uncertain_root_constructor_or_readiness_failure_is_contained_without_reclamation() {
        for failed in [E::SCHEDULE_START, E::WAIT_READY, E::DELIVER_LAUNCH] {
            let (mut table, mut host, record) = prepared();
            let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
            while reply.effect != failed {
                if reply.effect == E::BIND_WORKER {
                    bound(&mut table, &mut host, record);
                }
                reply = complete(&mut table, &mut host, record, reply.effect);
            }
            let seal = table.root_control_effect(record, C::PLATFORM_FAILED, failed, &mut host).unwrap();
            assert_eq!(seal.effect, E::SEAL_ABSENCE);
            let contained = table
                .root_control_effect(record, C::PLATFORM_FAILED, E::SEAL_ABSENCE, &mut host)
                .unwrap();
            assert_eq!(
                (contained.effect, contained.value),
                (E::CONTAIN_FAILURE, i64::from(P::CONTAINED))
            );
            assert!(matches!(
                table.root_control(record, C::ACK, &mut host),
                Err(Errno::EBUSY)
            ));
            let group = table.memory_groups().resolve_group(record.group).unwrap();
            let snapshot = table.memory_groups().snapshot(group).unwrap();
            assert_eq!(
                (snapshot.tasks, snapshot.images, snapshot.processes),
                (1, 1, 1)
            );
        }
    }
    #[test]
    fn shutdown_of_a_prepared_worker_requires_its_exact_terminal_fact() {
        use wasm_posix_shared::retirement_control as R;
        for ready in [false, true] {
            let (mut table, mut host, record) = prepared();
            let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
            while reply.effect != E::WAIT_READY {
                if reply.effect == E::BIND_WORKER { bound(&mut table, &mut host, record); }
                reply = complete(&mut table, &mut host, record, reply.effect);
            }
            if ready { reply = complete(&mut table, &mut host, record, E::WAIT_READY); }
            assert_eq!(reply.effect, if ready { E::DELIVER_LAUNCH } else { E::WAIT_READY });
            let group = table.memory_groups().resolve_group(record.group).unwrap();
            assert_eq!(table.stop_next_memory_group_member(group, &mut host).unwrap(), Some(record.pid));
            let cancelled = table.root_control(record, C::POLL, &mut host).unwrap();
            assert_eq!(cancelled.effect, E::CANCEL_PREPARED_WORKER);
            assert!(matches!(table.root_control_effect(record, C::PLATFORM_COMPLETED, E::CANCEL_PREPARED_WORKER, &mut host), Err(Errno::EBUSY)));
            table.retirement_control(record, R::command::WORKER_FENCE, 0, &mut host).unwrap();
            assert_eq!(complete(&mut table, &mut host, record, E::CANCEL_PREPARED_WORKER).effect, E::RETIRE_IMAGE);
        }
    }
    #[test]
    fn prepared_root_cancellation_ack_joins_already_finished_native_retirement() {
        use wasm_posix_shared::retirement_control as R;
        let (mut table, mut host, record) = prepared();
        let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
        while reply.effect != E::WAIT_READY {
            if reply.effect == E::BIND_WORKER {
                table.retirement_control(record, R::command::BIND_REFERENCES, R::NATIVE_JOIN_CAPABILITY, &mut host).unwrap();
            }
            reply = complete(&mut table, &mut host, record, reply.effect);
        }
        let group = table.memory_groups().resolve_group(record.group).unwrap();
        table.stop_next_memory_group_member(group, &mut host).unwrap();
        assert_eq!(table.root_control(record, C::POLL, &mut host).unwrap().effect, E::CANCEL_PREPARED_WORKER);
        table.retirement_control(record, R::command::WORKER_FENCE, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::NATIVE_JOIN, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::BEGIN_IMAGE, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::PLATFORM_DETACHED, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::BEGIN_REFERENCES, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::REFERENCES_DETACHED, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::POLL, 0, &mut host).unwrap();
        table.retirement_control(record, R::command::ACK, 0, &mut host).unwrap();
        assert!(matches!(table.memory_groups().storage_owner(record), Err(Errno::ESRCH)));
        assert_eq!(complete(&mut table, &mut host, record, E::CANCEL_PREPARED_WORKER).effect, E::DISCARD_TRANSPORT);
        complete(&mut table, &mut host, record, E::DISCARD_TRANSPORT);
        table.root_control(record, C::ACK, &mut host).unwrap();
        assert_eq!(table.memory_groups().snapshot(group).unwrap().tasks, 0);
    }
    #[test]
    fn failed_readiness_uses_an_accepted_node_join_without_requiring_absence() {
        use wasm_posix_shared::retirement_control as R;
        let (mut table, mut host, record) = prepared();
        let mut reply = table.root_control(record, C::LAUNCH, &mut host).unwrap();
        while reply.effect != E::WAIT_READY {
            if reply.effect == E::BIND_WORKER {
                table
                    .retirement_control(
                        record,
                        R::command::BIND_REFERENCES,
                        R::NATIVE_JOIN_CAPABILITY,
                        &mut host,
                    )
                    .unwrap();
            }
            reply = complete(&mut table, &mut host, record, reply.effect);
        }
        table
            .retirement_control(record, R::command::NATIVE_JOIN, 0, &mut host)
            .unwrap();
        assert_eq!(
            table
                .root_control_effect(record, C::PLATFORM_FAILED, E::WAIT_READY, &mut host)
                .unwrap()
                .effect,
            E::RETIRE_IMAGE
        );
    }
    #[test]
    fn root_control_failed_storage_preparation_retires_its_exact_admission() {
        let (mut table, pid, group) = fixture();
        // No backing was constructed: the error follows logical admission.
        // The caller must receive completed cancellation, not a leaked receipt.
        let reply = table
            .begin_root_control(group.as_raw(), pid, 2048, 73, &mut NoopHost)
            .unwrap();
        assert_eq!(reply.effect, effect::COMPLETE);
        assert_eq!(reply.value, i64::from(P::CANCELLED));
        assert_eq!(reply.errno, Errno::ENOENT as u32);
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(snapshot.tasks, 0);
        assert_eq!(snapshot.images, 0);
        assert_eq!(table.root_controls().entries.len(), 1);
        let mut wrong = reply.receipt;
        wrong.generation += 1;
        assert!(matches!(
            table.root_control(wrong, C::ACK, &mut NoopHost),
            Err(Errno::ESRCH)
        ));
        table
            .root_control(reply.receipt, C::ACK, &mut NoopHost)
            .unwrap();
        assert_eq!(table.root_controls().entries.len(), 0);
        assert!(matches!(
            table.root_control(reply.receipt, C::ACK, &mut NoopHost),
            Err(Errno::ESRCH)
        ));
    }
    #[test]
    fn root_control_refuses_an_impossible_virtual_layout_before_admission() {
        let (mut table, pid, group) = fixture();
        assert!(matches!(
            table.begin_root_control(group.as_raw(), pid, 128, 73, &mut NoopHost),
            Err(Errno::ENOMEM)
        ));
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(snapshot.tasks, 0);
        assert_eq!(snapshot.images, 0);
        assert_eq!(table.root_controls().entries.len(), 0);
    }
}
