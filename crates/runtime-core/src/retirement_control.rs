//! Actual ProcessTable authority for post-construction retirement. Platform
//! completion is a prerequisite, never inferred from process-table removal.
use crate::{
    io_buffer::IO_MEMORY,
    memory_group::{StorageReply, physical::HostMemory, storage::ProgressTarget},
    prepared_map::{MapMemory, PreparedMap, PreparedMapSlot},
    process::{HostIO, ProcessState},
    process_table::ProcessTable,
};
use wasm_posix_shared::{
    Errno,
    group_operation::{Reply, effect},
    group_storage::{Action, status as S},
    memory_group::ReceiptRecord,
    retirement_control::{self as W, command as C},
};
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Key(u32, u64);
impl MapMemory for Key {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Preparing,
    Platform,
    References,
    Release,
    Done,
}
struct Control {
    receipt: ReceiptRecord,
    image: bool,
    phase: Phase,
}
impl MapMemory for Control {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum StopPhase {
    Request,
    Workers,
    Done,
}
struct Stop {
    receipt: ReceiptRecord,
    natural_tid: u32,
    phase: StopPhase,
    publish: bool,
    parent: u32,
    status: i32,
}
impl MapMemory for Stop {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
pub(crate) struct Controls {
    entries: PreparedMap<Key, Control>,
    stops: PreparedMap<Key, Stop>,
}
impl Controls {
    pub(crate) const fn new() -> Self {
        Self {
            entries: PreparedMap::new(),
            stops: PreparedMap::new(),
        }
    }
}
impl ProcessTable {
    pub fn retirement_control_retains(&mut self, record: ReceiptRecord) -> bool {
        let controls = self.retirement_controls();
        controls
            .entries
            .get(&Key(record.group, record.serial))
            .is_some_and(|control| control.receipt == record && control.phase != Phase::Done)
            || controls
                .stops
                .get(&Key(record.group, record.serial))
                .is_some_and(|stop| stop.receipt == record)
    }
    pub fn retirement_control(
        &mut self,
        record: ReceiptRecord,
        command: u32,
        argument: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        if matches!(
            command,
            C::BEGIN_STOP | C::WORKERS_STOPPED | C::POLL_STOP | C::ACK_STOP
        ) {
            return self.group_stop_control(record, command, argument, host);
        }
        if matches!(command, C::BIND_REFERENCES | C::WORKER_CONTAINED) {
            if argument & !W::WORKER_JOINED != 0 {
                return Err(Errno::EINVAL);
            }
        } else if argument != 0 {
            return Err(Errno::EINVAL);
        }
        if matches!(
            command,
            C::WORKER_FENCE | C::NATIVE_JOIN | C::SEALED_ABSENCE
        ) {
            let accepted = self
                .memory_groups()
                .report_worker_fact(record, command, host)?;
            let mut reply = Reply::new(record, record.serial, effect::COMPLETE);
            reply.flags = if accepted { W::STOP_ACCEPTED } else { 0 };
            return Ok(reply);
        }
        let key = Key(record.group, record.serial);
        if command == C::WORKER_CONTAINED {
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            store.complete_worker_containment(admission, argument & W::WORKER_JOINED != 0)?;
            return Ok(Reply::new(record, record.serial, effect::COMPLETE));
        }
        if matches!(
            command,
            C::BIND_REFERENCES | C::BEGIN_REFERENCES | C::REFERENCES_DETACHED
        ) {
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            if command == C::BEGIN_REFERENCES && store.begin_worker_containment(admission)? {
                return Self::selected_retirement_effect(record, W::CONTAIN_WORKER, record);
            }
            let detach = match command {
                C::BIND_REFERENCES => {
                    store.bind_platform_references(
                        admission,
                        argument & W::NATIVE_JOIN_CAPABILITY != 0,
                    )?;
                    false
                }
                C::BEGIN_REFERENCES => store.begin_reference_detachment(admission)?,
                C::REFERENCES_DETACHED => {
                    store.complete_reference_detachment(admission)?;
                    false
                }
                _ => unreachable!(),
            };
            return Ok(Reply::new(
                record,
                record.serial,
                if detach {
                    W::DETACH_PLATFORM
                } else {
                    effect::COMPLETE
                },
            ));
        }
        if command == C::NOTE_WORKER_ABSENCE {
            let proc = self.get(record.pid).ok_or(Errno::ESRCH)?;
            if record.pid != record.tid || proc.exec_generation != record.generation {
                return Err(Errno::ESRCH);
            }
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            store.note_worker_absence(admission)?;
            return Ok(Reply::new(record, record.serial, effect::COMPLETE));
        }
        if command == C::PREPARE_DEACTIVATION {
            if record.pid != record.tid {
                return Err(Errno::EINVAL);
            }
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            if store.status(admission)? & S::IMAGE_STOPPED == 0 {
                return Err(Errno::EBUSY);
            }
            return self.retirement_exec_transport(record);
        }
        let beginning = matches!(command, C::BEGIN_IMAGE | C::BEGIN_THREAD);
        if beginning {
            let image = command == C::BEGIN_IMAGE;
            if image != (record.pid == record.tid) {
                return Err(Errno::EINVAL);
            }
            if self.retirement_controls().entries.get(&key).is_some() {
                return Err(Errno::EBUSY);
            }
            if !image {
                // A whole-image owner already holds this exact execution's
                // physical storage. Join its platform operation instead of
                // minting a competing pthread reclamation transaction.
                self.memory_groups().storage_owner(record)?;
                if let Some(root) = self.retirement_controls().entries.values().find(|control|
                    control.image && control.receipt.group == record.group
                        && control.receipt.pid == record.pid && control.receipt.generation == record.generation)
                    .map(|control| control.receipt) {
                    return Self::selected_retirement_effect(record, W::JOIN_IMAGE_RETIREMENT, root);
                }
            }
            if image && self.retirement_controls().stops.get(&key).is_some() {
                return Err(Errno::EBUSY);
            }
            self.validate_retirement_begin(record, image)?;
            let entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
                key,
                Control {
                    receipt: record,
                    image,
                    phase: Phase::Preparing,
                },
            )?;
            self.retirement_controls().entries.publish_io(entry);
        }
        let control = self
            .retirement_controls()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if control.receipt != record {
            return Err(Errno::ESRCH);
        }
        if command == C::ACK {
            if control.phase != Phase::Done {
                return Err(Errno::EBUSY);
            }
            self.retirement_controls().entries.remove(&key);
            return Ok(Reply::new(record, record.serial, effect::COMPLETE));
        }
        let mut entry = self
            .retirement_controls()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let result = self.advance_retirement(entry.value_mut(), command, host);
        self.retirement_controls().entries.publish_io(entry);
        if beginning {
            match result {
                Ok(reply) => Ok(reply),
                Err(error) => {
                    panic!("retained retirement continuation failed for {record:?}: {error:?}")
                }
            }
        } else {
            result
        }
    }
    fn validate_retirement_begin(
        &mut self,
        record: ReceiptRecord,
        image: bool,
    ) -> Result<(), Errno> {
        let (store, admission) = self.memory_groups().storage_owner(record)?;
        let status = store.status(admission)?;
        let absent = store.worker_absence(admission)?;
        if status & if image { S::IMAGE_STOPPED } else { S::STOPPED } == 0 {
            return Err(Errno::EBUSY);
        }
        if image {
            let exiting = self.get(record.pid).is_none_or(|proc| {
                proc.exec_generation != record.generation || proc.state == ProcessState::Exited
            });
            if !exiting && !absent && !self.group_fork_allows_image_retirement(record) {
                return Err(Errno::EBUSY);
            }
        }
        Ok(())
    }
    fn advance_retirement(
        &mut self,
        control: &mut Control,
        command: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let record = control.receipt;
        if command == C::PLATFORM_DETACHED {
            if control.phase != Phase::Platform {
                return Err(Errno::EBUSY);
            }
            control.phase = Phase::References;
        } else if !matches!(command, C::BEGIN_IMAGE | C::BEGIN_THREAD | C::POLL) {
            return Err(Errno::EINVAL);
        }
        if control.phase == Phase::Preparing {
            if control.image {
                if let Some(thread) = self.retirement_controls().entries.values().find(|other|
                    !other.image && other.receipt.group == record.group
                        && other.receipt.pid == record.pid && other.receipt.generation == record.generation)
                    .map(|other| other.receipt) {
                    return Self::selected_retirement_effect(record, W::WAIT_THREAD_RETIREMENT, thread);
                }
                let exec = self.retirement_exec_transport(record)?;
                if exec.effect != effect::COMPLETE {
                    return Ok(exec);
                }
                match self
                    .memory_groups()
                    .retire_image(record.pid, record.generation)
                {
                    Ok(()) | Err(Errno::ENOENT) => {}
                    Err(Errno::EBUSY) => return self.retirement_wait(record, host),
                    Err(error) => return Err(error),
                }
                match self
                    .memory_groups()
                    .storage_action(record, Action::RevokeSource, 0, 0, host)
                {
                    Ok(_) => {}
                    Err(Errno::EAGAIN) => return self.retirement_wait(record, host),
                    Err(error) => return Err(error),
                }
            }
            control.phase = Phase::Platform;
        }
        if control.phase == Phase::Platform {
            return Ok(Reply::new(record, record.serial, W::DETACH_PLATFORM));
        }
        if control.phase == Phase::References {
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            if let Some(selected) = store.pending_platform_references(admission, control.image)? {
                let selected_admission = store.resolve(selected)?;
                if store.begin_worker_containment(selected_admission)? {
                    return Self::selected_retirement_effect(record, W::CONTAIN_WORKER, selected);
                }
                store.begin_reference_detachment(selected_admission)?;
                let mut reply = Reply::new(record, record.serial, W::DETACH_REFERENCES);
                reply.payload_bytes = wasm_posix_shared::group_operation::PAYLOAD_BYTES as u32;
                selected.encode(&mut reply.payload[..32])?;
                return Ok(reply);
            }
            control.phase = Phase::Release;
        }
        if control.phase == Phase::Release {
            if control.image && self.exec_control_retains_image(record) {
                return self.retirement_wait(record, host);
            }
            let release = if control.image {
                self.release_group_storage_image(record, host)
                    .map(|_| ())
            } else {
                self.release_group_storage_thread(record, host)
            };
            match release {
                Ok(()) => {
                    control.phase = Phase::Done;
                    if control.image {
                        let group = self.memory_groups().resolve_group(record.group)?;
                        match self.memory_groups().sweep_storage_objects(group, host) {
                            Ok(_) | Err(Errno::EAGAIN) => {}
                            Err(error) => return Err(error),
                        }
                    }
                }
                Err(Errno::EBUSY | Errno::EAGAIN) => return self.retirement_wait(record, host),
                Err(error) => return Err(error),
            }
        }
        Ok(Reply::new(record, record.serial, effect::COMPLETE))
    }
    fn selected_retirement_effect(record: ReceiptRecord, effect: u32, selected: ReceiptRecord) -> Result<Reply, Errno> {
        let mut reply = Reply::new(record, record.serial, effect);
        reply.payload_bytes = wasm_posix_shared::group_operation::PAYLOAD_BYTES as u32;
        selected.encode(&mut reply.payload[..32])?;
        Ok(reply)
    }
    fn retirement_exec_transport(&mut self, record: ReceiptRecord) -> Result<Reply, Errno> {
        if let Some(future) = self.exec_preparation_for_retiring_image(record) {
            let mut reply = Reply::new(record, record.serial, W::CANCEL_EXEC_TRANSPORT);
            reply.payload_bytes = wasm_posix_shared::group_operation::PAYLOAD_BYTES as u32;
            future.encode(&mut reply.payload[..32])?;
            return Ok(reply);
        }
        Ok(Reply::new(record, record.serial, effect::COMPLETE))
    }
    fn retirement_wait(
        &mut self,
        record: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let (store, _) = self.memory_groups().storage_owner(record)?;
        let root = store.root_for_image(record)?;
        let wait = store.prepare_progress(
            &HostMemory {
                resource: store.resource(),
                host,
            },
            root,
            ProgressTarget::Pool,
        )?;
        let mut reply = Reply::new(
            record,
            record.serial,
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
}

impl ProcessTable {
    fn group_stop_control(
        &mut self,
        record: ReceiptRecord,
        command: u32,
        natural_tid: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let key = Key(record.group, record.serial);
        if record.pid != record.tid || command != C::BEGIN_STOP && natural_tid != 0 {
            return Err(Errno::EINVAL);
        }
        if command == C::BEGIN_STOP {
            if self.retirement_controls().stops.get(&key).is_some() {
                return Err(Errno::EBUSY);
            }
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            store.validate_natural_exit_actor(admission, natural_tid)?;
            let proc = self.get(record.pid).ok_or(Errno::ESRCH)?;
            let current = proc.exec_generation == record.generation;
            if current && proc.state != ProcessState::Exited {
                return Err(Errno::EBUSY);
            }
            // A real parent can reap after the last execution retires, before
            // the platform continuation runs. Retain the event while it exists.
            let status = if proc.exit_signal > 0 {
                128 + proc.exit_signal as i32
            } else {
                proc.exit_status
            };
            let stop = Stop {
                receipt: record,
                natural_tid,
                phase: StopPhase::Request,
                publish: current && !proc.exit_published,
                parent: proc.ppid,
                status,
            };
            let entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(key, stop)?;
            self.retirement_controls().stops.publish_io(entry);
        }
        let stop = self
            .retirement_controls()
            .stops
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if stop.receipt != record {
            return Err(Errno::ESRCH);
        }
        if command == C::ACK_STOP {
            if stop.phase != StopPhase::Done {
                return Err(Errno::EBUSY);
            }
            self.retirement_controls().stops.remove(&key);
            return Ok(Reply::new(record, record.serial, effect::COMPLETE));
        }
        let mut entry = self
            .retirement_controls()
            .stops
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let result = self.advance_group_stop(entry.value_mut(), command, host);
        self.retirement_controls().stops.publish_io(entry);
        if command == C::BEGIN_STOP {
            match result {
                Ok(reply) => Ok(reply),
                Err(error) => panic!("retained group stop failed for {record:?}: {error:?}"),
            }
        } else {
            result
        }
    }
    fn advance_group_stop(
        &mut self,
        stop: &mut Stop,
        command: u32,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let record = stop.receipt;
        if command == C::WORKERS_STOPPED {
            if stop.phase != StopPhase::Workers {
                return Err(Errno::EBUSY);
            }
            let (store, admission) = self.memory_groups().storage_owner(record)?;
            if store.status(admission)? & S::IMAGE_STOPPED == 0 {
                return Err(Errno::EBUSY);
            }
            if self
                .get(record.pid)
                .is_some_and(|proc| proc.exec_generation != record.generation)
            {
                stop.publish = false;
            }
            stop.phase = StopPhase::Done;
        }
        if stop.phase == StopPhase::Request {
            match self.memory_groups().storage_action(
                record,
                Action::StopImage,
                0,
                stop.natural_tid,
                host,
            ) {
                Ok(_) => stop.phase = StopPhase::Workers,
                Err(Errno::EAGAIN) => return self.retirement_wait(record, host),
                Err(error) => return Err(error),
            }
        }
        if stop.phase == StopPhase::Workers {
            return Ok(Reply::new(record, record.serial, W::WAIT_WORKERS));
        }
        let mut reply = Reply::new(record, record.serial, effect::COMPLETE);
        reply.flags = if stop.publish { W::PUBLISH_EXIT } else { 0 };
        reply.value = i64::from(stop.status);
        reply.length = stop.parent;
        Ok(reply)
    }
}
