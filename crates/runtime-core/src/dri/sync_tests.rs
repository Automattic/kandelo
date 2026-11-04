// Explicit-synchronization syscall tests.
//
// Decision D-18 defers porting IGT; these mirror its `sw_sync`,
// `syncobj_basic`, `syncobj_wait`, `syncobj_timeline` and `syncobj_eventfd`
// subtests by name (`igt_<suite>_<subtest>`), driving the real ioctl,
// poll, fork and SCM_RIGHTS paths. Kandelo has no `sw_sync` debugfs device;
// pending fences come from the kernel's software timeline instead, installed
// as `sync_file` descriptors exactly as an exported fence would be.
//
// Included into `syscalls::tests` (include!) so the same `MockHostIO`
// drives them.

use super::*;
use crate::dri::fence::{Fence, Source, SwTimeline, Timeline};
use crate::dri::sync_file::{self, SyncFile};
use wasm_posix_shared::dri_sync::*;
use wasm_posix_shared::poll::{POLLIN, POLLOUT};

const HANDLES_AT: u64 = 0x2000;
const POINTS_AT: u64 = 0x3000;
const INFO_AT: u64 = 0x4000;

struct Drm {
    proc: Process,
    host: MockHostIO,
    fd: i32,
}

fn drm() -> Drm {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    host.monotonic_time = Some((100, 0));
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    Drm { proc, host, fd }
}

fn bytes_of<T: Copy>(value: &T) -> Vec<u8> {
    let mut buf = alloc::vec![0u8; core::mem::size_of::<T>()];
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr().cast::<T>(), *value) };
    buf
}

fn from_bytes<T: Copy>(buf: &[u8]) -> T {
    unsafe { core::ptr::read_unaligned(buf.as_ptr().cast::<T>()) }
}

fn sw(name: &'static str) -> SwTimeline {
    SwTimeline::new("sw_sync", Timeline::Static(name))
}

impl Drm {
    fn io<T: Copy>(&mut self, fd: i32, request: u32, value: T) -> Result<T, Errno> {
        let mut buf = bytes_of(&value);
        sys_ioctl(&mut self.proc, &mut self.host, fd, request, &mut buf)?;
        Ok(from_bytes(&buf))
    }

    fn now(&self) -> i64 {
        let (sec, nsec) = self.host.monotonic_time.unwrap();
        sec * 1_000_000_000 + nsec
    }

    fn set_now_ns(&mut self, ns: i64) {
        self.host.monotonic_time = Some((ns / 1_000_000_000, ns % 1_000_000_000));
    }

    fn create(&mut self, flags: u32) -> u32 {
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_CREATE, DrmSyncobjCreate { handle: 0, flags })
            .unwrap().handle
    }

    fn destroy(&mut self, handle: u32) -> Result<(), Errno> {
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_DESTROY, DrmSyncobjDestroy { handle, pad: 0 })
            .map(drop)
    }

    fn put_handles(&mut self, handles: &[u32]) -> u64 {
        let at = HANDLES_AT as usize;
        for (i, h) in handles.iter().enumerate() {
            self.host.proc_memory[at + 4 * i..at + 4 * i + 4].copy_from_slice(&h.to_le_bytes());
        }
        HANDLES_AT
    }

    fn put_points(&mut self, points: &[u64]) -> u64 {
        let at = POINTS_AT as usize;
        for (i, p) in points.iter().enumerate() {
            self.host.proc_memory[at + 8 * i..at + 8 * i + 8].copy_from_slice(&p.to_le_bytes());
        }
        POINTS_AT
    }

    fn points_out(&self, count: usize) -> Vec<u64> {
        let at = POINTS_AT as usize;
        (0..count).map(|i| u64::from_le_bytes(
            self.host.proc_memory[at + 8 * i..at + 8 * i + 8].try_into().unwrap())).collect()
    }

    fn wait(&mut self, handles: &[u32], timeout_nsec: i64, flags: u32) -> Result<u32, Errno> {
        let ptr = self.put_handles(handles);
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_WAIT, DrmSyncobjWait { handles: ptr, timeout_nsec,
            count_handles: handles.len() as u32, flags, ..Default::default() })
            .map(|w| w.first_signaled)
    }

    fn tl_wait(&mut self, handles: &[u32], points: &[u64], timeout_nsec: i64, flags: u32)
        -> Result<u32, Errno> {
        let hp = self.put_handles(handles);
        let pp = self.put_points(points);
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT, DrmSyncobjTimelineWait { handles: hp,
            points: pp, timeout_nsec, count_handles: handles.len() as u32, flags,
            ..Default::default() }).map(|w| w.first_signaled)
    }

    fn array(&mut self, request: u32, handles: &[u32]) -> Result<(), Errno> {
        let ptr = self.put_handles(handles);
        self.io(self.fd, request, DrmSyncobjArray { handles: ptr,
            count_handles: handles.len() as u32, pad: 0 }).map(drop)
    }

    fn signal(&mut self, handles: &[u32]) -> Result<(), Errno> {
        self.array(DRM_IOCTL_SYNCOBJ_SIGNAL, handles)
    }

    fn reset(&mut self, handles: &[u32]) -> Result<(), Errno> {
        self.array(DRM_IOCTL_SYNCOBJ_RESET, handles)
    }

    fn tl_signal(&mut self, handles: &[u32], points: &[u64]) -> Result<(), Errno> {
        let hp = self.put_handles(handles);
        let pp = self.put_points(points);
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL, DrmSyncobjTimelineArray { handles: hp,
            points: pp, count_handles: handles.len() as u32, flags: 0 }).map(drop)
    }

    fn query(&mut self, handles: &[u32], flags: u32) -> Result<Vec<u64>, Errno> {
        let hp = self.put_handles(handles);
        self.put_points(&alloc::vec![0xdead; handles.len()]);
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_QUERY, DrmSyncobjTimelineArray { handles: hp,
            points: POINTS_AT, count_handles: handles.len() as u32, flags })?;
        Ok(self.points_out(handles.len()))
    }

    fn import(&mut self, handle: u32, sync_fd: i32, point: u64) -> Result<(), Errno> {
        let flags = DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_IMPORT_SYNC_FILE
            | if point != 0 { DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_TIMELINE } else { 0 };
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE, DrmSyncobjHandle { handle, flags,
            fd: sync_fd, pad: 0, point }).map(drop)
    }

    fn export(&mut self, handle: u32, point: u64) -> Result<i32, Errno> {
        let flags = DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_EXPORT_SYNC_FILE
            | if point != 0 { DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_TIMELINE } else { 0 };
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD, DrmSyncobjHandle { handle, flags,
            fd: -1, pad: 0, point }).map(|h| h.fd)
    }

    fn transfer(&mut self, dst: u32, dst_point: u64, src: u32, src_point: u64, flags: u32)
        -> Result<(), Errno> {
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_TRANSFER, DrmSyncobjTransfer { src_handle: src,
            dst_handle: dst, src_point, dst_point, flags, pad: 0 }).map(drop)
    }

    /// A `sync_file` fd holding a pending software fence at `seqno`.
    fn sw_fd(&mut self, timeline: &mut SwTimeline, seqno: u64) -> i32 {
        let fence = timeline.create_fence(seqno, self.now());
        sync_file::install_fd(&mut self.proc, SyncFile::new(fence), true).unwrap()
    }

    fn readable(&mut self, fd: i32) -> bool {
        let mut fds = [WasmPollFd { fd, events: POLLIN, revents: 0 }];
        sys_poll(&mut self.proc, &mut self.host, &mut fds, 0).unwrap();
        fds[0].revents & POLLIN != 0
    }

    fn merge(&mut self, a: i32, b: i32) -> Result<i32, Errno> {
        let mut data = SyncMergeData { fd2: b, ..Default::default() };
        data.name[..5].copy_from_slice(b"merge");
        self.io(a, SYNC_IOC_MERGE, data).map(|d| d.fence)
    }

    /// `sync_fence_count_status`: (fences, active, signaled, errored).
    fn info(&mut self, fd: i32) -> (SyncFileInfo, Vec<SyncFenceInfo>) {
        let count = self.io(fd, SYNC_IOC_FILE_INFO, SyncFileInfo::default()).unwrap().num_fences;
        let info = self.io(fd, SYNC_IOC_FILE_INFO, SyncFileInfo { num_fences: count,
            sync_fence_info: INFO_AT, ..Default::default() }).unwrap();
        let at = INFO_AT as usize;
        let size = core::mem::size_of::<SyncFenceInfo>();
        let fences = (0..count as usize)
            .map(|i| from_bytes(&self.host.proc_memory[at + i * size..at + (i + 1) * size]))
            .collect();
        (info, fences)
    }

    fn count_status(&mut self, fd: i32, status: i32) -> usize {
        self.info(fd).1.iter().filter(|f| if status < 0 { f.status < 0 } else { f.status == status })
            .count()
    }
}

fn name_of(bytes: &[u8]) -> &str {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    core::str::from_utf8(&bytes[..end]).unwrap()
}

// ── caps and permissions ───────────────────────────────────────────────────

#[test]
fn syncobj_caps_are_advertised_on_render_and_primary_nodes() {
    use wasm_posix_shared::dri::*;
    let mut d = drm();
    for capability in [DRM_CAP_SYNCOBJ, DRM_CAP_SYNCOBJ_TIMELINE] {
        let cap = d.io(d.fd, DRM_IOCTL_GET_CAP, WpkDrmGetCap { capability, value: 7 }).unwrap();
        assert_eq!(cap.value, 1, "capability {capability:#x}");
    }
    // Render-node allowed: the whole family works on renderD128.
    let h = d.create(DRM_SYNCOBJ_CREATE_SIGNALED);
    assert_eq!(d.wait(&[h], 0, 0), Ok(0));
}

#[test]
fn syncobj_ioctls_have_marshalling_contracts() {
    for request in [DRM_IOCTL_SYNCOBJ_CREATE, DRM_IOCTL_SYNCOBJ_DESTROY,
        DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE,
        DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD_V1, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE_V1,
        DRM_IOCTL_SYNCOBJ_WAIT, DRM_IOCTL_SYNCOBJ_WAIT_V1, DRM_IOCTL_SYNCOBJ_RESET,
        DRM_IOCTL_SYNCOBJ_SIGNAL, DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT,
        DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT_V1, DRM_IOCTL_SYNCOBJ_QUERY, DRM_IOCTL_SYNCOBJ_TRANSFER,
        DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL, DRM_IOCTL_SYNCOBJ_EVENTFD, SYNC_IOC_MERGE,
        SYNC_IOC_FILE_INFO, SYNC_IOC_SET_DEADLINE, DMA_BUF_IOCTL_EXPORT_SYNC_FILE,
        DMA_BUF_IOCTL_IMPORT_SYNC_FILE, DRM_IOCTL_WPK_EXPORT_FENCE] {
        let contract = wasm_posix_shared::ioctl_contract::request_contract(request)
            .unwrap_or_else(|| panic!("{request:#x} has no contract"));
        let encoded = (request >> 16) & 0x3fff;
        assert_eq!(contract.size_for_pointer_width(4), Some(encoded));
        assert_eq!(contract.size_for_pointer_width(8), Some(encoded));
    }
}

// ── syncobj_basic ──────────────────────────────────────────────────────────

#[test]
fn igt_syncobj_basic_bad_destroy() {
    let mut d = drm();
    assert_eq!(d.destroy(0xdeadbeef), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_bad_create_flags() {
    let mut d = drm();
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_CREATE,
        DrmSyncobjCreate { handle: 0, flags: 0xdeadbeef }).map(drop), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_bad_handle_to_fd() {
    let mut d = drm();
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD,
        DrmSyncobjHandle { handle: 0xdeadbeef, ..Default::default() }).map(drop),
        Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_bad_fd_to_handle() {
    let mut d = drm();
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE,
        DrmSyncobjHandle { fd: -1, ..Default::default() }).map(drop), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_illegal_fd_to_handle() {
    let mut d = drm();
    // A DRM fd is not a syncobj fd.
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE,
        DrmSyncobjHandle { fd: d.fd, ..Default::default() }).map(drop), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_bad_flags_and_pad() {
    let mut d = drm();
    let h = d.create(0);
    for request in [DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE] {
        assert_eq!(d.io(d.fd, request, DrmSyncobjHandle { handle: h, flags: 0xdeadbeef,
            fd: -1, ..Default::default() }).map(drop), Err(Errno::EINVAL), "flags {request:#x}");
        assert_eq!(d.io(d.fd, request, DrmSyncobjHandle { handle: h, pad: 0xdeadbeef,
            fd: -1, ..Default::default() }).map(drop), Err(Errno::EINVAL), "pad {request:#x}");
    }
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_DESTROY, DrmSyncobjDestroy { handle: h,
        pad: 0xdeadbeef }).map(drop), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_create_signaled() {
    let mut d = drm();
    let h = d.create(DRM_SYNCOBJ_CREATE_SIGNALED);
    assert_eq!(d.wait(&[h], 0, 0), Ok(0));
    let unsignaled = d.create(0);
    assert_eq!(d.wait(&[unsignaled], 0, 0), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_basic_test_valid_cycle() {
    let mut d = drm();
    let first = d.create(0);
    let shared = d.io(d.fd, DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD,
        DrmSyncobjHandle { handle: first, ..Default::default() }).unwrap().fd;
    // A syncobj fd is close-on-exec, read-only and an anonymous inode.
    let entry = d.proc.fd_table.get(shared).unwrap();
    assert_ne!(entry.fd_flags & wasm_posix_shared::fd_flags::FD_CLOEXEC, 0);
    assert_eq!(sys_fstat(&d.proc, &mut d.host, shared).unwrap().st_mode, 0o600);
    let second = d.io(d.fd, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE,
        DrmSyncobjHandle { fd: shared, ..Default::default() }).unwrap().handle;
    assert_ne!(first, second);
    // Both handles name one object.
    d.signal(&[first]).unwrap();
    assert_eq!(d.wait(&[second], 0, 0), Ok(0));
    d.destroy(first).unwrap();
    d.destroy(second).unwrap();
    // Linux idr reuses the lowest free handle.
    assert_eq!(d.create(0), 1);
    sys_close(&mut d.proc, &mut d.host, shared).unwrap();
}

#[test]
fn syncobj_handle_structs_without_point_are_accepted() {
    // Older headers, without `point`, encode a 16-byte drm_syncobj_handle.
    let mut d = drm();
    let h = d.create(DRM_SYNCOBJ_CREATE_SIGNALED);
    let mut buf = bytes_of(&DrmSyncobjHandle { handle: h, ..Default::default() });
    buf.truncate(16);
    sys_ioctl(&mut d.proc, &mut d.host, d.fd, DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD_V1, &mut buf).unwrap();
    let fd = i32::from_le_bytes(buf[8..12].try_into().unwrap());
    assert!(fd >= 0);
}

// ── syncobj_wait ───────────────────────────────────────────────────────────

#[test]
fn igt_syncobj_wait_invalid_wait_bad_flags() {
    let mut d = drm();
    let h = d.create(0);
    assert_eq!(d.wait(&[h], 0, 0xdeadbeef), Err(Errno::EINVAL));
    // WAIT_AVAILABLE is a timeline-wait flag only.
    assert_eq!(d.wait(&[h], 0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_wait_wait_zero_handles() {
    let mut d = drm();
    assert_eq!(d.wait(&[], 0, 0), Ok(0));
    assert_eq!(d.tl_wait(&[], &[], 0, 0), Ok(0));
}

#[test]
fn igt_syncobj_wait_invalid_wait_illegal_handle() {
    let mut d = drm();
    assert_eq!(d.wait(&[0], 0, 0), Err(Errno::ENOENT));
}

#[test]
fn igt_syncobj_wait_invalid_reset_and_signal_arrays() {
    let mut d = drm();
    for request in [DRM_IOCTL_SYNCOBJ_RESET, DRM_IOCTL_SYNCOBJ_SIGNAL] {
        // *-zero-handles
        assert_eq!(d.array(request, &[]), Err(Errno::EINVAL));
        // *-illegal-handle
        assert_eq!(d.array(request, &[0]), Err(Errno::ENOENT));
        // *-one-illegal-handle
        let a = d.create(0);
        let b = d.create(0);
        assert_eq!(d.array(request, &[a, 0, b]), Err(Errno::ENOENT));
        // *-bad-pad
        let ptr = d.put_handles(&[a]);
        assert_eq!(d.io(d.fd, request, DrmSyncobjArray { handles: ptr, count_handles: 1,
            pad: 0xdeadbeef }).map(drop), Err(Errno::EINVAL));
    }
}

#[test]
fn igt_syncobj_wait_single_wait() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    // Unsubmitted: EINVAL, or ETIME when waiting for submission with no time.
    assert_eq!(d.wait(&[h], 0, 0), Err(Errno::EINVAL));
    assert_eq!(d.wait(&[h], 0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT), Err(Errno::ETIME));
    // Submitted, unsignaled: ETIME.
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 0).unwrap();
    assert_eq!(d.wait(&[h], 0, 0), Err(Errno::ETIME));
    // Signaled.
    t.inc(1, d.now());
    for flags in [0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT] {
        assert_eq!(d.wait(&[h], 0, flags), Ok(0));
    }
}

#[test]
fn igt_syncobj_wait_wait_delayed_signal() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 0).unwrap();
    let deadline = d.now() + 1_000_000_000;
    // Blocking: parks on the host's retry path.
    assert_eq!(d.wait(&[h], deadline, 0), Err(Errno::EAGAIN));
    // (The import itself asked parked callers to retry; consume that.)
    crate::dri::fence::take_wake();
    assert!(!crate::dri::fence::take_wake());
    t.inc(1, d.now());
    // The signal asks the host to retry parked callers; the retry finishes.
    assert!(crate::dri::fence::take_wake());
    assert_eq!(d.wait(&[h], deadline, 0), Ok(0));
    assert_eq!(crate::dri::syncobj::pending_wait_count(), 0);
}

#[test]
fn syncobj_wait_times_out_with_etime_at_its_absolute_deadline() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 0).unwrap();
    let deadline = d.now() + 5_000;
    assert_eq!(d.wait(&[h], deadline, 0), Err(Errno::EAGAIN));
    d.set_now_ns(deadline);
    assert_eq!(d.wait(&[h], deadline, 0), Err(Errno::ETIME));
    assert_eq!(crate::dri::syncobj::pending_wait_count(), 0);
}

#[test]
fn igt_syncobj_wait_wait_for_submit_delayed_submit() {
    let mut d = drm();
    let h = d.create(0);
    let deadline = d.now() + 1_000_000_000;
    let flags = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT;
    assert_eq!(d.wait(&[h], deadline, flags), Err(Errno::EAGAIN));
    d.signal(&[h]).unwrap();
    assert!(crate::dri::fence::take_wake(), "a submission wakes parked waits");
    assert_eq!(d.wait(&[h], deadline, flags), Ok(0));
}

#[test]
fn igt_syncobj_wait_wait_all_delayed_signal() {
    let mut d = drm();
    let mut t = sw("t");
    let a = d.create(0);
    let b = d.create(0);
    let fa = d.sw_fd(&mut t, 1);
    let fb = d.sw_fd(&mut t, 2);
    d.import(a, fa, 0).unwrap();
    d.import(b, fb, 0).unwrap();
    let deadline = d.now() + 1_000_000_000;
    let all = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL;
    assert_eq!(d.wait(&[a, b], deadline, all), Err(Errno::EAGAIN));
    t.inc(1, d.now());
    assert_eq!(d.wait(&[a, b], deadline, all), Err(Errno::EAGAIN));
    // Wait-any on the same objects is satisfied by the first.
    crate::dri::syncobj::forget_task(1, 1);
    assert_eq!(d.wait(&[b, a], deadline, 0), Ok(1));
    t.inc(1, d.now());
    // A fresh wait-all whose objects are all signaled reports the first.
    assert_eq!(d.wait(&[a, b], deadline, all), Ok(0));
}

#[test]
fn igt_syncobj_wait_reset_unsignaled_and_signaled() {
    let mut d = drm();
    let h = d.create(0);
    d.reset(&[h]).unwrap();
    assert_eq!(d.wait(&[h], 0, 0), Err(Errno::EINVAL));
    let s = d.create(DRM_SYNCOBJ_CREATE_SIGNALED);
    d.reset(&[s]).unwrap();
    assert_eq!(d.wait(&[s], 0, 0), Err(Errno::EINVAL));
    // reset-multiple-signaled
    let many: Vec<u32> = (0..5).map(|_| d.create(DRM_SYNCOBJ_CREATE_SIGNALED)).collect();
    d.reset(&many).unwrap();
    for h in many {
        assert_eq!(d.wait(&[h], 0, 0), Err(Errno::EINVAL));
    }
}

#[test]
fn igt_syncobj_wait_reset_during_wait_for_submit() {
    let mut d = drm();
    let h = d.create(0);
    let deadline = d.now() + 1_000_000_000;
    let flags = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT;
    assert_eq!(d.wait(&[h], deadline, flags), Err(Errno::EAGAIN));
    d.reset(&[h]).unwrap();
    assert_eq!(d.wait(&[h], deadline, flags), Err(Errno::EAGAIN));
    d.signal(&[h]).unwrap();
    assert_eq!(d.wait(&[h], deadline, flags), Ok(0));
}

#[test]
fn igt_syncobj_wait_signal() {
    let mut d = drm();
    let h = d.create(0);
    d.signal(&[h]).unwrap();
    assert_eq!(d.wait(&[h], 0, 0), Ok(0));
}

#[test]
fn igt_syncobj_wait_multi_wait() {
    let mut d = drm();
    let mut t = sw("t");
    let unsubmitted = d.create(0);
    let submitted = d.create(0);
    let signaled = d.create(DRM_SYNCOBJ_CREATE_SIGNALED);
    let fd = d.sw_fd(&mut t, 1);
    d.import(submitted, fd, 0).unwrap();
    let submit = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT;
    let all = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL;
    // Any unsubmitted object without WAIT_FOR_SUBMIT is EINVAL.
    assert_eq!(d.wait(&[signaled, unsubmitted], 0, 0), Err(Errno::EINVAL));
    // Wait-any finds the signaled one and reports its index.
    assert_eq!(d.wait(&[submitted, signaled], 0, 0), Ok(1));
    assert_eq!(d.wait(&[unsubmitted, submitted, signaled], 0, submit), Ok(2));
    // Wait-all needs every object.
    assert_eq!(d.wait(&[submitted, signaled], 0, all), Err(Errno::ETIME));
    t.inc(1, d.now());
    assert_eq!(d.wait(&[submitted, signaled], 0, all), Ok(0));
}

#[test]
fn igt_syncobj_wait_wait_any_and_all_snapshot() {
    for all in [false, true] {
        let mut d = drm();
        let mut t = sw("t");
        let a = d.create(0);
        let b = d.create(0);
        let fa = d.sw_fd(&mut t, 1);
        let fb = d.sw_fd(&mut t, 2);
        d.import(a, fa, 0).unwrap();
        d.import(b, fb, 0).unwrap();
        let flags = if all { DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL } else { 0 };
        let deadline = d.now() + 1_000_000_000;
        assert_eq!(d.wait(&[a, b], deadline, flags), Err(Errno::EAGAIN));
        // Resetting the objects does not change what a wait in progress
        // waits on.
        d.reset(&[a, b]).unwrap();
        assert_eq!(d.wait(&[a, b], deadline, flags), Err(Errno::EAGAIN));
        t.inc(2, d.now());
        let first = d.wait(&[a, b], deadline, flags).unwrap();
        assert_eq!(first, if all { u32::MAX } else { 0 });
    }
}

#[test]
fn igt_syncobj_wait_wait_any_interrupted() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 0).unwrap();
    let deadline = d.now() + 1_000_000_000;
    assert_eq!(d.wait(&[h], deadline, 0), Err(Errno::EAGAIN));
    // A handler signal interrupts the parked call (the host completes it
    // with EINTR); its snapshot dies with it, so a restart captures anew.
    crate::dri::syncobj::forget_task(d.proc.pid, d.proc.pid);
    assert_eq!(crate::dri::syncobj::pending_wait_count(), 0);
    d.reset(&[h]).unwrap();
    assert_eq!(d.wait(&[h], deadline, 0), Err(Errno::EINVAL));
}

#[test]
fn syncobj_wait_snapshot_is_dropped_when_the_process_retires() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 0).unwrap();
    assert_eq!(d.wait(&[h], d.now() + 1_000_000, 0), Err(Errno::EAGAIN));
    crate::wait_park::retire_process(d.proc.pid);
    assert_eq!(crate::dri::syncobj::pending_wait_count(), 0);
}

#[test]
fn syncobj_wait_works_for_wasm64_callers() {
    // Every pointer member is a __u64, so both widths use one layout.
    let mut d = drm();
    d.proc.pointer_width = 8;
    let h = d.create(DRM_SYNCOBJ_CREATE_SIGNALED);
    assert_eq!(d.wait(&[h], 0, 0), Ok(0));
    d.tl_signal(&[h], &[3]).unwrap();
    assert_eq!(d.query(&[h], 0), Ok(alloc::vec![3]));
}

// ── syncobj_timeline ───────────────────────────────────────────────────────

#[test]
fn igt_syncobj_timeline_invalid_query() {
    let mut d = drm();
    assert_eq!(d.query(&[], 0), Err(Errno::EINVAL)); // zero-handles
    assert_eq!(d.query(&[0], 0), Err(Errno::ENOENT)); // illegal-handle
    let a = d.create(0);
    let b = d.create(0);
    d.tl_signal(&[a], &[1]).unwrap();
    d.tl_signal(&[b], &[1]).unwrap();
    assert_eq!(d.query(&[a, 0, b], 0), Err(Errno::ENOENT)); // one-illegal-handle
    assert_eq!(d.query(&[0], 0xdeadbeef), Err(Errno::EINVAL)); // bad-pad (flags)
}

#[test]
fn igt_syncobj_timeline_invalid_signal() {
    let mut d = drm();
    assert_eq!(d.tl_signal(&[], &[]), Err(Errno::EINVAL));
    assert_eq!(d.tl_signal(&[0], &[1]), Err(Errno::ENOENT));
    // invalid-signal-illegal-point: handle 1 does not exist yet.
    assert_eq!(d.tl_signal(&[1], &[0]), Err(Errno::ENOENT));
    let hp = d.put_handles(&[1]);
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL, DrmSyncobjTimelineArray {
        handles: hp, points: POINTS_AT, count_handles: 1, flags: 0xdeadbeef }).map(drop),
        Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_timeline_signal_array() {
    let mut d = drm();
    let hs: Vec<u32> = (0..4).map(|_| d.create(0)).collect();
    d.tl_signal(&hs, &[1, 2, 3, 4]).unwrap();
    assert_eq!(d.query(&hs, 0), Ok(alloc::vec![1, 2, 3, 4]));
    assert_eq!(d.tl_wait(&hs, &[1, 2, 3, 4], 0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL), Ok(0));
}

#[test]
fn igt_syncobj_timeline_invalid_transfer() {
    let mut d = drm();
    let a = d.create(0);
    // illegal-handle
    assert_eq!(d.transfer(0, 0, a, 0, 0), Err(Errno::ENOENT));
    assert_eq!(d.transfer(a, 0, 0, 0, 0), Err(Errno::ENOENT));
    // bad-pad
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_TRANSFER, DrmSyncobjTransfer { src_handle: a,
        dst_handle: a, pad: 0xdeadbeef, ..Default::default() }).map(drop), Err(Errno::EINVAL));
    // non-existent-point
    let b = d.create(0);
    d.tl_signal(&[a], &[1]).unwrap();
    assert_eq!(d.transfer(b, 0, a, 2, 0), Err(Errno::EINVAL));
}

#[test]
fn igt_syncobj_timeline_transfer_timeline_point() {
    let mut d = drm();
    let mut t = sw("t");
    let binary = d.create(0);
    let timeline = d.create(0);
    let fd = d.sw_fd(&mut t, 1);
    d.import(binary, fd, 0).unwrap();
    d.transfer(timeline, 3, binary, 0, 0).unwrap();
    assert_eq!(d.query(&[timeline], 0), Ok(alloc::vec![0]));
    assert_eq!(d.query(&[timeline], DRM_SYNCOBJ_QUERY_FLAGS_LAST_SUBMITTED), Ok(alloc::vec![3]));
    assert_eq!(d.tl_wait(&[timeline], &[3], 0, 0), Err(Errno::ETIME));
    assert_eq!(d.tl_wait(&[timeline], &[3], 0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE), Ok(0));
    t.inc(1, d.now());
    assert_eq!(d.query(&[timeline], 0), Ok(alloc::vec![3]));
    // And back from the timeline point to another binary object.
    let back = d.create(0);
    d.transfer(back, 0, timeline, 3, 0).unwrap();
    assert_eq!(d.wait(&[back], 0, 0), Ok(0));
}

#[test]
fn syncobj_transfer_wait_for_submit_parks_until_the_point_exists() {
    let mut d = drm();
    let src = d.create(0);
    let dst = d.create(0);
    let submit = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT;
    assert_eq!(d.transfer(dst, 0, src, 2, submit), Err(Errno::EAGAIN));
    d.tl_signal(&[src], &[2]).unwrap();
    assert_eq!(d.transfer(dst, 0, src, 2, submit), Ok(()));
    assert_eq!(d.wait(&[dst], 0, 0), Ok(0));
    // Nothing submitted for five seconds: ETIME.
    let late = d.create(0);
    assert_eq!(d.transfer(dst, 0, late, 1, submit), Err(Errno::EAGAIN));
    d.set_now_ns(d.now() + 5_000_000_000);
    assert_eq!(d.transfer(dst, 0, late, 1, submit), Err(Errno::ETIME));
}

#[test]
fn igt_syncobj_timeline_host_signal_points() {
    let mut d = drm();
    let h = d.create(0);
    for point in 1..=10u64 {
        d.tl_signal(&[h], &[point * 2]).unwrap();
        assert_eq!(d.query(&[h], 0), Ok(alloc::vec![point * 2]));
        assert_eq!(d.tl_wait(&[h], &[point * 2 - 1], 0, 0), Ok(0));
    }
}

#[test]
fn igt_syncobj_timeline_host_signal_ordered() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    // Points 1..3 from a GPU-like producer; point 2 completes only after 1.
    let f1 = d.sw_fd(&mut t, 1);
    let f3 = d.sw_fd(&mut t, 3);
    d.import(h, f1, 1).unwrap();
    d.tl_signal(&[h], &[2]).unwrap();
    d.import(h, f3, 3).unwrap();
    assert_eq!(d.query(&[h], 0), Ok(alloc::vec![0]));
    assert_eq!(d.tl_wait(&[h], &[2], 0, 0), Err(Errno::ETIME));
    t.inc(1, d.now());
    assert_eq!(d.query(&[h], 0), Ok(alloc::vec![2]));
    assert_eq!(d.tl_wait(&[h], &[2], 0, 0), Ok(0));
    assert_eq!(d.tl_wait(&[h], &[3], 0, 0), Err(Errno::ETIME));
    t.inc(2, d.now());
    assert_eq!(d.query(&[h], 0), Ok(alloc::vec![3]));
}

#[test]
fn igt_syncobj_timeline_device_signal_unordered() {
    let mut d = drm();
    let h = d.create(0);
    d.tl_signal(&[h], &[5]).unwrap();
    // A point below the last one starts a new context and keeps the max.
    d.tl_signal(&[h], &[3]).unwrap();
    assert_eq!(d.query(&[h], DRM_SYNCOBJ_QUERY_FLAGS_LAST_SUBMITTED), Ok(alloc::vec![5]));
    assert_eq!(d.tl_wait(&[h], &[5], 0, 0), Ok(0));
}

#[test]
fn igt_syncobj_timeline_signal_point_0() {
    let mut d = drm();
    let h = d.create(0);
    d.tl_signal(&[h], &[0]).unwrap();
    assert_eq!(d.tl_wait(&[h], &[0], 0, 0), Ok(0));
    assert_eq!(d.wait(&[h], 0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT), Ok(0));
}

#[test]
fn igt_syncobj_timeline_32bits_limit() {
    let mut d = drm();
    let h = d.create(0);
    let points = [u32::MAX as u64 - 1, u32::MAX as u64, (1u64 << 32) + 1];
    for &p in &points {
        d.tl_signal(&[h], &[p]).unwrap();
        assert_eq!(d.query(&[h], 0), Ok(alloc::vec![p]));
    }
}

#[test]
fn igt_syncobj_timeline_wait_for_submit_and_available() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    let deadline = d.now() + 1_000_000_000;
    let available = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE;
    // Unsubmitted point 2: available-wait parks, then the submission alone
    // (not the signal) completes it.
    assert_eq!(d.tl_wait(&[h], &[2], deadline, available), Err(Errno::EAGAIN));
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 2).unwrap();
    assert_eq!(d.tl_wait(&[h], &[2], deadline, available), Ok(0));
    assert_eq!(d.tl_wait(&[h], &[2], 0, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT),
        Err(Errno::ETIME));
}

// ── syncobj_eventfd ────────────────────────────────────────────────────────

impl Drm {
    fn eventfd(&mut self, handle: u32, point: u64, efd: i32, flags: u32) -> Result<(), Errno> {
        self.io(self.fd, DRM_IOCTL_SYNCOBJ_EVENTFD, DrmSyncobjEventfd { handle, flags, point,
            fd: efd, pad: 0 }).map(drop)
    }

    fn eventfd_count(&mut self, efd: i32) -> Option<u64> {
        let mut buf = [0u8; 8];
        match sys_read(&mut self.proc, &mut self.host, efd, &mut buf) {
            Ok(8) => Some(u64::from_le_bytes(buf)),
            Err(Errno::EAGAIN) => None,
            other => panic!("eventfd read {other:?}"),
        }
    }
}

#[test]
fn igt_syncobj_eventfd_invalid() {
    let mut d = drm();
    let h = d.create(0);
    let efd = sys_eventfd2(&mut d.proc, 0, O_NONBLOCK).unwrap();
    assert_eq!(d.eventfd(h, 0, efd, 0xdeadbeef), Err(Errno::EINVAL)); // bad-flags
    assert_eq!(d.eventfd(0, 0, efd, 0), Err(Errno::ENOENT)); // illegal-handle
    assert_eq!(d.eventfd(h, 0, d.fd, 0), Err(Errno::EINVAL)); // illegal-eventfd
    assert_eq!(d.eventfd(h, 0, 999, 0), Err(Errno::EBADF));
    assert_eq!(d.io(d.fd, DRM_IOCTL_SYNCOBJ_EVENTFD, DrmSyncobjEventfd { handle: h, fd: efd,
        pad: 0xdeadbeef, ..Default::default() }).map(drop), Err(Errno::EINVAL)); // bad-pad
}

#[test]
fn igt_syncobj_eventfd_wait_before_and_after_signal() {
    for timeline in [false, true] {
        let mut d = drm();
        let mut t = sw("t");
        let point = if timeline { 1 } else { 0 };
        let h = d.create(0);
        let efd = sys_eventfd2(&mut d.proc, 0, O_NONBLOCK).unwrap();
        // wait-before-signal: registered on an unsubmitted point.
        d.eventfd(h, point, efd, 0).unwrap();
        assert_eq!(d.eventfd_count(efd), None);
        let fd = d.sw_fd(&mut t, 1);
        d.import(h, fd, point).unwrap();
        assert_eq!(d.eventfd_count(efd), None, "submitted is not signaled");
        t.inc(1, d.now());
        assert_eq!(d.eventfd_count(efd), Some(1));
        // wait-signaled: already signaled fires at once.
        d.eventfd(h, point, efd, 0).unwrap();
        assert_eq!(d.eventfd_count(efd), Some(1));
        // wait-available fires on submission.
        let h2 = d.create(0);
        d.eventfd(h2, point, efd, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE).unwrap();
        assert_eq!(d.eventfd_count(efd), None);
        let fd2 = d.sw_fd(&mut t, 5);
        d.import(h2, fd2, point).unwrap();
        assert_eq!(d.eventfd_count(efd), Some(1));
    }
}

#[test]
fn syncobj_eventfd_keeps_its_eventfd_alive_after_close() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    let efd = sys_eventfd2(&mut d.proc, 0, O_NONBLOCK).unwrap();
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 0).unwrap();
    d.eventfd(h, 0, efd, 0).unwrap();
    let dup = sys_dup(&mut d.proc, efd).unwrap();
    sys_close(&mut d.proc, &mut d.host, efd).unwrap();
    t.inc(1, d.now());
    assert_eq!(d.eventfd_count(dup), Some(1));
}

// ── sync_file (sw_sync) ────────────────────────────────────────────────────

#[test]
fn igt_sw_sync_alloc_fence_and_merge_fence() {
    let mut d = drm();
    let mut a = sw("a");
    let mut b = sw("b");
    let fa = d.sw_fd(&mut a, 1);
    let fb = d.sw_fd(&mut b, 1);
    let merged = d.merge(fa, fb).unwrap();
    let (info, fences) = d.info(merged);
    assert_eq!(info.num_fences, 2);
    assert_eq!(info.status, 0);
    assert_eq!(name_of(&info.name), "merge");
    assert_eq!(name_of(&fences[0].driver_name), "sw_sync");
    assert_eq!(name_of(&fences[0].obj_name), "a");
    // A merged file is close-on-exec.
    let entry = d.proc.fd_table.get(merged).unwrap();
    assert_ne!(entry.fd_flags & wasm_posix_shared::fd_flags::FD_CLOEXEC, 0);
}

#[test]
fn igt_sw_sync_timeline_closed_and_closed_signaled() {
    let mut d = drm();
    let mut t = sw("t");
    let pending = d.sw_fd(&mut t, 5);
    t.inc(0, d.now());
    let signaled = d.sw_fd(&mut t, 0);
    t.close(d.now());
    assert!(d.readable(pending), "closing a timeline signals its fences");
    assert_eq!(d.count_status(pending, -1), 1, "with an error");
    assert_eq!(d.count_status(signaled, 1), 1);
}

#[test]
fn igt_sw_sync_sync_busy() {
    let mut d = drm();
    let mut t = sw("t");
    let fd = d.sw_fd(&mut t, 5);
    assert!(!d.readable(fd));
    t.inc(4, d.now());
    assert!(!d.readable(fd));
    t.inc(1, d.now());
    assert!(d.readable(fd));
    let (_, fences) = d.info(fd);
    assert_eq!(fences[0].timestamp_ns, d.now() as u64);
}

#[test]
fn igt_sw_sync_sync_busy_fork() {
    let mut d = drm();
    let mut t = sw("t");
    let fd = d.sw_fd(&mut t, 1);
    let mut child = fork_child_of(&d.proc, 2);
    child.ofd_table.link_shared_states_from(&d.proc.ofd_table, |_| panic!("no GEM")).unwrap();
    t.inc(1, d.now());
    let mut fds = [WasmPollFd { fd, events: POLLIN, revents: 0 }];
    sys_poll(&mut child, &mut d.host, &mut fds, 0).unwrap();
    assert_eq!(fds[0].revents & POLLIN, POLLIN, "the child's inherited fd sees the signal");
}

#[test]
fn igt_sw_sync_sync_busy_fork_unixsocket() {
    let mut d = drm();
    let mut t = sw("t");
    let fd = d.sw_fd(&mut t, 1);
    let queued = retain_fd_for_scm_rights(&d.proc, fd);
    sys_close(&mut d.proc, &mut d.host, fd).unwrap();
    let mut receiver = Process::new(3);
    let received = install_scm_rights_fds(&mut receiver, alloc::vec![queued]);
    assert_eq!(received.len(), 1);
    t.inc(1, d.now());
    let mut fds = [WasmPollFd { fd: received[0], events: POLLIN, revents: 0 }];
    sys_poll(&mut receiver, &mut d.host, &mut fds, 0).unwrap();
    assert_eq!(fds[0].revents & POLLIN, POLLIN);
}

#[test]
fn igt_sw_sync_sync_merge_invalid() {
    let mut d = drm();
    let mut t = sw("t");
    let fd = d.sw_fd(&mut t, 1);
    assert_eq!(d.merge(fd, -1), Err(Errno::ENOENT));
    assert_eq!(d.merge(fd, d.fd), Err(Errno::ENOENT));
    let mut data = SyncMergeData { fd2: fd, flags: 1, ..Default::default() };
    assert_eq!(d.io(fd, SYNC_IOC_MERGE, data).map(drop), Err(Errno::EINVAL));
    data.flags = 0;
    data.pad = 1;
    assert_eq!(d.io(fd, SYNC_IOC_MERGE, data).map(drop), Err(Errno::EINVAL));
}

#[test]
fn igt_sw_sync_sync_merge() {
    let mut d = drm();
    let mut t = sw("t");
    let f0 = d.sw_fd(&mut t, 1);
    let f1 = d.sw_fd(&mut t, 2);
    let f2 = d.sw_fd(&mut t, 3);
    let m = d.merge(f0, f1).unwrap();
    let m = d.merge(f2, m).unwrap();
    for fd in [f0, f1, f2, m] {
        assert_eq!(d.count_status(fd, 0), 1, "one active point each");
    }
    t.inc(1, d.now());
    assert_eq!(d.count_status(f0, 1), 1);
    assert_eq!(d.count_status(m, 0), 1, "merge signaled too early");
    t.inc(1, d.now());
    assert_eq!(d.count_status(m, 0), 1);
    t.inc(1, d.now());
    assert_eq!(d.count_status(m, 1), 1);
    assert!(d.readable(m));
}

#[test]
fn igt_sw_sync_sync_merge_same() {
    let mut d = drm();
    let mut t = sw("t");
    let f = d.sw_fd(&mut t, 1);
    let m = d.merge(f, f).unwrap();
    assert_eq!(d.count_status(m, 0), 1);
    t.inc(1, d.now());
    assert_eq!(d.count_status(f, 1), 1);
    assert!(d.readable(m));
}

#[test]
fn igt_sw_sync_sync_multi_timeline_wait() {
    let mut d = drm();
    let mut ts = [sw("a"), sw("b"), sw("c")];
    let fa = d.sw_fd(&mut ts[0], 5);
    let fb = d.sw_fd(&mut ts[1], 5);
    let fc = d.sw_fd(&mut ts[2], 5);
    let m = d.merge(fa, fb).unwrap();
    let m = d.merge(fc, m).unwrap();
    assert_eq!(d.count_status(m, 0), 3);
    let now = d.now();
    ts[0].inc(5, now);
    assert_eq!((d.count_status(m, 1), d.count_status(m, 0)), (1, 2));
    ts[1].inc(5, now);
    ts[2].inc(5, now);
    assert_eq!(d.count_status(m, 1), 3);
    assert!(d.readable(m));
}

#[test]
fn igt_sw_sync_sync_expired_merge() {
    let mut d = drm();
    let mut t = sw("t");
    t.inc(100, d.now());
    let expired = d.sw_fd(&mut t, 1);
    assert!(d.readable(expired));
    let m = d.merge(expired, expired).unwrap();
    assert!(d.readable(m));
    let (info, fences) = d.info(m);
    assert_eq!(info.status, 1);
    assert_ne!(fences[0].timestamp_ns, 0);
}

#[test]
fn sync_file_info_and_deadline_follow_sync_file_c() {
    let mut d = drm();
    let mut t = sw("t");
    let fd = d.sw_fd(&mut t, 1);
    // flags/pad must be zero; a short array is EINVAL.
    assert_eq!(d.io(fd, SYNC_IOC_FILE_INFO, SyncFileInfo { flags: 1, ..Default::default() })
        .map(drop), Err(Errno::EINVAL));
    let a = d.sw_fd(&mut sw("x"), 1);
    let m = d.merge(fd, a).unwrap();
    assert_eq!(d.io(m, SYNC_IOC_FILE_INFO, SyncFileInfo { num_fences: 1,
        sync_fence_info: INFO_AT, ..Default::default() }).map(drop), Err(Errno::EINVAL));
    // An unnamed file is named after its fence.
    let (info, _) = d.info(fd);
    assert!(name_of(&info.name).starts_with("sw_sync-t"), "{}", name_of(&info.name));
    // SET_DEADLINE is a hint, recorded and harmless; its pad must be zero.
    assert_eq!(d.io(fd, SYNC_IOC_SET_DEADLINE, SyncSetDeadline { deadline_ns: 5, pad: 1 })
        .map(drop), Err(Errno::EINVAL));
    d.io(fd, SYNC_IOC_SET_DEADLINE, SyncSetDeadline { deadline_ns: 5, pad: 0 }).unwrap();
    let file = sync_file::from_fd(&d.proc, fd).unwrap();
    assert_eq!(file.fence().deadline_ns(), Some(5));
    // Unknown request: ENOTTY.
    assert_eq!(d.io(fd, wasm_posix_shared::dri::DRM_IOCTL_GET_CAP,
        wasm_posix_shared::dri::WpkDrmGetCap::default()).map(drop), Err(Errno::ENOTTY));
}

#[test]
fn sync_file_is_an_anonymous_read_only_file() {
    let mut d = drm();
    let mut t = sw("t");
    let fd = d.sw_fd(&mut t, 1);
    let st = sys_fstat(&d.proc, &mut d.host, fd).unwrap();
    assert_eq!(st.st_mode, 0o600, "anonymous inode: no file type bits");
    let mut buf = [0u8; 8];
    assert_eq!(sys_read(&mut d.proc, &mut d.host, fd, &mut buf), Err(Errno::EINVAL));
    assert_eq!(sys_write(&mut d.proc, &mut d.host, fd, &buf), Err(Errno::EBADF));
    assert_eq!(sys_lseek(&mut d.proc, &mut d.host, fd, 0, 0), Err(Errno::ESPIPE));
    let dup = sys_dup(&mut d.proc, fd).unwrap();
    t.inc(1, d.now());
    assert!(d.readable(dup));
}

#[test]
fn syncobj_export_and_import_sync_files() {
    let mut d = drm();
    let mut t = sw("t");
    let h = d.create(0);
    // Exporting nothing is EINVAL; an unknown handle ENOENT.
    assert_eq!(d.export(h, 0), Err(Errno::EINVAL));
    assert_eq!(d.export(77, 0), Err(Errno::ENOENT));
    let fd = d.sw_fd(&mut t, 1);
    d.import(h, fd, 4).unwrap();
    let out = d.export(h, 4).unwrap();
    assert!(!d.readable(out));
    // Importing a non-sync_file is EINVAL.
    assert_eq!(d.import(h, d.fd, 0), Err(Errno::EINVAL));
    t.inc(1, d.now());
    assert!(d.readable(out));
    // A point already signaled exports a signaled stub.
    let stub = d.export(h, 4).unwrap();
    assert!(d.readable(stub));
}

#[test]
fn syncobj_handles_are_shared_by_fork_and_scm_rights() {
    let mut d = drm();
    let h = d.create(0);
    let mut child = fork_child_of(&d.proc, 2);
    child.ofd_table.link_shared_states_from(&d.proc.ofd_table, |_| panic!("no GEM")).unwrap();
    // The child's description is the parent's: one namespace.
    d.signal(&[h]).unwrap();
    let mut wait = bytes_of(&DrmSyncobjWait { handles: d.put_handles(&[h]), count_handles: 1,
        ..Default::default() });
    sys_ioctl(&mut child, &mut d.host, d.fd, DRM_IOCTL_SYNCOBJ_WAIT, &mut wait).unwrap();
    // A syncobj fd crosses SCM_RIGHTS and imports in another file.
    let shared = d.io(d.fd, DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD,
        DrmSyncobjHandle { handle: h, ..Default::default() }).unwrap().fd;
    let queued = retain_fd_for_scm_rights(&d.proc, shared);
    let mut other = Process::new(4);
    let received = install_scm_rights_fds(&mut other, alloc::vec![queued]);
    let other_drm = sys_open(&mut other, &mut d.host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let mut req = bytes_of(&DrmSyncobjHandle { fd: received[0], ..Default::default() });
    sys_ioctl(&mut other, &mut d.host, other_drm, DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE, &mut req)
        .unwrap();
    let imported: DrmSyncobjHandle = from_bytes(&req);
    assert_eq!(imported.handle, 1);
}

// ── dma-buf implicit fences ────────────────────────────────────────────────

fn prime_fd(d: &mut Drm) -> i32 {
    use wasm_posix_shared::dri::*;
    let created = d.io(d.fd, DRM_IOCTL_MODE_CREATE_DUMB, WpkDrmModeCreateDumb { width: 4,
        height: 4, bpp: 32, ..Default::default() }).unwrap();
    d.io(d.fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, WpkDrmPrimeHandle { handle: created.handle,
        flags: wasm_posix_shared::flags::O_RDWR, fd: -1 }).unwrap().fd
}

#[test]
fn dma_buf_sync_file_export_and_import_follow_the_reservation() {
    let _g = crate::dri::bo::TEST_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut d = drm();
    let mut t = sw("t");
    let buf = prime_fd(&mut d);
    let export = |d: &mut Drm, flags| d.io(buf, DMA_BUF_IOCTL_EXPORT_SYNC_FILE,
        DmaBufSyncFile { flags, fd: -1 }).map(|a| a.fd);
    // No fences: a signaled stub.
    let idle = export(&mut d, DMA_BUF_SYNC_READ).unwrap();
    assert!(d.readable(idle));
    // Bad flags.
    assert_eq!(export(&mut d, 0), Err(Errno::EINVAL));
    assert_eq!(export(&mut d, 4), Err(Errno::EINVAL));
    assert_eq!(d.io(buf, DMA_BUF_IOCTL_IMPORT_SYNC_FILE, DmaBufSyncFile {
        flags: DMA_BUF_SYNC_WRITE, fd: d.fd }).map(drop), Err(Errno::EINVAL));
    // A reader fence: writes wait for it, reads do not.
    let reader = d.sw_fd(&mut t, 1);
    d.io(buf, DMA_BUF_IOCTL_IMPORT_SYNC_FILE, DmaBufSyncFile { flags: DMA_BUF_SYNC_READ,
        fd: reader }).unwrap();
    let for_read = export(&mut d, DMA_BUF_SYNC_READ).unwrap();
    let for_write = export(&mut d, DMA_BUF_SYNC_WRITE).unwrap();
    assert!(d.readable(for_read));
    assert!(!d.readable(for_write));
    // dma-buf poll: readable (no writers), not writable (a reader).
    let mut fds = [WasmPollFd { fd: buf, events: POLLIN | POLLOUT, revents: 0 }];
    sys_poll(&mut d.proc, &mut d.host, &mut fds, 0).unwrap();
    assert_eq!(fds[0].revents, POLLIN);
    // A writer fence: reads now wait too.
    let mut w = sw("w");
    let writer = d.sw_fd(&mut w, 1);
    d.io(buf, DMA_BUF_IOCTL_IMPORT_SYNC_FILE, DmaBufSyncFile { flags: DMA_BUF_SYNC_WRITE,
        fd: writer }).unwrap();
    let blocked = export(&mut d, DMA_BUF_SYNC_READ).unwrap();
    assert!(!d.readable(blocked));
    w.inc(1, d.now());
    t.inc(1, d.now());
    assert!(d.readable(blocked) && d.readable(for_write));
    fds[0].revents = 0;
    sys_poll(&mut d.proc, &mut d.host, &mut fds, 0).unwrap();
    assert_eq!(fds[0].revents, POLLIN | POLLOUT);
}

// ── host GL fences ─────────────────────────────────────────────────────────

#[test]
fn a_waiter_on_a_host_fence_starts_host_polling() {
    let mut d = drm();
    let export_id = crate::dri::fence::allocate_export_id().unwrap();
    let fence = Fence::pending(crate::dri::fence::context_alloc(), 1, "kandelo-drm",
        Timeline::Static("gles"), Source::HostGl { export_id });
    let fd = sync_file::install_fd(&mut d.proc, SyncFile::new(fence), true).unwrap();
    assert!(!crate::dri::fence::host_work_pending(), "no waiter: no host work");
    // A syncobj holding it, with no waiter, still costs the host nothing.
    let h = d.create(0);
    d.import(h, fd, 0).unwrap();
    assert!(!crate::dri::fence::host_work_pending());
    // A poller is a waiter.
    assert!(!d.readable(fd));
    assert_eq!(crate::dri::fence::host_requests(),
        alloc::vec![(export_id, crate::dri::fence::HOST_REQUEST_POLL)]);
    crate::dri::fence::host_signaled(export_id, 0, d.now()).unwrap();
    assert!(d.readable(fd));
    assert_eq!(d.wait(&[h], 0, 0), Ok(0));
}

// ── implicit sync of GL work ───────────────────────────────────────────────

/// A GL submission from a process that names a buffer with a pending
/// implicit writer waits, before the host runs anything, until the writer
/// signals; fence queries never wait; a caught signal stays pending while
/// it waits (the call cannot fail with EINTR).
#[test]
fn gl_work_waits_for_the_implicit_fences_of_buffers_the_process_names() {
    use wasm_posix_shared::dri::*;
    use wasm_posix_shared::gl;
    let _g = crate::dri::bo::TEST_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (proc, host, fd) = glio_query_preflight_fixture();
    let mut d = Drm { proc, host, fd };
    d.host.monotonic_time = Some((100, 0));
    let created = d.io(fd, DRM_IOCTL_MODE_CREATE_DUMB, WpkDrmModeCreateDumb { width: 4, height: 4,
        bpp: 32, ..Default::default() }).unwrap();
    let prime = d.io(fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, WpkDrmPrimeHandle { handle: created.handle,
        flags: wasm_posix_shared::flags::O_RDWR, fd: -1 }).unwrap().fd;
    let submit = |d: &mut Drm| {
        let mut bytes = [0u8; 8];
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());
        sys_ioctl(&mut d.proc, &mut d.host, d.fd, gl::GLIO_SUBMIT, &mut bytes)
    };
    // No fence anywhere: the submission runs.
    submit(&mut d).unwrap();
    let ran = d.host.gl_submit_sessions.len();
    // A producer's render-complete fence imported as the buffer's writer.
    let mut producer = sw("producer");
    let writer = d.sw_fd(&mut producer, 1);
    d.io(prime, DMA_BUF_IOCTL_IMPORT_SYNC_FILE, DmaBufSyncFile { flags: DMA_BUF_SYNC_WRITE,
        fd: writer }).unwrap();
    assert_eq!(submit(&mut d), Err(Errno::EAGAIN));
    assert_eq!(d.host.gl_submit_sessions.len(), ran, "nothing reached the host");
    let (pid, tid) = (d.proc.pid, d.proc.pid);
    assert!(crate::dri::implicit_sync::waits_uninterruptibly(pid, tid));
    // A query that reads back waits too; a fence query does not.
    let mut finish = [0u8; 24];
    finish[..4].copy_from_slice(&gl::QOP_FINISH.to_le_bytes());
    assert_eq!(sys_ioctl(&mut d.proc, &mut d.host, fd, gl::GLIO_QUERY, &mut finish), Err(Errno::EAGAIN));
    glio_fence_query_test(&mut d.proc, &mut d.host, fd, gl::QOP_FENCE_STATUS).unwrap();
    // Loss diagnosis must not wait on a writer that may itself have failed.
    // The scope receipt reads no buffer and must still reach the host.
    let mut scope = [0u8; 24];
    scope[..4].copy_from_slice(&gl::QOP_CONTEXT_RESET_SCOPE.to_le_bytes());
    scope[12..16].copy_from_slice(&32u32.to_le_bytes());
    scope[16..20].copy_from_slice(&12u32.to_le_bytes());
    sys_ioctl(&mut d.proc, &mut d.host, fd, gl::GLIO_QUERY, &mut scope).unwrap();
    assert_eq!(d.host.gl_query_inputs.last(), Some(&(gl::QOP_CONTEXT_RESET_SCOPE, alloc::vec![], 12)));
    producer.inc(1, d.now());
    submit(&mut d).unwrap();
    assert_eq!(d.host.gl_submit_sessions.len(), ran + 1);
    assert!(!crate::dri::implicit_sync::waits_uninterruptibly(pid, tid));
    // A reader's fence makes a submission wait too: it may write the buffer.
    let mut display = sw("display");
    let reader = d.sw_fd(&mut display, 1);
    d.io(prime, DMA_BUF_IOCTL_IMPORT_SYNC_FILE, DmaBufSyncFile { flags: DMA_BUF_SYNC_READ,
        fd: reader }).unwrap();
    assert_eq!(submit(&mut d), Err(Errno::EAGAIN));
    // The process goes away while parked: its record goes with it.
    crate::wait_park::retire_process(pid);
    assert!(!crate::dri::implicit_sync::waits_uninterruptibly(pid, tid));
    display.inc(1, d.now());
    submit(&mut d).unwrap();
}
