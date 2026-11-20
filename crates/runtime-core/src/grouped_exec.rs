//! Executable-target admission follows the current kernel-owned image group.
//! Replacement metadata is reserved before commit; physical storage and actual
//! Worker stop remain the disposable host realm's independent obligations.
use crate::{
    exec_target::{self, Admission, PreparedExecOwner},
    process_table::ProcessTable,
};
use wasm_posix_shared::Errno;

impl ProcessTable {
    pub fn admit_exec_target(
        &self,
        owner_pid: u32,
        token: u32,
        expected_abi: u32,
    ) -> Result<Admission, Errno> {
        let proc = self.get(owner_pid).ok_or(Errno::ESRCH)?;
        if self.process_memory_group(owner_pid)?.is_none() {
            return exec_target::admit(proc, owner_pid, token, expected_abi);
        }
        match proc.prepared_exec_targets.get(token)?.owner() {
            PreparedExecOwner::Process { caller_tid, .. } => {
                self.validate_task(owner_pid, caller_tid)?;
                proc.prepared_exec_targets
                    .get(token)?
                    .owner()
                    .validate_process(owner_pid, caller_tid, proc.exec_generation)?;
            }
            PreparedExecOwner::Spawn { parent_pid, .. } => {
                if self.get(parent_pid).is_none() || proc.ppid != parent_pid {
                    return Err(Errno::ESRCH);
                }
                proc.prepared_exec_targets
                    .get(token)?
                    .owner()
                    .validate_spawn(parent_pid, owner_pid, proc.exec_generation)?;
            }
        }
        exec_target::admit_grouped(proc, owner_pid, token, expected_abi)
    }
}

/// A future main execution minted by the same kernel ledger as fork/clone.
/// The virtual bounds describe the SDK artifact, not common physical Memory.
#[derive(Debug, Clone, Copy)]
pub struct PreparedGroupedExec {
    pub receipt: crate::memory_group::GroupAdmission,
    pub initial_pages: u32,
    pub maximum_pages: u32,
}

pub(crate) struct Pending {
    source: crate::memory_group::GroupAdmission,
    target: u32,
    future: PreparedGroupedExec,
    memory: Option<crate::memory::MemoryManager>,
    cancelled: bool,
}

impl ProcessTable {
    /// No live image state changes until both metadata and ledger capacity are
    /// admitted. Host physical allocation must also finish before exec commit.
    pub fn prepare_grouped_exec(
        &mut self,
        pid: u32,
        tid: u32,
        target: u32,
    ) -> Result<PreparedGroupedExec, Errno> {
        self.validate_task(pid, tid)?;
        let source = self.memory_group_task(pid, tid)?.ok_or(Errno::EOPNOTSUPP)?;
        self.memory_group_running_admission(source)?;
        let proc = self.get(pid).ok_or(Errno::ESRCH)?;
        if proc.pending_grouped_exec.is_some() {
            return Err(Errno::EBUSY);
        }
        if proc.pointer_width != 4 || proc.vfork_child {
            return Err(Errno::EOPNOTSUPP);
        }
        proc.prepared_exec_targets
            .get(target)?
            .owner()
            .validate_process(pid, tid, proc.exec_generation)?;
        if !matches!(
            self.admit_exec_target(pid, target, wasm_posix_shared::ABI_VERSION)?,
            Admission::Program
        ) {
            return Err(Errno::ENOEXEC);
        }
        let layout = wasm_artifact::grouped_memory::read_layout(exec_target::artifact_bytes(
            proc, pid, target,
        )?)
        .map_err(|_| Errno::ENOEXEC)?;
        let generation = proc
            .exec_generation
            .checked_add(1)
            .ok_or(Errno::EOVERFLOW)?;
        // Allocate the owner before minting ledger custody; ENOMEM cannot leave
        // an unreachable future receipt behind.
        let mut storage = crate::IoBox::try_new(None::<Pending>)?;
        let receipt = self
            .memory_groups()
            .prepare_exec_image(source.group(), pid, generation)?;
        let future = PreparedGroupedExec {
            receipt,
            initial_pages: layout.initial_pages,
            maximum_pages: layout.maximum_pages,
        };
        *storage = Some(Pending {
            source,
            target,
            future,
            memory: None,
            cancelled: false,
        });
        // Publish the already allocated owner without a second allocation.
        self.get_mut(pid)
            .expect("validated exec process vanished")
            .pending_grouped_exec = Some(storage);
        Ok(future)
    }

    fn pending_grouped_exec(
        &self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<&Pending, Errno> {
        let pending = self
            .get(record.pid)
            .and_then(|proc| {
                proc.pending_grouped_exec
                    .as_deref()
                    .and_then(Option::as_ref)
            })
            .ok_or(Errno::ESRCH)?;
        if pending.future.receipt.record() != record {
            return Err(Errno::ESRCH);
        }
        Ok(pending)
    }

    /// Revalidate exact old caller/target and future receipt. A future Worker
    /// cannot Start through the normal ledger until exec advances generation.
    pub fn validate_grouped_exec(
        &self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<(), Errno> {
        let pending = self.pending_grouped_exec(record)?;
        if pending.cancelled {
            return Err(Errno::EBUSY);
        }
        let execution = pending.source.execution();
        self.validate_task(record.pid, execution.tid)?;
        if self.memory_group_task(record.pid, execution.tid)? != Some(pending.source) {
            return Err(Errno::ESRCH);
        }
        self.memory_group_running_admission(pending.source)?;
        let proc = self.get(record.pid).ok_or(Errno::ESRCH)?;
        proc.prepared_exec_targets
            .get(pending.target)?
            .owner()
            .validate_process(record.pid, execution.tid, proc.exec_generation)?;
        if proc.exec_generation.checked_add(1) != Some(record.generation) {
            return Err(Errno::ESRCH);
        }
        self.memory_groups_validate_exec(pending.future.receipt)
    }

    /// Build the entire future MM without replacing any outgoing mapping.
    pub fn configure_grouped_exec(
        &mut self,
        record: wasm_posix_shared::group_memory_layout::Record,
    ) -> Result<(), Errno> {
        self.validate_grouped_exec(record.receipt)?;
        let pending = self.pending_grouped_exec(record.receipt)?;
        let pointer = |value: u64| {
            u32::try_from(value)
                .map(|v| v as usize)
                .map_err(|_| Errno::EINVAL)
        };
        let control = pointer(record.control_base)?;
        let channel = pointer(record.channel)?;
        let end = pointer(record.control_end)?;
        if pending.memory.is_some()
            || record.mode != wasm_posix_shared::group_memory_layout::FRESH
            || record.initial_pages < pending.future.initial_pages
            || record.maximum_pages > pending.future.maximum_pages
            || record.control_base < u64::from(pending.future.initial_pages) * 65536
            || channel % 4 != 0
            || channel < control
            || channel
                .checked_add(wasm_posix_shared::channel::MIN_CHANNEL_SIZE)
                .is_none_or(|value| value > end)
        {
            return Err(Errno::EINVAL);
        }
        let mut memory = crate::memory::MemoryManager::new();
        memory.install_group_linear_layout(crate::memory::linear::InitialLayout {
            initial_pages: record.initial_pages,
            maximum_pages: record.maximum_pages,
            brk_base: pointer(record.brk_base)?,
            mmap_base: pointer(record.mmap_base)?,
            brk_limit: pointer(record.brk_limit)?,
            control_start: control,
            control_end: end,
        })?;
        self.get_mut(record.receipt.pid)
            .expect("validated exec process vanished")
            .pending_grouped_exec
            .as_deref_mut()
            .and_then(Option::as_mut)
            .unwrap()
            .memory = Some(memory);
        Ok(())
    }

    /// Cancel only this never-started receipt. Image custody and the Pending
    /// owner remain while the host settles its unexposed scratch/references.
    pub fn cancel_grouped_exec(
        &mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<(), Errno> {
        let pending = self.pending_grouped_exec(record)?;
        if pending.cancelled {
            return Err(Errno::EBUSY);
        }
        let receipt = pending.future.receipt;
        self.memory_groups().cancel_unconstructed(receipt)?;
        let pending = self
            .get_mut(record.pid)
            .unwrap()
            .pending_grouped_exec
            .as_deref_mut()
            .and_then(Option::as_mut)
            .unwrap();
        pending.cancelled = true;
        pending.memory = None;
        Ok(())
    }

    /// The host calls this after exact scratch/reference cleanup is ready,
    /// then returns final root/payload pages in the same serialized entry.
    /// Pending serial custody prevents old cancellation from deleting a later
    /// reservation for the same PID/future generation. This is not a stop proof.
    pub fn finish_grouped_exec_cancellation(
        &mut self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<(), Errno> {
        if !self.pending_grouped_exec(record)?.cancelled {
            return Err(Errno::EBUSY);
        }
        let receipt = self.pending_grouped_exec(record)?.future.receipt;
        self.memory_groups()
            .finish_exec_image_cancellation(receipt)?;
        self.get_mut(record.pid).unwrap().pending_grouped_exec = None;
        Ok(())
    }

    /// Normal lifecycle commit consumes the retained executable exactly once.
    /// A prepared MM is moved into place after the ordinary commit; no new MM
    /// allocation or layout installation is permitted past that boundary.
    pub fn commit_exec_target(
        &mut self,
        host: &mut dyn crate::process::HostIO,
        pid: u32,
        tid: u32,
        target: u32,
    ) -> Result<(), Errno> {
        let grouped = self.process_memory_group(pid)?.is_some()
            || self
                .get(pid)
                .is_some_and(|proc| proc.pending_grouped_exec.is_some());
        if !grouped {
            let (proc, locks) = self.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
            return exec_target::commit_process(proc, locks, host, pid, tid, target);
        }
        let validation = (|| {
            let proc = self.get(pid).ok_or(Errno::ESRCH)?;
            let pending = proc
                .pending_grouped_exec
                .as_deref()
                .and_then(Option::as_ref)
                .ok_or(Errno::EOPNOTSUPP)?;
            if pending.target != target || pending.source.execution().tid != tid {
                return Err(Errno::EINVAL);
            }
            self.validate_grouped_exec(pending.future.receipt.record())?;
            if pending.memory.is_none()
                || proc.pending_group_memory_change.is_some()
                || crate::owned_resource::has_pending_mapping(proc)
            {
                return Err(Errno::EBUSY);
            }
            Ok(pending.future.receipt)
        })();
        let future = match validation {
            Ok(future) => future,
            Err(error) => {
                let (proc, locks) = self.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
                exec_target::cancel(proc, locks, host, pid, target)?;
                return Err(error);
            }
        };
        let (proc, locks) = self.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
        exec_target::commit_process(proc, locks, host, pid, tid, target)?;
        let mut pending = proc
            .pending_grouped_exec
            .take()
            .expect("committed exec lost reservation")
            .into_inner()
            .expect("empty exec reservation");
        let mut memory = pending
            .memory
            .take()
            .expect("committed exec lost prepared MM");
        memory.set_data_limit(proc.rlimits[2][0]);
        proc.memory = memory;
        self.memory_groups()
            .commit_exec_image(future)
            .expect("committed exec lost exact image custody");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{memory_group::MemoryGroupLimits, process::test_host::NoopHost, syscalls::*};
    use alloc::{format, vec, vec::Vec};
    use wasm_posix_shared::{ABI_VERSION, flags::*};

    pub(super) struct Fixture {
        pub(super) table: ProcessTable,
        pub(super) pid: u32,
        enabled: (bool, bool),
    }
    impl Fixture {
        pub(super) fn new() -> Self {
            let enabled = (
                crate::rootfs::set_enabled(true),
                crate::tmpfs::set_enabled(true),
            );
            crate::rootfs::reset();
            let _ = crate::tmpfs::unlink(b"/tmp/grouped-exec-admission");
            crate::rootfs::insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
            crate::rootfs::insert_base_dir(b"/tmp", 0o1777, 0, 0, 2).unwrap();
            let mut table = ProcessTable::new();
            let pid = table.create_process().unwrap();
            Self {
                table,
                pid,
                enabled,
            }
        }
        pub(super) fn group(&mut self) {
            self.table.memory_groups().configure(2048, 1).unwrap();
            let group = self
                .table
                .memory_groups()
                .create(MemoryGroupLimits {
                    maximum_pages: 2048,
                    maximum_processes: 2,
                    maximum_tasks: 8,
                })
                .unwrap();
            let receipt = self
                .table
                .prepare_process_memory_group(group, self.pid)
                .unwrap();
            self.table.memory_groups().start(receipt).unwrap();
        }
        pub(super) fn target(&mut self, bytes: &[u8]) -> u32 {
            self.target_for(bytes, self.pid)
        }
        pub(super) fn target_for(&mut self, bytes: &[u8], caller_tid: u32) -> u32 {
            let generation = self.table.get(self.pid).unwrap().exec_generation;
            self.target_owned(bytes, PreparedExecOwner::Process { pid: self.pid, caller_tid, generation })
        }
        fn target_owned(&mut self, bytes: &[u8], owner: PreparedExecOwner) -> u32 {
            let pid = self.pid;
            let (proc, locks) = self.table.process_and_advisory_locks(pid).unwrap();
            let fd = sys_open(
                proc,
                &mut NoopHost,
                b"/tmp/grouped-exec-admission",
                O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC,
                0o755,
            )
            .unwrap();
            assert_eq!(
                sys_write(proc, &mut NoopHost, fd, bytes).unwrap(),
                bytes.len()
            );
            let token = exec_target::prepare(
                proc,
                locks,
                &mut NoopHost,
                owner,
                AT_FDCWD,
                b"/tmp/grouped-exec-admission",
                0,
            )
            .unwrap();
            let mut observed = vec![0; bytes.len()];
            let count =
                exec_target::read(proc, &mut NoopHost, pid, token, 0, &mut observed).unwrap();
            assert_eq!(count, bytes.len());
            assert_eq!(observed, bytes);
            sys_close(proc, &mut NoopHost, fd).unwrap();
            token
        }
        pub(super) fn admission(&self, token: u32) -> Result<Admission, Errno> {
            self.table.admit_exec_target(self.pid, token, ABI_VERSION)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some((proc, locks)) = self.table.process_and_advisory_locks(self.pid) {
                exec_target::drain_prepared_exec_targets(proc, locks, &mut NoopHost);
            }
            crate::rootfs::reset();
            crate::rootfs::set_enabled(self.enabled.0);
            crate::tmpfs::set_enabled(self.enabled.1);
        }
    }
    pub(super) fn grouped(version: u32) -> Vec<u8> {
        let mut bytes = wat::parse_str(format!(
            r#"(module
            (import "kandelo.memory-group.v3" "memory" (memory 1 65536 shared))
            (func(export "__abi_version")(result i32)i32.const {ABI_VERSION})
            (global(export "__vm_root")(mut i32)(i32.const 0))
            (global(export "__vm_scratch")(mut i32)(i32.const 0))
            (global(export "__vm_replica")(mut i32)(i32.const 0))
            (func(export "__vm_checkpoint")(param i32 i32))
            (func(export "__vm_worker_wait32")(param i32 i32 i64 i32 i32)(result i32)i32.const 0)
            (func(export "__vm_initialize")(param i32))
            (func(export "__vm_host_span")(param i32 i32 i32 i32)(result i32)i32.const 0))"#
        ))
        .unwrap();
        let data = format!(
            r#"{{"version":{version},"layout":3,"threadAttach":2,"cooperativeStop":3,"executionBarrier":1,"orderedWaitQueue":2,"initialPages":149,"maximumPages":65536,"accessProfile":"outlined","sourceSha256":"{}","helpersSha256":"{}"}}"#,
            "0".repeat(64),
            "a".repeat(64)
        );
        let name = wasm_posix_shared::program_extensions::memory_group_v3::SECTION;
        fn leb(mut n: usize, out: &mut Vec<u8>) {
            loop {
                let b = (n & 127) as u8;
                n >>= 7;
                out.push(b | if n > 0 { 128 } else { 0 });
                if n == 0 {
                    break;
                }
            }
        }
        let mut section = Vec::new();
        leb(name.len(), &mut section);
        section.extend_from_slice(name.as_bytes());
        section.extend_from_slice(data.as_bytes());
        bytes.push(0);
        leb(section.len(), &mut bytes);
        bytes.extend(section);
        bytes
    }
    #[test]
    fn explicit_initial_group_validation_reserves_nothing_and_admits_only_a_fresh_root() {
        let mut f = Fixture::new();
        f.table.memory_groups().configure(2048, 1).unwrap();
        let group = f.table.memory_groups().create(MemoryGroupLimits {
            maximum_pages: 2048, maximum_processes: 2, maximum_tasks: 8,
        }).unwrap();
        let raw_group = group.as_raw();
        let token = f.target(&grouped(3));
        assert!(matches!(f.admission(token), Ok(Admission::Refused(_))));
        assert!(matches!(f.table.admit_initial_group_exec_target(raw_group, f.pid, token, ABI_VERSION), Ok(Admission::Program)));
        assert_eq!(f.table.process_memory_group(f.pid), Ok(None));
        let snapshot = f.table.memory_groups().snapshot(group).unwrap();
        assert_eq!((snapshot.processes, snapshot.images, snapshot.tasks), (0, 0, 0));
        assert!(f.table.admit_initial_group_exec_target(raw_group + 1, f.pid, token, ABI_VERSION).is_err());
        {
            let (proc, locks) = f.table.process_and_advisory_locks(f.pid).unwrap();
            exec_target::commit_initial(proc, locks, &mut NoopHost, f.pid, token).unwrap();
        }
        // The receipt belongs to the committed generation, not inspection's
        // generation zero. No host-selected PID or receipt is introduced.
        let receipt = f.table.prepare_process_memory_group(group, f.pid).unwrap();
        assert_eq!(receipt.record().generation, 1);
        assert!(f.table.admit_initial_group_exec_target(raw_group, f.pid, token, ABI_VERSION).is_err());
    }

    #[test]
    fn initial_spawn_validation_requires_the_pending_childs_exact_parent_group() {
        let mut f = Fixture::new();
        f.table.memory_groups().configure(2048, 2).unwrap();
        let limits = MemoryGroupLimits { maximum_pages: 1024, maximum_processes: 4, maximum_tasks: 8 };
        let group = f.table.memory_groups().create(limits).unwrap();
        let other = f.table.memory_groups().create(limits).unwrap();
        let parent = f.pid;
        let admission = f.table.prepare_process_memory_group(group, parent).unwrap();
        f.table.memory_groups().start(admission).unwrap();
        let child = f.table.spawn_child_for_caller(parent, parent, &[], &[], &[],
            &crate::spawn::SpawnAttrs::empty(), &mut NoopHost).unwrap();
        f.pid = child;
        let token = f.target_owned(&grouped(3), PreparedExecOwner::Spawn {
            parent_pid: parent, child_pid: child, launch: 0,
        });
        assert!(matches!(f.table.admit_initial_group_exec_target(other.as_raw(), child, token, ABI_VERSION), Err(Errno::EPERM)));
        assert!(matches!(f.table.admit_initial_group_exec_target(group.as_raw(), child, token, ABI_VERSION), Ok(Admission::Program)));
        assert_eq!(f.table.process_memory_group(child), Ok(None));
        let snapshot = f.table.memory_groups().snapshot(group).unwrap();
        assert_eq!((snapshot.processes, snapshot.images, snapshot.tasks), (1, 1, 1));
        f.table.get_mut(child).unwrap().spawn_publication_pending = false;
        assert!(matches!(f.table.admit_initial_group_exec_target(group.as_raw(), child, token, ABI_VERSION), Err(Errno::EPERM)));
    }

    #[test]
    fn initial_group_validation_preserves_ordinary_and_script_policy_and_refuses_bad_artifacts() {
        for (bytes, kind) in [
            (include_bytes!("../../../abi/program-fixtures/v56/echo.wasm").to_vec(), 0),
            (b"#!/bin/interpreter -e\n".to_vec(), 1),
            (grouped(2), 2),
        ] {
            let mut f = Fixture::new();
            f.table.memory_groups().configure(2048, 1).unwrap();
            let group = f.table.memory_groups().create(MemoryGroupLimits {
                maximum_pages: 2048, maximum_processes: 2, maximum_tasks: 8,
            }).unwrap();
            let token = f.target(&bytes);
            let admitted = f.table.admit_initial_group_exec_target(group.as_raw(), f.pid, token, ABI_VERSION).unwrap();
            assert!(matches!((kind, admitted), (0, Admission::Program) | (1, Admission::Script(_)) | (2, Admission::Refused(_))));
            assert_eq!(f.table.process_memory_group(f.pid), Ok(None));
        }
    }

    #[test]
    fn only_current_group_members_admit_a_grouped_retained_executable() {
        let mut f = Fixture::new();
        let token = f.target(&grouped(3));
        assert!(matches!(f.admission(token), Ok(Admission::Refused(_))));
        f.group();
        assert!(matches!(f.admission(token), Ok(Admission::Program)));
        assert_eq!(f.table.exec_generation(f.pid), Ok(0));
        assert!(f.table.get(f.pid).unwrap().exe.is_none());
        // An old image's admission cannot enable an unrelated successor.
        f.table.get_mut(f.pid).unwrap().exec_generation = 1;
        let token = f.target(&grouped(3));
        assert!(matches!(f.admission(token), Ok(Admission::Refused(_))));
    }
    #[test]
    fn grouped_preflight_refuses_incompatible_or_ordinary_targets_without_committing() {
        let mut f = Fixture::new();
        f.group();
        for bytes in [
            grouped(4),
            include_bytes!("../../../abi/program-fixtures/v56/echo.wasm").to_vec(),
        ] {
            let token = f.target(&bytes);
            assert!(matches!(f.admission(token), Ok(Admission::Refused(_))));
            assert_eq!(f.table.exec_generation(f.pid), Ok(0));
            assert!(f.table.get(f.pid).unwrap().exe.is_none());
        }
    }
    #[test]
    fn current_membership_cannot_admit_an_old_generations_retained_target() {
        let mut f = Fixture::new();
        f.group();
        let group = f.table.process_memory_group(f.pid).unwrap().unwrap();
        let token = f.target(&grouped(3));
        f.table.get_mut(f.pid).unwrap().exec_generation = 1;
        f.table.prepare_process_memory_group(group, f.pid).unwrap();
        assert!(matches!(f.admission(token), Err(Errno::EINVAL)));
        assert!(
            f.table
                .get(f.pid)
                .unwrap()
                .prepared_exec_targets
                .get(token)
                .is_ok()
        );
        assert!(f.table.get(f.pid).unwrap().exe.is_none());
    }

    #[test]
    fn ordinary_control_and_grouped_shebang_resolution_stay_separate() {
        let mut f = Fixture::new();
        let token = f.target(include_bytes!(
            "../../../abi/program-fixtures/v56/echo.wasm"
        ));
        assert!(matches!(f.admission(token), Ok(Admission::Program)));
        f.group();
        let token = f.target(b"#!/bin/grouped-shell -e\n");
        assert!(matches!(f.admission(token), Ok(Admission::Script(_))));
        assert_eq!(f.table.exec_generation(f.pid), Ok(0));
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::tests::{Fixture, grouped};
    use super::*;
    use crate::{process::test_host::NoopHost, syscalls::*};
    use wasm_posix_shared::{
        flags::*,
        group_memory_layout::{FRESH, Record},
        memory_group::TaskAction,
    };
    const PAGE: u64 = 65536;
    fn layout(future: PreparedGroupedExec) -> Record {
        Record {
            receipt: future.receipt.record(),
            initial_pages: 152,
            maximum_pages: 2048,
            control_base: 149 * PAGE,
            control_end: 152 * PAGE,
            channel: 150 * PAGE,
            brk_base: 152 * PAGE,
            mmap_base: 152 * PAGE,
            brk_limit: 2048 * PAGE,
            mode: FRESH,
        }
    }
    fn cancel(f: &mut Fixture, future: PreparedGroupedExec) {
        f.table
            .cancel_grouped_exec(future.receipt.record())
            .unwrap();
        f.table
            .finish_grouped_exec_cancellation(future.receipt.record())
            .unwrap();
    }
    #[test]
    fn reserves_future_without_mutating_current_image_and_retains_exact_cancel_hold() {
        let mut f = Fixture::new();
        f.group();
        let target = f.target(&grouped(3));
        let group = f.table.process_memory_group(f.pid).unwrap().unwrap();
        let before = f.table.get(f.pid).unwrap().memory.get_brk();
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        assert_eq!(future.receipt.execution().pid, f.pid);
        assert_eq!(future.receipt.execution().tid, f.pid);
        assert_eq!(future.receipt.execution().exec_generation, 1);
        let snapshot = f.table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            (snapshot.processes, snapshot.tasks, snapshot.images),
            (1, 2, 2)
        );
        assert_eq!(f.table.get(f.pid).unwrap().memory.get_brk(), before);
        assert_eq!(f.table.exec_generation(f.pid), Ok(0));
        assert_eq!(
            f.table
                .memory_group_task_action(future.receipt.record(), TaskAction::Start),
            Err(Errno::EAGAIN)
        );
        assert_eq!(
            f.table
                .finish_grouped_exec_cancellation(future.receipt.record()),
            Err(Errno::EBUSY)
        );
        f.table
            .cancel_grouped_exec(future.receipt.record())
            .unwrap();
        assert_eq!(
            f.table.memory_groups().retire_image(f.pid, 1),
            Err(Errno::EBUSY)
        );
        assert_eq!(
            f.table
                .memory_groups()
                .rollback_unconstructed_image(f.pid, 1),
            Err(Errno::EBUSY)
        );
        assert!(f.table.memory_group_removal_pending(f.pid));
        assert!(matches!(
            f.table.prepare_grouped_exec(f.pid, f.pid, target),
            Err(Errno::EBUSY)
        ));
        f.table
            .finish_grouped_exec_cancellation(future.receipt.record())
            .unwrap();
        let later = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        assert_ne!(
            later.receipt.record().serial,
            future.receipt.record().serial
        );
        assert_eq!(later.receipt.execution(), future.receipt.execution());
        assert_eq!(
            f.table
                .finish_grouped_exec_cancellation(future.receipt.record()),
            Err(Errno::ESRCH)
        );
        f.table
            .validate_grouped_exec(later.receipt.record())
            .unwrap();
        cancel(&mut f, later);
        let snapshot = f.table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            (snapshot.processes, snapshot.tasks, snapshot.images),
            (1, 1, 1)
        );
    }
    #[test]
    fn real_commit_installs_prepared_mm_keeps_pid_and_inherited_fds_then_requires_old_stop() {
        let mut f = Fixture::new();
        f.group();
        let target = f.target(&grouped(3));
        let old = f.table.memory_group_task(f.pid, f.pid).unwrap().unwrap();
        let proc = f.table.get_mut(f.pid).unwrap();
        let keep = sys_open(
            proc,
            &mut NoopHost,
            b"/tmp/grouped-exec-admission",
            O_RDONLY,
            0,
        )
        .unwrap();
        let close = sys_open(
            proc,
            &mut NoopHost,
            b"/tmp/grouped-exec-admission",
            O_RDONLY | O_CLOEXEC,
            0,
        )
        .unwrap();
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        f.table.configure_grouped_exec(layout(future)).unwrap();
        f.table
            .commit_exec_target(&mut NoopHost, f.pid, f.pid, target)
            .unwrap();
        let proc = f.table.get_mut(f.pid).unwrap();
        assert_eq!(proc.pid, f.pid);
        assert_eq!(proc.exec_generation, 1);
        assert_eq!(proc.memory.group_virtual_extent(), Some(152));
        assert_eq!(proc.memory.group_virtual_maximum(), Some(2048));
        assert_eq!(proc.memory.get_brk(), (152 * PAGE) as usize);
        assert!(proc.pending_grouped_exec.is_none());
        assert!(proc.exe.is_some());
        let mut header = [0; 4];
        assert_eq!(sys_read(proc, &mut NoopHost, keep, &mut header), Ok(4));
        assert_eq!(&header, b"\0asm");
        assert!(sys_read(proc, &mut NoopHost, close, &mut header).is_err());
        assert_eq!(
            f.table
                .memory_group_task_action(future.receipt.record(), TaskAction::Start),
            Err(Errno::EBUSY)
        );
        f.table
            .memory_group_task_action(old.record(), TaskAction::BeginRetirement)
            .unwrap();
        assert_eq!(
            f.table
                .memory_group_task_action(future.receipt.record(), TaskAction::Start),
            Err(Errno::EBUSY)
        );
        f.table
            .memory_group_task_action(old.record(), TaskAction::RetireQuiescent)
            .unwrap();
        f.table
            .memory_group_task_action(future.receipt.record(), TaskAction::Start)
            .unwrap();
    }
    #[test]
    fn committed_unexposed_exec_keeps_removal_blocked_until_host_image_release() {
        let mut f = Fixture::new();
        f.group();
        let old = f.table.memory_group_task(f.pid, f.pid).unwrap().unwrap();
        let target = f.target(&grouped(3));
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        f.table.configure_grouped_exec(layout(future)).unwrap();
        f.table.commit_exec_target(&mut NoopHost, f.pid, f.pid, target).unwrap();
        let (proc, locks) = f.table.process_and_advisory_locks(f.pid).unwrap();
        sys_exit_with_locks(proc, locks, &mut NoopHost, 0);
        f.table.memory_group_task_action(old.record(), TaskAction::BeginRetirement).unwrap();
        f.table.memory_group_task_action(old.record(), TaskAction::RetireQuiescent).unwrap();
        assert!(f.table.memory_group_removal_pending(f.pid));
        assert!(f.table.remove_process(f.pid).is_none());
        f.table.memory_group_task_action(future.receipt.record(), TaskAction::CancelUnconstructed).unwrap();
        assert!(f.table.memory_group_removal_pending(f.pid));
        assert!(f.table.remove_process(f.pid).is_none());
        f.table.memory_groups().retire_image(f.pid, future.receipt.execution().exec_generation).unwrap();
        assert!(!f.table.memory_group_removal_pending(f.pid));
        assert!(f.table.remove_process(f.pid).is_some());
    }

    #[test]
    fn published_exec_transfers_committed_hold_to_normal_execution_receipt() {
        let mut f = Fixture::new();
        f.group();
        let old = f.table.memory_group_task(f.pid, f.pid).unwrap().unwrap();
        let target = f.target(&grouped(3));
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        f.table.configure_grouped_exec(layout(future)).unwrap();
        f.table.commit_exec_target(&mut NoopHost, f.pid, f.pid, target).unwrap();
        f.table.memory_group_task_action(old.record(), TaskAction::BeginRetirement).unwrap();
        f.table.memory_group_task_action(old.record(), TaskAction::RetireQuiescent).unwrap();
        f.table.memory_group_task_action(future.receipt.record(), TaskAction::Start).unwrap();
        let (proc, locks) = f.table.process_and_advisory_locks(f.pid).unwrap();
        sys_exit_with_locks(proc, locks, &mut NoopHost, 0);
        f.table.memory_group_task_action(future.receipt.record(), TaskAction::BeginRetirement).unwrap();
        f.table.memory_group_task_action(future.receipt.record(), TaskAction::RetireQuiescent).unwrap();
        assert!(!f.table.memory_group_removal_pending(f.pid));
        assert!(f.table.remove_process(f.pid).is_some());
    }

    #[test]
    fn allocation_refusal_at_prepare_and_mm_configuration_preserves_the_running_image() {
        let mut f = Fixture::new();
        f.group();
        let target = f.target(&grouped(3));
        let group = f.table.process_memory_group(f.pid).unwrap().unwrap();
        let before = f.table.memory_groups().snapshot(group).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert!(matches!(
                f.table.prepare_grouped_exec(f.pid, f.pid, target),
                Err(Errno::ENOMEM)
            ));
        }
        assert_eq!(f.table.memory_groups().snapshot(group).unwrap(), before);
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(
                f.table.configure_grouped_exec(layout(future)),
                Err(Errno::ENOMEM)
            );
        }
        assert_eq!(f.table.exec_generation(f.pid), Ok(0));
        assert!(f.table.get(f.pid).unwrap().exe.is_none());
        assert_eq!(
            f.table.get(f.pid).unwrap().memory.group_virtual_extent(),
            None
        );
        f.table.configure_grouped_exec(layout(future)).unwrap();
        cancel(&mut f, future);
        assert!(matches!(f.admission(target), Ok(Admission::Program)));
    }
    #[test]
    fn cleanup_after_process_exit_keeps_removal_blocked_until_exact_future_image_release() {
        let mut f = Fixture::new();
        f.group();
        let target = f.target(&grouped(3));
        let old = f.table.memory_group_task(f.pid, f.pid).unwrap().unwrap();
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        let (proc, locks) = f.table.process_and_advisory_locks(f.pid).unwrap();
        sys_exit_with_locks(proc, locks, &mut NoopHost, 0);
        assert!(
            f.table
                .validate_grouped_exec(future.receipt.record())
                .is_err()
        );
        f.table
            .cancel_grouped_exec(future.receipt.record())
            .unwrap();
        f.table
            .memory_group_task_action(old.record(), TaskAction::BeginRetirement)
            .unwrap();
        f.table
            .memory_group_task_action(old.record(), TaskAction::RetireQuiescent)
            .unwrap();
        assert!(f.table.memory_group_removal_pending(f.pid));
        assert!(f.table.remove_process(f.pid).is_none());
        f.table
            .finish_grouped_exec_cancellation(future.receipt.record())
            .unwrap();
        assert!(f.table.remove_process(f.pid).is_some());
    }
    #[test]
    fn full_task_budget_refuses_replacement_without_an_extra_image_or_owner() {
        let mut f = Fixture::new();
        f.group();
        let target = f.target(&grouped(3));
        for _ in 0..7 {
            f.table.create_thread(f.pid, f.pid, 0x8000, 0, 0).unwrap();
        }
        let group = f.table.process_memory_group(f.pid).unwrap().unwrap();
        let before = f.table.memory_groups().snapshot(group).unwrap();
        assert!(matches!(
            f.table.prepare_grouped_exec(f.pid, f.pid, target),
            Err(Errno::EAGAIN)
        ));
        assert_eq!(f.table.memory_groups().snapshot(group).unwrap(), before);
        assert!(f.table.get(f.pid).unwrap().pending_grouped_exec.is_none());
        assert_eq!(f.table.exec_generation(f.pid), Ok(0));
    }
    #[test]
    fn unconfigured_commit_consumes_target_but_preserves_old_image_and_cancel_custody() {
        let mut f = Fixture::new();
        f.group();
        let target = f.target(&grouped(3));
        let before = f.table.get(f.pid).unwrap().memory.get_brk();
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        assert_eq!(
            f.table
                .commit_exec_target(&mut NoopHost, f.pid, f.pid, target),
            Err(Errno::EBUSY)
        );
        assert_eq!(f.table.exec_generation(f.pid), Ok(0));
        assert_eq!(f.table.get(f.pid).unwrap().memory.get_brk(), before);
        assert!(
            f.table
                .get(f.pid)
                .unwrap()
                .prepared_exec_targets
                .get(target)
                .is_err()
        );
        cancel(&mut f, future);
    }

    #[test]
    fn committed_exec_consumes_competing_targets_and_sparse_cloexec_without_losing_open_peers() {
        let mut f = Fixture::new();
        f.group();
        for _ in 0..4 {
            f.target(&grouped(3));
        }
        let target = f.target(&grouped(3));
        let proc = f.table.get_mut(f.pid).unwrap();
        let keep = sys_open(
            proc,
            &mut NoopHost,
            b"/tmp/grouped-exec-admission",
            O_RDONLY,
            0,
        )
        .unwrap();
        let sparse = sys_fcntl(
            proc,
            keep,
            wasm_posix_shared::fcntl_cmd::F_DUPFD_CLOEXEC,
            256,
        )
        .unwrap();
        let close = sys_open(
            proc,
            &mut NoopHost,
            b"/tmp/grouped-exec-admission",
            O_RDONLY | O_CLOEXEC,
            0,
        )
        .unwrap();
        let future = f.table.prepare_grouped_exec(f.pid, f.pid, target).unwrap();
        f.table.configure_grouped_exec(layout(future)).unwrap();
        f.table
            .commit_exec_target(&mut NoopHost, f.pid, f.pid, target)
            .unwrap();
        let proc = f.table.get_mut(f.pid).unwrap();
        assert!(proc.prepared_exec_targets.drain().next().is_none());
        assert!(proc.fd_table.get(keep).is_ok());
        assert!(proc.fd_table.get(sparse).is_err());
        assert!(proc.fd_table.get(close).is_err());
    }

    #[test]
    fn pthread_exec_preserves_old_receipts_and_new_main_cannot_start_before_all_siblings_stop() {
        let mut f = Fixture::new();
        f.group();
        let old_main = f.table.memory_group_task(f.pid, f.pid).unwrap().unwrap();
        let tid = f.table.create_thread(f.pid, f.pid, 0x8000, 0, 0).unwrap();
        let old_thread = f.table.memory_group_task(f.pid, tid).unwrap().unwrap();
        f.table
            .memory_group_task_action(old_thread.record(), TaskAction::Start)
            .unwrap();
        let target = f.target_for(&grouped(3), tid);
        let future = f.table.prepare_grouped_exec(f.pid, tid, target).unwrap();
        f.table.configure_grouped_exec(layout(future)).unwrap();
        f.table
            .commit_exec_target(&mut NoopHost, f.pid, tid, target)
            .unwrap();
        assert_eq!(f.table.exec_generation(f.pid), Ok(1));
        assert!(f.table.get(f.pid).unwrap().get_thread(tid).is_none());
        f.table
            .memory_group_task_action(old_main.record(), TaskAction::BeginRetirement)
            .unwrap();
        f.table
            .memory_group_task_action(old_main.record(), TaskAction::RetireQuiescent)
            .unwrap();
        assert_eq!(
            f.table
                .memory_group_task_action(future.receipt.record(), TaskAction::Start),
            Err(Errno::EBUSY)
        );
        f.table
            .memory_group_task_action(old_thread.record(), TaskAction::BeginRetirement)
            .unwrap();
        f.table
            .memory_group_task_action(old_thread.record(), TaskAction::RetireQuiescent)
            .unwrap();
        f.table
            .memory_group_task_action(future.receipt.record(), TaskAction::Start)
            .unwrap();
    }
}
