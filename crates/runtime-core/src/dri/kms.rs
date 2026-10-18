//! Mode objects and properties of the one virtual display.
//!
//! Linux allocates CRTCs, encoders, connectors, planes and properties from
//! one id space, and clients such as wlroots read a property with
//! `DRM_MODE_OBJECT_ANY`, so no two objects here share an id. The card
//! offers the legacy (non-atomic) interface: properties Linux marks
//! atomic-only are not listed.

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

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

/// The pixel formats `DRM_IOCTL_MODE_ADDFB2` accepts for scanout.
pub const PRIMARY_PLANE_FORMATS: [u32; 3] =
    [DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888, DRM_FORMAT_RGB565];

pub enum PropertyKind {
    Enum(&'static [(u64, &'static str)]),
    Range(u64, u64),
    Blob,
}

pub struct Property {
    pub id: u32,
    pub name: &'static str,
    pub immutable: bool,
    pub kind: PropertyKind,
}

impl Property {
    pub fn flags(&self) -> u32 {
        let kind = match self.kind {
            PropertyKind::Enum(_) => DRM_MODE_PROP_ENUM,
            PropertyKind::Range(..) => DRM_MODE_PROP_RANGE,
            PropertyKind::Blob => DRM_MODE_PROP_BLOB,
        };
        if self.immutable { kind | DRM_MODE_PROP_IMMUTABLE } else { kind }
    }

    /// The `values` array `DRM_IOCTL_MODE_GETPROPERTY` reports: the enum
    /// values, the range bounds, or nothing for a blob.
    pub fn values(&self) -> alloc::vec::Vec<u64> {
        match self.kind {
            PropertyKind::Enum(entries) => entries.iter().map(|&(value, _)| value).collect(),
            PropertyKind::Range(min, max) => alloc::vec![min, max],
            PropertyKind::Blob => alloc::vec::Vec::new(),
        }
    }
}

const PROPERTIES: [Property; 5] = [
    Property {
        id: PROP_PLANE_TYPE,
        name: "type",
        immutable: true,
        kind: PropertyKind::Enum(&[
            (DRM_PLANE_TYPE_OVERLAY, "Overlay"),
            (DRM_PLANE_TYPE_PRIMARY, "Primary"),
            (DRM_PLANE_TYPE_CURSOR, "Cursor"),
        ]),
    },
    Property { id: PROP_EDID, name: "EDID", immutable: true, kind: PropertyKind::Blob },
    Property {
        id: PROP_DPMS,
        name: "DPMS",
        immutable: false,
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
        kind: PropertyKind::Enum(&[
            (DRM_MODE_LINK_STATUS_GOOD, "Good"),
            (DRM_MODE_LINK_STATUS_BAD, "Bad"),
        ]),
    },
    Property {
        id: PROP_NON_DESKTOP,
        name: "non-desktop",
        immutable: true,
        kind: PropertyKind::Range(0, 1),
    },
];

pub fn property(id: u32) -> Option<&'static Property> {
    PROPERTIES.iter().find(|p| p.id == id)
}

/// The `DRM_MODE_OBJECT_*` type of a mode object id.
pub fn object_type(id: u32) -> Option<u32> {
    match id {
        CRTC_ID => Some(DRM_MODE_OBJECT_CRTC),
        ENCODER_ID => Some(DRM_MODE_OBJECT_ENCODER),
        CONNECTOR_ID => Some(DRM_MODE_OBJECT_CONNECTOR),
        PRIMARY_PLANE_ID => Some(DRM_MODE_OBJECT_PLANE),
        PROP_PLANE_TYPE..=PROP_NON_DESKTOP => Some(DRM_MODE_OBJECT_PROPERTY),
        _ => None,
    }
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

/// The properties attached to an object, or `EINVAL` for an object type
/// that carries none (encoders, properties), as Linux reports.
pub fn object_properties(obj_id: u32, obj_type: u32) -> Result<&'static [u32], Errno> {
    match find_object(obj_id, obj_type)? {
        DRM_MODE_OBJECT_PLANE => Ok(&[PROP_PLANE_TYPE]),
        DRM_MODE_OBJECT_CONNECTOR => {
            Ok(&[PROP_EDID, PROP_DPMS, PROP_LINK_STATUS, PROP_NON_DESKTOP])
        }
        DRM_MODE_OBJECT_CRTC => Ok(&[]),
        _ => Err(Errno::EINVAL),
    }
}

static DPMS: AtomicU64 = AtomicU64::new(DRM_MODE_DPMS_ON);

pub fn property_value(prop_id: u32) -> u64 {
    match prop_id {
        PROP_PLANE_TYPE => DRM_PLANE_TYPE_PRIMARY,
        PROP_DPMS => DPMS.load(Ordering::Relaxed),
        PROP_LINK_STATUS => DRM_MODE_LINK_STATUS_GOOD,
        _ => 0,
    }
}

/// Set a property through the legacy interface. Only DPMS is mutable
/// there; a value outside the enum, an immutable property, or a
/// property the object does not carry fails with `EINVAL`.
pub fn set_property(obj_id: u32, obj_type: u32, prop_id: u32, value: u64) -> Result<(), Errno> {
    let props = object_properties(obj_id, obj_type)?;
    if !props.contains(&prop_id) {
        return Err(Errno::EINVAL);
    }
    let prop = property(prop_id).ok_or(Errno::EINVAL)?;
    let PropertyKind::Enum(entries) = prop.kind else {
        return Err(Errno::EINVAL);
    };
    if prop_id != PROP_DPMS || !entries.iter().any(|&(v, _)| v == value) {
        return Err(Errno::EINVAL);
    }
    DPMS.store(value, Ordering::Relaxed);
    Ok(())
}

static NEXT_MAGIC: AtomicU32 = AtomicU32::new(1);

/// Issue a fresh authentication token, as `drm_getmagic` does for a file
/// that has none yet. Tokens are never reused.
pub fn issue_magic() -> u32 {
    NEXT_MAGIC.fetch_add(1, Ordering::Relaxed)
}

/// Whether `magic` names a token issued to an open file. Magic 0 is never
/// issued, which is how libdrm's `drmIsMaster` probes for master.
pub fn magic_was_issued(magic: u32) -> bool {
    magic != 0 && magic < NEXT_MAGIC.load(Ordering::Relaxed)
}

/// Framebuffers share the one mode-object id space, so their ids start
/// after the fixed objects and are unique across open files.
static NEXT_FB_ID: AtomicU32 = AtomicU32::new(PROP_NON_DESKTOP + 1);

pub fn allocate_fb_id() -> Result<u32, Errno> {
    NEXT_FB_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| Errno::ENOMEM)
}

static CRTC_FB: AtomicU32 = AtomicU32::new(0);

struct GlobalMode(UnsafeCell<Option<WpkDrmModeModeinfo>>);

unsafe impl Sync for GlobalMode {}

static CRTC_MODE: GlobalMode = GlobalMode(UnsafeCell::new(None));

/// Record what `SETCRTC` or `PAGE_FLIP` put on the CRTC, so `GETCRTC`
/// and `GETPLANE` report the scanout state.
pub fn set_crtc_fb(fb_id: u32) {
    CRTC_FB.store(fb_id, Ordering::Relaxed);
}

pub fn set_crtc_mode(mode: Option<WpkDrmModeModeinfo>) {
    unsafe { *CRTC_MODE.0.get() = mode };
}

pub fn crtc_fb() -> u32 {
    CRTC_FB.load(Ordering::Relaxed)
}

pub fn crtc_mode() -> Option<WpkDrmModeModeinfo> {
    unsafe { *CRTC_MODE.0.get() }
}

/// An fb that `CLOSEFB` dropped while the CRTC scanned it out. Linux keeps
/// such an fb alive on the plane until the next modeset or flip.
pub struct ClosedScanout {
    pub pid: i32,
    pub fb_id: u32,
    pub bo_id: crate::dri::BoId,
}

struct GlobalClosedScanout(UnsafeCell<Option<ClosedScanout>>);

unsafe impl Sync for GlobalClosedScanout {}

static CLOSED_SCANOUT: GlobalClosedScanout = GlobalClosedScanout(UnsafeCell::new(None));

pub fn replace_closed_scanout(closed: Option<ClosedScanout>) -> Option<ClosedScanout> {
    unsafe { core::mem::replace(&mut *CLOSED_SCANOUT.0.get(), closed) }
}

#[cfg(test)]
pub fn reset_for_test() {
    DPMS.store(DRM_MODE_DPMS_ON, Ordering::Relaxed);
    NEXT_FB_ID.store(PROP_NON_DESKTOP + 1, Ordering::Relaxed);
    set_crtc_fb(0);
    set_crtc_mode(None);
    replace_closed_scanout(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_ids_are_unique_across_types() {
        let ids = [CRTC_ID, ENCODER_ID, CONNECTOR_ID, PRIMARY_PLANE_ID];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
            assert!(property(*a).is_none());
        }
    }

    #[test]
    fn find_object_checks_the_type() {
        assert_eq!(find_object(CONNECTOR_ID, DRM_MODE_OBJECT_ANY), Ok(DRM_MODE_OBJECT_CONNECTOR));
        assert_eq!(find_object(CONNECTOR_ID, DRM_MODE_OBJECT_CRTC), Err(Errno::ENOENT));
        assert_eq!(find_object(99, DRM_MODE_OBJECT_ANY), Err(Errno::ENOENT));
    }

    #[test]
    fn encoders_carry_no_properties() {
        assert_eq!(object_properties(ENCODER_ID, DRM_MODE_OBJECT_ANY), Err(Errno::EINVAL));
        assert_eq!(object_properties(CRTC_ID, DRM_MODE_OBJECT_CRTC), Ok(&[][..]));
    }

    #[test]
    fn only_dpms_is_settable_and_only_to_an_enum_value() {
        reset_for_test();
        assert_eq!(
            set_property(CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR, PROP_DPMS, DRM_MODE_DPMS_OFF),
            Ok(())
        );
        assert_eq!(property_value(PROP_DPMS), DRM_MODE_DPMS_OFF);
        assert_eq!(
            set_property(CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR, PROP_DPMS, 9),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            set_property(CONNECTOR_ID, DRM_MODE_OBJECT_ANY, PROP_NON_DESKTOP, 1),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            set_property(PRIMARY_PLANE_ID, DRM_MODE_OBJECT_PLANE, PROP_DPMS, DRM_MODE_DPMS_ON),
            Err(Errno::EINVAL)
        );
        reset_for_test();
    }
}
