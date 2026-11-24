//! Actual task/layout owners supply grouped launch recipes. The adapter only
//! binds the copied result to native Worker/channel objects.
use super::*;
use wasm_posix_shared::{group_operation::layout as L, process_memory as M};
const PAGE: u32 = M::WASM_PAGE_SIZE;

impl ProcessTable {
    /// Authorize exactly one native channel attachment for this emitted task
    /// layout. Raw/synthetic host calls cannot select another mapped mailbox.
    pub fn enter_group_thread_binding(
        &mut self,
        child: ReceiptRecord,
        token: u64,
        channel: u32,
    ) -> Result<Reply, Errno> {
        self.validate_task(child.pid, child.tid)?;
        let key = Key {
            group: child.group,
            token,
        };
        let operation = self
            .group_operations()
            .entries
            .get(&key)
            .ok_or(Errno::ESRCH)?;
        if operation.child != Some(child) || !kind::is_thread(operation.request.kind) {
            return Err(Errno::ESRCH);
        }
        if operation.phase != Phase::ThreadBinding
            || operation.thread_binding_entered
            || operation.failure.is_some()
        {
            return Err(Errno::EBUSY);
        }
        if operation.thread_layout.ok_or(Errno::EIO)?.0[5] != channel {
            return Err(Errno::EINVAL);
        }
        let parent = operation.receipt;
        self.validate_task(parent.pid, parent.tid)?;
        self.group_operations()
            .entries
            .get_mut(&key)
            .unwrap()
            .thread_binding_entered = true;
        Ok(Reply::new(child, token, effect::PREPARE_THREAD_BINDING))
    }

    pub fn report_group_thread_binding_failure(
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
        if owner.receipt != receipt || !kind::is_thread(owner.request.kind) {
            return Err(Errno::ESRCH);
        }
        if !matches!(owner.phase, Phase::ThreadBinding | Phase::Done) || owner.thread_retired {
            return Err(Errno::EBUSY);
        }
        let mut entry = self
            .group_operations()
            .entries
            .remove_entry(&key)
            .ok_or(Errno::ESRCH)?;
        let owner = entry.value_mut();
        owner
            .failure
            .get_or_insert(if no_memory { Errno::ENOMEM } else { Errno::EIO });
        owner.phase = Phase::ThreadDetach;
        let result = self.advance_group_operation(owner, host);
        self.group_operations().entries.publish_io(entry);
        result
    }

    pub(crate) fn group_task_channel(&self, receipt: ReceiptRecord) -> Result<u32, Errno> {
        let process = self.get(receipt.pid).ok_or(Errno::ESRCH)?;
        if process.exec_generation != receipt.generation {
            return Err(Errno::ESRCH);
        }
        let channel = if receipt.pid == receipt.tid {
            process.main_channel_addr
        } else {
            let (start, _) = process.memory.group_thread_control_interval(receipt)?;
            start as u64 + u64::from(M::THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * u64::from(PAGE)
        };
        u32::try_from(channel)
            .ok()
            .filter(|value| *value != 0)
            .ok_or(Errno::EFAULT)
    }

    pub(super) fn group_caller_word(
        &mut self,
        receipt: ReceiptRecord,
        address: u32,
        host: &mut dyn HostIO,
    ) -> Result<u32, Errno> {
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        store.execution_word(
            &HostMemory {
                resource: store.resource(),
                host,
            },
            admission,
            address,
        )
    }

    pub(super) fn group_thread_launch_layout(
        &mut self,
        caller: ReceiptRecord,
        child: ReceiptRecord,
        address: u32,
        length: u32,
        entry: Option<(u32, u32)>,
        host: &mut dyn HostIO,
    ) -> Result<L::Thread, Errno> {
        if length != M::PAGES_PER_THREAD_SLOT * PAGE || address % PAGE != 0 {
            return Err(Errno::EIO);
        }
        let thread = self
            .get(caller.pid)
            .ok_or(Errno::ESRCH)?
            .get_thread(child.tid)
            .ok_or(Errno::ESRCH)?;
        if thread.creator_tid != caller.tid || thread.grouped_entry.is_some() {
            return Err(Errno::EBUSY);
        }
        let channel = self.group_task_channel(caller)?;
        let (function, argument) = match entry {
            Some(entry) => entry,
            None => (
                self.group_caller_word(
                    caller,
                    channel
                        .checked_add(wasm_posix_shared::channel::DATA_OFFSET as u32)
                        .ok_or(Errno::EFAULT)?,
                    host,
                )?,
                self.group_caller_word(
                    caller,
                    channel
                        .checked_add(wasm_posix_shared::channel::DATA_OFFSET as u32 + 4)
                        .ok_or(Errno::EFAULT)?,
                    host,
                )?,
            ),
        };
        let process_channel =
            u32::try_from(self.get(child.pid).ok_or(Errno::ESRCH)?.main_channel_addr)
                .map_err(|_| Errno::EFAULT)?;
        let thread = self
            .get_mut(child.pid)
            .ok_or(Errno::ESRCH)?
            .get_thread_mut(child.tid)
            .ok_or(Errno::ESRCH)?;
        let stack = u32::try_from(thread.stack_ptr).map_err(|_| Errno::EFAULT)?;
        let tls = u32::try_from(thread.tls_ptr).map_err(|_| Errno::EFAULT)?;
        let ctid = u32::try_from(thread.ctid_ptr).map_err(|_| Errno::EFAULT)?;
        thread.grouped_entry = Some(crate::process::GroupedThreadEntry {
            function,
            argument,
            slot_start: address,
            slot_length: length,
        });
        let page = address / PAGE;
        Ok(L::Thread([
            page,
            page,
            address + M::THREAD_SLOT_TLS_PAGE * PAGE,
            address + M::THREAD_SLOT_TLS_PAGE * PAGE,
            address + M::THREAD_SLOT_FORK_SAVE_PAGE * PAGE,
            address + M::THREAD_SLOT_CHANNEL_PRIMARY_PAGE * PAGE,
            process_channel,
            function,
            argument,
            stack,
            tls,
            ctid,
        ]))
    }

    pub(super) fn group_fork_launch_layout(
        &mut self,
        caller: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<L::Fork, Errno> {
        let channel = self.group_task_channel(caller)?;
        let anchor = channel
            .checked_sub(M::FORK_SAVE_BUFFER_SIZE)
            .ok_or(Errno::EFAULT)?;
        let continuation = self.group_caller_word(caller, anchor, host)?;
        let header =
            wasm_posix_shared::abi::wpk_fork_linked_chunk_header_size(4).ok_or(Errno::EIO)?;
        let root = continuation
            .checked_sub(header)
            .filter(|root| *root != 0 && *root % PAGE == 0)
            .ok_or(Errno::EFAULT)?;
        let process = self.get(caller.pid).ok_or(Errno::ESRCH)?;
        let extent = process.memory.group_virtual_extent().ok_or(Errno::EFAULT)?;
        if u64::from(root) + u64::from(PAGE) > u64::from(extent) * u64::from(PAGE) {
            return Err(Errno::EFAULT);
        }
        let mut words = [L::MAIN, continuation, 0, 0, 0, 0, channel];
        let entry = if caller.tid != caller.pid {
            let thread = process.get_thread(caller.tid).ok_or(Errno::ESRCH)?;
            let entry = thread.grouped_entry.ok_or(Errno::ESRCH)?;
            let (start, length) = process.memory.group_thread_control_interval(caller)?;
            if start as u64 != u64::from(entry.slot_start)
                || length as u64 != u64::from(entry.slot_length)
            {
                return Err(Errno::ESRCH);
            }
            Some(entry)
        } else {
            process.grouped_main_entry
        };
        if let Some(entry) = entry {
            words[0] = L::THREAD;
            words[2] = entry.function;
            words[3] = entry.argument;
            words[4] = entry.slot_start;
            words[5] = entry.slot_length;
        }
        Ok(L::Fork(words))
    }

    pub(super) fn install_group_fork_entry(
        &mut self,
        child: ReceiptRecord,
        layout: L::Fork,
    ) -> Result<(), Errno> {
        let process = self.get_mut(child.pid).ok_or(Errno::ESRCH)?;
        if process.exec_generation != child.generation {
            return Err(Errno::ESRCH);
        }
        process.grouped_main_entry =
            (layout.0[0] == L::THREAD).then_some(crate::process::GroupedThreadEntry {
                function: layout.0[2],
                argument: layout.0[3],
                slot_start: layout.0[4],
                slot_length: layout.0[5],
            });
        Ok(())
    }
}
