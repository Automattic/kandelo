//! Atomic modesetting: one staged state, one check, one commit.
//!
//! Every change to the CRTC, its planes or its connector goes through here,
//! whether it comes from `DRM_IOCTL_MODE_ATOMIC` or from a legacy ioctl
//! (SETCRTC, PAGE_FLIP, SETPLANE, CURSOR, DPMS, SETGAMMA, OBJ_SETPROPERTY),
//! as on a Linux atomic driver where the legacy ioctls are helpers that
//! build an atomic state. A [`Commit`] starts as a copy of the committed
//! state, properties are staged into it in request order
//! (`drm_atomic_set_property`), [`Commit::check`] validates the whole
//! result (`drm_atomic_check_only`), and [`Commit::apply`] replaces the
//! device state and publishes the host effects. A check failure leaves the
//! device untouched; nothing after a successful check may fail, and an
//! internal failure there is a kernel fault (it panics), never a partial
//! commit.
//!
//! The virtual CRTC offers what its presenters can show exactly: a primary
//! plane that covers the whole CRTC unscaled, and a cursor plane that can be
//! positioned but not scaled or cropped. The DRM uAPI leaves the plane set
//! and each plane's limits to the driver, and Linux drivers with the same
//! limits refuse the same configurations with the same errors (`ERANGE` for
//! scaling, `EINVAL` for positioning a primary plane that must cover the
//! CRTC); see `drm_atomic_helper_check_plane_state`.
//!
//! WHY the hot path stays allocation-free: a compositor such as wlroots
//! issues one atomic commit per frame (and a TEST_ONLY commit to probe
//! direct scanout), so staging uses fixed-size copies of the state, the
//! request arrays are copied in bounded stack chunks, and blobs and the
//! connector's mode list are consulted only when the commit changes them.

use wasm_posix_shared::dri::*;
use wasm_posix_shared::Errno;

use super::kms::{self, CrtcState, PlaneGeometry};
use crate::ofd::KmsFb;
use crate::process::HostIO;

/// One plane as a commit stages it: `CRTC_ID` and `FB_ID` are separate
/// until the check requires them to agree.
#[derive(Clone, Copy, Default)]
pub struct StagedPlane {
    pub crtc: bool,
    pub fb_id: u32,
    pub fb: Option<KmsFb>,
    pub geometry: PlaneGeometry,
    pub damage_blob: u32,
}

/// What kind of request a commit completes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CommitKind {
    /// A legacy modeset, plane, DPMS or property update: it takes effect
    /// when the ioctl returns and leaves no commit pending.
    Legacy,
    /// A page flip or atomic commit on a lit CRTC: it is pending until the
    /// next vblank, which completes it (and sends its event).
    Flip,
}

/// Effects that legacy cursor ioctls request regardless of whether the
/// presented cursor changed (the host transport records each request).
#[derive(Clone, Copy, Default)]
pub struct CursorRequest {
    pub flags: u32,
}

/// A staged state change of the one CRTC, its planes and its connector.
#[derive(Clone, Copy)]
pub struct Commit {
    old_crtc: CrtcState,
    old_primary: StagedPlane,
    old_cursor: StagedPlane,
    old_connector_crtc: bool,
    pub crtc: CrtcState,
    pub primary: StagedPlane,
    pub cursor: StagedPlane,
    pub cursor_hot: (i32, i32),
    pub connector_crtc: bool,
    /// Objects in the commit (`drm_atomic_get_*_state` was called).
    pub crtc_in: bool,
    pub primary_in: bool,
    pub cursor_in: bool,
    pub connector_in: bool,
    /// `OUT_FENCE_PTR` as staged (a nonzero pointer already received -1).
    pub out_fence_ptr: u64,
    /// `DRM_MODE_ATOMIC_ALLOW_MODESET`; true for legacy commits, as
    /// `drm_atomic_state_init` defaults it.
    pub allow_modeset: bool,
    /// A legacy cursor ioctl's own flags (`DRM_MODE_CURSOR_BO`/`MOVE`).
    pub cursor_request: Option<CursorRequest>,
}

/// The current plane states as a commit stages them.
fn primary_now() -> StagedPlane {
    let device = kms::dev();
    let primary = device.primary;
    StagedPlane {
        crtc: primary.fb_id != 0,
        fb_id: primary.fb_id,
        fb: kms::framebuffer(primary.fb_id),
        geometry: primary.geometry,
        damage_blob: primary.damage_blob,
    }
}

fn cursor_now() -> (StagedPlane, (i32, i32)) {
    let state = kms::cursor_plane().unwrap_or_default();
    (
        StagedPlane {
            crtc: state.fb_id != 0,
            fb_id: state.fb_id,
            fb: state.fb,
            geometry: state.geometry(),
            damage_blob: state.damage_blob,
        },
        (state.hot_x, state.hot_y),
    )
}

/// Timings two modes must share to be the same mode (`drm_mode_equal`
/// without the picture-aspect bits).
fn mode_timing(m: &WpkDrmModeModeinfo) -> [u32; 12] {
    [
        m.clock, u32::from(m.hdisplay), u32::from(m.hsync_start), u32::from(m.hsync_end),
        u32::from(m.htotal), u32::from(m.hskew), u32::from(m.vdisplay),
        u32::from(m.vsync_start), u32::from(m.vsync_end), u32::from(m.vtotal),
        u32::from(m.vscan), m.flags & !DRM_MODE_FLAG_PIC_AR_MASK,
    ]
}

pub fn modes_equal(a: Option<&WpkDrmModeModeinfo>, b: Option<&WpkDrmModeModeinfo>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => mode_timing(a) == mode_timing(b),
        _ => false,
    }
}

/// `drm_mode_convert_umode` + `drm_mode_validate_basic`: ERANGE for a clock
/// or refresh beyond `INT_MAX`, EINVAL for undefined flags or inconsistent
/// timings.
pub fn umode_valid(mode: &WpkDrmModeModeinfo) -> Result<(), Errno> {
    if mode.clock > i32::MAX as u32 || mode.vrefresh > i32::MAX as u32 {
        return Err(Errno::ERANGE);
    }
    let flags = mode.flags & !DRM_MODE_FLAG_PIC_AR_MASK;
    if mode.flags & DRM_MODE_FLAG_PIC_AR_MASK > DRM_MODE_FLAG_PIC_AR_MAX
        || mode.mode_type & !DRM_MODE_TYPE_ALL != 0
        || flags & !DRM_MODE_FLAG_ALL != 0
        || flags & DRM_MODE_FLAG_3D_MASK > DRM_MODE_FLAG_3D_MAX
        || mode.clock == 0
        || mode.hdisplay == 0
        || mode.hsync_start < mode.hdisplay
        || mode.hsync_end < mode.hsync_start
        || mode.htotal < mode.hsync_end
        || mode.vdisplay == 0
        || mode.vsync_start < mode.vdisplay
        || mode.vsync_end < mode.vsync_start
        || mode.vtotal < mode.vsync_end
    {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

/// The virtual connector's `mode_valid`: the host presents only the modes
/// its connector advertises, so any other timing is refused like a mode a
/// driver cannot drive (EINVAL).
pub fn connector_mode_valid(host: &mut dyn HostIO, mode: &WpkDrmModeModeinfo) -> Result<(), Errno> {
    let wanted = mode_timing(mode);
    if crate::dri::modes::connector_modes(host.kms_mode_info(kms::CONNECTOR_ID))
        .iter().any(|m| mode_timing(m) == wanted)
    {
        Ok(())
    } else {
        Err(Errno::EINVAL)
    }
}

pub fn mode_from_bytes(data: &[u8]) -> WpkDrmModeModeinfo {
    debug_assert_eq!(data.len(), core::mem::size_of::<WpkDrmModeModeinfo>());
    unsafe { core::ptr::read_unaligned(data.as_ptr() as *const WpkDrmModeModeinfo) }
}

pub fn mode_bytes(mode: &WpkDrmModeModeinfo) -> alloc::vec::Vec<u8> {
    let bytes = unsafe {
        core::slice::from_raw_parts(
            mode as *const WpkDrmModeModeinfo as *const u8,
            core::mem::size_of::<WpkDrmModeModeinfo>(),
        )
    };
    bytes.to_vec()
}

/// `drm_property_replace_blob_from_id`: 0, or a live blob no longer than
/// `max_size` (when given) whose length is a multiple of `elem_size`.
fn blob_from_id(value: u64, max_size: Option<usize>, elem_size: usize) -> Result<u32, Errno> {
    let id = u32::try_from(value).map_err(|_| Errno::EINVAL)?;
    if id == 0 {
        return Ok(0);
    }
    let len = kms::blob_len(id).ok_or(Errno::EINVAL)?;
    if max_size.is_some_and(|max| len > max) || len % elem_size != 0 {
        return Err(Errno::EINVAL);
    }
    Ok(id)
}

/// Host and caller context a commit needs to stage `OUT_FENCE_PTR` and to
/// publish its effects.
pub struct CommitContext<'a> {
    pub host: &'a mut dyn HostIO,
    pub pid: i32,
}

impl Commit {
    /// A commit that changes nothing yet.
    pub fn current() -> Self {
        let device = kms::dev();
        let primary = primary_now();
        let (cursor, cursor_hot) = cursor_now();
        Self {
            old_crtc: device.crtc,
            old_primary: primary,
            old_cursor: cursor,
            old_connector_crtc: device.connector_crtc,
            crtc: device.crtc,
            primary,
            cursor,
            cursor_hot,
            connector_crtc: device.connector_crtc,
            crtc_in: false,
            primary_in: false,
            cursor_in: false,
            connector_in: false,
            out_fence_ptr: 0,
            allow_modeset: true,
            cursor_request: None,
        }
    }

    /// `drm_atomic_get_plane_state`: the plane joins the commit, and so does
    /// the CRTC it is on.
    pub fn touch_plane(&mut self, plane: u32) {
        let staged = if plane == kms::CURSOR_PLANE_ID {
            self.cursor_in = true;
            &self.cursor
        } else {
            self.primary_in = true;
            &self.primary
        };
        if staged.crtc {
            self.crtc_in = true;
        }
    }

    /// `drm_atomic_get_connector_state`: likewise for the connector.
    pub fn touch_connector(&mut self) {
        self.connector_in = true;
        if self.connector_crtc {
            self.crtc_in = true;
        }
    }

    pub fn plane_mut(&mut self, plane: u32) -> &mut StagedPlane {
        if plane == kms::CURSOR_PLANE_ID { &mut self.cursor } else { &mut self.primary }
    }

    /// Stage `MODE_ID` (`drm_atomic_set_mode_prop_for_crtc`).
    fn set_mode_blob(&mut self, id: u32) -> Result<(), Errno> {
        if id == self.crtc.mode_blob {
            return Ok(());
        }
        if id == 0 {
            self.crtc.mode = None;
            self.crtc.mode_blob = 0;
            return Ok(());
        }
        let data = kms::blob(id).ok_or(Errno::EINVAL)?;
        if data.len() != core::mem::size_of::<WpkDrmModeModeinfo>() {
            return Err(Errno::EINVAL);
        }
        let mode = mode_from_bytes(&data);
        // Any conversion failure is EINVAL here, unlike legacy SETCRTC.
        umode_valid(&mode).map_err(|_| Errno::EINVAL)?;
        self.crtc.mode = Some(mode);
        self.crtc.mode_blob = id;
        Ok(())
    }

    /// `drm_atomic_set_property` for one (object, property, value) of the
    /// request: the value's validity first, then the object joins the
    /// commit, then the property is staged. `obj` is a CRTC, plane or
    /// connector carrying `prop`.
    pub fn set_property(
        &mut self,
        ctx: &mut CommitContext<'_>,
        obj: u32,
        prop: &kms::Property,
        value: u64,
    ) -> Result<(), Errno> {
        if !prop.accepts(value) {
            return Err(Errno::EINVAL);
        }
        match obj {
            kms::CRTC_ID => {
                self.crtc_in = true;
                match prop.id {
                    kms::PROP_ACTIVE => self.crtc.active = value != 0,
                    kms::PROP_MODE_ID => self.set_mode_blob(value as u32)?,
                    kms::PROP_GAMMA_LUT => {
                        self.crtc.gamma_lut = blob_from_id(value,
                            Some(kms::GAMMA_SIZE as usize * kms::COLOR_LUT_ENTRY_BYTES),
                            kms::COLOR_LUT_ENTRY_BYTES)?;
                    }
                    kms::PROP_OUT_FENCE_PTR => {
                        // Linux writes -1 at once, so a bad pointer is EFAULT
                        // here and the slot reads -1 if the commit fails.
                        if value != 0 {
                            let minus_one = (-1i32).to_le_bytes();
                            if ctx.host.proc_write_bytes(ctx.pid, value, &minus_one) < 0 {
                                return Err(Errno::EFAULT);
                            }
                        }
                        self.out_fence_ptr = value;
                    }
                    _ => return Err(Errno::EINVAL),
                }
            }
            kms::PRIMARY_PLANE_ID | kms::CURSOR_PLANE_ID => {
                self.touch_plane(obj);
                match prop.id {
                    kms::PROP_FB_ID => {
                        let plane = self.plane_mut(obj);
                        plane.fb_id = value as u32;
                        plane.fb = kms::framebuffer(plane.fb_id);
                    }
                    kms::PROP_CRTC_ID => {
                        let on = value != 0;
                        self.plane_mut(obj).crtc = on;
                        if on {
                            self.crtc_in = true;
                        }
                    }
                    kms::PROP_SRC_X => self.plane_mut(obj).geometry.src_x = value as u32,
                    kms::PROP_SRC_Y => self.plane_mut(obj).geometry.src_y = value as u32,
                    kms::PROP_SRC_W => self.plane_mut(obj).geometry.src_w = value as u32,
                    kms::PROP_SRC_H => self.plane_mut(obj).geometry.src_h = value as u32,
                    kms::PROP_CRTC_X => self.plane_mut(obj).geometry.crtc_x = value as i64 as i32,
                    kms::PROP_CRTC_Y => self.plane_mut(obj).geometry.crtc_y = value as i64 as i32,
                    kms::PROP_CRTC_W => self.plane_mut(obj).geometry.crtc_w = value as u32,
                    kms::PROP_CRTC_H => self.plane_mut(obj).geometry.crtc_h = value as u32,
                    // -1 is "no fence". Any other fd would have to be a
                    // sync_file (sync_file_get_fence), and no sync_file
                    // exists yet, so every such fd fails as on Linux.
                    kms::PROP_IN_FENCE_FD => {
                        if value as i64 != -1 {
                            return Err(Errno::EINVAL);
                        }
                    }
                    // A damage hint: the host presents the whole plane
                    // every vblank, so the rectangles are only validated.
                    kms::PROP_FB_DAMAGE_CLIPS => {
                        self.plane_mut(obj).damage_blob =
                            blob_from_id(value, None, kms::DAMAGE_RECT_BYTES)?;
                    }
                    _ => return Err(Errno::EINVAL),
                }
            }
            kms::CONNECTOR_ID => {
                self.touch_connector();
                match prop.id {
                    kms::PROP_CRTC_ID => {
                        self.connector_crtc = value != 0;
                        if self.connector_crtc {
                            self.crtc_in = true;
                        }
                    }
                    // drm_atomic_connector_set_property: DPMS is set only
                    // through the legacy property ioctl.
                    kms::PROP_DPMS => return Err(Errno::EINVAL),
                    // Userspace never downgrades a Good link; the virtual
                    // link is always Good, so restoring it is a no-op.
                    kms::PROP_LINK_STATUS => {}
                    _ => return Err(Errno::EINVAL),
                }
            }
            _ => return Err(Errno::EINVAL),
        }
        Ok(())
    }

    fn mode_changed(&self) -> bool {
        !modes_equal(self.old_crtc.mode.as_ref(), self.crtc.mode.as_ref())
    }

    /// `drm_atomic_crtc_needs_modeset`: the mode, enable, active state or
    /// connector routing changes.
    pub fn needs_modeset(&self) -> bool {
        self.crtc_in
            && (self.mode_changed()
                || self.old_crtc.mode.is_some() != self.crtc.mode.is_some()
                || self.old_crtc.active != self.crtc.active
                || self.old_connector_crtc != self.connector_crtc)
    }

    /// `drm_atomic_plane_check`: the core rules every plane obeys.
    fn plane_core_check(plane: &StagedPlane, cursor: bool) -> Result<(), Errno> {
        // Either both CRTC and FB, or neither.
        if plane.crtc != plane.fb.is_some() {
            return Err(Errno::EINVAL);
        }
        let Some(fb) = plane.fb else { return Ok(()) };
        let format_ok = if cursor {
            kms::CURSOR_PLANE_FORMATS.contains(&fb.pixel_format)
        } else {
            kms::PRIMARY_PLANE_FORMATS.contains(&fb.pixel_format)
        };
        if !format_ok {
            return Err(Errno::EINVAL);
        }
        let g = plane.geometry;
        let int_max = i64::from(i32::MAX);
        if i64::from(g.crtc_w) > int_max
            || i64::from(g.crtc_x) > int_max - i64::from(g.crtc_w as i32)
            || i64::from(g.crtc_h) > int_max
            || i64::from(g.crtc_y) > int_max - i64::from(g.crtc_h as i32)
        {
            return Err(Errno::ERANGE);
        }
        let (fb_w, fb_h) = (fb.width << 16, fb.height << 16);
        if g.src_w > fb_w || g.src_x > fb_w - g.src_w || g.src_h > fb_h || g.src_y > fb_h - g.src_h {
            return Err(Errno::ENOSPC);
        }
        if plane.damage_blob != 0 {
            let data = kms::blob(plane.damage_blob).ok_or(Errno::EINVAL)?;
            for rect in data.chunks_exact(kms::DAMAGE_RECT_BYTES) {
                let at = |i: usize| i32::from_le_bytes(rect[i * 4..i * 4 + 4].try_into().unwrap());
                let (x1, y1, x2, y2) = (at(0), at(1), at(2), at(3));
                // Linux compares the clip's x2/y2 (pixels) against the
                // 16.16 fb size; keep its exact acceptance.
                if x1 >= x2 || y1 >= y2 || x1 < 0 || y1 < 0
                    || i64::from(x2) > i64::from(fb_w) || i64::from(y2) > i64::from(fb_h)
                {
                    return Err(Errno::EINVAL);
                }
            }
        }
        Ok(())
    }

    /// The driver's plane check (`drm_atomic_helper_check_plane_state` with
    /// no scaling, plus what the virtual planes can present).
    fn plane_driver_check(&self, plane: &StagedPlane, cursor: bool) -> Result<(), Errno> {
        let Some(fb) = plane.fb.filter(|_| plane.crtc) else { return Ok(()) };
        let g = plane.geometry;
        let enabled = self.crtc.mode;
        // The primary plane cannot be updated on a disabled CRTC; the cursor
        // plane can (it is not shown until the CRTC lights).
        if !cursor && enabled.is_none() {
            return Err(Errno::EINVAL);
        }
        // DRM_PLANE_NO_SCALING: the source is the destination's size.
        if u64::from(g.src_w) != u64::from(g.crtc_w) << 16
            || u64::from(g.src_h) != u64::from(g.crtc_h) << 16
        {
            return Err(Errno::ERANGE);
        }
        if cursor {
            // The cursor presenter reads a packed, linear image from its
            // origin: no crop, no row padding, at most 64x64.
            if fb.width == 0 || fb.height == 0
                || fb.width > kms::CURSOR_MAX_SIZE || fb.height > kms::CURSOR_MAX_SIZE
                || fb.offset != 0 || fb.stride != fb.width * 4
                || g.src_x != 0 || g.src_y != 0
                || g.src_w != fb.width << 16 || g.src_h != fb.height << 16
            {
                return Err(Errno::EINVAL);
            }
            return Ok(());
        }
        let mode = enabled.expect("checked above");
        // Not positionable: the primary covers the whole CRTC (an
        // off-screen primary included: the CRTC must scan one), panned by
        // whole pixels.
        if g.crtc_x != 0 || g.crtc_y != 0
            || g.crtc_w != u32::from(mode.hdisplay) || g.crtc_h != u32::from(mode.vdisplay)
            || (g.src_x | g.src_y) & 0xffff != 0
        {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    /// `drm_atomic_check_only` for this device. `event` is whether the
    /// commit asks for a completion event or out-fence on its CRTC.
    pub fn check(&self, host: &mut dyn HostIO, event: bool) -> Result<(), Errno> {
        // drm_atomic_plane_check, for the planes in the commit.
        if self.primary_in {
            Self::plane_core_check(&self.primary, false)?;
        }
        if self.cursor_in {
            Self::plane_core_check(&self.cursor, true)?;
        }
        let modeset = self.needs_modeset();
        if self.crtc_in {
            // drm_atomic_crtc_check.
            if self.crtc.active && self.crtc.mode.is_none() {
                return Err(Errno::EINVAL);
            }
            if event && !self.crtc.active && !self.old_crtc.active {
                return Err(Errno::EINVAL);
            }
            // drm_atomic_helper_check_modeset: an enabled CRTC drives a
            // connector and a disabled one none; the mode must be one the
            // connector can show.
            if self.crtc.mode.is_some() != self.connector_crtc {
                return Err(Errno::EINVAL);
            }
            if let Some(mode) = self.crtc.mode.as_ref().filter(|_| self.mode_changed()) {
                connector_mode_valid(host, mode)?;
            }
        }
        // drm_atomic_helper_check_planes: a modeset re-checks every plane.
        if self.primary_in || modeset {
            self.plane_driver_check(&self.primary, false)?;
        }
        if self.cursor_in || modeset {
            self.plane_driver_check(&self.cursor, true)?;
        }
        if self.crtc_in {
            // The CRTC needs its primary plane while it has a mode
            // (drm_atomic_helper_check_crtc_primary_plane).
            if self.crtc.mode.is_some() && !self.primary.crtc {
                return Err(Errno::EINVAL);
            }
            // The color stage applies exactly GAMMA_SIZE entries.
            if self.crtc.gamma_lut != 0
                && kms::blob_len(self.crtc.gamma_lut)
                    != Some(kms::GAMMA_SIZE as usize * kms::COLOR_LUT_ENTRY_BYTES)
            {
                return Err(Errno::EINVAL);
            }
        }
        // A changed cursor image must be able to take its BO reference.
        if self.cursor_in && self.cursor.fb_id != self.old_cursor.fb_id {
            if let Some(fb) = self.cursor.fb {
                crate::dri::with_registry(|r| {
                    r.get(fb.bo_id).ok_or(Errno::ENOENT)?.refcount
                        .checked_add(1).ok_or(Errno::EOVERFLOW).map(|_| ())
                })?;
            }
        }
        if !self.allow_modeset && modeset {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    /// Whether committing now would have to wait for the CRTC's previous
    /// commit (Linux's `stall_checks` / `drm_atomic_helper_setup_commit`).
    pub fn busy(&self) -> bool {
        // Every plane or connector on the CRTC brings the CRTC in.
        self.crtc_in && kms::flip_pending()
    }

    /// Replace the committed state with this one and publish the effects
    /// (`drm_atomic_helper_commit` after the point of no return). `kind`
    /// selects whether the commit stays pending until the next vblank;
    /// `event` queues a `DRM_EVENT_FLIP_COMPLETE` with that user data on
    /// `file`. Returns the commit's id while it is pending.
    pub fn apply(
        self,
        ctx: &mut CommitContext<'_>,
        kind: CommitKind,
        event: Option<(&mut crate::ofd::KmsFdState, u64)>,
    ) -> Option<u64> {
        let was_active = kms::crtc_active();
        let presented_before = presented_primary();
        let cursor_before = presented_cursor();
        let modeset = self.needs_modeset();
        let primary_fb_changed = self.primary.fb_id != self.old_primary.fb_id;
        let gamma_changed = self.crtc.gamma_lut != self.old_crtc.gamma_lut;

        // Blob references move with the state that uses them.
        kms::hold_blob(self.crtc.mode_blob);
        kms::hold_blob(self.crtc.gamma_lut);
        kms::hold_blob(self.primary.damage_blob);
        kms::hold_blob(self.cursor.damage_blob);
        kms::release_blob(self.old_crtc.mode_blob);
        kms::release_blob(self.old_crtc.gamma_lut);
        kms::release_blob(self.old_primary.damage_blob);
        kms::release_blob(self.old_cursor.damage_blob);

        let device = kms::dev();
        device.crtc = self.crtc;
        device.connector_crtc = self.connector_crtc;
        device.primary = kms::PrimaryPlaneState {
            fb_id: if self.primary.crtc { self.primary.fb_id } else { 0 },
            geometry: self.primary.geometry,
            damage_blob: self.primary.damage_blob,
        };
        if modeset {
            // drm_atomic_helper_update_legacy_modeset_state: the legacy DPMS
            // value follows the CRTC after every modeset.
            device.dpms = if self.connector_crtc && self.crtc.active {
                DRM_MODE_DPMS_ON
            } else {
                DRM_MODE_DPMS_OFF
            };
        }
        let old_cursor_bo = self.apply_cursor_state();

        let now_active = kms::crtc_active();
        if now_active && !was_active {
            // Enabling the CRTC starts its vblank counter at a real time.
            if let Ok((sec, nsec)) = ctx.host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC) {
                crate::dri::stamp_vblank_if_unset(sec as u32, (nsec / 1000) as u32);
            }
        }
        kms::note_vblank_transition(was_active);

        // Host effects: the scanout, the cursor and the color stage.
        let presented = presented_primary();
        let flip = self.primary_in && now_active;
        if presented != presented_before || flip {
            ctx.host.kms_set_fb(ctx.pid, kms::CRTC_ID, presented.0, presented.1);
        }
        if primary_fb_changed || !self.primary.crtc {
            if let Some(closed) = kms::replace_closed_scanout(None) {
                if closed.fb_id == kms::crtc_fb() {
                    kms::replace_closed_scanout(Some(closed));
                } else {
                    crate::dri::ioctl_kms::release_kms_fb(ctx.host, closed.pid, closed.fb_id, closed.fb.bo_id);
                }
            }
        }
        publish_cursor(ctx, cursor_before, self.cursor_request);
        if let Some(old) = old_cursor_bo {
            if crate::dri::with_registry(|r| r.decref(old)) == Some(0) {
                crate::syscalls::apply_dri_release_effect(
                    ctx.pid, crate::syscalls::DriReleaseEffect::DestroyBo(old), ctx.host);
            }
        }
        if gamma_changed {
            let lut = kms::effective_gamma_lut();
            ctx.host.kms_set_gamma(kms::CRTC_ID, lut.as_deref());
        }
        if flip {
            // Frame statistics for the host's display (kernel_kms_*): a
            // clock failure only skips the sample.
            if let Ok((sec, nsec)) = ctx.host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC) {
                let now_us = (sec as u64).wrapping_mul(1_000_000) + (nsec as u64) / 1000;
                crate::dri::record_kms_commit(kms::CRTC_ID, now_us);
            }
        }

        // Completion: a flip on a lit CRTC is pending until the next vblank,
        // which sends its event; a CRTC that is (now) dark completes at once.
        let pending = if kind == CommitKind::Flip && self.crtc_in && now_active {
            let device = kms::dev();
            let id = device.next_commit;
            device.next_commit = id.wrapping_add(1);
            device.pending_commit = Some(id);
            Some(id)
        } else {
            None
        };
        if let Some((file, user_data)) = event {
            if pending.is_some() {
                file.pending_flips.push(crate::ofd::PendingFlip {
                    crtc_id: kms::CRTC_ID,
                    fb_id: kms::crtc_fb(),
                    user_data,
                });
            } else {
                // The caller wakes the file's pollers for this event.
                crate::dri::queue_flip_event_now(file, user_data, kms::CRTC_ID);
            }
        }
        pending
    }

    /// Install the staged cursor plane, moving the plane's BO reference to
    /// a new image. Returns the BO whose reference the old image held, for
    /// the caller to drop after the host has seen the replacement.
    fn apply_cursor_state(&self) -> Option<crate::dri::BoId> {
        let previous = kms::cursor_plane();
        if previous.is_none() && !self.cursor_in {
            return None;
        }
        let mut next = previous.clone().unwrap_or_default();
        let image_changed = self.cursor.fb_id != self.old_cursor.fb_id || !self.cursor.crtc;
        let mut old_bo = None;
        let enabled = self.cursor.crtc && self.cursor.fb.is_some();
        if image_changed {
            let new_bo = if enabled { self.cursor.fb.map(|fb| fb.bo_id) } else { None };
            if new_bo != next.bo {
                if let Some(bo) = new_bo {
                    // Checked before the point of no return.
                    assert!(crate::dri::with_registry(|r| r.incref(bo)).is_some(),
                        "fatal KMS commit fault: cursor BO {bo} vanished after the check");
                }
                old_bo = core::mem::replace(&mut next.bo, new_bo);
            }
        }
        next.fb_id = if enabled { self.cursor.fb_id } else { 0 };
        next.fb = if enabled { self.cursor.fb } else { None };
        let g = self.cursor.geometry;
        next.x = g.crtc_x;
        next.y = g.crtc_y;
        next.crtc_w = g.crtc_w;
        next.crtc_h = g.crtc_h;
        next.src = [g.src_x, g.src_y, g.src_w, g.src_h];
        next.damage_blob = self.cursor.damage_blob;
        (next.hot_x, next.hot_y) = self.cursor_hot;
        kms::set_cursor_plane(next);
        old_bo
    }
}

/// What the CRTC scans out: the primary plane's framebuffer and the
/// viewport `[x, y, width, height]` of it, while the CRTC is lit; nothing
/// (fb 0) otherwise.
pub fn presented_primary() -> (u32, [u32; 4]) {
    let device = kms::dev();
    match device.crtc.mode {
        Some(mode) if device.crtc.active && device.primary.fb_id != 0 => {
            let (x, y) = kms::crtc_offset();
            (device.primary.fb_id, [x, y, u32::from(mode.hdisplay), u32::from(mode.vdisplay)])
        }
        _ => (0, [0; 4]),
    }
}

/// The presented cursor image and position: (fb, bo, width, height,
/// hotspot) and (x, y).
type PresentedCursor = ((u32, u32, u32, u32, i32, i32), (i32, i32));

fn presented_cursor() -> PresentedCursor {
    let state = kms::cursor_plane().unwrap_or_default();
    let image = match state.fb.filter(|_| kms::crtc_active() && state.fb_id != 0) {
        Some(fb) => (state.fb_id, fb.bo_id, fb.width, fb.height, state.hot_x, state.hot_y),
        None => (0, 0, 0, 0, 0, 0),
    };
    (image, (state.x, state.y))
}

/// Tell the host's cursor transport what changed on screen.
fn publish_cursor(ctx: &mut CommitContext<'_>, before: PresentedCursor, request: Option<CursorRequest>) {
    let after = presented_cursor();
    let mut flags = request.map_or(0, |request| request.flags);
    if after.0 != before.0 {
        flags |= DRM_MODE_CURSOR_BO;
    }
    if after.1 != before.1 {
        flags |= DRM_MODE_CURSOR_MOVE;
    }
    if flags == 0 {
        return;
    }
    let ((fb, bo, width, height, hot_x, hot_y), (x, y)) = after;
    ctx.host.kms_cursor(ctx.pid, kms::CRTC_ID, flags, bo, width, height, x, y, hot_x, hot_y, fb);
}

/// `DRM_IOCTL_MODE_ATOMIC` request arrays, copied from the caller in
/// bounded chunks. Each element is copied exactly once into kernel memory
/// and parsed from there (never re-read), and elements are reached in the
/// order Linux's `get_user` loop reaches them, so a fault is reported at
/// the same element: a chunk that runs past the caller's memory falls back
/// to copying the one element needed.
struct GuestArray<const N: usize> {
    base: u64,
    count: u64,
    chunk_start: u64,
    chunk_len: u64,
    bytes: [u8; N],
}

impl<const N: usize> GuestArray<N> {
    fn new(base: u64, count: u64) -> Self {
        Self { base, count, chunk_start: 0, chunk_len: 0, bytes: [0; N] }
    }

    /// Element `index` of `elem`-byte elements, little-endian.
    fn get(&mut self, host: &mut dyn HostIO, pid: i32, index: u64, elem: usize) -> Result<u64, Errno> {
        let per_chunk = (N / elem) as u64;
        if !(self.chunk_start..self.chunk_start + self.chunk_len).contains(&index) {
            let len = per_chunk.min(self.count.saturating_sub(index)).max(1);
            let address = |i: u64| i.checked_mul(elem as u64)
                .and_then(|offset| self.base.checked_add(offset));
            let start = address(index).ok_or(Errno::EFAULT)?;
            let chunk_bytes = (len as usize) * elem;
            let whole = index.checked_add(len).and_then(address).is_some()
                && start != 0
                && host.proc_read_bytes(pid, start, &mut self.bytes[..chunk_bytes]) >= 0;
            if whole {
                self.chunk_len = len;
            } else {
                if start == 0 || host.proc_read_bytes(pid, start, &mut self.bytes[..elem]) < 0 {
                    return Err(Errno::EFAULT);
                }
                self.chunk_len = 1;
            }
            self.chunk_start = index;
        }
        let at = ((index - self.chunk_start) as usize) * elem;
        let mut value = [0u8; 8];
        value[..elem].copy_from_slice(&self.bytes[at..at + elem]);
        Ok(u64::from_le_bytes(value))
    }
}

/// The object an atomic request names, if it can carry properties
/// (`drm_mode_object_find` + `obj->properties`); ENOENT otherwise.
fn atomic_object(host: &mut dyn HostIO, obj_id: u32) -> Result<&'static [u32], Errno> {
    match obj_id {
        kms::CURSOR_PLANE_ID if !host.kms_cursor_supported() => Err(Errno::ENOENT),
        kms::CRTC_ID | kms::CONNECTOR_ID | kms::PRIMARY_PLANE_ID | kms::CURSOR_PLANE_ID => {
            kms::object_properties(obj_id, DRM_MODE_OBJECT_ANY)
        }
        _ => Err(Errno::ENOENT),
    }
}

/// One thread's blocking atomic commit across the host's EAGAIN retries.
///
/// WHY: a blocking commit returns when its flip has completed, as Linux's
/// `drm_atomic_helper_wait_for_flip_done` does. Kandelo parks the caller on
/// the host's ordinary blocking-retry path, which re-runs the ioctl from
/// the unchanged request bytes; the record recognizes that retry so the
/// commit is applied once and the retry only waits. Linux's flip wait is
/// not interruptible, so a caught signal does not drop the record: libdrm
/// (and SA_RESTART) re-issue the same request after EINTR, which then
/// resumes the wait instead of committing twice.
#[derive(Clone, Copy, Debug)]
pub struct CommitWait {
    pub pid: u32,
    pub tid: u32,
    pub request: [u8; 56],
    pub commit: u64,
}

/// Parse the request's objects and properties into `commit`, as the loop
/// in `drm_mode_atomic_ioctl` does: object by object, property by property,
/// stopping at the first fault or invalid entry.
fn parse_request(
    ctx: &mut CommitContext<'_>,
    req: &WpkDrmModeAtomic,
    commit: &mut Commit,
) -> Result<(), Errno> {
    let count = u64::from(req.count_objs);
    let mut objs: GuestArray<256> = GuestArray::new(req.objs_ptr, count);
    let mut counts: GuestArray<256> = GuestArray::new(req.count_props_ptr, count);
    // The property arrays are indexed by a running total the caller does
    // not bound up front; chunks stop at the caller's own counts.
    let mut props: GuestArray<256> = GuestArray::new(req.props_ptr, u64::MAX);
    let mut values: GuestArray<512> = GuestArray::new(req.prop_values_ptr, u64::MAX);
    let mut copied_props: u64 = 0;
    for i in 0..count {
        let obj_id = objs.get(ctx.host, ctx.pid, i, 4)? as u32;
        let attached = atomic_object(ctx.host, obj_id)?;
        let count_props = counts.get(ctx.host, ctx.pid, i, 4)?;
        props.count = copied_props.saturating_add(count_props);
        values.count = props.count;
        for _ in 0..count_props {
            let prop_id = props.get(ctx.host, ctx.pid, copied_props, 4)? as u32;
            if !attached.contains(&prop_id) {
                return Err(Errno::ENOENT);
            }
            let prop = kms::property(prop_id).ok_or(Errno::ENOENT)?;
            let value = values.get(ctx.host, ctx.pid, copied_props, 8)?;
            commit.set_property(ctx, obj_id, prop, value)?;
            copied_props += 1;
        }
    }
    Ok(())
}

/// `DRM_IOCTL_MODE_ATOMIC` (`drm_mode_atomic_ioctl`).
pub fn atomic_ioctl(
    proc: &mut crate::process::Process,
    host: &mut dyn HostIO,
    ofd_idx: usize,
    buf: &mut [u8],
) -> Result<(), Errno> {
    let req: WpkDrmModeAtomic = crate::dri::ioctl_kms::read_dri_struct(buf)?;
    let pid = proc.pid;
    let tid = crate::syscalls::current_tid_for_process(proc);
    let file_id = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.ofd_id;
    {
        let kms_file = crate::dri::ioctl_kms::kms_state(proc, ofd_idx)?;
        if !kms_file.atomic {
            return Err(Errno::EINVAL);
        }
    }
    if req.flags & !DRM_MODE_ATOMIC_FLAGS != 0 || req.reserved != 0 {
        return Err(Errno::EINVAL);
    }
    // DRM_CAP_ATOMIC_ASYNC_PAGE_FLIP is 0: no async flips.
    if req.flags & DRM_MODE_PAGE_FLIP_ASYNC != 0 {
        return Err(Errno::EINVAL);
    }
    let test_only = req.flags & DRM_MODE_ATOMIC_TEST_ONLY != 0;
    let wants_event = req.flags & DRM_MODE_PAGE_FLIP_EVENT != 0;
    if test_only && wants_event {
        return Err(Errno::EINVAL);
    }
    let blocking = !test_only && req.flags & DRM_MODE_ATOMIC_NONBLOCK == 0;
    let request: [u8; 56] = buf[..56].try_into().unwrap();
    if blocking {
        // A retry of this thread's blocking commit only waits for it.
        let alive = |t: u32| t == proc.pid || proc.get_thread(t).is_some();
        let live: alloc::vec::Vec<u32> = crate::dri::ioctl_kms::kms_state(proc, ofd_idx)?
            .commit_waits.iter().filter(|w| w.pid == pid).map(|w| w.tid)
            .filter(|&t| alive(t)).collect();
        let mut kms_file = crate::dri::ioctl_kms::kms_state_mut(proc, ofd_idx)?;
        kms_file.commit_waits.retain(|w| w.pid != pid || live.contains(&w.tid));
        if let Some(index) = kms_file.commit_waits.iter().position(|w| w.pid == pid && w.tid == tid) {
            let wait = kms_file.commit_waits.remove(index);
            if wait.request == request {
                if kms::dev().pending_commit == Some(wait.commit) {
                    kms_file.commit_waits.push(wait);
                    return Err(Errno::EAGAIN);
                }
                return Ok(());
            }
        }
    }

    let mut ctx = CommitContext { host, pid: pid as i32 };
    let mut commit = Commit::current();
    commit.allow_modeset = req.flags & DRM_MODE_ATOMIC_ALLOW_MODESET != 0;
    parse_request(&mut ctx, &req, &mut commit)?;

    // prepare_signaling: an event per CRTC in the commit, reserved in the
    // file's event space; an event with no CRTC could never arrive.
    if !test_only {
        if wants_event {
            if !commit.crtc_in {
                return Err(Errno::EINVAL);
            }
            if crate::dri::ioctl_kms::kms_state(proc, ofd_idx)?.event_space_used() + 32 > DRM_EVENT_SPACE {
                return Err(Errno::ENOMEM);
            }
        }
        // An out-fence is a sync_file fd, which Kandelo does not have yet;
        // fail the commit rather than report a fence that does not exist.
        if commit.out_fence_ptr != 0 && commit.crtc_in {
            return Err(Errno::EOPNOTSUPP);
        }
    }
    let event = wants_event || (!test_only && commit.out_fence_ptr != 0);
    commit.check(ctx.host, event)?;
    if test_only {
        return Ok(());
    }
    if commit.busy() {
        // Userspace may not get ahead of the previous commit with a
        // nonblocking one; a blocking one waits for it (nothing is applied
        // yet, so an interrupting signal loses nothing).
        return Err(if blocking { Errno::EAGAIN } else { Errno::EBUSY });
    }
    let pending = {
        let mut kms_file = crate::dri::ioctl_kms::kms_state_mut(proc, ofd_idx)?;
        let event = wants_event.then_some((&mut *kms_file, req.user_data));
        let pending = commit.apply(&mut ctx, CommitKind::Flip, event);
        if blocking {
            if let Some(commit) = pending {
                kms_file.commit_waits.push(CommitWait { pid, tid, request, commit });
            }
        }
        pending
    };
    if wants_event && pending.is_none() {
        crate::epoll::notify(crate::epoll::Source::Description(file_id), 0x41);
    }
    if blocking && pending.is_some() {
        return Err(Errno::EAGAIN);
    }
    Ok(())
}
