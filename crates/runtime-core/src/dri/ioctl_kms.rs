//! The `/dev/dri/card0` KMS ioctls: mode-object queries, framebuffers,
//! legacy modeset, page flips, vblank waits, properties, cursor, gamma and
//! DRM master. Moved out of `syscalls.rs`; the shared render-node ioctls
//! (`handle_dri_ioctl`) and the open/close plumbing stay there.

use alloc::vec::Vec;

use wasm_posix_shared::Errno;

use crate::dri::atomic::{self, Commit, CommitContext, CommitKind, CursorRequest};
use crate::dri::kms;
use crate::process::{HostIO, Process};
use crate::syscalls::{
    apply_dri_release_effect, apply_dri_release_effects, current_tid_for_process, dri_state,
    dri_state_mut, handle_dri_ioctl, probe_dri_process_pointer, write_dri_bytes,
    DriReleaseEffect,
};

pub(crate) fn kms_state(proc: &Process, ofd_idx: usize) -> Result<core::cell::Ref<'_, crate::ofd::KmsFdState>, Errno> {
    proc.ofd_table
        .get(ofd_idx)
        .and_then(|o| o.kms())
        .ok_or(Errno::EBADF)
}

pub(crate) fn kms_state_mut(proc: &mut Process, ofd_idx: usize) -> Result<core::cell::RefMut<'_, crate::ofd::KmsFdState>, Errno> {
    proc.ofd_table
        .get_mut(ofd_idx)
        .and_then(|o| o.kms_mut())
        .ok_or(Errno::EBADF)
}

pub(crate) fn kms_file_is_current_master(proc: &Process, ofd_idx: usize) -> Result<bool, Errno> {
    let file = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    let kms = file.kms().ok_or(Errno::EBADF)?;
    Ok(kms.master_identity == Some(file.ofd_id)
        && crate::dri::master::current().is_some_and(|grant| grant.ofd_id == file.ofd_id))
}

pub(crate) fn write_dri_u32s(host: &mut dyn HostIO, pid: i32, pointer: u64, values: &[u32]) -> Result<(), Errno> {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    write_dri_bytes(host, pid, pointer, &bytes)
}

pub(crate) fn write_dri_u64s(host: &mut dyn HostIO, pid: i32, pointer: u64, values: &[u64]) -> Result<(), Errno> {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    write_dri_bytes(host, pid, pointer, &bytes)
}

/// Validate the complete pair even when called by a query with other outputs.
pub(crate) fn probe_dri_properties(
    host: &mut dyn HostIO, pid: i32, count: usize, ids: u64, values: u64,
) -> Result<(), Errno> {
    if count != 0 {
        probe_dri_process_pointer(host, pid, ids, count * 4)?;
        probe_dri_process_pointer(host, pid, values, count * 8)?;
    }
    Ok(())
}

/// Copy property ids and values as `drm_mode_object_get_properties` does:
/// as many as the caller's `capacity` holds, while the caller learns the
/// full count from the returned struct.
pub(crate) fn write_dri_properties(
    host: &mut dyn HostIO,
    pid: i32,
    obj_id: u32,
    props: &[u32],
    capacity: u32,
    ids_pointer: u64,
    values_pointer: u64,
) -> Result<(), Errno> {
    let copied = &props[..props.len().min(capacity as usize)];
    probe_dri_properties(host, pid, copied.len(), ids_pointer, values_pointer)?;
    let values: Vec<u64> = copied.iter().map(|&id| kms::object_property_value(obj_id, id)).collect();
    write_dri_u32s(host, pid, ids_pointer, copied)?;
    write_dri_u64s(host, pid, values_pointer, &values)
}

pub(crate) fn release_kms_fb(host: &mut dyn HostIO, pid: i32, fb_id: u32, bo_id: crate::dri::BoId) {
    if crate::dri::with_registry(|r| r.decref(bo_id)) == Some(0) {
        apply_dri_release_effect(pid, DriReleaseEffect::DestroyBo(bo_id), host);
    }
    apply_dri_release_effect(pid, DriReleaseEffect::RemoveFramebuffer(fb_id), host);
}

/// Linux disables the CRTC that scans out a removed fb.
pub(crate) fn disable_crtc_scanning(fb_id: u32) {
    kms::disable_crtc_scanning(fb_id);
}

/// Check `commit` and, when it passes, apply it as a legacy update: it takes
/// effect now and leaves no commit pending.
fn legacy_commit(host: &mut dyn HostIO, pid: i32, commit: Commit) -> Result<(), Errno> {
    commit.check(host, false)?;
    commit.apply(&mut CommitContext { host, pid }, CommitKind::Legacy, None);
    Ok(())
}

/// RMFB removes a creator-owned framebuffer from every active use, including
/// a cursor installed by another master file. CLOSEFB only drops the creator's
/// table reference and therefore does not call this function.
pub(crate) fn collect_cursor_framebuffer_release(fb_id: u32) -> Result<Vec<DriReleaseEffect>, Errno> {
    let Some(mut state) = kms::cursor_plane().filter(|state| state.fb_id == fb_id) else {
        return Ok(Vec::new());
    };
    let mut effects = Vec::with_capacity(2);
    let bo = state.bo.take().ok_or(Errno::EIO)?;
    // atomic_remove_fb disables the plane that scans the framebuffer.
    state.fb = None;
    state.fb_id = 0;
    state.src = [0; 4];
    state.crtc_w = 0;
    state.crtc_h = 0;
    effects.push(DriReleaseEffect::HideCursor { fb_id });
    kms::set_cursor_plane(state);
    if crate::dri::with_registry(|r| r.decref(bo)) == Some(0) {
        effects.push(DriReleaseEffect::DestroyBo(bo));
    }
    Ok(effects)
}

/// `drm_master_check_perm`: SET_MASTER and DROP_MASTER need either a file
/// that was master before, used by the process that opened it, or
/// CAP_SYS_ADMIN (an effective uid of 0; Kandelo has no finer capability
/// model). Otherwise EACCES, so a non-root client that never held master,
/// or a forked child sharing the master's file, cannot take it.
pub(crate) fn kms_master_check_perm(proc: &Process, ofd_idx: usize) -> Result<(), Errno> {
    let kms = kms_state(proc, ofd_idx)?;
    if (kms.was_master && kms.opener_pid == proc.pid) || proc.effective_uid() == 0 {
        Ok(())
    } else {
        Err(Errno::EACCES)
    }
}

/// `drm_ioctl_desc.flags` that `drm_ioctl_permit` checks.
pub(crate) const DRM_IOCTL_RENDER_ALLOW: u8 = 1 << 0;
pub(crate) const DRM_IOCTL_MASTER: u8 = 1 << 1;

/// The DRM ioctl table: every `'d'` request this driver implements, with
/// Linux's permission flags. `None` is an ioctl the device does not have.
pub(crate) fn drm_ioctl_flags(request: u32) -> Option<u8> {
    use wasm_posix_shared::dri::*;
    const R: u8 = DRM_IOCTL_RENDER_ALLOW;
    const M: u8 = DRM_IOCTL_MASTER;
    Some(match request {
        DRM_IOCTL_VERSION | DRM_IOCTL_VERSION_WASM64 | DRM_IOCTL_GET_CAP
        | DRM_IOCTL_GEM_CLOSE | DRM_IOCTL_PRIME_HANDLE_TO_FD | DRM_IOCTL_PRIME_FD_TO_HANDLE => R,
        // Kandelo boundary: the render node's CPU-shared allocator is the
        // dumb-buffer API (Kandelo has no driver-private allocation ioctl),
        // so these stay render-allowed, unlike Linux.
        DRM_IOCTL_MODE_CREATE_DUMB | DRM_IOCTL_MODE_MAP_DUMB | DRM_IOCTL_MODE_DESTROY_DUMB => R,
        // Kandelo's private 0xE0+ requests (GPU BOs, image import/export)
        // serve the render node by design; their handlers own validation.
        _ if request & 0xff >= 0xe0 => R,
        DRM_IOCTL_MODE_SETCRTC | DRM_IOCTL_MODE_SETPLANE | DRM_IOCTL_MODE_CURSOR
        | DRM_IOCTL_MODE_CURSOR2 | DRM_IOCTL_MODE_SETGAMMA | DRM_IOCTL_MODE_SETPROPERTY
        | DRM_IOCTL_MODE_OBJ_SETPROPERTY | DRM_IOCTL_MODE_PAGE_FLIP | DRM_IOCTL_MODE_DIRTYFB
        | DRM_IOCTL_AUTH_MAGIC | DRM_IOCTL_MODE_CREATE_LEASE | DRM_IOCTL_MODE_ATOMIC => M,
        DRM_IOCTL_SET_MASTER | DRM_IOCTL_DROP_MASTER | DRM_IOCTL_GET_MAGIC
        | DRM_IOCTL_GET_UNIQUE | DRM_IOCTL_GET_UNIQUE_WASM64 | DRM_IOCTL_SET_CLIENT_CAP
        | DRM_IOCTL_WAIT_VBLANK | DRM_IOCTL_WAIT_VBLANK_WASM64
        | DRM_IOCTL_MODE_GETRESOURCES | DRM_IOCTL_MODE_GETCRTC | DRM_IOCTL_MODE_GETENCODER
        | DRM_IOCTL_MODE_GETCONNECTOR | DRM_IOCTL_MODE_GETPLANERESOURCES | DRM_IOCTL_MODE_GETPLANE
        | DRM_IOCTL_MODE_GETPROPERTY | DRM_IOCTL_MODE_OBJ_GETPROPERTIES | DRM_IOCTL_MODE_GETPROPBLOB
        | DRM_IOCTL_MODE_CREATEPROPBLOB | DRM_IOCTL_MODE_DESTROYPROPBLOB | DRM_IOCTL_MODE_GETGAMMA
        | DRM_IOCTL_MODE_ADDFB | DRM_IOCTL_MODE_ADDFB2 | DRM_IOCTL_MODE_GETFB | DRM_IOCTL_MODE_GETFB2
        | DRM_IOCTL_MODE_RMFB | DRM_IOCTL_MODE_CLOSEFB => 0,
        _ => return None,
    })
}

/// `drm_ioctl` + `drm_ioctl_permit` for `'d'` requests, before any handler
/// runs: an ioctl the device lacks is EINVAL; a DRM_MASTER one needs the
/// current master (EACCES); and a render node accepts only RENDER_ALLOW
/// requests (EACCES). Other request types keep their own dispatch (the
/// Kandelo GL session requests are not `'d'` requests).
pub(crate) fn drm_ioctl_permit(proc: &Process, ofd_idx: usize, request: u32, render: bool) -> Result<(), Errno> {
    if (request >> 8) & 0xff != u32::from(b'd') {
        return Ok(());
    }
    let flags = drm_ioctl_flags(request).ok_or(Errno::EINVAL)?;
    if flags & DRM_IOCTL_MASTER != 0 && (render || !kms_file_is_current_master(proc, ofd_idx)?) {
        return Err(Errno::EACCES);
    }
    if render && flags & DRM_IOCTL_RENDER_ALLOW == 0 {
        return Err(Errno::EACCES);
    }
    Ok(())
}

/// Card0-specific KMS ioctls (SET/DROP_MASTER, MODE_GET*, ADDFB2/RMFB,
/// SETCRTC, PAGE_FLIP, WAIT_VBLANK). Unknown requests fall through to
/// `handle_dri_ioctl` so the per-fd GEM/PRIME path stays in one place.
pub(crate) fn handle_dri_card_ioctl(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    ofd_idx: usize,
    request: u32,
    buf: &mut [u8],
) -> Result<(), Errno> {
    use wasm_posix_shared::dri::*;
    let pid = proc.pid as i32;
    match request {
        DRM_IOCTL_SET_MASTER => {
            kms_master_check_perm(proc, ofd_idx)?;
            let ofd_id = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.ofd_id;
            {
                let mut kms = kms_state_mut(proc, ofd_idx)?;
                if kms.master_identity.is_some_and(|bound| bound != ofd_id) {
                    return Err(Errno::EINVAL);
                }
                kms.master_identity = Some(ofd_id);
            }
            let changed = crate::dri::master::try_set_master(pid, ofd_id)?;
            if let Ok(mut kms) = kms_state_mut(proc, ofd_idx) {
                kms.holds_master = true;
                kms.was_master = true;
                // drm_new_set_master: a file that did not create its master
                // object gets a fresh one, whose magic map is empty.
                kms.master_object = Some(ofd_id);
            }
            if changed {
                let grant = crate::dri::master::current().expect("admitted DRM master grant");
                host.kms_set_master(pid, grant.ofd_id.0, grant.lease_id);
            }
            Ok(())
        }
        DRM_IOCTL_DROP_MASTER => {
            kms_master_check_perm(proc, ofd_idx)?;
            let ofd_id = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.ofd_id;
            if let Some(grant) = crate::dri::master::drop_master(ofd_id) {
                // The cursor plane is device state and stays as it is.
                if let Ok(mut kms) = kms_state_mut(proc, ofd_idx) {
                    kms.holds_master = false;
                }
                apply_dri_release_effect(
                    pid,
                    DriReleaseEffect::DropMaster { file_id: grant.ofd_id.0, lease_id: grant.lease_id },
                    host,
                );
                Ok(())
            } else {
                Err(Errno::EINVAL)
            }
        }
        DRM_IOCTL_MODE_GETRESOURCES => {
            let req: WpkDrmModeCardRes = read_dri_struct(buf)?;
            // drm_mode_getresources lists this file's framebuffers and the
            // device's objects, copying min(capacity, count) ids per array.
            // Every destination that will be written -- a NULL one
            // included -- is probed before the first write, so a bad later
            // pointer leaves no earlier array partially updated.
            let fbs: Vec<u32> = kms_state(proc, ofd_idx)?.fbs.borrow().keys().copied().collect();
            let outputs: [(u64, u32, &[u32]); 4] = [
                (req.fb_id_ptr, req.count_fbs, &fbs),
                (req.crtc_id_ptr, req.count_crtcs, &[kms::CRTC_ID]),
                (req.connector_id_ptr, req.count_connectors, &[kms::CONNECTOR_ID]),
                (req.encoder_id_ptr, req.count_encoders, &[kms::ENCODER_ID]),
            ];
            for &(pointer, capacity, ids) in &outputs {
                let copied = ids.len().min(capacity as usize);
                if copied != 0 {
                    probe_dri_process_pointer(host, pid, pointer, copied * 4)?;
                }
            }
            for &(pointer, capacity, ids) in &outputs {
                let copied = ids.len().min(capacity as usize);
                if copied != 0 {
                    write_dri_u32s(host, pid, pointer, &ids[..copied])?;
                }
            }
            write_dri_struct(buf, WpkDrmModeCardRes {
                count_fbs: fbs.len() as u32,
                count_crtcs: 1,
                count_connectors: 1,
                count_encoders: 1,
                min_width: 1,
                max_width: KMS_MAX_FB_DIMENSION,
                min_height: 1,
                max_height: KMS_MAX_FB_DIMENSION,
                ..req
            });
            Ok(())
        }
        DRM_IOCTL_MODE_GETCRTC => {
            if buf.len() < core::mem::size_of::<WpkDrmModeGetCrtc>() {
                return Err(Errno::EINVAL);
            }
            let req: WpkDrmModeGetCrtc =
                unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
            if req.crtc_id != kms::CRTC_ID {
                return Err(Errno::ENOENT);
            }
            let mode = kms::crtc_mode();
            let (x, y) = kms::crtc_offset();
            let resp = WpkDrmModeGetCrtc {
                crtc_id: kms::CRTC_ID,
                fb_id: kms::crtc_fb(),
                x,
                y,
                gamma_size: kms::GAMMA_SIZE,
                mode_valid: mode.is_some() as u32,
                mode: mode.unwrap_or_default(),
                ..Default::default()
            };
            unsafe {
                core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, resp);
            }
            Ok(())
        }
        DRM_IOCTL_MODE_GETENCODER => {
            if buf.len() < core::mem::size_of::<WpkDrmModeGetEncoder>() {
                return Err(Errno::EINVAL);
            }
            let req: WpkDrmModeGetEncoder =
                unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
            if req.encoder_id != kms::ENCODER_ID {
                return Err(Errno::ENOENT);
            }
            let resp = WpkDrmModeGetEncoder {
                encoder_id: kms::ENCODER_ID,
                encoder_type: DRM_MODE_ENCODER_VIRTUAL,
                // drm_encoder_get_crtc: the current link, none while the
                // CRTC is disabled.
                crtc_id: if kms::crtc_mode().is_some() { kms::CRTC_ID } else { 0 },
                possible_crtcs: 0b1,
                ..Default::default()
            };
            unsafe {
                core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, resp);
            }
            Ok(())
        }
        DRM_IOCTL_MODE_GETCONNECTOR => {
            if buf.len() < core::mem::size_of::<WpkDrmModeGetConnector>() {
                return Err(Errno::EINVAL);
            }
            let req: WpkDrmModeGetConnector =
                unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
            if req.connector_id != kms::CONNECTOR_ID {
                return Err(Errno::ENOENT);
            }
            let props = kms::listed_properties(
                kms::object_properties(kms::CONNECTOR_ID, DRM_MODE_OBJECT_CONNECTOR)?,
                kms_state(proc, ofd_idx)?.atomic);
            let modes = crate::dri::modes::connector_modes(host.kms_mode_info(1));
            let mode_count = modes.len() as u32;
            // Linux reports the available count on both calls, but copies
            // the list only if the caller supplied enough capacity. A resize
            // between the count and fill calls can therefore be retried.
            let modes_ptr = (req.count_modes >= mode_count)
                .then(|| {
                    probe_dri_process_pointer(
                        host,
                        pid,
                        req.modes_ptr,
                        modes.len() * core::mem::size_of::<WpkDrmModeModeinfo>(),
                    )
                })
                .transpose()?;
            let encoders_ptr = (req.count_encoders >= 1)
                .then(|| probe_dri_process_pointer(host, pid, req.encoders_ptr, 4))
                .transpose()?;
            let property_count = props.len().min(req.count_props as usize);
            probe_dri_properties(host, pid, property_count, req.props_ptr, req.prop_values_ptr)?;
            if let Some(pointer) = modes_ptr {
                let mode_bytes = unsafe {
                    core::slice::from_raw_parts(
                        modes.as_ptr() as *const u8,
                        modes.len() * core::mem::size_of::<WpkDrmModeModeinfo>(),
                    )
                };
                let rc = host.proc_write_bytes(pid, pointer, mode_bytes);
                if rc < 0 {
                    return Err(Errno::EFAULT);
                }
            }
            if let Some(pointer) = encoders_ptr {
                write_dri_u32s(host, pid, pointer, &[kms::ENCODER_ID])?;
            }
            if property_count != 0 {
                write_dri_properties(host, pid, kms::CONNECTOR_ID, props, req.count_props,
                    req.props_ptr, req.prop_values_ptr)?;
            }
            // The display's physical size is what a client derives its
            // output scale (DPI) from; the host knows it, the kernel reports
            // it here as a real connector does.
            let (mm_width, mm_height) = host.kms_connector_mm(kms::CONNECTOR_ID);
            let resp = WpkDrmModeGetConnector {
                encoders_ptr: req.encoders_ptr,
                modes_ptr: req.modes_ptr,
                props_ptr: req.props_ptr,
                prop_values_ptr: req.prop_values_ptr,
                count_modes: mode_count,
                count_props: props.len() as u32,
                count_encoders: 1,
                // drm_connector_get_encoder: none while the CRTC is disabled.
                encoder_id: if kms::crtc_mode().is_some() { kms::ENCODER_ID } else { 0 },
                connector_id: kms::CONNECTOR_ID,
                connector_type: DRM_MODE_CONNECTOR_VIRTUAL,
                connector_type_id: 1,
                connection: DRM_MODE_CONNECTED,
                mm_width,
                mm_height,
                subpixel: DRM_MODE_SUBPIXEL_UNKNOWN,
                ..Default::default()
            };
            unsafe {
                core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, resp);
            }
            Ok(())
        }
        DRM_IOCTL_MODE_ADDFB2 => {
            let mut req: WpkDrmModeFbCmd2 = read_dri_struct(buf)?;
            req.fb_id = kms_add_framebuffer(proc, host, ofd_idx, &req)?;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_RMFB => {
            let fb_id = u32::from_le_bytes(buf.get(..4).ok_or(Errno::EINVAL)?.try_into().unwrap());
            // Device-wide lookup does not grant mutation authority: Linux
            // RMFB/CLOSEFB require a creator-owned entry in this file.
            let fb = kms_state(proc, ofd_idx)?.fbs.borrow().get(&fb_id)
                .copied().ok_or(Errno::ENOENT)?;
            let cursor_effects = collect_cursor_framebuffer_release(fb_id)?;
            kms_state_mut(proc, ofd_idx)?.fbs.borrow_mut().remove(&fb_id);
            kms::unregister_framebuffer(fb_id);
            apply_dri_release_effects(pid, cursor_effects, host);
            disable_crtc_scanning(fb_id);
            release_kms_fb(host, pid, fb_id, fb.bo_id);
            Ok(())
        }
        DRM_IOCTL_MODE_CLOSEFB => {
            if buf.len() < 8 { return Err(Errno::EINVAL); }
            let fb_id = u32::from_le_bytes(buf[..4].try_into().unwrap());
            if u32::from_le_bytes(buf[4..8].try_into().unwrap()) != 0 {
                return Err(Errno::EINVAL);
            }
            let fb = kms_state_mut(proc, ofd_idx)?.fbs.borrow_mut().remove(&fb_id)
                .ok_or(Errno::ENOENT)?;
            kms::unregister_framebuffer(fb_id);
            // A cursor retains its own immutable descriptor and BO hold;
            // CLOSEFB must leave an active cursor available to GETPLANE.
            if kms::crtc_fb() != fb_id {
                release_kms_fb(host, pid, fb_id, fb.bo_id);
                return Ok(());
            }
            let closed = kms::ClosedScanout { pid, fb_id, fb };
            if let Some(previous) = kms::replace_closed_scanout(Some(closed)) {
                release_kms_fb(host, previous.pid, previous.fb_id, previous.fb.bo_id);
            }
            Ok(())
        }
        DRM_IOCTL_MODE_GETFB => {
            let req: WpkDrmModeFbCmd = read_dri_struct(buf)?;
            let fb = kms::framebuffer(req.fb_id).ok_or(Errno::ENOENT)?;
            let (bpp, depth) = match fb.pixel_format {
                DRM_FORMAT_ARGB8888 | DRM_FORMAT_ABGR8888 => (32, 32),
                DRM_FORMAT_XRGB8888 | DRM_FORMAT_XBGR8888 => (32, 24),
                DRM_FORMAT_RGB565 => (16, 16),
                _ => return Err(Errno::EINVAL),
            };
            let handle = kms_getfb_handle(proc, ofd_idx, &fb)?;
            write_dri_struct(buf, WpkDrmModeFbCmd { fb_id: req.fb_id,
                width: fb.width, height: fb.height, pitch: fb.stride, bpp, depth, handle });
            Ok(())
        }
        DRM_IOCTL_MODE_GETFB2 => {
            // drm_mode_getfb2_ioctl: unprivileged metadata for every plane
            // slot (one plane here; the rest zero), the same handle rule as
            // GETFB, and no modifiers (DRM_CAP_ADDFB2_MODIFIERS is 0, so
            // neither DRM_MODE_FB_MODIFIERS nor modifier[] is reported).
            let req: WpkDrmModeFbCmd2 = read_dri_struct(buf)?;
            let fb = kms::framebuffer(req.fb_id).ok_or(Errno::ENOENT)?;
            let handle = kms_getfb_handle(proc, ofd_idx, &fb)?;
            let mut reply = WpkDrmModeFbCmd2 {
                fb_id: req.fb_id,
                width: fb.width,
                height: fb.height,
                pixel_format: fb.pixel_format,
                flags: fb.flags & DRM_MODE_FB_INTERLACED,
                ..Default::default()
            };
            reply.handles[0] = handle;
            reply.pitches[0] = fb.stride;
            reply.offsets[0] = fb.offset;
            write_dri_struct(buf, reply);
            Ok(())
        }
        DRM_IOCTL_MODE_ADDFB => {
            // drm_mode_addfb: map the legacy (bpp, depth) pair through
            // drm_driver_legacy_fb_format, then the shared ADDFB2 core so
            // validation cannot diverge. Pairs Linux maps to formats the
            // primary plane does not scan out are refused there (EINVAL).
            let mut req: WpkDrmModeFbCmd = read_dri_struct(buf)?;
            let pixel_format = match (req.bpp, req.depth) {
                (16, 16) => DRM_FORMAT_RGB565,
                (32, 24) => DRM_FORMAT_XRGB8888,
                (32, 32) => DRM_FORMAT_ARGB8888,
                _ => return Err(Errno::EINVAL),
            };
            let mut fb2 = WpkDrmModeFbCmd2 {
                width: req.width,
                height: req.height,
                pixel_format,
                ..Default::default()
            };
            fb2.handles[0] = req.handle;
            fb2.pitches[0] = req.pitch;
            req.fb_id = kms_add_framebuffer(proc, host, ofd_idx, &fb2)?;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_SETPLANE => {
            let req: WpkDrmModeSetPlane = read_dri_struct(buf)?;
            if req.plane_id == kms::PRIMARY_PLANE_ID {
                return kms_set_primary_plane(proc, host, req);
            }
            if req.plane_id != kms::CURSOR_PLANE_ID || !host.kms_cursor_supported() {
                return Err(Errno::ENOENT);
            }
            if !kms_file_is_current_master(proc, ofd_idx)? { return Err(Errno::EACCES); }
            // __setplane_atomic: an atomic update of the cursor plane alone.
            let mut commit = Commit::current();
            commit.touch_plane(kms::CURSOR_PLANE_ID);
            commit.cursor_hot = (0, 0);
            commit.cursor_request = Some(CursorRequest { flags: DRM_MODE_CURSOR_BO | DRM_MODE_CURSOR_MOVE });
            if req.fb_id == 0 {
                // __drm_atomic_helper_disable_plane: no CRTC, no fb, zero
                // geometry; Linux ignores the request's CRTC and geometry.
                commit.cursor = atomic::StagedPlane::default();
            } else {
                let fb = kms::framebuffer(req.fb_id).ok_or(Errno::ENOENT)?;
                if req.crtc_id != kms::CRTC_ID { return Err(Errno::ENOENT); }
                commit.cursor = atomic::StagedPlane {
                    crtc: true,
                    fb_id: req.fb_id,
                    fb: Some(fb),
                    geometry: kms::PlaneGeometry {
                        src_x: req.src_x, src_y: req.src_y, src_w: req.src_w, src_h: req.src_h,
                        crtc_x: req.crtc_x, crtc_y: req.crtc_y, crtc_w: req.crtc_w, crtc_h: req.crtc_h,
                    },
                    damage_blob: 0,
                };
                commit.crtc_in = true;
            }
            legacy_commit(host, pid, commit)
        }
        DRM_IOCTL_MODE_CURSOR | DRM_IOCTL_MODE_CURSOR2 => {
            let size = if request == DRM_IOCTL_MODE_CURSOR2 { 36 } else { 28 };
            if buf.len() < size { return Err(Errno::EINVAL); }
            let word = |i: usize| u32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap());
            let (flags, crtc) = (word(0), word(1));
            if flags == 0 || flags & !3 != 0 { return Err(Errno::EINVAL); }
            if crtc != kms::CRTC_ID { return Err(Errno::ENOENT); }
            if !kms_file_is_current_master(proc, ofd_idx)? { return Err(Errno::EACCES); }
            // No cursor plane and no legacy cursor hook: ENXIO, as
            // drm_mode_cursor_common reports it.
            if !host.kms_cursor_supported() { return Err(Errno::ENXIO); }
            // drm_mode_cursor_universal: an atomic update of the cursor plane
            // with a framebuffer wrapped around the handle.
            let mut commit = Commit::current();
            commit.touch_plane(kms::CURSOR_PLANE_ID);
            commit.cursor_request = Some(CursorRequest { flags });
            let mut next = commit.cursor;
            if flags & DRM_MODE_CURSOR_BO != 0 {
                let (width, height, handle) = (word(4), word(5), word(6));
                next.fb = if handle != 0 {
                    if width == 0 || height == 0 || width > 64 || height > 64 {
                        return Err(Errno::EINVAL);
                    }
                    let bo_id = *dri_state(proc, ofd_idx)?.gem.borrow().handles
                        .get(&handle).ok_or(Errno::ENOENT)?;
                    if !crate::dri::with_registry(|r| r.get(bo_id).is_some_and(|bo|
                        bo.size >= u64::from(width) * u64::from(height) * 4
                            && (bo.tier == crate::dri::BoTier::CpuShared
                                || (bo.bpp == 32 && bo.width == width && bo.height >= height))))
                    { return Err(Errno::EINVAL); }
                    Some(crate::ofd::KmsFb { bo_id, width, height,
                        pixel_format: DRM_FORMAT_ARGB8888, stride: width * 4, offset: 0, flags: 0 })
                } else { None };
                next.fb_id = if next.fb.is_some() { kms::allocate_fb_id()? } else { 0 };
                next.crtc = next.fb.is_some();
                let (w, h) = next.fb.map_or((0, 0), |fb| (fb.width, fb.height));
                next.geometry.crtc_w = w;
                next.geometry.crtc_h = h;
                next.geometry.src_x = 0;
                next.geometry.src_y = 0;
                next.geometry.src_w = w << 16;
                next.geometry.src_h = h << 16;
                commit.cursor_hot = if size == 36 { (word(7) as i32, word(8) as i32) } else { (0, 0) };
            }
            if flags & DRM_MODE_CURSOR_MOVE != 0 {
                next.geometry.crtc_x = word(2) as i32;
                next.geometry.crtc_y = word(3) as i32;
            }
            if next.crtc {
                commit.crtc_in = true;
            }
            commit.cursor = next;
            legacy_commit(host, pid, commit)
        }
        DRM_IOCTL_MODE_SETCRTC => {
            let req: WpkDrmModeGetCrtc = read_dri_struct(buf)?;
            // drm_ioctl_permit checks DRM_MASTER before the handler runs.
            if !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            // drm_mode_setcrtc: CRTC x/y offsets are signed 16-bit internally.
            if req.x & 0xffff_0000 != 0 || req.y & 0xffff_0000 != 0 {
                return Err(Errno::ERANGE);
            }
            if req.crtc_id != kms::CRTC_ID {
                return Err(Errno::ENOENT);
            }
            let mode_set = req.mode_valid != 0;
            let mut fb_found = None;
            let fb_id = if mode_set {
                // fb_id -1 keeps the currently bound framebuffer. Others
                // resolve device-wide; only RMFB/CLOSEFB are creator-only.
                let fb_id = if req.fb_id == u32::MAX {
                    match kms::crtc_fb() {
                        0 => return Err(Errno::EINVAL),
                        current => current,
                    }
                } else {
                    req.fb_id
                };
                let fb = kms::framebuffer(fb_id).ok_or(Errno::ENOENT)?;
                validate_kms_mode(host, &req.mode)?;
                if !kms::PRIMARY_PLANE_FORMATS.contains(&fb.pixel_format) {
                    return Err(Errno::EINVAL);
                }
                // The panned viewport must lie inside the fb; the host then
                // presents exactly that region (host_kms_set_fb).
                check_crtc_viewport(&req.mode, req.x, req.y, &fb)?;
                fb_found = Some(fb);
                fb_id
            } else {
                // Linux ignores the fb of a SETCRTC without a mode: it
                // disables the CRTC.
                0
            };
            if mode_set != (req.count_connectors > 0) || req.count_connectors > 1 {
                return Err(Errno::EINVAL);
            }
            if req.count_connectors > 0 {
                let len = req.count_connectors as usize * 4;
                let pointer = probe_dri_process_pointer(host, pid, req.set_connectors_ptr, len)?;
                let mut ids = alloc::vec![0u8; len];
                if host.proc_read_bytes(pid, pointer, &mut ids) < 0 {
                    return Err(Errno::EFAULT);
                }
                if ids
                    .chunks_exact(4)
                    .any(|id| u32::from_le_bytes(id.try_into().unwrap()) != kms::CONNECTOR_ID)
                {
                    return Err(Errno::ENOENT);
                }
            }
            // drm_atomic_helper_set_config: one commit of the CRTC, its
            // connector and its primary plane. A mode lights the CRTC with
            // the primary covering it from the panning offset; no mode turns
            // all three off (GETCRTC then reports 0/0, as on Linux).
            let mut commit = Commit::current();
            commit.crtc_in = true;
            commit.touch_connector();
            commit.touch_plane(kms::PRIMARY_PLANE_ID);
            let mut new_blob = None;
            if mode_set {
                let mode = req.mode;
                if !atomic::modes_equal(commit.crtc.mode.as_ref(), Some(&mode)) {
                    let id = kms::create_device_blob(atomic::mode_bytes(&mode))?;
                    new_blob = Some(id);
                    commit.crtc.mode_blob = id;
                }
                commit.crtc.mode = Some(mode);
                commit.crtc.active = true;
                commit.connector_crtc = true;
                commit.primary = atomic::StagedPlane {
                    crtc: true,
                    fb_id,
                    fb: fb_found,
                    geometry: kms::PlaneGeometry::full_screen(req.x, req.y,
                        u32::from(mode.hdisplay), u32::from(mode.vdisplay)),
                    damage_blob: 0,
                };
            } else {
                commit.crtc.mode = None;
                commit.crtc.mode_blob = 0;
                commit.crtc.active = false;
                commit.connector_crtc = false;
                commit.primary = atomic::StagedPlane::default();
            }
            let result = legacy_commit(host, pid, commit);
            if result.is_err() {
                if let Some(id) = new_blob {
                    kms::discard_unused_blob(id);
                }
            }
            result
        }
        DRM_IOCTL_MODE_PAGE_FLIP => {
            let req: WpkDrmModeCrtcPageFlip = read_dri_struct(buf)?;
            // drm_ioctl_permit checks DRM_MASTER before the handler runs.
            if !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            // drm_mode_page_flip_ioctl. Kandelo reports DRM_CAP_ASYNC_PAGE_FLIP
            // and DRM_CAP_PAGE_FLIP_TARGET as 0, so ASYNC and TARGET_* are
            // rejected exactly as Linux rejects them without those caps.
            if req.flags & !DRM_MODE_PAGE_FLIP_FLAGS != 0
                || req.reserved != 0
                || req.flags & (DRM_MODE_PAGE_FLIP_ASYNC | DRM_MODE_PAGE_FLIP_TARGET) != 0
            {
                return Err(Errno::EINVAL);
            }
            if req.crtc_id != kms::CRTC_ID {
                return Err(Errno::ENOENT);
            }
            // A CRTC with no bound fb (disabled by RMFB or a mode-less
            // SETCRTC) cannot flip: Linux's "framebuffer is currently
            // unbound" EBUSY.
            let mode = kms::crtc_mode().ok_or(Errno::EBUSY)?;
            let old_fb = kms::framebuffer(kms::crtc_fb()).ok_or(Errno::EBUSY)?;
            // Framebuffers are looked up device-wide (drm_framebuffer_lookup);
            // only RMFB/CLOSEFB are creator-file operations.
            let fb = kms::framebuffer(req.fb_id).ok_or(Errno::ENOENT)?;
            let (x, y) = kms::crtc_offset();
            check_crtc_viewport(&mode, x, y, &fb)?;
            if old_fb.pixel_format != fb.pixel_format {
                return Err(Errno::EINVAL);
            }
            let wants_event = req.flags & DRM_MODE_PAGE_FLIP_EVENT != 0;
            if wants_event
                && kms_state(proc, ofd_idx)?.event_space_used() + 32 > DRM_EVENT_SPACE
            {
                return Err(Errno::ENOMEM);
            }
            // drm_atomic_helper_page_flip: a nonblocking commit of the
            // primary plane's framebuffer. The check refuses an event while
            // the CRTC stays off (DPMS not On).
            let mut commit = Commit::current();
            commit.touch_plane(kms::PRIMARY_PLANE_ID);
            commit.primary.fb_id = req.fb_id;
            commit.primary.fb = Some(fb);
            commit.check(host, wants_event)?;
            // The previous flip's commit completes at the next vblank; until
            // then the CRTC is busy whichever file queued it.
            if commit.busy() {
                return Err(Errno::EBUSY);
            }
            // The new scanout fb is latched now (the client paints it before
            // the ioctl and reuses the old one only after the flip event),
            // and the flip completes at the next host vblank
            // (`dri::retire_vblank`), which also sends the
            // DRM_EVENT_FLIP_COMPLETE when, and only when, the caller asked
            // for one. libdrm's `drmModePageFlip → poll → drmHandleEvent`
            // loop therefore runs at refresh rate, not ioctl rate.
            let mut kms_file = kms_state_mut(proc, ofd_idx)?;
            let event = wants_event.then_some((&mut *kms_file, req.user_data));
            commit.apply(&mut CommitContext { host, pid }, CommitKind::Flip, event);
            Ok(())
        }
        DRM_IOCTL_WAIT_VBLANK | DRM_IOCTL_WAIT_VBLANK_WASM64 => {
            handle_drm_wait_vblank(proc, host, ofd_idx, request == DRM_IOCTL_WAIT_VBLANK_WASM64, buf)
        }
        DRM_IOCTL_SET_CLIENT_CAP => {
            let req: WpkDrmSetClientCap = read_dri_struct(buf)?;
            match req.capability {
                DRM_CLIENT_CAP_STEREO_3D | DRM_CLIENT_CAP_ASPECT_RATIO if req.value <= 1 => Ok(()),
                DRM_CLIENT_CAP_UNIVERSAL_PLANES if req.value <= 1 => {
                    kms_state_mut(proc, ofd_idx)?.universal_planes = req.value == 1;
                    Ok(())
                }
                // drm_setclientcap: 1 and 2 enable atomic (2 also lets a
                // client see writeback connectors, of which there are none),
                // 0 disables it; the cap sets universal planes alike.
                DRM_CLIENT_CAP_ATOMIC => {
                    if req.value > 2 {
                        return Err(Errno::EINVAL);
                    }
                    let mut kms_file = kms_state_mut(proc, ofd_idx)?;
                    kms_file.atomic = req.value != 0;
                    kms_file.universal_planes = req.value != 0;
                    Ok(())
                }
                // Writeback connectors need the atomic cap; there are none
                // to list, so accepting the cap changes no listing.
                DRM_CLIENT_CAP_WRITEBACK_CONNECTORS => {
                    if !kms_state(proc, ofd_idx)?.atomic || req.value > 1 {
                        return Err(Errno::EINVAL);
                    }
                    Ok(())
                }
                DRM_CLIENT_CAP_CURSOR_PLANE_HOTSPOT => Err(Errno::EOPNOTSUPP),
                _ => Err(Errno::EINVAL),
            }
        }
        DRM_IOCTL_MODE_GETPLANERESOURCES => {
            let mut req: WpkDrmModeGetPlaneRes = read_dri_struct(buf)?;
            let planes: &[u32] = if kms_state(proc, ofd_idx)?.universal_planes {
                if host.kms_cursor_supported() {
                    &[kms::PRIMARY_PLANE_ID, kms::CURSOR_PLANE_ID]
                } else { &[kms::PRIMARY_PLANE_ID] }
            } else {
                &[]
            };
            if !planes.is_empty() && req.count_planes as usize >= planes.len() {
                let pointer = probe_dri_process_pointer(host, pid, req.plane_id_ptr, planes.len() * 4)?;
                write_dri_u32s(host, pid, pointer, planes)?;
            }
            req.count_planes = planes.len() as u32;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_GETPLANE => {
            let mut req: WpkDrmModeGetPlane = read_dri_struct(buf)?;
            let (formats, fb_id): (&[u32], u32) = match req.plane_id {
                kms::PRIMARY_PLANE_ID => (&kms::PRIMARY_PLANE_FORMATS, kms::crtc_fb()),
                kms::CURSOR_PLANE_ID if host.kms_cursor_supported() =>
                    (&kms::CURSOR_PLANE_FORMATS, kms::cursor_plane().map_or(0, |state| state.fb_id)),
                _ => return Err(Errno::ENOENT),
            };
            if req.count_format_types as usize >= formats.len() {
                let pointer = probe_dri_process_pointer(host, pid, req.format_type_ptr, formats.len() * 4)?;
                write_dri_u32s(host, pid, pointer, formats)?;
            }
            req.crtc_id = if fb_id != 0 { kms::CRTC_ID } else { 0 };
            req.fb_id = fb_id;
            req.possible_crtcs = 0b1;
            req.gamma_size = 0;
            req.count_format_types = formats.len() as u32;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_OBJ_GETPROPERTIES => {
            let mut req: WpkDrmModeObjGetProperties = read_dri_struct(buf)?;
            if req.obj_id == kms::CURSOR_PLANE_ID && !host.kms_cursor_supported() {
                return Err(Errno::ENOENT);
            }
            let props = kms::listed_properties(kms::object_properties(req.obj_id, req.obj_type)?,
                kms_state(proc, ofd_idx)?.atomic);
            if req.count_props > 0 && !props.is_empty() {
                let ids = req.props_ptr;
                let values = req.prop_values_ptr;
                write_dri_properties(host, pid, req.obj_id, props, req.count_props, ids, values)?;
            }
            req.count_props = props.len() as u32;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_GETPROPERTY => {
            let mut req: WpkDrmModeGetProperty = read_dri_struct(buf)?;
            let prop = kms::property(req.prop_id).ok_or(Errno::ENOENT)?;
            let values = prop.values();
            let copied = values.len().min(req.count_values as usize);
            let enum_count = match prop.kind {
                kms::PropertyKind::Enum(entries) => entries.len().min(req.count_enum_blobs as usize),
                _ => 0,
            };
            if copied != 0 {
                probe_dri_process_pointer(host, pid, req.values_ptr, copied * 8)?;
            }
            if enum_count != 0 {
                probe_dri_process_pointer(host, pid, req.enum_blob_ptr, enum_count * 40)?;
            }
            if copied > 0 {
                let pointer = req.values_ptr;
                write_dri_u64s(host, pid, pointer, &values[..copied])?;
            }
            req.count_values = values.len() as u32;
            match prop.kind {
                kms::PropertyKind::Enum(entries) => {
                    let copied = entries.len().min(req.count_enum_blobs as usize);
                    if copied > 0 {
                        let pointer = req.enum_blob_ptr;
                        let mut bytes = Vec::with_capacity(copied * 40);
                        for &(value, name) in &entries[..copied] {
                            bytes.extend_from_slice(&value.to_le_bytes());
                            bytes.extend_from_slice(&dri_property_name(name));
                        }
                        write_dri_bytes(host, pid, pointer, &bytes)?;
                    }
                    req.count_enum_blobs = entries.len() as u32;
                }
                kms::PropertyKind::Blob => req.count_enum_blobs = 0,
                kms::PropertyKind::Range(..) | kms::PropertyKind::SignedRange(..)
                | kms::PropertyKind::Object(_) => {}
            }
            req.flags = prop.flags();
            req.name = dri_property_name(prop.name);
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_GETPROPBLOB => {
            // drm_mode_getblob_ioctl: copy only when the caller's length is
            // exactly the blob's, and always report the blob's length.
            let mut req: WpkDrmModeGetBlob = read_dri_struct(buf)?;
            let data = kms::blob(req.blob_id).ok_or(Errno::ENOENT)?;
            if req.length as usize == data.len() && !data.is_empty() {
                let pointer = probe_dri_process_pointer(host, pid, req.data, data.len())?;
                write_dri_bytes(host, pid, pointer, &data)?;
            }
            req.length = data.len() as u32;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_CREATEPROPBLOB => {
            // drm_mode_createblob_ioctl: any primary-node client; the blob
            // belongs to this file and dies with it.
            let mut req = read_dri_struct::<[u32; 4]>(buf)?;
            let data_ptr = u64::from(req[0]) | (u64::from(req[1]) << 32);
            let length = req[2] as usize;
            if length == 0 || length > i32::MAX as usize {
                return Err(Errno::EINVAL);
            }
            if length > kms::MAX_BLOB_BYTES {
                return Err(Errno::ENOMEM);
            }
            let pointer = probe_dri_process_pointer(host, pid, data_ptr, length)?;
            let mut data = alloc::vec![0u8; length];
            if host.proc_read_bytes(pid, pointer, &mut data) < 0 {
                return Err(Errno::EFAULT);
            }
            let owner = kms_state(proc, ofd_idx)?.master_identity.ok_or(Errno::EBADF)?;
            req[3] = kms::create_blob(owner, data)?;
            write_dri_struct(buf, req);
            Ok(())
        }
        DRM_IOCTL_MODE_DESTROYPROPBLOB => {
            // drm_mode_destroyblob_ioctl: an unknown blob is EINVAL; a blob
            // another file created is EPERM.
            let blob_id = read_dri_struct::<u32>(buf)?;
            let owner = kms_state(proc, ofd_idx)?.master_identity.ok_or(Errno::EBADF)?;
            kms::destroy_blob(blob_id, owner)
        }
        DRM_IOCTL_MODE_GETGAMMA | DRM_IOCTL_MODE_SETGAMMA => {
            // struct drm_mode_crtc_lut { crtc_id, gamma_size, red, green, blue }.
            // drm_mode_gamma_{get,set}_ioctl: the CRTC's legacy ramp has
            // kms::GAMMA_SIZE entries per channel (GETCRTC's gamma_size) and
            // any other size is EINVAL. Each channel is copied in turn, so a
            // fault on a later channel is EFAULT after the earlier ones moved.
            let [crtc_id, gamma_size, red_lo, red_hi, green_lo, green_hi, blue_lo, blue_hi] =
                read_dri_struct::<[u32; 8]>(buf)?;
            if request == DRM_IOCTL_MODE_SETGAMMA && !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            if crtc_id != kms::CRTC_ID {
                return Err(Errno::ENOENT);
            }
            if gamma_size != kms::GAMMA_SIZE {
                return Err(Errno::EINVAL);
            }
            let pointers = [red_lo, red_hi, green_lo, green_hi, blue_lo, blue_hi]
                .chunks(2).map(|w| u64::from(w[0]) | (u64::from(w[1]) << 32)).collect::<Vec<_>>();
            if request == DRM_IOCTL_MODE_GETGAMMA {
                let store = kms::gamma_store();
                for (channel, &pointer) in store.iter().zip(&pointers) {
                    let bytes: Vec<u8> = channel.iter().flat_map(|v| v.to_le_bytes()).collect();
                    write_dri_bytes(host, pid, pointer, &bytes)?;
                }
                return Ok(());
            }
            for (channel, &pointer) in pointers.iter().enumerate() {
                let mut bytes = [0u8; kms::GAMMA_SIZE as usize * 2];
                if pointer == 0 || host.proc_read_bytes(pid, pointer, &mut bytes) < 0 {
                    return Err(Errno::EFAULT);
                }
                kms::store_gamma_channel(channel, core::array::from_fn(|i| {
                    u16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]])
                }));
            }
            // drm_atomic_helper_legacy_gamma_set: commit the ramp as a new
            // GAMMA_LUT blob.
            let id = kms::legacy_gamma_blob()?;
            let mut commit = Commit::current();
            commit.crtc_in = true;
            commit.crtc.gamma_lut = id;
            let result = legacy_commit(host, pid, commit);
            if result.is_err() {
                kms::discard_unused_blob(id);
            }
            result
        }
        DRM_IOCTL_MODE_DIRTYFB => {
            // drm_mode_dirtyfb_ioctl. The host samples the scanout every
            // vblank, so flushing damage is the drm_atomic_helper_dirtyfb
            // no-op once the request is valid.
            let [fb_id, flags, _color, num_clips, clips_lo, clips_hi] = read_dri_struct::<[u32; 6]>(buf)?;
            if !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            kms::framebuffer(fb_id).ok_or(Errno::ENOENT)?;
            let clips = u64::from(clips_lo) | (u64::from(clips_hi) << 32);
            const DRM_MODE_FB_DIRTY_ANNOTATE_COPY: u32 = 0x01;
            const DRM_MODE_FB_DIRTY_MAX_CLIPS: u32 = 256;
            if (num_clips == 0) != (clips == 0)
                || (flags & DRM_MODE_FB_DIRTY_ANNOTATE_COPY != 0 && num_clips % 2 != 0)
                || num_clips > DRM_MODE_FB_DIRTY_MAX_CLIPS
            {
                return Err(Errno::EINVAL);
            }
            if num_clips != 0 {
                // struct drm_clip_rect is four u16s.
                probe_dri_process_pointer(host, pid, clips, num_clips as usize * 8)?;
            }
            Ok(())
        }
        DRM_IOCTL_GET_UNIQUE | DRM_IOCTL_GET_UNIQUE_WASM64 => {
            // drm_getunique reports the master's bus id, which only the
            // legacy SET_VERSION ioctl (absent here) ever sets: the unique
            // string is empty, so nothing is copied and unique_len is 0.
            let len = if request == DRM_IOCTL_GET_UNIQUE_WASM64 { 16 } else { 8 };
            let word = if len == 16 { 8 } else { 4 };
            if buf.len() < len {
                return Err(Errno::EINVAL);
            }
            buf[..word].fill(0);
            Ok(())
        }
        DRM_IOCTL_MODE_OBJ_SETPROPERTY => {
            let req: WpkDrmModeObjSetProperty = read_dri_struct(buf)?;
            if !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            if req.obj_id == kms::CURSOR_PLANE_ID && !host.kms_cursor_supported() {
                return Err(Errno::ENOENT);
            }
            set_property_legacy(host, pid, req.obj_id, req.obj_type, req.prop_id, req.value)
        }
        DRM_IOCTL_MODE_SETPROPERTY => {
            let req: WpkDrmModeConnectorSetProperty = read_dri_struct(buf)?;
            if !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            set_property_legacy(host, pid, req.connector_id, DRM_MODE_OBJECT_CONNECTOR, req.prop_id, req.value)
        }
        DRM_IOCTL_GET_MAGIC => {
            let mut kms = kms_state_mut(proc, ofd_idx)?;
            if kms.magic == 0 {
                let master_object = kms.master_object.or(kms.master_identity).ok_or(Errno::EBADF)?;
                kms.magic = kms::issue_magic(master_object)?;
            }
            buf.get_mut(..4).ok_or(Errno::EINVAL)?.copy_from_slice(&kms.magic.to_le_bytes());
            Ok(())
        }
        DRM_IOCTL_AUTH_MAGIC => {
            let magic = u32::from_le_bytes(buf.get(..4).ok_or(Errno::EINVAL)?.try_into().unwrap());
            if !kms_file_is_current_master(proc, ofd_idx)? {
                return Err(Errno::EACCES);
            }
            // Kandelo gates no primary-node ioctl on authentication (no
            // remaining DRM ioctl here carries DRM_AUTH), so consuming the
            // token is the whole effect.
            let master_object = kms_state(proc, ofd_idx)?.master_object.ok_or(Errno::EINVAL)?;
            kms::authenticate_magic(master_object, magic)
        }
        DRM_IOCTL_MODE_CREATE_LEASE => Err(Errno::EOPNOTSUPP),
        DRM_IOCTL_MODE_ATOMIC => atomic::atomic_ioctl(proc, host, ofd_idx, buf),
        _ => handle_dri_ioctl(proc, host, fd, ofd_idx, request, buf),
    }
}

/// GETFB/GETFB2 metadata is unprivileged. Only the exact current master
/// receives a new, reference-owning GEM name (otherwise 0); Kandelo exposes
/// no CAP_SYS_ADMIN override for it.
pub(crate) fn kms_getfb_handle(proc: &mut Process, ofd_idx: usize, fb: &crate::ofd::KmsFb) -> Result<u32, Errno> {
    if !kms_file_is_current_master(proc, ofd_idx)? {
        return Ok(0);
    }
    let dri = dri_state_mut(proc, ofd_idx)?;
    let mut gem = dri.gem.borrow_mut();
    let handle = gem.next_handle;
    let next = handle.checked_add(1).filter(|_| handle != 0).ok_or(Errno::EMFILE)?;
    crate::dri::with_registry(|r| {
        r.get(fb.bo_id).ok_or(Errno::ENOENT)?.refcount
            .checked_add(1).ok_or(Errno::EOVERFLOW)?;
        r.incref(fb.bo_id);
        Ok(())
    })?;
    gem.handles.insert(handle, fb.bo_id);
    gem.next_handle = next;
    Ok(handle)
}

/// Largest framebuffer dimension, as `GETRESOURCES` reports
/// (`mode_config.max_width` / `max_height`).
pub(crate) const KMS_MAX_FB_DIMENSION: u32 = 16384;

/// Bytes per pixel of a scanout format (`drm_format_info.cpp[0]`).
pub(crate) fn kms_format_cpp(format: u32) -> Option<u32> {
    use wasm_posix_shared::dri::*;
    match format {
        DRM_FORMAT_XRGB8888 | DRM_FORMAT_ARGB8888 | DRM_FORMAT_XBGR8888 | DRM_FORMAT_ABGR8888
        | DRM_FORMAT_XRGB2101010 | DRM_FORMAT_ARGB2101010 | DRM_FORMAT_XBGR2101010
        | DRM_FORMAT_ABGR2101010 => Some(4),
        DRM_FORMAT_XBGR16161616F | DRM_FORMAT_ABGR16161616F => Some(8),
        DRM_FORMAT_RGB565 | DRM_FORMAT_GR88 => Some(2),
        DRM_FORMAT_R8 => Some(1),
        _ => None,
    }
}

/// The shared ADDFB/ADDFB2 core: `drm_internal_framebuffer_create`,
/// `framebuffer_check` and `drm_gem_fb_init_with_funcs` for the single-plane
/// formats the primary plane scans out. Returns the new fb id.
///
/// Format modifiers keep Linux's unsupported-configuration errno (EINVAL):
/// `DRM_CAP_ADDFB2_MODIFIERS` is 0, so `DRM_MODE_FB_MODIFIERS` is refused
/// exactly as on a driver without modifier support. `offsets[0]` reaches
/// the host scanout (`host_kms_addfb`), which reads the plane from it.
pub(crate) fn kms_add_framebuffer(
    proc: &mut Process,
    host: &mut dyn HostIO,
    ofd_idx: usize,
    req: &wasm_posix_shared::dri::WpkDrmModeFbCmd2,
) -> Result<u32, Errno> {
    use wasm_posix_shared::dri::*;
    let pid = proc.pid as i32;
    if req.flags & !(DRM_MODE_FB_INTERLACED | DRM_MODE_FB_MODIFIERS) != 0
        || req.flags & DRM_MODE_FB_MODIFIERS != 0
        || !(1..=KMS_MAX_FB_DIMENSION).contains(&req.width)
        || !(1..=KMS_MAX_FB_DIMENSION).contains(&req.height)
        || !kms::PRIMARY_PLANE_FORMATS.contains(&req.pixel_format)
    {
        return Err(Errno::EINVAL);
    }
    let cpp = kms_format_cpp(req.pixel_format).ok_or(Errno::EINVAL)?;
    let pitch = u64::from(req.pitches[0]);
    let offset = u64::from(req.offsets[0]);
    let min_pitch = u64::from(req.width) * u64::from(cpp);
    // framebuffer_check, plane 0, then the unused planes. Without
    // DRM_MODE_FB_MODIFIERS, Linux ignores unused handles/pitches/offsets
    // (pre-modifier userspace left them uninitialized) but not modifiers.
    if req.handles[0] == 0
        || u64::from(req.height) * pitch + offset > u64::from(u32::MAX)
        || pitch < min_pitch
        || req.modifier.iter().any(|&modifier| modifier != DRM_FORMAT_MOD_LINEAR)
    {
        return Err(Errno::EINVAL);
    }
    let bo_id = *dri_state(proc, ofd_idx)?
        .gem.borrow().handles
        .get(&req.handles[0])
        .ok_or(Errno::ENOENT)?;
    let (bo_stride, bo_size, bo_width, bo_height, tier) = crate::dri::with_registry(|r|
        r.get(bo_id).map(|b| (b.stride, b.size, b.width, b.height, b.tier)))
        .ok_or(Errno::ENOENT)?;
    // drm_gem_fb_init_with_funcs: the last row's visible bytes must lie
    // inside the object.
    let min_size = u64::from(req.height - 1) * pitch + min_pitch + offset;
    // Reject before retaining backing or publishing an FB. A bad view must
    // not reach a presenter as an internal GPU failure. A GPU-tier BO is a
    // fixed native texture: its view must keep the allocation's row pitch
    // and fit its extent.
    // A GPU-tier BO is a native texture with no byte addressing, so its
    // view starts at the texture origin.
    if min_size > bo_size
        || (tier == crate::dri::BoTier::GpuTexture
            && (offset != 0 || req.pitches[0] != bo_stride
                || req.width > bo_width || req.height > bo_height))
    {
        return Err(Errno::EINVAL);
    }
    let fb_id = {
        let kms = kms_state_mut(proc, ofd_idx)?;
        let id = kms::allocate_fb_id()?;
        kms.fbs.borrow_mut().insert(
            id,
            crate::ofd::KmsFb {
                bo_id,
                width: req.width,
                height: req.height,
                pixel_format: req.pixel_format,
                stride: req.pitches[0],
                offset: req.offsets[0],
                flags: req.flags & DRM_MODE_FB_INTERLACED,
            },
        );
        kms::register_framebuffer(id, kms.fbs.downgrade());
        id
    };
    crate::dri::with_registry(|r| r.incref(bo_id));
    let rc = host.kms_addfb(pid, fb_id, bo_id, req.width, req.height, req.pixel_format,
        req.pitches[0], req.offsets[0]);
    if rc < 0 {
        kms::unregister_framebuffer(fb_id);
        if let Ok(kms) = kms_state_mut(proc, ofd_idx) {
            kms.fbs.borrow_mut().remove(&fb_id);
        }
        let _ = crate::dri::with_registry(|r| r.decref(bo_id));
        return Err(Errno::ENOMEM);
    }
    Ok(fb_id)
}

/// `drm_mode_convert_umode` + `drm_mode_validate_basic`, then the virtual
/// display's own `mode_valid`: the host can present only the modes its
/// connector advertises, so any other timing is refused like a mode a
/// driver cannot drive (EINVAL).
pub(crate) fn validate_kms_mode(
    host: &mut dyn HostIO,
    mode: &wasm_posix_shared::dri::WpkDrmModeModeinfo,
) -> Result<(), Errno> {
    atomic::umode_valid(mode)?;
    atomic::connector_mode_valid(host, mode)
}

/// `OBJ_SETPROPERTY` / `SETPROPERTY` on an atomic driver
/// (`set_property_atomic`): DPMS has its own commit
/// (`drm_atomic_connector_commit_dpms`); any other property attached to the
/// object becomes a one-property commit, so the atomic check applies to it.
fn set_property_legacy(
    host: &mut dyn HostIO,
    pid: i32,
    obj_id: u32,
    obj_type: u32,
    prop_id: u32,
    value: u64,
) -> Result<(), Errno> {
    let props = kms::object_properties(obj_id, obj_type)?;
    if !props.contains(&prop_id) {
        return Err(Errno::EINVAL);
    }
    use wasm_posix_shared::dri::{DRM_MODE_DPMS_OFF, DRM_MODE_DPMS_ON, DRM_MODE_OBJECT_CONNECTOR};
    let prop = kms::property(prop_id).ok_or(Errno::EINVAL)?;
    if !prop.accepts(value) {
        return Err(Errno::EINVAL);
    }
    let obj_id = obj_id;
    if prop_id == kms::PROP_DPMS {
        if kms::find_object(obj_id, obj_type)? != DRM_MODE_OBJECT_CONNECTOR {
            return Err(Errno::EINVAL);
        }
        // Standby and Suspend are Off on an atomic driver.
        let mode = if value == DRM_MODE_DPMS_ON { DRM_MODE_DPMS_ON } else { DRM_MODE_DPMS_OFF };
        let old = kms::dev().dpms;
        if old == mode {
            return Ok(());
        }
        kms::dev().dpms = mode;
        if !kms::dev().connector_crtc {
            return Ok(());
        }
        let mut commit = Commit::current();
        commit.touch_connector();
        commit.crtc.active = mode == DRM_MODE_DPMS_ON;
        let result = legacy_commit(host, pid, commit);
        if result.is_err() {
            kms::dev().dpms = old;
        }
        // The modeset rewrote DPMS from ACTIVE; keep the requested value.
        if result.is_ok() {
            kms::dev().dpms = mode;
        }
        return result;
    }
    let mut commit = Commit::current();
    let mut ctx = CommitContext { host, pid };
    commit.set_property(&mut ctx, obj_id, prop, value)?;
    legacy_commit(ctx.host, pid, commit)
}

/// Primary-plane `SETPLANE`, as a legacy driver's primary-plane helper
/// handles it (`drm_plane_helper_update_primary`): `__setplane_check`,
/// then an unscaled update that covers the whole CRTC, applied like a
/// SETCRTC that keeps the mode and connectors with the source origin as the
/// panning offset. The virtual CRTC cannot position, scale or hide its
/// primary plane, so those are refused as on such drivers: disabling it is
/// EINVAL, scaling ERANGE, partial coverage EINVAL.
pub(crate) fn kms_set_primary_plane(
    proc: &mut Process,
    host: &mut dyn HostIO,
    req: wasm_posix_shared::dri::WpkDrmModeSetPlane,
) -> Result<(), Errno> {
    if req.fb_id == 0 {
        return Err(Errno::EINVAL);
    }
    let fb = kms::framebuffer(req.fb_id).ok_or(Errno::ENOENT)?;
    if req.crtc_id != kms::CRTC_ID {
        return Err(Errno::ENOENT);
    }
    if !kms::PRIMARY_PLANE_FORMATS.contains(&fb.pixel_format) {
        return Err(Errno::EINVAL);
    }
    let int_max = i32::MAX as i64;
    if i64::from(req.crtc_w) > int_max || i64::from(req.crtc_x) > int_max - i64::from(req.crtc_w)
        || i64::from(req.crtc_h) > int_max || i64::from(req.crtc_y) > int_max - i64::from(req.crtc_h)
    {
        return Err(Errno::ERANGE);
    }
    // drm_framebuffer_check_src_coords (16.16 fixed point).
    let (fb_w, fb_h) = (u64::from(fb.width) << 16, u64::from(fb.height) << 16);
    let (src_x, src_y, src_w, src_h) =
        (u64::from(req.src_x), u64::from(req.src_y), u64::from(req.src_w), u64::from(req.src_h));
    if src_w > fb_w || src_x > fb_w - src_w || src_h > fb_h || src_y > fb_h - src_h {
        return Err(Errno::ENOSPC);
    }
    // A disabled CRTC leaves the plane invisible, which the helper refuses.
    let mode = kms::crtc_mode().ok_or(Errno::EINVAL)?;
    if src_w != u64::from(req.crtc_w) << 16 || src_h != u64::from(req.crtc_h) << 16 {
        return Err(Errno::ERANGE);
    }
    if req.crtc_x != 0 || req.crtc_y != 0
        || req.crtc_w != u32::from(mode.hdisplay) || req.crtc_h != u32::from(mode.vdisplay)
        || (req.src_x | req.src_y) & 0xffff != 0
    {
        return Err(Errno::EINVAL);
    }
    let (x, y) = (req.src_x >> 16, req.src_y >> 16);
    if x > 0xffff || y > 0xffff {
        return Err(Errno::ERANGE);
    }
    let mut commit = Commit::current();
    commit.touch_plane(kms::PRIMARY_PLANE_ID);
    commit.primary = atomic::StagedPlane {
        crtc: true,
        fb_id: req.fb_id,
        fb: Some(fb),
        geometry: kms::PlaneGeometry {
            src_x: req.src_x, src_y: req.src_y, src_w: req.src_w, src_h: req.src_h,
            crtc_x: req.crtc_x, crtc_y: req.crtc_y, crtc_w: req.crtc_w, crtc_h: req.crtc_h,
        },
        damage_blob: 0,
    };
    commit.crtc_in = true;
    legacy_commit(host, proc.pid as i32, commit)
}

/// `drm_crtc_check_viewport`: the mode's active area placed at `(x, y)` must
/// lie inside the framebuffer, otherwise ENOSPC.
pub(crate) fn check_crtc_viewport(
    mode: &wasm_posix_shared::dri::WpkDrmModeModeinfo,
    x: u32,
    y: u32,
    fb: &crate::ofd::KmsFb,
) -> Result<(), Errno> {
    let (width, height) = (u32::from(mode.hdisplay), u32::from(mode.vdisplay));
    if width > fb.width || x > fb.width - width || height > fb.height || y > fb.height - height {
        return Err(Errno::ENOSPC);
    }
    Ok(())
}

/// Linux's 3 s `wait_event_interruptible_timeout` bound in
/// `drm_wait_vblank_ioctl`; a wait that outlives it fails with EBUSY.
pub(crate) const DRM_VBLANK_WAIT_TIMEOUT_NS: i64 = 3_000_000_000;

/// `DRM_IOCTL_WAIT_VBLANK`, following `drm_wait_vblank_ioctl`.
///
/// The counter is the host's real vblank cadence (`dri::retire_vblank`,
/// driven by the same present pump that retires page flips), never a
/// synthesized value. A blocking wait returns EAGAIN, which parks the
/// caller on the host's ordinary blocking-retry path; the vblank that
/// reaches the target raises `dri::take_vblank_wake` so the host retries it
/// at that vblank. `wide` selects the LP64 (wasm64) union layout.
pub(crate) fn handle_drm_wait_vblank(
    proc: &mut Process,
    host: &mut dyn HostIO,
    ofd_idx: usize,
    wide: bool,
    buf: &mut [u8],
) -> Result<(), Errno> {
    use wasm_posix_shared::dri::*;
    let size = if wide { 24 } else { 16 };
    if buf.len() < size {
        return Err(Errno::EINVAL);
    }
    let word = |buf: &[u8], at: usize| u32::from_le_bytes(buf[at..at + 4].try_into().unwrap());
    let req_type = word(buf, 0);
    let req_sequence = word(buf, 4);
    // `unsigned long signal`: 4 bytes on wasm32, 8 on wasm64.
    let signal = if wide {
        u64::from_le_bytes(buf[8..16].try_into().unwrap())
    } else {
        u64::from(word(buf, 8))
    };
    if req_type & DRM_VBLANK_SIGNAL != 0
        || req_type & !(DRM_VBLANK_TYPES_MASK | DRM_VBLANK_FLAGS_MASK | DRM_VBLANK_HIGH_CRTC_MASK) != 0
    {
        return Err(Errno::EINVAL);
    }
    let flags = req_type & DRM_VBLANK_FLAGS_MASK;
    let high_pipe = (req_type & DRM_VBLANK_HIGH_CRTC_MASK) >> DRM_VBLANK_HIGH_CRTC_SHIFT;
    let pipe = if high_pipe != 0 {
        high_pipe
    } else if flags & DRM_VBLANK_SECONDARY != 0 {
        1
    } else {
        0
    };
    if pipe != 0 {
        return Err(Errno::EINVAL);
    }

    let pid = proc.pid;
    let tid = current_tid_for_process(proc);
    let (now_sec, now_nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC)?;
    let now_ns = now_sec.saturating_mul(1_000_000_000).saturating_add(now_nsec);
    let alive = |tid: u32| tid == proc.pid || proc.get_thread(tid).is_some();
    let live: alloc::vec::Vec<u32> = kms_state(proc, ofd_idx)?
        .vblank_waits.iter().filter(|w| w.pid == pid).map(|w| w.tid)
        .filter(|&t| alive(t)).collect();
    let mut kms = kms_state_mut(proc, ofd_idx)?;
    // A record whose task has exited can never be retried.
    kms.vblank_waits.retain(|w| w.pid != pid || live.contains(&w.tid));
    let resumed = kms.vblank_waits.iter()
        .position(|w| w.pid == pid && w.tid == tid)
        .map(|i| kms.vblank_waits.remove(i))
        .filter(|w| w.request_type == req_type && w.request_sequence == req_sequence);
    let off_generation = kms::vblank_off_generation();
    let (seq, tv_sec, tv_usec) = crate::dri::vblank_count_and_time();
    let write_reply = |buf: &mut [u8], out_type: u32| {
        buf[0..4].copy_from_slice(&out_type.to_le_bytes());
        buf[4..8].copy_from_slice(&(seq as u32).to_le_bytes());
        if wide {
            buf[8..16].copy_from_slice(&u64::from(tv_sec).to_le_bytes());
            buf[16..24].copy_from_slice(&u64::from(tv_usec).to_le_bytes());
        } else {
            buf[8..12].copy_from_slice(&tv_sec.to_le_bytes());
            buf[12..16].copy_from_slice(&tv_usec.to_le_bytes());
        }
    };
    // drm_crtc_vblank_off wakes every waiter; the woken wait succeeds and
    // replies with the count at which the CRTC stopped.
    if resumed.is_some_and(|w| w.off_generation != off_generation) {
        write_reply(buf, req_type & !(DRM_VBLANK_RELATIVE | DRM_VBLANK_NEXTONMISS));
        return Ok(());
    }
    // A CRTC that is off (no mode, or DPMS not On) has no running vblank
    // counter: `drm_vblank_get` refuses it with EINVAL.
    if !kms::crtc_active() {
        return Err(Errno::EINVAL);
    }
    let mut out_type = req_type;
    let (target, deadline_ns) = match resumed {
        Some(wait) => {
            out_type &= !(DRM_VBLANK_RELATIVE | DRM_VBLANK_NEXTONMISS);
            (wait.target, wait.deadline_ns)
        }
        None => {
            let mut target = if req_type & DRM_VBLANK_RELATIVE != 0 {
                out_type &= !DRM_VBLANK_RELATIVE;
                seq.wrapping_add(u64::from(req_sequence))
            } else {
                crate::dri::widen_32_to_64(req_sequence, seq)
            };
            if flags & DRM_VBLANK_NEXTONMISS != 0 && crate::dri::vblank_passed(seq, target) {
                target = seq + 1;
                out_type &= !DRM_VBLANK_NEXTONMISS;
            }
            (target, now_ns.saturating_add(DRM_VBLANK_WAIT_TIMEOUT_NS))
        }
    };
    buf[0..4].copy_from_slice(&out_type.to_le_bytes());

    if flags & DRM_VBLANK_EVENT != 0 {
        // drm_queue_vblank_event: reserve event space, then send at once if
        // the target has passed or queue for the vblank that reaches it.
        // The reply's time fields are left as the caller's request bytes.
        if kms.event_space_used() + 32 > DRM_EVENT_SPACE {
            return Err(Errno::ENOMEM);
        }
        let reply_sequence = if crate::dri::vblank_passed(seq, target) {
            crate::dri::queue_vblank_event_now(&mut *kms, signal, kms::CRTC_ID)
        } else {
            kms.pending_vblank_events.push(crate::ofd::PendingVblankEvent {
                target, user_data: signal, crtc_id: kms::CRTC_ID, off_generation,
            });
            target as u32
        };
        buf[4..8].copy_from_slice(&reply_sequence.to_le_bytes());
        drop(kms);
        if let Some(ofd) = proc.ofd_table.get(ofd_idx) {
            crate::epoll::notify(crate::epoll::Source::Description(ofd.ofd_id), 0x41);
        }
        return Ok(());
    }

    let mut result = Ok(());
    if !crate::dri::vblank_passed(seq, target) {
        if now_ns < deadline_ns {
            kms.vblank_waits.push(crate::ofd::VblankWait {
                pid, tid, request_type: req_type, request_sequence: req_sequence,
                target, deadline_ns, off_generation,
            });
            // The request words are rewritten as Linux rewrites them, but
            // the host discards a parked call's staged output.
            buf[4..8].copy_from_slice(&(target as u32).to_le_bytes());
            return Err(Errno::EAGAIN);
        }
        result = Err(Errno::EBUSY);
    }
    // drm_wait_vblank_reply: the current count and its vblank's time, also
    // reported with EBUSY.
    write_reply(buf, out_type);
    result
}

pub(crate) fn read_dri_struct<T: Copy>(buf: &[u8]) -> Result<T, Errno> {
    if buf.len() < core::mem::size_of::<T>() {
        return Err(Errno::EINVAL);
    }
    Ok(unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const T) })
}

pub(crate) fn write_dri_struct<T: Copy>(buf: &mut [u8], value: T) {
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut T, value) };
}

pub(crate) fn dri_property_name(name: &str) -> [u8; wasm_posix_shared::dri::DRM_PROP_NAME_LEN] {
    let mut out = [0u8; wasm_posix_shared::dri::DRM_PROP_NAME_LEN];
    out[..name.len()].copy_from_slice(name.as_bytes());
    out
}

