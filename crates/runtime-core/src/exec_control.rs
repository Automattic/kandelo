//! Actual ProcessTable custody across exec prepare, commit and image handoff.
use crate::{
    exec_target,
    grouped_exec::PreparedGroupedExec,
    io_buffer::IO_MEMORY,
    memory_group::{
        ReplicaDescriptor, StorageReply, physical::HostMemory, storage::ProgressTarget,
    },
    prepared_map::{MapMemory, PreparedMap, PreparedMapSlot},
    process::HostIO,
    process_table::ProcessTable,
};
use W::{command as C, effect as E, phase as P};
use wasm_posix_shared::{
    Errno, exec_control as W,
    group_operation::{Reply, effect},
    memory_group::ReceiptRecord,
};
const PAGE: u64 = 65536;
use crate::group_layout::Layout;
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Key(u32, u64);
impl MapMemory for Key {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
struct Control {
    source: ReceiptRecord,
    future: PreparedGroupedExec,
    layout: Layout,
    phase: u32,
    descriptor: Option<ReplicaDescriptor>,
    failure: Option<Errno>,
    parent: u32,
    signal: u32,
    pending_effect: u32,
    entered_effect: u32,
    exit_recorded: bool,
    exit_status: i32,
    replacement_bound: bool,
    constructor_entered: bool,
    delivery_entered: bool,
    replacement_stop_requested: bool,
    preparation_cancel_sent: bool,
    handed_off: bool,
}
impl MapMemory for Control {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
pub(crate) struct Controls {
    entries: PreparedMap<Key, Control>,
}
impl Controls {
    pub(crate) const fn new() -> Self {
        Self {
            entries: PreparedMap::new(),
        }
    }
}

impl ProcessTable {
    pub fn begin_exec_control(
        &mut self,
        source: ReceiptRecord,
        target: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        if self.running_group_memory_caller(source.pid, source.tid)? != source {
            return Err(Errno::ESRCH);
        }
        let (store, admission) = self.memory_groups().storage_owner(source)?;
        let ceiling = store.descriptor(admission)?.maximum_virtual_pages;
        let source_root = store.root_for_image(source)?.record();
        let proc = self.get(source.pid).ok_or(Errno::ESRCH)?;
        let layout = Layout::artifact(
            exec_target::artifact_bytes(proc, source.pid, target)?,
            ceiling,
        )?;
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let future = self.prepare_grouped_exec(source.pid, source.tid, target)?;
        let record = future.receipt.record();
        let control = Control {
            source: source_root,
            future,
            layout,
            phase: P::PREPARING,
            descriptor: None,
            failure: None,
            parent: 0,
            signal: 0,
            pending_effect: 0,
            entered_effect: 0,
            exit_recorded: false,
            exit_status: 0,
            replacement_bound: false,
            constructor_entered: false,
            delivery_entered: false,
            replacement_stop_requested: false,
            preparation_cancel_sent: false,
            handed_off: false,
        };
        let entry = slot.finish(Key(record.group, record.serial), control)?;
        self.exec_controls().entries.publish_io(entry);
        if let Err(error) = self.configure_grouped_exec(layout.record(record)) {
            let control = self
                .exec_controls()
                .entries
                .get_mut(&Key(record.group, record.serial))
                .unwrap();
            control.failure = Some(error);
            control.phase = P::CANCELLING;
        }
        // Normal admission/allocation errors are replies after exact rollback.
        // Once a receipt exists, a failed continuation is retained ownership,
        // never an ordinary "nothing admitted" host refusal.
        match self.exec_control(record, C::POLL, host) {
            Ok(reply) => Ok(reply),
            Err(error) => panic!("retained exec continuation failed for {record:?}: {error:?}"),
        }
    }

    pub(crate) fn validate_exec_control_commit(&self, future: ReceiptRecord) -> Result<(), Errno> {
        if let Some(control) = self
            .exec_controls_ref()
            .entries
            .get(&Key(future.group, future.serial))
        {
            if control.future.receipt.record() != future
                || control.phase != P::PREPARED
                || control.descriptor.is_none()
            {
                return Err(Errno::EBUSY);
            }
        }
        Ok(())
    }

    pub(crate) fn validate_exec_control_start(&self, future: ReceiptRecord) -> Result<(), Errno> {
        if let Some(control) = self
            .exec_controls_ref()
            .entries
            .get(&Key(future.group, future.serial))
        {
            if control.future.receipt.record() != future
                || control.phase != P::OLD_STOPPED
                || control.signal != 0
                || control.pending_effect != E::INSTALL_REPLACEMENT
            {
                return Err(Errno::EBUSY);
            }
            let proc = self.get(future.pid).ok_or(Errno::ESRCH)?;
            if proc.exec_generation != future.generation || proc.exit_signal != 0 {
                return Err(Errno::ESRCH);
            }
        }
        Ok(())
    }

    pub(crate) fn note_exec_control_commit(&mut self, future: ReceiptRecord) {
        if let Some(control) = self
            .exec_controls()
            .entries
            .get_mut(&Key(future.group, future.serial))
        {
            assert_eq!(control.future.receipt.record(), future);
            assert_eq!(control.phase, P::PREPARED);
            control.phase = P::COMMITTED;
        }
    }

    pub fn exec_control_retains_image(&mut self, image: ReceiptRecord) -> bool {
        self.exec_controls().entries.values().any(|control| {
            control.source.pid == image.pid
                && control.source.generation == image.generation
                && control.source.group == image.group
                && matches!(
                    control.phase,
                    P::PREPARING
                        | P::PREPARED
                        | P::CANCELLING
                        | P::COMMITTED
                        | P::HANDOFF
                        | P::OLD_STOPPED
                        | P::TERMINATING
                        | P::CONTAINED
                )
        })
    }

    pub fn exec_control(
        &mut self,
        record: ReceiptRecord,
        command: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        self.exec_control_effect(record, command, 0, host)
    }

    pub fn exec_control_effect(
        &mut self,
        record: ReceiptRecord,
        command: u32,
        completed_effect: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        if matches!(
            command,
            C::PLATFORM_COMPLETED | C::PLATFORM_FAILED | C::ENTER_NATIVE
        ) != (completed_effect != 0)
        {
            return Err(Errno::EINVAL);
        }
        let key = Key(record.group, record.serial);
        let control = self.exec_controls().entries.get(&key).ok_or(Errno::ESRCH)?;
        if control.future.receipt.record() != record {
            return Err(Errno::ESRCH);
        }
        if command == C::ACK {
            if !matches!(control.phase, P::CANCELLED | P::FINISHED) {
                return Err(Errno::EBUSY);
            }
            self.exec_controls().entries.remove(&key);
            return Ok(Reply::new(record, record.serial, effect::COMPLETE));
        }
        let mut entry = self
            .exec_controls()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let result = self.advance_exec_control(entry.value_mut(), command, completed_effect, host);
        self.exec_controls().entries.publish_io(entry);
        result
    }

    fn exec_control_reply(control: &Control, kind: u32) -> Reply {
        let record = control.future.receipt.record();
        let mut reply = Reply::new(record, record.serial, kind);
        reply.value = i64::from(control.phase);
        reply.errno = control.failure.map_or(0, |error| error as u32);
        reply.length = control.signal;
        reply.payload_bytes = wasm_posix_shared::group_operation::PAYLOAD_BYTES as u32;
        for (at, value) in control.layout.0.iter().enumerate() {
            reply.payload[at * 8..at * 8 + 8].copy_from_slice(&value.to_le_bytes());
        }
        control
            .source
            .encode(&mut reply.payload[W::SOURCE..W::SOURCE + 32])
            .expect("retained exec source");
        reply.payload[W::PARENT..W::PARENT + 4].copy_from_slice(&control.parent.to_le_bytes());
        reply.payload[W::SIGNAL..W::SIGNAL + 4].copy_from_slice(&control.signal.to_le_bytes());
        reply.payload[W::EXIT_STATUS..W::EXIT_STATUS + 4]
            .copy_from_slice(&control.exit_status.to_le_bytes());
        if control.exit_recorded {
            reply.flags |= W::flags::EXIT_HELD;
        }
        if let Some(descriptor) = control.descriptor {
            StorageReply {
                descriptor: Some(descriptor),
                value: 0,
                wait: None,
            }
            .encode(&mut reply.storage)
            .expect("retained exec storage");
        }
        reply
    }

    fn exec_control_wait(
        &mut self,
        control: &Control,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let (store, _) = self.memory_groups().storage_owner(control.source)?;
        let root = store.root_for_image(control.source)?;
        let wait = store.prepare_progress(
            &HostMemory {
                resource: store.resource(),
                host,
            },
            root,
            ProgressTarget::Pool,
        )?;
        let mut reply = Self::exec_control_reply(
            control,
            if wait.is_some() {
                effect::WAIT_NATIVE
            } else {
                effect::YIELD
            },
        );
        reply.delay = 10;
        if let Some(wait) = wait {
            reply.wait_token = wait.token;
            reply.wait_address = wait.address;
            reply.wait_expected = wait.expected;
            StorageReply::encode_progress(
                root.record(),
                store.resource(),
                wait,
                &mut reply.storage,
            )?;
        }
        Ok(reply)
    }

    fn capture_exec_exit(&self, control: &mut Control) {
        // After successful handoff the normal process-stop owner handles exit.
        // Retaining it here until transport ACK would suppress that owner.
        if control.handed_off {
            return;
        }
        let record = control.future.receipt.record();
        if let Some(process) = self.get(record.pid).filter(|process| {
            process.exec_generation == record.generation
                && (process.exit_signal > 0
                    || matches!(
                        process.state,
                        crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
                    ))
        }) {
            control.exit_recorded = true;
            control.parent = process.ppid;
            control.signal = process.exit_signal;
            control.exit_status = if process.exit_signal > 0 {
                128 + process.exit_signal as i32
            } else {
                process.exit_status
            };
        }
    }
    fn request_exec_replacement_stop(
        &mut self,
        control: &mut Control,
        host: &mut dyn HostIO,
    ) -> Result<bool, Errno> {
        if control.replacement_stop_requested {
            return Ok(true);
        }
        let record = control.future.receipt.record();
        match self.memory_groups().storage_action(
            record,
            wasm_posix_shared::group_storage::Action::StopImage,
            0,
            0,
            host,
        ) {
            Ok(_) => {
                control.replacement_stop_requested = true;
                Ok(true)
            }
            Err(Errno::EAGAIN) => Ok(false),
            Err(error) => Err(error),
        }
    }
    fn exec_replacement_stop_notification(
        &mut self,
        control: &mut Control,
    ) -> Result<Option<u32>, Errno> {
        if !control.replacement_bound || !control.constructor_entered {
            return Ok(None);
        }
        let (store, admission) = match self
            .memory_groups()
            .storage_owner(control.future.receipt.record())
        {
            Ok(owner) => owner,
            Err(Errno::ESRCH) => return Ok(None),
            Err(error) => return Err(error),
        };
        if store.accepted_worker_fact(admission)? {
            return Ok(None);
        }
        if control.delivery_entered {
            return Ok(Some(E::WAKE_REPLACEMENT));
        }
        if !control.preparation_cancel_sent {
            control.preparation_cancel_sent = true;
            return Ok(Some(E::CANCEL_PREPARATION));
        }
        Ok(None)
    }
    fn retiring_exec_reply(
        &mut self,
        control: &mut Control,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        if !self.request_exec_replacement_stop(control, host)? {
            let mut reply = Self::exec_control_reply(control, effect::YIELD);
            reply.delay = 10;
            return Ok(reply);
        }
        let (store, admission) = self
            .memory_groups()
            .storage_owner(control.future.receipt.record())?;
        control.pending_effect = if store.accepted_worker_fact(admission)? {
            E::WAIT_REPLACEMENT
        } else if !control.constructor_entered {
            E::SEAL_REPLACEMENT
        } else {
            self.exec_replacement_stop_notification(control)?
                .unwrap_or(E::WAIT_REPLACEMENT)
        };
        control.phase = P::RETIRING_INSTALLED;
        Ok(Self::exec_control_reply(control, control.pending_effect))
    }

    fn advance_exec_control(
        &mut self,
        control: &mut Control,
        command: u32,
        completed_effect: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let record = control.future.receipt.record();
        self.capture_exec_exit(control);
        match command {
            C::POLL | C::STATUS => {}
            C::VALIDATE => {
                if control.phase != P::PREPARED {
                    return Err(Errno::EBUSY);
                }
                self.validate_grouped_exec(record)?;
            }
            C::CANCEL => {
                if !matches!(
                    control.phase,
                    P::PREPARING | P::PREPARED | P::CANCELLING | P::CANCELLED
                ) {
                    return Err(Errno::EBUSY);
                }
                if control.phase != P::CANCELLED {
                    control.phase = P::CANCELLING;
                }
            }
            C::HANDOFF => {
                if control.phase != P::COMMITTED
                    || control.pending_effect != 0
                    || self
                        .get(record.pid)
                        .is_none_or(|proc| proc.exec_generation != record.generation)
                {
                    return Err(Errno::ESRCH);
                }
                control.pending_effect = E::DETACH_PREVIOUS;
            }
            C::PLATFORM_COMPLETED | C::PLATFORM_FAILED => {
                if control.pending_effect == 0
                    || control.pending_effect != completed_effect
                    || control.phase == P::CONTAINED
                {
                    return Err(Errno::EBUSY);
                }
                if command == C::PLATFORM_FAILED {
                    // A failed postcommit platform action is not evidence that
                    // its Worker never started, stopped, joined or detached.
                    // Retain both images; only this disposable kernel is lost.
                    control.phase = P::CONTAINED;
                    control.pending_effect = E::CONTAIN_FAILURE;
                } else {
                    self.complete_exec_platform_effect(control, completed_effect)?;
                }
            }
            C::ENTER_NATIVE
                if matches!(completed_effect, E::START_REPLACEMENT | E::DELIVER_LAUNCH)
                    && control.pending_effect == completed_effect
                    && control.entered_effect == 0 => {}
            C::VALIDATE_INSTALL | C::INSTALLED => {
                if control.phase != P::OLD_STOPPED
                    || control.signal != 0
                    || control.pending_effect != E::INSTALL_REPLACEMENT
                {
                    return Err(Errno::EBUSY);
                }
                let proc = self.get(record.pid).ok_or(Errno::ESRCH)?;
                if proc.exec_generation != record.generation || proc.exit_signal != 0 {
                    return Err(Errno::ESRCH);
                }
                let (store, admission) = self.memory_groups().storage_owner(record)?;
                if store.status(admission)? & wasm_posix_shared::group_storage::status::PREPARED
                    != 0
                {
                    return Err(Errno::EBUSY);
                }
                if command == C::INSTALLED {
                    control.phase = P::INSTALLED;
                }
            }
            _ => return Err(Errno::EINVAL),
        }
        if command == C::STATUS {
            if control.exit_recorded && control.phase == P::INSTALLED && control.replacement_bound {
                if !self.request_exec_replacement_stop(control, host)? {
                    let mut reply = Self::exec_control_reply(control, effect::YIELD);
                    reply.delay = 10;
                    return Ok(reply);
                }
                if let Some(notification) = self.exec_replacement_stop_notification(control)? {
                    return Ok(Self::exec_control_reply(control, notification));
                }
            } else if control.exit_recorded
                && !matches!(
                    control.phase,
                    P::TERMINATED_FUTURE | P::FINISHED | P::RETIRING_INSTALLED
                )
            {
                match self.memory_groups().storage_action(
                    control.source,
                    wasm_posix_shared::group_storage::Action::StopImage,
                    0,
                    0,
                    host,
                ) {
                    Ok(_) | Err(Errno::EAGAIN | Errno::ESRCH) => {}
                    Err(error) => return Err(error),
                }
            }
            return Ok(Self::exec_control_reply(control, effect::COMPLETE));
        }
        // Bind the real replacement's disposal endpoints even after exit, but
        // never authorize its constructor/delivery. In-flight callbacks must
        // report actual settlement before this retained owner changes effects.
        if control.phase == P::INSTALLED && control.exit_recorded && control.replacement_bound {
            return self.retiring_exec_reply(control, host);
        }
        if matches!(
            control.pending_effect,
            E::START_REPLACEMENT | E::DELIVER_LAUNCH
        ) && control.entered_effect == 0
        {
            use crate::group_completion::NativeStart;
            match self.group_native_start_permission(record, host)? {
                NativeStart::Stopped => {
                    let mut reply = Self::exec_control_reply(control, effect::YIELD);
                    reply.delay = 10;
                    return Ok(reply);
                }
                NativeStart::Dead => {
                    self.capture_exec_exit(control);
                    if control.exit_recorded {
                        return self.retiring_exec_reply(control, host);
                    }
                    control.failure = Some(Errno::ESRCH);
                    control.phase = P::CONTAINED;
                    control.pending_effect = E::CONTAIN_FAILURE;
                }
                NativeStart::Ready if command == C::ENTER_NATIVE => {
                    control.entered_effect = control.pending_effect;
                    if control.pending_effect == E::START_REPLACEMENT {
                        control.constructor_entered = true;
                    }
                    if control.pending_effect == E::DELIVER_LAUNCH {
                        control.delivery_entered = true;
                    }
                    let mut reply = Self::exec_control_reply(control, control.pending_effect);
                    reply.flags |= wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE;
                    return Ok(reply);
                }
                NativeStart::Ready => {}
            }
        }
        if control.pending_effect != 0 {
            return Ok(Self::exec_control_reply(control, control.pending_effect));
        }
        if control.phase == P::PREPARING {
            if let Err(error) = self.validate_grouped_exec(record) {
                control.failure = Some(error);
                control.phase = P::CANCELLING;
            } else {
                match self.memory_groups().prepare_storage_image(
                    control.future.receipt,
                    crate::memory_group::ImageLayout {
                        initial_pages: control.layout.0[0] as u32,
                        maximum_pages: control.layout.0[1] as u32,
                        scratch_bytes: PAGE as u32,
                    },
                    host,
                ) {
                    Ok(descriptor) => {
                        control.descriptor = Some(descriptor);
                        control.phase = P::PREPARED;
                    }
                    Err(Errno::EAGAIN) => return self.exec_control_wait(control, host),
                    Err(error) => {
                        control.failure = Some(error);
                        control.phase = P::CANCELLING;
                    }
                }
            }
        }
        if control.phase == P::CANCELLING {
            match self.cancel_grouped_exec(record, host) {
                Ok(()) => {}
                Err(Errno::EAGAIN) => return self.exec_control_wait(control, host),
                Err(error) => return Err(error),
            }
            self.finish_grouped_exec_cancellation(record)?;
            control.descriptor = None;
            control.phase = P::CANCELLED;
        }
        if control.phase == P::HANDOFF {
            match self.memory_groups().storage_action(
                control.source,
                wasm_posix_shared::group_storage::Action::StopImage,
                0,
                0,
                host,
            ) {
                Ok(_) => {
                    control.pending_effect = E::WAIT_WORKERS;
                    return Ok(Self::exec_control_reply(control, control.pending_effect));
                }
                Err(Errno::EAGAIN) => return self.exec_control_wait(control, host),
                Err(error) => return Err(error),
            }
        }
        if control.phase == P::TERMINATING {
            match self
                .memory_groups()
                .cancel_unconstructed_with_storage(control.future.receipt, host)
            {
                Ok(()) => {}
                Err(Errno::EAGAIN) => return self.exec_control_wait(control, host),
                Err(error) => return Err(error),
            }
            self.memory_groups()
                .retire_image(record.pid, record.generation)?;
            control.descriptor = None;
            control.phase = P::TERMINATED_FUTURE;
            control.pending_effect = E::DISCARD_FUTURE;
            return Ok(Self::exec_control_reply(control, control.pending_effect));
        }
        Ok(Self::exec_control_reply(control, effect::COMPLETE))
    }

    fn complete_exec_platform_effect(
        &mut self,
        control: &mut Control,
        completed: u32,
    ) -> Result<(), Errno> {
        let record = control.future.receipt.record();
        let next = match completed {
            E::DETACH_PREVIOUS => {
                control.phase = P::HANDOFF;
                0
            }
            E::WAIT_WORKERS => {
                let (store, admission) = self.memory_groups().storage_owner(control.source)?;
                if store.status(admission)?
                    & wasm_posix_shared::group_storage::status::IMAGE_STOPPED
                    == 0
                {
                    return Err(Errno::EBUSY);
                }
                control.phase = P::OLD_STOPPED;
                E::JOIN_PREVIOUS
            }
            E::JOIN_PREVIOUS => {
                let proc = self.get(record.pid).ok_or(Errno::ESRCH)?;
                if proc.exec_generation != record.generation {
                    return Err(Errno::ESRCH);
                }
                if control.exit_recorded {
                    control.signal = proc.exit_signal;
                    control.parent = proc.ppid;
                    control.phase = P::TERMINATING;
                    0
                } else {
                    E::INSTALL_REPLACEMENT
                }
            }
            E::INSTALL_REPLACEMENT => {
                if control.phase != P::INSTALLED {
                    return Err(Errno::EBUSY);
                }
                E::RETIRE_PREVIOUS
            }
            E::DISCARD_FUTURE => E::RETIRE_PREVIOUS,
            E::RETIRE_PREVIOUS => {
                // Native join/stop does not imply channel/native-wait/reference
                // retirement. Require the actual storage owner to be gone.
                match self.memory_groups().storage_owner(control.source) {
                    Err(Errno::ESRCH) => {}
                    _ => return Err(Errno::EBUSY),
                }
                if control.phase == P::TERMINATED_FUTURE {
                    E::PUBLISH_TERMINATION
                } else {
                    E::BIND_REPLACEMENT
                }
            }
            E::BIND_REPLACEMENT => {
                let (store, admission) = self.memory_groups().storage_owner(record)?;
                if !store.has_platform_references(admission)? {
                    return Err(Errno::EBUSY);
                }
                control.replacement_bound = true;
                E::START_REPLACEMENT
            }
            E::SEAL_REPLACEMENT => {
                let (store, admission) = self.memory_groups().storage_owner(record)?;
                if !store.accepted_worker_fact(admission)? || !store.worker_absence(admission)? {
                    return Err(Errno::EBUSY);
                }
                E::WAIT_REPLACEMENT
            }
            E::CANCEL_PREPARATION | E::WAKE_REPLACEMENT => E::WAIT_REPLACEMENT,
            E::WAIT_REPLACEMENT => {
                let (store, admission) = self.memory_groups().storage_owner(record)?;
                if store.status(admission)?
                    & wasm_posix_shared::group_storage::status::IMAGE_STOPPED
                    == 0
                {
                    return Err(Errno::EBUSY);
                }
                E::JOIN_REPLACEMENT
            }
            E::JOIN_REPLACEMENT => E::RETIRE_REPLACEMENT,
            E::RETIRE_REPLACEMENT => {
                if !matches!(
                    self.memory_groups().storage_owner(record),
                    Err(Errno::ESRCH)
                ) {
                    return Err(Errno::EBUSY);
                }
                control.descriptor = None;
                E::PUBLISH_TERMINATION
            }
            E::START_REPLACEMENT | E::DELIVER_LAUNCH => {
                if control.entered_effect != completed {
                    return Err(Errno::EBUSY);
                }
                if completed == E::START_REPLACEMENT {
                    E::WAIT_READY
                } else {
                    E::FINISH_HANDOFF
                }
            }
            E::WAIT_READY => E::DELIVER_LAUNCH,
            E::FINISH_HANDOFF => {
                // Exit can commit while this platform callback is outstanding.
                // Keep the installed phase so the next continuation selects
                // exact retirement instead of acknowledging away its event.
                if !control.exit_recorded {
                    control.handed_off = true;
                    control.phase = P::FINISHED;
                }
                0
            }
            E::PUBLISH_TERMINATION => {
                control.phase = P::FINISHED;
                0
            }
            _ => return Err(Errno::EINVAL),
        };
        control.pending_effect = next;
        control.entered_effect = 0;
        Ok(())
    }
}

impl ProcessTable {
    /// A retiring source asks the exec owner which exact uncommitted future
    /// still needs cancellation and platform-reference disposal.
    pub(crate) fn exec_preparation_for_retiring_image(
        &mut self,
        source: ReceiptRecord,
    ) -> Option<ReceiptRecord> {
        self.exec_controls()
            .entries
            .values()
            .find(|control| {
                control.source == source
                    && matches!(
                        control.phase,
                        P::PREPARING | P::PREPARED | P::CANCELLING | P::CANCELLED
                    )
            })
            .map(|control| control.future.receipt.record())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        grouped_exec::tests::{Fixture, grouped},
        memory_group::{ImageLayout, MemoryGroupLimits},
        process::test_host::NoopHost,
    };
    use alloc::{vec, vec::Vec};
    use wasm_posix_shared::{
        WasmStat, group_storage::Action, memory_group::TaskAction, retirement_control as R,
    };

    // A native foreign-memory host: it models bytes and reports concrete
    // effects, while the actual ProcessTable chooses every transition.
    struct Host {
        bytes: Vec<u8>,
        resource: u64,
        maximum: u32,
    }
    pub(crate) fn storage_host() -> impl HostIO {
        Host {
            bytes: Vec::new(),
            resource: 0,
            maximum: 0,
        }
    }
    macro_rules! noop {
        ($(fn $name:ident($($arg:ident: $ty:ty),*) -> $ret:ty;)*) => {$ (
            fn $name(&mut self, $($arg: $ty),*) -> $ret { NoopHost.$name($($arg),*) }
        )*};
    }
    impl HostIO for Host {
        noop! {
            fn host_close(h: i64) -> Result<(), Errno>;
            fn host_read(h: i64, b: &mut [u8]) -> Result<usize, Errno>;
            fn host_write(h: i64, b: &[u8]) -> Result<usize, Errno>;
            fn host_seek(h: i64, o: i64, w: u32) -> Result<i64, Errno>;
            fn host_fstat(h: i64) -> Result<WasmStat, Errno>;
            fn host_readdir(h: i64, b: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno>;
            fn host_clock_gettime(c: u32) -> Result<(i64, i64), Errno>;
            fn host_ftruncate(h: i64, l: i64) -> Result<(), Errno>;
            fn host_fsync(h: i64) -> Result<(), Errno>;
            fn host_fchmod(h: i64, m: u32) -> Result<(), Errno>;
            fn host_fchown(h: i64, u: u32, g: u32) -> Result<(), Errno>;
            fn host_set_alarm(s: u32) -> Result<(), Errno>;
            fn host_set_posix_timer(t: i32, s: i32, v: i64, i: i64) -> Result<(), Errno>;
            fn host_getrandom(b: &mut [u8]) -> Result<usize, Errno>;
            fn host_net_connect(h: i32, a: &[u8], p: u16) -> Result<(), Errno>;
            fn host_net_connect_status(h: i32) -> Result<(), Errno>;
            fn host_net_send(h: i32, d: &[u8], f: u32) -> Result<usize, Errno>;
            fn host_net_close(h: i32) -> Result<(), Errno>;
            fn host_net_recv(h: i32, l: u32, f: u32, b: &mut [u8]) -> Result<usize, Errno>;
            fn host_net_listen(h: i32, p: u16, a: &[u8; 4]) -> Result<(), Errno>;
            fn host_getaddrinfo(n: &[u8], r: &mut [u8]) -> Result<usize, Errno>;
            fn bind_framebuffer(p: i32, a: usize, l: usize, w: u32, h: u32, s: u32, f: u32) -> ();
            fn unbind_framebuffer(p: i32) -> ();
            fn fb_write(p: i32, o: usize, b: &[u8]) -> ();
        }
        fn group_memory_create(
            &mut self,
            resource: u64,
            initial: u32,
            maximum: u32,
        ) -> Result<(), Errno> {
            assert!(self.bytes.is_empty());
            self.resource = resource;
            self.maximum = maximum;
            self.bytes = vec![0; initial as usize * PAGE as usize];
            Ok(())
        }
        fn group_memory_pages(&self, resource: u64) -> Result<u32, Errno> {
            assert_eq!(resource, self.resource);
            Ok((self.bytes.len() / PAGE as usize) as u32)
        }
        fn group_memory_grow(&mut self, resource: u64, pages: u32) -> Result<u32, Errno> {
            let old = self.group_memory_pages(resource)?;
            if pages > self.maximum - old {
                return Err(Errno::ENOMEM);
            }
            self.bytes.resize((old + pages) as usize * PAGE as usize, 0);
            Ok(old)
        }
        fn group_memory_read(
            &self,
            resource: u64,
            address: u32,
            output: &mut [u8],
        ) -> Result<(), Errno> {
            assert_eq!(resource, self.resource);
            let bytes = self
                .bytes
                .get(address as usize..address as usize + output.len())
                .ok_or(Errno::EFAULT)?;
            output.copy_from_slice(bytes);
            Ok(())
        }
        fn group_memory_write(
            &mut self,
            resource: u64,
            address: u32,
            input: &[u8],
        ) -> Result<(), Errno> {
            assert_eq!(resource, self.resource);
            let bytes = self
                .bytes
                .get_mut(address as usize..address as usize + input.len())
                .ok_or(Errno::EFAULT)?;
            bytes.copy_from_slice(input);
            Ok(())
        }
        fn group_memory_fill(
            &mut self,
            resource: u64,
            address: u32,
            length: u32,
            byte: u8,
        ) -> Result<(), Errno> {
            assert_eq!(resource, self.resource);
            self.bytes
                .get_mut(address as usize..address as usize + length as usize)
                .ok_or(Errno::EFAULT)?
                .fill(byte);
            Ok(())
        }
        fn group_memory_copy(
            &mut self,
            resource: u64,
            destination: u32,
            source: u32,
            length: u32,
        ) -> Result<(), Errno> {
            assert_eq!(resource, self.resource);
            self.bytes.copy_within(
                source as usize..(u64::from(source) + u64::from(length)) as usize,
                destination as usize,
            );
            Ok(())
        }
        fn group_memory_atomic_load(&self, resource: u64, address: u32) -> Result<u32, Errno> {
            let mut bytes = [0; 4];
            self.group_memory_read(resource, address, &mut bytes)?;
            Ok(u32::from_le_bytes(bytes))
        }
        fn group_memory_atomic_store(
            &mut self,
            resource: u64,
            address: u32,
            value: u32,
        ) -> Result<(), Errno> {
            self.group_memory_write(resource, address, &value.to_le_bytes())
        }
        fn group_memory_atomic_compare_exchange(
            &mut self,
            resource: u64,
            address: u32,
            expected: u32,
            value: u32,
        ) -> Result<u32, Errno> {
            let old = self.group_memory_atomic_load(resource, address)?;
            if old == expected {
                self.group_memory_atomic_store(resource, address, value)?;
            }
            Ok(old)
        }
        fn group_memory_atomic_notify(
            &mut self,
            resource: u64,
            _address: u32,
            _count: u32,
        ) -> Result<u32, Errno> {
            assert_eq!(resource, self.resource);
            Ok(0)
        }
    }
    fn fixture() -> (Fixture, Host, ReceiptRecord, ReceiptRecord, u32) {
        let mut f = Fixture::new();
        f.table.memory_groups().configure(2048, 1).unwrap();
        let group = f
            .table
            .memory_groups()
            .create(MemoryGroupLimits {
                maximum_pages: 2048,
                maximum_processes: 2,
                maximum_tasks: 8,
            })
            .unwrap();
        let mut host = Host {
            bytes: Vec::new(),
            resource: 0,
            maximum: 0,
        };
        f.table
            .memory_groups()
            .create_storage(group, 1, &mut host)
            .unwrap();
        let old = f.table.prepare_process_memory_group(group, f.pid).unwrap();
        let layout = Layout::artifact(&grouped(3), 2048).unwrap();
        f.table
            .memory_groups()
            .prepare_storage_image(
                old,
                ImageLayout {
                    initial_pages: layout.0[0] as u32,
                    maximum_pages: 2048,
                    scratch_bytes: 65536,
                },
                &mut host,
            )
            .unwrap();
        f.table
            .memory_group_task_action(old.record(), TaskAction::Start)
            .unwrap();
        f.table.memory_groups().publish_storage(old).unwrap();
        f.table
            .install_group_memory_layout(layout.record(old.record()))
            .unwrap();
        let target = f.target(&grouped(3));
        let prepared = f
            .table
            .begin_exec_control(old.record(), target, &mut host)
            .unwrap();
        assert_eq!(prepared.value, i64::from(P::PREPARED));
        let future = prepared.receipt;
        f.table
            .commit_exec_target(&mut host, f.pid, f.pid, target)
            .unwrap();
        (f, host, old.record(), future, target)
    }
    fn done(f: &mut Fixture, host: &mut Host, future: ReceiptRecord, effect: u32) -> Reply {
        if effect == E::BIND_REPLACEMENT {
            f.table
                .retirement_control(
                    future,
                    R::command::BIND_REFERENCES,
                    R::NATIVE_JOIN_CAPABILITY,
                    host,
                )
                .unwrap();
        }
        if matches!(effect, E::START_REPLACEMENT | E::DELIVER_LAUNCH) {
            let permission = f
                .table
                .exec_control_effect(future, C::ENTER_NATIVE, effect, host)
                .unwrap();
            assert_ne!(
                permission.flags & wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE,
                0
            );
        }
        f.table
            .exec_control_effect(future, C::PLATFORM_COMPLETED, effect, host)
            .unwrap()
    }
    fn stopped(
        f: &mut Fixture,
        host: &mut Host,
        old: ReceiptRecord,
        future: ReceiptRecord,
    ) -> Reply {
        let first = f.table.exec_control(future, C::HANDOFF, host).unwrap();
        assert_eq!(first.effect, E::DETACH_PREVIOUS);
        assert!(matches!(
            f.table.exec_control_effect(
                future,
                C::PLATFORM_COMPLETED,
                E::INSTALL_REPLACEMENT,
                host
            ),
            Err(Errno::EBUSY)
        ));
        assert_eq!(done(f, host, future, first.effect).effect, E::WAIT_WORKERS);
        assert!(matches!(
            f.table
                .exec_control_effect(future, C::PLATFORM_COMPLETED, E::WAIT_WORKERS, host),
            Err(Errno::EBUSY)
        ));
        f.table
            .memory_groups()
            .storage_action(old, Action::NoteQuiescent, 0, 0, host)
            .unwrap();
        f.table
            .memory_group_task_action(old, TaskAction::BeginRetirement)
            .unwrap();
        f.table
            .memory_group_task_action(old, TaskAction::RetireQuiescent)
            .unwrap();
        let joined = done(f, host, future, E::WAIT_WORKERS);
        assert_eq!(joined.effect, E::JOIN_PREVIOUS);
        joined
    }
    fn retire(f: &mut Fixture, host: &mut Host, old: ReceiptRecord) {
        let mut reply = f
            .table
            .retirement_control(old, R::command::BEGIN_IMAGE, 0, host)
            .unwrap();
        while reply.effect != effect::COMPLETE {
            let command = match reply.effect {
                R::DETACH_PLATFORM => R::command::PLATFORM_DETACHED,
                R::CONTAIN_WORKER => {
                    let selected = ReceiptRecord::decode(&reply.payload[..32]).unwrap();
                    let (store, admission) = f.table.memory_groups().storage_owner(selected).unwrap();
                    // This fixture models Node Workers; a sealed constructor
                    // has no native Worker to join.
                    let joined = !store.worker_absence(admission).unwrap();
                    f.table.retirement_control(selected, R::command::WORKER_CONTAINED,
                        if joined { R::WORKER_JOINED } else { 0 }, host).unwrap();
                    R::command::POLL
                }
                R::DETACH_REFERENCES => {
                    let selected = ReceiptRecord::decode(&reply.payload[..32]).unwrap();
                    f.table
                        .retirement_control(selected, R::command::REFERENCES_DETACHED, 0, host)
                        .unwrap();
                    R::command::POLL
                }
                unexpected => panic!("unexpected native retirement effect {unexpected}"),
            };
            reply = f.table.retirement_control(old, command, 0, host).unwrap();
        }
        f.table
            .retirement_control(old, R::command::ACK, 0, host)
            .unwrap();
    }
    fn installed() -> (Fixture, Host, ReceiptRecord) {
        let (mut f, mut host, old, future, _) = fixture();
        stopped(&mut f, &mut host, old, future);
        assert_eq!(
            done(&mut f, &mut host, future, E::JOIN_PREVIOUS).effect,
            E::INSTALL_REPLACEMENT
        );
        f.table
            .memory_group_task_action(future, TaskAction::Start)
            .unwrap();
        let admission = f.table.memory_groups().resolve_receipt(future).unwrap();
        f.table.memory_groups().publish_storage(admission).unwrap();
        f.table
            .exec_control(future, C::INSTALLED, &mut host)
            .unwrap();
        assert_eq!(
            done(&mut f, &mut host, future, E::INSTALL_REPLACEMENT).effect,
            E::RETIRE_PREVIOUS
        );
        retire(&mut f, &mut host, old);
        assert_eq!(
            done(&mut f, &mut host, future, E::RETIRE_PREVIOUS).effect,
            E::BIND_REPLACEMENT
        );
        assert_eq!(
            done(&mut f, &mut host, future, E::BIND_REPLACEMENT).effect,
            E::START_REPLACEMENT
        );
        (f, host, future)
    }
    #[test]
    fn installed_exec_exit_retires_exact_future_before_publishing_its_rust_status() {
        for signal in [0, 15] {
            for stage in [
                E::START_REPLACEMENT,
                E::WAIT_READY,
                E::DELIVER_LAUNCH,
                E::FINISH_HANDOFF,
            ] {
                let (mut f, mut host, future) = installed();
                if stage != E::START_REPLACEMENT {
                    done(&mut f, &mut host, future, E::START_REPLACEMENT);
                }
                if matches!(stage, E::DELIVER_LAUNCH | E::FINISH_HANDOFF) {
                    done(&mut f, &mut host, future, E::WAIT_READY);
                }
                if stage == E::FINISH_HANDOFF {
                    done(&mut f, &mut host, future, E::DELIVER_LAUNCH);
                }
                if signal == 0 {
                    assert!(f.table.get_mut(f.pid).unwrap().record_normal_exit(173));
                } else {
                    assert!(f.table.get_mut(f.pid).unwrap().record_signal_exit(signal));
                }
                let status = f.table.exec_control(future, C::STATUS, &mut host).unwrap();
                assert_ne!(status.flags & W::flags::EXIT_HELD, 0);
                let expected = if signal == 0 {
                    173
                } else {
                    128 + signal as i32
                };
                assert_eq!(
                    i32::from_le_bytes(
                        status.payload[W::EXIT_STATUS..W::EXIT_STATUS + 4]
                            .try_into()
                            .unwrap()
                    ),
                    expected
                );
                assert!(matches!(
                    f.table
                        .retirement_control(future, R::command::BEGIN_IMAGE, 0, &mut host),
                    Err(Errno::EBUSY)
                ));
                let mut reply = f.table.exec_control(future, C::POLL, &mut host).unwrap();
                if stage == E::START_REPLACEMENT {
                    assert_eq!(reply.effect, E::SEAL_REPLACEMENT);
                    assert!(matches!(
                        f.table.exec_control_effect(
                            future,
                            C::PLATFORM_COMPLETED,
                            reply.effect,
                            &mut host
                        ),
                        Err(Errno::EBUSY)
                    ));
                    f.table
                        .retirement_control(future, R::command::SEALED_ABSENCE, 0, &mut host)
                        .unwrap();
                    reply = done(&mut f, &mut host, future, reply.effect);
                } else {
                    assert_eq!(
                        status.effect,
                        if stage == E::FINISH_HANDOFF {
                            E::WAKE_REPLACEMENT
                        } else {
                            E::CANCEL_PREPARATION
                        }
                    );
                    assert_eq!(
                        reply.effect,
                        if stage == E::FINISH_HANDOFF {
                            E::WAKE_REPLACEMENT
                        } else {
                            E::WAIT_REPLACEMENT
                        }
                    );
                    if reply.effect == E::WAKE_REPLACEMENT {
                        reply = done(&mut f, &mut host, future, reply.effect);
                    }
                    assert!(matches!(
                        f.table.exec_control_effect(
                            future,
                            C::PLATFORM_COMPLETED,
                            E::WAIT_REPLACEMENT,
                            &mut host
                        ),
                        Err(Errno::EBUSY)
                    ));
                    f.table
                        .retirement_control(future, R::command::WORKER_FENCE, 0, &mut host)
                        .unwrap();
                }
                assert_eq!(reply.effect, E::WAIT_REPLACEMENT);
                assert_eq!(
                    done(&mut f, &mut host, future, reply.effect).effect,
                    E::JOIN_REPLACEMENT
                );
                assert_eq!(
                    done(&mut f, &mut host, future, E::JOIN_REPLACEMENT).effect,
                    E::RETIRE_REPLACEMENT
                );
                assert!(matches!(
                    f.table.exec_control_effect(
                        future,
                        C::PLATFORM_COMPLETED,
                        E::RETIRE_REPLACEMENT,
                        &mut host
                    ),
                    Err(Errno::EBUSY)
                ));
                retire(&mut f, &mut host, future);
                let publish = done(&mut f, &mut host, future, E::RETIRE_REPLACEMENT);
                assert_eq!(publish.effect, E::PUBLISH_TERMINATION);
                assert_eq!(
                    i32::from_le_bytes(
                        publish.payload[W::EXIT_STATUS..W::EXIT_STATUS + 4]
                            .try_into()
                            .unwrap()
                    ),
                    expected
                );
                assert_eq!(
                    done(&mut f, &mut host, future, publish.effect).value,
                    i64::from(P::FINISHED)
                );
                f.table.exec_control(future, C::ACK, &mut host).unwrap();
                let group = f.table.memory_groups().resolve_group(future.group).unwrap();
                let usage = f.table.memory_groups().snapshot(group).unwrap();
                assert_eq!((usage.tasks, usage.images, usage.processes), (0, 0, 0));
            }
        }
    }
    #[test]
    fn exec_exit_during_finish_ack_keeps_retirement_with_actual_exec_owner() {
        for signal in [0, 15] {
            let (mut f, mut host, future) = installed();
            done(&mut f, &mut host, future, E::START_REPLACEMENT);
            done(&mut f, &mut host, future, E::WAIT_READY);
            done(&mut f, &mut host, future, E::DELIVER_LAUNCH);
            let expected = if signal == 0 {
                assert!(f.table.get_mut(f.pid).unwrap().record_normal_exit(173));
                173
            } else {
                assert!(f.table.get_mut(f.pid).unwrap().record_signal_exit(signal));
                128 + signal as i32
            };
            let wake = done(&mut f, &mut host, future, E::FINISH_HANDOFF);
            assert_eq!(wake.effect, E::WAKE_REPLACEMENT);
            assert_ne!(wake.flags & W::flags::EXIT_HELD, 0);
            assert!(matches!(
                f.table.exec_control(future, C::ACK, &mut host),
                Err(Errno::EBUSY)
            ));
            assert_eq!(
                done(&mut f, &mut host, future, wake.effect).effect,
                E::WAIT_REPLACEMENT
            );
            assert!(matches!(
                f.table.exec_control_effect(
                    future,
                    C::PLATFORM_COMPLETED,
                    E::WAIT_REPLACEMENT,
                    &mut host
                ),
                Err(Errno::EBUSY)
            ));
            f.table
                .retirement_control(future, R::command::WORKER_FENCE, 0, &mut host)
                .unwrap();
            assert_eq!(
                done(&mut f, &mut host, future, E::WAIT_REPLACEMENT).effect,
                E::JOIN_REPLACEMENT
            );
            assert_eq!(
                done(&mut f, &mut host, future, E::JOIN_REPLACEMENT).effect,
                E::RETIRE_REPLACEMENT
            );
            retire(&mut f, &mut host, future);
            let publish = done(&mut f, &mut host, future, E::RETIRE_REPLACEMENT);
            assert_eq!(publish.effect, E::PUBLISH_TERMINATION);
            assert_eq!(
                i32::from_le_bytes(
                    publish.payload[W::EXIT_STATUS..W::EXIT_STATUS + 4]
                        .try_into()
                        .unwrap()
                ),
                expected
            );
            done(&mut f, &mut host, future, publish.effect);
            assert_ne!(
                f.table
                    .exec_control(future, C::STATUS, &mut host)
                    .unwrap()
                    .flags
                    & W::flags::EXIT_HELD,
                0
            );
            f.table.exec_control(future, C::ACK, &mut host).unwrap();
            assert!(matches!(
                f.table.memory_groups().storage_owner(future),
                Err(Errno::ESRCH)
            ));
        }
    }
    #[test]
    fn exec_exit_after_finish_ack_uses_normal_stop_owner() {
        for signal in [0, 15] {
            let (mut f, mut host, future) = installed();
            done(&mut f, &mut host, future, E::START_REPLACEMENT);
            done(&mut f, &mut host, future, E::WAIT_READY);
            done(&mut f, &mut host, future, E::DELIVER_LAUNCH);
            assert_eq!(
                done(&mut f, &mut host, future, E::FINISH_HANDOFF).value,
                i64::from(P::FINISHED)
            );
            let expected = if signal == 0 {
                assert!(f.table.get_mut(f.pid).unwrap().record_normal_exit(173));
                173
            } else {
                assert!(f.table.get_mut(f.pid).unwrap().record_signal_exit(signal));
                128 + signal as i32
            };
            assert_eq!(
                f.table
                    .exec_control(future, C::STATUS, &mut host)
                    .unwrap()
                    .flags
                    & W::flags::EXIT_HELD,
                0
            );
            f.table.exec_control(future, C::ACK, &mut host).unwrap();
            assert_eq!(
                f.table
                    .retirement_control(future, R::command::BEGIN_STOP, 0, &mut host)
                    .unwrap()
                    .effect,
                R::WAIT_WORKERS
            );
            assert!(matches!(
                f.table
                    .retirement_control(future, R::command::WORKERS_STOPPED, 0, &mut host),
                Err(Errno::EBUSY)
            ));
            f.table
                .retirement_control(future, R::command::WORKER_FENCE, 0, &mut host)
                .unwrap();
            let publish = f
                .table
                .retirement_control(future, R::command::WORKERS_STOPPED, 0, &mut host)
                .unwrap();
            assert_ne!(publish.flags & R::PUBLISH_EXIT, 0);
            assert_eq!(publish.value, i64::from(expected));
            f.table
                .retirement_control(future, R::command::ACK_STOP, 0, &mut host)
                .unwrap();
            retire(&mut f, &mut host, future);
            let group = f.table.memory_groups().resolve_group(future.group).unwrap();
            let usage = f.table.memory_groups().snapshot(group).unwrap();
            assert_eq!((usage.tasks, usage.images, usage.processes), (0, 0, 0));
        }
    }
    #[test]
    fn kernel_drives_complete_exec_without_host_phase_selection() {
        let (mut f, mut host, old, future, _) = fixture();
        stopped(&mut f, &mut host, old, future);
        let install = done(&mut f, &mut host, future, E::JOIN_PREVIOUS);
        assert_eq!(install.effect, E::INSTALL_REPLACEMENT);
        assert!(matches!(
            f.table
                .exec_control_effect(future, C::PLATFORM_COMPLETED, E::JOIN_PREVIOUS, &mut host),
            Err(Errno::EBUSY)
        ));
        assert!(matches!(
            f.table.exec_control_effect(
                ReceiptRecord {
                    generation: future.generation + 1,
                    ..future
                },
                C::PLATFORM_COMPLETED,
                install.effect,
                &mut host
            ),
            Err(Errno::ESRCH)
        ));
        assert!(matches!(
            f.table
                .exec_control_effect(future, C::PLATFORM_COMPLETED, install.effect, &mut host),
            Err(Errno::EBUSY)
        ));
        f.table
            .memory_group_task_action(future, TaskAction::Start)
            .unwrap();
        let admission = f.table.memory_groups().resolve_receipt(future).unwrap();
        f.table.memory_groups().publish_storage(admission).unwrap();
        f.table
            .exec_control(future, C::INSTALLED, &mut host)
            .unwrap();
        assert_eq!(
            done(&mut f, &mut host, future, E::INSTALL_REPLACEMENT).effect,
            E::RETIRE_PREVIOUS
        );
        assert!(matches!(
            f.table.exec_control_effect(
                future,
                C::PLATFORM_COMPLETED,
                E::RETIRE_PREVIOUS,
                &mut host
            ),
            Err(Errno::EBUSY)
        ));
        retire(&mut f, &mut host, old);
        assert_eq!(
            done(&mut f, &mut host, future, E::RETIRE_PREVIOUS).effect,
            E::BIND_REPLACEMENT
        );
        assert_eq!(
            done(&mut f, &mut host, future, E::BIND_REPLACEMENT).effect,
            E::START_REPLACEMENT
        );
        f.table.get_mut(future.pid).unwrap().state = crate::process::ProcessState::Stopped;
        let held = f
            .table
            .exec_control_effect(future, C::ENTER_NATIVE, E::START_REPLACEMENT, &mut host)
            .unwrap();
        assert_eq!(held.effect, effect::YIELD);
        assert_eq!(
            held.flags & wasm_posix_shared::group_operation::flags::NATIVE_EXECUTE,
            0
        );
        assert!(matches!(
            f.table.exec_control_effect(
                future,
                C::PLATFORM_COMPLETED,
                E::START_REPLACEMENT,
                &mut host
            ),
            Err(Errno::EBUSY)
        ));
        f.table.get_mut(future.pid).unwrap().state = crate::process::ProcessState::Running;
        assert_eq!(
            done(&mut f, &mut host, future, E::START_REPLACEMENT).effect,
            E::WAIT_READY
        );
        assert_eq!(
            done(&mut f, &mut host, future, E::WAIT_READY).effect,
            E::DELIVER_LAUNCH
        );
        f.table.get_mut(future.pid).unwrap().state = crate::process::ProcessState::Stopped;
        assert_eq!(
            f.table
                .exec_control_effect(future, C::ENTER_NATIVE, E::DELIVER_LAUNCH, &mut host)
                .unwrap()
                .effect,
            effect::YIELD
        );
        assert!(matches!(
            f.table.exec_control_effect(
                future,
                C::PLATFORM_COMPLETED,
                E::DELIVER_LAUNCH,
                &mut host
            ),
            Err(Errno::EBUSY)
        ));
        f.table.get_mut(future.pid).unwrap().state = crate::process::ProcessState::Running;
        assert_eq!(
            done(&mut f, &mut host, future, E::DELIVER_LAUNCH).effect,
            E::FINISH_HANDOFF
        );
        let final_reply = done(&mut f, &mut host, future, E::FINISH_HANDOFF);
        assert_eq!(
            (final_reply.effect, final_reply.value),
            (effect::COMPLETE, i64::from(P::FINISHED))
        );
        f.table.exec_control(future, C::ACK, &mut host).unwrap();
        assert!(matches!(
            f.table.exec_control(future, C::POLL, &mut host),
            Err(Errno::ESRCH)
        ));
    }
    #[test]
    fn kernel_selects_signal_cancellation_and_publishes_after_both_images_retire() {
        let (mut f, mut host, old, future, _) = fixture();
        stopped(&mut f, &mut host, old, future);
        f.table.get_mut(f.pid).unwrap().exit_signal = 9;
        let discard = done(&mut f, &mut host, future, E::JOIN_PREVIOUS);
        assert_eq!((discard.effect, discard.length), (E::DISCARD_FUTURE, 9));
        assert!(matches!(
            f.table.memory_groups().storage_owner(future),
            Err(Errno::ESRCH)
        ));
        assert_eq!(
            done(&mut f, &mut host, future, E::DISCARD_FUTURE).effect,
            E::RETIRE_PREVIOUS
        );
        retire(&mut f, &mut host, old);
        let publish = done(&mut f, &mut host, future, E::RETIRE_PREVIOUS);
        assert_eq!(
            (publish.effect, publish.length),
            (E::PUBLISH_TERMINATION, 9)
        );
        assert_eq!(
            done(&mut f, &mut host, future, publish.effect).value,
            i64::from(P::FINISHED)
        );
        f.table.exec_control(future, C::ACK, &mut host).unwrap();
    }
    #[test]
    fn failed_platform_effect_retains_custody_and_cannot_supply_stop_or_release_proof() {
        let (mut f, mut host, old, future, _) = fixture();
        f.table.exec_control(future, C::HANDOFF, &mut host).unwrap();
        let failed = f
            .table
            .exec_control_effect(future, C::PLATFORM_FAILED, E::DETACH_PREVIOUS, &mut host)
            .unwrap();
        assert_eq!(
            (failed.effect, failed.value),
            (E::CONTAIN_FAILURE, i64::from(P::CONTAINED))
        );
        assert!(f.table.exec_control_retains_image(old));
        assert!(f.table.memory_groups().storage_owner(future).is_ok());
        assert!(matches!(
            f.table.exec_control(future, C::ACK, &mut host),
            Err(Errno::EBUSY)
        ));
        assert!(matches!(
            f.table.exec_control(future, C::CANCEL, &mut host),
            Err(Errno::EBUSY)
        ));
        assert!(matches!(
            f.table.exec_control_effect(
                future,
                C::PLATFORM_COMPLETED,
                E::DETACH_PREVIOUS,
                &mut host
            ),
            Err(Errno::EBUSY)
        ));
    }
    #[test]
    fn native_worker_facts_are_decided_by_kernel_capability_and_exact_receipt() {
        use wasm_posix_shared::retirement_control as R;
        let (mut f, mut host, old, _, _) = fixture();
        let group = f.table.memory_groups().resolve_group(old.group).unwrap();
        f.table
            .retirement_control(old, R::command::BIND_REFERENCES, 0, &mut host)
            .unwrap();
        let before = f.table.memory_groups().snapshot(group).unwrap();
        let synthetic = f
            .table
            .retirement_control(old, R::command::NATIVE_JOIN, 0, &mut host)
            .unwrap();
        assert_eq!(synthetic.flags, 0);
        assert_eq!(f.table.memory_groups().snapshot(group).unwrap(), before);
        assert!(matches!(
            f.table
                .retirement_control(old, R::command::BEGIN_REFERENCES, 0, &mut host),
            Err(Errno::EBUSY)
        ));
        let wrong = ReceiptRecord {
            generation: old.generation + 1,
            ..old
        };
        assert!(matches!(
            f.table
                .retirement_control(wrong, R::command::WORKER_FENCE, 0, &mut host),
            Err(Errno::ESRCH)
        ));
        assert_eq!(f.table.memory_groups().snapshot(group).unwrap(), before);
        let stopped = f
            .table
            .retirement_control(old, R::command::WORKER_FENCE, 0, &mut host)
            .unwrap();
        assert_eq!(stopped.flags, R::STOP_ACCEPTED);
        assert_eq!(
            f.table.memory_groups().snapshot(group).unwrap().tasks,
            before.tasks - 1
        );
        assert_eq!(
            f.table
                .retirement_control(old, R::command::WORKER_FENCE, 0, &mut host)
                .unwrap()
                .flags,
            R::STOP_ACCEPTED
        );
        assert_eq!(
            f.table.memory_groups().snapshot(group).unwrap().tasks,
            before.tasks - 1
        );
    }
    #[test]
    fn native_join_retires_quarantined_execution_but_still_owes_reference_detachment() {
        use wasm_posix_shared::retirement_control as R;
        let (mut f, mut host, old, _, _) = fixture();
        f.table
            .retirement_control(
                old,
                R::command::BIND_REFERENCES,
                R::NATIVE_JOIN_CAPABILITY,
                &mut host,
            )
            .unwrap();
        f.table
            .memory_group_task_action(old, TaskAction::BeginRetirement)
            .unwrap();
        f.table
            .memory_group_task_action(old, TaskAction::Quarantine)
            .unwrap();
        f.table
            .memory_groups()
            .storage_action(old, Action::ContainImage, 0, 0, &mut host)
            .unwrap();
        assert_eq!(
            f.table
                .retirement_control(old, R::command::NATIVE_JOIN, 0, &mut host)
                .unwrap()
                .flags,
            R::STOP_ACCEPTED
        );
        let (store, admission) = f.table.memory_groups().storage_owner(old).unwrap();
        assert_eq!(
            store.pending_platform_references(admission, true).unwrap(),
            Some(old)
        );
        assert!(store.begin_reference_detachment(admission).unwrap());
        assert!(!store.worker_absence(admission).unwrap());
    }
    #[test]
    fn sealed_absence_is_retained_as_a_distinct_kernel_fact() {
        use wasm_posix_shared::retirement_control as R;
        let (mut f, mut host, old, _, _) = fixture();
        f.table
            .retirement_control(old, R::command::BIND_REFERENCES, 0, &mut host)
            .unwrap();
        assert_eq!(
            f.table
                .retirement_control(old, R::command::SEALED_ABSENCE, 0, &mut host)
                .unwrap()
                .flags,
            R::STOP_ACCEPTED
        );
        let (store, admission) = f.table.memory_groups().storage_owner(old).unwrap();
        assert!(store.worker_absence(admission).unwrap());
        assert!(store.accepted_worker_fact(admission).unwrap());
    }
}
