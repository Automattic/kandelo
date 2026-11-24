//! Clone task allocation and parent-TID publication belong to the retained
//! ProcessTable operation, before any platform construction can be requested.
use super::*;

const PARENT_SETTID: u32 = 0x00100000;

pub(super) struct Task {
    pub(super) entry: (u32, u32),
    parent_tid: Option<(u32, u32)>,
}

impl ProcessTable {
    pub(crate) fn validate_clone_control_start(
        &mut self,
        record: ReceiptRecord,
    ) -> Result<(), Errno> {
        if self.group_operations().entries.values().any(|operation| {
            operation.request.kind == kind::CLONE && operation.child == Some(record)
        }) {
            return Err(Errno::EBUSY);
        }
        Ok(())
    }

    pub(super) fn allocate_group_clone(
        &mut self,
        operation: &mut Operation,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let caller = operation.receipt;
        if operation.child.is_some() || operation.clone_task.is_some() {
            return Err(Errno::EBUSY);
        }
        // The transport cannot choose a task ID, truncate a pointer or supply
        // pthread entry metadata independently of the actual caller mailbox.
        let words: [u32; 6] = operation.request.args.map(|word| word as u32);
        if operation
            .request
            .args
            .iter()
            .zip(words)
            .any(|(raw, word)| *raw != u64::from(word))
        {
            return Err(Errno::EINVAL);
        }
        let [flags, stack, ptid, tls, ctid, _] = words;
        let (tls, ctid) =
            crate::syscalls::thread_clone_settings(flags, tls as usize, ctid as usize)?;
        if self.get(caller.pid).ok_or(Errno::ESRCH)?.vfork_child {
            return Err(Errno::EAGAIN);
        }
        let channel = self.group_task_channel(caller)?;
        let data = channel
            .checked_add(wasm_posix_shared::channel::DATA_OFFSET as u32)
            .ok_or(Errno::EFAULT)?;
        let entry = (
            self.group_caller_word(caller, data, host)?,
            self.group_caller_word(caller, data.checked_add(4).ok_or(Errno::EFAULT)?, host)?,
        );
        let parent_tid = {
            let (store, admission) = self.memory_groups().storage_owner(caller)?;
            let memory = HostMemory {
                resource: store.resource(),
                host,
            };
            if ctid != 0 {
                store.writable_execution_word(&memory, admission, ctid as u32)?;
            }
            if flags & PARENT_SETTID != 0 {
                if ptid == 0 {
                    return Err(Errno::EFAULT);
                }
                Some((
                    ptid,
                    store.writable_execution_word(&memory, admission, ptid)?,
                ))
            } else {
                None
            }
        };
        // The operation and its queue reservation already exist. Every task
        // allocated below is retained before another fallible foreign effect.
        let tid = self.create_thread(caller.pid, caller.tid, stack as usize, tls, ctid)?;
        let child = self
            .memory_group_prepared_admission(crate::memory_group::GroupExecution {
                pid: caller.pid,
                tid,
                exec_generation: caller.generation,
            })
            .expect("newly allocated grouped clone must retain its prepared admission")
            .record();
        operation.child = Some(child);
        operation.request.thread = tid;
        operation.clone_task = Some(Task { entry, parent_tid });
        if let Some((address, _)) = parent_tid {
            let (store, admission) = self.memory_groups().storage_owner(caller)?;
            store.write_execution_word(
                &mut HostMemory {
                    resource: store.resource(),
                    host,
                },
                admission,
                address,
                tid,
            )?;
        }
        Ok(())
    }

    pub(super) fn restore_group_clone_parent_tid(
        &mut self,
        operation: &mut Operation,
        host: &mut dyn HostIO,
    ) -> Result<(), Errno> {
        let Some(task) = operation.clone_task.as_mut() else {
            return Ok(());
        };
        let Some((address, old)) = task.parent_tid else {
            return Ok(());
        };
        let child = operation.child.ok_or(Errno::EIO)?;
        let result = match self.memory_groups().storage_owner(operation.receipt) {
            Ok((store, admission)) => store
                .compare_exchange_execution_word(
                    &mut HostMemory {
                        resource: store.resource(),
                        host,
                    },
                    admission,
                    address,
                    child.tid,
                    old,
                )
                .map(|_| ()),
            Err(error) => Err(error),
        };
        match result {
            // A user-unmapped or retired word cannot be restored. Exact-image
            // lookup prevents writing into an exec successor; a CAS preserves
            // any intervening user write to the still-mapped word.
            Ok(()) | Err(Errno::ESRCH | Errno::EFAULT) => task.parent_tid = None,
            Err(error) => return Err(error),
        }
        Ok(())
    }
}
