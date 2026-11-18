//! Exact task/image custody for host-prepared grouped mappings. This module
//! owns metadata only: it grants no physical-page, device or execution fence.
//! Kernel-host transport and the normal syscall coordinator attach separately.
use crate::memory::change::{MemoryChange, PreparedMemoryChange};
use crate::process::ProcessState;
use crate::process_table::ProcessTable;
use wasm_posix_shared::{Errno, Syscall, memory_group::ReceiptRecord, mmap};

pub use crate::memory::change::MemoryChangeEffect as Effect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Description {
    pub token: u64,
    pub receipt: ReceiptRecord,
    pub effect: Effect,
}
impl Description {
    pub fn record(&self) -> wasm_posix_shared::group_memory_change::Description {
        let (kind, prot, address, length, old_address, old_length, flags) = match self.effect {
            Effect::Map { addr, len, prot, flags } => (1, prot, addr, len, 0, 0, flags),
            Effect::Unmap { addr, len } => (2, 0, addr, len, 0, 0, 0),
            Effect::Protect { addr, len, prot } => (3, prot, addr, len, 0, 0, 0),
            Effect::Remap { old_addr, old_len, new_addr, new_len, prot } => (4, prot, new_addr, new_len, old_addr, old_len, 0),
            Effect::Break { old, new } => (5, 3, new, 0, old, 0, 0),
        };
        wasm_posix_shared::group_memory_change::Description { receipt: self.receipt, token: self.token,
            kind, prot, address: address as u64, length: length as u64,
            old_address: old_address as u64, old_length: old_length as u64, result: self.result(), flags }
    }
    pub fn result(&self) -> u64 {
        match self.effect {
            Effect::Map { addr, .. } => addr as u64,
            Effect::Remap { new_addr, .. } => new_addr as u64,
            Effect::Break { new, .. } => new as u64,
            Effect::Unmap { .. } | Effect::Protect { .. } => 0,
        }
    }
}

pub(crate) struct Pending {
    description: Description,
    plan: PreparedMemoryChange,
}

fn pointer(value: u64) -> Result<usize, Errno> {
    // This backend is memory32 on every kernel/embedding pointer width.
    u32::try_from(value).map(|v| v as usize).map_err(|_| Errno::EINVAL)
}

fn intent(syscall: u32, args: [u64; 6]) -> Result<MemoryChange, Errno> {
    Ok(match syscall {
        n if n == Syscall::Mmap as u32 => {
            let prot = u32::try_from(args[2]).map_err(|_| Errno::EINVAL)?;
            let flags = u32::try_from(args[3]).map_err(|_| Errno::EINVAL)?;
            if flags & mmap::MAP_ANONYMOUS == 0 || flags & mmap::MAP_SHARED != 0 {
                // Descriptor/device/shared-object preparation must retain its
                // own real references and effects, never become anonymous.
                return Err(Errno::EOPNOTSUPP);
            }
            if flags & mmap::MAP_PRIVATE == 0 {
                return Err(Errno::EINVAL);
            }
            MemoryChange::Map { hint: pointer(args[0])?, len: pointer(args[1])?, prot, flags }
        }
        n if n == Syscall::Munmap as u32 => MemoryChange::Unmap {
            addr: pointer(args[0])?, len: pointer(args[1])?,
        },
        n if n == Syscall::Mprotect as u32 => MemoryChange::Protect {
            addr: pointer(args[0])?, len: pointer(args[1])?,
            prot: u32::try_from(args[2]).map_err(|_| Errno::EINVAL)?,
        },
        n if n == Syscall::Mremap as u32 => MemoryChange::Remap {
            addr: pointer(args[0])?, old_len: pointer(args[1])?, new_len: pointer(args[2])?,
            flags: u32::try_from(args[3]).map_err(|_| Errno::EINVAL)?,
        },
        n if n == Syscall::Brk as u32 => MemoryChange::Break { addr: pointer(args[0])? },
        _ => return Err(Errno::EINVAL),
    })
}

impl ProcessTable {
    pub fn install_group_memory_layout(&mut self, record: wasm_posix_shared::group_memory_layout::Record) -> Result<(), Errno> {
        use wasm_posix_shared::group_memory_layout::{FRESH, INHERITED};
        let receipt = self.admitted_group_memory_caller(record.receipt.pid, record.receipt.tid)?;
        if receipt != record.receipt || receipt.tid != receipt.pid { return Err(Errno::ESRCH); }
        let channel = pointer(record.channel)?;
        let channel_end = channel.checked_add(wasm_posix_shared::channel::MIN_CHANNEL_SIZE).ok_or(Errno::EINVAL)?;
        if channel % 4 != 0 { return Err(Errno::EINVAL); }
        let proc = self.get_mut(receipt.pid).ok_or(Errno::ESRCH)?;
        if crate::owned_resource::has_pending_mapping(proc) || proc.pending_group_memory_change.is_some() { return Err(Errno::EBUSY); }
        match record.mode {
            FRESH => {
                let (control_start, control_end) = (pointer(record.control_base)?, pointer(record.control_end)?);
                if channel < control_start || channel_end > control_end { return Err(Errno::EINVAL); }
                proc.memory.install_group_linear_layout(crate::memory::linear::InitialLayout {
                    initial_pages: record.initial_pages, maximum_pages: record.maximum_pages,
                    brk_base: pointer(record.brk_base)?, mmap_base: pointer(record.mmap_base)?, brk_limit: pointer(record.brk_limit)?,
                    control_start, control_end,
                })?;
            }
            INHERITED => {
                if proc.memory.group_virtual_extent() != Some(record.initial_pages)
                    || proc.memory.group_virtual_maximum() != Some(record.maximum_pages)
                    || [record.brk_base, record.mmap_base, record.brk_limit, record.control_base, record.control_end].iter().any(|value| *value != 0)
                    || !proc.memory.reserved_regions().iter().any(|region| region.addr <= channel && region.addr + region.len >= channel_end) {
                    return Err(Errno::EINVAL);
                }
            }
            _ => return Err(Errno::EINVAL),
        }
        proc.main_channel_addr = record.channel;
        Ok(())
    }

    pub fn group_memory_break(&self, pid: u32, tid: u32) -> Result<u64, Errno> {
        self.running_group_memory_caller(pid, tid)?;
        let proc = self.get(pid).ok_or(Errno::ESRCH)?;
        if proc.memory.group_virtual_extent().is_none() { return Err(Errno::EOPNOTSUPP); }
        Ok(proc.memory.get_brk() as u64)
    }
    fn admitted_group_memory_caller(&self, pid: u32, tid: u32) -> Result<ReceiptRecord, Errno> {
        let admission = self.memory_group_task(pid, tid)?.ok_or(Errno::EOPNOTSUPP)?;
        self.memory_group_running_admission(admission)?;
        let proc = self.get(pid).ok_or(Errno::ESRCH)?;
        if !matches!(proc.state, ProcessState::Running | ProcessState::Stopped) { return Err(Errno::ESRCH); }
        if proc.pointer_width != 4 || proc.vfork_child { return Err(Errno::EOPNOTSUPP); }
        Ok(admission.record())
    }
    fn running_group_memory_caller(&self, pid: u32, tid: u32) -> Result<ReceiptRecord, Errno> {
        let receipt = self.admitted_group_memory_caller(pid, tid)?;
        if self.get(pid).ok_or(Errno::ESRCH)?.state != ProcessState::Running { return Err(Errno::EAGAIN); }
        Ok(receipt)
    }

    /// Rust selects the result address and retains both snapshots. Raw host
    /// addresses cannot mint task/image identity or consume another plan.
    pub fn prepare_group_memory_change(&mut self, pid: u32, tid: u32, syscall: u32,
        args: [u64; 6], observed_pages: u32) -> Result<Description, Errno> {
        let receipt = self.running_group_memory_caller(pid, tid)?;
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        if proc.pending_group_memory_change.is_some() || crate::owned_resource::has_pending_mapping(proc) {
            return Err(Errno::EBUSY);
        }
        // Device and shared-memory cleanup is not implied by a metadata plan.
        // Refuse until those retained effects join the real coordinator.
        if proc.fb_binding.is_some() || !proc.dri_bindings.is_empty()
            || !proc.shm_mappings.is_empty() || proc.memory.has_shared_mapping() {
            return Err(Errno::EOPNOTSUPP);
        }
        let operation = intent(syscall, args)?;
        // The owning host freezes all execution replicas first. This is the
        // image's logical root extent, never the common physical Memory size.
        proc.memory.observe_group_virtual_growth(observed_pages)?;
        // Pay for the pending owner before acquiring MemoryManager custody.
        // Ordinary processes retain only one optional pointer, not two inline
        // metadata snapshots. No allocation can fail after the live serial.
        let mut storage = crate::IoBox::try_new(None::<Pending>)?;
        let plan = proc.memory.prepare_memory_change(operation)?;
        let description = Description { token: plan.serial(), receipt, effect: plan.effect() };
        *storage = Some(Pending { description, plan });
        proc.pending_group_memory_change = Some(storage);
        Ok(description)
    }

    pub fn validate_group_memory_change(&self, pid: u32, tid: u32, token: u64) -> Result<Description, Errno> {
        let proc = self.get(pid).ok_or(Errno::ESRCH)?;
        let pending = proc.pending_group_memory_change.as_deref().and_then(Option::as_ref).ok_or(Errno::ESRCH)?;
        if pending.description.token != token || pending.description.receipt.tid != tid
            || pending.description.receipt.generation != proc.exec_generation {
            return Err(Errno::ESRCH);
        }
        let receipt = self.running_group_memory_caller(pid, tid)?;
        if pending.description.receipt != receipt { return Err(Errno::ESRCH); }
        proc.memory.validate_memory_change(&pending.plan)?;
        Ok(pending.description)
    }

    pub fn commit_group_memory_change(&mut self, pid: u32, tid: u32, token: u64) -> Result<Description, Errno> {
        self.validate_group_memory_change(pid, tid, token)?;
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        let mut storage = proc.pending_group_memory_change.take().ok_or(Errno::ESRCH)?;
        let pending = storage.take().expect("published group mapping owner");
        match proc.memory.commit_memory_change(pending.plan) {
            Ok(_) => Ok(pending.description),
            Err((error, plan)) => {
                *storage = Some(Pending { plan, description: pending.description });
                proc.pending_group_memory_change = Some(storage);
                Err(error)
            }
        }
    }

    /// Cleanup remains possible after stop/thread exit/exec. A stale owner
    /// drops only its staging and never restores an old image's metadata.
    pub fn cancel_group_memory_change(&mut self, pid: u32, tid: u32, token: u64) -> Result<(), Errno> {
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        let pending = proc.pending_group_memory_change.as_deref().and_then(Option::as_ref).ok_or(Errno::ESRCH)?;
        if pending.description.token != token || pending.description.receipt.tid != tid {
            return Err(Errno::ESRCH);
        }
        let mut storage = proc.pending_group_memory_change.take().unwrap();
        let pending = storage.take().expect("published group mapping owner");
        if !proc.memory.owns_memory_change(&pending.plan) {
            // Exec may already have installed a different MemoryManager. Its
            // pending serial, if any, belongs to that successor exclusively.
            return Ok(());
        }
        match proc.memory.cancel_memory_change(pending.plan) {
            Ok(()) => Ok(()),
            Err((error, plan)) => {
                *storage = Some(Pending { plan, description: pending.description });
                proc.pending_group_memory_change = Some(storage);
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemoryManager;
    use crate::memory_group::{GroupAdmission, MemoryGroupLimits};
    const P: usize = 65536;
    const ANON: u32 = mmap::MAP_PRIVATE | mmap::MAP_ANONYMOUS;
    fn setup(start: bool) -> (ProcessTable, u32, GroupAdmission) {
        let mut table = ProcessTable::new();
        table.memory_groups().configure(128, 1).unwrap();
        let group = table.memory_groups().create(MemoryGroupLimits {
            maximum_pages: 64, maximum_processes: 4, maximum_tasks: 8,
        }).unwrap();
        let pid = table.create_process().unwrap();
        let mm = &mut table.get_mut(pid).unwrap().memory;
        mm.install_group_linear_layout(crate::memory::linear::InitialLayout { initial_pages: 4, maximum_pages: 64, brk_base: 3 * P, mmap_base: 4 * P, brk_limit: 64 * P, control_start: 0, control_end: 3 * P }).unwrap();
        let admission = table.prepare_process_memory_group(group, pid).unwrap();
        if start { table.memory_groups().start(admission).unwrap(); }
        (table, pid, admission)
    }
    fn map_args() -> [u64; 6] { [0, P as u64, 3, ANON as u64, u64::MAX, 0] }
    fn initial_record(admission: GroupAdmission) -> wasm_posix_shared::group_memory_layout::Record {
        wasm_posix_shared::group_memory_layout::Record { receipt: admission.record(), initial_pages: 4, maximum_pages: 64,
            brk_base: (3 * P) as u64, mmap_base: (4 * P) as u64, brk_limit: (64 * P) as u64,
            control_base: 0, control_end: (3 * P) as u64, channel: P as u64, mode: 0 }
    }
    #[test]
    fn layout_install_requires_exact_running_main_receipt_and_contains_whole_channel() {
        let (mut table, pid, admission) = setup(false); table.get_mut(pid).unwrap().memory = MemoryManager::new();
        let mut record = initial_record(admission);
        assert_eq!(table.install_group_memory_layout(record), Err(Errno::EBUSY)); table.memory_groups().start(admission).unwrap();
        record.receipt.serial ^= 1 << 40; assert_eq!(table.install_group_memory_layout(record), Err(Errno::ESRCH)); record.receipt = admission.record();
        record.channel = (3 * P - 4) as u64; assert_eq!(table.install_group_memory_layout(record), Err(Errno::EINVAL));
        assert!(table.get(pid).unwrap().memory.group_virtual_extent().is_none());
        record.channel = P as u64; table.get_mut(pid).unwrap().state = ProcessState::Stopped;
        table.install_group_memory_layout(record).unwrap();
        assert_eq!(table.group_memory_break(pid, pid), Err(Errno::EAGAIN));
        table.get_mut(pid).unwrap().state = ProcessState::Running;
        assert_eq!(table.group_memory_break(pid, pid), Ok((3 * P) as u64));
        assert_eq!(table.get(pid).unwrap().main_channel_addr, P as u64);
        assert_eq!(table.install_group_memory_layout(record), Err(Errno::EBUSY));
    }
    #[test]
    fn inherited_registration_preserves_live_fork_layout_and_refuses_extent_or_reset() {
        let (mut table, pid, _) = setup(true);
        let mapping = prepare(&mut table, pid); table.commit_group_memory_change(pid, pid, mapping.token).unwrap();
        let child = table.fork_process_for_caller(pid, pid).unwrap();
        let admission = table.memory_group_task(child, child).unwrap().unwrap(); table.memory_groups().start(admission).unwrap();
        let mut record = initial_record(admission); record.mode = 1; record.initial_pages = 5;
        record.brk_base = 0; record.mmap_base = 0; record.brk_limit = 0; record.control_end = 0;
        table.install_group_memory_layout(record).unwrap();
        assert_eq!(table.group_memory_break(child, child), Ok((3 * P) as u64));
        assert_eq!(table.get(child).unwrap().memory.mappings()[0].addr, 4 * P);
        record.initial_pages = 4; assert_eq!(table.install_group_memory_layout(record), Err(Errno::EINVAL));
        record.initial_pages = 5; record.brk_base = P as u64; assert_eq!(table.install_group_memory_layout(record), Err(Errno::EINVAL));
    }
    fn prepare(table: &mut ProcessTable, pid: u32) -> Description {
        table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, map_args(), table.get(pid).unwrap().memory.group_virtual_extent().unwrap()).unwrap()
    }
    #[test]
    fn kernel_selects_address_and_consumes_exact_commit_once() {
        let (mut table, pid, admission) = setup(true);
        let d = prepare(&mut table, pid);
        assert_eq!(d.receipt, admission.record()); assert!(d.token > 0);
        assert_eq!(d.result(), (4 * P) as u64);
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        assert!(crate::owned_resource::has_pending_mapping(table.get(pid).unwrap()));
        assert_eq!(table.validate_group_memory_change(pid, pid, d.token).unwrap(), d);
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token).unwrap(), d);
        assert_eq!(table.get(pid).unwrap().memory.mappings()[0].addr, 4 * P);
        assert!(!crate::owned_resource::has_pending_mapping(table.get(pid).unwrap()));
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token), Err(Errno::ESRCH));
        assert_eq!(table.cancel_group_memory_change(pid, pid, d.token), Err(Errno::ESRCH));
    }
    #[test]
    fn fixed_replacement_cancellation_preserves_old_interval() {
        let (mut table, pid, _) = setup(true);
        table.get_mut(pid).unwrap().memory.mmap_anonymous(4 * P, 2 * P, 3, ANON | mmap::MAP_FIXED);
        let before = table.get(pid).unwrap().memory.mappings().to_vec();
        let args = [(5 * P) as u64, P as u64, 1, (ANON | mmap::MAP_FIXED) as u64, 99, 7];
        // fd/offset are ignored for anonymous mappings, as on the ordinary path.
        let d = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, table.get(pid).unwrap().memory.group_virtual_extent().unwrap()).unwrap();
        assert_eq!(d.result(), (5 * P) as u64);
        assert_eq!(table.get(pid).unwrap().memory.mappings(), before);
        table.cancel_group_memory_change(pid, pid, d.token).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.mappings(), before);
    }
    #[test]
    fn receipt_phase_and_process_stop_prevent_preparation() {
        let (mut table, pid, admission) = setup(false);
        assert_eq!(table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, map_args(), table.get(pid).unwrap().memory.group_virtual_extent().unwrap()), Err(Errno::EBUSY));
        table.memory_groups().start(admission).unwrap();
        table.get_mut(pid).unwrap().state = ProcessState::Stopped;
        assert_eq!(table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, map_args(), table.get(pid).unwrap().memory.group_virtual_extent().unwrap()), Err(Errno::EAGAIN));
        assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
    }
    #[test]
    fn sibling_cannot_commit_or_cancel_and_busy_preparation_retains_no_extra_plan() {
        let (mut table, pid, _) = setup(true);
        let tid = table.create_thread(pid, pid, 0, 0, 0).unwrap();
        let thread = table.memory_group_task(pid, tid).unwrap().unwrap();
        table.memory_groups().start(thread).unwrap();
        let d = prepare(&mut table, pid);
        assert_eq!(table.commit_group_memory_change(pid, tid, d.token), Err(Errno::ESRCH));
        assert_eq!(table.cancel_group_memory_change(pid, tid, d.token), Err(Errno::ESRCH));
        assert_eq!(table.prepare_group_memory_change(pid, tid, Syscall::Mmap as u32, map_args(), table.get(pid).unwrap().memory.group_virtual_extent().unwrap()), Err(Errno::EBUSY));
        assert_eq!(table.validate_group_memory_change(pid, pid, d.token).unwrap(), d);
        table.cancel_group_memory_change(pid, pid, d.token).unwrap();
    }
    #[test]
    fn stopped_admission_cannot_commit_but_its_staging_can_be_cancelled() {
        let (mut table, pid, admission) = setup(true);
        let d = prepare(&mut table, pid);
        table.memory_groups().begin_retirement(admission).unwrap();
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token), Err(Errno::EBUSY));
        table.cancel_group_memory_change(pid, pid, d.token).unwrap();
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
    }
    #[test]
    fn changed_image_or_metadata_cannot_publish_an_old_plan() {
        let (mut table, pid, _) = setup(true);
        let d = prepare(&mut table, pid);
        let other = table.get_mut(pid).unwrap().memory.mmap_anonymous(0, P, 1, ANON);
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token), Err(Errno::EAGAIN));
        table.get_mut(pid).unwrap().exec_generation += 1u64 << 32;
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token), Err(Errno::ESRCH));
        table.cancel_group_memory_change(pid, pid, d.token).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.mappings()[0].addr, other);
        assert_eq!(table.get(pid).unwrap().memory.mappings()[0].prot, 1);
    }
    #[test]
    fn cancellation_of_displaced_manager_preserves_successor_transaction() {
        let (mut table, pid, _) = setup(true);
        let old = prepare(&mut table, pid);
        let mut successor = MemoryManager::new();
        let newer = successor.prepare_memory_change(MemoryChange::Map { hint: 0, len: P, prot: 1, flags: ANON }).unwrap();
        table.get_mut(pid).unwrap().memory = successor;
        table.get_mut(pid).unwrap().exec_generation += 1;
        table.cancel_group_memory_change(pid, pid, old.token).unwrap();
        table.get(pid).unwrap().memory.validate_memory_change(&newer).unwrap();
        table.get_mut(pid).unwrap().memory.cancel_memory_change(newer).unwrap();
    }
    #[test]
    fn invalid_wide_and_unimplemented_effects_never_acquire_a_plan() {
        let (mut table, pid, _) = setup(true);
        let mut wide = map_args(); wide[0] = 1u64 << 32;
        let mut shared = map_args(); shared[3] = (mmap::MAP_SHARED | mmap::MAP_ANONYMOUS) as u64;
        let mut file = map_args(); file[3] = mmap::MAP_PRIVATE as u64;
        for (nr, args, expected) in [(Syscall::Mmap as u32, wide, Errno::EINVAL),
            (Syscall::Mmap as u32, shared, Errno::EOPNOTSUPP),
            (Syscall::Mmap as u32, file, Errno::EOPNOTSUPP), (u32::MAX, map_args(), Errno::EINVAL)] {
            assert_eq!(table.prepare_group_memory_change(pid, pid, nr, args, table.get(pid).unwrap().memory.group_virtual_extent().unwrap()), Err(expected));
            assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
            assert!(!table.get(pid).unwrap().memory.has_pending_memory_change());
        }
    }
    #[test]
    fn prepared_protect_remap_unmap_and_break_publish_only_on_commit() {
        let (mut table, pid, _) = setup(true);
        let first = prepare(&mut table, pid); table.commit_group_memory_change(pid, pid, first.token).unwrap();
        for (nr, args) in [(Syscall::Mprotect, [(4 * P) as u64, P as u64, 1, 0, 0, 0]),
            (Syscall::Mremap, [(4 * P) as u64, P as u64, (2 * P) as u64, 1, 0, 0]),
            (Syscall::Munmap, [(4 * P) as u64, (2 * P) as u64, 0, 0, 0, 0]),
            (Syscall::Brk, [(5 * P) as u64, 0, 0, 0, 0, 0])] {
            let before = table.get(pid).unwrap().memory.mappings().to_vec();
            let d = table.prepare_group_memory_change(pid, pid, nr as u32, args, table.get(pid).unwrap().memory.group_virtual_extent().unwrap()).unwrap();
            assert_eq!(table.get(pid).unwrap().memory.mappings(), before);
            table.commit_group_memory_change(pid, pid, d.token).unwrap();
        }
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        assert_eq!(table.get(pid).unwrap().memory.get_brk(), 5 * P);
    }
    #[test]
    fn failed_metadata_admission_leaves_live_mapping_and_custody_intact() {
        let (mut table, pid, _) = setup(true);
        table.get_mut(pid).unwrap().memory.mmap_anonymous(0, P, 3, ANON);
        let before = table.get(pid).unwrap().memory.mappings().to_vec();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let _budget = crate::io_buffer::test_budget(held);
        assert_eq!(table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, map_args(), table.get(pid).unwrap().memory.group_virtual_extent().unwrap()), Err(Errno::ENOMEM));
        assert_eq!(table.get(pid).unwrap().memory.mappings(), before);
        assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
        assert!(!table.get(pid).unwrap().memory.has_pending_memory_change());
    }
}
