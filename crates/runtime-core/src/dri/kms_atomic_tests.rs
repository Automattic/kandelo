// Atomic KMS tests that mirror IGT's `kms_atomic` and `kms_properties`
// subtests (igt-gpu-tools `tests/kms_atomic.c`, `tests/kms_properties.c`)
// by name, driving the card through its uAPI only, as IGT does: property
// ids are looked up by name, the request arrays live in the caller's
// memory, and vblanks come from the host pump (`kms_host_vblank`).
//
// Included (`include!`) into the `syscalls` test module for its mock host
// and KMS helpers.

use super::*;
use crate::dri::kms;
use wasm_posix_shared::dri::*;

// include/uapi/drm/drm_mode.h and drm.h, spelled out as IGT spells them.
const IOCTL_MODE_ATOMIC: u32 = 0xc038_64bc;
const ATOMIC_TEST_ONLY: u32 = 0x0100;
const ATOMIC_NONBLOCK: u32 = 0x0200;
const ATOMIC_ALLOW_MODESET: u32 = 0x0400;
const PAGE_FLIP_EVENT: u32 = 0x01;
const CLIENT_CAP_ATOMIC: u64 = 3;
const CLIENT_CAP_WRITEBACK_CONNECTORS: u64 = 5;
const PROP_ATOMIC: u32 = 0x8000_0000;
const PROP_OBJECT: u32 = 1 << 6;
const PROP_SIGNED_RANGE: u32 = 2 << 6;

/// `struct drm_mode_atomic`.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct DrmModeAtomic {
    flags: u32,
    count_objs: u32,
    objs_ptr: u64,
    count_props_ptr: u64,
    props_ptr: u64,
    prop_values_ptr: u64,
    reserved: u64,
    user_data: u64,
}

// Request arrays in the mock process's memory (64 KiB).
const OBJS: u64 = 0x8000; // u32[64]
const COUNTS: u64 = 0x8100; // u32[64]
const PROPS: u64 = 0x8200; // u32[256]
const VALUES: u64 = 0x8a00; // u64[256]
const QUERY_IDS: u64 = 0xa000;
const QUERY_VALUES: u64 = 0xa400;
const BLOB_DATA: u64 = 0xc000;
const OUT_FENCE: u64 = 0xd000;

struct Igt {
    proc: Process,
    host: MockHostIO,
    fd: i32,
}

impl Igt {
    /// A DRM master with the atomic client cap, as `igt_display_require`
    /// sets it up.
    fn open() -> Self {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.cursor_supported = true;
        let fd = kms_master_card0(&mut proc, &mut host);
        let mut igt = Self { proc, host, fd };
        assert_eq!(igt.set_cap(CLIENT_CAP_ATOMIC, 1), Ok(()), "DRM_CLIENT_CAP_ATOMIC");
        igt
    }

    fn set_cap(&mut self, capability: u64, value: u64) -> Result<(), Errno> {
        kms_ioctl(&mut self.proc, &mut self.host, self.fd, DRM_IOCTL_SET_CLIENT_CAP,
            WpkDrmSetClientCap { capability, value }).map(|_| ())
    }

    fn properties(&mut self, obj: u32, obj_type: u32) -> Vec<(u32, u64)> {
        let reply = kms_ioctl(&mut self.proc, &mut self.host, self.fd, DRM_IOCTL_MODE_OBJ_GETPROPERTIES,
            WpkDrmModeObjGetProperties { props_ptr: QUERY_IDS, prop_values_ptr: QUERY_VALUES,
                count_props: 64, obj_id: obj, obj_type, pad: 0 }).unwrap();
        (0..reply.count_props as usize).map(|i| {
            let id = le_u32(&self.host.proc_memory, QUERY_IDS as usize + i * 4);
            let at = QUERY_VALUES as usize + i * 8;
            (id, u64::from_le_bytes(self.host.proc_memory[at..at + 8].try_into().unwrap()))
        }).collect()
    }

    fn property(&mut self, prop: u32) -> WpkDrmModeGetProperty {
        kms_ioctl(&mut self.proc, &mut self.host, self.fd, DRM_IOCTL_MODE_GETPROPERTY,
            WpkDrmModeGetProperty { prop_id: prop, ..Default::default() }).unwrap()
    }

    fn name_of(&mut self, prop: u32) -> alloc::string::String {
        let name = self.property(prop).name;
        let len = name.iter().position(|&b| b == 0).unwrap_or(name.len());
        alloc::string::String::from_utf8(name[..len].to_vec()).unwrap()
    }

    /// `igt_atomic_fill_*_props`: the id of a property by name.
    fn prop(&mut self, obj: u32, obj_type: u32, name: &str) -> u32 {
        let props = self.properties(obj, obj_type);
        props.iter().map(|&(id, _)| id).find(|&id| self.name_of(id) == name)
            .unwrap_or_else(|| panic!("object {obj} has no property {name}"))
    }

    fn value(&mut self, obj: u32, obj_type: u32, name: &str) -> u64 {
        let id = self.prop(obj, obj_type, name);
        self.properties(obj, obj_type).into_iter().find(|&(p, _)| p == id).unwrap().1
    }

    fn plane(&mut self, name: &str) -> u32 { self.prop(kms::PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE, name) }
    fn crtc(&mut self, name: &str) -> u32 { self.prop(kms::CRTC_ID, DRM_MODE_OBJECT_CRTC, name) }
    fn connector(&mut self, name: &str) -> u32 { self.prop(kms::CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR, name) }

    fn raw(&mut self, req: DrmModeAtomic) -> Result<(), Errno> {
        kms_ioctl(&mut self.proc, &mut self.host, self.fd, IOCTL_MODE_ATOMIC, req).map(|_| ())
    }

    /// Lay `objects` out as libdrm's `drmModeAtomicCommit` does and return
    /// the request.
    fn request(&mut self, flags: u32, objects: &[(u32, &[(u32, u64)])], user_data: u64) -> DrmModeAtomic {
        let memory = &mut self.host.proc_memory;
        let mut n = 0usize;
        for (i, (obj, props)) in objects.iter().enumerate() {
            memory[OBJS as usize + i * 4..][..4].copy_from_slice(&obj.to_le_bytes());
            memory[COUNTS as usize + i * 4..][..4].copy_from_slice(&(props.len() as u32).to_le_bytes());
            for &(prop, value) in props.iter() {
                memory[PROPS as usize + n * 4..][..4].copy_from_slice(&prop.to_le_bytes());
                memory[VALUES as usize + n * 8..][..8].copy_from_slice(&value.to_le_bytes());
                n += 1;
            }
        }
        DrmModeAtomic { flags, count_objs: objects.len() as u32, objs_ptr: OBJS,
            count_props_ptr: COUNTS, props_ptr: PROPS, prop_values_ptr: VALUES, reserved: 0, user_data }
    }

    fn commit(&mut self, flags: u32, objects: &[(u32, &[(u32, u64)])]) -> Result<(), Errno> {
        let req = self.request(flags, objects, 0);
        self.raw(req)
    }

    /// A blocking commit as the host runs it: the caller parks (EAGAIN)
    /// until the vblank that completes its flip, then the unchanged request
    /// is retried and returns.
    fn commit_blocking(&mut self, flags: u32, objects: &[(u32, &[(u32, u64)])]) -> Result<(), Errno> {
        let req = self.request(flags, objects, 0);
        self.raw_blocking(req)
    }

    fn raw_blocking(&mut self, req: DrmModeAtomic) -> Result<(), Errno> {
        match self.raw(req) {
            Err(Errno::EAGAIN) => {
                self.vblank();
                self.raw(req)
            }
            other => other,
        }
    }

    fn vblank(&mut self) -> u64 {
        kms_host_vblank(&mut self.proc, 100, 0)
    }

    fn blob(&mut self, bytes: &[u8]) -> u32 {
        self.host.proc_memory[BLOB_DATA as usize..][..bytes.len()].copy_from_slice(bytes);
        let req = [BLOB_DATA as u32, 0, bytes.len() as u32, 0];
        kms_ioctl(&mut self.proc, &mut self.host, self.fd, DRM_IOCTL_MODE_CREATEPROPBLOB, req).unwrap()[3]
    }

    fn mode_blob(&mut self) -> u32 {
        let mode = kms_test_mode();
        let bytes = unsafe { core::slice::from_raw_parts(&mode as *const _ as *const u8,
            core::mem::size_of::<WpkDrmModeModeinfo>()) }.to_vec();
        self.blob(&bytes)
    }

    fn fb(&mut self, width: u32, height: u32, format: u32) -> u32 {
        kms_fb(&mut self.proc, &mut self.host, self.fd, width, height, format)
    }

    /// `atomic_setup`: light the pipe with the connector's mode and a
    /// full-screen primary plane in one modeset.
    fn setup(&mut self) -> (u32, u32) {
        let fb = self.fb(640, 480, DRM_FORMAT_XRGB8888);
        let mode = self.mode_blob();
        let (fb_id, crtc_id, sx, sy, sw, sh, cx, cy, cw, ch) = (self.plane("FB_ID"),
            self.plane("CRTC_ID"), self.plane("SRC_X"), self.plane("SRC_Y"), self.plane("SRC_W"),
            self.plane("SRC_H"), self.plane("CRTC_X"), self.plane("CRTC_Y"), self.plane("CRTC_W"),
            self.plane("CRTC_H"));
        let (mode_id, active, conn_crtc) = (self.crtc("MODE_ID"), self.crtc("ACTIVE"), self.connector("CRTC_ID"));
        let crtc = u64::from(kms::CRTC_ID);
        self.commit_blocking(ATOMIC_ALLOW_MODESET, &[
            (kms::CRTC_ID, &[(mode_id, u64::from(mode)), (active, 1)]),
            (kms::CONNECTOR_ID, &[(conn_crtc, crtc)]),
            (kms::PRIMARY_PLANE_ID, &[(fb_id, u64::from(fb)), (crtc_id, crtc), (sx, 0), (sy, 0),
                (sw, 640 << 16), (sh, 480 << 16), (cx, 0), (cy, 0), (cw, 640), (ch, 480)]),
        ]).unwrap();
        (fb, mode)
    }

    fn getcrtc(&mut self) -> WpkDrmModeGetCrtc {
        kms_ioctl(&mut self.proc, &mut self.host, self.fd, DRM_IOCTL_MODE_GETCRTC,
            WpkDrmModeGetCrtc { crtc_id: kms::CRTC_ID, ..Default::default() }).unwrap()
    }

    fn getplane(&mut self, plane: u32) -> WpkDrmModeGetPlane {
        kms_ioctl(&mut self.proc, &mut self.host, self.fd, DRM_IOCTL_MODE_GETPLANE,
            WpkDrmModeGetPlane { plane_id: plane, ..Default::default() }).unwrap()
    }

    fn primary_state(&mut self) -> Vec<(u32, u64)> {
        self.properties(kms::PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE)
    }

    fn crtc_state(&mut self) -> Vec<(u32, u64)> {
        self.properties(kms::CRTC_ID, DRM_MODE_OBJECT_CRTC)
    }

    fn close(mut self) {
        sys_close(&mut self.proc, &mut self.host, self.fd).unwrap();
        kms::reset_for_test();
    }
}

fn locks() -> (std::sync::MutexGuard<'static, ()>, std::sync::MutexGuard<'static, ()>) {
    let master = crate::dri::master::lock_for_test();
    let registry = crate::dri::bo::TEST_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    crate::dri::bo::reset_registry();
    kms::reset_for_test();
    (master, registry)
}

/// igt@kms_atomic@atomic-invalid-params.
#[test]
fn kms_atomic_atomic_invalid_params() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (_, mode) = igt.setup();
    let crtc = kms::CRTC_ID;
    let mut ioc = DrmModeAtomic::default();
    // An empty request does nothing.
    assert_eq!(igt.raw(ioc), Ok(()));
    igt.host.proc_memory[OBJS as usize..VALUES as usize + 256 * 8].fill(0);
    ioc.objs_ptr = OBJS;
    ioc.count_props_ptr = COUNTS;
    ioc.props_ptr = PROPS;
    ioc.prop_values_ptr = VALUES;
    // Valid pointers, but still copy nothing.
    assert_eq!(igt.raw(ioc), Ok(()));
    // A no-op with an event: no CRTC could send it.
    assert_eq!(igt.raw(DrmModeAtomic { flags: PAGE_FLIP_EVENT, ..ioc }), Err(Errno::EINVAL));
    assert_eq!(igt.raw(DrmModeAtomic { flags: 0xdead_beef, ..ioc }), Err(Errno::EINVAL));
    assert_eq!(igt.raw(ioc), Ok(()));
    assert_eq!(igt.raw(DrmModeAtomic { reserved: 1, ..ioc }), Err(Errno::EINVAL));
    assert_eq!(igt.raw(ioc), Ok(()));
    // Zero is not a valid object id.
    ioc.count_objs = 16;
    assert_eq!(igt.raw(ioc), Err(Errno::ENOENT));
    // Objects that carry no properties.
    ioc.count_objs = 1;
    let fb = igt.getcrtc().fb_id;
    for not_settable in [mode, fb, kms::ENCODER_ID, igt.crtc("MODE_ID")] {
        igt.host.proc_memory[OBJS as usize..][..4].copy_from_slice(&not_settable.to_le_bytes());
        assert_eq!(igt.raw(ioc), Err(Errno::ENOENT), "object {not_settable}");
    }
    // Objects with no properties: a no-op (that still commits the CRTC).
    for i in 0..16 {
        igt.host.proc_memory[OBJS as usize + i * 4..][..4].copy_from_slice(&crtc.to_le_bytes());
    }
    assert_eq!(igt.raw_blocking(ioc), Ok(()));
    // Anything other than a property id of the object.
    igt.host.proc_memory[COUNTS as usize..][..4].copy_from_slice(&1u32.to_le_bytes());
    let plane_prop = igt.plane("FB_ID");
    for not_a_prop in [0, crtc, kms::PRIMARY_PLANE_ID, kms::CONNECTOR_ID, mode, plane_prop] {
        igt.host.proc_memory[PROPS as usize..][..4].copy_from_slice(&not_a_prop.to_le_bytes());
        assert_eq!(igt.raw(ioc), Err(Errno::ENOENT), "property {not_a_prop}");
    }
    // Valid property, valid value, many times over.
    let mode_id = igt.crtc("MODE_ID");
    for i in 0..256 {
        igt.host.proc_memory[PROPS as usize + i * 4..][..4].copy_from_slice(&mode_id.to_le_bytes());
        igt.host.proc_memory[VALUES as usize + i * 8..][..8].copy_from_slice(&u64::from(mode).to_le_bytes());
    }
    assert_eq!(igt.raw_blocking(ioc), Ok(()));
    for i in 0..16 {
        igt.host.proc_memory[COUNTS as usize + i * 4..][..4].copy_from_slice(&16u32.to_le_bytes());
    }
    assert_eq!(igt.raw_blocking(ioc), Ok(()));
    ioc.count_objs = 16;
    assert_eq!(igt.raw_blocking(ioc), Ok(()));
    // Outlandish addresses.
    assert_eq!(igt.raw(DrmModeAtomic { objs_ptr: 0, ..ioc }), Err(Errno::EFAULT));
    assert_eq!(igt.raw(DrmModeAtomic { count_props_ptr: 0, ..ioc }), Err(Errno::EFAULT));
    assert_eq!(igt.raw(DrmModeAtomic { props_ptr: 0, ..ioc }), Err(Errno::EFAULT));
    assert_eq!(igt.raw(DrmModeAtomic { prop_values_ptr: 0, ..ioc }), Err(Errno::EFAULT));
    assert_eq!(igt.raw_blocking(ioc), Ok(()));
    // Overflow and boundary conditions: the 17th object is not one.
    assert_eq!(igt.raw(DrmModeAtomic { count_objs: u32::MAX / 4, ..ioc }), Err(Errno::ENOENT));
    ioc.objs_ptr = u64::MAX - 4;
    assert_eq!(igt.raw(ioc), Err(Errno::EFAULT));
    assert_eq!(igt.raw(DrmModeAtomic { count_objs: 1, ..ioc }), Err(Errno::EFAULT));
    igt.close();
}

/// igt@kms_atomic@plane-invalid-params.
#[test]
fn kms_atomic_plane_invalid_params() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, mode) = igt.setup();
    let (fb_id, crtc_id) = (igt.plane("FB_ID"), igt.plane("CRTC_ID"));
    let before = igt.primary_state();
    let plane = kms::PRIMARY_PLANE_ID;
    // Object ids that are not framebuffers, and none while CRTC_ID is set.
    for bad in [kms::PRIMARY_PLANE_ID, kms::CRTC_ID, kms::CONNECTOR_ID, mode, 0] {
        assert_eq!(igt.commit(0, &[(plane, &[(fb_id, u64::from(bad))])]), Err(Errno::EINVAL), "FB_ID {bad}");
        assert_eq!(igt.primary_state(), before);
    }
    // Object ids that are not CRTCs, and none while FB_ID is set.
    for bad in [kms::PRIMARY_PLANE_ID, fb, kms::CONNECTOR_ID, mode, 0] {
        assert_eq!(igt.commit(0, &[(plane, &[(crtc_id, u64::from(bad))])]), Err(Errno::EINVAL), "CRTC_ID {bad}");
        assert_eq!(igt.primary_state(), before);
    }
    assert_eq!(igt.commit_blocking(0, &[(plane, &[(fb_id, u64::from(fb))])]), Ok(()));
    // A framebuffer too small for the plane configuration.
    let small = igt.fb(639, 479, DRM_FORMAT_XRGB8888);
    assert_eq!(igt.commit(0, &[(plane, &[(fb_id, u64::from(small))])]), Err(Errno::ENOSPC));
    assert_eq!(igt.primary_state(), before);
    igt.close();
}

/// igt@kms_atomic@plane-invalid-params-fence, without sw_sync: every fd is
/// "not a sync_file" (no sync_file exists yet), and -1 means no fence.
#[test]
fn kms_atomic_plane_invalid_params_fence() {
    let _locks = locks();
    let mut igt = Igt::open();
    igt.setup();
    let fence = igt.plane("IN_FENCE_FD");
    let plane = kms::PRIMARY_PLANE_ID;
    let drm_fd = igt.fd as u64;
    assert_eq!(igt.commit(0, &[(plane, &[(fence, drm_fd)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(0, &[(plane, &[(fence, -2i64 as u64)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit_blocking(0, &[(plane, &[(fence, -1i64 as u64)])]), Ok(()));
    assert_eq!(igt.value(plane, DRM_MODE_OBJECT_PLANE, "IN_FENCE_FD"), -1i64 as u64);
    igt.close();
}

/// igt@kms_atomic@crtc-invalid-params.
#[test]
fn kms_atomic_crtc_invalid_params() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, mode) = igt.setup();
    let mode_id = igt.crtc("MODE_ID");
    let before = igt.crtc_state();
    let crtc = kms::CRTC_ID;
    for bad in [kms::PRIMARY_PLANE_ID, kms::CRTC_ID, fb] {
        assert_eq!(igt.commit(ATOMIC_ALLOW_MODESET, &[(crtc, &[(mode_id, u64::from(bad))])]),
            Err(Errno::EINVAL), "MODE_ID {bad}");
        assert_eq!(igt.crtc_state(), before);
    }
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY, &[(crtc, &[(mode_id, u64::from(mode))])]), Ok(()));
    // TEST_ONLY cannot be combined with an event.
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY | PAGE_FLIP_EVENT, &[(crtc, &[(mode_id, u64::from(mode))])]),
        Err(Errno::EINVAL));
    // Blobs of the wrong size for a mode.
    let bytes = kms::blob(mode).unwrap().to_vec();
    let short = igt.blob(&bytes[..bytes.len() - 1]);
    let mut long_bytes = bytes.clone();
    long_bytes.push(0);
    let long = igt.blob(&long_bytes);
    for bad in [short, long] {
        assert_eq!(igt.commit(ATOMIC_ALLOW_MODESET, &[(crtc, &[(mode_id, u64::from(bad))])]), Err(Errno::EINVAL));
        assert_eq!(igt.crtc_state(), before);
    }
    // The same mode in a new blob is no modeset.
    let same = igt.blob(&bytes);
    assert_eq!(igt.commit_blocking(0, &[(crtc, &[(mode_id, u64::from(same))])]), Ok(()));
    assert_eq!(igt.value(crtc, DRM_MODE_OBJECT_CRTC, "MODE_ID"), u64::from(same));
    igt.close();
}

/// igt@kms_atomic@crtc-invalid-params-fence, without sw_sync.
#[test]
fn kms_atomic_crtc_invalid_params_fence() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, mode) = igt.setup();
    let (out_fence, active, mode_id) = (igt.crtc("OUT_FENCE_PTR"), igt.crtc("ACTIVE"), igt.crtc("MODE_ID"));
    let crtc = kms::CRTC_ID;
    let before = igt.crtc_state();
    // An out_fence_ptr outside the caller's memory.
    assert_eq!(igt.commit(ATOMIC_ALLOW_MODESET, &[(crtc, &[(out_fence, 1 << 40)])]), Err(Errno::EFAULT));
    // Turning the CRTC off is a modeset; an event on a CRTC that is off.
    assert_eq!(igt.commit(0, &[(crtc, &[(active, 0)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(PAGE_FLIP_EVENT, &[(crtc, &[(active, 0)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY, &[(crtc, &[(active, 1)])]), Ok(()));
    assert_eq!(igt.commit(PAGE_FLIP_EVENT, &[(crtc, &[(mode_id, u64::from(fb))])]), Err(Errno::EINVAL));
    assert_eq!(igt.crtc_state(), before);
    // A TEST_ONLY commit with an out-fence pointer: the slot reads -1.
    igt.host.proc_memory[OUT_FENCE as usize..][..4].copy_from_slice(&7i32.to_le_bytes());
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY, &[(crtc, &[(mode_id, u64::from(mode)), (out_fence, OUT_FENCE)])]), Ok(()));
    assert_eq!(le_u32(&igt.host.proc_memory, OUT_FENCE as usize), u32::MAX);
    // A real out-fence is a sync_file fd, which does not exist yet: the
    // commit fails without taking effect, and the slot still reads -1.
    let latched = igt.host.kms_set_fb_calls.len();
    assert_eq!(igt.commit(0, &[(crtc, &[(out_fence, OUT_FENCE)])]), Err(Errno::EOPNOTSUPP));
    assert_eq!(le_u32(&igt.host.proc_memory, OUT_FENCE as usize), u32::MAX);
    assert_eq!(igt.host.kms_set_fb_calls.len(), latched);
    assert!(!kms::flip_pending());
    igt.close();
}

/// igt@kms_atomic@test-only: TEST_ONLY touches only the request.
#[test]
fn kms_atomic_test_only() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb_id, crtc_id, mode_id, active, conn_crtc) = (igt.plane("FB_ID"), igt.plane("CRTC_ID"),
        igt.crtc("MODE_ID"), igt.crtc("ACTIVE"), igt.connector("CRTC_ID"));
    // From a dark pipe: test a full modeset, nothing changes.
    let fb = igt.fb(640, 480, DRM_FORMAT_XRGB8888);
    let mode = igt.mode_blob();
    let (plane_before, crtc_before) = (igt.primary_state(), igt.crtc_state());
    assert_eq!(igt.value(kms::CRTC_ID, DRM_MODE_OBJECT_CRTC, "MODE_ID"), 0);
    let crtc = u64::from(kms::CRTC_ID);
    let (sw, sh, cw, ch) = (igt.plane("SRC_W"), igt.plane("SRC_H"), igt.plane("CRTC_W"), igt.plane("CRTC_H"));
    let enable: [(u32, &[(u32, u64)]); 3] = [
        (kms::CRTC_ID, &[(mode_id, u64::from(mode)), (active, 1)]),
        (kms::CONNECTOR_ID, &[(conn_crtc, crtc)]),
        (kms::PRIMARY_PLANE_ID, &[(fb_id, u64::from(fb)), (crtc_id, crtc),
            (sw, 640 << 16), (sh, 480 << 16), (cw, 640), (ch, 480)]),
    ];
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY | ATOMIC_ALLOW_MODESET, &enable), Ok(()));
    assert_eq!((igt.primary_state(), igt.crtc_state()), (plane_before, crtc_before));
    assert_eq!(igt.getcrtc().mode_valid, 0);
    assert!(igt.host.kms_set_fb_calls.is_empty() && igt.host.cursor_calls.is_empty());
    assert!(!kms::crtc_active() && !kms::flip_pending());
    // Lit through the legacy API, then test a disable: still nothing.
    let request = kms_modeset(&mut igt.host, fb);
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_SETCRTC, request).unwrap();
    let (plane_before, crtc_before) = (igt.primary_state(), igt.crtc_state());
    let latched = igt.host.kms_set_fb_calls.len();
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY | ATOMIC_ALLOW_MODESET, &[
        (kms::CRTC_ID, &[(mode_id, 0), (active, 0)]),
        (kms::CONNECTOR_ID, &[(conn_crtc, 0)]),
        (kms::PRIMARY_PLANE_ID, &[(fb_id, 0), (crtc_id, 0)]),
    ]), Ok(()));
    assert_eq!((igt.primary_state(), igt.crtc_state()), (plane_before, crtc_before));
    assert_eq!(igt.host.kms_set_fb_calls.len(), latched);
    assert!(kms::crtc_active() && !kms::flip_pending());
    igt.close();
}

/// igt@kms_atomic@plane-primary-legacy: atomic and legacy updates of the
/// primary plane report one state.
#[test]
fn kms_atomic_plane_primary_legacy() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, _) = igt.setup();
    let fb_id = igt.plane("FB_ID");
    let fb2 = igt.fb(640, 480, DRM_FORMAT_XRGB8888);
    let plane = kms::PRIMARY_PLANE_ID;
    assert_eq!(igt.commit_blocking(0, &[(plane, &[(fb_id, u64::from(fb2))])]), Ok(()));
    assert_eq!((igt.getcrtc().fb_id, igt.getplane(plane).fb_id), (fb2, fb2));
    assert_eq!(*igt.host.kms_set_fb_calls.last().unwrap(), (1, kms::CRTC_ID, fb2));
    // Legacy SETCRTC: the atomic state follows (MODE_ID may be a new blob
    // of the same mode, as CRTC_RELAX_MODE allows).
    let request = kms_modeset(&mut igt.host, fb);
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_SETCRTC, request).unwrap();
    assert_eq!(igt.value(plane, DRM_MODE_OBJECT_PLANE, "FB_ID"), u64::from(fb));
    assert_eq!(igt.value(plane, DRM_MODE_OBJECT_PLANE, "SRC_W"), 640 << 16);
    assert_eq!(igt.value(kms::CRTC_ID, DRM_MODE_OBJECT_CRTC, "ACTIVE"), 1);
    // Universal SETPLANE.
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_SETPLANE, WpkDrmModeSetPlane {
        plane_id: plane, crtc_id: kms::CRTC_ID, fb_id: fb2, crtc_w: 640, crtc_h: 480,
        src_w: 640 << 16, src_h: 480 << 16, ..Default::default() }).unwrap();
    assert_eq!(igt.value(plane, DRM_MODE_OBJECT_PLANE, "FB_ID"), u64::from(fb2));
    igt.close();
}

/// igt@kms_atomic@plane-cursor-legacy.
#[test]
fn kms_atomic_plane_cursor_legacy() {
    let _locks = locks();
    let mut igt = Igt::open();
    igt.setup();
    let cursor = kms::CURSOR_PLANE_ID;
    let p = |igt: &mut Igt, name| igt.prop(cursor, DRM_MODE_OBJECT_PLANE, name);
    let (fb_id, crtc_id, cx, cy, cw, ch, sw, sh) = (p(&mut igt, "FB_ID"), p(&mut igt, "CRTC_ID"),
        p(&mut igt, "CRTC_X"), p(&mut igt, "CRTC_Y"), p(&mut igt, "CRTC_W"), p(&mut igt, "CRTC_H"),
        p(&mut igt, "SRC_W"), p(&mut igt, "SRC_H"));
    let image = igt.fb(64, 64, DRM_FORMAT_ARGB8888);
    let crtc = u64::from(kms::CRTC_ID);
    assert_eq!(igt.commit_blocking(0, &[(cursor, &[(fb_id, u64::from(image)), (crtc_id, crtc),
        (cx, 320), (cy, 240), (cw, 64), (ch, 64), (sw, 64 << 16), (sh, 64 << 16)])]), Ok(()));
    let plane = igt.getplane(cursor);
    assert_eq!((plane.fb_id, plane.crtc_id), (image, kms::CRTC_ID));
    let call = *igt.host.cursor_calls.last().unwrap();
    assert_eq!((call.4, call.5, call.2, call.3), (320, 240, 64, 64));
    // Negative positions are allowed: the cursor is clipped, not refused.
    assert_eq!(igt.commit_blocking(0, &[(cursor, &[(cx, -16i64 as u64), (cy, -16i64 as u64)])]), Ok(()));
    assert_eq!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "CRTC_X"), -16i64 as u64);
    // Disable through atomic.
    assert_eq!(igt.commit_blocking(0, &[(cursor, &[(fb_id, 0), (crtc_id, 0)])]), Ok(()));
    assert_eq!(igt.getplane(cursor).fb_id, 0);
    assert_eq!(igt.host.cursor_calls.last().unwrap().1, 0, "hidden");
    // The legacy cursor API, verified through atomic.
    let dumb = kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_CREATE_DUMB,
        WpkDrmModeCreateDumb { width: 64, height: 64, bpp: 32, ..Default::default() }).unwrap();
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_CURSOR, WpkDrmModeCursor {
        flags: DRM_MODE_CURSOR_BO | DRM_MODE_CURSOR_MOVE, crtc_id: kms::CRTC_ID, x: 100, y: 50,
        width: 64, height: 64, handle: dumb.handle }).unwrap();
    assert_ne!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "FB_ID"), 0);
    assert_eq!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "CRTC_ID"), crtc);
    assert_eq!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "CRTC_X"), 100);
    assert_eq!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "SRC_W"), 64 << 16);
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_CURSOR, WpkDrmModeCursor {
        flags: DRM_MODE_CURSOR_MOVE, crtc_id: kms::CRTC_ID, x: 84, y: 34, ..Default::default() }).unwrap();
    assert_eq!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "CRTC_Y"), 34);
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_CURSOR, WpkDrmModeCursor {
        flags: DRM_MODE_CURSOR_BO, crtc_id: kms::CRTC_ID, ..Default::default() }).unwrap();
    assert_eq!(igt.value(cursor, DRM_MODE_OBJECT_PLANE, "FB_ID"), 0);
    // The cursor plane neither scales nor crops (D-12).
    assert_eq!(igt.commit(0, &[(cursor, &[(fb_id, u64::from(image)), (crtc_id, crtc),
        (cw, 32), (ch, 32), (sw, 64 << 16), (sh, 64 << 16)])]), Err(Errno::ERANGE));
    igt.close();
}

/// igt@kms_atomic@atomic-plane-damage: FB_DAMAGE_CLIPS is validated and
/// held, and the plane is presented whole.
#[test]
fn kms_atomic_atomic_plane_damage() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, _) = igt.setup();
    let damage = igt.plane("FB_DAMAGE_CLIPS");
    let fb_id = igt.plane("FB_ID");
    let plane = kms::PRIMARY_PLANE_ID;
    let rect = |x1: i32, y1: i32, x2: i32, y2: i32| {
        [x1, y1, x2, y2].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()
    };
    let mut two = rect(0, 0, 320, 240);
    two.extend(rect(320, 240, 640, 480));
    let clips = igt.blob(&two);
    assert_eq!(igt.commit_blocking(0, &[(plane, &[(fb_id, u64::from(fb)), (damage, u64::from(clips))])]), Ok(()));
    assert_eq!(igt.value(plane, DRM_MODE_OBJECT_PLANE, "FB_DAMAGE_CLIPS"), u64::from(clips));
    // The plane state holds the blob after its creator destroys it.
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_DESTROYPROPBLOB, clips).unwrap();
    assert!(kms::blob(clips).is_some());
    let partial = igt.blob(&two[..20]);
    let empty = igt.blob(&rect(10, 10, 10, 20));
    let negative = igt.blob(&rect(-1, 0, 10, 10));
    for (bad, what) in [(partial, "not whole rects"), (empty, "empty rect"), (negative, "negative"), (0xffff, "no blob")] {
        assert_eq!(igt.commit(0, &[(plane, &[(damage, u64::from(bad))])]), Err(Errno::EINVAL), "{what}");
    }
    assert_eq!(igt.commit_blocking(0, &[(plane, &[(damage, 0)])]), Ok(()));
    assert!(kms::blob(clips).is_none(), "the last reference freed it");
    igt.close();
}

/// A nonblocking flip with an event, as a compositor issues one per frame:
/// EBUSY until the vblank that completes it, which delivers
/// DRM_EVENT_FLIP_COMPLETE with the request's user data.
#[test]
fn kms_atomic_nonblocking_flip_event_arrives_at_the_completing_vblank() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, _) = igt.setup();
    let fb2 = igt.fb(640, 480, DRM_FORMAT_XRGB8888);
    let fb_id = igt.plane("FB_ID");
    let plane = kms::PRIMARY_PLANE_ID;
    let req = igt.request(ATOMIC_NONBLOCK | PAGE_FLIP_EVENT, &[(plane, &[(fb_id, u64::from(fb2))])], 0xfeed_beef);
    assert_eq!(igt.raw(req), Ok(()));
    assert!(kms::flip_pending());
    assert_eq!(read_drm_events(&mut igt.proc, &mut igt.host, igt.fd, 32), Err(Errno::EAGAIN));
    let again = igt.request(ATOMIC_NONBLOCK, &[(plane, &[(fb_id, u64::from(fb))])], 0);
    assert_eq!(igt.raw(again), Err(Errno::EBUSY));
    // A TEST_ONLY probe is never busy.
    assert_eq!(igt.commit(ATOMIC_TEST_ONLY, &[(plane, &[(fb_id, u64::from(fb))])]), Ok(()));
    let seq = igt.vblank();
    assert!(crate::dri::take_vblank_wake());
    let event = read_drm_events(&mut igt.proc, &mut igt.host, igt.fd, 64).unwrap();
    assert_eq!(event.len(), 32);
    assert_eq!((le_u32(&event, 0), le_u32(&event, 24), le_u32(&event, 28)),
        (DRM_EVENT_FLIP_COMPLETE, seq as u32, kms::CRTC_ID));
    assert_eq!(u64::from_le_bytes(event[8..16].try_into().unwrap()), 0xfeed_beef);
    assert_eq!(igt.raw(again), Ok(()));
    igt.close();
}

/// A blocking commit returns once its flip has completed: it is applied
/// once, the host's retry only waits, and the completing vblank wakes it.
#[test]
fn kms_atomic_blocking_commit_waits_for_its_flip_once() {
    let _locks = locks();
    let mut igt = Igt::open();
    igt.setup();
    let fb2 = igt.fb(640, 480, DRM_FORMAT_XRGB8888);
    let fb_id = igt.plane("FB_ID");
    let req = igt.request(0, &[(kms::PRIMARY_PLANE_ID, &[(fb_id, u64::from(fb2))])], 0);
    let latched = igt.host.kms_set_fb_calls.len();
    assert_eq!(igt.raw(req), Err(Errno::EAGAIN), "parked on its own flip");
    assert_eq!(igt.getcrtc().fb_id, fb2, "applied before parking");
    assert_eq!(igt.host.kms_set_fb_calls.len(), latched + 1);
    assert_eq!(igt.raw(req), Err(Errno::EAGAIN), "a retry before the vblank still waits");
    assert_eq!(igt.host.kms_set_fb_calls.len(), latched + 1, "and does not commit twice");
    igt.vblank();
    assert!(crate::dri::take_vblank_wake(), "the completing vblank wakes the parked caller");
    assert_eq!(igt.raw(req), Ok(()));
    assert_eq!(igt.host.kms_set_fb_calls.len(), latched + 1);
    // A blocking commit behind a pending nonblocking one waits without
    // applying anything.
    let fb3 = igt.fb(640, 480, DRM_FORMAT_XRGB8888);
    let flip = igt.request(ATOMIC_NONBLOCK, &[(kms::PRIMARY_PLANE_ID, &[(fb_id, u64::from(fb3))])], 0);
    assert_eq!(igt.raw(flip), Ok(()));
    let back = igt.request(0, &[(kms::PRIMARY_PLANE_ID, &[(fb_id, u64::from(fb2))])], 0);
    assert_eq!(igt.raw(back), Err(Errno::EAGAIN));
    assert_eq!(igt.getcrtc().fb_id, fb3);
    igt.close();
}

/// The CRTC turning off sends a requested event at once; ACTIVE off scans
/// out nothing and stops the vblank counter.
#[test]
fn kms_atomic_disabling_the_crtc_completes_at_once_and_goes_dark() {
    let _locks = locks();
    let mut igt = Igt::open();
    igt.setup();
    let active = igt.crtc("ACTIVE");
    let req = igt.request(ATOMIC_NONBLOCK | ATOMIC_ALLOW_MODESET | PAGE_FLIP_EVENT,
        &[(kms::CRTC_ID, &[(active, 0)])], 7);
    assert_eq!(igt.raw(req), Ok(()));
    assert!(!kms::crtc_active() && !kms::flip_pending());
    assert_eq!(*igt.host.kms_set_fb_calls.last().unwrap(), (1, kms::CRTC_ID, 0));
    let event = read_drm_events(&mut igt.proc, &mut igt.host, igt.fd, 32).unwrap();
    assert_eq!((le_u32(&event, 0), u64::from_le_bytes(event[8..16].try_into().unwrap())),
        (DRM_EVENT_FLIP_COMPLETE, 7));
    // The legacy DPMS value follows ACTIVE; DPMS On lights it again.
    assert_eq!(igt.value(kms::CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR, "DPMS"), DRM_MODE_DPMS_OFF);
    kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd, DRM_IOCTL_MODE_OBJ_SETPROPERTY, WpkDrmModeObjSetProperty {
        value: DRM_MODE_DPMS_ON, prop_id: kms::PROP_DPMS, obj_id: kms::CONNECTOR_ID,
        obj_type: DRM_MODE_OBJECT_CONNECTOR, pad: 0 }).unwrap();
    assert_eq!(igt.value(kms::CRTC_ID, DRM_MODE_OBJECT_CRTC, "ACTIVE"), 1);
    assert_ne!(igt.host.kms_set_fb_calls.last().unwrap().2, 0, "scanning out again");
    igt.close();
}

/// D-12: the primary plane covers the whole CRTC unscaled, so scaling is
/// ERANGE and positioning, partial coverage or no primary on an enabled
/// CRTC is EINVAL; a modeset needs ALLOW_MODESET.
#[test]
fn kms_atomic_primary_plane_neither_scales_nor_moves() {
    let _locks = locks();
    let mut igt = Igt::open();
    let (fb, _) = igt.setup();
    let (fb_id, crtc_id, cx, cw, sw, sx) = (igt.plane("FB_ID"), igt.plane("CRTC_ID"),
        igt.plane("CRTC_X"), igt.plane("CRTC_W"), igt.plane("SRC_W"), igt.plane("SRC_X"));
    let plane = kms::PRIMARY_PLANE_ID;
    assert_eq!(igt.commit(0, &[(plane, &[(cw, 320)])]), Err(Errno::ERANGE));
    assert_eq!(igt.commit(0, &[(plane, &[(cw, 320), (sw, 320 << 16)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(0, &[(plane, &[(cx, 1), (cw, 639), (sw, 639 << 16)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(ATOMIC_ALLOW_MODESET, &[(plane, &[(fb_id, 0), (crtc_id, 0)])]), Err(Errno::EINVAL));
    // Panning a larger framebuffer by whole pixels is a flip.
    let big = igt.fb(800, 600, DRM_FORMAT_XRGB8888);
    assert_eq!(igt.commit_blocking(0, &[(plane, &[(fb_id, u64::from(big)), (sx, 16 << 16)])]), Ok(()));
    assert_eq!(igt.getcrtc().x, 16);
    assert_eq!(*igt.host.kms_set_fb_viewports.last().unwrap(), [16, 0, 640, 480]);
    assert_eq!(igt.commit(0, &[(plane, &[(sx, (16 << 16) + (1 << 15))])]), Err(Errno::EINVAL), "sub-pixel pan");
    let active = igt.crtc("ACTIVE");
    assert_eq!(igt.commit(0, &[(kms::CRTC_ID, &[(active, 0)])]), Err(Errno::EINVAL), "modeset without ALLOW_MODESET");
    let _ = fb;
    igt.close();
}

/// The atomic cap and ioctl permissions (drm_ioctl.c, drm_mode_atomic_ioctl).
#[test]
fn kms_atomic_needs_the_client_cap_and_master() {
    let _locks = locks();
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = kms_master_card0(&mut proc, &mut host);
    let empty = DrmModeAtomic::default();
    assert_eq!(kms_ioctl(&mut proc, &mut host, fd, IOCTL_MODE_ATOMIC, empty).map(|_| ()), Err(Errno::EINVAL),
        "atomic cap not enabled");
    let cap = |proc: &mut Process, host: &mut MockHostIO, fd, capability, value| {
        kms_ioctl(proc, host, fd, DRM_IOCTL_SET_CLIENT_CAP, WpkDrmSetClientCap { capability, value }).map(|_| ())
    };
    assert_eq!(cap(&mut proc, &mut host, fd, CLIENT_CAP_WRITEBACK_CONNECTORS, 1), Err(Errno::EINVAL));
    assert_eq!(cap(&mut proc, &mut host, fd, CLIENT_CAP_ATOMIC, 3), Err(Errno::EINVAL));
    assert_eq!(cap(&mut proc, &mut host, fd, CLIENT_CAP_ATOMIC, 1), Ok(()));
    assert_eq!(cap(&mut proc, &mut host, fd, CLIENT_CAP_WRITEBACK_CONNECTORS, 1), Ok(()));
    assert_eq!(cap(&mut proc, &mut host, fd, CLIENT_CAP_WRITEBACK_CONNECTORS, 2), Err(Errno::EINVAL));
    // Atomic implies universal planes.
    let planes = kms_ioctl(&mut proc, &mut host, fd, DRM_IOCTL_MODE_GETPLANERESOURCES,
        WpkDrmModeGetPlaneRes { plane_id_ptr: 0x1000, count_planes: 4, pad: 0 }).unwrap();
    assert_eq!(planes.count_planes, 1);
    assert_eq!(kms_ioctl(&mut proc, &mut host, fd, IOCTL_MODE_ATOMIC, empty).map(|_| ()), Ok(()));
    // DRM_MASTER on the primary node, refused on the render node.
    let plain = sys_open(&mut proc, &mut host, b"/dev/dri/card0", O_RDWR, 0).unwrap();
    cap(&mut proc, &mut host, plain, CLIENT_CAP_ATOMIC, 1).unwrap();
    assert_eq!(kms_ioctl(&mut proc, &mut host, plain, IOCTL_MODE_ATOMIC, empty).map(|_| ()), Err(Errno::EACCES));
    let render = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    assert_eq!(kms_ioctl(&mut proc, &mut host, render, IOCTL_MODE_ATOMIC, empty).map(|_| ()), Err(Errno::EACCES));
    // Clearing the cap clears universal planes too.
    assert_eq!(cap(&mut proc, &mut host, fd, CLIENT_CAP_ATOMIC, 0), Ok(()));
    let planes = kms_ioctl(&mut proc, &mut host, fd, DRM_IOCTL_MODE_GETPLANERESOURCES,
        WpkDrmModeGetPlaneRes { plane_id_ptr: 0x1000, count_planes: 4, pad: 0 }).unwrap();
    assert_eq!(planes.count_planes, 0);
    kms::reset_for_test();
}

/// igt@kms_properties@get_properties-sanity-atomic: the atomic properties
/// are listed only with the cap, with Linux's types and flags, and no
/// IN_FORMATS (no format modifiers are advertised, D-15).
#[test]
fn kms_properties_get_properties_sanity_atomic() {
    let _locks = locks();
    let mut igt = Igt::open();
    let names = |igt: &mut Igt, obj, ty| {
        let ids: Vec<u32> = igt.properties(obj, ty).into_iter().map(|(id, _)| id).collect();
        ids.into_iter().map(|id| igt.name_of(id)).collect::<Vec<_>>()
    };
    let plane = names(&mut igt, kms::PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE);
    for name in ["type", "FB_ID", "CRTC_ID", "SRC_X", "SRC_Y", "SRC_W", "SRC_H", "CRTC_X", "CRTC_Y",
        "CRTC_W", "CRTC_H", "IN_FENCE_FD", "FB_DAMAGE_CLIPS"] {
        assert!(plane.iter().any(|n| n == name), "plane property {name}");
    }
    assert!(!plane.iter().any(|n| n == "IN_FORMATS"));
    let crtc = names(&mut igt, kms::CRTC_ID, DRM_MODE_OBJECT_CRTC);
    for name in ["ACTIVE", "MODE_ID", "OUT_FENCE_PTR", "GAMMA_LUT", "GAMMA_LUT_SIZE"] {
        assert!(crtc.iter().any(|n| n == name), "crtc property {name}");
    }
    assert!(names(&mut igt, kms::CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR).iter().any(|n| n == "CRTC_ID"));
    let fb_id = igt.plane("FB_ID");
    let prop = igt.property(fb_id);
    assert_eq!(prop.flags, PROP_ATOMIC | PROP_OBJECT);
    assert_eq!(prop.count_values, 1);
    let crtc_x = igt.plane("CRTC_X");
    assert_eq!(igt.property(crtc_x).flags, PROP_ATOMIC | PROP_SIGNED_RANGE);
    let in_fence = igt.plane("IN_FENCE_FD");
    assert_eq!(igt.value(kms::PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE, "IN_FENCE_FD"), -1i64 as u64);
    let _ = in_fence;
    // Without the cap, none of them are listed.
    assert_eq!(igt.set_cap(CLIENT_CAP_ATOMIC, 0), Ok(()));
    assert_eq!(names(&mut igt, kms::PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE), ["type"]);
    assert_eq!(names(&mut igt, kms::CRTC_ID, DRM_MODE_OBJECT_CRTC), ["GAMMA_LUT", "GAMMA_LUT_SIZE"]);
    igt.close();
}

/// igt@kms_properties@invalid-properties-atomic.
#[test]
fn kms_properties_invalid_properties_atomic() {
    let _locks = locks();
    let mut igt = Igt::open();
    igt.setup();
    let (mode_id, active, gamma_size) = (igt.crtc("MODE_ID"), igt.crtc("ACTIVE"), igt.crtc("GAMMA_LUT_SIZE"));
    let (plane_type, fb_id) = (igt.plane("type"), igt.plane("FB_ID"));
    let dpms = igt.connector("DPMS");
    // A property the object does not carry.
    assert_eq!(igt.commit(0, &[(kms::PRIMARY_PLANE_ID, &[(mode_id, 0)])]), Err(Errno::ENOENT));
    assert_eq!(igt.commit(0, &[(kms::CRTC_ID, &[(fb_id, 0)])]), Err(Errno::ENOENT));
    // Immutable, out of range, or legacy-only.
    assert_eq!(igt.commit(0, &[(kms::PRIMARY_PLANE_ID, &[(plane_type, DRM_PLANE_TYPE_PRIMARY)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(0, &[(kms::CRTC_ID, &[(gamma_size, 256)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(ATOMIC_ALLOW_MODESET, &[(kms::CRTC_ID, &[(active, 2)])]), Err(Errno::EINVAL));
    assert_eq!(igt.commit(0, &[(kms::CONNECTOR_ID, &[(dpms, DRM_MODE_DPMS_ON)])]), Err(Errno::EINVAL));
    igt.close();
}

/// Legacy ioctls are commits through the same check: a legacy property
/// update that the atomic check refuses fails the same way and changes
/// nothing.
#[test]
fn kms_atomic_legacy_property_updates_take_the_atomic_check() {
    let _locks = locks();
    let mut igt = Igt::open();
    igt.setup();
    let sw = igt.plane("SRC_W");
    let fb_id = igt.plane("FB_ID");
    let setprop = |igt: &mut Igt, prop_id, value| kms_ioctl(&mut igt.proc, &mut igt.host, igt.fd,
        DRM_IOCTL_MODE_OBJ_SETPROPERTY, WpkDrmModeObjSetProperty { value, prop_id,
            obj_id: kms::PRIMARY_PLANE_ID, obj_type: DRM_MODE_OBJECT_PLANE, pad: 0 }).map(|_| ());
    assert_eq!(setprop(&mut igt, sw, 320 << 16), Err(Errno::ERANGE));
    assert_eq!(igt.value(kms::PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE, "SRC_W"), 640 << 16);
    let fb2 = igt.fb(640, 480, DRM_FORMAT_XRGB8888);
    assert_eq!(setprop(&mut igt, fb_id, u64::from(fb2)), Ok(()));
    assert_eq!(igt.getcrtc().fb_id, fb2);
    assert!(!kms::flip_pending(), "a legacy update completes when it returns");
    igt.close();
}
