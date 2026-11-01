//! Mode objects and properties of the one virtual display.
//!
//! Linux allocates CRTCs, encoders, connectors, planes and properties from
//! one id space, and clients such as wlroots read a property with
//! `DRM_MODE_OBJECT_ANY`, so no two objects here share an id. The card
//! offers the legacy (non-atomic) interface: properties Linux marks
//! atomic-only are not listed.
//!
//! All mutable display state lives in one [`KmsDevice`], the counterpart of
//! Linux's `drm_device` mode-config state: the CRTC, its planes and
//! connector, the property blobs, the framebuffer index and the magic map.
//! It is confined to the kernel syscall executor, just like the master and
//! BO registries.

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
/// Entries of the CRTC's legacy gamma ramp and of `GAMMA_LUT`
/// (`crtc->gamma_size`): 256, as common 8-bit legacy drivers report.
pub const GAMMA_SIZE: u32 = 256;
/// Bytes of one `struct drm_color_lut` (red, green, blue, reserved).
pub const COLOR_LUT_ENTRY_BYTES: usize = 8;
pub const CURSOR_PLANE_FORMATS: [u32; 1] = [DRM_FORMAT_ARGB8888];

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

const PROPERTIES: [Property; 7] = [
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
    Property { id: PROP_GAMMA_LUT, name: "GAMMA_LUT", immutable: false, kind: PropertyKind::Blob },
    Property {
        id: PROP_GAMMA_LUT_SIZE,
        name: "GAMMA_LUT_SIZE",
        immutable: true,
        kind: PropertyKind::Range(0, u32::MAX as u64),
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
        PRIMARY_PLANE_ID | CURSOR_PLANE_ID => Some(DRM_MODE_OBJECT_PLANE),
        PROP_PLANE_TYPE..=PROP_NON_DESKTOP | PROP_GAMMA_LUT | PROP_GAMMA_LUT_SIZE => {
            Some(DRM_MODE_OBJECT_PROPERTY)
        }
        _ if framebuffer(id).is_some() => Some(DRM_MODE_OBJECT_FB),
        _ if blob(id).is_some() => Some(DRM_MODE_OBJECT_BLOB),
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
        DRM_MODE_OBJECT_CRTC => Ok(&[PROP_GAMMA_LUT, PROP_GAMMA_LUT_SIZE]),
        _ => Err(Errno::EINVAL),
    }
}

/// The one display's mutable state. Every field was a separate static
/// before; one struct keeps a modeset's parts (mode, framebuffer, offset,
/// DPMS, planes, blobs) in one place so a commit can stage and replace them
/// together.
pub struct KmsDevice {
    dpms: u64,
    /// The legacy gamma ramp (`crtc->gamma_store`): red, green and blue,
    /// GAMMA_SIZE entries each, or `None` for the identity ramp `i << 8`
    /// (`drm_mode_crtc_set_gamma_size`). It changes only through SETGAMMA,
    /// as on Linux; GETGAMMA reports it.
    gamma_store: Option<[[u16; GAMMA_SIZE as usize]; 3]>,
    /// The `GAMMA_LUT` property: the blob the CRTC output passes through,
    /// or 0 when the LUT is absent (colors pass through unchanged).
    gamma_lut_blob: u32,
    next_magic: u32,
    magics: BTreeMap<u32, MagicEntry>,
    /// Framebuffers, blobs and kernel-owned objects share the one mode-object
    /// id space, so their ids start after the fixed objects and are unique
    /// across open files.
    next_object_id: u32,
    crtc_fb: u32,
    /// The CRTC's panning offset (`drm_mode_crtc.x`/`y`).
    crtc_offset: (u32, u32),
    /// A page flip latched on the CRTC that its next vblank has not
    /// completed. Linux tracks this per CRTC (the pending commit), not per
    /// file: a second flip before that vblank fails with EBUSY whichever
    /// file queued the first.
    flip_pending: bool,
    crtc_mode: Option<WpkDrmModeModeinfo>,
    /// Counts `drm_crtc_vblank_off` transitions. Linux sends every queued
    /// vblank event prematurely and wakes every waiter (which then
    /// succeeds) when the CRTC turns off; waits and events record the
    /// generation they started in, so a later generation means "the CRTC
    /// turned off since".
    vblank_off_generation: u32,
    cursor: Option<CursorPlaneState>,
    blobs: BTreeMap<u32, BlobEntry>,
    closed_scanout: Option<ClosedScanout>,
    framebuffers: BTreeMap<u32, crate::ofd::WeakKmsFbs>,
}

impl KmsDevice {
    const fn new() -> Self {
        Self {
            dpms: DRM_MODE_DPMS_ON,
            gamma_store: None,
            gamma_lut_blob: 0,
            next_magic: 1,
            magics: BTreeMap::new(),
            next_object_id: PROP_GAMMA_LUT_SIZE + 1,
            crtc_fb: 0,
            crtc_offset: (0, 0),
            flip_pending: false,
            crtc_mode: None,
            vblank_off_generation: 0,
            cursor: None,
            blobs: BTreeMap::new(),
            closed_scanout: None,
            framebuffers: BTreeMap::new(),
        }
    }
}

struct GlobalDevice(UnsafeCell<KmsDevice>);
unsafe impl Sync for GlobalDevice {}
static DEVICE: GlobalDevice = GlobalDevice(UnsafeCell::new(KmsDevice::new()));

/// The device state. The kernel executor is single-threaded and no caller
/// keeps the reference across another call into this module.
fn dev() -> &'static mut KmsDevice {
    unsafe { &mut *DEVICE.0.get() }
}

pub fn property_value(prop_id: u32) -> u64 {
    match prop_id {
        PROP_PLANE_TYPE => DRM_PLANE_TYPE_PRIMARY,
        PROP_DPMS => dev().dpms,
        PROP_LINK_STATUS => DRM_MODE_LINK_STATUS_GOOD,
        PROP_GAMMA_LUT => u64::from(gamma_lut_blob()),
        PROP_GAMMA_LUT_SIZE => u64::from(GAMMA_SIZE),
        _ => 0,
    }
}

pub fn object_property_value(obj_id: u32, prop_id: u32) -> u64 {
    if obj_id == CURSOR_PLANE_ID && prop_id == PROP_PLANE_TYPE {
        DRM_PLANE_TYPE_CURSOR
    } else {
        property_value(prop_id)
    }
}

/// What a property change asks the caller to publish to the host.
#[derive(Debug, PartialEq, Eq)]
pub enum PropertyEffect {
    None,
    /// The CRTC's effective gamma LUT changed.
    Gamma,
}

/// Set a property through the legacy interface. DPMS and the CRTC's
/// `GAMMA_LUT` are mutable there; a value outside the enum, an immutable
/// property, or a property the object does not carry fails with `EINVAL`.
pub fn set_property(obj_id: u32, obj_type: u32, prop_id: u32, value: u64) -> Result<PropertyEffect, Errno> {
    let props = object_properties(obj_id, obj_type)?;
    if !props.contains(&prop_id) {
        return Err(Errno::EINVAL);
    }
    if prop_id == PROP_GAMMA_LUT {
        // drm_atomic_replace_property_blob_from_id: 0 clears the LUT (the
        // CRTC passes colors through); otherwise the blob must exist and
        // hold exactly GAMMA_SIZE drm_color_lut entries.
        let id = u32::try_from(value).map_err(|_| Errno::EINVAL)?;
        if id != 0 && blob(id).is_none_or(|data| data.len() != GAMMA_SIZE as usize * COLOR_LUT_ENTRY_BYTES) {
            return Err(Errno::EINVAL);
        }
        set_gamma_lut_blob(id);
        return Ok(PropertyEffect::Gamma);
    }
    let prop = property(prop_id).ok_or(Errno::EINVAL)?;
    let PropertyKind::Enum(entries) = prop.kind else {
        return Err(Errno::EINVAL);
    };
    if prop_id != PROP_DPMS || !entries.iter().any(|&(v, _)| v == value) {
        return Err(Errno::EINVAL);
    }
    let was_active = crtc_active();
    dev().dpms = value;
    note_vblank_transition(was_active);
    Ok(PropertyEffect::None)
}

fn identity_ramp() -> [[u16; GAMMA_SIZE as usize]; 3] {
    let ramp: [u16; GAMMA_SIZE as usize] = core::array::from_fn(|i| (i as u16) << 8);
    [ramp; 3]
}

pub fn gamma_store() -> [[u16; GAMMA_SIZE as usize]; 3] {
    dev().gamma_store.unwrap_or_else(identity_ramp)
}

pub fn gamma_lut_blob() -> u32 {
    dev().gamma_lut_blob
}

/// Point `GAMMA_LUT` at `id`, holding that blob for the CRTC and releasing
/// the previous one (an unowned device blob is freed with its last use).
fn set_gamma_lut_blob(id: u32) {
    let device = dev();
    let blobs = &mut device.blobs;
    if let Some(entry) = blobs.get_mut(&id) {
        entry.held = true;
    }
    let previous = core::mem::replace(&mut device.gamma_lut_blob, id);
    if previous != 0 && previous != id {
        if let Some(entry) = blobs.get_mut(&previous) {
            entry.held = false;
            if entry.owner.is_none() {
                blobs.remove(&previous);
            }
        }
    }
}

/// `drm_mode_gamma_set_ioctl` copies each channel straight into
/// `gamma_store`, so a fault on a later channel leaves the earlier ones
/// stored (and the LUT the CRTC uses unchanged).
pub fn store_gamma_channel(channel: usize, values: [u16; GAMMA_SIZE as usize]) {
    let mut store = gamma_store();
    store[channel] = values;
    dev().gamma_store = Some(store);
}

/// `drm_atomic_helper_legacy_gamma_set`: make `GAMMA_LUT` a new
/// device-owned blob holding the stored ramp.
pub fn commit_legacy_gamma() -> Result<(), Errno> {
    let ramp = gamma_store();
    let mut data = alloc::vec::Vec::with_capacity(GAMMA_SIZE as usize * COLOR_LUT_ENTRY_BYTES);
    for i in 0..GAMMA_SIZE as usize {
        for channel in ramp.iter().map(|c| c[i]).chain([0]) {
            data.extend_from_slice(&channel.to_le_bytes());
        }
    }
    let id = allocate_fb_id()?;
    dev().blobs.insert(id, BlobEntry { owner: None, data: data.into(), held: false });
    set_gamma_lut_blob(id);
    Ok(())
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

/// Both coordinates fit in 16 bits: SETCRTC rejects larger ones (ERANGE).
pub fn set_crtc_offset((x, y): (u32, u32)) {
    debug_assert!(x <= 0xffff && y <= 0xffff);
    dev().crtc_offset = (x, y);
}

pub fn crtc_offset() -> (u32, u32) {
    dev().crtc_offset
}

pub fn flip_pending() -> bool {
    dev().flip_pending
}

pub fn set_flip_pending() {
    dev().flip_pending = true;
}

/// The vblank that follows a flip completes it.
pub fn complete_pending_flip() {
    dev().flip_pending = false;
}

/// Record what `SETCRTC` or `PAGE_FLIP` put on the CRTC, so `GETCRTC`
/// and `GETPLANE` report the scanout state.
pub fn set_crtc_fb(fb_id: u32) {
    dev().crtc_fb = fb_id;
}

pub fn set_crtc_mode(mode: Option<WpkDrmModeModeinfo>) {
    let was_active = crtc_active();
    dev().crtc_mode = mode;
    note_vblank_transition(was_active);
}

/// Whether the CRTC is lit: it has a mode and its connector's DPMS is On.
/// Linux's vblank counter (and `DRM_IOCTL_WAIT_VBLANK`) runs only then.
pub fn crtc_active() -> bool {
    crtc_mode().is_some() && dev().dpms == DRM_MODE_DPMS_ON
}

pub fn vblank_off_generation() -> u32 {
    dev().vblank_off_generation
}

fn note_vblank_transition(was_active: bool) {
    if was_active && !crtc_active() {
        dev().vblank_off_generation = dev().vblank_off_generation.wrapping_add(1);
    }
}

pub fn crtc_fb() -> u32 {
    dev().crtc_fb
}

pub fn crtc_mode() -> Option<WpkDrmModeModeinfo> {
    dev().crtc_mode
}

/// The cursor plane's state: its framebuffer, position and hotspot.
///
/// Like Linux's plane state this is device state, not master state: a
/// master change neither hides nor clears it, and the next master sees and
/// inherits it until it changes it. The plane owns one reference on the
/// scanned BO (`bo`), so the image stays alive while it is the cursor even
/// after the file that installed it closes. An internally allocated legacy
/// cursor framebuffer has a real identity but no user file-table entry.
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
}

pub fn cursor_plane() -> Option<CursorPlaneState> {
    dev().cursor.clone()
}

pub fn set_cursor_plane(state: CursorPlaneState) {
    dev().cursor = Some(state);
}

#[cfg(test)]
pub fn clear_cursor_plane_for_test() {
    dev().cursor = None;
}

/// Largest property blob a file may create. Linux bounds a blob only by
/// INT_MAX and allocation; the kernel heap here is far smaller, so a larger
/// request fails as an allocation does (ENOMEM).
pub const MAX_BLOB_BYTES: usize = 1 << 20;

/// User-created property blobs (`CREATEPROPBLOB`), keyed by object id and
/// owned by the creating DRM file.
/// A property blob: user-created ones belong to the creating file
/// (`owner`); kernel-created ones (a legacy gamma LUT) to the device. A
/// blob the CRTC uses (`held`) stays alive after its creator destroys it or
/// closes, as Linux's CRTC state holds a blob reference.
struct BlobEntry {
    owner: Option<crate::lock::OfdId>,
    data: alloc::rc::Rc<[u8]>,
    held: bool,
}

/// Blob ids come from the one mode-object id space.
pub fn create_blob(owner: crate::lock::OfdId, data: alloc::vec::Vec<u8>) -> Result<u32, Errno> {
    let id = allocate_fb_id()?;
    dev().blobs.insert(id, BlobEntry { owner: Some(owner), data: data.into(), held: false });
    Ok(id)
}

pub fn blob(id: u32) -> Option<alloc::rc::Rc<[u8]>> {
    dev().blobs.get(&id).map(|entry| entry.data.clone())
}

/// Drop the creator's hold; a blob the CRTC still uses stays readable.
fn disown_blob(blobs: &mut BTreeMap<u32, BlobEntry>, id: u32) {
    let held = blobs.get(&id).is_some_and(|entry| entry.held);
    if held {
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
    if let Some(fb) = dev().framebuffers.get(&id).and_then(|owner| owner.lookup(id)) {
        return Some(fb);
    }
    if let Some(state) = cursor_plane().filter(|state| state.fb_id == id) {
        return state.fb;
    }
    dev().closed_scanout.as_ref()
        .filter(|closed| closed.fb_id == id).map(|closed| closed.fb)
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
        assert_eq!(object_properties(CRTC_ID, DRM_MODE_OBJECT_CRTC),
            Ok(&[PROP_GAMMA_LUT, PROP_GAMMA_LUT_SIZE][..]));
    }

    #[test]
    fn only_dpms_is_settable_and_only_to_an_enum_value() {
        let _master = super::super::master::lock_for_test();
        reset_for_test();
        assert_eq!(
            set_property(CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR, PROP_DPMS, DRM_MODE_DPMS_OFF),
            Ok(PropertyEffect::None)
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
