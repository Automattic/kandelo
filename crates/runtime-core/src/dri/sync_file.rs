//! `sync_file`: a file descriptor that carries one fence
//! (`drivers/dma-buf/sync_file.c`).
//!
//! A `sync_file` is how a fence crosses a process boundary: it is passed by
//! `fork`, `dup` and `SCM_RIGHTS` like any descriptor, `poll(2)` reports
//! `POLLIN` once its fence has signaled, and `SYNC_IOC_MERGE` /
//! `SYNC_IOC_FILE_INFO` combine and inspect fences. The fence a file holds
//! never changes; merging makes a new file.
//!
//! The descriptor is a kernel-owned character-device OFD with the
//! [`crate::ofd::SYNC_FILE_FD_HOST_HANDLE`] sentinel and a
//! [`crate::ofd::DriOfdState::SyncFile`] sidecar, the same shape a PRIME fd
//! uses. Like Linux's anonymous inode it is opened read-only, has no
//! read/write operations, and reports `st_mode` 0600 with no file type bits.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::rc::{Rc, Weak};
use alloc::vec::Vec;
use core::cell::RefCell;
use core::fmt;

use wasm_posix_shared::Errno;
use wasm_posix_shared::dri_sync::*;

use super::fence::{Fence, Status};
use crate::process::{HostIO, Process};

struct SyncFileInner {
    id: u64,
    fence: Fence,
    /// `sync_file.user_name`, set by `SYNC_IOC_MERGE`; empty otherwise.
    user_name: [u8; 32],
}

/// One `sync_file` object; every descriptor of it holds a clone.
#[derive(Clone)]
pub struct SyncFile(Rc<SyncFileInner>);

impl fmt::Debug for SyncFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SyncFile(#{} {:?})", self.0.id, self.0.fence)
    }
}

struct Live {
    next_id: u64,
    files: BTreeMap<u64, Weak<SyncFileInner>>,
}

#[cfg(not(test))]
struct LiveCell(RefCell<Live>);
#[cfg(not(test))]
unsafe impl Sync for LiveCell {}
#[cfg(not(test))]
static LIVE: LiveCell = LiveCell(RefCell::new(Live { next_id: 1, files: BTreeMap::new() }));
#[cfg(test)]
std::thread_local! {
    static LIVE: RefCell<Live> = const { RefCell::new(Live { next_id: 1, files: BTreeMap::new() }) };
}

/// For destructors: a test thread's storage may already be torn down when
/// its last objects drop at thread exit; nothing is left to update then.
fn with_live_on_drop(f: impl FnOnce(&mut Live)) {
    #[cfg(not(test))]
    { f(&mut LIVE.0.borrow_mut()) }
    #[cfg(test)]
    { let _ = LIVE.try_with(|g| f(&mut g.borrow_mut())); }
}

fn with_live<R>(f: impl FnOnce(&mut Live) -> R) -> R {
    #[cfg(not(test))]
    { f(&mut LIVE.0.borrow_mut()) }
    #[cfg(test)]
    { LIVE.with(|live| f(&mut live.borrow_mut())) }
}

impl Drop for SyncFileInner {
    fn drop(&mut self) {
        let id = self.id;
        with_live_on_drop(|live| { live.files.remove(&id); });
    }
}

impl SyncFile {
    /// `sync_file_create(fence)`.
    pub fn new(fence: Fence) -> Self {
        Self::named(fence, [0; 32])
    }

    fn named(fence: Fence, user_name: [u8; 32]) -> Self {
        let id = with_live(|live| {
            let id = live.next_id;
            live.next_id = live.next_id.checked_add(1).expect("sync_file id space exhausted");
            id
        });
        let file = SyncFile(Rc::new(SyncFileInner { id, fence, user_name }));
        with_live(|live| { live.files.insert(id, Rc::downgrade(&file.0)); });
        file
    }

    /// The live file with this identity (fork reconstruction).
    pub fn lookup(id: u64) -> Option<Self> {
        with_live(|live| live.files.get(&id).and_then(Weak::upgrade)).map(SyncFile)
    }

    pub fn id(&self) -> u64 { self.0.id }
    pub fn fence(&self) -> &Fence { &self.0.fence }

    /// `sync_file_get_name`.
    pub fn name(&self) -> [u8; 32] {
        if self.0.user_name[0] != 0 {
            return self.0.user_name;
        }
        let fence = &self.0.fence;
        let text = alloc::format!("{}-{}{}-{}", fence.driver_name(), fence.timeline_name(),
            fence.context(), fence.seqno() as i64);
        let mut name = [0u8; 32];
        copy_c_string(&mut name, text.as_bytes());
        name
    }

    /// `sync_file_poll`: readable once the fence has signaled. A poller is a
    /// waiter, so an unsignaled fence starts being observed.
    pub fn poll_readable(&self) -> bool {
        if self.0.fence.is_signaled() {
            return true;
        }
        self.0.fence.enable_signaling();
        false
    }
}

/// `strscpy` into a fixed C buffer: truncate, always NUL-terminate.
pub(crate) fn copy_c_string(dst: &mut [u8], src: &[u8]) {
    let len = src.iter().position(|&b| b == 0).unwrap_or(src.len()).min(dst.len() - 1);
    dst[..len].copy_from_slice(&src[..len]);
    dst[len..].fill(0);
}

// ── Descriptors ───────────────────────────────────────────────────────────

/// Install a new descriptor for `file` (`anon_inode_getfile("sync_file",
/// .., 0)` + `fd_install`): read-only, close-on-exec when asked.
pub fn install_fd(proc: &mut Process, file: SyncFile, cloexec: bool) -> Result<i32, Errno> {
    let path = alloc::format!("anon_inode:sync_file:{}", file.id()).into_bytes();
    let ofd = proc.ofd_table.create(crate::ofd::FileType::CharDevice,
        wasm_posix_shared::flags::O_RDONLY, crate::ofd::SYNC_FILE_FD_HOST_HANDLE, path);
    proc.ofd_table.get_mut(ofd).expect("fresh OFD").dri_state =
        Some(alloc::boxed::Box::new(crate::ofd::DriOfdState::SyncFile(file)));
    let flags = if cloexec { wasm_posix_shared::fd_flags::FD_CLOEXEC } else { 0 };
    match proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd), flags) {
        Ok(fd) => Ok(fd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd);
            Err(e)
        }
    }
}

/// `sync_file_fdget`: the `sync_file` behind `fd`, or `None` for a closed fd
/// or a descriptor of any other kind.
pub fn from_fd(proc: &Process, fd: i32) -> Option<SyncFile> {
    let entry = proc.fd_table.get(fd).ok()?;
    match proc.ofd_table.get(entry.ofd_ref.0)?.dri_state.as_deref()? {
        crate::ofd::DriOfdState::SyncFile(file) => Some(file.clone()),
        _ => None,
    }
}

fn now_ns(host: &mut dyn HostIO) -> Result<i64, Errno> {
    let (sec, nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC)?;
    Ok(sec.saturating_mul(1_000_000_000).saturating_add(nsec))
}

fn read_struct<T: Copy + Default>(buf: &[u8]) -> Result<T, Errno> {
    if buf.len() < core::mem::size_of::<T>() {
        return Err(Errno::EINVAL);
    }
    Ok(unsafe { core::ptr::read_unaligned(buf.as_ptr().cast()) })
}

fn write_struct<T: Copy>(buf: &mut [u8], value: T) {
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr().cast(), value) };
}

/// `sync_file_ioctl`. Unknown requests are `ENOTTY`.
pub fn ioctl(proc: &mut Process, host: &mut dyn HostIO, file: SyncFile, request: u32,
    buf: &mut [u8]) -> Result<(), Errno> {
    match request {
        SYNC_IOC_MERGE => {
            let mut data: SyncMergeData = read_struct(buf)?;
            if data.flags != 0 || data.pad != 0 {
                return Err(Errno::EINVAL);
            }
            let other = from_fd(proc, data.fd2).ok_or(Errno::ENOENT)?;
            data.name[31] = 0;
            let merged = Fence::merge(&[file.fence().clone(), other.fence().clone()]);
            let fd = install_fd(proc, SyncFile::named(merged, data.name), true)?;
            data.fence = fd;
            write_struct(buf, data);
            Ok(())
        }
        SYNC_IOC_FILE_INFO => {
            let mut info: SyncFileInfo = read_struct(buf)?;
            if info.flags != 0 || info.pad != 0 {
                return Err(Errno::EINVAL);
            }
            let mut leaves = Vec::new();
            file.fence().unwrap_into(&mut leaves);
            let count = u32::try_from(leaves.len()).map_err(|_| Errno::ENOMEM)?;
            if info.num_fences == 0 {
                // Only the count (and the file's own status) was asked for.
                info.status = file.fence().status().get_status();
            } else {
                if info.num_fences < count {
                    return Err(Errno::EINVAL);
                }
                let mut status = 1;
                let mut bytes = Vec::new();
                bytes.try_reserve_exact(leaves.len() * core::mem::size_of::<SyncFenceInfo>())
                    .map_err(|_| Errno::ENOMEM)?;
                for leaf in &leaves {
                    let mut record = SyncFenceInfo::default();
                    copy_c_string(&mut record.obj_name, leaf.timeline_name().as_bytes());
                    copy_c_string(&mut record.driver_name, leaf.driver_name().as_bytes());
                    let leaf_status = leaf.status();
                    record.status = leaf_status.get_status();
                    record.timestamp_ns = match leaf_status {
                        Status::Signaled { timestamp_ns, .. } => timestamp_ns as u64,
                        Status::Pending => 0,
                    };
                    if status > 0 {
                        status = record.status;
                    }
                    let raw: [u8; core::mem::size_of::<SyncFenceInfo>()] =
                        unsafe { core::mem::transmute(record) };
                    bytes.extend_from_slice(&raw);
                }
                info.status = status;
                let pid = proc.pid as i32;
                let pointer = crate::syscalls::probe_dri_process_pointer(host, pid,
                    info.sync_fence_info, bytes.len())?;
                crate::syscalls::write_dri_bytes(host, pid, pointer, &bytes)?;
            }
            info.name = file.name();
            info.num_fences = count;
            write_struct(buf, info);
            Ok(())
        }
        SYNC_IOC_SET_DEADLINE => {
            let deadline: SyncSetDeadline = read_struct(buf)?;
            if deadline.pad != 0 {
                return Err(Errno::EINVAL);
            }
            file.fence().set_deadline(deadline.deadline_ns);
            Ok(())
        }
        _ => Err(Errno::ENOTTY),
    }
}

/// `CLOCK_MONOTONIC` now, for callers that stamp fences they signal.
pub fn monotonic_now(host: &mut dyn HostIO) -> Result<i64, Errno> {
    now_ns(host)
}
