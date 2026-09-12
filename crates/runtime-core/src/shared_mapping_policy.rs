//! Keeping a `MAP_SHARED` file mapping coherent with the same file written
//! through a descriptor.
//!
//! POSIX requires a mapping of a file and ordinary I/O on that file to be two
//! views of one object. A store through a mapping must become visible to a
//! later `read`, and a `write` must become visible through the mapping. The
//! mapping table holds a page cache per file, so both directions need a
//! publication point around every syscall that touches the file's bytes:
//!
//! * **before** the call, every dirty mapped page of the file is published and
//!   persisted, so the syscall reads what the mappings have already stored;
//! * **after** it, the cached pages are reconciled with what the call did, so
//!   no mapping keeps bytes the file no longer has.
//!
//! This module is the decision table for both, keyed by syscall number. It is
//! the kernel-side replacement for the host's
//! `flushSharedMappingsBeforeFileSyscall` and
//! `handleSharedMappingsAfterFileSyscall`.
//!
//! Two whole families of host code have no counterpart here, and that is the
//! point of moving it rather than porting it:
//!
//! * **The descriptor cache.** The host reaches a backing from a file
//!   descriptor through `sharedMmapFdCache`, and must therefore invalidate
//!   that cache on `close`, `dup`, `dup2`, `dup3` and the `F_DUPFD` family of
//!   `fcntl` — five branches of the after-syscall policy that exist only to
//!   maintain it. The kernel owns the descriptor table and the file identity
//!   behind it, so it resolves the key on demand and those branches are gone.
//! * **The number-domain fallbacks.** The host indexes its cache with
//!   JavaScript numbers, so a `pwrite` offset or `ftruncate` length outside the
//!   safe-integer range cannot be represented, and it falls back to refreshing
//!   the whole backing. It also has to carry exact offsets alongside the
//!   argument array to avoid rounding them. Here the arguments are already
//!   `i64`, so the exact value is the only value and the fallbacks are gone.

use alloc::string::String;

use wasm_posix_shared::flags::{AT_FDCWD, O_ACCMODE, O_RDWR, O_TRUNC, O_WRONLY};
use wasm_posix_shared::mmap::{MAP_ANONYMOUS, MAP_SHARED};
use wasm_posix_shared::mode::{S_IFMT, S_IFREG};
use wasm_posix_shared::{Errno, KernelSharedMappingFdFacts, Syscall};

use crate::memory::{
    SharedMappingIo, SharedMappingStat, SharedMappingTable, FILE_PAGE_SIZE,
};

use wasm_posix_shared::abi::extended_syscalls as ext;

/// What the kernel must answer for this policy to act.
///
/// Both questions are about file identity, which is what a backing is keyed
/// by. Returning `None` means nothing maps that file, which is the common
/// case and is not an error.
pub trait SharedMappingResolver {
    /// The backing key for the file this descriptor refers to.
    fn backing_key_for_fd(&mut self, pid: u32, fd: i32) -> Option<String>;

    /// The backing key for the file a `(dirfd, path pointer)` pair names.
    fn backing_key_for_path_arg(
        &mut self,
        pid: u32,
        dirfd: i32,
        path_ptr: u64,
    ) -> Option<String>;
}

/// One file syscall, as the policy needs to see it.
pub struct FileSyscall<'a> {
    pub nr: u32,
    pub args: &'a [i64],
    pub ret: i64,
    pub errno: i32,
}

impl FileSyscall<'_> {
    fn arg(&self, index: usize) -> i64 {
        self.args.get(index).copied().unwrap_or(0)
    }

    fn fd(&self, index: usize) -> i32 {
        self.arg(index) as i32
    }
}

/// Syscalls that read or write a descriptor's stored bytes directly, and so
/// must see the mappings' dirty pages before they run.
fn touches_fd_storage(nr: u32) -> bool {
    nr == Syscall::Read as u32
        || nr == Syscall::Pread as u32
        || nr == Syscall::Readv as u32
        || nr == ext::SYS_PREADV
        || nr == ext::SYS_PREADV2
        || nr == Syscall::Write as u32
        || nr == Syscall::Pwrite as u32
        || nr == Syscall::Writev as u32
        || nr == ext::SYS_PWRITEV
        || nr == ext::SYS_PWRITEV2
        || nr == Syscall::Fsync as u32
        || nr == Syscall::Fdatasync as u32
        || nr == Syscall::Ftruncate as u32
        || nr == ext::SYS_FALLOCATE
}

/// Publish and persist a backing named by a descriptor. A descriptor naming no
/// mapped file is not an error.
fn flush_fd(
    table: &mut SharedMappingTable,
    resolver: &mut dyn SharedMappingResolver,
    io: &mut dyn SharedMappingIo,
    pid: u32,
    fd: i32,
) -> bool {
    if fd < 0 {
        return true;
    }
    let Some(key) = resolver.backing_key_for_fd(pid, fd) else {
        return true;
    };
    table.flush_backing(&key, io).unwrap_or(false)
}

fn flush_path(
    table: &mut SharedMappingTable,
    resolver: &mut dyn SharedMappingResolver,
    io: &mut dyn SharedMappingIo,
    pid: u32,
    dirfd: i32,
    path_ptr: u64,
) -> bool {
    let Some(key) = resolver.backing_key_for_path_arg(pid, dirfd, path_ptr) else {
        return true;
    };
    table.flush_backing(&key, io).unwrap_or(false)
}

/// The `(dirfd, path pointer)` an open-family call names.
fn open_path_args(nr: u32, call: &FileSyscall) -> (i32, u64) {
    if nr == Syscall::Openat as u32 {
        (call.fd(0), call.arg(1) as u64)
    } else {
        (AT_FDCWD, call.arg(0) as u64)
    }
}

/// The open flags an open-family call carries.
fn open_flags(nr: u32, call: &FileSyscall) -> u32 {
    if nr == Syscall::Openat as u32 {
        call.arg(2) as u32
    } else {
        call.arg(1) as u32
    }
}

/// Publish every dirty mapped page the syscall is about to read or overwrite.
///
/// Returns `false` if a backing could not be persisted, which the caller must
/// treat as a reason not to proceed: letting the syscall run would read stale
/// bytes or destroy stores the mappings have already acknowledged.
pub fn flush_before_file_syscall(
    table: &mut SharedMappingTable,
    resolver: &mut dyn SharedMappingResolver,
    io: &mut dyn SharedMappingIo,
    pid: u32,
    call: &FileSyscall,
) -> bool {
    if !table.has_file_backings() {
        return true;
    }
    let nr = call.nr;

    if nr == Syscall::Truncate as u32 {
        return flush_path(table, resolver, io, pid, AT_FDCWD, call.arg(0) as u64);
    }

    if nr == Syscall::Open as u32 || nr == Syscall::Openat as u32 {
        if open_flags(nr, call) & O_TRUNC != 0 {
            let (dirfd, path_ptr) = open_path_args(nr, call);
            return flush_path(table, resolver, io, pid, dirfd, path_ptr);
        }
        return true;
    }

    // A `MAP_PRIVATE` file mapping is populated by reading the file after the
    // kernel reserves the memory. Publish any dirty shared view of that file
    // first, so the private snapshot does not start stale.
    if nr == Syscall::Mmap as u32 {
        let flags = call.arg(3) as u32;
        if flags & MAP_SHARED == 0 && flags & MAP_ANONYMOUS == 0 && call.fd(4) >= 0 {
            if table.sync_file_from_process(pid, true, io).is_err() {
                return false;
            }
            return flush_fd(table, resolver, io, pid, call.fd(4));
        }
        return true;
    }

    // Calls that move bytes between two descriptors must flush both ends.
    if nr == ext::SYS_SENDFILE {
        if table.sync_file_from_process(pid, true, io).is_err() {
            return false;
        }
        return flush_fd(table, resolver, io, pid, call.fd(0))
            && flush_fd(table, resolver, io, pid, call.fd(1));
    }
    if nr == ext::SYS_COPY_FILE_RANGE || nr == ext::SYS_SPLICE {
        if table.sync_file_from_process(pid, true, io).is_err() {
            return false;
        }
        return flush_fd(table, resolver, io, pid, call.fd(0))
            && flush_fd(table, resolver, io, pid, call.fd(2));
    }

    if !touches_fd_storage(nr) {
        return true;
    }
    if table.sync_file_from_process(pid, true, io).is_err() {
        return false;
    }
    flush_fd(table, resolver, io, pid, call.fd(0))
}

/// Reconcile the cached pages with what the syscall did to the file.
///
/// A failed call changed nothing, so it is skipped. Everything here is
/// best-effort in the sense that a backing which cannot be re-read is marked
/// stale rather than left holding bytes the file no longer has.
pub fn reconcile_after_file_syscall(
    table: &mut SharedMappingTable,
    resolver: &mut dyn SharedMappingResolver,
    io: &mut dyn SharedMappingIo,
    pid: u32,
    call: &FileSyscall,
    written: Option<&[u8]>,
) {
    if !table.has_file_backings() || call.errno != 0 {
        return;
    }
    let nr = call.nr;
    let ret = call.ret;

    // An `O_TRUNC` open emptied the file it opened.
    if (nr == Syscall::Open as u32 || nr == Syscall::Openat as u32) && ret >= 0 {
        if open_flags(nr, call) & O_TRUNC != 0 {
            reload_fd(table, resolver, io, pid, ret as i32, Some(0));
        }
        return;
    }

    // A positioned write put known bytes at a known offset, so the cache can
    // take them directly instead of re-reading the file.
    if nr == Syscall::Pwrite as u32 && ret > 0 {
        let fd = call.fd(0);
        let offset = call.arg(3);
        if offset < 0 {
            return;
        }
        let Some(key) = resolver.backing_key_for_fd(pid, fd) else {
            return;
        };
        match written {
            Some(bytes) if bytes.len() as i64 == ret => {
                table.apply_written_bytes(&key, offset as u64, bytes, io);
            }
            // The bytes were not available to copy; re-read the range the call
            // reported writing rather than leave it holding pre-write bytes.
            _ => {
                table.reload_backing(&key, None, io);
            }
        }
        return;
    }

    // Writes whose extent this layer cannot name: refresh the whole backing.
    if (nr == Syscall::Write as u32
        || nr == Syscall::Writev as u32
        || nr == ext::SYS_PWRITEV
        || nr == ext::SYS_PWRITEV2
        || nr == ext::SYS_SENDFILE)
        && ret > 0
    {
        reload_fd(table, resolver, io, pid, call.fd(0), None);
        return;
    }

    // `copy_file_range` and `splice` write to their *output* descriptor.
    if (nr == ext::SYS_COPY_FILE_RANGE || nr == ext::SYS_SPLICE) && ret > 0 {
        reload_fd(table, resolver, io, pid, call.fd(2), None);
        return;
    }

    if nr == Syscall::Ftruncate as u32 && ret == 0 {
        let length = call.arg(1);
        let exact = if length >= 0 { Some(length as u64) } else { None };
        reload_fd(table, resolver, io, pid, call.fd(0), exact);
        return;
    }

    // `fallocate` may change the size and may punch a hole. This cache does
    // not model sparse ranges, so re-derive the size rather than trust an
    // interval.
    if nr == ext::SYS_FALLOCATE && ret == 0 {
        reload_fd(table, resolver, io, pid, call.fd(0), None);
        return;
    }

    if nr == Syscall::Truncate as u32 && ret == 0 {
        let length = call.arg(1);
        let exact = if length >= 0 { Some(length as u64) } else { None };
        if let Some(key) =
            resolver.backing_key_for_path_arg(pid, AT_FDCWD, call.arg(0) as u64)
        {
            table.reload_backing(&key, exact, io);
        }
    }
}

fn reload_fd(
    table: &mut SharedMappingTable,
    resolver: &mut dyn SharedMappingResolver,
    io: &mut dyn SharedMappingIo,
    pid: u32,
    fd: i32,
    exact_size: Option<u64>,
) {
    if fd < 0 {
        return;
    }
    let Some(key) = resolver.backing_key_for_fd(pid, fd) else {
        return;
    };
    table.reload_backing(&key, exact_size, io);
}

// -- registering a new file mapping ---------------------------------------

/// How a `MAP_SHARED` mapping of a regular file must be backed.
///
/// Deciding this is entirely a question about the descriptor, so it is a pure
/// function of the facts the kernel already holds. Keeping it separate from
/// the table mutation is what lets the POSIX access rules — the part with the
/// most ways to be subtly wrong — be tested without any I/O at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MappingPreparation {
    /// A host-owned regular file: the mapping joins a shared byte store keyed
    /// by file identity, and writeback goes through the host handle.
    Backed {
        file_offset: u64,
        host_handle: i64,
        size: u64,
        /// The mapping is being created writable now.
        writable: bool,
        /// The description permits a later `PROT_WRITE` upgrade.
        write_allowed: bool,
    },
    /// A kernel-owned regular file — tmpfs, memfd, the rootfs overlay, procfs,
    /// a synthetic regular. There is no host handle to anchor a byte store on,
    /// so writeback rides the guest's own descriptor.
    FdWriteback {
        file_offset: u64,
        file_size: u64,
        dev: u64,
        ino: u64,
    },
    /// Not a shared-mapping case. The caller populates the range the way a
    /// `MAP_PRIVATE` file mapping is populated.
    Unsupported,
    Refused(Errno),
}

/// Classify a `MAP_SHARED` mapping of a file.
///
/// `supports_writeback` is the kernel's `fd_supports_mmap_writeback`: whether
/// a host `pwrite` through this descriptor reaches persistent host storage.
/// It is deliberately not consulted for a kernel-owned file, where it is false
/// by construction — that path does not write to host storage at all, it
/// writes back to the kernel-owned file through the guest's own descriptor, so
/// the file itself is the backing store.
pub fn classify_file_mapping(
    prot_write: bool,
    page_offset: u64,
    facts: &KernelSharedMappingFdFacts,
    supports_writeback: bool,
) -> MappingPreparation {
    let Some(file_offset) = page_offset.checked_mul(FILE_PAGE_SIZE as u64) else {
        return MappingPreparation::Refused(Errno::EINVAL);
    };
    if facts.mode & S_IFMT != S_IFREG {
        return MappingPreparation::Unsupported;
    }
    let access_mode = facts.access_mode & O_ACCMODE;

    if facts.has_host_handle == 0 {
        // A read-only request needs no writeback bridge: nothing can write
        // through it, so it wants the same one-time content snapshot a
        // `MAP_PRIVATE` mapping gets. Treating it as unsupported is what stops
        // every read-only `MAP_SHARED` of a tmpfs file — musl's `__map_file`,
        // used for locale, timezone and message-catalog loading — failing with
        // ENOTSUP purely because the file is kernel-owned. A file mapping
        // still requires a readable descriptor, so an O_WRONLY fd is EACCES
        // rather than a silently zero-filled success.
        if !prot_write {
            if access_mode == O_WRONLY {
                return MappingPreparation::Refused(Errno::EACCES);
            }
            return MappingPreparation::Unsupported;
        }
        // POSIX requires a shared writable file mapping to be backed by a
        // readable and writable description.
        if access_mode != O_RDWR {
            return MappingPreparation::Refused(Errno::EACCES);
        }
        return MappingPreparation::FdWriteback {
            file_offset,
            file_size: facts.size,
            dev: facts.dev,
            ino: facts.ino,
        };
    }

    if access_mode == O_WRONLY {
        return MappingPreparation::Refused(Errno::EACCES);
    }
    // Preserve the description's lifetime capability, not merely the initial
    // protection: an O_RDWR fd mapped PROT_READ may be upgraded after the fd
    // and the pathname are gone, so the stable handle must already support
    // writes.
    let write_allowed = access_mode == O_RDWR && supports_writeback;
    if prot_write && !write_allowed {
        return MappingPreparation::Refused(Errno::EACCES);
    }
    MappingPreparation::Backed {
        file_offset,
        host_handle: facts.host_handle,
        size: facts.size,
        writable: prot_write,
        write_allowed,
    }
}

/// Take the backing a new `Backed` mapping will name, ready for the kernel to
/// install the mapping itself.
///
/// This is the step whose absence left the reference accounting one short for
/// the life of every file mapping. Creation counts nothing,
/// `inherit_process_mappings` counts each inherited mapping and
/// `release_mapping` discounts every mapping it drops, so the mapping that
/// *causes* a backing must take its own reference here. Without it the first
/// process to exit takes the backing to zero and closes the host handle while
/// a live peer still has the file mapped, and — more quietly — two real peers
/// both sit in the sole-observer deferral and never see each other's writes.
///
/// Returns the backing key the caller must record on the mapping.
pub fn acquire_file_backing(
    table: &mut SharedMappingTable,
    io: &mut dyn SharedMappingIo,
    dev: u64,
    ino: u64,
    host_handle: i64,
    size: u64,
    mode: u32,
    write_allowed: bool,
    file_offset: u64,
    len: usize,
) -> Result<String, Errno> {
    let key = io
        .handle_identity(host_handle, dev, ino)
        .ok_or(Errno::ENOTSUP)?;
    let stat = SharedMappingStat {
        dev,
        ino,
        size,
        mode,
        host_handle: Some(host_handle),
    };
    table.get_or_create_file_backing(&key, &stat, write_allowed, io)?;

    // A sole existing observer defers publication to avoid scanning its
    // mapping at every boundary. Before another mapping joins, force every
    // existing observer to publish, so the newcomer starts from the latest
    // shared state rather than from the last persisted snapshot.
    if let Err(err) = table.publish_file_backing_observers(&key, io) {
        table.discard_unreferenced_file_backing(&key, io);
        return Err(err);
    }
    {
        let backing = table.file_backing_mut(&key).ok_or(Errno::EIO)?;
        if let Err(err) = backing.ensure_range_loaded(file_offset, len, io) {
            table.discard_unreferenced_file_backing(&key, io);
            return Err(err);
        }
    }
    // Reserve the backing across the kernel call. A `MAP_FIXED` cleanup may
    // drop the last old mapping of this same file before the new mapping is
    // installed.
    table
        .file_backing_mut(&key)
        .ok_or(Errno::EIO)?
        .ref_count += 1;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use alloc::vec::Vec;

    use crate::memory::SharedMappingStat;
    use wasm_posix_shared::Errno;

    const S_IFREG: u32 = 0o100000;

    struct Io {
        file: Vec<u8>,
        /// How many times the cache was persisted into the file.
        pwrites: usize,
    }

    impl Io {
        fn new(bytes: &[u8]) -> Self {
            Self {
                file: bytes.to_vec(),
                pwrites: 0,
            }
        }
    }

    impl SharedMappingIo for Io {
        fn read_process(&mut self, _pid: u32, _addr: u64, _dst: &mut [u8]) -> Result<(), Errno> {
            Err(Errno::ESRCH)
        }
        fn write_process(&mut self, _pid: u32, _addr: u64, _src: &[u8]) -> Result<(), Errno> {
            Err(Errno::ESRCH)
        }
        fn process_memory_len(&mut self, _pid: u32) -> Option<u64> {
            None
        }
        fn pread(&mut self, _handle: i64, offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
            let at = offset as usize;
            if at >= self.file.len() {
                return Ok(0);
            }
            let n = dst.len().min(self.file.len() - at);
            dst[..n].copy_from_slice(&self.file[at..at + n]);
            Ok(n)
        }
        fn pwrite(&mut self, _handle: i64, offset: u64, src: &[u8]) -> Result<usize, Errno> {
            let at = offset as usize;
            if at + src.len() > self.file.len() {
                self.file.resize(at + src.len(), 0);
            }
            self.file[at..at + src.len()].copy_from_slice(src);
            self.pwrites += 1;
            Ok(src.len())
        }
        fn fstat_handle(&mut self, _handle: i64) -> Result<SharedMappingStat, Errno> {
            Ok(SharedMappingStat {
                dev: 1,
                ino: 2,
                size: self.file.len() as u64,
                mode: S_IFREG | 0o644,
                host_handle: Some(10),
            })
        }
        fn handle_identity(&mut self, _handle: i64, _dev: u64, _ino: u64) -> Option<String> {
            Some("file:1:2".to_string())
        }
        fn retain_handle(&mut self, _handle: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn release_handle(&mut self, _handle: i64) {}
        fn fd_stat(&mut self, _pid: u32, _fd: i32) -> Result<SharedMappingStat, Errno> {
            Err(Errno::EBADF)
        }
        fn fd_pwrite(
            &mut self,
            _pid: u32,
            _fd: i32,
            _offset: u64,
            _src: &[u8],
        ) -> Result<usize, Errno> {
            Err(Errno::EBADF)
        }
        fn close_fd(&mut self, _pid: u32, _fd: i32) {}
        fn shm_read(&mut self, _seg: i32, _off: u64, _dst: &mut [u8]) -> Result<(), Errno> {
            Err(Errno::EINVAL)
        }
        fn shm_write(&mut self, _seg: i32, _off: u64, _src: &[u8]) -> Result<(), Errno> {
            Err(Errno::EINVAL)
        }
        fn report_writeback_loss(&mut self, _pid: u32, _addr: u64, _reason: &str) {}
    }

    /// Maps fd 3, and the pathname at pointer 0x100, onto the one backing.
    /// Counting the lookups is how a test tells *which* descriptor the policy
    /// decided to act on.
    struct Resolver {
        key: String,
        fd_lookups: usize,
        path_lookups: usize,
    }

    impl Resolver {
        fn new(key: &str) -> Self {
            Self {
                key: key.to_string(),
                fd_lookups: 0,
                path_lookups: 0,
            }
        }
    }

    impl SharedMappingResolver for Resolver {
        fn backing_key_for_fd(&mut self, _pid: u32, fd: i32) -> Option<String> {
            self.fd_lookups += 1;
            if fd == 3 {
                Some(self.key.clone())
            } else {
                None
            }
        }
        fn backing_key_for_path_arg(
            &mut self,
            _pid: u32,
            _dirfd: i32,
            path_ptr: u64,
        ) -> Option<String> {
            self.path_lookups += 1;
            if path_ptr == 0x100 {
                Some(self.key.clone())
            } else {
                None
            }
        }
    }

    fn table_with_backing(io: &mut Io) -> (SharedMappingTable, String) {
        let mut table = SharedMappingTable::new();
        let stat = io.fstat_handle(10).unwrap();
        let key = "file:1:2".to_string();
        {
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, io)
                .unwrap();
            backing.ref_count += 1;
        }
        // Make page 0 resident so a reload has something to re-read.
        table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, io)
            .unwrap();
        (table, key)
    }

    fn call(nr: u32, args: &[i64], ret: i64) -> FileSyscall<'_> {
        FileSyscall {
            nr,
            args,
            ret,
            errno: 0,
        }
    }

    #[test]
    fn a_write_through_the_descriptor_makes_the_cache_follow_the_file() {
        let mut io = Io::new(b"BEFORE..");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);
        let before = table.file_backing(&key).unwrap().version;

        io.file = b"AFTER...".to_vec();
        reconcile_after_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Write as u32, &[3, 0, 8], 8),
            None,
        );

        let seen = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(seen, b"AFTER...".to_vec());
        assert!(table.file_backing(&key).unwrap().version > before);
    }

    #[test]
    fn a_positioned_write_takes_its_bytes_without_re_reading_the_file() {
        let mut io = Io::new(b"........");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);

        io.file = b"..WXYZ..".to_vec();
        reconcile_after_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Pwrite as u32, &[3, 0, 4, 2], 4),
            Some(b"WXYZ"),
        );

        let seen = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(seen, b"..WXYZ..".to_vec());
        assert_eq!(
            table.file_backing(&key).unwrap().dirty_page_count(),
            0,
            "the file already has them; they must not be queued for writeback"
        );
    }

    #[test]
    fn an_ftruncate_length_is_taken_exactly_past_the_javascript_number_range() {
        // The host cannot represent this length and falls back to re-deriving
        // the size from the handle. Here it is simply an i64.
        let huge: i64 = (1i64 << 53) + 1;
        let mut io = Io::new(b"ABCDEFGH");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);

        reconcile_after_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Ftruncate as u32, &[3, huge], 0),
            None,
        );
        assert_eq!(
            table.file_backing(&key).unwrap().size,
            huge as u64,
            "the exact length survives"
        );
    }

    #[test]
    fn a_failed_call_changed_nothing_and_is_left_alone() {
        let mut io = Io::new(b"ABCDEFGH");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);
        let before = table.file_backing(&key).unwrap().version;

        let mut failed = call(Syscall::Write as u32, &[3, 0, 8], -1);
        failed.errno = Errno::EIO as i32;
        reconcile_after_file_syscall(&mut table, &mut res, &mut io, 1, &failed, None);

        assert_eq!(table.file_backing(&key).unwrap().version, before);
        assert_eq!(res.fd_lookups, 0, "a failed call is not even resolved");
    }

    #[test]
    fn copy_file_range_reconciles_its_output_descriptor_not_its_input() {
        let mut io = Io::new(b"ABCDEFGH");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);

        // fd 7 is the input and fd 3 the output.
        reconcile_after_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(ext::SYS_COPY_FILE_RANGE, &[7, 0, 3, 0, 8], 8),
            None,
        );
        assert_eq!(
            res.fd_lookups, 1,
            "exactly the output descriptor was resolved"
        );
    }

    #[test]
    fn a_read_publishes_the_mappings_dirty_pages_before_it_runs() {
        let mut io = Io::new(b"........");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .write_range(0, b"DIRTY", true, &mut io)
            .unwrap();

        assert!(flush_before_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Read as u32, &[3, 0, 8], 0),
        ));
        assert_eq!(
            io.file,
            b"DIRTY...".to_vec(),
            "the read must not see pre-store bytes"
        );
    }

    #[test]
    fn a_syscall_that_does_not_touch_stored_bytes_flushes_nothing() {
        let mut io = Io::new(b"........");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .write_range(0, b"DIRTY", true, &mut io)
            .unwrap();

        assert!(flush_before_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Dup as u32, &[3], 4),
        ));
        assert_eq!(io.pwrites, 0, "dup does not read the file's bytes");
        assert_eq!(res.fd_lookups, 0);
    }

    #[test]
    fn a_truncating_open_flushes_by_path_and_then_empties_the_backing() {
        let mut io = Io::new(b"ABCDEFGH");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);

        // open("/f", O_WRONLY|O_TRUNC) — the pathname is at 0x100.
        let opening = call(Syscall::Open as u32, &[0x100, O_TRUNC as i64], 3);
        assert!(flush_before_file_syscall(
            &mut table, &mut res, &mut io, 1, &opening
        ));
        assert_eq!(
            res.path_lookups, 1,
            "the target is named by path, not by the fd the call returns"
        );

        io.file.clear();
        reconcile_after_file_syscall(&mut table, &mut res, &mut io, 1, &opening, None);
        assert_eq!(
            table.file_backing(&key).unwrap().size,
            0,
            "the mapping must not keep bytes the file no longer has"
        );
    }

    #[test]
    fn a_shared_mmap_of_a_file_is_not_treated_as_a_private_populate() {
        let mut io = Io::new(b"........");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);

        let shared = call(
            Syscall::Mmap as u32,
            &[0, 8, 3, MAP_SHARED as i64, 3, 0],
            0x1000,
        );
        assert!(flush_before_file_syscall(
            &mut table, &mut res, &mut io, 1, &shared
        ));
        assert_eq!(
            res.fd_lookups, 0,
            "MAP_SHARED joins the backing rather than copying it"
        );
    }

    #[test]
    fn a_private_mmap_of_a_file_publishes_the_shared_view_first() {
        let mut io = Io::new(b"........");
        let (mut table, key) = table_with_backing(&mut io);
        let mut res = Resolver::new(&key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .write_range(0, b"DIRTY", true, &mut io)
            .unwrap();

        // MAP_PRIVATE of fd 3.
        let private = call(Syscall::Mmap as u32, &[0, 8, 1, 0x02, 3, 0], 0x1000);
        assert!(flush_before_file_syscall(
            &mut table, &mut res, &mut io, 1, &private
        ));
        assert_eq!(
            io.file,
            b"DIRTY...".to_vec(),
            "the private snapshot must not start stale"
        );
    }

    // -- classifying a new file mapping ---------------------------------

    const S_IFCHR: u32 = 0o020000;
    const O_RDONLY: u32 = 0;

    fn facts(mode: u32, access_mode: u32, host_owned: bool) -> KernelSharedMappingFdFacts {
        KernelSharedMappingFdFacts {
            dev: 1,
            ino: 2,
            size: 8,
            host_handle: if host_owned { 10 } else { -1 },
            mode,
            access_mode,
            has_host_handle: u32::from(host_owned),
            _pad: 0,
        }
    }

    #[test]
    fn a_writable_mapping_of_a_host_file_is_backed_and_upgradable() {
        let got = classify_file_mapping(true, 0, &facts(S_IFREG | 0o644, O_RDWR, true), true);
        assert_eq!(
            got,
            MappingPreparation::Backed {
                file_offset: 0,
                host_handle: 10,
                size: 8,
                writable: true,
                write_allowed: true,
            }
        );
    }

    #[test]
    fn a_read_only_mapping_of_a_writable_description_stays_upgradable() {
        // The fd may be closed and the pathname unlinked before a later
        // `mprotect(PROT_WRITE)`, so the capability is recorded now.
        let got = classify_file_mapping(false, 0, &facts(S_IFREG | 0o644, O_RDWR, true), true);
        assert_eq!(
            got,
            MappingPreparation::Backed {
                file_offset: 0,
                host_handle: 10,
                size: 8,
                writable: false,
                write_allowed: true,
            }
        );
    }

    #[test]
    fn a_write_only_descriptor_cannot_be_mapped_at_all() {
        // POSIX requires a readable description for any file mapping.
        assert_eq!(
            classify_file_mapping(false, 0, &facts(S_IFREG | 0o644, O_WRONLY, true), true),
            MappingPreparation::Refused(Errno::EACCES)
        );
        assert_eq!(
            classify_file_mapping(false, 0, &facts(S_IFREG | 0o644, O_WRONLY, false), true),
            MappingPreparation::Refused(Errno::EACCES)
        );
    }

    #[test]
    fn a_writable_mapping_needs_writeback_to_reach_persistent_storage() {
        assert_eq!(
            classify_file_mapping(true, 0, &facts(S_IFREG | 0o644, O_RDWR, true), false),
            MappingPreparation::Refused(Errno::EACCES),
            "a writable mapping whose stores could not be persisted is refused"
        );
        assert_eq!(
            classify_file_mapping(false, 0, &facts(S_IFREG | 0o644, O_RDWR, true), false),
            MappingPreparation::Backed {
                file_offset: 0,
                host_handle: 10,
                size: 8,
                writable: false,
                write_allowed: false,
            },
            "but a read-only mapping of it is fine, and is not upgradable"
        );
    }

    #[test]
    fn only_regular_files_take_this_path() {
        assert_eq!(
            classify_file_mapping(true, 0, &facts(S_IFCHR | 0o644, O_RDWR, true), true),
            MappingPreparation::Unsupported
        );
    }

    #[test]
    fn a_read_only_mapping_of_a_kernel_owned_file_is_populated_like_a_private_one() {
        // musl's `__map_file` — locale, timezone and message-catalog loading —
        // maps read-only `MAP_SHARED`. Refusing it because the file happens to
        // live on tmpfs would break all three.
        assert_eq!(
            classify_file_mapping(false, 0, &facts(S_IFREG | 0o644, O_RDONLY, false), false),
            MappingPreparation::Unsupported
        );
    }

    #[test]
    fn a_writable_mapping_of_a_kernel_owned_file_writes_back_through_its_own_fd() {
        assert_eq!(
            classify_file_mapping(true, 0, &facts(S_IFREG | 0o644, O_RDWR, false), false),
            MappingPreparation::FdWriteback {
                file_offset: 0,
                file_size: 8,
                dev: 1,
                ino: 2,
            },
            "the kernel's host-writeback capability is false here by \
             construction and must not be consulted"
        );
        assert_eq!(
            classify_file_mapping(true, 0, &facts(S_IFREG | 0o644, O_RDONLY, false), false),
            MappingPreparation::Refused(Errno::EACCES),
            "a shared writable mapping still needs O_RDWR"
        );
    }

    #[test]
    fn a_page_offset_that_cannot_be_a_byte_offset_is_refused() {
        assert_eq!(
            classify_file_mapping(
                false,
                u64::MAX / 2,
                &facts(S_IFREG | 0o644, O_RDWR, true),
                true
            ),
            MappingPreparation::Refused(Errno::EINVAL)
        );
    }

    #[test]
    fn the_page_offset_becomes_a_byte_offset() {
        let got = classify_file_mapping(false, 3, &facts(S_IFREG | 0o644, O_RDWR, true), true);
        let MappingPreparation::Backed { file_offset, .. } = got else {
            panic!("expected a backed mapping");
        };
        assert_eq!(file_offset, 3 * FILE_PAGE_SIZE as u64);
    }

    #[test]
    fn acquiring_a_backing_counts_the_mapping_that_caused_it() {
        // The invariant the whole cutover rests on: creation counts nothing,
        // so the registration path must take the reference.
        let mut io = Io::new(b"ABCDEFGH");
        let mut table = SharedMappingTable::new();

        let key = acquire_file_backing(
            &mut table,
            &mut io,
            1,
            2,
            10,
            8,
            S_IFREG | 0o644,
            true,
            0,
            8,
        )
        .unwrap();
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 1);

        // A second mapping of the same file joins the same backing.
        let again = acquire_file_backing(
            &mut table,
            &mut io,
            1,
            2,
            10,
            8,
            S_IFREG | 0o644,
            true,
            0,
            8,
        )
        .unwrap();
        assert_eq!(again, key, "same file identity, same backing");
        assert_eq!(
            table.file_backing(&key).unwrap().ref_count,
            2,
            "each mapping holds its own reference"
        );
    }

    #[test]
    fn an_empty_table_is_never_consulted() {
        let mut io = Io::new(b"ABCDEFGH");
        let mut table = SharedMappingTable::new();
        let mut res = Resolver::new("file:1:2");

        assert!(flush_before_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Write as u32, &[3, 0, 8], 8),
        ));
        reconcile_after_file_syscall(
            &mut table,
            &mut res,
            &mut io,
            1,
            &call(Syscall::Write as u32, &[3, 0, 8], 8),
            None,
        );
        assert_eq!(res.fd_lookups, 0, "no mapped file, no work and no lookup");
    }
}
