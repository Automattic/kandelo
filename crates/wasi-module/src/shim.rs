//! The 46 `wasi_snapshot_preview1` entry points.
//!
//! Generic over [`GuestMemory`] and [`Channel`], so every one of them runs on
//! the host against a byte buffer and a recording fake channel. That is what
//! makes this testable at all: the TypeScript it replaces can only be reached
//! through a real worker or a mocked `Atomics.wait`.
//!
//! Ported from `host/src/wasi-shim.ts:640-1614`, with the five chartered
//! defect fixes applied. Each fix is marked **DEFECT FIX** where it lands.

use wasi_abi::layout::{self, WasmStatFields};
use wasi_abi::translate::{self, poll_events};
use wasi_abi::types::{WasiFdflags, WasiLookupflags, WasiOflags};
use wasi_abi::{translate_linux_errno, WasiErrno, WASI_RIGHTS_ALL};
use wasm_posix_shared::abi::extended_syscalls;
use wasm_posix_shared::{flags, seek, Syscall};

use crate::channel::Channel;
use crate::mem::{read_iovec, GuestMemory};
use crate::preopen::PreopenTable;

/// Result of an entry point: WASI returns an errno for everything.
pub type WasiResult = Result<(), WasiErrno>;

/// Scratch layout inside the channel data area.
///
/// The TypeScript uses bare literals (`0`, `4096`, `CH_DATA_SIZE - 256`)
/// scattered across the entry points. Naming the regions makes the overlaps
/// checkable, and `debug_assert`s below pin that they do not collide.
mod scratch {
    use wasm_posix_shared::channel;

    /// Primary staging region: paths, stat buffers, timespecs, bulk transfer.
    pub const PRIMARY: u64 = 0;
    /// Secondary region, for calls that need two paths at once
    /// (`renameat`, `linkat`, `symlinkat`) or a path plus an output buffer.
    pub const SECONDARY: u64 = 4096;
    /// Bulk transfer region for `pread`/`pwrite`/`sock_*`/`getdents64`.
    /// The TypeScript reserves the same 256-byte tail margin.
    pub const BULK: u64 = 0;
    pub const BULK_CAPACITY: u64 = channel::DATA_SIZE as u64 - 256;
    /// Room a single resolved path may occupy in either region.
    pub const PATH_CAPACITY: u64 = SECONDARY - PRIMARY;
}

/// `utimensat` sentinel nanosecond values.
const UTIME_NOW: i64 = 0x3FFF_FFFF;
const UTIME_OMIT: i64 = 0x3FFF_FFFE;

/// WASI `fstflags` bits.
const FST_ATIM: u16 = 1;
const FST_ATIM_NOW: u16 = 2;
const FST_MTIM: u16 = 4;
const FST_MTIM_NOW: u16 = 8;

/// WASI `subclockflags`: bit 0 selects an absolute timeout.
const SUBSCRIPTION_CLOCK_ABSTIME: u16 = 1;

const NANOS_PER_SEC: u64 = 1_000_000_000;

pub struct WasiShim<M: GuestMemory, C: Channel> {
    pub mem: M,
    pub chan: C,
    preopens: PreopenTable,
    argv: StringBlob,
    env: StringBlob,
}

/// A NUL-separated run of strings sitting in guest memory.
///
/// The TypeScript holds `argv`/`env` as JavaScript `string[]` decoded from
/// `initData`. The module cannot: it has no allocator and no `TextDecoder`.
/// Instead the host writes the blob into memory once and hands over its
/// location, and the module walks the bytes. This also removes a round of
/// UTF-8 decode/encode that the TypeScript performs on every `args_get`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StringBlob {
    /// Address of the first byte.
    pub ptr: u32,
    /// Number of strings.
    pub count: u32,
    /// Total bytes, including every NUL terminator.
    pub bytes: u32,
}

impl<M: GuestMemory, C: Channel> WasiShim<M, C> {
    pub fn new(mem: M, chan: C, argv: StringBlob, env: StringBlob) -> Self {
        Self {
            mem,
            chan,
            preopens: PreopenTable::new(),
            argv,
            env,
        }
    }

    pub fn preopens(&self) -> &PreopenTable {
        &self.preopens
    }

    // ---------------------------------------------------------------- plumbing

    fn data(&self, offset: u64) -> u64 {
        self.chan.data_area() + offset
    }

    /// Issue a syscall and map a non-zero errno to a WASI errno.
    fn call(&self, nr: u32, args: [i64; 6]) -> Result<i64, WasiErrno> {
        let (result, errno) = self.chan.syscall(nr, args);
        if errno != 0 {
            return Err(translate_linux_errno(errno));
        }
        Ok(result)
    }

    /// Narrow an i64 syscall result to the u32 slot a WASI output expects.
    ///
    /// The TypeScript's `syscallResultNumber` guards the same narrowing. A
    /// result that does not fit is `EOVERFLOW` rather than a silently
    /// truncated byte count.
    fn narrow(result: i64) -> Result<u32, WasiErrno> {
        u32::try_from(result).map_err(|_| WasiErrno::Overflow)
    }

    /// Copy `len` bytes within guest memory, through a bounded stack buffer.
    fn copy_within(&self, dst: u64, src: u64, len: u64) -> WasiResult {
        self.mem.check_range(dst, len)?;
        self.mem.check_range(src, len)?;
        let mut chunk = [0u8; 512];
        let mut done = 0u64;
        while done < len {
            let n = (len - done).min(chunk.len() as u64) as usize;
            self.mem.read(src + done, &mut chunk[..n])?;
            self.mem.write(dst + done, &chunk[..n])?;
            done += n as u64;
        }
        Ok(())
    }

    /// Write a NUL-terminated resolved path into a scratch region and return
    /// the `(dirfd, path_addr)` pair the kernel's `*at` syscalls take.
    ///
    /// Mirrors `resolvePath` (`wasi-shim.ts:572`): a path under a preopened
    /// directory is prefixed with that directory, and the result is always
    /// passed with `AT_FDCWD` because the kernel resolves the absolute path.
    ///
    /// Unlike the TypeScript, an over-long path is `ENAMETOOLONG` rather than
    /// a `RangeError` escaping the shim as a JavaScript exception.
    fn resolve_path(
        &self,
        dirfd: u32,
        path_ptr: u32,
        path_len: u32,
        region: u64,
    ) -> Result<(i64, u64), WasiErrno> {
        let dest = self.data(region);
        let prefix: &[u8] = match self.preopens.get(dirfd) {
            // A preopen of "/" contributes no prefix: the TypeScript special
            // cases it so paths do not come out as "//foo".
            Some(b"/") | None => b"",
            Some(other) => other,
        };
        // Copy the prefix out of the table before writing, since `prefix`
        // borrows `self.preopens` while `write` borrows `self.mem`.
        let mut prefix_buf = [0u8; crate::preopen::MAX_PREOPEN_PATH];
        prefix_buf[..prefix.len()].copy_from_slice(prefix);
        let prefix_len = prefix.len() as u64;

        let first = if path_len == 0 {
            b'/'
        } else {
            self.mem.read_u8(path_ptr as u64)?
        };
        let needs_separator = first != b'/';
        let total = prefix_len + u64::from(needs_separator) + path_len as u64 + 1;
        if total > scratch::PATH_CAPACITY {
            return Err(WasiErrno::NameTooLong);
        }

        let mut cursor = dest;
        if prefix_len > 0 {
            self.mem.write(cursor, &prefix_buf[..prefix_len as usize])?;
            cursor += prefix_len;
        }
        if needs_separator {
            self.mem.write_u8(cursor, b'/')?;
            cursor += 1;
        }
        self.copy_within(cursor, path_ptr as u64, path_len as u64)?;
        cursor += path_len as u64;
        self.mem.write_u8(cursor, 0)?;

        Ok((flags::AT_FDCWD as i64, dest))
    }

    /// Read a kernel stat from a scratch region and write a WASI `filestat`.
    ///
    /// **DEFECT FIX 4.** Offsets come from `wasi_abi::layout::wasm_stat`,
    /// which derives them from the `WasmStat` struct with `offset_of!`. The
    /// TypeScript reads them by hand, and two of those reads straddle
    /// alignment padding.
    fn write_filestat(&self, stat_region: u64, filestat_ptr: u32) -> WasiResult {
        let mut raw = [0u8; layout::wasm_stat::SIZE];
        self.mem.read(self.data(stat_region), &mut raw)?;
        let fields = WasmStatFields::decode(&raw).ok_or(WasiErrno::Io)?;
        let mut out = [0u8; layout::filestat::SIZE];
        if !layout::encode_filestat(&fields, &mut out) {
            return Err(WasiErrno::Io);
        }
        self.mem.write(filestat_ptr as u64, &out)
    }

    /// Write the `(atim, mtim)` timespec pair `utimensat` takes, honoring the
    /// WASI `fstflags` NOW/OMIT selectors.
    fn write_utimens_pair(&self, region: u64, atim: u64, mtim: u64, fst_flags: u16) -> WasiResult {
        let base = self.data(region);
        let pair = |set: u16, now: u16, value: u64| -> (i64, i64) {
            if fst_flags & now != 0 {
                (0, UTIME_NOW)
            } else if fst_flags & set != 0 {
                (
                    (value / NANOS_PER_SEC) as i64,
                    (value % NANOS_PER_SEC) as i64,
                )
            } else {
                (0, UTIME_OMIT)
            }
        };
        let (a_sec, a_nsec) = pair(FST_ATIM, FST_ATIM_NOW, atim);
        let (m_sec, m_nsec) = pair(FST_MTIM, FST_MTIM_NOW, mtim);
        self.mem.write_u64(base, a_sec as u64)?;
        self.mem.write_u64(base + 8, a_nsec as u64)?;
        self.mem.write_u64(base + 16, m_sec as u64)?;
        self.mem.write_u64(base + 24, m_nsec as u64)?;
        Ok(())
    }

    /// Read a kernel timespec and fold it into a WASI nanosecond timestamp.
    fn read_timespec_nanos(&self, region: u64) -> Result<u64, WasiErrno> {
        let base = self.data(region);
        let sec = self.mem.read_i64(base)?;
        let nsec = self.mem.read_i64(base + 8)?;
        let sec = u64::try_from(sec).map_err(|_| WasiErrno::Overflow)?;
        let nsec = u32::try_from(nsec).map_err(|_| WasiErrno::Overflow)?;
        Ok(layout::wasi_timestamp(sec, nsec))
    }

    // ------------------------------------------------------------------- init

    /// Open `/` as the process's single preopened directory.
    ///
    /// Mirrors `init()` (`wasi-shim.ts:464`), which the host calls after the
    /// process is kernel-registered but before `_start`.
    ///
    /// Unlike the TypeScript, a failure here is REPORTED. The TypeScript
    /// silently leaves the preopen table empty when the open fails, and the
    /// guest then sees `fd_prestat_get(3)` return EBADF and concludes it has
    /// no filesystem -- a confusing symptom far from its cause.
    pub fn init(&mut self) -> WasiResult {
        let path = self.data(scratch::PRIMARY);
        self.mem.write(path, b"/\0")?;
        let fd = self.call(
            Syscall::Openat as u32,
            [
                flags::AT_FDCWD as i64,
                path as i64,
                (flags::O_RDONLY | flags::O_DIRECTORY) as i64,
                0,
                0,
                0,
            ],
        )?;
        if fd < 0 {
            return Err(WasiErrno::BadF);
        }
        self.preopens.insert(Self::narrow(fd)?, b"/")
    }

    // ------------------------------------------------------- args and environ

    fn blob_get(&self, blob: StringBlob, ptrs: u32, buf: u32) -> WasiResult {
        // Copy the blob verbatim, then publish a pointer at each string start.
        self.copy_within(buf as u64, blob.ptr as u64, blob.bytes as u64)?;
        let mut cursor = buf;
        let mut written = 0u32;
        for index in 0..blob.count {
            self.mem.write_u32(ptrs as u64 + index as u64 * 4, cursor)?;
            // Advance past this string's NUL.
            loop {
                if written >= blob.bytes {
                    return Err(WasiErrno::Inval);
                }
                let byte = self.mem.read_u8(cursor as u64)?;
                cursor += 1;
                written += 1;
                if byte == 0 {
                    break;
                }
            }
        }
        Ok(())
    }

    fn blob_sizes(&self, blob: StringBlob, count_out: u32, size_out: u32) -> WasiResult {
        self.mem.write_u32(count_out as u64, blob.count)?;
        self.mem.write_u32(size_out as u64, blob.bytes)
    }

    pub fn args_get(&self, argv_ptrs: u32, argv_buf: u32) -> WasiResult {
        self.blob_get(self.argv, argv_ptrs, argv_buf)
    }

    pub fn args_sizes_get(&self, argc_out: u32, argv_buf_size_out: u32) -> WasiResult {
        self.blob_sizes(self.argv, argc_out, argv_buf_size_out)
    }

    pub fn environ_get(&self, environ_ptrs: u32, environ_buf: u32) -> WasiResult {
        self.blob_get(self.env, environ_ptrs, environ_buf)
    }

    pub fn environ_sizes_get(&self, count_out: u32, size_out: u32) -> WasiResult {
        self.blob_sizes(self.env, count_out, size_out)
    }

    // ---------------------------------------------------------------- prestat

    pub fn fd_prestat_get(&self, fd: u32, prestat_ptr: u32) -> WasiResult {
        let len = self.preopens.get(fd).ok_or(WasiErrno::BadF)?.len() as u32;
        let mut out = [0u8; layout::prestat::SIZE];
        if !layout::encode_prestat_dir(len, &mut out) {
            return Err(WasiErrno::Io);
        }
        self.mem.write(prestat_ptr as u64, &out)
    }

    pub fn fd_prestat_dir_name(&self, fd: u32, path_ptr: u32, path_len: u32) -> WasiResult {
        let path = self.preopens.get(fd).ok_or(WasiErrno::BadF)?;
        let mut buf = [0u8; crate::preopen::MAX_PREOPEN_PATH];
        let n = path.len().min(path_len as usize);
        buf[..n].copy_from_slice(&path[..n]);
        self.mem.write(path_ptr as u64, &buf[..n])
    }

    // ------------------------------------------------------------------ fd ops

    pub fn fd_close(&mut self, fd: u32) -> WasiResult {
        self.call(Syscall::Close as u32, [fd as i64, 0, 0, 0, 0, 0])?;
        self.preopens.remove(fd);
        Ok(())
    }

    pub fn fd_read(&self, fd: u32, iovs: u32, iovs_len: u32, nread_out: u32) -> WasiResult {
        // The kernel reads the guest's iovec array directly, which is why
        // this can pass the raw pointer through rather than staging.
        let n = self.call(
            Syscall::Readv as u32,
            [fd as i64, iovs as i64, iovs_len as i64, 0, 0, 0],
        )?;
        self.mem.write_u32(nread_out as u64, Self::narrow(n)?)
    }

    pub fn fd_write(&self, fd: u32, iovs: u32, iovs_len: u32, nwritten_out: u32) -> WasiResult {
        let n = self.call(
            Syscall::Writev as u32,
            [fd as i64, iovs as i64, iovs_len as i64, 0, 0, 0],
        )?;
        self.mem.write_u32(nwritten_out as u64, Self::narrow(n)?)
    }

    /// Scatter `len` bytes from the bulk staging region across an iovec array.
    fn scatter(&self, iovs: u32, iovs_len: u32, len: u32) -> WasiResult {
        let mut remaining = len as u64;
        let mut src = self.data(scratch::BULK);
        for index in 0..iovs_len {
            if remaining == 0 {
                break;
            }
            let iov = read_iovec(&self.mem, iovs, index)?;
            let n = remaining.min(iov.buf_len as u64);
            self.copy_within(iov.buf as u64, src, n)?;
            src += n;
            remaining -= n;
        }
        Ok(())
    }

    /// Gather an iovec array into the bulk staging region, returning the
    /// number of bytes staged.
    fn gather(&self, iovs: u32, iovs_len: u32) -> Result<u32, WasiErrno> {
        let mut total = 0u64;
        let dst_base = self.data(scratch::BULK);
        for index in 0..iovs_len {
            let iov = read_iovec(&self.mem, iovs, index)?;
            let room = scratch::BULK_CAPACITY.saturating_sub(total);
            let n = room.min(iov.buf_len as u64);
            if n == 0 {
                break;
            }
            self.copy_within(dst_base + total, iov.buf as u64, n)?;
            total += n;
        }
        Ok(total as u32)
    }

    /// Total bytes an iovec array can receive, capped at the staging capacity.
    fn staged_capacity(&self, iovs: u32, iovs_len: u32) -> Result<u32, WasiErrno> {
        let total = crate::mem::iovec_total_len(&self.mem, iovs, iovs_len)?;
        Ok(total.min(scratch::BULK_CAPACITY) as u32)
    }

    pub fn fd_pread(
        &self,
        fd: u32,
        iovs: u32,
        iovs_len: u32,
        offset: u64,
        nread_out: u32,
    ) -> WasiResult {
        let want = self.staged_capacity(iovs, iovs_len)?;
        let n = self.call(
            Syscall::Pread as u32,
            [
                fd as i64,
                self.data(scratch::BULK) as i64,
                want as i64,
                offset as i64,
                0,
                0,
            ],
        )?;
        let read = Self::narrow(n)?;
        self.scatter(iovs, iovs_len, read)?;
        self.mem.write_u32(nread_out as u64, read)
    }

    pub fn fd_pwrite(
        &self,
        fd: u32,
        iovs: u32,
        iovs_len: u32,
        offset: u64,
        nwritten_out: u32,
    ) -> WasiResult {
        let staged = self.gather(iovs, iovs_len)?;
        let n = self.call(
            Syscall::Pwrite as u32,
            [
                fd as i64,
                self.data(scratch::BULK) as i64,
                staged as i64,
                offset as i64,
                0,
                0,
            ],
        )?;
        self.mem.write_u32(nwritten_out as u64, Self::narrow(n)?)
    }

    pub fn fd_seek(&self, fd: u32, offset: i64, whence: u32, new_offset_out: u32) -> WasiResult {
        let posix_whence = translate::wasi_whence_to_posix(whence).ok_or(WasiErrno::Inval)?;
        // Kandelo's lseek ABI carries the signed offset as low-u32/high-i32
        // words. That is the KERNEL's contract, not a JavaScript workaround,
        // so the split survives the port.
        let (low, high) = translate::split_signed_i64_words(offset);
        let result = self.call(
            Syscall::Seek as u32,
            [
                fd as i64,
                low as i64,
                high as i64,
                posix_whence as i64,
                0,
                0,
            ],
        )?;
        self.mem.write_u64(new_offset_out as u64, result as u64)
    }

    pub fn fd_tell(&self, fd: u32, offset_out: u32) -> WasiResult {
        let result = self.call(
            Syscall::Seek as u32,
            [fd as i64, 0, 0, seek::SEEK_CUR as i64, 0, 0],
        )?;
        self.mem.write_u64(offset_out as u64, result as u64)
    }

    pub fn fd_sync(&self, fd: u32) -> WasiResult {
        self.call(Syscall::Fsync as u32, [fd as i64, 0, 0, 0, 0, 0])?;
        Ok(())
    }

    pub fn fd_datasync(&self, fd: u32) -> WasiResult {
        self.call(Syscall::Fdatasync as u32, [fd as i64, 0, 0, 0, 0, 0])?;
        Ok(())
    }

    pub fn fd_fdstat_get(&self, fd: u32, fdstat_ptr: u32) -> WasiResult {
        self.call(
            Syscall::Fstat as u32,
            [fd as i64, self.data(scratch::PRIMARY) as i64, 0, 0, 0, 0],
        )?;
        let mode = self
            .mem
            .read_u32(self.data(scratch::PRIMARY) + layout::wasm_stat::ST_MODE as u64)?;
        let filetype = translate::mode_to_filetype(mode);

        // A failing fcntl leaves the flags at zero rather than failing the
        // whole call, matching the TypeScript: the filetype is the load-
        // bearing half of fdstat and is already known.
        let fdflags = match self.call(
            Syscall::Fcntl as u32,
            [fd as i64, translate::F_GETFL as i64, 0, 0, 0, 0],
        ) {
            Ok(raw) => translate::posix_flags_to_wasi_fdflags(raw as u32).bits() as u16,
            Err(_) => 0,
        };

        let mut out = [0u8; layout::fdstat::SIZE];
        if !layout::encode_fdstat(filetype, fdflags, WASI_RIGHTS_ALL, WASI_RIGHTS_ALL, &mut out) {
            return Err(WasiErrno::Io);
        }
        self.mem.write(fdstat_ptr as u64, &out)
    }

    /// **DEFECT FIX 3.** The TypeScript maps only APPEND and NONBLOCK and then
    /// returns success, so a guest that asked for synchronised writes is told
    /// it got them. The kernel has no `O_SYNC`/`O_DSYNC`/`O_RSYNC` at all, so
    /// the honest answer is `ENOTSUP`.
    pub fn fd_fdstat_set_flags(&self, fd: u32, fdflags: u16) -> WasiResult {
        let posix = translate::wasi_fdflags_to_setfl(WasiFdflags(fdflags as u32))?;
        self.call(
            Syscall::Fcntl as u32,
            [
                fd as i64,
                translate::F_SETFL as i64,
                posix as i64,
                0,
                0,
                0,
            ],
        )?;
        Ok(())
    }

    /// Kandelo does not model per-fd rights, so there is nothing to set. A
    /// no-op is the API's correct compatibility behavior, not a stub hiding a
    /// gap.
    pub fn fd_fdstat_set_rights(&self) -> WasiResult {
        Ok(())
    }

    pub fn fd_filestat_get(&self, fd: u32, filestat_ptr: u32) -> WasiResult {
        self.call(
            Syscall::Fstat as u32,
            [fd as i64, self.data(scratch::PRIMARY) as i64, 0, 0, 0, 0],
        )?;
        self.write_filestat(scratch::PRIMARY, filestat_ptr)
    }

    pub fn fd_filestat_set_size(&self, fd: u32, size: u64) -> WasiResult {
        self.call(
            Syscall::Ftruncate as u32,
            [fd as i64, size as i64, 0, 0, 0, 0],
        )?;
        Ok(())
    }

    pub fn fd_filestat_set_times(
        &self,
        fd: u32,
        atim: u64,
        mtim: u64,
        fst_flags: u16,
    ) -> WasiResult {
        self.write_utimens_pair(scratch::PRIMARY, atim, mtim, fst_flags)?;
        // The fd variant passes the fd as dirfd with an empty path.
        let empty = self.data(scratch::PRIMARY) + 32;
        self.mem.write_u8(empty, 0)?;
        self.call(
            Syscall::Utimensat as u32,
            [
                fd as i64,
                empty as i64,
                self.data(scratch::PRIMARY) as i64,
                0,
                0,
                0,
            ],
        )?;
        Ok(())
    }

    pub fn fd_allocate(&self, fd: u32, offset: u64, len: u64) -> WasiResult {
        // Kandelo follows Linux: (fd, mode, offset, len). WASI exposes only
        // allocation mode zero.
        self.call(
            extended_syscalls::SYS_FALLOCATE,
            [fd as i64, 0, offset as i64, len as i64, 0, 0],
        )?;
        Ok(())
    }

    /// Advisory only; the kernel has no readahead policy to set.
    pub fn fd_advise(&self) -> WasiResult {
        Ok(())
    }

    /// **DEFECT FIX 5.** `fd_readdir`'s cookie handling.
    ///
    /// The TypeScript issues a fresh `getdents64` on every call and then skips
    /// `cookie` entries of whatever came back (`wasi-shim.ts:1058-1063`). But
    /// `getdents64` advances the directory fd's offset, so the second call
    /// reads the NEXT batch and discards `cookie` entries of *those*: a
    /// directory larger than one batch silently loses entries. Only the
    /// single-batch case -- all the fixtures exercise -- works.
    ///
    /// The fix uses the cookie for what it is: an opaque resume position.
    /// Each emitted dirent carries the Linux `d_off` of the entry AFTER it as
    /// its `d_next`, and a non-zero incoming cookie seeks the fd there before
    /// reading. That is the same contract wasi-libc and wasmtime implement,
    /// and it keeps working across as many batches as the guest asks for.
    pub fn fd_readdir(
        &self,
        fd: u32,
        buf: u32,
        buf_len: u32,
        cookie: u64,
        size_out: u32,
    ) -> WasiResult {
        if cookie != 0 {
            let (low, high) = translate::split_signed_i64_words(cookie as i64);
            self.call(
                Syscall::Seek as u32,
                [
                    fd as i64,
                    low as i64,
                    high as i64,
                    seek::SEEK_SET as i64,
                    0,
                    0,
                ],
            )?;
        }

        let staging = self.data(scratch::BULK);
        let max_read = scratch::BULK_CAPACITY.min(32768);
        let mut written = 0u32;

        'batches: loop {
            let got = self.call(
                Syscall::Getdents64 as u32,
                [fd as i64, staging as i64, max_read as i64, 0, 0, 0],
            )?;
            let got = Self::narrow(got)?;
            if got == 0 {
                break;
            }

            let mut consumed = 0u32;
            while consumed < got {
                // Read the record header plus enough of the name to decode.
                //
                // 512 bytes holds any record the kernel can produce: a Linux
                // `dirent64` is a 19-byte header plus a NUL-terminated name,
                // and NAME_MAX is 255, so the longest possible record is 275
                // bytes. A record that somehow exceeded this buffer would fail
                // `decode_linux_dirent`'s `reclen > buf.len()` check and
                // surface as EIO rather than being silently truncated.
                let remaining = (got - consumed) as usize;
                let mut record = [0u8; 512];
                let take = remaining.min(record.len());
                self.mem
                    .read(staging + consumed as u64, &mut record[..take])?;
                let (entry, reclen) = match layout::decode_linux_dirent(&record[..take]) {
                    Some(decoded) => decoded,
                    // A malformed record is the kernel's problem, not
                    // something to loop forever on.
                    None => return Err(WasiErrno::Io),
                };

                let name_len = entry.name.len() as u32;
                let mut header = [0u8; layout::dirent::HEADER_SIZE];
                if !layout::encode_dirent_header(
                    entry.off as u64,
                    entry.ino,
                    name_len,
                    layout::dirent_type_to_filetype(entry.d_type),
                    &mut header,
                ) {
                    return Err(WasiErrno::Io);
                }

                // WASI wants a truncated final entry rather than a dropped
                // one, so header and name are written up to the buffer end.
                let room = buf_len.saturating_sub(written);
                if room == 0 {
                    break 'batches;
                }
                let header_n = room.min(header.len() as u32);
                self.mem
                    .write((buf + written) as u64, &header[..header_n as usize])?;
                written += header_n;
                if header_n < header.len() as u32 {
                    break 'batches;
                }

                let room = buf_len.saturating_sub(written);
                let name_n = room.min(name_len);
                if name_n > 0 {
                    self.copy_within(
                        (buf + written) as u64,
                        staging + consumed as u64 + layout::linux_dirent64::NAME as u64,
                        name_n as u64,
                    )?;
                    written += name_n;
                }
                if name_n < name_len {
                    break 'batches;
                }

                consumed += reclen as u32;
            }
        }

        self.mem.write_u32(size_out as u64, written)
    }

    pub fn fd_renumber(&mut self, from: u32, to: u32) -> WasiResult {
        self.call(Syscall::Dup2 as u32, [from as i64, to as i64, 0, 0, 0, 0])?;
        if from != to {
            self.call(Syscall::Close as u32, [from as i64, 0, 0, 0, 0, 0])?;
        }
        self.preopens.rename(from, to)
    }

    // ---------------------------------------------------------------- path ops

    pub fn path_create_directory(&self, fd: u32, path_ptr: u32, path_len: u32) -> WasiResult {
        let (dirfd, path) = self.resolve_path(fd, path_ptr, path_len, scratch::PRIMARY)?;
        self.call(
            Syscall::Mkdirat as u32,
            [dirfd, path as i64, 0o777, 0, 0, 0],
        )?;
        Ok(())
    }

    pub fn path_unlink_file(&self, fd: u32, path_ptr: u32, path_len: u32) -> WasiResult {
        let (dirfd, path) = self.resolve_path(fd, path_ptr, path_len, scratch::PRIMARY)?;
        self.call(Syscall::Unlinkat as u32, [dirfd, path as i64, 0, 0, 0, 0])?;
        Ok(())
    }

    pub fn path_remove_directory(&self, fd: u32, path_ptr: u32, path_len: u32) -> WasiResult {
        let (dirfd, path) = self.resolve_path(fd, path_ptr, path_len, scratch::PRIMARY)?;
        self.call(
            Syscall::Unlinkat as u32,
            [dirfd, path as i64, flags::AT_REMOVEDIR as i64, 0, 0, 0],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn path_rename(
        &self,
        old_fd: u32,
        old_path: u32,
        old_len: u32,
        new_fd: u32,
        new_path: u32,
        new_len: u32,
    ) -> WasiResult {
        let (old_dirfd, old_addr) =
            self.resolve_path(old_fd, old_path, old_len, scratch::PRIMARY)?;
        let (new_dirfd, new_addr) =
            self.resolve_path(new_fd, new_path, new_len, scratch::SECONDARY)?;
        self.call(
            Syscall::Renameat as u32,
            [old_dirfd, old_addr as i64, new_dirfd, new_addr as i64, 0, 0],
        )?;
        Ok(())
    }

    pub fn path_symlink(
        &self,
        old_path: u32,
        old_len: u32,
        fd: u32,
        new_path: u32,
        new_len: u32,
    ) -> WasiResult {
        // The symlink TARGET is used verbatim -- it is not resolved against a
        // preopen, because it is the link's contents, not a path to open.
        if old_len as u64 + 1 > scratch::PATH_CAPACITY {
            return Err(WasiErrno::NameTooLong);
        }
        let target = self.data(scratch::PRIMARY);
        self.copy_within(target, old_path as u64, old_len as u64)?;
        self.mem.write_u8(target + old_len as u64, 0)?;

        let (dirfd, link) = self.resolve_path(fd, new_path, new_len, scratch::SECONDARY)?;
        self.call(
            Syscall::Symlinkat as u32,
            [target as i64, dirfd, link as i64, 0, 0, 0],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn path_readlink(
        &self,
        fd: u32,
        path_ptr: u32,
        path_len: u32,
        buf: u32,
        buf_len: u32,
        size_out: u32,
    ) -> WasiResult {
        let (dirfd, path) = self.resolve_path(fd, path_ptr, path_len, scratch::PRIMARY)?;
        let result_addr = self.data(scratch::SECONDARY);
        let max = (buf_len as u64).min(scratch::BULK_CAPACITY - scratch::SECONDARY);
        let n = self.call(
            Syscall::Readlinkat as u32,
            [dirfd, path as i64, result_addr as i64, max as i64, 0, 0],
        )?;
        let len = Self::narrow(n)?;
        self.copy_within(buf as u64, result_addr, len as u64)?;
        self.mem.write_u32(size_out as u64, len)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn path_link(
        &self,
        old_fd: u32,
        _old_flags: u32,
        old_path: u32,
        old_len: u32,
        new_fd: u32,
        new_path: u32,
        new_len: u32,
    ) -> WasiResult {
        let (old_dirfd, old_addr) =
            self.resolve_path(old_fd, old_path, old_len, scratch::PRIMARY)?;
        let (new_dirfd, new_addr) =
            self.resolve_path(new_fd, new_path, new_len, scratch::SECONDARY)?;
        self.call(
            Syscall::Linkat as u32,
            [old_dirfd, old_addr as i64, new_dirfd, new_addr as i64, 0, 0],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn path_open(
        &self,
        dirfd: u32,
        _lookup_flags: u32,
        path_ptr: u32,
        path_len: u32,
        oflags: u16,
        _rights_base: u64,
        _rights_inheriting: u64,
        fdflags: u16,
        fd_out: u32,
    ) -> WasiResult {
        let (kernel_dirfd, path) = self.resolve_path(dirfd, path_ptr, path_len, scratch::PRIMARY)?;
        let oflags = WasiOflags(oflags as u32);
        let mut posix = translate::wasi_oflags_to_posix(oflags, WasiFdflags(fdflags as u32));

        // WASI carries no access mode in oflags -- it is implied by the
        // requested rights, which Kandelo does not model. A directory opens
        // read-only; everything else opens read/write and falls back below.
        if oflags.contains(WasiOflags::DIRECTORY) {
            posix |= flags::O_RDONLY;
        } else {
            posix |= flags::O_RDWR;
        }

        let opened = match self.call(
            Syscall::Openat as u32,
            [kernel_dirfd, path as i64, posix as i64, 0o666, 0, 0],
        ) {
            Ok(fd) => fd,
            Err(err) => {
                // A read/write open of something that can only be read is not
                // a failure the guest asked for. Retry read-only, but never
                // when the guest asked to create the file.
                let retryable = matches!(err, WasiErrno::IsDir | WasiErrno::Acces);
                if !retryable || posix & flags::O_CREAT != 0 {
                    return Err(err);
                }
                let posix = (posix & !flags::O_ACCMODE) | flags::O_RDONLY;
                self.call(
                    Syscall::Openat as u32,
                    [kernel_dirfd, path as i64, posix as i64, 0o666, 0, 0],
                )?
            }
        };
        self.mem.write_u32(fd_out as u64, Self::narrow(opened)?)
    }

    /// **DEFECT FIX 2.** `lookupflags` is honored, so WASI's `lstat` works.
    ///
    /// The TypeScript names the parameter `_flags` and passes a literal `0` to
    /// `fstatat`, which always follows symlinks. A guest asking to stat the
    /// link itself was silently given the target.
    pub fn path_filestat_get(
        &self,
        fd: u32,
        lookup_flags: u32,
        path_ptr: u32,
        path_len: u32,
        filestat_ptr: u32,
    ) -> WasiResult {
        let (dirfd, path) = self.resolve_path(fd, path_ptr, path_len, scratch::PRIMARY)?;
        let at_flags = translate::wasi_lookupflags_to_at_flags(WasiLookupflags(lookup_flags));
        self.call(
            Syscall::Fstatat as u32,
            [
                dirfd,
                path as i64,
                self.data(scratch::SECONDARY) as i64,
                at_flags as i64,
                0,
                0,
            ],
        )?;
        self.write_filestat(scratch::SECONDARY, filestat_ptr)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn path_filestat_set_times(
        &self,
        fd: u32,
        lookup_flags: u32,
        path_ptr: u32,
        path_len: u32,
        atim: u64,
        mtim: u64,
        fst_flags: u16,
    ) -> WasiResult {
        let (dirfd, path) = self.resolve_path(fd, path_ptr, path_len, scratch::SECONDARY)?;
        self.write_utimens_pair(scratch::PRIMARY, atim, mtim, fst_flags)?;
        // Same defect-2 fix: honor lookupflags rather than passing 0.
        let at_flags = translate::wasi_lookupflags_to_at_flags(WasiLookupflags(lookup_flags));
        self.call(
            Syscall::Utimensat as u32,
            [
                dirfd,
                path as i64,
                self.data(scratch::PRIMARY) as i64,
                at_flags as i64,
                0,
                0,
            ],
        )?;
        Ok(())
    }

    // --------------------------------------------------- random, clock, process

    pub fn random_get(&self, buf: u32, buf_len: u32) -> WasiResult {
        let mut done = 0u32;
        while done < buf_len {
            let chunk = (buf_len - done).min(scratch::BULK_CAPACITY as u32);
            let n = self.call(
                extended_syscalls::SYS_GETRANDOM,
                [self.data(scratch::BULK) as i64, chunk as i64, 0, 0, 0, 0],
            )?;
            let got = Self::narrow(n)?;
            if got == 0 {
                // Zero progress would spin forever. The TypeScript's `while
                // (offset < bufLen)` loop has exactly that hazard.
                return Err(WasiErrno::Io);
            }
            self.copy_within((buf + done) as u64, self.data(scratch::BULK), got as u64)?;
            done += got;
        }
        Ok(())
    }

    pub fn clock_time_get(&self, clock_id: u32, _precision: u64, time_out: u32) -> WasiResult {
        // Bug-compatible with the TypeScript: an undefined clock silently
        // becomes CLOCK_REALTIME. See `wasi_clock_to_posix_lenient`; changing
        // this is a maintainer decision, not this port's.
        let posix = translate::wasi_clock_to_posix_lenient(clock_id);
        self.call(
            Syscall::ClockGettime as u32,
            [posix as i64, self.data(scratch::PRIMARY) as i64, 0, 0, 0, 0],
        )?;
        let nanos = self.read_timespec_nanos(scratch::PRIMARY)?;
        self.mem.write_u64(time_out as u64, nanos)
    }

    pub fn clock_res_get(&self, clock_id: u32, res_out: u32) -> WasiResult {
        let posix = translate::wasi_clock_to_posix_lenient(clock_id);
        self.call(
            Syscall::ClockGetres as u32,
            [posix as i64, self.data(scratch::PRIMARY) as i64, 0, 0, 0, 0],
        )?;
        let nanos = self.read_timespec_nanos(scratch::PRIMARY)?;
        self.mem.write_u64(res_out as u64, nanos)
    }

    /// Issue `SYS_EXIT`. The unwind out of `_start` stays a host act -- see
    /// the JS thunk in `worker-main.ts`.
    pub fn proc_exit(&self, code: u32) {
        let _ = self.chan.syscall(Syscall::Exit as u32, [code as i64, 0, 0, 0, 0, 0]);
    }

    pub fn proc_raise(&self, sig: u32) -> WasiResult {
        let pid = self.call(Syscall::Getpid as u32, [0; 6])?;
        self.call(
            Syscall::Kill as u32,
            [Self::narrow(pid)? as i64, sig as i64, 0, 0, 0, 0],
        )?;
        Ok(())
    }

    pub fn sched_yield(&self) -> WasiResult {
        self.call(extended_syscalls::SYS_SCHED_YIELD, [0; 6])?;
        Ok(())
    }

    // ------------------------------------------------------------- poll_oneoff

    /// **DEFECT FIX 1.** Every subscription tag is matched exhaustively.
    ///
    /// The TypeScript computes `tag === FD_READ ? POLLIN : POLLOUT`
    /// (`wasi-shim.ts:1461`), so any tag that is not `FD_READ` -- including a
    /// malformed one -- becomes a write subscription. `WASI_EVENTTYPE_FD_WRITE`
    /// is declared and never compared against. Here an undefined tag is
    /// `EINVAL`, reported before any syscall is issued.
    pub fn poll_oneoff(
        &self,
        in_ptr: u32,
        out_ptr: u32,
        nsubscriptions: u32,
        nevents_out: u32,
    ) -> WasiResult {
        if nsubscriptions == 0 {
            return self.mem.write_u32(nevents_out as u64, 0);
        }

        let sub_size = layout::subscription::SIZE as u64;
        let poll_fd_size = layout::wasm_poll_fd::SIZE as u64;
        let poll_base = self.data(scratch::PRIMARY);

        // First pass: validate every tag before issuing anything, and stage
        // the pollfd array.
        let mut npollfds = 0u32;
        let mut clock_timeout_ms: i64 = -1;
        let mut clock_userdata = 0u64;
        let mut clock_is_abstime = false;
        let mut clock_abs_nanos = 0u64;

        for index in 0..nsubscriptions {
            let base = in_ptr as u64 + index as u64 * sub_size;
            let sub = {
                let mut raw = [0u8; layout::subscription::SIZE];
                self.mem.read(base, &mut raw)?;
                layout::decode_subscription(&raw).ok_or(WasiErrno::Inval)?
            };
            // Rejects an undefined tag; `None` means "not a pollfd".
            let events = translate::poll_events_for_eventtype(sub.tag)?;
            match events {
                None => {
                    let ms = (sub.clock_timeout / 1_000_000) as i64;
                    if clock_timeout_ms < 0 || ms < clock_timeout_ms {
                        clock_timeout_ms = ms;
                        clock_userdata = sub.userdata;
                        clock_is_abstime = sub.clock_flags & SUBSCRIPTION_CLOCK_ABSTIME != 0;
                        clock_abs_nanos = sub.clock_timeout;
                    }
                }
                Some(bits) => {
                    let entry = poll_base + npollfds as u64 * poll_fd_size;
                    self.mem.write_u32(
                        entry + layout::wasm_poll_fd::FD as u64,
                        sub.fd,
                    )?;
                    self.mem.write_u16(
                        entry + layout::wasm_poll_fd::EVENTS as u64,
                        bits,
                    )?;
                    self.mem.write_u16(
                        entry + layout::wasm_poll_fd::REVENTS as u64,
                        0,
                    )?;
                    npollfds += 1;
                }
            }
        }

        // An absolute clock deadline becomes a relative one.
        if clock_timeout_ms >= 0 && clock_is_abstime {
            self.call(
                Syscall::ClockGettime as u32,
                [
                    translate::posix_clock::CLOCK_REALTIME as i64,
                    self.data(scratch::SECONDARY) as i64,
                    0,
                    0,
                    0,
                    0,
                ],
            )?;
            let now = self.read_timespec_nanos(scratch::SECONDARY)?;
            clock_timeout_ms = clock_abs_nanos.saturating_sub(now) as i64 / 1_000_000;
        }

        let (_, errno) = self.chan.syscall(
            Syscall::Poll as u32,
            [
                if npollfds == 0 { 0 } else { poll_base as i64 },
                npollfds as i64,
                clock_timeout_ms,
                0,
                0,
                0,
            ],
        );
        // EINTR is not a poll failure: it means the wait was cut short, and
        // the revents already staged are still meaningful.
        if errno != 0 && errno != wasm_posix_shared::Errno::EINTR as u32 {
            return Err(translate_linux_errno(errno));
        }

        // Second pass: turn revents into WASI events. The subscription order
        // is re-walked so each pollfd keeps its own userdata and tag.
        let mut nevents = 0u32;
        let mut pollfd_index = 0u32;
        for index in 0..nsubscriptions {
            let base = in_ptr as u64 + index as u64 * sub_size;
            let mut raw = [0u8; layout::subscription::SIZE];
            self.mem.read(base, &mut raw)?;
            let sub = layout::decode_subscription(&raw).ok_or(WasiErrno::Inval)?;
            if translate::poll_events_for_eventtype(sub.tag)?.is_none() {
                continue;
            }
            let entry = poll_base + pollfd_index as u64 * poll_fd_size;
            pollfd_index += 1;
            let revents = self
                .mem
                .read_u16(entry + layout::wasm_poll_fd::REVENTS as u64)?;
            if revents == 0 {
                continue;
            }
            let error = if revents & poll_events::POLLERR != 0 {
                WasiErrno::Io.as_u16()
            } else {
                WasiErrno::Success.as_u16()
            };
            let mut out = [0u8; layout::event::SIZE];
            // nbytes is unknown from poll alone; 1 is what the TypeScript
            // reports and what a reader needs to see "there is something".
            layout::encode_event(sub.userdata, error, sub.tag, 1, 0, &mut out);
            self.mem
                .write(out_ptr as u64 + nevents as u64 * layout::event::SIZE as u64, &out)?;
            nevents += 1;
        }

        // A pure timeout still reports the clock subscription that expired.
        if nevents == 0 && clock_timeout_ms >= 0 {
            let mut out = [0u8; layout::event::SIZE];
            layout::encode_event(
                clock_userdata,
                WasiErrno::Success.as_u16(),
                wasi_abi::WasiEventType::Clock.as_u8(),
                0,
                0,
                &mut out,
            );
            self.mem.write(out_ptr as u64, &out)?;
            nevents = 1;
        }

        self.mem.write_u32(nevents_out as u64, nevents)
    }

    // ------------------------------------------------------------------ sockets

    #[allow(clippy::too_many_arguments)]
    pub fn sock_recv(
        &self,
        fd: u32,
        iovs: u32,
        iovs_len: u32,
        _ri_flags: u16,
        ro_datalen_out: u32,
        ro_flags_out: u32,
    ) -> WasiResult {
        let want = self.staged_capacity(iovs, iovs_len)?;
        let n = self.call(
            Syscall::Recvfrom as u32,
            [
                fd as i64,
                self.data(scratch::BULK) as i64,
                want as i64,
                0,
                0,
                0,
            ],
        )?;
        let read = Self::narrow(n)?;
        self.scatter(iovs, iovs_len, read)?;
        self.mem.write_u32(ro_datalen_out as u64, read)?;
        self.mem.write_u16(ro_flags_out as u64, 0)
    }

    pub fn sock_send(
        &self,
        fd: u32,
        iovs: u32,
        iovs_len: u32,
        _si_flags: u16,
        nwritten_out: u32,
    ) -> WasiResult {
        let staged = self.gather(iovs, iovs_len)?;
        let n = self.call(
            Syscall::Sendto as u32,
            [
                fd as i64,
                self.data(scratch::BULK) as i64,
                staged as i64,
                0,
                0,
                0,
            ],
        )?;
        self.mem.write_u32(nwritten_out as u64, Self::narrow(n)?)
    }

    /// WASI `sdflags` and POSIX `SHUT_*` share their numbering.
    pub fn sock_shutdown(&self, fd: u32, how: u32) -> WasiResult {
        self.call(
            Syscall::Shutdown as u32,
            [fd as i64, how as i64, 0, 0, 0, 0],
        )?;
        Ok(())
    }

    /// Kandelo does not expose `accept` to WASI guests. An honest refusal,
    /// per the debugging-and-POSIX contract: a stub that pretended to succeed
    /// would hand the guest a file descriptor that is not a connection.
    pub fn sock_accept(&self) -> WasiResult {
        Err(WasiErrno::NoSys)
    }
}
