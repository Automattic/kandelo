//! Executable-target admission follows the current kernel-owned image group.
//! This is preflight only, not replacement allocation or exec commit authority.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{memory_group::MemoryGroupLimits, process::test_host::NoopHost, syscalls::*};
    use alloc::{format, vec, vec::Vec};
    use wasm_posix_shared::{ABI_VERSION, flags::*};

    struct Fixture {
        table: ProcessTable,
        pid: u32,
        enabled: (bool, bool),
    }
    impl Fixture {
        fn new() -> Self {
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
        fn group(&mut self) {
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
        fn target(&mut self, bytes: &[u8]) -> u32 {
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
            let owner = PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: proc.exec_generation,
            };
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
        fn admission(&self, token: u32) -> Result<Admission, Errno> {
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
    fn grouped(version: u32) -> Vec<u8> {
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
