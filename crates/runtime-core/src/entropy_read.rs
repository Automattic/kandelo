//! Bounded, kernel-owned entropy reads into a caller's address space.
//!
//! The fd is resolved once. Continuations retain only an authenticated task,
//! image generation and copied destination metadata, never a payload or borrow.
use wasm_posix_shared::{Errno, Syscall, flags::*, platform_limits, abi::extended_syscalls::SYS_GETRANDOM};
use crate::{IoBuffer, PreparedMap, msghdr::NativeIovec, process::{HostIO, Process}};
use crate::prepared_map::{MapMemory, PreparedEntry};

/// Web Crypto's per-call byte quota, not a device read-size limit.
pub const ENTROPY_WINDOW_BYTES: usize = 65_536;
/// Bound synchronous work before returning control to the dedicated worker.
const WINDOWS_PER_TURN: usize = 16;
/// Outside the negated errno range; a pending batch has no guest result yet.
pub use wasm_posix_shared::abi::ENTROPY_READ_PENDING;

pub struct EntropyRead {
    tid: u32,
    generation: u64,
    entries: IoBuffer<NativeIovec>,
    entry: usize,
    offset: usize,
    delivered: usize,
    total: usize,
}

impl MapMemory for EntropyRead {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) } // entries carry their own I/O admission
}

impl EntropyRead {
    /// None leaves an ordinary descriptor on its existing single-operation path.
    pub fn prepare(
        proc: &Process, host: &mut dyn HostIO, tid: u32, syscall: u32,
        fd: i32, address: u64, length: u64,
    ) -> Result<Option<Self>, Errno> {
        if syscall != SYS_GETRANDOM {
            if syscall != Syscall::Read as u32 && syscall != Syscall::Readv as u32 {
                return Err(Errno::EINVAL);
            }
            let index = crate::syscalls::resolve_io_ofd(proc, fd)?;
            if !Self::is_device(proc, index)? { return Ok(None); }
        }
        let entries = if syscall == Syscall::Readv as u32 {
            crate::msghdr::read_iovecs(host, proc.pid as i32, address,
                u32::try_from(length).map_err(|_| Errno::EINVAL)?, proc.pointer_width)?
        } else {
            let length = usize::try_from(length).map_err(|_| Errno::EINVAL)?;
            if length > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES { return Err(Errno::EINVAL); }
            // Scalar C pointers retain the ordinary channel's null policy.
            if length != 0 && address == 0 { return Err(Errno::EFAULT); }
            let mut entries = IoBuffer::try_with_capacity(1)?;
            entries.push(NativeIovec { base: address, len: length });
            entries
        };
        Self::from_entries(proc, host, tid, entries).map(Some)
    }

    /// Called after normal I/O descriptor resolution; no host-side fd cache.
    pub fn is_device(proc: &Process, index: usize) -> Result<bool, Errno> {
        let ofd = proc.ofd_table.get(index).ok_or(Errno::EBADF)?;
        if ofd.file_type != crate::ofd::FileType::CharDevice
            || crate::syscalls::VirtualDevice::from_host_handle(ofd.host_handle)
                != Some(crate::syscalls::VirtualDevice::Urandom)
        { return Ok(false); }
        if ofd.is_path_only() || ofd.status_flags() & O_ACCMODE == O_WRONLY {
            return Err(Errno::EBADF);
        }
        Ok(true)
    }

    pub fn from_entries(proc: &Process, host: &mut dyn HostIO, tid: u32,
        entries: IoBuffer<NativeIovec>) -> Result<Self, Errno> {
        for entry in &*entries {
            if entry.len != 0 && host.proc_validate_range(proc.pid as i32, entry.base, entry.len) < 0 {
                return Err(Errno::EFAULT);
            }
        }
        let total = crate::msghdr::iovec_total(&entries)?;
        Ok(Self { tid, generation: proc.exec_generation, entries,
            entry: 0, offset: 0, delivered: 0, total })
    }

    pub fn is_empty(&self) -> bool { self.total == 0 }

    fn finish(&self, error: Errno) -> i32 {
        if self.delivered != 0 { self.delivered as i32 } else { -(error as i32) }
    }

    pub fn step(&mut self, proc: &Process, host: &mut dyn HostIO, interrupted: bool) -> i32 {
        if proc.exec_generation != self.generation { return -(Errno::ESRCH as i32); }
        if self.delivered == self.total { return self.delivered as i32; }
        if interrupted || proc.deliverable_for(self.tid) != 0 {
            return self.finish(Errno::EINTR);
        }
        let capacity = ENTROPY_WINDOW_BYTES.min(self.total - self.delivered);
        let mut window = match crate::guest_ptr::zeroed_io_staging(capacity, ENTROPY_WINDOW_BYTES) {
            Ok(window) => window, Err(error) => return self.finish(error),
        };
        for _ in 0..WINDOWS_PER_TURN {
            let length = capacity.min(self.total - self.delivered);
            if length == 0 { return self.delivered as i32; }
            let generated = match host.host_getrandom(&mut window[..length]) {
                Ok(n) if n > 0 && n <= length => n,
                Ok(_) => return self.finish(Errno::EIO),
                Err(error) => return self.finish(error),
            };
            // Generate whole windows even across iovec boundaries. Besides
            // bounding memory, this preserves the seeded source's 32-byte
            // block consumption independently of the caller's iovec splits.
            let mut copied = 0;
            while copied < generated {
                while self.entry < self.entries.len() && self.offset == self.entries[self.entry].len {
                    self.entry += 1;
                    self.offset = 0;
                }
                let entry = self.entries[self.entry];
                let length = (entry.len - self.offset).min(generated - copied);
                let Some(address) = entry.base.checked_add(self.offset as u64) else {
                    return self.finish(Errno::EFAULT);
                };
                if host.proc_write_bytes(proc.pid as i32, address, &window[copied..copied + length]) < 0 {
                    return self.finish(Errno::EFAULT);
                }
                self.offset += length;
                copied += length;
                self.delivered += length;
            }
            if generated < length { return self.delivered as i32; }
        }
        if self.delivered == self.total { self.delivered as i32 } else { ENTROPY_READ_PENDING }
    }
}

/// Tokens never repeat within a process, including across exec and cleanup.
pub struct EntropyReadLedger {
    reads: PreparedMap<i64, EntropyRead>,
    next_token: Option<i64>,
}

impl Default for EntropyReadLedger {
    fn default() -> Self { Self { reads: PreparedMap::new(), next_token: Some(1) } }
}

impl EntropyReadLedger {
    pub fn begin(&mut self, read: EntropyRead) -> Result<i64, Errno> {
        if self.reads.values().any(|active| active.tid == read.tid) { return Err(Errno::EBUSY); }
        let token = self.next_token.ok_or(Errno::EOVERFLOW)?;
        let prepared = self.reads.prepare_io(token, read)?;
        self.reads.publish_io(prepared);
        self.next_token = token.checked_add(1);
        Ok(token)
    }


    pub fn take(&mut self, tid: u32, token: i64) -> Result<EntropyReadBatch, Errno> {
        if self.reads.get(&token).is_none_or(|read| read.tid != tid) { return Err(Errno::EINVAL); }
        Ok(EntropyReadBatch(self.reads.remove_entry(&token).ok_or(Errno::EINVAL)?))
    }

    pub fn put_back(&mut self, batch: EntropyReadBatch) { self.reads.insert_prepared(batch.0); }
    pub fn clear(&mut self) { self.reads.clear(); }
    pub fn cancel_task(&mut self, tid: u32) {
        if let Some(token) = self.reads.iter().find_map(|(token, read)| (read.tid == tid).then_some(*token)) {
            self.reads.remove(&token);
        }
    }
}

/// Removed from the ledger during a synchronous batch; no mutable borrow of
/// process state crosses a host import, and restoring it cannot allocate.
pub struct EntropyReadBatch(PreparedEntry<i64, EntropyRead>);
impl EntropyReadBatch {
    pub fn step(&mut self, proc: &Process, host: &mut dyn HostIO, interrupted: bool) -> i32 {
        self.0.value_mut().step(proc, host, interrupted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::test_host::GuestMemoryHost;

    fn fixture(length: usize) -> (Process, GuestMemoryHost, EntropyRead) {
        let proc = Process::new(100);
        let mut host = GuestMemoryHost::new(4096, length + 2);
        host.entropy_fill_calls = true;
        host.memory.fill(0xa5);
        let read = EntropyRead::prepare(&proc, &mut host, 100, SYS_GETRANDOM,
            -1, 4097, length as u64).unwrap().unwrap();
        (proc, host, read)
    }

    #[test]
    fn increasing_reads_use_one_window_and_publish_each_prefix_before_continuing() {
        for length in [0, 1, 65535, 65536, 65537, 1048576, 3 * 1048576 + 29] {
            let (proc, mut host, mut read) = fixture(length);
            let baseline = crate::io_buffer::IO_MEMORY.usage().0;
            let mut turns = 0;
            loop {
                turns += 1;
                let result = read.step(&proc, &mut host, false);
                assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
                if result != ENTROPY_READ_PENDING { assert_eq!(result, length as i32); break; }
                assert_eq!(read.delivered, turns * WINDOWS_PER_TURN * ENTROPY_WINDOW_BYTES);
                assert_ne!(host.memory[read.delivered], 0xa5);
                assert_eq!(host.memory[read.delivered + 1], 0xa5);
            }
            assert!(host.entropy_max_window <= ENTROPY_WINDOW_BYTES);
            assert_eq!(host.entropy_calls, length.div_ceil(ENTROPY_WINDOW_BYTES));
            assert_eq!(host.memory[0], 0xa5);
            assert_eq!(host.memory[length + 1], 0xa5);
        }
    }

    #[test]
    fn entropy_failure_reports_only_the_delivered_prefix() {
        for failed_call in [1, 2, 5] {
            let length = 8 * ENTROPY_WINDOW_BYTES;
            let (proc, mut host, mut read) = fixture(length);
            host.entropy_failure_at = Some(failed_call);
            let prefix = (failed_call - 1) * ENTROPY_WINDOW_BYTES;
            assert_eq!(read.step(&proc, &mut host, false),
                if prefix == 0 { -(Errno::EIO as i32) } else { prefix as i32 });
            assert!(host.memory[prefix + 1..].iter().all(|&byte| byte == 0xa5));
        }
    }

    #[test]
    fn interruption_and_generation_change_never_replay_a_prefix() {
        let (mut proc, mut host, mut read) = fixture(4 * 1048576);
        assert_eq!(read.step(&proc, &mut host, false), ENTROPY_READ_PENDING);
        let calls = host.entropy_calls;
        assert_eq!(read.step(&proc, &mut host, true), 1048576);
        assert_eq!(host.entropy_calls, calls);
        proc.exec_generation += 1;
        assert_eq!(read.step(&proc, &mut host, false), -(Errno::ESRCH as i32));
        assert_eq!(host.entropy_calls, calls);
        let (proc, mut host, mut read) = fixture(1);
        assert_eq!(read.step(&proc, &mut host, true), -(Errno::EINTR as i32));
        assert_eq!(host.entropy_calls, 0);
    }

    #[test]
    fn invalid_huge_ranges_fail_before_entropy_or_payload_allocation() {
        let proc = Process::new(100);
        let mut host = GuestMemoryHost::new(4096, 16);
        for (address, length, error) in [(4097, 1 << 30, Errno::EFAULT),
            (u64::MAX, 2, Errno::EFAULT), (4097, u64::MAX, Errno::EINVAL), (0, 1, Errno::EFAULT)] {
            assert_eq!(EntropyRead::prepare(&proc, &mut host, 100, SYS_GETRANDOM,
                -1, address, length).err(), Some(error));
        }
        assert_eq!(host.entropy_calls, 0);
    }

    #[test]
    fn window_admission_refuses_before_generating_or_writing() {
        let (proc, mut host, mut read) = fixture(1048576);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(baseline);
        assert_eq!(read.step(&proc, &mut host, false), -(Errno::ENOMEM as i32));
        assert_eq!(host.entropy_calls, 0);
        assert!(host.memory.iter().all(|&byte| byte == 0xa5));
    }

    #[test]
    fn later_copy_fault_returns_the_previously_published_prefix() {
        let (proc, mut host, mut read) = fixture(2 * 1048576);
        assert_eq!(read.step(&proc, &mut host, false), ENTROPY_READ_PENDING);
        host.memory.truncate(1048576 + 1);
        assert_eq!(read.step(&proc, &mut host, false), 1048576);
    }

    #[test]
    fn kernel_selects_the_device_and_rejects_invalid_or_unreadable_descriptors() {
        let mut proc = Process::new(100);
        let mut host = GuestMemoryHost::new(4096, 8);
        assert!(EntropyRead::prepare(&proc, &mut host, 100, Syscall::Read as u32,
            0, 4096, 1).unwrap().is_none());
        assert_eq!(EntropyRead::prepare(&proc, &mut host, 100, Syscall::Read as u32,
            -1, 4096, 1).err(), Some(Errno::EBADF));
        let index = proc.fd_table.get(1).unwrap().ofd_ref.0;
        let ofd = proc.ofd_table.get_mut(index).unwrap();
        ofd.file_type = crate::ofd::FileType::CharDevice;
        ofd.host_handle = crate::syscalls::VirtualDevice::Urandom.host_handle();
        assert_eq!(EntropyRead::prepare(&proc, &mut host, 100, Syscall::Read as u32,
            1, 4096, 1).err(), Some(Errno::EBADF));
        assert_eq!(host.entropy_calls, 0);
    }

    #[test]
    fn iovec_metadata_is_copied_once_and_windows_cross_entries_at_both_widths() {
        for width in [4, 8] {
            let mut proc = Process::new(100);
            proc.pointer_width = width;
            let mut host = GuestMemoryHost::new(4096, 300000);
            host.entropy_fill_calls = true;
            let fd = 0;
            let index = proc.fd_table.get(fd).unwrap().ofd_ref.0;
            let ofd = proc.ofd_table.get_mut(index).unwrap();
            ofd.file_type = crate::ofd::FileType::CharDevice;
            ofd.host_handle = crate::syscalls::VirtualDevice::Urandom.host_handle();
            let entries = [(8192u64, 3u64), (9000, 0), (10000, 65537), (100000, 100000)];
            for (index, (base, len)) in entries.iter().enumerate() {
                let offset = 4096 + index as u64 * 2 * width as u64;
                host.poke(offset, &base.to_le_bytes()[..width as usize]);
                host.poke(offset + width as u64, &len.to_le_bytes()[..width as usize]);
            }
            let mut read = EntropyRead::prepare(&proc, &mut host, 100, Syscall::Readv as u32,
                fd, 4096, 4).unwrap().unwrap();
            host.poke(4096, &[0xff; 64]);
            assert_eq!(read.step(&proc, &mut host, false), 165540);
            assert_eq!(host.entropy_calls, 3);
            assert_eq!(host.peek(8192, 3), &[1; 3]);
            assert_eq!(host.peek(10000 + 65533, 4), &[2; 4]);
            assert_eq!(host.peek(100000, 1), &[2]);
        }
    }

    #[test]
    fn tokens_are_task_bound_one_shot_and_not_reused_after_clear() {
        let (proc, mut host, read) = fixture(1);
        let mut ledger = EntropyReadLedger::default();
        let token = ledger.begin(read).unwrap();
        assert!(ledger.take(101, token).is_err());
        let mut batch = ledger.take(100, token).unwrap();
        assert!(ledger.take(100, token).is_err());
        assert_eq!(batch.step(&proc, &mut host, false), 1);
        drop(batch);
        ledger.clear();
        let read = EntropyRead::prepare(&proc, &mut host, 100, SYS_GETRANDOM, -1, 4097, 1).unwrap().unwrap();
        assert!(ledger.begin(read).unwrap() > token);
        ledger.cancel_task(100);
        assert!(ledger.reads.is_empty());
    }

    #[test]
    fn chunking_preserves_existing_seeded_block_consumption_and_following_reads() {
        let length = 3 * 1048576 + 29;
        let (proc, mut host, mut read) = fixture(length);
        let mut reference = crate::image_build_determinism::Determinism::new(b"image-seed", 0).unwrap();
        let mut expected = alloc::vec![0; length];
        reference.fill_random(100, 100, &mut expected);
        host.entropy_seeded = Some(crate::image_build_determinism::Determinism::new(b"image-seed", 0).unwrap());
        while read.step(&proc, &mut host, false) == ENTROPY_READ_PENDING {}
        assert_eq!(host.peek(4097, length), expected);
        let mut next = [0; 257];
        reference.fill_random(100, 100, &mut next);
        host.host_getrandom(&mut expected[..257]).unwrap();
        assert_eq!(&expected[..257], &next);
    }
}
