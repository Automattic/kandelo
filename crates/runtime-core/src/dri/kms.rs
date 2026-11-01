//! Mode objects, properties and state of the one virtual display.
//!
//! Linux allocates CRTCs, encoders, connectors, planes and properties from
//! one id space, and clients such as wlroots read a property with
//! `DRM_MODE_OBJECT_ANY`, so no two objects here share an id.
//!
//! All mutable display state lives in one [`KmsDevice`], the counterpart of
//! Linux's `drm_device` mode-config state: the CRTC, its primary and cursor
//! planes and connector, the property blobs, the framebuffer index and the
//! magic map. It is confined to the kernel syscall executor, just like the
//! master and BO registries. Every change to the CRTC, plane or connector
//! state is a commit (`dri::atomic`): the atomic ioctl and the legacy
//! modeset, flip, plane, cursor, DPMS and gamma ioctls all stage a copy of
//! this state, check it once, and then replace it.

use core::cell::UnsafeCell;
use alloc::collections::BTreeMap;

use wasm_posix_shared::dri::*;
use wasm_posix_shared::Errno;

pub const CRTC_ID: u32 = 1;
pub const ENCODER_ID: u32 = 2;
pub const CONNECTOR_ID: u32 = 3;
pub const PRIMARY_PLANE_ID: u32 = 4;

pub const PROP_PLANE_TYPE: u32 = 5;
pub const PROP_EDID: u32 = 6;
pub const PROP_DPMS: u32 = 7;
pub const PROP_LINK_STATUS: u32 = 8;
pub const PROP_NON_DESKTOP: u32 = 9;
pub const CURSOR_PLANE_ID: u32 = 10;
/// CRTC color-management properties (`drm_crtc_enable_color_mgmt`): the
/// gamma LUT blob and its fixed entry count.
pub const PROP_GAMMA_LUT: u32 = 11;
pub const PROP_GAMMA_LUT_SIZE: u32 = 12;
/// The atomic properties (`drm_mode_create_standard_properties`). Linux
/// marks them `DRM_MODE_PROP_ATOMIC`: only a file that enabled
/// `DRM_CLIENT_CAP_ATOMIC` sees them listed, although any file can look one
/// up by id and set it through the legacy property ioctl. `CRTC_ID` is one
/// property shared by planes and connectors, as on Linux.
pub const PROP_FB_ID: u32 = 13;
pub const PROP_CRTC_ID: u32 = 14;
pub const PROP_SRC_X: u32 = 15;
pub const PROP_SRC_Y: u32 = 16;
pub const PROP_SRC_W: u32 = 17;
pub const PROP_SRC_H: u32 = 18;
pub const PROP_CRTC_X: u32 = 19;
pub const PROP_CRTC_Y: u32 = 20;
pub const PROP_CRTC_W: u32 = 21;
pub const PROP_CRTC_H: u32 = 22;
pub const PROP_IN_FENCE_FD: u32 = 23;
pub const PROP_FB_DAMAGE_CLIPS: u32 = 24;
pub const PROP_ACTIVE: u32 = 25;
pub const PROP_MODE_ID: u32 = 26;
pub const PROP_OUT_FENCE_PTR: u32 = 27;
/// First id handed out at run time (framebuffers, blobs).
const FIRST_DYNAMIC_ID: u32 = PROP_OUT_FENCE_PTR + 1;

/// Entries of the CRTC's legacy gamma ramp and of `GAMMA_LUT`
/// (`crtc->gamma_size`): 256, as common 8-bit legacy drivers report.
pub const GAMMA_SIZE: u32 = 256;
/// Bytes of one `struct drm_color_lut` (red, green, blue, reserved).
pub const COLOR_LUT_ENTRY_BYTES: usize = 8;
/// Bytes of one `struct drm_mode_rect` in an `FB_DAMAGE_CLIPS` blob.
pub const DAMAGE_RECT_BYTES: usize = 16;
pub const CURSOR_PLANE_FORMATS: [u32; 1] = [DRM_FORMAT_ARGB8888];
/// The cursor plane's largest image (`DRM_CAP_CURSOR_WIDTH`/`HEIGHT`).
pub const CURSOR_MAX_SIZE: u32 = 64;

/// The pixel formats `DRM_IOCTL_MODE_ADDFB2` accepts for scanout. The host's
/// presenters output 8 bits per channel, like a monitor connected at 8 bpc:
/// a single-channel R8 or two-channel GR88 plane shows its red (and green)
/// channel with the missing channels zero, as the format defines them, and a
/// 10-bit or half-float plane is reduced to 8 bits by rounding (half floats
/// clamped to [0, 1]) identically on every presentation path, with the gamma
/// LUT indexed by the reduced value.
pub const PRIMARY_PLANE_FORMATS: [u32; 13] = [
    DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888, DRM_FORMAT_RGB565,
    DRM_FORMAT_ABGR8888, DRM_FORMAT_XBGR8888, DRM_FORMAT_R8, DRM_FORMAT_GR88,
    DRM_FORMAT_XRGB2101010, DRM_FORMAT_ARGB2101010, DRM_FORMAT_XBGR2101010,
    DRM_FORMAT_ABGR2101010, DRM_FORMAT_XBGR16161616F, DRM_FORMAT_ABGR16161616F,
];

pub enum PropertyKind {
    Enum(&'static [(u64, &'static str)]),
    Range(u64, u64),
    SignedRange(i64, i64),
    /// `DRM_MODE_PROP_OBJECT`: 0 or the id of an object of this type.
    Object(u32),
    Blob,
}

pub struct Property {
    pub id: u32,
    pub name: &'static str,
    pub immutable: bool,
    /// `DRM_MODE_PROP_ATOMIC`: listed only to atomic clients.
    pub atomic: bool,
    pub kind: PropertyKind,
}

impl Property {
    pub fn flags(&self) -> u32 {
        let kind = match self.kind {
            PropertyKind::Enum(_) => DRM_MODE_PROP_ENUM,
            PropertyKind::Range(..) => DRM_MODE_PROP_RANGE,
            PropertyKind::SignedRange(..) => DRM_MODE_PROP_SIGNED_RANGE,
            PropertyKind::Object(_) => DRM_MODE_PROP_OBJECT,
            PropertyKind::Blob => DRM_MODE_PROP_BLOB,
        };
        let kind = if self.immutable { kind | DRM_MODE_PROP_IMMUTABLE } else { kind };
        if self.atomic { kind | DRM_MODE_PROP_ATOMIC } else { kind }
    }

    /// The `values` array `DRM_IOCTL_MODE_GETPROPERTY` reports: the enum
    /// values, the range bounds, the object type, or nothing for a blob.
    pub fn values(&self) -> alloc::vec::Vec<u64> {
        match self.kind {
            PropertyKind::Enum(entries) => entries.iter().map(|&(value, _)| value).collect(),
            PropertyKind::Range(min, max) => alloc::vec![min, max],
            PropertyKind::SignedRange(min, max) => alloc::vec![min as u64, max as u64],
            PropertyKind::Object(object_type) => alloc::vec![u64::from(object_type)],
            PropertyKind::Blob => alloc::vec::Vec::new(),
        }
    }

    /// `drm_property_change_valid_get`: whether `value` is one this
    /// property can take at all. Immutable properties take none; an object
    /// property takes 0 or the id of a live object of its type; a blob
    /// property takes 0 or the id of a live blob.
    pub fn accepts(&self, value: u64) -> bool {
        if self.immutable {
            return false;
        }
        match self.kind {
            PropertyKind::Range(min, max) => (min..=max).contains(&value),
            PropertyKind::SignedRange(min, max) => (min..=max).contains(&(value as i64)),
            PropertyKind::Enum(entries) => entries.iter().any(|&(v, _)| v == value),
            PropertyKind::Blob => value == 0
                || u32::try_from(value).is_ok_and(|id| blob(id).is_some()),
            PropertyKind::Object(object_type) => value == 0
                || u32::try_from(value).is_ok_and(|id| object_type_of(id) == Some(object_type)),
        }
    }
}

const fn atomic_range(id: u32, name: &'static str, min: u64, max: u64) -> Property {
    Property { id, name, immutable: false, atomic: true, kind: PropertyKind::Range(min, max) }
}

const fn atomic_signed(id: u32, name: &'static str, min: i64, max: i64) -> Property {
    Property { id, name, immutable: false, atomic: true, kind: PropertyKind::SignedRange(min, max) }
}

const PROPERTIES: [Property; 22] = [
    Property {
        id: PROP_PLANE_TYPE,
        name: "type",
        immutable: true,
        atomic: false,
        kind: PropertyKind::Enum(&[
            (DRM_PLANE_TYPE_OVERLAY, "Overlay"),
            (DRM_PLANE_TYPE_PRIMARY, "Primary"),
            (DRM_PLANE_TYPE_CURSOR, "Cursor"),
        ]),
    },
    Property { id: PROP_EDID, name: "EDID", immutable: true, atomic: false, kind: PropertyKind::Blob },
    Property {
        id: PROP_DPMS,
        name: "DPMS",
        immutable: false,
        atomic: false,
        kind: PropertyKind::Enum(&[
            (DRM_MODE_DPMS_ON, "On"),
            (DRM_MODE_DPMS_STANDBY, "Standby"),
            (DRM_MODE_DPMS_SUSPEND, "Suspend"),
            (DRM_MODE_DPMS_OFF, "Off"),
        ]),
    },
    Property {
        id: PROP_LINK_STATUS,
        name: "link-status",
        immutable: false,
        atomic: false,
        kind: PropertyKind::Enum(&[
            (DRM_MODE_LINK_STATUS_GOOD, "Good"),
            (DRM_MODE_LINK_STATUS_BAD, "Bad"),
        ]),
    },
    Property {
        id: PROP_NON_DESKTOP,
        name: "non-desktop",
        immutable: true,
        atomic: false,
        kind: PropertyKind::Range(0, 1),
    },
    Property { id: PROP_GAMMA_LUT, name: "GAMMA_LUT", immutable: false, atomic: false, kind: PropertyKind::Blob },
    Property {
        id: PROP_GAMMA_LUT_SIZE,
        name: "GAMMA_LUT_SIZE",
        immutable: true,
        atomic: false,
        kind: PropertyKind::Range(0, u32::MAX as u64),
    },
    Property {
        id: PROP_FB_ID, name: "FB_ID", immutable: false, atomic: true,
        kind: PropertyKind::Object(DRM_MODE_OBJECT_FB),
    },
    Property {
        id: PROP_CRTC_ID, name: "CRTC_ID", immutable: false, atomic: true,
        kind: PropertyKind::Object(DRM_MODE_OBJECT_CRTC),
    },
    atomic_range(PROP_SRC_X, "SRC_X", 0, u32::MAX as u64),
    atomic_range(PROP_SRC_Y, "SRC_Y", 0, u32::MAX as u64),
    atomic_range(PROP_SRC_W, "SRC_W", 0, u32::MAX as u64),
    atomic_range(PROP_SRC_H, "SRC_H", 0, u32::MAX as u64),
    atomic_signed(PROP_CRTC_X, "CRTC_X", i32::MIN as i64, i32::MAX as i64),
    atomic_signed(PROP_CRTC_Y, "CRTC_Y", i32::MIN as i64, i32::MAX as i64),
    atomic_range(PROP_CRTC_W, "CRTC_W", 0, i32::MAX as u64),
    atomic_range(PROP_CRTC_H, "CRTC_H", 0, i32::MAX as u64),
    atomic_signed(PROP_IN_FENCE_FD, "IN_FENCE_FD", -1, i32::MAX as i64),
    Property {
        id: PROP_FB_DAMAGE_CLIPS, name: "FB_DAMAGE_CLIPS", immutable: false, atomic: true,
        kind: PropertyKind::Blob,
    },
    atomic_range(PROP_ACTIVE, "ACTIVE", 0, 1),
    Property {
        id: PROP_MODE_ID, name: "MODE_ID", immutable: false, atomic: true,
        kind: PropertyKind::Blob,
    },
    atomic_range(PROP_OUT_FENCE_PTR, "OUT_FENCE_PTR", 0, u64::MAX),
];

pub fn property(id: u32) -> Option<&'static Property> {
    PROPERTIES.iter().find(|p| p.id == id)
}

/// The properties attached to each object, in Linux's attach order. The
/// legacy-visible ones come first, so a non-atomic client's listing is a
/// prefix.
const PLANE_PROPERTIES: [u32; 13] = [
    PROP_PLANE_TYPE, PROP_FB_ID, PROP_IN_FENCE_FD, PROP_CRTC_ID, PROP_CRTC_X, PROP_CRTC_Y,
    PROP_CRTC_W, PROP_CRTC_H, PROP_SRC_X, PROP_SRC_Y, PROP_SRC_W, PROP_SRC_H,
    PROP_FB_DAMAGE_CLIPS,
];
const CONNECTOR_PROPERTIES: [u32; 5] =
    [PROP_EDID, PROP_DPMS, PROP_LINK_STATUS, PROP_NON_DESKTOP, PROP_CRTC_ID];
const CRTC_PROPERTIES: [u32; 5] =
    [PROP_GAMMA_LUT, PROP_GAMMA_LUT_SIZE, PROP_ACTIVE, PROP_MODE_ID, PROP_OUT_FENCE_PTR];

/// The `DRM_MODE_OBJECT_*` type of a mode object id.
fn object_type_of(id: u32) -> Option<u32> {
    match id {
        CRTC_ID => Some(DRM_MODE_OBJECT_CRTC),
        ENCODER_ID => Some(DRM_MODE_OBJECT_ENCODER),
        CONNECTOR_ID => Some(DRM_MODE_OBJECT_CONNECTOR),
        PRIMARY_PLANE_ID | CURSOR_PLANE_ID => Some(DRM_MODE_OBJECT_PLANE),
        PROP_PLANE_TYPE..=PROP_NON_DESKTOP | PROP_GAMMA_LUT..=PROP_OUT_FENCE_PTR => {
            Some(DRM_MODE_OBJECT_PROPERTY)
        }
        _ if framebuffer(id).is_some() => Some(DRM_MODE_OBJECT_FB),
        _ if blob(id).is_some() => Some(DRM_MODE_OBJECT_BLOB),
        _ => None,
    }
}

pub fn object_type(id: u32) -> Option<u32> {
    object_type_of(id)
}

/// Resolve `obj_id` as `drm_mode_object_find` does: the id must name an
/// object, and `obj_type` must be its type or `DRM_MODE_OBJECT_ANY`.
pub fn find_object(obj_id: u32, obj_type: u32) -> Result<u32, Errno> {
    let actual = object_type(obj_id).ok_or(Errno::ENOENT)?;
    if obj_type != DRM_MODE_OBJECT_ANY && obj_type != actual {
        return Err(Errno::ENOENT);
    }
    Ok(actual)
}

/// Every property attached to an object, or `EINVAL` for an object type
/// that carries none (encoders, properties), as Linux reports.
pub fn object_properties(obj_id: u32, obj_type: u32) -> Result<&'static [u32], Errno> {
    match find_object(obj_id, obj_type)? {
        DRM_MODE_OBJECT_PLANE => Ok(&PLANE_PROPERTIES),
        DRM_MODE_OBJECT_CONNECTOR => Ok(&CONNECTOR_PROPERTIES),
        DRM_MODE_OBJECT_CRTC => Ok(&CRTC_PROPERTIES),
        _ => Err(Errno::EINVAL),
    }
}

/// The attached properties a file lists (`drm_mode_object_get_properties`):
/// atomic-only ones only for a file that enabled `DRM_CLIENT_CAP_ATOMIC`.
pub fn listed_properties(props: &'static [u32], atomic: bool) -> &'static [u32] {
    if atomic {
        return props;
    }
    let legacy = props.iter()
        .take_while(|&&id| property(id).is_some_and(|prop| !prop.atomic))
        .count();
    debug_assert!(props[legacy..].iter().all(|&id| property(id).is_some_and(|prop| prop.atomic)));
    &props[..legacy]
}

/// A plane's source rectangle (16.16 fixed point, `SRC_*`) and its
/// destination on the CRTC (`CRTC_*`), as `drm_plane_state` holds them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlaneGeometry {
    pub src_x: u32,
    pub src_y: u32,
    pub src_w: u32,
    pub src_h: u32,
    pub crtc_x: i32,
    pub crtc_y: i32,
    pub crtc_w: u32,
    pub crtc_h: u32,
}

impl PlaneGeometry {
    /// An unscaled plane that covers a `width`×`height` CRTC from the
    /// source origin `(x, y)` (what a legacy SETCRTC or flip scans).
    pub fn full_screen(x: u32, y: u32, width: u32, height: u32) -> Self {
        Self {
            src_x: x << 16, src_y: y << 16, src_w: width << 16, src_h: height << 16,
            crtc_x: 0, crtc_y: 0, crtc_w: width, crtc_h: height,
        }
    }
}

/// The primary plane: its framebuffer (0 = disabled), geometry and the
/// damage hint of the commit that put it there. The framebuffer is held by
/// its creating file's table (or by `ClosedScanout` after `CLOSEFB`).
#[derive(Clone, Copy, Debug, Default)]
pub struct PrimaryPlaneState {
    pub fb_id: u32,
    pub geometry: PlaneGeometry,
    pub damage_blob: u32,
}

/// The CRTC: `ACTIVE`, the mode (`MODE_ID`, whose blob the CRTC holds) and
/// `GAMMA_LUT`. A CRTC is enabled when it has a mode.
#[derive(Clone, Copy, Default)]
pub struct CrtcState {
    pub active: bool,
    pub mode: Option<WpkDrmModeModeinfo>,
    pub mode_blob: u32,
    pub gamma_lut: u32,
}

/// The cursor plane's state: its framebuffer, geometry and hotspot.
///
/// Like Linux's plane state this is device state, not master state: a
/// master change neither hides nor clears it, and the next master sees and
/// inherits it until it changes it. The plane owns one reference on the
/// scanned BO (`bo`), so the image stays alive while it is the cursor even
/// after the file that installed it closes. An internally allocated legacy
/// cursor framebuffer has a real identity but no user file-table entry.
/// `x`/`y` are the plane's `CRTC_X`/`CRTC_Y`.
#[derive(Clone, Debug, Default)]
pub struct CursorPlaneState {
    pub fb_id: u32,
    pub fb: Option<crate::ofd::KmsFb>,
    /// The BO reference the plane holds while `fb` is its image.
    pub bo: Option<crate::dri::BoId>,
    pub x: i32,
    pub y: i32,
    pub hot_x: i32,
    pub hot_y: i32,
    pub src: [u32; 4],
    pub crtc_w: u32,
    pub crtc_h: u32,
    pub damage_blob: u32,
}

impl CursorPlaneState {
    pub fn geometry(&self) -> PlaneGeometry {
        PlaneGeometry {
            src_x: self.src[0], src_y: self.src[1], src_w: self.src[2], src_h: self.src[3],
            crtc_x: self.x, crtc_y: self.y, crtc_w: self.crtc_w, crtc_h: self.crtc_h,
        }
    }
}

/// The one display's mutable state, the counterpart of Linux's mode-config
/// state: one struct keeps a modeset's parts (mode, planes, connector
/// routing, DPMS, blobs) in one place so a commit can stage, check and
/// replace them together.
pub struct KmsDevice {
    pub(crate) crtc: CrtcState,
    pub(crate) primary: PrimaryPlaneState,
    pub(crate) cursor: Option<CursorPlaneState>,
    /// The connector's `CRTC_ID`: whether it is routed to the CRTC.
    pub(crate) connector_crtc: bool,
    /// The connector's legacy `DPMS` value. On an atomic driver it is On or
    /// Off (`drm_atomic_connector_commit_dpms` maps Standby and Suspend to
    /// Off) and follows the CRTC's `ACTIVE` after every modeset.
    pub(crate) dpms: u64,
    /// The legacy gamma ramp (`crtc->gamma_store`): red, green and blue,
    /// GAMMA_SIZE entries each, or `None` for the identity ramp `i << 8`
    /// (`drm_mode_crtc_set_gamma_size`). It changes only through SETGAMMA,
    /// as on Linux; GETGAMMA reports it.
    gamma_store: Option<[[u16; GAMMA_SIZE as usize]; 3]>,
    next_magic: u32,
    magics: BTreeMap<u32, MagicEntry>,
    /// Framebuffers, blobs and kernel-owned objects share the one mode-object
    /// id space, so their ids start after the fixed objects and are unique
    /// across open files.
    next_object_id: u32,
    /// The commit the CRTC has latched that its next vblank has not yet
    /// completed (Linux's per-CRTC `commit_list` head). A nonblocking commit
    /// or flip while one is pending is EBUSY whichever file queued it; a
    /// blocking commit waits for it, then for its own.
    pub(crate) pending_commit: Option<u64>,
    pub(crate) next_commit: u64,
    /// Counts `drm_crtc_vblank_off` transitions. Linux sends every queued
    /// vblank event prematurely and wakes every waiter (which then
    /// succeeds) when the CRTC turns off; waits and events record the
    /// generation they started in, so a later generation means "the CRTC
    /// turned off since".
    vblank_off_generation: u32,
    blobs: BTreeMap<u32, BlobEntry>,
    closed_scanout: Option<ClosedScanout>,
    framebuffers: BTreeMap<u32, crate::ofd::WeakKmsFbs>,
    /// The connector's `EDID` blob (device-owned), 0 before the first probe.
    pub(crate) edid_blob: u32,
}

impl KmsDevice {
    const fn new() -> Self {
        Self {
            crtc: CrtcState { active: false, mode: None, mode_blob: 0, gamma_lut: 0 },
            primary: PrimaryPlaneState {
                fb_id: 0,
                geometry: PlaneGeometry {
                    src_x: 0, src_y: 0, src_w: 0, src_h: 0,
                    crtc_x: 0, crtc_y: 0, crtc_w: 0, crtc_h: 0,
                },
                damage_blob: 0,
            },
            cursor: None,
            connector_crtc: false,
            dpms: DRM_MODE_DPMS_ON,
            gamma_store: None,
            next_magic: 1,
            magics: BTreeMap::new(),
            next_object_id: FIRST_DYNAMIC_ID,
            pending_commit: None,
            next_commit: 1,
            vblank_off_generation: 0,
            blobs: BTreeMap::new(),
            closed_scanout: None,
            framebuffers: BTreeMap::new(),
            edid_blob: 0,
        }
    }
}

struct GlobalDevice(UnsafeCell<KmsDevice>);
unsafe impl Sync for GlobalDevice {}
static DEVICE: GlobalDevice = GlobalDevice(UnsafeCell::new(KmsDevice::new()));

/// The device state. The kernel executor is single-threaded and no caller
/// keeps the reference across another call into this module.
pub(crate) fn dev() -> &'static mut KmsDevice {
    unsafe { &mut *DEVICE.0.get() }
}

/// The current value of `prop_id` on object `obj_id`, from the committed
/// state (`drm_atomic_get_property`).
pub fn object_property_value(obj_id: u32, prop_id: u32) -> u64 {
    let device = dev();
    let cursor = device.cursor.clone().unwrap_or_default();
    let (fb_id, geometry, damage) = match obj_id {
        CURSOR_PLANE_ID => (cursor.fb_id, cursor.geometry(), cursor.damage_blob),
        _ => (device.primary.fb_id, device.primary.geometry, device.primary.damage_blob),
    };
    match prop_id {
        PROP_PLANE_TYPE if obj_id == CURSOR_PLANE_ID => DRM_PLANE_TYPE_CURSOR,
        PROP_PLANE_TYPE => DRM_PLANE_TYPE_PRIMARY,
        PROP_EDID => u64::from(device.edid_blob),
        PROP_DPMS => device.dpms,
        PROP_LINK_STATUS => DRM_MODE_LINK_STATUS_GOOD,
        PROP_GAMMA_LUT => u64::from(device.crtc.gamma_lut),
        PROP_GAMMA_LUT_SIZE => u64::from(GAMMA_SIZE),
        PROP_FB_ID => u64::from(fb_id),
        // A committed plane has a CRTC exactly when it has a framebuffer.
        PROP_CRTC_ID if obj_id == CONNECTOR_ID => if device.connector_crtc { u64::from(CRTC_ID) } else { 0 },
        PROP_CRTC_ID => if fb_id != 0 { u64::from(CRTC_ID) } else { 0 },
        PROP_SRC_X => u64::from(geometry.src_x),
        PROP_SRC_Y => u64::from(geometry.src_y),
        PROP_SRC_W => u64::from(geometry.src_w),
        PROP_SRC_H => u64::from(geometry.src_h),
        PROP_CRTC_X => i64::from(geometry.crtc_x) as u64,
        PROP_CRTC_Y => i64::from(geometry.crtc_y) as u64,
        PROP_CRTC_W => u64::from(geometry.crtc_w),
        PROP_CRTC_H => u64::from(geometry.crtc_h),
        // drm_atomic_plane_get_property reports no fence (-1); the fence is
        // consumed by the commit that carried it.
        PROP_IN_FENCE_FD => -1i64 as u64,
        PROP_FB_DAMAGE_CLIPS => u64::from(damage),
        PROP_ACTIVE => u64::from(device.crtc.active),
        PROP_MODE_ID => u64::from(device.crtc.mode_blob),
        PROP_OUT_FENCE_PTR => 0,
        _ => 0,
    }
}

/// The value of a property that does not depend on its object.
pub fn property_value(prop_id: u32) -> u64 {
    object_property_value(CRTC_ID, prop_id)
}

fn identity_ramp() -> [[u16; GAMMA_SIZE as usize]; 3] {
    let ramp: [u16; GAMMA_SIZE as usize] = core::array::from_fn(|i| (i as u16) << 8);
    [ramp; 3]
}

pub fn gamma_store() -> [[u16; GAMMA_SIZE as usize]; 3] {
    dev().gamma_store.unwrap_or_else(identity_ramp)
}

pub fn gamma_lut_blob() -> u32 {
    dev().crtc.gamma_lut
}

/// `drm_mode_gamma_set_ioctl` copies each channel straight into
/// `gamma_store`, so a fault on a later channel leaves the earlier ones
/// stored (and the LUT the CRTC uses unchanged).
pub fn store_gamma_channel(channel: usize, values: [u16; GAMMA_SIZE as usize]) {
    let mut store = gamma_store();
    store[channel] = values;
    dev().gamma_store = Some(store);
}

/// `drm_atomic_helper_legacy_gamma_set`, first half: a new device-owned
/// blob holding the stored ramp as `drm_color_lut` entries. The caller
/// commits it as the CRTC's `GAMMA_LUT`.
pub fn legacy_gamma_blob() -> Result<u32, Errno> {
    let ramp = gamma_store();
    let mut data = alloc::vec::Vec::with_capacity(GAMMA_SIZE as usize * COLOR_LUT_ENTRY_BYTES);
    for i in 0..GAMMA_SIZE as usize {
        for channel in ramp.iter().map(|c| c[i]).chain([0]) {
            data.extend_from_slice(&channel.to_le_bytes());
        }
    }
    create_device_blob(data)
}

/// The LUT the CRTC output passes through: red, green and blue entries in
/// that order, or `None` when `GAMMA_LUT` is absent.
pub fn effective_gamma_lut() -> Option<alloc::vec::Vec<u16>> {
    let data = blob(gamma_lut_blob())?;
    let entry = |i: usize, c: usize| {
        let at = i * COLOR_LUT_ENTRY_BYTES + c * 2;
        u16::from_le_bytes([data[at], data[at + 1]])
    };
    let n = GAMMA_SIZE as usize;
    Some((0..3).flat_map(|c| (0..n).map(move |i| entry(i, c))).collect())
}

/// One `drm_master.magic_map` entry: the master object the token was issued
/// under, and the file it authenticates until `AUTH_MAGIC` consumes it.
struct MagicEntry {
    master_object: crate::lock::OfdId,
    pending: bool,
}

/// `drm_getmagic` for a file that has no token yet: a fresh nonzero token in
/// the magic map of the master object the file belongs to. Magic 0 is never
/// issued, which is how libdrm's `drmIsMaster` probes for master.
pub fn issue_magic(master_object: crate::lock::OfdId) -> Result<u32, Errno> {
    let device = dev();
    let magic = device.next_magic;
    device.next_magic = magic.checked_add(1).ok_or(Errno::ENOSPC)?;
    device.magics.insert(magic, MagicEntry { master_object, pending: true });
    Ok(magic)
}

/// `drm_authmagic`: the token must be in the caller's master object's map
/// and not yet consumed; authenticating consumes it (a second attempt, a
/// token from a closed file, or one issued under another master object is
/// EINVAL).
pub fn authenticate_magic(master_object: crate::lock::OfdId, magic: u32) -> Result<(), Errno> {
    match dev().magics.get_mut(&magic) {
        Some(entry) if entry.master_object == master_object && entry.pending => {
            entry.pending = false;
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

/// The file's last close removes its token from the map.
pub fn release_magic(magic: u32) {
    if magic != 0 {
        dev().magics.remove(&magic);
    }
}

/// A fresh id in the one mode-object id space (framebuffers, blobs).
pub fn allocate_fb_id() -> Result<u32, Errno> {
    let device = dev();
    let id = device.next_object_id;
    device.next_object_id = id.checked_add(1).ok_or(Errno::ENOMEM)?;
    Ok(id)
}

/// The primary plane's source origin in whole pixels: the CRTC's panning
/// offset that `GETCRTC` reports (`primary->state->src_x >> 16`).
pub fn crtc_offset() -> (u32, u32) {
    let geometry = dev().primary.geometry;
    (geometry.src_x >> 16, geometry.src_y >> 16)
}

pub fn flip_pending() -> bool {
    dev().pending_commit.is_some()
}

/// The vblank that follows a commit completes it. Returns whether one was
/// pending, so the vblank can wake callers parked on it.
pub fn complete_pending_flip() -> bool {
    dev().pending_commit.take().is_some()
}

/// Whether the CRTC is lit: it has a mode and is `ACTIVE`. Linux's vblank
/// counter (and `DRM_IOCTL_WAIT_VBLANK`) runs only then.
pub fn crtc_active() -> bool {
    let crtc = dev().crtc;
    crtc.active && crtc.mode.is_some()
}

pub fn vblank_off_generation() -> u32 {
    dev().vblank_off_generation
}

/// Record a `drm_crtc_vblank_off` if the CRTC was lit and no longer is.
pub(crate) fn note_vblank_transition(was_active: bool) {
    if was_active && !crtc_active() {
        dev().vblank_off_generation = dev().vblank_off_generation.wrapping_add(1);
    }
}

pub fn crtc_fb() -> u32 {
    dev().primary.fb_id
}

pub fn crtc_mode() -> Option<WpkDrmModeModeinfo> {
    dev().crtc.mode
}

/// Test fixture: put `fb_id` on the primary plane without a commit.
#[cfg(test)]
pub fn set_crtc_fb(fb_id: u32) {
    dev().primary.fb_id = fb_id;
}

/// Test fixture: light the CRTC with `mode` without a commit.
#[cfg(test)]
pub fn set_crtc_mode(mode: Option<WpkDrmModeModeinfo>) {
    let device = dev();
    device.crtc.mode = mode;
    device.crtc.active = mode.is_some();
    device.connector_crtc = mode.is_some();
}

pub fn cursor_plane() -> Option<CursorPlaneState> {
    dev().cursor.clone()
}

pub fn set_cursor_plane(state: CursorPlaneState) {
    dev().cursor = Some(state);
}

/// The cursor the CRTC shows: the plane's framebuffer and position while
/// the CRTC is lit, otherwise none (a dark CRTC scans out nothing).
pub fn presented_cursor() -> (u32, i32, i32) {
    let state = dev().cursor.clone().unwrap_or_default();
    if crtc_active() { (state.fb_id, state.x, state.y) } else { (0, state.x, state.y) }
}

#[cfg(test)]
pub fn clear_cursor_plane_for_test() {
    dev().cursor = None;
}

/// Largest property blob a file may create. Linux bounds a blob only by
/// INT_MAX and allocation; the kernel heap here is far smaller, so a larger
/// request fails as an allocation does (ENOMEM).
pub const MAX_BLOB_BYTES: usize = 1 << 20;

/// A property blob: user-created ones belong to the creating file
/// (`owner`); kernel-created ones (a legacy gamma LUT or mode, the EDID) to
/// the device. Each state that uses a blob (`MODE_ID`, `GAMMA_LUT`,
/// `FB_DAMAGE_CLIPS`) holds a reference, so a used blob stays alive after
/// its creator destroys it or closes, as Linux's state holds a blob
/// reference.
struct BlobEntry {
    owner: Option<crate::lock::OfdId>,
    data: alloc::rc::Rc<[u8]>,
    holds: u32,
    /// A device blob the device itself keeps (the EDID), freed only when
    /// replaced.
    pinned: bool,
}

/// Blob ids come from the one mode-object id space.
pub fn create_blob(owner: crate::lock::OfdId, data: alloc::vec::Vec<u8>) -> Result<u32, Errno> {
    let id = allocate_fb_id()?;
    dev().blobs.insert(id, BlobEntry { owner: Some(owner), data: data.into(), holds: 0, pinned: false });
    Ok(id)
}

/// A blob the kernel creates for a state it commits (a legacy mode or
/// gamma LUT). It lives while a state holds it.
pub fn create_device_blob(data: alloc::vec::Vec<u8>) -> Result<u32, Errno> {
    let id = allocate_fb_id()?;
    dev().blobs.insert(id, BlobEntry { owner: None, data: data.into(), holds: 0, pinned: false });
    Ok(id)
}

pub fn blob(id: u32) -> Option<alloc::rc::Rc<[u8]>> {
    dev().blobs.get(&id).map(|entry| entry.data.clone())
}

/// The length of a blob, without cloning its handle.
pub fn blob_len(id: u32) -> Option<usize> {
    dev().blobs.get(&id).map(|entry| entry.data.len())
}

/// A state took a reference on blob `id` (0 = none).
pub(crate) fn hold_blob(id: u32) {
    if id != 0 {
        let entry = dev().blobs.get_mut(&id).expect("a committed state holds a live blob");
        entry.holds += 1;
    }
}

/// A state dropped its reference on blob `id` (0 = none); an unowned,
/// unpinned blob is freed with its last reference.
pub(crate) fn release_blob(id: u32) {
    if id == 0 {
        return;
    }
    let blobs = &mut dev().blobs;
    let entry = blobs.get_mut(&id).expect("a committed state held a live blob");
    entry.holds = entry.holds.checked_sub(1).expect("blob reference count underflow");
    if entry.holds == 0 && entry.owner.is_none() && !entry.pinned {
        blobs.remove(&id);
    }
}

/// Free a device blob created for a commit that failed its check.
pub(crate) fn discard_unused_blob(id: u32) {
    let blobs = &mut dev().blobs;
    if blobs.get(&id).is_some_and(|entry| entry.holds == 0 && entry.owner.is_none() && !entry.pinned) {
        blobs.remove(&id);
    }
}

/// Drop the creator's ownership; a blob a state still uses stays readable.
fn disown_blob(blobs: &mut BTreeMap<u32, BlobEntry>, id: u32) {
    let keep = blobs.get(&id).is_some_and(|entry| entry.holds != 0 || entry.pinned);
    if keep {
        if let Some(entry) = blobs.get_mut(&id) {
            entry.owner = None;
        }
    } else {
        blobs.remove(&id);
    }
}

pub fn destroy_blob(id: u32, owner: crate::lock::OfdId) -> Result<(), Errno> {
    let blobs = &mut dev().blobs;
    match blobs.get(&id) {
        None => Err(Errno::EINVAL),
        Some(entry) if entry.owner != Some(owner) => Err(Errno::EPERM),
        Some(_) => {
            disown_blob(blobs, id);
            Ok(())
        }
    }
}

/// The DRM file's last close frees the blobs it created.
pub fn release_blobs(owner: crate::lock::OfdId) {
    let blobs = &mut dev().blobs;
    let owned: alloc::vec::Vec<u32> = blobs.iter()
        .filter(|(_, entry)| entry.owner == Some(owner)).map(|(&id, _)| id).collect();
    for id in owned {
        disown_blob(blobs, id);
    }
}

/// An fb that `CLOSEFB` dropped while the CRTC scanned it out. Linux keeps
/// such an fb alive on the plane until the next modeset or flip.
pub struct ClosedScanout {
    pub pid: i32,
    pub fb_id: u32,
    pub fb: crate::ofd::KmsFb,
}

pub fn replace_closed_scanout(closed: Option<ClosedScanout>) -> Option<ClosedScanout> {
    core::mem::replace(&mut dev().closed_scanout, closed)
}

pub fn register_framebuffer(id: u32, owner: crate::ofd::WeakKmsFbs) {
    assert!(dev().framebuffers.insert(id, owner).is_none());
}

pub fn unregister_framebuffer(id: u32) {
    dev().framebuffers.remove(&id);
}

/// GETFB uses device-wide identity, while RMFB/CLOSEFB still require a
/// reference in the caller's file table (drm_framebuffer.c:drm_mode_closefb).
pub fn framebuffer(id: u32) -> Option<crate::ofd::KmsFb> {
    if id == 0 {
        return None;
    }
    let device = dev();
    if let Some(fb) = device.framebuffers.get(&id).and_then(|owner| owner.lookup(id)) {
        return Some(fb);
    }
    if let Some(state) = device.cursor.as_ref().filter(|state| state.fb_id == id) {
        return state.fb;
    }
    device.closed_scanout.as_ref()
        .filter(|closed| closed.fb_id == id).map(|closed| closed.fb)
}

/// `atomic_remove_fb` for the primary plane: removing the framebuffer the
/// CRTC scans out turns the CRTC off and disables the plane (Linux
/// disables a CRTC whose primary plane loses its framebuffer). The commit
/// has no host effects to publish: the caller removes the framebuffer from
/// the host, which then has nothing to scan.
pub fn disable_crtc_scanning(fb_id: u32) {
    let device = dev();
    if device.primary.fb_id != fb_id {
        return;
    }
    let was_active = crtc_active();
    let device = dev();
    release_blob(device.crtc.mode_blob);
    release_blob(device.primary.damage_blob);
    let device = dev();
    device.crtc.mode = None;
    device.crtc.mode_blob = 0;
    device.crtc.active = false;
    device.connector_crtc = false;
    device.dpms = DRM_MODE_DPMS_OFF;
    device.primary = PrimaryPlaneState::default();
    device.pending_commit = None;
    note_vblank_transition(was_active);
}

#[cfg(test)]
pub fn reset_for_test() {
    // The off generation only grows: a wait recorded before the reset must
    // still see later CRTC-off transitions as later.
    let generation = dev().vblank_off_generation;
    *dev() = KmsDevice::new();
    dev().vblank_off_generation = generation;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_ids_are_unique_across_types() {
        let _master = super::super::master::lock_for_test();
        let ids = [CRTC_ID, ENCODER_ID, CONNECTOR_ID, PRIMARY_PLANE_ID, CURSOR_PLANE_ID];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
            assert!(property(*a).is_none());
        }
        for prop in &PROPERTIES {
            assert!(prop.id < FIRST_DYNAMIC_ID);
            assert_eq!(object_type(prop.id), Some(DRM_MODE_OBJECT_PROPERTY), "{}", prop.name);
        }
    }

    #[test]
    fn find_object_checks_the_type() {
        let _master = super::super::master::lock_for_test();
        assert_eq!(find_object(CONNECTOR_ID, DRM_MODE_OBJECT_ANY), Ok(DRM_MODE_OBJECT_CONNECTOR));
        assert_eq!(find_object(CONNECTOR_ID, DRM_MODE_OBJECT_CRTC), Err(Errno::ENOENT));
        assert_eq!(find_object(99, DRM_MODE_OBJECT_ANY), Err(Errno::ENOENT));
    }

    #[test]
    fn encoders_carry_no_properties() {
        let _master = super::super::master::lock_for_test();
        assert_eq!(object_properties(ENCODER_ID, DRM_MODE_OBJECT_ANY), Err(Errno::EINVAL));
        let crtc = object_properties(CRTC_ID, DRM_MODE_OBJECT_CRTC).unwrap();
        assert_eq!(listed_properties(crtc, false), &[PROP_GAMMA_LUT, PROP_GAMMA_LUT_SIZE][..]);
    }

    /// kms_properties' "get_properties-sanity" for atomic clients: every
    /// atomic property is listed only to an atomic file, and each object
    /// carries the standard atomic set.
    #[test]
    fn atomic_properties_are_listed_only_to_atomic_files() {
        let _master = super::super::master::lock_for_test();
        for (obj, ty, names) in [
            (PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE, &["FB_ID", "CRTC_ID", "SRC_X", "SRC_Y",
                "SRC_W", "SRC_H", "CRTC_X", "CRTC_Y", "CRTC_W", "CRTC_H", "IN_FENCE_FD",
                "FB_DAMAGE_CLIPS"][..]),
            (CRTC_ID, DRM_MODE_OBJECT_CRTC, &["ACTIVE", "MODE_ID", "OUT_FENCE_PTR"][..]),
            (CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR, &["CRTC_ID"][..]),
        ] {
            let all = object_properties(obj, ty).unwrap();
            let legacy = listed_properties(all, false);
            for name in names {
                let id = all.iter().copied().find(|&id| property(id).unwrap().name == *name)
                    .unwrap_or_else(|| panic!("{name} missing on {obj}"));
                assert!(!legacy.contains(&id), "{name} listed to a legacy file");
                assert_ne!(property(id).unwrap().flags() & DRM_MODE_PROP_ATOMIC, 0);
            }
            assert!(!all.iter().any(|&id| property(id).unwrap().name == "IN_FORMATS"),
                "no IN_FORMATS: no format modifiers are advertised (D-15)");
        }
    }

    #[test]
    fn property_validity_follows_drm_property_change_valid_get() {
        let _master = super::super::master::lock_for_test();
        reset_for_test();
        let crtc_id = property(PROP_CRTC_ID).unwrap();
        assert!(crtc_id.accepts(0));
        assert!(crtc_id.accepts(u64::from(CRTC_ID)));
        assert!(!crtc_id.accepts(u64::from(PRIMARY_PLANE_ID)));
        assert!(!crtc_id.accepts(u64::from(CONNECTOR_ID)));
        let fence = property(PROP_IN_FENCE_FD).unwrap();
        assert!(fence.accepts(-1i64 as u64));
        assert!(!fence.accepts(-2i64 as u64));
        assert!(!property(PROP_GAMMA_LUT_SIZE).unwrap().accepts(256));
        assert!(!property(PROP_MODE_ID).unwrap().accepts(u64::from(CRTC_ID)));
        assert!(!property(PROP_ACTIVE).unwrap().accepts(2));
    }
}
