//! Explicit-synchronization uAPI: DRM sync objects, `sync_file` and the
//! dma-buf implicit-fence ioctls.
//!
//! Every number and layout here is Linux's uAPI (`include/uapi/drm/drm.h`,
//! `include/uapi/linux/sync_file.h`, `include/uapi/linux/dma-buf.h`), not a
//! Kandelo ABI number: programs compiled against Linux headers (libdrm,
//! wlroots, Mesa-style EGL users) issue them unchanged. Every pointer-carrying
//! field is a `__u64`, so one layout serves wasm32 and wasm64.
//!
//! The one Kandelo-private request, [`DRM_IOCTL_WPK_EXPORT_FENCE`], is how
//! `eglDupNativeFenceFDANDROID` turns a GL fence of an EGL object session into
//! a `sync_file` descriptor.

// --- DRM sync objects ('d', 0xbf..0xcf) ------------------------------------

/// `_IOWR('d', 0xbf, struct drm_syncobj_create)`.
pub const DRM_IOCTL_SYNCOBJ_CREATE: u32 = 0xc008_64bf;
/// `_IOWR('d', 0xc0, struct drm_syncobj_destroy)`.
pub const DRM_IOCTL_SYNCOBJ_DESTROY: u32 = 0xc008_64c0;
/// `_IOWR('d', 0xc1, struct drm_syncobj_handle)` with the 24-byte layout
/// (its `point` member serves timeline sync_file import/export).
pub const DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD: u32 = 0xc018_64c1;
/// `_IOWR('d', 0xc2, struct drm_syncobj_handle)`, 24 bytes.
pub const DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE: u32 = 0xc018_64c2;
/// The same two requests as encoded by older headers, which predate
/// `point` (16-byte struct). `drm_ioctl` dispatches on the request's `nr`, zero-fills the
/// missing tail and copies back only the caller's size, so Linux accepts
/// both encodings; so does Kandelo.
pub const DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD_V1: u32 = 0xc010_64c1;
pub const DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE_V1: u32 = 0xc010_64c2;
/// `_IOWR('d', 0xc3, struct drm_syncobj_wait)`, 40 bytes (with
/// `deadline_nsec`); the 32-byte pre-deadline encoding is `_V1`.
pub const DRM_IOCTL_SYNCOBJ_WAIT: u32 = 0xc028_64c3;
pub const DRM_IOCTL_SYNCOBJ_WAIT_V1: u32 = 0xc020_64c3;
/// `_IOWR('d', 0xc4, struct drm_syncobj_array)`.
pub const DRM_IOCTL_SYNCOBJ_RESET: u32 = 0xc010_64c4;
/// `_IOWR('d', 0xc5, struct drm_syncobj_array)`.
pub const DRM_IOCTL_SYNCOBJ_SIGNAL: u32 = 0xc010_64c5;
/// `_IOWR('d', 0xca, struct drm_syncobj_timeline_wait)`, 48 bytes; the
/// 40-byte pre-deadline encoding is `_V1`.
pub const DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT: u32 = 0xc030_64ca;
pub const DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT_V1: u32 = 0xc028_64ca;
/// `_IOWR('d', 0xcb, struct drm_syncobj_timeline_array)`.
pub const DRM_IOCTL_SYNCOBJ_QUERY: u32 = 0xc018_64cb;
/// `_IOWR('d', 0xcc, struct drm_syncobj_transfer)`.
pub const DRM_IOCTL_SYNCOBJ_TRANSFER: u32 = 0xc020_64cc;
/// `_IOWR('d', 0xcd, struct drm_syncobj_timeline_array)`.
pub const DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL: u32 = 0xc018_64cd;
/// `_IOWR('d', 0xcf, struct drm_syncobj_eventfd)`.
pub const DRM_IOCTL_SYNCOBJ_EVENTFD: u32 = 0xc018_64cf;

pub const DRM_SYNCOBJ_CREATE_SIGNALED: u32 = 1 << 0;
pub const DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_IMPORT_SYNC_FILE: u32 = 1 << 0;
pub const DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_TIMELINE: u32 = 1 << 1;
pub const DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_EXPORT_SYNC_FILE: u32 = 1 << 0;
pub const DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_TIMELINE: u32 = 1 << 1;
pub const DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL: u32 = 1 << 0;
pub const DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT: u32 = 1 << 1;
pub const DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE: u32 = 1 << 2;
pub const DRM_SYNCOBJ_WAIT_FLAGS_WAIT_DEADLINE: u32 = 1 << 3;
pub const DRM_SYNCOBJ_QUERY_FLAGS_LAST_SUBMITTED: u32 = 1 << 0;

/// `struct drm_syncobj_create` (8 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjCreate {
    pub handle: u32,
    pub flags: u32,
}

/// `struct drm_syncobj_destroy` (8 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjDestroy {
    pub handle: u32,
    pub pad: u32,
}

/// `struct drm_syncobj_handle` (24 bytes; 16 without `point`).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjHandle {
    pub handle: u32,
    pub flags: u32,
    pub fd: i32,
    pub pad: u32,
    pub point: u64,
}

/// `struct drm_syncobj_transfer` (32 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjTransfer {
    pub src_handle: u32,
    pub dst_handle: u32,
    pub src_point: u64,
    pub dst_point: u64,
    pub flags: u32,
    pub pad: u32,
}

/// `struct drm_syncobj_wait` (40 bytes; 32 without `deadline_nsec`).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjWait {
    pub handles: u64,
    pub timeout_nsec: i64,
    pub count_handles: u32,
    pub flags: u32,
    pub first_signaled: u32,
    pub pad: u32,
    pub deadline_nsec: u64,
}

/// `struct drm_syncobj_timeline_wait` (48 bytes; 40 without
/// `deadline_nsec`).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjTimelineWait {
    pub handles: u64,
    pub points: u64,
    pub timeout_nsec: i64,
    pub count_handles: u32,
    pub flags: u32,
    pub first_signaled: u32,
    pub pad: u32,
    pub deadline_nsec: u64,
}

/// `struct drm_syncobj_eventfd` (24 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjEventfd {
    pub handle: u32,
    pub flags: u32,
    pub point: u64,
    pub fd: i32,
    pub pad: u32,
}

/// `struct drm_syncobj_array` (16 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjArray {
    pub handles: u64,
    pub count_handles: u32,
    pub pad: u32,
}

/// `struct drm_syncobj_timeline_array` (24 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DrmSyncobjTimelineArray {
    pub handles: u64,
    pub points: u64,
    pub count_handles: u32,
    pub flags: u32,
}

// --- sync_file ('>') -----------------------------------------------------

/// `_IOWR('>', 3, struct sync_merge_data)`.
pub const SYNC_IOC_MERGE: u32 = 0xc030_3e03;
/// `_IOWR('>', 4, struct sync_file_info)`.
pub const SYNC_IOC_FILE_INFO: u32 = 0xc038_3e04;
/// `_IOW('>', 5, struct sync_set_deadline)`.
pub const SYNC_IOC_SET_DEADLINE: u32 = 0x4010_3e05;

/// `struct sync_merge_data` (48 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct SyncMergeData {
    pub name: [u8; 32],
    pub fd2: i32,
    pub fence: i32,
    pub flags: u32,
    pub pad: u32,
}

/// `struct sync_fence_info` (80 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct SyncFenceInfo {
    pub obj_name: [u8; 32],
    pub driver_name: [u8; 32],
    pub status: i32,
    pub flags: u32,
    pub timestamp_ns: u64,
}

impl Default for SyncFenceInfo {
    fn default() -> Self {
        Self { obj_name: [0; 32], driver_name: [0; 32], status: 0, flags: 0, timestamp_ns: 0 }
    }
}

/// `struct sync_file_info` (56 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct SyncFileInfo {
    pub name: [u8; 32],
    pub status: i32,
    pub flags: u32,
    pub num_fences: u32,
    pub pad: u32,
    pub sync_fence_info: u64,
}

/// `struct sync_set_deadline` (16 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct SyncSetDeadline {
    pub deadline_ns: u64,
    pub pad: u64,
}

// --- dma-buf implicit fences ('b') ----------------------------------------

/// `_IOWR('b', 2, struct dma_buf_export_sync_file)`.
pub const DMA_BUF_IOCTL_EXPORT_SYNC_FILE: u32 = 0xc008_6202;
/// `_IOW('b', 3, struct dma_buf_import_sync_file)`.
pub const DMA_BUF_IOCTL_IMPORT_SYNC_FILE: u32 = 0x4008_6203;
pub const DMA_BUF_SYNC_READ: u32 = 1 << 0;
pub const DMA_BUF_SYNC_WRITE: u32 = 2 << 0;
pub const DMA_BUF_SYNC_RW: u32 = DMA_BUF_SYNC_READ | DMA_BUF_SYNC_WRITE;

/// `struct dma_buf_export_sync_file` / `struct dma_buf_import_sync_file`
/// (8 bytes; identical layouts).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct DmaBufSyncFile {
    pub flags: u32,
    pub fd: i32,
}

// --- Kandelo: GL fence export ----------------------------------------------

/// `_IOWR('d', 0xe6, WpkDrmExportFence)` on an EGL object session's render
/// fd: publish the session's GL fence `token` as a new `sync_file` fd.
///
/// A fence on the virtual GPU's shared native context is complete in
/// submission order (every later Kandelo consumer is ordered behind it), so
/// its `sync_file` is signaled when it is created. A fence on a separate
/// native context stays pending until the host observes its native status,
/// which it polls only while a kernel waiter exists.
pub const DRM_IOCTL_WPK_EXPORT_FENCE: u32 = 0xc010_64e6;

/// `DRM_IOCTL_WPK_EXPORT_FENCE` argument (16 bytes). `flags` accepts only
/// `O_CLOEXEC`; `fd` is the returned descriptor.
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct WpkDrmExportFence {
    pub token: u32,
    pub flags: u32,
    pub fd: i32,
    pub pad: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    const fn ioc(dir: u32, magic: u8, nr: u32, size: usize) -> u32 {
        (dir << 30) | ((size as u32) << 16) | ((magic as u32) << 8) | nr
    }
    const W: u32 = 1;
    const RW: u32 = 3;

    #[test]
    fn struct_sizes_match_linux_uapi() {
        assert_eq!(size_of::<DrmSyncobjCreate>(), 8);
        assert_eq!(size_of::<DrmSyncobjDestroy>(), 8);
        assert_eq!(size_of::<DrmSyncobjHandle>(), 24);
        assert_eq!(size_of::<DrmSyncobjTransfer>(), 32);
        assert_eq!(size_of::<DrmSyncobjWait>(), 40);
        assert_eq!(size_of::<DrmSyncobjTimelineWait>(), 48);
        assert_eq!(size_of::<DrmSyncobjEventfd>(), 24);
        assert_eq!(size_of::<DrmSyncobjArray>(), 16);
        assert_eq!(size_of::<DrmSyncobjTimelineArray>(), 24);
        assert_eq!(size_of::<SyncMergeData>(), 48);
        assert_eq!(size_of::<SyncFenceInfo>(), 80);
        assert_eq!(size_of::<SyncFileInfo>(), 56);
        assert_eq!(size_of::<SyncSetDeadline>(), 16);
        assert_eq!(size_of::<DmaBufSyncFile>(), 8);
        assert_eq!(size_of::<WpkDrmExportFence>(), 16);
    }

    #[test]
    fn ioctl_numbers_match_linux_uapi() {
        let d = b'd';
        assert_eq!(DRM_IOCTL_SYNCOBJ_CREATE, ioc(RW, d, 0xbf, 8));
        assert_eq!(DRM_IOCTL_SYNCOBJ_DESTROY, ioc(RW, d, 0xc0, 8));
        assert_eq!(DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD, ioc(RW, d, 0xc1, 24));
        assert_eq!(DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE, ioc(RW, d, 0xc2, 24));
        assert_eq!(DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD_V1, ioc(RW, d, 0xc1, 16));
        assert_eq!(DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE_V1, ioc(RW, d, 0xc2, 16));
        assert_eq!(DRM_IOCTL_SYNCOBJ_WAIT, ioc(RW, d, 0xc3, 40));
        assert_eq!(DRM_IOCTL_SYNCOBJ_WAIT_V1, ioc(RW, d, 0xc3, 32));
        assert_eq!(DRM_IOCTL_SYNCOBJ_RESET, ioc(RW, d, 0xc4, 16));
        assert_eq!(DRM_IOCTL_SYNCOBJ_SIGNAL, ioc(RW, d, 0xc5, 16));
        assert_eq!(DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT, ioc(RW, d, 0xca, 48));
        assert_eq!(DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT_V1, ioc(RW, d, 0xca, 40));
        assert_eq!(DRM_IOCTL_SYNCOBJ_QUERY, ioc(RW, d, 0xcb, 24));
        assert_eq!(DRM_IOCTL_SYNCOBJ_TRANSFER, ioc(RW, d, 0xcc, 32));
        assert_eq!(DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL, ioc(RW, d, 0xcd, 24));
        assert_eq!(DRM_IOCTL_SYNCOBJ_EVENTFD, ioc(RW, d, 0xcf, 24));
        assert_eq!(SYNC_IOC_MERGE, ioc(RW, b'>', 3, 48));
        assert_eq!(SYNC_IOC_FILE_INFO, ioc(RW, b'>', 4, 56));
        assert_eq!(SYNC_IOC_SET_DEADLINE, ioc(W, b'>', 5, 16));
        assert_eq!(DMA_BUF_IOCTL_EXPORT_SYNC_FILE, ioc(RW, b'b', 2, 8));
        assert_eq!(DMA_BUF_IOCTL_IMPORT_SYNC_FILE, ioc(W, b'b', 3, 8));
        assert_eq!(DRM_IOCTL_WPK_EXPORT_FENCE, ioc(RW, d, 0xe6, 16));
    }
}
