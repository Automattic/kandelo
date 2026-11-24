//! ProcessTable-owned continuation driver for grouped execution.
//! Host callbacks carry platform effects and observations, never VM phases.
mod clone;
mod fork_launch;
mod layout;
mod thread_launch;
use crate::{
    group_memory_change::Description,
    io_buffer::IO_MEMORY,
    memory_group::{physical::HostMemory, storage::ProgressTarget, StorageReply},
    prepared_map::{MapMemory, PreparedMap, PreparedMapSlot},
    process::HostIO,
    process_table::ProcessTable,
};
use wasm_posix_shared::{
    group_operation::{self as W, effect, flags, kind, Reply, Request},
    group_storage::mapping as M,
    memory_group::ReceiptRecord,
    Errno, Syscall,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    group: u32,
    token: u64,
}
impl MapMemory for Key {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Queued,
    Barrier,
    Prepare,
    Stage,
    Populate,
    Commit,
    Cancel,
    ThreadPrepare,
    ThreadBinding,
    ThreadLaunch,
    ThreadDetach,
    ThreadExit,
    ThreadControls,
    ForkAllocate,
    ForkCopy,
    ForkLaunch,
    ForkCancel,
    ForkRetireTransport,
    ForkRemoveTransport,
    ForkRemoveKernel,
    ForkComplete,
    Done,
}
struct Operation {
    receipt: ReceiptRecord,
    token: u64,
    request: Request,
    phase: Phase,
    epoch: Option<u32>,
    description: Option<Description>,
    old_break: Option<u64>,
    packet: [u8; W::PAYLOAD_BYTES],
    driver: u32,
    transaction: u64,
    failure: Option<Errno>,
    value: i64,
    length: u32,
    deliver: bool,
    owned_packet: bool,
    child: Option<ReceiptRecord>,
    execution: Option<crate::memory_group::ReplicaDescriptor>,
    thread_retired: bool,
    launch: Option<fork_launch::Launch>,
    thread_layout: Option<W::layout::Thread>,
    fork_layout: Option<W::layout::Fork>,
    thread_binding_entered: bool,
    clone_task: Option<clone::Task>,
    thread_launch: Option<thread_launch::Launch>,
}
impl MapMemory for Operation {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
pub(crate) struct Operations {
    entries: PreparedMap<Key, Operation>,
}
impl Operations {
    pub(crate) const fn new() -> Self {
        Self {
            entries: PreparedMap::new(),
        }
    }
}

impl ProcessTable {
    pub fn begin_group_operation(
        &mut self,
        receipt: ReceiptRecord,
        input: &[u8],
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let mut request = Request::decode(input)?;
        match request.kind {
            kind::MAPPING
                if matches!(request.syscall,
                n if n == Syscall::Mmap as u32 || n == Syscall::Munmap as u32
                    || n == Syscall::Mprotect as u32 || n == Syscall::Mremap as u32 || n == Syscall::Brk as u32) =>
                {}
            kind::CLONE
                if request.syscall == wasm_posix_shared::abi::extended_syscalls::SYS_CLONE => {}
            kind::FORK if request.syscall == wasm_posix_shared::abi::host_intercepted::SYS_FORK => {
            }
            kind::OWNED_MAPPING if request.syscall == Syscall::Ioctl as u32 => {}
            _ => return Err(Errno::EINVAL),
        }
        if self.running_group_memory_caller(receipt.pid, receipt.tid)? != receipt {
            return Err(Errno::ESRCH);
        }
        // Normalize the wire's signed argument extension in Rust, before VM validation.
        if request.syscall == Syscall::Mmap as u32 || request.syscall == Syscall::Mprotect as u32 {
            request.args[2] = u64::from(request.args[2] as u32);
        }
        if request.syscall == Syscall::Mmap as u32 || request.syscall == Syscall::Mremap as u32 {
            request.args[3] = u64::from(request.args[3] as u32);
        }
        let child = None;
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let mut packet = [0; W::PAYLOAD_BYTES];
        if request.kind == kind::OWNED_MAPPING {
            packet.copy_from_slice(&input[64..]);
        }
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        let token = store.begin_image_operation(admission)?;
        let operation = Operation {
            receipt,
            token,
            request,
            phase: Phase::Queued,
            epoch: None,
            description: None,
            old_break: None,
            packet,
            driver: 0,
            transaction: 0,
            failure: None,
            value: 0,
            length: 0,
            deliver: true,
            owned_packet: false,
            child,
            execution: None,
            thread_retired: false,
            launch: None,
            thread_layout: None,
            fork_layout: None,
            thread_binding_entered: false,
            clone_task: None,
            thread_launch: None,
        };
        let entry = match slot.finish(
            Key {
                group: receipt.group,
                token,
            },
            operation,
        ) {
            Ok(entry) => entry,
            Err(error) => {
                store.finish_image_operation(admission, token)?;
                return Err(error);
            }
        };
        self.group_operations().entries.publish_io(entry);
        match self.poll_group_operation(receipt, token, None, host) {
            Ok(reply) => Ok(reply),
            Err(error) => {
                panic!("retained group operation failed for {receipt:?}/{token}: {error:?}")
            }
        }
    }

    /// A prepared map node retains its I/O reservation across driving. The
    /// storage queue entry stays live even while this continuation is borrowed.
    pub fn poll_group_operation(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        cancel: Option<u32>,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let key = Key {
            group: receipt.group,
            token,
        };
        if self
            .group_operations()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?
            .receipt
            != receipt
        {
            return Err(Errno::ESRCH);
        }
        let mut entry = self
            .group_operations()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let operation = entry.value_mut();
        if let Some(reason) = cancel {
            operation.deliver &= reason & W::TRANSPORT_GONE == 0;
            // ForkComplete has already transferred or removed the child.
            // Late parent cancellation can suppress delivery, never undo it.
            if !matches!(operation.phase, Phase::Done | Phase::ForkComplete)
                || kind::is_thread(operation.request.kind) && !operation.thread_retired
            {
                let committed = operation
                    .launch
                    .as_ref()
                    .is_some_and(|launch| launch.committed())
                    || operation
                        .thread_launch
                        .as_ref()
                        .is_some_and(|launch| launch.committed());
                if !committed {
                    operation.failure.get_or_insert(
                        Errno::from_u32(reason & !W::TRANSPORT_GONE).unwrap_or(Errno::EIO),
                    );
                    if operation.phase == Phase::ThreadLaunch {
                        operation.thread_launch.as_mut().ok_or(Errno::EIO)?.cancel();
                    } else if operation.phase == Phase::ForkLaunch
                        && operation
                            .launch
                            .as_ref()
                            .is_some_and(|launch| !launch.failed() && !launch.untouched())
                    {
                        operation.launch.as_mut().unwrap().cancel();
                    } else {
                        operation.phase = Self::group_operation_cancellation_phase(operation);
                    }
                }
            }
        }
        let result = self.advance_group_operation(operation, host);
        self.group_operations().entries.publish_io(entry);
        result
    }

    pub fn report_group_thread_binding(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        detached: bool,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let key = Key {
            group: receipt.group,
            token,
        };
        let operation = self
            .group_operations()
            .entries
            .get_mut(&key)
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt || !kind::is_thread(operation.request.kind) {
            return Err(Errno::ESRCH);
        }
        match (detached, operation.phase) {
            (true, Phase::ThreadDetach) => operation.phase = Phase::ThreadExit,
            (false, Phase::ThreadBinding) => {
                if !operation.thread_binding_entered {
                    return Err(Errno::EBUSY);
                }
                let child = operation.child.ok_or(Errno::EIO)?;
                let groups = self.memory_groups();
                let admission = groups.resolve_receipt(child)?;
                groups.start(admission)?;
                let descriptor = groups.publish_storage(admission)?;
                let operation = self.group_operations().entries.get_mut(&key).unwrap();
                operation.execution = Some(descriptor);
                operation.thread_launch = Some(thread_launch::Launch::new());
                operation.phase = Phase::ThreadLaunch;
            }
            _ => return Err(Errno::EBUSY),
        }
        self.poll_group_operation(receipt, token, None, host)
    }

    pub fn group_operation_thread_exit_target(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<ReceiptRecord, Errno> {
        let operation = self
            .group_operations()
            .entries
            .get(&Key {
                group: receipt.group,
                token,
            })
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt || operation.phase != Phase::ThreadExit {
            return Err(Errno::ESRCH);
        }
        operation.child.ok_or(Errno::EIO)
    }
    /// Failed clone construction never ran a child and must not simulate the
    /// guest exit side effect of clearing an unrelated child-TID word.
    pub fn group_operation_thread_exit_clears_child_tid(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<bool, Errno> {
        self.group_operation_thread_exit_target(receipt, token)?;
        Ok(self
            .group_operations()
            .entries
            .get(&Key {
                group: receipt.group,
                token,
            })
            .ok_or(Errno::ESRCH)?
            .request
            .kind
            != kind::CLONE)
    }

    pub fn finish_group_operation_thread_exit(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<(), Errno> {
        self.group_operation_thread_exit_target(receipt, token)?;
        self.group_operations()
            .entries
            .get_mut(&Key {
                group: receipt.group,
                token,
            })
            .unwrap()
            .phase = Phase::ThreadControls;
        Ok(())
    }

    pub fn group_operation_fork_create_input(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<u32, Errno> {
        let operation = self
            .group_operations()
            .entries
            .get(&Key {
                group: receipt.group,
                token,
            })
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt || operation.phase != Phase::ForkAllocate {
            return Err(Errno::ESRCH);
        }
        u32::try_from(operation.value).map_err(|_| Errno::EIO)
    }

    pub fn finish_group_operation_fork_create(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        result: Result<u32, Errno>,
    ) -> Result<(), Errno> {
        self.group_operation_fork_create_input(receipt, token)?;
        let child = match result {
            Ok(pid) => {
                let process = self.get_mut(pid).ok_or(Errno::ESRCH)?;
                process.fork_child = false;
                let generation = process.exec_generation;
                Some(
                    self.memory_group_prepared_admission(crate::memory_group::GroupExecution {
                        pid,
                        tid: pid,
                        exec_generation: generation,
                    })?
                    .record(),
                )
            }
            Err(_) => None,
        };
        let operation = self
            .group_operations()
            .entries
            .get_mut(&Key {
                group: receipt.group,
                token,
            })
            .unwrap();
        operation.child = child;
        match result {
            Ok(_) => operation.phase = Phase::ForkCopy,
            Err(error) => {
                operation.failure = Some(error);
                operation.phase = Phase::ForkCancel;
            }
        }
        Ok(())
    }

    pub fn group_operation_fork_remove_target(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<ReceiptRecord, Errno> {
        let operation = self
            .group_operations()
            .entries
            .get(&Key {
                group: receipt.group,
                token,
            })
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt || operation.phase != Phase::ForkRemoveKernel {
            return Err(Errno::ESRCH);
        }
        operation.child.ok_or(Errno::EIO)
    }

    pub fn finish_group_operation_fork_remove(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        self.group_operation_fork_remove_target(receipt, token)?;
        self.group_operations()
            .entries
            .get_mut(&Key {
                group: receipt.group,
                token,
            })
            .unwrap()
            .phase = Phase::ForkComplete;
        self.poll_group_operation(receipt, token, None, host)
    }

    pub fn report_group_fork_effect(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        command: u32,
        argument: u32,
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
        if operation.receipt != receipt || operation.request.kind != kind::FORK {
            return Err(Errno::ESRCH);
        }
        let child = operation.child.ok_or(Errno::EIO)?;
        let phase = operation.phase;
        if argument != 0 {
            if command != W::command::FORK_IMAGE_RETIRED
                || phase != Phase::ForkRetireTransport
                || !matches!(
                    Errno::from_u32(argument),
                    Some(Errno::EBUSY | Errno::EAGAIN)
                )
            {
                return Err(Errno::EINVAL);
            }
            let mut entry = self
                .group_operations()
                .entries
                .remove_entry(&key)
                .ok_or(Errno::ESRCH)?;
            let result = self.group_operation_wait(entry.value_mut(), ProgressTarget::Pool, host);
            self.group_operations().entries.publish_io(entry);
            return result;
        }
        let next = match (command, phase) {
            (W::command::FORK_LAUNCHED, Phase::ForkLaunch) => {
                if !operation
                    .launch
                    .as_ref()
                    .is_some_and(|launch| launch.succeeded())
                {
                    return Err(Errno::EBUSY);
                }
                let (store, admission) = self.memory_groups().storage_owner(child)?;
                if store.status(admission)? & wasm_posix_shared::group_storage::status::PREPARED
                    != 0
                {
                    return Err(Errno::EBUSY);
                }
                let (store, parent) = self.memory_groups().storage_owner(receipt)?;
                store.release_operation_child(parent, token, child)?;
                Phase::ForkComplete
            }
            (W::command::FORK_IMAGE_RETIRED, Phase::ForkRetireTransport) => {
                match self.memory_groups().storage_owner(child) {
                    Err(Errno::ESRCH) => {}
                    _ => return Err(Errno::EBUSY),
                }
                Phase::ForkRemoveTransport
            }
            (W::command::FORK_DETACHED, Phase::ForkRemoveTransport) => Phase::ForkRemoveKernel,
            _ => return Err(Errno::EBUSY),
        };
        let deliver = if next == Phase::ForkComplete {
            match self.running_group_memory_caller(receipt.pid, receipt.tid) {
                Ok(current) => current == receipt,
                Err(Errno::EAGAIN) => true,
                _ => false,
            }
        } else {
            true
        };
        let operation = self.group_operations().entries.get_mut(&key).unwrap();
        operation.phase = next;
        operation.deliver &= deliver;
        self.poll_group_operation(receipt, token, None, host)
    }

    pub fn acknowledge_group_operation(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<(), Errno> {
        let key = Key {
            group: receipt.group,
            token,
        };
        let operation = self
            .group_operations()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if operation.receipt != receipt {
            return Err(Errno::ESRCH);
        }
        if operation.phase != Phase::Done {
            return Err(Errno::EBUSY);
        }
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        store.finish_image_operation(admission, token)?;
        self.group_operations().entries.remove(&key);
        Ok(())
    }

    fn group_operation_cancellation_phase(operation: &Operation) -> Phase {
        if operation.request.kind == kind::FORK {
            return Phase::ForkCancel;
        }
        // A control mapping and pause must unwind before the child can exit.
        // Keep its admission charged through both mapping and physical cleanup.
        if operation.child.is_none() || operation.description.is_some() || operation.epoch.is_some()
        {
            Phase::Cancel
        } else if operation.execution.is_some() {
            Phase::ThreadDetach
        } else {
            Phase::ThreadExit
        }
    }

    fn group_operation_reply(operation: &Operation, effect: u32) -> Reply {
        let mut reply = Reply::new(operation.receipt, operation.token, effect);
        if !operation.deliver {
            reply.flags &= !flags::DELIVER;
        }
        if operation.thread_retired {
            reply.flags |= flags::THREAD_RETIRED;
        }
        if operation.failure.is_none()
            && matches!(
                operation.phase,
                Phase::ThreadBinding | Phase::ThreadLaunch | Phase::Done
            )
        {
            if let Some(descriptor) = operation.execution {
                reply.flags |= flags::THREAD_EXECUTION;
                StorageReply {
                    descriptor: Some(descriptor),
                    value: 0,
                    wait: None,
                }
                .encode(&mut reply.storage)
                .expect("kernel-owned execution descriptor");
            }
        }
        if operation.request.kind == kind::CLONE {
            if let Some(child) = operation.child {
                let offset = W::layout::THREAD_RECEIPT_OFFSET;
                child
                    .encode(&mut reply.payload[offset..offset + 32])
                    .expect("kernel-allocated clone receipt");
                reply.payload_bytes = W::PAYLOAD_BYTES as u32;
            }
        }
        reply.value = operation.value;
        reply.length = operation.length;
        if let Some(layout) = operation.thread_layout {
            layout.encode(&mut reply.payload);
            reply.payload_bytes = W::PAYLOAD_BYTES as u32;
        }
        if let Some(error) = operation.failure {
            reply.errno = error as u32;
            if operation.request.syscall == Syscall::Brk as u32
                && error == Errno::ENOMEM
                && operation.old_break.is_some()
            {
                reply.value = operation.old_break.unwrap() as i64;
                reply.errno = 0;
            } else {
                reply.value = -1;
            }
        }
        if operation.request.kind == kind::FORK {
            if let Some(layout) = operation.fork_layout {
                layout.encode(&mut reply.payload);
            }
            if let Some(child) = operation.child {
                child
                    .encode(&mut reply.payload[..32])
                    .expect("kernel-owned child receipt");
                reply.payload_bytes = W::PAYLOAD_BYTES as u32;
            }
            if let Some(descriptor) = operation.execution {
                StorageReply {
                    descriptor: Some(descriptor),
                    value: 0,
                    wait: None,
                }
                .encode(&mut reply.storage)
                .expect("kernel-owned fork storage");
            }
        }
        if operation.owned_packet {
            reply.flags |= flags::OWNED_PACKET;
            reply.payload_bytes = W::PAYLOAD_BYTES as u32;
            reply.payload = operation.packet;
        }
        reply
    }

    fn group_operation_wait(
        &mut self,
        operation: &Operation,
        target: ProgressTarget,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        let (store, _) = self.memory_groups().storage_owner(operation.receipt)?;
        // Retry observers can outlive the requesting pthread. Pin under the
        // image's root custody, which cannot retire before these waits settle.
        let admission = store.root_for_image(operation.receipt)?;
        let memory = HostMemory {
            resource: store.resource(),
            host,
        };
        let wait = store.prepare_progress(&memory, admission, target)?;
        let mut reply = Self::group_operation_reply(
            operation,
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
                admission.record(),
                store.resource(),
                wait,
                &mut reply.storage,
            )?;
        }
        Ok(reply)
    }

    fn release_group_operation_child(&mut self, operation: &Operation) -> Result<(), Errno> {
        let child = operation.child.ok_or(Errno::EIO)?;
        let (store, parent) = self.memory_groups().storage_owner(operation.receipt)?;
        store.release_operation_child(parent, operation.token, child)
    }

    fn resume_group_operation(
        &mut self,
        operation: &mut Operation,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        if let Some(epoch) = operation.epoch {
            let (store, admission) = self.memory_groups().storage_owner(operation.receipt)?;
            match store.resume_image(
                &mut HostMemory {
                    resource: store.resource(),
                    host,
                },
                admission,
                epoch,
            ) {
                Ok(()) | Err(Errno::ESRCH) => operation.epoch = None,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn advance_group_operation(
        &mut self,
        operation: &mut Operation,
        host: &mut dyn HostIO,
    ) -> Result<Reply, Errno> {
        use crate::group_memory_change::Effect;
        let receipt = operation.receipt;
        let mut population_chunks = 0;
        for _ in 0..16 {
            if !(operation.phase == Phase::ForkLaunch
                && operation
                    .launch
                    .as_ref()
                    .is_some_and(|launch| !launch.failed() && !launch.untouched()))
                && !matches!(
                    operation.phase,
                    Phase::Cancel
                        | Phase::ThreadLaunch
                        | Phase::ThreadDetach
                        | Phase::ThreadExit
                        | Phase::ThreadControls
                        | Phase::ForkCancel
                        | Phase::ForkRetireTransport
                        | Phase::ForkRemoveTransport
                        | Phase::ForkRemoveKernel
                        | Phase::ForkComplete
                        | Phase::Done
                )
            {
                let (store, admission) = self.memory_groups().storage_owner(receipt)?;
                let status = store.status(admission)?;
                use wasm_posix_shared::group_storage::status as S;
                if status & (S::STOPPING | S::STOPPED) != 0 || status & S::SOURCE_LIVE == 0 {
                    operation.failure = Some(Errno::ESRCH);
                    operation.deliver = false;
                    operation.phase = Self::group_operation_cancellation_phase(operation);
                }
            }
            if !(operation.phase == Phase::ForkLaunch
                && operation
                    .launch
                    .as_ref()
                    .is_some_and(|launch| !launch.failed() && !launch.untouched()))
                && !matches!(
                    operation.phase,
                    Phase::Cancel
                        | Phase::ThreadLaunch
                        | Phase::ThreadDetach
                        | Phase::ThreadExit
                        | Phase::ThreadControls
                        | Phase::ForkCancel
                        | Phase::ForkRetireTransport
                        | Phase::ForkRemoveTransport
                        | Phase::ForkRemoveKernel
                        | Phase::ForkComplete
                        | Phase::Done
                )
            {
                match self.running_group_memory_caller(receipt.pid, receipt.tid) {
                    Ok(current) if current == receipt => {}
                    Err(Errno::EAGAIN) => {
                        let mut reply = Self::group_operation_reply(operation, effect::YIELD);
                        reply.delay = 10;
                        return Ok(reply);
                    }
                    _ => {
                        operation.failure = Some(Errno::ESRCH);
                        operation.deliver = false;
                        operation.phase = Self::group_operation_cancellation_phase(operation);
                    }
                }
            }
            match operation.phase {
                Phase::Queued => {
                    let (store, admission) = self.memory_groups().storage_owner(receipt)?;
                    if let Some(blocker) =
                        store.blocking_image_operation(admission, operation.token)?
                    {
                        let mut reply =
                            Self::group_operation_reply(operation, effect::WAIT_OPERATION);
                        reply.wait_token = blocker;
                        return Ok(reply);
                    }
                    if operation.request.kind == kind::CLONE && operation.child.is_none() {
                        if let Err(error) = self.allocate_group_clone(operation, host) {
                            operation.failure = Some(error);
                            operation.phase = Phase::Cancel;
                            continue;
                        }
                    }
                    let (store, admission) = self.memory_groups().storage_owner(receipt)?;
                    let epoch = store.begin_operation_pause(
                        &mut HostMemory {
                            resource: store.resource(),
                            host,
                        },
                        admission,
                        operation.token,
                    );
                    match epoch {
                        Ok(epoch) => {
                            operation.epoch = Some(epoch);
                            operation.phase = Phase::Barrier;
                        }
                        Err(Errno::EBUSY) | Err(Errno::EAGAIN) => {
                            let mut reply = Self::group_operation_reply(operation, effect::YIELD);
                            reply.delay = 1;
                            return Ok(reply);
                        }
                        Err(error) => {
                            operation.failure = Some(error);
                            operation.phase = Phase::Cancel;
                        }
                    }
                }
                Phase::ThreadPrepare => {
                    let admission = self.memory_group_prepared_admission(
                        crate::memory_group::GroupExecution {
                            pid: receipt.pid,
                            tid: operation.child.ok_or(Errno::EIO)?.tid,
                            exec_generation: receipt.generation,
                        },
                    )?;
                    if admission.group().as_raw() != receipt.group {
                        return Err(Errno::ESRCH);
                    }
                    let child = admission.record();
                    operation.child = Some(child);
                    let prepared = self.prepare_group_storage_thread(child, host);
                    match prepared {
                        Ok(descriptor) => {
                            let (address, length) = self
                                .get(receipt.pid)
                                .ok_or(Errno::ESRCH)?
                                .memory
                                .group_thread_control_interval(child)?;
                            operation.value = address as i64;
                            operation.length = length as u32;
                            operation.execution = Some(descriptor);
                            match self.group_thread_launch_layout(
                                receipt,
                                child,
                                address as u32,
                                length as u32,
                                operation.clone_task.as_ref().ok_or(Errno::EIO)?.entry,
                            ) {
                                Ok(layout) => {
                                    operation.thread_layout = Some(layout);
                                    operation.phase = Phase::ThreadBinding;
                                }
                                Err(error) => {
                                    operation.failure = Some(error);
                                    operation.phase = Phase::ThreadDetach;
                                }
                            }
                        }
                        Err(Errno::EAGAIN) => {
                            return self.group_operation_wait(
                                operation,
                                ProgressTarget::Pool,
                                host,
                            );
                        }
                        Err(error) => {
                            operation.failure = Some(error);
                            operation.phase = Phase::ThreadExit;
                        }
                    }
                }
                Phase::ThreadBinding => {
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::PREPARE_THREAD_BINDING,
                    ));
                }
                Phase::ThreadLaunch => {
                    let launch = operation.thread_launch.as_ref().ok_or(Errno::EIO)?;
                    if launch.succeeded() {
                        // Native handoff and its parent-result entry are
                        // separate turns. The child is already committed;
                        // revalidate only publication, never undo creation.
                        if self.group_clone_parent_stopping(receipt) {
                            operation.deliver = false;
                        }
                        match self.running_group_memory_caller(receipt.pid, receipt.tid) {
                            Ok(current) if current == receipt => {}
                            Err(Errno::EAGAIN) if operation.deliver => {
                                let mut reply =
                                    Self::group_operation_reply(operation, effect::YIELD);
                                reply.delay = 10;
                                return Ok(reply);
                            }
                            _ => operation.deliver = false,
                        }
                        operation.value = i64::from(operation.child.ok_or(Errno::EIO)?.tid);
                        operation.phase = Phase::Done;
                        continue;
                    }
                    if launch.failed() {
                        operation.phase = Phase::ThreadDetach;
                        continue;
                    }
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::THREAD_LAUNCH,
                    ));
                }
                Phase::ThreadDetach => {
                    self.restore_group_clone_parent_tid(operation, host)?;
                    self.begin_group_thread_cleanup(operation.child.ok_or(Errno::EIO)?)?;
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::DETACH_THREAD_BINDING,
                    ));
                }
                Phase::ThreadExit => {
                    self.restore_group_clone_parent_tid(operation, host)?;
                    let child = operation.child.ok_or(Errno::EIO)?;
                    self.begin_group_thread_cleanup(child)?;
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::KERNEL_THREAD_EXIT,
                    ));
                }
                Phase::ThreadControls => {
                    let child = operation.child.ok_or(Errno::EIO)?;
                    let release = if self.memory_groups().resolve_receipt(child).is_ok() {
                        self.release_unstarted_group_thread(child, host)
                    } else {
                        self.release_group_storage_control(child, host)
                    };
                    match release {
                        Ok(()) => {
                            operation.thread_retired = true;
                            operation.execution = None;
                            operation.phase = Phase::Done;
                        }
                        Err(Errno::EAGAIN) | Err(Errno::EBUSY) => {
                            return self.group_operation_wait(
                                operation,
                                ProgressTarget::Pool,
                                host,
                            );
                        }
                        Err(error) => return Err(error),
                    }
                }
                Phase::ForkAllocate => {
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::KERNEL_FORK_CREATE,
                    ));
                }
                Phase::ForkCopy => {
                    let child = operation.child.ok_or(Errno::EIO)?;
                    match self.memory_groups().prepare_storage_fork(
                        receipt,
                        child,
                        operation.epoch.ok_or(Errno::EIO)?,
                        host,
                    ) {
                        Ok(descriptor) => {
                            let (store, parent) = self.memory_groups().storage_owner(receipt)?;
                            let child_admission = store.resolve(child)?;
                            store.hold_operation_child(parent, operation.token, child_admission)?;
                            operation.execution = Some(descriptor);
                            operation.value = i64::from(child.pid);
                            let initialized = (|| {
                                let layout = self.group_fork_launch_layout(receipt, host)?;
                                let channel = layout.0[6];
                                self.install_group_fork_entry(child, layout)?;
                                operation.fork_layout = Some(layout);
                                let (store, admission) =
                                    self.memory_groups().storage_owner(child)?;
                                store.initialize_fork_channel(
                                    &mut HostMemory {
                                        resource: store.resource(),
                                        host,
                                    },
                                    admission,
                                    channel,
                                )
                            })();
                            if let Err(error) = initialized {
                                operation.failure = Some(error);
                                operation.phase = Phase::ForkCancel;
                                continue;
                            }
                            operation.launch = Some(fork_launch::Launch::new());
                            operation.phase = Phase::ForkLaunch;
                        }
                        Err(Errno::EAGAIN) => {
                            return self.group_operation_wait(
                                operation,
                                ProgressTarget::Pool,
                                host,
                            );
                        }
                        Err(error) => {
                            operation.failure = Some(error);
                            operation.phase = Phase::ForkCancel;
                        }
                    }
                }
                Phase::ForkLaunch => {
                    return Ok(Self::group_operation_reply(operation, effect::FORK_LAUNCH));
                }
                Phase::ForkCancel => {
                    let Some(child) = operation.child else {
                        operation.phase = Phase::ForkComplete;
                        continue;
                    };
                    let state = self
                        .memory_groups()
                        .storage_owner(child)
                        .and_then(|(store, admission)| store.status(admission));
                    use wasm_posix_shared::group_storage::status as S;
                    match state {
                        Ok(status) if status & S::PREPARED != 0 => {
                            self.release_group_operation_child(operation)?;
                            let admission = self.memory_groups().resolve_receipt(child)?;
                            match self
                                .memory_groups()
                                .cancel_unconstructed_with_storage(admission, host)
                            {
                                Ok(()) => {}
                                Err(Errno::EAGAIN) => {
                                    return self.group_operation_wait(
                                        operation,
                                        ProgressTarget::Pool,
                                        host,
                                    );
                                }
                                Err(error) => return Err(error),
                            }
                        }
                        Ok(status) if status & S::IMAGE_STOPPED != 0 => {
                            self.release_group_operation_child(operation)?;
                            operation.phase = Phase::ForkRetireTransport;
                            continue;
                        }
                        Ok(_) => {
                            // No Worker stop proof: retain all charges and poison
                            // this kernel, rather than inventing a failed fork.
                            let (store, admission) = self.memory_groups().storage_owner(child)?;
                            let resource = store.resource();
                            let _ = store
                                .quarantine_image(&mut HostMemory { resource, host }, admission);
                            return Err(Errno::EBUSY);
                        }
                        Err(Errno::ESRCH) => {
                            self.release_group_operation_child(operation)?;
                            // Preparation can fail before physical storage exists.
                            if let Ok(admission) = self.memory_groups().resolve_receipt(child) {
                                self.memory_groups()
                                    .cancel_unconstructed_with_storage(admission, host)?;
                            }
                        }
                        Err(error) => return Err(error),
                    }
                    match self
                        .memory_groups()
                        .retire_image(child.pid, child.generation)
                    {
                        Ok(()) | Err(Errno::ENOENT) => {}
                        Err(error) => return Err(error),
                    }
                    operation.phase = Phase::ForkRemoveTransport;
                }
                Phase::ForkRetireTransport => {
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::FORK_RETIRE_TRANSPORT,
                    ));
                }
                Phase::ForkRemoveTransport => {
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::FORK_REMOVE_TRANSPORT,
                    ));
                }
                Phase::ForkRemoveKernel => {
                    return Ok(Self::group_operation_reply(
                        operation,
                        effect::KERNEL_FORK_REMOVE,
                    ));
                }
                Phase::ForkComplete => match self.resume_group_operation(operation, host) {
                    Ok(()) => operation.phase = Phase::Done,
                    Err(Errno::EAGAIN) => {
                        return self.group_operation_wait(
                            operation,
                            operation
                                .epoch
                                .map(ProgressTarget::Locks)
                                .unwrap_or(ProgressTarget::Pool),
                            host,
                        );
                    }
                    Err(error) => return Err(error),
                },
                Phase::Barrier => {
                    let epoch = operation.epoch.ok_or(Errno::EIO)?;
                    let (store, admission) = self.memory_groups().storage_owner(receipt)?;
                    let ready = store.image_pause_acknowledged(
                        &mut HostMemory {
                            resource: store.resource(),
                            host,
                        },
                        admission,
                        epoch,
                    )?;
                    if !ready {
                        return self.group_operation_wait(
                            operation,
                            ProgressTarget::Barrier(epoch),
                            host,
                        );
                    }
                    operation.phase = Phase::Prepare;
                }
                Phase::Prepare => {
                    let epoch = operation.epoch.ok_or(Errno::EIO)?;
                    let (store, admission) = self.memory_groups().storage_owner(receipt)?;
                    let mut memory = HostMemory {
                        resource: store.resource(),
                        host,
                    };
                    let extent = match store.paused_extent(&mut memory, admission, epoch) {
                        Ok(extent) => extent,
                        Err(Errno::EAGAIN) => {
                            return self.group_operation_wait(
                                operation,
                                ProgressTarget::Locks(epoch),
                                host,
                            );
                        }
                        Err(error) => return Err(error),
                    };
                    match store.reclaim_removed_pages(&mut memory, admission) {
                        Ok(_) => {}
                        Err(Errno::EAGAIN) => {
                            return self.group_operation_wait(
                                operation,
                                ProgressTarget::Locks(epoch),
                                host,
                            );
                        }
                        Err(error) => return Err(error),
                    }
                    store.sweep_objects(&mut memory)?;
                    if operation.request.kind == kind::FORK {
                        operation.value = i64::from(extent);
                        operation.phase = Phase::ForkAllocate;
                        continue;
                    }
                    if operation.request.syscall == Syscall::Brk as u32 {
                        operation.old_break =
                            Some(self.group_memory_break(receipt.pid, receipt.tid)?);
                    }
                    let prepared = match operation.request.kind {
                        kind::CLONE => {
                            match self.reuse_group_thread_control(
                                receipt.pid,
                                receipt.tid,
                                operation.child.ok_or(Errno::EIO)?.tid,
                            ) {
                                Ok(address) => {
                                    operation.value = address as i64;
                                    operation.length =
                                        wasm_posix_shared::process_memory::PAGES_PER_THREAD_SLOT
                                            * 65536;
                                    self.resume_group_operation(operation, host)?;
                                    operation.phase = Phase::ThreadPrepare;
                                    continue;
                                }
                                Err(Errno::ENOENT) => self
                                    .prepare_group_thread_control(
                                        receipt.pid,
                                        receipt.tid,
                                        operation.child.ok_or(Errno::EIO)?.tid,
                                        extent,
                                    )
                                    .map(Some),
                                Err(error) => Err(error),
                            }
                        }
                        kind::OWNED_MAPPING => {
                            let result = self.prepare_group_owned_mapping(
                                receipt.pid,
                                receipt.tid,
                                extent,
                                &mut operation.packet,
                                host,
                            );
                            operation.driver =
                                u32::from_le_bytes(operation.packet[24..28].try_into().unwrap());
                            operation.transaction =
                                u64::from_le_bytes(operation.packet[8..16].try_into().unwrap());
                            result
                        }
                        _ => self
                            .prepare_group_memory_change_with_io(
                                receipt.pid,
                                receipt.tid,
                                operation.request.syscall,
                                operation.request.args,
                                extent,
                                host,
                            )
                            .map(Some),
                    };
                    match prepared {
                        Ok(Some(description)) => {
                            operation.description = Some(description);
                            operation.phase = Phase::Stage;
                        }
                        Ok(None) => {
                            operation.owned_packet = true;
                            self.resume_group_operation(operation, host)?;
                            operation.phase = Phase::Done;
                        }
                        Err(error) => {
                            operation.failure = Some(error);
                            operation.phase = Phase::Cancel;
                        }
                    }
                }
                Phase::Stage | Phase::Populate | Phase::Commit => {
                    let description = operation.description.ok_or(Errno::EIO)?;
                    let command = match operation.phase {
                        Phase::Stage => M::STAGE,
                        Phase::Populate => M::POPULATE,
                        _ => M::COMMIT,
                    };
                    let result = self.group_storage_mapping_action(
                        receipt,
                        command,
                        description.token,
                        operation.driver,
                        operation.transaction,
                        if command == M::STAGE {
                            operation.epoch.ok_or(Errno::EIO)?
                        } else {
                            0
                        },
                        host,
                    );
                    match result {
                        Err(Errno::EAGAIN) => {
                            if operation.phase == Phase::Populate {
                                let mut reply =
                                    Self::group_operation_reply(operation, effect::YIELD);
                                reply.delay = 10;
                                return Ok(reply);
                            }
                            return self.group_operation_wait(
                                operation,
                                ProgressTarget::Locks(operation.epoch.ok_or(Errno::EIO)?),
                                host,
                            );
                        }
                        Err(error) => {
                            operation.failure = Some(error);
                            operation.phase = Phase::Cancel;
                        }
                        Ok(_) if operation.phase == Phase::Stage => {
                            operation.phase = Phase::Populate
                        }
                        Ok(0) if operation.phase == Phase::Populate => {
                            population_chunks += 1;
                            if population_chunks >= 4 {
                                return Ok(Self::group_operation_reply(operation, effect::YIELD));
                            }
                        }
                        Ok(1) if operation.phase == Phase::Populate => {
                            operation.phase = Phase::Commit
                        }
                        Ok(_) if operation.phase == Phase::Commit => {
                            operation.value = description.record().result as i64;
                            if kind::is_thread(operation.request.kind) {
                                let Effect::Map { addr, .. } = description.effect else {
                                    return Err(Errno::EIO);
                                };
                                operation.value = addr as i64;
                                operation.length = description.record().length as u32;
                            }
                            if operation.request.kind == kind::OWNED_MAPPING {
                                self.recover_group_operation_packet(operation, host)?;
                            }
                            let (store, admission) = self.memory_groups().storage_owner(receipt)?;
                            match store.reclaim_removed_pages(
                                &mut HostMemory {
                                    resource: store.resource(),
                                    host,
                                },
                                admission,
                            ) {
                                Ok(_) | Err(Errno::EAGAIN) => {}
                                Err(error) => return Err(error),
                            }
                            store.sweep_objects(&mut HostMemory {
                                resource: store.resource(),
                                host,
                            })?;
                            self.resume_group_operation(operation, host)?;
                            operation.description = None;
                            operation.phase = if kind::is_thread(operation.request.kind) {
                                Phase::ThreadPrepare
                            } else {
                                Phase::Done
                            };
                        }
                        Ok(_) => return Err(Errno::EIO),
                    }
                }
                Phase::Cancel => {
                    if let Some(description) = operation.description {
                        match self.group_storage_mapping_action(
                            receipt,
                            M::CANCEL,
                            description.token,
                            operation.driver,
                            operation.transaction,
                            operation.failure.unwrap_or(Errno::EIO) as u32,
                            host,
                        ) {
                            Ok(_) | Err(Errno::ESRCH) => operation.description = None,
                            Err(Errno::EAGAIN) => {
                                return self.group_operation_wait(
                                    operation,
                                    ProgressTarget::Pool,
                                    host,
                                );
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    self.restore_group_clone_parent_tid(operation, host)?;
                    self.resume_group_operation(operation, host)?;
                    operation.phase = if operation.child.is_some() {
                        if operation.execution.is_some() {
                            Phase::ThreadDetach
                        } else {
                            Phase::ThreadExit
                        }
                    } else {
                        Phase::Done
                    };
                }
                Phase::Done => return Ok(Self::group_operation_reply(operation, effect::COMPLETE)),
            }
        }
        Ok(Self::group_operation_reply(operation, effect::YIELD))
    }

    fn recover_group_operation_packet(
        &mut self,
        operation: &mut Operation,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let bytes = &mut operation.packet;
        bytes[4..8].copy_from_slice(&wasm_posix_shared::dri_owned::READ_LAST.to_le_bytes());
        bytes[16..24].fill(0);
        bytes[28..32].fill(0);
        bytes[32..36].copy_from_slice(&(-1i32).to_le_bytes());
        bytes[36..56].fill(0);
        bytes[64..].fill(0);
        let (proc, locks) = self
            .task_and_advisory_locks(operation.receipt.pid, operation.receipt.tid)
            .ok_or(Errno::ESRCH)?;
        crate::owned_resource::ioctl(proc, locks, host, -1, bytes)?;
        if u32::from_le_bytes(bytes[24..28].try_into().unwrap()) != operation.driver
            || u64::from_le_bytes(bytes[8..16].try_into().unwrap()) != operation.transaction
            || u32::from_le_bytes(bytes[52..56].try_into().unwrap())
                != wasm_posix_shared::dri_owned::COMPLETE
            || i32::from_le_bytes(bytes[48..52].try_into().unwrap()) != 0
        {
            return Err(Errno::EIO);
        }
        operation.owned_packet = true;
        Ok(())
    }
}

impl ProcessTable {
    pub(crate) fn group_fork_allows_image_retirement(&mut self, child: ReceiptRecord) -> bool {
        self.group_operations().entries.values().any(|operation| {
            operation.child == Some(child) && operation.phase == Phase::ForkRetireTransport
        })
    }
}
