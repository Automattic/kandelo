//! Exact task/image custody for host-prepared grouped mappings. This module
//! owns metadata only: it grants no physical-page, device or execution fence.
//! Kernel-host transport and the normal syscall coordinator attach separately.
use crate::memory::change::{MemoryChange, PreparedMemoryChange};
use crate::process::ProcessState;
use crate::process_table::ProcessTable;
use wasm_posix_shared::{Errno, Syscall, memory_group::ReceiptRecord, mmap};
mod storage;

pub use crate::memory::change::MemoryChangeEffect as Effect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Description {
    pub token: u64,
    pub receipt: ReceiptRecord,
    pub effect: Effect,
    pub population_address: usize,
    pub population_length: usize,
    pub shared_object: u64,
    pub shared_length: u64,
    pub shared_offset: u64,
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
            old_address: old_address as u64, old_length: old_length as u64, result: self.result(), flags,
            population_address: self.population_address as u64, population_length: self.population_length as u64,
            shared_object: self.shared_object, shared_length: self.shared_length, shared_offset: self.shared_offset }
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
    population: Option<Population>,
    population_position: usize,
    population_eof: bool,
    control_thread: Option<crate::memory_group::GroupAdmission>,
    device: Option<crate::syscalls::GroupBoMap>,
    retirement: Option<crate::syscalls::DeviceUnmapPlan>,
}
pub(crate) struct Population {
    pub address: usize,
    pub len: usize,
    pub offset: u64,
    pub source: crate::private_mapping::Source,
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
            match flags & (mmap::MAP_SHARED | mmap::MAP_PRIVATE) {
                mmap::MAP_SHARED | mmap::MAP_PRIVATE => {},
                _ => return Err(Errno::EINVAL),
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
    /// Legacy mirror-based attachments cannot change a grouped image. This
    /// check belongs before attachment accounting, including before the image
    /// has installed its linear layout or exposed its first execution.
    pub fn validate_legacy_mapping_backend(&self, pid: u32) -> Result<(), Errno> {
        let proc = self.get(pid).ok_or(Errno::ESRCH)?;
        if self.process_memory_group(pid)?.is_some() || proc.memory.group_virtual_extent().is_some() {
            return Err(Errno::EOPNOTSUPP);
        }
        Ok(())
    }
    /// The same exact all-replica barrier used by mmap must precede driver
    /// construction. Its packet still belongs to the normal owned-resource
    /// receipt; this bridge supplies physical pages, never new DRM authority.
    pub fn prepare_group_owned_mapping(&mut self, pid: u32, tid: u32, observed_pages: u32,
        packet: &mut [u8], host: &mut dyn crate::process::HostIO,
    ) -> Result<Option<Description>, Errno> {
        use wasm_posix_shared::dri_owned as W;
        if packet.len() != core::mem::size_of::<W::Packet>() { return Err(Errno::EINVAL); }
        let action = u32::from_le_bytes(packet[4..8].try_into().unwrap());
        if !matches!(action, W::MMAP | W::MMAP_EXACT | W::UNMAP_EXACT) { return Err(Errno::EINVAL); }
        let receipt = self.running_group_memory_caller(pid, tid)?;
        let (proc, locks) = self.task_and_advisory_locks(pid, tid).ok_or(Errno::ESRCH)?;
        if proc.pending_group_memory_change.is_some() || crate::owned_resource::has_pending_mapping(proc) {
            return Err(Errno::EBUSY);
        }
        proc.memory.observe_group_virtual_growth(observed_pages)?;
        crate::owned_resource::ioctl(proc, locks, host, -1, packet)?;
        if u32::from_le_bytes(packet[52..56].try_into().unwrap()) != W::PENDING { return Ok(None); }
        let token = u32::from_le_bytes(packet[24..28].try_into().unwrap());
        let transaction = u64::from_le_bytes(packet[8..16].try_into().unwrap());
        if let Err(error) = crate::owned_resource::prepare_grouped_mapping_backing(proc, receipt, token, transaction) {
            crate::owned_resource::refuse_grouped_mapping_backing(proc, locks, host, tid, token, transaction, error)?;
            return Err(error);
        }
        crate::owned_resource::grouped_mapping_description(proc, receipt, token, transaction).map(Some)
    }

    pub fn validate_group_owned_mapping(&self, pid: u32, tid: u32, token: u32, transaction: u64,
    ) -> Result<Description, Errno> {
        let receipt = self.running_group_memory_caller(pid, tid)?;
        crate::owned_resource::grouped_mapping_description(self.get(pid).ok_or(Errno::ESRCH)?, receipt, token, transaction)
    }

    pub fn finish_group_owned_mapping(&mut self, pid: u32, tid: u32, token: u32, transaction: u64,
        errno: u32, host: &mut dyn crate::process::HostIO,
    ) -> Result<i32, Errno> {
        if errno == 0 { self.validate_group_owned_mapping(pid, tid, token, transaction)?; }
        self.finish_owned_mapping(host, pid, tid, token, transaction, errno)?;
        crate::owned_resource::mapping_result(self.get(pid).ok_or(Errno::ESRCH)?, token, transaction)
    }

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

    /// The owning host must first pause every replica and read the logical
    /// virtual extent under its root lock. Observe that actual growth before
    /// cloning the MM; physical Memory size is never an address-space bound.
    /// No PID is allocated for stale, busy or unsupported private-copy input.
    pub fn fork_group_memory_process(&mut self, receipt: ReceiptRecord, observed_pages: u32) -> Result<u32, Errno> {
        if self.running_group_memory_caller(receipt.pid, receipt.tid)? != receipt {
            return Err(Errno::ESRCH);
        }
        let proc = self.get_mut(receipt.pid).ok_or(Errno::ESRCH)?;
        if proc.pending_group_memory_change.is_some() || crate::owned_resource::has_pending_mapping(proc) {
            return Err(Errno::EBUSY);
        }
        // Only exact kernel-owned direct backings may survive as aliases.
        // Device and legacy descriptor effects still need their own owner.
        if proc.fb_binding.is_some() || !crate::syscalls::group_dri_bindings_supported(proc, receipt.group)
            || !proc.shm_mappings.is_empty() || proc.memory.has_unsupported_group_shared_mapping(receipt.group) {
            return Err(Errno::EOPNOTSUPP);
        }
        proc.memory.observe_group_virtual_growth(observed_pages)?;
        self.fork_process_for_caller_with_mode(receipt.pid, receipt.tid, wasm_posix_shared::fork_contract::Mode::Fork)
    }
    pub(crate) fn admitted_group_memory_caller(&self, pid: u32, tid: u32) -> Result<ReceiptRecord, Errno> {
        let admission = self.memory_group_task(pid, tid)?.ok_or(Errno::EOPNOTSUPP)?;
        self.memory_group_running_admission(admission)?;
        let proc = self.get(pid).ok_or(Errno::ESRCH)?;
        if !matches!(proc.state, ProcessState::Running | ProcessState::Stopped) { return Err(Errno::ESRCH); }
        if proc.pointer_width != 4 || proc.vfork_child { return Err(Errno::EOPNOTSUPP); }
        Ok(admission.record())
    }
    pub(crate) fn running_group_memory_caller(&self, pid: u32, tid: u32) -> Result<ReceiptRecord, Errno> {
        let receipt = self.admitted_group_memory_caller(pid, tid)?;
        if self.get(pid).ok_or(Errno::ESRCH)?.state != ProcessState::Running { return Err(Errno::EAGAIN); }
        Ok(receipt)
    }

    /// Rust selects the result address and retains both snapshots. Raw host
    /// addresses cannot mint task/image identity or consume another plan.
    #[cfg(test)]
    pub(crate) fn prepare_group_memory_change(&mut self, pid: u32, tid: u32, syscall: u32,
        args: [u64; 6], observed_pages: u32) -> Result<Description, Errno> {
        self.prepare_group_memory_change_with_io(pid, tid, syscall, args, observed_pages, &mut crate::process::test_host::NoopHost)
    }

    pub fn prepare_group_memory_change_with_io(&mut self, pid: u32, tid: u32, syscall: u32,
        args: [u64; 6], observed_pages: u32, host: &mut dyn crate::process::HostIO) -> Result<Description, Errno> {
        let receipt = self.running_group_memory_caller(pid, tid)?;
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        if proc.pending_group_memory_change.is_some() || crate::owned_resource::has_pending_mapping(proc) {
            return Err(Errno::EBUSY);
        }
        // Device and legacy shared-memory cleanup is not implied by a plan.
        // Direct anonymous objects already participate in exact image custody.
        if proc.fb_binding.is_some() || !crate::syscalls::group_dri_bindings_supported(proc, receipt.group)
            || !proc.shm_mappings.is_empty() || proc.memory.has_unsupported_group_shared_mapping(receipt.group) {
            return Err(Errno::EOPNOTSUPP);
        }
        let operation = intent(syscall, args)?;
        crate::syscalls::validate_group_device_change(proc, operation)?;
        let device = if syscall == Syscall::Mmap as u32 && args[3] & mmap::MAP_ANONYMOUS as u64 == 0 {
            let offset = args[5].checked_mul(4096).filter(|value| *value <= i64::MAX as u64).ok_or(Errno::EINVAL)?;
            let fd = i32::try_from(args[4] as i64).map_err(|_| Errno::EINVAL)?;
            crate::syscalls::GroupBoMap::from_fd(proc, fd, offset, pointer(args[1])?, args[2] as u32, args[3] as u32)?
        } else { None };
        let file = if device.is_none() && syscall == Syscall::Mmap as u32 && args[3] & mmap::MAP_ANONYMOUS as u64 == 0 {
            let offset = args[5].checked_mul(4096).filter(|value| *value <= i64::MAX as u64).ok_or(Errno::EINVAL)?;
            let fd = i32::try_from(args[4] as i64).map_err(|_| Errno::EINVAL)?;
            let ofd = proc.ofd_table.get(proc.fd_table.get(fd)?.ofd_ref.0).ok_or(Errno::EBADF)?;
            let immutable_shared = args[3] & mmap::MAP_SHARED as u64 != 0 && crate::rootfs::is_rootfs_file_handle(ofd.host_handle);
            if immutable_shared && args[2] & mmap::PROT_WRITE as u64 != 0 { return Err(Errno::EOPNOTSUPP); }
            let (source, stat) = crate::private_mapping::Source::capture_for_mapping(proc, fd, host, immutable_shared)?;
            if args[3] & mmap::MAP_SHARED as u64 != 0 {
                if !immutable_shared && !source.kernel_handle().is_some_and(crate::kernel_file_mapping::supports_group_storage) { return Err(Errno::EOPNOTSUPP); }
                if immutable_shared && offset.checked_add(args[1]).is_none_or(|end| end > (stat.st_size.saturating_add(65535) & !65535)) {
                    return Err(Errno::EOPNOTSUPP);
                }
                if args[2] & mmap::PROT_WRITE as u64 != 0
                    && ofd.status_flags() & wasm_posix_shared::flags::O_ACCMODE != wasm_posix_shared::flags::O_RDWR {
                    return Err(Errno::EACCES);
                }
            }
            let mut name = alloc::vec::Vec::new();
            name.try_reserve_exact(ofd.path.len().checked_add(11).ok_or(Errno::ENOMEM)?).map_err(|_| Errno::ENOMEM)?;
            name.extend_from_slice(&ofd.path);
            if ofd.file_type == crate::ofd::FileType::MemFd {
                name.insert(0, b'/'); name.extend_from_slice(b" (deleted)");
            }
            Some((alloc::rc::Rc::try_new(crate::memory::MappingFile { dev: stat.st_dev, ino: stat.st_ino, name,
                private_source: Some(source), group_shared: None }).map_err(|_| Errno::ENOMEM)?, offset))
        } else { None };
        // The owning host freezes all execution replicas first. This is the
        // image's logical root extent, never the common physical Memory size.
        proc.memory.observe_group_virtual_growth(observed_pages)?;
        // Pay for the pending owner before acquiring MemoryManager custody.
        // Ordinary processes retain only one optional pointer, not two inline
        // metadata snapshots. No allocation can fail after the live serial.
        let mut storage = crate::IoBox::try_new(None::<Pending>)?;
        let mut plan = proc.memory.prepare_memory_change_with_file(operation, file)?;
        let backing = match &device { Some(device) => device.prepare(&mut plan, receipt.group),
            None => plan.prepare_group_shared(receipt.group) };
        if let Err(error) = backing {
            proc.memory.cancel_memory_change(plan).expect("fresh shared mapping plan cancellation"); return Err(error);
        }
        let (shared_object, shared_length, shared_offset) = match plan.shared_record() {
            Ok(record) => record,
            Err(error) => { proc.memory.cancel_memory_change(plan).expect("fresh shared description cancellation"); return Err(error); }
        };
        let population = match plan.private_population() {
            Ok(value) => value,
            Err(error) => { proc.memory.cancel_memory_change(plan).expect("fresh private mapping plan cancellation"); return Err(error); }
        };
        let description = Description { token: plan.serial(), receipt, effect: plan.effect(),
            population_address: population.as_ref().map_or(0, |p| p.address),
            population_length: population.as_ref().map_or(0, |p| p.len), shared_object, shared_length, shared_offset };
        let retirement = match crate::syscalls::prepare_group_device_retirement(proc, plan.effect(), device.is_some()) {
            Ok(plan) => plan,
            Err(error) => { proc.memory.cancel_memory_change(plan).expect("refused device retirement cancellation"); return Err(error); }
        };
        *storage = Some(Pending { description, plan, population, population_position: 0, population_eof: false, control_thread: None,
            device, retirement });
        proc.pending_group_memory_change = Some(storage);
        Ok(description)
    }

    /// Reserve only the exact unconstructed pthread's control slot. The
    /// ordinary mapping transaction owns both MM snapshots and physical work.
    pub fn prepare_group_thread_control(&mut self, pid: u32, caller_tid: u32, thread_tid: u32,
        observed_pages: u32) -> Result<Description, Errno> {
        let receipt = self.running_group_memory_caller(pid, caller_tid)?;
        self.validate_task(pid, thread_tid)?;
        if thread_tid == pid { return Err(Errno::EINVAL); }
        let thread = self.memory_group_prepared_admission(crate::memory_group::GroupExecution {
            pid, tid: thread_tid, exec_generation: receipt.generation,
        })?;
        if thread.group().as_raw() != receipt.group { return Err(Errno::ESRCH); }
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        if proc.pending_group_memory_change.is_some() || crate::owned_resource::has_pending_mapping(proc) {
            return Err(Errno::EBUSY);
        }
        proc.memory.observe_group_virtual_growth(observed_pages)?;
        let mut storage = crate::IoBox::try_new(None::<Pending>)?;
        let plan = proc.memory.prepare_memory_change(MemoryChange::ReserveHost {
            len: wasm_posix_shared::process_memory::PAGES_PER_THREAD_SLOT as usize * 65536, owner: thread.record(),
        })?;
        let description = Description { token: plan.serial(), receipt, effect: plan.effect(), population_address: 0, population_length: 0, shared_object: 0, shared_length: 0, shared_offset: 0 };
        *storage = Some(Pending { description, plan, population: None, population_position: 0, population_eof: false, control_thread: Some(thread), device: None, retirement: None });
        proc.pending_group_memory_change = Some(storage);
        Ok(description)
    }

    /// Rebind an already mapped, retired host control to one exact new task.
    /// No guest address from the host chooses a slot, and no allocation occurs.
    pub fn reuse_group_thread_control(&mut self, pid: u32, caller_tid: u32, thread_tid: u32) -> Result<usize, Errno> {
        let receipt = self.running_group_memory_caller(pid, caller_tid)?;
        self.validate_task(pid, thread_tid)?;
        if thread_tid == pid { return Err(Errno::EINVAL); }
        let thread = self.memory_group_prepared_admission(crate::memory_group::GroupExecution {
            pid, tid: thread_tid, exec_generation: receipt.generation,
        })?;
        if thread.group().as_raw() != receipt.group { return Err(Errno::ESRCH); }
        self.get_mut(pid).ok_or(Errno::ESRCH)?.memory.claim_group_thread_control(thread.record())
    }

    /// Retain the full old receipt after ThreadInfo is gone. Neither a numeric
    /// address nor thread exit alone permits reuse while Worker custody lives.
    pub fn release_group_thread_control(&mut self, receipt: ReceiptRecord) -> Result<(), Errno> {
        if receipt.pid == receipt.tid { return Err(Errno::EINVAL); }
        if self.memory_groups().resolve_receipt(receipt).is_ok() || self.validate_task(receipt.pid, receipt.tid).is_ok() {
            return Err(Errno::EBUSY);
        }
        let proc = self.get_mut(receipt.pid).ok_or(Errno::ESRCH)?;
        if proc.exec_generation != receipt.generation { return Err(Errno::ESRCH); }
        proc.memory.release_group_thread_control(receipt)
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
        if let Some(thread) = pending.control_thread {
            if self.memory_group_prepared_admission(thread.execution())? != thread { return Err(Errno::ESRCH); }
        }
        proc.memory.validate_memory_change(&pending.plan)?;
        Ok(pending.description)
    }

    #[cfg(test)]
    pub(crate) fn commit_group_memory_change(&mut self, pid: u32, tid: u32, token: u64) -> Result<Description, Errno> {
        self.commit_group_memory_change_with_io(pid, tid, token, &mut crate::process::test_host::NoopHost)
    }

    pub fn commit_group_memory_change_with_io(&mut self, pid: u32, tid: u32, token: u64,
        host: &mut dyn crate::process::HostIO) -> Result<Description, Errno> {
        self.validate_group_memory_change(pid, tid, token)?;
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        let pending = proc.pending_group_memory_change.as_deref().and_then(Option::as_ref).ok_or(Errno::ESRCH)?;
        if pending.population.as_ref().is_some_and(|p| pending.population_position < p.len && !pending.population_eof) {
            return Err(Errno::EBUSY);
        }
        if let Some(device) = &pending.device { device.bind(pid, &pending.plan, host)?; }
        let mut storage = proc.pending_group_memory_change.take().ok_or(Errno::ESRCH)?;
        let mut pending = storage.take().expect("published group mapping owner");
        let device_effects = pending.device.is_some() || pending.retirement.is_some();
        if let Some(retirement) = pending.retirement.take() {
            retirement.commit_with_host(proc, host, pending.device.is_some());
        }
        match proc.memory.commit_memory_change(pending.plan) {
            Ok(_) => {
                if let Some(device) = pending.device { device.publish(proc, pending.description.result() as usize); }
                Ok(pending.description)
            },
            Err((error, plan)) => {
                assert!(!device_effects, "validated device publication failed after native effects: {error:?}");
                *storage = Some(Pending { plan, description: pending.description, population: pending.population,
                    population_position: pending.population_position, population_eof: pending.population_eof,
                    control_thread: pending.control_thread, device: pending.device, retirement: pending.retirement });
                proc.pending_group_memory_change = Some(storage);
                Err(error)
            }
        }
    }

    /// Cleanup remains possible after stop/thread exit/exec. A stale owner
    /// drops only its staging and never restores an old image's metadata.
    #[cfg(test)]
    pub(crate) fn cancel_group_memory_change(&mut self, pid: u32, tid: u32, token: u64) -> Result<(), Errno> {
        self.cancel_group_memory_change_with_io(pid, tid, token, &mut crate::process::test_host::NoopHost)
    }

    pub fn cancel_group_memory_change_with_io(&mut self, pid: u32, tid: u32, token: u64,
        host: &mut dyn crate::process::HostIO) -> Result<(), Errno> {
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
            if let Some(device) = pending.device {
                if let Some(effect) = device.retire() { crate::syscalls::apply_dri_release_effect(pid as i32, effect, host); }
            }
            return Ok(());
        }
        match proc.memory.cancel_memory_change(pending.plan) {
            Ok(()) => {
                if let Some(device) = pending.device {
                    if let Some(effect) = device.retire() { crate::syscalls::apply_dri_release_effect(pid as i32, effect, host); }
                }
                Ok(())
            },
            Err((error, plan)) => {
                *storage = Some(Pending { plan, description: pending.description, population: pending.population,
                    population_position: pending.population_position, population_eof: pending.population_eof,
                    control_thread: pending.control_thread, device: pending.device, retirement: pending.retirement });
                proc.pending_group_memory_change = Some(storage);
                Err(error)
            }
        }
    }

    pub fn read_group_memory_population(&mut self, pid: u32, tid: u32, token: u64, offset: u64,
        output: &mut [u8], host: &mut dyn crate::process::HostIO) -> Result<usize, Errno> {
        self.validate_group_memory_change(pid, tid, token)?;
        let proc = self.get_mut(pid).ok_or(Errno::ESRCH)?;
        let pending = proc.pending_group_memory_change.as_deref_mut().and_then(Option::as_mut).ok_or(Errno::ESRCH)?;
        let population = pending.population.as_ref().ok_or(Errno::EINVAL)?;
        let offset = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
        if offset != pending.population_position || output.is_empty() || pending.population_eof
            || offset > population.len || output.len() > population.len - offset { return Err(Errno::EINVAL); }
        let count = population.source.read(population.offset + offset as u64, output, host)?;
        pending.population_position += count;
        pending.population_eof = count == 0;
        Ok(count)
    }
}

/// Lifecycle cleanup drops provisional native pins before the live mapping
/// and OFD walks. Keep the exact MM token for the host's later physical cancel;
/// neither a stopped process nor a retired fd may leave a last BO hold whose
/// plain Rust Drop cannot deliver its native destruction notification.
pub(crate) fn retire_device_preparation(proc: &mut crate::process::Process) -> Option<crate::syscalls::DriReleaseEffect> {
    let pending = proc.pending_group_memory_change.as_deref_mut()?.as_mut()?;
    drop(pending.retirement.take());
    pending.device.take()?.retire()
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
    #[test]
    fn legacy_attachment_backend_is_refused_before_group_layout_or_execution() {
        let mut table = ProcessTable::new();
        let ordinary = table.create_process().unwrap();
        assert_eq!(table.validate_legacy_mapping_backend(ordinary), Ok(()));
        assert_eq!(table.validate_legacy_mapping_backend(ordinary + 1), Err(Errno::ESRCH));
        table.memory_groups().configure(64, 1).unwrap();
        let group = table.memory_groups().create(MemoryGroupLimits {
            maximum_pages: 64, maximum_processes: 2, maximum_tasks: 4,
        }).unwrap();
        let pid = table.create_process().unwrap();
        let admission = table.prepare_process_memory_group(group, pid).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.group_virtual_extent(), None);
        let before = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(table.validate_legacy_mapping_backend(pid), Err(Errno::EOPNOTSUPP));
        table.memory_groups().start(admission).unwrap();
        assert_eq!(table.validate_legacy_mapping_backend(pid), Err(Errno::EOPNOTSUPP));
        let after = table.memory_groups().snapshot(group).unwrap();
        assert_eq!((after.tasks, after.images, after.backings), (before.tasks, before.images, before.backings));
        assert!(table.get(pid).unwrap().shm_mappings.is_empty());
        assert_eq!(table.validate_legacy_mapping_backend(ordinary), Ok(()));
    }

    #[test]
    fn direct_memory_syscalls_cannot_commit_the_logical_half_of_a_group_change() {
        use crate::{process::test_host::NoopHost, syscalls};
        let (mut table, pid, admission) = setup(true);
        let prepared = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, map_args(), 4).unwrap();
        let address = prepared.result() as usize;
        table.commit_group_memory_change(pid, pid, prepared.token).unwrap();
        let counts = table.memory_groups().snapshot(admission.group()).unwrap();
        let proc = table.get_mut(pid).unwrap();
        let before: alloc::vec::Vec<_> = proc.memory.mappings().iter().map(|m| (m.addr, m.len, m.prot, m.flags)).collect();
        let reserved = proc.memory.reserved_regions().to_vec();
        let old_break = proc.memory.get_brk();
        let old_extent = proc.memory.group_virtual_extent();
        let mut host = NoopHost;
        assert_eq!(syscalls::sys_mmap(proc, &mut host, address, P, 3, ANON | mmap::MAP_FIXED, -1, 0), Err(Errno::EOPNOTSUPP));
        assert_eq!(syscalls::sys_munmap(proc, &mut host, address, P), Err(Errno::EOPNOTSUPP));
        assert_eq!(syscalls::sys_mremap(proc, &mut host, address, P, 2 * P, 1, 0), Err(Errno::EOPNOTSUPP));
        assert_eq!(syscalls::sys_mprotect(proc, address, P, 0), Err(Errno::EOPNOTSUPP));
        assert_eq!(syscalls::sys_brk(proc, old_break + P), old_break);
        assert_eq!(syscalls::sys_brk(proc, 0), old_break);
        assert_eq!(proc.memory.mappings().iter().map(|m| (m.addr, m.len, m.prot, m.flags)).collect::<alloc::vec::Vec<_>>(), before);
        assert_eq!(proc.memory.reserved_regions(), reserved);
        assert_eq!(proc.memory.get_brk(), old_break);
        assert_eq!(proc.memory.group_virtual_extent(), old_extent);
        let after = table.memory_groups().snapshot(admission.group()).unwrap();
        assert_eq!((after.tasks, after.images, after.backings), (counts.tasks, counts.images, counts.backings));
        // The staged group path remains usable after every legacy refusal.
        let unmap = table.prepare_group_memory_change(pid, pid, Syscall::Munmap as u32,
            [address as u64, P as u64, 0, 0, 0, 0], 5).unwrap();
        table.commit_group_memory_change(pid, pid, unmap.token).unwrap();
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
    }

    #[test]
    fn thread_control_reservation_is_staged_cancellable_and_protected_from_guest_remapping() {
        let (mut table, pid, _) = setup(true);
        let tid = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        let original = table.get(pid).unwrap().memory.reserved_regions().to_vec();
        let first = table.prepare_group_thread_control(pid, pid, tid, 4).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.reserved_regions(), original);
        assert_eq!(first.population_length, 0);
        let pending = table.get(pid).unwrap().pending_group_memory_change.as_deref().unwrap().as_ref().unwrap();
        assert_eq!(pending.plan.shared_record(), Ok((0, 0, 0)), "protected pthread controls are private storage, not a missing ordinary VMA");
        assert!(matches!(first.effect, Effect::Map { len, prot: 3, .. } if len == 4 * P));
        table.cancel_group_memory_change(pid, pid, first.token).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.reserved_regions(), original);
        let next = table.prepare_group_thread_control(pid, pid, tid, 4).unwrap();
        table.commit_group_memory_change(pid, pid, next.token).unwrap();
        let address = next.result();
        assert!(table.get(pid).unwrap().memory.reserved_regions().iter().any(|r| r.addr == address as usize && r.len == 4 * P));
        for (syscall, args) in [
            (Syscall::Munmap, [address, (4 * P) as u64, 0, 0, 0, 0]),
            (Syscall::Mprotect, [address, (4 * P) as u64, 1, 0, 0, 0]),
            (Syscall::Mmap, [address, (4 * P) as u64, 3, (ANON | mmap::MAP_FIXED) as u64, u64::MAX, 0]),
        ] {
            assert_eq!(table.prepare_group_memory_change(pid, pid, syscall as u32, args, 8), Err(Errno::EINVAL));
        }
    }
    fn committed_control(table: &mut ProcessTable, pid: u32) -> (u32, crate::memory_group::GroupAdmission, usize) {
        let tid = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        let thread = table.memory_group_task(pid, tid).unwrap().unwrap();
        let description = table.prepare_group_thread_control(pid, pid, tid, 4).unwrap();
        table.commit_group_memory_change(pid, pid, description.token).unwrap();
        (tid, thread, description.result() as usize)
    }
    fn retire_control_thread(table: &mut ProcessTable, pid: u32, tid: u32, thread: crate::memory_group::GroupAdmission) {
        table.get_mut(pid).unwrap().remove_thread(tid).unwrap();
        table.memory_groups().begin_retirement(thread).unwrap();
        table.memory_groups().retire_quiescent(thread).unwrap();
    }
    #[test]
    fn control_owner_outlives_threadinfo_and_reuses_only_after_exact_worker_retirement() {
        let (mut table, pid, _) = setup(true);
        let (tid, thread, address) = committed_control(&mut table, pid);
        table.memory_groups().start(thread).unwrap();
        assert_eq!(table.release_group_thread_control(thread.record()), Err(Errno::EBUSY));
        table.get_mut(pid).unwrap().remove_thread(tid).unwrap();
        assert_eq!(table.release_group_thread_control(thread.record()), Err(Errno::EBUSY));
        table.memory_groups().begin_retirement(thread).unwrap();
        table.memory_groups().quarantine(thread).unwrap();
        assert_eq!(table.release_group_thread_control(thread.record()), Err(Errno::EBUSY));
        table.memory_groups().retire_quiescent(thread).unwrap();
        table.release_group_thread_control(thread.record()).unwrap();
        let replacement_tid = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        assert_eq!(table.reuse_group_thread_control(pid, pid, replacement_tid), Ok(address));
        assert_eq!(table.reuse_group_thread_control(pid, pid, replacement_tid), Err(Errno::EBUSY));
        assert_eq!(table.release_group_thread_control(thread.record()), Err(Errno::ESRCH));
        assert_eq!(table.prepare_group_thread_control(pid, pid, replacement_tid, 8), Err(Errno::EBUSY));
        assert!(table.get(pid).unwrap().memory.reserved_regions().iter().any(|r| r.addr == address && r.len == 4 * P));
    }
    #[test]
    fn control_release_rejects_forged_receipts_and_pending_metadata_before_rebinding() {
        let (mut table, pid, _) = setup(true);
        let (tid, thread, address) = committed_control(&mut table, pid);
        table.memory_groups().start(thread).unwrap();
        retire_control_thread(&mut table, pid, tid, thread);
        let original = thread.record();
        for forged in [ReceiptRecord { serial: original.serial ^ (1 << 32), ..original },
            ReceiptRecord { generation: original.generation + 1, ..original },
            ReceiptRecord { group: original.group + 1, ..original }, ReceiptRecord { tid: tid + 100, ..original }] {
            assert_eq!(table.release_group_thread_control(forged), Err(Errno::ESRCH));
        }
        let pending = table.prepare_group_memory_change(pid, pid, Syscall::Brk as u32, [0; 6], 8).unwrap();
        assert_eq!(table.release_group_thread_control(original), Err(Errno::EBUSY));
        table.cancel_group_memory_change(pid, pid, pending.token).unwrap();
        table.release_group_thread_control(original).unwrap();
        let next = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        assert_eq!(table.reuse_group_thread_control(pid, pid, next), Ok(address));
        let admission = table.memory_group_task(pid, next).unwrap().unwrap();
        table.memory_groups().start(admission).unwrap();
        assert_eq!(table.reuse_group_thread_control(pid, pid, next), Err(Errno::EBUSY));
    }
    #[test]
    fn fork_inherits_reserved_controls_without_inheriting_their_parent_receipts_or_free_list() {
        let (mut table, pid, main) = setup(true);
        let (tid, thread, address) = committed_control(&mut table, pid);
        table.memory_groups().start(thread).unwrap();
        retire_control_thread(&mut table, pid, tid, thread);
        table.release_group_thread_control(thread.record()).unwrap();
        let child = table.fork_group_memory_process(main.record(), 8).unwrap();
        let child_main = table.memory_group_task(child, child).unwrap().unwrap();
        table.memory_groups().start(child_main).unwrap();
        let child_tid = table.create_thread(child, child, 0x8000, 0, 0).unwrap();
        assert_eq!(table.reuse_group_thread_control(child, child, child_tid), Err(Errno::ENOENT));
        let child_control = table.prepare_group_thread_control(child, child, child_tid, 8).unwrap();
        assert_ne!(child_control.result() as usize, address);
        table.cancel_group_memory_change(child, child, child_control.token).unwrap();
        let next = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        assert_eq!(table.reuse_group_thread_control(pid, pid, next), Ok(address));
    }
    #[test]
    fn control_owner_admission_failure_keeps_live_reservations_and_budget_unchanged() {
        let (mut table, pid, _) = setup(true);
        let tid = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        let original = table.get(pid).unwrap().memory.reserved_regions().to_vec();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        { let _limit = crate::io_buffer::test_budget(held);
          assert_eq!(table.prepare_group_thread_control(pid, pid, tid, 4), Err(Errno::ENOMEM)); }
        assert_eq!(table.get(pid).unwrap().memory.reserved_regions(), original);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        assert_eq!(table.reuse_group_thread_control(pid, pid, tid), Err(Errno::ENOENT));
    }
    #[test]
    fn thread_control_commit_requires_the_same_unconstructed_task() {
        let (mut table, pid, _) = setup(true);
        let tid = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        let description = table.prepare_group_thread_control(pid, pid, tid, 4).unwrap();
        let thread = table.memory_group_task(pid, tid).unwrap().unwrap();
        table.memory_groups().start(thread).unwrap();
        assert_eq!(table.validate_group_memory_change(pid, pid, description.token), Err(Errno::EBUSY));
        assert_eq!(table.commit_group_memory_change(pid, pid, description.token), Err(Errno::EBUSY));
        table.cancel_group_memory_change(pid, pid, description.token).unwrap();
        assert_eq!(table.prepare_group_thread_control(pid, pid, tid, 4), Err(Errno::EBUSY));
        assert_eq!(table.prepare_group_thread_control(pid, pid, pid, 4), Err(Errno::EINVAL));
        assert_eq!(table.prepare_group_thread_control(pid, pid, tid + 100, 4), Err(Errno::ESRCH));
    }
    #[test]
    fn private_fork_observes_actual_growth_before_child_snapshot_without_resetting_live_layout() {
        let (mut table, pid, admission) = setup(true);
        let d = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32,
            [0, P as u64, 1, ANON as u64, u64::MAX, 0], 4).unwrap();
        table.commit_group_memory_change(pid, pid, d.token).unwrap();
        let unmap = table.prepare_group_memory_change(pid, pid, Syscall::Munmap as u32,
            [(3 * P) as u64, P as u64, 0, 0, 0, 0], 5).unwrap();
        table.commit_group_memory_change(pid, pid, unmap.token).unwrap();
        let child = table.fork_group_memory_process(admission.record(), 8).unwrap();
        assert_eq!(child, 101);
        assert_eq!(table.get(pid).unwrap().fork_count, 1);
        for id in [pid, child] {
            let mm = &table.get(id).unwrap().memory;
            assert_eq!(mm.group_virtual_extent(), Some(8));
            assert_eq!(mm.group_virtual_maximum(), Some(64));
            assert_eq!(mm.mappings()[0].addr, 4 * P);
            assert_eq!(mm.mappings()[0].prot, 1);
            assert_eq!(mm.reserved_regions()[0].addr, 0);
        }
        let child_admission = table.memory_group_task(child, child).unwrap().unwrap();
        assert_eq!(child_admission.record().group, admission.record().group);
        assert_eq!(table.memory_group_running_admission(child_admission), Err(Errno::EBUSY));
        table.memory_groups().start(child_admission).unwrap();
        // A real inherited hole stays a hole; newly observed pages exist.
        assert_eq!(table.prepare_group_memory_change(child, child, Syscall::Mprotect as u32,
            [(3 * P) as u64, P as u64, 3, 0, 0, 0], 8), Err(Errno::ENOMEM));
        let protect = table.prepare_group_memory_change(child, child, Syscall::Mprotect as u32,
            [(6 * P) as u64, P as u64, 1, 0, 0, 0], 8).unwrap();
        table.commit_group_memory_change(child, child, protect.token).unwrap();
    }
    #[test]
    fn private_fork_refuses_stale_or_foreign_receipts_before_observing_growth_or_allocating_pid() {
        let (mut table, pid, admission) = setup(true);
        let receipt = admission.record();
        for stale in [ReceiptRecord { serial: receipt.serial ^ (1 << 40), ..receipt },
            ReceiptRecord { generation: receipt.generation + 1, ..receipt },
            ReceiptRecord { group: receipt.group + 1, ..receipt },
            ReceiptRecord { tid: pid + 99, ..receipt }] {
            assert_eq!(table.fork_group_memory_process(stale, 8), Err(Errno::ESRCH));
        }
        assert_eq!(table.get(pid).unwrap().memory.group_virtual_extent(), Some(4));
        assert_eq!(table.get(pid).unwrap().fork_count, 0);
        assert_eq!(table.create_process().unwrap(), 101);
    }
    #[test]
    fn private_fork_refuses_busy_stopped_or_invalid_extent_without_publishing_child() {
        let (mut table, pid, admission) = setup(false);
        assert_eq!(table.fork_group_memory_process(admission.record(), 8), Err(Errno::EBUSY));
        table.memory_groups().start(admission).unwrap();
        table.get_mut(pid).unwrap().state = ProcessState::Stopped;
        assert_eq!(table.fork_group_memory_process(admission.record(), 8), Err(Errno::EAGAIN));
        table.get_mut(pid).unwrap().state = ProcessState::Running;
        for pages in [3, 65, u32::MAX] {
            assert_eq!(table.fork_group_memory_process(admission.record(), pages), Err(Errno::EINVAL));
        }
        let pending = prepare(&mut table, pid);
        assert_eq!(table.fork_group_memory_process(admission.record(), 8), Err(Errno::EBUSY));
        table.cancel_group_memory_change(pid, pid, pending.token).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.group_virtual_extent(), Some(4));
        assert_eq!(table.get(pid).unwrap().fork_count, 0);
        assert_eq!(table.create_process().unwrap(), 101);
    }
    #[test]
    fn private_fork_refuses_shared_backing_before_growth_or_pid_allocation() {
        let (mut table, pid, admission) = setup(true);
        table.get_mut(pid).unwrap().memory.try_mmap_anonymous(0, P, 3,
            mmap::MAP_SHARED | mmap::MAP_ANONYMOUS).unwrap();
        assert_eq!(table.fork_group_memory_process(admission.record(), 8), Err(Errno::EOPNOTSUPP));
        assert_eq!(table.get(pid).unwrap().memory.group_virtual_extent(), Some(4));
        assert_eq!(table.get(pid).unwrap().fork_count, 0);
        assert_eq!(table.create_process().unwrap(), 101);
    }
    #[test]
    fn private_fork_from_pthread_uses_its_exact_receipt_and_callers_signal_mask() {
        let (mut table, pid, admission) = setup(true);
        let tid = table.create_thread(pid, pid, 0, 0, 0).unwrap();
        let thread = table.memory_group_task(pid, tid).unwrap().unwrap();
        table.memory_groups().start(thread).unwrap();
        let proc = table.get_mut(pid).unwrap();
        proc.signals.blocked = 0x11;
        proc.get_thread_mut(tid).unwrap().signals.blocked = 0x22;
        let mut wrong = thread.record(); wrong.serial = admission.record().serial;
        assert_eq!(table.fork_group_memory_process(wrong, 8), Err(Errno::ESRCH));
        let child = table.fork_group_memory_process(thread.record(), 8).unwrap();
        assert_eq!(child, 102);
        assert_eq!(table.get(child).unwrap().signals.blocked, 0x22);
        assert_eq!(table.get(child).unwrap().memory.group_virtual_extent(), Some(8));
        let receipt = table.memory_group_task(child, child).unwrap().unwrap().record();
        assert_eq!(receipt.pid, child); assert_eq!(receipt.tid, child);
        assert_eq!(receipt.group, admission.record().group);
        assert_ne!(receipt.serial, thread.record().serial);
    }
    fn file(table: &mut ProcessTable, pid: u32) -> (i32, i64) {
        use crate::syscalls::*;
        let proc = table.get_mut(pid).unwrap();
        let fd = sys_memfd_create(proc, b"private", 0).unwrap();
        let handle = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap().host_handle;
        let mut host = crate::process::test_host::NoopHost;
        sys_pwrite(proc, &mut host, fd, b"before", P as i64).unwrap();
        sys_pwrite(proc, &mut host, fd, b"growth", 2 * P as i64).unwrap();
        (fd, crate::kernel_file_mapping::mapping_handle_for(crate::ofd::FileType::MemFd, handle).unwrap())
    }
    #[test]
    fn private_mapping_retains_exact_file_across_fd_reuse_and_remap_growth() {
        use crate::syscalls::*;
        let (mut table, pid, _) = setup(true);
        let (fd, handle) = file(&mut table, pid);
        let args = [0, P as u64, 3, mmap::MAP_PRIVATE as u64, fd as u64, (P / 4096) as u64];
        let mut host = crate::process::test_host::NoopHost;
        let d = table.prepare_group_memory_change_with_io(pid, pid, Syscall::Mmap as u32, args, 4, &mut host).unwrap();
        assert_eq!(d.population_address as u64, d.result()); assert_eq!(d.population_length, P);
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token), Err(Errno::EBUSY));
        sys_close(table.get_mut(pid).unwrap(), &mut host, fd).unwrap();
        let replacement = sys_memfd_create(table.get_mut(pid).unwrap(), b"replacement", 0).unwrap();
        assert_eq!(replacement, fd);
        sys_pwrite(table.get_mut(pid).unwrap(), &mut host, replacement, b"wrong!", P as i64).unwrap();
        let mut bytes = [0; 6];
        assert_eq!(table.read_group_memory_population(pid, pid, d.token, 0, &mut bytes, &mut host), Ok(6));
        assert_eq!(&bytes, b"before");
        assert_eq!(table.read_group_memory_population(pid, pid, d.token ^ (1 << 40), 0, &mut bytes, &mut host), Err(Errno::ESRCH));
        assert_eq!(table.read_group_memory_population(pid, pid, d.token, P as u64, &mut bytes, &mut host), Err(Errno::EINVAL));
        assert_eq!(table.commit_group_memory_change(pid, pid, d.token), Err(Errno::EBUSY));
        let mut rest = [0; P - 6];
        assert_eq!(table.read_group_memory_population(pid, pid, d.token, 6, &mut rest, &mut host), Ok(P - 6));
        table.commit_group_memory_change(pid, pid, d.token).unwrap();
        let growth = [d.result(), P as u64, (2 * P) as u64, 1, 0, 0];
        let d = table.prepare_group_memory_change_with_io(pid, pid, Syscall::Mremap as u32, growth, 5, &mut host).unwrap();
        assert_eq!(d.population_address, d.result() as usize + P);
        assert_eq!(table.read_group_memory_population(pid, pid, d.token, 0, &mut bytes, &mut host), Ok(6));
        assert_eq!(&bytes, b"growth");
        assert_eq!(table.read_group_memory_population(pid, pid, d.token, 6, &mut rest, &mut host), Ok(0));
        table.commit_group_memory_change(pid, pid, d.token).unwrap();
        let d = table.prepare_group_memory_change_with_io(pid, pid, Syscall::Munmap as u32,
            [d.result(), (2 * P) as u64, 0, 0, 0, 0], 6, &mut host).unwrap();
        table.commit_group_memory_change(pid, pid, d.token).unwrap();
        assert!(crate::kernel_file_mapping::content_generation(handle).is_none());
        crate::private_mapping::drain_releases(&mut host).unwrap();
        sys_close(table.get_mut(pid).unwrap(), &mut host, replacement).unwrap();
    }

    #[test]
    fn cancelled_private_fixed_mapping_keeps_live_metadata_and_releases_source() {
        use crate::syscalls::*;
        let (mut table, pid, _) = setup(true);
        let initial = prepare(&mut table, pid);
        table.commit_group_memory_change(pid, pid, initial.token).unwrap();
        let old = table.get(pid).unwrap().memory.mappings().to_vec();
        let (fd, handle) = file(&mut table, pid);
        let mut host = crate::process::test_host::NoopHost;
        let args = [initial.result(), P as u64, 1, (mmap::MAP_PRIVATE | mmap::MAP_FIXED) as u64, fd as u64, 0];
        let d = table.prepare_group_memory_change_with_io(pid, pid, Syscall::Mmap as u32, args, 5, &mut host).unwrap();
        sys_close(table.get_mut(pid).unwrap(), &mut host, fd).unwrap();
        assert!(crate::kernel_file_mapping::content_generation(handle).is_some());
        assert_eq!(table.get(pid).unwrap().memory.mappings(), old);
        table.cancel_group_memory_change(pid, pid, d.token).unwrap();
        assert_eq!(table.get(pid).unwrap().memory.mappings(), old);
        assert!(crate::kernel_file_mapping::content_generation(handle).is_none());
        crate::private_mapping::drain_releases(&mut host).unwrap();
    }

    #[test]
    fn private_source_refuses_access_and_metadata_budget_before_mapping_custody() {
        use crate::syscalls::*;
        let (mut table, pid, _) = setup(true);
        let (fd, handle) = file(&mut table, pid);
        let index = table.get(pid).unwrap().fd_table.get(fd).unwrap().ofd_ref.0;
        let args = [0, P as u64, 3, mmap::MAP_PRIVATE as u64, fd as u64, 0];
        let mut host = crate::process::test_host::NoopHost;
        table.get_mut(pid).unwrap().ofd_table.get_mut(index).unwrap().set_status_flags_raw(wasm_posix_shared::flags::O_WRONLY);
        assert_eq!(table.prepare_group_memory_change_with_io(pid, pid, Syscall::Mmap as u32, args, 4, &mut host), Err(Errno::EACCES));
        table.get_mut(pid).unwrap().ofd_table.get_mut(index).unwrap().set_status_flags_raw(wasm_posix_shared::flags::O_RDONLY);
        // Writable private pages need readable bytes, not a writable descriptor.
        let d = table.prepare_group_memory_change_with_io(pid, pid, Syscall::Mmap as u32, args, 4, &mut host).unwrap();
        table.cancel_group_memory_change(pid, pid, d.token).unwrap();
        crate::private_mapping::drain_releases(&mut host).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(table.prepare_group_memory_change_with_io(pid, pid, Syscall::Mmap as u32, args, 4, &mut host), Err(Errno::ENOMEM));
        }
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
        sys_close(table.get_mut(pid).unwrap(), &mut host, fd).unwrap();
        assert!(crate::kernel_file_mapping::content_generation(handle).is_none());
    }
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
        let mut shared = map_args(); shared[3] = mmap::MAP_SHARED as u64;
        let mut file = map_args(); file[3] = mmap::MAP_PRIVATE as u64;
        for (nr, args, expected) in [(Syscall::Mmap as u32, wide, Errno::EINVAL),
            (Syscall::Mmap as u32, shared, Errno::EBADF),
            (Syscall::Mmap as u32, file, Errno::EBADF), (u32::MAX, map_args(), Errno::EINVAL)] {
            assert_eq!(table.prepare_group_memory_change(pid, pid, nr, args, table.get(pid).unwrap().memory.group_virtual_extent().unwrap()), Err(expected));
            assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
            assert!(!table.get(pid).unwrap().memory.has_pending_memory_change());
        }
    }
    #[test]
    fn anonymous_shared_identity_is_staged_cancellable_and_inherited_by_live_mm() {
        let (mut table, pid, admission) = setup(true);
        let mut args = map_args(); args[1] = (3 * P) as u64; args[3] = (mmap::MAP_SHARED | mmap::MAP_ANONYMOUS) as u64;
        let cancelled = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert_eq!(cancelled.shared_object, cancelled.token);
        assert_eq!((cancelled.shared_length, cancelled.shared_offset), ((3 * P) as u64, 0));
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        table.cancel_group_memory_change(pid, pid, cancelled.token).unwrap();
        let map = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert!(map.shared_object > cancelled.shared_object);
        table.commit_group_memory_change(pid, pid, map.token).unwrap();
        let parent = &table.get(pid).unwrap().memory;
        assert!(!parent.has_unsupported_group_shared_mapping(admission.record().group));
        assert!(parent.has_unsupported_group_shared_mapping(admission.record().group + 1));
        let child = table.fork_group_memory_process(admission.record(), 7).unwrap();
        let parent_file = table.get(pid).unwrap().memory.mappings()[0].file.clone().unwrap();
        let child_file = table.get(child).unwrap().memory.mappings()[0].file.clone().unwrap();
        assert!(alloc::rc::Rc::ptr_eq(&parent_file, &child_file));
        assert!(parent_file.group_shared.is_some());
        let change = table.prepare_group_memory_change(pid, pid, Syscall::Mprotect as u32,
            [map.result() + P as u64, P as u64, 1, 0, 0, 0], 7).unwrap();
        table.commit_group_memory_change(pid, pid, change.token).unwrap();
        let mappings = table.get(pid).unwrap().memory.mappings();
        assert_eq!(mappings.len(), 3);
        assert_eq!(mappings.iter().map(|m| m.file_offset).collect::<alloc::vec::Vec<_>>(), alloc::vec![0, P as u64, (2 * P) as u64]);
        assert!(mappings.iter().all(|m| alloc::rc::Rc::ptr_eq(m.file.as_ref().unwrap(), &parent_file)));
        let unmap = table.prepare_group_memory_change(pid, pid, Syscall::Munmap as u32,
            [map.result(), (3 * P) as u64, 0, 0, 0, 0], 7).unwrap();
        table.commit_group_memory_change(pid, pid, unmap.token).unwrap();
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        assert_eq!(table.get(child).unwrap().memory.mappings()[0].len, 3 * P);
    }
    #[test]
    fn shared_remap_preserves_offset_and_object_bounds_without_stranding_custody() {
        let (mut table, pid, _) = setup(true);
        let mut args = map_args(); args[1] = (3 * P) as u64; args[3] = (mmap::MAP_SHARED | mmap::MAP_ANONYMOUS) as u64;
        let map = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        table.commit_group_memory_change(pid, pid, map.token).unwrap();
        for size in [P, 3 * P] {
            let remap = table.prepare_group_memory_change(pid, pid, Syscall::Mremap as u32,
                [map.result(), if size == P { (3 * P) as u64 } else { P as u64 }, size as u64, 1, 0, 0], 7).unwrap();
            assert_eq!((remap.shared_object, remap.shared_length, remap.shared_offset), (map.token, (3 * P) as u64, 0));
            table.commit_group_memory_change(pid, pid, remap.token).unwrap();
        }
        assert_eq!(table.prepare_group_memory_change(pid, pid, Syscall::Mremap as u32,
            [map.result(), (3 * P) as u64, (4 * P) as u64, 1, 0, 0], 7), Err(Errno::EOPNOTSUPP));
        assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
        assert!(!table.get(pid).unwrap().memory.has_pending_memory_change());
        let remap = table.prepare_group_memory_change(pid, pid, Syscall::Mremap as u32,
            [map.result() + P as u64, (2 * P) as u64, P as u64, 1, 0, 0], 7).unwrap();
        assert_eq!(remap.shared_offset, P as u64);
        table.cancel_group_memory_change(pid, pid, remap.token).unwrap();
    }
    #[test]
    fn anonymous_shared_refuses_conflicting_flags_and_metadata_exhaustion_without_publication() {
        let (mut table, pid, _) = setup(true);
        let mut args = map_args(); args[3] |= mmap::MAP_SHARED as u64;
        assert_eq!(table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4), Err(Errno::EINVAL));
        args[3] = (mmap::MAP_SHARED | mmap::MAP_ANONYMOUS) as u64;
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        { let _limit = crate::io_buffer::test_budget(held);
          assert_eq!(table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4), Err(Errno::ENOMEM)); }
        assert!(table.get(pid).unwrap().memory.mappings().is_empty());
        assert!(table.get(pid).unwrap().pending_group_memory_change.is_none());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
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
    fn tmpfs_shared_object_promotion_rolls_back_and_reuses_one_kernel_identity() {
        use crate::syscalls::*;
        use wasm_posix_shared::flags::{O_CREAT, O_RDWR};
        let (mut table, pid, admission) = setup(true);
        let mut host = crate::process::test_host::NoopHost;
        let proc = table.get_mut(pid).unwrap();
        let handle = crate::tmpfs::open(b"/tmp/group-shared-native", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        crate::tmpfs::truncate_handle(handle, (2 * P - 17) as i64).unwrap();
        crate::tmpfs::write(handle, 0, b"initial").unwrap();
        let index = proc.ofd_table.create(crate::ofd::FileType::Regular, O_RDWR, handle, b"/tmp/group-shared-native".to_vec());
        let fd = proc.fd_table.alloc(crate::fd::OpenFileDescRef(index), 0).unwrap();
        let args = [0, (2 * P) as u64, 3, mmap::MAP_SHARED as u64, fd as u64, 0];
        let first = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert_eq!(first.shared_object, first.token);
        first.record().encode(&mut [0; wasm_posix_shared::group_memory_change::DESCRIPTION_BYTES]).unwrap();
        assert!(!crate::tmpfs::group_storage_committed(handle));
        table.cancel_group_memory_change(pid, pid, first.token).unwrap();
        assert!(!crate::tmpfs::group_storage_alive(admission.record().group, first.token));
        assert_eq!(crate::tmpfs::write(handle, 0, b"current"), Ok(7));
        let next = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert_ne!(next.shared_object, first.shared_object);
        assert_eq!(table.commit_group_memory_change(pid, pid, next.token), Err(Errno::EBUSY));
        let mut bytes = alloc::vec![0; 2 * P];
        let read = table.read_group_memory_population(pid, pid, next.token, 0, &mut bytes, &mut host).unwrap();
        assert_eq!(read, 2 * P - 17); assert_eq!(&bytes[..7], b"current");
        assert_eq!(table.read_group_memory_population(pid, pid, next.token, read as u64, &mut bytes[..17], &mut host), Ok(0));
        table.commit_group_memory_change(pid, pid, next.token).unwrap();
        assert!(crate::tmpfs::group_storage_committed(handle));
        assert_eq!(crate::tmpfs::size(handle), Ok((2 * P - 17) as i64));
        assert_eq!(crate::tmpfs::write(handle, 0, b"x"), Err(Errno::EOPNOTSUPP));
        let extent = table.get(pid).unwrap().memory.group_virtual_extent().unwrap();
        let alias = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, extent).unwrap();
        assert_eq!(alias.shared_object, next.shared_object); assert_eq!(alias.population_length, 0);
        table.commit_group_memory_change(pid, pid, alias.token).unwrap();
        assert!(!table.get(pid).unwrap().memory.has_unsupported_group_shared_mapping(admission.record().group));
    }
    #[test]
    fn memfd_shared_object_cancels_population_and_retains_exact_backing_after_close() {
        use crate::syscalls::*;
        let (mut table, pid, admission) = setup(true);
        let mut host = crate::process::test_host::NoopHost;
        let proc = table.get_mut(pid).unwrap();
        let fd = sys_memfd_create(proc, b"group-shared", 0).unwrap();
        sys_ftruncate(proc, &mut host, fd, (2 * P - 17) as i64).unwrap();
        sys_pwrite(proc, &mut host, fd, b"initial", 0).unwrap();
        let ofd = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
        let handle = crate::kernel_file_mapping::mapping_handle_for(ofd.file_type, ofd.host_handle).unwrap();
        let args = [0, (2 * P) as u64, 3, mmap::MAP_SHARED as u64, fd as u64, 0];
        let first = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert_eq!(first.shared_object, first.token);
        assert!(!crate::kernel_file_mapping::group_storage_committed(handle));
        assert_eq!(sys_pwrite(table.get_mut(pid).unwrap(), &mut host, fd, b"x", 0), Err(Errno::EOPNOTSUPP));
        table.cancel_group_memory_change(pid, pid, first.token).unwrap();
        assert!(!crate::kernel_file_mapping::group_storage_alive(admission.record().group, first.shared_object));
        assert_eq!(sys_pwrite(table.get_mut(pid).unwrap(), &mut host, fd, b"current", 0), Ok(7));
        let next = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert_ne!(next.shared_object, first.shared_object);
        assert_eq!(table.commit_group_memory_change(pid, pid, next.token), Err(Errno::EBUSY));
        let mut bytes = alloc::vec![0; 2 * P];
        let read = table.read_group_memory_population(pid, pid, next.token, 0, &mut bytes, &mut host).unwrap();
        assert_eq!(read, 2 * P - 17); assert_eq!(&bytes[..7], b"current");
        assert_eq!(table.read_group_memory_population(pid, pid, next.token, read as u64, &mut bytes[..17], &mut host), Ok(0));
        table.commit_group_memory_change(pid, pid, next.token).unwrap();
        assert!(crate::kernel_file_mapping::group_storage_committed(handle));
        let proc = table.get_mut(pid).unwrap();
        assert_eq!(sys_fstat(proc, &mut host, fd).unwrap().st_size, (2 * P - 17) as u64);
        assert_eq!(sys_lseek(proc, &mut host, fd, 0, wasm_posix_shared::seek::SEEK_END), Ok((2 * P - 17) as i64));
        assert_eq!(sys_ftruncate(proc, &mut host, fd, (2 * P - 17) as i64), Ok(()));
        assert_eq!(sys_ftruncate(proc, &mut host, fd, (3 * P) as i64), Err(Errno::EOPNOTSUPP));
        // This test exercises the logical plan without a physical storage owner.
        // Neither descriptor path may fall back to the discarded kernel bytes.
        assert_eq!(sys_pwrite(proc, &mut host, fd, b"x", 0), Err(Errno::EAGAIN));
        assert_eq!(sys_pread(proc, &mut host, fd, &mut bytes[..7], 0), Err(Errno::EAGAIN));
        let extent = proc.memory.group_virtual_extent().unwrap();
        let alias = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, extent).unwrap();
        assert_eq!(alias.shared_object, next.shared_object); assert_eq!(alias.population_length, 0);
        table.commit_group_memory_change(pid, pid, alias.token).unwrap();
        assert_eq!(crate::kernel_file_mapping::prepare_group_storage(handle, admission.record().group + 1, 999, 2 * P), Err(Errno::EACCES));
        sys_close(table.get_mut(pid).unwrap(), &mut host, fd).unwrap();
        assert!(crate::kernel_file_mapping::group_storage_alive(admission.record().group, next.shared_object));
        for d in [next, alias] {
            let extent = table.get(pid).unwrap().memory.group_virtual_extent().unwrap();
            let unmap = table.prepare_group_memory_change(pid, pid, Syscall::Munmap as u32,
                [d.result(), (2 * P) as u64, 0, 0, 0, 0], extent).unwrap();
            table.commit_group_memory_change(pid, pid, unmap.token).unwrap();
        }
        assert!(!crate::kernel_file_mapping::group_storage_alive(admission.record().group, next.shared_object));
        assert!(crate::kernel_file_mapping::content_generation(handle).is_none());
    }

    #[test]
    fn first_descriptor_slice_populates_and_retains_the_complete_object() {
        use crate::syscalls::*;
        let (mut table, pid, _) = setup(true);
        let mut host = crate::process::test_host::NoopHost;
        let fd = sys_memfd_create(table.get_mut(pid).unwrap(), b"offset-first", 0).unwrap();
        sys_ftruncate(table.get_mut(pid).unwrap(), &mut host, fd, (3 * P - 17) as i64).unwrap();
        sys_pwrite(table.get_mut(pid).unwrap(), &mut host, fd, b"prefix", 3).unwrap();
        sys_pwrite(table.get_mut(pid).unwrap(), &mut host, fd, b"middle", (P + 3) as i64).unwrap();
        let args = [0, P as u64, 3, mmap::MAP_SHARED as u64, fd as u64, (P / 4096) as u64];
        let first = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32, args, 4).unwrap();
        assert_eq!((first.shared_length, first.shared_offset), ((3 * P) as u64, P as u64));
        assert_eq!((first.population_address, first.population_length), (0, 3 * P));
        first.record().encode(&mut [0; wasm_posix_shared::group_memory_change::DESCRIPTION_BYTES]).unwrap();
        let mut bytes = alloc::vec![0; 3 * P];
        let count = table.read_group_memory_population(pid, pid, first.token, 0, &mut bytes, &mut host).unwrap();
        assert_eq!(count, 3 * P - 17);
        assert_eq!(&bytes[3..9], b"prefix"); assert_eq!(&bytes[P + 3..P + 9], b"middle");
        assert_eq!(table.read_group_memory_population(pid, pid, first.token, count as u64, &mut bytes[..17], &mut host), Ok(0));
        table.commit_group_memory_change(pid, pid, first.token).unwrap();
        let extent = table.get(pid).unwrap().memory.group_virtual_extent().unwrap();
        let alias = table.prepare_group_memory_change(pid, pid, Syscall::Mmap as u32,
            [0, (2 * P) as u64, 1, mmap::MAP_SHARED as u64, fd as u64, 0], extent).unwrap();
        assert_eq!(alias.shared_object, first.shared_object); assert_eq!(alias.shared_offset, 0);
        assert_eq!(alias.population_length, 0);
        table.commit_group_memory_change(pid, pid, alias.token).unwrap();
    }

    #[test]
    fn abandoned_group_file_preparation_does_not_leave_descriptor_mutation_frozen() {
        use crate::syscalls::*;
        for memfd in [false, true] {
            let (mut table, pid, _) = setup(true);
            let mut host = crate::process::test_host::NoopHost;
            let proc = table.get_mut(pid).unwrap();
            let fd = if memfd { sys_memfd_create(proc, b"abandoned", 0).unwrap() }
                else {
                    let flags = wasm_posix_shared::flags::O_CREAT | wasm_posix_shared::flags::O_RDWR;
                    let handle = crate::tmpfs::open(b"/tmp/group-abandoned", flags, 0o600, 0, 0).unwrap();
                    let index = proc.ofd_table.create(crate::ofd::FileType::Regular, flags, handle, b"/tmp/group-abandoned".to_vec());
                    proc.fd_table.alloc(crate::fd::OpenFileDescRef(index), 0).unwrap()
                };
            sys_ftruncate(proc, &mut host, fd, P as i64).unwrap();
            let ofd = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
            let handle = crate::kernel_file_mapping::mapping_handle_for(ofd.file_type, ofd.host_handle).unwrap();
            crate::kernel_file_mapping::pin(handle).unwrap();
            let object = crate::kernel_file_mapping::prepare_group_storage(handle, 1, 9999, P).unwrap();
            assert_eq!(sys_pwrite(proc, &mut host, fd, b"x", 0), Err(Errno::EOPNOTSUPP));
            drop(object); crate::kernel_file_mapping::unpin(handle);
            assert!(!crate::kernel_file_mapping::group_storage_alive(1, 9999));
            assert_eq!(sys_pwrite(proc, &mut host, fd, b"ok", 0), Ok(2));
            assert_eq!(sys_ftruncate(proc, &mut host, fd, 1), Ok(()));
            sys_close(proc, &mut host, fd).unwrap();
        }
    }

    #[test]
    fn memfd_promotion_refuses_preexisting_mapping_pin_without_moving_bytes() {
        let index = crate::descriptor_backing::with_memfds(|table| {
            let mut backing = crate::descriptor_backing::MemFdBacking::new();
            backing.write_at(0, b"initial").unwrap();
            table.alloc(backing)
        });
        let handle = crate::kernel_file_mapping::mapping_handle_for(crate::ofd::FileType::MemFd, -(index as i64 + 1)).unwrap();
        crate::kernel_file_mapping::pin(handle).unwrap();
        crate::kernel_file_mapping::pin(handle).unwrap();
        assert_eq!(crate::kernel_file_mapping::prepare_group_storage(handle, 1, 99, P), Err(Errno::EOPNOTSUPP));
        assert!(!crate::kernel_file_mapping::group_storage_alive(1, 99));
        assert_eq!(crate::kernel_file_mapping::size_and_mode(handle).unwrap().0, 7);
        crate::kernel_file_mapping::unpin(handle); crate::kernel_file_mapping::unpin(handle);
        assert!(crate::descriptor_backing::release_for_ofd(crate::ofd::FileType::MemFd, -(index as i64 + 1)));
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
